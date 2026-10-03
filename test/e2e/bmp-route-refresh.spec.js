const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { bmpBrowserMockScript } = require('../../scripts/e2e-support/bmp');

// Render the real pages and their normal unified-event listeners. The mock DB
// exposes only committed rows, so updating its count does not itself notify UI.
function installRouteRefreshFixture() {
    const sourceId = 'a'.repeat(64);
    const client = {
        persistentSourceId: sourceId,
        persistentConnectionId: 'refresh-connection',
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.1',
        remotePort: 20001,
        sysName: 'route-refresh-router',
        isOnline: true,
        connectionState: 'open'
    };
    const peerScopeId = 'refresh-peer-scope';
    const instanceScopeId = 'refresh-loc-rib-scope';
    const session = {
        persistentOwnerKey: 'refresh-peer-owner',
        sessionType: 0,
        sessionRd: '0:0',
        sessionIp: '192.0.2.2',
        sessionAs: 64512,
        sessionRouterId: '192.0.2.2',
        sessionFlags: 0,
        rawSessionFlags: 0,
        enabledAddrFamilyTypes: [1],
        ribTypes: ['1'],
        routeScopes: [{ persistentScopeId: peerScopeId, afi: 1, safi: 1, ribType: '1' }],
        addPathMap: {},
        peerUpTlvs: [],
        isOnline: true,
        connectionState: 'open'
    };
    const instance = {
        persistentScopeId: instanceScopeId,
        persistentOwnerKey: 'refresh-loc-rib-owner',
        instanceType: 3,
        instanceRd: '64512:1',
        instanceIp: '192.0.2.1',
        instanceAs: 64512,
        instanceRouterId: '192.0.2.1',
        instanceFlags: 0,
        rawInstanceFlags: 0,
        addrFamilyType: 1,
        vrfTableNames: ['refresh-vrf'],
        peerUpTlvs: [],
        isOnline: true,
        connectionState: 'open'
    };
    const state = {
        sourceId,
        peerScopeId,
        instanceScopeId,
        totals: { [peerScopeId]: 70233, [instanceScopeId]: 70233 },
        queries: []
    };
    const success = data => ({ status: 'success', data });
    const query = (selectedClient, scopeId, page) => {
        state.queries.push({ sourceId: selectedClient.persistentSourceId, scopeId, page });
        const total = state.totals[scopeId];
        return Promise.resolve(
            success({
                list: [
                    {
                        routeKey: 'visible-route',
                        ip: '203.0.113.0',
                        mask: 24,
                        nextHop: '192.0.2.1',
                        asPath: '64512',
                        rd: '0:0',
                        pathId: 0,
                        labels: [],
                        routeState: 'active'
                    }
                ],
                total,
                summary: { active: total, stale: 0, total }
            })
        );
    };
    window.bmpApi.getClientList = async () => success([structuredClone(client)]);
    window.bmpApi.getClient = async () => success(structuredClone(client));
    window.bmpApi.getBgpSessions = async () => success([structuredClone(session)]);
    window.bmpApi.getBgpInstances = async () => success([structuredClone(instance)]);
    window.bmpApi.getBgpRoutes = (selectedClient, selectedSession, _af, _rib, page) =>
        query(selectedClient, selectedSession.persistentScopeId, page);
    window.bmpApi.getBgpInstanceRoutes = (selectedClient, selectedInstance, page) =>
        query(selectedClient, selectedInstance.persistentScopeId, page);
    window.__routeRefreshFixture = {
        state,
        commit(scopeId, total) {
            state.totals[scopeId] = total;
        },
        notify(instancePage, updates) {
            window.__bmpE2eEmit(
                instancePage ? 'bmp:instanceRouteUpdate' : 'bmp:routeUpdate',
                success({
                    batch: true,
                    updates: updates.map(update => ({
                        type: 1,
                        changedCount: 0,
                        reason: 'persistence-commit',
                        assuranceIncremental: true,
                        client: {
                            sourceId: update.sourceId,
                            persistentSourceId: update.sourceId,
                            connectionId: 'refresh-connection',
                            persistentConnectionId: 'refresh-connection'
                        },
                        ...update
                    }))
                })
            );
        }
    };
}

