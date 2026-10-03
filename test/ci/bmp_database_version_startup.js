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

async function checkStartup(isPackagedE2e, failure = null) {
    const events = [];
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
                        events.push('schema-check');
                        if (failure) throw failure;
                    }
                };
            }
            if (name === './worker/bmp/bmpPersistenceStore') return { SCHEMA_VERSION: 123 };
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
        assert.ok(events.indexOf('schema-check') < events.indexOf('create-window'));
        if (!isPackagedE2e) {
            assert.ok(events.indexOf('splash-frame') < events.indexOf('schema-check'));
            assert.ok(events.indexOf('schema-check') < events.indexOf('register-ipc'));
            assert.ok(events.indexOf('schema-check') < events.indexOf('load-settings'));
        }
    }
    assert.equal(events.filter(event => event === 'schema-check').length, 1);
}

(async () => {
    for (const e2e of [false, true]) {
        await checkStartup(e2e);
        await checkStartup(e2e, new Error('database version check failed'));
    }
    console.log('BMP schema versions are checked before windows and database IPC, including packaged E2E');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
