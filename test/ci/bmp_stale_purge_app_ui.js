const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse: parseVue } = require('@vue/compiler-sfc');
const { parse: parseJavaScript } = require('@babel/parser');
const { ref, computed } = require('vue');
const BmpApp = require('../../electron/app/bmpApp');
const BmpConst = require('../../electron/const/bmpConst');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

// Execute the actual SFC handlers, not copies of their implementations. The
// browser regression also exercises their rendering and route-update listeners.
function createPageHarness(instancePage) {
    const file = instancePage ? 'BgpLocRib.vue' : 'BgpSession.vue';
    const source = fs.readFileSync(path.join(__dirname, '../../src/view/bmp', file), 'utf8');
    const { descriptor, errors } = parseVue(source);
    assert.deepEqual(errors, []);
    const script = descriptor.scriptSetup.content;
    const ast = parseJavaScript(script, { sourceType: 'module' });
    const handler = instancePage ? 'purgeStaleInstanceRoutes' : 'purgeStaleRoutes';
    const names = new Set([
        'getClientTransportKey',
        'getClientKey',
        'stalePurgePendingKeys',
        'getStalePurgeKey',
        'isPurgingStaleRoutes',
        handler,
        ...(instancePage ? [] : ['normalizeRibType', 'getSessionIdentityKey'])
    ]);
    const declarations = ast.program.body.filter(
        node => node.type === 'VariableDeclaration' && node.declarations.some(item => names.has(item.id.name))
    );
    assert.equal(declarations.length, names.size, `${file}: every production declaration is loaded`);

    const state = {
        client: ref({ persistentSourceId: 'a'.repeat(64) }),
        selection: ref({ persistentScopeId: 'scope-one', addrFamilyType: 1 }),
        requests: [],
        reloads: [],
        success: [],
        errors: [],
        reloadDeferred: null,
        valid: true
    };
    const purge = (...args) => {
        const result = deferred();
        state.requests.push({ args, ...result });
        return result.promise;
    };
    const reload = async options => {
        state.reloads.push({ scope: state.selection.value.persistentScopeId, options });
        if (state.reloadDeferred) await state.reloadDeferred.promise;
    };
    const context = {
        ref,
        computed,
        monitoredClient: state.client,
        activeBgpSessionKey: ref('peer-one'),
        activeLocRibAf: ref(1),
        activeLocRibType: ref('1'),
        activeInstanceKey: ref('instance-one'),
        bgpRoutePagination: ref({ current: 3 }),
        pageActive: true,
        getMonitoredClientApiInfo: () => state.client.value && { ...state.client.value },
        getSessionApiInfo: () => state.selection.value && { ...state.selection.value },
        getActiveInstanceApiInfo: () => state.selection.value && { ...state.selection.value },
        getActiveSession: () => state.selection.value,
        isActiveRouteSelectionValid: () => state.valid,
        clearScheduledRouteRefresh() {},
        captureRouteSelection: () => ({ scopeId: state.selection.value.persistentScopeId }),
        loadBgpRoutes: reload,
        loadInstanceRoutes: reload,
        window: { bmpApi: { purgeStaleBgpRoutes: purge, purgeStaleBgpInstanceRoutes: purge } },
        notify: {
            success: message => state.success.push(message),
            error: message => state.errors.push(message)
        },
        console: { error() {} }
    };
    vm.runInNewContext(
        `${declarations.map(node => script.slice(node.start, node.end)).join('\n')}
        globalThis.page = {
            purge: ${handler},
            pending: stalePurgePendingKeys,
            busy: isPurgingStaleRoutes,
            key: getStalePurgeKey
        };`,
        context,
        { filename: file }
    );
    return { ...context.page, context, state };
}

