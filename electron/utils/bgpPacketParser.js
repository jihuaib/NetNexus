/**
 * BGP Packet Parser
 *
 * Parses BGP protocol packets from raw buffers and returns structured data.
 * Based on RFC 4271 and other BGP extension RFCs.
 */

// Import constants from existing BGP constants file
const BgpConst = require('../const/bgpConst');
const {
    ipv4BufferToString,
    ipv6BufferToString,
    getIpTypeName,
    rdBufferToString,
    extCommunitiesBufferToString
} = require('../utils/ipUtils');
const {
    getBgpPacketTypeName,
    getBgpOpenCapabilityName,
    getBgpAfiName,
    getBgpSafiName,
    getBgpOpenRoleName,
    getBgpPathAttrTypeName,
    getBgpOriginType,
    getBgpAsPathTypeName,
    getBgpNotificationErrorName,
    getBgpAddPathTypeName
} = require('../utils/bgpUtils');

/**
 * Parse a BGP packet from a buffer
 * @param {Buffer} buffer - The raw BGP packet buffer
 * @param {Object} context - Context object (e.g. bgpSession)
 * @returns {Object} Parsed BGP packet data
 */
function parseBgpPacket(buffer, context) {
    try {
        // Check if buffer is valid
        if (!Buffer.isBuffer(buffer) || buffer.length < BgpConst.BGP_HEAD_LEN) {
            return {
                valid: false,
                error: 'Invalid buffer or buffer too small'
            };
        }

        // Check if the BGP marker is valid (16 bytes of 0xFF)
        const marker = buffer.subarray(0, BgpConst.BGP_MARKER_LEN);
        if (!marker.every(byte => byte === 0xff)) {
            return {
                valid: false,
                error: 'Invalid BGP marker'
            };
        }

        // Parse the header
        const length = buffer.readUInt16BE(BgpConst.BGP_MARKER_LEN);
        const type = buffer[BgpConst.BGP_MARKER_LEN + 2];

        // Check if the buffer contains the complete packet
        if (buffer.length < length) {
            return {
                valid: false,
                error: `Incomplete packet: expected ${length} bytes, got ${buffer.length}`
            };
        }

        // Parse the packet based on the message type
        let packet = {
            type,
            length,
            valid: true
        };

        // Add the parsed data based on message type
        switch (type) {
            case BgpConst.BGP_PACKET_TYPE.OPEN:
                packet = { ...packet, ...parseOpenMessage(buffer) };
                break;
            case BgpConst.BGP_PACKET_TYPE.UPDATE:
                packet = { ...packet, ...parseUpdateMessage(buffer, context) };
                break;
            case BgpConst.BGP_PACKET_TYPE.NOTIFICATION:
                // ...
                packet = { ...packet, ...parseNotificationMessage(buffer) };
                break;
            case BgpConst.BGP_PACKET_TYPE.KEEPALIVE:
                // Keepalive has no additional data
                break;
            case BgpConst.BGP_PACKET_TYPE.ROUTE_REFRESH:
                packet = { ...packet, ...parseRouteRefreshMessage(buffer) };
                break;
            default:
                packet.valid = false;
                packet.error = `Unknown packet type: ${type}`;
        }

        return packet;
    } catch (error) {
        return {
            valid: false,
            error: `Error parsing BGP packet: ${error.message}`
        };
    }
}

function parseQpDqpn(buffer, position, bitLength) {
    const byteLength = Math.ceil(bitLength / 8);
    let dqpn = 0;

    for (let i = 0; i < byteLength; i++) {
        dqpn = dqpn * 256 + buffer[position + i];
    }

    if (bitLength > 0 && bitLength % 8 !== 0) {
        dqpn &= (1 << bitLength % 8) - 1;
    }

    return {
        dqpn,
        byteLength
    };
}

function readBigEndianValue(buffer, position, length) {
    let value = 0n;
    for (let i = 0; i < length && position + i < buffer.length; i++) {
        value = (value << 8n) + BigInt(buffer[position + i]);
    }

    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(value);
    }
    return value.toString();
}

function getBit(buffer, bitIndex) {
    const byteIndex = Math.floor(bitIndex / 8);
    const bitOffset = 7 - (bitIndex % 8);
    return (buffer[byteIndex] >> bitOffset) & 0x01;
}

function setBit(buffer, bitIndex, value) {
    if (!value) {
        return;
    }

    const byteIndex = Math.floor(bitIndex / 8);
    const bitOffset = 7 - (bitIndex % 8);
    buffer[byteIndex] |= 1 << bitOffset;
}

function parseNextHop(buffer, position, nextHopLength, afi, safi) {
    if (nextHopLength === 0) {
        return '';
    }

    if (
        (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 || afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) &&
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_VPN
    ) {
        // RD(8) + IPv4(4) = 12 bytes
        if (nextHopLength === BgpConst.BGP_RD_LEN + BgpConst.IP_HOST_BYTE_LEN) {
            return ipv4BufferToString(
                buffer.subarray(position + BgpConst.BGP_RD_LEN, position + BgpConst.BGP_RD_LEN + BgpConst.IP_HOST_BYTE_LEN),
                BgpConst.IP_HOST_LEN
            );
        }

        // RD(8) + IPv6(16) = 24 bytes (VPNv6 or VPNv4 from IPv6 neighbor)
        if (nextHopLength === BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN) {
            return ipv6BufferToString(
                buffer.subarray(position + BgpConst.BGP_RD_LEN, position + BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN),
                BgpConst.IPV6_HOST_LEN
            );
        }

        // RD(8) + IPv6(16) + RD(8) + IPv6(16) = 48 bytes (global + link-local)
        if (nextHopLength === (BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN) * 2) {
            const globalNextHop = ipv6BufferToString(
                buffer.subarray(position + BgpConst.BGP_RD_LEN, position + BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN),
                BgpConst.IPV6_HOST_LEN
            );
            const linkLocalNextHopPosition = position + BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN + BgpConst.BGP_RD_LEN;
            const linkLocalNextHop = ipv6BufferToString(
                buffer.subarray(linkLocalNextHopPosition, linkLocalNextHopPosition + BgpConst.IPV6_HOST_BYTE_LEN),
                BgpConst.IPV6_HOST_LEN
            );
            return `${globalNextHop}, ${linkLocalNextHop}`;
        }

        return buffer.subarray(position, position + nextHopLength).toString('hex');
    }

    if (nextHopLength === BgpConst.IP_HOST_BYTE_LEN) {
        return ipv4BufferToString(buffer.subarray(position, position + 4), BgpConst.IP_HOST_LEN);
    }

    if (nextHopLength === BgpConst.IPV6_HOST_BYTE_LEN) {
        return ipv6BufferToString(buffer.subarray(position, position + 16), BgpConst.IPV6_HOST_LEN);
    }

    if (nextHopLength === BgpConst.IPV6_HOST_BYTE_LEN * 2) {
        const globalNextHop = ipv6BufferToString(
            buffer.subarray(position, position + 16),
            BgpConst.IPV6_HOST_LEN
        );
        const linkLocalNextHop = ipv6BufferToString(
            buffer.subarray(position + 16, position + 32),
            BgpConst.IPV6_HOST_LEN
        );
        return `${globalNextHop}, ${linkLocalNextHop}`;
    }

    return buffer.subarray(position, position + nextHopLength).toString('hex');
}

function parseFlowSpecLength(buffer, position) {
    const errors = [];
    if (position >= buffer.length) {
        return {
            nlriLength: 0,
            lengthBytes: 0,
            errors: ['FlowSpec NLRI length is missing']
        };
    }

    const firstByte = buffer[position];
    if (firstByte < 240) {
        return {
            nlriLength: firstByte,
            lengthBytes: 1,
            errors
        };
    }

    if (position + 1 >= buffer.length) {
        return {
            nlriLength: 0,
            lengthBytes: 1,
            errors: ['FlowSpec extended NLRI length is truncated']
        };
    }

    return {
        nlriLength: ((firstByte & 0x0f) << 8) + buffer[position + 1],
        lengthBytes: 2,
        errors
    };
}

const FLOW_SPEC_COMPONENT_NAMES = {
    1: 'dst',
    2: 'src',
    3: 'proto',
    4: 'port',
    5: 'dst-port',
    6: 'src-port',
    7: 'icmp-type',
    8: 'icmp-code',
    9: 'tcp-flags',
    10: 'packet-length',
    11: 'dscp',
    12: 'fragment',
    13: 'flow-label'
};

function getFlowSpecOperatorValueLength(operator) {
    return 1 << ((operator & 0x30) >> 4);
}

function getFlowSpecOperatorName(operator, isBitmask) {
    const names = [];
    if (operator & 0x40) {
        names.push('and');
    }

    if (isBitmask) {
        const operation = operator & 0x01 ? 'match' : 'any';
        names.push(operator & 0x02 ? `not ${operation}` : operation);
    } else {
        const comparisonNames = {
            0: 'false',
            1: '=',
            2: '>',
            3: '>=',
            4: '<',
            5: '<=',
            6: '!=',
            7: 'true'
        };
        names.push(comparisonNames[operator & 0x07]);
    }

    return names.length > 0 ? names.join(' ') : '=';
}

function buildIpv6PrefixFromPattern(prefixBuffer, prefixLength, prefixOffset) {
    const fullPrefixBuffer = Buffer.alloc(BgpConst.IPV6_HOST_BYTE_LEN);
    const carriedBits = Math.max(prefixLength - prefixOffset, 0);

    for (let bitIndex = 0; bitIndex < carriedBits; bitIndex++) {
        setBit(fullPrefixBuffer, prefixOffset + bitIndex, getBit(prefixBuffer, bitIndex));
    }

    return ipv6BufferToString(fullPrefixBuffer, prefixLength);
}

function isFlowSpecComponentTypeAllowed(type, afi) {
    if (type < 1 || type > 13) {
        return false;
    }

    return afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 || type !== 13;
}

function validateFlowSpecOperationLength(type, valueLength) {
    if (type === 9 && valueLength > 2) {
        return 'FlowSpec TCP flags bitmask must be encoded as 1 or 2 octets';
    }

    if (type === 11 && valueLength !== 1) {
        return 'FlowSpec DSCP value must be encoded as 1 octet';
    }

    if (type === 12 && valueLength !== 1) {
        return 'FlowSpec fragment bitmask must be encoded as 1 octet';
    }

    return null;
}

function parseFlowSpecPrefixComponent(buffer, position, type, afi) {
    const errors = [];
    const isIpv6 = afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6;
    if (position >= buffer.length) {
        return {
            position: buffer.length,
            component: {
                type,
                name: FLOW_SPEC_COMPONENT_NAMES[type] || `type-${type}`,
                prefix: '',
                length: 0,
                offset: 0,
                formatted: `${FLOW_SPEC_COMPONENT_NAMES[type] || `type-${type}`}=truncated`
            },
            errors: ['FlowSpec prefix component length is truncated']
        };
    }

    const prefixLength = buffer[position];
    position += 1;

    let prefixOffset = 0;
    if (isIpv6) {
        if (position >= buffer.length) {
            return {
                position: buffer.length,
                component: {
                    type,
                    name: FLOW_SPEC_COMPONENT_NAMES[type] || `type-${type}`,
                    prefix: '',
                    length: prefixLength,
                    offset: 0,
                    formatted: `${FLOW_SPEC_COMPONENT_NAMES[type] || `type-${type}`}=truncated`
                },
                errors: ['IPv6 FlowSpec prefix offset is truncated']
            };
        }
        prefixOffset = buffer[position];
        position += 1;
    }

    if (isIpv6) {
        const isMatchAny = prefixLength === 0 && prefixOffset === 0;
        if (!isMatchAny && !(prefixOffset < prefixLength && prefixLength < 129)) {
            errors.push(`Invalid IPv6 FlowSpec prefix length/offset: length=${prefixLength}, offset=${prefixOffset}`);
        }
    } else if (prefixLength > BgpConst.IP_HOST_LEN) {
        errors.push(`Invalid IPv4 FlowSpec prefix length: ${prefixLength}`);
    }

    const carriedBits = Math.max(prefixLength - prefixOffset, 0);
    const prefixBytes = Math.ceil(carriedBits / 8);
    if (position + prefixBytes > buffer.length) {
        errors.push('FlowSpec prefix component is truncated');
    }
    const prefixBuffer = buffer.subarray(position, position + prefixBytes);
    position += prefixBytes;

    let prefix;
    if (isIpv6) {
        prefix = buildIpv6PrefixFromPattern(prefixBuffer, prefixLength, prefixOffset);
    } else {
        prefix = ipv4BufferToString(prefixBuffer, prefixLength);
    }

    const name = FLOW_SPEC_COMPONENT_NAMES[type] || `type-${type}`;
    const offsetText = prefixOffset > 0 ? ` offset ${prefixOffset}` : '';
    return {
        position,
        component: {
            type,
            name,
            prefix,
            length: prefixLength,
            offset: prefixOffset,
            formatted: `${name}=${prefix}/${prefixLength}${offsetText}`
        },
        errors
    };
}

function parseFlowSpecComponents(buffer, afi) {
    const components = [];
    const errors = [];
    let position = 0;
    let lastType = 0;

    while (position < buffer.length) {
        const type = buffer[position];
        position += 1;

        if (!FLOW_SPEC_COMPONENT_NAMES[type] || !isFlowSpecComponentTypeAllowed(type, afi)) {
            errors.push(`Unknown FlowSpec component type: ${type}`);
            components.push({
                type,
                name: `unknown-${type}`,
                rawValue: buffer.subarray(position).toString('hex'),
                formatted: `unknown-${type}=0x${buffer.subarray(position).toString('hex')}`
            });
            position = buffer.length;
            break;
        }

        if (type <= lastType) {
            errors.push(`FlowSpec component type ${type} is not in strict increasing order`);
        }
        lastType = type;

        if (type === 1 || type === 2) {
            const parsed = parseFlowSpecPrefixComponent(buffer, position, type, afi);
            components.push(parsed.component);
            errors.push(...parsed.errors);
            position = parsed.position;
            continue;
        }

        const operations = [];
        const isBitmask = type === 9 || type === 12;
        let endOfList = false;
        while (position < buffer.length && !endOfList) {
            const operator = buffer[position];
            position += 1;

            const valueLength = getFlowSpecOperatorValueLength(operator);
            if (operations.length === 0 && (operator & 0x40) !== 0) {
                errors.push(`FlowSpec component type ${type} first operator has AND bit set`);
            }
            const lengthError = validateFlowSpecOperationLength(type, valueLength);
            if (lengthError) {
                errors.push(lengthError);
            }
            if (position + valueLength > buffer.length) {
                errors.push(`FlowSpec component type ${type} operator value is truncated`);
                position = buffer.length;
                break;
            }
            const value = readBigEndianValue(buffer, position, valueLength);
            position += valueLength;
            endOfList = (operator & 0x80) !== 0;

            operations.push({
                operator,
                operatorName: getFlowSpecOperatorName(operator, isBitmask),
                value
            });
        }

        if (!endOfList) {
            errors.push(`FlowSpec component type ${type} operator list does not contain end-of-list`);
        }

        const name = FLOW_SPEC_COMPONENT_NAMES[type] || `type-${type}`;
        components.push({
            type,
            name,
            operations,
            formatted: `${name} ${operations.map(op => `${op.operatorName} ${op.value}`).join(' ')}`
        });
    }

    return { components, errors };
}

function parseFlowSpecNlri(buffer, position, afi) {
    const { nlriLength, lengthBytes, errors: lengthErrors } = parseFlowSpecLength(buffer, position);
    position += lengthBytes;

    const errors = [...lengthErrors];
    if (lengthBytes === 0) {
        position = buffer.length;
    }

    if (nlriLength === 0) {
        errors.push('FlowSpec NLRI value must contain at least one component');
    }

    if (position + nlriLength > buffer.length) {
        errors.push('FlowSpec NLRI length exceeds remaining buffer');
    }

    const nlriEnd = Math.min(position + nlriLength, buffer.length);
    const nlriBuffer = buffer.subarray(position, nlriEnd);
    const parsedComponents = parseFlowSpecComponents(nlriBuffer, afi);
    const components = parsedComponents.components;
    errors.push(...parsedComponents.errors);
    position = nlriEnd;

    const formatted = components.length > 0 ? components.map(component => component.formatted).join('; ') : 'flowspec';
    return {
        position,
        route: {
            prefix: formatted,
            rd: null,
            length: nlriLength,
            nlriLength,
            components,
            rawNlri: nlriBuffer.toString('hex'),
            valid: errors.length === 0,
            errors
        }
    };
}

