const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BgpConst = require('../../electron/const/bgpConst');
const BgpRoute = require('../../electron/worker/bgp/bgpRoute');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');

const configuredAttr = {
    attributePolicy: 'configured',
    configuredAttributes: ['med'],
    med: 10,
    pathAttributes: [{ type: 'med', value: 10 }]
};
const qpFamilies = [
    { family: BgpConst.BGP_ADDR_FAMILY.IPV4_QP, instanceKey: 'families|1|241', ip: '192.0.2.9', mask: 24 },
    { family: BgpConst.BGP_ADDR_FAMILY.IPV6_QP, instanceKey: 'families|2|241', ip: '2001:0db8:0:0::9', mask: 64 }
];
const mvpnFamily = BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN;
const mvpnInstanceKey = 'families|1|5';

function qpEntry(profile, dqpn, options = {}) {
    return {
        route: {
            ip: profile.ip,
            mask: profile.mask,
            dqpn,
            mpNextHop: '2001:db8::1',
            nlriEncoding: 'auto',
            ...options
        },
        attr: configuredAttr
    };
}

function mvpnEntry(routeType, options = {}) {
    return {
        route: {
            routeType,
            rd: '065000:0001',
            sourceAs: '0065000',
            sourceIp: '198.051.100.010',
            groupIp: '239.001.001.001',
            originatingRouterIp: '192.000.002.010',
            mpNextHop: null,
            ...options
        },
        attr: configuredAttr
    };
}

function replace(store, groupId, routes, profile) {
    return store.replaceRouteGroup(groupId, {
        groupName: `Group ${groupId}`,
        addressFamily: profile.family,
        instanceKey: profile.instanceKey,
        routes
    });
}

