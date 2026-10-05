const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const BmpApp = require('../../electron/app/bmpApp');
const BmpConst = require('../../electron/const/bmpConst');
const {
    DEFAULT_BMP_THREAD_COUNT,
    MAX_BMP_THREAD_COUNT,
    normalizeBmpThreadCount
} = require('../../electron/utils/bmp/bmpThreadConfig');

const INVALID_THREAD_COUNTS = [
    0,
    -1,
    17,
    3.2,
    '',
    ' ',
    '3.2',
    '4.0',
    'not-a-number',
    true,
    false,
    [],
    [4],
    {},
    Number.NaN,
    Number.POSITIVE_INFINITY,
    4n
];
const THREAD_COUNT_ERROR = /BMP处理线程数必须是1-16之间的整数/;

class MemoryStore {
    constructor() {
        this.values = new Map();
        this.writes = 0;
    }

    get(key) {
        return this.values.get(key);
    }

    set(key, value) {
        this.writes += 1;
        this.values.set(key, value);
    }
}

function config(overrides = {}) {
    return {
        port: '11019',
        bmpV4TlvDraft: 20,
        pathMarkingTlvType: 8,
        persistenceEnabled: true,
        authType: 'none',
        ...overrides
    };
}

function createAppFixture() {
    const store = new MemoryStore();
    const app = new BmpApp({ handle() {} }, store);
    const calls = [];
    let createdWorkers = 0;
    let closedReaders = 0;
    app.closeOfflinePersistenceReader = async () => {
        closedReaders += 1;
    };
    app.createBmpProcess = () => {
        createdWorkers += 1;
        return {
            addEventListener() {},
            removeEventListener() {},
            async sendRequest(operation, payload) {
                calls.push({ operation, payload });
                return { status: 'success', data: null, msg: 'ok' };
            },
            async terminate() {}
        };
    };
    return { app, store, calls, createdWorkers: () => createdWorkers, closedReaders: () => closedReaders };
}

function loadRendererValidation(relativePath) {
    const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.join(__dirname, '..', '..'));
    const sourcePath = path.join(projectRoot, 'src', 'utils', relativePath);
    const result = esbuild.buildSync({
        entryPoints: [sourcePath],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        write: false
    });
    const loaded = new Module(sourcePath, module);
    loaded.filename = sourcePath;
    loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
    loaded._compile(result.outputFiles[0].text, sourcePath);
    return loaded.exports;
}

function testNormalizationAndRendererValidation() {
    assert.equal(DEFAULT_BMP_THREAD_COUNT, 4);
    assert.equal(MAX_BMP_THREAD_COUNT, 16);
    for (const [value, expected] of [
        [undefined, 4],
        [null, 4],
        [1, 1],
        [4, 4],
        [16, 16],
        ['1', 1],
        [' 16 ', 16]
    ]) {
        assert.equal(normalizeBmpThreadCount(value), expected);
        assert.equal(BmpApp.normalizeBmpConfig(config({ threadCount: value })).threadCount, expected);
    }
    for (const value of INVALID_THREAD_COUNTS) {
        assert.throws(() => normalizeBmpThreadCount(value), THREAD_COUNT_ERROR, `accepted ${String(value)}`);
        assert.throws(() => BmpApp.normalizeBmpConfig(config({ threadCount: value })), THREAD_COUNT_ERROR);
    }

    const { FormValidator } = loadRendererValidation('validationCommon.js');
    const { createBmpConfigValidationRules } = loadRendererValidation('bmp/validationRules.js');
    const errors = { value: {} };
    const validator = new FormValidator(errors, 0);
    validator.addRules(createBmpConfigValidationRules());
    for (const value of [1, 4, 16, '1', ' 16 ']) {
        assert.equal(validator.validate(config({ threadCount: value })), false);
    }
    for (const value of [...INVALID_THREAD_COUNTS, undefined, null]) {
        assert.equal(validator.validate(config({ threadCount: value })), true);
        assert.match(errors.value.threadCount, /处理线程数|1-16/);
    }
}

