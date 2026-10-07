const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e } = require('../../scripts/e2e-support');
const { version: currentVersion } = require('../../package.json');
const notesByVersion = require('../../src/data/releaseNotes.json');
const currentRelease = notesByVersion[currentVersion];
const [major, minor, patch] = currentVersion.split('.').map(part => parseInt(part, 10));
let nextPatch = patch + 1;
while (notesByVersion[`${major}.${minor}.${nextPatch}`]) {
    nextPatch += 1;
}
const unknownVersion = `${major}.${minor}.${nextPatch}`;

async function installChangelogApi(page) {
    const storageKey = `netnexus.e2e.changelog.${Date.now()}.${Math.random()}`;

    await page.addInitScript(
        ({ key, version }) => {
            const readState = () => {
                const saved = localStorage.getItem(key);
                return saved ? JSON.parse(saved) : { version, seenVersions: [], marks: [] };
            };
            const success = data => Promise.resolve({ status: 'success', msg: '', data });
            const changelogApi = {
                getUpdateSettings: () => success({ autoCheckOnStartup: false, autoDownload: false }),
                saveUpdateSettings: settings => success(settings),
                getChangelogState: () => {
                    const state = readState();
                    return success({ version: state.version, shouldShow: !state.seenVersions.includes(state.version) });
                },
                markChangelogSeen: version => {
                    const state = readState();
                    const visibleDialog = Array.from(document.querySelectorAll('[role="dialog"]')).some(dialog => {
                        const box = dialog.getBoundingClientRect();
                        return (
                            box.width > 0 &&
                            box.height > 0 &&
                            dialog.innerText.includes('更新日志') &&
                            dialog.innerText.includes(`v${version}`)
                        );
                    });

                    state.marks.push({ version, visibleDialog });
                    if (state.rejectMark) {
                        localStorage.setItem(key, JSON.stringify(state));
                        return Promise.reject(new Error('模拟更新日志状态写入失败'));
                    }
                    if (!state.seenVersions.includes(version)) {
                        state.seenVersions.push(version);
                    }
                    localStorage.setItem(key, JSON.stringify(state));
                    return success(null);
                }
            };
            let commonApi = { ...window.commonApi, ...changelogApi };

            // Keep the feature mocks and changelog overrides regardless of init-script order.
            Object.defineProperty(window, 'commonApi', {
                configurable: true,
                get: () => commonApi,
                set: value => {
                    commonApi = { ...value, ...changelogApi };
                }
            });
            window.__changelogE2e = {
                readState,
                setVersion: version => {
                    localStorage.setItem(key, JSON.stringify({ ...readState(), version }));
                },
                setMarkFailure: rejectMark => {
                    localStorage.setItem(key, JSON.stringify({ ...readState(), rejectMark }));
                }
            };
        },
        { key: storageKey, version: currentVersion }
    );
}

async function expectCurrentReleaseContent(changelog) {
    await expect(changelog).toContainText(`v${currentVersion}`);
    await expect(changelog.locator('.changelog-summary')).toHaveText(currentRelease.summary);
    const moduleTitles = currentRelease.sections.map(section => section.title);
    const headings = changelog.locator('.changelog-section h3');
    await expect(headings).toHaveText(moduleTitles);
    for (const title of moduleTitles) {
        await expect(changelog.getByRole('heading', { name: title, exact: true })).toBeVisible();
    }
    const sections = await changelog.locator('.changelog-section').evaluateAll(elements =>
        elements.map(section => ({
            title: section.querySelector('h3').textContent.trim(),
            items: Array.from(section.querySelectorAll('li')).map(item => item.textContent.trim())
        }))
    );
    expect(sections).toEqual(currentRelease.sections);
}

async function expectCompactTypography(changelog) {
    const content = changelog.locator('.changelog-content');
    await expect(content).toHaveCSS('font-size', '13px');
    await expect(changelog.locator('.changelog-version strong')).toHaveCSS('font-size', '14px');
    await expect(changelog.locator('.changelog-hint')).toHaveCSS('font-size', '12px');
    const headings = changelog.locator('.changelog-section h3');
    for (let index = 0; index < (await headings.count()); index += 1) {
        await expect(headings.nth(index)).toHaveCSS('font-size', '13px');
        await expect(headings.nth(index)).toHaveCSS('font-weight', '600');
    }
    const bodyTypography = await content.evaluate(element => {
        const style = getComputedStyle(element);
        return {
            lineHeightRatio: parseFloat(style.lineHeight) / parseFloat(style.fontSize),
            itemFontSizes: Array.from(element.querySelectorAll('li')).map(item => getComputedStyle(item).fontSize)
        };
    });
    expect(bodyTypography.lineHeightRatio).toBeCloseTo(1.55, 2);
    expect(new Set(bodyTypography.itemFontSizes)).toEqual(new Set(['13px']));
}

