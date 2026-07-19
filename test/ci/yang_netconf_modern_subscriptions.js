'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const NetconfWorkerService = require('../../electron/worker/yang/netconfWorker');
const {
    buildEstablishSubscription,
    buildModifySubscription,
    buildDeleteSubscription,
    buildKillSubscription,
    buildResyncSubscription,
    SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
    YANG_PUSH_NAMESPACE
} = require('../../electron/utils/netconf');
const { YANG_EVT_TYPES } = require('../../electron/const/yangConst');

const BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const NOTIFICATION_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:notification:1.0';

class FakePort extends EventEmitter {
    constructor() {
        super();
        this.messages = [];
    }

    postMessage(message) {
        this.messages.push(message);
    }
}

class FakeClient extends EventEmitter {
    constructor() {
        super();
        this.connected = false;
        this.nextSubscriptionId = 41;
        this.requests = [];
        this.capabilities = [
            'urn:ietf:params:netconf:base:1.1',
            'urn:ietf:params:netconf:capability:notification:1.0',
            'urn:ietf:params:netconf:capability:interleave:1.0',
            `${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}?module=ietf-subscribed-notifications&revision=2019-09-09&features=encode-xml,xpath,subtree,replay`,
            `${YANG_PUSH_NAMESPACE}?module=ietf-yang-push&revision=2019-09-09&features=on-change`
        ];
    }

    async connect() {
        this.connected = true;
        return this.sessionInfo();
    }

    sessionInfo() {
        return { sessionId: 'modern-session-1', baseVersion: '1.1', capabilities: [...this.capabilities] };
    }

    async rpc(fragment, options = {}) {
        const messageId = String(this.requests.length + 1);
        const requestXml = fragment.startsWith('<rpc')
            ? fragment
            : `<rpc xmlns="${BASE_NAMESPACE}" message-id="${messageId}">${fragment}</rpc>`;
        this.requests.push({ fragment, requestXml, options });
        if (fragment.includes('establish-subscription')) {
            const id = String(this.nextSubscriptionId++);
            return {
                type: 'rpc-reply',
                requestXml,
                xml: `<rpc-reply xmlns="${BASE_NAMESPACE}" message-id="${messageId}"><id xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}">${id}</id></rpc-reply>`,
                root: { id },
                messageId,
                ok: false,
                data: null,
                errors: []
            };
        }
        return {
            type: 'rpc-reply',
            requestXml,
            xml: `<rpc-reply xmlns="${BASE_NAMESPACE}" message-id="${messageId}"><ok/></rpc-reply>`,
            root: { ok: '' },
            messageId,
            ok: true,
            data: null,
            errors: []
        };
    }

    async closeSession() {
        this.connected = false;
        this.emit('close', null);
        return { ok: true };
    }

    disconnect() {
        if (!this.connected) return;
        this.connected = false;
        this.emit('close', null);
    }
}

function notificationXml(eventXml) {
    return `<notification xmlns="${NOTIFICATION_NAMESPACE}"><eventTime>2026-07-19T00:00:00Z</eventTime>${eventXml}</notification>`;
}

function emitNotification(client, eventXml) {
    const xml = notificationXml(eventXml);
    client.emit('notification', {
        eventTime: '2026-07-19T00:00:00Z',
        xml,
        document: {},
        root: {}
    });
}

function lastEvent(port, eventName) {
    return [...port.messages].reverse().find(message => message.eventName === eventName)?.data || null;
}

