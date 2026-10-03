const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { bmpBrowserMockScript } = require('../../scripts/e2e-support/bmp');

// Only the IPC bridge is deferred. These tests render the real monitor pages,
// use their normal unified-event subscription, and never open a user database.
function installStalePurgeFixture() {
    const sourceId = 'a'.repeat(64);
    const client = {
        persistentSourceId: sourceId,
        persistentConnectionId: 'connection-test',
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.1',
        remotePort: 20001,
        sysName: 'purge-test-router',
        isOnline: false,
        connectionState: 'closed'
    };
    const scopes = [
        { persistentScopeId: 'peer-pre', afi: 1, safi: 1, ribType: '1' },
        { persistentScopeId: 'peer-post', afi: 1, safi: 1, ribType: '2' }
    ];
    const session = {
        persistentOwnerKey: 'peer-owner',
        sessionType: 0,
        sessionRd: '0:0',
        sessionIp: '192.0.2.2',
        sessionAs: 64512,
        sessionRouterId: '192.0.2.2',
        sessionFlags: 0,
        rawSessionFlags: 0,
        enabledAddrFamilyTypes: [1],
        ribTypes: ['1', '2'],
        routeScopes: scopes,
        addPathMap: {},
        peerUpTlvs: [],
        isOnline: false,
        connectionState: 'closed'
    };
    const instances = ['blue', 'red'].map(name => ({
        persistentScopeId: `loc-${name}`,
        persistentOwnerKey: `loc-owner-${name}`,
        instanceType: 3,
        instanceRd: name === 'blue' ? '64512:1' : '64512:2',
        instanceIp: '192.0.2.1',
        instanceAs: 64512,
        instanceRouterId: '192.0.2.1',
        instanceFlags: 0,
        rawInstanceFlags: 0,
        addrFamilyType: 1,
        vrfTableNames: [name],
        peerUpTlvs: [],
        isOnline: false,
        connectionState: 'closed'
    }));
    const state = {
        sourceId,
        stale: { 'peer-pre': 12, 'peer-post': 12, 'loc-blue': 12, 'loc-red': 12 },
        requests: [],
        queries: [],
        pendingReads: [],
        gateReads: false
    };
    const success = data => ({ status: 'success', data });
    const routeResult = scopeId =>
        success({
            list: [],
            total: state.stale[scopeId],
            summary: {
                active: 0,
                stale: state.stale[scopeId],
                total: state.stale[scopeId]
            }
        });
    const query = (scopeId, page) => {
        state.queries.push({ scopeId, page });
        if (!state.gateReads) return Promise.resolve(routeResult(scopeId));
        return new Promise(resolve => state.pendingReads.push(() => resolve(routeResult(scopeId))));
    };
    const purge = scopeId => new Promise(resolve => state.requests.push({ scopeId, resolve }));
    window.bmpApi.getClientList = async () => success([structuredClone(client)]);
    window.bmpApi.getClient = async () => success(structuredClone(client));
    window.bmpApi.getBgpSessions = async () => success([structuredClone(session)]);
    window.bmpApi.getBgpInstances = async () => success(structuredClone(instances));
    window.bmpApi.getBgpRoutes = (_client, selectedSession, _af, _rib, page) =>
        query(selectedSession.persistentScopeId, page);
    window.bmpApi.getBgpInstanceRoutes = (_client, instance, page) => query(instance.persistentScopeId, page);
    window.bmpApi.purgeStaleBgpRoutes = (_client, selectedSession) => purge(selectedSession.persistentScopeId);
    window.bmpApi.purgeStaleBgpInstanceRoutes = (_client, instance) => purge(instance.persistentScopeId);
    window.__stalePurgeFixture = {
        state,
        update(scopeId, stale, instancePage) {
            state.stale[scopeId] = stale;
            window.__bmpE2eEmit(
                instancePage ? 'bmp:instanceRouteUpdate' : 'bmp:routeUpdate',
                success({
                    sourceId,
                    scopeId,
                    action: 'routeDelete',
                    projectionReset: true
                })
            );
        },
        resolve(index, response) {
            const request = state.requests[index];
            if (response.status === 'success') state.stale[request.scopeId] = 0;
            request.resolve(response);
        },
        releaseReads() {
            state.gateReads = false;
            state.pendingReads.splice(0).forEach(resolve => resolve());
        }
    };
}

