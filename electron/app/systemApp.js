const packageJson = require('../../package.json');
const { app, dialog, BrowserWindow } = require('electron');
const Store = require('electron-store');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const {
    DEFAULT_LOG_SETTINGS,
    DEFAULT_TOOLS_SETTINGS,
    DEFAULT_UPDATE_SETTINGS,
    LOG_REQ_TYPES
} = require('../const/toolsConst');
const { API_ACCESS_MODE, DEFAULT_API_SETTINGS } = require('../const/apiConst');
const path = require('path');
const { getIconPath } = require('../utils/iconUtils');
const BgpApp = require('./bgpApp');
const ToolsApp = require('./toolsApp');
const BmpApp = require('./bmpApp');
const RpkiApp = require('./rpkiApp');
const FtpApp = require('./ftpApp');
const SnmpApp = require('./snmpApp');
const DhcpApp = require('./dhcpApp');
const NtpApp = require('./ntpApp');
const RadiusApp = require('./radiusApp');
const TftpApp = require('./tftpApp');
const SyslogApp = require('./syslogApp');
const YangApp = require('./yangApp');
const NetconfApp = require('./netconfApp');
const AppUpdater = require('./updater');
const NativeApp = require('./nativeApp');
const FtpConst = require('../const/ftpConst');
const ExternalApiServer = require('./externalApiServer');
const createBmpApiRoutes = require('./bmpApiRoutes');
const CliAccessServer = require('./cli');
const WiresharkPluginInstaller = require('./wiresharkPluginInstaller');
const { clearMajorVersionData } = require('../utils/majorVersionDataCleanup');
/**
 * 用于系统菜单处理
 */
class SystemApp {
    constructor(ipc, win, progressCallback = null) {
        this.win = win;
        this.isDev = !app.isPackaged;
        this.progressCallback = progressCallback;
        // 注册IPC处理程序
        this.registerHandlers(ipc);
        this.generalSettingsFileKey = 'GeneralSettings';
        this.toolsSettingsFileKey = 'ToolsSettings';
        this.ftpSettingsFileKey = 'FtpSettings';
        this.apiSettingsFileKey = 'ApiSettings';
        this.updateSettingsFileKey = 'UpdateSettings';
        this.appVersionFileKey = 'appVersion';
        this.currentLogLevel = DEFAULT_LOG_SETTINGS.logLevel;

        this.store = new Store({
            name: 'Settings Data',
            fileExtension: 'json',
            cwd: app.getPath('userData')
        });

        this.programStore = new Store({
            name: 'Program Data',
            fileExtension: 'json',
            cwd: app.getPath('userData')
        });

        this.bgpApp = new BgpApp(ipc, this.programStore);
        this.bmpApp = new BmpApp(ipc, this.programStore);
        this.rpkiApp = new RpkiApp(ipc, this.programStore);
        this.ftpApp = new FtpApp(ipc, this.programStore);
        this.snmpApp = new SnmpApp(ipc, this.programStore);
        this.dhcpApp = new DhcpApp(ipc, this.programStore);
        this.ntpApp = new NtpApp(ipc, this.programStore);
        this.radiusApp = new RadiusApp(ipc, this.programStore);
        this.tftpApp = new TftpApp(ipc, this.programStore);
        this.syslogApp = new SyslogApp(ipc, this.programStore);
        this.yangApp = new YangApp(ipc, this.programStore);
        this.netconfApp = new NetconfApp(ipc, this.programStore, { yangApp: this.yangApp });
        this.updaterApp = new AppUpdater(ipc, win);
        this.nativeApp = new NativeApp(ipc);
        this.toolsApp = new ToolsApp(ipc, this.programStore);
        this.externalApiServer = new ExternalApiServer();
        this.cliAccessServer = new CliAccessServer({
            bmpApp: this.bmpApp,
            externalApiServer: this.externalApiServer
        });
        this.wiresharkPluginInstaller = new WiresharkPluginInstaller();
        this.externalApiRoutesLoaded = false;
    }

    loadExternalApiRoutes() {
        if (this.externalApiRoutesLoaded) {
            return;
        }
        this.externalApiServer.setRoutes([
            {
                method: 'GET',
                path: '/api/v1/status',
                handler: async () =>
                    successResponse(
                        {
                            ...this.externalApiServer.getStatus(),
                            modules: ['bmp']
                        },
                        'API服务状态获取成功'
                    )
            },
            ...createBmpApiRoutes(this.bmpApp)
        ]);
        this.externalApiRoutesLoaded = true;
    }

