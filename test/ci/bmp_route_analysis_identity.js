'use strict';

const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const { canonicalizeRouteIdentity, formatRouteLookupKey } = require('../../electron/utils/bmp/bmpPersistentRouteKey');
const {
    buildBmpRouteLensFromPersistedRoutes,
    getQpRouteIdentity,
    getComplexRouteIdentity
} = require('../../electron/utils/bmp/bmpRouteLens');
const {
    buildBmpRouteAssuranceAnalysisFromPersistedRoutesAsync,
    buildBmpRouteAssuranceAnalysisFromRowStreamAsync,
    makeStreamRunKey,
    refreshBmpRouteAssuranceStreamRun
} = require('../../electron/utils/bmp/bmpRouteAssurance');
const Service = require('../../electron/utils/bmp/bmpRouteAssuranceService');

const PRE = BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN;
const POST = BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;
function persisted(route, ribType = PRE, peer = '198.51.100.1') {
    const routeKey = formatRouteLookupKey(canonicalizeRouteIdentity({ route }), { rd: route.rd });
    return {
        ...route,
        routeKey,
        persistentSourceId: 'a'.repeat(64),
        persistentScopeId: `${peer}-${ribType}`,
        scopeKind: 'peer',
        ownerKey: peer,
        ribType,
        routeState: 'active',
        peer: { type: 0, rd: '0:0', ip: peer, as: 65001 },
        source: { sysName: 'analysis-identity', remoteIp: '192.0.2.10' },
        origin: 'IGP',
        asPath: '65001',
        nextHop: '192.0.2.1'
    };
}
function qp(dqpn, dqpnBits, length = 24) {
    return persisted({
        afi: 1,
        safi: 241,
        ip: '192.0.2.0',
        mask: length,
        rd: '0:0',
        pathId: 0,
        nlriDetail: { prefix: '192.0.2.0', length, dqpn, dqpnBits }
    });
}
function evpn(tag, gateway, ribType = PRE, pathId = 0) {
    const prefix = `evpn:ip-prefix:65000:1:tag=${tag}:198.51.100.0/24:gw=${gateway}`;
    return persisted(
        {
            afi: 25,
            safi: 70,
            ip: prefix,
            mask: 24,
            rd: '65000:1',
            pathId,
            labels: gateway.endsWith('.1') ? 'MPLS 100' : 'MPLS 200',
            nlriDetail: {
                routeType: 5,
                prefix,
                length: 24,
                rd: '65000:1',
                rdRaw: 'raw:0000fde800000001',
                ethernetTagId: tag,
                ipPrefix: '198.51.100.0',
                prefixLength: 24,
                gatewayIp: gateway,
                labels: [{ label: gateway.endsWith('.1') ? 100 : 200 }]
            }
        },
        ribType
    );
}
async function* chunks(rows) {
    for (const row of rows) yield [row];
}

