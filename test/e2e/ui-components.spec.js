const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e } = require('../../scripts/e2e-support');

const fullHeightPageRoutes = [
    '/#/tools/string-generator',
    '/#/tools/packet-parser',
    '/#/tools/port-monitor',
    '/#/tools/network-info',
    '/#/tools/tcp-ao-mac',
    '/#/tools/http-api-tester',
    '/#/tools/tcp-tool',
    '/#/tools/udp-tool',
    '/#/bgp/bgp-config',
    '/#/bgp/bgp-peer-config',
    '/#/bgp/route-ipv4',
    '/#/bgp/route-ipv6',
    '/#/bgp/route-mvpn',
    '/#/bgp/route-ipv4-qp',
    '/#/bgp/route-ipv6-qp',
    '/#/bmp/bmp-config',
    '/#/bmp/bgp-session',
    '/#/bmp/bgp-loc-rib',
    '/#/bmp/bgp-session-statis-report',
    '/#/bmp/bgp-loc-rib-statis-report',
    '/#/rpki/rpki-config',
    '/#/rpki/rpki-roa-config',
    '/#/rpki/rpki-router-key-config',
    '/#/rpki/rpki-aspa-config',
    '/#/ftp/ftp-config',
    '/#/snmp/snmp-config',
    '/#/snmp/snmp-mib',
    '/#/snmp/snmp-trap',
    '/#/dhcp/dhcp-config',
    '/#/dhcp/dhcp-lease',
    '/#/ntp/ntp-config',
    '/#/ntp/ntp-request-log',
    '/#/radius/radius-config',
    '/#/radius/radius-request-log',
    '/#/radius/radius-session',
    '/#/tftp/tftp-config',
    '/#/tftp/tftp-transfer-log',
    '/#/syslog/syslog-config',
    '/#/syslog/syslog-message-log'
];

const moduleDefaultRoutes = [
    ['/#/tools', '/#/tools/string-generator'],
    ['/#/bgp', '/#/bgp/bgp-config'],
    ['/#/bmp', '/#/bmp/bmp-config'],
    ['/#/rpki', '/#/rpki/rpki-config'],
    ['/#/ftp', '/#/ftp/ftp-config'],
    ['/#/snmp', '/#/snmp/snmp-config'],
    ['/#/dhcp', '/#/dhcp/dhcp-config'],
    ['/#/ntp', '/#/ntp/ntp-config'],
    ['/#/radius', '/#/radius/radius-config'],
    ['/#/tftp', '/#/tftp/tftp-config'],
    ['/#/syslog', '/#/syslog/syslog-config']
];

async function openSettingsDialog(page) {
    const moreOptions = page.getByRole('button', { name: '更多选项' });
    await moreOptions.click();

    const settingsMenuItem = page.getByRole('menuitem', { name: '设置', exact: true });
    await expect(settingsMenuItem).toBeVisible();
    await settingsMenuItem.click();

    const settingsDialog = page.getByRole('dialog', { name: '设置' });
    await expect(settingsDialog).toBeVisible();
    return settingsDialog;
}

async function getMenuIconShapes(menu, itemNames) {
    const shapes = {};

    for (const itemName of itemNames) {
        const icon = menu.getByRole('menuitem', { name: itemName, exact: true }).locator('svg.nn-icon');
        await expect(icon).toHaveCount(1);
        shapes[itemName] = await icon.evaluate(element => element.innerHTML);
    }

    return shapes;
}

async function getEmptyVisualSnapshot(emptyState) {
    return emptyState.evaluate(element => {
        const image = element.querySelector('.nn-empty-image');
        const description = element.querySelector('.nn-empty-description');
        const surface = element.querySelector('.nn-empty-image-surface');
        const line = element.querySelector('.nn-empty-image-line');
        const accent = element.querySelector('.nn-empty-image-accent');
        const rootStyle = getComputedStyle(element);
        const imageStyle = getComputedStyle(image);
        const descriptionStyle = getComputedStyle(description);

        return {
            root: {
                minHeight: rootStyle.minHeight,
                padding: rootStyle.padding,
                color: rootStyle.color
            },
            image: {
                width: imageStyle.width,
                height: imageStyle.height,
                marginBottom: imageStyle.marginBottom
            },
            description: {
                color: descriptionStyle.color,
                fontSize: descriptionStyle.fontSize,
                lineHeight: descriptionStyle.lineHeight
            },
            illustration: {
                surfaceFill: getComputedStyle(surface).fill,
                surfaceStroke: getComputedStyle(surface).stroke,
                lineStroke: getComputedStyle(line).stroke,
                accentStroke: getComputedStyle(accent).stroke
            }
        };
    });
}

async function dragFromCenter(page, locator, targetX, targetY) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(targetX, targetY, { steps: 8 });
    await page.mouse.up();
}

