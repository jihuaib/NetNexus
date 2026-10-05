import ipaddr from 'ipaddr.js';
import { BGP_ADDR_FAMILY as AF } from '../../const/bgpConst';
import registry from '../../../shared/bgpAttributes.json';
import { isSchemaFieldVisible } from '../../utils/schemaForm';
import { isValidIpv4 } from '../../utils/validationCommon';
import { intersectRouteSequences } from './bgpRouteRange';
import { IPV4_ROUTE_SECTIONS } from './ipv4RouteSchema';
import {
    createAttributeRule,
    normalizeAttributeRules,
    getDefaultAttributeRules,
    compileRouteRulePayload,
    getAttributeResultColumns,
    getRouteTreeRules,
    isAttributeRuleApplicable,
    isMpNlriEncoding,
    getGeneratedRouteCount,
    validateAttributeRule
} from './bgpAttributeRules';
import {
    createIpv4RouteGroup,
    restoreIpv4RouteWorkspace,
    serializeIpv4RouteWorkspace,
    describeIpv4RouteRange,
    findIpv4RouteGroupOverlap
} from './ipv4RouteWorkspace';
import {
    VPN_EVPN_ROUTE_PROFILES,
    getEvpnRouteTypeDefaults,
    isVpnRoute,
    isEvpnRoute,
    normalizeEvpnRouteConfig,
    isVpnEvpnRoute,
    getVpnEvpnRouteSections,
    validateVpnEvpnRouteConfig,
    getVpnEvpnRouteSequences,
    describeVpnEvpnRouteNlri,
    getVpnEvpnRouteResultColumns
} from './bgpVpnEvpnSchema';

const clone = value => JSON.parse(JSON.stringify(value));
const families = {
    ipv4: {
        title: 'IPv4-UNC',
        addressFamily: AF.IPV4_UNC,
        defaults: registry.route.defaults
    },
    'ipv4-label': {
        title: 'IPv4 Label',
        addressFamily: AF.IPV4_LABEL_UNICAST,
        defaults: registry.route.defaults
    },
    ipv6: {
        title: 'IPv6-UNC',
        addressFamily: AF.IPV6_UNC,
        defaults: { prefix: '2001:db8::', mask: '64', count: '10', ipStep: '1' }
    },
    'ipv4-qp': {
        title: 'IPv4-QP',
        addressFamily: AF.IPV4_QP,
        defaults: { prefix: '1.1.1.1', mask: '32', count: '10', ipStep: '1' }
    },
    'ipv6-qp': {
        title: 'IPv6-QP',
        addressFamily: AF.IPV6_QP,
        defaults: { prefix: '2001:db8::1', mask: '128', count: '10', ipStep: '1' }
    },
    mvpn: {
        title: 'IPv4-MVPN',
        addressFamily: AF.IPV4_MVPN,
        defaults: {
            rd: '100:1',
            routeType: 1,
            sourceIp: '1.1.1.1',
            groupIp: '239.1.1.1',
            originatingRouterIp: '192.168.56.1',
            sourceAs: '65535',
            leafRouteKey: '020c00000064000000010000ffff',
            count: '1'
        }
    },
    ...VPN_EVPN_ROUTE_PROFILES
};
export const ROUTE_PROFILES = Object.fromEntries(
    Object.entries(families).map(([key, value]) => [
        key,
        {
            ...value,
            key,
            testPrefix: `bgp-${key}`,
            addressFamilies: value.addressFamilies || [value.addressFamily],
            defaults: {
                ...value.defaults,
                addressFamily: value.addressFamily,
                nlriEncoding: key === 'ipv4' ? 'auto' : 'mpReach'
            }
        }
    ])
);
export function getRouteProfile(profile) {
    const key = typeof profile === 'string' ? profile : profile?.key;
    if (!ROUTE_PROFILES[key]) throw new Error(`不支持的路由页面：${key}`);
    return typeof profile === 'object' ? { ...ROUTE_PROFILES[key], ...profile } : ROUTE_PROFILES[key];
}
const profileFor = config =>
    Object.values(ROUTE_PROFILES).find(profile => profile.addressFamilies.includes(Number(config.addressFamily))) ||
    ROUTE_PROFILES.ipv4;
