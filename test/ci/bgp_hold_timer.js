const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const BgpConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'bgpConst.js'));
const BgpSession = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgp', 'bgpSession.js'));

function makeSocket(localAddress = '192.0.2.10') {
    return {
        localAddress,
        destroyed: false,
        writes: [],
        write(buffer) {
            this.writes.push(Buffer.from(buffer));
            return true;
        },
        destroy() {
            this.destroyed = true;
        }
    };
}

function makeSession() {
    const session = new BgpSession(0, '192.0.2.1', new Map(), {});
    session.localAs = 65000;
    session.routerId = '192.0.2.10';
    session.holdTime = 30;
    return session;
}

function makeKeepAlivePacket() {
    const packet = Buffer.alloc(BgpConst.BGP_HEAD_LEN);
    packet.fill(0xff, 0, BgpConst.BGP_MARKER_LEN);
    packet.writeUInt16BE(BgpConst.BGP_HEAD_LEN, BgpConst.BGP_MARKER_LEN);
    packet.writeUInt8(BgpConst.BGP_PACKET_TYPE.KEEPALIVE, BgpConst.BGP_MARKER_LEN + 2);
    return packet;
}

{
    const socket = makeSocket();
    const session = makeSession();

    session.tcpConnectSuccess(socket);

    assert(session.holdTimer, 'TCP connect should start hold timer when holdTime is configured');
    assert.strictEqual(session.sessState, BgpConst.BGP_PEER_STATE.OPEN_SENT);
    assert.strictEqual(socket.writes[0].readUInt8(BgpConst.BGP_MARKER_LEN + 2), BgpConst.BGP_PACKET_TYPE.OPEN);

    session.handleSocketClosed(socket);
    assert.strictEqual(session.holdTimer, null, 'socket close should clear hold timer');
    assert.strictEqual(session.socket, null, 'socket close should clear session socket reference');
    assert.strictEqual(session.sessState, BgpConst.BGP_PEER_STATE.IDLE);
}

{
    const socket = makeSocket();
    const session = makeSession();
    session.holdTime = 0;

    session.tcpConnectSuccess(socket);

    assert.strictEqual(session.holdTimer, null, 'holdTime 0 should disable hold timer');
    session.resetSession();
}

{
    const socket = makeSocket();
    const session = makeSession();
    let refreshCount = 0;

    session.socket = socket;
    session.refreshHoldTimer = () => {
        refreshCount += 1;
    };

    session.recvMsg(makeKeepAlivePacket());

    assert.strictEqual(refreshCount, 1, 'a complete received BGP packet should refresh hold timer once');
}

{
    const socket = makeSocket();
    const session = makeSession();
    session.socket = socket;

    session.handleHoldTimerExpired();

    const notification = socket.writes[0];
    assert(notification, 'hold timer expiry should send a notification');
    assert.strictEqual(
        notification.readUInt8(BgpConst.BGP_MARKER_LEN + 2),
        BgpConst.BGP_PACKET_TYPE.NOTIFICATION,
        'hold timer expiry should send a BGP Notification'
    );
    assert.strictEqual(
        notification.readUInt8(BgpConst.BGP_MARKER_LEN + 3),
        BgpConst.BGP_ERROR_CODE.HOLD_TIMER_EXPIRED,
        'notification error code should be Hold Timer Expired'
    );
    assert.strictEqual(socket.destroyed, true, 'hold timer expiry should close the socket');
    assert.strictEqual(session.socket, null, 'hold timer expiry should clear session socket reference');
    assert.strictEqual(session.sessState, BgpConst.BGP_PEER_STATE.IDLE);
}

console.log('BGP hold timer tests passed');
