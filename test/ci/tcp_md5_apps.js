const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const BmpApp = require('../../electron/app/bmpApp');
const RpkiApp = require('../../electron/app/rpkiApp');
const BmpConst = require('../../electron/const/bmpConst');
const RpkiConst = require('../../electron/const/rpkiConst');
const logger = require('../../electron/log/logger');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');
const RpkiWorker = require('../../electron/worker/rpki/rpkiWorker');
const TcpAuthForwardingServer = require('../../electron/worker/core/tcpAuthForwardingServer');
const { buildSource } = require('../../electron/worker/bmp/bmpPersistenceMutation');
const { BMP_AUTH_TYPES, RPKI_AUTH_TYPES } = require('../../electron/utils/tcpAuthConfig');

const BmpWorker = loadBmpWorkerClass(__dirname, module);

class MemoryStore {
    constructor(initial = {}) {
        this.values = new Map(Object.entries(initial));
    }

    get(key) {
        return this.values.get(key);
    }

    set(key, value) {
        this.values.set(key, JSON.parse(JSON.stringify(value)));
    }
}

class FakeIpcMain {
    constructor() {
        this.handlers = new Map();
    }

    handle(name, handler) {
        this.handlers.set(name, handler);
    }
}

class FakeCredentialStore {
    constructor() {
        this.initializationCalls = 0;
    }

    async initialize() {
        this.initializationCalls += 1;
    }

    isAvailable() {
        return true;
    }

    encrypt(value) {
        return `encrypted:${Buffer.from(value, 'utf8').toString('base64')}`;
    }

    decrypt(value) {
        assert.match(value, /^encrypted:/);
        return Buffer.from(value.slice('encrypted:'.length), 'base64').toString('utf8');
    }
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function md5Profile(overrides = {}) {
    return {
        id: 'md5-router-a',
        name: 'MD5 Router A',
        peer: '192.0.2.1/32',
        key: 'settings-owned-md5-secret',
        ...overrides
    };
}

function aoProfile(overrides = {}) {
    return {
        id: 'ao-router-a',
        name: 'AO Router A',
        peer: '198.51.100.1/32',
        keys: [
            {
                id: 'ao-key-a',
                algorithm: 'hmac(sha1)',
                sndId: 1,
                rcvId: 1,
                macLength: 12,
                key: 'settings-owned-ao-secret',
                acceptStart: null,
                sendStart: null,
                sendEnd: null,
                acceptEnd: null
            }
        ],
        ...overrides
    };
}

function createFakeProtocolClient(startOperation, stopOperation) {
    const calls = [];
    const listeners = new Map();
    const client = {
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(handler);
        },
        removeEventListener(type, handler) {
            listeners.get(type)?.delete(handler);
        },
        async sendRequest(operation, payload) {
            calls.push({ operation, payload });
            if (operation === startOperation) return { status: 'success', data: null, msg: 'started' };
            if (operation === stopOperation) return { status: 'success', data: null, msg: 'stopped' };
            throw new Error(`unexpected operation: ${operation}`);
        },
        async terminate() {}
    };
    return { client, calls, listeners };
}

async function captureInfoLogs(operation) {
    const messages = [];
    const originalInfo = logger.info;
    logger.info = (...args) => messages.push(args);
    try {
        return { result: await operation(), messages };
    } finally {
        logger.info = originalInfo;
    }
}