function parseMplsLabelStack(buffer, position, nlriBitLength, nlriEnd) {
    const labels = [];
    let labelBits = 0;

    while (position + 3 <= nlriEnd && nlriBitLength - labelBits >= 24) {
        const entry = (buffer[position] << 16) | (buffer[position + 1] << 8) | buffer[position + 2];
        labels.push({
            label: entry >> 4,
            exp: (entry >> 1) & 0x07,
            bottom: (entry & 0x01) === 1
        });
        position += 3;
        labelBits += 24;

        if (labels[labels.length - 1].bottom) {
            break;
        }
    }

    return {
        labels,
        labelBits,
        position
    };
}

function parseLabeledUnicastNlri(buffer, position, afi) {
    const errors = [];
    const nlriBitLength = buffer[position];
    position += 1;
    const nlriEnd = position + Math.ceil(nlriBitLength / 8);
    const valueStart = position;

    if (nlriEnd > buffer.length) {
        errors.push('Labeled Unicast NLRI length exceeds remaining buffer');
    }

    if (nlriBitLength < 24) {
        errors.push(`Labeled Unicast NLRI length is too short: ${nlriBitLength}`);
    }

    const { labels, labelBits, position: prefixPosition } = parseMplsLabelStack(
        buffer,
        position,
        nlriBitLength,
        Math.min(nlriEnd, buffer.length)
    );
    position = prefixPosition;
    if (labels.length === 0) {
        errors.push('Labeled Unicast NLRI has no MPLS label');
    } else if (!labels[labels.length - 1].bottom) {
        errors.push('Labeled Unicast label stack does not contain bottom-of-stack bit');
    }

    const prefixLength = Math.max(nlriBitLength - labelBits, 0);
    const maxPrefixLength =
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 ? BgpConst.IPV6_HOST_LEN : BgpConst.IP_HOST_LEN;
    if (prefixLength > maxPrefixLength) {
        errors.push(`Labeled Unicast prefix length ${prefixLength} exceeds AFI maximum ${maxPrefixLength}`);
    }
    const prefixBytes = Math.ceil(prefixLength / 8);
    if (position + prefixBytes > buffer.length) {
        errors.push('Labeled Unicast prefix is truncated');
    }
    const prefixBuffer = buffer.subarray(position, position + prefixBytes);
    position += prefixBytes;

    const prefix =
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6
            ? ipv6BufferToString(prefixBuffer, prefixLength)
            : ipv4BufferToString(prefixBuffer, prefixLength);

    return {
        position,
        route: {
            prefix,
            rd: null,
            length: prefixLength,
            labels,
            nlriBits: nlriBitLength,
            rawNlri: buffer.subarray(valueStart, Math.min(nlriEnd, buffer.length)).toString('hex'),
            valid: errors.length === 0,
            errors
        }
    };
}

function parseLabeledUnicastWithdrawalNlri(buffer, position, afi) {
    const errors = [];
    const nlriBitLength = buffer[position];
    position += 1;
    const nlriEnd = position + Math.ceil(nlriBitLength / 8);
    const valueStart = position;

    if (nlriEnd > buffer.length) {
        errors.push('Labeled Unicast withdrawal NLRI length exceeds remaining buffer');
    }

    if (nlriBitLength < 24) {
        errors.push(`Labeled Unicast withdrawal NLRI length is too short: ${nlriBitLength}`);
    }

    const compatibilityField = buffer.subarray(position, Math.min(position + 3, buffer.length)).toString('hex');
    if (position + 3 > buffer.length) {
        errors.push('Labeled Unicast withdrawal compatibility field is truncated');
        position = buffer.length;
    } else {
        position += 3;
    }

    const prefixLength = Math.max(nlriBitLength - 24, 0);
    const maxPrefixLength =
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 ? BgpConst.IPV6_HOST_LEN : BgpConst.IP_HOST_LEN;
    if (prefixLength > maxPrefixLength) {
        errors.push(`Labeled Unicast withdrawal prefix length ${prefixLength} exceeds AFI maximum ${maxPrefixLength}`);
    }

    const prefixBytes = Math.ceil(prefixLength / 8);
    if (position + prefixBytes > buffer.length) {
        errors.push('Labeled Unicast withdrawal prefix is truncated');
    }
    const prefixBuffer = buffer.subarray(position, position + prefixBytes);
    position += prefixBytes;

    const prefix =
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6
            ? ipv6BufferToString(prefixBuffer, prefixLength)
            : ipv4BufferToString(prefixBuffer, prefixLength);

    return {
        position: Math.min(position, buffer.length),
        route: {
            prefix,
            rd: null,
            length: prefixLength,
            compatibilityField,
            nlriBits: nlriBitLength,
            rawNlri: buffer.subarray(valueStart, Math.min(nlriEnd, buffer.length)).toString('hex'),
            valid: errors.length === 0,
            errors
        }
    };
}

const BGP_LS_NLRI_TYPE_NAMES = {
    1: 'Node',
    2: 'Link',
    3: 'IPv4 Prefix',
    4: 'IPv6 Prefix'
};

const BGP_LS_PROTOCOL_NAMES = {
    1: 'IS-IS L1',
    2: 'IS-IS L2',
    3: 'OSPFv2',
    4: 'Direct',
    5: 'Static',
    6: 'OSPFv3'
};

const BGP_LS_TLV_NAMES = {
    256: 'Local Node Descriptors',
    257: 'Remote Node Descriptors',
    258: 'Link Local/Remote IDs',
    259: 'IPv4 Interface Address',
    260: 'IPv4 Neighbor Address',
    261: 'IPv6 Interface Address',
    262: 'IPv6 Neighbor Address',
    263: 'Multi-Topology ID',
    264: 'OSPF Route Type',
    265: 'IP Reachability',
    512: 'Autonomous System',
    513: 'BGP-LS Identifier',
    514: 'OSPF Area ID',
    515: 'IGP Router ID'
};

function parseBgpLsIpReachability(buffer, nlriType) {
    const errors = [];
    if (buffer.length < 1) {
        return {
            prefix: '',
            length: 0,
            formatted: 'truncated',
            errors: ['BGP-LS IP Reachability TLV is truncated']
        };
    }

    const prefixLength = buffer[0];
    const prefixBytes = Math.ceil(prefixLength / 8);
    const maxPrefixLength = nlriType === 4 ? BgpConst.IPV6_HOST_LEN : BgpConst.IP_HOST_LEN;
    if (prefixLength > maxPrefixLength) {
        errors.push(`BGP-LS IP Reachability prefix length ${prefixLength} exceeds ${maxPrefixLength}`);
    }
    if (1 + prefixBytes > buffer.length) {
        errors.push('BGP-LS IP Reachability prefix is truncated');
    }
    const prefixBuffer = buffer.subarray(1, 1 + prefixBytes);
    const isIpv6Prefix = nlriType === 4;
    const prefix = isIpv6Prefix
        ? ipv6BufferToString(prefixBuffer, prefixLength)
        : ipv4BufferToString(prefixBuffer, prefixLength);

    return {
        prefix,
        length: prefixLength,
        formatted: `${prefix}/${prefixLength}`,
        errors
    };
}

function formatBgpLsTlvValue(type, valueBuffer, nlriType) {
    if (type === 512 && valueBuffer.length >= 4) {
        return valueBuffer.readUInt32BE(0).toString();
    }

    if (type === 513 && valueBuffer.length >= 4) {
        return valueBuffer.readUInt32BE(0).toString();
    }

    if (type === 514 && valueBuffer.length >= 4) {
        return ipv4BufferToString(valueBuffer.subarray(0, 4), BgpConst.IP_HOST_LEN);
    }

    if (type === 515) {
        if (valueBuffer.length === 4) {
            return ipv4BufferToString(valueBuffer, BgpConst.IP_HOST_LEN);
        }
        return valueBuffer.toString('hex');
    }

    if (type === 258 && valueBuffer.length >= 8) {
        return `${valueBuffer.readUInt32BE(0)}->${valueBuffer.readUInt32BE(4)}`;
    }

    if ((type === 259 || type === 260) && valueBuffer.length >= 4) {
        return ipv4BufferToString(valueBuffer.subarray(0, 4), BgpConst.IP_HOST_LEN);
    }

    if ((type === 261 || type === 262) && valueBuffer.length >= 16) {
        return ipv6BufferToString(valueBuffer.subarray(0, 16), BgpConst.IPV6_HOST_LEN);
    }

    if (type === 263 && valueBuffer.length >= 2) {
        return (valueBuffer.readUInt16BE(0) & 0x0fff).toString();
    }

    if (type === 264 && valueBuffer.length >= 1) {
        return valueBuffer[0].toString();
    }

    if (type === 265) {
        const reachability = parseBgpLsIpReachability(valueBuffer, nlriType);
        return reachability ? reachability.formatted : valueBuffer.toString('hex');
    }

    return valueBuffer.toString('hex');
}

function compareBuffers(left, right) {
    const maxLength = Math.min(left.length, right.length);
    for (let i = 0; i < maxLength; i++) {
        if (left[i] !== right[i]) {
            return left[i] - right[i];
        }
    }

    return left.length - right.length;
}

function compareBgpLsTlvOrder(previous, current) {
    if (!previous) {
        return 0;
    }

    if (previous.type !== current.type) {
        return previous.type - current.type;
    }

    if (previous.length !== current.length) {
        return previous.length - current.length;
    }

    return compareBuffers(previous.valueBuffer, current.valueBuffer);
}

function validateBgpLsTlvValue(type, valueBuffer, nlriType) {
    if (type !== 265) {
        return [];
    }

    const reachability = parseBgpLsIpReachability(valueBuffer, nlriType);
    return reachability.errors || [];
}

function parseBgpLsTlvs(buffer, nlriType, options = {}) {
    const tlvs = [];
    const errors = [];
    let position = 0;
    let previousOrder = null;
    const seenTypes = new Set();

    while (position + 4 <= buffer.length) {
        const type = buffer.readUInt16BE(position);
        position += 2;
        const length = buffer.readUInt16BE(position);
        position += 2;

        if (options.nodeDescriptor) {
            if (seenTypes.has(type)) {
                errors.push(`BGP-LS Node Descriptor sub-TLV type ${type} appears more than once`);
            }
            seenTypes.add(type);
        }

        if (position + length > buffer.length) {
            errors.push(`BGP-LS TLV type ${type} length exceeds remaining NLRI`);
        }

        const valueEnd = Math.min(position + length, buffer.length);
        const valueBuffer = buffer.subarray(position, valueEnd);
        position = valueEnd;

        const currentOrder = { type, length, valueBuffer };
        if (compareBgpLsTlvOrder(previousOrder, currentOrder) > 0) {
            errors.push(`BGP-LS TLV type ${type} is not in canonical order`);
        }
        previousOrder = currentOrder;

        errors.push(...validateBgpLsTlvValue(type, valueBuffer, nlriType));

        const childResult =
            type === 256 || type === 257 ? parseBgpLsTlvs(valueBuffer, nlriType, { nodeDescriptor: true }) : null;
        const children = childResult ? childResult.tlvs : [];
        if (childResult) {
            errors.push(...childResult.errors.map(error => `BGP-LS TLV ${type}: ${error}`));
        }
        const tlv = {
            type,
            typeName: BGP_LS_TLV_NAMES[type] || `Unknown (${type})`,
            length,
            value: formatBgpLsTlvValue(type, valueBuffer, nlriType)
        };
        if (children.length > 0) {
            tlv.children = children;
        }
        tlvs.push(tlv);
    }

    if (position !== buffer.length) {
        errors.push('BGP-LS TLV trailer is shorter than a TLV header');
    }

    return { tlvs, errors };
}

function findBgpLsTlv(tlvs, type) {
    for (const tlv of tlvs) {
        if (tlv.type === type) {
            return tlv;
        }
        if (tlv.children) {
            const childMatch = findBgpLsTlv(tlv.children, type);
            if (childMatch) {
                return childMatch;
            }
        }
    }
    return null;
}

function buildBgpLsRoutePrefix(nlriType, protocolId, identifier, tlvs, isVpn = false) {
    const namespace = isVpn ? 'bgp-ls-vpn' : 'bgp-ls';
    const typeName = BGP_LS_NLRI_TYPE_NAMES[nlriType] || `Type ${nlriType}`;
    const protocolName = BGP_LS_PROTOCOL_NAMES[protocolId] || `Protocol ${protocolId}`;
    const reachability = findBgpLsTlv(tlvs, 265);
    if (reachability) {
        return `${namespace}:${typeName}:${reachability.value}`;
    }

    const localAddress = findBgpLsTlv(tlvs, 259) || findBgpLsTlv(tlvs, 261);
    const remoteAddress = findBgpLsTlv(tlvs, 260) || findBgpLsTlv(tlvs, 262);
    if (localAddress || remoteAddress) {
        return `${namespace}:${typeName}:${localAddress ? localAddress.value : '?'}->${
            remoteAddress ? remoteAddress.value : '?'
        }`;
    }

    const localNode = findBgpLsTlv(tlvs, 256);
    const nodeSummary = localNode && localNode.children ? localNode.children.map(child => child.value).join(',') : '';
    return `${namespace}:${typeName}:${protocolName}:id=${identifier}${nodeSummary ? `:${nodeSummary}` : ''}`;
}

function parseBgpLsNlri(buffer, position, hasRd = false) {
    const errors = [];
    const warnings = [];
    if (position + 4 > buffer.length) {
        return {
            position: buffer.length,
            route: {
                prefix: 'bgp-ls:truncated',
                rd: null,
                length: 0,
                valid: false,
                errors: ['BGP-LS NLRI header is truncated'],
                warnings,
                rawNlri: buffer.subarray(position).toString('hex')
            }
        };
    }

    const nlriType = buffer.readUInt16BE(position);
    position += 2;
    const nlriLength = buffer.readUInt16BE(position);
    position += 2;

    if (position + nlriLength > buffer.length) {
        errors.push('BGP-LS Total NLRI Length exceeds remaining buffer');
    }

    const nlriEnd = Math.min(position + nlriLength, buffer.length);
    const rawNlri = buffer.subarray(position, nlriEnd);
    let rd = null;
    if (hasRd) {
        if (position + BgpConst.BGP_RD_LEN <= nlriEnd) {
            rd = rdBufferToString(buffer.subarray(position, position + BgpConst.BGP_RD_LEN));
            position += BgpConst.BGP_RD_LEN;
        } else {
            errors.push('BGP-LS VPN RD is truncated');
            position = nlriEnd;
        }
    }

    if (!BGP_LS_NLRI_TYPE_NAMES[nlriType]) {
        return {
            position: nlriEnd,
            route: {
                prefix: `${hasRd ? 'bgp-ls-vpn' : 'bgp-ls'}:type-${nlriType}:0x${rawNlri.toString('hex')}`,
                rd,
                length: nlriLength * 8,
                nlriLength,
                routeType: nlriType,
                descriptors: [],
                rawNlri: rawNlri.toString('hex'),
                vpn: hasRd,
                valid: errors.length === 0,
                errors,
                warnings
            }
        };
    }

    let protocolId = null;
    if (position < nlriEnd) {
        protocolId = buffer[position];
        position += 1;
    } else {
        errors.push('BGP-LS Protocol-ID is truncated');
    }

    let identifier = '';
    if (position + 8 <= nlriEnd) {
        identifier = `0x${buffer.subarray(position, position + 8).toString('hex')}`;
        position += 8;
    } else {
        errors.push('BGP-LS Identifier is truncated');
    }

    const parsedTlvs = parseBgpLsTlvs(buffer.subarray(position, nlriEnd), nlriType);
    const tlvs = parsedTlvs.tlvs;
    errors.push(...parsedTlvs.errors);
    const reachability = findBgpLsTlv(tlvs, 265);
    if ((nlriType === 3 || nlriType === 4) && !reachability) {
        warnings.push('BGP-LS Prefix NLRI is missing IP Reachability TLV');
    }
    const routePrefix = buildBgpLsRoutePrefix(nlriType, protocolId, identifier, tlvs, hasRd);
    const routeLength = reachability
        ? parseInt(reachability.value.split('/').pop(), 10)
        : Math.max(nlriLength - (hasRd ? BgpConst.BGP_RD_LEN : 0), 0) * 8;

    return {
        position: nlriEnd,
        route: {
            prefix: routePrefix,
            rd,
            length: routeLength,
            nlriLength,
            routeType: nlriType,
            protocolId,
            protocol: BGP_LS_PROTOCOL_NAMES[protocolId] || protocolId,
            identifier,
            descriptors: tlvs,
            rawNlri: rawNlri.toString('hex'),
            vpn: hasRd,
            valid: errors.length === 0,
            errors,
            warnings
        }
    };
}