async function main() {
    const streamRpc = buildEstablishSubscription({
        stream: 'NETCONF',
        streamFilter: { type: 'xpath', select: '/ex:event', namespaces: { ex: 'urn:example:event' } },
        replayStartTime: '2026-07-18T00:00:00Z',
        stopTime: '2026-07-20T00:00:00Z',
        dscp: 10,
        encoding: 'encode-xml'
    });
    assert.match(streamRpc, new RegExp(`<establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"`));
    assert.match(streamRpc, /<stream-xpath-filter xmlns:ex="urn:example:event">\/ex:event<\/stream-xpath-filter>/u);
    assert.match(streamRpc, /<stream>NETCONF<\/stream>/u);
    assert.match(streamRpc, /<replay-start-time>2026-07-18T00:00:00Z<\/replay-start-time>/u);

    const pushRpc = buildEstablishSubscription({
        targetType: 'datastore',
        datastore: 'operational',
        datastoreFilter: { type: 'subtree', content: '<interfaces xmlns="urn:example:interfaces"/>' },
        updateTrigger: 'periodic',
        period: 500
    });
    assert.match(pushRpc, new RegExp(`xmlns:yp="${YANG_PUSH_NAMESPACE}"`));
    assert.match(pushRpc, /<yp:datastore>ds:operational<\/yp:datastore>/u);
    assert.match(pushRpc, /<yp:periodic><yp:period>500<\/yp:period><\/yp:periodic>/u);
    assert.throws(() => buildModifySubscription({ id: 1, stopTime: '2026-07-20T00:00:00Z' }), /streamFilter/u);
    assert.throws(
        () => buildModifySubscription({ id: 1, stream: 'NETCONF', streamFilterName: 'events' }),
        /stream cannot be modified/u
    );
    assert.throws(
        () =>
            buildModifySubscription({
                id: 1,
                targetType: 'datastore',
                datastore: 'operational',
                updateTrigger: 'on-change',
                syncOnStart: true
            }),
        /syncOnStart cannot be modified/u
    );
    assert.match(buildDeleteSubscription(22), /<delete-subscription[^>]*><id>22<\/id>/u);
    assert.match(buildKillSubscription(23), /<kill-subscription[^>]*><id>23<\/id>/u);
    assert.match(buildResyncSubscription(24), new RegExp(`<resync-subscription xmlns="${YANG_PUSH_NAMESPACE}"`));

    const port = new FakePort();
    const client = new FakeClient();
    const service = new NetconfWorkerService(port, { clientFactory: () => client });
    const profile = {
        id: 'modern-router',
        name: 'Modern router',
        host: '192.0.2.40',
        port: 830,
        username: 'netconf',
        password: 'secret',
        authMethod: 'password',
        hostKeyPolicy: 'accept-new'
    };
    const connected = await service.connect(profile);
    assert.equal(connected.supportsSubscribedNotifications, true);
    assert.equal(connected.supportsYangPush, true);
    assert.deepEqual(connected.capabilitySupport.subscribedNotificationFeatures, [
        'encode-xml',
        'replay',
        'subtree',
        'xpath'
    ]);
    assert.deepEqual(connected.capabilitySupport.yangPushFeatures, ['on-change']);

    const first = await service.executeOperation(profile.id, {
        operation: 'establish-subscription',
        stream: 'NETCONF',
        streamFilter: { type: 'xpath', select: '/ex:alpha', namespaces: { ex: 'urn:example:event' } }
    });
    const second = await service.executeOperation(profile.id, {
        operation: 'establish-subscription',
        stream: 'NETCONF'
    });
    assert.equal(first.subscription.publisherSubscriptionId, '41');
    assert.equal(first.subscription.subscriptionType, 'rfc8639');
    assert.equal(second.subscription.publisherSubscriptionId, '42');
    assert.equal(service.getSubscriptions(profile.id).liveCount, 2);
    assert.equal(service.getSessionState(profile.id).activeSubscriptionCount, 2);

    emitNotification(client, '<event xmlns="urn:example:event"><value>ambiguous</value></event>');
    let event = lastEvent(port, YANG_EVT_TYPES.NOTIFICATION);
    assert.equal(event.subscriptionId, null);
    assert.deepEqual(new Set(event.candidateSubscriptionIds), new Set([first.subscription.id, second.subscription.id]));

    emitNotification(
        client,
        `<push-update xmlns="${YANG_PUSH_NAMESPACE}"><id>42</id><datastore-contents/></push-update>`
    );
    event = lastEvent(port, YANG_EVT_TYPES.NOTIFICATION);
    assert.equal(event.subscriptionId, second.subscription.id);
    assert.equal(event.publisherSubscriptionId, '42');

    const modified = await service.executeOperation(profile.id, {
        operation: 'modify-subscription',
        subscriptionId: first.subscription.id,
        streamFilter: { type: 'xpath', select: '/ex:beta', namespaces: { ex: 'urn:example:event' } }
    });
    assert.equal(modified.subscription.publisherSubscriptionId, '41');
    assert.match(client.requests.at(-1).fragment, /<id>41<\/id>/u);
    assert.doesNotMatch(client.requests.at(-1).fragment, /<stream>/u);

    emitNotification(
        client,
        `<subscription-suspended xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>41</id><reason>insufficient-resources</reason></subscription-suspended>`
    );
    assert.equal(service.subscriptions.get(first.subscription.id).state, 'SUSPENDED');
    emitNotification(
        client,
        `<subscription-resumed xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>41</id></subscription-resumed>`
    );
    assert.equal(service.subscriptions.get(first.subscription.id).state, 'ACTIVE');

    const push = await service.executeOperation(profile.id, {
        operation: 'establish-subscription',
        targetType: 'datastore',
        datastore: 'operational',
        datastoreFilter: { type: 'xpath', select: '/if:interfaces', namespaces: { if: 'urn:example:interfaces' } },
        updateTrigger: 'on-change',
        dampeningPeriod: 100,
        syncOnStart: true,
        excludedChanges: ['move']
    });
    assert.equal(push.subscription.publisherSubscriptionId, '43');
    assert.equal(push.subscription.subscriptionType, 'yang-push');
    const partialPushModify = await service.executeOperation(profile.id, {
        operation: 'modify-subscription',
        subscriptionId: push.subscription.id,
        stopTime: '2026-07-20T00:00:00Z'
    });
    assert.equal(partialPushModify.subscription.updateTrigger, 'on-change');
    assert.doesNotMatch(client.requests.at(-1).fragment, /<yp:(?:periodic|on-change)>/u);
    const pushModified = await service.executeOperation(profile.id, {
        operation: 'modify-subscription',
        subscriptionId: push.subscription.id,
        updateTrigger: 'periodic',
        period: 250
    });
    assert.equal(pushModified.subscription.updateTrigger, 'periodic');
    assert.equal(pushModified.subscription.period, 250);
    assert.equal(pushModified.subscription.syncOnStart, true);
    assert.deepEqual(pushModified.subscription.excludedChanges, ['move']);
    assert.match(client.requests.at(-1).fragment, /<yp:datastore>ds:operational<\/yp:datastore>/u);
    assert.doesNotMatch(client.requests.at(-1).fragment, /datastore-(?:xpath|subtree)-filter|selection-filter-ref/u);
    assert.equal(pushModified.subscription.filter.type, 'xpath');
    assert.doesNotMatch(client.requests.at(-1).fragment, /sync-on-start|excluded-change/u);
    const requestCountBeforeRejectedResync = client.requests.length;
    await assert.rejects(
        service.executeOperation(profile.id, {
            operation: 'resync-subscription',
            subscriptionId: push.subscription.id
        }),
        error => error.code === 'NETCONF_RESYNC_NOT_ALLOWED'
    );
    assert.equal(client.requests.length, requestCountBeforeRejectedResync);
    await service.executeOperation(profile.id, {
        operation: 'modify-subscription',
        subscriptionId: push.subscription.id,
        updateTrigger: 'on-change'
    });
    const resynced = await service.executeOperation(profile.id, {
        operation: 'resync-subscription',
        subscriptionId: push.subscription.id
    });
    assert.ok(resynced.subscription.lastResyncAt);
    assert.match(client.requests.at(-1).fragment, /<id>43<\/id>/u);

    const deleted = await service.executeOperation(profile.id, {
        operation: 'delete-subscription',
        subscriptionId: first.subscription.id
    });
    assert.equal(deleted.subscription.state, 'TERMINATED');
    assert.equal(deleted.subscription.terminationReason, 'delete-subscription');
    const killed = await service.executeOperation(profile.id, {
        operation: 'kill-subscription',
        subscriptionId: second.subscription.id
    });
    assert.equal(killed.subscription.state, 'TERMINATED');
    await service.executeOperation(profile.id, {
        operation: 'delete-subscription',
        subscriptionId: push.subscription.id
    });
    assert.equal(service.getSubscriptions(profile.id).liveCount, 0);

    const legacy = await service.executeOperation(profile.id, {
        operation: 'create-subscription',
        stream: 'NETCONF'
    });
    assert.equal(legacy.subscription.subscriptionType, 'rfc5277');
    await assert.rejects(
        service.executeOperation(profile.id, { operation: 'establish-subscription', stream: 'NETCONF' }),
        error => error.code === 'NETCONF_SUBSCRIPTION_PROTOCOL_CONFLICT'
    );
    emitNotification(client, `<notificationComplete xmlns="${NOTIFICATION_NAMESPACE}"/>`);
    assert.equal(service.getSubscriptions(profile.id).liveCount, 0);

    const rawEstablished = await service.sendRpc(profile.id, {
        rpc: `<rpc xmlns="${BASE_NAMESPACE}" message-id="raw-establish"><establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><stream>NETCONF</stream></establish-subscription></rpc>`
    });
    assert.equal(rawEstablished.subscription.publisherSubscriptionId, '44');
    const rawDeleted = await service.sendRpc(profile.id, {
        rpc: `<rpc xmlns="${BASE_NAMESPACE}" message-id="raw-delete"><delete-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>44</id></delete-subscription></rpc>`
    });
    assert.equal(rawDeleted.subscription.state, 'TERMINATED');

    console.log('RFC 8639/8640 dynamic subscription and RFC 8641 YANG-Push backend tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
