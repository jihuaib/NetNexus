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
        filePath: isLocal ? `/tmp/netnexus-e2e/yang/${name}@${revision}.yang` : '',
        contentHash: isLocal ? `e2e-${id}` : '',
        compiled: isLocal,
        compileStatus: isLocal ? 'compiled' : 'pending'
    };
}

function createSchemaNodes() {
    return {
        'schema:interfaces': {
            id: 'schema:interfaces',
            name: 'interfaces',
            title: 'interfaces',
            keyword: 'container',
            module: 'ietf-interfaces',
            path: '/ietf-interfaces:interfaces',
            config: true,
            description: 'Interface configuration and operational state.',
            hasChildren: true,
            childCount: 1,
            childIds: ['schema:interface']
        },
        'schema:interface': {
            id: 'schema:interface',
            name: 'interface',
            title: 'interface',
            keyword: 'list',
            module: 'ietf-interfaces',
            path: '/ietf-interfaces:interfaces/interface',
            config: true,
            description: 'A configured interface.',
            hasChildren: true,
            childCount: 3,
            childIds: ['schema:interface:name', 'schema:interface:enabled', 'schema:interface:in-octets']
        },
        'schema:interface:name': {
            id: 'schema:interface:name',
            name: 'name',
            title: 'name',
            keyword: 'leaf',
            module: 'ietf-interfaces',
            path: '/ietf-interfaces:interfaces/interface/name',
            type: 'string',
            config: true,
            mandatory: true,
            description: 'The interface name.',
            hasChildren: false,
            childCount: 0,
            childIds: []
        },
        'schema:interface:enabled': {
            id: 'schema:interface:enabled',
            name: 'enabled',
            title: 'enabled',
            keyword: 'leaf',
            module: 'ietf-interfaces',
            path: '/ietf-interfaces:interfaces/interface/enabled',
            type: 'boolean',
            default: true,
            config: true,
            description: 'Controls whether the interface is enabled.',
            hasChildren: false,
            childCount: 0,
            childIds: []
        },
        'schema:interface:in-octets': {
            id: 'schema:interface:in-octets',
            name: 'in-octets',
            title: 'in-octets',
            keyword: 'leaf',
            module: 'ietf-interfaces',
            path: '/ietf-interfaces:interfaces/interface/in-octets',
            type: 'yang:counter32',
            config: false,
            description: 'Number of octets received on the interface.',
            hasChildren: false,
            childCount: 0,
            childIds: []
        },
        'schema:system': {
            id: 'schema:system',
            name: 'system',
            title: 'system',
            keyword: 'container',
            module: 'ietf-system',
            path: '/ietf-system:system',
            config: true,
            description: 'System configuration.',
            hasChildren: true,
            childCount: 1,
            childIds: ['schema:system:hostname']
        },
        'schema:system:hostname': {
            id: 'schema:system:hostname',
            name: 'hostname',
            title: 'hostname',
            keyword: 'leaf',
            module: 'ietf-system',
            path: '/ietf-system:system/hostname',
            type: 'string',
            config: true,
            hasChildren: false,
            childCount: 0,
            childIds: []
        }
    };
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
    return {
        profiles: [profile],
        nextProfileId: 2,
        connected: true,
        rpcSequence: 100,
        compileSequence: 1,
        modules,
        schemaNodes: createSchemaNodes(),
        rootNodeIds: ['schema:interfaces'],
        diagnostics: [],
        compiler: {
            available: true,
            required: true,
            status: 'ready',
            engine: 'libyang',
            executable: 'yanglint',
            version: '3.13.6-e2e',
            path: '/opt/netnexus/runtime/libyang/bin/yanglint',
            bundled: true
        },
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
    const node = yang.schemaNodes[nodeId];
    if (!node) return null;
    const result = clone(node);
    delete result.childIds;
    return result;
}

function buildWorkspace(yang, { cacheHit = false } = {}) {
    const localModules = yang.modules.filter(module => module.isLocal);
    const roots = yang.rootNodeIds.map(nodeId => schemaNodeSummary(yang, nodeId)).filter(Boolean);
    return {
        compileId: `e2e-compile-${yang.compileSequence}`,
        cacheHit,
        compiler: clone(yang.compiler),
        summary: {
            moduleCount: localModules.length,
            nodeCount: Object.keys(yang.schemaNodes).length,
            diagnosticCount: yang.diagnostics.length,
            cacheHit
        },
        modules: localModules.map(publicModule),
        diagnostics: clone(yang.diagnostics),
        schemaTree: {
            roots,
            nodeCount: Object.keys(yang.schemaNodes).length,
            authoritative: false,
            source: 'builtin-preview'
        }
    };
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

function executeNetconfOperation(yang, request) {
    if (!yang.connected) return errorResponse('请先建立 NETCONF 会话');
    const operation = String(request.operation || 'get');
    const messageId = String(++yang.rpcSequence);
    let operationXml = `<${operation}/>`;
    let replyBody = '<ok/>';
    if (operation === 'get' || operation === 'get-config') {
        operationXml = `<${operation}/>`;
        replyBody =
            '<data><interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"><interface>' +
            '<name>eth0</name><enabled>true</enabled><in-octets>102400</in-octets>' +
            '</interface></interfaces></data>';
    }
    const rpc = rpcEnvelope(messageId, operationXml);
    const reply = `<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${messageId}">${replyBody}</rpc-reply>`;
    return successResponse({ operation, messageId, rpc, reply, errors: [] });
}

function sendRawRpc(yang, request) {
    if (!yang.connected) return errorResponse('请先建立 NETCONF 会话');
    const messageId = String(++yang.rpcSequence);
    const rpc = String(request.rpc || '').trim() || rpcEnvelope(messageId, '<get/>');
    const dataReply = /<(?:[\w-]+:)?get(?:[\s>])/u.test(rpc)
        ? '<data><system xmlns="urn:ietf:params:xml:ns:yang:ietf-system"><hostname>netnexus-e2e</hostname></system></data>'
        : '<ok/>';
    const reply = `<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${messageId}">${dataReply}</rpc-reply>`;
    return successResponse({ messageId, rpc, reply, errors: [] });
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
            ? yang.modules.filter(module => identities.some(identity => moduleMatchesIdentity(module, identity)))
            : yang.modules.filter(module => module.isLocal);
        targets.forEach(module => {
            if (!module.isLocal) return;
            module.compiled = true;
            module.compileStatus = 'compiled';
            module.status = 'compiled';
        });
        yang.compileSequence += 1;
        yang.workspace = buildWorkspace(yang);
        emitTask(controller, 'compile', targets.filter(module => module.isLocal).length, 'YANG 编译与 Schema 索引完成');
        return successResponse(currentWorkspace(yang));
    }
    if (method === 'yang.registry.clearWorkspace') {
        yang.workspace = {
            compileId: '',
            cacheHit: false,
            compiler: clone(yang.compiler),
            summary: { moduleCount: 0, nodeCount: 0, diagnosticCount: 0, cacheHit: false },
            modules: [],
            diagnostics: [],
            schemaTree: { roots: [], nodeCount: 0, authoritative: false, source: 'builtin-preview' }
        };
        return successResponse(null, 'Schema 工作区已清空');
    }
    if (method === 'yang.registry.getWorkspace') return successResponse(currentWorkspace(yang));
    if (method === 'yang.registry.getSchemaRoots') {
        return successResponse({
            nodes: yang.rootNodeIds.map(nodeId => schemaNodeSummary(yang, nodeId)).filter(Boolean)
        });
    }
    if (method === 'yang.registry.getSchemaChildren') {
        const node = yang.schemaNodes[args[0]?.nodeId];
        const nodes = (node?.childIds || []).map(nodeId => schemaNodeSummary(yang, nodeId)).filter(Boolean);
        return successResponse({ nodes, children: nodes });
    }
    if (method === 'yang.registry.getSchemaNode') {
        const node = schemaNodeSummary(yang, args[0]?.nodeId);
        return node ? successResponse(node) : errorResponse('Schema 节点不存在');
    }
    if (method === 'yang.registry.getModuleSource') {
        const module = findModule(yang, args[0]);
        if (!module) return errorResponse('YANG 模块不存在');
        return successResponse({ source: moduleSources[module.name] || '', module: publicModule(module) });
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
