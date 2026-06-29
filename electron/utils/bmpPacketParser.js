const BmpConst = require('../const/bmpConst');
const BgpConst = require('../const/bgpConst');
const {
    getInitiationTlvName,
    parseCommonHeader,
    parsePeerHeader,
    parseBmpTlvs,
    parseStatsRecords
} = require('./bmpUtils');
const { ipv4BufferToString, ipv6BufferToString } = require('./ipUtils');
const { getBgpPacketTypeName, getBgpAfiName, getBgpSafiName, getBgpAddPathTypeName } = require('./bgpUtils');
const { parseBgpPacket, getBgpPacketSummary } = require('./bgpPacketParser');

function getBmpMessageTypeName(type) {
    return BmpConst.BMP_MSG_TYPE_NAME[type] || `Unknown (${type})`;
}

function getBmpPeerTypeName(type) {
    switch (type) {
        case BmpConst.BMP_PEER_TYPE.GLOBAL:
            return 'Global';
        case BmpConst.BMP_PEER_TYPE.L3VPN:
            return 'L3VPN';
        case BmpConst.BMP_PEER_TYPE.LOCAL:
            return 'Local';
        case BmpConst.BMP_PEER_TYPE.LOCAL_RIB:
            return 'Local RIB';
        default:
            return `Unknown (${type})`;
    }
}

function getBmpPeerDownReasonName(reason) {
    switch (reason) {
        case BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_NOTIFICATION:
            return 'Local system closed with notification';
        case BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_NO_NOTIFICATION:
            return 'Local system closed without notification';
        case BmpConst.BMP_PEER_DOWN_REASON.REMOTE_SYSTEM_CLOSED_WITH_NOTIFICATION:
            return 'Remote system closed with notification';
        case BmpConst.BMP_PEER_DOWN_REASON.REMOTE_SYSTEM_CLOSED_NO_NOTIFICATION:
            return 'Remote system closed without notification';
        case BmpConst.BMP_PEER_DOWN_REASON.PEER_DE_CONFIGURED:
            return 'Peer de-configured';
        case BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_TLV:
            return 'Local system closed with TLV';
        default:
            return `Unknown (${reason})`;
    }
}

function getBmpTlvName(type, context = 'common') {
    if (context === 'initiation') {
        if (type === BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME) {
            return 'VRF/Table Name';
        }
        return getInitiationTlvName(type);
    }

    if (
        (context === 'peer-up' || context === 'peer-down') &&
        type === BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME
    ) {
        return 'VRF/Table Name';
    }

    if (context === 'statistics') {
        if (type === BmpConst.BMP_STATS_REPORT_TLV_TYPE.STATS) return 'Stats';
    }

    if (context === 'route-monitoring' || context === 'route-mirroring') {
        switch (type) {
            case BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.GROUP:
                return 'Group';
            case BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME:
                return 'VRF/Table Name';
            case BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.STATELESS_PARSING:
                return 'Stateless Parsing';
            case BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE:
                return 'BGP Message';
            case BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING:
                return 'Path Marking';
            default:
                break;
        }
    }

    switch (type) {
        case BmpConst.BMP_TLV_TYPE.SEQUENCE_NUMBER:
            return 'Sequence Number';
        case BmpConst.BMP_TLV_TYPE.EXTENDED_FLAGS:
            return 'Extended Flags';
        case BmpConst.BMP_TLV_TYPE.TIMESTAMP:
            return 'Timestamp';
        default:
            return `TLV ${type}`;
    }
}

function getPathStatusNames(status) {
    const names = [];
    Object.entries(BmpConst.BMP_PATH_STATUS_NAME).forEach(([bit, name]) => {
        if ((status & Number(bit)) !== 0) {
            names.push(name);
        }
    });
    return names;
}

