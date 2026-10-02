const ipaddr = require('ipaddr.js');
const BgpConst = require('../const/bgpConst');
const BgpPeer = require('../worker/bgp/bgpPeer');

const TABLE_DUMP_V2 = 13;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

function unsigned(value, max, name) {
    const number = Number(value);
    if (
        value === undefined ||
        value === null ||
        value === '' ||
        !Number.isInteger(number) ||
        number < 0 ||
        number > max
    )
        throw new Error(`${name}必须为0~${max}的整数`);
    return number;
}

function address(value, family, name) {
    let result;
    try {
        result = ipaddr.parse(String(value));
    } catch (_error) {
        throw new Error(`${name}必须为有效IP地址`);
    }
    if (family && result.kind() !== family) throw new Error(`${name}必须为${family === 'ipv4' ? 'IPv4' : 'IPv6'}地址`);
    return result;
}

function uint16(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(value);
    return buffer;
}

function uint32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value);
    return buffer;
}

function record(timestamp, subtype, body) {
    const header = Buffer.alloc(12);
    header.writeUInt32BE(timestamp, 0);
    header.writeUInt16BE(TABLE_DUMP_V2, 4);
    header.writeUInt16BE(subtype, 6);
    header.writeUInt32BE(body.length, 8);
    return Buffer.concat([header, body]);
}

// RFC 6396 §4.3.4 stores only [next-hop length, next-hop bytes] for
// MP_REACH_NLRI. Preserve every physical attribute, including custom ones.
function compactMpAttributes(peer, attributes) {
    const result = [];
    for (let offset = 0; offset < attributes.length; ) {
        if (attributes.length - offset < 3) throw new Error('MRT路径属性头不完整');
        const flags = attributes[offset];
        const type = attributes[offset + 1];
        const extended = Boolean(flags & BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH);
        const headerLength = extended ? 4 : 3;
        if (attributes.length - offset < headerLength) throw new Error('MRT路径属性长度字段不完整');
        const length = extended ? attributes.readUInt16BE(offset + 2) : attributes[offset + 2];
        const end = offset + headerLength + length;
        if (end > attributes.length) throw new Error('MRT路径属性值长度不完整');
        const value = attributes.subarray(offset + headerLength, end);
        if (type === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI) {
            let compact;
            if (value.length && value[0] === value.length - 1) compact = value;
            else {
                if (value.length < 5 || value.length < 5 + value[3]) throw new Error('MRT MP_REACH_NLRI下一跳长度无效');
                compact = Buffer.concat([value.subarray(3, 4), value.subarray(4, 4 + value[3])]);
            }
            result.push(Buffer.from(peer.buildPathAttribute(type, flags, compact)));
        } else result.push(attributes.subarray(offset, end));
        offset = end;
    }
    return Buffer.concat(result);
}

