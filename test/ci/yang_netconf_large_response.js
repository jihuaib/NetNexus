'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const NetconfApp = require('../../electron/app/netconfApp');
const NetconfWorkerService = require('../../electron/worker/yang/netconfWorker');
const { NETCONF_REQ_TYPES, NETCONF_LIMITS } = require('../../electron/const/yangConst');

const BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';

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

const profile = {
    id: 'large-response-router',
    name: 'Large response router',
    host: '192.0.2.80',
    port: 830,
    username: 'netconf',
    rpcTimeout: 30000
};

const largeReply = (() => {
    const bodyBytes = NETCONF_LIMITS.MAX_INLINE_RPC_REPLY_BYTES + 32 * 1024;
    const body = `${'A'.repeat(Math.floor(bodyBytes * 0.7))}MIDDLE-MUST-NOT-REACH-RENDERER${'Z'.repeat(
        Math.ceil(bodyBytes * 0.3)
    )}`;
    return `<rpc-reply xmlns="${BASE_NAMESPACE}" message-id="large-1"><data>${body}</data></rpc-reply>`;
})();

function workerEntry(service, replyXml) {
    const entry = service.createEntry(profile);
    entry.status = 'connected';
    entry.client = {
        connected: true,
        sessionInfo: () => ({ sessionId: 'large-session', baseVersion: '1.1', capabilities: [] }),
        async rpc(rpc) {
            return {
                requestXml: `<rpc xmlns="${BASE_NAMESPACE}" message-id="large-1">${rpc}</rpc>`,
                xml: replyXml,
                messageId: 'large-1',
                ok: false,
                data: { expandedTreeMustStayInWorker: 'x'.repeat(1024) },
                errors: []
            };
        }
    };
    service.sessions.set(profile.id, entry);
    return entry;
}

async function verifyWorkerBoundary() {
    const service = new NetconfWorkerService(null);
    const entry = workerEntry(service, largeReply);
    const result = await service.sendRpc(profile.id, {
        rpc: `<rpc xmlns="${BASE_NAMESPACE}" message-id="large-1"><get/></rpc>`
    });
    assert.equal(result.reply, largeReply, 'worker must hand the main process one full response string');
    assert.equal(result.replyBytes, Buffer.byteLength(largeReply, 'utf8'));
    assert.equal(result.replyTruncated, true);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'xml'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'data'), false);

    const extracted = await service.executeOperation(profile.id, {
        operation: 'get-config',
        source: 'running',
        extractConfig: true
    });
    assert.equal(extracted.configTruncated, true);
    assert.equal(Object.prototype.hasOwnProperty.call(extracted, 'configXml'), false);

    const smallReply = `<rpc-reply xmlns="${BASE_NAMESPACE}" message-id="small-1"><ok/></rpc-reply>`;
    entry.client.rpc = async rpc => ({
        requestXml: `<rpc xmlns="${BASE_NAMESPACE}" message-id="small-1">${rpc}</rpc>`,
        xml: smallReply,
        messageId: 'small-1',
        ok: true,
        data: { compatible: true },
        errors: []
    });
    const small = await service.sendRpc(profile.id, {
        rpc: `<rpc xmlns="${BASE_NAMESPACE}" message-id="small-1"><get/></rpc>`
    });
    assert.equal(small.reply, smallReply);
    assert.equal(small.xml, smallReply, 'small response compatibility alias must be preserved');
    assert.deepEqual(small.data, { compatible: true });
    assert.equal(small.replyTruncated, false);
}

