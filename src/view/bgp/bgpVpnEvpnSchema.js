import ipaddr from 'ipaddr.js';
import { BGP_ADDR_FAMILY as AF } from '../../const/bgpConst';
import routeDistinguisher from '../../../shared/bgpRouteDistinguisher.js';
import evpnSrv6 from '../../../shared/bgpEvpnSrv6.js';
import {
    ATTRIBUTE_CATALOG,
    createAttributeRule,
    normalizeAttributeRules,
    isAttributeRuleApplicable,
    isAttributeRuleRequired,
    describeAttributeRule
} from './bgpAttributeRules';

const { normalizeRouteDistinguisher, parseRouteDistinguisher, composeRouteDistinguisher } = routeDistinguisher;
const { isEvpnPerEs, normalizeEvpnSrv6Parameters } = evpnSrv6;

export const EVPN_ETHERNET_SEGMENT_DEFAULTS = {
    esi: '01:02:00:00:00:00:01:00:00:00'
};

export const VPN_EVPN_ROUTE_PROFILES = {
    vpnv4: {
        title: 'VPNv4',
        addressFamily: AF.VPNV4,
        defaults: {
            prefix: '10.0.0.0',
            mask: '24',
            count: '10',
            ipStep: '1'
        }
    },
    vpnv6: {
        title: 'VPNv6',
        addressFamily: AF.VPNV6,
        defaults: {
            prefix: '2001:db8:100::',
            mask: '64',
            count: '10',
            ipStep: '1'
        }
    },
    evpn: {
        title: 'EVPN',
        addressFamily: AF.L2VPN_EVPN,
        defaults: {
            routeType: 2,
            esi: '00:00:00:00:00:00:00:00:00:00',
            esImportRt: '',
            ethernetTagId: '0',
            ethernetTagStep: '1',
            macAddress: '02:00:00:00:00:01',
            macStep: '1',
            ipAddress: '192.0.2.1',
            originatingRouterIp: '192.0.2.1',
            prefix: '10.0.0.0',
            mask: '24',
            gatewayIp: '0.0.0.0',
            ipStep: '1',
            encapsulationType: 'mpls',
            count: '1'
        }
    }
};

export const EVPN_ROUTE_TYPES = [
    'Ethernet Auto-Discovery',
    'MAC/IP Advertisement',
    'Inclusive Multicast Ethernet Tag',
    'Ethernet Segment',
    'IP Prefix'
].map((label, index) => ({ label: `Type ${index + 1} · ${label}`, value: index + 1 }));

export const isVpnRoute = config => [AF.VPNV4, AF.VPNV6].includes(Number(config.addressFamily));
export const isEvpnRoute = config => Number(config.addressFamily) === AF.L2VPN_EVPN;
export const isVpnEvpnRoute = config => isVpnRoute(config) || isEvpnRoute(config);
export const getEvpnRouteTypeDefaults = config =>
    Number(typeof config === 'object' ? config.routeType : config) === 4 ||
    (typeof config === 'object' && isEvpnPerEs(config))
        ? EVPN_ETHERNET_SEGMENT_DEFAULTS
        : {};
