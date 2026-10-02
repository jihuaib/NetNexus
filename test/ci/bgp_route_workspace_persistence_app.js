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
        const saved = new Map();
        for (const [configApi, generateApi, family] of families) {
            const routeWorkspace = {
                version: 1,
                profile: `${family}`,
                groups: [
                    {
                        id: `${family}-stable-1`,
                        name: 'First',
                        config: { count: 2, attributeRules: [], nlriRules: [] }
                    },
                    {
                        id: `${family}-stable-2`,
                        name: 'Second',
                        config: { count: 3, attributeRules: [{ type: 'med', value: 9 }], nlriRules: [] }
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
        for (const [, , family] of families)
            assert.deepEqual(disk[app.getRouteWorkspaceStoreKey(family)], saved.get(family));
        const reopened = makeApp();
        reopened.app.worker = null;
        for (const [configApi, , family] of families) {
            const loaded = await reopened.handlers.get(`bgp:load${configApi}RouteConfig`)();
            assert.equal(loaded.status, 'success');
            assert.deepEqual(
                loaded.data.routeWorkspace,
                saved.get(family),
                'fresh app/store instances must restore stable group IDs and drafts'
            );
        }
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
