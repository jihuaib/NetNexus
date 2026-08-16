'use strict';

const { EventEmitter } = require('node:events');
const { YangRegistry, YANG_REQ_TYPES, YANG_EVT_TYPES } = require('../../utils/yang');

class LocalYangCompilerClient extends EventEmitter {
    constructor() {
        super();
        this.registry = null;
        this.compileQueue = Promise.resolve();
        this.activeAbortableRequests = new Set();
        this.closed = false;
        this.terminationPromise = null;
    }

    normalizeConfiguration(data = {}) {
        return {
            rootDir: data.rootDir || data.repositoryRoot,
            userDataPath: data.userDataPath,
            workspaceId: data.workspaceId || 'default',
            workspaceName: data.workspaceName,
            compilerPath: data.compilerPath || null,
            compilerSource: data.compilerSource,
            compilerArgs: Array.isArray(data.compilerArgs) ? data.compilerArgs : [],
            schemaHelperPath: data.schemaHelperPath || null,
            schemaHelperArgs: Array.isArray(data.schemaHelperArgs) ? data.schemaHelperArgs : [],
            searchPaths: data.searchPaths || data.schemaSearchPaths,
            externalTimeout: data.externalTimeout,
            externalMaxBuffer: data.externalMaxBuffer,
            versionTimeout: data.versionTimeout,
            resourcesPath: data.resourcesPath,
            appPath: data.appPath,
            devResourcesPath: data.devResourcesPath,
            isPackaged: data.isPackaged,
            platform: data.platform,
            arch: data.arch
        };
    }

    configure(data = {}) {
        const configuration = this.normalizeConfiguration(data);
        if (!configuration.rootDir && !configuration.userDataPath) {
            throw new Error('YANG process must be configured with rootDir/repositoryRoot or userDataPath');
        }
        this.registry = new YangRegistry(configuration);
        return this.registry;
    }

    requireRegistry(data = {}) {
        return this.registry || this.configure(data);
    }

    emitProgress(eventName, progressId, progress = {}) {
        if (!progressId) return;
        const data = { progressId, ...progress };
        this.emit('event', eventName, data);
        this.emit(eventName, data);
    }

    async dispatch(operation, data = {}) {
        if (this.closed) {
            const error = new Error('YANG compiler client is closed');
            error.code = 'WORKER_TERMINATED';
            throw error;
        }

        if (operation === YANG_REQ_TYPES.CONFIGURE) {
            const registry = this.configure(data);
            return {
                rootDir: registry.repository.rootDir,
                workspace: registry.getWorkspace(),
                compiler: await registry.getCompilerStatus()
            };
        }

        const registry = this.requireRegistry(data);
        switch (operation) {
            case YANG_REQ_TYPES.GET_COMPILER_STATUS:
                return registry.getCompilerStatus(data);
            case YANG_REQ_TYPES.LIST_MODULES:
                return registry.listModules(data);
            case YANG_REQ_TYPES.IMPORT_FILES:
                return registry.importFiles(data.filePaths || data.paths || [], {
                    ...data,
                    onProgress: progress => this.emitProgress(YANG_EVT_TYPES.IMPORT_PROGRESS, data.progressId, progress)
                });
            case YANG_REQ_TYPES.IMPORT_DIRECTORY:
                return registry.importDirectory(data.directoryPath || data.path, {
                    ...data,
                    onProgress: progress => this.emitProgress(YANG_EVT_TYPES.IMPORT_PROGRESS, data.progressId, progress)
                });
            case YANG_REQ_TYPES.IMPORT_CONTENTS:
                return registry.importContents(data.contents || data.modules || [], data);
            case YANG_REQ_TYPES.COMPILE:
                return registry.compile({
                    ...data,
                    onProgress: progress =>
                        this.emitProgress(YANG_EVT_TYPES.COMPILE_PROGRESS, data.progressId, progress)
                });
            case YANG_REQ_TYPES.CLEAR_WORKSPACE:
                return registry.clearWorkspace(data.workspaceId || 'default');
            case YANG_REQ_TYPES.DELETE_WORKSPACE:
                return registry.deleteWorkspace(data.workspaceId || 'default');
            case YANG_REQ_TYPES.GET_WORKSPACE:
                return registry.getWorkspace(data.workspaceId || 'default');
            case YANG_REQ_TYPES.GET_SCHEMA_ROOTS:
                return registry.getSchemaRoots(data);
            case YANG_REQ_TYPES.GET_SCHEMA_CHILDREN:
                return registry.getSchemaChildren(data.parentId, data);
            case YANG_REQ_TYPES.GET_SCHEMA_NODE:
                return registry.getSchemaNode(data.nodeId, data);
            case YANG_REQ_TYPES.VALIDATE_RPC:
                return registry.validateRpc(data);
            case YANG_REQ_TYPES.GET_MODULE_SOURCE: {
                const identifier = data.identifier ||
                    data.hash || {
                        name: data.name,
                        revision: data.revision,
                        kind: data.kind
                    };
                return registry.getModuleSource(identifier, data);
            }
            case YANG_REQ_TYPES.GET_DIAGNOSTICS:
                return registry.getDiagnostics(data);
            case YANG_REQ_TYPES.CREATE_SNAPSHOT:
                return registry.createSnapshot(data);
            case YANG_REQ_TYPES.GET_SNAPSHOT:
                return registry.getSnapshot(data);
            case YANG_REQ_TYPES.LIST_SNAPSHOTS:
                return registry.listSnapshots();
            case YANG_REQ_TYPES.DELETE_SNAPSHOT:
                return registry.deleteSnapshot(data);
            default: {
                const error = new Error(`Unsupported in-process YANG compiler operation: ${operation}`);
                error.code = 'YANG_UNKNOWN_OPERATION';
                throw error;
            }
        }
    }

