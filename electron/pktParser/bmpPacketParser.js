const BmpConst = require('../const/bmpConst');
const BgpConst = require('../const/bgpConst');
const { ipv4BufferToString, ipv6BufferToString, rdBufferToString } = require('../utils/ipUtils');
const {
    getBmpMessageTypeName,
    getBmpPeerTypeName,
    getBmpPeerDownReasonName,
    getBmpTlvName
} = require('../utils/bmpPacketParser');
const { getBgpAfiName, getBgpSafiName, getBgpAddPathTypeName } = require('../utils/bgpUtils');
const { parseBgpPacket } = require('./bgpPacketParser');

function createTreeNode(name, offset, length, value = '', children = []) {
    return {
        name,
        offset,
        length,
        value,
        children
    };
}

function getBmpFrameLength(buffer, offset = 0, endOffset = buffer.length) {
    if (!Buffer.isBuffer(buffer) || offset < 0 || offset >= endOffset) {
        return {
            validStart: false,
            complete: false
        };
    }

    if (offset + BmpConst.BMP_HEADER_LENGTH > endOffset) {
        return {
            validStart: false,
            complete: false
        };
    }

    if (buffer[offset] !== BmpConst.BMP_VERSION.V4) {
        return {
            validStart: false,
            complete: false
        };
    }

    const length = buffer.readUInt32BE(offset + 1);
    if (length < BmpConst.BMP_HEADER_LENGTH) {
        return {
            validStart: true,
            complete: false,
            error: `Invalid BMP length ${length}`
        };
    }

    return {
        validStart: true,
        complete: offset + length <= endOffset,
        length
    };
}

function addLeafNode(parent, name, offset, length, value = '') {
    const node = createTreeNode(name, offset, length, value);
    parent.children.push(node);
    return node;
}

function formatHex(buffer, start, end) {
    return buffer.subarray(start, end).toString('hex');
}

function addPeerHeaderNode(buffer, parent, offset, endOffset) {
    if (offset + 42 > endOffset) {
        parent.children.push(createTreeNode('Malformed Per-Peer Header', offset, endOffset - offset, 'Truncated'));
        return { offset: endOffset, peer: null };
    }

    const peerNode = createTreeNode('Per-Peer Header', offset, 42, '', []);
    parent.children.push(peerNode);

    let position = offset;
    const peerType = buffer[position];
    addLeafNode(peerNode, 'Peer Type', position, 1, `${peerType} (${getBmpPeerTypeName(peerType)})`);
    position += 1;

    const peerFlags = buffer[position];
    addLeafNode(peerNode, 'Peer Flags', position, 1, `0x${peerFlags.toString(16).padStart(2, '0')}`);
    position += 1;

    const peerRd = rdBufferToString(buffer.subarray(position, position + BgpConst.BGP_RD_LEN));
    addLeafNode(peerNode, 'Peer Distinguisher', position, BgpConst.BGP_RD_LEN, peerRd);
    position += BgpConst.BGP_RD_LEN;

    let peerAddress;
    if (peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
        peerAddress = '0.0.0.0';
        addLeafNode(peerNode, 'Peer Address', position, 16, peerAddress);
        position += 16;
    } else if ((peerFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) !== 0) {
        peerAddress = ipv6BufferToString(buffer.subarray(position, position + 16), 128);
        addLeafNode(peerNode, 'Peer Address', position, 16, peerAddress);
        position += 16;
    } else {
        addLeafNode(peerNode, 'IPv4 Address Padding', position, 12, formatHex(buffer, position, position + 12));
        position += 12;
        peerAddress = ipv4BufferToString(buffer.subarray(position, position + 4), 32);
        addLeafNode(peerNode, 'Peer Address', position, 4, peerAddress);
        position += 4;
    }

    const peerAs = buffer.readUInt32BE(position);
    addLeafNode(peerNode, 'Peer AS', position, 4, peerAs);
    position += 4;

    const peerRouterId = ipv4BufferToString(buffer.subarray(position, position + 4), 32);
    addLeafNode(peerNode, 'Peer BGP ID', position, 4, peerRouterId);
    position += 4;

    const timestamp = buffer.readUInt32BE(position);
    addLeafNode(peerNode, 'Timestamp Seconds', position, 4, timestamp);
    position += 4;

    const timestampMs = buffer.readUInt32BE(position);
    addLeafNode(peerNode, 'Timestamp Microseconds', position, 4, timestampMs);
    position += 4;

    peerNode.value = `${getBmpPeerTypeName(peerType)} ${peerAddress} AS${peerAs} RD=${peerRd}`;
    return {
        offset: position,
        peer: {
            peerType,
            peerFlags,
            peerRd,
            peerAddress,
            peerAs,
            peerRouterId,
            timestamp,
            timestampMs
        }
    };
}

