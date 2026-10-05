const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e } = require('../../scripts/e2e-support');
const { collectBgpGeneratedRoutes } = require('../../electron/utils/bgp/simulator/bgpRouteGenerator');

const profiles = [
    { key: 'vpnv4', family: 4, configName: 'Vpnv4RouteConfig', prefix: '10.60.0.0', mask: '24' },
    { key: 'vpnv6', family: 5, configName: 'Vpnv6RouteConfig', prefix: '2001:db8:60::', mask: '64' }
];
const field = (page, profile, key) => page.getByTestId(`bgp-${profile}-route-${key}-input`);
const generateButton = (page, profile) => page.getByTestId(`bgp-${profile}-generate-routes-button`);

async function selectOption(page, testId, label) {
    await page.getByTestId(testId).click();
    await page.getByRole('option', { name: label, exact: true }).click();
}
async function activeNlriNode(page, profile, type) {
    const prefix = `bgp-${profile}`;
    const groupId = await page.getByTestId(`${prefix}-route-workspace`).getAttribute('data-active-group-id');
    const ruleId = await page.getByTestId(`${prefix}-tree-group-${groupId}`).evaluate((title, testId) => {
        for (let row = title.closest('[role="treeitem"]').nextElementSibling; row; row = row.nextElementSibling) {
            if (row.querySelector('.route-group-item')) break;
            const node = row.querySelector(`[data-testid="${testId}"]`);
            if (node) return node.dataset.ruleId;
        }
        return null;
    }, `${prefix}-tree-attribute-${type}`);
    expect(ruleId, `active ${profile} group must have a ${type} node`).toBeTruthy();
    return page.locator(`[data-testid="${prefix}-tree-attribute-${type}"][data-rule-id="${ruleId}"]`);
}

async function configureNlriNode(page, profile, type, mode, values) {
    const prefix = `bgp-${profile}`;
    await (await activeNlriNode(page, profile, type)).click();
    await selectOption(page, `${prefix}-attribute-mode-select`, mode);
    for (const [key, value] of Object.entries(values))
        await page.getByTestId(`${prefix}-attribute-${key}-input`).fill(value);
}

async function expectNlriNodeValues(page, profile, type, mode, values) {
    const prefix = `bgp-${profile}`;
    await (await activeNlriNode(page, profile, type)).click();
    await expect(page.getByTestId(`${prefix}-attribute-mode-select`)).toContainText(mode);
    for (const [key, value] of Object.entries(values))
        await expect(page.getByTestId(`${prefix}-attribute-${key}-input`)).toHaveValue(value);
}

async function expectRequiredNlriNodes(page, profile, types = ['rd', 'label']) {
    const prefix = `bgp-${profile}`;
    for (const type of types) {
        const node = page.getByTestId(`${prefix}-tree-attribute-${type}`);
        await expect(node).toHaveCount(1);
        await expect(node).toHaveAttribute('data-rule-section', 'nlri');
        await node.click({ button: 'right' });
        const menu = page.getByTestId(`${prefix}-nlri-context-menu`);
        await expect(menu).toBeVisible();
        const remove = page.getByTestId(`${prefix}-remove-attribute-button`);
        await expect(remove.locator('..').locator('..')).toHaveAttribute('aria-disabled', 'true');
        await remove.click({ force: true });
        await expect(node).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
    }
    const groupId = await page.getByTestId(`${prefix}-route-workspace`).getAttribute('data-active-group-id');
    await page.getByTestId(`${prefix}-tree-nlri-${groupId}`).click({ button: 'right' });
    await page.getByTestId(`${prefix}-add-attribute-button`).click();
    for (const type of types) {
        const add = page.getByTestId(`${prefix}-add-attribute-${type}`);
        await expect(add.locator('..').locator('..')).toHaveAttribute('aria-disabled', 'true');
        await add.click({ force: true });
        await expect(page.getByTestId(`${prefix}-tree-attribute-${type}`)).toHaveCount(1);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(`${prefix}-nlri-context-menu`)).toHaveCount(0);
}

const evpnTypeNames = [
    'Ethernet Auto-Discovery',
    'MAC/IP Advertisement',
    'Inclusive Multicast Ethernet Tag',
    'Ethernet Segment',
    'IP Prefix'
];
const evpnForwardingNodes = ['label', 'label2', 'vni', 'vni2', 'srv6L2', 'srv6L3'];

