import ipaddr from 'ipaddr.js';
import registry from '../../../shared/bgpAttributes.json';
import extendedCommunity from '../../../shared/bgpExtendedCommunities.js';
import routeDistinguisher from '../../../shared/bgpRouteDistinguisher.js';
import attributeConditions from '../../../shared/bgpAttributeConditions.js';
import evpnSrv6 from '../../../shared/bgpEvpnSrv6.js';
import { BGP_ADDR_FAMILY } from '../../const/bgpConst';

const { normalizeExtendedCommunities, getExtendedCommunityValueRange } = extendedCommunity;
const {
    normalizeRouteDistinguisher,
    parseRouteDistinguisher,
    composeRouteDistinguisher,
    getRouteDistinguisherValueRange
} = routeDistinguisher;
const { matchesCondition, isAttributeApplicable, isAttributeRequired } = attributeConditions;
const { isEvpnPerEs, normalizeEvpnSrv6Parameters, validateEvpnSrv6Sid } = evpnSrv6;

export const ATTRIBUTE_CATALOG = registry.attributes;
export const ATTRIBUTE_MODES = registry.modes;
const clone = value => JSON.parse(JSON.stringify(value));
const definitionFor = type => ATTRIBUTE_CATALOG.find(entry => entry.type === type);
const typedRouteTargets = value =>
    String(value ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(value => `rt:${value}`)
        .join(' ');
let sequence = 0;

export function createAttributeRule(type, addressFamily, config = {}) {
    const definition = definitionFor(type);
    if (!definition) throw new Error(`不支持的属性：${type}`);
    return {
        id: `attr-${Date.now().toString(36)}-${++sequence}`,
        type,
        ...clone(definition.default),
        ...clone(definition.familyDefaults?.[Number(addressFamily)] || {}),
        ...Object.assign(
            {},
            ...(definition.contextDefaults || [])
                .filter(entry => matchesCondition(entry.when, { ...config, addressFamily }))
                .map(entry => clone(entry.value))
        )
    };
}
export function isAttributeRuleApplicable(rule, config) {
    return isAttributeApplicable(definitionFor(rule.type) || {}, config);
}
export const isAttributeRuleRequired = (rule, config) => isAttributeRequired(definitionFor(rule.type) || {}, config);
export function isMpNlriEncoding(config) {
    return Number(config.addressFamily) !== BGP_ADDR_FAMILY.IPV4_UNC || config.nlriEncoding === 'mpReach';
}
export const getRuleSection = rule => definitionFor(rule?.type)?.section || 'attributes';
export const getRouteTreeRules = config => [...(config.nlriRules || []), ...(config.attributeRules || [])];
function getDefaultRules(addressFamily, section) {
    return ATTRIBUTE_CATALOG.filter(
        entry =>
            getRuleSection(entry) === section &&
            entry.defaultNode &&
            (section === 'nlri' || isAttributeRuleApplicable(entry, { addressFamily }))
    ).map(entry => createAttributeRule(entry.type, addressFamily));
}
export const getDefaultAttributeRules = addressFamily => getDefaultRules(addressFamily, 'attributes');
export const getDefaultNlriRules = addressFamily => getDefaultRules(addressFamily, 'nlri');
export function normalizeAttributeRules(rules) {
    const ids = new Set();
    return (Array.isArray(rules) ? rules : [])
        .filter(rule => rule && typeof rule === 'object' && rule.enabled !== false)
        .map(rule => {
            const result = { ...rule };
            delete result.enabled;
            if (result.type === 'rt') {
                result.type = 'extendedCommunities';
                result.subtype = 'rt';
                if (result.mode === 'fixed' || !result.mode) result.value = typedRouteTargets(result.value);
                if (result.mode === 'list') result.values = (result.values || []).map(typedRouteTargets);
            }
            const definition = definitionFor(result.type);
            if (definition?.valueCountValidation && result.valueCount === undefined)
                result.valueCount = definition.default.valueCount;
            if (!result.id || ids.has(result.id)) result.id = `attr-${Date.now().toString(36)}-${++sequence}`;
            ids.add(result.id);
            return result;
        });
}
export function normalizeRouteRuleSections(config) {
    const attributeRules = (config.attributeRules || []).filter(rule => getRuleSection(rule) === 'attributes');
    const nlriRules = (config.nlriRules || []).filter(rule => getRuleSection(rule) === 'nlri');
    return { ...config, attributeRules, nlriRules };
}
export function getAttributeRuleFields(rule, config = {}) {
    const fields = definitionFor(rule?.type)?.fields;
    if (!fields) return [];
    return [...(fields[rule.mode] || []), ...(fields.common || [])].map(field => {
        const result = { ...field };
        if (['srv6L2', 'srv6L3'].includes(rule.type) && field.key === 'endpointBehavior')
            result.options = field.options.filter(option => {
                try {
                    normalizeEvpnSrv6Parameters(
                        { type: rule.type, ...definitionFor(rule.type).default, endpointBehavior: option.value },
                        config
                    );
                    return true;
                } catch (_error) {
                    return false;
                }
            });
        return result;
    });
}
export const getRuleModeLabel = rule =>
    ATTRIBUTE_MODES.find(mode => mode.value === rule?.mode)?.label || definitionFor(rule?.type)?.label || '';
const pathValue = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
export function getRuleModeHelp(rule, config = {}) {
    const definition = definitionFor(rule?.type);
    const template =
        definition?.modeHelp?.[rule?.mode] ||
        ATTRIBUTE_MODES.find(mode => mode.value === rule?.mode)?.help ||
        definition?.description ||
        '';
    return template.replace(/\{([\w.]+)\}/g, (_match, path) =>
        String(
            pathValue(config, path) ??
                pathValue(rule, path) ??
                pathValue(definition?.default || {}, path) ??
                definition?.default?.value ??
                ''
        )
    );
}
export function describeAttributeRule(rule) {
    const definition = definitionFor(rule.type);
    const template =
        definition?.summary?.[rule.mode] || definition?.summary?.default || registry.summary[rule.mode] || '';
    const summary = template.replace(/\{([\w.]+)\}/g, (_match, path) => String(pathValue(rule, path) ?? ''));
    return definition?.valueCountValidation && ['increment', 'random'].includes(rule.mode)
        ? `${summary} · 每路由 ${rule.valueCount ?? definition.default.valueCount} 个值`
        : summary;
}
export function getGeneratedRouteCount(config) {
    const total = getGeneratedPrefixCount(config) * getGeneratedPathCount(config);
    return Number.isSafeInteger(total) ? total : 0;
}
export function getGeneratedPathCount(config) {
    const rule = (config.nlriRules || []).find(
        rule => rule.type === 'addPath' && isAttributeRuleApplicable(rule, config)
    );
    if (!rule) return 1;
    const count = Number(rule.count);
    return Number.isSafeInteger(count) && count >= 1 && count <= 0x100000000 ? count : 0;
}
export function getGeneratedPrefixCount(config) {
    const count = Number(config.count);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}
export function getAttributeResultColumns(config) {
    const entries = getRouteTreeRules(config)
        .filter(
            rule =>
                isAttributeRuleApplicable(rule, config) &&
                (definitionFor(rule.type)?.treeGroup !== 'mpNlri' || isMpNlriEncoding(config))
        )
        .map(rule => ({ rule, column: definitionFor(rule.type)?.resultColumn }))
        .filter(entry => entry.column);
    const seenTypes = new Map();
    return entries.map(({ rule, column }) => {
        const ordinal = seenTypes.get(rule.type) || 0;
        seenTypes.set(rule.type, ordinal + 1);
        const repeated = entries.filter(entry => entry.rule.type === rule.type).length > 1;
        return {
            ...column,
            title: repeated ? `${column.title} #${ordinal + 1}` : column.title,
            key: repeated ? `${column.key}:${ordinal}` : column.key,
            dataIndex: column.key,
            ellipsis: true,
            customRender: ({ text, record }) => {
                if (['srv6L2', 'srv6L3'].includes(rule.type))
                    text = record?.srv6Services?.find(
                        entry => entry.serviceType === (rule.type === 'srv6L2' ? 'l2' : 'l3')
                    )?.sid;
                if (getRuleSection(rule) === 'attributes' && Array.isArray(record?.pathAttributes)) {
                    const instances = record.pathAttributes.filter(
                        item => item.type === rule.type || (rule.type === 'extendedCommunities' && item.type === 'rt')
                    );
                    const instance = instances.find(item => item.ruleId === rule.id) || instances[ordinal];
                    text = instance?.type === 'rt' ? typedRouteTargets(instance.value) : instance?.value;
                }
                if (rule.type === 'extendedCommunities' && (text === undefined || text?.length === 0) && record?.rt) {
                    text = typedRouteTargets(record.rt);
                }
                if (text === null || text === undefined || text === '') return '—';
                const option = column.options?.find(item => String(item.value) === String(text));
                const value = Array.isArray(text) ? text.join(' ') : text;
                return option?.label ?? (value === '' ? '—' : value);
            }
        };
    });
}
export function compileRouteRulePayload(config, group = {}) {
    const withoutToggle = rule => {
        const result = { ...rule };
        delete result.enabled;
        return result;
    };
    return clone({
        ...Object.fromEntries(Object.keys(registry.route.defaults).map(key => [key, config[key]])),
        ...(group.id ? { groupId: group.id, groupName: group.name } : {}),
        ...(config.rd !== undefined ? { rd: config.rd } : {}),
        nlriRules: (config.nlriRules || [])
            .filter(
                rule =>
                    isAttributeRuleApplicable(rule, config) &&
                    (definitionFor(rule.type)?.treeGroup !== 'mpNlri' || isMpNlriEncoding(config))
            )
            .map(withoutToggle),
        attributeRules: (config.attributeRules || [])
            .filter(rule => isAttributeRuleApplicable(rule, config))
            .map(withoutToggle)
    });
}

function integer(value, min, max) {
    const number = Number(value);
    if (
        value === '' ||
        value === undefined ||
        value === null ||
        !Number.isSafeInteger(number) ||
        number < min ||
        number > max
    )
        throw new Error(`数值范围为 ${min}–${max}`);
    return number;
}
function ipv4Number(value) {
    const parts = String(value).split('.');
    if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part) || Number(part) > 255))
        throw new Error('IPv4 地址无效');
    return parts.reduce((number, part) => number * 256 + Number(part), 0);
}
function ipv4String(value) {
    integer(value, 0, 0xffffffff);
    return [24, 16, 8, 0].map(shift => Math.floor(value / 2 ** shift) % 256).join('.');
}
function ipv6Number(value) {
    const address = ipaddr.parse(String(value));
    if (address.kind() !== 'ipv6') throw new Error('SID 必须是 IPv6 地址');
    return address.toByteArray().reduce((number, byte) => (number << 8n) + BigInt(byte), 0n);
}
function ipv6String(value) {
    if (value < 0n || value >= 1n << 128n) throw new Error('SID 超出 IPv6 地址范围');
    return ipaddr
        .fromByteArray(Array.from({ length: 16 }, (_, index) => Number((value >> BigInt((15 - index) * 8)) & 255n)))
        .toString();
}
function ipNumber(value) {
    return String(value).includes(':')
        ? { bits: 128, number: ipv6Number(value) }
        : { bits: 32, number: BigInt(ipv4Number(value)) };
}
function ipString(number, bits) {
    if (number < 0n || number >= 1n << BigInt(bits)) throw new Error('下一跳超出地址范围');
    return bits === 128 ? ipv6String(number) : ipv4String(Number(number));
}
function boundsFor(rule, definition) {
    if (definition.valueType === 'extendedCommunity')
        return getExtendedCommunityValueRange(rule.base ?? definition.default.base);
    if (definition.valueType === 'rd') return getRouteDistinguisherValueRange(rule.base);
    return [definition.validation?.min ?? 0, definition.validation?.max ?? 0xffffffff];
}
function checkValue(rule, value, definition, config = {}) {
    const kind = definition.valueType;
    if (kind === 'rd') {
        const rd = normalizeRouteDistinguisher(value);
        if (
            Number(config.addressFamily) === BGP_ADDR_FAMILY.L2VPN_EVPN &&
            (Number(config.routeType) === 4 || isEvpnPerEs(config)) &&
            parseRouteDistinguisher(rd).type !== 1
        )
            throw new Error('当前 EVPN 路由的 RD 必须使用 IPv4 管理员');
        if (
            Number(config.addressFamily) === BGP_ADDR_FAMILY.L2VPN_EVPN &&
            isEvpnPerEs(config) &&
            parseRouteDistinguisher(rd).assigned === 0
        )
            throw new Error('EVPN per-ES 路由的 RD 数值必须为非零值');
        return rd;
    }
    if (kind === 'extendedCommunity') return normalizeExtendedCommunities(value);
    if (kind === 'ipv4') return ipv4String(ipv4Number(value));
    if (kind === 'ipAddress') {
        const address = ipNumber(value);
        if (
            rule.type === 'mpNextHop' &&
            config.encapsulationType === 'srv6' &&
            Number(config.addressFamily) === BGP_ADDR_FAMILY.L2VPN_EVPN &&
            address.bits !== 128
        )
            throw new Error('EVPN SRv6 的 MP Next Hop 必须为 IPv6 地址');
        return ipString(address.number, address.bits);
    }
    if (kind === 'srv6' || kind === 'ipv6') {
        const sid = ipv6String(ipv6Number(value));
        if (['srv6L2', 'srv6L3'].includes(rule.type))
            validateEvpnSrv6Sid(sid, normalizeEvpnSrv6Parameters(rule, config), config);
        return sid;
    }
    if (kind === 'asPath') {
        const parts = String(value ?? '')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        if (parts.length > definition.validation.maxLength) throw new Error('路径长度范围为 1–255');
        parts.forEach(part => integer(part, ...boundsFor(rule, definition)));
        return parts.join(' ');
    }
    if (kind === 'community') {
        const values = (Array.isArray(value) ? value.join(' ') : String(value ?? ''))
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        values.forEach(item => {
            const parts = item.split(':');
            if (parts.length !== 2) throw new Error('属性格式应为 ASN:数值');
            integer(parts[0], 0, 65535);
            integer(parts[1], 0, 65535);
        });
        return values.join(' ');
    }
    if (kind === 'raw') {
        const hex = String(value ?? '');
        if (/[^\da-f\s]/i.test(hex) || hex.replace(/\s/g, '').length % 2) throw new Error('请输入完整的十六进制字节');
        if (rule.typeCode !== '' && rule.typeCode !== undefined && rule.typeCode !== null) {
            integer(rule.typeCode, 1, 255);
            integer(rule.flags, 0, 255);
        }
        return value;
    }
    if (
        Number(config.addressFamily) === BGP_ADDR_FAMILY.L2VPN_EVPN &&
        isEvpnPerEs(config) &&
        ['label', 'vni'].includes(rule.type) &&
        Number(value) !== 0
    )
        throw new Error('EVPN per-ES 的 Label / VNI 必须为 0');
    return integer(value, ...boundsFor(rule, definition));
}

