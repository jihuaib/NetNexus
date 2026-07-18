const { expect, test } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');
const { getReleaseManifest } = require('../../scripts/libyang-runtime-config');

const bundledLibyangVersion = getReleaseManifest().libyangVersion;

const pageCases = [
    { route: '/#/yang/yang-connection', title: '连接设置', expectText: 'NETCONF' },
    { route: '/#/yang/yang-modules', title: 'YANG 模型库', expectText: 'ietf-interfaces' },
    { route: '/#/yang/yang-workspace', title: 'Schema 与设备操作', expectText: 'interfaces' }
];

async function openRuntimeSettings(page) {
    await page.getByRole('button', { name: '更多选项' }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    const settingsDialog = page.getByRole('dialog', { name: '设置' });
    await expect(settingsDialog).toBeVisible();
    await settingsDialog.getByRole('menuitem', { name: '运行时诊断', exact: true }).click();
    return settingsDialog;
}

const schemaTreeItems = page => page.locator('.schema-panel').getByRole('treeitem');
const parameterContextMenu = page => page.locator('.operation-parameter-context-menu');
const parameterNode = (parameterPanel, path) => parameterPanel.locator(`[data-parameter-path="${path}"]`);

async function openParameterContextMenu(page, parameterPanel, path) {
    const node = parameterNode(parameterPanel, path);
    await expect(node).toBeVisible();
    await node.click({ button: 'right' });
    const menu = parameterContextMenu(page);
    await expect(menu).toBeVisible();
    return { menu, node };
}

async function openSchemaSubmenu(contextMenu, labels) {
    let menu = contextMenu.locator('.schema-context-menu-list');
    for (const label of labels) {
        const submenuTitle = menu.getByRole('menuitem', { name: label, exact: true });
        await expect(submenuTitle).toBeVisible();
        await submenuTitle.click();
        await expect(submenuTitle).toHaveAttribute('aria-expanded', 'true');
        menu = submenuTitle.locator('xpath=following-sibling::ul[@role="menu"]');
        await expect(menu).toBeVisible();
    }
    return menu;
}

async function selectSchemaMenuPath(contextMenu, submenuLabels, itemLabel) {
    const menu = await openSchemaSubmenu(contextMenu, submenuLabels);
    const item = menu.getByRole('menuitem', { name: itemLabel, exact: true });
    await expect(item).toBeVisible();
    await item.click();
}

async function expandSchemaModule(page, moduleName) {
    const moduleNode = schemaTreeItems(page)
        .filter({ has: page.getByText(moduleName, { exact: true }) })
        .first();
    await expect(moduleNode).toBeVisible();
    await moduleNode.getByRole('button', { name: '展开节点' }).click();
    await expect(moduleNode).toHaveAttribute('aria-expanded', 'true');
    await expect(moduleNode.locator('[data-node-icon="module"]')).toBeVisible();
    return moduleNode;
}

async function dragSeparator(page, separator, deltaX, deltaY) {
    const box = await separator.boundingBox();
    expect(box).not.toBeNull();

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 10 });
    await page.mouse.up();
}

async function workspaceGeometry(page) {
    return page.locator('.yang-workspace-page:visible').evaluate(root => {
        const rect = selector => {
            const bounds = root.querySelector(selector).getBoundingClientRect();
            return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        };
        return {
            layout: rect('.workspace-layout'),
            schema: rect('.schema-panel'),
            operation: rect('.workspace-operation-panel'),
            request: rect('.operation-form-card'),
            response: rect('.operation-result-card'),
            parameters: rect('.operation-parameters-panel')
        };
    });
}

function expectSameGeometry(before, after) {
    Object.entries(before).forEach(([section, beforeBounds]) => {
        Object.entries(beforeBounds).forEach(([property, value]) => {
            expect(Math.abs(after[section][property] - value), `${section}.${property}`).toBeLessThanOrEqual(1);
        });
    });
}

