const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    getLibyangDiscoveryCandidates,
    getSchemaHelperCandidates,
    getBundledModuleSearchPath,
    parseSchemaHelperVersion,
    SCHEMA_HELPER_CONTRACT_VERSION
} = require('./libyangRuntime');

const METADATA_ENGINE = 'libyang-v1';
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;

class YangMetadataParser {
    constructor(options = {}) {
        this.options = options;
        this.cache = new Map();
        this.helper = null;
    }

    resolveHelper() {
        if (this.helper) {
            const stat = fs.statSync(this.helper.path);
            if (stat.size === this.helper.size && stat.mtimeMs === this.helper.mtimeMs) return this.helper;
            this.helper = null;
            this.cache.clear();
        }
        const candidates = getLibyangDiscoveryCandidates(this.options).flatMap(candidate =>
            getSchemaHelperCandidates(candidate, this.options)
        );
        const seen = new Set();
        for (const candidate of candidates) {
            if (seen.has(candidate.path)) continue;
            seen.add(candidate.path);
            let stat;
            try {
                stat = fs.statSync(candidate.path);
            } catch (_error) {
                continue;
            }
            if (!stat.isFile()) continue;
            const result = spawnSync(candidate.path, ['--version'], {
                encoding: 'utf8',
                timeout: 5000,
                maxBuffer: 128 * 1024,
                env: this.options.env || process.env,
                windowsHide: true
            });
            if (result.error) throw result.error;
            const version = parseSchemaHelperVersion(result.stdout || '');
            if (result.status !== 0 || version?.contractVersion !== SCHEMA_HELPER_CONTRACT_VERSION) continue;
            this.helper = {
                path: candidate.path,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                moduleSearchPath: getBundledModuleSearchPath(candidate.runtimeRoot)
            };
            return this.helper;
        }
        const error = new Error('The bundled libyang metadata parser is unavailable; rebuild or repair the runtime');
        error.code = 'LIBYANG_METADATA_UNAVAILABLE';
        throw error;
    }

    parse(source, options = {}) {
        const buffer = Buffer.from(String(source ?? '').replace(/^\uFEFF/u, ''), 'utf8');
        if (buffer.length > MAX_SOURCE_BYTES || buffer.includes(0)) {
            throw new Error('YANG metadata input exceeds the source limit or contains a NUL byte');
        }
        const helper = this.resolveHelper();
        const key = crypto.createHash('sha256').update(buffer).digest('hex');
        let parsed = this.cache.get(key);
        if (!parsed) {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-yang-metadata-'));
            try {
                const inputPath = path.join(directory, 'source.yang');
                fs.writeFileSync(inputPath, buffer);
                const args = ['--metadata'];
                if (helper.moduleSearchPath) args.push('-p', helper.moduleSearchPath);
                args.push(inputPath);
                const result = spawnSync(helper.path, args, {
                    cwd: directory,
                    encoding: 'utf8',
                    timeout: 15000,
                    maxBuffer: 8 * 1024 * 1024,
                    env: this.options.env || process.env,
                    windowsHide: true
                });
                if (result.error) throw result.error;
                if (result.status !== 0) throw new Error(result.stderr || 'libyang metadata extraction failed');
                parsed = JSON.parse(result.stdout);
                if (parsed.metadataVersion !== 1 || parsed.source !== 'libyang' || !Array.isArray(parsed.diagnostics)) {
                    throw new Error('Invalid libyang metadata response');
                }
                if (!parsed.metadata && !parsed.diagnostics.some(item => item.severity === 'error')) {
                    throw new Error('libyang returned neither metadata nor a parsing error');
                }
                if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value);
                this.cache.set(key, parsed);
            } finally {
                if (
                    path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()) &&
                    path.basename(directory).startsWith('netnexus-yang-metadata-')
                ) {
                    fs.rmSync(directory, { recursive: true, force: true });
                }
            }
        }
        const result = JSON.parse(JSON.stringify(parsed));
        return {
            metadata: result.metadata,
            metadataEngine: METADATA_ENGINE,
            diagnostics: result.diagnostics.map(item => ({
                ...item,
                source: options.sourceName || '<memory>',
                line: item.line || null,
                column: null,
                origin: 'libyang-metadata'
            }))
        };
    }
}

const defaultParser = new YangMetadataParser();
function parseYangMetadata(source, options = {}) {
    return defaultParser.parse(source, options);
}

module.exports = { YangMetadataParser, parseYangMetadata, METADATA_ENGINE };
