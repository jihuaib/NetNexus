const { getAddrFamilyType } = require('../../utils/bgpUtils');
const { toSerializableTlvs } = require('../../utils/bmpUtils');
const { getRoutePrefixIndexKeys } = require('../../utils/routePrefixUtils');
const BmpConst = require('../../const/bmpConst');
const BgpConst = require('../../const/bgpConst');
const { BmpRouteAttrStore, DEFAULT_BMP_ROUTE_ATTR } = require('./bmpRouteAttrStore');

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

        this.bgpRoutes = new Map();
        this.attrStore = new BmpRouteAttrStore();
        this.routePrefixIndexes = new Map();
        this.routeSummaries = new Map();
        this.ribEpochMap = new Map();
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

    getAddPathReceiveInfo(afi, safi, direction = 'receive') {
        const key = `${afi}|${safi}`;
        if (this.getAddPathEnabledForKey(key, direction)) {
            return { enabled: true };
        }

        if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST) {
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

    static makeRibEpochKey(afi, safi, ribType) {
        return `${afi}|${safi}|${ribType}`;
    }

    static normalizeRouteState(routeState) {
        return routeState === BmpConst.BMP_ROUTE_STATE.STALE
            ? BmpConst.BMP_ROUTE_STATE.STALE
            : BmpConst.BMP_ROUTE_STATE.ACTIVE;
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

    updateSummaryStateCount(summary, routeState, delta) {
        const state = BmpBgpSession.normalizeRouteState(routeState);
        if (state === BmpConst.BMP_ROUTE_STATE.STALE) {
            summary.stale = Math.max(0, summary.stale + delta);
        } else {
            summary.active = Math.max(0, summary.active + delta);
        }
    }

    recordRouteAdd(afi, safi, ribType, route) {
        const summary = this.ensureRouteTableSummary(afi, safi, ribType);
        summary.total += 1;
        this.updateSummaryStateCount(summary, route.routeState, 1);
    }

    recordRouteDelete(afi, safi, ribType, route) {
        const summary = this.ensureRouteTableSummary(afi, safi, ribType);
        summary.total = Math.max(0, summary.total - 1);
        this.updateSummaryStateCount(summary, route.routeState, -1);
    }

    recordRouteStateChange(afi, safi, ribType, previousState, nextState) {
        const previous = BmpBgpSession.normalizeRouteState(previousState);
        const next = BmpBgpSession.normalizeRouteState(nextState);
        if (previous === next) {
            return;
        }

        const summary = this.ensureRouteTableSummary(afi, safi, ribType);
        this.updateSummaryStateCount(summary, previous, -1);
        this.updateSummaryStateCount(summary, next, 1);
    }

    ensureRoutePrefixIndex(afi, safi, ribType) {
        const tableKey = this.getRouteTableKey(afi, safi, ribType);
        if (!this.routePrefixIndexes.has(tableKey)) {
            this.routePrefixIndexes.set(tableKey, new Map());
        }
        return this.routePrefixIndexes.get(tableKey);
    }

    addRouteKeyToPrefixIndex(prefixIndex, prefixKey, routeKey) {
        const existing = prefixIndex.get(prefixKey);
        if (!existing) {
            prefixIndex.set(prefixKey, routeKey);
            return;
        }

        if (existing instanceof Set) {
            existing.add(routeKey);
            return;
        }

        if (existing !== routeKey) {
            prefixIndex.set(prefixKey, new Set([existing, routeKey]));
        }
    }

    removeRouteKeyFromPrefixIndex(prefixIndex, prefixKey, routeKey) {
        const existing = prefixIndex.get(prefixKey);
        if (!existing) {
            return;
        }

        if (!(existing instanceof Set)) {
            if (existing === routeKey) {
                prefixIndex.delete(prefixKey);
            }
            return;
        }

        existing.delete(routeKey);
        if (existing.size === 0) {
            prefixIndex.delete(prefixKey);
            return;
        }

        if (existing.size === 1) {
            prefixIndex.set(prefixKey, existing.values().next().value);
        }
    }

    addRouteToPrefixIndex(afi, safi, ribType, routeKey, route) {
        const prefixIndex = this.ensureRoutePrefixIndex(afi, safi, ribType);
        getRoutePrefixIndexKeys(route).forEach(prefixKey => {
            this.addRouteKeyToPrefixIndex(prefixIndex, prefixKey, routeKey);
        });
    }

    removeRouteFromPrefixIndex(afi, safi, ribType, routeKey, route) {
        const tableKey = this.getRouteTableKey(afi, safi, ribType);
        const prefixIndex = this.routePrefixIndexes.get(tableKey);
        if (!prefixIndex) {
            return;
        }

        getRoutePrefixIndexKeys(route).forEach(prefixKey => {
            this.removeRouteKeyFromPrefixIndex(prefixIndex, prefixKey, routeKey);
        });
    }

    getRouteKeysByPrefix(afi, safi, ribType, prefixKey) {
        const tableKey = this.getRouteTableKey(afi, safi, ribType);
        const routeKeys = this.routePrefixIndexes.get(tableKey)?.get(prefixKey);
        if (!routeKeys) {
            return [];
        }
        return routeKeys instanceof Set ? routeKeys : [routeKeys];
    }

    assignRouteAttr(route, attr) {
        if (!route) {
            return null;
        }

        const nextAttrId = this.attrStore.intern(attr);
        const prevAttrId = route.attrId;

        if (prevAttrId === nextAttrId) {
            this.attrStore.release(nextAttrId);
            route._inlineAttr = null;
            return nextAttrId;
        }

        if (prevAttrId) {
            this.attrStore.release(prevAttrId);
        }

        route.attrId = nextAttrId;
        route._inlineAttr = null;
        return nextAttrId;
    }

    releaseRouteAttr(route) {
        if (!route?.attrId) {
            return;
        }

        this.attrStore.release(route.attrId);
        route.attrId = null;
        route._inlineAttr = null;
    }

    getRouteAttr(route) {
        return this.attrStore.get(route?.attrId) || route?.getInlineRouteAttr?.() || { ...DEFAULT_BMP_ROUTE_ATTR };
    }

    getRouteAttrEntry(route) {
        return this.attrStore.getEntry(route?.attrId);
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
        const afKey = `${afi}|${safi}`;
        const ribTypeRouteMap = this.bgpRoutes.get(afKey);
        const targetRibTypes =
            Array.isArray(ribTypes) && ribTypes.length > 0
                ? ribTypes
                : ribTypeRouteMap
                  ? Array.from(ribTypeRouteMap.keys())
                  : [];

        return targetRibTypes.map(ribType => {
            const staleEpoch = this.advanceRibEpoch(afi, safi, ribType);
            const routeMap = ribTypeRouteMap ? ribTypeRouteMap.get(ribType) : null;
            let changed = 0;
            if (routeMap) {
                routeMap.forEach(route => {
                    const previousState = route.routeState;
                    route.markStale(reason, staleEpoch);
                    if (BmpBgpSession.normalizeRouteState(previousState) !== BmpConst.BMP_ROUTE_STATE.STALE) {
                        this.recordRouteStateChange(afi, safi, ribType, previousState, route.routeState);
                        changed += 1;
                    }
                });
            }
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
        this.bgpRoutes.clear();
        this.attrStore.clear();
        this.routePrefixIndexes.clear();
        this.routeSummaries.clear();
        this.recvAddPathMap.clear();
        this.sendAddPathMap.clear();
        this.addPathReceiveMap.clear();
        this.addPathSendMap.clear();
        this.addPathMap.clear();
        this.ribEpochMap.clear();
    }
}

module.exports = BmpBgpSession;
