const STRUCTURE_FIELDS = [
    'locatorBlockLength',
    'locatorNodeLength',
    'functionLength',
    'argumentLength',
    'transpositionLength',
    'transpositionOffset'
];
const DEFAULT_STRUCTURE = {
    locatorBlockLength: 32,
    locatorNodeLength: 32,
    functionLength: 64,
    argumentLength: 0,
    transpositionLength: 0,
    transpositionOffset: 0
};

function isEvpnPerEs(config) {
    return Number(config.routeType) === 1 && Number(config.ethernetTagId ?? config.ethernetTag) === 0xffffffff;
}

function normalizeEvpnSrv6Parameters(rule, config) {
    const routeType = Number(config.routeType);
    const serviceType = rule.type === 'srv6L2' ? 'l2' : rule.type === 'srv6L3' ? 'l3' : '';
    if (!serviceType || config.encapsulationType !== 'srv6') throw new Error('SRv6 Service SID仅适用于EVPN SRv6封装');
    let allowed;
    if (serviceType === 'l2') {
        allowed =
            routeType === 1
                ? isEvpnPerEs(config)
                    ? [24]
                    : [21, 22, 23]
                : routeType === 2
                  ? [21, 23]
                  : routeType === 3
                    ? [24]
                    : [];
    } else {
        const payloadIp = String(
            routeType === 2
                ? (config.ipAddress ?? config.ip ?? '')
                : (config.ip ?? config.prefix ?? config.ipPrefix ?? '')
        ).trim();
        allowed =
            [2, 5].includes(routeType) && payloadIp ? (payloadIp.includes(':') ? [16, 18, 20] : [17, 19, 20]) : [];
    }
    if (!allowed.length) throw new Error(`EVPN Type ${routeType}不支持SRv6 ${serviceType.toUpperCase()} Service SID`);
    const fallback = serviceType === 'l3' ? 20 : isEvpnPerEs(config) || routeType === 3 ? 24 : 23;
    const endpointBehavior = Number(rule.endpointBehavior ?? fallback);
    if (!Number.isInteger(endpointBehavior) || !allowed.includes(endpointBehavior))
        throw new Error(`SRv6 Endpoint Behavior不适用于当前EVPN路由，允许值为 ${allowed.join(', ')}`);
    const srv6SidStructure = Object.fromEntries(
        STRUCTURE_FIELDS.map(key => {
            const value = Number(rule[key] ?? DEFAULT_STRUCTURE[key]);
            if (!Number.isInteger(value) || value < 0 || value > 128)
                throw new Error(`SRv6 SID结构字段 ${key} 范围为0 ~ 128`);
            return [key, value];
        })
    );
    const {
        locatorBlockLength,
        locatorNodeLength,
        functionLength,
        argumentLength,
        transpositionLength,
        transpositionOffset
    } = srv6SidStructure;
    if (locatorBlockLength + locatorNodeLength + functionLength + argumentLength > 128)
        throw new Error('SRv6 SID结构总位数不能超过128');
    if (argumentLength !== 0) throw new Error('EVPN SRv6当前支持完整SID和Local Bias，Argument Length必须为0');
    if (transpositionLength !== 0 || transpositionOffset !== 0)
        throw new Error('EVPN SRv6使用完整SID，转置长度和偏移必须为0');
    return { serviceType, endpointBehavior, srv6SidStructure };
}

function ipv6Number(value) {
    let text = String(value ?? '').trim();
    if (!text.includes(':') || text.includes('%')) throw new Error('SRv6 SID必须是IPv6地址');
    if (text.includes('.')) {
        const split = text.lastIndexOf(':');
        const bytes = text.slice(split + 1).split('.');
        if (bytes.length !== 4 || bytes.some(byte => !/^\d+$/.test(byte) || Number(byte) > 255))
            throw new Error('SRv6 SID必须是IPv6地址');
        text =
            text.slice(0, split + 1) +
            ((Number(bytes[0]) << 8) | Number(bytes[1])).toString(16) +
            ':' +
            ((Number(bytes[2]) << 8) | Number(bytes[3])).toString(16);
    }
    const halves = text.split('::');
    if (halves.length > 2) throw new Error('SRv6 SID必须是IPv6地址');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1))
        throw new Error('SRv6 SID必须是IPv6地址');
    const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
    if (groups.some(group => !/^[\da-f]{1,4}$/i.test(group))) throw new Error('SRv6 SID必须是IPv6地址');
    return groups.reduce((number, group) => (number << 16n) + BigInt(`0x${group}`), 0n);
}

function validateEvpnSrv6Sid(value, parameters, config) {
    const sid = ipv6Number(value);
    if (isEvpnPerEs(config) && sid !== 0n) throw new Error('EVPN Type 1 per-ES Local Bias的SRv6 SID必须为::');
    const structure = parameters.srv6SidStructure;
    const used = structure.locatorBlockLength + structure.locatorNodeLength + structure.functionLength;
    const tailMask = (1n << BigInt(128 - used)) - 1n;
    if ((sid & tailMask) !== 0n) throw new Error('SRv6 SID在Locator和Function之后的位必须为0');
    return true;
}

module.exports = { isEvpnPerEs, normalizeEvpnSrv6Parameters, validateEvpnSrv6Sid };
