const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const { buildAttributeRuleContext, getGeneratedAttributeValues } = require('../../electron/utils/bgpAttributeRules');

function loadFrontend(file) {
    const sourcePath = path.resolve(__dirname, '../../src/view/bgp', file);
    const result = esbuild.buildSync({
        entryPoints: [sourcePath],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        write: false
    });
    const loaded = new Module(sourcePath, module);
    loaded._compile(result.outputFiles[0].text, sourcePath);
    return loaded.exports;
}

const {
    createIpv4RouteGroup,
    restoreIpv4RouteWorkspace,
    serializeIpv4RouteWorkspace,
    findIpv4RouteGroupOverlap,
    describeIpv4RouteRange
} = loadFrontend('ipv4RouteWorkspace.js');
const {
    createAttributeRule,
    previewAttributeRule,
    validateAttributeRule,
    describeAttributeRule,
    ATTRIBUTE_CATALOG,
    getAttributeRuleFields,
    getDefaultAttributeRules,
    getDefaultNlriRules,
    normalizeAttributeRules,
    getRuleSection,
    getRuleModeHelp,
    getAttributeResultColumns,
    getGeneratedRouteCount,
    getGeneratedPrefixCount,
    isMpNlriEncoding,
    normalizeRouteRuleSections,
    compileRouteRulePayload
} = loadFrontend('bgpAttributeRules.js');
const { getVisibleRouteSections } = loadFrontend('ipv4RouteSchema.js');
const { validateRouteConfig } = loadFrontend('bgpRouteWorkspace.js');

const defaultGroup = createIpv4RouteGroup();
assert.deepEqual(
    defaultGroup.config.attributeRules.map(rule => rule.type),
    getDefaultAttributeRules(1).map(rule => rule.type)
);
assert.deepEqual(
    defaultGroup.config.nlriRules.map(rule => rule.type),
    getDefaultNlriRules(1).map(rule => rule.type)
);
assert.equal(getRuleSection(createAttributeRule('addPath')), 'nlri');
assert.equal(getRuleSection(createAttributeRule('label')), 'nlri');
assert.equal(getRuleSection(createAttributeRule('srv6')), 'attributes');
assert.equal(defaultGroup.config.nlriEncoding, 'auto');
assert.equal(defaultGroup.config.ipStep, '1');
assert.ok(
    getVisibleRouteSections()
        .flatMap(section => section.fields)
        .some(field => field.key === 'ipStep')
);
assert.equal(compileRouteRulePayload(defaultGroup.config).ipStep, '1');
assert.equal(isMpNlriEncoding(defaultGroup.config), false);
assert.equal(isMpNlriEncoding({ ...defaultGroup.config, nlriEncoding: 'mpReach' }), true);
const labelGroup = createIpv4RouteGroup('标签', { addressFamily: 12 });
assert.equal(isMpNlriEncoding(labelGroup.config), true, 'Label NLRI always uses MP encoding');
assert.ok(labelGroup.config.nlriRules.some(rule => rule.type === 'label'));
assert.ok(!labelGroup.config.nlriRules.some(rule => ['addPath', 'mpNextHop'].includes(rule.type)));
assert.ok(!defaultGroup.config.attributeRules.some(rule => rule.type === 'srv6'));
assert.ok(ATTRIBUTE_CATALOG.every(entry => !Object.hasOwn(entry.default, 'enabled')));
assert.ok(!labelGroup.config.attributeRules.some(rule => ['label', 'addPath'].includes(rule.type)));
const labelPathConfig = {
    ...labelGroup.config,
    count: 3,
    nlriRules: [...labelGroup.config.nlriRules, { ...createAttributeRule('addPath'), count: 2 }]
};
assert.equal(getGeneratedRouteCount(labelPathConfig), 6);
const labelPathPayload = compileRouteRulePayload(labelPathConfig);
assert.ok(labelPathPayload.nlriRules.some(rule => rule.type === 'addPath' && rule.count === 2));
assert.ok(getAttributeResultColumns(labelPathConfig).some(column => column.key === 'pathId'));
assert.deepEqual(
    Array.from(
        { length: 6 },
        (_, index) => getGeneratedAttributeValues(buildAttributeRuleContext(labelPathPayload), index).pathId
    ),
    [0, 1, 0, 1, 0, 1]
);
const medDefinition = ATTRIBUTE_CATALOG.find(entry => entry.type === 'med');
const previousDefault = medDefinition.default.value;
medDefinition.default.value = 37;
assert.equal(createAttributeRule('med').value, 37, 'default values must come from the attribute registry');
medDefinition.default.value = previousDefault;
const multiPathConfig = {
    ...defaultGroup.config,
    count: 5,
    nlriEncoding: 'mpReach',
    nlriRules: [...defaultGroup.config.nlriRules, { ...createAttributeRule('addPath'), count: 2 }]
};
assert.equal(getGeneratedRouteCount(multiPathConfig), 10);
assert.equal(getGeneratedPrefixCount(multiPathConfig), 5);
assert.equal(compileRouteRulePayload(multiPathConfig).nlriEncoding, 'mpReach');
assert.ok(getAttributeResultColumns(multiPathConfig).some(column => column.key === 'pathId'));
assert.equal(
    getAttributeResultColumns(multiPathConfig)
        .find(column => column.key === 'pathId')
        .customRender({ text: 0 }),
    0,
    'Path ID 0 must remain visible'
);
const pathContext = buildAttributeRuleContext(compileRouteRulePayload(multiPathConfig));
assert.deepEqual(
    Array.from({ length: 5 }, (_, index) => getGeneratedAttributeValues(pathContext, index).pathId),
    [0, 1, 0, 1, 0]
);
const pathRule = { ...createAttributeRule('addPath'), count: 3 };
assert.equal(getGeneratedRouteCount({ ...multiPathConfig, nlriRules: [pathRule] }), 15);
assert.equal(getGeneratedRouteCount({ ...multiPathConfig, nlriRules: [] }), 5);
assert.deepEqual(
    [0, 1, 2, 3].map(index => previewAttributeRule(pathRule, index)),
    ['0', '1', '2', '0']
);
assert.ok(getAttributeRuleFields(pathRule).some(field => field.key === 'count'));
assert.ok(getRuleModeHelp(pathRule).includes('Count ×'));
assert.match(previewAttributeRule({ ...pathRule, count: 0 }), /范围/);
assert.equal(getGeneratedRouteCount({ ...multiPathConfig, nlriRules: [{ ...pathRule, count: 0 }] }), 0);
assert.equal(getGeneratedRouteCount({ ...multiPathConfig, count: Number.MAX_SAFE_INTEGER }), 0);
assert.equal(
    getGeneratedRouteCount({ ...multiPathConfig, count: 1, nlriRules: [{ ...pathRule, count: 4294967296 }] }),
    4294967296
);
const groupPayload = compileRouteRulePayload(multiPathConfig, defaultGroup);
assert.equal(groupPayload.groupId, defaultGroup.id);
assert.equal(groupPayload.groupName, defaultGroup.name);
assert.equal(groupPayload.autoPathId, undefined);
assert.equal(
    compileRouteRulePayload({ ...multiPathConfig, addPathEnabled: true, srv6Enabled: true }).srv6Enabled,
    undefined
);
assert.ok(
    getAttributeRuleFields(createAttributeRule('srv6')).some(field => field.key === 'locatorBlockLength'),
    'SRv6 structure fields must be editable'
);

