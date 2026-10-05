const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

function loadRendererModule(relativePath) {
    const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.join(__dirname, '..', '..'));
    const sourcePath = path.join(projectRoot, relativePath);
    const result = esbuild.buildSync({
        entryPoints: [sourcePath],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        write: false
    });
    const loaded = new Module(sourcePath, module);
    loaded.filename = sourcePath;
    loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
    loaded._compile(result.outputFiles[0].text, sourcePath);
    return loaded.exports;
}

const workspace = loadRendererModule('src/view/bgp/bgpRouteWorkspace.js');
const schema = loadRendererModule('src/view/bgp/bgpVpnEvpnSchema.js');
const attributes = loadRendererModule('src/view/bgp/bgpAttributeRules.js');
const { isSchemaFieldVisible } = loadRendererModule('src/utils/schemaForm.js');
const make = (profile, patch = {}) => workspace.createRouteGroup(profile, profile, patch);
const visibleFields = config =>
    workspace
        .getRouteSections(config)
        .flatMap(section => section.fields)
        .filter(field => isSchemaFieldVisible(field, config))
        .map(field => field.key);
const expectValid = config => assert.deepEqual(workspace.validateRouteConfig(config), {});
const overlap = (left, right) => workspace.findRouteGroupOverlap([left, right], left.id);
const withRule = (config, type, patch) => ({
    ...config,
    nlriRules: config.nlriRules.map(rule => (rule.type === type ? { ...rule, ...patch } : rule))
});
const ruleFor = (config, type) => config.nlriRules.find(rule => rule.type === type);
const addRule = (config, type, patch = {}) => ({
    ...config,
    nlriRules: [
        ...config.nlriRules,
        { ...attributes.createAttributeRule(type, config.addressFamily, config), ...patch }
    ]
});
const expectRuleError = (config, type, patch) => {
    const changed = withRule(config, type, patch);
    assert.ok(workspace.validateRouteConfig(changed)[`rule:${ruleFor(config, type).id}`]);
};

for (const [profile, addressFamily] of [
    ['vpnv4', 4],
    ['vpnv6', 5],
    ['evpn', 3]
]) {
    const first = make(profile);
    const second = make(profile, withRule(first.config, 'rd', { value: '65000:2' }));
    assert.equal(first.config.addressFamily, addressFamily);
    assert.equal(first.config.nlriEncoding, 'mpReach');
    assert.ok(first.config.nlriRules.some(rule => rule.type === 'mpNextHop'));
    assert.ok(!first.config.attributeRules.some(rule => rule.type === 'nextHop'));
    assert.equal(first.config.attributeRules.find(rule => rule.type === 'extendedCommunities').value, 'rt:65000:1');
    expectValid(first.config);
    const saved = workspace.serializeRouteWorkspace(profile, [first, second], second.id);
    const restored = workspace.restoreRouteWorkspace(profile, saved);
    assert.equal(restored.activeGroupId, second.id);
    assert.deepEqual(
        restored.groups,
        [first, second],
        `${profile} must retain groups, active selection, and NLRI fields`
    );
    assert.ok(workspace.describeRouteRange(first.config).includes('RD 65000:1'));
    assert.ok(workspace.describeRouteNlri(first.config).includes('RD 65000:1'));
    assert.ok(workspace.getRouteResultColumns(first.config).some(column => column.key === 'rd'));
}

assert.equal(schema.canonicalVpnEvpnRd('065000:0001'), '65000:1');
assert.equal(schema.canonicalVpnEvpnRd('4294967295:65535'), '4294967295:65535');
assert.equal(schema.canonicalVpnEvpnRd('192.0.2.1:65535'), '192.0.2.1:65535');
assert.throws(() => schema.canonicalVpnEvpnRd('65536:65536'));
assert.throws(() => schema.canonicalVpnEvpnRd('192.0.2.1:65536'));
assert.throws(() => schema.canonicalVpnEvpnRd('4294967296:1'));

