const fs = require('fs');
const path = require('path');
const protobuf = require('protobufjs');
const logger = require('../../log/logger');
const { GRPC_METHOD_KIND, GRPC_DECODE_TARGET, GRPC_PROTO_TREE_KIND } = require('../../const/grpcConst');

const TO_OBJECT_OPTIONS = Object.freeze({
    longs: String,
    enums: String,
    defaults: true,
    arrays: true,
    objects: true,
    oneofs: true
});

const MAX_TEMPLATE_DEPTH = 6;
const LONG_TYPES = new Set(['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64']);
const PROTO_PATH_FIELD_NAMES = ['proto_path', 'encoding_path'];
const PROTO_CACHE_SCHEMA_VERSION = 1;
const MAX_PROTO_CACHE_FILE_BYTES = 64 * 1024 * 1024;

class ProtoCompileError extends Error {
    constructor(message, file = '', line = null) {
        super(message);
        this.name = 'ProtoCompileError';
        this.file = file;
        this.line = line;
    }
}

function stripLeadingDot(name) {
    return String(name || '').replace(/^\./u, '');
}

function extractLine(error) {
    const match = /\(line (\d+)\)/u.exec(String(error && error.message ? error.message : ''));
    if (match) {
        return Number(match[1]);
    }
    if (error && Number.isInteger(error.line)) {
        return error.line;
    }
    return null;
}

function getMethodKind(method) {
    if (method.requestStream && method.responseStream) {
        return GRPC_METHOD_KIND.BIDI_STREAM;
    }
    if (method.requestStream) {
        return GRPC_METHOD_KIND.CLIENT_STREAM;
    }
    if (method.responseStream) {
        return GRPC_METHOD_KIND.SERVER_STREAM;
    }
    return GRPC_METHOD_KIND.UNARY;
}

function toHex(buffer, maxBytes) {
    if (!buffer || buffer.length === 0) {
        return '';
    }
    const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, buffer.length) : buffer.length;
    const hex = Buffer.from(buffer.buffer, buffer.byteOffset, limit).toString('hex');
    return limit < buffer.length ? `${hex}...(${buffer.length} bytes)` : hex;
}

function bufferOf(value) {
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (typeof value === 'string') {
        return Buffer.from(value, 'base64');
    }
    return Buffer.alloc(0);
}

function normalizeProtoPath(protoPath) {
    // 兼容 "huawei_ifm.Ifm.interfaces.interface" 与 "huawei-ifm:ifm/interfaces/interface" 两种写法
    return String(protoPath || '')
        .trim()
        .replace(/-/gu, '_')
        .replace(/[:/]/gu, '.')
        .split('.')
        .map(segment => segment.trim())
        .filter(Boolean);
}

function normalizePathList(value) {
    return Array.from(
        new Set(
            (Array.isArray(value) ? value : [])
                .map(item => String(item || '').trim())
                .filter(Boolean)
                .map(item => path.resolve(item))
        )
    );
}

function fieldTypeText(field) {
    const base = field.resolvedType || field.type;
    if (field.rule === 'map') {
        return `map<${field.keyType}, ${base}>`;
    }
    if (field.rule === 'repeated') {
        return `repeated ${base}`;
    }
    return base;
}

class ProtoRegistry {
    constructor(options = {}) {
        // 内置模板只随源码仓库提供（resources/grpc/protos），不打包进安装包；打包后目录不存在即无内置模板。
        this.builtinDir = options.builtinDir || path.join(__dirname, '..', '..', '..', 'resources', 'grpc', 'protos');
        this.root = null;
        this.catalog = null;
        this.compiledFiles = [];
        this.includeDirs = [];
        this.cacheHit = false;
        this.treeIndex = null;
        // 解析后的绝对路径 -> proto 里的 import 字符串，保存工程时用于还原目录结构
        this.importTargets = new Map();
    }

    isCompiled() {
        return this.root !== null;
    }

    // ------------------------------------------------------------------
    // 内置 proto
    // ------------------------------------------------------------------

    listBuiltinProtoFiles() {
        try {
            return fs
                .readdirSync(this.builtinDir)
                .filter(name => name.endsWith('.proto'))
                .sort()
                .map(name => ({ name, path: path.join(this.builtinDir, name) }));
        } catch (_error) {
            return [];
        }
    }

    resolveBuiltinFile(name) {
        const safeName = path.basename(String(name || ''));
        if (!safeName.endsWith('.proto')) {
            return null;
        }
        const filePath = path.join(this.builtinDir, safeName);
        return fs.existsSync(filePath) ? filePath : null;
    }

    isBuiltinFile(filePath) {
        const resolved = path.resolve(String(filePath || ''));
        return path.dirname(resolved) === path.resolve(this.builtinDir);
    }

    createResolvePath(includeDirs) {
        return (origin, target) => {
            if (path.isAbsolute(target)) {
                return target;
            }
            const candidates = [];
            if (origin) {
                candidates.push(path.resolve(path.dirname(origin), target));
            }
            includeDirs.forEach(dir => candidates.push(path.resolve(dir, target)));
            candidates.push(path.resolve(this.builtinDir, target));
            const found = candidates.find(candidate => fs.existsSync(candidate));
            if (found) {
                if (origin) {
                    this.importTargets.set(found, target);
                }
                return found;
            }
            return candidates[0] || path.resolve(target);
        };
    }

