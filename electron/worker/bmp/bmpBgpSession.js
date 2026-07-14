const { getAddrFamilyType } = require('../../utils/bgpUtils');
const { toSerializableTlvs } = require('../../utils/bmpUtils');
const BgpConst = require('../../const/bgpConst');

class BmpBgpSession {
    constructor(bmpSession) {
        this.bmpSession = bmpSession;

        this.sessionType = null;
        this.sessionFlags = null;
        this.rawSessionFlags = null;
        this.sessionRd = null;
        this.sessionRdRaw = null;
        this.sessionIp = null;
        this.sessionAs = null;
        this.sessionRouterId = null;
        this.sessionTimestamp = null;
        this.sessionTimestampMicroseconds = null;
        this.sessionTimestampMs = null;
        this.localIp = null;
        this.localPort = null;
        this.remotePort = null;
        this.sessionState = null;
        this.peerUpTlvs = [];
        this.peerDownTlvs = [];
        this.lastRouteMonitoringTlvs = [];
        this.vrfTableNames = [];
        this.peerDownReason = null;
        this.peerDownFsmEventCode = null;

        this.recvAddressFamilies = [];
        this.sendAddressFamilies = [];
        this.enabledAddressFamilies = [];
        this.ribTypes = [];

        this.recvAddPathMap = new Map();
        this.sendAddPathMap = new Map();
        this.addPathReceiveMap = new Map();
        this.addPathSendMap = new Map();
        this.addPathMap = new Map();

        // Route payloads live exclusively in SQLite. Keep only one small record per
        // observed RIB scope so packet parsing and Peer Up/Down lifecycle handling do
        // not scale with the number of routes.
        this.routeScopes = new Map();
        this.routeSummaries = new Map();
        this.ribEpochMap = new Map();
        this.ribStaleMetadataMap = new Map();
    }