async function testBmpMainBoundary() {
    const store = new MemoryStore();
    const credentialStore = new FakeCredentialStore();
    const app = new BmpApp(new FakeIpcMain(), store, { credentialStore, platform: 'linux' });
    app.closeOfflinePersistenceReader = async () => {};
    app.getTcpMd5SettingsStore().saveSettings({ profiles: [md5Profile()] });

    const validConfig = {
        port: 11019,
        bmpV4TlvDraft: 20,
        pathMarkingTlvType: 8,
        authType: BMP_AUTH_TYPES.TCP_MD5,
        tcpMd5ProfileIds: ['md5-router-a']
    };
    const saved = await app.handleSaveBmpConfig(null, validConfig);
    assert.equal(saved.status, 'success', saved.msg);
    const persisted = clone(store.get('bmp-config'));
    assert.deepEqual(persisted.tcpMd5ProfileIds, ['md5-router-a']);
    assert.equal(JSON.stringify(persisted).includes('settings-owned-md5-secret'), false);

    const rejected = await app.handleSaveBmpConfig(null, {
        ...validConfig,
        tcpMd5ProfileIds: ['md5-router-a', 'missing-md5-router']
    });
    assert.equal(rejected.status, 'error');
    assert.match(rejected.msg, /TCP MD5.*不存在|不存在.*TCP MD5/);
    assert.deepEqual(store.get('bmp-config'), persisted, 'a missing Profile must not replace the last BMP config');

    const fake = createFakeProtocolClient(BmpConst.BMP_REQ_TYPES.START_BMP, BmpConst.BMP_REQ_TYPES.STOP_BMP);
    app.createBmpProcess = () => fake.client;
    const { result, messages } = await captureInfoLogs(() =>
        app.handleStartBmp(null, {
            ...validConfig,
            key: 'renderer-injected-md5-secret',
            keyEncrypted: 'renderer-injected-ciphertext',
            tcpMd5Profiles: [md5Profile({ key: 'renderer-injected-runtime-secret' })]
        })
    );
    assert.equal(result.status, 'success', result.msg);
    const start = fake.calls.find(call => call.operation === BmpConst.BMP_REQ_TYPES.START_BMP);
    assert(start, 'BMP did not send a worker start request');
    assert.deepEqual(start.payload.tcpAoProfiles, []);
    assert.deepEqual(
        start.payload.tcpMd5Profiles.map(profile => profile.id),
        ['md5-router-a']
    );
    assert.equal(start.payload.tcpMd5Profiles[0].key, 'settings-owned-md5-secret');
    assert.equal(JSON.stringify(start.payload).includes('renderer-injected'), false);
    assert.equal(JSON.stringify(messages).includes('settings-owned-md5-secret'), false, 'BMP logs exposed an MD5 key');
    await app.handleStopBmp();

    const plainApp = new BmpApp(new FakeIpcMain(), new MemoryStore(), { platform: 'linux' });
    plainApp.closeOfflinePersistenceReader = async () => {};
    const plainFake = createFakeProtocolClient(BmpConst.BMP_REQ_TYPES.START_BMP, BmpConst.BMP_REQ_TYPES.STOP_BMP);
    plainApp.createBmpProcess = () => plainFake.client;
    const plainResult = await plainApp.handleStartBmp(null, {
        port: 11020,
        authType: BMP_AUTH_TYPES.NONE,
        tcpMd5Profiles: [md5Profile({ key: 'none-mode-md5-secret' })],
        tcpMd5: md5Profile({ key: 'none-mode-nested-secret' })
    });
    assert.equal(plainResult.status, 'success', plainResult.msg);
    const plainStart = plainFake.calls.find(call => call.operation === BmpConst.BMP_REQ_TYPES.START_BMP);
    assert.deepEqual(plainStart.payload.tcpMd5Profiles, []);
    assert.equal(JSON.stringify(plainStart.payload).includes('none-mode'), false);
    await plainApp.handleStopBmp();
}

async function testRpkiMainBoundary() {
    const store = new MemoryStore();
    const credentialStore = new FakeCredentialStore();
    const app = new RpkiApp(new FakeIpcMain(), store, { credentialStore, platform: 'linux' });
    app.getRpkiDatabasePath = () => '/tmp/netnexus-tcp-md5-app-test.sqlite3';
    app.getTcpMd5SettingsStore().saveSettings({ profiles: [md5Profile()] });

    const validConfig = {
        port: 18282,
        authType: RPKI_AUTH_TYPES.TCP_MD5,
        tcpMd5ProfileId: 'md5-router-a'
    };
    const saved = await app.handleSaveRpkiConfig(null, validConfig);
    assert.equal(saved.status, 'success', saved.msg);
    const persisted = clone(store.get('rpki-config'));
    assert.equal(persisted.tcpMd5ProfileId, 'md5-router-a');
    assert.equal(JSON.stringify(persisted).includes('settings-owned-md5-secret'), false);

    const rejected = await app.handleSaveRpkiConfig(null, { ...validConfig, tcpMd5ProfileId: 'missing-md5-router' });
    assert.equal(rejected.status, 'error');
    assert.match(rejected.msg, /TCP MD5.*不存在|不存在.*TCP MD5/);
    assert.deepEqual(store.get('rpki-config'), persisted, 'a missing Profile must not replace the last RPKI config');

    const fake = createFakeProtocolClient(RpkiConst.RPKI_REQ_TYPES.START_RPKI, RpkiConst.RPKI_REQ_TYPES.STOP_RPKI);
    app.createRpkiProcess = () => fake.client;
    const { result, messages } = await captureInfoLogs(() =>
        app.handleStartRpki(null, {
            ...validConfig,
            key: 'renderer-injected-md5-secret',
            keyEncrypted: 'renderer-injected-ciphertext',
            tcpMd5: md5Profile({ key: 'renderer-injected-runtime-secret' })
        })
    );
    assert.equal(result.status, 'success', result.msg);
    const start = fake.calls.find(call => call.operation === RpkiConst.RPKI_REQ_TYPES.START_RPKI);
    assert(start, 'RPKI did not send a worker start request');
    assert.equal(start.payload.tcpAo, null);
    assert.equal(start.payload.tcpMd5.id, 'md5-router-a');
    assert.equal(start.payload.tcpMd5.key, 'settings-owned-md5-secret');
    assert.equal(JSON.stringify(start.payload).includes('renderer-injected'), false);
    assert.equal(JSON.stringify(messages).includes('settings-owned-md5-secret'), false, 'RPKI logs exposed an MD5 key');
    await app.handleStopRpki();

    const aoSettingsStore = {
        store: null,
        getRuntimeProfile() {
            return clone(aoProfile());
        }
    };
    const aoApp = new RpkiApp(new FakeIpcMain(), new MemoryStore(), {
        platform: 'linux',
        tcpAoSettingsStore: aoSettingsStore
    });
    aoApp.getRpkiDatabasePath = () => '/tmp/netnexus-tcp-md5-ao-test.sqlite3';
    const aoFake = createFakeProtocolClient(RpkiConst.RPKI_REQ_TYPES.START_RPKI, RpkiConst.RPKI_REQ_TYPES.STOP_RPKI);
    aoApp.createRpkiProcess = () => aoFake.client;
    const aoResult = await aoApp.handleStartRpki(null, {
        port: 18283,
        authType: RPKI_AUTH_TYPES.TCP_AO,
        tcpAoProfileId: 'ao-router-a',
        tcpMd5: md5Profile({ key: 'ao-mode-md5-secret' })
    });
    assert.equal(aoResult.status, 'success', aoResult.msg);
    const aoStart = aoFake.calls.find(call => call.operation === RpkiConst.RPKI_REQ_TYPES.START_RPKI);
    assert.equal(aoStart.payload.tcpMd5, null);
    assert.equal(JSON.stringify(aoStart.payload).includes('ao-mode-md5-secret'), false);
    await aoApp.handleStopRpki();
}

