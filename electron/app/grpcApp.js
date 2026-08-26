const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const ProtocolProcessWithPromise = require('../worker/core/protocolProcessWithPromise');
const { PROTOCOL_PROCESS_SERVICES, PROTOCOL_PROCESS_TIMEOUTS } = require('../worker/core/protocolProcessServices');
const GrpcConst = require('../const/grpcConst');
const EventDispatcher = require('../utils/eventDispatcher');

const DEFAULT_STATS_EMIT_INTERVAL_MS = 1000;
const GRPC_EVENT_CHANNEL = 'grpc:event';
const GRPC_RUNTIME_CHANGED_EVENT = 'grpc:runtimeChanged';

/**
 * gRPC 工具主进程侧：
 * - 管理 gRPC 协议进程（proto 编译、通用服务器、通用客户端）生命周期
 * - 持久化 proto 文件列表、服务器配置、客户端配置
 * - 把协议进程事件转发到配置页与独立监控窗口
 */
class GrpcApp {
    constructor(ipcMain, store, options = {}) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.protoConfigKey = 'grpc-proto-config';
        this.serverConfigKey = 'grpc-server-config';
        this.clientConfigKey = 'grpc-client-config';
        this.worker = null;
        this.workerStarting = null;
        this.logLevel = null;
        this.eventDispatcher = null;
        this.grpcEventHandler = null;
        this.serverRunning = false;
        this.lastServerStatus = null;
        this.pendingStats = null;
        this.statsEmitTimer = null;
        this.statsEmitIntervalMs = Number.isFinite(Number(options.statsEmitIntervalMs))
            ? Math.max(0, Number(options.statsEmitIntervalMs))
            : DEFAULT_STATS_EMIT_INTERVAL_MS;
        this.closeMonitorWindowsHandler =
            typeof options.closeMonitorWindows === 'function' ? options.closeMonitorWindows : null;

