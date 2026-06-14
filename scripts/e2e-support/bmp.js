const bmpBrowserMockScript =
    "(function installBmpApiMocks() {\n    const unifiedCallbacks = [];\n\n    window.__bmpE2eEmit = (type, data) => {\n        unifiedCallbacks.forEach(callback => callback({ type, data }));\n    };\n\n    window.commonApi = {\n        onUnifiedEvent: callback => {\n            unifiedCallbacks.push(callback);\n            return () => {\n                const index = unifiedCallbacks.indexOf(callback);\n                if (index >= 0) {\n                    unifiedCallbacks.splice(index, 1);\n                }\n            };\n        },\n        notifyRendererReady: () => {},\n        getServerDeploymentStatus: async () => ({\n            status: 'success',\n            data: { success: true }\n        }),\n        openDeveloperOptions: () => {},\n        openSoftwareInfo: () => {}\n    };\n\n    window.bmpApi = {\n        saveBmpConfig: config => window.__bmpE2eCall('saveBmpConfig', config),\n        loadBmpConfig: () => window.__bmpE2eCall('loadBmpConfig'),\n        startBmp: config => window.__bmpE2eCall('startBmp', config),\n        stopBmp: () => window.__bmpE2eCall('stopBmp'),\n        getClientList: () => window.__bmpE2eCall('getClientList'),\n        getBgpSessions: client => window.__bmpE2eCall('getBgpSessions', client),\n        getBgpRoutes: (client, session, af, ribType, page, pageSize, routeState, prefixFilter) =>\n            window.__bmpE2eCall('getBgpRoutes', {\n                client,\n                session,\n                af,\n                ribType,\n                page,\n                pageSize,\n                routeState,\n                prefixFilter\n            }),\n        getBgpRouteDetail: (client, session, af, ribType, routeKey, includeSummary = false) =>\n            window.__bmpE2eCall('getBgpRouteDetail', {\n                client,\n                session,\n                af,\n                ribType,\n                routeKey,\n                includeSummary\n            }),\n        getBgpInstances: client => window.__bmpE2eCall('getBgpInstances', client),\n        getBgpInstanceRoutes: (client, instance, page, pageSize, routeState, prefixFilter) =>\n            window.__bmpE2eCall('getBgpInstanceRoutes', {\n                client,\n                instance,\n                page,\n                pageSize,\n                routeState,\n                prefixFilter\n            }),\n        getBgpInstanceRouteDetail: (client, instance, routeKey, includeSummary = false) =>\n            window.__bmpE2eCall('getBgpInstanceRouteDetail', {\n                client,\n                instance,\n                routeKey,\n                includeSummary\n            }),\n        purgeStaleBgpRoutes: (client, session, af, ribType) =>\n            window.__bmpE2eCall('purgeStaleBgpRoutes', {\n                client,\n                session,\n                af,\n                ribType\n            }),\n        purgeStaleBgpInstanceRoutes: (client, instance) =>\n            window.__bmpE2eCall('purgeStaleBgpInstanceRoutes', {\n                client,\n                instance\n            }),\n        getBgpStatisticsReports: client => window.__bmpE2eCall('getBgpStatisticsReports', client),\n        getBgpInstanceStatisticsReports: client => window.__bmpE2eCall('getBgpInstanceStatisticsReports', client)\n    };\n})();\n";

