const { getAddrFamilyType } = require('../../utils/bgpUtils');
class BgpRoute {
    constructor(bgpInstance) {
        this.bgpInstance = bgpInstance;
        this.ip = null;
        this.mask = null;
        this.asPath = null;
        this.med = 0;
        this.localPref = 100;
        this.communities = [];
        this.nextHop = null;
        this.origin = null;
        this.customAttr = null;
        this.rt = null;

        // MVPN
        this.routeType = null;
        this.rd = null;
        this.originatingRouterIp = null;
        this.sourceIp = null;
        this.groupIp = null;
        this.sourceAs = null;

        // QP
        this.dqpn = null;
    }

    static makeKey(ip, mask) {
        return `${ip}|${mask}`;
    }

    static makeQpKey(dqpn, ip, mask) {
        return `${dqpn}|${ip}|${mask}`;
    }

    static parseKey(key) {
        const [ip, mask] = key.split('|');
        return { ip, mask };
    }

    getRouteInfo() {
        const addressFamily = getAddrFamilyType(this.bgpInstance.afi, this.bgpInstance.safi);
        return {
            ip: this.ip,
            mask: this.mask,
            asPath: this.asPath,
            med: this.med,
            localPref: this.localPref,
            communities: this.communities,
            nextHop: this.nextHop,
            origin: this.origin,
            customAttr: this.customAttr,
            rt: this.rt,
            routeType: this.routeType,
            rd: this.rd,
            originatingRouterIp: this.originatingRouterIp,
            sourceIp: this.sourceIp,
            groupIp: this.groupIp,
            sourceAs: this.sourceAs,
            dqpn: this.dqpn,
            addressFamily: addressFamily
        };
    }
}

module.exports = BgpRoute;