for (const instancePage of [false, true]) {
    const view = instancePage ? 'loc-rib' : 'session';
    const rootId = instancePage ? 'bmp-loc-rib-page' : 'bmp-session-page';
    const scopeId = instancePage ? 'refresh-loc-rib-scope' : 'refresh-peer-scope';

    test(`BMP ${view} final commit refreshes 70233 to 100000 without switching tabs`, async ({ page }) => {
        await page.addInitScript({ content: `${bmpBrowserMockScript}\n(${installRouteRefreshFixture.toString()})();` });
        await page.goto(
            `/#/monitor/bmp-client?clientKey=${encodeURIComponent(`source:${'a'.repeat(64)}`)}&view=${view}`
        );
        const originalUrl = page.url();
        const root = page.getByTestId(rootId);
        const activeTag = root.locator('.route-toolbar-status .nn-tag').filter({ hasText: /^当前 / });
        const totalText = root.locator('.route-table .nn-pagination-total');
        await expect(activeTag).toHaveText('当前 70233');
        await expect(totalText).toHaveText('共 70233 条，每页 25 条');

        const queryCount = await page.evaluate(() => window.__routeRefreshFixture.state.queries.length);
        await page.evaluate(
            ({ scopeId, loc }) => {
                const fixture = window.__routeRefreshFixture;
                fixture.commit(scopeId, 100000);
                // Foreign source, obsolete scope, and the same source/scope on
                // an old connection must neither refresh nor overwrite this page.
                fixture.notify(loc, [
                    { sourceId: 'b'.repeat(64), scopeId },
                    { sourceId: fixture.state.sourceId, scopeId: 'old-disconnected-scope' },
                    {
                        sourceId: fixture.state.sourceId,
                        scopeId,
                        client: {
                            sourceId: fixture.state.sourceId,
                            persistentSourceId: fixture.state.sourceId,
                            connectionId: 'old-refresh-connection',
                            persistentConnectionId: 'old-refresh-connection'
                        }
                    }
                ]);
            },
            { scopeId, loc: instancePage }
        );
        // Wait beyond the existing 1.5s throttle window to catch a mistakenly
        // scheduled refresh, not just an immediate synchronous no-op.
        await page.waitForTimeout(1700);
        expect(await page.evaluate(() => window.__routeRefreshFixture.state.queries.length)).toBe(queryCount);
        await expect(activeTag).toHaveText('当前 70233');
        await expect(totalText).toHaveText('共 70233 条，每页 25 条');

        // This is the single final notification emitted only after DB commit.
        await page.evaluate(
            ({ scopeId, loc }) => {
                const fixture = window.__routeRefreshFixture;
                fixture.notify(loc, [{ sourceId: fixture.state.sourceId, scopeId }]);
            },
            { scopeId, loc: instancePage }
        );
        await expect(activeTag).toHaveText('当前 100000');
        await expect(totalText).toHaveText('共 100000 条，每页 25 条');
        expect(page.url()).toBe(originalUrl);
        const queries = await page.evaluate(() => window.__routeRefreshFixture.state.queries);
        expect(queries.length).toBe(queryCount + 1);
        expect(queries.at(-1)).toEqual({ sourceId: 'a'.repeat(64), scopeId, page: 1 });

        // Adjacent successful batches are coalesced, but the next trailing read
        // must still observe the final commit rather than the previous total.
        await page.evaluate(
            ({ scopeId, loc }) => {
                const fixture = window.__routeRefreshFixture;
                for (const total of [100000, 100001, 100001]) {
                    fixture.commit(scopeId, total);
                    fixture.notify(loc, [{ sourceId: fixture.state.sourceId, scopeId }]);
                }
            },
            { scopeId, loc: instancePage }
        );
        await expect(activeTag).toHaveText('当前 100001');
        await expect(totalText).toHaveText('共 100001 条，每页 25 条');
        expect(page.url()).toBe(originalUrl);
        const finalQueries = await page.evaluate(() => window.__routeRefreshFixture.state.queries);
        expect(finalQueries.length).toBe(queryCount + 2);
        expect(finalQueries.at(-1)).toEqual({ sourceId: 'a'.repeat(64), scopeId, page: 1 });
    });
}