async function testSaveLoadAndInvalidRuntimeBoundaries() {
    const { app, store, calls, createdWorkers, closedReaders } = createAppFixture();
    assert.equal((await app.handleLoadBmpConfig()).data, null);
    for (const value of [undefined, null, 1, 16, '16']) {
        const saved = await app.handleSaveBmpConfig(null, config({ threadCount: value }));
        assert.equal(saved.status, 'success', saved.msg);
        const expected = normalizeBmpThreadCount(value);
        assert.equal(store.get('bmp-config').threadCount, expected);
        const loaded = await app.handleLoadBmpConfig();
        assert.equal(loaded.status, 'success', loaded.msg);
        assert.equal(loaded.data.threadCount, expected);
    }

    const lastSaved = store.get('bmp-config');
    const writes = store.writes;
    for (const value of INVALID_THREAD_COUNTS) {
        const saved = await app.handleSaveBmpConfig(null, config({ threadCount: value }));
        assert.equal(saved.status, 'error', `saved ${String(value)}`);
        assert.match(saved.msg, THREAD_COUNT_ERROR);
        assert.equal(store.get('bmp-config'), lastSaved, 'invalid input replaced the saved configuration');
        const started = await app.handleStartBmp(null, config({ threadCount: value }));
        assert.equal(started.status, 'error', `started ${String(value)}`);
        assert.match(started.msg, THREAD_COUNT_ERROR);
        assert.equal(app.worker, null);
    }
    assert.equal(store.writes, writes, 'invalid input must not write any configuration');
    assert.equal(createdWorkers(), 0, 'invalid thread counts must be rejected before creating a BMP process');
    assert.equal(closedReaders(), 0, 'invalid thread counts must not disturb the offline reader');
    assert.equal(calls.length, 0);

    for (const value of INVALID_THREAD_COUNTS) {
        const invalidPersistedConfig = config({ threadCount: value });
        store.values.set('bmp-config', invalidPersistedConfig);
        const loaded = await app.handleLoadBmpConfig();
        assert.equal(loaded.status, 'error', `loaded ${String(value)}`);
        assert.match(loaded.msg, THREAD_COUNT_ERROR);
        assert.equal(store.get('bmp-config'), invalidPersistedConfig, 'loading must not rewrite invalid data');
    }
    store.values.set('bmp-config', config());
    assert.equal((await app.handleLoadBmpConfig()).data.threadCount, DEFAULT_BMP_THREAD_COUNT);
    assert.equal(store.get('bmp-config').threadCount, undefined, 'loading old config must not write it back');
}

async function testRuntimeCountAndNextStartSemantics() {
    for (const value of [undefined, null, 1, 16]) {
        const { app, calls } = createAppFixture();
        const result = await app.handleStartBmp(null, config({ threadCount: value }));
        assert.equal(result.status, 'success', result.msg);
        const start = calls.find(call => call.operation === BmpConst.BMP_REQ_TYPES.START_BMP);
        assert.equal(start.payload.threadCount, normalizeBmpThreadCount(value));
        assert.equal((await app.handleStopBmp()).status, 'success');
    }

    const { app, store, calls } = createAppFixture();
    const injected = config({
        threadCount: 3,
        key: 'secret-not-config',
        keyEncrypted: 'encrypted-not-config',
        tcpAoProfiles: [{ key: 'secret-not-config' }],
        tcpMd5Profiles: [{ key: 'secret-not-config' }]
    });
    assert.equal((await app.handleSaveBmpConfig(null, injected)).status, 'success');
    const loaded = await app.handleLoadBmpConfig();
    assert.equal(loaded.data.threadCount, 3);
    assert.equal(JSON.stringify(store.get('bmp-config')).includes('not-config'), false);
    assert.equal((await app.handleStartBmp(null, loaded.data)).status, 'success');
    const runningPayload = calls[0].payload;
    assert.equal(runningPayload.threadCount, 3);
    assert.equal(JSON.stringify(runningPayload).includes('not-config'), false);

    assert.equal((await app.handleSaveBmpConfig(null, config({ threadCount: 16 }))).status, 'success');
    assert.equal(calls.length, 1, 'saving a thread count must not reconfigure the active BMP process');
    assert.equal(runningPayload.threadCount, 3);
    const nextConfig = await app.handleLoadBmpConfig();
    assert.equal(nextConfig.data.threadCount, 16);
    assert.equal((await app.handleStopBmp()).status, 'success');
    assert.equal((await app.handleStartBmp(null, nextConfig.data)).status, 'success');
    const starts = calls.filter(call => call.operation === BmpConst.BMP_REQ_TYPES.START_BMP);
    assert.deepEqual(
        starts.map(call => call.payload.threadCount),
        [3, 16]
    );
    assert.equal((await app.handleStopBmp()).status, 'success');
}

async function main() {
    testNormalizationAndRendererValidation();
    await testSaveLoadAndInvalidRuntimeBoundaries();
    await testRuntimeCountAndNextStartSemantics();
    console.log('BMP thread count configuration tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
