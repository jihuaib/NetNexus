const assert = require('node:assert/strict');

const BmpConst = require('../../electron/const/bmpConst');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');

class NoScanMap extends Map {
    forEach() {
        throw new Error('route table scan is forbidden during epoch invalidation');
    }
}

const ribType = BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;
const session = new BmpBgpSession({});
const route = new BmpBgpRoute(session, null);
Object.assign(route, {
    afi: 1,
    safi: 1,
    ribType,
    ip: '203.0.113.0',
    mask: 24,
    pathId: 0,
    rd: '0:0'
});
route.markActive(session.getRibEpoch(1, 1, ribType));
const routeMap = new NoScanMap([[route.getRouteKey(), route]]);
session.bgpRoutes.set('1|1', new Map([[ribType, routeMap]]));
session.recordRouteAdd(1, 1, ribType, route);

const stale = session.markRoutesStale(1, 1, [ribType], 'peer-down:1')[0];
assert.deepEqual(stale, { afi: 1, safi: 1, ribType, staleEpoch: 1, changed: 1 });
assert.equal(route.routeState, BmpConst.BMP_ROUTE_STATE.STALE);
assert.equal(route.staleReason, 'peer-down:1');
assert.deepEqual(session.getRouteSummary(1, 1, ribType), { active: 0, stale: 1, total: 1 });

const previousState = route.routeState;
route.markActive(session.getRibEpoch(1, 1, ribType));
session.recordRouteStateChange(1, 1, ribType, previousState, route.routeState);
assert.equal(route.routeState, BmpConst.BMP_ROUTE_STATE.ACTIVE);
assert.equal(route.staleReason, null);
assert.deepEqual(session.getRouteSummary(1, 1, ribType), { active: 1, stale: 0, total: 1 });

const repeated = session.markRoutesStale(1, 1, [ribType], 'peer-down:2')[0];
assert.equal(repeated.changed, 1);
const alreadyStale = session.markRoutesStale(1, 1, [ribType], 'peer-down:3')[0];
assert.equal(alreadyStale.changed, 0);
assert.equal(route.routeState, BmpConst.BMP_ROUTE_STATE.STALE);
assert.equal(route.staleReason, 'peer-down:3');

const instance = new BmpBgpInstance({});
Object.assign(instance, { afi: 2, safi: 1 });
const instanceRoute = new BmpBgpRoute(null, instance);
Object.assign(instanceRoute, { afi: 2, safi: 1, ribType: 'loc-rib', ip: '2001:db8::', mask: 64 });
instanceRoute.markActive(instance.getRibEpoch());
instance.bgpRoutes = new NoScanMap([[instanceRoute.getRouteKey(), instanceRoute]]);
instance.recordRouteAdd(instanceRoute);

const instanceStale = instance.markRoutesStale('loc-rib-peer-down');
assert.deepEqual(instanceStale, { staleEpoch: 1, changed: 1 });
assert.equal(instanceRoute.routeState, BmpConst.BMP_ROUTE_STATE.STALE);
assert.equal(instanceRoute.staleReason, 'loc-rib-peer-down');
assert.deepEqual(instance.getRouteSummary(), { active: 0, stale: 1, total: 1 });

console.log('BMP O(1) epoch aging tests passed');
