const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { getBrowserMockScript } = require('../../scripts/e2e-support');

const CLIENT = {
    persistentSourceId: 'incremental-source',
    persistentConnectionId: 'incremental-connection',
    connectionState: 'open',
    isOnline: true,
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '192.0.2.10',
    remotePort: 49152,
    sysName: 'incremental-router'
};
const OTHER_CLIENT = {
    ...CLIENT,
    persistentSourceId: 'other-incremental-source',
    persistentConnectionId: 'other-incremental-connection',
    remoteIp: '198.51.100.10',
    remotePort: 49200,
    sysName: 'other-incremental-router'
};
const CLIENT_KEY = encodeURIComponent(`source:${CLIENT.persistentSourceId}`);
const SESSION_MONITOR_ROUTE = `/#/monitor/bmp-client?clientKey=${CLIENT_KEY}&view=session`;
const LOC_RIB_MONITOR_ROUTE = `/#/monitor/bmp-client?clientKey=${CLIENT_KEY}&view=loc-rib`;

function scope(scopeId, ownerKey, ribType = 2, client = CLIENT) {
    return {
        persistentScopeId: scopeId,
        scopeId,
        persistentSourceId: client.persistentSourceId,
        persistentOwnerKey: ownerKey,
        ownerKey,
        afi: 1,
        safi: 1,
        addrFamilyType: 1,
        ribType,
        scopeState: 'ready',
        routeSummary: { active: 60, stale: 0, total: 60 }
    };
}

function session(ownerKey, scopeId, ip, asn, vrfName, client = CLIENT) {
    return {
        persistentSourceId: client.persistentSourceId,
        persistentOwnerKey: ownerKey,
        ownerKey,
        connectionState: 'open',
        isOnline: true,
        sessionType: 0,
        sessionRd: '0:0',
        sessionIp: ip,
        sessionAs: asn,
        sessionState: 0,
        enabledAddressFamilies: [{ afi: 1, safi: 1 }],
        enabledAddrFamilyTypes: [1],
        ribTypes: [2],
        vrfTableNames: [vrfName],
        routeScopes: [scope(scopeId, ownerKey, 2, client)]
    };
}

function instance(ownerKey, scopeId, vrfName, client = CLIENT) {
    return {
        persistentSourceId: client.persistentSourceId,
        persistentOwnerKey: ownerKey,
        ownerKey,
        persistentScopeId: scopeId,
        scopeId,
        connectionState: 'open',
        isOnline: true,
        instanceType: 3,
        instanceRd: '0:0',
        instanceIp: '0.0.0.0',
        instanceAs: 0,
        instanceState: 0,
        afi: 1,
        safi: 1,
        addrFamilyType: 1,
        enabledAddressFamilies: [{ afi: 1, safi: 1 }],
        enabledAddrFamilyTypes: [1],
        ribTypes: ['loc-rib'],
        vrfTableNames: [vrfName],
        routeScopes: [scope(scopeId, ownerKey, 'loc-rib', client)],
        routeSummary: { active: 60, stale: 0, total: 60 }
    };
}

const SESSION_A = session('session-owner-a', 'session-scope-a', '192.0.2.2', 65000, 'global');
const SESSION_B = session('session-owner-b', 'session-scope-b', '192.0.2.3', 65001, 'blue');
const OTHER_SESSION = session(
    'other-session-owner',
    'other-session-scope',
    '198.51.100.2',
    65100,
    'other',
    OTHER_CLIENT
);
const INSTANCE_A = instance('instance-owner-a', 'instance-scope-a', 'global');
const INSTANCE_B = instance('instance-owner-b', 'instance-scope-b', 'blue');
const OTHER_INSTANCE = instance('other-instance-owner', 'other-instance-scope', 'other', OTHER_CLIENT);

function route(scopeId, page) {
    const index = (page - 1) * 25;
    return {
        persistentScopeId: scopeId,
        routeKey: `0|0:0|10.0.${index}.0|24`,
        addrFamilyType: 1,
        afi: 1,
        safi: 1,
        ip: `10.0.${index}.0`,
        mask: 24,
        rd: '0:0',
        pathId: 0,
        nextHop: '192.0.2.254',
        asPath: '65000',
        parseStatus: 0,
        routeState: 'active'
    };
}

function success(data) {
    return { status: 'success', data };
}