function addBgpPacketNode(buffer, parent, offset, endOffset, name) {
    if (offset + BgpConst.BGP_HEAD_LEN > endOffset) {
        parent.children.push(createTreeNode(name, offset, endOffset - offset, 'Truncated BGP header'));
        return endOffset;
    }

    const length = buffer.readUInt16BE(offset + BgpConst.BGP_MARKER_LEN);
    const boundedLength = Math.min(length, endOffset - offset);
    const wrapper = createTreeNode(name, offset, boundedLength, '', []);
    parent.children.push(wrapper);
    const result = parseBgpPacket(buffer, wrapper, offset);
    if (!result.valid) {
        wrapper.value = result.error;
    }
    return offset + boundedLength;
}

function addStatsNodes(buffer, parent, valueOffset, valueEnd) {
    if (valueOffset + 4 > valueEnd) {
        parent.children.push(createTreeNode('Stats', valueOffset, valueEnd - valueOffset, 'Truncated stats count'));
        return;
    }

    const statsNode = createTreeNode('Stats', valueOffset, valueEnd - valueOffset, '', []);
    parent.children.push(statsNode);
    let position = valueOffset;
    const count = buffer.readUInt32BE(position);
    addLeafNode(statsNode, 'Count', position, 4, count);
    position += 4;

    for (let i = 0; i < count && position < valueEnd; i++) {
        const statOffset = position;
        if (position + 4 > valueEnd) {
            statsNode.children.push(
                createTreeNode(`Statistic ${i + 1}`, statOffset, valueEnd - statOffset, 'Truncated')
            );
            break;
        }
        const type = buffer.readUInt16BE(position);
        const length = buffer.readUInt16BE(position + 2);
        const statNode = createTreeNode(
            `Statistic ${i + 1}`,
            statOffset,
            Math.min(4 + length, valueEnd - statOffset),
            '',
            []
        );
        statsNode.children.push(statNode);
        addLeafNode(
            statNode,
            'Type',
            position,
            2,
            `${type} (${BmpConst.BMP_STATS_TYPE_NAME[type] || `Unknown (${type})`})`
        );
        position += 2;
        addLeafNode(statNode, 'Length', position, 2, length);
        position += 2;
        const statValueEnd = Math.min(position + length, valueEnd);
        addLeafNode(statNode, 'Value', position, statValueEnd - position, formatHex(buffer, position, statValueEnd));
        position += length;
    }
}

function addStatelessParsingNodes(buffer, parent, valueOffset, valueEnd) {
    let position = valueOffset;
    let index = 0;
    while (position + 2 <= valueEnd) {
        const capOffset = position;
        const code = buffer[position];
        const length = buffer[position + 1];
        position += 2;
        const capEnd = Math.min(position + length, valueEnd);
        const capNode = createTreeNode(`Capability ${index + 1}`, capOffset, capEnd - capOffset, `code=${code}`, []);
        parent.children.push(capNode);
        addLeafNode(capNode, 'Code', capOffset, 1, code);
        addLeafNode(capNode, 'Length', capOffset + 1, 1, length);

        if (code === BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH) {
            let tupleOffset = position;
            let tupleIndex = 0;
            while (tupleOffset + 4 <= capEnd) {
                const afi = buffer.readUInt16BE(tupleOffset);
                const safi = buffer[tupleOffset + 2];
                const mode = buffer[tupleOffset + 3];
                const tupleNode = createTreeNode(
                    `ADD-PATH Tuple ${tupleIndex + 1}`,
                    tupleOffset,
                    4,
                    `${getBgpAfiName(afi)}/${getBgpSafiName(safi)} ${getBgpAddPathTypeName(mode)}`,
                    []
                );
                capNode.children.push(tupleNode);
                addLeafNode(tupleNode, 'AFI', tupleOffset, 2, `${afi} (${getBgpAfiName(afi)})`);
                addLeafNode(tupleNode, 'SAFI', tupleOffset + 2, 1, `${safi} (${getBgpSafiName(safi)})`);
                addLeafNode(tupleNode, 'Send/Receive', tupleOffset + 3, 1, `${mode} (${getBgpAddPathTypeName(mode)})`);
                tupleOffset += 4;
                tupleIndex += 1;
            }
        } else {
            addLeafNode(capNode, 'Value', position, capEnd - position, formatHex(buffer, position, capEnd));
        }
        position += length;
        index += 1;
    }
}

