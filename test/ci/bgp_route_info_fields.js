const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const BgpConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'bgpConst.js'));
const BgpInstance = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpInstance.js'));
const BgpRoute = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpRoute.js'));

function getRouteInfo(instance, key, route, attr = {}) {
    instance.setRoute(key, route, attr);
    return route.getRouteInfo(instance.getRouteAttr(route));
}

function assertHasFields(routeInfo, fields) {
    for (const field of fields) {
        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(routeInfo, field),
            true,
            `route info should contain ${field}`
        );
    }
}

function assertOmitsFields(routeInfo, fields) {
    for (const field of fields) {
        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(routeInfo, field),
            false,
            `route info should not contain ${field}`
        );
    }
}

function assertObjectOmitsFields(object, fields) {
    for (const field of fields) {
        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(object, field),
            false,
            `object should not own ${field}`
        );
    }
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
    const route = new BgpRoute(instance);
    route.ip = '192.0.2.0';
    route.mask = 24;

    const routeInfo = getRouteInfo(instance, BgpRoute.makeKey(route.ip, route.mask), route, {
        nextHop: '192.0.2.254',
        asPath: '65000 65001'
    });

    assertHasFields(routeInfo, ['addressFamily', 'ip', 'mask', 'nextHop', 'asPath']);
    assertObjectOmitsFields(route, [
        'routeType',
        'rd',
        'originatingRouterIp',
        'sourceIp',
        'groupIp',
        'sourceAs',
        'dqpn'
    ]);
    assertOmitsFields(routeInfo, [
        'routeType',
        'rd',
        'originatingRouterIp',
        'sourceIp',
        'groupIp',
        'sourceAs',
        'dqpn',
        'bsid',
        'attrId'
    ]);
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_QP);
    const route = new BgpRoute(instance);
    route.ip = '10.0.0.1';
    route.mask = 32;
    route.dqpn = 7;

    const routeInfo = getRouteInfo(instance, BgpRoute.makeQpKey(route.dqpn, route.ip, route.mask), route, {
        nextHop: '2001:db8::7'
    });

    assertHasFields(routeInfo, ['addressFamily', 'ip', 'mask', 'nextHop', 'dqpn']);
    assertObjectOmitsFields(route, ['routeType', 'rd', 'originatingRouterIp', 'sourceIp', 'groupIp', 'sourceAs']);
    assertOmitsFields(routeInfo, [
        'routeType',
        'rd',
        'originatingRouterIp',
        'sourceIp',
        'groupIp',
        'sourceAs',
        'bsid',
        'attrId'
    ]);
}

{
    const instance = new BgpInstance(0, BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_MVPN);
    const route = new BgpRoute(instance);
    route.routeType = BgpConst.BGP_MVPN_ROUTE_TYPE.S_PMSI_AD;
    route.rd = '65000:1';
    route.sourceIp = '192.0.2.1';
    route.groupIp = '239.1.1.1';
    route.originatingRouterIp = '192.0.2.254';

    const key = `${route.routeType}|${route.rd}|${route.sourceAs || ''}|${route.sourceIp || ''}|${route.groupIp || ''}|${route.originatingRouterIp || ''}`;
    const routeInfo = getRouteInfo(instance, key, route, { rt: '65000:100' });

    assertHasFields(routeInfo, [
        'addressFamily',
        'routeType',
        'rd',
        'originatingRouterIp',
        'sourceIp',
        'groupIp',
        'sourceAs',
        'rt'
    ]);
    assertObjectOmitsFields(route, ['ip', 'mask', 'dqpn']);
    assertOmitsFields(routeInfo, ['ip', 'mask', 'dqpn', 'bsid', 'attrId']);
}

console.log('BGP route info field tests passed');
