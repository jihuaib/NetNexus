const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const packageJson = require('../../package.json');
const { clearMajorVersionData } = require('../../electron/utils/majorVersionDataCleanup');

function loadRuntime(userDataPath) {
    const originalLoad = Module._load;
    const handlers = new Map();
    const exposedApis = {};
    const ipc = { on() {}, handle: (channel, handler) => handlers.set(channel, handler) };
    const electronStub = {
        app: { isPackaged: true, getPath: () => userDataPath, getVersion: () => packageJson.version },
        ipcMain: ipc,
        dialog: { showMessageBoxSync: () => 0 },
        BrowserWindow: {}
    };
    class DummyDependency {
        invalidateCompilation() {}
    }
    Module._load = function loadWithStubs(request, parent, isMain) {
        if (request === 'electron') {
            if (parent?.filename.endsWith(`${path.sep}preload.js`)) {
                return {
                    contextBridge: { exposeInMainWorld: (name, api) => (exposedApis[name] = api) },
                    ipcRenderer: { invoke: (channel, ...args) => handlers.get(channel)(null, ...args) }
                };
            }
            return electronStub;
        }
        if (parent?.filename.endsWith(`${path.sep}systemApp.js`)) {
            if (request === '../log/logger') return { warn() {}, error() {} };
            if (request === '../utils/secureCredentialStore') return DummyDependency;
            if (request === './bmpApiRoutes') return () => [];
            if (request.startsWith('./')) return DummyDependency;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const ChangelogState = require('../../electron/utils/changelogState');
        const SystemApp = require('../../electron/app/systemApp');
        require('../../electron/preload');
        return {
            ChangelogState,
            commonApi: exposedApis.commonApi,
            createSystemApp: () => new SystemApp(ipc, { webContents: {} })
        };
    } finally {
        Module._load = originalLoad;
    }
}

function testVersionHistory(ChangelogState, userDataPath) {
    const stateFile = path.join(userDataPath, 'Changelog State.state');
    const versions = ['2.0.0', '2.0.1', '2.1.0', '3.0.0'];
    for (const version of versions) {
        const beforeRead = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
        const firstLaunch = new ChangelogState(userDataPath, version);
        assert.deepEqual(firstLaunch.getState(), { version, shouldShow: true });
        assert.deepEqual(new ChangelogState(userDataPath, version).getState(), { version, shouldShow: true });
        assert.equal(
            fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null,
            beforeRead,
            'checking startup state must never consume the first display'
        );
        firstLaunch.markSeen(version);
        const reopened = new ChangelogState(userDataPath, version);
        assert.deepEqual(reopened.getState(), { version, shouldShow: false });
        const beforeRepeat = fs.readFileSync(stateFile, 'utf8');
        reopened.markSeen(version);
        assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeRepeat, 'manual reopening must retain one record');
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).seenVersions, versions);
    fs.writeFileSync(path.join(userDataPath, 'Settings Data.json'), JSON.stringify({ appVersion: '3.0.0' }));
    assert.equal(clearMajorVersionData(userDataPath).removedJsonFiles, 1);
    for (const version of versions) {
        assert.equal(
            new ChangelogState(userDataPath, version).getState().shouldShow,
            false,
            'major-version cleanup and downgrade must preserve already viewed releases'
        );
    }
}

function testIpcAndStorageFailures(runtime, userDataPath) {
    const { commonApi, createSystemApp, ChangelogState } = runtime;
    const version = packageJson.version;
    const systemApp = createSystemApp();
    assert.equal(systemApp.checkVersionCompatibility(), true);
    assert.deepEqual(commonApi.getChangelogState().data, { version, shouldShow: true });

    for (const invalidVersion of [undefined, null, {}, [], 5, '', '0.0.0', `${version} `]) {
        assert.equal(commonApi.markChangelogSeen(invalidVersion).status, 'error');
        assert.equal(commonApi.getChangelogState().data.shouldShow, true);
    }

    const store = systemApp.changelogState.getStore();
    const originalSet = store.set;
    store.set = () => {
        throw new Error('storage write failure');
    };
    const failedWrite = commonApi.markChangelogSeen(version);
    assert.equal(failedWrite.status, 'error');
    assert.match(failedWrite.msg, /storage write failure/);
    store.set = originalSet;
    assert.equal(commonApi.getChangelogState().data.shouldShow, true, 'failed writes must not mark a release as seen');

    const previousVersion = `${Number.parseInt(version.split('.')[0], 10) - 1}.99.0`;
    new ChangelogState(userDataPath, previousVersion).markSeen(previousVersion);
    systemApp.store.set(systemApp.appVersionFileKey, previousVersion);
    assert.equal(systemApp.checkVersionCompatibility(), true);
    assert.equal(new ChangelogState(userDataPath, previousVersion).getState().shouldShow, false);
    assert.equal(commonApi.getChangelogState().data.shouldShow, true);
    assert.equal(commonApi.markChangelogSeen(version).status, 'success');

    const reopened = createSystemApp();
    assert.equal(reopened.checkVersionCompatibility(), true);
    assert.deepEqual(commonApi.getChangelogState().data, { version, shouldShow: false });
    const stateFile = reopened.changelogState.getStore().path;
    const savedState = fs.readFileSync(stateFile, 'utf8');
    fs.writeFileSync(stateFile, '{');
    assert.equal(commonApi.getChangelogState().status, 'error', 'disk read failures must reach the renderer');
    assert.equal(commonApi.markChangelogSeen(version).status, 'error');
    createSystemApp();
    assert.equal(commonApi.getChangelogState().status, 'error', 'lazy storage initialization failures must be caught');
    fs.writeFileSync(stateFile, JSON.stringify({ seenVersions: {} }));
    assert.equal(commonApi.getChangelogState().status, 'error', 'invalid stored history must be reported');
    fs.writeFileSync(stateFile, savedState);
    assert.deepEqual(commonApi.getChangelogState().data, { version, shouldShow: false });
}

function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-changelog-state-'));
    try {
        const ipcDirectory = path.join(directory, 'ipc');
        const runtime = loadRuntime(ipcDirectory);
        testVersionHistory(runtime.ChangelogState, path.join(directory, 'versions'));
        testIpcAndStorageFailures(runtime, ipcDirectory);
        console.log('Changelog first-display state, version history, cleanup, IPC and storage failure tests passed');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main();
