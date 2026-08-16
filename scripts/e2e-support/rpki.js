const { delay, errorResponse, successResponse } = require('./common');

const rpkiBrowserMockScript =
    "(function installRpkiApiMocks() {\n    const unifiedCallbacks = [];\n\n    window.__rpkiE2eEmit = (type, data) => {\n        unifiedCallbacks.forEach(callback => callback({ type, data }));\n    };\n\n    window.commonApi = {\n        onUnifiedEvent: callback => {\n            unifiedCallbacks.push(callback);\n            return () => {\n                const index = unifiedCallbacks.indexOf(callback);\n                if (index >= 0) {\n                    unifiedCallbacks.splice(index, 1);\n                }\n            };\n        },\n        notifyRendererReady: () => {},\n        openDeveloperOptions: () => {},\n        openSoftwareInfo: () => {}\n    };\n\n    window.rpkiApi = {\n        saveRpkiConfig: config => window.__rpkiE2eCall('saveRpkiConfig', config),\n        loadRpkiConfig: () => window.__rpkiE2eCall('loadRpkiConfig'),\n        startRpki: config => window.__rpkiE2eCall('startRpki', config),\n        stopRpki: () => window.__rpkiE2eCall('stopRpki'),\n        addRoa: roa => window.__rpkiE2eCall('addRoa', roa),\n        deleteRoa: roa => window.__rpkiE2eCall('deleteRoa', roa),\n        deleteAllRoa: () => window.__rpkiE2eCall('deleteAllRoa'),\n        getRoaList: query => window.__rpkiE2eCall('getRoaList', query),\n        selectRoaJsonFile: () => window.__rpkiE2eCall('selectRoaJsonFile'),\n        importRoaJson: options => window.__rpkiE2eCall('importRoaJson', options),\n        getClientList: () => window.__rpkiE2eCall('getClientList'),\n        addRouterKey: routerKey => window.__rpkiE2eCall('addRouterKey', routerKey),\n        deleteRouterKey: routerKey => window.__rpkiE2eCall('deleteRouterKey', routerKey),\n        getRouterKeyList: () => window.__rpkiE2eCall('getRouterKeyList'),\n        addAspa: aspa => window.__rpkiE2eCall('addAspa', aspa),\n        deleteAspa: aspa => window.__rpkiE2eCall('deleteAspa', aspa),\n        deleteAllAspa: () => window.__rpkiE2eCall('deleteAllAspa'),\n        selectAspaJsonFile: () => window.__rpkiE2eCall('selectAspaJsonFile'),\n        importAspaJson: options => window.__rpkiE2eCall('importAspaJson', options),\n        getAspaList: query => window.__rpkiE2eCall('getAspaList', query)\n    };\n})();\n";

const rpkiPageApiScript =
    "    window.rpkiApi = {\n        saveRpkiConfig: config => call('rpki.saveRpkiConfig', config),\n        loadRpkiConfig: () => call('rpki.loadRpkiConfig'),\n        startRpki: config => call('rpki.startRpki', config),\n        stopRpki: () => call('rpki.stopRpki'),\n        addRoa: roa => call('rpki.addRoa', roa),\n        deleteRoa: roa => call('rpki.deleteRoa', roa),\n        deleteAllRoa: () => call('rpki.deleteAllRoa'),\n        getRoaList: query => call('rpki.getRoaList', query),\n        selectRoaJsonFile: () => call('rpki.selectRoaJsonFile'),\n        importRoaJson: options => call('rpki.importRoaJson', options),\n        getClientList: () => call('rpki.getClientList'),\n        addRouterKey: routerKey => call('rpki.addRouterKey', routerKey),\n        deleteRouterKey: routerKey => call('rpki.deleteRouterKey', routerKey),\n        getRouterKeyList: () => call('rpki.getRouterKeyList'),\n        addAspa: aspa => call('rpki.addAspa', aspa),\n        deleteAspa: aspa => call('rpki.deleteAspa', aspa),\n        deleteAllAspa: () => call('rpki.deleteAllAspa'),\n        selectAspaJsonFile: () => call('rpki.selectAspaJsonFile'),\n        importAspaJson: options => call('rpki.importAspaJson', options),\n        getAspaList: query => call('rpki.getAspaList', query)\n    };";

