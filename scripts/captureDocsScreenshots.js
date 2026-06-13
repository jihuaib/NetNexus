const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const SystemApp = require('../electron/app/systemApp');

const BASE_URL = process.env.NETNEXUS_DOCS_URL || 'http://127.0.0.1:3000';
const OUTPUT_ROOT = path.join(__dirname, '..');
const BMP_DOCS_PORT = Number(process.env.NETNEXUS_DOCS_BMP_PORT || 1790);
const BMP_DOCS_ROUTES = Number(process.env.NETNEXUS_DOCS_BMP_ROUTES || 25);
const BMP_DRAFT_20 = 20;
const BMP_PATH_MARKING_TLV_DRAFT_20 = 8;
const DEFAULT_WINDOW_WIDTH = 1920;
const DEFAULT_WINDOW_HEIGHT = 1200;

const screenshots = [
    ['/bgp/bgp-config', 'docs/images/bgp/bgp-config.png'],
    ['/bgp/bgp-peer-config', 'docs/images/bgp/bgp-peer.png'],
    ['/bgp/route-ipv4', 'docs/images/bgp/bgp-route.png'],
    ['/bgp/route-ipv6', 'docs/images/bgp/bgp-route-ipv6.png'],
    ['/bgp/route-mvpn', 'docs/images/bgp/bgp-route-mvpn.png'],
    ['/bgp/route-ipv4-qp', 'docs/images/bgp/bgp-route-ipv4-qp.png'],
    ['/bgp/route-ipv6-qp', 'docs/images/bgp/bgp-route-ipv6-qp.png'],
    ['/bmp/bmp-config', 'docs/images/bmp/bmp-config-and-client-info.png'],
    ['/bmp/bgp-session', 'docs/images/bmp/bmp-client-and-bgp-monitor-peer-info.png'],
    ['/bmp/bgp-loc-rib', 'docs/images/bmp/bmp-monitor-bgp-route.png'],
    ['/bmp/bgp-session-statis-report', 'docs/images/bmp/bmp-session-statis-report.png'],
    ['/bmp/bgp-loc-rib-statis-report', 'docs/images/bmp/bmp-loc-rib-statis-report.png'],
    ['/rpki/rpki-config', 'docs/images/rpki/rpki-config-and-client.png'],
    ['/rpki/rpki-roa-config', 'docs/images/rpki/rpki-roa.png'],
    ['/rpki/rpki-aspa-config', 'docs/images/rpki/rpki-aspa.png'],
    ['/snmp/snmp-config', 'docs/images/snmp/snmp-config.png'],
    ['/snmp/snmp-trap', 'docs/images/snmp/snmp-trap.png'],
    ['/snmp/snmp-mib', 'docs/images/snmp/snmp-mib.png'],
    ['/ftp/ftp-config', 'docs/images/ftp/ftp-config-and-client.png'],
    ['/dhcp/dhcp-config', 'docs/images/dhcp/dhcp-config.png'],
    ['/dhcp/dhcp-lease', 'docs/images/dhcp/dhcp-lease-list.png'],
    ['/ntp/ntp-config', 'docs/images/ntp/ntp-config.png'],
    ['/ntp/ntp-request-log', 'docs/images/ntp/ntp-request-log.png'],
    ['/tftp/tftp-config', 'docs/images/tftp/tftp-config.png'],
    ['/tftp/tftp-transfer-log', 'docs/images/tftp/tftp-transfer-log.png'],
    ['/tools/string-generator', 'docs/images/tools/tools_string_generator.png'],
    ['/tools/packet-parser', 'docs/images/tools/tools_packet_parser.png'],
    ['/tools/port-monitor', 'docs/images/tools/tools_port_monitor.png'],
    ['/tools/network-info', 'docs/images/tools/tools_network_info.png'],
    ['/tools/http-api-tester', 'docs/images/tools/tools_http_api_tester.png'],
    ['/tools/tcp-ao-mac', 'docs/images/tools/tools_tcp_ao_mac.png']
];

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parsePositiveInteger(value, defaultValue) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function getCaptureWindowSize() {
    const { width: workAreaWidth, height: workAreaHeight } = screen.getPrimaryDisplay().workAreaSize;
    const defaultWidth = Math.max(DEFAULT_WINDOW_WIDTH, workAreaWidth);
    const defaultHeight = Math.max(DEFAULT_WINDOW_HEIGHT, workAreaHeight);
    return {
        width: parsePositiveInteger(process.env.NETNEXUS_DOCS_WINDOW_WIDTH, defaultWidth),
        height: parsePositiveInteger(process.env.NETNEXUS_DOCS_WINDOW_HEIGHT, defaultHeight)
    };
}

async function waitForRendererReady(win) {
    await new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            ipcMain.removeListener('app:renderer-ready', onReady);
            resolve();
        };
        const onReady = event => {
            if (event.sender === win.webContents) {
                finish();
            }
        };
        const timer = setTimeout(finish, 5000);
        ipcMain.on('app:renderer-ready', onReady);
    });
}