const vpn = make('vpnv4', { prefix: '10.2.0.99', count: '3', ipStep: '2' });
const sharedPrefix = make('vpnv4', {
    ...withRule(withRule(vpn.config, 'rd', { value: '065000:0001' }), 'label', { value: 2000 }),
    prefix: '10.2.4.0',
    count: '1'
});
assert.equal(overlap(vpn, sharedPrefix)?.groupId, sharedPrefix.id, 'labels do not change VPN route identity');
assert.equal(overlap(vpn, make('vpnv4', withRule(sharedPrefix.config, 'rd', { value: '65000:2' }))), null);
assert.equal(overlap(vpn, make('vpnv6')), null);
const rdId = vpn.config.nlriRules.find(rule => rule.type === 'rd').id;
const labelId = vpn.config.nlriRules.find(rule => rule.type === 'label').id;
assert.ok(workspace.validateRouteConfig(withRule(vpn.config, 'rd', { value: '65000:4294967296' }))[`rule:${rdId}`]);
assert.ok(workspace.validateRouteConfig({ ...vpn.config, prefix: '2001:db8::' }).prefix);
assert.ok(workspace.validateRouteConfig(withRule(vpn.config, 'label', { value: '1048576' }))[`rule:${labelId}`]);
assert.ok(
    workspace.validateRouteConfig(withRule(vpn.config, 'label', { mode: 'increment', start: '1048575' }))[
        `rule:${labelId}`
    ]
);
expectValid(withRule(vpn.config, 'label', { mode: 'increment', start: '1048571', step: '2' }));
assert.deepEqual(visibleFields(vpn.config), ['prefix', 'mask', 'count', 'ipStep']);
for (const field of ['rd', 'labelMode', 'labelStart', 'labelStep']) {
    assert.equal(Object.hasOwn(vpn.config, field), false);
    assert.equal(Object.hasOwn(workspace.compileRouteTreePayload(vpn.config), field), false);
}
const flatDraft = make('vpnv4', { rd: '65000:999', labelMode: 'increment', labelStart: '2000', labelStep: '3' });
assert.equal(flatDraft.config.nlriRules.find(rule => rule.type === 'rd').value, '65000:1');
assert.equal(flatDraft.config.nlriRules.find(rule => rule.type === 'label').value, 1000);
const explicitEmpty = make('vpnv4', { nlriRules: [] });
assert.deepEqual(
    explicitEmpty.config.nlriRules.map(rule => rule.type),
    ['rd', 'label']
);
expectValid(explicitEmpty.config);
for (const type of ['rd', 'label']) {
    const rule = vpn.config.nlriRules.find(rule => rule.type === type);
    const absent = { ...vpn.config, nlriRules: vpn.config.nlriRules.filter(entry => entry.type !== type) };
    assert.ok(workspace.validateRouteConfig(absent)[`rule:${type}`]);
    const duplicate = { ...vpn.config, nlriRules: [...vpn.config.nlriRules, { ...rule, id: `${rule.id}-duplicate` }] };
    assert.ok(workspace.validateRouteConfig(duplicate)[`rule:${rule.id}`]);
    assert.ok(workspace.validateRouteConfig(duplicate)[`rule:${rule.id}-duplicate`]);
    const definition = attributes.ATTRIBUTE_CATALOG.find(entry => entry.type === type);
    assert.deepEqual(definition.requiredAddressFamilies, [3, 4, 5]);
    assert.equal(workspace.getRouteResultColumns(vpn.config).filter(column => column.key === type).length, 1);
}
assert.equal(
    attributes.getDefaultNlriRules(1).some(rule => rule.type === 'rd'),
    false
);
assert.equal(attributes.createAttributeRule('label', 12).value, 16);
assert.equal(attributes.createAttributeRule('label', 5).value, 1000);
assert.ok(workspace.validateRouteConfig(make('vpnv6', { prefix: 'ffff:ffff:ffff:ffff::', count: '2' }).config).count);