function addPathMarkingNode(buffer, parent, valueOffset, valueEnd) {
    if (valueOffset + 4 > valueEnd) {
        parent.children.push(createTreeNode('Path Marking', valueOffset, valueEnd - valueOffset, 'Truncated status'));
        return;
    }

    const status = buffer.readUInt32BE(valueOffset) >>> 0;
    addLeafNode(parent, 'Path Status', valueOffset, 4, `0x${status.toString(16).padStart(8, '0')}`);
    if (valueOffset + 6 <= valueEnd) {
        const reason = buffer.readUInt16BE(valueOffset + 4);
        addLeafNode(
            parent,
            'Path Status Reason',
            valueOffset + 4,
            2,
            `${reason} (${BmpConst.BMP_PATH_STATUS_REASON_NAME[reason] || `Unknown (${reason})`})`
        );
    }
}

function addTlvNodes(buffer, parent, offset, endOffset, context, options = {}) {
    const indexed = options.indexed === true;
    const tlvsNode = createTreeNode('TLVs', offset, Math.max(0, endOffset - offset), '', []);
    parent.children.push(tlvsNode);

    let position = offset;
    let tlvIndex = 0;
    while (position < endOffset) {
        const tlvStart = position;
        if (position + 4 > endOffset) {
            tlvsNode.children.push(createTreeNode('Malformed TLV', tlvStart, endOffset - tlvStart, 'Truncated header'));
            break;
        }

        const rawType = buffer.readUInt16BE(position);
        const enterprise = (rawType & 0x8000) !== 0;
        const type = rawType & 0x7fff;
        position += 2;
        const length = buffer.readUInt16BE(position);
        position += 2;

        let rawIndex = null;
        if (indexed) {
            if (position + 2 > endOffset) {
                tlvsNode.children.push(
                    createTreeNode('Malformed Indexed TLV', tlvStart, endOffset - tlvStart, 'Truncated index')
                );
                break;
            }
            rawIndex = buffer.readUInt16BE(position);
            position += 2;
        }

        const rawValueOffset = position;
        const rawValueEnd = Math.min(position + length, endOffset);
        let valueOffset = rawValueOffset;
        let enterpriseNumber = null;
        if (enterprise && rawValueEnd - rawValueOffset >= 4) {
            enterpriseNumber = buffer.readUInt32BE(rawValueOffset);
            valueOffset += 4;
        }

        const tlvNode = createTreeNode(
            `TLV ${tlvIndex + 1}: ${getBmpTlvName(type, context)}`,
            tlvStart,
            rawValueEnd - tlvStart,
            '',
            []
        );
        tlvsNode.children.push(tlvNode);
        addLeafNode(tlvNode, 'Raw Type', tlvStart, 2, `0x${rawType.toString(16).padStart(4, '0')}`);
        addLeafNode(tlvNode, 'Type', tlvStart, 2, `${type} (${getBmpTlvName(type, context)})`);
        addLeafNode(tlvNode, 'Length', tlvStart + 2, 2, length);
        if (indexed) {
            addLeafNode(
                tlvNode,
                'Index',
                tlvStart + 4,
                2,
                `${rawIndex & 0x7fff}${(rawIndex & 0x8000) !== 0 ? ' (group)' : ''}`
            );
        }
        if (enterpriseNumber !== null) {
            addLeafNode(tlvNode, 'Enterprise Number', rawValueOffset, 4, enterpriseNumber);
        }

        const valueLength = Math.max(0, rawValueEnd - valueOffset);
        if (
            (context === 'route-monitoring' || context === 'route-mirroring') &&
            type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.BGP_MESSAGE
        ) {
            addBgpPacketNode(buffer, tlvNode, valueOffset, rawValueEnd, 'BGP Message');
        } else if (context === 'statistics' && type === BmpConst.BMP_STATS_REPORT_TLV_TYPE.STATS) {
            addStatsNodes(buffer, tlvNode, valueOffset, rawValueEnd);
        } else if (
            (context === 'route-monitoring' || context === 'route-mirroring') &&
            type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.STATELESS_PARSING
        ) {
            addStatelessParsingNodes(buffer, tlvNode, valueOffset, rawValueEnd);
        } else if (
            (context === 'route-monitoring' || context === 'route-mirroring') &&
            type === BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING
        ) {
            addPathMarkingNode(buffer, tlvNode, valueOffset, rawValueEnd);
        } else {
            addLeafNode(tlvNode, 'Value', valueOffset, valueLength, formatHex(buffer, valueOffset, rawValueEnd));
        }

        position = rawValueOffset + length;
        tlvIndex += 1;
    }

    return position;
}

