'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse: parseVue } = require('@vue/compiler-sfc');
const { parse: parseJavaScript } = require('@babel/parser');
const { ref } = require('vue');
const BgpConst = require('../../electron/const/bgpConst');

function visitAst(root, visit) {
    const pending = [root];
    while (pending.length > 0) {
        const node = pending.pop();
        if (!node || typeof node !== 'object') continue;
        if (typeof node.type === 'string') visit(node);
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) pending.push(...value);
            else if (value && typeof value === 'object') pending.push(value);
        }
    }
}

function findAstNode(root, matches) {
    let found;
    visitAst(root, node => {
        if (!found && matches(node)) found = node;
    });
    return found;
}

function deferred() {
    let resolve;
    const promise = new Promise(onResolve => {
        resolve = onResolve;
    });
    return { promise, resolve };
}

// Execute the complete production handlers from each SFC. Do not duplicate the
// row-key or detail request implementations in this regression harness.
function createPageHarness(instancePage) {
    const file = instancePage ? 'BgpLocRib.vue' : 'BgpSession.vue';
    const source = fs.readFileSync(path.join(__dirname, '../../src/view/bmp', file), 'utf8');
    const { descriptor, errors } = parseVue(source);
    assert.deepEqual(errors, []);
    assert.match(descriptor.template.content, /:row-key="getRouteRowKey"/);
    assert.match(descriptor.template.content, /@click="viewRouteDetailJson\(record\)"/);
    const script = descriptor.scriptSetup.content;
    const ast = parseJavaScript(script, { sourceType: 'module' });
    const names = new Set([
        'normalizeRoutePathId',
        'normalizeRouteRd',
        'getRouteKey',
        'getRouteRowKey',
        'viewRouteDetailJson',
        'routeDetailRequestId'
    ]);
    const declarations = ast.program.body.filter(
        node => node.type === 'VariableDeclaration' && node.declarations.some(item => names.has(item.id.name))
    );
    assert.equal(declarations.length, names.size, `${file}: all complete production declarations are loaded`);

    const client = { persistentSourceId: 'a'.repeat(64) };
    const selection = { persistentScopeId: 'detail-ui-scope', addrFamilyType: BgpConst.BGP_ADDR_FAMILY.IPV4_QP };
    const requests = [];
    const failures = [];
    const request = (...args) => {
        const pending = deferred();
        requests.push({ args, ...pending });
        return pending.promise;
    };
    const context = {
        monitoredClient: ref(client),
        activeBgpSessionKey: ref('detail-peer'),
        activeLocRibAf: ref(BgpConst.BGP_ADDR_FAMILY.IPV4_QP),
        activeLocRibType: ref('2'),
        activeInstanceKey: ref('detail-instance'),
        getActiveSession: () => selection,
        getSessionApiInfo: () => selection,
        getActiveInstanceApiInfo: () => selection,
        getMonitoredClientApiInfo: () => client,
        detailsDrawerTitle: ref(''),
        detailsDrawerVisible: ref(false),
        currentDetails: ref(null),
        routeDetailLoading: ref(false),
        routeEventTarget: ref(null),
        window: { bmpApi: { getBgpRouteDetail: request, getBgpInstanceRouteDetail: request } },
        notify: { error: message => failures.push(message) },
        console: { error() {} }
    };
    vm.runInNewContext(
        `${declarations.map(node => script.slice(node.start, node.end)).join('\n')}
        globalThis.page = { key: getRouteRowKey, view: viewRouteDetailJson };`,
        context,
        { filename: file }
    );
    return { ...context.page, context, requests, failures, client, selection, instancePage };
}

function assertRequest(page, request, record) {
    assert.equal(request.args.length, page.instancePage ? 3 : 5, 'detail IPC needs only the existing routeKey');
    assert.equal(request.args[0], page.client);
    assert.equal(request.args[1], page.selection);
    assert.equal(request.args.at(-1), record.routeKey, 'IPC identifies the selected complete NLRI by routeKey');
    if (!page.instancePage) {
        assert.equal(request.args[2], BgpConst.BGP_ADDR_FAMILY.IPV4_QP);
        assert.equal(request.args[3], '2');
    }
}

