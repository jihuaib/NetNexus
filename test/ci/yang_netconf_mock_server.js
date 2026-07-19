'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NetconfClient, NetconfRpcError } = require('../../electron/utils/netconf');
const { YangRegistry } = require('../../electron/utils/yang');
const NetconfWorkerService = require('../../electron/worker/yang/netconfWorker');
const { YANG_EVT_TYPES } = require('../../electron/const/yangConst');
const {
    MOCK_DEVICE_YANG,
    MOCK_INVALID_YANG,
    MOCK_TYPES_YANG,
    MockNetconfServer,
    parseArgs
} = require('../../scripts/mockNetconfServer');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_PROJECT_ROOT = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || PROJECT_ROOT);
const RPC_OPTIONS = Object.freeze({ timeout: 5_000 });
const MOCK_DEVICE_NAMESPACE = 'urn:netnexus:params:xml:ns:yang:mock-device';

function waitFor(predicate, message, timeoutMs = 3_000) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const check = () => {
            let result;
            try {
                result = predicate();
            } catch (error) {
                reject(error);
                return;
            }
            if (result) {
                resolve(result);
                return;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                reject(new Error(message));
                return;
            }
            setTimeout(check, 20);
        };
        check();
    });
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function createClient() {
    return new NetconfClient({
        helloTimeout: 5_000,
        rpcTimeout: 5_000,
        maxMessageSize: 8 * 1024 * 1024
    });
}

function connectionProfile(status, password = 'netconf') {
    return {
        host: status.host,
        port: status.port,
        username: status.username,
        password,
        hostKeyFingerprint: status.fingerprint,
        readyTimeout: 5_000,
        keepaliveInterval: 0,
        keepaliveCountMax: 3
    };
}

function assertRpcError(error, tag) {
    assert(error instanceof NetconfRpcError, `expected NetconfRpcError, received ${error?.name || error}`);
    assert.equal(error.code, 'NETCONF_RPC_ERROR');
    assert.equal(error.errors[0]?.tag, tag);
    assert(error.messageId);
    assert.match(error.replyXml, /<rpc-error>/u);
    return true;
}

async function compileDownloadedModules(tempRoot, deviceSource, typesSource) {
    assert.equal(deviceSource.trim(), MOCK_DEVICE_YANG.trim());
    assert.equal(typesSource.trim(), MOCK_TYPES_YANG.trim());

    const registry = new YangRegistry({
        rootDir: path.join(tempRoot, 'repository'),
        resourcesPath: path.join(SOURCE_PROJECT_ROOT, 'resources'),
        isPackaged: false
    });
    const compilerStatus = await registry.getCompilerStatus({ forceRuntimeDiscovery: true });
    assert.equal(compilerStatus.available, true, compilerStatus.error || compilerStatus.message);
    assert.equal(compilerStatus.engine, 'libyang');
    assert.equal(compilerStatus.source, 'bundled');

    registry.importContents([
        {
            content: typesSource,
            expectedName: 'netnexus-mock-types',
            fileName: 'netnexus-mock-types@2026-07-18.yang'
        },
        {
            content: deviceSource,
            expectedName: 'netnexus-mock-device',
            fileName: 'netnexus-mock-device@2026-07-18.yang'
        }
    ]);
    const compiled = await registry.compile({
        features: ['netnexus-mock-device:interface-counters'],
        force: true
    });
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics, null, 2));
    assert.equal(compiled.validation.engine, 'libyang');
    assert.equal(compiled.externalCompiler.exitCode, 0);
}

