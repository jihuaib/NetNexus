const { getAddrFamilyType } = require('../utils/bgpUtils');
const { getBgpPacketSummary } = require('../utils/bgpPacketParser');
const BmpConst = require('../const/bmpConst');

class BmpBgpRoute {
    constructor(BmpBgpSession, BmpBgpInstance) {
        this.BmpBgpSession = BmpBgpSession;
        this.BmpBgpInstance = BmpBgpInstance;

        // key
        this.pathId = null;
        this.rd = null;
        this.ip = null;
        this.mask = null;
        this.afi = null;
        this.safi = null;

        // attributes
        this.origin = null;
        this.asPath = null;
        this.med = 0;
        this.localPref = 0;
        this.communities = null;
        this.otc = null;
        this.nextHop = null;
        this.labels = null;
        this.routeType = null;
        this.rawNlri = null;
        this.nlriDetail = null;
        this.parserValid = true;
        this.parseErrors = null;
        this.parseWarnings = null;

        // bgp packet
        this.bgpPacket = [];

        this.routeState = BmpConst.BMP_ROUTE_STATE.ACTIVE;
        this.ribEpoch = 0;
        this.staleEpoch = null;
        this.lastSeenAt = null;
        this.staleAt = null;
        this.staleReason = null;
    }

    static makeKey(pathId, rd, ip, mask) {
        return `${pathId}|${rd}|${ip}|${mask}`;
    }

    static parseKey(key) {
        const [pathId, rd, ip, mask] = key.split('|');
        return { pathId, rd, ip, mask };
    }

    getRouteKey() {
        return BmpBgpRoute.makeKey(this.pathId, this.rd, this.ip, this.mask);
    }

    getAddrFamilyType() {
        if (this.afi && this.safi) {
            return getAddrFamilyType(this.afi, this.safi);
        } else if (this.BmpBgpSession) {
            return getAddrFamilyType(this.BmpBgpSession.afi, this.BmpBgpSession.safi);
        } else if (this.BmpBgpInstance) {
            return getAddrFamilyType(this.BmpBgpInstance.afi, this.BmpBgpInstance.safi);
        }
        return null;
    }

    getPacketSummary() {
        if (this.bgpPacket && !Array.isArray(this.bgpPacket)) {
            return getBgpPacketSummary(this.bgpPacket);
        }
        return null;
    }

    getRouteListInfo() {
        return {
            routeKey: this.getRouteKey(),
            addrFamilyType: this.getAddrFamilyType(),
            afi: this.afi,
            safi: this.safi,
            ip: this.ip,
            mask: this.mask,
            rd: this.rd,
            origin: this.origin,
            asPath: this.asPath,
            med: this.med,
            nextHop: this.nextHop,
            pathId: this.pathId,
            labels: this.labels,
            parserValid: this.parserValid,
            parseErrors: this.parseErrors,
            parseWarnings: this.parseWarnings,
            routeState: this.routeState
        };
    }

    getRouteInfo(options = {}) {
        const { includeSummary = true } = options;
        const routeInfo = {
            routeKey: this.getRouteKey(),
            addrFamilyType: this.getAddrFamilyType(),
            afi: this.afi,
            safi: this.safi,
            ip: this.ip,
            mask: this.mask,
            rd: this.rd,
            origin: this.origin,
            asPath: this.asPath,
            med: this.med,
            nextHop: this.nextHop,
            localPref: this.localPref,
            communities: this.communities,
            otc: this.otc,
            pathId: this.pathId,
            labels: this.labels,
            routeType: this.routeType,
            rawNlri: this.rawNlri,
            nlriDetail: this.nlriDetail,
            parserValid: this.parserValid,
            parseErrors: this.parseErrors,
            parseWarnings: this.parseWarnings,
            routeState: this.routeState,
            ribEpoch: this.ribEpoch,
            staleEpoch: this.staleEpoch,
            lastSeenAt: this.lastSeenAt,
            staleAt: this.staleAt,
            staleReason: this.staleReason
        };
        if (includeSummary) {
            routeInfo.summary = this.getPacketSummary();
        }
        return routeInfo;
    }

    markActive(ribEpoch = 0) {
        this.routeState = BmpConst.BMP_ROUTE_STATE.ACTIVE;
        this.ribEpoch = ribEpoch;
        this.lastSeenAt = new Date().toISOString();
        this.staleAt = null;
        this.staleReason = null;
        this.staleEpoch = null;
    }

    markStale(reason, staleEpoch = null) {
        this.routeState = BmpConst.BMP_ROUTE_STATE.STALE;
        this.staleReason = reason;
        this.staleEpoch = staleEpoch;
        this.staleAt = new Date().toISOString();
    }

    clearAttributes() {
        this.origin = null;
        this.asPath = null;
        this.med = 0;
        this.nextHop = null;
        this.localPref = 0;
        this.communities = null;
        this.otc = null;
        this.labels = null;
        this.routeType = null;
        this.rawNlri = null;
        this.nlriDetail = null;
        this.parserValid = true;
        this.parseErrors = null;
        this.parseWarnings = null;

        this.bgpPacket = [];
    }
}

module.exports = BmpBgpRoute;
