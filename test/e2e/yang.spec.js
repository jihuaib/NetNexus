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

function netconfEditContext(harness, nodePath, target = 'candidate') {
    const yang = harness.controller.state.yang;
    const node = Object.values(yang.schemaTree?.nodes || {}).find(item => item.path === nodePath);
    expect(node, `missing mock Schema node ${nodePath}`).toBeTruthy();
    return {
        profileId: yang.session.profileId,
        compileId: yang.workspace.compileId,
        nodeId: node.id,
        target
    };
}

async function latestMonitorRequest(page) {
    return page.evaluate(() => window.__featureMonitorRequestDetails?.at(-1) || null);
}

async function expectNetconfEditMonitorRequest(page, expectedContext) {
    await expect
        .poll(() => latestMonitorRequest(page))
        .toEqual({
            monitorId: 'netconf-edit-config',
            options: expectedContext
        });
    return latestMonitorRequest(page);
}

async function gotoNetconfEditMonitor(page, context) {
    const query = new URLSearchParams(context).toString();
    await page.goto('about:blank');
    await page.goto(`/#/monitor/netconf-edit-config?${query}`);
    const monitorPage = page.getByTestId('netconf-edit-config-monitor-page');
    await expect(monitorPage).toBeVisible();
    await expect(page.locator('.sider')).toHaveCount(0);
    await expect(page.locator('.monitor-window-header')).toHaveCount(0);

    const operationPanel = monitorPage.locator('.yang-operations-page');
    await expect(operationPanel).toBeVisible();
    await expect(operationPanel).toHaveClass(/yang-operations-embedded/u);
    await expect(operationPanel.locator('.operation-nav-card')).toHaveCount(0);
    await expect(operationPanel.locator('.operation-session-bar')).toHaveCount(0);
    await expect(operationPanel.locator('.operation-form-card')).toBeVisible();
    await expect(operationPanel.locator('.operation-result-card')).toBeVisible();
    await expect(operationPanel.getByRole('complementary', { name: '操作参数' })).toBeVisible();
    await expect(operationPanel.getByRole('separator', { name: '调整 RPC 请求和响应高度' })).toBeVisible();
    await expect(operationPanel.getByRole('separator', { name: '调整操作参数宽度' })).toBeVisible();
    return { monitorPage, operationPanel };
}

async function gotoNetconfNotificationMonitor(page) {
    await page.goto('/#/monitor/netconf-notifications');
    const monitorPage = page.getByTestId('netconf-notification-monitor-page');
    await expect(monitorPage).toBeVisible();
    await expect(page.locator('.sider')).toHaveCount(0);
    await expect(page.locator('.monitor-window-header')).toHaveCount(0);
    const browser = page.getByTestId('netconf-notification-drawer');
    await expect(browser).toBeVisible();
    const drawer = page.locator('.netconf-notification-standalone-drawer .nn-drawer-content');
    await expect(drawer).toBeVisible();
    return { monitorPage, browser, drawer };
}

async function openNetconfNotificationMonitor(page) {
    const button = page.locator('.notification-history-trigger');
    await button.click();
    await expect.poll(() => latestMonitorRequest(page)).toEqual({ monitorId: 'netconf-notifications', options: null });
    return gotoNetconfNotificationMonitor(page);
}

async function deliverLatestNotificationAction(page, harness) {
    const action = harness.controller.state.yang.notificationActionRequests.at(-1);
    expect(action).toBeTruthy();
    await page.goto('/#/yang/yang-workspace');
    const operationPanel = page.locator('.workspace-operation-panel');
    await expect(operationPanel).toBeVisible();
    await expect(operationPanel.getByRole('button', { name: '执行 get', exact: true })).toBeEnabled();
    // Browser-mode E2E reuses one renderer to represent the native notification
    // window. Replay the cross-window action only after the workspace Session is
    // ready, then await the mock delivery itself.
    await page.evaluate(
        payload =>
            new Promise(resolve => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        window.__featureE2eEmit?.('netconf:notificationAction', payload);
                        resolve();
                    });
                });
            }),
        { status: 'success', data: action }
    );
    return action;
}

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
    try {
        await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 10 });
    } finally {
        await page.mouse.up();
    }
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

async function connectionGeometry(page) {
    return page.locator('.yang-connection-page:visible').evaluate(root => {
        const rect = selector => {
            const bounds = root.querySelector(selector).getBoundingClientRect();
            return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        };
        return {
            card: rect(':scope > .connection-card'),
            body: rect(':scope > .connection-card > .nn-card-body'),
            layout: rect('.connection-layout'),
            profile: rect('.profile-card'),
            editor: rect('.profile-editor-card'),
            form: rect('.profile-form'),
            session: rect('.session-card')
        };
    });
}