function parseEmbeddedBgpPacket(buffer, position, label = 'BGP Message') {
    if (position + BgpConst.BGP_HEAD_LEN > buffer.length) {
        return {
            label,
            offset: position,
            valid: false,
            error: `${label} header is truncated`,
            length: 0
        };
    }

    const length = buffer.readUInt16BE(position + BgpConst.BGP_MARKER_LEN);
    if (length < BgpConst.BGP_HEAD_LEN) {
        return {
            label,
            offset: position,
            valid: false,
            error: `${label} has invalid length ${length}`,
            length: 0
        };
    }

    if (position + length > buffer.length) {
        return {
            label,
            offset: position,
            valid: false,
            error: `${label} length ${length} exceeds remaining bytes`,
            length: Math.max(0, buffer.length - position)
        };
    }

    const packet = buffer.subarray(position, position + length);
    const parsed = parseBgpPacket(packet);
    return {
        label,
        offset: position,
        length,
        valid: parsed.valid === true,
        error: parsed.valid ? null : parsed.error,
        parsed,
        summary: getBgpPacketSummary(parsed)
    };
}

function decodeBgpPacketHeader(buffer, label = 'BGP Message') {
    if (!Buffer.isBuffer(buffer) || buffer.length < BgpConst.BGP_HEAD_LEN) {
        return {
            label,
            valid: false,
            error: `${label} header is truncated`,
            length: 0,
            summary: `Invalid BGP packet: ${label} header is truncated`
        };
    }

    const marker = buffer.subarray(0, BgpConst.BGP_MARKER_LEN);
    if (!marker.every(byte => byte === 0xff)) {
        return {
            label,
            valid: false,
            error: `${label} has invalid marker`,
            length: 0,
            summary: `Invalid BGP packet: ${label} has invalid marker`
        };
    }

    const length = buffer.readUInt16BE(BgpConst.BGP_MARKER_LEN);
    const type = buffer[BgpConst.BGP_MARKER_LEN + 2];
    const typeName = getBgpPacketTypeName(type);
    const validLength = length >= BgpConst.BGP_HEAD_LEN && length <= buffer.length;
    const error = validLength ? null : `${label} has invalid length ${length}`;

    return {
        label,
        valid: validLength,
        error,
        type,
        typeName,
        length,
        bodyLength: Math.max(0, length - BgpConst.BGP_HEAD_LEN),
        summary: validLength
            ? `BGP ${typeName} Message (${length} bytes, header only; body parsing requires Peer Up capabilities)`
            : `Invalid BGP packet: ${error}`
    };
}

function decodeStatelessParsingTlv(tlv) {
    const capabilities = [];
    let position = 0;
    while (position + 2 <= tlv.value.length) {
        const code = tlv.value[position];
        const length = tlv.value[position + 1];
        position += 2;
        if (position + length > tlv.value.length) {
            capabilities.push({
                code,
                length,
                valueHex: tlv.value.subarray(position).toString('hex'),
                error: 'Capability is truncated'
            });
            break;
        }

        const value = tlv.value.subarray(position, position + length);
        position += length;
        const capability = {
            code,
            length,
            valueHex: value.toString('hex')
        };

        if (code === 0x45) {
            capability.addPaths = [];
            let capPosition = 0;
            while (capPosition + 4 <= value.length) {
                const afi = value.readUInt16BE(capPosition);
                const safi = value[capPosition + 2];
                const sendReceive = value[capPosition + 3];
                capability.addPaths.push({
                    afi,
                    afiName: getBgpAfiName(afi),
                    safi,
                    safiName: getBgpSafiName(safi),
                    sendReceive,
                    sendReceiveName: getBgpAddPathTypeName(sendReceive)
                });
                capPosition += 4;
            }
        }

        capabilities.push(capability);
    }
    return { capabilities };
}

function decodePathMarkingTlv(tlv) {
    if (tlv.value.length < 4) {
        return { error: 'Path status is truncated' };
    }

    const status = tlv.value.readUInt32BE(0) >>> 0;
    const decoded = {
        status,
        statusNames: getPathStatusNames(status)
    };

    if (tlv.value.length >= 6) {
        const reason = tlv.value.readUInt16BE(4);
        decoded.reason = reason;
        decoded.reasonName = BmpConst.BMP_PATH_STATUS_REASON_NAME[reason] || `Unknown (${reason})`;
    }

    return decoded;
}

