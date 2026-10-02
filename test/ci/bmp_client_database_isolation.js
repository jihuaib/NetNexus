const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpClientPersistenceStore = require('../../electron/worker/bmp/bmpClientPersistenceStore');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const { BMP_PERSISTENCE_OP } = require('../../electron/worker/bmp/bmpPersistenceConst');
const { getClientDatabasePath, getClientWorkerIndex } = require('../../electron/worker/bmp/bmpClientPersistencePaths');
const { parseEvpnNlri } = require('../../electron/utils/bgpAddressFamily/evpn');
const { parseFlowSpecNlri } = require('../../electron/utils/bgpAddressFamily/flowSpec');
const {
    buildConnectionMutation,
    buildRouteUpsertMutation,
    buildRouteWithdrawMutation,
    buildScopeMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const RIB_TYPE = 2;
const COMMON_ATTR = {
    origin: 'IGP',
    asPath: '65001',
    localPref: 100,
    communities: ['65001:100'],
    nextHop: '192.0.2.1'
};

function makeContext(name, generation, remotePort) {
    const bmpSession = {
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort,
        sysName: name,
        sysDesc: 'client database isolation test',
        bmpVersion: 4,
        persistenceConnectionId: `${name}-connection-${generation}`,
        persistenceConnectionGeneration: generation,
        persistenceOpenedAtMs: Date.now(),
        getBmpV4TlvDraft: () => 20
    };
    const owner = new BmpBgpSession(bmpSession);
    Object.assign(owner, {
        sessionType: 0,
        sessionRd: '0:0',
        sessionRdRaw: 'raw:0000000000000000',
        sessionIp: '198.51.100.1',
        sessionAs: 65001,
        vrfTableNames: ['global']
    });
    return { bmpSession, owner };
}

function routeFixtures() {
    const evpnBody = Buffer.concat([
        Buffer.from('0000fde800000001', 'hex'),
        Buffer.alloc(10),
        Buffer.from('00000064', 'hex'),
        Buffer.from('30aabbccddeeff20c000020a002710', 'hex')
    ]);
    const evpn = parseEvpnNlri(Buffer.concat([Buffer.from([2, evpnBody.length]), evpnBody]), 0).route;
    const flowSpec = parseFlowSpecNlri(Buffer.from([5, 1, 24, 192, 0, 2]), 0, 1).route;
    assert.notEqual(evpn.valid, false, 'EVPN fixture must parse');
    assert.equal(flowSpec.valid, true, 'FlowSpec fixture must parse');
    return [
        { afi: 1, safi: 1, nlri: { prefix: '203.0.113.0', length: 24, pathId: 0, rd: '0:0' } },
        { afi: 25, safi: 70, nlri: evpn },
        { afi: 1, safi: 133, nlri: flowSpec }
    ];
}

function makeRoute(owner, fixture, attr = COMMON_ATTR) {
    const nlri = JSON.parse(JSON.stringify(fixture.nlri));
    const route = new BmpBgpRoute(owner, null);
    Object.assign(route, {
        afi: fixture.afi,
        safi: fixture.safi,
        ribType: RIB_TYPE,
        pathId: nlri.pathId || 0,
        rd: nlri.rd || '0:0',
        rdRaw: nlri.rdRaw || null,
        ip: nlri.displayPrefix || nlri.prefix,
        mask: nlri.length,
        routeType: nlri.routeType ?? null,
        nlriDetail: { ...nlri, pathId: nlri.pathId || 0, rd: nlri.rd || '0:0' }
    });
    route.assignRouteAttr(attr);
    route.markActive(owner.getRibEpoch(fixture.afi, fixture.safi, RIB_TYPE));
    return route;
}

function scopeMutation(context, fixture, eventType, state) {
    return buildScopeMutation(context.bmpSession, context.owner, fixture.afi, fixture.safi, RIB_TYPE, eventType, {
        kind: 'peer',
        state
    });
}

function announce(context, route) {
    return buildRouteUpsertMutation(context.bmpSession, context.owner, route, route.afi, route.safi, RIB_TYPE, {
        kind: 'peer',
        scopeState: 'ready',
        isNewRoute: true
    });
}

function seed(context, fixtures) {
    const mutations = [buildConnectionMutation(context.bmpSession, 'connection_open')];
    fixtures.forEach(fixture => {
        mutations.push(scopeMutation(context, fixture, 'scope_open', 'syncing'));
        mutations.push(announce(context, makeRoute(context.owner, fixture)));
        mutations.push(scopeMutation(context, fixture, 'scope_eor', 'ready'));
    });
    return mutations;
}

function readPhysicalDatabase(dbPath) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return {
            sources: db.prepare('SELECT source_id FROM bmp_sources ORDER BY source_id').all(),
            attributes: db.prepare('SELECT attr_id, attr_json FROM bmp_route_attributes ORDER BY attr_id').all(),
            identities: db
                .prepare('SELECT route_id, afi, safi, nlri_kind, prefix FROM bmp_route_identities ORDER BY route_id')
                .all(),
            payloads: db.prepare('SELECT payload_hash, route_json FROM bmp_route_payloads ORDER BY payload_hash').all(),
            routes: db.prepare('SELECT COUNT(*) AS count FROM bmp_current_route_refs').get().count
        };
    } finally {
        db.close();
    }
}

