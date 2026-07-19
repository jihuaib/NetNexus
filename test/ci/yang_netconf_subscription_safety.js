'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const NetconfWorkerService = require('../../electron/worker/yang/netconfWorker');
const { SUBSCRIBED_NOTIFICATIONS_NAMESPACE, YANG_PUSH_NAMESPACE } = require('../../electron/utils/netconf');
const { YANG_EVT_TYPES } = require('../../electron/const/yangConst');

const BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const NOTIFICATION_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:notification:1.0';
const YANG_LIBRARY_CAPABILITY =
    'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=safety-test';

class FakePort extends EventEmitter {
    constructor() {
        super();
        this.messages = [];
    }

    postMessage(message) {
        this.messages.push(message);
    }
}

class SafetyClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.connected = false;
        this.capabilities = options.capabilities || [
            'urn:ietf:params:netconf:base:1.1',
            'urn:ietf:params:netconf:capability:notification:1.0',
            `${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}?module=ietf-subscribed-notifications&revision=2019-09-09&features=encode-xml,xpath,subtree`,
            `${YANG_PUSH_NAMESPACE}?module=ietf-yang-push&revision=2019-09-09&features=on-change`
        ];
        this.inventory = options.inventory || null;
        this.sessionId = options.sessionId || 'subscription-safety-session';
        this.nextSubscriptionId = options.nextSubscriptionId || 100;
        this.requests = [];
        this.sequence = 0;
        this.failNext = null;
        this.afterReplyNotification = '';
        this.discoveryCalls = 0;
    }

    async connect() {
        this.connected = true;
        return this.sessionInfo();
    }

    sessionInfo() {
        return { sessionId: this.sessionId, baseVersion: '1.1', capabilities: [...this.capabilities] };
    }

    async discoverSchemas() {
        this.discoveryCalls += 1;
        return this.inventory || { source: 'hello', modules: [] };
    }

    async rpc(fragment) {
        const messageId = String(this.requests.length + 1);
        const requestXml = fragment.startsWith('<rpc')
            ? fragment
            : `<rpc xmlns="${BASE_NAMESPACE}" message-id="${messageId}">${fragment}</rpc>`;
        this.requests.push({ fragment, requestXml });
        if (this.failNext) {
            const error = this.failNext;
            this.failNext = null;
            throw error;
        }
        const establishing = fragment.includes('establish-subscription');
        const subscriptionId = establishing ? String(this.nextSubscriptionId++) : null;
        const reply = {
            type: 'rpc-reply',
            requestXml,
            xml: establishing
                ? `<rpc-reply xmlns="${BASE_NAMESPACE}" message-id="${messageId}"><id xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}">${subscriptionId}</id></rpc-reply>`
                : `<rpc-reply xmlns="${BASE_NAMESPACE}" message-id="${messageId}"><ok/></rpc-reply>`,
            root: establishing ? { id: subscriptionId } : { ok: '' },
            messageId,
            ok: !establishing,
            data: null,
            errors: [],
            transportSequence: ++this.sequence
        };
        if (this.afterReplyNotification) {
            const eventXml = this.afterReplyNotification;
            this.afterReplyNotification = '';
            emitNotification(this, eventXml);
        }
        return reply;
    }

    async closeSession() {
        this.disconnect();
        return { ok: true };
    }

    disconnect(error = null) {
        if (!this.connected) return;
        this.connected = false;
        this.emit('close', error);
    }
}

const profile = id => ({
    id,
    name: id,
    host: '192.0.2.80',
    port: 830,
    username: 'netconf',
    password: 'secret',
    authMethod: 'password',
    hostKeyPolicy: 'accept-new',
    autoReconnect: false
});

function emitNotification(client, eventXml) {
    const xml = `<notification xmlns="${NOTIFICATION_NAMESPACE}"><eventTime>2026-07-19T00:00:00Z</eventTime>${eventXml}</notification>`;
    client.emit('notification', {
        eventTime: '2026-07-19T00:00:00Z',
        xml,
        document: {},
        root: {},
        transportSequence: ++client.sequence
    });
}

