const fs = require('fs');
const { app } = require('electron');
const path = require('path');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const WorkerWithPromise = require('../worker/workerWithPromise');
const logger = require('../log/logger');
const BgpConst = require('../const/bgpConst');
const EventDispatcher = require('../utils/eventDispatcher');
const { getAfiAndSafi } = require('../utils/bgpUtils');
const { shell } = require('electron');
const { importMrtFile } = require('../utils/routeViewsUtils');
const { collectBgpGeneratedRoutes } = require('../utils/bgpRouteGenerator');
const {
    getBgpRouteDataFilePath,
    iterateJsonlBgpRoutes,
    countBgpRoutes,
    upsertBgpRoutesToJsonl,
    deleteBgpRoutesFromJsonl,
    clearBgpRouteJsonl
} = require('../utils/bgpRouteStorage');
const { fileExists, ensureParentDir } = require('../utils/rpkiRoaImport');
class BgpApp {
    constructor(ipc, store) {
        this.worker = null;
        this.bgpConfigFileKey = 'bgp-config';
        this.ipv4PeerConfigFileKey = 'ipv4-peer-config';
        this.ipv6PeerConfigFileKey = 'ipv6-peer-config';
        this.ipv4UNCRouteConfigFileKey = 'ipv4-unc-route-config';
        this.ipv6UNCRouteConfigFileKey = 'ipv6-unc-route-config';
        this.ipv4MvpnRouteConfigFileKey = 'ipv4-mvpn-route-config';
        this.ipv4QpRouteConfigFileKey = 'ipv4-qp-route-config';
        this.ipv6QpRouteConfigFileKey = 'ipv6-qp-route-config';
        this.bgpRouteMetaFileKey = 'bgp-routes-meta';
        this.isDev = !app.isPackaged;
        this.peerChangeHandler = null;
        this.store = store;
        this.eventDispatcher = null;
        this.logLevel = null;
        this.startedAddressFamilies = new Set();
        // 注册IPC处理程序
        this.registerHandlers(ipc);
    }

