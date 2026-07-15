const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { BgpE2eController, getBrowserMockScript } = require('../../scripts/e2e-support');
const BgpConst = require('../../electron/const/bgpConst');

const LARGE_ROUTE_COUNT = Number(process.env.BGP_MVPN_LARGE_ROUTES || 5000);
const INCREMENTAL_ROUTE_COUNT = 5;
const PAGE_SIZE = 25;
const MVPN_ROUTE_TYPE = BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD;
const MVPN_NLRI_WIRE_LENGTH = 20;
const MVPN_ROUTES_PER_FULL_PACKET = 201;
const MVPN_FULL_PACKET_LENGTH = 4077;
const OPEN_CAPABILITIES = [
    BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
    BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH,
    BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS
];

function ipv4FromBuffer(buffer, offset) {
    return Array.from(buffer.subarray(offset, offset + 4)).join('.');
}

function decodeRd(buffer) {
    const type = buffer.readUInt16BE(0);
    if (type === BgpConst.RD_TYPE.IP) {
        return `${ipv4FromBuffer(buffer, 2)}:${buffer.readUInt16BE(6)}`;
    }
    if (type === BgpConst.RD_TYPE.AS4) {
        return `${buffer.readUInt32BE(2)}:${buffer.readUInt16BE(6)}`;
    }
    return `${buffer.readUInt16BE(2)}:${buffer.readUInt32BE(4)}`;
}

function decodeSourceActiveNlri(nlri) {
    expect(nlri.routeType).toBe(MVPN_ROUTE_TYPE);
    expect(nlri.nlriLength).toBe(MVPN_NLRI_WIRE_LENGTH - 2);

    const value = Buffer.from(nlri.rawNlri, 'hex');
    expect(value).toHaveLength(MVPN_NLRI_WIRE_LENGTH - 2);
    expect(value[8]).toBe(BgpConst.IP_HOST_LEN);
    expect(value[13]).toBe(BgpConst.IP_HOST_LEN);

    return {
        routeType: nlri.routeType,
        rd: decodeRd(value.subarray(0, 8)),
        sourceIp: ipv4FromBuffer(value, 9),
        groupIp: ipv4FromBuffer(value, 14)
    };
}

function normalizePageRoute(route) {
    return {
        routeType: Number(route.routeType),
        rd: route.rd,
        sourceIp: route.sourceIp,
        groupIp: route.groupIp
    };
}

function sortedRouteKeys(routes) {
    return routes.map(route => JSON.stringify(route)).sort();
}

function normalizeCellText(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ');
}

function expectedPacketCounts(total, routesPerFullPacket) {
    const counts = [];
    let remaining = total;
    while (remaining > 0) {
        const count = Math.min(remaining, routesPerFullPacket);
        counts.push(count);
        remaining -= count;
    }
    return counts;
}

function familyUpdates(source) {
    const updates = Array.isArray(source) ? source : source.getClientUpdates();
    return updates.filter(
        update =>
            update.valid &&
            update.mpReach?.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            update.mpReach?.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN &&
            update.mpReach.nlriCount > 0
    );
}

function routeConfig({ count, groupIp, rt = '65000:100' }) {
    return {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN,
        routeType: MVPN_ROUTE_TYPE,
        rd: '65000:100',
        rt,
        sourceIp: '198.51.100.10',
        groupIp,
        originatingRouterIp: '192.0.2.10',
        sourceAs: '65000',
        count: String(count),
        randomAsPathEnabled: false,
        asMin: 64512,
        asMax: 65534,
        asPathMinLength: 1,
        asPathMaxLength: 5
    };
}

async function startMvpnInstance(page, controller) {
    const bgpPort = await BgpE2eController.getFreePort();
    controller.setBgpPort(bgpPort);

    const result = await page.evaluate(
        ({ localAs, addressFamily }) =>
            window.bgpApi.startBgp({
                localAs,
                routerId: '192.0.2.10',
                addressFamily: [addressFamily]
            }),
        {
            localAs: '65000',
            addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN
        }
    );
    expect(result.status, result.msg).toBe('success');
}

