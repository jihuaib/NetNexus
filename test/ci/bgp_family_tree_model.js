const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const ipaddr = require('ipaddr.js');
const sourcePath = path.resolve(__dirname, '../../src/view/bgp/bgpRouteWorkspace.js');
const bundled = esbuild.buildSync({
    entryPoints: [sourcePath],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false
});
const loaded = new Module(sourcePath, module);
loaded._compile(bundled.outputFiles[0].text, sourcePath);
const {
    getRouteProfile,
    createRouteGroup,
    restoreRouteWorkspace,
    serializeRouteWorkspace,
    compileRouteTreePayload,
    validateRouteConfig,
    findRouteGroupOverlap,
    describeRouteRange,
    getRouteResultColumns,
    getRouteSections
} = loaded.exports;
const { buildAttributeRuleContext, getGeneratedAttributeValues } = require('../../electron/utils/bgpAttributeRules');

for (const name of ['ipv6', 'ipv4-qp', 'ipv6-qp', 'mvpn']) {
    const profile = getRouteProfile(name);
    const group = createRouteGroup(profile);
    assert.deepEqual(validateRouteConfig(group.config), {}, `${name} defaults must be generatable`);
    const payload = compileRouteTreePayload(group.config, group);
    assert.equal(payload.groupId, group.id);
    assert.equal(payload.addressFamily, profile.addressFamily);
    assert.ok([...payload.attributeRules, ...payload.nlriRules].every(rule => !Object.hasOwn(rule, 'enabled')));
    const compiled = buildAttributeRuleContext(payload);
    assert.equal(compiled.enabled, true);
    const attributes = getGeneratedAttributeValues(compiled, 0);
    assert.ok(!attributes.attr.pathAttributes.some(entry => entry.type === 'nextHop'));
    assert.equal(attributes.mpNextHop, '');
    assert.ok(getRouteResultColumns(group.config).length >= 2);
    const empty = createRouteGroup(name, 'empty', { ...group.config, nlriRules: [], attributeRules: [] });
    const saved = serializeRouteWorkspace(profile, [empty], empty.id);
    const restored = restoreRouteWorkspace(profile, saved);
    assert.equal(restored.activeGroupId, empty.id);
    assert.deepEqual(restored.groups[0].config.nlriRules, []);
    assert.deepEqual(restored.groups[0].config.attributeRules, []);
    assert.notEqual(createRouteGroup(profile).id, empty.id);
    assert.deepEqual(
        getGeneratedAttributeValues(buildAttributeRuleContext(compileRouteTreePayload(empty.config)), 0).attr
            .pathAttributes,
        []
    );
}
const ipv6 = createRouteGroup('ipv6', 'large', { prefix: '2001:db8::1', mask: 64, count: 100000000 });
const v6tail = createRouteGroup('ipv6', 'tail', { prefix: '2001:db8:0:1::abcd', mask: 64, count: 1 });
assert.ok(findRouteGroupOverlap([ipv6, v6tail], v6tail.id));
assert.equal(findRouteGroupOverlap([ipv6, { ...v6tail, config: { ...v6tail.config, mask: 65 } }], v6tail.id), null);
assert.match(describeRouteRange(ipv6.config), /2001:db8::\/64/);
assert.ok(validateRouteConfig({ ...ipv6.config, prefix: 'ffff:ffff:ffff:ffff::', count: 2 }).count);

