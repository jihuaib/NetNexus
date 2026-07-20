const assert = require('assert');
const vm = require('vm');
const { featurePageBrowserMockScript } = require('../../scripts/e2e-support/page-browser-mocks');
const { FeaturePageE2eController } = require('../../scripts/e2e-support/page-controller');
const { getReleaseManifest } = require('../../scripts/libyang-runtime-config');

const BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const INTERFACES_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const SYSTEM_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-system';

async function verifyBrowserBridge() {
    const calls = [];
    const window = {
        __featureE2eCall: async (method, ...args) => {
            calls.push({ method, args });
            return { status: 'success', data: { method } };
        }
    };
    vm.runInNewContext(featurePageBrowserMockScript, {
        window,
        MessageChannel,
        setTimeout,
        clearTimeout
    });

    const requiredNetconfMethods = [
        'listProfiles',
        'saveProfile',
        'deleteProfile',
        'testConnection',
        'connect',
        'disconnect',
        'getSessionState',
        'getSubscriptions',
        'selectPrivateKey',
        'discoverModules',
        'downloadModules',
        'executeOperation',
        'sendRpc'
    ];
    const requiredYangMethods = [
        'listModules',
        'selectFiles',
        'selectDirectory',
        'importFiles',
        'importDirectory',
        'getCompilerStatus',
        'compile',
        'clearWorkspace',
        'getWorkspace',
        'getSchemaRoots',
        'getSchemaChildren',
        'getSchemaNode',
        'getModuleSource',
        'getDiagnostics'
    ];

    requiredNetconfMethods.forEach(method => assert.equal(typeof window.netconfApi[method], 'function', method));
    requiredYangMethods.forEach(method => assert.equal(typeof window.yangApi[method], 'function', method));

    await window.netconfApi.executeOperation({ operation: 'get' });
    await window.yangApi.getSchemaChildren({ nodeId: 'yang-node-test-id' });
    assert.deepStrictEqual(calls[0], {
        method: 'yang.netconf.executeOperation',
        args: [{ operation: 'get' }]
    });
    assert.deepStrictEqual(calls[1], {
        method: 'yang.registry.getSchemaChildren',
        args: [{ nodeId: 'yang-node-test-id' }]
    });
}