function assertPhysicalIsolation(dbPath, sourceId, expectedRoutes = 3) {
    const rows = readPhysicalDatabase(dbPath);
    assert.deepEqual(rows.sources, [{ source_id: sourceId }], 'one physical database must own exactly its Client');
    assert.equal(rows.routes, expectedRoutes);
    assert.equal(rows.identities.length, 3, 'identical NLRIs must exist independently in each physical database');
    assert.equal(
        rows.attributes.length,
        1,
        'identical attributes must be deduplicated locally, not shared across Client files'
    );
    assert.equal(JSON.parse(rows.attributes[0].attr_json).nextHop, COMMON_ATTR.nextHop);
    return rows;
}

function testInvalidBatchIsolation(dbPath, fixtures) {
    const store = new BmpClientPersistenceStore({ dbPath }).open();
    try {
        const clientA = makeContext('invalid-batch-a', 100, 51001);
        const clientB = makeContext('invalid-batch-b', 200, 51002);
        const seedA = seed(clientA, fixtures);
        const seedB = seed(clientB, fixtures);
        store.applyBatch({ batchId: 'invalid-batch-seed', mutations: [...seedA, ...seedB], createdAtMs: Date.now() });
        const sourceA = seedA[0].source.id;
        const sourceB = seedB[0].source.id;
        const changed = () =>
            announce(clientA, makeRoute(clientA.owner, fixtures[0], { ...COMMON_ATTR, nextHop: '192.0.2.99' }));
        const foreignConnection = changed();
        foreignConnection.connection = seedB[0].connection;
        const foreignScope = changed();
        foreignScope.scope = seedB[2].scope;

        [foreignConnection, foreignScope].forEach((invalid, index) => {
            assert.throws(
                () =>
                    store.applyBatch({
                        batchId: `invalid-batch-${index}`,
                        mutations: [changed(), invalid],
                        createdAtMs: Date.now()
                    }),
                /source|client|ownership|belong|scope|connection/i,
                'a foreign Client descriptor must reject the entire batch before any database is modified'
            );
            assertPhysicalIsolation(getClientDatabasePath(dbPath, sourceA), sourceA);
            assertPhysicalIsolation(getClientDatabasePath(dbPath, sourceB), sourceB);
            assert.equal(
                store.queryRoutes({ sourceId: sourceA, afi: 1, safi: 1, routeState: 'all' }).list[0].nextHop,
                COMMON_ATTR.nextHop
            );
        });
    } finally {
        store.close();
    }
}

