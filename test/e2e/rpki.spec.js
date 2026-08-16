const { test, expect } = require('../../scripts/e2e-support/electron-test');
const {
    getBrowserMockScript,
    RpkiE2eController,
    setupFeaturePagesE2e,
    verifyPage
} = require('../../scripts/e2e-support');

const pageCases = [
    { route: '/#/rpki/rpki-config', title: 'RPKI服务器配置', expectText: '192.0.2.10' },
    { route: '/#/rpki/rpki-roa-config', title: 'RPKI ROA配置', expectText: '203.0.113.0' },
    { route: '/#/rpki/rpki-router-key-config', title: 'RPKI Router Key 配置 (协议 v1+)', expectText: '65000' },
    { route: '/#/rpki/rpki-aspa-config', title: 'RPKI ASPA 配置 (协议 v2)', expectText: '65010' }
];

test.describe('RPKI pages', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('renders RPKI pages with mock data', async ({ page }) => {
        for (const pageCase of pageCases) {
            await verifyPage(test, page, pageCase);
        }
    });

    test('caches ROA and ASPA once per RPKI runtime and clears both on stop', async ({ page }) => {
        const rpki = harness.controller.state.rpki;
        const routeTabs = page.locator('.fixed-tabs');
        const roaTable = page.getByTestId('rpki-roa-table');
        const aspaTable = page.getByTestId('rpki-aspa-table');

        await page.goto('/#/rpki/rpki-roa-config');
        await expect(roaTable).toContainText('203.0.113.0');
        expect(rpki.roaListCalls).toBe(1);

        await routeTabs.getByRole('tab', { name: 'ASPA (v2)', exact: true }).click();
        await expect(aspaTable).toContainText('65010');
        expect(rpki.aspaListCalls).toBe(1);

        await routeTabs.getByRole('tab', { name: 'RPKI ROA配置', exact: true }).click();
        await expect(roaTable).toContainText('203.0.113.0');
        expect(rpki.roaListCalls).toBe(1);

        rpki.running = false;
        await page.evaluate(() => {
            window.__featureE2eEmit?.('rpki:runtimeChanged', { running: false });
        });
        await expect(roaTable).not.toContainText('203.0.113.0');

        await routeTabs.getByRole('tab', { name: 'ASPA (v2)', exact: true }).click();
        await expect(aspaTable).not.toContainText('65010');
        expect(rpki.roaListCalls).toBe(1);
        expect(rpki.aspaListCalls).toBe(1);

        rpki.running = true;
        await page.evaluate(() => {
            window.__featureE2eEmit?.('rpki:runtimeChanged', { running: true });
        });
        await expect(aspaTable).toContainText('65010');
        expect(rpki.aspaListCalls).toBe(2);
        expect(rpki.roaListCalls).toBe(1);

        await routeTabs.getByRole('tab', { name: 'RPKI ROA配置', exact: true }).click();
        await expect(roaTable).toContainText('203.0.113.0');
        expect(rpki.roaListCalls).toBe(2);

        await routeTabs.getByRole('tab', { name: 'ASPA (v2)', exact: true }).click();
        await expect(aspaTable).toContainText('65010');
        expect(rpki.aspaListCalls).toBe(2);
    });

    test('does not restore ROA rows from a request that finishes after stop', async ({ page }) => {
        const rpki = harness.controller.state.rpki;
        rpki.roaListDelayMs = 1000;

        await page.goto('/#/rpki/rpki-roa-config');
        await expect.poll(() => rpki.roaListCalls).toBe(1);

        rpki.running = false;
        await page.evaluate(() => {
            window.__featureE2eEmit?.('rpki:runtimeChanged', { running: false });
        });

        await page.waitForTimeout(1100);
        await expect(page.getByTestId('rpki-roa-table')).not.toContainText('203.0.113.0');
        expect(rpki.roaListCalls).toBe(1);
    });

    test('clears cached ROA data when a runtime refresh returns an error', async ({ page }) => {
        const rpki = harness.controller.state.rpki;
        const roaTable = page.getByTestId('rpki-roa-table');

        await page.goto('/#/rpki/rpki-roa-config');
        await expect(roaTable).toContainText('203.0.113.0');

        rpki.roaListError = 'synthetic ROA query failure';
        await page.evaluate(() => {
            window.__featureE2eEmit?.('rpki:runtimeChanged', { running: true });
        });

        await expect(roaTable).not.toContainText('203.0.113.0');
        expect(rpki.roaListCalls).toBe(2);
    });

    test('keeps the config runtime state and client list in sync with process exit', async ({ page }) => {
        await page.goto('/#/rpki/rpki-config');
        await expect(page.getByTestId('rpki-config-page')).toBeVisible();

        await page.evaluate(() => {
            window.__featureE2eEmit?.('rpki:runtimeChanged', { running: true });
        });
        await expect(page.getByTestId('rpki-stop-button')).toBeEnabled();
        await expect(page.getByTestId('rpki-client-table')).toContainText('192.0.2.10');

        harness.controller.state.rpki.running = false;
        await page.evaluate(() => {
            window.__featureE2eEmit?.('rpki:runtimeChanged', { running: false });
        });
        await expect(page.getByTestId('rpki-stop-button')).toBeDisabled();
        await expect(page.getByTestId('rpki-client-table')).not.toContainText('192.0.2.10');
    });
});