async function establishMvpnPeer(page, controller) {
    const result = await page.evaluate(
        ({ addressFamily, openCap }) =>
            window.bgpApi.configIpv4Peer({
                peerIp: '127.0.0.1',
                peerAs: '65000',
                holdTime: '90',
                openCap,
                addressFamily: [addressFamily],
                role: '',
                openCapCustom: ''
            }),
        {
            addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN,
            openCap: OPEN_CAPABILITIES
        }
    );
    expect(result.status, result.msg).toBe('success');

    await controller.startMockClient({
        localAs: 65000,
        routerId: '192.0.2.20',
        holdTime: 90,
        addressFamilies: ['ipv4-mvpn']
    });
    await controller.waitForClientEvent('established');
    await controller.waitForPeerState('127.0.0.1', 'Established', 10000, BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN);
}

async function generateRoutes(page, config) {
    const result = await page.evaluate(
        routeConfigValue => window.bgpApi.generateIpv4MvpnRoutes(routeConfigValue),
        config
    );
    expect(result.status, result.msg).toBe('success');
    return result;
}

async function fetchAllRoutes(page) {
    return page.evaluate(
        async ({ addressFamily, pageSize, routeType }) => {
            const routes = [];
            let currentPage = 1;
            let total = 0;
            do {
                const result = await window.bgpApi.getRoutes(addressFamily, currentPage, pageSize, { routeType });
                if (result.status !== 'success') throw new Error(result.msg || 'MVPN getRoutes failed');
                total = Number(result.data.total || 0);
                routes.push(...(result.data.list || []));
                currentPage += 1;
            } while (routes.length < total);
            return { routes, total };
        },
        {
            addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN,
            pageSize: PAGE_SIZE,
            routeType: MVPN_ROUTE_TYPE
        }
    );
}

function assertWirePageParity(updates, pageRoutes) {
    const wireRoutes = updates.flatMap(update => update.mpReach.nlri).map(decodeSourceActiveNlri);
    expect(wireRoutes).toHaveLength(pageRoutes.length);
    expect(sortedRouteKeys(wireRoutes)).toEqual(sortedRouteKeys(pageRoutes.map(normalizePageRoute)));
}

function expectedRendererCells(route) {
    return [route.rd, route.rt, route.asPath, route.sourceIp, route.groupIp].map(normalizeCellText);
}

async function readRendererRows(table) {
    return table.locator('.nn-table-tbody > .nn-table-row').evaluateAll(rows =>
        rows.map(row =>
            Array.from(row.querySelectorAll(':scope > .nn-table-cell'))
                .slice(0, -1)
                .map(cell =>
                    String(cell.innerText || '')
                        .trim()
                        .replace(/\s+/g, ' ')
                )
        )
    );
}

async function assertRendererPage(page, routes) {
    await page.goto('/#/bgp/route-mvpn');
    await expect(page.getByTestId('bgp-route-mvpn-page')).toBeVisible();
    await page.getByRole('tab', { name: 'Source Active A-D (Type 5)', exact: true }).click();

    const table = page.getByTestId(`bgp-mvpn-route-table-${MVPN_ROUTE_TYPE}`);
    await expect(table.getByText(`共 ${routes.length} 条，每页 ${PAGE_SIZE} 条`)).toBeVisible({ timeout: 30000 });
    const lastPage = Math.ceil(routes.length / PAGE_SIZE);
    const rows = table.locator('.nn-table-tbody > .nn-table-row');
    const pagination = lastPage > 1 ? table.getByRole('navigation', { name: '表格分页' }) : null;
    const quickJumper = pagination ? pagination.getByRole('spinbutton', { name: '跳转页码' }) : null;

    for (let currentPage = 1; currentPage <= lastPage; currentPage += 1) {
        const expectedRows = routes
            .slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
            .map(expectedRendererCells);
        if (currentPage > 1) {
            await quickJumper.fill(String(currentPage));
            await quickJumper.press('Enter');
        }
        await expect(rows).toHaveCount(expectedRows.length, { timeout: 30000 });
        await expect(rows.first().locator('.nn-table-cell').nth(4)).toHaveText(expectedRows[0][4], {
            timeout: 30000
        });
        expect(await readRendererRows(table), `MVPN renderer page ${currentPage}`).toEqual(expectedRows);
    }
}

