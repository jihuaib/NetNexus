const BgpPeer = require('./bgpPeer');

class BgpInstance {
    constructor(vrfIndex, afi, safi) {
        this.vrfIndex = vrfIndex;
        this.afi = afi;
        this.safi = safi;

        this.peerMap = new Map();
        this.routeMap = new Map();
        // 自定义属性,
        this.customAttr = '';
        // 扩展团体属性
        this.rt = '';
        this.singleRouteSend = false;
        // QP路由下一跳 BSID
        this.bsid = '';
    }

    static makeKey(vrfIndex, afi, safi) {
        return `${vrfIndex}|${afi}|${safi}`;
    }

    static parseKey(key) {
        const [vrfIndex, afi, safi] = key.split('|');
        return { vrfIndex: parseInt(vrfIndex), afi: parseInt(afi), safi: parseInt(safi) };
    }

    addPeer(bgpSession) {
        const bgpPeer = new BgpPeer(bgpSession, this);
        this.peerMap.set(bgpSession.peerIp, bgpPeer);
    }

    changePeerState(peerIp, sessionState) {
        const peer = this.peerMap.get(peerIp);
        if (peer) {
            peer.changePeerState(sessionState);
        }
    }

    resetPeer(peerIp) {
        const peer = this.peerMap.get(peerIp);
        if (peer) {
            peer.resetPeer();
        }
    }

    sendRoute() {
        this.peerMap.forEach((peer, _) => {
            peer.sendRoute();
        });
    }

    withdrawRoute(withdrawnRoutes) {
        this.peerMap.forEach((peer, _) => {
            peer.withdrawRoute(withdrawnRoutes);
        });
    }
}

module.exports = BgpInstance;
