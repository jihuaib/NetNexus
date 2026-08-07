const { app, BrowserWindow, ipcMain, Tray } = require('electron');
const path = require('path');
const logger = require('./log/logger');
const { getIconPath, getTrayIconPath } = require('./utils/iconUtils');
const { MonitorWindowManager } = require('./window/monitorWindowManager');

const isDev = !app.isPackaged;
const isPackagedE2e = app.isPackaged && process.env.NETNEXUS_E2E === '1';
const RENDERER_READY_TIMEOUT_MS = 15000;
const MIN_SPLASH_VISIBLE_MS = 900;
const SPLASH_BACKGROUND_COLOR = '#667eea';
let mainWindow = null;
let splashWindow = null;
let systemApp = null;
let tray = null;
let splashProgress = 0;
let splashShownAt = 0;
let startupComplete = false;
let allowQuitAfterStorageClose = false;
let storageCloseForQuitPromise = null;
let monitorWindowManager = null;

app.commandLine.appendSwitch('lang', 'zh-CN');

if (isPackagedE2e) {
    app.setPath('userData', path.join(app.getPath('temp'), 'netnexus-e2e', String(process.pid)));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (hasSingleInstanceLock) {
    app.on('second-instance', () => {
        focusAvailableWindow();
    });
}

function focusAvailableWindow() {
    if (!startupComplete && splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.show();
        splashWindow.focus();
        return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }
    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
}

async function createSplashWindow() {
    // 计算 splash 窗口在工作区域内的居中位置
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const workArea = primaryDisplay.workArea;
    const splashWidth = 600;
    const splashHeight = 500;
    const x = Math.round(workArea.x + (workArea.width - splashWidth) / 2);
    const y = Math.round(workArea.y + (workArea.height - splashHeight) / 2);

    const splash = new BrowserWindow({
        width: splashWidth,
        height: splashHeight,
        x: x,
        y: y,
        // Windows 对长时间存在的透明无框窗口可能生成拉伸、模糊的合成画面。
        // splash 页面本身已有完整不透明背景，因此不需要使用透明分层窗口。
        transparent: false,
        backgroundColor: SPLASH_BACKGROUND_COLOR,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'splashPreload.js')
        }
    });

    const readyToShow = new Promise(resolve => splash.once('ready-to-show', resolve));
    splashWindow = splash;
    splash.once('closed', () => {
        if (splashWindow === splash) {
            splashWindow = null;
        }
    });
    await splash.loadFile(path.join(__dirname, 'splash.html'));
    await readyToShow;
    if (!splash.isDestroyed()) {
        splashShownAt = Date.now();
        splash.show();
        splash.focus();
    }
    return splash;
}

function getRendererUrl() {
    return isDev ? 'http://127.0.0.1:3000' : `file://${path.join(__dirname, '../dist/index.html')}`;
}

function initializeMonitorWindowManager() {
    if (monitorWindowManager) {
        return monitorWindowManager;
    }

    monitorWindowManager = new MonitorWindowManager({
        rendererUrl: getRendererUrl(),
        preloadPath: path.join(__dirname, 'preload.js'),
        icon: getIconPath(),
        isPackagedE2e
    });
    monitorWindowManager.registerIpcHandlers(ipcMain);
    return monitorWindowManager;
}

