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
        return {
            type: 'rpc-reply',
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

    const operation = await service.executeOperation(profile.id, {
        operation: 'edit-config',
        target: 'candidate',
        defaultOperation: 'merge',
        config: '<system xmlns="urn:example:system"><hostname>router-1</hostname></system>'
    });
    assert.equal(operation.ok, true);
    assert.match(operation.rpc, /<edit-config>/);
    assert.match(operation.rpc, /<candidate\/>/);
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

    console.log('NETCONF worker session, discovery, download, RPC, and host-key tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