function parseRouteDistinguisherNlri(buffer, position, afi) {
    const errors = [];
    const nlriBitLength = buffer[position];
    position += 1;
    const valueStart = position;
    const nlriEnd = position + Math.ceil(nlriBitLength / 8);
    const boundedNlriEnd = Math.min(nlriEnd, buffer.length);

    if (nlriEnd > buffer.length) {
        errors.push('VPN NLRI length exceeds remaining buffer');
    }
    if (nlriBitLength < 24 + (BgpConst.BGP_RD_LEN << 3)) {
        errors.push(`VPN NLRI length is too short: ${nlriBitLength}`);
    }

    const { labels, labelBits, position: rdPosition } = parseMplsLabelStack(
        buffer,
        position,
        nlriBitLength,
        boundedNlriEnd
    );
    position = rdPosition;
    if (labels.length === 0) {
        errors.push('VPN NLRI has no MPLS label');
    } else if (!labels[labels.length - 1].bottom) {
        errors.push('VPN label stack does not contain bottom-of-stack bit');
    }

    let rd = null;
    if (position + BgpConst.BGP_RD_LEN <= boundedNlriEnd) {
        rd = rdBufferToString(buffer.subarray(position, position + BgpConst.BGP_RD_LEN));
    } else {
        errors.push('VPN RD is truncated');
    }
    position = Math.min(position + BgpConst.BGP_RD_LEN, boundedNlriEnd);

    const prefixLength = Math.max(nlriBitLength - labelBits - (BgpConst.BGP_RD_LEN << 3), 0);
    const maxPrefixLength =
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 ? BgpConst.IPV6_HOST_LEN : BgpConst.IP_HOST_LEN;
    if (prefixLength > maxPrefixLength) {
        errors.push(`VPN prefix length ${prefixLength} exceeds AFI maximum ${maxPrefixLength}`);
    }
    const prefixBytes = Math.ceil(prefixLength / 8);
    if (position + prefixBytes > boundedNlriEnd) {
        errors.push('VPN prefix is truncated');
    }
    const prefixBuffer = buffer.subarray(position, Math.min(position + prefixBytes, boundedNlriEnd));
    position = Math.min(position + prefixBytes, boundedNlriEnd);

    const prefix =
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6
            ? ipv6BufferToString(prefixBuffer, prefixLength)
            : ipv4BufferToString(prefixBuffer, prefixLength);

    return {
        position,
        route: {
            prefix,
            rd,
            length: prefixLength,
            labels,
            nlriBits: nlriBitLength,
            rawNlri: buffer.subarray(valueStart, boundedNlriEnd).toString('hex'),
            valid: errors.length === 0,
            errors
        }
    };
}

const EVPN_ROUTE_TYPE_NAMES = {
    1: 'Ethernet A-D',
    2: 'MAC/IP Advertisement',
    3: 'Inclusive Multicast Ethernet Tag',
    4: 'Ethernet Segment',
    5: 'IP Prefix',
    6: 'Selective Multicast Ethernet Tag',
    7: 'Multicast Membership Report Synch',
    8: 'Multicast Leave Synch',
    9: 'Per-Region I-PMSI A-D',
    10: 'S-PMSI A-D',
    11: 'Leaf A-D'
};

const BGP_TUNNEL_TYPE = {
    MPLS_IN_IP_WITH_IPSEC: 6,
    VXLAN: 8,
    NVGRE: 9,
    MPLS: 10,
    MPLS_IN_GRE: 11,
    VXLAN_GPE: 12,
    MPLS_IN_UDP: 13,
    GENEVE: 19
};

const BGP_TUNNEL_TYPE_NAMES = {
    0: 'Reserved',
    1: 'L2TPv3 over IP',
    2: 'GRE',
    3: 'Transmit tunnel endpoint',
    4: 'IPsec in Tunnel-mode',
    5: 'IP in IP tunnel with IPsec Transport Mode',
    [BGP_TUNNEL_TYPE.MPLS_IN_IP_WITH_IPSEC]: 'MPLS-in-IP tunnel with IPsec Transport Mode',
    7: 'IP in IP',
    [BGP_TUNNEL_TYPE.VXLAN]: 'VXLAN',
    [BGP_TUNNEL_TYPE.NVGRE]: 'NVGRE',
    [BGP_TUNNEL_TYPE.MPLS]: 'MPLS',
    [BGP_TUNNEL_TYPE.MPLS_IN_GRE]: 'MPLS in GRE',
    [BGP_TUNNEL_TYPE.VXLAN_GPE]: 'VXLAN GPE',
    [BGP_TUNNEL_TYPE.MPLS_IN_UDP]: 'MPLS in UDP',
    14: 'IPv6 Tunnel',
    15: 'SR Policy',
    16: 'Bare',
    17: 'SR Tunnel',
    18: 'Cloud Security',
    [BGP_TUNNEL_TYPE.GENEVE]: 'Geneve',
    20: 'Any-Encapsulation',
    21: 'GTP',
    22: 'Dynamic Path Selection',
    23: 'Originating PE',
    24: 'Dynamic Path Selection Policy',
    25: 'SDWAN-Hybrid',
    26: 'X-over-UDP',
    27: 'Distributed Etherlink Switch',
    28: 'ESP-Protected-Payload'
};

const EVPN_VNI_TUNNEL_TYPES = new Set([
    BGP_TUNNEL_TYPE.VXLAN,
    BGP_TUNNEL_TYPE.NVGRE,
    BGP_TUNNEL_TYPE.VXLAN_GPE,
    BGP_TUNNEL_TYPE.GENEVE
]);

const EVPN_MPLS_TUNNEL_TYPES = new Set([
    BGP_TUNNEL_TYPE.MPLS_IN_IP_WITH_IPSEC,
    BGP_TUNNEL_TYPE.MPLS,
    BGP_TUNNEL_TYPE.MPLS_IN_GRE,
    BGP_TUNNEL_TYPE.MPLS_IN_UDP
]);

const PMSI_TUNNEL_TYPE_NAMES = {
    0: 'No tunnel information',
    1: 'RSVP-TE P2MP LSP',
    2: 'mLDP P2MP LSP',
    3: 'PIM-SSM Tree',
    4: 'PIM-SM Tree',
    5: 'BIDIR-PIM Tree',
    6: 'Ingress Replication',
    7: 'mLDP MP2MP LSP'
};

const EXT_COMMUNITY_TYPE_TRANSITIVE_OPAQUE = 0x03;
const EXT_COMMUNITY_TYPE_NON_TRANSITIVE_OPAQUE = 0x43;
const EXT_COMMUNITY_SUB_TYPE_ENCAPSULATION = 0x0c;

const BGP_PREFIX_SID_TLV_TYPE_NAMES = {
    0: 'Reserved',
    1: 'Label-Index',
    2: 'Deprecated',
    3: 'Originator SRGB',
    4: 'SRv6-VPN SID (Deprecated)',
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
    0: 'Reserved',
    1: 'End',
    2: 'End with PSP',
    3: 'End with USP',
    4: 'End with PSP & USP',
    5: 'End.X',
    6: 'End.X with PSP',
    7: 'End.X with USP',
    8: 'End.X with PSP & USP',
    9: 'End.T',
    10: 'End.T with PSP',
    11: 'End.T with USP',
    12: 'End.T with PSP & USP',
    13: 'End.B6.Insert',
    14: 'End.B6.Encaps',
    15: 'End.BM',
    16: 'End.DX6',
    17: 'End.DX4',
    18: 'End.DT6',
    19: 'End.DT4',
    20: 'End.DT46',
    21: 'End.DX2',
    22: 'End.DX2V',
    23: 'End.DT2U',
    24: 'End.DT2M',
    25: 'Reserved',
    26: 'End.B6.Insert.Red',
    27: 'End.B6.Encaps.Red',
    28: 'End with USD',
    29: 'End with PSP & USD',
    30: 'End with USP & USD',
    31: 'End with PSP, USP & USD',
    32: 'End.X with USD',
    33: 'End.X with PSP & USD',
    34: 'End.X with USP & USD',
    35: 'End.X with PSP, USP & USD',
    36: 'End.T with USD',
    37: 'End.T with PSP & USD',
    38: 'End.T with USP & USD',
    39: 'End.T with PSP, USP & USD',
    40: 'End.MAP',
    41: 'End.Limit',
    42: 'End with NEXT-ONLY-CSID',
    43: 'End with NEXT-CSID',
    44: 'End with NEXT-CSID & PSP',
    45: 'End with NEXT-CSID & USP',
    46: 'End with NEXT-CSID, PSP & USP',
    47: 'End with NEXT-CSID & USD',
    48: 'End with NEXT-CSID, PSP & USD',
    49: 'End with NEXT-CSID, USP & USD',
    50: 'End with NEXT-CSID, PSP, USP & USD',
    51: 'End.X with NEXT-ONLY-CSID',
    52: 'End.X with NEXT-CSID',
    53: 'End.X with NEXT-CSID & PSP',
    54: 'End.X with NEXT-CSID & USP',
    55: 'End.X with NEXT-CSID, PSP & USP',
    56: 'End.X with NEXT-CSID & USD',
    57: 'End.X with NEXT-CSID, PSP & USD',
    58: 'End.X with NEXT-CSID, USP & USD',
    59: 'End.X with NEXT-CSID, PSP, USP & USD',
    60: 'uDX6 (End.DX6 with NEXT-CSID)',
    61: 'uDX4 (End.DX4 with NEXT-CSID)',
    62: 'uDT6 (End.DT6 with NEXT-CSID)',
    63: 'uDT4 (End.DT4 with NEXT-CSID)',
    64: 'uDT46 (End.DT46 with NEXT-CSID)',
    65: 'uDX2 (End.DX2 with NEXT-CSID)',
    66: 'uDX2V (End.DX2V with NEXT-CSID)',
    67: 'uDT2U (End.DT2U with NEXT-CSID)',
    68: 'uDT2M (End.DT2M with NEXT-CSID)',
    69: 'End.M.GTP6.D',
    70: 'End.M.GTP6.Di',
    71: 'End.M.GTP6.E',
    72: 'End.M.GTP4.E',
    73: 'End.DTM',
    74: 'End.M (Mirror SID)',
    75: 'End.Replicate',
    76: 'End.DTMC4',
    77: 'End.DTMC6',
    78: 'End.DTMC46',
    79: 'End.BXC',
    80: 'End.BXC with PSP',
    81: 'End.BXC with USP',
    82: 'End.BXC with USD',
    83: 'End.BXC with PSP, USP & USD',
    84: 'End.NSH - NSH Segment',
    85: 'End.T with NEXT-CSID',
    86: 'End.T with NEXT-CSID & PSP',
    87: 'End.T with NEXT-CSID & USP',
    88: 'End.T with NEXT-CSID, PSP & USP',
    89: 'End.T with NEXT-CSID & USD',
    90: 'End.T with NEXT-CSID, PSP & USD',
    91: 'End.T with NEXT-CSID, USP & USD',
    92: 'End.T with NEXT-CSID, PSP, USP & USD',
    93: 'End.B6.Encaps with NEXT-CSID',
    94: 'End.B6.Encaps.Red with NEXT-CSID',
    95: 'End.BM with NEXT-CSID',
    96: 'End.LBS with NEXT-CSID',
    97: 'End.XLBS with NEXT-CSID',
    98: 'End.B6.Encaps.Red with NEXT-CSID, PSP & USD',
    99: 'End.B6.Insert.Red with NEXT-CSID, PSP & USD',
    100: 'End.PSID',
    101: 'End with REPLACE-CSID',
    102: 'End with REPLACE-CSID & PSP',
    103: 'End with REPLACE-CSID & USP',
    104: 'End with REPLACE-CSID, PSP & USP',
    105: 'End.X with REPLACE-CSID',
    106: 'End.X with REPLACE-CSID & PSP',
    107: 'End.X with REPLACE-CSID & USP',
    108: 'End.X with REPLACE-CSID, PSP & USP',
    109: 'End.T with REPLACE-CSID',
    110: 'End.T with REPLACE-CSID & PSP',
    111: 'End.T with REPLACE-CSID & USP',
    112: 'End.T with REPLACE-CSID, PSP & USP',
    114: 'End.B6.Encaps with REPLACE-CSID',
    115: 'End.BM with REPLACE-CSID',
    116: 'End.DX6 with REPLACE-CSID',
    117: 'End.DX4 with REPLACE-CSID',
    118: 'End.DT6 with REPLACE-CSID',
    119: 'End.DT4 with REPLACE-CSID',
    120: 'End.DT46 with REPLACE-CSID',
    121: 'End.DX2 with REPLACE-CSID',
    122: 'End.DX2V with REPLACE-CSID',
    123: 'End.DT2U with REPLACE-CSID',
    124: 'End.DT2M with REPLACE-CSID',
    127: 'End.B6.Encaps.Red with REPLACE-CSID',
    128: 'End with REPLACE-CSID & USD',
    129: 'End with REPLACE-CSID, PSP & USD',
    130: 'End with REPLACE-CSID, USP & USD',
    131: 'End with REPLACE-CSID, PSP, USP & USD',
    132: 'End.X with REPLACE-CSID & USD',
    133: 'End.X with REPLACE-CSID, PSP & USD',
    134: 'End.X with REPLACE-CSID, USP & USD',
    135: 'End.X with REPLACE-CSID, PSP, USP & USD',
    136: 'End.T with REPLACE-CSID & USD',
    137: 'End.T with REPLACE-CSID, PSP & USD',
    138: 'End.T with REPLACE-CSID, USP & USD',
    139: 'End.T with REPLACE-CSID, PSP, USP & USD',
    140: 'End.LBS with REPLACE-CSID',
    141: 'End.XLBS with REPLACE-CSID',
    142: 'End.DTM46',
    143: 'End.DXM4',
    144: 'End.DXM6',
    145: 'End.DXM2',
    150: 'End.XU',
    151: 'End.XU with PSP',
    152: 'End.XU with USP',
    153: 'End.XU with USD',
    154: 'End.XU with PSP, USP & USD',
    155: 'End.XU with REPPLACE-CSID',
    156: 'End.XU with REPPLACE-CSID & PSP',
    157: 'End.XU with REPPLACE-CSID & PSP & USP & USD',
    158: 'End.DX1',
    159: 'End.DX1 with NEXT-CSID',
    160: 'End.DX1 with REPLACE-CSID',
    161: 'End.AN - SR-aware function',
    162: 'End.AS - Static proxy',
    163: 'End.AD - Dynamic proxy',
    164: 'End.AM - Masquerading proxy',
    165: 'End.AM - Masquerading proxy with NAT',
    166: 'End.AM - Masquerading proxy with Caching',
    167: 'End.AM - Masquerading proxy with NAT & Caching',
    168: 'End.M.GTP6.E.Red',
    169: 'End.AN.CI.S',
    170: 'End.AN.CI.D.A',
    171: 'End.AN.CI.D.T',
    172: 'End.AN.CI.D.V',
    173: 'End.AN.CI.D.D',
    180: 'End.AS with REPLACE-CSID',
    181: 'End.AS with NEXT-CSID',
    182: 'End.AD with REPLACE-CSID',
    183: 'End.AD with NEXT-CSID',
    184: 'End.AM with REPLACE-CSID',
    185: 'End.AM with NEXT-CSID',
    186: 'End.AMN with REPLACE-CSID',
    187: 'End.AMN with NEXT-CSID',
    32767: 'The SID defined in [RFC8754]',
    65535: 'Opaque'
};