test.describe('BMP incremental route pages', () => {
    let calls;
    let sessionRoutesAvailable;
    let instanceRoutesAvailable;

    test.beforeEach(async ({ page }) => {
        calls = [];
        sessionRoutesAvailable = true;
        instanceRoutesAvailable = true;
        await page.exposeFunction('__bmpE2eCall', async (method, ...args) => {
            calls.push({ method, args });
            switch (method) {
                case 'getClientList':
                    return success([CLIENT]);
                case 'getBgpSessions':
                    return success([SESSION_A]);
                case 'getBgpRoutes': {
                    const request = args[0];
                    const scopeId = request.session.persistentScopeId;
                    return success({
                        list: sessionRoutesAvailable ? [route(scopeId, request.page)] : [],
                        total: sessionRoutesAvailable ? 60 : 0,
                        summary: sessionRoutesAvailable
                            ? { active: 60, stale: 0, total: 60 }
                            : { active: 0, stale: 0, total: 0 }
                    });
                }
                case 'getBgpInstances':
                    return success([INSTANCE_A]);
                case 'getBgpInstanceRoutes': {
                    const request = args[0];
                    const scopeId = request.instance.persistentScopeId;
                    return success({
                        list: instanceRoutesAvailable ? [route(scopeId, request.page)] : [],
                        total: instanceRoutesAvailable ? 60 : 0,
                        summary: instanceRoutesAvailable
                            ? { active: 60, stale: 0, total: 60 }
                            : { active: 0, stale: 0, total: 0 }
                    });
                }
                default:
                    return success(null);
            }
        });
        await page.addInitScript({ content: getBrowserMockScript('bmp') });
    });

    test('upserts Session tabs and refreshes only the active current page', async ({ page }) => {
        await page.goto(SESSION_MONITOR_ROUTE);
        const routeTable = page.getByTestId('bmp-session-route-table');
        await expect(routeTable).toContainText('10.0.0.0');
        const originalTab = page.getByRole('tab', { name: /192\.0\.2\.2/ });

        await page.getByRole('radio', { name: '当前', exact: true }).click();
        await page.getByPlaceholder('Prefix 或 Prefix/Mask').fill('10.0.0.0/8');
        await page.getByPlaceholder('Prefix 或 Prefix/Mask').press('Enter');
        await expect
            .poll(() => calls.filter(call => call.method === 'getBgpRoutes').at(-1)?.args[0])
            .toMatchObject({ routeState: 'active', prefixFilter: '10.0.0.0/8' });

        const pagination = routeTable.getByRole('navigation', { name: '表格分页' });
        const secondPageButton = pagination.getByRole('button', { name: '2', exact: true });
        await secondPageButton.click();
        await expect(routeTable).toContainText('10.0.25.0');
        await expect(secondPageButton).toHaveAttribute('aria-current', 'page');

        const sessionCallsBefore = calls.filter(call => call.method === 'getBgpSessions').length;
        const routeCallsBefore = calls.filter(call => call.method === 'getBgpRoutes').length;

        await page.evaluate(
            ({ client, nextSession }) => {
                window.__bmpE2eEmit('bmp:sessionUpdate', {
                    status: 'success',
                    data: { client, session: nextSession }
                });
            },
            { client: CLIENT, nextSession: SESSION_B }
        );

        const newTab = page.getByRole('tab', { name: /192\.0\.2\.3/ });
        await expect(newTab).toBeVisible();
        await expect(newTab).toHaveAttribute('aria-selected', 'false');
        await expect(secondPageButton).toHaveAttribute('aria-current', 'page');
        await expect(page.getByTestId('bmp-session-route-table')).toHaveCount(1);
        await page.waitForTimeout(100);
        expect(calls.filter(call => call.method === 'getBgpSessions').length).toBe(sessionCallsBefore);
        expect(calls.filter(call => call.method === 'getBgpRoutes').length).toBe(routeCallsBefore);

        await page.evaluate(
            ({ client, hiddenSession }) => {
                window.__bmpE2eEmit('bmp:routeUpdate', {
                    status: 'success',
                    data: { client, session: hiddenSession, af: 1, ribType: 2, scopeId: hiddenSession.scopeId }
                });
            },
            { client: CLIENT, hiddenSession: SESSION_B }
        );
        await page.waitForTimeout(100);
        expect(calls.filter(call => call.method === 'getBgpRoutes').length).toBe(routeCallsBefore);

        await page.evaluate(
            ({ sourceId, scopeId }) => {
                window.__bmpE2eEmit('bmp:routeUpdate', {
                    status: 'success',
                    data: {
                        batch: true,
                        updates: [
                            {
                                sourceId,
                                scopeId,
                                af: 1,
                                ribType: 2,
                                reason: 'reconnect-refresh-timeout',
                                projectionReset: true
                            }
                        ]
                    }
                });
            },
            { sourceId: CLIENT.persistentSourceId, scopeId: SESSION_A.routeScopes[0].persistentScopeId }
        );
        await expect
            .poll(() => calls.filter(call => call.method === 'getBgpRoutes').length)
            .toBeGreaterThan(routeCallsBefore);
        const latestRouteRequest = calls.filter(call => call.method === 'getBgpRoutes').at(-1).args[0];
        expect(latestRouteRequest.page).toBe(2);
        expect(latestRouteRequest.routeState).toBe('active');
        expect(latestRouteRequest.prefixFilter).toBe('10.0.0.0/8');
        expect(latestRouteRequest.session.persistentScopeId).toBe(SESSION_A.routeScopes[0].persistentScopeId);
        await expect(secondPageButton).toHaveAttribute('aria-current', 'page');

        await newTab.click();
        await expect
            .poll(() =>
                calls
                    .filter(call => call.method === 'getBgpRoutes')
                    .some(call => call.args[0].session.persistentScopeId === SESSION_B.routeScopes[0].persistentScopeId)
            )
            .toBe(true);
        await originalTab.click();
        await expect(originalTab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByTestId('bmp-session-route-table')).toHaveCount(1);

        sessionRoutesAvailable = false;
        await page.evaluate(
            ({ sourceId, scopeId }) => {
                window.__bmpE2eEmit('bmp:routeUpdate', {
                    status: 'success',
                    data: {
                        batch: true,
                        updates: [
                            {
                                sourceId,
                                scopeId,
                                reason: 'reconnect-refresh-timeout',
                                projectionReset: true
                            }
                        ]
                    }
                });
            },
            { sourceId: CLIENT.persistentSourceId, scopeId: SESSION_A.routeScopes[0].persistentScopeId }
        );
        await expect(routeTable).not.toContainText('10.0.25.0');
    });

    test('upserts Loc-RIB tabs and ignores inactive instance route events', async ({ page }) => {
        await page.goto(LOC_RIB_MONITOR_ROUTE);
        const routeTable = page.getByTestId('bmp-loc-rib-route-table');
        await expect(routeTable).toContainText('10.0.0.0');
        const originalTab = page.getByRole('tab', { name: /global/ });

        await page.getByRole('radio', { name: '当前', exact: true }).click();
        await page.getByPlaceholder('Prefix 或 Prefix/Mask').fill('10.0.0.0/8');
        await page.getByPlaceholder('Prefix 或 Prefix/Mask').press('Enter');
        await expect
            .poll(() => calls.filter(call => call.method === 'getBgpInstanceRoutes').at(-1)?.args[0])
            .toMatchObject({ routeState: 'active', prefixFilter: '10.0.0.0/8' });

        const pagination = routeTable.getByRole('navigation', { name: '表格分页' });
        const secondPageButton = pagination.getByRole('button', { name: '2', exact: true });
        await secondPageButton.click();
        await expect(routeTable).toContainText('10.0.25.0');
        await expect(secondPageButton).toHaveAttribute('aria-current', 'page');

        const instanceCallsBefore = calls.filter(call => call.method === 'getBgpInstances').length;
        const routeCallsBefore = calls.filter(call => call.method === 'getBgpInstanceRoutes').length;

        await page.evaluate(
            ({ client, nextInstance }) => {
                window.__bmpE2eEmit('bmp:instanceUpdate', {
                    status: 'success',
                    data: { client, instance: nextInstance }
                });
            },
            { client: CLIENT, nextInstance: INSTANCE_B }
        );

        const newTab = page.getByRole('tab', { name: /blue/ });
        await expect(newTab).toBeVisible();
        await expect(newTab).toHaveAttribute('aria-selected', 'false');
        await expect(secondPageButton).toHaveAttribute('aria-current', 'page');
        await expect(page.getByTestId('bmp-loc-rib-route-table')).toHaveCount(1);
        await page.waitForTimeout(100);
        expect(calls.filter(call => call.method === 'getBgpInstances').length).toBe(instanceCallsBefore);
        expect(calls.filter(call => call.method === 'getBgpInstanceRoutes').length).toBe(routeCallsBefore);

        await page.evaluate(
            ({ client, hiddenInstance }) => {
                window.__bmpE2eEmit('bmp:instanceRouteUpdate', {
                    status: 'success',
                    data: { client, instance: hiddenInstance, af: 1, scopeId: hiddenInstance.scopeId }
                });
            },
            { client: CLIENT, hiddenInstance: INSTANCE_B }
        );
        await page.waitForTimeout(100);
        expect(calls.filter(call => call.method === 'getBgpInstanceRoutes').length).toBe(routeCallsBefore);

        await page.evaluate(
            ({ sourceId, scopeId }) => {
                window.__bmpE2eEmit('bmp:instanceRouteUpdate', {
                    status: 'success',
                    data: {
                        batch: true,
                        updates: [
                            {
                                sourceId,
                                scopeId,
                                af: 1,
                                reason: 'reconnect-refresh-timeout',
                                projectionReset: true
                            }
                        ]
                    }
                });
            },
            { sourceId: CLIENT.persistentSourceId, scopeId: INSTANCE_A.persistentScopeId }
        );
        await expect
            .poll(() => calls.filter(call => call.method === 'getBgpInstanceRoutes').length)
            .toBeGreaterThan(routeCallsBefore);
        const latestRouteRequest = calls.filter(call => call.method === 'getBgpInstanceRoutes').at(-1).args[0];
        expect(latestRouteRequest.page).toBe(2);
        expect(latestRouteRequest.routeState).toBe('active');
        expect(latestRouteRequest.prefixFilter).toBe('10.0.0.0/8');
        expect(latestRouteRequest.instance.persistentScopeId).toBe(INSTANCE_A.persistentScopeId);
        await expect(secondPageButton).toHaveAttribute('aria-current', 'page');

        await newTab.click();
        await expect
            .poll(() =>
                calls
                    .filter(call => call.method === 'getBgpInstanceRoutes')
                    .some(call => call.args[0].instance.persistentScopeId === INSTANCE_B.persistentScopeId)
            )
            .toBe(true);
        await originalTab.click();
        await expect(originalTab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByTestId('bmp-loc-rib-route-table')).toHaveCount(1);

        instanceRoutesAvailable = false;
        await page.evaluate(
            ({ sourceId, scopeId }) => {
                window.__bmpE2eEmit('bmp:instanceRouteUpdate', {
                    status: 'success',
                    data: {
                        batch: true,
                        updates: [
                            {
                                sourceId,
                                scopeId,
                                reason: 'reconnect-refresh-timeout',
                                projectionReset: true
                            }
                        ]
                    }
                });
            },
            { sourceId: CLIENT.persistentSourceId, scopeId: INSTANCE_A.persistentScopeId }
        );
        await expect(routeTable).not.toContainText('10.0.25.0');
    });

    test('keeps the monitored Client isolated from another Client incremental events', async ({ page }) => {
        await page.goto(SESSION_MONITOR_ROUTE);
        const sessionPage = page.getByTestId('bmp-session-page');
        const sessionRouteTable = page.getByTestId('bmp-session-route-table');
        const originalSessionTab = page.getByRole('tab', { name: /192\.0\.2\.2/ });
        await expect(originalSessionTab).toBeVisible();
        await expect(sessionRouteTable).toContainText('10.0.0.0');

        const sessionCallsBeforeOther = calls.filter(call => call.method === 'getBgpSessions').length;
        const sessionRouteCallsBeforeOther = calls.filter(call => call.method === 'getBgpRoutes').length;

        await page.evaluate(
            ({ otherClient, otherSession, monitoredScopeId }) => {
                window.__bmpE2eEmit('bmp:sessionUpdate', {
                    status: 'success',
                    data: { client: otherClient, session: otherSession }
                });
                window.__bmpE2eEmit('bmp:routeUpdate', {
                    status: 'success',
                    data: {
                        client: otherClient,
                        sourceId: otherClient.persistentSourceId,
                        session: otherSession,
                        scopeId: monitoredScopeId,
                        af: 1,
                        ribType: 2,
                        projectionReset: true
                    }
                });
            },
            {
                otherClient: OTHER_CLIENT,
                otherSession: OTHER_SESSION,
                monitoredScopeId: SESSION_A.routeScopes[0].persistentScopeId
            }
        );

        await page.waitForTimeout(100);
        await expect(sessionPage.getByRole('tab')).toHaveCount(1);
        await expect(sessionPage.getByRole('tab', { name: /198\.51\.100\.2/ })).toHaveCount(0);
        await expect(sessionRouteTable).toContainText('10.0.0.0');
        expect(calls.filter(call => call.method === 'getBgpSessions').length).toBe(sessionCallsBeforeOther);
        expect(calls.filter(call => call.method === 'getBgpRoutes').length).toBe(sessionRouteCallsBeforeOther);

        await page.evaluate(
            ({ client, nextSession, activeSession }) => {
                window.__bmpE2eEmit('bmp:sessionUpdate', {
                    status: 'success',
                    data: { client, session: nextSession }
                });
                window.__bmpE2eEmit('bmp:routeUpdate', {
                    status: 'success',
                    data: {
                        client,
                        sourceId: client.persistentSourceId,
                        session: activeSession,
                        scopeId: activeSession.routeScopes[0].persistentScopeId,
                        af: 1,
                        ribType: 2,
                        projectionReset: true
                    }
                });
            },
            { client: CLIENT, nextSession: SESSION_B, activeSession: SESSION_A }
        );

        await expect(sessionPage.getByRole('tab', { name: /192\.0\.2\.3/ })).toBeVisible();
        await expect
            .poll(() => calls.filter(call => call.method === 'getBgpRoutes').length)
            .toBeGreaterThan(sessionRouteCallsBeforeOther);

        await page.goto(LOC_RIB_MONITOR_ROUTE);
        const locRibPage = page.getByTestId('bmp-loc-rib-page');
        const instanceRouteTable = page.getByTestId('bmp-loc-rib-route-table');
        const originalInstanceTab = page.getByRole('tab', { name: /global/ });
        await expect(originalInstanceTab).toBeVisible();
        await expect(instanceRouteTable).toContainText('10.0.0.0');

        const instanceCallsBeforeOther = calls.filter(call => call.method === 'getBgpInstances').length;
        const instanceRouteCallsBeforeOther = calls.filter(call => call.method === 'getBgpInstanceRoutes').length;

        await page.evaluate(
            ({ otherClient, otherInstance, monitoredScopeId }) => {
                window.__bmpE2eEmit('bmp:instanceUpdate', {
                    status: 'success',
                    data: { client: otherClient, instance: otherInstance }
                });
                window.__bmpE2eEmit('bmp:instanceRouteUpdate', {
                    status: 'success',
                    data: {
                        client: otherClient,
                        sourceId: otherClient.persistentSourceId,
                        instance: otherInstance,
                        scopeId: monitoredScopeId,
                        af: 1,
                        projectionReset: true
                    }
                });
            },
            {
                otherClient: OTHER_CLIENT,
                otherInstance: OTHER_INSTANCE,
                monitoredScopeId: INSTANCE_A.persistentScopeId
            }
        );

        await page.waitForTimeout(100);
        await expect(locRibPage.getByRole('tab')).toHaveCount(1);
        await expect(locRibPage.getByRole('tab', { name: /other/ })).toHaveCount(0);
        await expect(instanceRouteTable).toContainText('10.0.0.0');
        expect(calls.filter(call => call.method === 'getBgpInstances').length).toBe(instanceCallsBeforeOther);
        expect(calls.filter(call => call.method === 'getBgpInstanceRoutes').length).toBe(instanceRouteCallsBeforeOther);

        await page.evaluate(
            ({ client, nextInstance, activeInstance }) => {
                window.__bmpE2eEmit('bmp:instanceUpdate', {
                    status: 'success',
                    data: { client, instance: nextInstance }
                });
                window.__bmpE2eEmit('bmp:instanceRouteUpdate', {
                    status: 'success',
                    data: {
                        client,
                        sourceId: client.persistentSourceId,
                        instance: activeInstance,
                        scopeId: activeInstance.persistentScopeId,
                        af: 1,
                        projectionReset: true
                    }
                });
            },
            { client: CLIENT, nextInstance: INSTANCE_B, activeInstance: INSTANCE_A }
        );

        await expect(locRibPage.getByRole('tab', { name: /blue/ })).toBeVisible();
        await expect
            .poll(() => calls.filter(call => call.method === 'getBgpInstanceRoutes').length)
            .toBeGreaterThan(instanceRouteCallsBeforeOther);
    });
});