const BmpE2eController = (() => {
    const net = require('net');
    const path = require('path');
    const { spawn } = require('child_process');
    const { loadBmpWorkerClassFromFile } = require('../bmp-worker-loader');
    const { findPackagedElectronRoot } = require('./packaged-app');

    const projectRoot = path.join(__dirname, '..', '..');
    const workspaceElectronRoot = path.join(projectRoot, 'electron');
    const electronRoot =
        process.env.E2E_TARGET === 'browser' ? workspaceElectronRoot : findPackagedElectronRoot();
    const BmpConst = require(path.join(electronRoot, 'const', 'bmpConst'));
    const BmpSession = require(path.join(electronRoot, 'worker', 'bmp', 'bmpSession'));
    const RouteUpdateAggregator = require(path.join(electronRoot, 'utils', 'routeUpdateAggregator'));

    const BMP_EVENT_TYPE_TO_RENDERER_TYPE = {
        [BmpConst.BMP_EVT_TYPES.INITIATION]: 'bmp:initiation',
        [BmpConst.BMP_EVT_TYPES.SESSION_UPDATE]: 'bmp:sessionUpdate',
        [BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE]: 'bmp:routeUpdate',
        [BmpConst.BMP_EVT_TYPES.TERMINATION]: 'bmp:termination',
        [BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE]: 'bmp:instanceUpdate',
        [BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE]: 'bmp:instanceRouteUpdate',
        [BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT]: 'bmp:statisticsReport'
    };

    function successResponse(data = null, msg = '') {
        return { status: 'success', msg, data };
    }

    function errorResponse(msg = '', data = null) {
        return { status: 'error', msg, data };
    }

    function delay(ms) {
        return new Promise(resolve => {
            setTimeout(resolve, ms);
        });
    }

    function loadBmpWorkerClass() {
        const filePath = path.join(electronRoot, 'worker', 'bmp', 'bmpWorker.js');
        return loadBmpWorkerClassFromFile(filePath, module, 'E2E loading');
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
            if (typeof this.onEvent !== 'function') {
                return;
            }

            const type = BMP_EVENT_TYPE_TO_RENDERER_TYPE[eventName];
            if (!type) {
                return;
            }

            this.onEvent({
                type,
                data: successResponse(payload?.data ?? null, payload?.msg || '')
            });
        }
    }

    class BmpE2eController {
        constructor() {
            this.savedConfig = null;
            this.server = null;
            this.mockClient = null;
            this.mockClientOutput = '';
            this.timeline = [];
            this.lastRouteQuerySnapshot = null;
            this.eventListeners = new Set();
            this.worker = this.createWorker();
            this.record('controller initialized');
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
            const BmpWorker = loadBmpWorkerClass();
            const worker = Object.create(BmpWorker.prototype);

            worker.server = null;
            worker.ipv6Server = null;
            worker.socket = null;
            worker.bmpConfigData = null;
            worker.sshTunnel = null;
            worker.bmpSessionMap = new Map();
            worker.routeUpdateAggregator = new RouteUpdateAggregator();
            worker.routeUpdateFlushTimer = null;
            worker.routeUpdateFlushIntervalMs = 100;
            worker.messageHandler = new CaptureMessageHandler(event => this.emitEvent(event));

            return worker;
        }

        onEvent(listener) {
            this.eventListeners.add(listener);
            return () => this.eventListeners.delete(listener);
        }

        record(message, data = null) {
            const line = {
                at: new Date().toISOString(),
                message
            };
            if (data !== null && data !== undefined) {
                line.data = data;
            }
            this.timeline.push(line);
        }

        summarizeClient(client) {
            if (!client) {
                return null;
            }

            return {
                hostName: client.hostName,
                sysName: client.sysName,
                localAddress: client.localAddress,
                localPort: client.localPort,
                remoteAddress: client.remoteAddress,
                remotePort: client.remotePort,
                bmpVersion: client.bmpVersion
            };
        }

        summarizeSession(session) {
            if (!session) {
                return null;
            }

            return {
                sessionIp: session.sessionIp,
                sessionAs: session.sessionAs,
                sessionRouterId: session.sessionRouterId,
                state: session.state,
                ribTypes: session.ribTypes,
                enabledAddrFamilyTypes: session.enabledAddrFamilyTypes
            };
        }

        summarizeInstance(instance) {
            if (!instance) {
                return null;
            }

            return {
                instancePeerKey: instance.instancePeerKey,
                instanceRouterId: instance.instanceRouterId,
                instanceName: instance.instanceName,
                instanceType: instance.instanceType,
                vrfTableNames: instance.vrfTableNames,
                routeSummary: instance.routeSummary
            };
        }

        summarizeRoute(route) {
            if (!route) {
                return null;
            }

            return {
                prefix: `${route.ip}/${route.mask}`,
                ip: route.ip,
                mask: route.mask,
                rd: route.rd,
                pathId: route.pathId,
                nextHop: route.nextHop,
                asPath: route.asPath,
                med: route.med,
                localPref: route.localPref,
                labels: route.labels,
                addrFamilyType: route.addrFamilyType,
                routeState: route.routeState,
                pathStatusText: route.pathStatusText,
                pathStatusReasonText: route.pathStatusReasonText,
                parserValid: route.parserValid,
                parseWarnings: route.parseWarnings,
                parseErrors: route.parseErrors,
                routeKey: route.routeKey
            };
        }

        summarizeRouteList(routes = [], sampleSize = 12) {
            return {
                sampleSize: Math.min(routes.length, sampleSize),
                omitted: Math.max(0, routes.length - sampleSize),
                routes: routes.slice(0, sampleSize).map(route => this.summarizeRoute(route))
            };
        }

        summarizeWorkerRequest(methodName, data) {
            if (!data) {
                return null;
            }

            switch (methodName) {
                case 'getBgpRoutes':
                    return {
                        client: this.summarizeClient(data.client),
                        session: this.summarizeSession(data.session),
                        af: data.af,
                        ribType: data.ribType,
                        page: data.page,
                        pageSize: data.pageSize,
                        routeState: data.routeState,
                        prefixFilter: data.prefixFilter || ''
                    };
                case 'getBgpRouteDetail':
                    return {
                        client: this.summarizeClient(data.client),
                        session: this.summarizeSession(data.session),
                        af: data.af,
                        ribType: data.ribType,
                        routeKey: data.routeKey,
                        route: this.summarizeRoute(data.route),
                        includeSummary: data.includeSummary === true
                    };
                case 'getBgpInstanceRoutes':
                    return {
                        client: this.summarizeClient(data.client),
                        instance: this.summarizeInstance(data.instance),
                        page: data.page,
                        pageSize: data.pageSize,
                        routeState: data.routeState,
                        prefixFilter: data.prefixFilter || ''
                    };
                case 'getBgpInstanceRouteDetail':
                    return {
                        client: this.summarizeClient(data.client),
                        instance: this.summarizeInstance(data.instance),
                        routeKey: data.routeKey,
                        route: this.summarizeRoute(data.route),
                        includeSummary: data.includeSummary === true
                    };
                case 'getBgpSessions':
                case 'getBgpInstances':
                case 'purgeStaleBgpRoutes':
                case 'purgeStaleBgpInstanceRoutes':
                case 'getBgpStatisticsReports':
                case 'getBgpInstanceStatisticsReports':
                    return {
                        client: this.summarizeClient(data.client || data),
                        session: this.summarizeSession(data.session),
                        instance: this.summarizeInstance(data.instance)
                    };
                default:
                    return data;
            }
        }

        summarizeResponse(methodName, response) {
            if (!response || response.status !== 'success') {
                return {
                    status: response?.status || 'missing',
                    msg: response?.msg || ''
                };
            }
            const data = response.data;
            if (Array.isArray(data)) {
                return { status: response.status, count: data.length };
            }
            if (data && Array.isArray(data.list)) {
                const summary = {
                    status: response.status,
                    list: data.list.length,
                    total: data.total,
                    summary: data.summary
                };

                if (methodName === 'getBgpRoutes' || methodName === 'getBgpInstanceRoutes') {
                    summary.queriedRoutes = this.summarizeRouteList(data.list);
                }

                return summary;
            }
            if (methodName === 'getBgpRouteDetail' || methodName === 'getBgpInstanceRouteDetail') {
                return {
                    status: response.status,
                    msg: response.msg || '',
                    route: this.summarizeRoute(data),
                    communities: data?.communities,
                    summary: data?.summary
                };
            }
            return {
                status: response.status,
                msg: response.msg || '',
                hasData: data !== null && data !== undefined
            };
        }

        emitEvent(event) {
            this.record('renderer event emitted', {
                type: event.type,
                status: event.data?.status,
                hasData: event.data?.data !== null && event.data?.data !== undefined
            });
            this.eventListeners.forEach(listener => listener(event));
        }

        normalizeConfig(config = {}) {
            const draft =
                Number(config.bmpV4TlvDraft) === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
                    ? BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
                    : BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20;
            const defaultPathMarkingTlvType =
                draft === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
                    ? BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE_LEGACY.PATH_MARKING
                    : BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING;
            const configuredPathMarkingTlvType = Number(config.pathMarkingTlvType);

            return {
                ...config,
                port: Number(config.port),
                enableAuth: false,
                bmpV4TlvDraft: draft,
                pathMarkingTlvType:
                    Number.isInteger(configuredPathMarkingTlvType) &&
                    configuredPathMarkingTlvType >= 1 &&
                    configuredPathMarkingTlvType <= 0x3fff
                        ? configuredPathMarkingTlvType
                        : defaultPathMarkingTlvType
            };
        }

        async call(method, ...args) {
            this.record(`renderer API call: ${method}`);
            switch (method) {
                case 'saveBmpConfig':
                    return this.saveBmpConfig(args[0]);
                case 'loadBmpConfig':
                    return this.loadBmpConfig();
                case 'startBmp':
                    return this.startBmp(args[0]);
                case 'stopBmp':
                    return this.stopBmp();
                case 'getClientList':
                    return this.invokeWorker('getClientList', null);
                case 'getBgpSessions':
                    return this.invokeWorker('getBgpSessions', args[0]);
                case 'getBgpRoutes':
                    return this.invokeWorker('getBgpRoutes', args[0]);
                case 'getBgpRouteDetail':
                    return this.invokeWorker('getBgpRouteDetail', args[0]);
                case 'getBgpInstances':
                    return this.invokeWorker('getBgpInstances', args[0]);
                case 'getBgpInstanceRoutes':
                    return this.invokeWorker('getBgpInstanceRoutes', args[0]);
                case 'getBgpInstanceRouteDetail':
                    return this.invokeWorker('getBgpInstanceRouteDetail', args[0]);
                case 'purgeStaleBgpRoutes':
                    return this.invokeWorker('purgeStaleBgpRoutes', args[0]);
                case 'purgeStaleBgpInstanceRoutes':
                    return this.invokeWorker('purgeStaleBgpInstanceRoutes', args[0]);
                case 'getBgpStatisticsReports':
                    return this.invokeWorker('getBgpStatisticsReports', args[0]);
                case 'getBgpInstanceStatisticsReports':
                    return this.invokeWorker('getBgpInstanceStatisticsReports', args[0]);
                default:
                    return errorResponse(`Unsupported BMP E2E method: ${method}`);
            }
        }

        saveBmpConfig(config) {
            this.savedConfig = this.normalizeConfig(config);
            this.record('BMP config saved', {
                port: this.savedConfig.port,
                bmpV4TlvDraft: this.savedConfig.bmpV4TlvDraft,
                pathMarkingTlvType: this.savedConfig.pathMarkingTlvType
            });
            return successResponse(null, 'BMP配置文件保存成功');
        }

        loadBmpConfig() {
            this.record('BMP config loaded', {
                exists: !!this.savedConfig
            });
            return successResponse(this.savedConfig, this.savedConfig ? 'BMP配置文件加载成功' : 'BMP配置文件不存在');
        }

        async startBmp(config) {
            if (this.server) {
                return errorResponse('bmp协议已经启动');
            }

            this.savedConfig = this.normalizeConfig(config);
            this.worker.bmpConfigData = this.savedConfig;
            this.record('starting BMP TCP server', {
                port: this.savedConfig.port
            });

            this.server = net.createServer(socket => {
                const sessionKey = BmpSession.makeKey(
                    socket.localAddress,
                    socket.localPort,
                    socket.remoteAddress,
                    socket.remotePort
                );
                this.record('BMP mock TCP client connected', {
                    localAddress: socket.localAddress,
                    localPort: socket.localPort,
                    remoteAddress: socket.remoteAddress,
                    remotePort: socket.remotePort
                });
                this.worker.createBmpSession(socket, socket.remoteAddress, socket.remotePort);

                socket.on('data', data => {
                    this.record('BMP TCP data received', {
                        bytes: data.length
                    });
                    const session = this.worker.bmpSessionMap.get(sessionKey);
                    if (session) {
                        session.recvMsg(data);
                    }
                });
                socket.on('end', () => this.worker.removeBmpSessionByKey(sessionKey));
                socket.on('close', () => this.worker.removeBmpSessionByKey(sessionKey));
                socket.on('error', () => this.worker.removeBmpSessionByKey(sessionKey));
            });

            try {
                await new Promise((resolve, reject) => {
                    this.server.once('error', reject);
                    this.server.listen(this.savedConfig.port, '127.0.0.1', resolve);
                });
                this.record('BMP TCP server started', {
                    port: this.savedConfig.port
                });
                return successResponse(null, 'bmp协议启动成功');
            } catch (error) {
                this.server = null;
                this.record('BMP TCP server start failed', {
                    error: error.message
                });
                return errorResponse(`bmp协议启动失败: ${error.message}`);
            }
        }

        async stopBmp() {
            this.record('stopping BMP server');
            await this.stopMockClient();
            this.worker.clearRouteUpdateAggregation?.();

            for (const session of this.worker.bmpSessionMap.values()) {
                session.closeSession();
            }
            this.worker.bmpSessionMap.clear();
            this.worker.bmpConfigData = null;

            if (this.server) {
                const server = this.server;
                this.server = null;
                await new Promise(resolve => server.close(resolve));
            }

            this.emitEvent({
                type: 'bmp:termination',
                data: successResponse(null)
            });

            return successResponse(null, 'bmp协议停止成功');
        }

        invokeWorker(methodName, data) {
            const messageId = `${methodName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            this.worker.messageHandler.responses.delete(messageId);
            this.worker[methodName](messageId, data);
            const response = this.worker.messageHandler.responses.get(messageId);
            this.worker.messageHandler.responses.delete(messageId);
            this.record(`worker query: ${methodName}`, {
                request: this.summarizeWorkerRequest(methodName, data),
                response: this.summarizeResponse(methodName, response)
            });
            return response || errorResponse(`${methodName} did not return a response`);
        }

        async startMockClient({ routes = 12, interval = 0 } = {}) {
            if (!this.savedConfig?.port) {
                throw new Error('BMP server has not been started');
            }

            await this.stopMockClient();
            this.mockClientOutput = '';
            this.record('starting mockBmpClient script', {
                routes,
                interval,
                port: this.savedConfig.port
            });

            const scriptPath = path.join(projectRoot, 'scripts', 'mockBmpClient.js');
            this.mockClient = spawn(
                process.execPath,
                [
                    scriptPath,
                    '--host',
                    '127.0.0.1',
                    '--port',
                    String(this.savedConfig.port),
                    '--routes',
                    String(routes),
                    '--interval',
                    String(interval)
                ],
                {
                    cwd: projectRoot,
                    stdio: ['ignore', 'pipe', 'pipe']
                }
            );

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`BMP mock client timed out:\n${this.mockClientOutput}`));
                }, 10000);

                const handleOutput = chunk => {
                    const text = chunk.toString();
                    this.mockClientOutput += text;
                    text.split(/\r?\n/)
                        .filter(Boolean)
                        .forEach(line => this.record('mockBmpClient output', { line }));
                    if (this.mockClientOutput.includes('mock data sent; keeping BMP TCP connection open')) {
                        clearTimeout(timeout);
                        resolve();
                    }
                };

                this.mockClient.stdout.on('data', handleOutput);
                this.mockClient.stderr.on('data', handleOutput);
                this.mockClient.once('error', error => {
                    clearTimeout(timeout);
                    reject(error);
                });
                this.mockClient.once('exit', code => {
                    if (!this.mockClientOutput.includes('mock data sent; keeping BMP TCP connection open')) {
                        clearTimeout(timeout);
                        reject(new Error(`BMP mock client exited with code ${code}:\n${this.mockClientOutput}`));
                    }
                });
            });
        }

        async waitForMockData({ routes = 12, timeout = 10000 } = {}) {
            const deadline = Date.now() + timeout;
            this.record('waiting for BMP worker data', {
                expectedRoutes: routes,
                timeout
            });

            while (Date.now() < deadline) {
                const clients = this.invokeWorker('getClientList', null);
                if (clients.status === 'success' && clients.data.length > 0) {
                    const client = clients.data[0];
                    const sessions = this.invokeWorker('getBgpSessions', client);
                    const instances = this.invokeWorker('getBgpInstances', client);

                    if (
                        sessions.status === 'success' &&
                        sessions.data.length >= 3 &&
                        instances.status === 'success' &&
                        instances.data.length >= 1
                    ) {
                        const ipv4Session = sessions.data.find(session => session.sessionIp === '192.0.2.2');
                        const locRibInstance = instances.data.find(instance =>
                            Array.isArray(instance.vrfTableNames) ? instance.vrfTableNames.includes('global') : false
                        );

                        if (ipv4Session && locRibInstance) {
                            const routeResult = this.invokeWorker('getBgpRoutes', {
                                client,
                                session: ipv4Session,
                                af: ipv4Session.enabledAddrFamilyTypes[0],
                                ribType: ipv4Session.ribTypes[0],
                                page: 1,
                                pageSize: 25,
                                routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL
                            });
                            const locRibRouteResult = this.invokeWorker('getBgpInstanceRoutes', {
                                client,
                                instance: locRibInstance,
                                page: 1,
                                pageSize: 25,
                                routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL
                            });

                            if (
                                routeResult.status === 'success' &&
                                routeResult.data.total >= routes &&
                                locRibRouteResult.status === 'success' &&
                                locRibRouteResult.data.total >= Math.max(8, Math.min(25, routes))
                            ) {
                                this.lastRouteQuerySnapshot = {
                                    adjRib: {
                                        client: this.summarizeClient(client),
                                        session: this.summarizeSession(ipv4Session),
                                        af: ipv4Session.enabledAddrFamilyTypes[0],
                                        ribType: ipv4Session.ribTypes[0],
                                        page: 1,
                                        pageSize: 25,
                                        routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
                                        prefixFilter: '',
                                        total: routeResult.data.total,
                                        routes: routeResult.data.list.map(route => this.summarizeRoute(route))
                                    },
                                    locRib: {
                                        client: this.summarizeClient(client),
                                        instance: this.summarizeInstance(locRibInstance),
                                        page: 1,
                                        pageSize: 25,
                                        routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
                                        prefixFilter: '',
                                        total: locRibRouteResult.data.total,
                                        routes: locRibRouteResult.data.list.map(route => this.summarizeRoute(route))
                                    }
                                };

                                this.record('BMP worker data ready', {
                                    clients: clients.data.length,
                                    sessions: sessions.data.length,
                                    instances: instances.data.length,
                                    sessionRoutes: routeResult.data.total,
                                    locRibRoutes: locRibRouteResult.data.total,
                                    sessionRouteSample: this.summarizeRouteList(routeResult.data.list),
                                    locRibRouteSample: this.summarizeRouteList(locRibRouteResult.data.list)
                                });
                                return { client, ipv4Session, locRibInstance };
                            }
                        }
                    }
                }

                await delay(100);
            }

            throw new Error(`Timed out waiting for BMP mock data:\n${this.mockClientOutput}`);
        }

        async stopMockClient() {
            if (!this.mockClient) {
                return;
            }

            const child = this.mockClient;
            this.mockClient = null;

            if (child.exitCode !== null || child.signalCode !== null) {
                return;
            }

            await new Promise(resolve => {
                const timeout = setTimeout(resolve, 1000);
                child.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                child.kill('SIGTERM');
            });
            this.record('mockBmpClient stopped');
        }

        async cleanup() {
            await this.stopBmp();
        }
    }

    return BmpE2eController;
})();

module.exports = {
    BmpE2eController,
    bmpBrowserMockScript
};
