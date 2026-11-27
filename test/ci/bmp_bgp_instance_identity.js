const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BmpConst = require('../../electron/const/bmpConst');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpIngestClientPool = require('../../electron/worker/bmp/bmpIngestClientPool');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const { buildConnectionMutation } = require('../../electron/worker/bmp/bmpPersistenceMutation');
const { createIngestSnapshot, applyIngestSnapshot } = require('../../electron/worker/bmp/bmpIngestSnapshot');
const { createSourceKey } = require('../../electron/utils/bmp/bmpPersistentRouteKey');
const { getInitiationBgpInstanceName, parseCommonHeader, parseBmpTlvs } = require('../../electron/utils/bmp/bmpUtils');
const { builders } = require('../../scripts/mockBmpClient');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpWorker = loadBmpWorkerClass(__dirname, module);
const REMOTE_IP = '192.168.56.131';
const LEGACY_SOURCE_ID = '6ba87974e0d60b26e501562b01fad3abc4f3bda2c786760eff7148f03cc00216';
// The complete 205-byte BMP frame captured from H3C, excluding Ethernet/IP/TCP headers.
const H3C_INITIATION = Buffer.from(
    '03000000cd040001009f48334320436f6d7761726520506c6174666f726d20536f6674776172652c20' +
        '536f6674776172652056657273696f6e20392e312e3035382c20416c70686120373137302020483343' +
        '2053696d7761726536342020436f707972696768742028632920323030342d32303236204e65772048' +
        '334320546563686e6f6c6f6769657320436f2e2c204c74642e20416c6c2072696768747320726573' +
        '65727665642e000200034833430000001962677020696e7374616e6365206e616d653a64656661756c74',
    'hex'
);

function stringTlv(type, text) {
    const value = Buffer.from(text);
    const header = Buffer.alloc(4);
    header.writeUInt16BE(type, 0);
    header.writeUInt16BE(value.length, 2);
    return Buffer.concat([header, value]);
}

function initiation(instanceName, extraStrings = []) {
    return builders.bmpMessage(
        BmpConst.BMP_MSG_TYPE.INITIATION,
        Buffer.concat([
            stringTlv(1, 'H3C Comware Platform Software'),
            stringTlv(2, 'H3C'),
            ...extraStrings.map(text => stringTlv(0, text)),
            ...(instanceName === null ? [] : [stringTlv(0, `bgp instance name:${instanceName}`)])
        ])
    );
}

function standaloneSession(remotePort = 50001) {
    const mutations = [];
    const events = [];
    const session = new BmpSession(
        { sendEvent: (eventName, data) => events.push({ eventName, data }) },
        { enqueuePersistenceMutation: mutation => (mutations.push(mutation), true) }
    );
    Object.assign(session, { localIp: '127.0.0.1', localPort: 11019, remoteIp: REMOTE_IP, remotePort });
    return { session, mutations, events };
}