function decodeGroupTlv(tlv) {
    const indexes = [];
    let position = 0;
    while (position + 2 <= tlv.value.length) {
        indexes.push(tlv.value.readUInt16BE(position) & 0x7fff);
        position += 2;
    }
    return { indexes };
}

function decodeBmpTlv(tlv, context) {
    const decoded = {
        ...tlv,
        name: getBmpTlvName(tlv.type, context)
    };

    if (
        (context === 'initiation' &&
            (decoded.type === BmpConst.BMP_INITIATION_TLV_TYPE.SYS_NAME ||
                decoded.type === BmpConst.BMP_INITIATION_TLV_TYPE.SYS_DESC ||
                decoded.type === BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME)) ||
        ((context === 'peer-up' || context === 'peer-down' || context === 'termination') &&
            decoded.type === BmpConst.BMP_INITIATION_TLV_TYPE.VRF_TABLE_NAME) ||
        ((context === 'route-monitoring' || context === 'route-mirroring') &&
            decoded.type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.VRF_TABLE_NAME)
    ) {
        decoded.valueText = decoded.value.toString('utf8');
    }

    if (context === 'statistics' && decoded.type === BmpConst.BMP_STATS_REPORT_TLV_TYPE.STATS) {
        decoded.decoded = { statistics: parseStatsRecords(decoded.value).statistics };
    } else if (decoded.type === BmpConst.BMP_TLV_TYPE.SEQUENCE_NUMBER && decoded.value.length === 4) {
        decoded.decoded = { sequenceNumber: decoded.value.readUInt32BE(0) };
    } else if (decoded.type === BmpConst.BMP_TLV_TYPE.EXTENDED_FLAGS && decoded.value.length > 0) {
        decoded.decoded = { flags: decoded.value[0] };
    } else if (decoded.type === BmpConst.BMP_TLV_TYPE.TIMESTAMP && decoded.value.length >= 8) {
        decoded.decoded = {
            seconds: decoded.value.readUInt32BE(0),
            microseconds: decoded.value.readUInt32BE(4)
        };
    } else if (
        (context === 'route-monitoring' || context === 'route-mirroring') &&
        decoded.type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.STATELESS_PARSING
    ) {
        decoded.decoded = decodeStatelessParsingTlv(decoded);
    } else if (
        (context === 'route-monitoring' || context === 'route-mirroring') &&
        decoded.type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.GROUP
    ) {
        decoded.decoded = decodeGroupTlv(decoded);
    } else if (
        (context === 'route-monitoring' || context === 'route-mirroring') &&
        decoded.type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING
    ) {
        decoded.decoded = decodePathMarkingTlv(decoded);
    }

    if (
        (context === 'route-monitoring' || context === 'route-mirroring') &&
        decoded.type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE
    ) {
        const bgpHeader = decodeBgpPacketHeader(decoded.value);
        decoded.decoded = {
            ...(decoded.decoded || {}),
            bgpHeader,
            bgpSummary: bgpHeader.summary
        };
    }

    return decoded;
}

function parseTlvs(buffer, offset, context, options = {}) {
    const result = parseBmpTlvs(buffer, offset, options);
    return {
        tlvs: result.tlvs.map(tlv => decodeBmpTlv(tlv, context)),
        warnings: result.warnings,
        offset: result.offset
    };
}

function parseLocalAddress(buffer, position, peer) {
    if (peer.peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
        return {
            address: '0.0.0.0',
            nextPosition: position + 16
        };
    }

    if ((peer.peerFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) !== 0) {
        return {
            address: ipv6BufferToString(buffer.subarray(position, position + 16), 128),
            nextPosition: position + 16
        };
    }

    return {
        address: ipv4BufferToString(buffer.subarray(position + 12, position + 16), 32),
        nextPosition: position + 16
    };
}

function parsePeerHeaderAt(buffer, position) {
    const peerHeader = parsePeerHeader(buffer, position);
    if (!peerHeader.valid) {
        return peerHeader;
    }
    return {
        ...peerHeader,
        peer: {
            ...peerHeader.peer,
            peerTypeName: getBmpPeerTypeName(peerHeader.peer.peerType)
        }
    };
}

