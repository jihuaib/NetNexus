// Persistence mutation construction: the direct payload builder must equal the
// generic compaction of a full route info object, cached attribute identities
// must match the uncached computation, and cached scope descriptors must not
// leak per-mutation state between calls.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const BmpConst = require('../../electron/const/bmpConst');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const { canonicalizeBmpRouteAttr } = require('../../electron/worker/bmp/bmpRouteAttrStore');
const {
    buildScopeMutation,
    buildRouteUpsertMutation,
    buildRouteWithdrawMutation,
    compactRoutePayload
} = require('../../electron/worker/bmp/bmpPersistenceMutation');
const { createRouteKey, KEY_SCHEMA_VERSION } = require('../../electron/utils/bmpPersistentRouteKey');

const bmpSession = {
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '192.0.2.10',
    remotePort: 55000,
    sysName: 'mutation-router',
    sysDesc: 'mutation test',
    bmpVersion: 4,
    getBmpV4TlvDraft: () => 20
};
const owner = new BmpBgpSession(bmpSession);
Object.assign(owner, {
    sessionType: 0,
    sessionRd: '0:0',
    sessionIp: '198.51.100.1',
    sessionAs: 65001,
    vrfTableNames: ['blue']
});
const RIB = BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;

function makeRoute(prefix, mask, attr, extra = {}) {
    const route = new BmpBgpRoute(owner, null);
    Object.assign(route, {
        afi: 1,
        safi: 1,
        ribType: RIB,
        pathId: 3,
        rd: '0:0',
        ip: prefix,
        mask,
        nlriDetail: { prefix, length: mask, pathId: 3, rd: '0:0', valid: true },
        ...extra
    });
    route.assignRouteAttr(attr);
    route.markActive(owner.getRibEpoch(1, 1, RIB));
    return route;
}

const attr = {
    origin: 'IGP',
    asPath: '65001 65002',
    med: 10,
    localPref: 200,
    communities: ['65001:1'],
    nextHop: '10.0.0.1'
};
const plain = makeRoute('203.0.113.0', 24, attr);
const decorated = makeRoute('203.0.114.0', 24, attr, {
    labels: '100(BOS)',
    pathStatus: BmpConst.BMP_PATH_STATUS.BEST,
    pathStatusText: 'Best',
    rdRaw: 'raw:0000000000000000'
});
decorated.setRouteTlvs([{ name: 'VRF/Table Name', value: 'blue' }]);

// 1. Payload builder equals generic compaction of getRouteInfo().
[plain, decorated].forEach(route => {
    const mutation = buildRouteUpsertMutation(bmpSession, owner, route, 1, 1, RIB, { kind: 'peer', isNewRoute: true });
    assert.deepEqual(JSON.parse(mutation.route.routeJson), compactRoutePayload(route.getRouteInfo()));
});
assert.deepEqual(
    JSON.parse(buildRouteUpsertMutation(bmpSession, owner, plain, 1, 1, RIB, { kind: 'peer' }).route.routeJson),
    {},
    'a plain route must share the empty payload'
);

// 2. Attribute identity matches the uncached computation, and is shared by
//    routes that share an attribute object.
const first = buildRouteUpsertMutation(bmpSession, owner, plain, 1, 1, RIB, { kind: 'peer', isNewRoute: true });
const second = buildRouteUpsertMutation(bmpSession, owner, decorated, 1, 1, RIB, { kind: 'peer', isNewRoute: true });
const expectedAttrJson = JSON.stringify(canonicalizeBmpRouteAttr(plain.getRouteAttr()));
assert.equal(first.route.attrJson, expectedAttrJson);
assert.equal(first.route.attrId, crypto.createHash('sha256').update(expectedAttrJson).digest('hex'));
assert.equal(second.route.attrId, first.route.attrId, 'same attribute set must hash identically');
const changed = makeRoute('203.0.115.0', 24, { ...attr, nextHop: '10.0.0.2' });
const third = buildRouteUpsertMutation(bmpSession, owner, changed, 1, 1, RIB, { kind: 'peer', isNewRoute: true });
assert.notEqual(third.route.attrId, first.route.attrId);

// 3. Compact NLRI: plain prefixes drop nlriJson and keep flags; the route key
//    is the v2 canonical string; identity fields are complete.
assert.equal(first.route.nlriJson, null);
assert.equal(first.route.nlriFlags, 3, 'valid + rd present');
assert.equal(first.route.prefix, '203.0.113.0');
assert.equal(first.route.prefixLength, 24);
assert.equal(first.route.keyVersion, KEY_SCHEMA_VERSION);
assert.equal(first.route.identityJson, createRouteKey({ afi: 1, safi: 1, pathId: 3, route: plain }).canonicalJson);
assert.equal(
    first.route.identityJson,
    ['bmp-route', '2', '1', '1', '3', 'ip-prefix', 'ipv4', 'cb007100', '24'].join('\u001f')
);

// 4. Scope descriptors are cached per owner, but epoch/state/reason follow each call.
const scopeA = buildScopeMutation(bmpSession, owner, 1, 1, RIB, 'scope_open', { kind: 'peer', state: 'syncing' });
owner.advanceRibEpoch(1, 1, RIB);
const scopeB = buildScopeMutation(bmpSession, owner, 1, 1, RIB, 'scope_eor', {
    kind: 'peer',
    state: 'ready',
    reason: 'eor'
});
assert.equal(scopeA.scope.id, scopeB.scope.id);
assert.equal(scopeA.scope.epoch + 1, scopeB.scope.epoch);
assert.equal(scopeA.scope.state, 'syncing');
assert.equal(scopeB.scope.state, 'ready');
assert.equal(scopeB.scope.reason, 'eor');
assert.equal(scopeA.scope.reason, null, 'cached descriptor must not be mutated by a later call');

// 5. Withdraw without the in-memory route still yields the same identity.
const withdraw = buildRouteWithdrawMutation(
    bmpSession,
    owner,
    { prefix: '203.0.113.0', length: 24, pathId: 3, rd: '0:0' },
    null,
    1,
    1,
    RIB,
    { kind: 'peer' }
);
assert.equal(withdraw.route.id, first.route.id);
assert.equal(withdraw.route.nlriJson, null);
assert.equal(withdraw.route.nlriFlags, 2, 'rd present, no valid flag');

console.log('BMP persistence mutation tests passed');