function createWindow() {
    const webPreferences = {
        nodeIntegration: false, // 禁用 nodeIntegration 提高安全性
        contextIsolation: true // 启用 contextIsolation 更好地隔离上下文
    };

    if (!isPackagedE2e) {
        webPreferences.preload = path.join(__dirname, 'preload.js');
    }

    const win = new BrowserWindow({
        width: 1000,
        height: 800,
        minWidth: 1000,
        minHeight: 800,
        resizable: true,
        maximizable: true,
        fullscreen: false,
        autoHideMenuBar: true,
        frame: true,
        backgroundColor: '#ffffff',
        show: isPackagedE2e,
        icon: getIconPath(),
        webPreferences
    });

    logger.info(`Dev ${isDev} E2E ${isPackagedE2e} __dirname ${__dirname}`);
    const urlLocation = getRendererUrl();
    win.startupRendererReadyPromise = isPackagedE2e ? Promise.resolve() : waitForRendererReady(win);
    if (!isPackagedE2e) {
        win.startupRendererReadyPromise.catch(error => logger.error(`渲染进程就绪等待失败: ${error.message}`));
    }
    win.startupLoadPromise = win.loadURL(urlLocation);
    win.startupLoadPromise.catch(error => logger.error(`主窗口加载失败: ${error.message}`));

    // 监听窗口关闭事件
    win.on('close', async event => {
        if (isPackagedE2e) {
            return;
        }

        event.preventDefault();

        if (!systemApp) {
            monitorWindowManager?.closeAll();
            win.destroy();
            return;
        }

        const closeOk = await systemApp.handleWindowClose();
        if (!closeOk) {
            return;
        }

        monitorWindowManager?.closeAll();
        win.destroy();
    });

    // 窗口销毁后重置引用
    win.on('closed', () => {
        mainWindow = null;
    });

    mainWindow = win;

    if (isDev) {
        win.webContents.openDevTools();
    }
}

function createTray() {
    if (process.platform === 'darwin' || tray) {
        return;
    }

    tray = new Tray(getTrayIconPath());
    tray.setToolTip('NetNexus');
}

function waitForRendererReady(win, timeoutMs = RENDERER_READY_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId = null;
        const channel = 'app:renderer-ready';
        const cleanup = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            ipcMain.removeListener(channel, onReady);
            win.removeListener('closed', onClosed);
            win.webContents.removeListener('render-process-gone', onRenderProcessGone);
        };
        const finish = result => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(result);
        };
        const fail = error => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };
        const onReady = event => {
            if (event.sender === win.webContents) {
                finish({ source: 'renderer', timedOut: false });
            }
        };
        const onClosed = () => fail(new Error('主窗口已关闭'));
        const onRenderProcessGone = (_event, details) => {
            fail(new Error(`渲染进程退出: ${details.reason}`));
        };

        ipcMain.on(channel, onReady);
        win.once('closed', onClosed);
        win.webContents.once('render-process-gone', onRenderProcessGone);
        timeoutId = setTimeout(() => {
            finish({ source: 'timeout', timedOut: true });
        }, timeoutMs);
    });
}

// 更新启动进度
function updateSplashProgress(progress, text, state = 'active') {
    if (splashWindow && !splashWindow.isDestroyed()) {
        const normalizedProgress = Math.max(splashProgress, Math.min(100, Math.max(0, Number(progress) || 0)));
        splashProgress = normalizedProgress;
        splashWindow.webContents.send('startup-progress', {
            progress: normalizedProgress,
            text: text || '',
            state
        });
    }
}

function waitForMinimumSplashDuration() {
    const remaining = MIN_SPLASH_VISIBLE_MS - (Date.now() - splashShownAt);
    if (remaining <= 0) {
        return Promise.resolve();
    }
    return new Promise(resolve => setTimeout(resolve, remaining));
}

// 完成启动，显示主窗口
function finishStartup() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        startupComplete = true;
        // macOS 上使用工作区域大小，Windows/Linux 上直接最大化
        if (process.platform === 'darwin') {
            // macOS: 设置窗口大小为屏幕工作区域大小（排除菜单栏和 Dock）
            const { screen } = require('electron');
            const primaryDisplay = screen.getPrimaryDisplay();
            const workArea = primaryDisplay.workArea;
            // 先设置位置和大小（窗口仍然隐藏）
            mainWindow.setBounds({
                x: workArea.x,
                y: workArea.y,
                width: workArea.width,
                height: workArea.height
            });
        } else {
            mainWindow.maximize();
        }

        // 关闭 splash 窗口（使用 destroy 同步关闭）
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.destroy();
            splashWindow = null;
        }

        // 显示主窗口
        mainWindow.show();
        mainWindow.focus();
    }
}

