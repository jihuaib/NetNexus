const fs = require('fs');
const path = require('path');
const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { BmpE2eController, getBrowserMockScript } = require('../../scripts/e2e-support');
const { HuaweiBmpLiveScenario } = require('../../scripts/e2e-support/huawei-bmp-live-suite');
const { HUAWEI_BMP_SCENARIOS } = require('../../scripts/e2e-support/huawei-bmp-scenarios');

const LIVE_ENABLED = process.env.HUAWEI_BMP_E2E === '1';
const ADDRESS_FAMILY_LABEL = Object.freeze({
    1: 'IPv4 UNC',
    2: 'IPv6 UNC',
    3: 'L2VPN EVPN',
    4: 'VPNV4',
    5: 'VPNV6',
    12: 'IPv4 Label',
    14: 'Link-State'
});
const RIB_TYPE_LABEL = Object.freeze({
    1: 'Pre-policy Adj-RIB-In',
    2: 'Post-policy Adj-RIB-In',
    4: 'Pre-policy Adj-RIB-Out',
    5: 'Post-policy Adj-RIB-Out'
});

async function startCollectorFromPage(page, port) {
    await page.goto('/#/bmp/bmp-config');
    await expect(page.getByTestId('bmp-config-page')).toBeVisible();
    await page.getByTestId('bmp-port-input').fill(String(port));
    await page.getByText('draft-19', { exact: true }).click();
    await page.getByTestId('bmp-start-button').click();
    await expect(page.getByTestId('bmp-stop-button')).toBeEnabled({ timeout: 15000 });
}

function sessionTabLabel(session) {
    const vrf = session.vrfTableNames?.filter(Boolean).join(', ') || 'global';
    return `${vrf} | ${session.sessionIp} | ${session.sessionAs}`;
}

function locRibTabLabel(instance) {
    const vrf = instance.vrfTableNames?.filter(Boolean).join(', ') || 'global';
    return `${vrf} | ${ADDRESS_FAMILY_LABEL[instance.af] || instance.af}`;
}

function clientLabel(client) {
    const systemName = typeof client?.sysName === 'string' ? client.sysName.trim() : '';
    const remoteIp = typeof client?.remoteIp === 'string' ? client.remoteIp.trim() : '';
    return [systemName, remoteIp && remoteIp !== systemName ? remoteIp : ''].filter(Boolean).join(' · ') || '-';
}

async function getClientMonitorRoute(controller, monitorId, remoteIp) {
    const result = await controller.call('getClientList');
    const client = (result.data || []).find(item => item.remoteIp === remoteIp);
    if (!client) throw new Error(`BMP Client not found for ${remoteIp}`);
    const sourceId = client.persistentSourceId || client.sourceId;
    const clientKey = sourceId
        ? `source:${sourceId}`
        : `connection:${[client.localIp, client.localPort, client.remoteIp, client.remotePort].join('|')}`;
    return `/#/monitor/${monitorId}?clientKey=${encodeURIComponent(clientKey)}`;
}

async function selectOption(page, select, label) {
    await select.click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await expect(select.locator('.nn-select-single-value')).toHaveText(label);
}

async function verifyAllSessionScopes(page, live, controller) {
    live.report.uiSessionScopes = [];
    for (const device of live.report.devices) {
        await page.goto(await getClientMonitorRoute(controller, 'bmp-session', device.remoteIp));
        const root = page.getByTestId('bmp-session-page');
        await expect(root).toBeVisible();
        await expect.poll(() => page.title()).toBe(`BGP会话 · ${clientLabel(device)}`);
        await expect(page.locator('.monitor-window-header')).toHaveCount(0);
        await expect(root.locator('.client-tabs')).toHaveCount(0);
        for (const session of device.sessions) {
            const routeSets = session.routes.filter(route => route.total > 0);
            if (!routeSets.length) continue;
            await root
                .locator('.bmp-inner-tabs [role="tab"]')
                .filter({ hasText: sessionTabLabel(session) })
                .first()
                .click();
            const toolbar = root.locator('.route-toolbar:visible').first();
            const selects = toolbar.locator('.nn-select');
            const routeTable = root.locator('[data-testid="bmp-session-route-table"]:visible').first();
            for (const routeSet of routeSets) {
                const familyLabel = ADDRESS_FAMILY_LABEL[routeSet.af];
                const ribLabel = RIB_TYPE_LABEL[routeSet.ribType];
                if (!familyLabel || !ribLabel) continue;
                await selectOption(page, selects.nth(0), familyLabel);
                await selectOption(page, selects.nth(1), ribLabel);
                await expect(routeTable.locator('tbody tr:not(.nn-table-placeholder)')).not.toHaveCount(0, {
                    timeout: 20000
                });
                const prefix = routeSet.samples[0]?.ip;
                if (prefix) await expect(routeTable).toContainText(prefix, { timeout: 20000 });
                live.report.uiSessionScopes.push({
                    device: device.remoteIp,
                    sessionIp: session.sessionIp,
                    af: routeSet.af,
                    ribType: routeSet.ribType,
                    total: routeSet.total,
                    sample: prefix || null
                });
            }
        }
    }
}

