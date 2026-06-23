const BgpPeer = require('./bgpPeer');
const { BgpPathAttrStore } = require('./bgpPathAttrStore');
const { getAddrFamilyType } = require('../../utils/bgpUtils');

const ROUTE_ATTR_FIELDS = [
    'nextHop',
    'origin',
    'asPath',
    'med',
    'localPref',
    'communities',
    'customAttr',
    'rt',
    'srv6Sid',
    'srv6EndpointBehavior'
];
const ROUTE_NLRI_FIELDS = [
    'ip',
    'mask',
    'routeType',
    'rd',
    'originatingRouterIp',
    'sourceIp',
    'groupIp',
    'sourceAs',
    'dqpn',
    'label',
    'pathId'
];

class BgpInstance {
    constructor(vrfIndex, afi, safi) {
        this.vrfIndex = vrfIndex;
        this.afi = afi;
        this.safi = safi;

        this.peerMap = new Map();
        this.routeMap = new Map();
        this.attrStore = new BgpPathAttrStore();
        this.attrRouteIndex = new Map();
        // 自定义属性,
        this.customAttr = '';
        // 扩展团体属性
        this.rt = '';
    }

    static makeKey(vrfIndex, afi, safi) {
        return `${vrfIndex}|${afi}|${safi}`;
    }

    static parseKey(key) {
        const [vrfIndex, afi, safi] = key.split('|');
        return { vrfIndex: parseInt(vrfIndex), afi: parseInt(afi), safi: parseInt(safi) };
    }

    addPeer(bgpSession) {
        const addressFamily = getAddrFamilyType(this.afi, this.safi);
        const bgpPeer = new BgpPeer(bgpSession, this, bgpSession.getAddressFamilyOptions(addressFamily));
        this.peerMap.set(bgpSession.peerIp, bgpPeer);
    }

    copyRouteNlriFields(route, source = {}) {
        for (const field of ROUTE_NLRI_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(source, field)) {
                route[field] = source[field];
            }
        }
    }

    extractRouteAttr(source = {}) {
        const attr = {};
        for (const field of ROUTE_ATTR_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(source, field)) {
                attr[field] = source[field];
            }
        }

        if (source.formatted !== undefined) {
            attr.customAttr = source.formatted;
        }

        return attr;
    }

    makeRouteAttr(route, overrides = {}) {
        const currentAttr = route?.attrId ? this.attrStore.get(route.attrId) || {} : {};
        return {
            nextHop: overrides.nextHop !== undefined ? overrides.nextHop : currentAttr.nextHop,
            origin: overrides.origin !== undefined ? overrides.origin : currentAttr.origin,
            asPath: overrides.asPath !== undefined ? overrides.asPath : currentAttr.asPath,
            med: overrides.med !== undefined ? overrides.med : currentAttr.med,
            localPref: overrides.localPref !== undefined ? overrides.localPref : currentAttr.localPref,
            communities: overrides.communities !== undefined ? overrides.communities : currentAttr.communities,
            customAttr:
                overrides.customAttr !== undefined
                    ? overrides.customAttr
                    : currentAttr.customAttr !== undefined && currentAttr.customAttr !== null
                      ? currentAttr.customAttr
                      : this.customAttr,
            rt:
                overrides.rt !== undefined
                    ? overrides.rt
                    : currentAttr.rt !== undefined && currentAttr.rt !== null
                      ? currentAttr.rt
                      : this.rt,
            srv6Sid: overrides.srv6Sid !== undefined ? overrides.srv6Sid : currentAttr.srv6Sid,
            srv6EndpointBehavior:
                overrides.srv6EndpointBehavior !== undefined
                    ? overrides.srv6EndpointBehavior
                    : currentAttr.srv6EndpointBehavior
        };
    }

    setRoute(routeKey, route, attr = null) {
        const existingRoute = this.routeMap.get(routeKey);
        if (existingRoute) {
            this.removeRouteFromAttrIndex(routeKey, existingRoute);
        }

        this.routeMap.set(routeKey, route);
        this.assignRouteAttr(routeKey, this.makeRouteAttr(route, attr || {}));
    }

    deleteRoute(routeKey) {
        const route = this.routeMap.get(routeKey);
        if (!route) {
            return null;
        }

        this.removeRouteFromAttrIndex(routeKey, route);
        this.routeMap.delete(routeKey);
        return route;
    }

    clearRoutes() {
        this.routeMap.clear();
        this.attrRouteIndex.clear();
        this.attrStore.clear();
    }

    assignRouteAttr(routeKey, attr) {
        const route = this.routeMap.get(routeKey);
        if (!route) {
            return null;
        }

        const nextAttrId = this.attrStore.intern(attr);
        const prevAttrId = route.attrId;

        if (prevAttrId === nextAttrId) {
            this.attrStore.release(nextAttrId);
            return nextAttrId;
        }

        if (prevAttrId) {
            this.removeRouteFromAttrIndex(routeKey, route);
        }

        route.attrId = nextAttrId;
        if (!this.attrRouteIndex.has(nextAttrId)) {
            this.attrRouteIndex.set(nextAttrId, new Set());
        }
        this.attrRouteIndex.get(nextAttrId).add(routeKey);

        return nextAttrId;
    }

    removeRouteFromAttrIndex(routeKey, route) {
        const attrId = route.attrId;
        if (!attrId) {
            return;
        }

        const routeKeys = this.attrRouteIndex.get(attrId);
        if (routeKeys) {
            routeKeys.delete(routeKey);
            if (routeKeys.size === 0) {
                this.attrRouteIndex.delete(attrId);
            }
        }

        this.attrStore.release(attrId);
        route.attrId = null;
    }

    refreshRouteAttrs(filter = null, overrides = {}) {
        this.routeMap.forEach((route, routeKey) => {
            if (typeof filter === 'function' && !filter(route, routeKey)) {
                return;
            }
            this.assignRouteAttr(routeKey, this.makeRouteAttr(route, overrides));
        });
    }

    getRouteAttr(route) {
        return this.attrStore.get(route.attrId) || this.makeRouteAttr(route);
    }

    getRouteAttrEntry(route) {
        return this.attrStore.getEntry(route.attrId);
    }

    getRoutesByAttrGroups() {
        const groups = [];
        this.attrRouteIndex.forEach((routeKeys, attrId) => {
            const routes = [];
            routeKeys.forEach(routeKey => {
                const route = this.routeMap.get(routeKey);
                if (route) {
                    routes.push(route);
                }
            });

            if (routes.length > 0) {
                groups.push({
                    attrId,
                    attr: this.attrStore.get(attrId),
                    routes
                });
            }
        });
        return groups;
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
