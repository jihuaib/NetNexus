const fs = require('fs');
const path = require('path');
const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { BmpE2eController, getBrowserMockScript } = require('../../scripts/e2e-support');
const { HuaweiBmpLiveScenario } = require('../../scripts/e2e-support/huawei-bmp-live-suite');
const { MODES, buildModeScenario } = require('../../scripts/huawei-bmp-loc-rib-modes-e2e');

const LIVE_ENABLED = process.env.HUAWEI_BMP_E2E === '1';

async function startCollectorFromPage(page, port) {
    await page.goto('/#/bmp/bmp-config');
    await expect(page.getByTestId('bmp-config-page')).toBeVisible();
    await page.getByTestId('bmp-port-input').fill(String(port));
    await page.getByText('draft-19', { exact: true }).click();
    await page.getByTestId('bmp-start-button').click();
    await expect(page.getByTestId('bmp-stop-button')).toBeEnabled({ timeout: 15000 });
}

function findMultiPathPrefix(device) {
    const pathIdsByPrefix = new Map();
    for (const instance of device.locRib.filter(item => item.af === 1)) {
        for (const route of instance.samples) {
            if (!pathIdsByPrefix.has(route.ip)) pathIdsByPrefix.set(route.ip, new Set());
            pathIdsByPrefix.get(route.ip).add(Number(route.pathId));
        }
    }
    return [...pathIdsByPrefix.entries()].find(([, pathIds]) => pathIds.has(0) && pathIds.has(1))?.[0] || null;
}

function clientLabel(client) {
    const systemName = typeof client?.sysName === 'string' ? client.sysName.trim() : '';
    const remoteIp = typeof client?.remoteIp === 'string' ? client.remoteIp.trim() : '';
    return [systemName, remoteIp && remoteIp !== systemName ? remoteIp : ''].filter(Boolean).join(' · ') || '-';
}

async function getLocRibMonitorRoute(controller, remoteIp) {
    const result = await controller.call('getClientList');
    const client = (result.data || []).find(item => item.remoteIp === remoteIp);
    if (!client) throw new Error(`BMP Client not found for ${remoteIp}`);
    const sourceId = client.persistentSourceId || client.sourceId;
    const clientKey = sourceId
        ? `source:${sourceId}`
        : `connection:${[client.localIp, client.localPort, client.remoteIp, client.remotePort].join('|')}`;
    return `/#/monitor/bmp-loc-rib?clientKey=${encodeURIComponent(clientKey)}`;
}

