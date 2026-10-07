const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const { parsePathAttributes } = require('../../electron/utils/bgp/bgpPacketParser');
const { builders } = require('../../scripts/mockBmpClient');
const { pathAttribute, richAttributes, evpnRoute, bgpLsRoute, flowSpecRoute } = require('../fixtures/bmpRouteDetail');

const filename = path.resolve(__dirname, '../../src/utils/bmp/routeDetail.js');
const helper = new Module(filename, module);
helper.filename = filename;
helper.paths = Module._nodeModulePaths(path.dirname(filename));
helper._compile(
    transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'js', format: 'cjs', target: 'node16' }).code,
    filename
);
const { buildReadableRouteDetailModel, formatReadableAsPath, formatReadableRouteIdentity } = helper.exports;
const text = groups =>
    groups
        .map(group =>
            [
                group.title,
                group.description,
                ...group.items.flatMap(item => [item.label, item.value]),
                ...(group.tags || [])
            ]
                .flat()
                .join('\n')
        )
        .join('\n');

const route = { afi: 1, safi: 1, ip: '203.0.113.0', mask: 24, ...richAttributes() };
const original = JSON.stringify(route);
const model = buildReadableRouteDetailModel(route);
const attributes = text(model.attributes);
for (const value of [
    'IGP（本 AS 内部起源）',
    '65000 → 65101',
    '65010',
    '192.0.2.10',
    'NO_EXPORT',
    'NO_ADVERTISE',
    'NO_EXPORT_SUBCONFED',
    '65000:100',
    '65000:200:300',
    '65000:400',
    '65000:500',
    '192.0.2.9',
    '192.0.2.11',
    '192.0.2.12'
])
    assert.ok(attributes.includes(value), `missing readable attribute ${value}`);
assert.ok(!attributes.includes('[object Object]'));
assert.ok(!attributes.includes('rawValueHex'));
assert.ok(!attributes.includes('pathAttributes['));
const unknown = model.attributes.find(group => group.raw === 'deadbeef');
assert.ok(unknown, 'unknown attribute retains its uninterpreted raw value');
assert.ok(unknown.title.includes('99'));
assert.equal(unknown.items.length, 0);
assert.equal(JSON.stringify(route), original, 'presentation must not mutate the complete original route');

for (const [value, expected] of [
    [0, 'IGP（本 AS 内部起源）'],
    [1, 'EGP（通过 EGP 协议学习）'],
    [2, 'INCOMPLETE（其他方式学习）']
]) {
    const bytes = pathAttribute(1, Buffer.from([value]));
    const update = parsePathAttributes(bytes, 0, bytes.length, {});
    const origin = BmpSession.prototype.extractRouteAttributes.call({}, update);
    assert.ok(text(buildReadableRouteDetailModel(origin).attributes).includes(expected));
}
for (const value of [
    '不向本 AS 或本 AS 联邦之外发布',
    '不向任何 BGP 邻居发布',
    '包括同一联邦中的其他成员 AS',
    '普通数值的具体含义由运营者定义',
    '本地值由管理员定义',
    '用于 VPN 路由导入和导出策略',
    '帮助避免 VPN 站点之间的路由环路'
]) {
    assert.ok(attributes.includes(value), `missing attribute meaning: ${value}`);
}

const communities = Array.from({ length: 45 }, (_, index) => 65000 * 65536 + 500 + index);
const communityModel = buildReadableRouteDetailModel(richAttributes(1, communities));
const communityTags = communityModel.attributes.find(group => group.tags?.includes('65000:500')).tags;
assert.deepEqual(
    communityTags,
    communities.map((_, index) => `65000:${500 + index}`)
);

const legacy = buildReadableRouteDetailModel({
    origin: 'IGP',
    asPath: '65000 65100',
    nextHop: '::ffff:c0a8:e401',
    communities: '65000:1 NO_EXPORT RT 65000:400 SOO 65000:500',
    extendedCommunities: ['RT 65001:600'],
    largeCommunities: '65000:2:3 65536:4:5'
});
for (const value of [
    '65000 → 65100',
    '::ffff:192.168.228.1',
    '65000:1',
    'NO_EXPORT',
    '65000:400',
    '65000:500',
    '65001:600',
    '65000:2:3',
    '65536:4:5'
]) {
    assert.ok(text(legacy.attributes).includes(value), `legacy scalar attribute lost ${value}`);
}
const legacyStandard = legacy.attributes.find(group => group.title === '标准 Community');
assert.equal(legacyStandard.tags.length, 2, 'legacy mixed RT/SOO values must be classified as extended communities');
const legacyPathBytes = Buffer.concat([
    pathAttribute(2, Buffer.concat([Buffer.from([2, 2]), builders.u16(65000), builders.u16(23456)])),
    pathAttribute(17, Buffer.concat([Buffer.from([2, 1]), builders.u32(70000)]), 0xc0)
]);
const legacyUpdate = parsePathAttributes(legacyPathBytes, 0, legacyPathBytes.length, { asnSize: 2 });
assert.deepEqual(legacyUpdate.errors, []);
const reconstructed = BmpSession.prototype.extractRouteAttributes.call({}, { ...legacyUpdate, asnSize: 2 });
assert.equal(reconstructed.wireAsPath, '65000 23456');
assert.equal(reconstructed.asPath, '65000 70000');
const effectivePath = buildReadableRouteDetailModel(reconstructed).attributes.find(group => group.title === 'AS 路径');
assert.equal(effectivePath.items.find(item => item.label === '有效路径').value, '65000 → 70000');
assert.equal(effectivePath.items.find(item => item.label === '报文中的两字节路径').value, '65000 → 23456');

