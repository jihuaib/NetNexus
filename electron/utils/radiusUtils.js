const crypto = require('crypto');
const ipaddr = require('ipaddr.js');
const RadiusConst = require('../const/radiusConst');

const {
    RADIUS_CODES,
    RADIUS_ATTRIBUTES,
    RADIUS_SERVICE_TYPES,
    RADIUS_FRAMED_PROTOCOLS,
    RADIUS_ACCT_STATUS_TYPES,
    RADIUS_ERROR_CAUSES
} = RadiusConst;

const MAX_PACKET_LENGTH = 4096;
const MIN_PACKET_LENGTH = 20;
const MAX_ATTRIBUTE_VALUE_LENGTH = 253;

const CODE_NAMES = Object.fromEntries(Object.entries(RADIUS_CODES).map(([name, value]) => [value, name]));
const ATTRIBUTE_NAMES = Object.fromEntries(Object.entries(RADIUS_ATTRIBUTES).map(([name, value]) => [value, name]));

function md5(parts) {
    const hash = crypto.createHash('md5');
    parts.forEach(part => hash.update(part));
    return hash.digest();
}

function hmacMd5(key, data) {
    return crypto.createHmac('md5', key).update(data).digest();
}

function safeEqual(a, b) {
    if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

function normalizeSecret(secret) {
    const value = String(secret || '');
    if (!value) {
        throw new Error('RADIUS shared secret cannot be empty');
    }
    return Buffer.from(value, 'utf8');
}

function stringToBuffer(value) {
    return Buffer.from(String(value ?? ''), 'utf8');
}

function numberToBuffer(value) {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0 || num > 0xffffffff) {
        throw new Error(`RADIUS integer attribute out of range: ${value}`);
    }
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(num >>> 0, 0);
    return buffer;
}

function ipToBuffer(ip) {
    const parts = String(ip || '').split('.');
    if (parts.length !== 4) {
        throw new Error(`Invalid IPv4 address: ${ip}`);
    }
    const octets = parts.map(part => Number(part));
    if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        throw new Error(`Invalid IPv4 address: ${ip}`);
    }
    return Buffer.from(octets);
}

function bufferToIp(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length !== 4) {
        return '';
    }
    return Array.from(buffer).join('.');
}

function ipv6ToBuffer(ip) {
    let parsed;
    try {
        parsed = ipaddr.parse(String(ip || ''));
    } catch (_) {
        throw new Error(`Invalid IPv6 address: ${ip}`);
    }
    if (parsed.kind() !== 'ipv6') {
        throw new Error(`Invalid IPv6 address: ${ip}`);
    }
    return Buffer.from(parsed.toByteArray());
}

function bufferToIpv6(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length !== 16) {
        return '';
    }
    try {
        return ipaddr.fromByteArray(Array.from(buffer)).toString().toLowerCase();
    } catch (_) {
        return '';
    }
}

function normalizeAddress(address) {
    if (!address) {
        return '';
    }
    const value = String(address)
        .trim()
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split('%')[0];
    try {
        const parsed = ipaddr.parse(value);
        if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
            return parsed.toIPv4Address().toString();
        }
        return parsed.toString().toLowerCase();
    } catch (_) {
        return value.replace(/^::ffff:/, '').toLowerCase();
    }
}

function encodeAttribute(type, value) {
    const attrType = Number(type);
    if (!Number.isInteger(attrType) || attrType < 1 || attrType > 255) {
        throw new Error(`Invalid RADIUS attribute type: ${type}`);
    }
    const attrValue = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
    if (attrValue.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
        throw new Error(`RADIUS attribute ${attrType} is longer than 253 octets`);
    }
    const attr = Buffer.alloc(2 + attrValue.length);
    attr.writeUInt8(attrType, 0);
    attr.writeUInt8(attr.length, 1);
    attrValue.copy(attr, 2);
    return attr;
}