const workspace = {
    groups: [
        createIpv4RouteGroup('属性试验', {
            prefix: '10.0.0.1',
            mask: 32,
            count: 3,
            nlriEncoding: 'mpReach',
            nlriRules: [createAttributeRule('addPath')],
            attributeRules: [
                {
                    ...createAttributeRule('asPath'),
                    mode: 'random',
                    min: 64512,
                    max: 64512,
                    minLength: 3,
                    maxLength: 3
                },
                { ...createAttributeRule('extendedCommunities'), value: 'rt:65000:100' },
                { ...createAttributeRule('custom'), typeCode: '', value: 'c0 63 01 ff' }
            ]
        })
    ]
};
const config = workspace.groups[0].config;
const context = buildAttributeRuleContext(compileRouteRulePayload(config), () => 0.5);
assert.deepEqual(
    Object.fromEntries(
        Object.entries(getGeneratedAttributeValues(context, 0).attr).filter(([key]) =>
            ['asPath', 'extendedCommunities', 'customAttr'].includes(key)
        )
    ),
    {
        asPath: '64512 64512 64512',
        extendedCommunities: ['rt:65000:100'],
        customAttr: 'c06301ff'
    },
    'tree configuration must drive generated attributes'
);
const groupCopy = createIpv4RouteGroup('副本', config);
assert.notEqual(groupCopy.id, workspace.groups[0].id, 'a copy must get an independent ownership ID');
assert.equal(groupCopy.config.autoPathId, undefined);
groupCopy.config.attributeRules[0].min = 65000;
assert.equal(config.attributeRules[0].min, 64512, 'editing a copied group must not change the original rule');
const saved = serializeIpv4RouteWorkspace([workspace.groups[0], groupCopy], groupCopy.id);
const restored = restoreIpv4RouteWorkspace(saved);
assert.equal(saved.routeWorkspace.version, 6);
assert.equal(restored.activeGroupId, groupCopy.id);
assert.deepEqual(
    restored.groups.map(group => group.id),
    saved.routeWorkspace.groups.map(group => group.id),
    'group ownership IDs must survive reload'
);
assert.deepEqual(
    restored.groups.map(group => group.config.nlriRules),
    saved.routeWorkspace.groups.map(group => group.config.nlriRules)
);
assert.equal(restored.groups[0].config.nlriEncoding, 'mpReach');
const previousWorkspace = restoreIpv4RouteWorkspace({ routeWorkspace: { ...saved.routeWorkspace, version: 5 } });
assert.equal(previousWorkspace.groups.length, 1, 'a previous major configuration model is not migrated');
assert.deepEqual(
    restored.groups.map(group => group.config.attributeRules),
    saved.routeWorkspace.groups.map(group => group.config.attributeRules)
);
const noAttributes = createIpv4RouteGroup('无属性测试', { attributeRules: [] });
assert.deepEqual(noAttributes.config.attributeRules, []);
assert.deepEqual(normalizeRouteRuleSections(noAttributes.config).attributeRules, []);
const repeatedMed = [createAttributeRule('med'), createAttributeRule('med')];
const medColumns = getAttributeResultColumns({ ...defaultGroup.config, nlriRules: [], attributeRules: repeatedMed });
assert.deepEqual(
    medColumns.map(column => column.title),
    ['MED #1', 'MED #2']
);
const repeatedValues = {
    pathAttributes: [
        { type: 'med', value: 10 },
        { type: 'med', value: 90 }
    ]
};
assert.deepEqual(
    medColumns.map(column => column.customRender({ record: repeatedValues })),
    [10, 90]
);
assert.equal(medColumns[0].customRender({ record: { pathAttributes: [{ type: 'med', value: 0 }] } }), 0);