async function selectEvpnRoot(page) {
    const groupId = await page.getByTestId('bgp-evpn-route-workspace').getAttribute('data-active-group-id');
    await page.getByTestId(`bgp-evpn-tree-nlri-${groupId}`).click();
}
async function selectEvpnType(page, type) {
    await selectEvpnRoot(page);
    await selectOption(page, 'bgp-evpn-route-routeType-select', `Type ${type} · ${evpnTypeNames[type - 1]}`);
}
async function selectEvpnEncapsulation(page, encapsulation) {
    await selectEvpnRoot(page);
    await selectOption(page, 'bgp-evpn-route-encapsulationType-select', encapsulation);
}
async function addNlriNode(page, profile, type) {
    const prefix = `bgp-${profile}`;
    const groupId = await page.getByTestId(`${prefix}-route-workspace`).getAttribute('data-active-group-id');
    await page.getByTestId(`${prefix}-tree-nlri-${groupId}`).click({ button: 'right' });
    await page.getByTestId(`${prefix}-add-attribute-button`).click();
    await page.getByTestId(`${prefix}-add-attribute-${type}`).click();
    await expect(page.getByTestId(`${prefix}-nlri-context-menu`)).toHaveCount(0);
}
async function removeNlriNode(page, profile, type) {
    const prefix = `bgp-${profile}`;
    await (await activeNlriNode(page, profile, type)).click({ button: 'right' });
    const remove = page.getByTestId(`${prefix}-remove-attribute-button`);
    await expect(remove.locator('..').locator('..')).not.toHaveAttribute('aria-disabled', 'true');
    await remove.click();
    await expect(page.getByTestId(`${prefix}-tree-attribute-${type}`)).toHaveCount(0);
}
async function expectEvpnForwardingNodes(page, types) {
    for (const type of evpnForwardingNodes)
        await expect(page.getByTestId(`bgp-evpn-tree-attribute-${type}`)).toHaveCount(types.includes(type) ? 1 : 0);
}
async function saveAndReloadEvpn(page) {
    await dismissToasts(page);
    await expect(page.locator('.nn-toast')).toHaveCount(0);
    await page.getByTestId('bgp-evpn-save-workspace-button').click();
    await expect(page.locator('.workspace-save-state')).toContainText('已保存');
    await page.reload();
    await expect(generateButton(page, 'evpn')).toBeEnabled();
}
function expectOnlyEvpnRules(payload, types) {
    const forwarding = payload.nlriRules.filter(rule => evpnForwardingNodes.includes(rule.type));
    expect(forwarding.map(rule => rule.type).sort()).toEqual([...types].sort());
    for (const key of ['rd', 'label', 'label2', 'vni', 'vni2']) expect(payload).not.toHaveProperty(key);
    expect(payload.attributeRules.some(rule => ['rd', ...evpnForwardingNodes].includes(rule.type))).toBe(false);
    if (payload.encapsulationType === 'srv6')
        expect(payload.nlriRules.find(rule => rule.type === 'mpNextHop')).toMatchObject({
            mode: 'fixed',
            value: '2001:db8::1'
        });
}

async function selectFamily(page, testId, label) {
    const select = page.getByTestId(testId);
    await select.press('ArrowDown');
    await page.getByRole('option', { name: label, exact: true }).click();
    await select.press('Escape');
    await expect(select.getByRole('button', { name: `移除 ${label}`, exact: true })).toBeVisible();
}
async function dismissToasts(page) {
    const closeButtons = page.locator('.nn-toast:not(.nn-toast-leaving) .nn-toast-close');
    while (await closeButtons.count()) await closeButtons.first().click();
}
async function generate(page, profile) {
    await dismissToasts(page);
    await generateButton(page, profile).click();
    await expect(generateButton(page, profile)).toBeEnabled();
    await expect(page.locator('.nn-toast-error')).toHaveCount(0);
}
async function groupAction(page, profile, action) {
    const prefix = `bgp-${profile}`;
    const groupId = await page.getByTestId(`${prefix}-route-workspace`).getAttribute('data-active-group-id');
    await page.getByTestId(`${prefix}-tree-group-${groupId}`).click({ button: 'right' });
    await expect(page.getByTestId(`${prefix}-group-context-menu`)).toBeVisible();
    await page.getByTestId(`${prefix}-${action}-group-button`).click();
}

async function installApiBridge(page) {
    await page.addInitScript(() => {
        const patch = api => {
            api = api || {};
            const call = (method, ...args) => window.__featureE2eCall(`bgp.${method}`, ...args);
            for (const name of ['Vpnv4', 'Vpnv6', 'Evpn']) {
                api[`load${name}RouteConfig`] = () => call(`load${name}RouteConfig`);
                api[`save${name}RouteConfig`] = config => call(`save${name}RouteConfig`, config);
                api[`generate${name}Routes`] = config => call('generateRoutes', config);
                api[`delete${name}Routes`] = config => call('deleteRoutes', config);
            }
            for (const name of ['Ipv4', 'Ipv6']) {
                api[`load${name}PeerConfig`] = () => call(`load${name}PeerConfig`);
                api[`save${name}PeerConfig`] = config => call(`save${name}PeerConfig`, config);
                api[`config${name}Peer`] = config => call(`config${name}Peer`, config);
            }
            Object.assign(api, {
                loadBgpConfig: () => call('loadBgpConfig'),
                saveBgpConfig: config => call('saveBgpConfig', config),
                startBgp: config => call('startBgp', config),
                stopBgp: () => call('stopBgp'),
                getInstanceInfo: () => Promise.resolve({ status: 'success', data: [] }),
                getPeerInfo: () => Promise.resolve({ status: 'success', data: {} }),
                getRouteGroupStates: () => call('getRouteGroupStates'),
                withdrawRouteGroup: config => call('withdrawRouteGroup', config),
                getRoutes: (...args) => call('getRoutes', ...args)
            });
            return api;
        };
        let current = patch(window.bgpApi);
        Object.defineProperty(window, 'bgpApi', {
            configurable: true,
            get: () => current,
            set: value => {
                current = patch(value);
            }
        });
    });
}

