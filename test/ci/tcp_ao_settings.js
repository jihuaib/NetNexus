const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const TcpAoSettingsStore = require('../../electron/utils/tcpAoSettingsStore');
const RpkiApp = require('../../electron/app/rpkiApp');
const TcpAoSettingsLifecycleGate = require('../../electron/app/tcpAoSettingsLifecycleGate');
const RpkiConst = require('../../electron/const/rpkiConst');
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
const {
    BMP_AUTH_TYPES,
    RPKI_AUTH_TYPES,
    normalizeRpkiAuthenticationSelection
} = require('../../electron/utils/tcpAuthConfig');
const {
    normalizeTcpAoProfile,
    redactTcpAoConfig,
    assertContinuousRotationSchedule,
    assertCurrentSendKey,
    isKeySendActive
} = require('../../electron/utils/tcpAoConfig');

class MemoryStore {
    constructor() {
        this.values = new Map();
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

class BlockingCredentialStore extends FakeCredentialStore {
    blockNextInitialization() {
        const block = {
            entered: deferred(),
            release: deferred()
        };
        this.nextInitializationBlock = block;
        return block;
    }

    async initialize() {
        this.initializationCalls += 1;
        const block = this.nextInitializationBlock;
        this.nextInitializationBlock = null;
        if (!block) return;
        block.entered.resolve();
        await block.release.promise;
    }
}

function profile(overrides = {}) {
    return {
        id: 'router-a',
        name: 'Router A',
        peer: '192.0.2.1/32',
        keys: [
            {
                id: 'key-10',
                algorithm: 'hmac(sha1)',
                sndId: 10,
                rcvId: 20,
                macLength: 12,
                key: 'correct horse battery staple',
                acceptStart: null,
                sendStart: null,
                sendEnd: null,
                acceptEnd: null
            }
        ],
        ...overrides
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
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

function nextTurn() {
    return new Promise(resolve => setImmediate(resolve));
}

function createRuntimeConsumer(service, firstReload, rollbackReload = async () => ({ rolledBack: true })) {
    const calls = [];
    let stopCalls = 0;
    return {
        calls,
        get stopCalls() {
            return stopCalls;
        },
        getTcpAoRuntimeReloadState() {
            return { service, state: 'running', profileIds: ['router-a'] };
        },
        reloadTcpAoRuntimeProfiles(profiles) {
            calls.push(clone(profiles));
            if (calls.length === 1) return firstReload();
            return rollbackReload();
        },
        async stopTcpAoRuntimeAfterReloadFailure() {
            stopCalls += 1;
            return { stopped: true };
        }
    };
}

async function createRuntimeTransactionFixture(consumers) {
    let runtimeActive = false;
    const programStore = new MemoryStore();
    const rpkiApp = new RpkiApp(new FakeIpcMain(), programStore, {
        credentialStore: new FakeCredentialStore(),
        platform: 'linux',
        getTcpAoRuntimeConsumers: () => (runtimeActive ? consumers : [])
    });
    const initialSave = await rpkiApp.handleSaveTcpAoSettings(null, { profiles: [profile()] });
    assert.equal(initialSave.status, 'success', initialSave.msg);
    runtimeActive = true;
    return {
        programStore,
        rpkiApp,
        rendererProfiles: clone(initialSave.data.profiles),
        oldStoredSettings: clone(programStore.get('rpki-tcp-ao-settings'))
    };
}

async function testRuntimeReloadSuccessSummary() {
    const bmp = createRuntimeConsumer('BMP', async () => ({ disconnectedConnections: 2 }));
    const rpki = createRuntimeConsumer('RPKI', async () => ({ disconnectedConnections: 1 }));
    const fixture = await createRuntimeTransactionFixture([bmp, rpki]);
    fixture.rendererProfiles[0].keys[0].key = 'rotated runtime key';

    const response = await fixture.rpkiApp.handleSaveTcpAoSettings(null, {
        profiles: fixture.rendererProfiles
    });

    assert.equal(response.status, 'success', response.msg);
    assert.deepEqual(response.data.runtimeReload, {
        attempted: true,
        disconnectedConnections: 3,
        services: [
            {
                service: 'BMP',
                status: 'reloaded',
                profileIds: ['router-a'],
                disconnectedConnections: 2
            },
            {
                service: 'RPKI',
                status: 'reloaded',
                profileIds: ['router-a'],
                disconnectedConnections: 1
            }
        ]
    });
    assert.equal(bmp.calls.length, 1);
    assert.equal(rpki.calls.length, 1);
    assert.equal(bmp.calls[0][0].keys[0].key, 'rotated runtime key');
    assert.equal(rpki.calls[0][0].keys[0].key, 'rotated runtime key');
    assert.equal(
        fixture.rpkiApp.getTcpAoSettingsStore().getRuntimeProfile('router-a').keys[0].key,
        'rotated runtime key'
    );
}

async function testRuntimeReloadFailureRollsBackEveryConsumerAndStorage() {
    const bmpReload = deferred();
    const rpkiReload = deferred();
    const bmp = createRuntimeConsumer('BMP', () => bmpReload.promise);
    const rpki = createRuntimeConsumer('RPKI', () => rpkiReload.promise);
    const fixture = await createRuntimeTransactionFixture([bmp, rpki]);
    fixture.rendererProfiles[0].keys[0].key = 'must be rolled back';

    let saveSettled = false;
    const savePromise = fixture.rpkiApp
        .handleSaveTcpAoSettings(null, { profiles: fixture.rendererProfiles })
        .finally(() => {
            saveSettled = true;
        });
    while (bmp.calls.length === 0 || rpki.calls.length === 0) await nextTurn();

    bmpReload.resolve({ reloaded: true });
    await nextTurn();
    assert.equal(saveSettled, false, 'save must wait for every running TCP-AO consumer');

    rpkiReload.reject(new Error('simulated RPKI reload failure'));
    const response = await savePromise;

    assert.equal(response.status, 'error');
    assert.match(response.msg, /RPKI.*simulated RPKI reload failure/);
    assert.match(response.msg, /持久化TCP-AO配置已恢复/);
    assert.match(response.msg, /运行中的服务已回滚到旧密钥计划/);
    assert.deepEqual(
        fixture.programStore.get('rpki-tcp-ao-settings'),
        fixture.oldStoredSettings,
        'a partial runtime reload failure must restore the exact encrypted settings snapshot'
    );
    assert.equal(bmp.calls.length, 2, 'the successfully reloaded BMP service must receive the old plan');
    assert.equal(rpki.calls.length, 2, 'the failed RPKI service must also receive a best-effort old plan');
    assert.equal(bmp.calls[0][0].keys[0].key, 'must be rolled back');
    assert.equal(rpki.calls[0][0].keys[0].key, 'must be rolled back');
    assert.equal(bmp.calls[1][0].keys[0].key, 'correct horse battery staple');
    assert.equal(rpki.calls[1][0].keys[0].key, 'correct horse battery staple');
    assert.equal(bmp.stopCalls, 0);
    assert.equal(rpki.stopCalls, 0);
    assert.equal(
        fixture.rpkiApp.getTcpAoSettingsStore().getRuntimeProfile('router-a').keys[0].key,
        'correct horse battery staple'
    );
}

async function testRuntimeRollbackFailureStopsService() {
    const rpki = createRuntimeConsumer(
        'RPKI',
        async () => {
            throw new Error('simulated apply failure');
        },
        async () => {
            throw new Error('simulated rollback failure');
        }
    );
    const fixture = await createRuntimeTransactionFixture([rpki]);
    fixture.rendererProfiles[0].keys[0].key = 'unsafe replacement';

    const response = await fixture.rpkiApp.handleSaveTcpAoSettings(null, {
        profiles: fixture.rendererProfiles
    });

    assert.equal(response.status, 'error');
    assert.match(response.msg, /RPKI回滚失败.*simulated rollback failure.*服务已安全停止/);
    assert.equal(rpki.calls.length, 2);
    assert.equal(rpki.stopCalls, 1);
    assert.deepEqual(fixture.programStore.get('rpki-tcp-ao-settings'), fixture.oldStoredSettings);
}

async function testPersistenceRestoreFailureStopsAllRuntimeConsumers() {
    const bmp = createRuntimeConsumer('BMP', async () => ({ disconnectedConnections: 0 }));
    const rpki = createRuntimeConsumer('RPKI', async () => ({ disconnectedConnections: 0 }));
    const fixture = await createRuntimeTransactionFixture([bmp, rpki]);
    const originalSet = fixture.programStore.set.bind(fixture.programStore);
    fixture.programStore.set = (key, value) => {
        if (key === 'rpki-tcp-ao-settings' && Array.isArray(value?.profiles) && value.profiles.length === 1) {
            throw new Error('simulated settings restore failure');
        }
        return originalSet(key, value);
    };

    const response = await fixture.rpkiApp.handleSaveTcpAoSettings(null, { profiles: [] });

    assert.equal(response.status, 'error');
    assert.match(response.msg, /旧TCP-AO配置恢复失败: simulated settings restore failure/);
    assert.match(response.msg, /BMP已安全停止/);
    assert.match(response.msg, /RPKI已安全停止/);
    assert.equal(bmp.calls.length, 0, 'BMP should not receive a reload when the new selected profile is missing');
    assert.equal(rpki.calls.length, 0, 'RPKI should not receive a reload when the new selected profile is missing');
    assert.equal(bmp.stopCalls, 1);
    assert.equal(rpki.stopCalls, 1);
    assert.deepEqual(fixture.programStore.get('rpki-tcp-ao-settings').profiles, []);
}

async function testRuntimeSettingsSavesAreSerialized() {
    const firstReload = deferred();
    const calls = [];
    const consumer = {
        getTcpAoRuntimeReloadState() {
            return { service: 'RPKI', state: 'running', profileIds: ['router-a'] };
        },
        reloadTcpAoRuntimeProfiles(profiles) {
            calls.push(clone(profiles));
            return calls.length === 1 ? firstReload.promise : Promise.resolve({ disconnectedConnections: 0 });
        },
        async stopTcpAoRuntimeAfterReloadFailure() {
            return { stopped: true };
        }
    };
    const fixture = await createRuntimeTransactionFixture([consumer]);
    const firstProfiles = clone(fixture.rendererProfiles);
    firstProfiles[0].keys[0].key = 'serialized key one';
    const secondProfiles = clone(fixture.rendererProfiles);
    secondProfiles[0].keys[0].key = 'serialized key two';

    const firstSave = fixture.rpkiApp.handleSaveTcpAoSettings(null, { profiles: firstProfiles });
    const secondSave = fixture.rpkiApp.handleSaveTcpAoSettings(null, { profiles: secondProfiles });
    while (calls.length === 0) await nextTurn();
    await nextTurn();
    assert.equal(calls.length, 1, 'a second TCP-AO save overlapped the first runtime transaction');
    firstReload.resolve({ disconnectedConnections: 0 });
    const [firstResponse, secondResponse] = await Promise.all([firstSave, secondSave]);

    assert.equal(firstResponse.status, 'success', firstResponse.msg);
    assert.equal(secondResponse.status, 'success', secondResponse.msg);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0].keys[0].key, 'serialized key one');
    assert.equal(calls[1][0].keys[0].key, 'serialized key two');
    assert.equal(
        fixture.rpkiApp.getTcpAoSettingsStore().getRuntimeProfile('router-a').keys[0].key,
        'serialized key two'
    );
}

function createGateRaceRpkiWorker(options = {}) {
    const calls = [];
    const worker = {
        calls,
        addEventListener() {},
        removeEventListener() {},
        async sendRequest(operation, payload) {
            calls.push({ operation, payload: clone(payload) });
            if (operation === RpkiConst.RPKI_REQ_TYPES.START_RPKI) {
                if (options.startRequest) await options.startRequest.promise;
                return { status: 'success', data: null, msg: 'started' };
            }
            if (operation === RpkiConst.RPKI_REQ_TYPES.RELOAD_TCP_AO_PROFILE) {
                if (options.reloadRequest) await options.reloadRequest.promise;
                return { status: 'success', data: { disconnectedConnections: 0 }, msg: 'reloaded' };
            }
            throw new Error(`Unexpected operation ${operation}`);
        },
        async terminate() {}
    };
    return worker;
}

async function createGateRaceFixture(options = {}) {
    const store = new MemoryStore();
    const credentialStore = new BlockingCredentialStore();
    const gate = new TcpAoSettingsLifecycleGate();
    let rpkiApp;
    rpkiApp = new RpkiApp(new FakeIpcMain(), store, {
        credentialStore,
        platform: 'linux',
        tcpAoSettingsLifecycleGate: gate,
        getTcpAoRuntimeConsumers: () => [rpkiApp]
    });
    const initialSave = await rpkiApp.handleSaveTcpAoSettings(null, { profiles: [profile()] });
    assert.equal(initialSave.status, 'success', initialSave.msg);
    const worker = createGateRaceRpkiWorker(options);
    let processOptions = null;
    rpkiApp.getRpkiDatabasePath = () => '/tmp/netnexus-test-rpki-gate.sqlite3';
    rpkiApp.createRpkiProcess = (_workerPath, createdProcessOptions) => {
        processOptions = createdProcessOptions;
        return worker;
    };
    return {
        store,
        credentialStore,
        rpkiApp,
        worker,
        rendererProfiles: clone(initialSave.data.profiles),
        exitWorker() {
            processOptions?.onExit?.(1, worker, { expected: false });
        }
    };
}

async function testSettingsSaveThenTcpAoStartUsesCommittedPlan() {
    const fixture = await createGateRaceFixture();
    fixture.rendererProfiles[0].keys[0].key = 'save-before-start key';
    const initializationBlock = fixture.credentialStore.blockNextInitialization();
    const savePromise = fixture.rpkiApp.handleSaveTcpAoSettings(null, {
        profiles: fixture.rendererProfiles
    });
    await initializationBlock.entered.promise;

    const startPromise = fixture.rpkiApp.handleStartRpki(null, {
        port: 8282,
        authType: RPKI_AUTH_TYPES.TCP_AO,
        tcpAoProfileId: 'router-a'
    });
    await nextTurn();
    assert.equal(
        fixture.worker.calls.length,
        0,
        'a TCP-AO start must not read or launch with the old plan while a settings transaction owns the gate'
    );

    initializationBlock.release.resolve();
    const [saveResponse, startResponse] = await Promise.all([savePromise, startPromise]);
    assert.equal(saveResponse.status, 'success', saveResponse.msg);
    assert.equal(startResponse.status, 'success', startResponse.msg);
    const startCall = fixture.worker.calls.find(call => call.operation === RpkiConst.RPKI_REQ_TYPES.START_RPKI);
    assert.equal(startCall.payload.tcpAo.keys[0].key, 'save-before-start key');
    assert.deepEqual(
        saveResponse.data.runtimeReload.services,
        [],
        'the queued start is inactive for this transaction and must consume the committed plan after the gate releases'
    );
}

async function testTcpAoStartThenSettingsSaveReloadsStartedService() {
    const startRequest = deferred();
    const fixture = await createGateRaceFixture({ startRequest });
    const startPromise = fixture.rpkiApp.handleStartRpki(null, {
        port: 8282,
        authType: RPKI_AUTH_TYPES.TCP_AO,
        tcpAoProfileId: 'router-a'
    });
    while (!fixture.worker.calls.some(call => call.operation === RpkiConst.RPKI_REQ_TYPES.START_RPKI)) {
        await nextTurn();
    }

    fixture.rendererProfiles[0].keys[0].key = 'start-before-save key';
    const savePromise = fixture.rpkiApp.handleSaveTcpAoSettings(null, {
        profiles: fixture.rendererProfiles
    });
    await nextTurn();
    assert.equal(
        fixture.worker.calls.filter(call => call.operation === RpkiConst.RPKI_REQ_TYPES.RELOAD_TCP_AO_PROFILE).length,
        0,
        'the settings transaction must wait for the in-flight TCP-AO start to commit its runtime identity'
    );

    startRequest.resolve();
    const startResponse = await startPromise;
    const saveResponse = await savePromise;
    assert.equal(startResponse.status, 'success', startResponse.msg);
    assert.equal(saveResponse.status, 'success', saveResponse.msg);
    const startCall = fixture.worker.calls.find(call => call.operation === RpkiConst.RPKI_REQ_TYPES.START_RPKI);
    const reloadCall = fixture.worker.calls.find(
        call => call.operation === RpkiConst.RPKI_REQ_TYPES.RELOAD_TCP_AO_PROFILE
    );
    assert.equal(startCall.payload.tcpAo.keys[0].key, 'correct horse battery staple');
    assert.equal(reloadCall.payload.profile.keys[0].key, 'start-before-save key');
    assert.deepEqual(saveResponse.data.runtimeReload.services, [
        {
            service: 'RPKI',
            status: 'reloaded',
            profileIds: ['router-a'],
            disconnectedConnections: 0
        }
    ]);
}

async function testReloadFailureCancelsQueuedStartWithoutGateDeadlock() {
    const reloadRequest = deferred();
    const fixture = await createGateRaceFixture({ reloadRequest });
    const initialStart = await fixture.rpkiApp.handleStartRpki(null, {
        port: 8282,
        authType: RPKI_AUTH_TYPES.TCP_AO,
        tcpAoProfileId: 'router-a'
    });
    assert.equal(initialStart.status, 'success', initialStart.msg);
    const oldStoredSettings = clone(fixture.store.get('rpki-tcp-ao-settings'));

    fixture.rendererProfiles[0].keys[0].key = 'reload that loses its runtime';
    const savePromise = fixture.rpkiApp.handleSaveTcpAoSettings(null, {
        profiles: fixture.rendererProfiles
    });
    while (!fixture.worker.calls.some(call => call.operation === RpkiConst.RPKI_REQ_TYPES.RELOAD_TCP_AO_PROFILE)) {
        await nextTurn();
    }

    fixture.exitWorker();
    const queuedStartPromise = fixture.rpkiApp.handleStartRpki(null, {
        port: 8282,
        authType: RPKI_AUTH_TYPES.TCP_AO,
        tcpAoProfileId: 'router-a'
    });
    await nextTurn();
    assert.notEqual(fixture.rpkiApp.rpkiStartPromise, null, 'the replacement start must be queued behind the save');
    assert.equal(fixture.rpkiApp.rpkiStarting, false, 'the queued replacement must not start while save owns the gate');

    reloadRequest.reject(new Error('simulated runtime exit during reload'));
    const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('TCP-AO save/queued-start cancellation deadlocked')), 1000);
    });
    const [saveResponse, queuedStartResponse] = await Promise.race([
        Promise.all([savePromise, queuedStartPromise]),
        timeout
    ]);

    assert.equal(saveResponse.status, 'error');
    assert.match(saveResponse.msg, /simulated runtime exit during reload/);
    assert.match(saveResponse.msg, /RPKI回滚失败.*服务已安全停止/);
    assert.equal(queuedStartResponse.status, 'error');
    assert.match(queuedStartResponse.msg, /启动已取消/);
    assert.equal(fixture.rpkiApp.worker, null);
    assert.equal(fixture.rpkiApp.rpkiStarting, false);
    assert.equal(fixture.rpkiApp.rpkiStopping, false);
    assert.deepEqual(fixture.store.get('rpki-tcp-ao-settings'), oldStoredSettings);
}

