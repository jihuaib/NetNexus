const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const BgpApp = require('../../electron/app/bgpApp');
const BgpConst = require('../../electron/const/bgpConst');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const { PROTOCOL_PROCESS_SERVICES } = require('../../electron/worker/core/protocolProcessServices');

function makeIpc() {
    return {
        handlers: new Map(),
        handle(channel, handler) {
            this.handlers.set(channel, handler);
        }
    };
}

function makeStore() {
    const values = new Map();
    return {
        get: key => values.get(key),
        set: (key, value) => values.set(key, value)
    };
}

function getFreeTcpPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(error => (error ? reject(error) : resolve(port)));
        });
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    do {
        const result = predicate();
        if (result) return result;
        await delay(25);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${description}`);
}

async function assertUtilityProcess(client) {
    const host = client.process;
    assert.equal(host.runtimeKind, 'utility-process', 'BGP route ownership CI must use an Electron Utility process');
    const pid = await waitFor(() => host.pid, 'BGP utility PID');
    assert.notEqual(pid, process.pid, 'BGP route database owner must not be the Electron main process');

    const metric = await waitFor(
        () => app.getAppMetrics().find(item => item.pid === pid),
        `BGP utility PID ${pid} to appear in app metrics`
    );
    assert.equal(metric.type, 'Utility');
    assert(
        metric.name === PROTOCOL_PROCESS_SERVICES.BGP || metric.serviceName === PROTOCOL_PROCESS_SERVICES.BGP,
        'BGP route database owner must be identifiable by its protocol service name'
    );
    return { host, pid };
}

function assertNotRunning(response) {
    assert.equal(response.status, 'error');
    assert.equal(response.data, null);
    assert.match(response.msg, /没有运行/);
}

async function startBgp(bgpApp, sender) {
    const result = await bgpApp.handleStartBgp(
        { sender },
        {
            localAs: '65000',
            routerId: '192.0.2.1',
            port: await getFreeTcpPort(),
            addressFamily: [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC]
        }
    );
    assert.equal(result.status, 'success', result.msg);
    return bgpApp.worker;
}

async function main() {
    assert.equal(
        process.env.NETNEXUS_EXPECT_UTILITY_PROCESS,
        '1',
        'BGP route ownership CI must run through the real Electron utility-process runner'
    );

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-process-routes-'));
    const dbPath = path.join(tempDir, 'bgp.sqlite3');
    const rendererEvents = [];
    const sender = {
        send(channel, payload) {
            if (channel === 'unified-event') rendererEvents.push(payload);
        },
        isDestroyed() {
            return false;
        }
    };
    const bgpApp = new BgpApp(makeIpc(), makeStore());
    bgpApp.getBgpRouteDatabasePath = () => dbPath;

    // A patch in the Electron main isolate cannot affect the Utility process. Any
    // accidental main-process SQLite read therefore fails this test immediately.
    const originalOpen = BgpRouteSqliteStore.prototype.open;
    BgpRouteSqliteStore.prototype.open = function forbidMainProcessBgpDbOpen() {
        throw new Error('MAIN_PROCESS_BGP_DB_ACCESS_FORBIDDEN');
    };

    try {
        assertNotRunning(await bgpApp.handleGetRoutes(null, BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, 1, 25));
        assertNotRunning(
            await bgpApp.handleGetRouteDetail(null, BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, {
                ip: '203.0.113.77',
                mask: 32,
                rd: '0:0',
                pathId: 0
            })
        );

        const firstClient = await startBgp(bgpApp, sender);
        const firstProcess = await assertUtilityProcess(firstClient);
        const observedOps = [];
        const sendRequest = firstClient.sendRequest.bind(firstClient);
        firstClient.sendRequest = (op, data, options) => {
            observedOps.push(op);
            return sendRequest(op, data, options);
        };

        const generated = await bgpApp.handleGenerateIpv4Routes(null, {
            addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
            prefix: '203.0.113.77',
            mask: 32,
            count: 1,
            rd: '0:0',
            pathId: 0,
            customAttr: '',
            rt: '',
            randomAsPathEnabled: false,
            addPathEnabled: false,
            srv6Enabled: false
        });
        assert.equal(generated.status, 'success', generated.msg);
        assert.equal(generated.data.total, 1);

        const livePage = await bgpApp.handleGetRoutes(null, BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, 1, 25);
        assert.equal(livePage.status, 'success', livePage.msg);
        assert.equal(livePage.data.total, 1);
        assert.equal(livePage.data.list[0].ip, '203.0.113.77');
        assert(observedOps.includes(BgpConst.BGP_REQ_TYPES.GET_ROUTES));

        const liveDetail = await bgpApp.handleGetRouteDetail(
            null,
            BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
            livePage.data.list[0]
        );
        assert.equal(liveDetail.status, 'success', liveDetail.msg);
        assert.equal(liveDetail.data.ip, '203.0.113.77');
        assert(observedOps.includes(BgpConst.BGP_REQ_TYPES.GET_ROUTE_DETAIL));

        const disabledFamily = await bgpApp.handleGetRoutes(null, BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST, 1, 25);
        assert.equal(disabledFamily.status, 'error');
        assert.equal(disabledFamily.data, null);
        assert.match(disabledFamily.msg, /地址族未启动/);

        const stopped = await bgpApp.handleStopBgp();
        assert.equal(stopped.status, 'success', stopped.msg);
        assert.equal(bgpApp.worker, null);
        assert.equal(firstProcess.host.runtime, null);
        await waitFor(
            () => !app.getAppMetrics().some(item => item.pid === firstProcess.pid),
            `BGP utility PID ${firstProcess.pid} to leave app metrics`
        );
        assert.equal(fs.existsSync(dbPath), true, 'stopping BGP must retain the route database for the next runtime');
        assertNotRunning(await bgpApp.handleGetRoutes(null, BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, 1, 25));

        const secondClient = await startBgp(bgpApp, sender);
        const secondProcess = await assertUtilityProcess(secondClient);
        assert.notEqual(secondProcess.pid, firstProcess.pid, 'a BGP restart must create a new protocol process');

        const restoredPage = await bgpApp.handleGetRoutes(null, BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, 1, 25);
        assert.equal(restoredPage.status, 'success', restoredPage.msg);
        assert.equal(restoredPage.data.total, 1, 'a new BGP runtime must restore routes from the retained database');
        assert.equal(restoredPage.data.list[0].ip, '203.0.113.77');

        const restoredDetail = await bgpApp.handleGetRouteDetail(
            null,
            BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
            restoredPage.data.list[0]
        );
        assert.equal(restoredDetail.status, 'success', restoredDetail.msg);
        assert.equal(restoredDetail.data.ip, '203.0.113.77');

        const runtime = secondProcess.host.runtime;
        assert(runtime, 'second BGP utility runtime must still be alive before the crash check');
        assert.notEqual(runtime.kill(), false, 'BGP utility process kill must be accepted');
        await waitFor(() => bgpApp.worker === null, 'BgpApp to observe unexpected process exit');
        await waitFor(() => secondProcess.host.runtime === null, 'BGP process host to observe unexpected exit');
        await waitFor(
            () => !app.getAppMetrics().some(item => item.pid === secondProcess.pid),
            `crashed BGP utility PID ${secondProcess.pid} to leave app metrics`
        );
        assertNotRunning(await bgpApp.handleGetRoutes(null, BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, 1, 25));

        const runtimeStates = rendererEvents
            .filter(event => event.type === 'bgp:runtimeChanged')
            .map(event => event.data.running);
        assert.deepEqual(runtimeStates, [true, false, true, false]);

        console.log(
            `BGP process route ownership passed: main=${process.pid}, first=${firstProcess.pid}, second=${secondProcess.pid}`
        );
    } finally {
        if (bgpApp.worker) {
            await bgpApp.handleStopBgp().catch(() => {});
            await bgpApp.worker?.terminate().catch(() => {});
        }
        BgpRouteSqliteStore.prototype.open = originalOpen;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = main;