async function startApplication() {
    initializeMonitorWindowManager();

    if (isPackagedE2e) {
        createWindow();
        await mainWindow.startupLoadPromise;
        return;
    }

    // 创建启动窗口
    await createSplashWindow();
    updateSplashProgress(5, '启动界面已显示');

    // SystemApp 会加载所有协议模块，必须放到 splash 首帧之后，避免点击应用后长时间没有任何反馈。
    updateSplashProgress(10, '正在加载核心组件...');
    // 先让首帧和 10% 状态提交给原生窗口；Windows 首次检查原生模块时可能耗时较长。
    await new Promise(resolve => setImmediate(resolve));
    const SystemApp = require('./app/systemApp');
    updateSplashProgress(18, '核心组件加载完成');

    updateSplashProgress(20, '正在初始化系统托盘...');
    createTray();
    updateSplashProgress(24, '系统托盘初始化完成');

    updateSplashProgress(26, '正在创建主窗口...');
    createWindow();
    updateSplashProgress(32, '主窗口创建完成');

    app.on('activate', () => {
        if (!startupComplete && splashWindow && !splashWindow.isDestroyed()) {
            focusAvailableWindow();
            return;
        }
        // macOS: 点击 dock 图标时，如果没有窗口则重新创建
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
            focusAvailableWindow();
        } else {
            focusAvailableWindow();
        }
    });

    // 启动应用
    updateSplashProgress(34, '正在注册主进程服务...');
    systemApp = new SystemApp(ipcMain, mainWindow, updateSplashProgress, { monitorWindowManager });
    updateSplashProgress(40, '主进程服务注册完成');

    // 兼容性检查
    updateSplashProgress(42, '正在检查版本兼容性...');
    const checkVersionOk = systemApp.checkVersionCompatibility(splashWindow);
    if (!checkVersionOk) {
        if (splashWindow) splashWindow.close();
        app.quit();
        return;
    }
    updateSplashProgress(48, '版本兼容性检查完成');

    // 加载设置
    await systemApp.loadSettings();

    updateSplashProgress(84, '正在加载主窗口资源...');
    await mainWindow.startupLoadPromise;
    updateSplashProgress(90, '主窗口资源加载完成');

    updateSplashProgress(92, '正在等待页面渲染...');
    const rendererReady = await mainWindow.startupRendererReadyPromise;
    if (rendererReady?.timedOut) {
        updateSplashProgress(98, '页面就绪检查超时，使用已加载页面继续', 'warning');
    } else {
        updateSplashProgress(98, '页面渲染完成');
    }

    updateSplashProgress(100, '启动完成');
    await waitForMinimumSplashDuration();

    // 完成启动
    finishStartup();
}

if (!hasSingleInstanceLock) {
    app.quit();
} else {
    app.whenReady()
        .then(startApplication)
        .catch(error => {
            logger.error(`应用启动失败: ${error.message}`);
            updateSplashProgress(splashProgress, `启动失败: ${error.message}`, 'error');
        });
}

app.on('before-quit', event => {
    if (tray) {
        tray.destroy();
        tray = null;
    }

    const rpkiApp = systemApp?.rpkiApp;
    if (allowQuitAfterStorageClose) {
        allowQuitAfterStorageClose = false;
        storageCloseForQuitPromise = null;
        return;
    }
    if (!rpkiApp?.closeStorage) {
        return;
    }

    event.preventDefault();
    if (!storageCloseForQuitPromise) {
        storageCloseForQuitPromise = rpkiApp
            .closeStorage()
            .catch(error => {
                logger.warn(`关闭RPKI SQLite存储失败: ${error.message}`);
            })
            .finally(() => {
                allowQuitAfterStorageClose = true;
                app.quit();
            });
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
