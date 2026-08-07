const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

const EventDispatcher = require('../../electron/utils/eventDispatcher');
const BmpApp = require('../../electron/app/bmpApp');
const BmpConst = require('../../electron/const/bmpConst');
const SnmpApp = require('../../electron/app/snmpApp');
const SnmpConst = require('../../electron/const/snmpConst');
const SyslogApp = require('../../electron/app/syslogApp');
const SyslogConst = require('../../electron/const/syslogConst');
const {
    MonitorWindowManager,
    MONITOR_CONTEXT_EVENT,
    OPEN_MONITOR_CHANNEL,
    RENDERER_READY_CHANNEL,
    SUBSCRIBE_EVENT_SCOPE_CHANNEL,
    UNSUBSCRIBE_EVENT_SCOPE_CHANNEL,
    filterBmpEventForClient,
    filterNetconfEventForProfile,
    normalizeBmpClientKey,
    normalizeNetconfMonitorIdentifier
} = require('../../electron/window/monitorWindowManager');

let nextWebContentsId = 1;

class FakeWebContents extends EventEmitter {
    constructor() {
        super();
        this.id = nextWebContentsId++;
        this.destroyed = false;
        this.sent = [];
    }

    send(channel, payload) {
        this.sent.push({ channel, payload });
    }

    isDestroyed() {
        return this.destroyed;
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emit('destroyed');
    }
}

class FakeBrowserWindow extends EventEmitter {
    static instances = [];
    static nextLoadError = null;
    static nextLoadPromise = null;

    static fromWebContents(webContents) {
        return this.instances.find(window => !window.isDestroyed() && window.webContents === webContents) || null;
    }

    constructor(options) {
        super();
        this.options = options;
        this._webContents = new FakeWebContents();
        this.destroyed = false;
        this.throwOnDestroyedWebContentsAccess = false;
        this.minimized = false;
        this.loadedUrl = null;
        this.showCalls = 0;
        this.focusCalls = 0;
        this.restoreCalls = 0;
        FakeBrowserWindow.instances.push(this);
    }

    get webContents() {
        if (this.destroyed && this.throwOnDestroyedWebContentsAccess) {
            throw new Error('Object has been destroyed');
        }
        return this._webContents;
    }

    loadURL(url) {
        this.loadedUrl = url;
        if (FakeBrowserWindow.nextLoadPromise) {
            const promise = FakeBrowserWindow.nextLoadPromise;
            FakeBrowserWindow.nextLoadPromise = null;
            return promise;
        }
        if (FakeBrowserWindow.nextLoadError) {
            const error = FakeBrowserWindow.nextLoadError;
            FakeBrowserWindow.nextLoadError = null;
            return Promise.reject(error);
        }
        return Promise.resolve();
    }

    isDestroyed() {
        return this.destroyed;
    }

    isMinimized() {
        return this.minimized;
    }

    restore() {
        this.minimized = false;
        this.restoreCalls += 1;
    }

    show() {
        this.showCalls += 1;
    }

    focus() {
        this.focusCalls += 1;
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this._webContents.destroy();
        this.emit('closed');
    }

    close() {
        if (this.destroyed) return;
        this.emit('close');
        this.destroy();
    }
}

class FakeIpcMain extends EventEmitter {
    constructor() {
        super();
        this.handlers = new Map();
    }

    handle(channel, handler) {
        this.handlers.set(channel, handler);
    }
}