const isQp = config => [AF.IPV4_QP, AF.IPV6_QP].includes(Number(config.addressFamily));
const isMvpn = config => Number(config.addressFamily) === AF.IPV4_MVPN;
const isIpv6 = config => [AF.IPV6_UNC, AF.IPV6_QP].includes(Number(config.addressFamily));
const isIpv4Route = config => [AF.IPV4_UNC, AF.IPV4_LABEL_UNICAST].includes(Number(config.addressFamily));
const isIpv4Profile = profile => ['ipv4', 'ipv4-label'].includes(profile.key);
let sequence = 0;

export function createRouteGroup(profile, name = '路由组 1', config = {}) {
    profile = getRouteProfile(profile);
    if (isIpv4Profile(profile)) {
        const group = createIpv4RouteGroup(name, {
            ...clone(profile.defaults),
            ...config,
            addressFamily: profile.addressFamily
        });
        if (profile.key === 'ipv4-label') {
            if (!Array.isArray(config.attributeRules))
                group.config.attributeRules = group.config.attributeRules.filter(rule => rule.type !== 'nextHop');
            if (!Array.isArray(config.nlriRules))
                group.config.nlriRules.unshift(createAttributeRule('mpNextHop', profile.addressFamily));
        }
        return group;
    }
    let normalized = {
        ...clone(profile.defaults),
        ...(profile.key === 'evpn' ? getEvpnRouteTypeDefaults(config) : {}),
        ...clone(config)
    };
    delete normalized.routeWorkspace;
    if (!profile.addressFamilies.includes(Number(normalized.addressFamily)))
        normalized.addressFamily = profile.addressFamily;
    normalized.addressFamily = Number(normalized.addressFamily);
    if (isQp(normalized)) delete normalized.routeGrowthMode;
    normalized.nlriEncoding = 'mpReach';
    normalized.attributeRules = normalizeAttributeRules(
        Array.isArray(config.attributeRules)
            ? config.attributeRules
            : getDefaultAttributeRules(normalized.addressFamily).filter(rule => rule.type !== 'nextHop')
    );
    if ((isMvpn(normalized) || isVpnEvpnRoute(normalized)) && !Array.isArray(config.attributeRules)) {
        const rt = normalized.attributeRules.find(rule => rule.type === 'extendedCommunities');
        if (rt) rt.value = isMvpn(normalized) ? 'rt:1:1' : 'rt:65000:1';
    }
    normalized.nlriRules = normalizeAttributeRules(
        Array.isArray(config.nlriRules)
            ? config.nlriRules
            : isQp(normalized)
              ? [createAttributeRule('dqpn'), createAttributeRule('bsid')]
              : isVpnRoute(normalized)
                ? ['rd', 'label', 'mpNextHop'].map(type => createAttributeRule(type, normalized.addressFamily))
                : [createAttributeRule('mpNextHop', normalized.addressFamily, normalized)]
    );
    if (isVpnRoute(normalized)) {
        for (const type of ['rd', 'label'])
            if (!normalized.nlriRules.some(rule => rule.type === type))
                normalized.nlriRules.push(createAttributeRule(type, normalized.addressFamily));
        for (const field of ['rd', 'labelMode', 'labelStart', 'labelStep']) delete normalized[field];
    }
    if (isEvpnRoute(normalized)) normalized = normalizeEvpnRouteConfig(normalized);
    return { id: `${profile.key}-group-${Date.now().toString(36)}-${++sequence}`, name, config: normalized };
}
export function restoreRouteWorkspace(profile, saved) {
    profile = getRouteProfile(profile);
    if (isIpv4Profile(profile)) {
        const restored = restoreIpv4RouteWorkspace(saved);
        const groups = restored.groups.filter(group => group.config.addressFamily === profile.addressFamily);
        if (!groups.length) groups.push(createRouteGroup(profile));
        return {
            groups,
            activeGroupId: groups.some(group => group.id === restored.activeGroupId)
                ? restored.activeGroupId
                : groups[0].id
        };
    }
    const workspace = saved?.routeWorkspace;
    const used = new Set();
    const groups =
        workspace?.version === 1 && workspace.profile === profile.key && Array.isArray(workspace.groups)
            ? workspace.groups
                  .filter(group => group?.config && typeof group.config === 'object')
                  .map((group, index) => {
                      const result = createRouteGroup(profile, group.name || `路由组 ${index + 1}`, group.config);
                      if (typeof group.id === 'string' && group.id && !used.has(group.id)) result.id = group.id;
                      used.add(result.id);
                      return result;
                  })
            : [];
    if (!groups.length) groups.push(createRouteGroup(profile));
    return {
        groups,
        activeGroupId: groups.some(group => group.id === workspace?.activeGroupId)
            ? workspace.activeGroupId
            : groups[0].id
    };
}
export function serializeRouteWorkspace(profile, groups, activeGroupId) {
    profile = getRouteProfile(profile);
    if (isIpv4Profile(profile)) {
        const familyGroups = groups.filter(group => Number(group.config.addressFamily) === profile.addressFamily);
        if (!familyGroups.length) familyGroups.push(createRouteGroup(profile));
        return serializeIpv4RouteWorkspace(familyGroups, activeGroupId);
    }
    const active = groups.find(group => group.id === activeGroupId) || groups[0];
    return clone({
        ...active.config,
        routeWorkspace: { version: 1, profile: profile.key, groups, activeGroupId: active.id }
    });
}