test.describe('BGP VPNv4 VPNv6 EVPN construction', () => {
    let harness;
    let payloads;
    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
        payloads = [];
        const controller = harness.controller;
        const originalCall = controller.call.bind(controller);
        controller.call = async (method, ...args) => {
            const bgp = controller.state.bgp;
            if (method === 'bgp.generateRoutes') {
                const config = JSON.parse(JSON.stringify(args[0]));
                payloads.push(config);
                const generated = collectBgpGeneratedRoutes(config).map((route, index) => ({
                    ...route,
                    routeKey: `${config.groupId}:${index}`,
                    groupId: config.groupId,
                    groupName: config.groupName
                }));
                const previous = (bgp.routes.get(config.addressFamily) || []).filter(
                    route => route.groupId !== config.groupId
                );
                bgp.routes.set(config.addressFamily, [...previous, ...generated]);
                return { status: 'success', data: { added: generated.length }, msg: '路由生成成功' };
            }
            if (method === 'bgp.getRouteGroupStates') {
                const groups = new Map();
                for (const routes of bgp.routes.values()) {
                    for (const route of routes) {
                        const group = groups.get(route.groupId) || {
                            groupId: route.groupId,
                            groupName: route.groupName,
                            addressFamily: route.addressFamily,
                            routeCount: 0
                        };
                        group.routeCount++;
                        groups.set(route.groupId, group);
                    }
                }
                return { status: 'success', data: { groups: [...groups.values()] } };
            }
            if (method === 'bgp.withdrawRouteGroup') {
                let deleted = 0;
                for (const [family, routes] of bgp.routes) {
                    const remaining = routes.filter(route => route.groupId !== args[0].groupId);
                    deleted += routes.length - remaining.length;
                    bgp.routes.set(family, remaining);
                }
                return { status: 'success', data: { deleted } };
            }
            if (method === 'bgp.deleteRoutes') {
                const identity = args[0];
                const keys = [
                    'routeType',
                    'rd',
                    'esi',
                    'ethernetTagId',
                    'macAddress',
                    'ipAddress',
                    'originatingRouterIp',
                    'ip',
                    'mask'
                ];
                const routes = bgp.routes.get(identity.addressFamily) || [];
                const target = routes.find(route =>
                    keys.every(key => identity[key] === undefined || String(identity[key]) === String(route[key]))
                );
                bgp.routes.set(
                    identity.addressFamily,
                    routes.filter(route => route !== target)
                );
                return { status: 'success', data: { deleted: target ? 1 : 0 }, msg: '路由删除成功' };
            }
            return originalCall(method, ...args);
        };
        await installApiBridge(page);
    });
    test.afterEach(async () => {
        await harness?.cleanup();
    });

    for (const profile of profiles) {
        test(`${profile.key} builds labeled RD routes and restores independent groups`, async ({ page }) => {
            const prefix = `bgp-${profile.key}`;
            await page.goto(`/#/bgp/route-${profile.key}`);
            await expect(generateButton(page, profile.key)).toBeEnabled();
            await field(page, profile.key, 'prefix').fill(profile.prefix);
            await field(page, profile.key, 'mask').fill(profile.mask);
            await field(page, profile.key, 'count').fill('2');
            await expect(field(page, profile.key, 'rd')).toHaveCount(0);
            await expect(page.getByTestId(`${prefix}-route-labelMode-select`)).toHaveCount(0);
            await configureNlriNode(page, profile.key, 'rd', '固定值', { value: '65000:100' });
            await configureNlriNode(page, profile.key, 'label', '递增', { start: '20000', step: '5' });
            await generate(page, profile.key);
            await expect.poll(() => payloads.length).toBe(1);
            expect(payloads[0]).toMatchObject({
                addressFamily: profile.family,
                nlriRules: expect.arrayContaining([
                    expect.objectContaining({ type: 'rd', mode: 'fixed', value: '65000:100' }),
                    expect.objectContaining({ type: 'label', mode: 'increment', start: '20000', step: '5' })
                ])
            });
            const routes = harness.controller.state.bgp.routes.get(profile.family);
            expect(routes.map(route => route.rd)).toEqual(['65000:100', '65000:100']);
            expect(routes.map(route => route.label)).toEqual([20000, 20005]);
            await expect(page.getByTestId(`${prefix}-route-table`)).toContainText('65000:100');

            await page.getByTestId(`${prefix}-add-group-button`).click();
            await configureNlriNode(page, profile.key, 'rd', '固定值', { value: '65000:200' });
            await page.locator('.route-group-item').last().click();
            await field(page, profile.key, 'count').fill('1');
            await generate(page, profile.key);
            await expect.poll(() => payloads.length).toBe(2);
            const saved = harness.controller.state.bgp.configs.get(profile.configName);
            expect(saved.routeWorkspace.groups).toHaveLength(2);
            expect(saved.routeWorkspace.profile).toBe(profile.key);
            await page.reload();
            await expect(generateButton(page, profile.key)).toBeEnabled();
            await expectNlriNodeValues(page, profile.key, 'rd', '固定值', { value: '65000:200' });
            await page.locator('.route-group-item').last().click();
            await expect(page.getByTestId(`${prefix}-route-group-name`)).toHaveValue('路由组 2');
            await groupAction(page, profile.key, 'withdraw');
            await expect.poll(() => harness.controller.state.bgp.routes.get(profile.family).length).toBe(2);
            await groupAction(page, profile.key, 'remove');
            await expect(page.getByTestId(`${prefix}-route-group-name`)).toHaveValue('路由组 1');
            await expect(page.getByTestId(`${prefix}-route-table`)).toContainText('20005');
        });

        test(`${profile.key} keeps mandatory RD and Label nodes unique and restores all generation modes`, async ({
            page
        }) => {
            const prefix = `bgp-${profile.key}`;
            await page.goto(`/#/bgp/route-${profile.key}`);
            await expect(generateButton(page, profile.key)).toBeEnabled();
            await field(page, profile.key, 'prefix').fill(profile.prefix);
            await field(page, profile.key, 'mask').fill(profile.mask);
            await field(page, profile.key, 'count').fill('3');
            await expectRequiredNlriNodes(page, profile.key);
            const modes = [
                {
                    name: '固定值',
                    mode: 'fixed',
                    rd: { value: '65000:100' },
                    label: { value: '1000' },
                    rds: ['65000:100', '65000:100', '65000:100'],
                    labels: [1000, 1000, 1000]
                },
                {
                    name: '递增',
                    mode: 'increment',
                    rd: { base: '192.0.2.1', start: '100', step: '5' },
                    label: { start: '20000', step: '5' },
                    rds: ['192.0.2.1:100', '192.0.2.1:105', '192.0.2.1:110'],
                    labels: [20000, 20005, 20010]
                },
                {
                    name: '随机',
                    mode: 'random',
                    rd: { base: '65000', min: '100', max: '102' },
                    label: { min: '30000', max: '30002' }
                },
                {
                    name: '值列表',
                    mode: 'list',
                    rd: { values: '65000:200\n192.0.2.1:300' },
                    label: { values: '40000\n40005' },
                    rds: ['65000:200', '192.0.2.1:300', '65000:200'],
                    labels: [40000, 40005, 40000]
                }
            ];
            for (const [index, setting] of modes.entries()) {
                await configureNlriNode(page, profile.key, 'rd', setting.name, setting.rd);
                await configureNlriNode(page, profile.key, 'label', setting.name, setting.label);
                await page.getByTestId(`${prefix}-save-workspace-button`).click();
                await expect(page.locator('.workspace-save-state')).toContainText('已保存');
                await page.reload();
                await expect(generateButton(page, profile.key)).toBeEnabled();
                await expectNlriNodeValues(page, profile.key, 'rd', setting.name, setting.rd);
                await expectNlriNodeValues(page, profile.key, 'label', setting.name, setting.label);
                await generate(page, profile.key);
                await expect.poll(() => payloads.length).toBe(index + 1);
                const payload = payloads[index];
                expect(payload.nlriRules.filter(rule => rule.type === 'rd')).toHaveLength(1);
                expect(payload.nlriRules.filter(rule => rule.type === 'label')).toHaveLength(1);
                for (const type of ['rd', 'label']) {
                    const expected = Object.fromEntries(
                        Object.entries(setting[type]).map(([key, value]) => [
                            key,
                            key === 'values' ? value.split('\n') : value
                        ])
                    );
                    expect(payload.nlriRules.find(rule => rule.type === type)).toMatchObject({
                        mode: setting.mode,
                        ...expected
                    });
                    expect(payload.attributeRules.some(rule => rule.type === type)).toBe(false);
                }
                for (const key of ['rd', 'label', 'labelMode', 'labelStart', 'labelStep'])
                    expect(payload).not.toHaveProperty(key);
                const rows = harness.controller.state.bgp.routes.get(profile.family);
                expect(rows).toHaveLength(3);
                if (setting.mode === 'random') {
                    for (const row of rows) {
                        expect(row.rd.split(':')[0]).toBe('65000');
                        expect(Number(row.rd.split(':')[1])).toBeGreaterThanOrEqual(100);
                        expect(Number(row.rd.split(':')[1])).toBeLessThanOrEqual(102);
                        expect(row.label).toBeGreaterThanOrEqual(30000);
                        expect(row.label).toBeLessThanOrEqual(30002);
                    }
                } else {
                    expect(rows.map(row => row.rd)).toEqual(setting.rds);
                    expect(rows.map(row => row.label)).toEqual(setting.labels);
                }
            }
            await expectRequiredNlriNodes(page, profile.key);
        });
    }

    test('EVPN builds all five types, VXLAN VNIs, and mixed group results', async ({ page }) => {
        test.setTimeout(60000);
        await page.goto('/#/bgp/route-evpn');
        await expect(generateButton(page, 'evpn')).toBeEnabled();
        await expect(field(page, 'evpn', 'rd')).toHaveCount(0);
        await configureNlriNode(page, 'evpn', 'rd', '固定值', { value: '65000:100' });
        await selectEvpnRoot(page);
        await field(page, 'evpn', 'count').fill('2');
        await selectOption(page, 'bgp-evpn-route-encapsulationType-select', 'VXLAN');
        await configureNlriNode(page, 'evpn', 'vni', '固定值', { value: '10000' });
        for (let type = 1; type <= 5; type++) {
            await selectEvpnType(page, type);
            if (type === 2) await field(page, 'evpn', 'ipAddress').fill('');
            if (type === 5) {
                await field(page, 'evpn', 'prefix').fill('2001:db8:200::');
                await field(page, 'evpn', 'mask').fill('64');
                await field(page, 'evpn', 'gatewayIp').fill('::');
            }
            await expect(field(page, 'evpn', 'label')).toHaveCount(0);
            await expect(field(page, 'evpn', 'vni')).toHaveCount(0);
            await configureNlriNode(page, 'evpn', 'rd', '固定值', {
                value: type === 4 ? '192.0.2.1:100' : '65000:100'
            });
            if (type !== 4) await configureNlriNode(page, 'evpn', 'vni', '固定值', { value: '10000' });
            await generate(page, 'evpn');
            await expect.poll(() => payloads.length).toBe(type);
            expect(payloads[type - 1]).toMatchObject({
                addressFamily: 3,
                routeType: type,
                encapsulationType: 'vxlan'
            });
            expect(payloads[type - 1].nlriRules.find(rule => rule.type === 'rd').value).toBe(
                type === 4 ? '192.0.2.1:100' : '65000:100'
            );
            expectOnlyEvpnRules(payloads[type - 1], type === 4 ? [] : ['vni']);
            const rows = harness.controller.state.bgp.routes.get(3);
            expect(rows.every(row => row.rd === (type === 4 ? '192.0.2.1:100' : '65000:100'))).toBe(true);
            if (type !== 4) expect(rows.every(row => row.vni === 10000)).toBe(true);
            if (type !== 5) expect(payloads[type - 1]).not.toHaveProperty('prefix');
        }
        await page.getByTestId('bgp-evpn-add-group-button').click();
        await field(page, 'evpn', 'count').fill('2');
        await generate(page, 'evpn');
        await expect.poll(() => payloads.length).toBe(6);
        await expect(page.getByTestId('bgp-evpn-route-table')).toContainText('2001:db8:200::/64');
        await expect(page.getByTestId('bgp-evpn-route-table')).toContainText('02:00:00:00:00:01');
        await page.reload();
        await expect(generateButton(page, 'evpn')).toBeEnabled();
        expect(harness.controller.state.bgp.configs.get('EvpnRouteConfig').routeWorkspace.groups).toHaveLength(2);
        await groupAction(page, 'evpn', 'withdraw');
        await expect.poll(() => harness.controller.state.bgp.routes.get(3).length).toBe(2);
        await expect(page.getByTestId('bgp-evpn-route-table')).toContainText('2001:db8:200::/64');
    });

    test('EVPN keeps RD mandatory and restores all four RD generation modes', async ({ page }) => {
        await page.goto('/#/bgp/route-evpn');
        await expect(generateButton(page, 'evpn')).toBeEnabled();
        await field(page, 'evpn', 'count').fill('3');
        await expectRequiredNlriNodes(page, 'evpn', ['rd', 'label']);
        const cases = [
            {
                name: '固定值',
                mode: 'fixed',
                values: { value: '65000:100' },
                rds: ['65000:100', '65000:100', '65000:100']
            },
            {
                name: '递增',
                mode: 'increment',
                values: { base: '192.0.2.1', start: '100', step: '5' },
                rds: ['192.0.2.1:100', '192.0.2.1:105', '192.0.2.1:110']
            },
            { name: '随机', mode: 'random', values: { base: '65000', min: '100', max: '102' } },
            {
                name: '值列表',
                mode: 'list',
                values: { values: '65000:200\n192.0.2.1:300' },
                rds: ['65000:200', '192.0.2.1:300', '65000:200']
            }
        ];
        for (const [index, setting] of cases.entries()) {
            await configureNlriNode(page, 'evpn', 'rd', setting.name, setting.values);
            await saveAndReloadEvpn(page);
            await expectNlriNodeValues(page, 'evpn', 'rd', setting.name, setting.values);
            await generate(page, 'evpn');
            await expect.poll(() => payloads.length).toBe(index + 1);
            expect(payloads[index].nlriRules.find(rule => rule.type === 'rd').mode).toBe(setting.mode);
            expectOnlyEvpnRules(payloads[index], ['label']);
            const rows = harness.controller.state.bgp.routes.get(3);
            expect(rows).toHaveLength(3);
            if (setting.rds) expect(rows.map(row => row.rd)).toEqual(setting.rds);
            else
                for (const row of rows) {
                    expect(row.rd.split(':')[0]).toBe('65000');
                    expect(Number(row.rd.split(':')[1])).toBeGreaterThanOrEqual(100);
                    expect(Number(row.rd.split(':')[1])).toBeLessThanOrEqual(102);
                }
        }
        await expectRequiredNlriNodes(page, 'evpn', ['rd', 'label']);
    });

    test('EVPN switches forwarding nodes between MPLS, VXLAN and SRv6 without carrying inactive values', async ({
        page
    }) => {
        test.setTimeout(60000);
        await page.goto('/#/bgp/route-evpn');
        await expect(generateButton(page, 'evpn')).toBeEnabled();
        await expectEvpnForwardingNodes(page, ['label']);
        await configureNlriNode(page, 'evpn', 'label', '固定值', { value: '100' });
        await addNlriNode(page, 'evpn', 'label2');
        await configureNlriNode(page, 'evpn', 'label2', '固定值', { value: '200' });
        await generate(page, 'evpn');
        expectOnlyEvpnRules(payloads.at(-1), ['label', 'label2']);
        expect(harness.controller.state.bgp.routes.get(3)[0]).toMatchObject({ label: 100, label2: 200 });
        await removeNlriNode(page, 'evpn', 'label2');
        await generate(page, 'evpn');
        expect(harness.controller.state.bgp.routes.get(3)[0]).not.toHaveProperty('label2');

        await selectEvpnEncapsulation(page, 'VXLAN');
        await expectEvpnForwardingNodes(page, ['vni']);
        await expectRequiredNlriNodes(page, 'evpn', ['rd', 'vni']);
        await configureNlriNode(page, 'evpn', 'vni', '固定值', { value: '10000' });
        await addNlriNode(page, 'evpn', 'vni2');
        await configureNlriNode(page, 'evpn', 'vni2', '固定值', { value: '20000' });
        await generate(page, 'evpn');
        expectOnlyEvpnRules(payloads.at(-1), ['vni', 'vni2']);
        expect(harness.controller.state.bgp.routes.get(3)[0]).toMatchObject({ vni: 10000, vni2: 20000 });
        expect(harness.controller.state.bgp.routes.get(3)[0]).not.toHaveProperty('label');
        await removeNlriNode(page, 'evpn', 'vni2');
        await generate(page, 'evpn');
        expect(harness.controller.state.bgp.routes.get(3)[0]).not.toHaveProperty('vni2');

        await selectEvpnEncapsulation(page, 'SRv6');
        await expectEvpnForwardingNodes(page, ['srv6L2']);
        await expectRequiredNlriNodes(page, 'evpn', ['rd', 'srv6L2']);
        await configureNlriNode(page, 'evpn', 'srv6L2', '固定值', { value: '2001:db8:10::100' });
        await addNlriNode(page, 'evpn', 'srv6L3');
        await configureNlriNode(page, 'evpn', 'srv6L3', '固定值', { value: '2001:db8:30::100' });
        await generate(page, 'evpn');
        expectOnlyEvpnRules(payloads.at(-1), ['srv6L2', 'srv6L3']);
        let route = harness.controller.state.bgp.routes.get(3)[0];
        expect(route).toMatchObject({
            label: 3,
            label2: 3,
            srv6Services: [
                expect.objectContaining({ serviceType: 'l2', sid: '2001:db8:10::100', endpointBehavior: 23 }),
                expect.objectContaining({ serviceType: 'l3', sid: '2001:db8:30::100', endpointBehavior: 20 })
            ]
        });
        expect(route).not.toHaveProperty('vni');
        await removeNlriNode(page, 'evpn', 'srv6L3');
        await generate(page, 'evpn');
        route = harness.controller.state.bgp.routes.get(3)[0];
        expect(route.srv6Services.map(service => service.serviceType)).toEqual(['l2']);
        expect(route).not.toHaveProperty('label2');
        await addNlriNode(page, 'evpn', 'srv6L3');
        await selectEvpnRoot(page);
        await field(page, 'evpn', 'ipAddress').fill('');
        await expectEvpnForwardingNodes(page, ['srv6L2']);
        await field(page, 'evpn', 'ipAddress').fill('192.0.2.1');
        await expectEvpnForwardingNodes(page, ['srv6L2']);
        await addNlriNode(page, 'evpn', 'srv6L3');
        await configureNlriNode(page, 'evpn', 'srv6L3', '固定值', { value: '2001:db8:30::100' });
        await saveAndReloadEvpn(page);
        await expectEvpnForwardingNodes(page, ['srv6L2', 'srv6L3']);
        await expectNlriNodeValues(page, 'evpn', 'srv6L2', '固定值', { value: '2001:db8:10::100' });
        await expectNlriNodeValues(page, 'evpn', 'srv6L3', '固定值', { value: '2001:db8:30::100' });
        await generate(page, 'evpn');
        expectOnlyEvpnRules(payloads.at(-1), ['srv6L2', 'srv6L3']);
        await expect(page.getByTestId('bgp-evpn-route-table')).toContainText('2001:db8:10::100');
        await expect(page.getByTestId('bgp-evpn-route-table')).toContainText('2001:db8:30::100');

        await selectEvpnEncapsulation(page, 'MPLS');
        await expectEvpnForwardingNodes(page, ['label']);
        await generate(page, 'evpn');
        expectOnlyEvpnRules(payloads.at(-1), ['label']);
        expect(harness.controller.state.bgp.routes.get(3)[0]).not.toHaveProperty('srv6Services');
        await saveAndReloadEvpn(page);
        await expectEvpnForwardingNodes(page, ['label']);
        const saved = harness.controller.state.bgp.configs.get('EvpnRouteConfig').routeWorkspace.groups[0].config;
        expect(saved.nlriRules.filter(rule => evpnForwardingNodes.includes(rule.type)).map(rule => rule.type)).toEqual([
            'label'
        ]);
    });

    test('EVPN restores fixed, increment and list modes for complete L2 and L3 Service SIDs', async ({ page }) => {
        test.setTimeout(60000);
        await page.goto('/#/bgp/route-evpn');
        await expect(generateButton(page, 'evpn')).toBeEnabled();
        await field(page, 'evpn', 'count').fill('3');
        await selectEvpnEncapsulation(page, 'SRv6');
        const modes = [
            {
                name: '固定值',
                mode: 'fixed',
                values: { value: '2001:db8:10::100' },
                sids: ['2001:db8:10::100', '2001:db8:10::100', '2001:db8:10::100']
            },
            {
                name: '递增',
                mode: 'increment',
                values: { start: '2001:db8:10::100', step: '2' },
                sids: ['2001:db8:10::100', '2001:db8:10::102', '2001:db8:10::104']
            },
            {
                name: '值列表',
                mode: 'list',
                values: { values: '2001:db8:10::200\n2001:db8:10::300' },
                sids: ['2001:db8:10::200', '2001:db8:10::300', '2001:db8:10::200']
            }
        ];
        for (const [type, node, serviceType, endpointBehavior] of [
            [2, 'srv6L2', 'l2', 23],
            [5, 'srv6L3', 'l3', 20]
        ]) {
            await selectEvpnType(page, type);
            await expectEvpnForwardingNodes(page, [node]);
            await expectRequiredNlriNodes(page, 'evpn', ['rd', node]);
            for (const setting of modes) {
                await configureNlriNode(page, 'evpn', node, setting.name, setting.values);
                await saveAndReloadEvpn(page);
                await expectNlriNodeValues(page, 'evpn', node, setting.name, setting.values);
                for (const key of ['argumentLength', 'transpositionLength', 'transpositionOffset'])
                    await expect(page.getByTestId(`bgp-evpn-attribute-${key}-input`)).toHaveValue('0');
                await generate(page, 'evpn');
                expectOnlyEvpnRules(payloads.at(-1), [node]);
                expect(payloads.at(-1).nlriRules.find(rule => rule.type === node).mode).toBe(setting.mode);
                const rows = harness.controller.state.bgp.routes.get(3);
                expect(rows).toHaveLength(3);
                expect(rows.map(row => row.srv6Services[0].sid)).toEqual(setting.sids);
                for (const row of rows) {
                    expect(row.label).toBe(3);
                    expect(row.srv6Services).toHaveLength(1);
                    expect(row.srv6Services[0]).toMatchObject({
                        serviceType,
                        endpointBehavior,
                        sidStructure: {
                            locatorBlockLength: 32,
                            locatorNodeLength: 32,
                            functionLength: 64,
                            argumentLength: 0,
                            transpositionLength: 0,
                            transpositionOffset: 0
                        }
                    });
                }
            }
        }
    });

    test('EVPN applies Type 3 DT2M, Type 4 RD-only forwarding, and Type 1 Local Bias SID restrictions', async ({
        page
    }) => {
        test.setTimeout(60000);
        await page.goto('/#/bgp/route-evpn');
        await expect(generateButton(page, 'evpn')).toBeEnabled();
        await selectEvpnEncapsulation(page, 'SRv6');
        await selectEvpnType(page, 3);
        await expectEvpnForwardingNodes(page, ['srv6L2']);
        await expectRequiredNlriNodes(page, 'evpn', ['rd', 'srv6L2']);
        await page.getByTestId('bgp-evpn-tree-attribute-srv6L2').click();
        await expect(page.getByTestId('bgp-evpn-attribute-endpointBehavior-select')).toContainText('End.DT2M');
        await generate(page, 'evpn');
        expect(harness.controller.state.bgp.routes.get(3)[0].srv6Services[0]).toMatchObject({
            serviceType: 'l2',
            endpointBehavior: 24
        });

        await selectEvpnType(page, 4);
        await expectEvpnForwardingNodes(page, []);
        await expectRequiredNlriNodes(page, 'evpn', ['rd']);
        await configureNlriNode(page, 'evpn', 'rd', '固定值', { value: '192.0.2.1:100' });
        await generate(page, 'evpn');
        expectOnlyEvpnRules(payloads.at(-1), []);
        expect(harness.controller.state.bgp.routes.get(3)[0]).not.toHaveProperty('srv6Services');
        await saveAndReloadEvpn(page);
        await expectEvpnForwardingNodes(page, []);

        await selectEvpnType(page, 1);
        await field(page, 'evpn', 'esi').fill('01:02:00:00:00:00:01:00:00:00');
        await field(page, 'evpn', 'ethernetTagId').fill('4294967295');
        await expectEvpnForwardingNodes(page, ['srv6L2']);
        await page.getByTestId('bgp-evpn-tree-attribute-srv6L2').click();
        await expect(page.getByTestId('bgp-evpn-attribute-value-input')).toHaveValue('::');
        await expect(page.getByTestId('bgp-evpn-attribute-endpointBehavior-select')).toContainText('End.DT2M');
        await expect(page.getByTestId('bgp-evpn-attribute-argumentLength-input')).toHaveValue('0');
        await generate(page, 'evpn');
        expectOnlyEvpnRules(payloads.at(-1), ['srv6L2']);
        expect(harness.controller.state.bgp.routes.get(3)[0]).toMatchObject({
            label: 0,
            srv6Services: [
                expect.objectContaining({
                    serviceType: 'l2',
                    sid: '::',
                    endpointBehavior: 24,
                    sidStructure: expect.objectContaining({
                        argumentLength: 0,
                        transpositionLength: 0,
                        transpositionOffset: 0
                    })
                })
            ]
        });
        const successfulCalls = payloads.length;
        const expectRejected = async message => {
            await dismissToasts(page);
            await generateButton(page, 'evpn').click();
            await expect(page.locator('.nn-form-item-explain-error').first()).toContainText(message);
            expect(payloads).toHaveLength(successfulCalls);
        };
        await page.getByTestId('bgp-evpn-attribute-value-input').fill('::1');
        await expectRejected('Local Bias');
        await page.getByTestId('bgp-evpn-attribute-value-input').fill('::');
        await page.getByTestId('bgp-evpn-attribute-functionLength-input').fill('56');
        await page.getByTestId('bgp-evpn-attribute-argumentLength-input').fill('8');
        await expectRejected('Argument Length');
        await page.getByTestId('bgp-evpn-attribute-argumentLength-input').fill('0');
        await page.getByTestId('bgp-evpn-attribute-transpositionLength-input').fill('1');
        await expectRejected('转置');
        await page.getByTestId('bgp-evpn-attribute-transpositionLength-input').fill('0');
        await page.getByTestId('bgp-evpn-attribute-transpositionOffset-input').fill('1');
        await expectRejected('转置');
        await page.getByTestId('bgp-evpn-attribute-transpositionOffset-input').fill('0');
        await page.getByTestId('bgp-evpn-attribute-functionLength-input').fill('64');
        await saveAndReloadEvpn(page);
        await expectNlriNodeValues(page, 'evpn', 'srv6L2', '固定值', { value: '::' });
        await generate(page, 'evpn');
        expect(harness.controller.state.bgp.routes.get(3)[0].srv6Services[0].sid).toBe('::');
    });

    for (const transport of ['ipv4', 'ipv6']) {
        test(`${transport} peer selects and persists VPNv4 VPNv6 EVPN capabilities`, async ({ page }) => {
            await page.goto('/#/bgp/bgp-config');
            for (const label of ['VPNv4', 'VPNv6', 'EVPN'])
                await selectFamily(page, 'bgp-address-family-select', label);
            await page.getByTestId('bgp-start-button').click();
            await expect
                .poll(() => harness.controller.state.bgp.configs.get('BgpConfig')?.addressFamily)
                .toEqual([1, 4, 5, 3]);
            await page.goto('/#/bgp/bgp-peer-config');
            await page.getByRole('tab', { name: transport === 'ipv4' ? 'IPv4邻居' : 'IPv6邻居', exact: true }).click();
            const testId = `bgp-${transport}-peer-address-family-select`;
            for (const label of ['VPNv4', 'VPNv6', 'EVPN']) await selectFamily(page, testId, label);
            await page.getByTestId(`bgp-config-${transport}-peer-button`).click();
            const name = transport === 'ipv4' ? 'Ipv4PeerConfig' : 'Ipv6PeerConfig';
            const key = transport === 'ipv4' ? 'addressFamily' : 'addressFamilyIpv6';
            await expect
                .poll(() => harness.controller.state.bgp.configs.get(name)?.[key])
                .toEqual([transport === 'ipv4' ? 1 : 2, 4, 5, 3]);
            await page.reload();
            await page.getByRole('tab', { name: transport === 'ipv4' ? 'IPv4邻居' : 'IPv6邻居', exact: true }).click();
            for (const label of ['VPNv4', 'VPNv6', 'EVPN'])
                await expect(
                    page.getByTestId(testId).getByRole('button', { name: `移除 ${label}`, exact: true })
                ).toBeVisible();
            await expect(page.locator('.nn-toast-error')).toHaveCount(0);
        });
    }
});
