const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
process.env.NODE_ENV = 'test';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-workspaces-'));
const electronMock = {
    app: { isPackaged: false, getPath: () => directory, getVersion: () => '2.0.0' },
    ipcMain: { on() {} },
    shell: { openExternal() {} }
};
const originalLoad = Module._load;
let BgpApp;
let ElectronStore;
Module._load = function loadElectronMock(request, parent, isMain) {
    return request === 'electron' ? electronMock : originalLoad.call(this, request, parent, isMain);
};
try {
    BgpApp = require('../../electron/app/bgpApp');
    ElectronStore = require('electron-store');
} finally {
    Module._load = originalLoad;
}
const BgpConst = require('../../electron/const/bgpConst');
const families = [
    ['Ipv4UNC', 'Ipv4', BgpConst.BGP_ADDR_FAMILY.IPV4_UNC],
    ['Ipv4Label', 'Ipv4', BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST],
    ['Vpnv4', 'Vpnv4', BgpConst.BGP_ADDR_FAMILY.VPNV4],
    ['Vpnv6', 'Vpnv6', BgpConst.BGP_ADDR_FAMILY.VPNV6],
    ['Evpn', 'Evpn', BgpConst.BGP_ADDR_FAMILY.L2VPN_EVPN],
    ['Ipv6UNC', 'Ipv6', BgpConst.BGP_ADDR_FAMILY.IPV6_UNC],
    ['Ipv4Qp', 'Ipv4Qp', BgpConst.BGP_ADDR_FAMILY.IPV4_QP],
    ['Ipv6Qp', 'Ipv6Qp', BgpConst.BGP_ADDR_FAMILY.IPV6_QP],
    ['Ipv4Mvpn', 'Ipv4Mvpn', BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN]
];
function makeApp() {
    const handlers = new Map();
    const store = new ElectronStore({ cwd: directory, name: 'bgp-test-config' });
    const app = new BgpApp({ handle: (name, handler) => handlers.set(name, handler) }, store);
    app.startedAddressFamilies = new Set(families.map(([, , family]) => family));
    app.worker = {
        async sendRequest(_type, config) {
            assert.equal(
                config.routeWorkspace,
                undefined,
                'compiled requests must not send the workspace to the worker'
            );
            return { status: 'success', data: { added: 3, updated: 0, unchanged: 0, deleted: 1, total: 3 } };
        }
    };
    return { app, store, handlers };
}
async function main() {
    try {
        const { app, store, handlers } = makeApp();
        const uncFamily = BgpConst.BGP_ADDR_FAMILY.IPV4_UNC;
        const labelFamily = BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST;
        const legacyMixed = {
            version: 6,
            activeGroupId: 'old-label',
            groups: [
                { id: 'old-unc', name: 'Original UNC', config: { addressFamily: uncFamily, prefix: '192.0.2.0' } },
                {
                    id: 'old-label',
                    name: 'Original Label',
                    config: { addressFamily: labelFamily, prefix: '198.51.100.0' }
                }
            ]
        };
        store.set(app.ipv4RouteWorkspaceFileKey, legacyMixed);
        assert.deepEqual((await handlers.get('bgp:loadIpv4UNCRouteConfig')()).data.routeWorkspace.groups, [
            legacyMixed.groups[0]
        ]);
        assert.equal((await handlers.get('bgp:loadIpv4UNCRouteConfig')()).data.routeWorkspace.activeGroupId, 'old-unc');
        assert.deepEqual((await handlers.get('bgp:loadIpv4LabelRouteConfig')()).data.routeWorkspace.groups, [
            legacyMixed.groups[1]
        ]);
        assert.equal(store.get(app.getRouteWorkspaceStoreKey(uncFamily)), undefined);
        assert.equal(store.get(app.getRouteWorkspaceStoreKey(labelFamily)), undefined);
        const saved = new Map();
        for (const [configApi, generateApi, family] of families) {
            const routeWorkspace = {
                version: 1,
                profile: `${family}`,
                groups: [
                    {
                        id: `${family}-stable-1`,
                        name: 'First',
                        config: { addressFamily: family, count: 2, attributeRules: [], nlriRules: [] }
                    },
                    {
                        id: `${family}-stable-2`,
                        name: 'Second',
                        config: {
                            addressFamily: family,
                            count: 3,
                            attributeRules: [{ type: 'med', value: 9 }],
                            nlriRules: []
                        }
                    }
                ],
                activeGroupId: `${family}-stable-2`
            };
            saved.set(family, routeWorkspace);
            const save = handlers.get(`bgp:save${configApi}RouteConfig`);
            const load = handlers.get(`bgp:load${configApi}RouteConfig`);
            const generate = handlers.get(`bgp:generate${generateApi}Routes`);
            assert.ok(save && load && generate);
            const savedResponse = await save(null, { addressFamily: family, count: 2, routeWorkspace });
            assert.equal(savedResponse.status, 'success');
            if (family === uncFamily) {
                assert.deepEqual(
                    (await handlers.get('bgp:loadIpv4LabelRouteConfig')()).data.routeWorkspace.groups,
                    [legacyMixed.groups[1]],
                    'saving UNC must retain Label groups before their first isolated save'
                );
            }
            assert.notEqual(app.getRouteWorkspaceStoreKey(family), app.getRouteConfigStoreKey(family));
            assert.deepEqual(store.get(app.getRouteWorkspaceStoreKey(family)), routeWorkspace);
            assert.equal(store.get(app.getRouteConfigStoreKey(family)).routeWorkspace, undefined);
            const generated = await generate(null, {
                addressFamily: family,
                count: 3,
                groupId: `${family}-stable-2`,
                groupName: 'Second',
                attributeRules: [{ type: 'med', value: 9 }],
                nlriRules: []
            });
            assert.equal(generated.status, 'success');
            assert.equal(generated.data.deleted, 1);
            assert.deepEqual(
                (await load()).data.routeWorkspace,
                routeWorkspace,
                'managed generation must retain every group and the active ID'
            );
            const flat = await generate(null, { addressFamily: family, count: 1, prefix: 'legacy-config' });
            assert.equal(flat.status, 'success');
            assert.deepEqual(
                (await load()).data.routeWorkspace,
                routeWorkspace,
                'legacy generation must not remove a saved workspace'
            );
            await save(null, { addressFamily: family, count: 5 });
            assert.deepEqual(
                (await load()).data.routeWorkspace,
                routeWorkspace,
                'saving a flat last-route config must leave reusable groups intact'
            );
        }
        const disk = JSON.parse(fs.readFileSync(store.path, 'utf8'));
        assert.deepEqual(
            disk[app.ipv4RouteWorkspaceFileKey],
            legacyMixed,
            'the old mixed workspace remains on disk unchanged'
        );
        for (const [, , family] of families)
            assert.deepEqual(disk[app.getRouteWorkspaceStoreKey(family)], saved.get(family));
        const reopened = makeApp();
        reopened.app.worker = {
            async sendRequest() {
                throw new Error('failed generation');
            }
        };
        assert.equal(
            (await reopened.handlers.get('bgp:generateIpv4Routes')(null, { addressFamily: labelFamily, count: 1 }))
                .status,
            'error'
        );
        reopened.app.worker = null;
        assert.equal(
            (await reopened.handlers.get('bgp:generateIpv4Routes')(null, { addressFamily: uncFamily, count: 1 }))
                .status,
            'error'
        );
        for (const [configApi, , family] of families) {
            const loaded = await reopened.handlers.get(`bgp:load${configApi}RouteConfig`)();
            assert.equal(loaded.status, 'success');
            assert.deepEqual(
                loaded.data.routeWorkspace,
                saved.get(family),
                'fresh app/store instances must restore stable group IDs and drafts'
            );
        }
        const finalDisk = JSON.parse(fs.readFileSync(reopened.store.path, 'utf8'));
        assert.deepEqual(finalDisk[app.ipv4RouteWorkspaceFileKey], legacyMixed);
        assert.deepEqual(finalDisk[app.getRouteWorkspaceStoreKey(uncFamily)], saved.get(uncFamily));
        assert.deepEqual(finalDisk[app.getRouteWorkspaceStoreKey(labelFamily)], saved.get(labelFamily));
        console.log(
            'BGP family workspace save/generate/legacy/reopen persistence through real Electron Store IPC handlers passed'
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
