const MAX_UINT32 = 0xffffffff;

function unsignedInteger(value, max, label) {
    const text = String(value ?? '');
    const number = Number(text);
    if (!/^\d+$/.test(text) || !Number.isInteger(number) || number > max) throw new Error(`${label}范围为 0 ~ ${max}`);
    return number;
}

function parseBase(value) {
    const text = String(value ?? '').trim();
    if (text.includes('.')) {
        const parts = text.split('.');
        if (parts.length !== 4) throw new Error('RD请输入有效的IPv4地址');
        const bytes = parts.map(part => unsignedInteger(part, 255, 'RD IPv4地址'));
        return { base: bytes.join('.'), type: 1, maxAssigned: 0xffff };
    }
    const number = unsignedInteger(text, MAX_UINT32, 'RD ASN');
    const type = number <= 0xffff ? 0 : 2;
    return { base: `${number}`, type, maxAssigned: type === 0 ? MAX_UINT32 : 0xffff };
}

function composeRouteDistinguisher(base, assigned) {
    const parsed = parseBase(base);
    return `${parsed.base}:${unsignedInteger(assigned, parsed.maxAssigned, 'RD数值')}`;
}

function parseRouteDistinguisher(value) {
    const parts = String(value ?? '')
        .trim()
        .split(':');
    if (parts.length !== 2) throw new Error('RD格式应为 ASN:数值或IPv4:数值');
    const parsed = parseBase(parts[0]);
    const assigned = unsignedInteger(parts[1], parsed.maxAssigned, 'RD数值');
    return { ...parsed, assigned, canonical: `${parsed.base}:${assigned}` };
}

function normalizeRouteDistinguisher(value) {
    return parseRouteDistinguisher(value).canonical;
}

function getRouteDistinguisherValueRange(base) {
    return [0, parseBase(base).maxAssigned];
}

module.exports = {
    normalizeRouteDistinguisher,
    parseRouteDistinguisher,
    getRouteDistinguisherValueRange,
    composeRouteDistinguisher
};