async function verifyMainArtifactBoundary() {
    const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'netnexus-large-rpc-test-'));
    const savedPath = path.join(temporaryRoot, 'saved-full-reply.xml');
    const fakeDialog = {
        options: null,
        async showSaveDialog(...args) {
            this.options = args[args.length - 1];
            return { canceled: false, filePath: savedPath };
        }
    };
    const ipcMain = new FakeIpcMain();
    const app = new NetconfApp(ipcMain, new MemoryStore(), {
        yangApp: { setActiveProfileId() {} },
        dialog: fakeDialog,
        rpcReplyArtifactBaseDirectory: temporaryRoot
    });
    app.activeProfileId = profile.id;
    let terminated = false;
    app.workerClient = {
        async sendRequest(operation) {
            if (operation === NETCONF_REQ_TYPES.DISCONNECT_ALL) return { data: [] };
            assert.equal(operation, NETCONF_REQ_TYPES.SEND_RPC);
            return {
                data: {
                    reply: largeReply,
                    replyBytes: Buffer.byteLength(largeReply, 'utf8'),
                    replyTruncated: true,
                    messageId: 'large-1',
                    errors: [],
                    xml: largeReply,
                    data: { expandedTreeMustNotCrossRendererIpc: true }
                }
            };
        },
        async terminate() {
            terminated = true;
        }
    };
    const event = {
        sender: {
            isDestroyed: () => false,
            send() {}
        }
    };

    try {
        assert.equal(typeof ipcMain.handlers.get('netconf:saveRpcReply'), 'function');
        const response = await app.handleSendRpc(event, {
            profileId: profile.id,
            rpc: `<rpc xmlns="${BASE_NAMESPACE}" message-id="large-1"><get/></rpc>`
        });
        assert.equal(response.status, 'success');
        assert.equal(response.data.replyTruncated, true);
        assert.equal(response.data.replyBytes, Buffer.byteLength(largeReply, 'utf8'));
        assert(Buffer.byteLength(response.data.reply, 'utf8') <= NETCONF_LIMITS.MAX_INLINE_RPC_REPLY_BYTES);
        assert.equal(response.data.replyPreviewBytes, Buffer.byteLength(response.data.reply, 'utf8'));
        assert.match(response.data.reply, /^<rpc-reply/u);
        assert.match(response.data.reply, /ZZZZZZ/u, 'preview must retain the response tail');
        assert.doesNotMatch(response.data.reply, /MIDDLE-MUST-NOT-REACH-RENDERER/u);
        assert.equal(Object.prototype.hasOwnProperty.call(response.data, 'xml'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(response.data, 'data'), false);
        assert.match(response.data.replyFileToken, /^[0-9a-f-]{36}$/u);

        const artifact = app.rpcReplyArtifacts.get(response.data.replyFileToken);
        assert(artifact);
        assert.equal(await fs.promises.readFile(artifact.filePath, 'utf8'), largeReply);
        if (process.platform !== 'win32') {
            assert.equal((await fs.promises.stat(artifact.filePath)).mode & 0o777, 0o600);
            assert.equal((await fs.promises.stat(app.rpcReplyArtifactDirectory)).mode & 0o777, 0o700);
        }

        const saveResponse = await app.handleSaveRpcReply(null, {
            token: response.data.replyFileToken,
            suggestedName: '../unsafe:name'
        });
        assert.equal(saveResponse.status, 'success');
        assert.deepEqual(saveResponse.data, { canceled: false, filePath: savedPath });
        assert.equal(await fs.promises.readFile(savedPath, 'utf8'), largeReply);
        assert.equal(fakeDialog.options.defaultPath.includes('..'), false);
        assert.match(fakeDialog.options.defaultPath, /\.xml$/u);

        const missing = await app.handleSaveRpcReply(null, { token: 'not-an-artifact-token' });
        assert.equal(missing.status, 'error');
        assert.equal(missing.data.code, 'NETCONF_RPC_REPLY_ARTIFACT_NOT_FOUND');

        const artifactDirectory = app.rpcReplyArtifactDirectory;
        await app.closeAll();
        assert.equal(terminated, true);
        assert.equal(app.rpcReplyArtifacts.size, 0);
        await assert.rejects(fs.promises.stat(artifactDirectory), error => error.code === 'ENOENT');
    } finally {
        if (!terminated) await app.closeAll();
        await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
    }
}

async function verifyArtifactFailureFallback() {
    const app = new NetconfApp(new FakeIpcMain(), new MemoryStore(), {
        yangApp: { setActiveProfileId() {} },
        rpcReplyArtifactBaseDirectory: '/dev/null/netnexus-artifacts'
    });
    try {
        const result = await app.externalizeRpcPayload({ reply: largeReply, xml: largeReply, data: { huge: true } });
        assert.equal(result.replyTruncated, true);
        assert.equal(result.replyBytes, Buffer.byteLength(largeReply, 'utf8'));
        assert(Buffer.byteLength(result.reply, 'utf8') <= NETCONF_LIMITS.MAX_INLINE_RPC_REPLY_BYTES);
        assert.equal(result.replyFileToken, undefined);
        assert.equal(Object.prototype.hasOwnProperty.call(result, 'xml'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(result, 'data'), false);
        assert(result.replyArtifactError?.message);
    } finally {
        await app.closeAll();
    }
}

async function main() {
    await verifyWorkerBoundary();
    await verifyMainArtifactBoundary();
    if (process.platform !== 'win32') await verifyArtifactFailureFallback();
    console.log('NETCONF large RPC response IPC, artifact, save, and cleanup tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