async function verifyModeInLocRibPage(page, live, mode, controller) {
    const root = page.getByTestId('bmp-loc-rib-page');
    const addPath = mode.startsWith('add-path');
    const pathMarking = mode.includes('path-marking');
    live.report.uiLocRibMode = { mode, devices: [] };

    for (const device of live.report.devices) {
        await page.goto(await getLocRibMonitorRoute(controller, device.remoteIp));
        await expect(root).toBeVisible();
        await expect.poll(() => page.title()).toBe(`Loc-RIB · ${clientLabel(device)}`);
        await expect(page.locator('.monitor-window-header')).toHaveCount(0);
        await expect(root.locator('.client-tabs')).toHaveCount(0);
        const ipv4Instance = device.locRib.find(instance => instance.af === 1 && instance.total > 0);
        expect(ipv4Instance, `${device.remoteIp} IPv4 Loc-RIB instance`).toBeTruthy();

        await root.locator('.bmp-inner-tabs [role="tab"]').filter({ hasText: 'global | IPv4 UNC' }).first().click();
        const instanceTable = root.locator('[data-testid="bmp-loc-rib-instance-table"]:visible').first();
        const routeTable = root.locator('[data-testid="bmp-loc-rib-route-table"]:visible').first();
        await expect(instanceTable).toContainText(ipv4Instance.isAddPath ? 'Yes' : 'No', { timeout: 20000 });
        await expect(routeTable.locator('tbody tr:not(.nn-table-placeholder)')).not.toHaveCount(0, {
            timeout: 20000
        });

        const deviceResult = {
            device: device.remoteIp,
            total: ipv4Instance.total,
            reportedAddPathCapability: ipv4Instance.isAddPath === true,
            multiPathPrefix: null,
            pathIds: [],
            pathStatusVisible: false
        };

        if (addPath) {
            const prefix = findMultiPathPrefix(device);
            expect(prefix, `${device.remoteIp} same-prefix ADD-PATH routes`).toBeTruthy();
            const prefixRows = routeTable.locator('tbody tr:not(.nn-table-placeholder)').filter({ hasText: prefix });
            await expect(prefixRows).toHaveCount(2, { timeout: 20000 });
            const pathIds = (await prefixRows.locator('td:nth-child(6)').allTextContents())
                .map(value => Number(value.trim()))
                .sort((a, b) => a - b);
            expect(pathIds).toEqual([0, 1]);
            deviceResult.multiPathPrefix = prefix;
            deviceResult.pathIds = pathIds;
        } else {
            const pathIds = (
                await routeTable.locator('tbody tr:not(.nn-table-placeholder) td:nth-child(6)').allTextContents()
            ).map(value => Number(value.trim()));
            expect([...new Set(pathIds)]).toEqual([0]);
            deviceResult.pathIds = pathIds;
        }

        if (pathMarking) {
            await expect(routeTable).toContainText('Best', { timeout: 20000 });
            await expect(routeTable).toContainText('Primary', { timeout: 20000 });
            deviceResult.pathStatusVisible = true;
        }

        live.report.uiLocRibMode.devices.push(deviceResult);
    }

    const screenshotDirectory = path.join(live.lab.artifactDirectory, 'screenshots');
    fs.mkdirSync(screenshotDirectory, { recursive: true });
    await page.screenshot({
        path: path.join(screenshotDirectory, `${live.scenario.key}-loc-rib-mode.png`),
        fullPage: true
    });
}

test.describe('Huawei BMP Loc-RIB mode pages', () => {
    test.skip(!LIVE_ENABLED, 'Set HUAWEI_BMP_E2E=1 and the Huawei credential environment variables');

    for (const mode of MODES) {
        test(`${mode}: real devices render Loc-RIB mode`, async ({ page }) => {
            test.setTimeout(5 * 60 * 1000);
            const scenario = buildModeScenario(mode);
            const controller = new BmpE2eController();
            const live = new HuaweiBmpLiveScenario({ scenario, controller });
            let scenarioError = null;

            await page.exposeFunction('__bmpE2eCall', (method, ...args) => controller.call(method, ...args));
            controller.onEvent(event => {
                page.evaluate(({ type, data }) => window.__bmpE2eEmit?.(type, data), event).catch(() => {});
            });
            await page.addInitScript({ content: getBrowserMockScript('bmp') });

            try {
                await startCollectorFromPage(page, live.lab.collectorPort);
                live.collectorStarted = true;
                await live.apply({ trialSeconds: Number(process.env.NETNEXUS_HUAWEI_TRIAL_SECONDS || 900) });
                await live.waitForData({
                    timeoutMs: Number(process.env.NETNEXUS_HUAWEI_LOC_RIB_MODE_TIMEOUT_MS || 90000)
                });
                await live.collectFinal();
                await verifyModeInLocRibPage(page, live, mode, controller);
                expect.soft(live.report.setupIssues, 'scenario setup issues').toEqual([]);
                expect.soft(live.report.codeIssues, 'real-device parser/UI issues').toEqual([]);
            } catch (error) {
                scenarioError = error;
                live.report.setupIssues.push({
                    detail: `Playwright Loc-RIB mode failed: ${error.message}`,
                    stack: error.stack
                });
            } finally {
                try {
                    await live.cleanup();
                } catch (error) {
                    scenarioError ||= error;
                }
                live.writeReport('ui');
            }

            if (scenarioError) throw scenarioError;
        });
    }
});
