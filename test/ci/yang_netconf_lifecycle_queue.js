'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const NetconfApp = require('../../electron/app/netconfApp');
const { NETCONF_REQ_TYPES, YANG_EVT_TYPES } = require('../../electron/const/yangConst');
const { YANG_PROCESS_REQ_TYPES } = require('../../electron/worker/yang/yangProcessProtocol');

class FakeIpcMain {
    handle() {}
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
}

class FakeClient extends EventEmitter {
    constructor(name, sendRequest) {
        super();
        this.name = name;
        this.sendRequest = sendRequest;
    }
}

const event = {
    sender: {
        isDestroyed: () => false,
        send() {}
    }
};

const immediate = () => new Promise(resolve => setImmediate(resolve));

function createApp() {
    const activeIds = [];
    const detachedClients = [];
    const persistedDeletions = [];
    const app = new NetconfApp(new FakeIpcMain(), new MemoryStore(), {
        credentialStore: {
            sanitizeProfile: profile => ({ ...profile }),
            protectProfile: profile => ({ ...profile }),
            hydrateProfile: (profile, secrets) => ({ ...profile, ...secrets })
        },
        yangApp: {
            setActiveProfileId(profileId) {
                activeIds.push(profileId);
            },
            detachProcessClient(client) {
                detachedClients.push(client);
            },
            async deleteProfileWorkspace() {
                return true;
            },
            persistProfileWorkspaceDeletion(profileId, options) {
                persistedDeletions.push({ profileId, options });
            }
        }
    });
    app.resolveRuntimeProfile = profileOrId => ({
        id: String(profileOrId),
        connectTimeout: 1_000,
        rpcTimeout: 1_000
    });
    return { app, activeIds, detachedClients, persistedDeletions };
}

function installClientFactory(app, clients, terminated) {
    app.ensureWorker = () => {
        if (app.workerClient) return app.workerClient;
        const client = clients.shift();
        assert(client, 'test client factory exhausted');
        app.workerClient = client;
        app.workerReadyPromise = Promise.resolve();
        return client;
    };
    app.terminateYangProcess = async client => {
        if (!client) return;
        terminated.push(client);
        if (app.workerClient === client) {
            app.workerClient = null;
            app.workerReadyPromise = null;
            app.activeProfileId = null;
        }
    };
}

async function testProductionEventListenerRejectsStaleClient() {
    const { app } = createApp();
    const oldClient = app.ensureWorker(event);
    await app.workerReadyPromise;

    const terminated = [];
    const currentClient = new FakeClient('current', async () => ({ data: {} }));
    app.workerClient = currentClient;
    app.workerReadyPromise = Promise.resolve();
    app.activeProfileId = 'router-b';
    app.terminateYangProcess = async client => {
        terminated.push(client);
        if (app.workerClient === client) app.detachYangProcessClient(client);
    };

    oldClient.emit('event', YANG_EVT_TYPES.SESSION_EVENT, {
        profileId: 'router-b',
        status: 'disconnected',
        connected: false
    });
    await immediate();

    assert.strictEqual(app.workerClient, currentClient, 'the production event binding must identify its source client');
    assert.equal(app.activeProfileId, 'router-b');
    assert.deepEqual(terminated, []);
    await oldClient.terminate();
    app.eventDispatcher.cleanup();
}

async function testSupersededConnectOwnsItsClient() {
    const { app } = createApp();
    const terminated = [];
    let signalFirstStarted;
    const firstStarted = new Promise(resolve => {
        signalFirstStarted = resolve;
    });
    const firstClient = new FakeClient('first', async (operation, _data, options) => {
        assert.equal(operation, NETCONF_REQ_TYPES.CONNECT);
        signalFirstStarted();
        return new Promise((_resolve, reject) => {
            const rejectCancelled = () => {
                const error = new Error('first connect cancelled');
                error.code = 'WORKER_CANCELLED';
                reject(error);
            };
            if (options.signal.aborted) rejectCancelled();
            else options.signal.addEventListener('abort', rejectCancelled, { once: true });
        });
    });
    const secondClient = new FakeClient('second', async (operation, data) => {
        assert.equal(operation, NETCONF_REQ_TYPES.CONNECT);
        return { data: { profileId: data.id, status: 'connected' } };
    });
    installClientFactory(app, [firstClient, secondClient], terminated);

    const first = app.handleConnect(event, 'router-a');
    await firstStarted;
    const second = app.handleConnect(event, 'router-b');
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    assert.equal(firstResponse.status, 'error');
    assert.equal(secondResponse.status, 'success');
    assert.strictEqual(app.workerClient, secondClient);
    assert.equal(app.activeProfileId, 'router-b');
    assert(terminated.length >= 1);
    assert(
        terminated.every(client => client === firstClient),
        'a failed old connect must never terminate the new client'
    );

    app.relayWorkerEvent(
        YANG_EVT_TYPES.SESSION_EVENT,
        { profileId: 'router-a', status: 'disconnected', connected: false },
        firstClient
    );
    await immediate();
    assert.strictEqual(app.workerClient, secondClient, 'a stale client event must not terminate the current process');
    assert.equal(app.activeProfileId, 'router-b', 'a stale client event must not clear the current profile');
    app.eventDispatcher.cleanup();
}

