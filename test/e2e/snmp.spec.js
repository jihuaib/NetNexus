const { expect, test } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');

const MIB_COMPILE_ROUTE = '/#/snmp/snmp-mib-compile';
const MIB_WORKSPACE_ROUTE = '/#/snmp/snmp-mib';

const pageCases = [
    { route: '/#/snmp/snmp-config', title: '查询目标' },
    { route: MIB_COMPILE_ROUTE, title: 'MIB 编译', expectText: 'NETNEXUS-DEMO-MIB.mib' },
    { route: MIB_WORKSPACE_ROUTE, title: 'MIB 工作区', expectText: 'system' }
];

const mibTreeItems = page => page.locator('.mib-tree-panel').getByRole('treeitem');

const mibTreeNode = (page, name) =>
    mibTreeItems(page)
        .filter({ has: page.getByText(name, { exact: true }) })
        .first();

async function expandSystemTree(page) {
    const systemNode = mibTreeNode(page, 'system');
    await expect(systemNode).toBeVisible();
    if ((await systemNode.getAttribute('aria-expanded')) !== 'true') {
        await systemNode.getByRole('button', { name: '展开节点' }).click();
    }
    await expect(systemNode).toHaveAttribute('aria-expanded', 'true');
    await expect(mibTreeNode(page, 'sysDescr')).toBeVisible();
    await expect(mibTreeNode(page, 'sysContact')).toBeVisible();
    return systemNode;
}

async function openMibContextMenu(page, node) {
    await expect(node).toBeVisible();
    await node.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        element.dispatchEvent(
            new MouseEvent('contextmenu', {
                clientX: bounds.left + Math.min(bounds.width / 2, 120),
                clientY: bounds.top + bounds.height / 2,
                button: 2,
                buttons: 2,
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window
            })
        );
    });
    const contextMenu = page.locator('.mib-context-menu');
    await expect(contextMenu).toBeVisible();
    return contextMenu;
}

const apiCallCount = (harness, method) =>
    harness.controller.timeline.filter(item => item.message === `renderer API call: ${method}`).length;

async function expectStandaloneCenteredActionRow(row) {
    await expect(row).toHaveCSS('display', 'flex');
    await expect(row).toHaveCSS('justify-content', 'center');

    const layout = await row.evaluate(element => {
        const parent = element.parentElement;
        const rowBounds = element.getBoundingClientRect();
        const parentBounds = parent.getBoundingClientRect();
        const visibleButtons = Array.from(element.querySelectorAll('button')).filter(button => {
            const bounds = button.getBoundingClientRect();
            return bounds.width > 0 && bounds.height > 0;
        });
        const firstBounds = visibleButtons.at(0).getBoundingClientRect();
        const lastBounds = visibleButtons.at(-1).getBoundingClientRect();

        return {
            parentIsCardBody: parent.classList.contains('nn-card-body'),
            buttonCount: visibleButtons.length,
            leftInset: rowBounds.left - parentBounds.left,
            rightInset: parentBounds.right - rowBounds.right,
            rowWidth: rowBounds.width,
            buttonsCenter: (firstBounds.left + lastBounds.right) / 2,
            rowCenter: (rowBounds.left + rowBounds.right) / 2
        };
    });

    expect(layout.parentIsCardBody).toBe(true);
    expect(layout.buttonCount).toBe(2);
    expect(layout.rowWidth).toBeGreaterThan(300);
    expect(Math.abs(layout.leftInset - layout.rightInset)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.buttonsCenter - layout.rowCenter)).toBeLessThanOrEqual(1);
}

async function startSnmpRuntime(page) {
    await page.goto('/#/snmp/snmp-config');
    const startButton = page.getByTestId('snmp-runtime-start-button');
    const stopButton = page.getByTestId('snmp-runtime-stop-button');
    await expect(startButton).toBeVisible();
    await startButton.click();
    await expect(startButton).toBeDisabled();
    await expect(stopButton).toBeEnabled();
}

