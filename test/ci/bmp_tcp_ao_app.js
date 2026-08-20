const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const BmpApp = require('../../electron/app/bmpApp');
const BmpConst = require('../../electron/const/bmpConst');
const { BMP_AUTH_TYPES, normalizeBmpAuthenticationSelection } = require('../../electron/utils/tcpAuthConfig');
const { assertNonOverlappingTcpAoProfiles } = require('../../electron/utils/tcpAoConfig');

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

    encrypt(value) {
        return `encrypted:${Buffer.from(value, 'utf8').toString('base64')}`;
    }

    decrypt(value) {
        assert.match(value, /^encrypted:/);
        return Buffer.from(value.slice('encrypted:'.length), 'base64').toString('utf8');
    }
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function runtimeProfile(id, peer, secret) {
    const address = peer.split('/')[0];
    return {
        id,
        name: `Profile ${id}`,
        peer,
        family: peer.includes(':') ? 6 : 4,
        address,
        prefixLength: Number(peer.split('/')[1]),
        keys: [
            {
                id: `key-${id}`,
                algorithm: 'hmac(sha1)',
                sndId: 10,
                rcvId: 20,
                macLength: 12,
                key: secret,
                acceptStart: null,
                sendStart: null,
                sendEnd: null,
                acceptEnd: null
            }
        ]
    };
}

function createRendererTarget(events) {
    return {
        send(channel, payload) {
            if (channel === 'unified-event') events.push(payload);
        },
        isDestroyed() {
            return false;
        }
    };
}

function createFakeWorker(options = {}) {
    const listeners = new Map();
    const calls = [];
    let onExit = null;
    const worker = {
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(handler);
        },
        removeEventListener(type, handler) {
            listeners.get(type)?.delete(handler);
        },
        async sendRequest(operation, payload) {
            calls.push({ operation, payload });
            if (operation === BmpConst.BMP_REQ_TYPES.START_BMP) {
                if (options.startError) throw options.startError;
                if (options.startDeferred) return options.startDeferred.promise;
                return { status: 'success', data: null, msg: 'started' };
            }
            if (operation === BmpConst.BMP_REQ_TYPES.STOP_BMP) {
                return { status: 'success', data: null, msg: 'stopped' };
            }
            throw new Error(`Unexpected BMP worker operation: ${operation}`);
        },
        async terminate() {
            onExit?.(0, worker, { expected: true });
        }
    };
    return {
        worker,
        calls,
        listeners,
        installProcessFactory(app) {
            app.createBmpProcess = (_workerPath, processOptions) => {
                onExit = processOptions.onExit;
                return worker;
            };
        },
        exit(code, details = {}) {
            onExit?.(code, worker, details);
        }
    };
}

function baseConfig(overrides = {}) {
    return {
        port: 11019,
        bmpV4TlvDraft: 20,
        pathMarkingTlvType: 8,
        persistenceEnabled: true,
        authType: BMP_AUTH_TYPES.NONE,
        tcpAoProfileIds: [],
        ...overrides
    };
}

function assertNoRendererSecrets(value) {
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes('renderer-injected-secret'), false);
    assert.equal(serialized.includes('renderer-injected-ciphertext'), false);
    assert.equal(serialized.includes('renderer-injected-runtime-key'), false);
    for (const field of ['key', 'keyEncrypted', 'tcpAo', 'tcpAoProfiles', 'unexpectedRuntimeOption']) {
        assert.equal(Object.prototype.hasOwnProperty.call(value, field), false, `${field} crossed the BMP boundary`);
    }
}

function tcpAoAuthSelection(selection) {
    return {
        authType: selection.authType,
        tcpAoProfileIds: selection.tcpAoProfileIds
    };
}