test.describe('RPKI stop lifecycle', () => {
    let controller;

    test.beforeEach(async ({ page }) => {
        controller = new RpkiE2eController();

        await page.exposeFunction('__rpkiE2eCall', (method, ...args) => controller.call(method, ...args));
        controller.onEvent(event => {
            page.evaluate(({ type, data }) => window.__rpkiE2eEmit?.(type, data), event).catch(() => {});
        });

        await page.addInitScript({ content: getBrowserMockScript('rpki') });
    });

    test.afterEach(async () => {
        if (controller) {
            await controller.cleanup();
        }
    });

    test('stops RPKI server from UI and sends FIN to connected client', async ({ page }) => {
        const rpkiPort = await RpkiE2eController.getFreePort();

        await test.step('Start RPKI server from UI', async () => {
            await page.goto('/#/rpki/rpki-config');
            await expect(page.getByTestId('rpki-config-page')).toBeVisible();

            await page.getByTestId('rpki-port-input').fill(String(rpkiPort));
            await page.getByTestId('rpki-start-button').click();
            await expect(page.getByTestId('rpki-stop-button')).toBeEnabled();
        });

        await test.step('Connect a mock RPKI TCP client', async () => {
            await controller.startMockClient();
            const client = await controller.waitForClientConnected();

            await expect(page.getByTestId('rpki-client-table')).toContainText(String(client.remotePort), {
                timeout: 10000
            });
        });

        await test.step('Stop RPKI server and verify client receives FIN', async () => {
            await page.getByTestId('rpki-stop-button').click();

            const result = await controller.waitForMockClientEnd({ timeout: 5000 });
            expect(result.endReceived).toBe(true);
            expect(result.events).toContain('end');

            await expect(page.getByTestId('rpki-stop-button')).toBeDisabled();
            await expect(page.getByTestId('rpki-client-table')).not.toContainText('127.0.0.1');
        });
    });

    test('removes RPKI client session from the UI when the client disconnects', async ({ page }) => {
        const rpkiPort = await RpkiE2eController.getFreePort();
        let client;

        await test.step('Start RPKI server and connect a mock client', async () => {
            await page.goto('/#/rpki/rpki-config');
            await expect(page.getByTestId('rpki-config-page')).toBeVisible();

            await page.getByTestId('rpki-port-input').fill(String(rpkiPort));
            await page.getByTestId('rpki-start-button').click();
            await expect(page.getByTestId('rpki-stop-button')).toBeEnabled();

            await controller.startMockClient();
            client = await controller.waitForClientConnected();

            await expect(page.getByTestId('rpki-client-table')).toContainText(String(client.remotePort), {
                timeout: 10000
            });
        });

        await test.step('Disconnect mock RPKI client and verify UI removes the session', async () => {
            const closeResult = await controller.disconnectMockClient({ timeout: 5000 });
            expect(closeResult.hadError).toBe(false);

            await expect(page.getByTestId('rpki-client-table')).not.toContainText(String(client.remotePort), {
                timeout: 10000
            });
        });
    });
});