    unloadExternalApiRoutes() {
        this.externalApiServer.clearRoutes();
        this.externalApiRoutesLoaded = false;
    }

    // 添加版本兼容性检查方法
    checkVersionCompatibility(dialogParent = this.win) {
        try {
            // 获取当前版本
            const currentVersion = packageJson.version;
            logger.warn('当前版本: ' + currentVersion);

            // 获取存储的上一个版本
            const storedVersion = this.store.get(this.appVersionFileKey);
            logger.warn('存储版本: ' + storedVersion);

            // 如果是首次运行或版本信息丢失，保存当前版本并退出
            if (!storedVersion) {
                this.clearIncompatibleData(dialogParent);
                this.store.set(this.appVersionFileKey, currentVersion);
                return true;
            }

            // 检查版本是否不兼容 (对主版本号的变化进行检查)
            const currentMajorVersion = parseInt(currentVersion.split('.')[0]);
            const storedMajorVersion = parseInt(storedVersion.split('.')[0]);

            if (currentMajorVersion > storedMajorVersion) {
                logger.warn(`检测到不兼容升级: ${storedVersion} -> ${currentVersion}`);

                // 显示确认对话框
                const result = dialog.showMessageBoxSync(dialogParent, {
                    type: 'warning',
                    title: '版本不兼容',
                    message: `检测到主版本升级（${storedVersion} -> ${currentVersion}），需要清除旧数据。`,
                    detail: '将删除本地配置、JSON 数据和路由数据库，点击确定继续。',
                    buttons: ['确定', '取消'],
                    defaultId: 0,
                    cancelId: 1,
                    icon: getIconPath()
                });

                if (result === 0) {
                    // 用户选择确定，清除数据
                    this.clearIncompatibleData(dialogParent);
                    // 更新存储的版本
                    this.store.set(this.appVersionFileKey, currentVersion);
                    return true;
                } else {
                    return false;
                }
            } else {
                // 兼容版本升级，只更新版本号
                if (currentVersion !== storedVersion) {
                    this.store.set(this.appVersionFileKey, currentVersion);
                }
                return true;
            }
        } catch (error) {
            logger.error('检查版本兼容性时出错:', error.message);
            return false;
        }
    }

    // 添加清除不兼容数据的方法
    clearIncompatibleData(dialogParent = this.win) {
        try {
            logger.warn('清除不兼容数据');
            const userData = app.getPath('userData');

            // 主版本升级不迁移旧配置或路由数据，下一次打开时统一从空库和默认配置开始。
            const cleanup = clearMajorVersionData(userData);
            logger.warn(`已删除 ${cleanup.removedJsonFiles} 个本地 JSON 数据文件`);

            // 重新初始化 Store
            this.store = new Store({
                name: 'Settings Data',
                fileExtension: 'json',
                cwd: userData
            });

            this.programStore = new Store({
                name: 'Program Data',
                fileExtension: 'json',
                cwd: userData
            });

            // 各模块在 SystemApp 构造时已经拿到了旧 Store 实例，清理后统一切换到
            // 新实例，避免本次启动继续通过旧引用写入已经清除的程序数据。
            [
                this.bgpApp,
                this.bmpApp,
                this.rpkiApp,
                this.ftpApp,
                this.snmpApp,
                this.dhcpApp,
                this.ntpApp,
                this.radiusApp,
                this.tftpApp,
                this.syslogApp,
                this.toolsApp,
                this.yangApp,
                this.netconfApp
            ].forEach(appInstance => {
                if (appInstance) {
                    appInstance.store = this.programStore;
                }
            });
            this.yangApp.invalidateCompilation();
            return true;
        } catch (error) {
            logger.error('清除不兼容数据时出错:', error.message);
            dialog.showMessageBoxSync(dialogParent, {
                type: 'error',
                title: '错误',
                message: '清除数据时出错',
                detail: error.message,
                buttons: ['确定'],
                icon: getIconPath()
            });
            throw error;
        }
    }

