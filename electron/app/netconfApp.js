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
        this.deletingProfiles = new Set();
        this.profileGenerations = new Map();
        this.profileDeletionPromises = new Map();
        this.closing = false;
        this.closePromise = null;
        this.activeProfileId = null;
        this.yangApp?.setActiveProfileId?.(null);
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

    profileGeneration(profileId) {
        return this.profileGenerations.get(String(profileId || '')) || 0;
    }

    assertProfileAvailable(profileId, expectedGeneration = undefined) {
        const id = String(profileId || '');
        if (this.closing) {
            const error = new Error('NETCONF 服务正在关闭');
            error.code = 'NETCONF_APP_CLOSING';
            throw error;
        }
        if (this.deletingProfiles.has(id) || (expectedGeneration !== undefined && this.profileGeneration(id) !== expectedGeneration)) {
            const error = new Error('连接 Profile 正在删除或已被删除');
            error.code = 'NETCONF_PROFILE_DELETING';
            throw error;
        }
        return this.profileGeneration(id);
    }

    beginProfileDeletion(profileId) {
        const id = String(profileId || '');
        this.deletingProfiles.add(id);
        const generation = this.profileGeneration(id) + 1;
        this.profileGenerations.set(id, generation);
        return generation;
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
        this.yangApp?.profileWorkspaceId?.(id);
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
        if (this.closing) {
            const error = new Error('NETCONF 服务正在关闭');
            error.code = 'NETCONF_APP_CLOSING';
            throw error;
        }
        this.setWebContents(event);
        if (this.workerClient) return this.workerClient;
        this.workerClient = new RequestWorkerClient(resolveWorkerPath('yang/netconfWorker.js'), {
            defaultTimeoutMs: NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT + 5000
        });
        this.workerClient.on('event', (eventName, data) => {
            const state = data && typeof data === 'object' ? data : null;
            if (
                eventName !== YANG_EVT_TYPES.NOTIFICATION &&
                state?.profileId &&
                !this.closing &&
                !this.deletingProfiles.has(state.profileId)
            ) {
                if (['connected', 'connecting', 'reconnecting'].includes(state.status)) {
                    this.activeProfileId = state.profileId;
                    this.yangApp?.setActiveProfileId?.(state.profileId);
                } else if (
                    this.activeProfileId === state.profileId &&
                    ['disconnected', 'error'].includes(state.status)
                ) {
                    this.activeProfileId = null;
                    this.yangApp?.setActiveProfileId?.(null);
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
            this.yangApp?.setActiveProfileId?.(null);
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
            if (this.closing) this.assertProfileAvailable(input.id);
            const requestedGeneration = input.id ? this.assertProfileAvailable(input.id) : undefined;
            const profiles = this.getStoredProfiles();
            const index = input.id ? profiles.findIndex(profile => profile.id === input.id) : -1;
            const existing = index >= 0 ? profiles[index] : null;
            const normalized = this.normalizeProfile(input, existing);
            this.assertProfileAvailable(normalized.id, requestedGeneration);
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
        const id = String(profileId || '');
        if (!id) return errorResponse('缺少连接ID');
        if (this.closing) return errorResponse('NETCONF 服务正在关闭');
        if (this.deletingProfiles.has(id)) return errorResponse('连接 Profile 正在删除');
        this.beginProfileDeletion(id);
        const deletionPromise = (async () => {
            const pending = [];
            for (const task of this.taskManager.tasks.values()) {
                if (task.status === 'running' && task.metadata?.profileId === id) {
                    this.taskManager.cancel(task.taskId);
                    if (task.promise) pending.push(task.promise);
                }
            }
            await Promise.allSettled(pending);
            if (this.workerClient) await this.disconnectProfile(event, id);
            await this.yangApp?.deleteProfileWorkspace?.(id, event);
            this.saveStoredProfiles(this.getStoredProfiles().filter(profile => profile.id !== id));
            this.transientSecrets.delete(id);
            this.inventories.delete(id);
            return successResponse(null, '连接配置已删除');
        })();
        this.profileDeletionPromises.set(id, deletionPromise);
        try {
            return await deletionPromise;
        } catch (error) {
            return errorResponse('删除连接失败: ' + error.message);
        } finally {
            if (this.profileDeletionPromises.get(id) === deletionPromise) this.profileDeletionPromises.delete(id);
            this.deletingProfiles.delete(id);
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
            const requestedId = profile && typeof profile === 'object' ? profile.id : profile || this.activeProfileId;
            const requestedGeneration = requestedId ? this.assertProfileAvailable(requestedId) : undefined;
            const runtime = this.resolveRuntimeProfile(profile);
            const generation = this.assertProfileAvailable(runtime.id, requestedGeneration);
            if (runtime.privateKeyPath && !fs.existsSync(runtime.privateKeyPath)) throw new Error('私钥文件不存在');
            const result = await this.ensureWorker(event).sendRequest(NETCONF_REQ_TYPES.TEST_CONNECTION, runtime, {
                timeoutMs: runtime.connectTimeout + runtime.rpcTimeout + 5000
            });
            this.assertProfileAvailable(runtime.id, generation);
            return successResponse({ ...result.data, latency: Date.now() - startedAt }, 'NETCONF连接测试成功');
        } catch (error) {
            logger.error('NETCONF连接测试失败:', error.message);
            return errorResponse('连接测试失败: ' + error.message, { code: error.code });
        }
    }

    async handleConnect(event, profileOrId) {
        try {
            const requestedId =
                profileOrId && typeof profileOrId === 'object'
                    ? profileOrId.id
                    : profileOrId || this.activeProfileId;
            const requestedGeneration = requestedId ? this.assertProfileAvailable(requestedId) : undefined;
            const runtime = this.resolveRuntimeProfile(profileOrId);
            const generation = this.assertProfileAvailable(runtime.id, requestedGeneration);
            const client = this.ensureWorker(event);
            const result = await client.sendRequest(NETCONF_REQ_TYPES.CONNECT, runtime, {
                timeoutMs: runtime.connectTimeout + runtime.rpcTimeout + 5000
            });
            try {
                this.assertProfileAvailable(runtime.id, generation);
            } catch (error) {
                await client
                    .sendRequest(NETCONF_REQ_TYPES.DISCONNECT, { profileId: runtime.id }, { timeoutMs: 10000 })
                    .catch(() => {});
                if (this.activeProfileId === runtime.id) {
                    this.activeProfileId = null;
                    this.yangApp?.setActiveProfileId?.(null);
                }
                throw error;
            }
            this.activeProfileId = runtime.id;
            this.yangApp?.setActiveProfileId?.(runtime.id);
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
        this.setWebContents(event);
        const result = await this.workerClient.sendRequest(
            NETCONF_REQ_TYPES.DISCONNECT,
            { profileId },
            { timeoutMs: 10000 }
        );
        if (this.activeProfileId === profileId) this.activeProfileId = null;
        if (!this.activeProfileId) this.yangApp?.setActiveProfileId?.(null);
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

    async discoverModules(event, profileId, expectedGeneration = undefined) {
        const id = this.resolveProfileId(profileId);
        const generation = this.assertProfileAvailable(id, expectedGeneration);
        const result = await this.ensureWorker(event).sendRequest(
            NETCONF_REQ_TYPES.DISCOVER_MODULES,
            { profileId: id },
            { timeoutMs: 120000 }
        );
        this.assertProfileAvailable(id, generation);
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

    inventoryDependencyCandidates(inventory, name, kind = '') {
        const candidates = [];
        for (const module of inventory?.modules || []) {
            const moduleName = module.name || module.identifier;
            const moduleKind = module.kind || (module.submodule || module.isSubmodule ? 'submodule' : 'module');
            if (moduleName === name && (!kind || moduleKind === kind)) candidates.push(module);
            for (const submodule of module.submodules || []) {
                const descriptor = {
                    ...submodule,
                    kind: 'submodule',
                    submodule: true,
                    parentModule: moduleName
                };
                if ((descriptor.name || descriptor.identifier) === name && (!kind || kind === 'submodule')) {
                    candidates.push(descriptor);
                }
            }
        }
        return candidates;
    }

    findInventoryDependency(inventory, name, revision = '', kind = '') {
        const candidates = this.inventoryDependencyCandidates(inventory, name, kind);
        if (revision) {
            const exact = candidates.find(module => (module.revision || module.version || '') === revision);
            return exact;
        }
        return candidates.sort((left, right) =>
            (right.revision || right.version || '').localeCompare(left.revision || left.version || '')
        )[0];
    }

    dependencyDescriptor(item, fallbackKind = 'module') {
        const descriptor = typeof item === 'string' ? { name: item } : item || {};
        const name = descriptor.name || descriptor.identifier || '';
        if (!name) return null;
        const kind = descriptor.kind || fallbackKind;
        const revision = descriptor.revision || descriptor.version || descriptor.revisionDate || '';
        return {
            name,
            revision,
            format: descriptor.format || 'yang',
            kind,
            submodule: kind === 'submodule'
        };
    }

    resolveDependency(inventory, item, fallbackKind = 'module') {
        const descriptor = this.dependencyDescriptor(item, fallbackKind);
        if (!descriptor) return null;
        return (
            this.findInventoryDependency(inventory, descriptor.name, descriptor.revision, descriptor.kind) || descriptor
        );
    }

    inventoryDeclaredDependencies(inventory, module) {
        const dependencies = [];
        const add = (item, kind) => {
            const target = this.resolveDependency(inventory, item, kind);
            if (target) dependencies.push(target);
        };
        (module.submodules || []).forEach(item => add(item, 'submodule'));
        (module.deviations || []).forEach(item => add(item, 'module'));
        return dependencies;
    }

    parsedDependencies(inventory, downloaded) {
        return (downloaded.dependencies || [])
            .map(item => this.resolveDependency(inventory, item, item.kind === 'submodule' ? 'submodule' : 'module'))
            .filter(Boolean);
    }

    async handleDownloadModules(event, request = {}) {
        try {
            this.setWebContents(event);
            const profileId = this.resolveProfileId(request);
            const profileGeneration = this.assertProfileAvailable(profileId);
            const task = this.taskManager.start(
                'download',
                async ({ signal, report }) => {
                    this.assertProfileAvailable(profileId, profileGeneration);
                    let inventory = this.inventories.get(profileId);
                    if (!inventory) {
                        report({ phase: 'discovering', percent: 5, message: '正在读取设备YANG列表' });
                        inventory = await this.discoverModules(event, profileId, profileGeneration);
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
                    if (signal.aborted) {
                        throw new Error('YANG 下载已取消');
                    }
                    this.assertProfileAvailable(profileId, profileGeneration);
                    if (downloaded.length === 0) {
                        const detail = failed[0]?.error || '设备未返回模型内容';
                        throw new Error(`YANG下载失败: ${detail}`);
                    }
                    report({ phase: 'importing', percent: 85, message: '正在写入本地YANG仓库' });
                    const imported = this.yangApp
                        ? await this.yangApp.importDownloadedContents(downloaded, {
                              profileId,
                              inventory
                          }, event)
                        : { downloaded };
                    this.assertProfileAvailable(profileId, profileGeneration);
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
            const generation = this.assertProfileAvailable(profileId);
            const result = await this.ensureWorker(event).sendRequest(
                NETCONF_REQ_TYPES.EXECUTE_OPERATION,
                { ...request, profileId },
                { timeoutMs: Number(request.timeout) || 120000 }
            );
            this.assertProfileAvailable(profileId, generation);
            return successResponse(result.data, 'NETCONF操作完成');
        } catch (error) {
            return errorResponse('NETCONF操作失败: ' + error.message, { code: error.code, details: error.data });
        }
    }

    async handleSendRpc(event, request = {}) {
        try {
            const profileId = this.resolveProfileId(request);
            const generation = this.assertProfileAvailable(profileId);
            const result = await this.ensureWorker(event).sendRequest(
                NETCONF_REQ_TYPES.SEND_RPC,
                { ...request, profileId },
                { timeoutMs: Number(request.timeout) || 120000 }
            );
            this.assertProfileAvailable(profileId, generation);
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
        if (this.closePromise) return this.closePromise;
        const closePromise = (async () => {
            this.closing = true;
            const pendingTasks = [];
            for (const task of this.taskManager.tasks.values()) {
                if (task.status !== 'running') continue;
                this.taskManager.cancel(task.taskId);
                if (task.promise) pendingTasks.push(task.promise);
            }
            await Promise.allSettled(pendingTasks);
            await Promise.allSettled([...this.profileDeletionPromises.values()]);

            const worker = this.workerClient;
            if (worker) {
                try {
                    await worker.sendRequest(NETCONF_REQ_TYPES.DISCONNECT_ALL, null, { timeoutMs: 10000 });
                } catch (error) {
                    logger.warn('关闭NETCONF会话失败:', error.message);
                } finally {
                    await worker.terminate();
                    if (this.workerClient === worker) this.workerClient = null;
                }
            }
            this.activeProfileId = null;
            this.yangApp?.setActiveProfileId?.(null);
            this.deletingProfiles.clear();
            this.profileDeletionPromises.clear();
            this.eventDispatcher.cleanup();
        })();
        this.closePromise = closePromise;
        try {
            await closePromise;
        } finally {
            this.closing = false;
            if (this.closePromise === closePromise) this.closePromise = null;
        }
    }
}

module.exports = NetconfApp;
