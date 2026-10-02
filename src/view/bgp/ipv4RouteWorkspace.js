import { BGP_ADDR_FAMILY } from '../../const/bgpConst';
import { createIpv4RouteConfig } from './ipv4RouteSchema';
import { intersectRouteSequences } from './bgpRouteRange';
import {
    normalizeAttributeRules,
    getDefaultAttributeRules,
    getDefaultNlriRules,
    normalizeRouteRuleSections,
    getGeneratedPrefixCount
} from './bgpAttributeRules';

let groupSequence = 0;
const WORKSPACE_VERSION = 6;

export function createIpv4RouteGroup(name = '路由组 1', config = {}) {
    const defaults = createIpv4RouteConfig();
    const normalized = { ...defaults, ...JSON.parse(JSON.stringify(config)) };
    delete normalized.routeWorkspace;
    delete normalized.autoPathId;
    if (![BGP_ADDR_FAMILY.IPV4_UNC, BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST].includes(Number(normalized.addressFamily))) {
        normalized.addressFamily = BGP_ADDR_FAMILY.IPV4_UNC;
    }
    normalized.addressFamily = Number(normalized.addressFamily);
    normalized.attributeRules = normalizeAttributeRules(
        Array.isArray(config.attributeRules)
            ? config.attributeRules
            : getDefaultAttributeRules(normalized.addressFamily)
    );
    normalized.nlriRules = normalizeAttributeRules(
        Array.isArray(config.nlriRules) ? config.nlriRules : getDefaultNlriRules(normalized.addressFamily)
    );
    const routeConfig = normalizeRouteRuleSections(normalized);
    return {
        id: `ipv4-group-${Date.now().toString(36)}-${++groupSequence}`,
        name,
        config: routeConfig
    };
}

export function restoreIpv4RouteWorkspace(savedConfig) {
    const workspace = savedConfig?.routeWorkspace;
    const usedIds = new Set();
    const groups =
        workspace?.version === WORKSPACE_VERSION && Array.isArray(workspace.groups)
            ? workspace.groups
                  .filter(group => group && typeof group.config === 'object' && group.config !== null)
                  .map((group, index) => {
                      const restored = createIpv4RouteGroup(
                          typeof group.name === 'string' && group.name.trim() ? group.name : `路由组 ${index + 1}`,
                          group.config
                      );
                      if (typeof group.id === 'string' && group.id && !usedIds.has(group.id)) restored.id = group.id;
                      usedIds.add(restored.id);
                      return restored;
                  })
            : [];
    if (!groups.length) groups.push(createIpv4RouteGroup());
    return {
        groups,
        activeGroupId: groups.some(group => group.id === workspace?.activeGroupId)
            ? workspace.activeGroupId
            : groups[0].id
    };
}

export function serializeIpv4RouteWorkspace(groups, activeGroupId) {
    const activeGroup = groups.find(group => group.id === activeGroupId) || groups[0];
    return JSON.parse(
        JSON.stringify({
            ...activeGroup.config,
            routeWorkspace: { version: WORKSPACE_VERSION, activeGroupId: activeGroup.id, groups }
        })
    );
}

function ipv4RouteRange(config) {
    const parts = String(config.prefix).split('.');
    const mask = Number(config.mask);
    const count = Number(config.count);
    const ipStep = Number(config.ipStep === undefined ? 1 : config.ipStep);
    if (
        parts.length !== 4 ||
        parts.some(part => !/^\d+$/.test(part) || Number(part) > 255) ||
        config.mask === undefined ||
        config.mask === null ||
        config.mask === '' ||
        !Number.isInteger(mask) ||
        mask < 0 ||
        mask > 32 ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        !Number.isSafeInteger(ipStep) ||
        ipStep < 1
    )
        return null;
    const address = parts.reduce((value, part) => value * 256 + Number(part), 0);
    const subnet = 1n << BigInt(32 - mask);
    const start = (BigInt(address) / subnet) * subnet;
    const step = subnet * BigInt(ipStep);
    const prefixCount = getGeneratedPrefixCount(config);
    if (prefixCount < 1) return null;
    const countBigInt = BigInt(prefixCount);
    const last = start + (countBigInt - 1n) * step;
    const addressFamily = Number(config.addressFamily);
    return {
        start: [start],
        step: [step],
        count: countBigInt,
        last,
        mask,
        addressFamily,
        signature: JSON.stringify([addressFamily, mask, canonicalRd(config.rd)])
    };
}

const toAddress = value => [24, 16, 8, 0].map(shift => Math.floor(Number(value) / 2 ** shift) % 256).join('.');

function canonicalRd(value) {
    const text = String(value || '0:0').trim();
    const parts = text.split(':');
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return text;
    const administrator = /^\d+$/.test(parts[0])
        ? String(Number(parts[0]))
        : /^(\d{1,3}\.){3}\d{1,3}$/.test(parts[0])
          ? parts[0].split('.').map(Number).join('.')
          : parts[0];
    return `${administrator}:${Number(parts[1])}`;
}

export function describeIpv4RouteRange(config) {
    const range = ipv4RouteRange(config);
    if (!range) return '填写前缀和数量以预览范围';
    if (range.last > 0xffffffffn) return '生成范围超出 IPv4 地址空间';
    const span = `${toAddress(range.start[0])}/${range.mask} → ${toAddress(range.last)}/${range.mask}`;
    return Number(config.ipStep ?? 1) > 1 ? `${span} · 步长 ${config.ipStep}` : span;
}

// Exact NLRI keys: a covering /24 and a /25 are separate routes.
// Intersect sparse sequences without allocating one key per prefix or path.
export function findIpv4RouteGroupOverlap(groups, groupId) {
    const active = groups.find(group => group.id === groupId);
    const range = active && ipv4RouteRange(active.config);
    if (!range || range.last > 0xffffffffn) return null;
    for (const group of groups) {
        if (group.id === groupId) continue;
        const other = ipv4RouteRange(group.config);
        if (!other || other.last > 0xffffffffn) continue;
        const match = intersectRouteSequences(range, other);
        if (match)
            return {
                groupId: group.id,
                groupName: group.name,
                prefix: toAddress(match[0]),
                mask: range.mask,
                addressFamily: range.addressFamily
            };
    }
    return null;
}
