'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const NetconfApp = require('../../electron/app/netconfApp');
const EventDispatcher = require('../../electron/utils/eventDispatcher');
const { YANG_EVT_TYPES } = require('../../electron/const/yangConst');

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

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const notification = (sequence, overrides = {}) => ({
    profileId: 'notification-router',
    profileName: 'Notification router',
    host: '192.0.2.20',
    port: 830,
    sessionId: '101',
    subscriptionId: 'local-subscription-1',
    publisherSubscriptionId: '77',
    receivedAt: `2026-08-07T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
    eventTime: `2026-08-07T00:00:${String(sequence % 60).padStart(2, '0')}Z`,
    eventName: 'link-change',
    namespace: 'urn:example:events',
    xml: `<notification><sequence>${sequence}</sequence></notification>`,
    document: { notification: { sequence } },
    ...overrides
});

async function main() {
    const ipcMain = new FakeIpcMain();
    const primary = new FakeWebContents(1);
    const subscriber = new FakeWebContents(2);
    const app = new NetconfApp(ipcMain, new MemoryStore(), {
        primaryWebContents: primary,
        yangApp: { setActiveProfileId() {} },
        notificationSummaryDelayMs: 5
    });

    for (const channel of [
        'netconf:getNotificationHistory',
        'netconf:getNotificationSummary',
        'netconf:markNotificationRead',
        'netconf:deleteNotificationHistory',
        'netconf:clearNotificationHistory',
        'netconf:requestNotificationAction'
    ]) {
        assert.equal(ipcMain.handlers.has(channel), true, `${channel} must be registered`);
    }

    const subscription = {
        id: 'local-subscription-1',
        subscriptionId: 'local-subscription-1',
        deviceSubscriptionId: '77',
        publisherSubscriptionId: '77',
        profileId: 'notification-router',
        profileName: 'Notification router',
        sessionId: '101',
        state: 'ACTIVE',
        targetType: 'stream',
        stream: 'NETCONF',
        filter: { type: 'xpath', select: '/events/link-change', namespaces: { e: 'urn:example:events' } },
        createdAt: '2026-08-07T00:00:00.000Z'
    };
    app.relayWorkerEvent(YANG_EVT_TYPES.SUBSCRIPTION_EVENT, subscription);
    primary.messages.length = 0;

    assert.equal(EventDispatcher.subscribe(subscriber, YANG_EVT_TYPES.NOTIFICATION), true);
    app.relayWorkerEvent(YANG_EVT_TYPES.NOTIFICATION, notification(1));
    assert.equal(primary.messages.length, 0, 'full notifications must not be broadcast to the primary renderer');
    assert.equal(subscriber.messages.length, 1, 'an open notification window must receive the full live record');
    const liveRecord = subscriber.messages[0].payload.data.data;
    assert.equal(subscriber.messages[0].payload.type, YANG_EVT_TYPES.NOTIFICATION);
    assert.match(liveRecord.id, /^netconf-notification-/u);
    assert.equal(liveRecord.historyId, liveRecord.id);
    assert.equal(liveRecord.read, false);
    assert.match(liveRecord.xml, /<sequence>1<\/sequence>/u);

    await wait(20);
    assert.equal(primary.messages.length, 1, 'notification summaries must be batched for the primary renderer');
    assert.equal(primary.messages[0].payload.type, YANG_EVT_TYPES.NOTIFICATION_SUMMARY);
    assert.equal(primary.messages[0].payload.data.data.total, 1);
    assert.equal(primary.messages[0].payload.data.data.unread, 1);
    assert.equal(primary.messages[0].payload.data.data.lastEventName, 'link-change');
    assert.doesNotMatch(JSON.stringify(primary.messages[0]), /<notification>/u, 'summary IPC must not include XML');

    const initialHistory = await app.handleGetNotificationHistory(null);
    assert.equal(initialHistory.status, 'success');
    assert.equal(initialHistory.data.notifications.length, 1);
    assert.equal(initialHistory.data.subscriptions.length, 1, 'history snapshot must include active subscriptions');
    assert.equal(initialHistory.data.subscriptions[0].subscriptionId, 'local-subscription-1');
    assert.deepEqual(initialHistory.data.limits, {
        maxRecords: 500,
        maxTotalBytes: 16 * 1024 * 1024,
        maxXmlBytes: 2 * 1024 * 1024,
        maxSubscriptions: 256
    });

    subscriber.destroy();
    primary.messages.length = 0;
    app.relayWorkerEvent(YANG_EVT_TYPES.NOTIFICATION, notification(2));
    assert.equal(primary.messages.length, 0, 'a closed notification window must not cause full IPC delivery');
    await wait(20);
    assert.deepEqual(
        primary.messages.map(message => message.payload.type),
        [YANG_EVT_TYPES.NOTIFICATION_SUMMARY]
    );
    assert.equal((await app.handleGetNotificationHistory(null)).data.notifications.length, 2);

    const oversizedXml = `<notification>${'x'.repeat(2 * 1024 * 1024 + 4096)}</notification>`;
    app.relayWorkerEvent(YANG_EVT_TYPES.NOTIFICATION, notification(3, { xml: oversizedXml }));
    const oversizedRecord = (await app.handleGetNotificationHistory(null)).data.notifications[0];
    assert.equal(oversizedRecord.xmlTruncated, true);
    assert(Buffer.byteLength(oversizedRecord.xml, 'utf8') <= 2 * 1024 * 1024);

    for (let sequence = 4; sequence <= 505; sequence += 1) {
        app.relayWorkerEvent(YANG_EVT_TYPES.NOTIFICATION, notification(sequence));
    }
    const boundedHistory = await app.handleGetNotificationHistory(null);
    assert.equal(boundedHistory.data.notifications.length, 500);
    assert.equal(boundedHistory.data.summary.total, 500);
    assert.equal(boundedHistory.data.summary.received, 505);
    assert.equal(boundedHistory.data.summary.dropped, 5);

    const newestId = boundedHistory.data.notifications[0].historyId;
    const markOne = await app.handleMarkNotificationRead(null, { id: newestId, read: true });
    assert.equal(markOne.status, 'success');
    assert.equal(markOne.data.updated, 1);
    assert.equal(markOne.data.summary.unread, 499);
    const markProfile = await app.handleMarkNotificationRead(null, {
        scope: { kind: 'profile', profileId: 'notification-router' },
        read: true
    });
    assert.equal(markProfile.data.updated, 499);
    assert.equal(markProfile.data.summary.unread, 0);

    const scopedHistory = await app.handleGetNotificationHistory(null, {
        scope: {
            kind: 'subscription',
            profileId: 'notification-router',
            sessionId: '101',
            subscriptionId: 'local-subscription-1'
        }
    });
    assert.equal(scopedHistory.data.notifications.length, 500);
    assert.equal(scopedHistory.data.subscriptions.length, 1);

    const deleteMissingTarget = await app.handleDeleteNotificationHistory(null, {});
    assert.equal(deleteMissingTarget.status, 'error');
    assert.equal(deleteMissingTarget.data.code, 'NETCONF_NOTIFICATION_TARGET_REQUIRED');
    const deleteOne = await app.handleDeleteNotificationHistory(null, { notificationId: newestId });
    assert.equal(deleteOne.status, 'success');
    assert.equal(deleteOne.data.removed, 1);
    assert.equal(deleteOne.data.summary.total, 499);

    primary.messages.length = 0;
    const invalidAction = await app.handleRequestNotificationAction(null, {
        operation: 'execute-arbitrary-rpc',
        profileId: 'notification-router'
    });
    assert.equal(invalidAction.status, 'error');
    assert.equal(invalidAction.data.code, 'NETCONF_NOTIFICATION_ACTION_UNSUPPORTED');
    assert.equal(primary.messages.length, 0);

    const acceptedAction = await app.handleRequestNotificationAction(null, {
        operation: 'modify-subscription',
        profileId: 'notification-router',
        subscriptionId: 'local-subscription-1',
        deviceSubscriptionId: '77',
        untrustedExtraField: '<rpc>must-not-pass</rpc>'
    });
    assert.equal(acceptedAction.status, 'success');
    const actionMessage = primary.messages.find(message => message.payload.type === YANG_EVT_TYPES.NOTIFICATION_ACTION);
    assert(actionMessage, 'the compact action must be relayed to the primary renderer');
    const action = actionMessage.payload.data.data;
    assert.equal(action.operation, 'modify-subscription');
    assert.equal(action.profileId, 'notification-router');
    assert.equal(action.deviceSubscriptionId, '77');
    assert.deepEqual(action.filter, subscription.filter);
    assert.equal(Object.hasOwn(action, 'untrustedExtraField'), false);

    const clear = await app.handleClearNotificationHistory(null, {
        scope: { kind: 'session', profileId: 'notification-router', sessionId: '101' }
    });
    assert.equal(clear.status, 'success');
    assert.equal(clear.data.removed, 499);
    assert.equal(clear.data.summary.total, 0);
    assert.equal((await app.handleGetNotificationSummary()).data.total, 0);

    await app.closeAll();
    console.log('NETCONF notification backend history, routing and action relay tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
