const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const SystemApp = require('../electron/app/systemApp');
const BgpConst = require('../electron/const/bgpConst');
const { MonitorWindowManager } = require('../electron/window/monitorWindowManager');
const { MockNetconfServer } = require('./mockNetconfServer');

const BASE_URL = process.env.NETNEXUS_DOCS_URL || 'http://127.0.0.1:3000';
const OUTPUT_ROOT = path.join(__dirname, '..');
const NODE_PATH = process.env.NETNEXUS_NODE || process.env.npm_node_execpath || 'node';
const SCREENSHOT_SCOPE = String(process.env.NETNEXUS_DOCS_SCREENSHOT_SCOPE || '')
    .trim()
    .toLowerCase();
const SCREENSHOT_MATCH = String(process.env.NETNEXUS_DOCS_SCREENSHOT_MATCH || '').trim();
const BGP_DOCS_PORT = Number(process.env.NETNEXUS_DOCS_BGP_PORT || 11790);
const BMP_DOCS_PORT = Number(process.env.NETNEXUS_DOCS_BMP_PORT || 1790);
const BMP_DOCS_ROUTES = Number(process.env.NETNEXUS_DOCS_BMP_ROUTES || 25);
const RPKI_DOCS_PORT = Number(process.env.NETNEXUS_DOCS_RPKI_PORT || 11280);
const FTP_DOCS_PORT = Number(process.env.NETNEXUS_DOCS_FTP_PORT || 10021);
const SNMP_DOCS_TRAP_PORT = Number(process.env.NETNEXUS_DOCS_SNMP_TRAP_PORT || 10162);
const SNMP_DOCS_QUERY_PORT = Number(process.env.NETNEXUS_DOCS_SNMP_QUERY_PORT || 10161);
const DHCP_DOCS_PORT = Number(process.env.NETNEXUS_DOCS_DHCP_PORT || 1067);
const DHCP6_DOCS_PORT = Number(process.env.NETNEXUS_DOCS_DHCP6_PORT || 1547);
const NTP_DOCS_PORT = Number(process.env.NETNEXUS_DOCS_NTP_PORT || 10123);
const RADIUS_DOCS_AUTH_PORT = Number(process.env.NETNEXUS_DOCS_RADIUS_AUTH_PORT || 11812);
const RADIUS_DOCS_ACCOUNTING_PORT = Number(process.env.NETNEXUS_DOCS_RADIUS_ACCOUNTING_PORT || 11813);
const RADIUS_DOCS_COA_PORT = Number(process.env.NETNEXUS_DOCS_RADIUS_COA_PORT || 13799);
const TFTP_DOCS_PORT = Number(process.env.NETNEXUS_DOCS_TFTP_PORT || 10069);
const SYSLOG_DOCS_PORT = Number(process.env.NETNEXUS_DOCS_SYSLOG_PORT || 1514);
const TCP_TOOL_DOCS_PORT = Number(process.env.NETNEXUS_DOCS_TCP_TOOL_PORT || 19000);
const UDP_TOOL_DOCS_PORT = Number(process.env.NETNEXUS_DOCS_UDP_TOOL_PORT || 9000);
const TCP_TOOL_DOCS_PAYLOAD = 'NetNexus TCP demo payload';
const UDP_TOOL_DOCS_PAYLOAD = 'NetNexus UDP demo payload';
const BMP_DRAFT_20 = 20;
const BMP_PATH_MARKING_TLV_DRAFT_20 = 8;
const BMP_ROUTE_LENS_QUERY = '203.0.120.1';
const BMP_CLIENT_KEY_PLACEHOLDER = '__BMP_CLIENT_KEY__';
const DEFAULT_WINDOW_WIDTH = 1920;
const DEFAULT_WINDOW_HEIGHT = 1200;
const STARTUP_BANNER_WIDTH = 600;
const STARTUP_BANNER_HEIGHT = 500;
let bmpDocsClientKey = '';
let netconfDocsMockServer = null;
let yangDocsContext = null;