async function verifyPage(instancePage) {
    const page = createPageHarness(instancePage);
    const { state, context } = page;
    const first = page.purge();
    assert.equal(page.busy.value, true, 'busy is set before waiting for IPC');
    await page.purge();
    assert.equal(state.requests.length, 1, 'a duplicate handler invocation cannot send another request');

    // Pagination/filter changes do not make an in-flight scope look idle.
    context.bgpRoutePagination.value.current = 5;
    assert.equal(page.busy.value, true);
    state.selection.value = { persistentScopeId: 'scope-two', addrFamilyType: 1 };
    assert.equal(page.busy.value, false, 'another scope is independent');
    const second = page.purge();
    assert.equal(page.busy.value, true);
    state.requests[0].resolve({ status: 'success', data: { deleted: 20000 } });
    await first;
    assert.equal(page.busy.value, true, 'finishing the old scope cannot clear the new scope busy state');
    assert.equal(state.reloads.length, 0, 'an old scope cannot refresh or reset the newly selected scope');
    assert.equal(context.bgpRoutePagination.value.current, 5);
    state.requests[1].resolve({ status: 'error', msg: '数据库空间不足：具体后台原因' });
    await second;
    assert.equal(page.busy.value, false);
    assert.equal(page.pending.value.size, 0);
    assert.equal(state.errors.at(-1), '数据库空间不足：具体后台原因');
    assert.equal(state.success.length, 1, 'the failed scope must not produce a success toast');

    state.reloadDeferred = deferred();
    const third = page.purge();
    state.requests[2].resolve({ status: 'success', data: { deleted: 3 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.reloads.length, 1);
    assert.equal(page.busy.value, true, 'success waits for the final reload before releasing busy');
    assert.equal(context.bgpRoutePagination.value.current, 1);
    state.reloadDeferred.resolve();
    await third;
    assert.equal(page.busy.value, false);
    state.reloadDeferred = null;

    const rejected = page.purge();
    state.requests[3].reject(new Error('writer已退出：具体异常'));
    await rejected;
    assert.equal(state.errors.at(-1), 'writer已退出：具体异常');
    assert.equal(page.pending.value.size, 0, 'finally releases busy after rejection');

    const switchedClient = page.purge();
    state.client.value = { persistentSourceId: 'b'.repeat(64) };
    assert.equal(page.busy.value, false);
    state.requests[4].resolve({ status: 'success', data: { deleted: 1 } });
    await switchedClient;
    assert.equal(state.reloads.length, 1, 'a client switch cannot reload the new client for an old request');

    const inactive = page.purge();
    context.pageActive = false;
    state.requests[5].resolve({ status: 'success', data: { deleted: 1 } });
    await inactive;
    assert.equal(state.reloads.length, 1, 'deactivated pages do not refresh');
    assert.equal(page.pending.value.size, 0);

    if (!instancePage) {
        context.pageActive = true;
        const changedRib = page.purge();
        context.activeLocRibType.value = '2';
        assert.equal(page.busy.value, false, 'another RIB is independent');
        state.requests[6].resolve({ status: 'success', data: { deleted: 1 } });
        await changedRib;
        assert.equal(state.reloads.length, 1, 'a RIB switch cannot cause an old-request reload');
    }
}

async function verifyApp() {
    const app = Object.create(BmpApp.prototype);
    app.worker = null;
    const stoppedPeer = await app.handlePurgeStaleBgpRoutes(null, {}, {}, 1, '1');
    const stoppedInstance = await app.handlePurgeStaleBgpInstanceRoutes(null, {}, {});
    for (const result of [stoppedPeer, stoppedInstance]) {
        assert.equal(result.status, 'error');
        assert.match(result.msg, /BMP未启动/);
        assert.match(result.msg, /请先启动 BMP 服务/);
        assert.notEqual(result.data?.deleted, 0, 'a stopped service must not claim a successful zero deletion');
    }

    const calls = [];
    const pending = deferred();
    app.worker = {
        sendRequest(operation, payload) {
            calls.push({ operation, payload });
            return pending.promise;
        }
    };
    const client = { persistentSourceId: 'a'.repeat(64) };
    const session = { persistentScopeId: 'scope-peer' };
    const peerRequest = app.handlePurgeStaleBgpRoutes(null, client, session, 1, '2');
    assert.deepEqual(calls[0], {
        operation: BmpConst.BMP_REQ_TYPES.PURGE_STALE_BGP_ROUTES,
        payload: { client, session, af: 1, ribType: '2' }
    });
    pending.resolve({ data: { deleted: 25000 } });
    assert.equal((await peerRequest).data.deleted, 25000);

    app.worker = {
        async sendRequest(operation, payload) {
            assert.equal(operation, BmpConst.BMP_REQ_TYPES.PURGE_STALE_BGP_INSTANCE_ROUTES);
            assert.deepEqual(payload, { client, instance: { persistentScopeId: 'scope-instance' } });
            throw new Error('SQLite故障：需要保留到前端的原因');
        }
    };
    const failure = await app.handlePurgeStaleBgpInstanceRoutes(null, client, { persistentScopeId: 'scope-instance' });
    assert.equal(failure.status, 'error');
    assert.equal(failure.msg, 'SQLite故障：需要保留到前端的原因');
}

async function main() {
    await verifyPage(false);
    await verifyPage(true);
    await verifyApp();
    console.log('BMP stale purge app/UI deferred lifecycle tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
