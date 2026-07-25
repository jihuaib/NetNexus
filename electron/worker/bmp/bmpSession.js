const logger = require('../../log/logger');
const BmpConst = require('../../const/bmpConst');
const {
    getInitiationTlvName,
    toUnixTimestampMs,
    parseCommonHeader,
    parsePeerHeader,
    parseBmpTlvs,
    toSerializableTlvs,
    decodeExtendedPeerFlagsValue,
    getEffectivePeerFlags,
    parseStatsRecords
} = require('../../utils/bmpUtils');
const BgpConst = require('../../const/bgpConst');
const BmpBgpSession = require('./bmpBgpSession');
const BmpBgpRoute = require('./bmpBgpRoute');
const { rdBufferToString, ipv4BufferToString, ipv6BufferToString } = require('../../utils/ipUtils');
const { parseBgpPacket, getBgpPacketSummary: getBgpUpdateSummary } = require('../../utils/bgpPacketParser');
const { parseBmpPacket, getBmpPacketSummary } = require('../../utils/bmpPacketParser');
const { getAddrFamilyType } = require('../../utils/bgpUtils');
const { splitSessionStatisticsReport, getSessionStatisticsReportIdentityParts } = require('../../utils/bmpStatistics');
const BmpBgpInstance = require('./bmpBgpInstance');
const IdentityFallbackMap = require('./identityFallbackMap');
const {
    buildScope,
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation,
    buildRouteWithdrawMutation,
    buildRoutePurgeMutation
} = require('./bmpPersistenceMutation');

