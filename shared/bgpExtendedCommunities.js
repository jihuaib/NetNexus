const MAX_UINT32 = 0xffffffff;
const SUBTYPES = { rt: 2, soo: 3 };

function unsignedInteger(value, max, label) {
    const text = String(value ?? '');
    const number = Number(text);
    if (!/^\d+$/.test(text) || !Number.isInteger(number) || number > max) {
        throw new Error(`${label}范围为 0 ~ ${max}`);
    }
    return number;
}

function parseBase(value) {
    const text = String(value ?? '').trim();
    if (text.includes('.')) {
        const parts = text.split('.');
        if (parts.length !== 4) throw new Error('Extended Community请输入有效的IPv4地址');
        const bytes = parts.map(part => unsignedInteger(part, 255, 'Extended Community IPv4地址'));
        return { canonical: bytes.join('.'), type: 1, bytes, maxAssigned: 0xffff };
    }
    const number = unsignedInteger(text, MAX_UINT32, 'Extended Community ASN');
    const type = number <= 0xffff ? 0 : 2;
    return { canonical: `${number}`, type, number, maxAssigned: type === 0 ? MAX_UINT32 : 0xffff };
}

function unsignedBytes(value, size) {
    const bytes = Array(size).fill(0);
    for (let index = size - 1; index >= 0; index -= 1) {
        bytes[index] = value % 256;
        value = Math.floor(value / 256);
    }
    return bytes;
}

function parseEntry(value) {
    const parts = value.split(':');
    const subtype = parts[0].toLowerCase();
    if (subtype === 'hex') {
        if (parts.length !== 2 || !/^[\da-f]{16}$/i.test(parts[1])) {
            throw new Error('Extended Community原始值必须是8字节（16个十六进制字符）');
        }
        const hex = parts[1].toLowerCase();
        return {
            canonical: `hex:${hex}`,
            bytes: Array.from({ length: 8 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16))
        };
    }
    if (!Object.prototype.hasOwnProperty.call(SUBTYPES, subtype) || parts.length !== 3) {
        throw new Error('Extended Community格式应为 rt:ASN:数值、soo:ASN:数值或 hex:16位十六进制');
    }
    const base = parseBase(parts[1]);
    const assigned = unsignedInteger(parts[2], base.maxAssigned, 'Extended Community数值');
    const administrator = base.bytes || unsignedBytes(base.number, base.type === 0 ? 2 : 4);
    return {
        canonical: `${subtype}:${base.canonical}:${assigned}`,
        bytes: [base.type, SUBTYPES[subtype], ...administrator, ...unsignedBytes(assigned, base.type === 0 ? 4 : 2)]
    };
}

function parseEntries(value) {
    const inputs = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
    return inputs.flatMap(input => {
        if (typeof input !== 'string') throw new Error('Extended Community条目必须为字符串');
        return input.trim().split(/\s+/).filter(Boolean).map(parseEntry);
    });
}

function normalizeExtendedCommunities(value) {
    return parseEntries(value).map(entry => entry.canonical);
}

function encodeExtendedCommunities(value) {
    return parseEntries(value).flatMap(entry => entry.bytes);
}

function getExtendedCommunityValueRange(base) {
    return [0, parseBase(base).maxAssigned];
}

module.exports = { normalizeExtendedCommunities, encodeExtendedCommunities, getExtendedCommunityValueRange };
