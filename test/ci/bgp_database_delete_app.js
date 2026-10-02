const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
process.env.NODE_ENV = 'test';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-database-delete-'));
let activeUserData = path.join(temporaryRoot, 'initial');
const exposedApis = new Map();
const invoked = [];
const electronMock = {
    app: { isPackaged: false, getPath: () => activeUserData },
    shell: { openExternal() {} },
    dialog: {
        async showOpenDialog() {
            return { canceled: true, filePaths: [] };
        }
    },
    contextBridge: { exposeInMainWorld: (name, api) => exposedApis.set(name, api) },
    ipcRenderer: {
        invoke: (...args) => {
            invoked.push(args);
        },
        on() {},
        send() {},
        removeListener() {}
    }
};
const originalLoad = Module._load;
Module._load = function mockElectron(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
};
let BgpApp;
try {
    BgpApp = require('../../electron/app/bgpApp');
    require('../../electron/preload');
} finally {
    Module._load = originalLoad;
}
const Database = require('better-sqlite3');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const ProtocolProcessWithPromise = require('../../electron/worker/core/protocolProcessWithPromise');
const BgpConst = require('../../electron/const/bgpConst');

function fixture(name) {
    activeUserData = path.join(temporaryRoot, name);
    fs.mkdirSync(activeUserData, { recursive: true });
    const handlers = new Map();
    const values = new Map();
    const app = new BgpApp(
        { handle: (channel, handler) => handlers.set(channel, handler) },
        { get: key => values.get(key), set: (key, value) => values.set(key, value) }
    );
    return { app, handlers, dbPath: app.getBgpRouteDatabasePath(), userData: activeUserData };
}
function writeArtifacts(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    return ['', '-wal', '-shm', '-journal'].map(suffix => {
        const filePath = `${dbPath}${suffix}`;
        const contents = `not-SQLite:${suffix || 'database'}`;
        fs.writeFileSync(filePath, contents);
        return { filePath, size: Buffer.byteLength(contents) };
    });
}
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const event = { sender: { send() {}, isDestroyed: () => false } };
const config = { localAs: 65000, routerId: '192.0.2.1', addressFamily: [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC] };

