const { successResponse } = require('./common');

let bgpBrowserMockScript =
    "(function installBgpApiMocks() {\n    const unifiedCallbacks = [];\n\n    window.__bgpE2eEmit = (type, data) => {\n        unifiedCallbacks.forEach(callback => callback({ type, data }));\n    };\n\n    window.commonApi = {\n        onUnifiedEvent: callback => {\n            unifiedCallbacks.push(callback);\n            return () => {\n                const index = unifiedCallbacks.indexOf(callback);\n                if (index >= 0) {\n                    unifiedCallbacks.splice(index, 1);\n                }\n            };\n        },\n        notifyRendererReady: () => {},\n        openDeveloperOptions: () => {},\n        openSoftwareInfo: () => {}\n    };\n\n    window.bgpApi = {\n        saveBgpConfig: config => window.__bgpE2eCall('saveBgpConfig', config),\n        loadBgpConfig: () => window.__bgpE2eCall('loadBgpConfig'),\n        saveIpv4PeerConfig: config => window.__bgpE2eCall('saveIpv4PeerConfig', config),\n        loadIpv4PeerConfig: () => window.__bgpE2eCall('loadIpv4PeerConfig'),\n        saveIpv6PeerConfig: config => window.__bgpE2eCall('saveIpv6PeerConfig', config),\n        loadIpv6PeerConfig: () => window.__bgpE2eCall('loadIpv6PeerConfig'),\n        saveIpv4UNCRouteConfig: config => window.__bgpE2eCall('saveIpv4UNCRouteConfig', config),\n        loadIpv4UNCRouteConfig: () => window.__bgpE2eCall('loadIpv4UNCRouteConfig'),\n        saveIpv6UNCRouteConfig: config => window.__bgpE2eCall('saveIpv6UNCRouteConfig', config),\n        loadIpv6UNCRouteConfig: () => window.__bgpE2eCall('loadIpv6UNCRouteConfig'),\n        saveIpv4MvpnRouteConfig: config => window.__bgpE2eCall('saveIpv4MvpnRouteConfig', config),\n        loadIpv4MvpnRouteConfig: () => window.__bgpE2eCall('loadIpv4MvpnRouteConfig'),\n        saveIpv4QpRouteConfig: config => window.__bgpE2eCall('saveIpv4QpRouteConfig', config),\n        loadIpv4QpRouteConfig: () => window.__bgpE2eCall('loadIpv4QpRouteConfig'),\n        saveIpv6QpRouteConfig: config => window.__bgpE2eCall('saveIpv6QpRouteConfig', config),\n        loadIpv6QpRouteConfig: () => window.__bgpE2eCall('loadIpv6QpRouteConfig'),\n\n        startBgp: config => window.__bgpE2eCall('startBgp', config),\n        stopBgp: () => window.__bgpE2eCall('stopBgp'),\n        configIpv4Peer: config => window.__bgpE2eCall('configIpv4Peer', config),\n        configIpv6Peer: config => window.__bgpE2eCall('configIpv6Peer', config),\n        getPeerInfo: () => window.__bgpE2eCall('getPeerInfo'),\n        deletePeer: peer => window.__bgpE2eCall('deletePeer', peer),\n\n        generateIpv4Routes: config => window.__bgpE2eCall('generateIpv4Routes', config),\n        generateIpv6Routes: config => window.__bgpE2eCall('generateIpv6Routes', config),\n        generateIpv4MvpnRoutes: config => window.__bgpE2eCall('generateIpv4MvpnRoutes', config),\n        generateIpv4QpRoutes: config => window.__bgpE2eCall('generateIpv4QpRoutes', config),\n        generateIpv6QpRoutes: config => window.__bgpE2eCall('generateIpv6QpRoutes', config),\n        deleteIpv4Routes: config => window.__bgpE2eCall('deleteIpv4Routes', config),\n        deleteIpv6Routes: config => window.__bgpE2eCall('deleteIpv6Routes', config),\n        deleteIpv4MvpnRoutes: config => window.__bgpE2eCall('deleteIpv4MvpnRoutes', config),\n        deleteIpv4QpRoutes: config => window.__bgpE2eCall('deleteIpv4QpRoutes', config),\n        deleteIpv6QpRoutes: config => window.__bgpE2eCall('deleteIpv6QpRoutes', config),\n        deleteAllRoutesByFamily: addressFamily => window.__bgpE2eCall('deleteAllRoutesByFamily', addressFamily),\n        getRoutes: (addressFamily, page, pageSize) => window.__bgpE2eCall('getRoutes', addressFamily, page, pageSize),\n        getRouteDetail: (addressFamily, route) => window.__bgpE2eCall('getRouteDetail', addressFamily, route),\n\n        selectMrtFile: () =>\n            Promise.resolve({\n                status: 'success',\n                data: null,\n                msg: 'E2E does not select MRT files'\n            }),\n        importRouteViewsData: (filePath, limit, addressFamily) =>\n            window.__bgpE2eCall('importRouteViewsData', filePath, limit, addressFamily),\n        openExternal: url => window.__bgpE2eCall('openExternal', url),\n        getInstanceInfo: () => window.__bgpE2eCall('getInstanceInfo'),\n        getDefaultMrtFiles: () => window.__bgpE2eCall('getDefaultMrtFiles')\n    };\n})();\n";
