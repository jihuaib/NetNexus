const fs = require('fs');
const path = require('path');
const snmp = require('net-snmp');
const logger = require('../log/logger');
const { formatSnmpValue } = require('./snmpValueFormatter');

const MIB_FILE_EXTENSIONS = new Set(['.mib', '.txt', '.my', '']);
const MIB_CACHE_SCHEMA_VERSION = 3;
const MAX_MIB_FILES_PER_BATCH = 128;
const MAX_MIB_SOURCE_BYTES_PER_BATCH = 8 * 1024 * 1024;
const MAX_CACHED_OID_ENTRIES = 250000;
const MAX_CACHED_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_MIB_CACHE_FILE_BYTES = 256 * 1024 * 1024;

class MibCompileProgressReporter {
    constructor(onProgress) {
        this.onProgress = typeof onProgress === 'function' ? onProgress : null;
        this.total = 0;
        this.scanTotal = 0;
        this.scanned = 0;
        this.completed = 0;
        this.counts = {
            compiled: 0,
            skipped: 0,
            failed: 0
        };
        this.terminalFiles = new Set();
    }

    emit(payload = {}) {
        if (!this.onProgress) {
            return;
        }

        const progress = {
            phase: payload.phase || 'preparing',
            completed: this.completed,
            total: this.total,
            percent: this.getPercent(payload.phase),
            scanned: this.scanned,
            scanTotal: this.scanTotal,
            counts: { ...this.counts },
            ...payload
        };

        try {
            this.onProgress(progress);
        } catch (error) {
            logger.warn(`MIB编译进度回调失败: ${error.message}`);
        }
    }

    getPercent(phase) {
        if (phase === 'completed') {
            return 100;
        }
        if (phase === 'scanning') {
            return this.scanTotal > 0 ? Math.round((this.scanned / this.scanTotal) * 100) : 0;
        }
        if (phase === 'indexing' || phase === 'caching') {
            return 99;
        }
        return this.total > 0 ? Math.min(99, Math.round((this.completed / this.total) * 100)) : 0;
    }

    preparing(message = '正在准备 MIB 编译') {
        this.emit({ phase: 'preparing', message });
    }

    discovered(total, scanTotal) {
        this.total = total;
        this.scanTotal = scanTotal;
        this.emit({ phase: 'scanning', message: `发现 ${total} 个 MIB 文件` });
    }

    scannedFile(filePath, index) {
        this.scanned = index;
        this.emit({
            phase: 'scanning',
            filePath,
            fileName: path.basename(filePath),
            message: '正在读取 MIB 文件'
        });
    }

    planning() {
        this.emit({
            phase: 'planning',
            filePath: '',
            fileName: '',
            fileStatus: '',
            message: '正在分析 MIB 模块和依赖关系'
        });
    }

    beginCompilation() {
        this.emit({
            phase: 'compiling',
            filePath: '',
            fileName: '',
            fileStatus: '',
            message: '开始编译 MIB 文件'
        });
    }

    startFile(filePath) {
        if (this.terminalFiles.has(filePath)) {
            return;
        }
        this.emit({
            phase: 'compiling',
            filePath,
            fileName: path.basename(filePath),
            fileStatus: 'compiling',
            message: '正在编译当前文件'
        });
    }

    serializing(filePaths) {
        const currentFile = filePaths[filePaths.length - 1] || '';
        this.emit({
            phase: 'serializing',
            filePath: currentFile,
            fileName: currentFile ? path.basename(currentFile) : '',
            batchSize: filePaths.length,
            message: `正在解析当前批次（${filePaths.length} 个文件）`
        });
    }

    finishFile(filePath, fileStatus, msg = '') {
        if (!filePath || this.terminalFiles.has(filePath)) {
            return;
        }

        this.terminalFiles.add(filePath);
        this.completed += 1;
        if (Object.prototype.hasOwnProperty.call(this.counts, fileStatus)) {
            this.counts[fileStatus] += 1;
        }
        this.emit({
            phase: 'compiling',
            filePath,
            fileName: path.basename(filePath),
            fileStatus,
            msg,
            message: msg
        });
    }

    indexing() {
        this.emit({
            phase: 'indexing',
            filePath: '',
            fileName: '',
            fileStatus: '',
            message: '正在生成 OID 索引'
        });
    }

    caching() {
        this.emit({
            phase: 'caching',
            filePath: '',
            fileName: '',
            fileStatus: '',
            message: '正在保存 MIB 缓存'
        });
    }

    complete(summary = {}, extra = {}) {
        const compiled = Array.isArray(summary.loadedFiles) ? summary.loadedFiles.length : this.counts.compiled;
        const skipped = Array.isArray(summary.skippedFiles) ? summary.skippedFiles.length : this.counts.skipped;
        const failed = Array.isArray(summary.failedFiles) ? summary.failedFiles.length : this.counts.failed;
        const total = Number(summary.expandedFileCount) || this.total || compiled + skipped + failed;

        this.total = total;
        this.completed = total;
        this.counts = { compiled, skipped, failed };
        this.emit({
            phase: 'completed',
            message: extra.cacheHit ? '已从缓存加载 MIB' : 'MIB 编译完成',
            cacheHit: Boolean(extra.cacheHit),
            ...extra
        });
    }
}

class MibRegistry {
    constructor() {
        this.reset();
    }

    reset() {
        this.store = snmp.createModuleStore();
        this.parserKeySequence = 0;
        this.clearParserWorkingSet();
        this.compiledFiles = [];
        this.loadedFiles = [];
        this.failedFiles = [];
        this.skippedFiles = [];
        this.oidIndex = new Map();
        this.oidChildIndex = new Map();
        this.cachedModuleNames = null;
        this.cachedBaseModuleNames = null;
        this.cacheHit = false;
        this.activeSourceState = null;
        this.rebuildOidIndex();
    }

