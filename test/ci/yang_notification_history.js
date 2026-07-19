'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');
const { compileScript, compileStyle, compileTemplate, parse } = require('@vue/compiler-sfc');
const { XMLValidator } = require('fast-xml-parser');

const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.join(__dirname, '..', '..'));
const sourcePath = path.join(projectRoot, 'src', 'view', 'yang', 'useNetconfNotificationHistory.js');
const transformed = transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    format: 'cjs',
    loader: 'js',
    target: 'node16'
}).code;
const historyModule = new Module(sourcePath, module);
historyModule.filename = sourcePath;
historyModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
historyModule._compile(transformed, sourcePath);

const history = historyModule.exports;
const notificationXml = (message, eventTime = '2026-07-19T01:02:03Z') => `
<notification xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0">
  <eventTime>${eventTime}</eventTime>
  <mock-event xmlns="urn:netnexus:mock">
    <message>${message}</message>
  </mock-event>
</notification>`;

history.resetNetconfNotificationHistory();
history.configureNetconfNotificationHistory({
    maxRecords: 3,
    maxTotalBytes: 64 * 1024,
    maxXmlBytes: 2048,
    maxSubscriptions: 4
});

const orphanNotification = history.addNetconfNotification({
    id: 'orphan-notification',
    profileId: 'profile-orphan',
    sessionId: 'orphan-session',
    subscriptionId: 'orphan-subscription',
    xml: notificationXml('orphan', '2026-07-19T00:00:01Z')
});
assert.equal(orphanNotification.generatedAt, '2026-07-19T00:00:01.000Z');
const orphanGroup = history
    .useNetconfNotificationHistory()
    .groups.value.find(group => group.profileId === 'profile-orphan').children[0].children[0];
assert.equal(orphanGroup.status, 'unknown', 'a historical notification must not invent an active subscription');
history.selectNetconfNotificationScope({ kind: 'profile', profileId: 'profile-orphan' });
history.clearNetconfNotifications({ kind: 'profile', profileId: 'profile-orphan' });
assert.equal(history.useNetconfNotificationHistory().selectedScopeKey.value, 'notification-scope:all');
assert.equal(history.useNetconfNotificationHistory().selectedRecord.value, null);

history.upsertNetconfNotificationSubscription({
    id: 'terminated-probe',
    profileId: 'profile-probe',
    sessionId: 'probe-session',
    state: 'TERMINATED'
});
assert.equal(history.useNetconfNotificationHistory().subscriptions.value[0].status, 'ended');
history.removeNetconfNotificationSubscription('terminated-probe');

history.upsertNetconfNotificationSubscription({
    id: 'error-probe',
    profileId: 'profile-probe',
    sessionId: 'probe-session',
    state: 'FAILED',
    error: { message: 'subscription failed' }
});
assert.equal(history.useNetconfNotificationHistory().subscriptions.value[0].status, 'error');
assert.equal(history.useNetconfNotificationHistory().subscriptions.value[0].errorMessage, 'subscription failed');
history.removeNetconfNotificationSubscription('error-probe');