const mpIpv6 = { ...createAttributeRule('mpNextHop'), mode: 'fixed', value: '2001:db8::200' };
const classicMpDraft = { ...defaultGroup.config, nlriRules: [{ ...mpIpv6, value: 'unfinished-draft' }] };
assert.deepEqual(compileRouteRulePayload(classicMpDraft).nlriRules, []);
assert.equal(
    getGeneratedAttributeValues(buildAttributeRuleContext(compileRouteRulePayload(classicMpDraft)), 0).mpNextHop,
    null,
    'an unused MP next-hop draft must not block classic NLRI generation'
);
assert.equal(classicMpDraft.nlriRules[0].value, 'unfinished-draft', 'inactive MP configuration is retained');
assert.ok(!getAttributeResultColumns(classicMpDraft).some(column => column.key === 'mpNextHop'));
assert.deepEqual(
    compileRouteRulePayload({ ...classicMpDraft, nlriEncoding: 'mpReach', nlriRules: [mpIpv6] }).nlriRules,
    [mpIpv6]
);
assert.deepEqual(compileRouteRulePayload({ ...labelGroup.config, nlriRules: [mpIpv6] }).nlriRules, [mpIpv6]);
assert.equal(previewAttributeRule(mpIpv6), '2001:db8::200');
assert.equal(
    previewAttributeRule({ ...mpIpv6, mode: 'increment', start: '2001:db8::200', step: 2 }, 2),
    '2001:db8::204'
);
assert.equal(
    previewAttributeRule({ ...mpIpv6, mode: 'list', values: ['192.0.2.1', '2001:db8::200'] }, 1),
    '2001:db8::200'
);
assert.equal(
    previewAttributeRule({ ...mpIpv6, mode: 'random', min: '2001:db8::1', max: '2001:db8::1' }),
    '2001:db8::1'
);
assert.match(previewAttributeRule({ ...mpIpv6, mode: 'random', min: '192.0.2.1', max: '2001:db8::1' }), /同一地址族/);

for (const [rule, text] of [
    [{ ...createAttributeRule('med'), value: -1 }, '范围'],
    [{ ...createAttributeRule('origin'), mode: 'random', min: 5, max: 9 }, '范围'],
    [{ ...createAttributeRule('asPath'), mode: 'random', min: 65000, max: 0 }, '范围'],
    [{ ...createAttributeRule('label'), mode: 'increment', start: 1048575, step: 1 }, '范围']
])
    assert.ok(
        previewAttributeRule(rule, 1).includes(text),
        'invalid samples must not look like valid generated values'
    );