// Stable preview samples. The worker independently generates the actual route values.
export function previewAttributeRule(rule, index = 0, config = {}, throwErrors = false) {
    try {
        const definition = definitionFor(rule.type);
        if (!definition) throw new Error('不支持的属性类型');
        if (rule.type === 'addPath') return String(index % integer(rule.count, 1, 0x100000000));
        if (rule.mode === 'auto') {
            if (definition.autoValueKey)
                return String(
                    checkValue(
                        rule,
                        config[definition.autoValueKey] ?? rule.value ?? definition.default.value,
                        definition
                    )
                );
            return getRuleModeHelp(rule, config);
        }
        const sample = [0.15, 0.52, 0.91][index % 3];
        const random = (min, max) => {
            min = integer(min, ...boundsFor(rule, definition));
            max = integer(max, min, boundsFor(rule, definition)[1]);
            return min + Math.floor(sample * (max - min + 1));
        };
        let value;
        if (rule.mode === 'list') {
            if (!rule.values?.length) throw new Error('值列表为空');
            value = rule.values[index % rule.values.length];
        } else if (rule.mode === 'fixed') value = rule.value;
        else if (definition.valueType === 'rd') {
            const base = rule.base;
            const bounds = boundsFor(rule, definition);
            let assigned;
            if (rule.mode === 'increment') {
                assigned =
                    BigInt(integer(rule.start, ...bounds)) +
                    BigInt(index) * BigInt(integer(rule.step, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
                if (assigned < BigInt(bounds[0]) || assigned > BigInt(bounds[1]))
                    throw new Error(`RD 数值范围为 ${bounds[0]}–${bounds[1]}`);
            } else {
                const min = integer(rule.min, ...bounds);
                const max = integer(rule.max, min, bounds[1]);
                assigned = min + Math.floor(sample * (max - min + 1));
            }
            value = composeRouteDistinguisher(base, String(assigned));
        } else if (definition.valueCountValidation) {
            const valueCount = integer(
                rule.valueCount === undefined ? definition.default.valueCount : rule.valueCount,
                definition.valueCountValidation.min,
                definition.valueCountValidation.max
            );
            if (!Number.isSafeInteger(getGeneratedRouteCount(config) * valueCount))
                throw new Error('生成属性值总数超出安全整数范围');
            const bounds = boundsFor(rule, definition);
            const start = rule.mode === 'increment' ? BigInt(integer(rule.start, ...bounds)) : null;
            const step = rule.mode === 'increment' ? BigInt(integer(rule.step, -0xffffffff, 0xffffffff)) : null;
            const min = rule.mode === 'random' ? integer(rule.min, ...bounds) : null;
            const max = rule.mode === 'random' ? integer(rule.max, min, bounds[1]) : null;
            value = Array.from({ length: valueCount }, (_, offset) => {
                const valueIndex = index * valueCount + offset;
                if (!Number.isSafeInteger(valueIndex)) throw new Error('生成属性值索引超出安全整数范围');
                const number =
                    rule.mode === 'increment'
                        ? Number(start + BigInt(valueIndex) * step)
                        : min + Math.floor([0.15, 0.52, 0.91][valueIndex % 3] * (max - min + 1));
                integer(number, ...bounds);
                return definition.valueType === 'extendedCommunity'
                    ? `${rule.subtype ?? definition.default.subtype}:${rule.base ?? definition.default.base}:${number}`
                    : `${rule.base ?? definition.default.base}:${number}`;
            });
        } else if (definition.valueType === 'ipAddress' || definition.valueType === 'ipv6') {
            const start = ipNumber(rule.mode === 'increment' ? rule.start : rule.min);
            let number;
            if (rule.mode === 'increment') {
                const step = BigInt(integer(rule.step, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
                number = start.number + BigInt(index) * step;
            } else {
                const end = ipNumber(rule.max);
                if (start.bits !== end.bits) throw new Error('随机范围的两个地址必须属于同一地址族');
                if (end.number < start.number) throw new Error('随机最大地址不能小于最小地址');
                number = start.number + ((end.number - start.number + 1n) * BigInt([15, 52, 91][index % 3])) / 100n;
            }
            value = ipString(number, start.bits);
        } else if (definition.valueType === 'srv6') {
            const step = BigInt(rule.step);
            if (step < 0n || (step === 0n && !['srv6L2', 'srv6L3'].includes(rule.type)))
                throw new Error('SID 步长必须为正整数；EVPN 允许 0 表示固定 SID');
            value = ipv6String(ipv6Number(rule.start) + BigInt(index) * step);
        } else if (definition.valueType === 'asPath' && rule.mode === 'random') {
            integer(rule.min, ...boundsFor(rule, definition));
            integer(rule.max, Number(rule.min), boundsFor(rule, definition)[1]);
            const minLength = integer(rule.minLength, 1, definition.validation.maxLength);
            const maxLength = integer(rule.maxLength, minLength, definition.validation.maxLength);
            const length = minLength + Math.floor(sample * (maxLength - minLength + 1));
            value = Array.from(
                { length },
                (_, offset) =>
                    Number(rule.min) +
                    Math.floor(((sample + offset * 0.31) % 1) * (Number(rule.max) - Number(rule.min) + 1))
            ).join(' ');
        } else {
            const ip = definition.valueType === 'ipv4';
            const number =
                rule.mode === 'increment'
                    ? (ip ? ipv4Number(rule.start) : integer(rule.start, ...boundsFor(rule, definition))) +
                      index * integer(rule.step, -0xffffffff, 0xffffffff)
                    : random(ip ? ipv4Number(rule.min) : rule.min, ip ? ipv4Number(rule.max) : rule.max);
            value = ip ? ipv4String(number) : number;
            if (definition.valueType === 'extendedCommunity') value = `${rule.subtype}:${rule.base}:${value}`;
            else if (definition.valueType === 'community') value = `${rule.base}:${value}`;
        }
        value = checkValue(rule, value, definition, config);
        const option = definition.fields?.fixed
            ?.find(field => field.key === 'value')
            ?.options?.find(item => String(item.value) === String(value));
        return option?.label ?? ((Array.isArray(value) ? value.join(' ') : String(value ?? '')) || '空值');
    } catch (error) {
        if (throwErrors) throw error;
        return error.message;
    }
}

export function validateAttributeRule(rule, config = {}) {
    try {
        const definition = definitionFor(rule.type);
        if (!definition || (definition.modes.length && !definition.modes.includes(rule.mode)))
            throw new Error('不支持的节点生成方式');
        if (
            rule.type === 'rd' &&
            Number(config.addressFamily) === BGP_ADDR_FAMILY.L2VPN_EVPN &&
            isEvpnPerEs(config) &&
            rule.mode === 'random' &&
            Number(rule.min) < 1
        )
            throw new Error('EVPN per-ES 路由的 RD 随机范围不能包含 0');
        if (
            Number(config.addressFamily) === BGP_ADDR_FAMILY.L2VPN_EVPN &&
            isEvpnPerEs(config) &&
            ['label', 'vni'].includes(rule.type) &&
            rule.mode === 'random' &&
            (Number(rule.min) !== 0 || Number(rule.max) !== 0)
        )
            throw new Error('EVPN per-ES 的 Label / VNI 随机范围必须为 0–0');
        if (rule.mode === 'list') (rule.values || []).forEach(value => checkValue(rule, value, definition, config));
        if (['srv6L2', 'srv6L3'].includes(rule.type) && rule.mode === 'increment') {
            const parameters = normalizeEvpnSrv6Parameters(rule, config);
            const structure = parameters.srv6SidStructure;
            const tail = 128 - structure.locatorBlockLength - structure.locatorNodeLength - structure.functionLength;
            if (BigInt(rule.step) % (1n << BigInt(tail)))
                throw new Error('SID 步长必须保持 Locator 和 Function 之后的位为 0');
        }
        previewAttributeRule(rule, 0, config, true);
        previewAttributeRule(rule, Math.max(0, getGeneratedRouteCount(config) - 1), config, true);
        return '';
    } catch (error) {
        return error.message;
    }
}