async function testTrustedRendererBoundary() {
    const expectedPackagedRenderer = path.resolve(__dirname, '../../dist/index.html');
    assert.equal(BmpApp.PACKAGED_RENDERER_PATH, expectedPackagedRenderer);
    assert.equal(
        BmpApp.isTrustedBmpRendererUrl(pathToFileURL(expectedPackagedRenderer).href, { isPackaged: true }),
        true
    );
    assert.equal(
        BmpApp.isTrustedBmpRendererUrl(pathToFileURL(path.resolve(__dirname, '../../electron/dist/index.html')).href, {
            isPackaged: true
        }),
        false
    );
    assert.equal(BmpApp.isTrustedBmpRendererUrl('http://127.0.0.1:3000/bmp', { isPackaged: false }), true);
    assert.equal(BmpApp.isTrustedBmpRendererUrl('http://localhost:3000/bmp', { isPackaged: false }), false);

    const ipc = new FakeIpcMain();
    const trustedMainFrame = { url: `${pathToFileURL(expectedPackagedRenderer).href}#/bmp/bmp-config` };
    const trustedWebContents = {
        mainFrame: trustedMainFrame,
        getURL: () => trustedMainFrame.url
    };
    const ownerWindow = { isDestroyed: () => false };
    const browserWindow = {
        fromWebContents: sender => (sender?.withoutOwner ? null : ownerWindow)
    };
    new BmpApp(ipc, new MemoryStore(), {
        primaryWebContents: trustedWebContents,
        browserWindow,
        appIsPackaged: true,
        credentialStore: new FakeCredentialStore()
    });
    const trustedLoadHandler = ipc.handlers.get('bmp:loadBmpConfig');
    assert.equal(
        (await trustedLoadHandler({ sender: trustedWebContents, senderFrame: trustedMainFrame })).status,
        'success'
    );
    const otherMainFrame = { url: trustedMainFrame.url };
    await assert.rejects(
        async () =>
            trustedLoadHandler({
                sender: { mainFrame: otherMainFrame, getURL: () => otherMainFrame.url },
                senderFrame: otherMainFrame
            }),
        /未知窗口/
    );
    await assert.rejects(
        async () => trustedLoadHandler({ sender: trustedWebContents, senderFrame: { url: trustedMainFrame.url } }),
        /未知窗口/
    );
    trustedWebContents.withoutOwner = true;
    await assert.rejects(
        async () => trustedLoadHandler({ sender: trustedWebContents, senderFrame: trustedMainFrame }),
        /未知窗口/
    );
    delete trustedWebContents.withoutOwner;
    const originalTrustedUrl = trustedMainFrame.url;
    trustedMainFrame.url = 'file:///tmp/untrusted/index.html#/bmp';
    await assert.rejects(
        async () => trustedLoadHandler({ sender: trustedWebContents, senderFrame: trustedMainFrame }),
        /非应用页面/
    );
    trustedMainFrame.url = originalTrustedUrl;
}

function testAuthSelectionAndOverlapValidation() {
    assert.notEqual(
        BmpConst.BMP_EVT_TYPES.RUNTIME_FAILURE,
        undefined,
        'BMP runtime failures need a dedicated worker event type'
    );
    assert.deepEqual(tcpAoAuthSelection(normalizeBmpAuthenticationSelection({})), {
        authType: BMP_AUTH_TYPES.NONE,
        tcpAoProfileIds: []
    });
    assert.deepEqual(
        tcpAoAuthSelection(
            normalizeBmpAuthenticationSelection({
                authType: BMP_AUTH_TYPES.TCP_AO,
                tcpAoProfileIds: ['edge-a', 'edge-b']
            })
        ),
        { authType: BMP_AUTH_TYPES.TCP_AO, tcpAoProfileIds: ['edge-a', 'edge-b'] }
    );
    assert.deepEqual(
        tcpAoAuthSelection(
            normalizeBmpAuthenticationSelection({ authType: BMP_AUTH_TYPES.TCP_AO, tcpAoProfileId: 'legacy-edge' })
        ),
        { authType: BMP_AUTH_TYPES.TCP_AO, tcpAoProfileIds: ['legacy-edge'] },
        'a legacy single-profile BMP selection should migrate safely'
    );
    assert.throws(
        () => normalizeBmpAuthenticationSelection({ authType: BMP_AUTH_TYPES.TCP_AO, tcpAoProfileIds: [] }),
        /1-32/
    );
    assert.throws(
        () =>
            normalizeBmpAuthenticationSelection({
                authType: BMP_AUTH_TYPES.TCP_AO,
                tcpAoProfileIds: ['edge-a', 'edge-a']
            }),
        /重复/
    );
    assert.throws(
        () =>
            normalizeBmpAuthenticationSelection({
                authType: BMP_AUTH_TYPES.TCP_AO,
                tcpAoProfileIds: Array.from({ length: 33 }, (_, index) => `edge-${index}`)
            }),
        /1-32/
    );

    assert.doesNotThrow(() =>
        assertNonOverlappingTcpAoProfiles([
            runtimeProfile('edge-a', '192.0.2.0/25', 'secret-a'),
            runtimeProfile('edge-b', '192.0.2.128/25', 'secret-b'),
            runtimeProfile('edge-v6', '2001:db8::/64', 'secret-v6')
        ])
    );
    assert.throws(
        () =>
            assertNonOverlappingTcpAoProfiles([
                runtimeProfile('broad', '192.0.2.0/24', 'secret-a'),
                runtimeProfile('narrow', '192.0.2.128/25', 'secret-b')
            ]),
        /不能重叠.*broad.*narrow|不能重叠.*narrow.*broad/
    );
}