const nextHop = { ...createAttributeRule('nextHop'), mode: 'fixed', value: '010.0.0.1' };
assert.equal(
    previewAttributeRule(nextHop),
    getGeneratedAttributeValues(buildAttributeRuleContext({ count: 1, attributeRules: [nextHop] }), 0).attr.nextHop
);
const ascending = { ...createAttributeRule('med'), mode: 'increment', start: 10, step: 5 };
const ascendingContext = buildAttributeRuleContext({ count: 3, attributeRules: [ascending] });
for (let index = 0; index < 3; index++)
    assert.equal(
        previewAttributeRule(ascending, index),
        String(getGeneratedAttributeValues(ascendingContext, index).attr.med)
    );

assert.ok(!ATTRIBUTE_CATALOG.some(definition => definition.type === 'rt'), 'RT has no separate catalog entry');
const ext = createAttributeRule('extendedCommunities');
assert.equal(getRuleSection(ext), 'attributes');
assert.equal(ext.value, '', 'empty default must not insert an implicit RT');
const extFixed = {
    ...ext,
    value: 'RT:065000:00100 soo:192.0.2.1:20 hex:80AA0000000000FE'
};
assert.equal(previewAttributeRule(extFixed), 'rt:65000:100 soo:192.0.2.1:20 hex:80aa0000000000fe');
const extIncrement = { ...ext, mode: 'increment', subtype: 'soo', base: '192.0.2.1', start: 10, step: 2 };
assert.equal(previewAttributeRule(extIncrement, 2), 'soo:192.0.2.1:14');
const extRandom = { ...ext, mode: 'random', subtype: 'rt', base: 65000, min: 4294967295, max: 4294967295 };
assert.equal(previewAttributeRule(extRandom), 'rt:65000:4294967295');
const extList = { ...ext, mode: 'list', values: ['rt:65000:1 soo:65000:2', 'hex:ffffffffffffffff'] };
assert.equal(previewAttributeRule(extList, 0), 'rt:65000:1 soo:65000:2');
assert.equal(previewAttributeRule(extList, 1), 'hex:ffffffffffffffff');

