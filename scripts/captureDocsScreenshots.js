const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const SystemApp = require('../electron/app/systemApp');
const BgpConst = require('../electron/const/bgpConst');

const BASE_URL = process.env.NETNEXUS_DOCS_URL || 'http://127.0.0.1:3000';
const OUTPUT_ROOT = path.join(__dirname, '..');
const NODE_PATH = process.env.NETNEXUS_NODE || process.env.npm_node_execpath || 'node';
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
const DEFAULT_WINDOW_WIDTH = 1920;
const DEFAULT_WINDOW_HEIGHT = 1200;

const screenshots = [
    ['/bgp/bgp-config', 'docs/images/bgp/bgp-config.png'],
    ['/bgp/bgp-peer-config', 'docs/images/bgp/bgp-peer.png'],
    ['/bgp/route-ipv4', 'docs/images/bgp/bgp-route.png'],
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
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    ['/bmp/bgp-session', 'docs/images/bmp/bmp-client-and-bgp-monitor-peer-info.png'],
    {
        route: '/bmp/bgp-session',
        outputPath: 'docs/images/bmp/bmp-session-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    {
        route: '/bmp/bgp-session',
        outputPath: 'docs/images/bmp/bmp-session-route-detail.png',
        prepare: 'open-bmp-session-route-detail',
        cleanup: 'close-overlay'
    },
    ['/bmp/bgp-loc-rib', 'docs/images/bmp/bmp-monitor-bgp-route.png'],
    {
        route: '/bmp/bgp-loc-rib',
        outputPath: 'docs/images/bmp/bmp-loc-rib-instance-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    {
        route: '/bmp/bgp-loc-rib',
        outputPath: 'docs/images/bmp/bmp-loc-rib-route-detail.png',
        prepare: 'open-bmp-loc-rib-route-detail',
        cleanup: 'close-overlay'
    },
    ['/bmp/bgp-session-statis-report', 'docs/images/bmp/bmp-session-statis-report.png'],
    {
        route: '/bmp/bgp-session-statis-report',
        outputPath: 'docs/images/bmp/bmp-session-statis-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    ['/bmp/bgp-loc-rib-statis-report', 'docs/images/bmp/bmp-loc-rib-statis-report.png'],
    {
        route: '/bmp/bgp-loc-rib-statis-report',
        outputPath: 'docs/images/bmp/bmp-loc-rib-statis-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
    ['/rpki/rpki-config', 'docs/images/rpki/rpki-config-and-client.png'],
    ['/rpki/rpki-roa-config', 'docs/images/rpki/rpki-roa.png'],
    ['/rpki/rpki-router-key-config', 'docs/images/rpki/rpki-router-key.png'],
    ['/rpki/rpki-aspa-config', 'docs/images/rpki/rpki-aspa.png'],
    ['/snmp/snmp-config', 'docs/images/snmp/snmp-config.png'],
    ['/snmp/snmp-trap', 'docs/images/snmp/snmp-trap.png'],
    {
        route: '/snmp/snmp-trap',
        outputPath: 'docs/images/snmp/snmp-trap-detail.png',
        prepare: 'open-text-detail-0',
        cleanup: 'close-overlay'
    },
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
    ['/syslog/syslog-message-log', 'docs/images/syslog/syslog-message-log.png'],
    {
        route: '/syslog/syslog-message-log',
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
    await closeOpenOverlay(win);
    await wait(150);
    await win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(route)}`);
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

async function capturePage(win, label, outputPath) {
    await win.webContents.executeJavaScript('document.fonts && document.fonts.ready');
    await win.webContents.executeJavaScript(`
        (() => {
            let style = document.getElementById('docs-screenshot-hide-overlays');
            if (!style) {
                style = document.createElement('style');
                style.id = 'docs-screenshot-hide-overlays';
                document.head.appendChild(style);
            }
            style.textContent = '.nn-toast-host, .update-notification { display: none !important; }';
        })();
        document.querySelectorAll(
            '.nn-toast, .update-notification, [class*="update-notification"]'
        ).forEach(element => {
            element.remove();
        });
    `);
    const image = await win.capturePage();
    const absoluteOutputPath = path.join(OUTPUT_ROOT, outputPath);
    await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
    await fs.writeFile(absoluteOutputPath, image.toPNG());
    console.log(`captured ${label} -> ${outputPath}`);
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
            return {
                ready:
                    Boolean(overlay) &&
                    !spinning &&
                    text.length > 10 &&
                    !hasEmptyDetail &&
                    (!expectedText || text.includes(expectedText)),
                text: text.slice(0, 80),
                overlays: overlays.length,
                matchingOverlays: matchingOverlays.length,
                spinning
            };
        })()
    `,
        label,
        10000
    );
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
            const input = document.querySelector('.mib-query-row input');
            const button = Array.from(document.querySelectorAll('.mib-query-row button'))
                .find(item => item.textContent.includes('解析OID'));
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

    await waitForOpenOverlay(win, 'SNMP MIB OID parse result', 'OID解析结果');
    await closeOpenOverlay(win);
    await waitForRendererCondition(
        win,
        `
        (() => {
            const target = document.querySelector('.mib-node-title[data-tree-oid="${targetOid}"]');
            const detailText = document.querySelector('.mib-node-detail')?.textContent || '';
            return {
                ready: Boolean(target) && detailText.includes('demoWritableName'),
                targetVisible: Boolean(target),
                detailText: detailText.slice(0, 120)
            };
        })()
    `,
        'SNMP MIB expanded tree',
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
                ready: Boolean(menu) && text.includes('复制OID') && text.includes('GET 查询') && text.includes('SET 设置'),
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

    await waitForOpenOverlay(win, label, 'SNMP WALK');
    const started = await win.webContents.executeJavaScript(`
        (() => {
            const button = Array.from(document.querySelectorAll('.walk-modal-wrap .nn-modal-footer button'))
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
            const modal = document.querySelector('.walk-modal-wrap');
            const textarea = modal?.querySelector('textarea');
            const text = modal?.textContent || '';
            const output = textarea?.value || '';
            return {
                ready: Boolean(modal) && text.includes('3 条') && output.includes('demoAgentName'),
                text: text.slice(0, 240),
                output: output.slice(0, 240)
            };
        })()
    `,
        label,
        10000
    );
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

screenshotPreparers.set('open-text-detail-0', (win, label) => openDetailButtonByText(win, 0, label));
screenshotPreparers.set('open-bmp-session-route-detail', (win, label) =>
    openDetailButtonBySelector(win, '[data-testid="bmp-session-route-table"] .nn-table-tbody button', label)
);
screenshotPreparers.set('open-bmp-loc-rib-route-detail', (win, label) =>
    openDetailButtonBySelector(win, '[data-testid="bmp-loc-rib-route-table"] .nn-table-tbody button', label)
);
screenshotPreparers.set('open-tcp-ao-result', openTcpAoResult);
screenshotPreparers.set('open-snmp-mib-context-menu', openSnmpMibContextMenu);
screenshotPreparers.set('open-snmp-mib-walk', openSnmpMibWalkModal);
screenshotPreparers.set('open-ftp-users', openFtpUsersModal);
screenshotPreparers.set('open-route-advanced-config', openRouteAdvancedConfig);
screenshotCleanups.set('close-overlay', closeOpenOverlay);
screenshotCleanups.set('close-snmp-context-menu', closeSnmpMibContextMenu);

async function selectSettingsCategory(win, categoryText) {
    await win.webContents.executeJavaScript(`
        (() => {
            const categoryText = ${JSON.stringify(categoryText)};
            const items = Array.from(document.querySelectorAll('.settings-dialog-modal .nn-menu-item'));
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
        document.querySelector('.settings-dialog-modal .nn-modal-close')?.click();
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
    await selectSettingsCategory(win, '工具集合');
    await capturePage(win, 'settings/tools', 'docs/images/setting/setting-tools.png');
    await selectSettingsCategory(win, 'FTP服务器');
    await capturePage(win, 'settings/ftp', 'docs/images/setting/setting-ftp.png');
    await selectSettingsCategory(win, '外部API');
    await capturePage(win, 'settings/api', 'docs/images/setting/setting-api.png');
    await selectSettingsCategory(win, '服务器部署');
    await capturePage(win, 'settings/server-deployment', 'docs/images/setting/setting-server-deployment.png');
    await selectSettingsCategory(win, '应用更新');
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
    const child = spawn(NODE_PATH, args, {
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
                localPort: '',
                enableAuth: false,
                peerIP: '',
                md5Password: '',
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

async function setupDocsDemoData(win, runtimeDir, longRunningProcesses) {
    pagePreparers.set('/bgp/bgp-config', prepareBgpConfigPage);
    pagePreparers.set('/bgp/route-mvpn', prepareBgpMvpnPage);
    pagePreparers.set('/snmp/snmp-mib', prepareSnmpMibTreePage);
    await setupSettingsDemo(win);
    await setupBgpDemo(win, longRunningProcesses);
    await startBmpForDocs(win);
    const mock = startMockBmpClient();
    longRunningProcesses.push(mock.child);
    await mock.ready;
    await waitForBmpMockData(win);
    await setupRpkiDemo(win);
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

async function run() {
    app.commandLine.appendSwitch('disable-gpu');
    const userDataPath = path.join(os.tmpdir(), 'netnexus-docs-screenshots');
    await fs.rm(userDataPath, { recursive: true, force: true });
    app.setPath('userData', userDataPath);

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

    const longRunningProcesses = [];
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'netnexus-docs-runtime-'));
    try {
        await setupDocsDemoData(win, runtimeDir, longRunningProcesses);

        for (const screenshot of screenshots) {
            const { route, outputPath, prepare, cleanup } = normalizeScreenshotEntry(screenshot);
            await navigateAndCapture(win, route, outputPath, prepare, cleanup);
        }
        await captureSettingsScreenshots(win);
    } finally {
        for (const child of [...longRunningProcesses].reverse()) {
            await stopChildProcess(child);
        }
        await stopRunningServices(systemApp);
        await fs.rm(runtimeDir, { recursive: true, force: true });
        await systemApp.handleWindowClose();
        win.destroy();
        app.quit();
    }
}

run().catch(error => {
    console.error(error);
    app.exit(1);
});
