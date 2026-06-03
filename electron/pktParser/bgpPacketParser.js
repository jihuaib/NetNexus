/**
 * BGP Packet Parser
 *
 * Parses BGP protocol packets from raw buffers and returns structured data
 * and tree visualization.
 * Based on RFC 4271 and other BGP extension RFCs.
 */

const logger = require('../log/logger');

const BgpConst = require('../const/bgpConst');
const { ipv4BufferToString, ipv6BufferToString } = require('../utils/ipUtils');
const {
    getBgpPacketTypeName,
    getBgpOpenCapabilityName,
    getBgpAfiName,
    getBgpSafiName,
    getBgpOpenRoleName,
    getBgpPathAttrTypeName,
    getBgpNotificationErrorName,
    getBgpOriginType,
    getBgpAsPathTypeName
} = require('../utils/bgpUtils');

const BGP_PREFIX_SID_TLV_TYPE_NAMES = {
    0: 'Reserved',
    1: 'Label-Index',
    2: 'Deprecated',
    3: 'Originator SRGB',
    4: 'Deprecated',
    5: 'SRv6 L3 Service',
    6: 'SRv6 L2 Service',
    7: 'SRv6 Transport',
    255: 'Reserved'
};

const SRV6_SERVICE_SUB_TLV_TYPE_NAMES = {
    1: 'SRv6 SID Information'
};

const SRV6_SERVICE_DATA_SUB_SUB_TLV_TYPE_NAMES = {
    1: 'SRv6 SID Structure'
};

const SRV6_ENDPOINT_BEHAVIOR_NAMES = {
    1: 'End',
    5: 'End.X',
    9: 'End.T',
    16: 'End.DX6',
    17: 'End.DX4',
    18: 'End.DT6',
    19: 'End.DT4',
    20: 'End.DT46',
    23: 'End.DX2',
    24: 'End.DX2V',
    25: 'End.DT2U',
    26: 'End.DT2M'
};

function getBgpPrefixSidTlvTypeName(type) {
    return BGP_PREFIX_SID_TLV_TYPE_NAMES[type] || `Unknown (${type})`;
}

function getSrv6ServiceSubTlvTypeName(type) {
    return SRV6_SERVICE_SUB_TLV_TYPE_NAMES[type] || `Unknown (${type})`;
}

function getSrv6ServiceDataSubSubTlvTypeName(type) {
    return SRV6_SERVICE_DATA_SUB_SUB_TLV_TYPE_NAMES[type] || `Unknown (${type})`;
}

function getSrv6EndpointBehaviorName(behavior) {
    return SRV6_ENDPOINT_BEHAVIOR_NAMES[behavior] || `Unknown (${behavior})`;
}

function readUint24BE(buffer, position) {
    return (buffer[position] << 16) | (buffer[position + 1] << 8) | buffer[position + 2];
}

function addSrv6SidStructureNode(buffer, sidInfoNode, subSubOffset, length) {
    const structureNode = {
        name: 'SID Structure',
        offset: subSubOffset,
        length,
        value: '',
        children: []
    };

    const fields = [
        ['Locator Block Length', 0],
        ['Locator Node Length', 1],
        ['Function Length', 2],
        ['Argument Length', 3],
        ['Transposition Length', 4],
        ['Transposition Offset', 5]
    ];
    fields.forEach(([name, relativeOffset]) => {
        if (relativeOffset < length) {
            structureNode.children.push({
                name,
                offset: subSubOffset + relativeOffset,
                length: 1,
                value: buffer[subSubOffset + relativeOffset],
                children: []
            });
        }
    });
    structureNode.value = structureNode.children.map(child => `${child.name}: ${child.value}`).join(', ');
    sidInfoNode.children.push(structureNode);
}

function addSrv6ServiceDataSubSubTlvs(buffer, sidInfoNode, startOffset, endOffset) {
    let offset = startOffset;
    while (offset < endOffset) {
        if (offset + 3 > endOffset) {
            sidInfoNode.children.push({
                name: 'Malformed Sub-Sub-TLV',
                offset,
                length: endOffset - offset,
                value: 'Truncated SRv6 Service Data Sub-Sub-TLV header',
                children: []
            });
            break;
        }

        const type = buffer[offset];
        const length = buffer.readUInt16BE(offset + 1);
        const valueOffset = offset + 3;
        const subSubNode = {
            name: `Sub-Sub-TLV ${type} (${getSrv6ServiceDataSubSubTlvTypeName(type)})`,
            offset,
            length: Math.min(3 + length, endOffset - offset),
            value: '',
            children: [
                {
                    name: 'Type',
                    offset,
                    length: 1,
                    value: `${type} (${getSrv6ServiceDataSubSubTlvTypeName(type)})`,
                    children: []
                },
                {
                    name: 'Length',
                    offset: offset + 1,
                    length: 2,
                    value: length,
                    children: []
                }
            ]
        };
        sidInfoNode.children.push(subSubNode);

        if (valueOffset + length > endOffset) {
            subSubNode.value = 'Malformed: length exceeds SID Information Sub-TLV';
            break;
        }

        if (type === 1) {
            addSrv6SidStructureNode(buffer, subSubNode, valueOffset, length);
        } else {
            subSubNode.value = buffer.subarray(valueOffset, valueOffset + length).toString('hex');
        }
        offset = valueOffset + length;
    }
}

