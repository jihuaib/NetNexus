const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateAuthoritativeSchemaTree } = require('../../electron/utils/yang/yangCompiler');
const {
    buildGet,
    buildGetConfig,
    childValues,
    filterSubtreeXml,
    findRoot,
    getAttribute,
    parseXml,
    rpcReplyDataToConfig
} = require('../../electron/utils/netconf');
const { verifyRuntime } = require('../libyang-runtime-config');
const { errorResponse, successResponse } = require('./common');

const yangPageApiScript = `
    window.netconfApi = {
        listProfiles: () => call('yang.netconf.listProfiles'),
        saveProfile: profile => call('yang.netconf.saveProfile', profile),
        deleteProfile: profileId => call('yang.netconf.deleteProfile', profileId),
        testConnection: profile => call('yang.netconf.testConnection', profile),
        connect: profile => call('yang.netconf.connect', profile),
        disconnect: profileId => call('yang.netconf.disconnect', profileId),
        getSessionState: () => call('yang.netconf.getSessionState'),
        selectPrivateKey: () => call('yang.netconf.selectPrivateKey'),
        discoverModules: () => call('yang.netconf.discoverModules'),
        downloadModules: request => call('yang.netconf.downloadModules', request),
        executeOperation: request => call('yang.netconf.executeOperation', request),
        sendRpc: request => call('yang.netconf.sendRpc', request)
    };
    window.yangApi = {
        listModules: query => call('yang.registry.listModules', query),
        selectFiles: () => call('yang.registry.selectFiles'),
        selectDirectory: () => call('yang.registry.selectDirectory'),
        importFiles: filePaths => call('yang.registry.importFiles', filePaths),
        importDirectory: directoryPath => call('yang.registry.importDirectory', directoryPath),
        getCompilerStatus: () => call('yang.registry.getCompilerStatus'),
        compile: request => call('yang.registry.compile', request),
        clearWorkspace: () => call('yang.registry.clearWorkspace'),
        getWorkspace: () => call('yang.registry.getWorkspace'),
        getSchemaRoots: request => call('yang.registry.getSchemaRoots', request),
        getSchemaChildren: request => call('yang.registry.getSchemaChildren', request),
        getSchemaNode: request => call('yang.registry.getSchemaNode', request),
        getModuleSource: request => call('yang.registry.getModuleSource', request),
        getDiagnostics: request => call('yang.registry.getDiagnostics', request)
    };`;

const capabilities = Object.freeze([
    'urn:ietf:params:netconf:base:1.0',
    'urn:ietf:params:netconf:base:1.1',
    'urn:ietf:params:netconf:capability:writable-running:1.0',
    'urn:ietf:params:netconf:capability:candidate:1.0',
    'urn:ietf:params:netconf:capability:confirmed-commit:1.1',
    'urn:ietf:params:netconf:capability:startup:1.0',
    'urn:ietf:params:netconf:capability:validate:1.1',
    'urn:ietf:params:netconf:capability:xpath:1.0',
    'urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04',
    'urn:ietf:params:netconf:capability:notification:1.0'
]);

const PAGE_INTERFACES_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const PAGE_SYSTEM_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-system';
const PAGE_KEY_DEFINITIONS = Object.freeze([
    Object.freeze({
        namespace: PAGE_INTERFACES_NAMESPACE,
        element: 'interface',
        keys: Object.freeze([Object.freeze({ namespace: PAGE_INTERFACES_NAMESPACE, name: 'name' })])
    })
]);

const moduleSources = Object.freeze({
    'ietf-yang-types': `module ietf-yang-types {
  yang-version 1.1;
  namespace "urn:ietf:params:xml:ns:yang:ietf-yang-types";
  prefix yang;
  revision 2013-07-15;
  typedef counter32 { type uint32; }
}`,
    'ietf-interfaces': `module ietf-interfaces {
  yang-version 1.1;
  namespace "urn:ietf:params:xml:ns:yang:ietf-interfaces";
  prefix if;
  import ietf-yang-types { prefix yang; }
  revision 2018-02-20;
  container interfaces {
    list interface {
      key "name";
      leaf name { type string; }
      leaf enabled { type boolean; default true; }
      leaf in-octets { config false; type yang:counter32; }
    }
  }
}`,
    'ietf-system': `module ietf-system {
  yang-version 1.1;
  namespace "urn:ietf:params:xml:ns:yang:ietf-system";
  prefix sys;
  revision 2014-08-06;
  container system { leaf hostname { type string; } }
}`,
    'ietf-netconf-monitoring': `module ietf-netconf-monitoring {
  namespace "urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring";
  prefix ncm;
  revision 2010-10-04;
  container netconf-state { config false; }
}`,
    'netnexus-demo': `module netnexus-demo {
  yang-version 1.1;
  namespace "urn:netnexus:e2e:demo";
  prefix demo;
  revision 2026-01-01;
  container demo { leaf message { type string; default "NetNexus"; } }
}`,
    'vendor-system': `module vendor-system {
  yang-version 1.1;
  namespace "urn:netnexus:e2e:vendor-system";
  prefix vs;
  revision 2026-02-02;
  container system { leaf serial-number { config false; type string; } }
}`
});

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

