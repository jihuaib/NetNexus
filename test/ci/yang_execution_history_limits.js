'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');

const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.join(__dirname, '..', '..'));
const sourcePath = path.join(projectRoot, 'src', 'view', 'yang', 'useNetconfExecutionHistory.js');
const transformed = transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    format: 'cjs',
    loader: 'js',
    target: 'node16'
}).code;
const historyModule = new Module(sourcePath, module);
historyModule.filename = sourcePath;
historyModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
historyModule._compile(transformed, sourcePath);

const history = historyModule.exports;
const MAX_RETAINED_REPLY_PREVIEW_CHARACTERS = 256 * 1024;
const OMITTED_PAYLOAD_SENTINEL = 'NETNEXUS_FULL_RPC_REPLY_MUST_NOT_ENTER_HISTORY';

const compactItems = count => '<item><name>x</name></item>'.repeat(count);
const largeReply =
    '<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="large-history-42">' +
    '<data><items xmlns="urn:netnexus:test:large-reply">' +
    compactItems(8000) +
    `<probe>${OMITTED_PAYLOAD_SENTINEL}</probe>` +
    compactItems(8000) +
    '</items></data></rpc-reply>';

assert(
    largeReply.length > MAX_RETAINED_REPLY_PREVIEW_CHARACTERS,
    'the fixture must exceed the renderer/history preview limit'
);

history.clearNetconfExecutionHistory();

const normalId = history.beginNetconfExecution({
    operation: 'get',
    operationLabel: 'get',
    requestXml: '<rpc message-id="normal-1"><get/></rpc>',
    profileId: 'profile-large-reply',
    sessionId: '1001'
});
history.completeNetconfExecution(normalId, {
    status: 'success',
    messageId: 'normal-1',
    duration: 12,
    replyXml: '<rpc-reply message-id="normal-1"><ok/></rpc-reply>'
});

let records = history.useNetconfExecutionHistory().records.value;
assert.equal(records.length, 1);
assert.equal(records[0].replyTruncated, false);
assert.equal(records[0].replyXml, '<rpc-reply message-id="normal-1"><ok/></rpc-reply>');

const largeId = history.beginNetconfExecution({
    operation: 'get',
    operationLabel: 'get',
    requestXml: '<rpc message-id="large-history-42"><get/></rpc>',
    profileId: 'profile-large-reply',
    profileName: 'Large reply router',
    host: '192.0.2.42',
    port: 830,
    sessionId: '1002',
    contextPath: '/large-reply:items'
});
history.completeNetconfExecution(largeId, {
    status: 'success',
    messageId: 'large-history-42',
    duration: 345,
    replyXml: largeReply,
    replyTruncated: true,
    replyBytes: Buffer.byteLength(largeReply, 'utf8'),
    replyPreviewBytes: MAX_RETAINED_REPLY_PREVIEW_CHARACTERS,
    replyFileToken: 'opaque-large-history-token'
});

records = history.useNetconfExecutionHistory().records.value;
const largeRecord = records.find(record => record.id === largeId);
assert(largeRecord, 'an oversized reply must retain its useful execution metadata');
assert.equal(largeRecord.status, 'success');
assert.equal(largeRecord.messageId, 'large-history-42');
assert.equal(largeRecord.duration, 345);
assert.equal(largeRecord.profileName, 'Large reply router');
assert.equal(largeRecord.contextPath, '/large-reply:items');
assert.equal(largeRecord.replyTruncated, true, 'an oversized reply must be marked as truncated');
assert.equal(largeRecord.replyBytes, Buffer.byteLength(largeReply, 'utf8'));
assert.equal(largeRecord.replyPreviewBytes, MAX_RETAINED_REPLY_PREVIEW_CHARACTERS);
assert.equal(largeRecord.replyFileToken, 'opaque-large-history-token');
assert(
    largeRecord.replyXml.length <= MAX_RETAINED_REPLY_PREVIEW_CHARACTERS,
    `history retained ${largeRecord.replyXml.length} characters instead of a bounded preview`
);
assert.equal(
    largeRecord.replyXml.includes(OMITTED_PAYLOAD_SENTINEL),
    false,
    'the complete oversized payload must not be retained through a middle sentinel'
);
assert.equal(
    JSON.stringify(largeRecord).includes(OMITTED_PAYLOAD_SENTINEL),
    false,
    'the complete oversized payload must not survive in another history field'
);

history.clearNetconfExecutionHistory();
assert.equal(history.useNetconfExecutionHistory().records.value.length, 0);

console.log('NETCONF oversized execution history retention tests passed');
