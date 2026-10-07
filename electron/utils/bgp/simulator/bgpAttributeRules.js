const ipaddr = require('ipaddr.js');
const { ATTRIBUTE_BY_TYPE, ATTRIBUTE_DEFAULTS } = require('../bgpAttributeRegistry');
const {
    normalizeExtendedCommunities,
    getExtendedCommunityValueRange
} = require('../../../../shared/bgpExtendedCommunities');
const {
    normalizeRouteDistinguisher,
    composeRouteDistinguisher,
    getRouteDistinguisherValueRange
} = require('../../../../shared/bgpRouteDistinguisher');
const { isEvpnPerEs, normalizeEvpnSrv6Parameters, validateEvpnSrv6Sid } = require('../../../../shared/bgpEvpnSrv6');
const { isAttributeApplicable, isAttributeRequired } = require('../../../../shared/bgpAttributeConditions');

const MAX_UINT32 = 0xffffffff;
const MAX_IPV6 = (1n << 128n) - 1n;
const SRV6_STRUCTURE_FIELDS = [
    'locatorBlockLength',
    'locatorNodeLength',
    'functionLength',
    'argumentLength',
    'transpositionLength',
    'transpositionOffset'
];

function integer(value, min, max, name) {
    const number = Number(value);
    if (
        value === undefined ||
        value === null ||
        value === '' ||
        !Number.isInteger(number) ||
        number < min ||
        number > max
    ) {
        throw new Error(`${name}范围为 ${min} ~ ${max}`);
    }
    return number;
}

function ipv4Number(value) {
    const text = String(value ?? '');
    const parts = text.split('.');
    if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part) || Number(part) > 255)) {
        throw new Error('Next Hop请输入有效的IPv4地址');
    }
    return parts.reduce((number, part) => number * 256 + Number(part), 0);
}

function ipv4String(number) {
    return [24, 16, 8, 0].map(shift => (number >>> shift) & 255).join('.');
}

function ipv6Number(value) {
    try {
        const address = ipaddr.parse(String(value ?? ''));
        if (address.kind() !== 'ipv6') throw new Error('Invalid family');
        return address.toByteArray().reduce((number, byte) => number * 256n + BigInt(byte), 0n);
    } catch (_error) {
        throw new Error('SRv6 SID必须是IPv6地址');
    }
}

function ipAddressNumber(value) {
    try {
        const address = ipaddr.parse(String(value ?? ''));
        const family = address.kind();
        return {
            family,
            number: address.toByteArray().reduce((number, byte) => number * 256n + BigInt(byte), 0n),
            max: family === 'ipv6' ? MAX_IPV6 : BigInt(MAX_UINT32)
        };
    } catch (_error) {
        throw new Error('MP Next Hop请输入有效的IPv4或IPv6地址');
    }
}

function ipAddressString(value, family) {
    return family === 'ipv6' ? ipv6String(value) : ipv4String(Number(value));
}

function ipv6String(value) {
    const bytes = Array(16).fill(0);
    for (let index = 15; index >= 0; index -= 1) {
        bytes[index] = Number(value & 255n);
        value >>= 8n;
    }
    return ipaddr.fromByteArray(bytes).toString();
}

function normalizeAsPath(value) {
    const path = String(value ?? '').trim();
    if (!path) return '';
    const asns = path.split(/\s+/).map(asn => integer(asn, 1, MAX_UINT32, 'ASN'));
    const maxLength = ATTRIBUTE_BY_TYPE.get('asPath').validation.maxLength;
    if (asns.length > maxLength) throw new Error(`AS Path最多支持${maxLength}个AS`);
    return asns.join(' ');
}

function normalizeCommunity(value) {
    const parts = String(value).split(':');
    if (parts.length !== 2) throw new Error('Community格式应为 ASN:数值');
    const base = integer(parts[0], 0, 0xffff, 'Community ASN');
    return `${base}:${integer(parts[1], 0, 0xffff, 'Community数值')}`;
}

function normalizeCommunityList(value) {
    const values = Array.isArray(value)
        ? value
        : String(value ?? '')
              .trim()
              .split(/\s+/)
              .filter(Boolean);
    return values.map(normalizeCommunity);
}

function normalizeHex(value) {
    const text = String(value ?? '');
    if (/[^\da-f\s]/i.test(text)) throw new Error('自定义属性只允许十六进制字符和空白');
    const hex = text.replace(/\s/g, '').toLowerCase();
    if (hex.length % 2) throw new Error('自定义属性十六进制字符数必须为偶数');
    return hex;
}

