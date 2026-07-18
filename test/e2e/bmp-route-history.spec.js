const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { getBrowserMockScript } = require('../../scripts/e2e-support');

function success(data) {
    return { status: 'success', data };
}

function history(scopeId, overrides = {}) {
    const observedAtMs = overrides.observedAtMs || Date.parse('2026-07-18T08:00:00.000Z');
    const prefix = overrides.prefix || '203.0.113.0';
    const mask = overrides.mask || 24;
    return {
        scopeId,
        routeId: 'shared-route-id',
        sourceId: 'source-a',
        eventCount: overrides.eventCount || 2,
        firstObservedAt: new Date(observedAtMs - 60000).toISOString(),
        firstObservedAtMs: observedAtMs - 60000,
        latestEvent: {
            eventId: overrides.eventId || 20,
            eventType: overrides.eventType || 'withdraw',
            observedAt: new Date(observedAtMs).toISOString(),
            observedAtMs,
            ribEpoch: 3,
            reason: overrides.reason || null
        },
        route: {
            routeKey: `0|0:0|${prefix}|${mask}`,
            afi: 1,
            safi: 1,
            ip: prefix,
            mask,
            pathId: 0,
            rd: '0:0'
        },
        source: { remoteIp: '192.0.2.10', sysName: 'history-router' },
        scope: {
            kind: 'peer',
            afi: 1,
            safi: 1,
            ribType: '2',
            peerIp: overrides.peerIp || '192.0.2.1',
            peerAs: 65001,
            peerRd: '0:0',
            vrfName: 'blue'
        }
    };
}

function nonIpHistory(scopeId, identity, { afi, safi, addrFamilyType }) {
    const item = history(scopeId);
    item.route = {
        ...item.route,
        routeKey: `${afi}|${safi}|${identity}`,
        afi,
        safi,
        ip: identity,
        mask: 520,
        addrFamilyType,
        nlriDetail: { prefix: identity }
    };
    item.scope = { ...item.scope, afi, safi };
    return item;
}

function routeEvent(scopeId) {
    const observedAtMs = Date.parse('2026-07-18T07:59:00.000Z');
    return {
        eventId: 19,
        sourceId: 'source-a',
        connectionId: 'connection-a',
        sequence: 19,
        scopeId,
        routeId: 'shared-route-id',
        eventType: 'announce',
        observedAt: new Date(observedAtMs).toISOString(),
        observedAtMs,
        ribEpoch: 3,
        attrId: 'attr-a',
        route: {
            routeKey: '0|0:0|203.0.113.0|24',
            afi: 1,
            safi: 1,
            ip: '203.0.113.0',
            mask: 24,
            nextHop: '192.0.2.254',
            asPath: '65001 65100',
            localPref: 100
        }
    };
}

