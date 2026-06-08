const ipaddr = require('ipaddr.js');
const BgpConst = require('../const/bgpConst');

function normalizeRouteCount(routeCnt) {
    const count = Number(routeCnt);
    if (!Number.isFinite(count) || count <= 0) {
        return 0;
    }

    return Math.floor(count);
}

/**
 * Iterate generated IP networks without materializing the full list.
 * @param {number} routeType - IP_TYPE.IPV4 or IP_TYPE.IPV6
 * @param {string} routeIp - Starting IP address
 * @param {number} routeMask - Network mask
 * @param {number} routeCnt - Number of routes to generate
 * @param {Function} callback - Called with ({ ip, mask }, index)
 * @returns {number} Generated route count
 */
function forEachGeneratedRouteIp(routeType, routeIp, routeMask, routeCnt, callback) {
    const count = normalizeRouteCount(routeCnt);
    if (count === 0 || typeof callback !== 'function') {
        return 0;
    }

    let generatedCount = 0;

    if (routeType === BgpConst.IP_TYPE.IPV4) {
        const baseAddress = ipaddr.parse(routeIp);
        const baseBytes = baseAddress.toByteArray();
        let baseInt = (baseBytes[0] << 24) | (baseBytes[1] << 16) | (baseBytes[2] << 8) | baseBytes[3];

        const step = routeMask === 32 ? 1 : Math.pow(2, 32 - routeMask);

        for (let i = 0; i < count; i++) {
            const currentInt = baseInt + i * step;
            const bytes = [
                (currentInt >> 24) & 0xff,
                (currentInt >> 16) & 0xff,
                (currentInt >> 8) & 0xff,
                currentInt & 0xff
            ];
            const ip = ipaddr.fromByteArray(bytes);
            const networkAddress = ipaddr.IPv4.networkAddressFromCIDR(`${ip}/${routeMask}`);
            callback({ ip: networkAddress.toString(), mask: routeMask }, i);
            generatedCount += 1;
        }
    } else if (routeType === BgpConst.IP_TYPE.IPV6) {
        const baseAddress = ipaddr.parse(routeIp);
        const baseBytes = baseAddress.toByteArray(); // 16 bytes
        let baseBigInt = BigInt(0);
        for (let i = 0; i < 16; i++) {
            baseBigInt = (baseBigInt << 8n) + BigInt(baseBytes[i]);
        }

        const step = routeMask === 128 ? 1n : 1n << BigInt(128 - routeMask);

        for (let i = 0n; i < BigInt(count); i++) {
            const currentBigInt = baseBigInt + i * step;
            const bytes = [];
            for (let j = 15; j >= 0; j--) {
                bytes[j] = Number((currentBigInt >> BigInt((15 - j) * 8)) & 0xffn);
            }
            const ip = ipaddr.fromByteArray(bytes);
            const networkAddress = ipaddr.IPv6.networkAddressFromCIDR(`${ip}/${routeMask}`);
            const index = Number(i);
            callback({ ip: networkAddress.toString(), mask: routeMask }, index);
            generatedCount += 1;
        }
    }

    return generatedCount;
}

/**
 * Generate a list of IP networks based on route type, IP, mask and count
 * @param {number} routeType - IP_TYPE.IPV4 or IP_TYPE.IPV6
 * @param {string} routeIp - Starting IP address
 * @param {number} routeMask - Network mask
 * @param {number} routeCnt - Number of routes to generate
 * @returns {Array} Array of objects containing IP and mask
 */
function genRouteIps(routeType, routeIp, routeMask, routeCnt) {
    const routes = [];
    forEachGeneratedRouteIp(routeType, routeIp, routeMask, routeCnt, route => {
        routes.push(route);
    });

    return routes;
}

/**
 * 将一个 16 位无符号整数转换为两个字节（Big Endian）
 * @param {number} value - 0~65535
 * @returns {number[]} - 两个字节的数组 [high, low]
 */
function writeUInt16(value) {
    return [(value >> 8) & 0xff, value & 0xff];
}

/**
 * 将一个 32 位无符号整数转换为四个字节（Big Endian）
 * @param {number} value - 0~2^32-1
 * @returns {number[]} - 四个字节的数组
 */