function customAttribute(rule, value) {
    const hex = normalizeHex(value);
    if (rule.typeCode === undefined || rule.typeCode === null || rule.typeCode === '') return hex;
    const typeCode = integer(rule.typeCode, 1, 255, '自定义属性类型码');
    let flags = integer(rule.flags ?? ATTRIBUTE_DEFAULTS.custom.flags, 0, 255, '自定义属性Flags');
    const length = hex.length / 2;
    if (length > 0xffff) throw new Error('自定义属性值长度不能超过65535字节');
    if (length > 255) flags |= 0x10;
    const header = Buffer.alloc(flags & 0x10 ? 4 : 3);
    header[0] = flags;
    header[1] = typeCode;
    if (flags & 0x10) header.writeUInt16BE(length, 2);
    else header[2] = length;
    return header.toString('hex') + hex;
}

function normalizeValue(rule, value) {
    switch (rule.type) {
        case 'origin': {
            const origin =
                typeof value === 'string' ? ({ IGP: 0, EGP: 1, INCOMPLETE: 2 }[value.toUpperCase()] ?? value) : value;
            return integer(origin, 0, 2, 'Origin');
        }
        case 'asPath':
            return normalizeAsPath(value);
        case 'nextHop':
            return ipv4String(ipv4Number(value));
        case 'mpNextHop': {
            const address = ipAddressNumber(value);
            return ipAddressString(address.number, address.family);
        }
        case 'bsid': {
            const address = ipAddressNumber(value);
            if (address.family !== 'ipv6') throw new Error('BSID必须是IPv6地址');
            return ipAddressString(address.number, address.family);
        }
        case 'dqpn':
            return integer(value, 0, 0xffffff, 'DQPN');
        case 'med':
        case 'localPref':
            return integer(value, 0, MAX_UINT32, rule.type === 'med' ? 'MED' : 'Local Preference');
        case 'addPath':
            return integer(value, 0, MAX_UINT32, 'Path ID');
        case 'label':
        case 'label2':
            return integer(value, 0, 0xfffff, 'MPLS Label');
        case 'vni':
        case 'vni2':
            return integer(value, 0, 0xffffff, 'VNI');
        case 'rd':
            return normalizeRouteDistinguisher(value);
        case 'communities':
            return normalizeCommunityList(value);
        case 'extendedCommunities':
            return normalizeExtendedCommunities(value);
        case 'custom':
            return customAttribute(rule, value);
        default:
            throw new Error(`不支持的属性类型: ${rule.type}`);
    }
}

function getNumericRange(rule) {
    if (rule.type === 'rd') return getRouteDistinguisherValueRange(rule.base);
    if (rule.type === 'extendedCommunities') {
        return getExtendedCommunityValueRange(rule.base ?? ATTRIBUTE_DEFAULTS.extendedCommunities.base);
    }
    if (rule.type === 'communities') {
        normalizeCommunity(`${rule.base ?? ATTRIBUTE_DEFAULTS.communities.base}:0`);
        return [0, 0xffff];
    }
    const bounds = ATTRIBUTE_BY_TYPE.get(rule.type)?.validation;
    return [bounds?.min ?? 0, bounds?.max ?? MAX_UINT32];
}

