const BgpConst = require('../../const/bgpConst');
const {
    writeUInt32,
    ipToBytes,
    writeUInt16,
    getIpType,
    rdStringToBytes,
    extCommunitiesToBytes
} = require('../../utils/ipUtils');
const { getAddrFamilyType } = require('../../utils/bgpUtils');
const logger = require('../../log/logger');
const CommonUtils = require('../../utils/commonUtils');
const { canonicalizeAttr } = require('./bgpPathAttrStore');
const BgpRoute = require('./bgpRoute');

const MAX_PENDING_ROUTE_STREAM_ROUTES = 2000;

function parseRouteAsPath(asPathStr, use4ByteAsn = true) {
    if (!asPathStr || typeof asPathStr !== 'string') return null;
    const asNumbers = asPathStr
        .trim()
        .split(/\s+/)
        .map(asn => parseInt(asn, 10))
        .filter(asn => !isNaN(asn));
    if (asNumbers.length === 0) return null;
    const segments = [0x02, asNumbers.length];
    if (use4ByteAsn) {
        for (const asn of asNumbers) segments.push(...writeUInt32(asn));
    } else {
        for (const asn of asNumbers) segments.push(...writeUInt16(asn));
    }
    return Buffer.from(segments);
}

function parseRouteCommunities(communities) {
    if (!Array.isArray(communities) || communities.length === 0) return null;
    const communityBytes = [];
    for (const comm of communities) {
        if (typeof comm === 'string' && comm.includes(':')) {
            const [asn, value] = comm.split(':').map(x => parseInt(x, 10));
            if (!isNaN(asn) && !isNaN(value)) {
                communityBytes.push(...writeUInt16(asn));
                communityBytes.push(...writeUInt16(value));
            }
        }
    }
    return communityBytes.length === 0 ? null : Buffer.from(communityBytes);
}

function encodeQpDqpn(dqpn) {
    if (!Number.isInteger(dqpn) || dqpn < 0 || dqpn > 0xffffff) {
        throw new Error(`DQPN ${dqpn} exceeds supported 24-bit range`);
    }

    if (dqpn <= 0xff) {
        return {
            bitLength: 8,
            bytes: [dqpn]
        };
    }

    if (dqpn <= 0xffff) {
        return {
            bitLength: 16,
            bytes: [(dqpn >> 8) & 0xff, dqpn & 0xff]
        };
    }

    return {
        bitLength: 24,
        bytes: [(dqpn >> 16) & 0xff, (dqpn >> 8) & 0xff, dqpn & 0xff]
    };
}

function normalizeMplsLabel(label) {
    const value = Number(label);
    if (!Number.isInteger(value) || value < 0 || value > BgpConst.BGP_MPLS_LABEL_MAX) {
        throw new Error(`MPLS label ${label} exceeds supported 20-bit range`);
    }

    return value;
}

