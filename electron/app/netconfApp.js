const fs = require('fs');
const { randomUUID } = require('crypto');
const { BrowserWindow, dialog } = require('electron');
const logger = require('../log/logger');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const EventDispatcher = require('../utils/eventDispatcher');
const SecureCredentialStore = require('../utils/secureCredentialStore');
const TaskManager = require('../utils/taskManager');
const RequestWorkerClient = require('../worker/core/requestWorkerClient');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const { NETCONF_REQ_TYPES, YANG_EVT_TYPES, DEFAULT_NETCONF_PROFILE, NETCONF_LIMITS } = require('../const/yangConst');

const PROFILE_STORE_KEY = 'netconf-profiles';
const ALLOWED_AUTH_METHODS = new Set(['password', 'privateKey', 'agent']);
const ALLOWED_HOST_KEY_POLICIES = new Set(['ask', 'strict', 'accept-new']);

class NetconfApp {
    constructor(ipcMain, store, options = {}) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.yangApp = options.yangApp || null;
        this.workerClient = null;
        this.eventDispatcher = new EventDispatcher();
        this.credentialStore = options.credentialStore || new SecureCredentialStore();
        this.transientSecrets = new Map();
        this.inventories = new Map();
        this.activeProfileId = null;
        this.logLevel = null;
        this.taskManager = new TaskManager({
            onProgress: progress => {
                if (this.eventDispatcher.canEmit()) {
                    this.eventDispatcher.emit(YANG_EVT_TYPES.TASK_PROGRESS, successResponse(progress, 'YANG任务进度'));
                }
            }
        });
        this.registerIpcHandlers();
    }

    registerIpcHandlers() {
        const handle = (channel, handler) => this.ipcMain.handle(channel, handler.bind(this));
        handle('netconf:listProfiles', this.handleListProfiles);
        handle('netconf:saveProfile', this.handleSaveProfile);
        handle('netconf:deleteProfile', this.handleDeleteProfile);
        handle('netconf:selectPrivateKey', this.handleSelectPrivateKey);
        handle('netconf:testConnection', this.handleTestConnection);
        handle('netconf:connect', this.handleConnect);
        handle('netconf:disconnect', this.handleDisconnect);
        handle('netconf:getSessionState', this.handleGetSessionState);
        handle('netconf:discoverModules', this.handleDiscoverModules);
        handle('netconf:downloadModules', this.handleDownloadModules);
        handle('netconf:executeOperation', this.handleExecuteOperation);
        handle('netconf:sendRpc', this.handleSendRpc);
        handle('netconf:getTask', this.handleGetTask);
        handle('netconf:cancelTask', this.handleCancelTask);
    }

    setWebContents(event) {
        if (event?.sender && !event.sender.isDestroyed?.()) this.eventDispatcher.setWebContents(event.sender);
    }

    getStoredProfiles() {
        const profiles = this.store.get(PROFILE_STORE_KEY, []);
        return Array.isArray(profiles) ? profiles : [];
    }

    saveStoredProfiles(profiles) {
        this.store.set(PROFILE_STORE_KEY, profiles);
    }

    findStoredProfile(profileId) {
        return this.getStoredProfiles().find(profile => profile.id === profileId) || null;
    }

    normalizeProfile(input = {}, existing = null) {
        const id = String(input.id || existing?.id || randomUUID());
        const name = String(input.name || existing?.name || input.host || '')
            .trim()
            .slice(0, 80);
        const host = String(input.host || existing?.host || '').trim();
        const port = Number(input.port ?? existing?.port ?? DEFAULT_NETCONF_PROFILE.port);
        const username = String(input.username ?? existing?.username ?? '').trim();
        const authMethod =
            input.authMethod || input.authType || existing?.authMethod || DEFAULT_NETCONF_PROFILE.authMethod;
        const hostKeyPolicy = input.hostKeyPolicy || existing?.hostKeyPolicy || DEFAULT_NETCONF_PROFILE.hostKeyPolicy;

        if (!name) throw new Error('请输入连接名称');
        if (!host || /[\s\0]/u.test(host)) throw new Error('请输入有效的设备地址');
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在1到65535之间');
        if (!username) throw new Error('请输入NETCONF用户名');
        if (!ALLOWED_AUTH_METHODS.has(authMethod)) throw new Error(`不支持的认证方式: ${authMethod}`);
        if (!ALLOWED_HOST_KEY_POLICIES.has(hostKeyPolicy)) throw new Error(`不支持的主机密钥策略: ${hostKeyPolicy}`);

        const number = (value, fallback, min, max) => {
            const normalized = Number(value ?? fallback);
            return Number.isFinite(normalized) ? Math.max(min, Math.min(max, Math.trunc(normalized))) : fallback;
        };

        return {
            ...DEFAULT_NETCONF_PROFILE,
            ...existing,
            ...input,
            id,
            name,
            host,
            port,
            username,
            authMethod,
            hostKeyPolicy,
            privateKeyPath: String(input.privateKeyPath ?? existing?.privateKeyPath ?? '').trim(),
            hostKeyFingerprint: String(input.hostKeyFingerprint ?? existing?.hostKeyFingerprint ?? '').trim(),
            rememberCredentials: Boolean(input.rememberCredentials ?? existing?.rememberCredentials),
            autoReconnect: Boolean(input.autoReconnect ?? existing?.autoReconnect),
            connectTimeout: number(input.connectTimeout, existing?.connectTimeout || 15000, 1000, 120000),
            rpcTimeout: number(input.rpcTimeout, existing?.rpcTimeout || 30000, 1000, 300000),
            keepaliveInterval: number(input.keepaliveInterval, existing?.keepaliveInterval || 30000, 0, 300000),
            keepaliveCountMax: number(input.keepaliveCountMax, existing?.keepaliveCountMax || 3, 1, 20)
        };
    }

    captureTransientSecrets(profile) {
        if (!profile?.id) return;
        const previous = this.transientSecrets.get(profile.id) || {};
        const secrets = { ...previous };
        ['password', 'passphrase', 'privateKey'].forEach(field => {
            if (!Object.prototype.hasOwnProperty.call(profile, field)) return;
            if (profile[field]) secrets[field] = String(profile[field]);
            else delete secrets[field];
        });
        if (Object.keys(secrets).length > 0) this.transientSecrets.set(profile.id, secrets);
        else this.transientSecrets.delete(profile.id);
    }

    resolveRuntimeProfile(profileOrId) {
        const provided = profileOrId && typeof profileOrId === 'object' ? profileOrId : null;
        const profileId = provided?.id || profileOrId || this.activeProfileId;
        const stored = profileId ? this.findStoredProfile(String(profileId)) : null;
        const normalized = this.normalizeProfile(provided || stored || {}, stored);
        this.captureTransientSecrets({ ...provided, id: normalized.id });
        const runtime = this.credentialStore.hydrateProfile(
            stored ? { ...stored, ...normalized } : normalized,
            this.transientSecrets.get(normalized.id) || provided || {}
        );
        if (runtime.authMethod === 'password' && !runtime.password) {
            throw new Error('该连接没有可用密码，请重新输入凭据');
        }
        if (runtime.authMethod === 'privateKey' && !runtime.privateKey && !runtime.privateKeyPath) {
            throw new Error('请选择私钥文件');
        }
        return runtime;
    }

    ensureWorker(event) {
        this.setWebContents(event);
        if (this.workerClient) return this.workerClient;
        this.workerClient = new RequestWorkerClient(resolveWorkerPath('yang/netconfWorker.js'), {
            defaultTimeoutMs: NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT + 5000
        });
        this.workerClient.on('event', (eventName, data) => {
            const state = data && typeof data === 'object' ? data : null;
            if (eventName !== YANG_EVT_TYPES.NOTIFICATION && state?.profileId) {
                if (['connected', 'connecting', 'reconnecting'].includes(state.status)) {
                    this.activeProfileId = state.profileId;
                } else if (
                    this.activeProfileId === state.profileId &&
                    ['disconnected', 'error'].includes(state.status)
                ) {
                    this.activeProfileId = null;
                }
            }
            if (!this.eventDispatcher.canEmit()) return;
            if (eventName === YANG_EVT_TYPES.NOTIFICATION) {
                this.eventDispatcher.emit(YANG_EVT_TYPES.NOTIFICATION, successResponse(data));
            } else {
                this.eventDispatcher.emit(YANG_EVT_TYPES.SESSION_EVENT, successResponse(data));
            }
        });
        this.workerClient.on('exit', () => {
            this.workerClient = null;
            this.activeProfileId = null;
        });
        return this.workerClient;
    }

    async handleListProfiles() {
        try {
            return successResponse({
                profiles: this.getStoredProfiles().map(profile => this.credentialStore.sanitizeProfile(profile)),
                activeProfileId: this.activeProfileId
            });
        } catch (error) {
            return errorResponse('获取NETCONF连接失败: ' + error.message);
        }
    }

    async handleSaveProfile(_event, input = {}) {
        try {
            const profiles = this.getStoredProfiles();
            const index = input.id ? profiles.findIndex(profile => profile.id === input.id) : -1;
            const existing = index >= 0 ? profiles[index] : null;
            const normalized = this.normalizeProfile(input, existing);
            this.captureTransientSecrets(normalized);
            const protectedProfile = this.credentialStore.protectProfile(normalized, existing || {});
            if (index >= 0) profiles.splice(index, 1, protectedProfile);
            else profiles.push(protectedProfile);
            this.saveStoredProfiles(profiles);
            return successResponse(this.credentialStore.sanitizeProfile(protectedProfile), '连接配置已保存');
        } catch (error) {
            logger.error('保存NETCONF连接失败:', error);
            return errorResponse('保存连接失败: ' + error.message);
        }
    }

    async handleDeleteProfile(event, profileId) {
        try {
            const id = String(profileId || '');
            if (!id) return errorResponse('缺少连接ID');
            if (this.activeProfileId === id) await this.disconnectProfile(event, id);
            this.saveStoredProfiles(this.getStoredProfiles().filter(profile => profile.id !== id));
            this.transientSecrets.delete(id);
            this.inventories.delete(id);
            return successResponse(null, '连接配置已删除');
        } catch (error) {
            return errorResponse('删除连接失败: ' + error.message);
        }
    }

    async handleSelectPrivateKey(event) {
        try {
            const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
            const options = {
                title: '选择SSH私钥',
                properties: ['openFile'],
                filters: [{ name: 'SSH私钥', extensions: ['pem', 'key', 'ppk', '*'] }]
            };
            const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
            return successResponse(result.canceled ? null : result.filePaths[0] || null);
        } catch (error) {
            return errorResponse('选择私钥失败: ' + error.message);
        }
    }

    async handleTestConnection(event, profile) {
        const startedAt = Date.now();
        try {
            const runtime = this.resolveRuntimeProfile(profile);
            if (runtime.privateKeyPath && !fs.existsSync(runtime.privateKeyPath)) throw new Error('私钥文件不存在');
            const result = await this.ensureWorker(event).sendRequest(NETCONF_REQ_TYPES.TEST_CONNECTION, runtime, {
                timeoutMs: runtime.connectTimeout + runtime.rpcTimeout + 5000
            });
            return successResponse({ ...result.data, latency: Date.now() - startedAt }, 'NETCONF连接测试成功');
        } catch (error) {
            logger.error('NETCONF连接测试失败:', error.message);
            return errorResponse('连接测试失败: ' + error.message, { code: error.code });
        }
    }

    async handleConnect(event, profileOrId) {
        try {
            const runtime = this.resolveRuntimeProfile(profileOrId);
            const result = await this.ensureWorker(event).sendRequest(NETCONF_REQ_TYPES.CONNECT, runtime, {
                timeoutMs: runtime.connectTimeout + runtime.rpcTimeout + 5000
            });
            this.activeProfileId = runtime.id;
            this.rememberObservedFingerprint(runtime.id, result.data?.hostKeyFingerprint);
            return successResponse(result.data, 'NETCONF连接成功');
        } catch (error) {
            logger.error('NETCONF连接失败:', error.message);
            return errorResponse('NETCONF连接失败: ' + error.message, { code: error.code, details: error.data });
        }
    }

    rememberObservedFingerprint(profileId, fingerprint) {
        if (!profileId || !fingerprint) return;
        const profiles = this.getStoredProfiles();
        const index = profiles.findIndex(profile => profile.id === profileId);
        if (index < 0 || profiles[index].hostKeyFingerprint) return;
        profiles[index] = { ...profiles[index], hostKeyFingerprint: fingerprint };
        this.saveStoredProfiles(profiles);
    }

    async disconnectProfile(event, profileId) {
        if (!this.workerClient) return { profileId, status: 'disconnected' };
        const result = await this.ensureWorker(event).sendRequest(
            NETCONF_REQ_TYPES.DISCONNECT,
            { profileId },
            { timeoutMs: 10000 }
        );
        if (this.activeProfileId === profileId) this.activeProfileId = null;
        return result.data;
    }

    async handleDisconnect(event, profileId) {
        try {
            const id = String(profileId || this.activeProfileId || '');
            if (!id) return successResponse({ status: 'disconnected' }, '当前没有活动连接');
            return successResponse(await this.disconnectProfile(event, id), 'NETCONF连接已断开');
        } catch (error) {
            return errorResponse('断开NETCONF连接失败: ' + error.message);
        }
    }

    async handleGetSessionState(event, profileId) {
        try {
            const id = String(profileId || this.activeProfileId || '');
            if (!id || !this.workerClient) {
                return successResponse({
                    profileId: id || null,
                    status: 'disconnected',
                    activeProfileId: this.activeProfileId
                });
            }
            const result = await this.ensureWorker(event).sendRequest(NETCONF_REQ_TYPES.GET_SESSION_STATE, {
                profileId: id
            });
            return successResponse({ ...result.data, activeProfileId: this.activeProfileId });
        } catch (error) {
            return errorResponse('获取NETCONF状态失败: ' + error.message);
        }
    }

    resolveProfileId(request = null) {
        const value = request && typeof request === 'object' ? request.profileId : request;
        const profileId = value || this.activeProfileId;
        if (!profileId) throw new Error('请先连接NETCONF设备');
        return String(profileId);
    }

    async discoverModules(event, profileId) {
        const id = this.resolveProfileId(profileId);
        const result = await this.ensureWorker(event).sendRequest(
            NETCONF_REQ_TYPES.DISCOVER_MODULES,
            { profileId: id },
            { timeoutMs: 120000 }
        );
        const inventory = result.data || { modules: [] };
        this.inventories.set(id, inventory);
        return inventory;
    }

    async handleDiscoverModules(event, profileId) {
        try {
            return successResponse(await this.discoverModules(event, profileId), 'YANG模型列表读取成功');
        } catch (error) {
            logger.error('读取YANG模型列表失败:', error.message);
            return errorResponse('读取YANG模型列表失败: ' + error.message, { code: error.code, details: error.data });
        }
    }

    selectInventoryModules(inventory, requested = []) {
        const modules = Array.isArray(inventory?.modules) ? inventory.modules : [];
        if (!Array.isArray(requested) || requested.length === 0) return modules;
        const keys = new Set(
            requested.map(item => {
                if (typeof item === 'string') return item;
                return `${item.name || item.identifier || ''}@${item.revision || item.version || ''}`;
            })
        );
        return modules.filter(module => {
            const name = module.name || module.identifier || '';
            const revision = module.revision || module.version || '';
            return keys.has(name) || keys.has(`${name}@${revision}`);
        });
    }

    async downloadOne(profileId, module, signal) {
        const result = await this.workerClient.sendRequest(
            NETCONF_REQ_TYPES.GET_SCHEMA,
            { profileId, module },
            { timeoutMs: 120000, signal }
        );
        const content = result.data?.content ?? result.data?.schema ?? result.data;
        if (typeof content !== 'string' || !content.trim()) throw new Error('设备返回了空的YANG模型');
        if (Buffer.byteLength(content, 'utf8') > NETCONF_LIMITS.MAX_SCHEMA_BYTES) {
            throw new Error('设备返回的YANG模型超过大小限制');
        }
        return {
            content,
            expectedName: module.name || module.identifier,
            revision: module.revision || module.version || '',
            fileName: `${module.name || module.identifier}${module.revision || module.version ? `@${module.revision || module.version}` : ''}.yang`,
            source: result.data?.source || `netconf://${profileId}/${module.name || module.identifier}`,
            dependencies: Array.isArray(result.data?.dependencies) ? result.data.dependencies : []
        };
    }

    moduleKey(module) {
        const name = module?.name || module?.identifier || '';
        const revision = module?.revision || module?.version || '';
        return `${name}@${revision}`;
    }

    findInventoryDependency(inventory, name, revision = '') {
        const candidates = (inventory?.modules || []).filter(module => (module.name || module.identifier) === name);
        if (revision) {
            const exact = candidates.find(module => (module.revision || module.version || '') === revision);
            if (exact) return exact;
        }
        return candidates.sort((left, right) =>
            (right.revision || right.version || '').localeCompare(left.revision || left.version || '')
        )[0];
    }

    inventoryDeclaredDependencies(inventory, module) {
        const dependencies = [];
        const add = item => {
            const descriptor = typeof item === 'string' ? { name: item } : item || {};
            const target = this.findInventoryDependency(
                inventory,
                descriptor.name || descriptor.identifier,
                descriptor.revision || descriptor.version || descriptor.revisionDate
            );
            if (target) dependencies.push(target);
        };
        (module.submodules || []).forEach(add);
        (module.deviations || []).forEach(add);
        return dependencies;
    }

    parsedDependencies(inventory, downloaded) {
        return (downloaded.dependencies || [])
            .map(item => this.findInventoryDependency(inventory, item.name, item.revisionDate))
            .filter(Boolean);
    }

    async handleDownloadModules(event, request = {}) {
        try {
            this.setWebContents(event);
            const profileId = this.resolveProfileId(request);
            const task = this.taskManager.start(
                'download',
                async ({ signal, report }) => {
                    let inventory = this.inventories.get(profileId);
                    if (!inventory) {
                        report({ phase: 'discovering', percent: 5, message: '正在读取设备YANG列表' });
                        inventory = await this.discoverModules(event, profileId);
                    }
                    const selected = this.selectInventoryModules(inventory, request.modules);
                    if (selected.length === 0) throw new Error('没有匹配的YANG模型可下载');
                    const downloaded = [];
                    const failed = [];
                    const queuedKeys = new Set();
                    const queue = [];
                    const enqueue = module => {
                        const key = this.moduleKey(module);
                        if (!key || queuedKeys.has(key)) return;
                        queuedKeys.add(key);
                        queue.push(module);
                    };
                    selected.forEach(enqueue);
                    if (request.includeDependencies !== false) {
                        selected
                            .flatMap(module => this.inventoryDeclaredDependencies(inventory, module))
                            .forEach(enqueue);
                    }
                    for (let index = 0; index < queue.length; index += 1) {
                        if (signal.aborted) break;
                        const module = queue[index];
                        report({
                            phase: 'downloading',
                            percent: 10 + Math.round((index / Math.max(1, queue.length)) * 70),
                            completed: index,
                            total: queue.length,
                            module: module.name || module.identifier
                        });
                        try {
                            const item = await this.downloadOne(profileId, module, signal);
                            downloaded.push(item);
                            if (request.includeDependencies !== false) {
                                this.parsedDependencies(inventory, item).forEach(enqueue);
                                this.inventoryDeclaredDependencies(inventory, module).forEach(enqueue);
                            }
                        } catch (error) {
                            failed.push({
                                name: module.name || module.identifier,
                                revision: module.revision || module.version || '',
                                error: error.message
                            });
                        }
                    }
                    if (downloaded.length === 0) {
                        const detail = failed[0]?.error || '设备未返回模型内容';
                        throw new Error(`YANG下载失败: ${detail}`);
                    }
                    report({ phase: 'importing', percent: 85, message: '正在写入本地YANG仓库' });
                    const imported = this.yangApp
                        ? await this.yangApp.importDownloadedContents(downloaded, {
                              snapshotId: request.snapshotId,
                              profileId,
                              inventory
                          })
                        : { downloaded };
                    return { profileId, downloaded: downloaded.length, failed, imported };
                },
                { profileId }
            );
            return successResponse(task, 'YANG下载任务已开始');
        } catch (error) {
            return errorResponse('启动YANG下载失败: ' + error.message);
        }
    }

    async handleExecuteOperation(event, request = {}) {
        try {
            const profileId = this.resolveProfileId(request);
            const result = await this.ensureWorker(event).sendRequest(
                NETCONF_REQ_TYPES.EXECUTE_OPERATION,
                { ...request, profileId },
                { timeoutMs: Number(request.timeout) || 120000 }
            );
            return successResponse(result.data, 'NETCONF操作完成');
        } catch (error) {
            return errorResponse('NETCONF操作失败: ' + error.message, { code: error.code, details: error.data });
        }
    }

    async handleSendRpc(event, request = {}) {
        try {
            const profileId = this.resolveProfileId(request);
            const result = await this.ensureWorker(event).sendRequest(
                NETCONF_REQ_TYPES.SEND_RPC,
                { ...request, profileId },
                { timeoutMs: Number(request.timeout) || 120000 }
            );
            return successResponse(result.data, 'NETCONF RPC完成');
        } catch (error) {
            return errorResponse('NETCONF RPC失败: ' + error.message, { code: error.code, details: error.data });
        }
    }

    async handleGetTask(_event, taskId) {
        const task = this.taskManager.get(taskId);
        return task ? successResponse(task) : errorResponse('任务不存在');
    }

    async handleCancelTask(_event, taskId) {
        return this.taskManager.cancel(taskId)
            ? successResponse(null, '任务已取消')
            : errorResponse('任务不存在或已经结束');
    }

    getRunning() {
        return Boolean(
            (this.workerClient && this.activeProfileId) ||
                this.taskManager.list().some(task => task.status === 'running')
        );
    }

    async handleLogLevelChange(logLevel) {
        this.logLevel = logLevel;
    }

    async closeAll() {
        for (const task of this.taskManager.list()) {
            if (task.status === 'running') this.taskManager.cancel(task.taskId);
        }
        if (!this.workerClient) {
            this.eventDispatcher.cleanup();
            return;
        }
        try {
            await this.workerClient.sendRequest(NETCONF_REQ_TYPES.DISCONNECT_ALL, null, { timeoutMs: 10000 });
        } catch (error) {
            logger.warn('关闭NETCONF会话失败:', error.message);
        } finally {
            await this.workerClient.terminate();
            this.workerClient = null;
            this.activeProfileId = null;
            this.eventDispatcher.cleanup();
        }
    }
}

module.exports = NetconfApp;