for (const profile of ['vpnv4', 'vpnv6']) {
    const original = make(profile, { count: '3' });
    const rule = original.config.nlriRules.find(rule => rule.type === 'rd');
    for (const [patch, expected] of [
        [{ mode: 'fixed', value: '065000:0001' }, ['65000:1', '65000:1', '65000:1']],
        [
            { mode: 'increment', base: '192.0.2.1', start: '100', step: '5' },
            ['192.0.2.1:100', '192.0.2.1:105', '192.0.2.1:110']
        ],
        [{ mode: 'increment', base: '65000', start: '100', step: '-5' }, ['65000:100', '65000:95', '65000:90']],
        [
            { mode: 'random', base: '4294967295', min: '10', max: '10' },
            ['4294967295:10', '4294967295:10', '4294967295:10']
        ],
        [{ mode: 'list', values: ['65000:100', '192.0.2.1:200'] }, ['65000:100', '192.0.2.1:200', '65000:100']]
    ]) {
        const config = withRule(original.config, 'rd', patch);
        expectValid(config);
        assert.deepEqual(
            [0, 1, 2].map(index => attributes.previewAttributeRule({ ...rule, ...patch }, index, config)),
            expected
        );
        const group = make(profile, config);
        const saved = workspace.serializeRouteWorkspace(profile, [group], group.id);
        assert.deepEqual(
            workspace.restoreRouteWorkspace(profile, saved).groups[0].config.nlriRules,
            group.config.nlriRules
        );
    }
    for (const patch of [
        { mode: 'increment', base: '192.0.2.1', start: '65534', step: '1' },
        { mode: 'increment', base: '65000', start: '0', step: '-1' },
        { mode: 'random', base: '', min: '0', max: '1' },
        { mode: 'random', base: '65536', min: '0', max: '65536' },
        { mode: 'random', base: '65000', min: '10', max: '9' },
        { mode: 'list', values: ['65000:1', 'broken'] }
    ])
        assert.ok(workspace.validateRouteConfig(withRule(original.config, 'rd', patch))[`rule:${rule.id}`]);
}
const incrementRd = make(
    'vpnv4',
    withRule(vpn.config, 'rd', { mode: 'increment', base: '65000', start: '100', step: '5' })
);
assert.ok(overlap(incrementRd, make('vpnv4', withRule(sharedPrefix.config, 'rd', { value: '65000:110' }))));
assert.equal(
    overlap(incrementRd, make('vpnv4', withRule(sharedPrefix.config, 'rd', { value: '65000:105' }))),
    null,
    'RD and prefix must match on the same generated route'
);
const listRd = make('vpnv4', {
    ...withRule(vpn.config, 'rd', { mode: 'list', values: ['65000:1', '192.0.2.1:2'] }),
    count: '6'
});
assert.ok(
    overlap(
        listRd,
        make('vpnv4', { ...withRule(sharedPrefix.config, 'rd', { value: '192.0.2.1:2' }), prefix: '10.2.6.0' })
    )
);
assert.equal(
    overlap(listRd, make('vpnv4', withRule(sharedPrefix.config, 'rd', { value: '192.0.2.1:2' }))),
    null,
    'periodic RD lists retain their prefix-index alignment'
);
const randomRd = make('vpnv4', withRule(vpn.config, 'rd', { mode: 'random', base: '65000', min: '1', max: '2' }));
expectValid(randomRd.config);
assert.equal(overlap(randomRd, sharedPrefix), null, 'random RD collision checks are deferred to actual worker keys');
assert.match(workspace.describeRouteRange(randomRd.config), /RD 按随机规则生成/);
assert.ok(!workspace.describeRouteRange(randomRd.config).includes('DQPN'));
assert.match(workspace.describeRouteNlri(randomRd.config), /65000:1–2/);

