const { test } = require('@playwright/test');
const { setupFeaturePagesE2e, verifyPage } = require('../../scripts/e2e-support');

const pageCases = [
    { route: '/#/snmp/snmp-config', title: 'SNMP 配置' },
    { route: '/#/snmp/snmp-mib', title: 'MIB 管理', expectText: 'sysDescr' },
    { route: '/#/snmp/snmp-trap', title: 'SNMP Trap 监控', expectText: '192.0.2.80' }
];

test.describe('SNMP pages', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) {
            await harness.cleanup();
        }
    });

    test('renders SNMP pages with mock data', async ({ page }) => {
        for (const pageCase of pageCases) {
            await verifyPage(test, page, pageCase);
        }
    });
});
