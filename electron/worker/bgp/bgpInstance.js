const BgpPeer = require('./bgpPeer');
const BgpRoute = require('./bgpRoute');
const BgpRouteSqliteStore = require('./bgpRouteSqliteStore');
const { canonicalizeAttr } = require('./bgpPathAttrStore');
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
    constructor(vrfIndex, afi, safi, routeStore = null) {
        this.vrfIndex = vrfIndex;
        this.afi = afi;
        this.safi = safi;
        this.instanceKey = BgpInstance.makeKey(vrfIndex, afi, safi);

        this.peerMap = new Map();
        this.routeStore = routeStore || new BgpRouteSqliteStore();
        this.ownsRouteStore = !routeStore;
        this.routeStore.open();
        this.routeMap = this.routeStore.createRouteMap(this.instanceKey, {
            serialize: this.serializeRoute.bind(this),
            hydrate: this.hydrateRoute.bind(this)
        });

        this.customAttr = '';
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

    serializeRoute(route) {
        const serialized = {};
        this.copyRouteNlriFields(serialized, route);
        return {
            route: serialized,
            attr: this.getRouteAttr(route)
        };
    }

    hydrateRoute(storedRoute) {
        if (!storedRoute) return null;
        const route = new BgpRoute(this);
        this.copyRouteNlriFields(route, storedRoute);
        route.routeKey = storedRoute.routeKey;
        route.persistentRouteId = storedRoute.persistentRouteId;
        route.attrId = storedRoute.attrId || null;
        route._routeAttr = canonicalizeAttr(storedRoute.routeAttr || this.extractRouteAttr(storedRoute));
        return route;
    }

    makeRouteAttr(route, overrides = {}) {
        const currentAttr = route ? this.getRouteAttr(route) : {};
        return canonicalizeAttr({
            ...currentAttr,
            ...overrides,
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
                      : this.rt
        });
    }

    setRoute(routeKey, route, attr = null) {
        route._routeAttr = canonicalizeAttr(attr || this.makeRouteAttr(route));
        this.routeMap.setWithAttr(routeKey, route, route._routeAttr);
        const stored = this.routeMap.get(routeKey);
        if (stored) {
            route.attrId = stored.attrId;
            route.persistentRouteId = stored.persistentRouteId;
        }
        return route;
    }

    upsertRouteBatch(entries) {
        const serialized = (entries || []).map(entry => {
            const routeKey = entry.routeKey || entry.key;
            const route = entry.route || entry.value;
            const attr = canonicalizeAttr(entry.attr || this.makeRouteAttr(route));
            route._routeAttr = attr;
            return { routeKey, ...this.serializeRoute(route), attr };
        });
        return this.routeMap.upsertMany(serialized);
    }

    deleteRoute(routeKey) {
        const route = this.routeMap.get(routeKey);
        if (!route) return null;
        this.routeMap.delete(routeKey);
        return route;
    }

    deleteRouteBatch(routeKeys) {
        return this.routeMap.deleteMany(routeKeys);
    }

    clearRoutes() {
        return this.routeStore.clearInstance(this.instanceKey);
    }

    assignRouteAttr(routeKey, attr) {
        const canonical = canonicalizeAttr(attr);
        if (!this.routeMap.setRouteAttr(routeKey, canonical)) {
            return null;
        }
        const route = this.routeMap.get(routeKey);
        return route?.attrId || null;
    }

    removeRouteFromAttrIndex() {
        // Attributes and reference counts are maintained transactionally by SQLite.
    }

    refreshRouteAttrs(filter = null, overrides = {}) {
        let updated = 0;
        let cursor = null;
        do {
            const page = this.routeMap.queryPage({
                pageSize: 2000,
                afterRouteId: cursor,
                includeTotal: false
            });
            const entries = [];
            for (const route of page.list) {
                const routeKey = route.routeKey;
                if (typeof filter === 'function' && !filter(route, routeKey)) continue;
                entries.push({ routeKey, route, attr: this.makeRouteAttr(route, overrides) });
            }
            if (entries.length > 0) {
                updated += this.upsertRouteBatch(entries).updated;
            }
            cursor = page.nextCursor;
        } while (cursor !== null);
        return updated;
    }

    getRouteAttr(route) {
        if (route?._routeAttr) return route._routeAttr;
        return canonicalizeAttr(this.extractRouteAttr(route || {}));
    }

    getRouteAttrEntry(route) {
        if (!route?.attrId) return null;
        return {
            id: route.attrId,
            attr: this.getRouteAttr(route),
            refCount: this.routeStore.getAttributeRefCount(this.instanceKey, route.attrId)
        };
    }

    getAttributeGroupCount() {
        return this.routeStore.getInstanceAttributeCount(this.instanceKey);
    }

    getRoutesByAttrGroups() {
        return Array.from(this.routeMap.iterateAttrGroups({ batchSize: 10000 })).map(group => ({
            attrId: group.attrId,
            attr: group.attr,
            routes: group.routes
        }));
    }

    queryRoutePage(options = {}) {
        const result = this.routeMap.queryPage(options);
        return {
            ...result,
            list: result.list.map(route => route.getRouteInfo(this.getRouteAttr(route)))
        };
    }

    changePeerState(peerIp, sessionState) {
        const peer = this.peerMap.get(peerIp);
        if (peer) peer.changePeerState(sessionState);
    }

    resetPeer(peerIp) {
        const peer = this.peerMap.get(peerIp);
        if (peer) peer.resetPeer();
    }

    sendRoute() {
        this.peerMap.forEach(peer => peer.sendRoute());
    }

    sendRouteBatch(routes) {
        if (!routes || routes.length === 0) return;
        this.peerMap.forEach(peer => peer.sendRouteBatch(routes));
    }

    createRouteBatchStream() {
        const peerStreams = [];
        this.peerMap.forEach(peer => {
            if (typeof peer.createRouteBatchStream === 'function') {
                peerStreams.push(peer.createRouteBatchStream());
            }
        });
        let ended = false;
        return {
            write(routes) {
                if (ended || !routes || routes.length === 0) return;
                peerStreams.forEach(stream => stream.write(routes));
            },
            end() {
                if (ended) return;
                ended = true;
                peerStreams.forEach(stream => stream.end());
            }
        };
    }

    withdrawRoute(withdrawnRoutes) {
        const pending = [];
        this.peerMap.forEach(peer => {
            const result = peer.withdrawRoute(withdrawnRoutes);
            if (result && typeof result.then === 'function') pending.push(result);
        });
        return pending.length > 0 ? Promise.all(pending) : null;
    }

    close() {
        if (this.ownsRouteStore) this.routeStore.close();
    }
}

module.exports = BgpInstance;