    registerHandlers(ipc) {
        // 配置相关
        ipc.handle('bgp:saveBgpConfig', async (event, config) => this.handleSaveBgpConfig(event, config));
        ipc.handle('bgp:loadBgpConfig', async () => this.handleLoadBgpConfig());
        ipc.handle('bgp:saveIpv4PeerConfig', async (event, config) => this.handleSaveIpv4PeerConfig(event, config));
        ipc.handle('bgp:loadIpv4PeerConfig', async () => this.handleLoadIpv4PeerConfig());
        ipc.handle('bgp:saveIpv6PeerConfig', async (event, config) => this.handleSaveIpv6PeerConfig(event, config));
        ipc.handle('bgp:loadIpv6PeerConfig', async () => this.handleLoadIpv6PeerConfig());
        ipc.handle('bgp:saveIpv4UNCRouteConfig', async (event, config) =>
            this.handleSaveIpv4UNCRouteConfig(event, config)
        );
        ipc.handle('bgp:loadIpv4UNCRouteConfig', async () => this.handleLoadIpv4UNCRouteConfig());
        ipc.handle('bgp:saveIpv6UNCRouteConfig', async (event, config) =>
            this.handleSaveIpv6UNCRouteConfig(event, config)
        );
        ipc.handle('bgp:loadIpv6UNCRouteConfig', async () => this.handleLoadIpv6UNCRouteConfig());

        // bgp
        ipc.handle('bgp:startBgp', async (event, bgpConfigData) => this.handleStartBgp(event, bgpConfigData));
        ipc.handle('bgp:stopBgp', async () => this.handleStopBgp());

        // peer
        ipc.handle('bgp:configIpv4Peer', async (event, ipv4PeerConfigData) =>
            this.handleConfigIpv4Peer(event, ipv4PeerConfigData)
        );
        ipc.handle('bgp:configIpv6Peer', async (event, ipv6PeerConfigData) =>
            this.handleConfigIpv6Peer(event, ipv6PeerConfigData)
        );
        ipc.handle('bgp:getPeerInfo', async () => this.handleGetPeerInfo());
        ipc.handle('bgp:deletePeer', async (event, peer) => this.handleDeletePeer(event, peer));

        // route
        ipc.handle('bgp:generateIpv4Routes', async (event, config) => this.handleGenerateIpv4Routes(event, config));
        ipc.handle('bgp:generateIpv6Routes', async (event, config) => this.handleGenerateIpv6Routes(event, config));
        ipc.handle('bgp:deleteIpv4Routes', async (event, config) => this.handleDeleteIpv4Routes(event, config));
        ipc.handle('bgp:deleteIpv6Routes', async (event, config) => this.handleDeleteIpv6Routes(event, config));
        ipc.handle('bgp:deleteAllRoutesByFamily', async (event, addressFamily) =>
            this.handleDeleteAllRoutesByFamily(event, addressFamily)
        );
        ipc.handle('bgp:getRoutes', async (event, addressFamily, page, pageSize) =>
            this.handleGetRoutes(event, addressFamily, page, pageSize)
        );
        ipc.handle('bgp:getRouteDetail', async (event, addressFamily, route) =>
            this.handleGetRouteDetail(event, addressFamily, route)
        );

        // qp route
        ipc.handle('bgp:saveIpv4QpRouteConfig', async (event, config) =>
            this.handleSaveIpv4QpRouteConfig(event, config)
        );
        ipc.handle('bgp:loadIpv4QpRouteConfig', async () => this.handleLoadIpv4QpRouteConfig());
        ipc.handle('bgp:saveIpv6QpRouteConfig', async (event, config) =>
            this.handleSaveIpv6QpRouteConfig(event, config)
        );
        ipc.handle('bgp:loadIpv6QpRouteConfig', async () => this.handleLoadIpv6QpRouteConfig());
        ipc.handle('bgp:generateIpv4QpRoutes', async (event, config) => this.handleGenerateIpv4QpRoutes(event, config));
        ipc.handle('bgp:generateIpv6QpRoutes', async (event, config) => this.handleGenerateIpv6QpRoutes(event, config));
        ipc.handle('bgp:deleteIpv4QpRoutes', async (event, config) => this.handleDeleteIpv4QpRoutes(event, config));
        ipc.handle('bgp:deleteIpv6QpRoutes', async (event, config) => this.handleDeleteIpv6QpRoutes(event, config));

        // mvpn route
        ipc.handle('bgp:saveIpv4MvpnRouteConfig', async (event, config) =>
            this.handleSaveIpv4MvpnRouteConfig(event, config)
        );
        ipc.handle('bgp:loadIpv4MvpnRouteConfig', async () => this.handleLoadIpv4MvpnRouteConfig());
        ipc.handle('bgp:generateIpv4MvpnRoutes', async (event, config) =>
            this.handleGenerateIpv4MvpnRoutes(event, config)
        );
        ipc.handle('bgp:deleteIpv4MvpnRoutes', async (event, config) => this.handleDeleteIpv4MvpnRoutes(event, config));

        // RouteViews 导入
        ipc.handle('bgp:selectMrtFile', this.handleSelectMrtFile.bind(this));
        ipc.handle('bgp:importRouteViewsData', this.handleImportRouteViewsData.bind(this));
        ipc.handle('bgp:getInstanceInfo', this.handleGetInstanceInfo.bind(this));
        ipc.handle('bgp:getDefaultMrtFiles', this.handleGetDefaultMrtFiles.bind(this));
        ipc.handle('bgp:openExternal', (event, url) => shell.openExternal(url));
    }

    // 保存配置
    async handleSaveBgpConfig(event, config) {
        try {
            this.store.set(this.bgpConfigFileKey, config);
            return successResponse(null, 'BGP配置文件保存成功');
        } catch (error) {
            logger.error('Error saving Bgp config:', error.message);
            return errorResponse(error.message);
        }
    }

    // 加载配置
    async handleLoadBgpConfig() {
        try {
            const config = this.store.get(this.bgpConfigFileKey);
            if (!config) {
                return successResponse(null, 'BGP配置文件不存在');
            }
            return successResponse(config, 'BGP配置文件加载成功');
        } catch (error) {
            logger.error('Error loading Bgp config:', error.message);
            return errorResponse(error.message);
        }
    }

    // 保存配置
    async handleSaveIpv4PeerConfig(event, config) {
        try {
            this.store.set(this.ipv4PeerConfigFileKey, config);
            return successResponse(null, 'IPv4 Peer配置文件保存成功');
        } catch (error) {
            logger.error('Error saving ipv4 peer config:', error.message);
            return errorResponse(error.message);
        }
    }