const types = [
    'Intra-AS I-PMSI A-D',
    'Inter-AS I-PMSI A-D',
    'S-PMSI A-D',
    'Leaf A-D',
    'Source Active A-D',
    'Shared Tree Join',
    'Source Tree Join'
].map((label, index) => ({ label: `Type ${index + 1} · ${label}`, value: index + 1 }));
export const MVPN_ROUTE_TYPES = types;
const condition = routeTypes => ({ any: routeTypes.map(equals => ({ field: 'routeType', equals })) });
export function getRouteSections(config, profileKey) {
    const profile = profileKey ? getRouteProfile(profileKey) : profileFor(config);
    if (isVpnEvpnRoute(config)) return getVpnEvpnRouteSections(config, profile);
    const field = (key, label, options = {}) => ({
        key,
        label,
        type: 'input',
        testId: `${profile.testPrefix}-route-${key}-${options.type === 'select' ? 'select' : 'input'}`,
        ...options
    });
    if (isIpv4Profile(profile))
        return IPV4_ROUTE_SECTIONS.map(section => ({
            ...section,
            fields: section.fields
                .filter(field => field.key !== 'addressFamily')
                .map(field => ({
                    ...field,
                    testId: field.testId?.replace('bgp-ipv4-', `${profile.testPrefix}-`)
                }))
        }));
    const count = field('count', 'Count', {
        help: isMvpn(config)
            ? 'Type 1/4 递增 Orig Router；Type 2 递增 Source AS；其余类型递增 Group IP。'
            : isQp(config)
              ? '生成的路由数量；IP 前缀与 DQPN 分别按各自规则逐条取值。'
              : '生成的 NLRI 数；添加 ADD-PATH 后总路由数为 Count × 每前缀路径数。'
    });
    let fields;
    if (isMvpn(config)) {
        fields = [
            field('routeType', 'Route Type', { type: 'select', options: types }),
            field('rd', 'RD', { visibleWhen: condition([1, 2, 3, 5, 6, 7]), help: 'ASN:数值或 IPv4:数值。' }),
            field('leafRouteKey', 'Leaf Route Key', {
                type: 'textarea',
                visibleWhen: condition([4]),
                help: '被引用路由的完整 MCAST-VPN NLRI，十六进制字节，包含 Route Type 和 Length。'
            }),
            field('originatingRouterIp', 'Orig Router', { visibleWhen: condition([1, 3, 4]) }),
            field('sourceAs', 'Source AS', { visibleWhen: condition([2, 6, 7]) }),
            field('sourceIp', Number(config.routeType) === 6 ? 'Source IP (C-RP)' : 'Source IP', {
                visibleWhen: condition([3, 5, 6, 7])
            }),
            field('groupIp', 'Group IP', { visibleWhen: condition([3, 5, 6, 7]) }),
            count
        ];
    } else {
        fields = [
            field('prefix', 'Prefix', { help: '起始前缀；按掩码对齐网络地址。' }),
            field('mask', 'Mask', { help: isIpv6(config) ? '前缀长度，0–128。' : '前缀长度，0–32。' }),
            count
        ];
        if (isQp(config) || profile.key === 'ipv6')
            fields.push(
                field('ipStep', 'IP 步长', {
                    help: isQp(config)
                        ? '以子网为单位递增，0 表示固定 IP。DQPN 的生成规则在 DQPN 节点配置，独立生效。'
                        : '以子网为单位递增，默认为 1。例如 /64、步长 2 时，每次跳过一个 /64 子网。'
                })
            );
    }
    return [{ id: 'nlri', fields }];
}
export function compileRouteTreePayload(config, group) {
    if (isIpv4Route(config)) return compileRouteRulePayload(config, group);
    const schemaFields = getRouteSections(config).flatMap(section => section.fields);
    const fields = schemaFields.filter(field => isSchemaFieldVisible(field, config));
    const payload = {
        ...Object.fromEntries(fields.map(field => [field.key, config[field.key]])),
        ...compileRouteRulePayload(config, group)
    };
    for (const field of schemaFields) if (!isSchemaFieldVisible(field, config)) delete payload[field.key];
    for (const key of ['prefix', 'mask', 'rd']) if (!fields.some(field => field.key === key)) delete payload[key];
    return clone(payload);
}
const integer = (value, min, max) =>
    value !== '' &&
    value !== null &&
    value !== undefined &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= min &&
    Number(value) <= max;
