const crypto = require('node:crypto');
const ipaddr = require('ipaddr.js');

const TCP_AO_FORWARD_MAGIC = Buffer.from('NNAO', 'ascii');
const TCP_AO_FORWARD_VERSION = 1;
const TCP_AO_FORWARD_HEADER_BYTES = 80;
const TCP_AO_FORWARD_CAPABILITY_BYTES = 32;
const TCP_AO_FORWARD_HEADER_TIMEOUT_MS = 2000;
const TCP_AO_UNIX_PATH_MAX_BYTES = 107;

function invalidHeader(message) {
    const error = new Error(message);
    error.code = 'TCP_AO_FORWARD_HEADER_INVALID';
    return error;
}

function normalizePort(value, field) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw invalidHeader(`${field}无效`);
    }
    return port;
}

function normalizeCapability(value) {
    if (!Buffer.isBuffer(value) || value.length !== TCP_AO_FORWARD_CAPABILITY_BYTES) {
        throw invalidHeader('TCP-AO内部通道能力令牌长度无效');
    }
    return value;
}

function encodeAddress(address, family) {
    let parsed;
    try {
        parsed = ipaddr.parse(String(address || ''));
    } catch (_error) {
        throw invalidHeader('TCP-AO转发地址无效');
    }
    const expectedKind = family === 4 ? 'ipv4' : 'ipv6';
    if (parsed.kind() !== expectedKind || (family === 6 && parsed.isIPv4MappedAddress?.())) {
        throw invalidHeader('TCP-AO转发地址族不匹配');
    }
    const encoded = Buffer.alloc(16);
    const bytes = Buffer.from(parsed.toByteArray());
    bytes.copy(encoded, family === 4 ? 12 : 0);
    return encoded;
}

function decodeAddress(bytes, family) {
    if (family === 4) {
        for (let index = 0; index < 12; index += 1) {
            if (bytes[index] !== 0) throw invalidHeader('TCP-AO IPv4地址填充无效');
        }
        return ipaddr.fromByteArray(Array.from(bytes.subarray(12))).toString();
    }
    const parsed = ipaddr.fromByteArray(Array.from(bytes));
    if (parsed.isIPv4MappedAddress?.()) throw invalidHeader('TCP-AO转发头禁止IPv4映射IPv6地址');
    return parsed.toString();
}

function encodeTcpAoForwardHeader({ family, remoteAddress, remotePort, localAddress, localPort, capability }) {
    if (family !== 4 && family !== 6) throw invalidHeader('TCP-AO转发地址族无效');
    const token = normalizeCapability(capability);
    const header = Buffer.alloc(TCP_AO_FORWARD_HEADER_BYTES);
    TCP_AO_FORWARD_MAGIC.copy(header, 0);
    header[4] = TCP_AO_FORWARD_VERSION;
    header[5] = family;
    header.writeUInt16BE(TCP_AO_FORWARD_HEADER_BYTES, 6);
    header.writeUInt16BE(normalizePort(remotePort, 'TCP-AO远端端口'), 8);
    header.writeUInt16BE(normalizePort(localPort, 'TCP-AO本地端口'), 10);
    encodeAddress(remoteAddress, family).copy(header, 16);
    encodeAddress(localAddress, family).copy(header, 32);
    token.copy(header, 48);
    return header;
}

function decodeTcpAoForwardHeader(header, expectedCapability) {
    const token = normalizeCapability(expectedCapability);
    if (!Buffer.isBuffer(header) || header.length !== TCP_AO_FORWARD_HEADER_BYTES) {
        throw invalidHeader('TCP-AO转发头长度无效');
    }
    if (!header.subarray(0, 4).equals(TCP_AO_FORWARD_MAGIC)) throw invalidHeader('TCP-AO转发头魔数无效');
    if (header[4] !== TCP_AO_FORWARD_VERSION) throw invalidHeader('TCP-AO转发头版本无效');
    const family = header[5];
    if (family !== 4 && family !== 6) throw invalidHeader('TCP-AO转发地址族无效');
    if (header.readUInt16BE(6) !== TCP_AO_FORWARD_HEADER_BYTES) throw invalidHeader('TCP-AO转发头声明长度无效');
    if (header.readUInt32BE(12) !== 0) throw invalidHeader('TCP-AO转发头保留字段必须为零');
    const receivedCapability = header.subarray(48, 80);
    if (!crypto.timingSafeEqual(receivedCapability, token)) throw invalidHeader('TCP-AO内部通道认证失败');

    return {
        family,
        remoteAddress: decodeAddress(header.subarray(16, 32), family),
        remotePort: normalizePort(header.readUInt16BE(8), 'TCP-AO远端端口'),
        localAddress: decodeAddress(header.subarray(32, 48), family),
        localPort: normalizePort(header.readUInt16BE(10), 'TCP-AO本地端口')
    };
}

module.exports = {
    TCP_AO_FORWARD_MAGIC,
    TCP_AO_FORWARD_VERSION,
    TCP_AO_FORWARD_HEADER_BYTES,
    TCP_AO_FORWARD_CAPABILITY_BYTES,
    TCP_AO_FORWARD_HEADER_TIMEOUT_MS,
    TCP_AO_UNIX_PATH_MAX_BYTES,
    encodeTcpAoForwardHeader,
    decodeTcpAoForwardHeader
};
