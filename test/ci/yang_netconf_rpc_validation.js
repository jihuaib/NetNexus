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
    SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
    YANG_PUSH_NAMESPACE,
    IETF_DATASTORES_NAMESPACE,
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
assert.equal(isRfc3339DateTime('2016-12-31T23:59:60Z'), true);
assert.equal(isRfc3339DateTime('2024-02-30T12:00:00Z'), false);
assert.equal(isRfc3339DateTime('2024-01-01T24:00:00Z'), false);
assert.equal(isRfc3339DateTime('2024-01-01T12:00:00+15:00'), false);
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

const replayStart = new Date(Date.now() - 60_000).toISOString();
const stopTime = new Date(Date.now() + 3_600_000).toISOString();

result = validateNetconfRpc(
    rpc(
        `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}">` +
            '<stream-subtree-filter><event xmlns="urn:example:event"/></stream-subtree-filter>' +
            `<stream>NETCONF</stream><replay-start-time>${replayStart}</replay-start-time>` +
            `<stop-time>${stopTime}</stop-time></establish-subscription>`
    )
);
assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
assert.equal(result.operation, 'establish-subscription');

result = validateNetconfRpc(
    rpc(
        `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}">` +
            '<id>not-an-input</id><stream>NETCONF</stream></establish-subscription>'
    )
);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /输入不允许包含 id/u.test(item.message)));

result = validateNetconfRpc(
    rpc(
        `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" ` +
            `xmlns:yp="${YANG_PUSH_NAMESPACE}">` +
            `<yp:datastore xmlns:ds="${IETF_DATASTORES_NAMESPACE}">ds:operational</yp:datastore>` +
            '<yp:datastore-subtree-filter><state xmlns="urn:example:state"/></yp:datastore-subtree-filter>' +
            '<yp:periodic><yp:period>500</yp:period></yp:periodic>' +
            '</establish-subscription>'
    )
);
assert.equal(result.valid, true, JSON.stringify(result.diagnostics));

result = validateNetconfRpc(
    rpc(
        `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" ` +
            `xmlns:yp="${YANG_PUSH_NAMESPACE}" xmlns:vd="urn:example:vendor-datastores">` +
            '<yp:datastore>vd:telemetry</yp:datastore>' +
            '</establish-subscription>'
    )
);
assert.equal(result.valid, true, JSON.stringify(result.diagnostics));

result = validateNetconfRpc(
    rpc(
        `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" ` +
            `xmlns:yp="${YANG_PUSH_NAMESPACE}">` +
            '<yp:datastore>vd:telemetry</yp:datastore>' +
            '</establish-subscription>'
    )
);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /vd.*缺少 XML 命名空间/u.test(item.message)));

result = validateNetconfRpc(
    rpc(
        `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" ` +
            `xmlns:yp="${YANG_PUSH_NAMESPACE}" xmlns:ds="${IETF_DATASTORES_NAMESPACE}">` +
            '<yp:datastore>ds:operational</yp:datastore>' +
            '<yp:on-change><yp:dampening-period>0</yp:dampening-period><yp:sync-on-start>true</yp:sync-on-start>' +
            '<yp:excluded-change>move</yp:excluded-change></yp:on-change>' +
            '</establish-subscription>'
    )
);
assert.equal(result.valid, true, JSON.stringify(result.diagnostics));

result = validateNetconfRpc(
    rpc(
        `<modify-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}">` +
            '<id>22</id><stream-xpath-filter xmlns:e="urn:example:event">/e:event</stream-xpath-filter>' +
            `<stop-time>${stopTime}</stop-time></modify-subscription>`
    )
);
assert.equal(result.valid, true, JSON.stringify(result.diagnostics));

for (const body of [
    `<delete-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>0</id></delete-subscription>`,
    `<delete-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>22</id></delete-subscription>`,
    `<resync-subscription xmlns="${YANG_PUSH_NAMESPACE}"><id>22</id></resync-subscription>`
]) {
    result = validateNetconfRpc(rpc(body));
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
}

result = validateNetconfRpc(
    rpc(
        `<modify-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" ` +
            `xmlns:yp="${YANG_PUSH_NAMESPACE}" xmlns:ds="${IETF_DATASTORES_NAMESPACE}">` +
            '<id>22</id><yp:datastore>ds:operational</yp:datastore>' +
            '<yp:datastore-xpath-filter xmlns:m="urn:example:model">/m:state</yp:datastore-xpath-filter>' +
            '</modify-subscription>'
    )
);
assert.equal(result.valid, true, JSON.stringify(result.diagnostics));

result = validateNetconfRpc(
    rpc(
        `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" xmlns:yp="${YANG_PUSH_NAMESPACE}">` +
            '<stream>NETCONF</stream><yp:datastore>ds:operational</yp:datastore>' +
            '</establish-subscription>'
    )
);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /不能混用|只能选择/u.test(item.message)));

result = validateNetconfRpc(
    rpc(
        `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" ` +
            `xmlns:yp="${YANG_PUSH_NAMESPACE}" xmlns:ds="${IETF_DATASTORES_NAMESPACE}">` +
            '<yp:datastore>ds:operational</yp:datastore>' +
            `<replay-start-time>${replayStart}</replay-start-time>` +
            '<yp:periodic><yp:period>100</yp:period></yp:periodic></establish-subscription>'
    )
);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /不能混用/u.test(item.message)));

result = validateNetconfRpc(
    rpc(
        `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}">` +
            '<stream-subtree-filter><one xmlns="urn:example:event"/></stream-subtree-filter>' +
            '<stream-subtree-filter><two xmlns="urn:example:event"/></stream-subtree-filter>' +
            '<stream>NETCONF</stream></establish-subscription>'
    )
);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /stream-subtree-filter.*只能出现一次/u.test(item.message)));

