const { getAddrFamilyType } = require('../utils/bgpUtils');
const { toSerializableTlvs } = require('../utils/bmpUtils');

class BmpBgpSession {
    constructor(bmpSession) {
        this.bmpSession = bmpSession;

        this.sessionType = null;
        this.sessionFlags = null;
        this.rawSessionFlags = null;
        this.sessionRd = null;
        this.sessionIp = null;
        this.sessionAs = null;
        this.sessionRouterId = null;
        this.sessionTimestamp = null;
        this.sessionTimestampMs = null;
        this.localIp = null;
        this.localPort = null;
        this.remotePort = null;
        this.sessionState = null;
        this.peerUpTlvs = [];
        this.peerDownTlvs = [];
        this.lastRouteMonitoringTlvs = [];
        this.peerDownReason = null;
        this.peerDownFsmEventCode = null;

        this.recvAddressFamilies = [];
        this.sendAddressFamilies = [];
        this.enabledAddressFamilies = [];
        this.ribTypes = [];

        this.recvAddPathMap = new Map();
        this.sendAddPathMap = new Map();
        this.addPathMap = new Map();

        this.bgpRoutes = new Map();
    }

    isAddPathReceiveEnabled(afi, safi) {
        const key = `${afi}|${safi}`;
        if (this.addPathMap.has(key)) {
            return this.addPathMap.get(key);
        }
        return false;
    }

    static makeKey(sessionType, sessionRd, sessionIp, sessionAs) {
        return `${sessionType}|${sessionRd}|${sessionIp}|${sessionAs}`;
    }

    static parseKey(key) {
        const [sessionType, sessionRd, sessionIp, sessionAs] = key.split('|');
        return {
            sessionType,
            sessionRd,
            sessionIp,
            sessionAs
        };
    }

    getSessionInfo() {
        let addrFamilyTypes = [];
        this.enabledAddressFamilies.forEach(addrFamily => {
            addrFamilyTypes.push(getAddrFamilyType(addrFamily.afi, addrFamily.safi));
        });

        let addPaths = new Map();
        this.addPathMap.forEach((value, key) => {
            const [afi, safi] = key.split('|');
            addPaths.set(getAddrFamilyType(parseInt(afi), parseInt(safi)), value);
        });
        return {
            sessionType: this.sessionType,
            sessionFlags: this.sessionFlags,
            rawSessionFlags: this.rawSessionFlags,
            sessionRd: this.sessionRd,
            sessionIp: this.sessionIp,
            sessionAs: this.sessionAs,
            sessionRouterId: this.sessionRouterId,
            sessionTimestamp: this.sessionTimestamp,
            sessionTimestampMs: this.sessionTimestampMs,
            localIp: this.localIp,
            localPort: this.localPort,
            remotePort: this.remotePort,
            sessionState: this.sessionState,
            recvAddressFamilies: this.recvAddressFamilies,
            sendAddressFamilies: this.sendAddressFamilies,
            enabledAddressFamilies: this.enabledAddressFamilies,
            enabledAddrFamilyTypes: addrFamilyTypes,
            ribTypes: this.ribTypes,
            recvAddPathMap: Object.fromEntries(this.recvAddPathMap),
            sendAddPathMap: Object.fromEntries(this.sendAddPathMap),
            addPathMap: Object.fromEntries(addPaths),
            peerUpTlvs: toSerializableTlvs(this.peerUpTlvs),
            peerDownTlvs: toSerializableTlvs(this.peerDownTlvs),
            lastRouteMonitoringTlvs: toSerializableTlvs(this.lastRouteMonitoringTlvs),
            peerDownReason: this.peerDownReason,
            peerDownFsmEventCode: this.peerDownFsmEventCode
        };
    }

    closeSession() {
        this.bgpRoutes.clear();
        this.recvAddPathMap.clear();
        this.sendAddPathMap.clear();
        this.addPathMap.clear();
    }
}

module.exports = BmpBgpSession;