const screenshots = [
    {
        kind: 'startup',
        outputPath: 'docs/images/startup/startup-banner.png'
    },
    ['/bgp/bgp-config', 'docs/images/bgp/bgp-config.png'],
    ['/bgp/bgp-peer-config', 'docs/images/bgp/bgp-peer.png'],
    ['/bgp/route-ipv4', 'docs/images/bgp/bgp-route.png'],
    {
        route: '/bgp/route-ipv4',
        outputPath: 'docs/images/bgp/bgp-routeviews-import.png',
        prepare: 'open-routeviews-import',
        cleanup: 'close-overlay'
    },
    {
        route: '/bgp/route-ipv4',
        outputPath: 'docs/images/bgp/bgp-route-advanced-config.png',
        prepare: 'open-route-advanced-config',
        cleanup: 'close-overlay'
    },
    {
        route: '/bgp/route-ipv4',
        outputPath: 'docs/images/bgp/bgp-route-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    ['/bgp/route-ipv6', 'docs/images/bgp/bgp-route-ipv6.png'],
    {
        route: '/bgp/route-ipv6',
        outputPath: 'docs/images/bgp/bgp-route-ipv6-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    ['/bgp/route-mvpn', 'docs/images/bgp/bgp-route-mvpn.png'],
    {
        route: '/bgp/route-mvpn',
        outputPath: 'docs/images/bgp/bgp-route-mvpn-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    ['/bgp/route-ipv4-qp', 'docs/images/bgp/bgp-route-ipv4-qp.png'],
    {
        route: '/bgp/route-ipv4-qp',
        outputPath: 'docs/images/bgp/bgp-route-ipv4-qp-advanced-config.png',
        prepare: 'open-route-advanced-config',
        cleanup: 'close-overlay'
    },
    {
        route: '/bgp/route-ipv4-qp',
        outputPath: 'docs/images/bgp/bgp-route-ipv4-qp-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    ['/bgp/route-ipv6-qp', 'docs/images/bgp/bgp-route-ipv6-qp.png'],
    {
        route: '/bgp/route-ipv6-qp',
        outputPath: 'docs/images/bgp/bgp-route-ipv6-qp-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    ['/bmp/bmp-config', 'docs/images/bmp/bmp-config-and-client-info.png'],
    {
        route: '/bmp/bmp-config',
        outputPath: 'docs/images/bmp/bmp-client-detail.png',
        prepare: 'open-bmp-client-detail',
        cleanup: 'close-overlay'
    },
    [
        `/monitor/bmp-client?clientKey=${BMP_CLIENT_KEY_PLACEHOLDER}&view=session`,
        'docs/images/bmp/bmp-client-and-bgp-monitor-peer-info.png'
    ],
    {
        route: `/monitor/bmp-client?clientKey=${BMP_CLIENT_KEY_PLACEHOLDER}&view=session`,
        outputPath: 'docs/images/bmp/bmp-session-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    {
        route: `/monitor/bmp-client?clientKey=${BMP_CLIENT_KEY_PLACEHOLDER}&view=session`,
        outputPath: 'docs/images/bmp/bmp-session-route-detail.png',
        prepare: 'open-bmp-session-route-detail',
        cleanup: 'close-overlay'
    },
    [
        `/monitor/bmp-client?clientKey=${BMP_CLIENT_KEY_PLACEHOLDER}&view=loc-rib`,
        'docs/images/bmp/bmp-monitor-bgp-route.png'
    ],
    {
        route: `/monitor/bmp-client?clientKey=${BMP_CLIENT_KEY_PLACEHOLDER}&view=loc-rib`,
        outputPath: 'docs/images/bmp/bmp-loc-rib-instance-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    {
        route: `/monitor/bmp-client?clientKey=${BMP_CLIENT_KEY_PLACEHOLDER}&view=loc-rib`,
        outputPath: 'docs/images/bmp/bmp-loc-rib-route-detail.png',
        prepare: 'open-bmp-loc-rib-route-detail',
        cleanup: 'close-overlay'
    },
    [
        `/monitor/bmp-client?clientKey=${BMP_CLIENT_KEY_PLACEHOLDER}&view=session-statistics`,
        'docs/images/bmp/bmp-session-statis-report.png'
    ],
    {
        route: `/monitor/bmp-client?clientKey=${BMP_CLIENT_KEY_PLACEHOLDER}&view=session-statistics`,
        outputPath: 'docs/images/bmp/bmp-session-statis-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    [
        `/monitor/bmp-client?clientKey=${BMP_CLIENT_KEY_PLACEHOLDER}&view=loc-rib-statistics`,
        'docs/images/bmp/bmp-loc-rib-statis-report.png'
    ],
    {
        route: `/monitor/bmp-client?clientKey=${BMP_CLIENT_KEY_PLACEHOLDER}&view=loc-rib-statistics`,
        outputPath: 'docs/images/bmp/bmp-loc-rib-statis-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    {
        route: '/bmp/route-assurance',
        outputPath: 'docs/images/bmp/bmp-route-assurance.png',
        prepare: 'prepare-bmp-route-assurance'
    },
    {
        route: '/bmp/route-lens',
        outputPath: 'docs/images/bmp/bmp-route-lens.png',
        prepare: 'prepare-bmp-route-lens'
    },
    {
        route: '/bmp/route-lens',
        outputPath: 'docs/images/bmp/bmp-route-lens-route-detail.png',
        prepare: 'open-bmp-route-lens-route-detail',
        cleanup: 'close-overlay'
    },
    {
        route: '/bmp/route-lens',
        outputPath: 'docs/images/bmp/bmp-route-lens-policy-diff-detail.png',
        prepare: 'open-bmp-route-lens-policy-diff-detail',
        cleanup: 'close-overlay'
    },
    ['/rpki/rpki-config', 'docs/images/rpki/rpki-config-and-client.png'],
    ['/rpki/rpki-roa-config', 'docs/images/rpki/rpki-roa.png'],
    {
        route: '/rpki/rpki-roa-config',
        outputPath: 'docs/images/rpki/rpki-roa-import.png',
        prepare: 'open-rpki-roa-import',
        cleanup: 'close-overlay'
    },
    ['/rpki/rpki-router-key-config', 'docs/images/rpki/rpki-router-key.png'],
    ['/rpki/rpki-aspa-config', 'docs/images/rpki/rpki-aspa.png'],
    {
        route: '/rpki/rpki-aspa-config',
        outputPath: 'docs/images/rpki/rpki-aspa-import.png',
        prepare: 'open-rpki-aspa-import',
        cleanup: 'close-overlay'
    },
    ['/yang/yang-connection', 'docs/images/yang/yang-connection.png'],
    ['/yang/yang-modules', 'docs/images/yang/yang-modules.png'],
    ['/yang/yang-workspace', 'docs/images/yang/yang-workspace.png'],
    {
        route: '/yang/yang-workspace',
        outputPath: 'docs/images/yang/yang-operations.png',
        prepare: 'execute-yang-get'
    },
    {
        route: '/yang/yang-workspace',
        outputPath: 'docs/images/yang/yang-schema-context-menu.png',
        prepare: 'open-yang-schema-context-menu',
        cleanup: 'close-overlay'
    },
    {
        kind: 'monitor',
        monitorId: 'netconf-edit-config',
        outputPath: 'docs/images/yang/yang-edit-config-editor.png',
        prepare: 'prepare-yang-edit-config-editor'
    },
    {
        kind: 'monitor',
        monitorId: 'netconf-edit-config',
        outputPath: 'docs/images/yang/yang-operation-parameter-edit.png',
        prepare: 'open-yang-operation-parameter-edit',
        cleanup: 'close-overlay'
    },
    {
        kind: 'monitor',
        monitorId: 'netconf-edit-config',
        outputPath: 'docs/images/yang/yang-execution-history.png',
        prepare: 'execute-yang-edit-config-and-open-history'
    },
    {
        kind: 'monitor',
        monitorId: 'netconf-notifications',
        outputPath: 'docs/images/yang/yang-notifications.png',
        prepare: 'prepare-yang-notifications'
    },
    ['/snmp/snmp-config', 'docs/images/snmp/snmp-config.png'],
    ['/monitor/snmp-trap', 'docs/images/snmp/snmp-trap.png'],
    {
        route: '/monitor/snmp-trap',
        outputPath: 'docs/images/snmp/snmp-trap-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    ['/snmp/snmp-mib-compile', 'docs/images/snmp/snmp-mib-compile.png'],
    ['/snmp/snmp-mib', 'docs/images/snmp/snmp-mib.png'],
    {
        route: '/snmp/snmp-mib',
        outputPath: 'docs/images/snmp/snmp-mib-context-menu.png',
        prepare: 'open-snmp-mib-context-menu',
        cleanup: 'close-snmp-context-menu'
    },
    {
        route: '/snmp/snmp-mib',
        outputPath: 'docs/images/snmp/snmp-mib-walk.png',
        prepare: 'open-snmp-mib-walk',
        cleanup: 'close-overlay'
    },
    ['/ftp/ftp-config', 'docs/images/ftp/ftp-config-and-client.png'],
    {
        route: '/ftp/ftp-config',
        outputPath: 'docs/images/ftp/ftp-users.png',
        prepare: 'open-ftp-users',
        cleanup: 'close-overlay'
    },
    ['/dhcp/dhcp-config', 'docs/images/dhcp/dhcp-config.png'],
    ['/dhcp/dhcp-lease', 'docs/images/dhcp/dhcp-lease-list.png'],
    ['/ntp/ntp-config', 'docs/images/ntp/ntp-config.png'],
    ['/ntp/ntp-request-log', 'docs/images/ntp/ntp-request-log.png'],
    ['/radius/radius-config', 'docs/images/radius/radius-config.png'],
    ['/radius/radius-request-log', 'docs/images/radius/radius-request-log.png'],
    {
        route: '/radius/radius-request-log',
        outputPath: 'docs/images/radius/radius-request-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    ['/radius/radius-session', 'docs/images/radius/radius-session.png'],
    {
        route: '/radius/radius-session',
        outputPath: 'docs/images/radius/radius-session-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    ['/tftp/tftp-config', 'docs/images/tftp/tftp-config.png'],
    ['/tftp/tftp-transfer-log', 'docs/images/tftp/tftp-transfer-log.png'],
    ['/syslog/syslog-config', 'docs/images/syslog/syslog-config.png'],
    ['/monitor/syslog-message-log', 'docs/images/syslog/syslog-message-log.png'],
    {
        route: '/monitor/syslog-message-log',
        outputPath: 'docs/images/syslog/syslog-message-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    ['/tools/string-generator', 'docs/images/tools/tools_string_generator.png'],
    ['/tools/packet-parser', 'docs/images/tools/tools_packet_parser.png'],
    ['/tools/port-monitor', 'docs/images/tools/tools_port_monitor.png'],
    ['/tools/network-info', 'docs/images/tools/tools_network_info.png'],
    ['/tools/http-api-tester', 'docs/images/tools/tools_http_api_tester.png'],
    ['/tools/tcp-ao-mac', 'docs/images/tools/tools_tcp_ao_mac.png'],
    {
        route: '/tools/tcp-ao-mac',
        outputPath: 'docs/images/tools/tools_tcp_ao_mac_result.png',
        prepare: 'open-tcp-ao-result',
        cleanup: 'close-overlay'
    },
    ['/tools/tcp-tool', 'docs/images/tools/tools_tcp_tool.png'],
    ['/tools/udp-tool', 'docs/images/tools/tools_udp_tool.png']
];

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parsePositiveInteger(value, defaultValue) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function getCaptureWindowSize() {
    return {
        width: parsePositiveInteger(process.env.NETNEXUS_DOCS_WINDOW_WIDTH, DEFAULT_WINDOW_WIDTH),
        height: parsePositiveInteger(process.env.NETNEXUS_DOCS_WINDOW_HEIGHT, DEFAULT_WINDOW_HEIGHT)
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

const pagePreparers = new Map();
const pageCleanups = new Map();
const screenshotPreparers = new Map();
const screenshotCleanups = new Map();

function normalizeScreenshotEntry(entry) {
    if (Array.isArray(entry)) {
        return {
            route: entry[0],
            outputPath: entry[1],
            prepare: entry[2],
            cleanup: entry[3]
        };
    }
    return entry;
}

function matchesScreenshotScope(entry) {
    const { outputPath } = normalizeScreenshotEntry(entry);
    if (SCREENSHOT_SCOPE && !outputPath.startsWith(`docs/images/${SCREENSHOT_SCOPE}/`)) return false;
    return !SCREENSHOT_MATCH || outputPath.includes(SCREENSHOT_MATCH);
}

async function runScreenshotHandler(map, handlerName, win, label) {
    if (!handlerName) {
        return;
    }
    const handler = map.get(handlerName);
    if (!handler) {
        throw new Error(`unknown screenshot handler "${handlerName}" for ${label}`);
    }
    await handler(win, label);
}

async function navigateAndCapture(win, route, outputPath, prepare, cleanup) {
    if (route.includes(BMP_CLIENT_KEY_PLACEHOLDER)) {
        if (!bmpDocsClientKey) {
            throw new Error(`BMP Client key is unavailable for ${outputPath}`);
        }
        route = route.replace(BMP_CLIENT_KEY_PLACEHOLDER, encodeURIComponent(bmpDocsClientKey));
    }
    await closeOpenOverlay(win);
    await wait(150);
    if (route === '/monitor/netconf-notifications') {
        const directUrl = new URL(BASE_URL);
        directUrl.searchParams.set('docs-screenshot', 'netconf-notifications');
        directUrl.hash = route;
        const rendererReady = waitForRendererReady(win);
        await win.loadURL(directUrl.toString());
        await rendererReady;
    } else {
        await win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(route)}`);
    }
    await waitForRoute(win, route);
    await wait(1300);
    if (pagePreparers.has(route)) {
        await pagePreparers.get(route)(win);
        await wait(800);
    }
    await runScreenshotHandler(screenshotPreparers, prepare, win, outputPath);
    if (prepare) {
        await wait(500);
    }
    await capturePage(win, route, outputPath);
    if (cleanup) {
        await runScreenshotHandler(screenshotCleanups, cleanup, win, outputPath);
        await wait(300);
    } else if (pageCleanups.has(route)) {
        await pageCleanups.get(route)(win);
        await wait(300);
    }
}

function monitorScreenshotOptions(monitorId) {
    if (monitorId !== 'netconf-edit-config') return undefined;
    if (!yangDocsContext?.profileId || !yangDocsContext?.compileId || !yangDocsContext?.editableNodeId) {
        throw new Error('YANG edit-config monitor context is unavailable');
    }
    return {
        profileId: yangDocsContext.profileId,
        compileId: yangDocsContext.compileId,
        nodeId: yangDocsContext.editableNodeId,
        target: 'candidate'
    };
}

async function openAndCaptureMonitor(monitorWindowManager, screenshot) {
    const { monitorId, outputPath, prepare, cleanup } = screenshot;
    const response = await monitorWindowManager.openMonitor(monitorId, monitorScreenshotOptions(monitorId));
    assertSuccess(response, `open ${monitorId} documentation monitor`);

    const entry = [...monitorWindowManager.monitorWindows.values()].find(item => item.monitorId === monitorId);
    const monitorWindow = entry?.window;
    if (!monitorWindow || monitorWindow.isDestroyed()) {
        throw new Error(`${monitorId} documentation monitor window is unavailable`);
    }

    monitorWindow.hide();
    const { width, height } = getCaptureWindowSize();
    monitorWindow.setContentSize(width, height);
    await wait(400);
    await closeOpenOverlay(monitorWindow);
    await runScreenshotHandler(screenshotPreparers, prepare, monitorWindow, outputPath);
    if (prepare) await wait(500);
    monitorWindow.showInactive();
    await wait(250);
    try {
        await capturePage(monitorWindow, `/monitor/${monitorId}`, outputPath, {
            outputSize: { width, height },
            warmOverlayCapture: false
        });
        if (cleanup) {
            await runScreenshotHandler(screenshotCleanups, cleanup, monitorWindow, outputPath);
            await wait(300);
        }
    } finally {
        monitorWindow.hide();
    }
}

async function capturePage(win, label, outputPath, options = {}) {
    await win.webContents.executeJavaScript('document.fonts && document.fonts.ready');
    const hasOpenOverlay = await win.webContents.executeJavaScript(`
        (() => {
            let style = document.getElementById('docs-screenshot-hide-overlays');
            if (!style) {
                style = document.createElement('style');
                style.id = 'docs-screenshot-hide-overlays';
                document.head.appendChild(style);
            }
            style.textContent =
                '.nn-toast-host, .update-notification, .nn-floating-notification { display: none !important; } ' +
                '.nn-drawer-content-wrapper { transition: none !important; } ' +
                '.nn-drawer-motion-enter-from, .nn-drawer-motion-leave-to { opacity: 1 !important; } ' +
                '.nn-drawer-motion-enter-from .nn-drawer-content-wrapper, ' +
                '.nn-drawer-motion-leave-to .nn-drawer-content-wrapper { transform: none !important; }';
            const isVisible = element => {
                const rect = element?.getBoundingClientRect();
                const computed = element ? window.getComputedStyle(element) : null;
                return Boolean(
                    element &&
                    rect &&
                    rect.width > 0 &&
                    rect.height > 0 &&
                    computed?.display !== 'none' &&
                    computed?.visibility !== 'hidden'
                );
            };
            document.querySelectorAll('.nn-drawer').forEach(drawer => {
                if (!isVisible(drawer)) return;
                drawer.classList.remove('nn-drawer-motion-enter-from', 'nn-drawer-motion-leave-to');
                drawer.style.opacity = '1';
                const wrapper = drawer.querySelector('.nn-drawer-content-wrapper');
                if (wrapper) {
                    wrapper.style.transition = 'none';
                    wrapper.style.transform = 'none';
                }
            });
            document.querySelectorAll(
                '.nn-toast, .update-notification, [class*="update-notification"], .nn-floating-notification'
            ).forEach(element => {
                element.remove();
            });
            return Array.from(document.querySelectorAll('.nn-drawer-content, .nn-modal')).some(isVisible);
        })()
    `);
    await win.webContents.executeJavaScript(`
        new Promise(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
        })
    `);
    win.webContents.invalidate();
    await wait(150);
    if (hasOpenOverlay && options.warmOverlayCapture !== false) {
        await win.capturePage();
        await wait(100);
        win.webContents.invalidate();
    }
    const image = await win.capturePage();
    const [contentWidth, contentHeight] = win.getContentSize();
    const outputWidth = options.outputSize?.width || contentWidth;
    const outputHeight = options.outputSize?.height || contentHeight;
    const imageSize = image.getSize();
    const normalizedImage =
        imageSize.width === outputWidth && imageSize.height === outputHeight
            ? image
            : image.resize({
                  width: outputWidth,
                  height: outputHeight,
                  quality: 'best'
              });
    const absoluteOutputPath = path.join(OUTPUT_ROOT, outputPath);
    await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
    await fs.writeFile(absoluteOutputPath, normalizedImage.toPNG());
    console.log(`captured ${label} -> ${outputPath}`);
}

async function captureStartupBanner(outputPath) {
    const splash = new BrowserWindow({
        width: STARTUP_BANNER_WIDTH,
        height: STARTUP_BANNER_HEIGHT,
        useContentSize: true,
        show: false,
        transparent: false,
        backgroundColor: '#f4f6f8',
        frame: false,
        resizable: false,
        hasShadow: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    try {
        await splash.loadFile(path.join(__dirname, '../electron/splash.html'));
        await splash.webContents.executeJavaScript(`
            (() => {
                const style = document.createElement('style');
                style.id = 'docs-screenshot-stable-startup';
                style.textContent =
                    '.progress-bar { transition: none !important; } ' +
                    '.startup-step-current .startup-step-status { animation: none !important; }';
                document.head.appendChild(style);

                const steps = [
                    [18, '核心组件已加载', 'done'],
                    [34, '基础设置已加载', 'done'],
                    [52, '工具设置已加载', 'done'],
                    [72, '主进程服务已启动', 'done'],
                    [88, '等待页面渲染', 'active']
                ];
                steps.forEach(step => window.updateProgress(...step));
            })()
        `);
        await splash.webContents.executeJavaScript('document.fonts && document.fonts.ready');
        await splash.webContents.executeJavaScript(`
            new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        `);
        splash.webContents.invalidate();
        await wait(100);

        const image = await splash.capturePage();
        const normalizedImage = image.resize({
            width: STARTUP_BANNER_WIDTH,
            height: STARTUP_BANNER_HEIGHT,
            quality: 'best'
        });
        const absoluteOutputPath = path.join(OUTPUT_ROOT, outputPath);
        await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
        await fs.writeFile(absoluteOutputPath, normalizedImage.toPNG());
        console.log(`captured startup banner -> ${outputPath}`);
    } finally {
        splash.destroy();
    }
}

async function waitForOpenOverlay(win, label, expectedText = '') {
    await waitForRendererCondition(
        win,
        `
        (() => {
            const expectedText = ${JSON.stringify(expectedText)};
            const isVisible = element => {
                if (!element) return false;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const overlays = Array.from(document.querySelectorAll('.nn-drawer-content, .nn-modal'))
                .filter(isVisible);
            const matchingOverlays = expectedText
                ? overlays.filter(item => item.textContent.includes(expectedText))
                : overlays;
            const overlay = matchingOverlays[matchingOverlays.length - 1];
            const text = overlay?.textContent?.trim() || '';
            const spinning = Boolean(overlay?.querySelector('.nn-spin-overlay, .nn-spin, .nn-table-loading-mask'));
            const hasEmptyDetail = text.includes('暂无详情');
            const wrapper = overlay?.closest('.nn-drawer-content-wrapper');
            const panel = wrapper || overlay;
            const panelRect = panel?.getBoundingClientRect();
            const transitionRoot = wrapper?.closest('.nn-drawer');
            const drawerIsTransitioning = Boolean(
                transitionRoot?.classList.contains('nn-drawer-motion-enter-from') ||
                transitionRoot?.classList.contains('nn-drawer-motion-leave-to')
            );
            const panelIsInViewport = Boolean(
                panelRect &&
                panelRect.left >= -2 &&
                panelRect.top >= -2 &&
                panelRect.right <= window.innerWidth + 2 &&
                panelRect.bottom <= window.innerHeight + 2
            );
            return {
                ready:
                    Boolean(overlay) &&
                    !spinning &&
                    text.length > 10 &&
                    !hasEmptyDetail &&
                    panelIsInViewport &&
                    !drawerIsTransitioning &&
                    (!expectedText || text.includes(expectedText)),
                text: text.slice(0, 80),
                overlays: overlays.length,
                matchingOverlays: matchingOverlays.length,
                spinning,
                panelIsInViewport,
                drawerIsTransitioning,
                panelRect: panelRect
                    ? {
                          left: Math.round(panelRect.left),
                          top: Math.round(panelRect.top),
                          right: Math.round(panelRect.right),
                          bottom: Math.round(panelRect.bottom)
                      }
                    : null
            };
        })()
    `,
        label,
        10000
    );
    await wait(100);
}

async function openDetailButtonByText(win, buttonIndex, label) {
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const isVisible = element => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const buttons = Array.from(document.querySelectorAll('button'))
                .filter(button => isVisible(button) && !button.disabled && button.textContent.includes('详情'));
            const button = buttons[${buttonIndex}];
            if (!button) {
                return { clicked: false, count: buttons.length };
            }
            button.scrollIntoView({ block: 'center', inline: 'nearest' });
            button.click();
            return { clicked: true, count: buttons.length, text: button.textContent.trim() };
        })()
    `);
    if (!result?.clicked) {
        throw new Error(`detail button not found for ${label}: ${JSON.stringify(result)}`);
    }
    await waitForOpenOverlay(win, label);
}

async function openDetailButtonBySelector(win, selector, label) {
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const button = document.querySelector(${JSON.stringify(selector)});
            if (!button || button.disabled) {
                return { clicked: false };
            }
            button.scrollIntoView({ block: 'center', inline: 'nearest' });
            button.click();
            return { clicked: true, text: button.textContent.trim() };
        })()
    `);
    if (!result?.clicked) {
        throw new Error(`detail selector not found for ${label}: ${selector}`);
    }
    await waitForOpenOverlay(win, label);
}

async function selectOptionByText(win, selector, optionText, label) {
    const current = await win.webContents.executeJavaScript(`
        (() => {
            const select = document.querySelector(${JSON.stringify(selector)});
            if (!select) return { ready: false, reason: 'select not found' };
            const selectedText = select.querySelector('.nn-select-single-value')?.textContent?.trim() || '';
            const optionText = ${JSON.stringify(optionText)};
            if (selectedText === optionText || selectedText.startsWith(optionText + ' (')) {
                return { ready: true, alreadySelected: true, selectedText };
            }
            if (select.getAttribute('aria-disabled') === 'true') {
                return { ready: false, reason: 'select disabled', selectedText };
            }
            select.click();
            return { ready: true, alreadySelected: false, selectedText };
        })()
    `);
    if (!current?.ready) {
        throw new Error(`select unavailable for ${label}: ${JSON.stringify(current)}`);
    }
    if (current.alreadySelected) return;

    await waitForRendererCondition(
        win,
        `
        (() => {
            const isVisible = element => {
                const rect = element?.getBoundingClientRect();
                const style = element ? window.getComputedStyle(element) : null;
                return Boolean(
                    element &&
                    rect &&
                    rect.width > 0 &&
                    rect.height > 0 &&
                    style?.display !== 'none' &&
                    style?.visibility !== 'hidden'
                );
            };
            const options = Array.from(document.querySelectorAll('[role="option"]')).filter(isVisible);
            const optionText = ${JSON.stringify(optionText)};
            const option = options.find(item => {
                const text = item.textContent.trim();
                return text === optionText || text.startsWith(optionText + ' (');
            });
            return {
                ready: Boolean(option),
                options: options.map(item => item.textContent.trim()).slice(0, 20)
            };
        })()
    `,
        `${label} option`,
        10000
    );

    const result = await win.webContents.executeJavaScript(`
        (() => {
            const isVisible = element => {
                const rect = element?.getBoundingClientRect();
                const style = element ? window.getComputedStyle(element) : null;
                return Boolean(
                    element &&
                    rect &&
                    rect.width > 0 &&
                    rect.height > 0 &&
                    style?.display !== 'none' &&
                    style?.visibility !== 'hidden'
                );
            };
            const optionText = ${JSON.stringify(optionText)};
            const option = Array.from(document.querySelectorAll('[role="option"]'))
                .filter(isVisible)
                .find(item => {
                    const text = item.textContent.trim();
                    return text === optionText || text.startsWith(optionText + ' (');
                });
            if (!option) return { clicked: false };
            option.click();
            return { clicked: true, text: option.textContent.trim() };
        })()
    `);
    if (!result?.clicked) {
        throw new Error(`option not found for ${label}: ${optionText}`);
    }
    await wait(300);
}

async function clickDrawerTab(win, tabText, label) {
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const isVisible = element => {
                const rect = element?.getBoundingClientRect();
                const style = element ? window.getComputedStyle(element) : null;
                return Boolean(
                    element &&
                    rect &&
                    rect.width > 0 &&
                    rect.height > 0 &&
                    style?.display !== 'none' &&
                    style?.visibility !== 'hidden'
                );
            };
            const drawer = Array.from(document.querySelectorAll('.nn-drawer-content')).filter(isVisible).at(-1);
            const tab = Array.from(drawer?.querySelectorAll('.nn-tabs-tab') || [])
                .find(item => item.textContent.trim() === ${JSON.stringify(tabText)});
            if (!tab) return { clicked: false, drawerText: drawer?.textContent?.slice(0, 120) || '' };
            tab.click();
            return { clicked: true, text: tab.textContent.trim() };
        })()
    `);
    if (!result?.clicked) {
        throw new Error(`drawer tab not found for ${label}: ${JSON.stringify(result)}`);
    }
    await wait(200);
}

async function prepareBmpRouteLens(win, label) {
    const inputReady = await win.webContents.executeJavaScript(
        setDomInputScript('[data-testid="route-lens-query"]', BMP_ROUTE_LENS_QUERY)
    );
    if (!inputReady) throw new Error(`Route Lens input unavailable for ${label}`);
    const clicked = await win.webContents.executeJavaScript(`
        (() => {
            const button = document.querySelector('[data-testid="route-lens-search"]');
            if (!button || button.disabled) return false;
            button.click();
            return true;
        })()
    `);
    if (!clicked) throw new Error(`Route Lens search unavailable for ${label}`);

    await waitForRendererCondition(
        win,
        `
        (() => {
            const stageKeys = ['preIn', 'postIn', 'locRib', 'preOut', 'postOut'];
            const stages = Object.fromEntries(stageKeys.map(key => {
                const stage = document.querySelector('[data-testid="route-lens-stage-' + key + '"]');
                const cards = Array.from(stage?.querySelectorAll('[data-testid="route-lens-route-card"]') || []);
                return [key, cards.filter(card => card.textContent.includes('203.0.120.0/24')).length];
            }));
            return {
                ready: stageKeys.every(key => stages[key] === 1),
                stages,
                loading: Boolean(document.querySelector('.route-lens-page .nn-spin-spinning'))
            };
        })()
    `,
        label,
        15000
    );
}

async function openBmpRouteLensRouteDetail(win, label) {
    await prepareBmpRouteLens(win, label);
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const stage = document.querySelector('[data-testid="route-lens-stage-preIn"]');
            const card = Array.from(stage?.querySelectorAll('[data-testid="route-lens-route-card"]') || [])
                .find(item => item.textContent.includes('203.0.120.0/24'));
            if (!card) return { clicked: false };
            card.scrollIntoView({ block: 'center', inline: 'nearest' });
            card.click();
            return { clicked: true };
        })()
    `);
    if (!result?.clicked) throw new Error(`Route Lens route card unavailable for ${label}`);
    await waitForOpenOverlay(win, label, '203.0.120.0/24 · Pre Adj-RIB-In');
}

async function openBmpRouteLensPolicyDiffDetail(win, label) {
    await prepareBmpRouteLens(win, label);
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const panel = Array.from(document.querySelectorAll('.analysis-panel'))
                .find(item => item.textContent.includes('Inbound 属性差异'));
            const card = panel?.querySelector('.diff-card');
            if (!card) return { clicked: false, panelText: panel?.textContent?.slice(0, 120) || '' };
            card.scrollIntoView({ block: 'center', inline: 'nearest' });
            card.click();
            return { clicked: true };
        })()
    `);
    if (!result?.clicked) {
        throw new Error(`Route Lens policy diff unavailable for ${label}: ${JSON.stringify(result)}`);
    }
    await waitForOpenOverlay(win, label, 'Inbound 属性差异');
}

async function prepareBmpRouteAssurance(win, label) {
    const toggleState = await win.webContents.executeJavaScript(`
        (() => {
            const toggle = document.querySelector('[data-testid="route-assurance-toggle"]');
            if (!toggle || toggle.disabled) return { ready: false };
            const checked = toggle.getAttribute('aria-checked') === 'true';
            if (!checked) toggle.click();
            return { ready: true, checked };
        })()
    `);
    if (!toggleState?.ready) throw new Error(`Route Assurance toggle unavailable for ${label}`);

    await waitForRendererCondition(
        win,
        `
        (() => {
            const toggle = document.querySelector('[data-testid="route-assurance-toggle"]');
            const vrf = document.querySelector('[data-testid="route-assurance-vrf"]');
            return {
                ready: toggle?.getAttribute('aria-checked') === 'true' && vrf?.getAttribute('aria-disabled') !== 'true',
                checked: toggle?.getAttribute('aria-checked'),
                vrfDisabled: vrf?.getAttribute('aria-disabled')
            };
        })()
    `,
        `${label} analysis enabled`,
        15000
    );

    await selectOptionByText(win, '[data-testid="route-assurance-vrf"]', 'route-lens-lab', label);
    const clicked = await win.webContents.executeJavaScript(`
        (() => {
            const button = document.querySelector('[data-testid="route-assurance-search"]');
            if (!button || button.disabled) return false;
            button.click();
            return true;
        })()
    `);
    if (!clicked) throw new Error(`Route Assurance search unavailable for ${label}`);

    await waitForRendererCondition(
        win,
        `
        (() => {
            const expected = { preIn: '6', postIn: '5', locRib: '4', preOut: '3', postOut: '2' };
            const counts = Object.fromEntries(Object.keys(expected).map(key => [
                key,
                document.querySelector('[data-testid="route-assurance-stage-' + key + '"] strong')?.textContent?.trim()
            ]));
            const rows = Array.from(document.querySelectorAll('[data-testid="route-assurance-issue-row"]'));
            return {
                ready: Object.keys(expected).every(key => counts[key] === expected[key]) && rows.length === 5,
                counts,
                rows: rows.length,
                loading: Boolean(document.querySelector('.route-assurance-page .nn-table-loading-mask'))
            };
        })()
    `,
        label,
        20000
    );
}

async function closeOpenOverlay(win) {
    await win.webContents.executeJavaScript(`
        (() => {
            const buttons = Array.from(document.querySelectorAll('.nn-drawer .nn-drawer-close, .nn-modal .nn-modal-close'));
            buttons.reverse().forEach(button => button.click());
        })()
    `);
}

async function openTcpAoResult(win, label) {
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const button = Array.from(document.querySelectorAll('.tcpao-page button'))
                .find(item => item.textContent.includes('计算 MAC'));
            if (!button || button.disabled) {
                return { clicked: false };
            }
            button.scrollIntoView({ block: 'center', inline: 'nearest' });
            button.click();
            return { clicked: true };
        })()
    `);
    if (!result?.clicked) {
        throw new Error(`TCP-AO calculate button not found for ${label}`);
    }
    await waitForOpenOverlay(win, label, 'MAC 计算结果');
}

async function prepareSnmpMibTreePage(win) {
    const targetOid = '1.3.6.1.4.1.55555.1.1.3';
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const input = document.querySelector('.oid-query-row input');
            const button = Array.from(document.querySelectorAll('.oid-query-row button'))
                .find(item => item.textContent.includes('定位节点'));
            if (!input || !button) {
                return { ready: false, reason: 'query controls not found' };
            }
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) {
                setter.call(input, ${JSON.stringify(targetOid)});
            } else {
                input.value = ${JSON.stringify(targetOid)};
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            button.click();
            return { ready: true };
        })()
    `);
    if (!result?.ready) {
        throw new Error(`SNMP MIB query controls unavailable: ${JSON.stringify(result)}`);
    }

    await waitForRendererCondition(
        win,
        `
        (() => {
            const target = document.querySelector('.mib-node-title[data-tree-oid="${targetOid}"]');
            const treeNode = target?.closest('.nn-tree-node');
            return {
                ready:
                    Boolean(target) &&
                    target.textContent.includes('demoWritableName') &&
                    (treeNode?.getAttribute('aria-selected') === 'true' ||
                        treeNode?.classList.contains('nn-tree-node-selected')),
                targetVisible: Boolean(target),
                selected: treeNode?.getAttribute('aria-selected'),
                text: target?.textContent?.slice(0, 120) || ''
            };
        })()
    `,
        'SNMP MIB expanded tree',
        10000
    );
}

async function prepareSnmpMibCompilerPage(win) {
    await waitForRendererCondition(
        win,
        `
        (() => {
            const page = document.querySelector('.snmp-mib-page');
            const rows = Array.from(page?.querySelectorAll('.mib-file-table .nn-table-tbody tr') || []);
            const text = page?.textContent || '';
            const loading = Boolean(page?.querySelector('.nn-spin-spinning, .nn-table-loading-mask'));
            return {
                ready:
                    Boolean(page) &&
                    !loading &&
                    rows.length > 0 &&
                    text.includes('NETNEXUS-DEMO-MIB') &&
                    text.includes('文件状态'),
                rows: rows.length,
                loading,
                text: text.slice(0, 240)
            };
        })()
    `,
        'SNMP MIB compiler fixture',
        10000
    );
}

async function prepareYangConnectionPage(win) {
    await waitForRendererCondition(
        win,
        `
        (() => {
            const page = document.querySelector('.yang-connection-page');
            const text = page?.textContent || '';
            const loading = Boolean(page?.querySelector('.nn-spin-spinning'));
            const capabilityButton = Array.from(page?.querySelectorAll('.session-card button') || [])
                .find(button => button.textContent.includes('Capability'));
            return {
                ready:
                    Boolean(page) &&
                    !loading &&
                    text.includes('连接设置') &&
                    text.includes('Local NETCONF Mock') &&
                    text.includes('NETCONF 已连接') &&
                    Boolean(capabilityButton),
                loading,
                text: text.slice(0, 320)
            };
        })()
    `,
        'YANG connected profile page',
        20000
    );
}

async function prepareYangModulesPage(win) {
    await waitForRendererCondition(
        win,
        `
        (() => {
            const page = document.querySelector('.yang-modules-page');
            const rows = Array.from(page?.querySelectorAll('.module-table .nn-table-tbody tr') || []);
            const text = page?.textContent || '';
            const loading = Boolean(page?.querySelector('.nn-spin-spinning, .nn-table-loading-mask'));
            return {
                ready:
                    Boolean(page) &&
                    !loading &&
                    rows.length >= 2 &&
                    text.includes('Local NETCONF Mock') &&
                    text.includes('netnexus-mock-device') &&
                    text.includes('netnexus-mock-types') &&
                    text.includes('已编译'),
                rows: rows.length,
                loading,
                text: text.slice(0, 360)
            };
        })()
    `,
        'YANG downloaded and compiled modules page',
        30000
    );
}

async function expandYangSchemaNode(win, nodeName, expectedChild) {
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const item = Array.from(document.querySelectorAll('.schema-panel [role="treeitem"]'))
                .find(node => node.querySelector('.schema-node-name')?.textContent.trim() === ${JSON.stringify(nodeName)});
            const switcher = item?.querySelector('button.nn-tree-switcher');
            if (!item || !switcher) {
                return { found: Boolean(item), expanded: false };
            }
            const expanded = switcher.getAttribute('aria-label') === '收起节点';
            if (!expanded) switcher.click();
            return { found: true, expanded: true };
        })()
    `);
    if (!result?.found) {
        throw new Error(`YANG Schema node not found: ${nodeName}`);
    }
    await waitForRendererCondition(
        win,
        `
        (() => {
            const names = Array.from(document.querySelectorAll('.schema-panel .schema-node-name'))
                .map(node => node.textContent.trim());
            return {
                ready: names.includes(${JSON.stringify(expectedChild)}),
                names: names.slice(0, 30)
            };
        })()
    `,
        `YANG Schema ${nodeName} expanded`,
        10000
    );
}

async function prepareYangWorkspacePage(win) {
    await waitForRendererCondition(
        win,
        `
        (() => {
            const page = document.querySelector('.yang-workspace-page');
            const text = page?.textContent || '';
            const roots = page?.querySelectorAll('.schema-panel [role="treeitem"]') || [];
            const loading = Boolean(page?.querySelector('.schema-panel .nn-spin-spinning'));
            return {
                ready:
                    Boolean(page) &&
                    !loading &&
                    roots.length >= 2 &&
                    text.includes('Schema 与设备操作') &&
                    text.includes('Schema 已就绪') &&
                    text.includes('Local NETCONF Mock') &&
                    text.includes('netnexus-mock-device'),
                roots: roots.length,
                loading,
                text: text.slice(0, 360)
            };
        })()
    `,
        'YANG Schema workspace',
        30000
    );
    await expandYangSchemaNode(win, 'netnexus-mock-device', 'interfaces');
    await expandYangSchemaNode(win, 'interfaces', 'interface');
}

async function executeYangGet(win, label) {
    await prepareYangWorkspacePage(win);
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const panel = document.querySelector('.workspace-operation-panel .yang-operations-page');
            const button = Array.from(panel?.querySelectorAll('button') || [])
                .find(item => item.textContent.trim() === '执行 get');
            if (!panel || !button || button.disabled) {
                return {
                    clicked: false,
                    panelFound: Boolean(panel),
                    buttonFound: Boolean(button),
                    disabled: Boolean(button?.disabled)
                };
            }
            button.scrollIntoView({ block: 'center', inline: 'nearest' });
            button.click();
            return { clicked: true };
        })()
    `);
    if (!result?.clicked) {
        throw new Error(`YANG get action unavailable for ${label}: ${JSON.stringify(result)}`);
    }
    await waitForRendererCondition(
        win,
        `
        (() => {
            const panel = document.querySelector('.workspace-operation-panel .yang-operations-page');
            const resultCard = panel?.querySelector('.operation-result-card');
            const responseEditor = resultCard?.querySelector('.rpc-result textarea');
            const requestEditor = panel?.querySelector('.rpc-request-editor textarea');
            const response = responseEditor?.value || '';
            const request = requestEditor?.value || '';
            const text = resultCard?.textContent || '';
            return {
                ready:
                    text.includes('成功') &&
                    request.includes('<rpc') &&
                    request.includes('<get') &&
                    response.includes('<rpc-reply') &&
                    response.includes('<data'),
                text: text.slice(0, 240),
                request: request.slice(0, 160),
                response: response.slice(0, 160)
            };
        })()
    `,
        'YANG get request and response',
        20000
    );
}