bgpBrowserMockScript = bgpBrowserMockScript
    .replace(
        "deleteAllRoutesByFamily: addressFamily => window.__bgpE2eCall('deleteAllRoutesByFamily', addressFamily)",
        "deleteAllRoutesByFamily: (addressFamily, options = {}) => window.__bgpE2eCall('deleteAllRoutesByFamily', addressFamily, options)"
    )
    .replace(
        "getRoutes: (addressFamily, page, pageSize) => window.__bgpE2eCall('getRoutes', addressFamily, page, pageSize)",
        "getRoutes: (addressFamily, page, pageSize, options = {}) => window.__bgpE2eCall('getRoutes', addressFamily, page, pageSize, options)"
    );

const bgpPageApiScript =
    "    window.bgpApi = {\n        loadIpv6UNCRouteConfig: () => call('bgp.loadIpv6UNCRouteConfig'),\n        saveIpv6UNCRouteConfig: config => call('bgp.saveIpv6UNCRouteConfig', config),\n        generateIpv6Routes: config => call('bgp.generateRoutes', config),\n        loadIpv4MvpnRouteConfig: () => call('bgp.loadIpv4MvpnRouteConfig'),\n        saveIpv4MvpnRouteConfig: config => call('bgp.saveIpv4MvpnRouteConfig', config),\n        generateIpv4MvpnRoutes: config => call('bgp.generateRoutes', config),\n        loadIpv4QpRouteConfig: () => call('bgp.loadIpv4QpRouteConfig'),\n        saveIpv4QpRouteConfig: config => call('bgp.saveIpv4QpRouteConfig', config),\n        generateIpv4QpRoutes: config => call('bgp.generateRoutes', config),\n        loadIpv6QpRouteConfig: () => call('bgp.loadIpv6QpRouteConfig'),\n        saveIpv6QpRouteConfig: config => call('bgp.saveIpv6QpRouteConfig', config),\n        generateIpv6QpRoutes: config => call('bgp.generateRoutes', config),\n        getRoutes: (addressFamily, page, pageSize) => call('bgp.getRoutes', addressFamily, page, pageSize),\n        getRouteDetail: (addressFamily, route) => call('bgp.getRouteDetail', addressFamily, route),\n        deleteAllRoutesByFamily: addressFamily => call('bgp.deleteAllRoutesByFamily', addressFamily),\n        deleteIpv6Routes: config => call('bgp.deleteRoutes', config),\n        deleteIpv4MvpnRoutes: config => call('bgp.deleteRoutes', config),\n        deleteIpv4QpRoutes: config => call('bgp.deleteRoutes', config),\n        deleteIpv6QpRoutes: config => call('bgp.deleteRoutes', config),\n        getDefaultMrtFiles: () => call('bgp.getDefaultMrtFiles'),\n        selectMrtFile: () => call('bgp.selectMrtFile'),\n        importRouteViewsData: (filePath, limit, addressFamily) => call('bgp.importRouteViewsData', filePath, limit, addressFamily),\n        openExternal: url => call('bgp.openExternal', url)\n    };";

function createBgpPageState() {
    return {
        routes: new Map()
    };
}

function handlePageCall(controller, method, args) {
    const bgp = controller.state.bgp;
    if (method.startsWith('bgp.load')) return successResponse(null, '配置不存在');
    if (method.startsWith('bgp.save')) return successResponse(null, '配置保存成功');
    if (method === 'bgp.generateRoutes') {
        const config = args[0] || {};
        const routes = [];
        const count = Math.max(1, Number(config.count) || 1);
        for (let i = 0; i < count; i += 1) {
            routes.push({
                ip: config.prefix || '2001:db8::',
                mask: config.mask || 64,
                asPath: '',
                nextHop: '',
                rt: config.rt || '',
                addressFamily: config.addressFamily
            });
        }
        bgp.routes.set(Number(config.addressFamily), routes);
        return successResponse(null, '路由生成成功');
    }
    if (method === 'bgp.getRoutes') {
        const routes = bgp.routes.get(Number(args[0])) || [];
        return successResponse({ list: routes, total: routes.length });
    }
    if (method === 'bgp.getRouteDetail') return successResponse(args[1] || {});
    if (method === 'bgp.deleteAllRoutesByFamily') {
        bgp.routes.set(Number(args[0]), []);
        return successResponse({ deleted: 0 });
    }
    if (method === 'bgp.getDefaultMrtFiles') return successResponse([]);
    if (method === 'bgp.selectMrtFile') return successResponse(null);
    if (method === 'bgp.openExternal') return successResponse(null);
    return successResponse(null);
}