function makeSocket() {
    const socket = new EventEmitter();
    socket.remoteAddress = '192.0.2.1';
    socket.remotePort = 49152;
    socket.localAddress = '198.51.100.10';
    socket.localPort = 1790;
    socket.destroyed = false;
    socket.destroy = () => {
        socket.destroyed = true;
    };
    socket.resume = () => {};
    return socket;
}

function testForwardingMetadata() {
    assert.throws(() => new TcpAuthForwardingServer({ authType: 'unexpected-authentication' }), /不支持的TCP认证类型/);
    const forwarding = new TcpAuthForwardingServer({ authType: 'tcp-md5', serviceName: 'BMP' });
    forwarding.listenPort = 1790;
    forwarding.profiles = [{ id: 'md5-router-a', name: 'MD5 Router A', peer: '192.0.2.1/32' }];
    const metadata = forwarding.validatePeerMetadata({
        family: 4,
        remoteAddress: '192.0.2.1',
        remotePort: 49152,
        localAddress: '198.51.100.10',
        localPort: 1790
    });
    assert.deepEqual(
        {
            authentication: metadata.authentication,
            authProfileId: metadata.authProfileId,
            authProfileName: metadata.authProfileName,
            authPeer: metadata.authPeer,
            tcpMd5ProfileId: metadata.tcpMd5ProfileId,
            tcpMd5ProfileName: metadata.tcpMd5ProfileName,
            tcpMd5Peer: metadata.tcpMd5Peer
        },
        {
            authentication: 'tcp-md5',
            authProfileId: 'md5-router-a',
            authProfileName: 'MD5 Router A',
            authPeer: '192.0.2.1/32',
            tcpMd5ProfileId: 'md5-router-a',
            tcpMd5ProfileName: 'MD5 Router A',
            tcpMd5Peer: '192.0.2.1/32'
        }
    );
    assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'tcpAoProfileId'), false);

    const bmpWorker = Object.create(BmpWorker.prototype);
    bmpWorker.bmpSessionMap = new Map();
    bmpWorker.createBmpSession = (_socket, remoteIp, remotePort, localIp, localPort) => ({
        remoteIp,
        remotePort,
        localIp,
        localPort,
        recvMsg() {}
    });
    bmpWorker.removeBmpSessionByKey = () => {};
    const bmpSession = bmpWorker.attachClientSocket(makeSocket(), 'tcp-md5', metadata);
    assert.equal(bmpSession.authentication, 'tcp-md5');
    assert.equal(bmpSession.authProfileId, 'md5-router-a');
    assert.equal(bmpSession.tcpMd5ProfileId, 'md5-router-a');
    const source = buildSource(bmpSession);
    assert.equal(source.metadata.authentication, 'tcp-md5');
    assert.equal(source.metadata.authProfileId, 'md5-router-a');
    assert.equal(source.metadata.tcpMd5ProfileId, 'md5-router-a');

    const rpkiWorker = Object.create(RpkiWorker.prototype);
    rpkiWorker.rpkiSessionMap = new Map();
    let receivedAuthentication = null;
    rpkiWorker.createRpkiSession = (_socket, _remote, _remotePort, _local, _localPort, authentication) => {
        receivedAuthentication = authentication;
        return { closed: false, recvMsg() {}, closeSession() {} };
    };
    rpkiWorker.attachClientSocket(makeSocket(), 'tcp-md5', metadata);
    assert.equal(receivedAuthentication.authentication, 'tcp-md5');
    assert.equal(receivedAuthentication.authProfileId, 'md5-router-a');
    assert.equal(receivedAuthentication.tcpMd5ProfileId, 'md5-router-a');
}

