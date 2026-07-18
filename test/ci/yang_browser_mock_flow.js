const assert = require('assert');
const vm = require('vm');
const { featurePageBrowserMockScript } = require('../../scripts/e2e-support/page-browser-mocks');
const { FeaturePageE2eController } = require('../../scripts/e2e-support/page-controller');

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
    await window.yangApi.getSchemaChildren({ nodeId: 'schema:interfaces' });
    assert.deepStrictEqual(calls[0], {
        method: 'yang.netconf.executeOperation',
        args: [{ operation: 'get' }]
    });
    assert.deepStrictEqual(calls[1], {
        method: 'yang.registry.getSchemaChildren',
        args: [{ nodeId: 'schema:interfaces' }]
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
    assert.match(response.data.version, /e2e/u);

    response = await controller.call('yang.registry.compile', {});
    assert.equal(response.status, 'success');
    assert.match(response.data.compileId, /^e2e-compile-/u);
    assert(response.data.summary.moduleCount >= 5);
    assert(response.data.schemaTree.roots.length > 0);
    assert.equal(response.data.compiler.available, true);

    response = await controller.call('yang.registry.getSchemaChildren', { nodeId: 'schema:interfaces' });
    assert.equal(response.status, 'success');
    assert.equal(response.data.nodes[0].name, 'interface');
    response = await controller.call('yang.registry.getSchemaNode', { nodeId: 'schema:interface:name' });
    assert.equal(response.data.type, 'string');
    response = await controller.call('yang.registry.getModuleSource', { name: 'ietf-interfaces' });
    assert.match(response.data.source, /container interfaces/u);

    response = await controller.call('yang.netconf.executeOperation', { operation: 'get' });
    assert.equal(response.status, 'success');
    assert.match(response.data.rpc, /<get\/>/u);
    assert.match(response.data.reply, /<interfaces/u);
    response = await controller.call('yang.netconf.sendRpc', { rpc: '<rpc message-id="42"><commit/></rpc>' });
    assert.equal(response.status, 'success');
    assert.match(response.data.reply, /<ok\/>/u);

    assert(events.some(event => event.type === 'netconf:sessionEvent'));
    const taskActions = events
        .filter(event => event.type === 'yang:taskProgress')
        .map(event => event.data?.data?.action);
    ['discover', 'download', 'import', 'compile'].forEach(action => assert(taskActions.includes(action), action));

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