export function normalizeEvpnRouteConfig(config) {
    if (!isEvpnRoute(config)) return config;
    const result = {
        ...config,
        nlriRules: normalizeAttributeRules(config.nlriRules).filter(rule => isAttributeRuleApplicable(rule, config))
    };
    for (const definition of ATTRIBUTE_CATALOG.filter(entry => isAttributeRuleRequired(entry, result)))
        if (!result.nlriRules.some(rule => rule.type === definition.type))
            result.nlriRules.push(createAttributeRule(definition.type, result.addressFamily, result));
    for (const field of ['rd', 'label', 'label2', 'vni', 'vni2']) delete result[field];
    return result;
}
export function normalizeEvpnRouteTypeChange(previous, next) {
    if (!isEvpnRoute(next)) return next;
    const normalized = normalizeEvpnRouteConfig(next);
    const changed =
        Number(previous.routeType) !== Number(next.routeType) ||
        previous.encapsulationType !== next.encapsulationType ||
        isEvpnPerEs(previous) !== isEvpnPerEs(next);
    if (!changed) return normalized;
    if (
        (Number(next.routeType) === 4 || isEvpnPerEs(next)) &&
        String(normalized.esi).trim().replace(/[:-]/g, '') === '0'.repeat(20)
    )
        normalized.esi = EVPN_ETHERNET_SEGMENT_DEFAULTS.esi;
    normalized.nlriRules = normalized.nlriRules.map(rule => {
        const fallback = createAttributeRule(rule.type, normalized.addressFamily, normalized);
        if (rule.type === 'rd' && (Number(next.routeType) === 4 || isEvpnPerEs(next))) {
            const convert = value => {
                try {
                    const rd = parseRouteDistinguisher(value);
                    const assigned =
                        rd.assigned <= 65535 && (!isEvpnPerEs(next) || rd.assigned !== 0) ? rd.assigned : 1;
                    return composeRouteDistinguisher(rd.type === 1 ? rd.base : fallback.base, assigned);
                } catch (_error) {
                    return value;
                }
            };
            return {
                ...rule,
                value: convert(rule.value),
                values: rule.values?.map(convert),
                base: String(rule.base).includes('.') ? rule.base : fallback.base
            };
        }
        if (
            rule.type === 'mpNextHop' &&
            next.encapsulationType === 'srv6' &&
            previous.encapsulationType !== 'srv6' &&
            (rule.mode === 'auto' || (rule.mode === 'fixed' && !String(rule.value).includes(':')))
        )
            return { ...fallback, id: rule.id };
        if (['label', 'vni'].includes(rule.type) && isEvpnPerEs(previous) !== isEvpnPerEs(next))
            return { ...fallback, id: rule.id };
        if (['srv6L2', 'srv6L3'].includes(rule.type) && next.encapsulationType === 'srv6') {
            if (rule.type === 'srv6L2' && (isEvpnPerEs(next) || isEvpnPerEs(previous)))
                return { ...fallback, id: rule.id };
            try {
                normalizeEvpnSrv6Parameters(rule, normalized);
            } catch (_error) {
                return { ...rule, endpointBehavior: fallback.endpointBehavior };
            }
        }
        return rule;
    });
    return normalized;
}
const routeTypes = types => ({ any: types.map(equals => ({ field: 'routeType', equals })) });