function addSrv6SidInformationNode(buffer, serviceNode, offset, length) {
    const sidInfoNode = {
        name: 'SRv6 SID Information',
        offset,
        length,
        value: '',
        children: []
    };
    serviceNode.children.push(sidInfoNode);

    if (length < 21) {
        sidInfoNode.value = 'Malformed: length must be at least 21';
        return;
    }

    const sid = ipv6BufferToString(buffer.subarray(offset + 1, offset + 17), BgpConst.IPV6_HOST_LEN);
    const behavior = buffer.readUInt16BE(offset + 17);
    sidInfoNode.value = `${sid} ${getSrv6EndpointBehaviorName(behavior)}`;
    sidInfoNode.children.push(
        {
            name: 'Reserved',
            offset,
            length: 1,
            value: buffer[offset],
            children: []
        },
        {
            name: 'SRv6 SID',
            offset: offset + 1,
            length: 16,
            value: sid,
            children: []
        },
        {
            name: 'Endpoint Behavior',
            offset: offset + 17,
            length: 2,
            value: `${behavior} (${getSrv6EndpointBehaviorName(behavior)})`,
            children: []
        },
        {
            name: 'Reserved',
            offset: offset + 19,
            length: 1,
            value: buffer[offset + 19],
            children: []
        },
        {
            name: 'Flags',
            offset: offset + 20,
            length: 1,
            value: `0x${buffer[offset + 20].toString(16).padStart(2, '0')}`,
            children: []
        }
    );

    addSrv6ServiceDataSubSubTlvs(buffer, sidInfoNode, offset + 21, offset + length);
}

function addSrv6ServiceTlvDetails(buffer, prefixSidNode, tlvNode, type, valueOffset, length) {
    const serviceName = type === 5 ? 'SRv6 L3' : type === 6 ? 'SRv6 L2' : 'SRv6';
    if (length >= 1) {
        tlvNode.children.push({
            name: 'Reserved',
            offset: valueOffset,
            length: 1,
            value: buffer[valueOffset],
            children: []
        });
    }

    let offset = valueOffset + 1;
    const endOffset = valueOffset + length;
    const sidSummaries = [];
    while (offset < endOffset) {
        if (offset + 3 > endOffset) {
            tlvNode.children.push({
                name: 'Malformed Sub-TLV',
                offset,
                length: endOffset - offset,
                value: 'Truncated SRv6 Service Sub-TLV header',
                children: []
            });
            break;
        }

        const subType = buffer[offset];
        const subLength = buffer.readUInt16BE(offset + 1);
        const subValueOffset = offset + 3;
        const subNode = {
            name: `Sub-TLV ${subType} (${getSrv6ServiceSubTlvTypeName(subType)})`,
            offset,
            length: Math.min(3 + subLength, endOffset - offset),
            value: '',
            children: []
        };
        tlvNode.children.push(subNode);

        if (subValueOffset + subLength > endOffset) {
            subNode.value = 'Malformed: length exceeds service TLV';
            break;
        }

        if (subType === 1) {
            addSrv6SidInformationNode(buffer, subNode, subValueOffset, subLength);
            if (subLength >= 19) {
                const sid = ipv6BufferToString(buffer.subarray(subValueOffset + 1, subValueOffset + 17), BgpConst.IPV6_HOST_LEN);
                const behavior = buffer.readUInt16BE(subValueOffset + 17);
                sidSummaries.push(`${sid} ${getSrv6EndpointBehaviorName(behavior)}`);
            }
        } else {
            subNode.value = buffer.subarray(subValueOffset, subValueOffset + subLength).toString('hex');
        }
        offset = subValueOffset + subLength;
    }

    if (sidSummaries.length > 0) {
        tlvNode.value = `${serviceName} ${sidSummaries.join(', ')}`;
        prefixSidNode.value = prefixSidNode.value
            ? `${prefixSidNode.value}, ${tlvNode.value}`
            : tlvNode.value;
    }
}

function addPrefixSidTlvDetails(buffer, prefixSidNode, tlvNode, type, valueOffset, length) {
    if (type === 1) {
        if (length >= 1) {
            tlvNode.children.push({
                name: 'Reserved',
                offset: valueOffset,
                length: 1,
                value: buffer[valueOffset],
                children: []
            });
        }
        if (length >= 3) {
            tlvNode.children.push({
                name: 'Flags',
                offset: valueOffset + 1,
                length: 2,
                value: `0x${buffer.readUInt16BE(valueOffset + 1).toString(16).padStart(4, '0')}`,
                children: []
            });
        }
        if (length >= 7) {
            const labelIndex = buffer.readUInt32BE(valueOffset + 3);
            tlvNode.children.push({
                name: 'Label Index',
                offset: valueOffset + 3,
                length: 4,
                value: labelIndex,
                children: []
            });
            tlvNode.value = `Label-Index ${labelIndex}`;
            prefixSidNode.value = prefixSidNode.value ? `${prefixSidNode.value}, Label-Index ${labelIndex}` : `Label-Index ${labelIndex}`;
        }
        return;
    }

    if (type === 3) {
        if (length >= 2) {
            tlvNode.children.push({
                name: 'Flags',
                offset: valueOffset,
                length: 2,
                value: `0x${buffer.readUInt16BE(valueOffset).toString(16).padStart(4, '0')}`,
                children: []
            });
        }

        const ranges = [];
        let rangeOffset = valueOffset + 2;
        let rangeIndex = 1;
        while (rangeOffset + 6 <= valueOffset + length) {
            const start = readUint24BE(buffer, rangeOffset);
            const range = readUint24BE(buffer, rangeOffset + 3);
            ranges.push(`${start}+${range}`);
            tlvNode.children.push({
                name: `SRGB Range ${rangeIndex}`,
                offset: rangeOffset,
                length: 6,
                value: `${start}+${range}`,
                children: [
                    {
                        name: 'Start Label',
                        offset: rangeOffset,
                        length: 3,
                        value: start,
                        children: []
                    },
                    {
                        name: 'Range Size',
                        offset: rangeOffset + 3,
                        length: 3,
                        value: range,
                        children: []
                    }
                ]
            });
            rangeOffset += 6;
            rangeIndex += 1;
        }
        tlvNode.value = ranges.length > 0 ? `SRGB ${ranges.join(',')}` : 'SRGB';
        if (ranges.length > 0) {
            prefixSidNode.value = prefixSidNode.value ? `${prefixSidNode.value}, SRGB ${ranges.join(',')}` : `SRGB ${ranges.join(',')}`;
        }
    }

    if (type === 5 || type === 6 || type === 7) {
        addSrv6ServiceTlvDetails(buffer, prefixSidNode, tlvNode, type, valueOffset, length);
    }
}