async function verifyPage(instancePage) {
    const page = createPageHarness(instancePage);
    const records = [101, 102].map(dqpn => ({
        addrFamilyType: BgpConst.BGP_ADDR_FAMILY.IPV4_QP,
        afi: 1,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_QP,
        pathId: 0,
        rd: '0:0',
        ip: '203.0.113.0',
        mask: 24,
        routeKey: `0|0:0|qp:203.0.113.0/24:dqpn=${dqpn}/24|24`,
        persistentScopeId: page.selection.persistentScopeId,
        nlriDetail: { prefix: '203.0.113.0', length: 24, dqpn, dqpnBits: 24 }
    }));
    assert.notEqual(records[0].routeKey, records[1].routeKey, 'QP keys include their distinct DQPN identity');
    assert.notEqual(page.key(records[0]), page.key(records[1]), 'table keys distinguish complete route keys');
    for (const record of records) assert.equal(page.key(record), `${record.addrFamilyType}|${record.routeKey}`);

    for (const [index, record] of records.entries()) {
        const pending = page.view(record);
        const request = page.requests[index];
        assertRequest(page, request, record);
        assert.equal(page.context.routeDetailLoading.value, true);
        assert.equal(page.context.detailsDrawerVisible.value, true);
        assert.equal(page.context.routeEventTarget.value.routeKey, record.routeKey);
        request.resolve({ status: 'success', data: { ...record, detailMarker: `selected-${index}` } });
        await pending;
        assert.equal(page.context.currentDetails.value.routeKey, record.routeKey);
        assert.equal(page.context.currentDetails.value.nlriDetail.dqpn, record.nlriDetail.dqpn);
        assert.equal(page.context.currentDetails.value.detailMarker, `selected-${index}`);
        assert.equal(page.context.routeDetailLoading.value, false);
    }

    // Late detail responses from the first QP path cannot overwrite the second
    // selection, even though their displayed prefix is equal.
    const oldRequest = page.view(records[0]);
    const newRequest = page.view(records[1]);
    assertRequest(page, page.requests[2], records[0]);
    assertRequest(page, page.requests[3], records[1]);
    page.requests[3].resolve({ status: 'success', data: records[1] });
    await newRequest;
    page.requests[2].resolve({ status: 'success', data: records[0] });
    await oldRequest;
    assert.equal(page.context.currentDetails.value.routeKey, records[1].routeKey);
    assert.equal(page.context.currentDetails.value.nlriDetail.dqpn, 102);
    assert.equal(page.context.routeDetailLoading.value, false);
    assert.deepEqual(page.failures, []);
}

