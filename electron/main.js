const { app, BrowserWindow, ipcMain, Tray } = require('electron');
const path = require('path');
const SystemApp = require('./app/systemApp');
const logger = require('./log/logger');
const { getIconPath, getTrayIconPath } = require('./utils/iconUtils');

const isDev = !app.isPackaged;
let mainWindow = null;
let splashWindow = null;
let systemApp = null;
let tray = null;

app.commandLine.appendSwitch('lang', 'zh-CN');

function createSplashWindow() {
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
            contextIsolation: true
        }
    });

    splash.loadFile(path.join(__dirname, 'splash.html'));
    splashWindow = splash;
    return splash;
}

function createWindow() {
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
        show: false, // 关键：先隐藏窗口
        icon: getIconPath(),
        webPreferences: {
            nodeIntegration: false, // 禁用 nodeIntegration 提高安全性
            contextIsolation: true, // 启用 contextIsolation 更好地隔离上下文
            preload: path.join(__dirname, 'preload.js')
        }
    });

    logger.info(`Dev ${isDev} __dirname ${__dirname}`);
    const urlLocation = isDev ? 'http://127.0.0.1:3000' : `file://${path.join(__dirname, '../dist/index.html')}`;
    win.loadURL(urlLocation);

    // 监听窗口关闭事件
    win.on('close', async event => {
        event.preventDefault();

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

// 更新启动进度
function updateSplashProgress(progress, text) {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.webContents.executeJavaScript(`window.updateProgress(${progress}, '${text}')`);
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

app.whenReady().then(async () => {
    // 创建启动窗口
    createSplashWindow();
    updateSplashProgress(10, '正在初始化应用...');

    // 延迟创建主窗口，让启动窗口先显示
    await new Promise(resolve => setTimeout(resolve, 1000));

    createTray();
    createWindow();
    updateSplashProgress(20, '正在加载主窗口...');

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
    updateSplashProgress(30, '正在检查版本兼容性...');

    // 兼容性检查
    const checkVersionOk = systemApp.checkVersionCompatibility();
    if (!checkVersionOk) {
        if (splashWindow) splashWindow.close();
        app.quit();
        return;
    }

    updateSplashProgress(50, '正在加载设置...');
    // 加载设置
    await systemApp.loadSettings();

    updateSplashProgress(80, '正在初始化服务...');
    // 等待主窗口内容加载完成
    await new Promise(resolve => setTimeout(resolve, 500));

    updateSplashProgress(100, '启动完成');
    // 延迟一下让用户看到100%
    await new Promise(resolve => setTimeout(resolve, 300));

    // 完成启动
    finishStartup();
});

app.on('before-quit', () => {
    if (tray) {
        tray.destroy();
        tray = null;
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