const previewTokens = (rule, index = 0, config = {}) => previewAttributeRule(rule, index, config).trim().split(/\s+/);
for (const [type, valueCountMax, prefix] of [
    ['communities', 16383, '65000:'],
    ['extendedCommunities', 8191, 'rt:65000:']
]) {
    const rule = createAttributeRule(type);
    const metadata = ATTRIBUTE_CATALOG.find(entry => entry.type === type);
    assert.equal(rule.valueCount, 1, `${type} retains one generated value by default`);
    assert.equal(normalizeAttributeRules([{ ...rule, valueCount: undefined }])[0].valueCount, 1);
    assert.equal(normalizeAttributeRules([{ ...rule, valueCount: null }])[0].valueCount, null);
    assert.deepEqual(metadata.valueCountValidation, { min: 1, max: valueCountMax });
    for (const mode of ['increment', 'random']) {
        const fields = getAttributeRuleFields({ ...rule, mode });
        assert.ok(
            fields.some(field => field.key === 'valueCount'),
            `${type} ${mode} exposes per-route count`
        );
        for (const valueCount of [null, 0, -1, 1.5, '', 'invalid', valueCountMax + 1]) {
            const invalid = { ...rule, mode, valueCount };
            assert.notEqual(validateAttributeRule(invalid, { count: 1 }), '', `${type} rejects count ${valueCount}`);
        }
        assert.equal(
            validateAttributeRule({ ...rule, mode, valueCount: valueCountMax, start: 0, min: 0, max: 1 }, { count: 1 }),
            '',
            `${type} accepts the attribute-length boundary`
        );
    }
    for (const mode of ['fixed', 'list'])
        assert.ok(!getAttributeRuleFields({ ...rule, mode }).some(field => field.key === 'valueCount'));
    assert.equal(getAttributeRuleFields(rule).find(field => field.key === 'value').type, 'textarea');

    const increment = { ...rule, mode: 'increment', start: 100, step: 1, valueCount: 2 };
    assert.deepEqual(
        previewTokens({ ...increment, valueCount: undefined }, 1),
        [`${prefix}101`],
        'an omitted generated-value count retains the default of one'
    );
    assert.deepEqual(
        [0, 1, 2].map(index => previewTokens(increment, index)),
        [
            [`${prefix}100`, `${prefix}101`],
            [`${prefix}102`, `${prefix}103`],
            [`${prefix}104`, `${prefix}105`]
        ],
        'incremented values continue across complete route groups'
    );
    assert.match(describeAttributeRule(increment), /每路由\s*2\s*个/);
    assert.deepEqual(previewTokens({ ...increment, step: 3 }, 1), [`${prefix}106`, `${prefix}109`]);
    assert.deepEqual(previewTokens({ ...increment, start: 10, step: -2 }, 1), [`${prefix}6`, `${prefix}4`]);
    const random = { ...rule, mode: 'random', min: 0, max: 65535, valueCount: 3 };
    const sample = previewTokens(random, 0);
    assert.equal(sample.length, 3);
    assert.ok(new Set(sample).size > 1, 'random preview samples each value instead of cloning one draw');
    assert.deepEqual(previewTokens(random, 0), sample, 'random previews must remain stable at the same route index');
    assert.match(describeAttributeRule(random), /每路由\s*3\s*个/);
    for (let index = 0; index < 3; index++) {
        const values = previewTokens(random, index);
        assert.equal(values.length, 3);
        values.forEach(value => {
            assert.ok(value.startsWith(prefix));
            const number = Number(value.slice(prefix.length));
            assert.ok(Number.isInteger(number) && number >= 0 && number <= 65535);
        });
    }
    assert.deepEqual(
        previewTokens({ ...random, min: 42, max: 42 }),
        [`${prefix}42`, `${prefix}42`, `${prefix}42`],
        'duplicates are allowed when each independent draw has the same value'
    );

    const fixed = { ...rule, valueCount: 'stale-invalid', value: `${prefix}1\n${prefix}2 ${prefix}3` };
    assert.equal(validateAttributeRule(fixed, { count: 4 }), '');
    assert.deepEqual(previewTokens(fixed), [`${prefix}1`, `${prefix}2`, `${prefix}3`]);
    assert.equal(
        previewAttributeRule(fixed),
        `${prefix}1 ${prefix}2 ${prefix}3`,
        'multiline fixed values normalize whitespace'
    );
    assert.deepEqual(previewTokens({ ...fixed, value: `${prefix}1\n${prefix}1 ${prefix}2` }), [
        `${prefix}1`,
        `${prefix}1`,
        `${prefix}2`
    ]);
    const list = {
        ...rule,
        mode: 'list',
        valueCount: 0,
        values: [`${prefix}1 ${prefix}2`, `${prefix}3 ${prefix}4 ${prefix}5`]
    };
    assert.equal(validateAttributeRule(list, { count: 4 }), '');
    assert.deepEqual(
        [0, 1, 2].map(index => previewTokens(list, index)),
        [
            [`${prefix}1`, `${prefix}2`],
            [`${prefix}3`, `${prefix}4`, `${prefix}5`],
            [`${prefix}1`, `${prefix}2`]
        ],
        'list mode cycles complete groups, regardless of stale generated-value count'
    );
    const copyConfig = createIpv4RouteGroup('多值属性', { count: 3, attributeRules: [increment, random] });
    const roundTrip = restoreIpv4RouteWorkspace(serializeIpv4RouteWorkspace([copyConfig], copyConfig.id));
    assert.equal(roundTrip.activeGroupId, copyConfig.id);
    assert.deepEqual(roundTrip.groups[0].config.attributeRules, copyConfig.config.attributeRules);
    const payload = compileRouteRulePayload(roundTrip.groups[0].config, roundTrip.groups[0]);
    assert.deepEqual(
        payload.attributeRules.map(value => value.valueCount),
        [2, 3]
    );
    assert.deepEqual(previewTokens(payload.attributeRules[0], 1), [`${prefix}102`, `${prefix}103`]);
    const copied = createIpv4RouteGroup('多值副本', copyConfig.config);
    copied.config.attributeRules[0].valueCount = 4;
    assert.equal(copyConfig.config.attributeRules[0].valueCount, 2, 'copied per-route counts are independent');
}

