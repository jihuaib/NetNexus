const dgram = require('dgram');
const net = require('net');

function successResponse(data = null, msg = '') {
    return { status: 'success', msg, data };
}

function errorResponse(msg = '', data = null) {
    return { status: 'error', msg, data };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
    return new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
}

async function getFreeTcpPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function getFreeUdpPort() {
    const socket = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, '127.0.0.1', resolve);
    });
    const { port } = socket.address();
    await new Promise(resolve => socket.close(resolve));
    return port;
}

function buildFeaturePageBrowserMockScript(featureApiScripts) {
    return [
        '(function installFeaturePageApiMocks() {',
        '    const unifiedCallbacks = [];',
        '    const call = (method, ...args) => window.__featureE2eCall(method, ...args);',
        '    window.__featureE2eEmit = (type, data) => {',
        '        unifiedCallbacks.forEach(callback => callback({ type, data }));',
        '    };',
        '    window.commonApi = {',
        '        onUnifiedEvent: callback => {',
        '            unifiedCallbacks.push(callback);',
        '            return () => {',
        '                const index = unifiedCallbacks.indexOf(callback);',
        '                if (index >= 0) unifiedCallbacks.splice(index, 1);',
        '            };',
        '        },',
        '        notifyRendererReady: () => {},',
        "        getGeneralSettings: async () => ({ status: 'success', data: null }),",
        "        saveGeneralSettings: async data => ({ status: 'success', data }),",
        "        getToolsSettings: async () => ({ status: 'success', data: null }),",
        "        saveToolsSettings: async data => ({ status: 'success', data }),",
        '        getWiresharkBmpPluginStatus: async () => ({',
        "            status: 'success',",
        '            data: { sourceExists: true, installed: false, upToDate: false }',
        '        }),',
        "        selectDirectory: () => call('common.selectDirectory'),",
        '        openDeveloperOptions: () => {},',
        '        openSoftwareInfo: () => {}',
        '    };',
        '    window.__featureMonitorRequests = [];',
        '    window.__featureMonitorRequestDetails = [];',
        '    window.windowApi = {',
        '        openMonitor: async (monitorId, options) => {',
        '            window.__featureMonitorRequests.push(monitorId);',
        '            window.__featureMonitorRequestDetails.push({ monitorId, options: options || null });',
        '            return {',
        "                status: 'success',",
        "                msg: 'monitor opened',",
        '                data: { monitorId, reused: false }',
        '            };',
        '        },',
        "        subscribeEventScope: async scopeId => ({ status: 'success', data: { scopeId } }),",
        "        unsubscribeEventScope: async scopeId => ({ status: 'success', data: { scopeId } })",
        '    };',
        ...featureApiScripts,
        '})();'
    ].join('\n');
}

module.exports = {
    buildFeaturePageBrowserMockScript,
    delay,
    errorResponse,
    getFreeTcpPort,
    getFreeUdpPort,
    successResponse,
    timestamp
};
