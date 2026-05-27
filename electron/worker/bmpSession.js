const logger = require('../log/logger');
const BmpConst = require('../const/bmpConst');
const { getInitiationTlvName } = require('../utils/bmpUtils');
const BgpConst = require('../const/bgpConst');
const BmpBgpSession = require('./bmpBgpSession');
const BmpBgpRoute = require('./bmpBgpRoute');
const { rdBufferToString, ipv4BufferToString, ipv6BufferToString } = require('../utils/ipUtils');
const { parseBgpPacket } = require('../utils/bgpPacketParser');
const { getAddrFamilyType } = require('../utils/bgpUtils');
const BmpBgpInstance = require('./bmpBgpInstance');

class BmpSession {
    constructor(messageHandler, bmpWorker) {
        this.socket = null;
        this.messageHandler = messageHandler;
        this.bmpWorker = bmpWorker;
        this.localIp = null;
        this.localPort = null;
        this.remoteIp = null;
        this.remotePort = null;
        this.sysName = null;
        this.sysDesc = null;
        this.receivedAt = null;
        this.tlvs = [];

        this.bgpSessionMap = new Map();
        this.bgpInstanceMap = new Map();
        this.instAddPathMap = new Map();
        this.messageBuffer = Buffer.alloc(0);
    }

    static makeKey(localIp, localPort, remoteIp, remotePort) {
        return `${localIp}|${localPort}|${remoteIp}|${remotePort}`;
    }

    static parseKey(key) {
        const [localIp, localPort, remoteIp, remotePort] = key.split('|');
        return { localIp, localPort, remoteIp, remotePort };
    }

    isAddPathReceiveEnabled(afi, safi) {
        const key = `${afi}|${safi}`;
        if (this.instAddPathMap.has(key)) {
            return this.instAddPathMap.get(key);
        }
        return false;
    }

    // 辅助方法：设置路由属性
    setRouteAttributes(route, bgpUpdate) {
        route.bgpPacket = bgpUpdate;

        for (const attr of bgpUpdate.pathAttributes || []) {
            switch (attr.typeCode) {
                case BgpConst.BGP_PATH_ATTR.ORIGIN:
                    route.origin = attr.origin;
                    break;
                case BgpConst.BGP_PATH_ATTR.AS_PATH:
                    route.asPath = '';
                    attr.segments.forEach(seg => {
                        if (seg.typeName === 'AS_SEQUENCE') {
                            route.asPath += seg.asNumbers.join(' ');
                        } else {
                            route.asPath += `{${seg.asNumbers.join(' ')}}`;
                        }
                    });
                    break;
                case BgpConst.BGP_PATH_ATTR.NEXT_HOP:
                    route.nextHop = attr.nextHop;
                    break;
                case BgpConst.BGP_PATH_ATTR.LOCAL_PREF:
                    route.localPref = attr.localPref;
                    break;
                case BgpConst.BGP_PATH_ATTR.COMMUNITY:
                    route.communities = attr.communities.map(c => c.formatted).join(' ');
                    break;
                case BgpConst.BGP_PATH_ATTR.MED:
                    route.med = attr.med;
                    break;
                case BgpConst.BGP_PATH_ATTR.PATH_OTC:
                    route.otc = attr.otc;
                    break;
                case BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI:
                    route.nextHop = attr.mpReach.nextHop;
            }
        }
    }

    setRouteNlri(route, nlri, afi, safi) {
        route.pathId = nlri.pathId;
        route.rd = nlri.rd;
        route.ip = nlri.displayPrefix || nlri.prefix;
        route.mask = nlri.length;
        route.afi = afi;
        route.safi = safi;
        route.labels = Array.isArray(nlri.labels)
            ? nlri.labels.map(label => `${label.label}${label.bottom ? '(BOS)' : ''}`).join(',')
            : null;
        route.routeType = nlri.routeType || null;
        route.rawNlri = nlri.rawNlri || null;
        route.nlriDetail = nlri;
        route.parserValid = nlri.valid !== false;
        route.parseErrors = Array.isArray(nlri.errors) && nlri.errors.length > 0 ? nlri.errors.join('; ') : null;
        route.parseWarnings =
            Array.isArray(nlri.warnings) && nlri.warnings.length > 0 ? nlri.warnings.join('; ') : null;
    }

    getRibTypesByFlags(sessionFlags) {
        const ribTypes = [];

        if (sessionFlags === 0x00 || sessionFlags === BmpConst.BMP_SESSION_FLAGS.IPV6) {
            ribTypes.push(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN);
        }

        if (
            sessionFlags === (0x00 | BmpConst.BMP_SESSION_FLAGS.POST_POLICY) ||
            sessionFlags === (BmpConst.BMP_SESSION_FLAGS.IPV6 | BmpConst.BMP_SESSION_FLAGS.POST_POLICY)
        ) {
            ribTypes.push(BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN);
        }

        if (
            sessionFlags === (0x00 | BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT) ||
            sessionFlags === (BmpConst.BMP_SESSION_FLAGS.IPV6 | BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT)
        ) {
            ribTypes.push(BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT);
        }

        if (
            sessionFlags === (0x00 | BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT | BmpConst.BMP_SESSION_FLAGS.POST_POLICY) ||
            sessionFlags ===
                (BmpConst.BMP_SESSION_FLAGS.IPV6 |
                    BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT |
                    BmpConst.BMP_SESSION_FLAGS.POST_POLICY)
        ) {
            ribTypes.push(BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT);
        }

        return ribTypes;
    }