export function getVpnEvpnRouteSections(config, profile) {
    const field = (key, label, options = {}) => ({
        key,
        label,
        type: 'input',
        testId: `${profile.testPrefix}-route-${key}-${options.type === 'select' ? 'select' : 'input'}`,
        ...options
    });
    const prefixFields = [
        field('prefix', 'Prefix', { help: '起始前缀；按掩码对齐网络地址。' }),
        field('mask', 'Mask', { help: `前缀长度，0–${Number(config.addressFamily) === AF.VPNV6 ? 128 : 32}。` })
    ];
    if (isVpnRoute(config)) {
        return [
            {
                id: 'nlri',
                fields: [
                    ...prefixFields,
                    field('count', 'Count', { help: '每条前缀独立按 RD、Label 节点规则取值。' }),
                    field('ipStep', 'IP 步长', { help: '以子网为单位递增，默认为 1。' })
                ]
            }
        ];
    }
    return [
        {
            id: 'nlri',
            fields: [
                field('routeType', 'Route Type', { type: 'select', options: EVPN_ROUTE_TYPES }),
                field('esi', 'ESI', {
                    visibleWhen: routeTypes([1, 2, 4, 5]),
                    help: '10 字节十六进制，例如 00:00:00:00:00:00:00:00:00:00。'
                }),
                field('esImportRt', 'ES-Import RT（可选）', {
                    visibleWhen: routeTypes([4]),
                    help: '6 字节 MAC；ESI Type 1/2/3 留空时自动推导，其余 ESI 类型必须填写。'
                }),
                field('ethernetTagId', 'Ethernet Tag ID', {
                    visibleWhen: routeTypes([1, 2, 3, 5]),
                    help: '32 位值，范围 0–4294967295。'
                }),
                field('ethernetTagStep', 'Ethernet Tag 步长', {
                    visibleWhen: routeTypes(isEvpnPerEs(config) ? [] : [1]),
                    help: 'per-ES 的 Tag 固定为 4294967295；可用 RD 递增生成多条路由。'
                }),
                field('macAddress', 'MAC Address', {
                    visibleWhen: routeTypes([2]),
                    help: '例如 02:00:00:00:00:01；按 MAC 步长递增。'
                }),
                field('macStep', 'MAC 步长', { visibleWhen: routeTypes([2]) }),
                field('ipAddress', 'IP Address（可选）', {
                    visibleWhen: routeTypes([2]),
                    help: 'IPv4 或 IPv6；留空生成仅 MAC 路由。'
                }),
                field('originatingRouterIp', 'Originating Router IP', {
                    visibleWhen: routeTypes([3, 4]),
                    help: 'IPv4 或 IPv6 地址。'
                }),
                ...prefixFields.map(item => ({
                    ...item,
                    visibleWhen: routeTypes([5]),
                    ...(item.key === 'mask' ? { help: 'IPv4 为 0–32，IPv6 为 0–128。' } : {})
                })),
                field('gatewayIp', 'Gateway IP', {
                    visibleWhen: routeTypes([5]),
                    help: '与 Prefix 相同地址族；留空使用该地址族的全零地址。'
                }),
                field('ipStep', 'IP 步长', {
                    visibleWhen: routeTypes([2, 3, 4, 5]),
                    help: 'Type 2/3/4 按地址数递增；Type 5 按子网数递增。'
                }),
                field('encapsulationType', '封装类型', {
                    type: 'select',
                    options: [
                        { label: 'MPLS', value: 'mpls' },
                        { label: 'VXLAN', value: 'vxlan' },
                        { label: 'SRv6', value: 'srv6' }
                    ]
                }),
                field('count', 'Count', {
                    help: 'RD 与封装节点独立按规则取值；Type 1 递增 Tag（per-ES 固定）；Type 2 递增 MAC/IP；Type 3/4 递增 Orig Router；Type 5 递增前缀。'
                })
            ]
        }
    ];
}

const integer = (value, min, max) =>
    value !== '' &&
    value !== null &&
    value !== undefined &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= min &&
    Number(value) <= max;
const optional = value => value === undefined || value === null || String(value).trim() === '';
function ipValue(value, expectedBits) {
    const address = ipaddr.parse(String(value).trim());
    const bits = address.kind() === 'ipv4' ? 32 : 128;
    if (expectedBits && bits !== expectedBits) throw new Error('地址族不匹配');
    return { bits, number: address.toByteArray().reduce((result, byte) => (result << 8n) + BigInt(byte), 0n) };
}
function ipString(value, bits) {
    return ipaddr
        .fromByteArray(
            Array.from({ length: bits / 8 }, (_, index) => Number((value >> BigInt(bits - index * 8 - 8)) & 255n))
        )
        .toString();
}
export function canonicalVpnEvpnRd(value) {
    return normalizeRouteDistinguisher(value);
}
function hexBytes(value, length) {
    const hex = String(value ?? '')
        .trim()
        .replace(/[:-]/g, '')
        .toLowerCase();
    if (!new RegExp(`^[0-9a-f]{${length * 2}}$`).test(hex)) throw new Error('十六进制字节格式无效');
    return hex;
}
const macString = value => value.toString(16).padStart(12, '0').match(/../g).join(':');

