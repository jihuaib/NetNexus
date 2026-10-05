const ipaddr = require('ipaddr.js');
const BgpConst = require('../../const/bgpConst');
const { getAddrFamilyType } = require('../../utils/bgp/bgpUtils');
const { ATTRIBUTE_DEFAULTS, attributeRegistry } = require('../../utils/bgp/bgpAttributeRegistry');

const DEFAULT_PUBLIC_RD = '0:0';
const DEFAULT_PATH_ID = 0;
const MAX_PATH_ID = 0xffffffff;

class BgpRoute {
    constructor(bgpInstance) {
        this.bgpInstance = bgpInstance;
        this.attrId = null;
    }

    static normalizeRd(rd) {
        if (rd === undefined || rd === null || rd === '') {
            return DEFAULT_PUBLIC_RD;
        }
        return `${rd}`;
    }

    static normalizePathId(pathId) {
        if (pathId === undefined || pathId === null || pathId === '') {
            return DEFAULT_PATH_ID;
        }

        const numericPathId = Number(pathId);
        if (!Number.isInteger(numericPathId) || numericPathId < 0 || numericPathId > MAX_PATH_ID) {
            return DEFAULT_PATH_ID;
        }
        return numericPathId;
    }

    static normalizeNlriEncoding(value) {
        const encoding = value ?? attributeRegistry.route.defaults.nlriEncoding;
        if (!['auto', 'mpReach'].includes(encoding)) throw new Error('IPv4 NLRI编码仅支持auto或mpReach');
        return encoding;
    }

    static normalizeMpNextHop(value) {
        if (value === null) return null;
        if (value === undefined || value === '') return '';
        try {
            return ipaddr.parse(String(value)).toString();
        } catch (_error) {
            throw new Error('MP Next Hop请输入有效的IPv4或IPv6地址');
        }
    }

    static makeKey(ip, mask) {
        return `${ip}|${mask}`;
    }

    static makeUnicastKey(pathId, rd, ip, mask) {
        return `${BgpRoute.normalizeRd(rd)}|${BgpRoute.normalizePathId(pathId)}|${ip}|${mask}`;
    }

    static makeLabelUnicastKey(pathId, ip, mask) {
        const id = BgpRoute.normalizePathId(pathId);
        return id === 0 ? BgpRoute.makeKey(ip, mask) : `${id}|${ip}|${mask}`;
    }

    static makeUnicastPrefixKey(rd, ip, mask) {
        return `${BgpRoute.normalizeRd(rd)}|${ip}|${mask}`;
    }

    static makeQpKey(dqpn, ip, mask) {
        return `${dqpn}|${ip}|${mask}`;
    }

    static makeMvpnKey(route) {
        const routeType = Number(route.routeType);
        const canonicalIp = value => (value ? ipaddr.parse(String(value)).toString() : '');
        if (routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.LEAF_AD && route.leafRouteKey) {
            const leafRouteKey = String(route.leafRouteKey).replace(/\s+/g, '').toLowerCase();
            if (!/^(?:[0-9a-f]{2})+$/.test(leafRouteKey)) throw new Error('MVPN Leaf route key must be hexadecimal');
            return `${routeType}|leaf:${leafRouteKey}|${canonicalIp(route.originatingRouterIp)}`;
        }
        const [administrator, assigned] = BgpRoute.normalizeRd(route.rd).split(':');
        const rd = `${administrator?.includes('.') ? canonicalIp(administrator) : Number(administrator)}:${Number(assigned)}`;
        const sourceAs = [2, 6, 7].includes(routeType) ? Number(route.sourceAs ?? 0) : '';
        const sourceIp = [3, 5, 6, 7].includes(routeType) ? canonicalIp(route.sourceIp) : '';
        const groupIp = [3, 5, 6, 7].includes(routeType) ? canonicalIp(route.groupIp) : '';
        const originatingRouterIp = [1, 3, 4].includes(routeType) ? canonicalIp(route.originatingRouterIp) : '';
        return [routeType, rd, sourceAs, sourceIp, groupIp, originatingRouterIp].join('|');
    }

    static parseMvpnLeafRouteKey(key) {
        const match = /^4\|leaf:((?:[0-9a-f]{2})+)\|/.exec(String(key));
        return match ? match[1] : null;
    }