async function moduleToolbarGeometry(page) {
    return page.locator('.modules-card > .nn-card-body').evaluate(body => {
        const rect = element => {
            const bounds = element.getBoundingClientRect();
            return {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
                right: bounds.right,
                bottom: bounds.bottom
            };
        };
        const find = selector => body.querySelector(selector);
        return {
            body: rect(body),
            toolbar: rect(find('[data-testid="yang-modules-toolbar"]')),
            currentProfile: rect(find('[data-testid="yang-modules-current-profile"]')),
            actions: rect(find('[data-testid="yang-modules-actions"]')),
            selectionRow: rect(find('.selection-row')),
            selectionCheckbox: rect(find('.selection-row .nn-checkbox-wrapper')),
            search: rect(find('.selection-row .selection-search')),
            status: rect(find('.selection-row .selection-status')),
            table: rect(find('.module-table')),
            compileLog: rect(find('[data-testid="yang-compile-log-panel"]')),
            controls: [
                find('[data-testid="yang-modules-current-profile"]'),
                find('.module-refresh-action'),
                find('.selection-row .selection-search'),
                find('.selection-row .selection-status')
            ].map(rect),
            actionButtons: [...body.querySelectorAll('.module-action-button')].map(rect),
            pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
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

async function expectSelectableXmlTextarea(input) {
    await expect(input).toBeVisible();
    const value = await input.inputValue();
    expect(value.length).toBeGreaterThan(0);
    await input.selectText();
    expect(
        await input.evaluate(element => ({
            start: element.selectionStart,
            end: element.selectionEnd,
            selected: element.value.slice(element.selectionStart, element.selectionEnd)
        }))
    ).toEqual({ start: 0, end: value.length, selected: value });
    await input.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const selectionStyle = await input.evaluate(element => {
        const inputStyle = getComputedStyle(element);
        const selectedStyle = getComputedStyle(element, '::selection');
        const highlight = element.parentElement.querySelector('[data-xml-highlight-layer]');
        const highlightContent = element.parentElement.querySelector('[data-xml-highlight-content]');
        const highlightStyle = getComputedStyle(highlight);
        const highlightTransformValue = getComputedStyle(highlightContent).transform;
        const highlightTransform =
            highlightTransformValue === 'none'
                ? new DOMMatrixReadOnly()
                : new DOMMatrixReadOnly(highlightTransformValue);
        const normalizeZero = value => (Object.is(value, -0) ? 0 : value);
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d');
        context.fillStyle = highlightStyle.backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const baseColor = context.getImageData(0, 0, 1, 1).data;
        context.fillStyle = selectedStyle.backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const selectedColor = context.getImageData(0, 0, 1, 1).data;
        return {
            userSelect: inputStyle.userSelect,
            backgroundColor: selectedStyle.backgroundColor,
            color: selectedStyle.color,
            textFillColor: selectedStyle.webkitTextFillColor,
            contrast:
                Math.abs(selectedColor[0] - baseColor[0]) +
                Math.abs(selectedColor[1] - baseColor[1]) +
                Math.abs(selectedColor[2] - baseColor[2]),
            inputMetrics: {
                paddingTop: inputStyle.paddingTop,
                paddingLeft: inputStyle.paddingLeft,
                fontSize: inputStyle.fontSize,
                lineHeight: inputStyle.lineHeight
            },
            highlightMetrics: {
                paddingTop: highlightStyle.paddingTop,
                paddingLeft: highlightStyle.paddingLeft,
                fontSize: highlightStyle.fontSize,
                lineHeight: highlightStyle.lineHeight
            },
            inputScroll: { top: element.scrollTop, left: element.scrollLeft },
            highlightTransform: {
                top: normalizeZero(-highlightTransform.m42),
                left: normalizeZero(-highlightTransform.m41)
            },
            highlightViewportScroll: { top: highlight.scrollTop, left: highlight.scrollLeft }
        };
    });
    expect(selectionStyle.userSelect).toBe('text');
    expect(selectionStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(selectionStyle.backgroundColor).not.toBe('transparent');
    expect(selectionStyle.contrast).toBeGreaterThan(60);
    expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(selectionStyle.color);
    expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(selectionStyle.textFillColor);
    expect(selectionStyle.highlightMetrics).toEqual(selectionStyle.inputMetrics);
    expect(selectionStyle.highlightTransform).toEqual(selectionStyle.inputScroll);
    expect(selectionStyle.highlightViewportScroll).toEqual({ top: 0, left: 0 });
}

async function expectXmlTextareaLineNumbers(input) {
    const value = await input.inputValue();
    const editor = input.locator('xpath=..');
    await expect(editor.locator('[data-xml-line-number-gutter]')).toBeVisible();
    expect(
        await editor
            .locator('[data-xml-line-number]')
            .evaluateAll(elements => elements.map(element => element.dataset.lineNumber))
    ).toEqual(value.split('\n').map((_line, index) => String(index + 1)));
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

    test('keeps hidden model tooltips off the global capture-scroll path at scale', async ({ page }) => {
        test.setTimeout(60_000);

        await page.addInitScript(() => {
            const captureScrollListeners = new Set();
            const originalAddEventListener = window.addEventListener;
            const originalRemoveEventListener = window.removeEventListener;
            const usesCapture = options => options === true || Boolean(options?.capture);

            window.addEventListener = function addTrackedEventListener(type, listener, options) {
                if (type === 'scroll' && usesCapture(options) && listener) {
                    captureScrollListeners.add(listener);
                }
                return originalAddEventListener.call(this, type, listener, options);
            };
            window.removeEventListener = function removeTrackedEventListener(type, listener, options) {
                if (type === 'scroll' && usesCapture(options) && listener) {
                    captureScrollListeners.delete(listener);
                }
                return originalRemoveEventListener.call(this, type, listener, options);
            };
            window.__yangCaptureScrollListenerCount = () => captureScrollListeners.size;
        });

        const scaleModules = Array.from({ length: 1000 }, (_value, index) => ({
            id: `scale-module-${index}@2026-07-19`,
            moduleId: `scale-module-${index}@2026-07-19`,
            name: `scale-module-${index}`,
            revision: '2026-07-19',
            namespace: `urn:netnexus:e2e:scale:${index}`,
            conformanceType: 'implement',
            features: [`feature-${index}`],
            deviations: [],
            imports: [],
            isLocal: true,
            source: 'file',
            status: 'downloaded',
            downloadStatus: 'downloaded',
            fileName: `scale-module-${index}@2026-07-19.yang`,
            filePath: `/tmp/netnexus-e2e/scale-module-${index}@2026-07-19.yang`,
            contentHash: `scale-${index}`,
            compiled: false,
            compileStatus: 'pending'
        }));
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.registry.listModules') {
                return { status: 'success', data: { modules: scaleModules } };
            }
            return originalControllerCall(method, ...args);
        };
        const captureScrollListenerCount = () =>
            page.evaluate(() => window.__yangCaptureScrollListenerCount?.() ?? Number.POSITIVE_INFINITY);

        await page.goto('/#/yang/yang-modules');
        const moduleTable = page.locator('.module-table');
        const moduleRows = moduleTable.locator('.nn-table-tbody > .nn-table-row');
        const modulePagination = moduleTable.getByRole('navigation', { name: '表格分页' });
        await expect(moduleRows).toHaveCount(50);
        await expect(moduleTable.locator('.nn-tooltip')).toHaveCount(200);
        await expect(modulePagination.locator('.nn-pagination-total')).toHaveText('共 1000 个模型');
        await expect(modulePagination.locator('.nn-pagination-page-count')).toHaveText('第 1 / 20 页');
        await expect(page.getByRole('tooltip')).toHaveCount(0);

        const baselineListenerCount = await captureScrollListenerCount();
        expect(baselineListenerCount).toBeLessThan(20);

        const titledTooltip = moduleTable
            .locator('.nn-tooltip')
            .filter({ has: page.locator('.ellipsis-text') })
            .first();
        await titledTooltip.hover();
        await expect(page.getByRole('tooltip')).toBeVisible();
        await expect.poll(captureScrollListenerCount).toBe(baselineListenerCount + 1);

        await page.locator('.modules-card > .nn-card-head').hover();
        await expect(page.getByRole('tooltip')).toHaveCount(0);
        await expect.poll(captureScrollListenerCount).toBe(baselineListenerCount);

        const pageJumper = modulePagination.getByRole('spinbutton', { name: '跳转页码' });
        await pageJumper.fill('20');
        await pageJumper.press('Enter');
        await expect(modulePagination.locator('.nn-pagination-page-count')).toHaveText('第 20 / 20 页');
        await expect(moduleRows).toHaveCount(50);
        await expect(moduleTable.getByText('scale-module-999', { exact: true })).toBeVisible();

        const moduleSearch = page.getByLabel('搜索模型', { exact: true });
        await moduleSearch.fill('scale-module-99');
        await expect(moduleRows).toHaveCount(11);
        await expect(modulePagination).toHaveCount(0);
        await expect(moduleTable.getByText('scale-module-99', { exact: true })).toBeVisible();

        await moduleSearch.clear();
        await expect(modulePagination.locator('.nn-pagination-page-count')).toHaveText('第 1 / 20 页');
        await expect(moduleRows).toHaveCount(50);

        await page.goto('/#/yang/yang-workspace');
        await expect(page.getByText('Schema 与设备操作', { exact: true })).toBeVisible();
        await expect.poll(captureScrollListenerCount).toBeLessThan(20);
    });

    test('windows 1000 Schema roots while preserving the full workspace index', async ({ page }) => {
        test.setTimeout(60_000);

        const scaleRoots = Array.from({ length: 1000 }, (_value, index) => {
            const suffix = String(index).padStart(4, '0');
            const name = `scale-schema-${suffix}`;
            return {
                id: `yang-module-${suffix}`,
                key: `yang-module-${suffix}`,
                name,
                title: name,
                keyword: 'module',
                kind: 'module',
                module: name,
                revision: '2026-07-19',
                namespace: `urn:netnexus:e2e:schema:${index}`,
                path: `/${name}`,
                hasChildren: true,
                childCount: 1,
                isLeaf: false
            };
        });
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            const response = await originalControllerCall(method, ...args);
            if (method !== 'yang.registry.getWorkspace' || response?.status !== 'success') return response;
            return {
                ...response,
                data: {
                    ...response.data,
                    compileId: 'e2e-scale-schema',
                    summary: {
                        ...(response.data.summary || {}),
                        moduleCount: scaleRoots.length,
                        nodeCount: scaleRoots.length
                    },
                    schemaTree: {
                        ...(response.data.schemaTree || {}),
                        rootId: 'yang-schema-root',
                        roots: scaleRoots,
                        nodeCount: scaleRoots.length,
                        authoritative: true,
                        source: 'libyang-effective',
                        scope: 'core-effective-schema'
                    }
                }
            };
        };
        await harness.controller.call('yang.netconf.disconnect', 'e2e-netconf-profile');

        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto('/#/yang/yang-workspace');

        const workspacePage = page.locator('.yang-workspace-page:visible');
        const treeScroll = workspacePage.locator('.schema-tree-scroll .nn-tree');
        const treeItems = schemaTreeItems(page);
        await expect(workspacePage.getByText('模块 1000', { exact: true })).toBeVisible();
        await expect(treeItems.filter({ hasText: 'scale-schema-0000' })).toBeVisible();
        await expect(treeItems.filter({ hasText: 'scale-schema-0999' })).toHaveCount(0);
        await expect.poll(() => treeItems.count()).toBeLessThan(100);
        expect(await treeScroll.evaluate(element => element.scrollHeight > element.clientHeight * 10)).toBe(true);

        await treeScroll.evaluate(
            element =>
                new Promise(resolve => {
                    element.addEventListener(
                        'scroll',
                        () => requestAnimationFrame(() => requestAnimationFrame(resolve)),
                        { once: true }
                    );
                    element.scrollTop = element.scrollHeight;
                })
        );
        await expect(treeItems.filter({ hasText: 'scale-schema-0999' })).toBeVisible();
        await expect(treeItems.filter({ hasText: 'scale-schema-0000' })).toHaveCount(0);
        await expect.poll(() => treeItems.count()).toBeLessThan(100);

        const lastSchemaRoot = treeItems.filter({
            has: page.getByText('scale-schema-0999', { exact: true })
        });
        await lastSchemaRoot.click({ button: 'right' });
        const contextMenu = page.locator('.schema-context-menu');
        await expect(contextMenu).toBeVisible();
        // A delayed notification for the already-settled tree offset must not dismiss the new menu.
        await treeScroll.evaluate(
            element =>
                new Promise(resolve => {
                    element.dispatchEvent(new Event('scroll'));
                    requestAnimationFrame(() => requestAnimationFrame(resolve));
                })
        );
        await expect(contextMenu).toBeVisible();

        const settledScrollTop = await treeScroll.evaluate(element => element.scrollTop);
        await treeScroll.evaluate(element => {
            element.scrollTop -= 1;
        });
        await expect(contextMenu).toHaveCount(0);
        await treeScroll.evaluate(
            (element, scrollTop) =>
                new Promise(resolve => {
                    element.addEventListener(
                        'scroll',
                        () => requestAnimationFrame(() => requestAnimationFrame(resolve)),
                        { once: true }
                    );
                    element.scrollTop = scrollTop;
                }),
            settledScrollTop
        );
        await expect.poll(() => treeScroll.evaluate(element => element.scrollTop)).toBe(settledScrollTop);
        await lastSchemaRoot.click({ button: 'right' });
        await expect(contextMenu).toBeVisible();

        const retainedPosition = await treeScroll.evaluate(element => {
            window.__retainedSchemaTreeForActivationTest = element;
            const viewport = element.getBoundingClientRect();
            const rendered = [...element.querySelectorAll('[data-nn-tree-virtual-index]')];
            const intersecting = rendered.find(node => {
                const bounds = node.getBoundingClientRect();
                return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
            });
            return {
                scrollTop: element.scrollTop,
                firstIntersectingIndex: Number(intersecting?.dataset.nnTreeVirtualIndex)
            };
        });
        expect(retainedPosition.scrollTop).toBeGreaterThan(0);

        await contextMenu.getByRole('menuitem', { name: '前往连接设置', exact: true }).click();
        await expect(page.locator('.yang-connection-page:visible')).toBeVisible();
        await page.evaluate(() => {
            window.__retainedSchemaTreeForActivationTest.scrollTop = 0;
        });

        await page.getByRole('tab', { name: 'Schema 工作区', exact: true }).click();
        await expect(page.locator('.yang-workspace-page:visible')).toBeVisible();
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const element = document.querySelector('.yang-workspace-page .schema-tree-scroll .nn-tree');
                    if (!element) return false;
                    const viewport = element.getBoundingClientRect();
                    return (
                        element.scrollTop > 0 &&
                        [...element.querySelectorAll('[data-nn-tree-virtual-index]')].some(node => {
                            const bounds = node.getBoundingClientRect();
                            return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
                        })
                    );
                })
            )
            .toBe(true);
        const restoredPosition = await treeScroll.evaluate(element => {
            const viewport = element.getBoundingClientRect();
            const intersecting = [...element.querySelectorAll('[data-nn-tree-virtual-index]')].find(node => {
                const bounds = node.getBoundingClientRect();
                return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
            });
            delete window.__retainedSchemaTreeForActivationTest;
            return {
                scrollTop: element.scrollTop,
                firstIntersectingIndex: Number(intersecting?.dataset.nnTreeVirtualIndex)
            };
        });
        expect(Math.abs(restoredPosition.scrollTop - retainedPosition.scrollTop)).toBeLessThanOrEqual(1);
        expect(restoredPosition.firstIntersectingIndex).toBe(retainedPosition.firstIntersectingIndex);
    });

    test('follows the connected Profile without page-level Profile switches', async ({ page }) => {
        const backupCompile = await harness.controller.call('yang.registry.compile', {
            profileId: 'e2e-netconf-profile-2'
        });
        expect(backupCompile.status).toBe('success');
        await harness.controller.call('yang.registry.getWorkspace', { profileId: 'e2e-netconf-profile' });

        const scopedCalls = [];
        let releaseBackupConnect = null;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            const targetProfileId = args[0]?.id || args[0];
            if (
                method === 'yang.netconf.connect' &&
                targetProfileId === 'e2e-netconf-profile-2' &&
                !releaseBackupConnect
            ) {
                return new Promise(resolve => {
                    releaseBackupConnect = async () => resolve(await originalControllerCall(method, ...args));
                });
            }
            if (method.startsWith('yang.registry.')) {
                scopedCalls.push({ method, profileId: args[0]?.profileId || '' });
            }
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-modules');
        const moduleCurrentProfile = page.getByTestId('yang-modules-current-profile');
        await expect(moduleCurrentProfile).toContainText('NETCONF E2E 设备');
        await expect(page.getByTestId('yang-modules-profile-select')).toHaveCount(0);
        await expect(page.getByRole('combobox', { name: 'Profile' })).toHaveCount(0);
        await expect(page.getByText('ietf-interfaces', { exact: true })).toBeVisible();

        await page.goto('/#/yang/yang-workspace');
        const workspaceCurrentProfile = page.getByTestId('yang-workspace-current-profile');
        await expect(workspaceCurrentProfile).toContainText('NETCONF E2E 设备');
        await expect(page.getByTestId('yang-workspace-profile-select')).toHaveCount(0);
        await expect(page.getByRole('combobox', { name: 'Profile' })).toHaveCount(0);
        await expect(schemaTreeItems(page).filter({ hasText: 'ietf-interfaces' }).first()).toBeVisible();

        await page.goto('/#/yang/yang-connection');
        await page.locator('.profile-list-item').filter({ hasText: 'NETCONF E2E 备用设备' }).click();
        await page.locator('.profile-editor-card').getByRole('button', { name: '连接', exact: true }).click();
        await expect.poll(() => Boolean(releaseBackupConnect)).toBe(true);
        const profileSwitchDialog = page.getByRole('dialog', { name: '切换 Profile' });
        await expect(profileSwitchDialog).toBeVisible();
        const profileDataLoad = page.getByTestId('yang-profile-data-load');
        await expect(profileDataLoad).toContainText('连接中');
        await expect(profileDataLoad.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10');
        const modalCenterOffset = await profileSwitchDialog.evaluate(dialog => {
            const bounds = dialog.getBoundingClientRect();
            return {
                x: Math.abs(bounds.left + bounds.width / 2 - window.innerWidth / 2),
                y: Math.abs(bounds.top + bounds.height / 2 - window.innerHeight / 2)
            };
        });
        expect(modalCenterOffset.x).toBeLessThanOrEqual(1);
        expect(modalCenterOffset.y).toBeLessThanOrEqual(1);

        await releaseBackupConnect();
        await expect(profileDataLoad).toContainText('切换完成');
        await expect(profileDataLoad.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
        await expect
            .poll(
                () =>
                    scopedCalls.filter(
                        call =>
                            call.method === 'yang.registry.getWorkspace' && call.profileId === 'e2e-netconf-profile-2'
                    ).length
            )
            .toBeGreaterThanOrEqual(3);
        const primarySession = await page.evaluate(() => window.netconfApi.getSessionState('e2e-netconf-profile'));
        expect(primarySession.data.connected).toBe(false);
        await profileSwitchDialog.getByRole('button', { name: '完成', exact: true }).click();
        await expect(profileSwitchDialog).toBeHidden();
        harness.controller.emitEvent('netconf:sessionEvent', {
            status: 'success',
            data: {
                profileId: 'e2e-netconf-profile-2',
                profileName: 'NETCONF E2E 备用设备',
                status: 'connected',
                state: 'connected',
                connected: true,
                sessionId: 'e2e-session-backup',
                connectedAt: '2026-07-19T08:00:00.000Z'
            }
        });
        await page.waitForTimeout(220);
        await expect(profileSwitchDialog).toBeHidden();

        await page.goto('/#/yang/yang-modules');
        await expect(moduleCurrentProfile).toContainText('NETCONF E2E 备用设备');
        await expect(page.getByText('vendor-system', { exact: true })).toBeVisible();
        await expect(page.getByText('ietf-interfaces', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '获取设备列表', exact: true })).toBeEnabled();

        await page.goto('/#/yang/yang-workspace');
        await expect(workspaceCurrentProfile).toContainText('NETCONF E2E 备用设备');
        await expect(page.getByText('Schema 已就绪', { exact: true })).toBeVisible();
        await expect(schemaTreeItems(page).filter({ hasText: 'vendor-system' }).first()).toBeVisible();
        await expect(schemaTreeItems(page).filter({ hasText: 'ietf-interfaces' })).toHaveCount(0);
        expect(
            scopedCalls.some(
                call => call.method === 'yang.registry.listModules' && call.profileId === 'e2e-netconf-profile-2'
            )
        ).toBe(true);
        expect(
            scopedCalls.some(
                call => call.method === 'yang.registry.getWorkspace' && call.profileId === 'e2e-netconf-profile-2'
            )
        ).toBe(true);

        await page.goto('/#/yang/yang-connection');
        await page.locator('.session-card').getByRole('button', { name: '断开连接', exact: true }).click();
        await page.goto('/#/yang/yang-modules');
        await expect(moduleCurrentProfile).toContainText('NETCONF E2E 备用设备');
        await expect(page.getByText('vendor-system', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '获取设备列表', exact: true })).toBeDisabled();
    });

    test('keeps inactive Profile progress overlays out of the active YANG page', async ({ page }) => {
        await page.goto('/#/yang/yang-connection');
        await expect(page.locator('.yang-connection-page:visible')).toBeVisible();
        await page.goto('/#/yang/yang-modules');

        await page.getByRole('button', { name: '获取设备列表', exact: true }).click();
        const deviceDialog = page.getByRole('dialog', { name: '设备 YANG 模型' });
        await expect(deviceDialog).toBeVisible();
        await expect(page.locator('.nn-modal-root:visible')).toHaveCount(1);
        await expect(page.locator('.nn-modal-mask:visible')).toHaveCount(1);

        harness.controller.emitEvent('netconf:sessionEvent', {
            status: 'success',
            data: {
                profileId: 'e2e-netconf-profile',
                profileName: 'NETCONF E2E 设备',
                status: 'reconnecting',
                state: 'reconnecting',
                connected: false,
                message: '模拟后台重连'
            }
        });
        await page.waitForTimeout(100);

        await expect(page.getByRole('dialog', { name: '切换 Profile' })).toHaveCount(0);
        await expect(page.locator('.nn-modal-root:visible')).toHaveCount(1);
        await expect(page.locator('.nn-modal-mask:visible')).toHaveCount(1);
        expect(
            await page.evaluate(() => ({
                stack: globalThis.__NETNEXUS_UI_OVERLAY_STATE__?.stack?.length || 0,
                lockCount: globalThis.__NETNEXUS_UI_OVERLAY_STATE__?.lockCount || 0
            }))
        ).toEqual({ stack: 1, lockCount: 1 });

        await deviceDialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(deviceDialog).toBeHidden();
        await expect(page.locator('.nn-modal-root:visible')).toHaveCount(0);
        await expect(page.locator('.nn-modal-mask:visible')).toHaveCount(0);
        await expect
            .poll(() =>
                page.evaluate(() => ({
                    stack: globalThis.__NETNEXUS_UI_OVERLAY_STATE__?.stack?.length || 0,
                    lockCount: globalThis.__NETNEXUS_UI_OVERLAY_STATE__?.lockCount || 0
                }))
            )
            .toEqual({ stack: 0, lockCount: 0 });
    });

    test('keeps the current Profile when a replacement connection fails', async ({ page }) => {
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            const targetProfileId = args[0]?.id || args[0];
            if (method !== 'yang.netconf.connect' || targetProfileId !== 'e2e-netconf-profile-2') {
                return originalControllerCall(method, ...args);
            }
            harness.controller.emitEvent('netconf:sessionEvent', {
                status: 'success',
                data: {
                    profileId: targetProfileId,
                    profileName: 'NETCONF E2E 备用设备',
                    status: 'connecting',
                    state: 'connecting',
                    connected: false
                }
            });
            harness.controller.emitEvent('netconf:sessionEvent', {
                status: 'success',
                data: {
                    profileId: targetProfileId,
                    profileName: 'NETCONF E2E 备用设备',
                    status: 'error',
                    state: 'error',
                    connected: false,
                    message: '模拟连接失败'
                }
            });
            return { status: 'error', msg: '模拟连接失败' };
        };

        await page.goto('/#/yang/yang-modules');
        await expect(page.getByTestId('yang-modules-current-profile')).toContainText('NETCONF E2E 设备');
        await page.goto('/#/yang/yang-connection');
        await page.locator('.profile-list-item').filter({ hasText: 'NETCONF E2E 备用设备' }).click();
        await page.locator('.profile-editor-card').getByRole('button', { name: '连接', exact: true }).click();

        const profileSwitchDialog = page.getByRole('dialog', { name: '切换 Profile' });
        await expect(profileSwitchDialog).toContainText('连接失败');
        await expect(profileSwitchDialog).toContainText('仍保留当前 Profile');
        await profileSwitchDialog.getByRole('button', { name: '完成', exact: true }).click();
        await expect(profileSwitchDialog).toBeHidden();
        harness.controller.emitEvent('netconf:sessionEvent', {
            status: 'success',
            data: {
                profileId: 'e2e-netconf-profile-2',
                profileName: 'NETCONF E2E 备用设备',
                status: 'connected',
                state: 'connected',
                connected: true,
                sessionId: 'late-session-after-failure',
                connectedAt: '2026-07-19T08:00:01.000Z'
            }
        });
        await page.waitForTimeout(220);
        await expect(profileSwitchDialog).toBeHidden();

        await page.goto('/#/yang/yang-modules');
        await expect(page.getByTestId('yang-modules-current-profile')).toContainText('NETCONF E2E 设备');
        await expect(page.getByText('ietf-interfaces', { exact: true })).toBeVisible();
        await expect(page.getByText('vendor-system', { exact: true })).toHaveCount(0);
        const primarySession = await page.evaluate(() => window.netconfApi.getSessionState('e2e-netconf-profile'));
        expect(primarySession.data.connected).toBe(true);
    });

    test('keeps a delayed Profile save attached to its original editor context', async ({ page }) => {
        let releaseSave = null;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method !== 'yang.netconf.saveProfile' || releaseSave) {
                return originalControllerCall(method, ...args);
            }
            const response = await originalControllerCall(method, ...args);
            return new Promise(resolve => {
                releaseSave = () => resolve(response);
            });
        };

        await page.goto('/#/yang/yang-connection');
        const profileItems = page.locator('.profile-list-item');
        const primaryProfile = profileItems.filter({ hasText: 'NETCONF E2E 设备' });
        const backupProfile = profileItems.filter({ hasText: 'NETCONF E2E 备用设备' });
        const nameInput = page
            .locator('.profile-editor-card .nn-form-item')
            .filter({ hasText: 'Profile 名称' })
            .getByRole('textbox');

        await nameInput.fill('NETCONF E2E 设备（延迟保存）');
        await page.locator('.profile-editor-card').getByRole('button', { name: '保存', exact: true }).click();
        await expect.poll(() => Boolean(releaseSave)).toBe(true);

        await backupProfile.click();
        await expect(backupProfile).toHaveClass(/profile-list-item-active/u);
        await expect(nameInput).toHaveValue('NETCONF E2E 备用设备');

        releaseSave();
        await expect(page.getByRole('status').filter({ hasText: '连接 Profile 已保存' })).toBeVisible();
        await expect(profileItems).toHaveCount(2);
        await expect(primaryProfile).toContainText('NETCONF E2E 设备（延迟保存）');
        await expect(backupProfile).toHaveClass(/profile-list-item-active/u);
        await expect(nameInput).toHaveValue('NETCONF E2E 备用设备');
    });

    test('ignores an out-of-order module failure after the connected Profile changes', async ({ page }) => {
        let releaseImport = null;
        let delayed = false;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method !== 'yang.registry.importFiles' || args[0]?.profileId !== 'e2e-netconf-profile' || delayed) {
                return originalControllerCall(method, ...args);
            }
            delayed = true;
            return new Promise(resolve => {
                releaseImport = () => resolve({ status: 'error', msg: '延迟导入失败，不应写入新上下文' });
            });
        };

        await page.goto('/#/yang/yang-modules');
        await page.getByRole('button', { name: '导入文件', exact: true }).click();
        await expect.poll(() => Boolean(releaseImport)).toBe(true);

        await page.goto('/#/yang/yang-connection');
        await page.locator('.profile-list-item').filter({ hasText: 'NETCONF E2E 备用设备' }).click();
        await page.locator('.profile-editor-card').getByRole('button', { name: '连接', exact: true }).click();
        const profileSwitchDialog = page.getByRole('dialog', { name: '切换 Profile' });
        await expect(profileSwitchDialog).toContainText('切换完成');
        await profileSwitchDialog.getByRole('button', { name: '完成', exact: true }).click();
        await page.goto('/#/yang/yang-modules');
        await expect(page.getByText('vendor-system', { exact: true })).toBeVisible();

        releaseImport();
        await page.evaluate(() => new Promise(resolve => window.setTimeout(resolve, 100)));
        await expect(page.getByRole('alert').filter({ hasText: '延迟导入失败' })).toHaveCount(0);
    });

    test('uses the shared YANG page shell and aligned connection panels', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/#/yang/yang-connection');

        const connectionPage = page.locator('.yang-connection-page:visible');
        await expect(connectionPage.locator(':scope > .connection-card > .nn-card-head')).toHaveCount(1);
        await expect(connectionPage.locator('.connection-panel .nn-card-head')).toHaveCount(0);
        await expect(connectionPage.locator('.connection-card > .nn-card-head').getByText('连接设置')).toBeVisible();

        const connection = await connectionGeometry(page);
        const connectionPageBox = await connectionPage.boundingBox();
        expect(Math.abs(connection.card.y - connectionPageBox.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(connection.card.height - connectionPageBox.height)).toBeLessThanOrEqual(1);
        expect(connection.layout.y - connection.body.y).toBeLessThanOrEqual(16);
        expect(Math.abs(connection.profile.y - connection.editor.y)).toBeLessThanOrEqual(1);
        expect(connection.profile.width).toBeGreaterThanOrEqual(220);
        expect(connection.editor.width).toBeGreaterThan(connection.profile.width);
        expect(connection.profile.x + connection.profile.width).toBeLessThanOrEqual(connection.editor.x - 7);
        expect(connection.session.y).toBeGreaterThanOrEqual(connection.editor.y + connection.editor.height + 7);
        expect(connection.session.y - (connection.editor.y + connection.editor.height)).toBeLessThanOrEqual(9);
        expect(Math.abs(connection.session.x - connection.editor.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(connection.session.width - connection.editor.width)).toBeLessThanOrEqual(1);
        expect(
            connection.profile.height - (connection.editor.height + connection.session.height + 8)
        ).toBeLessThanOrEqual(1);
        expect(
            connection.editor.height + connection.session.height + 8 - connection.profile.height
        ).toBeLessThanOrEqual(1);
        expect(
            connection.body.y + connection.body.height - (connection.layout.y + connection.layout.height)
        ).toBeLessThanOrEqual(16);

        const profileRows = connectionPage.locator('.profile-form .nn-row');
        const identityColumns = profileRows.nth(0).locator('.nn-col');
        const endpointColumns = profileRows.nth(1).locator('.nn-col');
        for (const columnIndex of [0, 1]) {
            const identityColumn = await identityColumns.nth(columnIndex).boundingBox();
            const endpointColumn = await endpointColumns.nth(columnIndex).boundingBox();
            expect(Math.abs(endpointColumn.x - identityColumn.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(endpointColumn.width - identityColumn.width)).toBeLessThanOrEqual(1);
        }

        const connectionCard = connection.card;
        await page.goto('/#/yang/yang-modules');
        const modulesCard = await page.locator('.modules-card:visible').boundingBox();
        await page.goto('/#/yang/yang-workspace');
        const workspaceCard = await page.locator('.workspace-card:visible').boundingBox();
        for (const siblingCard of [modulesCard, workspaceCard]) {
            expect(Math.abs(siblingCard.x - connectionCard.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(siblingCard.y - connectionCard.y)).toBeLessThanOrEqual(1);
            expect(Math.abs(siblingCard.width - connectionCard.width)).toBeLessThanOrEqual(1);
            expect(Math.abs(siblingCard.height - connectionCard.height)).toBeLessThanOrEqual(1);
        }
    });

    test('stacks the connection panels without horizontal overflow on narrow screens', async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 1000 });
        await page.goto('/#/yang/yang-connection');

        const connection = await connectionGeometry(page);
        expect(connection.layout.y - connection.body.y).toBeLessThanOrEqual(16);
        expect(Math.abs(connection.profile.x - connection.editor.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(connection.profile.width - connection.editor.width)).toBeLessThanOrEqual(1);
        expect(connection.editor.y).toBeGreaterThanOrEqual(connection.profile.y + connection.profile.height + 7);
        expect(connection.session.y).toBeGreaterThanOrEqual(connection.editor.y + connection.editor.height + 7);
        expect(connection.session.y - (connection.editor.y + connection.editor.height)).toBeLessThanOrEqual(9);
        expect(
            connection.body.y + connection.body.height - (connection.layout.y + connection.layout.height)
        ).toBeLessThanOrEqual(16);
        await expect
            .poll(() =>
                page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
            )
            .toBeLessThanOrEqual(1);

        await page.setViewportSize({ width: 560, height: 1000 });
        const compactConnection = await connectionGeometry(page);
        expect(Math.abs(compactConnection.profile.width - compactConnection.editor.width)).toBeLessThanOrEqual(1);
        const firstFormColumns = page.locator('.profile-editor-card .profile-form .nn-row').first().locator('.nn-col');
        const firstColumn = await firstFormColumns.nth(0).boundingBox();
        const secondColumn = await firstFormColumns.nth(1).boundingBox();
        expect(Math.abs(firstColumn.x - secondColumn.x)).toBeLessThanOrEqual(1);
        expect(secondColumn.y).toBeGreaterThanOrEqual(firstColumn.y + firstColumn.height);
        await expect
            .poll(() =>
                page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
            )
            .toBeLessThanOrEqual(1);
    });

    test('restores persisted Schema roots when the successful workspace omits its inline tree', async ({ page }) => {
        let rootReads = 0;
        let workspaceReads = 0;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            const response = await originalControllerCall(method, ...args);
            if (method === 'yang.registry.getSchemaRoots') rootReads += 1;
            if (method === 'yang.registry.getWorkspace') workspaceReads += 1;
            if (method !== 'yang.registry.getWorkspace' || response.status !== 'success') return response;
            return {
                ...response,
                data: {
                    ...response.data,
                    success: true,
                    schemaTree: {
                        ...response.data.schemaTree,
                        roots: []
                    }
                }
            };
        };

        await page.goto('/#/yang/yang-workspace');
        await expect(page.getByText('Schema 已就绪', { exact: true })).toBeVisible();
        await expect(page.getByText('Schema 生成失败', { exact: true })).toHaveCount(0);
        await expect.poll(() => rootReads).toBeGreaterThan(0);
        await expect(schemaTreeItems(page).filter({ hasText: 'ietf-interfaces' }).first()).toBeVisible();
        expect(workspaceReads).toBe(1);
    });

    test('restores a partial Schema when one model fails compilation', async ({ page }) => {
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
                    success: false,
                    schemaAvailable: true,
                    partialSchema: true,
                    schemaTree: null,
                    summary: {
                        ...response.data.summary,
                        compiledFiles: 2,
                        failedFiles: 1
                    }
                }
            };
        };

        await page.goto('/#/yang/yang-workspace');

        const partialTag = page.getByText('Schema 部分可用', { exact: true });
        await expect(partialTag).toBeVisible();
        await expect(partialTag).toHaveAttribute('title', '已载入 2 个有效文件，排除 1 个编译失败文件');
        await expect(page.getByText('Schema 生成失败', { exact: true })).toHaveCount(0);
        await expect.poll(() => rootReads).toBeGreaterThan(0);
        await expect(schemaTreeItems(page).filter({ hasText: 'ietf-interfaces' }).first()).toBeVisible();
        await expect(schemaTreeItems(page).filter({ hasText: 'ietf-system' })).toHaveCount(0);
        await expandSchemaModule(page, 'ietf-interfaces');
        await expect(
            schemaTreeItems(page)
                .filter({ has: page.getByText('interfaces', { exact: true }) })
                .first()
        ).toBeVisible();
    });

    test('keeps the compiled Schema visible while additive downloads refresh a large workspace', async ({ page }) => {
        let refreshWorkspace = false;
        let workspaceRefreshReads = 0;
        let refreshRootReads = 0;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            const response = await originalControllerCall(method, ...args);
            if (!refreshWorkspace) return response;
            if (method === 'yang.registry.getWorkspace' && response.status === 'success') {
                workspaceRefreshReads += 1;
                return {
                    ...response,
                    data: {
                        ...response.data,
                        schemaTree: null
                    }
                };
            }
            if (method === 'yang.registry.getSchemaRoots') {
                refreshRootReads += 1;
                await new Promise(resolve => setTimeout(resolve, 800));
            }
            return response;
        };

        await page.goto('/#/yang/yang-workspace');
        const interfacesRoot = schemaTreeItems(page).filter({ hasText: 'ietf-interfaces' }).first();
        await expect(interfacesRoot).toBeVisible();
        await expandSchemaModule(page, 'ietf-interfaces');
        const interfacesNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interfaces', { exact: true }) })
            .first();
        await expect(interfacesNode).toBeVisible();

        refreshWorkspace = true;
        await page.evaluate(() => {
            window.__featureE2eEmit?.('yang:taskProgress', {
                status: 'success',
                data: {
                    taskId: 'e2e-additive-download',
                    action: 'download',
                    phase: 'completed',
                    completed: 2,
                    total: 2,
                    percent: 100,
                    profileId: 'e2e-netconf-profile'
                }
            });
        });

        await expect.poll(() => workspaceRefreshReads).toBeGreaterThan(0);
        await page.waitForTimeout(100);
        expect(await interfacesRoot.isVisible()).toBe(true);
        await expect(interfacesRoot).toHaveAttribute('aria-expanded', 'true');
        await expect(interfacesNode).toBeVisible();
        expect(refreshRootReads).toBe(0);
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
        const connectionPage = page.locator('.yang-connection-page:visible');
        const sessionTable = connectionPage.locator('.session-table');
        await expect(sessionTable).toBeVisible();
        await expect(sessionTable.getByRole('row')).toHaveCount(2);
        await expect(sessionTable.locator('thead th')).toHaveText([
            'Profile',
            '远端',
            'NETCONF Base',
            'Session ID',
            '连接时间',
            '操作'
        ]);
        const capabilityButton = sessionTable.getByRole('button', { name: /Capability \d+/u });
        await expect(capabilityButton).toBeVisible();
        await expect(sessionTable.getByRole('button', { name: '断开连接', exact: true })).toBeVisible();
        await expect(connectionPage.locator('.connection-status-bar')).toHaveCount(0);
        await expect(connectionPage.locator('.connection-status-description')).toHaveCount(0);
        await expect(connectionPage.getByRole('button', { name: /Capability \d+/u })).toHaveCount(1);
        await expect(connectionPage.getByText('能力数量', { exact: true })).toHaveCount(0);
        await capabilityButton.click();

        const capabilityDialog = page.getByRole('dialog', { name: '设备 Capability' });
        await expect(capabilityDialog).toBeVisible();
        await expect(capabilityDialog).toHaveClass(/nn-drawer-content/u);
        await expect(capabilityDialog.locator('.capability-list')).toHaveCSS('overflow-y', 'auto');
        await expect(capabilityDialog).toContainText('urn:ietf:params:netconf:capability:candidate:1.0');
        await capabilityDialog.getByRole('button', { name: '关闭' }).click();

        const connectedGeometry = await connectionGeometry(page);
        await sessionTable.getByRole('button', { name: '断开连接', exact: true }).click();
        await expect(sessionTable).toBeVisible();
        await expect(sessionTable.getByText('未连接', { exact: true })).toBeVisible();
        await expect(capabilityButton).toHaveCount(0);
        await expect(sessionTable.getByRole('button', { name: '断开连接', exact: true })).toHaveCount(0);
        const editorConnectButton = connectionPage
            .locator('.profile-editor-card')
            .getByRole('button', { name: '连接', exact: true });
        await expect(editorConnectButton).toBeVisible();
        expectSameGeometry(connectedGeometry, await connectionGeometry(page));

        await editorConnectButton.click();
        const profileSwitchDialog = page.getByRole('dialog', { name: '切换 Profile' });
        await expect(profileSwitchDialog).toContainText('切换完成');
        await profileSwitchDialog.getByRole('button', { name: '完成', exact: true }).click();
        await expect(capabilityButton).toBeVisible();
        await expect(sessionTable.getByRole('button', { name: '断开连接', exact: true })).toBeVisible();
        await expect(editorConnectButton).toHaveCount(0);

        await page.goto('/#/yang/yang-workspace');
        const workspacePage = page.locator('.yang-workspace-page:visible');
        await expect(workspacePage.getByRole('button', { name: /Capability/u })).toHaveCount(0);
        await expect(workspacePage.getByText('设备 Capability', { exact: true })).toHaveCount(0);
        await expect(workspacePage.locator('.operation-context-bar')).toHaveCount(0);
    });

    test('coalesces workspace splitter pointer events into one visual frame', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto('/#/yang/yang-workspace');

        const separator = page
            .locator('.yang-workspace-page:visible')
            .getByRole('separator', { name: '调整 Schema 树宽度' });
        await expect(separator).toBeVisible();

        const result = await separator.evaluate(async element => {
            const win = element.ownerDocument.defaultView;
            const documentRef = element.ownerDocument;
            const originalRequestAnimationFrame = win.requestAnimationFrame;
            const originalCancelAnimationFrame = win.cancelAnimationFrame;
            const callbacks = new Map();
            const pointerId = 731;
            let nextFrameId = 0;
            const separatorRect = element.getBoundingClientRect();
            const layout = element.closest('.workspace-layout');
            const schemaPanel = layout.querySelector('.schema-panel');
            const startX = separatorRect.x + separatorRect.width / 2;
            const startY = separatorRect.y + separatorRect.height / 2;
            const widthBefore = schemaPanel.getBoundingClientRect().width;
            const dispatchPointer = (target, type, clientX, buttons) =>
                target.dispatchEvent(
                    new PointerEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        pointerId,
                        pointerType: 'mouse',
                        isPrimary: true,
                        button: type === 'pointerdown' ? 0 : -1,
                        buttons,
                        clientX,
                        clientY: startY
                    })
                );

            win.requestAnimationFrame = callback => {
                nextFrameId += 1;
                callbacks.set(nextFrameId, callback);
                return nextFrameId;
            };
            win.cancelAnimationFrame = frameId => callbacks.delete(frameId);

            try {
                dispatchPointer(element, 'pointerdown', startX, 1);
                for (let index = 1; index <= 100; index += 1) {
                    dispatchPointer(documentRef, 'pointermove', startX + (120 * index) / 100, 1);
                }

                const scheduledFrames = callbacks.size;
                const widthBeforeFlush = schemaPanel.getBoundingClientRect().width;
                const pendingCallbacks = [...callbacks.values()];
                callbacks.clear();
                pendingCallbacks[0]?.(performance.now());
                await Promise.resolve();
                await Promise.resolve();
                const widthAfterFlush = schemaPanel.getBoundingClientRect().width;
                return { scheduledFrames, widthBefore, widthBeforeFlush, widthAfterFlush };
            } finally {
                dispatchPointer(documentRef, 'pointerup', startX + 120, 0);
                win.requestAnimationFrame = originalRequestAnimationFrame;
                win.cancelAnimationFrame = originalCancelAnimationFrame;
            }
        });

        expect(result.scheduledFrames).toBe(1);
        expect(Math.abs(result.widthBeforeFlush - result.widthBefore)).toBeLessThanOrEqual(1);
        expect(result.widthAfterFlush - result.widthBefore).toBeGreaterThan(100);
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

    test('shows the current compilation logs inline in the model list', async ({ page }) => {
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
        const failedModule = harness.controller.state.yang.modules.find(module => module.name === 'ietf-interfaces');
        failedModule.compiled = false;
        failedModule.compileStatus = 'failed';
        failedModule.status = 'failed';
        harness.controller.state.yang.workspace = null;
        let requestedCompileId = '';
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.registry.getDiagnostics') requestedCompileId = args[0]?.compileId || '';
            const response = await originalControllerCall(method, ...args);
            if (method !== 'yang.registry.getWorkspace' || response.status !== 'success') return response;
            return {
                ...response,
                data: {
                    ...response.data,
                    summary: { ...response.data.summary, compiledFiles: 1, failedFiles: 1 }
                }
            };
        };

        await page.goto('/#/yang/yang-modules');

        const compileLog = page.getByTestId('yang-compile-log-panel');
        await expect(compileLog).toBeVisible();
        await expect(compileLog.getByText('部分编译成功', { exact: true })).toBeVisible();
        await expect(compileLog.getByText('ietf-interfaces@2018-02-20.yang 编译失败', { exact: true })).toBeVisible();
        await expect(compileLog.getByText('ietf-yang-types@2013-07-15.yang 编译成功', { exact: true })).toBeVisible();
        const logTypography = await compileLog.evaluate(element => {
            const row = getComputedStyle(element.querySelector('.compile-log-row'));
            const message = getComputedStyle(element.querySelector('.compile-log-message'));
            const location = getComputedStyle(element.querySelector('.compile-log-location'));
            return {
                rowFontSize: row.fontSize,
                rowLineHeight: row.lineHeight,
                rowPaddingTop: row.paddingTop,
                messageFontSize: message.fontSize,
                locationFontSize: location.fontSize,
                locationLineHeight: location.lineHeight
            };
        });
        expect(logTypography).toEqual({
            rowFontSize: '12px',
            rowLineHeight: '18px',
            rowPaddingTop: '5px',
            messageFontSize: '12px',
            locationFontSize: '10px',
            locationLineHeight: '15px'
        });
        await expect(compileLog.getByText('missing import ietf-ip', { exact: true })).toBeVisible();
        await expect(compileLog.getByText('unused typedef demo-type', { exact: true })).toBeVisible();
        await expect(compileLog.getByText('libyang validation started', { exact: true })).toBeVisible();
        await expect(compileLog.getByText('ietf-interfaces@2018-02-20.yang:12:7', { exact: true })).toBeVisible();
        await expect(compileLog.getByText('错误 1 · 警告 1', { exact: true })).toBeVisible();
        await expect.poll(() => requestedCompileId).toBe(harness.controller.state.yang.workspace.compileId);
        await expect(page.getByRole('button', { name: /编译诊断/u })).toHaveCount(0);
        await expect(page.getByRole('dialog', { name: '编译诊断' })).toHaveCount(0);

        harness.controller.emitEvent('yang:taskProgress', {
            status: 'success',
            data: {
                taskId: 'e2e-compile-failed-with-diagnostics',
                action: 'compile',
                phase: 'failed',
                completed: 2,
                total: 3,
                percent: 100,
                counts: { compiled: 2, failed: 1 },
                profileId: harness.controller.state.yang.activeWorkspaceProfileId,
                message: 'YANG 编译存在错误，请查看编译日志'
            }
        });
        await expect(page.locator('.yang-task-notification')).toHaveCount(0);
        await expect(page.locator('.nn-toast-error')).toHaveCount(0);

        await expect(compileLog.getByRole('button', { name: '查看源码', exact: true })).toHaveCount(0);
        await expect(
            page.locator('.module-table').getByRole('button', { name: '源码', exact: true }).first()
        ).toBeVisible();

        const logResizer = page.getByRole('separator', { name: '调整模型列表和编译日志高度' });
        await expect(logResizer).toBeVisible();
        await expect(logResizer).toHaveAttribute('aria-orientation', 'horizontal');
        expect(await logResizer.evaluate(element => getComputedStyle(element).cursor)).toBe('row-resize');
        const moduleTable = page.locator('.module-table');
        const logBeforeResize = await compileLog.boundingBox();
        const tableBeforeResize = await moduleTable.boundingBox();
        const valueBeforeResize = Number(await logResizer.getAttribute('aria-valuenow'));
        expect(logBeforeResize).not.toBeNull();
        expect(tableBeforeResize).not.toBeNull();
        expect(valueBeforeResize).toBeGreaterThanOrEqual(140);

        await dragSeparator(page, logResizer, 0, -80);

        await expect
            .poll(async () => (await compileLog.boundingBox())?.height || 0)
            .toBeGreaterThan(logBeforeResize.height + 40);
        await expect
            .poll(async () => Number(await logResizer.getAttribute('aria-valuenow')))
            .toBeGreaterThan(valueBeforeResize);
        await expect
            .poll(async () => (await moduleTable.boundingBox())?.height || 0)
            .toBeLessThan(tableBeforeResize.height - 40);

        await compileLog.getByRole('tab', { name: '错误', exact: true }).click();
        await expect(compileLog.getByText('missing import ietf-ip', { exact: true })).toBeVisible();
        await expect(compileLog.getByText('ietf-interfaces@2018-02-20.yang 编译失败', { exact: true })).toBeVisible();
        await expect(compileLog.locator('.compile-log-list').getByText(/编译成功$/u)).toHaveCount(0);
        await expect(compileLog.getByText('unused typedef demo-type', { exact: true })).toHaveCount(0);
        await expect(compileLog.getByText('libyang validation started', { exact: true })).toHaveCount(0);

        await compileLog.getByRole('tab', { name: '警告', exact: true }).click();
        await expect(compileLog.getByText('missing import ietf-ip', { exact: true })).toHaveCount(0);
        await expect(compileLog.getByText('unused typedef demo-type', { exact: true })).toBeVisible();
        await expect(compileLog.getByText('libyang validation started', { exact: true })).toHaveCount(0);

        await compileLog.getByRole('tab', { name: '信息', exact: true }).click();
        await expect(compileLog.getByText('missing import ietf-ip', { exact: true })).toHaveCount(0);
        await expect(compileLog.getByText('unused typedef demo-type', { exact: true })).toHaveCount(0);
        await expect(compileLog.getByText('libyang validation started', { exact: true })).toBeVisible();
        await expect(compileLog.getByText('ietf-yang-types@2013-07-15.yang 编译成功', { exact: true })).toBeVisible();
        expect(
            await compileLog.locator('.compile-log-list').evaluate(element => getComputedStyle(element).overflowY)
        ).toBe('auto');
    });

    test('keeps a Windows compiler failure reason on the first log page', async ({ page }) => {
        const windowsDiagnostic = {
            severity: 'error',
            code: 'LIBYANG_SCHEMA_FAILED',
            message: "Unknown option '--schema-list' from the bundled Windows schema helper",
            source: 'C:\\NetNexus\\workspace\\broken-module.yang',
            line: 12,
            column: 7,
            authoritative: true
        };
        const failedModules = Array.from({ length: 1000 }, (_value, index) => {
            const suffix = String(index + 1).padStart(4, '0');
            return {
                id: `windows-failed-${suffix}`,
                hash: `windows-failed-${suffix}`,
                name: `windows-failed-${suffix}`,
                revision: '2026-07-20',
                fileName: `windows-failed-${suffix}.yang`,
                filePath: `C:\\NetNexus\\workspace\\windows-failed-${suffix}.yang`,
                isLocal: true,
                compiled: false,
                compileStatus: 'failed',
                status: 'failed'
            };
        });
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.registry.getDiagnostics') {
                return { status: 'error', msg: '模拟 Windows Worker 已退出，独立诊断查询不可用' };
            }
            const response = await originalControllerCall(method, ...args);
            if (method !== 'yang.registry.getWorkspace' || response?.status !== 'success') return response;
            return {
                ...response,
                data: {
                    ...response.data,
                    compileId: 'windows-failed-compile',
                    compiledAt: '2026-07-20T12:00:00.000Z',
                    success: false,
                    diagnostics: [windowsDiagnostic],
                    modules: failedModules,
                    summary: {
                        ...(response.data.summary || {}),
                        moduleCount: failedModules.length,
                        compiledFiles: 0,
                        failedFiles: failedModules.length,
                        errors: 1,
                        warnings: 0
                    }
                }
            };
        };

        await page.goto('/#/yang/yang-modules');

        const compileLog = page.getByTestId('yang-compile-log-panel');
        const firstLogRow = compileLog.locator('.compile-log-row').first();
        await expect(firstLogRow).toContainText("Unknown option '--schema-list'");
        await expect(firstLogRow).toContainText('broken-module.yang:12:7');
        await expect(compileLog.getByTestId('yang-compile-log-pagination')).toContainText('第 1 / 11 页');
        await expect(compileLog.getByText('windows-failed-0001.yang 编译失败', { exact: true })).toBeVisible();

        harness.controller.emitEvent('yang:taskProgress', {
            status: 'success',
            data: {
                taskId: 'windows-failed-task',
                action: 'compile',
                phase: 'failed',
                percent: 100,
                profileId: 'e2e-netconf-profile',
                message: 'YANG 编译失败',
                error: {
                    code: 'LIBYANG_SCHEMA_EXECUTION_FAILED',
                    message: 'Cannot load libyang.dll required by the bundled Windows schema helper'
                }
            }
        });
        await expect(firstLogRow).toContainText('Cannot load libyang.dll');
        await expect(firstLogRow).not.toContainText('YANG 编译失败');
    });

    test('batches 1000 live compile logs and keeps height dragging bounded', async ({ page }) => {
        test.setTimeout(60_000);
        const taskId = 'e2e-bulk-live-compile';
        let compileRequest = null;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.registry.compile') {
                compileRequest = JSON.parse(JSON.stringify(args[0]));
                return { status: 'success', data: { taskId } };
            }
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-modules');
        await page
            .getByRole('checkbox', { name: '选择全部筛选结果', exact: true })
            .evaluate(element => element.click());
        await page.getByRole('button', { name: '编译所选', exact: true }).click();
        await expect.poll(() => compileRequest?.moduleIds?.length || 0).toBe(2);

        await page.evaluate(
            ({ progressTaskId }) => {
                for (let completed = 1; completed <= 1005; completed += 1) {
                    window.__featureE2eEmit?.('yang:taskProgress', {
                        status: 'success',
                        data: {
                            taskId: progressTaskId,
                            action: 'compile',
                            phase: 'parsing',
                            currentHash: `bulk-compile-${completed}`,
                            currentFile: `bulk-compile-${completed}.yang`,
                            fileStatus: 'parsed',
                            completed,
                            total: 1005,
                            percent: Math.round((completed / 1005) * 55),
                            profileId: 'e2e-netconf-profile'
                        }
                    });
                }
            },
            { progressTaskId: taskId }
        );

        const compileLog = page.getByTestId('yang-compile-log-panel');
        const logRows = compileLog.locator('.compile-log-row');
        await expect(compileLog.getByText('1005/1005 · 55%', { exact: true })).toBeVisible();
        await expect(
            compileLog.getByText('bulk-compile-1005.yang 解析完成 · 1005/1005', { exact: true })
        ).toBeVisible();
        await expect(logRows).toHaveCount(100);

        const pagination = page.getByTestId('yang-compile-log-pagination');
        await expect(pagination).toContainText('第 1 / 11 页');
        const allLogIds = [];
        for (let pageNumber = 1; pageNumber <= 11; pageNumber += 1) {
            await expect(pagination).toContainText(`第 ${pageNumber} / 11 页`);
            const pageLogIds = await logRows.evaluateAll(elements => elements.map(element => element.dataset.logId));
            expect(pageLogIds.length).toBeLessThanOrEqual(100);
            expect(pageLogIds.every(Boolean)).toBe(true);
            allLogIds.push(...pageLogIds);
            if (pageNumber < 11) {
                await pagination.getByRole('button', { name: '编译日志下一页', exact: true }).click();
            }
        }
        expect(allLogIds).toHaveLength(1009);
        expect(new Set(allLogIds).size).toBe(allLogIds.length);

        const logResizer = page.getByRole('separator', { name: '调整模型列表和编译日志高度' });
        const logBeforeResize = await compileLog.boundingBox();
        const resizePreview = await logResizer.evaluate(async separator => {
            const layout = separator.closest('.module-results-layout');
            const tableContent = layout.querySelector('.module-table .nn-table-content');
            const logList = layout.querySelector('.compile-log-list');
            const bounds = separator.getBoundingClientRect();
            const pointerId = 73;
            const startX = bounds.x + bounds.width / 2;
            const startY = bounds.y + bounds.height / 2;
            const ariaBefore = separator.getAttribute('aria-valuenow');
            const cssBefore = layout.style.getPropertyValue('--compile-log-preview-height');
            const originalRequestAnimationFrame = window.requestAnimationFrame;
            const originalCancelAnimationFrame = window.cancelAnimationFrame;
            const queuedFrames = new Map();
            let nextFrameId = 1;
            window.requestAnimationFrame = callback => {
                const frameId = nextFrameId++;
                queuedFrames.set(frameId, callback);
                return frameId;
            };
            window.cancelAnimationFrame = frameId => queuedFrames.delete(frameId);
            try {
                separator.dispatchEvent(
                    new PointerEvent('pointerdown', {
                        bubbles: true,
                        button: 0,
                        clientX: startX,
                        clientY: startY,
                        isPrimary: true,
                        pointerId
                    })
                );
                for (let index = 1; index <= 100; index += 1) {
                    document.dispatchEvent(
                        new PointerEvent('pointermove', {
                            bubbles: true,
                            button: 0,
                            clientX: startX,
                            clientY: startY - index,
                            isPrimary: true,
                            pointerId
                        })
                    );
                }
                await Promise.resolve();
                const queuedFrameCount = queuedFrames.size;
                const callbacks = [...queuedFrames.values()];
                queuedFrames.clear();
                callbacks.forEach(callback => callback(performance.now()));
                const result = {
                    ariaBefore,
                    ariaDuring: separator.getAttribute('aria-valuenow'),
                    cssBefore,
                    cssDuring: layout.style.getPropertyValue('--compile-log-preview-height'),
                    queuedFrameCount,
                    tableVisibility: getComputedStyle(tableContent).contentVisibility,
                    logVisibility: getComputedStyle(logList).contentVisibility
                };
                document.dispatchEvent(
                    new PointerEvent('pointerup', {
                        bubbles: true,
                        button: 0,
                        clientX: startX,
                        clientY: startY - 100,
                        isPrimary: true,
                        pointerId
                    })
                );
                return result;
            } finally {
                window.requestAnimationFrame = originalRequestAnimationFrame;
                window.cancelAnimationFrame = originalCancelAnimationFrame;
            }
        });
        expect(resizePreview.queuedFrameCount).toBe(1);
        expect(resizePreview.ariaDuring).toBe(resizePreview.ariaBefore);
        expect(resizePreview.cssDuring).not.toBe(resizePreview.cssBefore);
        expect(resizePreview.tableVisibility).toBe('hidden');
        expect(resizePreview.logVisibility).toBe('hidden');
        await expect
            .poll(async () => Number(await logResizer.getAttribute('aria-valuenow')))
            .toBeGreaterThan(Number(resizePreview.ariaBefore));
        await expect
            .poll(async () => (await compileLog.boundingBox())?.height || 0)
            .toBeGreaterThan(logBeforeResize.height + 40);
        await expect(logRows).toHaveCount(9);
    });

    test('keeps the model tab state without reloading when returning', async ({ page }) => {
        const modelReadMethods = new Set([
            'yang.registry.listModules',
            'yang.registry.getWorkspace',
            'yang.registry.getDiagnostics',
            'yang.registry.getCompilerStatus',
            'yang.netconf.listProfiles',
            'yang.netconf.getSessionState'
        ]);
        const modelReads = [];
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (modelReadMethods.has(method)) modelReads.push(method);
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-modules');
        const modelSearch = page.getByPlaceholder('模块名 / namespace / revision');
        await expect(page.getByText('ietf-interfaces', { exact: true })).toBeVisible();
        await modelSearch.fill('ietf-interfaces');
        const interfaceRow = page.getByRole('row').filter({ hasText: 'ietf-interfaces' });
        await interfaceRow.getByRole('checkbox').evaluate(element => element.click());
        await expect(interfaceRow.getByRole('checkbox')).toBeChecked();

        await page.getByRole('tab', { name: '连接设置', exact: true }).click();
        await expect(page.locator('.yang-connection-page:visible')).toBeVisible();
        await page.waitForTimeout(150);
        modelReads.length = 0;
        await page.getByRole('tab', { name: '模型列表', exact: true }).click();
        await expect(page.locator('.yang-modules-page:visible')).toBeVisible();
        await page.waitForTimeout(150);

        expect(modelReads).toEqual([]);
        await expect(modelSearch).toHaveValue('ietf-interfaces');
        await expect(interfaceRow.getByRole('checkbox')).toBeChecked();
    });

    test('keeps the current Profile context and model filters responsive', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/#/yang/yang-modules');

        const currentProfile = page.getByTestId('yang-modules-current-profile');
        const modelSearch = page.getByPlaceholder('模块名 / namespace / revision');
        const statusSelect = page.getByTestId('yang-modules-status-select');
        await expect(currentProfile).toBeVisible();
        await expect(page.getByRole('combobox', { name: 'Profile' })).toHaveCount(0);
        await expect(modelSearch).toBeVisible();
        await expect(statusSelect).toBeVisible();

        const wideBefore = await moduleToolbarGeometry(page);
        expect(
            Math.abs(
                wideBefore.currentProfile.y +
                    wideBefore.currentProfile.height / 2 -
                    (wideBefore.actions.y + wideBefore.actions.height / 2)
            )
        ).toBeLessThanOrEqual(1);
        expect(wideBefore.currentProfile.right).toBeLessThanOrEqual(wideBefore.actions.x + 1);
        expect(wideBefore.actions.bottom).toBeLessThanOrEqual(wideBefore.selectionRow.y + 1);
        expect(wideBefore.selectionCheckbox.right).toBeLessThanOrEqual(wideBefore.search.x + 1);
        expect(wideBefore.search.right).toBeLessThanOrEqual(wideBefore.status.x + 1);
        expect(wideBefore.search.width).toBeLessThanOrEqual(341);
        expect(wideBefore.status.width).toBeLessThanOrEqual(151);
        expect(wideBefore.pageHasHorizontalOverflow).toBe(false);
        expect(wideBefore.table.bottom).toBeLessThanOrEqual(wideBefore.compileLog.y + 1);
        expect(wideBefore.compileLog.bottom).toBeLessThanOrEqual(wideBefore.body.bottom + 1);
        expect(wideBefore.compileLog.height).toBeGreaterThanOrEqual(159);
        [...wideBefore.controls, ...wideBefore.actionButtons].forEach(bounds => {
            expect(bounds.x).toBeGreaterThanOrEqual(wideBefore.body.x - 1);
            expect(bounds.right).toBeLessThanOrEqual(wideBefore.body.right + 1);
        });
        for (const action of ['获取设备列表', '导入文件', '导入目录', '编译所选', '清空工作区', '刷新']) {
            await expect(
                page.getByTestId('yang-modules-actions').getByRole('button', { name: action, exact: true })
            ).toBeVisible();
        }
        await expect(page.getByRole('button', { name: /编译诊断/u })).toHaveCount(0);

        await modelSearch.fill('ietf-interfaces');
        await statusSelect.click();
        await page.getByRole('option', { name: '已编译', exact: true }).click();
        const interfaceRow = page.getByRole('row').filter({ hasText: 'ietf-interfaces' });
        await interfaceRow.getByRole('checkbox').evaluate(element => element.click());
        await expect(page.getByRole('button', { name: '编译所选', exact: true })).toBeEnabled();

        const wideAfter = await moduleToolbarGeometry(page);
        expect(wideAfter.actionButtons).toHaveLength(wideBefore.actionButtons.length);
        wideAfter.actionButtons.forEach((bounds, index) => {
            const before = wideBefore.actionButtons[index];
            expect(Math.abs(bounds.x - before.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(bounds.y - before.y)).toBeLessThanOrEqual(1);
            expect(Math.abs(bounds.width - before.width)).toBeLessThanOrEqual(1);
            expect(Math.abs(bounds.height - before.height)).toBeLessThanOrEqual(1);
        });

        await page.setViewportSize({ width: 900, height: 900 });
        await expect(currentProfile).toBeVisible();
        const narrow = await moduleToolbarGeometry(page);
        expect(narrow.currentProfile.y).toBeGreaterThanOrEqual(narrow.toolbar.y - 1);
        expect(narrow.actions.y).toBeGreaterThanOrEqual(narrow.toolbar.y - 1);
        expect(narrow.actions.bottom).toBeLessThanOrEqual(narrow.toolbar.bottom + 1);
        expect(narrow.toolbar.bottom).toBeLessThanOrEqual(narrow.selectionRow.y + 1);
        expect(narrow.pageHasHorizontalOverflow).toBe(false);
        expect(narrow.table.bottom).toBeLessThanOrEqual(narrow.compileLog.y + 1);
        expect(narrow.compileLog.bottom).toBeLessThanOrEqual(narrow.body.bottom + 1);
        [...narrow.controls, ...narrow.actionButtons].forEach(bounds => {
            expect(bounds.x).toBeGreaterThanOrEqual(narrow.body.x - 1);
            expect(bounds.right).toBeLessThanOrEqual(narrow.body.right + 1);
        });
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

    test('clears only the active Profile local models and keeps device inventory available', async ({ page }) => {
        const primaryProfileId = 'e2e-netconf-profile';
        const backupProfileId = 'e2e-netconf-profile-2';
        const backupCompile = await harness.controller.call('yang.registry.compile', {
            profileId: backupProfileId
        });
        expect(backupCompile.status).toBe('success');
        await harness.controller.call('yang.registry.importFiles', { profileId: primaryProfileId });

        const seededDiagnostic = {
            id: 'clear-workspace-warning',
            severity: 'warning',
            module: 'ietf-interfaces',
            message: '清空工作区隔离测试诊断'
        };
        harness.controller.state.yang.diagnostics = [seededDiagnostic];
        harness.controller.state.yang.workspace = null;
        await harness.controller.call('yang.registry.getWorkspace', { profileId: primaryProfileId });
        const backupWorkspaceBefore = JSON.parse(
            JSON.stringify(harness.controller.state.yang.profileWorkspaces[backupProfileId])
        );
        let clearRequest = null;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.registry.clearWorkspace') {
                clearRequest = JSON.parse(JSON.stringify(args[0] || {}));
            }
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-modules');
        const modulesPage = page.locator('.yang-modules-page:visible');
        const moduleTable = modulesPage.locator('.module-table');
        const compileLog = modulesPage.getByTestId('yang-compile-log-panel');
        const clearButton = modulesPage
            .getByTestId('yang-modules-actions')
            .getByRole('button', { name: '清空工作区', exact: true });
        const interfacesRow = moduleTable.getByRole('row').filter({ hasText: 'ietf-interfaces' });

        await expect(clearButton).toBeEnabled();
        await expect(interfacesRow.getByText('已编译', { exact: true })).toHaveCount(2);
        await expect(moduleTable.getByText('netnexus-demo', { exact: true })).toBeVisible();
        await expect(compileLog.getByText('清空工作区隔离测试诊断', { exact: true })).toBeVisible();
        await clearButton.click();

        const confirmationDialog = page.getByRole('dialog', { name: '清空 YANG 工作区' });
        await expect(confirmationDialog).toBeVisible();
        await expect(confirmationDialog).toContainText('永久删除');
        await expect(confirmationDialog).toContainText('外部导入目录中的原始文件不会被删除');
        await expect(confirmationDialog).toContainText('不可恢复');
        await confirmationDialog.getByRole('button', { name: '清空', exact: true }).click();

        await expect.poll(() => clearRequest).toEqual({ profileId: primaryProfileId });
        await expect(confirmationDialog).toBeHidden();
        await expect(moduleTable.getByText('ietf-interfaces', { exact: true })).toHaveCount(0);
        await expect(moduleTable.getByText('ietf-yang-types', { exact: true })).toHaveCount(0);
        await expect(moduleTable.getByText('netnexus-demo', { exact: true })).toHaveCount(0);
        await expect(compileLog.getByText('尚未编译', { exact: true })).toBeVisible();
        await expect(compileLog.getByText('执行“编译所选”后在这里查看编译日志', { exact: true })).toBeVisible();
        await expect(compileLog.getByText('清空工作区隔离测试诊断', { exact: true })).toHaveCount(0);
        await expect(compileLog.locator('.compile-log-row')).toHaveCount(0);
        await expect(clearButton).toBeDisabled();
        await expect(
            page.getByRole('status').filter({ hasText: 'YANG 工作区已清空，本地托管副本已删除' })
        ).toBeVisible();
        await expect.poll(() => harness.controller.state.yang.workspace?.compileId || '').toBe('');
        expect(harness.controller.state.yang.compiledModuleIds).toEqual([]);
        expect(harness.controller.state.yang.schemaTree).toBeNull();
        expect(harness.controller.state.yang.diagnostics).toEqual([]);
        expect(harness.controller.state.yang.modules.filter(module => module.isLocal)).toEqual([]);
        expect(harness.controller.state.yang.profileWorkspaces[backupProfileId]).toEqual(backupWorkspaceBefore);

        const advertisedModules = harness.controller.state.yang.modules.filter(module => module.deviceAdvertised);
        expect(advertisedModules.map(module => module.name)).toEqual(
            expect.arrayContaining(['ietf-interfaces', 'ietf-yang-types'])
        );
        expect(advertisedModules.every(module => module.isLocal === false)).toBe(true);

        await modulesPage.getByRole('button', { name: '获取设备列表', exact: true }).click();
        const deviceDialog = page.getByRole('dialog', { name: '设备 YANG 模型' });
        const advertisedInterfacesRow = deviceDialog
            .getByRole('row')
            .filter({ hasText: 'ietf-interfaces@2018-02-20.yang' });
        await expect(advertisedInterfacesRow.getByRole('checkbox')).toBeEnabled();
        await advertisedInterfacesRow.getByRole('checkbox').evaluate(element => element.click());
        await deviceDialog.getByRole('button', { name: '下载所选 (1)', exact: true }).click();
        await expect(deviceDialog).toBeHidden();
        await expect(moduleTable.getByText('ietf-interfaces', { exact: true })).toBeVisible();
        await expect(moduleTable.getByText('ietf-yang-types', { exact: true })).toBeVisible();
        await expect(moduleTable.getByText('netnexus-demo', { exact: true })).toHaveCount(0);

        await page.goto('/#/yang/yang-workspace');
        const workspaceClearButton = page
            .locator('.yang-workspace-page:visible')
            .getByRole('button', { name: '清空', exact: true });
        await expect(workspaceClearButton).toBeEnabled();
        await expect(schemaTreeItems(page)).toHaveCount(0);
        await expect(page.getByText('暂无 Schema 节点', { exact: true })).toBeVisible();

        const backupWorkspaceAfter = await originalControllerCall('yang.registry.getWorkspace', {
            profileId: backupProfileId
        });
        expect(backupWorkspaceAfter.status).toBe('success');
        expect(backupWorkspaceAfter.data.compileId).toBe(backupWorkspaceBefore.workspace.compileId);
        expect(backupWorkspaceAfter.data.schemaTree).toEqual(backupWorkspaceBefore.workspace.schemaTree);
        const backupModulesAfter = await originalControllerCall('yang.registry.listModules', {
            profileId: backupProfileId
        });
        expect(backupModulesAfter.data.modules).toEqual(backupWorkspaceBefore.modules);
        expect(backupModulesAfter.data.modules).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'vendor-system', isLocal: true, compiled: true })])
        );
    });

    test('selects device models in a dialog and downloads their dependency closure', async ({ page }) => {
        let downloadRequest = null;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.netconf.downloadModules') {
                downloadRequest = JSON.parse(JSON.stringify(args[0]));
            }
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-modules');
        const modulesCard = page.locator('.modules-card');
        const moduleTable = modulesCard.locator('.module-table');
        await expect(moduleTable.getByText('ietf-system', { exact: true })).toHaveCount(0);
        await expect(modulesCard.getByRole('button', { name: /^下载所选/u })).toHaveCount(0);
        await expect(moduleTable.getByRole('button', { name: '下载', exact: true })).toHaveCount(0);

        const openDeviceModels = modulesCard.getByRole('button', { name: '获取设备列表', exact: true });
        await openDeviceModels.click();
        const deviceDialog = page.getByRole('dialog', { name: '设备 YANG 模型' });
        await expect(deviceDialog).toBeVisible();
        await expect(deviceDialog.getByText('依赖会自动下载', { exact: true })).toBeVisible();

        const localTypesRow = deviceDialog.getByRole('row').filter({ hasText: 'ietf-yang-types@2013-07-15.yang' });
        const systemRow = deviceDialog.getByRole('row').filter({ hasText: 'ietf-system@2014-08-06.yang' });
        await expect(localTypesRow.getByText('本地已有', { exact: true })).toBeVisible();
        await expect(localTypesRow.getByRole('checkbox')).toBeDisabled();
        await expect(systemRow.getByRole('checkbox')).toBeEnabled();
        await systemRow.getByRole('checkbox').evaluate(element => element.click());
        await expect(systemRow.getByRole('checkbox')).toBeChecked();

        await deviceDialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(deviceDialog).toBeHidden();
        expect(downloadRequest).toBeNull();

        await openDeviceModels.click();
        await expect(deviceDialog).toBeVisible();
        const refreshedSystemRow = deviceDialog.getByRole('row').filter({ hasText: 'ietf-system@2014-08-06.yang' });
        await expect(refreshedSystemRow.getByRole('checkbox')).not.toBeChecked();
        await refreshedSystemRow.getByRole('checkbox').evaluate(element => element.click());
        await deviceDialog.getByRole('button', { name: '下载所选 (1)', exact: true }).click();

        await expect(deviceDialog).toBeHidden();
        expect(downloadRequest).toMatchObject({
            profileId: 'e2e-netconf-profile',
            includeDependencies: true,
            modules: [{ name: 'ietf-system', revision: '2014-08-06' }]
        });
        expect(downloadRequest).not.toHaveProperty('snapshotId');
        await expect(moduleTable.getByText('ietf-system', { exact: true })).toBeVisible();
        await expect(moduleTable.getByText('ietf-netconf-monitoring', { exact: true })).toBeVisible();
        await expect(moduleTable.getByRole('button', { name: '下载', exact: true })).toHaveCount(0);
    });

    test('keeps the 1000-model download dialog bounded and draggable while progress updates', async ({ page }) => {
        const bulkModules = Array.from({ length: 1000 }, (_value, index) => ({
            name: `bulk-module-${String(index + 1).padStart(4, '0')}`,
            revision: '2026-07-19',
            namespace: `urn:netnexus:e2e:bulk:${index + 1}`,
            format: 'yang',
            features: []
        }));
        let downloadRequest = null;
        const taskId = 'e2e-bulk-download';
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.netconf.discoverModules') {
                return { status: 'success', data: { modules: bulkModules, source: 'ietf-yang-library' } };
            }
            if (method === 'yang.netconf.downloadModules') {
                downloadRequest = JSON.parse(JSON.stringify(args[0]));
                return { status: 'success', data: { taskId } };
            }
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-modules');
        await page.getByRole('button', { name: '获取设备列表', exact: true }).click();
        const deviceDialog = page.getByRole('dialog', { name: '设备 YANG 模型' });
        await expect(deviceDialog).toContainText('设备 1000');
        await expect(deviceDialog.locator('.device-module-table tbody .nn-table-row')).toHaveCount(50);
        await expect(deviceDialog.locator('.nn-pagination-page-count')).toHaveText('第 1 / 20 页');

        await deviceDialog
            .getByRole('checkbox', { name: '选择全部筛选结果中未下载的模型', exact: true })
            .evaluate(element => element.click());
        await expect(deviceDialog.getByRole('button', { name: '下载所选 (1000)', exact: true })).toBeEnabled();
        await deviceDialog.getByRole('button', { name: '下载所选 (1000)', exact: true }).click();
        expect(downloadRequest.modules).toHaveLength(1000);

        await page.evaluate(
            ({ progressTaskId }) => {
                for (let completed = 1; completed <= 20; completed += 1) {
                    window.__featureE2eEmit?.('yang:taskProgress', {
                        status: 'success',
                        data: {
                            taskId: progressTaskId,
                            action: 'download',
                            phase: 'downloading',
                            completed,
                            total: 1000,
                            percent: completed / 10,
                            profileId: 'e2e-netconf-profile'
                        }
                    });
                }
            },
            { progressTaskId: taskId }
        );
        await expect(deviceDialog).toContainText('20/1000');
        await expect(deviceDialog.locator('.device-module-table tbody .nn-table-row')).toHaveCount(50);

        const header = deviceDialog.locator('.nn-modal-header');
        const before = await deviceDialog.boundingBox();
        const headerBox = await header.boundingBox();
        expect(before).not.toBeNull();
        expect(headerBox).not.toBeNull();
        await page.mouse.move(headerBox.x + headerBox.width / 2, headerBox.y + headerBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(headerBox.x + headerBox.width / 2 + 80, headerBox.y + headerBox.height / 2, {
            steps: 24
        });
        await page.mouse.up();
        await expect.poll(async () => (await deviceDialog.boundingBox())?.x).toBeGreaterThan(before.x + 10);
    });

    test('keeps successful models when an initial-password error stops device download', async ({ page }) => {
        const taskId = 'e2e-partial-device-download';
        let downloadResult = null;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method !== 'yang.netconf.downloadModules') return originalControllerCall(method, ...args);

            const request = args[0] || {};
            const system = harness.controller.state.yang.modules.find(module => module.name === 'ietf-system');
            system.isLocal = true;
            system.source = 'download';
            system.status = 'downloaded';
            system.downloadStatus = 'downloaded';
            system.fileName = `${system.name}@${system.revision}.yang`;
            system.filePath = `/tmp/netnexus-e2e/yang/${system.fileName}`;
            system.contentHash = `e2e-${system.id}`;
            system.compileStatus = 'pending';
            system.compiled = false;
            harness.controller.state.yang.workspace = null;

            const failed = [
                {
                    name: 'ietf-netconf-monitoring',
                    revision: '2010-10-04',
                    code: 'NETCONF_INITIAL_PASSWORD_CHANGE_REQUIRED',
                    error: '设备要求先修改初始密码；已停止后续下载，请通过 STelnet 或 Console 修改密码后重试'
                }
            ];
            downloadResult = {
                profileId: request.profileId,
                downloaded: 1,
                persisted: 1,
                attempted: 2,
                unattempted: 1,
                total: 3,
                partial: true,
                stoppedEarly: true,
                stopReason: failed[0],
                failed
            };
            return { status: 'success', msg: 'YANG下载任务已开始', data: { taskId } };
        };

        await page.goto('/#/yang/yang-modules');
        await page.getByRole('button', { name: '获取设备列表', exact: true }).click();
        const deviceDialog = page.getByRole('dialog', { name: '设备 YANG 模型' });
        const systemRow = deviceDialog.getByRole('row').filter({ hasText: 'ietf-system@2014-08-06.yang' });
        await systemRow.getByRole('checkbox').evaluate(element => element.click());
        await deviceDialog.getByRole('button', { name: '下载所选 (1)', exact: true }).click();

        const emitTaskProgress = data =>
            page.evaluate(
                payload => window.__featureE2eEmit?.('yang:taskProgress', { status: 'success', data: payload }),
                data
            );
        await emitTaskProgress({
            taskId,
            action: 'download',
            phase: 'importing',
            completed: 2,
            total: 3,
            percent: 99,
            counts: { downloaded: 1, failed: 1 },
            profileId: downloadResult.profileId,
            message: '已保存 1 个模型，1 个失败，1 个未尝试，请先修改设备初始密码后重试'
        });
        await emitTaskProgress({
            taskId,
            action: 'download',
            phase: 'completed',
            percent: 100,
            profileId: downloadResult.profileId,
            result: downloadResult
        });

        await expect(page.locator('.yang-task-notification')).toHaveCount(0);
        await expect(deviceDialog).toBeVisible();
        await expect(deviceDialog.getByText('部分模型或依赖下载失败', { exact: true })).toBeVisible();
        await expect(deviceDialog).toContainText('ietf-netconf-monitoring：设备要求先修改初始密码');
        await expect(systemRow.getByText('本地已有', { exact: true })).toBeVisible();
        await expect(systemRow.getByRole('checkbox')).toBeDisabled();
        const failedDependencyRow = deviceDialog
            .getByRole('row')
            .filter({ hasText: 'ietf-netconf-monitoring@2010-10-04.yang' });
        await expect(failedDependencyRow.getByText('待下载', { exact: true })).toBeVisible();
        await expect(failedDependencyRow.getByRole('checkbox')).toBeEnabled();
        await expect(page.locator('.nn-toast-warning, .nn-toast-error')).toHaveCount(0);

        await deviceDialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(page.locator('.module-table').getByText('ietf-system', { exact: true })).toBeVisible();
    });

    test('selects and compiles every filtered model across pages', async ({ page }) => {
        const additionalModules = Array.from({ length: 74 }, (_value, index) => {
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
        const moduleRows = moduleTable.locator('tbody .nn-table-row');
        const modulePagination = moduleTable.getByRole('navigation', { name: '表格分页' });
        await expect(modulePagination.locator('.nn-pagination-total')).toHaveText('共 76 个模型');
        await expect(modulePagination.locator('.nn-pagination-page-count')).toHaveText('第 1 / 2 页');
        await expect(moduleTable.getByRole('columnheader', { name: '来源', exact: true })).toHaveCount(0);

        const lastAdditionalModule = page.getByText('bulk-local-74', { exact: true });
        await expect(lastAdditionalModule).toHaveCount(0);
        await modulePagination.getByRole('button', { name: '下一页', exact: true }).click();
        await expect(modulePagination.locator('.nn-pagination-page-count')).toHaveText('第 2 / 2 页');
        await expect(moduleRows).toHaveCount(26);
        await expect(lastAdditionalModule).toBeVisible();

        const statusSelect = page.getByTestId('yang-modules-status-select');
        await expect(statusSelect).toHaveCount(1);
        await statusSelect.click();
        await page.getByRole('option', { name: '全部状态', exact: true }).click();

        const expectedLocalNames = harness.controller.state.yang.modules
            .filter(module => module.isLocal)
            .map(module => module.name)
            .sort();
        await expect(page.locator('.selection-meta')).toHaveCount(0);
        await expect(page.getByText('仅本地模型可参与编译', { exact: true })).toHaveCount(0);

        const selectFiltered = page.getByRole('checkbox', { name: '选择全部筛选结果' });
        await selectFiltered.evaluate(element => element.click());
        await expect(selectFiltered).toBeChecked();
        await expect(
            moduleTable.getByRole('row').filter({ hasText: 'bulk-local-74' }).getByRole('checkbox')
        ).toBeChecked();

        await modulePagination.getByRole('button', { name: '上一页', exact: true }).click();
        await expect(modulePagination.locator('.nn-pagination-page-count')).toHaveText('第 1 / 2 页');
        await expect(moduleRows).toHaveCount(50);
        expect(await moduleRows.getByRole('checkbox').evaluateAll(inputs => inputs.every(input => input.checked))).toBe(
            true
        );

        await page.getByRole('button', { name: '编译所选', exact: true }).click();
        await expect.poll(() => compileRequest?.moduleIds?.length || 0).toBe(expectedLocalNames.length);
        expect(compileRequest.moduleIds.map(module => module.name).sort()).toEqual(expectedLocalNames);
    });

    test('imports a local model without clearing the active compilation', async ({ page }) => {
        await page.goto('/#/yang/yang-modules');
        const compileLog = page.getByTestId('yang-compile-log-panel');
        await expect(compileLog.getByText('ietf-yang-types@2013-07-15.yang 编译成功', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: '导入文件' }).click();
        await expect(page.getByText('netnexus-demo', { exact: true })).toBeVisible();
        const importedRow = page.locator('.module-table').getByRole('row').filter({ hasText: 'netnexus-demo' });
        await expect(importedRow.getByText('未编译', { exact: true })).toBeVisible();
        await expect(compileLog.getByText('编译成功', { exact: true }).first()).toBeVisible();
        await expect(compileLog.getByText('ietf-yang-types@2013-07-15.yang 编译成功', { exact: true })).toBeVisible();
        await expect(page.locator('.yang-task-notification')).toHaveCount(0);
    });

    test('shows save and validation feedback as floating alerts without resizing the page', async ({ page }) => {
        await page.goto('/#/yang/yang-connection');
        const editor = page.locator('.profile-editor-card');
        const initialGeometry = await connectionGeometry(page);

        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.getByRole('status').filter({ hasText: '连接 Profile 已保存' })).toBeVisible();
        expectSameGeometry(initialGeometry, await connectionGeometry(page));

        await page.getByRole('button', { name: '新建', exact: true }).click();
        const draftGeometry = await connectionGeometry(page);
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.getByRole('alert').filter({ hasText: '连接设置不完整' })).toBeVisible();
        await expect(editor.locator('.nn-alert')).toHaveCount(0);
        expectSameGeometry(draftGeometry, await connectionGeometry(page));
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
        await expect(operationPanel.locator('.rpc-result')).toContainText('<rpc-reply');
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

    test('coalesces rich XML scrolling onto compositor content layers', async ({ page }) => {
        await page.goto('/#/yang/yang-workspace');
        const operationPanel = page.locator('.workspace-operation-panel');
        const requestCard = operationPanel.locator('.operation-form-card');
        const requestEditor = requestCard.locator('.rpc-request-preview');
        const requestInput = requestEditor.locator('textarea[aria-label="RPC 请求 XML"]');
        const validateButton = requestCard.getByRole('button', { name: '验证', exact: true });
        const scrollStressRpc = [
            '<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="scroll-stress">',
            '  <get>',
            '    <filter type="subtree">',
            ...Array.from(
                { length: 100 },
                (_value, index) =>
                    `      <probe-${index + 1}>${'scroll-compositor-probe-'.repeat(10)}${index + 1}</probe-${index + 1}>`
            ),
            '    </filter>',
            '  </get>',
            '</rpc>'
        ].join('\n');

        await requestInput.fill(scrollStressRpc);
        await expect(requestEditor.locator('[data-xml-line-number]')).toHaveCount(scrollStressRpc.split('\n').length);
        await expect(requestEditor.locator('[data-xml-highlight-content]')).toBeVisible();
        await expect(requestEditor.locator('[data-xml-line-number-content]')).toBeVisible();
        await expect(requestEditor.locator('[data-xml-diagnostics-layer]')).toHaveAttribute('role', 'status');
        await expect(requestEditor.locator('[data-xml-diagnostics-content]')).toHaveCount(0);

        const scrollFrame = await requestInput.evaluate(async element => {
            const editor = element.parentElement;
            const readTransform = selector => {
                const content = editor.querySelector(selector);
                const transformValue = getComputedStyle(content).transform;
                const transform =
                    transformValue === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transformValue);
                const normalizeZero = value => (Object.is(value, -0) ? 0 : value);
                return { x: normalizeZero(transform.m41), y: normalizeZero(transform.m42) };
            };
            const readContentTransforms = () => ({
                highlight: readTransform('[data-xml-highlight-content]'),
                lineNumbers: readTransform('[data-xml-line-number-content]')
            });

            element.scrollTop = 0;
            element.scrollLeft = 0;
            element.dispatchEvent(new Event('scroll'));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

            const before = readContentTransforms();
            const maximumTop = element.scrollHeight - element.clientHeight;
            const maximumLeft = element.scrollWidth - element.clientWidth;
            for (let step = 1; step <= 16; step += 1) {
                element.scrollTop = Math.round((maximumTop * step) / 16);
                element.scrollLeft = Math.round((maximumLeft * step) / 16);
                element.dispatchEvent(new Event('scroll'));
            }

            const target = { top: element.scrollTop, left: element.scrollLeft };
            const synchronous = readContentTransforms();
            const viewportScroll = {
                highlight: {
                    top: editor.querySelector('[data-xml-highlight-layer]').scrollTop,
                    left: editor.querySelector('[data-xml-highlight-layer]').scrollLeft
                },
                lineNumbers: {
                    top: editor.querySelector('[data-xml-line-number-gutter]').scrollTop,
                    left: editor.querySelector('[data-xml-line-number-gutter]').scrollLeft
                }
            };
            const nextFrame = await new Promise(resolve =>
                requestAnimationFrame(() => resolve(readContentTransforms()))
            );

            return { before, synchronous, nextFrame, target, maximumTop, maximumLeft, viewportScroll };
        });
        expect(scrollFrame.maximumTop).toBeGreaterThan(0);
        expect(scrollFrame.maximumLeft).toBeGreaterThan(0);
        expect(scrollFrame.synchronous).toEqual(scrollFrame.before);
        expect(scrollFrame.nextFrame).toEqual({
            highlight: { x: -scrollFrame.target.left, y: -scrollFrame.target.top },
            lineNumbers: { x: 0, y: -scrollFrame.target.top }
        });
        expect(scrollFrame.viewportScroll).toEqual({
            highlight: { top: 0, left: 0 },
            lineNumbers: { top: 0, left: 0 }
        });

        const invalidBooleanRpc =
            '<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="scroll-diagnostic">\n' +
            '  <edit-config>\n' +
            '    <target><running/></target>\n' +
            '    <config>\n' +
            '      <interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">\n' +
            '        <interface>\n' +
            '          <name>eth0</name>\n' +
            '          <enabled>not-a-bool</enabled>\n' +
            '        </interface>\n' +
            '      </interfaces>\n' +
            '    </config>\n' +
            '  </edit-config>\n' +
            '</rpc>';
        await requestInput.fill(invalidBooleanRpc);
        await validateButton.click();
        await expect(requestEditor.locator('[data-xml-diagnostic][data-line="8"]')).toBeVisible();
        await expect(requestEditor.locator('[data-xml-diagnostics-content]')).toBeVisible();
        const diagnosticScrollAlignment = await requestInput.evaluate(async element => {
            const editor = element.parentElement;
            element.scrollTop = element.scrollHeight - element.clientHeight;
            element.dispatchEvent(new Event('scroll'));
            const transform = await new Promise(resolve =>
                requestAnimationFrame(() => {
                    const content = editor.querySelector('[data-xml-diagnostics-content]');
                    const transformValue = getComputedStyle(content).transform;
                    resolve(
                        transformValue === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transformValue)
                    );
                })
            );
            return {
                inputTop: element.scrollTop,
                contentY: Object.is(transform.m42, -0) ? 0 : transform.m42,
                viewportTop: editor.querySelector('[data-xml-diagnostics-layer]').scrollTop
            };
        });
        expect(diagnosticScrollAlignment.inputTop).toBeGreaterThan(0);
        expect(diagnosticScrollAlignment.contentY).toBe(-diagnosticScrollAlignment.inputTop);
        expect(diagnosticScrollAlignment.viewportTop).toBe(0);

        await requestInput.fill(invalidBooleanRpc.replace('not-a-bool', 'false'));
        await validateButton.click();
        await expect(requestEditor.locator('[data-xml-diagnostics-layer]')).toHaveAttribute('role', 'status');
        await expect(requestEditor.locator('[data-xml-diagnostics-content]')).toHaveCount(0);
    });

    test('validates, marks, and sends an edited complete RPC', async ({ page }) => {
        const rawRequests = [];
        let forcedValidationError = '';
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.registry.validateRpc' && forcedValidationError) {
                return { status: 'error', msg: forcedValidationError };
            }
            if (method === 'yang.netconf.sendRpc') rawRequests.push(JSON.parse(JSON.stringify(args[0])));
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-workspace');
        const operationPanel = page.locator('.workspace-operation-panel');
        const requestCard = operationPanel.locator('.operation-form-card');
        const requestEditor = requestCard.locator('.rpc-request-preview');
        const requestInput = requestEditor.locator('textarea[aria-label="RPC 请求 XML"]');
        const requestLineNumbers = requestEditor.locator('[data-xml-line-number]');
        const requestDiagnostics = requestEditor.locator('[data-xml-diagnostic]');
        const validateButton = requestCard.getByRole('button', { name: '验证', exact: true });
        const regenerateButton = requestCard.getByRole('button', { name: '参数生成', exact: true });
        const toolbarButtons = requestCard.locator('.request-browser-actions button');

        await expect(requestEditor).toHaveAttribute('data-xml-editor', '');
        await expect(requestInput).toBeEditable();
        const generatedRpc = await requestInput.inputValue();
        expect(generatedRpc).toMatch(/^<rpc\b[\s\S]*<get\b[\s\S]*<\/rpc>$/u);
        await expect(requestEditor.locator('[data-xml-line-number-gutter]')).toBeVisible();
        expect(
            await requestLineNumbers.evaluateAll(elements => elements.map(element => element.dataset.lineNumber))
        ).toEqual(generatedRpc.split('\n').map((_line, index) => String(index + 1)));
        await expectSelectableXmlTextarea(requestInput);
        await expect(regenerateButton).toBeDisabled();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const initialCardBox = await requestCard.boundingBox();
        const initialButtonWidths = await toolbarButtons.evaluateAll(buttons =>
            buttons.map(button => button.getBoundingClientRect().width)
        );

        const malformedRpc =
            '<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="manual-invalid">\n' +
            '  <get>\n' +
            '</rpc>';
        await requestInput.fill(malformedRpc);
        await expect(requestCard.getByText('手工编辑', { exact: true })).toBeVisible();
        await expect(regenerateButton).toBeEnabled();
        await validateButton.click();
        const malformedDiagnostic = requestEditor.locator('[data-xml-diagnostic][data-line="3"]');
        const malformedLineNumber = requestEditor.locator('[data-xml-line-number="3"]');
        await expect(malformedDiagnostic).toBeVisible();
        await expect(malformedDiagnostic).toContainText('XML 格式不合法');
        await expect(malformedLineNumber).toBeVisible();
        await expect(malformedLineNumber).toHaveClass(/xml-code-line-number-error/u);
        const [diagnosticBox, lineNumberBox] = await Promise.all([
            malformedDiagnostic.boundingBox(),
            malformedLineNumber.boundingBox()
        ]);
        expect(
            Math.abs(diagnosticBox.y + diagnosticBox.height / 2 - (lineNumberBox.y + lineNumberBox.height / 2))
        ).toBeLessThanOrEqual(2);
        await expect(requestCard.locator('.request-validation-bar')).toHaveCount(0);
        await expect(requestCard.getByRole('button', { name: /上一个 RPC 问题|下一个 RPC 问题/u })).toHaveCount(0);
        const malformedCardBox = await requestCard.boundingBox();
        expect(Math.abs(malformedCardBox.width - initialCardBox.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(malformedCardBox.height - initialCardBox.height)).toBeLessThanOrEqual(1);
        await operationPanel.getByRole('button', { name: '发送手工 RPC', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '确认发送手工 RPC' })).toHaveCount(0);
        await expect(page.getByRole('dialog', { name: '确认仍然下发 RPC' })).toHaveCount(0);
        await expect(page.getByRole('checkbox', { name: '我已了解本地 YANG 校验未通过，仍要下发该 RPC' })).toHaveCount(
            0
        );
        expect(rawRequests).toHaveLength(0);

        const unsafeRpc =
            '<!DOCTYPE rpc><rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="manual-unsafe"><get/></rpc>';
        await requestInput.fill(unsafeRpc);
        await validateButton.click();
        await expect(requestEditor.locator('[data-xml-diagnostic][data-line="1"]')).toContainText('DOCTYPE 或 ENTITY');

        const multipleInvalidRpc =
            '<rpc xmlns="urn:example:wrong" message-id="">\n' +
            '  <get>\n' +
            '    <!-- NETNEXUS_REQUIRED -->\n' +
            '  </get>\n' +
            '</rpc>';
        await requestInput.fill(multipleInvalidRpc);
        await validateButton.click();
        await expect(requestDiagnostics).toHaveCount(2);
        const rootDiagnostic = requestEditor.locator('[data-xml-diagnostic][data-line="1"]');
        await expect(rootDiagnostic).toContainText('NETCONF base 命名空间');
        await expect(rootDiagnostic).toContainText('message-id');
        await expect(requestEditor.locator('[data-xml-diagnostic][data-line="3"]')).toContainText('NETNEXUS_REQUIRED');

        const invalidBooleanRpc =
            '<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="manual-yang-invalid">\n' +
            '  <edit-config>\n' +
            '    <target><running/></target>\n' +
            '    <config>\n' +
            '      <interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">\n' +
            '        <interface>\n' +
            '          <name>eth0</name>\n' +
            '          <enabled>not-a-bool</enabled>\n' +
            '        </interface>\n' +
            '      </interfaces>\n' +
            '    </config>\n' +
            '  </edit-config>\n' +
            '</rpc>';
        await requestInput.fill(invalidBooleanRpc);
        await validateButton.click();
        const booleanDiagnostic = requestEditor.locator('[data-xml-diagnostic][data-line="8"]');
        await expect(booleanDiagnostic).toBeVisible();
        await expect(booleanDiagnostic).toContainText(/boolean|true|false/u);
        await expect(requestEditor.locator('[data-xml-diagnostics-content]')).toBeVisible();
        await expect(requestEditor.locator('[data-xml-line-number="8"]')).toHaveClass(/xml-code-line-number-error/u);
        await expect(requestInput).toHaveAttribute('aria-invalid', 'true');
        await operationPanel.getByRole('button', { name: '发送手工 RPC', exact: true }).click();
        const overrideConfirmation = page.getByRole('dialog', { name: '确认仍然下发 RPC' });
        const overrideCheckbox = overrideConfirmation.getByRole('checkbox', {
            name: '我已了解本地 YANG 校验未通过，仍要下发该 RPC'
        });
        const overrideAcknowledgement = overrideConfirmation.getByText('我已了解本地 YANG 校验未通过，仍要下发该 RPC', {
            exact: true
        });
        const overrideButton = overrideConfirmation.getByRole('button', { name: '仍然下发', exact: true });
        await expect(overrideConfirmation).toBeVisible();
        await expect(overrideConfirmation).toContainText(/本地 YANG 校验发现 1 处问题/u);
        await expect(overrideConfirmation).toContainText(/boolean|true|false/u);
        await expect(overrideCheckbox).not.toBeChecked();
        await expect(overrideButton).toBeDisabled();
        await overrideConfirmation.getByRole('button', { name: '取消', exact: true }).click();
        await expect(overrideConfirmation).toBeHidden();
        expect(rawRequests).toHaveLength(0);

        await operationPanel.getByRole('button', { name: '发送手工 RPC', exact: true }).click();
        await expect(overrideConfirmation).toBeVisible();
        await expect(overrideCheckbox).not.toBeChecked();
        await overrideAcknowledgement.click();
        await expect(overrideButton).toBeEnabled();
        await overrideButton.click();
        await expect.poll(() => rawRequests.length).toBe(1);
        expect(rawRequests[0]).toMatchObject({ rpc: invalidBooleanRpc });
        await expect(operationPanel.locator('.rpc-result')).toContainText('<ok/>');
        rawRequests.length = 0;

        const unrelatedSchemaRpc = invalidBooleanRpc
            .replace('manual-yang-invalid', 'manual-yang-context-error')
            .replace('not-a-bool', 'false');
        forcedValidationError = 'Not found node "bras-cu-controller" in unrelated BRAS deviation';
        await requestInput.fill(unrelatedSchemaRpc);
        await operationPanel.getByRole('button', { name: '发送手工 RPC', exact: true }).click();
        await expect(overrideConfirmation).toBeVisible();
        await expect(overrideConfirmation).toContainText('本地 YANG 校验无法完成');
        await expect(overrideConfirmation).toContainText('bras-cu-controller');
        await expect(overrideCheckbox).not.toBeChecked();
        await overrideAcknowledgement.click();
        await overrideButton.click();
        await expect.poll(() => rawRequests.length).toBe(1);
        expect(rawRequests[0]).toMatchObject({ rpc: unrelatedSchemaRpc });
        await expect(operationPanel.locator('.rpc-result')).toContainText('<ok/>');
        rawRequests.length = 0;
        forcedValidationError = '';

        const validBooleanRpc = invalidBooleanRpc.replace('not-a-bool', 'false');
        await requestInput.fill(validBooleanRpc);
        await validateButton.click();
        await expect(requestDiagnostics).toHaveCount(0);
        await expect(requestEditor.locator('[data-xml-diagnostics-layer]')).toHaveAttribute('role', 'status');
        await expect(requestEditor.locator('[data-xml-diagnostics-content]')).toHaveCount(0);
        await expect(requestInput).toHaveAttribute('aria-invalid', 'false');

        await regenerateButton.click();
        await expect(requestInput).toHaveValue(generatedRpc);
        await expect(regenerateButton).toBeDisabled();
        await expect(requestCard.getByText('只读', { exact: true })).toBeVisible();

        const validRpc =
            '<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="manual-201">\n' +
            '  <get>\n' +
            '    <filter type="subtree">\n' +
            '      <interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">\n' +
            '        <interface><name>eth0</name></interface>\n' +
            '      </interfaces>\n' +
            '    </filter>\n' +
            '  </get>\n' +
            '</rpc>';
        await requestInput.fill(validRpc);
        await validateButton.click();
        await expect(requestDiagnostics).toHaveCount(0);
        await expect(requestEditor.locator('[data-xml-diagnostics-layer]')).toHaveAttribute('role', 'status');
        await expect(requestEditor.locator('[data-xml-diagnostics-content]')).toHaveCount(0);
        expect(
            await toolbarButtons.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().width))
        ).toEqual(initialButtonWidths);
        const validatedCardBox = await requestCard.boundingBox();
        expect(Math.abs(validatedCardBox.width - initialCardBox.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(validatedCardBox.height - initialCardBox.height)).toBeLessThanOrEqual(1);

        await operationPanel.getByRole('button', { name: '发送手工 RPC', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '确认发送手工 RPC' })).toHaveCount(0);
        await expect(page.getByRole('dialog', { name: '确认仍然下发 RPC' })).toHaveCount(0);
        await expect.poll(() => rawRequests.length).toBe(1);
        expect(rawRequests[0]).toMatchObject({ rpc: validRpc });
        await expect(operationPanel.locator('.rpc-result')).toContainText('<data>');
        await expect(requestInput).toHaveValue(validRpc);
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
        const failedHistoryRequest = drawer.getByTestId('netconf-history-request');
        const failedHistoryReply = drawer.getByTestId('netconf-history-reply');
        await expect(failedHistoryRequest).toHaveValue(new RegExp(failedMessageId, 'u'));
        await expect(failedHistoryRequest).toHaveAttribute('tabindex', '0');
        await expect(failedHistoryReply).toHaveAttribute('tabindex', '0');
        await expect(failedHistoryReply).toHaveValue('mock transport closed');
        await expectXmlTextareaLineNumbers(failedHistoryRequest);
        await expectXmlTextareaLineNumbers(failedHistoryReply);
        await expectSelectableXmlTextarea(failedHistoryRequest);
        await expectSelectableXmlTextarea(failedHistoryReply);

        await historyItems.nth(1).click();
        await expect(historyItems.nth(1)).toContainText('RPC 错误');
        await expect(drawer.getByText(errorMessageId, { exact: true })).toBeVisible();
        const rpcErrorHistoryRequest = drawer.getByTestId('netconf-history-request');
        const rpcErrorHistoryReply = drawer.getByTestId('netconf-history-reply');
        await expect(rpcErrorHistoryRequest).toHaveValue(new RegExp(errorMessageId, 'u'));
        expect(await rpcErrorHistoryRequest.inputValue()).toMatch(
            /^\s*<rpc\b[^>]*message-id="history-error-102"[^>]*>[\s\S]*<get\/>[\s\S]*<\/rpc>\s*$/u
        );
        await expect(rpcErrorHistoryReply).toHaveValue(/<rpc-error>[\s\S]*mock denied/u);
        await expectXmlTextareaLineNumbers(rpcErrorHistoryRequest);
        await expectXmlTextareaLineNumbers(rpcErrorHistoryReply);
        await expect(rpcErrorHistoryReply.locator('xpath=..').locator('[data-xml-token="tag"]').first()).toBeVisible();

        await historyItems.nth(2).click();
        await expect(historyItems.nth(2)).toContainText('成功');
        await expect(drawer.getByTestId('netconf-history-request')).toHaveValue(/<get\/>/u);
        await expect(drawer.getByTestId('netconf-history-reply')).toHaveValue(/<data>/u);
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

    test('terminates one pending NETCONF RPC without disconnecting its Session', async ({ page }) => {
        let resolvePendingOperation;
        let markOperationStarted;
        let capturedOperationId = '';
        let cancelledOperation = null;
        let disconnectCalls = 0;
        const operationStarted = new Promise(resolve => {
            markOperationStarted = resolve;
        });
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.netconf.executeOperation') {
                capturedOperationId = args[0]?.operationId || '';
                markOperationStarted();
                return new Promise(resolve => {
                    resolvePendingOperation = resolve;
                });
            }
            if (method === 'yang.netconf.disconnect') {
                disconnectCalls += 1;
            }
            if (method === 'yang.netconf.cancelOperation') {
                cancelledOperation = args[0];
                resolvePendingOperation?.({
                    status: 'error',
                    msg: 'mock NETCONF RPC cancelled',
                    data: { code: 'WORKER_CANCELLED' }
                });
                return { status: 'success', data: { cancelled: true } };
            }
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-workspace');
        const operationPanel = page.locator('.workspace-operation-panel');
        const executeButton = operationPanel.getByRole('button', { name: '执行 get', exact: true });
        await executeButton.click();
        await operationStarted;

        const terminateButton = operationPanel.getByRole('button', { name: '终止请求', exact: true });
        await expect(terminateButton).toBeVisible();
        await expect(operationPanel.getByText('操作执行中；可只终止本地等待，连接保持不变')).toBeVisible();
        await terminateButton.click();

        await expect(terminateButton).toBeHidden();
        expect(capturedOperationId).toMatch(/^netconf-operation-/u);
        expect(cancelledOperation).toEqual({
            profileId: 'e2e-netconf-profile',
            operationId: capturedOperationId
        });
        expect(disconnectCalls).toBe(0);
        await expect(operationPanel.locator('.operation-result-card')).toContainText('已终止');
        await expect(operationPanel.locator('.rpc-result')).toContainText('NETCONF Session 保持连接');
        await expect(executeButton).toBeEnabled();

        await page.getByRole('button', { name: '执行记录', exact: true }).click();
        const historyDrawer = page.getByRole('dialog', { name: 'NETCONF 执行记录' });
        const historyItems = historyDrawer.getByTestId('netconf-history-item');
        await expect(historyItems).toHaveCount(1);
        await expect(historyItems.first()).toContainText('已终止');
        await expect(historyDrawer.getByTestId('netconf-history-reply')).toHaveValue(/NETCONF Session 保持连接/u);
    });

    test('executes node operations from the Schema tree context menu', async ({ page }) => {
        const capturedRequests = [];
        let forceGeneratedYangFailure = false;
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.registry.validateRpc' && forceGeneratedYangFailure) {
                return {
                    status: 'success',
                    data: {
                        valid: false,
                        diagnostics: [
                            {
                                severity: 'error',
                                code: 'LIBYANG_DATA',
                                message: 'YANG 校验失败：generated edit-config regression',
                                line: 1,
                                column: 1
                            }
                        ],
                        operation: 'edit-config',
                        engine: 'libyang',
                        authoritative: true,
                        performed: true
                    }
                };
            }
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
        await expect(propertyDialog).toBeHidden();
        await interfacesNode.click({ button: 'right' });

        await expect(contextMenu).toBeVisible();
        await expect(contextMenu.getByRole('menuitem', { name: '查看所属 YANG 源码' })).toHaveCount(0);
        await expect(contextMenu.getByRole('menuitem', { name: '查看 Capability', exact: true })).toHaveCount(0);
        await expect(contextMenu.getByRole('menuitem', { name: 'Candidate 工作区', exact: true })).toBeVisible();
        await expect(contextMenu.getByRole('menuitem', { name: '配置存储', exact: true })).toBeVisible();
        const operationPanel = page.locator('.workspace-operation-panel');
        await contextMenu.getByRole('menuitem', { name: '读取当前节点（get）', exact: true }).click();
        await expect.poll(() => capturedRequests.filter(request => request.operation === 'get').length).toBe(1);
        expect(capturedRequests.at(-1).filter).toEqual({
            type: 'subtree',
            content: '<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"/>'
        });
        await expect(operationPanel.getByRole('button', { name: '执行 get', exact: true })).toBeEnabled();

        await expect(operationPanel).toBeVisible();
        await expect(page.getByRole('dialog', { name: 'get · interfaces' })).toHaveCount(0);

        const requestCard = operationPanel.locator('.operation-form-card');
        const responseCard = operationPanel.locator('.operation-result-card');
        const operationParameters = operationPanel.getByRole('complementary', { name: '操作参数' });
        await operationParameters.getByRole('button', { name: '重置', exact: true }).click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(capturedRequests.filter(request => request.operation === 'get')).toHaveLength(1);
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
        await expect(requestPreview).toHaveAttribute('data-xml-editor', '');
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
        const requestFormatButton = requestCard.getByRole('button', { name: '格式化', exact: true });
        const requestFormatButtonWidth = (await requestFormatButton.boundingBox()).width;
        await requestFormatButton.click();
        expect((await requestFormatButton.boundingBox()).width).toBe(requestFormatButtonWidth);
        await expect(requestCard.getByText('只读', { exact: true })).toBeVisible();

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
        await expect(replyViewer.locator('[data-xml-line-number-gutter]')).toBeVisible();
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
        const replyCodeContent = replyViewer.locator('[data-xml-code-content]');
        const replyLineNumbers = replyViewer.locator('[data-xml-line-number]');
        const formattedReplyXml = await replyCodeContent.textContent();
        expect(formattedReplyXml).toMatch(/<rpc-reply[^>]*>\n\s{2}<data>\n\s{4}<interfaces[^>]*>/u);
        expect(formattedReplyXml).toMatch(/\n\s{6}<interface>\n\s{8}<name>eth0<\/name>/u);
        expect(
            await replyLineNumbers.evaluateAll(elements => elements.map(element => element.dataset.lineNumber))
        ).toEqual(formattedReplyXml.split('\n').map((_line, index) => String(index + 1)));
        await expectSelectableXmlTextarea(replyViewer.locator('textarea[aria-label="RPC 响应 XML"]'));
        const sentRequestXml = await requestPreview.locator('textarea[aria-label="RPC 请求 XML"]').inputValue();
        expect(sentRequestXml).toMatch(/message-id="\d+"/u);
        expect(sentRequestXml).not.toContain('message-id="preview"');

        const responseDisplayToggle = responseCard.getByRole('button', { name: '查看原文', exact: true });
        const formattedResponseToggleWidth = (await responseDisplayToggle.boundingBox()).width;
        await responseDisplayToggle.click();
        await expect(replyLineNumbers).toHaveCount(1);
        const rawReplyXml = await replyCodeContent.textContent();
        expect(rawReplyXml).not.toContain('\n');
        expect(
            await replyLineNumbers.evaluateAll(elements => elements.map(element => element.dataset.lineNumber))
        ).toEqual(['1']);
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
        await expect.poll(() => capturedRequests.filter(request => request.operation === 'get').length).toBe(3);
        await expect(operationPanel.getByRole('button', { name: '执行 get', exact: true })).toBeEnabled();
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
        const editMonitorContext = netconfEditContext(
            harness,
            '/ietf-interfaces:interfaces/interface/enabled',
            'candidate'
        );
        await enabledNode.click({ button: 'right' });
        await selectSchemaMenuPath(contextMenu, ['编辑当前节点（edit-config）'], 'Candidate');
        await expectNetconfEditMonitorRequest(page, editMonitorContext);
        await expect(operationPanel.getByRole('button', { name: '执行 get', exact: true })).toBeEnabled();
        await expect(operationPanel.getByRole('button', { name: '执行 edit-config', exact: true })).toHaveCount(0);
        expect(capturedRequests.filter(request => request.operation === 'get-config')).toHaveLength(0);

        const { monitorPage, operationPanel: editOperationPanel } = await gotoNetconfEditMonitor(
            page,
            editMonitorContext
        );
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
        await expect(editOperationPanel.getByText('已载入', { exact: true })).toBeVisible();
        const editParameters = editOperationPanel.getByRole('complementary', { name: '操作参数' });
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

        const editRequestPreview = editOperationPanel.locator('.rpc-request-preview');
        const executeEditButton = editOperationPanel.getByRole('button', {
            name: '执行 edit-config',
            exact: true
        });
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
        await expect(editRequestPreview).toContainText('<enabled>true</enabled>');
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
        await expect(editRequestPreview).toContainText('<enabled>false</enabled>');
        forceGeneratedYangFailure = true;
        await executeEditButton.click();
        const editConfirmation = page.getByRole('dialog', { name: '确认仍然下发 RPC' });
        await expect(editConfirmation).toBeVisible();
        await expect(editConfirmation).toContainText('generated edit-config regression');
        const generatedOverrideCheckbox = editConfirmation.getByRole('checkbox', {
            name: '我已了解本地 YANG 校验未通过，仍要下发该 RPC'
        });
        const generatedOverrideButton = editConfirmation.getByRole('button', { name: '仍然下发', exact: true });
        await expect(generatedOverrideCheckbox).not.toBeChecked();
        await expect(generatedOverrideButton).toBeDisabled();
        await editConfirmation.getByText('我已了解本地 YANG 校验未通过，仍要下发该 RPC', { exact: true }).click();
        await generatedOverrideButton.click();
        await expect(editOperationPanel.locator('.rpc-result')).toContainText('<ok/>');
        forceGeneratedYangFailure = false;
        expect(capturedRequests.slice(-2).map(request => request.operation)).toEqual(['get-config', 'edit-config']);
        expect(capturedRequests.at(-1).config).toContain('<enabled>false</enabled>');

        await monitorPage.getByRole('button', { name: '执行记录', exact: true }).click();
        const executionHistoryDrawer = page.getByRole('dialog', { name: 'NETCONF 执行记录' });
        const executionHistoryItems = executionHistoryDrawer.getByTestId('netconf-history-item');
        await expect(executionHistoryItems).toHaveCount(2);
        await expect(executionHistoryItems.nth(0)).toContainText('edit-config');
        await expect(executionHistoryItems.nth(1)).toContainText('edit-config 自动回读');
        await executionHistoryItems.nth(0).click();
        await expect(executionHistoryDrawer.getByTestId('netconf-history-request')).toHaveValue(
            /<edit-config>[\s\S]*<enabled>false<\/enabled>/u
        );
        await executionHistoryItems.nth(1).click();
        await expect(executionHistoryDrawer.getByTestId('netconf-history-request')).toHaveValue(/<get-config>/u);
        await executionHistoryDrawer.getByRole('button', { name: '关闭', exact: true }).click();
    });

    test('uses compiled enumeration metadata for YANG leaf value editing', async ({ page }) => {
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
        const editMonitorContext = netconfEditContext(harness, '/ietf-interfaces:interfaces', 'candidate');
        await interfacesNode.click({ button: 'right' });
        const contextMenu = page.locator('.schema-context-menu');
        await selectSchemaMenuPath(contextMenu, ['编辑当前节点（edit-config）'], 'Candidate');
        await expectNetconfEditMonitorRequest(page, editMonitorContext);

        const { operationPanel } = await gotoNetconfEditMonitor(page, editMonitorContext);
        await expect(operationPanel.getByText('已载入', { exact: true })).toBeVisible();
        const editParameters = operationPanel.getByRole('complementary', { name: '操作参数' });
        const modePath = '/rpc/edit-config/config/interfaces[1]/interface[1]/config[1]/mode[1]';
        const modeParameter = parameterNode(editParameters, modePath);
        await expect(modeParameter).toContainText('disabled');

        const parameterMenu = (await openParameterContextMenu(page, editParameters, modePath)).menu;
        await parameterMenu.getByRole('menuitem', { name: '修改值', exact: true }).click();
        const modeDialog = page.getByRole('dialog', { name: '修改值 · mode' });
        const modeEditor = modeDialog.getByRole('combobox', { name: '节点值' });
        await expect(modeEditor).toBeVisible();
        await expect(modeDialog).toContainText('disabled');
        await modeEditor.click();
        await page.getByRole('option', { name: 'enabled', exact: true }).click();
        await modeDialog.getByRole('button', { name: '确认', exact: true }).click();

        const requestPreview = operationPanel.locator('.rpc-request-preview');
        await expect(requestPreview).toContainText('<mode>enabled</mode>');
        const requestXml = await requestPreview.locator('textarea[aria-label="RPC 请求 XML"]').inputValue();
        expect(requestXml).not.toContain('<mode>20</mode>');
        await operationPanel.getByRole('button', { name: '执行 edit-config', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '确认仍然下发 RPC' })).toHaveCount(0);
        await expect.poll(() => capturedRequests.some(request => request.operation === 'edit-config')).toBe(true);
        const editRequest = capturedRequests.find(request => request.operation === 'edit-config');
        expect(editRequest.config).toContain('<mode>enabled</mode>');
        await expect(operationPanel.locator('.rpc-result')).toContainText('<ok/>');
    });
    test('keeps empty-capable composite list keys present without requiring non-empty text', async ({ page }) => {
        const capturedRequests = [];
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.netconf.executeOperation') {
                const request = JSON.parse(JSON.stringify(args[0]));
                capturedRequests.push(request);
                if (request.operation === 'get-config')
                    return { status: 'error', msg: 'mock BGP readback unavailable' };
            }
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-workspace');
        await expandSchemaModule(page, 'ietf-interfaces');
        const bgpNode = schemaTreeItems(page)
            .filter({ has: page.getByText('BGP', { exact: true }) })
            .first();
        await bgpNode.getByRole('button', { name: '\u5c55\u5f00\u8282\u70b9' }).click();
        const vrfsNode = schemaTreeItems(page)
            .filter({ has: page.getByText('VRFs', { exact: true }) })
            .first();
        await vrfsNode.getByRole('button', { name: '\u5c55\u5f00\u8282\u70b9' }).click();
        const vrfList = schemaTreeItems(page)
            .filter({ has: page.getByText('VRF', { exact: true }) })
            .first();
        await vrfList.getByRole('button', { name: '\u5c55\u5f00\u8282\u70b9' }).click();
        const bandwidthNode = schemaTreeItems(page)
            .filter({ has: page.getByText('BandwidthCompaction', { exact: true }) })
            .first();
        const editMonitorContext = netconfEditContext(
            harness,
            '/ietf-interfaces:BGP/VRFs/VRF/BandwidthCompaction',
            'candidate'
        );
        await bandwidthNode.click({ button: 'right' });
        const schemaMenu = page.locator('.schema-context-menu');
        await selectSchemaMenuPath(
            schemaMenu,
            ['\u7f16\u8f91\u5f53\u524d\u8282\u70b9\uff08edit-config\uff09'],
            'Candidate'
        );
        await expectNetconfEditMonitorRequest(page, editMonitorContext);

        const { operationPanel } = await gotoNetconfEditMonitor(page, editMonitorContext);
        await expect(operationPanel.getByText('\u8bfb\u53d6\u5931\u8d25', { exact: true })).toBeVisible();
        const editParameters = operationPanel.getByRole('complementary', { name: '\u64cd\u4f5c\u53c2\u6570' });
        const namePath = '/rpc/edit-config/config/BGP[1]/VRFs[1]/VRF[1]/Name[1]';
        const vrfPath = '/rpc/edit-config/config/BGP[1]/VRFs[1]/VRF[1]/VRF[1]';
        const bandwidthPath = '/rpc/edit-config/config/BGP[1]/VRFs[1]/VRF[1]/BandwidthCompaction[1]';
        const nameParameter = parameterNode(editParameters, namePath);
        const vrfParameter = parameterNode(editParameters, vrfPath);
        await expect(nameParameter).toContainText('key');
        await expect(vrfParameter).toContainText('key');
        await expect(nameParameter).not.toHaveAttribute('data-parameter-invalid', 'true');
        await expect(vrfParameter).not.toHaveAttribute('data-parameter-invalid', 'true');
        await expect(nameParameter.getByText('\u5fc5\u586b', { exact: true })).toHaveCount(0);
        await expect(vrfParameter.getByText('\u5fc5\u586b', { exact: true })).toHaveCount(0);

        let parameterMenu = (await openParameterContextMenu(page, editParameters, namePath)).menu;
        await expect(
            parameterMenu.getByRole('menuitem', { name: '\u79fb\u9664\u8282\u70b9', exact: true })
        ).toBeDisabled();
        await parameterMenu.getByRole('menuitem', { name: '\u4fee\u6539\u503c', exact: true }).click();
        const nameDialog = page.getByRole('dialog', { name: '\u4fee\u6539\u503c \u00b7 Name' });
        const nameEditor = nameDialog.getByRole('textbox', { name: '\u8282\u70b9\u503c' });
        await expect(nameEditor).toHaveValue('');
        await expect(nameEditor).not.toHaveAttribute('aria-invalid', 'true');
        await expect(nameDialog.locator('.nn-form-item-required')).toHaveCount(0);
        await nameDialog.getByRole('button', { name: '\u786e\u8ba4', exact: true }).click();

        parameterMenu = (await openParameterContextMenu(page, editParameters, bandwidthPath)).menu;
        await parameterMenu.getByRole('menuitem', { name: '\u4fee\u6539\u503c', exact: true }).click();
        const bandwidthDialog = page.getByRole('dialog', { name: '\u4fee\u6539\u503c \u00b7 BandwidthCompaction' });
        const bandwidthEditor = bandwidthDialog.getByRole('combobox', { name: '\u8282\u70b9\u503c' });
        await bandwidthEditor.click();
        await page.getByRole('option', { name: 'enable', exact: true }).click();
        await bandwidthDialog.getByRole('button', { name: '\u786e\u8ba4', exact: true }).click();

        const requestEditor = operationPanel.getByRole('textbox', { name: 'RPC \u8bf7\u6c42 XML' });
        await expect.poll(() => requestEditor.inputValue()).not.toContain('NETNEXUS_REQUIRED');
        const requestXml = await requestEditor.inputValue();
        expect(requestXml).toMatch(/<Name\s*\/>|<Name><\/Name>/u);
        expect(requestXml).toMatch(/<VRF\s*\/>|<VRF><\/VRF>/u);
        expect(requestXml).toContain('<BandwidthCompaction>enable</BandwidthCompaction>');

        await operationPanel.getByRole('button', { name: '\u6267\u884c edit-config', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '\u786e\u8ba4\u4ecd\u7136\u4e0b\u53d1 RPC' })).toHaveCount(0);
        await expect.poll(() => capturedRequests.some(request => request.operation === 'edit-config')).toBe(true);
        const editRequest = capturedRequests.find(request => request.operation === 'edit-config');
        expect(editRequest.config).toMatch(/<Name\s*\/>|<Name><\/Name>/u);
        expect(editRequest.config).toMatch(/<VRF\s*\/>|<VRF><\/VRF>/u);
        await expect(operationPanel.locator('.rpc-result')).toContainText('<ok/>');
    });

    test('executes fixed node and datastore workflows directly from the Schema context menu', async ({ page }) => {
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
        const candidateEditContext = netconfEditContext(harness, '/ietf-interfaces:interfaces', 'candidate');
        const runningEditContext = netconfEditContext(harness, '/ietf-interfaces:interfaces', 'running');
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
        const waitForImmediateOperation = async (operation, previousRequestCount) => {
            await expect.poll(() => capturedRequests.length).toBe(previousRequestCount + 1);
            const request = capturedRequests.at(-1);
            expect(request.operation).toBe(operation);
            await expect(operationPanel.getByRole('button', { name: `执行 ${operation}`, exact: true })).toBeEnabled();
            return request;
        };
        const executeImmediateMenuOperation = async (submenuLabels, itemLabel, operation) => {
            const previousRequestCount = capturedRequests.length;
            await openInterfacesContextMenu();
            await selectSchemaMenuPath(contextMenu, submenuLabels, itemLabel);
            return waitForImmediateOperation(operation, previousRequestCount);
        };

        await openInterfacesContextMenu();
        const getConfigMenu = await openSchemaSubmenu(contextMenu, ['读取节点配置（get-config）']);
        await expect(getConfigMenu.getByRole('menuitem', { name: 'Running', exact: true })).toBeVisible();
        await expect(getConfigMenu.getByRole('menuitem', { name: 'Candidate', exact: true })).toBeVisible();
        await expect(getConfigMenu.getByRole('menuitem', { name: 'Startup', exact: true })).toBeVisible();
        const requestsBeforeGetConfig = capturedRequests.length;
        await getConfigMenu.getByRole('menuitem', { name: 'Startup', exact: true }).click();
        const startupGetConfig = await waitForImmediateOperation('get-config', requestsBeforeGetConfig);
        expect(startupGetConfig).toMatchObject({
            source: 'startup',
            filter: {
                type: 'subtree',
                content: '<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"/>'
            }
        });
        expect(await requestXml()).toMatch(/<source>\s*<startup\/>\s*<\/source>/u);

        await openInterfacesContextMenu();
        const editConfigMenu = await openSchemaSubmenu(contextMenu, ['编辑当前节点（edit-config）']);
        await expect(editConfigMenu.getByRole('menuitem', { name: 'Candidate', exact: true })).toBeVisible();
        await expect(editConfigMenu.getByRole('menuitem', { name: 'Running', exact: true })).toBeVisible();
        await editConfigMenu.getByRole('menuitem', { name: 'Candidate', exact: true }).click();
        await expectNetconfEditMonitorRequest(page, candidateEditContext);
        expect(capturedRequests.filter(request => request.operation === 'get-config')).toHaveLength(1);
        expect(await requestXml()).toMatch(/<source>\s*<startup\/>\s*<\/source>/u);
        await expect(operationPanel.getByRole('button', { name: '执行 get-config', exact: true })).toBeEnabled();

        await openInterfacesContextMenu();
        await selectSchemaMenuPath(contextMenu, ['编辑当前节点（edit-config）'], 'Running');
        await expectNetconfEditMonitorRequest(page, runningEditContext);
        await expect
            .poll(() => page.evaluate(() => window.__featureMonitorRequestDetails || []))
            .toEqual([
                { monitorId: 'netconf-edit-config', options: candidateEditContext },
                { monitorId: 'netconf-edit-config', options: runningEditContext }
            ]);
        expect(capturedRequests.filter(request => request.operation === 'get-config')).toHaveLength(1);
        expect(await requestXml()).toMatch(/<source>\s*<startup\/>\s*<\/source>/u);

        await openInterfacesContextMenu();
        const candidateMenu = await openSchemaSubmenu(contextMenu, ['Candidate 工作区']);
        await expect(
            candidateMenu.getByRole('menuitem', { name: '提交整个 Candidate → Running', exact: true })
        ).toBeVisible();
        await expect(candidateMenu.getByRole('menuitem', { name: '放弃全部未提交修改', exact: true })).toBeVisible();
        await expect(candidateMenu.getByRole('menuitem', { name: '锁定 Candidate', exact: true })).toBeVisible();
        await expect(candidateMenu.getByRole('menuitem', { name: '解锁 Candidate', exact: true })).toBeVisible();
        await expect(candidateMenu.getByRole('menuitem', { name: '取消 Confirmed Commit', exact: true })).toBeVisible();
        const requestsBeforeCommit = capturedRequests.length;
        await candidateMenu.getByRole('menuitem', { name: '提交整个 Candidate → Running', exact: true }).click();
        const commitRequest = await waitForImmediateOperation('commit', requestsBeforeCommit);
        expect(commitRequest).toMatchObject({ confirmed: false });
        expect(await requestXml()).toMatch(/<commit\/>/u);

        const validateRequest = await executeImmediateMenuOperation(
            ['Candidate 工作区'],
            '校验 Candidate（validate）',
            'validate'
        );
        expect(validateRequest.source).toBe('candidate');
        await executeImmediateMenuOperation(['Candidate 工作区'], '取消 Confirmed Commit', 'cancel-commit');
        await executeImmediateMenuOperation(['Candidate 工作区'], '放弃全部未提交修改', 'discard-changes');

        const lockRequest = await executeImmediateMenuOperation(
            ['配置存储', '锁定配置存储（lock）'],
            'Running',
            'lock'
        );
        expect(lockRequest.target).toBe('running');
        const unlockRequest = await executeImmediateMenuOperation(
            ['配置存储', '解锁配置存储（unlock）'],
            'Running',
            'unlock'
        );
        expect(unlockRequest.target).toBe('running');

        await openInterfacesContextMenu();
        const startupMenu = await openSchemaSubmenu(contextMenu, ['配置存储', 'Startup']);
        await expect(startupMenu.getByRole('menuitem', { name: '保存 Running → Startup', exact: true })).toBeVisible();
        await expect(startupMenu.getByRole('menuitem', { name: '删除整个 Startup', exact: true })).toBeVisible();
        const requestsBeforeStartupCopy = capturedRequests.length;
        await startupMenu.getByRole('menuitem', { name: '保存 Running → Startup', exact: true }).click();
        const startupCopyRequest = await waitForImmediateOperation('copy-config', requestsBeforeStartupCopy);
        expect(startupCopyRequest).toMatchObject({ source: 'running', target: 'startup' });

        const startupDeleteRequest = await executeImmediateMenuOperation(
            ['配置存储', 'Startup'],
            '删除整个 Startup',
            'delete-config'
        );
        expect(startupDeleteRequest.target).toBe('startup');
        await expect(page.getByRole('dialog', { name: '确认仍然下发 RPC' })).toHaveCount(0);

        const { operationPanel: candidateEditPanel } = await gotoNetconfEditMonitor(page, candidateEditContext);
        await expect.poll(() => capturedRequests.filter(request => request.operation === 'get-config').length).toBe(2);
        await expect(candidateEditPanel.getByText('已载入', { exact: true })).toBeVisible();
        await expect(candidateEditPanel.locator('.rpc-request-preview')).toContainText('<candidate/>');

        const { operationPanel: runningEditPanel } = await gotoNetconfEditMonitor(page, runningEditContext);
        await expect.poll(() => capturedRequests.filter(request => request.operation === 'get-config').length).toBe(3);
        await expect(runningEditPanel.getByText('已载入', { exact: true })).toBeVisible();
        await expect(runningEditPanel.locator('.rpc-request-preview')).toContainText('<running/>');
        const editReadbacks = capturedRequests.filter(
            request => request.operation === 'get-config' && ['candidate', 'running'].includes(request.source)
        );
        expect(editReadbacks.map(request => request.source)).toEqual(['candidate', 'running']);
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
        const editMonitorContext = netconfEditContext(
            harness,
            '/ietf-interfaces:interfaces/interface/enabled',
            'candidate'
        );
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
        await expectNetconfEditMonitorRequest(page, editMonitorContext);

        const { operationPanel } = await gotoNetconfEditMonitor(page, editMonitorContext);
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

    test('blocks a loaded edit-config draft after its Schema compile context becomes stale', async ({ page }) => {
        await page.goto('/#/yang/yang-workspace');
        const editMonitorContext = netconfEditContext(
            harness,
            '/ietf-interfaces:interfaces/interface/enabled',
            'candidate'
        );
        const { monitorPage, operationPanel } = await gotoNetconfEditMonitor(page, editMonitorContext);
        await expect(operationPanel.getByText('已载入', { exact: true })).toBeVisible();

        const requestEditor = operationPanel
            .locator('.rpc-request-preview')
            .locator('textarea[aria-label="RPC 请求 XML"]');
        const executeButton = operationPanel.getByRole('button', { name: '执行 edit-config', exact: true });
        const draftXml = await requestEditor.inputValue();
        const originalCompileId = harness.controller.state.yang.workspace.compileId;
        const staleWarning = monitorPage.getByText('当前草稿已保留，但不能继续下发', { exact: true });

        try {
            harness.controller.state.yang.workspace.compileId = `${originalCompileId}-stale`;
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));

            await expect(staleWarning).toBeVisible();
            await expect(monitorPage).toContainText('主窗口的 Schema 已重新编译或清空');
            await expect(requestEditor).toHaveValue(draftXml);
            await expect(executeButton).toBeDisabled();
        } finally {
            harness.controller.state.yang.workspace.compileId = originalCompileId;
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        }

        await expect(staleWarning).toHaveCount(0);
        await expect(requestEditor).toHaveValue(draftXml);
        await expect(executeButton).toBeEnabled();
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
            if (executeCount > 1) return response;
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
        await expect.poll(() => executeCount).toBe(2);
        await expect(operationPanel.locator('.result-summary span').first()).toHaveText('get-config');
        await expect(operationPanel.getByRole('button', { name: '执行 get-config', exact: true })).toBeEnabled();
        expect(sessionReadCount).toBe(sessionReadsAfterMount);
    });

    test('removes the virtual device entry and blank-area context menu', async ({ page }) => {
        harness.controller.state.yang.schemaTree = null;
        harness.controller.state.yang.compiledModuleIds = [];
        harness.controller.state.yang.workspace = null;

        await page.goto('/#/yang/yang-workspace');
        const schemaBackground = page.locator('.schema-tree-scroll');
        await expect(page.getByText('当前设备：NETCONF E2E 设备', { exact: true })).toHaveCount(0);
        await expect(schemaTreeItems(page)).toHaveCount(0);
        await expect(schemaBackground.getByText('暂无 Schema 节点', { exact: true })).toBeVisible();
        await schemaBackground.click({ button: 'right', position: { x: 12, y: 12 } });
        await expect(page.locator('.schema-context-menu')).toHaveCount(0);
        await expect(page.getByText('设备级操作', { exact: true })).toHaveCount(0);
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
        const confirmationDialog = page.getByRole('dialog', { name: '清空 YANG 工作区' });
        await expect(confirmationDialog).toBeVisible();

        await page.goto('/#/yang/yang-modules');
        await expect(confirmationDialog).toBeHidden();
        await expect(page.getByText('YANG 模型库', { exact: true })).toBeVisible();
    });

    test('manages an RFC 8639 dynamic subscription without disconnecting its Session', async ({ page }) => {
        await page.goto('/#/yang/yang-workspace');
        await expandSchemaModule(page, 'ietf-interfaces');

        const notificationNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interface-event', { exact: true }) })
            .first();
        await notificationNode.dispatchEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: 180,
            clientY: 180
        });
        const contextMenu = page.locator('.schema-context-menu');
        await expect(contextMenu).toBeVisible();
        await contextMenu.getByRole('menuitem', { name: '建立动态订阅（RFC 8639）', exact: true }).click();

        const operationPanel = page.locator('.workspace-operation-panel');
        const requestEditor = operationPanel.getByRole('textbox', { name: 'RPC 请求 XML' });
        await expect.poll(() => requestEditor.inputValue()).toContain('<establish-subscription');
        expect(await requestEditor.inputValue()).toContain('urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications');
        expect(await requestEditor.inputValue()).toContain('<stream-subtree-filter>');
        expect(await requestEditor.inputValue()).toContain('<stream>NETCONF</stream>');

        await operationPanel.getByRole('button', { name: '执行 establish-subscription', exact: true }).click();
        await expect(operationPanel.locator('.rpc-result')).toContainText(
            'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications'
        );
        await expect(operationPanel.locator('.rpc-result')).toContainText('>51</id>');

        const notificationButton = page.locator('.notification-history-trigger');
        await expect(notificationButton.locator('.notification-history-badge')).toHaveText('1');
        let { browser, drawer } = await openNetconfNotificationMonitor(page);
        let subscriptionItem = browser.locator('.notification-subscription-item').first();
        await expect(subscriptionItem).toContainText('活动');
        await subscriptionItem.click();
        await expect(drawer.getByTestId('netconf-notification-disconnect-session')).toHaveCount(0);
        const modifyButton = drawer.getByTestId('netconf-notification-modify-subscription');
        const deleteButton = drawer.getByTestId('netconf-notification-delete-subscription');
        await expect(modifyButton).toBeEnabled();
        await expect(deleteButton).toBeEnabled();

        await modifyButton.click();
        await deliverLatestNotificationAction(page, harness);
        await expect.poll(() => requestEditor.inputValue()).toContain('<modify-subscription');
        expect(await requestEditor.inputValue()).toContain('<id>51</id>');
        expect(await requestEditor.inputValue()).not.toContain('<stream>NETCONF</stream>');
        await operationPanel.getByRole('button', { name: '执行 modify-subscription', exact: true }).click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('<ok/>');

        ({ browser, drawer } = await openNetconfNotificationMonitor(page));
        subscriptionItem = browser.locator('.notification-subscription-item').first();
        await subscriptionItem.click();
        await drawer.getByTestId('netconf-notification-delete-subscription').click();
        await deliverLatestNotificationAction(page, harness);
        await expect.poll(() => requestEditor.inputValue()).toContain('<delete-subscription');
        expect(await requestEditor.inputValue()).toContain('<id>51</id>');
        await operationPanel.getByRole('button', { name: '执行 delete-subscription', exact: true }).click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('<ok/>');

        ({ browser, drawer } = await openNetconfNotificationMonitor(page));
        subscriptionItem = browser.locator('.notification-subscription-item').first();
        await expect(subscriptionItem).toContainText('已结束');
        await subscriptionItem.click();
        await expect(drawer.getByTestId('netconf-notification-delete-subscription')).toBeDisabled();
        expect(harness.controller.state.yang.session.connected).toBe(true);
    });

    test('establishes a periodic RFC 8641 YANG-Push subscription from a data node', async ({ page }) => {
        await page.goto('/#/yang/yang-workspace');
        await expandSchemaModule(page, 'ietf-interfaces');

        const interfacesNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interfaces', { exact: true }) })
            .first();
        await interfacesNode.dispatchEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: 180,
            clientY: 180
        });
        const contextMenu = page.locator('.schema-context-menu');
        await expect(contextMenu).toBeVisible();
        await contextMenu.getByRole('menuitem', { name: '订阅当前节点（YANG-Push）', exact: true }).click();

        const operationPanel = page.locator('.workspace-operation-panel');
        const requestEditor = operationPanel.getByRole('textbox', { name: 'RPC 请求 XML' });
        await expect.poll(() => requestEditor.inputValue()).toContain('<yp:datastore');
        const requestXml = await requestEditor.inputValue();
        expect(requestXml).toContain('ds:operational');
        expect(requestXml).toContain('<yp:datastore-subtree-filter');
        expect(requestXml).toContain('<yp:periodic>');
        expect(requestXml).toContain('<yp:period>500</yp:period>');

        await operationPanel.getByRole('button', { name: '执行 establish-subscription', exact: true }).click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('>51</id>');

        const notificationButton = page.locator('.notification-history-trigger');
        await expect(notificationButton.locator('.notification-history-badge')).toHaveText('1');
        const { browser, drawer } = await openNetconfNotificationMonitor(page);
        await expect(browser.getByTestId('netconf-notification-row')).toContainText('push-update');
        const subscriptionItem = browser.locator('.notification-subscription-item').first();
        await subscriptionItem.click();
        await expect(drawer).toContainText('YANG-Push');
        await expect(drawer.getByTestId('netconf-notification-modify-subscription')).toBeEnabled();
        await expect(drawer.getByTestId('netconf-notification-resync-subscription')).toHaveCount(0);
        await expect(drawer.getByTestId('netconf-notification-disconnect-session')).toHaveCount(0);
    });

    test('switches YANG-Push to on-change and requests RFC 8641 resynchronization', async ({ page }) => {
        await page.goto('/#/yang/yang-workspace');
        await expandSchemaModule(page, 'ietf-interfaces');
        const interfacesNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interfaces', { exact: true }) })
            .first();
        await interfacesNode.dispatchEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: 180,
            clientY: 180
        });
        const contextMenu = page.locator('.schema-context-menu');
        await expect(contextMenu).toBeVisible();
        await contextMenu.getByRole('menuitem', { name: '订阅当前节点（YANG-Push）', exact: true }).click();

        const operationPanel = page.locator('.workspace-operation-panel');
        const operationParameters = operationPanel.getByRole('complementary', { name: '操作参数' });
        const requestEditor = operationPanel.getByRole('textbox', { name: 'RPC 请求 XML' });
        const triggerMenu = (
            await openParameterContextMenu(page, operationParameters, '/rpc/establish-subscription/update-trigger')
        ).menu;
        await triggerMenu.getByRole('menuitem', { name: '修改值', exact: true }).click();
        const triggerDialog = page.getByRole('dialog', { name: '修改值 · update-trigger' });
        const triggerEditor = triggerDialog.getByRole('combobox', { name: '节点值' });
        await triggerEditor.click();
        await page.getByRole('option', { name: '数据变化（on-change）', exact: true }).click();
        await triggerDialog.getByRole('button', { name: '确认', exact: true }).click();
        await expect.poll(() => requestEditor.inputValue()).toContain('<yp:on-change>');
        expect(await requestEditor.inputValue()).toContain('<yp:sync-on-start>true</yp:sync-on-start>');

        await operationPanel.getByRole('button', { name: '执行 establish-subscription', exact: true }).click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('>51</id>');

        const notificationButton = page.locator('.notification-history-trigger');
        const { browser, drawer } = await openNetconfNotificationMonitor(page);
        const subscriptionItem = browser.locator('.notification-subscription-item').first();
        await subscriptionItem.click();
        const resyncButton = drawer.getByTestId('netconf-notification-resync-subscription');
        await expect(resyncButton).toBeEnabled();
        await resyncButton.click();
        await deliverLatestNotificationAction(page, harness);
        await expect.poll(() => requestEditor.inputValue()).toContain('<resync-subscription');
        expect(await requestEditor.inputValue()).toContain('<id>51</id>');
        await operationPanel.getByRole('button', { name: '执行 resync-subscription', exact: true }).click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('<ok/>');
        await expect(notificationButton.locator('.notification-history-badge')).toHaveText('2');
    });

    test('subscribes from a YANG notification node and monitors asynchronous notifications', async ({ page }) => {
        await page.goto('/#/yang/yang-workspace');
        await expandSchemaModule(page, 'ietf-interfaces');

        const notificationNode = schemaTreeItems(page)
            .filter({ has: page.getByText('interface-event', { exact: true }) })
            .first();
        await expect(notificationNode).toBeVisible();
        await expect(notificationNode.locator('[data-node-icon="notification"]')).toBeVisible();

        await notificationNode.dispatchEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: 180,
            clientY: 180
        });
        const contextMenu = page.locator('.schema-context-menu');
        await expect(contextMenu).toBeVisible();
        await expect(contextMenu.getByRole('menuitem', { name: '读取全部数据（get）' })).toHaveCount(0);
        await contextMenu.getByRole('menuitem', { name: '订阅此通知（RFC 5277）', exact: true }).click();

        const operationPanel = page.locator('.workspace-operation-panel');
        const requestEditor = operationPanel.getByRole('textbox', { name: 'RPC 请求 XML' });
        await expect.poll(() => requestEditor.inputValue()).toContain('<create-subscription');
        expect(await requestEditor.inputValue()).toContain('urn:ietf:params:xml:ns:netconf:notification:1.0');
        expect(await requestEditor.inputValue()).toContain(
            '<interface-event xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"/>'
        );

        await operationPanel.getByRole('button', { name: '执行 create-subscription', exact: true }).click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('<rpc-reply');
        await expect(operationPanel.locator('.rpc-result')).toContainText('<ok/>');

        const notificationButton = page.locator('.notification-history-trigger');
        await expect(notificationButton).toBeVisible();
        await expect(notificationButton.locator('.notification-history-badge')).toHaveText('1');
        let { browser, drawer } = await openNetconfNotificationMonitor(page);
        await expect(browser.getByText('Session e2e-session-101', { exact: true })).toBeVisible();
        const notificationRow = browser.getByTestId('netconf-notification-row');
        await expect(notificationRow).toHaveCount(1);
        await expect(notificationRow).toContainText('interface-event');
        await notificationRow.click();
        await expect.poll(() => harness.controller.state.yang.notificationHistory[0]?.read).toBe(true);

        const notificationXml = browser.getByRole('textbox', { name: 'NETCONF Notification XML' });
        await expect(notificationXml).toBeVisible();
        expect(await notificationXml.inputValue()).toContain('<notification');
        expect(await notificationXml.inputValue()).toContain('<interface-event');
        await expectXmlTextareaLineNumbers(notificationXml);
        await expectSelectableXmlTextarea(notificationXml);

        await page.goto('/#/yang/yang-workspace');
        await page.getByRole('button', { name: '执行记录', exact: true }).click();
        const historyDrawer = page.getByRole('dialog', { name: 'NETCONF 执行记录' });
        await expect(historyDrawer.getByTestId('netconf-history-item')).toHaveCount(1);
        await expect(historyDrawer.getByTestId('netconf-history-item').first()).toContainText('create-subscription');
        expect(await historyDrawer.getByRole('textbox', { name: 'RPC 响应 XML' }).inputValue()).not.toContain(
            '<notification'
        );

        await historyDrawer.getByRole('button', { name: '关闭' }).click();
        ({ browser, drawer } = await openNetconfNotificationMonitor(page));
        let subscriptionItem = browser.locator('.notification-subscription-item').first();
        await expect(subscriptionItem).toContainText('活动');
        await subscriptionItem.click();
        const disconnectSubscription = drawer.getByTestId('netconf-notification-disconnect-session');
        await expect(disconnectSubscription).toBeEnabled();
        await disconnectSubscription.click();
        await deliverLatestNotificationAction(page, harness);
        const disconnectConfirmation = page.getByRole('dialog', { name: '结束 RFC 5277 订阅' });
        await expect(disconnectConfirmation).toContainText('必须断开 Session e2e-session-101');
        await disconnectConfirmation.getByRole('button', { name: '断开 Session', exact: true }).click();
        ({ browser, drawer } = await openNetconfNotificationMonitor(page));
        subscriptionItem = browser.locator('.notification-subscription-item').first();
        await expect(subscriptionItem).toContainText('已结束');
        await subscriptionItem.click();
        await expect(drawer.getByTestId('netconf-notification-disconnect-session')).toBeDisabled();
    });

    test('redirects the retired operations page to the Schema workspace', async ({ page }) => {
        await page.goto('/#/yang/yang-operations');
        await expect(page).toHaveURL(/#\/yang\/yang-workspace$/u);
        await expect(page.getByText('Schema 与设备操作', { exact: true })).toBeVisible();
        await expect(page.getByRole('tab', { name: '设备操作', exact: true })).toHaveCount(0);
    });
});