const rpcTimeout = () => Object.assign(new Error('simulated NETCONF timeout'), { code: 'NETCONF_RPC_TIMEOUT' });

async function raceAndAssociationTests() {
    const port = new FakePort();
    const client = new SafetyClient();
    const service = new NetconfWorkerService(port, { clientFactory: () => client });
    const connection = profile('race-router');
    await service.connect(connection);
    const established = await service.executeOperation(connection.id, {
        operation: 'establish-subscription',
        stream: 'NETCONF'
    });
    const localId = established.subscription.id;
    const publisherId = established.subscription.publisherSubscriptionId;

    client.afterReplyNotification = `<subscription-suspended xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>${publisherId}</id><reason>insufficient-resources</reason></subscription-suspended>`;
    await service.executeOperation(connection.id, {
        operation: 'modify-subscription',
        subscriptionId: localId,
        streamFilterName: 'reduced-events'
    });
    assert.equal(service.subscriptions.get(localId).state, 'SUSPENDED');

    client.afterReplyNotification = `<subscription-terminated xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>${publisherId}</id><reason>no-such-subscription</reason></subscription-terminated>`;
    await service.executeOperation(connection.id, {
        operation: 'modify-subscription',
        subscriptionId: localId,
        streamFilterName: 'final-events'
    });
    assert.equal(service.subscriptions.get(localId).state, 'TERMINATED');

    const strictClient = new SafetyClient({ sessionId: 'strict-association-session', nextSubscriptionId: 200 });
    const strictPort = new FakePort();
    const strictService = new NetconfWorkerService(strictPort, { clientFactory: () => strictClient });
    const strictProfile = profile('strict-association-router');
    await strictService.connect(strictProfile);
    const strictSubscription = await strictService.executeOperation(strictProfile.id, {
        operation: 'establish-subscription',
        stream: 'NETCONF'
    });
    const strictLocalId = strictSubscription.subscription.id;

    emitNotification(
        strictClient,
        '<subscription-terminated xmlns="urn:example:vendor-events"><id>200</id><reason>vendor</reason></subscription-terminated>'
    );
    assert.equal(strictService.subscriptions.get(strictLocalId).state, 'ACTIVE');
    emitNotification(
        strictClient,
        `<subscription-terminated xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>999</id><reason>no-such-subscription</reason></subscription-terminated>`
    );
    assert.equal(strictService.subscriptions.get(strictLocalId).state, 'ACTIVE');
    const unknownIdEvent = [...strictPort.messages]
        .reverse()
        .find(message => message.eventName === YANG_EVT_TYPES.NOTIFICATION)?.data;
    assert.equal(
        unknownIdEvent.subscriptionId,
        null,
        'an explicit unknown publisher id must not use sole-live fallback'
    );
    emitNotification(
        strictClient,
        `<subscription-terminated xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><reason>no-such-subscription</reason></subscription-terminated>`
    );
    assert.equal(
        strictService.subscriptions.get(strictLocalId).state,
        'ACTIVE',
        'a malformed lifecycle event has no id'
    );
}