    // ------------------------------------------------------------------
    // 编译 / 缓存
    // ------------------------------------------------------------------

    /**
     * 优先从缓存恢复；缓存失效或 force 时重新编译并写入缓存。
     */
    loadOrCompile({ filePaths = [], includeDirs = [], cacheFilePath = '', force = false } = {}) {
        const files = normalizePathList(filePaths);
        const dirs = normalizePathList(includeDirs);
        if (!force && cacheFilePath && this.loadCacheIfValid(files, dirs, cacheFilePath)) {
            return this.catalog;
        }
        const catalog = this.compile({ filePaths: files, includeDirs: dirs });
        if (cacheFilePath) {
            this.saveCache(cacheFilePath);
        }
        return catalog;
    }

    compile({ filePaths = [], includeDirs = [] } = {}) {
        const files = normalizePathList(filePaths);
        if (files.length === 0) {
            throw new ProtoCompileError('请至少选择一个 .proto 文件');
        }
        const dirs = normalizePathList(includeDirs);

        const root = new protobuf.Root();
        this.importTargets = new Map();
        root.resolvePath = this.createResolvePath(dirs);

        for (const file of files) {
            if (!fs.existsSync(file)) {
                throw new ProtoCompileError(`文件不存在: ${file}`, file);
            }
            try {
                root.loadSync(file, { keepCase: true, alternateCommentMode: true });
            } catch (error) {
                const line = extractLine(error);
                const message = String(error.message || error).replace(/\s*\(line \d+\)/u, '');
                throw new ProtoCompileError(`${path.basename(file)}: ${message}`, file, line);
            }
        }

        try {
            root.resolveAll();
        } catch (error) {
            throw new ProtoCompileError(`类型解析失败: ${error.message}`);
        }

        this.root = root;
        this.compiledFiles = files;
        this.includeDirs = dirs;
        this.cacheHit = false;
        this.treeIndex = null;
        this.catalog = this.buildCatalog(root.files || []);
        return this.catalog;
    }

    clear() {
        this.root = null;
        this.catalog = null;
        this.compiledFiles = [];
        this.includeDirs = [];
        this.cacheHit = false;
        this.treeIndex = null;
    }

    getCatalog() {
        return this.catalog;
    }