function encodeAttributes(attributes = []) {
    return Buffer.concat(
        attributes.map(attr => {
            if (Buffer.isBuffer(attr)) {
                return attr;
            }
            return encodeAttribute(attr.type, attr.value);
        })
    );
}

function attr(type, value) {
    return { type, value: Buffer.isBuffer(value) ? value : Buffer.from(value || []) };
}

function stringAttr(type, value) {
    return attr(type, stringToBuffer(value));
}

function integerAttr(type, value) {
    return attr(type, numberToBuffer(value));
}

function ipAttr(type, value) {
    return attr(type, ipToBuffer(value));
}

function ipv6Attr(type, value) {
    return attr(type, ipv6ToBuffer(value));
}

function ipv6PrefixAttr(type, prefix) {
    const [address, lengthText] = String(prefix || '').split('/');
    const prefixLength = Number(lengthText);
    if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 128) {
        throw new Error(`Invalid IPv6 prefix length: ${prefix}`);
    }
    const addressBuffer = ipv6ToBuffer(address);
    const prefixBytes = Math.ceil(prefixLength / 8);
    return attr(type, Buffer.concat([Buffer.from([0, prefixLength]), addressBuffer.slice(0, prefixBytes)]));
}

function vendorSpecificAttr(vendorId, vendorType, value) {
    const vendor = Number(vendorId);
    const type = Number(vendorType);
    const payload = Buffer.isBuffer(value) ? value : stringToBuffer(value);
    if (!Number.isInteger(vendor) || vendor < 1 || vendor > 0xffffffff) {
        throw new Error(`Invalid RADIUS vendor id: ${vendorId}`);
    }
    if (!Number.isInteger(type) || type < 1 || type > 255) {
        throw new Error(`Invalid RADIUS vendor attribute type: ${vendorType}`);
    }
    if (payload.length > 247) {
        throw new Error('Vendor-Specific payload is longer than 247 octets');
    }
    const buffer = Buffer.alloc(6 + payload.length);
    buffer.writeUInt32BE(vendor >>> 0, 0);
    buffer.writeUInt8(type, 4);
    buffer.writeUInt8(2 + payload.length, 5);
    payload.copy(buffer, 6);
    return attr(RADIUS_ATTRIBUTES.VENDOR_SPECIFIC, buffer);
}

function parsePacket(buffer) {
    if (!Buffer.isBuffer(buffer)) {
        throw new Error('RADIUS packet must be a Buffer');
    }
    if (buffer.length < MIN_PACKET_LENGTH) {
        throw new Error(`RADIUS packet shorter than ${MIN_PACKET_LENGTH} octets`);
    }

    const code = buffer.readUInt8(0);
    const identifier = buffer.readUInt8(1);
    const length = buffer.readUInt16BE(2);
    if (length < MIN_PACKET_LENGTH || length > MAX_PACKET_LENGTH) {
        throw new Error(`Invalid RADIUS packet length: ${length}`);
    }
    if (buffer.length < length) {
        throw new Error(`RADIUS packet truncated: expected ${length}, got ${buffer.length}`);
    }

    const raw = buffer.slice(0, length);
    const authenticator = raw.slice(4, 20);
    const attributes = [];
    let offset = MIN_PACKET_LENGTH;
    while (offset < length) {
        if (offset + 2 > length) {
            throw new Error('RADIUS attribute header is truncated');
        }
        const type = raw.readUInt8(offset);
        const attrLength = raw.readUInt8(offset + 1);
        if (attrLength < 2) {
            throw new Error(`Invalid RADIUS attribute length ${attrLength} for type ${type}`);
        }
        if (offset + attrLength > length) {
            throw new Error(`RADIUS attribute ${type} extends beyond packet length`);
        }
        const value = raw.slice(offset + 2, offset + attrLength);
        attributes.push({
            type,
            name: ATTRIBUTE_NAMES[type] || `Attribute-${type}`,
            length: attrLength,
            value,
            raw: raw.slice(offset, offset + attrLength)
        });
        offset += attrLength;
    }

    return {
        code,
        codeName: CODE_NAMES[code] || `Code-${code}`,
        identifier,
        length,
        authenticator,
        attributes,
        raw,
        paddingLength: buffer.length - length
    };
}

