'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { NetconfClient, NetconfRpcError } = require('../../electron/utils/netconf');
const {
    MockNetconfServer,
    MOCK_MODULES,
    SUBSCRIBED_NOTIFICATIONS_NAMESPACE: SN_NAMESPACE,
    YANG_PUSH_NAMESPACE
} = require('../../scripts/mockNetconfServer');

const DS_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
const MOCK_NAMESPACE = 'urn:netnexus:params:xml:ns:yang:mock-device';
const NETCONF_BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const RPC_OPTIONS = Object.freeze({ timeout: 5_000 });

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function waitFor(predicate, message, timeoutMs = 3_000) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const check = () => {
            try {
                const result = predicate();
                if (result) return resolve(result);
            } catch (error) {
                reject(error);
                return;
            }
            if (Date.now() - startedAt >= timeoutMs) return reject(new Error(message));
            setTimeout(check, 20);
        };
        check();
    });
}

function createClient() {
    return new NetconfClient({ helloTimeout: 5_000, rpcTimeout: 5_000, maxMessageSize: 8 * 1024 * 1024 });
}

function profile(status) {
    return {
        host: status.host,
        port: status.port,
        username: status.username,
        password: 'netconf',
        hostKeyFingerprint: status.fingerprint,
        readyTimeout: 5_000,
        keepaliveInterval: 0
    };
}

function replySubscriptionId(reply) {
    const match = /<id(?:\s[^>]*)?>(\d+)<\/id>/u.exec(reply.xml);
    assert(match, 'establish-subscription must return a publisher subscription id');
    return match[1];
}

function assertRpcError(error, tag, appTag) {
    assert(error instanceof NetconfRpcError, `expected NetconfRpcError, received ${error?.name || error}`);
    assert.equal(error.errors[0]?.tag, tag);
    if (appTag) assert.equal(error.errors[0]?.appTag, appTag);
    return true;
}

