'use strict';

const TaskManager = require('../../utils/taskManager');
const { NETCONF_REQ_TYPES, NETCONF_LIMITS } = require('../../const/yangConst');

const INITIAL_PASSWORD_CHANGE_REQUIRED_CODE = 'NETCONF_INITIAL_PASSWORD_CHANGE_REQUIRED';

class YangDownloadService {
    constructor(options = {}) {
        this.netconfService = options.netconfService;
        this.runtimeHost = options.runtimeHost || null;
        this.validateProfile = typeof options.validateProfile === 'function' ? options.validateProfile : () => {};
        this.inventories = new Map();
        this.importDownloadedContents =
            options.importDownloadedContents ||
            ((contents, importOptions) =>
                this.runtimeHost.runtime.importDownloadedContents(contents, importOptions, {
                    sender: this.runtimeHost.eventTarget
                }));
        this.getWorkspaceGeneration =
            options.getWorkspaceGeneration || (request => this.runtimeHost.getWorkspaceGeneration(request));
        this.taskManager = new TaskManager({
            onProgress: progress => {
                if (typeof options.onProgress === 'function') options.onProgress(progress);
                else this.runtimeHost?.runtime?.emitTaskProgress?.(progress);
            }
        });
    }

    requireProfileId(request = {}) {
        const value = request && typeof request === 'object' ? request.profileId : request;
        const profileId = String(value || this.runtimeHost?.runtime?.activeProfileId || '');
        if (!profileId) {
            const error = new Error('请先连接NETCONF设备');
            error.code = 'NETCONF_PROFILE_REQUIRED';
            throw error;
        }
        this.validateProfile(profileId);
        return profileId;
    }

    cancelledError() {
        const error = new Error('YANG 下载已取消');
        error.code = 'WORKER_CANCELLED';
        return error;
    }

    assertNotCancelled(signal) {
        if (signal?.aborted) throw this.cancelledError();
    }

    rememberInventory(profileId, inventory) {
        const normalized = inventory || { modules: [] };
        this.inventories.set(String(profileId), normalized);
        return normalized;
    }

