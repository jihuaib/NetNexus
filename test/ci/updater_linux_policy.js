const assert = require('assert');
const Module = require('module');

const updaterCalls = {
    listeners: [],
    checks: 0,
    downloads: 0,
    installs: 0,
    openedUrls: []
};

const fakeAutoUpdater = {
    on(eventName) {
        updaterCalls.listeners.push(eventName);
    },
    async checkForUpdates() {
        updaterCalls.checks += 1;
    },
    async downloadUpdate() {
        updaterCalls.downloads += 1;
    },
    quitAndInstall() {
        updaterCalls.installs += 1;
    }
};

class FakeEventDispatcher {
    setWebContents(webContents) {
        this.webContents = webContents;
    }

    emit() {}
}

const fakeLogger = {
    info() {},
    warn() {},
    error() {},
    raw() {
        return {};
    }
};

const originalLoad = Module._load;
Module._load = function loadUpdaterWithStubs(request, parent, isMain) {
    if (request === 'electron-updater') return { autoUpdater: fakeAutoUpdater };
    if (request === 'electron-updater/out/providers/Provider') return { parseVersion: value => value };
    if (request === 'electron') {
        return {
            app: {
                isPackaged: true,
                getVersion: () => '5.0.2-test'
            },
            shell: {
                openExternal: async url => updaterCalls.openedUrls.push(url)
            }
        };
    }
    if (request === '../log/logger') return fakeLogger;
    if (request === '../utils/eventDispatcher') return FakeEventDispatcher;
    return originalLoad.call(this, request, parent, isMain);
};

let AppUpdater;
try {
    AppUpdater = require('../../electron/app/updater');
} finally {
    Module._load = originalLoad;
}

async function main() {
    const handlers = new Map();
    const ipc = {
        handle(channel, handler) {
            handlers.set(channel, handler);
        }
    };
    const updater = new AppUpdater(ipc, { webContents: {} });

    assert.deepStrictEqual([...handlers.keys()].sort(), [
        'updater:checkForUpdates',
        'updater:downloadUpdate',
        'updater:getCurrentVersion',
        'updater:getUpdatePolicy',
        'updater:openReleasesPage',
        'updater:quitAndInstall'
    ]);
    assert.deepStrictEqual(updaterCalls.listeners, [], 'Linux must not attach automatic updater listeners');

    const policy = await handlers.get('updater:getUpdatePolicy')();
    assert.deepStrictEqual(policy, {
        platform: 'linux',
        mode: 'manual-deb',
        automaticUpdatesSupported: false,
        message: 'Linux 请从 GitHub Releases 下载并用 apt 安装 .deb',
        releasesUrl: 'https://github.com/jihuaib/NetNexus/releases'
    });

    const originalSetTimeout = global.setTimeout;
    let scheduledChecks = 0;
    global.setTimeout = () => {
        scheduledChecks += 1;
    };
    try {
        updater.updateSettings({ autoCheckOnStartup: true, autoDownload: true });
    } finally {
        global.setTimeout = originalSetTimeout;
    }
    assert.strictEqual(scheduledChecks, 0, 'Linux startup must not schedule update checks');

    for (const channel of ['updater:checkForUpdates', 'updater:downloadUpdate', 'updater:quitAndInstall']) {
        const result = await handlers.get(channel)();
        assert.deepStrictEqual(result, {
            success: false,
            code: 'LINUX_MANUAL_UPDATE_REQUIRED',
            error: 'Linux 请从 GitHub Releases 下载并用 apt 安装 .deb',
            releasesUrl: 'https://github.com/jihuaib/NetNexus/releases'
        });
    }
    assert.deepStrictEqual(
        { checks: updaterCalls.checks, downloads: updaterCalls.downloads, installs: updaterCalls.installs },
        { checks: 0, downloads: 0, installs: 0 },
        'Linux manual-update responses must not call electron-updater'
    );

    assert.strictEqual(await handlers.get('updater:getCurrentVersion')(), '5.0.2-test');
    assert.deepStrictEqual(await handlers.get('updater:openReleasesPage')(), {
        success: true,
        releasesUrl: 'https://github.com/jihuaib/NetNexus/releases'
    });
    assert.deepStrictEqual(updaterCalls.openedUrls, ['https://github.com/jihuaib/NetNexus/releases']);

    for (const platform of ['win32', 'darwin']) {
        assert.deepStrictEqual(AppUpdater.getUpdatePolicy(platform), {
            platform,
            mode: 'automatic',
            automaticUpdatesSupported: true,
            message: '',
            releasesUrl: 'https://github.com/jihuaib/NetNexus/releases'
        });
    }

    console.log('Linux updater policy tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