test('searches retained route histories with scope-isolated pagination and opens the selected timeline', async ({
    page
}) => {
    const calls = [];
    await page.exposeFunction('__bmpE2eCall', async (method, ...args) => {
        calls.push({ method, args });
        if (method === 'getPersistenceStatus') {
            return success({ oldestEventAtMs: Date.parse('2026-07-11T08:00:00.000Z') });
        }
        if (method !== 'getPersistedRouteEvents') return success(null);
        const query = args[0] || {};
        if (query.groupByRoute) {
            if (query.cursor) {
                return success({
                    kind: 'route-histories',
                    list: [
                        history('scope-b', {
                            eventId: 10,
                            observedAtMs: Date.parse('2026-07-18T07:00:00.000Z'),
                            peerIp: '192.0.2.2',
                            eventType: 'purge',
                            reason: 'retention-test'
                        })
                    ],
                    total: null,
                    pageSize: 30,
                    asOfEventId: 20,
                    nextCursor: null
                });
            }
            return success({
                kind: 'route-histories',
                list: [history('scope-a')],
                total: 2,
                pageSize: 30,
                asOfEventId: 20,
                nextCursor: 'history-page-two'
            });
        }
        return success({
            list: [routeEvent(query.scopeId)],
            total: 1,
            pageSize: 50,
            nextCursor: null
        });
    });
    await page.addInitScript({ content: getBrowserMockScript('bmp') });

    await page.goto('/#/bmp/route-history');
    const root = page.getByTestId('bmp-route-history-page');
    await expect(page.getByRole('tab', { name: '路由轨迹' })).toBeVisible();
    await expect(root.locator('.nn-card-head-title')).toHaveText('路由轨迹');
    await expect(root.getByTestId('route-history-table')).toBeVisible();
    await expect(root.locator('.route-toolbar')).toBeVisible();
    const layout = await root.evaluate(element => {
        const parent = element.parentElement;
        const cardBody = element.querySelector('.bmp-full-card .nn-card-body');
        const tableContent = element.querySelector('.history-table .nn-table-content');
        const rootStyle = getComputedStyle(element);
        const parentStyle = parent ? getComputedStyle(parent) : null;
        const cardBodyStyle = cardBody ? getComputedStyle(cardBody) : null;
        const tableContentStyle = tableContent ? getComputedStyle(tableContent) : null;
        const parentContentHeight = parent
            ? parent.clientHeight -
              Number.parseFloat(parentStyle?.paddingTop || '0') -
              Number.parseFloat(parentStyle?.paddingBottom || '0')
            : 0;

        return {
            rootHeight: Math.round(element.getBoundingClientRect().height),
            parentContentHeight: Math.round(parentContentHeight),
            rootOverflow: rootStyle.overflow,
            cardBodyDisplay: cardBodyStyle?.display,
            cardBodyOverflow: cardBodyStyle?.overflow,
            tableContentOverflow: tableContentStyle?.overflow
        };
    });
    expect(layout).toMatchObject({
        rootOverflow: 'hidden',
        cardBodyDisplay: 'flex',
        cardBodyOverflow: 'hidden',
        tableContentOverflow: 'auto'
    });
    expect(Math.abs(layout.rootHeight - layout.parentContentHeight)).toBeLessThanOrEqual(1);
    await expect(root).toContainText('轨迹包含仍在 RIB 以及已撤销、已清理的路由');
    await expect(root).toContainText('当前仍在 RIB 的路由也会显示');
    await expect(root).toContainText('数据库当前最早保留到');

    const scopeKindSelect = root.getByTestId('route-history-scope-kind');
    const ribTypeSelect = root.getByTestId('route-history-rib-type');
    await expect(ribTypeSelect).toHaveAttribute('aria-disabled', 'true');
    await expect(ribTypeSelect.locator('.nn-select-placeholder')).toHaveText('请先选择 Scope');

    await root.getByTestId('route-history-prefix').fill('203.0.113.9/24');
    await scopeKindSelect.click();
    await page.getByRole('option', { name: 'Loc-RIB', exact: true }).click();
    await expect(ribTypeSelect).toHaveAttribute('aria-disabled', 'true');
    await expect(ribTypeSelect.locator('.nn-select-single-value')).toHaveText('Loc-RIB');
    await root.getByTestId('route-history-search').click();
    await expect
        .poll(() => {
            const query = calls.find(call => call.args[0]?.groupByRoute && call.args[0]?.scopeKind === 'loc-rib')
                ?.args[0];
            return query ? { scopeKind: query.scopeKind, ribType: query.ribType } : null;
        })
        .toEqual({ scopeKind: 'loc-rib', ribType: 'loc-rib' });

    await scopeKindSelect.click();
    await page.getByRole('option', { name: 'BGP Peer RIB', exact: true }).click();
    await expect(ribTypeSelect).not.toHaveAttribute('aria-disabled', 'true');
    await expect(ribTypeSelect.locator('.nn-select-placeholder')).toHaveText('全部 Peer RIB 阶段');
    await ribTypeSelect.click();
    await expect(page.getByRole('option')).toHaveCount(4);
    await expect(page.getByRole('option', { name: 'Loc-RIB', exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: /AS_PATH/ })).toHaveCount(0);
    await page.getByRole('option', { name: 'Post-policy Adj-RIB-In', exact: true }).click();

    await root.getByTestId('route-history-search').click();

    await expect(root.getByTestId('route-history-row')).toHaveCount(1);
    await expect(root.getByTestId('route-history-row')).toContainText('最近保留事件：撤销');
    await expect(root.getByTestId('route-history-row')).toContainText('RD 0:0');
    await expect(root.getByTestId('route-history-row')).toContainText('Path ID 0');
    await expect
        .poll(() => {
            const query = calls.find(call => call.args[0]?.groupByRoute && call.args[0]?.scopeKind === 'peer')?.args[0];
            return {
                groupByRoute: query?.groupByRoute,
                prefixExact: query?.prefixExact,
                prefixLength: query?.prefixLength,
                afi: query?.afi,
                scopeKind: query?.scopeKind,
                ribType: query?.ribType,
                includeTotal: query?.includeTotal
            };
        })
        .toEqual({
            groupByRoute: true,
            prefixExact: '203.0.113.0',
            prefixLength: 24,
            afi: 1,
            scopeKind: 'peer',
            ribType: '2',
            includeTotal: true
        });

    await root.getByTestId('route-history-load-more').click();
    await expect(root.getByTestId('route-history-row')).toHaveCount(2);
    await expect(root.getByTestId('route-history-row').nth(1)).toContainText('最近保留事件：清理');
    const cursorCall = calls.find(call => call.args[0]?.groupByRoute && call.args[0]?.cursor);
    expect(cursorCall.args[0]).toMatchObject({
        cursor: 'history-page-two',
        includeTotal: false
    });

    await root.getByTestId('route-history-row').nth(1).getByTestId('route-history-open').click();
    await expect(page.getByTestId('bmp-route-event-timeline')).toBeVisible();
    await expect(page.getByTestId('bmp-route-event-item')).toContainText('宣告');
    await expect
        .poll(() => {
            const query = calls
                .filter(call => call.method === 'getPersistedRouteEvents')
                .map(call => call.args[0])
                .find(item => item?.scopeId === 'scope-b' && !item.groupByRoute);
            return query
                ? {
                      scopeId: query.scopeId,
                      routeId: query.routeId,
                      prefixExact: query.prefixExact,
                      toEventId: query.toEventId
                  }
                : null;
        })
        .toEqual({
            scopeId: 'scope-b',
            routeId: 'shared-route-id',
            prefixExact: undefined,
            toEventId: 20
        });
});

