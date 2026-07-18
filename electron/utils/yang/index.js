const { YangRepository } = require('./yangRepository');
const { YangCompiler, ROOT_NODE_ID } = require('./yangCompiler');
const parser = require('./yangParser');
const libyangRuntime = require('./libyangRuntime');

const YANG_REQ_TYPES = Object.freeze({
    CONFIGURE: 'yang:configure',
    LIST_MODULES: 'yang:list-modules',
    IMPORT_FILES: 'yang:import-files',
    IMPORT_DIRECTORY: 'yang:import-directory',
    IMPORT_CONTENTS: 'yang:import-contents',
    COMPILE: 'yang:compile',
    CLEAR_WORKSPACE: 'yang:clear-workspace',
    GET_WORKSPACE: 'yang:get-workspace',
    GET_SCHEMA_ROOTS: 'yang:get-schema-roots',
    GET_SCHEMA_CHILDREN: 'yang:get-schema-children',
    GET_SCHEMA_NODE: 'yang:get-schema-node',
    GET_MODULE_SOURCE: 'yang:get-module-source',
    GET_DIAGNOSTICS: 'yang:get-diagnostics',
    CREATE_SNAPSHOT: 'yang:create-snapshot',
    GET_SNAPSHOT: 'yang:get-snapshot',
    LIST_SNAPSHOTS: 'yang:list-snapshots',
    DELETE_SNAPSHOT: 'yang:delete-snapshot',
    GET_COMPILER_STATUS: 'yang:get-compiler-status'
});

const YANG_EVT_TYPES = Object.freeze({
    COMPILE_PROGRESS: 'yang:compile-progress',
    IMPORT_PROGRESS: 'yang:import-progress'
});

class YangRegistry {
    constructor(options = {}) {
        this.workspaceId = options.workspaceId || 'default';
        this.repository = options.repository || new YangRepository(options);
        this.compiler =
            options.compiler ||
            new YangCompiler({
                repository: this.repository,
                cacheDir: options.cacheDir,
                compilerPath: options.compilerPath,
                compilerSource: options.compilerSource,
                compilerArgs: options.compilerArgs,
                schemaHelperPath: options.schemaHelperPath,
                schemaHelperArgs: options.schemaHelperArgs,
                searchPaths: options.searchPaths || options.schemaSearchPaths,
                externalTimeout: options.externalTimeout,
                externalMaxBuffer: options.externalMaxBuffer,
                versionTimeout: options.versionTimeout,
                resourcesPath: options.resourcesPath,
                appPath: options.appPath,
                devResourcesPath: options.devResourcesPath,
                isPackaged: options.isPackaged,
                platform: options.platform,
                arch: options.arch,
                runtime: options.runtime
            });
        if (!this.repository.getWorkspace(this.workspaceId)) {
            this.repository.createWorkspace({ id: this.workspaceId, name: options.workspaceName || this.workspaceId });
        }
    }

    normalizeWorkspaceOptions(options = {}) {
        return {
            ...options,
            workspaceId: options.workspaceId === undefined ? this.workspaceId : options.workspaceId
        };
    }

    importFiles(filePaths = [], options = {}) {
        const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
        return this.repository.importPaths(paths, {
            ...this.normalizeWorkspaceOptions(options),
            recursive: false
        });
    }

    importDirectory(directoryPath, options = {}) {
        return this.repository.importPaths([directoryPath], {
            ...this.normalizeWorkspaceOptions(options),
            recursive: options.recursive !== false
        });
    }

    importContents(contents = [], options = {}) {
        return this.repository.importContents(contents, this.normalizeWorkspaceOptions(options));
    }

    listModules(options = {}) {
        const normalized = this.normalizeWorkspaceOptions(options);
        return this.repository.listModules(normalized);
    }

    getWorkspace(id = this.workspaceId) {
        return this.repository.getWorkspace(id);
    }

    clearWorkspace(id = this.workspaceId) {
        if (id && typeof id === 'object') {
            id = id.workspaceId || this.workspaceId;
        }
        if (id === this.workspaceId) {
            this.compiler.latestCompileId = null;
        }
        return this.repository.clearWorkspace(id);
    }

    async compile(options = {}) {
        let compileOptions = this.normalizeWorkspaceOptions(options);
        if (options.filePaths?.length) {
            const imported = this.repository.importPaths(options.filePaths, compileOptions);
            compileOptions = {
                ...compileOptions,
                hashes:
                    imported.workspace?.modules.map(module => module.hash) ||
                    imported.imported.map(entry => entry.hash),
                workspaceId: undefined
            };
        } else if (options.contents?.length) {
            const imported = this.repository.importContents(options.contents, compileOptions);
            compileOptions = {
                ...compileOptions,
                hashes:
                    imported.workspace?.modules.map(module => module.hash) ||
                    imported.imported.map(entry => entry.hash),
                workspaceId: undefined
            };
        }
        return this.compiler.compile(compileOptions);
    }

    async getCompilerStatus(options = {}) {
        return this.compiler.getCompilerStatus(options);
    }

    getSchemaRoots(options = {}) {
        const compileId = typeof options === 'string' ? options : options.compileId;
        return this.compiler.getSchemaRoots(compileId);
    }

    getSchemaChildren(parentId, options = {}) {
        if (parentId && typeof parentId === 'object') {
            options = parentId;
            parentId = options.parentId;
        }
        return this.compiler.getSchemaChildren(parentId || ROOT_NODE_ID, options.compileId);
    }

    getSchemaNode(nodeId, options = {}) {
        if (nodeId && typeof nodeId === 'object') {
            options = nodeId;
            nodeId = options.nodeId;
        }
        return this.compiler.getSchemaNode(nodeId, options.compileId);
    }

    getModuleSource(identifier) {
        return this.repository.getSource(identifier);
    }

    getDiagnostics(options = {}) {
        const compileId = typeof options === 'string' ? options : options.compileId;
        return this.compiler.getDiagnostics(compileId);
    }

    createSnapshot(options = {}) {
        const modules =
            options.modules || this.repository.getWorkspace(options.workspaceId || this.workspaceId)?.modules || [];
        return this.repository.createSnapshot({ ...options, modules });
    }

    getSnapshot(id) {
        return this.repository.getSnapshot(typeof id === 'object' ? id.id : id);
    }

    listSnapshots() {
        return this.repository.listManifests('snapshot');
    }

    deleteSnapshot(id) {
        return this.repository.deleteManifest('snapshot', typeof id === 'object' ? id.id : id);
    }
}

module.exports = {
    YangRegistry,
    YangRepository,
    YangCompiler,
    ROOT_NODE_ID,
    YANG_REQ_TYPES,
    YANG_EVT_TYPES,
    ...libyangRuntime,
    ...parser
};
