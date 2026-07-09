const fs = require('fs');
const path = require('path');
const snmp = require('net-snmp');
const logger = require('../log/logger');
const { formatSnmpValue } = require('./snmpValueFormatter');

const MIB_FILE_EXTENSIONS = new Set(['.mib', '.txt', '.my', '']);
const MIB_CACHE_SCHEMA_VERSION = 1;

class MibRegistry {
    constructor() {
        this.reset();
    }

    reset() {
        this.store = snmp.createModuleStore();
        this.compiledFiles = [];
        this.loadedFiles = [];
        this.failedFiles = [];
        this.oidIndex = new Map();
        this.oidChildIndex = new Map();
        this.cachedModuleNames = null;
        this.cachedBaseModuleNames = null;
        this.cacheHit = false;
        this.rebuildOidIndex();
    }

    loadOrCompileMibFiles(filePaths = [], options = {}) {
        const requestedPaths = this.normalizeFilePaths(filePaths);
        if (requestedPaths.length === 0) {
            this.reset();
            return this.getSummary();
        }

        if (!options.force && options.cacheFilePath && this.loadCacheIfValid(requestedPaths, options.cacheFilePath)) {
            return this.getSummary();
        }

        const summary = this.compileMibFiles(requestedPaths);
        if (options.cacheFilePath) {
            this.saveCache(options.cacheFilePath, requestedPaths);
        }
        return summary;
    }

    compileMibFiles(filePaths = []) {
        const requestedPaths = this.normalizeFilePaths(filePaths);
        this.reset();
        this.compiledFiles = requestedPaths;

        if (requestedPaths.length === 0) {
            return this.getSummary();
        }

        const expansion = this.expandInputPaths(requestedPaths);
        const metadata = this.buildFileMetadata(expansion.files);
        const knownModules = this.getKnownModuleNames(metadata);
        const baseModules = new Set(this.getModuleNames(true));
        const loadedModuleNames = new Set(baseModules);
        const pending = [...expansion.files];
        const loaded = [];
        const failed = [...expansion.failedPaths];
        const lastErrors = new Map();
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
                    const msg = `缺少依赖MIB: ${unknownImports.join(', ')}`;
                    lastErrors.set(filePath, msg);
                    failed.push({
                        filePath,
                        fileName: path.basename(filePath),
                        msg
                    });
                    pending.splice(i, 1);
                    continue;
                }

                const waitingImports = fileMeta.imports.filter(moduleName => !loadedModuleNames.has(moduleName));
                if (waitingImports.length > 0) {
                    continue;
                }

                try {
                    const beforeModules = new Set(this.getModuleNames(true));
                    this.loadFromFile(filePath);
                    loaded.push(filePath);
                    this.getModuleNames(true).forEach(moduleName => {
                        if (!beforeModules.has(moduleName)) {
                            loadedModuleNames.add(moduleName);
                        }
                    });
                    if (fileMeta.moduleName) {
                        loadedModuleNames.add(fileMeta.moduleName);
                    }
                    pending.splice(i, 1);
                    progressed = true;
                } catch (error) {
                    lastErrors.set(filePath, error.message);
                    failed.push({
                        filePath,
                        fileName: path.basename(filePath),
                        msg: error.message
                    });
                    this.rebuildStoreFromFiles(loaded);
                    pending.splice(i, 1);
                }
            }
        }

        this.loadedFiles = loaded;
        this.failedFiles = [
            ...failed,
            ...pending.map(filePath => ({
                filePath,
                fileName: path.basename(filePath),
                msg: this.getWaitingDependencyMessage(
                    metadata.get(filePath),
                    loadedModuleNames,
                    lastErrors.get(filePath)
                )
            }))
        ];

        this.rebuildOidIndex();
        return this.getSummary();
    }

    loadCacheIfValid(requestedPaths, cacheFilePath) {
        try {
            if (!cacheFilePath || !fs.existsSync(cacheFilePath)) {
                return false;
            }

            const cache = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
            if (cache.version !== MIB_CACHE_SCHEMA_VERSION) {
                return false;
            }

            if (!this.areFileListsEqual(cache.requestedFiles || [], requestedPaths)) {
                return false;
            }

            const expansion = this.expandInputPaths(requestedPaths);
            if (expansion.failedPaths.length > 0) {
                return false;
            }

            const currentSignatures = this.getFileSignatures(expansion.files);
            if (!this.areFileSignaturesEqual(currentSignatures, cache.fileSignatures || [])) {
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

    saveCache(cacheFilePath, requestedPaths) {
        try {
            const expansion = this.expandInputPaths(requestedPaths);
            const cache = {
                version: MIB_CACHE_SCHEMA_VERSION,
                createdAt: new Date().toISOString(),
                requestedFiles: requestedPaths,
                fileSignatures: this.getFileSignatures(expansion.files),
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

    buildFileMetadata(filePaths) {
        const metadata = new Map();
        filePaths.forEach(filePath => {
            metadata.set(filePath, this.parseMibMetadata(filePath));
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
                imports: Array.from(new Set(imports))
            };
        } catch (error) {
            return {
                moduleName: null,
                imports: [],
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

    loadFromFile(filePath) {
        return this.withSuppressedConsole(() => this.store.loadFromFile(filePath));
    }

    rebuildStoreFromFiles(filePaths) {
        this.store = snmp.createModuleStore();
        filePaths.forEach(filePath => {
            this.loadFromFile(filePath);
        });
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
        Object.entries(modules).forEach(([moduleName, module]) => {
            Object.entries(module || {}).forEach(([objectName, definition]) => {
                if (!definition || typeof definition !== 'object' || !definition.OID) {
                    return;
                }

                this.oidIndex.set(definition.OID, {
                    ...definition,
                    ModuleName: definition.ModuleName || moduleName,
                    ObjectName: definition.ObjectName || objectName
                });
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
            if (!this.oidChildIndex.has(oid)) {
                this.oidChildIndex.set(oid, []);
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
            expandedFileCount: this.loadedFiles.length + this.failedFiles.length,
            loadedFiles: this.loadedFiles.map(filePath => ({
                filePath,
                fileName: path.basename(filePath),
                status: 'compiled'
            })),
            failedFiles: this.failedFiles,
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
            this.safeTranslate(match.oid, snmp.OidFormat.module) ||
            `${match.definition.ModuleName}::${match.definition.ObjectName}`;
        const pathName = this.safeTranslate(match.oid, snmp.OidFormat.path) || match.definition.NameSpace || null;
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
            valuePath: valueInfo?.pathName || ''
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