function createRpkiPageState() {
    return {
        running: true,
        config: { port: '1280', maxProtocolVersion: 2 },
        clients: [
            {
                localIp: '127.0.0.1',
                localPort: 1280,
                remoteIp: '192.0.2.10',
                remotePort: 30000,
                version: 2,
                status: '已连接'
            }
        ],
        roas: [{ ipType: 1, asn: '65000', ip: '203.0.113.0', mask: '24', maxLength: '24' }],
        roaListCalls: 0,
        roaListDelayMs: 0,
        roaListError: '',
        routerKeys: [
            {
                ski: '0123456789ABCDEF0123456789ABCDEF01234567',
                asn: '65000',
                spki: '3059301306072A8648CE3D020106082A8648CE3D03010703420004'
            }
        ],
        aspas: [{ customerAsn: '65010', providerAsns: [65011, 65012], afiFlags: 3, format: 'latest' }],
        aspaListCalls: 0,
        aspaListDelayMs: 0,
        aspaListError: ''
    };
}

async function handlePageCall(controller, method, args) {
    const rpki = controller.state.rpki;
    if (method === 'rpki.loadRpkiConfig') return successResponse(rpki.config);
    if (method === 'rpki.saveRpkiConfig') {
        rpki.config = args[0];
        return successResponse(null);
    }
    if (method === 'rpki.startRpki') {
        rpki.running = true;
        controller.emitEvent('rpki:runtimeChanged', { running: true });
        return successResponse(null, 'RPKI启动成功');
    }
    if (method === 'rpki.stopRpki') {
        rpki.running = false;
        controller.emitEvent('rpki:runtimeChanged', { running: false });
        return successResponse(null, 'RPKI停止成功');
    }
    if (method === 'rpki.getClientList') return successResponse(rpki.running ? rpki.clients : []);
    if (method === 'rpki.getRoaList') {
        rpki.roaListCalls += 1;
        const response =
            !rpki.running || rpki.roaListError
                ? errorResponse(rpki.roaListError || 'RPKI未启动')
                : successResponse({
                      items: rpki.roas.map(roa => ({ ...roa })),
                      page: 1,
                      pageSize: 20,
                      total: rpki.roas.length,
                      storageTotal: rpki.roas.length
                  });
        if (rpki.roaListDelayMs > 0) await delay(rpki.roaListDelayMs);
        return response;
    }
    if (method === 'rpki.addRoa') {
        if (!rpki.running) return errorResponse('RPKI未启动');
        rpki.roas.push(args[0]);
        return successResponse(null);
    }
    if (method === 'rpki.deleteRoa') {
        if (!rpki.running) return errorResponse('RPKI未启动');
        return successResponse(null);
    }
    if (method === 'rpki.deleteAllRoa') {
        if (!rpki.running) return errorResponse('RPKI未启动');
        const deleted = rpki.roas.length;
        rpki.roas = [];
        return successResponse({ deleted });
    }
    if (method === 'rpki.getRouterKeyList') return successResponse(rpki.routerKeys);
    if (method === 'rpki.addRouterKey') {
        rpki.routerKeys.push(args[0]);
        return successResponse(null);
    }
    if (method === 'rpki.deleteRouterKey') return successResponse(null);
    if (method === 'rpki.getAspaList') {
        rpki.aspaListCalls += 1;
        const response =
            !rpki.running || rpki.aspaListError
                ? errorResponse(rpki.aspaListError || 'RPKI未启动')
                : successResponse({
                      items: rpki.aspas.map(aspa => ({ ...aspa, providerAsns: [...aspa.providerAsns] })),
                      page: 1,
                      pageSize: 20,
                      total: rpki.aspas.length,
                      storageTotal: rpki.aspas.length
                  });
        if (rpki.aspaListDelayMs > 0) await delay(rpki.aspaListDelayMs);
        return response;
    }
    if (method === 'rpki.addAspa') {
        if (!rpki.running) return errorResponse('RPKI未启动');
        rpki.aspas.push(args[0]);
        return successResponse(null);
    }
    if (method === 'rpki.deleteAspa') {
        if (!rpki.running) return errorResponse('RPKI未启动');
        return successResponse(null);
    }
    if (method === 'rpki.deleteAllAspa') {
        if (!rpki.running) return errorResponse('RPKI未启动');
        const deleted = rpki.aspas.length;
        rpki.aspas = [];
        return successResponse({ deleted });
    }
    if (method === 'rpki.importRoaJson' || method === 'rpki.importAspaJson') {
        return rpki.running ? successResponse(null) : errorResponse('RPKI未启动');
    }
    return successResponse(null);
}

