const fs = require('fs');
const path = require('path');
const logger = require('../../log/logger');
const { normalizePathList } = require('./protoRegistry');

const PROJECT_MANIFEST_VERSION = 1;
const PROJECT_MANIFEST_FILE = 'manifest.json';
const PROJECT_CACHE_FILE = 'proto-cache.json';
const PROJECT_PROTO_DIR = 'protos';

function normalizeProjectName(name = '') {
    return String(name || '')
        .trim()
        .replace(/[\\/:*?"<>|]/gu, '_')
        .replace(/\s+/gu, ' ')
        .replace(/^\.+/u, '')
        .slice(0, 80);
}

function requireDirectory(value, message) {
    const dir = String(value || '').trim();
    if (!dir) {
        throw new Error(message);
    }
    return path.resolve(dir);
}

function isSafeRelative(relative) {
    return (
        Boolean(relative) &&
        !path.isAbsolute(relative) &&
        !relative.split(/[\\/]/u).some(segment => segment === '..' || segment === '')
    );
}

/**
 * 被 import 的文件按 proto 里的 import 字符串放置（如 common/types.proto），
 * 顶层文件按文件名放置；这样工程内只需一个搜索目录即可解析全部 import。
 */
function copyProjectFile(sourcePath, importTarget, targetDir, usedNames) {
    const relative = isSafeRelative(importTarget) ? importTarget : path.basename(sourcePath);
    let target = path.join(targetDir, relative);
    let suffix = 1;
    while (usedNames.has(target)) {
        const parsed = path.parse(target);
        target = path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
        suffix += 1;
    }
    usedNames.add(target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(sourcePath, target);
    return target;
}

/**
 * proto 工程：把当前编译用到的 .proto 源文件、编译缓存和清单保存到工程目录，
 * 之后可以从工程恢复（导入）或复制到任意目录（导出）。所有用到的源文件
 * （含内置模板）都会复制进工程，工程目录自包含。
 */
class ProtoProjectStore {
    constructor(registry) {
        this.registry = registry;
    }

    projectDirOf(rootDir, name) {
        return path.join(requireDirectory(rootDir, '缺少 proto 工程目录'), name);
    }

    readManifest(projectDir) {
        const manifestPath = path.join(projectDir, PROJECT_MANIFEST_FILE);
        if (!fs.existsSync(manifestPath)) {
            throw new Error('工程清单不存在');
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!manifest || manifest.version !== PROJECT_MANIFEST_VERSION) {
            throw new Error('工程清单版本不支持');
        }
        return manifest;
    }

    formatRecord(manifest, projectDir) {
        return {
            name: manifest.name,
            directory: projectDir,
            createdAt: manifest.createdAt,
            updatedAt: manifest.updatedAt,
            fileCount: Number(manifest.fileCount) || 0,
            services: Array.isArray(manifest.services) ? manifest.services : [],
            summary: manifest.summary || null
        };
    }

    save({ name, rootDir, cacheFilePath }) {
        if (!this.registry.isCompiled()) {
            throw new Error('请先导入并编译 proto 文件');
        }
        const projectName = normalizeProjectName(name);
        if (!projectName) {
            throw new Error('请输入工程名');
        }
        const root = requireDirectory(rootDir, '缺少 proto 工程目录');
        fs.mkdirSync(root, { recursive: true });
        const projectDir = path.join(root, projectName);
        if (fs.existsSync(projectDir)) {
            throw new Error('工程名已存在，请换一个名称');
        }

        fs.mkdirSync(projectDir);
        try {
            const catalog = this.registry.getCatalog();
            const loadedFiles = catalog.files.map(item => item.path);
            const userFiles = loadedFiles;
            const protoDir = path.join(projectDir, PROJECT_PROTO_DIR);
            fs.mkdirSync(protoDir, { recursive: true });

            const usedNames = new Set();
            const fileMap = new Map();
            userFiles.forEach(file => {
                fileMap.set(file, copyProjectFile(file, this.registry.importTargets.get(file), protoDir, usedNames));
            });

            const requestedFiles = this.registry.compiledFiles.map(file =>
                path.relative(projectDir, fileMap.get(file) || file)
            );
            const includeDirs = [PROJECT_PROTO_DIR];

            const now = new Date().toISOString();
            const manifest = {
                version: PROJECT_MANIFEST_VERSION,
                name: projectName,
                createdAt: now,
                updatedAt: now,
                requestedFiles,
                includeDirs,
                originalRequestedFiles: [...this.registry.compiledFiles],
                originalIncludeDirs: [...this.registry.includeDirs],
                fileCount: userFiles.length,
                services: catalog.services.map(service => service.fullName),
                summary: catalog.summary,
                cacheFile: PROJECT_CACHE_FILE
            };
            fs.writeFileSync(path.join(projectDir, PROJECT_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');

            // 工程内缓存按工程内路径重新编译生成，保证导入时签名可命中
            const projectRegistry = new this.registry.constructor({ builtinDir: this.registry.builtinDir });
            const resolved = this.resolveManifestPaths(manifest, projectDir);
            projectRegistry.loadOrCompile({
                filePaths: resolved.filePaths,
                includeDirs: resolved.includeDirs,
                cacheFilePath: path.join(projectDir, PROJECT_CACHE_FILE),
                force: true
            });
            if (cacheFilePath && fs.existsSync(cacheFilePath)) {
                // 当前缓存保持不变；工程缓存独立维护
            }
            return { project: this.formatRecord(manifest, projectDir), manifest };
        } catch (error) {
            try {
                fs.rmSync(projectDir, { recursive: true, force: true });
            } catch (cleanupError) {
                logger.warn('清理失败的 proto 工程目录失败:', cleanupError.message);
            }
            throw error;
        }
    }

    resolveManifestPaths(manifest, projectDir) {
        const filePaths = (Array.isArray(manifest.requestedFiles) ? manifest.requestedFiles : [])
            .map(entry => path.resolve(projectDir, String(entry || '')))
            .filter(Boolean);
        const includeDirs = (Array.isArray(manifest.includeDirs) ? manifest.includeDirs : []).map(dir =>
            path.resolve(projectDir, String(dir || ''))
        );
        return { filePaths: normalizePathList(filePaths), includeDirs: normalizePathList(includeDirs) };
    }

    list({ rootDir }) {
        const root = requireDirectory(rootDir, '缺少 proto 工程目录');
        if (!fs.existsSync(root)) {
            return { rootDir: root, projects: [] };
        }
        const projects = fs
            .readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => {
                const projectDir = path.join(root, entry.name);
                try {
                    return this.formatRecord(this.readManifest(projectDir), projectDir);
                } catch (error) {
                    logger.warn(`忽略无效 proto 工程 ${projectDir}: ${error.message}`);
                    return null;
                }
            })
            .filter(Boolean)
            .sort((left, right) => (Date.parse(right.updatedAt || '') || 0) - (Date.parse(left.updatedAt || '') || 0));
        return { rootDir: root, projects };
    }

    /**
     * 导入工程：name 为工程目录名，或 directory 为任意位置的工程目录（会先复制到工程根目录）。
     */
    import({ name, directory, rootDir, cacheFilePath }) {
        const root = requireDirectory(rootDir, '缺少 proto 工程目录');
        let projectDir = '';
        if (directory) {
            const external = requireDirectory(directory, '请选择工程目录');
            const manifest = this.readManifest(external);
            const targetName = normalizeProjectName(manifest.name || path.basename(external));
            projectDir = path.join(root, targetName);
            if (path.resolve(external) !== path.resolve(projectDir)) {
                if (fs.existsSync(projectDir)) {
                    throw new Error(`工程 ${targetName} 已存在，请先删除或改名`);
                }
                fs.mkdirSync(root, { recursive: true });
                fs.cpSync(external, projectDir, { recursive: true });
            }
        } else {
            const projectName = normalizeProjectName(name);
            if (!projectName) {
                throw new Error('请选择要导入的工程');
            }
            projectDir = path.join(root, projectName);
        }

        const manifest = this.readManifest(projectDir);
        const { filePaths, includeDirs } = this.resolveManifestPaths(manifest, projectDir);
        const missing = filePaths.filter(file => !fs.existsSync(file));
        if (filePaths.length === 0 || missing.length > 0) {
            throw new Error(`工程内缺少 proto 源文件: ${missing.map(file => path.basename(file)).join(', ') || '无'}`);
        }

        const projectCache = path.join(projectDir, manifest.cacheFile || PROJECT_CACHE_FILE);
        if (cacheFilePath) {
            fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
            if (fs.existsSync(projectCache)) {
                fs.copyFileSync(projectCache, cacheFilePath);
            }
        }
        this.registry.loadOrCompile({ filePaths, includeDirs, cacheFilePath });
        if (!this.registry.cacheHit && cacheFilePath && fs.existsSync(cacheFilePath)) {
            fs.copyFileSync(cacheFilePath, projectCache);
        }
        return {
            project: this.formatRecord(manifest, projectDir),
            filePaths,
            includeDirs
        };
    }

    /**
     * 导出工程：把工程目录复制到目标目录（targetDir/<name>）。
     */
    export({ name, rootDir, targetDir }) {
        const projectName = normalizeProjectName(name);
        if (!projectName) {
            throw new Error('请选择要导出的工程');
        }
        const projectDir = this.projectDirOf(rootDir, projectName);
        this.readManifest(projectDir);
        const target = path.join(requireDirectory(targetDir, '请选择导出目录'), projectName);
        if (fs.existsSync(target)) {
            throw new Error(`目标目录已存在: ${target}`);
        }
        fs.cpSync(projectDir, target, { recursive: true });
        return { directory: target };
    }

    remove({ name, rootDir }) {
        const projectName = normalizeProjectName(name);
        if (!projectName) {
            throw new Error('请选择要删除的工程');
        }
        const projectDir = this.projectDirOf(rootDir, projectName);
        this.readManifest(projectDir);
        fs.rmSync(projectDir, { recursive: true, force: true });
        return { name: projectName };
    }
}

module.exports = {
    ProtoProjectStore,
    normalizeProjectName,
    PROJECT_MANIFEST_FILE,
    PROJECT_CACHE_FILE,
    PROJECT_PROTO_DIR
};
