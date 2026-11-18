'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const YangRuntimeService = require('../../electron/worker/yang/yangRuntimeService');
const NetconfWorkerService = require('../../electron/worker/yang/netconfWorker');
const {
    normalizeDeviceModels,
    deviceModuleDescriptors,
    matchesDeviceModule
} = require('../../electron/utils/yang/yangDeviceModels');

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
    delete(key) {
        this.values.delete(key);
    }
}

function models(revision, baseName) {
    return {
        source: 'rfc8525',
        contentId: `release-${revision}`,
        modules: [
            { name: 'vendor-bgp', revision, namespace: 'urn:vendor:bgp' },
            { name: baseName, revision, namespace: 'urn:vendor:base', conformanceType: 'import' },
            { name: 'common-types', revision, namespace: 'urn:common:types', conformanceType: 'import' }
        ]
    };
}

function contents(revision, baseName) {
    return [
        {
            content: `module common-types { namespace "urn:common:types"; prefix ct; revision ${revision}; typedef label { type string; } }`
        },
        {
            content: `module ${baseName} { namespace "urn:vendor:base"; prefix vb; revision ${revision}; typedef number { type uint32; } }`
        },
        {
            content: `module vendor-bgp { namespace "urn:vendor:bgp"; prefix bgp; import ${baseName} { prefix vb; } import common-types { prefix ct; } revision ${revision}; container bgp { leaf asn { type vb:number; } leaf label { type ct:label; } } }`
        }
    ];
}

