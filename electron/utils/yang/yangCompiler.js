const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseYang } = require('./yangParser');
const { sha256, stableStringify, atomicWriteJson } = require('./yangRepository');
const { LibyangRuntime } = require('./libyangRuntime');
const {
    buildRpcValidationPayload,
    isSecondaryYanglintDiagnostic,
    lineAt,
    normalizeLibyangRpcDiagnostic,
    resolveRpcValidationTarget
} = require('./yangRpcInstanceValidation');

const COMPILE_CACHE_SCHEMA_VERSION = 3;
const LIBYANG_SCHEMA_OUTPUT_VERSION = 1;
const DEFAULT_COMPILER_EXECUTABLE = 'yanglint';
const DEFAULT_EXTERNAL_TIMEOUT = 60_000;
const DEFAULT_EXTERNAL_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_VERSION_TIMEOUT = 5_000;
const MAX_RPC_VALIDATION_BYTES = 8 * 1024 * 1024;
const ROOT_NODE_ID = 'yang-schema-root';

function diagnosticKey(diagnostic) {
    return [
        diagnostic.severity,
        diagnostic.code,
        diagnostic.source,
        diagnostic.line,
        diagnostic.column,
        diagnostic.message
    ].join('\u0000');
}

function deduplicateDiagnostics(diagnostics) {
    const seen = new Set();
    return diagnostics.filter(diagnostic => {
        const key = diagnosticKey(diagnostic);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function normalizePositiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.floor(numeric)));
}

function normalizeStringList(value) {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return [...new Set(values.map(item => String(item).trim()).filter(Boolean))];
}

function normalizeCacheValues(value) {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return [...new Set(values.map(item => stableStringify(item)))].sort();
}

