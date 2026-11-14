'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const NetconfWorkerService = require('../../electron/worker/yang/netconfWorker');
const NetconfApp = require('../../electron/app/netconfApp');
const { NETCONF_REQ_TYPES } = require('../../electron/const/yangConst');
const { MockNetconfServer } = require('../../scripts/mockNetconfServer');

async function main() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-netconf-host-key-'));
    const messages = [];
    const service = new NetconfWorkerService({ on() {}, postMessage: message => messages.push(message) });
    let server = new MockNetconfServer({ port: 0, quiet: true });
    try {
        const original = await server.start();
        const profile = {
            id: 'rebooted-router',
            name: 'Rebooted Router',
            host: original.host,
            port: original.port,
            username: original.username,
            password: 'netconf',
            authMethod: 'password',
            hostKeyPolicy: 'strict',
            hostKeyFingerprint: original.fingerprint,
            connectTimeout: 5000,
            rpcTimeout: 5000,
            keepaliveInterval: 0
        };
        await service.connect(profile);
        await service.disconnect(profile.id);
        await server.stop();

        const keyPath = path.join(temporaryRoot, 'new-host-key.pem');
        const { privateKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
            publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
        });
        fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
        server = new MockNetconfServer({ port: original.port, hostKeyPath: keyPath, quiet: true });
        const rebooted = await server.start();
        assert.notEqual(rebooted.fingerprint, original.fingerprint);
        const expectedDetails = {
            profileId: profile.id,
            host: profile.host,
            port: profile.port,
            expectedFingerprint: original.fingerprint,
            observedFingerprint: rebooted.fingerprint
        };
        await assert.rejects(service.testConnection(profile), error => {
            assert.equal(error.code, 'NETCONF_HOST_KEY_MISMATCH');
            assert.deepEqual(error.data, expectedDetails);
            return true;
        });
        await service.handleMessage({ messageId: 'changed-key', op: NETCONF_REQ_TYPES.CONNECT, data: profile });
        const response = messages.find(message => message.messageId === 'changed-key');
        assert.equal(response.status, 'error');
        assert.equal(response.code, 'NETCONF_HOST_KEY_MISMATCH');
        assert.deepEqual(response.data.details, expectedDetails);
        assert.deepEqual(service.getSessionState(profile.id).lastError.details, expectedDetails);
        assert.equal(profile.hostKeyFingerprint, original.fingerprint, 'a failed attempt must keep the pinned key');
        assert.equal(
            server.logs.some(record => record.event === 'auth-success'),
            false
        );

        const entry = service.createEntry({ ...profile, autoReconnect: true });
        await assert.rejects(service.connectEntry(entry, true), error => error.code === 'NETCONF_HOST_KEY_MISMATCH');
        assert.equal(entry.status, 'error');
        assert.equal(entry.reconnectTimer, null, 'changed keys must stop automatic retry until confirmation');
        assert.equal(entry.profile.hostKeyFingerprint, original.fingerprint);

        // Exercise the renderer response boundary with the same serialized Worker error.
        const values = new Map();
        const app = new NetconfApp(
            { handle() {} },
            { get: (key, fallback) => values.get(key) ?? fallback, set: (key, value) => values.set(key, value) },
            { credentialStore: { hydrateProfile: (stored, secrets) => ({ ...stored, ...secrets }) } }
        );
        const client = {
            async sendRequest() {
                const error = new Error(response.msg);
                error.code = response.code;
                error.data = response.data;
                throw error;
            }
        };
        app.ensureLifecycleWorkerReady = async () => client;
        app.terminateYangProcess = async () => {};
        const event = { sender: { isDestroyed: () => false, send() {} } };
        for (const method of ['handleTestConnection', 'handleConnect']) {
            const result = await app[method](event, profile);
            assert.equal(result.status, 'error');
            assert.equal(result.data.code, 'NETCONF_HOST_KEY_MISMATCH');
            assert.deepEqual(result.data.details.details, expectedDetails);
        }

        const acceptedProfile = { ...profile, hostKeyFingerprint: rebooted.fingerprint };
        await assert.rejects(service.testConnection({ ...acceptedProfile, password: 'incorrect' }), error => {
            assert.notEqual(error.code, 'NETCONF_HOST_KEY_MISMATCH', 'password failures must remain distinct');
            return true;
        });
        const connected = await service.connect(acceptedProfile);
        assert.equal(connected.connected, true);
        assert.equal(connected.hostKeyFingerprint, rebooted.fingerprint);
        assert.equal(service.sessions.get(profile.id).profile.hostKeyFingerprint, rebooted.fingerprint);
        console.log('NETCONF Host Key change tests passed');
    } finally {
        await service.disconnectAll();
        await server.stop();
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