function checkFixtureAndSourceKeys() {
    assert.equal(H3C_INITIATION.length, 205);
    assert.deepEqual(parseCommonHeader(H3C_INITIATION), {
        valid: true,
        version: 3,
        length: 205,
        type: BmpConst.BMP_MSG_TYPE.INITIATION
    });
    const originalTlvs = parseBmpTlvs(H3C_INITIATION.subarray(6));
    assert.deepEqual(originalTlvs.warnings, []);
    assert.equal(getInitiationBgpInstanceName(originalTlvs.tlvs), 'default');
    assert.deepEqual(
        originalTlvs.tlvs.map(tlv => tlv.type),
        [1, 2, 0]
    );
    assert.match(originalTlvs.tlvs[0].value.toString(), /^H3C Comware Platform Software/);
    assert.equal(originalTlvs.tlvs[1].value.toString(), 'H3C');
    assert.equal(originalTlvs.tlvs[2].value.toString(), 'bgp instance name:default');

    const source = { sysName: 'H3C', sourceAddress: REMOTE_IP };
    assert.equal(createSourceKey(source).keyHex, LEGACY_SOURCE_ID, 'unnamed sources retain their historical hash');
    for (const bgpInstanceName of [undefined, null]) {
        assert.equal(createSourceKey({ ...source, bgpInstanceName }).keyHex, LEGACY_SOURCE_ID);
    }
    const keys = ['default', 'test1', 'test2', 'Test1'].map(
        bgpInstanceName => createSourceKey({ ...source, bgpInstanceName }).keyHex
    );
    assert.equal(new Set(keys).size, 4, 'actual instance names are dynamic and case-sensitive');
    assert.ok(keys.every(key => key !== LEGACY_SOURCE_ID));
    assert.equal(
        createSourceKey({ ...source, bgpInstanceName: 'test1', remotePort: 50001 }).keyHex,
        createSourceKey({ ...source, bgpInstanceName: 'test1', remotePort: 60001 }).keyHex,
        'the TCP source port must not participate in BGP process identity'
    );

    const { session, mutations } = standaloneSession();
    session.recvMsg(H3C_INITIATION);
    assert.equal(session.bmpVersion, BmpConst.BMP_VERSION.V3);
    assert.equal(session.bgpInstanceName, 'default');
    assert.equal(session.getClientInfo().bgpInstanceName, 'default');
    assert.equal(mutations.find(row => row.eventType === 'connection_open').source.metadata.bgpInstanceName, 'default');
    assert.equal(session.getPersistentSourceId(), keys[0], 'instance information must precede source admission');
    const mirror = standaloneSession(50002).session;
    applyIngestSnapshot(mirror, createIngestSnapshot(session));
    assert.equal(mirror.bgpInstanceName, 'default');
    assert.equal(mirror.getPersistentSourceId(), session.getPersistentSourceId());

    for (const text of ['arbitrary vendor description', 'prefix bgp instance name:test1']) {
        const plain = standaloneSession().session;
        plain.recvMsg(initiation(null, [text]));
        assert.equal(plain.bgpInstanceName, null);
        assert.equal(
            plain.getPersistentSourceId(),
            LEGACY_SOURCE_ID,
            'free-form TLV 0 strings are not source identity'
        );
    }
    const repeated = standaloneSession().session;
    repeated.recvMsg(initiation('test1', ['bgp instance name:test1']));
    assert.equal(repeated.bgpInstanceName, 'test1');
    const conflicting = standaloneSession();
    conflicting.session.recvMsg(initiation('test1', ['bgp instance name:test2']));
    assert.equal(
        conflicting.session.getPersistentSourceId(),
        null,
        'conflicting process identities must not be admitted'
    );
    assert.equal(conflicting.mutations.length, 0);
    assert.equal(conflicting.events.length, 0);

    const preInitMessage = builders.bmpMessage(
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        builders.peerUpPayload({ peerAddress: '192.0.2.2', peerAs: 65000, routerId: '192.0.2.1' })
    );
    const plainBeforeInit = standaloneSession();
    plainBeforeInit.session.recvMsg(preInitMessage);
    const plainSourceId = plainBeforeInit.session.getPersistentSourceId();
    plainBeforeInit.session.recvMsg(initiation(null, ['ordinary Init metadata']));
    assert.equal(plainBeforeInit.session.getPersistentSourceId(), plainSourceId);
    assert.equal(plainBeforeInit.session.persistenceConnectionClosed, false);
    assert.equal(plainBeforeInit.session.sysName, 'H3C', 'ordinary late Init preserves pre-Initiation compatibility');

    const beforeInit = standaloneSession();
    beforeInit.session.recvMsg(preInitMessage);
    const pinnedSourceId = beforeInit.session.getPersistentSourceId();
    assert.ok(pinnedSourceId, 'pre-Initiation Peer Up remains accepted');
    const beforeLateInit = beforeInit.mutations.length;
    beforeInit.session.recvMsg(initiation('test1'));
    assert.equal(beforeInit.session.bgpInstanceName, null, 'late process metadata requires a fresh connection');
    assert.equal(
        beforeInit.session.getPersistentSourceId(),
        pinnedSourceId,
        'late metadata must not silently rekey a feed'
    );
    assert.equal(beforeInit.session.persistenceConnectionClosed, true);
    assert.ok(beforeInit.mutations.slice(beforeLateInit).every(row => row.eventType === 'connection_close'));
}

