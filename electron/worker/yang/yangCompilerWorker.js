const { parentPort } = require('worker_threads');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const { YangRegistry, YANG_REQ_TYPES, YANG_EVT_TYPES } = require('../../utils/yang');

class YangCompilerWorker {
    constructor() {
        this.registry = null;
        this.configuration = null;
        this.compileQueue = Promise.resolve();
        this.messageHandler = new WorkerMessageHandler();
        this.messageHandler.init();
        this.registerHandlers();
    }

    registerHandlers() {
        this.messageHandler.registerHandler(YANG_REQ_TYPES.CONFIGURE, this.configure.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.GET_COMPILER_STATUS, this.getCompilerStatus.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.LIST_MODULES, this.listModules.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.IMPORT_FILES, this.importFiles.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.IMPORT_DIRECTORY, this.importDirectory.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.IMPORT_CONTENTS, this.importContents.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.COMPILE, this.compile.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.CLEAR_WORKSPACE, this.clearWorkspace.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.GET_WORKSPACE, this.getWorkspace.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.GET_SCHEMA_ROOTS, this.getSchemaRoots.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.GET_SCHEMA_CHILDREN, this.getSchemaChildren.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.GET_SCHEMA_NODE, this.getSchemaNode.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.GET_MODULE_SOURCE, this.getModuleSource.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.GET_DIAGNOSTICS, this.getDiagnostics.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.CREATE_SNAPSHOT, this.createSnapshot.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.GET_SNAPSHOT, this.getSnapshot.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.LIST_SNAPSHOTS, this.listSnapshots.bind(this));
        this.messageHandler.registerHandler(YANG_REQ_TYPES.DELETE_SNAPSHOT, this.deleteSnapshot.bind(this));
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

    createRegistry(configuration) {
        if (!configuration.rootDir && !configuration.userDataPath) {
            throw new Error('YANG worker must be configured with rootDir/repositoryRoot or userDataPath');
        }
        this.configuration = configuration;
        this.registry = new YangRegistry(configuration);
        return this.registry;
    }

    requireRegistry(data = {}) {
        if (this.registry) return this.registry;
        return this.createRegistry(this.normalizeConfiguration(data));
    }

    async configure(messageId, data = {}) {
        try {
            const registry = this.createRegistry(this.normalizeConfiguration(data));
            const compiler = await registry.getCompilerStatus();
            this.messageHandler.sendSuccessResponse(
                messageId,
                {
                    rootDir: registry.repository.rootDir,
                    workspace: registry.getWorkspace(),
                    compiler
                },
                'YANG compiler worker configured'
            );
        } catch (error) {
            this.sendError(messageId, 'Unable to configure YANG compiler', error);
        }
    }

    async getCompilerStatus(messageId, data = {}) {
        try {
            const status = await this.requireRegistry(data).getCompilerStatus(data);
            this.messageHandler.sendSuccessResponse(messageId, status, 'YANG compiler runtime status');
        } catch (error) {
            this.sendError(messageId, 'Unable to get YANG compiler status', error);
        }
    }

    createImportProgress(progressId) {
        if (!progressId) return undefined;
        return progress => {
            this.messageHandler.sendEvent(YANG_EVT_TYPES.IMPORT_PROGRESS, { progressId, ...progress });
        };
    }

    createCompileProgress(progressId) {
        if (!progressId) return undefined;
        return progress => {
            this.messageHandler.sendEvent(YANG_EVT_TYPES.COMPILE_PROGRESS, {
                progressId: progressId || '',
                ...progress
            });
        };
    }

    listModules(messageId, data = {}) {
        this.respond(messageId, 'Unable to list YANG modules', () => this.requireRegistry(data).listModules(data));
    }

    importFiles(messageId, data = {}) {
        this.respond(messageId, 'Unable to import YANG files', () =>
            this.requireRegistry(data).importFiles(data.filePaths || data.paths || [], {
                ...data,
                onProgress: this.createImportProgress(data.progressId)
            })
        );
    }

    importDirectory(messageId, data = {}) {
        this.respond(messageId, 'Unable to import YANG directory', () =>
            this.requireRegistry(data).importDirectory(data.directoryPath || data.path, {
                ...data,
                onProgress: this.createImportProgress(data.progressId)
            })
        );
    }

    importContents(messageId, data = {}) {
        this.respond(messageId, 'Unable to import downloaded YANG modules', () =>
            this.requireRegistry(data).importContents(data.contents || data.modules || [], data)
        );
    }

    compile(messageId, data = {}) {
        const work = async () => {
            try {
                const registry = this.requireRegistry(data);
                const result = await registry.compile({
                    ...data,
                    onProgress: this.createCompileProgress(data.progressId)
                });
                this.messageHandler.sendSuccessResponse(
                    messageId,
                    result,
                    result.success ? 'YANG compilation completed' : 'YANG compilation completed with diagnostics'
                );
            } catch (error) {
                if (data.progressId) {
                    this.messageHandler.sendEvent(YANG_EVT_TYPES.COMPILE_PROGRESS, {
                        progressId: data.progressId,
                        phase: 'failed',
                        completed: 0,
                        total: 0,
                        percent: 100,
                        message: error.message,
                        counts: { parsed: 0, failed: 1 }
                    });
                }
                this.sendError(messageId, 'YANG compilation failed', error);
            }
        };
        this.compileQueue = this.compileQueue.then(work, work);
    }

    clearWorkspace(messageId, data = {}) {
        this.respond(messageId, 'Unable to clear YANG workspace', () =>
            this.requireRegistry(data).clearWorkspace(data.workspaceId || 'default')
        );
    }

    getWorkspace(messageId, data = {}) {
        this.respond(messageId, 'Unable to get YANG workspace', () =>
            this.requireRegistry(data).getWorkspace(data.workspaceId || 'default')
        );
    }

    getSchemaRoots(messageId, data = {}) {
        this.respond(messageId, 'Unable to get schema roots', () => this.requireRegistry(data).getSchemaRoots(data));
    }

    getSchemaChildren(messageId, data = {}) {
        this.respond(messageId, 'Unable to get schema children', () =>
            this.requireRegistry(data).getSchemaChildren(data.parentId, data)
        );
    }

    getSchemaNode(messageId, data = {}) {
        this.respond(messageId, 'Unable to get schema node', () =>
            this.requireRegistry(data).getSchemaNode(data.nodeId, data)
        );
    }

    getModuleSource(messageId, data = {}) {
        this.respond(messageId, 'Unable to get YANG module source', () => {
            const identifier = data.identifier ||
                data.hash || {
                    name: data.name,
                    revision: data.revision,
                    kind: data.kind
                };
            return this.requireRegistry(data).getModuleSource(identifier);
        });
    }

    getDiagnostics(messageId, data = {}) {
        this.respond(messageId, 'Unable to get YANG diagnostics', () =>
            this.requireRegistry(data).getDiagnostics(data)
        );
    }

    createSnapshot(messageId, data = {}) {
        this.respond(messageId, 'Unable to create YANG snapshot', () =>
            this.requireRegistry(data).createSnapshot(data)
        );
    }

    getSnapshot(messageId, data = {}) {
        this.respond(messageId, 'Unable to get YANG snapshot', () => this.requireRegistry(data).getSnapshot(data));
    }

    listSnapshots(messageId, data = {}) {
        this.respond(messageId, 'Unable to list YANG snapshots', () => this.requireRegistry(data).listSnapshots());
    }

    deleteSnapshot(messageId, data = {}) {
        this.respond(messageId, 'Unable to delete YANG snapshot', () =>
            this.requireRegistry(data).deleteSnapshot(data)
        );
    }

    respond(messageId, prefix, callback) {
        try {
            const result = callback();
            this.messageHandler.sendSuccessResponse(messageId, result);
        } catch (error) {
            this.sendError(messageId, prefix, error);
        }
    }

    sendError(messageId, prefix, error) {
        logger.error(`${prefix}:`, error);
        this.messageHandler.sendErrorResponse(messageId, `${prefix}: ${error.message}`);
    }
}

if (parentPort) {
    new YangCompilerWorker();
}

module.exports = YangCompilerWorker;
