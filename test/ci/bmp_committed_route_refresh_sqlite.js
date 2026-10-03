const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');
const Session = require('../../electron/worker/bmp/bmpSession');
const Peer = require('../../electron/worker/bmp/bmpBgpSession');
const Instance = require('../../electron/worker/bmp/bmpBgpInstance');
const Route = require('../../electron/worker/bmp/bmpBgpRoute');
const Assurance = require('../../electron/utils/bmpRouteAssuranceService');
const Aggregator = require('../../electron/utils/routeUpdateAggregator');
const BmpConst = require('../../electron/const/bmpConst');
const { getClientWorkerIndex } = require('../../electron/worker/bmp/bmpClientPersistencePaths');
const {
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const BmpWorker = loadBmpWorkerClass(__dirname, module);
const PARTIAL = 70233;
const TOTAL = 100000;
const RIB = BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;

function context(name, port) {
    const session = new Session({}, {});
    Object.assign(session, {
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort: port,
        sysName: name
    });
    const peer = new Peer(session);
    Object.assign(peer, { sessionType: 0, sessionRd: '0:0', sessionIp: '198.51.100.1', sessionAs: 65001 });
    peer.ensureRouteScope(1, 1, RIB);
    const instance = new Instance(session);
    Object.assign(instance, {
        instanceType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        instanceRd: '0:0',
        instanceIp: '0.0.0.0',
        instanceAs: 0,
        afi: 1,
        safi: 1
    });
    const open = buildConnectionMutation(session, 'connection_open');
    const owners = [
        { owner: peer, kind: 'peer', rib: RIB },
        { owner: instance, kind: 'loc-rib', rib: 'loc-rib' }
    ].map(item => ({
        ...item,
        scope: buildScopeMutation(session, item.owner, 1, 1, item.rib, 'scope_open', {
            kind: item.kind,
            state: 'syncing'
        }).scope
    }));
    return {
        session,
        open,
        sourceId: open.source.id,
        owners,
        attr: Object.freeze({ origin: 'IGP', asPath: '65001', localPref: 100, nextHop: '192.0.2.1' })
    };
}

function announce(current, item, index) {
    const prefix = `10.${Math.floor(index / 65536)}.${Math.floor(index / 256) % 256}.${index % 256}`;
    const route = new Route(item.kind === 'peer' ? item.owner : null, item.kind === 'loc-rib' ? item.owner : null);
    Object.assign(route, {
        afi: 1,
        safi: 1,
        ribType: item.rib,
        ip: prefix,
        mask: 32,
        pathId: 0,
        rd: '0:0',
        nlriDetail: { prefix, length: 32, pathId: 0, rd: '0:0' }
    });
    route.assignSharedRouteAttr(current.attr);
    return buildRouteUpsertMutation(current.session, item.owner, route, 1, 1, item.rib, { kind: item.kind });
}

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-committed-refresh-'));
    const a = context('commit-refresh-a', 51001);
    let b;
    for (let index = 0; ; index++) {
        b = context(`commit-refresh-b-${index}`, 51002);
        if (getClientWorkerIndex(a.sourceId, 2) !== getClientWorkerIndex(b.sourceId, 2)) break;
    }
    const events = [];
    const queries = [];
    const visible = new Map();
    const failures = [];
    const worker = Object.create(BmpWorker.prototype);
    Object.assign(worker, {
        bmpConfigData: {
            persistenceDbPath: path.join(directory, 'bmp.sqlite3'),
            threadCount: 2,
            persistenceBatchSize: 5000,
            persistenceHighWatermarkBytes: 256 * 1024 * 1024,
            logLevel: 'off'
        },
        bmpStopping: false,
        bmpSessionMap: new Map(),
        persistenceReader: null,
        routeAssuranceService: new Assurance({ enabled: false }),
        routeUpdateAggregator: new Aggregator(),
        routeUpdateFlushIntervalMs: 10,
        schedulePersistenceSweep() {},
        handlePersistenceFailure: error => failures.push(error),
        messageHandler: {
            sendEvent(type, payload) {
                events.push({ type, payload });
                for (const update of payload.data.updates) {
                    assert.equal(update.reason, 'persistence-commit');
                    assert.equal(update.changedCount, 0);
                    assert.equal(update.client.persistentConnectionId, a.open.connection.id);
                    assert.equal(update.sourceId, a.sourceId);
                    assert.ok(a.owners.some(item => item.scope.id === update.scopeId));
                    // Model the active UI's nonblocking query on a commit
                    // notification. No explicit tail query or tab switch.
                    const query = worker
                        .queryRouteScope(
                            { sourceId: update.sourceId, scopeId: update.scopeId },
                            { page: 1, pageSize: 25, routeState: 'all' }
                        )
                        .then(result => {
                            visible.set(update.scopeId, result.total);
                            assert.ok(result.list.length <= 25);
                            assert.equal(result.summary.total, result.total);
                        });
                    queries.push(query);
                }
            }
        }
    });
    try {
        await worker.initializePersistence();
        assert.equal(worker.persistence.clients.length, 2);
        assert.notEqual(
            worker.persistence.getClient(a.sourceId).worker.threadId,
            worker.persistence.getClient(b.sourceId).worker.threadId
        );
        for (const current of [a, b]) {
            worker.persistence.enqueue(current.open);
            for (const item of current.owners) {
                for (let index = 0; index < (current === a ? PARTIAL : 3); index++) {
                    worker.persistence.enqueue(announce(current, item, index));
                }
            }
        }
        // Initial two-client seed notifications are outside the active-page
        // assertion; wait for committed data and reset the aggregation.
        worker.bmpStopping = true;
        await worker.persistence.fence();
        worker.clearRouteUpdateAggregation();
        worker.bmpStopping = false;
        for (const item of a.owners) {
            const page = await worker.queryRouteScope(
                { sourceId: a.sourceId, scopeId: item.scope.id },
                { page: 1, pageSize: 25, routeState: 'all' }
            );
            assert.equal(page.total, PARTIAL);
            visible.set(item.scope.id, page.total);
        }
        for (const item of a.owners) {
            for (let index = PARTIAL; index < TOTAL; index++) worker.persistence.enqueue(announce(a, item, index));
            worker.persistence.enqueue(
                buildScopeMutation(a.session, item.owner, 1, 1, item.rib, 'scope_eor', {
                    kind: item.kind,
                    state: 'ready'
                })
            );
        }
        await worker.persistence.fence(a.sourceId);
        // Use the production timer for the final notification, not a forced
        // flush. The normal page observer must converge on its own.
        const deadline = Date.now() + 5000;
        while (a.owners.some(item => visible.get(item.scope.id) !== TOTAL) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        await Promise.all(queries);
        assert.deepEqual(
            a.owners.map(item => visible.get(item.scope.id)),
            [TOTAL, TOTAL],
            'the final commit must notify both pages after the last input without a tab switch'
        );
        for (const type of [BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE])
            assert.ok(events.some(event => event.type === type));
        for (const item of b.owners) {
            const summary = await worker.persistenceReader.queryScopeSummary({
                sourceId: b.sourceId,
                scopeId: item.scope.id
            });
            assert.equal(summary.total, 3, 'another client database must be unchanged');
        }
        assert.equal(failures.length, 0);
        console.log(
            'BMP committed refresh SQLite passed: Peer/Loc-RIB 70233 -> 100000 via commit events, 2 client writers'
        );
    } finally {
        worker.bmpStopping = true;
        worker.clearRouteUpdateAggregation();
        await worker.persistenceReader?.close({ suppressErrors: true });
        await worker.persistence?.close({ suppressErrors: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