const decimalInteger = (value, min, max) => /^\d+$/.test(String(value)) && integer(value, min, max);
function ipNumber(value, bits) {
    const address = ipaddr.parse(String(value));
    if (address.kind() !== (bits === 32 ? 'ipv4' : 'ipv6')) throw new Error('地址族不匹配');
    return address.toByteArray().reduce((result, byte) => result * 256n + BigInt(byte), 0n);
}
function ipString(value, bits) {
    return ipaddr
        .fromByteArray(
            Array.from({ length: bits / 8 }, (_, index) => Number((value >> BigInt(bits - 8 - index * 8)) & 255n))
        )
        .toString();
}
function canonicalRd(value) {
    const [admin, assigned, extra] = String(value ?? '')
        .trim()
        .split(':');
    if (extra !== undefined || !/^\d+$/.test(assigned || '')) throw new Error('RD 格式无效');
    const numeric = /^\d+$/.test(admin);
    const maxAssigned = numeric && Number(admin) <= 65535 ? 0xffffffff : 65535;
    if (
        !integer(assigned, 0, maxAssigned) ||
        (numeric ? !integer(admin, 0, 0xffffffff) : ipaddr.parse(admin).kind() !== 'ipv4')
    )
        throw new Error('RD 范围无效');
    return `${numeric ? Number(admin) : ipaddr.parse(admin).toString()}:${Number(assigned)}`;
}
function leafHex(value) {
    const text = String(value || '')
        .replace(/\s/g, '')
        .toLowerCase();
    if (!text || !/^(?:[\da-f]{2})+$/.test(text) || text.length / 2 > 251)
        throw new Error('请输入 1–251 字节的十六进制 Route Key');
    return text;
}
export function validateRouteConfig(config) {
    const errors = {};
    const check = (key, test, message) => {
        try {
            if (!test()) errors[key] = message;
        } catch (_error) {
            errors[key] = message;
        }
    };
    check(
        'count',
        () => (isIpv4Route(config) ? decimalInteger : integer)(config.count, 1, Number.MAX_SAFE_INTEGER),
        '数量必须为正整数'
    );
    if (!errors.count && !getGeneratedRouteCount(config)) errors.count = '生成路由总数超出安全整数范围';
    if (isVpnEvpnRoute(config)) {
        Object.assign(errors, validateVpnEvpnRouteConfig(config));
    } else if (isMvpn(config)) {
        check('routeType', () => integer(config.routeType, 1, 7), '请选择路由类型');
        for (const field of getRouteSections(config)
            .flatMap(section => section.fields)
            .filter(field => isSchemaFieldVisible(field, config))) {
            if (['sourceIp', 'groupIp', 'originatingRouterIp'].includes(field.key))
                check(field.key, () => ipNumber(config[field.key], 32) >= 0n, '请输入有效的 IPv4 地址');
            if (field.key === 'rd') check('rd', () => Boolean(canonicalRd(config.rd)), '请输入有效的 RD');
            if (field.key === 'sourceAs')
                check('sourceAs', () => integer(config.sourceAs, 0, 0xffffffff), 'AS 范围为 0–4294967295');
            if (field.key === 'leafRouteKey')
                check(
                    'leafRouteKey',
                    () => Boolean(leafHex(config.leafRouteKey)),
                    '请输入有效的十六进制 Route Key（1–251 字节）'
                );
        }
    } else {
        const bits = isIpv6(config) ? 128 : 32;
        check(
            'prefix',
            () => (!isIpv4Route(config) || isValidIpv4(config.prefix)) && ipNumber(config.prefix, bits) >= 0n,
            `请输入有效的 IPv${bits === 128 ? 6 : 4} 地址`
        );
        check(
            'mask',
            () => (isIpv4Route(config) ? decimalInteger : integer)(config.mask, 0, bits),
            `前缀长度范围为 0–${bits}`
        );
        check(
            'ipStep',
            () =>
                (isIpv4Route(config) ? decimalInteger : integer)(
                    config.ipStep === undefined ? 1 : config.ipStep,
                    isQp(config) ? 0 : 1,
                    Number.MAX_SAFE_INTEGER
                ),
            isQp(config) ? 'IP 步长必须为非负整数，0 表示固定 IP' : 'IP 步长必须为正整数'
        );
    }
    for (const rule of getRouteTreeRules(config).filter(
        rule => isAttributeRuleApplicable(rule, config) && (rule.type !== 'mpNextHop' || isMpNlriEncoding(config))
    )) {
        const error = validateAttributeRule(rule, config);
        if (error) errors[`rule:${rule.id}`] = error;
    }
    if (!Object.keys(errors).length) {
        try {
            routeSequences(config);
        } catch (error) {
            errors.count = error.message;
        }
    }
    return errors;
}