    loadOrCompileMibFiles(filePaths = [], options = {}) {
        const requestedPaths = this.normalizeFilePaths(filePaths);
        const progressReporter = new MibCompileProgressReporter(options.onProgress);
        if (requestedPaths.length === 0) {
            this.reset();
            const summary = this.getSummary();
            progressReporter.complete(summary);
            return summary;
        }

        const sourceState = options.force ? null : this.captureMibSourceState(requestedPaths, options.cacheFilePath);
        if (!options.force && sourceState && this.isActiveSourceState(sourceState)) {
            const summary = this.getSummary();
            progressReporter.complete(summary, { cacheHit: true });
            return summary;
        }

        if (
            !options.force &&
            options.cacheFilePath &&
            this.loadCacheIfValid(requestedPaths, options.cacheFilePath, sourceState)
        ) {
            const restoredSourceState = this.captureMibSourceState(requestedPaths, options.cacheFilePath);
            if (this.areMibSourceStatesEqual(sourceState, restoredSourceState)) {
                this.activeSourceState = restoredSourceState;
                const summary = this.getSummary();
                progressReporter.complete(summary, { cacheHit: true });
                return summary;
            }
        }

        const summary = this.compileMibFiles(requestedPaths, {
            progressReporter,
            completeProgress: false
        });
        const compiledSourceState = this.captureMibSourceState(requestedPaths, options.cacheFilePath);
        if (options.cacheFilePath) {
            progressReporter.caching();
            this.saveCache(options.cacheFilePath, requestedPaths, compiledSourceState);
        }
        const activeSourceState = this.captureMibSourceState(requestedPaths, options.cacheFilePath);
        if (activeSourceState) {
            this.activeSourceState = activeSourceState;
        }
        progressReporter.complete(summary);
        return summary;
    }

    compileMibFiles(filePaths = [], options = {}) {
        const requestedPaths = this.normalizeFilePaths(filePaths);
        const progressReporter = options.progressReporter || new MibCompileProgressReporter(options.onProgress);
        return this.compileMibFilesInBatch(requestedPaths, {
            ...options,
            progressReporter
        });
    }

    compileMibFilesInBatch(filePaths = [], options = {}) {
        const requestedPaths = this.normalizeFilePaths(filePaths);
        const progressReporter = options.progressReporter || new MibCompileProgressReporter(options.onProgress);
        this.reset();
        this.compiledFiles = requestedPaths;
        progressReporter.preparing();

        if (requestedPaths.length === 0) {
            const summary = this.getSummary();
            if (options.completeProgress !== false) {
                progressReporter.complete(summary);
            }
            return summary;
        }

        const expansion = this.expandInputPaths(requestedPaths);
        progressReporter.discovered(expansion.files.length + expansion.failedPaths.length, expansion.files.length);
        const metadata = this.buildFileMetadata(expansion.files, (filePath, index) => {
            progressReporter.scannedFile(filePath, index);
        });
        progressReporter.planning();
        const preparation = this.prepareMibCandidates(expansion.files, metadata, requestedPaths);
        const plan = this.createMibLoadPlan(
            {
                files: preparation.files,
                failedPaths: [...expansion.failedPaths, ...preparation.failedFiles]
            },
            preparation.metadata
        );
        progressReporter.beginCompilation();
        plan.failed.forEach(record => progressReporter.finishFile(record.filePath, 'failed', record.msg));
        preparation.skippedFiles.forEach(record => progressReporter.finishFile(record.filePath, 'skipped', record.msg));
        const loadResult = this.loadFromFilesInBatch(plan.loadOrder, preparation.metadata, progressReporter);
        const loadedModuleNames = new Set(this.getModuleNames(true));

        this.loadedFiles = loadResult.loadedFiles;
        this.skippedFiles = preparation.skippedFiles;
        this.failedFiles = [
            ...plan.failed,
            ...loadResult.failedFiles,
            ...plan.pending.map(filePath => ({
                filePath,
                fileName: path.basename(filePath),
                msg: this.getWaitingDependencyMessage(preparation.metadata.get(filePath), loadedModuleNames)
            }))
        ];
        plan.pending.forEach(filePath => {
            const record = this.failedFiles.find(item => item.filePath === filePath);
            progressReporter.finishFile(filePath, 'failed', record?.msg || 'MIB依赖未满足');
        });

        progressReporter.indexing();
        this.rebuildOidIndex();
        const summary = this.getSummary();
        if (options.completeProgress !== false) {
            progressReporter.complete(summary);
        }
        return summary;
    }

    prepareMibCandidates(filePaths, metadata, requestedPaths = []) {
        const baseModules = new Set(this.getModuleNames(true));
        const explicitFiles = new Set(
            requestedPaths.filter(filePath => {
                try {
                    return fs.statSync(filePath).isFile();
                } catch (error) {
                    return false;
                }
            })
        );
        const groups = new Map();
        const failedFiles = [];
        const skippedFiles = [];

        filePaths.forEach((filePath, order) => {
            const fileMeta = metadata.get(filePath);
            if (!fileMeta || fileMeta.parseError) {
                failedFiles.push(this.createFileRecord(filePath, fileMeta?.parseError || 'MIB文件读取失败'));
                return;
            }

            if (!fileMeta.moduleName) {
                skippedFiles.push(this.createFileRecord(filePath, '未识别到MIB模块定义，已跳过', 'skipped'));
                return;
            }

            if (baseModules.has(fileMeta.moduleName)) {
                skippedFiles.push(
                    this.createFileRecord(filePath, `模块 ${fileMeta.moduleName} 已使用内置版本`, 'skipped')
                );
                return;
            }

            if (!groups.has(fileMeta.moduleName)) {
                groups.set(fileMeta.moduleName, []);
            }
            groups.get(fileMeta.moduleName).push({
                filePath,
                fileMeta,
                explicit: explicitFiles.has(filePath),
                order
            });
        });

        const selected = [];
        groups.forEach(candidates => {
            candidates.sort(
                (left, right) => Number(right.explicit) - Number(left.explicit) || left.order - right.order
            );
            const winner = candidates[0];
            selected.push(winner);
            candidates.slice(1).forEach(candidate => {
                skippedFiles.push(
                    this.createFileRecord(
                        candidate.filePath,
                        `重复模块 ${candidate.fileMeta.moduleName}，已优先选择 ${winner.filePath}`,
                        'skipped'
                    )
                );
            });
        });

        selected.sort((left, right) => left.order - right.order);
        return {
            files: selected.map(candidate => candidate.filePath),
            metadata: new Map(selected.map(candidate => [candidate.filePath, candidate.fileMeta])),
            failedFiles,
            skippedFiles
        };
    }

