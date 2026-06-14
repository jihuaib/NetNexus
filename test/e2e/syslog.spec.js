const { test } = require('@playwright/test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');

const pageCases = [
    { route: '/#/syslog/syslog-config', title: 'Syslog服务器配置' },
    { route: '/#/syslog/syslog-message-log', title: 'Syslog消息日志', expectText: 'netnexus test syslog message' }
];

test.describe('Syslog pages', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('renders Syslog pages with mock data', async ({ page }) => {
        for (const pageCase of pageCases) {
            await verifyPage(test, page, pageCase);
        }
    });
});
