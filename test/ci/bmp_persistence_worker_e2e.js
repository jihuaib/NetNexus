const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const BmpConst = require('../../electron/const/bmpConst');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const ProtocolProcessHost = require('../../electron/worker/core/protocolProcessHost');
const { PROTOCOL_PROCESS_SERVICES } = require('../../electron/worker/core/protocolProcessServices');
const { getAddrFamilyType } = require('../../electron/utils/bgpUtils');
const { buildScenario, parseArgs } = require('../../scripts/mockBmpClient');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(error => (error ? reject(error) : resolve(port)));
        });
    });
}

function createRequester(worker) {
    const pending = new Map();
    let sequence = 0;
    worker.on('message', message => {
        const callback = pending.get(message.messageId);
        if (!callback) {
            return;
        }
        pending.delete(message.messageId);
        if (message.status === 'success') {
            callback.resolve(message);
        } else {
            callback.reject(new Error(message.msg || 'BMP worker request failed'));
        }
    });
    worker.on('error', error => {
        pending.forEach(callback => callback.reject(error));
        pending.clear();
    });
    return (op, data = null) => {
        sequence += 1;
        const messageId = `bmp-persistence-e2e-${sequence}`;
        return new Promise((resolve, reject) => {
            pending.set(messageId, { resolve, reject });
            worker.postMessage({ messageId, op, data });
        });
    };
}

function sendScenario(port, messages, options = {}) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.setNoDelay(true);
        socket.once('error', reject);
        socket.once('connect', async () => {
            try {
                for (const message of messages) {
                    if (!socket.write(message.data)) {
                        await new Promise(drainResolve => socket.once('drain', drainResolve));
                    }
                }
                if (options.keepOpen) {
                    resolve(socket);
                } else {
                    socket.end();
                }
            } catch (error) {
                reject(error);
            }
        });
        socket.once('close', hadError => {
            if (!hadError) {
                resolve(null);
            }
        });
    });
}