async function compileInvalidDownloadedModule(tempRoot, deviceSource, typesSource, invalidSource) {
    assert.equal(invalidSource.trim(), MOCK_INVALID_YANG.trim());
    const registry = new YangRegistry({
        rootDir: path.join(tempRoot, 'invalid-repository'),
        resourcesPath: path.join(SOURCE_PROJECT_ROOT, 'resources'),
        isPackaged: false
    });
    const imported = registry.importContents([
        {
            content: typesSource,
            expectedName: 'netnexus-mock-types',
            fileName: 'netnexus-mock-types@2026-07-18.yang'
        },
        {
            content: deviceSource,
            expectedName: 'netnexus-mock-device',
            fileName: 'netnexus-mock-device@2026-07-18.yang'
        },
        {
            content: invalidSource,
            expectedName: 'netnexus-mock-invalid',
            fileName: 'netnexus-mock-invalid@2026-07-18.yang'
        }
    ]);
    assert.equal(imported.summary.imported, 3);
    assert.equal(imported.summary.invalid, 0, 'the mock file must download cleanly before libyang compilation');

    const compiled = await registry.compile({
        force: true,
        features: ['netnexus-mock-device:interface-counters']
    });
    assert.equal(compiled.success, false);
    assert.equal(compiled.externalCompiler.exitCode, 1);
    assert.equal(compiled.schemaAvailable, true);
    assert.equal(compiled.partialSchema, true);
    assert.equal(compiled.schemaTree.partial, true);
    assert.equal(compiled.schemaCompiler.succeeded, true);
    assert.deepEqual(Object.fromEntries(compiled.fileResults.map(result => [result.name, result.status])), {
        'netnexus-mock-device': 'compiled',
        'netnexus-mock-invalid': 'failed',
        'netnexus-mock-types': 'compiled'
    });
    assert.deepEqual(
        registry
            .getSchemaRoots({ compileId: compiled.compileId })
            .map(root => root.name)
            .sort(),
        ['netnexus-mock-device', 'netnexus-mock-types']
    );
    assert.equal(
        compiled.schemaCompiler.args.some(argument => /netnexus-mock-invalid/u.test(argument)),
        false
    );
    assert(
        compiled.diagnostics.some(
            diagnostic =>
                diagnostic.severity === 'error' &&
                /intentionally-undefined-type|Referenced type/u.test(diagnostic.message)
        ),
        JSON.stringify(compiled.diagnostics, null, 2)
    );
}