async function verifyForwarding() {
    const preload = fs.readFileSync(path.join(__dirname, '../../electron/preload.js'), 'utf8');
    const preloadAst = parseJavaScript(preload, { sourceType: 'script' });
    const exposure = findAstNode(
        preloadAst,
        node =>
            node.type === 'CallExpression' &&
            node.callee.type === 'MemberExpression' &&
            node.callee.property.name === 'exposeInMainWorld' &&
            node.arguments[0]?.value === 'bmpApi'
    );
    assert.ok(exposure, 'the actual bmpApi preload exposure is loaded');
    assert.equal(exposure.callee.object.type, 'Identifier', 'the actual contextBridge binding can be injected');
    const invokeBindings = new Set();
    visitAst(exposure.arguments[1], node => {
        if (
            node.type === 'CallExpression' &&
            node.callee.type === 'MemberExpression' &&
            node.callee.property.name === 'invoke'
        ) {
            assert.equal(node.callee.object.type, 'Identifier', 'the actual IPC binding can be injected');
            invokeBindings.add(node.callee.object.name);
        }
    });
    assert.ok(invokeBindings.size > 0, 'the actual bmpApi IPC invoke bindings are loaded');
    const invocations = [];
    let api;
    const preloadContext = {
        [exposure.callee.object.name]: {
            exposeInMainWorld(name, value) {
                assert.equal(name, 'bmpApi');
                api = value;
            }
        }
    };
    for (const binding of invokeBindings) {
        preloadContext[binding] = {
            invoke(...args) {
                invocations.push(args);
                return Promise.resolve({ status: 'success' });
            }
        };
    }
    vm.runInNewContext(preload.slice(exposure.start, exposure.end), preloadContext);
    const client = { persistentSourceId: 'a'.repeat(64) };
    const owner = { persistentScopeId: 'forwarding-scope' };
    const routeKey = '0|0:0|qp:203.0.113.0/24:dqpn=102/24|24';
    assert.equal(api.getBgpRouteDetail.length, 5);
    assert.equal(api.getBgpInstanceRouteDetail.length, 3);
    await api.getBgpRouteDetail(client, owner, BgpConst.BGP_ADDR_FAMILY.IPV4_QP, '2', routeKey);
    await api.getBgpInstanceRouteDetail(client, owner, routeKey);
    assert.deepEqual(invocations[0], [
        'bmp:getBgpRouteDetail',
        client,
        owner,
        BgpConst.BGP_ADDR_FAMILY.IPV4_QP,
        '2',
        routeKey
    ]);
    assert.deepEqual(invocations[1], ['bmp:getBgpInstanceRouteDetail', client, owner, routeKey]);

    const appSource = fs.readFileSync(path.join(__dirname, '../../electron/app/bmpApp.js'), 'utf8');
    const appAst = parseJavaScript(appSource, { sourceType: 'script' });
    const names = new Set(['handleGetBgpRouteDetail', 'handleGetBgpInstanceRouteDetail']);
    const appClass = findAstNode(
        appAst,
        node =>
            ['ClassDeclaration', 'ClassExpression'].includes(node.type) &&
            [...names].every(name =>
                node.body.body.some(method => method.type === 'ClassMethod' && method.key.name === name)
            )
    );
    assert.ok(appClass, 'the actual App class is located by its public detail IPC handlers');
    const methods = appClass.body.body.filter(node => node.type === 'ClassMethod' && names.has(node.key.name));
    assert.equal(methods.length, 2, 'both actual App detail IPC handlers are loaded');
    const appContext = {};
    vm.runInNewContext(
        `globalThis.Handlers = class { ${methods.map(node => appSource.slice(node.start, node.end)).join('\n')} };`,
        appContext
    );
    const app = new appContext.Handlers();
    const calls = [];
    app.queryBgpRouteDetail = async payload => {
        calls.push(payload);
        return { status: 'success', data: { routeKey: payload.routeKey } };
    };
    app.queryBgpInstanceRouteDetail = app.queryBgpRouteDetail;
    const peer = await app.handleGetBgpRouteDetail({}, client, owner, BgpConst.BGP_ADDR_FAMILY.IPV4_QP, '2', routeKey);
    const instance = await app.handleGetBgpInstanceRouteDetail({}, client, owner, routeKey);
    assert.equal(peer.data.routeKey, routeKey);
    assert.equal(instance.data.routeKey, routeKey);
    for (const payload of calls) {
        assert.equal(payload.client, client);
        assert.equal(payload.routeKey, routeKey);
        assert.equal(
            Object.prototype.hasOwnProperty.call(payload, 'routeId'),
            false,
            'App does not add a new ID parameter'
        );
    }
    assert.equal(calls[0].session, owner);
    assert.equal(calls[1].instance, owner);
}

async function main() {
    await verifyPage(false);
    await verifyPage(true);
    await verifyForwarding();
    console.log('BMP peer/Loc-RIB detail UI unique routeKey and late-response regressions passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