    createFileRecord(filePath, msg, status = 'failed') {
        return {
            filePath,
            fileName: path.basename(filePath),
            status,
            msg
        };
    }

    createMibLoadPlan(expansion, metadata) {
        const knownModules = this.getKnownModuleNames(metadata);
        const baseModules = new Set(this.getModuleNames(true));
        const loadedModuleNames = new Set(baseModules);
        const pending = [...expansion.files];
        const loadOrder = [];
        const failed = [...expansion.failedPaths];
        let progressed = true;

        while (pending.length > 0 && progressed) {
            progressed = false;

            for (let i = pending.length - 1; i >= 0; i--) {
                const filePath = pending[i];
                const fileMeta = metadata.get(filePath);
                const unknownImports = fileMeta.imports.filter(
                    moduleName => !baseModules.has(moduleName) && !knownModules.has(moduleName)
                );
                if (unknownImports.length > 0) {
                    failed.push({
                        filePath,
                        fileName: path.basename(filePath),
                        msg: `缺少依赖MIB: ${unknownImports.join(', ')}`
                    });
                    pending.splice(i, 1);
                    continue;
                }

                const waitingImports = fileMeta.imports.filter(moduleName => !loadedModuleNames.has(moduleName));
                if (waitingImports.length > 0) {
                    continue;
                }

                loadOrder.push(filePath);
                if (fileMeta.moduleName) {
                    loadedModuleNames.add(fileMeta.moduleName);
                }
                pending.splice(i, 1);
                progressed = true;
            }
        }

        return {
            loadOrder,
            failed,
            pending,
            loadedModuleNames
        };
    }

    loadCacheIfValid(requestedPaths, cacheFilePath, sourceState = null) {
        try {
            if (!cacheFilePath || !fs.existsSync(cacheFilePath)) {
                return false;
            }

            const cacheStat = fs.statSync(cacheFilePath);
            if (cacheStat.size > MAX_MIB_CACHE_FILE_BYTES) {
                logger.warn(`MIB缓存文件过大（${cacheStat.size} 字节），将重新编译而不加载`);
                return false;
            }

            const cache = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
            if (cache.version !== MIB_CACHE_SCHEMA_VERSION) {
                return false;
            }

            if (!this.areFileListsEqual(cache.requestedFiles || [], requestedPaths)) {
                return false;
            }

            const currentSourceState = sourceState || this.captureMibSourceState(requestedPaths, cacheFilePath);
            if (!currentSourceState) {
                return false;
            }

            if (!this.areFileSignaturesEqual(currentSourceState.fileSignatures, cache.fileSignatures || [])) {
                return false;
            }

            this.loadSnapshot(cache.snapshot);
            this.cacheHit = true;
            return true;
        } catch (error) {
            logger.warn('MIB缓存加载失败，将重新编译:', error.message);
            return false;
        }
    }

    saveCache(cacheFilePath, requestedPaths, sourceState = null) {
        try {
            const expansion = sourceState ? null : this.expandInputPaths(requestedPaths);
            const fileSignatures = sourceState ? sourceState.fileSignatures : this.getFileSignatures(expansion.files);
            const sourceBytes = fileSignatures.reduce((total, signature) => total + (signature.size || 0), 0);
            if (this.oidIndex.size > MAX_CACHED_OID_ENTRIES) {
                logger.warn(
                    `MIB对象数量 ${this.oidIndex.size} 超过缓存上限 ${MAX_CACHED_OID_ENTRIES}，跳过磁盘缓存以避免内存峰值`
                );
                return;
            }
            if (sourceBytes > MAX_CACHED_SOURCE_BYTES) {
                logger.warn(`MIB源文件总大小 ${sourceBytes} 字节超过缓存上限，跳过磁盘缓存以避免内存峰值`);
                return;
            }

            const cache = {
                version: MIB_CACHE_SCHEMA_VERSION,
                createdAt: new Date().toISOString(),
                requestedFiles: requestedPaths,
                fileSignatures,
                snapshot: this.buildSnapshot()
            };

            fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
            fs.writeFileSync(cacheFilePath, JSON.stringify(cache), 'utf8');
        } catch (error) {
            logger.warn('MIB缓存写入失败:', error.message);
        }
    }

    clearCache(cacheFilePath) {
        if (!cacheFilePath) {
            return;
        }

        try {
            if (fs.existsSync(cacheFilePath)) {
                fs.unlinkSync(cacheFilePath);
            }
        } catch (error) {
            logger.warn('MIB缓存删除失败:', error.message);
        }
    }

    buildSnapshot() {
        const summary = this.getSummary();
        return {
            requestedFiles: this.compiledFiles,
            loadedFiles: this.loadedFiles,
            failedFiles: this.failedFiles,
            skippedFiles: this.skippedFiles,
            modules: summary.modules,
            baseModules: summary.baseModules,
            oidIndexEntries: Array.from(this.oidIndex.entries())
        };
    }

    loadSnapshot(snapshot = {}) {
        this.reset();
        this.compiledFiles = this.normalizeFilePaths(snapshot.requestedFiles || []);
        this.loadedFiles = this.normalizeFilePaths(snapshot.loadedFiles || []);
        this.failedFiles = Array.isArray(snapshot.failedFiles) ? snapshot.failedFiles : [];
        this.skippedFiles = Array.isArray(snapshot.skippedFiles) ? snapshot.skippedFiles : [];
        this.cachedModuleNames = Array.isArray(snapshot.modules) ? snapshot.modules : [];
        this.cachedBaseModuleNames = Array.isArray(snapshot.baseModules) ? snapshot.baseModules : [];
        this.oidIndex = new Map(Array.isArray(snapshot.oidIndexEntries) ? snapshot.oidIndexEntries : []);
        this.rebuildOidChildIndex();
    }

