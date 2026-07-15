const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

process.env.NODE_ENV = 'test';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-routes-'));
const electronMock = {
    app: {
        isPackaged: false,
        getPath(name) {
            assert.strictEqual(name, 'userData');
            return tempDir;
        }
    },
    shell: { openExternal() {} },
    dialog: {
        async showOpenDialog() {
            return { canceled: true, filePaths: [] };
        }
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
} finally {
    Module._load = originalLoad;
}

const BgpConst = require('../../electron/const/bgpConst');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpRoute = require('../../electron/worker/bgp/bgpRoute');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const { getAfiAndSafi } = require('../../electron/utils/bgpUtils');

function makeStore() {
    const values = new Map();
    return { get: key => values.get(key), set: (key, value) => values.set(key, value) };
}

function makeIpc() {
    return {
        handlers: new Map(),
        handle(channel, handler) {
            this.handlers.set(channel, handler);
        }
    };
}

function makeWorkerRecorder(resolver) {
    const calls = [];
    return {
        calls,
        async sendRequest(op, payload) {
            calls.push({ op, payload });
            return resolver(op, payload, calls);
        }
    };
}

function instanceKey(addressFamily) {
    const { afi, safi } = getAfiAndSafi(addressFamily);
    return BgpInstance.makeKey(0, afi, safi);
}

(async () => {
    const app = new BgpApp(makeIpc(), makeStore());
    assert.strictEqual(app.getBgpRouteDatabasePath(), path.join(tempDir, 'bgp', 'bgp.sqlite3'));
    const db = new BgpRouteSqliteStore({ dbPath: app.getBgpRouteDatabasePath() }).open();
    assert.equal(fs.statSync(path.join(tempDir, 'bgp')).isDirectory(), true);
    const addressFamily = BgpConst.BGP_ADDR_FAMILY.IPV4_UNC;
    const key = instanceKey(addressFamily);
    const labelFamily = BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST;
    db.upsertRoutes(key, [
        {
            routeKey: BgpRoute.makeUnicastKey(0, '0:0', '192.0.2.1', 32),
            route: { ip: '192.0.2.1', mask: 32, rd: '0:0', pathId: 0 },
            attr: { nextHop: '198.51.100.1', asPath: '65000 65001' }
        },
        {
            routeKey: BgpRoute.makeUnicastKey(0, '0:0', '192.0.2.2', 32),
            route: { ip: '192.0.2.2', mask: 32, rd: '0:0', pathId: 0 },
            attr: { nextHop: '198.51.100.1', asPath: '65000 65001' }
        }
    ]);
    db.upsertRoutes(instanceKey(labelFamily), [
        {
            routeKey: BgpRoute.makeKey('198.18.0.0', 24),
            route: { ip: '198.18.0.0', mask: 24, label: 16000 },
            attr: { nextHop: '198.51.100.1' }
        }
    ]);
    db.close();

    const stoppedPage = await app.handleGetRoutes(null, addressFamily, 1, 25);
    assert.strictEqual(stoppedPage.status, 'success');
    assert.strictEqual(stoppedPage.data.total, 2, 'stopped BGP must still expose persisted routes');
    assert.deepStrictEqual(
        stoppedPage.data.list.map(route => route.ip),
        ['192.0.2.1', '192.0.2.2']
    );
    const stoppedDetail = await app.handleGetRouteDetail(null, addressFamily, stoppedPage.data.list[0]);
    assert.strictEqual(stoppedDetail.status, 'success');
    assert.strictEqual(stoppedDetail.data.asPath, '65000 65001');
    assert.strictEqual(stoppedDetail.data.attrRefCount, 2);
    const stoppedLabelPage = await app.handleGetRoutes(null, labelFamily, 1, 25);
    const stoppedLabelDetail = await app.handleGetRouteDetail(null, labelFamily, stoppedLabelPage.data.list[0]);
    assert.strictEqual(stoppedLabelDetail.status, 'success');
    assert.strictEqual(stoppedLabelDetail.data.label, 16000);

    const worker = makeWorkerRecorder((op, payload) => {
        if (op === BgpConst.BGP_REQ_TYPES.GENERATE_IPV4_ROUTES) {
            assert.ok(
                !Object.prototype.hasOwnProperty.call(payload, 'routes'),
                'main must not materialize generated routes'
            );
            return { status: 'success', msg: '路由生成成功', data: { added: 3, updated: 0, unchanged: 0, total: 5 } };
        }
        if (op === BgpConst.BGP_REQ_TYPES.DELETE_IPV4_ROUTES) {
            return { status: 'success', msg: '路由删除成功', data: { deleted: 3, total: 2 } };
        }
        if (op === BgpConst.BGP_REQ_TYPES.DELETE_ALL_ROUTES_BY_FAMILY) {
            return { status: 'success', msg: '全部删除成功', data: { deleted: 2, total: 0 } };
        }
        if (op === BgpConst.BGP_REQ_TYPES.IMPORT_ROUTES) {
            return {
                status: 'success',
                msg: '路由导入成功',
                data: { added: payload.routes.length, updated: 0, unchanged: 0, total: payload.routes.length }
            };
        }
        return { status: 'success', msg: 'ok', data: { list: [], total: 0 } };
    });
    app.worker = worker;
    app.startedAddressFamilies = new Set([addressFamily]);
    const disabledFamilyPage = await app.handleGetRoutes(null, labelFamily, 1, 25);
    assert.strictEqual(disabledFamilyPage.data.total, 1, 'disabled family must remain visible from SQLite');
    const config = { addressFamily, prefix: '203.0.113.1', mask: 32, count: 3, customAttr: '', rt: '' };
    const generated = await app.handleGenerateIpv4Routes(null, config);
    assert.deepStrictEqual(generated.data, { added: 3, updated: 0, unchanged: 0, total: 5 });
    const deleted = await app.handleDeleteIpv4Routes(null, config);
    assert.deepStrictEqual(deleted.data, { deleted: 3, total: 2 });
    const cleared = await app.handleDeleteAllRoutesByFamily(null, addressFamily);
    assert.deepStrictEqual(cleared.data, { deleted: 2, total: 0 });
    app.startedAddressFamilies.add(BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN);
    await app.handleDeleteAllRoutesByFamily(null, BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN, { routeType: 3 });
    assert.deepStrictEqual(worker.calls.at(-1).payload, {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN,
        routeType: 3
    });

    const importResult = await app.handleImportRouteViewsData(
        null,
        path.join(__dirname, '..', '..', 'scripts', 'test-data', 'test_routes_100.mrt'),
        5,
        addressFamily
    );
    assert.strictEqual(importResult.status, 'success');
    assert.strictEqual(importResult.data.imported, 5);
    const mrtCall = worker.calls.find(call => call.op === BgpConst.BGP_REQ_TYPES.IMPORT_ROUTES);
    assert.ok(mrtCall.payload.routes.every(route => route.rd === '0:0' && route.pathId === 0));

    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('BGP SQLite route integration tests passed');
})().catch(error => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
});