async function testPoolBatchIsolation(client, clientA, clientB, seedA, seedB, fixtures, pathA, pathB) {
    const beforeA = readPhysicalDatabase(pathA);
    const beforeB = readPhysicalDatabase(pathB);
    const changedA = () =>
        announce(clientA, makeRoute(clientA.owner, fixtures[0], { ...COMMON_ATTR, nextHop: '192.0.2.98' }));
    const changedB = () =>
        announce(clientB, makeRoute(clientB.owner, fixtures[0], { ...COMMON_ATTR, nextHop: '192.0.2.99' }));
    const foreignConnection = changedB();
    foreignConnection.connection = seedA[0].connection;
    const foreignScope = changedB();
    foreignScope.scope = seedA[2].scope;
    for (const [index, invalid] of [foreignConnection, foreignScope].entries()) {
        await assert.rejects(
            client.sendRequest(BMP_PERSISTENCE_OP.APPLY_BATCH, {
                batchId: `pool-invalid-batch-${index}`,
                createdAtMs: Date.now(),
                mutations: [changedA(), invalid]
            }),
            /source|client|ownership|belong|scope|connection/i,
            'pool preflight must reject a mixed-lane batch before dispatching the valid Client group'
        );
        assert.deepEqual(readPhysicalDatabase(pathA), beforeA);
        assert.deepEqual(readPhysicalDatabase(pathB), beforeB);
    }
    assert.equal(
        (await client.queryRoutes({ sourceId: seedB[0].source.id, afi: 1, safi: 1, routeState: 'all' })).list[0]
            .nextHop,
        COMMON_ATTR.nextHop
    );
}

