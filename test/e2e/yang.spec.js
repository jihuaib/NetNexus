const { expect, test } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');

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
        await expect(settingsDialog.getByText(/libyang 3\.13\.6-e2e/u)).toBeVisible();
    });

    test('blocks compilation when the bundled libyang runtime is unavailable', async ({ page }) => {
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
        await expect(page.getByRole('button', { name: '编译工作区' })).toBeDisabled();

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

        const interfacesNode = page
            .getByRole('treeitem')
            .filter({ has: page.getByText('interfaces', { exact: true }) })
            .first();
        await interfacesNode.click({ button: 'right' });

        const contextMenu = page.locator('.schema-context-menu');
        await expect(contextMenu).toBeVisible();
        await expect(
            contextMenu.getByRole('menuitem', { name: '复制配置存储（copy-config）', exact: true })
        ).toBeVisible();
        await expect(
            contextMenu.getByRole('menuitem', { name: '删除整个配置存储（delete-config）', exact: true })
        ).toBeVisible();
        await contextMenu.getByRole('menuitem', { name: '读取当前节点（get）', exact: true }).click();

        const operationDialog = page.getByRole('dialog', { name: 'get · interfaces' });
        await expect(operationDialog).toBeVisible();
        const getFilterEditor = operationDialog.locator('textarea');
        await expect(getFilterEditor).toHaveValue('<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"/>');
        const completeFilter =
            '<filter type="subtree"><interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"/></filter>';
        await getFilterEditor.fill(completeFilter);

        const executeButton = operationDialog.getByRole('button', { name: '执行 get', exact: true });
        await expect(executeButton).toBeEnabled();
        await executeButton.click();

        await expect(operationDialog.locator('.rpc-result')).toContainText('<rpc-reply');
        await expect(operationDialog.locator('.rpc-result')).toContainText('<interface>');
        await expect(operationDialog.getByText('成功', { exact: true })).toBeVisible();
        expect(capturedRequest.filter).toBe(completeFilter);
        await operationDialog.getByRole('button', { name: '关闭' }).click();

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
        const editDialog = page.getByRole('dialog', { name: 'edit-config · enabled' });
        const editXml = editDialog.locator('textarea');
        await expect(editXml).toHaveValue(/NETNEXUS_REQUIRED: 输入 list key 值/u);
        await expect(editXml).toHaveValue(/<enabled><!-- NETNEXUS_REQUIRED: 输入boolean 值 --><\/enabled>/u);
        await expect(editDialog.getByText('XML 草稿还不能执行', { exact: true })).toBeVisible();
        await expect(editDialog.getByRole('button', { name: '执行 edit-config', exact: true })).toBeDisabled();
        await editDialog.getByRole('button', { name: '关闭' }).click();
    });

    test('keeps global device operations in the tree when no Schema nodes are available', async ({ page }) => {
        harness.controller.state.yang.schemaNodes = {};
        harness.controller.state.yang.rootNodeIds = [];
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
        const deleteDialog = page.getByRole('dialog', { name: 'delete-config · NETCONF E2E 设备' });
        const deleteTarget = deleteDialog.getByRole('combobox');
        await expect(deleteTarget).toContainText('startup');
        await deleteTarget.click();
        await expect(page.getByRole('option', { name: 'startup', exact: true })).toBeVisible();
        await expect(page.getByRole('option', { name: 'candidate', exact: true })).toHaveCount(0);
        await page.getByRole('option', { name: 'startup', exact: true }).click();
        await deleteDialog.getByRole('button', { name: '关闭' }).click();

        await deviceNode.click({ button: 'right' });
        await contextMenu.getByRole('menuitem', { name: '复制配置存储（copy-config）', exact: true }).click();
        const copyDialog = page.getByRole('dialog', { name: 'copy-config · NETCONF E2E 设备' });
        await copyDialog.getByRole('button', { name: '执行 copy-config', exact: true }).click();
        const confirmationDialog = page.getByRole('dialog', { name: '确认执行 copy-config' });
        await expect(confirmationDialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(confirmationDialog).toBeHidden();
        await expect(copyDialog).toBeVisible();
        await copyDialog.getByRole('button', { name: '关闭' }).click();

        await deviceNode.click({ button: 'right' });
        await contextMenu.getByRole('menuitem', { name: '读取全部数据（get）', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'get · NETCONF E2E 设备' })).toBeVisible();
    });

    test('redirects the retired operations page to the Schema workspace', async ({ page }) => {
        await page.goto('/#/yang/yang-operations');
        await expect(page).toHaveURL(/#\/yang\/yang-workspace$/u);
        await expect(page.getByText('Schema 与设备操作', { exact: true })).toBeVisible();
        await expect(page.getByRole('tab', { name: '设备操作', exact: true })).toHaveCount(0);
    });
});
