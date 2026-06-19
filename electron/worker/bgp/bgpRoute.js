const BgpConst = require('../../const/bgpConst');
const { getAddrFamilyType } = require('../../utils/bgpUtils');

class BgpRoute {
    constructor(bgpInstance) {
        this.bgpInstance = bgpInstance;
        this.attrId = null;
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

    getRouteInfo(routeAttr = {}) {
        const addressFamily = getAddrFamilyType(this.bgpInstance.afi, this.bgpInstance.safi);
        const routeInfo = {
            asPath: routeAttr.asPath || '',
            med: routeAttr.med ?? 0,
            localPref: routeAttr.localPref ?? 100,
            communities: routeAttr.communities || [],
            nextHop: routeAttr.nextHop || '',
            origin: routeAttr.origin ?? null,
            customAttr: routeAttr.customAttr || '',
            rt: routeAttr.rt || '',
            addressFamily: addressFamily
        };

        if (this.bgpInstance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST) {
            routeInfo.ip = this.ip;
            routeInfo.mask = this.mask;
            if (routeAttr.srv6Sid) {
                routeInfo.srv6Sid = routeAttr.srv6Sid;
                routeInfo.srv6EndpointBehavior = routeAttr.srv6EndpointBehavior ?? null;
            }
        }

        if (this.bgpInstance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST) {
            routeInfo.ip = this.ip;
            routeInfo.mask = this.mask;
            routeInfo.label = this.label;
        }

        if (this.bgpInstance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN) {
            routeInfo.routeType = this.routeType;
            routeInfo.rd = this.rd;
            routeInfo.originatingRouterIp = this.originatingRouterIp;
            routeInfo.sourceIp = this.sourceIp;
            routeInfo.groupIp = this.groupIp;
            routeInfo.sourceAs = this.sourceAs;
        }

        if (this.bgpInstance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
            routeInfo.ip = this.ip;
            routeInfo.mask = this.mask;
            routeInfo.dqpn = this.dqpn;
        }

        return routeInfo;
    }
}

module.exports = BgpRoute;