    processRouteMonitoringGlobal(message) {
        try {
            let position = 0;
            const sessionType = message[position];
            position += 1;
            const sessionFlags = message[position];
            position += 1;
            const rdBuffer = message.subarray(position, position + BgpConst.BGP_RD_LEN);
            position += BgpConst.BGP_RD_LEN;
            const sessionRd = rdBufferToString(rdBuffer);

            let sessionAddress;
            if (sessionFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) {
                // IPv6 对等体
                sessionAddress = ipv6BufferToString(message.subarray(position, position + 16), 128);
                position += 16;
            } else {
                // IPv4 对等体
                // 12字节保留字段
                position += 12;
                sessionAddress = ipv4BufferToString(message.subarray(position, position + 4), 32);
                position += 4;
            }

            const sessionAs = message.readUInt32BE(position);
            position += 4;
            const _sessionRouterId = ipv4BufferToString(message.subarray(position, position + 4), 32);
            position += 4;
            const _sessionTimestamp = message.readUInt32BE(position);
            position += 4;
            const _sessionTimestampMs = message.readUInt32BE(position);
            position += 4;

            const bgpSessionKey = BmpBgpSession.makeKey(sessionType, sessionRd, sessionAddress, sessionAs);
            const bgpSession = this.bgpSessionMap.get(bgpSessionKey);
            if (!bgpSession) {
                logger.error(`Received BGP Update message from unknown session: ${bgpSessionKey}`);
                return;
            }

            // BGP 更新消息
            const bgpUpdateHeader = message.subarray(position, position + BgpConst.BGP_HEAD_LEN);
            const { length: updateLength, type: _updateType } = this.parseBgpHeader(bgpUpdateHeader);
            const bgpUpdate = message.subarray(position, position + updateLength);

            // Pass bgpSession for ADD-PATH capability check
            const parsedBgpUpdate = parseBgpPacket(bgpUpdate, bgpSession); // passing bgpSession as second arg

            if (!parsedBgpUpdate.valid) {
                logger.error(`Received BGP Update message is invalid: ${parsedBgpUpdate.error}`);
            }
            position += updateLength;

            let isNotify = false;
            const ribTypes = this.getRibTypesByFlags(sessionFlags);
            if (ribTypes.length === 0) {
                logger.error(`Received BGP Update message from unknown rib type: ${sessionFlags}`);
                return;
            }

            // 处理withdrawn routes (IPv4)
            if (parsedBgpUpdate.withdrawnRoutes && parsedBgpUpdate.withdrawnRoutes.length > 0) {
                const afKey = `${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`;
                const ribTypeRouteMap = bgpSession.bgpRoutes.get(afKey);
                if (!ribTypeRouteMap) {
                    logger.error(`Received BGP Update message from unknown address family: ${afKey}`);
                    return;
                }

                // 删除所有撤销的路由
                for (const ribType of ribTypes) {
                    const routeMap = ribTypeRouteMap.get(ribType);
                    if (!routeMap) {
                        logger.error(`Received BGP Update message from unknown rib type: ${ribType}`);
                        continue;
                    }
                    for (const withdrawn of parsedBgpUpdate.withdrawnRoutes) {
                        const routeKey = BmpBgpRoute.makeKey(
                            withdrawn.pathId,
                            withdrawn.rd,
                            withdrawn.prefix,
                            withdrawn.length
                        );
                        const route = routeMap.get(routeKey);
                        if (route) {
                            routeMap.delete(routeKey);
                            isNotify = true;
                        }
                    }

                    if (isNotify) {
                        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, {
                            data: {
                                type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE,
                                client: this.getClientInfo(),
                                session: bgpSession.getSessionInfo(),
                                af: getAddrFamilyType(
                                    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                                    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
                                ),
                                ribType: ribType
                            }
                        });
                    }
                }
            }

            isNotify = false;
            // 处理MP_UNREACH_NLRI (多协议撤销路由)
            let mpUnreachNlri = null;
            for (const attr of parsedBgpUpdate.pathAttributes || []) {
                if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI) {
                    mpUnreachNlri = attr.mpUnreach;
                    break;
                }
            }

