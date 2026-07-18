const { expect, test } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');

const pageCases = [
    { route: '/#/yang/yang-connection', title: '连接设置', expectText: 'NETCONF' },
    { route: '/#/yang/yang-modules', title: 'YANG 模型库', expectText: 'ietf-interfaces' },
    { route: '/#/yang/yang-workspace', title: 'Schema 工作区', expectText: 'interfaces' },
    { route: '/#/yang/yang-operations', title: 'RPC 结果', expectText: 'NETCONF 会话已连接' }
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

    test('executes a structured get RPC and shows the raw rpc-reply', async ({ page }) => {
        await page.goto('/#/yang/yang-operations');
        const executeButton = page.getByRole('button', { name: '执行 get', exact: true });
        await expect(executeButton).toBeEnabled();
        await executeButton.click();

        await expect(page.locator('.rpc-result')).toContainText('<rpc-reply');
        await expect(page.locator('.rpc-result')).toContainText('<interface>');
        await expect(page.getByText('成功', { exact: true })).toBeVisible();
    });
});