function getAttributes(packet, type) {
    return (packet.attributes || []).filter(item => item.type === type);
}

function getFirstAttribute(packet, type) {
    return getAttributes(packet, type)[0] || null;
}

function getString(packet, type) {
    const item = getFirstAttribute(packet, type);
    return item ? item.value.toString('utf8').replace(/\0+$/g, '') : '';
}

function getInteger(packet, type) {
    const item = getFirstAttribute(packet, type);
    if (!item || item.value.length !== 4) {
        return null;
    }
    return item.value.readUInt32BE(0);
}

function getIp(packet, type) {
    const item = getFirstAttribute(packet, type);
    return item ? bufferToIp(item.value) : '';
}

function getIpv6(packet, type) {
    const item = getFirstAttribute(packet, type);
    return item ? bufferToIpv6(item.value) : '';
}

function getIpv6Prefix(packet, type) {
    const item = getFirstAttribute(packet, type);
    if (!item || item.value.length < 2 || item.value.length > 18) {
        return '';
    }
    const prefixLength = item.value.readUInt8(1);
    if (prefixLength > 128) {
        return '';
    }
    const address = Buffer.alloc(16, 0);
    item.value.slice(2).copy(address, 0, 0, Math.min(16, item.value.length - 2));
    return `${bufferToIpv6(address)}/${prefixLength}`;
}

function hasAttribute(packet, type) {
    return Boolean(getFirstAttribute(packet, type));
}

function buildPacket(code, identifier, authenticator, attributes = []) {
    const attrs = encodeAttributes(attributes);
    const length = MIN_PACKET_LENGTH + attrs.length;
    if (length > MAX_PACKET_LENGTH) {
        throw new Error(`RADIUS packet is longer than ${MAX_PACKET_LENGTH} octets`);
    }
    const packet = Buffer.alloc(length);
    packet.writeUInt8(code, 0);
    packet.writeUInt8(identifier & 0xff, 1);
    packet.writeUInt16BE(length, 2);
    (authenticator || Buffer.alloc(16)).copy(packet, 4);
    attrs.copy(packet, MIN_PACKET_LENGTH);
    return packet;
}

function replaceAuthenticator(packet, authenticator) {
    const copy = Buffer.from(packet);
    authenticator.copy(copy, 4);
    return copy;
}

function zeroMessageAuthenticator(packet) {
    const copy = Buffer.from(packet);
    let offset = MIN_PACKET_LENGTH;
    while (offset < copy.length) {
        const type = copy.readUInt8(offset);
        const length = copy.readUInt8(offset + 1);
        if (type === RADIUS_ATTRIBUTES.MESSAGE_AUTHENTICATOR && length === 18) {
            copy.fill(0, offset + 2, offset + 18);
        }
        offset += length;
    }
    return copy;
}

function insertMessageAuthenticator(packet, value) {
    const copy = Buffer.from(packet);
    let offset = MIN_PACKET_LENGTH;
    while (offset < copy.length) {
        const type = copy.readUInt8(offset);
        const length = copy.readUInt8(offset + 1);
        if (type === RADIUS_ATTRIBUTES.MESSAGE_AUTHENTICATOR && length === 18) {
            value.copy(copy, offset + 2);
            return copy;
        }
        offset += length;
    }
    return copy;
}

function hasMessageAuthenticator(attributes = []) {
    return attributes.some(item => item.type === RADIUS_ATTRIBUTES.MESSAGE_AUTHENTICATOR);
}

function withMessageAuthenticator(attributes = [], required = false) {
    if (!required || hasMessageAuthenticator(attributes)) {
        return attributes;
    }
    return [...attributes, attr(RADIUS_ATTRIBUTES.MESSAGE_AUTHENTICATOR, Buffer.alloc(16))];
}

