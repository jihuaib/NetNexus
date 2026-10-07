const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const BgpConst = require('../../electron/const/bgpConst');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const { makeEvpnRouteKey, makeVpnRouteKey } = require('../../electron/utils/bgp/simulator/bgpVpnEvpn');
const { collectBgpGeneratedRoutes } = require('../../electron/utils/bgp/simulator/bgpRouteGenerator');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-vpn-evpn-storage-'));
const dbPath = path.join(directory, 'routes.sqlite');
const families = BgpConst.BGP_ADDR_FAMILY;
const evpnProfile = { addressFamily: families.L2VPN_EVPN, instanceKey: 'storage|25|70' };
const attr = { attributePolicy: 'configured', med: 15, pathAttributes: [{ type: 'med', value: 15 }] };
const esi = '00:01:02:03:04:05:06:07:08:09';
let store;

function entry(route) {
    return { route, attr };
}
function replace(id, routes, profile = evpnProfile) {
    return store.replaceRouteGroup(id, { groupName: id, ...profile, routes: routes.map(entry) });
}
function evpn(routeType, overrides = {}) {
    return {
        routeType,
        rd: routeType === 4 ? '192.0.2.10:1' : '65000:1',
        esi: routeType === 5 ? '00:00:00:00:00:00:00:00:00:00' : esi,
        esImportRt: '01:02:03:04:05:06',
        ethernetTagId: 100,
        macAddress: '00:11:22:33:44:55',
        ipAddress: '192.0.2.9',
        originatingRouterIp: '192.0.2.10',
        ip: '192.0.2.0',
        mask: 24,
        gatewayIp: '192.0.2.1',
        label: 16000,
        label2: 16001,
        encapsulationType: 'mpls',
        mpNextHop: '192.0.2.254',
        ...overrides
    };
}

