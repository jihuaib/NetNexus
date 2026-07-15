const ipaddr = require('ipaddr.js');
const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { BgpE2eController, getBrowserMockScript } = require('../../scripts/e2e-support');
const { FRR_BGP_ADDRESS_FAMILIES, FRR_BGP_LOCAL_AS, FrrBgpLab } = require('../../scripts/e2e-support/frr-bgp-lab');
const BgpConst = require('../../electron/const/bgpConst');

const LARGE_ROUTE_COUNT = Number(process.env.FRR_BGP_LARGE_ROUTES || 5000);
const INCREMENTAL_ROUTE_COUNT = 5;
const PAGE_SIZE = 25;
const OPEN_CAPABILITIES = [
    BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
    BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH,
    BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS
];

function ipv4FromNumber(value) {
    return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

function normalizePrefix(prefix) {
    const separator = prefix.lastIndexOf('/');
    const address = separator >= 0 ? prefix.slice(0, separator) : prefix;
    const mask = separator >= 0 ? Number(prefix.slice(separator + 1)) : null;
    const parsed = ipaddr.parse(address);
    return `${parsed.toString()}/${mask}`;
}

function normalizeAsPath(value) {
    if (Array.isArray(value)) return value.join(' ').trim().replace(/\s+/g, ' ');
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ');
}

function normalizeLabel(value) {
    if (Array.isArray(value)) return normalizeLabel(value[0]);
    if (value && typeof value === 'object') return normalizeLabel(value.label ?? value.value);
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizePageRoute(_family, route) {
    return {
        prefix: normalizePrefix(`${route.ip}/${route.mask}`),
        asPath: normalizeAsPath(route.asPath)
    };
}

function normalizeFrrRoute(_family, route) {
    return {
        prefix: normalizePrefix(route.prefix),
        asPath: normalizeAsPath(route.path)
    };
}

function sortedRoutes(routes) {
    return routes.map(route => JSON.stringify(route)).sort();
}

function expectedPacketCounts(total, perFullPacket) {
    const counts = [];
    let remaining = total;
    while (remaining > 0) {
        const count = Math.min(remaining, perFullPacket);
        counts.push(count);
        remaining -= count;
    }
    return counts;
}

function largeRouteConfig(family) {
    if (family.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC) {
        return {
            addressFamily: family.addressFamily,
            prefix: '2001:db8:520::1',
            mask: '128',
            count: String(LARGE_ROUTE_COUNT),
            customAttr: '',
            rt: ''
        };
    }

    return {
        addressFamily: family.addressFamily,
        prefix: family.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST ? '10.53.0.1' : '10.52.0.1',
        mask: '32',
        count: String(LARGE_ROUTE_COUNT),
        customAttr: '',
        rt: '',
        labelMode: BgpConst.BGP_LABEL_MODE.INCREMENT,
        labelStart: '16000',
        labelStep: '1'
    };
}

function incrementalRouteConfig(family, index) {
    if (family.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC) {
        return {
            addressFamily: family.addressFamily,
            prefix: `2001:db8:620::${(index + 1).toString(16)}`,
            mask: '128',
            count: '1',
            customAttr: '',
            rt: ''
        };
    }

    return {
        addressFamily: family.addressFamily,
        prefix: ipv4FromNumber((10 << 24) + (63 << 16) + index + 1),
        mask: '32',
        count: '1',
        customAttr: '',
        rt: '',
        labelMode: BgpConst.BGP_LABEL_MODE.FIXED,
        labelStart: String(26000 + index),
        labelStep: '1'
    };
}

function configuredAddressFamilies(family) {
    if (family.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) {
        // RouteIpv4 initially renders the UNC view before the test switches to
        // labeled-unicast, so keep an empty UNC instance available as well.
        return [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC, family.addressFamily];
    }
    return [family.addressFamily];
}

async function generateRoutes(page, family, config) {
    const method =
        family.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC ? 'generateIpv6Routes' : 'generateIpv4Routes';
    const result = await page.evaluate(({ methodName, routeConfig }) => window.bgpApi[methodName](routeConfig), {
        methodName: method,
        routeConfig: config
    });
    expect(result.status, result.msg).toBe('success');
    return result;
}

async function fetchAllPageRoutes(page, family) {
    return page.evaluate(
        async ({ addressFamily, pageSize }) => {
            const routes = [];
            let current = 1;
            let total = 0;
            do {
                const response = await window.bgpApi.getRoutes(addressFamily, current, pageSize);
                if (response.status !== 'success') throw new Error(response.msg || 'getRoutes failed');
                total = Number(response.data.total || 0);
                routes.push(...(response.data.list || []));
                current += 1;
            } while (routes.length < total);
            return { routes, total };
        },
        { addressFamily: family.addressFamily, pageSize: PAGE_SIZE }
    );
}

async function startBgp(page, controller, lab, family) {
    controller.setAdvertisedNextHop(lab.neighborAddress);
    const result = await page.evaluate(
        ({ localAs, addressFamilies }) =>
            window.bgpApi.startBgp({
                localAs: String(localAs),
                routerId: '192.0.2.10',
                addressFamily: addressFamilies
            }),
        { localAs: FRR_BGP_LOCAL_AS, addressFamilies: configuredAddressFamilies(family) }
    );
    expect(result.status, result.msg).toBe('success');

    const peerResult = await page.evaluate(
        ({ peerIp, peerAs, addressFamilies, openCap }) =>
            window.bgpApi.configIpv4Peer({
                peerIp,
                peerAs: String(peerAs),
                holdTime: '30',
                openCap,
                addressFamily: addressFamilies,
                role: '',
                openCapCustom: ''
            }),
        {
            peerIp: lab.netNexusPeerIp,
            peerAs: FRR_BGP_LOCAL_AS,
            addressFamilies: configuredAddressFamilies(family),
            openCap: OPEN_CAPABILITIES
        }
    );
    expect(peerResult.status, peerResult.msg).toBe('success');

    await lab.start();
    await lab.waitForEstablished();
    await controller.waitForPeerState(lab.netNexusPeerIp, 'Established', 60000, family.addressFamily);
}

function expectedRendererCells(family, route) {
    const cells = [`${route.ip}/${route.mask}`];
    if (family.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) {
        cells.push(String(normalizeLabel(route.label) ?? '-'));
    } else {
        cells.push(String(route.rd || '0:0'), String(route.pathId ?? 0));
    }
    cells.push(String(route.rt || ''), normalizeAsPath(route.asPath));
    return cells;
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

async function assertRendererPage(page, family, routes) {
    await page.goto(family.pageRoute);
    await expect(page.getByTestId(family.pageTestId)).toBeVisible();

    if (family.addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) {
        await page.locator('.route-display-switch').getByText('IPv4 Label', { exact: true }).click();
    }

    await expect(page.getByText(`共 ${routes.length} 条，每页 ${PAGE_SIZE} 条`)).toBeVisible({ timeout: 30000 });
    const table = page.getByTestId(family.tableTestId);
    const lastPage = Math.ceil(routes.length / PAGE_SIZE);
    const rows = table.locator('.nn-table-tbody > .nn-table-row');
    const pagination = lastPage > 1 ? table.getByRole('navigation', { name: '表格分页' }) : null;
    const pageJumper = pagination ? pagination.getByRole('spinbutton', { name: '跳转页码' }) : null;

    for (let currentPage = 1; currentPage <= lastPage; currentPage += 1) {
        const expectedRows = routes
            .slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
            .map(route => expectedRendererCells(family, route));
        if (currentPage > 1) {
            await pageJumper.fill(String(currentPage));
            await pageJumper.press('Enter');
        }
        await expect(rows).toHaveCount(expectedRows.length, { timeout: 30000 });
        await expect(rows.first().locator('.nn-table-cell').first()).toHaveText(expectedRows[0][0], {
            timeout: 30000
        });
        expect(await readRendererRows(table), `${family.name} renderer page ${currentPage}`).toEqual(expectedRows);
    }
}

function assertRouteParity(family, pageRoutes, frrRoutes) {
    expect(frrRoutes).toHaveLength(pageRoutes.length);
    expect(
        sortedRoutes(frrRoutes.map(route => normalizeFrrRoute(family, route))),
        `FRR sample: ${JSON.stringify(frrRoutes.slice(0, 2))}`
    ).toEqual(sortedRoutes(pageRoutes.map(route => normalizePageRoute(family, route))));
}

function familyUpdatePackets(controller, family) {
    return controller
        .getCapturedBgpPackets(BgpConst.BGP_PACKET_TYPE.UPDATE)
        .filter(packet => packet.afi === family.afi && packet.safi === family.safi && packet.nlriCount > 0);
}

function assertLabeledWireParity(family, pageRoutes, updates) {
    if (family.safi !== BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST) return;
    const pageLabels = pageRoutes
        .map(route => `${normalizePrefix(`${route.ip}/${route.mask}`)}|${normalizeLabel(route.label)}`)
        .sort();
    const wireLabels = updates
        .flatMap(packet => packet.nlri || [])
        .map(route => `${normalizePrefix(`${route.prefix}/${route.length}`)}|${normalizeLabel(route.label)}`)
        .sort();
    expect(wireLabels).toEqual(pageLabels);
}

async function assertFrrLabeledSamples(lab, family, pageRoutes) {
    if (family.safi !== BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST) return;
    const samples = [pageRoutes[0], pageRoutes[pageRoutes.length - 1]];
    for (const route of samples) {
        const prefix = normalizePrefix(`${route.ip}/${route.mask}`);
        const detail = await lab.getRouteDetail(prefix);
        expect(detail.paths?.[0]?.remoteLabel, `FRR label for ${prefix}`).toBe(normalizeLabel(route.label));
    }
}

test.describe('BGP to FRR route/page parity', () => {
    test.skip(process.env.FRR_BGP_E2E !== '1', 'Set FRR_BGP_E2E=1 to run Docker-backed FRR interoperability tests');

    let controller;
    let lab;

    test.beforeEach(async ({ page }) => {
        controller = new BgpE2eController({ listenHost: '0.0.0.0' });
        const bgpPort = await BgpE2eController.getFreePort();
        controller.setBgpPort(bgpPort);

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
            const diagnostics = {
                controllerTimeline: controller?.timeline || [],
                capturedBgpPackets: controller?.getCapturedBgpPackets() || [],
                frr: lab ? await lab.getDiagnostics().catch(error => error.message) : ''
            };
            await testInfo.attach('bgp-frr-diagnostics.json', {
                body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
                contentType: 'application/json'
            });
        }
        if (controller) await controller.cleanup();
        if (lab) await lab.cleanup();
        controller = null;
        lab = null;
    });

    for (const family of FRR_BGP_ADDRESS_FAMILIES) {
        test(`${family.name}: fills 4096-byte UPDATEs and matches FRR with every renderer page`, async ({ page }) => {
            test.setTimeout(180000);
            lab = new FrrBgpLab({
                bgpPort: controller.bgpPort,
                family,
                nameSuffix: `${family.key}-batch`
            });
            await lab.prepare();
            await startBgp(page, controller, lab, family);
            controller.clearCapturedBgpPackets();
            await generateRoutes(page, family, largeRouteConfig(family));

            const frrRoutes = await lab.waitForRouteCount(LARGE_ROUTE_COUNT, 90000);
            const pageSnapshot = await fetchAllPageRoutes(page, family);
            expect(pageSnapshot.total).toBe(LARGE_ROUTE_COUNT);
            assertRouteParity(family, pageSnapshot.routes, frrRoutes);
            await assertRendererPage(page, family, pageSnapshot.routes);

            const updates = familyUpdatePackets(controller, family);
            assertLabeledWireParity(family, pageSnapshot.routes, updates);
            await assertFrrLabeledSamples(lab, family, pageSnapshot.routes);
            const expectedCounts = expectedPacketCounts(LARGE_ROUTE_COUNT, family.fullPacketNlri);
            expect(updates.map(packet => packet.nlriCount)).toEqual(expectedCounts);
            for (const packet of updates) {
                expect(packet.validLength).toBe(true);
                expect(packet.valid, packet.parseError || packet.error).toBe(true);
                expect(packet.length).toBeLessThanOrEqual(BgpConst.BGP_MAX_PKT_SIZE);
                if (packet.nlriCount === family.fullPacketNlri) {
                    expect(packet.length).toBe(family.fullPacketLength);
                }
            }
            expect(updates[updates.length - 1].nlriCount).toBeLessThan(family.fullPacketNlri);
        });

        test(`${family.name}: sends count=1 changes without batching and stays equal to FRR/page`, async ({ page }) => {
            test.setTimeout(180000);
            lab = new FrrBgpLab({
                bgpPort: controller.bgpPort,
                family,
                nameSuffix: `${family.key}-incremental`
            });
            await lab.prepare();
            await startBgp(page, controller, lab, family);
            controller.clearCapturedBgpPackets();

            for (let index = 0; index < INCREMENTAL_ROUTE_COUNT; index += 1) {
                await generateRoutes(page, family, incrementalRouteConfig(family, index));
                await lab.waitForRouteCount(index + 1);
            }

            const pageSnapshot = await fetchAllPageRoutes(page, family);
            const frrRoutes = await lab.waitForRouteCount(INCREMENTAL_ROUTE_COUNT);
            expect(pageSnapshot.total).toBe(INCREMENTAL_ROUTE_COUNT);
            assertRouteParity(family, pageSnapshot.routes, frrRoutes);
            await assertRendererPage(page, family, pageSnapshot.routes);

            const updates = familyUpdatePackets(controller, family);
            assertLabeledWireParity(family, pageSnapshot.routes, updates);
            await assertFrrLabeledSamples(lab, family, pageSnapshot.routes);
            expect(updates).toHaveLength(INCREMENTAL_ROUTE_COUNT);
            expect(updates.map(packet => packet.nlriCount)).toEqual(
                Array.from({ length: INCREMENTAL_ROUTE_COUNT }, () => 1)
            );
            updates.forEach(packet => {
                expect(packet.validLength).toBe(true);
                expect(packet.valid, packet.parseError || packet.error).toBe(true);
                expect(packet.length).toBeLessThan(family.fullPacketLength);
            });
        });
    }
});