async function testBmpConfigWhitelist() {
    const store = new MemoryStore();
    const app = new BmpApp(new FakeIpcMain(), store, { credentialStore: new FakeCredentialStore() });
    app.getTcpAoSettingsStore().saveSettings({
        profiles: [
            runtimeProfile('edge-a', '192.0.2.1/32', 'settings-secret-a'),
            runtimeProfile('edge-b', '2001:db8::1/128', 'settings-secret-b')
        ]
    });
    const maliciousConfig = baseConfig({
        authType: BMP_AUTH_TYPES.TCP_AO,
        tcpAoProfileIds: ['edge-a', 'edge-b'],
        key: 'renderer-injected-secret',
        keyEncrypted: 'renderer-injected-ciphertext',
        tcpAo: { key: 'renderer-injected-secret' },
        tcpAoProfiles: [runtimeProfile('attacker', '203.0.113.1/32', 'renderer-injected-runtime-key')],
        persistenceDbPath: '/tmp/renderer-controlled.sqlite3',
        unexpectedRuntimeOption: 'renderer-controlled'
    });

    const missingProfileSave = await app.handleSaveBmpConfig(
        null,
        baseConfig({
            authType: BMP_AUTH_TYPES.TCP_AO,
            tcpAoProfileIds: ['edge-a', 'missing-edge']
        })
    );
    assert.equal(missingProfileSave.status, 'error');
    assert.match(missingProfileSave.msg, /TCP-AO.*不存在|不存在.*TCP-AO/);
    assert.equal(store.get('bmp-config'), undefined, 'a missing TCP-AO profile must not persist a BMP configuration');

    const saved = await app.handleSaveBmpConfig(null, maliciousConfig);
    assert.equal(saved.status, 'success', saved.msg);
    const stored = store.get('bmp-config');
    assert.deepEqual(
        Object.keys(stored)
            .filter(key => key !== 'tcpMd5ProfileIds')
            .sort(),
        ['authType', 'bmpV4TlvDraft', 'pathMarkingTlvType', 'persistenceEnabled', 'port', 'tcpAoProfileIds'].sort(),
        'BMP persistence must be an explicit allowlist'
    );
    assert.equal(Number(stored.port), 11019);
    assert.equal(stored.persistenceEnabled, true);
    assert.deepEqual(stored.tcpAoProfileIds, ['edge-a', 'edge-b']);
    assertNoRendererSecrets(stored);

    store.set('bmp-config', maliciousConfig);
    const loaded = await app.handleLoadBmpConfig();
    assert.equal(loaded.status, 'success', loaded.msg);
    assertNoRendererSecrets(loaded.data);
    assert.deepEqual(loaded.data.tcpAoProfileIds, ['edge-a', 'edge-b']);
}