const mvpnProfile = { family: mvpnFamily, instanceKey: mvpnInstanceKey };
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-family-groups-'));
const dbPath = path.join(directory, 'groups.sqlite3');
let store;
try {
    store = new BgpRouteSqliteStore({ dbPath }).open();
    for (const profile of qpFamilies) {
        const id = `qp-${profile.family}`;
        const initial = replace(store, id, [qpEntry(profile, null), qpEntry(profile, 0)], profile);
        assert.equal(initial.inserted, 2, 'an absent DQPN and an explicit DQPN zero are separate NLRIs');
        const rows = store.getRouteGroupRoutes(id);
        assert.deepEqual(
            rows.map(route => route.dqpn),
            [null, 0]
        );
        assert.equal(rows[0].ip, profile.family === BgpConst.BGP_ADDR_FAMILY.IPV4_QP ? '192.0.2.0' : '2001:db8::');
        assert.equal(rows[0].routeKey, `null|${rows[0].ip}|${profile.mask}`);
        assert.equal(rows[1].routeKey, `0|${rows[0].ip}|${profile.mask}`);
        assert.ok(
            rows.every(route => route.pathId === undefined),
            'QP does not acquire a fabricated unicast Path ID'
        );
        assert.equal(rows[0].attrId, rows[1].attrId);
        assert.throws(
            () => replace(store, `${id}-overlap`, [qpEntry(profile, 0, { pathId: 99 })], profile),
            new RegExp(`Group ${id}`),
            'Path ID does not permit a second group to own the same QP NLRI'
        );
        replace(store, `${id}-distinct`, [qpEntry(profile, 1)], profile);
        const before = store.getRouteGroupRoutes(id);
        assert.throws(
            () => replace(store, id, [qpEntry(profile, 2), qpEntry(profile, 0x1000000)], profile),
            /DQPN is invalid/
        );
        assert.deepEqual(store.getRouteGroupRoutes(id), before, 'late validation must retain the generated snapshot');
        assert.throws(
            () => replace(store, `${id}-duplicate`, [qpEntry(profile, 2), qpEntry(profile, 2)], profile),
            /duplicate route key/
        );
        const changedBsid = replace(store, id, [qpEntry(profile, null, { mpNextHop: '2001:db8::99' })], profile);
        assert.equal(changedBsid.updated, 1);
        assert.equal(changedBsid.deleted, 1);
        assert.equal(changedBsid.withdrawnRoutes.length, 2);
        assert.equal(changedBsid.withdrawnRoutes.find(route => route.dqpn === null).forceWithdraw, true);
        assert.equal(
            store.getRouteGroupRoutes(id)[0].attrId,
            before[0].attrId,
            'BSID does not enter the path attribute hash'
        );

        const managed = qpEntry(profile, null);
        managed.routeKey = `noncanonical-legacy-${id}`;
        assert.throws(() => store.upsertRoutes(profile.instanceKey, [managed]), new RegExp(`Group ${id}`));
        store.upsertRoutes(profile.instanceKey, [qpEntry(profile, 2)]);
        assert.throws(
            () => replace(store, `${id}-legacy`, [qpEntry(profile, 2)], profile),
            /existing legacy route/,
            'the same canonical QP NLRI cannot adopt a separately generated legacy route'
        );
    }

    for (const routeType of [1, 2, 3, 5, 6, 7]) {
        const id = `mvpn-${routeType}`;
        replace(store, id, [mvpnEntry(routeType)], mvpnProfile);
        const row = store.getRouteGroupRoutes(id)[0];
        assert.equal(row.routeType, routeType);
        assert.equal(row.rd, '65000:1');
        assert.equal(row.ip, undefined, 'MVPN rows must not invent a unicast prefix');
        assert.equal(row.mask, undefined);
        assert.equal(row.pathId, undefined);
        if ([2, 6, 7].includes(routeType)) assert.equal(row.sourceAs, 65000);
        else assert.equal(row.sourceAs, undefined);
        if ([3, 5, 6, 7].includes(routeType)) assert.equal(row.sourceIp, '198.51.100.10');
        else assert.equal(row.sourceIp, undefined);
        if ([3, 5, 6, 7].includes(routeType)) assert.equal(row.groupIp, '239.1.1.1');
        else assert.equal(row.groupIp, undefined);
        if ([1, 3].includes(routeType)) assert.equal(row.originatingRouterIp, '192.0.2.10');
        else assert.equal(row.originatingRouterIp, undefined);
        assert.throws(
            () => replace(store, `${id}-overlap`, [mvpnEntry(routeType, { rd: '65000:1', pathId: 9 })], mvpnProfile),
            new RegExp(`Group ${id}`)
        );
        replace(store, `${id}-other-rd`, [mvpnEntry(routeType, { rd: '65000:2' })], mvpnProfile);
    }
    replace(store, 'mvpn-6-other-source', [mvpnEntry(6, { sourceIp: '198.51.100.11' })], mvpnProfile);
    assert.equal(store.getRouteGroupRoutes('mvpn-6-other-source')[0].sourceIp, '198.51.100.11');
    const mvpnBefore = store.getRouteGroupRoutes('mvpn-5');
    const invalidCandidates = function* () {
        yield mvpnEntry(5, { groupIp: '239.1.2.1' });
        yield mvpnEntry(5, { sourceIp: 'not-an-ip' });
    };
    assert.throws(() => replace(store, 'mvpn-5', invalidCandidates(), mvpnProfile), /source IP is invalid/);
    assert.deepEqual(store.getRouteGroupRoutes('mvpn-5'), mvpnBefore);
    const legacyMvpn = mvpnEntry(5, { rd: '65000:1', sourceIp: '198.51.100.10', groupIp: '239.1.1.1' });
    legacyMvpn.routeKey = 'legacy-unrelated-key';
    assert.throws(() => store.upsertRoutes(mvpnInstanceKey, [legacyMvpn]), /Group mvpn-5/);
    store.upsertRoutes(mvpnInstanceKey, [mvpnEntry(5, { rd: '65000:99' })]);
    assert.throws(
        () => replace(store, 'mvpn-legacy-overlap', [mvpnEntry(5, { rd: '065000:0099' })], mvpnProfile),
        /existing legacy route/
    );

    const leafRouteKey = '05 12 0000fde80000000120c633640a20ef010101';
    replace(store, 'mvpn-leaf', [mvpnEntry(4, { leafRouteKey, originatingRouterIp: '192.0.2.10' })], mvpnProfile);
    const leaf = store.getRouteGroupRoutes('mvpn-leaf')[0];
    assert.equal(leaf.leafRouteKey, leafRouteKey.replace(/\s/g, ''));
    assert.equal(leaf.routeKey, `4|leaf:${leaf.leafRouteKey}|192.0.2.10`);
    assert.equal(leaf.rd, undefined, 'Leaf NLRI has no independent RD');
    assert.throws(
        () => replace(store, 'mvpn-leaf-overlap', [mvpnEntry(4, { leafRouteKey, rd: '65000:100' })], mvpnProfile),
        /Group mvpn-leaf/,
        'an unrelated draft RD must not split the same Leaf NLRI identity'
    );
    replace(
        store,
        'mvpn-leaf-other-origin',
        [mvpnEntry(4, { leafRouteKey, originatingRouterIp: '192.0.2.11' })],
        mvpnProfile
    );
    assert.throws(
        () => replace(store, 'mvpn-bad-leaf', [mvpnEntry(4, { leafRouteKey: '05zz' })], mvpnProfile),
        /hexadecimal|Leaf route key/
    );
    assert.equal(BgpRoute.parseMvpnLeafRouteKey(leaf.routeKey), leaf.leafRouteKey);

    const beforeReopen = store.listRouteGroups();
    const attributeCount = store.getStatus().attributes;
    assert.equal(attributeCount, 1, 'different NLRI next hops and fields share identical configured path attributes');
    store.close();
    store = new BgpRouteSqliteStore({ dbPath }).open();
    assert.deepEqual(store.listRouteGroups(), beforeReopen);
    assert.equal(store.getRouteGroupRoutes('qp-8')[0].dqpn, null);
    assert.equal(store.getRouteGroupRoutes('qp-8')[0].mpNextHop, '2001:db8::99');
    assert.equal(store.getRouteGroupRoutes('mvpn-leaf')[0].leafRouteKey, leaf.leafRouteKey);
    assert.equal(store.getRouteGroupRoutes('mvpn-6')[0].sourceIp, '198.51.100.10');
    assert.equal(store.getStatus().attributes, attributeCount);
    const withdrawal = store.withdrawRouteGroup('mvpn-leaf');
    assert.equal(withdrawal.deleted, 1);
    assert.equal(withdrawal.routes[0].leafRouteKey, leaf.leafRouteKey);
    assert.equal(withdrawal.routes[0].instanceKey, mvpnInstanceKey);
    assert.equal(store.getRouteGroupRoutes('mvpn-leaf').length, 0);
    assert.equal(store.withdrawRouteGroup('qp-8').routes[0].dqpn, null);
} finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
}
console.log('BGP family route group SQLite store tests passed');
