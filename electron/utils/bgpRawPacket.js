const BgpConst = require('../const/bgpConst');

const MIN_PACKET_LENGTH = {
    [BgpConst.BGP_PACKET_TYPE.OPEN]: 29,
    [BgpConst.BGP_PACKET_TYPE.UPDATE]: 23,
    [BgpConst.BGP_PACKET_TYPE.NOTIFICATION]: 21,
    [BgpConst.BGP_PACKET_TYPE.KEEPALIVE]: 19,
    [BgpConst.BGP_PACKET_TYPE.ROUTE_REFRESH]: 23
};

/**
 * Validate framing without interpreting or rebuilding the supplied BGP body.
 * Multiple complete messages may be supplied in their intended wire order.
 */
function parseBgpRawPacket(packetHex) {
    if (typeof packetHex !== 'string' || !packetHex.trim()) {
        throw new Error('请输入 BGP 原始报文的十六进制内容');
    }
    if (/[^0-9a-f\s]/i.test(packetHex)) {
        throw new Error('原始报文只能包含十六进制字符和空白，不支持 0x 前缀或抓包偏移量');
    }

    const hex = packetHex.replace(/\s/g, '');
    if (hex.length % 2 !== 0) {
        throw new Error('十六进制字符数必须为偶数，每两个字符表示一个字节');
    }

    // Buffer.from(hex, 'hex') silently truncates malformed input; validate first.
    const buffer = Buffer.from(hex, 'hex');
    const packets = [];
    let offset = 0;
    while (offset < buffer.length) {
        const packetLabel = `第 ${packets.length + 1} 条 BGP 报文`;
        if (buffer.length - offset < BgpConst.BGP_HEAD_LEN) {
            throw new Error(`${packetLabel}头部不完整，至少需要 ${BgpConst.BGP_HEAD_LEN} 字节`);
        }
        for (let index = 0; index < BgpConst.BGP_MARKER_LEN; index += 1) {
            if (buffer[offset + index] !== 0xff) {
                throw new Error(`${packetLabel}的 Marker 必须为 16 字节 FF`);
            }
        }

        const length = buffer.readUInt16BE(offset + BgpConst.BGP_MARKER_LEN);
        const type = buffer[offset + BgpConst.BGP_MARKER_LEN + 2];
        if (length < BgpConst.BGP_HEAD_LEN || length > BgpConst.BGP_MAX_PKT_SIZE) {
            throw new Error(`${packetLabel}的 Length 必须在 19 至 ${BgpConst.BGP_MAX_PKT_SIZE} 字节之间`);
        }
        if (!Object.prototype.hasOwnProperty.call(MIN_PACKET_LENGTH, type)) {
            throw new Error(`${packetLabel}的 Type ${type} 无效，仅支持 1 至 5`);
        }
        if (length < MIN_PACKET_LENGTH[type]) {
            throw new Error(`${packetLabel}类型 ${type} 的长度至少为 ${MIN_PACKET_LENGTH[type]} 字节`);
        }
        if (type === BgpConst.BGP_PACKET_TYPE.KEEPALIVE && length !== BgpConst.BGP_HEAD_LEN) {
            throw new Error(`${packetLabel}为 KEEPALIVE，长度必须为 19 字节`);
        }
        if (length > buffer.length - offset) {
            throw new Error(`${packetLabel}不完整：Length 为 ${length} 字节，剩余 ${buffer.length - offset} 字节`);
        }

        packets.push({ offset, length, type });
        offset += length;
    }

    return { buffer, packets, byteLength: buffer.length, packetCount: packets.length };
}

module.exports = { parseBgpRawPacket };
