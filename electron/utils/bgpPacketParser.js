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
        if (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 && nextHopLength === BgpConst.BGP_RD_LEN + BgpConst.IP_HOST_BYTE_LEN) {
            return ipv4BufferToString(
                buffer.subarray(position + BgpConst.BGP_RD_LEN, position + BgpConst.BGP_RD_LEN + BgpConst.IP_HOST_BYTE_LEN),
                BgpConst.IP_HOST_LEN
            );
        }

        if (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 && nextHopLength === BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN) {
            return ipv6BufferToString(
                buffer.subarray(position + BgpConst.BGP_RD_LEN, position + BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN),
                BgpConst.IPV6_HOST_LEN
            );
        }

        if (
            afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 &&
            nextHopLength === (BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN) * 2
        ) {
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

function buildBgpLsRoutePrefix(nlriType, protocolId, identifier, tlvs) {
    const typeName = BGP_LS_NLRI_TYPE_NAMES[nlriType] || `Type ${nlriType}`;
    const protocolName = BGP_LS_PROTOCOL_NAMES[protocolId] || `Protocol ${protocolId}`;
    const reachability = findBgpLsTlv(tlvs, 265);
    if (reachability) {
        return `bgp-ls:${typeName}:${reachability.value}`;
    }

    const localAddress = findBgpLsTlv(tlvs, 259) || findBgpLsTlv(tlvs, 261);
    const remoteAddress = findBgpLsTlv(tlvs, 260) || findBgpLsTlv(tlvs, 262);
    if (localAddress || remoteAddress) {
        return `bgp-ls:${typeName}:${localAddress ? localAddress.value : '?'}->${remoteAddress ? remoteAddress.value : '?'}`;
    }

    const localNode = findBgpLsTlv(tlvs, 256);
    const nodeSummary = localNode && localNode.children ? localNode.children.map(child => child.value).join(',') : '';
    return `bgp-ls:${typeName}:${protocolName}:id=${identifier}${nodeSummary ? `:${nodeSummary}` : ''}`;
}

function parseBgpLsNlri(buffer, position) {
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
    if (!BGP_LS_NLRI_TYPE_NAMES[nlriType]) {
        return {
            position: nlriEnd,
            route: {
                prefix: `bgp-ls:type-${nlriType}:0x${rawNlri.toString('hex')}`,
                rd: null,
                length: nlriLength * 8,
                routeType: nlriType,
                descriptors: [],
                rawNlri: rawNlri.toString('hex'),
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
    const routePrefix = buildBgpLsRoutePrefix(nlriType, protocolId, identifier, tlvs);
    const routeLength = reachability ? parseInt(reachability.value.split('/').pop(), 10) : nlriLength * 8;

    return {
        position: nlriEnd,
        route: {
            prefix: routePrefix,
            rd: null,
            length: routeLength,
            routeType: nlriType,
            protocolId,
            protocol: BGP_LS_PROTOCOL_NAMES[protocolId] || protocolId,
            identifier,
            descriptors: tlvs,
            rawNlri: rawNlri.toString('hex'),
            valid: errors.length === 0,
            errors,
            warnings
        }
    };
}

function parseRouteDistinguisherNlri(buffer, position, afi) {
    let prefixLength = buffer[position];
    position += 1;

    position += 3;
    const rdBuffer = buffer.subarray(position, position + BgpConst.BGP_RD_LEN);
    const rd = rdBufferToString(rdBuffer);
    position += BgpConst.BGP_RD_LEN;

    prefixLength -= 3 << 3;
    prefixLength -= BgpConst.BGP_RD_LEN << 3;

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
            displayPrefix: `${rd}:${prefix}`,
            rd,
            length: prefixLength
        }
    };
}

const EVPN_ROUTE_TYPE_NAMES = {
    1: 'Ethernet A-D',
    2: 'MAC/IP Advertisement',
    3: 'Inclusive Multicast Ethernet Tag',
    4: 'Ethernet Segment',
    5: 'IP Prefix'
};

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
        label: {
            label: entry >> 4,
            exp: (entry >> 1) & 0x07,
            bottom: (entry & 0x01) === 1
        },
        position: position + 3
    };
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
    }

    return {
        position,
        route: {
            prefix: routeValue.toString('hex'),
            rd: null,
            length: routeLength,
            routeType,
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

    if (afi === BgpConst.BGP_AFI_TYPE.AFI_BGP_LS && safi === BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS) {
        return parseBgpLsNlri(buffer, position);
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
        extCommunities.push({
            formatted: extCommunitiesBufferToString(subBuffer)
        });
    }

    return extCommunities;
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
                    summary += `\n  - ${route.prefix}/${route.length}`;
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
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MED) {
                        summary += `: ${attr.med}`;
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI) {
                        const afiName = getBgpAfiName(attr.mpReach.afi);
                        const safiName = getBgpSafiName(attr.mpReach.safi);
                        summary += `\n    - (${afiName}/${safiName}: ${attr.mpReach.nextHop})`;
                        if (attr.mpReach.nlri && attr.mpReach.nlri.length > 0) {
                            summary += '\n    - Routes:';
                            attr.mpReach.nlri.forEach(route => {
                                if (route.dqpn !== undefined) {
                                    summary += `\n      - DIP:${route.prefix}/${route.length}, DQPN:=${route.dqpn}/${route.dqpnBits}`;
                                } else {
                                    summary += `\n      - ${route.pathId} ${route.prefix}/${route.length}`;
                                }
                            });
                        }
                    } else if (attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI) {
                        const afiName = getBgpAfiName(attr.mpUnreach.afi);
                        const safiName = getBgpSafiName(attr.mpUnreach.safi);
                        summary += `\n    - (${afiName}/${safiName})`;
                        if (attr.mpUnreach.withdrawnRoutes && attr.mpUnreach.withdrawnRoutes.length > 0) {
                            summary += '\n    - Routes:';
                            attr.mpUnreach.withdrawnRoutes.forEach(route => {
                                if (route.dqpn !== undefined) {
                                    summary += `\n      - DIP:${route.prefix}/${route.length}, DQPN:=${route.dqpn}/${route.dqpnBits}`;
                                } else {
                                    summary += `\n      - ${route.pathId} ${route.prefix}/${route.length}`;
                                }
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
                    summary += `\n  - ${route.pathId} ${route.prefix}/${route.length}`;
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
