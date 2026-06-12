const BgpConst = require('../const/bgpConst');
const {
    writeUInt32,
    ipToBytes,
    writeUInt16,
    getIpType,
    rdStringToBytes,
    extCommunitiesToBytes
} = require('../utils/ipUtils');
const { getAddrFamilyType } = require('../utils/bgpUtils');
const logger = require('../log/logger');
const CommonUtils = require('../utils/commonUtils');

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

class BgpPeer {
    constructor(session, instance) {
        this.peerState = BgpConst.BGP_PEER_STATE.IDLE;
        this.session = session;
        this.instance = instance;
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

    getPeerInfo() {
        const addressFamily = getAddrFamilyType(this.instance.afi, this.instance.safi);
        return {
            vrfIndex: this.instance.vrfIndex,
            localIp: this.session.localIp,
            localAs: this.session.localAs,
            peerIp: this.session.peerIp,
            peerAs: this.session.peerAs,
            routerId: this.session.routerId,
            peerState: BgpConst.BGP_PEER_STATE_NAME[this.peerState],
            addressFamily: addressFamily,
            peerType: this.session.peerType
        };
    }

    getQpNextHop(route) {
        return `${route?.nextHop || this.instance.bsid || this.session.localIp}`;
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
        const isSingleRouteMode =
            routes.length === 1 && routes[0].nextHop && this.session.peerType === BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP;
        const nextHopIp = isSingleRouteMode ? routes[0].nextHop : this.session.localIp;

        if (this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
            // QP Next Hop 始终优先使用 BSID，避免被扩展下一跳逻辑覆盖
            const qpNextHop = this.getQpNextHop(route);
            const nextHopBytes = ipToBytes(`${qpNextHop}`);
            attr.push(nextHopBytes.length);
            attr.push(...nextHopBytes);
            msgLen += 1 + nextHopBytes.length;
        } else if (
            CommonUtils.BIT_TEST(this.session.localCapFlags, BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING)
        ) {
            const nextHopBytes = ipToBytes(`${nextHopIp}`);
            attr.push(nextHopBytes.length);
            attr.push(...nextHopBytes);
            msgLen += 1 + nextHopBytes.length;
        } else if (
            this.instance.afType === BgpConst.BGP_AFI_TYPE.AF_TYPE_IPV4 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN
        ) {
            // MVPN Next Hop
            // For MVPN, the Next Hop is 4 bytes (IPv4) or 16 bytes (IPv6)
            // Typically same as local IP.
            if (CommonUtils.BIT_TEST(this.session.localCapFlags, BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING)) {
                const nextHopBytes = ipToBytes(`${this.session.localIp}`);
                attr.push(nextHopBytes.length);
                attr.push(...nextHopBytes);
                msgLen += 1 + nextHopBytes.length;
            } else {
                // For now assuming IPv4 peering for MVPN IPv4 routes or basic encoding
                const nextHopBytes = ipToBytes(this.session.localIp);
                attr.push(nextHopBytes.length);
                attr.push(...nextHopBytes);
                msgLen += 1 + nextHopBytes.length;
            }
        } else {
            const nextHopBytes = ipToBytes(`::ffff:${this.session.localIp}`);
            attr.push(nextHopBytes.length);
            attr.push(...nextHopBytes);
            msgLen += 1 + nextHopBytes.length;
        }

        // Reserved
        attr.push(0x00);
        msgLen += 1;

        // NLRI
        let nlriBuf = [];

        if (
            this.instance.afType === BgpConst.BGP_AFI_TYPE.AF_TYPE_IPV4 &&
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
        } else {
            let prefixLength = Math.ceil(route.mask / 8); // 计算需要的字节数
            let nlriLen = 1 + prefixLength;
            while (msgLen + nlriLen < BgpConst.BGP_MAX_PKT_SIZE && routeIndex < routes.length) {
                attr.push(route.mask); // 前缀长度（单位bit）
                const prefixBytes = ipToBytes(route.ip);
                attr.push(...prefixBytes.slice(0, prefixLength));

                routeIndex++;
                msgLen += nlriLen;
                if (routeIndex < routes.length) {
                    route = routes[routeIndex];
                    prefixLength = Math.ceil(route.mask / 8); // 计算需要的字节数
                    nlriLen = 1 + prefixLength;
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
        } else {
            let prefixLength = Math.ceil(route.mask / 8); // 计算需要的字节数
            let nlriLen = 1 + prefixLength;
            while (msgLen + nlriLen < BgpConst.BGP_MAX_PKT_SIZE && routeIndex < routes.length) {
                attr.push(route.mask); // 前缀长度（单位bit）
                const prefixBytes = ipToBytes(route.ip);
                attr.push(...prefixBytes.slice(0, prefixLength));

                routeIndex++;
                msgLen += nlriLen;
                if (routeIndex < routes.length) {
                    route = routes[routeIndex];
                    prefixLength = Math.ceil(route.mask / 8); // 计算需要的字节数
                    nlriLen = 1 + prefixLength;
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

            // 检测是否为单条路由模式且路由包含自定义属性
            const isSingleRouteMode = routes.length === 1 && routes[0].asPath;
            const route = routes[routeIndex];

            // 构建路径属性
            let asPath = [];
            let localPref = [];
            let origin = [0x00];
            let med = 0;
            let communities = null;

            if (isSingleRouteMode) {
                if (route.asPath) {
                    const use4ByteAsn = CommonUtils.BIT_TEST(
                        this.session.localCapFlags,
                        BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS
                    );
                    const asPathBytes = parseRouteAsPath(route.asPath, use4ByteAsn);
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
                        asPath = this.buildPathAttribute(
                            BgpConst.BGP_PATH_ATTR.AS_PATH,
                            BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                            Array.from(finalAsPathBytes)
                        );
                    }
                }
                if (route.origin !== undefined) {
                    origin =
                        typeof route.origin === 'string'
                            ? [{ IGP: 0, EGP: 1, INCOMPLETE: 2 }[route.origin] || 0]
                            : [route.origin];
                }
                if (route.med !== undefined) med = route.med;
                if (route.localPref !== undefined && this.session.peerType === BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP) {
                    localPref = this.buildPathAttribute(
                        BgpConst.BGP_PATH_ATTR.LOCAL_PREF,
                        BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                        writeUInt32(route.localPref)
                    );
                }
                if (route.communities) {
                    const communityBytes = parseRouteCommunities(route.communities);
                    if (communityBytes)
                        communities = this.buildPathAttribute(
                            BgpConst.BGP_PATH_ATTR.COMMUNITY,
                            BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                            Array.from(communityBytes)
                        );
                }
            }

            if (asPath.length === 0) {
                if (this.session.peerType === BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP) {
                    asPath = this.buildPathAttribute(
                        BgpConst.BGP_PATH_ATTR.AS_PATH,
                        BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                        [0x02, 0x01, ...writeUInt32(this.session.localAs)]
                    );
                } else {
                    asPath = this.buildPathAttribute(
                        BgpConst.BGP_PATH_ATTR.AS_PATH,
                        BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                        []
                    );
                }
            }
            if (localPref.length === 0 && this.session.peerType === BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP) {
                localPref = this.buildPathAttribute(
                    BgpConst.BGP_PATH_ATTR.LOCAL_PREF,
                    BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                    writeUInt32(100)
                );
            }

            const pathAttr = [
                ...this.buildPathAttribute(
                    BgpConst.BGP_PATH_ATTR.ORIGIN,
                    BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                    origin
                ),
                ...asPath,
                ...this.buildPathAttribute(
                    BgpConst.BGP_PATH_ATTR.MED,
                    BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL,
                    writeUInt32(med)
                ),
                ...localPref
            ];
            if (communities) pathAttr.push(...communities);

            // 添加自定义属性
            if (this.instance.customAttr?.trim()) {
                try {
                    const customPathAttr = this.session.processCustomPkt(this.instance.customAttr);
                    pathAttr.push(...customPathAttr);
                } catch (error) {
                    logger.error(`Error processing custom path attribute: ${error.message}`);
                    return {
                        status: false,
                        index: routeIndex,
                        buffer: null
                    };
                }
            }

            if (this.instance.rt?.trim()) {
                const rtList = this.instance.rt.trim().split(/\s+/);
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

            const isSingleRouteMode = routes.length === 1 && routes[0].asPath;
            const route = routes[routeIndex];
            let asPath = [],
                localPref = [],
                origin = [0x00],
                nextHop = this.session.localIp,
                med = 0,
                communities = null;

            if (isSingleRouteMode) {
                if (route.asPath) {
                    const use4ByteAsn = CommonUtils.BIT_TEST(
                        this.session.localCapFlags,
                        BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS
                    );
                    const asPathBytes = parseRouteAsPath(route.asPath, use4ByteAsn);
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
                        asPath = this.buildPathAttribute(
                            BgpConst.BGP_PATH_ATTR.AS_PATH,
                            BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                            Array.from(finalAsPathBytes)
                        );
                    }
                }
                if (route.nextHop && this.session.peerType === BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP) {
                    // Only IBGP can use route's Next Hop, EBGP must use local IP
                    nextHop = route.nextHop;
                }
                if (route.origin !== undefined)
                    origin =
                        typeof route.origin === 'string'
                            ? [{ IGP: 0, EGP: 1, INCOMPLETE: 2 }[route.origin] || 0]
                            : [route.origin];
                if (route.med !== undefined) med = route.med;
                if (route.localPref !== undefined && this.session.peerType === BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP) {
                    localPref = this.buildPathAttribute(
                        BgpConst.BGP_PATH_ATTR.LOCAL_PREF,
                        BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                        writeUInt32(route.localPref)
                    );
                }
                if (route.communities) {
                    const communityBytes = parseRouteCommunities(route.communities);
                    if (communityBytes)
                        communities = this.buildPathAttribute(
                            BgpConst.BGP_PATH_ATTR.COMMUNITY,
                            BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                            Array.from(communityBytes)
                        );
                }
            }

            if (asPath.length === 0) {
                if (this.session.peerType === BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP) {
                    asPath = this.buildPathAttribute(
                        BgpConst.BGP_PATH_ATTR.AS_PATH,
                        BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                        [0x02, 0x01, ...writeUInt32(this.session.localAs)]
                    );
                } else {
                    asPath = this.buildPathAttribute(
                        BgpConst.BGP_PATH_ATTR.AS_PATH,
                        BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                        []
                    );
                }
            }
            if (localPref.length === 0 && this.session.peerType === BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP) {
                localPref = this.buildPathAttribute(
                    BgpConst.BGP_PATH_ATTR.LOCAL_PREF,
                    BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                    writeUInt32(100)
                );
            }

            const pathAttr = [
                ...this.buildPathAttribute(
                    BgpConst.BGP_PATH_ATTR.ORIGIN,
                    BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                    origin
                ),
                ...asPath,
                ...this.buildPathAttribute(
                    BgpConst.BGP_PATH_ATTR.NEXT_HOP,
                    BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE,
                    ipToBytes(nextHop)
                ),
                ...this.buildPathAttribute(
                    BgpConst.BGP_PATH_ATTR.MED,
                    BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL,
                    writeUInt32(med)
                ),
                ...localPref
            ];
            if (communities) pathAttr.push(...communities);

            // 添加自定义属性
            if (this.instance.customAttr?.trim()) {
                try {
                    const customPathAttr = this.session.processCustomPkt(this.instance.customAttr);
                    pathAttr.push(...customPathAttr);
                } catch (error) {
                    logger.error(`Error processing custom path attribute: ${error.message}`);
                    return {
                        status: false,
                        index: routeIndex,
                        buffer: null
                    };
                }
            }

            if (this.instance.rt?.trim()) {
                const rtList = this.instance.rt.trim().split(/\s+/);
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
            // 构建路径属性缓冲区
            const pathAttrBuf = Buffer.alloc(pathAttr.length + 2);
            pathAttrBuf.writeUInt16BE(pathAttr.length, 0);
            pathAttrBuf.set(pathAttr, 2);

            // 构建NLRI
            const nlri = [];
            let msgLen = BgpConst.BGP_HEAD_LEN + withdrawnRoutesBuf.length + pathAttrBuf.length;

            let curRoute = routes[routeIndex];
            let prefixLength = Math.ceil(curRoute.mask / 8); // 计算需要的字节数
            let nlriLen = 1 + prefixLength;
            while (msgLen + nlriLen < BgpConst.BGP_MAX_PKT_SIZE && routeIndex < routes.length) {
                nlri.push(curRoute.mask); // 前缀长度（单位bit）
                const prefixBytes = ipToBytes(curRoute.ip);
                nlri.push(...prefixBytes.slice(0, prefixLength));

                routeIndex++;
                msgLen += nlriLen;
                if (routeIndex < routes.length) {
                    curRoute = routes[routeIndex];
                    prefixLength = Math.ceil(curRoute.mask / 8); // 计算需要的字节数
                    nlriLen = 1 + prefixLength;
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
            let prefixLength = Math.ceil(route.mask / 8); // 计算需要的字节数
            let nlriLen = 1 + prefixLength;
            while (msgLen + nlriLen < BgpConst.BGP_MAX_PKT_SIZE && routeIndex < routes.length) {
                withdrawNlri.push(route.mask); // 前缀长度（单位bit）
                const prefixBytes = ipToBytes(route.ip);
                withdrawNlri.push(...prefixBytes.slice(0, prefixLength));

                routeIndex++;
                msgLen += nlriLen;
                if (routeIndex < routes.length) {
                    route = routes[routeIndex];
                    prefixLength = Math.ceil(route.mask / 8); // 计算需要的字节数
                    nlriLen = 1 + prefixLength;
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

    sendRoute() {
        let routeIndex = 0;
        let routes = [];

        if (this.peerState !== BgpConst.BGP_PEER_STATE.ESTABLISHED) {
            return;
        }

        const ipType = getIpType(this.session.peerIp);

        if (this.instance.singleRouteSend) {
            this.instance.routeMap.forEach((route, _) => {
                if (
                    this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
                    this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
                ) {
                    if (
                        CommonUtils.BIT_TEST(
                            this.session.localCapFlags,
                            BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING
                        )
                    ) {
                        const result = this.buildUpdateMpMsg([route], routeIndex);
                        if (result.status) {
                            this.session.sendRoute(result.buffer);
                        }
                    } else if (ipType === BgpConst.IP_TYPE.IPV4) {
                        // 没使能EXTENDED_NEXT_HOP_ENCODING的话，需要ipv4邻居才发送
                        const result = this.buildUpdateMsgIpv4([route], routeIndex);
                        if (result.status) {
                            this.session.sendRoute(result.buffer);
                        }
                    }
                } else if (
                    this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 &&
                    this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
                ) {
                    const result = this.buildUpdateMpMsg([route], routeIndex);
                    if (result.status) {
                        this.session.sendRoute(result.buffer);
                    }
                } else if (
                    this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
                    this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN
                ) {
                    const result = this.buildUpdateMpMsg([route], routeIndex);
                    if (result.status) {
                        this.session.sendRoute(result.buffer);
                    }
                } else if (this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
                    const result = this.buildUpdateMpMsg([route], routeIndex);
                    if (result.status) {
                        this.session.sendRoute(result.buffer);
                    }
                }
            });
            return;
        }

        this.instance.routeMap.forEach((route, _) => {
            routes.push(route);
        });

        if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        ) {
            if (CommonUtils.BIT_TEST(this.session.localCapFlags, BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING)) {
                while (routeIndex < routes.length) {
                    const result = this.buildUpdateMpMsg(routes, routeIndex);
                    if (result.status) {
                        this.session.sendRoute(result.buffer);
                        routeIndex = result.index;
                    } else {
                        break;
                    }
                }
            } else if (ipType === BgpConst.IP_TYPE.IPV4) {
                // 没使能EXTENDED_NEXT_HOP_ENCODING的话，需要ipv4邻居才发送
                while (routeIndex < routes.length) {
                    const result = this.buildUpdateMsgIpv4(routes, routeIndex);
                    if (result.status) {
                        this.session.sendRoute(result.buffer);
                        routeIndex = result.index;
                    } else {
                        break;
                    }
                }
            }
        } else if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        ) {
            while (routeIndex < routes.length) {
                const result = this.buildUpdateMpMsg(routes, routeIndex);
                if (result.status) {
                    this.session.sendRoute(result.buffer);
                    routeIndex = result.index;
                } else {
                    break;
                }
            }
        } else if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN
        ) {
            while (routeIndex < routes.length) {
                const result = this.buildUpdateMpMsg(routes, routeIndex);
                if (result.status) {
                    this.session.sendRoute(result.buffer);
                    routeIndex = result.index;
                } else {
                    break;
                }
            }
        } else if (this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
            while (routeIndex < routes.length) {
                const result = this.buildUpdateMpMsg(routes, routeIndex);
                if (result.status) {
                    this.session.sendRoute(result.buffer);
                    routeIndex = result.index;
                } else {
                    break;
                }
            }
        }
    }

    withdrawRoute(withdrawnRoutes) {
        let routeIndex = 0;

        if (this.peerState !== BgpConst.BGP_PEER_STATE.ESTABLISHED) {
            return;
        }

        if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        ) {
            if (CommonUtils.BIT_TEST(this.session.localCapFlags, BgpConst.BGP_CAP_FLAGS.EXTENDED_NEXT_HOP_ENCODING)) {
                while (routeIndex < withdrawnRoutes.length) {
                    const result = this.buildWithdrawMpMsg(withdrawnRoutes, routeIndex);
                    if (result.status) {
                        this.session.sendRoute(result.buffer);
                        routeIndex = result.index;
                    } else {
                        break;
                    }
                }
            } else {
                while (routeIndex < withdrawnRoutes.length) {
                    const result = this.buildWithdrawMsgIpv4(withdrawnRoutes, routeIndex);
                    if (result.status) {
                        this.session.sendRoute(result.buffer);
                        routeIndex = result.index;
                    } else {
                        break;
                    }
                }
            }
        } else if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        ) {
            while (routeIndex < withdrawnRoutes.length) {
                const result = this.buildWithdrawMpMsg(withdrawnRoutes, routeIndex);
                if (result.status) {
                    this.session.sendRoute(result.buffer);
                    routeIndex = result.index;
                } else {
                    break;
                }
            }
        } else if (
            this.instance.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN
        ) {
            while (routeIndex < withdrawnRoutes.length) {
                const result = this.buildWithdrawMpMsg(withdrawnRoutes, routeIndex);
                if (result.status) {
                    this.session.sendRoute(result.buffer);
                    routeIndex = result.index;
                } else {
                    break;
                }
            }
        } else if (this.instance.safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
            while (routeIndex < withdrawnRoutes.length) {
                const result = this.buildWithdrawMpMsg(withdrawnRoutes, routeIndex);
                if (result.status) {
                    this.session.sendRoute(result.buffer);
                    routeIndex = result.index;
                } else {
                    break;
                }
            }
        }
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