    registerHandlers(ipc) {
        ipc.on('common:openDeveloperOptions', () => this.handleOpenDeveloperOptions());
        ipc.on('common:openSoftwareInfo', () => this.handleOpenSoftwareInfo());
        ipc.handle('common:saveGeneralSettings', (event, settings) => this.handleSaveGeneralSettings(settings));
        ipc.handle('common:getGeneralSettings', () => this.handleGetGeneralSettings());
        ipc.handle('common:saveToolsSettings', (event, settings) => this.handleSaveToolsSettings(settings));
        ipc.handle('common:getToolsSettings', () => this.handleGetToolsSettings());
        ipc.handle('common:saveFtpSettings', (event, settings) => this.handleSaveFtpSettings(settings));
        ipc.handle('common:getFtpSettings', () => this.handleGetFtpSettings());
        ipc.handle('common:saveApiSettings', (event, settings) => this.handleSaveApiSettings(settings));
        ipc.handle('common:getApiSettings', () => this.handleGetApiSettings());
        ipc.handle('common:getApiServerStatus', () => this.handleGetApiServerStatus());
        ipc.handle('common:saveUpdateSettings', (event, settings) => this.handleSaveUpdateSettings(settings));
        ipc.handle('common:getUpdateSettings', () => this.handleGetUpdateSettings());
        ipc.handle('common:selectDirectory', () => this.handleSelectDirectory());
        ipc.handle('common:getWiresharkBmpPluginStatus', () => this.handleGetWiresharkBmpPluginStatus());
        ipc.handle('common:installWiresharkBmpPlugin', () => this.handleInstallWiresharkBmpPlugin());
        ipc.handle('common:uninstallWiresharkBmpPlugin', () => this.handleUninstallWiresharkBmpPlugin());
        ipc.handle('common:openWiresharkPluginDirectory', () => this.handleOpenWiresharkPluginDirectory());
    }