export function validateVpnEvpnRouteConfig(config) {
    const errors = {};
    const check = (key, callback, message) => {
        try {
            if (!callback()) errors[key] = message;
        } catch (_error) {
            errors[key] = message;
        }
    };
    const step = key => check(key, () => integer(config[key] ?? 1, 1, Number.MAX_SAFE_INTEGER), '步长必须为正整数');
    const prefix = bits => {
        let actualBits = bits;
        check('prefix', () => (actualBits = ipValue(config.prefix, bits).bits), '请输入有效且地址族匹配的前缀');
        check('mask', () => integer(config.mask, 0, actualBits || 128), `前缀长度范围为 0–${actualBits || 128}`);
        step('ipStep');
        return actualBits;
    };
    for (const definition of ATTRIBUTE_CATALOG.filter(
        entry => entry.section === 'nlri' && isAttributeRuleApplicable(entry, config)
    )) {
        const rules = (config.nlriRules || []).filter(rule => rule.type === definition.type);
        const required = isAttributeRuleRequired(definition, config);
        if ((required && rules.length !== 1) || (!definition.repeatable && rules.length > 1)) {
            const message = `${required ? 'NLRI 必须包含唯一的' : 'NLRI 不允许重复的'} ${definition.label} 节点`;
            if (!rules.length) errors[`rule:${definition.type}`] = message;
            else rules.forEach(rule => (errors[`rule:${rule.id}`] = message));
        }
    }
    if (isVpnRoute(config)) {
        prefix(Number(config.addressFamily) === AF.VPNV6 ? 128 : 32);
        return errors;
    }
    const type = Number(config.routeType);
    check('routeType', () => integer(type, 1, 5), '请选择 EVPN 路由类型');
    check('encapsulationType', () => ['mpls', 'vxlan', 'srv6'].includes(config.encapsulationType), '请选择封装类型');
    if ([1, 2, 4, 5].includes(type))
        check('esi', () => Boolean(hexBytes(config.esi, 10)), '请输入 10 字节十六进制 ESI');
    if (type === 4 || isEvpnPerEs(config)) {
        check('esi', () => hexBytes(config.esi, 10) !== '0'.repeat(20), 'Ethernet Segment 的 ESI 必须为非零值');
    }
    if (type === 4) {
        check(
            'esImportRt',
            () =>
                optional(config.esImportRt)
                    ? ['01', '02', '03'].includes(hexBytes(config.esi, 10).slice(0, 2))
                    : Boolean(hexBytes(config.esImportRt, 6)),
            '请输入 6 字节 ES-Import RT；只有 ESI Type 1/2/3 可以自动推导'
        );
    }
    if ([1, 2, 3, 5].includes(type))
        check('ethernetTagId', () => integer(config.ethernetTagId, 0, 0xffffffff), 'Ethernet Tag 范围为 0–4294967295');
    if (type === 1 && !isEvpnPerEs(config)) step('ethernetTagStep');
    if (type === 2) {
        check('macAddress', () => Boolean(hexBytes(config.macAddress, 6)), '请输入有效的 MAC 地址');
        step('macStep');
        if (!optional(config.ipAddress))
            check('ipAddress', () => ipValue(config.ipAddress).bits, '请输入有效的 IP 地址');
    }
    if ([3, 4].includes(type))
        check('originatingRouterIp', () => ipValue(config.originatingRouterIp).bits, '请输入有效的 IP 地址');
    if ([2, 3, 4].includes(type)) step('ipStep');
    if (type === 5) {
        const bits = prefix();
        if (!optional(config.gatewayIp))
            check('gatewayIp', () => ipValue(config.gatewayIp, bits).bits, 'Gateway IP 必须与 Prefix 地址族相同');
        if (!errors.esi && !errors.gatewayIp)
            check(
                'gatewayIp',
                () =>
                    hexBytes(config.esi, 10) === '0'.repeat(20) ||
                    optional(config.gatewayIp) ||
                    ipValue(config.gatewayIp, bits).number === 0n,
                'Type 5 的 ESI 与 Gateway IP 不能同时为非零值'
            );
    }
    return errors;
}