for (const type of [1, 2, 3, 4, 5]) {
    const config = make('evpn', { routeType: type, count: '3' }).config;
    expectValid(config);
    const payload = workspace.compileRouteTreePayload(config);
    assert.equal(payload.routeType, type);
    assert.equal(payload.addressFamily, 3);
    assert.ok(payload.nlriRules.some(rule => rule.type === 'mpNextHop'));
    if (type !== 5) {
        assert.ok(!Object.hasOwn(payload, 'prefix'), `Type ${type} must omit inactive prefix`);
        assert.ok(!Object.hasOwn(payload, 'mask'));
        assert.ok(!Object.hasOwn(payload, 'gatewayIp'));
    }
    if (![1, 2, 3, 5].includes(type)) {
        assert.ok(!Object.hasOwn(payload, 'label'));
        assert.ok(!Object.hasOwn(payload, 'vni'));
    }
    if (type !== 2) {
        assert.ok(!Object.hasOwn(payload, 'macAddress'));
        assert.ok(!Object.hasOwn(payload, 'ipAddress'));
        assert.ok(!Object.hasOwn(payload, 'label2'));
    }
    assert.ok(!Object.hasOwn(payload, 'vni'), 'MPLS route payload must omit inactive VNI fields');
    assert.ok(workspace.describeRouteRange(config).includes(`Type ${type}`));
}

const macOnly = make('evpn', { ipAddress: '', count: '3' });
expectValid(macOnly.config);
assert.ok(workspace.validateRouteConfig({ ...macOnly.config, macAddress: '02:00:00:00:00' }).macAddress);
assert.ok(workspace.validateRouteConfig({ ...macOnly.config, macAddress: 'ff:ff:ff:ff:ff:fe' }).count);
assert.ok(workspace.validateRouteConfig({ ...macOnly.config, ipAddress: '255.255.255.255' }).count);
assert.ok(workspace.validateRouteConfig({ ...macOnly.config, ipAddress: 'broken' }).ipAddress);
const sharedMac = make('evpn', {
    ...withRule(macOnly.config, 'label', { value: '2000' }),
    macAddress: '02:00:00:00:00:02',
    esi: '00:00:00:00:00:00:00:00:00:01'
});
assert.ok(overlap(macOnly, sharedMac), 'ESI and labels do not change a Type 2 NLRI key');
assert.equal(overlap(macOnly, make('evpn', { ...sharedMac.config, ethernetTagId: '1' })), null);
assert.equal(
    overlap(
        make('evpn', { count: '3', ipStep: '2' }),
        make('evpn', { macAddress: '02:00:00:00:00:02', ipAddress: '192.0.2.2', count: '1' })
    ),
    null,
    'Type 2 MAC and IP progressions must match on the same generated route'
);

const autoDiscovery = make('evpn', { routeType: 1, count: '3', ethernetTagId: '4294967294' });
assert.ok(workspace.validateRouteConfig(autoDiscovery.config).count);
const segment = make('evpn', { routeType: 4 });
assert.equal(ruleFor(segment.config, 'rd').value, '192.0.2.1:1');
assert.equal(segment.config.esi, '01:02:00:00:00:00:01:00:00:00');
expectValid(segment.config);
expectRuleError(segment.config, 'rd', { value: '65000:1' });
assert.ok(workspace.validateRouteConfig({ ...segment.config, esi: '00:00:00:00:00:00:00:00:00:00' }).esi);
assert.ok(workspace.validateRouteConfig({ ...segment.config, esi: '00:00:00:00:00:00:00:00:00:01' }).esImportRt);
expectValid({ ...segment.config, esi: '00:00:00:00:00:00:00:00:00:01', esImportRt: '02:00:00:00:00:01' });
assert.ok(workspace.validateRouteConfig({ ...segment.config, esImportRt: 'broken' }).esImportRt);
const switched = schema.normalizeEvpnRouteTypeChange(make('evpn').config, { ...make('evpn').config, routeType: 4 });
assert.equal(ruleFor(switched, 'rd').value, '192.0.2.1:1');
assert.equal(switched.esi, segment.config.esi);
expectValid(switched);
assert.doesNotThrow(() =>
    schema.normalizeEvpnRouteTypeChange(make('evpn').config, { ...make('evpn').config, routeType: 4, esi: 'broken' })
);
assert.equal(overlap(segment, make('evpn', { ...segment.config, esi: '01:02:00:00:00:00:02:00:00:00' })), null);
assert.ok(!Object.hasOwn(workspace.compileRouteTreePayload(segment.config), 'ethernetTagId'));