const communityPathConfig = {
    ...defaultGroup.config,
    count: 3,
    nlriRules: [{ ...createAttributeRule('addPath'), count: 2 }]
};
for (const [type, base, max] of [
    ['communities', '65000', 65535],
    ['extendedCommunities', '65000', 4294967295],
    ['extendedCommunities', '70000', 65535],
    ['extendedCommunities', '192.0.2.1', 65535]
]) {
    const rule = { ...createAttributeRule(type), mode: 'increment', base, start: max - 11, step: 1, valueCount: 2 };
    const prefix = type === 'communities' ? `${base}:` : `rt:${base}:`;
    assert.equal(validateAttributeRule(rule, communityPathConfig), '');
    assert.deepEqual(previewTokens(rule, 5, communityPathConfig), [`${prefix}${max - 1}`, `${prefix}${max}`]);
    const overflowing = { ...rule, start: max - 10 };
    assert.notEqual(
        validateAttributeRule(overflowing, communityPathConfig),
        '',
        'validate the final value of the final ADD-PATH route'
    );
    assert.ok(validateRouteConfig({ ...communityPathConfig, attributeRules: [overflowing] })[`rule:${rule.id}`]);
    assert.notEqual(validateAttributeRule({ ...rule, valueCount: 3 }, communityPathConfig), '');
    const descending = { ...rule, start: 11, step: -1 };
    assert.equal(validateAttributeRule(descending, communityPathConfig), '');
    assert.deepEqual(previewTokens(descending, 5, communityPathConfig), [`${prefix}1`, `${prefix}0`]);
    assert.notEqual(
        validateAttributeRule({ ...descending, start: 10 }, communityPathConfig),
        '',
        'negative-step tails must remain in range'
    );
}

for (const rule of [extFixed, extIncrement, extRandom, extList]) {
    const actual = buildAttributeRuleContext({ count: 3, attributeRules: [rule] }, () => 0.15);
    for (let index = 0; index < 3; index++)
        assert.equal(
            previewAttributeRule(rule, index),
            getGeneratedAttributeValues(actual, index).attr.extendedCommunities.join(' ')
        );
}
for (const value of ['hex:1234', 'rt:192.0.2.1:65536', 'soo:70000:65536', '65000:100']) {
    assert.match(previewAttributeRule({ ...ext, value }), /范围|格式|8字节/);
}
const extColumns = getAttributeResultColumns({
    ...defaultGroup.config,
    nlriRules: [],
    attributeRules: [ext, createAttributeRule('extendedCommunities')]
});
assert.deepEqual(
    extColumns.map(column => column.title),
    ['Extended Community #1', 'Extended Community #2']
);
assert.equal(
    extColumns[0].customRender({ record: { pathAttributes: [{ type: 'extendedCommunities', value: [] }] } }),
    '—'
);
assert.equal(
    extColumns[0].customRender({ record: { pathAttributes: [{ type: 'rt', value: '65000:100' }] } }),
    'rt:65000:100'
);
assert.deepEqual(
    extColumns.map(column =>
        column.customRender({
            record: {
                pathAttributes: [
                    { type: 'extendedCommunities', value: ['rt:65000:1', 'soo:65000:2'] },
                    { type: 'extendedCommunities', value: ['hex:ffffffffffffffff'] }
                ]
            }
        })
    ),
    ['rt:65000:1 soo:65000:2', 'hex:ffffffffffffffff']
);
const renamed = normalizeAttributeRules([
    { id: 'old-rt-fixed', type: 'rt', enabled: true, mode: 'fixed', value: '65000:1 192.0.2.1:2' },
    { id: 'old-rt-list', type: 'rt', mode: 'list', values: ['65000:1 65000:2', '65000:3'] }
]);
assert.equal(renamed[0].id, 'old-rt-fixed');
assert.equal(renamed[0].enabled, undefined);
assert.equal(renamed[0].type, 'extendedCommunities');
assert.equal(renamed[0].value, 'rt:65000:1 rt:192.0.2.1:2');
assert.deepEqual(renamed[1].values, ['rt:65000:1 rt:65000:2', 'rt:65000:3']);
const withoutDormantNodes = normalizeAttributeRules([
    { ...createAttributeRule('addPath'), enabled: false },
    { ...createAttributeRule('med'), enabled: true }
]);
assert.deepEqual(
    withoutDormantNodes.map(rule => rule.type),
    ['med']
);
assert.ok(!Object.hasOwn(withoutDormantNodes[0], 'enabled'));
const deletedNlri = { ...labelGroup.config, nlriRules: [] };
assert.deepEqual(normalizeRouteRuleSections(deletedNlri, 1).nlriRules, []);
assert.deepEqual(normalizeRouteRuleSections({ ...deletedNlri, addressFamily: 1 }, 12).nlriRules, []);
assert.deepEqual(
    compileRouteRulePayload({
        ...defaultGroup.config,
        attributeRules: [{ ...createAttributeRule('med'), enabled: false }]
    }).attributeRules.map(rule => [rule.type, rule.enabled]),
    [['med', undefined]],
    'the generator payload contains present nodes without a toggle field'
);

