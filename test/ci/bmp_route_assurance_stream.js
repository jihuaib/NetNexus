// Streamed Route Assurance: the ordered SQLite scan, the chunked worker
// transport with back-pressure, and the service's stream bootstrap plus
// per-run incremental refresh must agree with the paged in-memory builder.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BmpConst = require('../../electron/const/bmpConst');
const BmpRouteAssuranceService = require('../../electron/utils/bmpRouteAssuranceService');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const { makeStreamRunKey } = require('../../electron/utils/bmpRouteAssurance');
const {
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation,
    buildRouteWithdrawMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-assurance-stream-'));
const dbPath = path.join(tempDir, 'bmp.sqlite3');
const store = new BmpPersistenceStore({ dbPath }).open();
const PRE = BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN;
const POST = BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;

const bmpSession = {
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '192.0.2.1',
    remotePort: 50000,
    sysName: 'stream-router',
    sysDesc: 'Route Assurance stream test',
    bmpVersion: 4,
    getBmpV4TlvDraft: () => 20
};

function makePeer(ip, as) {
    const owner = new BmpBgpSession(bmpSession);
    Object.assign(owner, {
        sessionType: BmpConst.BMP_PEER_TYPE.GLOBAL,
        sessionRd: '0:0',
        sessionIp: ip,
        sessionAs: as,
        vrfTableNames: []
    });
    owner.ribTypes.push(PRE, POST);
    owner.enabledAddressFamilies.push({ afi: 1, safi: 1 });
    return owner;
}

function makeRoute(owner, prefix, ribType, nextHop = '192.0.2.254') {
    const route = new BmpBgpRoute(owner, null);
    Object.assign(route, {
        afi: 1,
        safi: 1,
        ribType,
        rd: '0:0',
        ip: prefix,
        mask: 24,
        pathId: 0,
        nlriDetail: { prefix, length: 24, pathId: 0, rd: '0:0' }
    });
    route.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop, localPref: 100, med: 0, communities: [] });
    route.markActive(0);
    return route;
}

let batchSequence = 0;
function apply(mutations) {
    batchSequence += 1;
    return store.applyBatch({ batchId: `stream-${batchSequence}`, createdAtMs: Date.now(), mutations });
}

const peerA = makePeer('198.51.100.1', 65001);
const peerB = makePeer('198.51.100.2', 65002);
const prefixes = ['203.0.113.0', '203.0.114.0', '203.0.115.0'];

// Peer A: all three prefixes in Pre-In, only the first two in Post-In.
// Peer B: first prefix in Pre-In and Post-In. No Loc-RIB at all.
const openScope = (owner, ribType) =>
    buildScopeMutation(bmpSession, owner, 1, 1, ribType, 'scope_open', { kind: 'peer', state: 'ready' });
const announce = (owner, prefix, ribType) =>
    buildRouteUpsertMutation(bmpSession, owner, makeRoute(owner, prefix, ribType), 1, 1, ribType, {
        kind: 'peer',
        state: 'ready',
        scopeState: 'ready',
        isNewRoute: true
    });
apply([
    buildConnectionMutation(bmpSession, 'connection_open'),
    openScope(peerA, PRE),
    openScope(peerA, POST),
    openScope(peerB, PRE),
    openScope(peerB, POST),
    ...prefixes.map(prefix => announce(peerA, prefix, PRE)),
    announce(peerA, prefixes[0], POST),
    announce(peerA, prefixes[1], POST),
    announce(peerB, prefixes[0], PRE),
    announce(peerB, prefixes[0], POST)
]);

function pageLoader(reader) {
    return cursor => reader.queryRoutes({ routeState: 'active', pageSize: 2, includeTotal: false, cursor });
}

function comparableSummary(result) {
    const { summary } = result;
    return {
        uniqueNlriCount: summary.uniqueNlriCount,
        totalIssueCount: summary.totalIssueCount,
        categoryCounts: summary.categoryCounts,
        stageCounts: summary.stageCounts,
        stagePathCounts: summary.stagePathCounts,
        scannedPathCount: summary.scannedPathCount,
        filteredPathCount: summary.filteredPathCount,
        clientCount: summary.clientCount,
        issueIds: result.issues.map(issue => issue.id).sort()
    };
}

async function referenceSummary() {
    const service = new BmpRouteAssuranceService({ enabled: false });
    await service.bootstrapFromPersistedRoutes(pageLoader(store), {});
    return comparableSummary(service.queryPersisted({ page: 1, pageSize: 100 }));
}