test.describe('SNMP pages', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('uses independent process and Trap buttons and saves configuration when starting', async ({ page }) => {
        await page.goto('/#/snmp/snmp-config');

        const runtimeStartButton = page.getByTestId('snmp-runtime-start-button');
        const runtimeStopButton = page.getByTestId('snmp-runtime-stop-button');
        const trapStartButton = page.getByTestId('snmp-trap-start-button');
        const trapStopButton = page.getByTestId('snmp-trap-stop-button');
        const runtimeActions = page.getByTestId('snmp-runtime-actions');
        const trapActions = page.getByTestId('snmp-trap-actions');
        const trapPort = page.getByPlaceholder('请输入Trap端口');
        const trapAuthCard = page.locator('.trap-auth-card');

        await expect(page.locator('.query-target-card').getByTestId('snmp-runtime-start-button')).toBeVisible();
        await expectStandaloneCenteredActionRow(runtimeActions);
        await expect(trapAuthCard).toContainText('Trap 服务与协议认证');
        await expect(trapAuthCard.getByTestId('snmp-trap-start-button')).toBeVisible();
        await expectStandaloneCenteredActionRow(trapActions);
        await expect
            .poll(() => trapActions.evaluate(element => element.parentElement?.lastElementChild === element))
            .toBe(true);
        await expect(trapAuthCard.locator('.card-section-title')).toHaveText('协议认证');
        await expect(trapAuthCard.getByRole('radio', { name: 'SNMPv2c', exact: true })).toBeVisible();
        await expect(runtimeStartButton).toBeEnabled();
        await expect(runtimeStopButton).toBeDisabled();
        await expect(trapStartButton).toBeDisabled();
        await expect(trapStopButton).toBeDisabled();
        await expect(page.getByRole('button', { name: '保存配置', exact: true })).toHaveCount(0);

        await page.getByPlaceholder('例如 127.0.0.1').fill('198.51.100.25');
        await trapPort.fill('invalid');
        await runtimeStartButton.click();
        await expect(runtimeStartButton).toBeDisabled();
        await expect(runtimeStopButton).toBeEnabled();
        await expect(trapStartButton).toBeEnabled();
        await expect(trapStopButton).toBeDisabled();
        await expect(page.getByPlaceholder('例如 127.0.0.1')).toBeDisabled();
        await expect(page.getByPlaceholder('请输入查询端口')).toBeDisabled();
        expect(apiCallCount(harness, 'snmp.saveSnmpConfig')).toBe(1);
        expect(apiCallCount(harness, 'snmp.startSnmp')).toBe(1);
        expect(harness.controller.state.snmp.config).toMatchObject({
            targetHost: '198.51.100.25',
            port: 162
        });
        expect(
            harness.controller.timeline.findIndex(item => item.message === 'renderer API call: snmp.saveSnmpConfig')
        ).toBeLessThan(
            harness.controller.timeline.findIndex(item => item.message === 'renderer API call: snmp.startSnmp')
        );

        await trapStartButton.click();
        expect(apiCallCount(harness, 'snmp.saveSnmpConfig')).toBe(1);
        expect(apiCallCount(harness, 'snmp.startSnmpTrap')).toBe(0);
        await expect(trapStartButton).toBeEnabled();
        await expect(trapStopButton).toBeDisabled();

        await trapPort.fill('162');
        await trapStartButton.click();
        await expect(trapStartButton).toBeDisabled();
        await expect(trapStopButton).toBeEnabled();
        await expect(trapPort).toBeDisabled();
        await expect(runtimeStopButton).toBeEnabled();
        expect(apiCallCount(harness, 'snmp.saveSnmpConfig')).toBe(2);
        expect(apiCallCount(harness, 'snmp.startSnmpTrap')).toBe(1);

        await trapStopButton.click();
        await expect(trapStartButton).toBeEnabled();
        await expect(trapStopButton).toBeDisabled();
        await expect(runtimeStopButton).toBeEnabled();
        expect(apiCallCount(harness, 'snmp.stopSnmpTrap')).toBe(1);
        expect(apiCallCount(harness, 'snmp.saveSnmpConfig')).toBe(2);

        await runtimeStopButton.click();
        await expect(runtimeStartButton).toBeEnabled();
        await expect(runtimeStopButton).toBeDisabled();
        await expect(trapStartButton).toBeDisabled();
        await expect(trapStopButton).toBeDisabled();
        expect(apiCallCount(harness, 'snmp.stopSnmp')).toBe(1);
        expect(apiCallCount(harness, 'snmp.saveSnmpConfig')).toBe(2);
    });

    test('loads MIB data only for the active runtime and drops late status responses', async ({ page }) => {
        await page.goto(MIB_COMPILE_ROUTE);

        await expect(page.getByTestId('snmp-mib-import-files-button')).toBeDisabled();
        await expect(page.getByText('NETNEXUS-DEMO-MIB.mib', { exact: true })).toHaveCount(0);
        expect(apiCallCount(harness, 'snmp.getMibStatus')).toBe(0);

        await page.evaluate(() => {
            window.__featureE2eEmit?.('snmp:runtimeChanged', {
                running: true,
                ready: true,
                trapRunning: false
            });
        });
        await expect(page.getByText('NETNEXUS-DEMO-MIB.mib', { exact: true })).toBeVisible();
        await expect.poll(() => apiCallCount(harness, 'snmp.getMibStatus')).toBe(1);

        await page.evaluate(() => {
            window.__featureE2eEmit?.('snmp:runtimeChanged', {
                running: false,
                ready: false,
                trapRunning: false
            });
        });
        await expect(page.getByTestId('snmp-mib-import-files-button')).toBeDisabled();
        await expect(page.getByText('NETNEXUS-DEMO-MIB.mib', { exact: true })).toHaveCount(0);

        harness.controller.state.snmp.mibStatusDelayMs = 250;
        await page.evaluate(() => {
            window.__featureE2eEmit?.('snmp:runtimeChanged', {
                running: true,
                ready: true,
                trapRunning: false
            });
        });
        await expect.poll(() => apiCallCount(harness, 'snmp.getMibStatus')).toBe(2);
        await page.evaluate(() => {
            window.__featureE2eEmit?.('snmp:runtimeChanged', {
                running: false,
                ready: false,
                trapRunning: false
            });
        });
        await page.waitForTimeout(350);
        await expect(page.getByTestId('snmp-mib-import-files-button')).toBeDisabled();
        await expect(page.getByText('NETNEXUS-DEMO-MIB.mib', { exact: true })).toHaveCount(0);
    });

    test('keeps the workspace layout while stopped and clears the tree on runtime stop', async ({ page }) => {
        await page.goto(MIB_WORKSPACE_ROUTE);

        await expect(page.locator('.mib-tree-panel')).toBeVisible();
        await expect(page.locator('.mib-tree-panel .nn-tree')).toHaveCount(0);
        expect(apiCallCount(harness, 'snmp.getMibStatus')).toBe(0);

        await page.evaluate(() => {
            window.__featureE2eEmit?.('snmp:runtimeChanged', {
                running: true,
                ready: true,
                trapRunning: false
            });
        });
        await expect(page.locator('.mib-tree-panel')).toBeVisible();
        await expect(mibTreeNode(page, 'system')).toBeVisible();

        await page.evaluate(() => {
            window.__featureE2eEmit?.('snmp:runtimeChanged', {
                running: false,
                ready: false,
                trapRunning: false
            });
        });
        await expect(page.locator('.mib-tree-panel')).toBeVisible();
        await expect(page.locator('.mib-tree-panel .nn-tree')).toHaveCount(0);
        await expect(mibTreeNode(page, 'system')).toHaveCount(0);
    });

    test('renders SNMP pages with mock data', async ({ page }) => {
        await startSnmpRuntime(page);
        for (const pageCase of pageCases) {
            await verifyPage(test, page, pageCase);
        }
    });

    test('opens Trap history in the standalone monitor route', async ({ page }) => {
        await startSnmpRuntime(page);
        await page.goto('/#/snmp/snmp-config');
        await expect(page.getByRole('tab', { name: 'Trap监控' })).toHaveCount(0);
        await expect(page.getByTestId('open-snmp-trap-monitor-window')).toHaveCount(0);

        await page.goto(MIB_WORKSPACE_ROUTE);
        await page.getByTestId('open-snmp-trap-monitor-window').click();
        await expect.poll(() => page.evaluate(() => window.__featureMonitorRequests)).toEqual(['snmp-trap']);

        await page.goto('/#/monitor/snmp-trap');
        await expect(page.getByTestId('snmp-monitor-shell')).toBeVisible();
        await expect(page.locator('.monitor-window-header')).toHaveCount(0);
        await expect.poll(() => page.title()).toBe('SNMP Trap 监控 - NetNexus');
        await expect(page.getByText('192.0.2.80')).toBeVisible();
        await expect(page.getByRole('button', { name: '清空' })).toBeVisible();
        await expect(page.locator('.sider')).toHaveCount(0);
    });

    test('redirects the legacy Trap route to the MIB workspace', async ({ page }) => {
        await startSnmpRuntime(page);
        await page.goto('/#/snmp/snmp-trap');
        await expect.poll(() => new URL(page.url()).hash).toBe('#/snmp/snmp-mib');
        await expect(page.getByTestId('open-snmp-trap-monitor-window')).toBeVisible();
    });

    test('keeps MIB files in the compile page and the OID tree in the workspace', async ({ page }) => {
        await startSnmpRuntime(page);
        await page.goto(MIB_COMPILE_ROUTE);

        const fileTable = page.locator('.mib-file-table');
        const statusFilter = page.getByTestId('mib-file-status-filter');
        await expect(fileTable).toBeVisible();
        await expect(statusFilter).toBeVisible();
        await expect(statusFilter.locator('.nn-select-single-value')).toHaveText('全部状态');
        await expect(fileTable.locator('.mib-file-name')).toHaveCount(3);
        await expect(fileTable.getByText('NETNEXUS-DEMO-MIB.mib', { exact: true })).toBeVisible();
        await expect(fileTable.getByText('NETNEXUS-DUPLICATE-MIB.mib', { exact: true })).toBeVisible();
        await expect(fileTable.getByText('NETNEXUS-BROKEN-MIB.mib', { exact: true })).toBeVisible();
        await expect(fileTable.locator('.mib-file-status-icon')).toHaveCount(3);
        await expect(fileTable.locator('.nn-tooltip-trigger')).toHaveCount(0);
        await expect(page.getByText('模块概览', { exact: true })).toHaveCount(0);
        await expect(page.locator('.mib-tree-panel')).toHaveCount(0);

        await statusFilter.click();
        await page.getByRole('option', { name: '失败', exact: true }).click();
        await expect(statusFilter.locator('.nn-select-single-value')).toHaveText('失败');
        await expect(fileTable.locator('.mib-file-name')).toHaveCount(1);
        await expect(fileTable.getByText('NETNEXUS-BROKEN-MIB.mib', { exact: true })).toBeVisible();
        await expect(fileTable.getByText('NETNEXUS-DEMO-MIB.mib', { exact: true })).toHaveCount(0);

        await statusFilter.click();
        await page.getByRole('option', { name: '全部状态', exact: true }).click();
        await expect(fileTable.locator('.mib-file-name')).toHaveCount(3);

        await page.goto(MIB_WORKSPACE_ROUTE);
        await expect(page.locator('.mib-tree-panel')).toBeVisible();
        await expect(page.locator('.mib-file-table')).toHaveCount(0);
        await expect(page.getByText('NETNEXUS-DEMO-MIB.mib', { exact: true })).toHaveCount(0);
    });

    test('shows live MIB file progress only in the compile page', async ({ page }) => {
        await startSnmpRuntime(page);
        await page.goto(MIB_COMPILE_ROUTE);

        const recompileButton = page.getByRole('button', { name: '重新编译' });
        await expect(recompileButton).toBeEnabled();
        await recompileButton.click();

        const inlineProgress = page.locator('.mib-compile-progress');
        await expect(inlineProgress).toBeVisible();
        await expect(inlineProgress).toContainText(/(准备编译|编译 \d+\/3)/u);
        await expect(inlineProgress.getByRole('progressbar', { name: 'MIB编译进度' })).toBeVisible();
        await expect(page.locator('.mib-compile-notification')).toHaveCount(0);

        await expect(recompileButton).toBeEnabled();
        await expect(inlineProgress).toHaveCount(0);

        await page.goto(MIB_WORKSPACE_ROUTE);
        await expect(page.locator('.mib-compile-progress')).toHaveCount(0);
    });

    test('loads MIB source only after clicking the file action', async ({ page }) => {
        await startSnmpRuntime(page);
        await page.goto(MIB_COMPILE_ROUTE);

        const fileTable = page.locator('.mib-file-table');
        const sourceRow = fileTable.getByRole('row').filter({ hasText: 'NETNEXUS-DEMO-MIB.mib' });
        const sourceButton = sourceRow.getByRole('button', { name: '源码', exact: true });
        await expect(sourceButton).toBeVisible();
        expect(apiCallCount(harness, 'snmp.getMibSource')).toBe(0);

        await sourceButton.click();

        const sourceDrawer = page.getByRole('dialog', { name: 'NETNEXUS-DEMO-MIB.mib', exact: true });
        await expect(sourceDrawer).toBeVisible();
        await expect(sourceDrawer.locator('.mib-source-preview')).toContainText(
            'NETNEXUS-DEMO-MIB DEFINITIONS ::= BEGIN'
        );
        await expect.poll(() => apiCallCount(harness, 'snmp.getMibSource')).toBe(1);

        await sourceDrawer.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(sourceDrawer).toBeHidden();
    });

    test('does not refresh compiler or workspace data when switching tabs', async ({ page }) => {
        await startSnmpRuntime(page);
        await page.goto(MIB_COMPILE_ROUTE);
        await expect(page.locator('.mib-file-table')).toBeVisible();
        await expect.poll(() => apiCallCount(harness, 'snmp.getMibStatus')).toBe(1);

        const statusFilter = page.getByTestId('mib-file-status-filter');
        await statusFilter.click();
        await page.getByRole('option', { name: '失败', exact: true }).click();
        await expect(page.locator('.mib-file-table .mib-file-name')).toHaveCount(1);

        await page.getByRole('tab', { name: 'MIB工作区', exact: true }).click();
        await expect(page).toHaveURL(/#\/snmp\/snmp-mib$/u);
        await expect(page.locator('.mib-tree-panel')).toBeVisible();
        await expect.poll(() => apiCallCount(harness, 'snmp.getMibStatus')).toBe(2);

        await page.getByRole('tab', { name: 'MIB编译', exact: true }).click();
        await expect(page).toHaveURL(/#\/snmp\/snmp-mib-compile$/u);
        await expect(page.locator('.mib-file-table')).toBeVisible();
        await expect(statusFilter.locator('.nn-select-single-value')).toHaveText('失败');
        await expect(page.locator('.mib-file-table .mib-file-name')).toHaveCount(1);

        await page.getByRole('tab', { name: 'MIB工作区', exact: true }).click();
        await expect(page).toHaveURL(/#\/snmp\/snmp-mib$/u);
        await expect(page.locator('.mib-tree-panel')).toBeVisible();
        await page.waitForTimeout(100);
        expect(apiCallCount(harness, 'snmp.getMibStatus')).toBe(2);
    });

    test('uses semantic icons for branch, table, read-only, read-write, and notification nodes', async ({ page }) => {
        await startSnmpRuntime(page);
        await page.goto(MIB_WORKSPACE_ROUTE);

        const systemNode = await expandSystemTree(page);
        const tableNode = mibTreeNode(page, 'ifTable');
        const notificationNode = mibTreeNode(page, 'linkDown');
        const readOnlyNode = mibTreeNode(page, 'sysDescr');
        const readWriteNode = mibTreeNode(page, 'sysContact');

        await expect(systemNode.locator('[data-node-icon="container"]')).toBeVisible();
        await expect(tableNode.locator('[data-node-icon="list"]')).toBeVisible();
        await expect(readOnlyNode.locator('[data-node-icon="read"]')).toBeVisible();
        await expect(readWriteNode.locator('[data-node-icon="write"]')).toBeVisible();
        await expect(notificationNode.locator('[data-node-icon="notification"]')).toBeVisible();
    });

    test('opens node properties only from the tree context menu', async ({ page }) => {
        await startSnmpRuntime(page);
        await page.goto(MIB_WORKSPACE_ROUTE);
        await expandSystemTree(page);

        const readOnlyNode = mibTreeNode(page, 'sysDescr');
        const propertyDialog = page.getByRole('dialog', { name: /节点属性 · .*sysDescr/u });

        await readOnlyNode.click();
        await expect(readOnlyNode).toHaveAttribute('aria-selected', 'true');
        await expect(propertyDialog).toHaveCount(0);
        await expect(page.locator('.operation-empty')).toBeVisible();

        const contextMenu = await openMibContextMenu(page, readOnlyNode);
        await expect(contextMenu.getByRole('menuitem')).toHaveCount(6);
        await expect(contextMenu.getByRole('menuitem', { name: '解析 OID', exact: true })).toHaveCount(0);
        await expect(contextMenu.getByRole('menuitem', { name: 'Trap 变量', exact: true })).toHaveCount(0);
        await contextMenu.getByRole('menuitem', { name: '查看节点属性', exact: true }).click();

        await expect(propertyDialog).toBeVisible();
        await expect(propertyDialog).toContainText('SNMPv2-MIB::sysDescr');
        await expect(propertyDialog).toContainText('1.3.6.1.2.1.1.1');
        await expect(propertyDialog.locator('.nn-descriptions-item-label').first()).toHaveCSS('text-align', 'left');
        await expect(propertyDialog.locator('.nn-descriptions-item-content').first()).toHaveCSS('text-align', 'left');
        expect(apiCallCount(harness, 'snmp.translateOid')).toBe(0);
        await propertyDialog.getByRole('button', { name: '关闭' }).click();
        await expect(propertyDialog).toBeHidden();
    });

    test('runs GET inline and exposes resizable workspace panes', async ({ page }) => {
        await startSnmpRuntime(page);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(MIB_WORKSPACE_ROUTE);
        await expandSystemTree(page);

        await expect
            .poll(async () => Math.round((await page.locator('.mib-tree-panel').boundingBox())?.width || 0))
            .toBe(320);
        await expect(mibTreeNode(page, 'sysDescr').locator('.mib-node-title')).toHaveCSS('font-size', '12px');

        const contextMenu = await openMibContextMenu(page, mibTreeNode(page, 'sysDescr'));
        await contextMenu.getByRole('menuitem', { name: 'GET 查询', exact: true }).click();

        const operations = page.locator('.snmp-mib-operations');
        await expect(operations.locator('.operation-nav')).toHaveCount(0);
        await expect(operations.locator('.operation-request-pane .operation-title')).toHaveText('请求 · GET');
        await expect(operations.getByPlaceholder('请输入数字 OID')).toHaveValue('1.3.6.1.2.1.1.1.0');
        await expect(page.getByRole('dialog')).toHaveCount(0);

        await operations.getByRole('button', { name: '发送 GET', exact: true }).click();
        await expect(operations.locator('.operation-result-pane')).toContainText('成功');
        await expect(operations.locator('.operation-result-descriptions')).toContainText('NetNexus E2E');
        expect(apiCallCount(harness, 'snmp.translateOid')).toBe(0);
        await expect(page.getByRole('dialog')).toHaveCount(0);

        const walkMenu = await openMibContextMenu(page, mibTreeNode(page, 'system'));
        await walkMenu.getByRole('menuitem', { name: 'WALK 查询', exact: true }).click();
        await expect(operations.locator('.operation-request-pane .operation-title')).toHaveText('请求 · WALK');
        await expect(page.getByRole('dialog')).toHaveCount(0);

        const setMenu = await openMibContextMenu(page, mibTreeNode(page, 'sysContact'));
        await setMenu.getByRole('menuitem', { name: 'SET 设置', exact: true }).click();
        await expect(operations.locator('.operation-request-pane .operation-title')).toHaveText('请求 · SET');
        await expect(page.getByRole('dialog')).toHaveCount(0);

        const treeSeparator = page.getByRole('separator', { name: '调整 OID 树宽度' });
        const operationSeparator = page.getByRole('separator', { name: '调整 SNMP 请求和响应高度' });
        await expect(treeSeparator).toBeVisible();
        await expect(treeSeparator).toHaveAttribute('aria-orientation', 'vertical');
        await expect(treeSeparator).toHaveAttribute('aria-valuenow', /^\d+$/u);
        await expect(operationSeparator).toBeVisible();
        await expect(operationSeparator).toHaveAttribute('aria-orientation', 'horizontal');
        await expect(operationSeparator).toHaveAttribute('aria-valuenow', /^\d+$/u);
    });

    test('locates a tree node by OID without opening an operation', async ({ page }) => {
        await startSnmpRuntime(page);
        const oid = '1.3.6.1.2.1.1.1.0';
        await page.goto(MIB_WORKSPACE_ROUTE);

        await page.locator('.oid-query-row input').fill(oid);
        await page.locator('.oid-query-row').getByRole('button', { name: '定位节点', exact: true }).click();

        const operations = page.locator('.snmp-mib-operations');
        await expect(mibTreeNode(page, 'sysDescr')).toHaveAttribute('aria-selected', 'true');
        await expect(operations.locator('.operation-empty')).toBeVisible();
        await expect(operations.locator('.operation-request-pane')).toHaveCount(0);
        expect(apiCallCount(harness, 'snmp.translateOid')).toBe(1);
    });
});