async function expectSnmpMibLayout(page, expectedSidebarWidth) {
    await expect
        .poll(async () => {
            const geometry = await page.evaluate(() => {
                const sidebar = document.querySelector('.main-layout > .sider');
                const mainContent = document.querySelector('.main-layout > .content-container');
                const fixedTabs = document.querySelector('.nn-main-container > .fixed-tabs');
                const fixedTabsNavWrap = fixedTabs?.querySelector('.nn-tabs-nav-wrap');
                const mibCard = document.querySelector('.snmp-mib-page .mib-card');
                const firstTab = document.querySelector('.fixed-tabs .nn-tabs-tab');
                const sidebarBox = sidebar?.getBoundingClientRect();
                const mainContentBox = mainContent?.getBoundingClientRect();
                const fixedTabsBox = fixedTabs?.getBoundingClientRect();
                const mibCardBox = mibCard?.getBoundingClientRect();
                const firstTabBox = firstTab?.getBoundingClientRect();

                if (
                    !sidebarBox ||
                    !mainContentBox ||
                    !fixedTabsBox ||
                    !fixedTabsNavWrap ||
                    !mibCardBox ||
                    !firstTabBox
                ) {
                    return null;
                }

                return {
                    sidebarWidth: sidebarBox.width,
                    mainContentGap: mainContentBox.left - sidebarBox.right,
                    cardLeftInset: mibCardBox.left - mainContentBox.left,
                    cardRightInset: window.innerWidth - mibCardBox.right,
                    cardTopInset: mibCardBox.top - fixedTabsBox.bottom,
                    cardBottomInset: window.innerHeight - mibCardBox.bottom,
                    tabsCardAlignment: firstTabBox.left - mibCardBox.left,
                    fixedTabsOverflowY: getComputedStyle(fixedTabsNavWrap).overflowY,
                    fixedTabsVerticalScrollbarWidth: fixedTabsNavWrap.offsetWidth - fixedTabsNavWrap.clientWidth
                };
            });

            if (!geometry) {
                return Number.POSITIVE_INFINITY;
            }

            if (geometry.fixedTabsOverflowY !== 'hidden') {
                return Number.POSITIVE_INFINITY;
            }

            return Math.max(
                Math.abs(geometry.sidebarWidth - expectedSidebarWidth),
                Math.abs(geometry.mainContentGap),
                Math.abs(geometry.cardLeftInset - 8),
                Math.abs(geometry.cardRightInset - 8),
                Math.abs(geometry.cardTopInset - 6),
                Math.abs(geometry.cardBottomInset - 6),
                Math.abs(geometry.tabsCardAlignment),
                Math.abs(geometry.fixedTabsVerticalScrollbarWidth)
            );
        })
        .toBeLessThanOrEqual(1);
}

async function expectFullHeightPageLayout(page, route) {
    await page.goto(route);

    const pageRoot = page.locator('.nn-main-container > .content-container > .nn-container');
    await expect(pageRoot).toBeVisible();

    await expect
        .poll(async () => {
            const geometry = await page.evaluate(() => {
                const content = document.querySelector('.nn-main-container > .content-container');
                const root = content?.querySelector(':scope > .nn-container');
                const contentBox = content?.getBoundingClientRect();
                const rootBox = root?.getBoundingClientRect();

                if (!content || !contentBox || !rootBox) {
                    return null;
                }

                return {
                    top: rootBox.top - contentBox.top,
                    right: contentBox.right - rootBox.right,
                    bottom: contentBox.bottom - rootBox.bottom,
                    left: rootBox.left - contentBox.left,
                    parentOverflow: content.scrollHeight - content.clientHeight
                };
            });

            if (!geometry) {
                return Number.POSITIVE_INFINITY;
            }

            return Math.max(
                Math.abs(geometry.top - 6),
                Math.abs(geometry.right - 8),
                Math.abs(geometry.bottom - 6),
                Math.abs(geometry.left - 8),
                Math.max(0, geometry.parentOverflow)
            );
        })
        .toBeLessThanOrEqual(1);
}

async function installLayoutApiFallbacks(page) {
    await page.addInitScript(() => {
        const success = data => Promise.resolve({ status: 'success', msg: '', data });
        const installFallback = (apiName, fallbackData) => {
            let target = window[apiName] || {};
            const proxy = new Proxy(
                {},
                {
                    get(_proxyTarget, property) {
                        if (property in target) {
                            return Reflect.get(target, property, target);
                        }
                        return () => success(fallbackData[property] ?? null);
                    }
                }
            );

            Object.defineProperty(window, apiName, {
                configurable: true,
                get: () => proxy,
                set: value => {
                    target = value || {};
                }
            });
        };

        installFallback('bgpApi', {
            getInstanceInfo: [],
            getPeerInfo: {},
            getRoutes: { list: [], total: 0 }
        });
        installFallback('bmpApi', {
            getBgpInstanceRoutes: { list: [], total: 0 },
            getBgpInstanceStatisticsReports: [],
            getBgpInstances: [],
            getBgpRoutes: { list: [], total: 0 },
            getBgpSessions: [],
            getBgpStatisticsReports: [],
            getClientList: []
        });
    });
}