function applyRouteDistinguisherSequence(config, base) {
    const count = base.count;
    const rule = (config.nlriRules || []).find(rule => rule.type === 'rd');
    if (!rule) throw new Error('NLRI 必须包含 RD 节点');
    const sequence = (rd, offset = 0n, period = 1n, rdStep = 0n) => {
        const remaining = count > offset ? (count - 1n - offset) / period + 1n : 0n;
        const assigned = BigInt(rd.assigned);
        const last = assigned + rdStep * (remaining - 1n);
        if (remaining && (last < 0n || last > BigInt(rd.maxAssigned))) throw new Error('RD 生成范围超出数值空间');
        return {
            signature: JSON.stringify([...base.signature, rd.type, rd.base]),
            start: [...base.start.map((value, index) => value + base.step[index] * offset), assigned],
            step: [...base.step.map(value => value * period), rdStep],
            count: remaining,
            format: value =>
                `${isEvpnRoute(config) ? `Type ${config.routeType} · ` : ''}RD ${composeRouteDistinguisher(rd.base, String(value[value.length - 1]))} · ${base.format(value.slice(0, -1))}`
        };
    };
    const fixedIdentity = base.step.every(value => value === 0n);
    if (rule.mode === 'fixed') {
        if (fixedIdentity && count > 1n) throw new Error('固定 NLRI 的 RD 必须变化，避免重复路由');
        return [sequence(parseRouteDistinguisher(rule.value))];
    }
    if (rule.mode === 'increment') {
        if (!integer(rule.step, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) throw new Error('RD 步长无效');
        if (fixedIdentity && count > 1n && Number(rule.step) === 0) throw new Error('固定 NLRI 的 RD 步长不能为 0');
        return [
            sequence(
                parseRouteDistinguisher(composeRouteDistinguisher(rule.base, rule.start)),
                0n,
                1n,
                BigInt(rule.step)
            )
        ];
    }
    if (rule.mode === 'list') {
        if (!Array.isArray(rule.values) || !rule.values.length) throw new Error('RD 值列表为空');
        if (fixedIdentity) {
            const used = rule.values.slice(0, Number(count)).map(normalizeRouteDistinguisher);
            if (count > BigInt(rule.values.length) || new Set(used).size !== used.length)
                throw new Error('固定 NLRI 的 RD 列表不能循环或重复');
        }
        return rule.values
            .map((value, index) => sequence(parseRouteDistinguisher(value), BigInt(index), BigInt(rule.values.length)))
            .filter(item => item.count > 0n);
    }
    if (rule.mode === 'random') {
        composeRouteDistinguisher(rule.base, rule.min);
        composeRouteDistinguisher(rule.base, rule.max);
        if (Number(rule.min) > Number(rule.max)) throw new Error('RD 随机最大值不能小于最小值');
        return []; // The worker checks actual sampled NLRI keys transactionally.
    }
    throw new Error('不支持的 RD 生成方式');
}

function getVpnRouteSequences(config) {
    const count = BigInt(config.count);
    const bits = Number(config.addressFamily) === AF.VPNV6 ? 128 : 32;
    const mask = Number(config.mask);
    const ipStep = config.ipStep ?? 1;
    if (count < 1n || !integer(mask, 0, bits) || !integer(ipStep, 1, Number.MAX_SAFE_INTEGER))
        throw new Error('前缀数量、掩码或 IP 步长无效');
    const subnet = 1n << BigInt(bits - mask);
    const address = ipValue(config.prefix, bits);
    const startIp = (address.number / subnet) * subnet;
    const stride = subnet * BigInt(ipStep);
    if (startIp + stride * (count - 1n) >= 1n << BigInt(bits)) throw new Error('生成范围超出地址或字段空间');
    return applyRouteDistinguisherSequence(config, {
        signature: [Number(config.addressFamily), bits, mask],
        start: [startIp],
        step: [stride],
        count,
        format: value => `${ipString(value[0], bits)}/${mask}`
    });
}

// Labels, ESIs in Type 2/5, and Type 5 gateways are forwarding information,
// not route identity. Keep overlap detection consistent with the worker keys.
export function getVpnEvpnRouteSequences(config) {
    if (isVpnRoute(config)) return getVpnRouteSequences(config);
    const count = BigInt(config.count);
    const af = Number(config.addressFamily);
    const type = Number(config.routeType);
    const signature = [af, type];
    const start = [];
    const step = [];
    const formatters = [];
    const add = (value, stride, bits, format) => {
        const last = value + stride * (count - 1n);
        if (count < 1n || value < 0n || stride < 0n || last >= 1n << BigInt(bits))
            throw new Error('生成范围超出地址或字段空间');
        start.push(value);
        step.push(stride);
        formatters.push(format);
    };
    const addIp = (value, stride, mask) => {
        const address = ipValue(value, af === AF.VPNV4 ? 32 : af === AF.VPNV6 ? 128 : undefined);
        const subnet = mask === undefined ? 1n : 1n << BigInt(address.bits - Number(mask));
        signature.push(address.bits, ...(mask === undefined ? [] : [Number(mask)]));
        add(
            (address.number / subnet) * subnet,
            subnet * BigInt(stride ?? 1),
            address.bits,
            value => `${ipString(value, address.bits)}${mask === undefined ? '' : `/${mask}`}`
        );
    };
    if ([1, 4].includes(type)) signature.push(hexBytes(config.esi, 10));
    if ([2, 3, 5].includes(type)) signature.push(Number(config.ethernetTagId));
    if (type === 1)
        add(
            BigInt(config.ethernetTagId),
            isEvpnPerEs(config) ? 0n : BigInt(config.ethernetTagStep ?? 1),
            32,
            value => `Tag ${value}`
        );
    if (type === 2) {
        add(BigInt(`0x${hexBytes(config.macAddress, 6)}`), BigInt(config.macStep ?? 1), 48, macString);
        if (!optional(config.ipAddress)) addIp(config.ipAddress, config.ipStep);
        else signature.push('mac-only');
    }
    if ([3, 4].includes(type)) addIp(config.originatingRouterIp, config.ipStep);
    if (type === 5) addIp(config.prefix, config.ipStep, config.mask);
    if (!start.length) throw new Error('请选择 EVPN 路由类型');
    return applyRouteDistinguisherSequence(config, {
        signature,
        start,
        step,
        count,
        format: value => value.map((item, index) => formatters[index](item)).join(' · ')
    });
}

export const describeVpnEvpnRouteNlri = config => {
    const rd = (config.nlriRules || []).find(rule => rule.type === 'rd');
    if (isEvpnRoute(config))
        return `Type ${config.routeType} · RD ${rd ? describeAttributeRule(rd) : '未配置'} · ${Number(config.count) || 0} 个 NLRI`;
    return `RD ${rd ? describeAttributeRule(rd) : '未配置'} · ${config.prefix}/${config.mask} · ${Number(config.count) || 0} 个 NLRI`;
};

export function getVpnEvpnRouteResultColumns(config) {
    const column = (key, title, width = 150) => ({ key, dataIndex: key, title, width, ellipsis: true });
    const prefix = {
        ...column('ip', '前缀', Number(config.addressFamily) === AF.VPNV6 ? 240 : 200),
        customRender: ({ record }) => `${record.ip}/${record.mask}`
    };
    if (isVpnRoute(config)) return [column('rd', 'RD'), prefix, column('label', 'MPLS Label', 120)];
    return [
        column('routeType', 'Type', 90),
        column('rd', 'RD'),
        {
            ...column('nlri', 'NLRI', 480),
            customRender: ({ record }) => {
                const type = Number(record.routeType);
                const parts = [];
                if ([1, 2, 3, 5].includes(type)) parts.push(`Tag ${record.ethernetTagId}`);
                if ([1, 4].includes(type)) parts.push(`ESI ${record.esi}`);
                if (type === 2) {
                    parts.push(record.macAddress);
                    if (!optional(record.ipAddress)) parts.push(record.ipAddress);
                }
                if ([3, 4].includes(type)) parts.push(record.originatingRouterIp);
                if (type === 5) {
                    parts.push(`${record.ip ?? record.prefix}/${record.mask}`);
                    if (!optional(record.gatewayIp)) parts.push(`GW ${record.gatewayIp}`);
                }
                return parts.filter(value => !optional(value)).join(' · ') || '—';
            }
        },
        {
            ...column('forwardingLabel', 'Label / VNI', 180),
            customRender: ({ record }) => {
                if (record.encapsulationType === 'srv6') return 'SRv6';
                const vxlan = record.encapsulationType === 'vxlan';
                const values = vxlan ? [record.vni, record.vni2] : [record.label, record.label2];
                const present = values.filter(value => !optional(value));
                return present.length ? `${vxlan ? 'VNI' : 'MPLS'} ${present.join(' / ')}` : '—';
            }
        }
    ];
}
