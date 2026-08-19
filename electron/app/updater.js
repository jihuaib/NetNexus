const { autoUpdater } = require('electron-updater');
const { parseVersion } = require('electron-updater/out/providers/Provider');
const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const logger = require('../log/logger');
const { DEFAULT_UPDATE_SETTINGS } = require('../const/toolsConst');
const EventDispatcher = require('../utils/eventDispatcher');
const { successResponse } = require('../utils/responseUtils');

const LINUX_RELEASES_URL = 'https://github.com/jihuaib/NetNexus/releases';
const LINUX_MANUAL_UPDATE_MESSAGE = 'Linux 请从 GitHub Releases 下载并用 apt 安装 .deb';

function getUpdatePolicy(platform = process.platform) {
    if (platform === 'linux') {
        return {
            platform,
            mode: 'manual-deb',
            automaticUpdatesSupported: false,
            message: LINUX_MANUAL_UPDATE_MESSAGE,
            releasesUrl: LINUX_RELEASES_URL
        };
    }

    return {
        platform,
        mode: 'automatic',
        automaticUpdatesSupported: true,
        message: '',
        releasesUrl: LINUX_RELEASES_URL
    };
}

class AppUpdater {
    constructor(ipc, mainWindow) {
        this.mainWindow = mainWindow;
        this.ipc = ipc;
        this.updateDownloaded = false;
        this.isDev = !app.isPackaged;
        this.updatePolicy = getUpdatePolicy();
        this.updateSettingsConfig = DEFAULT_UPDATE_SETTINGS;

        // 保存事件监听器引用，便于后续清理
        this.eventListeners = {};
        this.eventDispatcher = new EventDispatcher();
        this.eventDispatcher.setWebContents(this.mainWindow.webContents);

        this.setupAutoUpdater();
        this.registerHandlers();
        this.setupUpdateEvents();
    }

    registerHandlers() {
        this.ipc.handle('updater:checkForUpdates', this.checkForUpdates.bind(this));
        this.ipc.handle('updater:downloadUpdate', this.downloadUpdate.bind(this));
        this.ipc.handle('updater:quitAndInstall', this.quitAndInstall.bind(this));
        this.ipc.handle('updater:getCurrentVersion', this.getCurrentVersion.bind(this));
        this.ipc.handle('updater:getUpdatePolicy', this.getUpdatePolicy.bind(this));
        this.ipc.handle('updater:openReleasesPage', this.openReleasesPage.bind(this));
    }

    setupAutoUpdater() {
        if (!this.updatePolicy.automaticUpdatesSupported) {
            logger.info(LINUX_MANUAL_UPDATE_MESSAGE);
            return;
        }

        // 配置更新日志
        autoUpdater.logger = logger.raw();

        // 开发环境配置
        if (this.isDev) {
            // 强制在开发环境中启用更新检查
            autoUpdater.forceDevUpdateConfig = true;

            // 设置开发环境的更新配置
            Object.assign(autoUpdater, {
                // 允许降级（开发环境便于测试）
                allowDowngrade: true
            });

            // 设置本地更新配置文件用于测试
            const devConfigPath = path.join(__dirname, '../dev-app-update.yml');
            if (fs.existsSync(devConfigPath)) {
                autoUpdater.updateConfigPath = devConfigPath;
                logger.info('开发环境：使用本地配置文件', devConfigPath);
            }

            // macOS 开发环境额外配置
            if (process.platform === 'darwin') {
                // macOS 开发环境需要明确设置当前版本，否则无法正确比较版本
                // 从 package.json 读取版本号
                try {
                    const packageJsonPath = path.join(__dirname, '../../package.json');
                    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                    // 设置当前版本用于开发环境测试，需要使用 parseVersion 转换为 SemVer 对象
                    autoUpdater.currentVersion = parseVersion(packageJson.version);
                    logger.info('macOS 开发环境：设置当前版本为', packageJson.version);
                } catch (err) {
                    logger.warn('macOS 开发环境：读取 package.json 版本失败', err.message);
                }
            }

            logger.info('开发环境：已启用更新检查，forceDevUpdateConfig = true');
        } else {
            // 生产环境配置
            Object.assign(autoUpdater, {
                // 不允许降级（生产环境，防止重命名品牌后旧版本被识别为新版本）
                allowDowngrade: false
            });
        }
    }

    // 应用更新设置
    applyUpdateSettings() {
        if (!this.updatePolicy.automaticUpdatesSupported) {
            logger.info('Linux 自动更新已禁用；不会执行启动更新检查');
            return;
        }

        // 自动下载更新
        autoUpdater.autoDownload = this.updateSettingsConfig.autoDownload;
        autoUpdater.autoInstallOnAppQuit = true;

        // 启动时检查更新
        if (this.updateSettingsConfig.autoCheckOnStartup) {
            // 延迟一段时间后再检查更新，确保应用完全启动
            setTimeout(() => {
                this.checkForUpdates();
            }, 3000); // 3秒后检查更新
        }

        logger.info('更新设置已应用:', {
            autoDownload: autoUpdater.autoDownload,
            allowDowngrade: autoUpdater.allowDowngrade,
            autoCheckOnStartup: this.updateSettingsConfig.autoCheckOnStartup
        });
    }

    // 动态更新设置
    updateSettings(newSettings) {
        this.updateSettingsConfig = newSettings;
        this.applyUpdateSettings();
        logger.info('更新设置已更新:', this.updateSettingsConfig);
    }

