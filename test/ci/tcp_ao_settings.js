const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const TcpAoSettingsStore = require('../../electron/utils/tcpAoSettingsStore');
const RpkiApp = require('../../electron/app/rpkiApp');
const RpkiConst = require('../../electron/const/rpkiConst');
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
const {
    RPKI_AUTH_TYPES,
    normalizeRpkiAuthSelection,
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
    assert.deepEqual(normalizeRpkiAuthSelection({}), { authType: RPKI_AUTH_TYPES.NONE, tcpAoProfileId: '' });
    assert.throws(() => normalizeRpkiAuthSelection({ authType: RPKI_AUTH_TYPES.TCP_AO, tcpAoProfileId: '' }), /配置ID/);
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
    const stopResponse = await rpkiApp.handleStopRpki();
    assert.equal(stopResponse.status, 'success', stopResponse.msg);

    console.log('TCP-AO settings tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