function parsePeerScopedTlvs(buffer, position, context, options = {}) {
    const peerHeader = parsePeerHeaderAt(buffer, position);
    if (!peerHeader.valid) {
        return {
            peerHeader,
            warnings: [peerHeader.error],
            offset: position
        };
    }

    const tlvResult = parseTlvs(buffer, peerHeader.offset, context, options);
    return {
        peer: peerHeader.peer,
        tlvs: tlvResult.tlvs,
        warnings: tlvResult.warnings,
        offset: tlvResult.offset
    };
}

function parsePeerUp(buffer, position) {
    const peerHeader = parsePeerHeaderAt(buffer, position);
    if (!peerHeader.valid) {
        return {
            peerHeader,
            warnings: [peerHeader.error],
            offset: position
        };
    }

    position = peerHeader.offset;
    const localAddress = parseLocalAddress(buffer, position, peerHeader.peer);
    position = localAddress.nextPosition;

    if (position + 4 > buffer.length) {
        return {
            peer: peerHeader.peer,
            localAddress: localAddress.address,
            warnings: ['Peer Up ports are truncated'],
            offset: position
        };
    }

    const localPort = buffer.readUInt16BE(position);
    const remotePort = buffer.readUInt16BE(position + 2);
    position += 4;

    const receivedOpen = parseEmbeddedBgpPacket(buffer, position, 'Received BGP OPEN');
    position += receivedOpen.length;
    const sentOpen = parseEmbeddedBgpPacket(buffer, position, 'Sent BGP OPEN');
    position += sentOpen.length;

    const tlvResult = parseTlvs(buffer, position, 'peer-up');
    return {
        peer: peerHeader.peer,
        localAddress: localAddress.address,
        localPort,
        remotePort,
        receivedOpen,
        sentOpen,
        tlvs: tlvResult.tlvs,
        warnings: tlvResult.warnings,
        offset: tlvResult.offset
    };
}

function parsePeerDown(buffer, position) {
    const peerHeader = parsePeerHeaderAt(buffer, position);
    if (!peerHeader.valid) {
        return {
            peerHeader,
            warnings: [peerHeader.error],
            offset: position
        };
    }

    position = peerHeader.offset;
    if (position >= buffer.length) {
        return {
            peer: peerHeader.peer,
            warnings: ['Peer Down reason is truncated'],
            offset: position
        };
    }

    const reason = buffer[position];
    position += 1;
    const payload = {
        peer: peerHeader.peer,
        reason,
        reasonName: getBmpPeerDownReasonName(reason),
        warnings: []
    };

    if (
        reason === BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_NOTIFICATION ||
        reason === BmpConst.BMP_PEER_DOWN_REASON.REMOTE_SYSTEM_CLOSED_WITH_NOTIFICATION
    ) {
        payload.notification = parseEmbeddedBgpPacket(buffer, position, 'BGP Notification');
        position += payload.notification.length;
    } else if (reason === BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_NO_NOTIFICATION) {
        if (position + 2 <= buffer.length) {
            payload.fsmEventCode = buffer.readUInt16BE(position);
            position += 2;
        } else {
            payload.warnings.push('FSM event code is truncated');
        }
    }

    const tlvResult = parseTlvs(buffer, position, 'peer-down');
    payload.tlvs = tlvResult.tlvs;
    payload.warnings.push(...tlvResult.warnings);
    payload.offset = tlvResult.offset;
    return payload;
}

function parseStatistics(buffer, position) {
    const result = parsePeerScopedTlvs(buffer, position, 'statistics');
    const statsTlv = Array.isArray(result.tlvs)
        ? result.tlvs.find(tlv => !tlv.enterprise && tlv.type === BmpConst.BMP_STATS_REPORT_TLV_TYPE.STATS)
        : null;
    const statistics = statsTlv
        ? parseStatsRecords(statsTlv.value, 0, {
              locRib: result.peer?.peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB
          }).statistics
        : [];
    if (statsTlv) {
        statsTlv.decoded = { ...(statsTlv.decoded || {}), statistics };
    }
    return {
        ...result,
        statistics
    };
}