        this.registerIpcHandlers();
    }

    registerIpcHandlers() {
        const handle = (channel, handler) => this.ipcMain.handle(channel, handler.bind(this));
        handle('grpc:startRuntime', this.handleStartRuntime);
        handle('grpc:stopRuntime', this.handleStopRuntime);
        handle('grpc:getRuntimeState', this.handleGetRuntimeState);
        handle('grpc:getProtoConfig', this.handleGetProtoConfig);
        handle('grpc:selectProtoFiles', this.handleSelectProtoFiles);
        handle('grpc:selectProtoDirectory', this.handleSelectProtoDirectory);
        handle('grpc:compileProtos', this.handleCompileProtos);
        handle('grpc:getProtoCatalog', this.handleGetProtoCatalog);
        handle('grpc:clearProtos', this.handleClearProtos);
        handle('grpc:getProtoTreeChildren', this.handleGetProtoTreeChildren);
        handle('grpc:getProtoNode', this.handleGetProtoNode);
        handle('grpc:saveProtoProject', this.handleSaveProtoProject);
        handle('grpc:listProtoProjects', this.handleListProtoProjects);
        handle('grpc:importProtoProject', this.handleImportProtoProject);
        handle('grpc:exportProtoProject', this.handleExportProtoProject);
        handle('grpc:removeProtoProject', this.handleRemoveProtoProject);
        handle('grpc:selectDirectory', this.handleSelectDirectory);
        handle('grpc:getMessageTemplate', this.handleGetMessageTemplate);
        handle('grpc:saveServerConfig', this.handleSaveServerConfig);
        handle('grpc:getServerConfig', this.handleGetServerConfig);
        handle('grpc:startServer', this.handleStartServer);
        handle('grpc:stopServer', this.handleStopServer);
        handle('grpc:getServerStatus', this.handleGetServerStatus);
        handle('grpc:getMessageList', this.handleGetMessageList);
        handle('grpc:getMessageDetail', this.handleGetMessageDetail);
        handle('grpc:clearMessageHistory', this.handleClearMessageHistory);
        handle('grpc:getStreamList', this.handleGetStreamList);
        handle('grpc:sendStreamMessage', this.handleSendStreamMessage);
        handle('grpc:closeStream', this.handleCloseStream);
        handle('grpc:saveClientConfig', this.handleSaveClientConfig);
        handle('grpc:getClientConfig', this.handleGetClientConfig);
        handle('grpc:clientStartCall', this.handleClientStartCall);
        handle('grpc:clientSendMessage', this.handleClientSendMessage);
        handle('grpc:clientEndCall', this.handleClientEndCall);
        handle('grpc:clientCancelCall', this.handleClientCancelCall);
        handle('grpc:getClientCallList', this.handleGetClientCallList);
    }

    // ------------------------------------------------------------------
    // 协议进程管理
    // ------------------------------------------------------------------

    hasWorker() {
        return this.worker !== null;
    }

    getGrpcRunning() {
        return this.serverRunning;
    }

    setLogLevel(logLevel) {
        this.logLevel = logLevel;
    }

    getProtoCacheFilePath() {
        return path.join(app.getPath('userData'), 'grpc-proto-cache.json');
    }

    getProtoProjectRootDir() {
        return path.join(app.getPath('userData'), 'grpc-proto-projects');
    }

    getStoredProtoConfig() {
        const stored = this.store.get(this.protoConfigKey) || {};
        return {
            filePaths: Array.isArray(stored.filePaths) ? stored.filePaths.filter(Boolean) : [],
            includeDirs: Array.isArray(stored.includeDirs) ? stored.includeDirs.filter(Boolean) : []
        };
    }

    async ensureWorker(event = null) {
        if (event && event.sender) {
            this.attachWebContents(event.sender);
        }
        if (this.worker) {
            return this.worker;
        }
        if (this.workerStarting) {
            return this.workerStarting;
        }

        this.workerStarting = (async () => {
            const workerPath = resolveWorkerPath('grpc/grpcWorker.js');
            const processFactory = new ProtocolProcessWithPromise(workerPath, {
                serviceName: PROTOCOL_PROCESS_SERVICES.GRPC,
                onExit: (_code, client, exit = {}) => {
                    if (this.worker !== client) return;
                    if (exit.expected) return;
                    logger.error('gRPC 协议进程意外退出');
                    this.worker = null;
                    this.serverRunning = false;
                    this.lastServerStatus = null;
                    this.cancelPendingStatsUpdate();
                    this.closeMonitorWindows();
                    this.emitRuntimeChanged();
                    if (this.eventDispatcher) {
                        this.eventDispatcher.emit(
                            GRPC_EVENT_CHANNEL,
                            successResponse({
                                type: GrpcConst.GRPC_SUB_EVT_TYPES.SERVER_STATUS,
                                data: { status: 'stopped', reason: 'worker-exit' }
                            })
                        );
                    }
                }
            });
            const worker = processFactory.createLongRunningProcess();
            this.grpcEventHandler = data => this.handleWorkerEvent(data);
            worker.addEventListener(GrpcConst.GRPC_EVT_TYPES.GRPC_EVT, this.grpcEventHandler);
            this.worker = worker;

            const protoConfig = this.getStoredProtoConfig();
            if (protoConfig.filePaths.length > 0) {
                try {
                    await worker.sendRequest(GrpcConst.GRPC_REQ_TYPES.COMPILE_PROTOS, {
                        ...protoConfig,
                        cacheFilePath: this.getProtoCacheFilePath(),
                        logLevel: this.logLevel || undefined
                    });
                } catch (error) {
                    logger.warn(`启动时重新编译 proto 失败: ${error.message}`);
                }
            }
            return worker;
        })();

        try {
            return await this.workerStarting;
        } finally {
            this.workerStarting = null;
        }
    }

    attachWebContents(webContents) {
        if (!webContents) {
            return;
        }
        if (!this.eventDispatcher) {
            this.eventDispatcher = new EventDispatcher();
        }
        // 独立监控窗口通过订阅接收事件，主目标始终保持为主窗口。
        const currentTarget = this.eventDispatcher.webContents;
        if (!currentTarget || (typeof currentTarget.isDestroyed === 'function' && currentTarget.isDestroyed())) {
            this.eventDispatcher.setWebContents(webContents);
        }
    }

    /**
     * 与 SNMP 一致：协议进程由用户在页面显式启动，未启动时所有请求直接报错，不再按需拉起。
     */
    async request(op, data = null, options = undefined, event = null) {
        if (event && event.sender) {
            this.attachWebContents(event.sender);
        }
        if (!this.worker) {
            throw new Error('gRPC 进程未启动，请先在 Proto编译 页启动进程');
        }
        return this.worker.sendRequest(op, data, options);
    }

    getRuntimeStateSnapshot() {
        return {
            running: this.hasWorker(),
            starting: Boolean(this.workerStarting),
            serverRunning: this.serverRunning
        };
    }

    emitRuntimeChanged() {
        const state = this.getRuntimeStateSnapshot();
        const signature = JSON.stringify(state);
        if (signature === this.runtimeStateSignature) {
            return false;
        }
        this.runtimeStateSignature = signature;
        this.eventDispatcher?.emit(GRPC_RUNTIME_CHANGED_EVENT, state);
        return true;
    }

    async handleStartRuntime(event) {
        try {
            if (this.worker) {
                return successResponse(this.getRuntimeStateSnapshot(), 'gRPC 进程已在运行');
            }
            await this.ensureWorker(event);
            this.emitRuntimeChanged();
            return successResponse(this.getRuntimeStateSnapshot(), 'gRPC 进程启动成功');
        } catch (error) {
            logger.error('启动 gRPC 进程失败:', error);
            await this.cleanupWorker();
            this.emitRuntimeChanged();
            return errorResponse('启动 gRPC 进程失败: ' + error.message);
        }
    }

    async handleStopRuntime() {
        if (!this.worker && !this.workerStarting) {
            return errorResponse('gRPC 进程未启动');
        }
        if (this.workerStarting) {
            await this.workerStarting.catch(() => null);
        }
        const result = await this.handleShutdown();
        this.emitRuntimeChanged();
        return result.status === 'success'
            ? successResponse(this.getRuntimeStateSnapshot(), 'gRPC 进程已停止')
            : result;
    }

    async handleGetRuntimeState(event) {
        if (event && event.sender) {
            this.attachWebContents(event.sender);
        }
        return successResponse(this.getRuntimeStateSnapshot(), '获取 gRPC 进程状态成功');
    }

    async cleanupWorker() {
        this.cancelPendingStatsUpdate();
        if (this.worker && this.grpcEventHandler) {
            this.worker.removeEventListener(GrpcConst.GRPC_EVT_TYPES.GRPC_EVT, this.grpcEventHandler);
        }
        if (this.worker) {
            const worker = this.worker;
            this.worker = null;
            await worker.terminate();
        }
        this.grpcEventHandler = null;
        this.serverRunning = false;
        this.lastServerStatus = null;
    }

    /**
     * 应用退出时调用：停止服务器并结束协议进程。
     */
    async handleShutdown() {
        this.closeMonitorWindows();
        if (!this.worker) {
            return successResponse(null, 'gRPC 协议进程未启动');
        }
        try {
            if (this.serverRunning) {
                await this.worker.sendRequest(GrpcConst.GRPC_REQ_TYPES.STOP_SERVER, null, {
                    timeoutMs: PROTOCOL_PROCESS_TIMEOUTS.STOP
                });
            }
        } catch (error) {
            logger.warn(`退出时停止 gRPC 服务器失败: ${error.message}`);
        } finally {
            await this.cleanupWorker();
        }
        return successResponse(null, 'gRPC 已停止');
    }

    closeMonitorWindows() {
        if (!this.closeMonitorWindowsHandler) {
            return;
        }
        try {
            this.closeMonitorWindowsHandler();
        } catch (error) {
            logger.warn(`关闭 gRPC 独立监控窗口失败: ${error.message}`);
        }
    }

    // ------------------------------------------------------------------
    // 事件转发
    // ------------------------------------------------------------------

    handleWorkerEvent(data) {
        if (!data) {
            return;
        }
        if (data.type === GrpcConst.GRPC_SUB_EVT_TYPES.SERVER_STATUS && data.data) {
            this.serverRunning = data.data.status === 'running';
            this.lastServerStatus = data.data;
            if (!this.serverRunning) {
                this.closeMonitorWindows();
            }
        }
        if (!this.eventDispatcher) {
            return;
        }

        if (data.type === GrpcConst.GRPC_SUB_EVT_TYPES.MESSAGE_RECEIVED) {
            // 消息明细只投递给独立监控窗口；配置页只需要节流后的统计。
            this.eventDispatcher.emitToSubscribers(GRPC_EVENT_CHANNEL, successResponse(data));
            this.queueStatsUpdate(data.stats);
            return;
        }

        this.cancelPendingStatsUpdate();
        this.eventDispatcher.emit(GRPC_EVENT_CHANNEL, successResponse(data));
    }

    queueStatsUpdate(stats) {
        if (!stats) {
            return;
        }
        this.pendingStats = stats;
        if (this.statsEmitTimer) {
            return;
        }
        this.statsEmitTimer = setTimeout(() => {
            this.statsEmitTimer = null;
            const pendingStats = this.pendingStats;
            this.pendingStats = null;
            if (!pendingStats || !this.eventDispatcher) {
                return;
            }
            this.eventDispatcher.emitToPrimary(
                GRPC_EVENT_CHANNEL,
                successResponse({
                    type: GrpcConst.GRPC_SUB_EVT_TYPES.STATS_UPDATED,
                    data: null,
                    stats: pendingStats
                })
            );
        }, this.statsEmitIntervalMs);
    }

    cancelPendingStatsUpdate() {
        if (this.statsEmitTimer) {
            clearTimeout(this.statsEmitTimer);
            this.statsEmitTimer = null;
        }
        this.pendingStats = null;
    }

    // ------------------------------------------------------------------
    // proto 编译
    // ------------------------------------------------------------------

    async handleGetProtoConfig(event) {
        try {
            if (!this.worker) {
                if (event && event.sender) {
                    this.attachWebContents(event.sender);
                }
                return successResponse(
                    { ...this.getStoredProtoConfig(), compiled: false, runtimeRunning: false },
                    'gRPC 进程未启动'
                );
            }
            const result = await this.request(GrpcConst.GRPC_REQ_TYPES.GET_PROTO_CATALOG, null, undefined, event);
            return successResponse(
                {
                    ...this.getStoredProtoConfig(),
                    ...(result.data || {})
                },
                'proto 配置获取成功'
            );
        } catch (error) {
            logger.error('获取 proto 配置失败:', error);
            return errorResponse('获取 proto 配置失败: ' + error.message);
        }
    }

    async showOpenDialog(event, options) {
        const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
        return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
    }

    async handleSelectProtoFiles(event) {
        try {
            const result = await this.showOpenDialog(event, {
                title: '导入 .proto 文件',
                properties: ['openFile', 'multiSelections'],
                filters: [
                    { name: 'Protocol Buffers', extensions: ['proto'] },
                    { name: '所有文件', extensions: ['*'] }
                ]
            });
            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return successResponse([], '已取消选择');
            }
            return successResponse(result.filePaths, 'proto 文件选择成功');
        } catch (error) {
            logger.error('选择 proto 文件失败:', error);
            return errorResponse('选择 proto 文件失败: ' + error.message);
        }
    }

    async handleSelectProtoDirectory(event) {
        try {
            const result = await this.showOpenDialog(event, {
                title: '选择 proto import 搜索目录',
                properties: ['openDirectory']
            });
            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return successResponse(null, '已取消选择');
            }
            return successResponse(result.filePaths[0], '目录选择成功');
        } catch (error) {
            logger.error('选择 proto 目录失败:', error);
            return errorResponse('选择 proto 目录失败: ' + error.message);
        }
    }

    normalizePathList(value) {
        return Array.from(
            new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean))
        );
    }

    async handleCompileProtos(event, payload = {}) {
        try {
            const filePaths = this.normalizePathList(payload?.filePaths);
            const includeDirs = this.normalizePathList(payload?.includeDirs);
            const result = await this.request(
                GrpcConst.GRPC_REQ_TYPES.COMPILE_PROTOS,
                {
                    filePaths,
                    includeDirs,
                    cacheFilePath: this.getProtoCacheFilePath(),
                    force: Boolean(payload?.force),
                    logLevel: this.logLevel || undefined
                },
                undefined,
                event
            );
            this.store.set(this.protoConfigKey, { filePaths, includeDirs });
            return successResponse({ filePaths, includeDirs, ...(result.data || {}) }, result.msg || 'proto 编译成功');
        } catch (error) {
            logger.error('proto 编译失败:', error);
            return errorResponse(error.message, error.data || null);
        }
    }

    async handleGetProtoCatalog(event) {
        try {
            const result = await this.request(GrpcConst.GRPC_REQ_TYPES.GET_PROTO_CATALOG, null, undefined, event);
            return successResponse(result.data, result.msg || '获取 proto 目录成功');
        } catch (error) {
            logger.error('获取 proto 目录失败:', error);
            return errorResponse('获取 proto 目录失败: ' + error.message);
        }
    }

    async handleClearProtos(event) {
        try {
            if (this.serverRunning) {
                return errorResponse('请先停止 gRPC 服务器再清空 proto');
            }
            const result = this.worker
                ? await this.request(
                      GrpcConst.GRPC_REQ_TYPES.CLEAR_PROTOS,
                      { cacheFilePath: this.getProtoCacheFilePath() },
                      undefined,
                      event
                  )
                : { data: { compiled: false }, msg: 'proto 配置已清空' };
            this.store.set(this.protoConfigKey, { filePaths: [], includeDirs: [] });
            return successResponse({ filePaths: [], includeDirs: [], ...(result.data || {}) }, result.msg);
        } catch (error) {
            logger.error('清空 proto 配置失败:', error);
            return errorResponse('清空 proto 配置失败: ' + error.message);
        }
    }

    async handleGetProtoTreeChildren(event, parentKey = '') {
        try {
            const result = await this.request(
                GrpcConst.GRPC_REQ_TYPES.GET_PROTO_TREE_CHILDREN,
                { parentKey: typeof parentKey === 'string' ? parentKey : parentKey?.parentKey || '' },
                undefined,
                event
            );
            return successResponse(result.data, result.msg || '获取 proto 树节点成功');
        } catch (error) {
            return errorResponse('获取 proto 树节点失败: ' + error.message);
        }
    }

    async handleGetProtoNode(event, key = '') {
        try {
            const result = await this.request(
                GrpcConst.GRPC_REQ_TYPES.GET_PROTO_NODE,
                { key: typeof key === 'string' ? key : key?.key || key?.fullName || '' },
                undefined,
                event
            );
            return successResponse(result.data, result.msg || '获取节点详情成功');
        } catch (error) {
            return errorResponse('获取节点详情失败: ' + error.message);
        }
    }

    async handleSaveProtoProject(event, payload = {}) {
        try {
            const result = await this.request(
                GrpcConst.GRPC_REQ_TYPES.SAVE_PROTO_PROJECT,
                {
                    name: payload?.name,
                    projectRootDir: this.getProtoProjectRootDir(),
                    cacheFilePath: this.getProtoCacheFilePath()
                },
                undefined,
                event
            );
            return successResponse(result.data, result.msg || 'proto 工程保存成功');
        } catch (error) {
            logger.error('保存 proto 工程失败:', error);
            return errorResponse(error.message);
        }
    }

    async handleListProtoProjects(event) {
        try {
            const result = await this.request(
                GrpcConst.GRPC_REQ_TYPES.LIST_PROTO_PROJECTS,
                { projectRootDir: this.getProtoProjectRootDir() },
                undefined,
                event
            );
            return successResponse(result.data, result.msg || 'proto 工程列表获取成功');
        } catch (error) {
            return errorResponse(error.message);
        }
    }

    async handleImportProtoProject(event, payload = {}) {
        try {
            if (this.serverRunning) {
                return errorResponse('请先停止 gRPC 服务器再导入工程');
            }
            const result = await this.request(
                GrpcConst.GRPC_REQ_TYPES.IMPORT_PROTO_PROJECT,
                {
                    name: payload?.name,
                    directory: payload?.directory,
                    projectRootDir: this.getProtoProjectRootDir(),
                    cacheFilePath: this.getProtoCacheFilePath()
                },
                undefined,
                event
            );
            this.store.set(this.protoConfigKey, {
                filePaths: this.normalizePathList(result.data?.filePaths),
                includeDirs: this.normalizePathList(result.data?.includeDirs)
            });
            return successResponse(result.data, result.msg || 'proto 工程导入成功');
        } catch (error) {
            logger.error('导入 proto 工程失败:', error);
            return errorResponse(error.message);
        }
    }

    async handleExportProtoProject(event, payload = {}) {
        try {
            const result = await this.request(
                GrpcConst.GRPC_REQ_TYPES.EXPORT_PROTO_PROJECT,
                { name: payload?.name, targetDir: payload?.targetDir, projectRootDir: this.getProtoProjectRootDir() },
                undefined,
                event
            );
            return successResponse(result.data, result.msg || 'proto 工程导出成功');
        } catch (error) {
            return errorResponse(error.message);
        }
    }

    async handleRemoveProtoProject(event, payload = {}) {
        try {
            const result = await this.request(
                GrpcConst.GRPC_REQ_TYPES.REMOVE_PROTO_PROJECT,
                { name: payload?.name, projectRootDir: this.getProtoProjectRootDir() },
                undefined,
                event
            );
            return successResponse(result.data, result.msg || 'proto 工程已删除');
        } catch (error) {
            return errorResponse(error.message);
        }
    }

    async handleSelectDirectory(event, payload = {}) {
        try {
            const result = await this.showOpenDialog(event, {
                title: payload?.title || '选择目录',
                properties: ['openDirectory', 'createDirectory']
            });
            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return successResponse(null, '已取消选择');
            }
            return successResponse(result.filePaths[0], '目录选择成功');
        } catch (error) {
            return errorResponse('选择目录失败: ' + error.message);
        }
    }

    async handleGetMessageTemplate(event, payload = {}) {
        try {
            const result = await this.request(
                GrpcConst.GRPC_REQ_TYPES.GET_MESSAGE_TEMPLATE,
                { typeName: typeof payload === 'string' ? payload : payload?.typeName },
                undefined,
                event
            );
            return successResponse(result.data, result.msg || '生成消息模板成功');
        } catch (error) {
            return errorResponse('生成消息模板失败: ' + error.message);
        }
    }

    // ------------------------------------------------------------------
    // 服务器
    // ------------------------------------------------------------------

    async handleSaveServerConfig(_event, config) {
        try {
            this.store.set(this.serverConfigKey, config || {});
            return successResponse(null, '配置保存成功');
        } catch (error) {
            logger.error('保存 gRPC 服务器配置失败:', error);
            return errorResponse('配置保存失败: ' + error.message);
        }
    }

    async handleGetServerConfig() {
        try {
            const config = this.store.get(this.serverConfigKey);
            if (!config) {
                return successResponse(null, '获取默认配置');
            }
            return successResponse(config, '配置获取成功');
        } catch (error) {
            logger.error('获取 gRPC 服务器配置失败:', error);
            return errorResponse('配置获取失败: ' + error.message);
        }
    }

    async handleStartServer(event, config) {
        try {
            if (this.serverRunning) {
                return errorResponse('gRPC服务器已经启动');
            }
            const workerConfig = { ...(config || {}) };
            if (this.logLevel) {
                workerConfig.logLevel = this.logLevel;
            }
            logger.info(`启动 gRPC 服务器: ${JSON.stringify({ ...workerConfig, unaryReplyTemplates: '[...]' })}`);
            const result = await this.request(GrpcConst.GRPC_REQ_TYPES.START_SERVER, workerConfig, undefined, event);
            this.serverRunning = true;
            this.lastServerStatus = result.data || null;
            return successResponse(result.data, result.msg || 'gRPC服务器启动成功');
        } catch (error) {
            logger.error('启动 gRPC 服务器失败:', error);
            return errorResponse(error.message);
        }
    }

    async handleStopServer() {
        this.closeMonitorWindows();
        try {
            if (!this.worker || !this.serverRunning) {
                return errorResponse('gRPC服务器未启动');
            }
            const result = await this.worker.sendRequest(GrpcConst.GRPC_REQ_TYPES.STOP_SERVER, null, {
                timeoutMs: PROTOCOL_PROCESS_TIMEOUTS.STOP
            });
            this.serverRunning = false;
            return successResponse(null, result.msg || 'gRPC服务器已停止');
        } catch (error) {
            logger.error('停止 gRPC 服务器失败:', error);
            this.serverRunning = false;
            return errorResponse('停止gRPC服务器失败: ' + error.message);
        }
    }

    async handleGetServerStatus() {
        return successResponse(
            {
                running: this.serverRunning,
                workerAlive: this.hasWorker(),
                status: this.lastServerStatus
            },
            '获取 gRPC 服务器状态成功'
        );
    }

    async handleGetMessageList(_event, query = {}) {
        try {
            if (!this.worker) {
                return successResponse(
                    { list: [], total: 0, page: Number(query.page || 1), pageSize: Number(query.pageSize || 20) },
                    'gRPC 协议进程未启动'
                );
            }
            const result = await this.worker.sendRequest(GrpcConst.GRPC_REQ_TYPES.GET_MESSAGE_LIST, query);
            return successResponse(result.data, result.msg || '获取gRPC消息列表成功');
        } catch (error) {
            logger.error('获取 gRPC 消息列表失败:', error);
            return errorResponse('获取gRPC消息列表失败: ' + error.message);
        }
    }

    async handleGetMessageDetail(_event, id) {
        try {
            if (!this.worker) {
                return errorResponse('gRPC 协议进程未启动');
            }
            const result = await this.worker.sendRequest(GrpcConst.GRPC_REQ_TYPES.GET_MESSAGE_DETAIL, id);
            return successResponse(result.data, result.msg || '获取gRPC消息详情成功');
        } catch (error) {
            logger.error('获取 gRPC 消息详情失败:', error);
            return errorResponse('获取gRPC消息详情失败: ' + error.message);
        }
    }

    async handleClearMessageHistory() {
        try {
            if (!this.worker) {
                return successResponse(null, 'gRPC 协议进程未启动');
            }
            const result = await this.worker.sendRequest(GrpcConst.GRPC_REQ_TYPES.CLEAR_MESSAGE_HISTORY, null);
            return successResponse(null, result.msg || 'gRPC消息记录已清空');
        } catch (error) {
            logger.error('清空 gRPC 消息记录失败:', error);
            return errorResponse('清空gRPC消息记录失败: ' + error.message);
        }
    }

    async handleGetStreamList() {
        try {
            if (!this.worker) {
                return successResponse({ list: [], total: 0 }, 'gRPC 协议进程未启动');
            }
            const result = await this.worker.sendRequest(GrpcConst.GRPC_REQ_TYPES.GET_STREAM_LIST, null);
            return successResponse(result.data, result.msg || '获取流列表成功');
        } catch (error) {
            return errorResponse('获取流列表失败: ' + error.message);
        }
    }

    async handleSendStreamMessage(_event, payload = {}) {
        try {
            if (!this.worker) {
                return errorResponse('gRPC 协议进程未启动');
            }
            const result = await this.worker.sendRequest(GrpcConst.GRPC_REQ_TYPES.SEND_STREAM_MESSAGE, payload);
            return successResponse(result.data, result.msg || '消息已下发');
        } catch (error) {
            return errorResponse(error.message);
        }
    }

    async handleCloseStream(_event, payload = {}) {
        try {
            if (!this.worker) {
                return errorResponse('gRPC 协议进程未启动');
            }
            const result = await this.worker.sendRequest(GrpcConst.GRPC_REQ_TYPES.CLOSE_STREAM, payload);
            return successResponse(result.data, result.msg || '流已关闭');
        } catch (error) {
            return errorResponse(error.message);
        }
    }

    // ------------------------------------------------------------------
    // 客户端
    // ------------------------------------------------------------------

    async handleSaveClientConfig(_event, config) {
        try {
            this.store.set(this.clientConfigKey, config || {});
            return successResponse(null, '配置保存成功');
        } catch (error) {
            logger.error('保存 gRPC 客户端配置失败:', error);
            return errorResponse('配置保存失败: ' + error.message);
        }
    }

    async handleGetClientConfig() {
        try {
            const config = this.store.get(this.clientConfigKey);
            if (!config) {
                return successResponse(null, '获取默认配置');
            }
            return successResponse(config, '配置获取成功');
        } catch (error) {
            return errorResponse('配置获取失败: ' + error.message);
        }
    }

    async handleClientStartCall(event, payload = {}) {
        try {
            const result = await this.request(GrpcConst.GRPC_REQ_TYPES.CLIENT_START_CALL, payload, undefined, event);
            return successResponse(result.data, result.msg || '调用已发起');
        } catch (error) {
            logger.error('gRPC 客户端调用失败:', error);
            return errorResponse(error.message);
        }
    }

    async handleClientSendMessage(_event, payload = {}) {
        try {
            if (!this.worker) {
                return errorResponse('gRPC 协议进程未启动');
            }
            const result = await this.worker.sendRequest(GrpcConst.GRPC_REQ_TYPES.CLIENT_SEND_MESSAGE, payload);
            return successResponse(result.data, result.msg || '消息已发送');
        } catch (error) {
            return errorResponse(error.message);
        }
    }

    async handleClientEndCall(_event, payload = {}) {
        try {
            if (!this.worker) {
                return errorResponse('gRPC 协议进程未启动');
            }
            const result = await this.worker.sendRequest(GrpcConst.GRPC_REQ_TYPES.CLIENT_END_CALL, payload);
            return successResponse(result.data, result.msg || '已结束发送');
        } catch (error) {
            return errorResponse(error.message);
        }
    }

    async handleClientCancelCall(_event, payload = {}) {
        try {
            if (!this.worker) {
                return errorResponse('gRPC 协议进程未启动');
            }
            const result = await this.worker.sendRequest(GrpcConst.GRPC_REQ_TYPES.CLIENT_CANCEL_CALL, payload);
            return successResponse(result.data, result.msg || '调用已取消');
        } catch (error) {
            return errorResponse(error.message);
        }
    }

    async handleGetClientCallList() {
        try {
            if (!this.worker) {
                return successResponse({ list: [], total: 0 }, 'gRPC 协议进程未启动');
            }
            const result = await this.worker.sendRequest(GrpcConst.GRPC_REQ_TYPES.GET_CLIENT_CALL_LIST, null);
            return successResponse(result.data, result.msg || '获取调用列表成功');
        } catch (error) {
            return errorResponse('获取调用列表失败: ' + error.message);
        }
    }
}

module.exports = GrpcApp;
