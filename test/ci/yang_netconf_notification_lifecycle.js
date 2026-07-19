'use strict';

const assert = require('node:assert/strict');
const NetconfApp = require('../../electron/app/netconfApp');
const NetconfWorkerService = require('../../electron/worker/yang/netconfWorker');
const { NETCONF_REQ_TYPES, YANG_EVT_TYPES } = require('../../electron/const/yangConst');

class FakeIpcMain {
    constructor() {
        this.handlers = new Map();
    }

    handle(channel, handler) {
        this.handlers.set(channel, handler);
    }
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

const profile = {
    id: 'notification-router',
    name: 'Notification router',
    host: '192.0.2.20',
    port: 830,
    username: 'tester',
    password: 'secret',
    authMethod: 'password',
    hostKeyPolicy: 'accept-new',
    rpcTimeout: 300000
};

async function main() {
    const app = new NetconfApp(new FakeIpcMain(), new MemoryStore(), {
        yangApp: { setActiveProfileId() {} }
    });
    app.saveStoredProfiles([profile]);
    const sent = [];
    const event = {
        sender: {
            isDestroyed: () => false,
            send: (channel, payload) => sent.push({ channel, payload })
        }
    };
    app.setWebContents(event);

    const subscription = {
        id: 'subscription-before-worker-crash',
        subscriptionId: 'subscription-before-worker-crash',
        profileId: profile.id,
        sessionId: '101',
        state: 'ACTIVE',
        createdAt: '2026-07-19T00:00:00.000Z'
    };
    app.relayWorkerEvent(YANG_EVT_TYPES.SESSION_EVENT, {
        profileId: profile.id,
        sessionId: '101',
        status: 'connected',
        state: 'connected',
        connected: true,
        subscriptionActive: true,
        activeSubscription: subscription
    });
    app.relayWorkerEvent(YANG_EVT_TYPES.SUBSCRIPTION_EVENT, subscription);
    sent.length = 0;

    const crashedWorker = { closed: false };
    app.workerClient = crashedWorker;
    app.handleWorkerExit(crashedWorker, 9);

    assert.equal(app.workerClient, null);
    assert.equal(app.activeProfileId, null);
    const snapshot = app.subscriptionSnapshot(profile.id);
    assert.equal(snapshot.activeCount, 0);
    assert.equal(snapshot.total, 1);
    assert.equal(snapshot.subscriptions[0].state, 'TERMINATED');
    assert.equal(snapshot.subscriptions[0].terminationReason, 'worker-exit');
    assert.equal(snapshot.subscriptions[0].error.code, 'NETCONF_WORKER_EXIT');
    assert.equal(app.sessionSnapshots.get(profile.id).status, 'disconnected');
    assert.equal(app.sessionSnapshots.get(profile.id).subscriptionActive, false);
    assert.deepEqual(
        sent.map(item => item.payload.type),
        [YANG_EVT_TYPES.SUBSCRIPTION_EVENT, YANG_EVT_TYPES.SESSION_EVENT]
    );

    const cachedSubscriptions = await app.handleGetSubscriptions(null, profile.id);
    assert.equal(cachedSubscriptions.status, 'success');
    assert.equal(cachedSubscriptions.data.subscriptions[0].state, 'TERMINATED');
    const cachedSession = await app.handleGetSessionState(null, profile.id);
    assert.equal(cachedSession.status, 'success');
    assert.equal(cachedSession.data.status, 'disconnected');
    assert.equal(cachedSession.data.subscriptionActive, false);

    const calls = [];
    app.activeProfileId = profile.id;
    app.workerClient = {
        async sendRequest(operation, data, options) {
            calls.push({ operation, data, options });
            return { data: { ok: true } };
        }
    };
    const operationResult = await app.handleExecuteOperation(event, {
        profileId: profile.id,
        operation: 'get'
    });
    assert.equal(operationResult.status, 'success');
    assert.equal(calls[0].operation, NETCONF_REQ_TYPES.EXECUTE_OPERATION);
    assert.equal(calls[0].options.timeoutMs, 305000);

    const rpcResult = await app.handleSendRpc(event, {
        profileId: profile.id,
        rpc: '<get/>',
        timeout: 180000
    });
    assert.equal(rpcResult.status, 'success');
    assert.equal(calls[1].operation, NETCONF_REQ_TYPES.SEND_RPC);
    assert.equal(calls[1].options.timeoutMs, 185000);

    const workerEntry = {
        profileId: profile.id,
        profile,
        client: {
            connected: true,
            sessionInfo: () => ({
                sessionId: '101',
                baseVersion: '1.1',
                capabilities: []
            })
        },
        status: 'connected',
        observed: {},
        connectedAt: '2026-07-19T00:00:00.000Z',
        disconnectedAt: null,
        reconnectAttempt: 0,
        lastError: null,
        activeSubscriptionId: null
    };
    const firstService = new NetconfWorkerService(null);
    const secondService = new NetconfWorkerService(null);
    const firstId = firstService.activateSubscription(workerEntry, {}, '<create-subscription/>', '1').id;
    workerEntry.activeSubscriptionId = null;
    const secondId = secondService.activateSubscription(workerEntry, {}, '<create-subscription/>', '2').id;
    assert.match(firstId, /^rfc5277-[0-9a-f-]{36}$/u);
    assert.match(secondId, /^rfc5277-[0-9a-f-]{36}$/u);
    assert.notEqual(firstId, secondId);

    console.log('NETCONF notification timeout, worker-exit and restart lifecycle tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
