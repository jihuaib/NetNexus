const { getAddrFamilyType } = require('../utils/bgpUtils');
const { toSerializableTlvs } = require('../utils/bmpUtils');

class BmpBgpInstance {
    constructor(bmpSession) {
        this.bmpSession = bmpSession;

        this.afi = null;
        this.safi = null;
        this.instanceType = null;
        this.instanceFlags = null;
        this.rawInstanceFlags = null;
        this.instanceRd = null;
        this.instanceIp = null;
        this.instanceAs = null;
        this.instanceRouterId = null;
        this.instanceTimestamp = null;
        this.instanceTimestampMs = null;
        this.localIp = null;
        this.localPort = null;
        this.remotePort = null;
        this.instanceState = null;
        this.peerUpTlvs = [];
        this.lastRouteMonitoringTlvs = [];
        this.vrfTableNames = [];

        this.recvAddressFamilies = [];
        this.sendAddressFamilies = [];
        this.enabledAddressFamilies = [];
        this.ribTypes = [];

        this.recvAddPathMap = new Map();
        this.sendAddPathMap = new Map();
        this.isAddPath = false;

        this.bgpRoutes = new Map();
    }

    isAddPathReceiveEnabled(afi, safi) {
        const key = `${afi}|${safi}`;
        if (this.addPathMap.has(key)) {
            return this.addPathMap.get(key);
        }
        return false;
    }

    static makeKey(instanceType, instanceRd, afi, safi) {
        return `${instanceType}|${instanceRd}|${afi}|${safi}`;
    }

    static parseKey(key) {
        const [instanceType, instanceRd, afi, safi] = key.split('|');
        return {
            instanceType,
            instanceRd,
            afi,
            safi
        };
    }

    getInstanceInfo() {
        let addrFamilyTypes = [];
        this.enabledAddressFamilies.forEach(addrFamily => {
            addrFamilyTypes.push(getAddrFamilyType(addrFamily.afi, addrFamily.safi));
        });

        return {
            addrFamilyType: getAddrFamilyType(this.afi, this.safi),
            instanceType: this.instanceType,
            instanceFlags: this.instanceFlags,
            rawInstanceFlags: this.rawInstanceFlags,
            instanceRd: this.instanceRd,
            instanceIp: this.instanceIp,
            instanceAs: this.instanceAs,
            instanceRouterId: this.instanceRouterId,
            instanceTimestamp: this.instanceTimestamp,
            instanceTimestampMs: this.instanceTimestampMs,
            localIp: this.localIp,
            localPort: this.localPort,
            remotePort: this.remotePort,
            instanceState: this.instanceState,
            recvAddressFamilies: this.recvAddressFamilies,
            sendAddressFamilies: this.sendAddressFamilies,
            enabledAddressFamilies: this.enabledAddressFamilies,
            enabledAddrFamilyTypes: addrFamilyTypes,
            ribTypes: this.ribTypes,
            recvAddPathMap: Object.fromEntries(this.recvAddPathMap),
            sendAddPathMap: Object.fromEntries(this.sendAddPathMap),
            isAddPath: this.isAddPath,
            peerUpTlvs: toSerializableTlvs(this.peerUpTlvs),
            lastRouteMonitoringTlvs: toSerializableTlvs(this.lastRouteMonitoringTlvs),
            vrfTableNames: this.vrfTableNames
        };
    }

    closeInstance() {
        this.bgpRoutes.clear();
        this.recvAddPathMap.clear();
        this.sendAddPathMap.clear();
    }
}

module.exports = BmpBgpInstance;
