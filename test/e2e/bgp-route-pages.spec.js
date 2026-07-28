const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');

const pageCases = [
    {
        route: '/#/bgp/route-ipv4',
        title: 'IPv4-UNC路由配置',
        dialogTitle: 'IPv4 路由高级配置',
        sections: ['AS Path', 'ADD-PATH', 'SRv6']
    },
    {
        route: '/#/bgp/route-ipv6',
        title: 'IPv6-UNC路由配置',
        dialogTitle: 'IPv6 路由高级配置',
        sections: ['AS Path', 'ADD-PATH', 'SRv6']
    },
    {
        route: '/#/bgp/route-mvpn',
        title: 'IPv4-MVPN路由配置',
        dialogTitle: 'MVPN 路由高级配置',
        sections: ['AS Path']
    },
    {
        route: '/#/bgp/route-ipv4-qp',
        title: 'IPv4-QP路由配置',
        dialogTitle: 'IPv4 QP 路由高级配置',
        sections: ['AS Path', '生成策略', 'DQPN']
    },
    {
        route: '/#/bgp/route-ipv6-qp',
        title: 'IPv6-QP路由配置',
        dialogTitle: 'IPv6 QP 路由高级配置',
        sections: ['AS Path', '生成策略', 'DQPN']
    }
];

const ipv4RoutePageApiPatch = `
    (() => {
        const patchApi = api =>
            Object.assign(api || {}, {
                loadIpv4UNCRouteConfig: () => window.__featureE2eCall('bgp.loadIpv4UNCRouteConfig'),
                saveIpv4UNCRouteConfig: config =>
                    window.__featureE2eCall('bgp.saveIpv4UNCRouteConfig', config),
                generateIpv4Routes: config => window.__featureE2eCall('bgp.generateRoutes', config),
                deleteIpv4Routes: config => window.__featureE2eCall('bgp.deleteRoutes', config)
            });

        let currentApi = patchApi(window.bgpApi);
        Object.defineProperty(window, 'bgpApi', {
            configurable: true,
            enumerable: true,
            get: () => currentApi,
            set: value => {
                currentApi = patchApi(value);
            }
        });
    })();
`;

