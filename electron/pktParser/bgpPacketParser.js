/**
 * BGP Packet Parser
 *
 * Parses BGP protocol packets from raw buffers and returns structured data
 * and tree visualization.
 * Based on RFC 4271 and other BGP extension RFCs.
 */

const logger = require('../log/logger');

const BgpConst = require('../const/bgpConst');
const { ipv4BufferToString, ipv6BufferToString, getIpTypeName, extCommunitiesBufferToString } = require('../utils/ipUtils');
const {
    getBgpPacketTypeName,
    getBgpOpenCapabilityName,
    getBgpAfiName,
    getBgpSafiName,
    getBgpOpenRoleName,
    getBgpPathAttrTypeName,
    getBgpNotificationErrorName,
    getBgpOriginType,
    getBgpAsPathTypeName,
    getBgpAddPathTypeName
} = require('../utils/bgpUtils');

const BGP_TUNNEL_TYPE_NAMES = {
    0: 'Reserved',
    1: 'L2TPv3 over IP',
    2: 'GRE',
    3: 'Transmit tunnel endpoint',
    4: 'IPsec in Tunnel-mode',
    5: 'IP in IP tunnel with IPsec Transport Mode',
    6: 'MPLS-in-IP tunnel with IPsec Transport Mode',
    7: 'IP in IP',
    8: 'VXLAN',
    9: 'NVGRE',
    10: 'MPLS',
    11: 'MPLS in GRE',
    12: 'VXLAN GPE',
    13: 'MPLS in UDP',
    14: 'IPv6 Tunnel',
    15: 'MPLS in UDP with DTLS',
    16: 'SR Policy',
    17: 'SR Tunnel',
    19: 'Geneve'
};

const PMSI_TUNNEL_TYPE_NAMES = {
    0: 'No tunnel information',
    1: 'RSVP-TE P2MP LSP',
    2: 'mLDP P2MP LSP',
    3: 'PIM-SSM Tree',
    4: 'PIM-SM Tree',
    5: 'BIDIR-PIM Tree',
    6: 'Ingress Replication',
    7: 'mLDP MP2MP LSP',
    8: 'BIER'
};

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

function getBgpPrefixSidTlvTypeName(type) {
    return BGP_PREFIX_SID_TLV_TYPE_NAMES[type] || `Unknown (${type})`;
}

function getBgpTunnelTypeName(type) {
    return BGP_TUNNEL_TYPE_NAMES[type] || `Unknown (${type})`;
}