const overlapGroups = [
    createIpv4RouteGroup('原组', { prefix: '10.20.0.99', mask: 24, count: 3 }),
    createIpv4RouteGroup('重叠组', { prefix: '10.20.2.1', mask: 24, count: 2 })
];
const overlap = findIpv4RouteGroupOverlap(overlapGroups, overlapGroups[0].id);
assert.equal(overlap.groupName, '重叠组');
assert.equal(overlap.prefix, '10.20.2.0');
assert.equal(overlap.mask, 24);
assert.equal(describeIpv4RouteRange(overlapGroups[0].config), '10.20.0.0/24 → 10.20.2.0/24');
overlapGroups[1].config.nlriRules = [{ ...pathRule, count: 100 }];
assert.deepEqual(
    findIpv4RouteGroupOverlap(overlapGroups, overlapGroups[0].id),
    overlap,
    'Path IDs never affect overlap'
);
overlapGroups[1].config.prefix = '10.20.3.1';
assert.equal(
    findIpv4RouteGroupOverlap(overlapGroups, overlapGroups[0].id),
    null,
    'adjacent prefix ranges are separate'
);
overlapGroups[1].config.prefix = '10.20.0.0';
overlapGroups[1].config.mask = 25;
assert.equal(
    findIpv4RouteGroupOverlap(overlapGroups, overlapGroups[0].id),
    null,
    'CIDR containment is not identical NLRI'
);
overlapGroups[1].config.mask = 24;
overlapGroups[1].config.addressFamily = 12;
assert.equal(findIpv4RouteGroupOverlap(overlapGroups, overlapGroups[0].id), null, 'different SAFI uses a separate key');
overlapGroups[1].config.addressFamily = 1;
overlapGroups[1].config.rd = '65000:1';
assert.equal(findIpv4RouteGroupOverlap(overlapGroups, overlapGroups[0].id), null, 'different RD uses a separate key');
overlapGroups[1].config.rd = '0:0';
assert.ok(findIpv4RouteGroupOverlap(overlapGroups, overlapGroups[0].id));
overlapGroups[1].config.rd = '00:000';
assert.ok(findIpv4RouteGroupOverlap(overlapGroups, overlapGroups[0].id), 'RD is compared in canonical form');
overlapGroups[1].config.prefix = '';
assert.equal(findIpv4RouteGroupOverlap(overlapGroups, overlapGroups[0].id), null, 'invalid drafts have no occupancy');
assert.equal(findIpv4RouteGroupOverlap(overlapGroups, 'absent'), null);
const largeRanges = [
    createIpv4RouteGroup('大范围', { prefix: '0.0.0.0', mask: 32, count: 4294967296 }),
    createIpv4RouteGroup('末尾', { prefix: '255.255.255.255', mask: 32, count: 1 })
];
assert.equal(findIpv4RouteGroupOverlap(largeRanges, largeRanges[0].id).prefix, '255.255.255.255');

for (const addressFamily of [1, 12]) {
    const sparse = createIpv4RouteGroup('子网步长', {
        addressFamily,
        prefix: '10.0.0.99',
        mask: 24,
        count: 3,
        ipStep: '2',
        nlriRules: [{ ...createAttributeRule('addPath'), count: 3 }]
    });
    assert.deepEqual(validateRouteConfig(sparse.config), {});
    assert.equal(compileRouteRulePayload(sparse.config, sparse).ipStep, '2');
    assert.equal(getGeneratedRouteCount(sparse.config), 9, 'IP step must not change Count × path count');
    assert.equal(getGeneratedPrefixCount(sparse.config), 3);
    assert.equal(describeIpv4RouteRange(sparse.config), '10.0.0.0/24 → 10.0.4.0/24 · 步长 2');
    const persisted = serializeIpv4RouteWorkspace([sparse], sparse.id);
    const reopened = restoreIpv4RouteWorkspace(persisted);
    assert.equal(reopened.activeGroupId, sparse.id);
    assert.equal(reopened.groups[0].config.ipStep, '2');
    assert.equal(compileRouteRulePayload(reopened.groups[0].config).ipStep, '2');
    const copied = createIpv4RouteGroup('步长副本', sparse.config);
    copied.config.ipStep = '7';
    assert.equal(sparse.config.ipStep, '2');
    for (const ipStep of [0, -1, '', 'invalid', 1.5, Number.MAX_SAFE_INTEGER + 1])
        assert.ok(validateRouteConfig({ ...sparse.config, ipStep }).ipStep, `invalid IPv4 step ${ipStep}`);

    const gap = createIpv4RouteGroup('间隙', {
        ...sparse.config,
        prefix: '10.0.1.1',
        count: 2,
        nlriRules: []
    });
    assert.equal(findIpv4RouteGroupOverlap([sparse, gap], sparse.id), null, 'overlapping hulls can have disjoint keys');
    const shared = createIpv4RouteGroup('实际重叠', {
        ...sparse.config,
        prefix: '10.0.1.1',
        count: 2,
        ipStep: 3,
        nlriRules: []
    });
    assert.equal(findIpv4RouteGroupOverlap([sparse, shared], sparse.id).prefix, '10.0.4.0');
    assert.equal(
        findIpv4RouteGroupOverlap([sparse, { ...shared, config: { ...shared.config, count: 1 } }], sparse.id),
        null,
        'an unbounded progression match outside Count must not collide'
    );
    assert.equal(
        findIpv4RouteGroupOverlap([sparse, { ...shared, config: { ...shared.config, mask: 25 } }], sparse.id),
        null,
        'a different mask remains a separate NLRI key'
    );
    assert.equal(
        findIpv4RouteGroupOverlap([sparse, { ...gap, config: { ...gap.config, ipStep: 0 } }], sparse.id),
        null,
        'an invalid step draft has no occupancy'
    );
    const edge = { ...sparse.config, prefix: '255.255.253.99', count: 2 };
    assert.deepEqual(validateRouteConfig(edge), {});
    assert.equal(describeIpv4RouteRange(edge), '255.255.253.0/24 → 255.255.255.0/24 · 步长 2');
    assert.ok(validateRouteConfig({ ...edge, count: 3 }).count, 'step-aware address overflow must be rejected');
    assert.match(describeIpv4RouteRange({ ...edge, count: 3 }), /超出 IPv4/);
    assert.equal(findIpv4RouteGroupOverlap([sparse, { ...shared, config: { ...edge, count: 3 } }], sparse.id), null);
}

