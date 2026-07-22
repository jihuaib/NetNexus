const fs = require('fs');
const BmpConst = require('../../electron/const/bmpConst');
const BgpConst = require('../../electron/const/bgpConst');
const { parsePeerHeader, parseBmpTlvs } = require('../../electron/utils/bmpUtils');
const { parseBgpPacket } = require('../../electron/utils/bgpPacketParser');

const LEGACY_ROUTE_TLV = Object.freeze({
    VRF_TABLE_NAME: 3,
    BGP_MESSAGE: 4,
    PATH_MARKING: 5
});

function ribTypeFromFlags(flags) {
    const postPolicy = (flags & BmpConst.BMP_SESSION_FLAGS.POST_POLICY) !== 0;
    const adjRibOut = (flags & BmpConst.BMP_SESSION_FLAGS.ADJ_RIB_OUT) !== 0;
    if (adjRibOut) {
        return postPolicy ? BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT : BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT;
    }
    return postPolicy ? BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN : BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN;
}

function routePrefix(route) {
    if (!route) return null;
    if (route.displayPrefix) return route.displayPrefix;
    if (route.prefix === null || route.prefix === undefined) return null;
    return route.length === null || route.length === undefined
        ? String(route.prefix)
        : `${route.prefix}/${route.length}`;
}

function bgpRouteGroups(parsed) {
    if (!parsed || parsed.type !== BgpConst.BGP_PACKET_TYPE.UPDATE) return [];
    const groups = [];
    if ((parsed.nlri || []).length || (parsed.withdrawnRoutes || []).length) {
        groups.push({
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
            announced: parsed.nlri || [],
            withdrawn: parsed.withdrawnRoutes || []
        });
    }
    for (const attribute of parsed.pathAttributes || []) {
        if (attribute.mpReach) {
            groups.push({
                afi: attribute.mpReach.afi,
                safi: attribute.mpReach.safi,
                announced: attribute.mpReach.nlri || [],
                withdrawn: []
            });
        }
        if (attribute.mpUnreach) {
            groups.push({
                afi: attribute.mpUnreach.afi,
                safi: attribute.mpUnreach.safi,
                announced: [],
                withdrawn: attribute.mpUnreach.withdrawnRoutes || []
            });
        }
    }
    return groups;
}

function updateAggregate(aggregates, context, group) {
    const key = [
        context.peerType,
        context.peerAddress,
        context.peerRd,
        context.vrfName,
        context.ribType,
        group.afi,
        group.safi
    ].join('|');
    let item = aggregates.get(key);
    if (!item) {
        item = {
            peerType: context.peerType,
            peerAddress: context.peerAddress,
            peerRd: context.peerRd,
            vrfName: context.vrfName,
            ribType: context.ribType,
            afi: group.afi,
            safi: group.safi,
            messages: 0,
            announced: 0,
            withdrawn: 0,
            eor: 0,
            announcedPrefixes: [],
            withdrawnPrefixes: []
        };
        aggregates.set(key, item);
    }
    item.messages += 1;
    item.announced += group.announced.length;
    item.withdrawn += group.withdrawn.length;
    if (group.announced.length === 0 && group.withdrawn.length === 0) item.eor += 1;
    for (const route of group.announced) {
        const prefix = routePrefix(route);
        if (prefix && !item.announcedPrefixes.includes(prefix)) item.announcedPrefixes.push(prefix);
    }
    for (const route of group.withdrawn) {
        const prefix = routePrefix(route);
        if (prefix && !item.withdrawnPrefixes.includes(prefix)) item.withdrawnPrefixes.push(prefix);
    }
}

function analyzeBmpStream(buffer) {
    const messageTypes = {};
    const routeAggregates = new Map();
    const errors = [];
    let offset = 0;
    let messages = 0;
    let routeMonitoringMessages = 0;
    let pathMarkingTlvs = 0;

    while (offset < buffer.length) {
        if (offset + BmpConst.BMP_HEADER_LENGTH > buffer.length) {
            errors.push(`Trailing ${buffer.length - offset} bytes do not contain a BMP header`);
            break;
        }
        const version = buffer.readUInt8(offset);
        const length = buffer.readUInt32BE(offset + 1);
        const type = buffer.readUInt8(offset + 5);
        if (length < BmpConst.BMP_HEADER_LENGTH || offset + length > buffer.length) {
            errors.push(`Invalid BMP message at offset ${offset}: version=${version}, length=${length}`);
            break;
        }
        const message = buffer.subarray(offset, offset + length);
        offset += length;
        messages += 1;
        messageTypes[type] = (messageTypes[type] || 0) + 1;
        if (type !== BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING) continue;

        routeMonitoringMessages += 1;
        const peerResult = parsePeerHeader(message, BmpConst.BMP_HEADER_LENGTH);
        if (!peerResult.valid) {
            errors.push(peerResult.error);
            continue;
        }
        const { peer } = peerResult;
        const tlvResult = parseBmpTlvs(message, peerResult.offset, { indexed: true });
        errors.push(...tlvResult.warnings);
        const vrfTlv = tlvResult.tlvs.find(tlv => !tlv.enterprise && tlv.type === LEGACY_ROUTE_TLV.VRF_TABLE_NAME);
        const context = {
            peerType: peer.peerType,
            peerAddress: peer.peerAddress,
            peerRd: peer.peerRd,
            vrfName: vrfTlv ? vrfTlv.value.toString('utf8') : null,
            ribType: ribTypeFromFlags(peer.peerFlags)
        };
        pathMarkingTlvs += tlvResult.tlvs.filter(
            tlv => !tlv.enterprise && tlv.type === LEGACY_ROUTE_TLV.PATH_MARKING
        ).length;
        for (const tlv of tlvResult.tlvs) {
            if (tlv.enterprise || tlv.type !== LEGACY_ROUTE_TLV.BGP_MESSAGE) continue;
            const parsed = parseBgpPacket(tlv.value);
            if (parsed.valid === false) {
                errors.push(
                    `Invalid embedded BGP message for ${context.peerAddress}: ${parsed.error || 'parse error'}`
                );
            }
            for (const group of bgpRouteGroups(parsed)) updateAggregate(routeAggregates, context, group);
        }
    }

    return {
        bytes: buffer.length,
        consumedBytes: offset,
        messages,
        messageTypes,
        routeMonitoringMessages,
        pathMarkingTlvs,
        routeScopes: [...routeAggregates.values()],
        errors
    };
}

function analyzeBmpFile(filePath) {
    return analyzeBmpStream(fs.readFileSync(filePath));
}

module.exports = {
    analyzeBmpFile,
    analyzeBmpStream,
    bgpRouteGroups,
    ribTypeFromFlags
};
