const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e } = require('../../scripts/e2e-support');
const { version: currentVersion } = require('../../package.json');

const newRelease = {
    version: '5.0.7',
    releaseName: 'NetNexus 5.0.7',
    releaseNotes: 'SNMP 查询体验改进。\n\n## SNMP\n\n- 查询结果展示完整 MIB 路径。\n- 修复 Tree 节点枚举详情。'
};

async function emitUpdate(page, type, data = {}) {
    await page.evaluate(
        ({ type, data }) => {
            window.__featureE2eEmit('updater:update-status', { status: 'success', data: { type, data } });
        },
        { type, data }
    );
}

async function installUpdateApi(page) {
    await page.addInitScript(
        ({ version, updateInfo }) => {
            const state = { calls: [], marks: [], updateInfo };
            const success = data => Promise.resolve({ status: 'success', data });
            const emitUpdate = (type, data = {}) => {
                window.__featureE2eEmit('updater:update-status', { status: 'success', data: { type, data } });
            };
            const overrides = {
                getUpdateSettings: () => success({ autoCheckOnStartup: true, autoDownload: false }),
                saveUpdateSettings: settings => success(settings),
                getChangelogState: () => success({ version, shouldShow: false }),
                markChangelogSeen: seenVersion => {
                    state.marks.push(seenVersion);
                    return success(null);
                }
            };
            let commonApi = { ...window.commonApi, ...overrides };
            Object.defineProperty(window, 'commonApi', {
                configurable: true,
                get: () => commonApi,
                set: value => {
                    commonApi = { ...value, ...overrides };
                }
            });
            window.__updateReleaseNotesE2e = state;
            window.updaterApi = {
                getCurrentVersion: async () => version,
                getUpdatePolicy: async () => ({ automaticUpdatesSupported: true }),
                checkForUpdates: async () => {
                    state.calls.push('check');
                    emitUpdate('checking-for-update');
                    emitUpdate('update-available', state.updateInfo);
                    return { success: true, updateInfo: state.updateInfo };
                },
                downloadUpdate: async () => {
                    state.calls.push('download');
                    emitUpdate('download-started');
                },
                quitAndInstall: async () => {
                    state.calls.push('install');
                },
                openReleasesPage: async () => {
                    state.calls.push('open-releases');
                    return { success: true };
                }
            };
        },
        { version: currentVersion, updateInfo: newRelease }
    );
}

