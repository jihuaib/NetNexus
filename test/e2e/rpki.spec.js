const { test } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');

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
