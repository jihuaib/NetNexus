'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');

const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.join(__dirname, '..', '..'));
const sourcePath = path.join(projectRoot, 'src', 'view', 'yang', 'netconfRpcValidation.js');
const transformed = transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    format: 'cjs',
    loader: 'js',
    target: 'node16'
}).code;
const validationModule = new Module(sourcePath, module);
validationModule.filename = sourcePath;
validationModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
validationModule._compile(transformed, sourcePath);

const {
    NETCONF_BASE_NAMESPACE,
    NETCONF_NOTIFICATION_NAMESPACE,
    isRfc3339DateTime,
    validateNetconfRpc
} = validationModule.exports;

const rpc = body => `<rpc xmlns="${NETCONF_BASE_NAMESPACE}" message-id="101">${body}</rpc>`;
const firstError = value => validateNetconfRpc(value).diagnostics[0];

let result = validateNetconfRpc(rpc('<get/>'));
assert.equal(result.valid, true);
assert.equal(result.operation, 'get');
assert.deepEqual(result.diagnostics, []);

result = validateNetconfRpc(`<nc:rpc xmlns:nc="${NETCONF_BASE_NAMESPACE}" message-id="102"><nc:get/></nc:rpc>`);
assert.equal(result.valid, true);
assert.equal(result.operation, 'get');

assert.match(firstError('').message, /不能为空/u);
assert.match(
    firstError(`<!DOCTYPE rpc><rpc xmlns="${NETCONF_BASE_NAMESPACE}" message-id="1"><get/></rpc>`).message,
    /DOCTYPE/u
);
assert.match(
    firstError(`<!ENTITY x "value"><rpc xmlns="${NETCONF_BASE_NAMESPACE}" message-id="1"><get/></rpc>`).message,
    /ENTITY/u
);

result = validateNetconfRpc(`\n${rpc('<get><!-- NETNEXUS_REQUIRED: value --></get>')}`);
assert.equal(result.valid, false);
assert.equal(result.diagnostics[0].line, 2);
assert(result.diagnostics[0].index > 0);
assert.equal(result.diagnostics[0].length, 'NETNEXUS_REQUIRED'.length);

result = validateNetconfRpc(`<rpc xmlns="${NETCONF_BASE_NAMESPACE}" message-id="1">\n  <get>\n</rpc>`);
assert.equal(result.valid, false);
assert.equal(result.diagnostics.at(-1).line, 3);
assert.equal(result.diagnostics.at(-1).column, 1);

result = validateNetconfRpc(`<reply xmlns="${NETCONF_BASE_NAMESPACE}" message-id="1"><get/></reply>`);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /根元素必须是 rpc/u.test(item.message)));

result = validateNetconfRpc('<rpc xmlns="urn:example:wrong" message-id="1"><get/></rpc>');
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /NETCONF base 命名空间/u.test(item.message)));

result = validateNetconfRpc(`<rpc xmlns="${NETCONF_BASE_NAMESPACE}"><get/></rpc>`);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /message-id/u.test(item.message)));
assert.equal(result.operation, 'get');

result = validateNetconfRpc(`<rpc xmlns="${NETCONF_BASE_NAMESPACE}" message-id="1"></rpc>`);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /一个操作元素/u.test(item.message)));

const multipleOperationRpc = rpc('<get/><get-config/>');
result = validateNetconfRpc(multipleOperationRpc);
assert.equal(result.valid, false);
const operationError = result.diagnostics.find(item => /一个操作元素/u.test(item.message));
assert(operationError);
assert.equal(operationError.index, multipleOperationRpc.indexOf('get-config'));
assert.equal(operationError.length, 'get-config'.length);

result = validateNetconfRpc(
    rpc(
        `<create-subscription xmlns="${NETCONF_NOTIFICATION_NAMESPACE}">` +
            '<stream>NETCONF</stream><filter type="subtree"><alarm xmlns="urn:example:alarm"/></filter>' +
            '<startTime>2026-07-19T01:00:00Z</startTime><stopTime>2026-07-19T02:00:00Z</stopTime>' +
            '</create-subscription>'
    )
);
assert.equal(result.valid, true);
assert.equal(result.operation, 'create-subscription');
assert.equal(isRfc3339DateTime('2026-07-19T09:00:00+08:00'), true);
assert.equal(isRfc3339DateTime('2026-07-19'), false);

result = validateNetconfRpc(rpc('<create-subscription><stream>NETCONF</stream></create-subscription>'));
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /RFC 5277 命名空间/u.test(item.message)));

result = validateNetconfRpc(
    rpc(
        `<create-subscription xmlns="${NETCONF_NOTIFICATION_NAMESPACE}">` +
            '<filter type="xpath"/><stopTime>2026-07-19T02:00:00Z</stopTime>' +
            '</create-subscription>'
    )
);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /非空 select/u.test(item.message)));
assert(result.diagnostics.some(item => /必须与 startTime/u.test(item.message)));

result = validateNetconfRpc(
    rpc(
        `<create-subscription xmlns="${NETCONF_NOTIFICATION_NAMESPACE}">` +
            '<stopTime>2026-07-19T01:00:00Z</stopTime><startTime>2026-07-19T02:00:00Z</startTime>' +
            '</create-subscription>'
    )
);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /顺序不符合/u.test(item.message)));
assert(result.diagnostics.some(item => /晚于 startTime/u.test(item.message)));

result = validateNetconfRpc(
    rpc(
        `<create-subscription xmlns="${NETCONF_NOTIFICATION_NAMESPACE}">` +
            '<startTime>2026-07-19</startTime>' +
            '</create-subscription>'
    )
);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /RFC 3339/u.test(item.message)));

console.log('NETCONF RPC frontend validation tests passed');