test.describe('IPv4 MVPN BGP receiver/page parity', () => {
    let controller;

    test.beforeEach(async ({ page }) => {
        controller = new BgpE2eController();
        await page.exposeFunction('__bgpE2eCall', (method, ...args) => controller.call(method, ...args));
        controller.onEvent(event => {
            page.evaluate(({ type, data }) => window.__bgpE2eEmit?.(type, data), event).catch(() => {});
        });
        await page.addInitScript({ content: getBrowserMockScript('bgp') });
        await page.goto('/#/bgp/bgp-config');
        await expect(page.getByTestId('bgp-config-page')).toBeVisible();
    });

    test.afterEach(async ({ page: _page }, testInfo) => {
        if (testInfo.status !== testInfo.expectedStatus) {
            await testInfo.attach('bgp-mvpn-diagnostics.json', {
                body: Buffer.from(
                    JSON.stringify(
                        {
                            controllerTimeline: controller?.timeline || [],
                            mockClientEvents: controller?.mockClientEvents || []
                        },
                        null,
                        2
                    )
                ),
                contentType: 'application/json'
            });
        }
        if (controller) await controller.cleanup();
        controller = null;
    });

    test('fills 4096-byte UPDATEs and keeps every receiver NLRI equal to SQLite API and renderer pages', async ({
        page
    }) => {
        test.setTimeout(180000);
        await startMvpnInstance(page, controller);
        await establishMvpnPeer(page, controller);
        await generateRoutes(page, routeConfig({ count: LARGE_ROUTE_COUNT, groupIp: '239.10.0.1', rt: '' }));
        const updates = await controller.waitForClientUpdates(
            items =>
                familyUpdates(items).reduce((sum, update) => sum + update.mpReach.nlriCount, 0) >= LARGE_ROUTE_COUNT,
            60000
        );
        const mvpnUpdates = updates.filter(
            update =>
                update.valid &&
                update.mpReach?.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
                update.mpReach?.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN &&
                update.mpReach.nlriCount > 0
        );
        const pageSnapshot = await fetchAllRoutes(page);

        expect(pageSnapshot.total).toBe(LARGE_ROUTE_COUNT);
        expect(mvpnUpdates.length).toBeGreaterThan(1);
        const packetCounts = mvpnUpdates.map(update => update.mpReach.nlriCount);
        expect(packetCounts).toEqual(expectedPacketCounts(LARGE_ROUTE_COUNT, MVPN_ROUTES_PER_FULL_PACKET));
        for (const update of mvpnUpdates) {
            expect(update.valid).toBe(true);
            expect(update.length).toBeLessThanOrEqual(BgpConst.BGP_MAX_PKT_SIZE);
            if (update.mpReach.nlriCount === MVPN_ROUTES_PER_FULL_PACKET) {
                expect(update.length).toBe(MVPN_FULL_PACKET_LENGTH);
            }
        }
        const fullUpdates = mvpnUpdates.filter(
            update => update.length + MVPN_NLRI_WIRE_LENGTH > BgpConst.BGP_MAX_PKT_SIZE
        );
        expect(fullUpdates.length).toBeGreaterThan(1);

        assertWirePageParity(mvpnUpdates, pageSnapshot.routes);
        await assertRendererPage(page, pageSnapshot.routes);
    });

    test('sends count=1 generations as separate UPDATEs and keeps receiver, API, and page equal', async ({ page }) => {
        test.setTimeout(60000);
        await startMvpnInstance(page, controller);
        await establishMvpnPeer(page, controller);

        for (let index = 0; index < INCREMENTAL_ROUTE_COUNT; index += 1) {
            await generateRoutes(
                page,
                routeConfig({
                    count: 1,
                    groupIp: `239.20.0.${index + 1}`,
                    // Changing RT on an already-established peer intentionally triggers a full-table refresh.
                    // Keep RT stable at the instance default so this case measures one count=1 send per API call.
                    rt: ''
                })
            );
        }

        await controller.waitForClientUpdates(
            items =>
                items.filter(
                    update =>
                        update.valid &&
                        update.mpReach?.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
                        update.mpReach?.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN &&
                        update.mpReach.nlriCount > 0
                ).length >= INCREMENTAL_ROUTE_COUNT,
            20000
        );
        const mvpnUpdates = familyUpdates(controller);
        const pageSnapshot = await fetchAllRoutes(page);

        expect(mvpnUpdates).toHaveLength(INCREMENTAL_ROUTE_COUNT);
        expect(mvpnUpdates.map(update => update.mpReach.nlriCount)).toEqual(Array(INCREMENTAL_ROUTE_COUNT).fill(1));
        expect(pageSnapshot.total).toBe(INCREMENTAL_ROUTE_COUNT);
        assertWirePageParity(mvpnUpdates, pageSnapshot.routes);
        await assertRendererPage(page, pageSnapshot.routes);
    });
});
