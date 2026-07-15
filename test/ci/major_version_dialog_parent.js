const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const packageJson = require('../../package.json');

function loadSystemAppClass() {
    const originalLoad = Module._load;
    const dialogCalls = [];
    const dialogStub = {
        response: 0,
        showMessageBoxSync(...args) {
            dialogCalls.push(args);
            return this.response;
        }
    };
    const appStub = {
        isPackaged: true,
        getPath: () => '/tmp/netnexus-version-dialog-test'
    };
    const stubbedDependencies = new Set([
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
        './updater',
        './nativeApp',
        './externalApiServer',
        './cli',
        './wiresharkPluginInstaller'
    ]);
    class DummyDependency {}

    Module._load = function loadWithSystemAppStubs(request, parent, isMain) {
        if (request === 'electron') {
            return { app: appStub, dialog: dialogStub, BrowserWindow: {} };
        }
        if (request === 'electron-store') {
            return DummyDependency;
        }
        if (request === '../log/logger') {
            return { warn() {}, error() {} };
        }
        if (request === '../utils/majorVersionDataCleanup') {
            return {
                clearMajorVersionData() {
                    throw new Error('synthetic cleanup failure');
                }
            };
        }
        if (request === './bmpApiRoutes') {
            return () => [];
        }
        if (stubbedDependencies.has(request)) {
            return DummyDependency;
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        return {
            SystemApp: require('../../electron/app/systemApp'),
            dialogCalls,
            dialogStub
        };
    } finally {
        Module._load = originalLoad;
    }
}

function createCompatibilityHarness(SystemApp, storedVersion) {
    const writes = [];
    const cleanupParents = [];
    const systemApp = Object.create(SystemApp.prototype);
    systemApp.win = { name: 'hidden-main-window' };
    systemApp.appVersionFileKey = 'appVersion';
    systemApp.store = {
        get: () => storedVersion,
        set: (key, value) => writes.push([key, value])
    };
    systemApp.clearIncompatibleData = dialogParent => {
        cleanupParents.push(dialogParent);
        return true;
    };
    return { systemApp, writes, cleanupParents };
}

function main() {
    const { SystemApp, dialogCalls, dialogStub } = loadSystemAppClass();
    const currentMajor = Number.parseInt(packageJson.version.split('.')[0], 10);
    const previousVersion = `${currentMajor - 1}.99.0`;
    const splashWindow = { name: 'visible-always-on-top-splash' };
    if (process.env.NETNEXUS_MINIFIED_CI !== '1') {
        const mainProcessSource = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');
        assert.match(
            mainProcessSource,
            /checkVersionCompatibility\(splashWindow\)/,
            'startup must pass the visible splash to the compatibility check'
        );
    }

    const accepted = createCompatibilityHarness(SystemApp, previousVersion);
    dialogStub.response = 0;
    assert.equal(accepted.systemApp.checkVersionCompatibility(splashWindow), true);
    assert.equal(dialogCalls.length, 1);
    assert.equal(dialogCalls[0][0], splashWindow, 'compatibility dialog must be owned by the visible splash');
    assert.equal(dialogCalls[0][1].title, '版本不兼容');
    assert.deepEqual(accepted.cleanupParents, [splashWindow]);
    assert.deepEqual(accepted.writes, [['appVersion', packageJson.version]]);

    dialogCalls.length = 0;
    const cancelled = createCompatibilityHarness(SystemApp, previousVersion);
    dialogStub.response = 1;
    assert.equal(cancelled.systemApp.checkVersionCompatibility(splashWindow), false);
    assert.equal(dialogCalls[0][0], splashWindow);
    assert.deepEqual(cancelled.cleanupParents, []);
    assert.deepEqual(cancelled.writes, []);

    dialogCalls.length = 0;
    const cleanupFailure = Object.create(SystemApp.prototype);
    cleanupFailure.win = { name: 'hidden-main-window' };
    assert.throws(() => cleanupFailure.clearIncompatibleData(splashWindow), /synthetic cleanup failure/);
    assert.equal(dialogCalls[0][0], splashWindow, 'cleanup error dialog must remain above the splash');
    assert.equal(dialogCalls[0][1].title, '错误');

    console.log('Major-version compatibility dialogs use the visible startup window as their modal parent');
}

main();
