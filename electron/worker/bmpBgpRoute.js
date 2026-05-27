const { getAddrFamilyType } = require('../utils/bgpUtils');

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
    }

    static makeKey(pathId, rd, ip, mask) {
        return `${pathId}|${rd}|${ip}|${mask}`;
    }

    static parseKey(key) {
        const [pathId, rd, ip, mask] = key.split('|');
        return { pathId, rd, ip, mask };
    }

    getRouteInfo() {
        let addrFamilyType = null;
        if (this.afi && this.safi) {
            addrFamilyType = getAddrFamilyType(this.afi, this.safi);
        } else if (this.BmpBgpSession) {
            addrFamilyType = getAddrFamilyType(this.BmpBgpSession.afi, this.BmpBgpSession.safi);
        } else if (this.BmpBgpInstance) {
            addrFamilyType = getAddrFamilyType(this.BmpBgpInstance.afi, this.BmpBgpInstance.safi);
        }
        return {
            addrFamilyType: addrFamilyType,
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
            parseWarnings: this.parseWarnings
        };
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
