const assert = require('node:assert/strict');
const Module = require('node:module');

function loadSystemApp() {
    const originalLoad = Module._load;
    const dialogStub = {
        showMessageBox: async () => ({ response: 0 })
    };
    const loggerStub = { warn() {}, error() {}, info() {} };
    const stubbedApps = new Set([
        './bgpApp',
        './toolsApp',
        './bmpApp',
        './rpkiApp',
        './ftpApp',
        './snmpApp',
        './dhcpApp',
        './ntpApp',
        './radiusApp',
        './tftpApp',
        './syslogApp',
        './grpcApp',
        './yangApp',
        './netconfApp',
        './updater',
        './nativeApp',
        './externalApiServer',
        './cli',
        './wiresharkPluginInstaller'
    ]);
    class DummyDependency {}

    Module._load = function loadWithStubs(request, parent, isMain) {
        if (request === 'electron') {
            return {
                app: { isPackaged: false, getPath: () => process.cwd() },
                dialog: dialogStub,
                BrowserWindow: {}
            };
        }
        if (request === 'electron-store') return DummyDependency;
        if (request === '../log/logger') return loggerStub;
        if (request === './bmpApiRoutes') return () => [];
        if (stubbedApps.has(request)) return DummyDependency;
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        return { SystemApp: require('../../electron/app/systemApp'), dialogStub };
    } finally {
        Module._load = originalLoad;
    }
}

function protocolApp(name, trace, running = false, options = {}) {
    return {
        [`get${name}Running`]: () => running,
        [`handleStop${name}`]: async () => {
            trace.push(`${name}:stop`);
            if (options.stopError) throw options.stopError;
        }
    };
}

function createHarness(SystemApp, options = {}) {
    const trace = [];
    const app = Object.create(SystemApp.prototype);
    app.win = {};
    app.windowClosePromise = null;
    app.shutdownPromise = null;
    app.shutdownStepTimeoutMs = options.shutdownStepTimeoutMs || 50;
    app.bmpShutdownStepTimeoutMs = options.bmpShutdownStepTimeoutMs || app.shutdownStepTimeoutMs;
    app.pendingStartWaitTimeoutMs = options.pendingStartWaitTimeoutMs || 25;
    app.unloadExternalApiRoutes = () => trace.push('api:unload');
    app.externalApiServer = {
        getRunning: () => Boolean(options.apiRunning),
        stop: async () => trace.push('api:stop')
    };
    app.cliAccessServer = {
        getRunning: () => Boolean(options.cliRunning),
        stop: async () => trace.push('cli:stop')
    };
    app.bgpApp = protocolApp('Bgp', trace, Boolean(options.bgpRunning), {
        stopError: options.bgpStopError
    });
    app.bmpApp = {
        ...protocolApp('Bmp', trace, Boolean(options.bmpRunning)),
        bmpStarting: false,
        cancelPendingStart() {
            trace.push('bmp:cancel-start');
            this.bmpStarting = false;
        },
        closeOfflinePersistenceReader: async () => trace.push('bmp:close-reader')
    };
    app.rpkiApp = {
        ...protocolApp('Rpki', trace, Boolean(options.rpkiRunning)),
        rpkiStarting: false,
        cancelPendingStart() {
            trace.push('rpki:cancel-start');
            this.rpkiStarting = false;
        }
    };
    app.ftpApp = protocolApp('Ftp', trace, Boolean(options.ftpRunning));
    app.snmpApp = protocolApp('Snmp', trace, Boolean(options.snmpRunning));
    app.dhcpApp = protocolApp('Dhcp', trace, Boolean(options.dhcpRunning));
    app.ntpApp = protocolApp('Ntp', trace, Boolean(options.ntpRunning));
    app.radiusApp = {
        ...protocolApp('Radius', trace, Boolean(options.radiusRunning)),
        radiusStarting: false,
        cancelPendingStart() {
            trace.push('radius:cancel-start');
            this.radiusStarting = false;
        }
    };
    app.tftpApp = protocolApp('Tftp', trace, Boolean(options.tftpRunning));
    app.syslogApp = protocolApp('Syslog', trace, Boolean(options.syslogRunning));
    app.grpcApp = {
        hasWorker: () => Boolean(options.grpcRunning),
        getGrpcRunning: () => Boolean(options.grpcRunning),
        handleShutdown: async () => trace.push('Grpc:stop')
    };
    app.netconfApp = {
        getRunning: () => Boolean(options.netconfRunning),
        closeAll: async () => trace.push('netconf:close')
    };
    app.yangApp = {
        getRunning: () => Boolean(options.yangRunning),
        close: async () => trace.push('yang:close')
    };
    return { app, trace };
}

