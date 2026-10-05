const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e } = require('../../scripts/e2e-support');
const registry = require('../../shared/bgpAttributes.json');

const profiles = [
    { key: 'ipv6', family: 2, configKey: 'Ipv6UNCRouteConfig' },
    { key: 'ipv4-qp', family: 8, configKey: 'Ipv4QpRouteConfig' },
    { key: 'ipv6-qp', family: 9, configKey: 'Ipv6QpRouteConfig' },
    { key: 'mvpn', family: 6, configKey: 'Ipv4MvpnRouteConfig' }
];
const prefixFor = profile => `bgp-${profile.key}`;
const generateButtonId = profile =>
    profile.key === 'ipv4' ? 'bgp-generate-ipv4-routes-button' : `${prefixFor(profile)}-generate-routes-button`;
const basicFieldId = (profile, key) => `${prefixFor(profile)}-route-${key}-input`;
const bridge = `(() => {
    const patch = api => Object.assign(api || {}, {
        loadIpv4UNCRouteConfig: () => window.__featureE2eCall('bgp.loadIpv4UNCRouteConfig'),
        saveIpv4UNCRouteConfig: config => window.__featureE2eCall('bgp.saveIpv4UNCRouteConfig', config),
        generateIpv4Routes: config => window.__featureE2eCall('bgp.generateRoutes', config),
        getRouteGroupStates: () => window.__featureE2eCall('bgp.getRouteGroupStates'),
        withdrawRouteGroup: config => window.__featureE2eCall('bgp.withdrawRouteGroup', config),
        getRoutes: (...args) => window.__featureE2eCall('bgp.getRoutes', ...args)
    });
    let current = patch(window.bgpApi);
    Object.defineProperty(window, 'bgpApi', { configurable: true, get: () => current, set: api => { current = patch(api); } });
})();`;

async function openPage(page, profile) {
    await page.goto(`/#/bgp/route-${profile.key}`);
    await expect(page.getByTestId(generateButtonId(profile))).toBeEnabled();
}
async function groupId(page, profile) {
    return page.getByTestId(`${prefixFor(profile)}-route-workspace`).getAttribute('data-active-group-id');
}
async function selectRoot(page, profile) {
    await page.getByTestId(`${prefixFor(profile)}-tree-group-${await groupId(page, profile)}`).click();
}
async function selectOption(page, testId, label) {
    await page.getByTestId(testId).click();
    await page.getByRole('option', { name: label, exact: true }).click();
}
async function mode(page, profile, label) {
    await selectOption(page, `${prefixFor(profile)}-attribute-mode-select`, label);
}
async function addNode(page, profile, type) {
    const prefix = prefixFor(profile);
    const section = registry.attributes.find(item => item.type === type).section || 'attributes';
    await page.getByTestId(`${prefix}-tree-${section}-${await groupId(page, profile)}`).click({ button: 'right' });
    await expect(page.getByTestId(`${prefix}-${section === 'nlri' ? 'nlri' : 'attribute'}-context-menu`)).toBeVisible();
    await page.getByTestId(`${prefix}-add-attribute-button`).click();
    await page.getByTestId(`${prefix}-add-attribute-${type}`).click();
}
async function removeNode(page, profile, type) {
    const prefix = prefixFor(profile);
    await page.getByTestId(`${prefix}-tree-attribute-${type}`).first().click({ button: 'right' });
    await page.getByTestId(`${prefix}-remove-attribute-button`).click();
}
async function dismissToasts(page) {
    const buttons = page.locator('.nn-toast:not(.nn-toast-leaving) .nn-toast-close');
    while (await buttons.count()) await buttons.first().click();
    await expect(page.locator('.nn-toast')).toHaveCount(0);
}
async function generate(page, profile) {
    await dismissToasts(page);
    await page.getByTestId(generateButtonId(profile)).click();
}
async function groupMenu(page, profile) {
    const prefix = prefixFor(profile);
    await page.getByTestId(`${prefix}-tree-group-${await groupId(page, profile)}`).click({ button: 'right' });
    await expect(page.getByTestId(`${prefix}-group-context-menu`)).toBeVisible();
}
async function expectGeneratedCount(page, profile, count) {
    await expect(page.getByTestId(generateButtonId(profile))).toBeEnabled();
    await groupMenu(page, profile);
    await expect(
        page.getByTestId(`${prefixFor(profile)}-group-context-menu`).locator('.nn-context-menu-meta')
    ).toHaveText(`已生成 ${count} 条`);
    await page.keyboard.press('Escape');
}
async function groupAction(page, profile, action) {
    const prefix = prefixFor(profile);
    await groupMenu(page, profile);
    await page.getByTestId(`${prefix}-${action}-group-button`).click();
}

