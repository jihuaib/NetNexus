const assert = require('node:assert/strict');
const BgpApp = require('../../electron/app/bgpApp');
const BgpConst = require('../../electron/const/bgpConst');
const UNC = BgpConst.BGP_ADDR_FAMILY.IPV4_UNC;
const LABEL = BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST;
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function makeStore() {
    const values = new Map();
    return { get: key => clone(values.get(key)), set: (key, value) => values.set(key, clone(value)) };
}
function makeApp(store) {
    const handlers = new Map();
    const app = new BgpApp({ handle: (channel, handler) => handlers.set(channel, handler) }, store);
    return { app, handlers };
}
function config(addressFamily, prefix) {
    return { addressFamily, prefix, mask: '24', count: '3', nlriEncoding: 'auto', nlriRules: [], attributeRules: [] };
}
async function main() {
    const store = makeStore();
    const { app, handlers } = makeApp(store);
    const loadUnc = handlers.get('bgp:loadIpv4UNCRouteConfig');
    const loadLabel = handlers.get('bgp:loadIpv4LabelRouteConfig');
    const saveUnc = handlers.get('bgp:saveIpv4UNCRouteConfig');
    const saveLabel = handlers.get('bgp:saveIpv4LabelRouteConfig');
    const generate = handlers.get('bgp:generateIpv4Routes');
    const deleteRoutes = handlers.get('bgp:deleteIpv4Routes');
    const uncConfig = config(UNC, '10.20.0.0');
    const labelConfig = config(LABEL, '198.51.100.0');
    store.set(app.ipv4UNCRouteConfigFileKey, uncConfig);
    store.set(app.ipv4LabelRouteConfigFileKey, labelConfig);
    assert.deepEqual((await loadUnc()).data, uncConfig, 'flat UNC configuration remains loadable');
    assert.deepEqual((await loadLabel()).data, labelConfig, 'flat Label configuration remains loadable');

    const legacy = {
        version: 6,
        activeGroupId: 'label-group',
        groups: [
            { id: 'unc-first', name: 'First UNC', config: uncConfig },
            { id: 'label-group', name: 'Label', config: labelConfig },
            { id: 'unc-second', name: 'Second UNC', config: config(UNC, '10.21.0.0') }
        ]
    };
    store.set(app.ipv4RouteWorkspaceFileKey, legacy);
    const migratedUnc = (await loadUnc()).data.routeWorkspace;
    const migratedLabel = (await loadLabel()).data.routeWorkspace;
    assert.deepEqual(migratedUnc.groups, [legacy.groups[0], legacy.groups[2]]);
    assert.equal(migratedUnc.activeGroupId, 'unc-first');
    assert.deepEqual(migratedLabel.groups, [legacy.groups[1]]);
    assert.equal(migratedLabel.activeGroupId, 'label-group');
    assert.equal(store.get(app.getRouteWorkspaceStoreKey(UNC)), undefined, 'fallback reads do not persist migration');
    assert.equal(store.get(app.getRouteWorkspaceStoreKey(LABEL)), undefined);
    assert.deepEqual(store.get(app.ipv4RouteWorkspaceFileKey), legacy);

    const uncWorkspace = { ...migratedUnc, activeGroupId: 'unc-second' };
    assert.equal((await saveUnc(null, { ...uncConfig, routeWorkspace: uncWorkspace })).status, 'success');
    assert.deepEqual(
        (await loadLabel()).data.routeWorkspace,
        migratedLabel,
        'saving UNC retains unsaved Label fallback'
    );
    const labelWorkspace = {
        ...migratedLabel,
        groups: [...migratedLabel.groups, { id: 'label-second', name: 'Second Label', config: labelConfig }],
        activeGroupId: 'label-second'
    };
    assert.equal((await saveLabel(null, { ...labelConfig, routeWorkspace: labelWorkspace })).status, 'success');
    assert.deepEqual((await loadUnc()).data.routeWorkspace, uncWorkspace);
    assert.deepEqual((await loadLabel()).data.routeWorkspace, labelWorkspace);
    assert.notEqual(app.getRouteWorkspaceStoreKey(UNC), app.getRouteWorkspaceStoreKey(LABEL));
    assert.deepEqual(store.get(app.ipv4RouteWorkspaceFileKey), legacy, 'the original mixed workspace is retained');

    const requests = [];
    app.startedAddressFamilies = new Set([UNC, LABEL]);
    app.worker = {
        async sendRequest(op, payload) {
            requests.push({ op, payload });
            return { data: { added: 2, deleted: 1, total: 2 }, msg: 'success' };
        }
    };
    for (const family of [UNC, LABEL]) {
        const payload = { ...config(family, '203.0.113.0'), groupId: `group-${family}` };
        assert.equal((await generate(null, payload)).status, 'success');
        assert.deepEqual(requests[requests.length - 1], { op: BgpConst.BGP_REQ_TYPES.GENERATE_IPV4_ROUTES, payload });
        assert.equal((await deleteRoutes(null, { ...payload, groupId: undefined })).status, 'success');
        assert.equal(requests[requests.length - 1].op, BgpConst.BGP_REQ_TYPES.DELETE_IPV4_ROUTES);
        assert.equal(requests[requests.length - 1].payload.addressFamily, family);
    }
    assert.deepEqual((await loadUnc()).data.routeWorkspace, uncWorkspace);
    assert.deepEqual((await loadLabel()).data.routeWorkspace, labelWorkspace);
    await saveUnc(null, { ...uncConfig });
    await saveLabel(null, { ...labelConfig, routeWorkspace: { version: 6, groups: [], activeGroupId: null } });
    assert.deepEqual((await loadUnc()).data.routeWorkspace, uncWorkspace, 'flat saves retain reusable UNC groups');
    assert.deepEqual((await loadLabel()).data.routeWorkspace, labelWorkspace, 'empty saves do not erase Label groups');

    app.worker = {
        async sendRequest() {
            throw new Error('generation failed');
        }
    };
    assert.equal((await generate(null, labelConfig)).status, 'error');
    app.worker = null;
    assert.equal((await generate(null, uncConfig)).status, 'error');
    const reopened = makeApp(store);
    assert.deepEqual((await reopened.handlers.get('bgp:loadIpv4UNCRouteConfig')()).data.routeWorkspace, uncWorkspace);
    assert.deepEqual(
        (await reopened.handlers.get('bgp:loadIpv4LabelRouteConfig')()).data.routeWorkspace,
        labelWorkspace
    );
    assert.deepEqual(store.get(app.ipv4RouteWorkspaceFileKey), legacy);

    const onlyUnc = makeStore();
    const empty = makeApp(onlyUnc);
    onlyUnc.set(empty.app.ipv4RouteWorkspaceFileKey, { ...legacy, groups: [legacy.groups[0]] });
    assert.deepEqual((await empty.handlers.get('bgp:loadIpv4LabelRouteConfig')()).data.routeWorkspace.groups, []);
    assert.equal((await empty.handlers.get('bgp:loadIpv4LabelRouteConfig')()).data.routeWorkspace.activeGroupId, null);
    const oldFlat = makeStore();
    const oldApp = makeApp(oldFlat);
    oldFlat.set(oldApp.app.ipv4UNCRouteConfigFileKey, labelConfig);
    assert.equal((await oldApp.handlers.get('bgp:loadIpv4UNCRouteConfig')()).data, null);
    assert.deepEqual((await oldApp.handlers.get('bgp:loadIpv4LabelRouteConfig')()).data, labelConfig);
    await oldApp.handlers.get('bgp:saveIpv4UNCRouteConfig')(null, uncConfig);
    assert.deepEqual(
        (await oldApp.handlers.get('bgp:loadIpv4LabelRouteConfig')()).data,
        labelConfig,
        'saving UNC first must preserve a flat-only Label draft previously stored under the UNC key'
    );
    const distinctLabelConfig = { ...labelConfig, prefix: '203.0.113.0' };
    oldFlat.set(oldApp.app.ipv4LabelRouteConfigFileKey, distinctLabelConfig);
    oldFlat.set(oldApp.app.ipv4UNCRouteConfigFileKey, labelConfig);
    await oldApp.handlers.get('bgp:saveIpv4UNCRouteConfig')(null, uncConfig);
    assert.deepEqual(
        (await oldApp.handlers.get('bgp:loadIpv4LabelRouteConfig')()).data,
        distinctLabelConfig,
        'legacy protection must not replace an existing separate Label draft'
    );
    const generatedFlat = makeStore();
    const generationApp = makeApp(generatedFlat);
    generatedFlat.set(generationApp.app.ipv4UNCRouteConfigFileKey, labelConfig);
    assert.equal((await generationApp.handlers.get('bgp:generateIpv4Routes')(null, uncConfig)).status, 'error');
    assert.deepEqual(
        (await generationApp.handlers.get('bgp:loadIpv4LabelRouteConfig')()).data,
        labelConfig,
        'saving the last UNC generation attempt must also preserve the flat-only Label draft'
    );
    console.log('BGP IPv4 UNC/Label isolated workspace migration, generation, failure and reload tests passed');
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