function parseBmpPacket(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < BmpConst.BMP_HEADER_LENGTH) {
        return {
            valid: false,
            error: 'BMP common header is truncated'
        };
    }

    const header = parseCommonHeader(buffer);
    if (!header.valid) {
        return header;
    }

    if (header.version !== BmpConst.BMP_VERSION.V4) {
        return {
            valid: false,
            error: `Unsupported BMP version ${header.version}; only BMPv4 draft-20 is supported`,
            ...header
        };
    }

    if (header.length < BmpConst.BMP_HEADER_LENGTH) {
        return {
            valid: false,
            error: `Invalid BMP message length ${header.length}`,
            ...header
        };
    }

    if (buffer.length < header.length) {
        return {
            valid: false,
            error: `Incomplete BMP message: expected ${header.length} bytes, got ${buffer.length}`,
            ...header
        };
    }

    const message = buffer.subarray(0, header.length);
    const parsed = {
        valid: true,
        version: header.version,
        length: header.length,
        type: header.type,
        typeName: getBmpMessageTypeName(header.type),
        draft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20,
        trailingLength: buffer.length - header.length,
        warnings: []
    };

    let payload;
    switch (header.type) {
        case BmpConst.BMP_MSG_TYPE.INITIATION:
            payload = parseTlvs(message, BmpConst.BMP_HEADER_LENGTH, 'initiation');
            break;
        case BmpConst.BMP_MSG_TYPE.TERMINATION:
            payload = parseTlvs(message, BmpConst.BMP_HEADER_LENGTH, 'termination');
            break;
        case BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING:
            payload = parsePeerScopedTlvs(message, BmpConst.BMP_HEADER_LENGTH, 'route-monitoring', { indexed: true });
            break;
        case BmpConst.BMP_MSG_TYPE.ROUTE_MIRRORING:
            payload = parsePeerScopedTlvs(message, BmpConst.BMP_HEADER_LENGTH, 'route-mirroring', { indexed: true });
            break;
        case BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION:
            payload = parsePeerUp(message, BmpConst.BMP_HEADER_LENGTH);
            break;
        case BmpConst.BMP_MSG_TYPE.PEER_DOWN_NOTIFICATION:
            payload = parsePeerDown(message, BmpConst.BMP_HEADER_LENGTH);
            break;
        case BmpConst.BMP_MSG_TYPE.STATISTICS_REPORT:
            payload = parseStatistics(message, BmpConst.BMP_HEADER_LENGTH);
            break;
        default:
            payload = {
                rawValueHex: message.subarray(BmpConst.BMP_HEADER_LENGTH).toString('hex'),
                warnings: [`Unknown BMP message type ${header.type}`]
            };
            break;
    }

    parsed.payload = payload;
    if (Array.isArray(payload?.warnings)) {
        parsed.warnings.push(...payload.warnings);
    }

    return parsed;
}

function formatPeer(peer) {
    if (!peer) {
        return null;
    }
    return `${peer.peerTypeName || getBmpPeerTypeName(peer.peerType)} RD=${peer.peerRd} peer=${peer.peerAddress} AS=${peer.peerAs} routerId=${peer.peerRouterId}`;
}

function indent(text, prefix = '    ') {
    return String(text || '')
        .split('\n')
        .map(line => `${prefix}${line}`)
        .join('\n');
}

function formatEmbeddedBgpPacket(embedded, prefix = '  ') {
    if (!embedded) {
        return '';
    }

    return indent(embedded.summary || embedded.error || 'No BGP detail', prefix);
}