async function run() {
    const defaults = parseArgs([], {});
    assert.equal(defaults.host, '127.0.0.1');
    assert.equal(defaults.port, 8830);
    assert.equal(defaults.username, 'netconf');
    assert.throws(() => parseArgs(['--host', '0.0.0.0'], {}), /--allow-remote/u);
    assert.equal(parseArgs(['--host', '0.0.0.0', '--allow-remote'], {}).host, '0.0.0.0');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-netconf-mock-'));
    const server = new MockNetconfServer({ port: 0, quiet: true });
    const pageWorkerMessages = [];
    const pageWorker = new NetconfWorkerService({
        on() {},
        postMessage(message) {
            pageWorkerMessages.push(message);
        }
    });
    const clients = [];

    try {
        const status = await server.start();
        assert.equal(status.running, true);
        assert.equal(status.host, '127.0.0.1');
        assert(status.port > 0);
        assert.match(status.fingerprint, /^SHA256:/u);

        const pageProfile = {
            id: 'local-netconf-mock',
            name: 'Local NETCONF Mock',
            host: status.host,
            port: status.port,
            username: status.username,
            password: 'netconf',
            authMethod: 'password',
            hostKeyPolicy: 'accept-new',
            hostKeyFingerprint: '',
            connectTimeout: 5_000,
            rpcTimeout: 5_000,
            keepaliveInterval: 0,
            keepaliveCountMax: 3,
            autoReconnect: false
        };
        const testedProfile = await pageWorker.testConnection(pageProfile);
        assert.equal(testedProfile.connected, true);
        assert.equal(testedProfile.baseVersion, '1.1');
        assert.equal(testedProfile.hostKeyFingerprint, status.fingerprint);

        const pageConnection = await pageWorker.connect({
            ...pageProfile,
            hostKeyPolicy: 'strict',
            hostKeyFingerprint: testedProfile.hostKeyFingerprint
        });
        assert.equal(pageConnection.connected, true);
        assert.equal(pageConnection.hostKeyFingerprint, status.fingerprint);
        const pageInventory = await pageWorker.discoverModules(pageProfile.id);
        assert.equal(pageInventory.source, 'rfc8525');
        assert.deepEqual(pageInventory.modules.map(module => module.name).sort(), [
            'netnexus-mock-device',
            'netnexus-mock-invalid',
            'netnexus-mock-types'
        ]);
        const pageSchema = await pageWorker.getSchema(pageProfile.id, {
            name: 'netnexus-mock-device',
            revision: '2026-07-18'
        });
        assert(pageSchema.dependencies.some(dependency => dependency.name === 'netnexus-mock-types'));
        const pageGetConfig = await pageWorker.executeOperation(pageProfile.id, {
            operation: 'get-config',
            source: 'running',
            timeout: RPC_OPTIONS.timeout
        });
        assert.equal(pageGetConfig.ok, false);
        assert.match(pageGetConfig.xml, /<hostname>netnexus-mock<\/hostname>/u);

        const pageSubscriptionReply = await pageWorker.executeOperation(pageProfile.id, {
            operation: 'create-subscription',
            stream: 'NETCONF',
            filter: {
                type: 'subtree',
                content:
                    `<mock-event xmlns="${MOCK_DEVICE_NAMESPACE}">` +
                    '<message>page-worker-notification</message></mock-event>'
            },
            timeout: RPC_OPTIONS.timeout
        });
        assert.equal(pageSubscriptionReply.ok, true);
        assert.equal(pageSubscriptionReply.subscription.state, 'ACTIVE');
        assert.equal(pageSubscriptionReply.subscription.profileId, pageProfile.id);
        assert.equal(pageSubscriptionReply.subscription.sessionId, pageConnection.sessionId);
        assert.doesNotMatch(pageSubscriptionReply.reply, /<notification(?:\s|>)/u);
        assert(
            pageWorkerMessages.some(
                message =>
                    message.eventName === YANG_EVT_TYPES.SUBSCRIPTION_EVENT &&
                    message.data.id === pageSubscriptionReply.subscription.id &&
                    message.data.state === 'ACTIVE'
            ),
            'the page Worker must publish an active subscription event for notification history'
        );

        server.notify('page-worker-filter-miss');
        await delay(100);
        assert.equal(
            pageWorkerMessages.some(
                message =>
                    message.eventName === YANG_EVT_TYPES.NOTIFICATION &&
                    message.data.xml.includes('page-worker-filter-miss')
            ),
            false,
            'the real SSH Worker path must preserve server-side notification filtering'
        );
        server.notify('page-worker-notification');
        const pageNotificationEvent = await waitFor(
            () =>
                pageWorkerMessages.find(
                    message =>
                        message.eventName === YANG_EVT_TYPES.NOTIFICATION &&
                        message.data.xml.includes('page-worker-notification')
                ),
            'the real SSH notification did not reach the page Worker event stream'
        );
        assert.equal(pageNotificationEvent.data.profileId, pageProfile.id);
        assert.equal(pageNotificationEvent.data.sessionId, pageConnection.sessionId);
        assert.equal(pageNotificationEvent.data.subscriptionId, pageSubscriptionReply.subscription.id);
        assert.equal(pageNotificationEvent.data.state, 'ACTIVE');
        assert.equal(pageNotificationEvent.data.eventName, 'mock-event');
        assert.equal(pageNotificationEvent.data.namespace, MOCK_DEVICE_NAMESPACE);
        assert.match(pageNotificationEvent.data.xml, /^<notification\b/u);
        const pageSubscriptions = pageWorker.getSubscriptions(pageProfile.id);
        assert.equal(pageSubscriptions.activeCount, 1);
        assert.equal(pageSubscriptions.subscriptions[0].id, pageSubscriptionReply.subscription.id);

        await pageWorker.disconnectAll();
        assert(
            pageWorkerMessages.some(
                message =>
                    message.eventName === YANG_EVT_TYPES.SUBSCRIPTION_EVENT &&
                    message.data.id === pageSubscriptionReply.subscription.id &&
                    message.data.state === 'TERMINATED' &&
                    message.data.terminationReason === 'application-close'
            ),
            'disconnecting the page Worker must publish the terminated subscription for notification history'
        );

        const rejectedClient = createClient();
        clients.push(rejectedClient);
        await assert.rejects(rejectedClient.connect(connectionProfile(status, 'wrong-password')), error => {
            assert.equal(error.code, 'NETCONF_SSH_CONNECT_FAILED');
            assert.match(error.message, /authentication methods failed|authentication failure/iu);
            return true;
        });
        assert.equal(rejectedClient.connected, false);
        assert(server.logs.some(record => record.event === 'auth-reject' && record.method === 'password'));

        const primary = createClient();
        clients.push(primary);
        const primarySession = await primary.connect(connectionProfile(status));
        assert.equal(primarySession.baseVersion, '1.1');
        assert(primarySession.sessionId);
        assert(primarySession.capabilities.includes('urn:ietf:params:netconf:base:1.1'));
        assert(primarySession.capabilities.includes('urn:ietf:params:netconf:capability:notification:1.0'));
        assert(primarySession.capabilities.includes('urn:ietf:params:netconf:capability:interleave:1.0'));
        assert(primarySession.capabilities.includes('urn:ietf:params:netconf:capability:xpath:1.0'));
        assert(primarySession.capabilities.some(capability => capability.includes(':candidate:')));
        assert(primarySession.capabilities.some(capability => capability.includes('yang-library')));

        const inventory = await primary.discoverSchemas(RPC_OPTIONS);
        assert.equal(inventory.source, 'rfc8525');
        assert.equal(inventory.modules.length, 3);
        const deviceModule = inventory.modules.find(module => module.name === 'netnexus-mock-device');
        const invalidModule = inventory.modules.find(module => module.name === 'netnexus-mock-invalid');
        const typesModule = inventory.modules.find(module => module.name === 'netnexus-mock-types');
        assert(deviceModule);
        assert(invalidModule);
        assert(typesModule);
        assert.equal(deviceModule.revision, '2026-07-18');
        assert.equal(deviceModule.implemented, true);
        assert.equal(invalidModule.implemented, true);
        assert.equal(typesModule.conformanceType, 'import');

        const deviceSchema = await primary.getSchema({
            identifier: deviceModule.name,
            version: deviceModule.revision,
            format: 'yang',
            timeout: RPC_OPTIONS.timeout
        });
        const typesSchema = await primary.getSchema({
            identifier: typesModule.name,
            version: typesModule.revision,
            format: 'yang',
            timeout: RPC_OPTIONS.timeout
        });
        const invalidSchema = await primary.getSchema({
            identifier: invalidModule.name,
            version: invalidModule.revision,
            format: 'yang',
            timeout: RPC_OPTIONS.timeout
        });
        assert.match(deviceSchema.content, /^module netnexus-mock-device/u);
        assert.match(deviceSchema.content, /import netnexus-mock-types/u);
        assert.match(typesSchema.content, /^module netnexus-mock-types/u);
        assert.match(invalidSchema.content, /^module netnexus-mock-invalid/u);
        await compileDownloadedModules(tempRoot, deviceSchema.content, typesSchema.content);
        await compileInvalidDownloadedModule(
            tempRoot,
            deviceSchema.content,
            typesSchema.content,
            invalidSchema.content
        );

        const initialRunning = await primary.getConfig({ source: 'running' }, RPC_OPTIONS);
        assert.match(initialRunning.xml, /<hostname>netnexus-mock<\/hostname>/u);

        const sessionCountOnly = await primary.get(
            {
                filter: {
                    type: 'subtree',
                    content: `<state xmlns="${MOCK_DEVICE_NAMESPACE}"><session-count/></state>`
                }
            },
            RPC_OPTIONS
        );
        assert.match(
            sessionCountOnly.xml,
            new RegExp(`<state xmlns="${MOCK_DEVICE_NAMESPACE}"><session-count>\\d+</session-count></state>`, 'u')
        );
        assert.doesNotMatch(sessionCountOnly.xml, /<(?:uptime|datastore-revision|last-operation)>/u);
        assert.doesNotMatch(sessionCountOnly.xml, /<(?:system|interfaces)(?:\s|>)/u);
        assert.doesNotMatch(sessionCountOnly.xml, /<(?:yang-library|modules-state|netconf-state)(?:\s|>)/u);

        const hostnameOnly = await primary.getConfig(
            {
                source: 'running',
                filter: {
                    type: 'subtree',
                    content: `<system xmlns="${MOCK_DEVICE_NAMESPACE}"><hostname/></system>`
                }
            },
            RPC_OPTIONS
        );
        assert.match(
            hostnameOnly.xml,
            new RegExp(`<system xmlns="${MOCK_DEVICE_NAMESPACE}"><hostname>netnexus-mock</hostname></system>`, 'u')
        );
        assert.doesNotMatch(hostnameOnly.xml, /<(?:location|contact)>/u);
        assert.doesNotMatch(hostnameOnly.xml, /<(?:interfaces|state)(?:\s|>)/u);

        const selectedInterfaceLeaf = await primary.getConfig(
            {
                source: 'running',
                filter: {
                    type: 'subtree',
                    content:
                        `<interfaces xmlns="${MOCK_DEVICE_NAMESPACE}"><interface>` +
                        '<name>loopback0</name><enabled/></interface></interfaces>'
                }
            },
            RPC_OPTIONS
        );
        assert.match(
            selectedInterfaceLeaf.xml,
            new RegExp(
                `<interfaces xmlns="${MOCK_DEVICE_NAMESPACE}"><interface>` +
                    '<name>loopback0</name><enabled>true</enabled></interface></interfaces>',
                'u'
            )
        );
        assert.equal((selectedInterfaceLeaf.xml.match(/<interface>/gu) || []).length, 1);
        assert.doesNotMatch(selectedInterfaceLeaf.xml, /<name>eth0<\/name>/u);
        assert.doesNotMatch(selectedInterfaceLeaf.xml, /<(?:description|mtu|oper-status|packets)>/u);

        const unmatchedInterface = await primary.getConfig(
            {
                source: 'running',
                filter: {
                    type: 'subtree',
                    content:
                        `<interfaces xmlns="${MOCK_DEVICE_NAMESPACE}"><interface>` +
                        '<name>missing0</name><enabled/></interface></interfaces>'
                }
            },
            RPC_OPTIONS
        );
        assert.match(unmatchedInterface.xml, /<data(?:\s[^>]*)?(?:\/>|>\s*<\/data>)/u);
        assert.doesNotMatch(unmatchedInterface.xml, /<(?:system|interfaces|state)(?:\s|>)/u);

        const candidateConfig =
            '<system xmlns="urn:netnexus:params:xml:ns:yang:mock-device">' +
            '<hostname>candidate-committed</hostname><location>integration-lab</location>' +
            '</system>';
        const editReply = await primary.editConfig(
            {
                target: 'candidate',
                defaultOperation: 'merge',
                testOption: 'test-then-set',
                errorOption: 'stop-on-error',
                config: candidateConfig
            },
            RPC_OPTIONS
        );
        assert.equal(editReply.ok, true);
        const editedCandidate = await primary.getConfig({ source: 'candidate' }, RPC_OPTIONS);
        const uncommittedRunning = await primary.getConfig({ source: 'running' }, RPC_OPTIONS);
        assert.match(editedCandidate.xml, /<hostname>candidate-committed<\/hostname>/u);
        assert.match(uncommittedRunning.xml, /<hostname>netnexus-mock<\/hostname>/u);

        const validateReply = await primary.validate({ source: 'candidate' }, RPC_OPTIONS);
        assert.equal(validateReply.ok, true);
        const commitReply = await primary.commit({}, RPC_OPTIONS);
        assert.equal(commitReply.ok, true);
        const committedRunning = await primary.getConfig({ source: 'running' }, RPC_OPTIONS);
        assert.match(committedRunning.xml, /<hostname>candidate-committed<\/hostname>/u);

        await primary.editConfig(
            {
                target: 'candidate',
                config:
                    '<system xmlns="urn:netnexus:params:xml:ns:yang:mock-device">' +
                    '<hostname>candidate-discarded</hostname></system>'
            },
            RPC_OPTIONS
        );
        assert.match(
            (await primary.getConfig({ source: 'candidate' }, RPC_OPTIONS)).xml,
            /<hostname>candidate-discarded<\/hostname>/u
        );
        const discardReply = await primary.discardChanges(RPC_OPTIONS);
        assert.equal(discardReply.ok, true);
        assert.match(
            (await primary.getConfig({ source: 'candidate' }, RPC_OPTIONS)).xml,
            /<hostname>candidate-committed<\/hostname>/u
        );

        const secondary = createClient();
        clients.push(secondary);
        const secondarySession = await secondary.connect(connectionProfile(status));
        assert.equal(secondarySession.baseVersion, '1.1');
        assert.notEqual(secondarySession.sessionId, primarySession.sessionId);

        assert.equal((await primary.lock({ target: 'candidate' }, RPC_OPTIONS)).ok, true);
        await assert.rejects(secondary.lock({ target: 'candidate' }, RPC_OPTIONS), error =>
            assertRpcError(error, 'lock-denied')
        );
        assert.equal(server.getStatus().locks.candidate, primarySession.sessionId);
        assert.equal((await primary.unlock({ target: 'candidate' }, RPC_OPTIONS)).ok, true);
        assert.equal((await secondary.lock({ target: 'candidate' }, RPC_OPTIONS)).ok, true);
        assert.equal((await secondary.unlock({ target: 'candidate' }, RPC_OPTIONS)).ok, true);

        await assert.rejects(primary.rpc('<unsupported-operation/>', RPC_OPTIONS), error =>
            assertRpcError(error, 'operation-not-supported')
        );

        await assert.rejects(secondary.rpc('<create-subscription/>', RPC_OPTIONS), error =>
            assertRpcError(error, 'unknown-namespace')
        );
        await assert.rejects(secondary.createSubscription({ stream: 'UNKNOWN' }, RPC_OPTIONS), error =>
            assertRpcError(error, 'invalid-value')
        );
        await assert.rejects(
            secondary.createSubscription({ stopTime: new Date(Date.now() + 5_000).toISOString() }, RPC_OPTIONS),
            error => assertRpcError(error, 'invalid-value')
        );

        const notifications = [];
        primary.on('notification', notification => notifications.push(notification));
        const subscriptionReply = await primary.createSubscription(
            {
                stream: 'NETCONF',
                filter: {
                    type: 'subtree',
                    content:
                        `<mock-event xmlns="${MOCK_DEVICE_NAMESPACE}">` +
                        '<message>integration-test-notification</message></mock-event>'
                }
            },
            RPC_OPTIONS
        );
        assert.equal(subscriptionReply.ok, true);
        assert.equal(
            server.getStatus().sessions.find(session => session.sessionId === primarySession.sessionId)?.subscribed,
            true
        );
        await assert.rejects(primary.createSubscription({}, RPC_OPTIONS), error =>
            assertRpcError(error, 'operation-failed')
        );

        server.notify('filtered-out-notification');
        await delay(100);
        assert.equal(
            notifications.some(item => item.xml.includes('filtered-out-notification')),
            false,
            'a notification that does not match the subtree filter must not be delivered'
        );
        server.notify('integration-test-notification');
        const notification = await waitFor(
            () => notifications.find(item => item.xml.includes('integration-test-notification')),
            'mock server did not deliver the NETCONF notification'
        );
        assert.match(notification.eventTime, /^\d{4}-\d{2}-\d{2}T/u);
        assert.match(notification.xml, /^<notification xmlns="urn:ietf:params:xml:ns:netconf:notification:1\.0">/u);
        assert.match(notification.xml, /<mock-event/u);
        assert.match(notification.xml, /<message>integration-test-notification<\/message>/u);
        assert.match(notification.xml, /<datastore-revision>\d+<\/datastore-revision>/u);

        const expiringNotifications = [];
        secondary.on('notification', item => expiringNotifications.push(item));
        const startTime = new Date(Date.now() - 5_000).toISOString();
        const stopTime = new Date(Date.now() + 700).toISOString();
        const expiringReply = await secondary.createSubscription(
            {
                stream: 'NETCONF',
                filter: {
                    type: 'xpath',
                    select: "/nnmd:mock-event[nnmd:message='xpath-match']",
                    namespaces: { nnmd: MOCK_DEVICE_NAMESPACE }
                },
                startTime,
                stopTime
            },
            RPC_OPTIONS
        );
        assert.equal(expiringReply.ok, true);
        server.notify('xpath-miss');
        server.notify('xpath-match');
        await waitFor(
            () => expiringNotifications.find(item => item.xml.includes('xpath-match')),
            'mock server did not deliver the matching XPath-filtered notification'
        );
        await delay(100);
        assert.equal(
            expiringNotifications.some(item => item.xml.includes('xpath-miss')),
            false,
            'a notification that does not match the XPath filter must not be delivered'
        );
        await waitFor(
            () => expiringNotifications.find(item => item.xml.includes('<notificationComplete/>')),
            'mock server did not end the subscription at stopTime'
        );
        await waitFor(
            () =>
                server.getStatus().sessions.find(session => session.sessionId === secondarySession.sessionId)
                    ?.subscribed === false,
            'expired subscription state was not cleared'
        );
        server.notify('xpath-match-after-stop');
        await delay(100);
        assert.equal(
            expiringNotifications.some(item => item.xml.includes('xpath-match-after-stop')),
            false,
            'an expired subscription must not receive later notifications'
        );

        const secondaryId = secondarySession.sessionId;
        const closeReply = await secondary.closeSession(RPC_OPTIONS);
        assert.equal(closeReply.ok, true);
        assert.equal(secondary.connected, false);
        await waitFor(
            () => !server.getStatus().sessions.some(session => session.sessionId === secondaryId),
            'secondary NETCONF session remained registered after close-session'
        );

        const primaryId = primarySession.sessionId;
        assert.equal((await primary.closeSession(RPC_OPTIONS)).ok, true);
        assert.equal(primary.connected, false);
        await waitFor(
            () => !server.getStatus().sessions.some(session => session.sessionId === primaryId),
            'primary NETCONF session remained registered after close-session'
        );
        assert(
            server.logs.some(
                record =>
                    record.event === 'subscription-ended' &&
                    record.sessionId === primaryId &&
                    record.reason === 'session-close'
            ),
            'closing a NETCONF session must clear its active subscription'
        );

        assert(server.logs.some(record => record.event === 'rpc' && record.operation === 'get-schema'));
        assert(server.logs.some(record => record.event === 'rpc-error' && record.tag === 'lock-denied'));
        assert(server.logs.some(record => record.event === 'rpc-error' && record.tag === 'operation-not-supported'));
        assert(server.logs.some(record => record.event === 'state-change' && /commit/u.test(record.operation)));

        console.log('Real NETCONF-over-SSH mock server, stateful RPC, notification, and bundled libyang tests passed');
    } finally {
        for (const client of clients) {
            if (client.connected) client.disconnect('NETCONF mock integration test cleanup');
        }
        await pageWorker.disconnectAll().catch(() => {});
        await server.stop().catch(() => {});
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