function checkConfiguredExtraction() {
    const tlv = (type, text, enterprise = false) => ({ type, value: Buffer.from(text), enterprise });
    const customConfig = {
        sourceInstanceTemplate: 'custom',
        sourceInstanceTlvType: 5,
        sourceInstanceCustomTemplate: 'instance={instance}'
    };
    for (const instance of ['test1', 'test2']) {
        assert.equal(
            getInitiationBgpInstanceName(
                [tlv(0, 'bgp instance name:default'), tlv(5, `instance=${instance}`)],
                customConfig
            ),
            instance
        );
    }
    assert.equal(getInitiationBgpInstanceName([tlv(0, 'instance=test1')], customConfig), null);
    assert.equal(getInitiationBgpInstanceName([tlv(5, 'unrelated text')], customConfig), null);
    assert.equal(getInitiationBgpInstanceName([tlv(5, 'instance=test1', true)], customConfig), null);
    assert.equal(
        getInitiationBgpInstanceName([tlv(5, '[process.test2]')], {
            ...customConfig,
            sourceInstanceCustomTemplate: '[process.{instance}]'
        }),
        'test2',
        'custom template punctuation must be treated literally'
    );
    const fullValueConfig = { sourceInstanceTemplate: 'fullValue', sourceInstanceTlvType: 5 };
    assert.equal(getInitiationBgpInstanceName([tlv(5, '  test2  ')], fullValueConfig), 'test2');
    assert.equal(getInitiationBgpInstanceName([tlv(5, '   ')], fullValueConfig), null);
    assert.equal(getInitiationBgpInstanceName([tlv(0, 'test1')], fullValueConfig), null);
    assert.equal(
        getInitiationBgpInstanceName([tlv(5, '  enterprise-process  ', true)], {
            ...fullValueConfig,
            sourceInstanceTlvType: 0x8005
        }),
        'enterprise-process',
        'enterprise TLVs participate only when their full raw type is explicitly configured'
    );
}

class FixtureSocket extends EventEmitter {
    constructor(remotePort) {
        super();
        Object.assign(this, {
            localAddress: '127.0.0.1',
            localPort: 11019,
            remoteAddress: REMOTE_IP,
            remotePort,
            destroyed: false
        });
    }

    destroy() {
        this.destroyed = true;
    }

    pause() {}
    resume() {}
}

function workerFixture() {
    const mutations = [];
    const events = [];
    const failures = [];
    const worker = Object.create(BmpWorker.prototype);
    Object.assign(worker, {
        bmpSessionMap: new Map(),
        clientDeleteRemoteIpGates: new Map(),
        bmpConfigData: { threadCount: 4 },
        messageHandler: { sendEvent: (eventName, data) => events.push({ eventName, data }) },
        enqueuePersistenceMutation: mutation => (mutations.push(mutation), true),
        enqueueRouteUpdateEvent() {},
        enqueueInstanceRouteUpdateEvent() {},
        invalidateRouteAssurance() {},
        requestPersistenceSweep: () => true,
        handlePersistenceFailure: error => failures.push(error)
    });
    return { worker, mutations, events, failures };
}

