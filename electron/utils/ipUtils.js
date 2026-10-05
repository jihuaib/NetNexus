const ipaddr = require('ipaddr.js');

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

module.exports = { writeUInt16, writeUInt32, ipToBytes, ipv4BufferToString, ipv6BufferToString, getNetworkAddress };