function addPrefixSidAttributeNode(buffer, attrNode, valueOffset, attrLength) {
    const prefixSidNode = {
        name: 'PREFIX_SID',
        offset: valueOffset,
        length: attrLength,
        value: '',
        children: []
    };
    attrNode.children.push(prefixSidNode);

    let tlvOffset = valueOffset;
    const attrEnd = valueOffset + attrLength;
    while (tlvOffset < attrEnd) {
        if (tlvOffset + 3 > attrEnd) {
            prefixSidNode.children.push({
                name: 'Malformed TLV',
                offset: tlvOffset,
                length: attrEnd - tlvOffset,
                value: 'Truncated Prefix-SID TLV header',
                children: []
            });
            break;
        }

        const type = buffer[tlvOffset];
        const length = buffer.readUInt16BE(tlvOffset + 1);
        const valueOffsetForTlv = tlvOffset + 3;
        const tlvEnd = valueOffsetForTlv + length;
        const tlvNode = {
            name: `TLV ${type} (${getBgpPrefixSidTlvTypeName(type)})`,
            offset: tlvOffset,
            length: Math.min(3 + length, attrEnd - tlvOffset),
            value: '',
            children: [
                {
                    name: 'Type',
                    offset: tlvOffset,
                    length: 1,
                    value: `${type} (${getBgpPrefixSidTlvTypeName(type)})`,
                    children: []
                },
                {
                    name: 'Length',
                    offset: tlvOffset + 1,
                    length: 2,
                    value: length,
                    children: []
                }
            ]
        };
        prefixSidNode.children.push(tlvNode);

        if (tlvEnd > attrEnd) {
            tlvNode.value = 'Malformed: length exceeds attribute';
            break;
        }

        addPrefixSidTlvDetails(buffer, prefixSidNode, tlvNode, type, valueOffsetForTlv, length);
        if (!tlvNode.value) {
            tlvNode.value = buffer.subarray(valueOffsetForTlv, tlvEnd).toString('hex');
        }
        tlvOffset = tlvEnd;
    }
}

/**
 * Parse a BGP packet into a tree structure
 * @param {Buffer} buffer - The raw BGP packet buffer
 * @param {Object} tree - The tree structure to add BGP information to
 * @param {number} offset - Starting offset in the buffer
 * @returns {Object} Parse result with valid flag and tree structure
 */
function parseBgpPacket(buffer, tree, offset = 0) {
    try {
        // 检查缓冲区是否有效
        if (!Buffer.isBuffer(buffer) || buffer.length < BgpConst.BGP_HEAD_LEN) {
            return {
                valid: false,
                error: 'Invalid buffer or buffer too small'
            };
        }

        let curOffset = offset;

        // 解析BGP头部
        const headerNode = {
            name: 'BGP Packet',
            offset: curOffset,
            length: buffer.length - curOffset,
            value: '',
            children: []
        };
        tree.children.push(headerNode);

        // 解析标记
        const markerNode = {
            name: 'Marker',
            offset: curOffset,
            length: BgpConst.BGP_MARKER_LEN,
            value: 'All ones (0xFF)',
            children: []
        };
        headerNode.children.push(markerNode);

        // 检查BGP标记是否有效（16字节的0xFF）
        const marker = buffer.subarray(curOffset, curOffset + BgpConst.BGP_MARKER_LEN);
        if (!marker.every(byte => byte === 0xff)) {
            return {
                valid: false,
                error: 'Invalid BGP marker',
                tree
            };
        }
        curOffset += BgpConst.BGP_MARKER_LEN;

        // 解析长度
        const length = buffer.readUInt16BE(curOffset);
        const lengthNode = {
            name: 'Length',
            offset: curOffset,
            length: 2,
            value: length,
            children: []
        };
        headerNode.children.push(lengthNode);
        curOffset += 2;

        // 解析类型
        const type = buffer[curOffset];
        const typeName = getBgpPacketTypeName(type);
        const typeNode = {
            name: 'Type',
            offset: curOffset,
            length: 1,
            value: `${type} (${typeName})`,
            children: []
        };
        headerNode.children.push(typeNode);
        curOffset += 1;

        // 检查缓冲区是否包含完整的数据包
        if (buffer.length < length) {
            return {
                valid: false,
                error: `Incomplete packet: expected ${length} bytes, got ${buffer.length}`,
                tree
            };
        }

        // 根据消息类型解析消息体
        let payload = null;
        let newOffset = curOffset;

        switch (type) {
            case BgpConst.BGP_PACKET_TYPE.OPEN:
                newOffset = parseOpenMessageTree(buffer, curOffset, headerNode);
                break;
            case BgpConst.BGP_PACKET_TYPE.UPDATE:
                newOffset = parseUpdateMessageTree(buffer, curOffset, headerNode);
                break;
            case BgpConst.BGP_PACKET_TYPE.NOTIFICATION:
                newOffset = parseNotificationMessageTree(buffer, curOffset, headerNode);
                break;
            case BgpConst.BGP_PACKET_TYPE.KEEPALIVE:
                // Keepalive没有额外数据
                // messageBodyNode.value = 'No data (Keepalive message)';
                newOffset = curOffset;
                break;
            case BgpConst.BGP_PACKET_TYPE.ROUTE_REFRESH:
                newOffset = parseRouteRefreshMessageTree(buffer, curOffset, headerNode);
                break;
            default:
                return {
                    valid: false,
                    error: `Unknown packet type: ${type}`,
                    tree
                };
        }

        // 验证我们是否正确解析了所有内容
        if (newOffset - offset !== length) {
            logger.warn(`BGP parsing mismatch: expected length ${length}, actual parsed length ${newOffset - offset}`);
        }

        // 更新头节点长度
        headerNode.length = length;

        return {
            valid: true,
            payload
        };
    } catch (error) {
        return {
            valid: false,
            error: `Error parsing BGP packet tree: ${error.message}`
        };
    }
}