async function main() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-device-model-cache-'));
    const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.join(__dirname, '..', '..'));
    const store = new MemoryStore();
    const options = { rootDir, resourcesPath: path.join(projectRoot, 'resources'), isPackaged: false };
    const event = { sender: { isDestroyed: () => false, send() {} } };
    const createRuntime = () => new YangRuntimeService({ handle() {} }, store, options);
    let runtime = createRuntime();
    const newModels = models('2026-01-01', 'new-basetype');
    const oldModels = models('2021-01-01', 'comware-basetype');
    const monitoring = normalizeDeviceModels({
        source: 'rfc6022',
        modules: [{ name: 'bgp-part', revision: '2021-01-01', namespace: 'urn:vendor:bgp' }]
    });
    const submodule = { metadata: { kind: 'submodule', name: 'bgp-part', revision: '2021-01-01' } };
    assert(matchesDeviceModule(submodule, deviceModuleDescriptors(monitoring, 'submodule', 'bgp-part')[0]));
    assert.notEqual(
        normalizeDeviceModels({ ...oldModels, source: 'rfc7895', moduleSetId: 'one' }).fingerprint,
        normalizeDeviceModels({ ...oldModels, source: 'rfc7895', moduleSetId: 'two' }).fingerprint
    );
    const profileId = 'same-ip-different-firmware';
    const query = { profileId };
    const compile = async (request, succeeds = true) => {
        const response = await runtime.handleCompile(event, request);
        assert.equal(response.status, 'success', response.msg);
        const task = runtime.taskManager.tasks.get(response.data.taskId);
        await task.promise;
        assert.equal(task.status, succeeds ? 'completed' : 'failed', JSON.stringify(task.error));
        return task.result;
    };
    try {
        await runtime.importDownloadedContents(contents('2026-01-01', 'new-basetype'), query, event);
        await runtime.updateDeviceModels(profileId, newModels);
        const first = await compile({ ...query, modules: ['vendor-bgp'] });
        assert.equal(first.moduleHashes.length, 3);
        assert(first.schemaTree.nodeCount > 0);
        const persistedId = first.compileId;
        const sourcePaths = (
            await runtime.listRawModules(event, { workspaceId: runtime.resolveProfileContext(query).workspaceId })
        ).map(module => module.filePath);

        const reordered = { ...newModels, discoveredAt: 'later', modules: [...newModels.modules].reverse() };
        assert.equal(normalizeDeviceModels(reordered).fingerprint, normalizeDeviceModels(newModels).fingerprint);
        await runtime.updateDeviceModels(profileId, reordered);
        assert.equal((await runtime.handleGetWorkspace(event, query)).data.compileId, persistedId);
        for (const unavailable of [
            null,
            { source: 'rfc8525', modules: [] },
            { source: 'hello', modules: oldModels.modules }
        ]) {
            await runtime.updateDeviceModels(profileId, unavailable);
            assert.equal((await runtime.handleGetWorkspace(event, query)).data.compileId, persistedId);
        }
        await runtime.updateDeviceModels(profileId, oldModels, { isCurrent: () => false });
        assert.equal((await runtime.handleGetWorkspace(event, query)).data.compileId, persistedId);

        await runtime.updateDeviceModels(profileId, oldModels);
        let workspace = (await runtime.handleGetWorkspace(event, query)).data;
        assert.equal(workspace.deviceModelSet.schemaStale, true);
        assert.equal(workspace.compileId, '');
        assert.equal(workspace.modules.length, 3);
        assert(
            sourcePaths.every(filePath => fs.existsSync(filePath)),
            'switching firmware must preserve cached files'
        );
        assert.equal((await runtime.handleGetSchemaRoots(event, { ...query, compileId: persistedId })).status, 'error');
        assert.equal(
            (await runtime.handleValidateRpc(event, { ...query, compileId: persistedId, rpc: '<rpc/>' })).status,
            'error'
        );
        assert.equal(
            (
                await runtime.handleCompile(event, {
                    ...query,
                    modules: [{ name: 'vendor-bgp', revision: '2026-01-01' }]
                })
            ).status,
            'error'
        );
        await runtime.close();
        runtime = createRuntime();
        workspace = (await runtime.handleGetWorkspace(event, query)).data;
        assert.equal(
            workspace.deviceModelSet.schemaStale,
            true,
            'a restart must not restore the previous device Schema'
        );
        assert.equal(workspace.schemaTree, null);
        await assert.rejects(
            runtime.importDownloadedContents(
                contents('2026-01-01', 'new-basetype'),
                { ...query, inventory: newModels },
                event
            ),
            /模型集已变化/u
        );

        await runtime.importDownloadedContents(
            contents('2021-01-01', 'comware-basetype'),
            { ...query, inventory: oldModels },
            event
        );
        const oldVersion = await compile(query);
        assert.equal(oldVersion.modules.length, 3, 'whole-device compilation must exclude archived firmware models');
        assert(
            oldVersion.modules.every(module => module.metadata.revision === '2021-01-01'),
            'unpinned imports must use the device revision, not the latest cached revision'
        );
        workspace = (await runtime.handleGetWorkspace(event, query)).data;
        assert.equal(workspace.deviceModelSet.schemaStale, false);
        assert.equal(workspace.modules.length, 6);
        assert.equal(workspace.success, true);
        const oldCompileId = workspace.compileId;
        await runtime.close();
        runtime = createRuntime();
        assert.equal((await runtime.handleGetWorkspace(event, query)).data.compileId, oldCompileId);
        assert.equal((await runtime.handleGetSchemaRoots(event, query)).status, 'success');

        const conflictProfile = 'namespace-conflict';
        const conflictModels = {
            ...newModels,
            modules: [
                ...newModels.modules,
                { name: 'alias-basetype', revision: '2026-01-01', namespace: 'urn:vendor:base' }
            ]
        };
        await runtime.importDownloadedContents(
            contents('2026-01-01', 'new-basetype'),
            { profileId: conflictProfile },
            event
        );
        await runtime.updateDeviceModels(conflictProfile, conflictModels);
        const baseline = await compile({ profileId: conflictProfile, modules: ['vendor-bgp'] });
        await runtime.importDownloadedContents(
            [
                {
                    content:
                        'module alias-basetype { namespace "urn:vendor:base"; prefix ab; revision 2026-01-01; leaf alias { type string; } }'
                }
            ],
            { profileId: conflictProfile },
            event
        );
        await compile({ profileId: conflictProfile, modules: ['alias-basetype'] }, false);
        workspace = (await runtime.handleGetWorkspace(event, { profileId: conflictProfile })).data;
        assert.equal(workspace.compileId, baseline.compileId);
        assert.equal(workspace.schemaRetained, true);
        assert.equal(workspace.success, false);
        assert(workspace.diagnostics.some(item => /same namespace/u.test(item.message)));
        assert.equal((await runtime.handleGetSchemaRoots(event, { profileId: conflictProfile })).status, 'success');
        assert(
            (await runtime.handleGetDiagnostics(event, { profileId: conflictProfile })).data.some(item =>
                /same namespace/u.test(item.message)
            )
        );
        await runtime.close();
        runtime = createRuntime();
        workspace = (await runtime.handleGetWorkspace(event, { profileId: conflictProfile })).data;
        assert.equal(workspace.schemaRetained, true);
        assert.equal(workspace.compileId, baseline.compileId);
        assert.equal(workspace.summary.cacheHit, true);
        const retry = await compile({ profileId: conflictProfile, modules: ['vendor-bgp'] });
        assert.equal(retry.success, true, 'failed models must not be silently added to subsequent compilation');
        assert.equal(
            (await runtime.handleGetWorkspace(event, { profileId: conflictProfile })).data.schemaRetained,
            false
        );
        assert.equal(
            (await runtime.handleGetWorkspace(event, query)).data.compileId,
            oldCompileId,
            'profiles must keep separate model contexts'
        );

        const changedFeatures = {
            ...oldModels,
            modules: oldModels.modules.map(module => ({ ...module, features: ['feature-added'] }))
        };
        await runtime.updateDeviceModels(profileId, changedFeatures);
        assert.equal((await runtime.handleGetWorkspace(event, query)).data.deviceModelSet.schemaStale, true);
        assert.equal(
            (await runtime.handleGetWorkspace(event, { profileId: conflictProfile })).data.compileId,
            baseline.compileId
        );
        const originalSend = runtime.workerClient.sendRequest.bind(runtime.workerClient);
        let releaseCompile;
        let markCompileReady;
        const compileReady = new Promise(resolve => {
            markCompileReady = resolve;
        });
        const compileRelease = new Promise(resolve => {
            releaseCompile = resolve;
        });
        runtime.workerClient.sendRequest = async (...args) => {
            const result = await originalSend(...args);
            if (args[0] === 'yang:compile') {
                markCompileReady();
                await compileRelease;
            }
            return result;
        };
        const racingCompile = await runtime.handleCompile(event, {
            profileId: conflictProfile,
            modules: ['vendor-bgp'],
            force: true
        });
        await compileReady;
        await runtime.updateDeviceModels(conflictProfile, {
            ...conflictModels,
            contentId: 'changed-during-compilation'
        });
        releaseCompile();
        await runtime.taskManager.tasks.get(racingCompile.data.taskId).promise;
        assert.equal(runtime.taskManager.tasks.get(racingCompile.data.taskId).status, 'failed');
        assert.equal(
            (await runtime.handleGetWorkspace(event, { profileId: conflictProfile })).data.deviceModelSet.schemaStale,
            true,
            'a late compile result must not install a Schema for a previous device model set'
        );
        runtime.workerClient.sendRequest = originalSend;
        let serverInventory = changedFeatures;
        let discoveryFailure = false;
        let hostKey = 'original-key';
        let inventoryChecks = 0;
        class Client extends EventEmitter {
            async connect(profile) {
                if (!profile.hostVerifier(Buffer.from(hostKey))) throw new Error('Host verification failed');
                this.connected = true;
            }
            sessionInfo() {
                return { sessionId: 'cache-test', capabilities: ['urn:ietf:params:netconf:base:1.1'] };
            }
            async discoverSchemas() {
                if (discoveryFailure) throw new Error('device inventory query failed');
                return serverInventory;
            }
            disconnect() {
                this.connected = false;
            }
        }
        const netconf = new NetconfWorkerService(null, {
            listen: false,
            clientFactory: () => new Client(),
            onSchemaInventory: async (id, inventory, context) => {
                await runtime.updateDeviceModels(id, inventory, context);
                inventoryChecks += 1;
            }
        });
        try {
            await netconf.connect({
                id: profileId,
                host: '127.0.0.1',
                port: 830,
                username: 'test',
                hostKeyPolicy: 'accept-new'
            });
            const entry = netconf.sessions.get(profileId);
            await entry.schemaDiscoveryPromise;
            assert.equal(
                inventoryChecks,
                1,
                'connect must check the inventory even when the server only advertises RFC 6022'
            );
            serverInventory = { ...changedFeatures, contentId: 'new-content-id-same-modules' };
            await netconf.connectEntry(entry, true);
            await entry.schemaDiscoveryPromise;
            assert.equal(inventoryChecks, 2, 'automatic reconnect must discover the model set again');
            const fingerprint = runtime.lastCompile.get(runtime.resolveProfileContext(query).workspaceId).deviceModels
                .fingerprint;
            discoveryFailure = true;
            await netconf.connectEntry(entry, true);
            await entry.schemaDiscoveryPromise?.catch(() => {});
            assert.equal(
                netconf.getSessionState(profileId).connected,
                true,
                'inventory failure must not disconnect NETCONF'
            );
            assert.equal(
                runtime.lastCompile.get(runtime.resolveProfileContext(query).workspaceId).deviceModels.fingerprint,
                fingerprint
            );
            hostKey = 'replacement-key';
            await assert.rejects(
                netconf.connectEntry(entry, true),
                error => error.code === 'NETCONF_HOST_KEY_MISMATCH'
            );
            assert.equal(inventoryChecks, 2, 'an unconfirmed host key must not trigger model cache changes');
            assert.equal(
                runtime.lastCompile.get(runtime.resolveProfileContext(query).workspaceId).deviceModels.fingerprint,
                fingerprint
            );
        } finally {
            await netconf.disconnectAll();
        }
        console.log(
            'Profile model cache version switching, pinned imports, stale guards, failure retention, and restart tests passed'
        );
    } finally {
        await runtime.close();
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