try {
    store = new BgpRouteSqliteStore({ dbPath }).open();
    for (const routeType of [1, 2, 3, 4, 5]) {
        const id = `evpn-${routeType}`;
        const initial = evpn(routeType);
        assert.equal(replace(id, [initial]).inserted, 1);
        const before = store.getRouteGroupRoutes(id)[0];
        assert.equal(before.routeKey, makeEvpnRouteKey(initial));
        assert.equal(before.encapsulationType, 'mpls');
        if ([1, 2, 4, 5].includes(routeType)) assert.equal(before.esi, initial.esi);
        if (routeType === 4) assert.equal(before.esImportRt, initial.esImportRt);
        if ([1, 2, 3, 5].includes(routeType)) assert.equal(before.ethernetTagId, 100);
        if (routeType === 2) {
            assert.equal(before.macAddress, initial.macAddress);
            assert.equal(before.ipAddress, initial.ipAddress);
            assert.equal(before.label2, initial.label2);
        }
        if (routeType === 5) assert.equal(before.gatewayIp, initial.gatewayIp);
        const changed = evpn(routeType, { label: 17000, label2: 17001, gatewayIp: '192.0.2.2' });
        const result = replace(id, [changed]);
        assert.equal(result.updated, [1, 2, 3, 5].includes(routeType) ? 1 : 0);
        assert.equal(result.deleted, 0);
        assert.equal(store.getRouteGroupRoutes(id)[0].routeKey, before.routeKey);
        assert.equal(store.getRouteGroupRoutes(id)[0].attrId, before.attrId);
        assert.throws(() => replace(`${id}-overlap`, [changed]), /conflicts with/);
        replace(`${id}-other-rd`, [evpn(routeType, { rd: routeType === 4 ? '192.0.2.10:2' : '65000:2' })]);
        const snapshot = store.getRouteGroupRoutes(id);
        assert.throws(
            () =>
                replace(id, [
                    evpn(routeType, { rd: routeType === 4 ? '192.0.2.10:3' : '65000:3' }),
                    evpn(routeType, { rd: 'invalid' })
                ]),
            /RD/
        );
        assert.deepEqual(store.getRouteGroupRoutes(id), snapshot, 'late candidate failure must preserve the snapshot');
    }
    const macRoute = evpn(2, { rd: '65000:10', encapsulationType: 'vxlan', vni: 10000, vni2: 20000 });
    replace('vxlan', [macRoute]);
    const oldVxlan = store.getRouteGroupRoutes('vxlan')[0];
    assert.equal(oldVxlan.vni, 10000);
    assert.equal(oldVxlan.vni2, 20000);
    const vniChange = replace('vxlan', [
        { ...macRoute, vni: 10001, vni2: 20001, esi: '00:09:08:07:06:05:04:03:02:01' }
    ]);
    assert.equal(vniChange.updated, 1);
    const newVxlan = store.getRouteGroupRoutes('vxlan')[0];
    assert.equal(newVxlan.routeKey, oldVxlan.routeKey, 'VNI and Type 2 ESI changes update one semantic NLRI');
    assert.equal(newVxlan.vni2, 20001);
    assert.throws(
        () => store.upsertRoutes(evpnProfile.instanceKey, [{ routeKey: 'alternate-legacy-key', ...entry(macRoute) }]),
        /conflicts with route group vxlan/
    );
    const legacy = evpn(2, { rd: '65000:11', macAddress: '00:11:22:33:44:99' });
    store.upsertRoutes(evpnProfile.instanceKey, [{ routeKey: 'legacy-key', ...entry(legacy) }]);
    assert.throws(() => replace('legacy-collision', [legacy]), /existing legacy route/);

    for (const [family, afi, ip, mask] of [
        [families.VPNV4, 1, '198.51.100.0', 24],
        [families.VPNV6, 2, '2001:db8:100::', 64]
    ]) {
        const profile = { addressFamily: family, instanceKey: `storage|${afi}|128` };
        const route = { ip, mask, rd: '65000:1', label: 16000, mpNextHop: '192.0.2.254' };
        replace(`vpn-${afi}`, [route], profile);
        replace(`vpn-${afi}-other-rd`, [{ ...route, rd: '65000:2' }], profile);
        const key = makeVpnRouteKey(route, afi);
        assert.equal(replace(`vpn-${afi}`, [{ ...route, label: 16001 }], profile).updated, 1);
        assert.equal(store.getRouteGroupRoutes(`vpn-${afi}`)[0].routeKey, key);
        assert.equal(store.getRouteGroupRoutes(`vpn-${afi}`)[0].label, 16001);
        assert.equal(store.getRouteCount(profile.instanceKey), 2);
        const before = store.getRouteGroupRoutes(`vpn-${afi}`);
        assert.throws(() => replace(`vpn-${afi}`, [{ ...route, label: 0x100000 }], profile), /Label/);
        assert.deepEqual(store.getRouteGroupRoutes(`vpn-${afi}`), before);
        const generatedConfig = {
            addressFamily: family,
            prefix: afi === 1 ? '203.0.113.0' : '2001:db8:113::',
            mask,
            count: 3,
            nlriRules: [
                { type: 'rd', mode: 'list', values: ['65000:4294967295', '65536:65535', '192.0.2.1:65535'] },
                { type: 'label', mode: 'list', values: [0, 1048575, 17000] },
                { type: 'mpNextHop', mode: 'auto' }
            ]
        };
        const generated = collectBgpGeneratedRoutes(generatedConfig);
        replace(`vpn-${afi}-generated`, generated, profile);
        const snapshot = store.getRouteGroupRoutes(`vpn-${afi}-generated`);
        assert.deepEqual(
            snapshot.map(row => row.rd),
            generated.map(row => row.rd)
        );
        assert.deepEqual(
            snapshot.map(row => row.label),
            [0, 1048575, 17000]
        );
        generatedConfig.nlriRules[0] = { type: 'rd', mode: 'increment', base: '65536', start: 65535, step: 1 };
        assert.throws(() => collectBgpGeneratedRoutes(generatedConfig), /RD递增/);
        assert.deepEqual(store.getRouteGroupRoutes(`vpn-${afi}-generated`), snapshot);
    }
    const groupsBefore = store.listRouteGroups();
    const routesBefore = store.getRouteGroupRoutes('vxlan');
    store.close();
    store = new BgpRouteSqliteStore({ dbPath }).open();
    assert.deepEqual(store.listRouteGroups(), groupsBefore);
    assert.deepEqual(store.getRouteGroupRoutes('vxlan'), routesBefore);
    assert.equal(store.getRouteGroupRoutes('evpn-5')[0].gatewayIp, '192.0.2.2');
    assert.equal(store.getRouteGroupRoutes('evpn-4')[0].esImportRt, '01:02:03:04:05:06');
    for (const afi of [1, 2]) {
        const rows = store.getRouteGroupRoutes(`vpn-${afi}-generated`);
        assert.deepEqual(
            rows.map(row => row.rd),
            ['65000:4294967295', '65536:65535', '192.0.2.1:65535']
        );
        assert.deepEqual(
            rows.map(row => row.label),
            [0, 1048575, 17000]
        );
        const withdrawnVpn = store.withdrawRouteGroup(`vpn-${afi}-generated`);
        assert.equal(withdrawnVpn.deleted, 3);
        assert.deepEqual(
            withdrawnVpn.routes.map(row => row.routeKey),
            rows.map(row => row.routeKey)
        );
    }
    const withdrawn = store.withdrawRouteGroup('vxlan');
    assert.equal(withdrawn.deleted, 1);
    assert.equal(withdrawn.routes[0].vni2, 20001);
    store.close();

    // Recreate the previous schema to verify that version changes reset data.
    const migrationPath = path.join(directory, 'migration.sqlite');
    store = new BgpRouteSqliteStore({ dbPath: migrationPath }).open();
    const oldRoute = { ip: '203.0.113.0', mask: 24, rd: '65000:1', pathId: 0 };
    store.upsertRoutes('migration|1|1', [oldRoute]);
    store.close();
    let raw = new Database(migrationPath);
    const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bgp_routes_%'")
        .all();
    for (const { name } of tables) raw.exec(`ALTER TABLE ${name} DROP COLUMN nlri_json`);
    raw.pragma('user_version = 6');
    raw.close();
    store = new BgpRouteSqliteStore({ dbPath: migrationPath }).open();
    assert.equal(store.getStatus().schemaVersion, BgpRouteSqliteStore.SCHEMA_VERSION);
    assert.deepEqual(
        Array.from(store.iterateRoutes('migration|1|1')),
        [],
        'a v6 database must be reset instead of migrated'
    );
    store.close();
    raw = new Database(migrationPath);
    for (const { name } of tables)
        assert.ok(raw.pragma(`table_info(${name})`).some(column => column.name === 'nlri_json'));
    raw.close();

    // Even an incomplete older schema is reset without attempting ALTERs.
    const brokenPath = path.join(directory, 'broken-migration.sqlite');
    store = new BgpRouteSqliteStore({ dbPath: brokenPath }).open();
    store.close();
    raw = new Database(brokenPath);
    for (const { name } of tables.slice(0, -1)) raw.exec(`ALTER TABLE ${name} DROP COLUMN nlri_json`);
    raw.pragma('user_version = 6');
    raw.close();
    store = new BgpRouteSqliteStore({ dbPath: brokenPath }).open();
    assert.equal(store.getStatus().schemaVersion, BgpRouteSqliteStore.SCHEMA_VERSION);
    store.close();
    raw = new Database(brokenPath);
    assert.equal(raw.pragma('user_version', { simple: true }), BgpRouteSqliteStore.SCHEMA_VERSION);
    for (const { name } of tables)
        assert.ok(raw.pragma(`table_info(${name})`).some(column => column.name === 'nlri_json'));
    raw.close();
    console.log('BGP VPN/EVPN route persistence and schema reset tests passed');
} finally {
    if (store) store.close();
    fs.rmSync(directory, { recursive: true, force: true });
}
