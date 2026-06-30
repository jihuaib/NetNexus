const { getAddrFamilyType } = require('../../utils/bgpUtils');
const { toSerializableTlvs } = require('../../utils/bmpUtils');
const { getRoutePrefixIndexKeys } = require('../../utils/routePrefixUtils');
const BmpConst = require('../../const/bmpConst');
const BgpConst = require('../../const/bgpConst');
const { BmpRouteAttrStore, DEFAULT_BMP_ROUTE_ATTR } = require('./bmpRouteAttrStore');

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
        this.addPathReceiveMap = new Map();
        this.addPathSendMap = new Map();
        this.isAddPath = false;

        this.bgpRoutes = new Map();
        this.attrStore = new BmpRouteAttrStore();
        this.routePrefixIndex = new Map();
        this.routeSummary = { active: 0, stale: 0, total: 0 };
        this.ribEpoch = 0;
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

    static normalizeRouteState(routeState) {
        return routeState === BmpConst.BMP_ROUTE_STATE.STALE
            ? BmpConst.BMP_ROUTE_STATE.STALE
            : BmpConst.BMP_ROUTE_STATE.ACTIVE;
    }

    getRouteSummary() {
        return { ...this.routeSummary };
    }

    updateSummaryStateCount(routeState, delta) {
        const state = BmpBgpInstance.normalizeRouteState(routeState);
        if (state === BmpConst.BMP_ROUTE_STATE.STALE) {
            this.routeSummary.stale = Math.max(0, this.routeSummary.stale + delta);
        } else {
            this.routeSummary.active = Math.max(0, this.routeSummary.active + delta);
        }
    }

    recordRouteAdd(route) {
        this.routeSummary.total += 1;
        this.updateSummaryStateCount(route.routeState, 1);
    }

    recordRouteDelete(route) {
        this.routeSummary.total = Math.max(0, this.routeSummary.total - 1);
        this.updateSummaryStateCount(route.routeState, -1);
    }

    recordRouteStateChange(previousState, nextState) {
        const previous = BmpBgpInstance.normalizeRouteState(previousState);
        const next = BmpBgpInstance.normalizeRouteState(nextState);
        if (previous === next) {
            return;
        }

        this.updateSummaryStateCount(previous, -1);
        this.updateSummaryStateCount(next, 1);
    }

    addRouteKeyToPrefixIndex(prefixKey, routeKey) {
        const existing = this.routePrefixIndex.get(prefixKey);
        if (!existing) {
            this.routePrefixIndex.set(prefixKey, routeKey);
            return;
        }

        if (existing instanceof Set) {
            existing.add(routeKey);
            return;
        }

        if (existing !== routeKey) {
            this.routePrefixIndex.set(prefixKey, new Set([existing, routeKey]));
        }
    }

    removeRouteKeyFromPrefixIndex(prefixKey, routeKey) {
        const existing = this.routePrefixIndex.get(prefixKey);
        if (!existing) {
            return;
        }

        if (!(existing instanceof Set)) {
            if (existing === routeKey) {
                this.routePrefixIndex.delete(prefixKey);
            }
            return;
        }

        existing.delete(routeKey);
        if (existing.size === 0) {
            this.routePrefixIndex.delete(prefixKey);
            return;
        }

        if (existing.size === 1) {
            this.routePrefixIndex.set(prefixKey, existing.values().next().value);
        }
    }

    addRouteToPrefixIndex(routeKey, route) {
        getRoutePrefixIndexKeys(route).forEach(prefixKey => {
            this.addRouteKeyToPrefixIndex(prefixKey, routeKey);
        });
    }

    removeRouteFromPrefixIndex(routeKey, route) {
        getRoutePrefixIndexKeys(route).forEach(prefixKey => {
            this.removeRouteKeyFromPrefixIndex(prefixKey, routeKey);
        });
    }

    getRouteKeysByPrefix(prefixKey) {
        const routeKeys = this.routePrefixIndex.get(prefixKey);
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

    getRibEpoch() {
        return this.ribEpoch || 0;
    }

    advanceRibEpoch() {
        this.ribEpoch = this.getRibEpoch() + 1;
        return this.ribEpoch;
    }

    markRoutesStale(reason) {
        const staleEpoch = this.advanceRibEpoch();
        let changed = 0;
        this.bgpRoutes.forEach(route => {
            const previousState = route.routeState;
            route.markStale(reason, staleEpoch);
            if (BmpBgpInstance.normalizeRouteState(previousState) !== BmpConst.BMP_ROUTE_STATE.STALE) {
                this.recordRouteStateChange(previousState, route.routeState);
                changed += 1;
            }
        });
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
            addPathReceiveMap: Object.fromEntries(this.addPathReceiveMap),
            addPathSendMap: Object.fromEntries(this.addPathSendMap),
            isAddPath: this.isAddPath,
            peerUpTlvs: toSerializableTlvs(this.peerUpTlvs),
            lastRouteMonitoringTlvs: toSerializableTlvs(this.lastRouteMonitoringTlvs),
            vrfTableNames: this.vrfTableNames,
            ribEpoch: this.ribEpoch,
            routeSummary: this.getRouteSummary()
        };
    }

    closeInstance() {
        this.bgpRoutes.clear();
        this.attrStore.clear();
        this.routePrefixIndex.clear();
        this.routeSummary = { active: 0, stale: 0, total: 0 };
        this.recvAddPathMap.clear();
        this.sendAddPathMap.clear();
        this.addPathReceiveMap.clear();
        this.addPathSendMap.clear();
        this.isAddPath = false;
        this.ribEpoch = 0;
    }
}

module.exports = BmpBgpInstance;