            if (mpUnreachNlri && mpUnreachNlri.withdrawnRoutes && mpUnreachNlri.withdrawnRoutes.length > 0) {
                const afKey = `${mpUnreachNlri.afi}|${mpUnreachNlri.safi}`;
                const ribTypeRouteMap = bgpSession.bgpRoutes.get(afKey);
                if (!ribTypeRouteMap) {
                    logger.error(`Received BGP Update message from unknown address family: ${afKey}`);
                    return;
                }

                // 删除所有撤销的路由
                for (const ribType of ribTypes) {
                    const routeMap = ribTypeRouteMap.get(ribType);
                    if (!routeMap) {
                        logger.error(`Received BGP Update message from unknown rib type: ${ribType}`);
                        continue;
                    }
                    for (const withdrawn of mpUnreachNlri.withdrawnRoutes) {
                        const routeKey = BmpBgpRoute.makeKey(
                            withdrawn.pathId,
                            withdrawn.rd,
                            withdrawn.prefix,
                            withdrawn.length
                        );
                        const route = routeMap.get(routeKey);
                        if (route) {
                            routeMap.delete(routeKey);
                            isNotify = true;
                        }
                    }

                    if (isNotify) {
                        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, {
                            data: {
                                type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE,
                                client: this.getClientInfo(),
                                session: bgpSession.getSessionInfo(),
                                af: getAddrFamilyType(mpUnreachNlri.afi, mpUnreachNlri.safi),
                                ribType: ribType
                            }
                        });
                    }
                }
            }

            isNotify = false;
            // 处理IPv4 NLRI
            if (parsedBgpUpdate.nlri && parsedBgpUpdate.nlri.length > 0) {
                const afKey = `${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`;
                const ribTypeRouteMap = bgpSession.bgpRoutes.get(afKey);
                if (!ribTypeRouteMap) {
                    logger.error(`Received BGP Update message from unknown address family: ${afKey}`);
                    return;
                }

                for (const ribType of ribTypes) {
                    const routeMap = ribTypeRouteMap.get(ribType);
                    if (!routeMap) {
                        logger.error(`Received BGP Update message from unknown rib type: ${ribType}`);
                        continue;
                    }
                    for (const nlri of parsedBgpUpdate.nlri) {
                        const routeKey = BmpBgpRoute.makeKey(nlri.pathId, nlri.rd, nlri.prefix, nlri.length);

                        let bmpBgpRoute = routeMap.get(routeKey);
                        if (!bmpBgpRoute) {
                            bmpBgpRoute = new BmpBgpRoute(bgpSession, null);
                            routeMap.set(routeKey, bmpBgpRoute);
                        } else {
                            bmpBgpRoute.clearAttributes();
                        }

                        this.setRouteNlri(
                            bmpBgpRoute,
                            nlri,
                            BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                            BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
                        );

                        // 设置路由属性
                        this.setRouteAttributes(bmpBgpRoute, parsedBgpUpdate);

                        isNotify = true;
                    }
                    if (isNotify) {
                        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, {
                            data: {
                                type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
                                client: this.getClientInfo(),
                                session: bgpSession.getSessionInfo(),
                                af: getAddrFamilyType(
                                    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                                    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
                                ),
                                ribType: ribType
                            }
                        });
                    }
                }
            }

            isNotify = false;
            // 处理MP_REACH_NLRI (多协议扩展)
            let mpReachNlri = null;
            for (const attr of parsedBgpUpdate.pathAttributes || []) {
                if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI) {
                    mpReachNlri = attr.mpReach;
                    break;
                }
            }

            if (mpReachNlri && mpReachNlri.nlri && mpReachNlri.nlri.length > 0) {
                // 寻找匹配的多协议peer
                const afKey = `${mpReachNlri.afi}|${mpReachNlri.safi}`;
                const ribTypeRouteMap = bgpSession.bgpRoutes.get(afKey);
                if (!ribTypeRouteMap) {
                    logger.error(`Received BGP Update message from unknown address family: ${afKey}`);
                    return;
                }
                for (const ribType of ribTypes) {
                    const routeMap = ribTypeRouteMap.get(ribType);
                    if (!routeMap) {
                        logger.error(`Received BGP Update message from unknown rib type: ${ribType}`);
                        continue;
                    }
                    for (const nlri of mpReachNlri.nlri) {
                        const routeKey = BmpBgpRoute.makeKey(nlri.pathId, nlri.rd, nlri.prefix, nlri.length);

                        let bmpBgpRoute = routeMap.get(routeKey);
                        if (!bmpBgpRoute) {
                            bmpBgpRoute = new BmpBgpRoute(bgpSession, null);
                            routeMap.set(routeKey, bmpBgpRoute);
                        } else {
                            bmpBgpRoute.clearAttributes();
                        }

                        this.setRouteNlri(bmpBgpRoute, nlri, mpReachNlri.afi, mpReachNlri.safi);

                        // 设置路由属性
                        this.setRouteAttributes(bmpBgpRoute, parsedBgpUpdate);

                        isNotify = true;
                    }

                    if (isNotify) {
                        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, {
                            data: {
                                type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
                                client: this.getClientInfo(),
                                session: bgpSession.getSessionInfo(),
                                af: getAddrFamilyType(mpReachNlri.afi, mpReachNlri.safi),
                                ribType: ribType
                            }
                        });
                    }
                }
            }
        } catch (err) {
            logger.error(`Error processing route monitoring:`, err);
        }
    }

    processRouteMonitoringLocalRib(message) {
        try {
            let position = 0;
            const instanceType = message[position];
            position += 1;
            const instanceFlags = message[position];
            position += 1;
            const rdBuffer = message.subarray(position, position + BgpConst.BGP_RD_LEN);
            position += BgpConst.BGP_RD_LEN;
            const instanceRd = rdBufferToString(rdBuffer);

            let _instanceAddress;
            if (instanceFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) {
                // IPv6 对等体
                _instanceAddress = ipv6BufferToString(message.subarray(position, position + 16), 128);
                position += 16;
            } else {
                // IPv4 对等体
                // 12字节保留字段
                position += 12;
                _instanceAddress = ipv4BufferToString(message.subarray(position, position + 4), 32);
                position += 4;
            }

            const _instanceAs = message.readUInt32BE(position);
            position += 4;
            const _instanceRouterId = ipv4BufferToString(message.subarray(position, position + 4), 32);
            position += 4;
            const _instanceTimestamp = message.readUInt32BE(position);
            position += 4;
            const _instanceTimestampMs = message.readUInt32BE(position);
            position += 4;

            // BGP 更新消息
            const bgpUpdateHeader = message.subarray(position, position + BgpConst.BGP_HEAD_LEN);
            const { length: updateLength, type: _updateType } = this.parseBgpHeader(bgpUpdateHeader);
            const bgpUpdate = message.subarray(position, position + updateLength);

            // Pass bgpSession for ADD-PATH capability check
            const parsedBgpUpdate = parseBgpPacket(bgpUpdate, this); // passing bgpSession as second arg

            if (!parsedBgpUpdate.valid) {
                logger.error(`Received BGP Update message is invalid: ${parsedBgpUpdate.error}`);
            }
            position += updateLength;

            let isNotify = false;
            // 处理withdrawn routes (IPv4)
            if (parsedBgpUpdate.withdrawnRoutes && parsedBgpUpdate.withdrawnRoutes.length > 0) {
                const instKey = `${instanceType}|${instanceRd}|${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`;
                const bgpInstance = this.bgpInstanceMap.get(instKey);
                if (!bgpInstance) {
                    logger.error(`Received BGP Update message from unknown instance: ${instKey}`);
                    return;
                }

                // 删除所有撤销的路由
                for (const withdrawn of parsedBgpUpdate.withdrawnRoutes) {
                    const routeKey = BmpBgpRoute.makeKey(
                        withdrawn.pathId,
                        withdrawn.rd,
                        withdrawn.prefix,
                        withdrawn.length
                    );
                    const route = bgpInstance.bgpRoutes.get(routeKey);
                    if (route) {
                        bgpInstance.bgpRoutes.delete(routeKey);
                        isNotify = true;
                    }
                }

                if (isNotify) {
                    this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE, {
                        data: {
                            type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE,
                            client: this.getClientInfo(),
                            instance: bgpInstance.getInstanceInfo(),
                            af: getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
                        }
                    });
                }
            }

            isNotify = false;
            // 处理MP_UNREACH_NLRI (多协议撤销路由)
            let mpUnreachNlri = null;
            for (const attr of parsedBgpUpdate.pathAttributes || []) {
                if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI) {
                    mpUnreachNlri = attr.mpUnreach;
                    break;
                }
            }

            if (mpUnreachNlri && mpUnreachNlri.withdrawnRoutes && mpUnreachNlri.withdrawnRoutes.length > 0) {
                const instKey = `${instanceType}|${instanceRd}|${mpUnreachNlri.afi}|${mpUnreachNlri.safi}`;
                const bgpInstance = this.bgpInstanceMap.get(instKey);
                if (!bgpInstance) {
                    logger.error(`Received BGP Update message from unknown instance: ${instKey}`);
                    return;
                }

                // 删除所有撤销的路由
                for (const withdrawn of mpUnreachNlri.withdrawnRoutes) {
                    const routeKey = BmpBgpRoute.makeKey(
                        withdrawn.pathId,
                        withdrawn.rd,
                        withdrawn.prefix,
                        withdrawn.length
                    );
                    const route = bgpInstance.bgpRoutes.get(routeKey);
                    if (route) {
                        isNotify = true;
                        bgpInstance.bgpRoutes.delete(routeKey);
                    }
                }

                if (isNotify) {
                    this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE, {
                        data: {
                            type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE,
                            client: this.getClientInfo(),
                            instance: bgpInstance.getInstanceInfo(),
                            af: getAddrFamilyType(mpUnreachNlri.afi, mpUnreachNlri.safi)
                        }
                    });
                }
            }

            isNotify = false;
            // 处理IPv4 NLRI
            if (parsedBgpUpdate.nlri && parsedBgpUpdate.nlri.length > 0) {
                const instKey = `${instanceType}|${instanceRd}|${BgpConst.BGP_AFI_TYPE.AFI_IPV4}|${BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST}`;
                const bgpInstance = this.bgpInstanceMap.get(instKey);
                if (!bgpInstance) {
                    logger.error(`Received BGP Update message from unknown instance: ${instKey}`);
                    return;
                }

                for (const nlri of parsedBgpUpdate.nlri) {
                    const routeKey = BmpBgpRoute.makeKey(nlri.pathId, nlri.rd, nlri.prefix, nlri.length);

                    let bmpBgpRoute = bgpInstance.bgpRoutes.get(routeKey);
                    if (!bmpBgpRoute) {
                        bmpBgpRoute = new BmpBgpRoute(null, bgpInstance);
                        bgpInstance.bgpRoutes.set(routeKey, bmpBgpRoute);
                    } else {
                        bmpBgpRoute.clearAttributes();
                    }

                    this.setRouteNlri(
                        bmpBgpRoute,
                        nlri,
                        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
                    );

                    // 设置路由属性
                    this.setRouteAttributes(bmpBgpRoute, parsedBgpUpdate);

                    isNotify = true;
                }

                if (isNotify) {
                    this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE, {
                        data: {
                            type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
                            client: this.getClientInfo(),
                            instance: bgpInstance.getInstanceInfo(),
                            af: getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
                        }
                    });
                }
            }

            // 处理MP_REACH_NLRI (多协议扩展)
            isNotify = false;
            let mpReachNlri = null;
            for (const attr of parsedBgpUpdate.pathAttributes || []) {
                if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI) {
                    mpReachNlri = attr.mpReach;
                    break;
                }
            }

            if (mpReachNlri && mpReachNlri.nlri && mpReachNlri.nlri.length > 0) {
                // 寻找匹配的多协议peer
                const instKey = `${instanceType}|${instanceRd}|${mpReachNlri.afi}|${mpReachNlri.safi}`;
                const bgpInstance = this.bgpInstanceMap.get(instKey);
                if (!bgpInstance) {
                    logger.error(`Received BGP Update message from unknown instance: ${instKey}`);
                    return;
                }

                for (const nlri of mpReachNlri.nlri) {
                    const routeKey = BmpBgpRoute.makeKey(nlri.pathId, nlri.rd, nlri.prefix, nlri.length);

                    let bmpBgpRoute = bgpInstance.bgpRoutes.get(routeKey);
                    if (!bmpBgpRoute) {
                        bmpBgpRoute = new BmpBgpRoute(null, bgpInstance);
                        bgpInstance.bgpRoutes.set(routeKey, bmpBgpRoute);
                    } else {
                        bmpBgpRoute.clearAttributes();
                    }

                    this.setRouteNlri(bmpBgpRoute, nlri, mpReachNlri.afi, mpReachNlri.safi);

                    // 设置路由属性
                    this.setRouteAttributes(bmpBgpRoute, parsedBgpUpdate);

                    isNotify = true;
                }

                if (isNotify) {
                    this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE, {
                        data: {
                            type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
                            client: this.getClientInfo(),
                            instance: bgpInstance.getInstanceInfo(),
                            af: getAddrFamilyType(mpReachNlri.afi, mpReachNlri.safi)
                        }
                    });
                }
            }
        } catch (err) {
            logger.error(`Error processing route monitoring:`, err);
        }
    }

    processRouteMonitoring(message) {
        let position = 0;
        const sessionType = message[position];

        if (sessionType === BmpConst.BMP_PEER_TYPE.GLOBAL) {
            this.processRouteMonitoringGlobal(message);
        } else if (sessionType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
            this.processRouteMonitoringLocalRib(message);
        } else {
            logger.error(`Received BGP Update message from unknown session type: ${sessionType}`);
            return;
        }
    }

    mergeAddressFamilies(target, source) {
        if (!source || !Array.isArray(source)) return;
        source.forEach(srcItem => {
            const exists = target.some(tgtItem => tgtItem.afi === srcItem.afi && tgtItem.safi === srcItem.safi);
            if (!exists) {
                target.push(srcItem);
            }
        });
    }

    getClientInfo() {
        return {
            localIp: this.localIp,
            localPort: this.localPort,
            remoteIp: this.remoteIp,
            remotePort: this.remotePort,
            sysName: this.sysName,
            sysDesc: this.sysDesc,
            rawTlvs: this.tlvs,
            receivedAt: this.receivedAt
        };
    }

    processInitiation(message) {
        try {
            let position = 0;

            this.tlvs = [];

            // 解析消息中的所有TLV
            while (position < message.length) {
                // 每个TLV由Type (2字节), Length (2字节)和Value (可变)组成
                if (position + 4 > message.length) {
                    break; // 没有足够的TLV头数据
                }

                const type = message.readUInt16BE(position);
                position += 2;

                const length = message.readUInt16BE(position);
                position += 2;

                if (position + length > message.length) {
                    break; // 没有足够的TLV值数据
                }

                const value = message.subarray(position, position + length).toString('utf8');
                position += length;

                this.tlvs.push({ type, length, value });
            }

            // 提取已知的TLV类型
            this.sysName = '';
            this.sysDesc = '';

            for (const tlv of this.tlvs) {
                switch (tlv.type) {
                    case BmpConst.BMP_INITIATION_TLV_TYPE.SYS_NAME: // sysName
                        this.sysName = tlv.value;
                        tlv.tlvName = getInitiationTlvName(tlv.type);
                        break;
                    case BmpConst.BMP_INITIATION_TLV_TYPE.SYS_DESC: // sysDesc
                        this.sysDesc = tlv.value;
                        tlv.tlvName = getInitiationTlvName(tlv.type);
                        break;
                    default:
                        tlv.tlvName = getInitiationTlvName(tlv.type);
                }
            }

            this.receivedAt = new Date();

            // 创建一个初始化记录
            const clientInfo = this.getClientInfo();

            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.INITIATION, { data: clientInfo });
            logger.info(`Processed initiation message: sysName=${this.sysName}, sysDesc=${this.sysDesc}`);
        } catch (err) {
            logger.error(`Error processing initiation:`, err);
        }
    }

    parseBgpHeader(buffer) {
        if (buffer.length < BgpConst.BGP_HEAD_LEN) {
            return null;
        }

        const marker = buffer.subarray(0, 16).toString('hex');
        const length = buffer.readUInt16BE(16);
        const type = buffer.readUInt8(18);

        return { marker, length, type };
    }

    processPeerDownGlobal(message) {
        try {
            let position = 0;
            const sessionType = message[position];
            position += 1;
            const sessionFlags = message[position];
            position += 1;
            const rdBuffer = message.subarray(position, position + BgpConst.BGP_RD_LEN);
            position += BgpConst.BGP_RD_LEN;
            const sessionRd = rdBufferToString(rdBuffer);

            let sessionAddress;
            if (sessionFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) {
                // IPv6 peer
                sessionAddress = ipv6BufferToString(message.subarray(position, position + 16), 128);
                position += 16;
            } else {
                // IPv4 peer
                // 12字节保留字段
                position += 12;
                sessionAddress = ipv4BufferToString(message.subarray(position, position + 4), 32);
                position += 4;
            }

            const sessionAs = message.readUInt32BE(position);
            position += 4;
            const _sessionRouterId = ipv4BufferToString(message.subarray(position, position + 4), 32);
            position += 4;
            const _sessionTimestamp = message.readUInt32BE(position);
            position += 4;
            const _sessionTimestampMs = message.readUInt32BE(position);
            position += 4;

            const _reason = message[position];
            position += 1;

            const ribTypes = this.getRibTypesByFlags(sessionFlags);
            if (ribTypes.length === 0) {
                logger.error(`Received BGP Update message from unknown rib type: ${sessionFlags}`);
                return;
            }

            let parsedBgpNotification = null;
            if (position + BgpConst.BGP_HEAD_LEN <= message.length) {
                // BGP notification message
                const bgpNotificationHeader = message.subarray(position, position + BgpConst.BGP_HEAD_LEN);
                const { length: notificationLength, type: _notificationType } =
                    this.parseBgpHeader(bgpNotificationHeader);
                const bgpNotification = message.subarray(position, position + notificationLength);
                parsedBgpNotification = parseBgpPacket(bgpNotification);
                if (!parsedBgpNotification.valid) {
                    logger.error(`Received BGP Notification message is invalid: ${parsedBgpNotification.error}`);
                }
            }

            const sessKey = BmpBgpSession.makeKey(sessionType, sessionRd, sessionAddress, sessionAs);
            const bgpSession = this.bgpSessionMap.get(sessKey);
            if (!bgpSession) {
                logger.error(`Received BGP Update message from unknown session: ${sessKey}`);
                return;
            }

            if (parsedBgpNotification) {
                // bgp断开
                bgpSession.closeSession();
                this.bgpSessionMap.delete(sessKey);
            } else {
                // 遍历rib类型
                for (const ribType of ribTypes) {
                    bgpSession.bgpRoutes.forEach(routeMap => {
                        if (routeMap.has(ribType)) {
                            routeMap.get(ribType).clear();
                        }
                    });
                }
            }

            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.SESSION_UPDATE, {
                data: {
                    client: this.getClientInfo()
                }
            });
        } catch (err) {
            logger.error(`Error processing peer down:`, err);
        }
    }

    processPeerDownLocalRib(message) {
        try {
            let position = 0;
            const _instanceType = message[position];
            position += 1;
            const instanceFlags = message[position];
            position += 1;
            const rdBuffer = message.subarray(position, position + BgpConst.BGP_RD_LEN);
            position += BgpConst.BGP_RD_LEN;
            const _instanceRd = rdBufferToString(rdBuffer);

            let _instanceAddress;
            if (instanceFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) {
                // IPv6 peer
                _instanceAddress = ipv6BufferToString(message.subarray(position, position + 16), 128);
                position += 16;
            } else {
                // IPv4 peer
                // 12字节保留字段
                position += 12;
                _instanceAddress = ipv4BufferToString(message.subarray(position, position + 4), 32);
                position += 4;
            }

            const _instanceAs = message.readUInt32BE(position);
            position += 4;
            const _instanceRouterId = ipv4BufferToString(message.subarray(position, position + 4), 32);
            position += 4;
            const _instanceTimestamp = message.readUInt32BE(position);
            position += 4;
            const _instanceTimestampMs = message.readUInt32BE(position);
            position += 4;

            const _reason = message[position];
            position += 1;

            let parsedBgpNotification = null;
            if (position + BgpConst.BGP_HEAD_LEN <= message.length) {
                // BGP notification message
                const bgpNotificationHeader = message.subarray(position, position + BgpConst.BGP_HEAD_LEN);
                const { length: notificationLength, type: _notificationType } =
                    this.parseBgpHeader(bgpNotificationHeader);
                const bgpNotification = message.subarray(position, position + notificationLength);
                parsedBgpNotification = parseBgpPacket(bgpNotification);
                if (!parsedBgpNotification.valid) {
                    logger.error(`Received BGP Notification message is invalid: ${parsedBgpNotification.error}`);
                }
            }

            // todo: loc-rib 无法识别down的实例
            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE, {
                data: {
                    client: this.getClientInfo()
                }
            });
        } catch (err) {
            logger.error(`Error processing peer down:`, err);
        }
    }

    processPeerDown(message) {
        let position = 0;
        const peerType = message[position];
        if (peerType === BmpConst.BMP_PEER_TYPE.GLOBAL) {
            this.processPeerDownGlobal(message);
        } else if (peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
            this.processPeerDownLocalRib(message);
        } else {
            logger.error(`Unknown peer type: ${peerType}`);
        }
    }

    processPeerUpGlobal(message) {
        try {
            let position = 0;
            const sessionType = message[position];
            position += 1;
            const sessionFlags = message[position];
            position += 1;
            const rdBuffer = message.subarray(position, position + BgpConst.BGP_RD_LEN);
            position += BgpConst.BGP_RD_LEN;
            const sessionRd = rdBufferToString(rdBuffer);

            let sessionAddress;
            if (sessionFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) {
                // IPv6 peer
                sessionAddress = ipv6BufferToString(message.subarray(position, position + 16), 128);
                position += 16;
            } else {
                // IPv4 peer
                // 12字节保留字段
                position += 12;
                sessionAddress = ipv4BufferToString(message.subarray(position, position + 4), 32);
                position += 4;
            }

            const sessionAs = message.readUInt32BE(position);
            position += 4;
            const sessionRouterId = ipv4BufferToString(message.subarray(position, position + 4), 32);
            position += 4;
            const sessionTimestamp = message.readUInt32BE(position);
            position += 4;
            const sessionTimestampMs = message.readUInt32BE(position);
            position += 4;

            let localAddress;
            if (sessionFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) {
                // IPv6 peer
                localAddress = ipv6BufferToString(message.subarray(position, position + 16), 128);
                position += 16;
            } else {
                // IPv4 peer
                // 12字节保留字段
                position += 12;
                localAddress = ipv4BufferToString(message.subarray(position, position + 4), 32);
                position += 4;
            }

            const localPort = message.readUInt16BE(position);
            position += 2;
            const remotePort = message.readUInt16BE(position);
            position += 2;

            let parsedRecvBgpOpen = null;
            let parsedSendBgpOpen = null;

            if (position + BgpConst.BGP_HEAD_LEN <= message.length) {
                // BGP recv Open message
                const bgpRecvOpenHeader = message.subarray(position, position + BgpConst.BGP_HEAD_LEN);
                const { length: recvOpenLength, type: _recvOpenType } = this.parseBgpHeader(bgpRecvOpenHeader);
                const bgpRecvOpen = message.subarray(position, position + recvOpenLength);
                parsedRecvBgpOpen = parseBgpPacket(bgpRecvOpen);
                if (!parsedRecvBgpOpen.valid) {
                    logger.error(`Received BGP Open message is invalid: ${parsedRecvBgpOpen.error}`);
                }
                position += recvOpenLength;
            }

            if (position + BgpConst.BGP_HEAD_LEN <= message.length) {
                // BGP send Open message
                const bgpSendOpenHeader = message.subarray(position, position + BgpConst.BGP_HEAD_LEN);
                const { length: sendOpenLength, type: _sendOpenType } = this.parseBgpHeader(bgpSendOpenHeader);
                const bgpSendOpen = message.subarray(position, position + sendOpenLength);
                parsedSendBgpOpen = parseBgpPacket(bgpSendOpen);
                if (!parsedSendBgpOpen.valid) {
                    logger.error(`Sent BGP Open message is invalid: ${parsedSendBgpOpen.error}`);
                }
                position += sendOpenLength;
            }

            // 识别是否需要ADD-PATH
            const recvAddPaths = new Map(); // afi|safi -> code
            if (parsedRecvBgpOpen && parsedRecvBgpOpen.capabilities) {
                parsedRecvBgpOpen.capabilities.forEach(cap => {
                    if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH) {
                        cap.addPaths.forEach(ap => {
                            const key = `${ap.afi}|${ap.safi}`;
                            recvAddPaths.set(key, ap.sendReceive);
                        });
                    }
                });
            }

            const sendAddPaths = new Map();
            if (parsedSendBgpOpen && parsedSendBgpOpen.capabilities) {
                parsedSendBgpOpen.capabilities.forEach(cap => {
                    if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH) {
                        cap.addPaths.forEach(ap => {
                            const key = `${ap.afi}|${ap.safi}`;
                            sendAddPaths.set(key, ap.sendReceive);
                        });
                    }
                });
            }

            // Extract enabled address families from capabilities
            const enabledAddressFamilies = [];
            const recvAddressFamilies = [];
            const sentAddressFamilies = [];

            // Process received BGP OPEN message capabilities
            if (parsedRecvBgpOpen && parsedRecvBgpOpen.capabilities) {
                parsedRecvBgpOpen.capabilities.forEach(capability => {
                    if (capability.code === BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS) {
                        recvAddressFamilies.push({
                            afi: capability.afi,
                            safi: capability.safi
                        });
                    }
                });
            }

            // Process sent BGP OPEN message capabilities
            if (parsedSendBgpOpen && parsedSendBgpOpen.capabilities) {
                parsedSendBgpOpen.capabilities.forEach(capability => {
                    if (capability.code === BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS) {
                        sentAddressFamilies.push({
                            afi: capability.afi,
                            safi: capability.safi
                        });
                    }
                });
            }

            // Only include address families that appear in both received and sent capabilities
            recvAddressFamilies.forEach(recvAF => {
                const matchingSentAF = sentAddressFamilies.find(
                    sentAF => sentAF.afi === recvAF.afi && sentAF.safi === recvAF.safi
                );

                if (matchingSentAF) {
                    enabledAddressFamilies.push(recvAF);
                }
            });

            const bgpSessionKey = BmpBgpSession.makeKey(sessionType, sessionRd, sessionAddress, sessionAs);
            let bgpSession = this.bgpSessionMap.get(bgpSessionKey);
            if (!bgpSession) {
                bgpSession = new BmpBgpSession(this);
                this.bgpSessionMap.set(bgpSessionKey, bgpSession);
            }

            this.mergeAddressFamilies(bgpSession.enabledAddressFamilies, enabledAddressFamilies);
            this.mergeAddressFamilies(bgpSession.recvAddressFamilies, recvAddressFamilies);
            this.mergeAddressFamilies(bgpSession.sendAddressFamilies, sentAddressFamilies);

            const allKeys = new Set([...recvAddPaths.keys(), ...sendAddPaths.keys()]);
            allKeys.forEach(key => {
                const recvMode = recvAddPaths.get(key); // Remote Peer's mode
                const sendMode = sendAddPaths.get(key); // Monitored Router's mode

                let receive = false; // Does Router receive Path IDs? (Peer Send)
                let send = false; // Does Router send Path IDs? (Peer Recv)

                // Peer Sends if mode is 1(Both) or 2(Send)
                // Router Receives if mode is 1(Both) or 3(Receive)
                // BGP_ADD_PATH_TYPE: SEND_RECEIVE=1, SEND_ONLY=2, RECEIVE_ONLY=3
                if (
                    (recvMode === BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE ||
                        recvMode === BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY) &&
                    (sendMode === BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE ||
                        sendMode === BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY)
                ) {
                    receive = true;
                }

                // Router Sends if mode is 1(Both) or 2(Send)
                // Peer Receives if mode is 1(Both) or 3(Receive)
                if (
                    (sendMode === BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE ||
                        sendMode === BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY) &&
                    (recvMode === BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE ||
                        recvMode === BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY)
                ) {
                    send = true;
                }

                if (receive && send) {
                    bgpSession.addPathMap.set(key, true);
                } else {
                    bgpSession.addPathMap.set(key, false);
                }
            });

            bgpSession.recvAddPathMap = recvAddPaths;
            bgpSession.sendAddPathMap = sendAddPaths;

            bgpSession.enabledAddressFamilies.forEach(addrFamily => {
                const afKey = `${addrFamily.afi}|${addrFamily.safi}`;
                if (!bgpSession.bgpRoutes.has(afKey)) {
                    bgpSession.bgpRoutes.set(afKey, new Map());
                }
            });

            bgpSession.sessionFlags = (bgpSession.sessionFlags || 0) | sessionFlags;

            // 考虑到不同厂商实现不同，此处不从报文中获取ribType，改为一次性全部创建出来
            const ribTypes = [
                BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
                BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
                BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT,
                BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT
            ];
            ribTypes.forEach(ribType => {
                if (!bgpSession.ribTypes.includes(ribType)) {
                    bgpSession.ribTypes.push(ribType);
                }
            });

            bgpSession.ribTypes.forEach(ribType => {
                bgpSession.bgpRoutes.forEach((routeMap, _afKey) => {
                    if (!routeMap.has(ribType)) {
                        routeMap.set(ribType, new Map());
                    }
                });
            });

            // 正常相同bgp Session这些字段一样
            bgpSession.sessionType = sessionType;
            bgpSession.sessionFlags = sessionFlags;
            bgpSession.sessionRd = sessionRd;
            bgpSession.sessionIp = sessionAddress;
            bgpSession.sessionAs = sessionAs;
            bgpSession.sessionRouterId = sessionRouterId;
            bgpSession.sessionTimestamp = sessionTimestamp;
            bgpSession.sessionTimestampMs = sessionTimestampMs;
            bgpSession.localIp = localAddress;
            bgpSession.localPort = localPort;
            bgpSession.remotePort = remotePort;
            bgpSession.sessionState = BmpConst.BMP_SESSION_STATE.PEER_UP;

            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.SESSION_UPDATE, {
                data: {
                    client: this.getClientInfo()
                }
            });
        } catch (err) {
            logger.error(`Error processing session up:`, err);
        }
    }

    processPeerUpLocalRib(message) {
        try {
            let position = 0;
            const instanceType = message[position];
            position += 1;
            const instanceFlags = message[position];
            position += 1;
            const rdBuffer = message.subarray(position, position + BgpConst.BGP_RD_LEN);
            position += BgpConst.BGP_RD_LEN;
            const instanceRd = rdBufferToString(rdBuffer);

            let instanceAddress;
            if (instanceFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) {
                // IPv6 peer
                instanceAddress = ipv6BufferToString(message.subarray(position, position + 16), 128);
                position += 16;
            } else {
                // IPv4 peer
                // 12字节保留字段
                position += 12;
                instanceAddress = ipv4BufferToString(message.subarray(position, position + 4), 32);
                position += 4;
            }

            const instanceAs = message.readUInt32BE(position);
            position += 4;
            const instanceRouterId = ipv4BufferToString(message.subarray(position, position + 4), 32);
            position += 4;
            const instanceTimestamp = message.readUInt32BE(position);
            position += 4;
            const instanceTimestampMs = message.readUInt32BE(position);
            position += 4;

            let localAddress;
            if (instanceFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) {
                // IPv6 peer
                localAddress = ipv6BufferToString(message.subarray(position, position + 16), 128);
                position += 16;
            } else {
                // IPv4 peer
                // 12字节保留字段
                position += 12;
                localAddress = ipv4BufferToString(message.subarray(position, position + 4), 32);
                position += 4;
            }

            const localPort = message.readUInt16BE(position);
            position += 2;
            const remotePort = message.readUInt16BE(position);
            position += 2;

            let parsedRecvBgpOpen = null;
            let parsedSendBgpOpen = null;

            if (position + BgpConst.BGP_HEAD_LEN <= message.length) {
                // BGP recv Open message
                const bgpRecvOpenHeader = message.subarray(position, position + BgpConst.BGP_HEAD_LEN);
                const { length: recvOpenLength, type: _recvOpenType } = this.parseBgpHeader(bgpRecvOpenHeader);
                const bgpRecvOpen = message.subarray(position, position + recvOpenLength);
                parsedRecvBgpOpen = parseBgpPacket(bgpRecvOpen);
                if (!parsedRecvBgpOpen.valid) {
                    logger.error(`Received BGP Open message is invalid: ${parsedRecvBgpOpen.error}`);
                }
                position += recvOpenLength;
            }

            if (position + BgpConst.BGP_HEAD_LEN <= message.length) {
                // BGP send Open message
                const bgpSendOpenHeader = message.subarray(position, position + BgpConst.BGP_HEAD_LEN);
                const { length: sendOpenLength, type: _sendOpenType } = this.parseBgpHeader(bgpSendOpenHeader);
                const bgpSendOpen = message.subarray(position, position + sendOpenLength);
                parsedSendBgpOpen = parseBgpPacket(bgpSendOpen);
                if (!parsedSendBgpOpen.valid) {
                    logger.error(`Sent BGP Open message is invalid: ${parsedSendBgpOpen.error}`);
                }
                position += sendOpenLength;
            }

            // 识别是否需要ADD-PATH
            const recvAddPaths = new Map(); // afi|safi -> code
            if (parsedRecvBgpOpen && parsedRecvBgpOpen.capabilities) {
                parsedRecvBgpOpen.capabilities.forEach(cap => {
                    if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH) {
                        cap.addPaths.forEach(ap => {
                            const key = `${ap.afi}|${ap.safi}`;
                            recvAddPaths.set(key, ap.sendReceive);
                        });
                    }
                });
            }

            const sendAddPaths = new Map();
            if (parsedSendBgpOpen && parsedSendBgpOpen.capabilities) {
                parsedSendBgpOpen.capabilities.forEach(cap => {
                    if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH) {
                        cap.addPaths.forEach(ap => {
                            const key = `${ap.afi}|${ap.safi}`;
                            sendAddPaths.set(key, ap.sendReceive);
                        });
                    }
                });
            }

            // Extract enabled address families from capabilities
            const enabledAddressFamilies = [];
            const recvAddressFamilies = [];
            const sentAddressFamilies = [];

            // Process received BGP OPEN message capabilities
            if (parsedRecvBgpOpen && parsedRecvBgpOpen.capabilities) {
                parsedRecvBgpOpen.capabilities.forEach(capability => {
                    if (capability.code === BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS) {
                        recvAddressFamilies.push({
                            afi: capability.afi,
                            safi: capability.safi
                        });
                    }
                });
            }

            // Process sent BGP OPEN message capabilities
            if (parsedSendBgpOpen && parsedSendBgpOpen.capabilities) {
                parsedSendBgpOpen.capabilities.forEach(capability => {
                    if (capability.code === BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS) {
                        sentAddressFamilies.push({
                            afi: capability.afi,
                            safi: capability.safi
                        });
                    }
                });
            }

            // Only include address families that appear in both received and sent capabilities
            recvAddressFamilies.forEach(recvAF => {
                const matchingSentAF = sentAddressFamilies.find(
                    sentAF => sentAF.afi === recvAF.afi && sentAF.safi === recvAF.safi
                );

                if (matchingSentAF) {
                    enabledAddressFamilies.push(recvAF);
                }
            });

            enabledAddressFamilies.forEach(enabledAF => {
                const instanceKey = BmpBgpInstance.makeKey(instanceType, instanceRd, enabledAF.afi, enabledAF.safi);
                let bgpInstance = this.bgpInstanceMap.get(instanceKey);
                if (!bgpInstance) {
                    bgpInstance = new BmpBgpInstance(this);
                    this.bgpInstanceMap.set(instanceKey, bgpInstance);
                }

                this.mergeAddressFamilies(bgpInstance.enabledAddressFamilies, enabledAddressFamilies);
                this.mergeAddressFamilies(bgpInstance.recvAddressFamilies, recvAddressFamilies);
                this.mergeAddressFamilies(bgpInstance.sendAddressFamilies, sentAddressFamilies);

                bgpInstance.recvAddPathMap = recvAddPaths;
                bgpInstance.sendAddPathMap = sendAddPaths;
                bgpInstance.afi = enabledAF.afi;
                bgpInstance.safi = enabledAF.safi;

                bgpInstance.instanceFlags = (bgpInstance.instanceFlags || 0) | instanceFlags;

                const ribTypes = this.getRibTypesByFlags(instanceFlags);
                ribTypes.forEach(ribType => {
                    if (!bgpInstance.ribTypes.includes(ribType)) {
                        bgpInstance.ribTypes.push(ribType);
                    }
                });

                // 正常相同bgp Session这些字段一样
                bgpInstance.instanceType = instanceType;
                bgpInstance.instanceFlags = instanceFlags;
                bgpInstance.instanceRd = instanceRd;
                bgpInstance.instanceIp = instanceAddress;
                bgpInstance.instanceAs = instanceAs;
                bgpInstance.instanceRouterId = instanceRouterId;
                bgpInstance.instanceTimestamp = instanceTimestamp;
                bgpInstance.instanceTimestampMs = instanceTimestampMs;
                bgpInstance.localIp = localAddress;
                bgpInstance.localPort = localPort;
                bgpInstance.remotePort = remotePort;
                bgpInstance.instanceState = BmpConst.BMP_SESSION_STATE.PEER_UP;
            });

            const allKeys = new Set([...recvAddPaths.keys(), ...sendAddPaths.keys()]);
            allKeys.forEach(key => {
                const recvMode = recvAddPaths.get(key); // Remote Peer's mode
                const sendMode = sendAddPaths.get(key); // Monitored Router's mode

                let receive = false; // Does Router receive Path IDs? (Peer Send)
                let send = false; // Does Router send Path IDs? (Peer Recv)

                // Peer Sends if mode is 1(Both) or 2(Send)
                // Router Receives if mode is 1(Both) or 3(Receive)
                // BGP_ADD_PATH_TYPE: SEND_RECEIVE=1, SEND_ONLY=2, RECEIVE_ONLY=3
                if (
                    (recvMode === BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE ||
                        recvMode === BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY) &&
                    (sendMode === BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE ||
                        sendMode === BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY)
                ) {
                    receive = true;
                }

                // Router Sends if mode is 1(Both) or 2(Send)
                // Peer Receives if mode is 1(Both) or 3(Receive)
                if (
                    (sendMode === BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE ||
                        sendMode === BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY) &&
                    (recvMode === BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE ||
                        recvMode === BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY)
                ) {
                    send = true;
                }

                const [afi, safi] = key.split('|');
                const instanceKey = BmpBgpInstance.makeKey(instanceType, instanceRd, afi, safi);
                const bgpInstance = this.bgpInstanceMap.get(instanceKey);
                if (!bgpInstance) {
                    logger.error(`Instance not found for key: ${instanceKey}`);
                    return;
                }

                if (receive && send) {
                    this.instAddPathMap.set(key, true);
                    bgpInstance.isAddPath = true;
                } else {
                    this.instAddPathMap.set(key, false);
                    bgpInstance.isAddPath = false;
                }
            });

            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE, {
                data: {
                    client: this.getClientInfo()
                }
            });
        } catch (err) {
            logger.error(`Error processing session up:`, err);
        }
    }

    processPeerUp(message) {
        let position = 0;

        const sessionType = message[position];

        if (sessionType === BmpConst.BMP_PEER_TYPE.GLOBAL) {
            this.processPeerUpGlobal(message);
        } else if (sessionType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
            this.processPeerUpLocalRib(message);
        } else {
            logger.error(`Unknown session type: ${sessionType}`);
        }
    }

    processTermination(_message) {
        const clientInfo = this.getClientInfo();
        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.TERMINATION, { data: clientInfo });
        this.closeSession();

        const key = BmpSession.makeKey(this.localIp, this.localPort, this.remoteIp, this.remotePort);
        this.bmpWorker.bmpSessionMap.delete(key);
    }

    processStatisticsReportGlobal(message) {
        try {
            let position = 0;
            const sessionType = message[position];
            position += 1;
            const sessionFlags = message[position];
            position += 1;
            const rdBuffer = message.subarray(position, position + BgpConst.BGP_RD_LEN);
            position += BgpConst.BGP_RD_LEN;
            const sessionRd = rdBufferToString(rdBuffer);

            let sessionAddress;
            if (sessionFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) {
                sessionAddress = ipv6BufferToString(message.subarray(position, position + 16), 128);
                position += 16;
            } else {
                position += 12;
                sessionAddress = ipv4BufferToString(message.subarray(position, position + 4), 32);
                position += 4;
            }

            const sessionAs = message.readUInt32BE(position);
            position += 4;
            position += 4; // sessionRouterId
            position += 4; // sessionTimestamp
            position += 4; // sessionTimestampMs

            const statsCount = message.readUInt32BE(position);
            position += 4;

            const statistics = [];
            for (let i = 0; i < statsCount; i++) {
                if (position + 4 > message.length) break;

                const statType = message.readUInt16BE(position);
                position += 2;
                const statLength = message.readUInt16BE(position);
                position += 2;

                if (position + statLength > message.length) break;

                let statValue;
                if (statLength === 4) {
                    statValue = message.readUInt32BE(position);
                } else if (statLength === 8) {
                    statValue = Number(message.readBigUInt64BE(position));
                } else {
                    statValue = 0;
                }
                position += statLength;

                statistics.push({
                    type: statType,
                    value: statValue,
                    typeName: BmpConst.BMP_STATS_TYPE_NAME[statType] || `Unknown (${statType})`
                });
            }

            const bgpSessionKey = BmpBgpSession.makeKey(sessionType, sessionRd, sessionAddress, sessionAs);
            const bgpSession = this.bgpSessionMap.get(bgpSessionKey);

            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT, {
                data: {
                    client: this.getClientInfo(),
                    session: bgpSession ? bgpSession.getSessionInfo() : null,
                    statistics: statistics
                }
            });
        } catch (err) {
            logger.error(`Error processing statistics report (global):`, err);
        }
    }

    processStatisticsReportLocalRib(message) {
        try {
            let position = 0;
            const instanceType = message[position];
            position += 1;
            const instanceFlags = message[position];
            position += 1;
            const rdBuffer = message.subarray(position, position + BgpConst.BGP_RD_LEN);
            position += BgpConst.BGP_RD_LEN;
            const instanceRd = rdBufferToString(rdBuffer);

            if (instanceFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) {
                position += 16;
            } else {
                position += 12;
                position += 4;
            }

            position += 4; // instanceAs
            position += 4; // instanceRouterId
            position += 4; // instanceTimestamp
            position += 4; // instanceTimestampMs

            const statsCount = message.readUInt32BE(position);
            position += 4;

            const statistics = [];
            for (let i = 0; i < statsCount; i++) {
                if (position + 4 > message.length) break;

                const statType = message.readUInt16BE(position);
                position += 2;
                const statLength = message.readUInt16BE(position);
                position += 2;

                if (position + statLength > message.length) break;

                let statValue;
                if (statLength === 4) {
                    statValue = message.readUInt32BE(position);
                } else if (statLength === 8) {
                    statValue = Number(message.readBigUInt64BE(position));
                } else {
                    statValue = 0;
                }
                position += statLength;

                statistics.push({
                    type: statType,
                    value: statValue,
                    typeName: BmpConst.BMP_STATS_TYPE_NAME[statType] || `Unknown (${statType})`
                });
            }

            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT, {
                data: {
                    client: this.getClientInfo(),
                    instance: { instanceType, instanceRd },
                    statistics: statistics
                }
            });
        } catch (err) {
            logger.error(`Error processing statistics report (local rib):`, err);
        }
    }

    processStatisticsReport(message) {
        const peerType = message[0];
        if (peerType === BmpConst.BMP_PEER_TYPE.GLOBAL) {
            this.processStatisticsReportGlobal(message);
        } else if (peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
            this.processStatisticsReportLocalRib(message);
        } else {
            logger.error(`Unknown peer type in statistics report: ${peerType}`);
        }
    }

    processMessage(message) {
        try {
            const clientAddress = `${this.remoteIp}:${this.remotePort}`;

            const _version = message[0];
            const length = message.readUInt32BE(1);
            const type = message[5];

            logger.info(
                `Received message type ${BmpConst.BMP_MSG_TYPE_NAME[type]} from ${clientAddress}, length ${length}`
            );

            const msg = message.slice(BmpConst.BMP_HEADER_LENGTH, length);

            switch (type) {
                case BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING:
                    this.processRouteMonitoring(msg);
                    break;
                case BmpConst.BMP_MSG_TYPE.PEER_DOWN_NOTIFICATION:
                    this.processPeerDown(msg);
                    break;
                case BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION:
                    this.processPeerUp(msg);
                    break;
                case BmpConst.BMP_MSG_TYPE.INITIATION:
                    this.processInitiation(msg);
                    break;
                case BmpConst.BMP_MSG_TYPE.TERMINATION:
                    this.processTermination(msg);
                    break;
                case BmpConst.BMP_MSG_TYPE.STATISTICS_REPORT:
                    this.processStatisticsReport(msg);
                    break;
                default:
                    logger.warn(`Unknown message type: ${type}`);
            }
        } catch (err) {
            logger.error(`Error processing message:`, err);
        }
    }

    recvMsg(buffer) {
        this.messageBuffer = Buffer.concat([this.messageBuffer, buffer]);
        this.processBufferedMessages();
    }

    processBufferedMessages() {
        while (this.messageBuffer.length >= BmpConst.BMP_HEADER_LENGTH) {
            const messageLength = this.messageBuffer.readUInt32BE(1);
            if (this.messageBuffer.length < messageLength) {
                logger.info(
                    `Waiting for more data. Have ${this.messageBuffer.length} bytes, need ${messageLength} bytes`
                );
                break;
            }

            const completeMessage = this.messageBuffer.subarray(0, messageLength);
            this.messageBuffer = this.messageBuffer.subarray(messageLength);
            this.processMessage(completeMessage);
        }
    }

    closeSession() {
        // Close direct socket if exists
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }

        this.bgpSessionMap.forEach((peer, _) => {
            peer.closeSession();
        });

        this.bgpSessionMap.clear();
        this.instAddPathMap.clear();
        this.bgpInstanceMap.clear();
    }
}

module.exports = BmpSession;