function getPmsiTunnelTypeName(type) {
    return PMSI_TUNNEL_TYPE_NAMES[type] || `Unknown (${type})`;
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

function createTreeNode(name, offset, length, value = '', children = []) {
    return {
        name,
        offset,
        length,
        value,
        children
    };
}

function addLeafNode(parentNode, name, offset, length, value = '') {
    const node = createTreeNode(name, offset, length, value);
    parentNode.children.push(node);
    return node;
}

function formatHex(buffer, start, end) {
    return buffer.subarray(start, end).toString('hex');
}

function isSimpleIpNlri(afi, safi) {
    return (
        (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 || afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) &&
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    );
}

function formatIpPrefix(buffer, offset, prefixLength, afi) {
    const prefixBytes = Math.ceil(prefixLength / 8);
    const prefixBuffer = buffer.subarray(offset, offset + prefixBytes);
    if (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) {
        return ipv6BufferToString(prefixBuffer, prefixLength);
    }
    return ipv4BufferToString(prefixBuffer, prefixLength);
}

function formatNextHop(buffer, offset, nextHopLength, afi, safi) {
    if (nextHopLength === 0) {
        return '';
    }

    if (
        (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 || afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) &&
        safi === BgpConst.BGP_SAFI_TYPE.SAFI_VPN
    ) {
        if (nextHopLength === BgpConst.BGP_RD_LEN + BgpConst.IP_HOST_BYTE_LEN) {
            return ipv4BufferToString(
                buffer.subarray(offset + BgpConst.BGP_RD_LEN, offset + BgpConst.BGP_RD_LEN + BgpConst.IP_HOST_BYTE_LEN),
                BgpConst.IP_HOST_LEN
            );
        }
        if (nextHopLength === BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN) {
            return ipv6BufferToString(
                buffer.subarray(offset + BgpConst.BGP_RD_LEN, offset + BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN),
                BgpConst.IPV6_HOST_LEN
            );
        }
        if (nextHopLength === (BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN) * 2) {
            const globalNextHop = ipv6BufferToString(
                buffer.subarray(offset + BgpConst.BGP_RD_LEN, offset + BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN),
                BgpConst.IPV6_HOST_LEN
            );
            const linkLocalOffset = offset + BgpConst.BGP_RD_LEN + BgpConst.IPV6_HOST_BYTE_LEN + BgpConst.BGP_RD_LEN;
            const linkLocalNextHop = ipv6BufferToString(
                buffer.subarray(linkLocalOffset, linkLocalOffset + BgpConst.IPV6_HOST_BYTE_LEN),
                BgpConst.IPV6_HOST_LEN
            );
            return `${globalNextHop}, ${linkLocalNextHop}`;
        }
    }

    if (nextHopLength === BgpConst.IP_HOST_BYTE_LEN) {
        return ipv4BufferToString(buffer.subarray(offset, offset + BgpConst.IP_HOST_BYTE_LEN), BgpConst.IP_HOST_LEN);
    }
    if (nextHopLength === BgpConst.IPV6_HOST_BYTE_LEN) {
        return ipv6BufferToString(buffer.subarray(offset, offset + BgpConst.IPV6_HOST_BYTE_LEN), BgpConst.IPV6_HOST_LEN);
    }
    if (nextHopLength === BgpConst.IPV6_HOST_BYTE_LEN * 2) {
        const globalNextHop = ipv6BufferToString(
            buffer.subarray(offset, offset + BgpConst.IPV6_HOST_BYTE_LEN),
            BgpConst.IPV6_HOST_LEN
        );
        const linkLocalNextHop = ipv6BufferToString(
            buffer.subarray(offset + BgpConst.IPV6_HOST_BYTE_LEN, offset + BgpConst.IPV6_HOST_BYTE_LEN * 2),
            BgpConst.IPV6_HOST_LEN
        );
        return `${globalNextHop}, ${linkLocalNextHop}`;
    }

    return formatHex(buffer, offset, offset + nextHopLength);
}

function addSimpleNlriNodes(parentNode, buffer, offset, endOffset, afi, nodeName = 'NLRI') {
    const nlriNode = createTreeNode(nodeName, offset, endOffset - offset, '', []);
    parentNode.children.push(nlriNode);

    let position = offset;
    let routeIndex = 0;
    const routes = [];
    while (position < endOffset) {
        const prefixLength = buffer[position];
        const prefixBytes = Math.ceil(prefixLength / 8);
        const routeLength = 1 + prefixBytes;
        if (position + routeLength > endOffset) {
            nlriNode.children.push(
                createTreeNode('Malformed Route', position, endOffset - position, 'Prefix length exceeds NLRI data', [])
            );
            break;
        }

        const routeNode = createTreeNode(`Route ${routeIndex + 1}`, position, routeLength, '', []);
        nlriNode.children.push(routeNode);
        addLeafNode(routeNode, 'Prefix Length', position, 1, prefixLength);
        position += 1;

        let prefix = afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6 ? '::' : '0.0.0.0';
        if (prefixBytes > 0) {
            prefix = formatIpPrefix(buffer, position, prefixLength, afi);
            addLeafNode(routeNode, 'Prefix', position, prefixBytes, prefix);
            position += prefixBytes;
        }

        routeNode.value = `${prefix}/${prefixLength}`;
        routes.push(routeNode.value);
        routeIndex += 1;
    }

    nlriNode.value = routes.join(', ');
    return nlriNode;
}

function formatMplsLabel(raw24) {
    if (raw24 === 0) {
        return 'No Label';
    }
    const label = raw24 >> 4;
    const bottom = (raw24 & 0x1) === 1;
    return `Label ${label}${bottom ? ' (Bottom)' : ''}`;
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
    const flags = buffer[offset + 17];
    const behavior = buffer.readUInt16BE(offset + 18);
    const reserved2 = buffer[offset + 20];
    
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
            name: 'Flags',
            offset: offset + 17,
            length: 1,
            value: `0x${flags.toString(16).padStart(2, '0')}`,
            children: []
        },
        {
            name: 'Endpoint Behavior',
            offset: offset + 18,
            length: 2,
            value: `${behavior} (${getSrv6EndpointBehaviorName(behavior)})`,
            children: []
        },
        {
            name: 'Reserved',
            offset: offset + 20,
            length: 1,
            value: reserved2,
            children: []
        }
    );

    addSrv6ServiceDataSubSubTlvs(buffer, sidInfoNode, offset + 21, offset + length);
}