async function testRuntimeProfilesComeOnlyFromSettings() {
    const rendererEvents = [];
    const sender = createRendererTarget(rendererEvents);
    const credentialStore = new FakeCredentialStore();
    const expectedProfiles = new Map([
        ['edge-a', runtimeProfile('edge-a', '192.0.2.1/32', 'settings-secret-a')],
        ['edge-b', runtimeProfile('edge-b', '2001:db8::1/128', 'settings-secret-b')]
    ]);
    const requestedProfileIds = [];
    const tcpAoSettingsStore = {
        store: null,
        getRuntimeProfile(id) {
            requestedProfileIds.push(id);
            const selected = expectedProfiles.get(id);
            if (!selected) throw new Error(`TCP-AO配置不存在: ${id}`);
            return JSON.parse(JSON.stringify(selected));
        }
    };
    const app = new BmpApp(new FakeIpcMain(), new MemoryStore(), {
        credentialStore,
        tcpAoSettingsStore,
        platform: 'linux'
    });
    app.closeOfflinePersistenceReader = async () => {};
    const fake = createFakeWorker();
    fake.installProcessFactory(app);

    const response = await app.handleStartBmp(
        { sender },
        baseConfig({
            authType: BMP_AUTH_TYPES.TCP_AO,
            tcpAoProfileIds: ['edge-a', 'edge-b'],
            key: 'renderer-injected-secret',
            keyEncrypted: 'renderer-injected-ciphertext',
            tcpAoProfiles: [runtimeProfile('attacker', '203.0.113.1/32', 'renderer-injected-runtime-key')],
            unexpectedRuntimeOption: 'renderer-controlled'
        })
    );
    assert.equal(response.status, 'success', response.msg);
    assert.deepEqual(requestedProfileIds, ['edge-a', 'edge-b']);
    assert.equal(credentialStore.initializationCalls, 1);

    const startCall = fake.calls.find(call => call.operation === BmpConst.BMP_REQ_TYPES.START_BMP);
    assert(startCall, 'BMP START request was not sent');
    const payload = startCall.payload;
    assert.deepEqual(
        payload.tcpAoProfiles.map(profile => profile.id),
        ['edge-a', 'edge-b']
    );
    assert.deepEqual(
        payload.tcpAoProfiles.map(profile => profile.keys[0].key),
        ['settings-secret-a', 'settings-secret-b']
    );
    assert.equal(JSON.stringify(payload).includes('renderer-injected'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'key'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'keyEncrypted'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'tcpAo'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'unexpectedRuntimeOption'), false);

    const failure = {
        code: 'TCP_AO_KEYS_EXPIRED',
        reason: 'TCP-AO发送密钥已过期且没有可用的后继密钥，BMP服务已安全停止'
    };
    const failureHandlers = fake.listeners.get(BmpConst.BMP_EVT_TYPES.RUNTIME_FAILURE);
    assert.equal(failureHandlers?.size, 1, 'main must subscribe to structured BMP runtime failures');
    failureHandlers.forEach(handler => handler(failure));
    fake.exit(20, { expected: false });
    assert.equal(app.worker, null);

    const runtimeEvents = rendererEvents.filter(event => event.type === 'bmp:runtimeChanged');
    assert.deepEqual(
        runtimeEvents.map(event => event.data),
        [
            { running: true },
            {
                running: false,
                unexpected: true,
                code: failure.code,
                reason: failure.reason
            }
        ]
    );
    fake.exit(20, { expected: false });
    assert.equal(
        rendererEvents.filter(event => event.type === 'bmp:runtimeChanged').length,
        2,
        'a repeated process-exit callback must not duplicate the runtime failure'
    );
}