function addPeerScopedTlvs(buffer, parent, offset, endOffset, context, options = {}) {
    const peerResult = addPeerHeaderNode(buffer, parent, offset, endOffset);
    if (!peerResult.peer) {
        return endOffset;
    }
    return addTlvNodes(buffer, parent, peerResult.offset, endOffset, context, options);
}

function addPeerUpNodes(buffer, parent, offset, endOffset) {
    const peerResult = addPeerHeaderNode(buffer, parent, offset, endOffset);
    if (!peerResult.peer) {
        return endOffset;
    }

    let position = peerResult.offset;
    if (position + 20 > endOffset) {
        parent.children.push(createTreeNode('Malformed Peer Up Payload', position, endOffset - position, 'Truncated'));
        return endOffset;
    }

    if (peerResult.peer.peerType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB) {
        addLeafNode(parent, 'Local Address', position, 16, '0.0.0.0');
    } else if ((peerResult.peer.peerFlags & BmpConst.BMP_SESSION_FLAGS.IPV6) !== 0) {
        addLeafNode(
            parent,
            'Local Address',
            position,
            16,
            ipv6BufferToString(buffer.subarray(position, position + 16), 128)
        );
    } else {
        addLeafNode(
            parent,
            'Local Address',
            position,
            16,
            ipv4BufferToString(buffer.subarray(position + 12, position + 16), 32)
        );
    }
    position += 16;

    addLeafNode(parent, 'Local Port', position, 2, buffer.readUInt16BE(position));
    position += 2;
    addLeafNode(parent, 'Remote Port', position, 2, buffer.readUInt16BE(position));
    position += 2;

    position = addBgpPacketNode(buffer, parent, position, endOffset, 'Received BGP OPEN');
    position = addBgpPacketNode(buffer, parent, position, endOffset, 'Sent BGP OPEN');
    return addTlvNodes(buffer, parent, position, endOffset, 'peer-up');
}

function addPeerDownNodes(buffer, parent, offset, endOffset) {
    const peerResult = addPeerHeaderNode(buffer, parent, offset, endOffset);
    if (!peerResult.peer) {
        return endOffset;
    }

    let position = peerResult.offset;
    if (position >= endOffset) {
        parent.children.push(createTreeNode('Malformed Peer Down Payload', position, 0, 'Missing reason'));
        return endOffset;
    }

    const reason = buffer[position];
    addLeafNode(parent, 'Reason', position, 1, `${reason} (${getBmpPeerDownReasonName(reason)})`);
    position += 1;

    if (
        reason === BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_NOTIFICATION ||
        reason === BmpConst.BMP_PEER_DOWN_REASON.REMOTE_SYSTEM_CLOSED_WITH_NOTIFICATION
    ) {
        position = addBgpPacketNode(buffer, parent, position, endOffset, 'BGP Notification');
    } else if (reason === BmpConst.BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_NO_NOTIFICATION) {
        if (position + 2 <= endOffset) {
            addLeafNode(parent, 'FSM Event Code', position, 2, buffer.readUInt16BE(position));
            position += 2;
        }
    }

    return addTlvNodes(buffer, parent, position, endOffset, 'peer-down');
}