    getFileSignatures(filePaths = []) {
        return filePaths.map(filePath => this.getFileSignature(filePath)).filter(Boolean);
    }

    getFileSignature(filePath) {
        try {
            const stat = fs.statSync(filePath);
            return {
                filePath,
                size: stat.size,
                mtimeMs: Math.trunc(stat.mtimeMs)
            };
        } catch (error) {
            return null;
        }
    }

    captureMibSourceState(requestedPaths, cacheFilePath = '') {
        const expansion = this.expandInputPaths(requestedPaths);
        if (expansion.failedPaths.length > 0) {
            return null;
        }

        const fileSignatures = this.getFileSignatures(expansion.files);
        if (fileSignatures.length !== expansion.files.length) {
            return null;
        }

        return {
            requestedPaths: [...requestedPaths],
            fileSignatures,
            cacheFilePath,
            cacheFileSignature: cacheFilePath ? this.getFileSignature(cacheFilePath) : null
        };
    }

    isActiveSourceState(sourceState) {
        return this.areMibSourceStatesEqual(this.activeSourceState, sourceState);
    }

    areMibSourceStatesEqual(left, right) {
        if (!left || !right) {
            return false;
        }

        if (left.cacheFilePath !== right.cacheFilePath) {
            return false;
        }

        if (!this.areFileListsEqual(left.requestedPaths, right.requestedPaths)) {
            return false;
        }

        if (!this.areFileSignaturesEqual(left.fileSignatures, right.fileSignatures)) {
            return false;
        }

        return this.areOptionalFileSignaturesEqual(left.cacheFileSignature, right.cacheFileSignature);
    }

    areOptionalFileSignaturesEqual(left, right) {
        if (!left || !right) {
            return left === right;
        }

        return left.filePath === right.filePath && left.size === right.size && left.mtimeMs === right.mtimeMs;
    }

    areFileSignaturesEqual(left = [], right = []) {
        if (left.length !== right.length) {
            return false;
        }

        const rightMap = new Map(right.map(item => [item.filePath, item]));
        return left.every(item => {
            const matched = rightMap.get(item.filePath);
            return matched && matched.size === item.size && matched.mtimeMs === item.mtimeMs;
        });
    }

    areFileListsEqual(left = [], right = []) {
        if (left.length !== right.length) {
            return false;
        }

        return left.every((item, index) => item === right[index]);
    }

    normalizeFilePaths(filePaths) {
        if (!Array.isArray(filePaths)) {
            return [];
        }

        const seen = new Set();
        const normalized = [];
        filePaths.forEach(filePath => {
            if (!filePath || typeof filePath !== 'string') {
                return;
            }

            const trimmed = filePath.trim();
            if (!trimmed || seen.has(trimmed)) {
                return;
            }

            seen.add(trimmed);
            normalized.push(trimmed);
        });

        return normalized;
    }

    getWaitingDependencyMessage(fileMeta, loadedModuleNames, fallbackMsg) {
        const waitingImports = (fileMeta?.imports || []).filter(moduleName => !loadedModuleNames.has(moduleName));
        if (waitingImports.length > 0) {
            return `MIB依赖未满足: ${waitingImports.join(', ')}`;
        }
        return fallbackMsg || 'MIB依赖未满足或语法解析失败';
    }

    buildFileMetadata(filePaths, onFile) {
        const metadata = new Map();
        filePaths.forEach((filePath, index) => {
            metadata.set(filePath, this.parseMibMetadata(filePath));
            if (typeof onFile === 'function') {
                onFile(filePath, index + 1, filePaths.length);
            }
        });
        return metadata;
    }

