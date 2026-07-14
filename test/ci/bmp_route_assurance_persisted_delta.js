// Covers the SQLite committed-delta path that replaced ObservedRouteMap.
const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const BmpRouteAssuranceService = require('../../electron/utils/bmpRouteAssuranceService');

const service = new BmpRouteAssuranceService();
const sourceId = 'persisted-source-observed-map';
const ownerKey = '0|0:0|198.51.100.1|65001';
const routeKey = '1|0:0|203.0.113.0|24';
const routeId = 'persisted-route-203.0.113.0-24';
const source = {
    id: sourceId,
    sysName: 'persisted-router',
    remoteIp: '127.0.0.2'
};
const peer = {
    type: BmpConst.BMP_PEER_TYPE.GLOBAL,
    rd: '0:0',
    ip: '198.51.100.1',
    as: 65001,
    vrf: 'persisted-lab'
};

function makeRoute(overrides = {}) {
    return {
        routeKey,
        afi: 1,
        safi: 1,
        rd: '0:0',
        ip: '203.0.113.0',
        mask: 24,
        pathId: 1,
        routeState: BmpConst.BMP_ROUTE_STATE.ACTIVE,
        pathStatus: null,
        origin: 'IGP',
        asPath: '65001',
        nextHop: '192.0.2.254',
        localPref: 100,
        med: 0,
        communities: [],
        ...overrides
    };
}

function makePersistedRow(ribType, scopeId, overrides = {}) {
    return {
        ...makeRoute(overrides),
        persistentSourceId: sourceId,
        persistentScopeId: scopeId,
        persistentRouteId: routeId,
        ownerKey,
        scopeKind: 'peer',
        ribType,
        source,
        peer
    };
}

function makeCommittedDelta(action, ribType, scopeId, route, previous = null) {
    return {
        action,
        committed: true,
        projectionChanged: true,
        sourceId,
        scopeId,
        routeId,
        ownerKey,
        source,
        scope: {
            id: scopeId,
            ownerKey,
            kind: 'peer',
            afi: 1,
            safi: 1,
            ribType
        },
        routeKey,
        previous,
        current: action === 'delete' ? null : route
    };
}

async function verifyPersistedCommittedDeltaFlow() {
    const preIn = makePersistedRow(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, 'scope-pre-in');
    let pageReadCount = 0;
    await service.bootstrapFromPersistedRoutes(async cursor => {
        pageReadCount += 1;
        if (cursor === null) {
            return { list: [preIn], nextCursor: 'end' };
        }
        assert.equal(cursor, 'end');
        return { list: [], nextCursor: null };
    });

    assert.equal(pageReadCount, 2, 'bootstrap must stream persisted pages through the loader');
    assert.equal(service.getStatus().dataMode, 'persisted');

    let result = service.queryPersisted({ page: 1, pageSize: 25 });
    assert.equal(result.summary.categoryCounts['inbound-gap'], 1);
    assert.equal(result.summary.cacheHit, true);

    const postScopeId = 'scope-post-in';
    const postIn = makePersistedRow(BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, postScopeId);
    assert.equal(
        service.applyCommittedDelta(
            makeCommittedDelta('upsert', BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, postScopeId, postIn)
        ),
        true
    );
    result = service.queryPersisted({ page: 1, pageSize: 25 });
    assert.equal(result.summary.categoryCounts['inbound-gap'], 0);
    assert.equal(result.summary.categoryCounts['not-selected'], 1);

    const reportedPostIn = makePersistedRow(BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, postScopeId, {
        pathStatus: BmpConst.BMP_PATH_STATUS.NONSELECTED
    });
    assert.equal(
        service.applyCommittedDelta(
            makeCommittedDelta('upsert', BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, postScopeId, reportedPostIn, postIn)
        ),
        true
    );
    result = service.queryPersisted({ page: 1, pageSize: 25 });
    assert.equal(result.issues[0].category, 'not-selected');
    assert.equal(result.issues[0].evidenceType, 'reported');

    assert.equal(
        service.applyCommittedDelta(
            makeCommittedDelta('delete', BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, postScopeId, null, reportedPostIn)
        ),
        true
    );
    result = service.queryPersisted({ page: 1, pageSize: 25 });
    assert.equal(result.summary.categoryCounts['inbound-gap'], 1);
    assert.equal(result.summary.categoryCounts['not-selected'], 0);
    assert.equal(result.summary.incrementalUpdateCount, 3);

    assert.equal(
        service.applyCommittedDelta({ action: 'scope_stale', committed: true }),
        false,
        'scope-wide state changes require a persisted snapshot rebuild'
    );
}

verifyPersistedCommittedDeltaFlow()
    .then(() => console.log('BMP Route Assurance persisted committed-delta tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