// Each sequence represents complete NLRI keys, so masks, DQPN and MVPN fields
// stay independent. Path ID and path attributes never enter the signature.
function routeSequences(config) {
    const count = BigInt(config.count);
    if (count < 1n) throw new Error('数量必须为正整数');
    const af = Number(config.addressFamily);
    if (isVpnEvpnRoute(config)) return getVpnEvpnRouteSequences(config);
    if (isMvpn(config)) {
        const type = Number(config.routeType);
        const variable = type === 2 ? 'sourceAs' : [1, 4].includes(type) ? 'originatingRouterIp' : 'groupIp';
        const start = type === 2 ? BigInt(config.sourceAs) : ipNumber(config[variable], 32);
        if (start + count - 1n > 0xffffffffn) throw new Error('生成范围超出 IPv4 地址或 AS 空间');
        const fixed = type === 4 ? ['leaf', leafHex(config.leafRouteKey)] : ['rd', canonicalRd(config.rd)];
        if ([3, 5, 6, 7].includes(type)) fixed.push('source', ipaddr.parse(config.sourceIp).toString());
        if ([6, 7].includes(type)) fixed.push('as', Number(config.sourceAs));
        if (type === 3) fixed.push('origin', ipaddr.parse(config.originatingRouterIp).toString());
        return [
            {
                signature: JSON.stringify([af, type, ...fixed]),
                start: [start],
                step: [1n],
                count,
                format: value =>
                    `${type === 2 ? `Source AS ${value[0]}` : `${variable === 'originatingRouterIp' ? 'Orig Router' : 'Group IP'} ${ipString(value[0], 32)}`} · Type ${type}`
            }
        ];
    }
    const bits = isIpv6(config) ? 128 : 32;
    const mask = Number(config.mask);
    const ipStep = config.ipStep === undefined ? 1 : config.ipStep;
    if (!integer(ipStep, isQp(config) ? 0 : 1, Number.MAX_SAFE_INTEGER))
        throw new Error(isQp(config) ? 'IP 步长必须为非负整数，0 表示固定 IP' : 'IP 步长必须为正整数');
    const subnet = 1n << BigInt(bits - mask);
    const start = (ipNumber(config.prefix, bits) / subnet) * subnet;
    const step = subnet * BigInt(ipStep);
    if (start + step * (count - 1n) >= 1n << BigInt(bits)) throw new Error('生成范围超出 IP 地址空间');
    const rd = isQp(config)
        ? ''
        : isIpv4Route(config)
          ? String(config.rd ?? '') || '0:0'
          : canonicalRd(config.rd || '0:0');
    const signature = JSON.stringify([af, mask, rd]);
    const format = value => `${ipString(value[0], bits)}/${mask}${value.length > 1 ? ` · DQPN ${value[1]}` : ''}`;
    if (!isQp(config)) return [{ signature, start: [start], step: [step], count, format }];
    const rule = (config.nlriRules || []).find(rule => rule.type === 'dqpn');
    if (!rule) {
        if (count > 1n && step === 0n) throw new Error('未添加 DQPN 节点时，请让 IP 递增或将 Count 设为 1');
        return [{ signature: `${signature}:dqpn-absent`, start: [start], step: [step], count, format }];
    }
    if (rule.mode === 'random') return []; // Actual generated keys are checked transactionally by the worker.
    if (rule.mode === 'list') {
        if (
            step === 0n &&
            new Set(rule.values.slice(0, Math.min(Number(count), rule.values.length)).map(Number)).size <
                Math.min(Number(count), rule.values.length)
        )
            throw new Error('DQPN 值列表生成重复 NLRI；请调整值列表或让 IP 递增');
        return rule.values.map((value, offset) => {
            const length = BigInt(rule.values.length);
            const remaining = count > BigInt(offset) ? (count - 1n - BigInt(offset)) / length + 1n : 0n;
            if (remaining > 1n && step === 0n)
                throw new Error('DQPN 值列表循环会生成重复 NLRI；请减少 Count 或让 IP 递增');
            return {
                signature,
                start: [start + step * BigInt(offset), BigInt(value)],
                step: [step * length, 0n],
                count: remaining,
                format
            };
        });
    }
    const dqpn = BigInt(
        rule.mode === 'increment'
            ? rule.start
            : rule.mode === 'list'
              ? rule.values[0]
              : rule.mode === 'random'
                ? rule.min
                : rule.value
    );
    const dqpnStep = rule.mode === 'increment' ? BigInt(rule.step) : 0n;
    const last = dqpn + dqpnStep * (count - 1n);
    if (last < 0n || last > 0xffffffn) throw new Error('DQPN 生成范围超出 0–16777215');
    if (count > 1n && step === 0n && dqpnStep === 0n) throw new Error('当前规则生成重复 NLRI；请让 IP 或 DQPN 递增');
    return [{ signature, start: [start, dqpn], step: [step, dqpnStep], count, format }];
}
export function findRouteGroupOverlap(groups, groupId) {
    const active = groups.find(group => group.id === groupId);
    if (!active) return null;
    if (isIpv4Route(active.config)) return findIpv4RouteGroupOverlap(groups, groupId);
    let ranges;
    try {
        ranges = routeSequences(active.config);
    } catch (_error) {
        return null;
    }
    for (const group of groups.filter(group => group.id !== groupId)) {
        let others;
        try {
            others = routeSequences(group.config);
        } catch (_error) {
            continue;
        }
        for (const range of ranges)
            for (const other of others) {
                const match = intersectRouteSequences(range, other);
                if (match)
                    return {
                        groupId: group.id,
                        groupName: group.name,
                        prefix: range.format(match),
                        nlri: range.format(match),
                        mask: active.config.mask,
                        addressFamily: Number(active.config.addressFamily)
                    };
            }
    }
    return null;
}
export function describeRouteRange(config) {
    if (isIpv4Route(config)) return describeIpv4RouteRange(config);
    try {
        const range = routeSequences(config)[0];
        if (!range)
            return `${isEvpnRoute(config) ? `Type ${config.routeType}` : `${config.prefix}/${config.mask}`} · ${isVpnEvpnRoute(config) ? 'RD' : 'DQPN'} 按随机规则生成`;
        const span = `${range.format(range.start)} → ${range.format(range.start.map((value, index) => value + range.step[index] * (range.count - 1n)))}`;
        return !isQp(config) && !isMvpn(config) && Number(config.ipStep ?? 1) > 1
            ? `${span} · 步长 ${config.ipStep}`
            : span;
    } catch (error) {
        return error.message;
    }
}
export const describeRouteNlri = config =>
    isVpnEvpnRoute(config)
        ? describeVpnEvpnRouteNlri(config)
        : isMvpn(config)
          ? `Type ${config.routeType} · ${Number(config.count) || 0} 条路由`
          : `${config.prefix}/${config.mask} · ${Number(config.count) || 0} 个 NLRI`;
