const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseYang } = require('./yangParser');

const CATALOG_SCHEMA_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const DEFAULT_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
            blobs: path.join(this.rootDir, 'blobs'),
            snapshots: path.join(this.rootDir, 'snapshots'),
            workspaces: path.join(this.rootDir, 'workspaces'),
            compiled: path.join(this.rootDir, 'compiled'),
            catalog: path.join(this.rootDir, 'catalog.json')
        };
        Object.values(this.paths)
            .filter(directoryPath => directoryPath !== this.paths.catalog)
            .forEach(ensureDirectory);
        this.catalog = this.loadCatalog();
    }

    loadCatalog() {
        if (!fs.existsSync(this.paths.catalog)) {
            return {
                schemaVersion: CATALOG_SCHEMA_VERSION,
                updatedAt: null,
                blobs: {}
            };
        }
        try {
            const catalog = JSON.parse(fs.readFileSync(this.paths.catalog, 'utf8'));
            if (
                catalog.schemaVersion !== CATALOG_SCHEMA_VERSION ||
                !catalog.blobs ||
                typeof catalog.blobs !== 'object'
            ) {
                throw new Error('unsupported catalog schema');
            }
            return catalog;
        } catch (error) {
            throw new Error(`Unable to read YANG catalog ${this.paths.catalog}: ${error.message}`);
        }
    }

    saveCatalog() {
        this.catalog.updatedAt = new Date().toISOString();
        atomicWriteJson(this.paths.catalog, this.catalog);
    }

    getBlobPath(hash) {
        if (!/^[a-f0-9]{64}$/.test(hash)) {
            throw new Error(`Invalid YANG blob hash: ${hash}`);
        }
        return path.join(this.paths.blobs, hash.slice(0, 2), `${hash}.yang`);
    }

    storeBlob(buffer, hash) {
        const blobPath = this.getBlobPath(hash);
        if (fs.existsSync(blobPath)) {
            const existing = fs.readFileSync(blobPath);
            if (sha256(existing) !== hash) {
                throw new Error(`YANG blob integrity check failed for ${hash}`);
            }
            return blobPath;
        }
        try {
            atomicWriteFile(blobPath, buffer);
        } catch (error) {
            if (!fs.existsSync(blobPath)) {
                throw error;
            }
        }
        return blobPath;
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

        const blobPath = this.storeBlob(buffer, hash);
        const now = new Date().toISOString();
        const origin = options.source || options.sourcePath || options.origin || sourceName;
        const existing = this.catalog.blobs[hash];
        const origins = [...new Set([...(existing?.origins || []), origin].filter(Boolean))];
        const entry = {
            hash,
            blobPath,
            size: buffer.length,
            fileName: options.fileName || existing?.fileName || this.suggestFileName(parsed.metadata, hash),
            importedAt: existing?.importedAt || now,
            updatedAt: now,
            origins,
            metadata: parsed.metadata,
            diagnostics
        };
        this.catalog.blobs[hash] = entry;
        this.saveCatalog();
        return { ...entry, deduplicated: Boolean(existing) };
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
        if (options.workspaceId !== false) {
            workspace = this.addToWorkspace(options.workspaceId || 'default', imported, {
                name: options.workspaceName,
                metadata: options.workspaceMetadata
            });
        }
        if (options.snapshotId) {
            snapshot = this.createSnapshot({
                id: options.snapshotId,
                name: options.snapshotName,
                modules: imported,
                metadata: options.snapshotMetadata
            });
        }
        return {
            imported,
            failed,
            workspace,
            snapshot,
            summary: {
                discovered: imported.length + failed.length,
                imported: imported.length,
                deduplicated: imported.filter(entry => entry.deduplicated).length,
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

    manifestPath(type, id) {
        const normalizedType = type === 'snapshot' ? 'snapshot' : 'workspace';
        const safeId = normalizeManifestId(id, normalizedType);
        const directory = normalizedType === 'snapshot' ? this.paths.snapshots : this.paths.workspaces;
        return path.join(directory, safeId, 'manifest.json');
    }

    moduleReference(entryOrHash) {
        const entry = typeof entryOrHash === 'string' ? this.catalog.blobs[entryOrHash] : entryOrHash;
        if (!entry || !entry.hash || !this.catalog.blobs[entry.hash]) {
            throw new Error(`Unknown YANG blob ${typeof entryOrHash === 'string' ? entryOrHash : entryOrHash?.hash}`);
        }
        const metadata = entry.metadata || {};
        return {
            hash: entry.hash,
            name: metadata.name || null,
            revision: metadata.revision || null,
            kind: metadata.kind || null,
            fileName: entry.fileName,
            size: entry.size
        };
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
        const manifestPath = this.manifestPath('snapshot', id);
        if (fs.existsSync(manifestPath)) {
            throw new Error(`Snapshot ${id} already exists and is immutable`);
        }
        const modules = [
            ...new Map(
                (options.modules || []).map(item => {
                    const reference = this.moduleReference(item.hash || item);
                    return [reference.hash, reference];
                })
            ).values()
        ];
        const now = new Date().toISOString();
        const manifest = {
            schemaVersion: MANIFEST_SCHEMA_VERSION,
            type: 'snapshot',
            id,
            name: options.name || id,
            createdAt: now,
            updatedAt: now,
            contentHash: this.computeManifestContentHash(modules),
            metadata: options.metadata || {},
            modules
        };
        atomicWriteJson(manifestPath, manifest);
        return manifest;
    }

    createWorkspace(options = {}) {
        const id = normalizeManifestId(options.id, 'workspace');
        const manifestPath = this.manifestPath('workspace', id);
        if (fs.existsSync(manifestPath) && options.overwrite !== true) {
            throw new Error(`Workspace ${id} already exists`);
        }
        const modules = [
            ...new Map(
                (options.modules || []).map(item => {
                    const reference = this.moduleReference(item.hash || item);
                    return [reference.hash, reference];
                })
            ).values()
        ];
        const existing = fs.existsSync(manifestPath) ? this.readManifest('workspace', id) : null;
        const now = new Date().toISOString();
        const manifest = {
            schemaVersion: MANIFEST_SCHEMA_VERSION,
            type: 'workspace',
            id,
            name: options.name || existing?.name || id,
            createdAt: existing?.createdAt || now,
            updatedAt: now,
            baseSnapshotId: options.baseSnapshotId || existing?.baseSnapshotId || null,
            contentHash: this.computeManifestContentHash(modules),
            metadata: options.metadata || existing?.metadata || {},
            modules
        };
        atomicWriteJson(manifestPath, manifest);
        return manifest;
    }

    addToWorkspace(id = 'default', entries = [], options = {}) {
        const existing = this.getWorkspace(id);
        const modules = [...(existing?.modules || []), ...entries];
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
        const manifestPath = this.manifestPath(type, id);
        if (!fs.existsSync(manifestPath)) {
            return null;
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest.type !== type) {
            throw new Error(`Unsupported ${type} manifest ${id}`);
        }
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
        const manifestPath = this.manifestPath(type, id);
        if (!fs.existsSync(manifestPath)) {
            return false;
        }
        fs.rmSync(path.dirname(manifestPath), { recursive: true, force: false });
        return true;
    }

    resolveEntries(options = {}) {
        let hashes = options.hashes;
        if (!hashes && options.workspaceId) {
            hashes = (this.getWorkspace(options.workspaceId)?.modules || []).map(module => module.hash);
        }
        if (!hashes && options.snapshotId) {
            hashes = (this.getSnapshot(options.snapshotId)?.modules || []).map(module => module.hash);
        }
        if (!hashes) {
            hashes = Object.keys(this.catalog.blobs);
        }
        return [...new Set(hashes)].map(hash => {
            const entry = this.catalog.blobs[hash];
            if (!entry) {
                throw new Error(`Unknown YANG blob ${hash}`);
            }
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

    getSource(identifier) {
        let entry;
        if (typeof identifier === 'string' && /^[a-f0-9]{64}$/.test(identifier)) {
            entry = this.catalog.blobs[identifier];
        } else {
            const request = typeof identifier === 'string' ? { name: identifier } : identifier || {};
            const candidates = this.listModules({ name: request.name, revision: request.revision, kind: request.kind });
            entry = candidates[0];
        }
        if (!entry) {
            throw new Error(
                `YANG module not found: ${typeof identifier === 'string' ? identifier : stableStringify(identifier)}`
            );
        }
        const buffer = fs.readFileSync(this.getBlobPath(entry.hash));
        if (sha256(buffer) !== entry.hash) {
            throw new Error(`YANG blob integrity check failed for ${entry.hash}`);
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
    CATALOG_SCHEMA_VERSION,
    MANIFEST_SCHEMA_VERSION
};
