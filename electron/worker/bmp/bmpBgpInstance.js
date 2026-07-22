const { getAddrFamilyType } = require('../../utils/bgpUtils');
const { toSerializableTlvs } = require('../../utils/bmpUtils');
const BgpConst = require('../../const/bgpConst');

class BmpBgpInstance {
    constructor(bmpSession) {
        this.bmpSession = bmpSession;

        this.afi = null;
        this.safi = null;
        this.instanceType = null;
        this.instanceFlags = null;
        this.rawInstanceFlags = null;
        this.instanceRd = null;
        this.instanceRdRaw = null;
        this.instanceIp = null;
        this.instanceAs = null;
        this.instanceRouterId = null;
        this.instanceTimestamp = null;
        this.instanceTimestampMicroseconds = null;
        this.instanceTimestampMs = null;
        this.localIp = null;
        this.localPort = null;
        this.remotePort = null;
        this.instanceState = null;
        this.peerUpTlvs = [];
        this.vrfTableNames = [];

        this.recvAddressFamilies = [];
        this.sendAddressFamilies = [];
        this.enabledAddressFamilies = [];
        this.ribTypes = [];

        this.recvAddPathMap = new Map();
        this.sendAddPathMap = new Map();
        this.addPathReceiveMap = new Map();
        this.addPathSendMap = new Map();
        this.isAddPath = false;
        // Route Monitoring may lazily create an instance before its first real
        // Peer Up. This flag distinguishes that case from a repeated AF refresh.
        this.peerUpSeen = false;

        // Full Loc-RIB route payloads are persisted in SQLite. The instance keeps
        // only lifecycle metadata and a small cached summary.
        this.routeSummary = { active: 0, stale: 0, total: 0 };
        this.ribEpoch = 0;
        this.ribStaleMetadata = null;
    }

    getAddPathEnabledForKey(key, direction = 'receive') {
        if (direction === 'send') {
            return this.addPathSendMap.get(key) === true;
        }
        if (direction === 'any') {
            return this.addPathReceiveMap.get(key) === true || this.addPathSendMap.get(key) === true;
        }
        if (this.addPathReceiveMap.has(key)) {
            return this.addPathReceiveMap.get(key) === true;
        }
        return false;
    }

    hasAddressFamily(addressFamilies, afi, safi) {
        return (
            Array.isArray(addressFamilies) &&
            addressFamilies.some(
                addrFamily => Number(addrFamily.afi) === Number(afi) && Number(addrFamily.safi) === Number(safi)
            )
        );
    }

    hasAdvertisedAddressFamily(afi, safi) {
        return (
            this.hasAddressFamily(this.recvAddressFamilies, afi, safi) ||
            this.hasAddressFamily(this.sendAddressFamilies, afi, safi)
        );
    }

    getAddPathReceiveInfo(afi, safi, direction = 'receive') {
        const key = `${afi}|${safi}`;
        if (this.getAddPathEnabledForKey(key, direction)) {
            return { enabled: true };
        }

        if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST && !this.hasAdvertisedAddressFamily(afi, safi)) {
            const unicastKey = `${afi}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`;
            if (this.getAddPathEnabledForKey(unicastKey, direction)) {
                return {
                    enabled: true,
                    inferred: true
                };
            }
        }

        return { enabled: false };
    }

    isAddPathReceiveEnabled(afi, safi, direction = 'receive') {
        return this.getAddPathReceiveInfo(afi, safi, direction).enabled;
    }

    static makeKey(instanceType, instanceRd, afi, safi, instanceRdRaw = null) {
        return `${instanceType}|${instanceRdRaw || instanceRd}|${afi}|${safi}`;
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

    getRouteSummary() {
        return { ...this.routeSummary };
    }

    setRouteSummary(summary = {}) {
        this.routeSummary = {
            active: Math.max(0, Number(summary.active) || 0),
            stale: Math.max(0, Number(summary.stale) || 0),
            total: Math.max(0, Number(summary.total) || 0)
        };
        return this.getRouteSummary();
    }

    getRibEpoch() {
        return this.ribEpoch || 0;
    }

    advanceRibEpoch() {
        this.ribEpoch = this.getRibEpoch() + 1;
        return this.ribEpoch;
    }

    markRoutesStale(reason) {
        const staleEpoch = this.advanceRibEpoch();
        const changed = this.routeSummary.active;
        this.routeSummary.active = 0;
        this.routeSummary.stale = this.routeSummary.total;
        this.ribStaleMetadata = {
            staleEpoch,
            staleReason: reason,
            staleAt: new Date().toISOString()
        };
        return { staleEpoch, changed };
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
            instanceRdRaw: this.instanceRdRaw,
            instanceIp: this.instanceIp,
            instanceAs: this.instanceAs,
            instanceRouterId: this.instanceRouterId,
            instanceTimestamp: this.instanceTimestamp,
            instanceTimestampMicroseconds: this.instanceTimestampMicroseconds,
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
            addPathReceiveMap: Object.fromEntries(this.addPathReceiveMap),
            addPathSendMap: Object.fromEntries(this.addPathSendMap),
            isAddPath: this.isAddPath,
            peerUpTlvs: toSerializableTlvs(this.peerUpTlvs),
            vrfTableNames: this.vrfTableNames,
            ribEpoch: this.ribEpoch,
            routeSummary: this.getRouteSummary()
        };
    }

    closeInstance() {
        this.routeSummary = { active: 0, stale: 0, total: 0 };
        this.recvAddPathMap.clear();
        this.sendAddPathMap.clear();
        this.addPathReceiveMap.clear();
        this.addPathSendMap.clear();
        this.isAddPath = false;
        this.peerUpSeen = false;
        this.ribEpoch = 0;
        this.ribStaleMetadata = null;
    }
}

module.exports = BmpBgpInstance;
