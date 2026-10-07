const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(projectRoot, 'electron/main.js'), 'utf8');
const userDataPath = path.join(os.tmpdir(), 'netnexus-startup-user-data');
const hookStart = source.indexOf('function checkBmpDatabaseVersionsAtStartup() {');
const startupStart = source.indexOf('async function startApplication() {', hookStart);
const startupEnd = source.indexOf('\nif (!hasSingleInstanceLock)', startupStart);
assert.ok(hookStart >= 0 && startupStart > hookStart && startupEnd > startupStart);
const hooks = source.slice(hookStart, startupStart);
const startup = source.slice(startupStart, startupEnd);

async function checkStartup(isPackagedE2e, failingDatabase = null) {
    const events = [];
    const failure = failingDatabase ? new Error(`${failingDatabase} database version check failed`) : null;
    const context = {
        isPackagedE2e,
        app: {
            getPath(name) {
                assert.equal(name, 'userData');
                return userDataPath;
            },
            on() {},
            quit() {
                events.push('quit');
            }
        },
        path,
        ipcMain: {},
        require(name) {
            if (name === './worker/bmp/bmpDatabaseVersionCheck') {
                return {
                    prepareBmpDatabaseVersions(dbPath, options) {
                        assert.equal(dbPath, path.join(userDataPath, 'bmp', 'bmp.sqlite3'));
                        assert.deepEqual({ ...options }, { expectedVersion: 123 });
                        events.push('bmp-schema-check');
                        if (failingDatabase === 'bmp') throw failure;
                    }
                };
            }
            if (name === './worker/bmp/bmpPersistenceStore') return { SCHEMA_VERSION: 123 };
            if (name === './worker/bgp/bgpDatabaseVersionCheck') {
                return {
                    resetDatabaseIfVersionChanged(dbPath, expectedVersion) {
                        assert.equal(dbPath, path.join(userDataPath, 'bgp', 'bgp.sqlite3'));
                        assert.equal(expectedVersion, 456);
                        events.push('bgp-schema-check');
                        if (failingDatabase === 'bgp') throw failure;
                    }
                };
            }
            if (name === './worker/bgp/bgpRouteSqliteStore') return { SCHEMA_VERSION: 456 };
            if (name === './app/systemApp') {
                return class {
                    constructor() {
                        events.push('register-ipc');
                    }

                    checkVersionCompatibility() {
                        events.push('app-version-check');
                        return true;
                    }

                    async loadSettings() {
                        events.push('load-settings');
                    }
                };
            }
            throw new Error(`Unexpected startup dependency: ${name}`);
        },
        initializeMonitorWindowManager() {},
        async createSplashWindow() {
            events.push('splash-frame');
        },
        createWindow() {
            events.push('create-window');
            context.mainWindow = { startupLoadPromise: Promise.resolve() };
        },
        createTray() {},
        updateSplashProgress() {},
        waitForMinimumSplashDuration() {
            return Promise.resolve();
        },
        finishStartup() {
            events.push('finished');
        },
        BrowserWindow: { getAllWindows: () => [] },
        mainWindow: null,
        splashWindow: null,
        systemApp: null,
        monitorWindowManager: null,
        startupComplete: false
    };
    vm.runInNewContext(`${hooks}\n${startup}\nthis.runStartup = startApplication;`, context);
    if (failure) {
        await assert.rejects(context.runStartup(), error => error === failure);
        assert.ok(!events.includes('create-window'), 'failed version checks must not expose database IPC');
        assert.ok(!events.includes('register-ipc'));
    } else {
        await context.runStartup();
        for (const check of ['bmp-schema-check', 'bgp-schema-check']) {
            assert.ok(events.indexOf(check) < events.indexOf('create-window'));
            if (!isPackagedE2e) {
                assert.ok(events.indexOf('splash-frame') < events.indexOf(check));
                assert.ok(events.indexOf(check) < events.indexOf('register-ipc'));
                assert.ok(events.indexOf(check) < events.indexOf('load-settings'));
            }
        }
    }
    assert.equal(events.filter(event => event === 'bmp-schema-check').length, 1);
    assert.equal(events.filter(event => event === 'bgp-schema-check').length, failingDatabase === 'bmp' ? 0 : 1);
}

(async () => {
    for (const e2e of [false, true]) {
        await checkStartup(e2e);
        await checkStartup(e2e, 'bmp');
        await checkStartup(e2e, 'bgp');
    }
    console.log('BGP/BMP schema versions are checked before windows and database IPC, including packaged E2E');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