async function verifyAllLocRibScopes(page, live, controller) {
    live.report.uiLocRibScopes = [];
    for (const device of live.report.devices) {
        await page.goto(await getClientMonitorRoute(controller, 'bmp-loc-rib', device.remoteIp));
        const root = page.getByTestId('bmp-loc-rib-page');
        await expect(root).toBeVisible();
        await expect.poll(() => page.title()).toBe(`Loc-RIB · ${clientLabel(device)}`);
        await expect(page.locator('.monitor-window-header')).toHaveCount(0);
        await expect(root.locator('.client-tabs')).toHaveCount(0);
        for (const instance of device.locRib.filter(item => item.total > 0)) {
            await root
                .locator('.bmp-inner-tabs [role="tab"]')
                .filter({ hasText: locRibTabLabel(instance) })
                .first()
                .click();
            const routeTable = root.locator('[data-testid="bmp-loc-rib-route-table"]:visible').first();
            await expect(routeTable.locator('tbody tr:not(.nn-table-placeholder)')).not.toHaveCount(0, {
                timeout: 20000
            });
            const prefix = instance.samples[0]?.ip;
            if (prefix) await expect(routeTable).toContainText(prefix, { timeout: 20000 });
            live.report.uiLocRibScopes.push({
                device: device.remoteIp,
                af: instance.af,
                afi: instance.afi,
                safi: instance.safi,
                total: instance.total,
                sample: prefix || null
            });
        }
    }
}

async function verifyPages(page, live, controller) {
    const screenshotDirectory = path.join(live.lab.artifactDirectory, 'screenshots');
    fs.mkdirSync(screenshotDirectory, { recursive: true });

    await page.goto('/#/bmp/bmp-config');
    const clientTable = page.getByTestId('bmp-client-table');
    await expect(clientTable).toContainText('192.168.93.11', { timeout: 20000 });
    await expect(clientTable).toContainText('192.168.93.22');
    await expect(clientTable).toContainText('BMPv4');
    await expect(clientTable).toContainText('draft-19');
    await page.screenshot({
        path: path.join(screenshotDirectory, `${live.scenario.key}-clients.png`),
        fullPage: true
    });

    const hasAdjRibRoutes = live.report.devices.some(device =>
        device.sessions.some(session => session.routes.some(route => route.total > 0))
    );
    await verifyAllSessionScopes(page, live, controller);
    if (!hasAdjRibRoutes) {
        await expect(page.locator('[data-testid="bmp-session-route-table"]:visible').first()).toBeVisible();
    }
    await page.screenshot({
        path: path.join(screenshotDirectory, `${live.scenario.key}-sessions.png`),
        fullPage: true
    });

    if (live.scenario.families.some(family => family.locRib)) {
        await verifyAllLocRibScopes(page, live, controller);
        await page.screenshot({
            path: path.join(screenshotDirectory, `${live.scenario.key}-loc-rib.png`),
            fullPage: true
        });
    }
}

async function verifyUiStopRestart(page, live) {
    await page.goto('/#/bmp/bmp-config');
    await page.getByTestId('bmp-stop-button').click();
    await expect(page.getByTestId('bmp-start-button')).toBeEnabled({ timeout: 15000 });
    await page.getByTestId('bmp-start-button').click();
    await expect(page.getByTestId('bmp-stop-button')).toBeEnabled({ timeout: 15000 });
    // Huawei retries a deliberately stopped BMP transport on its own backoff timer.
    // Allow a full retry cycle before treating UI stop/start as failed.
    await live.waitForData({ timeoutMs: 180000 });
    await expect(page.getByTestId('bmp-client-table')).toContainText('192.168.93.11', { timeout: 20000 });
    await expect(page.getByTestId('bmp-client-table')).toContainText('192.168.93.22');
}

test.describe('Huawei BMP live device pages', () => {
    test.skip(!LIVE_ENABLED, 'Set HUAWEI_BMP_E2E=1 and the Huawei credential environment variables');

    for (const scenario of HUAWEI_BMP_SCENARIOS) {
        test(`${scenario.key}: real devices render BMP pages`, async ({ page }) => {
            test.setTimeout(8 * 60 * 1000);
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
                await live.waitForData({ timeoutMs: scenario.key.startsWith('evpn') ? 90000 : 180000 });
                await live.collectFinal();
                await verifyPages(page, live, controller);
                if (scenario.key === 'public-unicast') await verifyUiStopRestart(page, live);
                expect.soft(live.report.setupIssues, 'scenario setup issues').toEqual([]);
                expect.soft(live.report.codeIssues, 'real-device parser/UI issues').toEqual([]);
            } catch (error) {
                scenarioError = error;
                live.report.setupIssues.push({
                    detail: `Playwright scenario failed: ${error.message}`,
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
