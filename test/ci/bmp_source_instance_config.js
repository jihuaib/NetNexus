const assert = require('node:assert/strict');
const BmpApp = require('../../electron/app/bmpApp');
const BmpConst = require('../../electron/const/bmpConst');
const BmpIngestClientPool = require('../../electron/worker/bmp/bmpIngestClientPool');
const { normalizeSourceInstanceConfig } = require('../../shared/bmpSourceInstance');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpWorker = loadBmpWorkerClass(__dirname, module);
const DEFAULT_CONFIG = {
    sourceInstanceTemplate: 'h3c',
    sourceInstanceTlvType: 0,
    sourceInstanceCustomTemplate: 'bgp instance name:{instance}'
};
const VALID_CONFIGS = [
    {},
    { sourceInstanceTemplate: 'fullValue', sourceInstanceTlvType: 65535 },
    {
        sourceInstanceTemplate: 'custom',
        sourceInstanceTlvType: '32768',
        sourceInstanceCustomTemplate: 'BGP [instance] = {instance} (active)'
    }
];
const INVALID_CONFIGS = [
    { sourceInstanceTemplate: 'unknown' },
    { sourceInstanceTemplate: null },
    ...[null, -1, 65536, 1.5, '', ' ', '1.5', true, [], {}, Number.NaN].map(sourceInstanceTlvType => ({
        sourceInstanceTlvType
    })),
    ...['', 'no placeholder', '{instance}/{instance}', 'prefix\n{instance}', 'x'.repeat(1025) + '{instance}'].map(
        sourceInstanceCustomTemplate => ({ sourceInstanceTemplate: 'custom', sourceInstanceCustomTemplate })
    )
];

function config(overrides = {}) {
    return { port: '11019', threadCount: 1, authType: 'none', logLevel: 'off', ...overrides };
}

function sourceConfig(value) {
    return Object.fromEntries(Object.keys(DEFAULT_CONFIG).map(key => [key, value[key]]));
}

function createAppFixture() {
    const values = new Map();
    let writes = 0;
    const store = {
        get: key => values.get(key),
        set(key, value) {
            writes += 1;
            values.set(key, JSON.parse(JSON.stringify(value)));
        }
    };
    const handlers = new Map();
    const mainFrame = { url: 'http://127.0.0.1:3000/#/bmp' };
    const sender = { mainFrame, getURL: () => mainFrame.url };
    const app = new BmpApp({ handle: (name, handler) => handlers.set(name, handler) }, store, {
        primaryWebContents: sender,
        browserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
        appIsPackaged: false
    });
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
    return {
        app,
        store,
        values,
        calls,
        writes: () => writes,
        createdWorkers: () => createdWorkers,
        closedReaders: () => closedReaders,
        request: (name, payload) => handlers.get(`bmp:${name}`)({ sender, senderFrame: mainFrame }, payload)
    };
}

async function testConfigIpcRoundTrip() {
    assert.deepEqual(normalizeSourceInstanceConfig({}), DEFAULT_CONFIG);
    for (const input of VALID_CONFIGS) {
        const fixture = createAppFixture();
        const expected = normalizeSourceInstanceConfig(input);
        const saved = await fixture.request('saveBmpConfig', config(input));
        assert.equal(saved.status, 'success', saved.msg);
        assert.deepEqual(sourceConfig(fixture.store.get('bmp-config')), expected);
        const loaded = await fixture.request('loadBmpConfig');
        assert.equal(loaded.status, 'success', loaded.msg);
        assert.deepEqual(sourceConfig(loaded.data), expected);
        const started = await fixture.request('startBmp', loaded.data);
        assert.equal(started.status, 'success', started.msg);
        const start = fixture.calls.find(call => call.operation === BmpConst.BMP_REQ_TYPES.START_BMP);
        assert.deepEqual(sourceConfig(start.payload), expected);
        assert.equal((await fixture.request('stopBmp')).status, 'success');
    }

    const fixture = createAppFixture();
    fixture.values.set('bmp-config', config());
    const loaded = await fixture.request('loadBmpConfig');
    assert.deepEqual(sourceConfig(loaded.data), DEFAULT_CONFIG, 'old saved configs receive the H3C defaults');
    assert.equal(fixture.writes(), 0, 'loading defaults must not rewrite saved settings');

    assert.equal((await fixture.request('startBmp', loaded.data)).status, 'success');
    const firstStart = fixture.calls.find(call => call.operation === BmpConst.BMP_REQ_TYPES.START_BMP);
    assert.equal((await fixture.request('saveBmpConfig', config(VALID_CONFIGS[2]))).status, 'success');
    assert.equal(fixture.calls.length, 1, 'saving settings must not alter active parser workers');
    assert.deepEqual(sourceConfig(firstStart.payload), DEFAULT_CONFIG);
    assert.equal((await fixture.request('stopBmp')).status, 'success');
    const next = await fixture.request('loadBmpConfig');
    assert.equal((await fixture.request('startBmp', next.data)).status, 'success');
    const starts = fixture.calls.filter(call => call.operation === BmpConst.BMP_REQ_TYPES.START_BMP);
    assert.deepEqual(sourceConfig(starts[1].payload), normalizeSourceInstanceConfig(VALID_CONFIGS[2]));
    assert.equal((await fixture.request('stopBmp')).status, 'success');
}

