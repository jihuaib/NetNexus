const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const BmpApp = require('../../electron/app/bmpApp');
const BmpConst = require('../../electron/const/bmpConst');
const { MonitorWindowManager } = require('../../electron/window/monitorWindowManager');

let nextId = 1;
class FakeWindow extends EventEmitter {
    static instances = [];
    static fromWebContents(sender) {
        return this.instances.find(window => window.webContents === sender && !window.destroyed) || null;
    }
    constructor() {
        super();
        this.destroyed = false;
        this.webContents = new EventEmitter();
        Object.assign(this.webContents, {
            id: nextId++,
            mainFrame: { url: 'http://127.0.0.1:3000/' },
            isDestroyed: () => this.destroyed,
            send() {}
        });
        FakeWindow.instances.push(this);
    }
    async loadURL(url) {
        this.webContents.mainFrame.url = url;
    }
    isDestroyed() {
        return this.destroyed;
    }
    isMinimized() {
        return false;
    }
    show() {}
    focus() {}
    destroy() {
        this.destroyed = true;
        this.emit('closed');
    }
}

const sourceId = 'a'.repeat(64);
const otherSourceId = 'b'.repeat(64);
const client = {
    persistentSourceId: sourceId,
    persistentConnectionId: 'connection-a',
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '192.0.2.10',
    remotePort: 49152
};
const eventFor = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });

async function main() {
    const manager = new MonitorWindowManager({
        BrowserWindowClass: FakeWindow,
        rendererUrl: 'http://127.0.0.1:3000/',
        processResourceSampler: { getSnapshot: () => ({}) }
    });
    const primary = new FakeWindow();
    const handlers = new Map();
    const calls = [];
    const app = Object.create(BmpApp.prototype);
    Object.assign(app, {
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        primaryWebContents: primary.webContents,
        browserWindow: FakeWindow,
        appIsPackaged: false,
        resolveBmpMonitorContext: event => manager.getBmpMonitorContext(event),
        worker: {
            async sendRequest(operation, payload) {
                calls.push({ operation, payload });
                return { data: { deleted: 1 }, msg: 'stub' };
            }
        },
        async deletePersistenceDatabase() {
            calls.push({ operation: 'delete-database-stub' });
            return { deleted: true };
        },
        async queryClient(selector) {
            assert.deepEqual(selector, {
                localIp: client.localIp,
                localPort: client.localPort,
                remoteIp: client.remoteIp,
                remotePort: client.remotePort
            });
            return { status: 'success', data: { ...client } };
        }
    });
    app.registerHandlers();
    const invoke = (channel, event, ...args) => Promise.resolve().then(() => handlers.get(channel)(event, ...args));
    const peer = (event, selectedClient = client) =>
        invoke('bmp:purgeStaleBgpRoutes', event, selectedClient, {}, 1, '1');
    const instance = (event, selectedClient = client) =>
        invoke('bmp:purgeStaleBgpInstanceRoutes', event, selectedClient, {});
    const denyAll = async event => {
        const count = calls.length;
        await assert.rejects(invoke('bmp:deletePersistenceDatabase', event), /拒绝/);
        await assert.rejects(invoke('bmp:deleteClientData', event, client), /拒绝/);
        await assert.rejects(peer(event), /拒绝/);
        await assert.rejects(instance(event), /拒绝/);
        assert.equal(calls.length, count, 'denied IPC cannot reach any destructive operation');
    };
    try {
        await invoke('bmp:deletePersistenceDatabase', eventFor(primary));
        await invoke('bmp:deleteClientData', eventFor(primary), { sourceId, remoteIp: client.remoteIp });
        await peer(eventFor(primary));
        await instance(eventFor(primary));
        assert.equal(calls.length, 4, 'the trusted primary keeps all existing capabilities');

        // Exercise real registry creation and aliases, not a resolver that trusts
        // a renderer-supplied window type or clientKey.
        await manager.openMonitor('bmp-session', { clientKey: `source:${sourceId}` });
        const sourceMonitor = [...manager.monitorWindows.values()][0].window;
        assert.equal(manager.getBmpMonitorContext(eventFor(sourceMonitor)).monitorId, 'bmp-client');
        await peer(eventFor(sourceMonitor));
        await instance(eventFor(sourceMonitor), { ...client, persistentSourceId: sourceId.toUpperCase() });
        await assert.rejects(invoke('bmp:deletePersistenceDatabase', eventFor(sourceMonitor)), /拒绝/);
        await assert.rejects(invoke('bmp:deleteClientData', eventFor(sourceMonitor), client), /拒绝/);
        await assert.rejects(peer(eventFor(sourceMonitor), { ...client, persistentSourceId: otherSourceId }), /非当前/);

        await manager.openMonitor('syslog-message-log');
        const syslog = [...manager.monitorWindows.values()].find(
            entry => entry.context.monitorId === 'syslog-message-log'
        ).window;
        await denyAll(eventFor(syslog));
        await denyAll(eventFor(new FakeWindow()));
        await denyAll(null);
        await denyAll({ sender: primary.webContents, senderFrame: { url: primary.webContents.mainFrame.url } });
        await denyAll({
            sender: sourceMonitor.webContents,
            senderFrame: { url: sourceMonitor.webContents.mainFrame.url }
        });
        primary.webContents.mainFrame.url = 'https://untrusted.example/';
        await denyAll(eventFor(primary));
        primary.webContents.mainFrame.url = 'http://127.0.0.1:3000/';
        sourceMonitor.webContents.mainFrame.url = 'https://untrusted.example/';
        await denyAll(eventFor(sourceMonitor));
        sourceMonitor.webContents.mainFrame.url = 'http://127.0.0.1:3000/#/monitor/bmp-client';

        const transportKey = `connection:${client.localIp}|${client.localPort}|${client.remoteIp}|${client.remotePort}`;
        await manager.openMonitor('bmp-loc-rib', { clientKey: transportKey });
        const transportMonitor = [...manager.monitorWindows.values()].find(
            entry => entry.context.clientKey === transportKey
        ).window;
        await peer(eventFor(transportMonitor));
        const authorizedPayload = calls[calls.length - 1].payload.client;
        assert.equal(authorizedPayload.persistentSourceId, sourceId);
        assert.equal(authorizedPayload.persistentConnectionId, 'connection-a');
        await instance(eventFor(transportMonitor), {
            localIp: client.localIp,
            localPort: client.localPort,
            remoteIp: client.remoteIp,
            remotePort: client.remotePort
        });
        for (const forged of [
            { ...client, persistentSourceId: otherSourceId },
            { ...client, sourceId: otherSourceId },
            { ...client, persistentConnectionId: 'connection-b' },
            { ...client, persistenceConnectionId: 'connection-b' },
            { ...client, remotePort: 49153 }
        ])
            await assert.rejects(peer(eventFor(transportMonitor), forged), /拒绝/);

        const queryClient = app.queryClient;
        app.queryClient = async selector => {
            const response = await queryClient(selector);
            transportMonitor.webContents.mainFrame.url = 'https://untrusted.example/';
            return response;
        };
        await assert.rejects(peer(eventFor(transportMonitor)), /非应用页面/);
        app.queryClient = queryClient;

        app.appIsPackaged = true;
        app.packagedRendererPath = path.resolve(__dirname, '../../dist/index.html');
        primary.webContents.mainFrame.url = `${pathToFileURL(app.packagedRendererPath)}#/settings`;
        await invoke('bmp:deletePersistenceDatabase', eventFor(primary));
        primary.webContents.mainFrame.url = pathToFileURL(
            path.join(path.dirname(app.packagedRendererPath), 'other.html')
        ).href;
        await denyAll(eventFor(primary));
        app.appIsPackaged = false;
        sourceMonitor.destroy();
        await denyAll(eventFor(sourceMonitor));
        assert.equal(calls.filter(call => call.operation === BmpConst.BMP_REQ_TYPES.DELETE_CLIENT_DATA).length, 1);
    } finally {
        manager.closeAll();
        primary.destroy();
    }
    console.log('BMP destructive IPC authorization tests passed (no real deletion)');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