async function prepareYangNotificationsPage(win) {
    await waitForRendererCondition(
        win,
        `
        (() => {
            const page = document.querySelector('[data-testid="netconf-notification-monitor-page"]');
            const browser = document.querySelector('[data-testid="netconf-notification-drawer"]');
            const rows = browser?.querySelectorAll('[data-testid="netconf-notification-row"]') || [];
            return {
                ready: Boolean(page) && Boolean(browser) && rows.length > 0,
                rows: rows.length,
                text: browser?.textContent?.slice(0, 320) || '',
                hash: window.location.hash,
                title: document.title,
                bodyText: document.body?.innerText?.slice(0, 320) || '',
                appHtml: document.querySelector('#app')?.innerHTML?.slice(0, 500) || ''
            };
        })()
    `,
        'YANG notification history list',
        20000
    );
    await win.webContents.executeJavaScript(`
        (() => {
            const subscription = Array.from(document.querySelectorAll('.notification-subscription-item'))
                .find(item => item.textContent.includes('活动'));
            subscription?.click();
        })()
    `);
    await waitForRendererCondition(
        win,
        `
        (() => {
            const browser = document.querySelector('[data-testid="netconf-notification-drawer"]');
            const subscription = browser?.querySelector(
                '.notification-subscription-item[aria-selected="true"], .notification-subscription-item-active'
            );
            const row = browser?.querySelector('[data-testid="netconf-notification-row"]');
            return { ready: Boolean(subscription && row) };
        })()
    `,
        'YANG notification subscription selection',
        10000
    );
    await win.webContents.executeJavaScript(`
        (() => {
            const rows = Array.from(document.querySelectorAll('[data-testid="netconf-notification-row"]'));
            // The documentation notification is emitted during fixture setup.
            // Later RPCs may add newer mock-event rows, so select the oldest row.
            rows.at(-1)?.click();
        })()
    `);
    await waitForRendererCondition(
        win,
        `
        (() => {
            const browser = document.querySelector('[data-testid="netconf-notification-drawer"]');
            const xmlEditor = browser?.querySelector('[data-testid="netconf-notification-xml"]');
            const xml = xmlEditor?.value || xmlEditor?.querySelector('textarea')?.value || '';
            const text = browser?.textContent || '';
            const activeSubscription = browser?.querySelector(
                '.notification-subscription-item[aria-selected="true"], .notification-subscription-item-active'
            );
            return {
                ready:
                    Boolean(activeSubscription) &&
                    text.includes('通知浏览器') &&
                    text.includes('mock-event') &&
                    xml.includes('<notification') &&
                    xml.includes('NetNexus 文档演示通知'),
                xml: xml.slice(0, 240),
                text: text.slice(0, 360)
            };
        })()
    `,
        'YANG notification XML detail',
        15000
    );
}