function getBgpTunnelTypeName(tunnelType) {
    return BGP_TUNNEL_TYPE_NAMES[tunnelType] || `Unknown (${tunnelType})`;
}

function getPmsiTunnelTypeName(tunnelType) {
    return PMSI_TUNNEL_TYPE_NAMES[tunnelType] || `Unknown (${tunnelType})`;
}

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

function getEvpnLabelTypeForTunnel(tunnelType) {
    if (EVPN_VNI_TUNNEL_TYPES.has(tunnelType)) {
        return 'vni';
    }
    if (EVPN_MPLS_TUNNEL_TYPES.has(tunnelType)) {
        return 'mpls';
    }
    return 'unknown';
}

function buildBgpTunnelEncapsulation(tunnelType, source) {
    const labelType = getEvpnLabelTypeForTunnel(tunnelType);
    return {
        source,
        tunnelType,
        tunnelTypeName: getBgpTunnelTypeName(tunnelType),
        labelType,
        isVni: labelType === 'vni',
        isMpls: labelType === 'mpls'
    };
}

function readEvpnRd(buffer, position, errors) {
    if (position + BgpConst.BGP_RD_LEN > buffer.length) {
        errors.push('EVPN RD is truncated');
        return {
            rd: null,
            position: buffer.length
        };
    }

    return {
        rd: rdBufferToString(buffer.subarray(position, position + BgpConst.BGP_RD_LEN)),
        position: position + BgpConst.BGP_RD_LEN
    };
}

function readEvpnBytes(buffer, position, length, fieldName, errors) {
    if (position + length > buffer.length) {
        errors.push(`EVPN ${fieldName} is truncated`);
    }

    const end = Math.min(position + length, buffer.length);
    return {
        value: buffer.subarray(position, end),
        position: end
    };
}

function formatColonHex(buffer) {
    return Array.from(buffer)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join(':');
}

function formatMacAddress(buffer) {
    return formatColonHex(buffer);
}

function formatEvpnLabel(label, labelType) {
    const mplsText = `MPLS ${label.mplsLabel}${label.bottom ? '(BOS)' : ''}`;
    if (labelType === 'vni') {
        return `VNI ${label.vni}`;
    }
    if (labelType === 'mpls') {
        return mplsText;
    }
    return `${mplsText}/VNI ${label.vni}`;
}

function annotateEvpnLabel(label, encapsulation) {
    if (!label) {
        return null;
    }

    const labelType = encapsulation?.labelType || 'unknown';
    return {
        ...label,
        type: labelType,
        interpretation: labelType,
        display: formatEvpnLabel(label, labelType)
    };
}

function buildEvpnLabel(raw24) {
    const mplsLabel = raw24 >> 4;
    const label = {
        label: mplsLabel,
        mplsLabel,
        vni: raw24,
        raw24,
        rawHex: raw24.toString(16).padStart(6, '0'),
        exp: (raw24 >> 1) & 0x07,
        bottom: (raw24 & 0x01) === 1
    };

    return annotateEvpnLabel(label, null);
}

function readEvpnUint32(buffer, position, fieldName, errors) {
    if (position + 4 > buffer.length) {
        errors.push(`EVPN ${fieldName} is truncated`);
        return {
            value: null,
            position: buffer.length
        };
    }

    return {
        value: buffer.readUInt32BE(position),
        position: position + 4
    };
}

function readEvpnUint8(buffer, position, fieldName, errors) {
    if (position >= buffer.length) {
        errors.push(`EVPN ${fieldName} is truncated`);
        return {
            value: null,
            position: buffer.length
        };
    }

    return {
        value: buffer[position],
        position: position + 1
    };
}

function readEvpnLabel(buffer, position, fieldName, errors) {
    if (position + 3 > buffer.length) {
        errors.push(`EVPN ${fieldName} is truncated`);
        return {
            label: null,
            position: buffer.length
        };
    }

    const entry = (buffer[position] << 16) | (buffer[position + 1] << 8) | buffer[position + 2];
    return {
        label: buildEvpnLabel(entry),
        position: position + 3
    };
}

function readEvpnIpAddressField(buffer, position, fieldName, errors) {
    const lengthResult = readEvpnUint8(buffer, position, `${fieldName} Length`, errors);
    if (lengthResult.value === null) {
        return {
            length: null,
            ip: null,
            position: lengthResult.position
        };
    }

    const ipResult = parseEvpnIpByLength(buffer, lengthResult.position, lengthResult.value, fieldName, errors);
    return {
        length: lengthResult.value,
        ip: ipResult.ip,
        position: ipResult.position
    };
}

function parseEvpnMulticastSourceGroupOrigin(buffer, position, errors) {
    const sourceResult = readEvpnIpAddressField(buffer, position, 'Multicast Source Address', errors);
    position = sourceResult.position;
    const groupResult = readEvpnIpAddressField(buffer, position, 'Multicast Group Address', errors);
    position = groupResult.position;
    const originatorResult = readEvpnIpAddressField(buffer, position, 'Originator Router Address', errors);
    position = originatorResult.position;

    return {
        position,
        fields: {
            sourceLength: sourceResult.length,
            sourceAddress: sourceResult.ip,
            groupLength: groupResult.length,
            groupAddress: groupResult.ip,
            originatorLength: originatorResult.length,
            originatorRouterIp: originatorResult.ip
        }
    };
}

function addEvpnTrailingByteError(buffer, position, routeName, errors) {
    if (position !== buffer.length) {
        errors.push(`EVPN ${routeName} route has trailing bytes`);
    }
}

function parseEvpnIpByLength(buffer, position, bitLength, fieldName, errors) {
    if (bitLength === 0) {
        return {
            ip: null,
            position
        };
    }

    if (bitLength === BgpConst.IP_HOST_LEN) {
        const parsed = readEvpnBytes(buffer, position, BgpConst.IP_HOST_BYTE_LEN, fieldName, errors);
        return {
            ip: ipv4BufferToString(parsed.value, BgpConst.IP_HOST_LEN),
            position: parsed.position
        };
    }

    if (bitLength === BgpConst.IPV6_HOST_LEN) {
        const parsed = readEvpnBytes(buffer, position, BgpConst.IPV6_HOST_BYTE_LEN, fieldName, errors);
        return {
            ip: ipv6BufferToString(parsed.value, BgpConst.IPV6_HOST_LEN),
            position: parsed.position
        };
    }

    errors.push(`EVPN ${fieldName} length is unsupported: ${bitLength}`);
    const byteLength = Math.ceil(bitLength / 8);
    const parsed = readEvpnBytes(buffer, position, byteLength, fieldName, errors);
    return {
        ip: `0x${parsed.value.toString('hex')}`,
        position: parsed.position
    };
}

function parseEvpnIpPrefix(buffer, position, prefixLength, isIpv6, fieldName, errors) {
    const byteLength = isIpv6 ? BgpConst.IPV6_HOST_BYTE_LEN : BgpConst.IP_HOST_BYTE_LEN;
    const maxLength = isIpv6 ? BgpConst.IPV6_HOST_LEN : BgpConst.IP_HOST_LEN;

    if (prefixLength > maxLength) {
        errors.push(`EVPN ${fieldName} length ${prefixLength} exceeds ${maxLength}`);
    }

    const parsed = readEvpnBytes(buffer, position, byteLength, fieldName, errors);
    return {
        prefix: isIpv6
            ? ipv6BufferToString(parsed.value, prefixLength)
            : ipv4BufferToString(parsed.value, prefixLength),
        position: parsed.position
    };
}

function buildEvpnRoute(routeType, routeLength, routeValue, parsed) {
    return {
        prefix: parsed.prefix,
        rd: parsed.rd || null,
        length: parsed.length,
        nlriLength: routeLength,
        routeType,
        routeTypeName: EVPN_ROUTE_TYPE_NAMES[routeType] || `Unknown (${routeType})`,
        rawNlri: routeValue.toString('hex'),
        valid: parsed.errors.length === 0,
        errors: parsed.errors,
        ...parsed.fields
    };
}

function parseEvpnEthernetAutoDiscoveryRoute(routeType, routeLength, routeValue) {
    const errors = [];
    if (routeLength !== 25) {
        errors.push(`EVPN Ethernet A-D route length must be 25 octets: ${routeLength}`);
    }

    let position = 0;
    const rdResult = readEvpnRd(routeValue, position, errors);
    position = rdResult.position;
    const esiResult = readEvpnBytes(routeValue, position, 10, 'ESI', errors);
    position = esiResult.position;
    const tagResult = readEvpnUint32(routeValue, position, 'Ethernet Tag ID', errors);
    position = tagResult.position;
    const labelResult = readEvpnLabel(routeValue, position, 'MPLS Label', errors);

    const rd = rdResult.rd;
    const esi = formatColonHex(esiResult.value);
    const ethernetTagId = tagResult.value;
    const labels = labelResult.label ? [labelResult.label] : [];
    const prefix = `evpn:ad:${rd || '?'}:esi=${esi || '?'}:tag=${ethernetTagId ?? '?'}`;

    return buildEvpnRoute(routeType, routeLength, routeValue, {
        prefix,
        rd,
        length: routeLength,
        errors,
        fields: {
            esi,
            ethernetTagId,
            labels
        }
    });
}

function parseEvpnMacIpAdvertisementRoute(routeType, routeLength, routeValue) {
    const errors = [];
    let position = 0;
    const rdResult = readEvpnRd(routeValue, position, errors);
    position = rdResult.position;
    const esiResult = readEvpnBytes(routeValue, position, 10, 'ESI', errors);
    position = esiResult.position;
    const tagResult = readEvpnUint32(routeValue, position, 'Ethernet Tag ID', errors);
    position = tagResult.position;

    const macLength = position < routeValue.length ? routeValue[position] : 0;
    position += 1;
    if (macLength !== 48) {
        errors.push(`EVPN MAC/IP Advertisement MAC length is unsupported: ${macLength}`);
    }
    const macResult = readEvpnBytes(routeValue, position, Math.ceil(macLength / 8), 'MAC Address', errors);
    position = macResult.position;

    const ipLength = position < routeValue.length ? routeValue[position] : 0;
    position += 1;
    const ipBytes = ipLength === 0 ? 0 : ipLength === BgpConst.IP_HOST_LEN ? 4 : ipLength === BgpConst.IPV6_HOST_LEN ? 16 : null;
    if (ipBytes !== null) {
        const expectedLength = 8 + 10 + 4 + 1 + 6 + 1 + ipBytes + 3;
        if (routeLength !== expectedLength && routeLength !== expectedLength + 3) {
            errors.push(`EVPN MAC/IP Advertisement route length is inconsistent: ${routeLength}`);
        }
    }
    const ipResult = parseEvpnIpByLength(routeValue, position, ipLength, 'IP Address', errors);
    position = ipResult.position;

    const labelResult = readEvpnLabel(routeValue, position, 'MPLS Label 1', errors);
    position = labelResult.position;
    const labels = labelResult.label ? [labelResult.label] : [];
    if (position + 3 <= routeValue.length) {
        const label2Result = readEvpnLabel(routeValue, position, 'MPLS Label 2', errors);
        position = label2Result.position;
        if (label2Result.label) {
            labels.push(label2Result.label);
        }
    }
    if (position !== routeValue.length) {
        errors.push('EVPN MAC/IP Advertisement route has trailing bytes');
    }

    const rd = rdResult.rd;
    const esi = formatColonHex(esiResult.value);
    const ethernetTagId = tagResult.value;
    const macAddress = formatMacAddress(macResult.value);
    const ipText = ipResult.ip ? `:ip=${ipResult.ip}` : '';
    const prefix = `evpn:mac-ip:${rd || '?'}:tag=${ethernetTagId ?? '?'}:mac=${macAddress || '?'}${ipText}`;

    return buildEvpnRoute(routeType, routeLength, routeValue, {
        prefix,
        rd,
        length: routeLength,
        errors,
        fields: {
            esi,
            ethernetTagId,
            macLength,
            macAddress,
            ipLength,
            ipAddress: ipResult.ip,
            labels
        }
    });
}

function parseEvpnInclusiveMulticastRoute(routeType, routeLength, routeValue) {
    const errors = [];
    let position = 0;
    const rdResult = readEvpnRd(routeValue, position, errors);
    position = rdResult.position;
    const tagResult = readEvpnUint32(routeValue, position, 'Ethernet Tag ID', errors);
    position = tagResult.position;
    const ipLength = position < routeValue.length ? routeValue[position] : 0;
    position += 1;
    if (ipLength === BgpConst.IP_HOST_LEN && routeLength !== 17) {
        errors.push(`EVPN Inclusive Multicast IPv4 route length must be 17 octets: ${routeLength}`);
    }
    if (ipLength === BgpConst.IPV6_HOST_LEN && routeLength !== 29) {
        errors.push(`EVPN Inclusive Multicast IPv6 route length must be 29 octets: ${routeLength}`);
    }
    const originResult = parseEvpnIpByLength(routeValue, position, ipLength, 'Originating Router IP', errors);
    position = originResult.position;
    if (position !== routeValue.length) {
        errors.push('EVPN Inclusive Multicast route has trailing bytes');
    }

    const rd = rdResult.rd;
    const ethernetTagId = tagResult.value;
    const prefix = `evpn:imet:${rd || '?'}:tag=${ethernetTagId ?? '?'}:origin=${originResult.ip || '?'}`;

    return buildEvpnRoute(routeType, routeLength, routeValue, {
        prefix,
        rd,
        length: routeLength,
        errors,
        fields: {
            ethernetTagId,
            ipLength,
            originatingRouterIp: originResult.ip
        }
    });
}

function parseEvpnEthernetSegmentRoute(routeType, routeLength, routeValue) {
    const errors = [];
    let position = 0;
    const rdResult = readEvpnRd(routeValue, position, errors);
    position = rdResult.position;
    const esiResult = readEvpnBytes(routeValue, position, 10, 'ESI', errors);
    position = esiResult.position;
    const ipLength = position < routeValue.length ? routeValue[position] : 0;
    position += 1;
    if (ipLength === BgpConst.IP_HOST_LEN && routeLength !== 23) {
        errors.push(`EVPN Ethernet Segment IPv4 route length must be 23 octets: ${routeLength}`);
    }
    if (ipLength === BgpConst.IPV6_HOST_LEN && routeLength !== 35) {
        errors.push(`EVPN Ethernet Segment IPv6 route length must be 35 octets: ${routeLength}`);
    }
    const originResult = parseEvpnIpByLength(routeValue, position, ipLength, 'Originating Router IP', errors);
    position = originResult.position;
    if (position !== routeValue.length) {
        errors.push('EVPN Ethernet Segment route has trailing bytes');
    }

    const rd = rdResult.rd;
    const esi = formatColonHex(esiResult.value);
    const prefix = `evpn:es:${rd || '?'}:esi=${esi || '?'}:origin=${originResult.ip || '?'}`;

    return buildEvpnRoute(routeType, routeLength, routeValue, {
        prefix,
        rd,
        length: routeLength,
        errors,
        fields: {
            esi,
            ipLength,
            originatingRouterIp: originResult.ip
        }
    });
}