for (const instancePage of [false, true]) {
    const view = instancePage ? 'loc-rib' : 'session';
    const rootId = instancePage ? 'bmp-loc-rib-page' : 'bmp-session-page';
    const buttonId = instancePage ? 'bmp-loc-rib-purge-stale' : 'bmp-peer-purge-stale';
    const firstScope = instancePage ? 'loc-blue' : 'peer-pre';

    test(`BMP ${view} stale purge remains responsive and scope-safe`, async ({ page }) => {
        await page.addInitScript({ content: `${bmpBrowserMockScript}\n(${installStalePurgeFixture.toString()})();` });
        await page.goto(
            `/#/monitor/bmp-client?clientKey=${encodeURIComponent(`source:${'a'.repeat(64)}`)}&view=${view}`
        );
        const root = page.getByTestId(rootId);
        const button = root.getByTestId(buttonId);
        const staleTag = root.locator('.route-toolbar-status .nn-tag').filter({ hasText: /^过期 / });
        await expect(staleTag).toHaveText('过期 12');
        await button.click();
        await expect(button).toHaveText('清理中…');
        await expect(button).toBeDisabled();
        await button.dispatchEvent('click');
        await expect.poll(() => page.evaluate(() => window.__stalePurgeFixture.state.requests.length)).toBe(1);

        await page.evaluate(({ scopeId, loc }) => window.__stalePurgeFixture.update(scopeId, 7, loc), {
            scopeId: firstScope,
            loc: instancePage
        });
        await expect(staleTag).toHaveText('过期 7');
        await expect(button).toHaveText('清理中…');
        await expect(button).toBeDisabled();

        await page.evaluate(() => {
            window.__stalePurgeFixture.state.gateReads = true;
            window.__stalePurgeFixture.resolve(0, { status: 'success', data: { deleted: 12 } });
        });
        await expect.poll(() => page.evaluate(() => window.__stalePurgeFixture.state.pendingReads.length)).toBe(1);
        await expect(button).toHaveText('清理中…');
        await page.evaluate(() => window.__stalePurgeFixture.releaseReads());
        await expect(staleTag).toHaveText('过期 0');
        await expect(button).toHaveText('清理过期');
        await expect(button).toBeDisabled();

        await page.evaluate(({ scopeId, loc }) => window.__stalePurgeFixture.update(scopeId, 8, loc), {
            scopeId: firstScope,
            loc: instancePage
        });
        await expect(staleTag).toHaveText('过期 8');
        await button.click();
        await expect(button).toHaveText('清理中…');
        if (instancePage) {
            await root.getByRole('tab', { name: 'red | IPv4 UNC', exact: true }).click();
        } else {
            await root.locator('.route-toolbar-query .nn-select').nth(1).click();
            await page.getByRole('option', { name: 'Post-policy Adj-RIB-In', exact: true }).click();
        }
        await expect(staleTag).toHaveText('过期 12');
        await expect(button).toHaveText('清理过期');
        await expect(button).toBeEnabled();
        await button.click();
        await expect(button).toHaveText('清理中…');
        await expect.poll(() => page.evaluate(() => window.__stalePurgeFixture.state.requests.length)).toBe(3);

        const queryCount = await page.evaluate(() => window.__stalePurgeFixture.state.queries.length);
        await page.evaluate(() => window.__stalePurgeFixture.resolve(1, { status: 'success', data: { deleted: 8 } }));
        await expect(page.locator('.nn-toast').filter({ hasText: '已清理 8 条过期路由' })).toBeVisible();
        await expect(button).toHaveText('清理中…');
        await expect(button).toBeDisabled();
        expect(await page.evaluate(() => window.__stalePurgeFixture.state.queries.length)).toBe(queryCount);

        await page.evaluate(() =>
            window.__stalePurgeFixture.resolve(2, {
                status: 'error',
                msg: '清理被拒绝：测试存储不可写'
            })
        );
        await expect(page.locator('.nn-toast').filter({ hasText: '清理被拒绝：测试存储不可写' })).toBeVisible();
        await expect(button).toHaveText('清理过期');
        await expect(button).toBeEnabled();
        await expect(staleTag).toHaveText('过期 12');

        await button.click();
        await expect.poll(() => page.evaluate(() => window.__stalePurgeFixture.state.requests.length)).toBe(4);
        await page.evaluate(() => window.__stalePurgeFixture.resolve(3, { status: 'success', data: { deleted: 12 } }));
        await expect(staleTag).toHaveText('过期 0');
        await expect(button).toHaveText('清理过期');
        await expect(button).toBeDisabled();
    });
}