function formatTlvSummary(tlv, prefix = '  ') {
    let line = `${prefix}- ${tlv.name || getBmpTlvName(tlv.type)} type=${tlv.type} len=${tlv.length}`;
    if (tlv.index !== null && tlv.index !== undefined) {
        line += ` index=${tlv.index}${tlv.group ? ' group' : ''}`;
    }
    if (tlv.enterprise) {
        line += ` enterprise=${tlv.enterpriseNumber}`;
    }
    if (tlv.valueText !== undefined) {
        line += ` value="${tlv.valueText}"`;
    } else if (tlv.decoded?.sequenceNumber !== undefined) {
        line += ` value=${tlv.decoded.sequenceNumber}`;
    } else if (tlv.decoded?.flags !== undefined) {
        line += ` flags=0x${tlv.decoded.flags.toString(16)}`;
    } else if (tlv.decoded?.status !== undefined) {
        line += ` status=${tlv.decoded.statusNames.join('|') || tlv.decoded.status}`;
        if (tlv.decoded.reasonName) {
            line += ` reason=${tlv.decoded.reasonName}`;
        }
    } else if (tlv.decoded?.statistics) {
        line += ` records=${tlv.decoded.statistics.length}`;
    } else if (tlv.decoded?.capabilities) {
        line += ` capabilities=${tlv.decoded.capabilities.length}`;
    }

    if (tlv.decoded?.bgpSummary) {
        line += `\n${indent(tlv.decoded.bgpSummary, `${prefix}  `)}`;
    }

    return line;
}

function appendTlvSummary(summary, tlvs, title = 'TLVs') {
    if (!Array.isArray(tlvs) || tlvs.length === 0) {
        return summary;
    }

    summary += `\n${title}:`;
    tlvs.forEach(tlv => {
        summary += `\n${formatTlvSummary(tlv)}`;
    });
    return summary;
}

function getBmpPacketSummary(parsedPacket) {
    if (!parsedPacket || !parsedPacket.valid) {
        return `Invalid BMP packet: ${parsedPacket?.error || 'Unknown error'}`;
    }

    let summary = `BMPv${parsedPacket.version} ${parsedPacket.typeName} Message (${parsedPacket.length} bytes, draft-20)`;
    const payload = parsedPacket.payload || {};
    const peerLine = formatPeer(payload.peer);
    if (peerLine) {
        summary += `\nPeer: ${peerLine}`;
    }

    switch (parsedPacket.type) {
        case BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION:
            summary += `\nLocal: ${payload.localAddress}:${payload.localPort}`;
            summary += `\nRemote Port: ${payload.remotePort}`;
            if (payload.receivedOpen) {
                summary += `\nReceived OPEN:\n${formatEmbeddedBgpPacket(payload.receivedOpen, '  ')}`;
            }
            if (payload.sentOpen) {
                summary += `\nSent OPEN:\n${formatEmbeddedBgpPacket(payload.sentOpen, '  ')}`;
            }
            summary = appendTlvSummary(summary, payload.tlvs);
            break;
        case BmpConst.BMP_MSG_TYPE.PEER_DOWN_NOTIFICATION:
            summary += `\nReason: ${payload.reasonName}`;
            if (payload.fsmEventCode !== undefined) {
                summary += `\nFSM Event Code: ${payload.fsmEventCode}`;
            }
            if (payload.notification) {
                summary += `\nNotification:\n${formatEmbeddedBgpPacket(payload.notification, '  ')}`;
            }
            summary = appendTlvSummary(summary, payload.tlvs);
            break;
        case BmpConst.BMP_MSG_TYPE.STATISTICS_REPORT:
            if (Array.isArray(payload.statistics) && payload.statistics.length > 0) {
                summary += '\nStatistics:';
                payload.statistics.forEach(stat => {
                    const af =
                        stat.afi !== null && stat.afi !== undefined
                            ? ` ${getBgpAfiName(stat.afi)}/${getBgpSafiName(stat.safi)}`
                            : '';
                    summary += `\n  - ${stat.typeName}${af}: ${stat.value}`;
                });
            }
            summary = appendTlvSummary(summary, payload.tlvs);
            break;
        default:
            summary = appendTlvSummary(summary, payload.tlvs);
            break;
    }

    if (parsedPacket.trailingLength > 0) {
        summary += `\nTrailing Bytes: ${parsedPacket.trailingLength}`;
    }
    if (parsedPacket.warnings.length > 0) {
        summary += `\nWarnings: ${parsedPacket.warnings.join('; ')}`;
    }

    return summary;
}

module.exports = {
    parseBmpPacket,
    getBmpPacketSummary,
    getBmpMessageTypeName,
    getBmpPeerTypeName,
    getBmpPeerDownReasonName,
    getBmpTlvName
};