function parseBmpPacket(buffer, tree, offset = 0) {
    try {
        if (!Buffer.isBuffer(buffer) || buffer.length < offset + BmpConst.BMP_HEADER_LENGTH) {
            return {
                valid: false,
                error: 'Invalid buffer or BMP common header is truncated'
            };
        }

        const version = buffer[offset];
        const length = buffer.readUInt32BE(offset + 1);
        const type = buffer[offset + 5];
        const endOffset = offset + length;

        const bmpNode = createTreeNode(
            'BMP Packet',
            offset,
            Math.min(length, buffer.length - offset),
            `BMPv${version} ${getBmpMessageTypeName(type)}`,
            []
        );
        tree.children.push(bmpNode);

        const commonHeader = createTreeNode('Common Header', offset, BmpConst.BMP_HEADER_LENGTH, '', []);
        bmpNode.children.push(commonHeader);
        addLeafNode(commonHeader, 'Version', offset, 1, version);
        addLeafNode(commonHeader, 'Length', offset + 1, 4, length);
        addLeafNode(commonHeader, 'Message Type', offset + 5, 1, `${type} (${getBmpMessageTypeName(type)})`);

        if (version !== BmpConst.BMP_VERSION.V4) {
            return {
                valid: false,
                error: `Unsupported BMP version ${version}; only BMPv4 draft-20 is supported`
            };
        }

        if (length < BmpConst.BMP_HEADER_LENGTH || endOffset > buffer.length) {
            return {
                valid: false,
                error: `Incomplete BMP packet: expected ${length} bytes from offset ${offset}, got ${buffer.length - offset}`
            };
        }

        const bodyOffset = offset + BmpConst.BMP_HEADER_LENGTH;
        switch (type) {
            case BmpConst.BMP_MSG_TYPE.INITIATION:
                addTlvNodes(buffer, bmpNode, bodyOffset, endOffset, 'initiation');
                break;
            case BmpConst.BMP_MSG_TYPE.TERMINATION:
                addTlvNodes(buffer, bmpNode, bodyOffset, endOffset, 'termination');
                break;
            case BmpConst.BMP_MSG_TYPE.ROUTE_MONITORING:
                addPeerScopedTlvs(buffer, bmpNode, bodyOffset, endOffset, 'route-monitoring', { indexed: true });
                break;
            case BmpConst.BMP_MSG_TYPE.ROUTE_MIRRORING:
                addPeerScopedTlvs(buffer, bmpNode, bodyOffset, endOffset, 'route-mirroring', { indexed: true });
                break;
            case BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION:
                addPeerUpNodes(buffer, bmpNode, bodyOffset, endOffset);
                break;
            case BmpConst.BMP_MSG_TYPE.PEER_DOWN_NOTIFICATION:
                addPeerDownNodes(buffer, bmpNode, bodyOffset, endOffset);
                break;
            case BmpConst.BMP_MSG_TYPE.STATISTICS_REPORT:
                addPeerScopedTlvs(buffer, bmpNode, bodyOffset, endOffset, 'statistics');
                break;
            default:
                addLeafNode(
                    bmpNode,
                    'Payload',
                    bodyOffset,
                    endOffset - bodyOffset,
                    formatHex(buffer, bodyOffset, endOffset)
                );
                break;
        }

        return {
            valid: true,
            payload: null,
            nextOffset: endOffset,
            length
        };
    } catch (error) {
        return {
            valid: false,
            error: `Error parsing BMP packet tree: ${error.message}`
        };
    }
}

module.exports = {
    parseBmpPacket,
    getBmpFrameLength
};

parseBmpPacket.getFrameLength = getBmpFrameLength;