function computeResponseAuthenticator(code, identifier, requestAuthenticator, attributes, secret) {
    const attrs = encodeAttributes(attributes);
    const length = MIN_PACKET_LENGTH + attrs.length;
    const header = Buffer.alloc(MIN_PACKET_LENGTH);
    header.writeUInt8(code, 0);
    header.writeUInt8(identifier & 0xff, 1);
    header.writeUInt16BE(length, 2);
    requestAuthenticator.copy(header, 4);
    return md5([header, attrs, normalizeSecret(secret)]);
}

function buildResponsePacket(code, identifier, requestAuthenticator, attributes = [], secret, options = {}) {
    const includeMessageAuthenticator = Boolean(options.includeMessageAuthenticator);
    const responseAttrs = withMessageAuthenticator(attributes, includeMessageAuthenticator);
    let packet = buildPacket(code, identifier, requestAuthenticator, responseAttrs);

    if (includeMessageAuthenticator) {
        const hmacPacket = zeroMessageAuthenticator(replaceAuthenticator(packet, requestAuthenticator));
        const mac = hmacMd5(normalizeSecret(secret), hmacPacket);
        packet = insertMessageAuthenticator(packet, mac);
    }

    const finalPacket = Buffer.from(packet);
    const finalAttrs = finalPacket.slice(MIN_PACKET_LENGTH);
    const header = Buffer.alloc(MIN_PACKET_LENGTH);
    header.writeUInt8(code, 0);
    header.writeUInt8(identifier & 0xff, 1);
    header.writeUInt16BE(finalPacket.length, 2);
    requestAuthenticator.copy(header, 4);
    const responseAuthenticator = md5([header, finalAttrs, normalizeSecret(secret)]);
    responseAuthenticator.copy(finalPacket, 4);
    return finalPacket;
}

function computeAccountingRequestAuthenticator(code, identifier, attributes, secret) {
    const attrs = encodeAttributes(attributes);
    const length = MIN_PACKET_LENGTH + attrs.length;
    const header = Buffer.alloc(MIN_PACKET_LENGTH);
    header.writeUInt8(code, 0);
    header.writeUInt8(identifier & 0xff, 1);
    header.writeUInt16BE(length, 2);
    header.fill(0, 4, 20);
    return md5([header, attrs, normalizeSecret(secret)]);
}

function buildAccountingLikeRequestPacket(code, identifier, attributes, secret, options = {}) {
    const includeMessageAuthenticator = Boolean(options.includeMessageAuthenticator);
    const attrs = withMessageAuthenticator(attributes, includeMessageAuthenticator);
    let requestAuth = computeAccountingRequestAuthenticator(code, identifier, attrs, secret);
    let packet = buildPacket(code, identifier, requestAuth, attrs);

    if (includeMessageAuthenticator) {
        const zeroAuthPacket = replaceAuthenticator(zeroMessageAuthenticator(packet), Buffer.alloc(16));
        const mac = hmacMd5(normalizeSecret(secret), zeroAuthPacket);
        packet = insertMessageAuthenticator(packet, mac);
        const parsed = parsePacket(packet);
        requestAuth = computeAccountingRequestAuthenticator(code, identifier, parsed.attributes, secret);
        requestAuth.copy(packet, 4);
    }

    return packet;
}

function verifyAccountingLikeRequest(packet, secret) {
    const expected = computeAccountingRequestAuthenticator(packet.code, packet.identifier, packet.attributes, secret);
    return safeEqual(expected, packet.authenticator);
}

function computeAccessMessageAuthenticator(packet, secret, requestAuthenticator = null) {
    let hmacPacket = zeroMessageAuthenticator(packet.raw || packet);
    if (requestAuthenticator) {
        hmacPacket = replaceAuthenticator(hmacPacket, requestAuthenticator);
    }
    return hmacMd5(normalizeSecret(secret), hmacPacket);
}

function verifyAccessMessageAuthenticator(packet, secret, requestAuthenticator = null) {
    const item = getFirstAttribute(packet, RADIUS_ATTRIBUTES.MESSAGE_AUTHENTICATOR);
    if (!item || item.value.length !== 16) {
        return false;
    }
    return safeEqual(computeAccessMessageAuthenticator(packet, secret, requestAuthenticator), item.value);
}

