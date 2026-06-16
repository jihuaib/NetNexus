const BgpConst = require('../../const/bgpConst');
const { ipv4BufferToString, ipv6BufferToString, rdBufferToString } = require('../ipUtils');
const { formatIpAddressList } = require('./common');

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

function parseEvpnNextHop(buffer, position, nextHopLength) {
    return formatIpAddressList(buffer, position, nextHopLength);
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
    const ipBytes =
        ipLength === 0 ? 0 : ipLength === BgpConst.IP_HOST_LEN ? 4 : ipLength === BgpConst.IPV6_HOST_LEN ? 16 : null;
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

module.exports = {
    parseEvpnNlri,
    parseEvpnNextHop,
    buildEvpnLabel,
    annotateEvpnLabel,
    buildBgpTunnelEncapsulation,
    EXT_COMMUNITY_TYPE_TRANSITIVE_OPAQUE,
    EXT_COMMUNITY_TYPE_NON_TRANSITIVE_OPAQUE,
    EXT_COMMUNITY_SUB_TYPE_ENCAPSULATION,
    BGP_TUNNEL_TYPE,
    getBgpTunnelTypeName,
    getPmsiTunnelTypeName,
    getBgpPrefixSidTlvTypeName,
    getSrv6ServiceSubTlvTypeName,
    getSrv6ServiceDataSubSubTlvTypeName,
    getSrv6EndpointBehaviorName
};
