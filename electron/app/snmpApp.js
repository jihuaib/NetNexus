const fs = require('fs');
const path = require('path');
const snmp = require('net-snmp');
const { app, BrowserWindow, dialog } = require('electron');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const WorkerWithPromise = require('../worker/core/workerWithPromise');
const SnmpConst = require('../const/snmpConst');
const { LOG_REQ_TYPES } = require('../const/toolsConst');
const EventDispatcher = require('../utils/eventDispatcher');
class SnmpApp {
    constructor(ipcMain, store) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.snmpConfigFileKey = 'snmp-config';
        this.snmpMibFilesKey = 'snmp-mib-files';
        this.worker = null;
        this.mibWorker = null;

        this.snmpTrapEventHandler = null;
        this.eventDispatcher = null;

        this.logLevel = null;

        // 注册IPC处理程序
        this.registerIpcHandlers();
    }

    /**
     * 注册IPC处理程序
     */
    registerIpcHandlers() {
        this.ipcMain.handle('snmp:saveSnmpConfig', this.handleSaveSnmpConfig.bind(this));
        this.ipcMain.handle('snmp:getSnmpConfig', this.handleGetSnmpConfig.bind(this));
        this.ipcMain.handle('snmp:startSnmp', this.handleStartSnmp.bind(this));
        this.ipcMain.handle('snmp:stopSnmp', this.handleStopSnmp.bind(this));
        this.ipcMain.handle('snmp:getTrapList', this.handleGetTrapList.bind(this));
        this.ipcMain.handle('snmp:clearTrapHistory', this.handleClearTrapHistory.bind(this));
        this.ipcMain.handle('snmp:selectMibFiles', this.handleSelectMibFiles.bind(this));
        this.ipcMain.handle('snmp:selectMibDirectory', this.handleSelectMibDirectory.bind(this));
        this.ipcMain.handle('snmp:compileMibs', this.handleCompileMibs.bind(this));
        this.ipcMain.handle('snmp:getMibStatus', this.handleGetMibStatus.bind(this));
        this.ipcMain.handle('snmp:getMibTreeChildren', this.handleGetMibTreeChildren.bind(this));
        this.ipcMain.handle('snmp:saveMibProject', this.handleSaveMibProject.bind(this));
        this.ipcMain.handle('snmp:listMibProjects', this.handleListMibProjects.bind(this));
        this.ipcMain.handle('snmp:importMibProject', this.handleImportMibProject.bind(this));
        this.ipcMain.handle('snmp:clearMibs', this.handleClearMibs.bind(this));
        this.ipcMain.handle('snmp:translateOid', this.handleTranslateOid.bind(this));
        this.ipcMain.handle('snmp:sendGetRequest', this.handleSendGetRequest.bind(this));
        this.ipcMain.handle('snmp:sendGetNextRequest', this.handleSendGetNextRequest.bind(this));
        this.ipcMain.handle('snmp:sendWalkRequest', this.handleSendWalkRequest.bind(this));
        this.ipcMain.handle('snmp:sendSetRequest', this.handleSendSetRequest.bind(this));
        this.ipcMain.handle('snmp:listOidInstances', this.handleListOidInstances.bind(this));
    }

    normalizeSupportedVersions(versions) {
        const list = Array.isArray(versions) ? versions : [versions].filter(Boolean);
        if (list.includes('v2c')) {
            return ['v2c'];
        }
        if (list.includes('v1')) {
            return ['v1'];
        }
        if (list.includes('v3')) {
            return ['v3'];
        }
        return ['v2c'];
    }

    normalizeSnmpConfig(config = {}) {
        const restConfig = { ...config };
        delete restConfig.targetPort;
        delete restConfig.enableQueryMonitor;
        return {
            ...restConfig,
            supportedVersions: this.normalizeSupportedVersions(restConfig.supportedVersions)
        };
    }

    /**
     * 保存SNMP配置
     */
    async handleSaveSnmpConfig(_event, config) {
        try {
            const normalizedConfig = this.normalizeSnmpConfig(config);
            logger.info('handleSaveSnmpConfig', normalizedConfig);
            this.store.set(this.snmpConfigFileKey, normalizedConfig);
            return successResponse(null, '配置保存成功');
        } catch (error) {
            logger.error('保存SNMP配置失败:', error);
            return errorResponse('配置保存失败: ' + error.message);
        }
    }

    /**
     * 获取SNMP配置
     */
    async handleGetSnmpConfig() {
        try {
            const config = this.store.get(this.snmpConfigFileKey);
            if (!config) {
                return successResponse(null, '获取默认配置');
            }
            return successResponse(this.normalizeSnmpConfig(config), '配置获取成功');
        } catch (error) {
            logger.error('获取SNMP配置失败:', error);
            return errorResponse('配置获取失败: ' + error.message);
        }
    }

    /**
     * 启动SNMP服务器
     */
    async handleStartSnmp(event, config) {
        const webContents = event.sender;
        try {
            const runtimeConfig = this.normalizeSnmpConfig(config);
            if (this.worker !== null) {
                logger.error('SNMP协议已经启动');
                return errorResponse('SNMP协议已经启动');
            }

            logger.info(`启动SNMP服务器: ${JSON.stringify(runtimeConfig)}`);

            // 获取日志级别配置
            if (this.logLevel) {
                runtimeConfig.logLevel = this.logLevel;
            }
            runtimeConfig.mibFiles = this.getStoredMibFilePaths();
            runtimeConfig.mibCacheFilePath = this.getMibCacheFilePath();

            const workerPath = resolveWorkerPath('snmp/snmpWorker.js');

            const workerFactory = new WorkerWithPromise(workerPath);
            this.worker = workerFactory.createLongRunningWorker();

            this.eventDispatcher = new EventDispatcher();
            this.eventDispatcher.setWebContents(webContents);
            // 注册事件监听
            this.snmpTrapEventHandler = data => {
                this.eventDispatcher.emit('snmp:event', successResponse(data));
            };

            this.worker.addEventListener(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, this.snmpTrapEventHandler);

            const result = await this.worker.sendRequest(SnmpConst.SNMP_REQ_TYPES.START_SNMP, runtimeConfig);

            if (result.status === 'success') {
                logger.info(`SNMP服务器启动成功: ${JSON.stringify(result)}`);
                return successResponse(null, result.msg);
            }

            logger.error(`SNMP服务器启动失败: ${result.msg}`);
            await this.cleanupWorker();
            return errorResponse(result.msg);
        } catch (error) {
            logger.error('启动SNMP服务器失败:', error);
            await this.cleanupWorker();
            return errorResponse('启动SNMP服务器失败: ' + error.message);
        }
    }

    /**
     * 停止SNMP服务器
     */
    async handleStopSnmp() {
        try {
            if (this.worker === null) {
                logger.error('SNMP服务器未启动');
                return errorResponse('SNMP服务器未启动');
            }

            const result = await this.worker.sendRequest(SnmpConst.SNMP_REQ_TYPES.STOP_SNMP, null);
            logger.info(`SNMP服务器停止成功: ${JSON.stringify(result)}`);

            return successResponse(null, result.msg);
        } catch (error) {
            logger.error('停止SNMP服务器失败:', error);
            return errorResponse('停止SNMP服务器失败: ' + error.message);
        } finally {
            await this.cleanupWorker();
        }
    }

    /**
     * 获取Trap历史列表
     */
    async handleGetTrapList(_event, query = {}) {
        try {
            if (this.worker === null) {
                return successResponse(
                    {
                        list: [],
                        page: Number(query.page) || 1,
                        pageSize: Number(query.pageSize) || 20,
                        total: 0,
                        totalTraps: 0,
                        historyCount: 0,
                        todayTraps: 0,
                        recentTraps: 0,
                        onlineAgents: 0,
                        maxTrapHistory: SnmpConst.DEFAULT_SNMP_SETTINGS.maxTrapHistory
                    },
                    'SNMP服务器未启动'
                );
            }

            const result = await this.worker.sendRequest(SnmpConst.SNMP_REQ_TYPES.GET_TRAP_LIST, query);
            return successResponse(result.data || [], result.msg || '获取Trap列表成功');
        } catch (error) {
            logger.error('获取Trap列表失败:', error);
            return errorResponse('获取Trap列表失败: ' + error.message);
        }
    }

    /**
     * 清空Trap历史
     */
    async handleClearTrapHistory() {
        try {
            if (this.worker === null) {
                return successResponse(null, 'SNMP服务器未启动');
            }

            const result = await this.worker.sendRequest(SnmpConst.SNMP_REQ_TYPES.CLEAR_TRAP_HISTORY, null);
            return successResponse(null, result.msg || 'Trap历史已清空');
        } catch (error) {
            logger.error('清空Trap历史失败:', error);
            return errorResponse('清空Trap历史失败: ' + error.message);
        }
    }

    showMibOpenDialog(event) {
        const options = {
            title: '导入 MIB 文件',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: '所有支持的 MIB 文件', extensions: ['*'] },
                { name: '常见 MIB 后缀', extensions: ['mib', 'txt', 'my'] }
            ]
        };
        const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
        return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
    }

    async handleSelectMibFiles(event) {
        try {
            const result = await this.showMibOpenDialog(event);

            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return successResponse([], '已取消选择');
            }

            return successResponse(result.filePaths, 'MIB文件选择成功');
        } catch (error) {
            logger.error('选择MIB文件失败:', error);
            return errorResponse('选择MIB文件失败: ' + error.message);
        }
    }

    async handleSelectMibDirectory(event) {
        try {
            const options = {
                title: '导入 MIB 目录',
                properties: ['openDirectory']
            };
            const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
            const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);

            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return successResponse(null, '已取消选择');
            }

            return successResponse(result.filePaths[0], 'MIB目录选择成功');
        } catch (error) {
            logger.error('选择MIB目录失败:', error);
            return errorResponse('选择MIB目录失败: ' + error.message);
        }
    }

    async handleCompileMibs(_event, filePaths = []) {
        try {
            const selectedFiles = this.normalizeFilePaths(filePaths);
            const requestedFiles = selectedFiles.length > 0 ? selectedFiles : this.getStoredMibFilePaths();
            const result = await this.sendMibWorkerRequest(SnmpConst.MIB_REQ_TYPES.COMPILE_MIBS, {
                filePaths: requestedFiles,
                cacheFilePath: this.getMibCacheFilePath(),
                force: true
            });
            const summary = result.data;

            this.store.set(this.snmpMibFilesKey, requestedFiles);

            if (this.worker) {
                const workerResult = await this.worker.sendRequest(SnmpConst.SNMP_REQ_TYPES.COMPILE_MIBS, {
                    filePaths: requestedFiles,
                    cacheFilePath: this.getMibCacheFilePath()
                });
                summary.worker = workerResult.data;
            }

            return successResponse(summary, 'MIB编译完成');
        } catch (error) {
            logger.error('MIB编译失败:', error);
            return errorResponse('MIB编译失败: ' + error.message);
        }
    }

    async handleGetMibStatus() {
        try {
            const storedFiles = this.getStoredMibFilePaths();
            const result = await this.sendMibWorkerRequest(SnmpConst.MIB_REQ_TYPES.GET_MIB_STATUS, {
                requestedFiles: storedFiles,
                cacheFilePath: this.getMibCacheFilePath()
            });
            return successResponse(result.data, result.msg || '获取MIB状态成功');
        } catch (error) {
            logger.error('获取MIB状态失败:', error);
            return errorResponse('获取MIB状态失败: ' + error.message);
        }
    }

    async handleGetMibTreeChildren(_event, parentOid = '') {
        try {
            const storedFiles = this.getStoredMibFilePaths();
            const result = await this.sendMibWorkerRequest(SnmpConst.MIB_REQ_TYPES.GET_MIB_TREE_CHILDREN, {
                parentOid,
                requestedFiles: storedFiles,
                cacheFilePath: this.getMibCacheFilePath()
            });
            return successResponse(result.data, result.msg || '获取MIB树节点成功');
        } catch (error) {
            logger.error('获取MIB树节点失败:', error);
            return errorResponse('获取MIB树节点失败: ' + error.message);
        }
    }

    async handleSaveMibProject(_event, payload = {}) {
        let projectDir = '';
        let createdProjectDir = false;

        try {
            const sourcePaths = this.getStoredMibFilePaths();
            if (sourcePaths.length === 0) {
                return errorResponse('请先导入并编译MIB文件');
            }

            const projectName = this.normalizeMibProjectName(payload.name);
            if (!projectName) {
                return errorResponse('请输入工程名');
            }

            const projectRootDir = this.getMibProjectRootDir();
            fs.mkdirSync(projectRootDir, { recursive: true });
            projectDir = path.join(projectRootDir, projectName);
            if (fs.existsSync(projectDir)) {
                return errorResponse('工程名已存在，请换一个名称');
            }

            fs.mkdirSync(projectDir);
            createdProjectDir = true;

            const summary = await this.ensureCurrentMibCache(sourcePaths);
            const sourceCache = this.readJsonFile(this.getMibCacheFilePath());
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
            const projectCachePath = path.join(projectDir, 'mib-cache.json');
            const projectCache = this.buildProjectMibCache(sourceCache, copyResult, now);
            fs.writeFileSync(projectCachePath, JSON.stringify(projectCache), 'utf8');

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

            return successResponse(
                {
                    project: {
                        ...manifest,
                        directory: projectDir
                    },
                    summary
                },
                'MIB工程保存成功'
            );
        } catch (error) {
            logger.error('保存MIB工程失败:', error);
            if (createdProjectDir && projectDir) {
                try {
                    fs.rmSync(projectDir, { recursive: true, force: true });
                } catch (cleanupError) {
                    logger.warn('清理失败的MIB工程目录失败:', cleanupError.message);
                }
            }
            return errorResponse('保存MIB工程失败: ' + error.message);
        }
    }

    async handleListMibProjects() {
        try {
            const rootDir = this.getMibProjectRootDir();
            if (!fs.existsSync(rootDir)) {
                return successResponse({ rootDir, projects: [] }, '暂无MIB工程');
            }

            const projects = fs
                .readdirSync(rootDir, { withFileTypes: true })
                .filter(entry => entry.isDirectory())
                .map(entry => {
                    const projectDir = path.join(rootDir, entry.name);
                    try {
                        const manifest = this.readMibProjectManifest(projectDir);
                        return this.formatMibProjectRecord(manifest, projectDir);
                    } catch (error) {
                        logger.warn(`忽略无效MIB工程 ${projectDir}:`, error.message);
                        return null;
                    }
                })
                .filter(Boolean)
                .sort((left, right) => {
                    const leftTime = Date.parse(left.updatedAt || left.createdAt || '') || 0;
                    const rightTime = Date.parse(right.updatedAt || right.createdAt || '') || 0;
                    return rightTime - leftTime;
                });

            return successResponse({ rootDir, projects }, 'MIB工程列表获取成功');
        } catch (error) {
            logger.error('获取MIB工程列表失败:', error);
            return errorResponse('获取MIB工程列表失败: ' + error.message);
        }
    }

    async handleImportMibProject(_event, payload = {}) {
        try {
            const projectName = this.normalizeMibProjectName(payload.name || payload.projectName);
            if (!projectName) {
                return errorResponse('请选择要导入的工程');
            }

            const projectDir = path.join(this.getMibProjectRootDir(), projectName);
            const manifest = this.readMibProjectManifest(projectDir);
            const requestedFiles = this.normalizeFilePaths(manifest.requestedFiles).filter(filePath =>
                fs.existsSync(filePath)
            );
            if (requestedFiles.length === 0) {
                return errorResponse('工程内没有可用的MIB源文件');
            }

            const projectCachePath = path.join(projectDir, manifest.cacheFile || 'mib-cache.json');
            if (!fs.existsSync(projectCachePath)) {
                return errorResponse('工程编译缓存不存在');
            }

            const globalCachePath = this.getMibCacheFilePath();
            fs.mkdirSync(path.dirname(globalCachePath), { recursive: true });
            fs.copyFileSync(projectCachePath, globalCachePath);
            this.store.set(this.snmpMibFilesKey, requestedFiles);

            const result = await this.sendMibWorkerRequest(SnmpConst.MIB_REQ_TYPES.GET_MIB_STATUS, {
                requestedFiles,
                cacheFilePath: globalCachePath
            });
            if (result.status !== 'success') {
                throw new Error(result.msg || '工程MIB缓存加载失败');
            }

            const summary = result.data || {};
            if (!summary.cacheHit && fs.existsSync(globalCachePath)) {
                fs.copyFileSync(globalCachePath, projectCachePath);
            }

            if (this.worker) {
                const workerResult = await this.worker.sendRequest(SnmpConst.SNMP_REQ_TYPES.COMPILE_MIBS, {
                    filePaths: requestedFiles,
                    cacheFilePath: globalCachePath
                });
                summary.worker = workerResult.data;
            }

            return successResponse(
                {
                    project: this.formatMibProjectRecord(manifest, projectDir),
                    summary
                },
                'MIB工程导入成功'
            );
        } catch (error) {
            logger.error('导入MIB工程失败:', error);
            return errorResponse('导入MIB工程失败: ' + error.message);
        }
    }

    async handleClearMibs() {
        try {
            this.store.set(this.snmpMibFilesKey, []);
            const result = await this.sendMibWorkerRequest(SnmpConst.MIB_REQ_TYPES.CLEAR_MIBS, {
                cacheFilePath: this.getMibCacheFilePath()
            });

            if (this.worker) {
                await this.worker.sendRequest(SnmpConst.SNMP_REQ_TYPES.COMPILE_MIBS, {
                    filePaths: [],
                    cacheFilePath: this.getMibCacheFilePath(),
                    force: true
                });
            }

            return successResponse(result.data, result.msg || 'MIB配置已清空');
        } catch (error) {
            logger.error('清空MIB配置失败:', error);
            return errorResponse('清空MIB配置失败: ' + error.message);
        }
    }

    async handleTranslateOid(_event, oid) {
        try {
            const storedFiles = this.getStoredMibFilePaths();
            const result = await this.sendMibWorkerRequest(SnmpConst.MIB_REQ_TYPES.TRANSLATE_OID, {
                oid,
                requestedFiles: storedFiles,
                cacheFilePath: this.getMibCacheFilePath()
            });
            return successResponse(result.data, result.msg || 'OID解析成功');
        } catch (error) {
            logger.error('OID解析失败:', error);
            return errorResponse('OID解析失败: ' + error.message);
        }
    }

    async handleSendGetRequest(_event, request = {}) {
        let session = null;
        try {
            const storedConfig = this.normalizeSnmpConfig(this.store.get(this.snmpConfigFileKey) || {});
            const targetHost = String(storedConfig.targetHost || SnmpConst.DEFAULT_SNMP_SETTINGS.targetHost).trim();
            const oid = String(request.oid || '').trim();
            const version = this.getConfiguredSessionVersion(storedConfig);
            const community = storedConfig.community || 'public';
            const port = Number(storedConfig.queryPort) || SnmpConst.DEFAULT_SNMP_SETTINGS.queryPort;

            if (!targetHost) {
                return errorResponse('请输入目标地址');
            }

            if (!oid) {
                return errorResponse('请输入GET OID');
            }

            const snmpVersion = this.getSessionVersion(version);
            if (snmpVersion === null) {
                return errorResponse('当前GET发送暂支持SNMPv1/v2c，请在SNMP配置中启用SNMPv1或SNMPv2c');
            }

            session = snmp.createSession(targetHost, community, {
                port,
                version: snmpVersion,
                timeout: Number(request.timeout) || SnmpConst.DEFAULT_SNMP_SETTINGS.timeout,
                retries: Number(request.retries) || 0
            });

            const varbinds = await this.sendGetOids(session, [oid]);
            const firstError = varbinds.find(varbind => snmp.isVarbindError(varbind));
            if (firstError) {
                return errorResponse('GET失败: ' + snmp.varbindError(firstError));
            }

            return successResponse(
                {
                    targetHost,
                    targetPort: port,
                    version,
                    varbinds: varbinds.map(varbind => this.formatSessionVarbind(varbind))
                },
                'GET查询成功'
            );
        } catch (error) {
            logger.error('发送SNMP GET失败:', error);
            return errorResponse('发送SNMP GET失败: ' + error.message);
        } finally {
            if (session) {
                try {
                    session.close();
                } catch (error) {
                    logger.warn('关闭SNMP GET会话失败:', error.message);
                }
            }
        }
    }

    async handleSendGetNextRequest(_event, request = {}) {
        let session = null;
        try {
            const storedConfig = this.normalizeSnmpConfig(this.store.get(this.snmpConfigFileKey) || {});
            const targetHost = String(storedConfig.targetHost || SnmpConst.DEFAULT_SNMP_SETTINGS.targetHost).trim();
            const oid = String(request.oid || '').trim();
            const version = this.getConfiguredSessionVersion(storedConfig);
            const community = storedConfig.community || 'public';
            const port = Number(storedConfig.queryPort) || SnmpConst.DEFAULT_SNMP_SETTINGS.queryPort;

            if (!targetHost) {
                return errorResponse('请输入目标地址');
            }

            if (!oid) {
                return errorResponse('请输入GET-NEXT OID');
            }

            const snmpVersion = this.getSessionVersion(version);
            if (snmpVersion === null) {
                return errorResponse('当前GET-NEXT发送暂支持SNMPv1/v2c，请在SNMP配置中启用SNMPv1或SNMPv2c');
            }

            session = snmp.createSession(targetHost, community, {
                port,
                version: snmpVersion,
                timeout: Number(request.timeout) || SnmpConst.DEFAULT_SNMP_SETTINGS.timeout,
                retries: Number(request.retries) || 0
            });

            const varbinds = await this.sendGetNextOids(session, [oid]);
            const firstError = varbinds.find(varbind => snmp.isVarbindError(varbind));
            if (firstError) {
                return errorResponse('GET-NEXT失败: ' + snmp.varbindError(firstError));
            }

            return successResponse(
                {
                    targetHost,
                    targetPort: port,
                    version,
                    varbinds: varbinds.map(varbind => this.formatSessionVarbind(varbind))
                },
                'GET-NEXT查询成功'
            );
        } catch (error) {
            logger.error('发送SNMP GET-NEXT失败:', error);
            return errorResponse('发送SNMP GET-NEXT失败: ' + error.message);
        } finally {
            if (session) {
                try {
                    session.close();
                } catch (error) {
                    logger.warn('关闭SNMP GET-NEXT会话失败:', error.message);
                }
            }
        }
    }

    async handleSendSetRequest(_event, request = {}) {
        let session = null;
        try {
            const storedConfig = this.normalizeSnmpConfig(this.store.get(this.snmpConfigFileKey) || {});
            const targetHost = String(storedConfig.targetHost || SnmpConst.DEFAULT_SNMP_SETTINGS.targetHost).trim();
            const oid = String(request.oid || '').trim();
            const version = this.getConfiguredSessionVersion(storedConfig);
            const community = storedConfig.community || 'public';
            const port = Number(storedConfig.queryPort) || SnmpConst.DEFAULT_SNMP_SETTINGS.queryPort;

            if (!targetHost) {
                return errorResponse('请输入目标地址');
            }

            if (!oid) {
                return errorResponse('请输入SET OID');
            }

            const snmpVersion = this.getSessionVersion(version);
            if (snmpVersion === null) {
                return errorResponse('当前SET发送暂支持SNMPv1/v2c，请在SNMP配置中启用SNMPv1或SNMPv2c');
            }

            const objectType = this.getSetObjectType(request.type);
            const value = this.castSetValue(objectType, request.value);

            session = snmp.createSession(targetHost, community, {
                port,
                version: snmpVersion,
                timeout: Number(request.timeout) || SnmpConst.DEFAULT_SNMP_SETTINGS.timeout,
                retries: Number(request.retries) || 0
            });

            const varbinds = await this.sendSetVarbinds(session, [
                {
                    oid,
                    type: objectType,
                    value
                }
            ]);
            const firstError = varbinds.find(varbind => snmp.isVarbindError(varbind));
            if (firstError) {
                return errorResponse('SET失败: ' + snmp.varbindError(firstError));
            }

            return successResponse(
                {
                    targetHost,
                    targetPort: port,
                    version,
                    varbinds: varbinds.map(varbind => this.formatSessionVarbind(varbind))
                },
                'SET发送成功'
            );
        } catch (error) {
            logger.error('发送SNMP SET失败:', error);
            return errorResponse('发送SNMP SET失败: ' + error.message);
        } finally {
            if (session) {
                try {
                    session.close();
                } catch (error) {
                    logger.warn('关闭SNMP SET会话失败:', error.message);
                }
            }
        }
    }

    async handleSendWalkRequest(_event, request = {}) {
        let session = null;
        try {
            const storedConfig = this.normalizeSnmpConfig(this.store.get(this.snmpConfigFileKey) || {});
            const targetHost = String(storedConfig.targetHost || SnmpConst.DEFAULT_SNMP_SETTINGS.targetHost).trim();
            const baseOid = String(request.oid || '')
                .trim()
                .replace(/\.$/, '');
            const version = this.getConfiguredSessionVersion(storedConfig);
            const community = storedConfig.community || 'public';
            const port = Number(storedConfig.queryPort) || SnmpConst.DEFAULT_SNMP_SETTINGS.queryPort;
            const limit = Math.max(1, Math.min(Number(request.limit) || 100, 1000));
            const maxRepetitions = Math.max(1, Math.min(Number(request.maxRepetitions) || 20, 50));

            if (!targetHost) {
                return errorResponse('请输入目标地址');
            }

            if (!baseOid) {
                return errorResponse('请输入WALK起始OID');
            }

            const snmpVersion = this.getSessionVersion(version);
            if (snmpVersion === null) {
                return errorResponse('当前WALK暂支持SNMPv1/v2c，请在SNMP配置中启用SNMPv1或SNMPv2c');
            }

            session = snmp.createSession(targetHost, community, {
                port,
                version: snmpVersion,
                timeout: Number(request.timeout) || SnmpConst.DEFAULT_SNMP_SETTINGS.timeout,
                retries: Number(request.retries) || 0
            });

            const summary =
                version === 'v2c'
                    ? await this.listOidInstancesWithBulk(session, baseOid, limit, maxRepetitions)
                    : await this.listOidInstancesWithGetNext(session, baseOid, limit);

            return successResponse(
                {
                    targetHost,
                    targetPort: port,
                    version,
                    baseOid,
                    limit,
                    maxRepetitions,
                    ...summary
                },
                'WALK查询完成'
            );
        } catch (error) {
            logger.error('发送SNMP WALK失败:', error);
            return errorResponse('发送SNMP WALK失败: ' + error.message);
        } finally {
            if (session) {
                try {
                    session.close();
                } catch (error) {
                    logger.warn('关闭SNMP WALK会话失败:', error.message);
                }
            }
        }
    }

    async handleListOidInstances(_event, request = {}) {
        let session = null;
        try {
            const storedConfig = this.normalizeSnmpConfig(this.store.get(this.snmpConfigFileKey) || {});
            const targetHost = String(storedConfig.targetHost || SnmpConst.DEFAULT_SNMP_SETTINGS.targetHost).trim();
            const baseOid = String(request.oid || '')
                .trim()
                .replace(/\.$/, '');
            const version = this.getConfiguredSessionVersion(storedConfig);
            const community = storedConfig.community || 'public';
            const port = Number(storedConfig.queryPort) || SnmpConst.DEFAULT_SNMP_SETTINGS.queryPort;
            const limit = Math.max(1, Math.min(Number(request.limit) || 100, 500));
            const maxRepetitions = Math.max(1, Math.min(Number(request.maxRepetitions) || 20, 50));

            if (!targetHost) {
                return errorResponse('请输入目标地址');
            }

            if (!baseOid) {
                return errorResponse('请输入实例枚举OID');
            }

            const snmpVersion = this.getSessionVersion(version);
            if (snmpVersion === null) {
                return errorResponse('当前实例枚举暂支持SNMPv1/v2c，请在SNMP配置中启用SNMPv1或SNMPv2c');
            }

            session = snmp.createSession(targetHost, community, {
                port,
                version: snmpVersion,
                timeout: Number(request.timeout) || SnmpConst.DEFAULT_SNMP_SETTINGS.timeout,
                retries: Number(request.retries) || 0
            });

            const summary =
                version === 'v2c'
                    ? await this.listOidInstancesWithBulk(session, baseOid, limit, maxRepetitions)
                    : await this.listOidInstancesWithGetNext(session, baseOid, limit);

            return successResponse(
                {
                    targetHost,
                    targetPort: port,
                    version,
                    baseOid,
                    limit,
                    maxRepetitions,
                    ...summary
                },
                '实例枚举完成'
            );
        } catch (error) {
            logger.error('枚举SNMP实例失败:', error);
            return errorResponse('枚举SNMP实例失败: ' + error.message);
        } finally {
            if (session) {
                try {
                    session.close();
                } catch (error) {
                    logger.warn('关闭SNMP实例枚举会话失败:', error.message);
                }
            }
        }
    }

    sendGetOids(session, oids) {
        return new Promise((resolve, reject) => {
            session.get(oids, (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(result || []);
            });
        });
    }

    sendGetNextOids(session, oids) {
        return new Promise((resolve, reject) => {
            session.getNext(oids, (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(result || []);
            });
        });
    }

    sendGetBulkOids(session, oids, nonRepeaters, maxRepetitions) {
        return new Promise((resolve, reject) => {
            session.getBulk(oids, nonRepeaters, maxRepetitions, (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(result || []);
            });
        });
    }

    sendSetVarbinds(session, varbinds) {
        return new Promise((resolve, reject) => {
            session.set(varbinds, (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(result || []);
            });
        });
    }

    async listOidInstancesWithGetNext(session, baseOid, limit) {
        const rows = [];
        let currentOid = baseOid;
        let stoppedBy = 'endOfSubtree';

        while (rows.length < limit) {
            const varbinds = await this.sendGetNextOids(session, [currentOid]);
            const varbind = varbinds[0];
            const result = this.acceptInstanceVarbind(baseOid, currentOid, varbind);
            if (!result.accepted) {
                stoppedBy = result.reason;
                break;
            }

            rows.push(result.row);
            currentOid = varbind.oid;
        }

        return {
            rows,
            stoppedBy: rows.length >= limit ? 'limit' : stoppedBy,
            limitReached: rows.length >= limit
        };
    }

    async listOidInstancesWithBulk(session, baseOid, limit, maxRepetitions) {
        const rows = [];
        let currentOid = baseOid;
        let stoppedBy = 'endOfSubtree';

        while (rows.length < limit) {
            const groups = await this.sendGetBulkOids(
                session,
                [currentOid],
                0,
                Math.min(maxRepetitions, limit - rows.length)
            );
            const varbinds = Array.isArray(groups[0]) ? groups[0] : groups;
            if (!Array.isArray(varbinds) || varbinds.length === 0) {
                stoppedBy = 'emptyResponse';
                break;
            }

            let acceptedCount = 0;
            for (const varbind of varbinds) {
                const result = this.acceptInstanceVarbind(baseOid, currentOid, varbind);
                if (!result.accepted) {
                    stoppedBy = result.reason;
                    return {
                        rows,
                        stoppedBy,
                        limitReached: false
                    };
                }

                rows.push(result.row);
                currentOid = varbind.oid;
                acceptedCount++;

                if (rows.length >= limit) {
                    break;
                }
            }

            if (acceptedCount === 0) {
                stoppedBy = 'emptyResponse';
                break;
            }
        }

        return {
            rows,
            stoppedBy: rows.length >= limit ? 'limit' : stoppedBy,
            limitReached: rows.length >= limit
        };
    }

    acceptInstanceVarbind(baseOid, previousOid, varbind) {
        if (!varbind) {
            return {
                accepted: false,
                reason: 'emptyResponse'
            };
        }

        if (snmp.isVarbindError(varbind)) {
            return {
                accepted: false,
                reason: snmp.varbindError(varbind) || 'varbindError'
            };
        }

        if (!this.isOidInSubtree(baseOid, varbind.oid)) {
            return {
                accepted: false,
                reason: 'endOfSubtree'
            };
        }

        if (this.compareOids(varbind.oid, previousOid) <= 0) {
            return {
                accepted: false,
                reason: 'nonIncreasingOid'
            };
        }

        return {
            accepted: true,
            row: {
                ...this.formatSessionVarbind(varbind),
                instance: this.getOidInstanceSuffix(baseOid, varbind.oid)
            }
        };
    }

    isOidInSubtree(baseOid, oid) {
        return oid === baseOid || String(oid || '').startsWith(`${baseOid}.`);
    }

    getOidInstanceSuffix(baseOid, oid) {
        if (!this.isOidInSubtree(baseOid, oid) || oid === baseOid) {
            return '';
        }
        return String(oid).slice(baseOid.length + 1);
    }

    compareOids(left, right) {
        const leftParts = String(left || '')
            .split('.')
            .map(Number);
        const rightParts = String(right || '')
            .split('.')
            .map(Number);
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

    formatSessionVarbind(varbind) {
        return {
            oid: varbind.oid,
            type: snmp.ObjectType[varbind.type] || varbind.type,
            value: Buffer.isBuffer(varbind.value) ? varbind.value.toString() : varbind.value
        };
    }

    getSessionVersion(version) {
        const versionMap = {
            v1: snmp.Version1,
            v2c: snmp.Version2c
        };
        return versionMap[version] ?? null;
    }

    getConfiguredSessionVersion(config = {}) {
        const versions = Array.isArray(config.supportedVersions) ? config.supportedVersions : [];
        if (versions.length === 0 || !versions[0]) {
            return 'v2c';
        }
        return ['v1', 'v2c'].includes(versions[0]) ? versions[0] : '';
    }

    getSetObjectType(type = '') {
        const normalized = String(type || '')
            .replace(/[\s_-]+/g, '')
            .toLowerCase();
        const typeMap = {
            integer: snmp.ObjectType.Integer,
            integer32: snmp.ObjectType.Integer,
            boolean: snmp.ObjectType.Integer,
            truthvalue: snmp.ObjectType.Integer,
            rowstatus: snmp.ObjectType.Integer,
            octetstring: snmp.ObjectType.OctetString,
            displaystring: snmp.ObjectType.OctetString,
            string: snmp.ObjectType.OctetString,
            objectidentifier: snmp.ObjectType.OID,
            oid: snmp.ObjectType.OID,
            ipaddress: snmp.ObjectType.IpAddress,
            counter: snmp.ObjectType.Counter,
            counter32: snmp.ObjectType.Counter,
            gauge: snmp.ObjectType.Gauge,
            gauge32: snmp.ObjectType.Gauge,
            unsigned32: snmp.ObjectType.Gauge,
            timeticks: snmp.ObjectType.TimeTicks,
            counter64: snmp.ObjectType.Counter64
        };

        const objectType = typeMap[normalized];
        if (!objectType) {
            throw new Error(`不支持的SET类型: ${type || '-'}`);
        }
        return objectType;
    }

    castSetValue(objectType, value) {
        if (value === null || value === undefined || value === '') {
            throw new Error('请输入SET值');
        }

        if (
            [
                snmp.ObjectType.Integer,
                snmp.ObjectType.Counter,
                snmp.ObjectType.Gauge,
                snmp.ObjectType.TimeTicks,
                snmp.ObjectType.Counter64
            ].includes(objectType)
        ) {
            const numberValue = Number(value);
            if (!Number.isFinite(numberValue)) {
                throw new Error('数值类型必须输入数字');
            }
            return numberValue;
        }

        return String(value);
    }

    async ensureCurrentMibCache(sourcePaths) {
        const result = await this.sendMibWorkerRequest(SnmpConst.MIB_REQ_TYPES.GET_MIB_STATUS, {
            requestedFiles: sourcePaths,
            cacheFilePath: this.getMibCacheFilePath()
        });
        if (result.status !== 'success') {
            throw new Error(result.msg || '当前MIB缓存生成失败');
        }
        return result.data || {};
    }

    getMibProjectRootDir() {
        return path.join(app.getPath('userData'), 'snmp-mib-projects');
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
        if (!fs.existsSync(manifestPath)) {
            throw new Error('工程清单不存在');
        }

        const manifest = this.readJsonFile(manifestPath);
        if (!manifest || manifest.version !== 1 || !manifest.name) {
            throw new Error('工程清单格式无效');
        }

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
                if (!this.isMibCandidateFile(sourcePath)) {
                    return;
                }

                fs.copyFileSync(sourcePath, targetPath);
                requestedFiles.push(targetPath);
                filePathMap.set(sourcePath, targetPath);
                copiedFileCount++;
                return;
            }

            if (stat.isDirectory()) {
                fs.mkdirSync(targetPath, { recursive: true });
                const directoryFileCount = this.copyMibDirectoryFiles(sourcePath, targetPath, filePathMap);
                if (directoryFileCount > 0) {
                    requestedFiles.push(targetPath);
                    copiedFileCount += directoryFileCount;
                } else {
                    fs.rmSync(targetPath, { recursive: true, force: true });
                }
                return;
            }

            throw new Error(`不是文件或目录: ${sourcePath}`);
        });

        return {
            requestedFiles: this.normalizeFilePaths(requestedFiles),
            filePathMap,
            copiedFileCount
        };
    }

    copyMibDirectoryFiles(sourceDir, targetDir, filePathMap) {
        let copiedFileCount = 0;
        const usedNames = new Set();
        const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

        entries.forEach(entry => {
            if (entry.name.startsWith('.')) {
                return;
            }

            const sourcePath = path.join(sourceDir, entry.name);
            const targetName = this.getUniqueTargetName(targetDir, entry.name, usedNames);
            const targetPath = path.join(targetDir, targetName);

            if (entry.isDirectory()) {
                fs.mkdirSync(targetPath, { recursive: true });
                const directoryFileCount = this.copyMibDirectoryFiles(sourcePath, targetPath, filePathMap);
                if (directoryFileCount === 0) {
                    fs.rmSync(targetPath, { recursive: true, force: true });
                    return;
                }

                copiedFileCount += directoryFileCount;
                return;
            }

            if (!entry.isFile() || !this.isMibCandidateFile(sourcePath)) {
                return;
            }

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
        const expandedFiles = this.expandMibInputPaths(requestedFiles);

        return {
            version: sourceCache.version || 1,
            createdAt,
            requestedFiles,
            fileSignatures: this.getMibFileSignatures(expandedFiles),
            snapshot: {
                ...snapshot,
                requestedFiles,
                loadedFiles: this.remapMibFilePaths(snapshot.loadedFiles || [], copyResult.filePathMap),
                failedFiles: this.remapMibFailedFiles(snapshot.failedFiles || [], copyResult.filePathMap)
            }
        };
    }

    remapMibFilePaths(filePaths = [], filePathMap) {
        return this.normalizeFilePaths(filePaths.map(filePath => filePathMap.get(filePath) || filePath)).filter(
            filePath => fs.existsSync(filePath)
        );
    }

    remapMibFailedFiles(failedFiles = [], filePathMap) {
        if (!Array.isArray(failedFiles)) {
            return [];
        }

        return failedFiles.map(file => {
            const sourcePath = typeof file === 'string' ? file : file.filePath;
            if (!sourcePath) {
                return {
                    ...(typeof file === 'object' && file ? file : {}),
                    filePath: '',
                    fileName: ''
                };
            }
            const filePath = filePathMap.get(sourcePath) || sourcePath;
            return {
                ...(typeof file === 'object' && file ? file : {}),
                filePath,
                fileName: path.basename(filePath)
            };
        });
    }

    expandMibInputPaths(inputPaths = []) {
        const files = [];
        const seen = new Set();

        const addFile = filePath => {
            if (seen.has(filePath) || !this.isMibCandidateFile(filePath)) {
                return;
            }

            seen.add(filePath);
            files.push(filePath);
        };

        const visitPath = inputPath => {
            if (!inputPath || !fs.existsSync(inputPath)) {
                return;
            }

            const stat = fs.statSync(inputPath);
            if (stat.isFile()) {
                addFile(inputPath);
                return;
            }

            if (stat.isDirectory()) {
                this.walkMibDirectory(inputPath, addFile);
            }
        };

        this.normalizeFilePaths(inputPaths).forEach(visitPath);
        return files;
    }

    walkMibDirectory(directoryPath, addFile) {
        fs.readdirSync(directoryPath, { withFileTypes: true }).forEach(entry => {
            if (entry.name.startsWith('.')) {
                return;
            }

            const entryPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
                this.walkMibDirectory(entryPath, addFile);
                return;
            }

            if (entry.isFile()) {
                addFile(entryPath);
            }
        });
    }

    getMibFileSignatures(filePaths = []) {
        return filePaths
            .map(filePath => {
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
            })
            .filter(Boolean);
    }

    isMibCandidateFile(filePath) {
        return ['.mib', '.txt', '.my', ''].includes(path.extname(filePath).toLowerCase());
    }

    getStoredMibFilePaths() {
        const stored = this.store.get(this.snmpMibFilesKey);
        return this.normalizeFilePaths(stored);
    }

    getMibCacheFilePath() {
        return path.join(app.getPath('userData'), 'snmp-mib-cache.json');
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

    getMibWorker() {
        if (this.mibWorker) {
            return this.mibWorker;
        }

        const workerPath = resolveWorkerPath('snmp/mibWorker.js');
        const workerFactory = new WorkerWithPromise(workerPath);
        this.mibWorker = workerFactory.createLongRunningWorker();
        this.mibWorker.worker.unref();
        if (this.logLevel) {
            this.mibWorker.sendRequest(LOG_REQ_TYPES.SET_LOG_LEVEL, this.logLevel).catch(error => {
                logger.warn(`同步日志级别到 MIB worker 失败: ${error.message}`);
            });
        }
        return this.mibWorker;
    }

    async sendMibWorkerRequest(op, data = null) {
        try {
            return await this.getMibWorker().sendRequest(op, data);
        } catch (error) {
            if (/Worker stopped|terminated|Cannot post message/i.test(error.message)) {
                this.mibWorker = null;
            }
            throw error;
        }
    }

    async cleanupWorker() {
        if (this.worker && this.snmpTrapEventHandler) {
            this.worker.removeEventListener(SnmpConst.SNMP_EVT_TYPES.TRAP_EVT, this.snmpTrapEventHandler);
        }

        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
        }

        if (this.eventDispatcher) {
            this.eventDispatcher.cleanup();
            this.eventDispatcher = null;
        }

        this.snmpTrapEventHandler = null;
    }

    /**
     * 获取SNMP服务运行状态
     */
    getSnmpRunning() {
        return this.worker !== null;
    }
}

module.exports = SnmpApp;