async function openSettingsDialog(page) {
    await page.getByRole('button', { name: '更多选项' }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();

    const settingsDialog = page.getByRole('dialog', { name: '设置', exact: true });
    await expect(settingsDialog).toBeVisible();
    await settingsDialog.getByRole('tab', { name: '更新', exact: true }).click();
    return settingsDialog;
}

test.describe('Release changelog', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
        await installChangelogApi(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('shows each version once and records it only after the dialog is visible', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');

        const changelog = page.getByRole('dialog', { name: '更新日志', exact: true });
        await expect(changelog).toBeVisible();
        await expectCurrentReleaseContent(changelog);
        await expectCompactTypography(changelog);
        await expect
            .poll(() => page.evaluate(() => window.__changelogE2e.readState().marks))
            .toEqual([{ version: currentVersion, visibleDialog: true }]);
        await page.screenshot({ path: test.info().outputPath('changelog.png'), animations: 'disabled' });
        await changelog.getByRole('button', { name: '知道了', exact: true }).click();
        await expect(changelog).toBeHidden();

        await page.reload();
        await expect(page.getByText('报文解析器', { exact: true })).toBeVisible();
        await expect(changelog).toBeHidden();
        expect(await page.evaluate(() => window.__changelogE2e.readState().marks)).toHaveLength(1);

        await page.evaluate(version => window.__changelogE2e.setVersion(version), unknownVersion);
        await page.reload();
        await expect(changelog).toBeVisible();
        await expect(changelog).toContainText(`v${unknownVersion}`);
        await expect(changelog).toContainText('此版本暂未附带详细更新日志');
        await expect(changelog).not.toContainText(currentRelease.summary);
        await expect
            .poll(() => page.evaluate(() => window.__changelogE2e.readState().marks))
            .toEqual([
                { version: currentVersion, visibleDialog: true },
                { version: unknownVersion, visibleDialog: true }
            ]);
        await changelog.getByRole('button', { name: '关闭', exact: true }).click();

        await page.evaluate(version => window.__changelogE2e.setVersion(version), currentVersion);
        await page.reload();
        await expect(page.getByText('报文解析器', { exact: true })).toBeVisible();
        await expect(changelog).toBeHidden();
        expect(await page.evaluate(() => window.__changelogE2e.readState().marks)).toHaveLength(2);
    });

    test('reopens from update settings and returns to the same settings tab', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');

        const changelog = page.getByRole('dialog', { name: '更新日志', exact: true });
        await expect(changelog).toBeVisible();
        await changelog.getByRole('button', { name: '知道了', exact: true }).click();

        const settingsDialog = await openSettingsDialog(page);
        await settingsDialog.getByRole('button', { name: '查看更新日志', exact: true }).click();
        await expect(changelog).toBeVisible();
        await expect(changelog).toContainText(`v${currentVersion}`);
        await page.screenshot({ path: test.info().outputPath('changelog-settings.png'), animations: 'disabled' });
        await changelog.getByRole('button', { name: '关闭', exact: true }).click();

        await expect(settingsDialog).toBeVisible();
        await expect(settingsDialog.getByRole('tab', { name: '更新', exact: true })).toHaveAttribute(
            'aria-selected',
            'true'
        );
        await settingsDialog.getByRole('button', { name: '查看更新日志', exact: true }).click();
        await expect(changelog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(changelog).toBeHidden();
        await expect(settingsDialog).toBeVisible();
        await expect(settingsDialog.getByRole('button', { name: '查看更新日志', exact: true })).toBeVisible();
        expect(await page.evaluate(() => window.__changelogE2e.readState().seenVersions)).toEqual([currentVersion]);
    });

    test('keeps the dialog open after a storage failure and retries on the next launch', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');

        const changelog = page.getByRole('dialog', { name: '更新日志', exact: true });
        await expect(changelog).toBeVisible();
        await changelog.getByRole('button', { name: '知道了', exact: true }).click();
        await page.evaluate(version => {
            window.__changelogE2e.setVersion(version);
            window.__changelogE2e.setMarkFailure(true);
        }, unknownVersion);
        await page.reload();

        await expect(changelog).toBeVisible();
        await expect(changelog).toContainText(`v${unknownVersion}`);
        await expect
            .poll(() => page.evaluate(() => window.__changelogE2e.readState().marks))
            .toEqual([
                { version: currentVersion, visibleDialog: true },
                { version: unknownVersion, visibleDialog: true }
            ]);
        expect(await page.evaluate(() => window.__changelogE2e.readState().seenVersions)).toEqual([currentVersion]);
        await expect(changelog).toBeVisible();
        await changelog.getByRole('button', { name: '知道了', exact: true }).click();
        await page.evaluate(() => window.__changelogE2e.setMarkFailure(false));
        await page.reload();

        await expect(changelog).toBeVisible();
        await expect(changelog).toContainText(`v${unknownVersion}`);
        await expect
            .poll(() => page.evaluate(() => window.__changelogE2e.readState().seenVersions))
            .toEqual([currentVersion, unknownVersion]);
        expect(await page.evaluate(() => window.__changelogE2e.readState().marks)).toEqual([
            { version: currentVersion, visibleDialog: true },
            { version: unknownVersion, visibleDialog: true },
            { version: unknownVersion, visibleDialog: true }
        ]);
    });

    test('fits a narrow viewport in the dark theme', async ({ page }) => {
        await page.setViewportSize({ width: 520, height: 640 });
        await page.addInitScript(() => localStorage.setItem('netnexus.themePreset', 'dark'));
        await page.goto('/#/tools/packet-parser');

        const changelog = page.getByRole('dialog', { name: '更新日志', exact: true });
        await expect(changelog).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expectCurrentReleaseContent(changelog);
        await expectCompactTypography(changelog);
        const geometry = await changelog.evaluate(dialog => {
            const box = dialog.getBoundingClientRect();
            return {
                left: box.left,
                right: box.right,
                top: box.top,
                bottom: box.bottom,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                horizontalOverflow: dialog.scrollWidth - dialog.clientWidth
            };
        });

        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
        expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
        await page.screenshot({ path: test.info().outputPath('changelog-dark.png'), animations: 'disabled' });
        await changelog.getByRole('button', { name: '知道了', exact: true }).click();
        await expect(changelog).toBeHidden();
    });
});