history.upsertNetconfNotificationSubscription({
    id: 'modern-probe',
    profileId: 'profile-modern',
    sessionId: 'modern-session',
    type: 'rfc8641',
    deviceSubscriptionId: '52',
    targetType: 'datastore',
    datastore: 'ds:operational',
    datastoreNamespaces: { vd: 'urn:example:vendor-datastore' },
    dscp: 10,
    weighting: 20,
    dependency: 0,
    encoding: 've:cbor',
    encodingNamespaces: { ve: 'urn:example:encoding' },
    updateTrigger: 'on-change',
    state: 'SUSPENDED',
    reason: 'yp:insufficient-resources'
});
const pushUpdateXml = `
<notification xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0">
  <eventTime>2026-07-19T00:30:00Z</eventTime>
  <push-update xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-push">
    <id>52</id>
    <datastore-contents><state xmlns="urn:netnexus:mock"/></datastore-contents>
  </push-update>
</notification>`;
const modernNotification = history.addNetconfNotification({
    id: 'modern-push-update',
    profileId: 'profile-modern',
    sessionId: 'modern-session',
    xml: pushUpdateXml
});
assert.equal(modernNotification.deviceSubscriptionId, '52');
assert.equal(modernNotification.subscriptionId, 'modern-probe');
const modernSubscription = history.useNetconfNotificationHistory().subscriptions.value[0];
assert.equal(modernSubscription.protocol, 'rfc8641');
assert.equal(modernSubscription.status, 'suspended');
assert.equal(modernSubscription.updateTrigger, 'on-change');
assert.deepEqual(modernSubscription.datastoreNamespaces, { vd: 'urn:example:vendor-datastore' });
assert.equal(modernSubscription.dscp, 10);
assert.equal(modernSubscription.weighting, 20);
assert.equal(modernSubscription.dependency, 0);
assert.equal(modernSubscription.encoding, 've:cbor');
assert.deepEqual(modernSubscription.encodingNamespaces, { ve: 'urn:example:encoding' });
assert.equal(modernSubscription.suspensionReason, 'yp:insufficient-resources');
history.upsertNetconfNotificationSubscription({
    id: 'modern-probe',
    state: 'ACTIVE',
    replayCompletedAt: '2026-07-19T00:31:00Z'
});
assert.equal(history.useNetconfNotificationHistory().subscriptions.value[0].suspensionReason, '');
assert.equal(
    history.useNetconfNotificationHistory().subscriptions.value[0].replayCompletedAt,
    '2026-07-19T00:31:00.000Z'
);
for (const [id, xml] of [
    [
        'unknown-device-id',
        `<notification xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0"><eventTime>2026-07-19T00:31:10Z</eventTime><push-update xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-push"><id>999</id></push-update></notification>`
    ],
    [
        'vendor-lookalike',
        `<notification xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0"><eventTime>2026-07-19T00:31:20Z</eventTime><push-update xmlns="urn:example:vendor"><id>52</id></push-update></notification>`
    ],
    [
        'nested-device-id',
        `<notification xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0"><eventTime>2026-07-19T00:31:30Z</eventTime><push-update xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-push"><datastore-contents><id xmlns="urn:example:data">52</id></datastore-contents></push-update></notification>`
    ]
]) {
    const unmatched = history.addNetconfNotification({
        id,
        profileId: 'profile-modern',
        sessionId: 'modern-session',
        xml
    });
    assert.equal(unmatched.subscriptionId, '', `${id} must not fall back to the only active subscription`);
}
const started = history.addNetconfNotification({
    id: 'subscription-started',
    profileId: 'profile-modern',
    sessionId: 'modern-session',
    xml: `<notification xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0"><eventTime>2026-07-19T00:31:40Z</eventTime><sn:subscription-started xmlns:sn="urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications"><sn:id>52</sn:id><sn:stream>NETCONF</sn:stream></sn:subscription-started></notification>`
});
assert.equal(started.subscriptionId, 'modern-probe');
history.upsertNetconfNotificationSubscription({
    id: 'modern-probe',
    state: 'UNKNOWN',
    desynchronized: true,
    desynchronizedAt: '2026-07-19T00:32:00Z',
    desynchronizationReason: 'modify-subscription timed out'
});
assert.equal(history.useNetconfNotificationHistory().subscriptions.value[0].status, 'unknown');
assert.equal(history.useNetconfNotificationHistory().subscriptions.value[0].desynchronized, true);
assert.equal(
    history.useNetconfNotificationHistory().subscriptions.value[0].desynchronizationReason,
    'modify-subscription timed out'
);
history.clearNetconfNotifications({ kind: 'profile', profileId: 'profile-modern' });
history.removeNetconfNotificationSubscription('modern-probe');

history.upsertNetconfNotificationSubscription({
    id: 'zero-device-id',
    profileId: 'profile-modern',
    sessionId: 'modern-session',
    deviceSubscriptionId: 0
});
assert.equal(history.useNetconfNotificationHistory().subscriptions.value[0].deviceSubscriptionId, '0');
assert.equal(history.useNetconfNotificationHistory().subscriptions.value[0].protocol, 'rfc8639');
history.removeNetconfNotificationSubscription('zero-device-id');