const ipv6Prefix = make('evpn', { routeType: 5, prefix: '2001:db8:1::1', mask: '64', gatewayIp: '::', count: '3' });
expectValid(ipv6Prefix.config);
assert.ok(workspace.validateRouteConfig({ ...ipv6Prefix.config, gatewayIp: '0.0.0.0' }).gatewayIp);
assert.ok(
    overlap(
        ipv6Prefix,
        make('evpn', {
            ...withRule(ipv6Prefix.config, 'label', { value: '2000' }),
            prefix: '2001:db8:1:1::',
            esi: '00:00:00:00:00:00:00:00:00:01',
            gatewayIp: '::'
        })
    ),
    'Type 5 ESI, gateway, and labels are forwarding fields and do not change its NLRI key'
);
assert.ok(
    workspace.validateRouteConfig({
        ...ipv6Prefix.config,
        esi: '00:00:00:00:00:00:00:00:00:01',
        gatewayIp: '2001:db8::1'
    }).gatewayIp
);
expectValid({ ...ipv6Prefix.config, esi: '00:00:00:00:00:00:00:00:00:01', gatewayIp: '::' });
expectValid({ ...ipv6Prefix.config, gatewayIp: '2001:db8::1' });
const vxlan = make('evpn', { encapsulationType: 'vxlan' });
vxlan.config = addRule(withRule(vxlan.config, 'vni', { value: '16777215' }), 'vni2', { value: '10000' });
expectValid(vxlan.config);
const vxlanPayload = workspace.compileRouteTreePayload(vxlan.config);
assert.equal(ruleFor(vxlanPayload, 'vni').value, '16777215');
assert.equal(ruleFor(vxlanPayload, 'vni2').value, '10000');
assert.ok(!Object.hasOwn(vxlanPayload, 'label'));
assert.ok(!Object.hasOwn(vxlanPayload, 'label2'));
expectRuleError(vxlan.config, 'vni', { value: '16777216' });
const evpnColumns = workspace.getRouteResultColumns(vxlan.config);
assert.equal(
    evpnColumns
        .find(column => column.key === 'forwardingLabel')
        .customRender({ record: { encapsulationType: 'vxlan', vni: '16777215', vni2: '10000' } }),
    'VNI 16777215 / 10000'
);
assert.equal(
    evpnColumns
        .find(column => column.key === 'nlri')
        .customRender({ record: { routeType: 5, ethernetTagId: 0, ip: '2001:db8::', mask: 64, gatewayIp: '::' } }),
    'Tag 0 · 2001:db8::/64 · GW ::',
    'the shared EVPN results table must show Type 5 fields even while a Type 2 group is selected'
);

// EVPN NLRI rules are authoritative; flat forwarding drafts are never migrated.
const flatEvpn = make('evpn', { rd: '65000:99', label: 9999, label2: 9998, vni: 99, vni2: 98 });
for (const key of ['rd', 'label', 'label2', 'vni', 'vni2']) {
    assert.equal(Object.hasOwn(flatEvpn.config, key), false);
    assert.equal(Object.hasOwn(workspace.compileRouteTreePayload(flatEvpn.config), key), false);
    assert.ok(!visibleFields(flatEvpn.config).includes(key));
}
assert.equal(ruleFor(flatEvpn.config, 'rd').value, '65000:1');
assert.equal(ruleFor(flatEvpn.config, 'label').value, 1000);
for (const [encapsulationType, type, requiredTypes] of [
    ['mpls', 2, ['rd', 'label']],
    ['vxlan', 2, ['rd', 'vni']],
    ['srv6', 1, ['rd', 'srv6L2']],
    ['srv6', 2, ['rd', 'srv6L2']],
    ['srv6', 3, ['rd', 'srv6L2']],
    ['srv6', 4, ['rd']],
    ['srv6', 5, ['rd', 'srv6L3']]
]) {
    const config = make('evpn', { routeType: type, encapsulationType }).config;
    expectValid(config);
    assert.deepEqual(
        config.nlriRules.filter(rule => attributes.isAttributeRuleRequired(rule, config)).map(rule => rule.type),
        requiredTypes
    );
    for (const rule of config.nlriRules) {
        assert.ok(attributes.isAttributeRuleApplicable(rule, config));
        const duplicate = { ...config, nlriRules: [...config.nlriRules, { ...rule, id: 'duplicate' }] };
        assert.ok(workspace.validateRouteConfig(duplicate)[`rule:${rule.id}`]);
        if (attributes.isAttributeRuleRequired(rule, config))
            assert.ok(
                workspace.validateRouteConfig({
                    ...config,
                    nlriRules: config.nlriRules.filter(other => other !== rule)
                })[`rule:${rule.type}`]
            );
    }
    const payload = workspace.compileRouteTreePayload(config);
    assert.deepEqual(
        payload.nlriRules.map(rule => rule.type),
        config.nlriRules.map(rule => rule.type)
    );
    const group = make('evpn', config);
    assert.deepEqual(
        workspace.restoreRouteWorkspace('evpn', workspace.serializeRouteWorkspace('evpn', [group], group.id)).groups[0],
        group
    );
}