async function main() {
    // 1. Store-level ordered scan: runs are contiguous and chunking is honoured.
    const chunks = [];
    const scan = store.streamRouteAssuranceRows({ routeState: 'active', chunkSize: 2 }, chunk => {
        chunks.push(chunk);
    });
    assert.equal(scan.rows, 7);
    assert.equal(scan.cancelled, false);
    assert.equal(chunks.length, 4);
    const orderedRows = chunks.flat();
    const runKeys = orderedRows.map(row => makeStreamRunKey(row));
    const seenRuns = new Set();
    let previousRun = null;
    runKeys.forEach(runKey => {
        if (runKey !== previousRun) {
            assert.equal(seenRuns.has(runKey), false, `run ${runKey} must be contiguous in the ordered scan`);
            seenRuns.add(runKey);
            previousRun = runKey;
        }
    });
    assert.equal(seenRuns.size, 3, 'three prefixes under one source form three runs');

    const cancelled = store.streamRouteAssuranceRows({ chunkSize: 3 }, () => false);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.rows, 3, 'a rejected chunk stops the scan after that chunk');

    // 2. Worker transport: chunks are awaited (slow consumer) and cancel stops the scan.
    const reader = new BmpPersistenceClient({ dbPath, readOnly: true });
    await reader.open();
    try {
        const received = [];
        const summary = await reader.streamRouteAssuranceRows(
            { routeState: 'active', chunkSize: 3 },
            {
                window: 1,
                onChunk: async chunk => {
                    await new Promise(resolve => setTimeout(resolve, 15));
                    received.push(chunk.length);
                }
            }
        );
        assert.deepEqual(received, [3, 3, 1]);
        assert.equal(summary.rows, 7);
        assert.equal(summary.cancelled, false);

        let cancelHandle = null;
        const cancelledChunks = [];
        cancelHandle = reader.streamRouteAssuranceRows(
            { routeState: 'active', chunkSize: 1 },
            {
                window: 1,
                onChunk: async chunk => {
                    cancelledChunks.push(chunk.length);
                    if (cancelledChunks.length === 2) {
                        cancelHandle.cancel();
                    }
                }
            }
        );
        const cancelledSummary = await cancelHandle;
        assert.equal(cancelledSummary.cancelled, true);
        assert.ok(cancelledChunks.length < 7, 'cancel must stop the worker before the scan completes');

        const failing = reader.streamRouteAssuranceRows(
            { chunkSize: 1 },
            {
                onChunk: async () => {
                    throw new Error('consumer boom');
                }
            }
        );
        await assert.rejects(failing, /consumer boom/);

        // 3. Stream bootstrap must match the paged reference exactly.
        const expected = await referenceSummary();
        assert.equal(expected.categoryCounts['inbound-gap'], 1, 'peer A pre-in only prefix');
        assert.equal(expected.categoryCounts['not-selected'], 2, 'post-in prefixes with no Loc-RIB');

        const loadGroupRows = async locator => {
            const result = await reader.queryRoutes({
                sourceId: locator.sourceId,
                afi: locator.afi,
                safi: locator.safi,
                prefixExact: locator.prefix,
                prefixLength: locator.prefixLength,
                routeState: 'all',
                pageSize: 5000,
                includeTotal: false
            });
            return result.list;
        };
        const service = new BmpRouteAssuranceService({ enabled: false, groupRefreshDelayMs: 0 });
        const progress = [];
        const status = await service.bootstrapFromRouteStream(
            onChunk => reader.streamRouteAssuranceRows({ routeState: 'active', chunkSize: 2 }, { onChunk }),
            {},
            {
                chunkSize: 100,
                loadGroupRows,
                onProgress: current => progress.push(current.progress.scannedPathCount)
            }
        );
        assert.equal(status.state, 'ready');
        assert.equal(status.dataMode, 'stream');
        assert.ok(progress.length > 0);
        const streamed = service.queryPersisted({ page: 1, pageSize: 100 });
        assert.deepEqual(comparableSummary(streamed), expected);

        // The lean projection (worker default) and the fast issue-free
        // pre-check must produce the same result as the full projection, with
        // and without filters that force the exact path.
        for (const options of [
            {},
            { routeState: 'all' },
            { vrf: '__global__' },
            { af: '1' },
            { query: '203.0.113.0/24' },
            { client: 'stream-router' }
        ]) {
            const referenceService = new BmpRouteAssuranceService({ enabled: false });
            await referenceService.bootstrapFromPersistedRoutes(
                cursor =>
                    store.queryRoutes({
                        routeState: options.routeState || 'active',
                        pageSize: 3,
                        includeTotal: false,
                        cursor
                    }),
                options
            );
            const leanService = new BmpRouteAssuranceService({ enabled: false });
            await leanService.bootstrapFromRouteStream(
                onChunk =>
                    reader.streamRouteAssuranceRows(
                        { routeState: options.routeState || 'active', lean: true, chunkSize: 3 },
                        { onChunk }
                    ),
                options,
                { loadGroupRows }
            );
            assert.deepEqual(
                comparableSummary(leanService.queryPersisted({ ...options, page: 1, pageSize: 100 })),
                comparableSummary(referenceService.queryPersisted({ ...options, page: 1, pageSize: 100 })),
                `lean stream must match the paged reference for ${JSON.stringify(options)}`
            );
        }
        assert.equal(streamed.summary.retainedIssueCount, expected.totalIssueCount);
        assert.deepEqual(streamed.summary.truncatedCategories, []);
        assert.ok(streamed.issues.every(issue => issue.evidenceCount >= issue.evidence.length));
        assert.ok(streamed.issues.every(issue => issue.peerCount >= issue.peers.length));

        // 4. A committed delta refreshes only the affected run and stays exact.
        const withdrawn = { prefix: prefixes[0], length: 24, pathId: 0, rd: '0:0' };
        const withdrawResult = apply([
            buildRouteWithdrawMutation(bmpSession, peerA, withdrawn, makeRoute(peerA, prefixes[0], POST), 1, 1, POST, {
                kind: 'peer',
                state: 'ready'
            })
        ]);
        assert.equal(withdrawResult.deltas.length, 1);
        assert.equal(withdrawResult.deltas[0].projectionChanged, true);
        assert.equal(service.applyCommittedDelta(withdrawResult.deltas[0]), true);
        await service.flushGroupRefreshes();
        const afterWithdraw = service.queryPersisted({ page: 1, pageSize: 100 });
        assert.deepEqual(comparableSummary(afterWithdraw), await referenceSummary());
        assert.equal(afterWithdraw.summary.categoryCounts['inbound-gap'], 2, 'the withdrawn post-in opens a gap');

        const reannounce = apply([announce(peerA, prefixes[0], POST)]);
        assert.equal(service.applyCommittedDelta(reannounce.deltas[0]), true);
        await service.flushGroupRefreshes();
        assert.deepEqual(comparableSummary(service.queryPersisted({ page: 1, pageSize: 100 })), expected);
        assert.equal(service.getStats().groupRefreshCount, 2);

        // Scope-wide transitions still require a rebuild.
        assert.equal(service.applyCommittedDelta({ action: 'scope_eor', committed: true }), false);

        // 5. Retention cap keeps counts exact while storing fewer issue objects.
        const capped = new BmpRouteAssuranceService({ enabled: false });
        await capped.bootstrapFromRouteStream(
            onChunk => reader.streamRouteAssuranceRows({ routeState: 'active' }, { onChunk }),
            {},
            { loadGroupRows, maxRetainedIssuesPerCategory: 1 }
        );
        const cappedResult = capped.queryPersisted({ page: 1, pageSize: 100 });
        assert.equal(cappedResult.summary.totalIssueCount, expected.totalIssueCount);
        assert.deepEqual(cappedResult.summary.categoryCounts, expected.categoryCounts);
        assert.equal(cappedResult.summary.retainedIssueCount, 2);
        assert.deepEqual(cappedResult.summary.truncatedCategories, ['not-selected']);
        assert.equal(cappedResult.pagination.total, expected.totalIssueCount);

        // 6. Too many pending refreshes fall back to a rebuild request.
        const overflow = new BmpRouteAssuranceService({ enabled: false, maxPendingGroupRefreshes: 1 });
        await overflow.bootstrapFromRouteStream(
            onChunk => reader.streamRouteAssuranceRows({ routeState: 'active' }, { onChunk }),
            {},
            { loadGroupRows }
        );
        const deltas = prefixes.map(prefix => ({
            action: 'upsert',
            committed: true,
            projectionChanged: true,
            current: {
                persistentSourceId: reannounce.deltas[0].sourceId,
                afi: 1,
                safi: 1,
                rd: '0:0',
                ip: prefix,
                mask: 24
            }
        }));
        assert.equal(overflow.applyCommittedDelta(deltas[0]), true);
        assert.equal(overflow.applyCommittedDelta(deltas[1]), false, 'overflow must ask for a rebuild');
    } finally {
        await reader.close({ suppressErrors: true });
    }
    console.log('BMP Route Assurance stream tests passed');
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        store.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
