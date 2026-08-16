'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const NetconfApp = require('../../electron/app/netconfApp');
const YangApp = require('../../electron/app/yangApp');
const EventDispatcher = require('../../electron/utils/eventDispatcher');
const { NETCONF_REQ_TYPES, YANG_EVT_TYPES } = require('../../electron/const/yangConst');

class FakeIpcMain {
    constructor() {
        this.handlers = new Map();
    }

    handle(channel, handler) {
        this.handlers.set(channel, handler);
    }

    on() {}
}

class MemoryStore {
    constructor() {
        this.values = new Map();
    }

    get(key, fallback) {
        return this.values.has(key) ? this.values.get(key) : fallback;
    }

    set(key, value) {
        this.values.set(key, value);
    }

    delete(key) {
        this.values.delete(key);
    }
}

class FakeWebContents extends EventEmitter {
    constructor(id) {
        super();
        this.id = id;
        this.destroyed = false;
        this.messages = [];
    }

    isDestroyed() {
        return this.destroyed;
    }

    send(channel, payload) {
        if (this.destroyed) throw new Error('webContents destroyed');
        this.messages.push({ channel, payload });
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emit('destroyed');
    }
}

function createNetconfApp(options = {}) {
    return new NetconfApp(new FakeIpcMain(), new MemoryStore(), {
        yangApp: {
            setActiveProfileId() {},
            async deleteProfileWorkspace() {
                return true;
            }
        },
        ...options
    });
}

function verifySystemAppInjection() {
    const originalLoad = Module._load;
    let capturedYangOptions = null;
    let capturedNetconfOptions = null;

    class DummyDependency {}
    class StoreStub extends MemoryStore {}
    class YangStub {
        constructor(_ipc, _store, options) {
            capturedYangOptions = options;
        }
    }
    class NetconfStub {
        constructor(_ipc, _store, options) {
            capturedNetconfOptions = options;
        }
    }
    const stubbedDependencies = new Set([
        './bgpApp',
        './toolsApp',
        './bmpApp',
        './rpkiApp',
        './ftpApp',
        './snmpApp',
        './dhcpApp',
        './ntpApp',
        './radiusApp',
        './tftpApp',
        './syslogApp',
        './updater',
        './nativeApp',
        './externalApiServer',
        './cli',
        './wiresharkPluginInstaller'
    ]);

    Module._load = function loadWithSystemAppStubs(request, parent, isMain) {
        if (request === 'electron') {
            return {
                app: {
                    isPackaged: true,
                    getPath: () => path.join(os.tmpdir(), 'netnexus-netconf-multi-window-test')
                },
                dialog: {},
                BrowserWindow: {}
            };
        }
        if (request === 'electron-store') return StoreStub;
        if (request === './yangApp') return YangStub;
        if (request === './netconfApp') return NetconfStub;
        if (request === './bmpApiRoutes') return () => [];
        if (stubbedDependencies.has(request)) return DummyDependency;
        return originalLoad.call(this, request, parent, isMain);
    };

    let SystemApp;
    try {
        const modulePath = require.resolve('../../electron/app/systemApp');
        delete require.cache[modulePath];
        SystemApp = require(modulePath);
    } finally {
        Module._load = originalLoad;
    }

    const primary = new FakeWebContents(1);
    const closeCalls = [];
    const monitorWindowManager = {
        closeByProtocolProfile(protocol, profileId) {
            closeCalls.push(['profile', protocol, profileId]);
        },
        closeByProtocol(protocol) {
            closeCalls.push(['protocol', protocol]);
        }
    };
    const app = new SystemApp(new FakeIpcMain(), { webContents: primary }, null, { monitorWindowManager });

    assert.equal(capturedYangOptions.primaryWebContents, primary);
    assert.equal(capturedNetconfOptions.primaryWebContents, primary);
    assert.equal(capturedNetconfOptions.yangApp, app.yangApp);
    capturedNetconfOptions.closeProfileMonitorWindows('router-a');
    capturedNetconfOptions.closeMonitorWindows();
    assert.deepEqual(closeCalls, [
        ['profile', 'netconf', 'router-a'],
        ['protocol', 'netconf']
    ]);
}

function verifyFixedPrimaryTargets() {
    const primary = new FakeWebContents(10);
    const detached = new FakeWebContents(11);
    const netconfApp = createNetconfApp({ primaryWebContents: primary });

    netconfApp.setWebContents({ sender: detached });
    assert.equal(netconfApp.eventDispatcher.webContents, primary, 'detached NETCONF calls must not replace primary');
    netconfApp.relayWorkerEvent(YANG_EVT_TYPES.SESSION_EVENT, {
        profileId: 'fixed-primary-router',
        status: 'connected',
        connected: true
    });
    assert.equal(primary.messages.length, 1);
    assert.equal(primary.messages[0].payload.type, YANG_EVT_TYPES.SESSION_EVENT);
    assert.equal(detached.messages.length, 0);

    const yangApp = new YangApp(new FakeIpcMain(), new MemoryStore(), {
        rootDir: path.join(os.tmpdir(), 'netnexus-yang-fixed-primary-test'),
        primaryWebContents: primary
    });
    yangApp.setWebContents({ sender: detached });
    assert.equal(yangApp.eventDispatcher.webContents, primary, 'detached YANG calls must not replace primary');
    yangApp.emitTaskProgress({ taskId: 'fixed-primary-task', metadata: {} });
    assert.equal(primary.messages.at(-1).payload.type, YANG_EVT_TYPES.TASK_PROGRESS);
    assert.equal(detached.messages.length, 0);

    const legacyNetconf = createNetconfApp();
    legacyNetconf.setWebContents({ sender: detached });
    assert.equal(legacyNetconf.eventDispatcher.webContents, detached, 'no-options NETCONF behavior must stay dynamic');
    const legacyYang = new YangApp(new FakeIpcMain(), new MemoryStore(), {
        rootDir: path.join(os.tmpdir(), 'netnexus-yang-legacy-primary-test')
    });
    legacyYang.setWebContents({ sender: detached });
    assert.equal(legacyYang.eventDispatcher.webContents, detached, 'no-primary YANG behavior must stay dynamic');
}