async function createProfileDependencyFixture() {
    const programStore = new MemoryStore();
    const rpkiApp = new RpkiApp(new FakeIpcMain(), programStore, {
        credentialStore: new FakeCredentialStore(),
        platform: 'linux'
    });
    const saveResponse = await rpkiApp.handleSaveTcpAoSettings(null, {
        profiles: [
            profile(),
            profile({
                id: 'router-b',
                name: 'Router B',
                peer: '198.51.100.1/32'
            })
        ]
    });
    assert.equal(saveResponse.status, 'success', saveResponse.msg);
    return {
        programStore,
        rpkiApp,
        profiles: clone(saveResponse.data.profiles)
    };
}

async function testReferencedProfileDeletionGuards() {
    {
        const { programStore, rpkiApp, profiles } = await createProfileDependencyFixture();
        programStore.set('rpki-config', {
            authType: RPKI_AUTH_TYPES.TCP_AO,
            tcpAoProfileId: 'router-a'
        });
        const loaded = await rpkiApp.handleLoadTcpAoSettings();
        assert.deepEqual(
            loaded.data.profiles.find(item => item.id === 'router-a').usedBy,
            ['RPKI'],
            'the settings response should identify RPKI references for the renderer'
        );
        const before = clone(programStore.get('rpki-tcp-ao-settings'));
        const candidateProfiles = profiles.filter(item => item.id !== 'router-a');
        candidateProfiles[0].name = 'Router B must not be partially updated';

        const response = await rpkiApp.handleSaveTcpAoSettings(null, { profiles: candidateProfiles });
        assert.equal(response.status, 'error');
        assert.match(response.msg, /RPKI/);
        assert.match(response.msg, /Router A|router-a/);
        assert.deepEqual(
            programStore.get('rpki-tcp-ao-settings'),
            before,
            'a rejected RPKI-referenced deletion must not partially update TCP-AO settings'
        );
    }

    {
        const { programStore, rpkiApp, profiles } = await createProfileDependencyFixture();
        programStore.set('bmp-config', {
            authType: BMP_AUTH_TYPES.TCP_AO,
            tcpAoProfileIds: ['router-a']
        });

        const loaded = await rpkiApp.handleLoadTcpAoSettings();
        assert.deepEqual(
            loaded.data.profiles.find(item => item.id === 'router-a').usedBy,
            ['BMP'],
            'the settings response should identify BMP references for the renderer'
        );

        const response = await rpkiApp.handleSaveTcpAoSettings(null, {
            profiles: profiles.filter(item => item.id !== 'router-a')
        });
        assert.equal(response.status, 'error');
        assert.match(response.msg, /BMP/);
        assert.match(response.msg, /Router A|router-a/);
    }

    {
        const { programStore, rpkiApp, profiles } = await createProfileDependencyFixture();
        programStore.set('bmp-config', {
            authType: BMP_AUTH_TYPES.TCP_AO,
            tcpAoProfileId: 'router-a'
        });

        const response = await rpkiApp.handleSaveTcpAoSettings(null, {
            profiles: profiles.filter(item => item.id !== 'router-a')
        });
        assert.equal(response.status, 'error');
        assert.match(response.msg, /BMP/);
        assert.match(response.msg, /Router A|router-a/);
    }

    {
        const { programStore, rpkiApp, profiles } = await createProfileDependencyFixture();
        programStore.set('rpki-config', {
            authType: RPKI_AUTH_TYPES.TCP_AO,
            tcpAoProfileId: 'router-a'
        });
        programStore.set('bmp-config', {
            authType: BMP_AUTH_TYPES.TCP_AO,
            tcpAoProfileIds: ['router-a']
        });

        const loaded = await rpkiApp.handleLoadTcpAoSettings();
        assert.deepEqual(
            loaded.data.profiles.find(item => item.id === 'router-a').usedBy,
            ['BMP', 'RPKI'],
            'the settings response should identify every current consumer'
        );

        const response = await rpkiApp.handleSaveTcpAoSettings(null, {
            profiles: profiles.filter(item => item.id !== 'router-a')
        });
        assert.equal(response.status, 'error');
        assert.match(response.msg, /BMP/);
        assert.match(response.msg, /RPKI/);
        assert.match(response.msg, /Router A|router-a/);
    }
}