    // 加载配置
    async handleLoadIpv4PeerConfig() {
        try {
            const config = this.store.get(this.ipv4PeerConfigFileKey);
            if (!config) {
                return successResponse(null, 'IPv4 Peer配置文件不存在');
            }
            return successResponse(config, 'IPv4 Peer配置文件加载成功');
        } catch (error) {
            logger.error('Error loading ipv4 peer config:', error.message);
            return errorResponse(error.message);
        }
    }

    // 保存配置
    async handleSaveIpv6PeerConfig(event, config) {
        try {
            this.store.set(this.ipv6PeerConfigFileKey, config);
            return successResponse(null, 'IPv6 Peer配置文件保存成功');
        } catch (error) {
            logger.error('Error saving ipv6 peer config:', error.message);
            return errorResponse(error.message);
        }
    }

    // 加载配置
    async handleLoadIpv6PeerConfig() {
        try {
            const config = this.store.get(this.ipv6PeerConfigFileKey);
            if (!config) {
                return successResponse(null, 'IPv6 Peer配置文件不存在');
            }
            return successResponse(config, 'IPv6 Peer配置文件加载成功');
        } catch (error) {
            logger.error('Error loading ipv6 peer config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleSaveIpv4UNCRouteConfig(event, config) {
        try {
            this.store.set(this.ipv4UNCRouteConfigFileKey, config);
            return successResponse(null, 'IPv4 UNC Route配置文件保存成功');
        } catch (error) {
            logger.error('Error saving ipv4 unc route config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleLoadIpv4UNCRouteConfig() {
        try {
            const config = this.store.get(this.ipv4UNCRouteConfigFileKey);
            if (!config) {
                return successResponse(null, 'IPv4 UNC Route配置文件不存在');
            }
            return successResponse(config, 'IPv4 UNC Route配置文件加载成功');
        } catch (error) {
            logger.error('Error loading ipv4 unc route config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleSaveIpv6UNCRouteConfig(event, config) {
        try {
            this.store.set(this.ipv6UNCRouteConfigFileKey, config);
            return successResponse(null, 'IPv6 UNC Route配置文件保存成功');
        } catch (error) {
            logger.error('Error saving ipv6 unc route config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleLoadIpv6UNCRouteConfig() {
        try {
            const config = this.store.get(this.ipv6UNCRouteConfigFileKey);
            if (!config) {
                return successResponse(null, 'IPv6 UNC Route配置文件不存在');
            }
            return successResponse(config, 'IPv6 UNC Route配置文件加载成功');
        } catch (error) {
            logger.error('Error loading ipv6 unc route config:', error.message);
            return errorResponse(error.message);
        }
    }

    getBgpRouteDataFilePath(addressFamily = null) {
        return getBgpRouteDataFilePath(app.getPath('userData'), addressFamily);
    }

    async ensureBgpRouteFileStorage(addressFamily = null) {
        const filePath = this.getBgpRouteDataFilePath(addressFamily);
        await ensureParentDir(filePath);

        if (!(await fileExists(filePath))) {
            await fs.promises.writeFile(filePath, '', 'utf8');
            await this.updateBgpRouteMeta(0);
            return filePath;
        }

        const meta = this.store.get(this.bgpRouteMetaFileKey);
        if (!addressFamily && (!meta || typeof meta.count !== 'number')) {
            await this.updateBgpRouteMeta(await countBgpRoutes(filePath));
        }

        return filePath;
    }

    async updateBgpRouteMeta(count) {
        this.store.set(this.bgpRouteMetaFileKey, {
            storageVersion: 1,
            count,
            updatedAt: new Date().toISOString()
        });
    }

    async getBgpRouteTotalCount(filePath) {
        const meta = this.store.get(this.bgpRouteMetaFileKey);
        if (meta && typeof meta.count === 'number') {
            return meta.count;
        }

        const count = await countBgpRoutes(filePath);
        await this.updateBgpRouteMeta(count);
        return count;
    }

    getRouteConfigStoreKey(addressFamily) {
        switch (addressFamily) {
            case BgpConst.BGP_ADDR_FAMILY.IPV4_UNC:
                return this.ipv4UNCRouteConfigFileKey;
            case BgpConst.BGP_ADDR_FAMILY.IPV6_UNC:
                return this.ipv6UNCRouteConfigFileKey;
            case BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN:
                return this.ipv4MvpnRouteConfigFileKey;
            case BgpConst.BGP_ADDR_FAMILY.IPV4_QP:
                return this.ipv4QpRouteConfigFileKey;
            case BgpConst.BGP_ADDR_FAMILY.IPV6_QP:
                return this.ipv6QpRouteConfigFileKey;
            default:
                return null;
        }
    }

    getStartedAddressFamiliesFromConfig(config) {
        return new Set((Array.isArray(config?.addressFamily) ? config.addressFamily : []).map(item => Number(item)));
    }

    isAddressFamilyStarted(addressFamily) {
        return this.startedAddressFamilies.has(Number(addressFamily));
    }

    saveLastRouteConfig(config) {
        const key = this.getRouteConfigStoreKey(config?.addressFamily);
        if (key) {
            this.store.set(key, config);
        }
    }

    getInstanceAttrsForFamily(addressFamily) {
        const key = this.getRouteConfigStoreKey(addressFamily);
        const config = key ? this.store.get(key) || {} : {};
        return {
            customAttr: config.customAttr || '',
            rt: config.rt || '',
            bsid: config.bsid || ''
        };
    }

    getRouteRuntimeError(addressFamily) {
        if (!this.worker) {
            return 'bgp协议没有运行';
        }

        if (addressFamily && !this.isAddressFamilyStarted(addressFamily)) {
            return '地址族未启动，请先在BGP配置中使能该地址族';
        }

        return null;
    }

    async loadBgpRouteStorageToWorker(announce = false, addressFamilies = null) {
        if (!this.worker) {
            return { loaded: 0 };
        }

        const hasFamilyFilter = addressFamilies !== null && addressFamilies !== undefined;
        const enabledFamilies =
            addressFamilies instanceof Set
                ? addressFamilies
                : new Set((Array.isArray(addressFamilies) ? addressFamilies : []).map(item => Number(item)));
        const batchSize = 5000;
        const batches = new Map();
        let loaded = 0;

        const flush = async addressFamily => {
            const routes = batches.get(addressFamily);
            if (!routes || routes.length === 0) {
                return;
            }

            batches.set(addressFamily, []);
            const result = await this.worker.sendRequest(BgpConst.BGP_REQ_TYPES.IMPORT_ROUTES, {
                addressFamily,
                routes,
                announce,
                instanceAttrs: this.getInstanceAttrsForFamily(addressFamily),
                singleRouteSend: routes.some(route => route.asPath)
            });
            if (result.status !== 'success') {
                logger.error(`worker BGP路由恢复失败: ${result.msg}`);
            }
        };

        const routeFamilies = hasFamilyFilter
            ? Array.from(enabledFamilies)
            : [
                  BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
                  BgpConst.BGP_ADDR_FAMILY.IPV6_UNC,
                  BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN,
                  BgpConst.BGP_ADDR_FAMILY.IPV4_QP,
                  BgpConst.BGP_ADDR_FAMILY.IPV6_QP
              ];

        for (const addressFamily of routeFamilies) {
            const filePath = await this.ensureBgpRouteFileStorage(addressFamily);
            for await (const route of iterateJsonlBgpRoutes(filePath)) {
                if (route.addressFamily !== addressFamily) {
                    continue;
                }

                if (!batches.has(route.addressFamily)) {
                    batches.set(route.addressFamily, []);
                }

                const routes = batches.get(route.addressFamily);
                routes.push(route);
                loaded += 1;

                if (routes.length >= batchSize) {
                    await flush(route.addressFamily);
                }
            }
        }

        for (const addressFamily of batches.keys()) {
            await flush(addressFamily);
        }

        logger.info(`worker BGP路由批量加载完成: loaded=${loaded}, announce=${announce}`);
        return { loaded };
    }

    async persistGeneratedRoutes(config, reqType, successMsg, options = {}) {
        this.saveLastRouteConfig(config);
        const runtimeError = this.getRouteRuntimeError(config?.addressFamily);
        if (runtimeError) {
            logger.error(`${successMsg}失败: ${runtimeError}`);
            return errorResponse(runtimeError);
        }

        const routes = collectBgpGeneratedRoutes(config, options);
        const workerResult = await this.worker.sendRequest(reqType, config);
        const filePath = await this.ensureBgpRouteFileStorage(config.addressFamily);
        const result = await upsertBgpRoutesToJsonl(filePath, routes);
        await this.updateBgpRouteMeta(result.total);

        return successResponse(
            {
                added: result.added,
                updated: result.updated,
                unchanged: result.unchanged,
                total: result.total
            },
            workerResult.msg || successMsg
        );
    }

    async deleteGeneratedRoutes(config, reqType, successMsg, options = {}) {
        const runtimeError = this.getRouteRuntimeError(config?.addressFamily);
        if (runtimeError) {
            logger.error(`${successMsg}失败: ${runtimeError}`);
            return errorResponse(runtimeError);
        }

        const routes = collectBgpGeneratedRoutes(config, options);
        const workerResult = await this.worker.sendRequest(reqType, config);
        const filePath = await this.ensureBgpRouteFileStorage(config.addressFamily);
        const result = await deleteBgpRoutesFromJsonl(filePath, routes);
        await this.updateBgpRouteMeta(result.total);

        return successResponse({ deleted: result.deleted, total: result.total }, workerResult.msg || successMsg);
    }

    async handleDeletePeer(event, peer) {
        try {
            if (null === this.worker) {
                logger.error('bgp协议没有运行');
                return errorResponse('bgp协议没有运行');
            }

            logger.info(`delete peer: ${JSON.stringify(peer)}`);

            const result = await this.worker.sendRequest(BgpConst.BGP_REQ_TYPES.DELETE_PEER, peer);
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('Error deleting peer:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleConfigIpv4Peer(event, ipv4PeerConfigData) {
        try {
            if (null === this.worker) {
                logger.error(`bgp协议没有启动`);
                return errorResponse('bgp协议没有启动');
            }

            logger.info(`ipv4 peer config: ${JSON.stringify(ipv4PeerConfigData)}`);

            const result = await this.worker.sendRequest(BgpConst.BGP_REQ_TYPES.CONFIG_IPV4_PEER, ipv4PeerConfigData);

            // 这里肯定是启动成功了，如果失败，会抛出异常
            logger.info(`ipv4 config peer成功 result: ${JSON.stringify(result)}`);

            return successResponse(null, result.msg);
        } catch (error) {
            logger.error(`ipv4 Error config Peer:`, error.message);
            return errorResponse(error.message);
        }
    }

    async handleConfigIpv6Peer(event, ipv6PeerConfigData) {
        try {
            if (null === this.worker) {
                logger.error(`bgp协议没有启动`);
                return errorResponse('bgp协议没有启动');
            }

            logger.info(`ipv6 peer config: ${JSON.stringify(ipv6PeerConfigData)}`);

            const result = await this.worker.sendRequest(BgpConst.BGP_REQ_TYPES.CONFIG_IPV6_PEER, ipv6PeerConfigData);

            // 这里肯定是启动成功了，如果失败，会抛出异常
            logger.info(`ipv6 config peer成功 result: ${JSON.stringify(result)}`);

            return successResponse(null, result.msg);
        } catch (error) {
            logger.error(`ipv6 Error config Peer:`, error.message);
            return errorResponse(error.message);
        }
    }

    async handleStartBgp(event, bgpConfigData) {
        const webContents = event.sender;
        try {
            if (null !== this.worker) {
                logger.error(`bgp协议已经启动`);
                return errorResponse('bgp协议已经启动');
            }

            logger.info(`${JSON.stringify(bgpConfigData)}`);
            const startedAddressFamilies = this.getStartedAddressFamiliesFromConfig(bgpConfigData);

            // 获取日志级别配置
            if (this.logLevel) {
                bgpConfigData.logLevel = this.logLevel;
            }

            const workerPath = this.isDev
                ? path.join(__dirname, '../worker/bgpWorker.js')
                : path.join(process.resourcesPath, 'app', 'electron/worker/bgpWorker.js');

            const workerFactory = new WorkerWithPromise(workerPath);
            this.worker = workerFactory.createLongRunningWorker();

            // 设置事件发送器的 webContents
            this.eventDispatcher = new EventDispatcher();
            this.eventDispatcher.setWebContents(webContents);

            // 定义事件处理函数
            this.peerChangeHandler = data => {
                this.eventDispatcher.emit('bgp:peerChange', successResponse(data.data));
            };

            // 注册事件监听器，处理来自worker的事件通知
            this.worker.addEventListener(BgpConst.BGP_EVT_TYPES.BGP_PEER_CHANGE, this.peerChangeHandler);

            const result = await this.worker.sendRequest(BgpConst.BGP_REQ_TYPES.START_BGP, bgpConfigData);
            this.startedAddressFamilies = startedAddressFamilies;
            await this.loadBgpRouteStorageToWorker(false, startedAddressFamilies);

            // 这里肯定是启动成功了，如果失败，会抛出异常
            logger.info(`bgp启动成功 result: ${JSON.stringify(result)}`);
            return successResponse(null, result.msg);
        } catch (error) {
            if (this.worker) {
                this.worker.removeEventListener(BgpConst.BGP_EVT_TYPES.BGP_PEER_CHANGE, this.peerChangeHandler);
                await this.worker.terminate();
                this.worker = null;
            }
            this.startedAddressFamilies.clear();
            if (this.eventDispatcher) {
                this.eventDispatcher.cleanup(); // 清理事件发送器
            }
            this.eventDispatcher = null;
            logger.error('Error starting BGP:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleStopBgp() {
        if (null === this.worker) {
            logger.error('BGP未启动');
            return errorResponse('BGP未启动');
        }

        try {
            const result = await this.worker.sendRequest(BgpConst.BGP_REQ_TYPES.STOP_BGP, null);
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('Error stopping BGP:', error.message);
            return errorResponse(error.message);
        } finally {
            // 移除事件监听器
            this.worker.removeEventListener(BgpConst.BGP_EVT_TYPES.BGP_PEER_CHANGE, this.peerChangeHandler);
            await this.worker.terminate();
            this.worker = null;
            this.startedAddressFamilies.clear();
            this.eventDispatcher.cleanup(); // 清理事件发送器
            this.eventDispatcher = null;
        }
    }

    async handleGetInstanceInfo() {
        if (!this.worker) {
            return errorResponse('BGP worker is not running');
        }
        try {
            const result = await this.worker.sendRequest(BgpConst.BGP_REQ_TYPES.GET_INSTANCE_INFO, null);
            return successResponse(result.data, '实例信息查询成功');
        } catch (error) {
            logger.error(`Error getting instance info: ${error}`);
            return errorResponse(error.message);
        }
    }

    async handleGetPeerInfo() {
        if (null === this.worker) {
            return successResponse({}, 'bgp协议没有运行');
        }

        try {
            const result = await this.worker.sendRequest(BgpConst.BGP_REQ_TYPES.GET_PEER_INFO, null);
            logger.info(`获取Peer信息成功 result: ${JSON.stringify(result)}`);
            return successResponse(result.data, '获取Peer信息成功');
        } catch (error) {
            logger.error('Error getting peer info:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGenerateIpv4Routes(event, config) {
        try {
            logger.info(`${JSON.stringify(config)}`);
            return await this.persistGeneratedRoutes(
                config,
                BgpConst.BGP_REQ_TYPES.GENERATE_IPV4_ROUTES,
                '路由生成成功'
            );
        } catch (error) {
            logger.error('Error generating ipv4 routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGenerateIpv6Routes(event, config) {
        try {
            logger.info(`${JSON.stringify(config)}`);
            return await this.persistGeneratedRoutes(
                config,
                BgpConst.BGP_REQ_TYPES.GENERATE_IPV6_ROUTES,
                '路由生成成功'
            );
        } catch (error) {
            logger.error('Error generating ipv6 routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteIpv4Routes(event, config) {
        try {
            logger.info(`${JSON.stringify(config)}`);
            return await this.deleteGeneratedRoutes(
                config,
                BgpConst.BGP_REQ_TYPES.DELETE_IPV4_ROUTES,
                '路由删除成功'
            );
        } catch (error) {
            logger.error('Error deleting ipv4 routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteIpv6Routes(event, config) {
        try {
            logger.info(`${JSON.stringify(config)}`);
            return await this.deleteGeneratedRoutes(
                config,
                BgpConst.BGP_REQ_TYPES.DELETE_IPV6_ROUTES,
                '路由删除成功'
            );
        } catch (error) {
            logger.error('Error deleting ipv6 routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetRoutes(event, addressFamily, page, pageSize) {
        try {
            if (null === this.worker) {
                return successResponse({ list: [], total: 0 }, 'bgp协议没有运行');
            }

            if (!this.isAddressFamilyStarted(addressFamily)) {
                return successResponse({ list: [], total: 0 }, '地址族未启动');
            }

            logger.info(`addressFamily: ${addressFamily}, page: ${page}, pageSize: ${pageSize}`);
            const result = await this.worker.sendRequest(BgpConst.BGP_REQ_TYPES.GET_ROUTES, {
                addressFamily,
                page,
                pageSize
            });
            logger.info(`获取路由列表成功 result: ${JSON.stringify(result)}`);
            return successResponse(result.data, '获取路由信息成功');
        } catch (error) {
            logger.error('Error getting routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetRouteDetail(event, addressFamily, route) {
        try {
            if (null === this.worker) {
                return errorResponse('bgp协议没有运行');
            }

            if (!this.isAddressFamilyStarted(addressFamily)) {
                return errorResponse('地址族未启动');
            }

            const result = await this.worker.sendRequest(BgpConst.BGP_REQ_TYPES.GET_ROUTE_DETAIL, {
                addressFamily,
                route
            });
            return successResponse(result.data, result.msg || '获取路由详情成功');
        } catch (error) {
            logger.error('Error getting route detail:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteAllRoutesByFamily(event, addressFamily) {
        try {
            const runtimeError = this.getRouteRuntimeError(addressFamily);
            if (runtimeError) {
                logger.error(`删除全部路由失败: ${runtimeError}`);
                return errorResponse(runtimeError);
            }

            logger.info(`Deleting all routes for address family: ${addressFamily}`);
            const workerResult = await this.worker.sendRequest(BgpConst.BGP_REQ_TYPES.DELETE_ALL_ROUTES_BY_FAMILY, {
                addressFamily
            });
            const filePath = await this.ensureBgpRouteFileStorage(addressFamily);
            const result = await clearBgpRouteJsonl(filePath);
            await this.updateBgpRouteMeta(result.total);

            return successResponse(
                { deleted: workerResult.data?.deleted ?? result.deleted, total: result.total },
                workerResult.msg || '成功删除所有路由'
            );
        } catch (error) {
            logger.error('Error deleting all routes by family:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleSaveIpv4MvpnRouteConfig(event, config) {
        try {
            this.store.set(this.ipv4MvpnRouteConfigFileKey, config);
            return successResponse(null, 'IPv4 MVPN Route配置文件保存成功');
        } catch (error) {
            logger.error('Error saving ipv4 mvpn route config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleLoadIpv4MvpnRouteConfig() {
        try {
            const config = this.store.get(this.ipv4MvpnRouteConfigFileKey);
            if (!config) {
                return successResponse(null, 'IPv4 MVPN Route配置文件不存在');
            }
            return successResponse(config, 'IPv4 MVPN Route配置文件加载成功');
        } catch (error) {
            logger.error('Error loading ipv4 mvpn route config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGenerateIpv4MvpnRoutes(event, config) {
        try {
            logger.info(`${JSON.stringify(config)}`);
            return await this.persistGeneratedRoutes(
                config,
                BgpConst.BGP_REQ_TYPES.GENERATE_IPV4_MVPN_ROUTES,
                `MVPN路由生成成功`
            );
        } catch (error) {
            logger.error('Error generating ipv4 mvpn routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteIpv4MvpnRoutes(event, config) {
        try {
            logger.info(`${JSON.stringify(config)}`);
            return await this.deleteGeneratedRoutes(
                config,
                BgpConst.BGP_REQ_TYPES.DELETE_IPV4_MVPN_ROUTES,
                'MVPN路由删除成功'
            );
        } catch (error) {
            logger.error('Error deleting ipv4 mvpn routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleSaveIpv4QpRouteConfig(event, config) {
        try {
            this.store.set(this.ipv4QpRouteConfigFileKey, config);
            return successResponse(null, 'IPv4 QP Route配置文件保存成功');
        } catch (error) {
            logger.error('Error saving ipv4 qp route config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleLoadIpv4QpRouteConfig() {
        try {
            const config = this.store.get(this.ipv4QpRouteConfigFileKey);
            if (!config) {
                return successResponse(null, 'IPv4 QP Route配置文件不存在');
            }
            return successResponse(config, 'IPv4 QP Route配置文件加载成功');
        } catch (error) {
            logger.error('Error loading ipv4 qp route config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleSaveIpv6QpRouteConfig(event, config) {
        try {
            this.store.set(this.ipv6QpRouteConfigFileKey, config);
            return successResponse(null, 'IPv6 QP Route配置文件保存成功');
        } catch (error) {
            logger.error('Error saving ipv6 qp route config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleLoadIpv6QpRouteConfig() {
        try {
            const config = this.store.get(this.ipv6QpRouteConfigFileKey);
            if (!config) {
                return successResponse(null, 'IPv6 QP Route配置文件不存在');
            }
            return successResponse(config, 'IPv6 QP Route配置文件加载成功');
        } catch (error) {
            logger.error('Error loading ipv6 qp route config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGenerateIpv4QpRoutes(event, config) {
        try {
            return await this.persistGeneratedRoutes(
                config,
                BgpConst.BGP_REQ_TYPES.GENERATE_IPV4_QP_ROUTES,
                'QP路由生成成功'
            );
        } catch (error) {
            logger.error('Error generating ipv4 qp routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGenerateIpv6QpRoutes(event, config) {
        try {
            return await this.persistGeneratedRoutes(
                config,
                BgpConst.BGP_REQ_TYPES.GENERATE_IPV6_QP_ROUTES,
                'QP路由生成成功'
            );
        } catch (error) {
            logger.error('Error generating ipv6 qp routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteIpv4QpRoutes(event, config) {
        try {
            return await this.deleteGeneratedRoutes(
                config,
                BgpConst.BGP_REQ_TYPES.DELETE_IPV4_QP_ROUTES,
                'QP路由删除成功',
                { requireBsid: false }
            );
        } catch (error) {
            logger.error('Error deleting ipv4 qp routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleDeleteIpv6QpRoutes(event, config) {
        try {
            return await this.deleteGeneratedRoutes(
                config,
                BgpConst.BGP_REQ_TYPES.DELETE_IPV6_QP_ROUTES,
                'QP路由删除成功',
                { requireBsid: false }
            );
        } catch (error) {
            logger.error('Error deleting ipv6 qp routes:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleSelectMrtFile(_event) {
        const { dialog } = require('electron');
        const result = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [
                { name: 'MRT Files', extensions: ['gz', 'mrt'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (result.canceled || result.filePaths.length === 0) {
            return successResponse(null, '取消选择');
        }

        return successResponse(result.filePaths[0]);
    }

    async handleImportRouteViewsData(event, filePath, limit, addressFamily) {
        try {
            const runtimeError = this.getRouteRuntimeError(addressFamily);
            if (runtimeError) {
                logger.error(`RouteViews导入路由失败: ${runtimeError}`);
                return errorResponse(runtimeError);
            }

            logger.info(`Importing MRT file: ${filePath}, limit: ${limit}, AF: ${addressFamily}`);
            const { afi } = getAfiAndSafi(addressFamily);

            // Re-using the progress reporting logic
            const result = await importMrtFile(filePath, limit, afi, msg => {
                logger.info(`MRT Progress: ${msg}`);
                // Optional: We could emit an IPC event here to update the UI progress
                // this.eventSender('bgp:importProgress', msg);
            });

            if (result.status === 'success') {
                const routes = result.data.map(route => ({
                    ...route,
                    addressFamily
                }));
                const workerResult = await this.worker.sendRequest(BgpConst.BGP_REQ_TYPES.IMPORT_ROUTES, {
                    addressFamily,
                    routes,
                    announce: true,
                    singleRouteSend: true
                });
                const routeFilePath = await this.ensureBgpRouteFileStorage(addressFamily);
                const writeResult = await upsertBgpRoutesToJsonl(routeFilePath, routes);
                await this.updateBgpRouteMeta(writeResult.total);

                return successResponse(
                    {
                        imported: routes.length,
                        added: writeResult.added,
                        updated: writeResult.updated,
                        unchanged: writeResult.unchanged,
                        total: writeResult.total
                    },
                    workerResult.msg || '路由导入成功'
                );
            } else {
                return errorResponse(result.msg);
            }
        } catch (error) {
            logger.error('Error importing MRT data:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetDefaultMrtFiles() {
        const fs = require('fs').promises;
        const path = require('path');

        try {
            const bgpDataDir = path.join(__dirname, '../../bgpdata');

            logger.info(`Scanning default MRT files in: ${bgpDataDir}`);

            // Check if directory exists
            try {
                await fs.access(bgpDataDir);
            } catch (err) {
                logger.warn(`bgpdata directory not found: ${bgpDataDir}`);
                return successResponse([]);
            }

            // Read directory contents
            const files = await fs.readdir(bgpDataDir);
            const fileList = [];

            for (const file of files) {
                const filePath = path.join(bgpDataDir, file);
                try {
                    const stats = await fs.stat(filePath);
                    if (stats.isFile()) {
                        fileList.push({
                            name: file,
                            size: stats.size,
                            path: filePath
                        });
                    }
                } catch (err) {
                    logger.warn(`Error reading file stats for ${file}:`, err.message);
                }
            }

            logger.info(`Found ${fileList.length} default MRT files`);
            return successResponse(fileList);
        } catch (error) {
            logger.error('Error getting default MRT files:', error.message);
            return errorResponse(error.message);
        }
    }

    getBgpRunning() {
        return null !== this.worker;
    }
}

module.exports = BgpApp;
