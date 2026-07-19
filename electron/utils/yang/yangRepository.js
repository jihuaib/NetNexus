const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseYang } = require('./yangParser');

const MANIFEST_SCHEMA_VERSION = 2;
const DEFAULT_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODULES_DIRECTORY_NAME = 'modules';

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const pairs = Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
        return `{${pairs.join(',')}}`;
    }
    return JSON.stringify(value);
}

function ensureDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
}

function atomicWriteFile(filePath, value, encoding) {
    ensureDirectory(path.dirname(filePath));
    const randomSuffix = crypto.randomBytes(8).toString('hex');
    const temporaryPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${randomSuffix}.tmp`
    );
    let descriptor;
    try {
        descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
        fs.writeFileSync(descriptor, value, encoding ? { encoding } : undefined);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, filePath);
    } catch (error) {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch (_closeError) {
                // The original error is more useful.
            }
        }
        try {
            fs.unlinkSync(temporaryPath);
        } catch (_unlinkError) {
            // The temporary file may not have been created.
        }
        throw error;
    }
}

function atomicWriteJson(filePath, value) {
    atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeSourceBuffer(source) {
    if (Buffer.isBuffer(source)) {
        return source;
    }
    if (source instanceof Uint8Array) {
        return Buffer.from(source);
    }
    return Buffer.from(String(source ?? ''), 'utf8');
}

function normalizeManifestId(id, prefix) {
    const value = id || `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
    if (!SAFE_ID_RE.test(value)) {
        throw new Error(`Invalid ${prefix} id: ${value}`);
    }
    return value;
}

class YangRepository {
    constructor(options = {}) {
        if (!options.rootDir && !options.userDataPath) {
            throw new Error('YangRepository requires rootDir or userDataPath');
        }
        this.rootDir = path.resolve(options.rootDir || path.join(options.userDataPath, 'yang'));
        this.maxSourceBytes = Number(options.maxSourceBytes) || DEFAULT_MAX_SOURCE_BYTES;
        this.paths = {
            snapshots: path.join(this.rootDir, 'snapshots'),
            workspaces: path.join(this.rootDir, 'workspaces'),
            compiled: path.join(this.rootDir, 'compiled')
        };
        Object.values(this.paths).forEach(ensureDirectory);
    }

    scopeType(type) {
        return type === 'snapshot' ? 'snapshot' : 'workspace';
    }

    scopeDirectory(type, id) {
        const normalizedType = this.scopeType(type);
        const safeId = normalizeManifestId(id, normalizedType);
        const directory = normalizedType === 'snapshot' ? this.paths.snapshots : this.paths.workspaces;
        return path.join(directory, safeId);
    }

    manifestPath(type, id) {
        return path.join(this.scopeDirectory(type, id), 'manifest.json');
    }

    modulePath(type, id, hash) {
        if (!/^[a-f0-9]{64}$/.test(hash)) {
            throw new Error(`Invalid YANG module hash: ${hash}`);
        }
        return path.join(this.scopeDirectory(type, id), MODULES_DIRECTORY_NAME, `${hash}.yang`);
    }

    readEntryBuffer(entry) {
        if (Buffer.isBuffer(entry?._sourceBuffer)) return entry._sourceBuffer;
        const sourcePath = entry?.filePath;
        if (!sourcePath) {
            throw new Error(`YANG module ${entry?.hash || '<unknown>'} has no readable source file`);
        }
        return fs.readFileSync(sourcePath);
    }

    storeModule(type, id, entry) {
        const buffer = this.readEntryBuffer(entry);
        const hash = entry.hash;
        if (sha256(buffer) !== hash) {
            throw new Error(`YANG module integrity check failed for ${hash}`);
        }
        const modulePath = this.modulePath(type, id, hash);
        if (fs.existsSync(modulePath)) {
            const existing = fs.readFileSync(modulePath);
            if (sha256(existing) !== hash) {
                throw new Error(`YANG module integrity check failed for ${hash}`);
            }
            return modulePath;
        }
        try {
            atomicWriteFile(modulePath, buffer);
        } catch (error) {
            if (!fs.existsSync(modulePath)) {
                throw error;
            }
        }
        return modulePath;
    }

