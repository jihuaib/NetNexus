const { getAddrFamilyType } = require('../../utils/bgpUtils');
const { toSerializableTlvs } = require('../../utils/bmpUtils');
const { getRoutePrefixIndexKeys } = require('../../utils/routePrefixUtils');
const BmpConst = require('../../const/bmpConst');

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
        this.routePrefixIndex = new Map();
        this.routeSummary = { active: 0, stale: 0, total: 0 };
        this.ribEpoch = 0;
    }

    isAddPathReceiveEnabled(afi, safi, direction = 'receive') {
        const key = `${afi}|${safi}`;
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