async function testProfileDependencyGuardAllowsSafeSaves() {
    {
        const { programStore, rpkiApp, profiles } = await createProfileDependencyFixture();
        programStore.set('rpki-config', {
            authType: RPKI_AUTH_TYPES.TCP_AO,
            tcpAoProfileId: 'router-a'
        });
        const candidateProfiles = profiles
            .filter(item => item.id !== 'router-b')
            .map(item => ({ ...item, name: 'Router A edited while referenced' }));

        const response = await rpkiApp.handleSaveTcpAoSettings(null, { profiles: candidateProfiles });
        assert.equal(response.status, 'success', response.msg);
        assert.deepEqual(
            response.data.profiles.map(item => item.id),
            ['router-a'],
            'an unreferenced profile should remain deletable'
        );
        assert.equal(
            response.data.profiles[0].name,
            'Router A edited while referenced',
            'editing a referenced profile without changing its ID should remain allowed'
        );
    }

    {
        const { programStore, rpkiApp, profiles } = await createProfileDependencyFixture();
        programStore.set('rpki-config', {
            authType: RPKI_AUTH_TYPES.NONE,
            tcpAoProfileId: 'router-a'
        });
        programStore.set('bmp-config', {
            authType: BMP_AUTH_TYPES.NONE,
            tcpAoProfileIds: ['router-a'],
            tcpAoProfileId: 'router-a'
        });

        const response = await rpkiApp.handleSaveTcpAoSettings(null, {
            profiles: profiles.filter(item => item.id !== 'router-a')
        });
        assert.equal(response.status, 'success', response.msg);
        assert.deepEqual(
            response.data.profiles.map(item => item.id),
            ['router-b'],
            'stale profile IDs under authType none must not block deletion'
        );
    }
}