/**
 * Parse BGP OPEN message into a tree structure
 * @param {Buffer} buffer - Raw BGP packet buffer
 * @param {Object} parentNode - Parent tree node to attach the parsing results
 * @returns {number} The new offset after parsing the message
 */
function parseOpenMessageTree(buffer, curOffset, parentNode) {
    // 版本
    const version = buffer[curOffset];
    const versionNode = {
        name: 'Version',
        offset: curOffset,
        length: 1,
        value: version,
        children: []
    };
    parentNode.children.push(versionNode);
    curOffset += 1;

    // ASN
    const asn = buffer.readUInt16BE(curOffset);
    const asnNode = {
        name: 'ASN',
        offset: curOffset,
        length: 2,
        value: asn,
        children: []
    };
    parentNode.children.push(asnNode);
    curOffset += 2;

    // 保持时间
    const holdTime = buffer.readUInt16BE(curOffset);
    const holdTimeNode = {
        name: 'Hold Time',
        offset: curOffset,
        length: 2,
        value: holdTime,
        children: []
    };
    parentNode.children.push(holdTimeNode);
    curOffset += 2;

    // BGP标识符（路由器ID）
    const ipStr = ipv4BufferToString(buffer.subarray(curOffset, curOffset + 4));
    const bgpIdNode = {
        name: 'BGP Identifier (Router ID)',
        offset: curOffset,
        length: 4,
        value: ipStr,
        children: []
    };
    parentNode.children.push(bgpIdNode);
    curOffset += 4;

    // 可选参数长度
    const optParamLen = buffer[curOffset];
    const optParamLenNode = {
        name: 'Optional Parameters Length',
        offset: curOffset,
        length: 1,
        value: optParamLen,
        children: []
    };
    parentNode.children.push(optParamLenNode);
    curOffset += 1;

    // Optional Parameters
    if (optParamLen > 0) {
        const optParamsNode = {
            name: 'Optional Parameters',
            offset: curOffset,
            length: optParamLen,
            value: '',
            children: []
        };
        parentNode.children.push(optParamsNode);

        const optParamsEnd = curOffset + optParamLen;

        while (curOffset < optParamsEnd) {
            const paramType = buffer[curOffset];
            const paramLen = buffer[curOffset + 1];

            const paramNode = {
                name: `Parameter (Type: ${paramType})`,
                offset: curOffset,
                length: paramLen + 2, // Including type and length fields
                value: '',
                children: []
            };
            optParamsNode.children.push(paramNode);

            // Parameter Type
            const paramTypeNode = {
                name: 'Parameter Type',
                offset: curOffset,
                length: 1,
                value: paramType,
                children: []
            };
            paramNode.children.push(paramTypeNode);

            // Parameter Length
            const paramLenNode = {
                name: 'Parameter Length',
                offset: curOffset + 1,
                length: 1,
                value: paramLen,
                children: []
            };
            paramNode.children.push(paramLenNode);

            curOffset += 2;

            // Parameter type 2 is capability
            if (paramType === BgpConst.BGP_OPEN_OPT_TYPE.OPT_TYPE) {
                const capabilitiesNode = {
                    name: 'Capabilities',
                    offset: curOffset,
                    length: paramLen,
                    value: '',
                    children: []
                };
                paramNode.children.push(capabilitiesNode);

                let capOffset = curOffset;
                const capEndOffset = capOffset + paramLen;

                while (capOffset < capEndOffset) {
                    const capCode = buffer[capOffset];
                    const capLen = buffer[capOffset + 1];

                    const capabilityNode = {
                        name: `Capability (Code: ${capCode} - ${getBgpOpenCapabilityName(capCode)})`,
                        offset: capOffset,
                        length: capLen + 2, // Including code and length fields
                        value: '',
                        children: []
                    };
                    capabilitiesNode.children.push(capabilityNode);

                    // Capability Code
                    const capCodeNode = {
                        name: 'Code',
                        offset: capOffset,
                        length: 1,
                        value: `${capCode} (${getBgpOpenCapabilityName(capCode)})`,
                        children: []
                    };
                    capabilityNode.children.push(capCodeNode);

                    // Capability Length
                    const capLenNode = {
                        name: 'Length',
                        offset: capOffset + 1,
                        length: 1,
                        value: capLen,
                        children: []
                    };
                    capabilityNode.children.push(capLenNode);

                    capOffset += 2;

                    // Capability Value
                    if (capLen > 0) {
                        let valueOffset = capOffset;

                        // Parse capability-specific data
                        switch (capCode) {
                            case BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS:
                                if (capLen >= 4) {
                                    const afi = buffer.readUInt16BE(valueOffset);
                                    const afiNode = {
                                        name: 'AFI',
                                        offset: valueOffset,
                                        length: 2,
                                        value: `${afi} (${getBgpAfiName(afi)})`,
                                        children: []
                                    };
                                    capabilityNode.children.push(afiNode);
                                    valueOffset += 2;

                                    const reserved = buffer[valueOffset];
                                    const reservedNode = {
                                        name: 'Reserved',
                                        offset: valueOffset,
                                        length: 1,
                                        value: reserved,
                                        children: []
                                    };
                                    capabilityNode.children.push(reservedNode);
                                    valueOffset += 1;

                                    const safi = buffer[valueOffset];
                                    const safiNode = {
                                        name: 'SAFI',
                                        offset: valueOffset,
                                        length: 1,
                                        value: `${safi} (${getBgpSafiName(safi)})`,
                                        children: []
                                    };
                                    capabilityNode.children.push(safiNode);
                                }
                                break;

                            case BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS:
                                if (capLen >= 4) {
                                    const as4 = buffer.readUInt32BE(valueOffset);
                                    const as4Node = {
                                        name: '4-Octet AS Number',
                                        offset: valueOffset,
                                        length: 4,
                                        value: as4,
                                        children: []
                                    };
                                    capabilityNode.children.push(as4Node);
                                }
                                break;

                            case BgpConst.BGP_OPEN_CAP_CODE.BGP_ROLE:
                                if (capLen >= 1) {
                                    const role = buffer[valueOffset];
                                    const roleNode = {
                                        name: 'Role',
                                        offset: valueOffset,
                                        length: 1,
                                        value: `${role} (${getBgpOpenRoleName(role)})`,
                                        children: []
                                    };
                                    capabilityNode.children.push(roleNode);
                                }
                                break;

                            default: {
                                const valueNode = {
                                    name: 'Value',
                                    offset: valueOffset,
                                    length: capLen,
                                    value: buffer.subarray(valueOffset, valueOffset + capLen).toString('hex'),
                                    children: []
                                };
                                capabilityNode.children.push(valueNode);
                            }
                        }
                    }

                    capOffset += capLen;
                }
                curOffset += paramLen;
            } else {
                // For other parameter types
                const paramValueNode = {
                    name: 'Parameter Value',
                    offset: curOffset,
                    length: paramLen,
                    value: buffer.subarray(curOffset, curOffset + paramLen).toString('hex'),
                    children: []
                };
                paramNode.children.push(paramValueNode);
                curOffset += paramLen;
            }
        }
    }

    return curOffset;
}

