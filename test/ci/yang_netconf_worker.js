'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const NetconfWorkerService = require('../../electron/worker/yang/netconfWorker');
const { YANG_EVT_TYPES } = require('../../electron/const/yangConst');

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
    constructor(options) {
        super();
        this.options = options;
        this.connected = false;
        this.capabilities = ['urn:ietf:params:netconf:base:1.1', 'urn:ietf:params:netconf:capability:candidate:1.0'];
    }

    async connect(profile) {
        this.profile = profile;
        assert.equal(profile.port, 830);
        assert.equal(profile.hostVerifier(Buffer.from('worker-host-key')), true);
        if (profile.host === 'connect-failure.invalid') {
            const error = new Error('simulated connection failure');
            error.code = 'NETCONF_CONNECT_FAILED';
            throw error;
        }
        this.connected = true;
        return this.sessionInfo();
    }

    sessionInfo() {
        return {
            sessionId: 'worker-session-7',
            baseVersion: '1.1',
            capabilities: [...this.capabilities]
        };
    }

    async rpc(rpc, options) {
        this.lastRpc = rpc;
        this.lastRpcOptions = options;
        if (rpc.includes('<get-config>')) {
            return {
                type: 'rpc-reply',
                requestXml: `<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="8">${rpc}</rpc>`,
                xml: '<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="8"><data><system xmlns="urn:example:system"><hostname>router-1</hostname></system></data></rpc-reply>',
                messageId: '8',
                ok: false,
                data: { system: { hostname: 'router-1' } },
                errors: []
            };
        }
        return {
            type: 'rpc-reply',
            requestXml: `<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="9">${rpc}</rpc>`,
            xml: '<rpc-reply message-id="9"><ok/></rpc-reply>',
            messageId: '9',
            ok: true,
            data: null,
            errors: []
        };
    }

    async discoverSchemas() {
        return {
            source: 'rfc8525',
            contentId: 'content-1',
            modules: [{ name: 'example-system', revision: '2026-01-01', namespace: 'urn:example:system' }]
        };
    }

    async getSchema(options) {
        return {
            identifier: options.identifier,
            version: options.version,
            format: 'yang',
            content: 'module example-system { namespace "urn:example:system"; prefix es; revision 2026-01-01; }'
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

class DelayedConnectClient extends FakeClient {
    async connect(profile) {
        this.profile = profile;
        return new Promise(resolve => {
            this.releaseConnect = () => {
                this.connected = true;
                resolve(this.sessionInfo());
            };
        });
    }

    disconnect() {
        this.disconnectCount = (this.disconnectCount || 0) + 1;
        this.connected = false;
    }
}

class DelayedRpcClient extends FakeClient {
    constructor(options) {
        super(options);
        this.nextMessageId = 41;
        this.delayNextRpc = true;
        this.cancelledRpcIds = [];
        this.disconnectCount = 0;
    }

    reserveMessageId() {
        return this.nextMessageId++;
    }

    rpc(rpc, options = {}) {
        this.lastRpc = rpc;
        this.lastRpcOptions = options;
        if (!this.delayNextRpc) {
            const messageId = String(options.messageId);
            return Promise.resolve({
                type: 'rpc-reply',
                requestXml: `<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${messageId}">${rpc}</rpc>`,
                xml: `<rpc-reply message-id="${messageId}"><ok/></rpc-reply>`,
                messageId,
                ok: true,
                data: null,
                errors: []
            });
        }
        this.delayNextRpc = false;
        return new Promise((resolve, reject) => {
            this.pendingRpc = {
                messageId: String(options.messageId),
                requestXml: rpc,
                resolve,
                reject
            };
        });
    }

    cancelRpc(messageId) {
        const normalized = String(messageId);
        if (!this.pendingRpc || this.pendingRpc.messageId !== normalized) return false;
        const pending = this.pendingRpc;
        this.pendingRpc = null;
        this.cancelledRpcIds.push(normalized);
        const error = new Error(`NETCONF RPC ${normalized} was cancelled`);
        error.code = 'NETCONF_RPC_CANCELLED';
        error.messageId = normalized;
        error.requestXml = pending.requestXml;
        pending.reject(error);
        return true;
    }

    disconnect() {
        this.disconnectCount += 1;
        super.disconnect();
    }
}

const waitFor = async predicate => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('Timed out waiting for NETCONF worker test state');
};

async function main() {
    const port = new FakePort();
    const clients = [];
    const service = new NetconfWorkerService(port, {
        clientFactory: options => {
            const client = new FakeClient(options);
            clients.push(client);
            return client;
        }
    });
    const profile = {
        id: 'router-1',
        name: 'Router 1',
        host: '192.0.2.1',
        port: 830,
        username: 'netconf',
        authMethod: 'password',
        password: 'secret',
        hostKeyPolicy: 'accept-new',
        connectTimeout: 2000,
        rpcTimeout: 3000,
        keepaliveInterval: 1000,
        keepaliveCountMax: 2,
        autoReconnect: false
    };

    const connected = await service.connect(profile);
    assert.equal(connected.connected, true);
    assert.equal(connected.sessionId, 'worker-session-7');
    assert.match(connected.hostKeyFingerprint, /^SHA256:/);
    assert.equal(service.sessions.get(profile.id).profile.hostKeyFingerprint, connected.hostKeyFingerprint);
    assert.equal(clients[0].options.helloTimeout, 2000);

    const inventory = await service.discoverModules(profile.id);
    assert.equal(inventory.source, 'rfc8525');
    assert.equal(inventory.modules[0].name, 'example-system');
    assert.equal(inventory.profileId, profile.id);

    const downloaded = await service.getSchema(profile.id, inventory.modules[0]);
    assert.match(downloaded.content, /^module example-system/);
    assert.equal(downloaded.source, 'netconf://router-1/example-system@2026-01-01');

    const currentConfig = await service.executeOperation(profile.id, {
        operation: 'get-config',
        extractConfig: true,
        source: 'candidate',
        filter: { type: 'subtree', content: '<system xmlns="urn:example:system"/>' }
    });
    assert.equal(currentConfig.empty, false);
    assert.equal(currentConfig.sourceMessageId, '8');
    assert.match(currentConfig.requestXml, /^<rpc\b[^>]*message-id="8"/);
    assert.match(currentConfig.requestXml, /<get-config>/);
    assert.match(currentConfig.configXml, /<system xmlns="urn:example:system">/);
    assert.match(currentConfig.configXml, /<hostname>router-1<\/hostname>/);

    const operation = await service.executeOperation(profile.id, {
        operation: 'edit-config',
        target: 'candidate',
        defaultOperation: 'merge',
        config: '<system xmlns="urn:example:system"><hostname>router-1</hostname></system>'
    });
    assert.equal(operation.ok, true);
    assert.match(operation.rpc, /<edit-config>/);
    assert.match(operation.rpc, /<candidate\/>/);
    assert.doesNotMatch(operation.rpc, /^<rpc\b/);
    assert.match(operation.requestXml, /^<rpc\b[^>]*message-id="9"/);
    assert.match(operation.requestXml, /<edit-config>/);
    assert.equal(/message-id="([^"]+)"/.exec(operation.requestXml)[1], operation.messageId);
    assert.equal(clients[0].lastRpcOptions.rejectOnRpcError, false);

    await assert.rejects(
        service.sendRpc(profile.id, {
            rpc: '<!DOCTYPE rpc [<!ENTITY x SYSTEM "file:///etc/passwd">]><rpc>&x;</rpc>'
        }),
        error => error.code === 'NETCONF_UNSAFE_XML'
    );

    clients[0].emit('notification', {
        eventTime: '2026-07-18T00:00:00Z',
        xml: '<notification/>',
        document: { notification: {} }
    });
    const notification = port.messages.find(message => message.eventName === YANG_EVT_TYPES.NOTIFICATION);
    assert.equal(notification.data.profileId, profile.id);

    const disconnected = await service.disconnect(profile.id);
    assert.equal(disconnected.connected, false);
    assert.equal(disconnected.status, 'disconnected');
    assert.equal(service.sessions.get(profile.id).profile.password, undefined);

    await assert.rejects(
        service.connect({ ...profile, id: 'strict-router', hostKeyPolicy: 'strict', hostKeyFingerprint: '' }),
        error => error.code === 'NETCONF_HOST_VERIFICATION_REQUIRED'
    );

    const switchService = new NetconfWorkerService(new FakePort(), {
        clientFactory: options => new FakeClient(options)
    });
    const primaryProfile = { ...profile, id: 'switch-primary' };
    const backupProfile = { ...profile, id: 'switch-backup', host: '192.0.2.2' };
    await switchService.connect(primaryProfile);
    await assert.rejects(
        switchService.connect({
            ...backupProfile,
            id: 'switch-failed',
            host: 'connect-failure.invalid',
            autoReconnect: true
        }),
        /simulated connection failure/u
    );
    assert.equal(switchService.getSessionState(primaryProfile.id).connected, true);
    assert.equal(switchService.getSessionState('switch-failed').status, 'error');
    assert.equal(switchService.sessions.get('switch-failed').reconnectTimer, null);

    await switchService.connect(backupProfile);
    assert.equal(switchService.getSessionState(primaryProfile.id).status, 'disconnected');
    assert.equal(switchService.getSessionState(primaryProfile.id).connected, false);
    assert.equal(switchService.getSessionState(backupProfile.id).connected, true);
    await switchService.disconnectAll();

    const cancellationPort = new FakePort();
    let delayedClient = null;
    const cancellationService = new NetconfWorkerService(cancellationPort, {
        clientFactory: options => {
            delayedClient = new DelayedConnectClient(options);
            return delayedClient;
        }
    });
    cancellationPort.emit('message', {
        messageId: 'delayed-connect-request',
        op: 'connect',
        data: { ...profile, id: 'cancelled-router' }
    });
    await waitFor(() => Boolean(delayedClient?.releaseConnect));
    cancellationPort.emit('message', {
        op: '__cancel__',
        data: { messageId: 'delayed-connect-request' }
    });
    delayedClient.releaseConnect();
    await waitFor(() => cancellationService.activeConnectRequests.size === 0);
    assert.equal(cancellationService.getSessionState('cancelled-router').status, 'disconnected');
    assert.equal(cancellationService.getSessionState('cancelled-router').connected, false);
    assert.ok(delayedClient.disconnectCount >= 1);
    assert.equal(
        cancellationPort.messages.some(
            message =>
                message.messageId === 'delayed-connect-request' ||
                (message.eventName === YANG_EVT_TYPES.SESSION_EVENT && message.data?.status === 'connected')
        ),
        false
    );

    const rpcCancellationPort = new FakePort();
    let delayedRpcClient = null;
    const rpcCancellationService = new NetconfWorkerService(rpcCancellationPort, {
        clientFactory: options => {
            delayedRpcClient = new DelayedRpcClient(options);
            return delayedRpcClient;
        }
    });
    const rpcCancellationProfile = { ...profile, id: 'rpc-cancel-router' };
    await rpcCancellationService.connect(rpcCancellationProfile);
    rpcCancellationPort.messages.length = 0;
    rpcCancellationPort.emit('message', {
        messageId: 'delayed-rpc-request',
        op: 'executeOperation',
        data: { profileId: rpcCancellationProfile.id, operation: 'get' }
    });
    await waitFor(() => Boolean(delayedRpcClient?.pendingRpc));
    assert.equal(delayedRpcClient.pendingRpc.messageId, '41');
    assert.equal(rpcCancellationService.activeRpcRequests.get('delayed-rpc-request').messageId, '41');
    rpcCancellationPort.emit('message', {
        op: '__cancel__',
        data: { messageId: 'delayed-rpc-request' }
    });
    await waitFor(() => rpcCancellationService.activeRpcRequests.size === 0);
    assert.deepEqual(delayedRpcClient.cancelledRpcIds, ['41']);
    assert.equal(delayedRpcClient.disconnectCount, 0);
    assert.equal(delayedRpcClient.connected, true);
    assert.equal(rpcCancellationService.getSessionState(rpcCancellationProfile.id).connected, true);
    assert.equal(
        rpcCancellationPort.messages.some(message => message.messageId === 'delayed-rpc-request'),
        false,
        'a cancelled worker request must not publish a late response'
    );
    const afterCancellation = await rpcCancellationService.executeOperation(rpcCancellationProfile.id, {
        operation: 'get'
    });
    assert.equal(afterCancellation.ok, true);
    assert.equal(afterCancellation.messageId, '42');

    console.log('NETCONF worker session, discovery, download, RPC, and host-key tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