function computeDynamicRequestMessageAuthenticator(packet, secret) {
    const zeroed = replaceAuthenticator(zeroMessageAuthenticator(packet.raw || packet), Buffer.alloc(16));
    return hmacMd5(normalizeSecret(secret), zeroed);
}

function verifyDynamicRequestMessageAuthenticator(packet, secret) {
    const item = getFirstAttribute(packet, RADIUS_ATTRIBUTES.MESSAGE_AUTHENTICATOR);
    if (!item || item.value.length !== 16) {
        return false;
    }
    return safeEqual(computeDynamicRequestMessageAuthenticator(packet, secret), item.value);
}

function encryptUserPassword(password, secret, requestAuthenticator) {
    const passwordBuffer = stringToBuffer(password);
    if (passwordBuffer.length > 128) {
        throw new Error('RADIUS User-Password cannot exceed 128 octets');
    }
    const paddedLength = Math.max(16, Math.ceil(passwordBuffer.length / 16) * 16);
    const padded = Buffer.alloc(paddedLength, 0);
    passwordBuffer.copy(padded);

    const secretBuffer = normalizeSecret(secret);
    const blocks = [];
    let previous = requestAuthenticator;
    for (let offset = 0; offset < padded.length; offset += 16) {
        const digest = md5([secretBuffer, previous]);
        const cipher = Buffer.alloc(16);
        for (let i = 0; i < 16; i++) {
            cipher[i] = padded[offset + i] ^ digest[i];
        }
        blocks.push(cipher);
        previous = cipher;
    }
    return Buffer.concat(blocks);
}

function decryptUserPassword(encrypted, secret, requestAuthenticator) {
    if (!Buffer.isBuffer(encrypted) || encrypted.length < 16 || encrypted.length > 128 || encrypted.length % 16 !== 0) {
        throw new Error('Invalid RADIUS User-Password attribute length');
    }
    const secretBuffer = normalizeSecret(secret);
    const blocks = [];
    let previous = requestAuthenticator;
    for (let offset = 0; offset < encrypted.length; offset += 16) {
        const cipher = encrypted.slice(offset, offset + 16);
        const digest = md5([secretBuffer, previous]);
        const plain = Buffer.alloc(16);
        for (let i = 0; i < 16; i++) {
            plain[i] = cipher[i] ^ digest[i];
        }
        blocks.push(plain);
        previous = cipher;
    }
    return Buffer.concat(blocks).toString('utf8').replace(/\0+$/g, '');
}

function verifyChapPassword(packet, clearTextPassword) {
    const chap = getFirstAttribute(packet, RADIUS_ATTRIBUTES.CHAP_PASSWORD);
    if (!chap || chap.value.length !== 17) {
        return false;
    }
    const chapId = chap.value.slice(0, 1);
    const chapResponse = chap.value.slice(1);
    const challengeAttr = getFirstAttribute(packet, RADIUS_ATTRIBUTES.CHAP_CHALLENGE);
    const challenge = challengeAttr ? challengeAttr.value : packet.authenticator;
    const expected = md5([chapId, stringToBuffer(clearTextPassword), challenge]);
    return safeEqual(expected, chapResponse);
}

function buildChapPassword(chapId, clearTextPassword, challenge) {
    const id = Buffer.from([Number(chapId) & 0xff]);
    const response = md5([id, stringToBuffer(clearTextPassword), challenge]);
    return Buffer.concat([id, response]);
}

function getProxyStateAttributes(packet) {
    return getAttributes(packet, RADIUS_ATTRIBUTES.PROXY_STATE).map(item => attr(RADIUS_ATTRIBUTES.PROXY_STATE, item.value));
}

