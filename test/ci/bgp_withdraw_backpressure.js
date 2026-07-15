const assert = require('node:assert/strict');
const BgpConst = require('../../electron/const/bgpConst');
const BgpPeer = require('../../electron/worker/bgp/bgpPeer');

(async () => {
    let resetCount = 0;
    const session = {
        peerIp: '192.0.2.1',
        resetSession() {
            resetCount += 1;
        }
    };
    const instance = {
        afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    };
    const peer = new BgpPeer(session, instance);
    peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;

    let releaseWithdraw;
    const blockedWithdraw = new Promise(resolve => {
        releaseWithdraw = resolve;
    });
    peer.withdrawRouteNow = () => blockedWithdraw;

    const activeWithdraw = peer.withdrawRoute([{ ip: '198.51.100.0', mask: 24 }]);
    assert.ok(activeWithdraw && typeof activeWithdraw.then === 'function');

    let incrementalSendCount = 0;
    let fullSendCount = 0;
    peer.sendRouteBatchNow = () => {
        incrementalSendCount += 1;
        return null;
    };
    peer.sendRoutePage = () => {
        fullSendCount += 1;
        return null;
    };

    const routeBatch = [{ ip: '203.0.113.0', mask: 24 }];
    assert.strictEqual(
        peer.sendRouteBatch(routeBatch),
        activeWithdraw,
        'incremental announcement should join the active withdraw without retaining or sending its batch'
    );
    assert.strictEqual(
        peer.sendRoute(),
        activeWithdraw,
        'full route refresh should join the active withdraw instead of starting a concurrent stream'
    );
    assert.strictEqual(incrementalSendCount, 0, 'announcement builder must not run during withdraw backpressure');
    assert.strictEqual(fullSendCount, 0, 'full-table builder must not run during withdraw backpressure');
    assert.strictEqual(resetCount, 1, 'concurrent announcements should request one bounded session resync');
    assert.strictEqual(peer.resyncRequested, true);
    assert.equal(
        Object.values(peer).includes(routeBatch),
        false,
        'peer must not retain the skipped announcement batch while waiting for withdraw backpressure'
    );

    releaseWithdraw();
    await activeWithdraw;
    assert.strictEqual(peer.activeWithdrawPromise, null, 'withdraw state should clear after backpressure resolves');

    console.log('BGP withdraw backpressure tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