function parseEvpnIpPrefixRoute(routeType, routeLength, routeValue) {
    const errors = [];
    let position = 0;
    const rdResult = readEvpnRd(routeValue, position, errors);
    position = rdResult.position;
    const esiResult = readEvpnBytes(routeValue, position, 10, 'ESI', errors);
    position = esiResult.position;
    const tagResult = readEvpnUint32(routeValue, position, 'Ethernet Tag ID', errors);
    position = tagResult.position;
    const prefixLength = position < routeValue.length ? routeValue[position] : 0;
    position += 1;
    const isIpv6 = routeLength >= 58 || prefixLength > BgpConst.IP_HOST_LEN;
    if (routeLength !== 34 && routeLength !== 58) {
        errors.push(`EVPN IP Prefix route length must be 34 or 58 octets: ${routeLength}`);
    }
    const prefixResult = parseEvpnIpPrefix(routeValue, position, prefixLength, isIpv6, 'IP Prefix', errors);
    position = prefixResult.position;
    const gatewayResult = parseEvpnIpByLength(
        routeValue,
        position,
        isIpv6 ? BgpConst.IPV6_HOST_LEN : BgpConst.IP_HOST_LEN,
        'Gateway IP',
        errors
    );
    position = gatewayResult.position;
    const labelResult = readEvpnLabel(routeValue, position, 'MPLS Label', errors);
    position = labelResult.position;
    if (position !== routeValue.length) {
        errors.push('EVPN IP Prefix route has trailing bytes');
    }

    const rd = rdResult.rd;
    const esi = formatColonHex(esiResult.value);
    const ethernetTagId = tagResult.value;
    const labels = labelResult.label ? [labelResult.label] : [];
    const prefix = `evpn:ip-prefix:${rd || '?'}:tag=${ethernetTagId ?? '?'}:${prefixResult.prefix}/${prefixLength}:gw=${
        gatewayResult.ip || '?'
    }`;

    return buildEvpnRoute(routeType, routeLength, routeValue, {
        prefix,
        rd,
        length: prefixLength,
        errors,
        fields: {
            esi,
            ethernetTagId,
            ipPrefix: prefixResult.prefix,
            prefixLength,
            gatewayIp: gatewayResult.ip,
            labels
        }
    });
}

function parseEvpnSelectiveMulticastEthernetTagRoute(routeType, routeLength, routeValue) {
    const errors = [];
    let position = 0;
    const rdResult = readEvpnRd(routeValue, position, errors);
    position = rdResult.position;
    const tagResult = readEvpnUint32(routeValue, position, 'Ethernet Tag ID', errors);
    position = tagResult.position;
    const multicastResult = parseEvpnMulticastSourceGroupOrigin(routeValue, position, errors);
    position = multicastResult.position;
    const flagsResult = readEvpnUint8(routeValue, position, 'Flags', errors);
    position = flagsResult.position;
    addEvpnTrailingByteError(routeValue, position, 'Selective Multicast Ethernet Tag', errors);

    const rd = rdResult.rd;
    const ethernetTagId = tagResult.value;
    const source = multicastResult.fields.sourceAddress || '*';
    const group = multicastResult.fields.groupAddress || '?';
    const originator = multicastResult.fields.originatorRouterIp || '?';
    const prefix = `evpn:smet:${rd || '?'}:tag=${ethernetTagId ?? '?'}:source=${source}:group=${group}:origin=${originator}`;

    return buildEvpnRoute(routeType, routeLength, routeValue, {
        prefix,
        rd,
        length: routeLength,
        errors,
        fields: {
            ethernetTagId,
            ...multicastResult.fields,
            flags: flagsResult.value
        }
    });
}

function parseEvpnMulticastMembershipReportSynchRoute(routeType, routeLength, routeValue) {
    const errors = [];
    let position = 0;
    const rdResult = readEvpnRd(routeValue, position, errors);
    position = rdResult.position;
    const esiResult = readEvpnBytes(routeValue, position, 10, 'ESI', errors);
    position = esiResult.position;
    const tagResult = readEvpnUint32(routeValue, position, 'Ethernet Tag ID', errors);
    position = tagResult.position;
    const multicastResult = parseEvpnMulticastSourceGroupOrigin(routeValue, position, errors);
    position = multicastResult.position;
    const flagsResult = readEvpnUint8(routeValue, position, 'Flags', errors);
    position = flagsResult.position;
    addEvpnTrailingByteError(routeValue, position, 'Multicast Membership Report Synch', errors);

    const rd = rdResult.rd;
    const esi = formatColonHex(esiResult.value);
    const ethernetTagId = tagResult.value;
    const source = multicastResult.fields.sourceAddress || '*';
    const group = multicastResult.fields.groupAddress || '?';
    const originator = multicastResult.fields.originatorRouterIp || '?';
    const prefix = `evpn:membership-sync:${rd || '?'}:esi=${esi || '?'}:tag=${ethernetTagId ?? '?'}:source=${source}:group=${group}:origin=${originator}`;

    return buildEvpnRoute(routeType, routeLength, routeValue, {
        prefix,
        rd,
        length: routeLength,
        errors,
        fields: {
            esi,
            ethernetTagId,
            ...multicastResult.fields,
            flags: flagsResult.value
        }
    });
}

function parseEvpnMulticastLeaveSynchRoute(routeType, routeLength, routeValue) {
    const errors = [];
    let position = 0;
    const rdResult = readEvpnRd(routeValue, position, errors);
    position = rdResult.position;
    const esiResult = readEvpnBytes(routeValue, position, 10, 'ESI', errors);
    position = esiResult.position;
    const tagResult = readEvpnUint32(routeValue, position, 'Ethernet Tag ID', errors);
    position = tagResult.position;
    const multicastResult = parseEvpnMulticastSourceGroupOrigin(routeValue, position, errors);
    position = multicastResult.position;
    const reservedResult = readEvpnUint32(routeValue, position, 'Reserved', errors);
    position = reservedResult.position;
    const maximumResponseTimeResult = readEvpnUint8(routeValue, position, 'Maximum Response Time', errors);
    position = maximumResponseTimeResult.position;
    const flagsResult = readEvpnUint8(routeValue, position, 'Flags', errors);
    position = flagsResult.position;
    addEvpnTrailingByteError(routeValue, position, 'Multicast Leave Synch', errors);

    const rd = rdResult.rd;
    const esi = formatColonHex(esiResult.value);
    const ethernetTagId = tagResult.value;
    const source = multicastResult.fields.sourceAddress || '*';
    const group = multicastResult.fields.groupAddress || '?';
    const originator = multicastResult.fields.originatorRouterIp || '?';
    const prefix = `evpn:leave-sync:${rd || '?'}:esi=${esi || '?'}:tag=${ethernetTagId ?? '?'}:source=${source}:group=${group}:origin=${originator}`;

    return buildEvpnRoute(routeType, routeLength, routeValue, {
        prefix,
        rd,
        length: routeLength,
        errors,
        fields: {
            esi,
            ethernetTagId,
            ...multicastResult.fields,
            reserved: reservedResult.value,
            maximumResponseTime: maximumResponseTimeResult.value,
            flags: flagsResult.value
        }
    });
}

function parseEvpnPerRegionIPmsiAdRoute(routeType, routeLength, routeValue) {
    const errors = [];
    if (routeLength !== 20) {
        errors.push(`EVPN Per-Region I-PMSI A-D route length must be 20 octets: ${routeLength}`);
    }

    let position = 0;
    const rdResult = readEvpnRd(routeValue, position, errors);
    position = rdResult.position;
    const tagResult = readEvpnUint32(routeValue, position, 'Ethernet Tag ID', errors);
    position = tagResult.position;
    const regionResult = readEvpnBytes(routeValue, position, 8, 'Region ID', errors);
    position = regionResult.position;
    addEvpnTrailingByteError(routeValue, position, 'Per-Region I-PMSI A-D', errors);

    const rd = rdResult.rd;
    const ethernetTagId = tagResult.value;
    const regionId = formatColonHex(regionResult.value);
    const prefix = `evpn:per-region-ipmsi:${rd || '?'}:tag=${ethernetTagId ?? '?'}:region=${regionId || '?'}`;

    return buildEvpnRoute(routeType, routeLength, routeValue, {
        prefix,
        rd,
        length: routeLength,
        errors,
        fields: {
            ethernetTagId,
            regionId,
            regionIdHex: regionResult.value.toString('hex')
        }
    });
}

function parseEvpnSPmsiAdRoute(routeType, routeLength, routeValue) {
    const errors = [];
    let position = 0;
    const rdResult = readEvpnRd(routeValue, position, errors);
    position = rdResult.position;
    const tagResult = readEvpnUint32(routeValue, position, 'Ethernet Tag ID', errors);
    position = tagResult.position;
    const multicastResult = parseEvpnMulticastSourceGroupOrigin(routeValue, position, errors);
    position = multicastResult.position;
    addEvpnTrailingByteError(routeValue, position, 'S-PMSI A-D', errors);

    const rd = rdResult.rd;
    const ethernetTagId = tagResult.value;
    const source = multicastResult.fields.sourceAddress || '*';
    const group = multicastResult.fields.groupAddress || '?';
    const originator = multicastResult.fields.originatorRouterIp || '?';
    const prefix = `evpn:spmsi:${rd || '?'}:tag=${ethernetTagId ?? '?'}:source=${source}:group=${group}:origin=${originator}`;

    return buildEvpnRoute(routeType, routeLength, routeValue, {
        prefix,
        rd,
        length: routeLength,
        errors,
        fields: {
            ethernetTagId,
            ...multicastResult.fields
        }
    });
}

function findEvpnLeafAdOriginator(routeValue) {
    const candidates = [
        { bitLength: BgpConst.IP_HOST_LEN, byteLength: BgpConst.IP_HOST_BYTE_LEN },
        { bitLength: BgpConst.IPV6_HOST_LEN, byteLength: BgpConst.IPV6_HOST_BYTE_LEN }
    ]
        .map(candidate => {
            const lengthPosition = routeValue.length - candidate.byteLength - 1;
            if (lengthPosition < 0 || routeValue[lengthPosition] !== candidate.bitLength) {
                return null;
            }

            const routeKey = routeValue.subarray(0, lengthPosition);
            return {
                ...candidate,
                lengthPosition,
                routeKeyLooksLikeEvpnNlri: routeKey.length >= 2 && routeKey[1] + 2 === routeKey.length
            };
        })
        .filter(Boolean);

    if (candidates.length === 0) {
        return null;
    }

    candidates.sort((a, b) => {
        const evpnScore = Number(b.routeKeyLooksLikeEvpnNlri) - Number(a.routeKeyLooksLikeEvpnNlri);
        if (evpnScore !== 0) {
            return evpnScore;
        }
        return a.byteLength - b.byteLength;
    });

    return candidates[0];
}

function buildEvpnLeafAdRouteKeyFields(routeKey, errors) {
    const fields = {
        routeKeyHex: routeKey.toString('hex')
    };

    if (routeKey.length < 2) {
        return fields;
    }

    const routeKeyRouteType = routeKey[0];
    const routeKeyRouteLength = routeKey[1];
    fields.routeKeyRouteType = routeKeyRouteType;
    fields.routeKeyRouteTypeName = EVPN_ROUTE_TYPE_NAMES[routeKeyRouteType] || `Unknown (${routeKeyRouteType})`;
    fields.routeKeyRouteLength = routeKeyRouteLength;

    if (routeKeyRouteLength + 2 !== routeKey.length) {
        errors.push(`EVPN Leaf A-D route key length is inconsistent: ${routeKeyRouteLength}`);
        return fields;
    }

    if (routeKeyRouteType !== 11) {
        const keyRoute = parseEvpnNlri(routeKey, 0).route;
        fields.routeKeyPrefix = keyRoute.prefix;
        fields.routeKeyRoute = {
            prefix: keyRoute.prefix,
            rd: keyRoute.rd,
            routeType: keyRoute.routeType,
            routeTypeName: keyRoute.routeTypeName,
            length: keyRoute.length,
            valid: keyRoute.valid !== false,
            errors: keyRoute.errors || []
        };
    }

    return fields;
}

function parseEvpnLeafAdRoute(routeType, routeLength, routeValue) {
    const errors = [];
    const originator = findEvpnLeafAdOriginator(routeValue);
    let routeKey = routeValue;
    let originatorLength = null;
    let originatorRouterIp = null;
    let position = routeValue.length;

    if (originator) {
        routeKey = routeValue.subarray(0, originator.lengthPosition);
        originatorLength = originator.bitLength;
        const originatorResult = parseEvpnIpByLength(
            routeValue,
            originator.lengthPosition + 1,
            originator.bitLength,
            'Originator Router Address',
            errors
        );
        originatorRouterIp = originatorResult.ip;
        position = originatorResult.position;
    } else {
        errors.push('EVPN Leaf A-D originator address length is unsupported or truncated');
    }

    addEvpnTrailingByteError(routeValue, position, 'Leaf A-D', errors);
    const routeKeyFields = buildEvpnLeafAdRouteKeyFields(routeKey, errors);
    const rd = routeKeyFields.routeKeyRoute?.rd || null;
    const keyText = routeKeyFields.routeKeyPrefix || routeKeyFields.routeKeyHex || '?';
    const prefix = `evpn:leaf-ad:key=${keyText}:origin=${originatorRouterIp || '?'}`;

    return buildEvpnRoute(routeType, routeLength, routeValue, {
        prefix,
        rd,
        length: routeLength,
        errors,
        fields: {
            routeKeyLength: routeKey.length,
            ...routeKeyFields,
            originatorLength,
            originatorRouterIp
        }
    });
}

function parseEvpnNlri(buffer, position) {
    const routeType = buffer[position];
    position += 1;
    const routeLength = buffer[position];
    position += 1;
    const routeEnd = Math.min(position + routeLength, buffer.length);
    const routeValue = buffer.subarray(position, routeEnd);
    position = routeEnd;

    switch (routeType) {
        case 1:
            return {
                position,
                route: parseEvpnEthernetAutoDiscoveryRoute(routeType, routeLength, routeValue)
            };
        case 2:
            return {
                position,
                route: parseEvpnMacIpAdvertisementRoute(routeType, routeLength, routeValue)
            };
        case 3:
            return {
                position,
                route: parseEvpnInclusiveMulticastRoute(routeType, routeLength, routeValue)
            };
        case 4:
            return {
                position,
                route: parseEvpnEthernetSegmentRoute(routeType, routeLength, routeValue)
            };
        case 5:
            return {
                position,
                route: parseEvpnIpPrefixRoute(routeType, routeLength, routeValue)
            };
        case 6:
            return {
                position,
                route: parseEvpnSelectiveMulticastEthernetTagRoute(routeType, routeLength, routeValue)
            };
        case 7:
            return {
                position,
                route: parseEvpnMulticastMembershipReportSynchRoute(routeType, routeLength, routeValue)
            };
        case 8:
            return {
                position,
                route: parseEvpnMulticastLeaveSynchRoute(routeType, routeLength, routeValue)
            };
        case 9:
            return {
                position,
                route: parseEvpnPerRegionIPmsiAdRoute(routeType, routeLength, routeValue)
            };
        case 10:
            return {
                position,
                route: parseEvpnSPmsiAdRoute(routeType, routeLength, routeValue)
            };
        case 11:
            return {
                position,
                route: parseEvpnLeafAdRoute(routeType, routeLength, routeValue)
            };
    }

    return {
        position,
        route: {
            prefix: routeValue.toString('hex'),
            rd: null,
            length: routeLength,
            nlriLength: routeLength,
            routeType,
            routeTypeName: EVPN_ROUTE_TYPE_NAMES[routeType] || `Unknown (${routeType})`,
            rawNlri: routeValue.toString('hex')
        }
    };
}

function parseIpPrefixNlri(buffer, position, afi) {
    const prefixLength = buffer[position];
    position += 1;

    const prefixBytes = Math.ceil(prefixLength / 8);
    const prefixBuffer = buffer.subarray(position, position + prefixBytes);
    position += prefixBytes;

    const prefix =
        afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6
            ? ipv6BufferToString(prefixBuffer, prefixLength)
            : ipv4BufferToString(prefixBuffer, prefixLength);

    return {
        position,
        route: {
            prefix,
            rd: null,
            length: prefixLength
        }
    };
}

function parseFallbackNlri(buffer, position) {
    const routeType = buffer[position];
    position += 1;
    const routeLength = position < buffer.length ? buffer[position] : 0;
    position += 1;
    const routeValue = buffer.subarray(position, position + routeLength);
    position += routeLength;

    return {
        position,
        route: {
            prefix: routeValue.toString('hex'),
            rd: null,
            length: routeLength,
            nlriLength: routeLength,
            routeType,
            rawNlri: routeValue.toString('hex')
        }
    };
}