const ipv6Default = createRouteGroup('ipv6');
assert.equal(ipv6Default.config.ipStep, '1');
assert.equal(compileRouteTreePayload(ipv6Default.config).ipStep, '1');
assert.ok(
    getRouteSections(ipv6Default.config, 'ipv6')
        .flatMap(section => section.fields)
        .some(field => field.key === 'ipStep')
);
const sparseIpv6 = createRouteGroup('ipv6', '子网步长', {
    prefix: '2001:db8::abcd',
    mask: 64,
    count: 3,
    ipStep: '2',
    nlriRules: [{ id: 'paths', type: 'addPath', mode: 'fixed', count: 2 }]
});
assert.deepEqual(validateRouteConfig(sparseIpv6.config), {});
const sparseIpv6Payload = compileRouteTreePayload(sparseIpv6.config, sparseIpv6);
assert.equal(sparseIpv6Payload.ipStep, '2');
const sparsePathContext = buildAttributeRuleContext(sparseIpv6Payload);
assert.equal(sparseIpv6Payload.count, 3);
assert.equal(sparsePathContext.pathCount, 2, 'IPv6 step preserves per-prefix path count');
assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map(index => getGeneratedAttributeValues(sparsePathContext, index).pathId),
    [0, 1, 0, 1, 0, 1]
);
assert.match(describeRouteRange(sparseIpv6.config), /2001:db8::\/64 → 2001:db8:0:4::\/64/);
const sparseIpv6Restored = restoreRouteWorkspace('ipv6', serializeRouteWorkspace('ipv6', [sparseIpv6], sparseIpv6.id));
assert.equal(sparseIpv6Restored.activeGroupId, sparseIpv6.id);
assert.equal(sparseIpv6Restored.groups[0].config.ipStep, '2');
assert.equal(compileRouteTreePayload(sparseIpv6Restored.groups[0].config).ipStep, '2');
for (const ipStep of [0, -1, '', 'invalid', 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.ok(validateRouteConfig({ ...sparseIpv6.config, ipStep }).ipStep, `invalid IPv6 step ${ipStep}`);
const ipv6Gap = createRouteGroup('ipv6', '间隙', {
    ...sparseIpv6.config,
    prefix: '2001:db8:0:1::1234',
    count: 2,
    nlriRules: []
});
assert.equal(findRouteGroupOverlap([sparseIpv6, ipv6Gap], sparseIpv6.id), null, 'IPv6 sparse gaps must not collide');
const ipv6Shared = createRouteGroup('ipv6', '实际重叠', { ...ipv6Gap.config, ipStep: 3 });
assert.ok(findRouteGroupOverlap([sparseIpv6, ipv6Shared], sparseIpv6.id));
assert.equal(
    findRouteGroupOverlap([sparseIpv6, { ...ipv6Shared, config: { ...ipv6Shared.config, count: 1 } }], sparseIpv6.id),
    null
);
assert.equal(
    findRouteGroupOverlap([sparseIpv6, { ...ipv6Shared, config: { ...ipv6Shared.config, mask: 65 } }], sparseIpv6.id),
    null
);
const ipv6Edge = { ...sparseIpv6.config, prefix: 'ffff:ffff:ffff:fffd::1234', count: 2 };
assert.deepEqual(validateRouteConfig(ipv6Edge), {});
assert.ok(validateRouteConfig({ ...ipv6Edge, count: 3 }).count, 'IPv6 subnet step overflow must be rejected');
assert.deepEqual(
    validateRouteConfig({ ...ipv6Edge, prefix: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffb', mask: 128, count: 3 }),
    {}
);
assert.ok(
    validateRouteConfig({ ...ipv6Edge, prefix: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffb', mask: 128, count: 4 }).count
);

const ipv6Number = value =>
    ipaddr
        .parse(value)
        .toByteArray()
        .reduce((total, byte) => total * 256n + BigInt(byte), 0n);
const ipv6String = value =>
    ipaddr
        .fromByteArray(Array.from({ length: 16 }, (_, i) => Number((value >> BigInt(120 - 8 * i)) & 255n)))
        .toString();
let sparseSeed = 41;
const sparseRandom = max => {
    sparseSeed = (sparseSeed * 1664525 + 1013904223) >>> 0;
    return sparseSeed % max;
};
for (let index = 0; index < 250; index++) {
    const groups = [0, 1].map(() => {
        const mask = [124, 126, 128][sparseRandom(3)];
        const subnet = 1n << BigInt(128 - mask);
        return createRouteGroup('ipv6', '稀疏差分', {
            prefix: ipv6String(
                ipv6Number('2001:db8::') + BigInt(sparseRandom(50)) * subnet + BigInt(sparseRandom(Number(subnet)))
            ),
            mask,
            count: sparseRandom(9) + 1,
            ipStep: sparseRandom(7) + 1,
            nlriRules: []
        });
    });
    const keys = group => {
        const subnet = 1n << BigInt(128 - group.config.mask);
        const start = (ipv6Number(group.config.prefix) / subnet) * subnet;
        return new Set(
            Array.from(
                { length: group.config.count },
                (_, i) => `${start + BigInt(i * group.config.ipStep) * subnet}/${group.config.mask}`
            )
        );
    };
    groups.forEach(group => assert.deepEqual(validateRouteConfig(group.config), {}));
    const left = keys(groups[0]);
    const right = keys(groups[1]);
    const expected = [...right].some(key => left.has(key));
    for (const active of groups) {
        const actual = findRouteGroupOverlap(groups, active.id);
        assert.equal(Boolean(actual), expected, `IPv6 sparse intersection ${index}`);
        if (actual) {
            const key = `${ipv6Number(actual.nlri.split('/')[0])}/${actual.mask}`;
            assert.ok(left.has(key) && right.has(key), 'reported IPv6 overlap must be an actual generated key');
        }
    }
}
const hugeIpv6 = createRouteGroup('ipv6', '大稀疏范围', {
    prefix: '2001:db8::',
    mask: 128,
    count: Number.MAX_SAFE_INTEGER,
    ipStep: 3,
    nlriRules: [],
    attributeRules: []
});
const hugeIpv6End = createRouteGroup('ipv6', '末尾', {
    prefix: ipv6String(ipv6Number(hugeIpv6.config.prefix) + 3n * BigInt(Number.MAX_SAFE_INTEGER - 1)),
    mask: 128,
    count: 1,
    ipStep: 1,
    nlriRules: [],
    attributeRules: []
});
assert.deepEqual(validateRouteConfig(hugeIpv6.config), {});
assert.ok(findRouteGroupOverlap([hugeIpv6, hugeIpv6End], hugeIpv6.id));
hugeIpv6End.config.prefix = '2001:db8::1';
assert.equal(findRouteGroupOverlap([hugeIpv6, hugeIpv6End], hugeIpv6.id), null, 'large IPv6 hull gaps remain disjoint');

function qp(name, ip, ipStep, dqpn, dqpnStep, count) {
    return createRouteGroup(name, 'qp', {
        prefix: `10.0.0.${ip}`,
        mask: 32,
        ipStep,
        count,
        nlriRules: [{ id: 'dqpn', type: 'dqpn', mode: 'increment', start: dqpn, step: dqpnStep }]
    });
}
const a = qp('ipv4-qp', 1, 2, 1, 3, 8);
const b = qp('ipv4-qp', 5, 4, 7, 6, 3);
assert.ok(findRouteGroupOverlap([a, b], a.id));
const different = qp('ipv4-qp', 5, 4, 8, 6, 3);
assert.equal(
    findRouteGroupOverlap([a, different], a.id),
    null,
    'equal prefixes with different DQPN are distinct NLRIs'
);
const noDqpn = createRouteGroup('ipv4-qp', 'absent', { ...a.config, nlriRules: [] });
const zeroDqpn = createRouteGroup('ipv4-qp', 'zero', {
    ...a.config,
    nlriRules: [{ id: 'zero', type: 'dqpn', mode: 'fixed', value: 0 }]
});
assert.equal(findRouteGroupOverlap([noDqpn, zeroDqpn], noDqpn.id), null);
assert.equal(
    findRouteGroupOverlap(
        [a, { ...b, config: { ...b.config, addressFamily: 9, prefix: '2001:db8::5', mask: 128 } }],
        a.id
    ),
    null
);
assert.ok(
    validateRouteConfig({
        ...a.config,
        ipStep: 0,
        nlriRules: [{ id: 'fixed', type: 'dqpn', mode: 'fixed', value: 1 }]
    }).count
);
assert.ok(validateRouteConfig({ ...a.config, ipStep: 0, nlriRules: [] }).count);
assert.ok(
    validateRouteConfig({
        ...a.config,
        ipStep: 0,
        nlriRules: [{ id: 'cycle', type: 'dqpn', mode: 'list', values: ['1', '2'] }]
    }).count
);
assert.ok(
    validateRouteConfig({
        ...a.config,
        nlriRules: [{ id: 'overflow', type: 'dqpn', mode: 'increment', start: 0xffffff, step: 1 }]
    })['rule:overflow']
);
const list = createRouteGroup('ipv4-qp', 'list', {
    ...a.config,
    nlriRules: [{ id: 'list', type: 'dqpn', mode: 'list', values: ['7', '2'] }]
});
assert.ok(findRouteGroupOverlap([list, b], list.id));

for (const profile of ['ipv4-qp', 'ipv6-qp']) {
    const fixedIp = createRouteGroup(profile, 'fixed-ip', {
        count: 3,
        ipStep: 0,
        routeGrowthMode: 'ip',
        nlriRules: [{ id: 'dqpn', type: 'dqpn', mode: 'increment', start: 100, step: 3 }]
    });
    assert.deepEqual(validateRouteConfig(fixedIp.config), {});
    assert.equal(Object.hasOwn(fixedIp.config, 'routeGrowthMode'), false);
    const payload = compileRouteTreePayload(fixedIp.config);
    assert.equal(payload.ipStep, 0, 'numeric zero must remain a fixed IP');
    assert.equal(Object.hasOwn(payload, 'routeGrowthMode'), false);
    const context = buildAttributeRuleContext(payload);
    assert.deepEqual(
        [0, 1, 2].map(index => getGeneratedAttributeValues(context, index).dqpn),
        [100, 103, 106]
    );
    const restored = restoreRouteWorkspace(profile, serializeRouteWorkspace(profile, [fixedIp], fixedIp.id));
    assert.equal(restored.groups[0].config.ipStep, 0);
    assert.deepEqual(restored.groups[0].config.nlriRules, fixedIp.config.nlriRules);
    const overlap = createRouteGroup(profile, 'same-key', {
        ...fixedIp.config,
        count: 1,
        nlriRules: [{ id: 'fixed', type: 'dqpn', mode: 'fixed', value: 103 }]
    });
    assert.ok(findRouteGroupOverlap([fixedIp, overlap], fixedIp.id), 'fixed IP still checks DQPN keys');
    const fixedDqpn = createRouteGroup(profile, 'fixed-dqpn', {
        count: 3,
        ipStep: 2,
        nlriRules: [{ id: 'fixed', type: 'dqpn', mode: 'fixed', value: 42 }]
    });
    assert.deepEqual(validateRouteConfig(fixedDqpn.config), {});
    const fixedContext = buildAttributeRuleContext(compileRouteTreePayload(fixedDqpn.config));
    assert.deepEqual(
        [0, 1, 2].map(index => getGeneratedAttributeValues(fixedContext, index).dqpn),
        [42, 42, 42]
    );
    assert.ok(validateRouteConfig({ ...fixedDqpn.config, ipStep: -1 }).ipStep);
    assert.ok(validateRouteConfig({ ...fixedDqpn.config, ipStep: 0 }).count);
}

// Compare the bounded two-dimensional intersection with actual small NLRI sets.
let seed = 17;
const random = max => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % max;
};
for (let index = 0; index < 250; index++) {
    const groups = [0, 1].map(() =>
        qp('ipv4-qp', random(20) + 1, random(4) + 1, random(20), random(5) - 2, random(8) + 1)
    );
    const keys = group =>
        new Set(
            Array.from({ length: group.config.count }, (_, i) => {
                const rule = group.config.nlriRules[0];
                return `${Number(group.config.prefix.split('.').pop()) + group.config.ipStep * i}|${rule.start + rule.step * i}`;
            })
        );
    const left = keys(groups[0]);
    const expected = [...keys(groups[1])].some(key => left.has(key));
    const valid = groups.every(group => !Object.keys(validateRouteConfig(group.config)).length);
    if (valid) assert.equal(Boolean(findRouteGroupOverlap(groups, groups[0].id)), expected, `QP intersection ${index}`);
}

for (let routeType = 1; routeType <= 7; routeType++) {
    const first = createRouteGroup('mvpn', 'first', { routeType, count: 3 });
    const second = createRouteGroup('mvpn', 'second', { ...first.config, count: 1 });
    assert.deepEqual(validateRouteConfig(first.config), {});
    const payload = compileRouteTreePayload(first.config, first);
    assert.equal(Object.hasOwn(payload, 'prefix'), false);
    assert.equal(Object.hasOwn(payload, 'mask'), false);
    assert.ok(findRouteGroupOverlap([first, second], first.id), `MVPN Type ${routeType} shared key`);
    if (routeType === 4) {
        assert.equal(Object.hasOwn(payload, 'rd'), false);
        second.config.rd = '200:7';
        second.config.leafRouteKey = ` ${second.config.leafRouteKey.toUpperCase()} `;
        assert.ok(
            findRouteGroupOverlap([first, second], first.id),
            'Leaf key uses raw referenced NLRI, not an unused RD'
        );
        second.config.leafRouteKey = '020c000000c8000000010000ffff';
        assert.equal(findRouteGroupOverlap([first, second], first.id), null);
    } else {
        second.config.rd = '200:1';
        assert.equal(findRouteGroupOverlap([first, second], first.id), null);
    }
}
const mvpn5 = createRouteGroup('mvpn', 'five', { routeType: 5 });
const mvpn5Unused = createRouteGroup('mvpn', 'unused', {
    ...mvpn5.config,
    originatingRouterIp: '192.0.2.99',
    sourceAs: '8'
});
assert.ok(findRouteGroupOverlap([mvpn5, mvpn5Unused], mvpn5.id), 'non-wire fields must not evade overlap');
const mvpn6 = createRouteGroup('mvpn', 'six', { routeType: 6 });
const mvpn6Other = createRouteGroup('mvpn', 'other-rp', { ...mvpn6.config, sourceIp: '192.0.2.1' });
assert.equal(findRouteGroupOverlap([mvpn6, mvpn6Other], mvpn6.id), null);
assert.ok(validateRouteConfig({ ...mvpn6.config, rd: '70000:70000' }).rd);
assert.ok(validateRouteConfig({ ...mvpn6.config, groupIp: '255.255.255.255', count: 2 }).count);
assert.ok(validateRouteConfig({ ...mvpn6.config, routeType: 2, sourceAs: 0xffffffff, count: 2 }).count);
console.log('Other-family tree defaults, presence, payloads, saved workspaces and exact NLRI overlap tests passed');