// All four RD modes use the same generated route index as the MAC/IP sequence.
const changingEvpn = make('evpn', { count: '3' });
for (const [patch, expected] of [
    [{ mode: 'fixed', value: '065000:100' }, ['65000:100', '65000:100', '65000:100']],
    [
        { mode: 'increment', base: '192.0.2.1', start: '100', step: '5' },
        ['192.0.2.1:100', '192.0.2.1:105', '192.0.2.1:110']
    ],
    [{ mode: 'random', base: '65000', min: '100', max: '100' }, ['65000:100', '65000:100', '65000:100']],
    [{ mode: 'list', values: ['65000:100', '192.0.2.1:200'] }, ['65000:100', '192.0.2.1:200', '65000:100']]
]) {
    const config = withRule(changingEvpn.config, 'rd', patch);
    expectValid(config);
    assert.deepEqual(
        [0, 1, 2].map(index => attributes.previewAttributeRule(ruleFor(config, 'rd'), index, config)),
        expected
    );
}
const rdIncrementEvpn = make(
    'evpn',
    withRule(changingEvpn.config, 'rd', { mode: 'increment', base: '65000', start: '100', step: '5' })
);
const evpnIndex1 = make('evpn', {
    ...withRule(changingEvpn.config, 'rd', { value: '65000:105' }),
    macAddress: '02:00:00:00:00:02',
    ipAddress: '192.0.2.2',
    count: '1'
});
assert.ok(overlap(rdIncrementEvpn, evpnIndex1));
assert.equal(overlap(rdIncrementEvpn, make('evpn', withRule(evpnIndex1.config, 'rd', { value: '65000:110' }))), null);
const rdListEvpn = make(
    'evpn',
    withRule(changingEvpn.config, 'rd', { mode: 'list', values: ['65000:100', '192.0.2.1:200'] })
);
assert.ok(overlap(rdListEvpn, make('evpn', withRule(evpnIndex1.config, 'rd', { value: '192.0.2.1:200' }))));
assert.equal(overlap(rdListEvpn, make('evpn', withRule(evpnIndex1.config, 'rd', { value: '65000:100' }))), null);
const evpnRandom = withRule(changingEvpn.config, 'rd', { mode: 'random', base: '65000', min: 1, max: 2 });
assert.match(workspace.describeRouteRange(evpnRandom), /Type 2 · RD 按随机规则生成/);
assert.ok(!workspace.describeRouteNlri(evpnRandom).includes('undefined'));
assert.ok(workspace.validateRouteConfig({ ...evpnRandom, ipAddress: '255.255.255.255' }).count);

for (const patch of [
    { mode: 'fixed', value: '65000:1' },
    { mode: 'increment', base: '65000', start: 1, step: 1 },
    { mode: 'random', base: '65000', min: 1, max: 2 },
    { mode: 'list', values: ['192.0.2.1:1', '65000:2'] }
])
    expectRuleError(segment.config, 'rd', patch);
