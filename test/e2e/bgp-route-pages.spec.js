const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');
const attributeRegistry = require('../../shared/bgpAttributes.json');

const pageCases = [
    { route: '/#/bgp/route-ipv4', title: 'IPv4-UNC', testPrefix: 'bgp-ipv4' },
    { route: '/#/bgp/route-ipv4-label', title: 'IPv4 Label', testPrefix: 'bgp-ipv4-label' },
    { route: '/#/bgp/route-ipv6', title: 'IPv6-UNC', testPrefix: 'bgp-ipv6' },
    { route: '/#/bgp/route-mvpn', title: 'IPv4-MVPN', testPrefix: 'bgp-mvpn' },
    { route: '/#/bgp/route-ipv4-qp', title: 'IPv4-QP', testPrefix: 'bgp-ipv4-qp' },
    { route: '/#/bgp/route-ipv6-qp', title: 'IPv6-QP', testPrefix: 'bgp-ipv6-qp' }
];

const ipv4RoutePageApiPatch = `
    (() => {
        const patchApi = api =>
            Object.assign(api || {}, {
                loadIpv4UNCRouteConfig: () => window.__featureE2eCall('bgp.loadIpv4UNCRouteConfig'),
                saveIpv4UNCRouteConfig: config =>
                    window.__featureE2eCall('bgp.saveIpv4UNCRouteConfig', config),
                loadIpv4LabelRouteConfig: () => window.__featureE2eCall('bgp.loadIpv4LabelRouteConfig'),
                saveIpv4LabelRouteConfig: config => window.__featureE2eCall('bgp.saveIpv4LabelRouteConfig', config),
                generateIpv4Routes: config => {
                    window.__ipv4GeneratedPayload = JSON.parse(JSON.stringify(config));
                    return window.__featureE2eCall('bgp.generateRoutes', config);
                },
                deleteIpv4Routes: config => window.__featureE2eCall('bgp.deleteRoutes', config),
                getRouteGroupStates: () => window.__featureE2eCall('bgp.getRouteGroupStates'),
                withdrawRouteGroup: config => window.__featureE2eCall('bgp.withdrawRouteGroup', config)
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

function ipv4TestPrefix(page) {
    return page.url().includes('/route-ipv4-label') ? 'bgp-ipv4-label' : 'bgp-ipv4';
}

function ipv4GenerateButton(page) {
    return page.getByTestId(
        ipv4TestPrefix(page) === 'bgp-ipv4'
            ? 'bgp-generate-ipv4-routes-button'
            : 'bgp-ipv4-label-generate-routes-button'
    );
}

async function openIpv4RoutePage(page, label = false) {
    await page.goto(label ? '/#/bgp/route-ipv4-label' : '/#/bgp/route-ipv4');
    await expect(ipv4GenerateButton(page)).toBeEnabled();
}

async function addIpv4Attribute(page, label, forceAdd = false) {
    await expect(ipv4GenerateButton(page)).toBeEnabled();
    const type = attributeRegistry.attributes.find(entry => entry.label === label).type;
    const existing = page.getByTestId(`${ipv4TestPrefix(page)}-tree-attribute-${type}`);
    if (!forceAdd && (await existing.count())) {
        await existing.last().click();
        return;
    }
    const section = attributeRegistry.attributes.find(entry => entry.type === type).section || 'attributes';
    const groupId = await page
        .getByTestId(`${ipv4TestPrefix(page)}-route-workspace`)
        .getAttribute('data-active-group-id');
    await page.getByTestId(`${ipv4TestPrefix(page)}-tree-${section}-${groupId}`).click({ button: 'right' });
    const menu = page.getByTestId(`${ipv4TestPrefix(page)}-${section === 'nlri' ? 'nlri' : 'attribute'}-context-menu`);
    await expect(menu).toBeVisible();
    await page.getByTestId(`${ipv4TestPrefix(page)}-add-attribute-button`).click();
    await page.getByTestId(`${ipv4TestPrefix(page)}-add-attribute-${type}`).click();
    await expect(menu).toHaveCount(0);
}

async function removeIpv4Attribute(page, target) {
    await target.click({ button: 'right' });
    const section = await target.getAttribute('data-rule-section');
    const menu = page.getByTestId(`${ipv4TestPrefix(page)}-${section === 'nlri' ? 'nlri' : 'attribute'}-context-menu`);
    await expect(menu).toBeVisible();
    await page.getByTestId(`${ipv4TestPrefix(page)}-remove-attribute-button`).click();
    await expect(menu).toHaveCount(0);
}

async function setIpv4AttributeMode(page, label) {
    await page.getByTestId(`${ipv4TestPrefix(page)}-attribute-mode-select`).click();
    await page.getByRole('option', { name: label, exact: true }).click();
}

async function dismissNotifications(page) {
    const closeButtons = page.locator('.nn-toast:not(.nn-toast-leaving) .nn-toast-close');
    while (await closeButtons.count()) await closeButtons.first().click();
    await expect(page.locator('.nn-toast')).toHaveCount(0);
}

async function generateIpv4Group(page) {
    await dismissNotifications(page);
    await ipv4GenerateButton(page).click();
}

async function openIpv4GroupMenu(page, target) {
    if (!target) {
        const groupId = await page
            .getByTestId(`${ipv4TestPrefix(page)}-route-workspace`)
            .getAttribute('data-active-group-id');
        target = page.getByTestId(`${ipv4TestPrefix(page)}-tree-group-${groupId}`);
    }
    await target.click({ button: 'right' });
    await expect(page.getByTestId(`${ipv4TestPrefix(page)}-group-context-menu`)).toBeVisible();
}

async function expectGeneratedCount(page, count) {
    const generateButton = ipv4GenerateButton(page);
    await expect(generateButton).toBeEnabled();
    const selected = page.locator('[role="treeitem"][aria-selected="true"] .route-tree-title');
    const previous = await selected.evaluate(element => {
        const testId = element.dataset.testid;
        return {
            testId,
            index: Array.from(document.querySelectorAll(`[data-testid="${testId}"]`)).indexOf(element)
        };
    });
    if (count === 0) await expect(generateButton).toHaveText('生成本组路由');
    await openIpv4GroupMenu(page);
    const menu = page.getByTestId(`${ipv4TestPrefix(page)}-group-context-menu`);
    if (count > 0) await expect(menu.locator('.nn-context-menu-meta')).toHaveText(`已生成 ${count} 条`);
    else
        await expect(page.getByTestId(`${ipv4TestPrefix(page)}-withdraw-group-button`)).toHaveAttribute(
            'aria-disabled',
            'true'
        );
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    // Opening the group menu should not leave a different editor selected.
    await page.getByTestId(previous.testId).nth(previous.index).click();
}

async function ipv4GroupAction(page, action, target) {
    await openIpv4GroupMenu(page, target);
    await page.getByTestId(`${ipv4TestPrefix(page)}-${action}-group-button`).click();
    await expect(page.getByTestId(`${ipv4TestPrefix(page)}-group-context-menu`)).toHaveCount(0);
}

test.describe('BGP route pages', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
        const controller = harness.controller;
        const originalCall = controller.call.bind(controller);
        controller.state.bgp.running = true;
        controller.call = async (method, ...args) => {
            const bgp = controller.state.bgp;
            const routeGroups = () => {
                const groups = new Map();
                for (const routes of bgp.routes.values()) {
                    for (const route of routes.filter(item => item.groupId)) {
                        const state = groups.get(route.groupId) || {
                            groupId: route.groupId,
                            groupName: route.groupName,
                            addressFamily: route.addressFamily,
                            routeCount: 0,
                            generatedAt: route.generatedAt
                        };
                        state.routeCount += 1;
                        groups.set(route.groupId, state);
                    }
                }
                return [...groups.values()];
            };
            if (method === 'bgp.getRouteGroupStates') {
                controller.record('renderer API call: ' + method);
                return bgp.running
                    ? { status: 'success', data: { groups: routeGroups() } }
                    : { status: 'error', msg: 'BGP 未启动' };
            }
            if (method === 'bgp.withdrawRouteGroup') {
                controller.record('renderer API call: ' + method, args[0]);
                if (!bgp.running) return { status: 'error', msg: 'BGP 未启动' };
                let deleted = 0;
                for (const [family, routes] of bgp.routes.entries()) {
                    const remaining = routes.filter(route => route.groupId !== args[0].groupId);
                    deleted += routes.length - remaining.length;
                    bgp.routes.set(family, remaining);
                }
                return { status: 'success', data: { deleted } };
            }
            if (method === 'bgp.generateRoutes' && args[0]?.groupId) {
                const config = args[0];
                const family = Number(config.addressFamily);
                const remaining = (bgp.routes.get(family) || []).filter(route => route.groupId !== config.groupId);
                for (const [otherFamily, routes] of bgp.routes.entries()) {
                    if (otherFamily !== family)
                        bgp.routes.set(
                            otherFamily,
                            routes.filter(route => route.groupId !== config.groupId)
                        );
                }
                const addPath = config.nlriRules.find(rule => rule.type === 'addPath');
                const paths = addPath ? Number(addPath.count) : 1;
                const total = Number(config.count) * paths;
                const result = await originalCall(method, { ...config, count: total });
                const prefixStep = 2 ** (32 - Number(config.mask));
                const prefixValue = config.prefix.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
                const firstPrefix = Math.floor(prefixValue / prefixStep) * prefixStep;
                const generatedAt = new Date().toISOString();
                const generated = bgp.routes.get(family).map((route, index) => {
                    const value = firstPrefix + Math.floor(index / paths) * prefixStep;
                    return {
                        ...route,
                        ip: [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.'),
                        pathId: index % paths,
                        groupId: config.groupId,
                        groupName: config.groupName,
                        generatedAt
                    };
                });
                bgp.routes.set(family, [...remaining, ...generated]);
                return result;
            }
            if (method === 'bgp.deleteRoutes') {
                controller.record('renderer API call: ' + method);
                const config = args[0];
                const family = Number(config.addressFamily);
                const routes = bgp.routes.get(family) || [];
                bgp.routes.set(
                    family,
                    routes.filter(
                        route =>
                            !(
                                route.ip === config.prefix &&
                                Number(route.mask) === Number(config.mask) &&
                                Number(route.pathId || 0) === Number(config.pathId || 0)
                            )
                    )
                );
                return { status: 'success', data: { deleted: 1 }, msg: '路由删除成功' };
            }
            return originalCall(method, ...args);
        };
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

    test('isolates IPv4 route groups and removes only configuration', async ({ page }) => {
        const existingPrefix = '203.0.113.77/32';
        harness.controller.state.bgp.routes.set(1, [
            {
                ip: '203.0.113.77',
                mask: 32,
                rd: '0:0',
                pathId: 0,
                nextHop: '192.0.2.1',
                asPath: '65000',
                rt: '',
                addressFamily: 1
            }
        ]);

        await openIpv4RoutePage(page);
        const groups = page.locator('.route-group-item');
        const nameInput = page.getByTestId('bgp-ipv4-route-group-name');
        const prefixInput = page.getByTestId('bgp-ipv4-route-prefix-input');
        const maskInput = page.getByTestId('bgp-ipv4-route-mask-input');
        const countInput = page.getByTestId('bgp-ipv4-route-count-input');
        const removeButton = page.getByTestId('bgp-ipv4-remove-group-button');
        const routeTable = page.getByTestId('bgp-ipv4-route-table');

        await expect(groups).toHaveCount(1);
        await openIpv4GroupMenu(page);
        await expect(removeButton).toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Escape');
        await expect(routeTable).toContainText(existingPrefix);
        await nameInput.fill('骨干网');
        await prefixInput.fill('10.20.0.0');
        await maskInput.fill('24');
        await countInput.fill('3');

        await page.getByTestId('bgp-ipv4-add-group-button').click();
        await expect(groups).toHaveCount(2);
        await nameInput.fill('接入网');
        await prefixInput.fill('198.51.100.1');
        await maskInput.fill('32');
        await countInput.fill('7');

        await groups.first().click();
        await expect(nameInput).toHaveValue('骨干网');
        await expect(prefixInput).toHaveValue('10.20.0.0');
        await expect(maskInput).toHaveValue('24');
        await expect(countInput).toHaveValue('3');
        await groups.nth(1).click();
        await expect(nameInput).toHaveValue('接入网');
        await expect(prefixInput).toHaveValue('198.51.100.1');
        await expect(maskInput).toHaveValue('32');
        await expect(countInput).toHaveValue('7');

        await ipv4GroupAction(page, 'copy');
        await expect(groups).toHaveCount(3);
        await expect(prefixInput).toHaveValue('198.51.100.1');
        await expect(maskInput).toHaveValue('32');
        await expect(countInput).toHaveValue('7');
        await nameInput.fill('接入网副本');
        await prefixInput.fill('192.0.2.1');
        await countInput.fill('2');
        await groups.nth(1).click();
        await expect(prefixInput).toHaveValue('198.51.100.1');
        await expect(countInput).toHaveValue('7');
        await groups.nth(2).click();
        await expect(prefixInput).toHaveValue('192.0.2.1');
        await expect(countInput).toHaveValue('2');

        await ipv4GroupAction(page, 'remove');
        await expect(groups).toHaveCount(2);
        await expect(routeTable).toContainText(existingPrefix);
        expect(harness.controller.state.bgp.routes.get(1)).toHaveLength(1);
        expect(
            harness.controller.timeline.filter(item => item.message.startsWith('renderer API call: bgp.delete'))
        ).toHaveLength(0);
        await groups.first().click();
        await ipv4GroupAction(page, 'remove');
        await expect(groups).toHaveCount(1);
        await openIpv4GroupMenu(page);
        await expect(removeButton).toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Escape');
        await expect(nameInput).toHaveValue('接入网');
        await expect(prefixInput).toHaveValue('198.51.100.1');
        await expect(routeTable).toContainText(existingPrefix);
    });

    test('keeps IPv4 UNC and Label workspaces independent across tabs and reload', async ({ page }) => {
        await openIpv4RoutePage(page);
        await page.getByTestId('bgp-ipv4-route-group-name').fill('IPv4普通路由');
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('10.30.0.0');
        await page.getByTestId('bgp-ipv4-route-count-input').fill('4');
        await page.getByTestId('bgp-ipv4-save-workspace-button').click();
        await expect(page.locator('.workspace-save-state')).toContainText('已保存');
        const uncId = await page.getByTestId('bgp-ipv4-route-workspace').getAttribute('data-active-group-id');

        await page.getByRole('tab', { name: 'IPv4 Label路由', exact: true }).click();
        await expect(ipv4GenerateButton(page)).toBeEnabled();
        await expect(page.getByTestId('route-field-addressFamily')).toHaveCount(0);
        await expect(page.locator('.route-display-switch')).toHaveCount(0);
        await page.getByTestId('bgp-ipv4-label-route-group-name').fill('IPv4标签路由');
        await page.getByTestId('bgp-ipv4-label-route-prefix-input').fill('198.51.100.0');
        await page.getByTestId('bgp-ipv4-label-route-count-input').fill('8');
        await page.getByTestId('bgp-ipv4-label-tree-attribute-label').click();
        await setIpv4AttributeMode(page, '递增');
        await page.getByTestId('bgp-ipv4-label-attribute-start-input').fill('20000');
        await page.getByTestId('bgp-ipv4-label-attribute-step-input').fill('5');
        await expect(page.getByTestId('bgp-ipv4-label-attribute-preview')).toContainText('20005');
        await addIpv4Attribute(page, 'ADD-PATH');
        await page.getByTestId('bgp-ipv4-label-attribute-count-input').fill('4');
        await expect(page.getByTestId('bgp-ipv4-label-route-range-preview')).toContainText(
            '8 个前缀 × 4 条路径 = 32 条路由'
        );
        await page.getByTestId('bgp-ipv4-label-save-workspace-button').click();
        await expect(page.locator('.workspace-save-state')).toContainText('已保存');
        const labelId = await page.getByTestId('bgp-ipv4-label-route-workspace').getAttribute('data-active-group-id');
        expect(labelId).not.toBe(uncId);
        const savedUnc = harness.controller.state.bgp.configs.get('Ipv4UNCRouteConfig').routeWorkspace;
        const savedLabel = harness.controller.state.bgp.configs.get('Ipv4LabelRouteConfig').routeWorkspace;
        expect(savedUnc.groups.map(group => group.config.addressFamily)).toEqual([1]);
        expect(savedLabel.groups.map(group => group.config.addressFamily)).toEqual([12]);

        await page.getByRole('tab', { name: 'IPv4-UNC路由', exact: true }).click();
        await expect(page.getByTestId('bgp-ipv4-route-group-name')).toHaveValue('IPv4普通路由');
        await expect(page.getByTestId('bgp-ipv4-route-prefix-input')).toHaveValue('10.30.0.0');
        await expect(page.getByTestId('bgp-ipv4-route-count-input')).toHaveValue('4');
        await page.reload();
        await expect(page.getByTestId('bgp-ipv4-route-workspace')).toHaveAttribute('data-active-group-id', uncId);
        await page.getByRole('tab', { name: 'IPv4 Label路由', exact: true }).click();
        await page.reload();
        await expect(page.getByTestId('bgp-ipv4-label-route-workspace')).toHaveAttribute(
            'data-active-group-id',
            labelId
        );
        await expect(page.locator('.route-group-item')).toHaveCount(1);
        await expect(page.getByTestId('bgp-ipv4-label-route-group-name')).toHaveValue('IPv4标签路由');
        await expect(page.getByTestId('bgp-ipv4-label-route-prefix-input')).toHaveValue('198.51.100.0');
        await page.getByTestId('bgp-ipv4-label-tree-attribute-label').click();
        await expect(page.getByTestId('bgp-ipv4-label-attribute-start-input')).toHaveValue('20000');
        await expect(page.getByTestId('bgp-ipv4-label-attribute-step-input')).toHaveValue('5');
        await page.getByTestId('bgp-ipv4-label-tree-attribute-addPath').click();
        await expect(page.getByTestId('bgp-ipv4-label-attribute-count-input')).toHaveValue('4');
        await expect(page.getByTestId('bgp-ipv4-label-route-range-preview')).toContainText('32 条路由');
    });

    test('migrates each family from a mixed version 6 workspace without overwriting the other family', async ({
        page
    }) => {
        const legacy = {
            prefix: '198.51.100.0',
            mask: '24',
            count: '3',
            addressFamily: 12,
            routeWorkspace: {
                version: 6,
                activeGroupId: 'legacy-label',
                groups: [
                    {
                        id: 'legacy-unc',
                        name: '旧普通组',
                        config: {
                            prefix: '10.30.0.0',
                            mask: '24',
                            count: '4',
                            ipStep: '2',
                            attributeRules: [{ id: 'legacy-med', type: 'med', mode: 'fixed', value: '321' }],
                            nlriRules: []
                        }
                    },
                    {
                        id: 'legacy-label',
                        name: '旧标签组',
                        config: {
                            prefix: '198.51.100.0',
                            mask: '24',
                            count: '3',
                            addressFamily: 12,
                            attributeRules: [],
                            nlriRules: [
                                {
                                    id: 'legacy-label-rule',
                                    type: 'label',
                                    mode: 'increment',
                                    start: '20000',
                                    step: '5'
                                },
                                { id: 'legacy-path-rule', type: 'addPath', count: '2' }
                            ]
                        }
                    }
                ]
            }
        };
        harness.controller.state.bgp.configs.set('Ipv4UNCRouteConfig', legacy);
        await openIpv4RoutePage(page);
        await expect(page.locator('.route-group-item')).toHaveCount(1);
        await expect(page.getByTestId('bgp-ipv4-route-workspace')).toHaveAttribute(
            'data-active-group-id',
            'legacy-unc'
        );
        await expect(page.getByTestId('bgp-ipv4-route-group-name')).toHaveValue('旧普通组');
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('10.40.0.0');
        await page.getByTestId('bgp-ipv4-save-workspace-button').click();
        await expect(page.locator('.workspace-save-state')).toContainText('已保存');
        await openIpv4RoutePage(page, true);
        await expect(page.locator('.route-group-item')).toHaveCount(1);
        await expect(page.getByTestId('bgp-ipv4-label-route-workspace')).toHaveAttribute(
            'data-active-group-id',
            'legacy-label'
        );
        await expect(page.getByTestId('bgp-ipv4-label-route-group-name')).toHaveValue('旧标签组');
        await page.getByTestId('bgp-ipv4-label-tree-attribute-label').click();
        await expect(page.getByTestId('bgp-ipv4-label-attribute-start-input')).toHaveValue('20000');
        await expect(page.getByTestId('bgp-ipv4-label-attribute-step-input')).toHaveValue('5');
        await page.getByTestId('bgp-ipv4-label-tree-attribute-addPath').click();
        await expect(page.getByTestId('bgp-ipv4-label-attribute-count-input')).toHaveValue('2');
        await page.getByTestId('bgp-ipv4-label-save-workspace-button').click();
        await expect(page.locator('.workspace-save-state')).toContainText('已保存');
        const label = harness.controller.state.bgp.configs.get('Ipv4LabelRouteConfig').routeWorkspace;
        expect(label.groups[0].config.nlriRules.map(rule => rule.id)).toEqual([
            'legacy-label-rule',
            'legacy-path-rule'
        ]);
        await openIpv4RoutePage(page);
        await page.reload();
        await expect(page.getByTestId('bgp-ipv4-route-prefix-input')).toHaveValue('10.40.0.0');
        expect(harness.controller.state.bgp.legacyIpv4RouteConfig).toEqual(legacy);
    });

    test('adds and edits tree attributes with random, increment and list rules', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await openIpv4RoutePage(page);
        await expect(page.getByTestId('bgp-ipv4-route-tree')).toBeVisible();
        await page.getByTestId('bgp-ipv4-route-group-name').fill('随机属性试验');
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('10.50.0.0');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('24');
        await page.getByTestId('bgp-ipv4-route-count-input').fill('3');

        await removeIpv4Attribute(page, page.getByTestId('bgp-ipv4-tree-attribute-med'));
        await addIpv4Attribute(page, 'MED');
        await setIpv4AttributeMode(page, '随机');
        await page.getByTestId('bgp-ipv4-attribute-min-input').fill('10');
        await page.getByTestId('bgp-ipv4-attribute-max-input').fill('100');
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-med')).toContainText('随机');
        await expect(page.getByTestId('bgp-ipv4-attribute-preview')).toContainText('57');

        await addIpv4Attribute(page, 'Local Pref');
        await setIpv4AttributeMode(page, '递增');
        await page.getByTestId('bgp-ipv4-attribute-start-input').fill('100');
        await page.getByTestId('bgp-ipv4-attribute-step-input').fill('20');
        await expect(page.getByTestId('bgp-ipv4-attribute-preview')).toContainText('140');

        await addIpv4Attribute(page, 'AS Path');
        await setIpv4AttributeMode(page, '值列表');
        await page.getByTestId('bgp-ipv4-attribute-values-input').fill('65001 65002\n65003');
        await expect(page.getByTestId('bgp-ipv4-attribute-preview')).toContainText('65001 65002');
        await expect(page.getByTestId('bgp-ipv4-attribute-preview')).toContainText('65003');
        await generateIpv4Group(page);
        await expect(page.getByTestId('bgp-ipv4-route-table')).toContainText('10.50.0.0/24');
        const payload = await page.evaluate(() => window.__ipv4GeneratedPayload);
        expect(payload.routeWorkspace).toBeUndefined();
        expect(payload.attributeRules.find(rule => rule.type === 'med')).toMatchObject({
            mode: 'random',
            min: '10',
            max: '100'
        });
        expect(payload.attributeRules.find(rule => rule.type === 'localPref')).toMatchObject({
            mode: 'increment',
            start: '100',
            step: '20'
        });
        expect(payload.attributeRules.find(rule => rule.type === 'asPath').values).toEqual(['65001 65002', '65003']);

        await ipv4GroupAction(page, 'copy');
        await expect(page.locator('.route-group-item')).toHaveCount(2);
        await page.getByTestId('bgp-ipv4-tree-attribute-med').last().click();
        await page.getByTestId('bgp-ipv4-attribute-min-input').fill('500');
        await page.getByTestId('bgp-ipv4-attribute-max-input').fill('600');
        await removeIpv4Attribute(page, page.getByTestId('bgp-ipv4-tree-attribute-localPref').last());
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-localPref')).toHaveCount(1);
        await page.locator('.route-group-item').first().click();
        await page.getByTestId('bgp-ipv4-tree-attribute-med').first().click();
        await expect(page.getByTestId('bgp-ipv4-attribute-min-input')).toHaveValue('10');
        await expect(page.getByTestId('bgp-ipv4-attribute-max-input')).toHaveValue('100');
        await removeIpv4Attribute(page, page.getByTestId('bgp-ipv4-tree-attribute-med').first());
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-med')).toHaveCount(1);
        await page.getByTestId('bgp-ipv4-save-workspace-button').click();
        await expect(page.locator('.workspace-save-state')).toContainText('已保存');
        await page.reload();
        await expect(page.locator('.route-group-item')).toHaveCount(2);
        await page.getByTestId('bgp-ipv4-tree-attribute-asPath').first().click();
        await expect(page.getByTestId('bgp-ipv4-attribute-values-input')).toHaveValue('65001 65002\n65003');
        await page.getByTestId('bgp-ipv4-tree-attribute-med').click();
        await expect(page.getByTestId('bgp-ipv4-attribute-min-input')).toHaveValue('500');
        await expect(page.getByTestId('bgp-ipv4-attribute-max-input')).toHaveValue('600');
        await page.locator('.route-group-item').first().click();
        await addIpv4Attribute(page, 'MED', true);
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('0');
        await expect(page.getByTestId('bgp-ipv4-attribute-enabled-switch')).toHaveCount(0);
    });

    test('reuses route data across tabs and clears cached pages when BGP stops', async ({ page }) => {
        const ipv4Prefix = '203.0.113.77/32';
        const ipv6Prefix = '2001:db8::77/128';
        const labelPrefix = '198.51.100.77/32';
        const getRoutesCallCount = () =>
            harness.controller.timeline.filter(item => item.message === 'renderer API call: bgp.getRoutes').length;

        harness.controller.state.bgp.routes.set(1, [
            {
                ip: '203.0.113.77',
                mask: 32,
                rd: '0:0',
                pathId: 0,
                nextHop: '192.0.2.1',
                asPath: '65000',
                rt: '',
                addressFamily: 1
            }
        ]);
        harness.controller.state.bgp.routes.set(2, [
            {
                ip: '2001:db8::77',
                mask: 128,
                rd: '0:0',
                pathId: 0,
                nextHop: '2001:db8::1',
                asPath: '65000',
                rt: '',
                addressFamily: 2
            }
        ]);

        harness.controller.state.bgp.routes.set(12, [
            { ip: '198.51.100.77', mask: 32, pathId: 0, label: 100, addressFamily: 12 }
        ]);

        await openIpv4RoutePage(page);
        const routeTabs = page.locator('.fixed-tabs');
        const ipv4Table = page.getByTestId('bgp-ipv4-route-table');
        const ipv6Table = page.getByTestId('bgp-ipv6-route-table');
        const labelTable = page.getByTestId('bgp-ipv4-label-route-table');

        await expect(ipv4Table).toContainText(ipv4Prefix);
        expect(getRoutesCallCount()).toBe(1);

        await routeTabs.getByRole('tab', { name: 'IPv4 Label路由', exact: true }).click();
        await expect(labelTable).toContainText(labelPrefix);
        expect(getRoutesCallCount()).toBe(2);

        await routeTabs.getByRole('tab', { name: 'IPv6路由', exact: true }).click();
        await expect(page.getByTestId('bgp-route-ipv6-page')).toBeVisible();
        await expect(ipv6Table).toContainText(ipv6Prefix);
        expect(getRoutesCallCount()).toBe(3);

        await routeTabs.getByRole('tab', { name: 'IPv4-UNC路由', exact: true }).click();
        await expect(page.getByTestId('bgp-route-ipv4-page')).toBeVisible();
        await expect(ipv4Table).toContainText(ipv4Prefix);
        expect(getRoutesCallCount()).toBe(3);

        await page.evaluate(() => {
            window.__featureE2eEmit?.('bgp:runtimeChanged', {
                running: false,
                addressFamilies: []
            });
        });

        await expect(ipv4Table).not.toContainText(ipv4Prefix);
        expect(getRoutesCallCount()).toBe(3);

        await routeTabs.getByRole('tab', { name: 'IPv4 Label路由', exact: true }).click();
        await expect(labelTable).not.toContainText(labelPrefix);
        expect(getRoutesCallCount()).toBe(3);

        await routeTabs.getByRole('tab', { name: 'IPv6路由', exact: true }).click();
        await expect(page.getByTestId('bgp-route-ipv6-page')).toBeVisible();
        await expect(ipv6Table).not.toContainText(ipv6Prefix);
        expect(getRoutesCallCount()).toBe(3);

        await page.evaluate(() => {
            window.__featureE2eEmit?.('bgp:runtimeChanged', {
                running: true,
                addressFamilies: [1, 2, 12]
            });
        });

        await expect(ipv6Table).toContainText(ipv6Prefix);
        expect(getRoutesCallCount()).toBe(4);

        await routeTabs.getByRole('tab', { name: 'IPv4-UNC路由', exact: true }).click();
        await expect(page.getByTestId('bgp-route-ipv4-page')).toBeVisible();
        await expect(ipv4Table).toContainText(ipv4Prefix);
        expect(getRoutesCallCount()).toBe(5);

        await routeTabs.getByRole('tab', { name: 'IPv4 Label路由', exact: true }).click();
        await expect(labelTable).toContainText(labelPrefix);
        expect(getRoutesCallCount()).toBe(6);

        await routeTabs.getByRole('tab', { name: 'IPv6路由', exact: true }).click();
        await expect(ipv6Table).toContainText(ipv6Prefix);
        expect(getRoutesCallCount()).toBe(6);
    });

    test('clears the previous runtime before loading routes for a new BGP start', async ({ page }) => {
        const previousPrefix = '203.0.113.77/32';
        const currentPrefix = '198.51.100.88/32';

        harness.controller.state.bgp.routes.set(1, [
            {
                ip: '203.0.113.77',
                mask: 32,
                rd: '0:0',
                pathId: 0,
                nextHop: '192.0.2.1',
                asPath: '65000',
                rt: '',
                addressFamily: 1
            }
        ]);

        await openIpv4RoutePage(page);
        const ipv4Table = page.getByTestId('bgp-ipv4-route-table');
        await expect(ipv4Table).toContainText(previousPrefix);

        await page.evaluate(() => {
            const originalGetRoutes = window.bgpApi.getRoutes.bind(window.bgpApi);
            window.__bgpRuntimeRefreshPending = false;
            window.__resolveBgpRuntimeRefresh = null;
            window.bgpApi.getRoutes = (...args) =>
                new Promise(resolve => {
                    window.__bgpRuntimeRefreshPending = true;
                    window.__resolveBgpRuntimeRefresh = async () => {
                        const result = await originalGetRoutes(...args);
                        resolve(result);
                    };
                });
        });

        harness.controller.state.bgp.routes.set(1, [
            {
                ip: '198.51.100.88',
                mask: 32,
                rd: '0:0',
                pathId: 0,
                nextHop: '192.0.2.2',
                asPath: '65100',
                rt: '',
                addressFamily: 1
            }
        ]);

        await page.evaluate(() => {
            window.__featureE2eEmit?.('bgp:runtimeChanged', {
                running: true,
                addressFamilies: [1]
            });
        });

        await expect.poll(() => page.evaluate(() => window.__bgpRuntimeRefreshPending)).toBe(true);
        await expect(ipv4Table).not.toContainText(previousPrefix);
        await expect(ipv4Table).not.toContainText(currentPrefix);

        await page.evaluate(() => window.__resolveBgpRuntimeRefresh?.());
        await expect(ipv4Table).toContainText(currentPrefix);
        await expect(ipv4Table).not.toContainText(previousPrefix);
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
            await expect
                .poll(() =>
                    importButton.evaluate(button => {
                        const probe = document.createElement('span');
                        probe.style.backgroundColor = 'var(--nn-color-bg-card-head-ghost)';
                        document.body.appendChild(probe);
                        const matches =
                            getComputedStyle(button).backgroundColor === getComputedStyle(probe).backgroundColor;
                        probe.remove();
                        return matches;
                    })
                )
                .toBe(true);

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

    test('keeps the tree configuration height stable across every route page', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 720 });
        for (const pageCase of pageCases.slice(1)) {
            const prefix = pageCase.testPrefix;
            await page.goto(pageCase.route);
            await expect(page.getByTestId(`${prefix}-generate-routes-button`)).toBeEnabled();
            await expect(page.locator('.advanced-config-button')).toHaveCount(0);
            const workspace = page.getByTestId(`${prefix}-route-workspace`);
            const card = page.locator('.bgp-route-card');
            const list = page.locator('.bgp-route-list-card');
            const before = { card: await card.boundingBox(), list: await list.boundingBox() };
            await page.getByTestId(`${prefix}-tree-attribute-asPath`).click();
            await page.getByTestId(`${prefix}-attribute-mode-select`).click();
            await page.getByRole('option', { name: '值列表', exact: true }).click();
            await page.getByTestId(`${prefix}-attribute-values-input`).fill('65001 65002\n65003');
            const after = { card: await card.boundingBox(), list: await list.boundingBox() };
            expect(Math.abs(after.card.height - before.card.height)).toBeLessThanOrEqual(1);
            expect(Math.abs(after.list.y - before.list.y)).toBeLessThanOrEqual(1);
            expect(await workspace.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
            await expect(page.locator('.node-editor-footer')).toBeVisible();
        }
    });

    test('edits IPv4 Label under NLRI without horizontal overflow', async ({ page }) => {
        await page.setViewportSize({ width: 2056, height: 1209 });
        await openIpv4RoutePage(page, true);

        await expect(page.getByTestId('route-field-addressFamily')).toHaveCount(0);

        await expect(page.getByTestId('bgp-ipv4-label-tree-attribute-label')).toHaveAttribute(
            'data-rule-section',
            'nlri'
        );
        await page.getByTestId('bgp-ipv4-label-tree-attribute-label').click();
        await expect(page.locator('.node-editor-breadcrumb')).toContainText('NLRI / MPLS Label');
        await expect(page.getByTestId('bgp-ipv4-label-attribute-value-input')).toBeVisible();
        await page.getByTestId('bgp-ipv4-label-attribute-value-input').fill('100');
        await expect(page.getByTestId('bgp-ipv4-label-attribute-preview')).toContainText('100');
        const workspace = page.getByTestId('bgp-ipv4-label-route-workspace');
        expect(await workspace.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);

        await openIpv4RoutePage(page);
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-label')).toHaveCount(0);
        await generateIpv4Group(page);
        await expect
            .poll(() =>
                page.evaluate(() => window.__ipv4GeneratedPayload?.nlriRules?.some(rule => rule.type === 'label'))
            )
            .toBe(false);
        await expect(page.locator('.workspace-save-state')).toContainText('已保存');
        await openIpv4RoutePage(page, true);
        await page.getByTestId('bgp-ipv4-label-tree-attribute-label').click();
        await expect(page.getByTestId('bgp-ipv4-label-attribute-value-input')).toHaveValue('100');
    });

    test('classifies ADD-PATH as NLRI and SRv6 as a path attribute', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await openIpv4RoutePage(page);
        await expect(page.getByTestId('bgp-generate-ipv4-routes-button')).toBeEnabled();
        for (const entry of attributeRegistry.attributes.filter(
            item =>
                item.defaultNode &&
                item.treeGroup !== 'mpNlri' &&
                (!item.addressFamilies || item.addressFamilies.includes(1))
        )) {
            await expect(page.getByTestId(`bgp-ipv4-tree-attribute-${entry.type}`)).toHaveCount(1);
            await expect(page.getByTestId(`bgp-ipv4-tree-attribute-${entry.type}`)).toHaveAttribute(
                'data-rule-section',
                entry.section || 'attributes'
            );
        }
        await expect(page.locator('.advanced-config-button')).toHaveCount(0);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await page.getByTestId('bgp-ipv4-route-count-input').fill('2');
        await page.getByTestId('bgp-ipv4-tree-attribute-origin').click();
        await expect(page.getByTestId('bgp-ipv4-remove-attribute-button')).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-attribute-enabled-switch')).toHaveCount(0);

        await expect(page.getByTestId('bgp-ipv4-tree-attribute-addPath')).toHaveCount(0);
        await addIpv4Attribute(page, 'ADD-PATH');
        await expect(page.getByTestId('bgp-ipv4-attribute-mode-select')).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-attribute-count-input')).toBeEnabled();
        await page.getByTestId('bgp-ipv4-attribute-count-input').fill('3');
        await expect(page.getByTestId('bgp-ipv4-route-range-preview')).toContainText('2 个前缀 × 3 条路径 = 6 条路由');
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-srv6')).toHaveCount(0);
        await addIpv4Attribute(page, 'SRv6');
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toBeEnabled();
        await setIpv4AttributeMode(page, '递增');
        await page.getByTestId('bgp-ipv4-attribute-start-input').fill('2001:db8::100');
        await page.getByTestId('bgp-ipv4-attribute-step-input').fill('2');
        await page.getByTestId('bgp-ipv4-attribute-locatorBlockLength-input').fill('32');
        await page.getByTestId('bgp-ipv4-attribute-functionLength-input').fill('24');
        await expect(page.getByTestId('bgp-ipv4-attribute-preview')).toContainText('2001:db8::104');
        await generateIpv4Group(page);
        await expect
            .poll(() =>
                page.evaluate(
                    () => window.__ipv4GeneratedPayload?.nlriRules?.find(rule => rule.type === 'addPath')?.count
                )
            )
            .toBe('3');
        const payload = await page.evaluate(() => window.__ipv4GeneratedPayload);
        expect(payload.count).toBe('2');
        expect(payload.nlriRules.find(rule => rule.type === 'addPath')).toMatchObject({
            count: '3'
        });
        expect(payload.addPathEnabled).toBeUndefined();
        expect(payload.srv6Enabled).toBeUndefined();
        expect(payload.attributeRules.some(rule => ['addPath', 'label'].includes(rule.type))).toBe(false);
        expect(payload.nlriRules.some(rule => rule.type === 'srv6')).toBe(false);
        expect(payload.attributeRules.find(rule => rule.type === 'srv6')).toMatchObject({
            mode: 'increment',
            start: '2001:db8::100',
            step: '2',
            locatorBlockLength: '32',
            functionLength: '24'
        });
        await expect(page.locator('.workspace-save-state')).toContainText('已保存');
        await page.reload();
        await page.getByTestId('bgp-ipv4-tree-attribute-addPath').click();
        await expect(page.getByTestId('bgp-ipv4-attribute-count-input')).toHaveValue('3');
        await page.getByTestId('bgp-ipv4-tree-attribute-srv6').click();
        await expect(page.getByTestId('bgp-ipv4-attribute-start-input')).toHaveValue('2001:db8::100');
        await expect(page.getByTestId('bgp-ipv4-attribute-functionLength-input')).toHaveValue('24');
        const workspaceBox = await page.getByTestId('bgp-ipv4-route-workspace').boundingBox();
        for (const selector of ['.route-tree-panel', '.route-node-editor']) {
            const box = await page.locator(selector).boundingBox();
            expect(box.y + box.height).toBeLessThanOrEqual(workspaceBox.y + workspaceBox.height + 1);
        }
    });

    test('saves MP_REACH encoding and adds ADD-PATH back to the NLRI branch', async ({ page }) => {
        await openIpv4RoutePage(page);
        const encodingSelect = page.getByTestId('bgp-ipv4-nlri-encoding-select');
        await expect(encodingSelect).toContainText('自动（传统 NLRI）');
        await encodingSelect.click();
        await page.getByRole('option', { name: 'MP_REACH_NLRI', exact: true }).click();
        await page.getByTestId('bgp-ipv4-route-count-input').fill('2');

        await addIpv4Attribute(page, 'ADD-PATH');
        await removeIpv4Attribute(page, page.getByTestId('bgp-ipv4-tree-attribute-addPath'));
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-addPath')).toHaveCount(0);
        await expect(encodingSelect).toContainText('MP_REACH_NLRI');
        await addIpv4Attribute(page, 'ADD-PATH');
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-addPath')).toHaveAttribute('data-rule-section', 'nlri');
        await expect(page.locator('.node-editor-breadcrumb')).toContainText('NLRI / ADD-PATH');
        await page.getByTestId('bgp-ipv4-attribute-count-input').fill('3');
        await generateIpv4Group(page);
        await expect.poll(() => page.evaluate(() => window.__ipv4GeneratedPayload?.nlriEncoding)).toBe('mpReach');
        const payload = await page.evaluate(() => window.__ipv4GeneratedPayload);
        expect(payload.nlriRules.find(rule => rule.type === 'addPath')).toMatchObject({
            count: '3'
        });
        expect(payload.attributeRules.some(rule => rule.type === 'addPath')).toBe(false);
        await expect(page.locator('.workspace-save-state')).toContainText('已保存');

        await page.reload();
        await expect(encodingSelect).toContainText('MP_REACH_NLRI');
        await page.getByTestId('bgp-ipv4-tree-attribute-addPath').click();
        await expect(page.getByTestId('bgp-ipv4-attribute-count-input')).toHaveValue('3');
        await expect(page.getByTestId('bgp-ipv4-route-range-preview')).toContainText('6 条路由');

        await page.locator('.route-group-item').click();
        await openIpv4RoutePage(page, true);
        await page.getByTestId('bgp-ipv4-label-route-count-input').fill('2');
        await addIpv4Attribute(page, 'ADD-PATH');
        await page.getByTestId('bgp-ipv4-label-attribute-count-input').fill('3');
        await expect(encodingSelect).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-label-tree-attribute-label')).toHaveAttribute(
            'data-rule-section',
            'nlri'
        );
        await generateIpv4Group(page);
        await expect.poll(() => page.evaluate(() => window.__ipv4GeneratedPayload?.addressFamily)).toBe(12);
        const labelPayload = await page.evaluate(() => window.__ipv4GeneratedPayload);
        expect(labelPayload.nlriRules.some(rule => rule.type === 'label')).toBe(true);
        expect(labelPayload.attributeRules.some(rule => rule.type === 'label')).toBe(false);
        expect(labelPayload.nlriRules.find(rule => rule.type === 'addPath')).toMatchObject({
            count: '3'
        });
        expect(labelPayload.attributeRules.some(rule => rule.type === 'addPath')).toBe(false);
        await expectGeneratedCount(page, 6);
        expect(harness.controller.state.bgp.routes.get(1)).toHaveLength(6);
        expect(harness.controller.state.bgp.routes.get(12)).toHaveLength(6);
        await page.getByTestId('bgp-ipv4-label-tree-attribute-addPath').click();
        await expect(page.getByTestId('bgp-ipv4-label-attribute-enabled-switch')).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-label-attribute-count-input')).toHaveValue('3');
    });

    test('adds ADD-PATH from the Label NLRI menu and generates every path for every labeled prefix', async ({
        page
    }) => {
        await openIpv4RoutePage(page, true);
        await page.getByTestId('bgp-ipv4-label-route-group-name').fill('标签多路径组');
        await page.getByTestId('bgp-ipv4-label-route-prefix-input').fill('10.60.0.0');
        await page.getByTestId('bgp-ipv4-label-route-mask-input').fill('24');
        await page.getByTestId('bgp-ipv4-label-route-count-input').fill('3');
        await expect(page.getByTestId('bgp-ipv4-label-nlri-encoding-select')).toHaveCount(0);
        const addPathNode = page.getByTestId('bgp-ipv4-label-tree-attribute-addPath');
        await expect(addPathNode).toHaveCount(0);
        const groupId = await page.getByTestId('bgp-ipv4-label-route-workspace').getAttribute('data-active-group-id');
        await page.getByTestId(`bgp-ipv4-label-tree-nlri-${groupId}`).click({ button: 'right' });
        const nlriMenu = page.getByTestId('bgp-ipv4-label-nlri-context-menu');
        await expect(nlriMenu).toBeVisible();
        await expect(page.getByTestId('bgp-ipv4-label-group-context-menu')).toHaveCount(0);
        await page.getByTestId('bgp-ipv4-label-add-attribute-button').click();
        await expect(page.getByTestId('bgp-ipv4-label-add-attribute-addPath')).toBeVisible();
        await expect(
            page.getByTestId('bgp-ipv4-label-add-attribute-addPath').locator('..').locator('..')
        ).not.toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByTestId('bgp-ipv4-label-add-attribute-srv6')).toHaveCount(0);
        await page.getByTestId('bgp-ipv4-label-add-attribute-addPath').click();
        await expect(nlriMenu).toHaveCount(0);
        await expect(page.locator('.node-editor-breadcrumb')).toContainText('NLRI / ADD-PATH');
        await page.getByTestId('bgp-ipv4-label-attribute-count-input').fill('2');
        await expect(page.getByTestId('bgp-ipv4-label-route-range-preview')).toContainText(
            '3 个前缀 × 2 条路径 = 6 条路由'
        );
        await expect(page.getByTestId('bgp-ipv4-label-route-range-preview')).toContainText('10.60.2.0/24');

        await addIpv4Attribute(page, 'MP Next Hop');
        await expect(page.getByTestId('bgp-ipv4-label-attribute-mode-select')).not.toHaveAttribute(
            'aria-disabled',
            'true'
        );
        await expect(page.getByTestId('bgp-ipv4-label-mp-nlri-inactive-hint')).toHaveCount(0);
        await setIpv4AttributeMode(page, '固定值');
        await page.getByTestId('bgp-ipv4-label-attribute-value-input').fill('192.0.2.55');
        await page.getByTestId('bgp-ipv4-label-tree-attribute-label').click();
        await page.getByTestId('bgp-ipv4-label-attribute-value-input').fill('100');
        await expect(page.getByTestId('bgp-ipv4-label-tree-attribute-srv6')).toHaveCount(0);
        await page.getByTestId(`bgp-ipv4-label-tree-attributes-${groupId}`).click({ button: 'right' });
        await expect(page.getByTestId('bgp-ipv4-label-attribute-context-menu')).toBeVisible();
        await page.getByTestId('bgp-ipv4-label-add-attribute-button').click();
        await expect(page.getByTestId('bgp-ipv4-label-add-attribute-srv6')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await generateIpv4Group(page);
        await expectGeneratedCount(page, 6);
        const payload = await page.evaluate(() => window.__ipv4GeneratedPayload);
        expect(payload.addressFamily).toBe(12);
        expect(payload.count).toBe('3');
        expect(payload.nlriRules.find(rule => rule.type === 'addPath')).toMatchObject({ count: '2' });
        expect(payload.nlriRules.find(rule => rule.type === 'label')).toMatchObject({ value: '100' });
        expect(payload.nlriRules.find(rule => rule.type === 'mpNextHop')).toMatchObject({
            mode: 'fixed',
            value: '192.0.2.55'
        });
        expect(payload.attributeRules.some(rule => ['addPath', 'label', 'srv6'].includes(rule.type))).toBe(false);
        const routes = harness.controller.state.bgp.routes.get(12);
        expect(routes).toHaveLength(6);
        expect(routes.map(route => [route.ip, route.pathId])).toEqual([
            ['10.60.0.0', 0],
            ['10.60.0.0', 1],
            ['10.60.1.0', 0],
            ['10.60.1.0', 1],
            ['10.60.2.0', 0],
            ['10.60.2.0', 1]
        ]);
    });

    test('generates Count prefixes with the same ADD-PATH IDs for each prefix', async ({ page }) => {
        await openIpv4RoutePage(page);
        await page.getByTestId('bgp-ipv4-route-group-name').fill('多路径组');
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('203.0.113.10');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
        await page.getByTestId('bgp-ipv4-route-count-input').fill('5');
        await addIpv4Attribute(page, 'ADD-PATH');
        await expect(page.getByTestId('bgp-ipv4-attribute-mode-select')).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-attribute-auto-value-input')).toHaveCount(0);
        await page.getByTestId('bgp-ipv4-attribute-count-input').fill('2');
        await expect(page.getByTestId('bgp-ipv4-route-range-preview')).toContainText('5 个前缀 × 2 条路径 = 10 条路由');
        await expect(page.getByTestId('bgp-ipv4-route-range-preview')).toContainText('203.0.113.14/32');
        await generateIpv4Group(page);
        await expectGeneratedCount(page, 10);
        const payload = await page.evaluate(() => window.__ipv4GeneratedPayload);
        expect(payload.groupId).toBeTruthy();
        expect(payload.groupName).toBe('多路径组');
        expect(payload.autoPathId).toBeUndefined();
        expect(payload.count).toBe('5');
        expect(payload.nlriRules.find(rule => rule.type === 'addPath')).toMatchObject({ count: '2' });
        const routes = harness.controller.state.bgp.routes.get(1);
        expect(routes).toHaveLength(10);
        expect(routes.map(route => [route.ip, route.pathId])).toEqual(
            Array.from({ length: 5 }, (_, index) => [
                [`203.0.113.${10 + index}`, 0],
                [`203.0.113.${10 + index}`, 1]
            ]).flat()
        );
        await page.reload();
        await expectGeneratedCount(page, 10);
        await page.getByTestId('bgp-ipv4-tree-attribute-addPath').click();
        await expect(page.getByTestId('bgp-ipv4-attribute-count-input')).toHaveValue('2');
    });

    test('saves overlapping drafts but blocks their generation with the conflicting group key', async ({ page }) => {
        await openIpv4RoutePage(page);
        await page.getByTestId('bgp-ipv4-route-group-name').fill('已生成骨干');
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('198.51.100.10');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
        await page.getByTestId('bgp-ipv4-route-count-input').fill('2');
        await generateIpv4Group(page);
        await expectGeneratedCount(page, 2);
        const firstPayload = await page.evaluate(() => window.__ipv4GeneratedPayload);
        expect(harness.controller.state.bgp.routes.get(1).map(route => `${route.ip}/${route.mask}`)).toEqual([
            '198.51.100.10/32',
            '198.51.100.11/32'
        ]);
        await ipv4GroupAction(page, 'copy');
        await page.getByTestId('bgp-ipv4-route-group-name').fill('重叠草稿');
        // Use one shared NLRI so the conflict key does not depend on which valid intersection is returned.
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('198.51.100.11');
        await page.getByTestId('bgp-ipv4-save-workspace-button').click();
        await expect(page.locator('.workspace-save-state')).toContainText('已保存');
        await generateIpv4Group(page);
        await expect(page.locator('.nn-toast-error')).toContainText('已生成骨干');
        await expect(page.locator('.nn-toast-error')).toContainText('198.51.100.11/32');
        expect(await page.evaluate(() => window.__ipv4GeneratedPayload)).toEqual(firstPayload);
        expect(harness.controller.state.bgp.routes.get(1)).toHaveLength(2);
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('198.51.100.20');
        await generateIpv4Group(page);
        await expectGeneratedCount(page, 2);
        expect(harness.controller.state.bgp.routes.get(1)).toHaveLength(4);
    });

    test('withdraws actual group routes after draft changes and replaces only that group on regeneration', async ({
        page
    }) => {
        await openIpv4RoutePage(page);
        const groups = page.locator('.route-group-item');
        const prefixInput = page.getByTestId('bgp-ipv4-route-prefix-input');
        const countInput = page.getByTestId('bgp-ipv4-route-count-input');
        await prefixInput.fill('192.0.2.1');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
        await countInput.fill('3');
        await generateIpv4Group(page);
        await expectGeneratedCount(page, 3);
        const firstId = (await page.evaluate(() => window.__ipv4GeneratedPayload)).groupId;
        await ipv4GroupAction(page, 'copy');
        await prefixInput.fill('198.51.100.1');
        await countInput.fill('4');
        await generateIpv4Group(page);
        await expectGeneratedCount(page, 4);
        const secondId = (await page.evaluate(() => window.__ipv4GeneratedPayload)).groupId;
        await groups.first().click();
        await prefixInput.fill('203.0.113.1');
        await countInput.fill('2');
        await expectGeneratedCount(page, 3);
        await ipv4GroupAction(page, 'withdraw');
        await expectGeneratedCount(page, 0);
        expect(harness.controller.state.bgp.routes.get(1).every(route => route.groupId === secondId)).toBe(true);
        expect(harness.controller.state.bgp.routes.get(1)).toHaveLength(4);
        expect(
            harness.controller.timeline.find(item => item.message === 'renderer API call: bgp.withdrawRouteGroup').data
        ).toEqual({ groupId: firstId });
        await expect(prefixInput).toHaveValue('203.0.113.1');
        await generateIpv4Group(page);
        await expectGeneratedCount(page, 2);
        await countInput.fill('1');
        await generateIpv4Group(page);
        await expectGeneratedCount(page, 1);
        expect(harness.controller.state.bgp.routes.get(1)).toHaveLength(5);
        await ipv4GroupAction(page, 'remove');
        await expect(groups).toHaveCount(1);
        expect(harness.controller.state.bgp.routes.get(1)).toHaveLength(4);
        expect(harness.controller.state.bgp.routes.get(1).every(route => route.groupId === secondId)).toBe(true);
    });

    test('protects generated group configuration when BGP stops or withdrawal fails', async ({ page }) => {
        await openIpv4RoutePage(page);
        await page.getByTestId('bgp-ipv4-route-count-input').fill('2');
        await generateIpv4Group(page);
        await expectGeneratedCount(page, 2);
        await page.getByTestId('bgp-ipv4-add-group-button').click();
        await page.locator('.route-group-item').first().click();
        harness.controller.state.bgp.running = false;
        await page.evaluate(() =>
            window.__featureE2eEmit('bgp:runtimeChanged', { running: false, addressFamilies: [] })
        );
        await expectGeneratedCount(page, 2);
        await openIpv4GroupMenu(page);
        await expect(page.getByTestId('bgp-ipv4-group-context-menu').locator('.nn-context-menu-hint')).toContainText(
            '请启动 BGP 后刷新'
        );
        await expect(page.getByTestId('bgp-ipv4-remove-group-button')).toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Escape');
        await openIpv4GroupMenu(page);
        await expect(page.getByTestId('bgp-ipv4-withdraw-group-button')).toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Escape');
        harness.controller.state.bgp.running = true;
        await page.evaluate(() =>
            window.__featureE2eEmit('bgp:runtimeChanged', { running: true, addressFamilies: [1] })
        );
        await openIpv4GroupMenu(page);
        await expect(page.getByTestId('bgp-ipv4-remove-group-button')).not.toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Escape');
        await page.evaluate(() => {
            window.bgpApi.withdrawRouteGroup = async () => ({ status: 'error', msg: '模拟撤销失败' });
        });
        await ipv4GroupAction(page, 'remove');
        await expect(page.locator('.nn-toast-error')).toContainText('模拟撤销失败');
        await expect(page.locator('.route-group-item')).toHaveCount(2);
        expect(harness.controller.state.bgp.routes.get(1)).toHaveLength(2);
    });

    test('refreshes group counts after single-route and all-family deletion', async ({ page }) => {
        await openIpv4RoutePage(page);
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('203.0.113.1');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
        await page.getByTestId('bgp-ipv4-route-count-input').fill('3');
        await generateIpv4Group(page);
        await expectGeneratedCount(page, 3);
        await page
            .getByTestId('bgp-ipv4-route-table')
            .getByRole('button', { name: '删除', exact: true })
            .first()
            .click();
        await expectGeneratedCount(page, 2);
        await dismissNotifications(page);
        await page.getByRole('button', { name: '删除所有', exact: true }).click();
        await page
            .getByRole('dialog', { name: '确认删除', exact: true })
            .getByRole('button', { name: '确定', exact: true })
            .click();
        await expectGeneratedCount(page, 0);
        await openIpv4GroupMenu(page);
        await expect(page.getByTestId('bgp-ipv4-withdraw-group-button')).toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Escape');
    });

    test('edits repeated attributes independently and keeps Origin removed after reload', async ({ page }) => {
        await openIpv4RoutePage(page);
        const medNodes = page.getByTestId('bgp-ipv4-tree-attribute-med');
        await medNodes.click();
        await page.getByTestId('bgp-ipv4-attribute-value-input').fill('100');
        await addIpv4Attribute(page, 'MED', true);
        await expect(medNodes).toHaveCount(2);
        await expect(medNodes.nth(0)).toContainText('MED #1');
        await expect(medNodes.nth(1)).toContainText('MED #2');
        await page.getByTestId('bgp-ipv4-attribute-value-input').fill('200');
        await medNodes.first().click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('100');
        await medNodes.nth(1).click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('200');

        await removeIpv4Attribute(page, page.getByTestId('bgp-ipv4-tree-attribute-origin'));
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-origin')).toHaveCount(0);
        await medNodes.nth(1).click();
        await page.getByTestId('bgp-ipv4-attribute-value-input').fill('250');
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-origin')).toHaveCount(0);
        await generateIpv4Group(page);
        await expect(page.locator('.workspace-save-state')).toContainText('已保存');
        const payload = await page.evaluate(() => window.__ipv4GeneratedPayload);
        const medRules = payload.attributeRules.filter(rule => rule.type === 'med');
        expect(medRules.map(rule => rule.value)).toEqual(['100', '250']);
        expect(new Set(medRules.map(rule => rule.id)).size).toBe(2);
        expect(payload.attributeRules.some(rule => rule.type === 'origin')).toBe(false);

        await page.reload();
        await expect(medNodes).toHaveCount(2);
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-origin')).toHaveCount(0);
        await medNodes.first().click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('100');
        await medNodes.nth(1).click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('250');
        await removeIpv4Attribute(page, medNodes.nth(1));
        await expect(medNodes).toHaveCount(1);
        await medNodes.click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('100');
    });

    test('sends exactly the visible tree nodes and keeps deleted nodes absent after reload and tab changes', async ({
        page
    }) => {
        await openIpv4RoutePage(page);
        await page.getByTestId('bgp-ipv4-route-count-input').fill('2');
        const node = type => page.getByTestId(`${ipv4TestPrefix(page)}-tree-attribute-${type}`);
        const generateAndCheckPresence = async () => {
            await generateIpv4Group(page);
            await expect(ipv4GenerateButton(page)).toBeEnabled();
            const payload = await page.evaluate(() => window.__ipv4GeneratedPayload);
            const rules = [...payload.attributeRules, ...payload.nlriRules];
            const visibleTypes = await page
                .getByTestId(new RegExp(`^${ipv4TestPrefix(page)}-tree-attribute-`))
                .evaluateAll(
                    (elements, prefix) =>
                        elements.map(element => element.dataset.testid.replace(`${prefix}-tree-attribute-`, '')),
                    ipv4TestPrefix(page)
                );
            expect(rules.map(rule => rule.type).sort()).toEqual(visibleTypes.sort());
            expect(rules.every(rule => !Object.hasOwn(rule, 'enabled'))).toBe(true);
            await expect(page.getByTestId(`${ipv4TestPrefix(page)}-attribute-enabled-switch`)).toHaveCount(0);
            return payload;
        };
        await expect(node('addPath')).toHaveCount(0);
        await expect(node('srv6')).toHaveCount(0);
        await expect(node('mpNextHop')).toHaveCount(0);
        await expect(node('label')).toHaveCount(0);
        const initial = await generateAndCheckPresence();
        expect(initial.nlriRules).toEqual([]);
        await removeIpv4Attribute(page, node('med'));
        await removeIpv4Attribute(page, node('origin'));
        const removed = await generateAndCheckPresence();
        expect(removed.attributeRules.some(rule => ['med', 'origin'].includes(rule.type))).toBe(false);

        await addIpv4Attribute(page, 'MED');
        await page.getByTestId('bgp-ipv4-attribute-value-input').fill('321');
        await addIpv4Attribute(page, 'ADD-PATH');
        await addIpv4Attribute(page, 'SRv6');
        const added = await generateAndCheckPresence();
        expect(added.attributeRules.find(rule => rule.type === 'med')).toMatchObject({ value: '321' });
        expect(added.attributeRules.some(rule => rule.type === 'srv6')).toBe(true);
        expect(added.nlriRules.find(rule => rule.type === 'addPath')).toMatchObject({ count: 2 });
        await expectGeneratedCount(page, 4);
        await removeIpv4Attribute(page, node('addPath'));
        await removeIpv4Attribute(page, node('srv6'));
        const removedOptional = await generateAndCheckPresence();
        expect(removedOptional.nlriRules.some(rule => rule.type === 'addPath')).toBe(false);
        expect(removedOptional.attributeRules.some(rule => rule.type === 'srv6')).toBe(false);
        await expectGeneratedCount(page, 2);

        await expect(page.locator('.workspace-save-state')).toContainText('已保存');
        await openIpv4RoutePage(page, true);
        await expect(node('label')).toHaveCount(1);
        await removeIpv4Attribute(page, node('label'));
        await removeIpv4Attribute(page, node('mpNextHop'));
        await removeIpv4Attribute(page, node('origin'));
        const labelWithoutLabelNode = await generateAndCheckPresence();
        expect(labelWithoutLabelNode.addressFamily).toBe(12);
        expect(labelWithoutLabelNode.nlriRules).toEqual([]);
        await expect(page.locator('.workspace-save-state')).toContainText('已保存');
        await page.reload();
        await expect(ipv4GenerateButton(page)).toBeEnabled();
        await expect(node('label')).toHaveCount(0);
        await expect(node('origin')).toHaveCount(0);
        await expect(node('addPath')).toHaveCount(0);
        await expect(node('srv6')).toHaveCount(0);
        await openIpv4RoutePage(page);
        await expect(node('origin')).toHaveCount(0);
        await node('med').click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('321');
        await openIpv4RoutePage(page, true);
        await expect(node('label')).toHaveCount(0);
        await expect(node('mpNextHop')).toHaveCount(0);
        await generateAndCheckPresence();
    });

    test('uses explicit MP next hop nodes and preserves their independence from NEXT_HOP', async ({ page }) => {
        await openIpv4RoutePage(page);
        const mpNode = page.getByTestId('bgp-ipv4-tree-attribute-mpNextHop');
        const mpFolder = page.getByTestId(/^bgp-ipv4-tree-mp-nlri-/);
        const encodingSelect = page.getByTestId('bgp-ipv4-nlri-encoding-select');
        await expect(encodingSelect).toContainText('自动（传统 NLRI）');
        await expect(mpNode).toHaveCount(0);
        await expect(mpFolder).toHaveCount(0);
        const groupId = await page.getByTestId('bgp-ipv4-route-workspace').getAttribute('data-active-group-id');
        await page.getByTestId(`bgp-ipv4-tree-nlri-${groupId}`).click({ button: 'right' });
        await page.getByTestId('bgp-ipv4-add-attribute-button').click();
        await expect(page.getByTestId('bgp-ipv4-add-attribute-mpNextHop')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await encodingSelect.click();
        await page.getByRole('option', { name: 'MP_REACH_NLRI', exact: true }).click();
        await expect(mpNode).toHaveCount(0);
        await expect(mpFolder).toHaveCount(0);
        await generateIpv4Group(page);
        const emptyMpPayload = await page.evaluate(() => window.__ipv4GeneratedPayload);
        expect(emptyMpPayload.nlriEncoding).toBe('mpReach');
        expect(emptyMpPayload.nlriRules.some(rule => rule.type === 'mpNextHop')).toBe(false);

        await addIpv4Attribute(page, 'MP Next Hop');
        await expect(mpNode).toHaveAttribute('data-rule-section', 'nlri');
        await mpFolder.click();
        await expect(page.locator('.node-editor-breadcrumb')).toContainText('NLRI / MP_REACH_NLRI / MP Next Hop');
        await expect(page.getByTestId('bgp-ipv4-attribute-enabled-switch')).toHaveCount(0);
        await setIpv4AttributeMode(page, '固定值');
        await page.getByTestId('bgp-ipv4-attribute-value-input').fill('2001:db8::200');
        await page.getByTestId('bgp-ipv4-tree-attribute-nextHop').click();
        await setIpv4AttributeMode(page, '固定值');
        await page.getByTestId('bgp-ipv4-attribute-value-input').fill('192.0.2.10');
        await page.locator('.route-group-item').click();
        await page.getByTestId('bgp-ipv4-route-prefix-input').fill('203.0.113.1');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
        await page.getByTestId('bgp-ipv4-route-count-input').fill('5');
        await generateIpv4Group(page);
        await expect(page.locator('.workspace-save-state')).toContainText('已保存');
        const payload = await page.evaluate(() => window.__ipv4GeneratedPayload);
        expect(payload.count).toBe('5');
        expect(payload.nlriRules.find(rule => rule.type === 'mpNextHop')).toMatchObject({
            mode: 'fixed',
            value: '2001:db8::200'
        });
        expect(payload.attributeRules.find(rule => rule.type === 'nextHop')).toMatchObject({
            mode: 'fixed',
            value: '192.0.2.10'
        });
        expect(payload.attributeRules.some(rule => rule.type === 'mpNextHop')).toBe(false);
        await page.reload();
        await expect(encodingSelect).toContainText('MP_REACH_NLRI');
        await mpNode.click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('2001:db8::200');
        await page.getByTestId('bgp-ipv4-tree-attribute-nextHop').click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('192.0.2.10');
        await page.locator('.route-group-item').click();
        await encodingSelect.click();
        await page.getByRole('option', { name: '自动（传统 NLRI）', exact: true }).click();
        await expect(mpNode).toHaveCount(0);
        await expect(mpFolder).toHaveCount(0);
        await generateIpv4Group(page);
        const classicPayload = await page.evaluate(() => window.__ipv4GeneratedPayload);
        expect(classicPayload.nlriRules.some(rule => rule.type === 'mpNextHop')).toBe(false);
        await page.locator('.route-group-item').click();
        await encodingSelect.click();
        await page.getByRole('option', { name: 'MP_REACH_NLRI', exact: true }).click();
        await mpNode.click();
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toHaveValue('2001:db8::200');
        await removeIpv4Attribute(page, mpNode);
        await expect(mpNode).toHaveCount(0);
        await expect(mpFolder).toHaveCount(0);
        await generateIpv4Group(page);
        const deletedMpPayload = await page.evaluate(() => window.__ipv4GeneratedPayload);
        expect(deletedMpPayload.nlriEncoding).toBe('mpReach');
        expect(deletedMpPayload.nlriRules.some(rule => rule.type === 'mpNextHop')).toBe(false);
        await expect(page.locator('.workspace-save-state')).toContainText('已保存');
        await page.reload();
        await expect(encodingSelect).toContainText('MP_REACH_NLRI');
        await expect(mpNode).toHaveCount(0);
        await expect(mpFolder).toHaveCount(0);
        await encodingSelect.click();
        await page.getByRole('option', { name: '自动（传统 NLRI）', exact: true }).click();
        await encodingSelect.click();
        await page.getByRole('option', { name: 'MP_REACH_NLRI', exact: true }).click();
        await expect(mpNode).toHaveCount(0);
        await openIpv4RoutePage(page, true);
        await expect(page.getByTestId('bgp-ipv4-label-tree-attribute-mpNextHop')).toHaveCount(1);
        await addIpv4Attribute(page, 'MP Next Hop');
        await expect(page.getByTestId('bgp-ipv4-label-attribute-mode-select')).toContainText('自动');
        await expect(page.getByTestId('bgp-ipv4-label-attribute-enabled-switch')).toHaveCount(0);
        await generateIpv4Group(page);
        const automaticMpPayload = await page.evaluate(() => window.__ipv4GeneratedPayload);
        expect(automaticMpPayload.nlriRules.find(rule => rule.type === 'mpNextHop')).toMatchObject({ mode: 'auto' });
    });

    test('targets group operations only from the right-clicked group', async ({ page }) => {
        await openIpv4RoutePage(page);
        const groups = page.locator('.route-group-item');
        const prefix = page.getByTestId('bgp-ipv4-route-prefix-input');
        const count = page.getByTestId('bgp-ipv4-route-count-input');
        await page.getByTestId('bgp-ipv4-route-group-name').fill('第一组');
        await prefix.fill('192.0.2.1');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
        await count.fill('2');
        await generateIpv4Group(page);
        await expectGeneratedCount(page, 2);
        const firstId = (await page.evaluate(() => window.__ipv4GeneratedPayload)).groupId;
        await page.getByTestId('bgp-ipv4-add-group-button').click();
        await page.getByTestId('bgp-ipv4-route-group-name').fill('第二组');
        await prefix.fill('198.51.100.1');
        await page.getByTestId('bgp-ipv4-route-mask-input').fill('32');
        await count.fill('3');
        await generateIpv4Group(page);
        await expectGeneratedCount(page, 3);
        await groups.first().click();
        await ipv4GroupAction(page, 'copy', groups.nth(1));
        await expect(groups).toHaveCount(3);
        await groups.last().click();
        await expect(page.getByTestId('bgp-ipv4-route-group-name')).toHaveValue('第二组 副本');
        await expect(prefix).toHaveValue('198.51.100.1');
        await expect(count).toHaveValue('3');
        await ipv4GroupAction(page, 'remove');
        await expect(groups).toHaveCount(2);
        await groups.first().click();
        await ipv4GroupAction(page, 'withdraw', groups.nth(1));
        await expectGeneratedCount(page, 0);
        expect(harness.controller.state.bgp.routes.get(1)).toHaveLength(2);
        expect(harness.controller.state.bgp.routes.get(1).every(route => route.groupId === firstId)).toBe(true);
        await groups.first().click();
        await ipv4GroupAction(page, 'remove', groups.nth(1));
        await expect(groups).toHaveCount(1);
        await expect(page.getByTestId('bgp-ipv4-route-group-name')).toHaveValue('第一组');
        expect(harness.controller.state.bgp.routes.get(1)).toHaveLength(2);
    });

    test('scopes right-click menus to their tree nodes and edits the right-clicked attribute instance', async ({
        page
    }) => {
        await openIpv4RoutePage(page);
        const groupMenu = page.getByTestId('bgp-ipv4-group-context-menu');
        const attributeMenu = page.getByTestId('bgp-ipv4-attribute-context-menu');
        const nlriMenu = page.getByTestId('bgp-ipv4-nlri-context-menu');
        const medNodes = page.getByTestId('bgp-ipv4-tree-attribute-med');
        const value = page.getByTestId('bgp-ipv4-attribute-value-input');
        const workspace = page.getByTestId('bgp-ipv4-route-workspace');
        await medNodes.click();
        await value.fill('100');
        const firstGroupId = await workspace.getAttribute('data-active-group-id');
        await page.getByTestId('bgp-ipv4-add-group-button').click();
        await medNodes.last().click();
        await value.fill('200');
        const secondGroupId = await workspace.getAttribute('data-active-group-id');

        await medNodes.first().click({ button: 'right' });
        await expect(attributeMenu).toBeVisible();
        await expect(groupMenu).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-copy-group-button')).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-withdraw-group-button')).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-remove-group-button')).toHaveCount(0);
        await expect(value).toHaveValue('100');
        await expect(workspace).toHaveAttribute('data-active-group-id', firstGroupId);
        await page.getByTestId('bgp-ipv4-add-attribute-button').click();
        await expect(page.getByTestId('bgp-ipv4-add-attribute-addPath')).toHaveCount(0);
        await page.getByTestId('bgp-ipv4-add-attribute-med').click();
        await expect(attributeMenu).toHaveCount(0);
        await expect(medNodes).toHaveCount(3);
        await value.fill('300');
        await expect(medNodes.nth(0)).toContainText('MED #1');
        await expect(medNodes.nth(1)).toContainText('MED #2');
        await removeIpv4Attribute(page, medNodes.last());
        await expect(workspace).toHaveAttribute('data-active-group-id', secondGroupId);
        await expect(medNodes).toHaveCount(2);
        await medNodes.first().click();
        await expect(value).toHaveValue('100');
        await medNodes.nth(1).click();
        await expect(value).toHaveValue('300');

        await page.getByTestId(`bgp-ipv4-tree-attributes-${firstGroupId}`).click({ button: 'right' });
        await expect(attributeMenu).toBeVisible();
        await expect(groupMenu).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-remove-attribute-button')).toHaveCount(0);
        await page.keyboard.press('Escape');

        await expect(page.getByTestId('bgp-ipv4-tree-attribute-addPath')).toHaveCount(0);
        await page.getByTestId(`bgp-ipv4-tree-nlri-${firstGroupId}`).click({ button: 'right' });
        await expect(nlriMenu).toBeVisible();
        await expect(attributeMenu).toHaveCount(0);
        await expect(groupMenu).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-remove-attribute-button')).toHaveCount(0);
        await page.getByTestId('bgp-ipv4-add-attribute-button').click();
        await expect(page.getByTestId('bgp-ipv4-add-attribute-med')).toHaveCount(0);
        await page.getByTestId('bgp-ipv4-add-attribute-addPath').click();
        await expect(nlriMenu).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-tree-attribute-addPath')).toHaveCount(1);
        await expect(page.locator('.node-editor-breadcrumb')).toContainText('NLRI / ADD-PATH');
        await expect(page.locator('.add-attribute-actions')).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-attribute-type-select')).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-add-attribute-button')).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-remove-attribute-button')).toHaveCount(0);
    });

    test('closes the group context menu on Escape, outside click and tree scroll and keeps it in the viewport', async ({
        page
    }) => {
        await page.setViewportSize({ width: 1280, height: 720 });
        await openIpv4RoutePage(page);
        await page.getByTestId('bgp-ipv4-add-group-button').click();
        const group = page.locator('.route-group-item').first();
        const menu = page.getByTestId('bgp-ipv4-group-context-menu');
        await group.evaluate(element =>
            element.dispatchEvent(
                new MouseEvent('contextmenu', { clientX: 1278, clientY: 718, bubbles: true, cancelable: true })
            )
        );
        await expect(menu).toBeVisible();
        const box = await menu.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(8);
        expect(box.y).toBeGreaterThanOrEqual(8);
        expect(box.x + box.width).toBeLessThanOrEqual(1273);
        expect(box.y + box.height).toBeLessThanOrEqual(713);
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
        await openIpv4GroupMenu(page, group);
        await page.locator('.node-editor-breadcrumb').click();
        await expect(menu).toHaveCount(0);
        await openIpv4GroupMenu(page, group);
        await page.locator('.route-tree-scroll').evaluate(element => {
            element.scrollTop += 50;
        });
        await expect(menu).toHaveCount(0);
        await expect(page.locator('.tree-group-actions')).toHaveCount(0);
        await expect(page.getByTestId('bgp-ipv4-withdraw-group-button')).toHaveCount(0);
    });

    test('keeps the configuration card, footer and route table fixed across attribute modes and long SRv6 fields', async ({
        page
    }) => {
        for (const size of [
            { width: 1280, height: 720 },
            { width: 640, height: 800 }
        ]) {
            await page.setViewportSize(size);
            await openIpv4RoutePage(page);
            await page.locator('.route-group-item').first().click();
            const geometry = async () =>
                page.evaluate(() => {
                    const container = document.querySelector('.bgp-route-page');
                    const card = document.querySelector('.bgp-route-card').getBoundingClientRect();
                    const table = document.querySelector('.bgp-route-list-card').getBoundingClientRect();
                    const footer = document.querySelector('.node-editor-footer').getBoundingClientRect();
                    // Narrow pages scroll when a tree node or select receives focus.
                    // Compare their content coordinates so scrolling cannot look like a layout shift.
                    const offset = container.scrollTop - container.getBoundingClientRect().top;
                    return {
                        card: card.height,
                        table: table.top + offset,
                        footer: footer.top + offset,
                        tableHeight: table.height,
                        footerHeight: footer.height
                    };
                });
            const baseline = await geometry();
            const expectStable = async () => {
                const current = await geometry();
                for (const key of Object.keys(baseline))
                    expect(Math.abs(current[key] - baseline[key])).toBeLessThanOrEqual(1);
            };
            await page.getByTestId('bgp-ipv4-tree-attribute-med').click();
            for (const mode of ['固定值', '递增', '随机', '值列表']) {
                await setIpv4AttributeMode(page, mode);
                if (mode === '值列表')
                    await page
                        .getByTestId('bgp-ipv4-attribute-values-input')
                        .fill(Array.from({ length: 40 }, (_, index) => String(index)).join('\n'));
                await expectStable();
            }
            await addIpv4Attribute(page, 'SRv6');
            await expect(page.getByTestId('bgp-ipv4-attribute-enabled-switch')).toHaveCount(0);
            for (const mode of ['固定值', '递增', '值列表']) {
                await setIpv4AttributeMode(page, mode);
                await expectStable();
            }
            const scrollBody = page.getByTestId('bgp-ipv4-node-editor-scroll');
            expect(await scrollBody.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
            await scrollBody.evaluate(element => {
                element.scrollTop = element.scrollHeight;
            });
            await expectStable();
            const workspace = page.getByTestId('bgp-ipv4-route-workspace');
            expect(await workspace.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
        }
    });

    test('keeps the SRv6 tree editor responsive in a narrower window', async ({ page }) => {
        await page.setViewportSize({ width: 640, height: 800 });
        await openIpv4RoutePage(page);
        await addIpv4Attribute(page, 'SRv6');
        await expect(page.getByTestId('bgp-ipv4-attribute-value-input')).toBeEnabled();
        const workspace = page.getByTestId('bgp-ipv4-route-workspace');
        expect(await workspace.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
    });
});
