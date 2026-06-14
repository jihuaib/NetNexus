const { test } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');

const pageCases = [
    { route: '/#/dhcp/dhcp-config', title: 'DHCP服务器配置' },
    { route: '/#/dhcp/dhcp-lease', title: '租约列表', expectText: '192.168.1.101' }
];

test.describe('DHCP pages', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('renders DHCP pages with mock data', async ({ page }) => {
        for (const pageCase of pageCases) {
            await verifyPage(test, page, pageCase);
        }
    });
});
