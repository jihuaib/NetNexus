const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

/**
 * 回归：macOS 上主窗口关闭后由 Dock 重新创建，SystemApp 仍持有已销毁窗口时，
 * "开发人员选项" 必须仍能打开当前窗口的 DevTools，且不能抛 "Object has been destroyed"。
 */
function loadSystemAppClass() {
    const originalLoad = Module._load;
    const warnings = [];
    const stubbedDependencies = new Set([
        './bgpApp',
        './toolsApp',
        './bmpApp',
        './rpkiApp',
        './ftpApp',
        './snmpApp',
        './dhcpApp',
        './ntpApp',
        './radiusApp',
        './tftpApp',
        './syslogApp',
        './grpcApp',
        './updater',
        './nativeApp',
        './externalApiServer',
        './cli',
        './wiresharkPluginInstaller'
    ]);
    class DummyDependency {}

    Module._load = function loadWithSystemAppStubs(request, parent, isMain) {
        if (request === 'electron') {
            return {
                app: { isPackaged: true, getPath: () => '/tmp/netnexus-devtools-test' },
                dialog: {},
                BrowserWindow: {}
            };
        }
        if (request === 'electron-store') {
            return DummyDependency;
        }
        if (request === '../log/logger') {
            return { info() {}, warn: message => warnings.push(message), error() {} };
        }
        if (request === './bmpApiRoutes') {
            return () => [];
        }
        if (stubbedDependencies.has(request)) {
            return DummyDependency;
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        return { SystemApp: require('../../electron/app/systemApp'), warnings };
    } finally {
        Module._load = originalLoad;
    }
}

function createWebContents(name) {
    const calls = [];
    let devToolsOpened = false;
    return {
        name,
        calls,
        destroyed: false,
        isDestroyed() {
            return this.destroyed;
        },
        isDevToolsOpened() {
            return devToolsOpened;
        },
        openDevTools(options) {
            if (this.destroyed) {
                throw new TypeError('Object has been destroyed');
            }
            devToolsOpened = true;
            calls.push(options && options.activate ? 'open' : 'open-inactive');
        },
        closeDevTools() {
            devToolsOpened = false;
            calls.push('close');
        }
    };
}

function createWindow(name) {
    const webContents = createWebContents(name);
    return {
        webContents,
        isDestroyed: () => webContents.destroyed
    };
}

function createHarness(SystemApp) {
    const systemApp = Object.create(SystemApp.prototype);
    const registered = new Map();
    const ipc = {
        on: (channel, handler) => registered.set(channel, handler),
        handle: (channel, handler) => registered.set(channel, handler)
    };
    systemApp.win = createWindow('first-main-window');
    systemApp.registerHandlers(ipc);
    return { systemApp, registered };
}

async function main() {
    const { SystemApp, warnings } = loadSystemAppClass();

    // 1. 正常情况：IPC 事件的 sender 就是当前窗口；已打开时重新打开并激活，确保可见
    {
        const { systemApp, registered } = createHarness(SystemApp);
        const handler = registered.get('common:openDeveloperOptions');
        assert.equal(typeof handler, 'function', 'common:openDeveloperOptions must be registered');
        const sender = systemApp.win.webContents;
        handler({ sender });
        assert.deepEqual(sender.calls, ['open']);
        handler({ sender });
        await new Promise(resolve => setTimeout(resolve, 1200));
        assert.deepEqual(
            sender.calls,
            ['open', 'close', 'open'],
            'second click must re-open and activate already-open DevTools (may be hidden behind the window)'
        );
    }

    // 2. 回归场景：旧主窗口已销毁，Dock 重建了新窗口，SystemApp.win 还没同步
    {
        const { systemApp, registered } = createHarness(SystemApp);
        const handler = registered.get('common:openDeveloperOptions');
        const staleWindow = systemApp.win;
        staleWindow.webContents.destroyed = true;
        const recreated = createWindow('recreated-main-window');

        assert.doesNotThrow(() => handler({ sender: recreated.webContents }));
        assert.deepEqual(recreated.webContents.calls, ['open'], 'DevTools must open on the sender webContents');
        assert.deepEqual(staleWindow.webContents.calls, [], 'destroyed window must not be touched');
    }

    // 3. 没有 sender 时回退到 this.win；setMainWindow 同步重建后的窗口
    {
        const { systemApp } = createHarness(SystemApp);
        const staleWindow = systemApp.win;
        staleWindow.webContents.destroyed = true;
        const recreated = createWindow('recreated-main-window');
        systemApp.setMainWindow(recreated);
        assert.equal(systemApp.win, recreated);
        systemApp.handleOpenDeveloperOptions();
        assert.deepEqual(recreated.webContents.calls, ['open']);
    }

    // 4. 所有窗口都不可用：只记录告警，不抛异常
    {
        const { systemApp } = createHarness(SystemApp);
        systemApp.win.webContents.destroyed = true;
        const before = warnings.length;
        assert.doesNotThrow(() => systemApp.handleOpenDeveloperOptions({ sender: { isDestroyed: () => true } }));
        assert.equal(warnings.length, before + 1, 'unavailable window must be logged as a warning');
    }

    // 5. main.js 重建主窗口后必须把新窗口同步给 SystemApp
    if (process.env.NETNEXUS_MINIFIED_CI !== '1') {
        const mainProcessSource = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');
        assert.match(
            mainProcessSource,
            /systemApp\.setMainWindow\(win\)/,
            'createWindow must hand the recreated main window to SystemApp'
        );
    }

    console.log('System developer-options window tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
