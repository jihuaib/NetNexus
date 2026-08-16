const fs = require('node:fs');
const path = require('node:path');
const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const SnmpConst = require('../../const/snmpConst');
const MibRegistry = require('../../utils/mibRegistry');

const MAX_MIB_SOURCE_PREVIEW_BYTES = 16 * 1024 * 1024;

class MibWorker {
    constructor() {
        this.mibRegistry = new MibRegistry();
        this.messageHandler = new WorkerMessageHandler();
        this.messageHandler.init();
        this.messageHandler.registerHandler(SnmpConst.MIB_REQ_TYPES.COMPILE_MIBS, this.compileMibs.bind(this));
        this.messageHandler.registerHandler(SnmpConst.MIB_REQ_TYPES.GET_MIB_STATUS, this.getMibStatus.bind(this));
        this.messageHandler.registerHandler(
            SnmpConst.MIB_REQ_TYPES.GET_MIB_TREE_CHILDREN,
            this.getMibTreeChildren.bind(this)
        );
        this.messageHandler.registerHandler(SnmpConst.MIB_REQ_TYPES.CLEAR_MIBS, this.clearMibs.bind(this));
        this.messageHandler.registerHandler(SnmpConst.MIB_REQ_TYPES.TRANSLATE_OID, this.translateOid.bind(this));
        this.messageHandler.registerHandler(SnmpConst.MIB_REQ_TYPES.GET_MIB_SOURCE, this.getMibSource.bind(this));
        this.messageHandler.registerHandler(SnmpConst.MIB_REQ_TYPES.SAVE_MIB_PROJECT, this.saveMibProject.bind(this));
        this.messageHandler.registerHandler(SnmpConst.MIB_REQ_TYPES.LIST_MIB_PROJECTS, this.listMibProjects.bind(this));
        this.messageHandler.registerHandler(
            SnmpConst.MIB_REQ_TYPES.IMPORT_MIB_PROJECT,
            this.importMibProject.bind(this)
        );
    }

    normalizeRequest(data = {}) {
        if (Array.isArray(data)) {
            return {
                filePaths: data,
                cacheFilePath: '',
                force: false
            };
        }

        return {
            filePaths: data.filePaths || data.requestedFiles || [],
            cacheFilePath: data.cacheFilePath || '',
            force: Boolean(data.force),
            progressId: typeof data.progressId === 'string' ? data.progressId : ''
        };
    }

    createProgressCallback(progressId) {
        if (!progressId) {
            return undefined;
        }

        let lastSentAt = 0;
        let lastSentPhase = '';
        let pendingProgress = null;
        const sendProgress = progress => {
            lastSentAt = Date.now();
            lastSentPhase = progress.phase;
            this.messageHandler.sendEvent(SnmpConst.MIB_EVT_TYPES.COMPILE_PROGRESS, {
                progressId,
                ...progress
            });
        };

        return progress => {
            const forceSend =
                ['preparing', 'serializing', 'indexing', 'caching', 'completed', 'failed'].includes(progress.phase) ||
                progress.fileStatus === 'failed' ||
                progress.phase !== lastSentPhase;
            const now = Date.now();

            if (forceSend) {
                if (pendingProgress) {
                    sendProgress(pendingProgress);
                    pendingProgress = null;
                }
                sendProgress(progress);
                return;
            }

            if (now - lastSentAt >= 80) {
                pendingProgress = null;
                sendProgress(progress);
                return;
            }

            pendingProgress = progress;
        };
    }

    compileIfNeeded(data = {}) {
        const request = this.normalizeRequest(data);
        return this.mibRegistry.loadOrCompileMibFiles(request.filePaths, {
            cacheFilePath: request.cacheFilePath,
            force: request.force,
            onProgress: this.createProgressCallback(request.progressId)
        });
    }

    compileMibs(messageId, data = {}) {
        try {
            const request = this.normalizeRequest(data);
            const summary = this.mibRegistry.loadOrCompileMibFiles(request.filePaths, {
                cacheFilePath: request.cacheFilePath,
                force: request.force,
                onProgress: this.createProgressCallback(request.progressId)
            });
            this.messageHandler.sendSuccessResponse(messageId, summary, 'MIB编译完成');
        } catch (error) {
            logger.error('MIB后台编译失败:', error);
            this.messageHandler.sendErrorResponse(messageId, 'MIB编译失败: ' + error.message);
        }
    }

