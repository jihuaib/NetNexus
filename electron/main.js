const { app, BrowserWindow, ipcMain, Tray } = require('electron');
const path = require('path');
const SystemApp = require('./app/systemApp');
const logger = require('./log/logger');
const { getIconPath, getTrayIconPath } = require('./utils/iconUtils');

const isDev = !app.isPackaged;
const isPackagedE2e = app.isPackaged && process.env.NETNEXUS_E2E === '1';
let mainWindow = null;
let splashWindow = null;
let systemApp = null;
let tray = null;
let splashProgress = 0;

app.commandLine.appendSwitch('lang', 'zh-CN');

if (isPackagedE2e) {
    app.setPath('userData', path.join(app.getPath('temp'), 'netnexus-e2e', String(process.pid)));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (hasSingleInstanceLock) {
    app.on('second-instance', () => {
        if (!mainWindow) {
            return;
        }
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();
    });
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
        transparent: true,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'splashPreload.js')
        }
    });

    splashWindow = splash;
    await splash.loadFile(path.join(__dirname, 'splash.html'));
    return splash;
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
    const urlLocation = isDev ? 'http://127.0.0.1:3000' : `file://${path.join(__dirname, '../dist/index.html')}`;
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
            win.destroy();
            return;
        }

        const closeOk = await systemApp.handleWindowClose();
        if (!closeOk) {
            return;
        }

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

function waitForRendererReady(win) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const channel = 'app:renderer-ready';
        const cleanup = () => {
            ipcMain.removeListener(channel, onReady);
            win.removeListener('closed', onClosed);
            win.webContents.removeListener('render-process-gone', onRenderProcessGone);
        };
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve();
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
                finish();
            }
        };
        const onClosed = () => fail(new Error('主窗口已关闭'));
        const onRenderProcessGone = (_event, details) => {
            fail(new Error(`渲染进程退出: ${details.reason}`));
        };

        ipcMain.on(channel, onReady);
        win.once('closed', onClosed);
        win.webContents.once('render-process-gone', onRenderProcessGone);
    });
}

// 更新启动进度
function updateSplashProgress(progress, text) {
    if (splashWindow && !splashWindow.isDestroyed()) {
        const normalizedProgress = Math.max(splashProgress, Math.min(100, Math.max(0, Number(progress) || 0)));
        splashProgress = normalizedProgress;
        splashWindow.webContents.send('startup-progress', {
            progress: normalizedProgress,
            text: text || ''
        });
    }
}

// 完成启动，显示主窗口
function finishStartup() {
    if (mainWindow && !mainWindow.isDestroyed()) {
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
    if (isPackagedE2e) {
        createWindow();
        await mainWindow.startupLoadPromise;
        return;
    }

    // 创建启动窗口
    await createSplashWindow();
    updateSplashProgress(10, '正在初始化应用...');

    createTray();
    updateSplashProgress(15, '正在初始化托盘...');

    createWindow();
    updateSplashProgress(25, '正在创建主窗口...');

    app.on('activate', () => {
        // macOS: 点击 dock 图标时，如果没有窗口则重新创建
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
            if (mainWindow) {
                mainWindow.show();
                mainWindow.focus();
            }
        } else if (mainWindow) {
            // 窗口存在但可能被隐藏，重新显示
            mainWindow.show();
            mainWindow.focus();
        }
    });

    // 启动应用
    systemApp = new SystemApp(ipcMain, mainWindow, updateSplashProgress);
    updateSplashProgress(35, '正在初始化主进程服务...');

    // 兼容性检查
    updateSplashProgress(40, '正在检查版本兼容性...');
    const checkVersionOk = systemApp.checkVersionCompatibility();
    if (!checkVersionOk) {
        if (splashWindow) splashWindow.close();
        app.quit();
        return;
    }
    updateSplashProgress(45, '版本兼容性检查完成');

    // 加载设置
    await systemApp.loadSettings();

    updateSplashProgress(82, '正在加载主窗口资源...');
    await mainWindow.startupLoadPromise;

    updateSplashProgress(92, '正在等待页面渲染...');
    await mainWindow.startupRendererReadyPromise;

    updateSplashProgress(100, '启动完成');

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
            updateSplashProgress(splashProgress, `启动失败: ${error.message}`);
        });
}

app.on('before-quit', () => {
    if (tray) {
        tray.destroy();
        tray = null;
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
