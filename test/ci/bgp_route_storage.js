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
const ProtocolProcessWithPromise = require('../../electron/worker/core/protocolProcessWithPromise');
const EventDispatcher = require('../../electron/utils/eventDispatcher');
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
    assert.strictEqual(stoppedPage.status, 'error');
    assert.strictEqual(stoppedPage.data, null, 'stopped BGP must not expose persisted routes');
    assert.match(stoppedPage.msg, /没有运行/);
    const stoppedDetail = await app.handleGetRouteDetail(null, addressFamily, {
        ip: '192.0.2.1',
        mask: 32,
        rd: '0:0',
        pathId: 0
    });
    assert.strictEqual(stoppedDetail.status, 'error');
    assert.match(stoppedDetail.msg, /没有运行/);
    const stoppedLabelPage = await app.handleGetRoutes(null, labelFamily, 1, 25);
    assert.strictEqual(stoppedLabelPage.status, 'error');
    assert.strictEqual(stoppedLabelPage.data, null);

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
    assert.strictEqual(disabledFamilyPage.status, 'error', 'disabled family must not expose persisted routes');
    assert.strictEqual(disabledFamilyPage.data, null);
    assert.match(disabledFamilyPage.msg, /地址族未启动/);
    assert.strictEqual(worker.calls.length, 0, 'disabled family must not query the BGP process');
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

    const runtimeEvents = [];
    let listenerRemoved = false;
    let dispatcherCleaned = false;
    const terminationError = new Error('synthetic BGP terminate failure');
    const failingStopWorker = {
        async sendRequest(op, data) {
            assert.strictEqual(op, BgpConst.BGP_REQ_TYPES.STOP_BGP);
            assert.strictEqual(data, null);
            return { status: 'success', msg: 'bgp协议停止成功', data: null };
        },
        removeEventListener(eventName) {
            assert.strictEqual(eventName, BgpConst.BGP_EVT_TYPES.BGP_PEER_CHANGE);
            listenerRemoved = true;
        },
        async terminate() {
            throw terminationError;
        }
    };
    app.worker = failingStopWorker;
    app.startedAddressFamilies = new Set([addressFamily]);
    app.eventDispatcher = {
        emit(type, data) {
            runtimeEvents.push({ type, data });
        },
        cleanup() {
            dispatcherCleaned = true;
        }
    };

    const failedStop = await app.handleStopBgp();
    assert.strictEqual(failedStop.status, 'error');
    assert.strictEqual(failedStop.data, null);
    assert.match(failedStop.msg, /synthetic BGP terminate failure/);
    assert.strictEqual(listenerRemoved, true);
    assert.strictEqual(app.worker, null, 'terminate failure must not leave a stale BGP worker');
    assert.strictEqual(app.getBgpRunning(), false);
    assert.strictEqual(app.startedAddressFamilies.size, 0, 'terminate failure must clear started address families');
    assert.deepStrictEqual(runtimeEvents, [
        {
            type: 'bgp:runtimeChanged',
            data: { running: false, addressFamilies: [] }
        }
    ]);
    assert.strictEqual(dispatcherCleaned, true, 'terminate failure must clean up the event dispatcher');
    assert.strictEqual(app.eventDispatcher, null);

    const startError = new Error('synthetic BGP start failure');
    const startTerminationError = new Error('synthetic BGP start terminate failure');
    const startRuntimeEvents = [];
    let startDispatcherCleaned = false;
    const failedStartWorker = {
        addEventListener() {},
        removeEventListener(eventName) {
            assert.strictEqual(eventName, BgpConst.BGP_EVT_TYPES.BGP_PEER_CHANGE);
        },
        async sendRequest(op) {
            assert.strictEqual(op, BgpConst.BGP_REQ_TYPES.START_BGP);
            throw startError;
        },
        async terminate() {
            throw startTerminationError;
        }
    };
    const originalCreateLongRunningProcess = ProtocolProcessWithPromise.prototype.createLongRunningProcess;
    const originalDispatcherCleanup = EventDispatcher.prototype.cleanup;
    ProtocolProcessWithPromise.prototype.createLongRunningProcess = () => failedStartWorker;
    EventDispatcher.prototype.cleanup = function trackStartDispatcherCleanup() {
        startDispatcherCleaned = true;
        return originalDispatcherCleanup.call(this);
    };
    app.startedAddressFamilies = new Set([addressFamily]);
    try {
        const failedStart = await app.handleStartBgp(
            {
                sender: {
                    send(channel, payload) {
                        if (channel === 'unified-event') startRuntimeEvents.push(payload);
                    },
                    isDestroyed() {
                        return false;
                    }
                }
            },
            {
                localAs: '65000',
                routerId: '192.0.2.1',
                port: 1179,
                addressFamily: [addressFamily]
            }
        );
        assert.strictEqual(failedStart.status, 'error');
        assert.strictEqual(failedStart.data, null);
        assert.match(failedStart.msg, /synthetic BGP start terminate failure/);
    } finally {
        ProtocolProcessWithPromise.prototype.createLongRunningProcess = originalCreateLongRunningProcess;
        EventDispatcher.prototype.cleanup = originalDispatcherCleanup;
    }
    assert.strictEqual(app.worker, null, 'start terminate failure must not leave a stale BGP worker');
    assert.strictEqual(app.getBgpRunning(), false);
    assert.strictEqual(app.startedAddressFamilies.size, 0, 'start terminate failure must clear address families');
    assert.deepStrictEqual(startRuntimeEvents, [
        {
            type: 'bgp:runtimeChanged',
            data: { running: false, addressFamilies: [] }
        }
    ]);
    assert.strictEqual(startDispatcherCleaned, true, 'start terminate failure must clean up the event dispatcher');
    assert.strictEqual(app.eventDispatcher, null, 'start terminate failure must clean up the event dispatcher');

    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('BGP SQLite route integration tests passed');
})().catch(error => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
});