// Compare sparse progression intersection with small explicit NLRI sets, including unaligned hosts and mask keys.
const ipv4Number = value => value.split('.').reduce((total, octet) => total * 256 + Number(octet), 0);
const ipv4String = value => [24, 16, 8, 0].map(shift => Math.floor(value / 2 ** shift) % 256).join('.');
let sparseSeed = 29;
const sparseRandom = max => {
    sparseSeed = (sparseSeed * 1664525 + 1013904223) >>> 0;
    return sparseSeed % max;
};
for (const addressFamily of [1, 12]) {
    for (let index = 0; index < 250; index++) {
        const groups = [0, 1].map(() => {
            const mask = [24, 30, 32][sparseRandom(3)];
            const subnet = 2 ** (32 - mask);
            return createIpv4RouteGroup('稀疏差分', {
                addressFamily,
                prefix: ipv4String(ipv4Number('10.40.0.0') + sparseRandom(50) * subnet + sparseRandom(subnet)),
                mask,
                count: sparseRandom(9) + 1,
                ipStep: sparseRandom(7) + 1,
                nlriRules: []
            });
        });
        const keys = group => {
            const subnet = 2 ** (32 - group.config.mask);
            const start = Math.floor(ipv4Number(group.config.prefix) / subnet) * subnet;
            return new Set(
                Array.from(
                    { length: group.config.count },
                    (_, i) => `${start + i * group.config.ipStep * subnet}/${group.config.mask}`
                )
            );
        };
        groups.forEach(group => assert.deepEqual(validateRouteConfig(group.config), {}));
        const left = keys(groups[0]);
        const right = keys(groups[1]);
        const expected = [...right].some(key => left.has(key));
        for (const active of groups) {
            const actual = findIpv4RouteGroupOverlap(groups, active.id);
            assert.equal(Boolean(actual), expected, `IPv4 AF ${addressFamily} sparse intersection ${index}`);
            if (actual) {
                const key = `${ipv4Number(actual.prefix)}/${actual.mask}`;
                assert.ok(left.has(key) && right.has(key), 'reported overlap must be an actual generated key');
            }
        }
    }
}
const largeSparse = createIpv4RouteGroup('大稀疏范围', {
    prefix: '0.0.0.0',
    mask: 32,
    count: 2147483648,
    ipStep: 2,
    nlriRules: []
});
const largeSparseGap = createIpv4RouteGroup('大范围间隙', {
    prefix: '255.255.255.255',
    mask: 32,
    count: 1,
    ipStep: 1
});
assert.equal(findIpv4RouteGroupOverlap([largeSparse, largeSparseGap], largeSparse.id), null);
largeSparseGap.config.prefix = '255.255.255.254';
assert.equal(findIpv4RouteGroupOverlap([largeSparse, largeSparseGap], largeSparse.id).prefix, '255.255.255.254');

console.log('IPv4 attribute model persistence and preview tests passed');