    getMibStatus(messageId, data = {}) {
        try {
            const summary = this.compileIfNeeded(data);
            this.messageHandler.sendSuccessResponse(messageId, summary, '获取MIB状态成功');
        } catch (error) {
            logger.error('获取MIB状态失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '获取MIB状态失败: ' + error.message);
        }
    }

    getMibTreeChildren(messageId, data = {}) {
        try {
            this.compileIfNeeded(data);
            const parentOid = typeof data.parentOid === 'string' ? data.parentOid : '';
            this.messageHandler.sendSuccessResponse(
                messageId,
                this.mibRegistry.getOidTreeChildren(parentOid),
                '获取MIB树节点成功'
            );
        } catch (error) {
            logger.error('获取MIB树节点失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '获取MIB树节点失败: ' + error.message);
        }
    }

    clearMibs(messageId, data = {}) {
        try {
            const request = this.normalizeRequest(data);
            this.mibRegistry.reset();
            this.mibRegistry.clearCache(request.cacheFilePath);
            this.messageHandler.sendSuccessResponse(messageId, this.mibRegistry.getSummary(), 'MIB配置已清空');
        } catch (error) {
            logger.error('清空MIB配置失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '清空MIB配置失败: ' + error.message);
        }
    }

    translateOid(messageId, data = {}) {
        try {
            this.compileIfNeeded(data);
            this.messageHandler.sendSuccessResponse(messageId, this.mibRegistry.translateOid(data.oid), 'OID解析成功');
        } catch (error) {
            logger.error('OID解析失败:', error);
            this.messageHandler.sendErrorResponse(messageId, 'OID解析失败: ' + error.message);
        }
    }

    async getMibSource(messageId, data = {}) {
        try {
            const filePath = await this.resolveAllowedMibSourcePath(data.filePath, data.requestedFiles);
            const stat = await fs.promises.stat(filePath);
            const maxBytes = Math.max(1, Number(data.maxBytes) || MAX_MIB_SOURCE_PREVIEW_BYTES);
            if (stat.size > maxBytes) {
                throw new Error('MIB源码文件超过16MB，无法在界面中预览');
            }
            this.messageHandler.sendSuccessResponse(
                messageId,
                {
                    filePath,
                    fileName: path.basename(filePath),
                    source: await fs.promises.readFile(filePath, 'utf8')
                },
                '获取MIB源码成功'
            );
        } catch (error) {
            logger.error('获取MIB源码失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '获取MIB源码失败: ' + error.message);
        }
    }

    saveMibProject(messageId, data = {}) {
        let projectDir = '';
        let createdProjectDir = false;
        try {
            const sourcePaths = this.normalizeFilePaths(data.requestedFiles);
            if (sourcePaths.length === 0) {
                throw new Error('请先导入并编译MIB文件');
            }
            const projectName = this.normalizeMibProjectName(data.name);
            if (!projectName) {
                throw new Error('请输入工程名');
            }
            const projectRootDir = this.requireDirectoryPath(data.projectRootDir, '缺少MIB工程目录');
            const cacheFilePath = this.requireFilePath(data.cacheFilePath, '缺少MIB缓存路径');
            fs.mkdirSync(projectRootDir, { recursive: true });
            projectDir = path.join(projectRootDir, projectName);
            if (fs.existsSync(projectDir)) {
                throw new Error('工程名已存在，请换一个名称');
            }
            fs.mkdirSync(projectDir);
            createdProjectDir = true;

            const summary = this.mibRegistry.loadOrCompileMibFiles(sourcePaths, { cacheFilePath });
            const sourceCache = this.readJsonFile(cacheFilePath);
            if (!sourceCache?.snapshot) {
                throw new Error('当前MIB编译缓存不可用');
            }

            const mibsDir = path.join(projectDir, 'mibs');
            fs.mkdirSync(mibsDir, { recursive: true });
            const copyResult = this.copyMibProjectSources(sourcePaths, mibsDir);
            if (copyResult.requestedFiles.length === 0 || copyResult.copiedFileCount === 0) {
                throw new Error('没有可保存的MIB源文件');
            }

            const now = new Date().toISOString();
            const projectCache = this.buildProjectMibCache(sourceCache, copyResult, now);
            fs.writeFileSync(path.join(projectDir, 'mib-cache.json'), JSON.stringify(projectCache), 'utf8');
            const manifest = {
                version: 1,
                name: projectName,
                createdAt: now,
                updatedAt: now,
                sourceRoots: sourcePaths,
                requestedFiles: copyResult.requestedFiles,
                cacheFile: 'mib-cache.json',
                fileCount: copyResult.copiedFileCount,
                modules: Array.isArray(summary.modules) ? summary.modules : [],
                totalObjects: Number(summary.totalObjects) || 0
            };
            fs.writeFileSync(path.join(projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
            this.messageHandler.sendSuccessResponse(
                messageId,
                { project: { ...manifest, directory: projectDir }, summary },
                'MIB工程保存成功'
            );
        } catch (error) {
            if (createdProjectDir && projectDir) {
                try {
                    fs.rmSync(projectDir, { recursive: true, force: true });
                } catch (cleanupError) {
                    logger.warn('清理失败的MIB工程目录失败:', cleanupError.message);
                }
            }
            logger.error('保存MIB工程失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '保存MIB工程失败: ' + error.message);
        }
    }

    listMibProjects(messageId, data = {}) {
        try {
            const projectRootDir = this.requireDirectoryPath(data.projectRootDir, '缺少MIB工程目录');
            if (!fs.existsSync(projectRootDir)) {
                this.messageHandler.sendSuccessResponse(
                    messageId,
                    { rootDir: projectRootDir, projects: [] },
                    '暂无MIB工程'
                );
                return;
            }
            const projects = fs
                .readdirSync(projectRootDir, { withFileTypes: true })
                .filter(entry => entry.isDirectory())
                .map(entry => {
                    const projectDir = path.join(projectRootDir, entry.name);
                    try {
                        return this.formatMibProjectRecord(this.readMibProjectManifest(projectDir), projectDir);
                    } catch (error) {
                        logger.warn(`忽略无效MIB工程 ${projectDir}: ${error.message}`);
                        return null;
                    }
                })
                .filter(Boolean)
                .sort((left, right) => {
                    const leftTime = Date.parse(left.updatedAt || left.createdAt || '') || 0;
                    const rightTime = Date.parse(right.updatedAt || right.createdAt || '') || 0;
                    return rightTime - leftTime;
                });
            this.messageHandler.sendSuccessResponse(
                messageId,
                { rootDir: projectRootDir, projects },
                'MIB工程列表获取成功'
            );
        } catch (error) {
            logger.error('获取MIB工程列表失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '获取MIB工程列表失败: ' + error.message);
        }
    }

    importMibProject(messageId, data = {}) {
        try {
            const projectName = this.normalizeMibProjectName(data.name || data.projectName);
            if (!projectName) {
                throw new Error('请选择要导入的工程');
            }
            const projectRootDir = this.requireDirectoryPath(data.projectRootDir, '缺少MIB工程目录');
            const cacheFilePath = this.requireFilePath(data.cacheFilePath, '缺少MIB缓存路径');
            const projectDir = path.join(projectRootDir, projectName);
            const manifest = this.readMibProjectManifest(projectDir);
            const requestedFiles = this.normalizeFilePaths(manifest.requestedFiles).filter(filePath =>
                fs.existsSync(filePath)
            );
            if (requestedFiles.length === 0) {
                throw new Error('工程内没有可用的MIB源文件');
            }
            const projectCachePath = path.join(projectDir, manifest.cacheFile || 'mib-cache.json');
            if (!fs.existsSync(projectCachePath)) {
                throw new Error('工程编译缓存不存在');
            }
            fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
            fs.copyFileSync(projectCachePath, cacheFilePath);
            const summary = this.mibRegistry.loadOrCompileMibFiles(requestedFiles, { cacheFilePath });
            if (!summary.cacheHit && fs.existsSync(cacheFilePath)) {
                fs.copyFileSync(cacheFilePath, projectCachePath);
            }
            this.messageHandler.sendSuccessResponse(
                messageId,
                {
                    project: this.formatMibProjectRecord(manifest, projectDir),
                    summary,
                    requestedFiles
                },
                'MIB工程导入成功'
            );
        } catch (error) {
            logger.error('导入MIB工程失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '导入MIB工程失败: ' + error.message);
        }
    }

    requireDirectoryPath(value, message) {
        const resolved = typeof value === 'string' && value.trim() ? path.resolve(value) : '';
        if (!resolved) throw new Error(message);
        return resolved;
    }

    requireFilePath(value, message) {
        const resolved = typeof value === 'string' && value.trim() ? path.resolve(value) : '';
        if (!resolved) throw new Error(message);
        return resolved;
    }

    normalizeMibProjectName(name = '') {
        return String(name || '')
            .trim()
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/^\.+/, '')
            .slice(0, 80);
    }

    sanitizePathName(name = '') {
        const safeName = String(name || 'mib')
            .trim()
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/^\.+$/, '_');
        return safeName || 'mib';
    }

    readJsonFile(filePath) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    readMibProjectManifest(projectDir) {
        const manifestPath = path.join(projectDir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) throw new Error('工程清单不存在');
        const manifest = this.readJsonFile(manifestPath);
        if (!manifest || manifest.version !== 1 || !manifest.name) throw new Error('工程清单格式无效');
        return manifest;
    }

    formatMibProjectRecord(manifest, projectDir) {
        return {
            name: manifest.name,
            projectName: manifest.name,
            directory: projectDir,
            createdAt: manifest.createdAt || '',
            updatedAt: manifest.updatedAt || manifest.createdAt || '',
            fileCount: Number(manifest.fileCount) || 0,
            moduleCount: Array.isArray(manifest.modules) ? manifest.modules.length : 0,
            modules: Array.isArray(manifest.modules) ? manifest.modules : [],
            totalObjects: Number(manifest.totalObjects) || 0
        };
    }

    copyMibProjectSources(sourcePaths, mibsDir) {
        const requestedFiles = [];
        const filePathMap = new Map();
        const usedRootNames = new Set();
        let copiedFileCount = 0;
        sourcePaths.forEach(sourcePath => {
            const stat = fs.statSync(sourcePath);
            const targetName = this.getUniqueTargetName(mibsDir, path.basename(sourcePath), usedRootNames);
            const targetPath = path.join(mibsDir, targetName);
            if (stat.isFile()) {
                if (!this.isMibCandidateFile(sourcePath)) return;
                fs.copyFileSync(sourcePath, targetPath);
                requestedFiles.push(targetPath);
                filePathMap.set(sourcePath, targetPath);
                copiedFileCount++;
                return;
            }
            if (!stat.isDirectory()) throw new Error(`不是文件或目录: ${sourcePath}`);
            fs.mkdirSync(targetPath, { recursive: true });
            const directoryFileCount = this.copyMibDirectoryFiles(sourcePath, targetPath, filePathMap);
            if (directoryFileCount > 0) {
                requestedFiles.push(targetPath);
                copiedFileCount += directoryFileCount;
            } else {
                fs.rmSync(targetPath, { recursive: true, force: true });
            }
        });
        return { requestedFiles: this.normalizeFilePaths(requestedFiles), filePathMap, copiedFileCount };
    }

    copyMibDirectoryFiles(sourceDir, targetDir, filePathMap) {
        let copiedFileCount = 0;
        const usedNames = new Set();
        fs.readdirSync(sourceDir, { withFileTypes: true }).forEach(entry => {
            if (entry.name.startsWith('.')) return;
            const sourcePath = path.join(sourceDir, entry.name);
            const targetPath = path.join(targetDir, this.getUniqueTargetName(targetDir, entry.name, usedNames));
            if (entry.isDirectory()) {
                fs.mkdirSync(targetPath, { recursive: true });
                const count = this.copyMibDirectoryFiles(sourcePath, targetPath, filePathMap);
                if (count === 0) fs.rmSync(targetPath, { recursive: true, force: true });
                copiedFileCount += count;
                return;
            }
            if (!entry.isFile() || !this.isMibCandidateFile(sourcePath)) return;
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.copyFileSync(sourcePath, targetPath);
            filePathMap.set(sourcePath, targetPath);
            copiedFileCount++;
        });
        return copiedFileCount;
    }

    getUniqueTargetName(parentDir, rawName, usedNames) {
        const safeName = this.sanitizePathName(rawName);
        const parsed = path.parse(safeName);
        let candidate = safeName;
        let counter = 2;
        while (usedNames.has(candidate.toLowerCase()) || fs.existsSync(path.join(parentDir, candidate))) {
            candidate = `${parsed.name}_${counter}${parsed.ext}`;
            counter++;
        }
        usedNames.add(candidate.toLowerCase());
        return candidate;
    }

    buildProjectMibCache(sourceCache, copyResult, createdAt) {
        const snapshot = sourceCache.snapshot || {};
        const requestedFiles = copyResult.requestedFiles;
        return {
            version: sourceCache.version || 1,
            createdAt,
            requestedFiles,
            fileSignatures: this.getMibFileSignatures(this.expandMibInputPaths(requestedFiles)),
            snapshot: {
                ...snapshot,
                requestedFiles,
                loadedFiles: this.remapMibFilePaths(snapshot.loadedFiles || [], copyResult.filePathMap),
                failedFiles: this.remapMibFailedFiles(snapshot.failedFiles || [], copyResult.filePathMap)
            }
        };
    }

    remapMibFilePaths(filePaths, filePathMap) {
        return this.normalizeFilePaths(filePaths.map(filePath => filePathMap.get(filePath) || filePath)).filter(filePath =>
            fs.existsSync(filePath)
        );
    }

    remapMibFailedFiles(failedFiles, filePathMap) {
        return (Array.isArray(failedFiles) ? failedFiles : []).map(file => {
            const sourcePath = typeof file === 'string' ? file : file.filePath;
            const filePath = sourcePath ? filePathMap.get(sourcePath) || sourcePath : '';
            return {
                ...(typeof file === 'object' && file ? file : {}),
                filePath,
                fileName: filePath ? path.basename(filePath) : ''
            };
        });
    }

    expandMibInputPaths(inputPaths = []) {
        const files = [];
        const seen = new Set();
        const addFile = filePath => {
            if (seen.has(filePath) || !this.isMibCandidateFile(filePath)) return;
            seen.add(filePath);
            files.push(filePath);
        };
        const visit = inputPath => {
            if (!inputPath || !fs.existsSync(inputPath)) return;
            const stat = fs.statSync(inputPath);
            if (stat.isFile()) addFile(inputPath);
            else if (stat.isDirectory()) this.walkMibDirectory(inputPath, addFile);
        };
        this.normalizeFilePaths(inputPaths).forEach(visit);
        return files;
    }

    walkMibDirectory(directoryPath, addFile) {
        fs.readdirSync(directoryPath, { withFileTypes: true }).forEach(entry => {
            if (entry.name.startsWith('.')) return;
            const entryPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) this.walkMibDirectory(entryPath, addFile);
            else if (entry.isFile()) addFile(entryPath);
        });
    }

    getMibFileSignatures(filePaths = []) {
        return filePaths
            .map(filePath => {
                try {
                    const stat = fs.statSync(filePath);
                    return { filePath, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
                } catch (_error) {
                    return null;
                }
            })
            .filter(Boolean);
    }

    normalizeFilePaths(filePaths) {
        if (!Array.isArray(filePaths)) return [];
        return Array.from(
            new Set(filePaths.filter(filePath => typeof filePath === 'string').map(filePath => filePath.trim()).filter(Boolean))
        );
    }

    isMibCandidateFile(filePath) {
        return ['.mib', '.txt', '.my', ''].includes(path.extname(filePath).toLowerCase());
    }

    isPathInsideDirectory(directoryPath, filePath) {
        const relativePath = path.relative(directoryPath, filePath);
        return (
            relativePath === '' ||
            (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
        );
    }

    async resolveAllowedMibSourcePath(filePath, requestedFiles) {
        const requestedPath = typeof filePath === 'string' ? filePath.trim() : '';
        if (!requestedPath) throw new Error('缺少MIB文件路径');
        const resolvedPath = path.resolve(requestedPath);
        if (!this.isMibCandidateFile(resolvedPath)) throw new Error('该文件不是支持的MIB源码类型');
        let sourceStat;
        let sourceRealPath;
        try {
            sourceStat = await fs.promises.stat(resolvedPath);
            sourceRealPath = await fs.promises.realpath(resolvedPath);
        } catch (_error) {
            throw new Error('MIB源码文件不存在或无法读取');
        }
        if (!sourceStat.isFile()) throw new Error('MIB源码路径不是普通文件');
        for (const storedPath of this.normalizeFilePaths(requestedFiles)) {
            try {
                const storedStat = await fs.promises.stat(storedPath);
                const storedRealPath = await fs.promises.realpath(storedPath);
                if (storedStat.isFile() && storedRealPath === sourceRealPath) return sourceRealPath;
                if (storedStat.isDirectory() && this.isPathInsideDirectory(storedRealPath, sourceRealPath)) {
                    return sourceRealPath;
                }
            } catch (_error) {
                // Ignore stale entries and continue checking the remaining workspace roots.
            }
        }
        throw new Error('当前MIB编译工作区中不存在该文件');
    }
}

new MibWorker();