history.upsertNetconfNotificationSubscription({
    id: 'empty-subscription',
    profileId: 'profile-empty',
    sessionId: 'empty-session',
    state: 'ACTIVE'
});
history.selectNetconfNotificationScope({
    kind: 'subscription',
    profileId: 'profile-empty',
    sessionId: 'empty-session',
    subscriptionId: 'empty-subscription'
});
assert.equal(history.useNetconfNotificationHistory().selectedRecord.value, null);
history.removeNetconfNotificationSubscription('empty-subscription');

history.upsertNetconfNotificationSubscription({
    id: 'subscription-a',
    profileId: 'profile-a',
    profileName: 'Mock A',
    sessionId: '42',
    eventName: 'mock-event',
    label: 'Mock events',
    status: 'ACTIVE'
});
assert.equal(history.useNetconfNotificationHistory().subscriptions.value[0].status, 'active');

let ingested = history.ingestNetconfNotificationEvent({
    status: 'success',
    data: {
        status: 'success',
        data: {
            profileId: 'profile-a',
            profileName: 'Mock A',
            sessionId: '42',
            eventTime: '2026-07-19T01:02:03Z',
            xml: notificationXml('alpha')
        }
    }
});
assert.equal(ingested.kind, 'notification');
assert.equal(ingested.value.eventName, 'mock-event');
assert.equal(ingested.value.namespace, 'urn:netnexus:mock');
assert.equal(ingested.value.subscriptionId, 'subscription-a');

let state = history.useNetconfNotificationHistory();
assert.equal(state.records.value.length, 1);
assert.equal(state.unreadCount.value, 1);
assert.equal(state.groups.value[0].count, 1);
const profileGroup = state.groups.value.find(group => group.kind === 'profile' && group.profileId === 'profile-a');
assert(profileGroup);
assert.equal(profileGroup.children[0].sessionId, '42');
assert.equal(profileGroup.children[0].children[0].subscriptionId, 'subscription-a');
assert.equal(profileGroup.children[0].children[0].unread, 1);

history.addNetconfNotification({
    id: 'unassigned-event',
    profileId: 'profile-b',
    profileName: 'Mock B',
    sessionId: '77',
    xml: notificationXml('beta', '2026-07-19T02:03:04Z')
});
const unassignedProfile = state.groups.value.find(group => group.profileId === 'profile-b');
assert(unassignedProfile);
assert.equal(unassignedProfile.children[0].children.length, 1, 'unassigned notifications share one group');
assert.equal(unassignedProfile.children[0].children[0].subscriptionId, '');

history.selectNetconfNotificationScope({ kind: 'profile', profileId: 'profile-a' });
assert.equal(state.filteredRecords.value.length, 1);
history.setNetconfNotificationQuery('alpha');
assert.equal(state.filteredRecords.value.length, 1);
history.setNetconfNotificationQuery('does-not-exist');
assert.equal(state.filteredRecords.value.length, 0);
history.setNetconfNotificationQuery('');

history.selectNetconfNotification(ingested.value.id);
assert.equal(state.unreadCount.value, 1, 'selecting one event marks only that event as read');
history.setNetconfNotificationUnreadOnly(true);
assert.equal(state.filteredRecords.value.length, 0);
history.setNetconfNotificationUnreadOnly(false);

