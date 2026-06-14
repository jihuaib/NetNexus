const { test } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');

const pageCases = [
    { route: '/#/bgp/route-ipv6', title: 'IPv6-UNC路由配置' },
    { route: '/#/bgp/route-mvpn', title: 'IPv4-MVPN路由配置' },
    { route: '/#/bgp/route-ipv4-qp', title: 'IPv4-QP路由配置' },
    { route: '/#/bgp/route-ipv6-qp', title: 'IPv6-QP路由配置' }
];

test.describe('BGP route pages', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('renders route configuration pages with mock data', async ({ page }) => {
        for (const pageCase of pageCases) {
            await verifyPage(test, page, pageCase);
        }
    });
});