function summarizeAttributes(packet) {
    return (packet.attributes || []).map(item => {
        let value = item.value.toString('hex');
        if (
            [
                RADIUS_ATTRIBUTES.USER_NAME,
                RADIUS_ATTRIBUTES.NAS_IDENTIFIER,
                RADIUS_ATTRIBUTES.REPLY_MESSAGE,
                RADIUS_ATTRIBUTES.CALLING_STATION_ID,
                RADIUS_ATTRIBUTES.CALLED_STATION_ID,
                RADIUS_ATTRIBUTES.ACCT_SESSION_ID,
                RADIUS_ATTRIBUTES.NAS_PORT_ID,
                RADIUS_ATTRIBUTES.FILTER_ID
            ].includes(item.type)
        ) {
            value = item.value.toString('utf8');
        } else if (
            [
                RADIUS_ATTRIBUTES.NAS_PORT,
                RADIUS_ATTRIBUTES.SERVICE_TYPE,
                RADIUS_ATTRIBUTES.FRAMED_PROTOCOL,
                RADIUS_ATTRIBUTES.SESSION_TIMEOUT,
                RADIUS_ATTRIBUTES.IDLE_TIMEOUT,
                RADIUS_ATTRIBUTES.ACCT_STATUS_TYPE,
                RADIUS_ATTRIBUTES.ERROR_CAUSE
            ].includes(item.type) &&
            item.value.length === 4
        ) {
            value = item.value.readUInt32BE(0);
        } else if (
            [RADIUS_ATTRIBUTES.NAS_IP_ADDRESS, RADIUS_ATTRIBUTES.FRAMED_IP_ADDRESS, RADIUS_ATTRIBUTES.FRAMED_IP_NETMASK].includes(
                item.type
            ) &&
            item.value.length === 4
        ) {
            value = bufferToIp(item.value);
        } else if ([RADIUS_ATTRIBUTES.NAS_IPV6_ADDRESS].includes(item.type) && item.value.length === 16) {
            value = bufferToIpv6(item.value);
        } else if ([RADIUS_ATTRIBUTES.FRAMED_IPV6_PREFIX].includes(item.type)) {
            value = getIpv6Prefix({ attributes: [item] }, item.type) || value;
        }
        return {
            type: item.type,
            name: item.name,
            value
        };
    });
}

function codeName(code) {
    return CODE_NAMES[code] || `Code-${code}`;
}

function attributeName(type) {
    return ATTRIBUTE_NAMES[type] || `Attribute-${type}`;
}

module.exports = {
    MAX_PACKET_LENGTH,
    MIN_PACKET_LENGTH,
    CODE_NAMES,
    ATTRIBUTE_NAMES,
    md5,
    hmacMd5,
    safeEqual,
    normalizeAddress,
    ipToBuffer,
    bufferToIp,
    ipv6ToBuffer,
    bufferToIpv6,
    parsePacket,
    buildPacket,
    buildResponsePacket,
    computeResponseAuthenticator,
    buildAccountingLikeRequestPacket,
    computeAccountingRequestAuthenticator,
    verifyAccountingLikeRequest,
    computeAccessMessageAuthenticator,
    verifyAccessMessageAuthenticator,
    computeDynamicRequestMessageAuthenticator,
    verifyDynamicRequestMessageAuthenticator,
    encryptUserPassword,
    decryptUserPassword,
    verifyChapPassword,
    buildChapPassword,
    attr,
    stringAttr,
    integerAttr,
    ipAttr,
    ipv6Attr,
    ipv6PrefixAttr,
    vendorSpecificAttr,
    getAttributes,
    getFirstAttribute,
    getString,
    getInteger,
    getIp,
    getIpv6,
    getIpv6Prefix,
    hasAttribute,
    getProxyStateAttributes,
    summarizeAttributes,
    codeName,
    attributeName,
    RADIUS_CODES,
    RADIUS_ATTRIBUTES,
    RADIUS_SERVICE_TYPES,
    RADIUS_FRAMED_PROTOCOLS,
    RADIUS_ACCT_STATUS_TYPES,
    RADIUS_ERROR_CAUSES
};