test.describe('Update release notes', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
        await installUpdateApi(page);
        await page.goto('/#/tools/packet-parser');
        await expect(page.locator('.main-layout')).toBeVisible();
    });

    test.afterEach(async () => {
        await harness?.cleanup();
    });

    test('shows the available version notes after a manual settings check without marking them seen', async ({
        page
    }, testInfo) => {
        await page.getByRole('button', { name: '更多选项' }).click();
        await page.getByRole('menuitem', { name: '设置', exact: true }).click();
        const settings = page.getByRole('dialog', { name: '设置', exact: true });
        await settings.getByRole('tab', { name: '更新', exact: true }).click();
        await settings.getByRole('button', { name: '检查更新', exact: true }).click();

        const dialog = page.getByRole('dialog', { name: '新版本更新内容', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('v5.0.7');
        await expect(dialog.locator('.changelog-remote-notes')).toContainText('SNMP 查询体验改进。');
        await expect(dialog.locator('.changelog-remote-notes')).toContainText('查询结果展示完整 MIB 路径。');
        expect(await dialog.locator('.changelog-remote-notes').textContent()).toContain('\n');
        expect(await page.evaluate(() => window.__updateReleaseNotesE2e.calls)).toEqual(['check']);
        expect(await page.evaluate(() => window.__updateReleaseNotesE2e.marks)).toEqual([]);

        const screenshot = testInfo.outputPath('update-release-notes.png');
        await page.screenshot({ path: screenshot, animations: 'disabled' });
        await testInfo.attach('update-release-notes', { path: screenshot, contentType: 'image/png' });
        await dialog.getByRole('button', { name: '知道了', exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(settings).toBeVisible();
        await expect(settings.getByText(currentVersion, { exact: true })).toBeVisible();
    });

    test('opens automatic update notes again from the notification without coupling download and install actions', async ({
        page
    }) => {
        const dialog = page.getByRole('dialog', { name: '新版本更新内容', exact: true });
        const notification = page.locator('.update-notification');
        await emitUpdate(page, 'update-available', newRelease);
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('.changelog-remote-notes')).toContainText('修复 Tree 节点枚举详情。');
        await dialog.getByRole('button', { name: '知道了', exact: true }).click();

        await notification.getByRole('button', { name: '更新内容', exact: true }).click();
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: '知道了', exact: true }).click();
        await notification.getByText('发现新版本 5.0.7', { exact: true }).click();
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: '知道了', exact: true }).click();

        await notification.getByRole('button', { name: '下载', exact: true }).click();
        await expect(notification).toContainText('下载进度: 0%');
        await expect(dialog).toBeHidden();
        await emitUpdate(page, 'update-downloaded', newRelease);
        await notification.getByRole('button', { name: '安装', exact: true }).click();
        await expect(dialog).toBeHidden();
        expect(await page.evaluate(() => window.__updateReleaseNotesE2e.calls)).toEqual(['download', 'install']);
        expect(await page.evaluate(() => window.__updateReleaseNotesE2e.marks)).toEqual([]);
    });

    test('renders array and HTML notes as safe readable text within a narrow scrolling dialog', async ({ page }) => {
        await page.setViewportSize({ width: 520, height: 640 });
        const items = Array.from({ length: 45 }, (_, index) => `<li>更新项目 ${index + 1}：改善网络工具体验。</li>`);
        await emitUpdate(page, 'update-available', {
            version: '5.0.8',
            releaseNotes: [
                {
                    version: '5.0.8',
                    note: `<p>新版更新内容</p><ul>${items.join('')}</ul><script>window.__updateNotesInjected = true;</script><img src="x" onerror="window.__updateNotesInjected = true">`
                },
                { version: '5.0.7', note: '之前版本的修复说明。\n保留多版本更新内容。' },
                { version: '5.0.6', note: null }
            ]
        });

        const dialog = page.getByRole('dialog', { name: '新版本更新内容', exact: true });
        const notes = dialog.locator('.changelog-remote-notes');
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('v5.0.8');
        await expect(notes).toHaveCount(2);
        await expect(notes.nth(0)).toContainText('新版更新内容');
        await expect(notes.nth(0)).toContainText('更新项目 45：改善网络工具体验。');
        await expect(notes.nth(1)).toContainText('之前版本的修复说明。');
        await expect(notes.nth(1)).toContainText('保留多版本更新内容。');
        await expect(dialog.locator('.changelog-content')).not.toContainText('<li>');
        await expect(dialog.locator('.changelog-content')).not.toContainText('window.__updateNotesInjected');
        await expect(notes.locator('img, script')).toHaveCount(0);
        expect(await page.evaluate(() => window.__updateNotesInjected)).toBeUndefined();
        const geometry = await dialog.evaluate(element => {
            const box = element.getBoundingClientRect();
            const body = element.querySelector('.nn-modal-body');
            return {
                left: box.left,
                right: box.right,
                top: box.top,
                bottom: box.bottom,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                horizontalOverflow: element.scrollWidth - element.clientWidth,
                bodyScrollHeight: body.scrollHeight,
                bodyClientHeight: body.clientHeight
            };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
        expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
        expect(geometry.bodyScrollHeight).toBeGreaterThan(geometry.bodyClientHeight);
        await dialog.getByRole('button', { name: '知道了', exact: true }).click();
        await expect(dialog).toBeHidden();
    });

    test('falls back for missing release notes without retaining the previous version content', async ({ page }) => {
        const dialog = page.getByRole('dialog', { name: '新版本更新内容', exact: true });
        await emitUpdate(page, 'update-available', newRelease);
        await expect(dialog.locator('.changelog-remote-notes')).toContainText('SNMP 查询体验改进。');
        await dialog.getByRole('button', { name: '知道了', exact: true }).click();
        await emitUpdate(page, 'update-available', { version: '5.0.8', releaseNotes: null });

        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('v5.0.8');
        await expect(dialog).toContainText('此版本暂未附带详细更新日志，可前往 GitHub Releases 查看发布说明。');
        await expect(dialog).not.toContainText('SNMP 查询体验改进。');
        await dialog.getByRole('button', { name: 'GitHub Releases', exact: true }).click();
        expect(await page.evaluate(() => window.__updateReleaseNotesE2e.calls)).toEqual(['open-releases']);
        expect(await page.evaluate(() => window.__updateReleaseNotesE2e.marks)).toEqual([]);
    });

    test('does not open notes on failures or no-update results and closes an obsolete update dialog', async ({
        page
    }) => {
        const dialog = page.getByRole('dialog', { name: '新版本更新内容', exact: true });
        await emitUpdate(page, 'checking-for-update');
        await emitUpdate(page, 'update-not-available', { version: currentVersion });
        await expect(dialog).toBeHidden();
        await emitUpdate(page, 'update-error', { error: '更新服务器暂时不可用' });
        await expect(page.locator('.update-notification')).toContainText('更新服务器暂时不可用');
        await expect(dialog).toBeHidden();

        await emitUpdate(page, 'update-available', newRelease);
        await expect(dialog).toBeVisible();
        await emitUpdate(page, 'update-not-available', { version: currentVersion });
        await expect(dialog).toBeHidden();
        await expect(page.locator('.update-notification')).toBeHidden();
        expect(await page.evaluate(() => window.__updateReleaseNotesE2e.marks)).toEqual([]);
    });
});