async function timeoutAndOwnershipTests() {
    const port = new FakePort();
    const client = new SafetyClient({ sessionId: 'timeout-management-session', nextSubscriptionId: 300 });
    const service = new NetconfWorkerService(port, { clientFactory: () => client });
    const connection = profile('timeout-management-router');
    await service.connect(connection);
    const established = await service.executeOperation(connection.id, {
        operation: 'establish-subscription',
        stream: 'NETCONF'
    });
    client.failNext = rpcTimeout();
    await assert.rejects(
        service.executeOperation(connection.id, {
            operation: 'modify-subscription',
            subscriptionId: established.subscription.id,
            streamFilterName: 'events-after-timeout'
        }),
        error => error.code === 'NETCONF_RPC_TIMEOUT'
    );
    const unknown = service.subscriptions.get(established.subscription.id);
    assert.equal(unknown.state, 'UNKNOWN');
    assert.equal(unknown.desynchronized, true);
    assert.equal(client.connected, true, 'management timeout keeps the Session available for explicit recovery');
    const requestsBeforeRejectedOwnership = client.requests.length;
    await assert.rejects(
        service.executeOperation(connection.id, {
            operation: 'delete-subscription',
            subscriptionId: established.subscription.id
        }),
        error => error.code === 'NETCONF_SUBSCRIPTION_STATE_UNKNOWN'
    );
    await assert.rejects(
        service.sendRpc(connection.id, {
            rpc: `<delete-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>300</id></delete-subscription>`
        }),
        error => error.code === 'NETCONF_SUBSCRIPTION_STATE_UNKNOWN'
    );
    assert.equal(client.requests.length, requestsBeforeRejectedOwnership);
    await assert.rejects(
        service.executeOperation(connection.id, { operation: 'create-subscription', stream: 'NETCONF' }),
        error => error.code === 'NETCONF_SUBSCRIPTION_ALREADY_ACTIVE'
    );
    const externalKill = await service.sendRpc(connection.id, {
        rpc: `<kill-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>999</id></kill-subscription>`
    });
    assert.equal(externalKill.subscription, null, 'operator kill may target an untracked subscription');
    await service.disconnect(connection.id);
    assert.equal(unknown.state, 'TERMINATED', 'closing the Session resolves an UNKNOWN dynamic subscription');

    const establishClient = new SafetyClient({ sessionId: 'timeout-establish-session' });
    const establishService = new NetconfWorkerService(new FakePort(), { clientFactory: () => establishClient });
    const establishProfile = profile('timeout-establish-router');
    await establishService.connect(establishProfile);
    establishClient.failNext = rpcTimeout();
    await assert.rejects(
        establishService.executeOperation(establishProfile.id, {
            operation: 'establish-subscription',
            stream: 'NETCONF'
        }),
        error => error.code === 'NETCONF_RPC_TIMEOUT'
    );
    assert.equal(establishClient.connected, false, 'ambiguous establish timeout must close the NETCONF Session');
    assert.equal(establishService.getSessionState(establishProfile.id).connected, false);

    const untrackedClient = new SafetyClient({ sessionId: 'untracked-owner-session' });
    const untrackedService = new NetconfWorkerService(new FakePort(), { clientFactory: () => untrackedClient });
    const untrackedProfile = profile('untracked-owner-router');
    await untrackedService.connect(untrackedProfile);
    await assert.rejects(
        untrackedService.executeOperation(untrackedProfile.id, {
            operation: 'resync-subscription',
            id: 777
        }),
        error => error.code === 'NETCONF_SUBSCRIPTION_NOT_TRACKED'
    );
    await assert.rejects(
        untrackedService.sendRpc(untrackedProfile.id, {
            rpc: `<modify-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>777</id><stream-filter-name>events</stream-filter-name></modify-subscription>`
        }),
        error => error.code === 'NETCONF_SUBSCRIPTION_NOT_TRACKED'
    );
    assert.equal(untrackedClient.requests.length, 0, 'owner-only untracked operations are rejected before transport');
}

