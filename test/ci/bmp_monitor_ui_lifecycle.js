const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse: parseVue } = require('@vue/compiler-sfc');
const { parse: parseJavaScript } = require('@babel/parser');
const { ref, computed } = require('vue');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}
async function flush() {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

// Load every non-import statement from the real SFC. Only IPC, framework
// lifecycle registration and timers are mocked; no handler implementation is copied.
function loadPage(file, api, exportedNames, props = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/view/bmp', file), 'utf8');
    const { descriptor, errors } = parseVue(source);
    assert.deepEqual(errors, []);
    const script = descriptor.scriptSetup.content;
    const ast = parseJavaScript(script, { sourceType: 'module' });
    const hooks = { activated: [], mounted: [], deactivated: [], unmounted: [] };
    const listeners = new Map();
    const timers = new Map();
    const notifications = [];
    const subscriptions = [];
    const watchers = [];
    let nextTimer = 1;
    const route = { name: file === 'BgpRouteLens.vue' ? 'BgpRouteLens' : 'BgpLocRibStatisReport', query: {} };
    const context = {
        ref,
        computed,
        defineOptions() {},
        defineProps: () => props,
        useRoute: () => route,
        onActivated: callback => hooks.activated.push(callback),
        onMounted: callback => hooks.mounted.push(callback),
        onDeactivated: callback => hooks.deactivated.push(callback),
        onBeforeUnmount: callback => hooks.unmounted.push(callback),
        watch: (...args) => watchers.push(args),
        BMP_EVENT_PAGE_ID: {},
        ADDRESS_FAMILY_NAME: {},
        getAddrFamilyType: () => 1,
        ipaddr: require('ipaddr.js'),
        EyeOutlined: {},
        RouteOutlined: {},
        SearchOutlined: {},
        EventBus: {
            on: (type, _page, callback) => listeners.set(type, callback),
            off: type => listeners.delete(type)
        },
        setTimeout: (callback, delay) => {
            const id = nextTimer++;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimeout: id => timers.delete(id),
        window: {
            bmpApi: api,
            windowApi: {
                subscribeEventScope: scope => {
                    subscriptions.push(['on', scope]);
                    return Promise.resolve();
                },
                unsubscribeEventScope: scope => {
                    subscriptions.push(['off', scope]);
                    return Promise.resolve();
                }
            }
        },
        notify: { error: message => notifications.push(message) },
        console: { error() {} }
    };
    const body = ast.program.body
        .filter(node => node.type !== 'ImportDeclaration')
        .map(node => script.slice(node.start, node.end))
        .join('\n');
    vm.runInNewContext(`${body}\nglobalThis.page = { ${exportedNames.join(', ')} };`, context, { filename: file });
    return { ...context.page, hooks, listeners, timers, notifications, subscriptions, watchers, route };
}

const sourceId = 'a'.repeat(64);
const client = connectionId => ({
    persistentSourceId: sourceId,
    persistentConnectionId: connectionId,
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '192.0.2.1',
    remotePort: connectionId === 'new' ? 49153 : 49152,
    isOnline: true,
    connectionState: 'open'
});
const success = data => ({ status: 'success', data });
const report = (selectedClient, value) => ({
    client: selectedClient,
    instance: { instanceType: 3, instanceRd: '64512:1' },
    statistics: [{ type: 1, value }]
});

async function verifyLocRibStatistics() {
    const requests = [];
    const page = loadPage(
        'BgpLocRibStatisReport.vue',
        {
            getClient: async () => success(client('old')),
            getBgpInstanceStatisticsReports: selectedClient => {
                const pending = deferred();
                requests.push({ client: selectedClient, ...pending });
                return pending.promise;
            }
        },
        [
            'activatePage',
            'deactivatePage',
            'onClientUpdate',
            'onStatisticsReport',
            'onTerminationHandler',
            'loadStatisticsReports',
            'monitoredClient',
            'monitoredClientReports'
        ],
        { clientKey: `source:${sourceId}` }
    );
    const activation = page.activatePage();
    await flush();
    requests[0].resolve(success([report(client('old'), 1)]));
    await activation;
    const value = () => page.monitoredClientReports.value[0]?.statistics[0].value;
    assert.equal(value(), 1);

    const oldRead = page.loadStatisticsReports(page.monitoredClient.value);
    page.onClientUpdate(success(client('new')));
    assert.equal(requests.length, 3);
    page.onTerminationHandler(success(client('old')));
    assert.equal(page.monitoredClient.value.persistentConnectionId, 'new');
    assert.equal(page.monitoredClient.value.isOnline, true, 'an old termination cannot close a reconnected source');
    page.onStatisticsReport(success(report(client('old'), 99)));
    page.onStatisticsReport(success({ batch: true, updates: [report(client('old'), 98)] }));
    assert.equal(value(), 1, 'old-connection statistics cannot overwrite retained data');
    requests[2].resolve(success([report(client('new'), 20)]));
    await flush();
    requests[1].resolve(success([report(client('old'), 97)]));
    await oldRead;
    assert.equal(value(), 20, 'a late old-connection read cannot overwrite the new snapshot');

    page.onStatisticsReport(success({ batch: true, updates: [report(client('old'), 96), report(client('new'), 21)] }));
    assert.equal(value(), 21, 'valid updates survive mixed old/new batches');
    const terminatedRead = page.loadStatisticsReports(page.monitoredClient.value);
    page.onTerminationHandler(success(client('new')));
    assert.equal(page.monitoredClient.value.isOnline, false);
    requests[3].resolve(success([report(client('new'), 95)]));
    await terminatedRead;
    assert.equal(value(), 21, 'termination invalidates reads even when the connection ID is unchanged');

    const deactivatedRead = page.loadStatisticsReports(page.monitoredClient.value);
    page.deactivatePage();
    requests[4].reject(new Error('obsolete IPC error'));
    await deactivatedRead;
    assert.equal(page.notifications.length, 0, 'inactive/obsolete reads do not report errors');

    // Legacy reports without persistent connection IDs still reject a provably
    // different transport, while maintaining compatibility with partial DTOs.
    const legacy = { ...client('new') };
    delete legacy.persistentConnectionId;
    page.monitoredClient.value = legacy;
    const reactivation = page.activatePage();
    await flush();
    requests[5].resolve(success([]));
    await reactivation;
    const currentLegacy = { ...page.monitoredClient.value };
    delete currentLegacy.persistentConnectionId;
    page.monitoredClient.value = currentLegacy;
    page.onTerminationHandler(success({ ...currentLegacy, remotePort: currentLegacy.remotePort + 1 }));
    assert.equal(page.monitoredClient.value.isOnline, true);
    page.onStatisticsReport(success(report({ ...currentLegacy, remotePort: currentLegacy.remotePort + 1 }, 94)));
    assert.equal(value(), 21);
    page.deactivatePage();
}

async function verifyRouteLensActivation() {
    const requests = [];
    const page = loadPage(
        'BgpRouteLens.vue',
        {
            getRouteLens: (query, state) => {
                const pending = deferred();
                requests.push({ query, state, ...pending });
                return pending.promise;
            }
        },
        ['routeQuery', 'routeState', 'lensResult', 'searchRoute', 'runQuery', 'scheduleRefresh', 'hasSearched']
    );
    const activate = () => page.hooks.activated[0]();
    const deactivate = () => page.hooks.deactivated[0]();
    const runTimers = () => {
        const pending = [...page.timers.values()];
        page.timers.clear();
        pending.forEach(timer => {
            assert.equal(timer.delay, 900);
            timer.callback();
        });
    };
    activate();
    assert.equal(requests.length, 0, 'opening an empty Lens does not invent a query');
    page.routeQuery.value = '203.0.113.1';
    page.searchRoute();
    requests[0].resolve(success({ generatedAt: 'snapshot-before' }));
    await flush();
    assert.equal(page.hasSearched.value, true);
    deactivate();
    assert.equal(page.listeners.size, 0);
    activate();
    activate();
    assert.equal(page.timers.size, 1, 'activation resumes the last search exactly once with the existing debounce');
    assert.equal(requests.length, 1);
    runTimers();
    requests[1].resolve(success({ generatedAt: 'snapshot-after-hidden-commit' }));
    await flush();
    assert.equal(page.lensResult.value.generatedAt, 'snapshot-after-hidden-commit');

    const obsolete = page.runQuery('203.0.113.1');
    deactivate();
    page.routeState.value = 'all';
    activate();
    runTimers();
    assert.equal(requests[3].state, 'all');
    requests[3].resolve(success({ generatedAt: 'newest' }));
    await flush();
    requests[2].resolve(success({ generatedAt: 'obsolete' }));
    await obsolete;
    assert.equal(page.lensResult.value.generatedAt, 'newest', 'inactive requests cannot replace the restored snapshot');
    page.scheduleRefresh();
    deactivate();
    assert.equal(page.timers.size, 0, 'deactivation cancels queued refreshes');

    page.route.query = { q: '198.51.100.1', state: 'stale' };
    activate();
    assert.equal(requests[4].query, '198.51.100.1');
    assert.equal(requests[4].state, 'stale');
    assert.equal(page.timers.size, 0, 'a new deep link does not schedule a redundant restored query');
    requests[4].resolve(success({ generatedAt: 'deep-link' }));
    await flush();
    assert.equal(page.lensResult.value.generatedAt, 'deep-link');
    deactivate();
    assert.equal(page.notifications.length, 0);
}

async function verifyTransportBoundStatistics() {
    const originalClient = client('old');
    const transportKey = `connection:${originalClient.localIp}|${originalClient.localPort}|${originalClient.remoteIp}|${originalClient.remotePort}`;
    const page = loadPage(
        'BgpLocRibStatisReport.vue',
        {
            getClient: async () => success(originalClient),
            getBgpInstanceStatisticsReports: async selectedClient => success([report(selectedClient, 7)])
        },
        [
            'activatePage',
            'deactivatePage',
            'onClientUpdate',
            'onStatisticsReport',
            'onTerminationHandler',
            'monitoredClient',
            'monitoredClientReports'
        ],
        { clientKey: transportKey }
    );
    await page.activatePage();
    assert.equal(
        page.monitoredClient.value.persistentSourceId,
        sourceId,
        'a transport-bound monitor accepts the real DTO after Initiation adds its stable source ID'
    );
    assert.equal(page.monitoredClientReports.value[0].statistics[0].value, 7);
    const reconnected = { ...originalClient, persistentConnectionId: 'new' };
    page.onClientUpdate(success(reconnected));
    await flush();
    page.onStatisticsReport(success(report(originalClient, 99)));
    page.onTerminationHandler(success(originalClient));
    assert.equal(page.monitoredClient.value.isOnline, true, 'same-transport old connection events remain rejected');
    assert.equal(page.monitoredClientReports.value[0].statistics[0].value, 7);
    page.onStatisticsReport(success(report(reconnected, 31)));
    assert.equal(page.monitoredClientReports.value[0].statistics[0].value, 31);
    page.onTerminationHandler(success(reconnected));
    assert.equal(page.monitoredClient.value.isOnline, false);
    page.deactivatePage();
}

async function main() {
    await verifyLocRibStatistics();
    await verifyTransportBoundStatistics();
    await verifyRouteLensActivation();
    console.log('BMP monitor UI connection/activation lifecycle tests passed');
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