async function verifyControllerFlow() {
    const controller = new FeaturePageE2eController();
    const events = [];
    controller.onEvent(event => events.push(event));

    let response = await controller.call('yang.netconf.getSessionState');
    assert.equal(response.status, 'success');
    assert.equal(response.data.connected, true);
    assert(response.data.capabilities.some(capability => capability.includes('yang-library')));

    response = await controller.call('yang.netconf.disconnect');
    assert.equal(response.data.connected, false);
    response = await controller.call('yang.netconf.discoverModules');
    assert.equal(response.status, 'error');

    response = await controller.call('yang.netconf.connect', 'e2e-netconf-profile');
    assert.equal(response.status, 'success');
    assert.equal(response.data.connected, true);

    response = await controller.call('yang.netconf.saveProfile', {
        name: 'Second E2E Device',
        host: '198.51.100.20',
        port: 830,
        username: 'netconf',
        password: 'must-not-be-returned',
        rememberCredentials: true
    });
    assert.equal(response.status, 'success');
    assert(response.data.id);
    assert.equal(response.data.password, undefined);
    assert.equal(response.data.hasSavedCredentials, true);

    response = await controller.call('yang.netconf.discoverModules');
    assert.equal(response.status, 'success');
    assert(response.data.modules.some(module => module.name === 'ietf-system'));

    response = await controller.call('yang.netconf.downloadModules', {
        modules: [{ name: 'ietf-system', revision: '2014-08-06' }],
        includeDependencies: true
    });
    assert.equal(response.status, 'success');
    assert.equal(response.data.downloaded[0].isLocal, true);

    response = await controller.call('yang.registry.importFiles', ['/tmp/netnexus-demo.yang']);
    assert.equal(response.status, 'success');
    assert.equal(response.data.imported[0].name, 'netnexus-demo');
    response = await controller.call('yang.registry.importDirectory', '/tmp/netnexus-e2e/import');
    assert.equal(response.data.imported[0].name, 'vendor-system');

    response = await controller.call('yang.registry.getCompilerStatus');
    assert.equal(response.status, 'success');
    assert.equal(response.data.available, true);
    assert.equal(response.data.engine, 'libyang');
    assert.equal(response.data.version, getReleaseManifest().libyangVersion);
    assert.equal(response.data.schemaContractVersion, 2);
    assert.equal(response.data.source, 'bundled');

    response = await controller.call('yang.registry.compile', {});
    assert.equal(response.status, 'success');
    assert.match(response.data.compileId, /^e2e-compile-/u);
    assert(response.data.summary.moduleCount >= 5);
    assert(response.data.schemaTree.roots.length > 0);
    assert.equal(response.data.schemaTree.authoritative, true);
    assert.equal(response.data.schemaTree.source, 'libyang-effective');
    assert.equal(response.data.schemaTree.scope, 'core-effective-schema');
    assert.equal(response.data.compiler.available, true);

    const interfaceModule = response.data.schemaTree.roots.find(root => root.name === 'ietf-interfaces');
    assert(interfaceModule);
    assert.match(interfaceModule.id, /^yang-module-/u);
    response = await controller.call('yang.registry.getSchemaChildren', { nodeId: interfaceModule.id });
    assert.equal(response.status, 'success');
    const interfaces = response.data.nodes.find(node => node.name === 'interfaces');
    assert(interfaces);
    response = await controller.call('yang.registry.getSchemaChildren', { nodeId: interfaces.id });
    const interfaceList = response.data.nodes.find(node => node.name === 'interface');
    assert(interfaceList);
    response = await controller.call('yang.registry.getSchemaChildren', { nodeId: interfaceList.id });
    const nameLeaf = response.data.nodes.find(node => node.name === 'name');
    assert(nameLeaf);
    response = await controller.call('yang.registry.getSchemaNode', { nodeId: nameLeaf.id });
    assert.equal(response.data.type, 'string');
    assert.equal(response.data.mandatory, false);
    response = await controller.call('yang.registry.getModuleSource', { name: 'ietf-interfaces' });
    assert.match(response.data.source, /container interfaces/u);

    response = await controller.call('yang.netconf.executeOperation', { operation: 'get' });
    assert.equal(response.status, 'success');
    assert.match(response.data.rpc, /<get><\/get>/u);
    assert.match(response.data.reply, /<interfaces/u);

    response = await controller.call('yang.netconf.executeOperation', {
        operation: 'create-subscription',
        stream: 'NETCONF',
        filter: {
            type: 'subtree',
            content: `<interface-event xmlns="${INTERFACES_NAMESPACE}"/>`
        }
    });
    assert.equal(response.status, 'success');
    assert.match(response.data.rpc, /create-subscription/u);
    response = await controller.call('yang.netconf.getSubscriptions', 'e2e-netconf-profile');
    assert.equal(response.data.subscriptions.length, 1);
    assert.equal(response.data.subscriptions[0].state, 'active');

    response = await controller.call('yang.netconf.executeOperation', {
        operation: 'get',
        filter: {
            type: 'subtree',
            content:
                `<interfaces xmlns="${INTERFACES_NAMESPACE}"><interface>` +
                '<name>eth0</name><in-octets/></interface></interfaces>'
        }
    });
    assert.match(response.data.rpc, /<filter type="subtree">/u);
    assert.match(response.data.reply, /<name>eth0<\/name><in-octets>102400<\/in-octets>/u);
    assert.doesNotMatch(response.data.reply, /<(?:enabled|system)(?:\s|>)/u);

    response = await controller.call('yang.netconf.executeOperation', {
        operation: 'get-config',
        source: 'running',
        filter: {
            type: 'subtree',
            content:
                `<interfaces xmlns="${INTERFACES_NAMESPACE}"><interface>` +
                '<name>missing0</name><enabled/></interface></interfaces>'
        }
    });
    assert.match(response.data.rpc, /<get-config><source><running\/><\/source>/u);
    assert.match(response.data.reply, /<data><\/data>/u);
    assert.doesNotMatch(response.data.reply, /<(?:interfaces|in-octets)(?:\s|>)/u);

    const prefixedRawGet =
        `<nc:rpc xmlns:nc="${BASE_NAMESPACE}" message-id="42"><nc:get>` +
        '<nc:filter type="subtree">' +
        `<sys:system xmlns:sys="${SYSTEM_NAMESPACE}"><sys:hostname/></sys:system>` +
        '</nc:filter></nc:get></nc:rpc>';
    response = await controller.call('yang.netconf.sendRpc', { rpc: prefixedRawGet });
    assert.equal(response.data.messageId, '42');
    assert.match(response.data.reply, /<system xmlns="urn:ietf:params:xml:ns:yang:ietf-system">/u);
    assert.match(response.data.reply, /<hostname>netnexus-e2e<\/hostname>/u);
    assert.doesNotMatch(response.data.reply, /<interfaces(?:\s|>)/u);

    response = await controller.call('yang.netconf.sendRpc', { rpc: '<rpc message-id="42"><commit/></rpc>' });
    assert.equal(response.status, 'success');
    assert.match(response.data.reply, /<ok\/>/u);

    assert(events.some(event => event.type === 'netconf:sessionEvent'));
    const taskActions = events
        .filter(event => event.type === 'yang:taskProgress')
        .map(event => event.data?.data?.action);
    ['discover', 'download', 'import', 'compile'].forEach(action => assert(taskActions.includes(action), action));

    const validInterfaceSource = controller.state.yang.moduleSources['ietf-interfaces'];
    controller.state.yang.moduleSources['ietf-interfaces'] = validInterfaceSource.replace(
        'leaf name { type string; }',
        'leaf name { type netnexus-missing-type; }'
    );
    const successfulCompileId = controller.state.yang.workspace.compileId;
    response = await controller.call('yang.registry.compile', {
        moduleIds: [{ name: 'ietf-interfaces', revision: '2018-02-20' }]
    });
    assert.equal(response.status, 'error');
    assert.match(response.msg, /libyang effective Schema 编译失败/u);
    assert.equal(controller.state.yang.workspace.compileId, successfulCompileId);
    controller.state.yang.moduleSources['ietf-interfaces'] = validInterfaceSource;

    response = await controller.call('yang.registry.clearWorkspace');
    assert.equal(response.status, 'success');
    response = await controller.call('yang.registry.getWorkspace');
    assert.equal(response.data.summary.nodeCount, 0);

    controller.state.yang.compiler = {
        ...controller.state.yang.compiler,
        available: false,
        status: 'unavailable',
        message: '内置 yanglint 文件缺失'
    };
    response = await controller.call('yang.registry.compile', {});
    assert.equal(response.status, 'error');
    assert.match(response.msg, /yanglint/u);
}

(async () => {
    await verifyBrowserBridge();
    await verifyControllerFlow();
    console.log('NETCONF/YANG feature-page browser mock flow tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