test.describe('BGP family tree workspaces', () => {
    let harness;
    let payloads;
    let generated;
    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
        payloads = [];
        generated = new Map();
        const controller = harness.controller;
        const originalCall = controller.call.bind(controller);
        controller.call = async (method, ...args) => {
            if (method === 'bgp.getRouteGroupStates')
                return { status: 'success', data: { groups: [...generated.values()] } };
            if (method === 'bgp.withdrawRouteGroup') {
                const state = generated.get(args[0].groupId);
                generated.delete(args[0].groupId);
                for (const [family, rows] of controller.state.bgp.routes)
                    controller.state.bgp.routes.set(
                        family,
                        rows.filter(row => row.groupId !== args[0].groupId)
                    );
                return { status: 'success', data: { deleted: state?.routeCount || 0 } };
            }
            if (method === 'bgp.generateRoutes') {
                const config = JSON.parse(JSON.stringify(args[0]));
                payloads.push(config);
                const paths = Number(config.nlriRules.find(rule => rule.type === 'addPath')?.count || 1);
                const routeCount = Number(config.count) * paths;
                generated.set(config.groupId, {
                    groupId: config.groupId,
                    groupName: config.groupName,
                    addressFamily: config.addressFamily,
                    routeCount,
                    generatedAt: Date.now()
                });
                const rows = (controller.state.bgp.routes.get(config.addressFamily) || []).filter(
                    row => row.groupId !== config.groupId
                );
                rows.push(
                    ...Array.from({ length: routeCount }, (_, index) => ({
                        ...config,
                        ip: config.prefix,
                        mask: Number(config.mask),
                        pathId: index % paths,
                        routeKey: `${config.groupId}:${index}`
                    }))
                );
                controller.state.bgp.routes.set(config.addressFamily, rows);
                return { status: 'success', msg: '路由生成成功' };
            }
            if (method === 'bgp.getRoutes') {
                const rows = (controller.state.bgp.routes.get(Number(args[0])) || []).filter(
                    row => !args[3]?.routeType || Number(row.routeType) === Number(args[3].routeType)
                );
                return { status: 'success', data: { list: rows, total: rows.length } };
            }
            return originalCall(method, ...args);
        };
        await page.addInitScript({ content: bridge });
    });
    test.afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    for (const definition of [
        {
            type: 'communities',
            label: 'Community',
            fixed: '65000:100\n65000:200',
            groups: ['65000:100 65000:200', '65000:300 65000:400'],
            incrementPrefix: '65000:'
        },
        {
            type: 'extendedCommunities',
            label: 'Extended Community',
            fixed: 'rt:65000:100\nsoo:65000:200\nhex:0002fde800000064',
            groups: ['rt:65000:100 soo:65000:200', 'hex:430a010203040506 soo:192.0.2.1:20'],
            incrementPrefix: 'soo:65000:'
        }
    ]) {
        test(`${definition.label} edits multiple values per route and preserves independent repeated nodes`, async ({
            page
        }) => {
            const profile = { key: 'ipv4', family: 1, configKey: 'Ipv4UNCRouteConfig' };
            const prefix = prefixFor(profile);
            await openPage(page, profile);
            await page.getByTestId(basicFieldId(profile, 'prefix')).fill('10.71.0.1');
            await page.getByTestId(basicFieldId(profile, 'mask')).fill('32');
            await page.getByTestId(basicFieldId(profile, 'count')).fill('3');
            await page.getByTestId(`${prefix}-tree-attribute-${definition.type}`).click();
            const valueInput = page.getByTestId(`${prefix}-attribute-value-input`);
            await expect(valueInput).toHaveJSProperty('tagName', 'TEXTAREA');
            await valueInput.fill(definition.fixed);
            const previews = page.getByTestId(`${prefix}-attribute-preview`).locator('code');
            await expect(previews).toHaveText(Array(3).fill(definition.fixed.replace(/\n/g, ' ')));
            await expect(page.getByTestId(`${prefix}-attribute-valueCount-input`)).toHaveCount(0);
            await generate(page, profile);
            await expect
                .poll(() => payloads.at(-1)?.attributeRules.find(rule => rule.type === definition.type)?.value)
                .toBe(definition.fixed);

            await mode(page, profile, '值列表');
            await page.getByTestId(`${prefix}-attribute-values-input`).fill(definition.groups.join('\n'));
            await expect(previews).toHaveText([definition.groups[0], definition.groups[1], definition.groups[0]]);
            await expect(page.getByTestId(`${prefix}-attribute-valueCount-input`)).toHaveCount(0);
            await generate(page, profile);
            expect(payloads.at(-1).attributeRules.find(rule => rule.type === definition.type).values).toEqual(
                definition.groups
            );

            await mode(page, profile, '递增');
            await expect(page.getByTestId(`${prefix}-attribute-valueCount-input`)).toHaveValue('1');
            await page.getByTestId(`${prefix}-attribute-valueCount-input`).fill('2');
            await page.getByTestId(`${prefix}-attribute-base-input`).fill('65000');
            await page.getByTestId(`${prefix}-attribute-start-input`).fill('100');
            await page.getByTestId(`${prefix}-attribute-step-input`).fill('10');
            if (definition.type === 'extendedCommunities')
                await selectOption(page, `${prefix}-attribute-subtype-select`, 'Site of Origin (SoO)');
            const incrementPreviews = ['100 110', '120 130', '140 150'].map(group =>
                group
                    .split(' ')
                    .map(value => `${definition.incrementPrefix}${value}`)
                    .join(' ')
            );
            await expect(previews).toHaveText(incrementPreviews);
            await addNode(page, profile, definition.type);
            await mode(page, profile, '随机');
            await expect(page.getByTestId(`${prefix}-attribute-valueCount-input`)).toHaveValue('1');
            await page.getByTestId(`${prefix}-attribute-valueCount-input`).fill('3');
            await page.getByTestId(`${prefix}-attribute-base-input`).fill('65000');
            await page.getByTestId(`${prefix}-attribute-min-input`).fill('400');
            await page.getByTestId(`${prefix}-attribute-max-input`).fill('402');
            const randomGroups = await previews.allTextContents();
            for (const group of randomGroups) {
                const values = group.trim().split(/\s+/);
                expect(values).toHaveLength(3);
                for (const value of values) {
                    const suffix = Number(value.split(':').at(-1));
                    expect(suffix).toBeGreaterThanOrEqual(400);
                    expect(suffix).toBeLessThanOrEqual(402);
                }
            }
            await page.getByTestId(`${prefix}-save-workspace-button`).click();
            await expect(page.locator('.workspace-save-state')).toContainText('已保存');
            const savedRules = harness.controller.state.bgp.configs
                .get(profile.configKey)
                .attributeRules.filter(rule => rule.type === definition.type);
            expect(savedRules.map(rule => [rule.mode, rule.valueCount])).toEqual([
                ['increment', '2'],
                ['random', '3']
            ]);
            await page.reload();
            await expect(page.getByTestId(generateButtonId(profile))).toBeEnabled();
            const nodes = page.getByTestId(`${prefix}-tree-attribute-${definition.type}`);
            await expect(nodes).toHaveCount(2);
            await nodes.first().click();
            await expect(page.getByTestId(`${prefix}-attribute-valueCount-input`)).toHaveValue('2');
            await expect(page.getByTestId(`${prefix}-attribute-start-input`)).toHaveValue('100');
            await expect(previews).toHaveText(incrementPreviews);
            await nodes.last().click();
            await expect(page.getByTestId(`${prefix}-attribute-valueCount-input`)).toHaveValue('3');
            await expect(page.getByTestId(`${prefix}-attribute-min-input`)).toHaveValue('400');
            await generate(page, profile);
            await expectGeneratedCount(page, profile, 3);
            expect(
                payloads
                    .at(-1)
                    .attributeRules.filter(rule => rule.type === definition.type)
                    .map(rule => [rule.mode, rule.valueCount])
            ).toEqual([
                ['increment', '2'],
                ['random', '3']
            ]);
        });
    }

    for (const profile of [
        {
            key: 'ipv4',
            label: 'IPv4 UNC',
            family: 1,
            configKey: 'Ipv4UNCRouteConfig',
            prefix: '10.20.0.1',
            mask: '24',
            first: '10.20.0.0/24',
            last: '10.20.4.0/24'
        },
        {
            key: 'ipv4-label',
            label: 'IPv4 Label',
            family: 12,
            configKey: 'Ipv4LabelRouteConfig',
            prefix: '198.51.100.1',
            mask: '24',
            first: '198.51.100.0/24',
            last: '198.51.104.0/24'
        },
        {
            ...profiles[0],
            label: 'IPv6 UNC',
            prefix: '2001:db8:600::1',
            mask: '64',
            first: '2001:db8:600::/64',
            last: '2001:db8:600:4::/64'
        }
    ]) {
        test(`${profile.label} previews subnet ipStep and restores Count times ADD-PATH generation`, async ({
            page
        }) => {
            const prefix = prefixFor(profile);
            await openPage(page, profile);
            await page.getByTestId(basicFieldId(profile, 'prefix')).fill(profile.prefix);
            await page.getByTestId(basicFieldId(profile, 'mask')).fill(profile.mask);
            await page.getByTestId(basicFieldId(profile, 'count')).fill('3');
            await expect(page.getByTestId(basicFieldId(profile, 'ipStep'))).toHaveValue('1');
            await page.getByTestId(basicFieldId(profile, 'ipStep')).fill('2');
            const preview = page.getByTestId(`${prefix}-route-range-preview`);
            await expect(preview).toContainText(profile.first);
            await expect(preview).toContainText(profile.last);
            await addNode(page, profile, 'addPath');
            await page.getByTestId(`${prefix}-attribute-count-input`).fill('2');
            await expect(preview).toContainText('3 个前缀 × 2 条路径 = 6 条路由');
            await page.getByTestId(`${prefix}-save-workspace-button`).click();
            await expect(page.locator('.workspace-save-state')).toContainText('已保存');
            const saved = harness.controller.state.bgp.configs.get(profile.configKey);
            expect(saved.ipStep).toBe('2');
            expect(saved.addressFamily).toBe(profile.family);
            await page.reload();
            await expect(page.getByTestId(generateButtonId(profile))).toBeEnabled();
            await expect(page.getByTestId(basicFieldId(profile, 'ipStep'))).toHaveValue('2');
            await expect(preview).toContainText(profile.first);
            await expect(preview).toContainText(profile.last);
            await expect(preview).toContainText('3 个前缀 × 2 条路径 = 6 条路由');
            await generate(page, profile);
            await expectGeneratedCount(page, profile, 6);
            expect(payloads.at(-1)).toMatchObject({ addressFamily: profile.family, ipStep: '2', count: '3' });
            expect(payloads.at(-1).nlriRules.find(rule => rule.type === 'addPath').count).toBe('2');

            if (profile.family === 1) {
                await groupAction(page, profile, 'copy');
                await selectRoot(page, profile);
                await page.getByTestId(basicFieldId(profile, 'prefix')).fill('10.20.1.0');
                await generate(page, profile);
                await expectGeneratedCount(page, profile, 6);
                expect(payloads).toHaveLength(2);
                expect(generated.size).toBe(2);
                await selectRoot(page, profile);
                await page.getByTestId(basicFieldId(profile, 'prefix')).fill('10.20.2.0');
                await generate(page, profile);
                await expect(page.locator('.nn-toast-error')).toContainText('重叠');
                expect(payloads).toHaveLength(2);
            }
        });
    }

    for (const profile of profiles) {
        test(`${profile.key} preserves independent repeated attributes and generated group ownership`, async ({
            page
        }) => {
            const prefix = prefixFor(profile);
            await openPage(page, profile);
            await expect(page.locator('.advanced-config-button')).toHaveCount(0);
            await page.getByTestId(`${prefix}-route-group-name`).fill(`Tree ${profile.key}`);
            await page.getByTestId(`${prefix}-route-count-input`).fill('2');
            await page.getByTestId(`${prefix}-tree-attribute-med`).click();
            await mode(page, profile, '递增');
            await page.getByTestId(`${prefix}-attribute-start-input`).fill('10');
            await page.getByTestId(`${prefix}-attribute-step-input`).fill('2');
            await addNode(page, profile, 'med');
            await mode(page, profile, '值列表');
            await page.getByTestId(`${prefix}-attribute-values-input`).fill('100\n200');
            await removeNode(page, profile, 'origin');
            await page.getByTestId(`${prefix}-save-workspace-button`).click();
            await expect(page.locator('.workspace-save-state')).toContainText('已保存');
            const saved = harness.controller.state.bgp.configs.get(profile.configKey);
            expect(saved.routeWorkspace.profile).toBe(profile.key);
            expect(saved.routeWorkspace.version).toBe(1);
            expect(saved.attributeRules.filter(rule => rule.type === 'med')).toHaveLength(2);
            await page.reload();
            await expect(page.getByTestId(`${prefix}-generate-routes-button`)).toBeEnabled();
            await expect(page.getByTestId(`${prefix}-tree-attribute-origin`)).toHaveCount(0);
            const medNodes = page.getByTestId(`${prefix}-tree-attribute-med`);
            await expect(medNodes).toHaveCount(2);
            await medNodes.first().click();
            await expect(page.getByTestId(`${prefix}-attribute-start-input`)).toHaveValue('10');
            await medNodes.last().click();
            await expect(page.getByTestId(`${prefix}-attribute-values-input`)).toHaveValue('100\n200');
            await expect(page.getByTestId(`${prefix}-attribute-enabled-switch`)).toHaveCount(0);
            await generate(page, profile);
            await expectGeneratedCount(page, profile, 2);
            expect(payloads.at(-1).groupName).toBe(`Tree ${profile.key}`);
            expect(
                payloads
                    .at(-1)
                    .attributeRules.filter(rule => rule.type === 'med')
                    .map(rule => rule.mode)
            ).toEqual(['increment', 'list']);
            expect(payloads.at(-1).attributeRules.some(rule => rule.type === 'origin')).toBe(false);
            expect(payloads.at(-1).attributeRules.some(rule => Object.hasOwn(rule, 'enabled'))).toBe(false);
            await groupAction(page, profile, 'withdraw');
            await expect(page.getByTestId(generateButtonId(profile))).toHaveText('生成本组路由');
            expect(generated.size).toBe(0);
            await groupMenu(page, profile);
            await expect(page.getByTestId(`${prefix}-withdraw-group-button`)).toHaveAttribute('aria-disabled', 'true');
            await page.keyboard.press('Escape');
            await expect(medNodes).toHaveCount(2);
        });
    }

    for (const profile of profiles.filter(item => item.key.includes('qp'))) {
        test(`${profile.key} edits IP and DQPN growth independently and keeps BSID inside MP NLRI`, async ({
            page
        }) => {
            const prefix = prefixFor(profile);
            await openPage(page, profile);
            await expect(page.getByTestId(`${prefix}-route-routeGrowthMode-select`)).toHaveCount(0);
            await page.getByTestId(`${prefix}-route-count-input`).fill('3');
            await page.getByTestId(`${prefix}-route-ipStep-input`).fill('2');
            await page.getByTestId(`${prefix}-tree-attribute-bsid`).click();
            await mode(page, profile, '递增');
            await page.getByTestId(`${prefix}-attribute-start-input`).fill('2001:db8::a');
            await page.getByTestId(`${prefix}-attribute-step-input`).fill('1');
            await expect(page.locator('.node-editor-breadcrumb')).toContainText('MP_REACH_NLRI');

            await page.getByTestId(`${prefix}-tree-attribute-dqpn`).click();
            await mode(page, profile, '固定值');
            await page.getByTestId(`${prefix}-attribute-value-input`).fill('42');
            await expect(page.getByTestId(`${prefix}-attribute-preview`).locator('code')).toHaveText([
                '42',
                '42',
                '42'
            ]);
            await generate(page, profile);
            await expect.poll(() => payloads.at(-1)?.nlriRules.find(rule => rule.type === 'dqpn')?.value).toBe('42');
            expect(payloads.at(-1).ipStep).toBe('2');
            expect(Object.hasOwn(payloads.at(-1), 'routeGrowthMode')).toBe(false);

            await selectRoot(page, profile);
            await page.getByTestId(`${prefix}-route-ipStep-input`).fill('0');
            await page.getByTestId(`${prefix}-tree-attribute-dqpn`).click();
            await mode(page, profile, '递增');
            await page.getByTestId(`${prefix}-attribute-start-input`).fill('100');
            await page.getByTestId(`${prefix}-attribute-step-input`).fill('3');
            await expect(page.getByTestId(`${prefix}-attribute-preview`).locator('code')).toHaveText([
                '100',
                '103',
                '106'
            ]);
            await page.getByTestId(`${prefix}-save-workspace-button`).click();
            await expect(page.locator('.workspace-save-state')).toContainText('已保存');
            const saved = harness.controller.state.bgp.configs.get(profile.configKey);
            expect(saved.ipStep).toBe('0');
            expect(Object.hasOwn(saved, 'routeGrowthMode')).toBe(false);
            await page.reload();
            await expect(page.getByTestId(`${prefix}-generate-routes-button`)).toBeEnabled();
            await expect(page.getByTestId(`${prefix}-route-ipStep-input`)).toHaveValue('0');
            await expect(page.getByTestId(`${prefix}-route-routeGrowthMode-select`)).toHaveCount(0);
            await page.getByTestId(`${prefix}-tree-attribute-dqpn`).click();
            await expect(page.getByTestId(`${prefix}-attribute-start-input`)).toHaveValue('100');
            await expect(page.getByTestId(`${prefix}-attribute-step-input`)).toHaveValue('3');
            await expect(page.getByTestId(`${prefix}-attribute-preview`).locator('code')).toHaveText([
                '100',
                '103',
                '106'
            ]);
            await generate(page, profile);
            await expect.poll(() => payloads.at(-1)?.ipStep).toBe('0');
            expect(Object.hasOwn(payloads.at(-1), 'routeGrowthMode')).toBe(false);
            expect(payloads.at(-1).nlriRules.find(rule => rule.type === 'dqpn')).toMatchObject({
                mode: 'increment',
                start: '100',
                step: '3'
            });

            await selectRoot(page, profile);
            await page.getByTestId(`${prefix}-route-ipStep-input`).fill('2');
            await generate(page, profile);
            await expect.poll(() => payloads.at(-1)?.ipStep).toBe('2');
            expect(payloads.at(-1).nlriRules.map(rule => rule.type)).toEqual(['dqpn', 'bsid']);
            expect(payloads.at(-1).attributeRules.some(rule => ['dqpn', 'bsid'].includes(rule.type))).toBe(false);
            expect(Object.hasOwn(payloads.at(-1), 'routeGrowthMode')).toBe(false);

            await removeNode(page, profile, 'dqpn');
            await generate(page, profile);
            await expect.poll(() => payloads.at(-1)?.nlriRules.some(rule => rule.type === 'dqpn')).toBe(false);
            expect(payloads.at(-1).ipStep).toBe('2');
            expect(Object.hasOwn(payloads.at(-1), 'routeGrowthMode')).toBe(false);
        });
    }

    test('IPv6 keeps ADD-PATH and SRv6 in their proper tree branches', async ({ page }) => {
        const profile = profiles[0];
        const prefix = prefixFor(profile);
        await openPage(page, profile);
        await page.getByTestId(`${prefix}-route-count-input`).fill('3');
        await addNode(page, profile, 'addPath');
        await page.getByTestId(`${prefix}-attribute-count-input`).fill('2');
        await expect(page.getByTestId(`${prefix}-tree-attribute-addPath`)).toHaveAttribute('data-rule-section', 'nlri');
        await addNode(page, profile, 'srv6');
        await expect(page.getByTestId(`${prefix}-tree-attribute-srv6`)).toHaveAttribute(
            'data-rule-section',
            'attributes'
        );
        await expect(page.getByTestId(`${prefix}-attribute-endpointBehavior-select`)).toContainText('End.DT6');
        await page.getByTestId(`${prefix}-attribute-value-input`).fill('2001:db8:880::1');
        await expect(page.getByTestId(`${prefix}-route-range-preview`)).toContainText('3 个前缀 × 2 条路径 = 6 条路由');
        await generate(page, profile);
        await expectGeneratedCount(page, profile, 6);
        expect(payloads.at(-1).attributeRules.find(rule => rule.type === 'srv6').endpointBehavior).toBe(18);
    });

    test('MVPN exposes every type-specific NLRI and keeps Leaf identity separate from RD', async ({ page }) => {
        const profile = profiles.at(-1);
        const prefix = prefixFor(profile);
        await openPage(page, profile);
        const expectedFields = {
            1: ['rd', 'originatingRouterIp'],
            2: ['rd', 'sourceAs'],
            3: ['rd', 'sourceIp', 'groupIp', 'originatingRouterIp'],
            4: ['leafRouteKey', 'originatingRouterIp'],
            5: ['rd', 'sourceIp', 'groupIp'],
            6: ['rd', 'sourceAs', 'sourceIp', 'groupIp'],
            7: ['rd', 'sourceAs', 'sourceIp', 'groupIp']
        };
        for (let type = 1; type <= 7; type++) {
            await selectRoot(page, profile);
            await page.getByTestId(`${prefix}-route-routeType-select`).click();
            await page.getByRole('option', { name: new RegExp(`^Type ${type} ·`) }).click();
            await page.getByTestId(`${prefix}-route-count-input`).fill('2');
            for (const field of ['rd', 'sourceAs', 'sourceIp', 'groupIp', 'originatingRouterIp', 'leafRouteKey'])
                await expect(page.getByTestId(`${prefix}-route-${field}-input`)).toHaveCount(
                    expectedFields[type].includes(field) ? 1 : 0
                );
            await generate(page, profile);
            await expect.poll(() => payloads.at(-1)?.routeType).toBe(type);
            for (const field of ['rd', 'sourceAs', 'sourceIp', 'groupIp', 'originatingRouterIp', 'leafRouteKey'])
                expect(Object.hasOwn(payloads.at(-1), field)).toBe(expectedFields[type].includes(field));
            await expect(page.getByTestId(`${prefix}-route-table-${type}`)).toBeVisible();
        }
    });

    test('QP groups with distinct DQPN coexist while identical NLRI keys block generation', async ({ page }) => {
        const profile = profiles[1];
        const prefix = prefixFor(profile);
        await openPage(page, profile);
        await page.getByTestId(`${prefix}-route-count-input`).fill('1');
        await generate(page, profile);
        await groupAction(page, profile, 'copy');
        await generate(page, profile);
        await expect(page.locator('.nn-toast-error')).toContainText('NLRI 路由键重叠');
        expect(payloads).toHaveLength(1);
        await page.getByTestId(`${prefix}-tree-attribute-dqpn`).last().click();
        await page.getByTestId(`${prefix}-attribute-start-input`).fill('2');
        await generate(page, profile);
        await expectGeneratedCount(page, profile, 1);
        expect(generated.size).toBe(2);
        await groupAction(page, profile, 'remove');
        await expect(page.locator('.route-group-item')).toHaveCount(1);
        expect(generated.size).toBe(1);
    });
});
