const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { parseYang, findChild, statementValue } = require('./yangParser');
const { sha256, stableStringify, atomicWriteJson } = require('./yangRepository');
const { LibyangRuntime } = require('./libyangRuntime');

const COMPILE_CACHE_SCHEMA_VERSION = 2;
const DEFAULT_COMPILER_EXECUTABLE = 'yanglint';
const DEFAULT_EXTERNAL_TIMEOUT = 60_000;
const DEFAULT_EXTERNAL_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_VERSION_TIMEOUT = 5_000;
const ROOT_NODE_ID = 'yang-schema-root';
const SCHEMA_KEYWORDS = new Set([
    'container',
    'list',
    'leaf',
    'leaf-list',
    'choice',
    'case',
    'rpc',
    'action',
    'notification',
    'input',
    'output'
]);
const SCHEMA_WRAPPER_KEYWORDS = new Set(['augment']);

function normalizeBoolean(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
}

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

function runExecutable(executable, args, options = {}) {
    return new Promise(resolve => {
        execFile(
            executable,
            args,
            {
                cwd: options.cwd,
                timeout: options.timeout || DEFAULT_EXTERNAL_TIMEOUT,
                maxBuffer: options.maxBuffer || DEFAULT_EXTERNAL_MAX_BUFFER,
                windowsHide: true,
                env: options.env || process.env
            },
            (error, stdout, stderr) => resolve({ error, stdout: stdout || '', stderr: stderr || '' })
        );
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

function compilerUnavailableDiagnostic(status) {
    return {
        severity: 'error',
        code: 'YANGLINT_UNAVAILABLE',
        message: status.error || `Required libyang compiler ${status.executable} is not available`,
        source: status.path || status.executable,
        line: null,
        column: null,
        authoritative: true,
        installHint: status.installHint
    };
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
        this.runtime = options.runtime || null;
        this.runtimeOptions = {
            resourcesPath: options.resourcesPath,
            appPath: options.appPath,
            devResourcesPath: options.devResourcesPath,
            isPackaged: options.isPackaged,
            platform: options.platform,
            arch: options.arch
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
                else if (phase === 'schema') percent = 78;
                else if (phase === 'external') percent = 88;
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
        const usesDefaultCompilerArgs =
            options.compilerArgs === undefined ||
            (compilerArgs.length === this.compilerArgs.length &&
                compilerArgs.every((argument, index) => argument === this.compilerArgs[index]));
        const usesDefaultRuntime =
            options.compilerPath === undefined && options.env === undefined && usesDefaultCompilerArgs;
        if (this.runtime && usesDefaultRuntime) return this.runtime;
        const runtime = new LibyangRuntime({
            ...this.runtimeOptions,
            executablePath: compilerPath,
            env: options.env || process.env,
            discoveryTimeoutMs: normalizePositiveInteger(options.versionTimeout, this.versionTimeout, 100, 30_000),
            versionArgs: [...compilerArgs, '--version']
        });
        if (usesDefaultRuntime) this.runtime = runtime;
        return runtime;
    }

    getCompilerIdentity(status, compilerArgs) {
        let fileState = null;
        try {
            const stats = fs.statSync(status.path);
            fileState = { size: stats.size, mtimeMs: stats.mtimeMs };
        } catch (_error) {
            // Runtime status already contains a clear availability error.
        }
        return {
            type: 'yanglint',
            engine: 'libyang',
            available: status.available,
            path: status.path,
            source: status.source,
            version: status.version,
            versionOutput: status.versionOutput,
            runtimeRoot: status.runtimeRoot || null,
            moduleSearchPath: status.moduleSearchPath || null,
            capabilities: status.capabilities || null,
            args: compilerArgs,
            fileState
        };
    }

    calculateHashes(entries, options, compilerStatus, compilerArgs) {
        const contentHash = sha256(
            Buffer.from(
                entries
                    .map(entry => entry.hash)
                    .sort()
                    .join('\n'),
                'utf8'
            )
        );
        const context = {
            schemaVersion: COMPILE_CACHE_SCHEMA_VERSION,
            contentHash,
            features: normalizeCacheValues(options.features),
            deviations: normalizeCacheValues(options.deviations),
            searchPaths: normalizeStringList(options.searchPaths || options.schemaSearchPaths || this.searchPaths).map(
                searchPath => path.resolve(searchPath)
            ),
            externalMaxBuffer: normalizePositiveInteger(
                options.externalMaxBuffer,
                this.externalMaxBuffer,
                1024,
                64 * 1024 * 1024
            ),
            externalTimeout: normalizePositiveInteger(options.externalTimeout, this.externalTimeout, 100, 10 * 60_000),
            compiler: this.getCompilerIdentity(compilerStatus, compilerArgs)
        };
        return {
            contentHash,
            contextHash: sha256(Buffer.from(stableStringify(context), 'utf8')),
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
                !cache.tree
            ) {
                return null;
            }
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
        const buffer = fs.readFileSync(this.repository.getBlobPath(entry.hash));
        const actualHash = sha256(buffer);
        if (actualHash !== entry.hash) {
            throw new Error(`YANG blob integrity check failed for ${entry.hash}`);
        }
        const source = buffer.toString('utf8');
        const parsed = parseYang(source, { sourceName: entry.fileName || entry.hash });
        return {
            id: `${parsed.metadata?.kind || 'invalid'}:${parsed.metadata?.name || entry.hash}@${parsed.metadata?.revision || 'none'}#${entry.hash.slice(0, 12)}`,
            hash: entry.hash,
            fileName: entry.fileName,
            blobPath: this.repository.getBlobPath(entry.hash),
            size: entry.size,
            metadata: parsed.metadata,
            ast: parsed.ast,
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

    buildSchemaTree(modules) {
        const nodes = {};
        const childIndex = { [ROOT_NODE_ID]: [] };
        const roots = [];
        const addNode = node => {
            nodes[node.id] = node;
            if (!childIndex[node.parentId]) childIndex[node.parentId] = [];
            childIndex[node.parentId].push(node.id);
            if (!childIndex[node.id]) childIndex[node.id] = [];
        };

        for (const module of modules.filter(item => item.ast && item.metadata?.name)) {
            const moduleRootId = `yang-module-${module.hash.slice(0, 24)}`;
            const moduleNode = {
                id: moduleRootId,
                parentId: ROOT_NODE_ID,
                name: module.metadata.name,
                keyword: module.metadata.kind,
                module: module.metadata.name,
                revision: module.metadata.revision,
                namespace: module.metadata.namespace,
                description: module.metadata.description,
                path: `/${module.metadata.name}`,
                sourceHash: module.hash,
                hasChildren: false,
                childCount: 0
            };
            addNode(moduleNode);
            roots.push(moduleRootId);

            const occurrences = new Map();
            const visitStatements = (statements, parentId, parentPath, inheritedConfig = null) => {
                for (const statement of statements || []) {
                    if (SCHEMA_WRAPPER_KEYWORDS.has(statement.keyword)) {
                        visitStatements(statement.children, parentId, parentPath, inheritedConfig);
                        continue;
                    }
                    if (!SCHEMA_KEYWORDS.has(statement.keyword)) continue;
                    const localName = statement.argument || statement.keyword;
                    const basePath = `${parentPath}/${localName}`;
                    const occurrenceKey = `${module.hash}:${statement.keyword}:${basePath}`;
                    const occurrence = (occurrences.get(occurrenceKey) || 0) + 1;
                    occurrences.set(occurrenceKey, occurrence);
                    const schemaPath = occurrence === 1 ? basePath : `${basePath}[${occurrence}]`;
                    const id = `yang-node-${sha256(Buffer.from(`${module.hash}\u0000${statement.keyword}\u0000${schemaPath}`)).slice(0, 32)}`;
                    const explicitConfig = normalizeBoolean(statementValue(statement, 'config'));
                    const effectiveConfig = explicitConfig === null ? inheritedConfig : explicitConfig;
                    const typeStatement = findChild(statement, 'type');
                    const node = {
                        id,
                        parentId,
                        name: localName,
                        keyword: statement.keyword,
                        module: module.metadata.name,
                        revision: module.metadata.revision,
                        path: schemaPath,
                        description: statementValue(statement, 'description'),
                        reference: statementValue(statement, 'reference'),
                        status: statementValue(statement, 'status', 'current'),
                        config: effectiveConfig,
                        mandatory: normalizeBoolean(statementValue(statement, 'mandatory')),
                        type: typeStatement?.argument || null,
                        units: statementValue(statement, 'units'),
                        default: statementValue(statement, 'default'),
                        key: statementValue(statement, 'key'),
                        minElements: statementValue(statement, 'min-elements'),
                        maxElements: statementValue(statement, 'max-elements'),
                        presence: statementValue(statement, 'presence'),
                        ifFeatures: (statement.children || [])
                            .filter(child => child.keyword === 'if-feature')
                            .map(child => child.argument),
                        sourceHash: module.hash,
                        sourceLine: statement.line,
                        hasChildren: false,
                        childCount: 0
                    };
                    addNode(node);
                    visitStatements(statement.children, id, schemaPath, effectiveConfig);
                }
            };
            visitStatements(module.ast.children, moduleRootId, `/${module.metadata.name}`, null);
        }

        for (const node of Object.values(nodes)) {
            node.childCount = childIndex[node.id]?.length || 0;
            node.hasChildren = node.childCount > 0;
        }

        return {
            rootId: ROOT_NODE_ID,
            roots,
            nodes,
            childIndex,
            nodeCount: Object.keys(nodes).length
        };
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
                fs.copyFileSync(module.blobPath, targetPath, fs.constants.COPYFILE_EXCL);
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
                resolved.push(path.resolve(explicitPath));
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
            if (match) resolved.push(match.path);
        }
        return [...new Set(resolved)];
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
                    code: 'YANGLINT',
                    message: match[2],
                    source: null,
                    line: null,
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
                    code: 'YANGLINT',
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
                    code: 'YANGLINT',
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
                code: 'YANGLINT_OUTPUT',
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

    async runExternalCompiler(runtime, compilerStatus, compilerArgs, contextHash, modules, options) {
        const materialized = this.materializeExternalInputs(contextHash, modules);
        const bundledSearchPath =
            compilerStatus.moduleSearchPath ||
            (compilerStatus.runtimeRoot
                ? path.join(compilerStatus.runtimeRoot, 'share', 'yang', 'modules', 'libyang')
                : null);
        const searchPaths = normalizeStringList([
            materialized.inputDirectory,
            ...(bundledSearchPath && fs.existsSync(bundledSearchPath) ? [bundledSearchPath] : []),
            ...normalizeStringList(options.searchPaths || options.schemaSearchPaths || this.searchPaths)
        ]).map(searchPath => path.resolve(searchPath));
        const featureArguments = this.normalizeFeatureArguments(options.features, modules);
        const deviationPaths = this.resolveDeviationInputs(options.deviations, materialized.inputs);
        const schemaPaths = materialized.inputs
            .filter(input => input.module.metadata?.kind === 'module')
            .map(input => input.path);
        const generatedArgs = [];
        for (const searchPath of searchPaths) generatedArgs.push('-p', searchPath);
        for (const featureArgument of featureArguments) generatedArgs.push('-F', featureArgument);
        const additionalDeviationPaths = deviationPaths.filter(deviationPath => !schemaPaths.includes(deviationPath));
        const args = [...compilerArgs, ...generatedArgs, ...schemaPaths, ...additionalDeviationPaths];
        const timeout = normalizePositiveInteger(options.externalTimeout, this.externalTimeout, 100, 10 * 60_000);
        const maxBuffer = normalizePositiveInteger(
            options.externalMaxBuffer,
            this.externalMaxBuffer,
            1024,
            64 * 1024 * 1024
        );
        let result;
        try {
            result = await runtime.execute(args, {
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
                timedOut: error.code === 'YANGLINT_TIMEOUT',
                outputLimitExceeded: error.code === 'YANGLINT_OUTPUT_LIMIT',
                durationMs: null,
                error
            };
        }
        const diagnostics = [
            ...this.parseExternalDiagnostics(result.stdout, 'info'),
            ...this.parseExternalDiagnostics(result.stderr, 'warning')
        ];
        const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;
        if ((result.error || exitCode !== 0) && !diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
            const outputLimit = result.outputLimitExceeded || result.error?.code === 'YANGLINT_OUTPUT_LIMIT';
            diagnostics.push({
                severity: 'error',
                code: outputLimit
                    ? 'YANGLINT_OUTPUT_LIMIT'
                    : result.timedOut
                      ? 'YANGLINT_TIMEOUT'
                      : result.error
                        ? 'YANGLINT_EXECUTION_FAILED'
                        : 'YANGLINT_FAILED',
                message: result.error?.message || `yanglint exited with code ${exitCode} without an error diagnostic`,
                source: compilerStatus.path,
                line: null,
                column: null,
                authoritative: true
            });
        }
        return {
            invoked: true,
            succeeded: !result.error && exitCode === 0,
            path: compilerStatus.path,
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
            diagnostics
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
        const compilerArgs = Array.isArray(options.compilerArgs) ? options.compilerArgs : this.compilerArgs;
        const progress = this.createProgress(options.onProgress, uniqueEntries.length);
        progress('preparing', { message: 'Preparing YANG compilation' });
        const runtime = this.createRuntime({
            compilerPath: options.compilerPath,
            compilerArgs: options.compilerArgs,
            versionTimeout: options.versionTimeout,
            env: options.env,
            runtime: options.runtime
        });
        const compilerStatus = await runtime.getStatus({ force: options.forceRuntimeDiscovery === true });
        const hashes = this.calculateHashes(uniqueEntries, options, compilerStatus, compilerArgs);
        const compileId = hashes.contextHash;
        progress('runtime', {
            percent: 5,
            message: compilerStatus.available
                ? `Using libyang ${compilerStatus.version}`
                : 'Required libyang runtime is unavailable',
            compileId,
            compiler: compilerStatus
        });

        if (!options.force) {
            const inMemory = this.results.get(compileId);
            if (inMemory) {
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
                        origin: 'builtin-preview'
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
                origin: 'builtin-preview'
            }))
        );

        progress('schema', { completed: uniqueEntries.length, message: 'Building schema tree index' });
        const tree = this.buildSchemaTree(modules);

        let externalCompiler = {
            invoked: false,
            succeeded: false,
            path: compilerStatus.path,
            args: [],
            exitCode: null,
            timedOut: false,
            outputTruncated: false,
            diagnostics: []
        };
        if (compilerStatus.available && modules.some(module => module.metadata?.kind === 'module')) {
            progress('external', { completed: uniqueEntries.length, message: 'Running external yanglint compiler' });
            externalCompiler = await this.runExternalCompiler(
                runtime,
                compilerStatus,
                compilerArgs,
                compileId,
                modules,
                options
            );
            diagnostics.push(...externalCompiler.diagnostics);
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
        const previewErrorCount = finalDiagnostics.filter(
            diagnostic => diagnostic.severity === 'error' && diagnostic.authoritative === false
        ).length;
        const warningCount = finalDiagnostics.filter(diagnostic => diagnostic.severity === 'warning').length;
        const publicResult = {
            success: externalCompiler.succeeded === true && authoritativeErrorCount === 0,
            cacheHit: false,
            compileId,
            contentHash: hashes.contentHash,
            contextHash: hashes.contextHash,
            compiledAt: new Date().toISOString(),
            modules: this.publicModules(modules),
            diagnostics: finalDiagnostics,
            dependencyGraph: dependencies.graph,
            schemaTree: {
                authoritative: false,
                source: 'builtin-preview',
                rootId: tree.rootId,
                roots: tree.roots.map(id => nodesPublicView(tree.nodes[id])),
                nodeCount: tree.nodeCount
            },
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
                succeeded: externalCompiler.succeeded === true && authoritativeErrorCount === 0
            },
            summary: {
                requested: uniqueEntries.length,
                parsed: modules.length,
                modules: modules.filter(module => module.metadata?.kind === 'module').length,
                submodules: modules.filter(module => module.metadata?.kind === 'submodule').length,
                missingDependencies: dependencies.graph.missing.length,
                schemaNodes: tree.nodeCount,
                errors: errorCount,
                authoritativeErrors: authoritativeErrorCount,
                previewErrors: previewErrorCount,
                warnings: warningCount
            }
        };

        progress('caching', { completed: uniqueEntries.length, message: 'Saving YANG compilation cache' });
        this.saveCache(compileId, publicResult, tree);
        this.installResult(publicResult, tree);
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
    SCHEMA_KEYWORDS,
    COMPILE_CACHE_SCHEMA_VERSION,
    runExecutable
};