async function waitForRoutes(request, minimum = 1) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const response = await request(BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTES, {
            routeState: 'all',
            pageSize: 5000
        });
        if (response.data.total >= minimum) {
            return response;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${minimum} persisted BMP routes`);
}

function withTimeout(promise, timeoutMs, message) {
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-worker-e2e-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    const port = await getFreePort();
    const worker = new ProtocolProcessHost(
        path.join(__dirname, '..', '..', 'electron', 'worker', 'bmp', 'bmpWorker.js'),
        { serviceName: PROTOCOL_PROCESS_SERVICES.BMP }
    );
    assert.notEqual(worker.pid, process.pid, 'BMP must run in an independent process');
    if (process.env.NETNEXUS_EXPECT_UTILITY_PROCESS === '1') {
        assert.equal(worker.runtimeKind, 'utility-process');
    }
    const request = createRequester(worker);
    let offlineClient;
    let bmpSocket;
    try {
        await request(BmpConst.BMP_REQ_TYPES.START_BMP, {
            port,
            bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20,
            pathMarkingTlvType: BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING,
            persistenceEnabled: true,
            persistenceDbPath: dbPath,
            persistenceBatchSize: 64,
            persistenceFlushMs: 5,
            persistenceHighWatermarkBytes: 4 * 1024 * 1024,
            persistenceLowWatermarkBytes: 2 * 1024 * 1024
        });

        const options = parseArgs([
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--routes',
            '1',
            '--interval',
            '0',
            '--once',
            '--no-dump-packets'
        ]);
        bmpSocket = await sendScenario(port, buildScenario(options), { keepOpen: true });

        const liveStatus = await request(BmpConst.BMP_REQ_TYPES.GET_PERSISTENCE_STATUS);
        assert.equal(liveStatus.data.ready, true);
        assert.equal(liveStatus.data.journalMode, 'wal');
        const liveRoutes = await waitForRoutes(request, 10);
        assert.ok(liveRoutes.data.total > 10, `expected persisted routes, got ${liveRoutes.data.total}`);
        assert.equal(
            liveRoutes.data.list.every(route => route.persistentRouteId.length === 64),
            true
        );
        const persistedTotal = liveRoutes.data.total;

        const clients = await request(BmpConst.BMP_REQ_TYPES.GET_CLIENT_LIST);
        assert.equal(clients.data.length, 1);
        const client = clients.data[0];
        const singleClient = await request(BmpConst.BMP_REQ_TYPES.GET_CLIENT, {
            persistentSourceId: client.persistentSourceId
        });
        assert.equal(singleClient.data.persistentSourceId, client.persistentSourceId);
        assert.equal(singleClient.data.remoteIp, client.remoteIp);
        assert.equal(singleClient.data.isOnline, true);
        const peerRoute = liveRoutes.data.list.find(
            route => route.scopeKind === 'peer' && route.afi === 1 && route.safi === 1 && route.ip === '10.10.0.0'
        );
        assert.ok(peerRoute, 'expected a live IPv4 peer route');
        const sessions = await request(BmpConst.BMP_REQ_TYPES.GET_BGP_SESSIONS, client);
        const session = sessions.data.find(
            item =>
                String(item.sessionType) === String(peerRoute.peer.type) &&
                item.sessionIp === peerRoute.peer.ip &&
                String(item.sessionAs) === String(peerRoute.peer.as)
        );
        assert.ok(session, 'expected the persisted peer scope to resolve to a live session');
        const peerScopeRoutes = liveRoutes.data.list.filter(
            route => route.persistentScopeId === peerRoute.persistentScopeId
        );
        const peerRoutes = await request(BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTES, {
            client,
            session,
            af: getAddrFamilyType(peerRoute.afi, peerRoute.safi),
            ribType: peerRoute.ribType,
            page: 1,
            pageSize: 10,
            routeState: 'all',
            prefixFilter: `${peerRoute.ip}/${peerRoute.mask}`
        });
        assert.equal(peerRoutes.data.total, 1);
        assert.equal(peerRoutes.data.list[0].routeKey, peerRoute.routeKey);
        assert.equal(session.bgpRoutes, undefined, 'session API must not expose an in-memory route map');
        assert.ok(session.routeSummary.total >= peerScopeRoutes.length);

        const peerDetail = await request(BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTE_DETAIL, {
            client,
            session,
            af: getAddrFamilyType(peerRoute.afi, peerRoute.safi),
            ribType: peerRoute.ribType,
            routeKey: peerRoute.routeKey
        });
        assert.equal(peerDetail.data.persistentRouteId, peerRoute.persistentRouteId);

        const routeLens = await request(BmpConst.BMP_REQ_TYPES.GET_ROUTE_LENS, {
            query: `${peerRoute.ip}/${peerRoute.mask}`,
            routeState: 'all'
        });
        assert.ok(routeLens.data.summary.total > 0);

        const assuranceStatus = await request(BmpConst.BMP_REQ_TYPES.SET_ROUTE_ASSURANCE_ENABLED, {
            enabled: true,
            filters: { routeState: 'all' }
        });
        assert.equal(assuranceStatus.data.state, 'ready');
        const assurance = await request(BmpConst.BMP_REQ_TYPES.GET_ROUTE_ASSURANCE, {
            routeState: 'all',
            page: 1,
            pageSize: 10
        });
        assert.ok(assurance.data.summary.scannedPathCount > 0);
        await request(BmpConst.BMP_REQ_TYPES.SET_ROUTE_ASSURANCE_ENABLED, { enabled: false });

        const locRibRoute = liveRoutes.data.list.find(route => route.scopeKind === 'loc-rib');
        assert.ok(locRibRoute, 'expected a persisted Loc-RIB route');
        const instances = await request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCES, client);
        const instance = instances.data.find(
            item =>
                String(item.instanceType) === String(locRibRoute.peer.type) &&
                item.instanceRd === locRibRoute.peer.rd &&
                getAddrFamilyType(locRibRoute.afi, locRibRoute.safi) === item.addrFamilyType
        );
        assert.ok(instance, 'expected the persisted Loc-RIB scope to resolve to a live instance');
        assert.equal(instance.bgpRoutes, undefined, 'instance API must not expose an in-memory route map');
        const instanceRoutes = await request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTES, {
            client,
            instance,
            page: 1,
            pageSize: 10,
            routeState: 'all',
            prefixFilter: locRibRoute.ip
        });
        assert.ok(instanceRoutes.data.total > 0);

        const bmpSocketClosed = new Promise(resolve => bmpSocket.once('close', resolve));
        await withTimeout(
            request(BmpConst.BMP_REQ_TYPES.STOP_BMP),
            5000,
            'timed out stopping BMP worker with an active client connection'
        );
        await withTimeout(bmpSocketClosed, 2000, 'BMP worker stop did not close the active client connection');
        assert.equal(bmpSocket.destroyed, true);
        bmpSocket = null;

        await worker.terminate();

        offlineClient = new BmpPersistenceClient({ dbPath, readOnly: true });
        await offlineClient.open();
        const offlineRoutes = await offlineClient.queryRoutes({ routeState: 'all', pageSize: 5000 });
        assert.equal(offlineRoutes.total, persistedTotal);
        assert.ok((await offlineClient.queryEvents({ pageSize: 5000 })).total > persistedTotal);
        await offlineClient.close();
        offlineClient = null;

        console.log(`BMP worker persistence E2E passed: routes=${persistedTotal}`);
    } finally {
        bmpSocket?.destroy();
        await offlineClient?.close().catch(() => {});
        await worker.terminate().catch(() => {});
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = main;