    async handleGetWiresharkBmpPluginStatus() {
        try {
            const status = await this.wiresharkPluginInstaller.getStatus();
            return successResponse(status, 'Wireshark插件状态获取成功');
        } catch (error) {
            logger.error('Error getting Wireshark BMP plugin status:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleInstallWiresharkBmpPlugin() {
        try {
            const status = await this.wiresharkPluginInstaller.install();
            return successResponse(status, 'Wireshark插件已安装');
        } catch (error) {
            logger.error('Error installing Wireshark BMP plugin:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleUninstallWiresharkBmpPlugin() {
        try {
            const status = await this.wiresharkPluginInstaller.uninstall();
            return successResponse(status, 'Wireshark插件已卸载');
        } catch (error) {
            logger.error('Error uninstalling Wireshark BMP plugin:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleOpenWiresharkPluginDirectory() {
        try {
            const status = await this.wiresharkPluginInstaller.openPluginDirectory();
            return successResponse(status, 'Wireshark插件目录已打开');
        } catch (error) {
            logger.error('Error opening Wireshark plugin directory:', error.message);
            return errorResponse(error.message);
        }
    }

    handleSaveGeneralSettings(settings) {
        try {
            const logLevel = settings.logLevel || DEFAULT_LOG_SETTINGS.logLevel;
            const normalizedSettings = {
                ...settings
            };
            delete normalizedSettings.logLevel;
            if (Object.keys(normalizedSettings).length > 0) {
                this.store.set(this.generalSettingsFileKey, normalizedSettings);
            } else {
                this.store.delete(this.generalSettingsFileKey);
            }
            this.applyLogLevel(logLevel);
            return successResponse(null, 'Settings saved successfully');
        } catch (error) {
            logger.error('Error saving settings:', error.message);
            return errorResponse(error.message);
        }
    }

    handleGetGeneralSettings() {
        try {
            const settings = this.purgeStoredLogLevel();
            return successResponse(
                {
                    ...(settings || {}),
                    logLevel: this.currentLogLevel
                },
                'Settings loaded successfully'
            );
        } catch (error) {
            logger.error('Error getting settings:', error.message);
            return errorResponse(error.message);
        }
    }

    handleSaveToolsSettings(settings) {
        try {
            this.store.set(this.toolsSettingsFileKey, settings);

            let maxMessageHistory = DEFAULT_TOOLS_SETTINGS.packetParser.maxMessageHistory;
            let maxStringHistory = DEFAULT_TOOLS_SETTINGS.stringGenerator.maxStringHistory;
            if (settings.packetParser && settings.packetParser.maxMessageHistory) {
                maxMessageHistory = settings.packetParser.maxMessageHistory;
            }
            if (settings.stringGenerator && settings.stringGenerator.maxStringHistory) {
                maxStringHistory = settings.stringGenerator.maxStringHistory;
            }
            this.toolsApp.setMaxMessageHistory(maxMessageHistory);
            this.toolsApp.setMaxStringHistory(maxStringHistory);

            return successResponse(null, 'Settings saved successfully');
        } catch (error) {
            logger.error('Error saving settings:', error.message);
            return errorResponse(error.message);
        }
    }

    handleGetToolsSettings() {
        try {
            const settings = this.store.get(this.toolsSettingsFileKey);
            if (!settings) {
                return successResponse(null, 'Settings not found');
            }
            return successResponse(settings, 'Settings loaded successfully');
        } catch (error) {
            logger.error('Error getting settings:', error.message);
            return errorResponse(error.message);
        }
    }

    handleSaveFtpSettings(settings) {
        try {
            this.store.set(this.ftpSettingsFileKey, settings);

            let maxFtpUser = FtpConst.DEFAULT_FTP_SETTINGS.maxFtpUser;
            if (settings.maxFtpUser) {
                maxFtpUser = settings.maxFtpUser;
            }

            this.ftpApp.setMaxFtpUser(maxFtpUser);

            return successResponse(null, 'Settings saved successfully');
        } catch (error) {
            logger.error('Error saving settings:', error.message);
            return errorResponse(error.message);
        }
    }

    handleGetFtpSettings() {
        try {
            const settings = this.store.get(this.ftpSettingsFileKey);
            if (!settings) {
                return successResponse(null, 'Settings not found');
            }
            return successResponse(settings, 'Settings loaded successfully');
        } catch (error) {
            logger.error('Error getting settings:', error.message);
            return errorResponse(error.message);
        }
    }

    normalizeApiSettings(settings = {}) {
        const mode = this.normalizeApiAccessMode(settings);
        const port = Number(settings.port ?? DEFAULT_API_SETTINGS.port);
        const maxPageSize = Number(settings.maxPageSize ?? DEFAULT_API_SETTINGS.maxPageSize);
        const cliPort = DEFAULT_API_SETTINGS.cliPort;
        const cliMaxSessions = Number(settings.cliMaxSessions ?? DEFAULT_API_SETTINGS.cliMaxSessions);

        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('API端口必须是1到65535之间的整数');
        }
        if (!Number.isInteger(maxPageSize) || maxPageSize < 1 || maxPageSize > 10000) {
            throw new Error('分页最大条数必须是1到10000之间的整数');
        }
        if (!Number.isInteger(cliPort) || cliPort < 1 || cliPort > 65535) {
            throw new Error('CLI端口必须是1到65535之间的整数');
        }
        if (!Number.isInteger(cliMaxSessions) || cliMaxSessions < 1 || cliMaxSessions > 100) {
            throw new Error('CLI最大会话数必须是1到100之间的整数');
        }

        return {
            enabled: mode !== API_ACCESS_MODE.NONE,
            mode,
            host: DEFAULT_API_SETTINGS.host,
            port,
            maxPageSize,
            cliHost: DEFAULT_API_SETTINGS.cliHost,
            cliPort,
            cliMaxSessions
        };
    }

    normalizeApiAccessMode(settings = {}) {
        const mode = String(settings.mode || '').trim();
        if ([API_ACCESS_MODE.NONE, API_ACCESS_MODE.HTTP, API_ACCESS_MODE.CLI].includes(mode)) {
            return mode;
        }
        return settings.enabled ? API_ACCESS_MODE.HTTP : API_ACCESS_MODE.NONE;
    }

    async applyApiSettings(settings) {
        if (settings.mode === API_ACCESS_MODE.HTTP) {
            await this.cliAccessServer.updateSettings({
                enabled: false,
                host: settings.cliHost,
                port: settings.cliPort,
                maxSessions: settings.cliMaxSessions
            });
            this.loadExternalApiRoutes();
            try {
                await this.externalApiServer.updateSettings({
                    enabled: true,
                    host: settings.host,
                    port: settings.port,
                    maxPageSize: settings.maxPageSize
                });
            } catch (error) {
                this.unloadExternalApiRoutes();
                throw error;
            }
            return;
        }

        await this.externalApiServer.updateSettings({
            enabled: false,
            host: settings.host,
            port: settings.port,
            maxPageSize: settings.maxPageSize
        });
        this.unloadExternalApiRoutes();

        await this.cliAccessServer.updateSettings({
            enabled: settings.mode === API_ACCESS_MODE.CLI,
            host: settings.cliHost,
            port: settings.cliPort,
            maxSessions: settings.cliMaxSessions
        });
    }

    updateStartupProgress(progress, text) {
        if (typeof this.progressCallback === 'function') {
            this.progressCallback(progress, text);
        }
    }

    async handleSaveApiSettings(settings) {
        try {
            const normalizedSettings = this.normalizeApiSettings(settings);
            await this.applyApiSettings(normalizedSettings);
            this.store.set(this.apiSettingsFileKey, normalizedSettings);
            return successResponse(this.getAccessServiceStatus(), '接入设置保存成功');
        } catch (error) {
            logger.error('Error saving API settings:', error.message);
            return errorResponse(error.message);
        }
    }

    handleGetApiSettings() {
        try {
            const settings = this.store.get(this.apiSettingsFileKey);
            const normalizedSettings = this.normalizeApiSettings({
                ...DEFAULT_API_SETTINGS,
                ...(settings || {})
            });
            return successResponse(normalizedSettings, 'API设置加载成功');
        } catch (error) {
            logger.error('Error getting API settings:', error.message);
            return errorResponse(error.message);
        }
    }

    handleGetApiServerStatus() {
        try {
            return successResponse(this.getAccessServiceStatus(), '接入服务状态获取成功');
        } catch (error) {
            logger.error('Error getting API server status:', error.message);
            return errorResponse(error.message);
        }
    }

    getAccessServiceStatus() {
        const http = this.externalApiServer.getStatus();
        const cli = this.cliAccessServer.getStatus();
        return {
            running: http.running || cli.running,
            mode: http.running ? API_ACCESS_MODE.HTTP : cli.running ? API_ACCESS_MODE.CLI : API_ACCESS_MODE.NONE,
            http,
            cli,
            host: http.host,
            port: http.port,
            enabled: http.running || cli.running
        };
    }

    handleOpenDeveloperOptions() {
        this.win.webContents.openDevTools();
    }

    showSoftwareInfo() {
        const aboutMessage = `
      Version: ${packageJson.version}
      Author: ${packageJson.author.name}
      Email: ${packageJson.author.email}
      Environment: ${this.isDev ? 'Development' : 'Production'}
      Electron: ${process.versions.electron}
      arch: ${process.arch}
      platform: ${process.platform}
      Node.js: ${process.versions.node}
      Chrome: ${process.versions.chrome}`;

        dialog.showMessageBox({
            type: 'info',
            title: 'About NetNexus',
            message: aboutMessage,
            buttons: ['OK'],
            icon: path.join(__dirname, '../assets/icon.ico')
        });
    }

    handleOpenSoftwareInfo() {
        this.showSoftwareInfo();
    }

    applyLogLevel(logLevel) {
        this.currentLogLevel = logLevel || DEFAULT_LOG_SETTINGS.logLevel;
        logger.setLevel(this.currentLogLevel);
        [
            this.bgpApp,
            this.bmpApp,
            this.rpkiApp,
            this.ftpApp,
            this.snmpApp,
            this.dhcpApp,
            this.ntpApp,
            this.radiusApp,
            this.tftpApp,
            this.syslogApp,
            this.yangApp,
            this.netconfApp
        ].forEach(appInstance => this.applyLogLevelToApp(appInstance));
    }

    applyLogLevelToApp(appInstance) {
        if (!appInstance) {
            return;
        }

        appInstance.logLevel = this.currentLogLevel;
        if (typeof appInstance.handleLogLevelChange === 'function') {
            Promise.resolve()
                .then(() => appInstance.handleLogLevelChange(this.currentLogLevel))
                .catch(error => {
                    logger.warn(`同步日志级别到应用组件失败: ${error.message}`);
                });
        }
        [appInstance.worker, appInstance.worker6, appInstance.mibWorker].forEach(worker => {
            if (!worker || typeof worker.sendRequest !== 'function') {
                return;
            }

            worker.sendRequest(LOG_REQ_TYPES.SET_LOG_LEVEL, this.currentLogLevel).catch(error => {
                logger.warn(`同步日志级别到 worker 失败: ${error.message}`);
            });
        });
    }

    purgeStoredLogLevel() {
        const settings = this.store.get(this.generalSettingsFileKey);
        if (!settings || typeof settings !== 'object') {
            return null;
        }

        if (!Object.prototype.hasOwnProperty.call(settings, 'logLevel')) {
            return settings;
        }

        const sanitizedSettings = {
            ...settings
        };
        delete sanitizedSettings.logLevel;

        if (Object.keys(sanitizedSettings).length > 0) {
            this.store.set(this.generalSettingsFileKey, sanitizedSettings);
            return sanitizedSettings;
        }

        this.store.delete(this.generalSettingsFileKey);
        return null;
    }

    async loadSettings() {
        this.updateStartupProgress(50, '正在加载基础设置...');
        this.purgeStoredLogLevel();

        // 日志级别不再持久化，启动时固定关闭。设置页保存后仅当前运行期间生效。
        this.applyLogLevel(DEFAULT_LOG_SETTINGS.logLevel);

        // 加载工具设置
        this.updateStartupProgress(56, '正在加载工具设置...');
        let maxMessageHistory = DEFAULT_TOOLS_SETTINGS.packetParser.maxMessageHistory;
        let maxStringHistory = DEFAULT_TOOLS_SETTINGS.stringGenerator.maxStringHistory;
        let maxFtpUser = DEFAULT_TOOLS_SETTINGS.ftpServer.maxFtpUser;
        const toolsSettings = this.store.get(this.toolsSettingsFileKey);
        if (toolsSettings && toolsSettings.packetParser) {
            if (toolsSettings.packetParser.maxMessageHistory) {
                maxMessageHistory = toolsSettings.packetParser.maxMessageHistory;
            }
        }
        if (toolsSettings && toolsSettings.stringGenerator) {
            if (toolsSettings.stringGenerator.maxStringHistory) {
                maxStringHistory = toolsSettings.stringGenerator.maxStringHistory;
            }
        }
        if (toolsSettings && toolsSettings.ftpServer) {
            if (toolsSettings.ftpServer.maxFtpUser) {
                maxFtpUser = toolsSettings.ftpServer.maxFtpUser;
            }
        }
        this.toolsApp.setMaxMessageHistory(maxMessageHistory);
        this.toolsApp.setMaxStringHistory(maxStringHistory);
        this.ftpApp.setMaxFtpUser(maxFtpUser);

        // 加载更新设置并应用
        this.updateStartupProgress(62, '正在加载更新设置...');
        let updateSetting = DEFAULT_UPDATE_SETTINGS;
        const updateSettingsFromStore = this.store.get(this.updateSettingsFileKey);
        if (updateSettingsFromStore) {
            updateSetting = updateSettingsFromStore;
        }
        this.updaterApp.updateSettings(updateSetting);

        // 加载外部接入设置并按保存的接入方式自动启动。mode=none 时保持关闭。
        this.updateStartupProgress(68, '正在加载外部接入设置...');
        try {
            const apiSettings = this.normalizeApiSettings({
                ...DEFAULT_API_SETTINGS,
                ...(this.store.get(this.apiSettingsFileKey) || {})
            });
            if (apiSettings.mode === API_ACCESS_MODE.NONE) {
                await this.applyApiSettings(apiSettings);
                this.updateStartupProgress(72, '外部接入未启用');
            } else {
                this.updateStartupProgress(
                    70,
                    apiSettings.mode === API_ACCESS_MODE.HTTP ? '正在启动 HTTP API...' : '正在启动 Telnet CLI...'
                );
                await this.applyApiSettings(apiSettings);
                this.updateStartupProgress(
                    74,
                    apiSettings.mode === API_ACCESS_MODE.HTTP ? 'HTTP API 已启动' : 'Telnet CLI 已启动'
                );
            }
        } catch (error) {
            logger.error('启动外部接入服务失败:', error.message);
            this.updateStartupProgress(74, `外部接入启动失败: ${error.message}`);
        }

        this.updateStartupProgress(80, '设置加载完成');
    }

    async handleWindowClose() {
        const isBgpRunning = this.bgpApp.getBgpRunning();
        const isBmpRunning = this.bmpApp.getBmpRunning();
        const isRpkiRunning = this.rpkiApp.getRpkiRunning();
        const isFtpRunning = this.ftpApp.getFtpRunning();
        const isSnmpRunning = this.snmpApp.getSnmpRunning();
        const isNtpRunning = this.ntpApp.getNtpRunning();
        const isRadiusRunning = this.radiusApp.getRadiusRunning();
        const isTftpRunning = this.tftpApp.getTftpRunning();
        const isSyslogRunning = this.syslogApp.getSyslogRunning();
        const isNetconfRunning = this.netconfApp.getRunning();
        const isYangRunning = this.yangApp.getRunning();
        const isApiRunning = this.externalApiServer.getRunning();
        const isCliRunning = this.cliAccessServer.getRunning();

        if (
            isBgpRunning ||
            isBmpRunning ||
            isRpkiRunning ||
            isFtpRunning ||
            isSnmpRunning ||
            isNtpRunning ||
            isRadiusRunning ||
            isTftpRunning ||
            isSyslogRunning ||
            isNetconfRunning ||
            isYangRunning ||
            isApiRunning ||
            isCliRunning
        ) {
            const { response } = await dialog.showMessageBox(this.win, {
                type: 'warning',
                title: '确认关闭',
                message: 'NetNexus 正在运行，确定要关闭吗？',
                buttons: ['确定', '取消'],
                defaultId: 1,
                cancelId: 1,
                icon: getIconPath()
            });

            if (response === 0) {
                // 用户点击确定，先停止 NetNexus 然后关闭窗口
                if (isBgpRunning) {
                    await this.bgpApp.handleStopBgp();
                }
                if (isBmpRunning) {
                    await this.bmpApp.handleStopBmp();
                }
                if (isRpkiRunning) {
                    await this.rpkiApp.handleStopRpki();
                }
                if (isFtpRunning) {
                    await this.ftpApp.handleStopFtp();
                }
                if (isSnmpRunning) {
                    await this.snmpApp.handleStopSnmp();
                }
                if (isNtpRunning) {
                    await this.ntpApp.handleStopNtp();
                }
                if (isRadiusRunning) {
                    await this.radiusApp.handleStopRadius();
                }
                if (isTftpRunning) {
                    await this.tftpApp.handleStopTftp();
                }
                if (isSyslogRunning) {
                    await this.syslogApp.handleStopSyslog();
                }
                if (isApiRunning) {
                    await this.externalApiServer.stop();
                    this.unloadExternalApiRoutes();
                }
                if (isCliRunning) {
                    await this.cliAccessServer.stop();
                }

                await this.netconfApp.closeAll();
                await this.bmpApp.closeOfflinePersistenceReader();
                await this.rpkiApp.closeStorage();
                await this.yangApp.close();

                return true;
            }
            return false;
        }

        if (isCliRunning) {
            await this.cliAccessServer.stop();
        }
        await this.bmpApp.closeOfflinePersistenceReader();
        await this.rpkiApp.closeStorage();
        await this.netconfApp.closeAll();
        await this.yangApp.close();
        return true;
    }

    async handleSelectDirectory() {
        try {
            const win = BrowserWindow.getFocusedWindow(); // 获取当前窗口
            const result = await dialog.showOpenDialog(win, {
                properties: ['openDirectory'],
                icon: getIconPath()
            });
            return successResponse(result);
        } catch (error) {
            logger.error('Error selecting directory:', error.message);
            return errorResponse(error.message);
        }
    }

    handleSaveUpdateSettings(settings) {
        try {
            this.store.set(this.updateSettingsFileKey, settings);
            // 更新AppUpdater的设置
            this.updaterApp.updateSettings(settings);
            return successResponse(null, 'Update settings saved successfully');
        } catch (error) {
            logger.error('Error saving update settings:', error.message);
            return errorResponse(error.message);
        }
    }

    handleGetUpdateSettings() {
        try {
            const settings = this.store.get(this.updateSettingsFileKey);
            if (!settings) {
                return successResponse(DEFAULT_UPDATE_SETTINGS, 'Default update settings loaded');
            }
            return successResponse(settings, 'Update settings loaded successfully');
        } catch (error) {
            logger.error('Error getting update settings:', error.message);
            return errorResponse(error.message);
        }
    }
}

module.exports = SystemApp;