const BgpE2eController = (() => {
    const net = require('net');
    const path = require('path');
    const { spawn } = require('child_process');

    const projectRoot = path.join(__dirname, '..', '..');
    const BgpConst = require(path.join(projectRoot, 'electron', 'const', 'bgpConst'));
    const BgpWorker = require(path.join(projectRoot, 'electron', 'worker', 'bgp', 'bgpWorker'));
    const BgpSession = require(path.join(projectRoot, 'electron', 'worker', 'bgp', 'bgpSession'));
    const BgpInstance = require(path.join(projectRoot, 'electron', 'worker', 'bgp', 'bgpInstance'));
    const BgpRoute = require(path.join(projectRoot, 'electron', 'worker', 'bgp', 'bgpRoute'));
    const { parseBgpPacket } = require(path.join(projectRoot, 'electron', 'utils', 'bgpPacketParser'));

    const BGP_EVENT_TYPE_TO_RENDERER_TYPE = {
        [BgpConst.BGP_EVT_TYPES.BGP_PEER_CHANGE]: 'bgp:peerChange'
    };

    const DEFAULT_BGP_CONFIG = {
        localAs: '65535',
        routerId: '192.168.56.1',
        addressFamily: [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC]
    };

    const DEFAULT_IPV4_PEER_CONFIG = {
        peerIp: '127.0.0.1',
        peerAs: '100',
        holdTime: '90',
        openCap: [
            BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
            BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH,
            BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS
        ],
        addressFamily: [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC],
        role: '',
        openCapCustom: ''
    };

    const DEFAULT_IPV6_PEER_CONFIG = {
        peerIpv6: '192::11',
        peerIpv6As: '100',
        holdTimeIpv6: '180',
        openCapIpv6: [
            BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
            BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH,
            BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS
        ],
        addressFamilyIpv6: [BgpConst.BGP_ADDR_FAMILY.IPV6_UNC],
        roleIpv6: '',
        openCapCustomIpv6: ''
    };

    const DEFAULT_IPV4_ROUTE_CONFIG = {
        prefix: '10.20.0.0',
        mask: '24',
        count: '3',
        customAttr: '',
        rt: '',
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC
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

    function ipv4FromNumber(value) {
        return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
    }

    class CaptureMessageHandler {
        constructor(onEvent) {
            this.responses = new Map();
            this.waiters = new Map();
            this.onEvent = onEvent;
        }

        setResponse(messageId, response) {
            this.responses.set(messageId, response);
            const waiter = this.waiters.get(messageId);
            if (waiter) {
                clearTimeout(waiter.timeout);
                this.waiters.delete(messageId);
                waiter.resolve(response);
            }
        }

        waitForResponse(messageId, timeoutMs = 10000) {
            if (this.responses.has(messageId)) {
                return Promise.resolve(this.responses.get(messageId));
            }

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.waiters.delete(messageId);
                    reject(new Error(`Timed out waiting for worker response: ${messageId}`));
                }, timeoutMs);
                this.waiters.set(messageId, { resolve, reject, timeout });
            });
        }

        sendSuccessResponse(messageId, data = null, msg = '') {
            this.setResponse(messageId, successResponse(data, msg));
        }

        sendErrorResponse(messageId, msg = '', data = null) {
            this.setResponse(messageId, errorResponse(msg, data));
        }

        sendEvent(eventName, payload = null) {
            if (typeof this.onEvent !== 'function') {
                return;
            }

            const type = BGP_EVENT_TYPE_TO_RENDERER_TYPE[eventName];
            if (!type) {
                return;
            }

            this.onEvent({
                type,
                data: successResponse(payload?.data ?? null, payload?.msg || '')
            });
        }
    }

    class BgpE2eController {
        constructor(options = {}) {
            this.bgpPort = null;
            this.listenHost = options.listenHost || '127.0.0.1';
            this.ipv6ListenHost = options.ipv6ListenHost || '::1';
            this.advertisedNextHop = options.advertisedNextHop || null;
            this.server = null;
            this.ipv6Server = null;
            this.mockClient = null;
            this.mockClientOutput = '';
            this.mockClientLineBuffer = '';
            this.mockClientEvents = [];
            this.mockClientExit = null;
            this.mockClientExitPromise = null;
            this.savedBgpConfig = null;
            this.savedIpv4PeerConfig = null;
            this.savedIpv6PeerConfig = null;
            this.savedIpv4RouteConfig = null;
            this.savedConfigs = new Map();
            this.timeline = [];
            this.eventListeners = new Set();
            this.capturedBgpPackets = [];
            this.worker = this.createWorker();
            this.record('BGP controller initialized');
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

        setBgpPort(port) {
            this.bgpPort = Number(port);
            this.record('allocated BGP port', { port: this.bgpPort });
        }

        setAdvertisedNextHop(address) {
            this.advertisedNextHop = address || null;
            this.record('configured E2E advertised next hop', { address: this.advertisedNextHop });
        }

        createWorker() {
            const worker = Object.create(BgpWorker.prototype);

            worker.server = null;
            worker.ipv6Server = null;
            worker.bgpConfigData = null;
            worker.ipv4PeerConfigData = null;
            worker.ipv6PeerConfigData = null;
            worker.bgpSessionMap = new Map();
            worker.bgpInstanceMap = new Map();
            worker.messageHandler = new CaptureMessageHandler(event => this.emitEvent(event));
            worker.startTcpServer = messageId => this.startTcpServer(messageId);

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

        emitEvent(event) {
            this.record('renderer event emitted', {
                type: event.type,
                status: event.data?.status,
                data: this.summarizePeer(event.data?.data)
            });
            this.eventListeners.forEach(listener => listener(event));
        }

        normalizeBgpConfig(config = {}) {
            const addressFamily =
                Array.isArray(config.addressFamily) && config.addressFamily.length > 0
                    ? config.addressFamily.map(Number)
                    : DEFAULT_BGP_CONFIG.addressFamily;

            return {
                ...DEFAULT_BGP_CONFIG,
                ...config,
                localAs: String(config.localAs ?? DEFAULT_BGP_CONFIG.localAs),
                routerId: config.routerId || DEFAULT_BGP_CONFIG.routerId,
                addressFamily
            };
        }

        normalizeIpv4PeerConfig(config = {}) {
            return {
                ...DEFAULT_IPV4_PEER_CONFIG,
                ...config,
                peerIp: config.peerIp || DEFAULT_IPV4_PEER_CONFIG.peerIp,
                peerAs: String(config.peerAs ?? DEFAULT_IPV4_PEER_CONFIG.peerAs),
                holdTime: String(config.holdTime ?? DEFAULT_IPV4_PEER_CONFIG.holdTime),
                openCap: Array.isArray(config.openCap) ? config.openCap.map(Number) : DEFAULT_IPV4_PEER_CONFIG.openCap,
                addressFamily: Array.isArray(config.addressFamily)
                    ? config.addressFamily.map(Number)
                    : DEFAULT_IPV4_PEER_CONFIG.addressFamily
            };
        }

        normalizeIpv4RouteConfig(config = {}) {
            return {
                ...DEFAULT_IPV4_ROUTE_CONFIG,
                ...config,
                prefix: config.prefix || DEFAULT_IPV4_ROUTE_CONFIG.prefix,
                mask: String(config.mask ?? DEFAULT_IPV4_ROUTE_CONFIG.mask),
                count: String(config.count ?? DEFAULT_IPV4_ROUTE_CONFIG.count),
                addressFamily: Number(config.addressFamily ?? BgpConst.BGP_ADDR_FAMILY.IPV4_UNC)
            };
        }

        summarizePeer(peer) {
            if (!peer) {
                return null;
            }

            return {
                localIp: peer.localIp,
                localAs: peer.localAs,
                peerIp: peer.peerIp,
                peerAs: peer.peerAs,
                routerId: peer.routerId,
                peerState: peer.peerState,
                addressFamily: peer.addressFamily,
                peerType: peer.peerType
            };
        }

        summarizePeerInfo(peerInfo) {
            if (!peerInfo || typeof peerInfo !== 'object') {
                return peerInfo;
            }

            return Object.fromEntries(
                Object.entries(peerInfo).map(([family, peers]) => [
                    family,
                    Array.isArray(peers) ? peers.map(peer => this.summarizePeer(peer)) : peers
                ])
            );
        }

        summarizeRoute(route) {
            if (!route) {
                return null;
            }

            return {
                prefix: `${route.ip}/${route.mask}`,
                ip: route.ip,
                mask: route.mask,
                asPath: route.asPath,
                nextHop: route.nextHop,
                origin: route.origin,
                med: route.med,
                localPref: route.localPref,
                rt: route.rt,
                addressFamily: route.addressFamily
            };
        }

        summarizeRouteList(routes = [], sampleSize = 10) {
            return {
                sampleSize: Math.min(routes.length, sampleSize),
                omitted: Math.max(0, routes.length - sampleSize),
                routes: routes.slice(0, sampleSize).map(route => this.summarizeRoute(route))
            };
        }

        summarizeResponse(methodName, response) {
            if (!response || response.status !== 'success') {
                return {
                    status: response?.status || 'missing',
                    msg: response?.msg || ''
                };
            }

            if (methodName === 'getPeerInfo') {
                return {
                    status: response.status,
                    msg: response.msg || '',
                    peers: this.summarizePeerInfo(response.data)
                };
            }

            if (methodName === 'getRoutes' && response.data) {
                return {
                    status: response.status,
                    msg: response.msg || '',
                    total: response.data.total,
                    routes: this.summarizeRouteList(response.data.list || [])
                };
            }

            if (methodName === 'getRouteDetail') {
                return {
                    status: response.status,
                    msg: response.msg || '',
                    route: this.summarizeRoute(response.data)
                };
            }

            if (Array.isArray(response.data)) {
                return {
                    status: response.status,
                    msg: response.msg || '',
                    count: response.data.length,
                    data: response.data
                };
            }

            return {
                status: response.status,
                msg: response.msg || '',
                hasData: response.data !== null && response.data !== undefined
            };
        }

        async call(method, ...args) {
            this.record(`renderer API call: ${method}`);
            switch (method) {
                case 'saveBgpConfig':
                    return this.saveBgpConfig(args[0]);
                case 'loadBgpConfig':
                    return this.loadBgpConfig();
                case 'saveIpv4PeerConfig':
                    return this.saveIpv4PeerConfig(args[0]);
                case 'loadIpv4PeerConfig':
                    return successResponse(
                        this.savedIpv4PeerConfig,
                        this.savedIpv4PeerConfig ? 'IPv4 Peer配置加载成功' : 'IPv4 Peer配置不存在'
                    );
                case 'saveIpv6PeerConfig':
                    this.savedIpv6PeerConfig = { ...DEFAULT_IPV6_PEER_CONFIG, ...(args[0] || {}) };
                    return successResponse(null, 'IPv6 Peer配置保存成功');
                case 'loadIpv6PeerConfig':
                    return successResponse(
                        this.savedIpv6PeerConfig,
                        this.savedIpv6PeerConfig ? 'IPv6 Peer配置加载成功' : 'IPv6 Peer配置不存在'
                    );
                case 'saveIpv4UNCRouteConfig':
                    return this.saveIpv4RouteConfig(args[0]);
                case 'loadIpv4UNCRouteConfig':
                    return successResponse(
                        this.savedIpv4RouteConfig,
                        this.savedIpv4RouteConfig ? 'IPv4-UNC路由配置加载成功' : 'IPv4-UNC路由配置不存在'
                    );
                case 'saveIpv6UNCRouteConfig':
                case 'saveIpv4MvpnRouteConfig':
                case 'saveIpv4QpRouteConfig':
                case 'saveIpv6QpRouteConfig':
                    this.savedConfigs.set(method, args[0] || null);
                    return successResponse(null, '配置保存成功');
                case 'loadIpv6UNCRouteConfig':
                case 'loadIpv4MvpnRouteConfig':
                case 'loadIpv4QpRouteConfig':
                case 'loadIpv6QpRouteConfig':
                    return successResponse(null, '配置不存在');
                case 'startBgp':
                    return this.startBgp(args[0]);
                case 'stopBgp':
                    return this.stopBgp();
                case 'configIpv4Peer':
                    return this.configIpv4Peer(args[0]);
                case 'configIpv6Peer':
                    return this.invokeWorker('configIpv6Peer', args[0]);
                case 'getPeerInfo':
                    return this.invokeWorker('getPeerInfo', null);
                case 'deletePeer':
                    return this.invokeWorker('deletePeer', args[0]);
                case 'generateIpv4Routes':
                    return this.generateIpv4Routes(args[0]);
                case 'generateIpv6Routes':
                    return this.invokeWorker('generateRoutes', args[0]);
                case 'generateIpv4MvpnRoutes':
                    return this.invokeWorker('generateMvpnRoutes', args[0]);
                case 'generateIpv4QpRoutes':
                case 'generateIpv6QpRoutes':
                    return this.invokeWorker('generateQpRoutes', args[0]);
                case 'deleteIpv4Routes':
                case 'deleteIpv6Routes':
                    return this.invokeWorker('deleteRoute', args[0]);
                case 'deleteIpv4MvpnRoutes':
                    return this.invokeWorker('deleteMvpnRoutes', args[0]);
                case 'deleteIpv4QpRoutes':
                case 'deleteIpv6QpRoutes':
                    return this.invokeWorker('deleteQpRoute', args[0]);
                case 'deleteAllRoutesByFamily':
                    return this.invokeWorker('deleteAllRoutesByFamily', { addressFamily: args[0], ...(args[1] || {}) });
                case 'getRoutes':
                    return this.invokeWorker('getRoutes', {
                        addressFamily: args[0],
                        page: args[1],
                        pageSize: args[2],
                        ...(args[3] || {})
                    });
                case 'getRouteDetail':
                    return this.invokeWorker('getRouteDetail', {
                        addressFamily: args[0],
                        route: args[1]
                    });
                case 'getInstanceInfo':
                    return this.invokeWorker('getInstanceInfo', null);
                case 'getDefaultMrtFiles':
                    return successResponse([]);
                case 'importRouteViewsData':
                    return errorResponse('E2E does not import RouteViews data');
                case 'openExternal':
                    this.record('open external ignored', { url: args[0] });
                    return successResponse(null, 'openExternal ignored in E2E');
                default:
                    return errorResponse(`Unsupported BGP E2E method: ${method}`);
            }
        }

        saveBgpConfig(config) {
            this.savedBgpConfig = this.normalizeBgpConfig(config);
            this.record('BGP config saved', this.savedBgpConfig);
            return successResponse(null, 'BGP配置文件保存成功');
        }

        loadBgpConfig() {
            return successResponse(
                this.savedBgpConfig,
                this.savedBgpConfig ? 'BGP配置文件加载成功' : 'BGP配置文件不存在'
            );
        }

        saveIpv4PeerConfig(config) {
            this.savedIpv4PeerConfig = this.normalizeIpv4PeerConfig(config);
            this.record('IPv4 peer config saved', this.savedIpv4PeerConfig);
            return successResponse(null, 'IPv4 Peer配置保存成功');
        }

        saveIpv4RouteConfig(config) {
            this.savedIpv4RouteConfig = this.normalizeIpv4RouteConfig(config);
            this.record('IPv4 route config saved', this.savedIpv4RouteConfig);
            return successResponse(null, 'IPv4-UNC路由配置保存成功');
        }

        async startBgp(config) {
            if (this.server) {
                return errorResponse('bgp协议已经启动');
            }
            if (!this.bgpPort) {
                this.setBgpPort(await BgpE2eController.getFreePort());
            }

            this.savedBgpConfig = this.normalizeBgpConfig(config);
            this.record('starting BGP worker TCP server', {
                port: this.bgpPort,
                config: this.savedBgpConfig
            });

            const result = await this.invokeWorker('startBgp', this.savedBgpConfig);
            if (result.status !== 'success') {
                this.record('BGP worker start failed', this.summarizeResponse('startBgp', result));
            }
            return result;
        }

        async startTcpServer(messageId) {
            try {
                const createServer = protocol =>
                    net.createServer(socket => {
                        const clientAddress = socket.remoteAddress;
                        const clientPort = socket.remotePort;

                        this.record('BGP TCP client connected', {
                            protocol,
                            localAddress: socket.localAddress,
                            localPort: socket.localPort,
                            remoteAddress: clientAddress,
                            remotePort: clientPort
                        });

                        socket.on('data', data => {
                            this.record('BGP TCP data received', {
                                protocol,
                                remoteAddress: clientAddress,
                                remotePort: clientPort,
                                bytes: data.length
                            });
                            const session = this.worker.bgpSessionMap.get(BgpSession.makeKey(0, socket.remoteAddress));
                            if (!session) {
                                this.record('BGP TCP data rejected because session is missing', {
                                    remoteAddress: socket.remoteAddress
                                });
                                socket.destroy();
                                return;
                            }
                            session.recvMsg(data);
                        });

                        socket.on('end', () => {
                            this.record('BGP TCP client ended', {
                                protocol,
                                remoteAddress: clientAddress,
                                remotePort: clientPort
                            });
                        });

                        socket.on('close', () => {
                            this.record('BGP TCP client closed', {
                                protocol,
                                remoteAddress: clientAddress,
                                remotePort: clientPort
                            });
                            const session = this.worker.bgpSessionMap.get(BgpSession.makeKey(0, clientAddress));
                            if (session) {
                                session.handleSocketClosed(socket);
                            }
                        });

                        socket.on('error', error => {
                            this.record('BGP TCP socket error', {
                                protocol,
                                remoteAddress: clientAddress,
                                remotePort: clientPort,
                                error: error.message
                            });
                        });

                        const originalWrite = socket.write.bind(socket);
                        socket.write = (chunk, ...args) => {
                            this.captureBgpPacket(socket, chunk);
                            return originalWrite(chunk, ...args);
                        };

                        const session = this.worker.bgpSessionMap.get(BgpSession.makeKey(0, socket.remoteAddress));
                        if (!session) {
                            this.record('BGP TCP connection rejected because peer is not configured', {
                                remoteAddress: socket.remoteAddress
                            });
                            socket.destroy();
                            return;
                        }

                        session.tcpConnectSuccess(socket);
                        if (this.advertisedNextHop) {
                            session.localIp = this.advertisedNextHop;
                        }
                    });

                this.server = createServer('ipv4');
                this.ipv6Server = createServer('ipv6');

                await new Promise((resolve, reject) => {
                    this.server.once('error', reject);
                    this.server.listen(this.bgpPort, this.listenHost, resolve);
                });
                try {
                    await new Promise((resolve, reject) => {
                        this.ipv6Server.once('error', reject);
                        this.ipv6Server.listen(
                            { port: this.bgpPort, host: this.ipv6ListenHost, ipv6Only: true },
                            resolve
                        );
                    });
                } catch (error) {
                    this.record('BGP IPv6 TCP server start skipped', { error: error.message });
                    this.ipv6Server = null;
                }

                this.worker.server = this.server;
                this.worker.ipv6Server = this.ipv6Server;
                this.record('BGP TCP server started', {
                    host: this.listenHost,
                    ipv6Host: this.ipv6Server ? this.ipv6ListenHost : null,
                    port: this.bgpPort
                });
                this.worker.messageHandler.sendSuccessResponse(messageId, null, 'bgp协议启动成功');
            } catch (error) {
                this.record('BGP TCP server start failed', { error: error.message });
                this.server = null;
                this.worker.server = null;
                this.worker.messageHandler.sendErrorResponse(messageId, `bgp协议启动失败: ${error.message}`);
            }
        }

        captureBgpPacket(socket, chunk) {
            const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk || '');
            if (buffer.length < BgpConst.BGP_HEAD_LEN) return;
            if (!buffer.subarray(0, BgpConst.BGP_MARKER_LEN).every(value => value === 0xff)) return;

            const length = buffer.readUInt16BE(BgpConst.BGP_MARKER_LEN);
            const type = buffer.readUInt8(BgpConst.BGP_MARKER_LEN + 2);
            const captured = {
                at: Date.now(),
                peerIp: socket.remoteAddress,
                type,
                length,
                wireLength: buffer.length,
                validLength: length === buffer.length
            };

            if (type === BgpConst.BGP_PACKET_TYPE.UPDATE) {
                try {
                    const session = this.worker.bgpSessionMap.get(BgpSession.makeKey(0, socket.remoteAddress));
                    const parsed = parseBgpPacket(buffer, session || null);
                    const mpReach = (parsed.pathAttributes || []).find(attribute => attribute.mpReach)?.mpReach;
                    const nlri = mpReach?.nlri || parsed.nlri || [];
                    captured.valid = parsed.valid !== false;
                    captured.afi = mpReach?.afi ?? BgpConst.BGP_AFI_TYPE.AFI_IPV4;
                    captured.safi = mpReach?.safi ?? BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;
                    captured.nlriCount = nlri.length;
                    captured.nlri = nlri.map(route => ({
                        prefix: route.prefix,
                        length: route.length,
                        pathId: route.pathId ?? 0,
                        label: route.labels?.[0]?.label ?? route.label?.label ?? route.label ?? null
                    }));
                    captured.error = parsed.error || '';
                } catch (error) {
                    captured.valid = false;
                    captured.parseError = error.message;
                }
            }

            this.capturedBgpPackets.push(captured);
        }

        clearCapturedBgpPackets() {
            this.capturedBgpPackets = [];
        }

        getCapturedBgpPackets(type = null) {
            return this.capturedBgpPackets
                .filter(packet => type === null || packet.type === type)
                .map(packet => ({ ...packet }));
        }

        async stopBgp() {
            if (!this.worker.bgpConfigData && !this.server) {
                return successResponse(null, 'BGP未启动');
            }

            const result = await this.invokeWorker('stopBgp', null);
            this.server = null;
            this.ipv6Server = null;
            return result.status === 'success' ? result : successResponse(null, 'bgp协议停止成功');
        }

        async configIpv4Peer(config) {
            this.savedIpv4PeerConfig = this.normalizeIpv4PeerConfig(config);
            return this.invokeWorker('configIpv4Peer', this.savedIpv4PeerConfig);
        }

        async generateIpv4Routes(config) {
            this.savedIpv4RouteConfig = this.normalizeIpv4RouteConfig(config);
            return this.invokeWorker('generateRoutes', this.savedIpv4RouteConfig);
        }

        async invokeWorker(methodName, data) {
            const messageId = `${methodName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            this.worker.messageHandler.responses.delete(messageId);

            try {
                const result = this.worker[methodName](messageId, data);
                if (result && typeof result.then === 'function') {
                    await result;
                }
                const response = await this.worker.messageHandler.waitForResponse(messageId);
                this.worker.messageHandler.responses.delete(messageId);
                this.record(`worker query: ${methodName}`, {
                    response: this.summarizeResponse(methodName, response)
                });
                return response || errorResponse(`${methodName} did not return a response`);
            } catch (error) {
                this.worker.messageHandler.responses.delete(messageId);
                this.record(`worker query failed: ${methodName}`, {
                    error: error.message
                });
                return errorResponse(error.message);
            }
        }

        async startMockClient({
            host = '127.0.0.1',
            localAs = 100,
            routerId = '192.0.2.2',
            holdTime = 90,
            addressFamilies = ['ipv4-unc'],
            addPathAddressFamilies = [],
            extendedNextHop = false
        } = {}) {
            if (!this.bgpPort) {
                throw new Error('BGP server port has not been allocated');
            }

            await this.stopMockClient();
            this.mockClientOutput = '';
            this.mockClientLineBuffer = '';
            this.mockClientEvents = [];
            this.mockClientExit = null;
            this.mockClientExitPromise = null;

            const scriptPath = path.join(projectRoot, 'scripts', 'mockBgpClient.js');
            this.record('starting mockBgpClient script', {
                script: 'scripts/mockBgpClient.js',
                host,
                port: this.bgpPort,
                localAs,
                routerId,
                holdTime,
                addressFamilies,
                addPathAddressFamilies,
                extendedNextHop
            });

            const args = [
                scriptPath,
                '--host',
                host,
                '--port',
                String(this.bgpPort),
                '--local-as',
                String(localAs),
                '--router-id',
                routerId,
                '--hold-time',
                String(holdTime),
                '--address-family',
                addressFamilies.join(',')
            ];
            if (addPathAddressFamilies.length > 0) {
                args.push('--add-path-address-family', addPathAddressFamilies.join(','));
            }
            if (extendedNextHop) {
                args.push('--extended-next-hop');
            }

            this.mockClient = spawn(process.execPath, args, {
                cwd: projectRoot,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            this.mockClient.stdout.on('data', chunk => this.handleMockClientOutput(chunk));
            this.mockClient.stderr.on('data', chunk => this.handleMockClientOutput(chunk));
            this.mockClient.once('error', error => {
                this.mockClientExit = { error: error.message };
                this.record('mockBgpClient error', { error: error.message });
            });
            this.mockClientExitPromise = new Promise(resolve => {
                const child = this.mockClient;
                child.once('exit', (code, signal) => {
                    const exitInfo = {
                        code,
                        signal,
                        output: this.mockClientOutput,
                        events: [...this.mockClientEvents]
                    };
                    this.mockClientExit = exitInfo;
                    if (this.mockClient === child) {
                        this.mockClient = null;
                    }
                    this.record('mockBgpClient exited', { code, signal });
                    resolve(exitInfo);
                });
            });

            await this.waitForClientEvent('connected', () => true, 10000);
        }

        handleMockClientOutput(chunk) {
            const text = chunk.toString();
            this.mockClientOutput += text;
            this.mockClientLineBuffer += text;

            const lines = this.mockClientLineBuffer.split(/\r?\n/u);
            this.mockClientLineBuffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }
                try {
                    const event = JSON.parse(line);
                    this.mockClientEvents.push(event);
                    this.record('mockBgpClient event', event);
                } catch (error) {
                    this.record('mockBgpClient output', { line });
                }
            }
        }

        async waitForClientEvent(eventName, predicate = () => true, timeout = 10000) {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const found = this.mockClientEvents.find(event => event.event === eventName && predicate(event));
                if (found) {
                    return found;
                }
                if (this.mockClientExit && this.mockClientExit.code !== null && eventName !== 'closed') {
                    throw new Error(`mockBgpClient exited before ${eventName}:\n${this.mockClientOutput}`);
                }
                await delay(50);
            }

            throw new Error(`Timed out waiting for mockBgpClient event ${eventName}:\n${this.mockClientOutput}`);
        }

        async waitForPeerState(peerIp, state, timeout = 10000, addressFamily = BgpConst.BGP_ADDR_FAMILY.IPV4_UNC) {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const response = await this.invokeWorker('getPeerInfo', null);
                const peers = response.data?.[addressFamily] || [];
                const peer = peers.find(item => item.peerIp === peerIp && item.peerState === state);
                if (peer) {
                    return peer;
                }
                await delay(100);
            }

            throw new Error(`Timed out waiting for peer ${peerIp} to reach ${state}`);
        }

        seedInterleavedIpv4QpRoutes({
            count = 5000,
            baseIp = (10 << 24) + (90 << 16) + 1,
            mask = 32,
            dqpn = 7,
            nextHopA = '2001:db8::a',
            nextHopB = '2001:db8::b'
        } = {}) {
            const instance = this.worker.bgpInstanceMap.get(
                BgpInstance.makeKey(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_QP)
            );
            if (!instance) {
                throw new Error('IPv4 QP BGP instance does not exist');
            }

            for (let index = 0; index < count; index++) {
                const route = new BgpRoute(instance);
                route.ip = ipv4FromNumber(baseIp + index);
                route.mask = mask;
                route.dqpn = dqpn;
                const key = BgpRoute.makeQpKey(route.dqpn, route.ip, route.mask);
                instance.setRoute(key, route, { nextHop: index % 2 === 0 ? nextHopA : nextHopB });
            }

            const attributeGroupCount = instance.getAttributeGroupCount();
            return {
                routeCount: instance.routeMap.size,
                attrCount: attributeGroupCount,
                attrGroupCount: attributeGroupCount
            };
        }

        async waitForRoutes(addressFamily, expectedRoutes, timeout = 10000) {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const response = await this.invokeWorker('getRoutes', {
                    addressFamily,
                    page: 1,
                    pageSize: 25
                });
                if (response.status === 'success' && response.data.total >= expectedRoutes) {
                    return response.data;
                }
                await delay(100);
            }

            throw new Error(`Timed out waiting for ${expectedRoutes} BGP routes`);
        }

        getClientUpdates() {
            return this.mockClientEvents.filter(event => event.event === 'received-update');
        }

        async waitForClientUpdates(predicate, timeout = 10000) {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const updates = this.getClientUpdates();
                if (predicate(updates)) {
                    return updates;
                }
                if (this.mockClientExit && this.mockClientExit.code !== null) {
                    throw new Error(`mockBgpClient exited before expected UPDATE packets:\n${this.mockClientOutput}`);
                }
                await delay(50);
            }

            throw new Error(`Timed out waiting for expected UPDATE packets:\n${this.mockClientOutput}`);
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
            this.record('mockBgpClient stopped');
        }

        async waitForMockClientExit({ timeout = 5000 } = {}) {
            if (this.mockClientExit) {
                return this.mockClientExit;
            }

            if (!this.mockClientExitPromise) {
                throw new Error('BGP mock client has not been started');
            }

            return Promise.race([
                this.mockClientExitPromise,
                new Promise((_, reject) => {
                    setTimeout(() => {
                        reject(new Error(`Timed out waiting for BGP mock client exit:\n${this.mockClientOutput}`));
                    }, timeout);
                })
            ]);
        }

        async cleanup() {
            await this.stopBgp();
            await this.stopMockClient();
        }
    }

    return BgpE2eController;
})();

module.exports = {
    BgpE2eController,
    bgpBrowserMockScript,
    bgpPageApiScript,
    createBgpPageState,
    handlePageCall
};