    getFileSignatures(filePaths = []) {
        return normalizePathList(filePaths).map(filePath => {
            try {
                const stat = fs.statSync(filePath);
                return { path: filePath, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
            } catch (_error) {
                return { path: filePath, size: -1, mtimeMs: -1 };
            }
        });
    }

    areSignaturesEqual(left = [], right = []) {
        if (left.length !== right.length) {
            return false;
        }
        return left.every(
            (item, index) =>
                item.path === right[index].path &&
                item.size === right[index].size &&
                item.mtimeMs === right[index].mtimeMs
        );
    }

    buildSnapshot() {
        return {
            requestedFiles: [...this.compiledFiles],
            includeDirs: [...this.includeDirs],
            rootJson: this.root.toJSON(),
            catalog: this.catalog
        };
    }

    loadSnapshot(snapshot = {}) {
        const root = protobuf.Root.fromJSON(snapshot.rootJson || {});
        root.resolveAll();
        this.root = root;
        this.compiledFiles = normalizePathList(snapshot.requestedFiles);
        this.includeDirs = normalizePathList(snapshot.includeDirs);
        this.catalog = snapshot.catalog || this.buildCatalog(this.compiledFiles);
        this.treeIndex = null;
    }

    loadCacheIfValid(files, dirs, cacheFilePath) {
        try {
            if (!cacheFilePath || !fs.existsSync(cacheFilePath)) {
                return false;
            }
            const stat = fs.statSync(cacheFilePath);
            if (stat.size > MAX_PROTO_CACHE_FILE_BYTES) {
                logger.warn(`proto 缓存文件过大（${stat.size} 字节），将重新编译`);
                return false;
            }
            const cache = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
            if (cache.version !== PROTO_CACHE_SCHEMA_VERSION || !cache.snapshot) {
                return false;
            }
            const requested = normalizePathList(cache.requestedFiles);
            const cachedDirs = normalizePathList(cache.includeDirs);
            if (requested.join('\n') !== files.join('\n') || cachedDirs.join('\n') !== dirs.join('\n')) {
                return false;
            }
            const loadedFiles = Array.isArray(cache.snapshot.catalog?.files)
                ? cache.snapshot.catalog.files.map(item => item.path)
                : requested;
            if (!this.areSignaturesEqual(this.getFileSignatures(loadedFiles), cache.fileSignatures || [])) {
                return false;
            }
            this.loadSnapshot(cache.snapshot);
            this.cacheHit = true;
            return true;
        } catch (error) {
            logger.warn('proto 缓存加载失败，将重新编译:', error.message);
            return false;
        }
    }

    saveCache(cacheFilePath) {
        if (!cacheFilePath || !this.root) {
            return;
        }
        try {
            const loadedFiles = (this.catalog?.files || []).map(item => item.path);
            const cache = {
                version: PROTO_CACHE_SCHEMA_VERSION,
                createdAt: new Date().toISOString(),
                requestedFiles: [...this.compiledFiles],
                includeDirs: [...this.includeDirs],
                fileSignatures: this.getFileSignatures(loadedFiles),
                snapshot: this.buildSnapshot()
            };
            fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
            fs.writeFileSync(cacheFilePath, JSON.stringify(cache), 'utf8');
        } catch (error) {
            logger.warn('proto 缓存写入失败:', error.message);
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
            logger.warn('proto 缓存删除失败:', error.message);
        }
    }

    // ------------------------------------------------------------------
    // 目录（catalog）
    // ------------------------------------------------------------------

    buildCatalog(loadedFiles) {
        const services = [];
        const messages = [];
        const enums = [];
        const packages = new Set();

        const walk = (namespace, parentType) => {
            for (const nested of namespace.nestedArray || []) {
                if (nested instanceof protobuf.Service) {
                    services.push(this.describeService(nested));
                    packages.add(this.packageOf(nested));
                } else if (nested instanceof protobuf.Type) {
                    messages.push(this.describeMessage(nested, parentType));
                    packages.add(this.packageOf(nested));
                    walk(nested, stripLeadingDot(nested.fullName));
                } else if (nested instanceof protobuf.Enum) {
                    enums.push(this.describeEnum(nested, parentType));
                    packages.add(this.packageOf(nested));
                } else if (nested instanceof protobuf.Namespace) {
                    walk(nested, '');
                }
            }
        };
        walk(this.root, '');

        services.sort((a, b) => a.fullName.localeCompare(b.fullName));
        messages.sort((a, b) => a.fullName.localeCompare(b.fullName));
        enums.sort((a, b) => a.fullName.localeCompare(b.fullName));

        const requested = new Set(this.compiledFiles);
        return {
            compiledAt: new Date().toISOString(),
            files: [...loadedFiles].map(file => ({
                path: file,
                name: path.basename(file),
                builtin: this.isBuiltinFile(file),
                requested: requested.has(file)
            })),
            requestedFiles: [...this.compiledFiles],
            includeDirs: [...this.includeDirs],
            packages: Array.from(packages).sort(),
            services,
            messages,
            enums,
            summary: {
                fileCount: loadedFiles.length,
                serviceCount: services.length,
                methodCount: services.reduce((sum, service) => sum + service.methods.length, 0),
                messageCount: messages.length,
                enumCount: enums.length
            }
        };
    }

    packageOf(reflectionObject) {
        let current = reflectionObject.parent;
        const segments = [];
        while (current && current !== this.root) {
            if (!(current instanceof protobuf.Type) && !(current instanceof protobuf.Service)) {
                segments.unshift(current.name);
            }
            current = current.parent;
        }
        return segments.join('.');
    }

    describeService(service) {
        const fullName = stripLeadingDot(service.fullName);
        return {
            name: service.name,
            fullName,
            package: this.packageOf(service),
            file: service.filename || '',
            comment: service.comment || '',
            methods: service.methodsArray.map(method => ({
                name: method.name,
                fullName: `${fullName}.${method.name}`,
                service: fullName,
                path: `/${fullName}/${method.name}`,
                kind: getMethodKind(method),
                requestStream: Boolean(method.requestStream),
                responseStream: Boolean(method.responseStream),
                requestType: stripLeadingDot(method.resolvedRequestType?.fullName || method.requestType),
                responseType: stripLeadingDot(method.resolvedResponseType?.fullName || method.responseType),
                comment: method.comment || ''
            }))
        };
    }

    describeMessage(type, parentType = '') {
        return {
            name: type.name,
            fullName: stripLeadingDot(type.fullName),
            package: this.packageOf(type),
            parentType,
            file: type.filename || '',
            comment: type.comment || '',
            fields: type.fieldsArray
                .slice()
                .sort((a, b) => a.id - b.id)
                .map(field => ({
                    name: field.name,
                    id: field.id,
                    type: field.type,
                    resolvedType: field.resolvedType ? stripLeadingDot(field.resolvedType.fullName) : '',
                    resolvedKind: field.resolvedType
                        ? field.resolvedType instanceof protobuf.Enum
                            ? 'enum'
                            : 'message'
                        : 'scalar',
                    rule: field.map ? 'map' : field.repeated ? 'repeated' : field.optional ? 'optional' : '',
                    keyType: field.map ? field.keyType : '',
                    oneof: field.partOf ? field.partOf.name : '',
                    comment: field.comment || ''
                })),
            oneofs: type.oneofsArray.map(oneof => ({ name: oneof.name, fields: [...oneof.oneof] })),
            nestedMessages: (type.nestedArray || [])
                .filter(nested => nested instanceof protobuf.Type)
                .map(nested => stripLeadingDot(nested.fullName)),
            nestedEnums: (type.nestedArray || [])
                .filter(nested => nested instanceof protobuf.Enum)
                .map(nested => stripLeadingDot(nested.fullName))
        };
    }

    describeEnum(enumType, parentType = '') {
        return {
            name: enumType.name,
            fullName: stripLeadingDot(enumType.fullName),
            package: this.packageOf(enumType),
            parentType,
            file: enumType.filename || '',
            comment: enumType.comment || '',
            values: Object.entries(enumType.values).map(([name, value]) => ({ name, value }))
        };
    }

    /**
     * 供渲染层使用的轻量状态：不包含消息/字段明细，树节点通过 getTreeChildren 按需获取。
     */
    getStatus() {
        if (!this.catalog) {
            return {
                compiled: false,
                cacheHit: false,
                requestedFiles: [...this.compiledFiles],
                includeDirs: [...this.includeDirs],
                files: [],
                packages: [],
                services: [],
                summary: { fileCount: 0, serviceCount: 0, methodCount: 0, messageCount: 0, enumCount: 0 },
                compiledAt: ''
            };
        }
        return {
            compiled: true,
            cacheHit: this.cacheHit,
            requestedFiles: [...this.compiledFiles],
            includeDirs: [...this.includeDirs],
            files: this.catalog.files,
            packages: this.catalog.packages,
            services: this.catalog.services,
            summary: this.catalog.summary,
            compiledAt: this.catalog.compiledAt
        };
    }

    // ------------------------------------------------------------------
    // 树（按需返回子节点，渲染层不持有整棵目录）
    // ------------------------------------------------------------------

    ensureTreeIndex() {
        if (this.treeIndex) {
            return this.treeIndex;
        }
        const catalog = this.catalog;
        if (!catalog) {
            throw new Error('尚未编译 proto 文件');
        }
        const children = new Map();
        const nodes = new Map();
        const parents = new Map();
        const add = (parentKey, node) => {
            if (!children.has(parentKey)) {
                children.set(parentKey, []);
            }
            children.get(parentKey).push(node);
            nodes.set(node.key, node);
            parents.set(node.key, parentKey);
        };

        const packages = catalog.packages.length > 0 ? catalog.packages : [''];
        packages.forEach(pkg => {
            add('', {
                key: `pkg:${pkg}`,
                title: pkg || '(默认包)',
                kind: GRPC_PROTO_TREE_KIND.PACKAGE,
                fullName: pkg,
                isLeaf: false
            });
        });

        catalog.services.forEach(service => {
            const key = `svc:${service.fullName}`;
            add(`pkg:${service.package}`, {
                key,
                title: service.name,
                kind: GRPC_PROTO_TREE_KIND.SERVICE,
                fullName: service.fullName,
                meta: `${service.methods.length} 个方法`,
                file: path.basename(service.file || ''),
                isLeaf: service.methods.length === 0
            });
            service.methods.forEach(method => {
                add(key, {
                    key: `method:${method.fullName}`,
                    title: method.name,
                    kind: GRPC_PROTO_TREE_KIND.METHOD,
                    fullName: method.fullName,
                    methodKind: method.kind,
                    meta: `${method.requestType} → ${method.responseType}`,
                    isLeaf: true
                });
            });
        });

        const addMessage = message => {
            const key = `msg:${message.fullName}`;
            const parentKey = message.parentType ? `msg:${message.parentType}` : `pkg:${message.package}`;
            const childCount = message.fields.length + message.nestedMessages.length + message.nestedEnums.length;
            add(parentKey, {
                key,
                title: message.name,
                kind: GRPC_PROTO_TREE_KIND.MESSAGE,
                fullName: message.fullName,
                meta: `${message.fields.length} 个字段`,
                file: path.basename(message.file || ''),
                isLeaf: childCount === 0
            });
        };
        const addEnum = enumType => {
            const key = `enum:${enumType.fullName}`;
            const parentKey = enumType.parentType ? `msg:${enumType.parentType}` : `pkg:${enumType.package}`;
            add(parentKey, {
                key,
                title: enumType.name,
                kind: GRPC_PROTO_TREE_KIND.ENUM,
                fullName: enumType.fullName,
                meta: `${enumType.values.length} 个值`,
                file: path.basename(enumType.file || ''),
                isLeaf: enumType.values.length === 0
            });
            enumType.values.forEach(value => {
                add(key, {
                    key: `enumval:${enumType.fullName}#${value.name}`,
                    title: value.name,
                    kind: GRPC_PROTO_TREE_KIND.ENUM_VALUE,
                    fullName: `${enumType.fullName}.${value.name}`,
                    meta: `= ${value.value}`,
                    isLeaf: true
                });
            });
        };

        // 父消息一定排在嵌套消息前（fullName 更短），保证父节点先创建
        const byDepth = [...catalog.messages].sort((a, b) => a.fullName.length - b.fullName.length);
        byDepth.forEach(addMessage);
        catalog.enums.forEach(addEnum);
        catalog.messages.forEach(message => {
            const key = `msg:${message.fullName}`;
            message.fields.forEach(field => {
                add(key, {
                    key: `field:${message.fullName}#${field.name}`,
                    title: field.name,
                    kind: GRPC_PROTO_TREE_KIND.FIELD,
                    fullName: `${message.fullName}.${field.name}`,
                    meta: `= ${field.id} · ${fieldTypeText(field)}`,
                    fieldKind: field.resolvedKind,
                    oneof: field.oneof,
                    isLeaf: true
                });
            });
        });

        this.treeIndex = { children, nodes, parents };
        return this.treeIndex;
    }

    getTreeChildren(parentKey = '') {
        const index = this.ensureTreeIndex();
        return (index.children.get(String(parentKey || '')) || []).map(node => ({ ...node }));
    }

    getTreePath(key) {
        const index = this.ensureTreeIndex();
        const pathKeys = [];
        let current = index.parents.get(key);
        while (current) {
            pathKeys.unshift(current);
            current = index.parents.get(current);
        }
        return pathKeys;
    }

    findTreeKey(fullName) {
        const name = stripLeadingDot(fullName);
        const index = this.ensureTreeIndex();
        for (const prefix of ['svc', 'msg', 'enum', 'method']) {
            const key = `${prefix}:${name}`;
            if (index.nodes.has(key)) {
                return key;
            }
        }
        return null;
    }

    /**
     * 返回节点详情（含祖先路径），供属性面板与定位使用。
     */
    getTreeNode(keyOrName) {
        const index = this.ensureTreeIndex();
        const key = index.nodes.has(keyOrName) ? keyOrName : this.findTreeKey(keyOrName);
        if (!key) {
            throw new Error(`节点不存在: ${keyOrName}`);
        }
        const node = index.nodes.get(key);
        const catalog = this.catalog;
        let detail = null;
        switch (node.kind) {
            case GRPC_PROTO_TREE_KIND.SERVICE:
                detail = catalog.services.find(item => item.fullName === node.fullName) || null;
                break;
            case GRPC_PROTO_TREE_KIND.METHOD: {
                const serviceName = node.fullName.slice(0, node.fullName.lastIndexOf('.'));
                const service = catalog.services.find(item => item.fullName === serviceName);
                detail = service ? service.methods.find(item => item.fullName === node.fullName) || null : null;
                break;
            }
            case GRPC_PROTO_TREE_KIND.MESSAGE:
                detail = catalog.messages.find(item => item.fullName === node.fullName) || null;
                break;
            case GRPC_PROTO_TREE_KIND.ENUM:
                detail = catalog.enums.find(item => item.fullName === node.fullName) || null;
                break;
            case GRPC_PROTO_TREE_KIND.FIELD: {
                const [messageName, fieldName] = key.slice('field:'.length).split('#');
                const message = catalog.messages.find(item => item.fullName === messageName);
                const field = message ? message.fields.find(item => item.name === fieldName) : null;
                detail = field ? { ...field, message: messageName, typeText: fieldTypeText(field) } : null;
                break;
            }
            case GRPC_PROTO_TREE_KIND.ENUM_VALUE: {
                const [enumName, valueName] = key.slice('enumval:'.length).split('#');
                const enumType = catalog.enums.find(item => item.fullName === enumName);
                const value = enumType ? enumType.values.find(item => item.name === valueName) : null;
                detail = value ? { ...value, enum: enumName } : null;
                break;
            }
            default:
                detail = { name: node.fullName };
        }
        return { node: { ...node }, detail, treePath: this.getTreePath(key) };
    }

    // ------------------------------------------------------------------
    // 类型查找
    // ------------------------------------------------------------------

    ensureCompiled() {
        if (!this.root) {
            throw new Error('尚未编译 proto 文件');
        }
    }

    lookupType(typeName) {
        this.ensureCompiled();
        const name = stripLeadingDot(typeName);
        try {
            return this.root.lookupType(name);
        } catch (_error) {
            throw new Error(`消息类型不存在: ${name}`);
        }
    }

    tryLookupType(typeName) {
        try {
            return this.lookupType(typeName);
        } catch (_error) {
            return null;
        }
    }

    lookupService(serviceName) {
        this.ensureCompiled();
        const name = stripLeadingDot(serviceName);
        try {
            return this.root.lookupService(name);
        } catch (_error) {
            throw new Error(`服务不存在: ${name}`);
        }
    }

    findMethod(methodFullName) {
        const name = stripLeadingDot(methodFullName);
        const index = name.lastIndexOf('.');
        if (index <= 0) {
            throw new Error(`方法名格式错误: ${name}`);
        }
        const service = this.lookupService(name.slice(0, index));
        const method = service.methods[name.slice(index + 1)];
        if (!method) {
            throw new Error(`方法不存在: ${name}`);
        }
        method.resolve();
        return { service, method };
    }

    /**
     * 生成 grpc-js 可直接使用的 service definition。
     * 反序列化返回 { raw, message }，序列化接受 Buffer（原样）或普通对象（按类型编码）。
     */
    buildServiceDefinition(serviceName) {
        const service = this.lookupService(serviceName);
        const serviceFullName = stripLeadingDot(service.fullName);
        const definition = {};

        for (const method of service.methodsArray) {
            method.resolve();
            const requestType = method.resolvedRequestType;
            const responseType = method.resolvedResponseType;
            definition[method.name] = {
                path: `/${serviceFullName}/${method.name}`,
                originalName: method.name,
                requestStream: Boolean(method.requestStream),
                responseStream: Boolean(method.responseStream),
                requestSerialize: value => this.serializeValue(requestType, value),
                requestDeserialize: buffer => this.deserializeValue(requestType, buffer),
                responseSerialize: value => this.serializeValue(responseType, value),
                responseDeserialize: buffer => this.deserializeValue(responseType, buffer)
            };
        }

        return { serviceFullName, definition, service };
    }

    serializeValue(type, value) {
        if (Buffer.isBuffer(value)) {
            return value;
        }
        return this.encodeMessage(type, value);
    }

    deserializeValue(type, buffer) {
        const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        return { raw, message: type.decode(raw) };
    }

    // ------------------------------------------------------------------
    // 编码
    // ------------------------------------------------------------------

    encodeMessage(typeOrName, plainObject) {
        const type = typeof typeOrName === 'string' ? this.lookupType(typeOrName) : typeOrName;
        const payload = this.normalizeForEncode(
            type,
            plainObject && typeof plainObject === 'object' ? plainObject : {},
            ''
        );
        const invalid = type.verify(payload);
        if (invalid) {
            throw new Error(`${stripLeadingDot(type.fullName)} 校验失败: ${invalid}`);
        }
        return Buffer.from(type.encode(type.fromObject(payload)).finish());
    }

    /**
     * 把界面 JSON 转成 verify 可接受的形态：枚举名 -> 数值、64 位整数字符串 -> Long、
     * 递归处理嵌套消息/repeated/map。未知字段原样保留，由 verify 报错。
     */
    normalizeForEncode(type, value, pathPrefix) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return value;
        }
        const output = {};
        for (const [key, item] of Object.entries(value)) {
            const field = type.fields[key];
            if (!field || item === undefined || item === null) {
                output[key] = item;
                continue;
            }
            field.resolve();
            const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;
            const convert = single => this.normalizeScalarForEncode(field, single, fieldPath);
            if (field.map) {
                if (typeof item !== 'object' || Array.isArray(item)) {
                    output[key] = item;
                    continue;
                }
                const mapped = {};
                for (const [mapKey, mapValue] of Object.entries(item)) {
                    mapped[mapKey] = convert(mapValue);
                }
                output[key] = mapped;
            } else if (field.repeated) {
                output[key] = Array.isArray(item) ? item.map(convert) : item;
            } else {
                output[key] = convert(item);
            }
        }
        return output;
    }

    normalizeScalarForEncode(field, value, fieldPath) {
        if (field.resolvedType instanceof protobuf.Type) {
            return this.normalizeForEncode(field.resolvedType, value, fieldPath);
        }
        if (field.resolvedType instanceof protobuf.Enum) {
            if (typeof value === 'string' && value in field.resolvedType.values) {
                return field.resolvedType.values[value];
            }
            if (typeof value === 'string' && /^-?\d+$/u.test(value.trim())) {
                return Number(value);
            }
            return value;
        }
        if (LONG_TYPES.has(field.type)) {
            if (typeof value === 'string' && /^-?\d+$/u.test(value.trim())) {
                const unsigned = field.type.startsWith('u') || field.type === 'fixed64';
                if (protobuf.util.Long) {
                    return protobuf.util.Long.fromString(value.trim(), unsigned, 10);
                }
                return Number(value);
            }
            return value;
        }
        if (field.type === 'bytes' && typeof value === 'string' && /^0x[0-9a-fA-F]*$/u.test(value)) {
            return Buffer.from(value.slice(2), 'hex');
        }
        if (
            (field.type === 'int32' ||
                field.type === 'uint32' ||
                field.type === 'sint32' ||
                field.type === 'fixed32' ||
                field.type === 'sfixed32' ||
                field.type === 'double' ||
                field.type === 'float') &&
            typeof value === 'string' &&
            value.trim() !== '' &&
            Number.isFinite(Number(value))
        ) {
            return Number(value);
        }
        return value;
    }

    // ------------------------------------------------------------------
    // 解码
    // ------------------------------------------------------------------

    /**
     * 解码并按规则展开嵌套的 bytes / JSON 字段。
     * @returns {{ value: Object, warnings: string[] }}
     */
    decodeMessage(typeOrName, input, options = {}) {
        const type = typeof typeOrName === 'string' ? this.lookupType(typeOrName) : typeOrName;
        const message = input instanceof protobuf.Message ? input : type.decode(bufferOf(input));
        const rules = this.indexDecodeRules(options.decodeRules);
        const warnings = [];
        const context = { protoPath: '' };
        const value = this.expandMessage(type, message, rules, context, warnings, options.maxRawHexBytes, 0);
        return { value, warnings: Array.from(new Set(warnings)) };
    }

    indexDecodeRules(decodeRules) {
        const index = new Map();
        for (const rule of Array.isArray(decodeRules) ? decodeRules : []) {
            if (!rule || !rule.messageType || !rule.field || !rule.targetType) {
                continue;
            }
            index.set(`${stripLeadingDot(rule.messageType)}#${rule.field}`, String(rule.targetType).trim());
        }
        return index;
    }

    expandMessage(type, message, rules, parentContext, warnings, maxRawHexBytes, depth) {
        const plain = type.toObject(message, TO_OBJECT_OPTIONS);
        const context = { ...parentContext };
        for (const fieldName of PROTO_PATH_FIELD_NAMES) {
            if (typeof plain[fieldName] === 'string' && plain[fieldName]) {
                context.protoPath = plain[fieldName];
            }
        }
        if (depth > 32) {
            warnings.push(`${stripLeadingDot(type.fullName)}: 嵌套层级过深，停止展开`);
            return plain;
        }

        const typeFullName = stripLeadingDot(type.fullName);
        for (const field of type.fieldsArray) {
            const fieldValue = plain[field.name];
            if (fieldValue === undefined || fieldValue === null) {
                continue;
            }
            const rawValue = message[field.name];
            const rule = rules.get(`${typeFullName}#${field.name}`);

            if (field.resolvedType instanceof protobuf.Type) {
                const subType = field.resolvedType;
                const expand = item =>
                    this.expandMessage(subType, item, rules, context, warnings, maxRawHexBytes, depth + 1);
                if (field.map) {
                    const mapped = {};
                    for (const key of Object.keys(rawValue || {})) {
                        mapped[key] = expand(rawValue[key]);
                    }
                    plain[field.name] = mapped;
                } else if (field.repeated) {
                    plain[field.name] = (rawValue || []).map(expand);
                } else if (rawValue) {
                    plain[field.name] = expand(rawValue);
                }
                continue;
            }

            if (field.type === 'bytes') {
                const convert = item =>
                    this.expandBytes(
                        typeFullName,
                        field.name,
                        bufferOf(item),
                        rule,
                        rules,
                        context,
                        warnings,
                        maxRawHexBytes,
                        depth
                    );
                if (field.map) {
                    const mapped = {};
                    for (const key of Object.keys(rawValue || {})) {
                        mapped[key] = convert(rawValue[key]);
                    }
                    plain[field.name] = mapped;
                } else if (field.repeated) {
                    plain[field.name] = (rawValue || []).map(convert);
                } else {
                    plain[field.name] = convert(rawValue);
                }
                continue;
            }

            if (field.type === 'string' && rule === GRPC_DECODE_TARGET.JSON) {
                const convert = item => this.expandJsonText(String(item), typeFullName, field.name, warnings);
                if (field.repeated) {
                    plain[field.name] = (fieldValue || []).map(convert);
                } else if (!field.map) {
                    plain[field.name] = convert(fieldValue);
                }
            }
        }

        return plain;
    }

    expandBytes(ownerType, fieldName, buffer, rule, rules, context, warnings, maxRawHexBytes, depth) {
        if (buffer.length === 0) {
            return '';
        }
        if (!rule) {
            return this.autoDecodeBytes(ownerType, fieldName, buffer, rules, context, warnings, maxRawHexBytes, depth);
        }
        if (rule === GRPC_DECODE_TARGET.JSON) {
            return this.expandJsonText(buffer.toString('utf8'), ownerType, fieldName, warnings);
        }

        let targetType = null;
        if (rule === GRPC_DECODE_TARGET.PROTO_PATH) {
            const resolved = this.resolveTypeByProtoPath(context.protoPath);
            if (!resolved) {
                warnings.push(
                    `${ownerType}.${fieldName}: 无法根据 proto_path "${context.protoPath || ''}" 找到消息类型，已保留原始字节`
                );
                return toHex(buffer, maxRawHexBytes);
            }
            targetType = resolved;
        } else {
            targetType = this.tryLookupType(rule);
            if (!targetType) {
                warnings.push(`${ownerType}.${fieldName}: 解码目标类型 ${rule} 不存在，已保留原始字节`);
                return toHex(buffer, maxRawHexBytes);
            }
        }

        try {
            const decoded = targetType.decode(buffer);
            return {
                $type: stripLeadingDot(targetType.fullName),
                $length: buffer.length,
                value: this.expandMessage(targetType, decoded, rules, context, warnings, maxRawHexBytes, depth + 1)
            };
        } catch (error) {
            warnings.push(
                `${ownerType}.${fieldName}: 按 ${stripLeadingDot(targetType.fullName)} 解码失败 (${error.message})，已保留原始字节`
            );
            return toHex(buffer, maxRawHexBytes);
        }
    }

    /**
     * 没有显式规则时的自动解码：
     * 1. 内容看起来是 JSON 文本 -> 解析；
     * 2. 上下文里有 proto_path / encoding_path 且能定位到消息类型 -> 按该类型解码；
     * 3. Telemetry 惯例：最外层的 data / payload 字段尝试用目录里名为 Telemetry 的消息解码。
     * 全部失败则保留 hex，不产生警告。
     */
    autoDecodeBytes(ownerType, fieldName, buffer, rules, context, warnings, maxRawHexBytes, depth) {
        const first = buffer[0];
        if (first === 0x7b || first === 0x5b) {
            try {
                return JSON.parse(buffer.toString('utf8'));
            } catch (_error) {
                // 不是 JSON，继续尝试
            }
        }

        const candidates = [];
        const byProtoPath = this.resolveTypeByProtoPath(context.protoPath);
        if (byProtoPath) {
            candidates.push(byProtoPath);
        }
        // 只在最外层（尚无 proto_path 上下文）对 data/payload 字段尝试 Telemetry 头，避免把行内容误判为头消息
        if (!context.protoPath && /^(data|payload)$/iu.test(fieldName) && this.catalog) {
            this.catalog.messages
                .filter(message => message.name === 'Telemetry' && message.fullName !== ownerType)
                .forEach(message => {
                    const type = this.tryLookupType(message.fullName);
                    if (type && !candidates.includes(type)) {
                        candidates.push(type);
                    }
                });
        }

        for (const targetType of candidates) {
            const decoded = this.tryDecodeStrict(targetType, buffer);
            if (!decoded) {
                continue;
            }
            return {
                $type: stripLeadingDot(targetType.fullName),
                $length: buffer.length,
                $auto: true,
                value: this.expandMessage(targetType, decoded, rules, context, warnings, maxRawHexBytes, depth + 1)
            };
        }
        if (context.protoPath && !byProtoPath) {
            warnings.push(
                `${ownerType}.${fieldName}: 未找到 proto_path "${context.protoPath}" 对应的消息类型，请导入设备对应的业务 proto 后重新编译；已保留原始字节`
            );
        }
        return toHex(buffer, maxRawHexBytes);
    }

    /**
     * 严格解码：任何解析异常、或解出来没有任何已知字段，都视为不匹配。
     */
    tryDecodeStrict(type, buffer) {
        try {
            const message = type.decode(buffer);
            const hasKnownField = type.fieldsArray.some(field => {
                const value = message[field.name];
                if (value === undefined || value === null) {
                    return false;
                }
                if (Array.isArray(value)) {
                    return value.length > 0;
                }
                if (typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
                    return Object.keys(value).length > 0 || value instanceof protobuf.Message;
                }
                return true;
            });
            return hasKnownField ? message : null;
        } catch (_error) {
            return null;
        }
    }

    expandJsonText(text, ownerType, fieldName, warnings) {
        const trimmed = String(text || '').trim();
        if (!trimmed) {
            return text;
        }
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            warnings.push(`${ownerType}.${fieldName}: JSON 解析失败 (${error.message})，已保留原始文本`);
            return text;
        }
    }

    /**
     * 按 Telemetry proto_path（如 huawei_ifm.Ifm.interfaces.interface）定位行内容的消息类型：
     * 先找最长可解析的消息类型前缀，再沿字段名逐级下钻到目标字段的消息类型。
     */
    resolveTypeByProtoPath(protoPath) {
        const segments = normalizeProtoPath(protoPath);
        if (segments.length === 0 || !this.root) {
            return null;
        }

        for (let prefixLength = segments.length; prefixLength >= 1; prefixLength -= 1) {
            const candidate = this.tryLookupType(segments.slice(0, prefixLength).join('.'));
            if (!candidate) {
                continue;
            }
            let current = candidate;
            let matched = true;
            for (const fieldName of segments.slice(prefixLength)) {
                const field = current.fields[fieldName] || current.fields[fieldName.toLowerCase()];
                if (!field) {
                    matched = false;
                    break;
                }
                field.resolve();
                if (!(field.resolvedType instanceof protobuf.Type)) {
                    matched = false;
                    break;
                }
                current = field.resolvedType;
            }
            if (matched) {
                return current;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    // 模板
    // ------------------------------------------------------------------

    /**
     * 根据消息定义生成示例 JSON，供客户端请求或服务端回复模板使用。
     */
    createTemplate(typeOrName) {
        const type = typeof typeOrName === 'string' ? this.lookupType(typeOrName) : typeOrName;
        return this.buildTemplate(type, [], 0);
    }

    buildTemplate(type, stack, depth) {
        const template = {};
        if (depth >= MAX_TEMPLATE_DEPTH || stack.includes(type)) {
            return template;
        }
        const nextStack = [...stack, type];
        const seenOneofs = new Set();

        for (const field of type.fieldsArray.slice().sort((a, b) => a.id - b.id)) {
            if (field.partOf) {
                if (seenOneofs.has(field.partOf.name)) {
                    continue;
                }
                seenOneofs.add(field.partOf.name);
            }
            field.resolve();
            const scalar = this.scalarTemplate(field, nextStack, depth);
            if (field.map) {
                template[field.name] = {};
            } else if (field.repeated) {
                template[field.name] = [scalar];
            } else {
                template[field.name] = scalar;
            }
        }
        return template;
    }

    scalarTemplate(field, stack, depth) {
        if (field.resolvedType instanceof protobuf.Type) {
            return this.buildTemplate(field.resolvedType, stack, depth + 1);
        }
        if (field.resolvedType instanceof protobuf.Enum) {
            const names = Object.keys(field.resolvedType.values);
            return names.length > 0 ? names[0] : 0;
        }
        switch (field.type) {
            case 'string':
                return '';
            case 'bool':
                return false;
            case 'bytes':
                return '';
            case 'int64':
            case 'uint64':
            case 'sint64':
            case 'fixed64':
            case 'sfixed64':
                return '0';
            default:
                return 0;
        }
    }
}

module.exports = {
    ProtoRegistry,
    ProtoCompileError,
    PROTO_CACHE_SCHEMA_VERSION,
    getMethodKind,
    toHex,
    stripLeadingDot,
    normalizeProtoPath,
    normalizePathList
};
