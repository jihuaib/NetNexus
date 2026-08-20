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
        const runtimeFailureReason = 'TCP-AO发送密钥已过期且没有可用的后继密钥，RPKI服务已安全停止';

        await page.goto('/#/rpki/rpki-config');
        await expect(page.getByTestId('rpki-config-page')).toBeVisible();

        await page.evaluate(() => {
            window.__featureE2eEmit?.('rpki:runtimeChanged', { running: true });
        });
        await expect(page.getByTestId('rpki-stop-button')).toBeEnabled();
        await expect(page.getByTestId('rpki-client-table')).toContainText('192.0.2.10');

        harness.controller.state.rpki.running = false;
        await page.evaluate(reason => {
            window.__featureE2eEmit?.('rpki:runtimeChanged', {
                running: false,
                unexpected: true,
                code: 'TCP_AO_KEYS_EXPIRED',
                reason
            });
        }, runtimeFailureReason);
        await expect(page.getByTestId('rpki-stop-button')).toBeDisabled();
        await expect(page.getByTestId('rpki-client-table')).not.toContainText('192.0.2.10');

        const runtimeFailureAlert = page.getByTestId('rpki-runtime-failure');
        await expect(runtimeFailureAlert).toBeVisible();
        await expect(runtimeFailureAlert).toContainText('RPKI服务已安全停止');
        await expect(runtimeFailureAlert).toContainText(runtimeFailureReason);

        harness.controller.state.rpki.running = true;
        await page.evaluate(() => {
            window.__featureE2eEmit?.('rpki:runtimeChanged', { running: true });
        });
        await expect(runtimeFailureAlert).toBeHidden();
        await expect(page.getByTestId('rpki-stop-button')).toBeEnabled();
    });

    test('starts with a TCP-AO profile reference without sending key material', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');
        await page.evaluate(() => {
            window.rpkiApi = new Proxy(window.rpkiApi, {
                get(target, property, receiver) {
                    if (property === 'loadTcpAoSettings') {
                        return async () => ({
                            status: 'success',
                            data: {
                                profiles: [
                                    {
                                        id: 'edge-cache',
                                        name: '边缘 Cache',
                                        peer: '198.51.100.10/32',
                                        keys: [
                                            {
                                                id: 'edge-current',
                                                algorithm: 'hmac(sha256)',
                                                sndId: 7,
                                                rcvId: 8,
                                                macLength: 16,
                                                hasSavedKey: true,
                                                acceptStart: null,
                                                sendStart: null,
                                                sendEnd: null,
                                                acceptEnd: null
                                            }
                                        ]
                                    }
                                ]
                            }
                        });
                    }
                    if (property === 'saveTcpAoSettings') {
                        return async settings => ({ status: 'success', data: settings });
                    }
                    return Reflect.get(target, property, receiver);
                }
            });
        });

        await page
            .locator('.main-menu')
            .getByRole('menuitem', { name: /^RPKI(?:服务器)?$/u })
            .click();
        await expect(page).toHaveURL(/#\/rpki\/rpki-config$/u);
        await expect(page.getByTestId('rpki-config-page')).toBeVisible();
        await page.getByRole('radio', { name: 'TCP-AO', exact: true }).check({ force: true });
        await expect(page.getByTestId('rpki-tcp-ao-profile-select')).toBeVisible();

        await page.getByTestId('rpki-open-tcp-ao-settings').click();
        const settingsDialog = page.getByRole('dialog', { name: '设置' });
        await expect(settingsDialog).toBeVisible();
        await expect(settingsDialog.getByRole('tab', { name: 'TCP-AO', exact: true })).toHaveAttribute(
            'aria-selected',
            'true'
        );
        await settingsDialog.getByRole('button', { name: '关闭' }).click();
        await expect(settingsDialog).toBeHidden();

        await page.getByTestId('rpki-tcp-ao-profile-select').click();
        await page.getByRole('option').filter({ hasText: '边缘 Cache' }).click();
        await expect(page.getByText('当前 Send ID 7 / Receive ID 8', { exact: false })).toBeVisible();
        await page.getByTestId('rpki-start-button').click();

        await expect(page.getByTestId('rpki-stop-button')).toBeEnabled();
        const savedConfig = harness.controller.state.rpki.config;
        expect(savedConfig.authType).toBe('tcp-ao');
        expect(savedConfig.tcpAoProfileId).toBe('edge-cache');
        expect(savedConfig).not.toHaveProperty('tcpAo');
        expect(JSON.stringify(savedConfig)).not.toContain('edge-current');
        expect(JSON.stringify(savedConfig)).not.toContain('key');
    });

    test('starts with a TCP MD5 profile reference without sending key material', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');
        await page.evaluate(() => {
            window.rpkiApi = new Proxy(window.rpkiApi, {
                get(target, property, receiver) {
                    if (property === 'loadTcpMd5Settings') {
                        return async () => ({
                            status: 'success',
                            data: {
                                profiles: [
                                    {
                                        id: 'rpki-cache-md5',
                                        name: 'RPKI Cache MD5',
                                        peer: '198.51.100.20/32',
                                        hasSavedKey: true,
                                        savedKeyStatus: 'available'
                                    }
                                ]
                            }
                        });
                    }
                    return Reflect.get(target, property, receiver);
                }
            });
        });

        await page
            .locator('.main-menu')
            .getByRole('menuitem', { name: /^RPKI(?:服务器)?$/u })
            .click();
        await expect(page).toHaveURL(/#\/rpki\/rpki-config$/u);
        await page.getByRole('radio', { name: 'TCP MD5', exact: true }).check({ force: true });
        await page.getByTestId('rpki-tcp-md5-profile-select').click();
        await page.getByRole('option').filter({ hasText: 'RPKI Cache MD5' }).click();
        await expect(page.getByText('允许的对端范围：198.51.100.20/32', { exact: true })).toBeVisible();

        await page.getByTestId('rpki-start-button').click();
        await expect(page.getByTestId('rpki-stop-button')).toBeEnabled();

        const savedConfig = harness.controller.state.rpki.config;
        expect(savedConfig.authType).toBe('tcp-md5');
        expect(savedConfig.tcpMd5ProfileId).toBe('rpki-cache-md5');
        expect(savedConfig.tcpAoProfileId).toBe('');
        expect(JSON.stringify(savedConfig)).not.toContain('198.51.100.20');
        expect(JSON.stringify(savedConfig)).not.toContain('key');
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
