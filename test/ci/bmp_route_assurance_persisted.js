const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const BmpRouteAssuranceService = require('../../electron/utils/bmpRouteAssuranceService');

const sourceId = 'persisted-source-1';
const preScopeId = 'persisted-scope-pre-in';
const postScopeId = 'persisted-scope-post-in';
const routeId = 'persisted-route-1';
const routeKey = '1|0:0|203.0.113.0|24';

function makePersistedRow({ scopeId, ribType, nextHop = '192.0.2.1', routeState = 'active' }) {
    return {
        persistentRouteId: routeId,
        persistentScopeId: scopeId,
        persistentSourceId: sourceId,
        routeKey,
        afi: 1,
        safi: 1,
        rd: '0:0',
        ip: '203.0.113.0',
        mask: 24,
        pathId: 7,
        routeState,
        scopeKind: 'peer',
        ribType,
        peer: {
            type: 0,
            rd: '0:0',
            ip: '198.51.100.1',
            as: 65001,
            vrf: 'persisted-blue'
        },
        source: {
            remoteIp: '192.0.2.10',
            sysName: 'persisted-router'
        },
        origin: 'IGP',
        asPath: '65001',
        nextHop,
        localPref: 100,
        med: 0,
        communities: ['65001:100'],
        largePersistenceOnlyPayload: 'x'.repeat(1024)
    };
}

async function verifyPersistedBootstrapAndCommittedDeltas() {
    const preIn = makePersistedRow({
        scopeId: preScopeId,
        ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
    });
    const stale = {
        ...makePersistedRow({
            scopeId: 'persisted-stale-scope',
            ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
            routeState: 'stale'
        }),
        persistentRouteId: 'persisted-stale-route',
        routeKey: '1|0:0|198.51.100.0|24',
        ip: '198.51.100.0'
    };
    const cursors = [];
    const loadPage = async cursor => {
        cursors.push(cursor);
        if (cursor === null) {
            return { list: [preIn], nextCursor: 'page-2' };
        }
        return { list: [stale], nextCursor: null };
    };

    const service = new BmpRouteAssuranceService({ enabled: false });
    const status = await service.bootstrapFromPersistedRoutes(loadPage, {}, { chunkSize: 100 });
    assert.equal(status.state, 'ready');
    assert.equal(status.dataMode, 'persisted');
    assert.deepEqual(cursors, [null, 'page-2']);

    let result = service.queryPersisted({ page: 1, pageSize: 25 });
    assert.equal(result.summary.scannedPathCount, 2, 'stale persisted paths are scanned before state filtering');
    assert.equal(result.summary.filteredPathCount, 1);
    assert.equal(result.summary.categoryCounts['inbound-gap'], 1);

    const analysis = service.cache.values().next().value.analysis;
    const retainedEntries = Array.from(analysis._incremental.sourceEntriesByKey.values()).flatMap(value =>
        Array.isArray(value) ? value : [value]
    );
    assert.equal(retainedEntries.length, 1);
    assert.notEqual(retainedEntries[0].route, preIn);
    assert.equal(retainedEntries[0].route.largePersistenceOnlyPayload, undefined);

    const postIn = makePersistedRow({
        scopeId: postScopeId,
        ribType: BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN
    });
    assert.equal(
        service.applyCommittedDelta({
            action: 'upsert',
            current: postIn,
            sourceId,
            scopeId: postScopeId,
            routeId,
            legacyRouteKey: routeKey,
            mutation: {
                source: { id: sourceId, ...postIn.source },
                scope: {
                    id: postScopeId,
                    kind: 'peer',
                    ownerKey: 'persisted-peer-owner',
                    afi: 1,
                    safi: 1,
                    ribType: BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
                    peerType: postIn.peer.type,
                    peerRd: postIn.peer.rd,
                    peerIp: postIn.peer.ip,
                    peerAs: postIn.peer.as,
                    vrfName: postIn.peer.vrf
                }
            }
        }),
        true
    );
    result = service.queryPersisted({ page: 1, pageSize: 25 });
    assert.equal(result.summary.scannedPathCount, 3);
    assert.equal(result.summary.categoryCounts['inbound-gap'], 0);
    assert.equal(result.summary.categoryCounts['not-selected'], 1);

    assert.equal(
        service.applyCommittedDelta({
            action: 'delete',
            sourceId,
            scopeId: postScopeId,
            routeId,
            routeKey,
            scopeKind: 'peer',
            ownerKey: 'persisted-peer-owner',
            afi: 1,
            safi: 1,
            ribType: BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
            source: postIn.source,
            peer: postIn.peer
        }),
        true,
        'a committed delete can remove its aggregate by stable identity without a previous route object'
    );
    result = service.queryPersisted({ page: 1, pageSize: 25 });
    assert.equal(result.summary.scannedPathCount, 2);
    assert.equal(result.summary.categoryCounts['inbound-gap'], 1);
    assert.equal(result.summary.categoryCounts['not-selected'], 0);

    assert.throws(
        () => service.queryPersisted({ client: 'another-router' }),
        error => error.code === 'BMP_ROUTE_ASSURANCE_PERSISTED_SNAPSHOT_MISS'
    );
    assert.equal(service.applyCommittedDelta({ action: 'scope_stale', scopeId: preScopeId }), false);
    assert.equal(service.applyCommittedDelta({ action: 'scope_open', scopeId: preScopeId }), false);
    assert.equal(service.applyCommittedDelta({ action: 'connection_close', sourceId }), false);
    assert.equal(service.applyCommittedDelta({ action: 'connection_open', sourceId }), true);
    const revisionBeforeNoop = service.getStats().revision;
    assert.equal(service.applyCommittedDelta({ action: 'upsert', committed: true, projectionChanged: false }), true);
    assert.equal(service.getStats().revision, revisionBeforeNoop);
}

async function verifyCommittedDeltaDuringBootstrap() {
    const rows = [];
    for (let index = 0; index < 200; index += 1) {
        rows.push({
            ...makePersistedRow({
                scopeId: preScopeId,
                ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
            }),
            persistentRouteId: `bootstrap-route-${index}`,
            routeKey: `bootstrap-route-${index}`,
            ip: `10.0.${Math.floor(index / 256)}.${index % 256}`,
            mask: 32,
            pathId: index + 1
        });
    }
    const service = new BmpRouteAssuranceService({ enabled: false });
    let applied = false;
    await service.bootstrapFromPersistedRoutes(
        rows,
        {},
        {
            chunkSize: 100,
            onProgress: status => {
                if (applied || status.progress.scannedPathCount < 100) {
                    return;
                }
                applied = true;
                service.applyCommittedDelta({
                    action: 'delete',
                    sourceId,
                    scopeId: preScopeId,
                    routeId: 'bootstrap-route-0',
                    routeKey: 'bootstrap-route-0',
                    scopeKind: 'peer',
                    ownerKey: 'persisted-peer-owner',
                    afi: 1,
                    safi: 1,
                    ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
                    source: rows[0].source,
                    peer: rows[0].peer
                });
            }
        }
    );
    assert.equal(applied, true);
    const result = service.queryPersisted({ page: 1, pageSize: 25 });
    assert.equal(result.summary.scannedPathCount, 199);
    assert.equal(result.summary.filteredPathCount, 199);
    assert.equal(result.summary.categoryCounts['inbound-gap'], 199);
}

verifyPersistedBootstrapAndCommittedDeltas()
    .then(verifyCommittedDeltaDuringBootstrap)
    .then(() => console.log('BMP Route Assurance persisted bootstrap tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