const RpkiE2eController = (() => {
    const net = require('net');
    const path = require('path');

    const projectRoot = path.join(__dirname, '..', '..');
    const RpkiWorker = require(path.join(projectRoot, 'electron', 'worker', 'rpki', 'rpkiWorker'));
    const RpkiSession = require(path.join(projectRoot, 'electron', 'worker', 'rpki', 'rpkiSession'));
    const RpkiConst = require(path.join(projectRoot, 'electron', 'const', 'rpkiConst'));

    const RPKI_EVENT_TYPE_TO_RENDERER_TYPE = {
        [RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION]: 'rpki:clientConnection'
    };

    function delay(ms) {
        return new Promise(resolve => {
            setTimeout(resolve, ms);
        });
    }

    class CaptureMessageHandler {
        constructor(onEvent) {
            this.responses = new Map();
            this.onEvent = onEvent;
        }

        sendSuccessResponse(messageId, data = null, msg = '') {
            this.responses.set(messageId, successResponse(data, msg));
        }

        sendErrorResponse(messageId, msg = '', data = null) {
            this.responses.set(messageId, errorResponse(msg, data));
        }

        sendEvent(eventName, payload = null) {
            const type = RPKI_EVENT_TYPE_TO_RENDERER_TYPE[eventName];
            if (!type || typeof this.onEvent !== 'function') {
                return;
            }

            this.onEvent({
                type,
                data: successResponse(payload)
            });
        }
    }

    class RpkiE2eController {
        constructor() {
            this.savedConfig = null;
            this.server = null;
            this.mockClient = null;
            this.mockClientEvents = [];
            this.mockClientEndPromise = null;
            this.mockClientClosePromise = null;
            this.timeline = [];
            this.eventListeners = new Set();
            this.worker = this.createWorker();
            this.record('RPKI controller initialized');
        }

        static async getFreePort() {
            const server = net.createServer();
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            const { port } = server.address();
            await new Promise(resolve => server.close(resolve));
            return port;
        }

        createWorker() {
            const worker = Object.create(RpkiWorker.prototype);

            worker.server = null;
            worker.ipv6Server = null;
            worker.socket = null;
            worker.rpkiConfigData = null;
            worker.rpkiSessionMap = new Map();
            worker.rpkiRouterKeyMap = new Map();
            worker.rpkiDatabasePath = null;
            worker.rpkiStore = null;
            worker.cacheSerial = 1;
            worker.serialHistory = [];
            worker.serialHistoryOperationCount = 0;
            worker.maxSerialHistoryEntries = 1024;
            worker.maxSerialHistoryOperations = 200000;
            worker.storageMutationQueue = Promise.resolve();
            worker.storageStopping = false;
            worker.activeImportClients = new Set();
            worker.messageHandler = new CaptureMessageHandler(event => this.emitEvent(event));

            return worker;
        }

        onEvent(listener) {
            this.eventListeners.add(listener);
            return () => this.eventListeners.delete(listener);
        }

        record(message, data = null) {
            const item = { at: new Date().toISOString(), message };
            if (data !== null && data !== undefined) {
                item.data = data;
            }
            this.timeline.push(item);
        }

        emitEvent(event) {
            this.record('renderer event emitted', {
                type: event.type,
                opType: event.data?.data?.opType
            });
            this.eventListeners.forEach(listener => listener(event));
        }

        normalizeConfig(config = {}) {
            const maxProtocolVersion = Number(config.maxProtocolVersion);
            const supportedVersions = Object.values(RpkiConst.RPKI_PROTOCOL_VERSION);

            return {
                ...config,
                port: Number(config.port),
                maxProtocolVersion: supportedVersions.includes(maxProtocolVersion)
                    ? maxProtocolVersion
                    : RpkiConst.RPKI_MAX_SUPPORTED_VERSION,
                aspaFormat: config.aspaFormat || RpkiConst.RPKI_ASPA_FORMAT.LATEST
            };
        }

        async call(method, ...args) {
            this.record(`renderer API call: ${method}`);
            switch (method) {
                case 'saveRpkiConfig':
                    return this.saveRpkiConfig(args[0]);
                case 'loadRpkiConfig':
                    return this.loadRpkiConfig();
                case 'startRpki':
                    return this.startRpki(args[0]);
                case 'stopRpki':
                    return this.stopRpki();
                case 'getClientList':
                    return this.invokeWorker('getClientList', null);
                case 'getRoaList':
                    return successResponse({ items: [], page: 1, pageSize: 20, total: 0, storageTotal: 0 });
                case 'getRouterKeyList':
                    return successResponse([]);
                case 'getAspaList':
                    return successResponse({ items: [], page: 1, pageSize: 20, total: 0, storageTotal: 0 });
                case 'selectRoaJsonFile':
                case 'importRoaJson':
                case 'addRoa':
                case 'deleteRoa':
                case 'deleteAllRoa':
                case 'addRouterKey':
                case 'deleteRouterKey':
                case 'selectAspaJsonFile':
                case 'importAspaJson':
                case 'addAspa':
                case 'deleteAspa':
                case 'deleteAllAspa':
                    return successResponse(null);
                default:
                    return errorResponse(`Unsupported RPKI E2E method: ${method}`);
            }
        }

        saveRpkiConfig(config) {
            this.savedConfig = this.normalizeConfig(config);
            this.record('RPKI config saved', { port: this.savedConfig.port });
            return successResponse(null, 'RPKI配置文件保存成功');
        }

        loadRpkiConfig() {
            return successResponse(this.savedConfig, this.savedConfig ? 'RPKI配置文件加载成功' : 'RPKI配置文件不存在');
        }

        async startRpki(config) {
            if (this.server) {
                return errorResponse('rpki协议已经启动');
            }

            this.savedConfig = this.normalizeConfig(config);
            this.worker.rpkiConfigData = this.savedConfig;
            this.record('starting RPKI TCP server', { port: this.savedConfig.port });

            const server = net.createServer(socket => {
                const sessionKey = RpkiSession.makeKey(
                    socket.localAddress,
                    socket.localPort,
                    socket.remoteAddress,
                    socket.remotePort
                );

                this.worker.createRpkiSession(socket, socket.remoteAddress, socket.remotePort);
                this.record('RPKI mock TCP client connected', {
                    localAddress: socket.localAddress,
                    localPort: socket.localPort,
                    remoteAddress: socket.remoteAddress,
                    remotePort: socket.remotePort
                });

                const closeSession = () => {
                    const session = this.worker.rpkiSessionMap.get(sessionKey);
                    if (session) {
                        session.closeSession({ destroySocket: false });
                    }
                };

                socket.on('data', data => {
                    const session = this.worker.rpkiSessionMap.get(sessionKey);
                    if (session) {
                        session.recvMsg(data);
                    }
                });
                socket.on('end', closeSession);
                socket.on('close', closeSession);
                socket.on('error', closeSession);
            });

            try {
                await new Promise((resolve, reject) => {
                    server.once('error', reject);
                    server.listen(this.savedConfig.port, '127.0.0.1', resolve);
                });
                this.server = server;
                this.worker.server = server;
                this.record('RPKI TCP server started', { port: this.savedConfig.port });
                this.emitEvent({ type: 'rpki:runtimeChanged', data: { running: true } });
                return successResponse(null, 'rpki协议启动成功');
            } catch (error) {
                this.server = null;
                this.worker.server = null;
                return errorResponse(`rpki协议启动失败: ${error.message}`);
            }
        }

        async stopRpki() {
            if (!this.server && !this.worker.rpkiConfigData) {
                return errorResponse('RPKI未启动');
            }

            const messageId = `stop-rpki-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            await this.worker.stopRpki(messageId);
            const response = this.worker.messageHandler.responses.get(messageId);
            this.worker.messageHandler.responses.delete(messageId);
            this.server = null;
            this.emitEvent({ type: 'rpki:runtimeChanged', data: { running: false } });
            return response || errorResponse('stopRpki did not return a response');
        }

        invokeWorker(methodName, data) {
            const messageId = `${methodName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            this.worker.messageHandler.responses.delete(messageId);
            this.worker[methodName](messageId, data);
            const response = this.worker.messageHandler.responses.get(messageId);
            this.worker.messageHandler.responses.delete(messageId);
            return response || errorResponse(`${methodName} did not return a response`);
        }

        async startMockClient() {
            if (!this.savedConfig?.port) {
                throw new Error('RPKI server has not been started');
            }

            await this.stopMockClient();
            this.mockClientEvents = [];
            this.record('starting RPKI mock TCP client', { port: this.savedConfig.port });

            const client = new net.Socket();
            this.mockClient = client;

            this.mockClientEndPromise = new Promise(resolve => {
                client.once('end', () => {
                    this.mockClientEvents.push('end');
                    this.record('RPKI mock TCP client received FIN');
                    resolve({ endReceived: true, events: [...this.mockClientEvents] });
                });
            });
            this.mockClientClosePromise = new Promise(resolve => {
                client.once('close', hadError => {
                    this.mockClientEvents.push(`close:${hadError}`);
                    if (this.mockClient === client) {
                        this.mockClient = null;
                    }
                    resolve({ hadError, events: [...this.mockClientEvents] });
                });
            });

            client.on('error', error => {
                this.mockClientEvents.push(`error:${error.code || error.message}`);
            });

            await new Promise((resolve, reject) => {
                client.once('connect', resolve);
                client.once('error', reject);
                client.connect(this.savedConfig.port, '127.0.0.1');
            });
            this.mockClientEvents.push('connect');
            this.record('RPKI mock TCP client connected');
        }

        async waitForClientConnected({ timeout = 5000 } = {}) {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const result = this.invokeWorker('getClientList', null);
                if (result.status === 'success' && result.data.length > 0) {
                    return result.data[0];
                }
                await delay(50);
            }
            throw new Error('Timed out waiting for RPKI client connection');
        }

        async waitForNoClients({ timeout = 5000 } = {}) {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const result = this.invokeWorker('getClientList', null);
                if (result.status === 'success' && result.data.length === 0) {
                    return true;
                }
                await delay(50);
            }
            throw new Error('Timed out waiting for RPKI client list to become empty');
        }

        async waitForMockClientEnd({ timeout = 5000 } = {}) {
            if (!this.mockClientEndPromise) {
                throw new Error('RPKI mock client has not been started');
            }

            return Promise.race([
                this.mockClientEndPromise,
                delay(timeout).then(() => {
                    throw new Error(`Timed out waiting for RPKI FIN, events=${this.mockClientEvents.join(',')}`);
                })
            ]);
        }

        async disconnectMockClient({ timeout = 5000 } = {}) {
            const client = this.mockClient;
            if (!client) {
                throw new Error('RPKI mock client has not been started');
            }

            if (!client.destroyed) {
                client.end();
            }

            const closeResult = await Promise.race([
                this.mockClientClosePromise || Promise.resolve({ hadError: false, events: [...this.mockClientEvents] }),
                delay(timeout).then(() => {
                    throw new Error(
                        `Timed out waiting for RPKI mock client close, events=${this.mockClientEvents.join(',')}`
                    );
                })
            ]);
            this.mockClient = null;
            await this.waitForNoClients({ timeout });
            return closeResult;
        }

        async stopMockClient() {
            const client = this.mockClient;
            if (!client) {
                return;
            }

            if (!client.destroyed) {
                client.end();
            }
            await Promise.race([this.mockClientClosePromise || Promise.resolve(), delay(1000)]);
            if (!client.destroyed) {
                client.destroy();
            }
            this.mockClient = null;
        }

        async cleanup() {
            await this.stopRpki().catch(() => {});
            await this.stopMockClient();
        }
    }

    return RpkiE2eController;
})();

module.exports = {
    createRpkiPageState,
    handlePageCall,
    RpkiE2eController,
    rpkiBrowserMockScript,
    rpkiPageApiScript
};