async function testStartupErrorsRemainActionable() {
    const missingProfileApp = new BmpApp(new FakeIpcMain(), new MemoryStore(), {
        credentialStore: new FakeCredentialStore(),
        platform: 'linux',
        tcpAoSettingsStore: {
            getRuntimeProfile(id) {
                throw new Error(`TCP-AO配置不存在: ${id}`);
            }
        }
    });
    let processCreated = false;
    missingProfileApp.createBmpProcess = () => {
        processCreated = true;
        throw new Error('must not create a worker for an invalid profile');
    };
    const missing = await missingProfileApp.handleStartBmp(
        { sender: createRendererTarget([]) },
        baseConfig({ authType: BMP_AUTH_TYPES.TCP_AO, tcpAoProfileIds: ['missing'] })
    );
    assert.equal(missing.status, 'error');
    assert.match(missing.msg, /TCP-AO配置不存在: missing/);
    assert.equal(processCreated, false);

    const helperErrorApp = new BmpApp(new FakeIpcMain(), new MemoryStore());
    helperErrorApp.closeOfflinePersistenceReader = async () => {};
    const fake = createFakeWorker({ startError: new Error('TCP 认证 helper未确认TCP-AO强制认证状态') });
    fake.installProcessFactory(helperErrorApp);
    const helperFailure = await helperErrorApp.handleStartBmp({ sender: createRendererTarget([]) }, baseConfig());
    assert.equal(helperFailure.status, 'error');
    assert.match(helperFailure.msg, /TCP 认证 helper未确认TCP-AO强制认证状态/);
}

async function testStopCancelsPendingStart() {
    const rendererEvents = [];
    const app = new BmpApp(new FakeIpcMain(), new MemoryStore());
    app.closeOfflinePersistenceReader = async () => {};
    const startup = deferred();
    const fake = createFakeWorker({ startDeferred: startup });
    fake.installProcessFactory(app);

    const startPromise = app.handleStartBmp({ sender: createRendererTarget(rendererEvents) }, baseConfig());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.bmpStarting, true);
    assert.equal(
        fake.calls.some(call => call.operation === BmpConst.BMP_REQ_TYPES.START_BMP),
        true
    );

    const stopPromise = app.handleStopBmp();
    assert.equal(app.bmpStopping, true);
    startup.resolve({ status: 'success', data: null, msg: 'started' });
    const [startResponse, stopResponse] = await Promise.all([startPromise, stopPromise]);

    assert.equal(startResponse.status, 'error');
    assert.match(startResponse.msg, /启动已取消/);
    assert.equal(stopResponse.status, 'success');
    assert.match(stopResponse.msg, /启动已取消/);
    assert.equal(app.worker, null);
    assert.equal(app.bmpStarting, false);
    assert.equal(app.bmpStopping, false);
    assert.equal(
        rendererEvents.some(event => event.type === 'bmp:runtimeChanged' && event.data?.running === true),
        false,
        'a cancelled BMP start must never publish a running state'
    );
}

async function testRuntimeReloadBoundary() {
    const app = new BmpApp(new FakeIpcMain(), new MemoryStore());
    let request = null;
    const worker = {
        async sendRequest(operation, payload, options) {
            request = { operation, payload: JSON.parse(JSON.stringify(payload)), options };
            return { data: { disconnectedConnections: 3 } };
        }
    };
    app.worker = worker;
    app.runningAuthType = BMP_AUTH_TYPES.TCP_AO;
    app.runningTcpAoProfileIds = ['edge-a'];
    const profiles = [runtimeProfile('edge-a', '192.0.2.1/32', 'replacement runtime secret')];

    const status = await app.reloadTcpAoRuntimeProfiles(profiles);

    assert.equal(request.operation, BmpConst.BMP_REQ_TYPES.RELOAD_TCP_AO_PROFILES);
    assert.equal(request.payload.profiles[0].keys[0].key, 'replacement runtime secret');
    assert.equal(JSON.stringify(request.payload).includes('keyEncrypted'), false);
    assert.equal(profiles[0].keys.length, 0, 'main-process reload input retained plaintext key material');
    assert.equal(status.disconnectedConnections, 3);
}

async function main() {
    testAuthSelectionAndOverlapValidation();
    await testTrustedRendererBoundary();
    await testBmpConfigWhitelist();
    await testRuntimeProfilesComeOnlyFromSettings();
    await testStartupErrorsRemainActionable();
    await testStopCancelsPendingStart();
    await testRuntimeReloadBoundary();
    console.log('BMP TCP-AO app tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