function encodeMplsLabel(label, bottom = true) {
    const value = (normalizeMplsLabel(label) << 4) | (bottom ? 1 : 0);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

class BgpPeer {
    constructor(session, instance, addressFamilyOptions = {}) {
        this.peerState = BgpConst.BGP_PEER_STATE.IDLE;
        this.session = session;
        this.instance = instance;
        this.addressFamilyOptions = {
            sendSrv6PrefixSid: addressFamilyOptions.sendSrv6PrefixSid === true
        };
    }

    changePeerState(state) {
        if (state !== BgpConst.BGP_PEER_STATE.IDLE) {
            if (this.peerState === BgpConst.BGP_PEER_STATE.NO_NEG) {
                return;
            }
        }

        logger.info(
            `peer ${this.session.peerIp} fsm state ${BgpConst.BGP_PEER_STATE_NAME[this.peerState]} -> ${BgpConst.BGP_PEER_STATE_NAME[state]}`
        );

        this.peerState = state;
        if (state === BgpConst.BGP_PEER_STATE.ESTABLISHED) {
            this.resyncRequested = false;
        }

        const peerInfo = this.getPeerInfo();

        // 发送状态变更事件
        this.session.messageHandler.sendEvent(BgpConst.BGP_EVT_TYPES.BGP_PEER_CHANGE, { data: peerInfo });
    }

    resetPeer() {
        logger.info(
            `peer ${this.session.peerIp} fsm state ${BgpConst.BGP_PEER_STATE_NAME[this.peerState]} -> ${BgpConst.BGP_PEER_STATE_NAME[BgpConst.BGP_PEER_STATE.IDLE]}`
        );

        this.peerState = BgpConst.BGP_PEER_STATE.IDLE;

        const peerInfo = this.getPeerInfo();

        // 发送状态变更事件
        this.session.messageHandler.sendEvent(BgpConst.BGP_EVT_TYPES.BGP_PEER_CHANGE, { data: peerInfo });
    }

    getAddPathNegotiationInfo() {
        if (!this.isIpUnicastFamily()) {
            return {
                addPathSendEnabled: false,
                addPathReceiveEnabled: false
            };
        }

        const addPathSendEnabled =
            typeof this.session.isAddPathSendEnabled === 'function' &&
            this.session.isAddPathSendEnabled(this.instance.afi, this.instance.safi);
        const addPathReceiveEnabled =
            typeof this.session.isAddPathReceiveEnabled === 'function' &&
            this.session.isAddPathReceiveEnabled(this.instance.afi, this.instance.safi);

        return {
            addPathSendEnabled,
            addPathReceiveEnabled
        };
    }

    getPeerInfo() {
        const addressFamily = getAddrFamilyType(this.instance.afi, this.instance.safi);
        const addPathInfo = this.getAddPathNegotiationInfo();
        return {
            vrfIndex: this.instance.vrfIndex,
            localIp: this.session.localIp,
            localAs: this.session.localAs,
            peerIp: this.session.peerIp,
            peerAs: this.session.peerAs,
            routerId: this.session.routerId,
            peerState: BgpConst.BGP_PEER_STATE_NAME[this.peerState],
            addressFamily: addressFamily,
            peerType: this.session.peerType,
            sendSrv6PrefixSid: this.addressFamilyOptions.sendSrv6PrefixSid,
            ...addPathInfo
        };
    }

    getQpNextHop(route) {
        const routeAttr = this.getRouteAttr(route);
        return `${routeAttr.nextHop || this.session.localIp}`;
    }

    getRouteAttr(route) {
        return this.instance.getRouteAttr(route) || {};
    }

    isIpUnicastFamily() {
        return (
            (this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 ||
                this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        );
    }

    shouldSendAddPath() {
        return (
            this.isIpUnicastFamily() &&
            typeof this.session.isAddPathSendEnabled === 'function' &&
            this.session.isAddPathSendEnabled(this.instance.afi, this.instance.safi)
        );
    }

    getRoutePathId(route) {
        return BgpRoute.normalizePathId(route?.pathId);
    }

    getRouteUnicastPrefixKey(route) {
        return BgpRoute.makeUnicastPrefixKey(route?.rd, route?.ip, route?.mask);
    }

    buildIpPrefixNlri(route, includePathId = false) {
        const prefixBytes = ipToBytes(route.ip);
        const prefixLength = Math.ceil(route.mask / 8);
        const nlri = [];
        if (includePathId) {
            nlri.push(...writeUInt32(this.getRoutePathId(route)));
        }
        nlri.push(route.mask);
        nlri.push(...prefixBytes.slice(0, prefixLength));
        return nlri;
    }

    getOutboundRoutes() {
        const routes = Array.from(this.instance.routeMap.values());
        if (!this.isIpUnicastFamily() || this.shouldSendAddPath()) {
            return routes;
        }

        const selectedRoutes = new Map();
        routes.forEach(route => {
            const prefixKey = this.getRouteUnicastPrefixKey(route);
            const selectedRoute = selectedRoutes.get(prefixKey);
            if (!selectedRoute || this.getRoutePathId(route) < this.getRoutePathId(selectedRoute)) {
                selectedRoutes.set(prefixKey, route);
            }
        });
        return Array.from(selectedRoutes.values());
    }

    getWithdrawnRoutes(routes) {
        if (!this.isIpUnicastFamily() || this.shouldSendAddPath()) {
            return routes;
        }

        const withdrawnRoutes = new Map();
        routes.forEach(route => {
            const prefixKey = this.getRouteUnicastPrefixKey(route);
            const remaining = this.instance.routeMap.queryPrefix(route.ip, {
                prefixLength: route.mask,
                rd: BgpRoute.normalizeRd(route.rd),
                pageSize: 1,
                includeTotal: false
            });
            const hasRemainingRoute = remaining.list.length > 0;
            if (!hasRemainingRoute && !withdrawnRoutes.has(prefixKey)) {
                withdrawnRoutes.set(prefixKey, route);
            }
        });
        return Array.from(withdrawnRoutes.values());
    }

    getOriginValue(origin) {
        if (origin === undefined || origin === null || origin === '') {
            return 0;
        }

        if (typeof origin === 'string') {
            return { IGP: 0, EGP: 1, INCOMPLETE: 2 }[origin] || 0;
        }

        return origin;
    }

    buildAsPathAttribute(routeAttr) {
        if (routeAttr.asPath) {
            const use4ByteAsn = CommonUtils.BIT_TEST(this.session.localCapFlags, BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS);
            const asPathBytes = parseRouteAsPath(routeAttr.asPath, use4ByteAsn);
            if (asPathBytes) {
                let finalAsPathBytes;
                if (this.session.peerType === BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP) {
                    const localAsBytes = use4ByteAsn
                        ? writeUInt32(this.session.localAs)
                        : writeUInt16(this.session.localAs);
                    const existingPath = Array.from(asPathBytes);
                    finalAsPathBytes = Buffer.from([
                        existingPath[0],
                        existingPath[1] + 1,
                        ...localAsBytes,
                        ...existingPath.slice(2)
                    ]);
                } else {
                    finalAsPathBytes = asPathBytes;
                }

                return this.buildPathAttribute(
                    BgpConst.BGP_PATH_ATTR.AS_PATH,
                    BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                    Array.from(finalAsPathBytes)
                );
            }
        }

        if (this.session.peerType === BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP) {
            return this.buildPathAttribute(BgpConst.BGP_PATH_ATTR.AS_PATH, BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE, [
                0x02,
                0x01,
                ...writeUInt32(this.session.localAs)
            ]);
        }

        return this.buildPathAttribute(BgpConst.BGP_PATH_ATTR.AS_PATH, BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE, []);
    }

    buildLocalPrefAttribute(routeAttr) {
        if (this.session.peerType !== BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP) {
            return [];
        }

        return this.buildPathAttribute(
            BgpConst.BGP_PATH_ATTR.LOCAL_PREF,
            BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
            writeUInt32(routeAttr.localPref ?? 100)
        );
    }

    canSendSrv6PrefixSid() {
        return (
            this.addressFamilyOptions.sendSrv6PrefixSid === true &&
            getIpType(this.session.peerIp) === BgpConst.IP_TYPE.IPV6 &&
            (this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 ||
                this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        );
    }

    getDefaultSrv6EndpointBehavior() {
        return this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4
            ? BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT4
            : BgpConst.BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6;
    }

    buildSrv6PrefixSidAttribute(routeAttr) {
        if (!this.canSendSrv6PrefixSid()) {
            return [];
        }

        if (!routeAttr.srv6Sid) {
            return [];
        }

        const sidBytes = ipToBytes(`${routeAttr.srv6Sid}`);
        if (sidBytes.length !== BgpConst.IPV6_HOST_BYTE_LEN) {
            throw new Error(`SRv6 SID must be IPv6 address: ${routeAttr.srv6Sid}`);
        }

        const endpointBehavior = Number.isInteger(Number(routeAttr.srv6EndpointBehavior))
            ? Number(routeAttr.srv6EndpointBehavior)
            : this.getDefaultSrv6EndpointBehavior();
        const sidStructureSubSubTlv = [0x01, ...writeUInt16(6), 48, 16, 16, 0, 0, 0];
        const sidInformationValue = [
            0x00,
            ...sidBytes,
            0x00,
            ...writeUInt16(endpointBehavior),
            0x00,
            ...sidStructureSubSubTlv
        ];
        const sidInformationSubTlv = [0x01, ...writeUInt16(sidInformationValue.length), ...sidInformationValue];
        const serviceTlvValue = [0x00, ...sidInformationSubTlv];
        const serviceTlv = [0x05, ...writeUInt16(serviceTlvValue.length), ...serviceTlvValue];

        return this.buildPathAttribute(
            BgpConst.BGP_PATH_ATTR.PREFIX_SID,
            BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
            serviceTlv
        );
    }

    buildRoutePathAttributes(route, options = {}) {
        const routeAttr = this.getRouteAttr(route);
        const origin = [this.getOriginValue(routeAttr.origin)];
        const med = routeAttr.med ?? 0;
        const pathAttr = [
            ...this.buildPathAttribute(BgpConst.BGP_PATH_ATTR.ORIGIN, BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE, origin),
            ...this.buildAsPathAttribute(routeAttr)
        ];

        if (options.includeIpv4NextHop) {
            const nextHop =
                routeAttr.nextHop && this.session.peerType === BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP
                    ? routeAttr.nextHop
                    : this.session.localIp;
            pathAttr.push(
                ...this.buildPathAttribute(
                    BgpConst.BGP_PATH_ATTR.NEXT_HOP,
                    BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                    ipToBytes(nextHop)
                )
            );
        }

        pathAttr.push(
            ...this.buildPathAttribute(
                BgpConst.BGP_PATH_ATTR.MED,
                BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL,
                writeUInt32(med)
            ),
            ...this.buildLocalPrefAttribute(routeAttr)
        );

        const communityBytes = parseRouteCommunities(routeAttr.communities);
        if (communityBytes) {
            pathAttr.push(
                ...this.buildPathAttribute(
                    BgpConst.BGP_PATH_ATTR.COMMUNITY,
                    BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                    Array.from(communityBytes)
                )
            );
        }

        if (routeAttr.customAttr?.trim()) {
            const customPathAttr = this.session.processCustomPkt(routeAttr.customAttr);
            pathAttr.push(...customPathAttr);
        }

        if (routeAttr.rt?.trim()) {
            const rtList = routeAttr.rt.trim().split(/\s+/);
            const rtBuffers = [];
            for (const rt of rtList) {
                if (rt) {
                    rtBuffers.push(extCommunitiesToBytes(BgpConst.EXT_COMMUNITY_SUB_TYPE.RT, rt));
                }
            }
            const combinedBuffer = Buffer.concat(rtBuffers);

            if (combinedBuffer.length > 0) {
                pathAttr.push(
                    ...this.buildPathAttribute(
                        BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES,
                        BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL |
                            BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH |
                            BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                        combinedBuffer
                    )
                );
            }
        }

        pathAttr.push(...this.buildSrv6PrefixSidAttribute(routeAttr));

        return pathAttr;
    }

    buildPathAttribute(type, flags, value) {
        const attr = [];
        attr.push(flags);
        attr.push(type);
        if (value.length > 255 || flags & BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH) {
            attr.push(...writeUInt16(value.length));
        } else {
            attr.push(value.length);
        }
        attr.push(...value);
        return attr;
    }

    getOutboundRouteAttrGroupKey(route) {
        const attr = canonicalizeAttr(this.getRouteAttr(route));
        if (!this.canSendSrv6PrefixSid()) {
            attr.srv6Sid = '';
            attr.srv6EndpointBehavior = null;
        } else if (!attr.srv6Sid) {
            attr.srv6EndpointBehavior = null;
        } else if (attr.srv6EndpointBehavior === null) {
            attr.srv6EndpointBehavior = this.getDefaultSrv6EndpointBehavior();
        }
        return JSON.stringify(attr);
    }

    getOutboundRouteGroups() {
        const groups = new Map();
        this.getOutboundRoutes().forEach(route => {
            const key = this.getOutboundRouteAttrGroupKey(route);
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key).push(route);
        });
        return Array.from(groups.values());
    }

    getRouteNextHopIp(route) {
        const routeAttr = this.getRouteAttr(route);
        return routeAttr.nextHop && this.session.peerType === BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP
            ? routeAttr.nextHop
            : this.session.localIp;
    }

    getIpv6NlriNextHopBytes(nextHopIp) {
        const nextHopBytes = ipToBytes(`${nextHopIp}`);
        if (nextHopBytes.length === BgpConst.IP_HOST_BYTE_LEN) {
            return ipToBytes(`::ffff:${nextHopIp}`);
        }
        return nextHopBytes;
    }

    getMpReachNextHopBytes(route) {
        if (this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
            return ipToBytes(`${this.getQpNextHop(route)}`);
        }

        if (this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) {
            return this.getIpv6NlriNextHopBytes(this.getRouteNextHopIp(route));
        }

        if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN
        ) {
            return ipToBytes(`${this.session.localIp}`);
        }

        return ipToBytes(`${this.getRouteNextHopIp(route)}`);
    }

    buildMpReachNlriAttribute(routes, routeIndex, msgLen) {
        const attr = [];
        attr.push(BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH);
        attr.push(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI);
        msgLen += 2;

        // 记录长度位置，稍后更新
        const lengthPos = attr.length;
        attr.push(0x00, 0x00); // 占位长度
        msgLen += 2;

        // AFI and SAFI
        attr.push(...writeUInt16(this.instance.afi));
        attr.push(this.instance.safi);
        msgLen += 3;

        // Next Hop
        let route = routes[routeIndex];
        const nextHopBytes = this.getMpReachNextHopBytes(route);
        attr.push(nextHopBytes.length);
        attr.push(...nextHopBytes);
        msgLen += 1 + nextHopBytes.length;

        // Reserved
        attr.push(0x00);
        msgLen += 1;

        // NLRI
        let nlriBuf = [];

        if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN
        ) {
            while (routeIndex < routes.length) {
                const mvpnNlri = this.buildMvpnNlri(route);
                if (msgLen + nlriBuf.length + mvpnNlri.length > BgpConst.BGP_MAX_PKT_SIZE) {
                    if (nlriBuf.length > 0) {
                        break;
                    }
                }
                nlriBuf.push(...mvpnNlri);

                routeIndex++;
                if (routeIndex < routes.length) {
                    route = routes[routeIndex];
                } else {
                    break;
                }
            }
            attr.push(...nlriBuf);
            msgLen += nlriBuf.length;
        } else if (this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
            // QP NLRI: [总长度][DQPN TLV][Prefix TLV]
            const qpNextHop = this.getQpNextHop(route);
            while (routeIndex < routes.length) {
                if (nlriBuf.length > 0 && this.getQpNextHop(route) !== qpNextHop) {
                    break;
                }

                const qpNlri = this.buildQpNlri(route);
                if (msgLen + nlriBuf.length + qpNlri.length > BgpConst.BGP_MAX_PKT_SIZE) {
                    if (nlriBuf.length > 0) {
                        break;
                    }
                }
                nlriBuf.push(...qpNlri);

                routeIndex++;
                if (routeIndex < routes.length) {
                    route = routes[routeIndex];
                } else {
                    break;
                }
            }
            attr.push(...nlriBuf);
            msgLen += nlriBuf.length;
        } else if (this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST) {
            while (routeIndex < routes.length) {
                const labelNlri = this.buildLabeledUnicastNlri(route);
                if (msgLen + nlriBuf.length + labelNlri.length > BgpConst.BGP_MAX_PKT_SIZE) {
                    if (nlriBuf.length > 0) {
                        break;
                    }
                }
                nlriBuf.push(...labelNlri);

                routeIndex++;
                if (routeIndex < routes.length) {
                    route = routes[routeIndex];
                } else {
                    break;
                }
            }
            attr.push(...nlriBuf);
            msgLen += nlriBuf.length;
        } else {
            const includePathId = this.shouldSendAddPath();
            let routeNlri = this.buildIpPrefixNlri(route, includePathId);
            let nlriLen = routeNlri.length;
            while (msgLen + nlriLen <= BgpConst.BGP_MAX_PKT_SIZE && routeIndex < routes.length) {
                attr.push(...routeNlri);

                routeIndex++;
                msgLen += nlriLen;
                if (routeIndex < routes.length) {
                    route = routes[routeIndex];
                    routeNlri = this.buildIpPrefixNlri(route, includePathId);
                    nlriLen = routeNlri.length;
                } else {
                    break;
                }
            }
        }

        // 更新长度
        const length = attr.length - lengthPos - 2;
        const lengthBuf = Buffer.alloc(2);
        lengthBuf.writeUInt16BE(length, 0);
        attr[lengthPos] = lengthBuf[0];
        attr[lengthPos + 1] = lengthBuf[1];

        return { index: routeIndex, attr: attr };
    }

    buildMpUnreachNlriAttribute(routes, msgLen, routeIndex) {
        const attr = [];
        attr.push(BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH);
        attr.push(BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI);
        msgLen += 2;

        // 记录长度位置，稍后更新
        const lengthPos = attr.length;
        attr.push(0x00, 0x00); // 占位长度
        msgLen += 2;

        // AFI and SAFI
        attr.push(...writeUInt16(this.instance.afi));
        attr.push(this.instance.safi);
        msgLen += 3;

        // NLRI
        let route = routes[routeIndex];

        if (this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN) {
            let nlriBuf = [];
            while (routeIndex < routes.length) {
                const mvpnNlri = this.buildMvpnNlri(route);
                if (msgLen + nlriBuf.length + mvpnNlri.length > BgpConst.BGP_MAX_PKT_SIZE) {
                    if (nlriBuf.length > 0) {
                        break;
                    }
                }
                nlriBuf.push(...mvpnNlri);

                routeIndex++;
                if (routeIndex < routes.length) {
                    route = routes[routeIndex];
                } else {
                    break;
                }
            }
            attr.push(...nlriBuf);
            msgLen += nlriBuf.length;
        } else if (this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
            // QP Withdraw NLRI: [总长度][DQPN TLV][Prefix TLV]
            let nlriBuf = [];
            while (routeIndex < routes.length) {
                const qpNlri = this.buildQpNlri(route);
                if (msgLen + nlriBuf.length + qpNlri.length > BgpConst.BGP_MAX_PKT_SIZE) {
                    if (nlriBuf.length > 0) {
                        break;
                    }
                }
                nlriBuf.push(...qpNlri);

                routeIndex++;
                if (routeIndex < routes.length) {
                    route = routes[routeIndex];
                } else {
                    break;
                }
            }
            attr.push(...nlriBuf);
            msgLen += nlriBuf.length;
        } else if (this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST) {
            let nlriBuf = [];
            while (routeIndex < routes.length) {
                const labelNlri = this.buildLabeledUnicastNlri(route);
                if (msgLen + nlriBuf.length + labelNlri.length > BgpConst.BGP_MAX_PKT_SIZE) {
                    if (nlriBuf.length > 0) {
                        break;
                    }
                }
                nlriBuf.push(...labelNlri);

                routeIndex++;
                if (routeIndex < routes.length) {
                    route = routes[routeIndex];
                } else {
                    break;
                }
            }
            attr.push(...nlriBuf);
            msgLen += nlriBuf.length;
        } else {
            const includePathId = this.shouldSendAddPath();
            let routeNlri = this.buildIpPrefixNlri(route, includePathId);
            let nlriLen = routeNlri.length;
            while (msgLen + nlriLen <= BgpConst.BGP_MAX_PKT_SIZE && routeIndex < routes.length) {
                attr.push(...routeNlri);

                routeIndex++;
                msgLen += nlriLen;
                if (routeIndex < routes.length) {
                    route = routes[routeIndex];
                    routeNlri = this.buildIpPrefixNlri(route, includePathId);
                    nlriLen = routeNlri.length;
                } else {
                    break;
                }
            }
        }

        // 更新长度
        const length = attr.length - lengthPos - 2;
        const lengthBuf = Buffer.alloc(2);
        lengthBuf.writeUInt16BE(length, 0);
        attr[lengthPos] = lengthBuf[0];
        attr[lengthPos + 1] = lengthBuf[1];

        return { index: routeIndex, attr: attr };
    }

    buildUpdateMpMsg(routes, routeIndex) {
        try {
            // 构建撤销路由缓冲区
            const withdrawnRoutesBuf = Buffer.alloc(2);
            withdrawnRoutesBuf.writeUInt16BE(0, 0);

            const route = routes[routeIndex];

            const pathAttr = this.buildRoutePathAttributes(route);

            const msgLen = BgpConst.BGP_HEAD_LEN + withdrawnRoutesBuf.length + 2 + pathAttr.length; // 固定长度

            const mpNlriAttrResult = this.buildMpReachNlriAttribute(routes, routeIndex, msgLen);
            pathAttr.push(...mpNlriAttrResult.attr);

            // 构建路径属性缓冲区
            const pathAttrBuf = Buffer.alloc(pathAttr.length + 2);
            pathAttrBuf.writeUInt16BE(pathAttr.length, 0);
            pathAttrBuf.set(pathAttr, 2);

            // 构建消息头
            const bufHeader = this.session.buildBgpMessageHeader(
                BgpConst.BGP_HEAD_LEN + withdrawnRoutesBuf.length + pathAttrBuf.length,
                BgpConst.BGP_PACKET_TYPE.UPDATE
            );

            const buffer = Buffer.concat([bufHeader, withdrawnRoutesBuf, pathAttrBuf]);
            return {
                status: true,
                index: mpNlriAttrResult.index,
                buffer: buffer
            };
        } catch (error) {
            logger.error(`Error building IPv6 UPDATE message: ${error.message}`);
            return {
                status: false,
                index: routeIndex,
                buffer: null
            };
        }
    }

    buildUpdateMsgIpv4(routes, routeIndex) {
        try {
            // 构建撤销路由缓冲区
            const withdrawnRoutesBuf = Buffer.alloc(2);
            withdrawnRoutesBuf.writeUInt16BE(0, 0);

            const route = routes[routeIndex];
            const pathAttr = this.buildRoutePathAttributes(route, { includeIpv4NextHop: true });
            // 构建路径属性缓冲区
            const pathAttrBuf = Buffer.alloc(pathAttr.length + 2);
            pathAttrBuf.writeUInt16BE(pathAttr.length, 0);
            pathAttrBuf.set(pathAttr, 2);

            // 构建NLRI
            const nlri = [];
            let msgLen = BgpConst.BGP_HEAD_LEN + withdrawnRoutesBuf.length + pathAttrBuf.length;

            let curRoute = routes[routeIndex];
            const includePathId = this.shouldSendAddPath();
            let routeNlri = this.buildIpPrefixNlri(curRoute, includePathId);
            let nlriLen = routeNlri.length;
            while (msgLen + nlriLen <= BgpConst.BGP_MAX_PKT_SIZE && routeIndex < routes.length) {
                nlri.push(...routeNlri);

                routeIndex++;
                msgLen += nlriLen;
                if (routeIndex < routes.length) {
                    curRoute = routes[routeIndex];
                    routeNlri = this.buildIpPrefixNlri(curRoute, includePathId);
                    nlriLen = routeNlri.length;
                } else {
                    break;
                }
            }

            const nlriBuf = Buffer.alloc(nlri.length);
            nlriBuf.set(nlri);

            // 构建消息头
            const bufHeader = this.session.buildBgpMessageHeader(
                BgpConst.BGP_HEAD_LEN + withdrawnRoutesBuf.length + pathAttrBuf.length + nlriBuf.length,
                BgpConst.BGP_PACKET_TYPE.UPDATE
            );

            const buffer = Buffer.concat([bufHeader, withdrawnRoutesBuf, pathAttrBuf, nlriBuf]);
            return {
                status: true,
                index: routeIndex,
                buffer: buffer
            };
        } catch (error) {
            logger.error(`Error building IPv4 UPDATE message: ${error.message}`);
            return {
                status: false,
                index: routeIndex,
                buffer: null
            };
        }
    }

    buildWithdrawMsgIpv4(routes, routeIndex) {
        try {
            const pathAttrBuf = Buffer.alloc(2);
            pathAttrBuf.writeUInt16BE(0, 0);

            const withdrawNlri = [];
            let msgLen = BgpConst.BGP_HEAD_LEN + pathAttrBuf.length + 2; // 固定长度

            let route = routes[routeIndex];
            const includePathId = this.shouldSendAddPath();
            let routeNlri = this.buildIpPrefixNlri(route, includePathId);
            let nlriLen = routeNlri.length;
            while (msgLen + nlriLen <= BgpConst.BGP_MAX_PKT_SIZE && routeIndex < routes.length) {
                withdrawNlri.push(...routeNlri);

                routeIndex++;
                msgLen += nlriLen;
                if (routeIndex < routes.length) {
                    route = routes[routeIndex];
                    routeNlri = this.buildIpPrefixNlri(route, includePathId);
                    nlriLen = routeNlri.length;
                } else {
                    break;
                }
            }

            const withdrawNlriBuf = Buffer.alloc(withdrawNlri.length + 2);
            withdrawNlriBuf.writeUInt16BE(withdrawNlri.length, 0);
            withdrawNlriBuf.set(withdrawNlri, 2);

            const bufHeader = this.session.buildBgpMessageHeader(
                BgpConst.BGP_HEAD_LEN + withdrawNlriBuf.length + pathAttrBuf.length,
                BgpConst.BGP_PACKET_TYPE.UPDATE
            );

            const buffer = Buffer.concat([bufHeader, withdrawNlriBuf, pathAttrBuf]);
            return {
                status: true,
                index: routeIndex,
                buffer: buffer
            };
        } catch (error) {
            logger.error(`Error building IPv4 WITHDRAW message: ${error.message}`);
            return {
                status: false,
                index: routeIndex,
                buffer: null
            };
        }
    }

    buildWithdrawMpMsg(routes, routeIndex) {
        try {
            // 构建撤销路由缓冲区
            const withdrawnRoutesBuf = Buffer.alloc(2);
            withdrawnRoutesBuf.writeUInt16BE(0, 0);

            const msgLen = BgpConst.BGP_HEAD_LEN + withdrawnRoutesBuf.length + 2; // 固定长度

            // 构建路径属性
            const mpUnReachAttrResult = this.buildMpUnreachNlriAttribute(routes, msgLen, routeIndex);

            // 构建路径属性缓冲区
            const pathAttrBuf = Buffer.alloc(mpUnReachAttrResult.attr.length + 2);
            pathAttrBuf.writeUInt16BE(mpUnReachAttrResult.attr.length, 0);
            pathAttrBuf.set(mpUnReachAttrResult.attr, 2);

            // 构建消息头
            const bufHeader = this.session.buildBgpMessageHeader(
                BgpConst.BGP_HEAD_LEN + withdrawnRoutesBuf.length + pathAttrBuf.length,
                BgpConst.BGP_PACKET_TYPE.UPDATE
            );

            const buffer = Buffer.concat([bufHeader, withdrawnRoutesBuf, pathAttrBuf]);

            return {
                status: true,
                index: mpUnReachAttrResult.index,
                buffer: buffer
            };
        } catch (error) {
            logger.error(`Error building IPv6 WITHDRAW message: ${error.message}`);
            return {
                status: false,
                index: routeIndex,
                buffer: null
            };
        }
    }

    sendBuiltRouteLoop(routes, builder, routeIndex = 0) {
        while (routeIndex < routes.length) {
            const result = builder(routes, routeIndex);
            if (!result.status) return null;
            routeIndex = result.index;
            const pending = this.session.sendRoute(result.buffer);
            if (pending && typeof pending.then === 'function') {
                return pending.then(() => this.sendBuiltRouteLoop(routes, builder, routeIndex));
            }
        }
        return null;
    }

    getRouteGroupBuilder() {
        const ipType = getIpType(this.session.peerIp);

        if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        ) {
            if (CommonUtils.BIT_TEST(this.session.localCapFlags, BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING)) {
                return this.buildUpdateMpMsg.bind(this);
            } else if (ipType === BgpConst.IP_TYPE.IPV4) {
                // 没使能EXTENDED_NEXT_HOP_ENCODING的话，需要ipv4邻居才发送
                return this.buildUpdateMsgIpv4.bind(this);
            }
        } else if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        ) {
            return this.buildUpdateMpMsg.bind(this);
        } else if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN
        ) {
            return this.buildUpdateMpMsg.bind(this);
        } else if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
        ) {
            return this.buildUpdateMpMsg.bind(this);
        } else if (this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
            return this.buildUpdateMpMsg.bind(this);
        }
        return null;
    }

    sendRouteGroup(routes) {
        if (!routes || routes.length === 0) return null;
        const builder = this.getRouteGroupBuilder();
        return builder ? this.sendBuiltRouteLoop(routes, builder) : null;
    }

    getSelectedRoutesForBatch(routes) {
        if (!this.isIpUnicastFamily() || this.shouldSendAddPath()) return routes;
        const selected = new Map();
        routes.forEach(route => {
            const prefixKey = this.getRouteUnicastPrefixKey(route);
            const current = selected.get(prefixKey);
            if (!current || this.getRoutePathId(route) < this.getRoutePathId(current)) {
                selected.set(prefixKey, route);
            }
        });
        const result = [];
        for (const route of selected.values()) {
            if (this.getRoutePathId(route) === 0) {
                result.push(route);
                continue;
            }
            const best = this.instance.routeMap.queryPrefix(route.ip, {
                prefixLength: route.mask,
                rd: BgpRoute.normalizeRd(route.rd),
                bestPathOnly: true,
                pageSize: 1,
                includeTotal: false
            }).list[0];
            if (best) result.push(best);
        }
        return result;
    }

    sendRouteBatchNow(routes) {
        if (this.peerState !== BgpConst.BGP_PEER_STATE.ESTABLISHED) {
            return null;
        }
        const groups = new Map();
        this.getSelectedRoutesForBatch(routes).forEach(route => {
            const key = this.getOutboundRouteAttrGroupKey(route);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(route);
        });
        const routeGroups = Array.from(groups.values());
        const sendNext = index => {
            while (index < routeGroups.length) {
                const pending = this.sendRouteGroup(routeGroups[index]);
                index += 1;
                if (pending && typeof pending.then === 'function') {
                    return pending.then(() => sendNext(index));
                }
            }
            return null;
        };
        return sendNext(0);
    }

    abandonRouteBatchStream(state, needsResend = false) {
        state.abandoned = true;
        state.needsResend = state.needsResend || needsResend;
        state.pendingGroups.clear();
        state.pendingPrefixes?.clear();
        state.pendingRouteCount = 0;
    }

    unindexPendingRouteBatchStreamRoutes(state, routes) {
        if (!state.pendingPrefixes) return;
        routes.forEach(route => {
            const prefixKey = this.getRouteUnicastPrefixKey(route);
            if (state.pendingPrefixes.get(prefixKey)?.route === route) {
                state.pendingPrefixes.delete(prefixKey);
            }
        });
    }

    sendCompleteRouteBatchStreamPackets(state, routes) {
        while (routes.length > 0) {
            const result = state.builder(routes, 0);
            if (!result.status || result.index <= 0) {
                this.requestPeerResync('route batch stream packetization failed');
                this.abandonRouteBatchStream(state);
                return null;
            }

            // The builder consumed every available route, so this may still be
            // a partial UPDATE. Keep it until another chunk supplies the
            // look-ahead route, or until the API operation explicitly ends.
            if (result.index >= routes.length) return null;

            const consumedRoutes = routes.splice(0, result.index);
            this.unindexPendingRouteBatchStreamRoutes(state, consumedRoutes);
            state.pendingRouteCount -= consumedRoutes.length;
            const pending = this.session.sendRoute(result.buffer);
            if (pending && typeof pending.then === 'function') {
                if (state.abandonOnBackpressure) {
                    const tracked = this.trackRouteSend(pending);
                    this.abandonRouteBatchStream(state, true);
                    return tracked;
                }
                return pending.then(() => this.sendCompleteRouteBatchStreamPackets(state, routes));
            }
        }
        return null;
    }

    flushOldestRouteBatchStreamGroup(state) {
        const oldest = state.pendingGroups.entries().next();
        if (oldest.done) return null;
        const [key, routes] = oldest.value;
        state.pendingGroups.delete(key);
        state.pendingRouteCount -= routes.length;
        this.unindexPendingRouteBatchStreamRoutes(state, routes);
        const pending = this.sendBuiltRouteLoop(routes, state.builder);
        if (pending && typeof pending.then === 'function') {
            if (state.abandonOnBackpressure) {
                const tracked = this.trackRouteSend(pending);
                this.abandonRouteBatchStream(state, true);
                return tracked;
            }
            return pending;
        }
        return null;
    }

    appendRouteBatchStreamGroup(state, key, group) {
        const pendingRoutes = state.pendingGroups.get(key) || [];
        group.forEach(route => {
            if (state.pendingPrefixes) {
                const prefixKey = this.getRouteUnicastPrefixKey(route);
                const previous = state.pendingPrefixes.get(prefixKey);
                if (previous) {
                    const previousRoutes = state.pendingGroups.get(previous.groupKey);
                    const previousIndex = previousRoutes?.indexOf(previous.route) ?? -1;
                    if (previousIndex >= 0) {
                        previousRoutes.splice(previousIndex, 1);
                        state.pendingRouteCount -= 1;
                        if (previousRoutes.length === 0) {
                            state.pendingGroups.delete(previous.groupKey);
                        }
                    }
                    state.pendingPrefixes.delete(prefixKey);
                }
                state.pendingPrefixes.set(prefixKey, { groupKey: key, route });
            }
            pendingRoutes.push(route);
            state.pendingRouteCount += 1;
        });

        // Refresh insertion order so the global bound evicts the least
        // recently extended attribute group first.
        state.pendingGroups.delete(key);
        state.pendingGroups.set(key, pendingRoutes);

        const enforceBound = () => {
            while (state.pendingRouteCount > MAX_PENDING_ROUTE_STREAM_ROUTES) {
                const flushPending = this.flushOldestRouteBatchStreamGroup(state);
                if (flushPending) {
                    if (state.abandoned) return flushPending;
                    return flushPending.then(enforceBound);
                }
                if (state.abandoned) return null;
            }
            return null;
        };

        const pending = this.sendCompleteRouteBatchStreamPackets(state, pendingRoutes);
        if (pending) {
            if (state.abandoned) return pending;
            return pending.then(enforceBound);
        }
        if (state.abandoned) return null;
        return enforceBound();
    }

    writeRouteBatchStream(state, routes) {
        if (state.ended || state.abandoned || !routes || routes.length === 0) return null;

        const groups = new Map();
        this.getSelectedRoutesForBatch(routes).forEach(route => {
            const key = this.getOutboundRouteAttrGroupKey(route);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(route);
        });

        const groupEntries = Array.from(groups.entries());
        const sendNext = index => {
            while (index < groupEntries.length) {
                const [key, group] = groupEntries[index];
                const pending = this.appendRouteBatchStreamGroup(state, key, group);
                index += 1;
                if (pending) {
                    if (state.abandoned) return pending;
                    return pending.then(() => sendNext(index));
                }
                if (state.abandoned) return null;
            }
            return null;
        };
        return sendNext(0);
    }

    endRouteBatchStream(state) {
        if (state.ended) return this.activeSendPromise;
        state.ended = true;

        if (state.abandoned) {
            if (!state.needsResend) return this.activeSendPromise;
            if (this.activeSendPromise) {
                this.resendRequested = true;
                return this.activeSendPromise;
            }
            return this.sendRoute();
        }

        const routeGroups = Array.from(state.pendingGroups.values());
        state.pendingGroups.clear();
        state.pendingPrefixes?.clear();
        state.pendingRouteCount = 0;
        const sendNext = index => {
            while (index < routeGroups.length) {
                const pending = this.sendBuiltRouteLoop(routeGroups[index], state.builder);
                index += 1;
                if (pending && typeof pending.then === 'function') {
                    return pending.then(() => sendNext(index));
                }
            }
            return null;
        };
        const pending = sendNext(0);
        return state.trackSends ? this.trackRouteSend(pending) : pending;
    }

    createRouteBatchStream(options = {}) {
        const state = {
            builder: this.getRouteGroupBuilder(),
            pendingGroups: new Map(),
            pendingPrefixes: this.isIpUnicastFamily() && !this.shouldSendAddPath() ? new Map() : null,
            pendingRouteCount: 0,
            abandoned: false,
            needsResend: false,
            ended: false,
            abandonOnBackpressure: options.abandonOnBackpressure !== false,
            trackSends: options.trackSends !== false
        };

        if (this.peerState !== BgpConst.BGP_PEER_STATE.ESTABLISHED || !state.builder) {
            state.abandoned = true;
        } else if (this.activeWithdrawPromise) {
            this.requestPeerResync('announcement stream while a withdraw stream is backpressured');
            state.abandoned = true;
        } else if (this.activeSendPromise) {
            state.abandoned = true;
            state.needsResend = true;
        }

        return {
            write: routes => this.writeRouteBatchStream(state, routes),
            end: () => this.endRouteBatchStream(state)
        };
    }

    sendRoutePage(cursor = null, routeBatchStream = null) {
        const stream =
            routeBatchStream ||
            this.createRouteBatchStream({
                abandonOnBackpressure: false,
                trackSends: false
            });
        const page = this.instance.routeMap.queryPage({
            pageSize: 2000,
            afterRouteId: cursor,
            includeTotal: false,
            bestPathOnly: this.isIpUnicastFamily() && !this.shouldSendAddPath()
        });
        if (page.list.length === 0) return stream.end();
        const pending = stream.write(page.list);
        const next = () => (page.nextCursor === null ? stream.end() : this.sendRoutePage(page.nextCursor, stream));
        return pending && typeof pending.then === 'function' ? pending.then(next) : next();
    }

    trackRouteSend(pending) {
        if (!pending || typeof pending.then !== 'function') return null;
        this.activeSendPromise = pending
            .catch(error => logger.error(`BGP route stream failed: ${error.message}`))
            .finally(() => {
                this.activeSendPromise = null;
                if (this.resendRequested) {
                    this.resendRequested = false;
                    this.sendRoute();
                }
            });
        return this.activeSendPromise;
    }

    sendRouteBatch(routes) {
        if (this.activeWithdrawPromise) {
            // Announcements must not race a backpressured withdraw stream. Do
            // not retain this batch: resetting the session makes the next
            // establishment advertise a bounded snapshot from SQLite.
            this.requestPeerResync('announcement while a withdraw stream is backpressured');
            return this.activeWithdrawPromise;
        }
        if (this.activeSendPromise) {
            // Do not retain subsequent batches while the socket is congested.
            // A bounded full-table stream will reconcile the peer afterwards.
            this.resendRequested = true;
            return this.activeSendPromise;
        }
        return this.trackRouteSend(this.sendRouteBatchNow(routes));
    }

    sendRoute() {
        if (this.peerState !== BgpConst.BGP_PEER_STATE.ESTABLISHED) return null;
        if (this.activeWithdrawPromise) {
            this.requestPeerResync('route refresh while a withdraw stream is backpressured');
            return this.activeWithdrawPromise;
        }
        if (this.activeSendPromise) {
            this.resendRequested = true;
            return this.activeSendPromise;
        }
        return this.trackRouteSend(this.sendRoutePage());
    }

    withdrawRouteNow(withdrawnRoutes) {
        if (this.peerState !== BgpConst.BGP_PEER_STATE.ESTABLISHED) {
            return null;
        }

        withdrawnRoutes = this.getWithdrawnRoutes(withdrawnRoutes || []);
        if (withdrawnRoutes.length === 0) {
            return null;
        }

        if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        ) {
            if (CommonUtils.BIT_TEST(this.session.localCapFlags, BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING)) {
                return this.sendBuiltRouteLoop(withdrawnRoutes, this.buildWithdrawMpMsg.bind(this));
            } else {
                return this.sendBuiltRouteLoop(withdrawnRoutes, this.buildWithdrawMsgIpv4.bind(this));
            }
        } else if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        ) {
            return this.sendBuiltRouteLoop(withdrawnRoutes, this.buildWithdrawMpMsg.bind(this));
        } else if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN
        ) {
            return this.sendBuiltRouteLoop(withdrawnRoutes, this.buildWithdrawMpMsg.bind(this));
        } else if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
        ) {
            return this.sendBuiltRouteLoop(withdrawnRoutes, this.buildWithdrawMpMsg.bind(this));
        } else if (this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
            return this.sendBuiltRouteLoop(withdrawnRoutes, this.buildWithdrawMpMsg.bind(this));
        }
        return null;
    }

    requestPeerResync(reason) {
        if (this.resyncRequested) return;
        this.resyncRequested = true;
        logger.warn(`Resetting BGP peer ${this.session.peerIp} for bounded route resync: ${reason}`);
        if (typeof this.session.resetSession === 'function') {
            this.session.resetSession();
        }
    }

    withdrawRoute(withdrawnRoutes) {
        if (this.activeSendPromise) {
            this.requestPeerResync('withdraw while an announcement stream is backpressured');
            return this.activeSendPromise;
        }
        if (this.activeWithdrawPromise) {
            this.requestPeerResync('bulk withdraw exceeded socket backpressure');
            return this.activeWithdrawPromise;
        }
        const pending = this.withdrawRouteNow(withdrawnRoutes);
        if (!pending || typeof pending.then !== 'function') return null;
        this.activeWithdrawPromise = pending
            .catch(error => logger.warn(`BGP withdraw stream stopped: ${error.message}`))
            .finally(() => {
                this.activeWithdrawPromise = null;
            });
        return this.activeWithdrawPromise;
    }

    buildLabeledUnicastNlri(route) {
        const label = route.label ?? 16;
        const labelBytes = encodeMplsLabel(label, true);
        const prefixBytes = ipToBytes(route.ip);
        const prefixByteLength = Math.ceil(route.mask / 8);
        const nlriBitLength = 24 + Number(route.mask);

        if (!Number.isInteger(nlriBitLength) || nlriBitLength < 24 || nlriBitLength > 56) {
            throw new Error(`Invalid IPv4 labeled-unicast NLRI length ${nlriBitLength}`);
        }

        return Buffer.from([nlriBitLength, ...labelBytes, ...prefixBytes.slice(0, prefixByteLength)]);
    }

    buildQpNlri(route) {
        const nlri = [];
        // TLV 1: DQPN，length 字段单位为 bit，value 使用最少 1-3 字节编码
        const dqpn = Number(route.dqpn || 0);
        const { bitLength: dqpnBitLength, bytes: dqpnBytes } = encodeQpDqpn(dqpn);
        nlri.push(1); // type = 1
        nlri.push(dqpnBitLength); // length（bit 数）
        nlri.push(...dqpnBytes); // DQPN 值

        // TLV 2: prefix，length 为 bit 数，value 为 ceil(mask/8) 字节
        const prefixBytes = ipToBytes(route.ip);
        const prefixByteLength = Math.ceil(route.mask / 8);
        nlri.push(2); // type = 2
        nlri.push(route.mask); // length（bit 数）
        nlri.push(...prefixBytes.slice(0, prefixByteLength)); // 前缀字节

        // 计算总长度（1字节长度字段 + 实际数据长度）
        const totalLength = nlri.length;

        // 检查长度是否超过255
        if (totalLength > 255) {
            throw new Error(`NLRIs total length ${totalLength} exceeds 255`);
        }

        // 在最前面加上总长度（1字节）
        const result = [totalLength, ...nlri];

        return Buffer.from(result);
    }

    buildMvpnNlri(route) {
        const type = route.routeType;
        const rdBytes = rdStringToBytes(route.rd);
        const bufferParts = [];

        bufferParts.push(Buffer.from([type]));

        const contentParts = [];

        contentParts.push(rdBytes);

        switch (type) {
            case BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD: {
                // Type 1
                const ipBytes = ipToBytes(route.originatingRouterIp);
                contentParts.push(Buffer.from(ipBytes));
                break;
            }
            case BgpConst.BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD: {
                // Type 2
                const asBuf = Buffer.alloc(4);
                asBuf.writeUInt32BE(route.sourceAs || this.session.localAs, 0);
                contentParts.push(asBuf);
                break;
            }
            case BgpConst.BGP_MVPN_ROUTE_TYPE.S_PMSI_AD: {
                // Type 3
                const sourceBytes = ipToBytes(route.sourceIp);
                const groupBytes = ipToBytes(route.groupIp);
                const origIpBytes = ipToBytes(route.originatingRouterIp || this.session.localIp);

                contentParts.push(Buffer.from([sourceBytes.length * 8]));
                contentParts.push(Buffer.from(sourceBytes));
                contentParts.push(Buffer.from([groupBytes.length * 8]));
                contentParts.push(Buffer.from(groupBytes));
                contentParts.push(Buffer.from(origIpBytes));
                break;
            }
            case BgpConst.BGP_MVPN_ROUTE_TYPE.LEAF_AD: {
                // Type 4
                break;
            }
            case BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD: {
                // Type 5
                const sourceBytes = ipToBytes(route.sourceIp);
                const groupBytes = ipToBytes(route.groupIp);

                contentParts.push(Buffer.from([sourceBytes.length * 8]));
                contentParts.push(Buffer.from(sourceBytes));
                contentParts.push(Buffer.from([groupBytes.length * 8]));
                contentParts.push(Buffer.from(groupBytes));
                break;
            }
            case BgpConst.BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN: // Type 6
            case BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN: {
                // Type 7
                const asBuf = Buffer.alloc(4);
                asBuf.writeUInt32BE(route.sourceAs || 0, 0);
                contentParts.push(asBuf);

                const groupBytes = ipToBytes(route.groupIp);
                contentParts.push(Buffer.from([groupBytes.length * 8]));
                contentParts.push(Buffer.from(groupBytes));

                const sourceBytes = ipToBytes(route.sourceIp);
                contentParts.push(Buffer.from([sourceBytes.length * 8]));
                contentParts.push(Buffer.from(sourceBytes));
                break;
            }
        }

        const dataBuffer = Buffer.concat(contentParts);
        bufferParts.push(Buffer.from([dataBuffer.length]));
        bufferParts.push(dataBuffer);

        return Buffer.concat(bufferParts);
    }
}

module.exports = BgpPeer;