function parseNlriEntry(buffer, position, afi, safi, isWithdrawn = false) {
    if (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 && safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST) {
        return parseIpPrefixNlri(buffer, position, afi);
    }

    if (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 && safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST) {
        return parseIpPrefixNlri(buffer, position, afi);
    }

    if (afi === BgpConst.BGP_AFI_TYPE.AFI_L2VPN && safi === BgpConst.BGP_SAFI_TYPE.SAFI_EVPN) {
        return parseEvpnNlri(buffer, position);
    }

    if (
        (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 || afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) &&
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_VPN
    ) {
        return parseRouteDistinguisherNlri(buffer, position, afi);
    }

    if (
        (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 || afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) &&
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST
    ) {
        if (isWithdrawn) {
            return parseLabeledUnicastWithdrawalNlri(buffer, position, afi);
        }
        return parseLabeledUnicastNlri(buffer, position, afi);
    }

    if (
        (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 || afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) &&
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC
    ) {
        return parseFlowSpecNlri(buffer, position, afi);
    }

    if (
        afi === BgpConst.BGP_AFI_TYPE.AFI_BGP_LS &&
        (safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS || safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN)
    ) {
        return parseBgpLsNlri(buffer, position, safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN);
    }

    if (safi === BgpConst.BGP_SAFI_TYPE.SAFI_QP) {
        const nlriTotalLength = buffer[position];
        position += 1;
        position += 1;
        const dqpnBitLength = buffer[position];
        position += 1;
        const { dqpn, byteLength: dqpnByteLength } = parseQpDqpn(buffer, position, dqpnBitLength);
        position += dqpnByteLength;
        position += 1;
        const prefixLength = buffer[position];
        position += 1;
        const prefixBytes = Math.ceil(prefixLength / 8);
        const prefixBuffer = buffer.subarray(position, position + prefixBytes);
        position += prefixBytes;
        const prefix =
            afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4
                ? ipv4BufferToString(prefixBuffer, prefixLength)
                : ipv6BufferToString(prefixBuffer, prefixLength);

        return {
            position,
            route: {
                prefix,
                rd: null,
                length: prefixLength,
                dqpn,
                dqpnBits: dqpnBitLength,
                nlriBits: nlriTotalLength * 8
            }
        };
    }

    return parseFallbackNlri(buffer, position);
}

/**
 * Parse BGP OPEN message
 * @param {Buffer} buffer - Raw BGP packet buffer
 * @returns {Object} Parsed OPEN message data
 */
function parseOpenMessage(buffer) {
    let position = BgpConst.BGP_HEAD_LEN;
    const version = buffer[position];
    position += 1;
    const asn = buffer.readUInt16BE(position);
    position += 2;
    const holdTime = buffer.readUInt16BE(position);
    position += 2;
    const routerId = `${buffer[position]}.${buffer[position + 1]}.${buffer[position + 2]}.${buffer[position + 3]}`;
    position += 4;
    const optParamLen = buffer[position];
    position += 1;

    const result = {
        version,
        asn,
        holdTime,
        routerId,
        optParamLen,
        capabilities: []
    };

    // Parse optional parameters (capabilities)
    if (optParamLen > 0) {
        const optParamsEnd = position + optParamLen;

        while (position < optParamsEnd) {
            const paramType = buffer[position];
            const paramLen = buffer[position + 1];
            position += 2;

            // Parameter type 2 is capability
            if (paramType === BgpConst.BGP_OPEN_OPT_TYPE.OPT_TYPE) {
                let capPosition = position;
                let capPositionEnd = capPosition + paramLen;

                // Parse capability value based on capability code
                while (capPosition < capPositionEnd) {
                    const capCode = buffer[capPosition];
                    const capLen = buffer[capPosition + 1];
                    capPosition += 2;

                    const capability = {
                        code: capCode,
                        length: capLen
                    };

                    let tempPosition = capPosition;
                    switch (capCode) {
                        case BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS: // Multiprotocol Extensions
                            if (capLen >= 4) {
                                const afi = buffer.readUInt16BE(tempPosition);
                                tempPosition += 2;
                                // 1字节保留字段
                                tempPosition += 1;
                                const safi = buffer[tempPosition];
                                tempPosition += 1;
                                capability.afi = afi;
                                capability.safi = safi;
                            }
                            break;
                        case BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS: // 4-octet AS number
                            if (capLen >= 4) {
                                capability.as4 = buffer.readUInt32BE(tempPosition);
                                tempPosition += 4;
                            }
                            break;
                        case BgpConst.BGP_OPEN_CAP_CODE.BGP_ROLE: // BGP Role Capability
                            if (capLen >= 1) {
                                capability.role = buffer[tempPosition];
                                tempPosition += 1;
                            }
                            break;
                        case BgpConst.BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING: // Extended Next Hop Encoding
                            capability.nextHops = [];
                            while (tempPosition + 6 <= capPosition + capLen) {
                                const afi = buffer.readUInt16BE(tempPosition);
                                tempPosition += 2;
                                const safi = buffer.readUInt16BE(tempPosition);
                                tempPosition += 2;
                                const ipType = buffer.readUInt16BE(tempPosition);
                                tempPosition += 2;
                                capability.nextHops.push({ afi, safi, ipType });
                            }

                            if (capability.nextHops.length > 0) {
                                capability.afi = capability.nextHops[0].afi;
                                capability.safi = capability.nextHops[0].safi;
                                capability.ipType = capability.nextHops[0].ipType;
                            }
                            break;
                        case BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH: // ADD-PATH
                            capability.addPaths = [];
                            // Capability value contains one or more tuples of (AFI, SAFI, Send/Receive)
                            // Each tuple is 4 bytes: AFI(2) + SAFI(1) + Send/Receive(1)
                            while (tempPosition < capPosition + capLen) {
                                if (tempPosition + 4 <= capPosition + capLen) {
                                    const afi = buffer.readUInt16BE(tempPosition);
                                    tempPosition += 2;
                                    const safi = buffer[tempPosition];
                                    tempPosition += 1;
                                    const sendReceive = buffer[tempPosition];
                                    tempPosition += 1;
                                    capability.addPaths.push({
                                        afi,
                                        safi,
                                        sendReceive
                                    });
                                } else {
                                    break;
                                }
                            }
                            break;
                        // Other capabilities could be added here
                    }
                    result.capabilities.push(capability);
                    capPosition += capLen;
                }
                position += paramLen;
            } else {
                position += paramLen;
            }
        }
    }

    return result;
}

/**
 * Parse BGP UPDATE message
 * @param {Object} context - Context object
 * @returns {Object} Parsed UPDATE message data
 */
function parseUpdateMessage(buffer, context) {
    let position = BgpConst.BGP_HEAD_LEN;
    const withdrawnRoutesLength = buffer.readUInt16BE(position);
    position += 2;
    const withdrawnRoutes = [];

    // Check if ADD-PATH is enabled for IPv4 Unicast
    let addPathEnabled = false;
    if (context && typeof context.isAddPathReceiveEnabled === 'function') {
        addPathEnabled = context.isAddPathReceiveEnabled(
            BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        );
    }
    // Backward compatibility or if context is map
    else if (context && context.addPathMap) {
        // If context is just the object we constructed (though we pass the class instance usually)
        // Not implementing this branch since we pass the instance.
    }

    // Parse withdrawn routes
    const withdrawnRoutesEnd = position + withdrawnRoutesLength;
    while (position < withdrawnRoutesEnd) {
        let pathId = 0;
        if (addPathEnabled) {
            pathId = buffer.readUInt32BE(position);
            position += 4;
        }

        const prefixLength = buffer[position];
        position += 1;

        // Calculate bytes needed for the prefix
        const prefixBytes = Math.ceil(prefixLength / 8);

        // Extract the prefix
        const prefixBuffer = buffer.subarray(position, position + prefixBytes);
        position += prefixBytes;

        // Convert to dotted decimal format for IPv4
        const prefix = ipv4BufferToString(prefixBuffer, prefixLength);

        withdrawnRoutes.push({
            pathId,
            prefix,
            length: prefixLength
        });
    }

    // Parse path attributes
    const pathAttributesLength = buffer.readUInt16BE(position);
    position += 2;

    const pathAttributesEnd = position + pathAttributesLength;
    const { pathAttributes, nextPosition } = parsePathAttributes(buffer, position, pathAttributesEnd, context);
    position = nextPosition;
    annotateEvpnPathAttributes(pathAttributes);
    const attributeErrors = [];
    pathAttributes.forEach(attr => {
        if (attr.valid === false && Array.isArray(attr.errors)) {
            attributeErrors.push(...attr.errors.map(error => `${getBgpPathAttrTypeName(attr.typeCode)}: ${error}`));
        }
    });

    // Parse NLRI
    const nlri = [];
    while (position < buffer.length) {
        let pathId = 0;
        if (addPathEnabled) {
            pathId = buffer.readUInt32BE(position);
            position += 4;
        }

        const prefixLength = buffer[position];
        position += 1;

        // Calculate bytes needed for the prefix
        const prefixBytes = Math.ceil(prefixLength / 8);

        // Extract the prefix
        const prefixBuffer = buffer.subarray(position, position + prefixBytes);
        position += prefixBytes;

        // Convert to dotted decimal format for IPv4
        const prefix = ipv4BufferToString(prefixBuffer, prefixLength);

        nlri.push({
            pathId,
            prefix,
            length: prefixLength
        });
    }

    return {
        withdrawnRoutesLength,
        withdrawnRoutes,
        pathAttributesLength,
        pathAttributes,
        nlri,
        valid: attributeErrors.length === 0,
        error: attributeErrors.join('; '),
        errors: attributeErrors
    };
}

/**
 * Parses BGP path attributes from a buffer
 * @param {Buffer} buffer - Raw buffer
 * @param {number} startPosition - Start position in buffer
 * @param {number} endPosition - End position in buffer
 * @param {Object} context - Context object
 * @returns {Object} { attributes: Array, nextPosition: number }
 */
function parsePathAttributes(buffer, startPosition, endPosition, context) {
    let position = startPosition;
    const pathAttributes = [];
    const asnSize = (context && context.asnSize) || 4;

    while (position < endPosition) {
        if (position + 2 > buffer.length) break;
        const flags = buffer[position];
        const typeCode = buffer[position + 1];
        position += 2;

        const extendedLength = (flags & BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH) !== 0;
        let attributeLength;

        if (extendedLength) {
            if (position + 2 > buffer.length) break;
            attributeLength = buffer.readUInt16BE(position);
            position += 2;
        } else {
            if (position + 1 > buffer.length) break;
            attributeLength = buffer[position];
            position += 1;
        }

        if (position + attributeLength > buffer.length) break;
        const attributeValue = buffer.subarray(position, position + attributeLength);
        position += attributeLength;

        const attribute = {
            flags,
            typeCode,
            length: attributeLength,
            value: attributeValue
        };

        // Parse specific attribute types
        switch (typeCode) {
            case BgpConst.BGP_PATH_ATTR.ORIGIN: {
                // ORIGIN
                if (attributeValue.length >= 1) attribute.origin = getBgpOriginType(attributeValue[0]);
                break;
            }
            case BgpConst.BGP_PATH_ATTR.AS_PATH: {
                // AS_PATH
                // Heuristic to detect ASN size if not provided
                let effectiveAsnSize = asnSize;
                if (!context || !context.asnSize) {
                    // Check if total length matches 2-byte or 4-byte ASNs
                    // Very simple check: header is 2 bytes (Type, Count).
                    if (attributeValue.length >= 2) {
                        const count = attributeValue[1];
                        if (attributeValue.length === 2 + count * 2) effectiveAsnSize = 2;
                        else if (attributeValue.length === 2 + count * 4) effectiveAsnSize = 4;
                    }
                }
                attribute.segments = parseAsPath(attributeValue, effectiveAsnSize);
                break;
            }
            case BgpConst.BGP_PATH_ATTR.NEXT_HOP: {
                // NEXT_HOP
                if (attributeValue.length === 4) {
                    attribute.nextHop = `${attributeValue[0]}.${attributeValue[1]}.${attributeValue[2]}.${attributeValue[3]}`;
                }
                break;
            }
            case BgpConst.BGP_PATH_ATTR.MED: {
                // MED
                if (attributeValue.length >= 4) attribute.med = attributeValue.readUInt32BE(0);
                break;
            }
            case BgpConst.BGP_PATH_ATTR.LOCAL_PREF: {
                // LOCAL_PREF
                if (attributeValue.length >= 4) attribute.localPref = attributeValue.readUInt32BE(0);
                break;
            }
            case BgpConst.BGP_PATH_ATTR.ATOMIC_AGGREGATE: {
                // ATOMIC_AGGREGATE
                break;
            }
            case BgpConst.BGP_PATH_ATTR.AGGREGATOR: {
                // AGGREGATOR
                if (attributeValue.length >= 6) {
                    attribute.aggregatorAs = attributeValue.readUInt16BE(0);
                    attribute.aggregatorIp = `${attributeValue[2]}.${attributeValue[3]}.${attributeValue[4]}.${attributeValue[5]}`;
                }
                break;
            }
            case BgpConst.BGP_PATH_ATTR.COMMUNITY: {
                // COMMUNITY
                attribute.communities = parseCommunities(attributeValue);
                break;
            }
            case BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES: {
                // EXTENDED_COMMUNITIES
                attribute.extCommunities = parseExtCommunities(attributeValue);
                break;
            }
            case BgpConst.BGP_PATH_ATTR.PMSI_TUNNEL: {
                attribute.pmsiTunnel = parsePmsiTunnelAttribute(attributeValue);
                attribute.valid = attribute.pmsiTunnel.valid;
                attribute.errors = attribute.pmsiTunnel.errors;
                break;
            }
            case BgpConst.BGP_PATH_ATTR.TUNNEL_ENCAPSULATION: {
                attribute.tunnelEncapsulation = parseTunnelEncapsulationAttribute(attributeValue);
                attribute.valid = attribute.tunnelEncapsulation.valid;
                attribute.errors = attribute.tunnelEncapsulation.errors;
                break;
            }
            case BgpConst.BGP_PATH_ATTR.PREFIX_SID: {
                attribute.prefixSid = parseBgpPrefixSidAttribute(attributeValue);
                attribute.valid = attribute.prefixSid.valid;
                attribute.errors = attribute.prefixSid.errors;
                attribute.warnings = attribute.prefixSid.warnings;
                break;
            }
            case BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI: {
                // MP_REACH_NLRI
                attribute.mpReach = parseMpReachNlri(attributeValue, context);
                attribute.valid = attribute.mpReach.valid;
                attribute.errors = attribute.mpReach.errors;
                attribute.warnings = attribute.mpReach.warnings;
                break;
            }
            case BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI: {
                // MP_UNREACH_NLRI
                attribute.mpUnreach = parseMpUnreachNlri(attributeValue, context);
                attribute.valid = attribute.mpUnreach.valid;
                attribute.errors = attribute.mpUnreach.errors;
                attribute.warnings = attribute.mpUnreach.warnings;
                break;
            }
            case BgpConst.BGP_PATH_ATTR.PATH_OTC: {
                // OTC
                if (attributeValue.length >= 4) attribute.otc = attributeValue.readUInt32BE(0);
                break;
            }
        }

        pathAttributes.push(attribute);
    }

    return { pathAttributes, nextPosition: position };
}

/**
 * Parse BGP NOTIFICATION message
 * @param {Buffer} buffer - Raw BGP packet buffer
 * @returns {Object} Parsed NOTIFICATION message data
 */
function parseNotificationMessage(buffer) {
    let position = BgpConst.BGP_HEAD_LEN;
    const errorCode = buffer[position];
    position += 1;
    const errorSubcode = buffer[position];
    position += 1;

    const data = buffer.subarray(position);

    return {
        errorCode,
        errorSubcode,
        data
    };
}

/**
 * Parse BGP ROUTE-REFRESH message
 * @param {Buffer} buffer - Raw BGP packet buffer
 * @returns {Object} Parsed ROUTE-REFRESH message data
 */
function parseRouteRefreshMessage(buffer) {
    let position = BgpConst.BGP_HEAD_LEN;
    const afi = buffer.readUInt16BE(position);
    position += 2;
    const subType = buffer[position];
    position += 1;
    const safi = buffer[position];

    return {
        afi,
        subType,
        safi
    };
}

/**
 * Parse AS_PATH attribute
 * @param {Buffer} buffer - AS_PATH attribute value
 * @param {number} asnSize - 2 or 4 byte ASNs
 * @returns {Array} Array of AS path segments
 */