    setupUpdateEvents() {
        if (!this.updatePolicy.automaticUpdatesSupported) {
            return;
        }

        // 检查更新时
        this.eventListeners.checkingForUpdate = () => {
            logger.info('正在检查更新...');
            this.sendUpdateStatus('checking-for-update');
        };
        autoUpdater.on('checking-for-update', this.eventListeners.checkingForUpdate);

        // 有可用更新时
        this.eventListeners.updateAvailable = info => {
            logger.info('发现新版本:', info.version);
            this.sendUpdateStatus('update-available', info);
            if (this.updateSettingsConfig.autoDownload) {
                this.sendUpdateStatus('download-started');
            }
        };
        autoUpdater.on('update-available', this.eventListeners.updateAvailable);

        // 没有可用更新时
        this.eventListeners.updateNotAvailable = info => {
            logger.info('当前已是最新版本');
            this.sendUpdateStatus('update-not-available', info);
        };
        autoUpdater.on('update-not-available', this.eventListeners.updateNotAvailable);

        // 更新错误时
        this.eventListeners.error = err => {
            // 检查是否是找不到更新文件的 404 错误
            const is404Error =
                err.message &&
                (err.message.includes('latest-mac.yml') || err.message.includes('latest.yml')) &&
                err.message.includes('404');

            if (is404Error) {
                // 服务端没有对应平台的更新文件，只记录简洁日志
                logger.warn('更新检查：服务端暂无当前平台的更新包');
                this.sendUpdateStatus('update-error', { error: '服务端暂无当前平台的更新包' });
            } else {
                logger.error('更新过程中出现错误:', err);
                this.sendUpdateStatus('update-error', { error: err.message });
            }
        };
        autoUpdater.on('error', this.eventListeners.error);

        // 下载进度
        this.eventListeners.downloadProgress = progressObj => {
            const logMessage = `下载速度: ${progressObj.bytesPerSecond} - 已下载 ${progressObj.percent}% (${progressObj.transferred}/${progressObj.total})`;
            logger.info(logMessage);
            this.sendUpdateStatus('download-progress', progressObj);
        };
        autoUpdater.on('download-progress', this.eventListeners.downloadProgress);

        // 更新下载完成
        this.eventListeners.updateDownloaded = info => {
            logger.info('更新下载完成');
            this.updateDownloaded = true;
            this.sendUpdateStatus('update-downloaded', info);
        };
        autoUpdater.on('update-downloaded', this.eventListeners.updateDownloaded);
    }

    // 发送更新状态到渲染进程
    sendUpdateStatus(type, data = {}) {
        this.eventDispatcher.emit('updater:update-status', successResponse({ type, data }));
    }

    // 检查更新
    async checkForUpdates() {
        if (!this.updatePolicy.automaticUpdatesSupported) {
            return this.linuxManualUpdateResponse();
        }

        try {
            logger.info('手动检查更新');
            const result = await autoUpdater.checkForUpdates();
            // 返回简化的结果，避免 IPC 序列化问题
            return {
                success: true,
                updateInfo: result?.updateInfo
                    ? {
                          version: result.updateInfo.version,
                          releaseDate: result.updateInfo.releaseDate
                      }
                    : null
            };
        } catch (error) {
            // 检查是否是找不到更新文件的 404 错误
            const is404Error =
                error.message &&
                (error.message.includes('latest-mac.yml') || error.message.includes('latest.yml')) &&
                error.message.includes('404');

            if (is404Error) {
                logger.warn('检查更新：服务端暂无当前平台的更新包');
            } else {
                logger.error('检查更新失败:', error);
            }
            // 事件已由 error 监听器处理，这里不再重复发送
            return {
                success: false,
                error: is404Error ? '服务端暂无当前平台的更新包' : error.message
            };
        }
    }

    // 下载更新
    async downloadUpdate() {
        if (!this.updatePolicy.automaticUpdatesSupported) {
            return this.linuxManualUpdateResponse();
        }

        try {
            logger.info('开始下载更新');
            this.sendUpdateStatus('download-started');
            await autoUpdater.downloadUpdate();
        } catch (error) {
            logger.error('下载更新失败:', error);
            this.sendUpdateStatus('update-error', { error: error.message });
        }
    }

    // 退出并安装更新
    quitAndInstall() {
        if (!this.updatePolicy.automaticUpdatesSupported) {
            return this.linuxManualUpdateResponse();
        }

        if (this.updateDownloaded) {
            // macOS 开发环境下，只记录日志，不执行实际安装
            if (this.isDev && process.platform === 'darwin') {
                logger.info('macOS 开发环境：已下载更新，但开发环境下无法执行自动安装');
                logger.info('请使用打包后的应用测试完整的更新安装流程');
                return;
            }
            logger.info('退出应用并安装更新');
            autoUpdater.quitAndInstall();
        } else {
            logger.warn('没有下载的更新可安装');
        }
    }

    // 获取当前版本信息
    getCurrentVersion() {
        return app.getVersion();
    }

    getUpdatePolicy() {
        return { ...this.updatePolicy };
    }

    linuxManualUpdateResponse() {
        return {
            success: false,
            code: 'LINUX_MANUAL_UPDATE_REQUIRED',
            error: LINUX_MANUAL_UPDATE_MESSAGE,
            releasesUrl: LINUX_RELEASES_URL
        };
    }

    async openReleasesPage() {
        try {
            await shell.openExternal(LINUX_RELEASES_URL);
            return { success: true, releasesUrl: LINUX_RELEASES_URL };
        } catch (error) {
            logger.error('打开 GitHub Releases 失败:', error);
            return { success: false, error: error.message, releasesUrl: LINUX_RELEASES_URL };
        }
    }
}

module.exports = AppUpdater;
module.exports.getUpdatePolicy = getUpdatePolicy;
module.exports.LINUX_MANUAL_UPDATE_MESSAGE = LINUX_MANUAL_UPDATE_MESSAGE;
module.exports.LINUX_RELEASES_URL = LINUX_RELEASES_URL;
