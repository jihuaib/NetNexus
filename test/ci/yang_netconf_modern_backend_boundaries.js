'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const NetconfWorkerService = require('../../electron/worker/yang/netconfWorker');
const {
    buildEstablishSubscription,
    buildModifySubscription,
    SUBSCRIBED_NOTIFICATIONS_NAMESPACE,
    YANG_PUSH_NAMESPACE,
    DATASTORES_NAMESPACE
} = require('../../electron/utils/netconf');
const { YANG_EVT_TYPES } = require('../../electron/const/yangConst');

const BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const NOTIFICATION_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:notification:1.0';
const VENDOR_NAMESPACE = 'urn:netnexus:test:modern-boundaries';
const FILTER_NAMESPACE = 'urn:netnexus:test:filter-content';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const FULL_CAPABILITIES = [
    'urn:ietf:params:netconf:base:1.1',
    'urn:ietf:params:netconf:capability:notification:1.0',
    'urn:ietf:params:netconf:capability:interleave:1.0',
    `${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}?module=ietf-subscribed-notifications&revision=2019-09-09&features=encode-xml,encode-json,xpath,subtree,replay,dscp,qos`,
    `${YANG_PUSH_NAMESPACE}?module=ietf-yang-push&revision=2019-09-09&features=on-change`
];

const profile = id => ({
    id,
    name: id,
    host: '192.0.2.91',
    port: 830,
    username: 'netconf',
    password: 'secret',
    authMethod: 'password',
    hostKeyPolicy: 'accept-new',
    autoReconnect: false
});

class FakePort extends EventEmitter {
    constructor() {
        super();
        this.messages = [];
    }

    postMessage(message) {
        this.messages.push(message);
    }
}

class BoundaryClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.connected = false;
        this.capabilities = options.capabilities || FULL_CAPABILITIES;
        this.subscriptionIds = [...(options.subscriptionIds || [10, 11, 99])];
        this.requests = [];
        this.sequence = 0;
        this.sessionId = options.sessionId || 'modern-boundary-session';
    }

    async connect() {
        this.connected = true;
        return this.sessionInfo();
    }

    sessionInfo() {
        return {
            sessionId: this.sessionId,
            baseVersion: '1.1',
            capabilities: [...this.capabilities]
        };
    }

    async rpc(fragment) {
        const messageId = String(this.requests.length + 1);
        const requestXml = /^\s*<(?:[A-Za-z_][\w.-]*:)?rpc\b/u.test(fragment)
            ? fragment
            : `<rpc xmlns="${BASE_NAMESPACE}" message-id="${messageId}">${fragment}</rpc>`;
        this.requests.push({ fragment, requestXml });
        const establishing = /<(?:[A-Za-z_][\w.-]*:)?establish-subscription\b/u.test(fragment);
        const subscriptionId = establishing ? this.subscriptionIds.shift() : null;
        assert.notEqual(subscriptionId, undefined, 'the fake client ran out of subscription ids');
        return {
            type: 'rpc-reply',
            requestXml,
            xml: establishing
                ? `<rpc-reply xmlns="${BASE_NAMESPACE}" message-id="${messageId}"><id xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}">${subscriptionId}</id></rpc-reply>`
                : `<rpc-reply xmlns="${BASE_NAMESPACE}" message-id="${messageId}"><ok/></rpc-reply>`,
            root: establishing ? { id: String(subscriptionId) } : { ok: '' },
            messageId,
            ok: !establishing,
            data: null,
            errors: [],
            transportSequence: ++this.sequence
        };
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

async function createService(id, options = {}) {
    const client = new BoundaryClient(options);
    const port = new FakePort();
    const service = new NetconfWorkerService(port, { clientFactory: () => client });
    const connection = profile(id);
    await service.connect(connection);
    return { client, service, connection, port };
}

function lastNotification(port) {
    return [...port.messages].reverse().find(message => message.eventName === YANG_EVT_TYPES.NOTIFICATION)?.data;
}

function vendorModuleSource() {
    return `module netnexus-modern-boundary-vendor {
  yang-version 1.1;
  namespace "${VENDOR_NAMESPACE}";
  prefix nbv;

  import ietf-datastores { prefix ds; }
  import ietf-subscribed-notifications { prefix sn; }

  identity archive-store { base ds:datastore; }

  container root {
    leaf value { type string; }
  }

  augment "/sn:delete-subscription/sn:input" {
    leaf id { type uint32; }
  }

  augment "/sn:subscription-modified" {
    leaf id { type uint32; }
  }
}
`;
}

function validateWithBundledYanglint(documents) {
    const workspaceRoot = path.resolve(__dirname, '../..');
    const runtimeRoot = path.join(workspaceRoot, 'resources', 'libyang', `${process.platform}-${process.arch}`);
    const executable = path.join(runtimeRoot, 'bin', process.platform === 'win32' ? 'yanglint.exe' : 'yanglint');
    if (!fs.existsSync(executable)) {
        console.log(`Bundled yanglint is not present for ${process.platform}-${process.arch}; schema cases skipped`);
        return false;
    }

    const moduleRoot = path.join(runtimeRoot, 'share', 'yang', 'modules', 'libyang');
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-modern-boundaries-'));
    const vendorModule = path.join(temporaryRoot, 'netnexus-modern-boundary-vendor.yang');
    fs.writeFileSync(vendorModule, vendorModuleSource(), 'utf8');
    try {
        for (const [index, xml] of documents.entries()) {
            const rpcPath = path.join(temporaryRoot, `rpc-${index + 1}.xml`);
            fs.writeFileSync(rpcPath, xml, 'utf8');
            const result = spawnSync(
                executable,
                [
                    '-I',
                    'xml',
                    '-t',
                    'nc-rpc',
                    '-p',
                    moduleRoot,
                    path.join(moduleRoot, 'ietf-datastores@2018-02-14.yang'),
                    path.join(moduleRoot, 'ietf-subscribed-notifications@2019-09-09.yang'),
                    path.join(moduleRoot, 'ietf-yang-push@2019-09-09.yang'),
                    vendorModule,
                    rpcPath
                ],
                { encoding: 'utf8' }
            );
            assert.equal(
                result.status,
                0,
                `bundled yanglint rejected boundary RPC ${index + 1}:\n${result.stderr || result.stdout}\n${xml}`
            );
        }
        return true;
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

function builderAndSchemaTests() {
    const noTrigger = buildEstablishSubscription({
        targetType: 'datastore',
        datastore: 'archive:archive-store',
        datastoreNamespaces: { archive: VENDOR_NAMESPACE },
        datastoreFilter: {
            type: 'xpath',
            select: '/yp:root',
            namespaces: { yp: VENDOR_NAMESPACE }
        },
        wrap: true,
        messageId: 'no-trigger'
    });
    assert.match(noTrigger, /<yp:datastore>archive:archive-store<\/yp:datastore>/u);
    assert.match(noTrigger, new RegExp(`xmlns:archive="${VENDOR_NAMESPACE}"`));
    assert.match(noTrigger, new RegExp(`<nyp:datastore-xpath-filter xmlns:yp="${VENDOR_NAMESPACE}"`));
    assert.doesNotMatch(noTrigger, /<yp:(?:periodic|on-change)>/u);

    const zeroValues = buildEstablishSubscription({
        targetType: 'datastore',
        datastore: 'operational',
        dscp: 0,
        weighting: 0,
        dependency: 0,
        updateTrigger: 'on-change',
        dampeningPeriod: 0,
        syncOnStart: false,
        wrap: true,
        messageId: 'zero-values'
    });
    for (const element of ['dscp', 'weighting', 'dependency']) {
        assert.match(zeroValues, new RegExp(`<${element}>0</${element}>`));
    }
    assert.match(zeroValues, /<yp:dampening-period>0<\/yp:dampening-period>/u);
    assert.match(zeroValues, /<yp:sync-on-start>false<\/yp:sync-on-start>/u);

    const defaultNamespaceCollision = buildEstablishSubscription({
        stream: 'NETCONF',
        streamFilter: {
            type: 'xpath',
            select: '/nbv:root',
            namespaces: { '': FILTER_NAMESPACE, nbv: VENDOR_NAMESPACE }
        },
        wrap: true,
        messageId: 'default-namespace-collision'
    });
    assert.match(defaultNamespaceCollision, new RegExp(`<nsn:stream-xpath-filter xmlns="${FILTER_NAMESPACE}"`));
    assert.match(defaultNamespaceCollision, new RegExp(`xmlns:nsn="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"`));

    const modify = buildModifySubscription({
        id: 0,
        targetType: 'datastore',
        datastore: 'archive:archive-store',
        datastoreNamespaces: { archive: VENDOR_NAMESPACE },
        datastoreFilter: {
            type: 'subtree',
            content: `<nbv:root xmlns:nbv="${VENDOR_NAMESPACE}"><nbv:value>schema</nbv:value></nbv:root>`
        },
        wrap: true,
        messageId: 'modify-zero-id'
    });
    assert.match(modify, /<id>0<\/id>/u);
    assert.doesNotMatch(modify, /<yp:(?:periodic|on-change)>/u);

    const vendorAugmentedDelete = `<rpc xmlns="${BASE_NAMESPACE}" message-id="vendor-id"><delete-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" xmlns:nbv="${VENDOR_NAMESPACE}"><nbv:id>99</nbv:id><id>10</id></delete-subscription></rpc>`;
    validateWithBundledYanglint([noTrigger, zeroValues, defaultNamespaceCollision, modify, vendorAugmentedDelete]);

    const orphanValues = {
        period: 0,
        anchorTime: '2026-07-19T00:00:00Z',
        dampeningPeriod: 0
    };
    for (const [field, value] of Object.entries(orphanValues)) {
        assert.throws(
            () =>
                buildEstablishSubscription({
                    targetType: 'datastore',
                    datastore: 'operational',
                    [field]: value
                }),
            /updateTrigger is required/u,
            `${field} must not be silently orphaned`
        );
    }

    const immutableValues = {
        syncOnStart: false,
        excludedChanges: ['move'],
        replayStartTime: '2026-07-18T00:00:00Z',
        dscp: 0,
        weighting: 0,
        dependency: 0,
        encoding: 'encode-xml'
    };
    for (const [field, value] of Object.entries(immutableValues)) {
        assert.throws(
            () =>
                buildModifySubscription({
                    id: 1,
                    targetType: 'datastore',
                    datastore: 'operational',
                    [field]: value
                }),
            /cannot be modified after a subscription is established/u,
            `${field} must be immutable for modify-subscription`
        );
    }
}

async function rawRoundTripAndOmissionTests() {
    const { client, service, connection } = await createService('raw-boundary-router');
    const rawOnChange = `<rpc xmlns="${BASE_NAMESPACE}" message-id="raw-on-change">
  <establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" xmlns:yp="${YANG_PUSH_NAMESPACE}" xmlns:store="${VENDOR_NAMESPACE}">
    <yp:datastore>store:archive-store</yp:datastore>
    <yp:datastore-xpath-filter xmlns:flt="${FILTER_NAMESPACE}">/flt:root</yp:datastore-xpath-filter>
    <stop-time>2026-07-21T00:00:00Z</stop-time>
    <dscp>0</dscp>
    <weighting>0</weighting>
    <dependency>0</dependency>
    <encoding>encode-xml</encoding>
    <yp:on-change>
      <yp:dampening-period>0</yp:dampening-period>
      <yp:sync-on-start>0</yp:sync-on-start>
      <yp:excluded-change>move</yp:excluded-change>
    </yp:on-change>
  </establish-subscription>
</rpc>`;
    const onChange = await service.sendRpc(connection.id, { rpc: rawOnChange });
    assert.equal(onChange.subscription.publisherSubscriptionId, '10');
    assert.equal(onChange.subscription.datastore, 'store:archive-store');
    assert.deepEqual(onChange.subscription.datastoreNamespaces, { store: VENDOR_NAMESPACE });
    assert.equal(onChange.subscription.filter.type, 'xpath');
    assert.equal(onChange.subscription.filter.select, '/flt:root');
    assert.equal(onChange.subscription.filter.namespaces.flt, FILTER_NAMESPACE);
    assert.equal(onChange.subscription.dscp, 0);
    assert.equal(onChange.subscription.weighting, 0);
    assert.equal(onChange.subscription.dependency, 0);
    assert.equal(onChange.subscription.dampeningPeriod, 0);
    assert.equal(onChange.subscription.syncOnStart, false);
    assert.deepEqual(onChange.subscription.excludedChanges, ['move']);

    const rawSubtree = `<rpc xmlns="${BASE_NAMESPACE}" message-id="raw-subtree">
  <establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" xmlns:yp="${YANG_PUSH_NAMESPACE}" xmlns:ds="${DATASTORES_NAMESPACE}">
    <yp:datastore>ds:operational</yp:datastore>
    <yp:datastore-subtree-filter xmlns="${FILTER_NAMESPACE}">
      <root><value>eth0 &amp; blue</value></root>
    </yp:datastore-subtree-filter>
  </establish-subscription>
</rpc>`;
    const subtree = await service.sendRpc(connection.id, { rpc: rawSubtree });
    assert.equal(subtree.subscription.publisherSubscriptionId, '11');
    assert.equal(subtree.subscription.datastore, 'operational');
    assert.deepEqual(subtree.subscription.datastoreNamespaces, {});
    assert.equal(subtree.subscription.filter.type, 'subtree');
    assert.equal(subtree.subscription.filter.namespaces[''], FILTER_NAMESPACE);
    assert.match(subtree.subscription.filter.content, /<root>/u);
    assert.match(subtree.subscription.filter.content, /eth0 &amp; blue/u);
    await service.executeOperation(connection.id, {
        operation: 'modify-subscription',
        subscriptionId: subtree.subscription.id,
        datastoreFilter: subtree.subscription.filter
    });
    assert.match(
        client.requests.at(-1).fragment,
        new RegExp(`<yp:datastore-subtree-filter xmlns="${FILTER_NAMESPACE}"`),
        'the inherited default namespace must survive raw parse and structured rebuild'
    );
    assert.match(client.requests.at(-1).fragment, /<root><value>eth0 &amp; blue<\/value><\/root>/u);

    const rawStream = `<rpc xmlns="${BASE_NAMESPACE}" message-id="raw-stream"><establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><stream>NETCONF</stream></establish-subscription></rpc>`;
    const stream = await service.sendRpc(connection.id, { rpc: rawStream });
    assert.equal(stream.subscription.publisherSubscriptionId, '99');

    const beforeOmission = service.subscriptions.get(onChange.subscription.id);
    const originalFilter = JSON.parse(JSON.stringify(beforeOmission.filter));
    const originalStopTime = beforeOmission.stopTime;
    const originalUpdateTrigger = beforeOmission.updateTrigger;
    const omitted = await service.executeOperation(connection.id, {
        operation: 'modify-subscription',
        subscriptionId: onChange.subscription.id,
        filter: { type: 'unchanged' },
        stopTime: null,
        updateTrigger: 'unchanged'
    });
    const omissionRpc = client.requests.at(-1).fragment;
    assert.match(omissionRpc, /<yp:datastore>store:archive-store<\/yp:datastore>/u);
    assert.match(omissionRpc, new RegExp(`xmlns:store="${VENDOR_NAMESPACE}"`));
    assert.doesNotMatch(omissionRpc, /(?:datastore|selection)-.+-filter|selection-filter-ref/u);
    assert.doesNotMatch(omissionRpc, /<stop-time>/u);
    assert.doesNotMatch(omissionRpc, /<yp:(?:periodic|on-change)>/u);
    assert.deepEqual(omitted.subscription.filter, originalFilter);
    assert.equal(omitted.subscription.stopTime, originalStopTime);
    assert.equal(omitted.subscription.updateTrigger, originalUpdateTrigger);

    await assert.rejects(
        service.executeOperation(connection.id, {
            operation: 'modify-subscription',
            subscriptionId: onChange.subscription.id,
            clearFilter: true
        }),
        error => error.code === 'NETCONF_SUBSCRIPTION_FILTER_CLEAR_UNSUPPORTED'
    );

    let requestsBeforeTargetChange = client.requests.length;
    await assert.rejects(
        service.executeOperation(connection.id, {
            operation: 'modify-subscription',
            subscriptionId: onChange.subscription.id,
            targetType: 'stream',
            streamFilter: { type: 'xpath', select: '/event' }
        }),
        error => error.code === 'NETCONF_SUBSCRIPTION_TARGET_CHANGE_UNSUPPORTED'
    );
    assert.equal(client.requests.length, requestsBeforeTargetChange);
    requestsBeforeTargetChange = client.requests.length;
    await assert.rejects(
        service.executeOperation(connection.id, {
            operation: 'modify-subscription',
            subscriptionId: stream.subscription.id,
            targetType: 'datastore',
            datastore: 'operational'
        }),
        error => error.code === 'NETCONF_SUBSCRIPTION_TARGET_CHANGE_UNSUPPORTED'
    );
    assert.equal(client.requests.length, requestsBeforeTargetChange);

    const activeResync = await service.executeOperation(connection.id, {
        operation: 'resync-subscription',
        subscriptionId: onChange.subscription.id
    });
    assert.ok(activeResync.subscription.lastResyncAt);

    emitNotification(
        client,
        `<subscription-suspended xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>10</id><reason>insufficient-resources</reason></subscription-suspended>`
    );
    const requestsBeforeSuspendedResync = client.requests.length;
    await assert.rejects(
        service.executeOperation(connection.id, {
            operation: 'resync-subscription',
            subscriptionId: onChange.subscription.id
        }),
        error => error.code === 'NETCONF_RESYNC_NOT_ALLOWED'
    );
    assert.equal(client.requests.length, requestsBeforeSuspendedResync, 'invalid resync must fail before client.rpc');
    emitNotification(
        client,
        `<subscription-resumed xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>10</id></subscription-resumed>`
    );

    await service.executeOperation(connection.id, {
        operation: 'modify-subscription',
        subscriptionId: onChange.subscription.id,
        updateTrigger: 'periodic',
        period: 0
    });
    const requestsBeforePeriodicResync = client.requests.length;
    await assert.rejects(
        service.executeOperation(connection.id, {
            operation: 'resync-subscription',
            subscriptionId: onChange.subscription.id
        }),
        error => error.code === 'NETCONF_RESYNC_NOT_ALLOWED'
    );
    assert.equal(client.requests.length, requestsBeforePeriodicResync, 'periodic resync must fail before client.rpc');

    const rawTargetChange = `<rpc xmlns="${BASE_NAMESPACE}" message-id="raw-target-change"><modify-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>11</id><stream-xpath-filter>/event</stream-xpath-filter></modify-subscription></rpc>`;
    const rawTargetChanged = await service.sendRpc(connection.id, { rpc: rawTargetChange });
    assert.equal(rawTargetChanged.subscription.publisherSubscriptionId, '11');
    assert.equal(rawTargetChanged.subscription.state, 'UNKNOWN');
    assert.equal(rawTargetChanged.subscription.desynchronized, true);
    assert.equal(rawTargetChanged.subscription.error.code, 'NETCONF_SUBSCRIPTION_POLICY_SNAPSHOT_PENDING');
    assert.equal(
        service.subscriptions.get(subtree.subscription.id).targetType,
        'datastore',
        'raw cross-target success must not guess the new local policy before a complete snapshot'
    );

    const vendorIdDelete = `<rpc xmlns="${BASE_NAMESPACE}" message-id="vendor-id-runtime"><delete-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" xmlns:nbv="${VENDOR_NAMESPACE}"><nbv:id>99</nbv:id><id>10</id></delete-subscription></rpc>`;
    const deleted = await service.sendRpc(connection.id, { rpc: vendorIdDelete });
    assert.equal(deleted.subscription.publisherSubscriptionId, '10');
    assert.equal(deleted.subscription.state, 'TERMINATED');
    assert.equal(service.subscriptions.get(stream.subscription.id).state, 'ACTIVE');

    await service.disconnect(connection.id);
}

async function featurePreflightTests() {
    const limitedCapabilities = [
        'urn:ietf:params:netconf:base:1.1',
        `${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}?module=ietf-subscribed-notifications&revision=2019-09-09&features=encode-xml`,
        `${YANG_PUSH_NAMESPACE}?module=ietf-yang-push&revision=2019-09-09`
    ];
    const limited = await createService('limited-feature-router', {
        capabilities: limitedCapabilities,
        subscriptionIds: [50]
    });
    await assert.rejects(
        limited.service.executeOperation(limited.connection.id, {
            operation: 'establish-subscription',
            stream: 'NETCONF',
            streamFilter: {
                type: 'xpath',
                select: '/nbv:root',
                namespaces: { nbv: VENDOR_NAMESPACE }
            }
        }),
        error => error.code === 'NETCONF_SUBSCRIPTION_FEATURE_NOT_SUPPORTED' && error.feature === 'xpath'
    );
    assert.equal(limited.client.requests.length, 0, 'unsupported XPath must fail before client.rpc');

    const rawOnChange = `<rpc xmlns="${BASE_NAMESPACE}" message-id="unsupported-on-change"><establish-subscription xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" xmlns:yp="${YANG_PUSH_NAMESPACE}" xmlns:ds="${DATASTORES_NAMESPACE}"><yp:datastore>ds:operational</yp:datastore><yp:on-change/></establish-subscription></rpc>`;
    await assert.rejects(
        limited.service.sendRpc(limited.connection.id, { rpc: rawOnChange }),
        error => error.code === 'NETCONF_SUBSCRIPTION_FEATURE_NOT_SUPPORTED' && error.feature === 'on-change'
    );
    assert.equal(limited.client.requests.length, 0, 'unsupported raw on-change must fail before client.rpc');

    const noYangPush = await createService('no-yang-push-router', {
        capabilities: [
            'urn:ietf:params:netconf:base:1.1',
            `${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}?module=ietf-subscribed-notifications&revision=2019-09-09&features=encode-xml`
        ],
        subscriptionIds: [60]
    });
    await assert.rejects(
        noYangPush.service.executeOperation(noYangPush.connection.id, {
            operation: 'establish-subscription',
            targetType: 'datastore',
            datastore: 'operational'
        }),
        error => error.code === 'NETCONF_YANG_PUSH_NOT_SUPPORTED'
    );
    assert.equal(noYangPush.client.requests.length, 0, 'missing ietf-yang-push must fail before client.rpc');

    await limited.service.disconnect(limited.connection.id);
    await noYangPush.service.disconnect(noYangPush.connection.id);
}

async function modifiedSnapshotTests() {
    const { client, service, connection, port } = await createService('snapshot-router', {
        subscriptionIds: [70]
    });
    const established = await service.executeOperation(connection.id, {
        operation: 'establish-subscription',
        targetType: 'datastore',
        datastore: 'operational',
        datastoreFilter: {
            type: 'xpath',
            select: '/old:root',
            namespaces: { old: 'urn:netnexus:test:old-filter' }
        },
        stopTime: '2026-07-20T00:00:00Z',
        dscp: 12,
        weighting: 7,
        dependency: 4,
        encoding: 'encode-xml',
        updateTrigger: 'periodic',
        period: 100
    });

    emitNotification(
        client,
        `<subscription-modified xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}" xmlns:yp="${YANG_PUSH_NAMESPACE}" xmlns:nbv="${VENDOR_NAMESPACE}" xmlns:store="${VENDOR_NAMESPACE}">
  <nbv:id>999</nbv:id>
  <id>70</id>
  <yp:datastore>store:archive-store</yp:datastore>
  <yp:datastore-subtree-filter xmlns:flt="${FILTER_NAMESPACE}"><flt:root><flt:value>snapshot</flt:value></flt:root></yp:datastore-subtree-filter>
  <stop-time>2026-07-22T00:00:00Z</stop-time>
  <dscp>0</dscp>
  <weighting>0</weighting>
  <dependency>0</dependency>
  <encoding>encode-xml</encoding>
  <yp:on-change>
    <yp:dampening-period>0</yp:dampening-period>
    <yp:sync-on-start>false</yp:sync-on-start>
    <yp:excluded-change>move</yp:excluded-change>
    <yp:excluded-change>replace</yp:excluded-change>
  </yp:on-change>
</subscription-modified>`
    );

    const snapshot = service.subscriptions.get(established.subscription.id);
    assert.equal(snapshot.state, 'ACTIVE');
    assert.equal(snapshot.targetType, 'datastore');
    assert.equal(snapshot.datastore, 'store:archive-store');
    assert.deepEqual(snapshot.datastoreNamespaces, { store: VENDOR_NAMESPACE });
    assert.equal(snapshot.filter.type, 'subtree');
    assert.equal(snapshot.filter.namespaces.flt, FILTER_NAMESPACE);
    assert.match(snapshot.filter.content, /<flt:value>snapshot<\/flt:value>/u);
    assert.equal(snapshot.stopTime, '2026-07-22T00:00:00Z');
    assert.equal(snapshot.dscp, 0);
    assert.equal(snapshot.weighting, 0);
    assert.equal(snapshot.dependency, 0);
    assert.equal(snapshot.encoding, 'encode-xml');
    assert.equal(snapshot.updateTrigger, 'on-change');
    assert.equal(snapshot.period, null);
    assert.equal(snapshot.anchorTime, null);
    assert.equal(snapshot.dampeningPeriod, 0);
    assert.equal(snapshot.syncOnStart, false);
    assert.deepEqual(snapshot.excludedChanges, ['move', 'replace']);
    assert.ok(snapshot.modifiedNotificationAt);
    assert.match(snapshot.modifiedNotificationXml, /subscription-modified/u);
    assert.equal(snapshot.desynchronized, false);

    const resynced = await service.executeOperation(connection.id, {
        operation: 'resync-subscription',
        subscriptionId: established.subscription.id
    });
    assert.ok(resynced.subscription.lastResyncAt, 'the complete snapshot must update tracked resync eligibility');

    emitNotification(
        client,
        `<subscription-suspended xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><reason>insufficient-resources</reason></subscription-suspended>`
    );
    assert.equal(service.subscriptions.get(established.subscription.id).state, 'ACTIVE');
    assert.equal(lastNotification(port).subscriptionId, null, 'a standard modern event with no id must not fallback');

    emitNotification(
        client,
        `<subscription-suspended xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>not-a-uint</id><reason>insufficient-resources</reason></subscription-suspended>`
    );
    assert.equal(service.subscriptions.get(established.subscription.id).state, 'ACTIVE');
    assert.equal(lastNotification(port).subscriptionId, null, 'an invalid standard id must not fallback');
    assert.equal(lastNotification(port).subscriptionParameterError.code, 'NETCONF_INVALID_SUBSCRIPTION_RPC');

    emitNotification(client, `<vendor-alert xmlns="${VENDOR_NAMESPACE}"><message>generic</message></vendor-alert>`);
    assert.equal(
        lastNotification(port).subscriptionId,
        null,
        'a sole datastore subscription must not claim a generic notification without an id'
    );
    emitNotification(
        client,
        `<subscription-suspended xmlns="${VENDOR_NAMESPACE}"><reason>vendor</reason></subscription-suspended>`
    );
    assert.equal(
        lastNotification(port).subscriptionId,
        null,
        'a vendor lifecycle lookalike without an id must not claim a sole datastore subscription'
    );

    const wrongEnvelopeXml = `<notification xmlns="${VENDOR_NAMESPACE}"><eventTime>2026-07-19T00:00:00Z</eventTime><subscription-terminated xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>70</id><reason>vendor-envelope</reason></subscription-terminated></notification>`;
    client.emit('notification', {
        eventTime: '2026-07-19T00:00:00Z',
        xml: wrongEnvelopeXml,
        document: {},
        root: {},
        transportSequence: ++client.sequence
    });
    assert.equal(
        service.subscriptions.get(established.subscription.id).state,
        'ACTIVE',
        'a non-NETCONF notification envelope must never drive lifecycle state'
    );

    emitNotification(
        client,
        `<subscription-modified xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>70</id><stop-time>2026-07-23T00:00:00Z</stop-time></subscription-modified>`
    );
    const malformedSnapshot = service.subscriptions.get(established.subscription.id);
    assert.equal(malformedSnapshot.state, 'UNKNOWN');
    assert.equal(malformedSnapshot.desynchronized, true);
    assert.equal(malformedSnapshot.desynchronizationReason, 'invalid-subscription-modified-notification');
    await service.disconnect(connection.id);
}

async function stopTimeLifecycleTests() {
    const { service, connection } = await createService('stop-time-router', {
        subscriptionIds: [80]
    });
    const established = await service.executeOperation(connection.id, {
        operation: 'establish-subscription',
        stream: 'NETCONF',
        streamFilter: { type: 'xpath', select: '/event' },
        stopTime: new Date(Date.now() + 5_000).toISOString()
    });
    const revisedStopTime = new Date(Date.now() + 80).toISOString();
    const modified = await service.executeOperation(connection.id, {
        operation: 'modify-subscription',
        subscriptionId: established.subscription.id,
        stopTime: revisedStopTime
    });
    assert.equal(modified.subscription.state, 'ACTIVE');
    assert.equal(modified.subscription.stopTime, revisedStopTime);
    await delay(180);
    const expired = service
        .getSubscriptions(connection.id)
        .subscriptions.find(subscription => subscription.id === established.subscription.id);
    assert.equal(expired.state, 'TERMINATED');
    assert.equal(expired.terminationReason, 'stop-time');
    await service.disconnect(connection.id);
}

async function mixedNotificationAssociationTests() {
    const { client, service, connection, port } = await createService('mixed-association-router', {
        subscriptionIds: [90, 91, 92]
    });
    const firstStream = await service.executeOperation(connection.id, {
        operation: 'establish-subscription',
        stream: 'NETCONF'
    });
    const datastore = await service.executeOperation(connection.id, {
        operation: 'establish-subscription',
        targetType: 'datastore',
        datastore: 'operational'
    });
    emitNotification(client, `<vendor-event xmlns="${VENDOR_NAMESPACE}"><message>stream-one</message></vendor-event>`);
    assert.equal(lastNotification(port).subscriptionId, firstStream.subscription.id);
    assert.deepEqual(lastNotification(port).candidateSubscriptionIds, []);

    const secondStream = await service.executeOperation(connection.id, {
        operation: 'establish-subscription',
        stream: 'NETCONF'
    });
    emitNotification(client, `<vendor-event xmlns="${VENDOR_NAMESPACE}"><message>ambiguous</message></vendor-event>`);
    assert.equal(lastNotification(port).subscriptionId, null);
    assert.deepEqual(
        [...lastNotification(port).candidateSubscriptionIds].sort(),
        [firstStream.subscription.id, secondStream.subscription.id].sort(),
        'generic notification candidates must contain only event-stream subscriptions'
    );
    assert.ok(!lastNotification(port).candidateSubscriptionIds.includes(datastore.subscription.id));
    await service.disconnect(connection.id);
}

async function unknownStopTimeTests() {
    const { client, service, connection } = await createService('unknown-stop-time-router', {
        subscriptionIds: [100, 101]
    });
    const malformedSnapshotSubscription = await service.executeOperation(connection.id, {
        operation: 'establish-subscription',
        stream: 'NETCONF',
        stopTime: new Date(Date.now() + 180).toISOString()
    });
    assert.ok(service.subscriptionStopTimers.has(malformedSnapshotSubscription.subscription.id));
    emitNotification(
        client,
        `<subscription-modified xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>100</id><stop-time>${new Date(
            Date.now() + 180
        ).toISOString()}</stop-time></subscription-modified>`
    );
    assert.equal(service.subscriptions.get(malformedSnapshotSubscription.subscription.id).state, 'UNKNOWN');
    assert.ok(!service.subscriptionStopTimers.has(malformedSnapshotSubscription.subscription.id));
    await delay(260);
    assert.equal(
        service
            .getSubscriptions(connection.id)
            .subscriptions.find(subscription => subscription.id === malformedSnapshotSubscription.subscription.id)
            .state,
        'UNKNOWN',
        'an UNKNOWN subscription must not terminate from a possibly stale stop-time'
    );

    const restoredStopTime = new Date(Date.now() + 100).toISOString();
    emitNotification(
        client,
        `<subscription-modified xmlns="${SUBSCRIBED_NOTIFICATIONS_NAMESPACE}"><id>100</id><stream>NETCONF</stream><stop-time>${restoredStopTime}</stop-time></subscription-modified>`
    );
    assert.equal(service.subscriptions.get(malformedSnapshotSubscription.subscription.id).state, 'ACTIVE');
    assert.ok(service.subscriptionStopTimers.has(malformedSnapshotSubscription.subscription.id));
    await delay(180);
    assert.equal(service.subscriptions.get(malformedSnapshotSubscription.subscription.id).state, 'TERMINATED');
    assert.equal(
        service.subscriptions.get(malformedSnapshotSubscription.subscription.id).terminationReason,
        'stop-time'
    );

    const timeoutSubscription = await service.executeOperation(connection.id, {
        operation: 'establish-subscription',
        stream: 'NETCONF',
        stopTime: new Date(Date.now() + 100).toISOString()
    });
    const entry = service.sessions.get(connection.id);
    service.markSubscriptionUnknown(
        entry,
        service.subscriptions.get(timeoutSubscription.subscription.id),
        'modify-subscription',
        Object.assign(new Error('timeout'), { code: 'NETCONF_RPC_TIMEOUT' })
    );
    assert.ok(!service.subscriptionStopTimers.has(timeoutSubscription.subscription.id));
    await delay(180);
    assert.equal(
        service
            .getSubscriptions(connection.id)
            .subscriptions.find(subscription => subscription.id === timeoutSubscription.subscription.id).state,
        'UNKNOWN'
    );
    await service.disconnect(connection.id);
}

async function main() {
    assert.equal(DATASTORES_NAMESPACE, 'urn:ietf:params:xml:ns:yang:ietf-datastores');
    builderAndSchemaTests();
    await rawRoundTripAndOmissionTests();
    await featurePreflightTests();
    await modifiedSnapshotTests();
    await stopTimeLifecycleTests();
    await mixedNotificationAssociationTests();
    await unknownStopTimeTests();
    console.log('Modern subscription builder/worker RFC boundary tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