async function verifyPreloadBridge() {
    const originalLoad = Module._load;
    const exposed = new Map();
    const invocations = [];
    const electronStub = {
        contextBridge: {
            exposeInMainWorld(name, api) {
                exposed.set(name, api);
            }
        },
        ipcRenderer: {
            invoke(channel, ...args) {
                invocations.push({ channel, args });
                return Promise.resolve({ status: 'success' });
            },
            send() {},
            on() {},
            removeListener() {}
        }
    };

    Module._load = function loadWithElectronStub(request, parent, isMain) {
        if (request === 'electron') {
            return electronStub;
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    const preloadPath = path.join(__dirname, '..', '..', 'electron', 'preload.js');
    delete require.cache[require.resolve(preloadPath)];
    try {
        require(preloadPath);
        assert.equal(typeof exposed.get('windowApi')?.openMonitor, 'function');
        assert.equal(typeof exposed.get('windowApi')?.subscribeEventScope, 'function');
        assert.equal(typeof exposed.get('windowApi')?.unsubscribeEventScope, 'function');
        await exposed.get('windowApi').openMonitor('syslog-message-log');
        assert.deepEqual(invocations.at(-1), {
            channel: OPEN_MONITOR_CHANNEL,
            args: ['syslog-message-log']
        });
        const clientKey = `source:${'a'.repeat(64)}`;
        await exposed.get('windowApi').openMonitor('bmp-client', { clientKey });
        assert.deepEqual(invocations.at(-1), {
            channel: OPEN_MONITOR_CHANNEL,
            args: ['bmp-client', { clientKey }]
        });
        const netconfOptions = {
            profileId: 'profile-a',
            compileId: 'compile-a',
            nodeId: 'node-a',
            target: 'candidate'
        };
        await exposed.get('windowApi').openMonitor('netconf-edit-config', netconfOptions);
        assert.deepEqual(invocations.at(-1), {
            channel: OPEN_MONITOR_CHANNEL,
            args: ['netconf-edit-config', netconfOptions]
        });
        await exposed.get('windowApi').openMonitor('netconf-notifications');
        assert.deepEqual(invocations.at(-1), {
            channel: OPEN_MONITOR_CHANNEL,
            args: ['netconf-notifications']
        });
        await exposed.get('netconfApi').getNotificationHistory({});
        assert.deepEqual(invocations.at(-1), {
            channel: 'netconf:getNotificationHistory',
            args: [{}]
        });
        await exposed.get('netconfApi').requestNotificationAction({ operation: 'resync-subscription' });
        assert.deepEqual(invocations.at(-1), {
            channel: 'netconf:requestNotificationAction',
            args: [{ operation: 'resync-subscription' }]
        });
        await exposed.get('windowApi').subscribeEventScope('bmp-route-lens');
        assert.deepEqual(invocations.at(-1), {
            channel: SUBSCRIBE_EVENT_SCOPE_CHANNEL,
            args: ['bmp-route-lens']
        });
        await exposed.get('windowApi').unsubscribeEventScope('bmp-route-lens');
        assert.deepEqual(invocations.at(-1), {
            channel: UNSUBSCRIBE_EVENT_SCOPE_CHANNEL,
            args: ['bmp-route-lens']
        });
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve(preloadPath)];
    }
}

async function verifyScopedNetconfEditConfigWindows() {
    FakeBrowserWindow.instances = [];
    FakeBrowserWindow.nextLoadError = null;
    FakeBrowserWindow.nextLoadPromise = null;
    const sourceWindow = new FakeBrowserWindow({ role: 'main' });
    const ipcMain = new FakeIpcMain();
    const manager = new MonitorWindowManager({
        BrowserWindowClass: FakeBrowserWindow,
        rendererUrl: 'file:///tmp/netnexus/dist/index.html',
        preloadPath: '/tmp/netnexus/electron/preload.js'
    });
    manager.registerIpcHandlers(ipcMain);
    const openHandler = ipcMain.handlers.get(OPEN_MONITOR_CHANNEL);
    const profileA = 'profile:A/设备';
    const profileB = 'profile:B';
    const baseOptions = {
        profileId: profileA,
        compileId: 'compile:A/1',
        nodeId: 'node:/interfaces/interface[name="xe-0/0/0"]',
        target: 'candidate'
    };

    assert.equal(normalizeNetconfMonitorIdentifier('a'), 'a');
    assert.equal(normalizeNetconfMonitorIdentifier('设'.repeat(341)), '设'.repeat(341));
    for (const invalidIdentifier of [
        '',
        '   ',
        'profile\u0000id',
        'profile\u007fid',
        'a'.repeat(1025),
        '设'.repeat(342),
        123,
        null
    ]) {
        assert.equal(normalizeNetconfMonitorIdentifier(invalidIdentifier), null);
    }

    const invalidRequests = [
        undefined,
        {},
        { ...baseOptions, profileId: '' },
        { ...baseOptions, profileId: '设'.repeat(342) },
        { ...baseOptions, compileId: '' },
        { ...baseOptions, compileId: 'compile\ninvalid' },
        { ...baseOptions, nodeId: '' },
        { ...baseOptions, nodeId: 'n'.repeat(1025) },
        { ...baseOptions, target: 'startup' },
        { ...baseOptions, target: 'Candidate' },
        { ...baseOptions, url: '/untrusted' }
    ];
    for (const options of invalidRequests) {
        const result = await openHandler({ sender: sourceWindow.webContents }, 'netconf-edit-config', options);
        assert.equal(result.status, 'error');
        assert.equal(manager.getOpenCount(), 0);
    }

    const opened = await openHandler({ sender: sourceWindow.webContents }, 'netconf-edit-config', baseOptions);
    assert.equal(opened.status, 'success');
    assert.deepEqual(opened.data, {
        monitorId: 'netconf-edit-config',
        ...baseOptions,
        reused: false
    });
    const query = new URLSearchParams(baseOptions);
    const baseWindow = FakeBrowserWindow.instances[1];
    assert.equal(
        baseWindow.loadedUrl,
        `file:///tmp/netnexus/dist/index.html#/monitor/netconf-edit-config?${query.toString()}`
    );
    assert.deepEqual(baseWindow.options.width, 1440);
    assert.deepEqual(baseWindow.options.minWidth, 1024);

    const dispatcher = new EventDispatcher();
    const sessionA = { status: 'success', data: { profileId: profileA, status: 'connected' } };
    const sessionB = { status: 'success', data: { profileId: profileB, status: 'connected' } };
    assert.deepEqual(filterNetconfEventForProfile(sessionA, profileA), sessionA);
    assert.equal(filterNetconfEventForProfile(sessionA, profileB), undefined);
    assert.equal(filterNetconfEventForProfile({ status: 'success', data: null }, profileA), undefined);
    assert.equal(dispatcher.emitToSubscribers('netconf:sessionEvent', sessionA), 1);
    assert.equal(baseWindow.webContents.sent.at(-1).payload.data, sessionA);
    assert.equal(dispatcher.emitToSubscribers('netconf:sessionEvent', sessionB), 0);

    const messageCountBeforeSameContext = baseWindow.webContents.sent.length;
    const reused = await openHandler({ sender: sourceWindow.webContents }, 'netconf-edit-config', { ...baseOptions });
    assert.equal(reused.status, 'success');
    assert.equal(reused.data.reused, true);
    assert.equal(manager.getOpenCount(), 1);
    assert.equal(
        baseWindow.webContents.sent.length,
        messageCountBeforeSameContext,
        'reopening the same context only focuses the singleton window'
    );

    const variants = [
        { ...baseOptions, compileId: 'compile:B/2' },
        { ...baseOptions, nodeId: 'node:/interfaces/interface[name="xe-0/0/1"]' },
        { ...baseOptions, target: 'running' },
        { ...baseOptions, profileId: profileB }
    ];
    for (const options of variants) {
        const result = await openHandler({ sender: sourceWindow.webContents }, 'netconf-edit-config', options);
        assert.equal(result.status, 'success');
        assert.equal(result.data.reused, true);
    }
    assert.equal(manager.getOpenCount(), 1, 'all edit-config contexts share one native window');
    assert.equal(FakeBrowserWindow.instances.length, 2, 'switching context does not create another BrowserWindow');
    assert.equal(
        baseWindow.webContents.sent.filter(message => message.payload.type === MONITOR_CONTEXT_EVENT).length,
        0,
        'context updates wait until the monitor renderer has mounted'
    );
    assert.equal(dispatcher.emitToSubscribers('netconf:sessionEvent', sessionA), 0);
    assert.equal(dispatcher.emitToSubscribers('netconf:sessionEvent', sessionB), 1);
    assert.equal(baseWindow.webContents.sent.at(-1).payload.data, sessionB);

    ipcMain.emit(RENDERER_READY_CHANNEL, { sender: baseWindow.webContents });
    const queuedContextMessages = baseWindow.webContents.sent.filter(
        message => message.payload.type === MONITOR_CONTEXT_EVENT
    );
    assert.equal(queuedContextMessages.length, 1, 'only the latest pre-mount context is delivered');
    assert.deepEqual(queuedContextMessages[0].payload.data, {
        monitorId: 'netconf-edit-config',
        ...variants.at(-1)
    });

    const switchedBackOptions = { ...baseOptions, target: 'running' };
    const switchedBack = await openHandler(
        { sender: sourceWindow.webContents },
        'netconf-edit-config',
        switchedBackOptions
    );
    assert.equal(switchedBack.status, 'success');
    assert.equal(switchedBack.data.reused, true);
    const liveContextMessages = baseWindow.webContents.sent.filter(
        message => message.payload.type === MONITOR_CONTEXT_EVENT
    );
    assert.equal(liveContextMessages.length, 2);
    assert.deepEqual(liveContextMessages.at(-1).payload.data, {
        monitorId: 'netconf-edit-config',
        ...switchedBackOptions
    });
    assert.equal(dispatcher.emitToSubscribers('netconf:sessionEvent', sessionA), 1);
    assert.equal(dispatcher.emitToSubscribers('netconf:sessionEvent', sessionB), 0);

    const sessionCount = baseWindow.webContents.sent.length;
    assert.equal(dispatcher.emitToSubscribers('netconf:notification', sessionA), 0);
    assert.equal(
        baseWindow.webContents.sent.length,
        sessionCount,
        'edit-config windows subscribe only to Session state'
    );

    assert.equal(manager.closeByProtocolProfile('unknown', profileA), 0);
    assert.equal(manager.closeByProtocolProfile('netconf', ''), 0);
    assert.equal(manager.closeByProtocolProfile('netconf', profileB), 0, 'the old Profile no longer owns the editor');
    assert.equal(manager.closeByProtocolProfile(' NETCONF ', profileA), 1);
    assert.equal(baseWindow.isDestroyed(), true);
    assert.equal(manager.getOpenCount(), 0);

    let resolvePendingLoad;
    FakeBrowserWindow.nextLoadPromise = new Promise(resolve => {
        resolvePendingLoad = resolve;
    });
    const pendingOpen = manager.openMonitor('netconf-edit-config', baseOptions);
    const pendingWindow = FakeBrowserWindow.instances.at(-1);
    const pendingProfileB = await manager.openMonitor('netconf-edit-config', {
        ...baseOptions,
        profileId: profileB
    });
    assert.equal(pendingProfileB.data.reused, true);
    assert.equal(manager.getOpenCount(), 1);
    assert.equal(
        pendingWindow.webContents.sent.filter(message => message.payload.type === MONITOR_CONTEXT_EVENT).length,
        0
    );
    resolvePendingLoad();
    assert.equal((await pendingOpen).status, 'success');
    ipcMain.emit(RENDERER_READY_CHANNEL, { sender: pendingWindow.webContents });
    assert.deepEqual(
        pendingWindow.webContents.sent.find(message => message.payload.type === MONITOR_CONTEXT_EVENT)?.payload.data,
        {
            monitorId: 'netconf-edit-config',
            ...baseOptions,
            profileId: profileB
        },
        'a context selected during load is delivered after renderer-ready'
    );
    assert.equal(manager.closeByProtocolProfile('netconf', profileA), 0);
    assert.equal(manager.closeByProtocolProfile('netconf', profileB), 1);

    dispatcher.cleanup();
    sourceWindow.destroy();
}

async function verifyNetconfNotificationWindow() {
    FakeBrowserWindow.instances = [];
    const sourceWindow = new FakeBrowserWindow({ role: 'main' });
    const ipcMain = new FakeIpcMain();
    const manager = new MonitorWindowManager({
        BrowserWindowClass: FakeBrowserWindow,
        rendererUrl: 'file:///tmp/netnexus/dist/index.html',
        preloadPath: '/tmp/netnexus/electron/preload.js'
    });
    manager.registerIpcHandlers(ipcMain);
    const openHandler = ipcMain.handlers.get(OPEN_MONITOR_CHANNEL);

    assert.equal(
        (await openHandler({ sender: sourceWindow.webContents }, 'netconf-notifications', { profileId: 'x' })).status,
        'error',
        'the global notification window accepts no renderer-controlled filtering options'
    );
    const opened = await openHandler({ sender: sourceWindow.webContents }, 'netconf-notifications');
    assert.equal(opened.status, 'success');
    assert.deepEqual(opened.data, { monitorId: 'netconf-notifications', reused: false });
    const notificationWindow = FakeBrowserWindow.instances[1];
    assert.equal(notificationWindow.loadedUrl, 'file:///tmp/netnexus/dist/index.html#/monitor/netconf-notifications');

    const dispatcher = new EventDispatcher();
    for (const eventType of ['netconf:notification', 'netconf:subscriptionEvent', 'netconf:sessionEvent']) {
        assert.equal(dispatcher.emitToSubscribers(eventType, { eventType }), 1);
        assert.equal(notificationWindow.webContents.sent.at(-1).payload.type, eventType);
    }
    assert.equal(dispatcher.emitToSubscribers('yang:taskProgress', {}), 0);

    const reused = await openHandler({ sender: sourceWindow.webContents }, 'netconf-notifications');
    assert.equal(reused.data.reused, true);
    assert.equal(manager.getOpenCount(), 1);
    assert.equal(FakeBrowserWindow.instances.length, 2);
    assert.equal(manager.closeByProtocolProfile('netconf', 'profile-a'), 0);
    assert.equal(manager.closeByProtocol('netconf'), 1);
    assert.equal(notificationWindow.isDestroyed(), true);
    dispatcher.cleanup();
    sourceWindow.destroy();
}

async function verifyScopedBmpMonitorWindows() {
    FakeBrowserWindow.instances = [];
    const sourceWindow = new FakeBrowserWindow({ role: 'main' });
    const ipcMain = new FakeIpcMain();
    const manager = new MonitorWindowManager({
        BrowserWindowClass: FakeBrowserWindow,
        rendererUrl: 'file:///tmp/netnexus/dist/index.html',
        preloadPath: '/tmp/netnexus/electron/preload.js',
        maxWindows: 2
    });
    manager.registerIpcHandlers(ipcMain);
    const openHandler = ipcMain.handlers.get(OPEN_MONITOR_CHANNEL);
    const clientA = `source:${'a'.repeat(64)}`;
    const clientB = `source:${'b'.repeat(64)}`;

    assert.equal(normalizeBmpClientKey(clientA), clientA);
    assert.equal(normalizeBmpClientKey(`source:${'A'.repeat(64)}`), clientA);
    assert.equal(normalizeBmpClientKey('source:not-a-source-id'), null);
    assert.equal(normalizeBmpClientKey('connection:127.0.0.1|1790|192.0.2.1|50000') !== null, true);
    assert.equal((await openHandler({ sender: sourceWindow.webContents }, 'bmp-client')).status, 'error');
    assert.equal(
        (await openHandler({ sender: sourceWindow.webContents }, 'bmp-client', { clientKey: clientA, url: '/x' }))
            .status,
        'error'
    );

    const openedA = await openHandler({ sender: sourceWindow.webContents }, 'bmp-session', { clientKey: clientA });
    const openedB = await openHandler({ sender: sourceWindow.webContents }, 'bmp-client', { clientKey: clientB });
    const openedLocA = await openHandler({ sender: sourceWindow.webContents }, 'bmp-loc-rib', {
        clientKey: clientA
    });
    assert.equal(openedA.status, 'success');
    assert.equal(openedB.status, 'success');
    assert.equal(openedLocA.status, 'success');
    assert.equal(openedA.data.monitorId, 'bmp-client');
    assert.equal(openedB.data.monitorId, 'bmp-client');
    assert.equal(openedLocA.data.monitorId, 'bmp-client');
    assert.equal(openedLocA.data.reused, true, 'legacy Loc-RIB entry reuses the Client window');
    assert.equal(manager.getOpenCount(), 2, 'each Client gets one reusable unified BMP window');
    assert.equal(
        (
            await openHandler({ sender: sourceWindow.webContents }, 'bmp-client', {
                clientKey: `source:${'c'.repeat(64)}`
            })
        ).status,
        'error',
        'the monitor window hard limit bounds invalid-key resource usage'
    );

    const clientAWindow = FakeBrowserWindow.instances[1];
    const clientBWindow = FakeBrowserWindow.instances[2];
    assert.equal(
        clientAWindow.loadedUrl,
        `file:///tmp/netnexus/dist/index.html#/monitor/bmp-client?clientKey=source%3A${'a'.repeat(64)}&view=session`
    );
    assert.equal(
        clientBWindow.loadedUrl,
        `file:///tmp/netnexus/dist/index.html#/monitor/bmp-client?clientKey=source%3A${'b'.repeat(64)}`
    );

    const reusedA = await openHandler({ sender: sourceWindow.webContents }, 'bmp-client', { clientKey: clientA });
    assert.equal(reusedA.data.reused, true);
    assert.equal(reusedA.data.monitorId, 'bmp-client');
    assert.equal(manager.getOpenCount(), 2);

    const dispatcher = new EventDispatcher();
    dispatcher.setWebContents(sourceWindow.webContents);
    const makeUpdate = sourceId => ({
        client: { persistentSourceId: sourceId },
        changedCount: 1
    });
    const routeResponse = {
        status: 'success',
        data: {
            batch: true,
            updates: [makeUpdate('a'.repeat(64)), makeUpdate('b'.repeat(64))]
        }
    };
    const assertBatchDeliveredToClientWindows = eventType => {
        const primaryCount = sourceWindow.webContents.sent.length;
        const clientACount = clientAWindow.webContents.sent.length;
        const clientBCount = clientBWindow.webContents.sent.length;

        assert.equal(dispatcher.emitToSubscribers(eventType, routeResponse), 2);
        assert.equal(
            sourceWindow.webContents.sent.length,
            primaryCount,
            `${eventType} detail bypasses the primary window`
        );
        assert.equal(clientAWindow.webContents.sent.length, clientACount + 1);
        assert.equal(clientBWindow.webContents.sent.length, clientBCount + 1);
        assert.equal(clientAWindow.webContents.sent.at(-1).payload.type, eventType);
        assert.equal(clientBWindow.webContents.sent.at(-1).payload.type, eventType);
        assert.deepEqual(
            clientAWindow.webContents.sent
                .at(-1)
                .payload.data.data.updates.map(update => update.client.persistentSourceId),
            ['a'.repeat(64)]
        );
        assert.deepEqual(
            clientBWindow.webContents.sent
                .at(-1)
                .payload.data.data.updates.map(update => update.client.persistentSourceId),
            ['b'.repeat(64)]
        );
    };

    assertBatchDeliveredToClientWindows('bmp:sessionUpdate');
    assertBatchDeliveredToClientWindows('bmp:routeUpdate');
    assertBatchDeliveredToClientWindows('bmp:instanceUpdate');
    assertBatchDeliveredToClientWindows('bmp:instanceRouteUpdate');

    const primaryCountBeforeStatistics = sourceWindow.webContents.sent.length;
    const clientBCountBeforeAStatistics = clientBWindow.webContents.sent.length;
    assert.equal(
        dispatcher.emitToSubscribers('bmp:statisticsReport', {
            status: 'success',
            data: makeUpdate('a'.repeat(64))
        }),
        1
    );
    assert.equal(clientAWindow.webContents.sent.at(-1).payload.type, 'bmp:statisticsReport');
    assert.equal(clientAWindow.webContents.sent.at(-1).payload.data.data.client.persistentSourceId, 'a'.repeat(64));
    assert.equal(
        clientBWindow.webContents.sent.length,
        clientBCountBeforeAStatistics,
        'Client B does not receive Client A statistics'
    );
    assert.equal(sourceWindow.webContents.sent.length, primaryCountBeforeStatistics);

    const clientACountBeforeBStatistics = clientAWindow.webContents.sent.length;
    assert.equal(
        dispatcher.emitToSubscribers('bmp:statisticsReport', {
            status: 'success',
            data: makeUpdate('b'.repeat(64))
        }),
        1
    );
    assert.equal(clientBWindow.webContents.sent.at(-1).payload.type, 'bmp:statisticsReport');
    assert.equal(clientBWindow.webContents.sent.at(-1).payload.data.data.client.persistentSourceId, 'b'.repeat(64));
    assert.equal(
        clientAWindow.webContents.sent.length,
        clientACountBeforeBStatistics,
        'Client A does not receive Client B statistics'
    );

    const unmatched = filterBmpEventForClient({ status: 'success', data: makeUpdate('b'.repeat(64)) }, clientA);
    assert.equal(unmatched, undefined);
    const connectionKey = 'connection:127.0.0.1|1790|192.0.2.10|50000';
    assert.notEqual(
        filterBmpEventForClient(
            {
                status: 'success',
                data: {
                    client: {
                        persistentSourceId: 'c'.repeat(64),
                        localIp: '127.0.0.1',
                        localPort: 1790,
                        remoteIp: '192.0.2.10',
                        remotePort: 50000
                    }
                }
            },
            connectionKey
        ),
        undefined,
        'connection-scoped windows keep matching after the client gains a stable source ID'
    );
    assert.deepEqual(
        filterBmpEventForClient({ status: 'success', data: null }, clientA, 'bmp:termination'),
        { status: 'success', data: null },
        'global BMP termination reaches every client-scoped monitor'
    );

    manager.closeAll();
    dispatcher.cleanup();
    sourceWindow.destroy();
}

async function verifyMonitorWindowLifecycle() {
    FakeBrowserWindow.instances = [];
    FakeBrowserWindow.nextLoadError = null;
    FakeBrowserWindow.nextLoadPromise = null;
    const sourceWindow = new FakeBrowserWindow({ role: 'main' });
    const ipcMain = new FakeIpcMain();
    const manager = new MonitorWindowManager({
        BrowserWindowClass: FakeBrowserWindow,
        rendererUrl: 'file:///tmp/netnexus/dist/index.html',
        preloadPath: '/tmp/netnexus/electron/preload.js',
        icon: '/tmp/netnexus/electron/assets/icon.ico'
    });
    manager.registerIpcHandlers(ipcMain);
    manager.registerIpcHandlers(ipcMain);

    const openHandler = ipcMain.handlers.get(OPEN_MONITOR_CHANNEL);
    assert.equal(typeof openHandler, 'function');
    assert.equal(ipcMain.handlers.size, 3, 'window IPC handlers should only be registered once');

    const subscribeScope = ipcMain.handlers.get(SUBSCRIBE_EVENT_SCOPE_CHANNEL);
    const unsubscribeScope = ipcMain.handlers.get(UNSUBSCRIBE_EVENT_SCOPE_CHANNEL);
    assert.equal((await subscribeScope({ sender: sourceWindow.webContents }, 'unknown-scope')).status, 'error');
    assert.equal((await subscribeScope({ sender: new FakeWebContents() }, 'bmp-route-lens')).status, 'error');
    assert.equal((await subscribeScope({ sender: sourceWindow.webContents }, 'bmp-route-lens')).status, 'success');
    const scopeDispatcher = new EventDispatcher();
    assert.equal(scopeDispatcher.emitToSubscribers('bmp:routeLensInvalidated', { id: 1 }), 1);
    assert.equal(sourceWindow.webContents.sent.at(-1).payload.type, 'bmp:routeLensInvalidated');
    assert.equal((await unsubscribeScope({ sender: sourceWindow.webContents }, 'bmp-route-lens')).status, 'success');
    assert.equal(scopeDispatcher.emitToSubscribers('bmp:routeLensInvalidated', { id: 2 }), 0);
    sourceWindow.webContents.sent = [];

    const unknownSenderResult = await openHandler({ sender: new FakeWebContents() }, 'syslog-message-log');
    assert.equal(unknownSenderResult.status, 'error');
    assert.equal(manager.getOpenCount(), 0);

    for (const invalidMonitorId of ['unknown-monitor', 'toString', '__proto__']) {
        const unknownResult = await openHandler({ sender: sourceWindow.webContents }, invalidMonitorId);
        assert.equal(unknownResult.status, 'error');
        assert.equal(manager.getOpenCount(), 0);
    }

    const opened = await openHandler({ sender: sourceWindow.webContents }, 'syslog-message-log');
    assert.equal(opened.status, 'success');
    assert.equal(opened.data.reused, false);
    assert.equal(manager.getOpenCount(), 1);
    assert.equal(FakeBrowserWindow.instances.length, 2);

    const monitorWindow = FakeBrowserWindow.instances[1];
    const monitorWebContents = monitorWindow.webContents;
    assert.equal(monitorWindow.loadedUrl, 'file:///tmp/netnexus/dist/index.html#/monitor/syslog-message-log');
    assert.equal(monitorWindow.options.webPreferences.nodeIntegration, false);
    assert.equal(monitorWindow.options.webPreferences.contextIsolation, true);
    assert.equal(monitorWindow.options.webPreferences.preload, '/tmp/netnexus/electron/preload.js');
    assert.equal(monitorWindow.options.minWidth, 900);
    assert.equal(monitorWindow.options.minHeight, 620);

    monitorWindow.emit('ready-to-show');
    assert.equal(monitorWindow.showCalls, 1);
    assert.equal(monitorWindow.focusCalls, 1);

    const monitorOnlyDispatcher = new EventDispatcher();
    assert.equal(
        monitorOnlyDispatcher.canEmit('syslog:event'),
        true,
        'a matching monitor subscriber is a valid event target'
    );
    assert.equal(monitorOnlyDispatcher.canEmit(), false, 'unscoped checks retain the original primary-only behavior');
    assert.equal(monitorOnlyDispatcher.canEmit('bmp:routeUpdate'), false, 'other topics do not leak across modules');

    const dispatcher = new EventDispatcher();
    dispatcher.setWebContents(sourceWindow.webContents);
    dispatcher.emit('syslog:event', { id: 1 });
    dispatcher.emit('bmp:routeUpdate', { id: 2 });
    assert.equal(sourceWindow.webContents.sent.length, 2, 'primary target receives its existing event stream');
    assert.equal(monitorWebContents.sent.length, 1, 'monitor only receives its subscribed Syslog topic');
    assert.equal(monitorWebContents.sent[0].payload.type, 'syslog:event');

    const subscriberOnlyCount = dispatcher.emitToSubscribers('syslog:event', { id: 'detail-only' });
    assert.equal(subscriberOnlyCount, 1);
    assert.equal(sourceWindow.webContents.sent.length, 2, 'detailed monitor events bypass the primary window');
    assert.equal(monitorWebContents.sent.length, 2);
    assert.equal(monitorWebContents.sent.at(-1).payload.data.id, 'detail-only');

    const primaryOnlyCount = dispatcher.emitToPrimary('syslog:event', { id: 'stats-only' });
    assert.equal(primaryOnlyCount, 1);
    assert.equal(sourceWindow.webContents.sent.length, 3);
    assert.equal(sourceWindow.webContents.sent.at(-1).payload.data.id, 'stats-only');
    assert.equal(monitorWebContents.sent.length, 2, 'throttled stats bypass the monitor window');

    monitorWindow.minimized = true;
    const reused = await openHandler({ sender: sourceWindow.webContents }, 'syslog-message-log');
    assert.equal(reused.status, 'success');
    assert.equal(reused.data.reused, true);
    assert.equal(FakeBrowserWindow.instances.length, 2);
    assert.equal(monitorWindow.restoreCalls, 1);
    assert.equal(monitorWindow.showCalls, 2);
    assert.equal(monitorWindow.focusCalls, 2);

    monitorWindow.throwOnDestroyedWebContentsAccess = true;
    assert.doesNotThrow(
        () => monitorWindow.close(),
        'manual close must not read BrowserWindow.webContents after destroy'
    );
    assert.throws(() => monitorWindow.webContents, /Object has been destroyed/);
    assert.equal(manager.getOpenCount(), 0, 'closing a monitor only removes it from the registry');
    assert.equal(
        monitorOnlyDispatcher.canEmit('syslog:event'),
        false,
        'closing the last monitor removes its event target'
    );
    const primaryMessageCount = sourceWindow.webContents.sent.length;
    assert.equal(dispatcher.emitToSubscribers('syslog:event', { id: 'no-window' }), 0);
    assert.equal(
        sourceWindow.webContents.sent.length,
        primaryMessageCount,
        'without a monitor, detailed messages produce no renderer IPC'
    );
    dispatcher.emit('syslog:event', { id: 3 });
    assert.equal(monitorWebContents.sent.length, 2, 'closed monitor is unsubscribed from live events');

    const reopened = await openHandler({ sender: sourceWindow.webContents }, 'syslog-message-log');
    assert.equal(reopened.status, 'success');
    assert.equal(reopened.data.reused, false);
    assert.equal(FakeBrowserWindow.instances.length, 3);
    const reopenedWindow = FakeBrowserWindow.instances[2];
    manager.closeAll();
    assert.equal(reopenedWindow.isDestroyed(), true);
    assert.equal(manager.getOpenCount(), 0);

    FakeBrowserWindow.nextLoadError = new Error('mock load failure');
    const failedOpen = await openHandler({ sender: sourceWindow.webContents }, 'syslog-message-log');
    assert.equal(failedOpen.status, 'error');
    assert.match(failedOpen.msg, /mock load failure/);
    const failedWindow = FakeBrowserWindow.instances.at(-1);
    assert.equal(failedWindow.isDestroyed(), true, 'a failed load should destroy its hidden window');
    assert.equal(manager.getOpenCount(), 0, 'a failed load should be removed so it can be retried');

    const retriedOpen = await openHandler({ sender: sourceWindow.webContents }, 'syslog-message-log');
    assert.equal(retriedOpen.status, 'success');
    assert.equal(retriedOpen.data.reused, false);
    const retriedWindow = FakeBrowserWindow.instances.at(-1);
    retriedWindow.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(retriedWindow.isDestroyed(), true, 'a crashed monitor renderer is destroyed instead of reused');
    assert.equal(manager.getOpenCount(), 0, 'a crashed monitor is removed from the registry');

    let resolvePendingLoad;
    FakeBrowserWindow.nextLoadPromise = new Promise(resolve => {
        resolvePendingLoad = resolve;
    });
    const pendingOpen = openHandler({ sender: sourceWindow.webContents }, 'syslog-message-log');
    const pendingWindow = FakeBrowserWindow.instances.at(-1);
    dispatcher.emitToSubscribers('syslog:event', { id: 'during-load' });
    assert.equal(
        pendingWindow.webContents.sent.at(-1).payload.data.id,
        'during-load',
        'subscription is established before renderer navigation completes'
    );
    resolvePendingLoad();
    assert.equal((await pendingOpen).status, 'success');
    manager.closeAll();

    let rejectPendingLoad;
    FakeBrowserWindow.nextLoadPromise = new Promise((_resolve, reject) => {
        rejectPendingLoad = reject;
    });
    const closingPendingOpen = openHandler({ sender: sourceWindow.webContents }, 'syslog-message-log');
    const closingPendingWindow = FakeBrowserWindow.instances.at(-1);
    const closingPendingWebContents = closingPendingWindow.webContents;
    assert.equal(dispatcher.emitToSubscribers('syslog:event', { id: 'before-pending-close' }), 1);
    assert.equal(closingPendingWebContents.sent.at(-1).payload.data.id, 'before-pending-close');

    closingPendingWindow.close();
    const abortedError = new Error('ERR_ABORTED (-3) loading monitor');
    abortedError.code = 'ERR_ABORTED';
    rejectPendingLoad(abortedError);
    const closedPendingResult = await closingPendingOpen;
    assert.equal(closedPendingResult.status, 'success');
    assert.equal(closedPendingResult.data.closed, true);
    assert.equal(manager.getOpenCount(), 0);
    assert.equal(
        dispatcher.emitToSubscribers('syslog:event', { id: 'after-pending-close' }),
        0,
        'closing during navigation must remove the early event subscription'
    );
    assert.equal(closingPendingWebContents.sent.at(-1).payload.data.id, 'before-pending-close');

    dispatcher.cleanup();
    sourceWindow.destroy();
}

async function verifyProtocolWindowCleanup() {
    FakeBrowserWindow.instances = [];
    FakeBrowserWindow.nextLoadError = null;
    FakeBrowserWindow.nextLoadPromise = null;
    const manager = new MonitorWindowManager({
        BrowserWindowClass: FakeBrowserWindow,
        rendererUrl: 'file:///tmp/netnexus/dist/index.html',
        preloadPath: '/tmp/netnexus/electron/preload.js'
    });
    const clientA = `source:${'a'.repeat(64)}`;
    const clientB = `source:${'b'.repeat(64)}`;

    await manager.openMonitor('syslog-message-log');
    await manager.openMonitor('snmp-trap');
    await manager.openMonitor('bmp-session', { clientKey: clientA });
    await manager.openMonitor('bmp-client', { clientKey: clientB });
    const reusedLocA = await manager.openMonitor('bmp-loc-rib', { clientKey: clientA });
    const reusedLocB = await manager.openMonitor('bmp-loc-rib', { clientKey: clientB });
    assert.equal(reusedLocA.data.reused, true);
    assert.equal(reusedLocB.data.reused, true);
    assert.equal(manager.getOpenCount(), 4);

    const findWindows = route => FakeBrowserWindow.instances.filter(window => window.loadedUrl?.includes(route));
    const syslogWindows = findWindows('/monitor/syslog-message-log');
    const snmpWindows = findWindows('/monitor/snmp-trap');
    const bmpClientWindows = findWindows('/monitor/bmp-client');
    assert.deepEqual([syslogWindows.length, snmpWindows.length, bmpClientWindows.length], [1, 1, 2]);

    assert.equal(manager.closeByProtocol(' snmp '), 1);
    assert.equal(snmpWindows[0].isDestroyed(), true);
    assert.equal(syslogWindows[0].isDestroyed(), false);
    assert.equal(
        bmpClientWindows.every(window => !window.isDestroyed()),
        true
    );
    assert.equal(manager.getOpenCount(), 3);

    assert.equal(manager.closeByProtocol('SYSLOG'), 1);
    assert.equal(syslogWindows[0].isDestroyed(), true);
    assert.equal(
        bmpClientWindows.every(window => !window.isDestroyed()),
        true
    );
    assert.equal(manager.getOpenCount(), 2);

    assert.equal(manager.closeByProtocol('bmp'), 2, 'BMP stop closes every unified Client monitor window');
    assert.equal(
        bmpClientWindows.every(window => window.isDestroyed()),
        true
    );
    assert.equal(manager.getOpenCount(), 0);
    assert.equal(manager.closeByProtocol('unknown'), 0);
}

async function verifyProtocolStopClosesBeforeWorkerRequest() {
    const cases = [
        {
            name: 'Syslog',
            AppClass: SyslogApp,
            requestType: SyslogConst.SYSLOG_REQ_TYPES.STOP_SYSLOG,
            stop: app => app.handleStopSyslog()
        },
        {
            name: 'SNMP',
            AppClass: SnmpApp,
            requestType: SnmpConst.SNMP_REQ_TYPES.STOP_SNMP,
            stop: app => app.handleStopSnmp()
        },
        {
            name: 'BMP',
            AppClass: BmpApp,
            requestType: BmpConst.BMP_REQ_TYPES.STOP_BMP,
            stop: app => app.handleStopBmp()
        }
    ];

    for (const testCase of cases) {
        const calls = [];
        const app = new testCase.AppClass(
            new FakeIpcMain(),
            { get() {}, set() {} },
            {
                closeMonitorWindows() {
                    calls.push('close');
                }
            }
        );
        app.worker = {
            async sendRequest(requestType, data) {
                calls.push('request');
                assert.equal(requestType, testCase.requestType);
                assert.equal(data, null);
                assert.deepEqual(calls, ['close', 'request'], `${testCase.name} closes windows before worker stop`);
                return { status: 'success', msg: `${testCase.name} stopped` };
            },
            removeEventListener() {},
            async terminate() {
                calls.push('terminate');
            }
        };

        const result = await testCase.stop(app);
        assert.equal(result.status, 'success');
        assert.deepEqual(calls, ['close', 'request', 'terminate']);
    }
}

async function verifySyslogDeliveryPolicy() {
    const app = new SyslogApp(new FakeIpcMain(), { get() {}, set() {} }, { statsEmitIntervalMs: 5 });
    const subscriberEvents = [];
    const primaryEvents = [];
    const broadcastEvents = [];
    app.eventDispatcher = {
        emitToSubscribers(eventType, data) {
            subscriberEvents.push({ eventType, data });
        },
        emitToPrimary(eventType, data) {
            primaryEvents.push({ eventType, data });
        },
        emit(eventType, data) {
            broadcastEvents.push({ eventType, data });
        }
    };

    const messageEvent = (id, messageCount) => ({
        type: SyslogConst.SYSLOG_SUB_EVT_TYPES.MESSAGE_RECEIVED,
        data: { id, message: `message-${id}` },
        stats: { messageCount, totalReceived: messageCount }
    });

    app.handleSyslogWorkerEvent(messageEvent(1, 1));
    app.handleSyslogWorkerEvent(messageEvent(2, 2));
    assert.equal(subscriberEvents.length, 2, 'every detail is routed only to monitor subscribers');
    assert.equal(primaryEvents.length, 0, 'primary stats are coalesced instead of sent per message');

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(primaryEvents.length, 1, 'multiple message stats are merged into one primary update');
    assert.equal(primaryEvents[0].data.data.type, SyslogConst.SYSLOG_SUB_EVT_TYPES.STATS_UPDATED);
    assert.equal(primaryEvents[0].data.data.stats.messageCount, 2, 'the latest stats win within the interval');

    app.handleSyslogWorkerEvent(messageEvent(3, 3));
    app.handleSyslogWorkerEvent({
        type: SyslogConst.SYSLOG_SUB_EVT_TYPES.HISTORY_CLEARED,
        data: null,
        stats: { messageCount: 0, totalReceived: 3 }
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(primaryEvents.length, 1, 'a control event cancels a stale pending stats update');
    assert.equal(broadcastEvents.length, 1, 'low-frequency control events still reach both window roles');
    assert.equal(broadcastEvents[0].data.data.type, SyslogConst.SYSLOG_SUB_EVT_TYPES.HISTORY_CLEARED);

    app.cancelPendingStatsUpdate();
}

function verifySnmpDeliveryPolicy() {
    const app = new SnmpApp(new FakeIpcMain(), { get() {}, set() {} });
    const subscriberEvents = [];
    const primaryEvents = [];
    const broadcastEvents = [];
    app.eventDispatcher = {
        emitToSubscribers(eventType, data) {
            subscriberEvents.push({ eventType, data });
        },
        emitToPrimary(eventType, data) {
            primaryEvents.push({ eventType, data });
        },
        emit(eventType, data) {
            broadcastEvents.push({ eventType, data });
        }
    };

    app.handleSnmpWorkerEvent({
        type: SnmpConst.SNMP_SUB_EVT_TYPES.TRAP_BATCH_RECEIVED,
        data: { changedCount: 3, totalTraps: 12, historyCount: 12 }
    });
    assert.equal(subscriberEvents.length, 1, 'Trap refresh invalidation is monitor-only');
    assert.equal(primaryEvents.length, 1, 'the primary receives one lightweight counter snapshot');
    assert.equal(primaryEvents[0].data.data.type, SnmpConst.SNMP_SUB_EVT_TYPES.STATS_UPDATED);
    assert.equal(primaryEvents[0].data.data.data.totalTraps, 12);
    assert.equal(broadcastEvents.length, 0);

    app.handleSnmpWorkerEvent({
        type: SnmpConst.SNMP_SUB_EVT_TYPES.HISTORY_CLEARED,
        data: { totalTraps: 0, historyCount: 0 }
    });
    assert.equal(broadcastEvents.length, 1, 'history clear is synchronized to both window roles');
}

function verifyBmpDeliveryPolicy() {
    const app = new BmpApp(new FakeIpcMain(), { get() {}, set() {} });
    const subscriberEvents = [];
    app.eventDispatcher = {
        emitToSubscribers(eventType, data) {
            subscriberEvents.push({ eventType, data });
        },
        emit() {
            assert.fail('detailed BMP updates must not be broadcast to the primary renderer');
        },
        emitToPrimary() {
            assert.fail('detailed BMP updates must not target the primary renderer directly');
        }
    };

    const update = { batch: true, updates: [{ changedCount: 2 }] };
    app.emitDetailedMonitorUpdate('bmp:routeUpdate', update);
    assert.deepEqual(
        subscriberEvents.map(event => event.eventType),
        ['bmp:routeUpdate', 'bmp:routeAssuranceInvalidated', 'bmp:routeLensInvalidated']
    );
    assert.equal(subscriberEvents[0].data.data, update, 'the detailed payload is reserved for monitor subscribers');
    assert.deepEqual(subscriberEvents[1].data.data, { sourceEvent: 'bmp:routeUpdate' });
    assert.deepEqual(subscriberEvents[2].data.data, { sourceEvent: 'bmp:routeUpdate' });
}

async function main() {
    await verifyPreloadBridge();
    await verifyMonitorWindowLifecycle();
    await verifyScopedBmpMonitorWindows();
    await verifyScopedNetconfEditConfigWindows();
    await verifyNetconfNotificationWindow();
    await verifyProtocolWindowCleanup();
    await verifyProtocolStopClosesBeforeWorkerRequest();
    await verifySyslogDeliveryPolicy();
    verifyBmpDeliveryPolicy();
    verifySnmpDeliveryPolicy();
    console.log('Monitor window manager and event subscription tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