async function main() {
    const qps = [qp(1, 8), qp(1, 16), qp(0, 0), qp(null, null), qp(1, 8, 25)];
    const identities = qps.map(getQpRouteIdentity);
    assert.equal(new Set(identities).size, 5, 'DQPN bits, prefix length and absence/zero are different identities');
    assert.equal(identities[2], 'qp:1:192.0.2.0/24;dqpn=0/0');
    assert.equal(identities[3], 'qp:1:192.0.2.0/24;dqpn=absent');
    assert.notEqual(
        getQpRouteIdentity({ ...qps[2], nlriDetail: { ...qps[2].nlriDetail, dqpnBits: undefined } }),
        identities[2]
    );
    const hostBits = { ...qps[0], ip: '192.0.2.7', nlriDetail: { ...qps[0].nlriDetail, prefix: '192.0.2.7' } };
    assert.equal(getQpRouteIdentity(hostBits), identities[0]);

    const lens = buildBmpRouteLensFromPersistedRoutes(qps, { query: '192.0.2.1' });
    assert.equal(lens.summary.total, 5);
    assert.equal(new Set(lens.stages.preIn.map(entry => entry.id)).size, 5);
    for (const identity of identities) {
        const exact = buildBmpRouteLensFromPersistedRoutes(qps, { query: identity });
        assert.equal(exact.summary.total, 1, `QP text selection isolates ${identity}`);
        assert.equal(exact.stages.preIn[0].match.routeIdentity, identity);
    }
    const mismatched = buildBmpRouteLensFromPersistedRoutes([qps[0], { ...qps[1], ribType: POST }], {
        query: '192.0.2.1'
    });
    assert.deepEqual(mismatched.policyDiffs.inbound.map(diff => diff.status).sort(), ['missing-after', 'post-only']);
    const qpArray = await buildBmpRouteAssuranceAnalysisFromPersistedRoutesAsync(qps);
    const qpStream = await buildBmpRouteAssuranceAnalysisFromRowStreamAsync(chunks(qps));
    assert.equal(qpArray.summary.uniqueNlriCount, 5);
    assert.equal(qpStream.summary.uniqueNlriCount, 5);
    assert.deepEqual(qpStream.summary.categoryCounts, qpArray.summary.categoryCounts);
    const absentOnly = [qp(null, null), { ...qp(null, null), ribType: POST }];
    assert.equal(
        (await buildBmpRouteAssuranceAnalysisFromRowStreamAsync(chunks(absentOnly))).summary.uniqueNlriCount,
        1
    );

    const before = evpn(100, '192.0.2.1');
    const after = evpn(100, '192.0.2.2', POST);
    const anotherTag = evpn(101, '192.0.2.3', POST);
    assert.equal(before.routeKey, after.routeKey, 'mutable gateway/labels do not enter the public route key');
    assert.equal(getComplexRouteIdentity(before), getComplexRouteIdentity(after));
    assert.equal(getComplexRouteIdentity(before), getComplexRouteIdentity(evpn(100, '192.0.2.4', PRE, 99)));
    assert.notEqual(getComplexRouteIdentity(before), getComplexRouteIdentity(anotherTag));
    assert.equal(getComplexRouteIdentity({ ...before, afi: 1 }), null, 'mismatched AF headers are rejected');
    assert.equal(getComplexRouteIdentity({ ...before, routeKey: '0|65000:1|old-synthetic-display|24' }), null);
    assert.equal(makeStreamRunKey(before), makeStreamRunKey(after));
    const evpnRows = [before, after, anotherTag];
    const evpnArray = await buildBmpRouteAssuranceAnalysisFromPersistedRoutesAsync(evpnRows);
    const evpnStream = await buildBmpRouteAssuranceAnalysisFromRowStreamAsync(chunks(evpnRows));
    assert.equal(evpnArray.summary.uniqueNlriCount, 2);
    assert.equal(evpnStream.summary.uniqueNlriCount, 2);
    assert.deepEqual(evpnStream.summary.categoryCounts, evpnArray.summary.categoryCounts);
    const evpnLens = buildBmpRouteLensFromPersistedRoutes(evpnRows, { query: '198.51.100.1' });
    assert.equal(evpnLens.policyDiffs.inbound.length, 2);
    assert.equal(evpnLens.policyDiffs.inbound.find(diff => diff.before && diff.after).status, 'modified');
    assert.equal(evpnLens.policyDiffs.inbound.filter(diff => diff.status === 'post-only').length, 1);

    const lookup = getComplexRouteIdentity(before);
    const locator = { sourceId: before.persistentSourceId, afi: 25, safi: 70, routeLookupIdentity: lookup };
    assert.equal(makeStreamRunKey(locator), makeStreamRunKey(before));
    assert.equal(refreshBmpRouteAssuranceStreamRun(evpnStream, locator, [after]), true);
    assert.equal(evpnStream.summary.uniqueNlriCount, 2, 'refresh replaces the whole stable NLRI run, not one gateway');
    const service = new Service({ enabled: true, groupRefreshDelayMs: 100000 });
    try {
        service.groupRefreshLoader = async () => [];
        assert.equal(service.queueGroupRefresh({ current: before }), true);
        assert.equal(service.queueGroupRefresh({ current: after }), true);
        assert.equal(service.pendingGroupRefreshes.size, 1, 'gateway changes coalesce into one stable group refresh');
        const pending = service.pendingGroupRefreshes.values().next().value;
        assert.equal(pending.routeLookupIdentity, lookup);
        assert.equal(pending.row.routeLookupIdentity, lookup);
        assert.equal(makeStreamRunKey(pending.row), makeStreamRunKey(before));
    } finally {
        service.invalidate('test-complete');
    }
    console.log('BMP QP/complex Route Assurance and Lens complete NLRI identity regressions passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
