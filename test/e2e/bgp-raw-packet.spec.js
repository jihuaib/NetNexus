const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { BgpE2eController, getBrowserMockScript } = require('../../scripts/e2e-support');
const BgpConst = require('../../electron/const/bgpConst');

const cases = [
    { name: 'IPv4', peerIp: '127.0.0.1', family: 1, packetHex: 'ff'.repeat(16) + '00170200000000' },
    { name: 'IPv6', peerIp: '::1', family: 2, packetHex: 'ff'.repeat(16) + '001d0200000006800f03000201' }
];

test.describe('BGP raw packet sending', () => {
    let controller;

    test.beforeEach(async ({ page }) => {
        controller = new BgpE2eController();
        controller.setBgpPort(await BgpE2eController.getFreePort());
        await page.exposeFunction('__bgpE2eCall', (method, ...args) => controller.call(method, ...args));
        controller.onEvent(event => {
            page.evaluate(({ type, data }) => window.__bgpE2eEmit?.(type, data), event).catch(() => {});
        });
        await page.addInitScript({ content: getBrowserMockScript('bgp') });
    });

    test.afterEach(async () => {
        await controller?.cleanup();
    });

    for (const { name, peerIp, family, packetHex } of cases) {
        test(`${name} sends raw bytes only while Established and disables an open dialog on disconnect`, async ({
            page
        }) => {
            await page.goto('/#/bgp/bgp-config');
            await expect(page.getByTestId('bgp-config-page')).toBeVisible();
            const started = await page.evaluate(() =>
                window.bgpApi.startBgp({ localAs: '65535', routerId: '192.0.2.1', addressFamily: [1, 2] })
            );
            expect(started.status).toBe('success');
            const openCap = [
                BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
                BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS
            ];
            const configured = await page.evaluate(
                ({ peerIp, family, openCap }) =>
                    family === 1
                        ? window.bgpApi.configIpv4Peer({
                              peerIp,
                              peerAs: '100',
                              holdTime: '90',
                              openCap,
                              addressFamily: [family],
                              role: '',
                              openCapCustom: ''
                          })
                        : window.bgpApi.configIpv6Peer({
                              peerIpv6: peerIp,
                              peerIpv6As: '100',
                              holdTimeIpv6: '90',
                              openCapIpv6: openCap,
                              addressFamilyIpv6: [family],
                              roleIpv6: '',
                              openCapCustomIpv6: ''
                          }),
                { peerIp, family, openCap }
            );
            expect(configured.status).toBe('success');

            await page.locator('.fixed-tabs').getByRole('tab', { name: '邻居配置', exact: true }).click();
            await expect(page.getByTestId('bgp-peer-page')).toBeVisible();
            if (family === 2) await page.getByRole('tab', { name: 'IPv6-UNC邻居', exact: true }).click();
            const table = page.getByTestId(`bgp-ipv${family === 1 ? 4 : 6}-unc-peer-table`);
            await expect(table).toContainText('Idle');
            const openButton = table.getByTestId('bgp-raw-packet-open');
            await expect(openButton).toBeDisabled();
            const premature = await page.evaluate(config => window.bgpApi.sendRawPacket(config), {
                vrfIndex: 0,
                peerIp,
                packetHex
            });
            expect(premature.status).toBe('error');

            await controller.startMockClient({
                host: peerIp,
                addressFamilies: [family === 1 ? 'ipv4-unc' : 'ipv6-unc']
            });
            await controller.waitForClientEvent('established');
            await controller.waitForPeerState(peerIp, 'Established', 10000, family);
            await expect(openButton).toBeEnabled();
            await openButton.click();

            const input = page.getByTestId('bgp-raw-packet-input');
            const sendButton = page.getByTestId('bgp-raw-packet-send');
            await input.fill('ff zz');
            await sendButton.click();
            await expect(page.getByTestId('bgp-raw-packet-result')).toContainText('十六进制');
            const formattedHex = packetHex.match(/.{2}/g).join(' \n');
            await input.fill(formattedHex);
            await expect(sendButton).toBeEnabled();
            const callsBefore = controller.timeline.filter(
                item => item.message === 'renderer API call: sendRawPacket'
            ).length;
            await sendButton.click();
            await expect(page.getByTestId('bgp-raw-packet-result')).toContainText('已发送');
            const received = await controller.waitForClientEvent(
                'received-update',
                event => event.length === packetHex.length / 2
            );
            expect(received.length).toBe(packetHex.length / 2);
            expect(controller.timeline.filter(item => item.message === 'renderer API call: sendRawPacket').length).toBe(
                callsBefore + 1
            );

            await controller.stopMockClient();
            await controller.waitForPeerState(peerIp, 'Idle', 10000, family);
            await expect(sendButton).toBeDisabled();
            await expect(page.getByTestId('bgp-raw-packet-status')).toContainText('Idle');
            const disconnected = await page.evaluate(config => window.bgpApi.sendRawPacket(config), {
                vrfIndex: 0,
                peerIp,
                packetHex
            });
            expect(disconnected.status).toBe('error');

            await controller.startMockClient({
                host: peerIp,
                addressFamilies: [family === 1 ? 'ipv4-unc' : 'ipv6-unc']
            });
            await controller.waitForPeerState(peerIp, 'Established', 10000, family);
            await expect(sendButton).toBeEnabled();
            expect(controller.mockClientEvents.filter(event => event.event === 'received-update')).toHaveLength(0);

            // A response from a previous visit must not overwrite a newly opened dialog.
            await page.evaluate(() => {
                window.__rawPendingResponses = [];
                window.bgpApi.sendRawPacket = config =>
                    new Promise(resolve => window.__rawPendingResponses.push({ config, resolve }));
            });
            await sendButton.click();
            await expect(input).toBeDisabled();
            await page.evaluate(() => {
                window.location.hash = '/bgp/bgp-config';
            });
            await expect(page.getByTestId('bgp-config-page')).toBeVisible();
            await page.locator('.fixed-tabs').getByRole('tab', { name: '邻居配置', exact: true }).click();
            await expect(openButton).toBeEnabled();
            await openButton.click();
            await expect(input).toHaveValue('');
            await input.fill(packetHex);
            await sendButton.click();
            await expect(input).toBeDisabled();
            await page.evaluate(() => {
                window.__rawPendingResponses[0].resolve({
                    status: 'success',
                    data: { packetCount: 99, byteLength: 9999 }
                });
            });
            await expect(page.getByTestId('bgp-raw-packet-result')).toHaveCount(0);
            await expect(sendButton).toBeDisabled();
            await page.evaluate(() => {
                window.__rawPendingResponses[1].resolve({ status: 'error', msg: '当前请求写入失败' });
            });
            await expect(page.getByTestId('bgp-raw-packet-result')).toContainText('当前请求写入失败');
            await expect(sendButton).toBeEnabled();
            await page.evaluate(() =>
                window.__bgpE2eEmit('bgp:runtimeChanged', { running: false, addressFamilies: [] })
            );
            await expect(sendButton).toBeDisabled();
        });
    }
});
