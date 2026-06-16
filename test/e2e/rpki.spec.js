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
