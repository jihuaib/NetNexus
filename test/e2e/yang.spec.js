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
            profileRow: rect(find('[data-testid="yang-modules-profile-row"]')),
            profile: rect(find('[data-testid="yang-modules-profile-select-field"]')),
            actions: rect(find('[data-testid="yang-modules-actions"]')),
            selectionRow: rect(find('.selection-row')),
            selectionCheckbox: rect(find('.selection-row .nn-checkbox-wrapper')),
            search: rect(find('.selection-row .selection-search')),
            status: rect(find('.selection-row .selection-status')),
            table: rect(find('.module-table')),
            compileLog: rect(find('[data-testid="yang-compile-log-panel"]')),
            controls: [
                find('[data-testid="yang-modules-profile-select-field"]'),
                find('.module-refresh-action'),
                find('.selection-row .selection-search'),
                find('.selection-row .selection-status')
            ].map(rect),
            actionButtons: [...body.querySelectorAll('.module-action-button')].map(rect),
            pageHasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
        };
    });
}

async function relativeProfileGeometry(page, cardSelector, fieldTestId) {
    return page.locator(`${cardSelector} > .nn-card-body`).evaluate((body, testId) => {
        const bodyBounds = body.getBoundingClientRect();
        const fieldBounds = body.querySelector(`[data-testid="${testId}"]`).getBoundingClientRect();
        return {
            x: fieldBounds.x - bodyBounds.x,
            y: fieldBounds.y - bodyBounds.y,
            width: fieldBounds.width,
            height: fieldBounds.height
        };
    }, fieldTestId);
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
        const highlightStyle = getComputedStyle(highlight);
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
            highlightScroll: { top: highlight.scrollTop, left: highlight.scrollLeft }
        };
    });
    expect(selectionStyle.userSelect).toBe('text');
    expect(selectionStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(selectionStyle.backgroundColor).not.toBe('transparent');
    expect(selectionStyle.contrast).toBeGreaterThan(60);
    expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(selectionStyle.color);
    expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(selectionStyle.textFillColor);
    expect(selectionStyle.highlightMetrics).toEqual(selectionStyle.inputMetrics);
    expect(selectionStyle.highlightScroll).toEqual(selectionStyle.inputScroll);
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

    test('isolates model and Schema workspaces when switching Profiles', async ({ page }) => {
        const scopedCalls = [];
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method.startsWith('yang.registry.')) {
                scopedCalls.push({ method, profileId: args[0]?.profileId || '' });
            }
            return originalControllerCall(method, ...args);
        };

        await page.goto('/#/yang/yang-modules');
        const moduleProfileSelect = page.getByTestId('yang-modules-profile-select');
        await expect(moduleProfileSelect).toContainText('NETCONF E2E 设备');
        const moduleProfileGeometry = await relativeProfileGeometry(
            page,
            '.modules-card',
            'yang-modules-profile-select-field'
        );
        await expect(page.getByText('ietf-interfaces', { exact: true })).toBeVisible();
        await moduleProfileSelect.click();
        await page.getByRole('option', { name: 'NETCONF E2E 备用设备', exact: true }).click();

        await expect(moduleProfileSelect).toContainText('NETCONF E2E 备用设备');
        await expect(page.getByText('vendor-system', { exact: true })).toBeVisible();
        await expect(page.getByText('ietf-interfaces', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '获取设备列表', exact: true })).toBeDisabled();

        await page.goto('/#/yang/yang-workspace');
        const workspaceProfileSelect = page.getByTestId('yang-workspace-profile-select');
        await expect(workspaceProfileSelect).toContainText('NETCONF E2E 备用设备');
        const workspaceProfileGeometry = await relativeProfileGeometry(
            page,
            '.workspace-card',
            'yang-workspace-profile-select-field'
        );
        Object.entries(moduleProfileGeometry).forEach(([property, value]) => {
            expect(Math.abs(workspaceProfileGeometry[property] - value), `Profile.${property}`).toBeLessThanOrEqual(1);
        });
        await expect(page.getByText('暂无 Schema', { exact: true })).toBeVisible();
        await expect(schemaTreeItems(page).filter({ hasText: 'ietf-interfaces' })).toHaveCount(0);
        await workspaceProfileSelect.click();
        await page.getByRole('option', { name: 'NETCONF E2E 设备', exact: true }).click();

        await expect(workspaceProfileSelect).toContainText('NETCONF E2E 设备');
        await expect(schemaTreeItems(page).filter({ hasText: 'ietf-interfaces' }).first()).toBeVisible();
        expect(
            scopedCalls.some(
                call => call.method === 'yang.registry.listModules' && call.profileId === 'e2e-netconf-profile-2'
            )
        ).toBe(true);
        expect(
            scopedCalls.some(
                call => call.method === 'yang.registry.getWorkspace' && call.profileId === 'e2e-netconf-profile'
            )
        ).toBe(true);
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

    test('ignores an out-of-order module failure after a Profile round trip', async ({ page }) => {
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

        const profileSelect = page.getByTestId('yang-modules-profile-select');
        await profileSelect.click();
        await page.getByRole('option', { name: 'NETCONF E2E 备用设备', exact: true }).click();
        await expect(page.getByText('vendor-system', { exact: true })).toBeVisible();
        await profileSelect.click();
        await page.getByRole('option', { name: 'NETCONF E2E 设备', exact: true }).click();
        await expect(page.getByText('ietf-interfaces', { exact: true })).toBeVisible();

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
        await expect(capabilityButton).toBeVisible();
        await expect(sessionTable.getByRole('button', { name: '断开连接', exact: true })).toBeVisible();
        await expect(editorConnectButton).toHaveCount(0);

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
        const compileNotification = page.locator('.yang-task-notification');
        await expect(compileNotification).toBeVisible();
        await expect(compileNotification.locator('.notification-title')).toHaveText('YANG 编译失败');
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

    test('keeps Profile fixed and model filters beside selection at responsive widths', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/#/yang/yang-modules');

        const profileSelect = page.getByTestId('yang-modules-profile-select');
        const modelSearch = page.getByPlaceholder('模块名 / namespace / revision');
        const statusSelect = page.getByTestId('yang-modules-status-select');
        await expect(profileSelect).toBeVisible();
        await expect(modelSearch).toBeVisible();
        await expect(statusSelect).toBeVisible();

        const wideBefore = await moduleToolbarGeometry(page);
        expect(Math.abs(wideBefore.profile.y - wideBefore.actions.y)).toBeLessThanOrEqual(1);
        expect(wideBefore.profile.right).toBeLessThanOrEqual(wideBefore.actions.x + 1);
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
        for (const action of ['获取设备列表', '导入文件', '导入目录', '编译所选', '刷新']) {
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
        await expect(profileSelect).toBeVisible();
        const narrow = await moduleToolbarGeometry(page);
        expect(narrow.profile.y).toBeGreaterThanOrEqual(narrow.profileRow.y - 1);
        expect(narrow.actions.y).toBeGreaterThanOrEqual(narrow.profileRow.y - 1);
        expect(narrow.actions.bottom).toBeLessThanOrEqual(narrow.profileRow.bottom + 1);
        expect(narrow.profileRow.bottom).toBeLessThanOrEqual(narrow.selectionRow.y + 1);
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

        const notification = page.locator('.yang-task-notification');
        await expect(notification).toBeVisible();
        await expect(notification.locator('.notification-title')).toHaveText('模型下载部分完成');
        await expect(notification.locator('.notification-description')).toHaveText(
            '已保存 1 个模型，1 个失败，1 个未尝试，请先修改设备初始密码后重试'
        );
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
        await expect(moduleTable.getByRole('columnheader', { name: '来源', exact: true })).toHaveCount(0);

        const lastAdditionalModule = page.getByText('bulk-local-24', { exact: true });
        await expect(lastAdditionalModule).toHaveCount(1);
        await lastAdditionalModule.scrollIntoViewIfNeeded();
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
        await expect(moduleTable.locator('tbody .nn-table-row')).toHaveCount(expectedLocalNames.length);

        const selectFiltered = page.getByRole('checkbox', { name: '选择当前筛选结果' });
        await selectFiltered.evaluate(element => element.click());
        await expect(selectFiltered).toBeChecked();
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

    test('validates, marks, confirms, and sends an edited complete RPC', async ({ page }) => {
        const rawRequests = [];
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
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
        await expect(requestEditor.locator('[data-xml-line-number="8"]')).toHaveClass(/xml-code-line-number-error/u);
        await expect(requestInput).toHaveAttribute('aria-invalid', 'true');
        await operationPanel.getByRole('button', { name: '发送手工 RPC', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '确认发送手工 RPC' })).toHaveCount(0);
        expect(rawRequests).toHaveLength(0);

        const validBooleanRpc = invalidBooleanRpc.replace('not-a-bool', 'false');
        await requestInput.fill(validBooleanRpc);
        await validateButton.click();
        await expect(requestDiagnostics).toHaveCount(0);
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
        expect(
            await toolbarButtons.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().width))
        ).toEqual(initialButtonWidths);
        const validatedCardBox = await requestCard.boundingBox();
        expect(Math.abs(validatedCardBox.width - initialCardBox.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(validatedCardBox.height - initialCardBox.height)).toBeLessThanOrEqual(1);

        await operationPanel.getByRole('button', { name: '发送手工 RPC', exact: true }).click();
        const confirmation = page.getByRole('dialog', { name: '确认发送手工 RPC' });
        await expect(confirmation).toBeVisible();
        await expect(confirmation).toContainText('完整 RPC 原文发送');
        expect(rawRequests).toHaveLength(0);
        await confirmation.getByRole('button', { name: '确认执行', exact: true }).click();
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
        await expect(contextMenu.getByRole('menuitem', { name: 'Candidate 工作区', exact: true })).toBeVisible();
        await expect(contextMenu.getByRole('menuitem', { name: '配置存储', exact: true })).toBeVisible();
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
        await expect(executionHistoryDrawer.getByTestId('netconf-history-request')).toHaveValue(/<get-config>/u);
        await executionHistoryDrawer.getByRole('button', { name: '关闭', exact: true }).click();
    });

    test('keeps node and datastore workflows in the Schema context menu', async ({ page }) => {
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
        await expect(candidateMenu.getByRole('menuitem', { name: '放弃全部未提交修改', exact: true })).toBeVisible();
        await expect(candidateMenu.getByRole('menuitem', { name: '锁定 Candidate', exact: true })).toBeVisible();
        await candidateMenu.getByRole('menuitem', { name: '提交整个 Candidate → Running', exact: true }).click();
        await expect(operationPanel.getByRole('button', { name: '执行 commit', exact: true })).toBeVisible();
        expect(await requestXml()).toMatch(/<commit\/>/u);

        await openInterfacesContextMenu();
        await selectSchemaMenuPath(contextMenu, ['配置存储', '锁定配置存储（lock）'], 'Running');
        await expect(operationPanel.getByRole('button', { name: '执行 lock', exact: true })).toBeVisible();
        expect(await requestXml()).toMatch(/<lock>\s*<target>\s*<running\/>\s*<\/target>\s*<\/lock>/u);

        await openInterfacesContextMenu();
        const startupMenu = await openSchemaSubmenu(contextMenu, ['配置存储', 'Startup']);
        await expect(startupMenu.getByRole('menuitem', { name: '保存 Running → Startup', exact: true })).toBeVisible();
        await expect(startupMenu.getByRole('menuitem', { name: '删除整个 Startup…', exact: true })).toBeVisible();
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
        const confirmationDialog = page.getByRole('dialog', { name: '清空 Schema 工作区' });
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
        await notificationNode.click({ button: 'right' });
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
        const establishConfirmation = page.getByRole('dialog', { name: '确认执行 establish-subscription' });
        await establishConfirmation.getByRole('button', { name: '确认执行', exact: true }).click();
        await expect(operationPanel.locator('.rpc-result')).toContainText(
            'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications'
        );
        await expect(operationPanel.locator('.rpc-result')).toContainText('>51</id>');

        const notificationButton = page.locator('.notification-history-trigger');
        await expect(notificationButton.locator('.notification-history-badge')).toHaveText('1');
        await notificationButton.click();
        const drawer = page.getByRole('dialog', { name: 'NETCONF 通知记录' });
        const subscriptionItem = drawer.locator('.notification-subscription-item').first();
        await expect(subscriptionItem).toContainText('活动');
        await subscriptionItem.click();
        await expect(drawer.getByTestId('netconf-notification-disconnect-session')).toHaveCount(0);
        const modifyButton = drawer.getByTestId('netconf-notification-modify-subscription');
        const deleteButton = drawer.getByTestId('netconf-notification-delete-subscription');
        await expect(modifyButton).toBeEnabled();
        await expect(deleteButton).toBeEnabled();

        await modifyButton.click();
        await expect(drawer).toBeHidden();
        await expect.poll(() => requestEditor.inputValue()).toContain('<modify-subscription');
        expect(await requestEditor.inputValue()).toContain('<id>51</id>');
        expect(await requestEditor.inputValue()).not.toContain('<stream>NETCONF</stream>');
        await operationPanel.getByRole('button', { name: '执行 modify-subscription', exact: true }).click();
        const modifyConfirmation = page.getByRole('dialog', { name: '确认执行 modify-subscription' });
        await modifyConfirmation.getByRole('button', { name: '确认执行', exact: true }).click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('<ok/>');

        await notificationButton.click();
        await subscriptionItem.click();
        await drawer.getByTestId('netconf-notification-delete-subscription').click();
        await expect(drawer).toBeHidden();
        await expect.poll(() => requestEditor.inputValue()).toContain('<delete-subscription');
        expect(await requestEditor.inputValue()).toContain('<id>51</id>');
        await operationPanel.getByRole('button', { name: '执行 delete-subscription', exact: true }).click();
        const deleteConfirmation = page.getByRole('dialog', { name: '确认执行 delete-subscription' });
        await deleteConfirmation.getByRole('button', { name: '确认执行', exact: true }).click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('<ok/>');

        await notificationButton.click();
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
        const confirmation = page.getByRole('dialog', { name: '确认执行 establish-subscription' });
        await confirmation.getByRole('button', { name: '确认执行', exact: true }).click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('>51</id>');

        const notificationButton = page.locator('.notification-history-trigger');
        await expect(notificationButton.locator('.notification-history-badge')).toHaveText('1');
        await notificationButton.click();
        const drawer = page.getByRole('dialog', { name: 'NETCONF 通知记录' });
        await expect(drawer.getByTestId('netconf-notification-row')).toContainText('push-update');
        const subscriptionItem = drawer.locator('.notification-subscription-item').first();
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
        await page
            .getByRole('dialog', { name: '确认执行 establish-subscription' })
            .getByRole('button', { name: '确认执行', exact: true })
            .click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('>51</id>');

        const notificationButton = page.locator('.notification-history-trigger');
        await notificationButton.click();
        const drawer = page.getByRole('dialog', { name: 'NETCONF 通知记录' });
        const subscriptionItem = drawer.locator('.notification-subscription-item').first();
        await subscriptionItem.click();
        const resyncButton = drawer.getByTestId('netconf-notification-resync-subscription');
        await expect(resyncButton).toBeEnabled();
        await resyncButton.click();
        await expect(drawer).toBeHidden();
        await expect.poll(() => requestEditor.inputValue()).toContain('<resync-subscription');
        expect(await requestEditor.inputValue()).toContain('<id>51</id>');
        await operationPanel.getByRole('button', { name: '执行 resync-subscription', exact: true }).click();
        await page
            .getByRole('dialog', { name: '确认执行 resync-subscription' })
            .getByRole('button', { name: '确认执行', exact: true })
            .click();
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
        const confirmation = page.getByRole('dialog', { name: '确认执行 create-subscription' });
        await expect(confirmation).toBeVisible();
        await confirmation.getByRole('button', { name: '确认执行', exact: true }).click();
        await expect(operationPanel.locator('.rpc-result')).toContainText('<rpc-reply');
        await expect(operationPanel.locator('.rpc-result')).toContainText('<ok/>');

        const notificationButton = page.locator('.notification-history-trigger');
        await expect(notificationButton).toBeVisible();
        await expect(notificationButton.locator('.notification-history-badge')).toHaveText('1');
        await notificationButton.click();

        const drawer = page.getByRole('dialog', { name: 'NETCONF 通知记录' });
        await expect(drawer).toBeVisible();
        await expect(drawer.getByText('Session e2e-session-101', { exact: true })).toBeVisible();
        const notificationRow = drawer.getByTestId('netconf-notification-row');
        await expect(notificationRow).toHaveCount(1);
        await expect(notificationRow).toContainText('interface-event');
        await notificationRow.click();

        const notificationXml = drawer.getByRole('textbox', { name: 'NETCONF Notification XML' });
        await expect(notificationXml).toBeVisible();
        expect(await notificationXml.inputValue()).toContain('<notification');
        expect(await notificationXml.inputValue()).toContain('<interface-event');
        await expectXmlTextareaLineNumbers(notificationXml);
        await expectSelectableXmlTextarea(notificationXml);

        await drawer.getByRole('button', { name: '关闭' }).click();
        await page.getByRole('button', { name: '执行记录', exact: true }).click();
        const historyDrawer = page.getByRole('dialog', { name: 'NETCONF 执行记录' });
        await expect(historyDrawer.getByTestId('netconf-history-item')).toHaveCount(1);
        await expect(historyDrawer.getByTestId('netconf-history-item').first()).toContainText('create-subscription');
        expect(await historyDrawer.getByRole('textbox', { name: 'RPC 响应 XML' }).inputValue()).not.toContain(
            '<notification'
        );

        await historyDrawer.getByRole('button', { name: '关闭' }).click();
        await notificationButton.click();
        await expect(drawer).toBeVisible();
        const subscriptionItem = drawer.locator('.notification-subscription-item').first();
        await expect(subscriptionItem).toContainText('活动');
        await subscriptionItem.click();
        const disconnectSubscription = drawer.getByTestId('netconf-notification-disconnect-session');
        await expect(disconnectSubscription).toBeEnabled();
        await disconnectSubscription.click();
        const disconnectConfirmation = page.getByRole('dialog', { name: '结束 RFC 5277 订阅' });
        await expect(disconnectConfirmation).toContainText('必须断开 Session e2e-session-101');
        await disconnectConfirmation.getByRole('button', { name: '断开 Session', exact: true }).click();
        await expect(subscriptionItem).toContainText('已结束');
        await expect(disconnectSubscription).toBeDisabled();
    });

    test('redirects the retired operations page to the Schema workspace', async ({ page }) => {
        await page.goto('/#/yang/yang-operations');
        await expect(page).toHaveURL(/#\/yang\/yang-workspace$/u);
        await expect(page.getByText('Schema 与设备操作', { exact: true })).toBeVisible();
        await expect(page.getByRole('tab', { name: '设备操作', exact: true })).toHaveCount(0);
    });
});