    validateSource(buffer, sourceName) {
        if (buffer.length > this.maxSourceBytes) {
            throw new Error(`YANG source ${sourceName} exceeds ${this.maxSourceBytes} bytes`);
        }
        if (buffer.includes(0)) {
            throw new Error(`YANG source ${sourceName} contains a NUL byte`);
        }
        if (!Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer)) {
            throw new Error(`YANG source ${sourceName} is not valid UTF-8`);
        }
    }

    importContent(content, options = {}) {
        const sourceName = options.fileName || options.expectedName || '<downloaded.yang>';
        const buffer = normalizeSourceBuffer(content);
        this.validateSource(buffer, sourceName);
        const hash = sha256(buffer);
        const text = buffer.toString('utf8');
        const parsed = parseYang(text, { sourceName });
        const diagnostics = [...parsed.diagnostics];

        if (options.expectedName && parsed.metadata?.name !== options.expectedName) {
            diagnostics.push({
                severity: 'error',
                code: 'MODULE_NAME_MISMATCH',
                message: `Expected module ${options.expectedName}, received ${parsed.metadata?.name || 'an invalid YANG document'}`,
                source: sourceName,
                line: parsed.ast?.line || 1,
                column: parsed.ast?.column || 1,
                offset: parsed.ast?.offset || 0
            });
        }
        if (options.revision && parsed.metadata?.revision !== options.revision) {
            diagnostics.push({
                severity: 'error',
                code: 'MODULE_REVISION_MISMATCH',
                message: `Expected revision ${options.revision}, received ${parsed.metadata?.revision || 'none'}`,
                source: sourceName,
                line: parsed.ast?.line || 1,
                column: parsed.ast?.column || 1,
                offset: parsed.ast?.offset || 0
            });
        }

        const now = new Date().toISOString();
        const origin = options.source || options.sourcePath || options.origin || sourceName;
        const entry = {
            hash,
            size: buffer.length,
            fileName: options.fileName || this.suggestFileName(parsed.metadata, hash),
            importedAt: now,
            updatedAt: now,
            origins: [origin].filter(Boolean),
            metadata: parsed.metadata,
            diagnostics,
            deduplicated: false
        };
        Object.defineProperty(entry, '_sourceBuffer', { value: buffer, enumerable: false });
        return entry;
    }

    importContents(contents = [], options = {}) {
        if (!Array.isArray(contents)) {
            throw new TypeError('contents must be an array');
        }
        const imported = [];
        const failed = [];
        contents.forEach((item, index) => {
            try {
                const descriptor =
                    item && typeof item === 'object' && !Buffer.isBuffer(item) ? item : { content: item };
                imported.push(
                    this.importContent(descriptor.content, {
                        fileName:
                            descriptor.fileName ||
                            (descriptor.expectedName
                                ? `${descriptor.expectedName}${descriptor.revision ? `@${descriptor.revision}` : ''}.yang`
                                : `download-${index + 1}.yang`),
                        expectedName: descriptor.expectedName,
                        revision: descriptor.revision,
                        source: descriptor.source || options.source
                    })
                );
            } catch (error) {
                failed.push({
                    index,
                    expectedName: item?.expectedName || null,
                    source: item?.source || null,
                    error: error.message
                });
            }
        });
        return this.finishImport(imported, failed, options);
    }

    collectYangFiles(inputPaths, options = {}) {
        const recursive = options.recursive !== false;
        const files = [];
        const failed = [];
        const visit = inputPath => {
            const resolvedPath = path.resolve(inputPath);
            let stats;
            try {
                stats = fs.lstatSync(resolvedPath);
            } catch (error) {
                failed.push({ path: resolvedPath, error: error.message });
                return;
            }
            if (stats.isSymbolicLink()) {
                failed.push({ path: resolvedPath, error: 'Symbolic links are not imported' });
                return;
            }
            if (stats.isFile()) {
                if (path.extname(resolvedPath).toLowerCase() === '.yang') {
                    files.push(resolvedPath);
                } else {
                    failed.push({ path: resolvedPath, error: 'Not a .yang file' });
                }
                return;
            }
            if (!stats.isDirectory()) {
                failed.push({ path: resolvedPath, error: 'Not a regular file or directory' });
                return;
            }
            let entries;
            try {
                entries = fs
                    .readdirSync(resolvedPath, { withFileTypes: true })
                    .sort((left, right) => left.name.localeCompare(right.name));
            } catch (error) {
                failed.push({ path: resolvedPath, error: error.message });
                return;
            }
            for (const entry of entries) {
                const childPath = path.join(resolvedPath, entry.name);
                if (entry.isDirectory() && recursive) {
                    visit(childPath);
                } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.yang') {
                    files.push(childPath);
                }
            }
        };

        for (const inputPath of [...new Set(inputPaths.map(String))]) {
            visit(inputPath);
        }
        return { files: [...new Set(files)], failed };
    }

    importPaths(inputPaths = [], options = {}) {
        const paths = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
        const discovered = this.collectYangFiles(paths, options);
        const imported = [];
        const failed = [...discovered.failed];
        discovered.files.forEach((filePath, index) => {
            try {
                options.onProgress?.({
                    phase: 'importing',
                    completed: index,
                    total: discovered.files.length,
                    percent: discovered.files.length ? Math.round((index / discovered.files.length) * 100) : 0,
                    currentFile: filePath
                });
                imported.push(
                    this.importContent(fs.readFileSync(filePath), {
                        fileName: path.basename(filePath),
                        sourcePath: filePath
                    })
                );
            } catch (error) {
                failed.push({ path: filePath, error: error.message });
            }
        });
        return this.finishImport(imported, failed, options);
    }

    finishImport(imported, failed, options) {
        let workspace = null;
        let snapshot = null;
        let workspaceId = null;
        let snapshotId = null;
        const deduplicated = new Set();
        if (options.snapshotId && this.getSnapshot(options.snapshotId)) {
            throw new Error(`Snapshot ${options.snapshotId} already exists and is immutable`);
        }
        if (options.workspaceId !== false) {
            workspaceId = options.workspaceId || 'default';
            const existingHashes = new Set(this.getWorkspace(workspaceId)?.modules?.map(module => module.hash) || []);
            const seenHashes = new Set(existingHashes);
            imported.forEach((entry, index) => {
                if (seenHashes.has(entry.hash)) deduplicated.add(index);
                seenHashes.add(entry.hash);
            });
            workspace = this.addToWorkspace(workspaceId, imported, {
                name: options.workspaceName,
                metadata: options.workspaceMetadata
            });
        }
        if (options.snapshotId) {
            snapshotId = options.snapshotId;
            snapshot = this.createSnapshot({
                id: snapshotId,
                name: options.snapshotName,
                modules: imported,
                metadata: options.snapshotMetadata
            });
        }
        if (!workspaceId) {
            const seenHashes = new Set();
            imported.forEach((entry, index) => {
                if (seenHashes.has(entry.hash)) deduplicated.add(index);
                seenHashes.add(entry.hash);
            });
        }
        const persistedEntries = workspaceId
            ? this.resolveEntries({ workspaceId, hashes: imported.map(entry => entry.hash) })
            : snapshotId
              ? this.resolveEntries({ snapshotId, hashes: imported.map(entry => entry.hash) })
              : [];
        const persistedByHash = new Map(persistedEntries.map(entry => [entry.hash, entry]));
        const publicImported = imported.map((entry, index) => ({
            ...entry,
            ...(persistedByHash.get(entry.hash) || {}),
            deduplicated: deduplicated.has(index)
        }));
        return {
            imported: publicImported,
            failed,
            workspace,
            snapshot,
            summary: {
                discovered: imported.length + failed.length,
                imported: imported.length,
                deduplicated: deduplicated.size,
                failed: failed.length,
                invalid: imported.filter(entry => entry.diagnostics.some(diagnostic => diagnostic.severity === 'error'))
                    .length
            }
        };
    }

    suggestFileName(metadata, hash) {
        if (!metadata?.name) {
            return `${hash}.yang`;
        }
        return `${metadata.name}${metadata.revision ? `@${metadata.revision}` : ''}.yang`;
    }

    moduleReference(entry) {
        if (!entry?.hash || !/^[a-f0-9]{64}$/.test(entry.hash)) {
            throw new Error(`Invalid YANG module reference ${entry?.hash || '<unknown>'}`);
        }
        const metadata = entry.metadata || {};
        return {
            hash: entry.hash,
            name: metadata.name || null,
            revision: metadata.revision || null,
            kind: metadata.kind || null,
            fileName: entry.fileName,
            size: entry.size,
            importedAt: entry.importedAt || null,
            updatedAt: entry.updatedAt || null,
            origins: [...new Set((entry.origins || []).filter(Boolean))],
            metadata,
            diagnostics: Array.isArray(entry.diagnostics) ? entry.diagnostics : [],
            relativePath: `${MODULES_DIRECTORY_NAME}/${entry.hash}.yang`
        };
    }

    mergeModuleEntries(entries = []) {
        const merged = new Map();
        for (const entry of entries) {
            if (!entry?.hash) continue;
            const existing = merged.get(entry.hash);
            if (!existing) {
                merged.set(entry.hash, entry);
                continue;
            }
            const source = Buffer.isBuffer(entry._sourceBuffer) ? entry : existing;
            const combined = {
                ...existing,
                ...entry,
                fileName: existing.fileName || entry.fileName,
                importedAt: existing.importedAt || entry.importedAt || null,
                updatedAt: entry.updatedAt || existing.updatedAt || null,
                origins: [...new Set([...(existing.origins || []), ...(entry.origins || [])].filter(Boolean))],
                metadata: entry.metadata || existing.metadata || {},
                diagnostics: Array.isArray(entry.diagnostics) ? entry.diagnostics : existing.diagnostics || []
            };
            const sourceBuffer = source._sourceBuffer;
            if (Buffer.isBuffer(sourceBuffer)) {
                Object.defineProperty(combined, '_sourceBuffer', { value: sourceBuffer, enumerable: false });
            }
            merged.set(entry.hash, combined);
        }
        return [...merged.values()];
    }

    expandManifestModules(type, id, manifest) {
        return (manifest?.modules || []).map(reference => ({
            ...reference,
            filePath: this.modulePath(type, id, reference.hash)
        }));
    }

    pruneModuleDirectory(type, id, hashes) {
        const moduleDirectory = path.join(this.scopeDirectory(type, id), MODULES_DIRECTORY_NAME);
        if (!fs.existsSync(moduleDirectory)) return;
        const expected = new Set([...hashes].map(hash => `${hash}.yang`));
        for (const entry of fs.readdirSync(moduleDirectory, { withFileTypes: true })) {
            if (entry.isFile() && expected.has(entry.name)) continue;
            fs.rmSync(path.join(moduleDirectory, entry.name), { recursive: true, force: true });
        }
    }

    writeManifest(type, id, options = {}) {
        const normalizedType = this.scopeType(type);
        const manifestPath = this.manifestPath(normalizedType, id);
        const existing = this.readManifest(normalizedType, id);
        const manifestExists = fs.existsSync(manifestPath);
        if (manifestExists && existing && options.overwrite !== true) {
            const label = normalizedType === 'snapshot' ? 'Snapshot' : 'Workspace';
            throw new Error(`${label} ${id} already exists${normalizedType === 'snapshot' ? ' and is immutable' : ''}`);
        }
        if (manifestExists && !existing) {
            fs.rmSync(this.scopeDirectory(normalizedType, id), { recursive: true, force: true });
        }

        const modules = this.mergeModuleEntries(options.modules || []);
        const references = modules.map(entry => {
            this.storeModule(normalizedType, id, entry);
            return this.moduleReference(entry);
        });
        const now = new Date().toISOString();
        const manifest = {
            schemaVersion: MANIFEST_SCHEMA_VERSION,
            type: normalizedType,
            id,
            name: options.name || existing?.name || id,
            createdAt: existing?.createdAt || now,
            updatedAt: now,
            contentHash: this.computeManifestContentHash(references),
            metadata: options.metadata || existing?.metadata || {},
            modules: references
        };
        if (normalizedType === 'workspace') {
            manifest.baseSnapshotId = options.baseSnapshotId || existing?.baseSnapshotId || null;
        }
        atomicWriteJson(manifestPath, manifest);
        this.pruneModuleDirectory(normalizedType, id, new Set(references.map(reference => reference.hash)));
        return manifest;
    }

    computeManifestContentHash(modules) {
        return sha256(
            Buffer.from(
                modules
                    .map(module => module.hash)
                    .sort()
                    .join('\n'),
                'utf8'
            )
        );
    }

    createSnapshot(options = {}) {
        const id = normalizeManifestId(options.id, 'snapshot');
        return this.writeManifest('snapshot', id, {
            name: options.name || id,
            metadata: options.metadata,
            modules: options.modules || []
        });
    }

    createWorkspace(options = {}) {
        const id = normalizeManifestId(options.id, 'workspace');
        return this.writeManifest('workspace', id, {
            ...options,
            id
        });
    }

    addToWorkspace(id = 'default', entries = [], options = {}) {
        const existing = this.getWorkspace(id);
        const modules = [...this.expandManifestModules('workspace', id, existing), ...entries];
        return this.createWorkspace({
            id,
            name: options.name || existing?.name || id,
            baseSnapshotId: existing?.baseSnapshotId,
            metadata: options.metadata || existing?.metadata || {},
            modules,
            overwrite: true
        });
    }

    clearWorkspace(id = 'default') {
        const existing = this.getWorkspace(id);
        return this.createWorkspace({
            id,
            name: existing?.name || id,
            baseSnapshotId: existing?.baseSnapshotId,
            metadata: existing?.metadata || {},
            modules: [],
            overwrite: true
        });
    }

    readManifest(type, id) {
        const normalizedType = this.scopeType(type);
        const manifestPath = this.manifestPath(normalizedType, id);
        if (!fs.existsSync(manifestPath)) {
            return null;
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest.type !== normalizedType) return null;
        return manifest;
    }

    getWorkspace(id = 'default') {
        return this.readManifest('workspace', id);
    }

    getSnapshot(id) {
        return this.readManifest('snapshot', id);
    }

    listManifests(type) {
        const directory = type === 'snapshot' ? this.paths.snapshots : this.paths.workspaces;
        return fs
            .readdirSync(directory, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && SAFE_ID_RE.test(entry.name))
            .map(entry => this.readManifest(type, entry.name))
            .filter(Boolean)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    deleteManifest(type, id) {
        const directory = this.scopeDirectory(type, id);
        if (!fs.existsSync(directory)) {
            return false;
        }
        fs.rmSync(directory, { recursive: true, force: false });
        return true;
    }

    deleteWorkspace(id = 'default') {
        return this.deleteManifest('workspace', id);
    }

    resolveEntries(options = {}) {
        const useSnapshot = Boolean(options.snapshotId);
        const type = useSnapshot ? 'snapshot' : 'workspace';
        const id = useSnapshot ? options.snapshotId : options.workspaceId || 'default';
        const manifest = useSnapshot ? this.getSnapshot(id) : this.getWorkspace(id);
        const entries = this.expandManifestModules(type, id, manifest);
        if (options.hashes === undefined) return entries;
        const byHash = new Map(entries.map(entry => [entry.hash, entry]));
        return [...new Set(options.hashes)].map(hash => {
            const entry = byHash.get(hash);
            if (!entry) throw new Error(`Unknown YANG module ${hash} in ${type} ${id}`);
            return entry;
        });
    }

    listModules(options = {}) {
        let entries = this.resolveEntries(options);
        if (options.name) {
            entries = entries.filter(entry => entry.metadata?.name === options.name);
        }
        if (options.revision) {
            entries = entries.filter(entry => entry.metadata?.revision === options.revision);
        }
        if (options.kind) {
            entries = entries.filter(entry => entry.metadata?.kind === options.kind);
        }
        return entries
            .map(entry => ({ ...entry }))
            .sort((left, right) => {
                const nameCompare = (left.metadata?.name || left.fileName).localeCompare(
                    right.metadata?.name || right.fileName
                );
                return nameCompare || (right.metadata?.revision || '').localeCompare(left.metadata?.revision || '');
            });
    }

    getSource(identifier, options = {}) {
        const request = typeof identifier === 'string' ? { name: identifier } : identifier || {};
        const scope = {
            workspaceId: request.workspaceId ?? options.workspaceId,
            snapshotId: request.snapshotId ?? options.snapshotId
        };
        let candidates = this.listModules(scope);
        const hash =
            typeof identifier === 'string' && /^[a-f0-9]{64}$/.test(identifier) ? identifier : request.hash;
        if (hash) candidates = candidates.filter(entry => entry.hash === hash);
        else {
            if (request.name) candidates = candidates.filter(entry => entry.metadata?.name === request.name);
            if (request.revision) candidates = candidates.filter(entry => entry.metadata?.revision === request.revision);
            if (request.kind) candidates = candidates.filter(entry => entry.metadata?.kind === request.kind);
        }
        const entry = candidates[0];
        if (!entry) {
            throw new Error(
                `YANG module not found: ${typeof identifier === 'string' ? identifier : stableStringify(identifier)}`
            );
        }
        const buffer = fs.readFileSync(entry.filePath);
        if (sha256(buffer) !== entry.hash) {
            throw new Error(`YANG module integrity check failed for ${entry.hash}`);
        }
        const source = buffer.toString('utf8');
        return {
            hash: entry.hash,
            fileName: entry.fileName,
            metadata: entry.metadata,
            source
        };
    }
}

module.exports = {
    YangRepository,
    sha256,
    stableStringify,
    atomicWriteFile,
    atomicWriteJson,
    MANIFEST_SCHEMA_VERSION
};