const LOC_RIB_DEFAULT_RD = '0:0';
const LOC_RIB_DEFAULT_RD_RAW = 'raw:0000000000000000';
const LOC_RIB_DEFAULT_RD_ADD_PATH_INFERRED_WARNING =
    'Loc-RIB ADD-PATH is inferred from RD 0:0 for the same AFI/SAFI; Peer Up did not advertise ADD-PATH for this RD';

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

        this.bgpSessionMap = new IdentityFallbackMap(session =>
            BmpBgpSession.makeKey(session.sessionType, session.sessionRd, session.sessionIp, session.sessionAs)
        );
        this.bgpInstanceMap = new IdentityFallbackMap(instance =>
            BmpBgpInstance.makeKey(instance.instanceType, instance.instanceRd, instance.afi, instance.safi)
        );
        this.bgpStatisticsReportMap = new Map();
        this.bgpInstanceStatisticsReportMap = new Map();
        this.instAddPathMap = new Map();
        this.instAddPathReceiveMap = new Map();
        this.instAddPathSendMap = new Map();
        this.messageBuffer = Buffer.alloc(0);
        this.persistenceConnectionOpened = false;
        this.persistenceConnectionClosed = false;
        this.persistenceSequence = 0;
    }

    static makeKey(localIp, localPort, remoteIp, remotePort) {
        return `${localIp}|${localPort}|${remoteIp}|${remotePort}`;
    }

    static parseKey(key) {
        const [localIp, localPort, remoteIp, remotePort] = key.split('|');
        return { localIp, localPort, remoteIp, remotePort };
    }

    static makeStatisticsReportKey(...parts) {
        return parts.join('|');
    }

    enqueuePersistenceMutation(mutation) {
        if (!this.bmpWorker || typeof this.bmpWorker.enqueuePersistenceMutation !== 'function') {
            return false;
        }
        return this.bmpWorker.enqueuePersistenceMutation(mutation);
    }

    makeAndEnqueuePersistenceMutation(factory, ensureConnection = true) {
        try {
            if (ensureConnection && !this.persistenceConnectionOpened) {
                this.persistConnectionOpen();
            }
            return this.enqueuePersistenceMutation(factory());
        } catch (error) {
            logger.error(`Failed to build BMP persistence mutation: ${error.message}`);
            // Once persistence is active, silently skipping an event would make the
            // database an untrustworthy projection of the in-memory RIB. Treat key or
            // serialization failures exactly like writer failures and stop ingestion.
            if (this.bmpWorker?.persistence && typeof this.bmpWorker.handlePersistenceFailure === 'function') {
                this.bmpWorker.handlePersistenceFailure(error);
            }
            return false;
        }
    }

    persistConnectionOpen() {
        if (this.persistenceConnectionOpened || !this.remoteIp) {
            return false;
        }
        this.persistenceConnectionOpened = true;
        const accepted = this.makeAndEnqueuePersistenceMutation(
            () => buildConnectionMutation(this, 'connection_open'),
            false
        );
        if (accepted) {
            this.invalidateRouteAssurance('persistence-connection-open');
            // Arm the single refresh deadline for both scopes explicitly reopened
            // by Peer Up and scopes that never reappear on the replacement connection.
            this.bmpWorker?.requestPersistenceSweep?.();
        }
        return accepted;
    }

    persistSourceUpdate() {
        return this.makeAndEnqueuePersistenceMutation(() => buildConnectionMutation(this, 'source_update'));
    }

    persistConnectionClose(reason = 'connection-close') {
        if (this.persistenceConnectionClosed) {
            return false;
        }
        this.persistenceConnectionClosed = true;
        if (!this.persistenceConnectionOpened) {
            return false;
        }
        const accepted = this.makeAndEnqueuePersistenceMutation(() =>
            buildConnectionMutation(this, 'connection_close', { reason })
        );
        if (accepted) {
            // A close can turn an ambiguous multi-connection source into one
            // unambiguous replacement connection, so recompute its deadline.
            this.bmpWorker?.requestPersistenceSweep?.();
        }
        return accepted;
    }

    persistStatistics(report, sourceTimestampMs = null) {
        return this.makeAndEnqueuePersistenceMutation(() => {
            const mutation = buildConnectionMutation(this, 'statistics', { sourceTimestampMs });
            mutation.statistics = report;
            return mutation;
        });
    }

    getPersistenceScopeState(owner, afi, safi, ribType) {
        const key = `${afi}|${safi}|${ribType}`;
        return owner.persistenceScopeStateMap?.get(key) || 'syncing';
    }

    setPersistenceScopeState(owner, afi, safi, ribType, state) {
        if (!owner.persistenceScopeStateMap) {
            owner.persistenceScopeStateMap = new Map();
        }
        owner.persistenceScopeStateMap.set(`${afi}|${safi}|${ribType}`, state);
    }

    persistScopeState(owner, afi, safi, ribType, kind, state, eventType, options = {}) {
        this.setPersistenceScopeState(owner, afi, safi, ribType, state);
        const accepted = this.makeAndEnqueuePersistenceMutation(() =>
            buildScopeMutation(this, owner, afi, safi, ribType, eventType, {
                ...options,
                kind,
                state
            })
        );
        if (accepted && ['scope_open', 'scope_stale', 'scope_eor', 'scope_timeout'].includes(eventType)) {
            this.invalidateRouteAssurance(`persistence-${eventType}`);
        }
        return accepted;
    }

    persistSessionRouteUpsert(bgpSession, route, afi, safi, ribType, options = {}) {
        route.ribType = ribType;
        return this.makeAndEnqueuePersistenceMutation(() =>
            buildRouteUpsertMutation(this, bgpSession, route, afi, safi, ribType, {
                ...options,
                kind: 'peer',
                scopeState: this.getPersistenceScopeState(bgpSession, afi, safi, ribType)
            })
        );
    }

    persistSessionRouteWithdraw(bgpSession, withdrawn, route, afi, safi, ribType, options = {}) {
        return this.makeAndEnqueuePersistenceMutation(() =>
            buildRouteWithdrawMutation(this, bgpSession, withdrawn, route, afi, safi, ribType, {
                ...options,
                kind: 'peer',
                state: this.getPersistenceScopeState(bgpSession, afi, safi, ribType)
            })
        );
    }

    persistInstanceRouteUpsert(bgpInstance, route, afi, safi, options = {}) {
        route.ribType = 'loc-rib';
        return this.makeAndEnqueuePersistenceMutation(() =>
            buildRouteUpsertMutation(this, bgpInstance, route, afi, safi, 'loc-rib', {
                ...options,
                kind: 'loc-rib',
                scopeState: this.getPersistenceScopeState(bgpInstance, afi, safi, 'loc-rib')
            })
        );
    }

    persistInstanceRouteWithdraw(bgpInstance, withdrawn, route, afi, safi, options = {}) {
        return this.makeAndEnqueuePersistenceMutation(() =>
            buildRouteWithdrawMutation(this, bgpInstance, withdrawn, route, afi, safi, 'loc-rib', {
                ...options,
                kind: 'loc-rib',
                state: this.getPersistenceScopeState(bgpInstance, afi, safi, 'loc-rib')
            })
        );
    }

    persistSessionRoutePurge(bgpSession, route, afi, safi, ribType, options = {}) {
        return this.makeAndEnqueuePersistenceMutation(() =>
            buildRoutePurgeMutation(this, bgpSession, route, afi, safi, ribType, {
                ...options,
                kind: 'peer',
                state: this.getPersistenceScopeState(bgpSession, afi, safi, ribType)
            })
        );
    }

    persistInstanceRoutePurge(bgpInstance, route, afi, safi, options = {}) {
        return this.makeAndEnqueuePersistenceMutation(() =>
            buildRoutePurgeMutation(this, bgpInstance, route, afi, safi, 'loc-rib', {
                ...options,
                kind: 'loc-rib',
                state: this.getPersistenceScopeState(bgpInstance, afi, safi, 'loc-rib')
            })
        );
    }

    getPersistenceScope(owner, afi, safi, ribType, kind = 'peer') {
        return buildScope(this, owner, afi, safi, ribType, { kind });
    }

    getPersistenceScopeId(owner, afi, safi, ribType, kind = 'peer') {
        return this.getPersistenceScope(owner, afi, safi, ribType, kind).id;
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

    getPathMarkingTlvType() {
        const configuredType = Number(this.bmpWorker?.bmpConfigData?.pathMarkingTlvType);
        if (Number.isInteger(configuredType) && configuredType >= 1 && configuredType <= 0x3fff) {
            return configuredType;
        }

        return this.getBmpV4TlvDraft() === BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
            ? BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE_LEGACY.PATH_MARKING
            : BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING;
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

    isRouteMonitoringGroupTlv(tlv) {
        if (tlv.enterprise || !Buffer.isBuffer(tlv.value)) {
            return false;
        }

        return tlv.type === this.getRouteMonitoringTlvTypes().GROUP;
    }

    isPathMarkingTlv(tlv) {
        if (!Buffer.isBuffer(tlv.value)) {
            return false;
        }
        if (tlv.type !== this.getPathMarkingTlvType()) {
            return false;
        }
        if (tlv.value.length !== 4 && tlv.value.length !== 6) {
            return false;
        }

        return !(tlv.type === this.getRouteMonitoringTlvTypes().VRF_TABLE_NAME && this.isTextTlvValue(tlv.value));
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
            return tlv.type === this.getRouteMonitoringTlvTypes().VRF_TABLE_NAME && this.isTextTlvValue(tlv.value);
        }

        return tlv.type === BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME && this.isTextTlvValue(tlv.value);
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
        const getFallbackAddPathInfo = (afi, safi) => {
            if (!fallbackContext) {
                return { enabled: false };
            }
            if (typeof fallbackContext.getAddPathReceiveInfo === 'function') {
                return fallbackContext.getAddPathReceiveInfo(afi, safi, direction) || { enabled: false };
            }
            if (typeof fallbackContext.isAddPathReceiveEnabled === 'function') {
                return { enabled: fallbackContext.isAddPathReceiveEnabled(afi, safi, direction) };
            }
            return { enabled: false };
        };

        if (statelessAddPathMap.size === 0) {
            if (!fallbackContext || typeof fallbackContext.isAddPathReceiveEnabled !== 'function') {
                return fallbackContext;
            }
            return {
                getAddPathReceiveInfo: (afi, safi) => {
                    if (typeof fallbackContext.getAddPathReceiveInfo === 'function') {
                        return fallbackContext.getAddPathReceiveInfo(afi, safi, direction);
                    }
                    return { enabled: fallbackContext.isAddPathReceiveEnabled(afi, safi, direction) };
                },
                isAddPathReceiveEnabled: (afi, safi) => fallbackContext.isAddPathReceiveEnabled(afi, safi, direction)
            };
        }

        return {
            getAddPathReceiveInfo: (afi, safi) => {
                const key = `${afi}|${safi}`;
                if (statelessAddPathMap.has(key)) {
                    const fallbackInfo = getFallbackAddPathInfo(afi, safi);
                    return {
                        enabled: statelessAddPathMap.get(key) !== 0,
                        source: 'bmp-stateless-parsing-tlv',
                        fallbackEnabled: fallbackInfo.enabled === true
                    };
                }
                if (fallbackContext && typeof fallbackContext.getAddPathReceiveInfo === 'function') {
                    return fallbackContext.getAddPathReceiveInfo(afi, safi, direction);
                }
                if (fallbackContext && typeof fallbackContext.isAddPathReceiveEnabled === 'function') {
                    return { enabled: fallbackContext.isAddPathReceiveEnabled(afi, safi, direction) };
                }
                return { enabled: false };
            },
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

    createLocRibBgpParsingContext(locRibPeer) {
        const getInstanceAddPathReceiveInfo = (bgpInstance, afi, safi, direction) => {
            if (!bgpInstance) {
                return { enabled: false };
            }
            return typeof bgpInstance.getAddPathReceiveInfo === 'function'
                ? bgpInstance.getAddPathReceiveInfo(afi, safi, direction)
                : { enabled: bgpInstance.isAddPathReceiveEnabled(afi, safi, direction) };
        };

        const getAddPathReceiveInfo = (afi, safi, direction = 'receive') => {
            const instanceKey = BmpBgpInstance.makeKey(
                locRibPeer.peerType,
                locRibPeer.peerRd,
                afi,
                safi,
                locRibPeer.peerRdRaw
            );
            const bgpInstance = this.bgpInstanceMap.get(instanceKey);
            const advertisedForRequestedAf = this.hasAdvertisedAddressFamily(bgpInstance, afi, safi);
            if (bgpInstance) {
                const addPathInfo = getInstanceAddPathReceiveInfo(bgpInstance, afi, safi, direction);
                if (addPathInfo.enabled || advertisedForRequestedAf) {
                    return addPathInfo;
                }
            }

            if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST && !advertisedForRequestedAf) {
                const unicastInstanceKey = BmpBgpInstance.makeKey(
                    locRibPeer.peerType,
                    locRibPeer.peerRd,
                    afi,
                    BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                    locRibPeer.peerRdRaw
                );
                const unicastInstance = this.bgpInstanceMap.get(unicastInstanceKey);
                if (
                    unicastInstance &&
                    unicastInstance.isAddPathReceiveEnabled(afi, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST, direction)
                ) {
                    return {
                        enabled: true,
                        inferred: true
                    };
                }
            }

            if (
                safi !== BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST &&
                !this.hasNegotiatedAddressFamily(bgpInstance, afi, safi) &&
                locRibPeer.peerRd !== LOC_RIB_DEFAULT_RD
            ) {
                const defaultInstanceKey = BmpBgpInstance.makeKey(
                    locRibPeer.peerType,
                    LOC_RIB_DEFAULT_RD,
                    afi,
                    safi,
                    LOC_RIB_DEFAULT_RD_RAW
                );
                const defaultInstance = this.bgpInstanceMap.get(defaultInstanceKey);
                if (this.hasNegotiatedAddressFamily(defaultInstance, afi, safi)) {
                    const defaultAddPathInfo = getInstanceAddPathReceiveInfo(defaultInstance, afi, safi, direction);
                    return defaultAddPathInfo.enabled
                        ? {
                              ...defaultAddPathInfo,
                              inferred: true,
                              warning: LOC_RIB_DEFAULT_RD_ADD_PATH_INFERRED_WARNING
                          }
                        : defaultAddPathInfo;
                }
            }

            return { enabled: false };
        };

        return {
            getAddPathReceiveInfo,
            isAddPathReceiveEnabled: (afi, safi, direction = 'receive') =>
                getAddPathReceiveInfo(afi, safi, direction).enabled
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

    mergeVrfTableNames(target, vrfTableNames) {
        if (!target || !Array.isArray(vrfTableNames) || vrfTableNames.length === 0) {
            return false;
        }

        const merged = new Set(Array.isArray(target.vrfTableNames) ? target.vrfTableNames : []);
        const previousSize = merged.size;
        vrfTableNames.forEach(name => {
            if (name) {
                merged.add(name);
            }
        });
        target.vrfTableNames = Array.from(merged);
        return target.vrfTableNames.length !== previousSize;
    }

    hasAddressFamily(addressFamilies, afi, safi) {
        return (
            Array.isArray(addressFamilies) &&
            addressFamilies.some(
                addrFamily => Number(addrFamily.afi) === Number(afi) && Number(addrFamily.safi) === Number(safi)
            )
        );
    }

    hasAdvertisedAddressFamily(target, afi, safi) {
        if (!target) {
            return false;
        }

        return (
            this.hasAddressFamily(target.recvAddressFamilies, afi, safi) ||
            this.hasAddressFamily(target.sendAddressFamilies, afi, safi)
        );
    }

    hasNegotiatedAddressFamily(target, afi, safi) {
        if (!target) {
            return false;
        }

        return (
            this.hasAddressFamily(target.recvAddressFamilies, afi, safi) &&
            this.hasAddressFamily(target.sendAddressFamilies, afi, safi)
        );
    }

    decodePathMarkingTlv(tlv) {
        const pathStatus = tlv.value.readUInt32BE(0) >>> 0;
        const pathStatusNames = BmpBgpRoute.getPathStatusNames(pathStatus);
        const pathStatusUnknownBits = BmpBgpRoute.getPathStatusUnknownBits(pathStatus);
        const reasonCode = tlv.value.length >= 6 ? tlv.value.readUInt16BE(4) : null;
        const reasonName = reasonCode === null ? null : BmpConst.BMP_PATH_STATUS_REASON_NAME?.[reasonCode] || null;
        const reasonText =
            reasonCode === null ? null : reasonName || `Unknown(0x${reasonCode.toString(16).padStart(4, '0')})`;

        tlv.name = 'Path Marking';
        tlv.decoded = {
            pathStatus,
            pathStatusHex: `0x${pathStatus.toString(16).padStart(8, '0')}`,
            pathStatusNames,
            pathStatusText: BmpBgpRoute.formatPathStatus(pathStatus, pathStatusNames, pathStatusUnknownBits),
            pathStatusUnknownBits,
            reasonCode,
            reasonCodeHex: reasonCode === null ? null : `0x${reasonCode.toString(16).padStart(4, '0')}`,
            reasonName,
            reasonText,
            target: tlv.group ? 'group' : tlv.index === 0 ? 'all' : 'nlri'
        };

        return {
            type: tlv.type,
            enterprise: tlv.enterprise,
            enterpriseNumber: tlv.enterpriseNumber,
            rawIndex: tlv.rawIndex,
            index: tlv.index,
            group: tlv.group,
            pathStatus,
            pathStatusNames,
            pathStatusText: tlv.decoded.pathStatusText,
            pathStatusUnknownBits,
            reasonCode,
            reasonName,
            reasonText
        };
    }

    buildRouteMonitoringGroupMap(routeTlvs) {
        const groupMap = new Map();
        if (!Array.isArray(routeTlvs)) {
            return groupMap;
        }

        routeTlvs.forEach(tlv => {
            if (
                !this.isRouteMonitoringGroupTlv(tlv) ||
                !tlv.group ||
                tlv.rawIndex === null ||
                tlv.rawIndex === undefined
            ) {
                return;
            }

            const indexes = [];
            let position = 0;
            while (position + 2 <= tlv.value.length) {
                const rawIndex = tlv.value.readUInt16BE(position);
                position += 2;
                const index = rawIndex & 0x7fff;
                if (index > 0) {
                    indexes.push(index);
                }
            }
            if (position !== tlv.value.length) {
                logger.warn(`Route Monitoring Group TLV ${tlv.rawIndex} contains a truncated NLRI index`);
            }

            tlv.name = 'Group';
            tlv.decoded = { indexes };
            groupMap.set(tlv.rawIndex, indexes);
        });

        return groupMap;
    }

    resolveIndexedTlvRouteIndexes(tlv, groupMap, nlriCount) {
        if (!nlriCount) {
            return [];
        }
        if (tlv.rawIndex === 0 || (!tlv.group && tlv.index === 0)) {
            return Array.from({ length: nlriCount }, (_, offset) => offset + 1);
        }
        if (tlv.group) {
            const groupRawIndex =
                tlv.rawIndex !== null && tlv.rawIndex !== undefined ? tlv.rawIndex : 0x8000 | Number(tlv.index || 0);
            const indexes = groupMap.get(groupRawIndex);
            if (!Array.isArray(indexes)) {
                logger.warn(`Path Marking TLV references unknown group index ${groupRawIndex}`);
                return [];
            }
            return indexes.filter(index => index >= 1 && index <= nlriCount);
        }

        const index = Number(tlv.index);
        return index >= 1 && index <= nlriCount ? [index] : [];
    }

    getRouteMonitoringNlriList(parsedBgpUpdate) {
        const nlriList = [];
        if (!parsedBgpUpdate) {
            return nlriList;
        }

        if (Array.isArray(parsedBgpUpdate.nlri)) {
            nlriList.push(...parsedBgpUpdate.nlri);
        }

        for (const attr of parsedBgpUpdate.pathAttributes || []) {
            if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI && Array.isArray(attr.mpReach?.nlri)) {
                nlriList.push(...attr.mpReach.nlri);
            }
        }

        return nlriList;
    }

    buildPathMarkingAssignments(parsedBgpUpdate, routeTlvs) {
        const assignments = new Map();
        if (!Array.isArray(routeTlvs)) {
            return assignments;
        }

        const nlriList = this.getRouteMonitoringNlriList(parsedBgpUpdate);
        if (nlriList.length === 0) {
            return assignments;
        }

        const groupMap = this.buildRouteMonitoringGroupMap(routeTlvs);
        routeTlvs.forEach(tlv => {
            if (!this.isPathMarkingTlv(tlv)) {
                return;
            }

            const marking = this.decodePathMarkingTlv(tlv);
            const indexes = this.resolveIndexedTlvRouteIndexes(tlv, groupMap, nlriList.length);
            indexes.forEach(index => {
                const nlri = nlriList[index - 1];
                if (!nlri) {
                    return;
                }
                if (!assignments.has(nlri)) {
                    assignments.set(nlri, []);
                }
                assignments.get(nlri).push(marking);
            });
        });

        return assignments;
    }

    applyPathMarkings(route, assignments, nlri) {
        route.setPathStatusMarkings(assignments?.get(nlri) || []);
    }

    isRouteTlvVisibleOnRoute(tlv) {
        if (!tlv || !Buffer.isBuffer(tlv.value)) {
            return false;
        }
        if (!tlv.enterprise && (this.isRouteMonitoringBgpMessageTlv(tlv) || this.isRouteMonitoringGroupTlv(tlv))) {
            return false;
        }
        return true;
    }

    decorateRouteTlvForDisplay(tlv) {
        if (!tlv || !Buffer.isBuffer(tlv.value)) {
            return;
        }

        if (
            this.isBmpV4TlvDraft20() &&
            !tlv.enterprise &&
            tlv.type === BmpConst.BMP_TLV_TYPE.EXTENDED_FLAGS &&
            tlv.value.length > 0
        ) {
            const flags = decodeExtendedPeerFlagsValue(tlv.value);
            tlv.name = 'Extended Flags';
            tlv.decoded = {
                flags,
                flagsHex: `0x${flags.toString(16).padStart(2, '0')}`
            };
            return;
        }

        if (
            this.isBmpV4TlvDraft20() &&
            !tlv.enterprise &&
            tlv.type === BmpConst.BMP_TLV_TYPE.SEQUENCE_NUMBER &&
            tlv.value.length === 4
        ) {
            tlv.name = 'Sequence Number';
            tlv.decoded = {
                sequenceNumber: tlv.value.readUInt32BE(0)
            };
            return;
        }

        if (
            this.isBmpV4TlvDraft20() &&
            !tlv.enterprise &&
            tlv.type === BmpConst.BMP_TLV_TYPE.TIMESTAMP &&
            tlv.value.length >= 8
        ) {
            tlv.name = 'Timestamp';
            tlv.decoded = {
                seconds: tlv.value.readUInt32BE(0),
                microseconds: tlv.value.readUInt32BE(4)
            };
            return;
        }

        if (this.isVrfTableNameTlv(tlv)) {
            tlv.name = 'VRF/Table Name';
            tlv.valueText = tlv.value.toString('utf8');
            return;
        }

        if (this.isRouteMonitoringStatelessParsingTlv(tlv) && !tlv.decoded) {
            this.decodeStatelessParsingTlvs([tlv]);
            return;
        }

        if (this.isPathMarkingTlv(tlv) && !tlv.decoded) {
            this.decodePathMarkingTlv(tlv);
        }
    }

    buildRouteTlvAssignments(parsedBgpUpdate, routeTlvs) {
        const assignments = new Map();
        if (!Array.isArray(routeTlvs)) {
            return assignments;
        }

        const nlriList = this.getRouteMonitoringNlriList(parsedBgpUpdate);
        if (nlriList.length === 0) {
            return assignments;
        }

        const groupMap = this.buildRouteMonitoringGroupMap(routeTlvs);
        routeTlvs.forEach(tlv => {
            if (!this.isRouteTlvVisibleOnRoute(tlv)) {
                return;
            }

            this.decorateRouteTlvForDisplay(tlv);
            const indexes = this.resolveIndexedTlvRouteIndexes(tlv, groupMap, nlriList.length);
            indexes.forEach(index => {
                const nlri = nlriList[index - 1];
                if (!nlri) {
                    return;
                }
                if (!assignments.has(nlri)) {
                    assignments.set(nlri, []);
                }

                const serializable = toSerializableTlvs([tlv])[0];
                assignments.get(nlri).push({
                    ...serializable,
                    appliedNlriIndex: index
                });
            });
        });

        return assignments;
    }

    applyRouteTlvs(route, assignments, nlri) {
        route.setRouteTlvs(assignments?.get(nlri) || []);
    }

    getOrCreateLocRibInstance(peer, afi, safi, options = {}) {
        const instanceKey = BmpBgpInstance.makeKey(peer.peerType, peer.peerRd, afi, safi, peer.peerRdRaw);
        let bgpInstance = this.bgpInstanceMap.get(instanceKey);
        let instanceInfoChanged = false;
        if (!bgpInstance) {
            bgpInstance = new BmpBgpInstance(this);
            this.bgpInstanceMap.set(instanceKey, bgpInstance);
            instanceInfoChanged = true;
        }

        const addrFamily = { afi, safi };
        if (!this.hasAddressFamily(bgpInstance.enabledAddressFamilies, afi, safi)) {
            this.mergeAddressFamilies(bgpInstance.enabledAddressFamilies, [addrFamily]);
            instanceInfoChanged = true;
        }
        if (!bgpInstance.afi) {
            bgpInstance.afi = afi;
            bgpInstance.safi = safi;
            instanceInfoChanged = true;
        }

        bgpInstance.instanceType = peer.peerType;
        bgpInstance.instanceFlags = peer.peerFlags;
        bgpInstance.rawInstanceFlags = peer.peerFlags;
        bgpInstance.instanceRd = peer.peerRd;
        bgpInstance.instanceRdRaw = peer.peerRdRaw || null;
        bgpInstance.instanceIp = peer.peerAddress;
        bgpInstance.instanceAs = peer.peerAs;
        bgpInstance.instanceRouterId = peer.peerRouterId;
        bgpInstance.instanceTimestamp = peer.peerTimestamp;
        bgpInstance.instanceTimestampMicroseconds = peer.peerTimestampMicroseconds;
        bgpInstance.instanceTimestampMs = peer.peerTimestampMs;
        bgpInstance.localIp = options.localAddress || bgpInstance.localIp || '0.0.0.0';
        bgpInstance.localPort = options.localPort || bgpInstance.localPort || 0;
        bgpInstance.remotePort = options.remotePort || bgpInstance.remotePort || 0;
        bgpInstance.instanceState = BmpConst.BMP_SESSION_STATE.PEER_UP;

        if (Array.isArray(options.peerUpTlvs)) {
            bgpInstance.peerUpTlvs = options.peerUpTlvs;
        }
        const vrfTableNames = [
            ...this.decodeVrfTableNameTlvs(options.peerUpTlvs),
            ...this.decodeVrfTableNameTlvs(options.routeTlvs)
        ];
        if (vrfTableNames.length > 0) {
            if (this.mergeVrfTableNames(bgpInstance, vrfTableNames)) {
                instanceInfoChanged = true;
                this.invalidateRouteAssurance('instance-vrf-metadata-change');
            }
        } else if (!bgpInstance.vrfTableNames || bgpInstance.vrfTableNames.length === 0) {
            const defaultVrfTableNames = peer.peerRd === '0:0' ? ['global'] : [];
            if (!Array.isArray(bgpInstance.vrfTableNames) || defaultVrfTableNames.length > 0) {
                bgpInstance.vrfTableNames = defaultVrfTableNames;
                instanceInfoChanged = true;
                this.invalidateRouteAssurance('instance-vrf-metadata-change');
            }
        }

        if (instanceInfoChanged) {
            this.sendInstanceUpdateEvent(bgpInstance);
        }

        return bgpInstance;
    }

    ensureBgpSessionRouteScope(bgpSession, afi, safi, ribType) {
        const addrFamily = { afi, safi };
        let sessionInfoChanged = false;
        const routeScopeKey = bgpSession.getRouteTableKey(afi, safi, ribType);
        const hadRouteScope = bgpSession.routeScopes.has(routeScopeKey);
        if (!this.hasAddressFamily(bgpSession.enabledAddressFamilies, afi, safi)) {
            this.mergeAddressFamilies(bgpSession.enabledAddressFamilies, [addrFamily]);
            sessionInfoChanged = true;
        }

        if (!bgpSession.ribTypes.includes(ribType)) {
            bgpSession.ribTypes.push(ribType);
            sessionInfoChanged = true;
        }

        const scope = bgpSession.ensureRouteScope(afi, safi, ribType);
        sessionInfoChanged = sessionInfoChanged || !hadRouteScope;

        if (sessionInfoChanged) {
            this.sendSessionUpdateEvent(bgpSession);
        }

        return scope;
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
            const effectivePeerFlags = this.isBmpV4TlvDraft20()
                ? getEffectivePeerFlags(peerFlags, routeTlvs)
                : peerFlags;
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
            hasValidBgpNotification: false,
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
                result.hasValidBgpNotification =
                    embedded.type === BgpConst.BGP_PACKET_TYPE.NOTIFICATION &&
                    embedded.length >= BgpConst.BGP_HEAD_LEN + 2 &&
                    embedded.parsed?.valid === true &&
                    embedded.parsed.type === BgpConst.BGP_PACKET_TYPE.NOTIFICATION &&
                    Number.isInteger(embedded.parsed.errorCode) &&
                    Number.isInteger(embedded.parsed.errorSubcode);
                if (!result.hasValidBgpNotification) {
                    logger.warn('Peer Down: embedded BGP message is not a valid Notification');
                }
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

        if (
            version === BmpConst.BMP_VERSION.V4 ||
            reason === BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_TLV
        ) {
            const tlvResult = parseBmpTlvs(message, position);
            this.logTlvWarnings('Peer Down TLV', tlvResult.warnings);
            result.tlvs = tlvResult.tlvs;
        }

        return result;
    }

    // 辅助方法：设置路由属性
    setRouteAttributes(route, bgpUpdate) {
        const routeAttr = {};

        for (const attr of bgpUpdate.pathAttributes || []) {
            switch (attr.typeCode) {
                case BgpConst.BGP_PATH_ATTR.ORIGIN:
                    routeAttr.origin = attr.origin;
                    break;
                case BgpConst.BGP_PATH_ATTR.AS_PATH:
                    routeAttr.asPath = '';
                    attr.segments.forEach(seg => {
                        if (seg.typeName === 'AS_SEQUENCE') {
                            routeAttr.asPath += seg.asNumbers.join(' ');
                        } else {
                            routeAttr.asPath += `{${seg.asNumbers.join(' ')}}`;
                        }
                    });
                    break;
                case BgpConst.BGP_PATH_ATTR.NEXT_HOP:
                    routeAttr.nextHop = attr.nextHop;
                    break;
                case BgpConst.BGP_PATH_ATTR.LOCAL_PREF:
                    routeAttr.localPref = attr.localPref;
                    break;
                case BgpConst.BGP_PATH_ATTR.COMMUNITY:
                    routeAttr.communities = attr.communities.map(c => c.formatted).join(' ');
                    break;
                case BgpConst.BGP_PATH_ATTR.MED:
                    routeAttr.med = attr.med;
                    break;
                case BgpConst.BGP_PATH_ATTR.PATH_OTC:
                    routeAttr.otc = attr.otc;
                    break;
                case BgpConst.BGP_PATH_ATTR.PREFIX_SID:
                    routeAttr.prefixSid = attr.prefixSid?.formatted || null;
                    break;
                case BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI:
                    routeAttr.nextHop = attr.mpReach.nextHop;
            }
        }

        if (typeof route.assignRouteAttr === 'function') {
            route.assignRouteAttr(routeAttr);
        } else {
            Object.assign(route, routeAttr);
        }
    }

    setRouteNlri(route, nlri, afi, safi) {
        const normalizedPathId = BmpBgpRoute.normalizePathId(nlri.pathId);
        const normalizedRd = BmpBgpRoute.normalizeRd(nlri.rd);
        const nlriDetail = { ...nlri };
        delete nlriDetail.parseWarning;
        route.pathId = normalizedPathId;
        route.rd = normalizedRd;
        route.rdRaw = nlri.rdRaw || null;
        route.ip = nlri.displayPrefix || nlri.prefix;
        route.mask = nlri.length;
        route.afi = afi;
        route.safi = safi;
        route.labels = Array.isArray(nlri.labels)
            ? nlri.labels.map(label => label.display || `${label.label}${label.bottom ? '(BOS)' : ''}`).join(',')
            : null;
        route.routeType = nlri.routeType || null;
        route.nlriDetail = {
            ...nlriDetail,
            pathId: normalizedPathId,
            rd: normalizedRd
        };
        route.parseStatus = BmpBgpRoute.makeParseStatus(
            nlri.valid !== false,
            nlri.errors,
            nlri.parseWarning || nlri.warnings
        );
    }

    getRibTypesByFlags(sessionFlags) {
        const postPolicy = (sessionFlags & BmpConst.BMP_SESSION_FLAGS.POST_POLICY) !== 0;
        const adjRibOut = (sessionFlags & BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT) !== 0;

        if (adjRibOut) {
            return [postPolicy ? BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT : BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT];
        }

        return [postPolicy ? BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN : BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN];
    }

    formatPeerLogLine(peer) {
        if (!peer) {
            return '(unknown peer)';
        }

        return `type=${peer.peerType} rd=${peer.peerRd} peer=${peer.peerAddress} as=${peer.peerAs}`;
    }

    formatFlagsLogLine(rawFlags, effectiveFlags = rawFlags) {
        const raw = Number(rawFlags || 0);
        const effective = Number(effectiveFlags || 0);
        return `raw=0x${raw.toString(16).padStart(2, '0')} effective=0x${effective.toString(16).padStart(2, '0')}`;
    }

    logContextualRouteMonitoringDetail(peer, parsedBgpUpdate, options = {}) {
        if (!logger.shouldLog('info')) {
            return;
        }

        const detail = [
            `Received BMP Route Monitoring BGP detail (${options.scope || 'session'}, parsed with Peer Up capabilities)`,
            `Peer: ${this.formatPeerLogLine(peer)}`,
            `Flags: ${this.formatFlagsLogLine(options.rawFlags, options.effectiveFlags)}`
        ];

        if (Array.isArray(options.ribTypes) && options.ribTypes.length > 0) {
            detail.push(`RIB Types: ${options.ribTypes.join(',')}`);
        }

        detail.push(getBgpUpdateSummary(parsedBgpUpdate));
        logger.info(detail.join('\n'));
    }

    getEndOfRibAddressFamilies(parsedBgpUpdate) {
        const families = [];
        const withdrawn = parsedBgpUpdate.withdrawnRoutes || [];
        const nlri = parsedBgpUpdate.nlri || [];
        const attributes = parsedBgpUpdate.pathAttributes || [];
        if (
            Number(parsedBgpUpdate.withdrawnRoutesLength || 0) === 0 &&
            Number(parsedBgpUpdate.pathAttributesLength || 0) === 0 &&
            withdrawn.length === 0 &&
            attributes.length === 0 &&
            nlri.length === 0
        ) {
            families.push({
                afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
            });
        }

        if (attributes.length === 1 && attributes[0].typeCode === BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI) {
            const mpUnreach = attributes[0].mpUnreach;
            if (mpUnreach && (!mpUnreach.withdrawnRoutes || mpUnreach.withdrawnRoutes.length === 0)) {
                families.push({ afi: mpUnreach.afi, safi: mpUnreach.safi });
            }
        }
        return families;
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
                peerRdRaw: sessionRdRaw,
                peerAddress: sessionAddress,
                peerAs: sessionAs,
                peerTimestampMs: sourceTimestampMs
            } = peerHeader.peer;

            const bgpSessionKey = BmpBgpSession.makeKey(
                sessionType,
                sessionRd,
                sessionAddress,
                sessionAs,
                sessionRdRaw
            );
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
            const pathMarkingAssignments = this.buildPathMarkingAssignments(parsedBgpUpdate, routePayload.routeTlvs);
            const routeTlvAssignments = this.buildRouteTlvAssignments(parsedBgpUpdate, routePayload.routeTlvs);
            const effectiveSessionFlags =
                version === BmpConst.BMP_VERSION.V4 && this.isBmpV4TlvDraft20()
                    ? getEffectivePeerFlags(sessionFlags, routePayload.routeTlvs)
                    : sessionFlags;
            const routeVrfTableNames = this.decodeVrfTableNameTlvs(routePayload.routeTlvs);
            if (this.mergeVrfTableNames(bgpSession, routeVrfTableNames)) {
                this.invalidateRouteAssurance('session-vrf-metadata-change');
                this.sendSessionUpdateEvent(bgpSession);
            }

            if (parsedBgpUpdate.type !== BgpConst.BGP_PACKET_TYPE.UPDATE) {
                logger.error(`Route Monitoring contains non-UPDATE BGP message type: ${parsedBgpUpdate.type}`);
                return;
            }
            if (!parsedBgpUpdate.valid) {
                // Preserve partially decoded NLRI for diagnostics, but never allow an
                // invalid UPDATE to advance an EOR-gated stale sweep.
                logger.error(`Received BGP Update message is invalid: ${parsedBgpUpdate.error}`);
            }

            let isNotify = false;
            const ribTypes = this.getRibTypesByFlags(effectiveSessionFlags);
            if (ribTypes.length === 0) {
                logger.error(`Received BGP Update message from unknown rib type: ${effectiveSessionFlags}`);
                return;
            }
            this.logContextualRouteMonitoringDetail(peerHeader.peer, parsedBgpUpdate, {
                scope: 'session',
                rawFlags: sessionFlags,
                effectiveFlags: effectiveSessionFlags,
                ribTypes
            });

            if (parsedBgpUpdate.valid) {
                this.getEndOfRibAddressFamilies(parsedBgpUpdate).forEach(family => {
                    ribTypes.forEach(ribType => {
                        this.persistScopeState(
                            bgpSession,
                            family.afi,
                            family.safi,
                            ribType,
                            'peer',
                            'ready',
                            'scope_eor',
                            { sourceTimestampMs }
                        );
                        this.bmpWorker?.requestPersistenceSweep?.();
                    });
                });
            }

            // 处理withdrawn routes (IPv4)
            if (parsedBgpUpdate.withdrawnRoutes && parsedBgpUpdate.withdrawnRoutes.length > 0) {
                // 删除所有撤销的路由
                for (const ribType of ribTypes) {
                    this.ensureBgpSessionRouteScope(
                        bgpSession,
                        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                        ribType
                    );
                    for (const withdrawn of parsedBgpUpdate.withdrawnRoutes) {
                        this.persistSessionRouteWithdraw(
                            bgpSession,
                            withdrawn,
                            null,
                            BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                            BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                            ribType,
                            { sourceTimestampMs }
                        );
                        isNotify = true;
                    }

                    if (isNotify) {
                        this.sendRouteUpdateEvent(
                            BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE,
                            bgpSession,
                            getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST),
                            ribType
                        );
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
                // 删除所有撤销的路由
                for (const ribType of ribTypes) {
                    this.ensureBgpSessionRouteScope(bgpSession, mpUnreachNlri.afi, mpUnreachNlri.safi, ribType);
                    for (const withdrawn of mpUnreachNlri.withdrawnRoutes) {
                        this.persistSessionRouteWithdraw(
                            bgpSession,
                            withdrawn,
                            null,
                            mpUnreachNlri.afi,
                            mpUnreachNlri.safi,
                            ribType,
                            { sourceTimestampMs }
                        );
                        isNotify = true;
                    }

                    if (isNotify) {
                        this.sendRouteUpdateEvent(
                            BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE,
                            bgpSession,
                            getAddrFamilyType(mpUnreachNlri.afi, mpUnreachNlri.safi),
                            ribType
                        );
                    }
                }
            }

            isNotify = false;
            // 处理IPv4 NLRI
            if (parsedBgpUpdate.nlri && parsedBgpUpdate.nlri.length > 0) {
                for (const ribType of ribTypes) {
                    this.ensureBgpSessionRouteScope(
                        bgpSession,
                        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                        ribType
                    );
                    for (const nlri of parsedBgpUpdate.nlri) {
                        const bmpBgpRoute = new BmpBgpRoute(null, null);

                        this.setRouteNlri(
                            bmpBgpRoute,
                            nlri,
                            BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                            BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
                        );

                        // 设置路由属性
                        this.setRouteAttributes(bmpBgpRoute, parsedBgpUpdate);
                        this.applyPathMarkings(bmpBgpRoute, pathMarkingAssignments, nlri);
                        this.applyRouteTlvs(bmpBgpRoute, routeTlvAssignments, nlri);
                        bmpBgpRoute.markActive(
                            bgpSession.getRibEpoch(
                                BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                                BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                                ribType
                            )
                        );
                        this.persistSessionRouteUpsert(
                            bgpSession,
                            bmpBgpRoute,
                            BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                            BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                            ribType,
                            { sourceTimestampMs }
                        );

                        isNotify = true;
                    }
                    if (isNotify) {
                        this.sendRouteUpdateEvent(
                            BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
                            bgpSession,
                            getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST),
                            ribType
                        );
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
                for (const ribType of ribTypes) {
                    this.ensureBgpSessionRouteScope(bgpSession, mpReachNlri.afi, mpReachNlri.safi, ribType);
                    for (const nlri of mpReachNlri.nlri) {
                        const bmpBgpRoute = new BmpBgpRoute(null, null);

                        this.setRouteNlri(bmpBgpRoute, nlri, mpReachNlri.afi, mpReachNlri.safi);

                        // 设置路由属性
                        this.setRouteAttributes(bmpBgpRoute, parsedBgpUpdate);
                        this.applyPathMarkings(bmpBgpRoute, pathMarkingAssignments, nlri);
                        this.applyRouteTlvs(bmpBgpRoute, routeTlvAssignments, nlri);
                        bmpBgpRoute.markActive(bgpSession.getRibEpoch(mpReachNlri.afi, mpReachNlri.safi, ribType));
                        this.persistSessionRouteUpsert(
                            bgpSession,
                            bmpBgpRoute,
                            mpReachNlri.afi,
                            mpReachNlri.safi,
                            ribType,
                            { sourceTimestampMs }
                        );

                        isNotify = true;
                    }

                    if (isNotify) {
                        this.sendRouteUpdateEvent(
                            BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
                            bgpSession,
                            getAddrFamilyType(mpReachNlri.afi, mpReachNlri.safi),
                            ribType
                        );
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
            const sourceTimestampMs = locRibPeer.peerTimestampMs;

            const routePayload = this.parseRouteMonitoringBgpUpdate(
                message,
                position,
                version,
                this.createLocRibBgpParsingContext(locRibPeer),
                locRibPeer.peerFlags,
                locRibPeer.peerType
            );
            if (routePayload.error) {
                logger.error(routePayload.error);
                return;
            }
            const parsedBgpUpdate = routePayload.parsedBgpUpdate;
            const pathMarkingAssignments = this.buildPathMarkingAssignments(parsedBgpUpdate, routePayload.routeTlvs);
            const routeTlvAssignments = this.buildRouteTlvAssignments(parsedBgpUpdate, routePayload.routeTlvs);
            const effectiveLocRibFlags =
                version === BmpConst.BMP_VERSION.V4 && this.isBmpV4TlvDraft20()
                    ? getEffectivePeerFlags(locRibPeer.peerFlags, routePayload.routeTlvs)
                    : locRibPeer.peerFlags;

            if (parsedBgpUpdate.type !== BgpConst.BGP_PACKET_TYPE.UPDATE) {
                logger.error(`Route Monitoring contains non-UPDATE BGP message type: ${parsedBgpUpdate.type}`);
                return;
            }
            if (!parsedBgpUpdate.valid) {
                logger.error(`Received BGP Update message is invalid: ${parsedBgpUpdate.error}`);
            }
            this.logContextualRouteMonitoringDetail(locRibPeer, parsedBgpUpdate, {
                scope: 'loc-rib',
                rawFlags: locRibPeer.peerFlags,
                effectiveFlags: effectiveLocRibFlags
            });

            if (parsedBgpUpdate.valid) {
                this.getEndOfRibAddressFamilies(parsedBgpUpdate).forEach(family => {
                    const bgpInstance = this.getOrCreateLocRibInstance(locRibPeer, family.afi, family.safi, {
                        routeTlvs: routePayload.routeTlvs
                    });
                    this.persistScopeState(
                        bgpInstance,
                        family.afi,
                        family.safi,
                        'loc-rib',
                        'loc-rib',
                        'ready',
                        'scope_eor',
                        { sourceTimestampMs }
                    );
                    this.bmpWorker?.requestPersistenceSweep?.();
                });
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
                    this.persistInstanceRouteWithdraw(
                        bgpInstance,
                        withdrawn,
                        null,
                        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                        { sourceTimestampMs }
                    );
                    isNotify = true;
                }

                if (isNotify) {
                    this.sendInstanceRouteUpdateEvent(
                        BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE,
                        bgpInstance,
                        getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
                    );
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
                    this.persistInstanceRouteWithdraw(
                        bgpInstance,
                        withdrawn,
                        null,
                        mpUnreachNlri.afi,
                        mpUnreachNlri.safi,
                        { sourceTimestampMs }
                    );
                    isNotify = true;
                }

                if (isNotify) {
                    this.sendInstanceRouteUpdateEvent(
                        BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_DELETE,
                        bgpInstance,
                        getAddrFamilyType(mpUnreachNlri.afi, mpUnreachNlri.safi)
                    );
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
                    const bmpBgpRoute = new BmpBgpRoute(null, null);

                    this.setRouteNlri(
                        bmpBgpRoute,
                        nlri,
                        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
                    );

                    // 设置路由属性
                    this.setRouteAttributes(bmpBgpRoute, parsedBgpUpdate);
                    this.applyPathMarkings(bmpBgpRoute, pathMarkingAssignments, nlri);
                    this.applyRouteTlvs(bmpBgpRoute, routeTlvAssignments, nlri);
                    bmpBgpRoute.markActive(bgpInstance.getRibEpoch());
                    this.persistInstanceRouteUpsert(
                        bgpInstance,
                        bmpBgpRoute,
                        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
                        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
                        { sourceTimestampMs }
                    );

                    isNotify = true;
                }

                if (isNotify) {
                    this.sendInstanceRouteUpdateEvent(
                        BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
                        bgpInstance,
                        getAddrFamilyType(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
                    );
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
                    const bmpBgpRoute = new BmpBgpRoute(null, null);

                    this.setRouteNlri(bmpBgpRoute, nlri, mpReachNlri.afi, mpReachNlri.safi);

                    // 设置路由属性
                    this.setRouteAttributes(bmpBgpRoute, parsedBgpUpdate);
                    this.applyPathMarkings(bmpBgpRoute, pathMarkingAssignments, nlri);
                    this.applyRouteTlvs(bmpBgpRoute, routeTlvAssignments, nlri);
                    bmpBgpRoute.markActive(bgpInstance.getRibEpoch());
                    this.persistInstanceRouteUpsert(bgpInstance, bmpBgpRoute, mpReachNlri.afi, mpReachNlri.safi, {
                        sourceTimestampMs
                    });

                    isNotify = true;
                }

                if (isNotify) {
                    this.sendInstanceRouteUpdateEvent(
                        BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
                        bgpInstance,
                        getAddrFamilyType(mpReachNlri.afi, mpReachNlri.safi)
                    );
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

    replaceAddressFamilies(target, source, touchedKeys) {
        if (!Array.isArray(target) || !(touchedKeys instanceof Set) || touchedKeys.size === 0) {
            return;
        }
        const sourceByKey = new Map(
            (Array.isArray(source) ? source : []).map(item => [`${item.afi}|${item.safi}`, item])
        );
        const replacedKeys = new Set();
        const next = [];
        target.forEach(item => {
            const key = `${item.afi}|${item.safi}`;
            if (!touchedKeys.has(key)) {
                next.push(item);
            } else if (sourceByKey.has(key) && !replacedKeys.has(key)) {
                next.push(sourceByKey.get(key));
                replacedKeys.add(key);
            }
        });
        sourceByKey.forEach((item, key) => {
            if (touchedKeys.has(key) && !replacedKeys.has(key)) {
                next.push(item);
            }
        });
        target.splice(0, target.length, ...next);
    }

    markSessionRoutesStale(bgpSession, addressFamilies, ribTypes, reason) {
        if (!bgpSession || !Array.isArray(addressFamilies)) {
            return [];
        }

        // A null RIB filter asks the owner to derive the exact tracked RIB
        // scopes for each AFI/SAFI. This avoids creating empty cross-product
        // scopes when a lifecycle event applies to the whole peer.
        const targetRibTypes = Array.isArray(ribTypes) && ribTypes.length > 0 ? ribTypes : null;
        const updates = [];
        addressFamilies.forEach(addrFamily => {
            const staleResults = bgpSession.markRoutesStale(
                Number(addrFamily.afi),
                Number(addrFamily.safi),
                targetRibTypes,
                reason
            );
            staleResults.forEach(result => {
                this.persistScopeState(
                    bgpSession,
                    result.afi,
                    result.safi,
                    result.ribType,
                    'peer',
                    'stale',
                    'scope_stale',
                    { reason }
                );
                // The authoritative counters are in SQLite. Always notify the UI
                // that the scope changed; the next read refreshes its cached summary.
                updates.push(result);
            });
        });
        return updates;
    }

    sendSessionStaleEvents(bgpSession, staleUpdates) {
        staleUpdates.forEach(update => {
            this.sendRouteUpdateEvent(
                BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_STALE,
                bgpSession,
                getAddrFamilyType(update.afi, update.safi),
                update.ribType,
                update.changed
            );
        });
    }

    requestNotificationPeerRoutePurge(bgpSession, reason, staleUpdates) {
        if (!bgpSession || !this.bmpWorker || typeof this.bmpWorker.requestNotificationPeerRoutePurge !== 'function') {
            return false;
        }

        const sourceId = this.getPersistentSourceId();
        const ownerKey = this.getSessionOwnerKey(bgpSession);
        if (!sourceId || !ownerKey) {
            return false;
        }

        const scopes = (Array.isArray(staleUpdates) ? staleUpdates : []).map(update => ({
            scopeId: this.getPersistenceScopeId(
                bgpSession,
                Number(update.afi),
                Number(update.safi),
                update.ribType,
                'peer'
            ),
            afi: Number(update.afi),
            safi: Number(update.safi),
            ribType: update.ribType,
            ribEpochBefore: Number(update.staleEpoch)
        }));
        if (scopes.length === 0) {
            return true;
        }

        const requested = this.bmpWorker.requestNotificationPeerRoutePurge({
            sourceId,
            ownerKey,
            scopeKind: 'peer',
            scopes,
            reason: `peer-down-notification:${reason}`
        });
        return requested !== false;
    }

    markInstanceRoutesStale(bgpInstance, reason) {
        if (!bgpInstance) {
            return { changed: 0 };
        }
        const result = bgpInstance.markRoutesStale(reason);
        this.persistScopeState(
            bgpInstance,
            bgpInstance.afi,
            bgpInstance.safi,
            'loc-rib',
            'loc-rib',
            'stale',
            'scope_stale',
            { reason }
        );
        return result;
    }

    sendInstanceStaleEvent(bgpInstance) {
        this.sendInstanceRouteUpdateEvent(
            BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_STALE,
            bgpInstance,
            getAddrFamilyType(bgpInstance.afi, bgpInstance.safi)
        );
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
        const persistentSourceId = this.getPersistentSourceId();
        return {
            persistentSourceId,
            sourceId: persistentSourceId,
            persistentConnectionId: this.persistenceConnectionId || null,
            connectionState: this.persistenceConnectionClosed ? 'closed' : 'open',
            isOnline: !this.persistenceConnectionClosed && Boolean(this.socket) && this.socket.destroyed !== true,
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

    getClientRouteEventInfo() {
        const persistentSourceId = this.getPersistentSourceId();
        return {
            persistentSourceId,
            sourceId: persistentSourceId,
            localIp: this.localIp,
            localPort: this.localPort,
            remoteIp: this.remoteIp,
            remotePort: this.remotePort
        };
    }

    getPersistentSourceId() {
        return this.persistenceSourceKey?.keyHex || null;
    }

    getSessionOwnerKey(bgpSession) {
        return BmpBgpSession.makeKey(
            bgpSession.sessionType,
            bgpSession.sessionRd,
            bgpSession.sessionIp,
            bgpSession.sessionAs,
            bgpSession.sessionRdRaw
        );
    }

    getInstanceOwnerKey(bgpInstance) {
        return BmpBgpInstance.makeKey(
            bgpInstance.instanceType,
            bgpInstance.instanceRd,
            bgpInstance.afi,
            bgpInstance.safi,
            bgpInstance.instanceRdRaw
        );
    }

    getSessionScopeEventInfo(bgpSession, af, ribType) {
        const routeScopes = Array.from(bgpSession.routeScopes?.values?.() || []);
        const scope = routeScopes.find(
            item => getAddrFamilyType(Number(item.afi), Number(item.safi)) === Number(af) && item.ribType === ribType
        );
        if (!scope) {
            return null;
        }
        const scopeId = this.getPersistenceScopeId(
            bgpSession,
            Number(scope.afi),
            Number(scope.safi),
            scope.ribType,
            'peer'
        );
        return {
            persistentScopeId: scopeId,
            scopeId,
            afi: Number(scope.afi),
            safi: Number(scope.safi),
            addrFamilyType: getAddrFamilyType(Number(scope.afi), Number(scope.safi)),
            ribType: scope.ribType
        };
    }

    getSessionUpdateEventInfo(bgpSession) {
        if (this.bmpWorker && typeof this.bmpWorker.buildLiveSessionTopology === 'function') {
            return this.bmpWorker.buildLiveSessionTopology(this, bgpSession);
        }

        const ownerKey = this.getSessionOwnerKey(bgpSession);
        const routeScopes = Array.from(bgpSession.routeScopes?.values?.() || [], scope => {
            const persistentScopeId = this.getPersistenceScopeId(
                bgpSession,
                Number(scope.afi),
                Number(scope.safi),
                scope.ribType,
                'peer'
            );
            return {
                persistentScopeId,
                scopeId: persistentScopeId,
                persistentOwnerKey: ownerKey,
                ownerKey,
                afi: Number(scope.afi),
                safi: Number(scope.safi),
                addrFamilyType: getAddrFamilyType(Number(scope.afi), Number(scope.safi)),
                ribType: scope.ribType,
                routeSummary: bgpSession.getRouteSummary(scope.afi, scope.safi, scope.ribType)
            };
        });
        const sourceId = this.getPersistentSourceId();
        return {
            ...bgpSession.getSessionInfo(),
            persistentSourceId: sourceId,
            sourceId,
            persistentOwnerKey: ownerKey,
            ownerKey,
            persistentConnectionId: this.persistenceConnectionId || null,
            connectionState: this.persistenceConnectionClosed ? 'closed' : 'open',
            isOnline: bgpSession.sessionState === BmpConst.BMP_SESSION_STATE.PEER_UP,
            routeScopes
        };
    }

    getInstanceUpdateEventInfo(bgpInstance) {
        if (this.bmpWorker && typeof this.bmpWorker.buildLiveInstanceTopology === 'function') {
            return this.bmpWorker.buildLiveInstanceTopology(this, bgpInstance);
        }

        const ownerKey = this.getInstanceOwnerKey(bgpInstance);
        const persistentScopeId = this.getPersistenceScopeId(
            bgpInstance,
            Number(bgpInstance.afi),
            Number(bgpInstance.safi),
            'loc-rib',
            'loc-rib'
        );
        const sourceId = this.getPersistentSourceId();
        const routeSummary = bgpInstance.getRouteSummary();
        const routeScope = {
            persistentScopeId,
            scopeId: persistentScopeId,
            persistentOwnerKey: ownerKey,
            ownerKey,
            afi: Number(bgpInstance.afi),
            safi: Number(bgpInstance.safi),
            addrFamilyType: getAddrFamilyType(Number(bgpInstance.afi), Number(bgpInstance.safi)),
            ribType: 'loc-rib',
            routeSummary
        };
        return {
            ...bgpInstance.getInstanceInfo(),
            persistentSourceId: sourceId,
            sourceId,
            persistentOwnerKey: ownerKey,
            ownerKey,
            persistentScopeId,
            scopeId: persistentScopeId,
            persistentConnectionId: this.persistenceConnectionId || null,
            connectionState: this.persistenceConnectionClosed ? 'closed' : 'open',
            isOnline: bgpInstance.instanceState === BmpConst.BMP_SESSION_STATE.PEER_UP,
            routeScopes: [routeScope],
            routeSummary
        };
    }

    sendSessionUpdateEvent(bgpSession) {
        if (!bgpSession) {
            return false;
        }
        const session = this.getSessionUpdateEventInfo(bgpSession);
        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.SESSION_UPDATE, {
            data: {
                client: this.getClientInfo(),
                session
            }
        });
        return true;
    }

    sendInstanceUpdateEvent(bgpInstance) {
        if (!bgpInstance) {
            return false;
        }
        const instance = this.getInstanceUpdateEventInfo(bgpInstance);
        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE, {
            data: {
                client: this.getClientInfo(),
                instance
            }
        });
        return true;
    }

    getSessionRouteEventInfo(bgpSession, af, ribType) {
        const ownerKey = this.getSessionOwnerKey(bgpSession);
        const scope = this.getSessionScopeEventInfo(bgpSession, af, ribType);
        return {
            sessionType: bgpSession.sessionType,
            sessionRd: bgpSession.sessionRd,
            sessionRdRaw: bgpSession.sessionRdRaw,
            sessionIp: bgpSession.sessionIp,
            sessionAs: bgpSession.sessionAs,
            persistentOwnerKey: ownerKey,
            ownerKey,
            persistentScopeId: scope?.persistentScopeId || null,
            scopeId: scope?.scopeId || null
        };
    }

    getInstanceRouteEventInfo(bgpInstance) {
        const ownerKey = this.getInstanceOwnerKey(bgpInstance);
        const scopeId = this.getPersistenceScopeId(
            bgpInstance,
            Number(bgpInstance.afi),
            Number(bgpInstance.safi),
            'loc-rib',
            'loc-rib'
        );
        return {
            instanceType: bgpInstance.instanceType,
            instanceRd: bgpInstance.instanceRd,
            instanceRdRaw: bgpInstance.instanceRdRaw,
            addrFamilyType: getAddrFamilyType(bgpInstance.afi, bgpInstance.safi),
            persistentOwnerKey: ownerKey,
            ownerKey,
            persistentScopeId: scopeId,
            scopeId
        };
    }

    sendRouteUpdateEvent(type, bgpSession, af, ribType, changedCount = 1) {
        const session = this.getSessionRouteEventInfo(bgpSession, af, ribType);
        const client = this.getClientRouteEventInfo();
        const update = {
            type,
            client,
            session,
            persistentSourceId: client.persistentSourceId,
            sourceId: client.sourceId,
            persistentOwnerKey: session.persistentOwnerKey,
            ownerKey: session.ownerKey,
            persistentScopeId: session.persistentScopeId,
            scopeId: session.scopeId,
            af,
            ribType,
            changedCount,
            assuranceIncremental: true
        };

        if (this.bmpWorker && typeof this.bmpWorker.enqueueRouteUpdateEvent === 'function') {
            this.bmpWorker.enqueueRouteUpdateEvent(update);
            return;
        }

        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.ROUTE_UPDATE, { data: update });
    }

    sendInstanceRouteUpdateEvent(type, bgpInstance, af, changedCount = 1) {
        const instance = this.getInstanceRouteEventInfo(bgpInstance);
        const client = this.getClientRouteEventInfo();
        const update = {
            type,
            client,
            instance,
            persistentSourceId: client.persistentSourceId,
            sourceId: client.sourceId,
            persistentOwnerKey: instance.persistentOwnerKey,
            ownerKey: instance.ownerKey,
            persistentScopeId: instance.persistentScopeId,
            scopeId: instance.scopeId,
            af,
            changedCount,
            assuranceIncremental: true
        };

        if (this.bmpWorker && typeof this.bmpWorker.enqueueInstanceRouteUpdateEvent === 'function') {
            this.bmpWorker.enqueueInstanceRouteUpdateEvent(update);
            return;
        }

        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.INSTANCE_ROUTE_UPDATE, { data: update });
    }

    invalidateRouteAssurance(reason) {
        if (this.bmpWorker && typeof this.bmpWorker.invalidateRouteAssurance === 'function') {
            this.bmpWorker.invalidateRouteAssurance(reason);
        }
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
                    case BmpConst.BMP_INITIATION_TLV_TYPE.STRING:
                        if (!tlv.enterprise) {
                            tlv.valueText = tlv.value.toString('utf8');
                        }
                        break;
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

            this.persistConnectionOpen();
            this.persistSourceUpdate();
            // Persistence context supplies the stable source ID used to merge the
            // live connection with its SQLite-backed offline topology.
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
                peerRdRaw: sessionRdRaw,
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

            const sessKey = BmpBgpSession.makeKey(sessionType, sessionRd, sessionAddress, sessionAs, sessionRdRaw);
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
                    ...bgpSession
                        .getRouteScopeAddressFamilies()
                        .map(addrFamily => `${addrFamily.afi}|${addrFamily.safi}`)
                ])
            );

            const staleAddressFamilies = addressFamilyKeys.map(key => {
                const [afi, safi] = key.split('|').map(value => Number(value));
                return { afi, safi };
            });
            // Peer header policy/RIB flags classify Route Monitoring messages,
            // but Peer Down applies to the complete BGP peering session. Derive
            // the exact tracked RIB scopes per AFI/SAFI instead of limiting the
            // event to the header's (often pre-policy) view.
            const staleUpdates = this.markSessionRoutesStale(
                bgpSession,
                staleAddressFamilies,
                null,
                `peer-down:${reason}`
            );
            bgpSession.sessionState = BmpConst.BMP_SESSION_STATE.PEER_DOWN;
            bgpSession.peerUpAddressFamilyKeys.clear();

            const purgeRequested =
                peerDownPayload.hasValidBgpNotification &&
                this.requestNotificationPeerRoutePurge(bgpSession, reason, staleUpdates);
            if (purgeRequested) {
                logger.info(
                    `Peer Down with a valid BGP Notification is deleting routes from ${staleUpdates.length} peer scopes for ${sessKey}`
                );
            } else {
                this.sendSessionStaleEvents(bgpSession, staleUpdates);
                this.bmpWorker?.requestPersistenceSweep?.();
                if (addressFamilyKeys.length > 1) {
                    logger.info(
                        `Peer Down marked ${addressFamilyKeys.length} address families stale for ${sessKey}; keeping routes until refresh, withdraw, purge, or BMP close`
                    );
                }
            }

            this.sendSessionUpdateEvent(bgpSession);
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
            const { peerType: instanceType, peerRd: instanceRd, peerRdRaw: instanceRdRaw } = peerHeader.peer;

            const reason = message[position];
            position += 1;
            const peerDownPayload = this.parsePeerDownPayload(message, position, reason, version);
            const peerDownVrfTableNames = this.decodeVrfTableNameTlvs(peerDownPayload.tlvs);

            const rdIdentity = instanceRdRaw || instanceRd;
            const prefix = `${instanceType}|${rdIdentity}|`;
            const candidates = [];
            this.bgpInstanceMap.forEach((instance, key) => {
                if (
                    instance.instanceType !== instanceType ||
                    (instance.instanceRdRaw || instance.instanceRd) !== rdIdentity
                ) {
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

            candidates.forEach(({ instance }) => {
                this.markInstanceRoutesStale(instance, `loc-rib-peer-down:${reason}`);
                instance.instanceState = BmpConst.BMP_SESSION_STATE.PEER_DOWN;
                instance.peerUpSeen = false;
                this.sendInstanceStaleEvent(instance);
                this.sendInstanceUpdateEvent(instance);
            });
            this.bmpWorker?.requestPersistenceSweep?.();

            if (candidates.length > 1) {
                logger.info(
                    `Loc-RIB Peer Down marked ${candidates.length} address families stale for ${prefix}; keeping routes until refresh, withdraw, purge, or BMP close`
                );
            }
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
            const sessionRdRaw = `raw:${rdBuffer.toString('hex')}`;

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
            const sessionTimestampMicroseconds = message.readUInt32BE(position);
            position += 4;
            const sessionTimestampMs = toUnixTimestampMs(sessionTimestamp, sessionTimestampMicroseconds);

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
            const vrfTableNames = this.decodeVrfTableNameTlvs(peerUpTlvs);
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

            const incomingAddressFamilyKeys = new Set([
                ...recvAddressFamilies.map(item => `${item.afi}|${item.safi}`),
                ...sentAddressFamilies.map(item => `${item.afi}|${item.safi}`)
            ]);

            const bgpSessionKey = BmpBgpSession.makeKey(
                sessionType,
                sessionRd,
                sessionAddress,
                sessionAs,
                sessionRdRaw
            );
            let bgpSession = this.bgpSessionMap.get(bgpSessionKey);
            const mergePeerUpCapabilities = bgpSession?.sessionState === BmpConst.BMP_SESSION_STATE.PEER_UP;
            if (!bgpSession) {
                bgpSession = new BmpBgpSession(this);
                this.bgpSessionMap.set(bgpSessionKey, bgpSession);
            } else if (mergePeerUpCapabilities) {
                const staleAddressFamilies = Array.from(incomingAddressFamilyKeys)
                    .filter(key => bgpSession.peerUpAddressFamilyKeys.has(key))
                    .map(key => {
                        const [afi, safi] = key.split('|').map(Number);
                        return { afi, safi };
                    });
                const staleUpdates = this.markSessionRoutesStale(
                    bgpSession,
                    staleAddressFamilies,
                    null,
                    'peer-up-refresh'
                );
                this.sendSessionStaleEvents(bgpSession, staleUpdates);
            }

            // Some routers split one logical Peer Up across multiple messages, often
            // one AFI/SAFI at a time. Treat omitted families as unchanged on the same
            // BMP connection. Peer Down or connection close ends the current peer
            // generation; only a validated Peer Down Notification hard-deletes its
            // old routes. A repeated family is still a fresh epoch.
            if (!mergePeerUpCapabilities) {
                bgpSession.enabledAddressFamilies = [];
                bgpSession.recvAddressFamilies = [];
                bgpSession.sendAddressFamilies = [];
                bgpSession.recvAddPathMap.clear();
                bgpSession.sendAddPathMap.clear();
                bgpSession.addPathReceiveMap.clear();
                bgpSession.addPathSendMap.clear();
                bgpSession.addPathMap.clear();
                bgpSession.peerUpAddressFamilyKeys.clear();
            }
            const incomingCapabilityKeys = new Set([
                ...incomingAddressFamilyKeys,
                ...recvAddPaths.keys(),
                ...sendAddPaths.keys()
            ]);
            const incomingCapabilityAddressFamilies = Array.from(incomingCapabilityKeys, key => {
                const [afi, safi] = key.split('|').map(Number);
                return { afi, safi };
            });
            this.clearSessionAddPathByAddressFamilies(bgpSession, incomingCapabilityAddressFamilies);
            this.replaceAddressFamilies(
                bgpSession.enabledAddressFamilies,
                enabledAddressFamilies,
                incomingAddressFamilyKeys
            );
            this.replaceAddressFamilies(bgpSession.recvAddressFamilies, recvAddressFamilies, incomingAddressFamilyKeys);
            this.replaceAddressFamilies(bgpSession.sendAddressFamilies, sentAddressFamilies, incomingAddressFamilyKeys);
            incomingAddressFamilyKeys.forEach(key => bgpSession.peerUpAddressFamilyKeys.add(key));

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

            recvAddPaths.forEach((mode, key) => bgpSession.recvAddPathMap.set(key, mode));
            sendAddPaths.forEach((mode, key) => bgpSession.sendAddPathMap.set(key, mode));

            bgpSession.sessionFlags = (bgpSession.sessionFlags || 0) | effectiveSessionFlags;
            bgpSession.rawSessionFlags = sessionFlags;
            bgpSession.peerUpTlvs = peerUpTlvs;
            this.mergeVrfTableNames(bgpSession, vrfTableNames);

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

            // 正常相同bgp Session这些字段一样
            bgpSession.sessionType = sessionType;
            bgpSession.sessionFlags = effectiveSessionFlags;
            bgpSession.sessionRd = sessionRd;
            bgpSession.sessionRdRaw = sessionRdRaw;
            bgpSession.sessionIp = sessionAddress;
            bgpSession.sessionAs = sessionAs;
            bgpSession.sessionRouterId = sessionRouterId;
            bgpSession.sessionTimestamp = sessionTimestamp;
            bgpSession.sessionTimestampMicroseconds = sessionTimestampMicroseconds;
            bgpSession.sessionTimestampMs = sessionTimestampMs;
            bgpSession.localIp = localAddress;
            bgpSession.localPort = localPort;
            bgpSession.remotePort = remotePort;
            bgpSession.sessionState = BmpConst.BMP_SESSION_STATE.PEER_UP;

            const scopeAddressFamilies = new Set(enabledAddressFamilies.map(item => `${item.afi}|${item.safi}`));
            scopeAddressFamilies.forEach(afKey => {
                const [afi, safi] = afKey.split('|').map(Number);
                bgpSession.ribTypes.forEach(ribType => {
                    bgpSession.ensureRouteScope(afi, safi, ribType);
                    this.persistScopeState(bgpSession, afi, safi, ribType, 'peer', 'syncing', 'scope_open', {
                        sourceTimestampMs: sessionTimestampMs
                    });
                });
            });
            this.bmpWorker?.requestPersistenceSweep?.();

            this.sendSessionUpdateEvent(bgpSession);
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
                peerRdRaw: instanceRdRaw,
                peerAddress: instanceAddress,
                peerAs: instanceAs,
                peerRouterId: instanceRouterId,
                peerTimestamp: instanceTimestamp,
                peerTimestampMicroseconds: instanceTimestampMicroseconds,
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

                const instanceKey = BmpBgpInstance.makeKey(
                    instanceType,
                    instanceRd,
                    enabledAF.afi,
                    enabledAF.safi,
                    instanceRdRaw
                );
                let bgpInstance = this.bgpInstanceMap.get(instanceKey);
                if (!bgpInstance) {
                    bgpInstance = new BmpBgpInstance(this);
                    this.bgpInstanceMap.set(instanceKey, bgpInstance);
                } else {
                    if (bgpInstance.peerUpSeen && bgpInstance.instanceState === BmpConst.BMP_SESSION_STATE.PEER_UP) {
                        this.markInstanceRoutesStale(bgpInstance, 'peer-up-refresh');
                        this.sendInstanceStaleEvent(bgpInstance);
                    }
                    bgpInstance.recvAddPathMap.clear();
                    bgpInstance.sendAddPathMap.clear();
                    bgpInstance.addPathReceiveMap.clear();
                    bgpInstance.addPathSendMap.clear();
                    bgpInstance.isAddPath = false;
                }

                bgpInstance.enabledAddressFamilies = enabledAddressFamilies.map(item => ({ ...item }));
                bgpInstance.recvAddressFamilies = recvAddressFamilies.map(item => ({ ...item }));
                bgpInstance.sendAddressFamilies = sentAddressFamilies.map(item => ({ ...item }));

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
                bgpInstance.instanceRdRaw = instanceRdRaw || null;
                bgpInstance.instanceIp = instanceAddress;
                bgpInstance.instanceAs = instanceAs;
                bgpInstance.instanceRouterId = instanceRouterId;
                bgpInstance.instanceTimestamp = instanceTimestamp;
                bgpInstance.instanceTimestampMicroseconds = instanceTimestampMicroseconds;
                bgpInstance.instanceTimestampMs = instanceTimestampMs;
                bgpInstance.localIp = localAddress;
                bgpInstance.localPort = localPort;
                bgpInstance.remotePort = remotePort;
                bgpInstance.instanceState = BmpConst.BMP_SESSION_STATE.PEER_UP;
                bgpInstance.peerUpSeen = true;
                this.persistScopeState(
                    bgpInstance,
                    enabledAF.afi,
                    enabledAF.safi,
                    'loc-rib',
                    'loc-rib',
                    'syncing',
                    'scope_open',
                    { sourceTimestampMs: instanceTimestampMs }
                );
            });
            this.bmpWorker?.requestPersistenceSweep?.();

            const allKeys = new Set([...recvAddPaths.keys(), ...sendAddPaths.keys()]);
            allKeys.forEach(key => {
                const recvMode = recvAddPaths.get(key); // Remote Peer's mode
                const sendMode = sendAddPaths.get(key); // Monitored Router's mode
                const receive = this.canRouterReceiveAddPath(recvMode, sendMode);
                const send = this.canRouterSendAddPath(recvMode, sendMode);

                const [afi, safi] = key.split('|');
                const instanceKey = BmpBgpInstance.makeKey(instanceType, instanceRd, afi, safi, instanceRdRaw);
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

            enabledAddressFamilies.forEach(enabledAF => {
                const instanceKey = BmpBgpInstance.makeKey(
                    instanceType,
                    instanceRd,
                    enabledAF.afi,
                    enabledAF.safi,
                    instanceRdRaw
                );
                const bgpInstance = this.bgpInstanceMap.get(instanceKey);
                if (bgpInstance) {
                    this.sendInstanceUpdateEvent(bgpInstance);
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
        this.closeSession();
        const clientInfo = this.getClientInfo();
        this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.TERMINATION, { data: clientInfo });

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
                peerRdRaw: sessionRdRaw,
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

            const effectiveSessionFlags =
                version === BmpConst.BMP_VERSION.V4 && this.isBmpV4TlvDraft20()
                    ? getEffectivePeerFlags(sessionFlags, tlvs)
                    : sessionFlags;
            const ribType = this.getRibTypesByFlags(effectiveSessionFlags)[0];

            const bgpSessionKey = BmpBgpSession.makeKey(
                sessionType,
                sessionRd,
                sessionAddress,
                sessionAs,
                sessionRdRaw
            );
            const bgpSession = this.bgpSessionMap.get(bgpSessionKey);
            const baseSessionInfo = bgpSession
                ? bgpSession.getSessionInfo()
                : {
                      sessionType,
                      sessionRd,
                      sessionRdRaw,
                      sessionIp: sessionAddress,
                      sessionAs,
                      sessionRouterId,
                      sessionTimestamp,
                      sessionTimestampMs
                  };
            const sessionInfo = {
                ...baseSessionInfo,
                sessionFlags: effectiveSessionFlags,
                rawSessionFlags: sessionFlags
            };

            const report = {
                client: this.getClientInfo(),
                session: sessionInfo,
                rawSessionFlags: sessionFlags,
                sessionFlags: effectiveSessionFlags,
                effectiveSessionFlags,
                ribType,
                statistics: statistics,
                tlvs: toSerializableTlvs(tlvs),
                updatedAt: new Date().toISOString()
            };
            splitSessionStatisticsReport(report).forEach(ribReport => {
                this.bgpStatisticsReportMap.set(
                    BmpSession.makeStatisticsReportKey(...getSessionStatisticsReportIdentityParts(ribReport)),
                    ribReport
                );
                this.persistStatistics(ribReport, sessionTimestampMs);
                this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT, {
                    data: ribReport
                });
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
                peerRdRaw: instanceRdRaw,
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
            const rdIdentity = instanceRdRaw || instanceRd;
            this.bgpInstanceMap.forEach(instance => {
                if (
                    instance.instanceType === instanceType &&
                    (instance.instanceRdRaw || instance.instanceRd) === rdIdentity &&
                    Array.isArray(instance.vrfTableNames)
                ) {
                    vrfTableNames.push(...instance.vrfTableNames);
                }
            });

            const report = {
                client: this.getClientInfo(),
                instance: {
                    instanceType,
                    instanceFlags,
                    instanceRd,
                    instanceRdRaw,
                    instanceIp,
                    instanceAs,
                    instanceRouterId,
                    instanceTimestamp,
                    instanceTimestampMs,
                    vrfTableNames: Array.from(new Set(vrfTableNames))
                },
                statistics: statistics,
                tlvs: toSerializableTlvs(tlvs),
                updatedAt: new Date().toISOString()
            };
            this.bgpInstanceStatisticsReportMap.set(
                BmpSession.makeStatisticsReportKey(instanceType, instanceRdRaw || instanceRd),
                report
            );

            this.persistStatistics(report, instanceTimestampMs);
            this.messageHandler.sendEvent(BmpConst.BMP_EVT_TYPES.STATISTICS_REPORT, { data: report });
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
            if (
                version === BmpConst.BMP_VERSION.V4 &&
                this.isBmpV4TlvDraft20() &&
                type !== BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING &&
                logger.shouldLog('info')
            ) {
                const parsedPacket = parseBmpPacket(message);
                logger.info(`Received BMP packet detail:\n${getBmpPacketSummary(parsedPacket)}`);
            }

            const msg = message.slice(BmpConst.BMP_HEADER_LENGTH, length);

            if (
                type === BmpConst.BMP_MSG_TYPE.PEER_DOWN_NOTIFICATION ||
                type === BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION ||
                type === BmpConst.BMP_MSG_TYPE.INITIATION ||
                type === BmpConst.BMP_MSG_TYPE.TERMINATION
            ) {
                this.invalidateRouteAssurance(`bmp-message-${type}`);
            }

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
        this.invalidateRouteAssurance('bmp-session-close');
        this.persistConnectionClose('bmp-session-close');
        // Close direct socket if exists
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }

        this.bgpSessionMap.forEach((peer, _) => {
            peer.closeSession();
        });
        this.bgpInstanceMap.forEach((instance, _) => {
            instance.closeInstance();
        });

        this.bgpSessionMap.clear();
        this.bgpStatisticsReportMap.clear();
        this.bgpInstanceStatisticsReportMap.clear();
        this.instAddPathMap.clear();
        this.instAddPathReceiveMap.clear();
        this.instAddPathSendMap.clear();
        this.bgpInstanceMap.clear();
    }
}

module.exports = BmpSession;