/**
 * Parse BGP UPDATE message into a tree structure
 * @param {Buffer} buffer - Raw BGP packet buffer
 * @param {Object} parentNode - Parent tree node to attach the parsing results
 * @returns {number} The new offset after parsing the message
 */
function parseUpdateMessageTree(buffer, curOffset, parentNode) {
    // Withdrawn Routes Length
    const withdrawnRoutesLength = buffer.readUInt16BE(curOffset);
    const withdrawnRoutesLengthNode = {
        name: 'Withdrawn Routes Length',
        offset: curOffset,
        length: 2,
        value: withdrawnRoutesLength,
        children: []
    };
    parentNode.children.push(withdrawnRoutesLengthNode);
    curOffset += 2;

    // Withdrawn Routes
    if (withdrawnRoutesLength > 0) {
        const withdrawnRoutesNode = {
            name: 'Withdrawn Routes',
            offset: curOffset,
            length: withdrawnRoutesLength,
            value: '',
            children: []
        };
        parentNode.children.push(withdrawnRoutesNode);

        const withdrawnRoutesEnd = curOffset + withdrawnRoutesLength;
        let routeIndex = 0;

        while (curOffset < withdrawnRoutesEnd) {
            const prefixLength = buffer[curOffset];
            const prefixBytes = Math.ceil(prefixLength / 8);

            const prefixNode = {
                name: `Route ${routeIndex + 1}`,
                offset: curOffset,
                length: 1 + prefixBytes, // Length field + prefix bytes
                value: '',
                children: []
            };
            withdrawnRoutesNode.children.push(prefixNode);

            // Prefix Length
            const prefixLengthNode = {
                name: 'Prefix Length',
                offset: curOffset,
                length: 1,
                value: prefixLength,
                children: []
            };
            prefixNode.children.push(prefixLengthNode);
            curOffset += 1;

            // Extract the prefix
            if (prefixBytes > 0) {
                const prefixBuffer = buffer.subarray(curOffset, curOffset + prefixBytes);
                const prefix = ipv4BufferToString(prefixBuffer, prefixLength);

                const prefixValueNode = {
                    name: 'Prefix',
                    offset: curOffset,
                    length: prefixBytes,
                    value: prefix,
                    children: []
                };
                prefixNode.children.push(prefixValueNode);
                curOffset += prefixBytes;

                prefixNode.value = `${prefixLength} bits: ${prefix}`;
            } else {
                prefixNode.value = `${prefixLength} bits: 0.0.0.0`;
            }

            routeIndex++;
        }
    }

    // Path Attributes Length
    const pathAttributesLength = buffer.readUInt16BE(curOffset);
    const pathAttributesLengthNode = {
        name: 'Path Attributes Length',
        offset: curOffset,
        length: 2,
        value: pathAttributesLength,
        children: []
    };
    parentNode.children.push(pathAttributesLengthNode);
    curOffset += 2;

    // Path Attributes
    if (pathAttributesLength > 0) {
        const pathAttributesNode = {
            name: 'Path Attributes',
            offset: curOffset,
            length: pathAttributesLength,
            value: '',
            children: []
        };
        parentNode.children.push(pathAttributesNode);

        const pathAttributesEnd = curOffset + pathAttributesLength;

        while (curOffset < pathAttributesEnd) {
            const attrFlags = buffer[curOffset];
            const attrTypeCode = buffer[curOffset + 1];

            // Check if extended length bit is set
            const extendedLength = (attrFlags & BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH) !== 0;
            const attrLengthSize = extendedLength ? 2 : 1;
            const attrLength = extendedLength ? buffer.readUInt16BE(curOffset + 2) : buffer[curOffset + 2];

            const headerLength = 2 + attrLengthSize; // Flags + Type + Length field

            const attrNode = {
                name: `Attribute (Type: ${attrTypeCode} - ${getBgpPathAttrTypeName(attrTypeCode)})`,
                offset: curOffset,
                length: headerLength + attrLength,
                value: '',
                children: []
            };
            pathAttributesNode.children.push(attrNode);

            // Attribute Flags
            const flagsStr = [
                attrFlags & BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL ? 'OPTIONAL' : '',
                attrFlags & BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE ? 'TRANSITIVE' : '',
                attrFlags & BgpConst.BGP_PATH_ATTR_FLAGS.PARTIAL ? 'PARTIAL' : '',
                attrFlags & BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH ? 'EXTENDED_LENGTH' : ''
            ]
                .filter(Boolean)
                .join('|');

            const attrFlagsNode = {
                name: 'Flags',
                offset: curOffset,
                length: 1,
                value: `0x${attrFlags.toString(16)} (${flagsStr})`,
                children: []
            };
            attrNode.children.push(attrFlagsNode);

            // Attribute Type
            const attrTypeNode = {
                name: 'Type',
                offset: curOffset + 1,
                length: 1,
                value: `${attrTypeCode} (${getBgpPathAttrTypeName(attrTypeCode)})`,
                children: []
            };
            attrNode.children.push(attrTypeNode);

            // Attribute Length
            const attrLengthNode = {
                name: 'Length',
                offset: curOffset + 2,
                length: attrLengthSize,
                value: attrLength,
                children: []
            };
            attrNode.children.push(attrLengthNode);

            // Attribute Value
            const valueOffset = curOffset + headerLength;

            // Parse attribute value based on type
            switch (attrTypeCode) {
                case BgpConst.BGP_PATH_ATTR.ORIGIN: {
                    const origin = buffer[valueOffset];
                    const originName = getBgpOriginType(origin);
                    const valueNode = {
                        name: 'Value',
                        offset: valueOffset,
                        length: attrLength,
                        value: `${origin} (${originName})`,
                        children: []
                    };
                    attrNode.children.push(valueNode);
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.AS_PATH: {
                    const asPathNode = {
                        name: 'AS_PATH',
                        offset: valueOffset,
                        length: attrLength,
                        value: '',
                        children: []
                    };
                    attrNode.children.push(asPathNode);

                    // Parse AS_PATH segments
                    let segmentOffset = valueOffset;
                    let segmentIndex = 0;

                    while (segmentOffset < valueOffset + attrLength) {
                        const segmentType = buffer[segmentOffset];
                        const segmentTypeName = getBgpAsPathTypeName(segmentType);
                        const segmentLength = buffer[segmentOffset + 1]; // Number of ASNs

                        const segmentNode = {
                            name: `Segment ${segmentIndex + 1} (${segmentTypeName})`,
                            offset: segmentOffset,
                            length: 2 + segmentLength * 4, // type + length + AS numbers (4 bytes each)
                            value: segmentTypeName,
                            children: []
                        };
                        asPathNode.children.push(segmentNode);

                        // Segment Type
                        const segmentTypeNode = {
                            name: 'Type',
                            offset: segmentOffset,
                            length: 1,
                            value: `${segmentType} (${segmentTypeName})`,
                            children: []
                        };
                        segmentNode.children.push(segmentTypeNode);

                        // Segment Length
                        const segmentLengthNode = {
                            name: 'Length',
                            offset: segmentOffset + 1,
                            length: 1,
                            value: segmentLength,
                            children: []
                        };
                        segmentNode.children.push(segmentLengthNode);

                        segmentOffset += 2;

                        // AS Numbers
                        const asNumbers = [];
                        for (let i = 0; i < segmentLength; i++) {
                            const asn = buffer.readUInt32BE(segmentOffset);
                            asNumbers.push(asn);

                            const asnNode = {
                                name: `AS${i + 1}`,
                                offset: segmentOffset,
                                length: 4,
                                value: asn,
                                children: []
                            };
                            segmentNode.children.push(asnNode);

                            segmentOffset += 4;
                        }

                        // Update segment value with AS numbers
                        if (segmentType === BgpConst.BGP_AS_PATH_TYPE.AS_SEQUENCE) {
                            segmentNode.value = `${segmentTypeName}: ${asNumbers.join(' ')}`;
                        } else {
                            segmentNode.value = `${segmentTypeName}: {${asNumbers.join(' ')}}`;
                        }

                        segmentIndex++;
                    }
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.NEXT_HOP: {
                    const nextHop = `${buffer[valueOffset]}.${buffer[valueOffset + 1]}.${buffer[valueOffset + 2]}.${buffer[valueOffset + 3]}`;
                    const valueNode = {
                        name: 'Next Hop',
                        offset: valueOffset,
                        length: attrLength,
                        value: nextHop,
                        children: []
                    };
                    attrNode.children.push(valueNode);
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.MED: {
                    const med = buffer.readUInt32BE(valueOffset);
                    const valueNode = {
                        name: 'MED',
                        offset: valueOffset,
                        length: attrLength,
                        value: med,
                        children: []
                    };
                    attrNode.children.push(valueNode);
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.LOCAL_PREF: {
                    const localPref = buffer.readUInt32BE(valueOffset);
                    const valueNode = {
                        name: 'Local Preference',
                        offset: valueOffset,
                        length: attrLength,
                        value: localPref,
                        children: []
                    };
                    attrNode.children.push(valueNode);
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.ATOMIC_AGGREGATE: {
                    const valueNode = {
                        name: 'Atomic Aggregate',
                        offset: valueOffset,
                        length: attrLength,
                        value: 'Present',
                        children: []
                    };
                    attrNode.children.push(valueNode);
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.AGGREGATOR: {
                    const aggregatorAs = buffer.readUInt16BE(valueOffset);
                    const aggregatorIp = `${buffer[valueOffset + 2]}.${buffer[valueOffset + 3]}.${buffer[valueOffset + 4]}.${buffer[valueOffset + 5]}`;

                    const valueNode = {
                        name: 'Aggregator',
                        offset: valueOffset,
                        length: attrLength,
                        value: `AS: ${aggregatorAs}, IP: ${aggregatorIp}`,
                        children: []
                    };

                    const asNode = {
                        name: 'AS',
                        offset: valueOffset,
                        length: 2,
                        value: aggregatorAs,
                        children: []
                    };
                    valueNode.children.push(asNode);

                    const ipNode = {
                        name: 'IP',
                        offset: valueOffset + 2,
                        length: 4,
                        value: aggregatorIp,
                        children: []
                    };
                    valueNode.children.push(ipNode);

                    attrNode.children.push(valueNode);
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.COMMUNITY: {
                    const communitiesNode = {
                        name: 'Communities',
                        offset: valueOffset,
                        length: attrLength,
                        value: '',
                        children: []
                    };
                    attrNode.children.push(communitiesNode);

                    // Each community is 4 bytes (32 bits)
                    const communityCount = attrLength / 4;
                    const communities = [];

                    for (let i = 0; i < communityCount; i++) {
                        const commOffset = valueOffset + i * 4;
                        const highOrder = buffer.readUInt16BE(commOffset);
                        const lowOrder = buffer.readUInt16BE(commOffset + 2);
                        const communityValue = `${highOrder}:${lowOrder}`;
                        communities.push(communityValue);

                        const communityNode = {
                            name: `Community ${i + 1}`,
                            offset: commOffset,
                            length: 4,
                            value: communityValue,
                            children: []
                        };
                        communitiesNode.children.push(communityNode);
                    }

                    communitiesNode.value = communities.join(', ');
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI: {
                    const mpReachNode = {
                        name: 'MP_REACH_NLRI',
                        offset: valueOffset,
                        length: attrLength,
                        value: '',
                        children: []
                    };
                    attrNode.children.push(mpReachNode);

                    // Parse AFI
                    const afi = buffer.readUInt16BE(valueOffset);
                    const afiNode = {
                        name: 'AFI',
                        offset: valueOffset,
                        length: 2,
                        value: `${afi} (${getBgpAfiName(afi)})`,
                        children: []
                    };
                    mpReachNode.children.push(afiNode);

                    // Parse SAFI
                    const safi = buffer[valueOffset + 2]; // +3 because of 1 reserved byte
                    const safiNode = {
                        name: 'SAFI',
                        offset: valueOffset + 2,
                        length: 1,
                        value: `${safi} (${getBgpSafiName(safi)})`,
                        children: []
                    };
                    mpReachNode.children.push(safiNode);

                    // length
                    const lengthNode = {
                        name: 'Length',
                        offset: valueOffset + 3,
                        length: 1,
                        value: buffer[valueOffset + 3],
                        children: []
                    };
                    mpReachNode.children.push(lengthNode);

                    // The rest of MP_REACH_NLRI parsing could be implemented here
                    // but it's complex due to variable formats based on AFI/SAFI
                    const remainingDataNode = {
                        name: 'Next Hop & NLRI Data',
                        offset: valueOffset + 4,
                        length: attrLength - 4,
                        value: buffer.subarray(valueOffset + 4, valueOffset + attrLength).toString('hex'),
                        children: []
                    };
                    mpReachNode.children.push(remainingDataNode);
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI: {
                    const mpUnreachNode = {
                        name: 'MP_UNREACH_NLRI',
                        offset: valueOffset,
                        length: attrLength,
                        value: '',
                        children: []
                    };
                    attrNode.children.push(mpUnreachNode);

                    // Parse AFI
                    const afi = buffer.readUInt16BE(valueOffset);
                    const afiNode = {
                        name: 'AFI',
                        offset: valueOffset,
                        length: 2,
                        value: `${afi} (${getBgpAfiName(afi)})`,
                        children: []
                    };
                    mpUnreachNode.children.push(afiNode);

                    // Parse SAFI
                    const safi = buffer[valueOffset + 2];
                    const safiNode = {
                        name: 'SAFI',
                        offset: valueOffset + 2,
                        length: 1,
                        value: `${safi} (${getBgpSafiName(safi)})`,
                        children: []
                    };
                    mpUnreachNode.children.push(safiNode);

                    // The rest of MP_UNREACH_NLRI parsing could be implemented here
                    if (attrLength > 3) {
                        const withdrawnDataNode = {
                            name: 'Withdrawn Routes Data',
                            offset: valueOffset + 3,
                            length: attrLength - 3,
                            value: buffer.subarray(valueOffset + 3, valueOffset + attrLength).toString('hex'),
                            children: []
                        };
                        mpUnreachNode.children.push(withdrawnDataNode);
                    }
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.PREFIX_SID: {
                    addPrefixSidAttributeNode(buffer, attrNode, valueOffset, attrLength);
                    break;
                }
                default: {
                    const valueNode = {
                        name: 'Value',
                        offset: valueOffset,
                        length: attrLength,
                        value: buffer.subarray(valueOffset, valueOffset + attrLength).toString('hex'),
                        children: []
                    };
                    attrNode.children.push(valueNode);
                }
            }

            curOffset += headerLength + attrLength;
        }
    }

    // NLRI (Network Layer Reachability Information)
    const nlriLength = buffer.length - curOffset;
    if (nlriLength > 0) {
        const nlriNode = {
            name: 'NLRI',
            offset: curOffset,
            length: nlriLength,
            value: '',
            children: []
        };
        parentNode.children.push(nlriNode);

        let routeIndex = 0;
        while (curOffset < buffer.length) {
            const prefixLength = buffer[curOffset];
            const prefixBytes = Math.ceil(prefixLength / 8);

            const prefixNode = {
                name: `Route ${routeIndex + 1}`,
                offset: curOffset,
                length: 1 + prefixBytes,
                value: '',
                children: []
            };
            nlriNode.children.push(prefixNode);

            // Prefix Length
            const prefixLengthNode = {
                name: 'Prefix Length',
                offset: curOffset,
                length: 1,
                value: prefixLength,
                children: []
            };
            prefixNode.children.push(prefixLengthNode);
            curOffset += 1;

            // Prefix
            if (prefixBytes > 0) {
                const prefixBuffer = buffer.subarray(curOffset, curOffset + prefixBytes);
                const prefix = ipv4BufferToString(prefixBuffer, prefixLength);

                const prefixValueNode = {
                    name: 'Prefix',
                    offset: curOffset,
                    length: prefixBytes,
                    value: prefix,
                    children: []
                };
                prefixNode.children.push(prefixValueNode);
                curOffset += prefixBytes;

                prefixNode.value = `${prefixLength} bits: ${prefix}`;
            } else {
                prefixNode.value = `${prefixLength} bits: 0.0.0.0`;
            }

            routeIndex++;
        }
    }

    return curOffset;
}

/**
 * Parse BGP NOTIFICATION message into a tree structure
 * @param {Buffer} buffer - Raw BGP packet buffer
 * @param {Object} parentNode - Parent tree node to attach the parsing results
 * @returns {number} The new offset after parsing the message
 */
function parseNotificationMessageTree(buffer, curOffset, parentNode) {
    // Error Code
    const errorCode = buffer[curOffset];
    const errorCodeNode = {
        name: 'Error Code',
        offset: curOffset,
        length: 1,
        value: errorCode,
        children: []
    };
    parentNode.children.push(errorCodeNode);
    curOffset += 1;

    // Error Subcode
    const errorSubcode = buffer[curOffset];
    const errorSubcodeNode = {
        name: 'Error Subcode',
        offset: curOffset,
        length: 1,
        value: `${errorSubcode} (${getBgpNotificationErrorName(errorCode, errorSubcode)})`,
        children: []
    };
    parentNode.children.push(errorSubcodeNode);
    curOffset += 1;

    // Data
    const dataLength = buffer.length - curOffset;
    if (dataLength > 0) {
        const dataNode = {
            name: 'Data',
            offset: curOffset,
            length: dataLength,
            value: buffer.subarray(curOffset, buffer.length).toString('hex'),
            children: []
        };
        parentNode.children.push(dataNode);
        curOffset += dataLength;
    }

    return curOffset;
}

/**
 * Parse BGP ROUTE-REFRESH message into a tree structure
 * @param {Buffer} buffer - Raw BGP packet buffer
 * @param {Object} parentNode - Parent tree node to attach the parsing results
 * @returns {number} The new offset after parsing the message
 */
function parseRouteRefreshMessageTree(buffer, curOffset, parentNode) {
    // AFI
    const afi = buffer.readUInt16BE(curOffset);
    const afiNode = {
        name: 'AFI',
        offset: curOffset,
        length: 2,
        value: `${afi} (${getBgpAfiName(afi)})`,
        children: []
    };
    parentNode.children.push(afiNode);
    curOffset += 2;

    // Reserved
    const reserved = buffer[curOffset];
    const reservedNode = {
        name: 'Reserved',
        offset: curOffset,
        length: 1,
        value: reserved,
        children: []
    };
    parentNode.children.push(reservedNode);
    curOffset += 1;

    // SAFI
    const safi = buffer[curOffset];
    const safiNode = {
        name: 'SAFI',
        offset: curOffset,
        length: 1,
        value: `${safi} (${getBgpSafiName(safi)})`,
        children: []
    };
    parentNode.children.push(safiNode);
    curOffset += 1;

    return curOffset;
}

module.exports = {
    parseBgpPacket
};