function verifySubscriberOnlySessionDelivery() {
    const subscriber = new FakeWebContents(20);
    const app = createNetconfApp();
    assert.equal(EventDispatcher.subscribe(subscriber, YANG_EVT_TYPES.SESSION_EVENT), true);
    try {
        app.relayWorkerEvent(YANG_EVT_TYPES.SESSION_EVENT, {
            profileId: 'subscriber-only-router',
            status: 'connected',
            connected: true
        });
        assert.equal(subscriber.messages.length, 1, 'session canEmit must include explicit subscriber event type');
        assert.equal(subscriber.messages[0].payload.type, YANG_EVT_TYPES.SESSION_EVENT);
    } finally {
        EventDispatcher.unsubscribe(subscriber);
    }
}

async function verifyDestroyedSenderCancelsOnlyLocalRpc() {
    const primary = new FakeWebContents(30);
    const detached = new FakeWebContents(31);
    const app = createNetconfApp({ primaryWebContents: primary });
    app.activeProfileId = 'rpc-router';
    const workerOperations = [];
    app.workerClient = {
        sendRequest(operation, _data, options) {
            workerOperations.push(operation);
            return new Promise((_resolve, reject) => {
                options.signal.addEventListener(
                    'abort',
                    () => {
                        const error = new Error('local renderer wait cancelled');
                        error.code = 'WORKER_CANCELLED';
                        reject(error);
                    },
                    { once: true }
                );
            });
        }
    };

    const pending = app.handleExecuteOperation(
        { sender: detached },
        { profileId: 'rpc-router', operation: 'get', operationId: 'detached-rpc-1' }
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.activeRpcOperations.size, 1);
    assert.equal(detached.listenerCount('destroyed'), 1);

    detached.destroy();
    assert.equal(app.activeRpcOperations.size, 0, 'destroyed sender must immediately release operation registry');
    assert.equal(detached.listenerCount('destroyed'), 0, 'destroyed listener must be cleaned up');
    const response = await pending;
    assert.equal(response.status, 'error');
    assert.equal(response.data.code, 'WORKER_CANCELLED');
    assert.deepEqual(workerOperations, [NETCONF_REQ_TYPES.EXECUTE_OPERATION]);
    assert.equal(app.activeProfileId, 'rpc-router', 'renderer destruction must not disconnect the NETCONF session');
    assert.equal(app.eventDispatcher.webContents, primary);
}

async function verifyMonitorWindowLifecycleCallbacks() {
    const profileCloseCalls = [];
    let allCloseCalls = 0;
    const app = createNetconfApp({
        closeProfileMonitorWindows: profileId => profileCloseCalls.push(profileId),
        closeMonitorWindows: () => {
            allCloseCalls += 1;
        }
    });
    const workerOperations = [];
    app.workerClient = {
        async sendRequest(operation, data) {
            workerOperations.push([operation, data?.profileId || null]);
            if (operation === NETCONF_REQ_TYPES.CONNECT) {
                return { data: { profileId: data.id, status: 'connected' } };
            }
            if (operation === NETCONF_REQ_TYPES.DISCONNECT) {
                return { data: { profileId: data.profileId, status: 'disconnected' } };
            }
            if (operation === NETCONF_REQ_TYPES.PURGE_PROFILE) {
                return { data: { profileId: data.profileId } };
            }
            if (operation === NETCONF_REQ_TYPES.DISCONNECT_ALL) return { data: [] };
            throw new Error(`unexpected worker operation: ${operation}`);
        },
        async terminate() {}
    };
    app.resolveRuntimeProfile = profileOrId => ({
        id: String(profileOrId),
        connectTimeout: 1000,
        rpcTimeout: 1000
    });
    app.activeProfileId = 'old-router';
    const event = { sender: new FakeWebContents(40) };

    const connected = await app.handleConnect(event, 'new-router');
    assert.equal(connected.status, 'success');
    assert.deepEqual(profileCloseCalls, ['old-router'], 'successful profile switch must close the old profile window');

    const disconnected = await app.handleDisconnect(event, 'new-router');
    assert.equal(disconnected.status, 'success');
    assert.deepEqual(profileCloseCalls, ['old-router', 'new-router']);

    const deleted = await app.handleDeleteProfile(event, 'deleted-router');
    assert.equal(deleted.status, 'success');
    assert.deepEqual(profileCloseCalls, ['old-router', 'new-router', 'deleted-router']);

    await app.closeAll();
    assert.equal(allCloseCalls, 1, 'closeAll must close every NETCONF detached window');
    assert.equal(app.workerClient, null, 'explicit disconnect must already terminate the shared YANG process');
    assert.equal(
        workerOperations.some(([operation]) => operation === NETCONF_REQ_TYPES.DISCONNECT_ALL),
        false,
        'closeAll must not recreate or address a YANG process after explicit disconnect'
    );
}

async function main() {
    verifySystemAppInjection();
    verifyFixedPrimaryTargets();
    verifySubscriberOnlySessionDelivery();
    await verifyDestroyedSenderCancelsOnlyLocalRpc();
    await verifyMonitorWindowLifecycleCallbacks();
    console.log('YANG/NETCONF multi-window lifecycle CI checks passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