test.describe('Custom UI component interactions', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('navigates with the main sidebar menu', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');
        await expect(page.getByText('报文解析器', { exact: true })).toBeVisible();

        const ntpMenuItem = page.locator('.main-menu').getByRole('menuitem', { name: 'NTP服务器' });
        await ntpMenuItem.click();

        await expect(page).toHaveURL(/#\/ntp\/ntp-config$/u);
        await expect(page.getByText('NTP服务器配置', { exact: true })).toBeVisible();
        await expect(ntpMenuItem).toHaveAttribute('aria-current', 'page');
    });

    test('uses compact typography for configuration helper text', async ({ page }) => {
        const helperTextPages = [
            { route: '/#/dhcp/dhcp-config', title: 'DHCP服务器配置', minimumCount: 1 },
            { route: '/#/tftp/tftp-config', title: 'TFTP服务器配置', minimumCount: 1 },
            { route: '/#/ntp/ntp-config', title: 'NTP服务器配置', minimumCount: 2 },
            { route: '/#/syslog/syslog-config', title: 'Syslog服务器配置', minimumCount: 1 },
            { route: '/#/rpki/rpki-config', title: 'RPKI服务器配置', minimumCount: 2 }
        ];

        for (const helperTextPage of helperTextPages) {
            await page.goto(helperTextPage.route);
            await expect(page.getByText(helperTextPage.title, { exact: true })).toBeVisible();

            const helperTexts = page.locator('.nn-helper-text');
            await expect(helperTexts.first()).toBeVisible();

            const styles = await helperTexts.evaluateAll(elements =>
                elements.map(element => ({
                    fontSize: getComputedStyle(element).fontSize,
                    lineHeight: getComputedStyle(element).lineHeight
                }))
            );

            expect(styles.length).toBeGreaterThanOrEqual(helperTextPage.minimumCount);
            expect(styles.every(style => style.fontSize === '12px' && style.lineHeight === '18px')).toBe(true);
        }
    });

    test('uses distinct navigation icons and keeps settings icons aligned with their pages', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/#/tools/packet-parser');

        const mainMenu = page.locator('.main-menu');
        const mainIconShapes = await getMenuIconShapes(mainMenu, [
            '工具集合',
            'BGP模拟器',
            'BMP服务器',
            'RPKI服务器',
            'FTP服务器',
            'SNMP服务器',
            'DHCP服务器',
            'NTP服务器',
            'RADIUS服务器',
            'TFTP服务器',
            'Syslog服务器'
        ]);
        expect(new Set(Object.values(mainIconShapes)).size).toBe(Object.keys(mainIconShapes).length);

        await page.getByRole('button', { name: '更多选项' }).click();
        const quickMenu = page.locator('.nn-dropdown-popup');
        await expect(quickMenu).toBeVisible();
        const quickIconShapes = await getMenuIconShapes(quickMenu, ['设置', '开发人员选项', '关于']);
        expect(new Set(Object.values(quickIconShapes)).size).toBe(Object.keys(quickIconShapes).length);

        await quickMenu.getByRole('menuitem', { name: '设置', exact: true }).click();
        const settingsDialog = page.getByRole('dialog', { name: '设置' });
        await expect(settingsDialog).toBeVisible();
        const settingsIconShapes = await getMenuIconShapes(settingsDialog.locator('.settings-menu'), [
            '通用设置',
            '工具集合',
            'FTP服务器',
            '外部API',
            '服务器部署',
            '运行时诊断',
            '应用更新'
        ]);
        expect(new Set(Object.values(settingsIconShapes)).size).toBe(Object.keys(settingsIconShapes).length);
        expect(settingsIconShapes['通用设置']).toBe(quickIconShapes['设置']);
        expect(settingsIconShapes['工具集合']).toBe(mainIconShapes['工具集合']);
        expect(settingsIconShapes['FTP服务器']).toBe(mainIconShapes['FTP服务器']);
    });

    test('keeps configuration labels compact, radio buttons joined and sidebar text regular', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await installLayoutApiFallbacks(page);
        await page.goto('/#/bmp/bmp-config');

        const localPortLabel = page.locator('.nn-form-item-label > label').filter({ hasText: '本地监听端口' });
        await expect(localPortLabel).toHaveCSS('font-size', '13px');
        await expect(localPortLabel).toHaveCSS('white-space', 'nowrap');
        expect(await localPortLabel.evaluate(label => label.scrollWidth <= label.parentElement.clientWidth)).toBe(true);

        const draft20Button = page.getByRole('radio', { name: 'draft-20', exact: true });
        const draft19Button = page.getByRole('radio', { name: 'draft-19', exact: true });
        await expect(draft20Button).toBeVisible();
        await expect(draft19Button).toBeVisible();
        expect(
            await draft20Button.evaluate(
                (firstButton, secondButton) => {
                    const firstBox = firstButton.getBoundingClientRect();
                    const secondBox = secondButton.getBoundingClientRect();
                    return secondBox.left - firstBox.right;
                },
                await draft19Button.elementHandle()
            )
        ).toBeLessThanOrEqual(0);

        const mainMenu = page.locator('.main-menu');
        const selectedMenuItem = mainMenu.getByRole('menuitem', { name: 'BMP服务器', exact: true });
        const regularMenuItem = mainMenu.getByRole('menuitem', { name: 'BGP模拟器', exact: true });
        await expect(selectedMenuItem).toHaveCSS('font-size', '13px');
        await expect(selectedMenuItem).toHaveCSS('font-weight', '400');
        await expect(regularMenuItem).toHaveCSS('font-size', '13px');
        await expect(regularMenuItem).toHaveCSS('font-weight', '400');
    });

    test('uses the shared empty illustration and typography for tables and page states', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await installLayoutApiFallbacks(page);
        await page.goto('/#/bmp/bmp-config');
        await page.evaluate(() => {
            document.documentElement.dataset.theme = 'light';
            delete document.documentElement.dataset.themePreset;
            document.documentElement.style.colorScheme = 'light';
        });

        const tableEmpty = page.locator('[data-testid="bmp-client-table"] .nn-table-placeholder .nn-empty');
        await expect(tableEmpty).toHaveCount(1);
        const tableImage = tableEmpty.locator('svg.nn-empty-image');
        const tableDescription = tableEmpty.locator('.nn-empty-description');
        await expect(tableImage).toBeVisible();
        await expect(tableDescription).toHaveText('暂无数据');
        await expect(tableDescription).toHaveCSS('font-size', '13px');
        const tableImageMarkup = await tableImage.evaluate(element => element.innerHTML);
        const tableVisual = await getEmptyVisualSnapshot(tableEmpty);

        await page.goto('/#/bmp/bgp-session');

        const pageEmpty = page.locator('.no-result-message .nn-empty');
        await expect(pageEmpty).toHaveCount(1);
        const pageImage = pageEmpty.locator('svg.nn-empty-image');
        const pageDescription = pageEmpty.locator('.nn-empty-description');
        await expect(pageImage).toBeVisible();
        await expect(pageDescription).toHaveText('暂无数据');
        await expect(pageDescription).toHaveCSS('font-size', '13px');
        expect(await pageImage.evaluate(element => element.innerHTML)).toBe(tableImageMarkup);
        const lightPageVisual = await getEmptyVisualSnapshot(pageEmpty);
        expect(lightPageVisual).toEqual(tableVisual);

        await page.evaluate(() => {
            document.documentElement.dataset.theme = 'dark';
            document.documentElement.dataset.themePreset = 'dark';
            document.documentElement.style.colorScheme = 'dark';
        });
        const darkPageVisual = await getEmptyVisualSnapshot(pageEmpty);
        expect(darkPageVisual.illustration.surfaceFill).not.toBe(lightPageVisual.illustration.surfaceFill);
        expect(darkPageVisual.illustration.lineStroke).not.toBe(lightPageVisual.illustration.lineStroke);
        expect(darkPageVisual.description.color).not.toBe(lightPageVisual.description.color);
    });

    test('keeps the current workspace when its main sidebar item is clicked again', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');

        const toolsMenuItem = page.locator('.main-menu').getByRole('menuitem', { name: '工具集合' });
        const packetParserPage = page.locator('.packet-parser-page');
        await expect(packetParserPage).toBeVisible();

        for (let clickCount = 0; clickCount < 2; clickCount += 1) {
            await toolsMenuItem.click();
            await expect(page).toHaveURL(/#\/tools\/packet-parser$/u);
            await expect(packetParserPage).toBeVisible();
            await expect(toolsMenuItem).toHaveAttribute('aria-current', 'page');
        }
    });

    test('redirects module roots without Vue Router configuration warnings', async ({ page }) => {
        const routerWarnings = [];
        page.on('console', message => {
            if (message.text().includes('[Vue Router warn]')) {
                routerWarnings.push(message.text());
            }
        });
        await installLayoutApiFallbacks(page);

        for (const [moduleRoute, defaultRoute] of moduleDefaultRoutes) {
            await page.goto(moduleRoute);
            await expect.poll(() => new URL(page.url()).hash).toBe(defaultRoute.slice(1));
            await expect(page.locator('.nn-main-container > .content-container > .nn-container')).toBeVisible();
        }

        expect(routerWarnings).toEqual([]);
    });

    test('keeps the SNMP MIB workspace aligned in expanded and collapsed layouts', async ({ page }) => {
        await page.setViewportSize({ width: 2056, height: 1209 });
        await page.goto('/#/snmp/snmp-mib');

        const sidebar = page.locator('.main-layout > .sider');
        const toggleButton = sidebar.locator('.toggle-btn .nn-button');
        const mibCard = page.locator('.snmp-mib-page .mib-card');
        await expect(mibCard).toBeVisible();

        if (await sidebar.evaluate(element => element.classList.contains('collapsed'))) {
            await toggleButton.click();
        }
        await expect(sidebar).not.toHaveClass(/collapsed/u);
        await expectSnmpMibLayout(page, 160);
        await toggleButton.click();
        await expect(sidebar).toHaveClass(/collapsed/u);
        await expectSnmpMibLayout(page, 60);
    });

    test('keeps every routed workspace aligned with equal top and bottom spacing', async ({ page }) => {
        test.setTimeout(90000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await installLayoutApiFallbacks(page);

        for (const route of fullHeightPageRoutes) {
            await test.step(route, async () => {
                await expectFullHeightPageLayout(page, route);
            });
        }
    });

    test('uses compact typography for API and loaded MIB lists', async ({ page }) => {
        await page.goto('/#/tools/http-api-tester');

        const apiListItem = page.locator('.api-list-item').first();
        await expect(apiListItem).toBeVisible();
        await expect.soft(apiListItem).toHaveCSS('font-size', '13px');
        await expect.soft(apiListItem).toHaveCSS('line-height', '18.2px');

        await page.goto('/#/snmp/snmp-mib');

        const mibFilePanelTitle = page.locator('.mib-file-block .mib-panel-title');
        const mibFileName = page.locator('.mib-file-name').first();
        await expect(mibFileName).toContainText('NETNEXUS-DEMO-MIB.mib');
        await expect.soft(mibFilePanelTitle).toHaveCSS('font-size', '13px');
        await expect.soft(mibFilePanelTitle).toHaveCSS('line-height', '18.2px');
        await expect.soft(mibFileName).toHaveCSS('font-size', '13px');
        await expect.soft(mibFileName).toHaveCSS('line-height', '18.2px');
    });

    test('uses compact typography for BGP neighbor lists', async ({ page }) => {
        await installLayoutApiFallbacks(page);
        await page.goto('/#/bgp/bgp-peer-config');

        await page.getByRole('tab', { name: 'IPv4-QP邻居', exact: true }).click();
        const qpPanel = page.getByRole('tabpanel', { name: 'IPv4-QP邻居' });
        const qpHeader = qpPanel.getByText('IPv4-QP邻居列表', { exact: true });
        const qpTable = page.getByTestId('bgp-ipv4-qp-peer-table');

        await expect(qpPanel).toBeVisible();
        await expect(qpHeader).toHaveCSS('font-size', '12px');
        await expect(qpHeader).toHaveCSS('line-height', '18px');
        await expect(qpTable.locator('.nn-table')).toHaveCSS('font-size', '12px');
    });

    test('uses a light themed receive panel for TCP and UDP', async ({ page }) => {
        for (const [route, panelSelector] of [
            ['/#/tools/tcp-tool', '.tcp-log-list'],
            ['/#/tools/udp-tool', '.udp-log-list']
        ]) {
            await test.step(route, async () => {
                await page.goto(route);
                await page.evaluate(() => {
                    document.documentElement.dataset.theme = 'light';
                    delete document.documentElement.dataset.themePreset;
                    document.documentElement.style.colorScheme = 'light';
                });

                const panelStyle = await page.locator(panelSelector).evaluate(element => {
                    const probe = document.createElement('span');
                    document.body.appendChild(probe);
                    const readToken = (property, token) => {
                        probe.style[property] = `var(${token})`;
                        return getComputedStyle(probe)[property];
                    };
                    const style = getComputedStyle(element);
                    const snapshot = {
                        background: style.backgroundColor,
                        color: style.color,
                        border: style.borderColor,
                        codeBackground: readToken('backgroundColor', '--nn-color-bg-code'),
                        consoleBackground: readToken('backgroundColor', '--nn-color-bg-console'),
                        text: readToken('color', '--nn-color-text'),
                        borderLight: readToken('borderColor', '--nn-color-border-light')
                    };
                    probe.remove();
                    return snapshot;
                });

                expect(panelStyle.background).toBe(panelStyle.codeBackground);
                expect(panelStyle.background).not.toBe(panelStyle.consoleBackground);
                expect(panelStyle.color).toBe(panelStyle.text);
                expect(panelStyle.border).toBe(panelStyle.borderLight);
            });
        }
    });

    test('keeps card header actions, icons and status badges visually aligned', async ({ page }) => {
        await page.goto('/#/tools/http-api-tester');

        const headerButtons = page.locator('.http-api-card .nn-card-extra .nn-button');
        await expect(headerButtons).toHaveCount(3);
        const buttonStyles = await headerButtons.evaluateAll(buttons =>
            buttons.map(button => {
                const style = getComputedStyle(button);
                const icon = button.querySelector('.nn-button-icon .nn-icon');
                return {
                    height: style.height,
                    fontSize: style.fontSize,
                    background: style.backgroundColor,
                    border: style.borderColor,
                    color: style.color,
                    iconSize: icon ? getComputedStyle(icon).fontSize : null
                };
            })
        );
        expect(new Set(buttonStyles.map(style => style.height))).toEqual(new Set(['24px']));
        expect(new Set(buttonStyles.map(style => style.fontSize))).toEqual(new Set(['12px']));
        expect(new Set(buttonStyles.map(style => style.background)).size).toBe(2);
        expect(buttonStyles[1]).toEqual(buttonStyles[2]);
        expect(buttonStyles[0].background).not.toBe(buttonStyles[1].background);
        expect(buttonStyles[0].color).not.toBe(buttonStyles[1].color);
        expect(new Set(buttonStyles.map(style => style.iconSize))).toEqual(new Set(['14px']));
        const maxColorChannelDifference = (firstColor, secondColor) => {
            const firstChannels = (firstColor.match(/[\d.]+/gu) || []).slice(0, 3).map(Number);
            const secondChannels = (secondColor.match(/[\d.]+/gu) || []).slice(0, 3).map(Number);
            return Math.max(...firstChannels.map((value, index) => Math.abs(value - secondChannels[index])));
        };

        const expectedHeaderColors = {
            orange: 'rgb(249, 115, 22)',
            blue: 'rgb(22, 119, 255)',
            dark: 'rgb(37, 99, 235)'
        };

        for (const preset of ['orange', 'blue', 'dark']) {
            await page.evaluate(nextPreset => {
                document.documentElement.dataset.theme = nextPreset === 'dark' ? 'dark' : 'light';
                document.documentElement.dataset.themePreset = nextPreset;
                document.documentElement.style.colorScheme = nextPreset === 'dark' ? 'dark' : 'light';
            }, preset);
            await expect
                .poll(
                    () =>
                        headerButtons.first().evaluate(button => {
                            const buttonColor = getComputedStyle(button).color;
                            if (!buttonColor) return -1;

                            return button
                                .getAnimations()
                                .filter(animation => animation.pending || animation.playState === 'running').length;
                        }),
                    { timeout: 2000 }
                )
                .toBe(0);

            const contrastStyle = await headerButtons.first().evaluate(button => {
                const header = button.closest('.nn-card-head');
                const probe = document.createElement('span');
                document.body.appendChild(probe);
                const readToken = (property, token) => {
                    probe.style[property] = `var(${token})`;
                    return getComputedStyle(probe)[property];
                };
                const parseRgb = color => (color.match(/[\d.]+/gu) || []).slice(0, 3).map(Number);
                const luminance = color => {
                    const channels = parseRgb(color).map(value => {
                        const normalized = value / 255;
                        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
                    });
                    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
                };
                const contrast = (foreground, background) => {
                    const first = luminance(foreground);
                    const second = luminance(background);
                    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
                };
                const buttonStyle = getComputedStyle(button);
                const headerStyle = getComputedStyle(header);
                const snapshot = {
                    background: buttonStyle.backgroundColor,
                    color: buttonStyle.color,
                    border: buttonStyle.borderColor,
                    shadow: buttonStyle.boxShadow,
                    headerBackground: headerStyle.backgroundColor,
                    controlTextContrast: contrast(buttonStyle.color, buttonStyle.backgroundColor),
                    controlBackground: readToken('backgroundColor', '--nn-color-bg-card-head-control'),
                    controlText: readToken('color', '--nn-color-text-card-head-control'),
                    controlBorder: readToken('borderColor', '--nn-color-border-card-head-control')
                };
                probe.remove();
                return snapshot;
            });

            expect(contrastStyle.background).toBe(contrastStyle.controlBackground);
            expect(contrastStyle.headerBackground).toBe(expectedHeaderColors[preset]);
            expect(contrastStyle.background).not.toBe(contrastStyle.headerBackground);
            expect(maxColorChannelDifference(contrastStyle.color, contrastStyle.controlText)).toBeLessThanOrEqual(2);
            expect(maxColorChannelDifference(contrastStyle.border, contrastStyle.controlBorder)).toBeLessThanOrEqual(2);
            expect(contrastStyle.shadow).not.toBe('none');
            expect(contrastStyle.controlTextContrast).toBeGreaterThanOrEqual(4.5);
        }

        await page.goto('/#/tools/tcp-tool');

        const statusTag = page.locator('.tcp-config-card .nn-card-extra .nn-tag');
        await expect(statusTag).toHaveCSS('height', '24px');
        await expect(statusTag).toHaveCSS('margin-right', '0px');
        await expect(statusTag).toHaveAttribute('role', 'status');

        await page.goto('/#/ntp/ntp-config');
        await expect(page.locator('.nn-card-extra .nn-button').first()).toHaveCSS('height', '24px');
    });

    test('uses blue as the default theme when no preset is stored', async ({ page }) => {
        await page.addInitScript(storageKey => {
            try {
                localStorage.removeItem(storageKey);
            } catch (_error) {
                // The first about:blank document has no storage origin.
            }
        }, 'netnexus.themePreset');

        await page.goto('/#/tools/packet-parser');

        await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
        await expect(page.locator('html')).toHaveAttribute('data-theme-preset', 'blue');
    });

    test('aligns the HTTP API selection marker with the sidebar divider', async ({ page }) => {
        await page.goto('/#/tools/http-api-tester');

        const activeApiItem = page.locator('.api-list-item.active');
        await expect(activeApiItem).toBeVisible();

        const geometry = await activeApiItem.evaluate(element => {
            const sidebar = element.closest('.api-sidebar');
            const sidebarBox = sidebar.getBoundingClientRect();
            const itemBox = element.getBoundingClientRect();
            const sidebarStyle = getComputedStyle(sidebar);
            const markerStyle = getComputedStyle(element, '::after');
            const dividerCenter = sidebarBox.right - parseFloat(sidebarStyle.borderRightWidth) / 2;
            const markerCenter = itemBox.right - parseFloat(markerStyle.right) - parseFloat(markerStyle.width) / 2;

            return {
                dividerCenter,
                markerCenter,
                itemWidth: itemBox.width,
                sidebarContentWidth: sidebar.clientWidth
            };
        });

        expect(Math.abs(geometry.markerCenter - geometry.dividerCenter)).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.itemWidth - geometry.sidebarContentWidth)).toBeLessThanOrEqual(1);

        await activeApiItem.click({ button: 'right' });
        const contextMenu = page.locator('.nn-dropdown-popup');
        await expect(contextMenu).toBeVisible();
        await expect(contextMenu.getByText('修改名称', { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(contextMenu).toBeHidden();
    });

    test('opens settings from the dropdown and operates its menu, modal and select', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');
        const initialTheme = await page.evaluate(() => ({
            theme: document.documentElement.dataset.theme,
            preset: document.documentElement.dataset.themePreset
        }));
        const initialBodyOverflow = await page.evaluate(() => document.body.style.overflow);
        const settingsDialog = await openSettingsDialog(page);

        await page.waitForTimeout(220);
        await expect
            .poll(() =>
                page.evaluate(() => ({
                    theme: document.documentElement.dataset.theme,
                    preset: document.documentElement.dataset.themePreset
                }))
            )
            .toEqual(initialTheme);

        const themeGroup = settingsDialog.getByRole('radiogroup', { name: '主题颜色' });
        const themeChoices = themeGroup.getByRole('radio');
        const themeCards = themeGroup.locator('.theme-preset-option');
        await expect(themeChoices).toHaveCount(3);
        await expect(themeCards).toHaveCount(3);
        for (let index = 0; index < 3; index += 1) {
            await expect(themeCards.nth(index)).toBeVisible();
        }
        await expect(settingsDialog.getByRole('combobox')).toHaveCount(1);

        const previewColors = await themeGroup
            .locator('.theme-preset-preview-header')
            .evaluateAll(previews => previews.map(preview => getComputedStyle(preview).backgroundColor));
        expect(new Set(previewColors).size).toBe(3);

        const blueTheme = themeGroup.getByRole('radio', { name: '蓝色', exact: true });
        await blueTheme.click();
        await expect(blueTheme).toBeChecked();
        await expect(themeGroup.locator('.theme-preset-option-blue')).toHaveCSS('border-color', 'rgb(22, 119, 255)');
        await expect(page.locator('html')).toHaveAttribute('data-theme-preset', 'blue');

        const toolsCategory = settingsDialog.getByRole('menuitem', { name: '工具集合', exact: true });
        await toolsCategory.click();
        await expect(toolsCategory).toHaveAttribute('aria-current', 'page');
        await expect(settingsDialog.getByText('Tools设置', { exact: true })).toBeVisible();

        await settingsDialog.getByRole('button', { name: '关闭' }).click();
        expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
        await page.waitForTimeout(80);
        expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
        await expect(settingsDialog).toBeHidden();
        await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe(initialBodyOverflow);
    });

    test('drags the settings modal within viewport bounds and resets its position after reopening', async ({
        page
    }) => {
        await page.goto('/#/tools/packet-parser');

        const settingsDialog = await openSettingsDialog(page);
        const modalRoot = page.locator('.nn-modal-root');
        const modalHeader = settingsDialog.locator('.nn-modal-header');
        const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

        await expect(modalRoot).toHaveCSS('position', 'fixed');
        await expect(modalRoot).toHaveCSS('z-index', '1000');
        await expect
            .poll(async () => {
                const box = await settingsDialog.boundingBox();
                return Math.max(
                    Math.abs(box.x + box.width / 2 - viewport.width / 2),
                    Math.abs(box.y + box.height / 2 - viewport.height / 2)
                );
            })
            .toBeLessThanOrEqual(1);

        const initialBox = await settingsDialog.boundingBox();
        const initialHeaderBox = await modalHeader.boundingBox();
        expect(initialBox).not.toBeNull();
        expect(initialHeaderBox).not.toBeNull();

        await dragFromCenter(
            page,
            modalHeader,
            initialHeaderBox.x + initialHeaderBox.width / 2 - 60,
            initialHeaderBox.y + initialHeaderBox.height / 2
        );

        await expect.poll(async () => (await settingsDialog.boundingBox())?.x).toBeLessThan(initialBox.x - 40);
        await expect(settingsDialog).toBeVisible();

        let headerBox = await modalHeader.boundingBox();
        await dragFromCenter(page, modalHeader, 0, headerBox.y + headerBox.height / 2);

        let boundedBox = await settingsDialog.boundingBox();
        expect(boundedBox.x).toBeGreaterThanOrEqual(7);
        expect(boundedBox.x).toBeLessThanOrEqual(9);
        expect(boundedBox.y).toBeGreaterThanOrEqual(7);
        expect(boundedBox.y + boundedBox.height).toBeLessThanOrEqual(viewport.height - 7);

        headerBox = await modalHeader.boundingBox();
        await dragFromCenter(page, modalHeader, viewport.width - 1, headerBox.y + headerBox.height / 2);

        boundedBox = await settingsDialog.boundingBox();
        expect(boundedBox.x + boundedBox.width).toBeGreaterThanOrEqual(viewport.width - 9);
        expect(boundedBox.x + boundedBox.width).toBeLessThanOrEqual(viewport.width - 7);
        expect(boundedBox.y).toBeGreaterThanOrEqual(7);
        expect(boundedBox.y + boundedBox.height).toBeLessThanOrEqual(viewport.height - 7);

        await settingsDialog.getByRole('button', { name: '关闭' }).click();
        await expect(settingsDialog).toBeHidden();

        const reopenedDialog = await openSettingsDialog(page);
        const reopenedBox = await reopenedDialog.boundingBox();
        expect(Math.abs(reopenedBox.x - initialBox.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(reopenedBox.y - initialBox.y)).toBeLessThanOrEqual(1);
    });

    test('keeps a modal open when its outside mask is clicked', async ({ page }) => {
        await page.goto('/#/bgp/route-ipv6');
        await expect(page.getByText('IPv6-UNC路由配置', { exact: true })).toBeVisible();

        await page.getByRole('button', { name: '从 RouteViews 导入', exact: true }).click();
        const importDialog = page.getByRole('dialog', { name: '导入 BGP MRT 路由文件' });
        await expect(importDialog).toBeVisible();

        await page.locator('.nn-modal-wrap').click({ position: { x: 4, y: 4 } });
        await expect(importDialog).toBeVisible();

        await importDialog.getByRole('button', { name: '关闭' }).click();
        await expect(importDialog).toBeHidden();
    });

    test('uses the active theme in the custom date range picker', async ({ page }) => {
        const rangePickerWarnings = [];
        page.on('console', message => {
            if (message.type() === 'warning' && message.text().includes('Extraneous non-props attributes')) {
                rangePickerWarnings.push(message.text());
            }
        });

        await page.goto('/#/snmp/snmp-trap');

        const settingsDialog = await openSettingsDialog(page);
        const darkTheme = settingsDialog.getByRole('radiogroup', { name: '主题颜色' }).getByRole('radio', {
            name: '深色',
            exact: true
        });
        await darkTheme.click();
        await expect(darkTheme).toBeChecked();
        await settingsDialog.getByRole('button', { name: '关闭' }).click();
        await expect(settingsDialog).toBeHidden();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

        const picker = page.locator('.nn-range-picker').first();
        expect(await picker.evaluate(element => element.style.width)).toBe('100%');
        const startInput = picker.getByRole('combobox', { name: '开始日期' });
        const endInput = picker.getByRole('combobox', { name: '结束日期' });
        await startInput.click();

        const panel = page.getByRole('dialog', { name: '选择日期范围' });
        await expect(panel).toBeVisible();
        await expect(panel).toHaveCSS('color-scheme', 'dark');
        expect(
            await panel.evaluate(element => {
                const probe = document.createElement('span');
                probe.style.backgroundColor = 'var(--nn-color-bg-elevated)';
                document.body.appendChild(probe);
                const matches = getComputedStyle(element).backgroundColor === getComputedStyle(probe).backgroundColor;
                probe.remove();
                return matches;
            })
        ).toBe(true);

        const currentMonthDays = panel.locator('.nn-range-picker-day:not(.nn-range-picker-day-outside)');
        await currentMonthDays.nth(0).click();
        await currentMonthDays.nth(1).click();

        const selectedStart = panel.locator('.nn-range-picker-day-start');
        expect(
            await selectedStart.evaluate(element => {
                const probe = document.createElement('span');
                probe.style.backgroundColor = 'var(--nn-color-primary)';
                document.body.appendChild(probe);
                const matches = getComputedStyle(element).backgroundColor === getComputedStyle(probe).backgroundColor;
                probe.remove();
                return matches;
            })
        ).toBe(true);

        await panel.getByLabel('开始时间').fill('08:30:00');
        await panel.getByLabel('结束时间').fill('09:45:00');
        await panel.getByRole('button', { name: '确定' }).click();

        await expect(panel).toBeHidden();
        await expect(startInput).toHaveValue(/08:30:00$/u);
        await expect(endInput).toHaveValue(/09:45:00$/u);
        expect(rangePickerWarnings).toEqual([]);
    });

    test('opens and closes an existing BGP route detail drawer', async ({ page }) => {
        await page.goto('/#/bgp/route-ipv6');
        await expect(page.getByText('IPv6-UNC路由配置', { exact: true })).toBeVisible();

        await page.getByRole('button', { name: '生成IPv6路由' }).click();

        const routeList = page.locator('.bgp-route-list-card');
        await expect(routeList.getByText('2001:db8::/64', { exact: true }).first()).toBeVisible();
        await routeList.getByRole('button', { name: '详情', exact: true }).first().click();

        const routeDrawer = page.getByRole('dialog', { name: 'BGP路由详情' });
        await expect(routeDrawer).toBeVisible();
        await expect(routeDrawer).toContainText('"ip": "2001:db8::"');

        const drawerStyle = await routeDrawer.evaluate(element => {
            const probe = document.createElement('span');
            document.body.appendChild(probe);
            const readToken = (property, token) => {
                probe.style[property] = `var(${token})`;
                return getComputedStyle(probe)[property];
            };
            const header = element.querySelector('.nn-drawer-header');
            const body = element.querySelector('.nn-drawer-body');
            const code = element.querySelector('.json-detail');
            const snapshot = {
                panelBackground: getComputedStyle(element).backgroundColor,
                headerBackground: getComputedStyle(header).backgroundColor,
                bodyBackground: getComputedStyle(body).backgroundColor,
                codeBackground: getComputedStyle(code).backgroundColor,
                codeColor: getComputedStyle(code).color,
                codeBorder: getComputedStyle(code).borderColor,
                elevated: readToken('backgroundColor', '--nn-color-bg-elevated'),
                themedCodeBackground: readToken('backgroundColor', '--nn-color-bg-code'),
                consoleBackground: readToken('backgroundColor', '--nn-color-bg-console'),
                text: readToken('color', '--nn-color-text'),
                borderLight: readToken('borderColor', '--nn-color-border-light')
            };
            probe.remove();
            return snapshot;
        });
        expect(drawerStyle.panelBackground).toBe(drawerStyle.elevated);
        expect(drawerStyle.headerBackground).toBe(drawerStyle.elevated);
        expect(drawerStyle.bodyBackground).toBe(drawerStyle.elevated);
        expect(drawerStyle.codeBackground).toBe(drawerStyle.themedCodeBackground);
        expect(drawerStyle.codeBackground).not.toBe(drawerStyle.consoleBackground);
        expect(drawerStyle.codeColor).toBe(drawerStyle.text);
        expect(drawerStyle.codeBorder).toBe(drawerStyle.borderLight);

        await page.locator('.nn-drawer-mask').click({ position: { x: 4, y: 4 } });
        await expect(routeDrawer).toBeVisible();

        await routeDrawer.getByRole('button', { name: '关闭' }).click();
        await expect(routeDrawer).toBeHidden();
    });
});
