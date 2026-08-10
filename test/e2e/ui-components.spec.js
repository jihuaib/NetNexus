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
    '/#/rpki/rpki-config',
    '/#/rpki/rpki-roa-config',
    '/#/rpki/rpki-router-key-config',
    '/#/rpki/rpki-aspa-config',
    '/#/ftp/ftp-config',
    '/#/snmp/snmp-config',
    '/#/snmp/snmp-mib-compile',
    '/#/snmp/snmp-mib',
    '/#/dhcp/dhcp-config',
    '/#/dhcp/dhcp-lease',
    '/#/ntp/ntp-config',
    '/#/ntp/ntp-request-log',
    '/#/radius/radius-config',
    '/#/radius/radius-request-log',
    '/#/radius/radius-session',
    '/#/tftp/tftp-config',
    '/#/tftp/tftp-transfer-log',
    '/#/syslog/syslog-config'
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

async function getMenuIconShapes(menu, itemNames, role = 'menuitem') {
    const shapes = {};

    for (const itemName of itemNames) {
        const icon = menu.getByRole(role, { name: itemName, exact: true }).locator('svg.nn-icon');
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
            getClientList: [],
            getRouteAssurance: {
                filters: {},
                funnel: {},
                summary: {},
                facets: {},
                issues: [],
                pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
                generatedAt: 'E2E-TIME'
            },
            setRouteAssuranceEnabled: true
        });
    });
}