async function main() {
    const expectedPackagedRenderer = path.resolve(__dirname, '../../dist/index.html');
    assert.equal(RpkiApp.PACKAGED_RENDERER_PATH, expectedPackagedRenderer);
    assert.equal(
        RpkiApp.isTrustedRpkiRendererUrl(pathToFileURL(expectedPackagedRenderer).href, {
            isPackaged: true
        }),
        true
    );
    assert.equal(
        RpkiApp.isTrustedRpkiRendererUrl(
            pathToFileURL(path.resolve(__dirname, '../../electron/dist/index.html')).href,
            {
                isPackaged: true
            }
        ),
        false
    );
    assert.equal(RpkiApp.isTrustedRpkiRendererUrl('http://127.0.0.1:3000/rpki', { isPackaged: false }), true);
    assert.equal(RpkiApp.isTrustedRpkiRendererUrl('http://localhost:3000/rpki', { isPackaged: false }), false);

    const boundaryIpc = new FakeIpcMain();
    const trustedMainFrame = { url: `${pathToFileURL(expectedPackagedRenderer).href}#/rpki/rpki-config` };
    const trustedWebContents = {
        mainFrame: trustedMainFrame,
        getURL: () => trustedMainFrame.url
    };
    const ownerWindow = { isDestroyed: () => false };
    const browserWindow = {
        fromWebContents: sender => (sender?.withoutOwner ? null : ownerWindow)
    };
    new RpkiApp(boundaryIpc, new MemoryStore(), {
        primaryWebContents: trustedWebContents,
        browserWindow,
        appIsPackaged: true,
        credentialStore: new FakeCredentialStore()
    });
    const trustedLoadHandler = boundaryIpc.handlers.get('rpki:loadRpkiConfig');
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
    trustedMainFrame.url = 'file:///tmp/untrusted/index.html#/rpki';
    await assert.rejects(
        async () => trustedLoadHandler({ sender: trustedWebContents, senderFrame: trustedMainFrame }),
        /非应用页面/
    );
    trustedMainFrame.url = originalTrustedUrl;

    const rawStore = new MemoryStore();
    const settings = new TcpAoSettingsStore(rawStore, new FakeCredentialStore());

    const saved = settings.saveSettings({ profiles: [profile()] });
    assert.equal(saved.profiles.length, 1);
    assert.equal(saved.profiles[0].keys[0].hasSavedKey, true);
    assert.equal(saved.profiles[0].keys[0].savedKeyStatus, 'available');
    assert.equal(Object.prototype.hasOwnProperty.call(saved.profiles[0].keys[0], 'key'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(saved.profiles[0].keys[0], 'keyEncrypted'), false);

    const raw = rawStore.get('rpki-tcp-ao-settings');
    assert.equal(JSON.stringify(raw).includes('correct horse battery staple'), false, 'plaintext key reached storage');
    assert.match(raw.profiles[0].keys[0].keyEncrypted, /^encrypted:/);

    const runtime = settings.getRuntimeProfile('router-a');
    assert.equal(runtime.keys[0].key, 'correct horse battery staple');
    assert.equal(runtime.family, 4);
    assert.equal(runtime.address, '192.0.2.1');

    settings.saveSettings({
        profiles: [
            {
                ...saved.profiles[0],
                name: 'Router A renamed',
                keys: saved.profiles[0].keys.map(key => ({ ...key, key: '' }))
            }
        ]
    });
    assert.equal(settings.getRuntimeProfile('router-a').keys[0].key, 'correct horse battery staple');
    assert.equal(settings.listProfiles().profiles[0].name, 'Router A renamed');
    assert.throws(
        () =>
            settings.saveSettings({
                profiles: [
                    {
                        ...settings.listProfiles().profiles[0],
                        keys: settings.listProfiles().profiles[0].keys.map(key => ({
                            ...key,
                            algorithm: 'hmac(sha256)',
                            key: ''
                        }))
                    }
                ]
            }),
        /更换算法.*重新输入密钥/
    );

    const corruptStore = new MemoryStore();
    const corruptSettings = new TcpAoSettingsStore(corruptStore, new FakeCredentialStore());
    corruptStore.set('rpki-tcp-ao-settings', {
        version: 1,
        profiles: [
            {
                ...raw.profiles[0],
                keys: [{ ...raw.profiles[0].keys[0], keyEncrypted: 'damaged-ciphertext' }]
            }
        ]
    });
    const unavailableKey = corruptSettings.listProfiles().profiles[0].keys[0];
    assert.equal(unavailableKey.hasSavedKey, false);
    assert.equal(unavailableKey.savedKeyStatus, 'unavailable');
    assert.throws(
        () =>
            corruptSettings.saveSettings({
                profiles: [
                    {
                        ...corruptSettings.listProfiles().profiles[0],
                        keys: [{ ...unavailableKey, key: '' }]
                    }
                ]
            }),
        /无法读取.*重新输入密钥/
    );

    assert.throws(
        () => settings.saveSettings({ profiles: [profile({ id: 'a' }), profile({ id: 'a', name: 'B' })] }),
        /ID重复/
    );
    assert.throws(
        () =>
            normalizeTcpAoProfile(profile({ keys: [{ ...profile().keys[0], algorithm: 'cmac(aes)', key: 'short' }] }), {
                requireKey: true
            }),
        /16字节/
    );
    assert.throws(
        () =>
            normalizeTcpAoProfile(
                profile({
                    keys: [
                        {
                            ...profile().keys[0],
                            acceptStart: 100,
                            sendStart: 200,
                            sendEnd: 400,
                            acceptEnd: 300
                        }
                    ]
                }),
                { requireKey: true }
            ),
        /接收开始.*发送开始.*发送结束.*接收结束/
    );
    assert.throws(
        () =>
            normalizeTcpAoProfile(profile({ keys: [{ ...profile().keys[0], sendStart: '-1' }] }), { requireKey: true }),
        /带时区/
    );
    assert.throws(
        () =>
            normalizeTcpAoProfile(profile({ keys: [{ ...profile().keys[0], sendStart: '2099-01-01T00:00:00' }] }), {
                requireKey: true
            }),
        /带时区/
    );
    assert.equal(
        normalizeTcpAoProfile(profile({ keys: [{ ...profile().keys[0], sendStart: '2099-01-01T00:00:00Z' }] }), {
            requireKey: true
        }).keys[0].sendStart,
        4_070_908_800
    );
    assert.throws(() => normalizeTcpAoProfile(profile({ peer: 'not-an-ip' }), { requireKey: true }), /对端/);
    assert.throws(() => normalizeTcpAoProfile(profile({ peer: '192.0.2.1/24' }), { requireKey: true }), /主机位/);
    assert.throws(
        () => normalizeTcpAoProfile(profile({ peer: 'fe80::1%eth0/128' }), { requireKey: true }),
        /zone|scope/
    );
    assert.throws(() => normalizeTcpAoProfile(profile({ peer: '::ffff:192.0.2.1/128' }), { requireKey: true }), /映射/);
    assert.throws(
        () =>
            normalizeTcpAoProfile(profile({ keys: [{ ...profile().keys[0], sendStart: '2025-02-29T00:00:00Z' }] }), {
                requireKey: true
            }),
        /格式无效/
    );
    const byteIdBoundary = normalizeTcpAoProfile(
        profile({ keys: [{ ...profile().keys[0], sndId: 255, rcvId: 0, key: 'x'.repeat(80) }] }),
        { requireKey: true }
    );
    assert.equal(byteIdBoundary.keys[0].sndId, 255);
    assert.equal(byteIdBoundary.keys[0].rcvId, 0);
    assert.throws(
        () => normalizeTcpAoProfile(profile({ keys: [{ ...profile().keys[0], sndId: 256 }] }), { requireKey: true }),
        /0-255/
    );
    assert.throws(
        () =>
            normalizeTcpAoProfile(profile({ keys: [{ ...profile().keys[0], key: 'x'.repeat(81) }] }), {
                requireKey: true
            }),
        /80字节/
    );
    assert.throws(
        () =>
            normalizeTcpAoProfile(profile({ keys: [{ ...profile().keys[0], key: 'bad\0key' }] }), { requireKey: true }),
        /NUL/
    );
    assert.throws(
        () => normalizeTcpAoProfile(profile({ keys: [{ ...profile().keys[0], macLength: 21 }] }), { requireKey: true }),
        /4-20/
    );
    const now = Math.floor(Date.now() / 1000);
    const rotating = normalizeTcpAoProfile(
        profile({
            keys: [
                {
                    ...profile().keys[0],
                    id: 'key-current',
                    sndId: 10,
                    rcvId: 20,
                    sendEnd: now + 3600,
                    acceptEnd: now + 7200
                },
                {
                    ...profile().keys[0],
                    id: 'key-next',
                    sndId: 11,
                    rcvId: 21,
                    acceptStart: now,
                    sendStart: now + 3600,
                    sendEnd: null,
                    acceptEnd: null
                }
            ]
        }),
        { requireKey: true }
    );
    assert.equal(assertContinuousRotationSchedule(rotating, now).id, 'key-current');
    const switchTime = rotating.keys[0].sendEnd;
    assert.equal(assertCurrentSendKey(rotating, switchTime - 1).id, 'key-current');
    assert.equal(isKeySendActive(rotating.keys[0], switchTime), false);
    assert.equal(isKeySendActive(rotating.keys[1], switchTime), true);
    assert.equal(assertCurrentSendKey(rotating, switchTime).id, 'key-next');
    const scheduleWithGap = JSON.parse(JSON.stringify(rotating));
    scheduleWithGap.keys[1].sendStart += 1;
    assert.throws(() => assertContinuousRotationSchedule(scheduleWithGap, now), /不能存在空档/);
    const finiteFinalSchedule = JSON.parse(JSON.stringify(rotating));
    finiteFinalSchedule.keys[1].sendEnd = now + 7200;
    finiteFinalSchedule.keys[1].acceptEnd = now + 7800;
    assert.equal(assertContinuousRotationSchedule(finiteFinalSchedule, now).id, 'key-current');
    const defaultRpkiAuth = normalizeRpkiAuthenticationSelection({});
    assert.deepEqual(
        { authType: defaultRpkiAuth.authType, tcpAoProfileId: defaultRpkiAuth.tcpAoProfileId },
        { authType: RPKI_AUTH_TYPES.NONE, tcpAoProfileId: '' }
    );
    assert.throws(
        () => normalizeRpkiAuthenticationSelection({ authType: RPKI_AUTH_TYPES.TCP_AO, tcpAoProfileId: '' }),
        /配置ID|Profile ID/
    );
    assert.equal(redactTcpAoConfig(runtime).keys[0].key, '<redacted>');
    const summarized = new WorkerMessageHandler({ parentEndpoint: {} }).summarizeMessage({
        messageId: 'secret-test',
        data: { tcpAo: runtime }
    });
    assert.equal(summarized.data.tcpAo.keys, '[Array(1)]');

    const ipc = new FakeIpcMain();
    const programStore = new MemoryStore();
    const credentialStore = new FakeCredentialStore();
    const rpkiApp = new RpkiApp(ipc, programStore, { credentialStore, platform: 'linux' });
    const saveSettingsResponse = await rpkiApp.handleSaveTcpAoSettings(null, { profiles: [profile()] });
    assert.equal(saveSettingsResponse.status, 'success', saveSettingsResponse.msg);
    assert.equal(credentialStore.initializationCalls, 1);
    const loadedSettings = await rpkiApp.handleLoadTcpAoSettings();
    assert.equal(credentialStore.initializationCalls, 2);
    assert.equal(loadedSettings.data.profiles[0].keys[0].hasSavedKey, true);
    assert.equal(Object.prototype.hasOwnProperty.call(loadedSettings.data.profiles[0].keys[0], 'key'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loadedSettings.data.profiles[0].keys[0], 'keyEncrypted'), false);

    const rpkiConfig = {
        port: 8282,
        authType: RPKI_AUTH_TYPES.TCP_AO,
        tcpAoProfileId: 'router-a',
        key: 'renderer-injected-top-level-secret',
        keyEncrypted: 'renderer-injected-ciphertext',
        unexpectedRuntimeOption: 'renderer-injected-option',
        tcpAo: { key: 'renderer-injected-secret' }
    };
    const saveRpkiResponse = await rpkiApp.handleSaveRpkiConfig(null, rpkiConfig);
    assert.equal(saveRpkiResponse.status, 'success');
    const storedRpkiConfig = programStore.get('rpki-config');
    assert.equal(Object.prototype.hasOwnProperty.call(storedRpkiConfig, 'tcpAo'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(storedRpkiConfig, 'key'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(storedRpkiConfig, 'keyEncrypted'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(storedRpkiConfig, 'unexpectedRuntimeOption'), false);
    const missingProfileSaveResponse = await rpkiApp.handleSaveRpkiConfig(null, {
        ...rpkiConfig,
        tcpAoProfileId: 'missing-router'
    });
    assert.equal(missingProfileSaveResponse.status, 'error');
    assert.match(missingProfileSaveResponse.msg, /TCP-AO.*不存在|不存在.*TCP-AO/);
    assert.deepEqual(
        programStore.get('rpki-config'),
        storedRpkiConfig,
        'a missing TCP-AO profile must not replace the last valid RPKI configuration'
    );
    programStore.set('rpki-config', {
        ...storedRpkiConfig,
        key: 'legacy-top-level-secret',
        keyEncrypted: 'legacy-ciphertext',
        tcpAo: { key: 'legacy-nested-secret' }
    });
    const loadedRpkiResponse = await rpkiApp.handleLoadRpkiConfig();
    assert.equal(Object.prototype.hasOwnProperty.call(loadedRpkiResponse.data, 'key'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loadedRpkiResponse.data, 'keyEncrypted'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loadedRpkiResponse.data, 'tcpAo'), false);

    let startPayload = null;
    let runtimeReloadPayload = null;
    let exitHandler = null;
    const fakeWorker = {
        addEventListener() {},
        removeEventListener() {},
        async sendRequest(operation, payload) {
            if (operation === RpkiConst.RPKI_REQ_TYPES.START_RPKI) {
                startPayload = payload;
                return { status: 'success', data: null, msg: 'started' };
            }
            if (operation === RpkiConst.RPKI_REQ_TYPES.STOP_RPKI) {
                return { status: 'success', data: null, msg: 'stopped' };
            }
            if (operation === RpkiConst.RPKI_REQ_TYPES.RELOAD_TCP_AO_PROFILE) {
                runtimeReloadPayload = clone(payload);
                return { status: 'success', data: { disconnectedConnections: 1 }, msg: 'reloaded' };
            }
            throw new Error(`Unexpected operation ${operation}`);
        },
        async terminate() {
            exitHandler?.(0, fakeWorker);
        }
    };
    rpkiApp.getRpkiDatabasePath = () => '/tmp/netnexus-test-rpki.sqlite3';
    rpkiApp.createRpkiProcess = (_workerPath, options) => {
        exitHandler = options.onExit;
        return fakeWorker;
    };
    const startResponse = await rpkiApp.handleStartRpki(null, rpkiConfig);
    assert.equal(startResponse.status, 'success', startResponse.msg);
    assert.equal(startPayload.tcpAo.keys[0].key, 'correct horse battery staple');
    assert.notEqual(startPayload.tcpAo.keys[0].key, rpkiConfig.tcpAo.key);
    assert.equal(Object.prototype.hasOwnProperty.call(startPayload, 'key'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(startPayload, 'unexpectedRuntimeOption'), false);
    assert.equal(startPayload.tcpAo.family, 4);
    const liveRendererProfiles = clone((await rpkiApp.handleLoadTcpAoSettings()).data.profiles);
    liveRendererProfiles[0].keys[0].key = 'live replacement secret';
    const liveSaveResponse = await rpkiApp.handleSaveTcpAoSettings(null, { profiles: liveRendererProfiles });
    assert.equal(liveSaveResponse.status, 'success', liveSaveResponse.msg);
    assert.equal(runtimeReloadPayload.profile.keys[0].key, 'live replacement secret');
    assert.equal(liveSaveResponse.data.runtimeReload.disconnectedConnections, 1);
    const stopResponse = await rpkiApp.handleStopRpki();
    assert.equal(stopResponse.status, 'success', stopResponse.msg);

    await testReferencedProfileDeletionGuards();
    await testProfileDependencyGuardAllowsSafeSaves();
    await testRuntimeReloadSuccessSummary();
    await testRuntimeReloadFailureRollsBackEveryConsumerAndStorage();
    await testRuntimeRollbackFailureStopsService();
    await testPersistenceRestoreFailureStopsAllRuntimeConsumers();
    await testRuntimeSettingsSavesAreSerialized();
    await testSettingsSaveThenTcpAoStartUsesCommittedPlan();
    await testTcpAoStartThenSettingsSaveReloadsStartedService();
    await testReloadFailureCancelsQueuedStartWithoutGateDeadlock();

    console.log('TCP-AO settings tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
