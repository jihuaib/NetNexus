const { test } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');

const pageCases = [
    { route: '/#/tools/packet-parser', title: '报文解析器' },
    { route: '/#/tools/port-monitor', title: '端口连接列表', expectText: '3000' },
    { route: '/#/tools/network-info', title: '网络信息', expectText: 'NetNexus E2E Interface' },
    { route: '/#/tools/tcp-ao-mac', title: 'TCP-AO MAC 计算器' },
    { route: '/#/tools/http-api-tester', title: 'HTTP API测试', expectText: 'Mock Status' }
];

test.describe('Tools pages', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('renders tool pages with mock data', async ({ page }) => {
        for (const pageCase of pageCases) {
            await verifyPage(test, page, pageCase);
        }
    });
});