function addSrv6ServiceTlvDetails(buffer, prefixSidNode, tlvNode, type, valueOffset, length) {
    const serviceName = type === 5 ? 'SRv6 L3' : type === 6 ? 'SRv6 L2' : type === 4 ? 'SRv6 VPN' : 'SRv6';
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
            if (subLength >= 20) {
                const sid = ipv6BufferToString(buffer.subarray(subValueOffset + 1, subValueOffset + 17), BgpConst.IPV6_HOST_LEN);
                const behavior = buffer.readUInt16BE(subValueOffset + 18);
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

    if (type === 4 || type === 5 || type === 6 || type === 7) {
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
        if (!Buffer.isBuffer(buffer) || buffer.length < offset + BgpConst.BGP_HEAD_LEN) {
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
        const messageEndOffset = offset + length;

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
        if (buffer.length < messageEndOffset) {
            return {
                valid: false,
                error: `Incomplete packet: expected ${length} bytes from offset ${offset}, got ${buffer.length - offset}`,
                tree
            };
        }

        // 根据消息类型解析消息体
        let payload = null;
        let newOffset = curOffset;

        switch (type) {
            case BgpConst.BGP_PACKET_TYPE.OPEN:
                newOffset = parseOpenMessageTree(buffer, curOffset, headerNode, messageEndOffset);
                break;
            case BgpConst.BGP_PACKET_TYPE.UPDATE:
                newOffset = parseUpdateMessageTree(buffer, curOffset, headerNode, messageEndOffset);
                break;
            case BgpConst.BGP_PACKET_TYPE.NOTIFICATION:
                newOffset = parseNotificationMessageTree(buffer, curOffset, headerNode, messageEndOffset);
                break;
            case BgpConst.BGP_PACKET_TYPE.KEEPALIVE:
                // Keepalive没有额外数据
                // messageBodyNode.value = 'No data (Keepalive message)';
                newOffset = curOffset;
                break;
            case BgpConst.BGP_PACKET_TYPE.ROUTE_REFRESH:
                newOffset = parseRouteRefreshMessageTree(buffer, curOffset, headerNode, messageEndOffset);
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
function parseOpenMessageTree(buffer, curOffset, parentNode, messageEndOffset) {
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

        const optParamsEnd = Math.min(curOffset + optParamLen, messageEndOffset);

        while (curOffset < optParamsEnd) {
            if (curOffset + 2 > optParamsEnd) {
                optParamsNode.children.push(
                    createTreeNode('Malformed Parameter', curOffset, optParamsEnd - curOffset, 'Truncated parameter header')
                );
                break;
            }

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
                const capEndOffset = Math.min(capOffset + paramLen, optParamsEnd);

                while (capOffset < capEndOffset) {
                    if (capOffset + 2 > capEndOffset) {
                        capabilitiesNode.children.push(
                            createTreeNode('Malformed Capability', capOffset, capEndOffset - capOffset, 'Truncated capability header')
                        );
                        break;
                    }

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

                            case BgpConst.BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING: {
                                let tupleOffset = valueOffset;
                                let tupleIndex = 0;
                                const tupleEnd = valueOffset + capLen;
                                const tupleSummaries = [];
                                while (tupleOffset + 6 <= tupleEnd) {
                                    const afi = buffer.readUInt16BE(tupleOffset);
                                    const safi = buffer.readUInt16BE(tupleOffset + 2);
                                    const nextHopAfi = buffer.readUInt16BE(tupleOffset + 4);
                                    const tupleNode = createTreeNode(
                                        `Next Hop Tuple ${tupleIndex + 1}`,
                                        tupleOffset,
                                        6,
                                        `${getBgpAfiName(afi)}/${getBgpSafiName(safi)}/${getIpTypeName(nextHopAfi)}`,
                                        []
                                    );
                                    capabilityNode.children.push(tupleNode);
                                    addLeafNode(tupleNode, 'AFI', tupleOffset, 2, `${afi} (${getBgpAfiName(afi)})`);
                                    addLeafNode(tupleNode, 'SAFI', tupleOffset + 2, 2, `${safi} (${getBgpSafiName(safi)})`);
                                    addLeafNode(
                                        tupleNode,
                                        'Next Hop AFI',
                                        tupleOffset + 4,
                                        2,
                                        `${nextHopAfi} (${getIpTypeName(nextHopAfi)})`
                                    );
                                    tupleSummaries.push(tupleNode.value);
                                    tupleOffset += 6;
                                    tupleIndex += 1;
                                }
                                if (tupleOffset < tupleEnd) {
                                    capabilityNode.children.push(
                                        createTreeNode(
                                            'Trailing Data',
                                            tupleOffset,
                                            tupleEnd - tupleOffset,
                                            formatHex(buffer, tupleOffset, tupleEnd),
                                            []
                                        )
                                    );
                                }
                                capabilityNode.value = tupleSummaries.join(', ');
                                break;
                            }

                            case BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH: {
                                let tupleOffset = valueOffset;
                                let tupleIndex = 0;
                                const tupleEnd = valueOffset + capLen;
                                const tupleSummaries = [];
                                while (tupleOffset + 4 <= tupleEnd) {
                                    const afi = buffer.readUInt16BE(tupleOffset);
                                    const safi = buffer[tupleOffset + 2];
                                    const sendReceive = buffer[tupleOffset + 3];
                                    const tupleNode = createTreeNode(
                                        `ADD-PATH Tuple ${tupleIndex + 1}`,
                                        tupleOffset,
                                        4,
                                        `${getBgpAfiName(afi)}/${getBgpSafiName(safi)}: ${getBgpAddPathTypeName(sendReceive)}`,
                                        []
                                    );
                                    capabilityNode.children.push(tupleNode);
                                    addLeafNode(tupleNode, 'AFI', tupleOffset, 2, `${afi} (${getBgpAfiName(afi)})`);
                                    addLeafNode(tupleNode, 'SAFI', tupleOffset + 2, 1, `${safi} (${getBgpSafiName(safi)})`);
                                    addLeafNode(
                                        tupleNode,
                                        'Send/Receive',
                                        tupleOffset + 3,
                                        1,
                                        `${sendReceive} (${getBgpAddPathTypeName(sendReceive)})`
                                    );
                                    tupleSummaries.push(tupleNode.value);
                                    tupleOffset += 4;
                                    tupleIndex += 1;
                                }
                                if (tupleOffset < tupleEnd) {
                                    capabilityNode.children.push(
                                        createTreeNode(
                                            'Trailing Data',
                                            tupleOffset,
                                            tupleEnd - tupleOffset,
                                            formatHex(buffer, tupleOffset, tupleEnd),
                                            []
                                        )
                                    );
                                }
                                capabilityNode.value = tupleSummaries.join(', ');
                                break;
                            }

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

                    capOffset = Math.min(capOffset + capLen, capEndOffset);
                }
                curOffset = Math.min(curOffset + paramLen, optParamsEnd);
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
                curOffset = Math.min(curOffset + paramLen, optParamsEnd);
            }
        }
    }

    return curOffset;
}

function addAsPathNode(buffer, attrNode, valueOffset, attrValueEnd, nodeName = 'AS_PATH', asnSize = 4) {
    const asPathNode = createTreeNode(nodeName, valueOffset, attrValueEnd - valueOffset, '', []);
    attrNode.children.push(asPathNode);

    let segmentOffset = valueOffset;
    let segmentIndex = 0;
    const segmentSummaries = [];
    while (segmentOffset < attrValueEnd) {
        if (segmentOffset + 2 > attrValueEnd) {
            asPathNode.children.push(
                createTreeNode('Malformed Segment', segmentOffset, attrValueEnd - segmentOffset, 'Truncated AS_PATH segment header')
            );
            break;
        }

        const segmentType = buffer[segmentOffset];
        const segmentTypeName = getBgpAsPathTypeName(segmentType);
        const segmentLength = buffer[segmentOffset + 1];
        const segmentByteLength = 2 + segmentLength * asnSize;
        const segmentNode = createTreeNode(
            `Segment ${segmentIndex + 1} (${segmentTypeName})`,
            segmentOffset,
            Math.min(segmentByteLength, attrValueEnd - segmentOffset),
            segmentTypeName,
            []
        );
        asPathNode.children.push(segmentNode);
        addLeafNode(segmentNode, 'Type', segmentOffset, 1, `${segmentType} (${segmentTypeName})`);
        addLeafNode(segmentNode, 'Length', segmentOffset + 1, 1, segmentLength);

        segmentOffset += 2;
        const asNumbers = [];
        for (let i = 0; i < segmentLength; i++) {
            if (segmentOffset + asnSize > attrValueEnd) {
                segmentNode.children.push(
                    createTreeNode('Malformed AS Number', segmentOffset, attrValueEnd - segmentOffset, 'Truncated AS number')
                );
                segmentOffset = attrValueEnd;
                break;
            }

            const asn = asnSize === 2 ? buffer.readUInt16BE(segmentOffset) : buffer.readUInt32BE(segmentOffset);
            asNumbers.push(asn);
            addLeafNode(segmentNode, `AS${i + 1}`, segmentOffset, asnSize, asn);
            segmentOffset += asnSize;
        }

        segmentNode.value =
            segmentType === BgpConst.BGP_AS_PATH_TYPE.AS_SEQUENCE
                ? `${segmentTypeName}: ${asNumbers.join(' ')}`
                : `${segmentTypeName}: {${asNumbers.join(' ')}}`;
        segmentSummaries.push(segmentNode.value);
        segmentIndex += 1;
    }

    asPathNode.value = segmentSummaries.join(' ');
}

function addAggregatorNode(buffer, attrNode, valueOffset, attrLength, asnSize, nodeName) {
    const attrValueEnd = valueOffset + attrLength;
    const aggregatorNode = createTreeNode(nodeName, valueOffset, attrLength, '', []);
    attrNode.children.push(aggregatorNode);

    if (attrLength < asnSize + 4) {
        aggregatorNode.value = 'Truncated';
        if (attrLength > 0) {
            addLeafNode(aggregatorNode, 'Raw Value', valueOffset, attrLength, formatHex(buffer, valueOffset, attrValueEnd));
        }
        return;
    }

    const aggregatorAs = asnSize === 2 ? buffer.readUInt16BE(valueOffset) : buffer.readUInt32BE(valueOffset);
    const aggregatorIpOffset = valueOffset + asnSize;
    const aggregatorIp = ipv4BufferToString(buffer.subarray(aggregatorIpOffset, aggregatorIpOffset + 4), BgpConst.IP_HOST_LEN);

    addLeafNode(aggregatorNode, 'AS', valueOffset, asnSize, aggregatorAs);
    addLeafNode(aggregatorNode, 'IP', aggregatorIpOffset, 4, aggregatorIp);
    aggregatorNode.value = `AS: ${aggregatorAs}, IP: ${aggregatorIp}`;
}

function addExtendedCommunitiesNode(buffer, attrNode, valueOffset, attrValueEnd) {
    const extNode = createTreeNode('Extended Communities', valueOffset, attrValueEnd - valueOffset, '', []);
    attrNode.children.push(extNode);

    const communities = [];
    let commOffset = valueOffset;
    let index = 0;
    while (commOffset < attrValueEnd) {
        const commLength = Math.min(8, attrValueEnd - commOffset);
        const commBuffer = buffer.subarray(commOffset, commOffset + commLength);
        let formatted;
        try {
            formatted = commLength === 8 ? extCommunitiesBufferToString(commBuffer) : `truncated(${commBuffer.toString('hex')})`;
        } catch (_error) {
            formatted = `unknown(${commBuffer.toString('hex')})`;
        }

        const commNode = createTreeNode(`Extended Community ${index + 1}`, commOffset, commLength, formatted, []);
        extNode.children.push(commNode);
        if (commLength >= 1) {
            addLeafNode(commNode, 'Type', commOffset, 1, `0x${buffer[commOffset].toString(16).padStart(2, '0')}`);
        }
        if (commLength >= 2) {
            addLeafNode(commNode, 'Sub-Type', commOffset + 1, 1, `0x${buffer[commOffset + 1].toString(16).padStart(2, '0')}`);
        }
        if (commLength > 2) {
            addLeafNode(commNode, 'Value', commOffset + 2, commLength - 2, formatHex(buffer, commOffset + 2, commOffset + commLength));
        }
        communities.push(formatted);
        commOffset += commLength;
        index += 1;
    }

    extNode.value = communities.join(', ');
}

function addPmsiTunnelNode(buffer, attrNode, valueOffset, attrValueEnd) {
    const pmsiNode = createTreeNode('PMSI Tunnel', valueOffset, attrValueEnd - valueOffset, '', []);
    attrNode.children.push(pmsiNode);

    if (attrValueEnd - valueOffset < 5) {
        pmsiNode.value = 'Truncated';
        addLeafNode(pmsiNode, 'Raw Value', valueOffset, attrValueEnd - valueOffset, formatHex(buffer, valueOffset, attrValueEnd));
        return;
    }

    const flags = buffer[valueOffset];
    const tunnelType = buffer[valueOffset + 1];
    const rawLabel = readUint24BE(buffer, valueOffset + 2);
    const label = formatMplsLabel(rawLabel);
    const tunnelTypeName = getPmsiTunnelTypeName(tunnelType);

    addLeafNode(pmsiNode, 'Flags', valueOffset, 1, `0x${flags.toString(16).padStart(2, '0')}`);
    addLeafNode(pmsiNode, 'Tunnel Type', valueOffset + 1, 1, `${tunnelType} (${tunnelTypeName})`);
    addLeafNode(pmsiNode, 'MPLS Label', valueOffset + 2, 3, label);
    if (valueOffset + 5 < attrValueEnd) {
        addLeafNode(
            pmsiNode,
            'Tunnel Identifier',
            valueOffset + 5,
            attrValueEnd - valueOffset - 5,
            formatHex(buffer, valueOffset + 5, attrValueEnd)
        );
    }

    pmsiNode.value = `${tunnelTypeName}, ${label}`;
}

function addTunnelEncapsulationNode(buffer, attrNode, valueOffset, attrValueEnd) {
    const encapNode = createTreeNode('Tunnel Encapsulation', valueOffset, attrValueEnd - valueOffset, '', []);
    attrNode.children.push(encapNode);

    let tlvOffset = valueOffset;
    let tlvIndex = 0;
    const summaries = [];
    while (tlvOffset < attrValueEnd) {
        if (tlvOffset + 4 > attrValueEnd) {
            encapNode.children.push(
                createTreeNode('Malformed TLV', tlvOffset, attrValueEnd - tlvOffset, 'Truncated tunnel TLV header')
            );
            break;
        }

        const tunnelType = buffer.readUInt16BE(tlvOffset);
        const tunnelTypeName = getBgpTunnelTypeName(tunnelType);
        const tlvLength = buffer.readUInt16BE(tlvOffset + 2);
        const valueStart = tlvOffset + 4;
        const valueEnd = Math.min(valueStart + tlvLength, attrValueEnd);
        const tlvNode = createTreeNode(
            `Tunnel TLV ${tlvIndex + 1}`,
            tlvOffset,
            Math.min(4 + tlvLength, attrValueEnd - tlvOffset),
            tunnelTypeName,
            []
        );
        encapNode.children.push(tlvNode);
        addLeafNode(tlvNode, 'Tunnel Type', tlvOffset, 2, `${tunnelType} (${tunnelTypeName})`);
        addLeafNode(tlvNode, 'Length', tlvOffset + 2, 2, tlvLength);
        if (valueStart < valueEnd) {
            addLeafNode(tlvNode, 'Value', valueStart, valueEnd - valueStart, formatHex(buffer, valueStart, valueEnd));
        }

        summaries.push(tunnelTypeName);
        if (valueStart + tlvLength > attrValueEnd) {
            tlvNode.value = `${tunnelTypeName} (length exceeds attribute)`;
            break;
        }
        tlvOffset = valueStart + tlvLength;
        tlvIndex += 1;
    }

    encapNode.value = summaries.join(', ');
}

/**
 * Parse BGP UPDATE message into a tree structure
 * @param {Buffer} buffer - Raw BGP packet buffer
 * @param {Object} parentNode - Parent tree node to attach the parsing results
 * @returns {number} The new offset after parsing the message
 */
function parseUpdateMessageTree(buffer, curOffset, parentNode, messageEndOffset) {
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

        const withdrawnRoutesEnd = Math.min(curOffset + withdrawnRoutesLength, messageEndOffset);
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

        const pathAttributesEnd = Math.min(curOffset + pathAttributesLength, messageEndOffset);

        while (curOffset < pathAttributesEnd) {
            const attrFlags = buffer[curOffset];
            const attrTypeCode = buffer[curOffset + 1];

            // Check if extended length bit is set
            const extendedLength = (attrFlags & BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH) !== 0;
            const attrLengthSize = extendedLength ? 2 : 1;
            const attrLength = extendedLength ? buffer.readUInt16BE(curOffset + 2) : buffer[curOffset + 2];

            const headerLength = 2 + attrLengthSize; // Flags + Type + Length field
            const valueOffset = curOffset + headerLength;
            const attrValueEnd = Math.min(valueOffset + attrLength, pathAttributesEnd);

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
                case BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES: {
                    addExtendedCommunitiesNode(buffer, attrNode, valueOffset, attrValueEnd);
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.ORIGINATOR_ID: {
                    const originatorId = ipv4BufferToString(buffer.subarray(valueOffset, valueOffset + 4), BgpConst.IP_HOST_LEN);
                    attrNode.children.push(createTreeNode('Originator ID', valueOffset, attrLength, originatorId, []));
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.CLUSTER_LIST: {
                    const clusterListNode = createTreeNode('Cluster List', valueOffset, attrLength, '', []);
                    attrNode.children.push(clusterListNode);
                    const clusters = [];
                    let clusterOffset = valueOffset;
                    let clusterIndex = 0;
                    while (clusterOffset + 4 <= attrValueEnd) {
                        const clusterId = ipv4BufferToString(
                            buffer.subarray(clusterOffset, clusterOffset + 4),
                            BgpConst.IP_HOST_LEN
                        );
                        clusters.push(clusterId);
                        addLeafNode(clusterListNode, `Cluster ID ${clusterIndex + 1}`, clusterOffset, 4, clusterId);
                        clusterOffset += 4;
                        clusterIndex += 1;
                    }
                    if (clusterOffset < attrValueEnd) {
                        addLeafNode(
                            clusterListNode,
                            'Trailing Data',
                            clusterOffset,
                            attrValueEnd - clusterOffset,
                            formatHex(buffer, clusterOffset, attrValueEnd)
                        );
                    }
                    clusterListNode.value = clusters.join(', ');
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.AS4_PATH: {
                    addAsPathNode(buffer, attrNode, valueOffset, attrValueEnd, 'AS4_PATH');
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.AS4_AGGREGATOR: {
                    addAggregatorNode(buffer, attrNode, valueOffset, attrValueEnd - valueOffset, 4, 'AS4 Aggregator');
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

                    // Next Hop Length
                    const nextHopLength = buffer[valueOffset + 3];
                    const lengthNode = {
                        name: 'Next Hop Length',
                        offset: valueOffset + 3,
                        length: 1,
                        value: nextHopLength,
                        children: []
                    };
                    mpReachNode.children.push(lengthNode);

                    const nextHopOffset = valueOffset + 4;
                    const nextHopEnd = Math.min(nextHopOffset + nextHopLength, attrValueEnd);
                    const nextHop = formatNextHop(buffer, nextHopOffset, nextHopEnd - nextHopOffset, afi, safi);
                    addLeafNode(mpReachNode, 'Next Hop', nextHopOffset, nextHopEnd - nextHopOffset, nextHop);

                    const reservedOffset = nextHopEnd;
                    if (reservedOffset < attrValueEnd) {
                        addLeafNode(mpReachNode, 'Reserved', reservedOffset, 1, buffer[reservedOffset]);
                    }

                    const nlriOffset = reservedOffset + 1;
                    if (nlriOffset < attrValueEnd) {
                        if (isSimpleIpNlri(afi, safi)) {
                            addSimpleNlriNodes(mpReachNode, buffer, nlriOffset, attrValueEnd, afi, 'NLRI');
                        } else {
                            addLeafNode(
                                mpReachNode,
                                'NLRI Data',
                                nlriOffset,
                                attrValueEnd - nlriOffset,
                                formatHex(buffer, nlriOffset, attrValueEnd)
                            );
                        }
                    }
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

                    if (attrLength > 3) {
                        const withdrawnOffset = valueOffset + 3;
                        if (isSimpleIpNlri(afi, safi)) {
                            addSimpleNlriNodes(mpUnreachNode, buffer, withdrawnOffset, attrValueEnd, afi, 'Withdrawn Routes');
                        } else {
                            addLeafNode(
                                mpUnreachNode,
                                'Withdrawn Routes Data',
                                withdrawnOffset,
                                attrValueEnd - withdrawnOffset,
                                formatHex(buffer, withdrawnOffset, attrValueEnd)
                            );
                        }
                    }
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.PMSI_TUNNEL: {
                    addPmsiTunnelNode(buffer, attrNode, valueOffset, attrValueEnd);
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.TUNNEL_ENCAPSULATION: {
                    addTunnelEncapsulationNode(buffer, attrNode, valueOffset, attrValueEnd);
                    break;
                }
                case BgpConst.BGP_PATH_ATTR.PATH_OTC: {
                    if (attrValueEnd - valueOffset >= 4) {
                        const otc = buffer.readUInt32BE(valueOffset);
                        addLeafNode(attrNode, 'Only-To-Customer AS', valueOffset, 4, otc);
                    } else {
                        addLeafNode(attrNode, 'Only-To-Customer AS', valueOffset, attrValueEnd - valueOffset, 'Truncated');
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
    const nlriLength = messageEndOffset - curOffset;
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
        while (curOffset < messageEndOffset) {
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
function parseNotificationMessageTree(buffer, curOffset, parentNode, messageEndOffset) {
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
    const dataLength = messageEndOffset - curOffset;
    if (dataLength > 0) {
        const dataNode = {
            name: 'Data',
            offset: curOffset,
            length: dataLength,
            value: buffer.subarray(curOffset, messageEndOffset).toString('hex'),
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
function parseRouteRefreshMessageTree(buffer, curOffset, parentNode, messageEndOffset) {
    if (curOffset + 4 > messageEndOffset) {
        parentNode.children.push(createTreeNode('Malformed Route Refresh', curOffset, messageEndOffset - curOffset, 'Truncated'));
        return messageEndOffset;
    }

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