for (const patch of [
    { mode: 'increment', base: '192.0.2.1', start: 1, step: 1 },
    { mode: 'random', base: '192.0.2.1', min: 1, max: 2 },
    { mode: 'list', values: ['192.0.2.1:1', '192.0.2.2:2'] }
])
    expectValid(withRule(segment.config, 'rd', patch));

const srv6 = make('evpn', { encapsulationType: 'srv6', count: '3' }).config;
assert.equal(ruleFor(srv6, 'mpNextHop').mode, 'fixed');
assert.equal(ruleFor(srv6, 'mpNextHop').value, '2001:db8::1');
assert.equal(ruleFor(srv6, 'srv6L2').endpointBehavior, 23);
assert.deepEqual(
    [
        'locatorBlockLength',
        'locatorNodeLength',
        'functionLength',
        'argumentLength',
        'transpositionLength',
        'transpositionOffset'
    ].map(key => ruleFor(srv6, 'srv6L2')[key]),
    [32, 32, 64, 0, 0, 0]
);
for (const patch of [
    { mode: 'fixed', value: '2001:db8:1::100' },
    { mode: 'increment', start: '2001:db8:1::100', step: 1 },
    { mode: 'list', values: ['2001:db8:1::100', '2001:db8:1::101'] }
])
    expectValid(withRule(srv6, 'srv6L2', patch));
for (const patch of [
    { value: '192.0.2.1' },
    { endpointBehavior: 24 },
    { argumentLength: 1 },
    { transpositionLength: 1 },
    { transpositionOffset: 1 },
    { locatorBlockLength: 64, locatorNodeLength: 64, functionLength: 64 },
    { functionLength: 16, value: '2001:db8:1::1' },
    { mode: 'increment', functionLength: 16, start: '2001:db8:1::', step: 1 },
    { mode: 'list', values: ['2001:db8:1::100', 'bad'] }
])
    expectRuleError(srv6, 'srv6L2', patch);
expectRuleError(srv6, 'mpNextHop', { value: '192.0.2.1' });
const dualSid = addRule(srv6, 'srv6L3');
expectValid(dualSid);
assert.equal(attributes.isAttributeRuleRequired(ruleFor(dualSid, 'srv6L3'), dualSid), false);
assert.deepEqual(
    attributes
        .getAttributeRuleFields(ruleFor(dualSid, 'srv6L3'), dualSid)
        .find(field => field.key === 'endpointBehavior')
        .options.map(option => option.value),
    [17, 19, 20]
);
expectRuleError(dualSid, 'srv6L3', { endpointBehavior: 18 });
expectValid(withRule({ ...dualSid, ipAddress: '2001:db8::1' }, 'srv6L3', { endpointBehavior: 18 }));
const noIp = schema.normalizeEvpnRouteTypeChange(dualSid, { ...dualSid, ipAddress: '' });
assert.equal(ruleFor(noIp, 'srv6L3'), undefined);
assert.equal(
    ruleFor(schema.normalizeEvpnRouteTypeChange(noIp, { ...noIp, ipAddress: '192.0.2.1' }), 'srv6L3'),
    undefined
);
const srv6Columns = workspace.getRouteResultColumns(dualSid);
const generatedServices = {
    srv6Services: [
        { serviceType: 'l2', sid: '2001:db8:1::42' },
        { serviceType: 'l3', sid: '2001:db8:3::42' }
    ]
};
assert.equal(
    srv6Columns.find(column => column.key === 'srv6L2').customRender({ record: generatedServices }),
    '2001:db8:1::42'
);
assert.equal(
    srv6Columns.find(column => column.key === 'srv6L3').customRender({ record: generatedServices }),
    '2001:db8:3::42'
);