test('queries EVPN, BGP-LS, and FlowSpec histories as NLRI text without appending a fake mask', async ({ page }) => {
    const calls = [];
    const cases = [
        {
            input: 'evpn:mac-ip:65000:1:tag=101:mac=aa:bb:cc:dd:ee:01:ip=192.0.2.11',
            queryPrefix: 'evpn:mac-ip:65000:1:tag=101:mac=aa:bb:cc:dd:ee:01:ip=192.0.2.11',
            identity: 'evpn:mac-ip:65000:1:tag=101:mac=aa:bb:cc:dd:ee:01:ip=192.0.2.11',
            afi: 25,
            safi: 70,
            addrFamilyType: 3,
            familyLabel: 'L2VPN EVPN'
        },
        {
            input: 'BGP-LS:Link:10.10.0.1->10.10.0.2',
            queryPrefix: 'bgp-ls:Link:10.10.0.1->10.10.0.2',
            identity: 'bgp-ls:Link:10.10.0.1->10.10.0.2',
            afi: 16388,
            safi: 71,
            addrFamilyType: 14,
            familyLabel: 'Link-State'
        },
        {
            input: 'FlowSpec: dst=198.51.100.0/24 proto = 6',
            queryPrefix: 'dst=198.51.100.0/24 proto = 6',
            identity: 'dst=198.51.100.0/24 proto = 6',
            afi: 1,
            safi: 133,
            addrFamilyType: 10,
            familyLabel: 'IPv4 FlowSpec'
        }
    ];
    await page.exposeFunction('__bmpE2eCall', async (method, ...args) => {
        if (method === 'getPersistenceStatus') return success({ oldestEventAtMs: null });
        if (method !== 'getPersistedRouteEvents') return success(null);
        const query = args[0] || {};
        calls.push(query);
        if (!query.groupByRoute) return success({ list: [], total: 0, nextCursor: null });
        const matchedCase = cases.find(item => item.queryPrefix === query.prefix);
        return success({
            kind: 'route-histories',
            list: matchedCase
                ? [
                      nonIpHistory(`scope-${matchedCase.safi}`, matchedCase.identity, {
                          afi: matchedCase.afi,
                          safi: matchedCase.safi,
                          addrFamilyType: matchedCase.addrFamilyType
                      })
                  ]
                : [],
            total: matchedCase ? 1 : 0,
            pageSize: 30,
            asOfEventId: 20,
            nextCursor: null
        });
    });
    await page.addInitScript({ content: getBrowserMockScript('bmp') });

    await page.goto('/#/bmp/route-history');
    const root = page.getByTestId('bmp-route-history-page');
    const input = root.getByTestId('route-history-prefix');

    for (const routeCase of cases) {
        await input.fill(routeCase.input);
        await root.getByTestId('route-history-search').click();

        await expect
            .poll(() => calls.filter(query => query.groupByRoute && query.prefix === routeCase.queryPrefix).length)
            .toBe(1);
        const query = calls.find(item => item.groupByRoute && item.prefix === routeCase.queryPrefix);
        expect(query).toMatchObject({
            groupByRoute: true,
            prefix: routeCase.queryPrefix,
            includeTotal: true
        });
        expect(query.prefixExact).toBeUndefined();
        expect(query.prefixLength).toBeUndefined();
        expect(query.afi).toBeUndefined();

        const row = root.getByTestId('route-history-row');
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(routeCase.identity);
        await expect(row).toContainText(routeCase.familyLabel);
        await expect(row).not.toContainText(`${routeCase.identity}/520`);
        await expect(row).not.toContainText('/520');
    }
});