    getAddPathEnabledForKey(key, direction = 'receive') {
        if (direction === 'send') {
            return this.addPathSendMap.get(key) === true;
        }
        if (direction === 'any') {
            return (
                this.addPathReceiveMap.get(key) === true ||
                this.addPathSendMap.get(key) === true ||
                this.addPathMap.get(key) === true
            );
        }
        if (this.addPathReceiveMap.has(key)) {
            return this.addPathReceiveMap.get(key) === true;
        }
        if (this.addPathMap.has(key)) {
            return this.addPathMap.get(key) === true;
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

    static makeKey(sessionType, sessionRd, sessionIp, sessionAs, sessionRdRaw = null) {
        return `${sessionType}|${sessionRdRaw || sessionRd}|${sessionIp}|${sessionAs}`;
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

    static makeRibEpochKey(afi, safi, ribType) {
        return `${afi}|${safi}|${ribType}`;
    }

    getRouteTableKey(afi, safi, ribType) {
        return `${afi}|${safi}|${ribType}`;
    }

    getRouteSummary(afi = null, safi = null, ribType = null) {
        if (
            afi !== null &&
            afi !== undefined &&
            safi !== null &&
            safi !== undefined &&
            ribType !== null &&
            ribType !== undefined
        ) {
            const summary = this.ensureRouteTableSummary(afi, safi, ribType);
            return { ...summary };
        }

        const summary = { active: 0, stale: 0, total: 0 };
        this.routeSummaries.forEach(item => {
            summary.active += item.active;
            summary.stale += item.stale;
            summary.total += item.total;
        });
        return summary;
    }

    ensureRouteTableSummary(afi, safi, ribType) {
        const key = this.getRouteTableKey(afi, safi, ribType);
        if (!this.routeSummaries.has(key)) {
            this.routeSummaries.set(key, { active: 0, stale: 0, total: 0 });
        }
        return this.routeSummaries.get(key);
    }

    setRouteSummary(afi, safi, ribType, summary = {}) {
        const value = {
            active: Math.max(0, Number(summary.active) || 0),
            stale: Math.max(0, Number(summary.stale) || 0),
            total: Math.max(0, Number(summary.total) || 0)
        };
        this.routeSummaries.set(this.getRouteTableKey(afi, safi, ribType), value);
        return { ...value };
    }

    ensureRouteScope(afi, safi, ribType) {
        const key = this.getRouteTableKey(afi, safi, ribType);
        if (!this.routeScopes.has(key)) {
            this.routeScopes.set(key, {
                afi: Number(afi),
                safi: Number(safi),
                ribType
            });
        }
        return this.routeScopes.get(key);
    }

    getRouteScopeAddressFamilies() {
        const families = new Map();
        this.routeScopes.forEach(scope => {
            families.set(`${scope.afi}|${scope.safi}`, { afi: scope.afi, safi: scope.safi });
        });
        return Array.from(families.values());
    }

    getRibEpoch(afi, safi, ribType) {
        const key = BmpBgpSession.makeRibEpochKey(afi, safi, ribType);
        if (!this.ribEpochMap.has(key)) {
            this.ribEpochMap.set(key, 0);
        }
        return this.ribEpochMap.get(key);
    }

    advanceRibEpoch(afi, safi, ribType) {
        const key = BmpBgpSession.makeRibEpochKey(afi, safi, ribType);
        const nextEpoch = this.getRibEpoch(afi, safi, ribType) + 1;
        this.ribEpochMap.set(key, nextEpoch);
        return nextEpoch;
    }

    markRoutesStale(afi, safi, ribTypes, reason) {
        const targetRibTypes =
            Array.isArray(ribTypes) && ribTypes.length > 0
                ? ribTypes
                : Array.from(this.routeScopes.values())
                      .filter(scope => scope.afi === Number(afi) && scope.safi === Number(safi))
                      .map(scope => scope.ribType);

        return targetRibTypes.map(ribType => {
            this.ensureRouteScope(afi, safi, ribType);
            const staleEpoch = this.advanceRibEpoch(afi, safi, ribType);
            const summary = this.ensureRouteTableSummary(afi, safi, ribType);
            const changed = summary.active;
            summary.active = 0;
            summary.stale = summary.total;
            this.ribStaleMetadataMap.set(BmpBgpSession.makeRibEpochKey(afi, safi, ribType), {
                staleEpoch,
                staleReason: reason,
                staleAt: new Date().toISOString()
            });
            return { afi, safi, ribType, staleEpoch, changed };
        });
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
        const addPathReceiveMap = {};
        this.addPathReceiveMap.forEach((value, key) => {
            const [afi, safi] = key.split('|');
            addPathReceiveMap[getAddrFamilyType(parseInt(afi), parseInt(safi))] = value;
        });
        const addPathSendMap = {};
        this.addPathSendMap.forEach((value, key) => {
            const [afi, safi] = key.split('|');
            addPathSendMap[getAddrFamilyType(parseInt(afi), parseInt(safi))] = value;
        });
        return {
            sessionType: this.sessionType,
            sessionFlags: this.sessionFlags,
            rawSessionFlags: this.rawSessionFlags,
            sessionRd: this.sessionRd,
            sessionRdRaw: this.sessionRdRaw,
            sessionIp: this.sessionIp,
            sessionAs: this.sessionAs,
            sessionRouterId: this.sessionRouterId,
            sessionTimestamp: this.sessionTimestamp,
            sessionTimestampMicroseconds: this.sessionTimestampMicroseconds,
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
            addPathReceiveMap,
            addPathSendMap,
            addPathMap: Object.fromEntries(addPaths),
            peerUpTlvs: toSerializableTlvs(this.peerUpTlvs),
            peerDownTlvs: toSerializableTlvs(this.peerDownTlvs),
            lastRouteMonitoringTlvs: toSerializableTlvs(this.lastRouteMonitoringTlvs),
            vrfTableNames: this.vrfTableNames,
            peerDownReason: this.peerDownReason,
            peerDownFsmEventCode: this.peerDownFsmEventCode,
            ribEpochMap: Object.fromEntries(this.ribEpochMap),
            routeSummary: this.getRouteSummary()
        };
    }

    closeSession() {
        this.routeScopes.clear();
        this.routeSummaries.clear();
        this.recvAddPathMap.clear();
        this.sendAddPathMap.clear();
        this.addPathReceiveMap.clear();
        this.addPathSendMap.clear();
        this.addPathMap.clear();
        this.ribEpochMap.clear();
        this.ribStaleMetadataMap.clear();
    }
}

module.exports = BmpBgpSession;