const segments = [
    { type: 2, values: [65000, 65100], expected: '65000 → 65100' },
    { type: 1, values: [65200, 65300], expected: '{65200, 65300}' },
    { type: 3, values: [65400, 65500], expected: '(65400 → 65500)' },
    { type: 4, values: [65600, 65700], expected: '[65600, 65700]' }
];
const segmentBytes = Buffer.concat(
    segments.map(segment =>
        Buffer.concat([
            Buffer.from([segment.type, segment.values.length]),
            ...segment.values.map(value => builders.u32(value))
        ])
    )
);
const pathBytes = pathAttribute(2, segmentBytes);
const parsed = parsePathAttributes(pathBytes, 0, pathBytes.length, { asnSize: 4 });
assert.deepEqual(parsed.errors, []);
const pathModel = buildReadableRouteDetailModel(BmpSession.prototype.extractRouteAttributes.call({}, parsed));
for (const segment of segments) assert.ok(text(pathModel.attributes).includes(segment.expected));

for (const [typeCode, rawValueHex] of [
    [9, 'c00002'],
    [10, 'c000020bc0'],
    [32, '0000fde8000000c8000001']
]) {
    const invalid = buildReadableRouteDetailModel({
        pathAttributes: [{ typeCode, rawValueHex, length: rawValueHex.length / 2 }]
    });
    const raw = invalid.attributes.find(group => group.raw === rawValueHex);
    assert.ok(raw, `malformed attribute ${typeCode} remains available as raw bytes`);
    assert.equal(raw.items.length, 0, `malformed attribute ${typeCode} must not manufacture decoded values`);
    assert.equal((raw.tags || []).length, 0);
}

const nlriCases = [
    [evpnRoute(), ['MAC/IP Advertisement', 'aa:bb:cc:dd:ee:01', '192.0.2.11', 'VNI 10000', 'VXLAN']],
    [
        bgpLsRoute(),
        ['OSPFv2', '本地节点', '远端节点', '65009', '10.100.0.1', '65109', '10.200.0.1', '10.10.0.1', '10.10.0.2']
    ],
    [flowSpecRoute(), ['203.0.113.0/24', 'TCP', '443']]
];
assert.deepEqual(formatReadableRouteIdentity(evpnRoute()), {
    title: 'EVPN MAC/IP 路由',
    summary: 'aa:bb:cc:dd:ee:01 · 192.0.2.11'
});
assert.deepEqual(formatReadableRouteIdentity(bgpLsRoute()), {
    title: 'BGP-LS 链路路由',
    summary: 'OSPFv2 · 10.100.0.1 → 10.200.0.1'
});
for (const [record, expected] of nlriCases) {
    const before = JSON.stringify(record);
    const nlri = text(buildReadableRouteDetailModel({ client: { sysName: 'semantic-router' }, route: record }).nlri);
    for (const value of expected) assert.ok(nlri.includes(value), `missing readable NLRI ${value}`);
    assert.ok(!nlri.includes('[object Object]'));
    assert.ok(!nlri.includes('raw:'));
    assert.ok(!nlri.includes('evpn:mac-ip:'));
    assert.ok(!nlri.includes('bgp-ls:Link:'));
    assert.equal(JSON.stringify(record), before);
}

for (const partial of [
    null,
    { communities: [null, undefined, { value: 0 }, '65000:1'], largeCommunities: [null, '65000:2:3'] },
    {
        pathAttributes: [
            null,
            undefined,
            [],
            15,
            { typeCode: 8, communities: [null, {}, { value: 0 }, '65000:1'], rawValueHex: '00000000fde80001' },
            { typeCode: 16, extCommunities: [null, {}, 'RT 65000:400'], rawValueHex: '0002fde800000190' },
            { typeCode: 32, largeCommunities: [null, '65000:2:3'], rawValueHex: '0000fde80000000200000003' }
        ]
    }
]) {
    const before = JSON.stringify(partial);
    assert.doesNotThrow(() => buildReadableRouteDetailModel(partial));
    assert.equal(JSON.stringify(partial), before, 'partial route preservation');
}
for (const asPath of ['', []]) {
    assert.equal(formatReadableAsPath(asPath), '空 AS 路径');
}

console.log('BMP readable route detail regression passed');