result = validateNetconfRpc(
    rpc(
        `<modify-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}">` +
            '<id>4294967296</id><stream>NETCONF</stream></modify-subscription>'
    )
);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /id 必须/u.test(item.message)));
assert(result.diagnostics.some(item => /不能修改 stream/u.test(item.message)));

result = validateNetconfRpc(
    rpc(
        `<modify-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" ` +
            `xmlns:yp="${YANG_PUSH_NAMESPACE}" xmlns:ds="${IETF_DATASTORES_NAMESPACE}">` +
            '<id>52</id><yp:datastore>ds:operational</yp:datastore>' +
            '<yp:on-change><yp:dampening-period>10</yp:dampening-period>' +
            '<yp:sync-on-start>false</yp:sync-on-start><yp:excluded-change>bogus</yp:excluded-change></yp:on-change>' +
            '</modify-subscription>'
    )
);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /不能修改 sync-on-start/u.test(item.message)));
assert(result.diagnostics.some(item => /excluded-change 只能/u.test(item.message)));
assert(result.diagnostics.some(item => /不能修改 excluded-change/u.test(item.message)));

result = validateNetconfRpc(
    rpc(
        `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" xmlns:yp="${YANG_PUSH_NAMESPACE}">` +
            '<yp:datastore xmlns:ds="urn:example:wrong">ds:operational</yp:datastore>' +
            '<yp:periodic><yp:period>4294967296</yp:period></yp:periodic></establish-subscription>'
    )
);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /ds 前缀/u.test(item.message)));
assert(result.diagnostics.some(item => /period 必须/u.test(item.message)));

result = validateNetconfRpc(
    rpc(
        `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" xmlns:yp="${YANG_PUSH_NAMESPACE}">` +
            '<yp:datastore>operational</yp:datastore>' +
            '<yp:periodic><yp:period>100</yp:period></yp:periodic></establish-subscription>'
    )
);
assert.equal(result.valid, false);
assert(result.diagnostics.some(item => /带命名空间前缀的 identityref/u.test(item.message)));

result = validateNetconfRpc(
    rpc(
        `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}">` +
            '<stream>NETCONF<bad/></stream>' +
            '<stream-xpath-filter><bad/></stream-xpath-filter>' +
            '<encoding><bad/></encoding>' +
            '</establish-subscription>'
    )
);
assert.equal(result.valid, false);
for (const leaf of ['stream', 'stream-xpath-filter', 'encoding']) {
    assert(result.diagnostics.some(item => item.message.includes(`${leaf} 是标量叶子`)));
}
assert(result.diagnostics.some(item => /encoding 不能为空/u.test(item.message)));

for (const encoding of ['bad value', 'bogus', 'vendor:codec']) {
    result = validateNetconfRpc(
        rpc(
            `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}">` +
                `<stream>NETCONF</stream><encoding>${encoding}</encoding>` +
                '</establish-subscription>'
        )
    );
    assert.equal(result.valid, false);
}
assert(result.diagnostics.some(item => /vendor.*缺少 XML 命名空间/u.test(item.message)));
result = validateNetconfRpc(
    rpc(
        `<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}">` +
            '<stream>NETCONF</stream><encoding>encode-xml</encoding></establish-subscription>'
    )
);
assert.equal(result.valid, true, JSON.stringify(result.diagnostics));

const duplicateUnsupportedRpc = [
    `<rpc xmlns="${NETCONF_BASE_NAMESPACE}" message-id="duplicate-unsupported">`,
    `  <establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}">`,
    '    <foo/>',
    '    <foo/>',
    '    <stream>NETCONF</stream>',
    '  </establish-subscription>',
    '</rpc>'
].join('\n');
result = validateNetconfRpc(duplicateUnsupportedRpc);
assert.deepEqual(
    result.diagnostics.filter(item => /不支持子元素 foo/u.test(item.message)).map(item => item.line),
    [3, 4]
);

const typedModernRpc = [
    `<rpc xmlns="${NETCONF_BASE_NAMESPACE}" message-id="typed-modern">`,
    `  <establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" xmlns:yp="${YANG_PUSH_NAMESPACE}" xmlns:ds="${IETF_DATASTORES_NAMESPACE}">`,
    '    <yp:datastore>ds:operational</yp:datastore>',
    '    <dscp>64</dscp>',
    '    <weighting>256</weighting>',
    '    <dependency>-1</dependency>',
    '    <yp:on-change>',
    '      <yp:dampening-period>invalid</yp:dampening-period>',
    '      <yp:sync-on-start>yes</yp:sync-on-start>',
    '      <yp:excluded-change>bogus</yp:excluded-change>',
    '    </yp:on-change>',
    '  </establish-subscription>',
    '</rpc>'
].join('\n');
result = validateNetconfRpc(typedModernRpc);
assert.equal(result.valid, false);
for (const [pattern, line] of [
    [/dscp 必须/u, 4],
    [/weighting 必须/u, 5],
    [/dependency 必须/u, 6],
    [/dampening-period 必须/u, 8],
    [/sync-on-start 必须/u, 9],
    [/excluded-change 只能/u, 10]
]) {
    const diagnostic = result.diagnostics.find(item => pattern.test(item.message));
    assert(diagnostic, `missing diagnostic ${pattern}`);
    assert.equal(diagnostic.line, line, `${diagnostic.message} should mark its own XML line`);
}

console.log('NETCONF RPC frontend validation tests passed');
