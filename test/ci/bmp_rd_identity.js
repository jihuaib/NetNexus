const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const BmpSession = require(path.join(root, 'electron', 'worker', 'bmp', 'bmpSession.js'));
const BmpBgpSession = require(path.join(root, 'electron', 'worker', 'bmp', 'bmpBgpSession.js'));
const BmpBgpInstance = require(path.join(root, 'electron', 'worker', 'bmp', 'bmpBgpInstance.js'));
const BmpBgpRoute = require(path.join(root, 'electron', 'worker', 'bmp', 'bmpBgpRoute.js'));

const DISPLAY_RD = '65000:7';
const TYPE_ZERO_RD = 'raw:0000fde800000007';
const TYPE_TWO_RD = 'raw:00020000fde80007';

const bmpSession = new BmpSession({ sendEvent() {} }, {});

function makeSession(rdRaw) {
    const session = new BmpBgpSession(bmpSession);
    session.sessionType = 1;
    session.sessionRd = DISPLAY_RD;
    session.sessionRdRaw = rdRaw;
    session.sessionIp = '192.0.2.1';
    session.sessionAs = 65000;
    return session;
}

const sessionTypeZero = makeSession(TYPE_ZERO_RD);
const sessionTypeTwo = makeSession(TYPE_TWO_RD);
const sessionTypeZeroKey = BmpBgpSession.makeKey(1, DISPLAY_RD, '192.0.2.1', 65000, TYPE_ZERO_RD);
const sessionTypeTwoKey = BmpBgpSession.makeKey(1, DISPLAY_RD, '192.0.2.1', 65000, TYPE_TWO_RD);
assert.notStrictEqual(sessionTypeZeroKey, sessionTypeTwoKey);
bmpSession.bgpSessionMap.set(sessionTypeZeroKey, sessionTypeZero);
bmpSession.bgpSessionMap.set(sessionTypeTwoKey, sessionTypeTwo);
assert.strictEqual(bmpSession.bgpSessionMap.size, 2);
assert.strictEqual(bmpSession.bgpSessionMap.get(sessionTypeZeroKey), sessionTypeZero);
assert.strictEqual(bmpSession.bgpSessionMap.get(sessionTypeTwoKey), sessionTypeTwo);
assert.strictEqual(
    bmpSession.bgpSessionMap.get(BmpBgpSession.makeKey(1, DISPLAY_RD, '192.0.2.1', 65000)),
    undefined,
    'a display-only lookup must not choose between colliding binary RDs'
);
assert.strictEqual(sessionTypeZero.getSessionInfo().sessionRdRaw, TYPE_ZERO_RD);

function makeInstance(rdRaw) {
    const instance = new BmpBgpInstance(bmpSession);
    instance.instanceType = 3;
    instance.instanceRd = DISPLAY_RD;
    instance.instanceRdRaw = rdRaw;
    instance.afi = 1;
    instance.safi = 128;
    return instance;
}

const instanceTypeZero = makeInstance(TYPE_ZERO_RD);
const instanceTypeTwo = makeInstance(TYPE_TWO_RD);
const instanceTypeZeroKey = BmpBgpInstance.makeKey(3, DISPLAY_RD, 1, 128, TYPE_ZERO_RD);
const instanceTypeTwoKey = BmpBgpInstance.makeKey(3, DISPLAY_RD, 1, 128, TYPE_TWO_RD);
assert.notStrictEqual(instanceTypeZeroKey, instanceTypeTwoKey);
bmpSession.bgpInstanceMap.set(instanceTypeZeroKey, instanceTypeZero);
bmpSession.bgpInstanceMap.set(instanceTypeTwoKey, instanceTypeTwo);
assert.strictEqual(bmpSession.bgpInstanceMap.size, 2);
assert.strictEqual(bmpSession.bgpInstanceMap.get(instanceTypeZeroKey), instanceTypeZero);
assert.strictEqual(bmpSession.bgpInstanceMap.get(instanceTypeTwoKey), instanceTypeTwo);
assert.strictEqual(
    bmpSession.bgpInstanceMap.get(BmpBgpInstance.makeKey(3, DISPLAY_RD, 1, 128)),
    undefined,
    'a display-only instance lookup must remain ambiguous'
);
assert.strictEqual(instanceTypeTwo.getInstanceInfo().instanceRdRaw, TYPE_TWO_RD);

const routeTypeZero = new BmpBgpRoute(sessionTypeZero, null);
routeTypeZero.pathId = 11;
routeTypeZero.rd = DISPLAY_RD;
routeTypeZero.rdRaw = TYPE_ZERO_RD;
routeTypeZero.ip = '203.0.113.0';
routeTypeZero.mask = 24;

const routeTypeTwo = new BmpBgpRoute(sessionTypeTwo, null);
routeTypeTwo.pathId = 11;
routeTypeTwo.rd = DISPLAY_RD;
routeTypeTwo.rdRaw = TYPE_TWO_RD;
routeTypeTwo.ip = '203.0.113.0';
routeTypeTwo.mask = 24;

assert.notStrictEqual(routeTypeZero.getRouteKey(), routeTypeTwo.getRouteKey());
const routes = new Map([
    [routeTypeZero.getRouteKey(), routeTypeZero],
    [routeTypeTwo.getRouteKey(), routeTypeTwo]
]);
assert.strictEqual(routes.size, 2);
assert.strictEqual(routeTypeZero.getRouteInfo().rdRaw, TYPE_ZERO_RD);

console.log('BMP raw RD identity tests passed');