async function testActiveProfileDeleteSerializesReconnect() {
    const { app, detachedClients, persistedDeletions } = createApp();
    const terminated = [];
    let signalPurgeStarted;
    let releasePurge;
    const purgeStarted = new Promise(resolve => {
        signalPurgeStarted = resolve;
    });
    const purgeBlocked = new Promise(resolve => {
        releasePurge = resolve;
    });
    const oldClient = new FakeClient('old', async (operation, data) => {
        assert.equal(operation, YANG_PROCESS_REQ_TYPES.DELETE_PROFILE_WORKSPACE);
        assert.equal(data.profileId, 'router-a');
        signalPurgeStarted();
        await purgeBlocked;
        return { data: { profileId: data.profileId } };
    });
    let newConnectCalls = 0;
    const newClient = new FakeClient('new', async (operation, data) => {
        assert.equal(operation, NETCONF_REQ_TYPES.CONNECT);
        newConnectCalls += 1;
        return { data: { profileId: data.id, status: 'connected' } };
    });
    app.saveStoredProfiles([
        { id: 'router-a', name: 'Router A' },
        { id: 'router-b', name: 'Router B' },
        { id: 'router-c', name: 'Router C' }
    ]);
    app.workerClient = oldClient;
    app.workerReadyPromise = Promise.resolve();
    app.activeProfileId = 'router-a';
    installClientFactory(app, [newClient], terminated);

    const deletion = app.handleDeleteProfile(event, 'router-a');
    await purgeStarted;
    assert.equal(app.workerClient, null, 'active-profile deletion must detach the old client before PURGE waits');
    assert.equal(app.activeProfileId, null, 'active-profile deletion must clear the active profile before PURGE waits');
    assert.deepEqual(detachedClients, [oldClient]);
    await assert.rejects(
        app.requireWorker(event),
        error => error?.code === 'YANG_PROCESS_NOT_RUNNING',
        'non-lifecycle requests must not enter the old process while PURGE is pending'
    );
    const queuedDeletion = app.handleDeleteProfile(event, 'router-c');
    const reconnect = app.handleConnect(event, 'router-b');
    await immediate();
    assert.equal(newConnectCalls, 0, 'connect must remain queued while active-profile deletion owns the old client');
    assert.deepEqual(terminated, [], 'a queued connect must not cancel an atomic profile deletion');

    releasePurge();
    const [deleteResponse, queuedDeleteResponse, connectResponse] = await Promise.all([
        deletion,
        queuedDeletion,
        reconnect
    ]);
    assert.equal(deleteResponse.status, 'success');
    assert.equal(queuedDeleteResponse.status, 'success', 'a queued profile deletion must remain non-supersedable');
    assert.equal(connectResponse.status, 'success');
    assert.deepEqual(persistedDeletions, [{ profileId: 'router-a', options: { pending: false } }]);
    assert.deepEqual(terminated, [oldClient]);
    assert.strictEqual(app.workerClient, newClient);
    assert.equal(app.activeProfileId, 'router-b');
    assert.equal(app.findStoredProfile('router-a'), null);
    assert.equal(app.findStoredProfile('router-c'), null);

    app.relayWorkerEvent(
        YANG_EVT_TYPES.SESSION_EVENT,
        { profileId: 'router-a', status: 'disconnected', connected: false },
        oldClient
    );
    await immediate();
    assert.strictEqual(app.workerClient, newClient);
    assert.equal(app.activeProfileId, 'router-b');
    app.eventDispatcher.cleanup();
}

async function testExplicitDisconnectDetachesBeforeRequestSettles() {
    const { app, detachedClients } = createApp();
    const terminated = [];
    const operations = [];
    let signalDisconnectStarted;
    let releaseDisconnect;
    const disconnectStarted = new Promise(resolve => {
        signalDisconnectStarted = resolve;
    });
    const disconnectBlocked = new Promise(resolve => {
        releaseDisconnect = resolve;
    });
    const client = new FakeClient('disconnecting', async (operation, data) => {
        operations.push(operation);
        assert.equal(operation, NETCONF_REQ_TYPES.DISCONNECT);
        assert.equal(data.profileId, 'router-a');
        signalDisconnectStarted();
        await disconnectBlocked;
        return { data: { profileId: data.profileId, status: 'disconnected', connected: false } };
    });
    app.workerClient = client;
    app.workerReadyPromise = Promise.resolve();
    app.activeProfileId = 'router-a';
    installClientFactory(app, [], terminated);

    const disconnect = app.handleDisconnect(event, 'router-a');
    await disconnectStarted;

    assert.equal(app.workerClient, null, 'disconnect must make the old process unavailable before awaiting NETCONF');
    assert.equal(app.workerReadyPromise, null);
    assert.equal(app.activeProfileId, null);
    assert.deepEqual(detachedClients, [client]);
    await assert.rejects(
        app.requireWorker(event),
        error => error?.code === 'YANG_PROCESS_NOT_RUNNING',
        'non-lifecycle requests must not reuse a client whose disconnect is still pending'
    );
    assert.deepEqual(operations, [NETCONF_REQ_TYPES.DISCONNECT]);

    releaseDisconnect();
    const response = await disconnect;
    assert.equal(response.status, 'success');
    assert.deepEqual(terminated, [client]);
    assert.equal(app.workerClient, null);

    const stoppedState = await app.handleGetSessionState(event, 'router-a');
    assert.equal(stoppedState.status, 'success');
    assert.equal(stoppedState.data.connected, false);
    assert.equal(stoppedState.data.processRunning, false);
    assert.deepEqual(operations, [NETCONF_REQ_TYPES.DISCONNECT], 'stopped reads must not address or spawn a process');
    app.eventDispatcher.cleanup();
}

async function main() {
    await testProductionEventListenerRejectsStaleClient();
    await testSupersededConnectOwnsItsClient();
    await testActiveProfileDeleteSerializesReconnect();
    await testExplicitDisconnectDetachesBeforeRequestSettles();
    console.log('NETCONF lifecycle queue client-generation tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
