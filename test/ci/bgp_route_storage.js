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
    shell: {
        openExternal() {}
    },
    dialog: {
        async showOpenDialog() {
            return { canceled: true, filePaths: [] };
        }
    }
};

const originalLoad = Module._load;
Module._load = function mockElectron(request, parent, isMain) {
    if (request === 'electron') {
        return electronMock;
    }
    return originalLoad.call(this, request, parent, isMain);
};

let BgpApp;
try {
    BgpApp = require(path.join(__dirname, '..', '..', 'electron', 'app', 'bgpApp.js'));
} finally {
    Module._load = originalLoad;
}

const BgpConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'bgpConst.js'));
const { countBgpRoutes } = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'bgpRouteStorage.js'));

function makeStore() {
    const data = new Map();
    return {
        get(key) {
            return data.get(key);
        },
        set(key, value) {
            data.set(key, value);
        }
    };
}

function makeIpc() {
    return {
        handlers: new Map(),
        handle(channel, handler) {
            this.handlers.set(channel, handler);
        }
    };
}

function makeWorkerRecorder(resolvers = {}) {
    const calls = [];
    return {
        calls,
        async sendRequest(op, payload) {
            calls.push({ op, payload });
            if (typeof resolvers[op] === 'function') {
                return resolvers[op](payload, calls);
            }
            return { status: 'success', msg: 'ok', data: null };
        }
    };
}

(async () => {
    const app = new BgpApp(makeIpc(), makeStore());

    const ipv4Config = {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: '192.0.2.1',
        mask: 32,
        count: 2,
        customAttr: 'origin igp',
        rt: ''
    };

    const noWorkerGenerateResult = await app.handleGenerateIpv4Routes(null, ipv4Config);
    assert.strictEqual(noWorkerGenerateResult.status, 'error');
    assert.strictEqual(noWorkerGenerateResult.msg, 'bgp协议没有运行');
    assert.deepStrictEqual(app.store.get('ipv4-unc-route-config'), ipv4Config);

    const routeFilePath = await app.ensureBgpRouteFileStorage(BgpConst.BGP_ADDR_FAMILY.IPV4_UNC);
    assert.strictEqual(await countBgpRoutes(routeFilePath), 0, 'rejected route generation must not update storage');

    const stoppedPage = await app.handleGetRoutes(null, BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, 1, 10);
    assert.strictEqual(stoppedPage.status, 'success');
    assert.deepStrictEqual(stoppedPage.data, { list: [], total: 0 });

    const workerRoutes = [
        {
            addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
            ip: '192.0.2.1',
            mask: 32
        },
        {
            addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
            ip: '192.0.2.2',
            mask: 32
        }
    ];
    const worker = makeWorkerRecorder({
        [BgpConst.BGP_REQ_TYPES.GET_ROUTES]: () => ({
            status: 'success',
            msg: 'ok',
            data: {
                list: workerRoutes,
                total: workerRoutes.length
            }
        }),
        [BgpConst.BGP_REQ_TYPES.DELETE_ALL_ROUTES_BY_FAMILY]: () => ({
            status: 'success',
            msg: '成功删除所有 2 条路由',
            data: {
                deleted: 2
            }
        })
    });
    app.worker = worker;
    app.startedAddressFamilies = new Set([BgpConst.BGP_ADDR_FAMILY.IPV4_UNC]);

    const ipv6Config = {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV6_UNC,
        prefix: '2001:db8::1',
        mask: 128,
        count: 1,
        customAttr: '',
        rt: ''
    };
    const ipv6GenerateResult = await app.handleGenerateIpv6Routes(null, ipv6Config);
    assert.strictEqual(ipv6GenerateResult.status, 'error');
    assert.strictEqual(ipv6GenerateResult.msg, '地址族未启动，请先在BGP配置中使能该地址族');
    assert.strictEqual(worker.calls.length, 0, 'routes for non-started address family must not be sent to worker');
    assert.strictEqual(await countBgpRoutes(routeFilePath), 0, 'non-started address family must not update storage');

    const ipv4GenerateResult = await app.handleGenerateIpv4Routes(null, ipv4Config);
    assert.strictEqual(ipv4GenerateResult.status, 'success');
    assert.strictEqual(ipv4GenerateResult.data.added, 2);
    assert.strictEqual(ipv4GenerateResult.data.total, 2);
    assert.strictEqual(worker.calls.length, 1);
    assert.strictEqual(worker.calls[0].op, BgpConst.BGP_REQ_TYPES.GENERATE_IPV4_ROUTES);

    const firstPage = await app.handleGetRoutes(null, BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, 1, 10);
    assert.strictEqual(firstPage.status, 'success');
    assert.strictEqual(firstPage.data.total, 2);
    assert.deepStrictEqual(
        firstPage.data.list.map(route => route.ip),
        ['192.0.2.1', '192.0.2.2']
    );
    assert.strictEqual(worker.calls[1].op, BgpConst.BGP_REQ_TYPES.GET_ROUTES);

    const loadResult = await app.loadBgpRouteStorageToWorker(false, new Set([BgpConst.BGP_ADDR_FAMILY.IPV4_UNC]));
    assert.strictEqual(loadResult.loaded, 2);
    assert.strictEqual(worker.calls.length, 3);
    assert.strictEqual(worker.calls[2].op, BgpConst.BGP_REQ_TYPES.IMPORT_ROUTES);
    assert.strictEqual(worker.calls[2].payload.addressFamily, BgpConst.BGP_ADDR_FAMILY.IPV4_UNC);
    assert.strictEqual(worker.calls[2].payload.routes.length, 2);
    assert(worker.calls[2].payload.routes.every(route => route.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC));

    const deleteResult = await app.handleDeleteAllRoutesByFamily(null, BgpConst.BGP_ADDR_FAMILY.IPV4_UNC);
    assert.strictEqual(deleteResult.status, 'success');
    assert.strictEqual(deleteResult.data.deleted, 2);
    assert.strictEqual(deleteResult.data.total, 0);
    assert.strictEqual(worker.calls.length, 4);
    assert.strictEqual(worker.calls[3].op, BgpConst.BGP_REQ_TYPES.DELETE_ALL_ROUTES_BY_FAMILY);
    assert.deepStrictEqual(worker.calls[3].payload, {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC
    });
    assert.strictEqual(await countBgpRoutes(routeFilePath), 0);

    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('BGP route storage tests passed');
})().catch(error => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
});
