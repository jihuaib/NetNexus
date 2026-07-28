const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseYang } = require('./yangParser');
const { sha256, stableStringify, atomicWriteFile, atomicWriteJson } = require('./yangRepository');
const { LibyangRuntime } = require('./libyangRuntime');
const {
    buildRpcValidationPayload,
    isSecondaryYanglintDiagnostic,
    lineAt,
    normalizeLibyangRpcDiagnostic,
    resolveRpcValidationTarget
} = require('./yangRpcInstanceValidation');

const COMPILE_CACHE_SCHEMA_VERSION = 7;
const LIBYANG_SCHEMA_OUTPUT_VERSION = 3;
const DEFAULT_COMPILER_EXECUTABLE = 'yanglint';
const DEFAULT_EXTERNAL_TIMEOUT = 60_000;
const DEFAULT_EXTERNAL_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_VERSION_TIMEOUT = 5_000;
const MAX_RPC_VALIDATION_BYTES = 8 * 1024 * 1024;
const ROOT_NODE_ID = 'yang-schema-root';
const FILE_VALIDATION_CONCURRENCY = 3;
const LIBYANG_BASE_TYPES = new Set([
    'binary',
    'bits',
    'boolean',
    'decimal64',
    'empty',
    'enumeration',
    'identityref',
    'instance-identifier',
    'int8',
    'int16',
    'int32',
    'int64',
    'leafref',
    'string',
    'uint8',
    'uint16',
    'uint32',
    'uint64',
    'union'
]);

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

function terminalSchemaNodePrefix(value) {
    const terminalNode = String(value || '')
        .trim()
        .split('/')
        .filter(Boolean)
        .at(-1);
    const match = String(terminalNode || '').match(/^\s*(?:([A-Za-z_][A-Za-z0-9_.-]*)\s*:)?[A-Za-z_][A-Za-z0-9_.-]*/u);
    return match ? match[1] || '' : null;
}