export function getRouteResultColumns(config) {
    if (isVpnEvpnRoute(config)) {
        const primary = getVpnEvpnRouteResultColumns(config);
        return [
            ...primary,
            ...getAttributeResultColumns(config).filter(
                column =>
                    !primary.some(item => item.key === column.key) &&
                    !(isEvpnRoute(config) && ['label', 'label2', 'vni', 'vni2'].includes(column.key))
            )
        ];
    }
    const column = (key, title, width = 140) => ({ key, dataIndex: key, title, width, ellipsis: true });
    const primary = isMvpn(config)
        ? [
              ...(Number(config.routeType) === 4
                  ? [column('leafRouteKey', 'Leaf Route Key', 220)]
                  : [column('rd', 'RD')]),
              ...([1, 3, 4].includes(Number(config.routeType)) ? [column('originatingRouterIp', 'Orig Router')] : []),
              ...([2, 6, 7].includes(Number(config.routeType)) ? [column('sourceAs', 'Source AS')] : []),
              ...([3, 5, 6, 7].includes(Number(config.routeType))
                  ? [
                        column('sourceIp', Number(config.routeType) === 6 ? 'Source IP (C-RP)' : 'Source IP'),
                        column('groupIp', 'Group IP')
                    ]
                  : [])
          ]
        : [
              {
                  ...column('ip', '前缀', isIpv6(config) ? 240 : 140),
                  customRender: ({ record }) => `${record.ip}/${record.mask}`
              }
          ];
    return [...primary, ...getAttributeResultColumns(config)];
}