    parseMibMetadata(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const stripped = content.replace(/--.*$/gm, '');
            const moduleMatch = stripped.match(/^\s*([A-Za-z][A-Za-z0-9-]*)\s+DEFINITIONS\s*::=\s*BEGIN/im);
            const importsMatch = stripped.match(/\bIMPORTS\b([\s\S]*?);/i);
            const imports = [];

            if (importsMatch) {
                const importBody = importsMatch[1];
                const importPattern = /\bFROM\s+([A-Za-z][A-Za-z0-9-]*)/gi;
                let match = importPattern.exec(importBody);
                while (match) {
                    imports.push(match[1]);
                    match = importPattern.exec(importBody);
                }
            }

            return {
                moduleName: moduleMatch ? moduleMatch[1] : null,
                imports: Array.from(new Set(imports)),
                sourceBytes: Buffer.byteLength(content)
            };
        } catch (error) {
            return {
                moduleName: null,
                imports: [],
                sourceBytes: 0,
                parseError: error.message
            };
        }
    }

    getKnownModuleNames(metadata) {
        const names = new Set(this.getModuleNames(true));
        for (const item of metadata.values()) {
            if (item.moduleName) {
                names.add(item.moduleName);
            }
        }
        return names;
    }

    loadFromFilesInBatch(filePaths, metadata, progressReporter = new MibCompileProgressReporter()) {
        const parser = this.store?.parser;
        if (!parser || typeof parser.ParseModule !== 'function' || typeof parser.Serialize !== 'function') {
            throw new Error('当前 net-snmp 版本不支持流式 MIB 批量编译');
        }

        const loadedFiles = [];
        const failedFiles = [];
        const availableModules = new Set(this.getModuleNames(true));
        const batches = this.createMibBatches(filePaths, metadata);

        batches.forEach(batch => {
            const readyFiles = [];
            const plannedModules = new Set(availableModules);
            batch.forEach(filePath => {
                const fileMeta = metadata.get(filePath);
                const missingImports = (fileMeta?.imports || []).filter(moduleName => !plannedModules.has(moduleName));
                if (missingImports.length > 0) {
                    const record = this.createFileRecord(filePath, `MIB依赖编译失败: ${missingImports.join(', ')}`);
                    failedFiles.push(record);
                    progressReporter.finishFile(filePath, 'failed', record.msg);
                    return;
                }

                readyFiles.push(filePath);
                plannedModules.add(fileMeta.moduleName);
            });

            if (readyFiles.length === 0) {
                return;
            }

            const batchResult = this.tryLoadMibBatch(readyFiles, metadata, progressReporter);
            if (batchResult.success) {
                readyFiles.forEach(filePath => {
                    loadedFiles.push(filePath);
                    availableModules.add(metadata.get(filePath).moduleName);
                    progressReporter.finishFile(filePath, 'compiled');
                });
                return;
            }

            logger.warn(`MIB批次解析失败，隔离批次内文件: ${batchResult.error.message}`);
            readyFiles.forEach(filePath => {
                const fileMeta = metadata.get(filePath);
                const missingImports = (fileMeta?.imports || []).filter(
                    moduleName => !availableModules.has(moduleName)
                );
                if (missingImports.length > 0) {
                    const record = this.createFileRecord(filePath, `MIB依赖编译失败: ${missingImports.join(', ')}`);
                    failedFiles.push(record);
                    progressReporter.finishFile(filePath, 'failed', record.msg);
                    return;
                }

                const singleResult = this.tryLoadMibBatch([filePath], metadata, progressReporter);
                if (!singleResult.success) {
                    const record = this.createFileRecord(filePath, `MIB解析失败: ${singleResult.error.message}`);
                    failedFiles.push(record);
                    progressReporter.finishFile(filePath, 'failed', record.msg);
                    return;
                }

                loadedFiles.push(filePath);
                availableModules.add(fileMeta.moduleName);
                progressReporter.finishFile(filePath, 'compiled');
            });
        });

        return {
            loadedFiles,
            failedFiles
        };
    }

    createMibBatches(filePaths, metadata) {
        const batches = [];
        let currentBatch = [];
        let currentBytes = 0;

        const flush = () => {
            if (currentBatch.length > 0) {
                batches.push(currentBatch);
                currentBatch = [];
                currentBytes = 0;
            }
        };

        filePaths.forEach(filePath => {
            const sourceBytes = metadata.get(filePath)?.sourceBytes || 0;
            if (
                currentBatch.length > 0 &&
                (currentBatch.length >= MAX_MIB_FILES_PER_BATCH ||
                    currentBytes + sourceBytes > MAX_MIB_SOURCE_BYTES_PER_BATCH)
            ) {
                flush();
            }

            currentBatch.push(filePath);
            currentBytes += sourceBytes;
            if (currentBatch.length >= MAX_MIB_FILES_PER_BATCH || currentBytes >= MAX_MIB_SOURCE_BYTES_PER_BATCH) {
                flush();
            }
        });
        flush();
        return batches;
    }

    tryLoadMibBatch(filePaths, metadata, progressReporter = new MibCompileProgressReporter()) {
        const parser = this.store.parser;
        const moduleNamesBefore = new Set(Object.keys(parser.Modules || {}));
        const macroState = this.captureParserMacroState();
        const expectedModules = new Set(filePaths.map(filePath => metadata.get(filePath).moduleName));

        try {
            this.withSuppressedConsole(() => {
                filePaths.forEach(filePath => {
                    progressReporter.startFile(filePath);
                    const parserKey = `__netnexus_${this.parserKeySequence++}`;
                    parser.ParseModule(parserKey, fs.readFileSync(filePath, 'utf8'));
                    const detectedModuleName = parser.CharBuffer.ModuleName[parserKey];
                    const expectedModuleName = metadata.get(filePath).moduleName;
                    if (detectedModuleName !== expectedModuleName) {
                        throw new Error(
                            `模块名解析不一致: 预扫描 ${expectedModuleName}，解析器 ${detectedModuleName || '未识别'}`
                        );
                    }
                });
                progressReporter.serializing(filePaths);
                parser.Serialize();
            });

            const unexpectedModules = Object.keys(parser.Modules || {}).filter(
                moduleName => !moduleNamesBefore.has(moduleName) && !expectedModules.has(moduleName)
            );
            if (unexpectedModules.length > 0) {
                throw new Error(`解析器生成了异常模块: ${unexpectedModules.join(', ')}`);
            }

            for (const moduleName of expectedModules) {
                if (!parser.Modules[moduleName]) {
                    throw new Error(`解析后未生成模块 ${moduleName}`);
                }
            }

            return { success: true };
        } catch (error) {
            this.rollbackParserState(moduleNamesBefore, macroState);
            return {
                success: false,
                error
            };
        } finally {
            this.clearParserWorkingSet();
        }
    }

    captureParserMacroState() {
        const parser = this.store.parser;
        const names = Array.isArray(parser.MACROS) ? [...parser.MACROS] : [];
        return {
            names,
            definitions: new Map(Array.from(new Set(names)).map(name => [name, parser[name]]))
        };
    }

    rollbackParserState(moduleNamesBefore, macroState) {
        const parser = this.store.parser;
        Object.keys(parser.Modules || {}).forEach(moduleName => {
            if (!moduleNamesBefore.has(moduleName)) {
                delete parser.Modules[moduleName];
            }
        });

        const currentMacroNames = Array.isArray(parser.MACROS) ? parser.MACROS : [];
        currentMacroNames.forEach(name => {
            if (!macroState.definitions.has(name)) {
                delete parser[name];
            }
        });
        macroState.definitions.forEach((definition, name) => {
            parser[name] = definition;
        });
        parser.MACROS = [...macroState.names];
    }

    clearParserWorkingSet() {
        const parser = this.store?.parser;
        if (!parser) {
            return;
        }

        if (parser.CharBuffer) {
            parser.CharBuffer.Table = {};
            parser.CharBuffer.ModuleName = {};
        }
        parser.SymbolBuffer = {};
    }

    withSuppressedConsole(fn) {
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;
        console.log = () => {};
        console.warn = () => {};
        console.error = () => {};
        try {
            return fn();
        } finally {
            console.log = originalLog;
            console.warn = originalWarn;
            console.error = originalError;
        }
    }

    expandInputPaths(inputPaths) {
        const files = [];
        const failedPaths = [];
        const seen = new Set();

        const addFile = filePath => {
            if (seen.has(filePath)) {
                return;
            }

            if (!this.isMibCandidateFile(filePath)) {
                return;
            }

            seen.add(filePath);
            files.push(filePath);
        };

        const visitPath = inputPath => {
            let stat;
            try {
                stat = fs.statSync(inputPath);
            } catch (error) {
                failedPaths.push({
                    filePath: inputPath,
                    fileName: path.basename(inputPath),
                    msg: '路径不存在或不可访问: ' + error.message
                });
                return;
            }

            if (stat.isFile()) {
                addFile(inputPath);
                return;
            }

            if (!stat.isDirectory()) {
                failedPaths.push({
                    filePath: inputPath,
                    fileName: path.basename(inputPath),
                    msg: '不是文件或目录'
                });
                return;
            }

            this.walkDirectory(inputPath, addFile, failedPaths);
        };

        inputPaths.forEach(visitPath);

        return {
            files,
            failedPaths
        };
    }

    walkDirectory(directoryPath, addFile, failedPaths) {
        let entries;
        try {
            entries = fs.readdirSync(directoryPath, { withFileTypes: true });
            entries.sort((left, right) => left.name.localeCompare(right.name));
        } catch (error) {
            failedPaths.push({
                filePath: directoryPath,
                fileName: path.basename(directoryPath),
                msg: '目录读取失败: ' + error.message
            });
            return;
        }

        entries.forEach(entry => {
            if (entry.name.startsWith('.')) {
                return;
            }

            const entryPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
                this.walkDirectory(entryPath, addFile, failedPaths);
                return;
            }

            if (entry.isFile()) {
                addFile(entryPath);
            }
        });
    }

    isMibCandidateFile(filePath) {
        return MIB_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    }

    rebuildOidIndex() {
        this.oidIndex.clear();

        const modules = this.getModules(true);
        const syntaxTypes = this.getSyntaxTypes();
        Object.entries(modules).forEach(([moduleName, module]) => {
            Object.entries(module || {}).forEach(([objectName, definition]) => {
                if (!definition || typeof definition !== 'object' || !definition.OID) {
                    return;
                }

                const enumValues = this.getEnumerationValues(definition.SYNTAX, syntaxTypes);
                definition.ModuleName ||= moduleName;
                definition.ObjectName ||= objectName;
                if (Object.keys(enumValues).length > 0) {
                    definition.EnumValues = enumValues;
                }
                this.oidIndex.set(definition.OID, definition);
            });
        });

        this.rebuildOidChildIndex();
    }

    rebuildOidChildIndex() {
        this.oidChildIndex.clear();

        const oids = Array.from(this.oidIndex.keys()).sort(this.compareOid);
        oids.forEach(oid => {
            const parentOid = this.findNearestParentOid(oid, this.oidIndex);
            const parentKey = parentOid || '';
            if (!this.oidChildIndex.has(parentKey)) {
                this.oidChildIndex.set(parentKey, []);
            }
            this.oidChildIndex.get(parentKey).push(oid);
        });
    }

    getModules(includeBase = false) {
        try {
            return this.store.getModules(includeBase) || {};
        } catch (error) {
            logger.error('获取MIB模块失败:', error);
            return {};
        }
    }

    getSyntaxTypes() {
        try {
            return this.store.getSyntaxTypes() || {};
        } catch (error) {
            logger.warn('获取MIB语法类型失败:', error.message);
            return {};
        }
    }

    getEnumerationValues(syntax, syntaxTypes = {}, visitedTypes = new Set()) {
        if (typeof syntax === 'string') {
            if (visitedTypes.has(syntax) || !syntaxTypes[syntax]) {
                return {};
            }

            visitedTypes.add(syntax);
            return this.getEnumerationValues(syntaxTypes[syntax], syntaxTypes, visitedTypes);
        }

        if (!syntax || typeof syntax !== 'object' || Array.isArray(syntax)) {
            return {};
        }

        for (const integerSyntax of ['INTEGER', 'Integer32']) {
            const enumValues = this.normalizeEnumerationValues(syntax[integerSyntax]);
            if (Object.keys(enumValues).length > 0) {
                return enumValues;
            }
        }

        return this.normalizeEnumerationValues(syntax);
    }

    normalizeEnumerationValues(values) {
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
            return {};
        }

        return Object.fromEntries(
            Object.entries(values)
                .filter(([value, name]) => /^-?\d+$/.test(value) && typeof name === 'string' && name.length > 0)
                .map(([value, name]) => [value, name])
        );
    }

    getEnumerationName(enumValues, value) {
        if (!enumValues || value === null || value === undefined) {
            return '';
        }

        const normalizedValue = String(value).trim();
        return Object.prototype.hasOwnProperty.call(enumValues, normalizedValue) ? enumValues[normalizedValue] : '';
    }

    getModuleNames(includeBase = false) {
        try {
            return this.store.getModuleNames(includeBase) || [];
        } catch (error) {
            logger.error('获取MIB模块名失败:', error);
            return [];
        }
    }

    getSummary() {
        const moduleNames = this.cachedModuleNames || this.getModuleNames(false);
        const moduleNamesWithBase = this.cachedBaseModuleNames
            ? [...moduleNames, ...this.cachedBaseModuleNames]
            : this.getModuleNames(true);

        return {
            requestedFiles: this.compiledFiles,
            expandedFileCount: this.loadedFiles.length + this.failedFiles.length + this.skippedFiles.length,
            loadedFiles: this.loadedFiles.map(filePath => ({
                filePath,
                fileName: path.basename(filePath),
                status: 'compiled'
            })),
            failedFiles: this.failedFiles,
            skippedFiles: this.skippedFiles,
            modules: moduleNames,
            baseModules: moduleNamesWithBase.filter(moduleName => !moduleNames.includes(moduleName)),
            totalObjects: this.oidIndex.size,
            cacheHit: this.cacheHit,
            oidTree: this.getOidTreeChildren()
        };
    }

    getOidTreeChildren(parentOid = '') {
        const normalizedParentOid = this.normalizeOid(parentOid);
        const childOids = this.oidChildIndex.get(normalizedParentOid) || [];

        return childOids.map(oid =>
            this.toOidTreeNode(oid, this.oidIndex.get(oid), {
                parentOid: normalizedParentOid || null
            })
        );
    }

    getOidTreePath(oid) {
        const normalizedOid = this.normalizeOid(oid);
        if (!normalizedOid || !this.oidIndex.has(normalizedOid)) {
            return [];
        }

        const pathParts = [normalizedOid];
        let currentOid = normalizedOid;
        let parentOid = this.findNearestParentOid(currentOid, this.oidIndex);
        while (parentOid) {
            pathParts.unshift(parentOid);
            currentOid = parentOid;
            parentOid = this.findNearestParentOid(currentOid, this.oidIndex);
        }

        return pathParts;
    }

    buildOidTree() {
        const nodes = new Map();
        const roots = [];
        const oids = Array.from(this.oidIndex.keys()).sort(this.compareOid);

        oids.forEach(oid => {
            nodes.set(oid, this.toOidTreeNode(oid, this.oidIndex.get(oid), { includeChildren: true }));
        });

        oids.forEach(oid => {
            const node = nodes.get(oid);
            const parentOid = this.findNearestParentOid(oid, nodes);
            if (parentOid) {
                nodes.get(parentOid).children.push(node);
                return;
            }

            roots.push(node);
        });

        this.annotateQueryOids(nodes);
        return roots;
    }

    toOidTreeNode(oid, definition = {}, options = {}) {
        const objectName = definition.ObjectName || definition.NAME || oid;
        const moduleName = definition.ModuleName || '';
        const accessCapabilities = this.getAccessCapabilities(definition);
        const parentOid = Object.prototype.hasOwnProperty.call(options, 'parentOid')
            ? options.parentOid
            : this.findNearestParentOid(oid, this.oidIndex);
        const childOids = this.oidChildIndex.get(oid) || [];
        const queryMetadata = this.getNodeQueryMetadata(
            oid,
            {
                ...accessCapabilities,
                objectName,
                macro: definition.MACRO || '',
                maxAccess: definition['MAX-ACCESS'] || definition.ACCESS || '',
                syntax: this.formatSyntax(definition.SYNTAX)
            },
            parentOid
        );

        return {
            key: oid,
            title: objectName,
            oid,
            objectName,
            moduleName,
            moduleQualifiedName: moduleName ? `${moduleName}::${objectName}` : objectName,
            pathName: definition.NameSpace || '',
            macro: definition.MACRO || '',
            syntax: this.formatSyntax(definition.SYNTAX),
            maxAccess: definition['MAX-ACCESS'] || definition.ACCESS || '',
            status: definition.STATUS || '',
            ...accessCapabilities,
            ...queryMetadata,
            hasChildren: childOids.length > 0,
            isLeaf: childOids.length === 0,
            children: []
        };
    }

    annotateQueryOids(nodes) {
        for (const [oid, node] of nodes.entries()) {
            const parentOid = this.findNearestParentOid(oid, nodes);
            Object.assign(node, this.getNodeQueryMetadata(oid, node, parentOid));
        }
    }

    getNodeQueryMetadata(oid, node, parentOid) {
        const isTableColumn = this.isTableColumnNodeByOid(node, parentOid);
        const isScalar = Boolean((node.canGet || node.canSet) && !isTableColumn);

        return {
            isScalar,
            isTableColumn,
            queryOid: isScalar ? `${oid}.0` : oid
        };
    }

    isTableColumnNodeByOid(node, parentOid) {
        if (!node || !parentOid || !(node.canGet || node.canSet)) {
            return false;
        }

        const parentDefinition = this.oidIndex.get(parentOid);
        if (!parentDefinition) {
            return false;
        }

        const parentMacro = String(parentDefinition.MACRO || '').toUpperCase();
        const parentAccess = String(parentDefinition['MAX-ACCESS'] || parentDefinition.ACCESS || '').toLowerCase();
        if (parentMacro !== 'OBJECT-TYPE' || parentAccess !== 'not-accessible') {
            return false;
        }

        const parentObjectName = parentDefinition.ObjectName || parentDefinition.NAME || '';
        if (/Entry$/i.test(parentObjectName)) {
            return true;
        }

        const siblingValueNodeCount = (this.oidChildIndex.get(parentOid) || []).filter(childOid => {
            const capabilities = this.getAccessCapabilities(this.oidIndex.get(childOid));
            return capabilities.canGet || capabilities.canSet;
        }).length;
        return siblingValueNodeCount > 1 && !this.isPrimitiveSyntax(this.formatSyntax(parentDefinition.SYNTAX));
    }

    isTableColumnNode(node, parentNode) {
        if (!node || !parentNode || !(node.canGet || node.canSet)) {
            return false;
        }

        const parentMacro = String(parentNode.macro || '').toUpperCase();
        const parentAccess = String(parentNode.maxAccess || '').toLowerCase();
        if (parentMacro !== 'OBJECT-TYPE' || parentAccess !== 'not-accessible') {
            return false;
        }

        if (/Entry$/i.test(parentNode.objectName || '')) {
            return true;
        }

        const siblingValueNodeCount = (parentNode.children || []).filter(child => child.canGet || child.canSet).length;
        return siblingValueNodeCount > 1 && !this.isPrimitiveSyntax(parentNode.syntax);
    }

    isPrimitiveSyntax(syntax = '') {
        return /^(Integer|Integer32|Unsigned32|Counter32|Counter64|Gauge32|TimeTicks|OctetString|ObjectIdentifier|OID|IpAddress|Boolean)$/i.test(
            String(syntax).replace(/\s+/g, '')
        );
    }

    getAccessCapabilities(definition = {}) {
        const macro = String(definition.MACRO || '').toUpperCase();
        const access = String(definition['MAX-ACCESS'] || definition.ACCESS || '').toLowerCase();
        const isObjectType = macro === 'OBJECT-TYPE';
        const isNotification = macro === 'NOTIFICATION-TYPE' || macro === 'TRAP-TYPE';
        const canGet = isObjectType && ['read-only', 'read-write', 'read-create'].includes(access);
        const canSet = isObjectType && ['read-write', 'read-create', 'write-only'].includes(access);
        const notifyOnly = isNotification || access === 'accessible-for-notify';
        let nodeRole = 'container';

        if (canSet) {
            nodeRole = 'read-write';
        } else if (canGet) {
            nodeRole = 'read-only';
        } else if (notifyOnly) {
            nodeRole = 'notify-only';
        } else if (access === 'not-accessible') {
            nodeRole = 'not-accessible';
        } else if (isObjectType) {
            nodeRole = 'object';
        } else if (isNotification) {
            nodeRole = 'notification';
        }

        return {
            canGet,
            canSet,
            notifyOnly,
            nodeRole
        };
    }

    findNearestParentOid(oid, nodes) {
        const parts = oid.split('.');
        for (let length = parts.length - 1; length > 0; length--) {
            const parentOid = parts.slice(0, length).join('.');
            if (nodes.has(parentOid)) {
                return parentOid;
            }
        }

        return null;
    }

    compareOid(left, right) {
        const leftParts = left.split('.').map(Number);
        const rightParts = right.split('.').map(Number);
        const length = Math.max(leftParts.length, rightParts.length);

        for (let index = 0; index < length; index++) {
            const leftValue = leftParts[index] ?? -1;
            const rightValue = rightParts[index] ?? -1;
            if (leftValue !== rightValue) {
                return leftValue - rightValue;
            }
        }

        return 0;
    }

    translateOid(oid) {
        const normalizedOid = this.normalizeOid(oid);
        if (!normalizedOid) {
            return {
                oid,
                matched: false
            };
        }

        const match = this.findBestOidMatch(normalizedOid);
        if (!match) {
            return {
                oid: normalizedOid,
                matched: false
            };
        }

        const moduleQualifiedName =
            match.definition.ModuleName && match.definition.ObjectName
                ? `${match.definition.ModuleName}::${match.definition.ObjectName}`
                : this.safeTranslate(match.oid, snmp.OidFormat.module);
        const pathName = match.definition.NameSpace || this.safeTranslate(match.oid, snmp.OidFormat.path) || null;
        const accessCapabilities = this.getAccessCapabilities(match.definition);
        const queryMetadata = this.getNodeQueryMetadata(
            match.oid,
            {
                ...accessCapabilities,
                objectName: match.definition.ObjectName || match.definition.NAME || match.oid
            },
            this.findNearestParentOid(match.oid, this.oidIndex)
        );

        return {
            oid: normalizedOid,
            matched: true,
            matchedOid: match.oid,
            instanceSuffix: match.instanceSuffix,
            moduleName: match.definition.ModuleName || null,
            objectName: match.definition.ObjectName || null,
            moduleQualifiedName,
            pathName,
            macro: match.definition.MACRO || null,
            syntax: this.formatSyntax(match.definition.SYNTAX),
            enumValues: match.definition.EnumValues || {},
            maxAccess: match.definition['MAX-ACCESS'] || match.definition.ACCESS || null,
            status: match.definition.STATUS || null,
            description: match.definition.DESCRIPTION || null,
            treePath: this.getOidTreePath(match.oid),
            ...accessCapabilities,
            ...queryMetadata
        };
    }

    enrichVarbind(varbind = {}) {
        const oidInfo = this.translateOid(varbind.oid);
        const rawType = varbind.rawType || varbind.type;
        const typeName = this.getObjectTypeName(rawType);
        const formattedValue = formatSnmpValue(varbind.value);
        const value = formattedValue.value;
        const valueInfo = this.shouldTranslateValue(rawType, value) ? this.translateOid(value) : null;
        const enumName = this.getEnumerationName(oidInfo.enumValues, value);

        return {
            ...varbind,
            type: typeName,
            rawType,
            ...formattedValue,
            oidName: oidInfo.moduleQualifiedName || oidInfo.objectName || '',
            oidModule: oidInfo.moduleName || '',
            oidObject: oidInfo.objectName || '',
            oidPath: oidInfo.pathName || '',
            oidDescription: oidInfo.description || '',
            oidSyntax: oidInfo.syntax || '',
            oidMacro: oidInfo.macro || '',
            oidInstance: oidInfo.instanceSuffix || '',
            oidMatched: oidInfo.matched,
            valueName: valueInfo?.moduleQualifiedName || '',
            valuePath: valueInfo?.pathName || '',
            ...(enumName
                ? {
                      enumName,
                      displayValue: `${enumName} (${value})`
                  }
                : {})
        };
    }

    findBestOidMatch(oid) {
        const parts = oid.split('.');
        for (let length = parts.length; length > 0; length--) {
            const prefix = parts.slice(0, length).join('.');
            const definition = this.oidIndex.get(prefix);
            if (definition) {
                return {
                    oid: prefix,
                    definition,
                    instanceSuffix: parts.slice(length).join('.')
                };
            }
        }

        return null;
    }

    safeTranslate(oid, format) {
        try {
            return this.store.translate(oid, format);
        } catch (error) {
            return null;
        }
    }

    normalizeOid(oid) {
        if (!oid || typeof oid !== 'string') {
            return '';
        }

        return oid.trim().replace(/^\./, '');
    }

    getObjectTypeName(type) {
        if (typeof type === 'string' && Number.isNaN(Number(type))) {
            return type;
        }

        return snmp.ObjectType[type] || String(type || '');
    }

    shouldTranslateValue(rawType, value) {
        const typeName = this.getObjectTypeName(rawType);
        const looksLikeOid = typeof value === 'string' && /^\d+(?:\.\d+)*$/.test(value);
        return (
            looksLikeOid && (typeName === 'OID' || typeName === 'ObjectIdentifier' || typeName === 'OBJECT IDENTIFIER')
        );
    }

    formatValue(value) {
        return formatSnmpValue(value).value;
    }

    formatSyntax(syntax) {
        if (!syntax) {
            return '';
        }

        if (typeof syntax === 'string') {
            return syntax;
        }

        if (typeof syntax === 'object') {
            return Object.keys(syntax).join(', ');
        }

        return String(syntax);
    }
}

module.exports = MibRegistry;
