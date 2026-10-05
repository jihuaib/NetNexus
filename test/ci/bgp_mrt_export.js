const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
process.env.NODE_ENV = 'test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-mrt-export-'));
let userData = path.join(directory, 'app');
let saveResult = { canceled: true };
const dialogs = [];
const apis = new Map();
const invoked = [];
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === 'electron')
        return {
            app: { isPackaged: false, getPath: name => (name === 'downloads' ? directory : userData) },
            shell: { openExternal() {} },
            dialog: {
                async showSaveDialog(options) {
                    dialogs.push(options);
                    return typeof saveResult === 'function' ? saveResult() : saveResult;
                }
            },
            contextBridge: { exposeInMainWorld: (name, api) => apis.set(name, api) },
            ipcRenderer: {
                invoke: (...args) => invoked.push(args),
                on() {},
                send() {},
                removeListener() {}
            }
        };
    return originalLoad.call(this, request, parent, isMain);
};
const BgpApp = require('../../electron/app/bgpApp');
require('../../electron/preload');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const { getMrtExportInfo, exportRouteDatabaseMrt } = require('../../electron/utils/bgp/simulator/bgpMrtExport');

const attr = {
    attributePolicy: 'configured',
    configuredAttributes: ['origin', 'asPath', 'communities', 'extendedCommunities', 'med'],
    pathAttributes: [
        { type: 'origin', value: 0 },
        { type: 'asPath', value: '70000 65001' },
        { type: 'communities', value: ['65000:1', '65000:2'] },
        { type: 'extendedCommunities', value: ['rt:65000:1', 'rt:65000:2'] },
        { type: 'med', value: 11 },
        { type: 'med', value: 22 }
    ]
};
const profile = {
    1: { instanceKey: '0|1|1', ip: '192.0.2.0', mask: 24 },
    2: { instanceKey: '0|2|1', ip: '2001:db8::', mask: 64 },
    12: { instanceKey: '0|1|4', ip: '198.51.100.0', mask: 24 }
};
function replace(store, groupId, addressFamily, routes) {
    return store.replaceRouteGroup(groupId, {
        addressFamily,
        instanceKey: profile[addressFamily].instanceKey,
        groupName: `路由组 ${groupId}`,
        routes
    });
}
function entry(addressFamily, options = {}, attributes = attr) {
    const { ip, mask } = profile[addressFamily];
    return {
        route: { ip, mask, pathId: 0, rd: '65000:1', mpNextHop: '2001:db8::1', ...options },
        attr: attributes
    };
}
function* many(count) {
    for (let index = 0; index < count; index += 1) {
        const prefix = Math.floor(index / 2);
        yield entry(1, {
            ip: `10.0.${prefix >> 8}.${prefix & 255}`,
            mask: 32,
            pathId: index % 2,
            nlriEncoding: 'mpReach'
        });
    }
}
function records(filePath) {
    const bytes = fs.readFileSync(filePath);
    const result = [];
    for (let offset = 0; offset < bytes.length; ) {
        assert.ok(bytes.length - offset >= 12);
        const length = bytes.readUInt32BE(offset + 8);
        assert.equal(bytes.readUInt16BE(offset + 4), 13);
        assert.ok(offset + 12 + length <= bytes.length);
        result.push({
            subtype: bytes.readUInt16BE(offset + 6),
            body: bytes.subarray(offset + 12, offset + 12 + length)
        });
        offset += 12 + length;
    }
    assert.equal(result[0].subtype, 1);
    return result;
}
function unicast(record) {
    const body = record.body;
    assert.ok([8, 10].includes(record.subtype));
    const mask = body[4];
    const entryOffset = 5 + Math.ceil(mask / 8);
    assert.equal(body.readUInt16BE(entryOffset), 1);
    const attrLength = body.readUInt16BE(entryOffset + 12);
    assert.equal(body.length, entryOffset + 14 + attrLength);
    return {
        sequence: body.readUInt32BE(0),
        prefix: body.subarray(5, entryOffset).toString('hex'),
        pathId: body.readUInt32BE(entryOffset + 8),
        attrs: body.subarray(entryOffset + 14)
    };
}
function peerInfo(record) {
    const body = record.body;
    const viewLength = body.readUInt16BE(4);
    const offset = 6 + viewLength;
    assert.equal(body.readUInt16BE(offset), 1);
    assert.equal(body[offset + 2], 2);
    return {
        viewName: body.subarray(6, offset).toString('utf8'),
        routerId: Array.from(body.subarray(offset + 3, offset + 7)).join('.'),
        localIp: Array.from(body.subarray(offset + 7, offset + 11)).join('.'),
        localAs: body.readUInt32BE(offset + 11)
    };
}
function fixture(name) {
    userData = path.join(directory, name);
    fs.mkdirSync(userData, { recursive: true });
    const handlers = new Map();
    const values = new Map([['bgp-config', { routerId: '192.0.2.1', localAs: 65000 }]]);
    const app = new BgpApp(
        { handle: (name, handler) => handlers.set(name, handler) },
        { get: key => values.get(key), set: (key, value) => values.set(key, value) }
    );
    return { app, handlers, dbPath: app.getBgpRouteDatabasePath() };
}
function deferred() {
    let resolve;
    const promise = new Promise(yes => (resolve = yes));
    return { promise, resolve };
}