async function checkAdmission(usePool) {
    const { worker, mutations, events, failures } = workerFixture();
    const snapshots = [];
    const pool = usePool
        ? new BmpIngestClientPool({
              threadCount: 4,
              onResult(record, result) {
                  snapshots.push(result.snapshot);
                  worker.handleIngestResult(record, result);
              },
              onClosed: record => worker.handleIngestClosed(record),
              onError: error => failures.push(error)
          })
        : null;
    if (pool) {
        await pool.open();
        worker.ingestPool = pool;
    }
    let nextPort = 50000;
    const attach = () => worker.attachClientSocket(new FixtureSocket(++nextPort), 'tcp');
    const receive = async (session, message) => {
        session.recvMsg(message);
        await pool?.fence();
        // Admission can enqueue a close after the barrier was already sent.
        if (session.sourceAdmissionRejected) await pool?.fence();
    };
    const remove = async session => {
        worker.removeBmpSessionByKey(
            BmpSession.makeKey(session.localIp, session.localPort, session.remoteIp, session.remotePort),
            session
        );
        await pool?.fence();
    };
    try {
        const defaultFeed = attach();
        await receive(defaultFeed, H3C_INITIATION);
        const test1 = attach();
        await receive(test1, initiation('test1'));
        const test2 = attach();
        await receive(test2, initiation('test2'));
        assert.equal(worker.bmpSessionMap.size, 3, 'one device may open feeds for default, test1 and test2');
        assert.equal(new Set([defaultFeed, test1, test2].map(feed => feed.getPersistentSourceId())).size, 3);
        for (const feed of [defaultFeed, test1, test2]) assert.equal(feed.socket.destroyed, false);
        const beforeDuplicate = [mutations.length, events.length];
        const duplicate = attach();
        const duplicateSocket = duplicate.socket;
        await receive(duplicate, initiation('test1', ['different free-form string']));
        assert.equal(duplicate.sourceAdmissionRejected, true);
        assert.equal(duplicateSocket.destroyed, true);
        assert.deepEqual([mutations.length, events.length], beforeDuplicate, 'rejected feeds must publish no state');
        assert.equal(test1.socket.destroyed, false, 'rejecting a duplicate must preserve the accepted process feed');
        const caseVariant = attach();
        await receive(caseVariant, initiation('Test1'));
        assert.equal(caseVariant.bgpInstanceName, 'Test1');
        assert.notEqual(caseVariant.getPersistentSourceId(), test1.getPersistentSourceId());
        const sourceId = defaultFeed.getPersistentSourceId();
        const connectionId = defaultFeed.persistenceConnectionId;
        await remove(defaultFeed);
        const replacement = attach();
        await receive(replacement, initiation('default', ['metadata may change on reconnect']));
        assert.notEqual(replacement.remotePort, defaultFeed.remotePort);
        assert.equal(replacement.getPersistentSourceId(), sourceId);
        assert.notEqual(replacement.persistenceConnectionId, connectionId);
        assert.equal(worker.bmpSessionMap.size, 4);
        if (pool) {
            assert.ok(snapshots.some(snapshot => snapshot.session.bgpInstanceName === 'test2'));
            assert.equal(test2.getClientInfo().bgpInstanceName, 'test2', 'worker snapshots retain process metadata');
        }
        assert.deepEqual(failures, []);
    } finally {
        for (const session of Array.from(worker.bmpSessionMap.values())) await remove(session);
        await pool?.close();
    }
}

async function checkConfiguredIngest() {
    const { worker, mutations, failures } = workerFixture();
    const config = {
        sourceInstanceTemplate: 'custom',
        sourceInstanceTlvType: 5,
        sourceInstanceCustomTemplate: 'instance={instance}'
    };
    worker.bmpConfigData = { ...worker.bmpConfigData, ...config };
    const pool = new BmpIngestClientPool({
        threadCount: 1,
        config,
        onResult: (record, result) => worker.handleIngestResult(record, result),
        onClosed: record => worker.handleIngestClosed(record),
        onError: error => failures.push(error)
    });
    try {
        await pool.open();
        worker.ingestPool = pool;
        const session = worker.attachClientSocket(new FixtureSocket(52000), 'tcp');
        session.recvMsg(
            builders.bmpMessage(
                BmpConst.BMP_MSG_TYPE.INITIATION,
                Buffer.concat([
                    stringTlv(1, 'H3C Comware Platform Software'),
                    stringTlv(2, 'H3C'),
                    stringTlv(0, 'bgp instance name:default'),
                    stringTlv(5, 'instance=test1')
                ])
            )
        );
        await pool.fence();
        assert.equal(session.bgpInstanceName, 'test1', 'the configured type and template must reach the parser worker');
        assert.equal(
            session.getPersistentSourceId(),
            createSourceKey({ sysName: 'H3C', sourceAddress: REMOTE_IP, bgpInstanceName: 'test1' }).keyHex
        );
        assert.equal(
            mutations.find(row => row.eventType === 'connection_open').source.metadata.bgpInstanceName,
            'test1'
        );
        assert.deepEqual(failures, []);
    } finally {
        for (const session of worker.bmpSessionMap.values()) worker.clearClientInitializationTimer(session);
        await pool.close();
    }
}