function writeUInt32(value) {
    return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * 通用 IP 转字节（支持 IPv4 和 IPv6）
 * @param {string} ip - IP 地址字符串
 * @returns {number[]} - IPv4 返回 4 字节，IPv6 返回 16 字节
 */
function ipToBytes(ip) {
    const addr = ipaddr.parse(ip);
    return addr.toByteArray();
}

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
                assigned = buffer.readUInt32BE(6);
            }
            return `RT ${admin}:${assigned}`;

        case BgpConst.EXT_COMMUNITY_SUB_TYPE.SOO:
            if (ipFormat === BgpConst.EXT_COMMUNITY_TYPE.IP) {
                admin = Array.from(buffer.slice(2, 6)).join('.');
                assigned = buffer.readUInt16BE(6);
            } else if (ipFormat === BgpConst.EXT_COMMUNITY_TYPE.AS2) {
                admin = buffer.readUInt16BE(2);
                assigned = buffer.readUInt16BE(4);
            } else {
                admin = buffer.readUInt32BE(2);
                assigned = buffer.readUInt16BE(6);
            }
            return `SOO ${admin}:${assigned}`;

        default:
            return `unknown(${ipFormat}|${subType})`;
    }
}

function ipv4BufferToString(buffer, length) {
    const fullBytes = Math.floor(length / 8);
    const remainingBits = length % 8;

    const ipBuffer = Buffer.alloc(4);
    buffer.copy(ipBuffer, 0, 0, buffer.length);

    if (remainingBits > 0 && fullBytes < 4) {
        const mask = 0xff & (0xff << (8 - remainingBits));
        ipBuffer[fullBytes] &= mask;
    }

    return Array.from(ipBuffer).join('.');
}

function ipv6BufferToString(buffer, length) {
    const fullBytes = Math.floor(length / 8);
    const remainingBits = length % 8;

    const ipBuffer = Buffer.alloc(16);
    buffer.copy(ipBuffer, 0, 0, buffer.length);

    if (remainingBits > 0 && fullBytes < 16) {
        const mask = 0xff & (0xff << (8 - remainingBits));
        ipBuffer[fullBytes] &= mask;
    }

    const segments = [];
    for (let i = 0; i < 16; i += 2) {
        segments.push(ipBuffer.readUInt16BE(i).toString(16));
    }

    // 简化为 "::" 格式
    return segments
        .join(':')
        .replace(/(^|:)0(:0)+(:|$)/, '::')
        .replace(/:{3,}/g, '::');
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

// 判断地址是ipv4还是ipv6
function getIpType(ip) {
    if (ipaddr.IPv4.isIPv4(ip)) {
        return BgpConst.IP_TYPE.IPV4;
    } else if (ipaddr.IPv6.isIPv6(ip)) {
        return BgpConst.IP_TYPE.IPV6;
    }

    return null;
}

/**
 * Get IP type name from code
 * @param {Number} ipType - IP type code
 * @returns {String} IP type name
 */
function getIpTypeName(ipType) {
    return ipType === BgpConst.IP_TYPE.IPV4 ? 'IPv4' : 'IPv6';
}

function getNetworkAddress(ip, prefixLen) {
    const parsedIp = ipaddr.parse(ip);

    if (parsedIp.kind() === 'ipv4') {
        const ipInt = parsedIp.toByteArray().reduce((acc, byte) => (acc << 8) + byte, 0);
        const mask = ~(2 ** (32 - prefixLen) - 1) >>> 0;
        const networkInt = ipInt & mask;
        const bytes = [
            (networkInt >>> 24) & 0xff,
            (networkInt >>> 16) & 0xff,
            (networkInt >>> 8) & 0xff,
            networkInt & 0xff
        ];
        return `${bytes.join('.')}/${prefixLen}`;
    } else if (parsedIp.kind() === 'ipv6') {
        const parts = parsedIp
            .toNormalizedString()
            .split(':')
            .map(p => parseInt(p || '0', 16));
        const fullBits = parts.flatMap(part => [(part >> 8) & 0xff, part & 0xff]);

        const bitLen = 128;
        const maskBits = new Array(bitLen).fill(0).map((_, i) => (i < prefixLen ? 1 : 0));
        const networkBits = fullBits
            .flatMap(byte => [
                (byte >> 7) & 1,
                (byte >> 6) & 1,
                (byte >> 5) & 1,
                (byte >> 4) & 1,
                (byte >> 3) & 1,
                (byte >> 2) & 1,
                (byte >> 1) & 1,
                byte & 1
            ])
            .map((b, i) => b & maskBits[i]);

        const newBytes = [];
        for (let i = 0; i < bitLen; i += 8) {
            let byte = 0;
            for (let j = 0; j < 8; j++) {
                byte = (byte << 1) | networkBits[i + j];
            }
            newBytes.push(byte);
        }

        const addr = ipaddr.fromByteArray(newBytes);
        return `${addr.toNormalizedString()}/${prefixLen}`;
    }

    return null;
}

module.exports = {
    genRouteIps,
    forEachGeneratedRouteIp,
    writeUInt16,
    writeUInt32,
    ipToBytes,
    rdBufferToString,
    extCommunitiesBufferToString,
    getIpType,
    ipv4BufferToString,
    ipv6BufferToString,
    rdStringToBytes,
    extCommunitiesToBytes,
    getIpTypeName,
    getNetworkAddress
};
