const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');
const Session = require('../../electron/worker/bmp/bmpSession');
const Peer = require('../../electron/worker/bmp/bmpBgpSession');
const Instance = require('../../electron/worker/bmp/bmpBgpInstance');
const Route = require('../../electron/worker/bmp/bmpBgpRoute');
const Persistence = require('../../electron/worker/bmp/bmpPersistenceClient');
const Assurance = require('../../electron/utils/bmpRouteAssuranceService');
const Aggregator = require('../../electron/utils/routeUpdateAggregator');
const BmpConst = require('../../electron/const/bmpConst');
const { getAddrFamilyType } = require('../../electron/utils/bgpUtils');
const { getClientDatabasePath, getClientWorkerIndex } = require('../../electron/worker/bmp/bmpClientPersistencePaths');
const {
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const BmpWorker = loadBmpWorkerClass(__dirname, module);
const STALE = 20003;
const RIB = BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;

function context(name, port, generation, nextHop) {
    const session = new Session({}, {});
    Object.assign(session, {
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort: port,
        sysName: name,
        persistenceConnectionId: `${name}-connection`,
        persistenceConnectionGeneration: generation,
        persistenceOpenedAtMs: Date.now()
    });
    const peers = [1, 2].map(index => {
        const owner = new Peer(session);
        Object.assign(owner, {
            sessionType: 0,
            sessionRd: '0:0',
            sessionIp: `198.51.100.${index}`,
            sessionAs: 65001,
            sessionState: BmpConst.BMP_SESSION_STATE.PEER_UP,
            enabledAddressFamilies: [{ afi: 1, safi: 1 }],
            ribTypes: [RIB]
        });
        owner.ensureRouteScope(1, 1, RIB);
        session.bgpSessionMap.set(Peer.makeKey(0, '0:0', owner.sessionIp, 65001), owner);
        return owner;
    });
    const instance = new Instance(session);
    Object.assign(instance, {
        instanceType: BmpConst.BMP_PEER_TYPE.LOCAL_RIB,
        instanceRd: '0:0',
        instanceIp: '0.0.0.0',
        instanceAs: 0,
        afi: 1,
        safi: 1,
        instanceState: BmpConst.BMP_SESSION_STATE.PEER_UP
    });
    session.bgpInstanceMap.set(Instance.makeKey(instance.instanceType, '0:0', 1, 1), instance);
    const open = buildConnectionMutation(session, 'connection_open');
    return {
        session,
        peers,
        instance,
        open,
        sourceId: open.source.id,
        attr: Object.freeze({ origin: 'IGP', asPath: '65001', localPref: 100, nextHop })
    };
}

function announce(current, owner, index, kind = 'peer') {
    const ribType = kind === 'peer' ? RIB : 'loc-rib';
    const prefix = `10.${Math.floor(index / 65536)}.${Math.floor(index / 256) % 256}.${index % 256}`;
    const route = new Route(kind === 'peer' ? owner : null, kind === 'loc-rib' ? owner : null);
    Object.assign(route, {
        afi: 1,
        safi: 1,
        ribType,
        ip: prefix,
        mask: 32,
        pathId: 0,
        rd: '0:0',
        nlriDetail: { prefix, length: 32, pathId: 0, rd: '0:0' }
    });
    route.assignSharedRouteAttr(current.attr);
    route.markActive(owner.getRibEpoch(1, 1, ribType));
    return buildRouteUpsertMutation(current.session, owner, route, 1, 1, ribType, { kind, scopeState: 'ready' });
}

function scope(current, owner, kind = 'peer') {
    return buildScopeMutation(current.session, owner, 1, 1, kind === 'peer' ? RIB : 'loc-rib', 'scope_open', {
        kind,
        state: 'syncing'
    });
}

function physical(dbPath) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const rows = {};
        for (const table of [
            'bmp_connections',
            'bmp_rib_scopes',
            'bmp_scope_route_counts',
            'bmp_route_attributes',
            'bmp_route_payloads',
            'bmp_route_identities'
        ])
            rows[table] = db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
        rows.routes = db.prepare('SELECT * FROM bmp_current_route_refs ORDER BY scope_pk, route_pk').all();
        rows.foreignKeys = db.pragma('foreign_key_check');
        return rows;
    } finally {
        db.close();
    }
}

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-manual-pool-'));
    const dbPath = path.join(directory, 'bmp.sqlite3');
    const a = context('manual-pool-a', 51001, 1000, '192.0.2.1');
    let b;
    for (let index = 0; ; index++) {
        b = context(`manual-pool-b-${index}`, 51002, 2000, '192.0.2.2');
        if (getClientWorkerIndex(a.sourceId, 2) !== getClientWorkerIndex(b.sourceId, 2)) break;
    }
    const errors = [];
    const persistence = new Persistence({
        dbPath,
        partitionByClient: true,
        writerWorkerCount: 2,
        batchSize: 5000,
        includeCommittedDeltas: false,
        onError: error => errors.push(error)
    });
    const worker = Object.create(BmpWorker.prototype);
    const responses = [];
    const events = [];
    Object.assign(worker, {
        persistence,
        persistenceReader: null,
        persistenceFailure: null,
        ingestPool: null,
        bmpRuntimeStarted: true,
        bmpStopping: false,
        staleScopePurgeTasks: new Map(),
        routeAssuranceService: new Assurance({ enabled: false }),
        routeUpdateAggregator: new Aggregator(),
        routeUpdateFlushIntervalMs: 1000,
        bmpSessionMap: new Map(
            [a, b].map(current => [
                Session.makeKey(
                    current.session.localIp,
                    current.session.localPort,
                    current.session.remoteIp,
                    current.session.remotePort
                ),
                current.session
            ])
        ),
        messageHandler: {
            sendSuccessResponse: (id, data) => responses.push({ id, status: 'success', data }),
            sendErrorResponse: (id, msg) => responses.push({ id, status: 'error', msg }),
            sendEvent: (type, payload) => events.push({ type, payload })
        }
    });
    try {
        await persistence.open();
        assert.equal(persistence.clients.length, 2);
        assert.notEqual(
            persistence.getClient(a.sourceId).worker.threadId,
            persistence.getClient(b.sourceId).worker.threadId
        );
        const descriptors = new Map();
        for (const current of [a, b]) {
            persistence.enqueue(current.open);
            for (const [owner, kind, count] of [
                [current.peers[0], 'peer', current === a ? STALE : 3],
                [current.instance, 'loc-rib', current === a ? STALE : 3],
                [current.peers[1], 'peer', current === a ? 2 : 0]
            ]) {
                if (!count) continue;
                const descriptor = scope(current, owner, kind);
                descriptors.set(owner, descriptor.scope);
                persistence.enqueue(descriptor);
                for (let index = 0; index < count; index++) persistence.enqueue(announce(current, owner, index, kind));
            }
        }
        // The writers were opened before seeding: no reopen/recovery can mark
        // these fresh epoch-1 paths stale merely for the sake of this fixture.
        for (const [owner, kind] of [
            [a.peers[0], 'peer'],
            [a.instance, 'loc-rib']
        ]) {
            owner.advanceRibEpoch(1, 1, kind === 'peer' ? RIB : 'loc-rib');
            persistence.enqueue(scope(a, owner, kind));
            for (let index = 30000; index < 30003; index++) persistence.enqueue(announce(a, owner, index, kind));
        }
        await persistence.fence();
        const beforeB = physical(getClientDatabasePath(dbPath, b.sourceId));
        assert.equal(beforeB.routes.length, 6);
        const summaries = async owner =>
            persistence.queryScopeSummary({ sourceId: a.sourceId, scopeId: descriptors.get(owner).id });
        for (const owner of [a.peers[0], a.instance]) {
            const before = await summaries(owner);
            assert.deepEqual([before.active, before.stale, before.total], [3, STALE, STALE + 3]);
        }
        const compactBatches = [];
        const originalPurge = persistence.purgeStaleRoutes.bind(persistence);
        persistence.purgeStaleRoutes = async (query, options) => {
            assert.equal(query.sourceId, a.sourceId);
            assert.equal(query.includeDetails, false);
            assert.deepEqual(options, { fence: false });
            const result = await originalPurge(query, options);
            assert.equal(Object.hasOwn(result, 'routes'), false);
            assert.equal(Object.hasOwn(result, 'deltas'), false);
            compactBatches.push({ scopeId: query.scopeId, purged: result.purged });
            return result;
        };
        const client = a.session.getClientInfo();
        await worker.purgeStaleBgpRoutes('peer-cleanup', {
            client,
            session: a.peers[0].getSessionInfo(),
            af: getAddrFamilyType(1, 1),
            ribType: RIB
        });
        assert.deepEqual(
            [...(await summaries(a.peers[0])).scopes].map(item => [item.active, item.stale]),
            [[3, 0]]
        );
        assert.equal((await summaries(a.instance)).stale, STALE, 'peer cleanup cannot delete the Loc-RIB scope');
        await worker.purgeStaleBgpInstanceRoutes('instance-cleanup', {
            client,
            instance: { ...a.instance.getInstanceInfo(), persistentScopeId: descriptors.get(a.instance).id }
        });
        worker.flushRouteUpdateEvents();
        assert.deepEqual(responses, [
            { id: 'peer-cleanup', status: 'success', data: { deleted: STALE } },
            { id: 'instance-cleanup', status: 'success', data: { deleted: STALE } }
        ]);
        assert.deepEqual(
            compactBatches.map(item => item.purged),
            [20000, 3, 20000, 3]
        );
        for (const [owner, type] of [
            [a.peers[0], BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE],
            [a.instance, BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE]
        ]) {
            const updates = events.filter(event => event.type === type).flatMap(event => event.payload.data.updates);
            assert.equal(
                updates.reduce((total, update) => total + update.changedCount, 0),
                STALE
            );
            assert.ok(
                updates.every(
                    update =>
                        update.sourceId === a.sourceId &&
                        update.scopeId === descriptors.get(owner).id &&
                        update.projectionReset
                )
            );
            const after = await summaries(owner);
            assert.deepEqual([after.active, after.stale, after.total], [3, 0, 3]);
        }
        assert.equal((await summaries(a.peers[1])).active, 2);
        assert.deepEqual(
            physical(getClientDatabasePath(dbPath, b.sourceId)),
            beforeB,
            'another writer/client must remain physically unchanged'
        );
        const afterA = physical(getClientDatabasePath(dbPath, a.sourceId));
        assert.equal(afterA.routes.length, 8);
        assert.equal(
            afterA.bmp_scope_route_counts.reduce((total, row) => total + row.route_count, 0),
            8
        );
        assert.equal(
            afterA.bmp_route_attributes.length,
            1,
            'GC must keep the shared attribute used by fresh and other-scope routes'
        );
        assert.equal(
            afterA.bmp_route_identities.length,
            5,
            'GC must retain the two shared old NLRIs still used by another scope'
        );
        assert.equal(afterA.bmp_route_payloads.length, 1);
        assert.deepEqual(afterA.foreignKeys, []);
        assert.deepEqual(errors, []);
        assert.equal(worker.staleScopePurgeTasks.size, 0);
    } finally {
        worker.clearRouteUpdateAggregation();
        await persistence.close({ suppressErrors: true });
        fs.rmSync(directory, { recursive: true, force: true });
    }
    console.log('BMP real SQLite writer-pool manual stale purge tests passed');
}

if (require.main === module)
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
module.exports = { main };