function parseAsPath(buffer, asnSize = 4) {
    const segments = [];
    let position = 0;

    while (position < buffer.length) {
        if (position + 2 > buffer.length) break;
        const segmentType = buffer[position];
        const segmentLength = buffer[position + 1];
        position += 2;

        const asNumbers = [];
        for (let i = 0; i < segmentLength; i++) {
            if (position + asnSize > buffer.length) break;
            if (asnSize === 4) {
                asNumbers.push(buffer.readUInt32BE(position));
            } else {
                asNumbers.push(buffer.readUInt16BE(position));
            }
            position += asnSize;
        }

        segments.push({
            type: segmentType,
            typeName: getBgpAsPathTypeName(segmentType),
            asNumbers
        });
    }

    return segments;
}

/**
 * Parse COMMUNITIES attribute
 * @param {Buffer} buffer - COMMUNITIES attribute value
 * @returns {Array} Array of community values
 */
function parseCommunities(buffer) {
    const communities = [];

    for (let i = 0; i < buffer.length; i += 4) {
        const value = buffer.readUInt32BE(i);
        const highOrder = (value >> 16) & 0xffff;
        const lowOrder = value & 0xffff;

        communities.push({
            value,
            formatted: `${highOrder}:${lowOrder}`
        });
    }

    return communities;
}

function parseExtCommunities(buffer) {
    const extCommunities = [];

    for (let i = 0; i < buffer.length; i += 8) {
        const subBuffer = buffer.subarray(i, i + 8);
        if (subBuffer.length !== 8) {
            extCommunities.push({
                rawHex: subBuffer.toString('hex'),
                valid: false,
                formatted: `truncated(${subBuffer.toString('hex')})`
            });
            continue;
        }

        const type = subBuffer[0];
        const subType = subBuffer[1];
        const community = {
            type,
            subType,
            rawHex: subBuffer.toString('hex'),
            valueHex: subBuffer.subarray(2).toString('hex'),
            valid: true
        };

        try {
            community.formatted = extCommunitiesBufferToString(subBuffer);
        } catch (error) {
            community.formatted = `unknown(${type}|${subType})`;
            community.error = error.message;
        }

        const isEncapsulation =
            (type === EXT_COMMUNITY_TYPE_TRANSITIVE_OPAQUE || type === EXT_COMMUNITY_TYPE_NON_TRANSITIVE_OPAQUE) &&
            subType === EXT_COMMUNITY_SUB_TYPE_ENCAPSULATION;
        if (isEncapsulation) {
            const tunnelType = subBuffer.readUInt16BE(6);
            community.encapsulation = buildBgpTunnelEncapsulation(tunnelType, 'extended-community');
            community.formatted = `Encapsulation ${community.encapsulation.tunnelTypeName} (${tunnelType})`;
        }

        extCommunities.push(community);
    }

    return extCommunities;
}

function parsePmsiTunnelAttribute(buffer) {
    const errors = [];
    if (buffer.length < 5) {
        errors.push(`PMSI Tunnel attribute is truncated: ${buffer.length} octets`);
        return {
            valid: false,
            errors,
            flags: buffer.length > 0 ? buffer[0] : null,
            tunnelType: buffer.length > 1 ? buffer[1] : null,
            tunnelTypeName: buffer.length > 1 ? getPmsiTunnelTypeName(buffer[1]) : null,
            label: null,
            labelPresent: false,
            tunnelIdentifierHex: buffer.length > 2 ? buffer.subarray(2).toString('hex') : ''
        };
    }

    const raw24 = (buffer[2] << 16) | (buffer[3] << 8) | buffer[4];
    const label = buildEvpnLabel(raw24);
    return {
        valid: true,
        errors,
        flags: buffer[0],
        tunnelType: buffer[1],
        tunnelTypeName: getPmsiTunnelTypeName(buffer[1]),
        label,
        labelPresent: raw24 !== 0,
        tunnelIdentifierHex: buffer.subarray(5).toString('hex')
    };
}

function parseTunnelEncapsulationAttribute(buffer) {
    const tlvs = [];
    const errors = [];
    let position = 0;

    while (position < buffer.length) {
        if (position + 4 > buffer.length) {
            errors.push(`Tunnel Encapsulation TLV header is truncated at offset ${position}`);
            break;
        }

        const tunnelType = buffer.readUInt16BE(position);
        position += 2;
        const length = buffer.readUInt16BE(position);
        position += 2;
        if (position + length > buffer.length) {
            errors.push(`Tunnel Encapsulation TLV ${tunnelType} length exceeds attribute: ${length}`);
            break;
        }

        const value = buffer.subarray(position, position + length);
        position += length;
        tlvs.push({
            ...buildBgpTunnelEncapsulation(tunnelType, 'tunnel-encapsulation-attribute'),
            length,
            valueHex: value.toString('hex')
        });
    }

    return {
        tlvs,
        valid: errors.length === 0,
        errors
    };
}

function readUint24BE(buffer, position) {
    return (buffer[position] << 16) | (buffer[position + 1] << 8) | buffer[position + 2];
}

function parseBgpPrefixSidLabelIndexTlv(value, errors) {
    if (value.length !== 7) {
        errors.push(`BGP Prefix-SID Label-Index TLV length must be 7 octets: ${value.length}`);
    }

    return {
        reserved: value.length >= 1 ? value[0] : null,
        flags: value.length >= 3 ? value.readUInt16BE(1) : null,
        labelIndex: value.length >= 7 ? value.readUInt32BE(3) : null
    };
}

function parseBgpPrefixSidOriginatorSrgbTlv(value, errors) {
    if (value.length < 8 || (value.length - 2) % 6 !== 0) {
        errors.push(`BGP Prefix-SID Originator SRGB TLV length must be 2 + non-zero multiple of 6 octets: ${value.length}`);
    }

    const flags = value.length >= 2 ? value.readUInt16BE(0) : null;
    const ranges = [];
    let position = 2;
    while (position + 6 <= value.length) {
        const start = readUint24BE(value, position);
        const range = readUint24BE(value, position + 3);
        ranges.push({
            start,
            range,
            end: range > 0 ? start + range - 1 : start
        });
        position += 6;
    }

    return {
        flags,
        ranges
    };
}

function parseSrv6ServiceDataSubSubTlvs(buffer, errors) {
    const subSubTlvs = [];
    let position = 0;

    while (position < buffer.length) {
        if (position + 3 > buffer.length) {
            errors.push(`SRv6 Service Data Sub-Sub-TLV header is truncated at offset ${position}`);
            break;
        }

        const type = buffer[position];
        const length = buffer.readUInt16BE(position + 1);
        const valueStart = position + 3;
        const valueEnd = valueStart + length;
        if (valueEnd > buffer.length) {
            errors.push(`SRv6 Service Data Sub-Sub-TLV ${type} length exceeds parent: ${length}`);
            break;
        }

        const value = buffer.subarray(valueStart, valueEnd);
        const subSubTlv = {
            type,
            typeName: getSrv6ServiceDataSubSubTlvTypeName(type),
            length,
            rawValue: value.toString('hex')
        };

        if (type === 1) {
            if (length !== 6) {
                errors.push(`SRv6 SID Structure Sub-Sub-TLV length must be 6 octets: ${length}`);
            }
            subSubTlv.sidStructure = {
                locatorBlockLength: value.length >= 1 ? value[0] : null,
                locatorNodeLength: value.length >= 2 ? value[1] : null,
                functionLength: value.length >= 3 ? value[2] : null,
                argumentLength: value.length >= 4 ? value[3] : null,
                transpositionLength: value.length >= 5 ? value[4] : null,
                transpositionOffset: value.length >= 6 ? value[5] : null
            };
        }

        subSubTlvs.push(subSubTlv);
        position = valueEnd;
    }

    return subSubTlvs;
}

function parseSrv6SidInformationSubTlv(value, errors) {
    if (value.length < 21) {
        errors.push(`SRv6 SID Information Sub-TLV length must be at least 21 octets: ${value.length}`);
    }

    const sidBuffer = value.length >= 17 ? value.subarray(1, 17) : Buffer.alloc(0);
    const flags = value.length >= 18 ? value[17] : null;
    const endpointBehavior = value.length >= 20 ? value.readUInt16BE(18) : null;
    const reserved2 = value.length >= 21 ? value[20] : null;
    const subSubTlvBuffer = value.length > 21 ? value.subarray(21) : Buffer.alloc(0);
    const subSubTlvs = parseSrv6ServiceDataSubSubTlvs(subSubTlvBuffer, errors);
    const sidStructureSubSubTlv = subSubTlvs.find(subSubTlv => subSubTlv.type === 1 && subSubTlv.sidStructure);

    return {
        reserved: value.length >= 1 ? value[0] : null,
        sid: sidBuffer.length === BgpConst.IPV6_HOST_BYTE_LEN ? ipv6BufferToString(sidBuffer, BgpConst.IPV6_HOST_LEN) : null,
        sidHex: sidBuffer.toString('hex'),
        endpointBehavior,
        endpointBehaviorName: endpointBehavior !== null ? getSrv6EndpointBehaviorName(endpointBehavior) : null,
        reserved2,
        flags,
        subSubTlvs,
        sidStructure: sidStructureSubSubTlv?.sidStructure || null
    };
}

function parseSrv6ServiceSubTlvs(buffer, errors) {
    const subTlvs = [];
    const sidInfos = [];
    let position = 0;

    while (position < buffer.length) {
        if (position + 3 > buffer.length) {
            errors.push(`SRv6 Service Sub-TLV header is truncated at offset ${position}`);
            break;
        }

        const type = buffer[position];
        const length = buffer.readUInt16BE(position + 1);
        const valueStart = position + 3;
        const valueEnd = valueStart + length;
        if (valueEnd > buffer.length) {
            errors.push(`SRv6 Service Sub-TLV ${type} length exceeds service TLV: ${length}`);
            break;
        }

        const value = buffer.subarray(valueStart, valueEnd);
        const subTlv = {
            type,
            typeName: getSrv6ServiceSubTlvTypeName(type),
            length,
            rawValue: value.toString('hex')
        };

        if (type === 1) {
            subTlv.sidInformation = parseSrv6SidInformationSubTlv(value, errors);
            sidInfos.push(subTlv.sidInformation);
        }

        subTlvs.push(subTlv);
        position = valueEnd;
    }

    return {
        subTlvs,
        sidInfos
    };
}

function parseBgpPrefixSidSrv6ServiceTlv(type, value, errors) {
    if (value.length < 1) {
        errors.push(`BGP Prefix-SID ${getBgpPrefixSidTlvTypeName(type)} TLV is truncated`);
    }

    const serviceTlv = {
        serviceType: type === 5 ? 'l3' : type === 6 ? 'l2' : type === 4 ? 'vpn' : 'transport',
        reserved: value.length >= 1 ? value[0] : null,
        subTlvs: [],
        sidInfos: []
    };

    const parsedSubTlvs = parseSrv6ServiceSubTlvs(value.length > 1 ? value.subarray(1) : Buffer.alloc(0), errors);
    serviceTlv.subTlvs = parsedSubTlvs.subTlvs;
    serviceTlv.sidInfos = parsedSubTlvs.sidInfos;
    return serviceTlv;
}

function formatBgpPrefixSid(prefixSid) {
    if (!prefixSid || !Array.isArray(prefixSid.tlvs)) {
        return '';
    }

    const parts = [];
    if (prefixSid.labelIndex?.labelIndex !== null && prefixSid.labelIndex?.labelIndex !== undefined) {
        parts.push(`Label-Index ${prefixSid.labelIndex.labelIndex}`);
    }
    if (prefixSid.originatorSrgb?.ranges?.length > 0) {
        const ranges = prefixSid.originatorSrgb.ranges.map(range => `${range.start}+${range.range}`).join(',');
        parts.push(`SRGB ${ranges}`);
    }
    if (Array.isArray(prefixSid.srv6Services)) {
        prefixSid.srv6Services.forEach(service => {
            service.sidInfos.forEach(sidInfo => {
                const serviceName = service.serviceType === 'l2' ? 'SRv6 L2' : service.serviceType === 'l3' ? 'SRv6 L3' : service.serviceType === 'vpn' ? 'SRv6 VPN' : 'SRv6';
                parts.push(`${serviceName} ${sidInfo.sid || sidInfo.sidHex} ${sidInfo.endpointBehaviorName || ''}`.trim());
            });
        });
    }
    if (parts.length === 0 && prefixSid.tlvs.length > 0) {
        parts.push(prefixSid.tlvs.map(tlv => `${tlv.typeName}(${tlv.length})`).join(', '));
    }

    return parts.join(', ');
}

function parseBgpPrefixSidAttribute(buffer) {
    const tlvs = [];
    const errors = [];
    const warnings = [];
    const seenRecognizedTypes = new Set();
    let labelIndex = null;
    let originatorSrgb = null;
    const srv6Services = [];
    let position = 0;

    while (position < buffer.length) {
        if (position + 3 > buffer.length) {
            errors.push(`BGP Prefix-SID TLV header is truncated at offset ${position}`);
            break;
        }

        const type = buffer[position];
        const length = buffer.readUInt16BE(position + 1);
        const valueStart = position + 3;
        const valueEnd = valueStart + length;
        if (valueEnd > buffer.length) {
            errors.push(`BGP Prefix-SID TLV ${type} length exceeds attribute: ${length}`);
            break;
        }

        const value = buffer.subarray(valueStart, valueEnd);
        const tlv = {
            type,
            typeName: getBgpPrefixSidTlvTypeName(type),
            length,
            rawValue: value.toString('hex')
        };

        if ((type === 1 || type === 3) && seenRecognizedTypes.has(type)) {
            warnings.push(`Duplicate BGP Prefix-SID ${tlv.typeName} TLV ignored`);
            tlv.ignored = true;
            tlvs.push(tlv);
            position = valueEnd;
            continue;
        }

        switch (type) {
            case 1:
                tlv.labelIndex = parseBgpPrefixSidLabelIndexTlv(value, errors);
                labelIndex = tlv.labelIndex;
                seenRecognizedTypes.add(type);
                break;
            case 3:
                tlv.originatorSrgb = parseBgpPrefixSidOriginatorSrgbTlv(value, errors);
                originatorSrgb = tlv.originatorSrgb;
                seenRecognizedTypes.add(type);
                break;
            case 4:
            case 5:
            case 6:
            case 7:
                tlv.srv6Service = parseBgpPrefixSidSrv6ServiceTlv(type, value, errors);
                srv6Services.push(tlv.srv6Service);
                break;
            default:
                break;
        }

        tlvs.push(tlv);
        position = valueEnd;
    }

    const prefixSid = {
        tlvs,
        labelIndex,
        originatorSrgb,
        srv6Services,
        valid: errors.length === 0,
        errors,
        warnings
    };
    prefixSid.formatted = formatBgpPrefixSid(prefixSid);

    return prefixSid;
}

function buildEvpnEncapsulationSummary(pathAttributes) {
    const encapsulations = [];

    pathAttributes.forEach(attr => {
        if (Array.isArray(attr.extCommunities)) {
            attr.extCommunities.forEach(community => {
                if (community.encapsulation) {
                    encapsulations.push(community.encapsulation);
                }
            });
        }

        if (Array.isArray(attr.tunnelEncapsulation?.tlvs)) {
            encapsulations.push(...attr.tunnelEncapsulation.tlvs);
        }
    });

    if (encapsulations.length === 0) {
        return null;
    }

    const uniqueByTunnelType = new Map();
    encapsulations.forEach(encapsulation => {
        uniqueByTunnelType.set(encapsulation.tunnelType, encapsulation);
    });
    const uniqueEncapsulations = Array.from(uniqueByTunnelType.values());
    const hasVni = uniqueEncapsulations.some(encapsulation => encapsulation.labelType === 'vni');
    const hasMpls = uniqueEncapsulations.some(encapsulation => encapsulation.labelType === 'mpls');
    const hasUnknown = uniqueEncapsulations.some(encapsulation => encapsulation.labelType === 'unknown');
    const labelType = hasVni && !hasMpls && !hasUnknown ? 'vni' : hasMpls && !hasVni && !hasUnknown ? 'mpls' : 'unknown';

    return {
        labelType,
        isVni: labelType === 'vni',
        isMpls: labelType === 'mpls',
        tunnelType: uniqueEncapsulations.length === 1 ? uniqueEncapsulations[0].tunnelType : null,
        tunnelTypeName: uniqueEncapsulations.length === 1 ? uniqueEncapsulations[0].tunnelTypeName : null,
        tunnelTypes: uniqueEncapsulations.map(encapsulation => encapsulation.tunnelType),
        tunnelTypeNames: uniqueEncapsulations.map(encapsulation => encapsulation.tunnelTypeName),
        encapsulations: uniqueEncapsulations
    };
}