test.describe('BGP route pages', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
        await page.addInitScript({ content: ipv4RoutePageApiPatch });
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('renders route configuration pages with mock data', async ({ page }) => {
        for (const pageCase of pageCases) {
            await verifyPage(test, page, pageCase);
        }
    });

    test('uses the orange card-header palette for the RouteViews action', async ({ page }) => {
        for (const route of ['/#/bgp/route-ipv4', '/#/bgp/route-ipv6']) {
            await page.goto(route);
            await page.evaluate(() => {
                document.documentElement.dataset.theme = 'light';
                document.documentElement.dataset.themePreset = 'orange';
                document.documentElement.style.colorScheme = 'light';
            });

            const importButton = page.getByRole('button', { name: '从 RouteViews 导入', exact: true });
            await expect(importButton).toBeVisible();

            const appearance = await importButton.evaluate(button => {
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
                const snapshot = {
                    background: buttonStyle.backgroundColor,
                    color: buttonStyle.color,
                    border: buttonStyle.borderColor,
                    headerBackground: getComputedStyle(header).backgroundColor,
                    ghostBackground: readToken('backgroundColor', '--nn-color-bg-card-head-ghost'),
                    ghostText: readToken('color', '--nn-color-text-card-head-ghost'),
                    ghostBorder: readToken('borderColor', '--nn-color-border-card-head-ghost'),
                    contrast: contrast(buttonStyle.color, buttonStyle.backgroundColor)
                };
                probe.remove();
                return snapshot;
            });

            expect(appearance.background).toBe(appearance.ghostBackground);
            expect(appearance.background).not.toBe(appearance.headerBackground);
            expect(appearance.color).toBe(appearance.ghostText);
            expect(appearance.border).toBe(appearance.ghostBorder);
            expect(appearance.contrast).toBeGreaterThanOrEqual(4.5);
        }
    });

    test('keeps advanced configuration compact across every route page', async ({ page }) => {
        await page.setViewportSize({ width: 2056, height: 1209 });

        for (const pageCase of pageCases) {
            await page.goto(pageCase.route);
            await page.locator('.advanced-config-button').click();

            const dialog = page.getByRole('dialog', { name: pageCase.dialogTitle });
            await expect(dialog).toBeVisible();
            await expect(dialog.locator('.section-title')).toHaveText(pageCase.sections);

            const geometry = await dialog.evaluate(element => {
                const body = element.querySelector('.nn-modal-body');
                const formItem = element.querySelector('.nn-form-item');
                const section = element.querySelector('.advanced-section');
                const sectionTitle = element.querySelector('.section-title');
                const startAsItem = Array.from(element.querySelectorAll('.nn-form-item')).find(item =>
                    item.querySelector('.nn-form-item-label')?.textContent.includes('起始 AS')
                );
                const startAsLabel = startAsItem.querySelector('.nn-form-item-label');
                const startAsControl = startAsItem.querySelector('.nn-form-item-control');
                const startAsLabelBox = startAsLabel.getBoundingClientRect();
                const startAsControlBox = startAsControl.getBoundingClientRect();

                return {
                    dialogWidth: element.getBoundingClientRect().width,
                    hasHorizontalOverflow: body.scrollWidth > body.clientWidth + 1,
                    formItemMarginBottom: parseFloat(getComputedStyle(formItem).marginBottom),
                    sectionTitleMarginBottom: parseFloat(getComputedStyle(sectionTitle).marginBottom),
                    sectionPaddingTop: parseFloat(getComputedStyle(section).paddingTop),
                    startAsIsHorizontal:
                        startAsLabelBox.right <= startAsControlBox.left + 1 &&
                        Math.abs(startAsLabelBox.top - startAsControlBox.top) <= 1,
                    startAsLabelHasColon: Boolean(startAsLabel.querySelector('.nn-form-item-colon'))
                };
            });

            expect(geometry.dialogWidth).toBeLessThanOrEqual(841);
            expect(geometry.hasHorizontalOverflow).toBe(false);
            expect(geometry.formItemMarginBottom).toBeLessThanOrEqual(6);
            expect(geometry.sectionTitleMarginBottom).toBeLessThanOrEqual(6);
            expect(geometry.sectionPaddingTop).toBeLessThanOrEqual(10);
            expect(geometry.startAsIsHorizontal).toBe(true);
            expect(geometry.startAsLabelHasColon).toBe(true);

            await dialog.getByRole('button', { name: '取消', exact: true }).click();
            await expect(dialog).toBeHidden();
        }
    });

    test('keeps the IPv4 Label advanced configuration compact', async ({ page }) => {
        await page.setViewportSize({ width: 2056, height: 1209 });
        await page.goto('/#/bgp/route-ipv4');

        const addressFamilySelect = page.locator('.bgp-route-form').getByRole('combobox').first();
        await addressFamilySelect.click();
        await page.getByRole('option', { name: 'IPv4 Label', exact: true }).click();
        await expect(addressFamilySelect).toContainText('IPv4 Label');

        await page.locator('.advanced-config-button').click();
        const dialog = page.getByRole('dialog', { name: 'IPv4 路由高级配置' });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('.section-title')).toHaveText(['AS Path', 'MPLS Label']);

        const hasHorizontalOverflow = await dialog.locator('.nn-modal-body').evaluate(body => {
            return body.scrollWidth > body.clientWidth + 1;
        });
        expect(hasHorizontalOverflow).toBe(false);
    });

    test('keeps the advanced configuration responsive in a narrower window', async ({ page }) => {
        await page.setViewportSize({ width: 640, height: 800 });
        await page.goto('/#/bgp/route-ipv4');
        await page.locator('.advanced-config-button').click();

        const dialog = page.getByRole('dialog', { name: 'IPv4 路由高级配置' });
        await expect(dialog).toBeVisible();

        const geometry = await dialog.evaluate(element => {
            const body = element.querySelector('.nn-modal-body');
            return {
                dialogWidth: element.getBoundingClientRect().width,
                hasHorizontalOverflow: body.scrollWidth > body.clientWidth + 1
            };
        });

        expect(geometry.dialogWidth).toBeLessThanOrEqual(609);
        expect(geometry.hasHorizontalOverflow).toBe(false);
        await expect(dialog.getByRole('button', { name: '应用', exact: true })).toBeVisible();
    });
});