async function openYangSchemaContextMenu(win, label) {
    await prepareYangWorkspacePage(win);
    const opened = await win.webContents.executeJavaScript(`
        (() => {
            const item = Array.from(document.querySelectorAll('.schema-panel [role="treeitem"]'))
                .find(node => node.querySelector('.schema-node-name')?.textContent.trim() === 'interfaces');
            if (!item) return { opened: false, reason: 'interfaces Schema node not found' };
            item.scrollIntoView({ block: 'center', inline: 'nearest' });
            const bounds = item.getBoundingClientRect();
            item.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: Math.min(bounds.left + Math.max(80, bounds.width / 2), window.innerWidth - 320),
                clientY: Math.min(bounds.top + Math.max(12, bounds.height / 2), window.innerHeight - 520),
                button: 2
            }));
            return { opened: true };
        })()
    `);
    if (!opened?.opened) {
        throw new Error(`YANG Schema context menu unavailable for ${label}: ${JSON.stringify(opened)}`);
    }
    await waitForRendererCondition(
        win,
        `
        (() => {
            const menu = document.querySelector('.schema-context-menu');
            const text = menu?.textContent || '';
            const bounds = menu?.getBoundingClientRect();
            return {
                ready:
                    Boolean(menu && bounds?.width > 0 && bounds?.height > 0) &&
                    text.includes('interfaces') &&
                    text.includes('读取当前节点（get）') &&
                    text.includes('编辑当前节点（edit-config）'),
                text: text.slice(0, 500)
            };
        })()
    `,
        'YANG Schema context menu',
        10000
    );
    await win.webContents.executeJavaScript(`
        (() => {
            const item = Array.from(document.querySelectorAll('.schema-context-menu [role="menuitem"]'))
                .find(node => node.textContent.trim().startsWith('编辑当前节点（edit-config）'));
            item?.click();
        })()
    `);
    await waitForRendererCondition(
        win,
        `
        (() => {
            const menu = document.querySelector('.schema-context-menu');
            const submenuTrigger = Array.from(menu?.querySelectorAll('[role="menuitem"]') || [])
                .find(node => node.textContent.trim().startsWith('编辑当前节点（edit-config）'));
            const text = menu?.textContent || '';
            return {
                ready:
                    submenuTrigger?.getAttribute('aria-expanded') === 'true' &&
                    text.includes('Candidate') &&
                    text.includes('Running'),
                expanded: submenuTrigger?.getAttribute('aria-expanded'),
                text: text.slice(0, 600)
            };
        })()
    `,
        'YANG edit-config Schema submenu',
        10000
    );
}

async function prepareYangEditConfigEditor(win) {
    await waitForRendererCondition(
        win,
        `
        (() => {
            const page = document.querySelector('[data-testid="netconf-edit-config-monitor-page"]');
            const panel = page?.querySelector('.yang-operations-page');
            const request = panel?.querySelector('.rpc-request-editor textarea')?.value || '';
            const readback = panel?.querySelector('.edit-config-readback-bar')?.textContent || '';
            const target = panel?.querySelector('[data-parameter-path="/rpc/edit-config/target"]')?.textContent || '';
            const defaultOperation =
                panel?.querySelector('[data-parameter-path="/rpc/edit-config/default-operation"]')?.textContent || '';
            const name = panel?.querySelector(
                '[data-parameter-path="/rpc/edit-config/config/interfaces[1]/interface[1]/name[1]"]'
            )?.textContent || '';
            const enabled = panel?.querySelector(
                '[data-parameter-path="/rpc/edit-config/config/interfaces[1]/interface[1]/enabled[1]"]'
            )?.textContent || '';
            const executeButton = Array.from(panel?.querySelectorAll('button') || [])
                .find(button => button.textContent.trim() === '执行 edit-config');
            return {
                ready:
                    Boolean(page && panel) &&
                    !page.querySelector('.netconf-edit-config-state') &&
                    readback.includes('已载入') &&
                    request.includes('<edit-config') &&
                    request.includes('<enabled>true</enabled>') &&
                    target.includes('candidate') &&
                    defaultOperation.includes('merge') &&
                    name.includes('eth0') &&
                    enabled.includes('true') &&
                    Boolean(executeButton && !executeButton.disabled),
                readback: readback.slice(0, 160),
                target: target.slice(0, 100),
                defaultOperation: defaultOperation.slice(0, 100),
                name: name.slice(0, 100),
                enabled: enabled.slice(0, 100),
                request: request.slice(0, 300),
                pageText: page?.textContent?.slice(0, 500) || ''
            };
        })()
    `,
        'YANG edit-config Content Editor readback',
        30000
    );
}

async function openYangEnabledParameterMenu(win, label) {
    await prepareYangEditConfigEditor(win);
    const opened = await win.webContents.executeJavaScript(`
        (() => {
            const node = document.querySelector(
                '[data-parameter-path="/rpc/edit-config/config/interfaces[1]/interface[1]/enabled[1]"]'
            );
            const item = node?.closest('[role="treeitem"]') || node;
            if (!item) return { opened: false, reason: 'enabled parameter not found' };
            item.scrollIntoView({ block: 'center', inline: 'nearest' });
            const bounds = item.getBoundingClientRect();
            item.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: Math.min(bounds.left + Math.max(80, bounds.width / 2), window.innerWidth - 300),
                clientY: Math.min(bounds.top + Math.max(12, bounds.height / 2), window.innerHeight - 360),
                button: 2
            }));
            return { opened: true };
        })()
    `);
    if (!opened?.opened) {
        throw new Error(`YANG enabled parameter menu unavailable for ${label}: ${JSON.stringify(opened)}`);
    }
    await waitForRendererCondition(
        win,
        `
        (() => {
            const menu = document.querySelector('.operation-parameter-context-menu');
            const item = Array.from(menu?.querySelectorAll('[role="menuitem"]') || [])
                .find(node => node.textContent.trim() === '修改值');
            const bounds = menu?.getBoundingClientRect();
            return {
                ready:
                    Boolean(menu && bounds?.width > 0 && bounds?.height > 0) &&
                    Boolean(item) &&
                    item.getAttribute('aria-disabled') !== 'true',
                text: menu?.textContent?.slice(0, 320) || '',
                disabled: item?.getAttribute('aria-disabled')
            };
        })()
    `,
        'YANG enabled parameter context menu',
        10000
    );
}

async function openYangOperationParameterEdit(win, label) {
    await openYangEnabledParameterMenu(win, label);
    await win.webContents.executeJavaScript(`
        (() => {
            const menu = document.querySelector('.operation-parameter-context-menu');
            const item = Array.from(menu?.querySelectorAll('[role="menuitem"]') || [])
                .find(node => node.textContent.trim() === '修改值');
            item?.click();
        })()
    `);
    await waitForRendererCondition(
        win,
        `
        (() => {
            const dialog = Array.from(document.querySelectorAll('[role="dialog"]'))
                .find(node => node.textContent.includes('修改值 · enabled'));
            const editor = dialog?.querySelector('[aria-label="节点值"]');
            const bounds = dialog?.getBoundingClientRect();
            return {
                ready:
                    Boolean(dialog && bounds?.width > 0 && bounds?.height > 0) &&
                    Boolean(editor) &&
                    dialog.textContent.includes('true'),
                text: dialog?.textContent?.slice(0, 320) || '',
                value: editor?.value || editor?.textContent || ''
            };
        })()
    `,
        'YANG operation parameter value editor',
        10000
    );
}

async function executeYangEditConfigAndOpenHistory(win, label) {
    await prepareYangEditConfigEditor(win);
    const executed = await win.webContents.executeJavaScript(`
        (() => {
            const panel = document.querySelector('[data-testid="netconf-edit-config-monitor-page"] .yang-operations-page');
            const button = Array.from(panel?.querySelectorAll('button') || [])
                .find(item => item.textContent.trim() === '执行 edit-config');
            if (!button || button.disabled) return { clicked: false, disabled: Boolean(button?.disabled) };
            button.click();
            return { clicked: true };
        })()
    `);
    if (!executed?.clicked) {
        throw new Error(`YANG edit-config action unavailable for ${label}: ${JSON.stringify(executed)}`);
    }
    await waitForRendererCondition(
        win,
        `
        (() => {
            const panel = document.querySelector('[data-testid="netconf-edit-config-monitor-page"] .yang-operations-page');
            const result = panel?.querySelector('.operation-result-card');
            const response = result?.querySelector('.rpc-result textarea')?.value || '';
            return {
                ready: Boolean(result?.textContent.includes('成功')) && response.includes('<ok'),
                text: result?.textContent?.slice(0, 260) || '',
                response: response.slice(0, 220)
            };
        })()
    `,
        'YANG edit-config RPC result',
        20000
    );
    await win.webContents.executeJavaScript(`
        (() => {
            const page = document.querySelector('[data-testid="netconf-edit-config-monitor-page"]');
            const button = Array.from(page?.querySelectorAll('.execution-history-trigger') || [])
                .find(item => item.textContent.trim() === '执行记录');
            button?.click();
        })()
    `);
    await waitForRendererCondition(
        win,
        `
        (() => {
            const drawer = document.querySelector('.execution-history-drawer');
            const items = Array.from(drawer?.querySelectorAll('[data-testid="netconf-history-item"]') || []);
            const editRecord = items.find(item =>
                item.textContent.includes('edit-config') && !item.textContent.includes('自动回读')
            );
            const readbackRecord = items.find(item => item.textContent.includes('edit-config 自动回读'));
            if (readbackRecord && readbackRecord.getAttribute('aria-selected') !== 'true') readbackRecord.click();
            return {
                ready: Boolean(drawer && editRecord && readbackRecord),
                total: items.length,
                records: items.map(item => item.textContent.trim().slice(0, 160))
            };
        })()
    `,
        'YANG edit-config execution history list',
        10000
    );
    await waitForRendererCondition(
        win,
        `
        (() => {
            const drawer = document.querySelector('.execution-history-drawer');
            const selected = drawer?.querySelector('[data-testid="netconf-history-item"][aria-selected="true"]');
            const requestEditor = drawer?.querySelector('[data-testid="netconf-history-request"]');
            const replyEditor = drawer?.querySelector('[data-testid="netconf-history-reply"]');
            const request = requestEditor?.value || requestEditor?.querySelector('textarea')?.value || '';
            const reply = replyEditor?.value || replyEditor?.querySelector('textarea')?.value || '';
            return {
                ready:
                    Boolean(selected?.textContent.includes('edit-config 自动回读')) &&
                    request.includes('<get-config') &&
                    reply.includes('<rpc-reply') &&
                    reply.includes('<enabled>true</enabled>'),
                selected: selected?.textContent?.slice(0, 180) || '',
                request: request.slice(0, 240),
                reply: reply.slice(0, 300)
            };
        })()
    `,
        'YANG edit-config execution history detail',
        10000
    );
}

async function openSnmpMibContextMenuAtOid(win, label, targetOid) {
    await prepareSnmpMibTreePage(win);
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const target = document.querySelector('.mib-node-title[data-tree-oid="${targetOid}"]');
            if (!target) {
                return { opened: false, reason: 'target node not found' };
            }
            target.scrollIntoView({ block: 'center', inline: 'nearest' });
            const rect = target.getBoundingClientRect();
            const x = Math.min(rect.left + Math.max(40, rect.width / 2), window.innerWidth - 240);
            const y = Math.min(rect.top + Math.max(10, rect.height / 2), window.innerHeight - 340);
            const event = new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
                button: 2,
                buttons: 2
            });
            target.dispatchEvent(event);
            return { opened: true, x, y, text: target.textContent.trim() };
        })()
    `);
    if (!result?.opened) {
        throw new Error(`SNMP MIB context menu target unavailable for ${label}: ${JSON.stringify(result)}`);
    }
    await waitForRendererCondition(
        win,
        `
        (() => {
            const menu = document.querySelector('.mib-context-menu');
            const text = menu?.textContent?.trim() || '';
            return {
                ready:
                    Boolean(menu) && text.includes('复制 OID') && text.includes('GET 查询') && text.includes('SET 设置'),
                text: text.slice(0, 160)
            };
        })()
    `,
        label,
        5000
    );
}

async function openSnmpMibContextMenu(win, label) {
    await openSnmpMibContextMenuAtOid(win, label, '1.3.6.1.4.1.55555.1.1.3');
}

async function openSnmpMibWalkModal(win, label) {
    await openSnmpMibContextMenuAtOid(win, label, '1.3.6.1.4.1.55555.1.1');
    const clicked = await win.webContents.executeJavaScript(`
        (() => {
            const items = Array.from(document.querySelectorAll('.mib-context-menu .nn-menu-item'));
            const item = items.find(node => node.textContent.includes('WALK 查询'));
            if (!item) {
                return { clicked: false, reason: 'walk menu item not found' };
            }
            item.click();
            return { clicked: true };
        })()
    `);
    if (!clicked?.clicked) {
        throw new Error(`SNMP MIB WALK menu item unavailable for ${label}: ${JSON.stringify(clicked)}`);
    }

    await waitForRendererCondition(
        win,
        `
        (() => {
            const operations = document.querySelector('.snmp-mib-operations');
            const request = operations?.querySelector('.operation-request-pane');
            const response = operations?.querySelector('.operation-result-pane');
            const startButton = Array.from(request?.querySelectorAll('button') || [])
                .find(item => item.textContent.includes('开始 WALK'));
            const text = operations?.textContent || '';
            return {
                ready:
                    Boolean(request) &&
                    Boolean(response) &&
                    Boolean(startButton) &&
                    !startButton.disabled &&
                    text.includes('请求 · WALK'),
                text: text.slice(0, 240)
            };
        })()
    `,
        `${label} request panel`,
        5000
    );
    const started = await win.webContents.executeJavaScript(`
        (() => {
            const button = Array.from(
                document.querySelectorAll('.snmp-mib-operations .operation-request-pane button')
            )
                .find(item => item.textContent.includes('开始 WALK'));
            if (!button) {
                return { started: false, reason: 'start button not found' };
            }
            button.click();
            return { started: true };
        })()
    `);
    if (!started?.started) {
        throw new Error(`SNMP MIB WALK start button unavailable for ${label}: ${JSON.stringify(started)}`);
    }

    await waitForRendererCondition(
        win,
        `
        (() => {
            const operations = document.querySelector('.snmp-mib-operations');
            const response = operations?.querySelector('.operation-result-pane');
            const textarea = response?.querySelector('.walk-result-output');
            const text = response?.textContent || '';
            const output = textarea?.value || '';
            return {
                ready:
                    Boolean(response) &&
                    text.includes('成功') &&
                    text.includes('3 条') &&
                    output.includes('NetNexus Demo Agent'),
                text: text.slice(0, 240),
                output: output.slice(0, 240)
            };
        })()
    `,
        label,
        10000
    );

    await win.webContents.executeJavaScript(`
        new Promise(resolve => {
            const treeScroll = document.querySelector('.snmp-mib-page .mib-tree-scroll');
            if (treeScroll) treeScroll.scrollLeft = 0;
            requestAnimationFrame(() => requestAnimationFrame(resolve));
        })
    `);
}

async function closeSnmpMibContextMenu(win) {
    await win.webContents.executeJavaScript(`
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 12, clientY: 12 }));
    `);
}

async function openFtpUsersModal(win, label) {
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const button = Array.from(document.querySelectorAll('button'))
                .find(item => item.textContent.includes('用户列表'));
            if (!button || button.disabled) {
                return { clicked: false };
            }
            button.click();
            return { clicked: true };
        })()
    `);
    if (!result?.clicked) {
        throw new Error(`FTP users button not found for ${label}`);
    }
    await waitForOpenOverlay(win, label, '用户列表');
}