    async discoverModules(profileId, context = {}) {
        const id = this.requireProfileId(profileId);
        const inventory = await this.netconfService.dispatch(
            NETCONF_REQ_TYPES.DISCOVER_MODULES,
            { profileId: id },
            context
        );
        this.requireProfileId(id);
        return this.rememberInventory(id, inventory);
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
        this.requireProfileId(profileId);
        this.assertNotCancelled(signal);
        const result = await this.netconfService.dispatch(NETCONF_REQ_TYPES.GET_SCHEMA, { profileId, module });
        this.requireProfileId(profileId);
        this.assertNotCancelled(signal);
        const content = result?.content ?? result?.schema ?? result;
        if (typeof content !== 'string' || !content.trim()) throw new Error('设备返回了空的YANG模型');
        if (Buffer.byteLength(content, 'utf8') > NETCONF_LIMITS.MAX_SCHEMA_BYTES) {
            throw new Error('设备返回的YANG模型超过大小限制');
        }
        return {
            content,
            expectedName: module.name || module.identifier,
            revision: module.revision || module.version || '',
            fileName: `${module.name || module.identifier}${module.revision || module.version ? `@${module.revision || module.version}` : ''}.yang`,
            source: result?.source || `netconf://${profileId}/${module.name || module.identifier}`,
            dependencies: Array.isArray(result?.dependencies) ? result.dependencies : []
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
            return candidates.find(module => (module.revision || module.version || '') === revision);
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

    downloadErrorText(error) {
        const rpcErrors = Array.isArray(error?.errors)
            ? error.errors
            : Array.isArray(error?.data?.errors)
              ? error.data.errors
              : [];
        return [
            error?.message,
            error?.data?.message,
            ...rpcErrors.flatMap(item => [item?.message, item?.tag, item?.appTag, item?.path])
        ]
            .map(value => String(value || '').trim())
            .filter(Boolean)
            .join(' ');
    }

    isInitialPasswordChangeError(error) {
        const text = this.downloadErrorText(error);
        return (
            error?.code === INITIAL_PASSWORD_CHANGE_REQUIRED_CODE ||
            (/initial\s+password/iu.test(text) && /change/iu.test(text)) ||
            (/初始密码/u.test(text) && /(修改|更改|变更)/u.test(text))
        );
    }

    downloadFailure(module, error) {
        const initialPassword = this.isInitialPasswordChangeError(error);
        const rpcErrors = Array.isArray(error?.errors)
            ? error.errors
            : Array.isArray(error?.data?.errors)
              ? error.data.errors
              : [];
        const details = rpcErrors.length
            ? rpcErrors.map(item => ({
                  type: item?.type || '',
                  tag: item?.tag || '',
                  severity: item?.severity || '',
                  appTag: item?.appTag || '',
                  path: item?.path || '',
                  message: item?.message || ''
              }))
            : [];
        return {
            name: module.name || module.identifier,
            revision: module.revision || module.version || '',
            error: initialPassword
                ? '设备要求先修改初始密码；已停止后续下载，请通过 STelnet 或 Console 修改密码后重试'
                : error?.message || String(error),
            code: initialPassword ? INITIAL_PASSWORD_CHANGE_REQUIRED_CODE : error?.code || 'YANG_DOWNLOAD_FAILED',
            ...(details.length ? { details } : {})
        };
    }

    startDownload(request = {}) {
        const profileId = this.requireProfileId(request);
        const workspaceGeneration = this.getWorkspaceGeneration({ profileId });
        return this.taskManager.start(
            'download',
            async ({ signal, report }) => {
                this.assertNotCancelled(signal);
                let inventory = this.inventories.get(profileId);
                if (!inventory) {
                    report({ phase: 'discovering', percent: 5, message: '正在读取设备YANG列表' });
                    inventory = await this.discoverModules(profileId);
                }
                this.assertNotCancelled(signal);
                const selected = this.selectInventoryModules(inventory, request.modules);
                if (selected.length === 0) throw new Error('没有匹配的YANG模型可下载');
                const downloaded = [];
                const failed = [];
                let stopReason = null;
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
                    selected.flatMap(module => this.inventoryDeclaredDependencies(inventory, module)).forEach(enqueue);
                }
                for (let index = 0; index < queue.length; index += 1) {
                    this.assertNotCancelled(signal);
                    const module = queue[index];
                    report({
                        phase: 'downloading',
                        percent: 10 + Math.round((index / Math.max(1, queue.length)) * 70),
                        completed: index,
                        total: queue.length,
                        module: module.name || module.identifier,
                        counts: { downloaded: downloaded.length, failed: failed.length }
                    });
                    try {
                        const item = await this.downloadOne(profileId, module, signal);
                        downloaded.push(item);
                        if (request.includeDependencies !== false) {
                            this.parsedDependencies(inventory, item).forEach(enqueue);
                            this.inventoryDeclaredDependencies(inventory, module).forEach(enqueue);
                        }
                    } catch (error) {
                        if (signal.aborted) throw this.cancelledError();
                        const failure = this.downloadFailure(module, error);
                        failed.push(failure);
                        if (failure.code === INITIAL_PASSWORD_CHANGE_REQUIRED_CODE) {
                            stopReason = failure;
                            break;
                        }
                    }
                }
                this.assertNotCancelled(signal);
                if (downloaded.length === 0) {
                    const initialPasswordRequired = stopReason?.code === INITIAL_PASSWORD_CHANGE_REQUIRED_CODE;
                    const detail = initialPasswordRequired
                        ? '设备要求先修改初始密码；本次 get-schema 没有返回任何模型。请先通过 STelnet 或 Console 修改密码，再更新连接 Profile 后重试'
                        : failed[0]?.error || '设备未返回模型内容';
                    report({
                        phase: 'downloading',
                        percent: 100,
                        completed: failed.length,
                        total: queue.length,
                        message: detail,
                        counts: { downloaded: 0, failed: failed.length }
                    });
                    const error = new Error(`YANG下载失败: ${detail}`);
                    error.code = stopReason?.code || 'YANG_DOWNLOAD_FAILED';
                    throw error;
                }
                report({
                    phase: 'importing',
                    percent: 85,
                    message: '正在写入本地YANG仓库',
                    counts: { downloaded: downloaded.length, failed: failed.length }
                });
                const imported = await this.importDownloadedContents(downloaded, {
                    profileId,
                    inventory,
                    workspaceGeneration
                });
                this.assertNotCancelled(signal);
                const importFailures = Array.isArray(imported?.failed)
                    ? imported.failed.map(item => ({
                          name: item.expectedName || item.name || '未知模型',
                          revision: item.revision || '',
                          error: item.error || item.message || '写入本地YANG仓库失败',
                          code: item.code || 'YANG_IMPORT_FAILED'
                      }))
                    : [];
                failed.push(...importFailures);
                const persisted = Math.max(
                    0,
                    Number(imported?.summary?.imported ?? downloaded.length - importFailures.length) || 0
                );
                if (persisted === 0) {
                    const error = new Error('YANG下载成功，但没有模型能够写入本地YANG仓库');
                    error.code = 'YANG_DOWNLOAD_PERSIST_FAILED';
                    throw error;
                }
                const attempted = downloaded.length + failed.length - importFailures.length;
                const unattempted = Math.max(0, queue.length - attempted);
                const partial = failed.length > 0;
                const finalMessage = stopReason
                    ? [
                          `已保存 ${persisted} 个模型`,
                          `${failed.length} 个失败`,
                          unattempted ? `${unattempted} 个未尝试` : '',
                          '请先修改设备初始密码后重试'
                      ]
                          .filter(Boolean)
                          .join('，')
                    : partial
                      ? `已保存 ${persisted} 个模型，${failed.length} 个失败`
                      : `已保存 ${persisted} 个模型`;
                report({
                    phase: 'importing',
                    percent: 99,
                    completed: attempted,
                    total: queue.length,
                    message: finalMessage,
                    counts: { downloaded: persisted, failed: failed.length }
                });
                return {
                    profileId,
                    downloaded: downloaded.length,
                    persisted,
                    attempted,
                    unattempted,
                    total: queue.length,
                    partial,
                    stoppedEarly: Boolean(stopReason),
                    stopReason,
                    failed,
                    imported
                };
            },
            { profileId }
        );
    }

    getTask(taskId) {
        return this.taskManager.get(taskId);
    }

    cancelTask(taskId) {
        return this.taskManager.cancel(taskId);
    }

    abortProfile(profileId, options = {}) {
        const id = String(profileId || '');
        const pending = [];
        for (const task of this.taskManager.tasks.values()) {
            if (task.status !== 'running' || String(task.metadata?.profileId || '') !== id) continue;
            this.taskManager.cancel(task.taskId);
            if (task.promise) pending.push(task.promise);
        }
        if (options.keepInventory !== true) this.inventories.delete(id);
        return pending;
    }

    abortAll() {
        const pending = [];
        for (const task of this.taskManager.tasks.values()) {
            if (task.status !== 'running') continue;
            this.taskManager.cancel(task.taskId);
            if (task.promise) pending.push(task.promise);
        }
        this.inventories.clear();
        return pending;
    }

    async cancelProfile(profileId, options = {}) {
        const pending = this.abortProfile(profileId, options);
        if (options.wait !== false) await Promise.allSettled(pending);
    }

    async close() {
        const pending = this.abortAll();
        await Promise.allSettled(pending);
    }
}

module.exports = YangDownloadService;
module.exports.INITIAL_PASSWORD_CHANGE_REQUIRED_CODE = INITIAL_PASSWORD_CHANGE_REQUIRED_CODE;