async function main() {
    const originalCreate = ProtocolProcessWithPromise.prototype.createLongRunningProcess;
    const originalUnlink = fs.promises.unlink;
    try {
        {
            const { app, handlers, dbPath, userData } = fixture('old-schema');
            assert.ok(handlers.has('bgp:getRouteDatabaseInfo'));
            assert.ok(handlers.has('bgp:deleteRouteDatabase'));
            exposedApis.get('bgpApi').getRouteDatabaseInfo();
            exposedApis.get('bgpApi').deleteRouteDatabase();
            assert.deepEqual(invoked.slice(-2), [['bgp:getRouteDatabaseInfo'], ['bgp:deleteRouteDatabase']]);
            fs.mkdirSync(path.dirname(dbPath), { recursive: true });
            const legacy = new Database(dbPath);
            legacy.exec(
                "CREATE TABLE legacy_data(value TEXT); INSERT INTO legacy_data VALUES ('preserved-until-explicit-delete')"
            );
            legacy.pragma('user_version = 3');
            legacy.close();
            assert.throws(
                () => new BgpRouteSqliteStore(dbPath).open(),
                new RegExp(`schema 3.*schema ${BgpRouteSqliteStore.SCHEMA_VERSION}`)
            );
            const beforeDelete = fs.readFileSync(dbPath);
            const info = await handlers.get('bgp:getRouteDatabaseInfo')();
            assert.equal(info.status, 'success');
            assert.equal(info.data.exists, true);
            assert.equal(info.data.canDelete, true);
            assert.equal(info.data.dbPath, path.join(userData, 'bgp', 'bgp.sqlite3'));
            assert.deepEqual(
                fs.readFileSync(dbPath),
                beforeDelete,
                'status must not open or rewrite an incompatible database'
            );
            const preserved = [
                path.join(userData, 'Settings Data.json'),
                path.join(userData, 'Program Data.json'),
                path.join(userData, 'bgp', 'other.sqlite3'),
                path.join(userData, 'bmp', 'bmp.sqlite3')
            ];
            for (const file of preserved) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, 'keep');
            }
            for (const suffix of ['-wal', '-shm', '-journal']) fs.writeFileSync(`${dbPath}${suffix}`, suffix);
            const result = await handlers.get('bgp:deleteRouteDatabase')();
            assert.equal(result.status, 'success');
            assert.equal(result.data.deletedFileCount, 4);
            assert.deepEqual(result.data.deletedArtifacts, ['wal', 'shm', 'journal', 'database']);
            assert.equal(result.data.exists, false);
            assert.equal(result.data.busy, false);
            assert.equal(app.routeDatabaseDeleting, false);
            for (const file of preserved) assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
            const fresh = new BgpRouteSqliteStore(dbPath).open();
            assert.equal(
                fresh.db.pragma('user_version', { simple: true }),
                BgpRouteSqliteStore.SCHEMA_VERSION,
                'explicit deletion permits creating the current schema on the next start'
            );
            fresh.close();
        }
        {
            const { app, dbPath } = fixture('sidecar-only');
            const empty = await app.handleGetRouteDatabaseInfo();
            assert.equal(empty.data.exists, false);
            assert.equal(fs.existsSync(path.dirname(dbPath)), false, 'query must not create the database directory');
            fs.mkdirSync(path.dirname(dbPath));
            fs.writeFileSync(`${dbPath}-wal`, 'orphan-wal');
            fs.writeFileSync(`${dbPath}-journal`, 'orphan-journal');
            const info = app.getRouteDatabaseInfo();
            assert.equal(info.exists, true);
            assert.equal(info.fileCount, 2);
            assert.equal(info.totalSize, Buffer.byteLength('orphan-walorphan-journal'));
            assert.equal((await app.handleDeleteRouteDatabase()).data.deletedFileCount, 2);
            const again = await app.handleDeleteRouteDatabase();
            assert.equal(again.status, 'success');
            assert.equal(again.data.deleted, false);
            assert.equal(again.data.deletedFileCount, 0);
        }
        {
            const { app, dbPath } = fixture('busy');
            const files = writeArtifacts(dbPath);
            for (const [field, value, pattern] of [
                ['worker', {}, /先停止 BGP/],
                ['bgpStarting', true, /正在启动/],
                ['bgpStopping', true, /正在停止/]
            ]) {
                app[field] = value;
                assert.equal(app.getRouteDatabaseInfo().busy, true);
                const result = await app.handleDeleteRouteDatabase();
                assert.equal(result.status, 'error');
                assert.match(result.msg, pattern);
                assert.equal(fs.existsSync(dbPath), true);
                app[field] = field === 'worker' ? null : false;
            }
            const unlinkGate = deferred();
            let blocked = false;
            fs.promises.unlink = async filePath => {
                if (!blocked) {
                    blocked = true;
                    await unlinkGate.promise;
                }
                return originalUnlink(filePath);
            };
            const deleting = app.handleDeleteRouteDatabase();
            await flush();
            assert.equal(app.getRouteDatabaseInfo().deleting, true);
            assert.equal(app.getRouteDatabaseInfo().busy, true);
            assert.match((await app.handleDeleteRouteDatabase()).msg, /请勿重复/);
            assert.match((await app.handleStartBgp(null, config)).msg, /数据库正在删除/);
            unlinkGate.resolve();
            assert.equal((await deleting).status, 'success');
            fs.promises.unlink = originalUnlink;
            for (const file of files) assert.equal(fs.existsSync(file.filePath), false);
        }
        {
            const { app, dbPath } = fixture('start-schema-failure');
            writeArtifacts(dbPath);
            const termination = deferred();
            const worker = {
                addEventListener() {},
                removeEventListener() {},
                async sendRequest() {
                    throw new Error(`schema 3 is incompatible with schema ${BgpRouteSqliteStore.SCHEMA_VERSION}`);
                },
                terminate: () => termination.promise
            };
            ProtocolProcessWithPromise.prototype.createLongRunningProcess = () => worker;
            const starting = app.handleStartBgp(event, config);
            await flush();
            assert.equal(app.getRouteDatabaseInfo().starting, true);
            assert.match((await app.handleDeleteRouteDatabase()).msg, /正在启动/);
            termination.resolve();
            assert.equal((await starting).status, 'error');
            assert.equal(app.worker, null);
            assert.equal(app.getRouteDatabaseInfo().busy, false);
            assert.equal(
                (await app.handleDeleteRouteDatabase()).status,
                'success',
                'a schema error followed by confirmed process exit must permit deletion'
            );
        }
        {
            const { app, dbPath } = fixture('stop-waits-for-exit');
            writeArtifacts(dbPath);
            const stopped = deferred();
            const terminated = deferred();
            const worker = {
                removeEventListener() {},
                sendRequest: () => stopped.promise,
                terminate: () => terminated.promise
            };
            app.worker = worker;
            const stopping = app.handleStopBgp();
            await flush();
            assert.equal(app.getRouteDatabaseInfo().stopping, true);
            assert.match((await app.handleDeleteRouteDatabase()).msg, /正在停止/);
            stopped.resolve({ msg: 'stopped' });
            await flush();
            app.cleanupBgpRuntime(worker);
            assert.equal(app.worker, null);
            assert.equal(
                app.getRouteDatabaseInfo().busy,
                true,
                'null worker alone does not confirm the terminating process has exited'
            );
            assert.match((await app.handleDeleteRouteDatabase()).msg, /正在停止/);
            terminated.resolve();
            assert.equal((await stopping).status, 'success');
            assert.equal(app.getRouteDatabaseInfo().busy, false);
            assert.equal((await app.handleDeleteRouteDatabase()).status, 'success');
        }
        {
            const { app, dbPath } = fixture('unconfirmed-exit');
            writeArtifacts(dbPath);
            let onExit;
            const worker = {
                addEventListener() {},
                removeEventListener() {},
                async sendRequest() {
                    throw new Error('start failure');
                },
                async terminate() {
                    throw new Error('exit not confirmed');
                }
            };
            ProtocolProcessWithPromise.prototype.createLongRunningProcess = function createFake() {
                onExit = this.options.onExit;
                return worker;
            };
            assert.equal((await app.handleStartBgp(event, config)).status, 'error');
            assert.equal(app.worker, null);
            assert.equal(app.getRouteDatabaseInfo().stopping, true);
            assert.match((await app.handleDeleteRouteDatabase()).msg, /尚未确认退出/);
            assert.match((await app.handleStartBgp(null, config)).msg, /尚未确认退出/);
            onExit(1, worker, { expected: true });
            assert.equal(app.getRouteDatabaseInfo().busy, false);
            assert.equal((await app.handleDeleteRouteDatabase()).status, 'success');
        }
        {
            const { app, dbPath } = fixture('unlink-failure');
            writeArtifacts(dbPath);
            fs.promises.unlink = async filePath => {
                if (filePath === `${dbPath}-wal`) {
                    const error = new Error('permission denied');
                    error.code = 'EACCES';
                    throw error;
                }
                return originalUnlink(filePath);
            };
            const failed = await app.handleDeleteRouteDatabase();
            assert.equal(failed.status, 'error');
            assert.match(failed.msg, /wal.*permission denied/);
            assert.equal(fs.existsSync(dbPath), true, 'the primary database must remain if a sidecar fails');
            assert.equal(app.routeDatabaseDeleting, false);
            fs.promises.unlink = originalUnlink;
            assert.equal((await app.handleDeleteRouteDatabase()).status, 'success');
        }
        {
            const { app, dbPath } = fixture('unsafe-files');
            fs.mkdirSync(path.dirname(dbPath));
            const target = path.join(temporaryRoot, 'symlink-target');
            fs.writeFileSync(target, 'do-not-delete');
            fs.symlinkSync(target, dbPath);
            assert.equal((await app.handleGetRouteDatabaseInfo()).status, 'error');
            assert.equal((await app.handleDeleteRouteDatabase()).status, 'error');
            assert.equal(fs.readFileSync(target, 'utf8'), 'do-not-delete');
            assert.equal(fs.lstatSync(dbPath).isSymbolicLink(), true);
            fs.unlinkSync(dbPath);
            fs.writeFileSync(dbPath, 'database');
            fs.mkdirSync(`${dbPath}-wal`);
            assert.equal((await app.handleDeleteRouteDatabase()).status, 'error');
            assert.equal(fs.readFileSync(dbPath, 'utf8'), 'database');
            fs.rmdirSync(`${dbPath}-wal`);
            fs.symlinkSync(target, `${dbPath}-wal`);
            assert.equal((await app.handleDeleteRouteDatabase()).status, 'error');
            assert.equal(fs.readFileSync(target, 'utf8'), 'do-not-delete');
            assert.equal(fs.readFileSync(dbPath, 'utf8'), 'database');
        }
        {
            const { app, dbPath, userData } = fixture('unsafe-directory');
            const outside = path.join(temporaryRoot, 'outside-bgp');
            fs.mkdirSync(outside);
            fs.writeFileSync(path.join(outside, 'bgp.sqlite3'), 'external-data');
            fs.symlinkSync(outside, path.join(userData, 'bgp'));
            const result = await app.handleDeleteRouteDatabase();
            assert.equal(result.status, 'error');
            assert.match(result.msg, /数据库目录/);
            assert.equal(fs.readFileSync(path.join(outside, 'bgp.sqlite3'), 'utf8'), 'external-data');
            assert.equal(fs.lstatSync(path.dirname(dbPath)).isSymbolicLink(), true);
        }
        {
            const { app, handlers } = fixture('group-api-lifecycle');
            assert.ok(handlers.has('bgp:getRouteGroupStates'));
            assert.ok(handlers.has('bgp:withdrawRouteGroup'));
            exposedApis.get('bgpApi').getRouteGroupStates();
            exposedApis.get('bgpApi').withdrawRouteGroup({ groupId: 'group-1' });
            assert.deepEqual(invoked.slice(-2), [
                ['bgp:getRouteGroupStates'],
                ['bgp:withdrawRouteGroup', { groupId: 'group-1' }]
            ]);
            assert.equal((await app.handleGetRouteGroupStates()).status, 'error');
            assert.equal((await app.handleWithdrawRouteGroup(null, { groupId: 'group-1' })).status, 'error');
            const requests = [];
            app.worker = {
                sendRequest: async (type, data) => {
                    requests.push({ type, data });
                    return {
                        data: type === BgpConst.BGP_REQ_TYPES.GET_ROUTE_GROUP_STATES ? { groups: [] } : { deleted: 2 }
                    };
                }
            };
            for (const flag of ['bgpStarting', 'bgpStopping']) {
                app[flag] = true;
                assert.equal((await app.handleGetRouteGroupStates()).status, 'error');
                assert.equal((await app.handleWithdrawRouteGroup(null, { groupId: 'group-1' })).status, 'error');
                assert.equal(
                    (
                        await app.persistGeneratedRoutes(
                            { ...config, groupId: 'group-1' },
                            BgpConst.BGP_REQ_TYPES.GENERATE_IPV4_ROUTES,
                            '生成'
                        )
                    ).status,
                    'error'
                );
                app[flag] = false;
            }
            assert.equal(requests.length, 0, 'group state must stay unknown until BGP has completed startup');
            assert.deepEqual((await app.handleGetRouteGroupStates()).data, { groups: [] });
            assert.deepEqual((await app.handleWithdrawRouteGroup(null, { groupId: 'group-1' })).data, { deleted: 2 });
            assert.deepEqual(requests, [
                { type: BgpConst.BGP_REQ_TYPES.GET_ROUTE_GROUP_STATES, data: null },
                { type: BgpConst.BGP_REQ_TYPES.WITHDRAW_ROUTE_GROUP, data: { groupId: 'group-1' } }
            ]);
        }
        console.log(
            'BGP database info, explicit old/corrupt database deletion, lifecycle guards, sidecars, and filesystem safety tests passed'
        );
    } finally {
        ProtocolProcessWithPromise.prototype.createLongRunningProcess = originalCreate;
        fs.promises.unlink = originalUnlink;
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
