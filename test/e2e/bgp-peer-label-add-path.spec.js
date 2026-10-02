const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e } = require('../../scripts/e2e-support');

const peerCases = [
    {
        type: 'ipv4',
        tab: 'IPv4邻居',
        configKey: 'Ipv4PeerConfig',
        capabilitiesKey: 'openCap',
        familiesKey: 'addressFamily',
        config: { peerIp: '192.0.2.10', peerAs: '65001', holdTime: '90', openCap: [1, 2, 65], addressFamily: [1] }
    },
    {
        type: 'ipv6',
        tab: 'IPv6邻居',
        configKey: 'Ipv6PeerConfig',
        capabilitiesKey: 'openCapIpv6',
        familiesKey: 'addressFamilyIpv6',
        config: {
            peerIpv6: '2001:db8::10',
            peerIpv6As: '65001',
            holdTimeIpv6: '90',
            openCapIpv6: [1, 2, 65],
            addressFamilyIpv6: [2]
        }
    }
];

async function installPeerApiBridge(page) {
    await page.addInitScript(() => {
        const patchApi = api =>
            Object.assign(api || {}, {
                loadIpv4PeerConfig: () => window.__featureE2eCall('bgp.loadIpv4PeerConfig'),
                saveIpv4PeerConfig: config => window.__featureE2eCall('bgp.saveIpv4PeerConfig', config),
                configIpv4Peer: config => window.__featureE2eCall('bgp.configIpv4Peer', config),
                loadIpv6PeerConfig: () => window.__featureE2eCall('bgp.loadIpv6PeerConfig'),
                saveIpv6PeerConfig: config => window.__featureE2eCall('bgp.saveIpv6PeerConfig', config),
                configIpv6Peer: config => window.__featureE2eCall('bgp.configIpv6Peer', config),
                getPeerInfo: () => Promise.resolve({ status: 'success', data: {} })
            });
        let currentApi = patchApi(window.bgpApi);
        Object.defineProperty(window, 'bgpApi', {
            configurable: true,
            get: () => currentApi,
            set: value => {
                currentApi = patchApi(value);
            }
        });
    });
}

test.describe('Label ADD-PATH peer configuration', () => {
    for (const peerCase of peerCases) {
        test(`${peerCase.type} peer gates and persists Label ADD-PATH independently of SRv6`, async ({ page }) => {
            const harness = await setupFeaturePagesE2e(page);
            const savedPayloads = [];
            const controller = harness.controller;
            const originalCall = controller.call.bind(controller);
            controller.state.bgp.configs.set(peerCase.configKey, {
                ...peerCase.config,
                addressFamilyConfig: { 12: { sendAddPath: false, sendSrv6PrefixSid: false } }
            });
            controller.call = async (method, ...args) => {
                if (method === `bgp.save${peerCase.configKey}`) savedPayloads.push(JSON.parse(JSON.stringify(args[0])));
                return originalCall(method, ...args);
            };
            await installPeerApiBridge(page);

            try {
                await page.goto('/#/bgp/bgp-peer-config');
                await page.getByRole('tab', { name: peerCase.tab, exact: true }).click();
                const saveButton = page.getByTestId(`bgp-config-${peerCase.type}-peer-button`);
                const form = saveButton.locator('xpath=ancestor::form');
                const capability = form.getByRole('checkbox', { name: 'ADD-PATH', exact: true });
                const capabilityLabel = capability.locator('xpath=ancestor::label[1]');
                const labelAddPathLabel = page.getByTestId(`bgp-${peerCase.type}-peer-add-path-12-checkbox`);
                const labelAddPath = labelAddPathLabel.getByRole('checkbox');
                const familySelect = form
                    .locator('.nn-form-item')
                    .filter({ hasText: /^Addr Family/ })
                    .locator('.nn-select');
                const addLabelFamily = async () => {
                    await familySelect.press('ArrowDown');
                    await expect(familySelect).toHaveAttribute('aria-expanded', 'true');
                    await page.getByRole('option', { name: 'IPv4 Label', exact: true }).click();
                    await familySelect.press('Escape');
                    await expect(
                        familySelect.getByRole('button', { name: '移除 IPv4 Label', exact: true })
                    ).toBeVisible();
                };
                const save = async expectedAddPath => {
                    const previousCount = savedPayloads.length;
                    await saveButton.click();
                    await expect.poll(() => savedPayloads.length).toBe(previousCount + 1);
                    const payload = savedPayloads[savedPayloads.length - 1];
                    expect(payload.addressFamilyConfig[12]).toEqual({
                        sendAddPath: expectedAddPath,
                        sendSrv6PrefixSid: false
                    });
                    await expect(page.locator('.nn-toast-error')).toHaveCount(0);
                    return payload;
                };

                await expect(page.getByTestId(`bgp-${peerCase.type}-peer-ip-input`)).toHaveValue(
                    peerCase.config.peerIp || peerCase.config.peerIpv6
                );
                await expect(labelAddPath).toBeDisabled();
                await expect(capability).not.toBeChecked();
                await capabilityLabel.click();
                await expect(labelAddPath).toBeDisabled();
                await capabilityLabel.click();
                await addLabelFamily();
                await expect(labelAddPath).toBeDisabled();
                await capabilityLabel.click();
                await expect(labelAddPath).toBeEnabled();
                await labelAddPathLabel.click();
                const enabledPayload = await save(true);
                expect(enabledPayload[peerCase.capabilitiesKey]).toContain(69);
                expect(enabledPayload[peerCase.familiesKey]).toContain(12);

                // A stored SRv6 setting for Label must not become a sendable peer option.
                controller.state.bgp.configs.get(peerCase.configKey).addressFamilyConfig[12].sendSrv6PrefixSid = true;
                await page.reload();
                await page.getByRole('tab', { name: peerCase.tab, exact: true }).click();
                await expect(labelAddPath).toBeEnabled();
                await expect(labelAddPath).toBeChecked();
                const srv6Field = form.locator('.nn-form-item').filter({ hasText: /^SRv6 SID/ });
                if (peerCase.type === 'ipv6') {
                    await expect(srv6Field.getByRole('checkbox')).toHaveCount(2);
                    await expect(srv6Field.getByRole('checkbox', { name: 'IPv4 Label', exact: true })).toHaveCount(0);
                } else {
                    await expect(srv6Field).toHaveCount(0);
                }
                await save(true);

                await capabilityLabel.click();
                await expect(labelAddPath).toBeDisabled();
                await expect(labelAddPath).not.toBeChecked();
                const noCapabilityPayload = await save(false);
                expect(noCapabilityPayload[peerCase.capabilitiesKey]).not.toContain(69);

                await capabilityLabel.click();
                await expect(labelAddPath).toBeEnabled();
                await labelAddPathLabel.click();
                await familySelect.getByRole('button', { name: '移除 IPv4 Label', exact: true }).click();
                await expect(familySelect.getByRole('button', { name: '移除 IPv4 Label', exact: true })).toHaveCount(0);
                await expect(labelAddPath).toBeDisabled();
                await expect(labelAddPath).not.toBeChecked();
                const noFamilyPayload = await save(false);
                expect(noFamilyPayload[peerCase.familiesKey]).not.toContain(12);
            } finally {
                await harness.cleanup();
            }
        });
    }
});