test('validates input and renders query error, retry, and empty states', async ({ page }) => {
    let groupedAttempts = 0;
    let ipv6Attempts = 0;
    const groupedQueries = [];
    await page.exposeFunction('__bmpE2eCall', async (method, ...args) => {
        if (method !== 'getPersistedRouteEvents') return success(null);
        if (!args[0]?.groupByRoute) return success({ list: [], total: 0, nextCursor: null });
        groupedAttempts += 1;
        groupedQueries.push(args[0]);
        if (args[0]?.prefixExact === '2001:db8::') {
            ipv6Attempts += 1;
            if (ipv6Attempts === 1) return { status: 'error', msg: 'history backend unavailable' };
        }
        return success({
            kind: 'route-histories',
            list: [],
            total: 0,
            pageSize: 30,
            asOfEventId: 0,
            nextCursor: null
        });
    });
    await page.addInitScript({ content: getBrowserMockScript('bmp') });

    await page.goto('/#/bmp/route-history');
    const root = page.getByTestId('bmp-route-history-page');
    const readContentLayout = () =>
        root.evaluate(element => {
            const toolbarRect = element.querySelector('.route-toolbar')?.getBoundingClientRect();
            const tableRect = element.querySelector('.history-table-shell')?.getBoundingClientRect();
            const pickRect = rect =>
                rect
                    ? {
                          top: Math.round(rect.top),
                          left: Math.round(rect.left),
                          width: Math.round(rect.width),
                          height: Math.round(rect.height)
                      }
                    : null;
            return { toolbar: pickRect(toolbarRect), table: pickRect(tableRect) };
        });
    const layoutBeforeValidation = await readContentLayout();

    await root.getByTestId('route-history-search').click();
    const emptyPrefixToast = page
        .locator('.nn-toast-error')
        .filter({ hasText: '请输入要查询的 Prefix 或 NLRI 标识' })
        .last();
    await expect(emptyPrefixToast).toBeVisible();
    await expect(emptyPrefixToast).toHaveAttribute('role', 'alert');
    await expect(root.getByTestId('route-history-prefix')).toHaveClass(/nn-input-status-error/);
    expect(await readContentLayout()).toEqual(layoutBeforeValidation);
    expect(groupedAttempts).toBe(0);
    await emptyPrefixToast.getByRole('button', { name: '关闭' }).click();
    await expect(emptyPrefixToast).toBeHidden();

    await root.getByTestId('route-history-prefix').fill('192.0.2.0/99');
    await root.getByTestId('route-history-search').click();
    const invalidPrefixToast = page
        .locator('.nn-toast-error')
        .filter({ hasText: '请输入有效的 IPv4、IPv6 或 CIDR Prefix' })
        .last();
    await expect(invalidPrefixToast).toBeVisible();
    expect(await readContentLayout()).toEqual(layoutBeforeValidation);
    expect(groupedAttempts).toBe(0);
    await invalidPrefixToast.getByRole('button', { name: '关闭' }).click();

    await root.getByTestId('route-history-prefix').fill('not-a-prefix');
    await root.getByTestId('route-history-search').click();
    await expect(root.getByTestId('route-history-empty')).toContainText('not-a-prefix');
    expect(groupedQueries.at(-1)).toMatchObject({ prefix: 'not-a-prefix' });
    expect(groupedQueries.at(-1).prefixExact).toBeUndefined();
    expect(groupedQueries.at(-1).afi).toBeUndefined();

    await root.getByTestId('route-history-prefix').fill('2001:0DB8:0000::/32');
    await root.getByTestId('route-history-search').click();
    await expect(root).toContainText('history backend unavailable');
    await root.getByTestId('route-history-retry').click();
    await expect(root.getByTestId('route-history-empty')).toContainText('2001:db8::/32');
    expect(groupedAttempts).toBe(3);
    expect(ipv6Attempts).toBe(2);
});

