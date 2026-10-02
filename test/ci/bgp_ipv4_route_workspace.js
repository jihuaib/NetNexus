const assert = require('node:assert/strict');
const BgpApp = require('../../electron/app/bgpApp');
const BgpConst = require('../../electron/const/bgpConst');

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function makeStore() {
    const values = new Map();
    return {
        get: key => clone(values.get(key)),
        set: (key, value) => values.set(key, clone(value))
    };
}

function makeApp(store) {
    const handlers = new Map();
    const app = new BgpApp({ handle: (channel, handler) => handlers.set(channel, handler) }, store);
    return { app, handlers };
}

async function main() {
    const store = makeStore();
    const { app, handlers } = makeApp(store);
    const load = handlers.get('bgp:loadIpv4UNCRouteConfig');
    const save = handlers.get('bgp:saveIpv4UNCRouteConfig');
    const generate = handlers.get('bgp:generateIpv4Routes');
    const unicastConfig = {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        prefix: '10.20.0.0',
        mask: '24',
        count: '3',
        nlriEncoding: 'mpReach',
        nlriRules: [{ id: 'add-path', type: 'addPath', enabled: true, count: 2 }],
        attributeRules: []
    };
    store.set(app.ipv4UNCRouteConfigFileKey, unicastConfig);
    const legacy = await load();
    assert.equal(legacy.status, 'success');
    assert.deepEqual(legacy.data, unicastConfig, 'existing single-route configuration must remain loadable');

    const labelConfig = {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST,
        prefix: '198.51.100.0',
        mask: '24',
        count: '8',
        nlriEncoding: 'auto',
        nlriRules: [{ id: 'label', type: 'label', enabled: true, mode: 'increment', start: '20000', step: '5' }],
        attributeRules: []
    };
    const workspace = {
        version: 6,
        activeGroupId: 'label-group',
        groups: [
            { id: 'unicast-group', name: 'IPv4普通路由', config: unicastConfig },
            { id: 'label-group', name: 'IPv4标签路由', config: labelConfig }
        ]
    };
    const saved = await save(null, { ...labelConfig, routeWorkspace: workspace });
    assert.equal(saved.status, 'success', saved.msg);
    assert.deepEqual((await load()).data.routeWorkspace, workspace);

    const workerRequests = [];
    app.startedAddressFamilies = new Set([
        BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST
    ]);
    app.worker = {
        async sendRequest(op, config) {
            workerRequests.push({ op, config });
            return { data: { added: 2, total: 2 }, msg: 'generated' };
        }
    };
    const laterUnicastConfig = { ...unicastConfig, prefix: '10.99.0.0', count: '2' };
    const generated = await generate(null, laterUnicastConfig);
    assert.equal(generated.status, 'success', generated.msg);
    assert.deepEqual(workerRequests[0], {
        op: BgpConst.BGP_REQ_TYPES.GENERATE_IPV4_ROUTES,
        config: laterUnicastConfig
    });
    assert.deepEqual(store.get(app.ipv4UNCRouteConfigFileKey), laterUnicastConfig);
    assert.deepEqual(
        (await load()).data.routeWorkspace,
        workspace,
        'generating a route group must not overwrite the saved workspace or its active selection'
    );

    const laterLabelConfig = { ...labelConfig, prefix: '203.0.113.0', count: '2' };
    assert.equal((await generate(null, laterLabelConfig)).status, 'success');
    assert.deepEqual(store.get(app.ipv4LabelRouteConfigFileKey), laterLabelConfig);
    assert.deepEqual((await load()).data.routeWorkspace, workspace, 'Label generation must retain every saved group');

    app.worker = null;
    const stopped = await generate(null, { ...unicastConfig, prefix: '10.100.0.0' });
    assert.equal(stopped.status, 'error');
    assert.deepEqual(
        (await load()).data.routeWorkspace,
        workspace,
        'a generation attempt while BGP is stopped must not erase the workspace'
    );

    const restarted = makeApp(store);
    const restored = await restarted.handlers.get('bgp:loadIpv4UNCRouteConfig')();
    assert.equal(restored.status, 'success');
    assert.deepEqual(
        restored.data.routeWorkspace,
        workspace,
        'a new app instance must restore saved groups and active ID'
    );
    console.log('BGP IPv4 route workspace persistence tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