function annotatePmsiTunnel(pmsiTunnel, encapsulation) {
    if (!pmsiTunnel) {
        return null;
    }

    const annotated = {
        ...pmsiTunnel,
        label: annotateEvpnLabel(pmsiTunnel.label, encapsulation)
    };
    annotated.labels = annotated.labelPresent && annotated.label ? [annotated.label] : [];
    return annotated;
}

function annotateEvpnRoute(route, encapsulation, pmsiTunnel) {
    if (!route || route.routeType === undefined) {
        return;
    }

    if (encapsulation) {
        route.encapsulation = encapsulation;
        route.encapsulationType = encapsulation.labelType;
    }

    if (pmsiTunnel && route.routeType === 3) {
        route.pmsiTunnel = annotatePmsiTunnel(pmsiTunnel, encapsulation);
        if ((!Array.isArray(route.labels) || route.labels.length === 0) && route.pmsiTunnel.labels.length > 0) {
            route.labels = route.pmsiTunnel.labels;
        }
    }

    if (Array.isArray(route.labels)) {
        route.labels = route.labels.map(label => annotateEvpnLabel(label, encapsulation));
    }
}

function annotateEvpnNlriList(nlriList, afi, safi, encapsulation, pmsiTunnel) {
    if (afi !== BgpConst.BGP_AFI_TYPE.AFI_L2VPN || safi !== BgpConst.BGP_SAFI_TYPE.SAFI_EVPN) {
        return;
    }

    nlriList.forEach(route => annotateEvpnRoute(route, encapsulation, pmsiTunnel));
}

function annotateEvpnPathAttributes(pathAttributes) {
    const encapsulation = buildEvpnEncapsulationSummary(pathAttributes);
    let pmsiTunnel = null;

    pathAttributes.forEach(attr => {
        if (attr.pmsiTunnel) {
            attr.pmsiTunnel = annotatePmsiTunnel(attr.pmsiTunnel, encapsulation);
            pmsiTunnel = attr.pmsiTunnel;
        }
    });

    pathAttributes.forEach(attr => {
        if (attr.mpReach) {
            annotateEvpnNlriList(attr.mpReach.nlri, attr.mpReach.afi, attr.mpReach.safi, encapsulation, pmsiTunnel);
        }
        if (attr.mpUnreach) {
            annotateEvpnNlriList(
                attr.mpUnreach.withdrawnRoutes,
                attr.mpUnreach.afi,
                attr.mpUnreach.safi,
                encapsulation,
                pmsiTunnel
            );
        }
    });
}

/**
 * Parse MP_REACH_NLRI attribute
 * @param {Buffer} buffer - MP_REACH_NLRI attribute value
 * @param {Object} context - Context object
 * @returns {Object} Parsed MP_REACH_NLRI data
 */
function parseMpReachNlri(buffer, context) {
    let position = 0;
    const afi = buffer.readUInt16BE(position);
    position += 2;
    const safi = buffer[position];
    position += 1;
    const nextHopLength = buffer[position];
    position += 1;

    const nextHop = parseNextHop(buffer, position, nextHopLength, afi, safi);

    position += nextHopLength;

    // Skip the reserved byte
    position += 1;

    // Check if ADD-PATH is enabled for this AFI/SAFI
    let addPathEnabled = false;
    if (context && typeof context.isAddPathReceiveEnabled === 'function') {
        addPathEnabled = context.isAddPathReceiveEnabled(afi, safi);
    } else if (context && context.addPathMap) {
        // Backwards compatibility map check omitted for brevity in this specific patch
    }

    // Parse NLRI
    const nlri = [];
    const errors = [];
    const warnings = [];
    while (position < buffer.length) {
        let pathId = 0;
        if (addPathEnabled) {
            pathId = buffer.readUInt32BE(position);
            position += 4;
        }

        const parsedNlri = parseNlriEntry(buffer, position, afi, safi);
        if (parsedNlri.position <= position) {
            break;
        }
        position = parsedNlri.position;
        if (parsedNlri.route.valid === false && Array.isArray(parsedNlri.route.errors)) {
            errors.push(...parsedNlri.route.errors.map(error => `NLRI ${nlri.length + 1}: ${error}`));
        }
        if (Array.isArray(parsedNlri.route.warnings)) {
            warnings.push(...parsedNlri.route.warnings.map(warning => `NLRI ${nlri.length + 1}: ${warning}`));
        }

        nlri.push({
            pathId,
            ...parsedNlri.route
        });
    }

    return {
        afi,
        safi,
        nextHopLength,
        nextHop,
        nlri,
        valid: errors.length === 0,
        errors,
        warnings
    };
}

/**
 * Parse MP_UNREACH_NLRI attribute
 * @param {Buffer} buffer - MP_UNREACH_NLRI attribute value
 * @param {Object} context - Context object
 * @returns {Object} Parsed MP_UNREACH_NLRI data
 */
function parseMpUnreachNlri(buffer, context) {
    let position = 0;
    const afi = buffer.readUInt16BE(position);
    position += 2;
    const safi = buffer[position];
    position += 1;

    // Check if ADD-PATH is enabled for this AFI/SAFI
    let addPathEnabled = false;
    if (context && typeof context.isAddPathReceiveEnabled === 'function') {
        addPathEnabled = context.isAddPathReceiveEnabled(afi, safi);
    } else if (context && context.addPathMap) {
        // Backwards compatibility map check omitted for brevity in this specific patch
    }

    // Parse withdrawn routes
    const withdrawnRoutes = [];
    const errors = [];
    const warnings = [];
    while (position < buffer.length) {
        let pathId = 0;
        if (addPathEnabled) {
            pathId = buffer.readUInt32BE(position);
            position += 4;
        }

        const parsedNlri = parseNlriEntry(buffer, position, afi, safi, true);
        if (parsedNlri.position <= position) {
            break;
        }
        position = parsedNlri.position;
        if (parsedNlri.route.valid === false && Array.isArray(parsedNlri.route.errors)) {
            errors.push(...parsedNlri.route.errors.map(error => `Withdrawn NLRI ${withdrawnRoutes.length + 1}: ${error}`));
        }
        if (Array.isArray(parsedNlri.route.warnings)) {
            warnings.push(
                ...parsedNlri.route.warnings.map(warning => `Withdrawn NLRI ${withdrawnRoutes.length + 1}: ${warning}`)
            );
        }

        withdrawnRoutes.push({
            pathId,
            ...parsedNlri.route
        });
    }

    return {
        afi,
        safi,
        withdrawnRoutes,
        valid: errors.length === 0,
        errors,
        warnings
    };
}

/**
 * Helper function to get a human-readable summary of a BGP packet
 * @param {Object} parsedPacket - The parsed BGP packet object
 * @returns {String} Human-readable summary
 */
function isVariableLengthSummaryNlri(afi, safi) {
    return (
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_EVPN ||
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC ||
        (afi === BgpConst.BGP_AFI_TYPE.AFI_BGP_LS &&
            (safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS || safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS_VPN))
    );
}

function getBgpSummaryRouteLength(route, afi, safi) {
    if (isVariableLengthSummaryNlri(afi, safi)) {
        if (route.nlriLength !== undefined && route.nlriLength !== null) {
            return route.nlriLength;
        }
        if (typeof route.rawNlri === 'string') {
            return Math.ceil(route.rawNlri.length / 2);
        }
    }

    return route.length;
}

function formatBgpSummaryRoute(route, afi, safi, indent, includePathId = true) {
    if (route.dqpn !== undefined) {
        return `${indent}- DIP:${route.prefix}/${route.length}, DQPN:=${route.dqpn}/${route.dqpnBits}`;
    }

    const pathId = includePathId && route.pathId !== undefined ? `${route.pathId} ` : '';
    return `${indent}- ${pathId}${route.prefix}/${getBgpSummaryRouteLength(route, afi, safi)}`;
}

function getBgpPacketSummary(parsedPacket) {
    if (!parsedPacket || !parsedPacket.valid) {
        return `Invalid BGP packet: ${parsedPacket?.error || 'Unknown error'}`;
    }

    const typeName = getBgpPacketTypeName(parsedPacket.type);
    let summary = `BGP ${typeName} Message (${parsedPacket.length} bytes)`;

    switch (parsedPacket.type) {
        case BgpConst.BGP_PACKET_TYPE.OPEN: // OPEN
            summary += `\nVersion: ${parsedPacket.version}`;
            summary += `\nAS: ${parsedPacket.asn}`;
            summary += `\nHold Time: ${parsedPacket.holdTime} seconds`;
            summary += `\nRouter ID: ${parsedPacket.routerId}`;

            if (parsedPacket.capabilities && parsedPacket.capabilities.length > 0) {
                summary += '\nCapabilities:';
                parsedPacket.capabilities.forEach(cap => {
                    const capName = getBgpOpenCapabilityName(cap.code);
                    summary += `\n  - ${capName}`;

                    if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS) {
                        // Multiprotocol
                        const afiName = getBgpAfiName(cap.afi);
                        const safiName = getBgpSafiName(cap.safi);
                        summary += ` (${afiName}/${safiName})`;
                    } else if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS) {
                        // 4-octet AS
                        summary += ` (AS${cap.as4})`;
                    } else if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.BGP_ROLE) {
                        // BGP Role
                        const roleName = getBgpOpenRoleName(cap.role);
                        summary += ` (${roleName})`;
                    } else if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING) {
                        // Extended Next Hop Encoding
                        if (cap.nextHops && cap.nextHops.length > 0) {
                            cap.nextHops.forEach(nextHop => {
                                const afiName = getBgpAfiName(nextHop.afi);
                                const safiName = getBgpSafiName(nextHop.safi);
                                const ipTypeName = getIpTypeName(nextHop.ipType);
                                summary += `\n    - ${afiName}/${safiName}/${ipTypeName}`;
                            });
                        } else {
                            const afiName = getBgpAfiName(cap.afi);
                            const safiName = getBgpSafiName(cap.safi);
                            const ipTypeName = getIpTypeName(cap.ipType);
                            summary += ` (${afiName}/${safiName}/${ipTypeName})`;
                        }
                    } else if (cap.code === BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH) {
                        // ADD-PATH
                        if (cap.addPaths && cap.addPaths.length > 0) {
                            cap.addPaths.forEach(path => {
                                const afiName = getBgpAfiName(path.afi);
                                const safiName = getBgpSafiName(path.safi);
                                const direction = getBgpAddPathTypeName(path.sendReceive);
                                summary += `\n    - ${afiName}/${safiName}: ${direction}`;
                            });
                        }
                    }
                });
            }
            break;

        case BgpConst.BGP_PACKET_TYPE.UPDATE: // UPDATE
            if (parsedPacket.withdrawnRoutes && parsedPacket.withdrawnRoutes.length > 0) {
                summary += '\nWithdrawn Routes:';
                parsedPacket.withdrawnRoutes.forEach(route => {
                    summary += `\n${formatBgpSummaryRoute(route, null, null, '  ', false)}`;
                });
            }

            if (parsedPacket.pathAttributes && parsedPacket.pathAttributes.length > 0) {
                summary += '\nPath Attributes:';
                parsedPacket.pathAttributes.forEach(attr => {
                    const attrName = getBgpPathAttrTypeName(attr.typeCode);
                    summary += `\n  - ${attrName}`;

                    if (attr.typeCode === BgpConst.BGP_PATH_ATTR.ORIGIN) {
                        summary += `: ${attr.origin}`;
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.AS_PATH) {
                        if (attr.segments) {
                            summary += ': ';
                            attr.segments.forEach(seg => {
                                if (seg.typeName === 'AS_SEQUENCE') {
                                    summary += seg.asNumbers.join(' ');
                                } else {
                                    summary += `{${seg.asNumbers.join(' ')}}`;
                                }
                            });
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.NEXT_HOP) {
                        summary += `: ${attr.nextHop}`;
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.LOCAL_PREF) {
                        summary += `: ${attr.localPref}`;
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.COMMUNITY) {
                        if (attr.communities) {
                            summary += `: ${attr.communities.map(c => c.formatted).join(' ')}`;
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES) {
                        if (attr.extCommunities) {
                            summary += `: ${attr.extCommunities.map(c => c.formatted).join(' ')}`;
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.PMSI_TUNNEL) {
                        if (attr.pmsiTunnel) {
                            summary += `: ${attr.pmsiTunnel.tunnelTypeName}`;
                            if (attr.pmsiTunnel.labelPresent && attr.pmsiTunnel.label) {
                                summary += ` ${attr.pmsiTunnel.label.display}`;
                            }
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.TUNNEL_ENCAPSULATION) {
                        if (attr.tunnelEncapsulation) {
                            summary += `: ${attr.tunnelEncapsulation.tlvs.map(tlv => tlv.tunnelTypeName).join(', ')}`;
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.PREFIX_SID) {
                        if (attr.prefixSid?.formatted) {
                            summary += `: ${attr.prefixSid.formatted}`;
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MED) {
                        summary += `: ${attr.med}`;
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI) {
                        const afiName = getBgpAfiName(attr.mpReach.afi);
                        const safiName = getBgpSafiName(attr.mpReach.safi);
                        summary += `\n    - (${afiName}/${safiName}: ${attr.mpReach.nextHop})`;
                        if (attr.mpReach.nlri && attr.mpReach.nlri.length > 0) {
                            summary += '\n    - Routes:';
                            attr.mpReach.nlri.forEach(route => {
                                summary += `\n${formatBgpSummaryRoute(route, attr.mpReach.afi, attr.mpReach.safi, '      ')}`;
                            });
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI) {
                        const afiName = getBgpAfiName(attr.mpUnreach.afi);
                        const safiName = getBgpSafiName(attr.mpUnreach.safi);
                        summary += `\n    - (${afiName}/${safiName})`;
                        if (attr.mpUnreach.withdrawnRoutes && attr.mpUnreach.withdrawnRoutes.length > 0) {
                            summary += '\n    - Routes:';
                            attr.mpUnreach.withdrawnRoutes.forEach(route => {
                                summary += `\n${formatBgpSummaryRoute(
                                    route,
                                    attr.mpUnreach.afi,
                                    attr.mpUnreach.safi,
                                    '      '
                                )}`;
                            });
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.PATH_OTC) {
                        summary += `: ${attr.otc}`;
                    }
                });
            }

            if (parsedPacket.nlri && parsedPacket.nlri.length > 0) {
                summary += '\nRoutes:';
                parsedPacket.nlri.forEach(route => {
                    summary += `\n${formatBgpSummaryRoute(route, null, null, '  ')}`;
                });
            }
            break;

        case BgpConst.BGP_PACKET_TYPE.NOTIFICATION: // NOTIFICATION
            {
                const errorName = getBgpNotificationErrorName(parsedPacket.errorCode, parsedPacket.errorSubcode);
                summary += `\nError: ${errorName}`;
                summary += `\nError Code: ${parsedPacket.errorCode}`;
                summary += `\nError Subcode: ${parsedPacket.errorSubcode}`;
            }
            break;

        case BgpConst.BGP_PACKET_TYPE.KEEPALIVE: // KEEPALIVE
            // No additional information for keepalive
            break;

        case BgpConst.BGP_PACKET_TYPE.ROUTE_REFRESH: // ROUTE-REFRESH
            {
                const afiName = getBgpAfiName(parsedPacket.afi);
                const safiName = getBgpSafiName(parsedPacket.safi);
                summary += `\nAddress Family: ${afiName}`;
                summary += `\nSubsequent Address Family: ${safiName}`;
            }
            break;
    }

    return summary;
}

module.exports = {
    parseBgpPacket,
    getBgpPacketSummary,
    parsePathAttributes
};