function compileRule(source, routeCount, addressFamily, config) {
    const metadata = ATTRIBUTE_BY_TYPE.get(source?.type);
    if (!metadata) throw new Error(`不支持的属性类型: ${source?.type}`);
    const rule = { ...source, mode: source.mode || metadata.default.mode || 'fixed' };
    delete rule.enabled;
    if (metadata.modes.length && !metadata.modes.includes(rule.mode))
        throw new Error(`不支持的属性生成模式: ${rule.mode}`);
    if (rule.type === 'addPath') {
        if (source.mode && source.mode !== 'fixed') throw new Error('ADD-PATH请配置每前缀Path-ID数量');
        return {
            ...rule,
            count: integer(
                rule.count ?? metadata.default.count,
                metadata.validation.min,
                metadata.validation.max,
                'ADD-PATH数量'
            )
        };
    }
    if (['srv6', 'srv6L2', 'srv6L3'].includes(rule.type)) {
        const evpn = rule.type === 'srv6' ? null : normalizeEvpnSrv6Parameters(rule, config);
        const endpointBehavior =
            evpn?.endpointBehavior ??
            integer(
                rule.endpointBehavior ??
                    metadata.familyDefaults?.[addressFamily]?.endpointBehavior ??
                    metadata.default.endpointBehavior,
                0,
                0xffff,
                'SRv6 Endpoint Behavior'
            );
        const srv6SidStructure =
            evpn?.srv6SidStructure ??
            Object.fromEntries(
                SRV6_STRUCTURE_FIELDS.map(key => [key, integer(rule[key] ?? metadata.default[key], 0, 128, key)])
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
        if (transpositionLength + transpositionOffset > 128) throw new Error('SRv6 SID转置范围不能超过128位');
        if (rule.type !== 'srv6' && (transpositionLength !== 0 || transpositionOffset !== 0))
            throw new Error('EVPN SRv6使用完整SID，转置长度和偏移必须为0');
        Object.assign(rule, { srv6SidStructure });
        const normalizeSid = value => {
            const sid = ipv6String(ipv6Number(value));
            if (evpn) validateEvpnSrv6Sid(sid, evpn, config);
            return sid;
        };
        if (rule.mode === 'fixed') return { ...rule, endpointBehavior, resolved: normalizeSid(rule.value) };
        if (rule.mode === 'list') {
            if (!Array.isArray(rule.values) || !rule.values.length) throw new Error('SRv6 SID列表不能为空');
            return { ...rule, endpointBehavior, resolved: rule.values.map(normalizeSid) };
        }
        if (rule.mode !== 'increment') throw new Error('SRv6 SID支持固定、递增或列表模式');
        const start = ipv6Number(rule.start);
        const step = BigInt(integer(rule.step ?? metadata.default.step, 1, Number.MAX_SAFE_INTEGER, 'SRv6 SID步长'));
        if (start + BigInt(Math.max(0, routeCount - 1)) * step > MAX_IPV6)
            throw new Error('SRv6 SID递增超出IPv6地址范围');
        if (evpn) {
            normalizeSid(rule.start);
            const used =
                srv6SidStructure.locatorBlockLength +
                srv6SidStructure.locatorNodeLength +
                srv6SidStructure.functionLength;
            if (routeCount > 1 && step % (1n << BigInt(128 - used)) !== 0n)
                throw new Error('SRv6 SID步长必须保持Locator和Function之后的位为0');
            normalizeSid(ipv6String(start + BigInt(Math.max(0, routeCount - 1)) * step));
        }
        return { ...rule, endpointBehavior, start, step };
    }
    if (rule.mode === 'auto') {
        if (!['nextHop', 'mpNextHop', 'bsid'].includes(rule.type)) throw new Error('自动模式仅适用于Next Hop或BSID');
        return { ...rule, resolved: '' };
    }
    if (
        rule.type === 'rd' &&
        Number(config.addressFamily) === 3 &&
        (Number(config.routeType) === 4 || isEvpnPerEs(config))
    ) {
        const values = rule.mode === 'list' ? rule.values || [] : rule.mode === 'fixed' ? [rule.value] : [rule.base];
        if (
            values.some(
                value =>
                    !String(value ?? '')
                        .split(':')[0]
                        .includes('.')
            )
        )
            throw new Error('EVPN Type 4或Type 1 per-ES的RD必须为IPv4:数值（Type 1）');
    }
    if (rule.mode === 'fixed') return { ...rule, resolved: normalizeValue(rule, rule.value) };
    if (rule.mode === 'list') {
        if (!Array.isArray(rule.values) || !rule.values.length) throw new Error('属性值列表不能为空');
        return { ...rule, resolved: rule.values.map(value => normalizeValue(rule, value)) };
    }
    if (rule.type === 'rd') {
        rule.base = composeRouteDistinguisher(rule.base, 0).split(':')[0];
        const [minValue, maxValue] = getNumericRange(rule);
        if (rule.mode === 'increment') {
            const start = integer(rule.start, minValue, maxValue, 'RD起始数值');
            const step = integer(
                rule.step ?? metadata.default.step,
                -Number.MAX_SAFE_INTEGER,
                Number.MAX_SAFE_INTEGER,
                'RD步长'
            );
            const last = BigInt(start) + BigInt(Math.max(0, routeCount - 1)) * BigInt(step);
            if (last < BigInt(minValue) || last > BigInt(maxValue)) throw new Error('RD递增超出数值范围');
            return { ...rule, start, step };
        }
        const min = integer(rule.min, minValue, maxValue, 'RD随机最小数值');
        const max = integer(rule.max, minValue, maxValue, 'RD随机最大数值');
        if (max < min) throw new Error('RD随机最大值不能小于最小值');
        return { ...rule, min, max };
    }
    if (['mpNextHop', 'bsid'].includes(rule.type)) {
        if (rule.mode === 'increment') {
            const start = ipAddressNumber(rule.start);
            if (rule.type === 'bsid' && start.family !== 'ipv6') throw new Error('BSID必须是IPv6地址');
            const step = BigInt(
                integer(
                    rule.step ?? metadata.default.step,
                    -Number.MAX_SAFE_INTEGER,
                    Number.MAX_SAFE_INTEGER,
                    'MP Next Hop步长'
                )
            );
            const last = start.number + BigInt(Math.max(0, routeCount - 1)) * step;
            if (last < 0n || last > start.max) throw new Error('MP Next Hop递增超出地址范围');
            return { ...rule, start: start.number, step, ipFamily: start.family };
        }
        const min = ipAddressNumber(rule.min);
        const max = ipAddressNumber(rule.max);
        if (rule.type === 'bsid' && (min.family !== 'ipv6' || max.family !== 'ipv6'))
            throw new Error('BSID必须是IPv6地址');
        if (min.family !== max.family) throw new Error('MP Next Hop随机范围必须为同一地址族');
        if (max.number < min.number) throw new Error('MP Next Hop随机最大值不能小于最小值');
        return { ...rule, min: min.number, max: max.number, ipFamily: min.family };
    }
    if (rule.type === 'custom') throw new Error('自定义属性支持固定值或列表模式');
    if (rule.type === 'extendedCommunities') {
        const subtype = String(rule.subtype ?? metadata.default.subtype).toLowerCase();
        const base = rule.base ?? metadata.default.base;
        const normalized = normalizeExtendedCommunities(`${subtype}:${base}:0`)[0].split(':');
        rule.subtype = normalized[0];
        rule.base = normalized[1];
    }
    const multipleValues = ['communities', 'extendedCommunities'].includes(rule.type);
    if (multipleValues) {
        rule.valueCount = integer(
            rule.valueCount === undefined ? metadata.default.valueCount : rule.valueCount,
            metadata.valueCountValidation.min,
            metadata.valueCountValidation.max,
            `${metadata.label}每路由值数量`
        );
    }
    const generatedValueCount = routeCount * (multipleValues ? rule.valueCount : 1);
    if (!Number.isSafeInteger(generatedValueCount)) throw new Error('生成属性值总数超出安全整数范围');
    const [minValue, maxValue] = getNumericRange(rule);
    const readValue = value =>
        rule.type === 'nextHop' ? ipv4Number(value) : integer(value, minValue, maxValue, rule.type);
    if (rule.mode === 'increment') {
        const start = readValue(rule.start);
        const step = integer(rule.step ?? metadata.default.step, -MAX_UINT32, MAX_UINT32, '属性步长');
        const last = start + Math.max(0, generatedValueCount - 1) * step;
        integer(last, minValue, maxValue, `${rule.type}最后一个属性值`);
        return { ...rule, start, step };
    }
    const min = readValue(rule.min);
    const max = readValue(rule.max);
    if (max < min) throw new Error('随机属性最大值不能小于最小值');
    if (rule.type !== 'asPath') return { ...rule, min, max };
    const maxAllowedLength = metadata.validation.maxLength;
    const minLength = integer(rule.minLength ?? metadata.default.minLength, 1, maxAllowedLength, 'AS Path最少AS个数');
    const maxLength = integer(rule.maxLength ?? minLength, minLength, maxAllowedLength, 'AS Path最多AS个数');
    return { ...rule, min, max, minLength, maxLength };
}

/** Compile and validate once, before the worker changes or sends any route. */
function buildAttributeRuleContext(config = {}, random = Math.random, routeCount = Number(config.count) || 1) {
    const requiresVpnNlri = [4, 5].includes(Number(config.addressFamily)) && !Array.isArray(config.routes);
    if (requiresVpnNlri) {
        for (const type of ['rd', 'label']) {
            if (!Array.isArray(config.nlriRules) || !config.nlriRules.some(rule => rule?.type === type))
                throw new Error(`VPN路由需要${type === 'rd' ? 'RD' : 'Label'}节点`);
        }
    }
    if (config.attributeRules === undefined && config.nlriRules === undefined)
        return { enabled: false, rules: [], random };
    if (!Array.isArray(config.routes))
        for (const metadata of ATTRIBUTE_BY_TYPE.values()) {
            if (isAttributeRequired(metadata, config) && !config.nlriRules?.some(rule => rule?.type === metadata.type))
                throw new Error(`路由需要${metadata.label}节点`);
        }
    const sourceRules = [];
    for (const [section, rules] of [
        ['attributes', config.attributeRules],
        ['nlri', config.nlriRules]
    ]) {
        if (rules === undefined) continue;
        if (!Array.isArray(rules)) throw new Error(`${section === 'nlri' ? 'NLRI' : '属性'}规则必须为数组`);
        for (const rule of rules) {
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('属性规则节点必须为对象');
            const metadata = ATTRIBUTE_BY_TYPE.get(rule.type);
            if (metadata && (metadata.section || 'attributes') !== section)
                throw new Error(
                    `${metadata.label}必须配置在${metadata.section === 'nlri' ? 'NLRI' : 'Path Attributes'}分支`
                );
            sourceRules.push(rule);
        }
    }
    const addPath = sourceRules.find(rule => rule.type === 'addPath');
    const pathCount = addPath
        ? integer(
              addPath.count ?? ATTRIBUTE_DEFAULTS.addPath.count,
              ATTRIBUTE_BY_TYPE.get('addPath').validation.min,
              ATTRIBUTE_BY_TYPE.get('addPath').validation.max,
              'ADD-PATH数量'
          )
        : 1;
    const generatedCount = Array.isArray(config.routes) ? config.routes.length : routeCount * pathCount;
    if (!Number.isSafeInteger(generatedCount) || generatedCount < 0) throw new Error('生成路由总数超出安全整数范围');
    const seenTypes = new Set();
    const rules = sourceRules.map(source => {
        const metadata = ATTRIBUTE_BY_TYPE.get(source?.type);
        if (config.addressFamily !== undefined && metadata && !isAttributeApplicable(metadata, config)) {
            throw new Error(`${metadata.label}不适用于当前地址族`);
        }
        if ((metadata?.section || 'attributes') === 'nlri' && seenTypes.has(source.type))
            throw new Error(`NLRI节点 ${source.type} 不能重复添加`);
        seenTypes.add(source.type);
        return compileRule(
            source,
            source.type === 'dqpn' && config.routeGrowthMode === 'ip' ? 1 : generatedCount,
            config.addressFamily,
            config
        );
    });
    return {
        enabled: true,
        rules,
        attributeRules: rules.filter(
            rule => (ATTRIBUTE_BY_TYPE.get(rule.type).section || 'attributes') === 'attributes'
        ),
        random,
        pathCount,
        qpGrowDqpn: config.routeGrowthMode !== 'ip'
    };
}

function sampleInteger(min, max, random) {
    const sample = Math.min(Math.max(Number(random()) || 0, 0), 1 - Number.EPSILON);
    return min + Math.floor(sample * (max - min + 1));
}

function resolveRuleValue(rule, index, random) {
    if (rule.mode === 'auto') return rule.resolved;
    if (rule.mode === 'fixed') return rule.resolved;
    if (rule.mode === 'list') return rule.resolved[index % rule.resolved.length];
    if (['srv6', 'srv6L2', 'srv6L3'].includes(rule.type)) return ipv6String(rule.start + BigInt(index) * rule.step);
    if (rule.type === 'rd') {
        const value =
            rule.mode === 'increment'
                ? Number(BigInt(rule.start) + BigInt(index) * BigInt(rule.step))
                : sampleInteger(rule.min, rule.max, random);
        return composeRouteDistinguisher(rule.base, value);
    }
    if (['mpNextHop', 'bsid'].includes(rule.type)) {
        const value =
            rule.mode === 'increment'
                ? rule.start + BigInt(index) * rule.step
                : rule.min +
                  (BigInt(sampleInteger(0, Number.MAX_SAFE_INTEGER, random)) * (rule.max - rule.min + 1n)) /
                      (1n << 53n);
        return ipAddressString(value, rule.ipFamily);
    }
    if (rule.type === 'asPath' && rule.mode === 'random') {
        const length = sampleInteger(rule.minLength, rule.maxLength, random);
        return Array.from({ length }, () => sampleInteger(rule.min, rule.max, random)).join(' ');
    }
    if (['communities', 'extendedCommunities'].includes(rule.type)) {
        const [min, max] = getNumericRange(rule);
        return Array.from({ length: rule.valueCount }, (_, offset) => {
            const number =
                rule.mode === 'increment'
                    ? rule.start + (index * rule.valueCount + offset) * rule.step
                    : sampleInteger(rule.min, rule.max, random);
            integer(number, min, max, rule.type);
            return rule.type === 'extendedCommunities'
                ? normalizeExtendedCommunities(`${rule.subtype}:${rule.base}:${number}`)[0]
                : normalizeCommunity(`${rule.base ?? ATTRIBUTE_DEFAULTS.communities.base}:${number}`);
        });
    }
    const number =
        rule.mode === 'increment' ? rule.start + index * rule.step : sampleInteger(rule.min, rule.max, random);
    const [min, max] = getNumericRange(rule);
    integer(number, min, max, rule.type);
    if (rule.type === 'nextHop') return ipv4String(number);
    if (rule.type === 'asPath') return `${number}`;
    return number;
}

function getGeneratedAttributeValues(context, routeIndex) {
    const attr = { pathAttributes: [] };
    let label;
    let rd;
    const evpnNlri = {};
    let pathId;
    let mpNextHop = null;
    let dqpn = null;
    for (const rule of context.rules) {
        if (rule.type === 'addPath') {
            pathId = routeIndex % rule.count;
            continue;
        }
        let value;
        if (rule.type === 'dqpn' && !context.qpGrowDqpn) {
            if (!Object.hasOwn(context, 'qpFixedDqpn')) context.qpFixedDqpn = resolveRuleValue(rule, 0, context.random);
            value = context.qpFixedDqpn;
        } else value = resolveRuleValue(rule, routeIndex, context.random);
        if (rule.type === 'mpNextHop' || rule.type === 'bsid') {
            mpNextHop = value;
            continue;
        }
        if (rule.type === 'dqpn') {
            dqpn = value;
            continue;
        }
        if (rule.type === 'rd') {
            rd = value;
            continue;
        }
        if (['srv6L2', 'srv6L3'].includes(rule.type)) {
            const service = {
                serviceType: rule.type === 'srv6L2' ? 'l2' : 'l3',
                sid: value,
                endpointBehavior: rule.endpointBehavior,
                sidStructure: { ...rule.srv6SidStructure }
            };
            (attr.srv6Services ||= []).push(service);
            attr.pathAttributes.push({
                type: rule.type,
                value,
                srv6EndpointBehavior: rule.endpointBehavior,
                srv6SidStructure: { ...rule.srv6SidStructure }
            });
            continue;
        }
        if (['vni', 'vni2', 'label2'].includes(rule.type)) {
            evpnNlri[rule.type] = value;
            continue;
        }
        if (rule.type === 'srv6') {
            attr.srv6Sid = value;
            attr.srv6EndpointBehavior = rule.endpointBehavior;
            attr.srv6SidStructure = { ...rule.srv6SidStructure };
        } else if (rule.type === 'label') label = value;
        else if (rule.type === 'custom') attr.customAttr = (attr.customAttr || '') + value;
        else attr[rule.type] = Array.isArray(value) ? [...value] : value;
        if ((ATTRIBUTE_BY_TYPE.get(rule.type).section || 'attributes') === 'attributes') {
            const entry = { type: rule.type, value: Array.isArray(value) ? [...value] : value };
            if (rule.type === 'asPath' && rule.prependLocalAs === false) entry.prependLocalAs = false;
            if (rule.type === 'srv6') {
                entry.srv6EndpointBehavior = rule.endpointBehavior;
                entry.srv6SidStructure = { ...rule.srv6SidStructure };
            }
            attr.pathAttributes.push(entry);
        }
    }
    return {
        attr,
        label,
        ...(rd !== undefined ? { rd } : {}),
        ...evpnNlri,
        mpNextHop,
        pathId,
        ...(context.rules.some(rule => rule.type === 'dqpn') ? { dqpn } : {})
    };
}

module.exports = { buildAttributeRuleContext, getGeneratedAttributeValues };