async function testWorkerForwardingLifecycle() {
    for (const [WorkerClass, configField, setConfig, startMethod] of [
        [BmpWorker, 'tcpMd5Profiles', profile => ({ port: 1790, tcpMd5Profiles: [profile] }), 'startTcpMd5Server'],
        [RpkiWorker, 'tcpMd5', profile => ({ port: 8282, tcpMd5: profile }), 'startTcpMd5Server']
    ]) {
        const worker = Object.create(WorkerClass.prototype);
        const runtimeProfile = md5Profile();
        const forwardedProfiles = [];
        let connection = null;
        let stopCalls = 0;
        const forwardingServer = {
            async start(options) {
                forwardedProfiles.push(...options.profiles.map(clone));
                connection = options.onConnection;
                options.onProfilesConsumed();
                return { listenPort: options.listenPort, families: [4] };
            },
            async stop() {
                stopCalls += 1;
            }
        };
        worker.bmpConfigData = null;
        worker.rpkiConfigData = null;
        worker[WorkerClass === BmpWorker ? 'bmpConfigData' : 'rpkiConfigData'] = setConfig(runtimeProfile);
        worker.bmpSocketsPaused = false;
        worker.persistence = null;
        worker.attachClientSocket = (_socket, transport, metadata, initialData) => {
            assert.equal(transport, 'tcp-md5');
            assert.equal(metadata.tcpMd5ProfileId, 'md5-router-a');
            assert.equal(initialData.toString(), 'first-pdu');
            return { id: 'session' };
        };
        worker.createTcpAuthForwardingServer = () => forwardingServer;
        await worker[startMethod]();

        assert.equal(forwardedProfiles[0].key, 'settings-owned-md5-secret');
        const redactedConfig = worker[WorkerClass === BmpWorker ? 'bmpConfigData' : 'rpkiConfigData'][configField];
        const redactedProfile = Array.isArray(redactedConfig) ? redactedConfig[0] : redactedConfig;
        assert.equal(redactedProfile.key, '<redacted>');
        assert.equal(runtimeProfile.key, '<redacted>');
        const accepted = connection(makeSocket(), { tcpMd5ProfileId: 'md5-router-a' }, Buffer.from('first-pdu'));
        assert(accepted, 'the authenticated connection should reach the protocol worker');

        if (WorkerClass === BmpWorker) {
            worker.server = null;
            worker.ipv6Server = null;
            await worker.closeTcpServers();
        } else {
            worker.storageStopping = false;
            worker.server = null;
            worker.ipv6Server = null;
            worker.tcpAuthProxy = null;
            worker.pendingTcpAuthSockets = new Set();
            worker.rpkiSessionMap = new Map();
            worker.closingRpkiSessions = new Set();
            worker.rpkiRouterKeyMap = new Map();
            worker.activeImportClients = new Set();
            worker.activeDataSnapshots = 0;
            worker.storageMutationQueue = Promise.resolve();
            worker.destroyPendingTcpAuthSockets = () => {};
            worker.cleanupTcpAuthForwardEndpoint = () => {};
            worker.clearSerialHistory = () => {};
            worker.closeRpkiStore = () => {};
            worker.messageHandler = {
                sendSuccessResponse() {},
                sendErrorResponse(_id, message) {
                    throw new Error(message);
                }
            };
            await worker.stopRpki('stop-md5');
        }
        assert.equal(stopCalls, 1, `${WorkerClass.name} did not stop the MD5 forwarding server`);
    }
}

async function main() {
    await testBmpMainBoundary();
    await testRpkiMainBoundary();
    testForwardingMetadata();
    await testWorkerForwardingLifecycle();
    console.log('BMP/RPKI TCP MD5 app and worker integration tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