let verifiedRuntime = null;

function createCompilerStatus() {
    try {
        if (!verifiedRuntime) verifiedRuntime = verifyRuntime();
        return {
            ...clone(verifiedRuntime),
            status: 'ready',
            bundled: verifiedRuntime.source === 'bundled',
            schemaVersion: verifiedRuntime.version,
            capabilities: {
                validation: true,
                schemaExport: true,
                coreSchemaExport: true,
                extensionSchemaExport: false
            }
        };
    } catch (error) {
        return {
            available: false,
            required: true,
            status: 'unavailable',
            engine: 'libyang',
            executable: 'yanglint',
            schemaExecutable: 'netnexus-libyang-schema',
            bundled: true,
            message: error.message,
            error: error.message,
            installHint: '请先构建当前平台的内置 libyang 运行时。'
        };
    }
}

function makeModule({
    id,
    name,
    revision,
    namespace,
    isLocal = false,
    source = 'netconf',
    imports = [],
    features = []
}) {
    return {
        id,
        moduleId: id,
        name,
        revision,
        namespace,
        conformanceType: 'implement',
        features,
        deviations: [],
        imports,
        isLocal,
        source,
        status: isLocal ? 'downloaded' : 'discovered',
        downloadStatus: isLocal ? 'downloaded' : 'remote',
        fileName: isLocal ? `${name}@${revision}.yang` : '',
        filePath: isLocal ? `/tmp/netnexus-e2e/yang/${name}@${revision}.yang` : '',
        contentHash: isLocal ? `e2e-${id}` : '',
        compiled: false,
        compileStatus: 'pending'
    };
}

function schemaSource(yang, module) {
    const source = yang.moduleSources[module.name];
    if (typeof source !== 'string' || !source.trim()) {
        throw new Error(`E2E 模块 ${module.id || module.name} 没有可供 libyang 编译的真实 YANG 源码`);
    }
    return source;
}

function materializeModuleSources(yang, directory) {
    const pathsById = new Map();
    yang.modules
        .filter(module => module.isLocal)
        .forEach(module => {
            const fileName = `${module.name}@${module.revision || 'none'}.yang`;
            const filePath = path.join(directory, fileName);
            fs.writeFileSync(filePath, schemaSource(yang, module), 'utf8');
            pathsById.set(module.id, filePath);
        });
    return pathsById;
}