async function testAggregateCursorAndStream(client) {
    const rows = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
        const result = await client.queryRoutes({ routeState: 'all', pageSize: 2, cursor });
        rows.push(...result.list);
        cursor = result.nextCursor;
        if (!cursor) break;
    }
    assert.equal(cursor, null, 'aggregate cursors must terminate across the Client boundary');
    assert.equal(rows.length, 6);
    assert.equal(new Set(rows.map(route => `${route.persistentScopeId}|${route.persistentRouteId}`)).size, 6);
    const streamed = [];
    const scan = await client.streamRouteAssuranceRows(
        { routeState: 'active', chunkSize: 1 },
        {
            window: 1,
            onChunk: chunk => streamed.push(...chunk)
        }
    );
    assert.equal(scan.rows, 6);
    assert.equal(scan.cancelled, false);
    assert.equal(streamed.length, 6);
    const sourceRuns = streamed
        .map(row => row.persistentSourceId)
        .filter((id, index, ids) => index === 0 || ids[index - 1] !== id);
    assert.equal(sourceRuns.length, 2, 'Route Assurance bootstrap must keep each Client in one contiguous group');
    assert.equal(new Set(sourceRuns).size, 2);
    let cancelledRows = 0;
    let handle;
    handle = client.streamRouteAssuranceRows(
        { routeState: 'active', chunkSize: 1 },
        {
            window: 1,
            onChunk: chunk => {
                cancelledRows += chunk.length;
                handle.cancel();
            }
        }
    );
    assert.equal((await handle).cancelled, true);
    assert.ok(
        cancelledRows > 0 && cancelledRows < 6,
        'stream cancellation must stop before a complete cross-Client bootstrap'
    );
    assert.equal(
        (await client.queryRoutes({ routeState: 'all' })).total,
        6,
        'cancelling a read must leave the reader usable'
    );
}

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-client-databases-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    const fixtures = routeFixtures();
    let client;
    let offline;
    try {
        testInvalidBatchIsolation(path.join(tempDir, 'invalid-batches.sqlite3'), fixtures);
        client = new BmpPersistenceClient({
            dbPath,
            partitionByClient: true,
            writerWorkerCount: 2,
            batchSize: 64,
            flushMs: 1
        });
        await client.open();
        const clientA = makeContext('database-client-a', 100, 50001);
        const clientB = makeContext('database-client-b-2', 200, 50002);
        const seedA = seed(clientA, fixtures);
        const seedB = seed(clientB, fixtures);
        const sourceA = seedA[0].source.id;
        const sourceB = seedB[0].source.id;
        assert.notEqual(sourceA, sourceB, 'different names on the same source address must identify different Clients');
        assert.notEqual(
            getClientWorkerIndex(sourceA, 2),
            getClientWorkerIndex(sourceB, 2),
            'the test must exercise both FIFO writer lanes'
        );
        const threadIds = client.clients.map(lane => lane.worker.threadId);
        assert.equal(threadIds.length, 2);
        assert.ok(threadIds.every(threadId => Number.isInteger(threadId) && threadId > 0));
        assert.equal(new Set(threadIds).size, 2, 'the two Client lanes must run in distinct real worker threads');
        for (let index = 0; index < seedA.length; index += 1) {
            client.enqueue(seedA[index]);
            client.enqueue(seedB[index]);
        }
        await client.fence();
        assert.ok(
            client.clients.every(
                lane => lane.mutationSequence > 0 && lane.committedMutationSequence >= lane.mutationSequence
            ),
            'a real pool fence must wait until both writer threads acknowledge all seeded mutations'
        );
        assert.equal(client.getWatermark().bufferedBytes, 0);
        await client.drain();

        const pathA = getClientDatabasePath(dbPath, sourceA);
        const pathB = getClientDatabasePath(dbPath, sourceB);
        assert.notEqual(pathA, pathB);
        assert.equal(path.dirname(pathA), `${path.resolve(dbPath)}.clients`);
        assert.equal(fs.existsSync(dbPath), false, 'Client storage must not silently create a shared RIB database');
        const physicalA = assertPhysicalIsolation(pathA, sourceA);
        const physicalB = assertPhysicalIsolation(pathB, sourceB);
        assert.deepEqual(physicalA.identities, physicalB.identities);
        assert.deepEqual(physicalA.attributes, physicalB.attributes);
        await testPoolBatchIsolation(client, clientA, clientB, seedA, seedB, fixtures, pathA, pathB);
        const status = await client.getStatus({ includeCounts: true });
        assert.equal(status.storageMode, 'client-databases');
        assert.equal(status.storageDirectory, path.dirname(pathA));
        assert.equal(status.clientDatabaseCount, 2);
        assert.equal(status.writerWorkerCount, 2);
        assert.equal(status.sources, 2);
        assert.equal(status.currentRoutes, 6);
        assert.deepEqual(new Set(status.clientDatabases.map(entry => entry.dbPath)), new Set([pathA, pathB]));
        const topology = await client.queryTopology();
        assert.equal(topology.sourceCount, 2);
        assert.equal(topology.routeSummary.total, 6);
        assert.equal((await client.queryRoutes({ routeState: 'all', pageSize: 20 })).total, 6);
        assert.equal(
            (await client.queryRoutes({ sourceId: sourceA, scopeId: seedB[2].scope.id, routeState: 'all' })).total,
            0,
            'an explicit Client lookup must not leak a foreign Client scope'
        );
        const paginated = [];
        for (let page = 1; page <= 3; page += 1) {
            const result = await client.queryRoutes({ routeState: 'all', pageSize: 2, page });
            assert.equal(result.total, 6);
            assert.equal(result.list.length, 2);
            paginated.push(...result.list);
        }
        assert.equal(new Set(paginated.map(route => `${route.persistentScopeId}|${route.persistentRouteId}`)).size, 6);
        await testAggregateCursorAndStream(client);

        for (const sourceId of [sourceA, sourceB]) {
            for (const fixture of fixtures) {
                const result = await client.queryRoutes({
                    sourceId,
                    afi: fixture.afi,
                    safi: fixture.safi,
                    routeState: 'all'
                });
                assert.equal(
                    result.total,
                    1,
                    'IP, EVPN and FlowSpec routes must all remain readable through Client routing'
                );
                assert.equal(result.list[0].nextHop, COMMON_ATTR.nextHop);
                assert.equal(result.list[0].nlriDetail.prefix, fixture.nlri.prefix);
                const detail = await client.queryRoutes({
                    sourceId,
                    legacyRouteKey: result.list[0].routeKey,
                    routeState: 'all'
                });
                assert.equal(detail.total, 1);
                assert.equal(detail.list[0].persistentRouteId, result.list[0].persistentRouteId);
            }
        }

        client.enqueue(
            announce(clientA, makeRoute(clientA.owner, fixtures[0], { ...COMMON_ATTR, nextHop: '192.0.2.2' }))
        );
        await client.drain();
        assert.equal(
            (await client.queryRoutes({ sourceId: sourceA, afi: 1, safi: 1, routeState: 'all' })).list[0].nextHop,
            '192.0.2.2'
        );
        assertPhysicalIsolation(pathB, sourceB);
        const evpn = fixtures[1];
        client.enqueue(
            buildRouteWithdrawMutation(
                clientA.bmpSession,
                clientA.owner,
                evpn.nlri,
                null,
                evpn.afi,
                evpn.safi,
                RIB_TYPE,
                { kind: 'peer' }
            )
        );
        await client.drain();
        assert.equal(
            (await client.queryRoutes({ sourceId: sourceA, afi: evpn.afi, safi: evpn.safi, routeState: 'all' })).total,
            0
        );
        assert.equal(
            (await client.queryRoutes({ sourceId: sourceB, afi: evpn.afi, safi: evpn.safi, routeState: 'all' })).total,
            1
        );
        const flowSpec = fixtures[2];
        client.enqueue(
            buildRouteWithdrawMutation(
                clientA.bmpSession,
                clientA.owner,
                flowSpec.nlri,
                null,
                flowSpec.afi,
                flowSpec.safi,
                RIB_TYPE,
                { kind: 'peer' }
            )
        );
        await client.drain();
        assert.equal(
            (await client.queryRoutes({ sourceId: sourceA, afi: flowSpec.afi, safi: flowSpec.safi, routeState: 'all' }))
                .total,
            0
        );
        assert.equal(
            (await client.queryRoutes({ sourceId: sourceB, afi: flowSpec.afi, safi: flowSpec.safi, routeState: 'all' }))
                .total,
            1
        );
        client.enqueue(announce(clientA, makeRoute(clientA.owner, flowSpec)));
        await client.drain();

        client.enqueue(
            buildConnectionMutation(clientA.bmpSession, 'connection_close', { reason: 'test-client-close' })
        );
        await client.drain();
        assert.equal((await client.queryRoutes({ sourceId: sourceA, routeState: 'stale' })).total, 2);
        assert.equal((await client.queryRoutes({ sourceId: sourceB, routeState: 'active' })).total, 3);
        const replacementA = makeContext('database-client-a', 300, 50003);
        const replacementOpen = buildConnectionMutation(replacementA.bmpSession, 'connection_open');
        assert.equal(replacementOpen.source.id, sourceA, 'a changed TCP port must reuse the same Client database');
        client.enqueue(replacementOpen);
        fixtures.forEach(fixture => {
            client.enqueue(scopeMutation(replacementA, fixture, 'scope_open', 'syncing'));
            if (fixture.safi === 1) {
                client.enqueue(
                    announce(
                        replacementA,
                        makeRoute(replacementA.owner, fixture, { ...COMMON_ATTR, nextHop: '192.0.2.3' })
                    )
                );
            }
            client.enqueue(scopeMutation(replacementA, fixture, 'scope_eor', 'ready'));
        });
        await client.drain();
        await client.sweep({
            mode: 'lifecycle',
            sourceId: sourceA,
            staleBeforeMs: 0,
            refreshTimeoutBeforeMs: 0,
            eventsBeforeMs: 0
        });
        assert.equal(
            (await client.queryRoutes({ sourceId: sourceA, routeState: 'all' })).total,
            1,
            'EOR must remove only unseen routes of the reconnecting Client'
        );
        assert.equal(
            (await client.queryRoutes({ sourceId: sourceA, routeState: 'active' })).list[0].nextHop,
            '192.0.2.3'
        );
        assertPhysicalIsolation(pathB, sourceB);
        assert.equal(
            (await client.getStatus()).clientDatabaseCount,
            2,
            'reconnect must not create a third physical database'
        );

        await client.close();
        client = null;
        const beforeRestartB = readPhysicalDatabase(pathB);
        const restartA = new BmpPersistenceStore({ dbPath: pathA }).open();
        restartA.close();
        assert.deepEqual(
            readPhysicalDatabase(pathB),
            beforeRestartB,
            'recovery of one Client database must not modify another Client'
        );
        offline = new BmpPersistenceClient({ dbPath, partitionByClient: true, readOnly: true });
        await offline.open();
        assert.equal(
            (await offline.queryRoutes({ routeState: 'all' })).total,
            4,
            'offline startup must discover both persisted Client databases'
        );
        assert.equal((await offline.queryTopology()).sourceCount, 2);
        assert.equal((await offline.queryRoutes({ sourceId: sourceB, routeState: 'active' })).total, 3);
        await offline.close();
        offline = null;

        client = new BmpPersistenceClient({ dbPath, partitionByClient: true, writerWorkerCount: 2 });
        await client.open();
        offline = new BmpPersistenceClient({ dbPath, partitionByClient: true, readOnly: true });
        await offline.open();
        assert.equal((await offline.queryRoutes({ sourceId: sourceA, routeState: 'all' })).total, 1);
        assert.equal((await offline.queryRoutes({ sourceId: sourceB, routeState: 'all' })).total, 3);
        const retainedInode = fs.statSync(pathA).ino;
        const beforeDeleteB = readPhysicalDatabase(pathB);
        const deleted = await client.purgeSource({ sourceId: sourceA });
        assert.equal(deleted.deleted, true);
        assert.equal(
            fs.existsSync(pathA),
            true,
            'purge retains the empty file so readers cannot hold an obsolete inode'
        );
        const afterDeleteA = readPhysicalDatabase(pathA);
        assert.equal(afterDeleteA.sources.length, 0);
        assert.equal(afterDeleteA.routes, 0);
        assert.equal(afterDeleteA.attributes.length, 0, 'Client deletion must remove all of its local attributes');
        assert.equal(afterDeleteA.identities.length, 0);
        assert.equal(afterDeleteA.payloads.length, 0);
        assert.deepEqual(
            readPhysicalDatabase(pathB),
            beforeDeleteB,
            'deleting Client A must not alter Client B routes, attributes or identities'
        );
        assert.equal((await client.queryRoutes({ sourceId: sourceA, routeState: 'all' })).total, 0);
        assert.equal((await client.queryRoutes({ sourceId: sourceB, routeState: 'all' })).total, 3);
        assert.equal((await client.queryRoutes({ routeState: 'all' })).total, 3);
        assert.equal(
            (await offline.queryRoutes({ sourceId: sourceA, routeState: 'all' })).total,
            0,
            'an already-open independent reader must observe the committed Client deletion'
        );
        assert.equal((await offline.queryRoutes({ sourceId: sourceB, routeState: 'all' })).total, 3);
        const revivedA = makeContext('database-client-a', 400, 50004);
        const revivedSeed = seed(revivedA, fixtures);
        assert.equal(revivedSeed[0].source.id, sourceA);
        revivedSeed.forEach(mutation => client.enqueue(mutation));
        await client.drain();
        assert.equal(
            fs.statSync(pathA).ino,
            retainedInode,
            'Client reattachment must reuse the retained file rather than create a zombie reader inode'
        );
        assert.equal((await client.getStatus()).clientDatabaseCount, 2);
        assert.equal((await offline.queryRoutes({ sourceId: sourceA, routeState: 'all' })).total, 3);
        assert.equal(
            (await offline.queryRoutes({ sourceId: sourceA, afi: 1, safi: 1, routeState: 'all' })).list[0].nextHop,
            COMMON_ATTR.nextHop
        );
        assert.deepEqual(readPhysicalDatabase(pathB), beforeDeleteB);
        await client.purgeSource({ sourceId: sourceA });
        assert.equal((await offline.queryRoutes({ sourceId: sourceA, routeState: 'all' })).total, 0);
        assert.equal((await offline.queryRoutes({ sourceId: sourceB, routeState: 'all' })).total, 3);
        await offline.close();
        offline = null;
        await client.close();
        client = null;
        offline = new BmpPersistenceClient({ dbPath, partitionByClient: true, readOnly: true });
        await offline.open();
        assert.equal((await offline.queryRoutes({ routeState: 'all' })).total, 3);
        assert.equal(
            (await offline.queryTopology()).sourceCount,
            1,
            'a restart must not resurrect the deleted Client from its retained empty file'
        );
        console.log(
            'BMP Client database isolation tests passed: physical files, attributes, NLRI, invalid batches, withdraw, reconnect/EOR, restart and delete'
        );
    } finally {
        if (offline) await offline.close({ suppressErrors: true });
        if (client) await client.close({ suppressErrors: true });
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