    sendRequest(operation, data = {}, options = {}) {
        if (this.closed) {
            const error = new Error('YANG compiler client is closed');
            error.code = 'WORKER_TERMINATED';
            return Promise.reject(error);
        }
        if (options.signal?.aborted) {
            const error = new Error(`YANG process request cancelled: ${operation}`);
            error.code = 'WORKER_CANCELLED';
            return Promise.reject(error);
        }
        const abortable = [YANG_REQ_TYPES.COMPILE, YANG_REQ_TYPES.VALIDATE_RPC].includes(operation);
        const controller = abortable ? new AbortController() : null;
        const requestSignal = controller?.signal || options.signal;
        let detachSourceSignal = null;
        if (controller && options.signal) {
            const abortFromSource = () => controller.abort(options.signal.reason);
            options.signal.addEventListener('abort', abortFromSource, { once: true });
            detachSourceSignal = () => options.signal.removeEventListener('abort', abortFromSource);
        }
        const payload = requestSignal ? { ...(data || {}), signal: requestSignal } : data;
        const execute = () => {
            if (requestSignal?.aborted) {
                const error = new Error(`YANG process request cancelled: ${operation}`);
                error.code = 'WORKER_CANCELLED';
                return Promise.reject(error);
            }
            return this.dispatch(operation, payload).then(result => ({ status: 'success', data: result }));
        };
        const request = operation === YANG_REQ_TYPES.COMPILE ? this.compileQueue.then(execute, execute) : execute();
        if (!abortable) return request;

        const record = { operation, controller, promise: null };
        const trackedRequest = Promise.resolve(request).finally(() => {
            detachSourceSignal?.();
            this.activeAbortableRequests.delete(record);
        });
        record.promise = trackedRequest;
        this.activeAbortableRequests.add(record);
        if (operation === YANG_REQ_TYPES.COMPILE) this.compileQueue = trackedRequest.catch(() => {});
        return trackedRequest;
    }

    async terminate() {
        if (this.terminationPromise) return this.terminationPromise;
        this.closed = true;
        for (const request of this.activeAbortableRequests) {
            if (!request.controller.signal.aborted) request.controller.abort();
        }
        const pending = [...this.activeAbortableRequests].map(request => request.promise).filter(Boolean);
        this.terminationPromise = Promise.allSettled(pending).then(() => {
            this.registry = null;
            this.compileQueue = Promise.resolve();
        });
        return this.terminationPromise;
    }
}

module.exports = LocalYangCompilerClient;
