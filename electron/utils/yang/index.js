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
    DELETE_WORKSPACE: 'yang:delete-workspace',
    GET_WORKSPACE: 'yang:get-workspace',
    GET_SCHEMA_ROOTS: 'yang:get-schema-roots',
    GET_SCHEMA_CHILDREN: 'yang:get-schema-children',
    GET_SCHEMA_NODE: 'yang:get-schema-node',
    VALIDATE_RPC: 'yang:validate-rpc',
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
        this.latestCompileIds = new Map();
        this.compileScopeContentHashes = new Map();
        this.compileScopeModuleHashes = new Map();
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

    compileScopeKey(options = {}) {
        if (options.snapshotId) return `snapshot:${options.snapshotId}`;
        const workspaceId = options.workspaceId === undefined ? this.workspaceId : options.workspaceId;
        return `workspace:${workspaceId}`;
    }

    resolveCompileId(options = {}) {
        const explicit = typeof options === 'string' ? options : options?.compileId;
        if (typeof options === 'string' && explicit) return explicit;
        const normalized = typeof options === 'object' && options ? options : {};
        const scopeKey = this.compileScopeKey(normalized);
        let compileId = this.latestCompileIds.get(scopeKey);
        if (compileId) {
            const expectedContentHash = this.compileScopeContentHashes.get(scopeKey);
            const expectedModuleHashes = this.compileScopeModuleHashes.get(scopeKey);
            const manifest = normalized.snapshotId
                ? this.repository.getSnapshot(normalized.snapshotId)
                : this.repository.getWorkspace(
                      normalized.workspaceId === undefined ? this.workspaceId : normalized.workspaceId
                  );
            const currentModuleHashes = new Set((manifest?.modules || []).map(module => module.hash).filter(Boolean));
            const modulesAreCurrent =
                Array.isArray(expectedModuleHashes) &&
                expectedModuleHashes.length > 0 &&
                expectedModuleHashes.every(hash => currentModuleHashes.has(hash));
            const contentIsCurrent =
                (!Array.isArray(expectedModuleHashes) || expectedModuleHashes.length === 0) &&
                Boolean(expectedContentHash) &&
                expectedContentHash === manifest?.contentHash;
            if (!modulesAreCurrent && !contentIsCurrent) {
                this.latestCompileIds.delete(scopeKey);
                this.compileScopeContentHashes.delete(scopeKey);
                this.compileScopeModuleHashes.delete(scopeKey);
                compileId = null;
            }
        }
        if (explicit && compileId !== explicit) {
            throw new Error(`YANG compilation ${explicit} is not loaded for ${scopeKey}`);
        }
        if (explicit) return explicit;
        if (!compileId) throw new Error(`No YANG compilation is loaded for ${scopeKey}`);
        return compileId;
    }

    clearScopeCompilation(options = {}) {
        const scopeKey = this.compileScopeKey(options);
        const removedCompileId = this.latestCompileIds.get(scopeKey);
        this.latestCompileIds.delete(scopeKey);
        this.compileScopeContentHashes.delete(scopeKey);
        this.compileScopeModuleHashes.delete(scopeKey);
        if (removedCompileId && this.compiler.latestCompileId === removedCompileId) {
            this.compiler.latestCompileId = this.latestCompileIds.get(this.compileScopeKey()) || null;
        }
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
        this.clearScopeCompilation({ workspaceId: id });
        return this.repository.clearWorkspace(id);
    }

    deleteWorkspace(id = this.workspaceId) {
        if (id && typeof id === 'object') {
            id = id.workspaceId || this.workspaceId;
        }
        this.clearScopeCompilation({ workspaceId: id });
        return this.repository.deleteWorkspace(id);
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
                workspaceId: compileOptions.workspaceId
            };
        } else if (options.contents?.length) {
            const imported = this.repository.importContents(options.contents, compileOptions);
            compileOptions = {
                ...compileOptions,
                hashes:
                    imported.workspace?.modules.map(module => module.hash) ||
                    imported.imported.map(entry => entry.hash),
                workspaceId: compileOptions.workspaceId
            };
        }
        const result = await this.compiler.compile(compileOptions);
        const scopeKey = this.compileScopeKey(compileOptions);
        const scopeContentHash = compileOptions.snapshotId
            ? this.repository.getSnapshot(compileOptions.snapshotId)?.contentHash
            : this.repository.getWorkspace(compileOptions.workspaceId)?.contentHash;
        this.latestCompileIds.set(scopeKey, result.compileId);
        this.compileScopeContentHashes.set(scopeKey, scopeContentHash || null);
        this.compileScopeModuleHashes.set(scopeKey, [...new Set((result.moduleHashes || []).filter(Boolean))]);
        return result;
    }

    async getCompilerStatus(options = {}) {
        return this.compiler.getCompilerStatus(options);
    }

    getSchemaRoots(options = {}) {
        return this.compiler.getSchemaRoots(this.resolveCompileId(options));
    }

    getSchemaChildren(parentId, options = {}) {
        if (parentId && typeof parentId === 'object') {
            options = parentId;
            parentId = options.parentId;
        }
        return this.compiler.getSchemaChildren(parentId || ROOT_NODE_ID, this.resolveCompileId(options));
    }

    getSchemaNode(nodeId, options = {}) {
        if (nodeId && typeof nodeId === 'object') {
            options = nodeId;
            nodeId = options.nodeId;
        }
        return this.compiler.getSchemaNode(nodeId, this.resolveCompileId(options));
    }

    async validateRpc(options = {}) {
        return this.compiler.validateRpc({ ...options, compileId: this.resolveCompileId(options) });
    }

    getModuleSource(identifier, options = {}) {
        return this.repository.getSource(identifier, this.normalizeWorkspaceOptions(options));
    }

    getDiagnostics(options = {}) {
        return this.compiler.getDiagnostics(this.resolveCompileId(options));
    }

    createSnapshot(options = {}) {
        const workspaceId = options.workspaceId || this.workspaceId;
        const requestedModules = Array.isArray(options.modules) ? options.modules : null;
        const modules = requestedModules
            ? requestedModules.every(module => module && typeof module === 'object' && module.filePath)
                ? requestedModules
                : this.repository.resolveEntries({
                      workspaceId,
                      hashes: requestedModules.map(module => (typeof module === 'string' ? module : module?.hash))
                  })
            : this.repository.resolveEntries({ workspaceId });
        return this.repository.createSnapshot({ ...options, modules });
    }

    getSnapshot(id) {
        return this.repository.getSnapshot(typeof id === 'object' ? id.id : id);
    }

    listSnapshots() {
        return this.repository.listManifests('snapshot');
    }

    deleteSnapshot(id) {
        const snapshotId = typeof id === 'object' ? id.id : id;
        this.clearScopeCompilation({ snapshotId });
        return this.repository.deleteManifest('snapshot', snapshotId);
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