function executeSchemaHelper(yang, targets) {
    if (!yang.compiler.available || !yang.compiler.schemaPath) {
        throw new Error(yang.compiler.message || '内置 libyang Schema helper 不可用');
    }
    if (!targets.length) throw new Error('没有可供 libyang 编译的本地 YANG 模块');

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-yang-e2e-'));
    try {
        const pathsById = materializeModuleSources(yang, directory);
        const inputPaths = targets.map(module => pathsById.get(module.id));
        if (inputPaths.some(filePath => !filePath)) {
            throw new Error('libyang Schema helper 的顶层模块源码没有完成物化');
        }
        const runtimeModulePaths = [
            path.join(yang.compiler.runtimeDirectory || '', 'share', 'yang', 'modules', 'libyang'),
            path.join(yang.compiler.runtimeDirectory || '', 'share', 'yang', 'modules')
        ].filter(directoryPath => {
            try {
                return fs.statSync(directoryPath).isDirectory();
            } catch (_error) {
                return false;
            }
        });
        /* libyang searches directories in reverse insertion order, so the E2E workspace must be last. */
        const searchArgs = [...runtimeModulePaths, directory].flatMap(directoryPath => ['-p', directoryPath]);
        const execution = childProcess.spawnSync(yang.compiler.schemaPath, [...searchArgs, ...inputPaths], {
            cwd: directory,
            encoding: 'utf8',
            timeout: 60_000,
            maxBuffer: 64 * 1024 * 1024,
            windowsHide: true
        });
        if (execution.error || execution.status !== 0) {
            const detail = [execution.error?.message, execution.stderr, execution.stdout]
                .map(value => String(value || '').trim())
                .filter(Boolean)
                .join('\n');
            throw new Error(
                `libyang effective Schema 编译失败${execution.status === null ? '' : `（退出码 ${execution.status}）`}` +
                    (detail ? `：\n${detail}` : '')
            );
        }
        let output;
        try {
            output = JSON.parse(execution.stdout);
        } catch (error) {
            throw new Error(`libyang Schema helper 返回了无效 JSON：${error.message}`);
        }
        return validateAuthoritativeSchemaTree(output);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function createYangPageState() {
    const profile = {
        id: 'e2e-netconf-profile',
        name: 'NETCONF E2E 设备',
        host: '192.0.2.10',
        port: 830,
        username: 'netconf',
        authMethod: 'password',
        password: '',
        rememberCredentials: true,
        hasSavedCredentials: true,
        hostKeyFingerprint: 'SHA256:NetNexusE2EHostKey',
        connectTimeout: 15000,
        keepaliveInterval: 30000,
        autoReconnect: false
    };
    const modules = [
        makeModule({
            id: 'ietf-yang-types@2013-07-15',
            name: 'ietf-yang-types',
            revision: '2013-07-15',
            namespace: 'urn:ietf:params:xml:ns:yang:ietf-yang-types',
            isLocal: true,
            source: 'download'
        }),
        makeModule({
            id: 'ietf-interfaces@2018-02-20',
            name: 'ietf-interfaces',
            revision: '2018-02-20',
            namespace: 'urn:ietf:params:xml:ns:yang:ietf-interfaces',
            isLocal: true,
            source: 'download',
            imports: [{ name: 'ietf-yang-types', revision: '2013-07-15' }]
        }),
        makeModule({
            id: 'ietf-system@2014-08-06',
            name: 'ietf-system',
            revision: '2014-08-06',
            namespace: 'urn:ietf:params:xml:ns:yang:ietf-system'
        }),
        makeModule({
            id: 'ietf-netconf-monitoring@2010-10-04',
            name: 'ietf-netconf-monitoring',
            revision: '2010-10-04',
            namespace: 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring'
        })
    ];
    const yang = {
        profiles: [profile],
        nextProfileId: 2,
        connected: true,
        rpcSequence: 100,
        compileSequence: 0,
        modules,
        moduleSources: { ...moduleSources },
        schemaTree: null,
        compiledModuleIds: [],
        compiledAt: '',
        diagnostics: [],
        compiler: createCompilerStatus(),
        session: {
            status: 'connected',
            state: 'connected',
            connected: true,
            profileId: profile.id,
            profileName: profile.name,
            host: profile.host,
            port: profile.port,
            baseVersion: '1.1',
            version: '1.1',
            sessionId: 'e2e-session-101',
            connectedAt: new Date().toISOString(),
            capabilities: [...capabilities]
        },
        workspace: null
    };
    if (yang.compiler.available) {
        compileWorkspace(
            yang,
            modules.filter(module => module.isLocal),
            { cacheHit: true }
        );
    } else {
        yang.workspace = buildWorkspace(yang);
    }
    return yang;
}

function publicProfile(profile) {
    const result = clone(profile);
    delete result.password;
    delete result.passphrase;
    result.hasSavedCredentials = Boolean(profile.hasSavedCredentials || profile.rememberCredentials);
    return result;
}

function publicModule(module) {
    return clone(module);
}

function moduleMatchesIdentity(module, identity) {
    if (typeof identity === 'string') return module.id === identity || module.name === identity;
    if (!identity) return false;
    if (identity.id && module.id === identity.id) return true;
    return module.name === identity.name && (!identity.revision || identity.revision === module.revision);
}

function findModule(yang, identity) {
    return yang.modules.find(module => moduleMatchesIdentity(module, identity));
}

function schemaNodeSummary(yang, nodeId) {
    return clone(yang.schemaTree?.nodes?.[nodeId]) || null;
}

function buildWorkspace(yang, { cacheHit = false } = {}) {
    const tree = yang.schemaTree;
    const compiledIds = new Set(yang.compiledModuleIds);
    const compiledModules = yang.modules.filter(module => compiledIds.has(module.id));
    const roots = (tree?.roots || []).map(nodeId => schemaNodeSummary(yang, nodeId)).filter(Boolean);
    const errors = yang.diagnostics.filter(diagnostic => ['error', 'fatal'].includes(diagnostic.severity)).length;
    const warnings = yang.diagnostics.filter(diagnostic => ['warning', 'warn'].includes(diagnostic.severity)).length;
    const success = Boolean(tree) && errors === 0;
    return {
        compileId: tree ? `e2e-compile-${yang.compileSequence}` : '',
        compiledAt: yang.compiledAt || null,
        success,
        cacheHit,
        compiler: clone(yang.compiler),
        summary: {
            moduleCount: compiledModules.length,
            nodeCount: tree?.nodeCount || 0,
            diagnosticCount: yang.diagnostics.length,
            errors,
            warnings,
            cacheHit
        },
        modules: compiledModules.map(publicModule),
        diagnostics: clone(yang.diagnostics),
        schemaTree: tree
            ? {
                  rootId: tree.rootId,
                  roots,
                  nodeCount: tree.nodeCount,
                  authoritative: tree.authoritative,
                  source: tree.source,
                  scope: tree.scope
              }
            : null,
        externalCompiler: {
            invoked: Boolean(tree),
            succeeded: Boolean(tree),
            path: yang.compiler.schemaPath || null,
            exitCode: tree ? 0 : null
        },
        validation: { authoritative: tree?.authoritative === true, engine: 'libyang', succeeded: success }
    };
}

function compileWorkspace(yang, targets, { cacheHit = false } = {}) {
    const tree = executeSchemaHelper(yang, targets);
    targets.forEach(module => {
        module.compiled = true;
        module.compileStatus = 'compiled';
        module.status = 'compiled';
    });
    yang.compileSequence += 1;
    yang.compiledAt = new Date().toISOString();
    yang.compiledModuleIds = targets.map(module => module.id);
    yang.schemaTree = tree;
    yang.diagnostics = [];
    yang.workspace = buildWorkspace(yang, { cacheHit });
    return clone(yang.workspace);
}

function currentWorkspace(yang) {
    if (!yang.workspace) yang.workspace = buildWorkspace(yang, { cacheHit: true });
    return clone(yang.workspace);
}

function emitSession(controller, yang) {
    controller.emitEvent('netconf:sessionEvent', successResponse(clone(yang.session), 'NETCONF 会话状态更新'));
}

function emitTask(controller, action, count, message) {
    const taskId = `e2e-${action}-${Date.now()}`;
    controller.emitEvent(
        'yang:taskProgress',
        successResponse({
            taskId,
            jobId: taskId,
            action,
            phase: 'completed',
            completed: count,
            total: count,
            percent: 100,
            counts: { [action === 'compile' ? 'compiled' : `${action}ed`]: count, failed: 0 },
            message
        })
    );
}

function makeImportedModule(name, revision, namespace, source) {
    return makeModule({
        id: `${name}@${revision}`,
        name,
        revision,
        namespace,
        isLocal: true,
        source
    });
}

function addOrUpdateModule(yang, module) {
    const index = yang.modules.findIndex(item => item.id === module.id);
    if (index >= 0) yang.modules.splice(index, 1, module);
    else yang.modules.push(module);
    return module;
}

function normalizeProfile(yang, input) {
    const existing = input?.id ? yang.profiles.find(profile => profile.id === input.id) : null;
    const id = existing?.id || input?.id || `e2e-netconf-profile-${yang.nextProfileId++}`;
    return {
        ...(existing || {}),
        ...(input || {}),
        id,
        port: Number(input?.port || existing?.port || 830),
        connectTimeout: Number(input?.connectTimeout || existing?.connectTimeout || 15000),
        keepaliveInterval: Number(input?.keepaliveInterval ?? existing?.keepaliveInterval ?? 30000),
        hasSavedCredentials: Boolean(input?.password || input?.privateKeyPath || existing?.hasSavedCredentials)
    };
}

function connectSession(controller, yang, target) {
    const profile =
        typeof target === 'string'
            ? yang.profiles.find(item => item.id === target)
            : normalizeProfile(yang, target || {});
    if (!profile) return errorResponse('连接 Profile 不存在');
    yang.connected = true;
    yang.session = {
        status: 'connected',
        state: 'connected',
        connected: true,
        profileId: profile.id,
        profileName: profile.name,
        host: profile.host,
        port: profile.port,
        baseVersion: '1.1',
        version: '1.1',
        sessionId: `e2e-session-${Date.now()}`,
        connectedAt: new Date().toISOString(),
        hostKeyFingerprint: profile.hostKeyFingerprint || 'SHA256:NetNexusE2EHostKey',
        capabilities: [...capabilities]
    };
    emitSession(controller, yang);
    return successResponse(clone(yang.session), 'NETCONF 连接成功');
}

function handleNetconfCall(controller, yang, method, args) {
    if (method === 'yang.netconf.listProfiles') return successResponse(yang.profiles.map(publicProfile));
    if (method === 'yang.netconf.saveProfile') {
        const profile = normalizeProfile(yang, args[0] || {});
        const index = yang.profiles.findIndex(item => item.id === profile.id);
        if (index >= 0) yang.profiles.splice(index, 1, profile);
        else yang.profiles.push(profile);
        return successResponse(publicProfile(profile), '连接 Profile 已保存');
    }
    if (method === 'yang.netconf.deleteProfile') {
        const profileId = args[0];
        yang.profiles = yang.profiles.filter(profile => profile.id !== profileId);
        if (yang.session.profileId === profileId) {
            yang.connected = false;
            yang.session = { status: 'disconnected', state: 'disconnected', connected: false, capabilities: [] };
            emitSession(controller, yang);
        }
        return successResponse(null, '连接 Profile 已删除');
    }
    if (method === 'yang.netconf.testConnection') {
        return successResponse({
            success: true,
            latency: 12,
            baseVersion: '1.1',
            sessionId: 'e2e-test-session',
            hostKeyFingerprint: args[0]?.hostKeyFingerprint || 'SHA256:NetNexusE2EHostKey',
            capabilities: [...capabilities]
        });
    }
    if (method === 'yang.netconf.connect') return connectSession(controller, yang, args[0]);
    if (method === 'yang.netconf.disconnect') {
        yang.connected = false;
        yang.session = {
            status: 'disconnected',
            state: 'disconnected',
            connected: false,
            profileId: args[0] || yang.session.profileId || '',
            capabilities: []
        };
        emitSession(controller, yang);
        return successResponse(clone(yang.session), 'NETCONF 连接已断开');
    }
    if (method === 'yang.netconf.getSessionState') return successResponse(clone(yang.session));
    if (method === 'yang.netconf.selectPrivateKey') {
        return successResponse({ filePath: '/tmp/netnexus-e2e/id_ed25519' });
    }
    if (method === 'yang.netconf.discoverModules') {
        if (!yang.connected) return errorResponse('请先建立 NETCONF 会话');
        const discovered = yang.modules.filter(module => !module.isLocal).map(publicModule);
        emitTask(controller, 'discover', discovered.length, `已从 YANG Library 读取 ${discovered.length} 个模块`);
        return successResponse({
            snapshotId: 'e2e-yang-library-snapshot',
            modules: discovered,
            source: 'ietf-yang-library'
        });
    }
    if (method === 'yang.netconf.downloadModules') {
        if (!yang.connected) return errorResponse('请先建立 NETCONF 会话');
        const request = args[0] || {};
        const identities = Array.isArray(request.modules) ? request.modules : [];
        const downloaded = [];
        identities.forEach(identity => {
            const module = findModule(yang, identity);
            if (!module) return;
            module.isLocal = true;
            module.source = 'download';
            module.status = 'downloaded';
            module.downloadStatus = 'downloaded';
            module.fileName = `${module.name}@${module.revision}.yang`;
            module.filePath = `/tmp/netnexus-e2e/yang/${module.name}@${module.revision}.yang`;
            module.contentHash = `e2e-${module.id}`;
            module.compileStatus = 'pending';
            module.compiled = false;
            downloaded.push(publicModule(module));
        });
        yang.workspace = null;
        emitTask(controller, 'download', downloaded.length, `已通过 get-schema 下载 ${downloaded.length} 个模块`);
        return successResponse({
            modules: downloaded,
            downloaded,
            includeDependencies: Boolean(request.includeDependencies)
        });
    }
    if (method === 'yang.netconf.executeOperation') return executeNetconfOperation(yang, args[0] || {});
    if (method === 'yang.netconf.sendRpc') return sendRawRpc(yang, args[0] || {});
    return null;
}

function rpcEnvelope(messageId, body) {
    return `<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${messageId}">${body}</rpc>`;
}

function pageDatastoreXml(includeOperational) {
    const operationalState = includeOperational ? '<in-octets>102400</in-octets>' : '';
    return (
        `<system xmlns="${PAGE_SYSTEM_NAMESPACE}"><hostname>netnexus-e2e</hostname></system>` +
        `<interfaces xmlns="${PAGE_INTERFACES_NAMESPACE}">` +
        `<interface><name>eth0</name><enabled>true</enabled>${operationalState}</interface>` +
        '</interfaces>'
    );
}

function filterPageDatastore(rpc, includeOperational) {
    return filterSubtreeXml(pageDatastoreXml(includeOperational), rpc, {
        keyDefinitions: PAGE_KEY_DEFINITIONS,
        passthroughUnsupported: true
    });
}

function readOperationFromRpc(rpc) {
    const root = findRoot(parseXml(rpc));
    if (!root) return null;
    if (root.name === 'get' || root.name === 'get-config') {
        return { name: root.name, messageId: null, operationXml: rpc };
    }
    if (root.name !== 'rpc') return null;
    const name =
        childValues(root.value, 'get-config').length > 0
            ? 'get-config'
            : childValues(root.value, 'get').length > 0
              ? 'get'
              : null;
    return name ? { name, messageId: getAttribute(root.value, 'message-id'), operationXml: rpc } : null;
}

function executeNetconfOperation(yang, request) {
    if (!yang.connected) return errorResponse('请先建立 NETCONF 会话');
    const operation = String(request.operation || 'get');
    const messageId = String(++yang.rpcSequence);
    let operationXml = `<${operation}/>`;
    let replyBody = '<ok/>';
    if (operation === 'get' || operation === 'get-config') {
        const readOptions = { ...request };
        delete readOptions.messageId;
        delete readOptions.wrap;
        operationXml = operation === 'get' ? buildGet(readOptions) : buildGetConfig(readOptions);
    }
    const rpc = rpcEnvelope(messageId, operationXml);
    if (operation === 'get' || operation === 'get-config') {
        replyBody = `<data>${filterPageDatastore(rpc, operation === 'get')}</data>`;
    }
    const reply = `<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${messageId}">${replyBody}</rpc-reply>`;
    const response = { operation, messageId, rpc, requestXml: rpc, reply, errors: [] };
    if (operation === 'get-config') Object.assign(response, rpcReplyDataToConfig(reply));
    return successResponse(response);
}

function sendRawRpc(yang, request) {
    if (!yang.connected) return errorResponse('请先建立 NETCONF 会话');
    const generatedMessageId = String(++yang.rpcSequence);
    const source = String(request.rpc || '').trim() || '<get/>';
    const readOperation = readOperationFromRpc(source);
    const messageId = String(readOperation?.messageId || generatedMessageId);
    const rpc = findRoot(parseXml(source))?.name === 'rpc' ? source : rpcEnvelope(messageId, source);
    const replyBody = readOperation
        ? `<data>${filterPageDatastore(rpc, readOperation.name === 'get')}</data>`
        : '<ok/>';
    const reply = `<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${messageId}">${replyBody}</rpc-reply>`;
    return successResponse({ messageId, rpc, requestXml: rpc, reply, errors: [] });
}

function handleRegistryCall(controller, yang, method, args) {
    if (method === 'yang.registry.listModules') {
        const query = typeof args[0] === 'string' ? args[0] : args[0]?.query || args[0]?.search || '';
        const normalizedQuery = String(query).trim().toLowerCase();
        const modules = normalizedQuery
            ? yang.modules.filter(module =>
                  [module.name, module.namespace, module.revision].some(value =>
                      String(value || '')
                          .toLowerCase()
                          .includes(normalizedQuery)
                  )
              )
            : yang.modules;
        return successResponse({ modules: modules.map(publicModule) });
    }
    if (method === 'yang.registry.selectFiles') {
        return successResponse({ filePaths: ['/tmp/netnexus-e2e/import/netnexus-demo.yang'], canceled: false });
    }
    if (method === 'yang.registry.selectDirectory') {
        return successResponse({ directoryPath: '/tmp/netnexus-e2e/import', canceled: false });
    }
    if (method === 'yang.registry.importFiles') {
        const imported = addOrUpdateModule(
            yang,
            makeImportedModule('netnexus-demo', '2026-01-01', 'urn:netnexus:e2e:demo', 'import')
        );
        imported.imported = true;
        yang.workspace = null;
        emitTask(controller, 'import', 1, 'YANG 文件导入完成');
        return successResponse({ imported: [publicModule(imported)], modules: [publicModule(imported)], failed: [] });
    }
    if (method === 'yang.registry.importDirectory') {
        const imported = addOrUpdateModule(
            yang,
            makeImportedModule('vendor-system', '2026-02-02', 'urn:netnexus:e2e:vendor-system', 'import')
        );
        imported.imported = true;
        yang.workspace = null;
        emitTask(controller, 'import', 1, 'YANG 目录扫描与导入完成');
        return successResponse({ imported: [publicModule(imported)], modules: [publicModule(imported)], failed: [] });
    }
    if (method === 'yang.registry.getCompilerStatus') return successResponse(clone(yang.compiler));
    if (method === 'yang.registry.compile') {
        if (!yang.compiler.available) {
            return errorResponse(yang.compiler.message || '内置 libyang/yanglint 运行时不可用，无法执行权威 YANG 编译');
        }
        const request = args[0] || {};
        const identities = Array.isArray(request.moduleIds) ? request.moduleIds : [];
        const targets = identities.length
            ? yang.modules.filter(
                  module => module.isLocal && identities.some(identity => moduleMatchesIdentity(module, identity))
              )
            : yang.modules.filter(module => module.isLocal);
        const workspace = compileWorkspace(yang, targets);
        emitTask(controller, 'compile', targets.length, 'YANG 编译与 Schema 索引完成');
        return successResponse(workspace);
    }
    if (method === 'yang.registry.clearWorkspace') {
        yang.schemaTree = null;
        yang.compiledModuleIds = [];
        yang.compiledAt = '';
        yang.diagnostics = [];
        yang.modules.forEach(module => {
            module.compiled = false;
            module.compileStatus = 'pending';
            if (module.isLocal) module.status = 'downloaded';
        });
        yang.workspace = buildWorkspace(yang);
        return successResponse(null, 'Schema 工作区已清空');
    }
    if (method === 'yang.registry.getWorkspace') return successResponse(currentWorkspace(yang));
    if (method === 'yang.registry.getSchemaRoots') {
        return successResponse({
            nodes: (yang.schemaTree?.roots || []).map(nodeId => schemaNodeSummary(yang, nodeId)).filter(Boolean)
        });
    }
    if (method === 'yang.registry.getSchemaChildren') {
        const parentId = args[0]?.parentId || args[0]?.nodeId || yang.schemaTree?.rootId;
        const nodes = (yang.schemaTree?.childIndex?.[parentId] || [])
            .map(nodeId => schemaNodeSummary(yang, nodeId))
            .filter(Boolean);
        return successResponse({ nodes, children: nodes });
    }
    if (method === 'yang.registry.getSchemaNode') {
        const node = schemaNodeSummary(yang, args[0]?.nodeId);
        return node ? successResponse(node) : errorResponse('Schema 节点不存在');
    }
    if (method === 'yang.registry.getModuleSource') {
        const module = findModule(yang, args[0]);
        if (!module) return errorResponse('YANG 模块不存在');
        return successResponse({ source: yang.moduleSources[module.name] || '', module: publicModule(module) });
    }
    if (method === 'yang.registry.getDiagnostics') {
        return successResponse({ diagnostics: clone(yang.diagnostics) });
    }
    return null;
}

function handlePageCall(controller, method, args) {
    const yang = controller.state.yang;
    const netconfResponse = handleNetconfCall(controller, yang, method, args);
    if (netconfResponse) return netconfResponse;
    const registryResponse = handleRegistryCall(controller, yang, method, args);
    if (registryResponse) return registryResponse;
    return errorResponse(`Unsupported NETCONF/YANG E2E method: ${method}`);
}

module.exports = {
    createYangPageState,
    handlePageCall,
    yangPageApiScript
};
