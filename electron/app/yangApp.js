const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');
const logger = require('../log/logger');
const EventDispatcher = require('../utils/eventDispatcher');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const TaskManager = require('../utils/taskManager');
const RequestWorkerClient = require('../worker/core/requestWorkerClient');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const { YANG_REQ_TYPES: WORKER_REQ_TYPES, YANG_EVT_TYPES: WORKER_EVT_TYPES } = require('../utils/yang');
const { YANG_EVT_TYPES } = require('../const/yangConst');

const WORKSPACE_ID = 'default';
const STATE_STORE_KEY = 'yang-workspace-state';
const DEFAULT_REQUEST_TIMEOUT = 120000;

class YangApp {
    constructor(ipcMain, store, options = {}) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.rootDir = path.resolve(options.rootDir || path.join(app.getPath('userData'), 'yang'));
        this.compilerPath = options.compilerPath || process.env.NETNEXUS_YANGLINT_PATH || null;
        this.compilerArgs = Array.isArray(options.compilerArgs) ? options.compilerArgs : [];
        this.resourcesPath = options.resourcesPath || process.resourcesPath;
        this.isPackaged = options.isPackaged ?? Boolean(app?.isPackaged);
        this.workerClient = null;
        this.configurePromise = null;
        this.progressReporters = new Map();
        this.eventDispatcher = new EventDispatcher();
        this.lastCompile = this.readStoredState();
        this.compileResult = null;
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
        handle('yang:getModuleSource', this.handleGetModuleSource);
        handle('yang:getDiagnostics', this.handleGetDiagnostics);
    }

    setWebContents(event) {
        const sender = event?.sender;
        if (sender && !sender.isDestroyed?.()) this.eventDispatcher.setWebContents(sender);
    }

    emitTaskProgress(progress) {
        if (!this.eventDispatcher.canEmit()) return;
        this.eventDispatcher.emit(YANG_EVT_TYPES.TASK_PROGRESS, successResponse(progress, 'YANG任务进度'));
    }

    readStoredState() {
        try {
            return this.store?.get(STATE_STORE_KEY, null) || null;
        } catch (_error) {
            return null;
        }
    }

    persistCompileState(result, workspace) {
        this.lastCompile = result
            ? {
                  compileId: result.compileId,
                  contentHash: result.contentHash,
                  contextHash: result.contextHash,
                  compiledAt: result.compiledAt,
                  success: result.success,
                  summary: result.summary || {},
                  moduleHashes: result.moduleHashes || result.modules?.map(module => module.hash).filter(Boolean) || [],
                  restoreOptions: result.restoreOptions || {},
                  workspaceContentHash: workspace?.contentHash || null
              }
            : null;
        if (!this.store) return;
        if (this.lastCompile) this.store.set(STATE_STORE_KEY, this.lastCompile);
        else this.store.delete(STATE_STORE_KEY);
    }

    invalidateCompilation() {
        this.compileResult = null;
        this.persistCompileState(null, null);
    }

    ensureWorker(event) {
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
                    workspaceId: WORKSPACE_ID,
                    compilerPath: this.compilerPath,
                    compilerArgs: this.compilerArgs,
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
        const response = await client.sendRequest(
            operation,
            { workspaceId: WORKSPACE_ID, ...data },
            { timeoutMs: options.timeoutMs || DEFAULT_REQUEST_TIMEOUT, signal: options.signal }
        );
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
            localPath: entry?.blobPath || entry?.filePath || '',
            filePath: entry?.blobPath || entry?.filePath || '',
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

    compiledHashes() {
        if (this.compileResult) {
            return new Set(this.compileResult.success ? this.compileResult.moduleHashes || [] : []);
        }
        return new Set(this.lastCompile?.success ? this.lastCompile.moduleHashes || [] : []);
    }

    failedCompileHashes() {
        if (this.compileResult) {
            return new Set(this.compileResult.success ? [] : this.compileResult.moduleHashes || []);
        }
        return new Set(this.lastCompile?.success === false ? this.lastCompile.moduleHashes || [] : []);
    }

    async listRawModules(event, query = {}) {
        return this.send(event, WORKER_REQ_TYPES.LIST_MODULES, query || {});
    }

    async handleListModules(event, query = {}) {
        try {
            const modules = await this.listRawModules(event, query);
            const compiled = this.compiledHashes();
            const failed = this.failedCompileHashes();
            return successResponse(modules.map(module => this.normalizeModule(module, compiled, failed)));
        } catch (error) {
            return errorResponse('获取YANG模型失败: ' + error.message);
        }
    }

    startImportTask(event, type, operation, data) {
        this.setWebContents(event);
        return this.taskManager.start(
            'import',
            async ({ taskId, signal, report }) => {
                this.progressReporters.set(taskId, report);
                report({ phase: 'importing', percent: 1, message: '正在导入YANG模型' });
                try {
                    const result = await this.send(
                        event,
                        operation,
                        { ...data, progressId: taskId },
                        { timeoutMs: 10 * 60 * 1000, signal }
                    );
                    this.invalidateCompilation();
                    return result;
                } finally {
                    this.progressReporters.delete(taskId);
                }
            },
            { source: type }
        );
    }

    async handleImportFiles(event, filePaths) {
        try {
            const paths = Array.isArray(filePaths) && filePaths.length ? filePaths : await this.selectFiles(event);
            if (!paths.length) return successResponse({ cancelled: true, filePaths: [] }, '已取消导入');
            return successResponse(
                this.startImportTask(event, 'files', WORKER_REQ_TYPES.IMPORT_FILES, { filePaths: paths }),
                'YANG导入任务已开始'
            );
        } catch (error) {
            return errorResponse('启动YANG文件导入失败: ' + error.message);
        }
    }

    async handleImportDirectory(event, directoryPath) {
        try {
            const selected =
                typeof directoryPath === 'string' && directoryPath ? directoryPath : await this.selectDirectory(event);
            if (!selected) return successResponse({ cancelled: true }, '已取消导入');
            return successResponse(
                this.startImportTask(event, 'directory', WORKER_REQ_TYPES.IMPORT_DIRECTORY, {
                    directoryPath: selected,
                    recursive: true
                }),
                'YANG目录导入任务已开始'
            );
        } catch (error) {
            return errorResponse('启动YANG目录导入失败: ' + error.message);
        }
    }

    async importDownloadedContents(contents, options = {}) {
        const result = await this.send(null, WORKER_REQ_TYPES.IMPORT_CONTENTS, {
            contents,
            snapshotId: options.snapshotId,
            snapshotMetadata: {
                profileId: options.profileId || null,
                discoveredAt: options.inventory?.discoveredAt || new Date().toISOString()
            }
        });
        this.invalidateCompilation();
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
            const compiler = await this.send(event, WORKER_REQ_TYPES.GET_COMPILER_STATUS, {
                forceRuntimeDiscovery: options.forceRuntimeDiscovery === true
            });
            if (!compiler.available) {
                const details = [compiler.error, compiler.installHint].filter(Boolean).join(' ');
                return errorResponse(`libyang/yanglint 权威编译器不可用${details ? `: ${details}` : ''}`);
            }
            const modules = await this.listRawModules(event);
            if (!modules.length) return errorResponse('请先下载或导入YANG模型');
            const hashes = this.resolveCompileHashes(options.hashes || options.moduleIds || options.modules, modules);
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
                                hashes: hashes || undefined,
                                progressId: taskId
                            },
                            { timeoutMs: 10 * 60 * 1000, signal }
                        );
                        const workspace = await this.send(event, WORKER_REQ_TYPES.GET_WORKSPACE);
                        this.compileResult = {
                            ...result,
                            moduleHashes: result.modules?.map(module => module.hash).filter(Boolean) || [],
                            restoreOptions: {
                                features: Array.isArray(options.features) ? options.features : [],
                                deviations: Array.isArray(options.deviations) ? options.deviations : [],
                                compilerPath: options.compilerPath,
                                compilerArgs: Array.isArray(options.compilerArgs) ? options.compilerArgs : undefined
                            }
                        };
                        this.persistCompileState(this.compileResult, workspace);
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
                { moduleCount: hashes?.length || modules.length }
            );
            return successResponse(task, 'YANG编译任务已开始');
        } catch (error) {
            return errorResponse('启动YANG编译失败: ' + error.message);
        }
    }

    isStoredCompilationCurrent(workspace) {
        return Boolean(
            this.lastCompile?.compileId &&
                workspace?.contentHash &&
                this.lastCompile.workspaceContentHash === workspace.contentHash
        );
    }

    async decorateWorkspace(event, workspace) {
        const current = this.isStoredCompilationCurrent(workspace) ? this.lastCompile : null;
        const result = this.compileResult?.compileId === current?.compileId ? this.compileResult : null;
        const compiled = new Set(current?.success ? current.moduleHashes || [] : []);
        const failed = new Set(current?.success === false ? current.moduleHashes || [] : []);
        const rawModules = await this.listRawModules(event);
        const modules = rawModules.map(module => this.normalizeModule(module, compiled, failed));
        const compiler = await this.send(event, WORKER_REQ_TYPES.GET_COMPILER_STATUS);
        return {
            workspaceId: workspace?.id || WORKSPACE_ID,
            name: workspace?.name || WORKSPACE_ID,
            createdAt: workspace?.createdAt || null,
            updatedAt: workspace?.updatedAt || null,
            contentHash: workspace?.contentHash || null,
            compileId: current?.compileId || '',
            compiledAt: current?.compiledAt || null,
            success: current?.success ?? null,
            compiler,
            modules,
            diagnostics: result?.diagnostics || [],
            summary: {
                moduleCount: modules.length,
                nodeCount: result?.schemaTree?.nodeCount || current?.summary?.schemaNodes || 0,
                cacheHit: Boolean(current?.cacheHit),
                errors: current?.summary?.errors || 0,
                warnings: current?.summary?.warnings || 0
            },
            schemaTree: result?.schemaTree || null
        };
    }

    async handleGetWorkspace(event) {
        try {
            const workspace = await this.send(event, WORKER_REQ_TYPES.GET_WORKSPACE);
            if (!this.isStoredCompilationCurrent(workspace) && this.lastCompile) this.invalidateCompilation();
            return successResponse(await this.decorateWorkspace(event, workspace));
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

    async ensureCompilationLoaded(event, requestedCompileId) {
        const workspace = await this.send(event, WORKER_REQ_TYPES.GET_WORKSPACE);
        if (!this.isStoredCompilationCurrent(workspace)) throw new Error('当前工作区尚未编译');
        const expected = requestedCompileId || this.lastCompile.compileId;
        if (requestedCompileId && requestedCompileId !== this.lastCompile.compileId) {
            throw new Error('指定的YANG编译上下文已失效');
        }
        try {
            await this.send(event, WORKER_REQ_TYPES.GET_DIAGNOSTICS, { compileId: expected });
        } catch (_error) {
            const restored = await this.send(
                event,
                WORKER_REQ_TYPES.COMPILE,
                {
                    ...this.lastCompile.restoreOptions,
                    force: false,
                    hashes: this.lastCompile.moduleHashes || undefined
                },
                { timeoutMs: 10 * 60 * 1000 }
            );
            this.compileResult = {
                ...restored,
                moduleHashes: restored.modules?.map(module => module.hash).filter(Boolean) || []
            };
            this.persistCompileState(this.compileResult, workspace);
            if (restored.compileId !== expected) throw new Error('YANG工作区内容或编译选项已经变化，请重新编译');
        }
        return expected;
    }

    async handleClearWorkspace(event) {
        try {
            this.setWebContents(event);
            this.invalidateCompilation();
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

    async handleCompiledQuery(event, request, operation, errorPrefix) {
        try {
            const compileId = await this.ensureCompilationLoaded(event, request?.compileId);
            return successResponse(await this.send(event, operation, { ...request, compileId }));
        } catch (error) {
            return errorResponse(`${errorPrefix}: ${error.message}`);
        }
    }

    async handleGetModuleSource(event, request = {}) {
        try {
            const data = { ...request };
            if (request.moduleId && !request.hash) data.hash = request.moduleId;
            return successResponse(await this.send(event, WORKER_REQ_TYPES.GET_MODULE_SOURCE, data));
        } catch (error) {
            return errorResponse('获取YANG源码失败: ' + error.message);
        }
    }

    async handleLogLevelChange(logLevel) {
        this.logLevel = logLevel;
    }

    getRunning() {
        return this.taskManager.list().some(task => task.status === 'running');
    }

    async close() {
        for (const task of this.taskManager.list()) {
            if (task.status === 'running') this.taskManager.cancel(task.taskId);
        }
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
    }
}

module.exports = YangApp;