    static parseKey(key) {
        const [ip, mask] = key.split('|');
        return { ip, mask };
    }

    getRouteInfo(routeAttr = {}) {
        const addressFamily = getAddrFamilyType(this.bgpInstance.afi, this.bgpInstance.safi);
        const routeInfo = {
            asPath: routeAttr.asPath || '',
            med:
                routeAttr.attributePolicy === 'configured'
                    ? (routeAttr.med ?? null)
                    : (routeAttr.med ?? ATTRIBUTE_DEFAULTS.med.value),
            localPref:
                routeAttr.attributePolicy === 'configured'
                    ? (routeAttr.localPref ?? null)
                    : (routeAttr.localPref ?? ATTRIBUTE_DEFAULTS.localPref.value),
            communities: routeAttr.communities || [],
            nextHop: routeAttr.nextHop || '',
            origin: routeAttr.origin ?? null,
            customAttr: routeAttr.customAttr || '',
            rt: routeAttr.rt || '',
            addressFamily: addressFamily
        };
        if (Object.prototype.hasOwnProperty.call(routeAttr, 'extendedCommunities')) {
            routeInfo.extendedCommunities = routeAttr.extendedCommunities || [];
        }
        if (this.nlriEncoding !== undefined) routeInfo.nlriEncoding = this.nlriEncoding;
        if (this.mpNextHop !== undefined) routeInfo.mpNextHop = this.mpNextHop;
        if (routeAttr.attributePolicy === 'configured') routeInfo.pathAttributes = routeAttr.pathAttributes || [];

        if (this.bgpInstance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST) {
            routeInfo.ip = this.ip;
            routeInfo.mask = this.mask;
            routeInfo.rd = BgpRoute.normalizeRd(this.rd);
            routeInfo.pathId = BgpRoute.normalizePathId(this.pathId);
            if (routeAttr.srv6Sid) {
                routeInfo.srv6Sid = routeAttr.srv6Sid;
                routeInfo.srv6EndpointBehavior = routeAttr.srv6EndpointBehavior ?? null;
                if (routeAttr.srv6SidStructure) routeInfo.srv6SidStructure = { ...routeAttr.srv6SidStructure };
            }
        }

        if (this.bgpInstance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST) {
            routeInfo.ip = this.ip;
            routeInfo.mask = this.mask;
            routeInfo.label = this.label;
            routeInfo.pathId = BgpRoute.normalizePathId(this.pathId);
        }

        if (this.bgpInstance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN) {
            routeInfo.routeType = this.routeType;
            routeInfo.rd = this.rd;
            routeInfo.originatingRouterIp = this.originatingRouterIp;
            routeInfo.sourceIp = this.sourceIp;
            routeInfo.groupIp = this.groupIp;
            routeInfo.sourceAs = this.sourceAs;
            if (this.leafRouteKey !== undefined) routeInfo.leafRouteKey = this.leafRouteKey;
        }

        if (this.bgpInstance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_VPN) {
            Object.assign(routeInfo, { ip: this.ip, mask: this.mask, rd: this.rd, label: this.label });
        }
        if (this.bgpInstance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_EVPN) {
            if (routeAttr.srv6Services)
                routeInfo.srv6Services = routeAttr.srv6Services.map(service => ({
                    ...service,
                    sidStructure: { ...service.sidStructure }
                }));
            for (const field of [
                'routeType',
                'rd',
                'esi',
                'ethernetTagId',
                'macAddress',
                'ipAddress',
                'originatingRouterIp',
                'ip',
                'mask',
                'gatewayIp',
                'encapsulationType',
                'esImportRt',
                'label',
                'label2',
                'vni',
                'vni2'
            ]) {
                if (this[field] !== undefined) routeInfo[field] = this[field];
            }
        }

        if (this.bgpInstance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
            routeInfo.ip = this.ip;
            routeInfo.mask = this.mask;
            routeInfo.dqpn = this.dqpn;
        }

        return routeInfo;
    }
}

BgpRoute.DEFAULT_PUBLIC_RD = DEFAULT_PUBLIC_RD;
BgpRoute.DEFAULT_PATH_ID = DEFAULT_PATH_ID;
BgpRoute.MAX_PATH_ID = MAX_PATH_ID;

module.exports = BgpRoute;