function normalizedPathKey(value) {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function schemaFileFingerprint(filePath) {
    const resolvedPath = path.resolve(filePath);
    try {
        const stats = fs.statSync(resolvedPath);
        if (!stats.isFile()) return { path: resolvedPath, type: 'not-file' };
        return {
            path: resolvedPath,
            size: stats.size,
            hash: sha256(fs.readFileSync(resolvedPath))
        };
    } catch (error) {
        return { path: resolvedPath, error: error.code || error.message };
    }
}

function schemaSearchPathFingerprint(searchPath) {
    const resolvedPath = path.resolve(searchPath);
    const entries = [];
    const visitedDirectories = new Set();
    const visit = (currentPath, relativePath) => {
        let realPath;
        let stats;
        try {
            realPath = fs.realpathSync(currentPath);
            stats = fs.statSync(realPath);
        } catch (error) {
            entries.push({ path: relativePath, error: error.code || error.message });
            return;
        }
        if (stats.isDirectory()) {
            const directoryKey = normalizedPathKey(realPath);
            if (visitedDirectories.has(directoryKey)) return;
            visitedDirectories.add(directoryKey);
            let names;
            try {
                names = fs.readdirSync(realPath).sort((left, right) => left.localeCompare(right));
            } catch (error) {
                entries.push({ path: relativePath, error: error.code || error.message });
                return;
            }
            for (const name of names) {
                visit(path.join(realPath, name), relativePath ? `${relativePath}/${name}` : name);
            }
            return;
        }
        if (!stats.isFile() || (!relativePath.endsWith('.yang') && !relativePath.endsWith('.yin'))) return;
        try {
            entries.push({ path: relativePath, size: stats.size, hash: sha256(fs.readFileSync(realPath)) });
        } catch (error) {
            entries.push({ path: relativePath, error: error.code || error.message });
        }
    };
    visit(resolvedPath, '');
    return { path: resolvedPath, entries };
}

function externalDeviationPaths(value) {
    const deviations = Array.isArray(value) ? value : value ? [value] : [];
    return deviations
        .map(deviation => {
            if (deviation && typeof deviation === 'object') return deviation.path || deviation.filePath || null;
            if (typeof deviation !== 'string') return null;
            return path.isAbsolute(deviation) ||
                deviation.includes('/') ||
                deviation.includes('\\') ||
                /\.yang$/i.test(deviation)
                ? deviation
                : null;
        })
        .filter(Boolean);
}

function compilerUnavailableDiagnostic(status) {
    return {
        severity: 'error',
        code: 'LIBYANG_RUNTIME_UNAVAILABLE',
        message: status.error || 'Required libyang compiler and schema helper are not available',
        source: status.schemaPath || status.path || status.executable,
        line: null,
        column: null,
        authoritative: true,
        installHint: status.installHint
    };
}

function emptySchemaIndex() {
    return {
        rootId: ROOT_NODE_ID,
        roots: [],
        nodes: {},
        childIndex: { [ROOT_NODE_ID]: [] },
        nodeCount: 0
    };
}

function validateAuthoritativeSchemaTree(value) {
    const fail = message => {
        const error = new Error(`Invalid libyang schema output: ${message}`);
        error.code = 'LIBYANG_SCHEMA_INVALID_OUTPUT';
        throw error;
    };
    const isObject = item => Boolean(item) && typeof item === 'object' && !Array.isArray(item);
    if (!isObject(value)) fail('root value must be an object');
    if (value.schemaVersion !== LIBYANG_SCHEMA_OUTPUT_VERSION) {
        fail(`schemaVersion must be ${LIBYANG_SCHEMA_OUTPUT_VERSION}`);
    }
    if (value.authoritative !== true) fail('authoritative must be true');
    if (value.source !== 'libyang-effective') fail('source must be libyang-effective');
    if (value.scope !== 'core-effective-schema') fail('scope must be core-effective-schema');
    if (value.rootId !== ROOT_NODE_ID) fail(`rootId must be ${ROOT_NODE_ID}`);
    if (!Array.isArray(value.roots) || !isObject(value.nodes) || !isObject(value.childIndex)) {
        fail('roots, nodes, and childIndex are required');
    }

    const nodeIds = Object.keys(value.nodes);
    if (!Number.isSafeInteger(value.nodeCount) || value.nodeCount < 0 || value.nodeCount !== nodeIds.length) {
        fail('nodeCount does not match nodes');
    }
    const rootChildren = value.childIndex[ROOT_NODE_ID];
    if (!Array.isArray(rootChildren) || rootChildren.length !== value.roots.length) {
        fail('root child index does not match roots');
    }
    if (rootChildren.some((id, index) => id !== value.roots[index])) {
        fail('roots must exactly match the root child index');
    }

    const referenced = new Set();
    for (const [parentId, children] of Object.entries(value.childIndex)) {
        if (parentId !== ROOT_NODE_ID && !Object.hasOwn(value.nodes, parentId)) {
            fail(`childIndex contains unknown parent ${parentId}`);
        }
        if (!Array.isArray(children) || children.some(id => typeof id !== 'string' || !id)) {
            fail(`childIndex entry ${parentId} must be an array of node IDs`);
        }
        if (new Set(children).size !== children.length) fail(`childIndex entry ${parentId} contains duplicates`);
        for (const childId of children) {
            if (!Object.hasOwn(value.nodes, childId)) fail(`childIndex references unknown node ${childId}`);
            if (referenced.has(childId)) fail(`node ${childId} has more than one parent`);
            referenced.add(childId);
            if (value.nodes[childId].parentId !== parentId) {
                fail(`node ${childId} parentId does not match childIndex`);
            }
        }
    }

    for (const nodeId of nodeIds) {
        const node = value.nodes[nodeId];
        if (!isObject(node) || node.id !== nodeId) fail(`node key ${nodeId} does not match its id`);
        if (typeof node.parentId !== 'string' || !node.parentId) fail(`node ${nodeId} has no parentId`);
        for (const field of ['name', 'keyword', 'path']) {
            if (typeof node[field] !== 'string' || !node[field]) fail(`node ${nodeId} has no ${field}`);
        }
        if (node.presence !== null && typeof node.presence !== 'boolean') {
            fail(`node ${nodeId} presence must be boolean or null`);
        }
        const children = value.childIndex[nodeId];
        if (!Array.isArray(children)) fail(`node ${nodeId} has no childIndex entry`);
        if (!Number.isSafeInteger(node.childCount) || node.childCount !== children.length) {
            fail(`node ${nodeId} childCount does not match childIndex`);
        }
        if (node.hasChildren !== children.length > 0) fail(`node ${nodeId} hasChildren is inconsistent`);
        if (!referenced.has(nodeId)) fail(`node ${nodeId} is not reachable from the schema root`);
    }
    if (new Set(value.roots).size !== value.roots.length) fail('roots contains duplicates');

    const visited = new Set();
    const visiting = new Set();
    const visit = nodeId => {
        if (visiting.has(nodeId)) fail(`schema contains a cycle at ${nodeId}`);
        if (visited.has(nodeId)) return;
        visiting.add(nodeId);
        for (const childId of value.childIndex[nodeId] || []) visit(childId);
        visiting.delete(nodeId);
        visited.add(nodeId);
    };
    for (const rootId of value.roots) visit(rootId);
    if (visited.size !== nodeIds.length) fail('not every node is reachable from roots');
    return value;
}

class YangCompiler {
    constructor(options = {}) {
        if (!options.repository) {
            throw new Error('YangCompiler requires a YangRepository');
        }
        this.repository = options.repository;
        this.cacheDir = path.resolve(options.cacheDir || this.repository.paths.compiled);
        this.compilerPath = options.compilerPath || process.env.NETNEXUS_YANGLINT_PATH || DEFAULT_COMPILER_EXECUTABLE;
        this.compilerArgs = Array.isArray(options.compilerArgs) ? options.compilerArgs.slice() : [];
        this.schemaHelperPath = options.schemaHelperPath || process.env.NETNEXUS_LIBYANG_SCHEMA_PATH || null;
        this.schemaHelperArgs = Array.isArray(options.schemaHelperArgs) ? options.schemaHelperArgs.slice() : [];
        this.runtime = options.runtime || null;
        this.runtimeOptions = {
            resourcesPath: options.resourcesPath,
            appPath: options.appPath,
            devResourcesPath: options.devResourcesPath,
            isPackaged: options.isPackaged,
            platform: options.platform,
            arch: options.arch,
            schemaExecutablePath: this.schemaHelperPath,
            schemaHelperArgs: this.schemaHelperArgs
        };
        this.searchPaths = normalizeStringList(options.searchPaths || options.schemaSearchPaths);
        this.externalTimeout = normalizePositiveInteger(
            options.externalTimeout,
            DEFAULT_EXTERNAL_TIMEOUT,
            100,
            10 * 60_000
        );
        this.externalMaxBuffer = normalizePositiveInteger(
            options.externalMaxBuffer,
            DEFAULT_EXTERNAL_MAX_BUFFER,
            1024,
            64 * 1024 * 1024
        );
        this.versionTimeout = normalizePositiveInteger(options.versionTimeout, DEFAULT_VERSION_TIMEOUT, 100, 30_000);
        this.results = new Map();
        this.latestCompileId = null;
        fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    emitProgress(onProgress, payload) {
        if (typeof onProgress !== 'function') return;
        try {
            onProgress(payload);
        } catch (_error) {
            // Progress observers cannot fail a compilation.
        }
    }

    createProgress(onProgress, total) {
        const counts = { parsed: 0, failed: 0 };
        return (phase, extra = {}) => {
            if (extra.counts) {
                Object.assign(counts, extra.counts);
            }
            const completed = extra.completed ?? counts.parsed;
            let percent = extra.percent;
            if (percent === undefined) {
                if (phase === 'completed') percent = 100;
                else if (phase === 'parsing') percent = total ? Math.round((completed / total) * 55) : 55;
                else if (phase === 'dependencies') percent = 65;
                else if (phase === 'external') percent = 78;
                else if (phase === 'schema') percent = 88;
                else if (phase === 'caching') percent = 97;
                else percent = 0;
            }
            this.emitProgress(onProgress, {
                phase,
                completed,
                total,
                percent,
                ...extra,
                counts: { ...counts }
            });
        };
    }

    async getCompilerStatus(options = {}) {
        const runtime = this.createRuntime(options);
        return runtime.getStatus({ force: options.forceRuntimeDiscovery === true });
    }

    createRuntime(options = {}) {
        if (options.runtime) return options.runtime;
        const compilerPath = options.compilerPath || this.compilerPath || DEFAULT_COMPILER_EXECUTABLE;
        const compilerArgs = Array.isArray(options.compilerArgs) ? options.compilerArgs : this.compilerArgs;
        const schemaHelperPath = options.schemaHelperPath || this.schemaHelperPath;
        const schemaHelperArgs = Array.isArray(options.schemaHelperArgs)
            ? options.schemaHelperArgs
            : this.schemaHelperArgs;
        const usesDefaultCompilerArgs =
            options.compilerArgs === undefined ||
            (compilerArgs.length === this.compilerArgs.length &&
                compilerArgs.every((argument, index) => argument === this.compilerArgs[index]));
        const usesDefaultSchemaArgs = options.schemaHelperArgs === undefined;
        const usesDefaultRuntime =
            options.compilerPath === undefined &&
            options.schemaHelperPath === undefined &&
            options.env === undefined &&
            usesDefaultCompilerArgs &&
            usesDefaultSchemaArgs;
        if (this.runtime && usesDefaultRuntime) return this.runtime;
        const runtime = new LibyangRuntime({
            ...this.runtimeOptions,
            executablePath: compilerPath,
            schemaExecutablePath: schemaHelperPath,
            schemaHelperArgs,
            env: options.env || process.env,
            discoveryTimeoutMs: normalizePositiveInteger(options.versionTimeout, this.versionTimeout, 100, 30_000),
            versionArgs: [...compilerArgs, '--version']
        });
        if (usesDefaultRuntime) this.runtime = runtime;
        return runtime;
    }

    getCompilerIdentity(status, schemaHelperArgs) {
        let validatorFileState = null;
        let schemaFileState = null;
        try {
            const stats = fs.statSync(status.path);
            validatorFileState = { size: stats.size, mtimeMs: stats.mtimeMs };
        } catch (_error) {
            // Runtime status already contains a clear availability error.
        }
        try {
            const stats = fs.statSync(status.schemaPath);
            schemaFileState = { size: stats.size, mtimeMs: stats.mtimeMs };
        } catch (_error) {
            // Runtime status already contains a clear availability error.
        }
        return {
            type: 'netnexus-libyang-schema',
            engine: 'libyang',
            available: status.available,
            path: status.schemaPath,
            validatorPath: status.path,
            source: status.source,
            version: status.schemaVersion || status.version,
            versionOutput: status.schemaVersionOutput || status.versionOutput,
            runtimeRoot: status.runtimeRoot || null,
            moduleSearchPath: status.moduleSearchPath || null,
            schemaContractVersion: status.schemaContractVersion || null,
            capabilities: status.capabilities || null,
            args: schemaHelperArgs,
            validatorFileState,
            schemaFileState
        };
    }

    calculateHashes(entries, options, compilerStatus, schemaHelperArgs) {
        const contentHash = sha256(
            Buffer.from(
                entries
                    .map(entry => entry.hash)
                    .sort()
                    .join('\n'),
                'utf8'
            )
        );
        const configuredSearchPaths = normalizeStringList(
            options.searchPaths || options.schemaSearchPaths || this.searchPaths
        ).map(searchPath => path.resolve(searchPath));
        const deviationFilePaths = externalDeviationPaths(options.deviations).map(deviationPath =>
            path.resolve(deviationPath)
        );
        const context = {
            schemaVersion: COMPILE_CACHE_SCHEMA_VERSION,
            contentHash,
            features: normalizeCacheValues(options.features),
            deviations: normalizeCacheValues(options.deviations),
            deviationFiles: deviationFilePaths.map(schemaFileFingerprint),
            searchPaths: configuredSearchPaths,
            bundledSchemas: compilerStatus.moduleSearchPath
                ? schemaSearchPathFingerprint(compilerStatus.moduleSearchPath)
                : null,
            externalMaxBuffer: normalizePositiveInteger(
                options.externalMaxBuffer,
                this.externalMaxBuffer,
                1024,
                64 * 1024 * 1024
            ),
            externalTimeout: normalizePositiveInteger(options.externalTimeout, this.externalTimeout, 100, 10 * 60_000),
            compiler: this.getCompilerIdentity(compilerStatus, schemaHelperArgs)
        };
        return {
            contentHash,
            contextHash: sha256(Buffer.from(stableStringify(context), 'utf8')),
            cacheable: configuredSearchPaths.length === 0 && deviationFilePaths.length === 0,
            context
        };
    }

    readCache(contextHash) {
        const cachePath = path.join(this.cacheDir, contextHash, 'result.json');
        if (!fs.existsSync(cachePath)) return null;
        try {
            const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (
                cache.schemaVersion !== COMPILE_CACHE_SCHEMA_VERSION ||
                cache.contextHash !== contextHash ||
                cache.result?.success !== true ||
                !cache.tree
            ) {
                return null;
            }
            validateAuthoritativeSchemaTree(cache.tree);
            return cache;
        } catch (_error) {
            return null;
        }
    }

    saveCache(contextHash, publicResult, tree) {
        const cachePath = path.join(this.cacheDir, contextHash, 'result.json');
        atomicWriteJson(cachePath, {
            schemaVersion: COMPILE_CACHE_SCHEMA_VERSION,
            contextHash,
            savedAt: new Date().toISOString(),
            result: publicResult,
            tree
        });
    }

    installResult(result, tree) {
        this.results.set(result.compileId, { result, tree });
        this.latestCompileId = result.compileId;
    }

    loadModule(entry) {
        const sourcePath = entry.filePath;
        if (!sourcePath) throw new Error(`YANG module ${entry.hash} has no workspace-local source file`);
        const buffer = fs.readFileSync(sourcePath);
        const actualHash = sha256(buffer);
        if (actualHash !== entry.hash) {
            throw new Error(`YANG module integrity check failed for ${entry.hash}`);
        }
        const source = buffer.toString('utf8');
        const parsed = parseYang(source, { sourceName: entry.fileName || entry.hash });
        return {
            id: `${parsed.metadata?.kind || 'invalid'}:${parsed.metadata?.name || entry.hash}@${parsed.metadata?.revision || 'none'}#${entry.hash.slice(0, 12)}`,
            hash: entry.hash,
            fileName: entry.fileName,
            filePath: sourcePath,
            size: entry.size,
            metadata: parsed.metadata,
            diagnostics: parsed.diagnostics
        };
    }

    buildDependencyGraph(modules) {
        const diagnostics = [];
        const groups = new Map();
        for (const module of modules) {
            if (!module.metadata?.name) continue;
            const key = `${module.metadata.kind}:${module.metadata.name}:${module.metadata.revision || ''}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(module);
        }

        for (const [key, candidates] of groups) {
            if (candidates.length > 1) {
                const [kind, name, revision] = key.split(':');
                diagnostics.push({
                    severity: 'error',
                    code: 'DUPLICATE_REVISION',
                    message: `${kind} ${name}@${revision || 'none'} has ${candidates.length} different source files`,
                    source: candidates.map(candidate => candidate.fileName).join(', '),
                    line: 1,
                    column: 1
                });
            }
        }

        const nodes = modules.map(module => ({
            id: module.id,
            hash: module.hash,
            fileName: module.fileName,
            kind: module.metadata?.kind || 'invalid',
            name: module.metadata?.name || module.fileName,
            revision: module.metadata?.revision || null
        }));
        const edges = [];
        const missing = [];
        const moduleById = new Map(modules.map(module => [module.id, module]));

        const selectTarget = (kind, name, revisionDate) => {
            const candidates = modules.filter(
                module => module.metadata?.kind === kind && module.metadata?.name === name
            );
            if (revisionDate) {
                return candidates.find(candidate => candidate.metadata.revision === revisionDate) || null;
            }
            return (
                candidates.sort((left, right) =>
                    (right.metadata.revision || '').localeCompare(left.metadata.revision || '')
                )[0] || null
            );
        };

        const addDependency = (source, type, name, revisionDate, location = {}) => {
            const targetKind = type === 'include' ? 'submodule' : 'module';
            const target = selectTarget(targetKind, name, revisionDate);
            const edge = {
                from: source.id,
                to: target?.id || null,
                type,
                name,
                revisionDate: revisionDate || null,
                resolved: Boolean(target)
            };
            edges.push(edge);
            if (!target) {
                const item = {
                    from: source.id,
                    type,
                    name,
                    revisionDate: revisionDate || null
                };
                missing.push(item);
                diagnostics.push({
                    severity: 'error',
                    code: 'MISSING_DEPENDENCY',
                    message: `${source.metadata.kind} ${source.metadata.name} requires ${targetKind} ${name}${revisionDate ? `@${revisionDate}` : ''}`,
                    source: source.fileName,
                    line: location.line || 1,
                    column: location.column || 1,
                    dependency: item
                });
            }
        };

        for (const module of modules) {
            if (!module.metadata) continue;
            for (const dependency of module.metadata.imports || []) {
                addDependency(module, 'import', dependency.name, dependency.revisionDate, dependency);
            }
            for (const dependency of module.metadata.includes || []) {
                addDependency(module, 'include', dependency.name, dependency.revisionDate, dependency);
            }
            if (module.metadata.kind === 'submodule' && module.metadata.belongsTo) {
                addDependency(module, 'belongs-to', module.metadata.belongsTo, null, {});
            }
        }

        const adjacency = new Map(nodes.map(node => [node.id, []]));
        edges
            .filter(edge => edge.to && edge.type !== 'belongs-to')
            .forEach(edge => adjacency.get(edge.from)?.push(edge.to));
        const visiting = new Set();
        const visited = new Set();
        const cycleKeys = new Set();
        const visit = (id, stack) => {
            if (visiting.has(id)) {
                const cycleStart = stack.indexOf(id);
                const cycle = [...stack.slice(cycleStart), id];
                const cycleKey = cycle.slice(0, -1).sort().join('|');
                if (!cycleKeys.has(cycleKey)) {
                    cycleKeys.add(cycleKey);
                    diagnostics.push({
                        severity: 'warning',
                        code: 'DEPENDENCY_CYCLE',
                        message: `Dependency cycle: ${cycle.map(nodeId => moduleById.get(nodeId)?.metadata?.name || nodeId).join(' -> ')}`,
                        source: moduleById.get(id)?.fileName || null,
                        line: 1,
                        column: 1
                    });
                }
                return;
            }
            if (visited.has(id)) return;
            visiting.add(id);
            stack.push(id);
            for (const target of adjacency.get(id) || []) visit(target, stack);
            stack.pop();
            visiting.delete(id);
            visited.add(id);
        };
        nodes.forEach(node => visit(node.id, []));

        return { graph: { nodes, edges, missing }, diagnostics };
    }

    materializeExternalInputs(contextHash, modules) {
        const inputDirectory = path.join(this.cacheDir, contextHash, 'inputs');
        fs.mkdirSync(inputDirectory, { recursive: true });
        const usedNames = new Set();
        const inputs = modules.map(module => {
            const metadata = module.metadata;
            const preferredName = metadata?.name
                ? `${metadata.name}${metadata.revision ? `@${metadata.revision}` : ''}.yang`
                : module.fileName || `${module.hash}.yang`;
            const sanitizedName = preferredName.replace(/[^A-Za-z0-9_.@-]/g, '_');
            let fileName = sanitizedName;
            if (usedNames.has(fileName)) {
                fileName = `${path.basename(sanitizedName, '.yang')}-${module.hash.slice(0, 12)}.yang`;
            }
            usedNames.add(fileName);
            const targetPath = path.join(inputDirectory, fileName);
            if (!fs.existsSync(targetPath)) {
                fs.copyFileSync(module.filePath, targetPath, fs.constants.COPYFILE_EXCL);
            }
            return { module, path: targetPath };
        });
        return { inputDirectory, inputs };
    }

    normalizeFeatureArguments(features, modules) {
        const byModule = new Map();
        const add = (moduleName, featureNames) => {
            if (!moduleName) return;
            if (!byModule.has(moduleName)) byModule.set(moduleName, new Set());
            for (const featureName of normalizeStringList(featureNames)) {
                byModule.get(moduleName).add(featureName);
            }
        };
        for (const feature of Array.isArray(features) ? features : features ? [features] : []) {
            if (typeof feature === 'string') {
                const separator = feature.indexOf(':');
                if (separator > 0) {
                    add(feature.slice(0, separator), feature.slice(separator + 1).split(','));
                    continue;
                }
                for (const module of modules) {
                    if (module.metadata?.features?.includes(feature)) add(module.metadata.name, [feature]);
                }
                continue;
            }
            if (!feature || typeof feature !== 'object') continue;
            const moduleName = feature.module || feature.moduleName || feature.name;
            add(moduleName, feature.features || feature.enabled || feature.feature || []);
        }
        return [...byModule.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([moduleName, enabled]) => `${moduleName}:${[...enabled].sort().join(',')}`);
    }

    resolveDeviationInputs(deviations, inputs) {
        const requested = Array.isArray(deviations) ? deviations : deviations ? [deviations] : [];
        const resolved = [];
        const diagnostics = [];
        for (const deviation of requested) {
            const descriptor =
                typeof deviation === 'string' &&
                (path.isAbsolute(deviation) ||
                    deviation.includes('/') ||
                    deviation.includes('\\') ||
                    /\.yang$/i.test(deviation))
                    ? { path: deviation }
                    : typeof deviation === 'string'
                      ? { name: deviation }
                      : deviation || {};
            const explicitPath = descriptor.path || descriptor.filePath;
            if (explicitPath) {
                const resolvedPath = path.resolve(explicitPath);
                try {
                    const stats = fs.statSync(resolvedPath);
                    if (!stats.isFile()) {
                        diagnostics.push({
                            severity: 'error',
                            code: 'DEVIATION_INVALID_FILE',
                            message: `Requested deviation is not a regular file: ${resolvedPath}`,
                            source: resolvedPath,
                            line: null,
                            column: null,
                            authoritative: true,
                            origin: 'compiler-host'
                        });
                        continue;
                    }
                    fs.accessSync(resolvedPath, fs.constants.R_OK);
                    resolved.push(resolvedPath);
                } catch (error) {
                    diagnostics.push({
                        severity: 'error',
                        code: error.code === 'ENOENT' ? 'DEVIATION_NOT_FOUND' : 'DEVIATION_UNREADABLE',
                        message: `Cannot use requested deviation ${resolvedPath}: ${error.message}`,
                        source: resolvedPath,
                        line: null,
                        column: null,
                        authoritative: true,
                        origin: 'compiler-host'
                    });
                }
                continue;
            }
            const name = descriptor.name || descriptor.module || descriptor.moduleName;
            const revision = descriptor.revision || descriptor.revisionDate;
            const hash = descriptor.hash;
            const match = inputs.find(input => {
                const metadata = input.module.metadata || {};
                return (
                    (!hash || input.module.hash === hash) &&
                    (!name || metadata.name === name) &&
                    (!revision || metadata.revision === revision)
                );
            });
            if (match) {
                resolved.push(match.path);
            } else {
                diagnostics.push({
                    severity: 'error',
                    code: 'DEVIATION_NOT_FOUND',
                    message: `Requested deviation module was not found: ${name || hash || '<unspecified>'}${revision ? `@${revision}` : ''}`,
                    source: name || hash || null,
                    line: null,
                    column: null,
                    authoritative: true,
                    origin: 'compiler-host'
                });
            }
        }
        return { paths: [...new Set(resolved)], diagnostics };
    }

    parseExternalDiagnostics(output, defaultSeverity = 'info') {
        const diagnostics = [];
        for (const rawLine of String(output || '').split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            let match = line.match(/^YANGLINT\[([EWI])\]\s*:\s*(.+)$/i);
            if (match) {
                diagnostics.push({
                    severity:
                        match[1].toUpperCase() === 'E' ? 'error' : match[1].toUpperCase() === 'W' ? 'warning' : 'info',
                    code: 'LIBYANG',
                    message: match[2],
                    source: null,
                    line: null,
                    column: null,
                    raw: rawLine,
                    authoritative: true
                });
                continue;
            }
            match = line.match(/^libyang\[(\d+)\]\s*:\s*(.+)$/i);
            if (match) {
                const level = Number(match[1]);
                const location = match[2].match(/\(path:\s*([^,)]+)(?:,\s*line(?: number)?\s*(\d+))?\)/i);
                const lineOnly = match[2].match(/\bline(?: number)?\s*(\d+)\b/i);
                diagnostics.push({
                    severity: level === 0 ? 'error' : level === 1 ? 'warning' : 'info',
                    code: 'LIBYANG',
                    message: match[2],
                    source: location?.[1]?.trim() || null,
                    line: location?.[2] ? Number(location[2]) : lineOnly?.[1] ? Number(lineOnly[1]) : null,
                    column: null,
                    raw: rawLine,
                    authoritative: true
                });
                continue;
            }
            match = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning|info)\s*:\s*(.+)$/i);
            if (match) {
                diagnostics.push({
                    severity: match[4].toLowerCase(),
                    code: 'LIBYANG',
                    message: match[5],
                    source: match[1],
                    line: Number(match[2]),
                    column: Number(match[3]),
                    raw: rawLine,
                    authoritative: true
                });
                continue;
            }
            match = line.match(/^(?:libyang\s+)?(err|error|warn|warning|info)\s*:\s*(.+)$/i);
            if (match) {
                const severityToken = match[1].toLowerCase();
                const location = match[2].match(/\(path:\s*([^,)]+)(?:,\s*line(?: number)?\s*(\d+))?\)/i);
                const lineOnly = match[2].match(/\bline(?: number)?\s*(\d+)\b/i);
                diagnostics.push({
                    severity:
                        severityToken === 'err' || severityToken === 'error'
                            ? 'error'
                            : severityToken.startsWith('warn')
                              ? 'warning'
                              : 'info',
                    code: 'LIBYANG',
                    message: match[2],
                    source: location?.[1]?.trim() || null,
                    line: location?.[2] ? Number(location[2]) : lineOnly?.[1] ? Number(lineOnly[1]) : null,
                    column: null,
                    raw: rawLine,
                    authoritative: true
                });
                continue;
            }
            diagnostics.push({
                severity: /error|invalid|failed/i.test(line) ? 'error' : defaultSeverity,
                code: 'LIBYANG_OUTPUT',
                message: line,
                source: null,
                line: null,
                column: null,
                raw: rawLine,
                authoritative: true
            });
        }
        return diagnostics;
    }

    async runLibyangSchemaCompiler(runtime, compilerStatus, contextHash, modules, options) {
        const materialized = this.materializeExternalInputs(contextHash, modules);
        const bundledSearchPath =
            compilerStatus.moduleSearchPath ||
            (compilerStatus.runtimeRoot
                ? path.join(compilerStatus.runtimeRoot, 'share', 'yang', 'modules', 'libyang')
                : null);
        const featureArguments = this.normalizeFeatureArguments(options.features, modules);
        const deviationResolution = this.resolveDeviationInputs(options.deviations, materialized.inputs);
        const deviationPaths = deviationResolution.paths;
        if (deviationResolution.diagnostics.length) {
            return {
                invoked: false,
                succeeded: false,
                path: compilerStatus.schemaPath,
                args: [],
                generatedArgs: [],
                searchPaths: [],
                features: featureArguments,
                deviations: deviationPaths,
                timeout: null,
                maxBuffer: null,
                exitCode: null,
                signal: null,
                durationMs: null,
                timedOut: false,
                outputTruncated: false,
                diagnostics: deviationResolution.diagnostics,
                tree: null
            };
        }
        /* libyang searches its configured directories in reverse insertion order. Keep the
         * authoritative workspace directory last so it wins over user and bundled fallbacks. */
        const searchPaths = normalizeStringList([
            ...(bundledSearchPath && fs.existsSync(bundledSearchPath) ? [bundledSearchPath] : []),
            ...normalizeStringList(options.searchPaths || options.schemaSearchPaths || this.searchPaths),
            ...deviationPaths.map(deviationPath => path.dirname(deviationPath)),
            materialized.inputDirectory
        ]).map(searchPath => path.resolve(searchPath));
        const schemaPaths = materialized.inputs
            .filter(input => input.module.metadata?.kind === 'module')
            .map(input => input.path);
        const schemaPathKeys = new Set(schemaPaths.map(normalizedPathKey));
        const externalDeviationPaths = deviationPaths.filter(
            deviationPath => !schemaPathKeys.has(normalizedPathKey(deviationPath))
        );
        const generatedArgs = [];
        for (const searchPath of searchPaths) generatedArgs.push('-p', searchPath);
        for (const featureArgument of featureArguments) generatedArgs.push('-F', featureArgument);
        /* A repository module is already parsed as an implemented top-level module, so libyang
         * applies any deviations it defines automatically and its own schema remains exportable.
         * -D is reserved for additional files outside the selected repository inputs. */
        for (const deviationPath of externalDeviationPaths) generatedArgs.push('-D', deviationPath);
        const args = [...generatedArgs, ...schemaPaths];
        const timeout = normalizePositiveInteger(options.externalTimeout, this.externalTimeout, 100, 10 * 60_000);
        const maxBuffer = normalizePositiveInteger(
            options.externalMaxBuffer,
            this.externalMaxBuffer,
            1024,
            64 * 1024 * 1024
        );
        let result;
        try {
            if (typeof runtime.executeSchema !== 'function') {
                const error = new Error('The configured libyang runtime does not provide schema export');
                error.code = 'LIBYANG_SCHEMA_UNAVAILABLE';
                throw error;
            }
            result = await runtime.executeSchema(args, {
                cwd: materialized.inputDirectory,
                timeoutMs: timeout,
                maxOutputBytes: maxBuffer,
                env: options.env || process.env
            });
        } catch (error) {
            result = {
                stdout: '',
                stderr: '',
                exitCode: null,
                signal: null,
                timedOut: error.code === 'LIBYANG_SCHEMA_TIMEOUT',
                outputLimitExceeded: error.code === 'LIBYANG_SCHEMA_OUTPUT_LIMIT',
                durationMs: null,
                error
            };
        }
        const diagnostics = this.parseExternalDiagnostics(result.stderr, 'warning');
        const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;
        let tree = null;
        if (!result.error && exitCode === 0) {
            try {
                tree = validateAuthoritativeSchemaTree(JSON.parse(result.stdout));
            } catch (error) {
                diagnostics.push({
                    severity: 'error',
                    code: 'LIBYANG_SCHEMA_INVALID_OUTPUT',
                    message: error.message,
                    source: compilerStatus.schemaPath,
                    line: null,
                    column: null,
                    authoritative: true
                });
            }
        }
        if ((result.error || exitCode !== 0) && !diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
            const outputLimit = result.outputLimitExceeded || result.error?.code === 'LIBYANG_SCHEMA_OUTPUT_LIMIT';
            diagnostics.push({
                severity: 'error',
                code: outputLimit
                    ? 'LIBYANG_SCHEMA_OUTPUT_LIMIT'
                    : result.timedOut
                      ? 'LIBYANG_SCHEMA_TIMEOUT'
                      : result.error
                        ? 'LIBYANG_SCHEMA_EXECUTION_FAILED'
                        : 'LIBYANG_SCHEMA_FAILED',
                message:
                    result.error?.message ||
                    `libyang schema helper exited with code ${exitCode} without an error diagnostic`,
                source: compilerStatus.schemaPath,
                line: null,
                column: null,
                authoritative: true
            });
        }
        return {
            invoked: true,
            succeeded: !result.error && exitCode === 0 && Boolean(tree),
            path: compilerStatus.schemaPath,
            args,
            generatedArgs,
            searchPaths,
            features: featureArguments,
            deviations: deviationPaths,
            timeout,
            maxBuffer,
            exitCode,
            signal: result.signal || null,
            durationMs: result.durationMs,
            timedOut: Boolean(result.timedOut),
            outputTruncated: Boolean(result.outputLimitExceeded),
            diagnostics,
            tree
        };
    }

    publicModules(modules) {
        return modules.map(module => ({
            id: module.id,
            hash: module.hash,
            fileName: module.fileName,
            size: module.size,
            metadata: module.metadata,
            diagnosticCount: module.diagnostics.length
        }));
    }

    async compile(options = {}) {
        const entries = this.repository.resolveEntries({
            hashes: options.hashes,
            workspaceId: options.workspaceId,
            snapshotId: options.snapshotId
        });
        const uniqueEntries = [...new Map(entries.map(entry => [entry.hash, entry])).values()];
        const schemaHelperArgs = Array.isArray(options.schemaHelperArgs)
            ? options.schemaHelperArgs
            : this.schemaHelperArgs;
        const progress = this.createProgress(options.onProgress, uniqueEntries.length);
        progress('preparing', { message: 'Preparing YANG compilation' });
        const runtime = this.createRuntime({
            compilerPath: options.compilerPath,
            compilerArgs: options.compilerArgs,
            schemaHelperPath: options.schemaHelperPath,
            schemaHelperArgs,
            versionTimeout: options.versionTimeout,
            env: options.env,
            runtime: options.runtime
        });
        const compilerStatus = await runtime.getStatus({ force: options.forceRuntimeDiscovery === true });
        const hashes = this.calculateHashes(uniqueEntries, options, compilerStatus, schemaHelperArgs);
        const compileId = hashes.contextHash;
        progress('runtime', {
            percent: 5,
            message: compilerStatus.available
                ? `Using libyang ${compilerStatus.version}`
                : 'Required libyang runtime is unavailable',
            compileId,
            compiler: compilerStatus
        });

        if (!options.force && hashes.cacheable) {
            const inMemory = this.results.get(compileId);
            if (inMemory?.result?.success === true) {
                this.latestCompileId = compileId;
                const result = { ...inMemory.result, cacheHit: true };
                progress('completed', {
                    completed: uniqueEntries.length,
                    percent: 100,
                    message: 'YANG compilation loaded from memory cache',
                    cacheHit: true,
                    compileId
                });
                return result;
            }
            const cached = this.readCache(compileId);
            if (cached) {
                const result = { ...cached.result, cacheHit: true };
                this.installResult(result, cached.tree);
                progress('completed', {
                    completed: uniqueEntries.length,
                    percent: 100,
                    message: 'YANG compilation loaded from disk cache',
                    cacheHit: true,
                    compileId
                });
                return result;
            }
        }

        const modules = [];
        const diagnostics = [];
        for (let index = 0; index < uniqueEntries.length; index += 1) {
            const entry = uniqueEntries[index];
            try {
                const module = this.loadModule(entry);
                modules.push(module);
                diagnostics.push(
                    ...module.diagnostics.map(diagnostic => ({
                        ...diagnostic,
                        authoritative: false,
                        origin: 'repository-index'
                    }))
                );
            } catch (error) {
                diagnostics.push({
                    severity: 'error',
                    code: 'SOURCE_READ_FAILED',
                    message: error.message,
                    source: entry.fileName,
                    line: 1,
                    column: 1,
                    authoritative: true,
                    origin: 'compiler-host'
                });
            }
            const failed = diagnostics.filter(diagnostic => diagnostic.severity === 'error').length;
            const completed = index + 1;
            progress('parsing', {
                completed,
                currentFile: entry.fileName,
                message: `Parsed ${entry.fileName}`,
                counts: { parsed: completed, failed }
            });
        }

        progress('dependencies', { completed: uniqueEntries.length, message: 'Resolving imports and includes' });
        const dependencies = this.buildDependencyGraph(modules);
        diagnostics.push(
            ...dependencies.diagnostics.map(diagnostic => ({
                ...diagnostic,
                authoritative: false,
                origin: 'repository-index'
            }))
        );

        let externalCompiler = {
            invoked: false,
            succeeded: false,
            path: compilerStatus.schemaPath,
            args: [],
            exitCode: null,
            timedOut: false,
            outputTruncated: false,
            diagnostics: [],
            tree: null
        };
        if (compilerStatus.available && modules.some(module => module.metadata?.kind === 'module')) {
            progress('external', {
                completed: uniqueEntries.length,
                message: 'Compiling and exporting the effective schema with libyang'
            });
            externalCompiler = await this.runLibyangSchemaCompiler(
                runtime,
                compilerStatus,
                compileId,
                modules,
                options
            );
            diagnostics.push(...externalCompiler.diagnostics);
            progress('schema', {
                completed: uniqueEntries.length,
                message: externalCompiler.tree
                    ? 'Authoritative libyang effective schema loaded'
                    : 'Authoritative libyang schema export failed'
            });
        } else if (!compilerStatus.available) {
            diagnostics.push(compilerUnavailableDiagnostic(compilerStatus));
        } else {
            diagnostics.push({
                severity: 'error',
                code: 'NO_TOP_LEVEL_YANG_MODULE',
                message: 'No readable top-level YANG module is available for libyang validation',
                source: null,
                line: null,
                column: null,
                authoritative: true,
                origin: 'compiler-host'
            });
        }

        const finalDiagnostics = deduplicateDiagnostics(diagnostics);
        const errorCount = finalDiagnostics.filter(diagnostic => diagnostic.severity === 'error').length;
        const authoritativeErrorCount = finalDiagnostics.filter(
            diagnostic => diagnostic.severity === 'error' && diagnostic.authoritative !== false
        ).length;
        const indexErrorCount = finalDiagnostics.filter(
            diagnostic => diagnostic.severity === 'error' && diagnostic.authoritative === false
        ).length;
        const warningCount = finalDiagnostics.filter(diagnostic => diagnostic.severity === 'warning').length;
        const tree = externalCompiler.tree;
        const succeeded = externalCompiler.succeeded === true && Boolean(tree) && authoritativeErrorCount === 0;
        const publicResult = {
            success: succeeded,
            cacheHit: false,
            compileId,
            contentHash: hashes.contentHash,
            contextHash: hashes.contextHash,
            compiledAt: new Date().toISOString(),
            modules: this.publicModules(modules),
            diagnostics: finalDiagnostics,
            dependencyGraph: dependencies.graph,
            schemaTree: tree
                ? {
                      authoritative: true,
                      source: 'libyang-effective',
                      scope: tree.scope,
                      rootId: tree.rootId,
                      roots: tree.roots.map(id => nodesPublicView(tree.nodes[id])),
                      nodeCount: tree.nodeCount
                  }
                : null,
            externalCompiler: {
                invoked: externalCompiler.invoked,
                succeeded: externalCompiler.succeeded,
                path: externalCompiler.path,
                args: externalCompiler.args,
                generatedArgs: externalCompiler.generatedArgs || [],
                searchPaths: externalCompiler.searchPaths || [],
                features: externalCompiler.features || [],
                deviations: externalCompiler.deviations || [],
                timeout: externalCompiler.timeout || null,
                maxBuffer: externalCompiler.maxBuffer || null,
                exitCode: externalCompiler.exitCode,
                signal: externalCompiler.signal || null,
                durationMs: externalCompiler.durationMs || null,
                timedOut: externalCompiler.timedOut,
                outputTruncated: externalCompiler.outputTruncated
            },
            compiler: compilerStatus,
            validation: {
                authoritative: true,
                engine: 'libyang',
                succeeded
            },
            summary: {
                requested: uniqueEntries.length,
                parsed: modules.length,
                modules: modules.filter(module => module.metadata?.kind === 'module').length,
                submodules: modules.filter(module => module.metadata?.kind === 'submodule').length,
                missingDependencies: dependencies.graph.missing.length,
                schemaNodes: tree?.nodeCount || 0,
                errors: errorCount,
                authoritativeErrors: authoritativeErrorCount,
                indexErrors: indexErrorCount,
                warnings: warningCount
            }
        };

        if (succeeded && hashes.cacheable) {
            progress('caching', { completed: uniqueEntries.length, message: 'Saving YANG compilation cache' });
            this.saveCache(compileId, publicResult, tree);
        }
        /* Failed compilations expose no Schema contract. Keep only an empty query
         * index so diagnostics remain addressable by compileId. */
        this.installResult(publicResult, tree || emptySchemaIndex());
        progress('completed', {
            completed: uniqueEntries.length,
            percent: 100,
            message: publicResult.success ? 'YANG compilation completed' : 'YANG compilation completed with errors',
            cacheHit: false,
            compileId,
            success: publicResult.success,
            counts: { parsed: modules.length, failed: errorCount }
        });
        return publicResult;
    }

    resolveCompilation(compileId) {
        const id = compileId || this.latestCompileId;
        if (!id || !this.results.has(id)) {
            throw new Error('No YANG compilation is active; compile the workspace first');
        }
        return this.results.get(id);
    }

    getSchemaRoots(compileId) {
        const compilation = this.resolveCompilation(compileId);
        return compilation.tree.roots.map(id => nodesPublicView(compilation.tree.nodes[id]));
    }

    getSchemaChildren(parentId = ROOT_NODE_ID, compileId) {
        const compilation = this.resolveCompilation(compileId);
        const effectiveParentId = parentId || compilation.tree.rootId;
        return (compilation.tree.childIndex[effectiveParentId] || []).map(id =>
            nodesPublicView(compilation.tree.nodes[id])
        );
    }

    getSchemaNode(nodeId, compileId) {
        const compilation = this.resolveCompilation(compileId);
        const node = compilation.tree.nodes[nodeId];
        return node ? nodesPublicView(node) : null;
    }

    dataValidationSchemaPaths(externalCompiler = {}) {
        const args = Array.isArray(externalCompiler.args) ? externalCompiler.args : [];
        const generatedArgs = Array.isArray(externalCompiler.generatedArgs) ? externalCompiler.generatedArgs : [];
        let schemaPaths = generatedArgs.length <= args.length ? args.slice(generatedArgs.length) : [];
        if (!schemaPaths.length) {
            const optionWithValue = new Set(['-p', '--path', '-F', '--features', '-D']);
            schemaPaths = [];
            for (let index = 0; index < args.length; index += 1) {
                if (optionWithValue.has(args[index])) {
                    index += 1;
                    continue;
                }
                if (!args[index].startsWith('-')) schemaPaths.push(args[index]);
            }
        }
        const seen = new Set(schemaPaths.map(normalizedPathKey));
        for (const deviationPath of externalCompiler.deviations || []) {
            const key = normalizedPathKey(deviationPath);
            if (seen.has(key)) continue;
            seen.add(key);
            schemaPaths.push(deviationPath);
        }
        return schemaPaths.map(filePath => path.resolve(filePath));
    }

    async validateRpc(options = {}) {
        const rpc = String(options.rpc ?? '');
        if (Buffer.byteLength(rpc, 'utf8') > MAX_RPC_VALIDATION_BYTES) {
            const error = new Error(`RPC exceeds the ${MAX_RPC_VALIDATION_BYTES} byte validation limit`);
            error.code = 'RPC_VALIDATION_SIZE_LIMIT';
            throw error;
        }
        const compilation = this.resolveCompilation(options.compileId);
        if (compilation.result?.success !== true) {
            const error = new Error('The active YANG compilation did not complete successfully');
            error.code = 'YANG_COMPILATION_UNAVAILABLE';
            throw error;
        }
        const target = resolveRpcValidationTarget(rpc);
        if (target.skipped) {
            return {
                valid: true,
                diagnostics: [],
                operation: target.operation,
                engine: 'libyang',
                authoritative: true,
                performed: false,
                validationType: null,
                skippedReason: target.reason
            };
        }

        const externalCompiler = compilation.result.externalCompiler || {};
        const schemaPaths = this.dataValidationSchemaPaths(externalCompiler);
        const missingSchema = schemaPaths.find(schemaPath => !fs.existsSync(schemaPath));
        if (!schemaPaths.length || missingSchema) {
            const error = new Error(
                missingSchema
                    ? `Compiled YANG input is no longer available: ${missingSchema}`
                    : 'The active YANG compilation has no reusable schema inputs'
            );
            error.code = 'YANG_VALIDATION_CONTEXT_UNAVAILABLE';
            throw error;
        }

        const runtime = this.createRuntime(options);
        const compilerStatus = await runtime.getStatus();
        if (!compilerStatus.available || compilerStatus.capabilities?.dataValidation !== true) {
            const error = new Error(compilerStatus.error || 'The bundled libyang runtime cannot validate data');
            error.code = 'LIBYANG_DATA_VALIDATION_UNAVAILABLE';
            throw error;
        }

        const searchPaths = normalizeStringList(externalCompiler.searchPaths).map(searchPath =>
            path.resolve(searchPath)
        );
        const features = normalizeStringList(externalCompiler.features);
        const args = [];
        for (const searchPath of searchPaths) args.push('-p', searchPath);
        for (const feature of features) args.push('-F', feature);

        const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'netnexus-rpc-validation-'));
        const inputPath = path.join(temporaryDirectory, 'rpc-payload.xml');
        const payload = buildRpcValidationPayload(rpc, target.nodes);
        try {
            await fs.promises.writeFile(inputPath, payload, { encoding: 'utf8', mode: 0o600 });
            const execution = await runtime.execute(
                [...args, '-I', 'xml', '-t', target.validationType, ...schemaPaths, inputPath],
                {
                    cwd: path.dirname(schemaPaths[0]),
                    timeoutMs: normalizePositiveInteger(
                        options.timeoutMs,
                        Math.min(this.externalTimeout, 30_000),
                        100,
                        60_000
                    ),
                    maxOutputBytes: normalizePositiveInteger(
                        options.maxOutputBytes,
                        Math.min(this.externalMaxBuffer, 2 * 1024 * 1024),
                        1024,
                        8 * 1024 * 1024
                    ),
                    env: options.env || process.env
                }
            );
            if (execution.error) throw execution.error;

            const parsed = this.parseExternalDiagnostics(execution.stderr, 'warning');
            let failures = parsed.filter(
                diagnostic => diagnostic.severity === 'error' && !isSecondaryYanglintDiagnostic(diagnostic)
            );
            if (execution.exitCode !== 0 && failures.length === 0) {
                failures = [
                    {
                        severity: 'error',
                        code: 'LIBYANG_DATA_VALIDATION_FAILED',
                        message:
                            String(execution.stderr || execution.stdout || '').trim() ||
                            `yanglint exited with code ${execution.exitCode}`,
                        line: lineAt(rpc, target.nodes[0]?.start || 0)
                    }
                ];
            }
            const fallbackLine = lineAt(rpc, target.nodes[0]?.start || 0);
            const diagnostics = deduplicateDiagnostics(
                failures.map(diagnostic => normalizeLibyangRpcDiagnostic(rpc, diagnostic, fallbackLine))
            );
            return {
                valid: execution.exitCode === 0 && diagnostics.length === 0,
                diagnostics,
                operation: target.operation,
                engine: 'libyang',
                authoritative: true,
                performed: true,
                validationType: target.validationType,
                skippedReason: ''
            };
        } finally {
            await fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
        }
    }

    getDiagnostics(compileId) {
        return this.resolveCompilation(compileId).result.diagnostics;
    }

    getResult(compileId) {
        return this.resolveCompilation(compileId).result;
    }
}

function nodesPublicView(node) {
    return node ? { ...node } : null;
}

module.exports = {
    YangCompiler,
    ROOT_NODE_ID,
    COMPILE_CACHE_SCHEMA_VERSION,
    LIBYANG_SCHEMA_OUTPUT_VERSION,
    validateAuthoritativeSchemaTree
};
