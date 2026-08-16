const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const ProtocolProcessWithPromise = require('../worker/core/protocolProcessWithPromise');
const { PROTOCOL_PROCESS_SERVICES, PROTOCOL_PROCESS_TIMEOUTS } = require('../worker/core/protocolProcessServices');
const DhcpConst = require('../const/dhcpConst');
const Dhcp6Const = require('../const/dhcp6Const');
const EventDispatcher = require('../utils/eventDispatcher');

class DhcpApp {
    constructor(ipcMain, store) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.dhcpConfigFileKey = 'dhcp-config';
        this.worker = null;
        this.dhcp6Running = false;
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

            const workerPath = resolveWorkerPath('dhcp/dhcpProcess.js');

            const processFactory = new ProtocolProcessWithPromise(workerPath, {
                serviceName: PROTOCOL_PROCESS_SERVICES.DHCP,
                onExit: (_code, client, exit = {}) => {
                    if (this.worker !== client) return;
                    if (exit.expected) return;
                    this.worker = null;
                    this.dhcp6Running = false;
                    this.eventDispatcher?.cleanup();
                    this.eventDispatcher = null;
                }
            });
            this.worker = processFactory.createLongRunningProcess();

            this.eventDispatcher = new EventDispatcher();
            this.eventDispatcher.setWebContents(webContents);

            this.dhcpEvtHandler = data => {
                this.eventDispatcher?.emit('dhcp:event', successResponse({ ...data, version: 4 }));
            };
            this.dhcp6EvtHandler = data => {
                this.eventDispatcher?.emit('dhcp:event', successResponse({ ...data, version: 6 }));
            };

            this.worker.addEventListener(DhcpConst.DHCP_EVT_TYPES.DHCP_EVT, this.dhcpEvtHandler);
            this.worker.addEventListener(Dhcp6Const.DHCP6_EVT_TYPES.DHCP6_EVT, this.dhcp6EvtHandler);

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
                await this._startDhcp6(v6Config);
            }

            return successResponse(null, result.msg);
        } catch (error) {
            if (this.worker) {
                this.worker.removeEventListener(DhcpConst.DHCP_EVT_TYPES.DHCP_EVT, this.dhcpEvtHandler);
                this.worker.removeEventListener(Dhcp6Const.DHCP6_EVT_TYPES.DHCP6_EVT, this.dhcp6EvtHandler);
                await this.worker.terminate().catch(terminateError => {
                    logger.warn(`终止DHCP进程失败: ${terminateError.message}`);
                });
                this.worker = null;
            }
            this.dhcp6Running = false;
            if (this.eventDispatcher) {
                this.eventDispatcher.cleanup();
                this.eventDispatcher = null;
            }
            logger.error('启动DHCP出错:', error.message);
            return errorResponse(error.message);
        }
    }

    async _startDhcp6(v6Config) {
        const worker = this.worker;
        if (!worker) {
            throw new Error('DHCP服务器未启动');
        }
        if (this.dhcp6Running) {
            throw new Error('DHCPv6服务器已经启动');
        }

        try {
            const result6 = await worker.sendRequest(Dhcp6Const.DHCP6_REQ_TYPES.START_DHCP6, v6Config);
            if (result6.status === 'success') {
                this.dhcp6Running = true;
                logger.info(`DHCPv6启动成功: ${result6.msg}`);
            } else {
                throw new Error(result6.msg);
            }
        } catch (error) {
            this.dhcp6Running = false;
            if (this.worker !== worker || error.code === 'WORKER_EXIT' || error.code === 'WORKER_TERMINATED') {
                throw error;
            }
            logger.error('启动DHCPv6出错（不影响DHCPv4）:', error.message);
        }
    }

    async handleStopDhcp() {
        const worker = this.worker;
        const dhcp6Running = this.dhcp6Running;
        const eventDispatcher = this.eventDispatcher;
        if (!worker) {
            logger.error('DHCP服务器未启动');
            return errorResponse('DHCP服务器未启动');
        }

        try {
            let result = null;
            let stopError = null;
            try {
                result = await worker.sendRequest(DhcpConst.DHCP_REQ_TYPES.STOP_DHCP, null, {
                    timeoutMs: PROTOCOL_PROCESS_TIMEOUTS.STOP
                });
                logger.info(`DHCPv4停止成功: ${result.msg}`);
            } catch (error) {
                stopError = error;
            }
            if (dhcp6Running) {
                try {
                    const result6 = await worker.sendRequest(Dhcp6Const.DHCP6_REQ_TYPES.STOP_DHCP6, null, {
                        timeoutMs: PROTOCOL_PROCESS_TIMEOUTS.STOP
                    });
                    logger.info(`DHCPv6停止成功: ${result6.msg}`);
                    result ||= result6;
                } catch (error) {
                    stopError ||= error;
                }
            }
            if (stopError) throw stopError;
            return successResponse(null, result?.msg || 'DHCP服务器已停止');
        } catch (error) {
            logger.error('停止DHCP出错:', error.message);
            return errorResponse(error.message);
        } finally {
            worker.removeEventListener(DhcpConst.DHCP_EVT_TYPES.DHCP_EVT, this.dhcpEvtHandler);
            worker.removeEventListener(Dhcp6Const.DHCP6_EVT_TYPES.DHCP6_EVT, this.dhcp6EvtHandler);
            await worker.terminate().catch(error => logger.warn(`终止DHCP进程失败: ${error.message}`));
            if (this.worker === worker) this.worker = null;
            this.dhcp6Running = false;
            if (this.eventDispatcher === eventDispatcher) {
                eventDispatcher?.cleanup();
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
            if (this.dhcp6Running) {
                try {
                    const v6Result = await this.worker.sendRequest(Dhcp6Const.DHCP6_REQ_TYPES.GET_LEASE_LIST, null);
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
        if (null === this.worker || !this.dhcp6Running) {
            return errorResponse('DHCPv6服务器未启动');
        }
        try {
            const result = await this.worker.sendRequest(Dhcp6Const.DHCP6_REQ_TYPES.RELEASE_LEASE, duid);
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
