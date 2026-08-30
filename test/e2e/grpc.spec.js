const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e } = require('../../scripts/e2e-support');

const WORKSPACE_ROUTE = '/#/grpc/grpc-workspace';

const methodNode = (page, name) =>
    page
        .getByRole('treeitem')
        .filter({ has: page.getByText(name, { exact: true }) })
        .first();

test.describe('gRPC workspace', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('client mode: select method, invoke, inspect response tabs and history', async ({ page }) => {
        await page.goto(WORKSPACE_ROUTE);
        await expect(page.getByText('在左侧选择方法').first()).toBeVisible();

        // 点击方法：URL 栏显示调用路径，请求区自动生成模板
        await methodNode(page, 'Get').click();
        await expect(page.locator('.url-method .method-path')).toHaveText('/gnmi.gNMI/Get');
        await expect(page.locator('.tab-editor textarea').first()).toHaveValue(/"encoding": "JSON"/);

        // Metadata 内嵌编辑
        await page
            .getByRole('tab', { name: /Metadata/ })
            .first()
            .click();
        await page.getByRole('button', { name: '添加' }).click();
        await page.getByPlaceholder('如 username').fill('username');
        await page.getByPlaceholder('value').fill('admin');
        await page.getByRole('tab', { name: /消息/ }).click();

        // 调用：状态栏显示 OK、耗时与计数，响应时间线包含请求与响应
        await page.getByRole('button', { name: '调用' }).click();
        await expect(page.locator('.status-bar .status-code')).toHaveText('OK (0)');
        await expect(page.locator('.status-bar')).toContainText('12 ms');
        await expect(page.locator('.timeline-item')).toHaveCount(2);
        await expect(page.locator('.timeline-dir').nth(0)).toHaveText('请求');
        await expect(page.locator('.timeline-dir').nth(1)).toHaveText('响应');
        // 最新响应自动展开
        await expect(page.locator('.timeline-detail')).toHaveCount(1);

        // 响应 Metadata / Trailers Tab
        await page
            .getByRole('tab', { name: /^Metadata/ })
            .nth(1)
            .click();
        await expect(page.locator('.kv-table:visible')).toContainText('x-e2e');
        await page.getByRole('tab', { name: /Trailers/ }).click();
        await expect(page.locator('.kv-table:visible')).toContainText('grpc-status');

        // 历史
        await page.getByText('历史', { exact: true }).click();
        await expect(page.locator('.history-item')).toHaveCount(1);
        await expect(page.locator('.history-item')).toContainText('gnmi.gNMI.Get');
        await expect(page.locator('.history-item')).toContainText('OK (0)');

        // 保存的客户端配置应包含 metadata 与按方法记忆的请求文本
        const saved = harness.controller.state.grpc.clientConfig;
        expect(saved.method).toBe('gnmi.gNMI.Get');
        expect(saved.metadata).toEqual([{ enabled: true, key: 'username', value: 'admin' }]);
        expect(saved.requestTexts['gnmi.gNMI.Get']).toContain('"encoding": "JSON"');

        await page.getByRole('tab', { name: /响应/ }).click();
        await page.screenshot({ path: process.env.GRPC_E2E_SHOT_CLIENT || 'test-results/grpc-client.png' });
        await expect(page.locator('.nn-toast-error')).toHaveCount(0);
    });

    test('client mode: bidi stream exposes send / end / cancel in the toolbar', async ({ page }) => {
        await page.goto(WORKSPACE_ROUTE);
        await methodNode(page, 'Subscribe').click();
        await expect(page.locator('.url-method .method-path')).toHaveText('/gnmi.gNMI/Subscribe');
        await page.getByRole('button', { name: '调用' }).click();

        await expect(page.locator('.status-bar .status-code')).toHaveText('进行中');
        const sendButton = page.locator('.workspace-actions').getByRole('button', { name: '发送', exact: true });
        await expect(sendButton).toBeVisible();
        await sendButton.click();
        await expect(page.locator('.timeline-item')).toHaveCount(2);
        await page.locator('.workspace-actions').getByRole('button', { name: '结束发送' }).click();
        await expect(page.locator('.status-bar .status-code')).toHaveText('OK (0)');
        await expect(page.getByRole('button', { name: '调用' })).toBeVisible();
    });

    test('server mode: host a service, receive a device stream and push a message', async ({ page }) => {
        await page.goto(WORKSPACE_ROUTE);
        await page.getByText('服务器 · 上报').click();
        await expect(page.getByText('在左侧勾选要托管的服务')).toBeVisible();

        const serviceNode = page
            .getByRole('treeitem')
            .filter({ has: page.getByText('huawei_dialout.gRPCDataservice', { exact: true }) })
            .first();
        await serviceNode.locator('.nn-checkbox').click();
        await expect(page.locator('.url-method')).toContainText('1 个服务待托管');

        await page.getByRole('button', { name: '启动服务器' }).click();
        await expect(page.locator('.url-method')).toContainText('监听中 :57400');
        await expect(page.locator('.stream-item')).toHaveCount(1);
        await expect(page.locator('.stream-item')).toContainText('192.0.2.10:40001');

        await page.locator('.stream-item').click();
        await expect(page.locator('.status-bar')).toContainText('192.0.2.10:40001');
        await expect(page.locator('.timeline-item')).toHaveCount(1);

        await page.getByRole('button', { name: '模板' }).click();
        await page.getByRole('button', { name: '下发' }).click();
        await expect(page.locator('.timeline-item')).toHaveCount(2);
        await expect(page.locator('.stream-item')).toContainText('↑1');

        await page.screenshot({ path: process.env.GRPC_E2E_SHOT_SERVER || 'test-results/grpc-server.png' });
        await page.getByRole('button', { name: '停止服务器' }).click();
        await expect(page.getByRole('button', { name: '启动服务器' })).toBeVisible();
        await expect(page.locator('.nn-toast-error')).toHaveCount(0);
    });
});