test.describe('NETCONF/YANG workbench', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('renders all workbench pages with device and schema data', async ({ page }) => {
        for (const pageCase of pageCases) await verifyPage(test, page, pageCase);
        await expect(page.locator('.compiler-runtime-bar')).toHaveCount(0);

        const settingsDialog = await openRuntimeSettings(page);
        await expect(settingsDialog.getByText(`libyang ${bundledLibyangVersion}`, { exact: false })).toBeVisible();
    });

    test('restores persisted Schema roots when the successful workspace omits its inline tree', async ({ page }) => {
        let rootReads = 0;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            const response = await originalControllerCall(method, ...args);
            if (method === 'yang.registry.getSchemaRoots') rootReads += 1;
            if (method !== 'yang.registry.getWorkspace' || response.status !== 'success') return response;
            return {
                ...response,
                data: {
                    ...response.data,
                    success: true,
                    schemaTree: null
                }
            };
        };

        await page.goto('/#/yang/yang-workspace');
        await expect(page.getByText('Schema 已就绪', { exact: true })).toBeVisible();
        await expect(page.getByText('Schema 生成失败', { exact: true })).toHaveCount(0);
        await expect.poll(() => rootReads).toBeGreaterThan(0);
        await expect(schemaTreeItems(page).filter({ hasText: 'ietf-interfaces' }).first()).toBeVisible();
    });

    test('keeps lazily loaded Schema branches expanded when returning to the workspace', async ({ page }) => {
        let workspaceReads = 0;
        let childReads = 0;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            const response = await originalControllerCall(method, ...args);
            if (method === 'yang.registry.getWorkspace') workspaceReads += 1;
            if (method === 'yang.registry.getSchemaChildren') childReads += 1;
            return response;
        };

        await page.goto('/#/yang/yang-workspace');
        const moduleNode = await expandSchemaModule(page, 'ietf-interfaces');
        await expect(moduleNode).toHaveAttribute('aria-expanded', 'true');

        const interfacesNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interfaces', { exact: true }) })
            .first();
        await expect(interfacesNode).toBeVisible();
        await interfacesNode.getByRole('button', { name: '展开节点' }).click();
        await expect(interfacesNode).toHaveAttribute('aria-expanded', 'true');
        await expect(
            schemaTreeItems(page)
                .filter({ has: page.getByText('interface', { exact: true }) })
                .first()
        ).toBeVisible();

        const workspaceReadsBeforeReturn = workspaceReads;
        const childReadsBeforeReturn = childReads;
        await page.goto('/#/yang/yang-modules');
        await expect(page.getByText('YANG 模型库', { exact: true })).toBeVisible();
        await page.goto('/#/yang/yang-workspace');
        await expect.poll(() => workspaceReads).toBeGreaterThan(workspaceReadsBeforeReturn);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

        const returnedModuleNode = schemaTreeItems(page)
            .filter({ has: page.getByText('ietf-interfaces', { exact: true }) })
            .first();
        const returnedInterfacesNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interfaces', { exact: true }) })
            .first();
        await expect(returnedModuleNode).toHaveAttribute('aria-expanded', 'true');
        await expect(returnedInterfacesNode).toHaveAttribute('aria-expanded', 'true');
        await expect(
            schemaTreeItems(page)
                .filter({ has: page.getByText('interface', { exact: true }) })
                .first()
        ).toBeVisible();
        expect(childReads).toBe(childReadsBeforeReturn);
    });

    test('keeps compilation in the model list when the bundled libyang runtime is unavailable', async ({ page }) => {
        harness.controller.state.yang.compiler = {
            available: false,
            required: true,
            status: 'unavailable',
            engine: 'libyang',
            executable: 'yanglint',
            bundled: true,
            message: '内置 yanglint 文件缺失',
            installHint: '请修复或重新安装 NetNexus。'
        };
        harness.controller.state.yang.workspace = null;

        await page.goto('/#/yang/yang-workspace');

        await expect(page.locator('.compiler-runtime-bar')).toHaveCount(0);
        await expect(page.getByText('内置 YANG 编译器不可用')).toHaveCount(0);
        await expect(page.getByRole('button', { name: '编译工作区' })).toHaveCount(0);
        await expect(page.getByRole('tab', { name: 'YANG 源码', exact: true })).toHaveCount(0);
        await expect(page.getByRole('tab', { name: /诊断/u })).toHaveCount(0);

        const settingsDialog = await openRuntimeSettings(page);
        const compilerAlert = settingsDialog.getByRole('alert');
        await expect(compilerAlert.getByText('内置 YANG 编译器不可用')).toBeVisible();
        await expect(compilerAlert).toContainText('请修复或重新安装 NetNexus');
        await settingsDialog.getByRole('button', { name: '关闭' }).click();

        await page.goto('/#/yang/yang-modules');
        const localModuleRow = page.getByRole('row').filter({ hasText: 'ietf-interfaces' });
        await localModuleRow.getByRole('checkbox').evaluate(element => element.click());
        await expect(localModuleRow.getByRole('checkbox')).toBeChecked();
        await expect(page.getByRole('button', { name: '编译所选' })).toBeDisabled();
        await expect(localModuleRow.getByRole('button', { name: '源码', exact: true })).toBeVisible();
    });

    test('keeps the device Capability entry in connection settings only', async ({ page }) => {
        await page.goto('/#/yang/yang-connection');
        const capabilityButton = page.getByRole('button', { name: /设备 Capability \d+/u });
        await expect(capabilityButton).toBeVisible();
        await capabilityButton.click();

        const capabilityDialog = page.getByRole('dialog', { name: '设备 Capability' });
        await expect(capabilityDialog).toBeVisible();
        await expect(capabilityDialog).toContainText('urn:ietf:params:netconf:capability:candidate:1.0');
        await capabilityDialog.getByRole('button', { name: '关闭' }).click();

        await page.goto('/#/yang/yang-workspace');
        const workspacePage = page.locator('.yang-workspace-page:visible');
        await expect(workspacePage.getByRole('button', { name: /Capability/u })).toHaveCount(0);
        await expect(workspacePage.getByText('设备 Capability', { exact: true })).toHaveCount(0);
        await expect(workspacePage.locator('.operation-context-bar')).toHaveCount(0);
    });

    test('resizes the Schema, RPC messages, and full-height parameter tree without resizing containers', async ({
        page
    }) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto('/#/yang/yang-workspace');

        const workspacePage = page.locator('.yang-workspace-page:visible');
        const workspaceLayout = workspacePage.locator('.workspace-layout');
        const schemaPanel = workspaceLayout.locator('.schema-panel');
        const operationPanel = workspaceLayout.locator('.workspace-operation-panel');
        const requestCard = operationPanel.locator('.operation-form-card');
        const responseCard = operationPanel.locator('.operation-result-card');
        const parameterPanel = operationPanel.getByRole('complementary', { name: '操作参数' });
        const treeSeparator = workspacePage.getByRole('separator', { name: '调整 Schema 树宽度' });
        const operationSeparator = operationPanel.getByRole('separator', {
            name: '调整 RPC 请求和响应高度'
        });
        const parameterSeparator = operationPanel.getByRole('separator', { name: '调整操作参数宽度' });

        await expect(treeSeparator).toBeVisible();
        await expect(treeSeparator).toHaveAttribute('aria-orientation', 'vertical');
        await expect(operationSeparator).toBeVisible();
        await expect(operationSeparator).toHaveAttribute('aria-orientation', 'horizontal');
        await expect(parameterSeparator).toBeVisible();
        await expect(parameterSeparator).toHaveAttribute('aria-orientation', 'vertical');

        const workspaceBefore = await workspaceLayout.boundingBox();
        const treeBefore = await schemaPanel.boundingBox();
        const operationBefore = await operationPanel.boundingBox();
        expect(workspaceBefore).not.toBeNull();
        expect(treeBefore).not.toBeNull();
        expect(operationBefore).not.toBeNull();
        expect(Math.abs(treeBefore.width - 320)).toBeLessThanOrEqual(1);
        const parameterInitial = await parameterPanel.boundingBox();
        expect(parameterInitial).not.toBeNull();
        expect(Math.abs(parameterInitial.y - operationBefore.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(parameterInitial.height - operationBefore.height)).toBeLessThanOrEqual(1);

        await dragSeparator(page, treeSeparator, 120, 0);
        await expect
            .poll(async () => (await schemaPanel.boundingBox())?.width || 0)
            .toBeGreaterThan(treeBefore.width + 90);

        const workspaceAfterTreeDrag = await workspaceLayout.boundingBox();
        const treeAfter = await schemaPanel.boundingBox();
        const operationAfterTreeDrag = await operationPanel.boundingBox();
        expect(workspaceAfterTreeDrag).not.toBeNull();
        expect(treeAfter).not.toBeNull();
        expect(operationAfterTreeDrag).not.toBeNull();

        const treeWidthIncrease = treeAfter.width - treeBefore.width;
        const operationWidthDecrease = operationBefore.width - operationAfterTreeDrag.width;
        expect(operationWidthDecrease).toBeGreaterThan(90);
        expect(Math.abs(treeWidthIncrease - operationWidthDecrease)).toBeLessThanOrEqual(2);
        expect(Math.abs(workspaceAfterTreeDrag.width - workspaceBefore.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(workspaceAfterTreeDrag.height - workspaceBefore.height)).toBeLessThanOrEqual(1);

        const requestBefore = await requestCard.boundingBox();
        const responseBefore = await responseCard.boundingBox();
        const parameterBefore = await parameterPanel.boundingBox();
        const operationBeforeRowDrag = await operationPanel.boundingBox();
        expect(requestBefore).not.toBeNull();
        expect(responseBefore).not.toBeNull();
        expect(parameterBefore).not.toBeNull();
        expect(operationBeforeRowDrag).not.toBeNull();

        await dragSeparator(page, parameterSeparator, -90, 0);
        await expect
            .poll(async () => (await parameterPanel.boundingBox())?.width || 0)
            .toBeGreaterThan(parameterBefore.width + 70);
        const requestAfterParameterDrag = await requestCard.boundingBox();
        const responseAfterParameterDrag = await responseCard.boundingBox();
        const parameterAfterDrag = await parameterPanel.boundingBox();
        expect(requestAfterParameterDrag).not.toBeNull();
        expect(responseAfterParameterDrag).not.toBeNull();
        expect(parameterAfterDrag).not.toBeNull();
        expect(requestBefore.width - requestAfterParameterDrag.width).toBeGreaterThan(70);
        expect(Math.abs(requestAfterParameterDrag.width - responseAfterParameterDrag.width)).toBeLessThanOrEqual(1);

        await dragSeparator(page, operationSeparator, 0, 100);
        await expect
            .poll(async () => (await requestCard.boundingBox())?.height || 0)
            .toBeGreaterThan(requestBefore.height + 70);

        const requestAfter = await requestCard.boundingBox();
        const responseAfter = await responseCard.boundingBox();
        const operationAfterRowDrag = await operationPanel.boundingBox();
        expect(requestAfter).not.toBeNull();
        expect(responseAfter).not.toBeNull();
        expect(operationAfterRowDrag).not.toBeNull();

        const requestHeightIncrease = requestAfter.height - requestBefore.height;
        const responseHeightDecrease = responseBefore.height - responseAfter.height;
        expect(responseHeightDecrease).toBeGreaterThan(70);
        expect(Math.abs(requestHeightIncrease - responseHeightDecrease)).toBeLessThanOrEqual(2);
        expect(Math.abs(operationAfterRowDrag.width - operationBeforeRowDrag.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(operationAfterRowDrag.height - operationBeforeRowDrag.height)).toBeLessThanOrEqual(1);
        const parameterAfterRowDrag = await parameterPanel.boundingBox();
        expect(Math.abs(parameterAfterRowDrag.width - parameterAfterDrag.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(parameterAfterRowDrag.height - operationAfterRowDrag.height)).toBeLessThanOrEqual(1);

        await parameterPanel.getByRole('button', { name: '隐藏', exact: true }).click();
        await expect(parameterSeparator).toBeHidden();
        await expect.poll(async () => (await parameterPanel.boundingBox())?.width || 0).toBeLessThanOrEqual(40);
        const requestWhileParametersHidden = await requestCard.boundingBox();
        expect(requestWhileParametersHidden.width).toBeGreaterThan(requestAfterParameterDrag.width + 300);
        await parameterPanel.getByRole('button', { name: '展开操作参数', exact: true }).click();
        await expect(parameterSeparator).toBeVisible();
        await expect
            .poll(async () => (await parameterPanel.boundingBox())?.width || 0)
            .toBeGreaterThan(parameterBefore.width + 70);

        await treeSeparator.press('End');
        await expect.poll(async () => (await operationPanel.boundingBox())?.width || 0).toBeLessThanOrEqual(422);
        await expect.poll(async () => (await parameterPanel.boundingBox())?.width || 0).toBeLessThanOrEqual(100);
        const narrowParameterBox = await parameterPanel.boundingBox();
        const narrowResetBox = await parameterPanel.getByRole('button', { name: '重置', exact: true }).boundingBox();
        const narrowHideBox = await parameterPanel.getByRole('button', { name: '隐藏', exact: true }).boundingBox();
        expect(narrowParameterBox).not.toBeNull();
        expect(narrowResetBox).not.toBeNull();
        expect(narrowHideBox).not.toBeNull();
        expect(narrowResetBox.x).toBeGreaterThanOrEqual(narrowParameterBox.x);
        expect(narrowHideBox.x + narrowHideBox.width).toBeLessThanOrEqual(
            narrowParameterBox.x + narrowParameterBox.width + 1
        );
    });

    test('shows the current compilation diagnostics in the model list', async ({ page }) => {
        harness.controller.state.yang.diagnostics = [
            {
                severity: 'error',
                module: 'ietf-interfaces',
                file: '/tmp/netnexus/compile/ietf-interfaces@2018-02-20.yang',
                line: 12,
                column: 7,
                message: 'missing import ietf-ip'
            },
            {
                severity: 'warning',
                module: 'ietf-interfaces',
                file: 'ietf-interfaces.yang',
                line: 20,
                message: 'unused typedef demo-type'
            },
            { severity: 'info', module: 'ietf-interfaces', message: 'libyang validation started' }
        ];
        harness.controller.state.yang.workspace = null;
        let requestedCompileId = '';
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.registry.getDiagnostics') requestedCompileId = args[0]?.compileId || '';
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-modules');
        await page.getByRole('button', { name: /编译诊断/u }).click();

        const diagnosticDialog = page.getByRole('dialog', { name: '编译诊断' });
        await expect(diagnosticDialog).toBeVisible();
        await expect(diagnosticDialog.getByText('missing import ietf-ip', { exact: true })).toBeVisible();
        await expect(diagnosticDialog.getByText('ietf-interfaces@2018-02-20.yang:12:7', { exact: true })).toBeVisible();
        expect(requestedCompileId).toBe(harness.controller.state.yang.workspace.compileId);

        const errorRow = diagnosticDialog.locator('.diagnostic-row').filter({ hasText: 'missing import ietf-ip' });
        await errorRow.getByRole('button', { name: '查看源码', exact: true }).click();
        const sourceDrawer = page.getByRole('dialog', { name: 'ietf-interfaces@2018-02-20' });
        await expect(sourceDrawer).toBeVisible();
        await expect(sourceDrawer).toContainText('module ietf-interfaces');
        await expect(diagnosticDialog).toBeVisible();
        await sourceDrawer.getByRole('button', { name: '关闭' }).click();
        await expect(diagnosticDialog).toBeVisible();

        await diagnosticDialog.getByRole('tab', { name: '错误', exact: true }).click();
        await expect(diagnosticDialog.getByText('unused typedef demo-type', { exact: true })).toHaveCount(0);
        await expect(diagnosticDialog.getByText('libyang validation started', { exact: true })).toHaveCount(0);
    });

    test('compiles only the models selected in the model list', async ({ page }) => {
        let compileRequest = null;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.registry.compile') compileRequest = args[0];
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-modules');
        const localModuleRow = page.getByRole('row').filter({ hasText: 'ietf-interfaces' });
        await localModuleRow.getByRole('checkbox').evaluate(element => element.click());
        await expect(localModuleRow.getByRole('checkbox')).toBeChecked();
        await page.getByRole('button', { name: '编译所选' }).click();

        expect(compileRequest).toBeTruthy();
        expect(compileRequest.moduleIds).toHaveLength(1);
        expect(compileRequest.moduleIds[0].name).toBe('ietf-interfaces');
        await expect(localModuleRow.getByRole('button', { name: '源码', exact: true })).toBeVisible();
    });

    test('shows and compiles every filtered model without pagination', async ({ page }) => {
        const additionalModules = Array.from({ length: 24 }, (_value, index) => {
            const suffix = String(index + 1).padStart(2, '0');
            const name = `bulk-local-${suffix}`;
            return {
                id: `${name}@2026-07-19`,
                moduleId: `${name}@2026-07-19`,
                name,
                revision: '2026-07-19',
                namespace: `urn:netnexus:e2e:${name}`,
                isLocal: true,
                source: 'import',
                filePath: `/tmp/netnexus-e2e/yang/${name}@2026-07-19.yang`,
                status: 'downloaded',
                compileStatus: 'pending'
            };
        });
        harness.controller.state.yang.modules.push(...additionalModules);

        let compileRequest = null;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.registry.compile') {
                compileRequest = JSON.parse(JSON.stringify(args[0]));
                return { status: 'success', msg: 'YANG 编译完成', data: { cacheHit: false } };
            }
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-modules');
        const moduleTable = page.locator('.module-table');
        await expect(moduleTable.getByRole('navigation', { name: '表格分页' })).toHaveCount(0);

        const lastAdditionalModule = page.getByText('bulk-local-24', { exact: true });
        await expect(lastAdditionalModule).toHaveCount(1);
        await lastAdditionalModule.scrollIntoViewIfNeeded();
        await expect(lastAdditionalModule).toBeVisible();

        const sourceSelect = page.locator('.module-filters').getByRole('combobox').first();
        await sourceSelect.click();
        await page.getByRole('option', { name: '本地仓库', exact: true }).click();

        const expectedLocalNames = harness.controller.state.yang.modules
            .filter(module => module.isLocal)
            .map(module => module.name)
            .sort();
        const selectionMeta = page.locator('.selection-meta');
        await expect(selectionMeta).toContainText(`显示 ${expectedLocalNames.length}，已选 0`);
        await expect(moduleTable.locator('tbody .nn-table-row')).toHaveCount(expectedLocalNames.length);

        const selectFiltered = page.getByRole('checkbox', { name: '选择当前筛选结果' });
        await selectFiltered.evaluate(element => element.click());
        await expect(selectFiltered).toBeChecked();
        await expect(selectionMeta).toContainText(
            `显示 ${expectedLocalNames.length}，已选 ${expectedLocalNames.length}`
        );
        await expect(
            moduleTable.getByRole('row').filter({ hasText: 'bulk-local-24' }).getByRole('checkbox')
        ).toBeChecked();

        await page.getByRole('button', { name: '编译所选', exact: true }).click();
        await expect.poll(() => compileRequest?.moduleIds?.length || 0).toBe(expectedLocalNames.length);
        expect(compileRequest.moduleIds.map(module => module.name).sort()).toEqual(expectedLocalNames);
    });

    test('imports a local model and reports task completion', async ({ page }) => {
        await page.goto('/#/yang/yang-modules');
        await page.getByRole('button', { name: '导入文件' }).click();
        await expect(page.getByText('netnexus-demo', { exact: true })).toBeVisible();

        const notification = page.locator('.yang-task-notification');
        await expect(notification).toBeVisible();
        await expect(notification.locator('.notification-title')).toContainText('模型导入完成');
    });

    test('shows save and validation feedback as floating alerts without resizing the page', async ({ page }) => {
        await page.goto('/#/yang/yang-connection');
        const editor = page.locator('.profile-editor-card');
        const editorBox = await editor.boundingBox();
        const statusBox = await page.locator('.connection-status-bar').boundingBox();
        expect(statusBox.y).toBeGreaterThan(editorBox.y + editorBox.height - 1);
        const initialHeight = editorBox.height;

        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.getByRole('status').filter({ hasText: '连接 Profile 已保存' })).toBeVisible();
        expect(Math.abs((await editor.boundingBox()).height - initialHeight)).toBeLessThanOrEqual(1);

        await page.getByRole('button', { name: '新建', exact: true }).click();
        const draftHeight = (await editor.boundingBox()).height;
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.getByRole('alert').filter({ hasText: '连接设置不完整' })).toBeVisible();
        await expect(editor.locator('.nn-alert')).toHaveCount(0);
        expect(Math.abs((await editor.boundingBox()).height - draftHeight)).toBeLessThanOrEqual(1);
    });

    test('highlights editable XML safely without replacing the native input', async ({ page }) => {
        await page.goto('/#/yang/yang-workspace');
        await expandSchemaModule(page, 'ietf-interfaces');
        const interfacesNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interfaces', { exact: true }) })
            .first();
        await expect(interfacesNode).toBeVisible();
        await expect(interfacesNode.locator('[data-node-icon="container"]')).toBeVisible();
        await interfacesNode.dispatchEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: 120,
            clientY: 120
        });
        const contextMenu = page.locator('.schema-context-menu');
        await expect(contextMenu).toBeVisible();
        await expect(contextMenu.locator('.schema-context-menu-title')).toContainText('interfaces');
        const getItem = contextMenu.getByRole('menuitem', { name: '读取当前节点（get）', exact: true });
        await expect(getItem).not.toHaveAttribute('aria-disabled', 'true');
        await getItem.click();

        const operationPanel = page.locator('.workspace-operation-panel');
        const operationParameters = operationPanel.getByRole('complementary', { name: '操作参数' });
        let parameterMenu = (await openParameterContextMenu(page, operationParameters, '/rpc/get/filter/interfaces[1]'))
            .menu;
        await parameterMenu.getByRole('menuitem', { name: '移除节点', exact: true }).click();

        parameterMenu = (await openParameterContextMenu(page, operationParameters, '/rpc/get/filter/xml-source')).menu;
        await parameterMenu.getByRole('menuitem', { name: '修改值', exact: true }).click();
        const editDialog = page.getByRole('dialog', { name: '修改值 · XML 片段' });
        const xmlEditor = editDialog.locator('[data-xml-editor]');
        const xmlTextarea = xmlEditor.locator('textarea[data-xml-input]');
        const xmlHighlightLayer = xmlEditor.locator('[data-xml-highlight-layer]');
        const draft =
            '<interfaces xmlns="urn:test"><script data-xml-xss="true">' +
            'window.__netNexusXmlXss = true</script><!-- unfinished';

        await expect(xmlEditor).toBeVisible();
        await expect(xmlTextarea).toBeVisible();
        await expect(xmlTextarea).toHaveValue('');
        await expect(xmlHighlightLayer).toHaveAttribute('aria-hidden', 'true');
        await xmlTextarea.fill(draft);
        await expect(xmlTextarea).toHaveValue(draft);
        await expect.poll(() => xmlHighlightLayer.textContent()).toBe(draft);

        const editorTokens = [
            xmlHighlightLayer.locator('[data-xml-token="tag"]').first(),
            xmlHighlightLayer.locator('[data-xml-token="attribute"]').first(),
            xmlHighlightLayer.locator('[data-xml-token="value"]').first(),
            xmlHighlightLayer.locator('[data-xml-token="comment"]').first()
        ];
        await Promise.all(editorTokens.map(token => expect(token).toBeVisible()));
        const editorSyntaxColors = await Promise.all(
            editorTokens.map(token => token.evaluate(element => getComputedStyle(element).color))
        );
        expect(new Set(editorSyntaxColors).size).toBe(4);
        await expect(operationPanel.locator('script[data-xml-xss="true"]')).toHaveCount(0);
        expect(await page.evaluate(() => window.__netNexusXmlXss)).toBeUndefined();
        await editDialog.getByRole('button', { name: '确认', exact: true }).click();
    });

    test('keeps NETCONF execution history in an overlay without resizing the workspace', async ({ page }) => {
        let executionCount = 0;
        const errorMessageId = 'history-error-102';
        const failedMessageId = 'history-failed-103';
        const failedRequestXml =
            '<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="history-failed-103"><get/></rpc>';
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method !== 'yang.netconf.executeOperation') return originalControllerCall(method, ...args);
            executionCount += 1;
            if (executionCount === 3) {
                return {
                    status: 'error',
                    msg: 'mock transport closed',
                    data: {
                        code: 'NETCONF_TRANSPORT_CLOSED',
                        details: { messageId: failedMessageId, requestXml: failedRequestXml }
                    }
                };
            }
            if (executionCount === 1) {
                const response = await originalControllerCall(method, ...args);
                const data = { ...response.data, rpc: '<get/>' };
                delete data.requestXml;
                return { ...response, data };
            }
            if (executionCount !== 2) return originalControllerCall(method, ...args);

            const rpc =
                '<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="history-error-102"><get/></rpc>';
            const reply =
                '<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="history-error-102">' +
                '<rpc-error><error-type>application</error-type><error-tag>operation-failed</error-tag>' +
                '<error-message>mock denied</error-message></rpc-error></rpc-reply>';
            return {
                status: 'success',
                data: {
                    operation: 'get',
                    messageId: errorMessageId,
                    rpc: '<get/>',
                    requestXml: rpc,
                    reply,
                    errors: [{ type: 'application', tag: 'operation-failed', message: 'mock denied' }]
                }
            };
        };

        await page.goto('/#/yang/yang-workspace');
        const operationPanel = page.locator('.workspace-operation-panel');
        const executeButton = operationPanel.getByRole('button', { name: '执行 get', exact: true });
        const historyButton = page.getByRole('button', { name: '执行记录', exact: true });
        const initialHistoryButtonWidth = (await historyButton.boundingBox()).width;

        await executeButton.click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('<data>');
        const requestViewer = operationPanel.locator('.rpc-request-preview');
        const legacyRequestXml = await requestViewer.textContent();
        expect(legacyRequestXml).toMatch(
            /^\s*<rpc\b[^>]*xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"[^>]*message-id="\d+"[^>]*>[\s\S]*<get\/>[\s\S]*<\/rpc>\s*$/u
        );
        await executeButton.click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('mock denied');
        const rpcErrorRequestXml = await requestViewer.textContent();
        expect(rpcErrorRequestXml).toMatch(
            /^\s*<rpc\b[^>]*xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"[^>]*message-id="history-error-102"[^>]*>[\s\S]*<get\/>[\s\S]*<\/rpc>\s*$/u
        );
        await executeButton.click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('mock transport closed');
        expect((await historyButton.boundingBox()).width).toBe(initialHistoryButtonWidth);

        const beforeDrawer = await workspaceGeometry(page);
        await historyButton.click();
        const drawer = page.getByRole('dialog', { name: 'NETCONF 执行记录' });
        await expect(drawer).toBeVisible();
        expectSameGeometry(beforeDrawer, await workspaceGeometry(page));

        const historyItems = drawer.getByTestId('netconf-history-item');
        await expect(historyItems).toHaveCount(3);
        await expect(historyItems.nth(0)).toContainText('执行失败');
        await expect(historyItems.nth(0)).toHaveAttribute('tabindex', '0');
        await expect(historyItems.nth(1)).toHaveAttribute('tabindex', '-1');
        await historyItems.nth(0).focus();
        await historyItems.nth(0).press('End');
        await expect(historyItems.nth(2)).toHaveAttribute('aria-selected', 'true');
        await expect(historyItems.nth(2)).toBeFocused();
        await historyItems.nth(2).press('Home');
        await expect(historyItems.nth(0)).toHaveAttribute('aria-selected', 'true');
        await expect(historyItems.nth(0)).toBeFocused();
        await expect(drawer.getByText(failedMessageId, { exact: true })).toBeVisible();
        await expect(drawer.getByTestId('netconf-history-request')).toContainText(failedMessageId);
        await expect(drawer.getByTestId('netconf-history-request')).toHaveAttribute('tabindex', '0');
        await expect(drawer.getByTestId('netconf-history-reply')).toHaveAttribute('tabindex', '0');
        await expect(drawer.getByTestId('netconf-history-reply')).toContainText('mock transport closed');

        await historyItems.nth(1).click();
        await expect(historyItems.nth(1)).toContainText('RPC 错误');
        await expect(drawer.getByText(errorMessageId, { exact: true })).toBeVisible();
        const rpcErrorHistoryRequest = drawer.getByTestId('netconf-history-request');
        await expect(rpcErrorHistoryRequest).toContainText(errorMessageId);
        expect(await rpcErrorHistoryRequest.textContent()).toMatch(
            /^\s*<rpc\b[^>]*message-id="history-error-102"[^>]*>[\s\S]*<get\/>[\s\S]*<\/rpc>\s*$/u
        );
        await expect(drawer.getByTestId('netconf-history-reply')).toContainText('<rpc-error>');
        await expect(drawer.getByTestId('netconf-history-reply')).toContainText('mock denied');

        await historyItems.nth(2).click();
        await expect(historyItems.nth(2)).toContainText('成功');
        await expect(drawer.getByTestId('netconf-history-request')).toContainText('<get/>');
        await expect(drawer.getByTestId('netconf-history-reply')).toContainText('<data>');
        await expect(drawer).toContainText('NETCONF E2E 设备 · 192.0.2.10:830');

        await drawer.getByTestId('netconf-history-clear').click();
        const clearConfirmation = page.getByRole('dialog', { name: '确定清空全部 NETCONF 执行记录？' });
        await expect(clearConfirmation).toBeVisible();
        await clearConfirmation.getByRole('button', { name: '清空', exact: true }).click();
        await expect(drawer.getByText('暂无执行记录', { exact: true })).toBeVisible();
        await expect(historyItems).toHaveCount(0);

        await drawer.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(drawer).toBeHidden();
        await expect(operationPanel.locator('.rpc-result')).toContainText('mock transport closed');
        expect((await historyButton.boundingBox()).width).toBe(initialHistoryButtonWidth);
    });

    test('executes node operations from the Schema tree context menu', async ({ page }) => {
        const capturedRequests = [];
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.netconf.executeOperation') {
                capturedRequests.push(JSON.parse(JSON.stringify(args[0])));
            }
            return originalControllerCall(method, ...args);
        };
        await page.goto('/#/yang/yang-workspace');
        const moduleNode = await expandSchemaModule(page, 'ietf-interfaces');
        await expect(moduleNode.locator('[data-node-icon="module"]')).toBeVisible();

        const interfacesNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interfaces', { exact: true }) })
            .first();
        const containerIcon = interfacesNode.locator('[data-node-icon="container"]');
        await expect(containerIcon).toBeVisible();
        await interfacesNode.click();
        const propertyDialog = page.getByRole('dialog', { name: '节点属性 · interfaces' });
        await expect(interfacesNode).toHaveAttribute('aria-selected', 'true');
        await expect(propertyDialog).toHaveCount(0);

        await interfacesNode.click({ button: 'right' });
        const contextMenu = page.locator('.schema-context-menu');
        await expect(contextMenu).toBeVisible();
        await contextMenu.getByRole('menuitem', { name: '查看节点属性', exact: true }).click();
        await expect(propertyDialog).toBeVisible();
        await expect(propertyDialog).toContainText('/ietf-interfaces:interfaces');
        await propertyDialog.getByRole('button', { name: '关闭' }).click();

        await interfacesNode.click({ button: 'right' });

        await expect(contextMenu).toBeVisible();
        await expect(contextMenu.getByRole('menuitem', { name: '查看所属 YANG 源码' })).toHaveCount(0);
        await expect(contextMenu.getByRole('menuitem', { name: '查看 Capability', exact: true })).toHaveCount(0);
        const datastoreMenu = await openSchemaSubmenu(contextMenu, ['配置存储']);
        await expect(
            datastoreMenu.getByRole('menuitem', { name: '复制配置存储（copy-config）…', exact: true })
        ).toBeVisible();
        const startupMenu = await openSchemaSubmenu(contextMenu, ['配置存储', 'Startup']);
        await expect(startupMenu.getByRole('menuitem', { name: '删除整个 Startup…', exact: true })).toBeVisible();
        await contextMenu.getByRole('menuitem', { name: '读取当前节点（get）', exact: true }).click();

        const operationPanel = page.locator('.workspace-operation-panel');
        await expect(operationPanel).toBeVisible();
        await expect(page.getByRole('dialog', { name: 'get · interfaces' })).toHaveCount(0);

        const requestCard = operationPanel.locator('.operation-form-card');
        const responseCard = operationPanel.locator('.operation-result-card');
        const operationParameters = operationPanel.getByRole('complementary', { name: '操作参数' });
        const operationBox = await operationPanel.boundingBox();
        const requestBox = await requestCard.boundingBox();
        const responseBox = await responseCard.boundingBox();
        const operationParametersBox = await operationParameters.boundingBox();
        expect(operationBox).toBeTruthy();
        expect(requestBox).toBeTruthy();
        expect(responseBox).toBeTruthy();
        expect(operationParametersBox).toBeTruthy();
        expect(Math.abs(requestBox.x - operationBox.x)).toBeLessThan(1);
        expect(Math.abs(requestBox.width - responseBox.width)).toBeLessThan(1);
        expect(responseBox.y).toBeGreaterThanOrEqual(requestBox.y + requestBox.height - 1);
        expect(operationParametersBox.x).toBeGreaterThanOrEqual(requestBox.x + requestBox.width + 7);
        expect(Math.abs(operationParametersBox.y - operationBox.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(operationParametersBox.height - operationBox.height)).toBeLessThanOrEqual(1);

        await expect(operationPanel.getByRole('tab', { name: 'RPC XML', exact: true })).toHaveCount(0);
        await expect(operationPanel.getByRole('tab', { name: '操作参数', exact: true })).toHaveCount(0);
        const requestPreview = requestCard.locator('.rpc-request-preview');
        await expect(requestPreview).toBeVisible();
        await expect(requestPreview).toHaveAttribute('data-xml-viewer', '');
        const requestTagToken = requestPreview.locator('[data-xml-token="tag"]').first();
        const requestAttributeToken = requestPreview.locator('[data-xml-token="attribute"]').first();
        const requestValueToken = requestPreview.locator('[data-xml-token="value"]').first();
        const requestPunctuationToken = requestPreview.locator('[data-xml-token="punctuation"]').first();
        await expect(requestTagToken).toHaveText('rpc');
        await expect(requestAttributeToken).toHaveText('xmlns');
        await expect(requestValueToken).toHaveText('"urn:ietf:params:xml:ns:netconf:base:1.0"');
        await expect(requestPunctuationToken).toHaveText('<');
        const requestSyntaxColors = await Promise.all(
            [requestTagToken, requestAttributeToken, requestValueToken, requestPunctuationToken].map(token =>
                token.evaluate(element => getComputedStyle(element).color)
            )
        );
        expect(new Set(requestSyntaxColors).size).toBe(4);
        await expect(operationParameters).toBeVisible();
        await expect(operationParameters.getByRole('tree', { name: '操作参数树' })).toBeVisible();
        await expect(operationParameters.locator('[data-parameter-path="/rpc/get"]')).toBeVisible();
        await expect(operationParameters.locator('[data-parameter-path="/rpc/get/filter"]')).toBeVisible();
        await expect(
            operationParameters.locator('[data-parameter-path="/rpc/get/filter/interfaces[1]"]')
        ).toBeVisible();
        await expect(
            parameterNode(operationParameters, '/rpc/get').locator('[data-node-icon="operation"]')
        ).toBeVisible();
        await expect(
            parameterNode(operationParameters, '/rpc/get/filter/interfaces[1]').locator('[data-node-icon="container"]')
        ).toBeVisible();
        await expect(operationParameters.getByRole('textbox')).toHaveCount(0);
        await expect(operationParameters.getByRole('combobox')).toHaveCount(0);

        const filterTreeItem = parameterNode(operationParameters, '/rpc/get/filter')
            .locator('xpath=ancestor::*[@role="treeitem"]')
            .first();
        await filterTreeItem.focus();
        await filterTreeItem.press('Shift+F10');
        await expect(parameterContextMenu(page)).toBeVisible();
        await expect(parameterContextMenu(page).locator('[role="menuitem"]:focus')).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(parameterContextMenu(page)).toBeHidden();
        await expect(filterTreeItem).toBeFocused();

        let parameterMenu = (await openParameterContextMenu(page, operationParameters, '/rpc/get/filter/interfaces[1]'))
            .menu;
        await page.locator('.schema-panel .panel-header').click();
        await expect(parameterMenu).toBeHidden();
        parameterMenu = (await openParameterContextMenu(page, operationParameters, '/rpc/get/filter/interfaces[1]'))
            .menu;
        await parameterMenu.getByRole('menuitem', { name: '添加子节点', exact: true }).click();
        const addInterfaceDialog = page.getByRole('dialog', { name: '添加子节点 · interfaces' });
        await expect(addInterfaceDialog.getByRole('combobox', { name: 'Schema 节点' })).toContainText('interface');
        await addInterfaceDialog.getByRole('button', { name: '确认', exact: true }).click();
        const addedInterface = parameterNode(operationParameters, '/rpc/get/filter/interfaces[1]/interface[1]');
        await expect(addedInterface).toBeVisible();
        await expect(addedInterface.locator('[data-node-icon="list"]')).toBeVisible();
        await expect(requestPreview).toContainText('<interface/>');

        parameterMenu = (
            await openParameterContextMenu(page, operationParameters, '/rpc/get/filter/interfaces[1]/interface[1]')
        ).menu;
        await parameterMenu.getByRole('menuitem', { name: '添加子节点', exact: true }).click();
        const addNameDialog = page.getByRole('dialog', { name: '添加子节点 · interface' });
        const childSchemaSelect = addNameDialog.getByRole('combobox', { name: 'Schema 节点' });
        await childSchemaSelect.click();
        await page.getByRole('option', { name: 'name (leaf)', exact: true }).click();
        await addNameDialog.getByRole('button', { name: '确认', exact: true }).click();
        const emptyName = parameterNode(operationParameters, '/rpc/get/filter/interfaces[1]/interface[1]/name[1]');
        await expect(emptyName).toBeVisible();
        await expect(requestPreview).toContainText('<name/>');
        parameterMenu = (
            await openParameterContextMenu(
                page,
                operationParameters,
                '/rpc/get/filter/interfaces[1]/interface[1]/name[1]'
            )
        ).menu;
        await expect(parameterMenu.getByRole('menuitem', { name: '修改值', exact: true })).not.toHaveAttribute(
            'aria-disabled',
            'true'
        );
        await parameterMenu.getByRole('menuitem', { name: '修改值', exact: true }).click();
        const editEmptyNameDialog = page.getByRole('dialog', { name: '修改值 · name' });
        await editEmptyNameDialog.getByRole('textbox', { name: '节点值' }).fill('eth0');
        await editEmptyNameDialog.getByRole('button', { name: '确认', exact: true }).click();
        await expect(requestPreview).toContainText('<name>eth0</name>');

        parameterMenu = (
            await openParameterContextMenu(page, operationParameters, '/rpc/get/filter/interfaces[1]/interface[1]')
        ).menu;
        await parameterMenu.getByRole('menuitem', { name: '添加属性', exact: true }).click();
        const addAttributeDialog = page.getByRole('dialog', { name: '添加属性 · interface' });
        await expect(addAttributeDialog.getByRole('textbox', { name: '节点命名空间' })).toHaveValue('');
        await addAttributeDialog.getByRole('textbox', { name: '节点名称' }).fill('nc:operation');
        await addAttributeDialog.getByRole('textbox', { name: '节点初始值' }).fill('merge');
        await addAttributeDialog.getByRole('button', { name: '确认', exact: true }).click();
        const operationAttribute = parameterNode(
            operationParameters,
            '/rpc/get/filter/interfaces[1]/interface[1]/@nc:operation'
        );
        await expect(operationAttribute.locator('[data-node-icon="attribute"]')).toBeVisible();
        await expect(requestPreview).toContainText('nc:operation="merge"');
        await expect(requestPreview).toContainText('xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0"');
        parameterMenu = (
            await openParameterContextMenu(
                page,
                operationParameters,
                '/rpc/get/filter/interfaces[1]/interface[1]/@nc:operation'
            )
        ).menu;
        await parameterMenu.getByRole('menuitem', { name: '移除节点', exact: true }).click();
        await expect(operationAttribute).toHaveCount(0);

        parameterMenu = (
            await openParameterContextMenu(page, operationParameters, '/rpc/get/filter/interfaces[1]/interface[1]')
        ).menu;
        await parameterMenu.getByRole('menuitem', { name: '移除节点', exact: true }).click();
        await expect(addedInterface).toHaveCount(0);
        await expect(requestPreview).toContainText('<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"/>');

        const initialRequestXml = await requestPreview.textContent();
        expect(initialRequestXml).toMatch(/<rpc[^>]*>\n\s{2}<get>\n\s{4}<filter type="subtree">/u);
        const requestDisplayToggle = requestCard.getByRole('button', { name: '查看原文', exact: true });
        const formattedRequestToggleWidth = (await requestDisplayToggle.boundingBox()).width;
        await requestDisplayToggle.click();
        const requestFormatToggle = requestCard.getByRole('button', { name: '格式化', exact: true });
        const rawRequestToggleWidth = (await requestFormatToggle.boundingBox()).width;
        expect(rawRequestToggleWidth).toBe(formattedRequestToggleWidth);
        await requestFormatToggle.click();

        parameterMenu = (await openParameterContextMenu(page, operationParameters, '/rpc/get/filter')).menu;
        await parameterMenu.getByRole('menuitem', { name: '修改值', exact: true }).click();
        let editValueDialog = page.getByRole('dialog', { name: '修改值 · filter' });
        const filterTypeEditor = editValueDialog.getByRole('combobox', { name: '节点值' });
        await expect(filterTypeEditor).toContainText('subtree');
        await filterTypeEditor.click();
        await page.getByRole('option', { name: 'xpath', exact: true }).click();
        await editValueDialog.getByRole('button', { name: '确认', exact: true }).click();
        parameterMenu = (await openParameterContextMenu(page, operationParameters, '/rpc/get/filter/@select')).menu;
        await parameterMenu.getByRole('menuitem', { name: '修改值', exact: true }).click();
        editValueDialog = page.getByRole('dialog', { name: '修改值 · @select' });
        const xpathEditor = editValueDialog.getByRole('textbox', { name: '节点值' });
        await xpathEditor.fill('/interfaces/interface[name="eth0"]');
        await editValueDialog.getByRole('button', { name: '确认', exact: true }).click();
        await expect(requestPreview).toContainText('type="xpath"');
        await expect(requestPreview).toContainText('select="/interfaces/interface[name=&quot;eth0&quot;]"');
        parameterMenu = (await openParameterContextMenu(page, operationParameters, '/rpc/get/filter')).menu;
        await parameterMenu.getByRole('menuitem', { name: '修改值', exact: true }).click();
        editValueDialog = page.getByRole('dialog', { name: '修改值 · filter' });
        const resetFilterType = editValueDialog.getByRole('combobox', { name: '节点值' });
        await resetFilterType.click();
        await page.getByRole('option', { name: 'subtree', exact: true }).click();
        await editValueDialog.getByRole('button', { name: '确认', exact: true }).click();
        await expect(requestPreview).toContainText('<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"/>');
        const formattedRequestXml = await requestPreview.textContent();
        expect(formattedRequestXml).toMatch(/<rpc[^>]*>\n\s{2}<get>\n\s{4}<filter type="subtree">/u);
        expect(formattedRequestXml).toMatch(
            /\n\s{6}<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"\/>\n\s{4}<\/filter>/u
        );

        const executeButton = operationPanel.getByRole('button', { name: '执行 get', exact: true });
        await expect(executeButton).toBeEnabled();
        await executeButton.click();

        const replyViewer = operationPanel.locator('.rpc-result');
        await expect(replyViewer).toContainText('<rpc-reply');
        await expect(replyViewer).toContainText('<interface>');
        await expect(replyViewer).toHaveAttribute('data-xml-viewer', '');
        const replyTagToken = replyViewer.locator('[data-xml-token="tag"]').first();
        const replyAttributeToken = replyViewer.locator('[data-xml-token="attribute"]').first();
        const replyValueToken = replyViewer.locator('[data-xml-token="value"]').first();
        const replyTextToken = replyViewer
            .locator('[data-xml-token="text"]')
            .filter({ hasText: /^eth0$/u })
            .first();
        await expect(replyTagToken).toHaveText('rpc-reply');
        await expect(replyAttributeToken).toHaveText('xmlns');
        await expect(replyValueToken).toHaveText('"urn:ietf:params:xml:ns:netconf:base:1.0"');
        await expect(replyTextToken).toHaveText('eth0');
        const replySyntaxColors = await Promise.all(
            [replyTagToken, replyAttributeToken, replyValueToken, replyTextToken].map(token =>
                token.evaluate(element => getComputedStyle(element).color)
            )
        );
        expect(new Set(replySyntaxColors).size).toBe(4);
        const formattedReplyXml = await replyViewer.textContent();
        expect(formattedReplyXml).toMatch(/<rpc-reply[^>]*>\n\s{2}<data>\n\s{4}<interfaces[^>]*>/u);
        expect(formattedReplyXml).toMatch(/\n\s{6}<interface>\n\s{8}<name>eth0<\/name>/u);
        const sentRequestXml = await requestPreview.textContent();
        expect(sentRequestXml).toMatch(/message-id="\d+"/u);
        expect(sentRequestXml).not.toContain('message-id="preview"');

        const responseDisplayToggle = responseCard.getByRole('button', { name: '查看原文', exact: true });
        const formattedResponseToggleWidth = (await responseDisplayToggle.boundingBox()).width;
        await responseDisplayToggle.click();
        const rawReplyXml = await operationPanel.locator('.rpc-result').textContent();
        expect(rawReplyXml).not.toContain('\n');
        const responseFormatToggle = responseCard.getByRole('button', { name: '格式化', exact: true });
        const rawResponseToggleWidth = (await responseFormatToggle.boundingBox()).width;
        expect(rawResponseToggleWidth).toBe(formattedResponseToggleWidth);
        await responseFormatToggle.click();
        await expect(operationPanel.getByText('成功', { exact: true })).toBeVisible();
        expect(capturedRequests.at(-1).filter).toEqual({
            type: 'subtree',
            content: '<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"/>'
        });

        await interfacesNode.getByRole('button', { name: '展开节点' }).click();
        const interfaceNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interface', { exact: true }) })
            .first();
        await expect(interfaceNode.locator('[data-node-icon="list"]')).toBeVisible();
        await interfaceNode.getByRole('button', { name: '展开节点' }).click();
        const keyNode = schemaTreeItems(page)
            .filter({ has: page.getByText('name', { exact: true }) })
            .first();
        const keyIcon = keyNode.locator('[data-node-icon="key"]');
        await expect(keyIcon).toBeVisible();
        const stateNode = schemaTreeItems(page)
            .filter({ has: page.getByText('in-octets', { exact: true }) })
            .first();
        await expect(stateNode.locator('[data-node-icon="state"]')).toBeVisible();
        await stateNode.click({ button: 'right' });
        await expect(
            contextMenu.getByRole('menuitem', { name: '读取当前节点（get）', exact: true })
        ).not.toHaveAttribute('aria-disabled', 'true');
        await expect(
            contextMenu.getByRole('menuitem', { name: '编辑当前节点（edit-config）', exact: true })
        ).toBeDisabled();
        await contextMenu.getByRole('menuitem', { name: '读取当前节点（get）', exact: true }).click();
        const stateParameter = parameterNode(
            operationParameters,
            '/rpc/get/filter/interfaces[1]/interface[1]/in-octets[1]'
        );
        await expect(stateParameter.locator('[data-node-icon="state"]')).toBeVisible();

        const enabledNode = schemaTreeItems(page)
            .filter({ has: page.getByText('enabled', { exact: true }) })
            .first();
        const leafIcon = enabledNode.locator('[data-node-icon="leaf"]');
        await expect(leafIcon).toBeVisible();
        const [containerColor, keyColor, leafColor] = await Promise.all(
            [containerIcon, keyIcon, leafIcon].map(icon => icon.evaluate(element => getComputedStyle(element).color))
        );
        expect(keyColor).not.toBe(leafColor);
        expect(containerColor).not.toBe(leafColor);
        await enabledNode.click({ button: 'right' });
        await selectSchemaMenuPath(contextMenu, ['编辑当前节点（edit-config）'], 'Candidate');
        await expect.poll(() => capturedRequests.filter(request => request.operation === 'get-config').length).toBe(1);
        const configReadRequest = capturedRequests.find(request => request.operation === 'get-config');
        expect(configReadRequest.source).toBe('candidate');
        expect(configReadRequest.filter).toEqual({
            type: 'subtree',
            content:
                '<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">\n' +
                '  <interface>\n' +
                '    <enabled/>\n' +
                '  </interface>\n' +
                '</interfaces>'
        });
        await expect(operationPanel.getByText('已载入', { exact: true })).toBeVisible();
        const editParameters = operationPanel.getByRole('complementary', { name: '操作参数' });
        const configTree = editParameters.locator('[data-parameter-path="/rpc/edit-config/config"]');
        const nameParameter = editParameters.locator(
            '[data-parameter-path="/rpc/edit-config/config/interfaces[1]/interface[1]/name[1]"]'
        );
        const enabledParameter = editParameters.locator(
            '[data-parameter-path="/rpc/edit-config/config/interfaces[1]/interface[1]/enabled[1]"]'
        );
        await expect(configTree).toBeVisible();
        await expect(nameParameter.locator('[data-node-icon="key"]')).toBeVisible();
        await expect(nameParameter).toContainText('key');
        await expect(nameParameter).toContainText('eth0');
        await expect(enabledParameter.locator('[data-node-icon="leaf"]')).toBeVisible();
        await expect(enabledParameter).toContainText('true');
        await expect(editParameters.getByRole('textbox')).toHaveCount(0);
        await expect(editParameters.getByRole('combobox')).toHaveCount(0);
        await expect(editParameters).not.toContainText('NETNEXUS_REQUIRED');

        const executeEditButton = operationPanel.getByRole('button', { name: '执行 edit-config', exact: true });
        await expect(executeEditButton).toBeEnabled();
        parameterMenu = (
            await openParameterContextMenu(
                page,
                editParameters,
                '/rpc/edit-config/config/interfaces[1]/interface[1]/enabled[1]'
            )
        ).menu;
        await parameterMenu.getByRole('menuitem', { name: '修改值', exact: true }).click();
        let enabledDialog = page.getByRole('dialog', { name: '修改值 · enabled' });
        let enabledEditor = enabledDialog.getByRole('combobox', { name: '节点值' });
        await enabledEditor.click();
        await page.getByRole('option', { name: 'false', exact: true }).click();
        await enabledDialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(requestPreview).toContainText('<enabled>true</enabled>');
        parameterMenu = (
            await openParameterContextMenu(
                page,
                editParameters,
                '/rpc/edit-config/config/interfaces[1]/interface[1]/enabled[1]'
            )
        ).menu;
        await parameterMenu.getByRole('menuitem', { name: '修改值', exact: true }).click();
        enabledDialog = page.getByRole('dialog', { name: '修改值 · enabled' });
        enabledEditor = enabledDialog.getByRole('combobox', { name: '节点值' });
        await enabledEditor.click();
        await page.getByRole('option', { name: 'false', exact: true }).click();
        await enabledDialog.getByRole('button', { name: '确认', exact: true }).click();
        await expect(requestPreview).toContainText('<enabled>false</enabled>');
        await executeEditButton.click();
        const editConfirmation = page.getByRole('dialog', { name: '确认执行 edit-config' });
        await expect(editConfirmation).toBeVisible();
        await editConfirmation.getByRole('button', { name: '确认执行', exact: true }).click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('<ok/>');
        expect(capturedRequests.slice(-2).map(request => request.operation)).toEqual(['get-config', 'edit-config']);
        expect(capturedRequests.at(-1).config).toContain('<enabled>false</enabled>');

        await page.getByRole('button', { name: '执行记录', exact: true }).click();
        const executionHistoryDrawer = page.getByRole('dialog', { name: 'NETCONF 执行记录' });
        const executionHistoryItems = executionHistoryDrawer.getByTestId('netconf-history-item');
        await expect(executionHistoryItems).toHaveCount(3);
        await expect(executionHistoryItems.nth(0)).toContainText('edit-config');
        await expect(executionHistoryItems.nth(1)).toContainText('edit-config 自动回读');
        await executionHistoryItems.nth(1).click();
        await expect(executionHistoryDrawer.getByTestId('netconf-history-request')).toContainText('<get-config>');
        await executionHistoryDrawer.getByRole('button', { name: '关闭', exact: true }).click();
    });

    test('routes datastore workflows through the cascading Schema context menu', async ({ page }) => {
        const capturedRequests = [];
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.netconf.executeOperation') {
                capturedRequests.push(JSON.parse(JSON.stringify(args[0])));
            }
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-workspace');
        await expandSchemaModule(page, 'ietf-interfaces');
        const interfacesNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interfaces', { exact: true }) })
            .first();
        const contextMenu = page.locator('.schema-context-menu');
        const operationPanel = page.locator('.workspace-operation-panel');
        const requestPreview = operationPanel.locator('.rpc-request-preview');
        const openInterfacesContextMenu = async () => {
            await interfacesNode.dispatchEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                button: 2,
                clientX: 120,
                clientY: 120
            });
            await expect(contextMenu).toBeVisible();
        };
        const requestXml = async () => requestPreview.textContent();

        await openInterfacesContextMenu();
        const getConfigMenu = await openSchemaSubmenu(contextMenu, ['读取节点配置（get-config）']);
        await expect(getConfigMenu.getByRole('menuitem', { name: 'Running', exact: true })).toBeVisible();
        await expect(getConfigMenu.getByRole('menuitem', { name: 'Candidate', exact: true })).toBeVisible();
        await expect(getConfigMenu.getByRole('menuitem', { name: 'Startup', exact: true })).toBeVisible();
        await getConfigMenu.getByRole('menuitem', { name: 'Startup', exact: true }).click();
        await expect(operationPanel.getByRole('button', { name: '执行 get-config', exact: true })).toBeVisible();
        expect(await requestXml()).toMatch(/<source>\s*<startup\/>\s*<\/source>/u);

        await openInterfacesContextMenu();
        const editConfigMenu = await openSchemaSubmenu(contextMenu, ['编辑当前节点（edit-config）']);
        await expect(editConfigMenu.getByRole('menuitem', { name: 'Candidate', exact: true })).toBeVisible();
        await expect(editConfigMenu.getByRole('menuitem', { name: 'Running', exact: true })).toBeVisible();
        await editConfigMenu.getByRole('menuitem', { name: 'Candidate', exact: true }).click();
        await expect.poll(() => capturedRequests.filter(request => request.operation === 'get-config').length).toBe(1);
        await expect(operationPanel.getByText('已载入', { exact: true })).toBeVisible();
        expect(
            capturedRequests.filter(request => request.operation === 'get-config').map(request => request.source)
        ).toEqual(['candidate']);
        expect(await requestXml()).toMatch(/<target>\s*<candidate\/>\s*<\/target>/u);

        await openInterfacesContextMenu();
        await selectSchemaMenuPath(contextMenu, ['编辑当前节点（edit-config）'], 'Running');
        await expect.poll(() => capturedRequests.filter(request => request.operation === 'get-config').length).toBe(2);
        await expect(operationPanel.getByText('已载入', { exact: true })).toBeVisible();
        const editReadbacks = capturedRequests.filter(request => request.operation === 'get-config');
        expect(editReadbacks.map(request => request.source)).toEqual(['candidate', 'running']);
        expect(editReadbacks.filter(request => request.source === 'candidate')).toHaveLength(1);
        expect(editReadbacks.filter(request => request.source === 'running')).toHaveLength(1);
        expect(await requestXml()).toMatch(/<target>\s*<running\/>\s*<\/target>/u);

        await openInterfacesContextMenu();
        const candidateMenu = await openSchemaSubmenu(contextMenu, ['Candidate 工作区']);
        await expect(
            candidateMenu.getByRole('menuitem', { name: '提交整个 Candidate → Running', exact: true })
        ).toBeVisible();
        await expect(
            candidateMenu.getByRole('menuitem', { name: 'Confirmed Commit → Running…', exact: true })
        ).toBeVisible();
        await expect(candidateMenu.getByRole('menuitem', { name: '取消 Confirmed Commit', exact: true })).toBeVisible();
        await expect(candidateMenu.getByRole('menuitem', { name: '放弃全部未提交修改', exact: true })).toBeVisible();
        await candidateMenu.getByRole('menuitem', { name: '提交整个 Candidate → Running', exact: true }).click();
        await expect(operationPanel.getByRole('button', { name: '执行 commit', exact: true })).toBeVisible();
        await expect(requestPreview).toContainText('<commit/>');

        await openInterfacesContextMenu();
        await selectSchemaMenuPath(contextMenu, ['Candidate 工作区'], 'Confirmed Commit → Running…');
        expect(await requestXml()).toMatch(
            /<commit>\s*<confirmed\/>\s*<confirm-timeout>600<\/confirm-timeout>\s*<\/commit>/u
        );

        await openInterfacesContextMenu();
        await selectSchemaMenuPath(contextMenu, ['Candidate 工作区'], '取消 Confirmed Commit');
        await expect(operationPanel.getByRole('button', { name: '执行 cancel-commit', exact: true })).toBeVisible();
        await expect(requestPreview).toContainText('<cancel-commit/>');

        await openInterfacesContextMenu();
        await selectSchemaMenuPath(contextMenu, ['Candidate 工作区'], '放弃全部未提交修改');
        await expect(operationPanel.getByRole('button', { name: '执行 discard-changes', exact: true })).toBeVisible();
        await expect(requestPreview).toContainText('<discard-changes/>');

        await openInterfacesContextMenu();
        const startupMenu = await openSchemaSubmenu(contextMenu, ['配置存储', 'Startup']);
        await expect(startupMenu.getByRole('menuitem', { name: '保存 Running → Startup', exact: true })).toBeVisible();
        await expect(startupMenu.getByRole('menuitem', { name: '删除整个 Startup…', exact: true })).toBeVisible();
        await startupMenu.getByRole('menuitem', { name: '保存 Running → Startup', exact: true }).click();
        await expect(operationPanel.getByRole('button', { name: '执行 copy-config', exact: true })).toBeVisible();
        expect(await requestXml()).toMatch(/<target>\s*<startup\/>\s*<\/target>/u);
        expect(await requestXml()).toMatch(/<source>\s*<running\/>\s*<\/source>/u);

        await openInterfacesContextMenu();
        await selectSchemaMenuPath(contextMenu, ['配置存储', 'Startup'], '删除整个 Startup…');
        await expect(operationPanel.getByRole('button', { name: '执行 delete-config', exact: true })).toBeVisible();
        expect(await requestXml()).toMatch(/<target>\s*<startup\/>\s*<\/target>/u);
    });

    test('keeps the Schema edit draft when reading current device config fails', async ({ page }) => {
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.netconf.executeOperation' && args[0]?.operation === 'get-config') {
                return { status: 'error', msg: 'mock get-config failed' };
            }
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-workspace');
        await expandSchemaModule(page, 'ietf-interfaces');
        const interfacesNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interfaces', { exact: true }) })
            .first();
        await interfacesNode.getByRole('button', { name: '展开节点' }).click();
        const interfaceNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interface', { exact: true }) })
            .first();
        await interfaceNode.getByRole('button', { name: '展开节点' }).click();
        await expect(interfaceNode.locator('[data-node-icon="list"]')).toBeVisible();
        const enabledNode = schemaTreeItems(page)
            .filter({ has: page.getByText('enabled', { exact: true }) })
            .first();
        await enabledNode.dispatchEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: 120,
            clientY: 120
        });
        const contextMenu = page.locator('.schema-context-menu');
        await expect(contextMenu).toBeVisible();
        await selectSchemaMenuPath(contextMenu, ['编辑当前节点（edit-config）'], 'Candidate');

        const operationPanel = page.locator('.workspace-operation-panel');
        await expect(operationPanel.getByText('读取失败', { exact: true })).toBeVisible();
        const editParameters = operationPanel.getByRole('complementary', { name: '操作参数' });
        const nameParameter = editParameters.locator(
            '[data-parameter-path="/rpc/edit-config/config/interfaces[1]/interface[1]/name[1]"]'
        );
        const enabledParameter = editParameters.locator(
            '[data-parameter-path="/rpc/edit-config/config/interfaces[1]/interface[1]/enabled[1]"]'
        );
        await expect(nameParameter).toHaveAttribute('data-parameter-invalid', 'true');
        await expect(enabledParameter).toHaveAttribute('data-parameter-invalid', 'true');
        let parameterMenu = (
            await openParameterContextMenu(
                page,
                editParameters,
                '/rpc/edit-config/config/interfaces[1]/interface[1]/name[1]'
            )
        ).menu;
        await parameterMenu.getByRole('menuitem', { name: '修改值', exact: true }).click();
        const nameDialog = page.getByRole('dialog', { name: '修改值 · name' });
        const nameEditor = nameDialog.getByRole('textbox', { name: '节点值' });
        await expect(nameEditor).toHaveAttribute('aria-invalid', 'true');
        await expect(nameEditor).toHaveAttribute('placeholder', /NETNEXUS_REQUIRED: 输入 list key 值/u);
        await nameDialog.getByRole('button', { name: '取消', exact: true }).click();
        parameterMenu = (
            await openParameterContextMenu(
                page,
                editParameters,
                '/rpc/edit-config/config/interfaces[1]/interface[1]/enabled[1]'
            )
        ).menu;
        await parameterMenu.getByRole('menuitem', { name: '修改值', exact: true }).click();
        const enabledDialog = page.getByRole('dialog', { name: '修改值 · enabled' });
        await expect(enabledDialog.getByRole('combobox', { name: '节点值' })).toHaveAttribute('aria-invalid', 'true');
        await enabledDialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(operationPanel.getByRole('button', { name: '执行 edit-config', exact: true })).toBeDisabled();
    });

    test('keeps an in-flight RPC attached and blocks operation context switching', async ({ page }) => {
        let releaseRpc = null;
        let executeCount = 0;
        let sessionReadCount = 0;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.netconf.getSessionState') sessionReadCount += 1;
            if (method !== 'yang.netconf.executeOperation') return originalControllerCall(method, ...args);
            executeCount += 1;
            const response = await originalControllerCall(method, ...args);
            return new Promise(resolve => {
                releaseRpc = () => resolve(response);
            });
        };

        await page.goto('/#/yang/yang-workspace');
        await expandSchemaModule(page, 'ietf-interfaces');
        const operationPanel = page.locator('.workspace-operation-panel');
        const interfacesNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interfaces', { exact: true }) })
            .first();
        const contextMenu = page.locator('.schema-context-menu');
        const openInterfacesContextMenu = async () => {
            await interfacesNode.dispatchEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                button: 2,
                clientX: 120,
                clientY: 120
            });
            await expect(contextMenu).toBeVisible();
        };
        await expect(operationPanel.locator('.operation-context-bar')).toHaveCount(0);
        await expect(operationPanel.getByText('NETCONF 已连接', { exact: true })).toHaveCount(0);
        const sessionReadsAfterMount = sessionReadCount;

        await openInterfacesContextMenu();
        await contextMenu.getByRole('menuitem', { name: '读取当前节点（get）', exact: true }).click();
        await operationPanel.getByRole('button', { name: '执行 get', exact: true }).click();
        await expect.poll(() => Boolean(releaseRpc)).toBe(true);

        await openInterfacesContextMenu();
        const nextOperationItem = contextMenu.getByRole('menuitem', {
            name: '读取节点配置（get-config）',
            exact: true
        });
        await expect(nextOperationItem).toBeDisabled();
        const currentExecuteButton = operationPanel.getByRole('button', { name: '执行 get', exact: true });
        await expect(currentExecuteButton).toBeDisabled();
        expect(executeCount).toBe(1);
        expect(sessionReadCount).toBe(sessionReadsAfterMount);

        await page.keyboard.press('Escape');
        releaseRpc();
        await expect(operationPanel.locator('.rpc-result')).toContainText('<rpc-reply');
        await expect(operationPanel.locator('.result-summary span').first()).toHaveText('get');
        await expect(currentExecuteButton).toBeEnabled();
        expect(executeCount).toBe(1);

        await openInterfacesContextMenu();
        await selectSchemaMenuPath(contextMenu, ['读取节点配置（get-config）'], 'Running');
        await expect(operationPanel.getByRole('button', { name: '执行 get-config', exact: true })).toBeEnabled();
        expect(sessionReadCount).toBe(sessionReadsAfterMount);
    });

    test('keeps global device operations in the tree when no Schema nodes are available', async ({ page }) => {
        harness.controller.state.yang.schemaTree = null;
        harness.controller.state.yang.compiledModuleIds = [];
        harness.controller.state.yang.workspace = null;
        await page.setViewportSize({ width: 1000, height: 420 });

        await page.goto('/#/yang/yang-workspace');
        const deviceNode = schemaTreeItems(page).filter({
            has: page.getByText('当前设备：NETCONF E2E 设备', { exact: true })
        });
        await expect(deviceNode).toBeVisible();
        await deviceNode.click({ button: 'right' });

        const contextMenu = page.locator('.schema-context-menu');
        const menuMetrics = await contextMenu.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return { top: bounds.top, bottom: bounds.bottom, viewportHeight: window.innerHeight };
        });
        expect(menuMetrics.top).toBeGreaterThanOrEqual(0);
        expect(menuMetrics.bottom).toBeLessThanOrEqual(menuMetrics.viewportHeight);
        await expect(contextMenu).toBeVisible();

        await page.setViewportSize({ width: 1280, height: 900 });
        await deviceNode.click({ button: 'right' });
        await expect(contextMenu.getByRole('menuitem', { name: '读取全部数据（get）', exact: true })).toBeVisible();
        await expect(contextMenu.getByRole('menuitem', { name: '原始 RPC', exact: true })).toBeVisible();

        await selectSchemaMenuPath(contextMenu, ['配置存储', 'Startup'], '删除整个 Startup…');
        const operationPanel = page.locator('.workspace-operation-panel');
        const operationParameters = operationPanel.getByRole('complementary', { name: '操作参数' });
        const targetPath = '/rpc/delete-config/target';
        const deleteTargetNode = parameterNode(operationParameters, targetPath);
        await expect(deleteTargetNode).toContainText('startup');
        const parameterMenu = (await openParameterContextMenu(page, operationParameters, targetPath)).menu;
        await parameterMenu.getByRole('menuitem', { name: '修改值', exact: true }).click();
        const targetDialog = page.getByRole('dialog', { name: '修改值 · target' });
        const deleteTarget = targetDialog.getByRole('combobox', { name: '节点值' });
        await expect(deleteTarget).toContainText('startup');
        await deleteTarget.click();
        await expect(page.getByRole('option', { name: 'startup', exact: true })).toBeVisible();
        await expect(page.getByRole('option', { name: 'candidate', exact: true })).toHaveCount(0);
        await page.getByRole('option', { name: 'startup', exact: true }).click();
        await targetDialog.getByRole('button', { name: '确认', exact: true }).click();

        await deviceNode.click({ button: 'right' });
        await selectSchemaMenuPath(contextMenu, ['配置存储'], '复制配置存储（copy-config）…');
        await operationPanel.getByRole('button', { name: '执行 copy-config', exact: true }).click();
        const confirmationDialog = page.getByRole('dialog', { name: '确认执行 copy-config' });
        await expect(confirmationDialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(confirmationDialog).toBeHidden();
        await expect(operationPanel.getByRole('button', { name: '执行 copy-config', exact: true })).toBeVisible();

        await deviceNode.click({ button: 'right' });
        await contextMenu.getByRole('menuitem', { name: '读取全部数据（get）', exact: true }).click();
        await expect(operationPanel.getByRole('button', { name: '执行 get', exact: true })).toBeVisible();
        await expect(page.getByRole('dialog', { name: /get · NETCONF E2E 设备/u })).toHaveCount(0);
    });

    test('closes the destructive workspace confirmation when leaving the page', async ({ page }) => {
        await page.goto('/#/yang/yang-workspace');
        const workspacePage = page.locator('.yang-workspace-page:visible');
        const clearButton = workspacePage.locator('.workspace-toolbar').getByRole('button', {
            name: '清空',
            exact: true
        });
        await expect(clearButton).toBeEnabled();
        await clearButton.click();
        const confirmationDialog = page.getByRole('dialog', { name: '清空 Schema 工作区' });
        await expect(confirmationDialog).toBeVisible();

        await page.goto('/#/yang/yang-modules');
        await expect(confirmationDialog).toBeHidden();
        await expect(page.getByText('YANG 模型库', { exact: true })).toBeVisible();
    });

    test('redirects the retired operations page to the Schema workspace', async ({ page }) => {
        await page.goto('/#/yang/yang-operations');
        await expect(page).toHaveURL(/#\/yang\/yang-workspace$/u);
        await expect(page.getByText('Schema 与设备操作', { exact: true })).toBeVisible();
        await expect(page.getByRole('tab', { name: '设备操作', exact: true })).toHaveCount(0);
    });
});