async function capabilityAndRetentionTests() {
    const noEncodingClient = new SafetyClient({
        sessionId: 'no-encoding-session',
        capabilities: [
            'urn:ietf:params:netconf:base:1.1',
            `${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}?module=ietf-subscribed-notifications&features=xpath,subtree`
        ]
    });
    const noEncodingService = new NetconfWorkerService(new FakePort(), { clientFactory: () => noEncodingClient });
    const noEncodingProfile = profile('no-encoding-router');
    const noEncodingState = await noEncodingService.connect(noEncodingProfile);
    assert.equal(noEncodingState.supportsSubscribedNotifications, false);
    assert.equal(noEncodingState.capabilitySupport.subscribedNotificationsModule, true);
    assert.equal(noEncodingState.capabilitySupport.encodeXml, false);
    await assert.rejects(
        noEncodingService.executeOperation(noEncodingProfile.id, {
            operation: 'establish-subscription',
            stream: 'NETCONF'
        }),
        error => error.code === 'NETCONF_MODERN_SUBSCRIPTION_NOT_SUPPORTED'
    );

    const implementedInventory = {
        source: 'rfc8525',
        modules: [
            {
                name: 'ietf-subscribed-notifications',
                conformanceType: 'implement',
                features: ['encode-xml', 'xpath', 'subtree']
            },
            { name: 'ietf-yang-push', conformanceType: 'implement', features: ['on-change'] }
        ]
    };
    const discoveredClient = new SafetyClient({
        sessionId: 'automatic-discovery-session',
        capabilities: ['urn:ietf:params:netconf:base:1.1', YANG_LIBRARY_CAPABILITY],
        inventory: implementedInventory
    });
    const discoveredService = new NetconfWorkerService(new FakePort(), { clientFactory: () => discoveredClient });
    const discoveredProfile = profile('automatic-discovery-router');
    await discoveredService.connect(discoveredProfile);
    const pendingDiscovery = discoveredService.sessions.get(discoveredProfile.id).schemaDiscoveryPromise;
    if (pendingDiscovery) await pendingDiscovery;
    const discoveredState = discoveredService.getSessionState(discoveredProfile.id);
    assert.equal(discoveredClient.discoveryCalls, 1);
    assert.equal(discoveredState.supportsSubscribedNotifications, true);
    assert.equal(discoveredState.supportsYangPush, true);

    const importOnlyClient = new SafetyClient({
        sessionId: 'import-only-session',
        capabilities: ['urn:ietf:params:netconf:base:1.1', YANG_LIBRARY_CAPABILITY],
        inventory: {
            source: 'rfc8525',
            modules: [
                {
                    name: 'ietf-subscribed-notifications',
                    conformanceType: 'import',
                    features: ['encode-xml']
                },
                { name: 'ietf-yang-push', conformanceType: 'implement', features: ['on-change'] }
            ]
        }
    });
    const importOnlyService = new NetconfWorkerService(new FakePort(), { clientFactory: () => importOnlyClient });
    const importOnlyProfile = profile('import-only-router');
    await importOnlyService.connect(importOnlyProfile);
    const importDiscovery = importOnlyService.sessions.get(importOnlyProfile.id).schemaDiscoveryPromise;
    if (importDiscovery) await importDiscovery;
    assert.equal(importOnlyService.getSessionState(importOnlyProfile.id).supportsSubscribedNotifications, false);
    assert.equal(importOnlyService.getSessionState(importOnlyProfile.id).supportsYangPush, false);

    for (let index = 0; index < 300; index += 1) {
        const id = `terminal-history-${index}`;
        discoveredService.subscriptions.set(id, {
            id,
            subscriptionId: id,
            profileId: discoveredProfile.id,
            state: 'TERMINATED',
            subscriptionType: 'rfc8639',
            createdAt: new Date(index * 1000).toISOString(),
            terminatedAt: new Date(index * 1000 + 1).toISOString(),
            requestXml: '<rpc/>'
        });
    }
    discoveredService.pruneSubscriptionHistory(discoveredProfile.id);
    assert(discoveredService.getSubscriptions(discoveredProfile.id).total <= 256);
    const purged = await discoveredService.purgeProfile(discoveredProfile.id);
    assert.equal(purged.profileId, discoveredProfile.id);
    assert.equal(discoveredService.sessions.has(discoveredProfile.id), false);
    assert.equal(discoveredService.getSubscriptions(discoveredProfile.id).total, 0);
}

async function main() {
    await raceAndAssociationTests();
    await timeoutAndOwnershipTests();
    await capabilityAndRetentionTests();
    console.log('NETCONF subscription race, timeout, ownership, capability, and retention safety tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