async function waitForRoute(win, route) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const currentHash = await win.webContents.executeJavaScript('window.location.hash');
        if (currentHash === `#${route}`) {
            return;
        }
        await wait(100);
    }
}

async function navigateAndCapture(win, route, outputPath) {
    await win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(route)}`);
    await waitForRoute(win, route);
    await wait(1300);
    await capturePage(win, route, outputPath);
}

async function capturePage(win, label, outputPath) {
    await win.webContents.executeJavaScript('document.fonts && document.fonts.ready');
    await win.webContents.executeJavaScript(`
        document.querySelectorAll('.ant-message, .ant-notification, .update-notification').forEach(element => {
            element.remove();
        });
    `);
    const image = await win.capturePage();
    const absoluteOutputPath = path.join(OUTPUT_ROOT, outputPath);
    await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
    await fs.writeFile(absoluteOutputPath, image.toPNG());
    console.log(`captured ${label} -> ${outputPath}`);
}

async function selectSettingsCategory(win, categoryText) {
    await win.webContents.executeJavaScript(`
        (() => {
            const categoryText = ${JSON.stringify(categoryText)};
            const items = Array.from(document.querySelectorAll('.settings-dialog-modal .ant-menu-item'));
            const item = items.find(element => element.textContent.includes(categoryText));
            if (!item) {
                throw new Error('settings category not found: ' + categoryText);
            }
            item.click();
        })()
    `);
    await wait(600);
}

async function openSettingsDialog(win) {
    await win.webContents.executeJavaScript(`
        (() => {
            const button = document.querySelector('.bottom-menu-btn button');
            if (!button) {
                throw new Error('settings menu button not found');
            }
            button.click();
        })()
    `);
    await wait(300);
    await win.webContents.executeJavaScript(`
        (() => {
            const items = Array.from(document.querySelectorAll('.ant-dropdown .ant-dropdown-menu-item'));
            const item = items.find(element => element.textContent.includes('设置'));
            if (!item) {
                throw new Error('settings menu item not found');
            }
            item.click();
        })()
    `);
    await wait(800);
}

async function closeSettingsDialog(win) {
    await win.webContents.executeJavaScript(`
        document.querySelector('.settings-dialog-modal .ant-modal-close')?.click();
    `);
    await wait(300);
}

async function captureSettingsScreenshots(win) {
    await win.webContents.executeJavaScript(`window.location.hash = '/tools/string-generator'`);
    await waitForRoute(win, '/tools/string-generator');
    await wait(800);
    await openSettingsDialog(win);
    await selectSettingsCategory(win, '通用设置');
    await capturePage(win, 'settings/general', 'docs/images/setting/setting.png');
    await selectSettingsCategory(win, '应用更新');
    await capturePage(win, 'settings/update', 'docs/images/setting/setting-updater.png');
    await closeSettingsDialog(win);
}

function assertSuccess(result, action) {
    if (!result || result.status !== 'success') {
        throw new Error(`${action} failed: ${result?.msg || 'unknown error'}`);
    }
}

async function startBmpForDocs(win) {
    const config = {
        port: `${BMP_DOCS_PORT}`,
        bmpV4TlvDraft: BMP_DRAFT_20,
        pathMarkingTlvType: BMP_PATH_MARKING_TLV_DRAFT_20,
        enableAuth: false,
        localPort: '',
        peerIP: '',
        md5Password: ''
    };

    const result = await win.webContents.executeJavaScript(`
        (async () => {
            const config = ${JSON.stringify(config)};
            const saveResult = await window.bmpApi.saveBmpConfig(config);
            if (!saveResult || saveResult.status !== 'success') {
                return saveResult;
            }
            return window.bmpApi.startBmp(config);
        })()
    `);
    assertSuccess(result, 'start BMP for docs screenshots');
    console.log(`started BMP server for docs screenshots on 127.0.0.1:${BMP_DOCS_PORT}`);
}

function startMockBmpClient() {
    const nodePath = process.env.NETNEXUS_NODE || process.env.npm_node_execpath || 'node';
    const mockScriptPath = path.join(__dirname, 'mockBmpClient.js');
    const args = [
        mockScriptPath,
        '--host',
        '127.0.0.1',
        '--port',
        `${BMP_DOCS_PORT}`,
        '--routes',
        `${BMP_DOCS_ROUTES}`,
        '--interval',
        '1'
    ];
    const child = spawn(nodePath, args, {
        cwd: OUTPUT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('mock BMP client did not finish sending data in time'));
        }, 15000);

        const handleOutput = data => {
            output += data.toString();
            if (output.includes('mock data sent; keeping BMP TCP connection open')) {
                clearTimeout(timeout);
                resolve();
            }
        };

        child.stdout.on('data', data => {
            process.stdout.write(data);
            handleOutput(data);
        });
        child.stderr.on('data', data => {
            process.stderr.write(data);
            output += data.toString();
        });
        child.once('error', error => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once('exit', code => {
            clearTimeout(timeout);
            if (!output.includes('mock data sent; keeping BMP TCP connection open')) {
                reject(new Error(`mock BMP client exited before data was ready, code ${code}`));
            }
        });
    });

    return { child, ready };
}

async function stopMockBmpClient(child) {
    if (!child || child.exitCode !== null) {
        return;
    }

    child.kill('SIGINT');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        wait(1000)
    ]);

    if (child.exitCode === null) {
        child.kill('SIGTERM');
    }
}

async function waitForBmpMockData(win) {
    const deadline = Date.now() + 15000;
    let lastState = null;

    while (Date.now() < deadline) {
        lastState = await win.webContents.executeJavaScript(`
            (async () => {
                const clientsResult = await window.bmpApi.getClientList();
                const clients = clientsResult?.status === 'success' && Array.isArray(clientsResult.data)
                    ? clientsResult.data
                    : [];
                const state = {
                    ready: false,
                    clients: clients.length,
                    sessions: 0,
                    sessionRoutes: 0,
                    instances: 0,
                    instanceRoutes: 0,
                    sessionStats: 0,
                    instanceStats: 0
                };
                if (clients.length === 0) {
                    return state;
                }

                const client = clients[0];
                const sessionsResult = await window.bmpApi.getBgpSessions(client);
                const sessions = sessionsResult?.status === 'success' && Array.isArray(sessionsResult.data)
                    ? sessionsResult.data
                    : [];
                state.sessions = sessions.length;
                if (sessions.length > 0) {
                    const session = sessions[0];
                    const af = Array.isArray(session.enabledAddrFamilyTypes) ? session.enabledAddrFamilyTypes[0] : null;
                    const ribType = Array.isArray(session.ribTypes) ? session.ribTypes[0] : null;
                    if (af !== null && af !== undefined && ribType !== null && ribType !== undefined) {
                        const routesResult = await window.bmpApi.getBgpRoutes(
                            client,
                            session,
                            af,
                            ribType,
                            1,
                            25,
                            'all',
                            ''
                        );
                        state.sessionRoutes = routesResult?.data?.total || 0;
                    }
                }

                const instancesResult = await window.bmpApi.getBgpInstances(client);
                const instances = instancesResult?.status === 'success' && Array.isArray(instancesResult.data)
                    ? instancesResult.data
                    : [];
                state.instances = instances.length;
                if (instances.length > 0) {
                    const routesResult = await window.bmpApi.getBgpInstanceRoutes(
                        client,
                        instances[0],
                        1,
                        25,
                        'all',
                        ''
                    );
                    state.instanceRoutes = routesResult?.data?.total || 0;
                }

                const sessionStatsResult = await window.bmpApi.getBgpStatisticsReports(client);
                state.sessionStats =
                    sessionStatsResult?.status === 'success' && Array.isArray(sessionStatsResult.data)
                        ? sessionStatsResult.data.length
                        : 0;
                const instanceStatsResult = await window.bmpApi.getBgpInstanceStatisticsReports(client);
                state.instanceStats =
                    instanceStatsResult?.status === 'success' && Array.isArray(instanceStatsResult.data)
                        ? instanceStatsResult.data.length
                        : 0;

                state.ready =
                    state.clients > 0 &&
                    state.sessions > 0 &&
                    state.sessionRoutes > 0 &&
                    state.instances > 0 &&
                    state.instanceRoutes > 0 &&
                    state.sessionStats > 0 &&
                    state.instanceStats > 0;
                return state;
            })()
        `);

        if (lastState.ready) {
            console.log(`BMP mock data ready: ${JSON.stringify(lastState)}`);
            return;
        }

        await wait(300);
    }

    throw new Error(`BMP mock data was not ready: ${JSON.stringify(lastState)}`);
}

async function run() {
    app.commandLine.appendSwitch('disable-gpu');
    app.setPath('userData', path.join(os.tmpdir(), 'netnexus-docs-screenshots'));

    await app.whenReady();

    const { width, height } = getCaptureWindowSize();
    const win = new BrowserWindow({
        width,
        height,
        useContentSize: true,
        show: false,
        backgroundColor: '#ffffff',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../electron/preload.js')
        }
    });
    console.log(`docs screenshot viewport: ${width}x${height}`);

    const systemApp = new SystemApp(ipcMain, win, null);
    await systemApp.loadSettings();

    await win.loadURL(`${BASE_URL}/#/tools/string-generator`);
    await waitForRendererReady(win);
    await wait(900);

    let mockProcess = null;
    try {
        await startBmpForDocs(win);
        const mock = startMockBmpClient();
        mockProcess = mock.child;
        await mock.ready;
        await waitForBmpMockData(win);

        for (const [route, outputPath] of screenshots) {
            await navigateAndCapture(win, route, outputPath);
        }
        await captureSettingsScreenshots(win);
    } finally {
        await stopMockBmpClient(mockProcess);
        if (systemApp.bmpApp.getBmpRunning()) {
            await win.webContents.executeJavaScript('window.bmpApi.stopBmp()');
        }
        await systemApp.handleWindowClose();
        win.destroy();
        app.quit();
    }
}

run().catch(error => {
    console.error(error);
    app.exit(1);
});