async function openRouteAdvancedConfig(win, label) {
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const button = Array.from(document.querySelectorAll('button'))
                .find(item => item.textContent.trim().includes('高级配置'));
            if (!button || button.disabled) {
                return { clicked: false };
            }
            button.click();
            return { clicked: true };
        })()
    `);
    if (!result?.clicked) {
        throw new Error(`route advanced config button not found for ${label}`);
    }
    await waitForOpenOverlay(win, label, '高级配置');
}

async function openBmpClientDetail(win, label) {
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const rows = Array.from(document.querySelectorAll('[data-testid="bmp-client-table"] .nn-table-tbody tr'));
            const row = rows.find(item => item.textContent.includes('demo-bmp-router'));
            const button = row?.querySelector('[data-testid="bmp-client-detail-button"]');
            if (!row || !button || button.disabled) {
                return {
                    clicked: false,
                    rows: rows.map(item => item.textContent.trim()).filter(Boolean)
                };
            }
            button.scrollIntoView({ block: 'center', inline: 'nearest' });
            button.click();
            return { clicked: true, row: row.textContent.trim() };
        })()
    `);
    if (!result?.clicked) {
        throw new Error(`BMP demo Client detail button not found for ${label}: ${JSON.stringify(result)}`);
    }
    await waitForOpenOverlay(win, label, 'BMP客户端信息');
}

