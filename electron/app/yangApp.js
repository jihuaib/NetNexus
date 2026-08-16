'use strict';

const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const EventDispatcher = require('../utils/eventDispatcher');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const { profileWorkspaceId } = require('../utils/yang/yangWorkspaceIdentity');
const { YANG_EVT_TYPES } = require('../const/yangConst');
const { LOG_REQ_TYPES } = require('../const/toolsConst');
const { YANG_PROCESS_REQ_TYPES, YANG_PROCESS_EVT_TYPES } = require('../worker/yang/yangProcessProtocol');

const STATE_STORE_KEY = 'yang-profile-workspace-states';
const PENDING_WORKSPACE_DELETIONS_KEY = 'yang-pending-workspace-deletions';
const DEFAULT_REQUEST_TIMEOUT = 120000;

function unavailableCompilerStatus() {
    return {
        available: false,
        required: true,
        checking: false,
        engine: 'libyang',
        source: 'stopped',
        error: 'YANG进程未启动',
        message: 'YANG进程未启动，请先连接NETCONF设备',
        installHint: '连接成功后将在YANG进程内检测libyang运行时'
    };
}

function emptyWorkspace(profileId = '') {
    return {
        profileId: String(profileId || ''),
        workspaceId: '',
        name: '',
        createdAt: null,
        updatedAt: null,
        contentHash: null,
        compileId: '',
        compiledAt: null,
        success: null,
        schemaAvailable: false,
        partialSchema: false,
        schemaModuleHashes: [],
        excludedModuleHashes: [],
        compiler: unavailableCompilerStatus(),
        modules: [],
        fileResults: [],
        diagnostics: [],
        diagnosticsTruncated: false,
        summary: {
            moduleCount: 0,
            nodeCount: 0,
            cacheHit: false,
            errors: 0,
            warnings: 0,
            compiledFiles: 0,
            failedFiles: 0
        },
        schemaTree: null,
        processRunning: false
    };
}