const jsonExport = history.createNetconfNotificationExport({
    scope: { kind: 'profile', profileId: 'profile-a' }
});
assert.equal(jsonExport.count, 1);
assert.equal(jsonExport.subscriptions.length, 1);
assert.equal(
    history.createNetconfNotificationExport({
        scope: {
            kind: 'subscription',
            profileId: 'profile-a',
            sessionId: '42',
            subscriptionId: 'subscription-a'
        }
    }).subscriptions.length,
    1
);
assert.equal(JSON.parse(history.serializeNetconfNotificationExport({ format: 'json' })).schemaVersion, 1);
const xmlExport = history.serializeNetconfNotificationExport({ format: 'xml' });
assert.match(xmlExport, /<notification-xml><!\[CDATA\[/u);
assert.match(xmlExport, /<mock-event/u);
assert.equal(XMLValidator.validate(xmlExport), true);
assert.match(history.netconfNotificationExportDescriptor().filename, /^netconf-notifications-.*\.json$/u);

history.addNetconfNotification({ id: 'event-3', profileId: 'profile-a', sessionId: '42', xml: notificationXml('3') });
history.addNetconfNotification({ id: 'event-4', profileId: 'profile-a', sessionId: '42', xml: notificationXml('4') });
history.addNetconfNotification({ id: 'event-5', profileId: 'profile-a', sessionId: '42', xml: notificationXml('5') });
assert.equal(state.records.value.length, 3);
assert.equal(
    state.records.value.some(record => record.id === ingested.value.id),
    false,
    'old records are evicted'
);
assert(state.totalBytes.value <= state.limits.maxTotalBytes);
history.selectNetconfNotification('');
assert.equal(state.selectedRecord.value, null);

const oversized = history.addNetconfNotification({
    id: 'oversized',
    profileId: 'profile-a',
    sessionId: '42',
    xml: notificationXml('x'.repeat(20_000))
});
assert.equal(oversized.xmlTruncated, true);
assert(Buffer.byteLength(oversized.xml, 'utf8') <= state.limits.maxXmlBytes);
assert(state.totalBytes.value <= state.limits.maxTotalBytes);
assert.equal(XMLValidator.validate(history.serializeNetconfNotificationExport({ format: 'xml' })), true);

const listeners = new Map();
const fakeEventBus = {
    on(type, id, handler) {
        listeners.set(`${type}:${id}`, handler);
    },
    off(type, id) {
        listeners.delete(`${type}:${id}`);
    }
};
const disposeCollector = history.installNetconfNotificationCollector(fakeEventBus, {
    NOTIFICATION: 'test:notification',
    SUBSCRIPTION_EVENT: 'test:subscription'
});
const subscriptionHandler = listeners.get('test:subscription:netconf-notification-history-collector');
const notificationHandler = listeners.get('test:notification:netconf-notification-history-collector');
assert.equal(typeof subscriptionHandler, 'function');
assert.equal(typeof notificationHandler, 'function');
subscriptionHandler({
    status: 'success',
    data: { data: { kind: 'subscription', id: 'collector-subscription', profileId: 'collector-profile' } }
});
notificationHandler({
    status: 'success',
    data: { data: { id: 'collector-event', profileId: 'collector-profile', xml: notificationXml('collector') } }
});
assert(state.subscriptions.value.some(subscription => subscription.id === 'collector-subscription'));
assert(state.records.value.some(record => record.id === 'collector-event'));
disposeCollector();
assert.equal(listeners.size, 0);

assert.equal(history.deleteNetconfNotification('collector-event'), true);
assert(history.clearNetconfNotifications({ kind: 'all' }) > 0);
assert.equal(state.records.value.length, 0);

const componentPath = path.join(projectRoot, 'src', 'view', 'yang', 'YangNotificationDrawer.vue');
const componentSource = fs.readFileSync(componentPath, 'utf8');
const parsed = parse(componentSource, { filename: componentPath });
assert.deepEqual(parsed.errors, []);
assert(parsed.descriptor.template);
assert(parsed.descriptor.scriptSetup);
assert(parsed.descriptor.styles.length > 0);
compileScript(parsed.descriptor, { id: 'yang-notification-drawer' });
const templateResult = compileTemplate({
    id: 'yang-notification-drawer',
    filename: componentPath,
    source: parsed.descriptor.template.content,
    scoped: true
});
assert.deepEqual(templateResult.errors, []);
const styleResult = compileStyle({
    id: 'data-v-yang-notification-drawer',
    filename: componentPath,
    source: parsed.descriptor.styles[0].content,
    scoped: true
});
assert.deepEqual(styleResult.errors, []);
for (const expected of [
    'Generated',
    'Received',
    'Notification',
    'line-numbers',
    'netconf-notification-xml',
    '断开 Session 并结束订阅',
    'disconnect-session'
]) {
    assert(componentSource.includes(expected), `notification drawer must include ${expected}`);
}

const workspaceSource = fs.readFileSync(path.join(projectRoot, 'src', 'view', 'yang', 'YangWorkspace.vue'), 'utf8');
assert(workspaceSource.includes("invokeBridge('netconfApi', 'disconnect', profileId)"));
assert(workspaceSource.includes('RFC 5277 没有单独的取消订阅 RPC'));

history.resetNetconfNotificationHistory();
console.log('NETCONF notification history store and drawer component tests passed');
