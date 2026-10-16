const assert = require('node:assert/strict');
const net = require('node:net');
const BmpConst = require('../../electron/const/bmpConst');
const BmpIngestClientPool = require('../../electron/worker/bmp/bmpIngestClientPool');
const { builders } = require('../../scripts/mockBmpClient');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpWorker = loadBmpWorkerClass(__dirname, module);
const PEER = { peerAddress: '192.0.2.2', peerAs: 65000, routerId: '192.0.2.1' };
const SYS_NAME = 'duplicate-source-router';

async function waitUntil(read, predicate, label) {
    const deadline = Date.now() + 5000;
    let latest;
    while (Date.now() < deadline) {
        latest = read();
        if (predicate(latest)) return latest;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(label);
}

function routeMessage(prefix, nextHop) {
    return builders.routeMonitoringMessage(PEER, builders.ipv4Update([prefix], { nextHop }));
}

function connectionMessages(sysName, nextHop) {
    return Buffer.concat([
        builders.initiationMessage({ sysName }),
        builders.bmpMessage(BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, builders.peerUpPayload(PEER)),
        routeMessage('203.0.113.0', nextHop),
        builders.routeMonitoringMessage(PEER, builders.endOfRibUpdate())
    ]);
}

function hasNextHop(mutation, nextHop) {
    return Boolean(mutation?.route?.attrJson && JSON.parse(mutation.route.attrJson).nextHop === nextHop);
}

async function checkDuplicateAdmission(usePool) {
    const mutations = [];
    const events = [];
    const routeUpdates = [];
    const sweeps = [];
    const invalidations = [];
    const failures = [];
    const results = [];
    const sockets = new Set();
    const endpoints = [];
    const worker = Object.create(BmpWorker.prototype);
    Object.assign(worker, {
        bmpSessionMap: new Map(),
        clientDeleteRemoteIpGates: new Map(),
        bmpConfigData: { threadCount: 3 },
        clientInitializationTimeoutMs: 5000,
        messageHandler: {
            sendEvent(eventName, data) {
                events.push({ eventName, data });
            }
        },
        enqueuePersistenceMutation(mutation) {
            mutations.push(mutation);
            return true;
        },
        enqueueRouteUpdateEvent: update => routeUpdates.push(update),
        enqueueInstanceRouteUpdateEvent: update => routeUpdates.push(update),
        invalidateRouteAssurance: reason => invalidations.push(reason),
        requestPersistenceSweep(sourceId) {
            sweeps.push(sourceId);
            return true;
        },
        handlePersistenceFailure: error => failures.push(error)
    });
    const pool = usePool
        ? new BmpIngestClientPool({
              threadCount: 3,
              onResult(record, result) {
                  results.push({ remotePort: record.session.remotePort, actions: result.actions });
                  worker.handleIngestResult(record, result);
              },
              onClosed: record => worker.handleIngestClosed(record),
              onError: error => failures.push(error)
          })
        : {
              async open() {},
              async fence() {},
              async close() {},
              getStatus: () => ({ activeClientCount: worker.bmpSessionMap.size })
          };
    await pool.open();
    if (usePool) worker.ingestPool = pool;
    const server = net.createServer(socket => worker.attachClientSocket(socket, 'tcp', endpoints.shift()));
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const connect = async remoteIp => {
        endpoints.push(remoteIp ? { remoteAddress: remoteIp } : {});
        const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
        socket.setNoDelay(true);
        socket.on('error', () => {});
        sockets.add(socket);
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        const session = await waitUntil(
            () => Array.from(worker.bmpSessionMap.values()).find(item => item.remotePort === socket.localPort),
            value => Boolean(value),
            'accepted TCP connection did not acquire a session'
        );
        return { socket, session };
    };
    const waitForMutation = (session, predicate, label) =>
        waitUntil(
            () => mutations.filter(mutation => mutation.connection?.id === session.persistenceConnectionId),
            predicate,
            label
        );
    try {
        const pending = await connect();
        const owner = await connect();
        owner.socket.write(connectionMessages(SYS_NAME, '192.0.2.11'));
        await waitForMutation(
            owner.session,
            rows => rows.some(row => hasNextHop(row, '192.0.2.11')),
            'the first initialized connection did not ingest its route'
        );
        await pool.fence();
        const sourceId = owner.session.getPersistentSourceId();
        assert.ok(sourceId);
        if (usePool) {
            assert.ok(
                pending.session.persistenceConnectionGeneration < owner.session.persistenceConnectionGeneration,
                'the earlier TCP connection must not reserve an unannounced source identity'
            );
        }
        const beforeDuplicate = {
            mutations: mutations.length,
            events: events.length,
            routeUpdates: routeUpdates.length,
            sweeps: sweeps.length,
            invalidations: invalidations.length
        };
        pending.session.recvMsg(connectionMessages(SYS_NAME, '192.0.2.99'));
        await waitUntil(() => pending.socket.destroyed, Boolean, 'duplicate BMP source was not disconnected');
        await waitUntil(
            () => pool.getStatus().activeClientCount,
            count => count === 1,
            'duplicate close acknowledgement did not release its parser slot'
        );
        await pool.fence();
        const afterDuplicate = {
            mutations: mutations.length,
            events: events.length,
            routeUpdates: routeUpdates.length,
            sweeps: sweeps.length,
            invalidations: invalidations.length
        };
        for (const [kind, count] of Object.entries(beforeDuplicate)) {
            if (!usePool && kind === 'invalidations') continue;
            assert.equal(afterDuplicate[kind], count, `a rejected source must not publish ${kind}`);
        }
        assert.equal(owner.socket.destroyed, false, 'rejecting a duplicate must preserve the first initialized feed');
        assert.equal(worker.bmpSessionMap.size, 1);
        if (usePool) {
            assert.ok(
                results.some(
                    result =>
                        result.remotePort === pending.session.remotePort &&
                        result.actions.some(action => action.eventName === BmpConst.BMP_EVT_TYPES.INITIATION) &&
                        result.actions.some(action => hasNextHop(action.mutation, '192.0.2.99'))
                ),
                'the fixture must include Init and a route in one rejected parser batch'
            );
        }

        owner.socket.write(routeMessage('203.0.114.0', '192.0.2.12'));
        await waitForMutation(
            owner.session,
            rows => rows.some(row => row.route?.prefix === '203.0.114.0'),
            'the accepted feed stopped ingesting after rejecting its duplicate'
        );
        const other = await connect();
        other.socket.write(connectionMessages('independent-source-router', '192.0.2.22'));
        await waitForMutation(
            other.session,
            rows => rows.some(row => hasNextHop(row, '192.0.2.22')),
            'a distinct BMP source must remain admissible'
        );
        assert.notEqual(other.session.getPersistentSourceId(), sourceId);
        assert.equal(pool.getStatus().activeClientCount, 2);
        const sameNameOtherAddress = await connect('192.0.2.100');
        sameNameOtherAddress.socket.write(connectionMessages(SYS_NAME, '192.0.2.44'));
        await waitForMutation(
            sameNameOtherAddress.session,
            rows => rows.some(row => hasNextHop(row, '192.0.2.44')),
            'the same sysName at a different source address must remain admissible'
        );
        assert.notEqual(sameNameOtherAddress.session.getPersistentSourceId(), sourceId);
        assert.equal(pool.getStatus().activeClientCount, 3);

        owner.socket.end();
        await waitForMutation(
            owner.session,
            rows => rows.some(row => row.eventType === 'connection_close'),
            'the accepted owner did not persist its disconnect'
        );
        await waitUntil(
            () => pool.getStatus().activeClientCount,
            count => count === 2,
            'the accepted owner did not release its parser slot'
        );
        const replacement = await connect();
        replacement.socket.write(connectionMessages(SYS_NAME, '192.0.2.33'));
        await waitForMutation(
            replacement.session,
            rows => rows.some(row => hasNextHop(row, '192.0.2.33')),
            'the same source could not reconnect after its owner disconnected'
        );
        assert.notEqual(replacement.socket.localPort, owner.session.remotePort);
        assert.equal(replacement.session.getPersistentSourceId(), sourceId);
        assert.notEqual(replacement.session.persistenceConnectionId, owner.session.persistenceConnectionId);
        assert.equal(other.socket.destroyed, false, 'reconnecting one source must not interrupt another');
        assert.equal(sameNameOtherAddress.socket.destroyed, false);
        assert.equal(pool.getStatus().activeClientCount, 3);
        assert.equal(
            events.filter(event => event.eventName === BmpConst.BMP_EVT_TYPES.INITIATION).length,
            4,
            'only accepted connections may publish Initiation events'
        );
        assert.deepEqual(failures, []);
    } finally {
        for (const session of worker.bmpSessionMap.values()) worker.clearClientInitializationTimer(session);
        for (const socket of sockets) socket.destroy();
        await pool.close();
        await new Promise(resolve => server.close(resolve));
    }
}

function checkPreInitiationDuplicate() {
    const mutations = [];
    const events = [];
    const routeUpdates = [];
    const sweeps = [];
    const worker = Object.create(BmpWorker.prototype);
    Object.assign(worker, {
        bmpSessionMap: new Map(),
        clientDeleteRemoteIpGates: new Map(),
        messageHandler: { sendEvent: (eventName, data) => events.push({ eventName, data }) },
        enqueuePersistenceMutation(mutation) {
            mutations.push(mutation);
            return true;
        },
        enqueueRouteUpdateEvent: update => routeUpdates.push(update),
        enqueueInstanceRouteUpdateEvent: update => routeUpdates.push(update),
        invalidateRouteAssurance() {},
        requestPersistenceSweep(sourceId) {
            sweeps.push(sourceId);
            return true;
        }
    });
    const createSession = remotePort =>
        worker.createBmpSession(
            {
                localAddress: '127.0.0.1',
                localPort: 11019,
                destroyed: false,
                destroy() {
                    this.destroyed = true;
                }
            },
            '192.0.2.10',
            remotePort
        );
    const bytes = Buffer.concat([
        builders.bmpMessage(BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, builders.peerUpPayload(PEER)),
        routeMessage('203.0.113.0', '192.0.2.11')
    ]);
    const owner = createSession(50001);
    owner.recvMsg(bytes);
    assert.ok(mutations.some(mutation => hasNextHop(mutation, '192.0.2.11')));
    const beforeDuplicate = [mutations.length, events.length, routeUpdates.length, sweeps.length];
    const duplicate = createSession(50002);
    const duplicateSocket = duplicate.socket;
    duplicate.recvMsg(bytes);
    assert.equal(duplicateSocket.destroyed, true, 'pre-Initiation traffic must still enforce source admission');
    assert.deepEqual(
        [mutations.length, events.length, routeUpdates.length, sweeps.length],
        beforeDuplicate,
        'a rejected Peer Up before Initiation must not publish mutations or peer/route events'
    );
    assert.equal(owner.socket.destroyed, false);
    assert.equal(worker.bmpSessionMap.size, 1);
    worker.removeBmpSessionByKey('127.0.0.1|11019|192.0.2.10|50001', owner);
}

async function main() {
    await checkDuplicateAdmission(true);
    await checkDuplicateAdmission(false);
    checkPreInitiationDuplicate();
    console.log('BMP duplicate-source admission passed: parser/direct ownership, batch isolation and reconnect');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