class YangApp {
    constructor(ipcMain, store, options = {}) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.rootDir = path.resolve(options.rootDir || path.join(app.getPath('userData'), 'yang'));
        this.compilerPath = options.compilerPath || process.env.NETNEXUS_YANGLINT_PATH || null;
        this.compilerArgs = Array.isArray(options.compilerArgs) ? options.compilerArgs : [];
        this.schemaHelperPath = options.schemaHelperPath || process.env.NETNEXUS_LIBYANG_SCHEMA_PATH || null;
        this.schemaHelperArgs = Array.isArray(options.schemaHelperArgs) ? options.schemaHelperArgs : [];
        this.resourcesPath = options.resourcesPath || process.resourcesPath;
        this.isPackaged = options.isPackaged ?? Boolean(app?.isPackaged);
        this.primaryWebContents = options.primaryWebContents || null;
        this.hasFixedPrimaryWebContents = Boolean(this.primaryWebContents);
        this.eventDispatcher = new EventDispatcher();
        if (this.primaryWebContents && !this.primaryWebContents.isDestroyed?.()) {
            this.eventDispatcher.setWebContents(this.primaryWebContents);
        }
        this.processClient = null;
        this.workerClient = null;
        this.processConfigurePromise = null;
        this.processReady = false;
        this.activeProfileId = null;
        this.logLevel = null;
        this.boundProcessEvent = (eventName, data) => this.handleProcessEvent(eventName, data);
        this.processExitHandlers = new WeakMap();
        this.registerIpcHandlers();
    }

    registerIpcHandlers() {
        const handlers = {
            'yang:listModules': this.handleListModules,
            'yang:selectFiles': this.handleSelectFiles,
            'yang:selectDirectory': this.handleSelectDirectory,
            'yang:importFiles': this.handleImportFiles,
            'yang:importDirectory': this.handleImportDirectory,
            'yang:compile': this.handleCompile,
            'yang:getCompilerStatus': this.handleGetCompilerStatus,
            'yang:clearWorkspace': this.handleClearWorkspace,
            'yang:getWorkspace': this.handleGetWorkspace,
            'yang:getSchemaRoots': this.handleGetSchemaRoots,
            'yang:getSchemaChildren': this.handleGetSchemaChildren,
            'yang:getSchemaNode': this.handleGetSchemaNode,
            'yang:validateRpc': this.handleValidateRpc,
            'yang:getModuleSource': this.handleGetModuleSource,
            'yang:getDiagnostics': this.handleGetDiagnostics,
            'yang:getRuntimeState': this.handleGetRuntimeState
        };
        for (const [channel, handler] of Object.entries(handlers)) {
            this.ipcMain.handle(channel, handler.bind(this));
        }
    }

    setWebContents(event) {
        if (this.hasFixedPrimaryWebContents) {
            if (this.primaryWebContents && !this.primaryWebContents.isDestroyed?.()) {
                this.eventDispatcher.setWebContents(this.primaryWebContents);
            }
            return;
        }
        if (event?.sender && !event.sender.isDestroyed?.()) this.eventDispatcher.setWebContents(event.sender);
    }

    getProcessConfiguration() {
        const pending = this.store?.get(PENDING_WORKSPACE_DELETIONS_KEY, []);
        return {
            rootDir: this.rootDir,
            compilerPath: this.compilerPath,
            compilerArgs: this.compilerArgs,
            schemaHelperPath: this.schemaHelperPath,
            schemaHelperArgs: this.schemaHelperArgs,
            resourcesPath: this.resourcesPath,
            isPackaged: this.isPackaged,
            persistedCompileState: this.store?.get(STATE_STORE_KEY, null),
            pendingWorkspaceDeletions: Array.isArray(pending) ? pending : []
        };
    }

    runtimeSnapshot() {
        return {
            running: Boolean(this.processClient),
            ready: Boolean(this.processClient && this.processReady),
            processRunning: Boolean(this.processClient),
            activeProfileId: this.activeProfileId
        };
    }

    emitRuntimeChanged() {
        if (this.eventDispatcher.canEmit(YANG_EVT_TYPES.RUNTIME_CHANGED)) {
            this.eventDispatcher.emit(YANG_EVT_TYPES.RUNTIME_CHANGED, successResponse(this.runtimeSnapshot()));
        }
    }

    emitTaskProgress(progress) {
        if (this.eventDispatcher.canEmit(YANG_EVT_TYPES.TASK_PROGRESS)) {
            this.eventDispatcher.emit(YANG_EVT_TYPES.TASK_PROGRESS, successResponse(progress, 'YANG任务进度'));
        }
    }

    handleProcessEvent(eventName, data) {
        if (eventName === YANG_PROCESS_EVT_TYPES.STATE_UPDATE) {
            if (data?.key !== STATE_STORE_KEY) return;
            if (data.value === null || data.value === undefined) this.store?.delete(STATE_STORE_KEY);
            else this.store?.set(STATE_STORE_KEY, data.value);
            return;
        }
        if (eventName !== YANG_EVT_TYPES.TASK_PROGRESS) return;
        if (this.eventDispatcher.canEmit(eventName)) this.eventDispatcher.emit(eventName, data);
    }

    async attachProcessClient(client) {
        if (!client) throw new Error('缺少YANG进程客户端');
        if (this.processClient === client && this.processConfigurePromise) return this.processConfigurePromise;
        this.detachProcessClient(this.processClient);
        this.processClient = client;
        this.workerClient = client;
        this.processReady = false;
        client.on?.('event', this.boundProcessEvent);
        const exitHandler = () => this.detachProcessClient(client);
        this.processExitHandlers.set(client, exitHandler);
        client.on?.('exit', exitHandler);
        const configuration = client
            .sendRequest(YANG_PROCESS_REQ_TYPES.CONFIGURE, this.getProcessConfiguration(), { timeoutMs: 30000 })
            .then(response => {
                if (this.processClient !== client) {
                    const error = new Error('YANG进程已退出');
                    error.code = 'YANG_PROCESS_NOT_RUNNING';
                    throw error;
                }
                this.processReady = true;
                this.store?.delete(PENDING_WORKSPACE_DELETIONS_KEY);
                if (this.logLevel) {
                    void client.sendRequest(LOG_REQ_TYPES.SET_LOG_LEVEL, this.logLevel).catch(() => {});
                }
                this.emitRuntimeChanged();
                return response.data;
            });
        this.processConfigurePromise = configuration;
        try {
            return await configuration;
        } catch (error) {
            this.detachProcessClient(client);
            throw error;
        }
    }

    detachProcessClient(client = this.processClient) {
        if (!client || this.processClient !== client) return false;
        client.off?.('event', this.boundProcessEvent);
        const exitHandler = this.processExitHandlers.get(client);
        if (exitHandler) client.off?.('exit', exitHandler);
        this.processExitHandlers.delete(client);
        this.processClient = null;
        this.workerClient = null;
        this.processConfigurePromise = null;
        this.processReady = false;
        this.activeProfileId = null;
        this.emitRuntimeChanged();
        return true;
    }

    async request(channel, data = {}, options = {}) {
        const client = this.processClient;
        const configured = this.processConfigurePromise;
        if (!client || !configured) {
            const error = new Error('YANG进程未启动，请先连接NETCONF设备');
            error.code = 'YANG_PROCESS_NOT_RUNNING';
            throw error;
        }
        await configured;
        if (this.processClient !== client) {
            const error = new Error('YANG进程已退出');
            error.code = 'YANG_PROCESS_NOT_RUNNING';
            throw error;
        }
        const response = await client.sendRequest(channel, data, {
            timeoutMs: options.timeoutMs || DEFAULT_REQUEST_TIMEOUT,
            signal: options.signal
        });
        return response.data;
    }

    async forward(event, channel, data = {}, options = {}) {
        try {
            this.setWebContents(event);
            return await this.request(channel, data, options);
        } catch (error) {
            return errorResponse(error.message, { code: error.code, details: error.data });
        }
    }

    async selectFiles(event) {
        const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
        const options = {
            title: '导入YANG文件',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'YANG模型', extensions: ['yang'] }]
        };
        const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        return result.canceled ? [] : result.filePaths || [];
    }

    async selectDirectory(event) {
        const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
        const options = { title: '导入YANG目录', properties: ['openDirectory'] };
        const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        return result.canceled ? null : result.filePaths?.[0] || null;
    }

    async handleSelectFiles(event) {
        try {
            return successResponse(await this.selectFiles(event));
        } catch (error) {
            return errorResponse('选择YANG文件失败: ' + error.message);
        }
    }

    async handleSelectDirectory(event) {
        try {
            return successResponse(await this.selectDirectory(event));
        } catch (error) {
            return errorResponse('选择YANG目录失败: ' + error.message);
        }
    }

    async handleListModules(event, query = {}) {
        if (!this.processClient) return successResponse([]);
        return this.forward(event, 'yang:listModules', query || {});
    }

    async handleGetWorkspace(event, query = {}) {
        if (!this.processClient) return successResponse(emptyWorkspace(query?.profileId));
        return this.forward(event, 'yang:getWorkspace', query || {});
    }

    async handleGetCompilerStatus(event, options = {}) {
        if (!this.processClient) return successResponse(unavailableCompilerStatus(), 'YANG进程未启动');
        return this.forward(event, 'yang:getCompilerStatus', options || {});
    }

    async handleImportFiles(event, input = {}) {
        if (!this.processClient) {
            return errorResponse('YANG进程未启动，请先连接NETCONF设备', {
                code: 'YANG_PROCESS_NOT_RUNNING'
            });
        }
        const options = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
        const requestedPaths = Array.isArray(input) ? input : options.filePaths || options.paths;
        const filePaths =
            Array.isArray(requestedPaths) && requestedPaths.length ? requestedPaths : await this.selectFiles(event);
        if (!filePaths.length) return successResponse({ cancelled: true, filePaths: [] }, '已取消导入');
        return this.forward(event, 'yang:importFiles', { ...options, filePaths });
    }

    async handleImportDirectory(event, input = {}) {
        if (!this.processClient) {
            return errorResponse('YANG进程未启动，请先连接NETCONF设备', {
                code: 'YANG_PROCESS_NOT_RUNNING'
            });
        }
        const options = input && typeof input === 'object' ? { ...input } : {};
        const requestedPath = typeof input === 'string' ? input : options.directoryPath || options.path;
        const directoryPath = requestedPath || (await this.selectDirectory(event));
        if (!directoryPath) return successResponse({ cancelled: true }, '已取消导入');
        return this.forward(event, 'yang:importDirectory', { ...options, directoryPath });
    }

    handleCompile(event, options = {}) {
        return this.forward(event, 'yang:compile', options || {}, { timeoutMs: 10 * 60 * 1000 });
    }

    handleClearWorkspace(event, request = {}) {
        return this.forward(event, 'yang:clearWorkspace', request || {});
    }

    handleGetSchemaRoots(event, query = {}) {
        return this.forward(event, 'yang:getSchemaRoots', query || {});
    }

    handleGetSchemaChildren(event, request = {}) {
        return this.forward(event, 'yang:getSchemaChildren', request || {});
    }

    handleGetSchemaNode(event, request = {}) {
        return this.forward(event, 'yang:getSchemaNode', request || {});
    }

    handleValidateRpc(event, request = {}) {
        return this.forward(event, 'yang:validateRpc', request || {}, { timeoutMs: 60000 });
    }

    handleGetModuleSource(event, request = {}) {
        return this.forward(event, 'yang:getModuleSource', request || {});
    }

    handleGetDiagnostics(event, query = {}) {
        return this.forward(event, 'yang:getDiagnostics', query || {});
    }

    async handleGetRuntimeState() {
        return successResponse(this.runtimeSnapshot());
    }

    setActiveProfileId(profileId) {
        this.activeProfileId = profileId ? String(profileId) : null;
        const client = this.processClient;
        if (client && this.processConfigurePromise) {
            void this.processConfigurePromise
                .then(() =>
                    client.sendRequest(YANG_PROCESS_REQ_TYPES.SET_ACTIVE_PROFILE, {
                        profileId: this.activeProfileId
                    })
                )
                .catch(() => {});
        }
    }

    profileWorkspaceId(profileId) {
        return profileWorkspaceId(profileId);
    }

    async getWorkspaceGeneration(request = {}) {
        const response = await this.request(YANG_PROCESS_REQ_TYPES.GET_WORKSPACE_GENERATION, request);
        return Number(response) || 0;
    }

    async importDownloadedContents(contents, options = {}) {
        return this.request(YANG_PROCESS_REQ_TYPES.IMPORT_DOWNLOADED_CONTENTS, { contents, options });
    }

    async deleteProfileWorkspace(profileId) {
        if (this.processClient) {
            const response = await this.request(YANG_PROCESS_REQ_TYPES.DELETE_PROFILE_WORKSPACE, { profileId });
            this.persistProfileWorkspaceDeletion(profileId, { pending: false });
            return Boolean(response);
        }
        this.persistProfileWorkspaceDeletion(profileId, { pending: true });
        return true;
    }

    persistProfileWorkspaceDeletion(profileId, options = {}) {
        const pending = new Set(this.store?.get(PENDING_WORKSPACE_DELETIONS_KEY, []));
        const id = String(profileId || '');
        if (options.pending === true) pending.add(id);
        else pending.delete(id);
        if (pending.size > 0) this.store?.set(PENDING_WORKSPACE_DELETIONS_KEY, [...pending]);
        else this.store?.delete(PENDING_WORKSPACE_DELETIONS_KEY);
        const state = this.store?.get(STATE_STORE_KEY, null);
        if (state?.workspaces) {
            const next = { ...state, workspaces: { ...state.workspaces } };
            delete next.workspaces[profileWorkspaceId(id)];
            this.store?.set(STATE_STORE_KEY, next);
        }
    }

    invalidateCompilation() {
        this.store?.delete(STATE_STORE_KEY);
    }

    async handleLogLevelChange(logLevel) {
        this.logLevel = logLevel;
        if (!this.processClient) return;
        await this.request(LOG_REQ_TYPES.SET_LOG_LEVEL, logLevel).catch(() => {});
    }

    getRunning() {
        return Boolean(this.processClient);
    }

    async close() {
        this.detachProcessClient(this.processClient);
        this.eventDispatcher.cleanup();
    }
}

module.exports = YangApp;
module.exports.profileWorkspaceId = profileWorkspaceId;
module.exports.STATE_STORE_KEY = STATE_STORE_KEY;
module.exports.PENDING_WORKSPACE_DELETIONS_KEY = PENDING_WORKSPACE_DELETIONS_KEY;
module.exports.emptyWorkspace = emptyWorkspace;
module.exports.unavailableCompilerStatus = unavailableCompilerStatus;
