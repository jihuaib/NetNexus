const logger = require('../log/logger');
const BmpConst = require('../const/bmpConst');
const {
    getInitiationTlvName,
    parseCommonHeader,
    parsePeerHeader,
    parseBmpTlvs,
    toSerializableTlvs,
    getEffectivePeerFlags,
    parseStatsRecords
} = require('../utils/bmpUtils');
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
        this.bmpVersion = null;
        this.terminationTlvs = [];

        this.bgpSessionMap = new Map();
        this.bgpInstanceMap = new Map();
        this.instAddPathMap = new Map();
        this.instAddPathReceiveMap = new Map();
        this.instAddPathSendMap = new Map();
        this.messageBuffer = Buffer.alloc(0);
    }

    static makeKey(localIp, localPort, remoteIp, remotePort) {
        return `${localIp}|${localPort}|${remoteIp}|${remotePort}`;
    }

    static parseKey(key) {
        const [localIp, localPort, remoteIp, remotePort] = key.split('|');
        return { localIp, localPort, remoteIp, remotePort };
    }

    isAddPathReceiveEnabled(afi, safi, direction = 'receive') {
        const key = `${afi}|${safi}`;
        if (direction === 'send') {
            return this.instAddPathSendMap.get(key) === true;
        }
        if (direction === 'any') {
            return (
                this.instAddPathReceiveMap.get(key) === true ||
                this.instAddPathSendMap.get(key) === true ||
                this.instAddPathMap.get(key) === true
            );
        }
        if (this.instAddPathReceiveMap.has(key)) {
            return this.instAddPathReceiveMap.get(key) === true;
        }
        if (this.instAddPathMap.has(key)) {
            return this.instAddPathMap.get(key) === true;
        }
        return false;
    }

    canReceiveAddPath(mode) {
        return mode === BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY || mode === BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE;
    }

    canSendAddPath(mode) {
        return mode === BgpConst.BGP_ADD_PATH_TYPE.SEND_ONLY || mode === BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE;
    }

    canRouterReceiveAddPath(remoteMode, routerMode) {
        return this.canSendAddPath(remoteMode) && this.canReceiveAddPath(routerMode);
    }

    canRouterSendAddPath(remoteMode, routerMode) {
        return this.canSendAddPath(routerMode) && this.canReceiveAddPath(remoteMode);
    }

    getAddPathParsingDirection(peerType, peerFlags) {
        if (peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
            return 'any';
        }
        return (peerFlags & BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT) !== 0 ? 'send' : 'receive';
    }

    logTlvWarnings(context, warnings) {
        if (!Array.isArray(warnings)) {
            return;
        }
        warnings.forEach(warning => logger.warn(`${context}: ${warning}`));
    }

    getBmpV4TlvDraft() {
        return Number(this.bmpWorker?.bmpConfigData?.bmpV4TlvDraft) === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
            ? BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
            : BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20;
    }

    getRouteMonitoringTlvTypes() {
        return this.getBmpV4TlvDraft() === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
            ? BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE_LEGACY
            : BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE;
    }

    isBmpV4TlvDraft20() {
        return this.getBmpV4TlvDraft() === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20;
    }

    isRouteMonitoringBgpMessageTlv(tlv) {
        if (tlv.enterprise || (tlv.index !== 0 && tlv.index !== null)) {
            return false;
        }

        return tlv.type === this.getRouteMonitoringTlvTypes().BGP_MESSAGE;
    }

    isRouteMonitoringStatelessParsingTlv(tlv) {
        if (tlv.enterprise || !Buffer.isBuffer(tlv.value)) {
            return false;
        }

        return tlv.type === this.getRouteMonitoringTlvTypes().STATELESS_PARSING;
    }

    isTextTlvValue(value) {
        if (!Buffer.isBuffer(value) || value.length === 0 || value.length > 255) {
            return false;
        }

        return value.every(byte => byte >= 0x20 && byte !== 0x7f);
    }

    isVrfTableNameTlv(tlv) {
        if (tlv.enterprise || !Buffer.isBuffer(tlv.value)) {
            return false;
        }

        if (tlv.index !== null && tlv.index !== undefined) {
            return tlv.type === this.getRouteMonitoringTlvTypes().VRF_TABLE_NAME;
        }

        return (
            tlv.type === BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME &&
            this.isTextTlvValue(tlv.value)
        );
    }

    decodeStatelessParsingTlvs(tlvs) {
        const addPathMap = new Map();
        if (!Array.isArray(tlvs)) {
            return addPathMap;
        }

        tlvs.forEach(tlv => {
            if (!this.isRouteMonitoringStatelessParsingTlv(tlv)) {
                return;
            }

            tlv.name = 'Stateless Parsing';
            tlv.decoded = { capabilities: [] };
            let position = 0;
            while (position + 2 <= tlv.value.length) {
                const capCode = tlv.value[position];
                position += 1;
                const capLength = tlv.value[position];
                position += 1;

                if (position + capLength > tlv.value.length) {
                    logger.warn(`Stateless Parsing TLV capability ${capCode} is truncated`);
                    break;
                }

                const capValue = tlv.value.subarray(position, position + capLength);
                position += capLength;
                const capability = {
                    code: capCode,
                    length: capLength,
                    valueHex: capValue.toString('hex')
                };

                if (capCode === BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH) {
                    capability.addPaths = [];
                    let capPosition = 0;
                    while (capPosition + 4 <= capValue.length) {
                        const afi = capValue.readUInt16BE(capPosition);
                        capPosition += 2;
                        const safi = capValue[capPosition];
                        capPosition += 1;
                        const sendReceive = capValue[capPosition];
                        capPosition += 1;

                        capability.addPaths.push({ afi, safi, sendReceive });
                        addPathMap.set(`${afi}|${safi}`, sendReceive);
                    }
                }

                tlv.decoded.capabilities.push(capability);
            }
        });

        return addPathMap;
    }

    createBgpParsingContext(tlvs, fallbackContext, direction = 'receive') {
        const statelessAddPathMap = this.decodeStatelessParsingTlvs(tlvs);
        if (statelessAddPathMap.size === 0) {
            if (!fallbackContext || typeof fallbackContext.isAddPathReceiveEnabled !== 'function') {
                return fallbackContext;
            }
            return {
                isAddPathReceiveEnabled: (afi, safi) => fallbackContext.isAddPathReceiveEnabled(afi, safi, direction)
            };
        }

        return {
            isAddPathReceiveEnabled: (afi, safi) => {
                const key = `${afi}|${safi}`;
                if (statelessAddPathMap.has(key)) {
                    return statelessAddPathMap.get(key) !== 0;
                }
                if (fallbackContext && typeof fallbackContext.isAddPathReceiveEnabled === 'function') {
                    return fallbackContext.isAddPathReceiveEnabled(afi, safi, direction);
                }
                return false;
            }
        };
    }

    decodeVrfTableNameTlvs(tlvs) {
        if (!Array.isArray(tlvs)) {
            return [];
        }

        return tlvs
            .filter(tlv => this.isVrfTableNameTlv(tlv))
            .map(tlv => {
                tlv.name = 'VRF/Table Name';
                tlv.valueText = tlv.value.toString('utf8');
                return tlv.valueText;
            });
    }

    getOrCreateLocRibInstance(peer, afi, safi, options = {}) {
        const instanceKey = BmpBgpInstance.makeKey(peer.peerType, peer.peerRd, afi, safi);
        let bgpInstance = this.bgpInstanceMap.get(instanceKey);
        if (!bgpInstance) {
            bgpInstance = new BmpBgpInstance(this);
            this.bgpInstanceMap.set(instanceKey, bgpInstance);
        }

        const addrFamily = { afi, safi };
        this.mergeAddressFamilies(bgpInstance.enabledAddressFamilies, [addrFamily]);
        if (!bgpInstance.afi) {
            bgpInstance.afi = afi;
            bgpInstance.safi = safi;
        }

        bgpInstance.instanceType = peer.peerType;
        bgpInstance.instanceFlags = peer.peerFlags;
        bgpInstance.rawInstanceFlags = peer.peerFlags;
        bgpInstance.instanceRd = peer.peerRd;
        bgpInstance.instanceIp = peer.peerAddress;
        bgpInstance.instanceAs = peer.peerAs;
        bgpInstance.instanceRouterId = peer.peerRouterId;
        bgpInstance.instanceTimestamp = peer.peerTimestamp;
        bgpInstance.instanceTimestampMs = peer.peerTimestampMs;
        bgpInstance.localIp = options.localAddress || bgpInstance.localIp || '0.0.0.0';
        bgpInstance.localPort = options.localPort || bgpInstance.localPort || 0;
        bgpInstance.remotePort = options.remotePort || bgpInstance.remotePort || 0;
        bgpInstance.instanceState = BmpConst.BMP_SESSION_STATE.PEER_UP;

        if (Array.isArray(options.peerUpTlvs)) {
            bgpInstance.peerUpTlvs = options.peerUpTlvs;
        }
        if (Array.isArray(options.routeTlvs)) {
            bgpInstance.lastRouteMonitoringTlvs = options.routeTlvs;
        }

        const vrfTableNames = [
            ...this.decodeVrfTableNameTlvs(options.peerUpTlvs),
            ...this.decodeVrfTableNameTlvs(options.routeTlvs)
        ];
        if (vrfTableNames.length > 0) {
            bgpInstance.vrfTableNames = Array.from(new Set([...(bgpInstance.vrfTableNames || []), ...vrfTableNames]));
        } else if (!bgpInstance.vrfTableNames || bgpInstance.vrfTableNames.length === 0) {
            bgpInstance.vrfTableNames = peer.peerRd === '0:0' ? ['global'] : [];
        }

        return bgpInstance;
    }

    parseEmbeddedBgpPacket(message, position, context, label) {
        if (position + BgpConst.BGP_HEAD_LEN > message.length) {
            return {
                error: `${label} header is truncated`
            };
        }

        const bgpHeader = this.parseBgpHeader(message.subarray(position, position + BgpConst.BGP_HEAD_LEN));
        if (!bgpHeader || bgpHeader.length < BgpConst.BGP_HEAD_LEN) {
            return {
                error: `${label} has invalid header`
            };
        }

        if (position + bgpHeader.length > message.length) {
            return {
                error: `${label} length ${bgpHeader.length} exceeds remaining bytes`
            };
        }

        const packet = message.subarray(position, position + bgpHeader.length);
        const parsed = parseBgpPacket(packet, context);
        if (!parsed.valid) {
            logger.error(`${label} is invalid: ${parsed.error}`);
        }

        return {
            packet,
            parsed,
            length: bgpHeader.length,
            type: bgpHeader.type
        };
    }

    parseRouteMonitoringBgpUpdate(message, position, version, context, peerFlags = 0, peerType = null) {
        if (version === BmpConst.BMP_VERSION.V4) {
            const tlvResult = parseBmpTlvs(message, position, { indexed: true });
            this.logTlvWarnings('Route Monitoring TLV', tlvResult.warnings);

            const routeTlvs = tlvResult.tlvs;
            const bgpMessageTlv = routeTlvs.find(tlv => this.isRouteMonitoringBgpMessageTlv(tlv));

            if (!bgpMessageTlv) {
                return {
                    error: 'BMPv4 Route Monitoring message does not contain mandatory BGP Message TLV',
                    routeTlvs
                };
            }

            bgpMessageTlv.name = 'BGP Message';
            const effectivePeerFlags =
                this.isBmpV4TlvDraft20() ? getEffectivePeerFlags(peerFlags, routeTlvs) : peerFlags;
            const bgpContext = this.createBgpParsingContext(
                routeTlvs,
                context,
                this.getAddPathParsingDirection(peerType, effectivePeerFlags)
            );
            const parsed = parseBgpPacket(bgpMessageTlv.value, bgpContext);
            if (!parsed.valid) {
                logger.error(`Received BMPv4 BGP Update message is invalid: ${parsed.error}`);
            }

            return {
                parsedBgpUpdate: parsed,
                bgpUpdate: bgpMessageTlv.value,
                routeTlvs
            };
        }

        const bgpContext = this.createBgpParsingContext(
            [],
            context,
            this.getAddPathParsingDirection(peerType, peerFlags)
        );
        const embedded = this.parseEmbeddedBgpPacket(message, position, bgpContext, 'BGP Update message');
        if (embedded.error) {
            return embedded;
        }

        return {
            parsedBgpUpdate: embedded.parsed,
            bgpUpdate: embedded.packet,
            routeTlvs: []
        };
    }

    parsePeerDownPayload(message, position, reason, version) {
        const result = {
            parsedBgpNotification: null,
            fsmEventCode: null,
            tlvs: []
        };

        if (
            reason === BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_NOTIFICATION ||
            reason === BmpConst.BMP_PEER_DOWN_REASON.REMOTE_SYSTEM_CLOSED_WITH_NOTIFICATION
        ) {
            const embedded = this.parseEmbeddedBgpPacket(message, position, null, 'BGP Notification message');
            if (!embedded.error) {
                result.parsedBgpNotification = embedded.parsed;
                position += embedded.length;
            } else {
                logger.warn(`Peer Down: ${embedded.error}`);
            }
        } else if (reason === BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_NO_NOTIFICATION) {
            if (position + 2 <= message.length) {
                result.fsmEventCode = message.readUInt16BE(position);
                position += 2;
            } else {
                logger.warn('Peer Down: FSM event code is truncated');
            }
        }

        if (version === BmpConst.BMP_VERSION.V4 || reason === BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_TLV) {
            const tlvResult = parseBmpTlvs(message, position);
            this.logTlvWarnings('Peer Down TLV', tlvResult.warnings);
            result.tlvs = tlvResult.tlvs;
        }

        return result;
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
        const postPolicy = (sessionFlags & BmpConst.BMP_SESSION_FLAGS.POST_POLICY) !== 0;
        const adjRibOut = (sessionFlags & BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT) !== 0;
        const asPath = (sessionFlags & BmpConst.BMP_SESSION_FLAGS.AS_PATH) !== 0;

        if (adjRibOut) {
            return [
                postPolicy ? BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT : BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT
            ];
        }

        if (asPath) {
            return [BmpConst.BMP_BGP_RIB_TYPE.AS_PATH];
        }

        return [postPolicy ? BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN : BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN];
    }

    processRouteMonitoringGlobal(message, version = BmpConst.BMP_VERSION.V3) {
        try {
            let position = 0;
            const peerHeader = parsePeerHeader(message, position);
            if (!peerHeader.valid) {
                logger.error(peerHeader.error);
                return;
            }
            position = peerHeader.offset;
            const {
                peerType: sessionType,
                peerFlags: sessionFlags,
                peerRd: sessionRd,
                peerAddress: sessionAddress,
                peerAs: sessionAs
            } = peerHeader.peer;

            const bgpSessionKey = BmpBgpSession.makeKey(sessionType, sessionRd, sessionAddress, sessionAs);
            const bgpSession = this.bgpSessionMap.get(bgpSessionKey);
            if (!bgpSession) {
                logger.error(`Received BGP Update message from unknown session: ${bgpSessionKey}`);
                return;
            }

            const routePayload = this.parseRouteMonitoringBgpUpdate(
                message,
                position,
                version,
                bgpSession,
                sessionFlags,
                sessionType
            );
            if (routePayload.error) {
                logger.error(routePayload.error);
                return;
            }
            const parsedBgpUpdate = routePayload.parsedBgpUpdate;
            const effectiveSessionFlags =
                version === BmpConst.BMP_VERSION.V4 && this.isBmpV4TlvDraft20()
                    ? getEffectivePeerFlags(sessionFlags, routePayload.routeTlvs)
                    : sessionFlags;
            bgpSession.lastRouteMonitoringTlvs = routePayload.routeTlvs || [];

            if (!parsedBgpUpdate.valid) {
                logger.error(`Received BGP Update message is invalid: ${parsedBgpUpdate.error}`);
            }

            let isNotify = false;
            const ribTypes = this.getRibTypesByFlags(effectiveSessionFlags);
            if (ribTypes.length === 0) {
                logger.error(`Received BGP Update message from unknown rib type: ${effectiveSessionFlags}`);
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

    processRouteMonitoringLocalRib(message, version = BmpConst.BMP_VERSION.V3) {
        try {
            let position = 0;
            const peerHeader = parsePeerHeader(message, position);
            if (!peerHeader.valid) {
                logger.error(peerHeader.error);
                return;
            }
            position = peerHeader.offset;
            const locRibPeer = peerHeader.peer;

            const routePayload = this.parseRouteMonitoringBgpUpdate(
                message,
                position,
                version,
                this,
                locRibPeer.peerFlags,
                locRibPeer.peerType
            );
            if (routePayload.error) {
                logger.error(routePayload.error);
                return;
            }
            const parsedBgpUpdate = routePayload.parsedBgpUpdate;

            if (!parsedBgpUpdate.valid) {
                logger.error(`Received BGP Update message is invalid: ${parsedBgpUpdate.error}`);
            }

            let isNotify = false;
            // 处理withdrawn routes (IPv4)
            if (parsedBgpUpdate.withdrawnRoutes && parsedBgpUpdate.withdrawnRoutes.length > 0) {
                const bgpInstance = this.getOrCreateLocRibInstance(
                    locRibPeer,
                    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                    { routeTlvs: routePayload.routeTlvs }
                );

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
                const bgpInstance = this.getOrCreateLocRibInstance(locRibPeer, mpUnreachNlri.afi, mpUnreachNlri.safi, {
                    routeTlvs: routePayload.routeTlvs
                });

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
                const bgpInstance = this.getOrCreateLocRibInstance(
                    locRibPeer,
                    BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                    { routeTlvs: routePayload.routeTlvs }
                );

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
                const bgpInstance = this.getOrCreateLocRibInstance(locRibPeer, mpReachNlri.afi, mpReachNlri.safi, {
                    routeTlvs: routePayload.routeTlvs
                });

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

    processRouteMonitoring(message, version = BmpConst.BMP_VERSION.V3) {
        let position = 0;
        const sessionType = message[position];

        if (
            sessionType === BmpConst.BMP_PEER_TYPE.GLOBAL ||
            sessionType === BmpConst.BMP_PEER_TYPE.L3VPN ||
            sessionType === BmpConst.BMP_PEER_TYPE.LOCAL
        ) {
            this.processRouteMonitoringGlobal(message, version);
        } else if (sessionType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
            this.processRouteMonitoringLocalRib(message, version);
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

    clearSessionAddPathByAddressFamilies(bgpSession, addressFamilies) {
        if (!bgpSession || !Array.isArray(addressFamilies)) {
            return;
        }

        addressFamilies.forEach(addrFamily => {
            const key = `${addrFamily.afi}|${addrFamily.safi}`;
            bgpSession.recvAddPathMap.delete(key);
            bgpSession.sendAddPathMap.delete(key);
            bgpSession.addPathReceiveMap.delete(key);
            bgpSession.addPathSendMap.delete(key);
            bgpSession.addPathMap.delete(key);
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
            bmpVersion: this.bmpVersion,
            bmpV4TlvDraft: this.getBmpV4TlvDraft(),
            rawTlvs: toSerializableTlvs(this.tlvs),
            terminationTlvs: toSerializableTlvs(this.terminationTlvs),
            receivedAt: this.receivedAt
        };
    }

    processInitiation(message) {
        try {
            this.tlvs = [];
            const tlvResult = parseBmpTlvs(message);
            this.logTlvWarnings('Initiation TLV', tlvResult.warnings);
            this.tlvs = tlvResult.tlvs;

            // 提取已知的TLV类型
            this.sysName = '';
            this.sysDesc = '';

            for (const tlv of this.tlvs) {
                tlv.name = getInitiationTlvName(tlv.type);
                switch (tlv.type) {
                    case BmpConst.BMP_INITIATION_TLV_TYPE.SYS_NAME: // sysName
                        if (!tlv.enterprise) {
                            tlv.valueText = tlv.value.toString('utf8');
                            this.sysName = tlv.valueText;
                        }
                        break;
                    case BmpConst.BMP_INITIATION_TLV_TYPE.SYS_DESC: // sysDesc
                        if (!tlv.enterprise) {
                            tlv.valueText = tlv.value.toString('utf8');
                            this.sysDesc = tlv.valueText;
                        }
                        break;
                    default:
                        break;
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

    processPeerDownGlobal(message, version = BmpConst.BMP_VERSION.V3) {
        try {
            let position = 0;
            const peerHeader = parsePeerHeader(message, position);
            if (!peerHeader.valid) {
                logger.error(peerHeader.error);
                return;
            }
            position = peerHeader.offset;
            const {
                peerType: sessionType,
                peerFlags: sessionFlags,
                peerRd: sessionRd,
                peerAddress: sessionAddress,
                peerAs: sessionAs
            } = peerHeader.peer;

            const reason = message[position];
            position += 1;
            const peerDownPayload = this.parsePeerDownPayload(message, position, reason, version);
            const effectiveSessionFlags =
                version === BmpConst.BMP_VERSION.V4 && this.isBmpV4TlvDraft20()
                    ? getEffectivePeerFlags(sessionFlags, peerDownPayload.tlvs)
                    : sessionFlags;

            const ribTypes = this.getRibTypesByFlags(effectiveSessionFlags);
            if (ribTypes.length === 0) {
                logger.error(`Received BGP Update message from unknown rib type: ${effectiveSessionFlags}`);
                return;
            }

            const sessKey = BmpBgpSession.makeKey(sessionType, sessionRd, sessionAddress, sessionAs);
            const bgpSession = this.bgpSessionMap.get(sessKey);
            if (!bgpSession) {
                logger.error(`Received BGP Update message from unknown session: ${sessKey}`);
                return;
            }

            bgpSession.peerDownReason = reason;
            bgpSession.peerDownTlvs = peerDownPayload.tlvs;
            bgpSession.peerDownFsmEventCode = peerDownPayload.fsmEventCode;

            const addressFamilyKeys = Array.from(
                new Set([
                    ...bgpSession.enabledAddressFamilies.map(addrFamily => `${addrFamily.afi}|${addrFamily.safi}`),
                    ...bgpSession.bgpRoutes.keys()
                ])
            );

            if (peerDownPayload.parsedBgpNotification) {
                // BGP Notification means the monitored BGP peer is down, not an AF-only BMP config refresh.
                bgpSession.closeSession();
                this.bgpSessionMap.delete(sessKey);
            } else {
                if (addressFamilyKeys.length === 1) {
                    const ribTypeRouteMap = bgpSession.bgpRoutes.get(addressFamilyKeys[0]);
                    if (ribTypeRouteMap) {
                        for (const ribType of ribTypes) {
                            if (ribTypeRouteMap.has(ribType)) {
                                ribTypeRouteMap.get(ribType).clear();
                            }
                        }
                    }
                } else if (addressFamilyKeys.length > 1) {
                    logger.info(
                        `Peer Down matched ${addressFamilyKeys.length} address families for ${sessKey}; keeping routes until AF-specific Peer Up refresh or withdraw`
                    );
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

    processPeerDownLocalRib(message, version = BmpConst.BMP_VERSION.V3) {
        try {
            let position = 0;
            const peerHeader = parsePeerHeader(message, position);
            if (!peerHeader.valid) {
                logger.error(peerHeader.error);
                return;
            }
            position = peerHeader.offset;
            const { peerType: instanceType, peerRd: instanceRd } = peerHeader.peer;

            const reason = message[position];
            position += 1;
            const peerDownPayload = this.parsePeerDownPayload(message, position, reason, version);
            const peerDownVrfTableNames = this.decodeVrfTableNameTlvs(peerDownPayload.tlvs);

            const prefix = `${instanceType}|${instanceRd}|`;
            const candidates = [];
            this.bgpInstanceMap.forEach((instance, key) => {
                if (!key.startsWith(prefix)) {
                    return;
                }

                if (peerDownVrfTableNames.length > 0) {
                    const instanceVrfTableNames =
                        Array.isArray(instance.vrfTableNames) && instance.vrfTableNames.length > 0
                            ? instance.vrfTableNames
                            : instanceRd === '0:0'
                              ? ['global']
                              : [];
                    if (!peerDownVrfTableNames.some(name => instanceVrfTableNames.includes(name))) {
                        return;
                    }
                }

                candidates.push({ instance, key });
            });

            if (candidates.length === 1) {
                candidates[0].instance.closeInstance();
                this.bgpInstanceMap.delete(candidates[0].key);
            } else if (candidates.length > 1) {
                logger.info(
                    `Loc-RIB Peer Down matched ${candidates.length} address families for ${prefix}; keeping routes until AF-specific Peer Up refresh`
                );
            }

            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE, {
                data: {
                    client: this.getClientInfo()
                }
            });
        } catch (err) {
            logger.error(`Error processing peer down:`, err);
        }
    }

    processPeerDown(message, version = BmpConst.BMP_VERSION.V3) {
        let position = 0;
        const peerType = message[position];
        if (
            peerType === BmpConst.BMP_PEER_TYPE.GLOBAL ||
            peerType === BmpConst.BMP_PEER_TYPE.L3VPN ||
            peerType === BmpConst.BMP_PEER_TYPE.LOCAL
        ) {
            this.processPeerDownGlobal(message, version);
        } else if (peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
            this.processPeerDownLocalRib(message, version);
        } else {
            logger.error(`Unknown peer type: ${peerType}`);
        }
    }

    processPeerUpGlobal(message, version = BmpConst.BMP_VERSION.V3) {
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

            const peerUpTlvResult = parseBmpTlvs(message, position);
            this.logTlvWarnings('Peer Up TLV', peerUpTlvResult.warnings);
            const peerUpTlvs = peerUpTlvResult.tlvs;
            const effectiveSessionFlags =
                version === BmpConst.BMP_VERSION.V4 && this.isBmpV4TlvDraft20()
                    ? getEffectivePeerFlags(sessionFlags, peerUpTlvs)
                    : sessionFlags;

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
            } else {
                this.clearSessionAddPathByAddressFamilies(bgpSession, enabledAddressFamilies);
            }

            this.mergeAddressFamilies(bgpSession.enabledAddressFamilies, enabledAddressFamilies);
            this.mergeAddressFamilies(bgpSession.recvAddressFamilies, recvAddressFamilies);
            this.mergeAddressFamilies(bgpSession.sendAddressFamilies, sentAddressFamilies);

            const allKeys = new Set([...recvAddPaths.keys(), ...sendAddPaths.keys()]);
            allKeys.forEach(key => {
                const recvMode = recvAddPaths.get(key); // Remote Peer's mode
                const sendMode = sendAddPaths.get(key); // Monitored Router's mode
                const receive = this.canRouterReceiveAddPath(recvMode, sendMode);
                const send = this.canRouterSendAddPath(recvMode, sendMode);

                bgpSession.addPathReceiveMap.set(key, receive);
                bgpSession.addPathSendMap.set(key, send);
                bgpSession.addPathMap.set(key, receive || send);
            });

            bgpSession.recvAddPathMap = recvAddPaths;
            bgpSession.sendAddPathMap = sendAddPaths;

            bgpSession.enabledAddressFamilies.forEach(addrFamily => {
                const afKey = `${addrFamily.afi}|${addrFamily.safi}`;
                if (!bgpSession.bgpRoutes.has(afKey)) {
                    bgpSession.bgpRoutes.set(afKey, new Map());
                }
            });

            bgpSession.sessionFlags = (bgpSession.sessionFlags || 0) | effectiveSessionFlags;
            bgpSession.rawSessionFlags = sessionFlags;
            bgpSession.peerUpTlvs = peerUpTlvs;

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
            bgpSession.sessionFlags = effectiveSessionFlags;
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

    processPeerUpLocalRib(message, version = BmpConst.BMP_VERSION.V3) {
        try {
            let position = 0;
            const peerHeader = parsePeerHeader(message, position);
            if (!peerHeader.valid) {
                logger.error(peerHeader.error);
                return;
            }
            position = peerHeader.offset;
            const {
                peerType: instanceType,
                peerFlags: instanceFlags,
                peerRd: instanceRd,
                peerAddress: instanceAddress,
                peerAs: instanceAs,
                peerRouterId: instanceRouterId,
                peerTimestamp: instanceTimestamp,
                peerTimestampMs: instanceTimestampMs
            } = peerHeader.peer;

            let localAddress;
            if (instanceType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
                localAddress = '0.0.0.0';
                position += 16;
            } else if (instanceFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) {
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

            const peerUpTlvResult = parseBmpTlvs(message, position);
            this.logTlvWarnings('Peer Up Local-RIB TLV', peerUpTlvResult.warnings);
            const peerUpTlvs = peerUpTlvResult.tlvs;
            const vrfTableNames = this.decodeVrfTableNameTlvs(peerUpTlvs);
            const effectiveInstanceFlags =
                version === BmpConst.BMP_VERSION.V4 && this.isBmpV4TlvDraft20()
                    ? getEffectivePeerFlags(instanceFlags, peerUpTlvs)
                    : instanceFlags;

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
                const addPathKey = `${enabledAF.afi}|${enabledAF.safi}`;
                this.instAddPathMap.delete(addPathKey);
                this.instAddPathReceiveMap.delete(addPathKey);
                this.instAddPathSendMap.delete(addPathKey);

                const instanceKey = BmpBgpInstance.makeKey(instanceType, instanceRd, enabledAF.afi, enabledAF.safi);
                let bgpInstance = this.bgpInstanceMap.get(instanceKey);
                if (!bgpInstance) {
                    bgpInstance = new BmpBgpInstance(this);
                    this.bgpInstanceMap.set(instanceKey, bgpInstance);
                } else {
                    bgpInstance.recvAddPathMap.clear();
                    bgpInstance.sendAddPathMap.clear();
                    bgpInstance.addPathReceiveMap.clear();
                    bgpInstance.addPathSendMap.clear();
                    bgpInstance.isAddPath = false;
                }

                this.mergeAddressFamilies(bgpInstance.enabledAddressFamilies, enabledAddressFamilies);
                this.mergeAddressFamilies(bgpInstance.recvAddressFamilies, recvAddressFamilies);
                this.mergeAddressFamilies(bgpInstance.sendAddressFamilies, sentAddressFamilies);

                bgpInstance.recvAddPathMap = recvAddPaths;
                bgpInstance.sendAddPathMap = sendAddPaths;
                bgpInstance.afi = enabledAF.afi;
                bgpInstance.safi = enabledAF.safi;

                bgpInstance.instanceFlags = (bgpInstance.instanceFlags || 0) | effectiveInstanceFlags;
                bgpInstance.rawInstanceFlags = instanceFlags;
                bgpInstance.peerUpTlvs = peerUpTlvs;
                bgpInstance.vrfTableNames =
                    vrfTableNames.length > 0
                        ? vrfTableNames
                        : instanceRd === '0:0'
                          ? ['global']
                          : bgpInstance.vrfTableNames;

                const ribTypes = this.getRibTypesByFlags(effectiveInstanceFlags);
                ribTypes.forEach(ribType => {
                    if (!bgpInstance.ribTypes.includes(ribType)) {
                        bgpInstance.ribTypes.push(ribType);
                    }
                });

                // 正常相同bgp Session这些字段一样
                bgpInstance.instanceType = instanceType;
                bgpInstance.instanceFlags = effectiveInstanceFlags;
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
                const receive = this.canRouterReceiveAddPath(recvMode, sendMode);
                const send = this.canRouterSendAddPath(recvMode, sendMode);

                const [afi, safi] = key.split('|');
                const instanceKey = BmpBgpInstance.makeKey(instanceType, instanceRd, afi, safi);
                const bgpInstance = this.bgpInstanceMap.get(instanceKey);
                if (!bgpInstance) {
                    logger.error(`Instance not found for key: ${instanceKey}`);
                    return;
                }

                this.instAddPathReceiveMap.set(key, receive);
                this.instAddPathSendMap.set(key, send);
                this.instAddPathMap.set(key, receive || send);
                bgpInstance.addPathReceiveMap.set(key, receive);
                bgpInstance.addPathSendMap.set(key, send);
                bgpInstance.isAddPath = receive || send;
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

    processPeerUp(message, version = BmpConst.BMP_VERSION.V3) {
        let position = 0;

        const sessionType = message[position];

        if (
            sessionType === BmpConst.BMP_PEER_TYPE.GLOBAL ||
            sessionType === BmpConst.BMP_PEER_TYPE.L3VPN ||
            sessionType === BmpConst.BMP_PEER_TYPE.LOCAL
        ) {
            this.processPeerUpGlobal(message, version);
        } else if (sessionType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
            this.processPeerUpLocalRib(message, version);
        } else {
            logger.error(`Unknown session type: ${sessionType}`);
        }
    }

    processTermination(message) {
        const tlvResult = parseBmpTlvs(message);
        this.logTlvWarnings('Termination TLV', tlvResult.warnings);
        this.terminationTlvs = tlvResult.tlvs;
        const clientInfo = this.getClientInfo();
        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.TERMINATION, { data: clientInfo });
        this.closeSession();

        const key = BmpSession.makeKey(this.localIp, this.localPort, this.remoteIp, this.remotePort);
        this.bmpWorker.bmpSessionMap.delete(key);
    }

    processStatisticsReportGlobal(message, version = BmpConst.BMP_VERSION.V3) {
        try {
            let position = 0;
            const peerHeader = parsePeerHeader(message, position);
            if (!peerHeader.valid) {
                logger.error(peerHeader.error);
                return;
            }
            position = peerHeader.offset;
            const {
                peerType: sessionType,
                peerFlags: sessionFlags,
                peerRd: sessionRd,
                peerAddress: sessionAddress,
                peerAs: sessionAs,
                peerRouterId: sessionRouterId,
                peerTimestamp: sessionTimestamp,
                peerTimestampMs: sessionTimestampMs
            } = peerHeader.peer;

            let statistics = [];
            let tlvs = [];
            if (version === BmpConst.BMP_VERSION.V4 && this.isBmpV4TlvDraft20()) {
                const tlvResult = parseBmpTlvs(message, position);
                this.logTlvWarnings('Statistics Report TLV', tlvResult.warnings);
                tlvs = tlvResult.tlvs;
                const statsTlv = tlvs.find(
                    tlv => !tlv.enterprise && tlv.type === BmpConst.BMP_STATS_REPORT_TLV_TYPE.STATS
                );
                if (!statsTlv) {
                    logger.error('BMPv4 Statistics Report message does not contain mandatory Stats TLV');
                    return;
                }
                statsTlv.name = 'Stats';
                const statsResult = parseStatsRecords(statsTlv.value);
                this.logTlvWarnings('Statistics Report Stats TLV', statsResult.warnings);
                statistics = statsResult.statistics;
            } else {
                const statsResult = parseStatsRecords(message, position);
                this.logTlvWarnings('Statistics Report', statsResult.warnings);
                statistics = statsResult.statistics;
            }

            const bgpSessionKey = BmpBgpSession.makeKey(sessionType, sessionRd, sessionAddress, sessionAs);
            const bgpSession = this.bgpSessionMap.get(bgpSessionKey);
            const sessionInfo = bgpSession
                ? bgpSession.getSessionInfo()
                : {
                      sessionType,
                      sessionFlags,
                      sessionRd,
                      sessionIp: sessionAddress,
                      sessionAs,
                      sessionRouterId,
                      sessionTimestamp,
                      sessionTimestampMs
                  };

            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT, {
                data: {
                    client: this.getClientInfo(),
                    session: sessionInfo,
                    statistics: statistics,
                    tlvs: toSerializableTlvs(tlvs)
                }
            });
        } catch (err) {
            logger.error(`Error processing statistics report (global):`, err);
        }
    }

    processStatisticsReportLocalRib(message, version = BmpConst.BMP_VERSION.V3) {
        try {
            let position = 0;
            const peerHeader = parsePeerHeader(message, position);
            if (!peerHeader.valid) {
                logger.error(peerHeader.error);
                return;
            }
            position = peerHeader.offset;
            const {
                peerType: instanceType,
                peerFlags: instanceFlags,
                peerRd: instanceRd,
                peerAddress: instanceIp,
                peerAs: instanceAs,
                peerRouterId: instanceRouterId,
                peerTimestamp: instanceTimestamp,
                peerTimestampMs: instanceTimestampMs
            } = peerHeader.peer;

            let statistics = [];
            let tlvs = [];
            if (version === BmpConst.BMP_VERSION.V4 && this.isBmpV4TlvDraft20()) {
                const tlvResult = parseBmpTlvs(message, position);
                this.logTlvWarnings('Local-RIB Statistics Report TLV', tlvResult.warnings);
                tlvs = tlvResult.tlvs;
                const statsTlv = tlvs.find(
                    tlv => !tlv.enterprise && tlv.type === BmpConst.BMP_STATS_REPORT_TLV_TYPE.STATS
                );
                if (!statsTlv) {
                    logger.error('BMPv4 Local-RIB Statistics Report message does not contain mandatory Stats TLV');
                    return;
                }
                statsTlv.name = 'Stats';
                const statsResult = parseStatsRecords(statsTlv.value, 0, { locRib: true });
                this.logTlvWarnings('Local-RIB Statistics Report Stats TLV', statsResult.warnings);
                statistics = statsResult.statistics;
            } else {
                const statsResult = parseStatsRecords(message, position, { locRib: true });
                this.logTlvWarnings('Local-RIB Statistics Report', statsResult.warnings);
                statistics = statsResult.statistics;
            }

            const vrfTableNames = [];
            const instancePrefix = `${instanceType}|${instanceRd}|`;
            this.bgpInstanceMap.forEach((instance, key) => {
                if (key.startsWith(instancePrefix) && Array.isArray(instance.vrfTableNames)) {
                    vrfTableNames.push(...instance.vrfTableNames);
                }
            });

            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT, {
                data: {
                    client: this.getClientInfo(),
                    instance: {
                        instanceType,
                        instanceFlags,
                        instanceRd,
                        instanceIp,
                        instanceAs,
                        instanceRouterId,
                        instanceTimestamp,
                        instanceTimestampMs,
                        vrfTableNames: Array.from(new Set(vrfTableNames))
                    },
                    statistics: statistics,
                    tlvs: toSerializableTlvs(tlvs)
                }
            });
        } catch (err) {
            logger.error(`Error processing statistics report (local rib):`, err);
        }
    }

    processStatisticsReport(message, version = BmpConst.BMP_VERSION.V3) {
        const peerType = message[0];
        if (
            peerType === BmpConst.BMP_PEER_TYPE.GLOBAL ||
            peerType === BmpConst.BMP_PEER_TYPE.L3VPN ||
            peerType === BmpConst.BMP_PEER_TYPE.LOCAL
        ) {
            this.processStatisticsReportGlobal(message, version);
        } else if (peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
            this.processStatisticsReportLocalRib(message, version);
        } else {
            logger.error(`Unknown peer type in statistics report: ${peerType}`);
        }
    }

    processMessage(message) {
        try {
            const clientAddress = `${this.remoteIp}:${this.remotePort}`;

            const header = parseCommonHeader(message);
            if (!header.valid) {
                logger.error(header.error);
                return;
            }

            const { version, length, type } = header;
            this.bmpVersion = version;
            if (version !== BmpConst.BMP_VERSION.V3 && version !== BmpConst.BMP_VERSION.V4) {
                logger.warn(`Unsupported BMP version ${version} from ${clientAddress}`);
                this.closeSession();
                return;
            }

            logger.info(
                `Received BMPv${version} message type ${BmpConst.BMP_MSG_TYPE_NAME[type]} from ${clientAddress}, length ${length}`
            );

            const msg = message.slice(BmpConst.BMP_HEADER_LENGTH, length);

            switch (type) {
                case BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING:
                    this.processRouteMonitoring(msg, version);
                    break;
                case BmpConst.BMP_MSG_TYPE.PEER_DOWN_NOTIFICATION:
                    this.processPeerDown(msg, version);
                    break;
                case BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION:
                    this.processPeerUp(msg, version);
                    break;
                case BmpConst.BMP_MSG_TYPE.INITIATION:
                    this.processInitiation(msg);
                    break;
                case BmpConst.BMP_MSG_TYPE.TERMINATION:
                    this.processTermination(msg);
                    break;
                case BmpConst.BMP_MSG_TYPE.STATISTICS_REPORT:
                    this.processStatisticsReport(msg, version);
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
            if (messageLength < BmpConst.BMP_HEADER_LENGTH) {
                logger.warn(`Invalid BMP message length ${messageLength}, closing session`);
                this.messageBuffer = Buffer.alloc(0);
                this.closeSession();
                break;
            }

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
        this.instAddPathReceiveMap.clear();
        this.instAddPathSendMap.clear();
        this.bgpInstanceMap.clear();
    }
}

module.exports = BmpSession;
