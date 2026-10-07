const ipaddr = require('ipaddr.js');
const BgpConst = require('../../const/bgpConst');

/**
 * 将 8 字节 RD Buffer 转换为字符串形式
 * 支持三种格式：Type 0, Type 1, Type 2
 * @param {Buffer} buffer - 长度为 8 的 Buffer
 * @returns {string} - 可读的 RD 字符串（如 '65000:100'）
 */
function rdBufferToString(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length !== 8) {
        throw new Error('RD must be a Buffer of length 8');
    }

    const type = buffer.readUInt16BE(0); // 前2字节是 Type
    let admin, assigned;

    switch (type) {
        case BgpConst.RD_TYPE.AS2:
            admin = buffer.readUInt16BE(2);
            assigned = buffer.readUInt32BE(4);
            return `${admin}:${assigned}`;

        case BgpConst.RD_TYPE.IP:
            admin = Array.from(buffer.slice(2, 6)).join('.');
            assigned = buffer.readUInt16BE(6);
            return `${admin}:${assigned}`;

        case BgpConst.RD_TYPE.AS4:
            admin = buffer.readUInt32BE(2);
            assigned = buffer.readUInt16BE(6);
            return `${admin}:${assigned}`;

        default:
            return `unknown(${type})`;
    }
}

/**
 * 将 8 字节扩展团体 Buffer 转换为字符串形式
 * 支持三种格式：Type 0, Type 1, Type 2
 * @param {Buffer} buffer - 长度为 8 的 Buffer
 * @returns {string} - 可读的扩展团体字符串（如 '65000:100'）
 */
function extCommunitiesBufferToString(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length !== 8) {
        throw new Error('ExtCommunities must be a Buffer of length 8');
    }

    const ipFormat = buffer.readUint8(0); // 前2字节是 Type
    const subType = buffer.readUint8(1); // 前2字节是 Type
    let admin, assigned;

    if (ipFormat === 0x43 && subType === 0x00) {
        const state = buffer.readUint8(7);
        const stateName =
            {
                0: 'Valid',
                1: 'NotFound',
                2: 'Invalid'
            }[state] || `Unknown(${state})`;
        return `Origin Validation State: ${stateName}`;
    }

    switch (subType) {
        case BgpConst.EXT_COMMUNITY_SUB_TYPE.RT:
            if (ipFormat === BgpConst.EXT_COMMUNITY_TYPE.IP) {
                admin = Array.from(buffer.slice(2, 6)).join('.');
                assigned = buffer.readUInt16BE(6);
            } else if (ipFormat === BgpConst.EXT_COMMUNITY_TYPE.AS2) {
                admin = buffer.readUInt16BE(2);
                assigned = buffer.readUInt32BE(4);
            } else {
                admin = buffer.readUInt32BE(2);
                assigned = buffer.readUInt16BE(6);
            }
            return `RT ${admin}:${assigned}`;

        case BgpConst.EXT_COMMUNITY_SUB_TYPE.SOO:
            if (ipFormat === BgpConst.EXT_COMMUNITY_TYPE.IP) {
                admin = Array.from(buffer.slice(2, 6)).join('.');
                assigned = buffer.readUInt16BE(6);
            } else if (ipFormat === BgpConst.EXT_COMMUNITY_TYPE.AS2) {
                admin = buffer.readUInt16BE(2);
                assigned = buffer.readUInt32BE(4);
            } else {
                admin = buffer.readUInt32BE(2);
                assigned = buffer.readUInt16BE(6);
            }
            return `SOO ${admin}:${assigned}`;

        default:
            return `unknown(${ipFormat}|${subType})`;
    }
}

/**
 * 将 RD 字符串转换为 8 字节 Buffer
 * 支持格式:
 * - Type 1: IP:Assigned (e.g., 1.1.1.1:100)
 * - Type 0: ASN(2byte):Assigned(4byte) (e.g., 65000:100000)
 * - Type 2: ASN(4byte):Assigned(2byte) (e.g., 655360:100)
 */
function rdStringToBytes(rdStr) {
    if (!rdStr || typeof rdStr !== 'string') {
        return Buffer.alloc(8); // Return empty/zero RD on error
    }

    const parts = rdStr.split(':');
    if (parts.length !== 2) {
        return Buffer.alloc(8);
    }

    const buffer = Buffer.alloc(8);

    if (parts[0].includes('.') && ipaddr.IPv4.isValid(parts[0])) {
        buffer.writeUInt16BE(BgpConst.RD_TYPE.IP, 0);
        const ipBytes = ipaddr.parse(parts[0]).toByteArray();
        buffer.set(ipBytes, 2);
        buffer.writeUInt16BE(parseInt(parts[1]), 6);
    } else {
        const admin = parseInt(parts[0]);
        const assigned = parseInt(parts[1]);

        if (admin > 0xffff) {
            buffer.writeUInt16BE(BgpConst.RD_TYPE.AS4, 0);
            buffer.writeUInt32BE(admin, 2);
            buffer.writeUInt16BE(assigned, 6);
        } else {
            buffer.writeUInt16BE(BgpConst.RD_TYPE.AS2, 0);
            buffer.writeUInt16BE(admin, 2);
            buffer.writeUInt32BE(assigned, 4);
        }
    }
    return buffer;
}

/**
 * 将扩展团体属性转换为 8 字节 Buffer
 * 支持格式:
 * - Type 1: IP:Assigned (e.g., 1.1.1.1:100)
 * - Type 0: ASN(2byte):Assigned(4byte) (e.g., 65000:100000)
 * - Type 2: ASN(4byte):Assigned(2byte) (e.g., 655360:100)
 */
function extCommunitiesToBytes(type, communities) {
    if (!communities || typeof communities !== 'string') {
        return Buffer.alloc(8); // Return empty/zero RD on error
    }

    const parts = communities.split(':');
    if (parts.length !== 2) {
        return Buffer.alloc(8);
    }

    const buffer = Buffer.alloc(8);

    if (parts[0].includes('.') && ipaddr.IPv4.isValid(parts[0])) {
        buffer.writeUint8(BgpConst.EXT_COMMUNITY_TYPE.IP, 0); // ip
        buffer.writeUint8(type, 1); // Type
        const ipBytes = ipaddr.parse(parts[0]).toByteArray();
        buffer.set(ipBytes, 2);
        buffer.writeUInt16BE(parseInt(parts[1]), 6);
    } else {
        const admin = parseInt(parts[0]);
        const assigned = parseInt(parts[1]);

        if (admin > 0xffff) {
            buffer.writeUint8(BgpConst.EXT_COMMUNITY_TYPE.AS4, 0); // as4
            buffer.writeUint8(type, 1); // Type
            buffer.writeUInt32BE(admin, 2);
            buffer.writeUInt16BE(assigned, 6);
        } else {
            buffer.writeUint8(BgpConst.EXT_COMMUNITY_TYPE.AS2, 0); // as2
            buffer.writeUint8(type, 1); // Type
            buffer.writeUInt16BE(admin, 2);
            buffer.writeUInt32BE(assigned, 4);
        }
    }
    return buffer;
}

module.exports = { rdBufferToString, extCommunitiesBufferToString, rdStringToBytes, extCommunitiesToBytes };