async function openImportModal(win, label, { pageSelector, buttonText, dialogTitle }) {
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const page = document.querySelector(${JSON.stringify(pageSelector)});
            const buttonText = ${JSON.stringify(buttonText)};
            const button = Array.from(page?.querySelectorAll('button') || [])
                .find(item => item.textContent.trim() === buttonText);
            if (!page || !button || button.disabled) {
                return {
                    clicked: false,
                    pageFound: Boolean(page),
                    buttons: Array.from(page?.querySelectorAll('button') || [])
                        .map(item => item.textContent.trim())
                        .filter(Boolean)
                };
            }
            button.scrollIntoView({ block: 'center', inline: 'nearest' });
            button.click();
            return { clicked: true };
        })()
    `);
    if (!result?.clicked) {
        throw new Error(`import button not found for ${label}: ${JSON.stringify(result)}`);
    }

    await waitForOpenOverlay(win, label, dialogTitle);
    await waitForRendererCondition(
        win,
        `
        (() => {
            const dialogTitle = ${JSON.stringify(dialogTitle)};
            const isVisible = element => {
                const rect = element?.getBoundingClientRect();
                const style = element ? window.getComputedStyle(element) : null;
                return Boolean(
                    rect?.width > 0 &&
                    rect?.height > 0 &&
                    style?.display !== 'none' &&
                    style?.visibility !== 'hidden'
                );
            };
            const candidates = Array.from(document.querySelectorAll('.nn-file-import-modal'));
            const body = candidates.find(item => {
                const candidateModal = item.closest('.nn-modal');
                return isVisible(candidateModal) && candidateModal.textContent.includes(dialogTitle);
            });
            const modal = body?.closest('.nn-modal');
            const text = modal?.textContent || '';
            const rect = modal?.getBoundingClientRect();
            const loading = body?.getAttribute('aria-busy') === 'true';
            return {
                ready:
                    Boolean(body) &&
                    Boolean(modal) &&
                    !loading &&
                    text.includes(dialogTitle) &&
                    rect?.width > 0 &&
                    rect?.height > 0,
                loading,
                text: text.slice(0, 240)
            };
        })()
    `,
        `${label} import modal`,
        10000
    );
}

screenshotPreparers.set('open-text-detail-0', (win, label) => openDetailButtonByText(win, 0, label));
screenshotPreparers.set('open-bmp-session-route-detail', (win, label) =>
    openDetailButtonBySelector(win, '[data-testid="bmp-session-route-table"] .nn-table-tbody button', label)
);
screenshotPreparers.set('open-bmp-loc-rib-route-detail', (win, label) =>
    openDetailButtonBySelector(win, '[data-testid="bmp-loc-rib-route-table"] .nn-table-tbody button', label)
);
screenshotPreparers.set('prepare-bmp-route-assurance', prepareBmpRouteAssurance);
screenshotPreparers.set('prepare-bmp-route-lens', prepareBmpRouteLens);
screenshotPreparers.set('open-bmp-route-lens-route-detail', openBmpRouteLensRouteDetail);
screenshotPreparers.set('open-bmp-route-lens-policy-diff-detail', openBmpRouteLensPolicyDiffDetail);
screenshotPreparers.set('open-tcp-ao-result', openTcpAoResult);
screenshotPreparers.set('open-snmp-mib-context-menu', openSnmpMibContextMenu);
screenshotPreparers.set('open-snmp-mib-walk', openSnmpMibWalkModal);
screenshotPreparers.set('open-ftp-users', openFtpUsersModal);
screenshotPreparers.set('open-route-advanced-config', openRouteAdvancedConfig);
screenshotPreparers.set('open-bmp-client-detail', openBmpClientDetail);
screenshotPreparers.set('execute-yang-get', executeYangGet);
screenshotPreparers.set('open-yang-schema-context-menu', openYangSchemaContextMenu);
screenshotPreparers.set('prepare-yang-edit-config-editor', prepareYangEditConfigEditor);
screenshotPreparers.set('open-yang-operation-parameter-edit', openYangOperationParameterEdit);
screenshotPreparers.set('execute-yang-edit-config-and-open-history', executeYangEditConfigAndOpenHistory);
screenshotPreparers.set('prepare-yang-notifications', prepareYangNotificationsPage);
screenshotPreparers.set('open-routeviews-import', (win, label) =>
    openImportModal(win, label, {
        pageSelector: '[data-testid="bgp-route-ipv4-page"]',
        buttonText: '从 RouteViews 导入',
        dialogTitle: '导入 BGP MRT 路由文件'
    })
);
screenshotPreparers.set('open-rpki-roa-import', (win, label) =>
    openImportModal(win, label, {
        pageSelector: '.adaptive-list-page',
        buttonText: '导入JSON',
        dialogTitle: '导入 ROA JSON 文件'
    })
);
screenshotPreparers.set('open-rpki-aspa-import', (win, label) =>
    openImportModal(win, label, {
        pageSelector: '.adaptive-list-page',
        buttonText: '导入JSON',
        dialogTitle: '导入 ASPA JSON 文件'
    })
);
screenshotCleanups.set('close-overlay', closeOpenOverlay);
screenshotCleanups.set('close-snmp-context-menu', closeSnmpMibContextMenu);

async function selectSettingsCategory(win, categoryText) {
    await win.webContents.executeJavaScript(`
        (() => {
            const categoryText = ${JSON.stringify(categoryText)};
            const items = Array.from(
                document.querySelectorAll('.settings-dialog-modal .nn-navigation-modal-nav-item')
            );
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
            const items = Array.from(document.querySelectorAll('.nn-dropdown-popup .nn-menu-item'));
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
        document.querySelector('.settings-dialog-modal .nn-navigation-modal-close')?.click();
    `);
    await wait(300);
}

async function waitForSettingsPage(win, selector, expectedText, pendingText = '') {
    await waitForRendererCondition(
        win,
        `
        (() => {
            const page = document.querySelector(${JSON.stringify(selector)});
            const pendingText = ${JSON.stringify(pendingText)};
            const text = page?.textContent || '';
            return {
                ready:
                    Boolean(page) &&
                    text.includes(${JSON.stringify(expectedText)}) &&
                    (!pendingText || !text.includes(pendingText)),
                text: text.slice(0, 240)
            };
        })()
    `,
        `settings ${expectedText}`,
        15000
    );
}

async function captureSettingsScreenshots(win) {
    await win.webContents.executeJavaScript(`window.location.hash = '/tools/string-generator'`);
    await waitForRoute(win, '/tools/string-generator');
    await wait(800);
    await openSettingsDialog(win);
    await selectSettingsCategory(win, '通用');
    await capturePage(win, 'settings/general', 'docs/images/setting/setting.png');
    await win.webContents.executeJavaScript(`
        (() => {
            const option = document.querySelector('.theme-preset-option-dark');
            if (!option) throw new Error('dark theme option not found');
            option.click();
        })()
    `);
    await wait(500);
    await capturePage(win, 'settings/theme-dark', 'docs/images/setting/setting-theme-dark.png');
    await win.webContents.executeJavaScript(`document.querySelector('.theme-preset-option-blue')?.click()`);
    await wait(300);
    await selectSettingsCategory(win, '工具');
    await capturePage(win, 'settings/tools', 'docs/images/setting/setting-tools.png');
    await selectSettingsCategory(win, 'FTP');
    await capturePage(win, 'settings/ftp', 'docs/images/setting/setting-ftp.png');
    await selectSettingsCategory(win, 'API');
    await capturePage(win, 'settings/api', 'docs/images/setting/setting-api.png');
    await selectSettingsCategory(win, '数据');
    await waitForSettingsPage(win, '.bmp-data-settings', 'BMP SQLite 数据库', '检测中');
    await capturePage(win, 'settings/data', 'docs/images/setting/setting-data.png');
    await selectSettingsCategory(win, '运行时');
    await waitForSettingsPage(win, '.runtime-settings', 'YANG 编译器', '正在检查内置 YANG 编译器');
    await capturePage(win, 'settings/runtime', 'docs/images/setting/setting-runtime.png');
    await selectSettingsCategory(win, '更新');
    await capturePage(win, 'settings/update', 'docs/images/setting/setting-updater.png');
    await closeSettingsDialog(win);
}

function assertSuccess(result, action) {
    if (!result || result.status !== 'success') {
        throw new Error(`${action} failed: ${result?.msg || 'unknown error'}`);
    }
}

function warnOptional(error, action) {
    console.warn(`${action} skipped: ${error.message || error}`);
}

async function invokeRenderer(win, script, action) {
    const result = await win.webContents.executeJavaScript(script);
    assertSuccess(result, action);
    return result;
}

function runNodeScript(scriptName, args = [], options = {}) {
    const child = spawn(NODE_PATH, [path.join(__dirname, scriptName), ...args], {
        cwd: OUTPUT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', data => {
        process.stdout.write(data);
        output += data.toString();
    });
    child.stderr.on('data', data => {
        process.stderr.write(data);
        output += data.toString();
    });

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`${scriptName} timed out`));
        }, options.timeoutMs || 20000);

        child.once('error', error => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once('exit', code => {
            clearTimeout(timeout);
            if (code === 0) {
                resolve(output);
                return;
            }
            reject(new Error(`${scriptName} exited with code ${code}`));
        });
    });
}

function startNodeProcess(scriptName, args = [], options = {}) {
    const child = spawn(NODE_PATH, [path.join(__dirname, scriptName), ...args], {
        cwd: OUTPUT_ROOT,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    const readyPattern = options.readyPattern;
    const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`${scriptName} did not become ready in time`));
        }, options.timeoutMs || 15000);

        const handleOutput = data => {
            output += data.toString();
            if (!readyPattern || output.includes(readyPattern)) {
                clearTimeout(timeout);
                resolve(output);
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
            if (!readyPattern || !output.includes(readyPattern)) {
                reject(new Error(`${scriptName} exited before ready, code ${code}`));
            }
        });
    });

    return { child, ready };
}

async function stopChildProcess(child) {
    if (!child || child.exitCode !== null) {
        return;
    }

    if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write('/quit\n');
    } else {
        child.kill('SIGINT');
    }

    await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(1200)]);
    if (child.exitCode === null) {
        child.kill('SIGTERM');
    }
}

async function waitForRendererCondition(win, script, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastValue = null;
    while (Date.now() < deadline) {
        lastValue = await win.webContents.executeJavaScript(script);
        if (lastValue?.ready) {
            console.log(`${label} ready: ${JSON.stringify(lastValue)}`);
            return lastValue;
        }
        await wait(300);
    }
    throw new Error(`${label} was not ready: ${JSON.stringify(lastValue)}`);
}

async function startBmpForDocs(win) {
    const config = {
        port: `${BMP_DOCS_PORT}`,
        bmpV4TlvDraft: BMP_DRAFT_20,
        pathMarkingTlvType: BMP_PATH_MARKING_TLV_DRAFT_20
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

function startMockBmpClient(scenario = 'full') {
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
        '1',
        '--scenario',
        scenario,
        '--no-dump-packets'
    ];
    const child = spawn(NODE_PATH, args, {
        cwd: OUTPUT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`mock BMP client (${scenario}) did not finish sending data in time`));
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
                reject(new Error(`mock BMP client (${scenario}) exited before data was ready, code ${code}`));
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
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(1000)]);

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
                const sourceId = client.persistentSourceId || client.sourceId;
                state.clientKey = sourceId
                    ? 'source:' + sourceId
                    : 'connection:' + [client.localIp, client.localPort, client.remoteIp, client.remotePort].join('|');
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
            return lastState;
        }

        await wait(300);
    }

    throw new Error(`BMP mock data was not ready: ${JSON.stringify(lastState)}`);
}

async function setupSettingsDemo(win) {
    await invokeRenderer(
        win,
        `
        (async () => {
            const results = [];
            results.push(await window.commonApi.saveGeneralSettings({ logLevel: 'info' }));
            results.push(await window.commonApi.saveToolsSettings({
                packetParser: { maxMessageHistory: 50 },
                stringGenerator: { maxStringHistory: 50 }
            }));
            results.push(await window.commonApi.saveFtpSettings({ maxFtpUser: 20 }));
            results.push(await window.commonApi.saveApiSettings({
                mode: 'none',
                port: 18080,
                maxPageSize: 1000,
                cliMaxSessions: 20
            }));
            const failed = results.find(item => !item || item.status !== 'success');
            return failed || { status: 'success' };
        })()
    `,
        'seed settings demo data'
    );
}

async function setupBgpDemo(win, longRunningProcesses) {
    const family = BgpConst.BGP_ADDR_FAMILY;
    const caps = BgpConst.BGP_OPEN_CAP_CODE;
    const families = [
        family.IPV4_UNC,
        family.IPV4_LABEL_UNICAST,
        family.IPV6_UNC,
        family.IPV4_MVPN,
        family.IPV4_QP,
        family.IPV6_QP
    ];
    const addressFamilyConfig = {
        [family.IPV4_UNC]: { sendAddPath: true, sendSrv6PrefixSid: false },
        [family.IPV6_UNC]: { sendAddPath: true, sendSrv6PrefixSid: true },
        [family.IPV4_LABEL_UNICAST]: { sendAddPath: false, sendSrv6PrefixSid: false },
        [family.IPV4_MVPN]: { sendAddPath: false, sendSrv6PrefixSid: false },
        [family.IPV4_QP]: { sendAddPath: false, sendSrv6PrefixSid: false },
        [family.IPV6_QP]: { sendAddPath: false, sendSrv6PrefixSid: false }
    };
    const openCap = [
        caps.MULTIPROTOCOL_EXTENSIONS,
        caps.ROUTE_REFRESH,
        caps.FOUR_OCTET_AS,
        caps.ADD_PATH,
        caps.EXTENDED_NEXT_HOP_ENCODING
    ];

    await invokeRenderer(
        win,
        `
        (async () => {
            const bgpConfig = ${JSON.stringify({
                localAs: '65535',
                routerId: '192.168.56.1',
                port: String(BGP_DOCS_PORT),
                addressFamily: families
            })};
            const ipv4Peer = ${JSON.stringify({
                peerIp: '127.0.0.1',
                peerAs: '100',
                holdTime: '90',
                openCap,
                addressFamily: families,
                addressFamilyConfig,
                role: '',
                openCapCustom: ''
            })};
            const ipv6Peer = ${JSON.stringify({
                peerIpv6: '::1',
                peerIpv6As: '100',
                holdTimeIpv6: '90',
                openCapIpv6: openCap,
                addressFamilyIpv6: [family.IPV6_UNC, family.IPV6_QP],
                addressFamilyConfig,
                roleIpv6: '',
                openCapCustomIpv6: ''
            })};
            const steps = [
                await window.bgpApi.saveBgpConfig(bgpConfig),
                await window.bgpApi.startBgp(bgpConfig),
                await window.bgpApi.saveIpv4PeerConfig(ipv4Peer),
                await window.bgpApi.configIpv4Peer(ipv4Peer),
                await window.bgpApi.saveIpv6PeerConfig(ipv6Peer),
                await window.bgpApi.configIpv6Peer(ipv6Peer)
            ];
            return steps.find(item => !item || item.status !== 'success') || { status: 'success' };
        })()
    `,
        'start BGP demo server'
    );

    const mock = startNodeProcess(
        'mockBgpClient.js',
        [
            '--host',
            '127.0.0.1',
            '--port',
            String(BGP_DOCS_PORT),
            '--local-as',
            '100',
            '--router-id',
            '192.0.2.2',
            '--hold-time',
            '90',
            '--address-family',
            'ipv4-unc,ipv6-unc,ipv4-qp',
            '--add-path-address-family',
            'ipv4-unc,ipv6-unc',
            '--extended-next-hop'
        ],
        { readyPattern: '"event":"established"', timeoutMs: 15000 }
    );
    longRunningProcesses.push(mock.child);
    await mock.ready;

    const routeConfigs = [
        {
            api: 'generateIpv4Routes',
            config: {
                addressFamily: family.IPV4_UNC,
                prefix: '10.10.0.0',
                mask: '24',
                count: '18',
                rd: '65000:10',
                rt: '65000:10',
                addPathEnabled: true,
                addPathCount: '2',
                customAttr: '',
                srv6Enabled: true,
                srv6SidMode: BgpConst.BGP_SRV6_SID_MODE.INCREMENT,
                srv6Sid: '2001:db8:10:ffff::1',
                srv6SidStep: '1',
                srv6EndpointBehavior: BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT4
            }
        },
        {
            api: 'generateIpv4Routes',
            config: {
                addressFamily: family.IPV4_LABEL_UNICAST,
                prefix: '10.20.0.0',
                mask: '24',
                count: '12',
                rt: '65000:20',
                labelMode: BgpConst.BGP_LABEL_MODE.INCREMENT,
                labelStart: '16000',
                labelStep: '4',
                customAttr: ''
            }
        },
        {
            api: 'generateIpv6Routes',
            config: {
                addressFamily: family.IPV6_UNC,
                prefix: '2001:db8:10::',
                mask: '64',
                count: '14',
                rd: '65000:30',
                rt: '65000:30',
                addPathEnabled: true,
                addPathCount: '2',
                srv6Enabled: true,
                srv6SidMode: BgpConst.BGP_SRV6_SID_MODE.INCREMENT,
                srv6Sid: '2001:db8:ffff::1',
                srv6SidStep: '1',
                srv6EndpointBehavior: BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6,
                customAttr: ''
            }
        },
        {
            api: 'generateIpv4MvpnRoutes',
            config: {
                addressFamily: family.IPV4_MVPN,
                routeType: BgpConst.BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                rd: '65000:40',
                rt: '65000:40',
                sourceIp: '10.40.0.1',
                groupIp: '239.40.0.1',
                originatingRouterIp: '192.168.56.1',
                sourceAs: '65535',
                count: '8'
            }
        },
        {
            api: 'generateIpv4QpRoutes',
            config: {
                addressFamily: family.IPV4_QP,
                prefix: '10.50.0.1',
                mask: '32',
                count: '12',
                ipStep: '1',
                routeGrowthMode: BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN,
                startDqpn: '1000',
                dqpnStep: '10',
                bsidMode: BgpConst.BGP_QP_BSID_MODE.CONTINUOUS,
                bsid: '2001:db8:50::1',
                bsidStep: '1',
                customAttr: ''
            }
        },
        {
            api: 'generateIpv6QpRoutes',
            config: {
                addressFamily: family.IPV6_QP,
                prefix: '2001:db8:60::1',
                mask: '128',
                count: '12',
                ipStep: '1',
                routeGrowthMode: BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN,
                startDqpn: '2000',
                dqpnStep: '10',
                bsidMode: BgpConst.BGP_QP_BSID_MODE.CONTINUOUS,
                bsid: '2001:db8:60::ffff',
                bsidStep: '1',
                customAttr: ''
            }
        }
    ];

    await invokeRenderer(
        win,
        `
        (async () => {
            const routeConfigs = ${JSON.stringify(routeConfigs)};
            for (const item of routeConfigs) {
                const result = await window.bgpApi[item.api](item.config);
                if (!result || result.status !== 'success') {
                    return result;
                }
            }
            return { status: 'success' };
        })()
    `,
        'generate BGP demo routes'
    );

    await waitForRendererCondition(
        win,
        `
        (async () => {
            const families = ${JSON.stringify(families)};
            const totals = {};
            for (const family of families) {
                const result = await window.bgpApi.getRoutes(family, 1, 20);
                totals[family] = result?.data?.total || 0;
            }
            return {
                ready: Object.values(totals).every(total => total > 0),
                totals
            };
        })()
    `,
        'BGP demo data'
    );
}

async function setupRpkiDemo(win) {
    await invokeRenderer(
        win,
        `
        (async () => {
            const config = ${JSON.stringify({
                port: String(RPKI_DOCS_PORT),
                maxProtocolVersion: 2,
                aspaFormat: 'latest'
            })};
            const roas = [
                { ipType: 1, asn: '65001', ip: '10.10.0.0', mask: '24', maxLength: '24' },
                { ipType: 1, asn: '65002', ip: '10.20.0.0', mask: '24', maxLength: '28' },
                { ipType: 2, asn: '65003', ip: '2001:db8:10::', mask: '48', maxLength: '64' }
            ];
            const routerKeys = [
                {
                    ski: '0123456789ABCDEF0123456789ABCDEF01234567',
                    asn: '65001',
                    spki: '3059301306072A8648CE3D020106082A8648CE3D03010703420004'
                },
                {
                    ski: '89ABCDEF0123456789ABCDEF0123456789ABCDEF',
                    asn: '65002',
                    spki: '3059301306072A8648CE3D020106082A8648CE3D03010703420004'
                }
            ];
            const aspas = [
                { customerAsn: '65010', providerAsns: ['65001', '65002', '65003'], afiFlags: 3 },
                { customerAsn: '65020', providerAsns: ['65002', '65003'], afiFlags: 1 }
            ];
            const saveResult = await window.rpkiApi.saveRpkiConfig(config);
            if (!saveResult || saveResult.status !== 'success') return saveResult;
            for (const roa of roas) {
                const result = await window.rpkiApi.addRoa(roa);
                if (!result || result.status !== 'success') return result;
            }
            for (const routerKey of routerKeys) {
                const result = await window.rpkiApi.addRouterKey(routerKey);
                if (!result || result.status !== 'success') return result;
            }
            for (const aspa of aspas) {
                const result = await window.rpkiApi.addAspa(aspa);
                if (!result || result.status !== 'success') return result;
            }
            return window.rpkiApi.startRpki(config);
        })()
    `,
        'seed RPKI demo data'
    );
}

async function setupFtpDemo(win, runtimeDir) {
    const rootDir = path.join(runtimeDir, 'ftp-root');
    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, 'netnexus-readme.txt'), 'NetNexus FTP docs payload\n');
    const config = { port: String(FTP_DOCS_PORT) };
    const user = { rootDir, username: 'netnexus', password: 'netnexus' };

    await invokeRenderer(
        win,
        `
        (async () => {
            const config = ${JSON.stringify(config)};
            const user = ${JSON.stringify(user)};
            const addResult = await window.ftpApi.addFtpUser(user);
            if (!addResult || addResult.status !== 'success') return addResult;
            const saveResult = await window.ftpApi.saveFtpConfig(config);
            if (!saveResult || saveResult.status !== 'success') return saveResult;
            return window.ftpApi.startFtp(config, user);
        })()
    `,
        'start FTP demo server'
    );
    await runNodeScript(
        'mockFtpClient.js',
        ['--port', String(FTP_DOCS_PORT), '--username', user.username, '--password', user.password],
        { timeoutMs: 12000 }
    );
}

async function setupDhcpDemo(win) {
    const config = {
        serverIp: '127.0.0.1',
        serverPort: DHCP_DOCS_PORT,
        poolStart: '10.66.0.100',
        poolEnd: '10.66.0.150',
        subnetMask: '255.255.255.0',
        gateway: '10.66.0.1',
        dns1: '8.8.8.8',
        dns2: '1.1.1.1',
        leaseTime: 3600,
        v6: {
            serverPort: DHCP6_DOCS_PORT,
            poolStart: '2001:db8:66::100',
            poolEnd: '2001:db8:66::1ff',
            preferredLifetime: 3600,
            validLifetime: 7200,
            dns1: '2001:4860:4860::8888',
            dns2: '2001:4860:4860::8844'
        }
    };
    await invokeRenderer(
        win,
        `
        (async () => {
            const config = ${JSON.stringify(config)};
            const saveResult = await window.dhcpApi.saveDhcpConfig(config);
            if (!saveResult || saveResult.status !== 'success') return saveResult;
            return window.dhcpApi.startDhcp(config);
        })()
    `,
        'start DHCP demo server'
    );
    await runNodeScript(
        'testDhcpClient.js',
        ['--server', '127.0.0.1', '--port', String(DHCP_DOCS_PORT), '--count', '1', '--timeout', '5000'],
        { timeoutMs: 20000 }
    );
    await waitForRendererCondition(
        win,
        `
        (async () => {
            const result = await window.dhcpApi.getLeaseList();
            const leases = result?.status === 'success' && Array.isArray(result.data) ? result.data : [];
            return { ready: leases.length >= 1, leases: leases.length };
        })()
    `,
        'DHCP demo leases'
    );
}

async function setupSnmpDemo(win, longRunningProcesses) {
    const mibPath = path.join(OUTPUT_ROOT, 'scripts/manual/snmp/mibs/NETNEXUS-DEMO-MIB.mib');
    const agent = startNodeProcess('manual/snmp/snmp_mib_browser_agent.js', [String(SNMP_DOCS_QUERY_PORT), 'public'], {
        readyPattern: '[snmp-demo-agent] listening',
        timeoutMs: 15000
    });
    longRunningProcesses.push(agent.child);
    await agent.ready;

    const config = {
        targetHost: '127.0.0.1',
        port: String(SNMP_DOCS_TRAP_PORT),
        queryPort: String(SNMP_DOCS_QUERY_PORT),
        supportedVersions: ['v2c'],
        community: 'public',
        v3Username: '',
        securityLevel: 'noAuthNoPriv',
        authProtocol: 'SHA',
        authPassword: '',
        privProtocol: 'AES',
        privPassword: ''
    };
    await invokeRenderer(
        win,
        `
        (async () => {
            const mibResult = await window.snmpApi.compileMibs(${JSON.stringify([mibPath])});
            if (!mibResult || mibResult.status !== 'success') return mibResult;
            const config = ${JSON.stringify(config)};
            const saveResult = await window.snmpApi.saveSnmpConfig(config);
            if (!saveResult || saveResult.status !== 'success') return saveResult;
            return window.snmpApi.startSnmp(config);
        })()
    `,
        'start SNMP demo trap server'
    );
    await runNodeScript('manual/snmp/snmp_test.js', ['127.0.0.1', String(SNMP_DOCS_TRAP_PORT), '12'], {
        timeoutMs: 20000
    });
    await waitForRendererCondition(
        win,
        `
        (async () => {
            const result = await window.snmpApi.getTrapList({ page: 1, pageSize: 20 });
            const total = result?.data?.totalTraps || result?.data?.total || result?.data?.list?.length || 0;
            return { ready: total > 0, total };
        })()
    `,
        'SNMP demo traps'
    );
}

async function setupNtpDemo(win) {
    const config = {
        port: NTP_DOCS_PORT,
        stratum: 2,
        referenceId: 'NNXS',
        timeOffsetMs: 250,
        rootDelayMs: 2,
        rootDispersionMs: 5
    };
    await invokeRenderer(
        win,
        `
        (async () => {
            const config = ${JSON.stringify(config)};
            const saveResult = await window.ntpApi.saveNtpConfig(config);
            if (!saveResult || saveResult.status !== 'success') return saveResult;
            return window.ntpApi.startNtp(config);
        })()
    `,
        'start NTP demo server'
    );
    await runNodeScript(
        'testNtpClient.js',
        ['--server', '127.0.0.1', '--port', String(NTP_DOCS_PORT), '--count', '3'],
        {
            timeoutMs: 12000
        }
    );
    await waitForRendererCondition(
        win,
        `
        (async () => {
            const result = await window.ntpApi.getRequestList();
            const requests = result?.status === 'success' && Array.isArray(result.data) ? result.data : [];
            return { ready: requests.length >= 1, requests: requests.length };
        })()
    `,
        'NTP demo requests'
    );
}

async function setupRadiusDemo(win) {
    const config = {
        authPort: RADIUS_DOCS_AUTH_PORT,
        accountingPort: RADIUS_DOCS_ACCOUNTING_PORT,
        coaPort: RADIUS_DOCS_COA_PORT,
        enableAuth: true,
        enableAccounting: true,
        enableDynamicAuth: true,
        sharedSecret: 'testing123',
        requireMessageAuthenticator: false,
        rejectUnknownClients: false
    };
    await invokeRenderer(
        win,
        `
        (async () => {
            const config = ${JSON.stringify(config)};
            const saveResult = await window.radiusApi.saveRadiusConfig(config);
            if (!saveResult || saveResult.status !== 'success') return saveResult;
            return window.radiusApi.startRadius(config);
        })()
    `,
        'start RADIUS demo server'
    );
    await runNodeScript(
        'mockRadiusClient.js',
        [
            '--auth-port',
            String(RADIUS_DOCS_AUTH_PORT),
            '--accounting-port',
            String(RADIUS_DOCS_ACCOUNTING_PORT),
            '--coa-port',
            String(RADIUS_DOCS_COA_PORT),
            '--secret',
            'testing123',
            '--username',
            'demo',
            '--password',
            'demo'
        ],
        { timeoutMs: 20000 }
    );
    await waitForRendererCondition(
        win,
        `
        (async () => {
            const requestsResult = await window.radiusApi.getRequestList();
            const sessionsResult = await window.radiusApi.getSessionList();
            const requests = requestsResult?.status === 'success' && Array.isArray(requestsResult.data)
                ? requestsResult.data
                : [];
            const sessions = sessionsResult?.status === 'success' && Array.isArray(sessionsResult.data)
                ? sessionsResult.data
                : [];
            return { ready: requests.length > 0 && sessions.length > 0, requests: requests.length, sessions: sessions.length };
        })()
    `,
        'RADIUS demo data'
    );
}

async function setupTftpDemo(win, runtimeDir) {
    const rootDir = path.join(runtimeDir, 'tftp-root');
    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, 'readme.txt'), 'NetNexus TFTP docs payload\n');
    const config = {
        port: TFTP_DOCS_PORT,
        rootDir,
        blockSize: 512,
        timeout: 3,
        retries: 3,
        allowRead: true,
        allowWrite: true
    };
    await invokeRenderer(
        win,
        `
        (async () => {
            const config = ${JSON.stringify(config)};
            const saveResult = await window.tftpApi.saveTftpConfig(config);
            if (!saveResult || saveResult.status !== 'success') return saveResult;
            return window.tftpApi.startTftp(config);
        })()
    `,
        'start TFTP demo server'
    );
    await runNodeScript(
        'mockTftpClient.js',
        ['--port', String(TFTP_DOCS_PORT), '--mode', 'read', '--filename', 'readme.txt'],
        { timeoutMs: 12000 }
    );
    await waitForRendererCondition(
        win,
        `
        (async () => {
            const result = await window.tftpApi.getTransferList();
            const transfers = result?.status === 'success' && Array.isArray(result.data) ? result.data : [];
            return { ready: transfers.length >= 1, transfers: transfers.length };
        })()
    `,
        'TFTP demo transfers'
    );
}

async function setupSyslogDemo(win) {
    const config = {
        port: SYSLOG_DOCS_PORT,
        enableUdp: true,
        enableTcp: true,
        maxMessageLength: 8192
    };
    await invokeRenderer(
        win,
        `
        (async () => {
            const config = ${JSON.stringify(config)};
            const saveResult = await window.syslogApi.saveSyslogConfig(config);
            if (!saveResult || saveResult.status !== 'success') return saveResult;
            return window.syslogApi.startSyslog(config);
        })()
    `,
        'start Syslog demo server'
    );
    await runNodeScript(
        'testSyslogClient.js',
        ['--server', '127.0.0.1', '--port', String(SYSLOG_DOCS_PORT), '--no-error-cases'],
        { timeoutMs: 15000 }
    );
    await waitForRendererCondition(
        win,
        `
        (async () => {
            const result = await window.syslogApi.getMessageList({ page: 1, pageSize: 20 });
            const total = result?.data?.total || result?.data?.list?.length || 0;
            return { ready: total > 0, total };
        })()
    `,
        'Syslog demo messages'
    );
}

function setDomInputScript(selector, value, index = 0) {
    return `
        (() => {
            const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
            const element = elements[${index}];
            if (!element) return false;
            const descriptor =
                Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value') ||
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ||
                Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            descriptor.set.call(element, ${JSON.stringify(String(value))});
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()
    `;
}

async function injectToolLogFallback(win, tool, payload, stateText, recvText) {
    const byteLength = Buffer.byteLength(payload);
    const script = `
        (() => {
            const tool = ${JSON.stringify(tool)};
            const payload = ${JSON.stringify(payload)};
            const stateText = ${JSON.stringify(stateText)};
            const recvText = ${JSON.stringify(recvText)};
            const byteLength = ${byteLength};
            const page = document.querySelector('.' + tool + '-tool-page');
            if (!page) return false;

            const tag = page.querySelector('.nn-tag');
            if (tag) {
                tag.textContent = stateText;
            }

            const textarea = page.querySelector('.' + tool + '-send-card textarea');
            if (textarea) {
                const descriptor =
                    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value') ||
                    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
                descriptor.set.call(textarea, payload);
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
            }

            const traffic = page.querySelector('.' + tool + '-traffic-info');
            if (traffic) {
                traffic.textContent = '发送 ' + byteLength + ' B / 接收 ' + byteLength + ' B';
            }

            const controlButton = Array.from(page.querySelectorAll('.' + tool + '-config-form button')).find(button =>
                ['建立连接', '打开'].some(text => button.textContent.includes(text))
            );
            if (controlButton) {
                controlButton.disabled = false;
                controlButton.classList.remove('nn-button-primary');
                controlButton.classList.add('nn-button-default', 'nn-button-danger');
                controlButton.textContent = tool === 'tcp' ? '结束连接' : '关闭';
            }

            const sendButton = page.querySelector('.' + tool + '-send-actions button');
            if (sendButton) {
                sendButton.disabled = false;
                sendButton.classList.remove('nn-button-disabled');
            }

            const logList = page.querySelector('.' + tool + '-log-list');
            if (!logList) return false;
            logList.querySelectorAll('.nn-empty, .' + tool + '-log-empty').forEach(element => element.remove());

            const now = new Date();
            const time =
                now.toLocaleTimeString('zh-CN', { hour12: false }) +
                '.' +
                String(now.getMilliseconds()).padStart(3, '0');
            const addLog = (type, tagText, text) => {
                if (logList.textContent.includes(text)) {
                    return;
                }
                const item = document.createElement('div');
                item.className = tool + '-log-item ' + tool + '-log-' + type;
                item.style.cssText =
                    'display:flex;gap:8px;align-items:flex-start;padding:4px 8px;border-bottom:1px solid #f0f0f0;font-family:Menlo,Consolas,monospace;font-size:12px;';
                const timeSpan = document.createElement('span');
                timeSpan.className = tool + '-log-time';
                timeSpan.textContent = time;
                timeSpan.style.cssText = 'color:#8c8c8c;white-space:nowrap;';
                const tagSpan = document.createElement('span');
                tagSpan.className = tool + '-log-tag';
                tagSpan.textContent = tagText;
                tagSpan.style.cssText = 'min-width:36px;color:' + (type === 'recv' ? '#52c41a' : '#1677ff') + ';font-weight:600;';
                const textSpan = document.createElement('span');
                textSpan.className = tool + '-log-text';
                textSpan.textContent = text;
                textSpan.style.cssText = 'word-break:break-all;';
                item.append(timeSpan, tagSpan, textSpan);
                logList.append(item);
            };

            addLog('send', '发送', byteLength + ' 字节: ' + payload);
            addLog('recv', '接收', recvText);
            return true;
        })()
    `;
    const injected = await win.webContents.executeJavaScript(script);
    if (!injected) {
        throw new Error(`${tool.toUpperCase()} tool fallback log injection failed`);
    }
}

async function prepareBgpConfigPage(win) {
    try {
        const result = await win.webContents.executeJavaScript('window.bgpApi.getInstanceInfo()');
        assertSuccess(result, 'load BGP instance info for docs screenshot');
        const instances = Array.isArray(result.data) ? result.data : [];
        if (instances.length === 0) {
            return;
        }

        await win.webContents.executeJavaScript(`
            (() => {
                const instances = ${JSON.stringify(instances)};
                const familyLabels = {
                    1: 'Ipv4-UNC',
                    2: 'Ipv6-UNC',
                    6: 'IPv4-MVPN',
                    7: 'IPv6-MVPN',
                    8: 'IPv4-QP',
                    9: 'IPv6-QP',
                    12: 'IPv4 Label'
                };
                const page = document.querySelector('[data-testid="bgp-config-page"]');
                if (!page) return false;

                page.querySelectorAll('input').forEach(element => {
                    element.setAttribute('disabled', 'disabled');
                });
                page.querySelectorAll('.nn-select').forEach(element => {
                    element.setAttribute('aria-disabled', 'true');
                    element.setAttribute('tabindex', '-1');
                    element.classList.add('nn-select-disabled');
                });

                const startButton = page.querySelector('[data-testid="bgp-start-button"]');
                if (startButton) {
                    startButton.disabled = true;
                    startButton.classList.add('nn-button-disabled');
                    startButton.textContent = 'BGP已启动';
                }

                const stopButton = page.querySelector('[data-testid="bgp-stop-button"]');
                if (stopButton) {
                    stopButton.disabled = false;
                    stopButton.classList.remove('nn-button-disabled');
                }

                const table = page.querySelector('[data-testid="bgp-instance-table"]');
                const tbody = table?.querySelector('.nn-table-tbody');
                if (!tbody) return false;
                tbody.innerHTML = '';

                const makeCell = (content, align = 'left') => {
                    const td = document.createElement('td');
                    td.className = 'nn-table-cell';
                    td.style.cssText =
                        'padding:16px;border-bottom:1px solid #f0f0f0;text-align:' + align + ';vertical-align:middle;';
                    if (typeof content === 'string') {
                        td.textContent = content;
                    } else {
                        td.append(content);
                    }
                    return td;
                };

                instances.forEach(instance => {
                    const row = document.createElement('tr');
                    row.className = 'nn-table-row';
                    const familyTag = document.createElement('span');
                    familyTag.className = 'nn-tag nn-tag-blue';
                    familyTag.textContent = familyLabels[instance.addressFamily] || String(instance.addressFamily);
                    familyTag.style.cssText =
                        'box-sizing:border-box;margin-inline-end:8px;padding-inline:7px;color:#1677ff;background:#e6f4ff;border:1px solid #91caff;border-radius:4px;';

                    const routeBadge = document.createElement('span');
                    routeBadge.className = 'nn-badge';
                    routeBadge.textContent = String(instance.routeCount ?? 0);
                    routeBadge.style.cssText =
                        'display:inline-block;min-width:20px;height:20px;line-height:20px;padding:0 6px;border-radius:10px;color:#fff;background:#52c41a;font-size:12px;';

                    row.append(
                        makeCell(familyTag),
                        makeCell(String(instance.peerCount ?? 0), 'center'),
                        makeCell(routeBadge, 'center')
                    );
                    tbody.append(row);
                });
                return true;
            })()
        `);
    } catch (error) {
        warnOptional(error, 'prepare BGP config page');
    }
}

async function prepareBgpMvpnPage(win) {
    await win.webContents.executeJavaScript(`
        (() => {
            const tab = Array.from(document.querySelectorAll('.mvpn-route-tabs .nn-tabs-tab'))
                .find(element => element.textContent.includes('S-PMSI A-D'));
            if (tab) {
                tab.click();
            }
        })()
    `);
    await wait(400);
}

async function prepareTcpToolPage(win) {
    try {
        await win.webContents.executeJavaScript(setDomInputScript('.tcp-config-form input', '127.0.0.1', 0));
        await win.webContents.executeJavaScript(setDomInputScript('.tcp-config-form input', TCP_TOOL_DOCS_PORT, 1));
        await win.webContents.executeJavaScript(`
            Array.from(document.querySelectorAll('.tcp-config-form button'))
                .find(button => button.textContent.includes('建立连接'))?.click();
        `);
        await waitForRendererCondition(
            win,
            `({ ready: document.body.innerText.includes('已连接') })`,
            'TCP tool connection',
            5000
        );
        await win.webContents.executeJavaScript(setDomInputScript('.tcp-send-card textarea', TCP_TOOL_DOCS_PAYLOAD));
        const sendResult = await win.webContents.executeJavaScript(`
            window.toolsApi.tcpSend({
                id: 'tcp-1',
                data: ${JSON.stringify(TCP_TOOL_DOCS_PAYLOAD)},
                encoding: 'utf8'
            })
        `);
        assertSuccess(sendResult, 'send TCP tool demo payload');
        await waitForRendererCondition(
            win,
            `({ ready: document.body.innerText.includes('接收') && document.body.innerText.includes(${JSON.stringify(TCP_TOOL_DOCS_PAYLOAD)}) })`,
            'TCP tool echo',
            5000
        );
    } catch (error) {
        warnOptional(error, 'prepare TCP tool page');
        await injectToolLogFallback(
            win,
            'tcp',
            TCP_TOOL_DOCS_PAYLOAD,
            '已连接',
            `${Buffer.byteLength(TCP_TOOL_DOCS_PAYLOAD)} 字节: ${Buffer.from(TCP_TOOL_DOCS_PAYLOAD).toString('hex')}  |  ${TCP_TOOL_DOCS_PAYLOAD}`
        );
    }
}

async function prepareUdpToolPage(win) {
    try {
        await win.webContents.executeJavaScript(setDomInputScript('.udp-config-form input', '127.0.0.1', 0));
        await win.webContents.executeJavaScript(setDomInputScript('.udp-config-form input', UDP_TOOL_DOCS_PORT, 1));
        await win.webContents.executeJavaScript(`
            Array.from(document.querySelectorAll('.udp-config-form button'))
                .find(button => button.textContent.includes('打开'))?.click();
        `);
        await waitForRendererCondition(
            win,
            `({ ready: document.body.innerText.includes('就绪') })`,
            'UDP tool socket',
            5000
        );
        await win.webContents.executeJavaScript(setDomInputScript('.udp-send-card textarea', UDP_TOOL_DOCS_PAYLOAD));
        const sendResult = await win.webContents.executeJavaScript(`
            window.toolsApi.udpSend({
                id: 'udp-1',
                data: ${JSON.stringify(UDP_TOOL_DOCS_PAYLOAD)},
                encoding: 'utf8'
            })
        `);
        assertSuccess(sendResult, 'send UDP tool demo payload');
        await waitForRendererCondition(
            win,
            `({ ready: document.body.innerText.includes('接收') && document.body.innerText.includes(${JSON.stringify(UDP_TOOL_DOCS_PAYLOAD)}) })`,
            'UDP tool echo',
            5000
        );
    } catch (error) {
        warnOptional(error, 'prepare UDP tool page');
        await injectToolLogFallback(
            win,
            'udp',
            UDP_TOOL_DOCS_PAYLOAD,
            '就绪',
            `${Buffer.byteLength(UDP_TOOL_DOCS_PAYLOAD)} 字节 <- 127.0.0.1:${UDP_TOOL_DOCS_PORT}: ${Buffer.from(
                UDP_TOOL_DOCS_PAYLOAD
            ).toString('hex')}  |  ${UDP_TOOL_DOCS_PAYLOAD}`
        );
    }
}

async function setupToolsDemo(win, longRunningProcesses) {
    await invokeRenderer(
        win,
        `
        (async () => {
            const stringResult = await window.toolsApi.generateString({
                template: 'neighbor 192.0.2.{A} remote-as 650{A}',
                placeholder: '{A}',
                start: '1',
                end: '5'
            });
            if (!stringResult || stringResult.status !== 'success') return stringResult;
            const packetResult = await window.toolsApi.parsePacket({
                startLayer: 4,
                protocolType: 2,
                protocolPort: '179',
                transportProtocol: 6,
                packetData: 'FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF 00 13 04'
            });
            if (!packetResult || packetResult.status !== 'success') return packetResult;
            const tcpAoStateResult = await window.toolsApi.saveTcpAoMacState({
                formState: {
                    key: 'netnexus-demo-key',
                    sne: '00000001',
                    ipPacket: [
                        '45 00 00 28 00 00 40 00 40 06 00 00 C0 00 02 01 C0 00 02 02',
                        '30 39 00 B3 00 00 00 01 00 00 00 00 50 02 20 00 00 00 00 00'
                    ].join(' ')
                },
                algorithm: 'hmac-sha1',
                skipKdf: false,
                includeOtherOptions: true,
                includePseudoHeader: true
            });
            if (!tcpAoStateResult || tcpAoStateResult.status !== 'success') return tcpAoStateResult;
            return { status: 'success' };
        })()
    `,
        'seed tools demo history'
    );

    const tcpServer = startNodeProcess(
        'mockTcpServer.js',
        ['--host', '127.0.0.1', '--port', String(TCP_TOOL_DOCS_PORT), '--echo'],
        { readyPattern: '交互式 TCP 服务端已启动', timeoutMs: 10000 }
    );
    longRunningProcesses.push(tcpServer.child);
    await tcpServer.ready;

    const udpServer = startNodeProcess(
        'mockUdpServer.js',
        ['--host', '127.0.0.1', '--port', String(UDP_TOOL_DOCS_PORT), '--echo'],
        { readyPattern: '交互式 UDP 服务端已启动', timeoutMs: 10000 }
    );
    longRunningProcesses.push(udpServer.child);
    await udpServer.ready;

    pagePreparers.set('/tools/string-generator', async pageWin => {
        await pageWin.webContents.executeJavaScript(`
            Array.from(document.querySelectorAll('button'))
                .find(button => button.textContent.includes('立即生成'))?.click();
        `);
    });
    pagePreparers.set('/tools/packet-parser', async pageWin => {
        await pageWin.webContents.executeJavaScript(`
            Array.from(document.querySelectorAll('button'))
                .find(button => button.textContent.includes('识别历史'))?.click();
        `);
    });
    pageCleanups.set('/tools/packet-parser', async pageWin => {
        await closeOpenOverlay(pageWin);
    });
    pagePreparers.set('/tools/tcp-tool', prepareTcpToolPage);
    pagePreparers.set('/tools/udp-tool', prepareUdpToolPage);
}

async function awaitDocsTask(taskManager, response, action) {
    assertSuccess(response, action);
    const taskId = response?.data?.taskId;
    const task = taskId ? taskManager?.tasks?.get(taskId) : null;
    if (!taskId || !task?.promise) {
        throw new Error(`${action} did not return a managed task`);
    }
    await task.promise;
    if (task.status !== 'completed') {
        throw new Error(`${action} failed: ${task.error?.message || task.status || 'unknown task error'}`);
    }
    return task.result;
}

function schemaNodesFromResponse(response, action) {
    assertSuccess(response, action);
    const data = response?.data;
    const nodes = Array.isArray(data) ? data : data?.nodes || data?.items || data?.roots || [];
    if (!Array.isArray(nodes)) throw new Error(`${action} did not return a Schema node list`);
    return nodes;
}

function findNamedSchemaNode(nodes, name) {
    return nodes.find(
        node =>
            String(node?.name || node?.title || '')
                .split(':')
                .at(-1) === name
    );
}

async function findYangDocsEditableNode(event, yangApp, profileId, compileId) {
    const query = { profileId, compileId };
    const roots = schemaNodesFromResponse(
        await yangApp.handleGetSchemaRoots(event, query),
        'load YANG docs Schema roots'
    );
    const moduleNode = findNamedSchemaNode(roots, 'netnexus-mock-device');
    if (!moduleNode?.id) throw new Error('netnexus-mock-device Schema root is unavailable');

    let parent = moduleNode;
    for (const name of ['interfaces', 'interface', 'enabled']) {
        const children = schemaNodesFromResponse(
            await yangApp.handleGetSchemaChildren(event, { ...query, parentId: parent.id }),
            `load YANG docs Schema children for ${parent.name || parent.title || parent.id}`
        );
        const child = findNamedSchemaNode(children, name);
        if (!child?.id) throw new Error(`YANG docs Schema node is unavailable: ${name}`);
        parent = child;
    }
    return parent;
}

async function setupYangDemo(win, systemApp) {
    netconfDocsMockServer = new MockNetconfServer({
        host: '127.0.0.1',
        port: 0,
        username: 'netconf',
        password: 'netconf',
        quiet: true
    });
    const serverStatus = await netconfDocsMockServer.start();
    const event = { sender: win.webContents };
    const netconfApp = systemApp.netconfApp;
    const yangApp = systemApp.yangApp;

    const profileResult = await netconfApp.handleSaveProfile(event, {
        name: 'Local NETCONF Mock',
        host: serverStatus.host,
        port: serverStatus.port,
        username: 'netconf',
        password: 'netconf',
        authMethod: 'password',
        hostKeyPolicy: 'accept-new',
        rememberCredentials: false,
        connectTimeout: 5000,
        rpcTimeout: 30000,
        keepaliveInterval: 0,
        autoReconnect: false
    });
    assertSuccess(profileResult, 'save YANG docs NETCONF profile');
    const profileId = profileResult.data?.id;
    if (!profileId) throw new Error('YANG docs NETCONF profile ID is unavailable');

    const connectResult = await netconfApp.handleConnect(event, profileId);
    assertSuccess(connectResult, 'connect YANG docs NETCONF profile');

    const inventoryResult = await netconfApp.handleDiscoverModules(event, profileId);
    assertSuccess(inventoryResult, 'discover YANG docs modules');
    const deviceModule = (inventoryResult.data?.modules || []).find(module => module.name === 'netnexus-mock-device');
    if (!deviceModule) throw new Error('NETCONF mock did not advertise netnexus-mock-device');

    const downloadResult = await netconfApp.handleDownloadModules(event, {
        profileId,
        modules: [{ name: deviceModule.name, revision: deviceModule.revision }],
        includeDependencies: true
    });
    await awaitDocsTask(netconfApp.taskManager, downloadResult, 'download YANG docs modules');

    const modulesResult = await yangApp.handleListModules(event, { profileId });
    assertSuccess(modulesResult, 'list downloaded YANG docs modules');
    const localModuleNames = new Set((modulesResult.data || []).map(module => module.name));
    for (const moduleName of ['netnexus-mock-device', 'netnexus-mock-types']) {
        if (!localModuleNames.has(moduleName)) {
            throw new Error(`downloaded YANG docs module is unavailable: ${moduleName}`);
        }
    }

    const compileResult = await yangApp.handleCompile(event, { profileId });
    await awaitDocsTask(yangApp.taskManager, compileResult, 'compile YANG docs modules');
    const workspaceResult = await yangApp.handleGetWorkspace(event, { profileId });
    assertSuccess(workspaceResult, 'load compiled YANG docs workspace');
    if (!workspaceResult.data?.compileId || workspaceResult.data?.success !== true) {
        throw new Error(`YANG docs workspace was not compiled: ${JSON.stringify(workspaceResult.data?.summary || {})}`);
    }
    const compileId = workspaceResult.data.compileId;
    const editableNode = await findYangDocsEditableNode(event, yangApp, profileId, compileId);
    yangDocsContext = {
        profileId,
        compileId,
        editableNodeId: editableNode.id,
        editableNodePath: editableNode.path || ''
    };

    const subscriptionResult = await netconfApp.handleExecuteOperation(event, {
        profileId,
        operation: 'establish-subscription',
        targetType: 'stream',
        stream: 'NETCONF'
    });
    assertSuccess(subscriptionResult, 'establish YANG docs notification subscription');
    await waitForRendererCondition(
        win,
        `
        (async () => {
            const result = await window.netconfApi.getSubscriptions({ profileId: ${JSON.stringify(profileId)} });
            const subscriptions = result?.data?.subscriptions || result?.data?.items || result?.data || [];
            const items = Array.isArray(subscriptions) ? subscriptions : [];
            return {
                ready: result?.status === 'success' && items.some(item =>
                    ['active', 'started'].includes(String(item.state || item.status || '').toLowerCase())
                ),
                total: items.length,
                states: items.map(item => item.state || item.status)
            };
        })()
    `,
        'YANG docs notification subscription',
        15000
    );

    netconfDocsMockServer.notify('NetNexus 文档演示通知');
    await waitForRendererCondition(
        win,
        `
        (async () => {
            const result = await window.netconfApi.getNotificationHistory({ profileId: ${JSON.stringify(profileId)} });
            const notifications = result?.data?.notifications || [];
            return {
                ready:
                    result?.status === 'success' &&
                    notifications.some(item =>
                        String(item.eventName || '').includes('mock-event') &&
                        String(item.xml || item.rawXml || '').includes('NetNexus 文档演示通知')
                    ),
                total: notifications.length,
                events: notifications.map(item => item.eventName)
            };
        })()
    `,
        'YANG docs notification history',
        15000
    );

    console.log(
        `YANG docs demo ready: ${JSON.stringify({
            profileId,
            editableNode: yangDocsContext.editableNodePath || yangDocsContext.editableNodeId,
            modules: localModuleNames.size,
            schemaNodes: workspaceResult.data?.summary?.nodeCount || 0,
            notification: true
        })}`
    );
}

async function setupDocsDemoData(win, runtimeDir, longRunningProcesses, systemApp) {
    pagePreparers.set('/bgp/bgp-config', prepareBgpConfigPage);
    pagePreparers.set('/bgp/route-mvpn', prepareBgpMvpnPage);
    pagePreparers.set('/yang/yang-connection', prepareYangConnectionPage);
    pagePreparers.set('/yang/yang-modules', prepareYangModulesPage);
    pagePreparers.set('/yang/yang-workspace', prepareYangWorkspacePage);
    pagePreparers.set('/monitor/netconf-notifications', prepareYangNotificationsPage);
    pagePreparers.set('/snmp/snmp-mib-compile', prepareSnmpMibCompilerPage);
    pagePreparers.set('/snmp/snmp-mib', prepareSnmpMibTreePage);
    if (SCREENSHOT_SCOPE === 'yang') {
        systemApp.applyLogLevel('off');
        await setupYangDemo(win, systemApp);
        return;
    }
    await setupSettingsDemo(win);
    // Keep the persisted demo selection visible in Settings while avoiding
    // high-volume protocol logs during the full documentation capture.
    systemApp.applyLogLevel('off');
    await setupBgpDemo(win, longRunningProcesses);
    await startBmpForDocs(win);
    const mock = startMockBmpClient();
    longRunningProcesses.push(mock.child);
    await mock.ready;
    const bmpState = await waitForBmpMockData(win);
    bmpDocsClientKey = bmpState.clientKey;
    await setupRpkiDemo(win);
    await setupYangDemo(win, systemApp);
    await setupFtpDemo(win, runtimeDir);
    await setupDhcpDemo(win);
    await setupSnmpDemo(win, longRunningProcesses);
    await setupNtpDemo(win);
    await setupRadiusDemo(win);
    await setupTftpDemo(win, runtimeDir);
    await setupSyslogDemo(win);
    await setupToolsDemo(win, longRunningProcesses);
}

async function stopRunningServices(systemApp) {
    const services = [
        ['bgpApp', 'getBgpRunning', 'handleStopBgp'],
        ['bmpApp', 'getBmpRunning', 'handleStopBmp'],
        ['rpkiApp', 'getRpkiRunning', 'handleStopRpki'],
        ['ftpApp', 'getFtpRunning', 'handleStopFtp'],
        ['snmpApp', 'getSnmpRunning', 'handleStopSnmp'],
        ['dhcpApp', 'getDhcpRunning', 'handleStopDhcp'],
        ['ntpApp', 'getNtpRunning', 'handleStopNtp'],
        ['radiusApp', 'getRadiusRunning', 'handleStopRadius'],
        ['tftpApp', 'getTftpRunning', 'handleStopTftp'],
        ['syslogApp', 'getSyslogRunning', 'handleStopSyslog']
    ];

    for (const [appName, isRunningMethod, stopMethod] of services) {
        const service = systemApp[appName];
        if (service && typeof service[isRunningMethod] === 'function' && service[isRunningMethod]()) {
            try {
                await service[stopMethod]();
            } catch (error) {
                warnOptional(error, `stop ${appName}`);
            }
        }
    }
}

async function stopNetconfDocsMockServer() {
    const server = netconfDocsMockServer;
    netconfDocsMockServer = null;
    if (!server) return;
    try {
        await server.stop();
    } catch (error) {
        warnOptional(error, 'stop NETCONF docs mock server');
    }
}

async function run() {
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('force-device-scale-factor', '1');
    // The standalone startup banner is captured before the application window.
    // Keep Electron alive when that temporary window is destroyed.
    app.on('window-all-closed', () => {});
    const userDataPath = path.join(os.tmpdir(), 'netnexus-docs-screenshots');
    await fs.rm(userDataPath, { recursive: true, force: true });
    app.setPath('userData', userDataPath);

    await app.whenReady();

    const selectedScreenshots = screenshots.filter(matchesScreenshotScope);
    const captureSettings = (!SCREENSHOT_SCOPE && !SCREENSHOT_MATCH) || SCREENSHOT_SCOPE === 'setting';
    if ((SCREENSHOT_SCOPE || SCREENSHOT_MATCH) && selectedScreenshots.length === 0 && !captureSettings) {
        throw new Error(
            `no documentation screenshots matched scope=${SCREENSHOT_SCOPE || '*'} match=${SCREENSHOT_MATCH || '*'}`
        );
    }

    const startupScreenshots = selectedScreenshots.filter(
        screenshot => normalizeScreenshotEntry(screenshot).kind === 'startup'
    );
    for (const screenshot of startupScreenshots) {
        await captureStartupBanner(normalizeScreenshotEntry(screenshot).outputPath);
    }

    const pageScreenshots = selectedScreenshots.filter(
        screenshot => normalizeScreenshotEntry(screenshot).kind !== 'startup'
    );
    if (pageScreenshots.length === 0 && !captureSettings) {
        app.quit();
        return;
    }

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

    const monitorWindowManager = new MonitorWindowManager({
        rendererUrl: BASE_URL,
        preloadPath: path.join(__dirname, '../electron/preload.js')
    });
    monitorWindowManager.registerIpcHandlers(ipcMain);
    const systemApp = new SystemApp(ipcMain, win, null, { monitorWindowManager });
    await systemApp.loadSettings();

    await win.loadURL(`${BASE_URL}/#/tools/string-generator`);
    await waitForRendererReady(win);
    await wait(900);

    const longRunningProcesses = [];
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'netnexus-docs-runtime-'));
    try {
        await setupDocsDemoData(win, runtimeDir, longRunningProcesses, systemApp);

        for (const screenshot of pageScreenshots) {
            const normalizedScreenshot = normalizeScreenshotEntry(screenshot);
            if (normalizedScreenshot.kind === 'monitor') {
                await openAndCaptureMonitor(monitorWindowManager, normalizedScreenshot);
            } else {
                const { route, outputPath, prepare, cleanup } = normalizedScreenshot;
                await navigateAndCapture(win, route, outputPath, prepare, cleanup);
            }
        }
        if (captureSettings) {
            await captureSettingsScreenshots(win);
        }
    } finally {
        monitorWindowManager.closeAll();
        for (const child of [...longRunningProcesses].reverse()) {
            await stopChildProcess(child);
        }
        await stopRunningServices(systemApp);
        await fs.rm(runtimeDir, { recursive: true, force: true });
        try {
            // Documentation fixtures intentionally keep a NETCONF session active.
            // Close it before SystemApp's interactive shutdown guard so headless
            // capture never waits on a native confirmation dialog.
            await systemApp.netconfApp.closeAll();
            await systemApp.handleWindowClose();
        } finally {
            await stopNetconfDocsMockServer();
        }
        win.destroy();
        app.quit();
    }
}

run().catch(error => {
    console.error(error);
    app.exit(1);
});
