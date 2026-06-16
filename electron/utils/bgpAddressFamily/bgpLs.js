const BgpConst = require('../../const/bgpConst');
const { ipv4BufferToString, ipv6BufferToString, rdBufferToString } = require('../ipUtils');
const { formatIpAddressList } = require('./common');

function parseBgpLsNextHop(buffer, position, nextHopLength) {
    return formatIpAddressList(buffer, position, nextHopLength);
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

module.exports = {
    parseBgpLsNlri,
    parseBgpLsNextHop
};
