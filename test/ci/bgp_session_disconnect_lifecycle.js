const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const BgpSession = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpSession.js'));
const BgpConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'bgpConst.js'));

function makeSocket() {
    return {
        destroyed: false,
        writable: true,
        localAddress: '127.0.0.1',
        write() {
            return true;
        },
        destroy() {
            this.destroyed = true;
        }
    };
}

const stateChanges = [];
const instanceMap = new Map([
    [
        'ipv4',
        {
            changePeerState(peerIp, state) {
                stateChanges.push({ peerIp, state });
            }
        }
    ]
]);

const session = new BgpSession(0, '127.0.0.1', instanceMap, { sendEvent() {} });
const socket = makeSocket();
const timer = setTimeout(() => {}, 10000);
if (typeof timer.unref === 'function') {
    timer.unref();
}

session.socket = socket;
session.packetBuffer = Buffer.from([0xff, 0xff]);
session.holdTimer = timer;
session.changeSessionFsmState(BgpConst.BGP_PEER_STATE.ESTABLISHED);

session.handleSocketClosed(socket);

assert.strictEqual(session.socket, null, 'client TCP close should clear BGP session socket');
assert.strictEqual(session.packetBuffer.length, 0, 'client TCP close should clear buffered BGP packets');
assert.strictEqual(session.holdTimer, null, 'client TCP close should clear hold timer');
assert.strictEqual(session.sessState, BgpConst.BGP_PEER_STATE.IDLE, 'client TCP close should move session to Idle');
assert.deepStrictEqual(
    stateChanges[stateChanges.length - 1],
    { peerIp: '127.0.0.1', state: BgpConst.BGP_PEER_STATE.IDLE },
    'client TCP close should publish Idle to peer state'
);

session.handleSocketClosed(socket);
assert.strictEqual(session.sessState, BgpConst.BGP_PEER_STATE.IDLE, 'stale socket close should be idempotent');

console.log('BGP session disconnect lifecycle tests passed');
