const packageJson = require('../../package.json');
const { app, dialog, BrowserWindow } = require('electron');
const Store = require('electron-store');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const { DEFAULT_LOG_SETTINGS, DEFAULT_TOOLS_SETTINGS, DEFAULT_UPDATE_SETTINGS } = require('../const/toolsConst');
const fs = require('fs');
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
const AppUpdater = require('./updater');
const NativeApp = require('./nativeApp');
const FtpConst = require('../const/ftpConst');
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
        this.updateSettingsFileKey = 'UpdateSettings';
        this.deploymentConfigFileKey = 'DeploymentConfig';
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
        this.updaterApp = new AppUpdater(ipc, win);
        this.nativeApp = new NativeApp(ipc);
        this.toolsApp = new ToolsApp(ipc, this.programStore);
    }

    // 添加版本兼容性检查方法
    checkVersionCompatibility() {
        try {
            // 获取当前版本
            const currentVersion = packageJson.version;
            logger.warn('当前版本: ' + currentVersion);

            // 获取存储的上一个版本
            const storedVersion = this.store.get(this.appVersionFileKey);
            logger.warn('存储版本: ' + storedVersion);

            // 如果是首次运行或版本信息丢失，保存当前版本并退出
            if (!storedVersion) {
                this.clearIncompatibleData();
                this.store.set(this.appVersionFileKey, currentVersion);
                return true;
            }

            // 检查版本是否不兼容 (对主版本号的变化进行检查)
            const currentMajorVersion = parseInt(currentVersion.split('.')[0]);
            const storedMajorVersion = parseInt(storedVersion.split('.')[0]);

            if (currentMajorVersion > storedMajorVersion) {
                logger.warn(`检测到不兼容升级: ${storedVersion} -> ${currentVersion}`);

                // 显示确认对话框
                const result = dialog.showMessageBoxSync({
                    type: 'warning',
                    title: '版本不兼容',
                    message: `检测到主版本升级（${storedVersion} -> ${currentVersion}），需要清除旧数据。`,
                    detail: '将删除程序数据和设置数据，点击确定继续。',
                    buttons: ['确定', '取消'],
                    defaultId: 0,
                    cancelId: 1,
                    icon: getIconPath()
                });

                if (result === 0) {
                    // 用户选择确定，清除数据
                    this.clearIncompatibleData();
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
    clearIncompatibleData() {
        try {
            logger.warn('清除不兼容数据');
            const userData = app.getPath('userData');

            // 删除 Program Data
            const programDataPath = path.join(userData, 'Program Data.json');
            if (fs.existsSync(programDataPath)) {
                fs.unlinkSync(programDataPath);
                logger.warn('已删除 Program Data.json');
            }

            // 删除 Settings Data
            const settingsDataPath = path.join(userData, 'Settings Data.json');
            if (fs.existsSync(settingsDataPath)) {
                fs.unlinkSync(settingsDataPath);
                logger.warn('已删除 Settings Data.json');
            }

            // 重新初始化 Store
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
        } catch (error) {
            logger.error('清除不兼容数据时出错:', error.message);
            dialog.showMessageBoxSync({
                type: 'error',
                title: '错误',
                message: '清除数据时出错',
                detail: error.message,
                buttons: ['确定'],
                icon: getIconPath()
            });
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
        ipc.handle('common:saveUpdateSettings', (event, settings) => this.handleSaveUpdateSettings(settings));
        ipc.handle('common:getUpdateSettings', () => this.handleGetUpdateSettings());
        ipc.handle('common:selectDirectory', () => this.handleSelectDirectory());

        // 服务器部署
        ipc.handle('common:deployServer', (event, deployConfig) => this.handleDeployServer(deployConfig));
        ipc.handle('common:saveDeploymentConfig', (event, config) => this.handleSaveDeploymentConfig(config));
        ipc.handle('common:loadDeploymentConfig', () => this.handleLoadDeploymentConfig());
        ipc.handle('common:testSSHConnection', (event, config) => this.handleTestSSHConnection(config));
        ipc.handle('common:getServerDeploymentStatus', () => this.handleGetServerDeploymentStatus());
    }

    async handleDeployServer(deployConfig) {
        const SshDeployer = require('./sshDeployer');
        const deployer = new SshDeployer();

        try {
            logger.info(`Starting proxy deployment to ${deployConfig.serverAddress}...`);

            // Connect to SSH server
            await deployer.connect(deployConfig.serverAddress, deployConfig.sshUsername, deployConfig.sshPassword);

            // Deploy proxy
            const result = await deployer.deploy();

            logger.info('Proxy deployment completed successfully');
            return successResponse(result, '代理部署成功');
        } catch (error) {
            logger.error(`Proxy deployment failed: ${error.message}`);
            return errorResponse(`部署失败: ${error.message}`);
        } finally {
            deployer.disconnect();
        }
    }

    async handleSaveDeploymentConfig(config) {
        try {
            this.store.set(this.deploymentConfigFileKey, config);
            this.bmpApp.setServerDeploymentConfig(config);
            this.rpkiApp.setServerDeploymentConfig(config);
            return successResponse(null, '部署配置保存成功');
        } catch (error) {
            logger.error('Error saving deployment config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleLoadDeploymentConfig() {
        try {
            const config = this.store.get(this.deploymentConfigFileKey);
            return successResponse(config || {});
        } catch (error) {
            logger.error('Error loading deployment config:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleTestSSHConnection(sshConfig) {
        const SshDeployer = require('./sshDeployer');
        const deployer = new SshDeployer();

        try {
            logger.info(`Testing SSH connection to ${sshConfig.serverAddress}...`);
            await deployer.connect(sshConfig.serverAddress, sshConfig.sshUsername, sshConfig.sshPassword);
            deployer.disconnect();
            return successResponse(null, 'SSH连接测试成功');
        } catch (error) {
            logger.error(`SSH connection test failed: ${error.message}`);
            return errorResponse(`连接失败: ${error.message}`);
        }
    }

    // 获取服务部署状态
    async handleGetServerDeploymentStatus() {
        try {
            const config = this.store.get(this.deploymentConfigFileKey);
            if (config && config.deploymentStatus) {
                if (config.deploymentStatus.success) {
                    return successResponse({ success: true }, '');
                } else {
                    return successResponse({ success: false }, '');
                }
            }
            return successResponse({ success: false }, '');
        } catch (error) {
            logger.error('Error getting server deployment status:', error.message);
            return successResponse({ success: false }, '');
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
        this.bgpApp.logLevel = this.currentLogLevel;
        this.bmpApp.logLevel = this.currentLogLevel;
        this.rpkiApp.logLevel = this.currentLogLevel;
        this.ftpApp.logLevel = this.currentLogLevel;
        this.snmpApp.logLevel = this.currentLogLevel;
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

    loadSettings() {
        this.purgeStoredLogLevel();

        // 日志级别不再持久化，启动时固定关闭。设置页保存后仅当前运行期间生效。
        this.applyLogLevel(DEFAULT_LOG_SETTINGS.logLevel);

        // 加载工具设置
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
        let updateSetting = DEFAULT_UPDATE_SETTINGS;
        const updateSettingsFromStore = this.store.get(this.updateSettingsFileKey);
        if (updateSettingsFromStore) {
            updateSetting = updateSettingsFromStore;
        }
        this.updaterApp.updateSettings(updateSetting);

        // 加载部署配置
        const deploymentConfig = this.store.get(this.deploymentConfigFileKey);
        if (deploymentConfig) {
            this.bmpApp.setServerDeploymentConfig(deploymentConfig);
            this.rpkiApp.setServerDeploymentConfig(deploymentConfig);
        }
    }

    async handleWindowClose() {
        const isBgpRunning = this.bgpApp.getBgpRunning();
        const isBmpRunning = this.bmpApp.getBmpRunning();
        const isRpkiRunning = this.rpkiApp.getRpkiRunning();
        const isFtpRunning = this.ftpApp.getFtpRunning();
        const isSnmpRunning = this.snmpApp.getSnmpRunning();
        const isNtpRunning = this.ntpApp.getNtpRunning();

        if (
            isBgpRunning ||
            isBmpRunning ||
            isRpkiRunning ||
            isFtpRunning ||
            isSnmpRunning ||
            isNtpRunning
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

                return true;
            }
            return false;
        }

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