test('a new Enter search supersedes an in-flight history request', async ({ page }) => {
    let groupedAttempts = 0;
    let resolveFirstRequest;
    const firstRequest = new Promise(resolve => {
        resolveFirstRequest = resolve;
    });
    await page.exposeFunction('__bmpE2eCall', async (method, ...args) => {
        if (method === 'getPersistenceStatus') return success({ oldestEventAtMs: null });
        if (method !== 'getPersistedRouteEvents') return success(null);
        if (!args[0]?.groupByRoute) return success({ list: [], total: 0, nextCursor: null });
        groupedAttempts += 1;
        if (groupedAttempts === 1) return firstRequest;
        return success({
            kind: 'route-histories',
            list: [history('scope-new', { prefix: '198.51.100.0' })],
            total: 1,
            pageSize: 30,
            asOfEventId: 31,
            nextCursor: null
        });
    });
    await page.addInitScript({ content: getBrowserMockScript('bmp') });

    await page.goto('/#/bmp/route-history');
    const root = page.getByTestId('bmp-route-history-page');
    const input = root.getByTestId('route-history-prefix');
    await input.fill('203.0.113.0/24');
    await input.press('Enter');
    await expect.poll(() => groupedAttempts).toBe(1);

    await input.fill('198.51.100.0/24');
    await input.press('Enter');
    await expect(root.getByTestId('route-history-row')).toContainText('198.51.100.0/24');

    resolveFirstRequest(
        success({
            kind: 'route-histories',
            list: [history('scope-old')],
            total: 1,
            pageSize: 30,
            asOfEventId: 30,
            nextCursor: null
        })
    );
    await expect(root.getByTestId('route-history-row')).toContainText('198.51.100.0/24');
});