/** Encode saved routes, independently of live peers and their negotiated capabilities. */
function createMrtEncoder({
    addressFamily,
    routerId,
    localAs,
    localIp,
    timestamp = Math.floor(Date.now() / 1000),
    viewName = '',
    addPath = true
} = {}) {
    const family = Number(addressFamily);
    const definitions = {
        [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC]: { afi: 1, safi: 1, subtype: addPath ? 8 : 2 },
        [BgpConst.BGP_ADDR_FAMILY.IPV6_UNC]: { afi: 2, safi: 1, subtype: addPath ? 10 : 4 },
        [BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST]: { afi: 1, safi: 4, subtype: addPath ? 12 : 6 }
    };
    const definition = definitions[family];
    if (!definition) throw new Error('MRT导出仅支持IPv4/IPv6 Unicast和IPv4 Label地址族');
    if (typeof addPath !== 'boolean') throw new Error('MRT ADD-PATH选项必须为布尔值');
    const bgpId = Buffer.from(address(routerId, 'ipv4', 'Router ID').toByteArray());
    const peerAddress = address(localIp, null, '本地地址');
    const peerBytes = Buffer.from(peerAddress.toByteArray());
    const asn = unsigned(localAs, MAX_UINT32, '本地AS');
    const time = unsigned(timestamp, MAX_UINT32, 'MRT时间戳');
    const name = Buffer.from(String(viewName), 'utf8');
    if (name.length > MAX_UINT16) throw new Error('MRT View Name不能超过65535字节');

    const instance = { ...definition, getRouteAttr: route => route.routeAttr };
    const peer = new BgpPeer(
        {
            localIp: peerAddress.toString(),
            routerId: address(routerId, 'ipv4', 'Router ID').toString(),
            localAs: asn,
            // The synthetic context encodes the saved RIB rather than a peer's
            // outbound policy. Always retain stored SRv6 and four-byte ASNs.
            peerIp: '::',
            peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP,
            localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS,
            processCustomPkt: value => Buffer.from(String(value).replace(/\s+/g, '').replace(/0x/g, ''), 'hex')
        },
        instance,
        { sendSrv6PrefixSid: true }
    );

    return {
        peerIndexTable() {
            const peerType = 0x02 | (peerAddress.kind() === 'ipv6' ? 0x01 : 0);
            return record(
                time,
                1,
                Buffer.concat([
                    bgpId,
                    uint16(name.length),
                    name,
                    uint16(1),
                    Buffer.from([peerType]),
                    bgpId,
                    peerBytes,
                    uint32(asn)
                ])
            );
        },

        encodeRoute(row, { sequence = 0, originatedTime } = {}) {
            if (!row || !row.routeAttr || typeof row.routeAttr !== 'object')
                throw new Error('MRT路由缺少已保存路径属性');
            const source = address(row.ip, definition.afi === 1 ? 'ipv4' : 'ipv6', '路由前缀');
            const mask = unsigned(row.mask, definition.afi === 1 ? 32 : 128, '路由前缀长度');
            const network = Buffer.from(source.toByteArray());
            const prefixLength = Math.ceil(mask / 8);
            if (mask % 8) network[prefixLength - 1] &= (0xff << (8 - (mask % 8))) & 0xff;
            network.fill(0, prefixLength);
            const route = {
                ...row,
                ip: ipaddr.fromByteArray(Array.from(network)).toString(),
                mask,
                pathId: unsigned(row.pathId ?? 0, MAX_UINT32, 'Path ID')
            };
            const seq = unsigned(sequence, MAX_UINT32, 'MRT序列号');
            const origin = unsigned(
                originatedTime === undefined
                    ? row.createdAtMs === undefined || row.createdAtMs === null
                        ? time
                        : Math.floor(Number(row.createdAtMs) / 1000)
                    : originatedTime,
                MAX_UINT32,
                '路由生成时间'
            );
            const includeMp =
                definition.afi === 2 ||
                definition.safi === 4 ||
                row.nlriEncoding === 'mpReach' ||
                (row.mpNextHop !== null && row.mpNextHop !== undefined);
            const encoded = Buffer.from(peer.buildRoutePathAttributes(route, { includeIpv4NextHop: !includeMp }));
            const attrs = [compactMpAttributes(peer, encoded)];
            if (includeMp) {
                const nextHop = peer.getMpReachNextHopBytes(route);
                attrs.push(
                    Buffer.from(
                        peer.buildPathAttribute(
                            BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI,
                            BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL,
                            [nextHop.length, ...nextHop]
                        )
                    )
                );
            }
            const attributes = Buffer.concat(attrs);
            if (attributes.length > MAX_UINT16) throw new Error('MRT路径属性总长度不能超过65535字节');
            const entry = Buffer.concat([
                uint16(0),
                uint32(origin),
                ...(addPath && definition.safi === 1 ? [uint32(route.pathId)] : []),
                uint16(attributes.length),
                attributes
            ]);
            const nlri =
                definition.safi === 4
                    ? Buffer.concat([
                          uint16(definition.afi),
                          Buffer.from([definition.safi]),
                          peer.buildLabeledUnicastNlri(route, addPath)
                      ])
                    : Buffer.concat([Buffer.from([mask]), network.subarray(0, prefixLength)]);
            return record(time, definition.subtype, Buffer.concat([uint32(seq), nlri, uint16(1), entry]));
        }
    };
}

module.exports = { createMrtEncoder };