async function testFailureIsolation(SystemApp) {
    const { app, trace } = createHarness(SystemApp, {
        apiRunning: true,
        cliRunning: true,
        bgpRunning: true,
        bgpStopError: new Error('synthetic BGP stop failure'),
        bmpRunning: true,
        rpkiRunning: true,
        ftpRunning: true,
        snmpRunning: true,
        dhcpRunning: true,
        ntpRunning: true,
        radiusRunning: true,
        tftpRunning: true,
        syslogRunning: true,
        grpcRunning: true
    });

    const errors = await app.shutdownServices();
    assert.deepEqual(
        errors.map(entry => entry.name),
        ['BGP']
    );
    assert.deepEqual(trace.slice(0, 3), ['api:stop', 'api:unload', 'cli:stop']);
    for (const expected of [
        'Bmp:stop',
        'Rpki:stop',
        'Ftp:stop',
        'Snmp:stop',
        'Dhcp:stop',
        'Ntp:stop',
        'Radius:stop',
        'Tftp:stop',
        'Syslog:stop',
        'Grpc:stop',
        'netconf:close',
        'bmp:close-reader',
        'yang:close'
    ]) {
        assert(trace.includes(expected), `${expected} must run after a previous stop failure`);
    }
}

async function testTimeoutContinues(SystemApp) {
    const { app, trace } = createHarness(SystemApp, {
        shutdownStepTimeoutMs: 20,
        bgpRunning: true,
        ntpRunning: true
    });
    app.bgpApp.handleStopBgp = () => new Promise(() => {});

    const startedAt = Date.now();
    const errors = await app.shutdownServices();
    assert(errors.some(entry => entry.name === 'BGP' && entry.error.code === 'SHUTDOWN_TIMEOUT'));
    assert(trace.includes('Ntp:stop'));
    assert(Date.now() - startedAt < 500, 'shutdown must not remain blocked by a hung protocol stop');
}

async function testConcurrentCloseSharesOneRun(SystemApp) {
    const app = Object.create(SystemApp.prototype);
    app.windowClosePromise = null;
    let calls = 0;
    let release;
    app.performWindowClose = () => {
        calls += 1;
        return new Promise(resolve => {
            release = resolve;
        });
    };

    const first = app.handleWindowClose();
    const second = app.handleWindowClose();
    assert.equal(calls, 1);
    release(true);
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
}

async function testDialogStateIsNotShutdownSnapshot(SystemApp, dialogStub) {
    const { app, trace } = createHarness(SystemApp);
    let bgpRunning = true;
    let ntpRunning = false;
    app.bgpApp.getBgpRunning = () => bgpRunning;
    app.ntpApp.getNtpRunning = () => ntpRunning;
    dialogStub.showMessageBox = async () => {
        bgpRunning = false;
        ntpRunning = true;
        return { response: 0 };
    };

    assert.equal(await app.handleWindowClose(), true);
    assert(trace.includes('Ntp:stop'), 'a protocol started while the dialog is open must still be stopped');
}

async function main() {
    const { SystemApp, dialogStub } = loadSystemApp();
    await testFailureIsolation(SystemApp);
    await testTimeoutContinues(SystemApp);
    await testConcurrentCloseSharesOneRun(SystemApp);
    await testDialogStateIsNotShutdownSnapshot(SystemApp, dialogStub);
    console.log('System protocol-process shutdown lifecycle tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