async function checkPersistedTopology() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-process-identity-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    let store;
    let client;
    try {
        const feeds = ['default', 'test1', 'test2'].map((name, index) => {
            const fixture = standaloneSession(51000 + index);
            fixture.session.recvMsg(initiation(name));
            const peer = { peerAddress: '192.0.2.2', peerAs: 65000, routerId: '192.0.2.1' };
            fixture.session.recvMsg(
                Buffer.concat([
                    builders.bmpMessage(BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, builders.peerUpPayload(peer)),
                    builders.routeMonitoringMessage(
                        peer,
                        builders.ipv4Update(['203.0.113.0'], { nextHop: `192.0.2.${10 + index}` })
                    ),
                    builders.routeMonitoringMessage(peer, builders.endOfRibUpdate())
                ])
            );
            return fixture;
        });
        store = new BmpPersistenceStore({ dbPath }).open();
        store.applyBatch({ batchId: 'process-identities-open', mutations: feeds.flatMap(feed => feed.mutations) });
        assert.equal(store.queryTopology().sourceCount, 3);
        assert.deepEqual(
            new Set(store.queryTopology().clients.map(client => client.bgpInstanceName)),
            new Set(['default', 'test1', 'test2'])
        );
        feeds.forEach(({ session }, index) => {
            const routes = store.queryRoutes({ sourceId: session.getPersistentSourceId(), routeState: 'all' });
            assert.equal(routes.total, 1, 'the same peer and prefix in other BGP processes must remain isolated');
            assert.equal(routes.list[0].nextHop, `192.0.2.${10 + index}`);
            assert.equal(routes.list[0].source.bgpInstanceName, session.bgpInstanceName);
        });
        for (const lean of [false, true]) {
            const streamed = [];
            store.streamRouteAssuranceRows({ routeState: 'all', lean, chunkSize: 1 }, chunk => streamed.push(...chunk));
            assert.equal(streamed.length, 3);
            for (const { session } of feeds) {
                const route = streamed.find(row => row.persistentSourceId === session.getPersistentSourceId());
                assert.ok(route, `the ${lean ? 'lean' : 'full'} stream must retain every BGP process`);
                assert.equal(route.source.bgpInstanceName, session.bgpInstanceName);
            }
        }
        const closeMutations = feeds.map(({ session }) => buildConnectionMutation(session, 'connection_close'));
        store.applyBatch({ batchId: 'process-identities-close', mutations: closeMutations });
        store.close();
        store = new BmpPersistenceStore({ dbPath }).open();
        const restored = store.queryTopology();
        assert.equal(restored.sourceCount, 3);
        for (const { session } of feeds) {
            const restoredClient = restored.clients.find(client => client.sourceId === session.getPersistentSourceId());
            assert.ok(restoredClient);
            assert.equal(restoredClient.bgpInstanceName, session.bgpInstanceName);
            assert.equal(restoredClient.sysName, 'H3C');
            assert.equal(restoredClient.isOnline, false);
        }
        store.close();
        store = null;
        client = new BmpPersistenceClient({ dbPath, readOnly: true });
        await client.open();
        const fromWorker = await client.queryTopology({ sourceId: feeds[1].session.getPersistentSourceId() });
        assert.equal(fromWorker.clients.length, 1);
        assert.equal(fromWorker.clients[0].bgpInstanceName, 'test1');
        assert.equal(fromWorker.clients[0].isOnline, false);
    } finally {
        await client?.close({ suppressErrors: true }).catch(() => {});
        store?.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function main() {
    checkFixtureAndSourceKeys();
    checkConfiguredExtraction();
    await checkAdmission(false);
    await checkAdmission(true);
    await checkConfiguredIngest();
    await checkPersistedTopology();
    console.log(
        'BMP BGP process identity passed: H3C Init, admission, reconnect, worker snapshots and offline topology'
    );
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
