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

async function expandSchemaModule(page, moduleName) {
    const moduleNode = page
        .getByRole('treeitem')
        .filter({ has: page.getByText(moduleName, { exact: true }) })
        .first();
    await expect(moduleNode).toBeVisible();
    await moduleNode.getByRole('button', { name: '展开节点' }).click();
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

    test('resizes the Schema, RPC request, and RPC response panes without resizing their containers', async ({
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
        const treeSeparator = workspacePage.getByRole('separator', { name: '调整 Schema 树宽度' });
        const operationSeparator = operationPanel.getByRole('separator', {
            name: '调整 RPC 请求和响应高度'
        });

        await expect(treeSeparator).toBeVisible();
        await expect(treeSeparator).toHaveAttribute('aria-orientation', 'vertical');
        await expect(operationSeparator).toBeVisible();
        await expect(operationSeparator).toHaveAttribute('aria-orientation', 'horizontal');

        const workspaceBefore = await workspaceLayout.boundingBox();
        const treeBefore = await schemaPanel.boundingBox();
        const operationBefore = await operationPanel.boundingBox();
        expect(workspaceBefore).not.toBeNull();
        expect(treeBefore).not.toBeNull();
        expect(operationBefore).not.toBeNull();

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
        const operationBeforeRowDrag = await operationPanel.boundingBox();
        expect(requestBefore).not.toBeNull();
        expect(responseBefore).not.toBeNull();
        expect(operationBeforeRowDrag).not.toBeNull();

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

    test('executes node operations from the Schema tree context menu', async ({ page }) => {
        let capturedRequest = null;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.netconf.executeOperation') capturedRequest = args[0];
            return originalControllerCall(method, ...args);
        };
        await page.goto('/#/yang/yang-workspace');
        await expandSchemaModule(page, 'ietf-interfaces');

        const interfacesNode = page
            .getByRole('treeitem')
            .filter({ has: page.getByText('interfaces', { exact: true }) })
            .first();
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
        await expect(
            contextMenu.getByRole('menuitem', { name: '复制配置存储（copy-config）', exact: true })
        ).toBeVisible();
        await expect(
            contextMenu.getByRole('menuitem', { name: '删除整个配置存储（delete-config）', exact: true })
        ).toBeVisible();
        await contextMenu.getByRole('menuitem', { name: '读取当前节点（get）', exact: true }).click();

        const operationPanel = page.locator('.workspace-operation-panel');
        await expect(operationPanel).toBeVisible();
        await expect(page.getByRole('dialog', { name: 'get · interfaces' })).toHaveCount(0);

        const requestCard = operationPanel.locator('.operation-form-card');
        const responseCard = operationPanel.locator('.operation-result-card');
        const operationBox = await operationPanel.boundingBox();
        const requestBox = await requestCard.boundingBox();
        const responseBox = await responseCard.boundingBox();
        expect(operationBox).toBeTruthy();
        expect(requestBox).toBeTruthy();
        expect(responseBox).toBeTruthy();
        expect(Math.abs(requestBox.x - operationBox.x)).toBeLessThan(1);
        expect(Math.abs(requestBox.width - operationBox.width)).toBeLessThan(1);
        expect(Math.abs(responseBox.width - operationBox.width)).toBeLessThan(1);
        expect(responseBox.y).toBeGreaterThanOrEqual(requestBox.y + requestBox.height - 1);

        const rpcXmlTab = operationPanel.getByRole('tab', { name: 'RPC XML', exact: true });
        await expect(rpcXmlTab).toHaveAttribute('aria-selected', 'true');
        const requestPreview = operationPanel.locator('.rpc-request-preview');
        await expect(requestPreview).toBeVisible();
        const initialRequestXml = await requestPreview.textContent();
        expect(initialRequestXml).toMatch(/<rpc[^>]*>\n\s{2}<get>\n\s{4}<filter type="subtree">/u);
        const requestDisplayToggle = requestCard.getByRole('button', { name: '查看原文', exact: true });
        const formattedRequestToggleWidth = (await requestDisplayToggle.boundingBox()).width;
        await requestDisplayToggle.click();
        const requestFormatToggle = requestCard.getByRole('button', { name: '格式化', exact: true });
        const rawRequestToggleWidth = (await requestFormatToggle.boundingBox()).width;
        expect(rawRequestToggleWidth).toBe(formattedRequestToggleWidth);
        await requestFormatToggle.click();

        const operationParametersTab = operationPanel.getByRole('tab', { name: '操作参数', exact: true });
        await operationParametersTab.click();
        await expect(operationParametersTab).toHaveAttribute('aria-selected', 'true');
        const getFilterEditor = operationPanel.locator('textarea');
        await expect(getFilterEditor).toHaveValue('<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"/>');
        const completeFilter =
            '<filter type="subtree"><interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"/></filter>';
        await getFilterEditor.fill(completeFilter);

        await rpcXmlTab.click();
        const formattedRequestXml = await requestPreview.textContent();
        expect(formattedRequestXml).toMatch(/<rpc[^>]*>\n\s{2}<get>\n\s{4}<filter type="subtree">/u);
        expect(formattedRequestXml).toMatch(
            /\n\s{6}<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"\/>\n\s{4}<\/filter>/u
        );

        const executeButton = operationPanel.getByRole('button', { name: '执行 get', exact: true });
        await expect(executeButton).toBeEnabled();
        await executeButton.click();

        await expect(operationPanel.locator('.rpc-result')).toContainText('<rpc-reply');
        await expect(operationPanel.locator('.rpc-result')).toContainText('<interface>');
        const formattedReplyXml = await operationPanel.locator('.rpc-result').textContent();
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
        expect(capturedRequest.filter).toBe(completeFilter);

        await interfacesNode.getByRole('button', { name: '展开节点' }).click();
        const interfaceNode = page
            .getByRole('treeitem')
            .filter({ has: page.getByText('interface', { exact: true }) })
            .first();
        await interfaceNode.getByRole('button', { name: '展开节点' }).click();
        const stateNode = page
            .getByRole('treeitem')
            .filter({ has: page.getByText('in-octets', { exact: true }) })
            .first();
        await stateNode.click({ button: 'right' });
        await expect(
            contextMenu.getByRole('menuitem', { name: '读取当前节点（get）', exact: true })
        ).not.toHaveAttribute('aria-disabled', 'true');
        await expect(
            contextMenu.getByRole('menuitem', { name: '编辑当前节点（edit-config）', exact: true })
        ).toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Escape');

        const enabledNode = page
            .getByRole('treeitem')
            .filter({ has: page.getByText('enabled', { exact: true }) })
            .first();
        await enabledNode.click({ button: 'right' });
        await contextMenu.getByRole('menuitem', { name: '编辑当前节点（edit-config）', exact: true }).click();
        await operationPanel.getByRole('tab', { name: '操作参数', exact: true }).click();
        const editXml = operationPanel.locator('textarea');
        await expect(editXml).toHaveValue(/NETNEXUS_REQUIRED: 输入 list key 值/u);
        await expect(editXml).toHaveValue(/<enabled><!-- NETNEXUS_REQUIRED: 输入boolean 值 --><\/enabled>/u);
        await expect(operationPanel.getByText('XML 草稿还不能执行', { exact: true })).toBeVisible();
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
        const interfacesNode = page
            .getByRole('treeitem')
            .filter({ has: page.getByText('interfaces', { exact: true }) })
            .first();
        const contextMenu = page.locator('.schema-context-menu');
        await expect(operationPanel.locator('.operation-context-bar')).toHaveCount(0);
        await expect(operationPanel.getByText('NETCONF 已连接', { exact: true })).toHaveCount(0);
        const sessionReadsAfterMount = sessionReadCount;

        await interfacesNode.click({ button: 'right' });
        await contextMenu.getByRole('menuitem', { name: '读取当前节点（get）', exact: true }).click();
        await operationPanel.getByRole('button', { name: '执行 get', exact: true }).click();
        await expect.poll(() => Boolean(releaseRpc)).toBe(true);

        await interfacesNode.click({ button: 'right' });
        const nextOperationItem = contextMenu.getByRole('menuitem', {
            name: '读取节点配置（get-config）',
            exact: true
        });
        await expect(nextOperationItem).toHaveAttribute('aria-disabled', 'true');
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

        await interfacesNode.click({ button: 'right' });
        await contextMenu.getByRole('menuitem', { name: '读取节点配置（get-config）', exact: true }).click();
        await expect(operationPanel.getByRole('button', { name: '执行 get-config', exact: true })).toBeEnabled();
        expect(sessionReadCount).toBe(sessionReadsAfterMount);
    });

    test('keeps global device operations in the tree when no Schema nodes are available', async ({ page }) => {
        harness.controller.state.yang.schemaTree = null;
        harness.controller.state.yang.compiledModuleIds = [];
        harness.controller.state.yang.workspace = null;
        await page.setViewportSize({ width: 1000, height: 420 });

        await page.goto('/#/yang/yang-workspace');
        const deviceNode = page
            .getByRole('treeitem')
            .filter({ has: page.getByText('当前设备：NETCONF E2E 设备', { exact: true }) });
        await expect(deviceNode).toBeVisible();
        await deviceNode.click({ button: 'right' });

        const contextMenu = page.locator('.schema-context-menu');
        const menuMetrics = await contextMenu.evaluate(element => ({
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight
        }));
        expect(menuMetrics.scrollHeight).toBeGreaterThan(menuMetrics.clientHeight);
        await contextMenu.evaluate(element => {
            element.scrollTop = element.scrollHeight;
        });
        await expect(contextMenu).toBeVisible();

        await page.setViewportSize({ width: 1280, height: 900 });
        await deviceNode.click({ button: 'right' });
        await expect(contextMenu.getByRole('menuitem', { name: '读取全部数据（get）', exact: true })).toBeVisible();
        await expect(contextMenu.getByRole('menuitem', { name: '原始 RPC', exact: true })).toBeVisible();

        await contextMenu.getByRole('menuitem', { name: '删除整个配置存储（delete-config）', exact: true }).click();
        const operationPanel = page.locator('.workspace-operation-panel');
        await operationPanel.getByRole('tab', { name: '操作参数', exact: true }).click();
        const deleteTarget = operationPanel.getByRole('combobox');
        await expect(deleteTarget).toContainText('startup');
        await deleteTarget.click();
        await expect(page.getByRole('option', { name: 'startup', exact: true })).toBeVisible();
        await expect(page.getByRole('option', { name: 'candidate', exact: true })).toHaveCount(0);
        await page.getByRole('option', { name: 'startup', exact: true }).click();

        await deviceNode.click({ button: 'right' });
        await contextMenu.getByRole('menuitem', { name: '复制配置存储（copy-config）', exact: true }).click();
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