// Context switches retain valid custom SIDs, reset required endpoint behavior,
// and remove forwarding nodes belonging to another encapsulation or route type.
const customSid = withRule(srv6, 'srv6L2', { value: '2001:db8:abcd::1234' });
const imet = schema.normalizeEvpnRouteTypeChange(customSid, { ...customSid, routeType: 3 });
assert.equal(ruleFor(imet, 'srv6L2').value, '2001:db8:abcd::1234');
assert.equal(ruleFor(imet, 'srv6L2').endpointBehavior, 24);
expectValid(imet);
assert.deepEqual(
    attributes
        .getAttributeRuleFields(ruleFor(imet, 'srv6L2'), imet)
        .find(field => field.key === 'endpointBehavior')
        .options.map(option => option.value),
    [24]
);
const mplsAgain = schema.normalizeEvpnRouteTypeChange(dualSid, { ...dualSid, encapsulationType: 'mpls' });
assert.deepEqual(
    mplsAgain.nlriRules.map(rule => rule.type),
    ['mpNextHop', 'rd', 'label']
);
const vxlanAgain = schema.normalizeEvpnRouteTypeChange(mplsAgain, { ...mplsAgain, encapsulationType: 'vxlan' });
assert.deepEqual(
    vxlanAgain.nlriRules.map(rule => rule.type),
    ['mpNextHop', 'rd', 'vni']
);
const noForwarding = schema.normalizeEvpnRouteTypeChange(dualSid, { ...dualSid, routeType: 4 });
assert.deepEqual(
    noForwarding.nlriRules.map(rule => rule.type),
    ['mpNextHop', 'rd']
);
expectValid(noForwarding);

for (const encapsulationType of ['mpls', 'vxlan', 'srv6']) {
    const perEs = make('evpn', { routeType: 1, ethernetTagId: '4294967295', encapsulationType }).config;
    expectValid(perEs);
    assert.equal(ruleFor(perEs, 'rd').value, '192.0.2.1:1');
    assert.ok(!visibleFields(perEs).includes('ethernetTagStep'));
    assert.equal(Object.hasOwn(workspace.compileRouteTreePayload(perEs), 'ethernetTagStep'), false);
    expectRuleError(perEs, 'rd', { value: '192.0.2.1:0' });
    expectRuleError(perEs, 'rd', { mode: 'random', base: '192.0.2.1', min: 0, max: 1 });
    assert.ok(workspace.validateRouteConfig({ ...perEs, esi: '00:00:00:00:00:00:00:00:00:00' }).esi);
    assert.ok(workspace.validateRouteConfig({ ...perEs, count: 2 }).count);
    const multiple = withRule({ ...perEs, count: 3 }, 'rd', {
        mode: 'increment',
        base: '192.0.2.1',
        start: 1,
        step: 1
    });
    expectValid(multiple);
    const target = make('evpn', withRule(perEs, 'rd', { value: '192.0.2.1:2' }));
    assert.ok(overlap(make('evpn', multiple), target));
    if (encapsulationType === 'srv6') {
        assert.equal(ruleFor(perEs, 'srv6L2').value, '::');
        assert.equal(ruleFor(perEs, 'srv6L2').endpointBehavior, 24);
        expectRuleError(perEs, 'srv6L2', { value: '2001:db8::1' });
        const perEvi = schema.normalizeEvpnRouteTypeChange(perEs, { ...perEs, ethernetTagId: '100' });
        assert.notEqual(ruleFor(perEvi, 'srv6L2').value, '::');
        assert.equal(ruleFor(perEvi, 'srv6L2').endpointBehavior, 23);
        expectValid(perEvi);
        const back = schema.normalizeEvpnRouteTypeChange(perEvi, { ...perEvi, ethernetTagId: '4294967295' });
        assert.equal(ruleFor(back, 'srv6L2').value, '::');
        expectValid(back);
    } else {
        const type = encapsulationType === 'mpls' ? 'label' : 'vni';
        assert.equal(ruleFor(perEs, type).value, 0);
        expectRuleError(perEs, type, { value: 1 });
        expectRuleError(perEs, type, { mode: 'random', min: 0, max: 1 });
        expectValid(withRule(multiple, type, { mode: 'increment', start: 0, step: 0 }));
    }
}

console.log('BGP VPNv4/VPNv6/EVPN/SRv6 route schema tests passed');