async function expectHeaderSwitchTokens(toggle, trackToken, handleToken) {
    await expect
        .poll(() =>
            toggle.evaluate(
                (element, tokens) => {
                    const handle = element.querySelector('.nn-switch-handle');
                    const probe = document.createElement('span');
                    document.body.appendChild(probe);
                    probe.style.backgroundColor = `var(${tokens.track})`;
                    const expectedTrack = getComputedStyle(probe).backgroundColor;
                    probe.style.backgroundColor = `var(${tokens.handle})`;
                    const expectedHandle = getComputedStyle(probe).backgroundColor;
                    const matches =
                        getComputedStyle(element).backgroundColor === expectedTrack &&
                        getComputedStyle(handle).backgroundColor === expectedHandle;
                    probe.remove();
                    return matches;
                },
                { track: trackToken, handle: handleToken }
            )
        )
        .toBe(true);
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

    test('renders the application shell with the flat visual contract', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');
        await expect(page.getByText('报文解析器', { exact: true })).toBeVisible();

        const expandSidebarButton = page.getByRole('button', { name: '展开侧边栏' });
        if (await expandSidebarButton.isVisible()) {
            await expandSidebarButton.evaluate(button => button.click());
        }
        await expect(page.locator('.sidebar-brand-logo')).toBeVisible();

        const snapshot = await page.evaluate(() => {
            const sider = document.querySelector('.main-layout > .sider');
            const sidebarNav = sider.querySelector('.sidebar-nav');
            const contentArea = document.querySelector('.main-layout .content-area');
            const logo = document.querySelector('.sidebar-brand-logo');
            const selectedItem = document.querySelector('.main-menu .nn-menu-item-selected');
            const selectedIcon = selectedItem.querySelector('svg.nn-icon');
            const unselectedItem = [...document.querySelectorAll('.main-menu .nn-menu-item')].find(
                item => !item.classList.contains('nn-menu-item-selected')
            );
            const unselectedIcon = unselectedItem.querySelector('svg.nn-icon');
            const cardHeader = document.querySelector('.nn-card-head');
            const parseColor = color => (color.match(/[\d.]+/gu) || []).slice(0, 3).map(Number);
            const luminance = color => {
                const channels = parseColor(color).map(value => {
                    const normalized = value / 255;
                    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
                });
                return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
            };
            const contrast = (firstColor, secondColor) => {
                const first = luminance(firstColor);
                const second = luminance(secondColor);
                return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
            };
            const selectedStyle = getComputedStyle(selectedItem);
            const selectedBackground = selectedStyle.backgroundColor;
            const selectedForeground = selectedStyle.color;
            const selectedIconColor = getComputedStyle(selectedIcon).color;
            const selectedRail = selectedStyle.borderInlineStartColor;
            const unselectedStyle = getComputedStyle(unselectedItem);
            const unselectedForeground = unselectedStyle.color;
            const unselectedIconColor = getComputedStyle(unselectedIcon).color;
            const siderStyle = getComputedStyle(sider);
            const sidebarNavStyle = getComputedStyle(sidebarNav);
            const contentAreaStyle = getComputedStyle(contentArea);
            const probe = document.createElement('span');
            document.body.appendChild(probe);
            const resolveColor = token => {
                probe.style.color = `var(${token})`;
                return getComputedStyle(probe).color;
            };
            const result = {
                siderBackgroundImage: siderStyle.backgroundImage,
                siderBackground: siderStyle.backgroundColor,
                expectedSiderBackground: resolveColor('--nn-color-bg-surface'),
                siderBorder: siderStyle.borderRightColor,
                expectedSiderBorder: resolveColor('--nn-color-border'),
                sidebarNavBackground: sidebarNavStyle.backgroundColor,
                expectedSidebarNavBackground: resolveColor('--nn-color-bg-muted'),
                contentAreaBackground: contentAreaStyle.backgroundColor,
                expectedContentAreaBackground: resolveColor('--nn-color-bg-surface'),
                siderShadow: siderStyle.boxShadow,
                logoRadius: getComputedStyle(logo).borderRadius,
                logoShadow: getComputedStyle(logo).boxShadow,
                menuRadius: getComputedStyle(selectedItem).borderRadius,
                menuShadow: getComputedStyle(selectedItem).boxShadow,
                selectedBackground,
                expectedSelectedBackground: resolveColor('--nn-color-bg-selected'),
                selectedForeground,
                expectedSelectedForeground: resolveColor('--nn-color-text-info'),
                menuIconMatchesText: selectedIconColor === selectedForeground,
                menuTextContrast: contrast(selectedForeground, selectedBackground),
                menuIconContrast: contrast(selectedIconColor, selectedBackground),
                menuRailContrast: contrast(selectedRail, selectedBackground),
                unselectedIconMatchesText: unselectedIconColor === unselectedForeground,
                unselectedTextContrast: contrast(unselectedForeground, sidebarNavStyle.backgroundColor),
                unselectedIconContrast: contrast(unselectedIconColor, sidebarNavStyle.backgroundColor),
                cardHeaderBackground: getComputedStyle(cardHeader).backgroundColor,
                expectedCardHeaderBackground: resolveColor('--nn-color-bg-card-head'),
                cardAccent: getComputedStyle(cardHeader, '::before').backgroundColor,
                expectedAccent: resolveColor('--nn-color-primary')
            };
            probe.remove();
            return result;
        });

        expect(snapshot.siderBackgroundImage).toBe('none');
        expect(snapshot.siderBackground).toBe(snapshot.expectedSiderBackground);
        expect(snapshot.siderBorder).toBe(snapshot.expectedSiderBorder);
        expect(snapshot.sidebarNavBackground).toBe(snapshot.expectedSidebarNavBackground);
        expect(snapshot.contentAreaBackground).toBe(snapshot.expectedContentAreaBackground);
        expect(snapshot.siderShadow).toBe('none');
        expect(snapshot.logoRadius).toBe('2px');
        expect(snapshot.logoShadow).toBe('none');
        expect(snapshot.menuRadius).toBe('2px');
        expect(snapshot.menuShadow).toBe('none');
        expect(snapshot.selectedBackground).toBe(snapshot.expectedSelectedBackground);
        expect(snapshot.selectedBackground).not.toBe(snapshot.sidebarNavBackground);
        expect(snapshot.selectedForeground).toBe(snapshot.expectedSelectedForeground);
        expect(snapshot.menuIconMatchesText).toBe(true);
        expect(snapshot.menuTextContrast).toBeGreaterThanOrEqual(4.5);
        expect(snapshot.menuIconContrast).toBeGreaterThanOrEqual(3);
        expect(snapshot.menuRailContrast).toBeGreaterThanOrEqual(3);
        expect(snapshot.unselectedIconMatchesText).toBe(true);
        expect(snapshot.unselectedTextContrast).toBeGreaterThanOrEqual(4.5);
        expect(snapshot.unselectedIconContrast).toBeGreaterThanOrEqual(3);
        expect(snapshot.cardHeaderBackground).toBe(snapshot.expectedCardHeaderBackground);
        expect(snapshot.cardAccent).toBe(snapshot.expectedAccent);

        const selectedMenuItem = page.locator('.main-menu .nn-menu-item-selected');
        await selectedMenuItem.focus();
        await expect(selectedMenuItem).not.toHaveCSS('outline-style', 'none');

        const input = page.locator('.nn-input').first();
        await input.click();
        await expect(input).toHaveCSS('outline-style', 'none');
        await expect(input).toHaveCSS('box-shadow', 'none');

        const settingsDialog = await openSettingsDialog(page);
        await expect(settingsDialog.locator('.nn-navigation-modal-rail')).toHaveCSS('width', '160px');
        const selectedSettingsTab = settingsDialog.locator('.nn-navigation-modal-nav-item-active');
        const settingsTabContrast = await selectedSettingsTab.evaluate(element => {
            const channels = color => (color.match(/[\d.]+/gu) || []).slice(0, 3).map(Number);
            const luminance = color =>
                channels(color)
                    .map(value => {
                        const normalized = value / 255;
                        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
                    })
                    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
            const ratio = (firstColor, secondColor) => {
                const first = luminance(firstColor);
                const second = luminance(secondColor);
                return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
            };
            const style = getComputedStyle(element);
            const background = style.backgroundColor;
            const foreground = style.color;
            const icon = getComputedStyle(element.querySelector('svg.nn-icon')).color;
            return {
                iconMatchesText: icon === foreground,
                text: ratio(foreground, background),
                icon: ratio(icon, background),
                rail: ratio(style.borderInlineStartColor, background)
            };
        });
        expect(settingsTabContrast.iconMatchesText).toBe(true);
        expect(settingsTabContrast.text).toBeGreaterThanOrEqual(4.5);
        expect(settingsTabContrast.icon).toBeGreaterThanOrEqual(3);
        expect(settingsTabContrast.rail).toBeGreaterThanOrEqual(3);
        await page.keyboard.press('Escape');
    });

    test('navigates with the main sidebar menu', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');
        await expect(page.getByText('报文解析器', { exact: true })).toBeVisible();

        const ntpMenuItem = page.locator('.main-menu').getByRole('menuitem', { name: 'NTP' });
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
            '工具',
            'BGP',
            'BMP',
            'RPKI',
            'FTP',
            'SNMP',
            'DHCP',
            'NTP',
            'RADIUS',
            'TFTP',
            'Syslog'
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
        const settingsIconShapes = await getMenuIconShapes(
            settingsDialog.locator('.nn-navigation-modal-nav'),
            ['通用', '工具', 'FTP', 'API', '数据', '运行时', '更新'],
            'tab'
        );
        expect(new Set(Object.values(settingsIconShapes)).size).toBe(Object.keys(settingsIconShapes).length);
        expect(settingsIconShapes['通用']).toBe(quickIconShapes['设置']);
        expect(settingsIconShapes['工具']).toBe(mainIconShapes['工具']);
        expect(settingsIconShapes.FTP).toBe(mainIconShapes.FTP);
    });

    test('keeps configuration labels compact, radio buttons joined and selected sidebar text emphasized', async ({
        page
    }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await installLayoutApiFallbacks(page);
        await page.goto('/#/bmp/bmp-config');

        const pathTlvLabel = page.locator('.nn-form-item-label > label').filter({ hasText: 'Path TLV类型' });
        await expect(pathTlvLabel).toHaveCSS('font-size', '13px');
        await expect(pathTlvLabel).toHaveCSS('white-space', 'nowrap');
        expect(await pathTlvLabel.evaluate(label => label.scrollWidth <= label.parentElement.clientWidth)).toBe(true);

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
        const selectedMenuItem = mainMenu.getByRole('menuitem', { name: 'BMP', exact: true });
        const regularMenuItem = mainMenu.getByRole('menuitem', { name: 'BGP', exact: true });
        await expect(selectedMenuItem).toHaveCSS('font-size', '13px');
        await expect(selectedMenuItem).toHaveCSS('font-weight', '500');
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

        await page.goto('/#/monitor/bmp-client?clientKey=source%3Aempty-client&view=session');

        const pageEmpty = page.locator('.no-result-message .nn-empty');
        await expect(pageEmpty).toHaveCount(1);
        const pageImage = pageEmpty.locator('svg.nn-empty-image');
        const pageDescription = pageEmpty.locator('.nn-empty-description');
        await expect(pageImage).toBeVisible();
        await expect(pageDescription).toHaveText('未找到指定 Client');
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

        const toolsMenuItem = page.locator('.main-menu').getByRole('menuitem', { name: '工具' });
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

    test('keeps the SNMP MIB compiler aligned in expanded and collapsed layouts', async ({ page }) => {
        await page.setViewportSize({ width: 2056, height: 1209 });
        await page.goto('/#/snmp/snmp-mib-compile');

        const sidebar = page.locator('.main-layout > .sider');
        const toggleButton = sidebar.locator('.toggle-btn.nn-button');
        const mibCard = page.locator('.snmp-mib-page .mib-card');
        await expect(mibCard).toBeVisible();

        if (await sidebar.evaluate(element => element.classList.contains('collapsed'))) {
            await toggleButton.click();
        }
        await expect(sidebar).not.toHaveClass(/collapsed/u);
        await expectSnmpMibLayout(page, 160);
        await toggleButton.click();
        await expect(sidebar).toHaveClass(/collapsed/u);
        await expectSnmpMibLayout(page, 64);
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

        await page.goto('/#/snmp/snmp-mib-compile');

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
                    headerAccent: getComputedStyle(header, '::before').backgroundColor,
                    controlTextContrast: contrast(buttonStyle.color, buttonStyle.backgroundColor),
                    expectedHeaderBackground: readToken('backgroundColor', '--nn-color-bg-card-head'),
                    primaryBackground: readToken('backgroundColor', '--nn-color-primary'),
                    primaryText: readToken('color', '--nn-color-text-inverse'),
                    primaryBorder: readToken('borderColor', '--nn-color-primary')
                };
                probe.remove();
                return snapshot;
            });

            expect(contrastStyle.background).toBe(contrastStyle.primaryBackground);
            expect(contrastStyle.headerBackground).toBe(contrastStyle.expectedHeaderBackground);
            expect(contrastStyle.headerAccent).toBe(contrastStyle.primaryBackground);
            expect(contrastStyle.background).not.toBe(contrastStyle.headerBackground);
            expect(maxColorChannelDifference(contrastStyle.color, contrastStyle.primaryText)).toBeLessThanOrEqual(2);
            expect(maxColorChannelDifference(contrastStyle.border, contrastStyle.primaryBorder)).toBeLessThanOrEqual(2);
            expect(contrastStyle.shadow).toBe('none');
            expect(contrastStyle.controlTextContrast).toBeGreaterThanOrEqual(4.5);

            if (preset === 'orange') {
                const ghostStyle = await headerButtons.nth(1).evaluate(button => {
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
                    const style = getComputedStyle(button);
                    const snapshot = {
                        background: style.backgroundColor,
                        color: style.color,
                        border: style.borderColor,
                        headerBackground: getComputedStyle(header).backgroundColor,
                        ghostBackground: readToken('backgroundColor', '--nn-color-bg-card-head-ghost'),
                        ghostText: readToken('color', '--nn-color-text-card-head-ghost'),
                        ghostBorder: readToken('borderColor', '--nn-color-border-card-head-ghost'),
                        textContrast: contrast(style.color, style.backgroundColor)
                    };
                    probe.remove();
                    return snapshot;
                });

                expect(ghostStyle.background).toBe(ghostStyle.ghostBackground);
                expect(ghostStyle.background).not.toBe(ghostStyle.headerBackground);
                expect(ghostStyle.color).toBe(ghostStyle.ghostText);
                expect(ghostStyle.border).toBe(ghostStyle.ghostBorder);
                expect(ghostStyle.textContrast).toBeGreaterThanOrEqual(4.5);
            }
        }

        await page.goto('/#/tools/tcp-tool');

        const statusTag = page.locator('.tcp-config-card .nn-card-extra .nn-tag');
        await expect(statusTag).toHaveCSS('height', '24px');
        await expect(statusTag).toHaveCSS('margin-right', '0px');
        await expect(statusTag).toHaveAttribute('role', 'status');

        await page.goto('/#/ntp/ntp-config');
        await expect(page.locator('.nn-card-extra .nn-button').first()).toHaveCSS('height', '24px');
    });

    test('keeps orange route matrix header status controls distinct', async ({ page }) => {
        await installLayoutApiFallbacks(page);
        await page.goto('/#/bmp/route-assurance');
        await page.evaluate(() => {
            document.documentElement.dataset.theme = 'light';
            document.documentElement.dataset.themePreset = 'orange';
            document.documentElement.style.colorScheme = 'light';
        });

        const assurancePage = page.getByTestId('bmp-route-assurance-page');
        const analysisPill = assurancePage.locator('.analysis-toggle');
        const analysisToggle = page.getByTestId('route-assurance-toggle');
        await expect(analysisPill).toBeVisible();
        await expect(analysisToggle).toHaveAttribute('aria-checked', 'false');
        await expectHeaderSwitchTokens(
            analysisToggle,
            '--nn-color-bg-card-head-ghost-hover',
            '--nn-color-text-card-head-ghost'
        );

        const readHeaderAppearance = async () =>
            analysisPill.evaluate(element => {
                const header = element.closest('.nn-card-head');
                const toggle = element.querySelector('.nn-switch');
                const handle = toggle.querySelector('.nn-switch-handle');
                const generatedAt = header.querySelector('.generated-at');
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
                const pillStyle = getComputedStyle(element);
                const toggleStyle = getComputedStyle(toggle);
                const handleStyle = getComputedStyle(handle);
                const generatedStyle = generatedAt ? getComputedStyle(generatedAt) : null;
                const snapshot = {
                    headerBackground: getComputedStyle(header).backgroundColor,
                    pillBackground: pillStyle.backgroundColor,
                    pillColor: pillStyle.color,
                    pillBorder: pillStyle.borderColor,
                    pillHeight: pillStyle.height,
                    pillTextContrast: contrast(pillStyle.color, pillStyle.backgroundColor),
                    toggleBackground: toggleStyle.backgroundColor,
                    toggleShadow: toggleStyle.boxShadow,
                    toggleHeight: toggleStyle.height,
                    handleBackground: handleStyle.backgroundColor,
                    generatedBackground: generatedStyle?.backgroundColor || '',
                    generatedColor: generatedStyle?.color || '',
                    generatedBorder: generatedStyle?.borderColor || '',
                    generatedTextContrast: generatedStyle
                        ? contrast(generatedStyle.color, generatedStyle.backgroundColor)
                        : 0,
                    ghostBackground: readToken('backgroundColor', '--nn-color-bg-card-head-ghost'),
                    ghostHoverBackground: readToken('backgroundColor', '--nn-color-bg-card-head-ghost-hover'),
                    ghostText: readToken('color', '--nn-color-text-card-head-ghost'),
                    ghostBorder: readToken('borderColor', '--nn-color-border-card-head-ghost'),
                    primary: readToken('backgroundColor', '--nn-color-primary'),
                    inverseText: readToken('color', '--nn-color-text-inverse')
                };
                probe.remove();
                return snapshot;
            });

        const offAppearance = await readHeaderAppearance();
        expect(offAppearance.pillBackground).toBe(offAppearance.ghostBackground);
        expect(offAppearance.pillColor).toBe(offAppearance.ghostText);
        expect(offAppearance.pillBorder).toBe(offAppearance.ghostBorder);
        expect(offAppearance.pillHeight).toBe('24px');
        expect(offAppearance.pillTextContrast).toBeGreaterThanOrEqual(4.5);
        expect(offAppearance.toggleBackground).toBe(offAppearance.ghostHoverBackground);
        expect(offAppearance.toggleShadow).toBe('none');
        expect(offAppearance.toggleHeight).toBe('18px');
        expect(offAppearance.handleBackground).toBe(offAppearance.ghostText);

        await analysisToggle.click();
        await expect(analysisToggle).toHaveAttribute('aria-checked', 'true');
        await expectHeaderSwitchTokens(analysisToggle, '--nn-color-primary', '--nn-color-text-inverse');
        const generatedAt = assurancePage.locator('.generated-at');
        await expect(generatedAt).toHaveText('更新于 E2E-TIME');

        const onAppearance = await readHeaderAppearance();
        expect(onAppearance.toggleBackground).toBe(onAppearance.primary);
        expect(onAppearance.toggleBackground).not.toBe(onAppearance.headerBackground);
        expect(onAppearance.handleBackground).toBe(onAppearance.inverseText);
        expect(onAppearance.handleBackground).not.toBe(onAppearance.toggleBackground);
        expect(onAppearance.generatedBackground).toBe(onAppearance.ghostBackground);
        expect(onAppearance.generatedColor).toBe(onAppearance.ghostText);
        expect(onAppearance.generatedBorder).toBe(onAppearance.ghostBorder);
        expect(onAppearance.generatedTextContrast).toBeGreaterThanOrEqual(4.5);

        await analysisToggle.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(analysisToggle).toBeFocused();
        await expect(analysisToggle).toHaveCSS('outline-style', 'solid');
    });

    test('keeps the default blue route matrix analysis control trailing when the timestamp appears', async ({
        page
    }) => {
        await installLayoutApiFallbacks(page);
        await page.goto('/#/bmp/route-assurance');
        await page.evaluate(() => {
            document.documentElement.dataset.theme = 'light';
            document.documentElement.dataset.themePreset = 'blue';
            document.documentElement.style.colorScheme = 'light';
        });

        const assurancePage = page.getByTestId('bmp-route-assurance-page');
        const controls = assurancePage.locator('.analysis-controls');
        const analysisPill = controls.locator('.analysis-toggle');
        const analysisToggle = page.getByTestId('route-assurance-toggle');
        await expect(analysisPill).toBeVisible();
        await expect(assurancePage.locator('.generated-at')).toHaveCount(0);
        await expectHeaderSwitchTokens(
            analysisToggle,
            '--nn-color-bg-card-head-ghost-hover',
            '--nn-color-text-card-head-ghost'
        );

        const trailingEdgeBefore = await analysisPill.evaluate(element => element.getBoundingClientRect().right);
        await analysisToggle.click();
        await expect(analysisToggle).toHaveAttribute('aria-checked', 'true');
        await expectHeaderSwitchTokens(analysisToggle, '--nn-color-primary-active', '--nn-color-text-inverse');

        const generatedAt = assurancePage.locator('.generated-at');
        await expect(generatedAt).toHaveText('更新于 E2E-TIME');
        const geometry = await controls.evaluate(element => {
            const generated = element.querySelector('.generated-at').getBoundingClientRect();
            const analysis = element.querySelector('.analysis-toggle').getBoundingClientRect();
            const container = element.getBoundingClientRect();
            return {
                generatedRight: generated.right,
                analysisLeft: analysis.left,
                analysisRight: analysis.right,
                containerRight: container.right
            };
        });

        expect(geometry.generatedRight).toBeLessThanOrEqual(geometry.analysisLeft);
        expect(Math.abs(geometry.analysisRight - geometry.containerRight)).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.analysisRight - trailingEdgeBefore)).toBeLessThanOrEqual(1);
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
        await page.setViewportSize({ width: 2056, height: 1209 });
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
        const themePresetGeometry = await themeGroup.evaluate(group => {
            const groupBox = group.getBoundingClientRect();
            const cardWidths = Array.from(group.querySelectorAll('.theme-preset-option')).map(
                card => card.getBoundingClientRect().width
            );

            return {
                groupWidth: groupBox.width,
                widestCard: Math.max(...cardWidths)
            };
        });
        expect(themePresetGeometry.groupWidth).toBeLessThanOrEqual(720);
        expect(themePresetGeometry.widestCard).toBeLessThanOrEqual(240);
        const logLevelSelect = settingsDialog.getByRole('combobox');
        await expect(logLevelSelect).toHaveCount(1);
        await logLevelSelect.click();
        await page.getByRole('option', { name: 'error', exact: true }).click();
        await expect(logLevelSelect).toContainText('error');

        const previewColors = await themeGroup
            .locator('.theme-preset-preview-header')
            .evaluateAll(previews => previews.map(preview => getComputedStyle(preview).backgroundColor));
        expect(new Set(previewColors).size).toBe(3);

        const blueTheme = themeGroup.getByRole('radio', { name: '蓝色', exact: true });
        await blueTheme.click();
        await expect(blueTheme).toBeChecked();
        const selectedThemeBorder = await themeGroup.locator('.theme-preset-option-blue').evaluate(element => {
            const probe = document.createElement('span');
            probe.style.borderColor = 'var(--nn-color-primary)';
            document.body.appendChild(probe);
            const result = {
                actual: getComputedStyle(element).borderColor,
                expected: getComputedStyle(probe).borderColor
            };
            probe.remove();
            return result;
        });
        expect(selectedThemeBorder.actual).toBe(selectedThemeBorder.expected);
        await expect(page.locator('html')).toHaveAttribute('data-theme-preset', 'blue');

        const toolsCategory = settingsDialog.getByRole('tab', { name: '工具', exact: true });
        await toolsCategory.click();
        await expect(toolsCategory).toHaveAttribute('aria-selected', 'true');
        await expect(settingsDialog.getByRole('heading', { name: '工具', level: 2 })).toBeVisible();

        const generalCategory = settingsDialog.getByRole('tab', { name: '通用', exact: true });
        await generalCategory.click();
        await expect(generalCategory).toHaveAttribute('aria-selected', 'true');
        await expect(settingsDialog.getByRole('combobox')).toContainText('error');

        await settingsDialog.getByRole('button', { name: '关闭' }).click();
        expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
        await page.waitForTimeout(80);
        expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
        await expect(settingsDialog).toBeHidden();
        await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe(initialBodyOverflow);
    });

    test('uses settings primitives without flattening complex page layouts', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');
        await page.evaluate(() => {
            window.__settingsLayoutSaveCalls = [];
            const fallbacks = {
                getFtpSettings: async () => ({ status: 'success', data: { maxFtpUser: 100 } }),
                getApiSettings: async () => ({ status: 'success', data: {} }),
                getApiServerStatus: async () => ({
                    status: 'success',
                    data: {
                        running: true,
                        mode: 'cli',
                        http: { running: false, host: '127.0.0.1', port: 18080 },
                        cli: { running: true, host: '127.0.0.1', port: 3788 }
                    }
                }),
                getUpdateSettings: async () => ({
                    status: 'success',
                    data: { autoCheckOnStartup: true, autoDownload: false }
                }),
                saveUpdateSettings: async settings => {
                    window.__settingsLayoutSaveCalls.push({ ...settings });
                    return { status: 'success' };
                }
            };
            window.commonApi = new Proxy(window.commonApi, {
                get(target, property, receiver) {
                    return property in fallbacks ? fallbacks[property] : Reflect.get(target, property, receiver);
                }
            });
        });
        const settingsDialog = await openSettingsDialog(page);
        const categories = [
            {
                tab: '通用',
                description: '界面主题与运行日志',
                root: '.general-settings',
                layout: '.theme-preset-options',
                items: 2,
                sections: ['主题', '日志']
            },
            {
                tab: '工具',
                description: '历史记录与 Wireshark 插件',
                root: '.tools-settings',
                layout: '.wireshark-plugin-panel',
                items: 2,
                sections: ['字符串生成', '报文解析', 'Wireshark']
            },
            {
                tab: 'FTP',
                description: 'FTP 用户记录存储',
                root: '.ftp-settings',
                layout: '#ftp-user-limit',
                items: 1,
                sections: ['用户存储']
            },
            {
                tab: 'API',
                description: 'HTTP API 与 Telnet CLI',
                root: '.api-settings',
                layout: '[role="radiogroup"]',
                items: 1,
                sections: ['接入配置', '运行状态']
            },
            {
                tab: '数据',
                description: 'BMP SQLite 数据库维护',
                root: '.bmp-data-settings',
                layout: '.database-panel',
                items: 1,
                sections: ['BMP SQLite 数据库']
            },
            {
                tab: '运行时',
                description: 'YANG 编译器运行状态',
                root: '.runtime-settings',
                layout: '.runtime-details',
                items: 0,
                sections: ['YANG 编译器']
            },
            {
                tab: '更新',
                description: '版本检查、下载与安装',
                root: '.update-settings',
                layout: '.version-info',
                items: 3,
                sections: ['版本与安装', '自动更新']
            }
        ];

        for (const category of categories) {
            const tab = settingsDialog.getByRole('tab', { name: category.tab, exact: true });
            await tab.click();
            await expect(tab).toHaveAttribute('aria-selected', 'true');

            const panel = settingsDialog.getByRole('tabpanel');
            const settingsPage = panel.locator(category.root);
            await expect(settingsPage).toBeVisible();
            await expect(settingsPage).toHaveAttribute('data-nn-settings', '');
            await expect(settingsDialog.getByRole('heading', { name: category.tab, level: 2 })).toBeVisible();
            await expect(settingsDialog.locator('.nn-navigation-modal-description')).toHaveText(category.description);
            await expect(settingsPage.locator(category.layout)).toBeVisible();
            await expect(settingsPage.locator(':scope > [data-nn-settings-section]')).toHaveCount(
                category.sections.length
            );
            for (const sectionTitle of category.sections) {
                await expect(settingsPage.getByRole('heading', { name: sectionTitle, level: 3 })).toBeVisible();
            }
            await expect(settingsPage.locator('[data-nn-settings-item]')).toHaveCount(category.items);
            await expect(settingsPage.locator(':scope > .nn-card')).toHaveCount(0);
        }

        await settingsDialog.getByRole('tab', { name: '通用', exact: true }).click();
        await expect(settingsDialog.getByRole('combobox', { name: '日志级别' })).toBeVisible();
        await settingsDialog.getByRole('tab', { name: '工具', exact: true }).click();
        await expect(
            settingsDialog.getByRole('region', { name: '字符串生成' }).getByLabel('历史记录最大存储条数')
        ).toBeVisible();
        await expect(
            settingsDialog.getByRole('region', { name: '报文解析' }).getByLabel('历史记录最大存储条数')
        ).toBeVisible();
        await settingsDialog.getByRole('tab', { name: 'FTP', exact: true }).click();
        await expect(settingsDialog.getByRole('region', { name: '用户存储' }).getByLabel('最大存储条数')).toBeVisible();
        await settingsDialog.getByRole('tab', { name: 'API', exact: true }).click();
        const apiSettings = settingsDialog.locator('.api-settings');
        await expect(apiSettings.getByRole('radiogroup', { name: '接入方式' })).toBeVisible();
        const apiRuntimeStatus = apiSettings.getByRole('region', { name: '运行状态' });
        await expect(apiRuntimeStatus.getByRole('alert')).toContainText('Telnet CLI 正在运行');
        const apiEndpointRows = apiRuntimeStatus.locator('.nn-descriptions-item');
        await expect(apiEndpointRows).toHaveCount(2);
        const httpEndpoint = apiEndpointRows.filter({ hasText: 'HTTP API' });
        await expect(httpEndpoint).toContainText('127.0.0.1:18080');
        await expect(httpEndpoint.getByText('未运行', { exact: true })).toBeVisible();
        const cliEndpoint = apiEndpointRows.filter({ hasText: 'Telnet CLI' });
        await expect(cliEndpoint).toContainText('127.0.0.1:3788');
        await expect(cliEndpoint.getByText('运行中', { exact: true })).toBeVisible();
        await expect(apiEndpointRows.locator('.api-endpoint-state').first()).toHaveCSS(
            'justify-content',
            'space-between'
        );
        await apiSettings.getByRole('radio', { name: 'HTTP API', exact: true }).click();
        await expect(apiSettings.locator('[data-nn-settings-item]')).toHaveCount(3);
        const httpPort = apiSettings.getByLabel('HTTP监听端口');
        await expect(httpPort).toBeVisible();
        const httpPageSize = apiSettings.getByLabel('分页最大条数');
        await expect(httpPageSize).toBeVisible();
        const httpPortItem = httpPort.locator('xpath=ancestor::*[@data-nn-settings-item]');
        const httpPageSizeItem = httpPageSize.locator('xpath=ancestor::*[@data-nn-settings-item]');
        await expect(httpPortItem).toHaveCSS('border-bottom-width', '0px');
        await expect(httpPortItem).toHaveCSS('padding-bottom', '4px');
        await expect(httpPageSizeItem).toHaveCSS('padding-top', '4px');
        await apiSettings.getByRole('radio', { name: 'Telnet CLI', exact: true }).click();
        await expect(apiSettings.locator('[data-nn-settings-item]')).toHaveCount(3);
        const telnetPort = apiSettings.getByLabel('Telnet监听端口');
        await expect(telnetPort).toBeDisabled();
        const telnetMaxSessions = apiSettings.getByLabel('最大会话数');
        await expect(telnetMaxSessions).toBeVisible();
        const telnetPortItem = telnetPort.locator('xpath=ancestor::*[@data-nn-settings-item]');
        const telnetMaxSessionsItem = telnetMaxSessions.locator('xpath=ancestor::*[@data-nn-settings-item]');
        await expect(telnetPortItem).toHaveCSS('border-bottom-width', '0px');
        await expect(telnetPortItem).toHaveCSS('padding-bottom', '4px');
        await expect(telnetMaxSessionsItem).toHaveCSS('padding-top', '4px');
        await settingsDialog.getByRole('tab', { name: '更新', exact: true }).click();

        const updateSettings = settingsDialog.locator('.update-settings');
        const automaticUpdates = updateSettings.getByRole('region', { name: '自动更新' });
        await expect(automaticUpdates).toBeVisible();
        await expect(automaticUpdates.locator('[data-nn-settings-item]')).toHaveCount(2);
        await expect(automaticUpdates.getByRole('switch', { name: '启动时检查更新' })).toBeVisible();
        const automaticDownload = automaticUpdates.getByRole('switch', { name: '自动下载更新' });
        await expect(automaticDownload).toHaveAttribute('aria-checked', 'false');
        await automaticDownload.click();
        await expect(automaticDownload).toHaveAttribute('aria-checked', 'true');
        await expect
            .poll(() => page.evaluate(() => window.__settingsLayoutSaveCalls.at(-1)))
            .toEqual({ autoCheckOnStartup: true, autoDownload: true });
    });

    test('deletes the stopped BMP database from data management after confirmation', async ({ page }) => {
        await installLayoutApiFallbacks(page);
        await page.goto('/#/tools/packet-parser');
        await page.evaluate(() => {
            const state = {
                deleteCalls: 0,
                statusCalls: 0,
                finishDelete: null,
                info: {
                    dbPath: '/tmp/netnexus/bmp/bmp.sqlite3',
                    exists: true,
                    running: false,
                    starting: false,
                    deleting: false,
                    busy: false,
                    canDelete: true,
                    totalSize: 1536,
                    fileCount: 2
                }
            };
            window.__bmpDataSettingsE2e = state;
            window.bmpApi = {
                getPersistenceDatabaseInfo: async () => {
                    state.statusCalls += 1;
                    return {
                        status: 'success',
                        msg: 'ok',
                        data: { ...state.info }
                    };
                },
                deletePersistenceDatabase: () => {
                    state.deleteCalls += 1;
                    return new Promise(resolve => {
                        state.finishDelete = () => {
                            state.info = {
                                ...state.info,
                                exists: false,
                                canDelete: false,
                                totalSize: 0,
                                fileCount: 0
                            };
                            resolve({
                                status: 'success',
                                msg: 'BMP数据库删除成功',
                                data: { ...state.info, deleted: true }
                            });
                        };
                    });
                }
            };
        });

        const settingsDialog = await openSettingsDialog(page);
        await settingsDialog.getByRole('tab', { name: '数据', exact: true }).click();
        await expect(settingsDialog.getByText('/tmp/netnexus/bmp/bmp.sqlite3', { exact: true })).toBeVisible();
        await expect(settingsDialog.getByText('1.50 KB', { exact: true })).toBeVisible();
        expect(await page.evaluate(() => window.__bmpDataSettingsE2e.statusCalls)).toBe(1);
        const baselineOverlayState = await page.evaluate(() => ({
            stackSize: window.__NETNEXUS_UI_OVERLAY_STATE__.stack.length,
            lockCount: window.__NETNEXUS_UI_OVERLAY_STATE__.lockCount
        }));

        const deleteButton = settingsDialog.getByTestId('bmp-database-delete-button');
        await expect(deleteButton).toBeEnabled();
        await deleteButton.click();
        let confirmDialog = page.getByRole('dialog', { name: '确认删除 BMP 数据库' });
        await expect(confirmDialog).toBeVisible();
        await expect
            .poll(() =>
                page.evaluate(() => ({
                    stackSize: window.__NETNEXUS_UI_OVERLAY_STATE__.stack.length,
                    lockCount: window.__NETNEXUS_UI_OVERLAY_STATE__.lockCount
                }))
            )
            .toEqual({
                stackSize: baselineOverlayState.stackSize + 1,
                lockCount: baselineOverlayState.lockCount + 1
            });

        await expect(confirmDialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(confirmDialog.getByRole('button', { name: '永久删除', exact: true })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(confirmDialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(confirmDialog).toBeHidden();
        await expect(settingsDialog).toBeVisible();
        await expect(deleteButton).toBeFocused();
        await expect
            .poll(() =>
                page.evaluate(() => ({
                    stackSize: window.__NETNEXUS_UI_OVERLAY_STATE__.stack.length,
                    lockCount: window.__NETNEXUS_UI_OVERLAY_STATE__.lockCount
                }))
            )
            .toEqual(baselineOverlayState);
        expect(await page.evaluate(() => window.__bmpDataSettingsE2e.deleteCalls)).toBe(0);

        await deleteButton.click();
        confirmDialog = page.getByRole('dialog', { name: '确认删除 BMP 数据库' });
        await confirmDialog.getByRole('button', { name: '永久删除', exact: true }).click();
        await expect(confirmDialog.getByRole('button', { name: '处理中...', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(confirmDialog).toBeVisible();
        await expect(settingsDialog).toBeVisible();
        await page.evaluate(() => window.__bmpDataSettingsE2e.finishDelete());
        await expect(confirmDialog).toBeHidden();
        await expect(settingsDialog.getByText('不存在', { exact: true })).toBeVisible();
        await expect(deleteButton).toBeDisabled();
        expect(await page.evaluate(() => window.__bmpDataSettingsE2e.deleteCalls)).toBe(1);
        await expect
            .poll(() =>
                page.evaluate(() => ({
                    stackSize: window.__NETNEXUS_UI_OVERLAY_STATE__.stack.length,
                    lockCount: window.__NETNEXUS_UI_OVERLAY_STATE__.lockCount
                }))
            )
            .toEqual(baselineOverlayState);
    });

    test('drags the settings modal within viewport bounds and resets its position after reopening', async ({
        page
    }) => {
        await page.goto('/#/tools/packet-parser');

        const settingsDialog = await openSettingsDialog(page);
        const modalRoot = page.locator('.nn-modal-root');
        const modalHeader = settingsDialog.locator('.nn-navigation-modal-header');
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

        await page.goto('/#/monitor/snmp-trap');
        await page.evaluate(() => {
            document.documentElement.dataset.theme = 'dark';
            document.documentElement.dataset.themePreset = 'dark';
            document.documentElement.style.colorScheme = 'dark';
        });
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