function validationContextError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
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
        const typedNode = node.keyword === 'leaf' || node.keyword === 'leaf-list';
        if (node.baseType !== null && (typeof node.baseType !== 'string' || !node.baseType)) {
            fail(`node ${nodeId} baseType must be a non-empty string or null`);
        }
        if (typedNode && node.baseType === null) {
            fail(`typed node ${nodeId} must declare its baseType`);
        }
        if (typedNode && !LIBYANG_BASE_TYPES.has(node.baseType)) {
            fail(`typed node ${nodeId} has unknown baseType ${node.baseType}`);
        }
        if (!typedNode && node.baseType !== null) {
            fail(`non-typed node ${nodeId} baseType must be null`);
        }
        if (typedNode && typeof node.acceptsEmptyString !== 'boolean') {
            fail(`typed node ${nodeId} acceptsEmptyString must be boolean`);
        }
        if (!typedNode && node.acceptsEmptyString !== null) {
            fail(`non-typed node ${nodeId} acceptsEmptyString must be null`);
        }
        if (!Array.isArray(node.enumValues)) {
            fail(`node ${nodeId} enumValues must be an array`);
        }
        if (node.baseType !== 'enumeration' && node.enumValues.length > 0) {
            fail(`non-enumeration node ${nodeId} must not declare enumValues`);
        }
        if (node.baseType === 'enumeration' && node.enumValues.length === 0) {
            fail(`enumeration node ${nodeId} must declare at least one enum value`);
        }
        const enumNames = new Set();
        const enumNumbers = new Set();
        for (const [enumIndex, enumValue] of node.enumValues.entries()) {
            if (!isObject(enumValue)) fail(`node ${nodeId} enumValues[${enumIndex}] must be an object`);
            if (typeof enumValue.name !== 'string' || !enumValue.name) {
                fail(`node ${nodeId} enumValues[${enumIndex}] has no name`);
            }
            if (
                !Number.isSafeInteger(enumValue.value) ||
                enumValue.value < -2_147_483_648 ||
                enumValue.value > 2_147_483_647
            ) {
                fail(`node ${nodeId} enumValues[${enumIndex}] value must be a signed 32-bit integer`);
            }
            for (const field of ['description', 'reference']) {
                if (enumValue[field] !== null && typeof enumValue[field] !== 'string') {
                    fail(`node ${nodeId} enumValues[${enumIndex}] ${field} must be a string or null`);
                }
            }
            if (!['current', 'deprecated', 'obsolete'].includes(enumValue.status)) {
                fail(`node ${nodeId} enumValues[${enumIndex}] has an invalid status`);
            }
            if (enumNames.has(enumValue.name)) fail(`node ${nodeId} has duplicate enum name ${enumValue.name}`);
            if (enumNumbers.has(enumValue.value)) fail(`node ${nodeId} has duplicate enum value ${enumValue.value}`);
            enumNames.add(enumValue.name);
            enumNumbers.add(enumValue.value);
        }
        if (!Array.isArray(node.schemaKey) || node.schemaKey.some(name => typeof name !== 'string' || !name)) {
            fail(`node ${nodeId} schemaKey must be an array of non-empty strings`);
        }
        if (new Set(node.schemaKey).size !== node.schemaKey.length) {
            fail(`node ${nodeId} schemaKey contains duplicates`);
        }
        if (!Array.isArray(node.schemaKeyDetails)) {
            fail(`node ${nodeId} schemaKeyDetails must be an array`);
        }
        if (node.keyword !== 'list' && (node.schemaKey.length || node.schemaKeyDetails.length)) {
            fail(`non-list node ${nodeId} must not declare schema keys`);
        }
        if (node.schemaKeyDetails.length !== node.schemaKey.length) {
            fail(`list node ${nodeId} schemaKeyDetails must match schemaKey`);
        }
        const detailedKeyNames = new Set();
        node.schemaKeyDetails.forEach((detail, keyIndex) => {
            if (!isObject(detail)) fail(`node ${nodeId} schemaKeyDetails[${keyIndex}] must be an object`);
            if (typeof detail.name !== 'string' || !detail.name) {
                fail(`node ${nodeId} schemaKeyDetails[${keyIndex}] has no name`);
            }
            if (typeof detail.acceptsEmptyString !== 'boolean') {
                fail(`node ${nodeId} schemaKeyDetails[${keyIndex}] acceptsEmptyString must be boolean`);
            }
            if (detail.name !== node.schemaKey[keyIndex]) {
                fail(`node ${nodeId} schemaKeyDetails must use schemaKey order`);
            }
            if (detailedKeyNames.has(detail.name)) {
                fail(`node ${nodeId} schemaKeyDetails contains duplicate ${detail.name}`);
            }
            detailedKeyNames.add(detail.name);
        });
        if (node.presence !== null && typeof node.presence !== 'boolean') {
            fail(`node ${nodeId} presence must be boolean or null`);
        }
        const children = value.childIndex[nodeId];
        if (!Array.isArray(children)) fail(`node ${nodeId} has no childIndex entry`);
        if (node.keyword === 'list') {
            node.schemaKeyDetails.forEach(detail => {
                const keyNode = children
                    .map(childId => value.nodes[childId])
                    .find(child => child?.keyword === 'leaf' && child.name === detail.name);
                if (!keyNode) {
                    fail(`list node ${nodeId} schema key ${detail.name} has no direct leaf`);
                }
                if (keyNode.acceptsEmptyString !== detail.acceptsEmptyString) {
                    fail(`list node ${nodeId} schema key ${detail.name} empty-string metadata does not match its leaf`);
                }
            });
        }
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

    materializeSchemaPathList(inputDirectory, schemaPaths) {
        if (!schemaPaths.length) return null;
        const content = Buffer.from(`${schemaPaths.map(schemaPath => path.resolve(schemaPath)).join('\0')}\0`, 'utf8');
        const listPath = path.join(inputDirectory, `.schema-${sha256(content).slice(0, 24)}.list`);
        atomicWriteFile(listPath, content);
        return listPath;
    }

    readSchemaPathList(listPath) {
        const content = fs.readFileSync(listPath);
        if (!content.length || content[content.length - 1] !== 0) {
            throw new Error(`Invalid schema path list: ${listPath}`);
        }
        const schemaPaths = content
            .subarray(0, content.length - 1)
            .toString('utf8')
            .split('\0');
        if (schemaPaths.some(schemaPath => !schemaPath)) {
            throw new Error(`Invalid empty entry in schema path list: ${listPath}`);
        }
        return schemaPaths;
    }

    schemaInputDescriptors(inputs, deviationPaths = []) {
        const descriptors = inputs.map(input => ({
            hash: input.module.hash,
            path: path.resolve(input.path),
            externalDeviation: false
        }));
        const knownPaths = new Set(descriptors.map(descriptor => normalizedPathKey(descriptor.path)));
        for (const deviationPath of deviationPaths) {
            const resolvedPath = path.resolve(deviationPath);
            if (knownPaths.has(normalizedPathKey(resolvedPath))) continue;
            const source = fs.readFileSync(resolvedPath);
            const parsed = parseYang(source.toString('utf8'), { sourceName: path.basename(resolvedPath) });
            descriptors.push({
                hash: sha256(source),
                path: resolvedPath,
                externalDeviation: true,
                metadata: parsed.metadata
            });
            knownPaths.add(normalizedPathKey(resolvedPath));
        }
        return descriptors;
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

    moduleDependencyClosure(modules, rootHashes) {
        if (!rootHashes) return modules;
        const requested = rootHashes instanceof Set ? rootHashes : new Set(rootHashes);
        const selectTarget = (kind, name, revisionDate) =>
            modules
                .filter(module => module.metadata?.kind === kind && module.metadata?.name === name)
                .filter(module => !revisionDate || module.metadata?.revision === revisionDate)
                .sort((left, right) =>
                    (right.metadata?.revision || '').localeCompare(left.metadata?.revision || '')
                )[0] || null;
        const closure = new Map();
        const queue = modules.filter(module => requested.has(module.hash));
        while (queue.length) {
            const module = queue.shift();
            if (!module?.hash || closure.has(module.hash)) continue;
            closure.set(module.hash, module);
            for (const dependency of module.metadata?.imports || []) {
                const target = selectTarget('module', dependency.name, dependency.revisionDate);
                if (target && !closure.has(target.hash)) queue.push(target);
            }
            for (const dependency of module.metadata?.includes || []) {
                const target = selectTarget('submodule', dependency.name, dependency.revisionDate);
                if (target && !closure.has(target.hash)) queue.push(target);
            }
            if (module.metadata?.kind === 'submodule' && module.metadata.belongsTo) {
                const target = selectTarget('module', module.metadata.belongsTo);
                if (target && !closure.has(target.hash)) queue.push(target);
            }
        }
        return [...closure.values()];
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

    async runLibyangSchemaCompiler(runtime, compilerStatus, contextHash, modules, options, rootHashes = null) {
        const materialized = this.materializeExternalInputs(contextHash, modules);
        const bundledSearchPath =
            compilerStatus.moduleSearchPath ||
            (compilerStatus.runtimeRoot
                ? path.join(compilerStatus.runtimeRoot, 'share', 'yang', 'modules', 'libyang')
                : null);
        const activeModules = this.moduleDependencyClosure(modules, rootHashes);
        const activeModuleNames = new Set(activeModules.map(module => module.metadata?.name).filter(Boolean));
        for (const module of activeModules) {
            for (const dependency of module.metadata?.imports || []) activeModuleNames.add(dependency.name);
        }
        const configuredFeatureArguments = this.normalizeFeatureArguments(options.features, modules);
        let featureArguments = rootHashes
            ? configuredFeatureArguments.filter(argument =>
                  activeModuleNames.has(argument.slice(0, argument.indexOf(':')))
              )
            : configuredFeatureArguments;
        if (rootHashes && configuredFeatureArguments.length && featureArguments.length === 0) {
            const rootModule = modules.find(module => rootHashes.has(module.hash));
            if (rootModule?.metadata?.name) featureArguments = [`${rootModule.metadata.name}:`];
        }
        const deviationResolution = this.resolveDeviationInputs(options.deviations, materialized.inputs);
        const deviationPaths = deviationResolution.paths;
        const schemaInputs = this.schemaInputDescriptors(materialized.inputs, deviationPaths);
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
                schemaInputs,
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
            .filter(
                input => input.module.metadata?.kind === 'module' && (!rootHashes || rootHashes.has(input.module.hash))
            )
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
        const schemaListPath = this.materializeSchemaPathList(materialized.inputDirectory, schemaPaths);
        const args = [...generatedArgs, '--schema-list', schemaListPath];
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
            const primaryOutputDiagnostic = !result.error
                ? diagnostics.find(diagnostic =>
                      /error|invalid|fail|unknown\s+option|unable\s+to|cannot|not\s+found|missing|required/iu.test(
                          String(diagnostic.message || '')
                      )
                  ) || diagnostics[0]
                : null;
            if (primaryOutputDiagnostic) {
                primaryOutputDiagnostic.severity = 'error';
                if (primaryOutputDiagnostic.code === 'LIBYANG_OUTPUT') {
                    primaryOutputDiagnostic.code = 'LIBYANG_SCHEMA_FAILED';
                }
            } else {
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
            schemaInputs,
            schemaListPath,
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

    async buildFileResults({
        entries,
        modules,
        dependencies,
        succeeded,
        runtime,
        compilerStatus,
        compileId,
        options,
        progress,
        compileDiagnostics = []
    }) {
        const compactDiagnostic = (diagnostic, fallbackSource = null) => {
            if (!diagnostic?.message) return null;
            const line = Number(diagnostic.line);
            const column = Number(diagnostic.column);
            return {
                severity: String(diagnostic.severity || 'error').toLowerCase(),
                code: diagnostic.code || 'YANG_COMPILE_FAILED',
                message: String(diagnostic.message),
                source: diagnostic.source || fallbackSource,
                line:
                    diagnostic.line !== null &&
                    diagnostic.line !== undefined &&
                    diagnostic.line !== '' &&
                    Number.isFinite(line)
                        ? line
                        : null,
                column:
                    diagnostic.column !== null &&
                    diagnostic.column !== undefined &&
                    diagnostic.column !== '' &&
                    Number.isFinite(column)
                        ? column
                        : null,
                authoritative: diagnostic.authoritative !== false
            };
        };
        const createResult = (entry, module, status, diagnosticCount = 0, diagnostic = null) => ({
            hash: entry.hash,
            moduleId: module?.id || entry.hash,
            name: module?.metadata?.name || entry.metadata?.name || entry.fileName,
            revision: module?.metadata?.revision || entry.metadata?.revision || null,
            kind: module?.metadata?.kind || entry.metadata?.kind || 'invalid',
            fileName: entry.fileName,
            status,
            compileStatus: status,
            compiled: status === 'compiled',
            diagnosticCount,
            ...(diagnostic ? { diagnostic } : {})
        });
        const modulesByHash = new Map(modules.map(module => [module.hash, module]));
        if (succeeded) {
            return entries.map(entry => createResult(entry, modulesByHash.get(entry.hash), 'compiled'));
        }

        const topLevelModules = modules.filter(module => module.metadata?.kind === 'module');
        const statusByModuleId = new Map();
        const diagnosticsByModuleId = new Map();
        const primaryDiagnosticByModuleId = new Map();
        let nextIndex = 0;
        let completed = 0;
        const validateNext = async () => {
            while (nextIndex < topLevelModules.length) {
                const index = nextIndex++;
                const module = topLevelModules[index];
                let validation;
                if (compilerStatus.available) {
                    validation = await this.runLibyangSchemaCompiler(
                        runtime,
                        compilerStatus,
                        compileId,
                        modules,
                        options,
                        new Set([module.hash])
                    );
                } else {
                    validation = { succeeded: false, diagnostics: [] };
                }
                const validationDiagnostics = Array.isArray(validation.diagnostics) ? validation.diagnostics : [];
                const primaryDiagnostic = compactDiagnostic(
                    validationDiagnostics.find(diagnostic => diagnostic.severity === 'error') ||
                        validationDiagnostics[0],
                    module.fileName
                );
                statusByModuleId.set(module.id, validation.succeeded ? 'compiled' : 'failed');
                diagnosticsByModuleId.set(module.id, validationDiagnostics.length);
                if (primaryDiagnostic) primaryDiagnosticByModuleId.set(module.id, primaryDiagnostic);
                completed += 1;
                progress('file-validation', {
                    completed,
                    total: topLevelModules.length,
                    percent: 88 + Math.round((completed / Math.max(1, topLevelModules.length)) * 7),
                    currentFile: module.fileName,
                    currentHash: module.hash,
                    currentName: module.metadata?.name || module.fileName,
                    currentRevision: module.metadata?.revision || null,
                    fileStatus: validation.succeeded ? 'compiled' : 'failed',
                    message: `${module.fileName} ${validation.succeeded ? 'compiled successfully' : 'failed compilation'}`,
                    diagnostic: primaryDiagnostic || undefined
                });
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(FILE_VALIDATION_CONCURRENCY, Math.max(1, topLevelModules.length)) }, () =>
                validateNext()
            )
        );

        const incomingEdges = new Map();
        for (const edge of dependencies.graph.edges || []) {
            if (!edge.to) continue;
            if (!incomingEdges.has(edge.to)) incomingEdges.set(edge.to, []);
            incomingEdges.get(edge.to).push(edge.from);
        }
        const pendingSubmodules = modules.filter(module => module.metadata?.kind === 'submodule');
        for (let pass = 0; pass <= pendingSubmodules.length; pass += 1) {
            let changed = false;
            for (const module of pendingSubmodules) {
                if (statusByModuleId.has(module.id)) continue;
                const parentStatuses = (incomingEdges.get(module.id) || [])
                    .map(parentId => statusByModuleId.get(parentId))
                    .filter(Boolean);
                if (parentStatuses.includes('compiled')) {
                    statusByModuleId.set(module.id, 'compiled');
                    changed = true;
                } else if (parentStatuses.length) {
                    statusByModuleId.set(module.id, 'failed');
                    changed = true;
                }
            }
            if (!changed) break;
        }
        for (const module of pendingSubmodules) {
            if (!statusByModuleId.has(module.id)) statusByModuleId.set(module.id, 'failed');
        }

        return entries.map(entry => {
            const module = modulesByHash.get(entry.hash);
            const status = module ? statusByModuleId.get(module.id) || 'failed' : 'failed';
            const diagnosticCount = module
                ? diagnosticsByModuleId.get(module.id) || module.diagnostics?.length || 0
                : 1;
            const entryName = module?.metadata?.name || entry.metadata?.name || '';
            const matchingCompileDiagnostic = compileDiagnostics.find(diagnostic => {
                if (diagnostic.severity !== 'error') return false;
                const sourceName = String(diagnostic.source || '')
                    .split(/[\\/]/u)
                    .pop();
                return sourceName === entry.fileName || (entryName && diagnostic.module === entryName);
            });
            const diagnostic =
                (module && primaryDiagnosticByModuleId.get(module.id)) ||
                compactDiagnostic(
                    matchingCompileDiagnostic ||
                        module?.diagnostics?.find(item => item.severity === 'error') ||
                        (entries.length === 1 ? compileDiagnostics.find(item => item.severity === 'error') : null),
                    entry.fileName
                );
            return createResult(entry, module, status, diagnosticCount, status === 'failed' ? diagnostic : null);
        });
    }

    publicModules(modules, fileResults = []) {
        const resultsByHash = new Map(fileResults.map(result => [result.hash, result]));
        return modules.map(module => ({
            id: module.id,
            hash: module.hash,
            fileName: module.fileName,
            size: module.size,
            metadata: module.metadata,
            diagnosticCount: module.diagnostics.length,
            compileStatus: resultsByHash.get(module.hash)?.status || 'pending',
            compiled: resultsByHash.get(module.hash)?.status === 'compiled'
        }));
    }

    publicCompilerExecution(execution = {}, extra = {}) {
        return {
            invoked: Boolean(execution.invoked),
            succeeded: Boolean(execution.succeeded),
            path: execution.path || null,
            args: execution.args || [],
            generatedArgs: execution.generatedArgs || [],
            searchPaths: execution.searchPaths || [],
            features: execution.features || [],
            deviations: execution.deviations || [],
            schemaInputs: execution.schemaInputs || [],
            schemaListPath: execution.schemaListPath || null,
            timeout: execution.timeout || null,
            maxBuffer: execution.maxBuffer || null,
            exitCode: execution.exitCode ?? null,
            signal: execution.signal || null,
            durationMs: execution.durationMs || null,
            timedOut: Boolean(execution.timedOut),
            outputTruncated: Boolean(execution.outputTruncated),
            ...extra
        };
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
                currentHash: entry.hash,
                currentName: entry.metadata?.name || entry.fileName,
                currentRevision: entry.metadata?.revision || null,
                fileStatus: 'parsed',
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
        const aggregateTree = externalCompiler.tree;
        const succeeded =
            externalCompiler.succeeded === true && Boolean(aggregateTree) && authoritativeErrorCount === 0;
        const fileResults = await this.buildFileResults({
            entries: uniqueEntries,
            modules,
            dependencies,
            succeeded,
            runtime,
            compilerStatus,
            compileId,
            options,
            progress,
            compileDiagnostics: finalDiagnostics
        });
        fileResults.forEach((fileResult, index) => {
            const completed = index + 1;
            progress('file-result', {
                completed,
                total: fileResults.length,
                percent: 88 + Math.round((completed / Math.max(1, fileResults.length)) * 7),
                currentFile: fileResult.fileName,
                currentHash: fileResult.hash,
                currentName: fileResult.name,
                currentRevision: fileResult.revision,
                fileStatus: fileResult.status,
                diagnostic: fileResult.diagnostic || undefined,
                message: `${fileResult.fileName} ${
                    fileResult.status === 'compiled' ? 'compiled successfully' : 'failed compilation'
                }`
            });
        });
        const compiledFileCount = fileResults.filter(result => result.status === 'compiled').length;
        const failedFileCount = fileResults.filter(result => result.status === 'failed').length;
        const compiledTopLevelHashes = fileResults
            .filter(result => result.kind === 'module' && result.status === 'compiled')
            .map(result => result.hash);
        const failedTopLevelHashes = fileResults
            .filter(result => result.kind === 'module' && result.status === 'failed')
            .map(result => result.hash);
        let tree = aggregateTree;
        let schemaCompiler = externalCompiler;
        let partialSchema = !succeeded && Boolean(aggregateTree);
        if (
            !succeeded &&
            compilerStatus.available &&
            compiledTopLevelHashes.length > 0 &&
            failedTopLevelHashes.length > 0
        ) {
            progress('partial-schema', {
                completed: uniqueEntries.length,
                percent: 96,
                message: 'Building an authoritative Schema from successfully compiled modules'
            });
            const partialCompiler = await this.runLibyangSchemaCompiler(
                runtime,
                compilerStatus,
                compileId,
                modules,
                options,
                new Set(compiledTopLevelHashes)
            );
            if (partialCompiler.succeeded && partialCompiler.tree) {
                tree = partialCompiler.tree;
                schemaCompiler = partialCompiler;
                partialSchema = true;
            }
        }
        const schemaAvailable = Boolean(tree);
        const schemaModuleHashes = schemaAvailable
            ? partialSchema
                ? compiledTopLevelHashes
                : fileResults.filter(result => result.kind === 'module').map(result => result.hash)
            : [];
        const excludedModuleHashes = failedTopLevelHashes;
        const publicResult = {
            success: succeeded,
            schemaAvailable,
            partialSchema,
            cacheHit: false,
            compileId,
            contentHash: hashes.contentHash,
            contextHash: hashes.contextHash,
            compiledAt: new Date().toISOString(),
            modules: this.publicModules(modules, fileResults),
            moduleHashes: fileResults.map(result => result.hash),
            schemaModuleHashes,
            excludedModuleHashes,
            fileResults,
            diagnostics: finalDiagnostics,
            dependencyGraph: dependencies.graph,
            schemaTree: tree
                ? {
                      authoritative: true,
                      source: 'libyang-effective',
                      scope: tree.scope,
                      partial: partialSchema,
                      moduleHashes: schemaModuleHashes,
                      excludedModuleHashes,
                      rootId: tree.rootId,
                      roots: tree.roots.map(id => nodesPublicView(tree.nodes[id])),
                      nodeCount: tree.nodeCount
                  }
                : null,
            externalCompiler: this.publicCompilerExecution(externalCompiler),
            schemaCompiler: this.publicCompilerExecution(schemaCompiler, {
                partial: partialSchema,
                moduleHashes: schemaModuleHashes,
                excludedModuleHashes
            }),
            compiler: compilerStatus,
            validation: {
                authoritative: true,
                engine: 'libyang',
                succeeded,
                schemaAvailable,
                partial: partialSchema
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
                warnings: warningCount,
                compiledFiles: compiledFileCount,
                failedFiles: failedFileCount,
                schemaModules: schemaModuleHashes.length,
                excludedModules: excludedModuleHashes.length,
                partialSchema
            }
        };

        if (succeeded && hashes.cacheable) {
            progress('caching', { completed: uniqueEntries.length, message: 'Saving YANG compilation cache' });
            this.saveCache(compileId, publicResult, tree);
        }
        /* A mixed-result batch may expose a separately compiled authoritative Schema
         * for its valid roots. Batches without a safe combined subset keep an empty index. */
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
        const optionWithValue = new Set(['-p', '--path', '-F', '--features', '-D', '--deviation']);
        const schemaPaths = [];
        for (let index = 0; index < args.length; index += 1) {
            if (args[index] === '--schema-list') {
                const listPath = args[index + 1];
                if (listPath) schemaPaths.push(...this.readSchemaPathList(listPath));
                index += 1;
                continue;
            }
            if (optionWithValue.has(args[index])) {
                index += 1;
                continue;
            }
            if (!args[index].startsWith('-')) schemaPaths.push(args[index]);
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

    rpcValidationSchemaCatalog(compilation, schemaCompiler) {
        const modules = Array.isArray(compilation.result?.modules) ? compilation.result.modules : [];
        const modulesByHash = new Map(modules.map(module => [module.hash, module]));
        let inputs = Array.isArray(schemaCompiler.schemaInputs) ? schemaCompiler.schemaInputs : [];
        if (!inputs.length) {
            const deviationPaths = new Set(
                normalizeStringList(schemaCompiler.deviations).map(deviationPath => normalizedPathKey(deviationPath))
            );
            inputs = this.dataValidationSchemaPaths(schemaCompiler).map(schemaPath => {
                const source = fs.readFileSync(schemaPath);
                const hash = sha256(source);
                const parsed = parseYang(source.toString('utf8'), { sourceName: path.basename(schemaPath) });
                return {
                    hash,
                    path: schemaPath,
                    externalDeviation: deviationPaths.has(normalizedPathKey(schemaPath)),
                    metadata: parsed.metadata
                };
            });
        }
        return inputs.map(input => {
            const externalDeviation = input.externalDeviation === true;
            const module = externalDeviation ? null : modulesByHash.get(input.hash);
            return {
                ...(module || {}),
                hash: input.hash || module?.hash || '',
                path: path.resolve(input.path),
                metadata: input.metadata || module?.metadata || null,
                externalDeviation
            };
        });
    }

    deviationTargetsScope(metadata, targetModules) {
        if (!metadata || !Array.isArray(metadata.deviations) || !metadata.deviations.length) return false;
        const prefixes = new Map();
        const ownerName = metadata.kind === 'submodule' ? metadata.belongsTo : metadata.name;
        const ownerPrefix = metadata.kind === 'submodule' ? metadata.belongsToPrefix : metadata.prefix;
        const ownerRevision = metadata.kind === 'submodule' ? null : metadata.revision || null;
        if (ownerName && ownerPrefix) {
            prefixes.set(ownerPrefix, { name: ownerName, revisionDate: ownerRevision });
        }
        for (const imported of metadata.imports || []) {
            if (!imported?.prefix || !imported?.name) continue;
            prefixes.set(imported.prefix, {
                name: imported.name,
                revisionDate: imported.revisionDate || null
            });
        }
        return metadata.deviations.some(deviation => {
            /* The first path segment only identifies the datastore root. For augmented
             * data, the terminal node's prefix identifies the module whose schema is
             * actually changed by the deviation. */
            const prefix = terminalSchemaNodePrefix(deviation?.target);
            if (prefix === null) return false;
            const target = prefix ? prefixes.get(prefix) : { name: ownerName, revisionDate: ownerRevision };
            if (!target?.name) return false;
            return targetModules.some(
                module =>
                    module.metadata?.kind === 'module' &&
                    module.metadata?.name === target.name &&
                    (!target.revisionDate || module.metadata?.revision === target.revisionDate)
            );
        });
    }

    selectRpcValidationScope(compilation, schemaCompiler, target) {
        const catalog = this.rpcValidationSchemaCatalog(compilation, schemaCompiler);
        const repositoryModules = catalog.filter(input => !input.externalDeviation && input.hash && input.metadata);
        const configuredDeviationPaths = new Set(
            normalizeStringList(schemaCompiler.deviations).map(deviationPath => normalizedPathKey(deviationPath))
        );
        const configuredRepositoryDeviations = repositoryModules.filter(input =>
            configuredDeviationPaths.has(normalizedPathKey(input.path))
        );
        const activeRootHashes = new Set(
            normalizeStringList(
                Array.isArray(schemaCompiler.moduleHashes) && schemaCompiler.moduleHashes.length
                    ? schemaCompiler.moduleHashes
                    : compilation.result?.schemaModuleHashes
            )
        );
        if (!activeRootHashes.size) {
            repositoryModules
                .filter(module => module.metadata?.kind === 'module')
                .forEach(module => activeRootHashes.add(module.hash));
        }

        const availabilityRootHashes = new Set(activeRootHashes);
        configuredRepositoryDeviations.forEach(module => availabilityRootHashes.add(module.hash));
        for (const externalDeviation of catalog.filter(input => input.externalDeviation)) {
            for (const imported of externalDeviation.metadata?.imports || []) {
                const dependency = repositoryModules
                    .filter(module => module.metadata?.kind === 'module')
                    .filter(module => module.metadata?.name === imported.name)
                    .filter(module => !imported.revisionDate || module.metadata?.revision === imported.revisionDate)
                    .sort((left, right) =>
                        (right.metadata?.revision || '').localeCompare(left.metadata?.revision || '')
                    )[0];
                if (dependency?.hash) availabilityRootHashes.add(dependency.hash);
            }
        }
        const repositoryTopLevelModules = repositoryModules.filter(module => module.metadata?.kind === 'module');
        const availableModules = repositoryTopLevelModules.every(module => availabilityRootHashes.has(module.hash))
            ? repositoryModules
            : this.moduleDependencyClosure(repositoryModules, availabilityRootHashes);
        const availableTopLevelModules = availableModules.filter(module => module.metadata?.kind === 'module');
        const namespaces = normalizeStringList(target.namespaces);
        if (!namespaces.length) {
            throw validationContextError(
                'YANG_RPC_NAMESPACE_NOT_COMPILED',
                'The RPC payload does not identify a compiled YANG module namespace'
            );
        }

        const seedModules = new Map();
        const resolveNamespace = namespace => {
            const matches = availableTopLevelModules.filter(module => module.metadata?.namespace === namespace);
            if (matches.length > 1) {
                throw validationContextError(
                    'YANG_RPC_NAMESPACE_AMBIGUOUS',
                    `More than one compiled YANG module uses RPC payload namespace ${namespace}`
                );
            }
            if (!matches.length) {
                throw validationContextError(
                    'YANG_RPC_NAMESPACE_NOT_COMPILED',
                    `No active compiled YANG module uses RPC payload namespace ${namespace}`
                );
            }
            seedModules.set(matches[0].hash, matches[0]);
        };
        namespaces.forEach(resolveNamespace);
        if (!seedModules.size) {
            throw validationContextError(
                'YANG_RPC_NAMESPACE_NOT_COMPILED',
                'No active compiled YANG module matches the RPC payload'
            );
        }

        const baseClosure = this.moduleDependencyClosure(repositoryModules, new Set(seedModules.keys()));
        const baseTargetModules = baseClosure.filter(module => module.metadata?.kind === 'module');
        const candidateRootHashes = new Set(activeRootHashes);
        configuredRepositoryDeviations.forEach(module => candidateRootHashes.add(module.hash));
        const deviationSourcesByOwner = new Map();
        for (const source of repositoryModules) {
            if (!source.metadata?.deviations?.length) continue;
            const owner = source.metadata.kind === 'submodule' ? source.metadata.belongsTo : source.metadata.name;
            if (!owner) continue;
            if (!deviationSourcesByOwner.has(owner)) deviationSourcesByOwner.set(owner, []);
            deviationSourcesByOwner.get(owner).push(source);
        }
        const relevantDeviationRoots = repositoryModules.filter(module => {
            if (module.metadata?.kind !== 'module' || !candidateRootHashes.has(module.hash)) return false;
            const moduleSources = deviationSourcesByOwner.get(module.metadata.name) || [];
            return moduleSources.some(source => this.deviationTargetsScope(source.metadata, baseTargetModules));
        });
        const relevantExternalDeviations = catalog.filter(
            input => input.externalDeviation && this.deviationTargetsScope(input.metadata, baseTargetModules)
        );

        const scopeRootHashes = new Set(seedModules.keys());
        relevantDeviationRoots.forEach(module => scopeRootHashes.add(module.hash));
        for (const externalDeviation of relevantExternalDeviations) {
            for (const imported of externalDeviation.metadata?.imports || []) {
                const matches = repositoryModules
                    .filter(module => module.metadata?.kind === 'module' && module.metadata?.name === imported.name)
                    .filter(module => !imported.revisionDate || module.metadata?.revision === imported.revisionDate)
                    .sort((left, right) =>
                        (right.metadata?.revision || '').localeCompare(left.metadata?.revision || '')
                    );
                if (matches[0]?.hash) scopeRootHashes.add(matches[0].hash);
            }
        }
        const scopeModules = this.moduleDependencyClosure(repositoryModules, scopeRootHashes);
        const scopeHashes = new Set(scopeModules.map(module => module.hash));
        const relevantExternalPaths = new Set(relevantExternalDeviations.map(input => normalizedPathKey(input.path)));
        const selectedInputs = catalog.filter(input =>
            input.externalDeviation
                ? relevantExternalPaths.has(normalizedPathKey(input.path))
                : scopeHashes.has(input.hash)
        );
        const missingSchema = selectedInputs.find(input => !fs.existsSync(input.path));
        if (missingSchema) {
            throw validationContextError(
                'YANG_VALIDATION_CONTEXT_UNAVAILABLE',
                `Compiled YANG input is no longer available: ${missingSchema.path}`
            );
        }
        const schemaPaths = selectedInputs.filter(input => input.metadata?.kind === 'module').map(input => input.path);
        if (!schemaPaths.length) {
            throw validationContextError(
                'YANG_VALIDATION_CONTEXT_UNAVAILABLE',
                'The RPC payload has no reusable compiled YANG schema inputs'
            );
        }

        const scopeModuleNames = new Set(selectedInputs.map(input => input.metadata?.name).filter(Boolean));
        const configuredFeatures = normalizeStringList(schemaCompiler.features);
        let features = configuredFeatures.filter(feature => {
            const separator = feature.indexOf(':');
            return separator > 0 && scopeModuleNames.has(feature.slice(0, separator));
        });
        if (configuredFeatures.length && !features.length) {
            const seedModuleName = seedModules.values().next().value?.metadata?.name;
            if (seedModuleName) features = [`${seedModuleName}:`];
        }
        return {
            schemaPaths,
            features,
            namespaces,
            modules: selectedInputs
                .filter(input => input.metadata?.kind === 'module')
                .map(input => ({
                    name: input.metadata.name,
                    revision: input.metadata.revision || null,
                    namespace: input.metadata.namespace || null,
                    deviation:
                        relevantExternalPaths.has(normalizedPathKey(input.path)) ||
                        relevantDeviationRoots.some(module => module.hash === input.hash)
                }))
        };
    }

    async validateRpc(options = {}) {
        const rpc = String(options.rpc ?? '');
        if (Buffer.byteLength(rpc, 'utf8') > MAX_RPC_VALIDATION_BYTES) {
            const error = new Error(`RPC exceeds the ${MAX_RPC_VALIDATION_BYTES} byte validation limit`);
            error.code = 'RPC_VALIDATION_SIZE_LIMIT';
            throw error;
        }
        const compilation = this.resolveCompilation(options.compileId);
        if (compilation.result?.schemaAvailable !== true) {
            const error = new Error('The active YANG compilation has no authoritative Schema available');
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

        const schemaCompiler = compilation.result.schemaCompiler || compilation.result.externalCompiler || {};
        const validationScope = this.selectRpcValidationScope(compilation, schemaCompiler, target);
        const schemaPaths = validationScope.schemaPaths;

        const runtime = this.createRuntime(options);
        const compilerStatus = await runtime.getStatus();
        if (!compilerStatus.available || compilerStatus.capabilities?.dataValidation !== true) {
            const error = new Error(compilerStatus.error || 'The bundled libyang runtime cannot validate data');
            error.code = 'LIBYANG_DATA_VALIDATION_UNAVAILABLE';
            throw error;
        }

        const searchPaths = normalizeStringList(schemaCompiler.searchPaths).map(searchPath => path.resolve(searchPath));
        const args = [];
        for (const searchPath of searchPaths) args.push('-p', searchPath);
        for (const feature of validationScope.features) args.push('-F', feature);

        const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'netnexus-rpc-validation-'));
        const inputPath = path.join(temporaryDirectory, 'rpc-payload.xml');
        const payload = buildRpcValidationPayload(rpc, target.nodes);
        try {
            await fs.promises.writeFile(inputPath, payload, { encoding: 'utf8', mode: 0o600 });
            const execution = await runtime.execute(
                [
                    ...args,
                    /* Implement imports referenced by when/must/default expressions. Without
                     * this, schema-file ordering can leave an already imported module in the
                     * non-implemented state and make otherwise valid instance data fail. */
                    '-i',
                    '-I',
                    'xml',
                    '-t',
                    target.validationType,
                    ...schemaPaths,
                    inputPath
                ],
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
                namespaces: validationScope.namespaces,
                modules: validationScope.modules,
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