async function main() {
    let store;
    try {
        const { app, handlers, dbPath } = fixture('generated');
        store = new BgpRouteSqliteStore({ dbPath }).open();
        replace(store, 'many', 1, many(1005));
        replace(store, 'other', 1, [entry(1)]);
        replace(store, 'v6', 2, [entry(2), entry(2, { pathId: 1 })]);
        replace(store, 'label', 12, [entry(12, { label: 16 }), entry(12, { label: 16, pathId: 1 })]);
        const options = {
            dbPath,
            routerId: '192.0.2.1',
            localAs: 65000,
            localIp: '192.0.2.254',
            timestamp: 1700000000
        };
        assert.equal(getMrtExportInfo({ dbPath, addressFamily: 1 }).routeCount, 1006);
        assert.equal(getMrtExportInfo({ dbPath, addressFamily: 1, groupId: 'many' }).routeCount, 1005);
        assert.throws(() => getMrtExportInfo({ dbPath, addressFamily: 2, groupId: 'many' }), /地址族/);
        assert.throws(() => getMrtExportInfo({ dbPath, addressFamily: 1, groupId: 'missing' }), /尚未生成/);
        assert.throws(() => getMrtExportInfo({ dbPath, addressFamily: 3 }), /支持 IPv4/);
        const beforeRows = Array.from(store.iterateRoutes('0|1|1'));
        const allPath = path.join(directory, 'all.mrt');
        const all = await exportRouteDatabaseMrt({ ...options, addressFamily: 1, filePath: allPath });
        assert.equal(all.routeCount, 1006, 'export all rows, independently of UI pagination');
        const allRecords = records(allPath);
        assert.equal(allRecords.length, 1007);
        assert.ok(allRecords.slice(1).every(record => record.subtype === 8));
        const decoded = allRecords.slice(1).map(unicast);
        assert.deepEqual(
            decoded.map(row => row.sequence),
            Array.from({ length: 1006 }, (_, index) => index)
        );
        assert.ok(decoded.some(row => row.pathId === 0));
        assert.ok(decoded.some(row => row.pathId === 1));
        assert.equal(new Set(decoded.map(row => `${row.prefix}|${row.pathId}`)).size, 1006);
        assert.deepEqual(Array.from(store.iterateRoutes('0|1|1')), beforeRows, 'export must not regenerate attributes');
        for (const [family, groupId, subtype, count] of [
            [1, 'other', 8, 1],
            [2, 'v6', 10, 2],
            [12, 'label', 12, 2]
        ]) {
            const filePath = path.join(directory, `group-${family}.mrt`);
            const result = await exportRouteDatabaseMrt({ ...options, addressFamily: family, groupId, filePath });
            const parsed = records(filePath);
            assert.equal(result.routeCount, count);
            assert.equal(parsed.length, count + 1);
            assert.ok(parsed.slice(1).every(record => record.subtype === subtype));
            assert.equal(peerInfo(parsed[0]).viewName, `路由组 ${groupId}`);
        }

        // Replace both route contents and group metadata between streaming batches.
        // The keyset iterator must retain its original read transaction snapshot.
        let changed = false;
        const snapshotPath = path.join(directory, 'snapshot.mrt');
        const snapshot = await exportRouteDatabaseMrt({
            ...options,
            addressFamily: 1,
            groupId: 'many',
            filePath: snapshotPath,
            onProgress: count => {
                if (changed || count < 1000) return;
                changed = true;
                replace(store, 'many', 1, [entry(1, { ip: '203.0.113.1', mask: 32 })]);
            }
        });
        assert.equal(changed, true);
        assert.equal(snapshot.routeCount, 1005);
        assert.equal(records(snapshotPath).length, 1006);
        assert.equal(store.getRouteGroupRoutes('many').length, 1);
        assert.ok(
            records(snapshotPath)
                .slice(1)
                .every(record => unicast(record).prefix.startsWith('0a00'))
        );

        const target = path.join(directory, 'preserved.mrt');
        fs.writeFileSync(target, 'existing export');
        await assert.rejects(
            exportRouteDatabaseMrt({
                ...options,
                addressFamily: 1,
                filePath: target,
                onProgress() {
                    throw new Error('injected write interruption');
                }
            }),
            /injected write interruption/
        );
        assert.equal(fs.readFileSync(target, 'utf8'), 'existing export');
        const oversized = {
            attributePolicy: 'configured',
            configuredAttributes: ['med'],
            pathAttributes: Array.from({ length: 10000 }, () => ({ type: 'med', value: 1 }))
        };
        replace(store, 'oversized', 1, [entry(1, { ip: '203.0.114.0' }, oversized)]);
        await assert.rejects(
            exportRouteDatabaseMrt({ ...options, addressFamily: 1, groupId: 'oversized', filePath: target }),
            /65535/
        );
        assert.equal(fs.readFileSync(target, 'utf8'), 'existing export');
        assert.equal(
            fs.readdirSync(directory).some(name => name.endsWith('.tmp')),
            false
        );
        store.withdrawRouteGroup('oversized');
        const recovered = await exportRouteDatabaseMrt({ ...options, addressFamily: 1, filePath: target });
        assert.equal(recovered.routeCount, 2, 'failure must release the snapshot and file handles');
        for (const suffix of ['', '-wal', '-shm', '-journal'])
            await assert.rejects(
                exportRouteDatabaseMrt({ ...options, addressFamily: 1, filePath: `${dbPath}${suffix}` }),
                /不能覆盖/
            );
        const aliasDirectory = path.join(directory, 'database-directory-alias');
        fs.symlinkSync(path.dirname(dbPath), aliasDirectory, 'dir');
        for (const suffix of ['', '-wal', '-shm', '-journal'])
            await assert.rejects(
                exportRouteDatabaseMrt({
                    ...options,
                    addressFamily: 1,
                    filePath: path.join(aliasDirectory, `${path.basename(dbPath)}${suffix}`)
                }),
                /不能覆盖/
            );
        const aliasFile = path.join(directory, 'database-inode-alias.mrt');
        fs.linkSync(dbPath, aliasFile);
        await assert.rejects(exportRouteDatabaseMrt({ ...options, addressFamily: 1, filePath: aliasFile }), /不能覆盖/);
        assert.equal(store.getRouteCount('0|1|1'), 2);
        await assert.rejects(
            exportRouteDatabaseMrt({
                ...options,
                addressFamily: 1,
                filePath: path.join(directory, 'absent', 'file.mrt')
            }),
            /ENOENT/
        );

        assert.ok(handlers.has('bgp:exportMrt'));
        apis.get('bgpApi').exportMrt({ addressFamily: 2, groupId: 'v6' });
        assert.deepEqual(invoked.at(-1), ['bgp:exportMrt', { addressFamily: 2, groupId: 'v6' }]);
        const dialogCount = dialogs.length;
        assert.equal((await app.handleExportMrt(null, { addressFamily: 3 })).status, 'error');
        assert.equal(dialogs.length, dialogCount, 'validate stored routes before opening a save dialog');
        const canceled = await app.handleExportMrt(null, { addressFamily: 2 });
        assert.deepEqual(canceled.data, { canceled: true });
        assert.equal(app.routeMrtExporting, false);
        assert.equal(dialogs.at(-1).filters[0].extensions[0], 'mrt');
        const gate = deferred();
        saveResult = () => gate.promise;
        const pending = app.handleExportMrt(null, { addressFamily: 1 });
        assert.equal(app.getRouteDatabaseInfo().exporting, true);
        assert.equal(app.getRouteDatabaseInfo().canDelete, false);
        assert.match((await app.handleExportMrt(null, { addressFamily: 1 })).msg, /正在导出/);
        assert.match((await app.handleDeleteRouteDatabase()).msg, /正在导出/);
        gate.resolve({ canceled: true });
        await pending;
        assert.equal(app.routeMrtExporting, false);
        saveResult = { canceled: false, filePath: path.join(directory, 'offline') };
        const offline = await app.handleExportMrt(null, { addressFamily: 2, groupId: 'v6' });
        assert.equal(offline.status, 'success', offline.msg);
        assert.equal(offline.data.routeCount, 2);
        assert.equal(offline.data.filePath, path.join(directory, 'offline.mrt'));
        assert.equal(peerInfo(records(offline.data.filePath)[0]).localIp, '192.0.2.1');

        app.handleGetPeerInfo = async () => ({
            status: 'success',
            data: {
                1: [
                    { peerState: 'Idle', localIp: '192.0.2.8', routerId: '192.0.2.8', localAs: 8 },
                    { peerState: 'Established', localIp: '198.51.100.9', routerId: '198.51.100.10', localAs: 70000 }
                ]
            }
        });
        saveResult = { canceled: false, filePath: path.join(directory, 'online.MRT') };
        const online = await app.handleExportMrt(null, { addressFamily: 1 });
        assert.equal(online.status, 'success', online.msg);
        assert.equal(online.data.filePath, saveResult.filePath);
        assert.deepEqual(peerInfo(records(online.data.filePath)[0]), {
            viewName: 'NetNexus',
            routerId: '198.51.100.10',
            localIp: '198.51.100.9',
            localAs: 70000
        });
        saveResult = { canceled: false, filePath: path.join(directory, 'disappeared.mrt') };
        store.withdrawRouteGroup('v6');
        const noRows = await app.handleExportMrt(null, { addressFamily: 2 });
        assert.equal(noRows.status, 'error');
        assert.match(noRows.msg, /没有可导出/);
        assert.equal(fs.existsSync(saveResult.filePath), false);
        assert.equal(app.routeMrtExporting, false);
        store.close();
        store = null;
        const missing = fixture('no-database');
        const noDatabase = await missing.app.handleExportMrt(null, { addressFamily: 1 });
        assert.match(noDatabase.msg, /没有可导出/);
        assert.equal(fs.existsSync(path.dirname(missing.dbPath)), false);
        console.log(
            'bgp_mrt_export passed: saved snapshots, all/group streams, WAL consistency, atomic failures, offline IPC'
        );
    } finally {
        if (store) store.close();
        Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
