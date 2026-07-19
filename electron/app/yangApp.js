const path = require('path');
const { createHash } = require('crypto');
const { app, BrowserWindow, dialog } = require('electron');
const logger = require('../log/logger');
const EventDispatcher = require('../utils/eventDispatcher');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const TaskManager = require('../utils/taskManager');
const RequestWorkerClient = require('../worker/core/requestWorkerClient');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const { YANG_REQ_TYPES: WORKER_REQ_TYPES, YANG_EVT_TYPES: WORKER_EVT_TYPES } = require('../utils/yang');
const { YANG_EVT_TYPES } = require('../const/yangConst');

const CONFIGURATION_WORKSPACE_ID = 'default';
const STATE_STORE_KEY = 'yang-profile-workspace-states';
const STATE_SCHEMA_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT = 120000;
const MAX_PROFILE_ID_BYTES = 1024;
const PROFILE_WORKSPACE_ID_RE = /^profile-[a-f0-9]{64}$/u;
const LIFECYCLE_ERROR_CODES = new Set([
    'WORKER_CANCELLED',
    'WORKER_EXIT',
    'WORKER_TERMINATED',
    'YANG_APP_CLOSED',
    'YANG_APP_CLOSING'
]);

function profileWorkspaceId(profileId) {
    const value = String(profileId ?? '');
    const containsControlCharacter = [...value].some(character => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 0x1f || codePoint === 0x7f;
    });
    if (!value || /^\s+$/u.test(value) || containsControlCharacter || Buffer.byteLength(value) > MAX_PROFILE_ID_BYTES) {
        throw new Error('缺少有效的 NETCONF Profile ID');
    }
    return `profile-${createHash('sha256').update(value, 'utf8').digest('hex')}`;
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
        this.workerClient = null;
        this.configurePromise = null;
        this.progressReporters = new Map();
        this.eventDispatcher = new EventDispatcher();
        this.activeProfileId = null;
        this.lastCompile = this.readStoredState();
        this.compileResult = new Map();
        this.compilationRestorePromises = new Map();
        this.deletingWorkspaces = new Set();
        this.closing = false;
        this.closed = false;
        this.closePromise = null;
        this.lifecycleGeneration = 0;
        this.retiredWebContents = new WeakSet();
        this.logLevel = null;
        this.taskManager = new TaskManager({
            onProgress: progress => this.emitTaskProgress(progress)
        });
        this.registerIpcHandlers();
    }

    registerIpcHandlers() {
        const handle = (channel, handler) => this.ipcMain.handle(channel, handler.bind(this));
        handle('yang:listModules', this.handleListModules);
        handle('yang:selectFiles', this.handleSelectFiles);
        handle('yang:selectDirectory', this.handleSelectDirectory);
        handle('yang:importFiles', this.handleImportFiles);
        handle('yang:importDirectory', this.handleImportDirectory);
        handle('yang:compile', this.handleCompile);
        handle('yang:getCompilerStatus', this.handleGetCompilerStatus);
        handle('yang:clearWorkspace', this.handleClearWorkspace);
        handle('yang:getWorkspace', this.handleGetWorkspace);
        handle('yang:getSchemaRoots', this.handleGetSchemaRoots);
        handle('yang:getSchemaChildren', this.handleGetSchemaChildren);
        handle('yang:getSchemaNode', this.handleGetSchemaNode);
        handle('yang:validateRpc', this.handleValidateRpc);
        handle('yang:getModuleSource', this.handleGetModuleSource);
        handle('yang:getDiagnostics', this.handleGetDiagnostics);
    }

    setWebContents(event) {
        const sender = event?.sender;
        if (sender && !sender.isDestroyed?.()) this.eventDispatcher.setWebContents(sender);
    }

    emitTaskProgress(progress) {
        if (!this.eventDispatcher.canEmit()) return;
        const profileId = progress?.metadata?.profileId || null;
        const workspaceId = progress?.metadata?.workspaceId || null;
        this.eventDispatcher.emit(
            YANG_EVT_TYPES.TASK_PROGRESS,
            successResponse({ ...progress, profileId, workspaceId }, 'YANG任务进度')
        );
    }

    readStoredState() {
        try {
            const stored = this.store?.get(STATE_STORE_KEY, null);
            if (stored?.schemaVersion !== STATE_SCHEMA_VERSION || !stored.workspaces) return new Map();
            return new Map(
                Object.entries(stored.workspaces).filter(
                    ([workspaceId, state]) =>
                        PROFILE_WORKSPACE_ID_RE.test(workspaceId) &&
                        state &&
                        typeof state === 'object' &&
                        !Array.isArray(state)
                )
            );
        } catch (_error) {
            return new Map();
        }
    }

    writeStoredState() {
        if (!this.store) return;
        this.store.set(STATE_STORE_KEY, {
            schemaVersion: STATE_SCHEMA_VERSION,
            workspaces: Object.fromEntries(this.lastCompile)
        });
    }

    persistCompileState(workspaceId, result, workspace) {
        const state = result
            ? {
                  compileId: result.compileId,
                  contentHash: result.contentHash,
                  contextHash: result.contextHash,
                  compiledAt: result.compiledAt,
                  success: result.success,
                  schemaAvailable: result.schemaAvailable === true,
                  partialSchema: result.partialSchema === true,
                  summary: result.summary || {},
                  moduleHashes: result.moduleHashes || result.modules?.map(module => module.hash).filter(Boolean) || [],
                  schemaModuleHashes: Array.isArray(result.schemaModuleHashes) ? [...result.schemaModuleHashes] : [],
                  excludedModuleHashes: Array.isArray(result.excludedModuleHashes)
                      ? [...result.excludedModuleHashes]
                      : [],
                  fileResults: Array.isArray(result.fileResults)
                      ? result.fileResults.map(fileResult => ({ ...fileResult }))
                      : undefined,
                  restoreOptions: result.restoreOptions || {},
                  workspaceContentHash: workspace?.contentHash || null
              }
            : null;
        if (state) this.lastCompile.set(workspaceId, state);
        else this.lastCompile.delete(workspaceId);
        this.writeStoredState();
    }

    invalidateCompilation(workspaceId) {
        if (!workspaceId) {
            this.compileResult.clear();
            this.lastCompile.clear();
            this.compilationRestorePromises.clear();
            this.store?.delete(STATE_STORE_KEY);
            return;
        }
        this.compileResult.delete(workspaceId);
        this.persistCompileState(workspaceId, null, null);
    }

    setActiveProfileId(profileId) {
        this.activeProfileId = profileId ? String(profileId) : null;
    }

    profileWorkspaceId(profileId) {
        return profileWorkspaceId(profileId);
    }

    resolveProfileContext(request = {}) {
        const payload = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
        const profileId = String(payload.profileId ?? this.activeProfileId ?? '');
        return { profileId, workspaceId: profileWorkspaceId(profileId) };
    }

    assertWorkspaceAvailable(workspaceId) {
        if (this.deletingWorkspaces.has(workspaceId)) throw new Error('该 Profile 工作区正在删除');
    }

    lifecycleError(code, message) {
        const error = new Error(message);
        error.code = code;
        return error;
    }

    assertLifecycleAvailable(event) {
        if (this.closing) throw this.lifecycleError('YANG_APP_CLOSING', 'YANG 服务正在关闭');
        if (!this.closed) return;
        const sender = event?.sender;
        if (sender && typeof sender === 'object' && !sender.isDestroyed?.() && !this.retiredWebContents.has(sender)) {
            this.closed = false;
            return;
        }
        throw this.lifecycleError('YANG_APP_CLOSED', 'YANG 服务已关闭');
    }

    isLifecycleInterruption(error, generation) {
        return (
            generation !== this.lifecycleGeneration ||
            this.closing ||
            this.closed ||
            LIFECYCLE_ERROR_CODES.has(error?.code)
        );
    }

    ensureWorker(event) {
        this.assertLifecycleAvailable(event);
        this.setWebContents(event);
        if (this.workerClient) return this.workerClient;
        const client = new RequestWorkerClient(resolveWorkerPath('yang/yangCompilerWorker.js'), {
            defaultTimeoutMs: DEFAULT_REQUEST_TIMEOUT
        });
        client.on('event', (eventName, data = {}) => {
            if (![WORKER_EVT_TYPES.COMPILE_PROGRESS, WORKER_EVT_TYPES.IMPORT_PROGRESS].includes(eventName)) return;
            const reporter = this.progressReporters.get(data.progressId);
            if (reporter) reporter(data);
        });
        client.on('exit', () => {
            if (this.workerClient === client) {
                this.workerClient = null;
                this.configurePromise = null;
                this.progressReporters.clear();
            }
        });
        this.workerClient = client;
        this.configurePromise = client
            .sendRequest(
                WORKER_REQ_TYPES.CONFIGURE,
                {
                    rootDir: this.rootDir,
                    workspaceId: CONFIGURATION_WORKSPACE_ID,
                    compilerPath: this.compilerPath,
                    compilerArgs: this.compilerArgs,
                    schemaHelperPath: this.schemaHelperPath,
                    schemaHelperArgs: this.schemaHelperArgs,
                    resourcesPath: this.resourcesPath,
                    isPackaged: this.isPackaged
                },
                { timeoutMs: 30000 }
            )
            .catch(async error => {
                if (this.workerClient === client) this.workerClient = null;
                this.configurePromise = null;
                await client.terminate().catch(() => {});
                throw error;
            });
        return client;
    }

    async send(event, operation, data = {}, options = {}) {
        const client = this.ensureWorker(event);
        await this.configurePromise;
        const response = await client.sendRequest(operation, data, {
            timeoutMs: options.timeoutMs || DEFAULT_REQUEST_TIMEOUT,
            signal: options.signal
        });
        return response.data;
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

    normalizeModule(entry, compiledHashes = new Set(), failedHashes = new Set()) {
        const metadata = entry?.metadata || {};
        const hash = entry?.hash || entry?.contentHash || entry?.id || '';
        const diagnostics = Array.isArray(entry?.diagnostics) ? entry.diagnostics : [];
        const hasErrors = diagnostics.some(item => item.severity === 'error');
        return {
            ...entry,
            id: hash,
            moduleId: hash,
            hash,
            contentHash: hash,
            name: metadata.name || entry?.name || entry?.fileName || hash,
            revision: metadata.revision || entry?.revision || '',
            namespace: metadata.namespace || entry?.namespace || '',
            features: metadata.features || entry?.features || [],
            deviations: metadata.deviations || entry?.deviations || [],
            imports: metadata.imports || entry?.imports || [],
            includes: metadata.includes || entry?.includes || [],
            kind: metadata.kind || entry?.kind || 'module',
            submodule: (metadata.kind || entry?.kind) === 'submodule',
            isSubmodule: (metadata.kind || entry?.kind) === 'submodule',
            isLocal: true,
            localPath: entry?.filePath || '',
            filePath: entry?.filePath || '',
            status: hasErrors ? 'failed' : 'downloaded',
            compileStatus: compiledHashes.has(hash)
                ? 'compiled'
                : failedHashes.has(hash) || hasErrors
                  ? 'failed'
                  : 'pending',
            compiled: compiledHashes.has(hash),
            diagnosticCount: diagnostics.length
        };
    }

    compiledHashes(workspaceId) {
        return new Set(
            this.compilationFileResults(workspaceId)
                .filter(fileResult => fileResult.status === 'compiled')
                .map(fileResult => fileResult.hash)
        );
    }

    failedCompileHashes(workspaceId) {
        return new Set(
            this.compilationFileResults(workspaceId)
                .filter(fileResult => fileResult.status === 'failed')
                .map(fileResult => fileResult.hash)
        );
    }

    compilationFileResults(workspaceId) {
        const result = this.compileResult.get(workspaceId);
        const stored = this.lastCompile.get(workspaceId);
        const compilation = result || stored;
        if (!compilation) return [];
        if (Array.isArray(compilation.fileResults)) {
            return compilation.fileResults.filter(
                fileResult => fileResult?.hash && ['compiled', 'failed'].includes(fileResult.status)
            );
        }
        const fallbackStatus = compilation.success === true ? 'compiled' : 'failed';
        return (compilation.moduleHashes || []).map(hash => ({ hash, status: fallbackStatus }));
    }

    async listRawModules(event, query = {}) {
        return this.send(event, WORKER_REQ_TYPES.LIST_MODULES, query || {});
    }

    async handleListModules(event, query = {}) {
        try {
            const context = this.resolveProfileContext(query);
            const payload = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
            const workspace = await this.send(event, WORKER_REQ_TYPES.GET_WORKSPACE, {
                workspaceId: context.workspaceId
            });
            this.reconcileCompilationFreshness(context.workspaceId, workspace);
            const modules = await this.listRawModules(event, { ...payload, workspaceId: context.workspaceId });
            const compiled = this.compiledHashes(context.workspaceId);
            const failed = this.failedCompileHashes(context.workspaceId);
            return successResponse(modules.map(module => this.normalizeModule(module, compiled, failed)));
        } catch (error) {
            return errorResponse('获取YANG模型失败: ' + error.message);
        }
    }

    startImportTask(event, type, operation, data, context) {
        this.setWebContents(event);
        this.assertWorkspaceAvailable(context.workspaceId);
        return this.taskManager.start(
            'import',
            async ({ taskId, signal, report }) => {
                this.progressReporters.set(taskId, report);
                report({ phase: 'importing', percent: 1, message: '正在导入YANG模型' });
                try {
                    const result = await this.send(
                        event,
                        operation,
                        {
                            ...data,
                            workspaceId: context.workspaceId,
                            workspaceMetadata: { profileId: context.profileId },
                            progressId: taskId
                        },
                        { timeoutMs: 10 * 60 * 1000, signal }
                    );
                    this.reconcileCompilationFreshness(context.workspaceId, result?.workspace);
                    return result;
                } finally {
                    this.progressReporters.delete(taskId);
                }
            },
            { source: type, ...context }
        );
    }

    async handleImportFiles(event, input) {
        try {
            const options = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
            const context = this.resolveProfileContext(options);
            const requestedPaths = Array.isArray(input) ? input : options.filePaths || options.paths;
            const paths =
                Array.isArray(requestedPaths) && requestedPaths.length ? requestedPaths : await this.selectFiles(event);
            if (!paths.length) return successResponse({ cancelled: true, filePaths: [] }, '已取消导入');
            return successResponse(
                this.startImportTask(event, 'files', WORKER_REQ_TYPES.IMPORT_FILES, { filePaths: paths }, context),
                'YANG导入任务已开始'
            );
        } catch (error) {
            return errorResponse('启动YANG文件导入失败: ' + error.message);
        }
    }

    async handleImportDirectory(event, input) {
        try {
            const options = input && typeof input === 'object' ? input : {};
            const context = this.resolveProfileContext(options);
            const requestedPath = typeof input === 'string' ? input : options.directoryPath || options.path;
            const selected =
                typeof requestedPath === 'string' && requestedPath ? requestedPath : await this.selectDirectory(event);
            if (!selected) return successResponse({ cancelled: true }, '已取消导入');
            return successResponse(
                this.startImportTask(
                    event,
                    'directory',
                    WORKER_REQ_TYPES.IMPORT_DIRECTORY,
                    {
                        directoryPath: selected,
                        recursive: true
                    },
                    context
                ),
                'YANG目录导入任务已开始'
            );
        } catch (error) {
            return errorResponse('启动YANG目录导入失败: ' + error.message);
        }
    }

    async importDownloadedContents(contents, options = {}, event = null) {
        const context = this.resolveProfileContext(options);
        this.assertWorkspaceAvailable(context.workspaceId);
        const result = await this.send(event, WORKER_REQ_TYPES.IMPORT_CONTENTS, {
            contents,
            workspaceId: context.workspaceId,
            workspaceMetadata: {
                profileId: context.profileId,
                discoveredAt: options.inventory?.discoveredAt || new Date().toISOString()
            }
        });
        this.reconcileCompilationFreshness(context.workspaceId, result?.workspace);
        return result;
    }

    resolveCompileHashes(requested, modules) {
        if (!Array.isArray(requested) || requested.length === 0) return null;
        const findModule = identity => {
            const value = typeof identity === 'string' ? { id: identity, name: identity } : identity || {};
            return modules.find(module => {
                const metadata = module.metadata || {};
                return (
                    [module.hash, module.id].includes(value.id || value.hash) ||
                    (metadata.name === value.name && (!value.revision || metadata.revision === value.revision))
                );
            });
        };
        const selected = requested.map(findModule).filter(Boolean);
        const byName = (kind, name, revision) =>
            modules
                .filter(module => module.metadata?.kind === kind && module.metadata?.name === name)
                .filter(module => !revision || module.metadata?.revision === revision)
                .sort((left, right) =>
                    (right.metadata?.revision || '').localeCompare(left.metadata?.revision || '')
                )[0];
        const hashes = new Set();
        const queue = [...selected];
        while (queue.length) {
            const module = queue.shift();
            if (!module?.hash || hashes.has(module.hash)) continue;
            hashes.add(module.hash);
            for (const dependency of module.metadata?.imports || []) {
                const target = byName('module', dependency.name, dependency.revisionDate);
                if (target && !hashes.has(target.hash)) queue.push(target);
            }
            for (const dependency of module.metadata?.includes || []) {
                const target = byName('submodule', dependency.name, dependency.revisionDate);
                if (target && !hashes.has(target.hash)) queue.push(target);
            }
            if (module.metadata?.kind === 'submodule' && module.metadata.belongsTo) {
                const target = byName('module', module.metadata.belongsTo);
                if (target && !hashes.has(target.hash)) queue.push(target);
            }
        }
        if (hashes.size === 0) throw new Error('没有匹配的本地YANG模型可编译');
        return [...hashes];
    }

    async handleCompile(event, options = {}) {
        try {
            this.setWebContents(event);
            const context = this.resolveProfileContext(options);
            this.assertWorkspaceAvailable(context.workspaceId);
            const compiler = await this.send(event, WORKER_REQ_TYPES.GET_COMPILER_STATUS, {
                forceRuntimeDiscovery: options.forceRuntimeDiscovery === true
            });
            if (!compiler.available) {
                const details = [compiler.error, compiler.installHint].filter(Boolean).join(' ');
                return errorResponse(`libyang/yanglint 权威编译器不可用${details ? `: ${details}` : ''}`);
            }
            const modules = await this.listRawModules(event, { workspaceId: context.workspaceId });
            if (!modules.length) return errorResponse('请先下载或导入YANG模型');
            const requestedHashes = this.resolveCompileHashes(
                options.hashes || options.moduleIds || options.modules,
                modules
            );
            const availableHashes = new Set(modules.map(module => module.hash).filter(Boolean));
            const stored = this.lastCompile.get(context.workspaceId);
            const storedModuleHashes = Array.isArray(stored?.moduleHashes)
                ? stored.moduleHashes.filter(hash => availableHashes.has(hash))
                : [];
            const canExtendStoredCompilation =
                requestedHashes &&
                options.replaceContext !== true &&
                storedModuleHashes.length > 0 &&
                storedModuleHashes.length === stored.moduleHashes.length;
            const hashes = canExtendStoredCompilation
                ? [...new Set([...storedModuleHashes, ...requestedHashes])]
                : requestedHashes;
            const task = this.taskManager.start(
                'compile',
                async ({ taskId, signal, report }) => {
                    this.progressReporters.set(taskId, progress => {
                        if (progress.phase !== 'completed') report(progress);
                    });
                    try {
                        const result = await this.send(
                            event,
                            WORKER_REQ_TYPES.COMPILE,
                            {
                                ...options,
                                workspaceId: context.workspaceId,
                                hashes: hashes || undefined,
                                progressId: taskId
                            },
                            { timeoutMs: 10 * 60 * 1000, signal }
                        );
                        const workspace = await this.send(event, WORKER_REQ_TYPES.GET_WORKSPACE, {
                            workspaceId: context.workspaceId
                        });
                        const compileResult = {
                            ...result,
                            moduleHashes:
                                result.moduleHashes ||
                                result.fileResults?.map(fileResult => fileResult.hash).filter(Boolean) ||
                                result.modules?.map(module => module.hash).filter(Boolean) ||
                                [],
                            restoreOptions: {
                                features: Array.isArray(options.features) ? options.features : [],
                                deviations: Array.isArray(options.deviations) ? options.deviations : [],
                                searchPaths: Array.isArray(options.searchPaths) ? options.searchPaths : undefined,
                                schemaSearchPaths: Array.isArray(options.schemaSearchPaths)
                                    ? options.schemaSearchPaths
                                    : undefined,
                                externalTimeout: options.externalTimeout,
                                externalMaxBuffer: options.externalMaxBuffer,
                                compilerPath: options.compilerPath,
                                compilerArgs: Array.isArray(options.compilerArgs) ? options.compilerArgs : undefined,
                                schemaHelperPath: options.schemaHelperPath,
                                schemaHelperArgs: Array.isArray(options.schemaHelperArgs)
                                    ? options.schemaHelperArgs
                                    : undefined
                            }
                        };
                        this.compileResult.set(context.workspaceId, compileResult);
                        this.persistCompileState(context.workspaceId, compileResult, workspace);
                        if (!result.success) {
                            const diagnostic = result.diagnostics?.find(
                                item => item.severity === 'error' && item.authoritative !== false
                            );
                            const error = new Error(diagnostic?.message || 'libyang权威编译未通过，请查看诊断');
                            error.code = diagnostic?.code || 'YANG_COMPILE_FAILED';
                            throw error;
                        }
                        return result;
                    } finally {
                        this.progressReporters.delete(taskId);
                    }
                },
                { ...context, moduleCount: hashes?.length || modules.length }
            );
            return successResponse(task, 'YANG编译任务已开始');
        } catch (error) {
            return errorResponse('启动YANG编译失败: ' + error.message);
        }
    }

    isStoredCompilationCurrent(workspaceId, workspace) {
        const stored = this.lastCompile.get(workspaceId);
        if (!stored?.compileId || !workspace) return false;
        const storedModuleHashes = Array.isArray(stored.moduleHashes) ? stored.moduleHashes.filter(Boolean) : [];
        if (storedModuleHashes.length > 0 && Array.isArray(workspace.modules)) {
            const workspaceModuleHashes = new Set(workspace.modules.map(module => module.hash).filter(Boolean));
            return storedModuleHashes.every(hash => workspaceModuleHashes.has(hash));
        }
        return Boolean(workspace.contentHash && stored.workspaceContentHash === workspace.contentHash);
    }

    reconcileCompilationFreshness(workspaceId, workspace) {
        const stored = this.lastCompile.get(workspaceId);
        if (stored && !this.isStoredCompilationCurrent(workspaceId, workspace)) {
            this.invalidateCompilation(workspaceId);
            return false;
        }
        const result = this.compileResult.get(workspaceId);
        if (result && (!stored || result.compileId !== stored.compileId)) {
            this.compileResult.delete(workspaceId);
        }
        return Boolean(stored);
    }

    async restoreStoredCompilation(event, context, workspace, requestedCompileId, options = {}) {
        const stored = this.lastCompile.get(context.workspaceId);
        if (!this.isStoredCompilationCurrent(context.workspaceId, workspace)) {
            throw new Error('当前工作区尚未编译');
        }
        const expected = requestedCompileId || stored.compileId;
        if (requestedCompileId && requestedCompileId !== stored.compileId) {
            throw new Error('指定的YANG编译上下文已失效');
        }
        const currentResult = this.compileResult.get(context.workspaceId);
        if (!options.forceWorkerRestore && currentResult?.compileId === expected) {
            return currentResult;
        }

        // The persisted compile ID identifies the exact source/option context. Do not include the
        // whole workspace content hash: additive imports may change it without invalidating the
        // stored Schema and must still share one in-flight restore.
        const restoreKey = `${context.workspaceId}\u0000${expected}`;
        const pending = this.compilationRestorePromises.get(restoreKey);
        if (pending) return pending;

        const restoreOptions =
            stored.restoreOptions && typeof stored.restoreOptions === 'object' && !Array.isArray(stored.restoreOptions)
                ? { ...stored.restoreOptions }
                : {};
        const hashes =
            Array.isArray(stored.moduleHashes) && stored.moduleHashes.length ? stored.moduleHashes : undefined;
        const restorePromise = (async () => {
            const restored = await this.send(
                event,
                WORKER_REQ_TYPES.COMPILE,
                {
                    ...restoreOptions,
                    workspaceId: context.workspaceId,
                    force: false,
                    hashes
                },
                { timeoutMs: 10 * 60 * 1000 }
            );
            const restoredModuleHashes =
                restored.moduleHashes ||
                restored.fileResults?.map(fileResult => fileResult.hash).filter(Boolean) ||
                restored.modules?.map(module => module.hash).filter(Boolean) ||
                [];
            const storedModuleHashes = Array.isArray(stored.moduleHashes) ? stored.moduleHashes.filter(Boolean) : [];
            if (
                storedModuleHashes.length > 0 &&
                JSON.stringify([...storedModuleHashes].sort()) !== JSON.stringify([...restoredModuleHashes].sort())
            ) {
                throw new Error('恢复后的YANG源文件集合与已保存的编译上下文不一致');
            }
            const restoredHasAuthoritativeSchema =
                restored.schemaAvailable === true &&
                restored.schemaTree?.authoritative === true &&
                restored.schemaTree?.source === 'libyang-effective';
            const storedExpectsSchema =
                stored.success === true ||
                stored.schemaAvailable === true ||
                Number(stored.summary?.schemaNodes || 0) > 0;
            if (
                (stored.success === true && restored.success !== true) ||
                (storedExpectsSchema && !restoredHasAuthoritativeSchema)
            ) {
                const diagnostic = restored.diagnostics?.find(
                    item => item.severity === 'error' && item.authoritative !== false
                );
                throw new Error(diagnostic?.message || '无法恢复已保存的libyang权威Schema缓存');
            }
            if (
                stored.schemaAvailable === true &&
                Array.isArray(stored.schemaModuleHashes) &&
                stored.schemaModuleHashes.length > 0 &&
                JSON.stringify([...stored.schemaModuleHashes].sort()) !==
                    JSON.stringify([...(restored.schemaModuleHashes || [])].sort())
            ) {
                throw new Error('恢复后的部分Schema模块集合与已保存的编译上下文不一致');
            }

            const latestWorkspace = await this.send(event, WORKER_REQ_TYPES.GET_WORKSPACE, {
                workspaceId: context.workspaceId
            });
            if (
                this.lastCompile.get(context.workspaceId) !== stored ||
                !this.isStoredCompilationCurrent(context.workspaceId, latestWorkspace)
            ) {
                throw new Error('YANG工作区在恢复编译上下文时已发生变化');
            }

            const compileResult = {
                ...restored,
                moduleHashes: restoredModuleHashes.length ? restoredModuleHashes : stored.moduleHashes || [],
                restoreOptions
            };
            this.compileResult.set(context.workspaceId, compileResult);
            this.persistCompileState(context.workspaceId, compileResult, latestWorkspace);
            return compileResult;
        })();
        this.compilationRestorePromises.set(restoreKey, restorePromise);
        try {
            return await restorePromise;
        } finally {
            if (this.compilationRestorePromises.get(restoreKey) === restorePromise) {
                this.compilationRestorePromises.delete(restoreKey);
            }
        }
    }

    async decorateWorkspace(event, context, workspace) {
        const current = this.isStoredCompilationCurrent(context.workspaceId, workspace)
            ? this.lastCompile.get(context.workspaceId)
            : null;
        const workspaceResult = this.compileResult.get(context.workspaceId);
        const result = workspaceResult?.compileId === current?.compileId ? workspaceResult : null;
        const fileResults = this.compilationFileResults(context.workspaceId);
        const compiled = new Set(
            fileResults.filter(fileResult => fileResult.status === 'compiled').map(fileResult => fileResult.hash)
        );
        const failed = new Set(
            fileResults.filter(fileResult => fileResult.status === 'failed').map(fileResult => fileResult.hash)
        );
        const rawModules = await this.listRawModules(event, { workspaceId: context.workspaceId });
        const modules = rawModules.map(module => this.normalizeModule(module, compiled, failed));
        const compiler = await this.send(event, WORKER_REQ_TYPES.GET_COMPILER_STATUS);
        const schemaAvailable = Boolean(
            result?.schemaTree?.authoritative === true || current?.schemaAvailable === true
        );
        const partialSchema = Boolean(result?.partialSchema === true || current?.partialSchema === true);
        return {
            profileId: context.profileId,
            workspaceId: workspace?.id || context.workspaceId,
            name: workspace?.name || context.workspaceId,
            createdAt: workspace?.createdAt || null,
            updatedAt: workspace?.updatedAt || null,
            contentHash: workspace?.contentHash || null,
            compileId: current?.compileId || '',
            compiledAt: current?.compiledAt || null,
            success: current?.success ?? null,
            schemaAvailable,
            partialSchema,
            schemaModuleHashes: result?.schemaModuleHashes || current?.schemaModuleHashes || [],
            excludedModuleHashes: result?.excludedModuleHashes || current?.excludedModuleHashes || [],
            compiler,
            modules,
            fileResults,
            diagnostics: result?.diagnostics || [],
            summary: {
                moduleCount: modules.length,
                nodeCount: result?.schemaTree?.nodeCount || current?.summary?.schemaNodes || 0,
                cacheHit: Boolean(current?.cacheHit),
                errors: current?.summary?.errors || 0,
                warnings: current?.summary?.warnings || 0,
                compiledFiles: fileResults.filter(fileResult => fileResult.status === 'compiled').length,
                failedFiles: fileResults.filter(fileResult => fileResult.status === 'failed').length
            },
            schemaTree: result?.schemaTree || null
        };
    }

    async handleGetWorkspace(event, query = {}) {
        const lifecycleGeneration = this.lifecycleGeneration;
        try {
            const context = this.resolveProfileContext(query);
            const workspace = await this.send(event, WORKER_REQ_TYPES.GET_WORKSPACE, {
                workspaceId: context.workspaceId
            });
            const stored = this.lastCompile.get(context.workspaceId);
            const storedIsCurrent = this.reconcileCompilationFreshness(context.workspaceId, workspace);
            const result = this.compileResult.get(context.workspaceId);
            let restoreError = '';
            const needsStoredResult =
                storedIsCurrent &&
                result?.compileId !== stored?.compileId &&
                (stored?.success === true ||
                    stored?.schemaAvailable === true ||
                    Number(stored?.summary?.schemaNodes || 0) > 0 ||
                    (stored?.success === false &&
                        Number(stored?.summary?.compiledFiles || 0) > 0 &&
                        Number(stored?.summary?.failedFiles || 0) > 0) ||
                    !Array.isArray(stored?.fileResults));
            if (needsStoredResult) {
                try {
                    await this.restoreStoredCompilation(event, context, workspace, stored.compileId);
                } catch (error) {
                    if (this.isLifecycleInterruption(error, lifecycleGeneration)) throw error;
                    logger.warn(`恢复YANG编译缓存失败 (${context.workspaceId}):`, error.message);
                    // A runtime discovery or cache migration failure can be transient during startup.
                    // Keep the persisted compilation descriptor so the workspace can retry instead of
                    // permanently losing its Schema tree after the first failed restore attempt.
                    if (this.lastCompile.get(context.workspaceId) === stored) restoreError = error.message;
                }
            }
            const decorated = await this.decorateWorkspace(event, context, workspace);
            if (restoreError) decorated.restoreError = restoreError;
            return successResponse(decorated);
        } catch (error) {
            return errorResponse('获取YANG工作区失败: ' + error.message);
        }
    }

    async handleGetCompilerStatus(event, options = {}) {
        try {
            const compiler = await this.send(event, WORKER_REQ_TYPES.GET_COMPILER_STATUS, {
                forceRuntimeDiscovery: options.force === true || options.forceRuntimeDiscovery === true
            });
            return successResponse(compiler, 'libyang编译器状态');
        } catch (error) {
            return errorResponse('获取libyang编译器状态失败: ' + error.message);
        }
    }

    async ensureCompilationLoaded(event, request = {}) {
        const context = this.resolveProfileContext(request);
        const workspace = await this.send(event, WORKER_REQ_TYPES.GET_WORKSPACE, {
            workspaceId: context.workspaceId
        });
        const stored = this.lastCompile.get(context.workspaceId);
        if (!this.isStoredCompilationCurrent(context.workspaceId, workspace)) throw new Error('当前工作区尚未编译');
        const requestedCompileId = request?.compileId;
        const expected = requestedCompileId || stored.compileId;
        if (requestedCompileId && requestedCompileId !== stored.compileId) {
            throw new Error('指定的YANG编译上下文已失效');
        }
        let loadedCompileId = expected;
        try {
            await this.send(event, WORKER_REQ_TYPES.GET_DIAGNOSTICS, {
                workspaceId: context.workspaceId,
                compileId: expected
            });
        } catch (_error) {
            const restored = await this.restoreStoredCompilation(event, context, workspace, expected, {
                forceWorkerRestore: true
            });
            loadedCompileId = restored.compileId;
        }
        return { ...context, compileId: loadedCompileId };
    }

    async handleClearWorkspace(event, request = {}) {
        try {
            this.setWebContents(event);
            const context = this.resolveProfileContext(request);
            this.invalidateCompilation(context.workspaceId);
            return successResponse(null, 'YANG编译工作区已清空');
        } catch (error) {
            return errorResponse('清空YANG工作区失败: ' + error.message);
        }
    }

    async handleGetSchemaRoots(event, query = {}) {
        return this.handleCompiledQuery(event, query, WORKER_REQ_TYPES.GET_SCHEMA_ROOTS, '获取Schema根节点失败');
    }

    async handleGetSchemaChildren(event, request = {}) {
        const normalized = { ...request, parentId: request.parentId || request.nodeId };
        return this.handleCompiledQuery(
            event,
            normalized,
            WORKER_REQ_TYPES.GET_SCHEMA_CHILDREN,
            '获取Schema子节点失败'
        );
    }

    async handleGetSchemaNode(event, request = {}) {
        return this.handleCompiledQuery(event, request, WORKER_REQ_TYPES.GET_SCHEMA_NODE, '获取Schema节点失败');
    }

    async handleGetDiagnostics(event, query = {}) {
        return this.handleCompiledQuery(event, query, WORKER_REQ_TYPES.GET_DIAGNOSTICS, '获取YANG诊断失败');
    }

    async handleValidateRpc(event, request = {}) {
        try {
            const payload = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
            const context = await this.ensureCompilationLoaded(event, payload);
            const result = await this.send(
                event,
                WORKER_REQ_TYPES.VALIDATE_RPC,
                { ...context, rpc: String(payload.rpc ?? '') },
                { timeoutMs: 60_000 }
            );
            return successResponse(result, result.valid ? 'RPC YANG校验通过' : 'RPC YANG校验未通过');
        } catch (error) {
            return errorResponse(`RPC YANG校验失败: ${error.message}`, {
                code: error.code || 'YANG_RPC_VALIDATION_FAILED'
            });
        }
    }

    async handleCompiledQuery(event, request, operation, errorPrefix) {
        try {
            const payload = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
            const context = await this.ensureCompilationLoaded(event, payload);
            return successResponse(await this.send(event, operation, { ...payload, ...context }));
        } catch (error) {
            return errorResponse(`${errorPrefix}: ${error.message}`);
        }
    }

    async handleGetModuleSource(event, request = {}) {
        try {
            const payload = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
            const context = this.resolveProfileContext(payload);
            const modules = await this.listRawModules(event, { workspaceId: context.workspaceId });
            const hash = payload.hash || payload.moduleId;
            const module = modules.find(entry => {
                if (hash) return entry.hash === hash;
                const metadata = entry.metadata || {};
                return (
                    metadata.name === payload.name &&
                    (!payload.revision || metadata.revision === payload.revision) &&
                    (!payload.kind || metadata.kind === payload.kind)
                );
            });
            if (!module) throw new Error('当前 Profile 工作区中不存在该 YANG 模型');
            return successResponse(
                await this.send(event, WORKER_REQ_TYPES.GET_MODULE_SOURCE, {
                    workspaceId: context.workspaceId,
                    hash: module.hash
                })
            );
        } catch (error) {
            return errorResponse('获取YANG源码失败: ' + error.message);
        }
    }

    async deleteProfileWorkspace(profileId, event = null) {
        const context = this.resolveProfileContext({ profileId });
        if (this.deletingWorkspaces.has(context.workspaceId)) throw new Error('该 Profile 工作区正在删除');
        this.deletingWorkspaces.add(context.workspaceId);
        try {
            const pending = [];
            for (const task of this.taskManager.tasks.values()) {
                if (
                    task.status === 'running' &&
                    (task.metadata?.profileId === context.profileId ||
                        task.metadata?.workspaceId === context.workspaceId)
                ) {
                    this.taskManager.cancel(task.taskId);
                    if (task.promise) pending.push(task.promise);
                }
            }
            await Promise.allSettled(pending);
            const deleted = await this.send(event, WORKER_REQ_TYPES.DELETE_WORKSPACE, {
                workspaceId: context.workspaceId
            });
            this.invalidateCompilation(context.workspaceId);
            for (const key of this.compilationRestorePromises.keys()) {
                if (key.startsWith(`${context.workspaceId}\u0000`)) this.compilationRestorePromises.delete(key);
            }
            return Boolean(deleted);
        } finally {
            this.deletingWorkspaces.delete(context.workspaceId);
        }
    }

    async handleLogLevelChange(logLevel) {
        this.logLevel = logLevel;
    }

    getRunning() {
        return this.taskManager.list().some(task => task.status === 'running');
    }

    async close() {
        if (this.closePromise) return this.closePromise;
        const closePromise = (async () => {
            this.closing = true;
            this.closed = false;
            this.lifecycleGeneration += 1;
            const sender = this.eventDispatcher.webContents;
            if (sender && typeof sender === 'object') this.retiredWebContents.add(sender);

            const pendingTasks = [];
            for (const task of this.taskManager.tasks.values()) {
                if (task.status !== 'running') continue;
                this.taskManager.cancel(task.taskId);
                if (task.promise) pendingTasks.push(task.promise);
            }
            await Promise.allSettled(pendingTasks);

            const worker = this.workerClient;
            this.workerClient = null;
            this.configurePromise = null;
            this.progressReporters.clear();
            this.eventDispatcher.cleanup();
            if (worker) {
                try {
                    await worker.terminate();
                } catch (error) {
                    logger.warn('关闭YANG编译Worker失败:', error.message);
                }
            }
            this.compilationRestorePromises.clear();
            this.deletingWorkspaces.clear();
            this.activeProfileId = null;
            this.closed = true;
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

module.exports = YangApp;
module.exports.profileWorkspaceId = profileWorkspaceId;
module.exports.STATE_STORE_KEY = STATE_STORE_KEY;
