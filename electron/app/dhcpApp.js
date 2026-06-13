const path = require('path');
const { app } = require('electron');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const WorkerWithPromise = require('../worker/workerWithPromise');
const DhcpConst = require('../const/dhcpConst');
const Dhcp6Const = require('../const/dhcp6Const');
const EventDispatcher = require('../utils/eventDispatcher');

class DhcpApp {
    constructor(ipcMain, store) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.dhcpConfigFileKey = 'dhcp-config';
        this.worker = null;
        this.worker6 = null;
        this.isDev = !app.isPackaged;
        this.logLevel = null;
        this.eventDispatcher = null;
        this.dhcpEvtHandler = null;
        this.dhcp6EvtHandler = null;

        this.registerIpcHandlers();
    }

    registerIpcHandlers() {
        this.ipcMain.handle('dhcp:saveDhcpConfig', this.handleSaveDhcpConfig.bind(this));
        this.ipcMain.handle('dhcp:getDhcpConfig', this.handleGetDhcpConfig.bind(this));
        this.ipcMain.handle('dhcp:startDhcp', this.handleStartDhcp.bind(this));
        this.ipcMain.handle('dhcp:stopDhcp', this.handleStopDhcp.bind(this));
        this.ipcMain.handle('dhcp:getLeaseList', this.handleGetLeaseList.bind(this));
        this.ipcMain.handle('dhcp:releaseLease', this.handleReleaseLease.bind(this));
        this.ipcMain.handle('dhcp:releaseDhcp6Lease', this.handleReleaseDhcp6Lease.bind(this));
    }

    async handleSaveDhcpConfig(event, config) {
        logger.info('handleSaveDhcpConfig', config);
        this.store.set(this.dhcpConfigFileKey, config);
        return successResponse(null, '配置保存成功');
    }

    async handleGetDhcpConfig() {
        const config = this.store.get(this.dhcpConfigFileKey);
        if (!config) {
            return successResponse(null, '配置不存在');
        }
        return successResponse(config, '配置获取成功');
    }

    async handleStartDhcp(event, config) {
        const webContents = event.sender;
        try {
            if (null !== this.worker) {
                logger.error('DHCP服务器已经启动');
                return errorResponse('DHCP服务器已经启动');
            }

            logger.info(`启动DHCP: ${JSON.stringify(config)}`);

            if (this.logLevel) {
                config.logLevel = this.logLevel;
            }

            const workerPath = this.isDev
                ? path.join(__dirname, '../worker/dhcpWorker.js')
                : path.join(process.resourcesPath, 'app', 'electron/worker/dhcpWorker.js');

            const workerFactory = new WorkerWithPromise(workerPath);
            this.worker = workerFactory.createLongRunningWorker();

            this.eventDispatcher = new EventDispatcher();
            this.eventDispatcher.setWebContents(webContents);

            this.dhcpEvtHandler = data => {
                this.eventDispatcher.emit('dhcp:event', successResponse({ ...data, version: 4 }));
            };

            this.worker.addEventListener(DhcpConst.DHCP_EVT_TYPES.DHCP_EVT, this.dhcpEvtHandler);

            const result = await this.worker.sendRequest(DhcpConst.DHCP_REQ_TYPES.START_DHCP, config);

            if (result.status !== 'success') {
                throw new Error(result.msg);
            }
            logger.info(`DHCPv4启动成功: ${result.msg}`);

            // 启动 DHCPv6（可选，失败不影响 DHCPv4）
            if (config.v6) {
                const v6Config = {
                    ...config.v6
                };
                if (this.logLevel) {
                    v6Config.logLevel = this.logLevel;
                }
                await this._startDhcp6(webContents, v6Config);
            }

            return successResponse(null, result.msg);
        } catch (error) {
            if (this.worker) {
                this.worker.removeEventListener(DhcpConst.DHCP_EVT_TYPES.DHCP_EVT, this.dhcpEvtHandler);
                await this.worker.terminate();
                this.worker = null;
            }
            if (this.eventDispatcher) {
                this.eventDispatcher.cleanup();
                this.eventDispatcher = null;
            }
            logger.error('启动DHCP出错:', error.message);
            return errorResponse(error.message);
        }
    }

    async _startDhcp6(webContents, v6Config) {
        try {
            const worker6Path = this.isDev
                ? path.join(__dirname, '../worker/dhcp6Worker.js')
                : path.join(process.resourcesPath, 'app', 'electron/worker/dhcp6Worker.js');

            const worker6Factory = new WorkerWithPromise(worker6Path);
            this.worker6 = worker6Factory.createLongRunningWorker();

            this.dhcp6EvtHandler = data => {
                if (this.eventDispatcher) {
                    this.eventDispatcher.emit('dhcp:event', successResponse({ ...data, version: 6 }));
                }
            };

            this.worker6.addEventListener(Dhcp6Const.DHCP6_EVT_TYPES.DHCP6_EVT, this.dhcp6EvtHandler);

            const result6 = await this.worker6.sendRequest(Dhcp6Const.DHCP6_REQ_TYPES.START_DHCP6, v6Config);
            if (result6.status === 'success') {
                logger.info(`DHCPv6启动成功: ${result6.msg}`);
            } else {
                throw new Error(result6.msg);
            }
        } catch (error) {
            logger.error('启动DHCPv6出错（不影响DHCPv4）:', error.message);
            if (this.worker6) {
                this.worker6.removeEventListener(Dhcp6Const.DHCP6_EVT_TYPES.DHCP6_EVT, this.dhcp6EvtHandler);
                await this.worker6.terminate();
                this.worker6 = null;
            }
        }
    }

    async handleStopDhcp() {
        try {
            if (null === this.worker) {
                logger.error('DHCP服务器未启动');
                return errorResponse('DHCP服务器未启动');
            }

            const result = await this.worker.sendRequest(DhcpConst.DHCP_REQ_TYPES.STOP_DHCP, null);
            logger.info(`DHCP停止成功: ${result.msg}`);
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('停止DHCP出错:', error.message);
            return errorResponse(error.message);
        } finally {
            if (this.worker) {
                this.worker.removeEventListener(DhcpConst.DHCP_EVT_TYPES.DHCP_EVT, this.dhcpEvtHandler);
                await this.worker.terminate();
                this.worker = null;
            }
            if (this.worker6) {
                try {
                    await this.worker6.sendRequest(Dhcp6Const.DHCP6_REQ_TYPES.STOP_DHCP6, null);
                } catch (_) {
                    /* ignore */
                }
                this.worker6.removeEventListener(Dhcp6Const.DHCP6_EVT_TYPES.DHCP6_EVT, this.dhcp6EvtHandler);
                await this.worker6.terminate();
                this.worker6 = null;
            }
            if (this.eventDispatcher) {
                this.eventDispatcher.cleanup();
                this.eventDispatcher = null;
            }
        }
    }

    async handleGetLeaseList() {
        if (null === this.worker) {
            return successResponse([], 'DHCP服务器未启动');
        }
        try {
            const v4Result = await this.worker.sendRequest(DhcpConst.DHCP_REQ_TYPES.GET_LEASE_LIST, null);
            const v4Leases = (v4Result.data || []).map(l => ({ ...l, version: 4, id: l.macAddr }));

            let v6Leases = [];
            if (this.worker6) {
                try {
                    const v6Result = await this.worker6.sendRequest(Dhcp6Const.DHCP6_REQ_TYPES.GET_LEASE_LIST, null);
                    v6Leases = (v6Result.data || []).map(l => ({ ...l, version: 6, id: l.duid }));
                } catch (_) {
                    /* ignore */
                }
            }

            return successResponse([...v4Leases, ...v6Leases], '获取租约列表成功');
        } catch (error) {
            logger.error('获取租约列表出错:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleReleaseLease(event, macAddr) {
        if (null === this.worker) {
            return errorResponse('DHCP服务器未启动');
        }
        try {
            const result = await this.worker.sendRequest(DhcpConst.DHCP_REQ_TYPES.RELEASE_LEASE, macAddr);
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('释放租约出错:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleReleaseDhcp6Lease(event, duid) {
        if (null === this.worker6) {
            return errorResponse('DHCPv6服务器未启动');
        }
        try {
            const result = await this.worker6.sendRequest(Dhcp6Const.DHCP6_REQ_TYPES.RELEASE_LEASE, duid);
            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('释放DHCPv6租约出错:', error.message);
            return errorResponse(error.message);
        }
    }

    getDhcpRunning() {
        return null !== this.worker;
    }
}

module.exports = DhcpApp;