async function testInvalidConfigBoundaries() {
    const fixture = createAppFixture();
    assert.equal((await fixture.request('saveBmpConfig', config())).status, 'success');
    const savedConfig = fixture.store.get('bmp-config');
    const writes = fixture.writes();
    for (const invalid of INVALID_CONFIGS) {
        const rejectedSave = await fixture.request('saveBmpConfig', config(invalid));
        assert.equal(rejectedSave.status, 'error', `saved invalid config ${JSON.stringify(invalid)}`);
        assert.ok(rejectedSave.msg);
        assert.equal(fixture.store.get('bmp-config'), savedConfig);
        const rejectedStart = await fixture.request('startBmp', config(invalid));
        assert.equal(rejectedStart.status, 'error', `started invalid config ${JSON.stringify(invalid)}`);
        assert.equal(fixture.app.worker, null);
        assert.throws(() => new BmpIngestClientPool({ threadCount: 1, config: invalid }));

        fixture.values.set('bmp-config', config(invalid));
        assert.equal((await fixture.request('loadBmpConfig')).status, 'error');
        fixture.values.set('bmp-config', savedConfig);
    }
    assert.equal(fixture.writes(), writes);
    assert.equal(fixture.createdWorkers(), 0);
    assert.equal(fixture.closedReaders(), 0, 'invalid settings must not disturb the offline database reader');
    assert.equal(fixture.calls.length, 0);
}

async function testWorkerRuntimeBoundary() {
    for (const input of [...VALID_CONFIGS, ...INVALID_CONFIGS]) {
        const errors = [];
        let persistenceStarts = 0;
        let serverStarts = 0;
        const worker = Object.create(BmpWorker.prototype);
        Object.assign(worker, {
            bmpConfigData: null,
            messageHandler: { sendErrorResponse: (_id, message) => errors.push(message) },
            async initializePersistence() {
                persistenceStarts += 1;
            },
            async startTcpServer() {
                serverStarts += 1;
            }
        });
        try {
            await worker.startBmp('source-instance-config', config(input));
            if (INVALID_CONFIGS.includes(input)) {
                assert.equal(errors.length, 1, `worker accepted ${JSON.stringify(input)}`);
                assert.equal(worker.bmpConfigData, null);
                assert.equal(persistenceStarts, 0);
                assert.equal(serverStarts, 0);
                assert.equal(worker.ingestPool, undefined);
            } else {
                assert.deepEqual(errors, []);
                assert.equal(persistenceStarts, 1);
                assert.equal(serverStarts, 1);
                assert.deepEqual(sourceConfig(worker.bmpConfigData), normalizeSourceInstanceConfig(input));
                assert.deepEqual(sourceConfig(worker.ingestPool.config), normalizeSourceInstanceConfig(input));
                assert.equal(worker.ingestPool.getStatus().ingestWorkerCount, 1);
            }
        } finally {
            await worker.ingestPool?.close();
        }
    }
}

async function testParserWorkerReceivesCustomConfig() {
    const results = [];
    const failures = [];
    const pool = new BmpIngestClientPool({
        threadCount: 1,
        config: VALID_CONFIGS[2],
        onResult: (_record, result) => results.push(result),
        onError: error => failures.push(error)
    });
    const session = {
        persistenceConnectionId: 'source-instance-config',
        persistenceConnectionGeneration: 1,
        persistenceOpenedAtMs: Date.now(),
        socket: { pause() {}, resume() {}, destroy() {} }
    };
    try {
        await pool.open();
        const record = pool.attach(session, {
            sessionKey: '127.0.0.1|11019|192.0.2.10|52000',
            metadata: { localIp: '127.0.0.1', localPort: 11019, remoteIp: '192.0.2.10', remotePort: 52000 }
        });
        assert.ok(record);
        const value = Buffer.from('BGP [instance] = vpn-blue (active)', 'utf8');
        const packet = Buffer.alloc(6 + 4 + 4 + value.length);
        packet.writeUInt8(3, 0);
        packet.writeUInt32BE(packet.length, 1);
        packet.writeUInt8(BmpConst.BMP_MSG_TYPE.INITIATION, 5);
        packet.writeUInt16BE(32768, 6);
        packet.writeUInt16BE(4 + value.length, 8);
        packet.writeUInt32BE(25506, 10);
        value.copy(packet, 14);
        assert.equal(pool.send(record, packet), true);
        await pool.fence();
        assert.deepEqual(failures, []);
        const parsed = results.find(result => result.snapshot?.session?.bgpInstanceName);
        assert.ok(parsed, 'custom Initiation template must reach the parser worker through workerData');
        assert.equal(parsed.snapshot.session.bgpInstanceName, 'vpn-blue');
    } finally {
        await pool.close();
    }
}

(async () => {
    await testConfigIpcRoundTrip();
    await testInvalidConfigBoundaries();
    await testWorkerRuntimeBoundary();
    await testParserWorkerReceivesCustomConfig();
    console.log('BMP source instance config IPC, defaults, validation and worker propagation tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