function validateNotificationWithBundledYanglint(xml) {
    const workspaceRoot = path.resolve(__dirname, '../..');
    const runtimeRoot = path.join(workspaceRoot, 'resources', 'libyang', `${process.platform}-${process.arch}`);
    const executable = path.join(runtimeRoot, 'bin', process.platform === 'win32' ? 'yanglint.exe' : 'yanglint');
    if (!fs.existsSync(executable)) return false;
    const moduleRoot = path.join(runtimeRoot, 'share', 'yang', 'modules', 'libyang');
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-yang-push-'));
    const notificationPath = path.join(temporaryRoot, 'push-change-notification.xml');
    try {
        fs.writeFileSync(notificationPath, xml, 'utf8');
        const result = spawnSync(
            executable,
            [
                '-I',
                'xml',
                '-t',
                'nc-notif',
                '-p',
                moduleRoot,
                '-F',
                'ietf-subscribed-notifications:encode-xml,subtree,xpath',
                '-F',
                'ietf-yang-push:on-change',
                path.join(moduleRoot, 'ietf-subscribed-notifications@2019-09-09.yang'),
                path.join(moduleRoot, 'ietf-yang-push@2019-09-09.yang'),
                notificationPath
            ],
            { encoding: 'utf8' }
        );
        assert.equal(result.status, 0, `bundled yanglint rejected notification:\n${result.stderr || result.stdout}`);
        return true;
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

function validateSubscriptionStateWithBundledYanglint(xml) {
    const workspaceRoot = path.resolve(__dirname, '../..');
    const runtimeRoot = path.join(workspaceRoot, 'resources', 'libyang', `${process.platform}-${process.arch}`);
    const executable = path.join(runtimeRoot, 'bin', process.platform === 'win32' ? 'yanglint.exe' : 'yanglint');
    if (!fs.existsSync(executable)) return false;
    const subscriptions = /<subscriptions\b[\s\S]*<\/subscriptions>/u.exec(xml)?.[0];
    assert(subscriptions, 'NETCONF get reply is missing the subscriptions state tree');
    const moduleRoot = path.join(runtimeRoot, 'share', 'yang', 'modules', 'libyang');
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-subscription-state-'));
    const statePath = path.join(temporaryRoot, 'subscriptions.xml');
    try {
        fs.writeFileSync(statePath, subscriptions, 'utf8');
        const result = spawnSync(
            executable,
            [
                '-I',
                'xml',
                '-t',
                'data',
                '-p',
                moduleRoot,
                '-F',
                'ietf-subscribed-notifications:encode-xml,subtree,xpath',
                '-F',
                'ietf-yang-push:on-change',
                path.join(moduleRoot, 'ietf-datastores@2018-02-14.yang'),
                path.join(moduleRoot, 'ietf-subscribed-notifications@2019-09-09.yang'),
                path.join(moduleRoot, 'ietf-yang-push@2019-09-09.yang'),
                statePath
            ],
            { encoding: 'utf8' }
        );
        assert.equal(
            result.status,
            0,
            `bundled yanglint rejected subscriptions state:\n${result.stderr || result.stdout}`
        );
        return true;
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

function notificationEventTime(xml) {
    const match = /<eventTime>([^<]+)<\/eventTime>/u.exec(xml);
    assert(match, 'notification is missing eventTime');
    return Date.parse(match[1]);
}

function isPushNotification(notification, eventName, subscriptionId) {
    return (
        notification.xml.includes(`<${eventName}`) &&
        notification.xml.includes(`<${eventName} xmlns="${YANG_PUSH_NAMESPACE}"><id>${subscriptionId}</id>`)
    );
}

function streamSubscription(message) {
    return (
        `<establish-subscription xmlns="${SN_NAMESPACE}">` +
        '<stream-subtree-filter>' +
        `<mock-event xmlns="${MOCK_NAMESPACE}"><message>${message}</message></mock-event>` +
        '</stream-subtree-filter><stream>NETCONF</stream></establish-subscription>'
    );
}

function datastoreSubscription(filter, trigger) {
    return (
        `<establish-subscription xmlns="${SN_NAMESPACE}" ` +
        `xmlns:yp="${YANG_PUSH_NAMESPACE}" xmlns:ds="${DS_NAMESPACE}">` +
        '<yp:datastore>ds:operational</yp:datastore>' +
        filter +
        trigger +
        '</establish-subscription>'
    );
}

async function run() {
    const server = new MockNetconfServer({ port: 0, quiet: true });
    const clients = [];
    try {
        const status = await server.start();
        const subscriber = createClient();
        const administrator = createClient();
        clients.push(subscriber, administrator);
        const session = await subscriber.connect(profile(status));
        await administrator.connect(profile(status));

        const subscribedNotificationsCapability = session.capabilities.find(value =>
            value.startsWith(`${SN_NAMESPACE}?module=ietf-subscribed-notifications&revision=2019-09-09`)
        );
        assert(subscribedNotificationsCapability);
        assert.doesNotMatch(subscribedNotificationsCapability, /(?:^|,)replay(?:,|$)/u);
        assert(
            session.capabilities.some(value =>
                value.startsWith(`${YANG_PUSH_NAMESPACE}?module=ietf-yang-push&revision=2019-09-09`)
            )
        );
        const inventory = await subscriber.discoverSchemas(RPC_OPTIONS);
        assert.deepEqual(inventory.modules.map(module => module.name).sort(), Object.keys(MOCK_MODULES).sort());
        const subscribedNotificationsModule = inventory.modules.find(
            module => module.name === 'ietf-subscribed-notifications'
        );
        const yangPushModule = inventory.modules.find(module => module.name === 'ietf-yang-push');
        assert.deepEqual(subscribedNotificationsModule.features.sort(), ['encode-xml', 'subtree', 'xpath']);
        assert.deepEqual(yangPushModule.features, ['on-change']);
        const subscribedNotificationsSchema = await subscriber.getSchema({
            identifier: subscribedNotificationsModule.name,
            version: subscribedNotificationsModule.revision,
            format: 'yang',
            timeout: RPC_OPTIONS.timeout
        });
        const yangPushSchema = await subscriber.getSchema({
            identifier: yangPushModule.name,
            version: yangPushModule.revision,
            format: 'yang',
            timeout: RPC_OPTIONS.timeout
        });
        assert.match(subscribedNotificationsSchema.content, /^module ietf-subscribed-notifications/u);
        assert.match(yangPushSchema.content, /^module ietf-yang-push/u);
        for (const dependency of [
            'ietf-datastores',
            'ietf-interfaces',
            'ietf-network-instance',
            'ietf-restconf',
            'ietf-yang-patch',
            'ietf-yang-schema-mount'
        ]) {
            assert(
                inventory.modules.some(module => module.name === dependency),
                `missing ${dependency} dependency`
            );
        }
        for (const module of inventory.modules.filter(item => item.name.startsWith('ietf-'))) {
            const schema = await subscriber.getSchema({
                identifier: module.name,
                version: module.revision,
                format: 'yang',
                timeout: RPC_OPTIONS.timeout
            });
            assert(
                schema.content.includes(`module ${module.name} {`),
                `get-schema did not return the source for ${module.name}`
            );
        }

        const notifications = [];
        subscriber.on('notification', notification => notifications.push(notification));

        await assert.rejects(
            subscriber.rpc(
                `<establish-subscription xmlns="${SN_NAMESPACE}"><stream>NETCONF</stream>` +
                    '<replay-start-time>2026-01-01T00:00:00Z</replay-start-time></establish-subscription>',
                RPC_OPTIONS
            ),
            error =>
                assertRpcError(error, 'operation-not-supported', 'ietf-subscribed-notifications:replay-unsupported')
        );
        await assert.rejects(
            subscriber.rpc(
                `<establish-subscription xmlns="${SN_NAMESPACE}">` +
                    '<stream>NETCONF</stream><dscp>10</dscp></establish-subscription>',
                RPC_OPTIONS
            ),
            error => assertRpcError(error, 'invalid-value', 'ietf-subscribed-notifications:dscp-unavailable')
        );
        await assert.rejects(
            subscriber.rpc(
                `<establish-subscription xmlns="${SN_NAMESPACE}">` +
                    '<stream-xpath-filter>relative/path</stream-xpath-filter>' +
                    '<stream>NETCONF</stream></establish-subscription>',
                RPC_OPTIONS
            ),
            error => assertRpcError(error, 'invalid-value', 'ietf-subscribed-notifications:filter-unsupported')
        );
        await assert.rejects(
            subscriber.rpc(
                `<establish-subscription xmlns="${SN_NAMESPACE}" xmlns:yp="${YANG_PUSH_NAMESPACE}">` +
                    '<yp:stream>NETCONF</yp:stream></establish-subscription>',
                RPC_OPTIONS
            ),
            error => assertRpcError(error, 'unknown-namespace')
        );
        await assert.rejects(
            subscriber.rpc(
                `<delete-subscription xmlns="${SN_NAMESPACE}"><id>0</id></delete-subscription>`,
                RPC_OPTIONS
            ),
            error => assertRpcError(error, 'invalid-value', 'ietf-subscribed-notifications:no-such-subscription')
        );
        await assert.rejects(
            subscriber.rpc(
                `<resync-subscription xmlns="${YANG_PUSH_NAMESPACE}"><id>0</id></resync-subscription>`,
                RPC_OPTIONS
            ),
            error => assertRpcError(error, 'invalid-value', 'ietf-yang-push:no-such-subscription-resync')
        );
        await assert.rejects(
            subscriber.rpc(
                datastoreSubscription('', '<yp:periodic><yp:period>0</yp:period></yp:periodic>'),
                RPC_OPTIONS
            ),
            error => assertRpcError(error, 'invalid-value', 'ietf-yang-push:period-unsupported')
        );

        const streamId = replySubscriptionId(await subscriber.rpc(streamSubscription('stream-match'), RPC_OPTIONS));
        const streams = await subscriber.get(
            {
                filter: {
                    type: 'subtree',
                    content: `<streams xmlns="${SN_NAMESPACE}"><stream><name/></stream></streams>`
                }
            },
            RPC_OPTIONS
        );
        assert.match(streams.xml, /<name>NETCONF<\/name>/u);
        server.notify('stream-miss');
        await delay(60);
        assert.equal(
            notifications.some(item => item.xml.includes('stream-miss')),
            false
        );
        server.notify('stream-match');
        await waitFor(
            () => notifications.find(item => item.xml.includes('<mock-event') && item.xml.includes('stream-match')),
            'RFC 8639 stream event was not delivered'
        );
        await assert.rejects(subscriber.createSubscription({}, RPC_OPTIONS), error =>
            assertRpcError(error, 'operation-not-supported')
        );

        // subscription-started is configured-only in RFC 8639.  This explicit
        // injection hook lets UI tests exercise its wire format without making
        // dynamic establishment emit a non-standard state notification.
        assert.equal(server.notifySubscriptionState(streamId, 'subscription-started'), true);
        await waitFor(
            () =>
                notifications.find(
                    item => item.xml.includes('<subscription-started') && item.xml.includes(`<id>${streamId}</id>`)
                ),
            'subscription-started test notification was not delivered'
        );

        const periodicId = replySubscriptionId(
            await subscriber.rpc(
                datastoreSubscription(
                    '<yp:datastore-subtree-filter>' +
                        `<state xmlns="${MOCK_NAMESPACE}"><datastore-revision/></state>` +
                        '</yp:datastore-subtree-filter>',
                    '<yp:periodic><yp:period>20</yp:period></yp:periodic>'
                ),
                RPC_OPTIONS
            )
        );
        const initialPeriodic = await waitFor(
            () => notifications.find(item => isPushNotification(item, 'push-update', periodicId)),
            'initial periodic push-update was not delivered'
        );
        assert.match(initialPeriodic.xml, /<datastore-revision>\d+<\/datastore-revision>/u);
        assert.doesNotMatch(initialPeriodic.xml, /<(?:uptime|session-count|last-operation)>/u);
        await assert.rejects(
            subscriber.rpc(
                `<resync-subscription xmlns="${YANG_PUSH_NAMESPACE}"><id>${periodicId}</id></resync-subscription>`,
                RPC_OPTIONS
            ),
            error => assertRpcError(error, 'operation-not-supported', 'ietf-yang-push:on-change-sync-unsupported')
        );
        await assert.rejects(
            administrator.rpc(
                `<resync-subscription xmlns="${YANG_PUSH_NAMESPACE}"><id>${periodicId}</id></resync-subscription>`,
                RPC_OPTIONS
            ),
            error => assertRpcError(error, 'invalid-value', 'ietf-yang-push:no-such-subscription-resync')
        );
        const subscriptions = await subscriber.get(
            {
                filter: {
                    type: 'subtree',
                    content: `<subscriptions xmlns="${SN_NAMESPACE}"/>`
                }
            },
            RPC_OPTIONS
        );
        assert.match(subscriptions.xml, new RegExp(`<id>${streamId}</id>`, 'u'));
        assert.match(subscriptions.xml, new RegExp(`<id>${periodicId}</id>`, 'u'));
        assert.equal((subscriptions.xml.match(/<subscription>/gu) || []).length, 2);
        assert.equal((subscriptions.xml.match(/<encoding>encode-xml<\/encoding>/gu) || []).length, 2);
        assert.equal((subscriptions.xml.match(/<receivers><receiver>/gu) || []).length, 2);
        assert.match(
            subscriptions.xml,
            new RegExp(
                `<id>${streamId}</id>[\\s\\S]*?<sent-event-records>[1-9]\\d*</sent-event-records>` +
                    '<excluded-event-records>[1-9]\\d*</excluded-event-records>',
                'u'
            )
        );
        assert.match(
            subscriptions.xml,
            new RegExp(
                '<receivers><receiver><name>NETCONF session ' +
                    session.sessionId +
                    ' \\(netconf\\)<\\/name><sent-event-records>\\d+<\\/sent-event-records>' +
                    '<excluded-event-records>\\d+<\\/excluded-event-records><state>active<\\/state>',
                'u'
            )
        );
        validateSubscriptionStateWithBundledYanglint(subscriptions.xml);

        const operationalStateId = replySubscriptionId(
            await subscriber.rpc(
                datastoreSubscription(
                    '<yp:datastore-xpath-filter>' +
                        '/ietf-subscribed-notifications:subscriptions/' +
                        'ietf-subscribed-notifications:subscription/' +
                        'ietf-subscribed-notifications:id</yp:datastore-xpath-filter>',
                    '<yp:periodic><yp:period>50</yp:period></yp:periodic>'
                ),
                RPC_OPTIONS
            )
        );
        const operationalStateUpdate = await waitFor(
            () => notifications.find(item => isPushNotification(item, 'push-update', operationalStateId)),
            'operational YANG-Push did not include subscribed-notifications state'
        );
        assert.match(
            operationalStateUpdate.xml,
            new RegExp(`<subscriptions xmlns="${SN_NAMESPACE}">[\\s\\S]*<id>${operationalStateId}</id>`, 'u')
        );

        const beforeModify = notifications.length;
        const modifyPeriodic =
            `<modify-subscription xmlns="${SN_NAMESPACE}" ` +
            `xmlns:yp="${YANG_PUSH_NAMESPACE}" xmlns:ds="${DS_NAMESPACE}">` +
            `<id>${periodicId}</id><yp:datastore>ds:operational</yp:datastore>` +
            '<yp:datastore-xpath-filter>' +
            '/netnexus-mock-device:system/netnexus-mock-device:hostname</yp:datastore-xpath-filter>' +
            '<yp:periodic><yp:period>10</yp:period></yp:periodic></modify-subscription>';
        assert.equal((await subscriber.rpc(modifyPeriodic, RPC_OPTIONS)).ok, true);
        await delay(40);
        assert.equal(
            notifications.slice(beforeModify).some(item => item.xml.includes('<subscription-modified')),
            false,
            'subscriber-driven modify must not fabricate subscription-modified'
        );
        assert.equal(server.notifySubscriptionState(periodicId, 'subscription-modified'), true);
        const modifiedState = await waitFor(
            () =>
                notifications.find(
                    item => item.xml.includes('<subscription-modified') && item.xml.includes(`<id>${periodicId}</id>`)
                ),
            'subscription-modified test notification was not delivered'
        );
        assert.match(modifiedState.xml, /<period>10<\/period>/u);
        await waitFor(
            () =>
                notifications.find(
                    item =>
                        isPushNotification(item, 'push-update', periodicId) &&
                        item.xml.includes('<hostname>netnexus-mock</hostname>')
                ),
            'modified datastore XPath selection was not applied'
        );

        await assert.rejects(
            administrator.rpc(
                `<modify-subscription xmlns="${SN_NAMESPACE}"><id>${periodicId}</id></modify-subscription>`,
                RPC_OPTIONS
            ),
            error => assertRpcError(error, 'invalid-value', 'ietf-subscribed-notifications:no-such-subscription')
        );

        const onChangeId = replySubscriptionId(
            await subscriber.rpc(
                datastoreSubscription(
                    '<yp:datastore-subtree-filter>' +
                        `<system xmlns="${MOCK_NAMESPACE}"><hostname/></system>` +
                        '</yp:datastore-subtree-filter>',
                    '<yp:on-change><yp:dampening-period>100</yp:dampening-period>' +
                        '<yp:sync-on-start>true</yp:sync-on-start></yp:on-change>'
                ),
                RPC_OPTIONS
            )
        );
        await waitFor(
            () => notifications.find(item => isPushNotification(item, 'push-update', onChangeId)),
            'on-change sync-on-start update was not delivered'
        );
        await subscriber.editConfig(
            {
                target: 'running',
                config: `<system xmlns="${MOCK_NAMESPACE}"><hostname>yang-push-change</hostname></system>`
            },
            RPC_OPTIONS
        );
        const changeUpdate = await waitFor(
            () =>
                notifications.find(
                    item => item.xml.includes('<push-change-update') && item.xml.includes(`<id>${onChangeId}</id>`)
                ),
            'on-change push-change-update was not delivered'
        );
        assert.doesNotMatch(changeUpdate.xml, /xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-patch"/u);
        assert.match(changeUpdate.xml, /<patch-id>0<\/patch-id>/u);
        assert.match(changeUpdate.xml, /<operation>replace<\/operation>/u);
        assert.match(changeUpdate.xml, /<target>\/netnexus-mock-device:system\/hostname<\/target>/u);
        assert.match(changeUpdate.xml, /<hostname(?:\s[^>]*)?>yang-push-change<\/hostname>/u);
        validateNotificationWithBundledYanglint(changeUpdate.xml);

        const churnStart = notifications.length;
        await subscriber.editConfig(
            {
                target: 'running',
                config: `<system xmlns="${MOCK_NAMESPACE}"><hostname>yang-push-transient</hostname></system>`
            },
            RPC_OPTIONS
        );
        await subscriber.editConfig(
            {
                target: 'running',
                config: `<system xmlns="${MOCK_NAMESPACE}"><hostname>yang-push-change</hostname></system>`
            },
            RPC_OPTIONS
        );
        const churnUpdate = await waitFor(
            () =>
                notifications
                    .slice(churnStart)
                    .find(
                        item => item.xml.includes('<push-change-update') && item.xml.includes(`<id>${onChangeId}</id>`)
                    ),
            'on-change churn was lost during dampening'
        );
        assert.match(churnUpdate.xml, /<patch-id>1<\/patch-id>/u);
        assert.match(churnUpdate.xml, /yang-push-transient/u);
        assert.match(churnUpdate.xml, /yang-push-change/u);
        assert.equal((churnUpdate.xml.match(/<operation>replace<\/operation>/gu) || []).length, 2);

        const pendingModifyStart = notifications.length;
        await subscriber.editConfig(
            {
                target: 'running',
                config: `<system xmlns="${MOCK_NAMESPACE}"><hostname>pending-before-modify</hostname></system>`
            },
            RPC_OPTIONS
        );
        assert.equal(
            (
                await subscriber.rpc(
                    `<modify-subscription xmlns="${SN_NAMESPACE}" xmlns:yp="${YANG_PUSH_NAMESPACE}" ` +
                        `xmlns:ds="${DS_NAMESPACE}"><id>${onChangeId}</id>` +
                        '<yp:datastore>ds:operational</yp:datastore>' +
                        '<yp:on-change><yp:dampening-period>5</yp:dampening-period></yp:on-change>' +
                        '</modify-subscription>',
                    RPC_OPTIONS
                )
            ).ok,
            true
        );
        const pendingAfterModify = await waitFor(
            () =>
                notifications
                    .slice(pendingModifyStart)
                    .find(
                        item =>
                            item.xml.includes('<push-change-update') &&
                            item.xml.includes(`<id>${onChangeId}</id>`) &&
                            item.xml.includes('pending-before-modify')
                    ),
            'modify-subscription discarded a dampened datastore change'
        );
        assert.match(pendingAfterModify.xml, /<patch-id>2<\/patch-id>/u);

        await assert.rejects(
            subscriber.rpc(
                `<modify-subscription xmlns="${SN_NAMESPACE}"><id>${onChangeId}</id></modify-subscription>`,
                RPC_OPTIONS
            ),
            error => assertRpcError(error, 'missing-element')
        );

        const fullUpdateCount = notifications.filter(item =>
            isPushNotification(item, 'push-update', onChangeId)
        ).length;
        assert.equal(
            (
                await subscriber.rpc(
                    `<resync-subscription xmlns="${YANG_PUSH_NAMESPACE}"><id>${onChangeId}</id></resync-subscription>`,
                    RPC_OPTIONS
                )
            ).ok,
            true
        );
        await waitFor(
            () =>
                notifications.filter(item => isPushNotification(item, 'push-update', onChangeId)).length >
                fullUpdateCount,
            'resync-subscription did not send a full push-update'
        );
        const afterResyncStart = notifications.length;
        await subscriber.editConfig(
            {
                target: 'running',
                config: `<system xmlns="${MOCK_NAMESPACE}"><hostname>after-resync</hostname></system>`
            },
            RPC_OPTIONS
        );
        const afterResyncChange = await waitFor(
            () =>
                notifications
                    .slice(afterResyncStart)
                    .find(
                        item => item.xml.includes('<push-change-update') && item.xml.includes(`<id>${onChangeId}</id>`)
                    ),
            'on-change update after resync was not delivered'
        );
        assert.match(afterResyncChange.xml, /<patch-id>0<\/patch-id>/u);
        assert.match(afterResyncChange.xml, /after-resync/u);
        await assert.rejects(
            subscriber.rpc(
                `<modify-subscription xmlns="${SN_NAMESPACE}" xmlns:yp="${YANG_PUSH_NAMESPACE}" ` +
                    `xmlns:ds="${DS_NAMESPACE}"><id>${onChangeId}</id>` +
                    '<yp:datastore>ds:operational</yp:datastore><yp:on-change>' +
                    '<yp:sync-on-start>false</yp:sync-on-start></yp:on-change></modify-subscription>',
                RPC_OPTIONS
            ),
            error => assertRpcError(error, 'invalid-value')
        );

        const interfaceChangeId = replySubscriptionId(
            await subscriber.rpc(
                datastoreSubscription(
                    '<yp:datastore-subtree-filter>' +
                        `<interfaces xmlns="${MOCK_NAMESPACE}"><interface/></interfaces>` +
                        '</yp:datastore-subtree-filter>',
                    '<yp:on-change><yp:dampening-period>20</yp:dampening-period>' +
                        '<yp:sync-on-start>true</yp:sync-on-start></yp:on-change>'
                ),
                RPC_OPTIONS
            )
        );
        await waitFor(
            () => notifications.find(item => isPushNotification(item, 'push-update', interfaceChangeId)),
            'interface on-change synchronization was not delivered'
        );
        const interfaceChurnStart = notifications.length;
        await subscriber.editConfig(
            {
                target: 'running',
                config:
                    `<interfaces xmlns="${MOCK_NAMESPACE}"><interface><name>push-test</name>` +
                    '<description>transient interface</description></interface></interfaces>'
            },
            RPC_OPTIONS
        );
        await subscriber.editConfig(
            {
                target: 'running',
                config:
                    `<interfaces xmlns="${MOCK_NAMESPACE}" xmlns:nc="${NETCONF_BASE_NAMESPACE}">` +
                    '<interface nc:operation="delete"><name>push-test</name></interface></interfaces>'
            },
            RPC_OPTIONS
        );
        const interfaceChurn = await waitFor(
            () =>
                notifications
                    .slice(interfaceChurnStart)
                    .find(
                        item =>
                            item.xml.includes('<push-change-update') &&
                            item.xml.includes(`<id>${interfaceChangeId}</id>`)
                    ),
            'interface create/delete churn was not delivered'
        );
        assert.match(
            interfaceChurn.xml,
            /<operation>create<\/operation><target>\/netnexus-mock-device:interfaces\/interface=push-test<\/target>/u
        );
        assert.match(interfaceChurn.xml, /<interface(?:\s[^>]*)?>[\s\S]*<name>push-test<\/name>/u);
        assert.match(
            interfaceChurn.xml,
            /<operation>delete<\/operation><target>\/netnexus-mock-device:interfaces\/interface=push-test<\/target><\/edit>/u
        );
        assert.equal((interfaceChurn.xml.match(/interface=push-test/gu) || []).length, 2);

        const anchorTimestamp = Date.now() + 180;
        const stopTimestamp = anchorTimestamp + 600;
        const anchoredStart = notifications.length;
        const anchoredId = replySubscriptionId(
            await subscriber.rpc(
                datastoreSubscription(
                    '<yp:datastore-subtree-filter>' +
                        `<state xmlns="${MOCK_NAMESPACE}"><datastore-revision/></state>` +
                        '</yp:datastore-subtree-filter>',
                    '<yp:periodic><yp:period>20</yp:period>' +
                        `<yp:anchor-time>${new Date(anchorTimestamp).toISOString()}</yp:anchor-time>` +
                        '</yp:periodic>'
                ).replace(
                    '</establish-subscription>',
                    `<stop-time>${new Date(stopTimestamp).toISOString()}</stop-time></establish-subscription>`
                ),
                RPC_OPTIONS
            )
        );
        await waitFor(
            () =>
                notifications.slice(anchoredStart).filter(item => isPushNotification(item, 'push-update', anchoredId))
                    .length >= 2,
            'anchored periodic updates were not delivered'
        );
        await delay(Math.max(0, stopTimestamp - Date.now() + 120));
        const anchoredUpdates = notifications
            .slice(anchoredStart)
            .filter(item => isPushNotification(item, 'push-update', anchoredId));
        assert(
            anchoredUpdates.length >= 2 && anchoredUpdates.length <= 3,
            `expected 2-3 anchored updates before stop-time, received ${anchoredUpdates.length}`
        );
        const anchoredEventTimes = anchoredUpdates.map(item => notificationEventTime(item.xml));
        assert(anchoredEventTimes.every(timestamp => timestamp >= anchorTimestamp - 20 && timestamp < stopTimestamp));
        for (let index = 1; index < anchoredEventTimes.length; index += 1) {
            assert(anchoredEventTimes[index] - anchoredEventTimes[index - 1] >= 140);
            assert(anchoredEventTimes[index] - anchoredEventTimes[index - 1] <= 300);
        }
        assert.equal(
            notifications
                .slice(anchoredStart)
                .some(
                    item => item.xml.includes('<subscription-completed') && item.xml.includes(`<id>${anchoredId}</id>`)
                ),
            false,
            'dynamic stop-time must not fabricate configured-only subscription-completed'
        );
        assert.equal(
            server
                .getStatus()
                .sessions.find(item => item.sessionId === session.sessionId)
                .dynamicSubscriptions.some(item => item.id === anchoredId),
            false
        );

        const streamMatches = notifications.filter(item => item.xml.includes('stream-match')).length;
        assert.equal(server.terminateSubscription(streamId, 'ietf-yang-push:unchanging-selection'), true);
        const terminatedState = await waitFor(
            () =>
                notifications.find(
                    item => item.xml.includes('<subscription-terminated') && item.xml.includes(`<id>${streamId}</id>`)
                ),
            'subscription-terminated was not delivered'
        );
        assert.match(
            terminatedState.xml,
            new RegExp(`<reason xmlns:yp="${YANG_PUSH_NAMESPACE}">yp:unchanging-selection</reason>`, 'u')
        );
        validateNotificationWithBundledYanglint(terminatedState.xml);
        server.notify('stream-match');
        await delay(60);
        assert.equal(notifications.filter(item => item.xml.includes('stream-match')).length, streamMatches);

        for (const id of [periodicId, operationalStateId, onChangeId, interfaceChangeId]) {
            assert.equal(
                (
                    await subscriber.rpc(
                        `<delete-subscription xmlns="${SN_NAMESPACE}"><id>${id}</id></delete-subscription>`,
                        RPC_OPTIONS
                    )
                ).ok,
                true
            );
        }
        assert.equal(
            server.getStatus().sessions.find(item => item.sessionId === session.sessionId).dynamicSubscriptions.length,
            0
        );

        const killedId = replySubscriptionId(
            await subscriber.rpc(streamSubscription('administrator-kill'), RPC_OPTIONS)
        );
        assert.equal(
            (
                await administrator.rpc(
                    `<kill-subscription xmlns="${SN_NAMESPACE}"><id>${killedId}</id></kill-subscription>`,
                    RPC_OPTIONS
                )
            ).ok,
            true
        );
        await waitFor(
            () =>
                notifications.find(
                    item => item.xml.includes('<subscription-terminated') && item.xml.includes(`<id>${killedId}</id>`)
                ),
            'kill-subscription did not send subscription-terminated'
        );

        console.log('RFC 8639/8640 and RFC 8641 real NETCONF-over-SSH mock tests passed');
    } finally {
        for (const client of clients) {
            if (client.connected) client.disconnect('modern NETCONF mock test cleanup');
        }
        await server.stop().catch(() => {});
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
