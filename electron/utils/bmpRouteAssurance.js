const crypto = require('crypto');
const ipaddr = require('ipaddr.js');
const BmpConst = require('../const/bmpConst');
const BgpConst = require('../const/bgpConst');
const { getAddrFamilyType, getBgpAfiName, getBgpSafiName } = require('./bgpUtils');
const { parseRouteLensQuery } = require('./bmpRouteLens');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;
const MAX_SORTED_ISSUES = 100_000;
const GLOBAL_VRF = '__global__';
const STAGES = ['preIn', 'postIn', 'locRib', 'preOut', 'postOut'];
const CATEGORIES = ['inbound-gap', 'not-selected', 'not-exported', 'outbound-gap', 'multi-egress-inconsistent'];
const CATEGORY_LABELS = {
    'inbound-gap': '入站阶段缺口',
    'not-selected': '未进入 Loc-RIB',
    'not-exported': '未生成出站路由',
    'outbound-gap': '出站阶段缺口',
    'multi-egress-inconsistent': '多出口属性不一致'
};
const RIB_STAGE_MAP = new Map([
    [BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, 'preIn'],
    [BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN, 'postIn'],
    [BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT, 'preOut'],
    [BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT, 'postOut']
]);
const EGRESS_COMPARE_FIELDS = [
    'origin',
    'asPath',
    'nextHop',
    'localPref',
    'med',
    'communities',
    'otc',
    'prefixSid',
    'labels'
];
const RETAINED_ROUTE_FIELDS = [
    'routeKey',
    'afi',
    'safi',
    'addrFamilyType',
    'ip',
    'mask',
    'rd',
    'pathId',
    'pathStatus',
    'pathStatusText',
    'routeState',
    'routeType',
    'dqpn',
    'dqpnBits',
    ...EGRESS_COMPARE_FIELDS
];
const RETAINED_NLRI_DETAIL_FIELDS = ['prefix', 'rd', 'routeType', 'routeTypeName', 'nlriTypeName', 'dqpn', 'dqpnBits'];

function stableId(parts) {
    return crypto
        .createHash('sha256')
        .update(parts.map(part => String(part ?? '')).join('\u001f'))
        .digest('hex')
        .slice(0, 24);
}

function getRouteAssuranceStage(ribType, scope = 'session') {
    return scope === 'instance' ? 'locRib' : RIB_STAGE_MAP.get(Number(ribType));
}

function makeRouteAssuranceSourceKey({ clientKey, scope = 'session', ownerKey, stage, ribType, routeKey }) {
    const normalizedStage = stage || getRouteAssuranceStage(ribType, scope) || '';
    return [clientKey, scope, ownerKey, normalizedStage, routeKey].map(value => String(value ?? '')).join('\u001f');
}

function normalizedText(value) {
    return value === null || value === undefined ? '' : String(value).trim().toLowerCase();
}

function normalizedRouteState(value) {
    const state = normalizedText(value || BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE);
    return Object.values(BmpConst.BMP_ROUTE_STATE_FILTER).includes(state)
        ? state
        : BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE;
}

function routeStateMatches(route, routeState) {
    return (
        routeState === BmpConst.BMP_ROUTE_STATE_FILTER.ALL ||
        (route?.routeState || BmpConst.BMP_ROUTE_STATE.ACTIVE) === routeState
    );
}

function normalizeNetworkAddress(address, prefixLength) {
    return address.constructor.networkAddressFromCIDR(`${address.toString()}/${prefixLength}`).toString();
}

function getRouteNetwork(route) {
    const rawIp = route?.ip;
    const rawMask = route?.mask;
    const prefixLength = Number(rawMask);
    if (!ipaddr.isValid(String(rawIp || '')) || !Number.isInteger(prefixLength)) {
        return null;
    }
    const address = ipaddr.parse(String(rawIp));
    const maxLength = address.kind() === 'ipv4' ? 32 : 128;
    if (prefixLength < 0 || prefixLength > maxLength) {
        return null;
    }
    const network = normalizeNetworkAddress(address, prefixLength);
    return {
        address,
        family: address.kind(),
        network,
        prefixLength,
        displayPrefix: `${network}/${prefixLength}`
    };
}

function getRouteBaseIdentity(route) {
    const network = getRouteNetwork(route);
    if (network) {
        return network.displayPrefix;
    }
    return String(route?.nlriDetail?.prefix || route?.ip || route?.routeKey || '').trim();
}

function getMvpnRouteTypeName(routeType) {
    return Object.entries(BgpConst.BGP_MVPN_ROUTE_TYPE || {}).find(
        ([, value]) => Number(value) === Number(routeType)
    )?.[0];
}

function getRouteIdentity(route) {
    const baseIdentity = getRouteBaseIdentity(route);
    const routeType = route?.nlriDetail?.routeType ?? route?.routeType;
    if (Number(route?.safi) === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN && routeType !== null && routeType !== undefined) {
        const routeTypeName = getMvpnRouteTypeName(routeType);
        return `mvpn:type=${routeType}${routeTypeName ? `:${routeTypeName.toLowerCase()}` : ''}:0x${baseIdentity}`;
    }
    const dqpn = route?.nlriDetail?.dqpn ?? route?.dqpn;
    if (dqpn !== null && dqpn !== undefined && dqpn !== '') {
        const network = getRouteNetwork(route);
        return `${network ? network.address.toString() : baseIdentity}|dqpn=${dqpn}`;
    }
    return baseIdentity;
}

function getRouteDisplayPrefix(route) {
    const baseDisplay = getRouteBaseIdentity(route) || '-';
    const routeType = route?.nlriDetail?.routeType ?? route?.routeType;
    if (Number(route?.safi) === BgpConst.BGP_SAFI_TYPE.SAFI_MVPN && routeType !== null && routeType !== undefined) {
        const routeTypeName = getMvpnRouteTypeName(routeType);
        return `MVPN ${routeTypeName || `type=${routeType}`} · 0x${baseDisplay}`;
    }
    const dqpn = route?.nlriDetail?.dqpn ?? route?.dqpn;
    if (dqpn !== null && dqpn !== undefined && dqpn !== '') {
        const dqpnBits = route?.nlriDetail?.dqpnBits ?? route?.dqpnBits;
        return `${baseDisplay} · DQPN ${dqpn}${dqpnBits !== null && dqpnBits !== undefined ? `/${dqpnBits}` : ''}`;
    }
    return baseDisplay;
}

function getRouteLensQuery(route) {
    return getRouteIdentity(route);
}

function makeNlriKey(route, vrfTableNames = []) {
    const rd = route?.nlriDetail?.rd || route?.rd || '0:0';
    const dqpn = route?.nlriDetail?.dqpn ?? route?.dqpn ?? '';
    const routeType = route?.nlriDetail?.routeType ?? route?.routeType ?? '';
    const vrf = vrfTableNames.map(normalizedText).sort().join(',') || '-';
    return [route?.afi ?? '', route?.safi ?? '', rd, vrf, getRouteIdentity(route), dqpn, routeType].join('|');
}

function getVrfNames(route, owner) {
    const routeNames = (Array.isArray(route?.routeTlvs) ? route.routeTlvs : [])
        .filter(tlv => tlv?.name === 'VRF/Table Name')
        .map(tlv => tlv.valueText ?? tlv.value)
        .filter(value => typeof value === 'string' && value.trim())
        .map(value => value.trim());
    const ownerNames = Array.isArray(owner?.vrfTableNames) ? owner.vrfTableNames.filter(Boolean) : [];
    return Array.from(new Set(routeNames.length > 0 ? routeNames : ownerNames));
}

function makeClientInfo(clientKey, bmpSession) {
    const info = bmpSession?.getClientInfo?.() || bmpSession?.client || {};
    return {
        key: String(clientKey),
        sysName: info.sysName || '',
        localIp: info.localIp || '',
        localPort: info.localPort ?? null,
        remoteIp: info.remoteIp || '',
        remotePort: info.remotePort ?? null
    };
}

function makePeerInfo(sessionKey, session) {
    return {
        key: String(sessionKey),
        ip: session?.sessionIp || '',
        as: session?.sessionAs ?? null,
        rd: session?.sessionRd || '0:0',
        type: session?.sessionType ?? null
    };
}

function cloneRetainedValue(value) {
    if (Array.isArray(value)) {
        return value.map(cloneRetainedValue);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneRetainedValue(item)]));
    }
    return value;
}

function makeRetainedRoute(routeInfo) {
    const retained = {};
    RETAINED_ROUTE_FIELDS.forEach(field => {
        if (routeInfo[field] !== undefined) {
            retained[field] = cloneRetainedValue(routeInfo[field]);
        }
    });
    if (routeInfo.nlriDetail && typeof routeInfo.nlriDetail === 'object') {
        const nlriDetail = {};
        RETAINED_NLRI_DETAIL_FIELDS.forEach(field => {
            if (routeInfo.nlriDetail[field] !== undefined) {
                nlriDetail[field] = cloneRetainedValue(routeInfo.nlriDetail[field]);
            }
        });
        if (Object.keys(nlriDetail).length > 0) {
            retained.nlriDetail = nlriDetail;
        }
    }
    return retained;
}

function makeEntry({ client, ownerKey, owner, peer, stage, ribType, route, sourceKey, retainFullRoute = true }) {
    const routeInfo = typeof route?.getRouteInfo === 'function' ? route.getRouteInfo() : { ...route };
    const afi = Number(routeInfo.afi);
    const safi = Number(routeInfo.safi);
    const af = routeInfo.addrFamilyType ?? getAddrFamilyType(afi, safi);
    const afLabel = `${getBgpAfiName(afi)} ${getBgpSafiName(safi)}`;
    const vrfTableNames = getVrfNames(routeInfo, owner);
    const nlriKey = makeNlriKey(routeInfo, vrfTableNames);
    return {
        stage,
        ribType,
        client,
        peer,
        ownerKey: String(ownerKey),
        afi,
        safi,
        af,
        afLabel,
        nlriKey,
        displayPrefix: getRouteDisplayPrefix(routeInfo),
        routeLensQuery: getRouteLensQuery(routeInfo),
        vrfTableNames,
        route: retainFullRoute ? route : makeRetainedRoute(routeInfo),
        sourceKey: sourceKey || null
    };
}

function getEntryRouteInfo(entry) {
    const route = entry?.route;
    return typeof route?.getRouteInfo === 'function' ? route.getRouteInfo() : route || {};
}

function makeGroupMeta(entry) {
    return {
        groupKey: `${entry.client.key}\u001f${entry.nlriKey}`,
        client: entry.client,
        afi: entry.afi,
        safi: entry.safi,
        af: entry.af,
        afLabel: entry.afLabel,
        nlriKey: entry.nlriKey,
        displayPrefix: entry.displayPrefix,
        routeLensQuery: entry.routeLensQuery,
        vrfTableNames: entry.vrfTableNames
    };
}

function makeCompactEntry(entry, meta) {
    return {
        stage: entry.stage,
        ribType: entry.ribType,
        peer: entry.peer,
        ownerKey: entry.ownerKey,
        route: entry.route,
        sourceKey: entry.sourceKey || null,
        meta
    };
}

function getEntryMeta(entry) {
    return entry?.meta || entry || {};
}

function makeEvidenceEntryId(entry) {
    const routeInfo = getEntryRouteInfo(entry);
    const meta = getEntryMeta(entry);
    return `assurance-route-${stableId([
        meta.client.key,
        entry.ownerKey,
        entry.stage,
        entry.ribType,
        meta.nlriKey,
        routeInfo.pathId || 0
    ])}`;
}

function entryMatchesClient(entry, clientFilter) {
    const filter = normalizedText(clientFilter);
    if (!filter) {
        return true;
    }
    return [
        entry.client.key,
        entry.client.sysName,
        entry.client.localIp,
        entry.client.remoteIp,
        `${entry.client.localIp}:${entry.client.localPort}`,
        `${entry.client.remoteIp}:${entry.client.remotePort}`
    ].some(value => normalizedText(value).includes(filter));
}

function entryMatchesVrf(entry, vrfFilter) {
    const filter = normalizedText(vrfFilter);
    if (!filter) {
        return true;
    }
    if (filter === GLOBAL_VRF) {
        return entry.vrfTableNames.length === 0;
    }
    return entry.vrfTableNames.some(value => normalizedText(value).includes(filter));
}

function entryMatchesAf(entry, afFilter) {
    const filter = normalizedText(afFilter);
    if (!filter) {
        return true;
    }
    return [entry.af, `${entry.afi}|${entry.safi}`, `${entry.afi}/${entry.safi}`, entry.afLabel].some(
        value => normalizedText(value) === filter || normalizedText(value).includes(filter)
    );
}

function entryMatchesQuery(entry, queryFilter) {
    const input = String(
        queryFilter && typeof queryFilter === 'object' ? queryFilter.value || '' : queryFilter || ''
    ).trim();
    if (!input) {
        return true;
    }

    const query = queryFilter?.parsed || parseRouteLensQuery(input);

    if (query.mode === 'text') {
        const routeInfo = getEntryRouteInfo(entry);
        const haystack = [
            entry.displayPrefix,
            routeInfo.routeKey,
            routeInfo.routeType,
            routeInfo.nlriDetail?.routeTypeName,
            routeInfo.nlriDetail?.nlriTypeName,
            entry.client.sysName,
            entry.client.remoteIp,
            entry.peer?.ip
        ]
            .map(normalizedText)
            .join('\u001f');
        return haystack.includes(query.normalized);
    }

    const network = getRouteNetwork(getEntryRouteInfo(entry));
    if (!network || network.family !== query.addressFamily) {
        return false;
    }
    if (query.mode === 'exact') {
        return network.network === query.network && network.prefixLength === query.prefixLength;
    }
    return query.address.match(ipaddr.parse(network.network), network.prefixLength);
}

function makeEmptyGroup() {
    return Object.fromEntries(STAGES.map(stage => [stage, null]));
}

function getGroupStageEntries(group, stage) {
    const value = group?.[stage];
    if (!value) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

function getGroupStageCount(group, stage) {
    const value = group?.[stage];
    return Array.isArray(value) ? value.length : value ? 1 : 0;
}

function addGroupStageEntry(group, stage, entry) {
    const value = group[stage];
    if (!value) {
        group[stage] = entry;
    } else if (Array.isArray(value)) {
        value.push(entry);
    } else {
        group[stage] = [value, entry];
    }
}

function removeGroupStageEntry(group, stage, entry) {
    const value = group[stage];
    if (!value) {
        return false;
    }
    if (!Array.isArray(value)) {
        if (value !== entry) {
            return false;
        }
        group[stage] = null;
        return true;
    }
    const index = value.indexOf(entry);
    if (index < 0) {
        return false;
    }
    value.splice(index, 1);
    if (value.length === 1) {
        group[stage] = value[0];
    } else if (value.length === 0) {
        group[stage] = null;
    }
    return true;
}

function getAllGroupEntries(group) {
    return STAGES.flatMap(stage => getGroupStageEntries(group, stage));
}

function makeFacetAccumulator() {
    return {
        clients: new Map(),
        vrfs: new Map(),
        addressFamilies: new Map()
    };
}

function recordFacetEntry(facets, entry) {
    if (!facets.clients.has(entry.client.key)) {
        facets.clients.set(entry.client.key, {
            value: entry.client.key,
            label: entry.client.sysName || entry.client.remoteIp || entry.client.localIp || entry.client.key,
            count: 0
        });
    }
    facets.clients.get(entry.client.key).count += 1;
    if (entry.vrfTableNames.length === 0) {
        facets.vrfs.set(GLOBAL_VRF, (facets.vrfs.get(GLOBAL_VRF) || 0) + 1);
    } else {
        entry.vrfTableNames.forEach(vrf => facets.vrfs.set(vrf, (facets.vrfs.get(vrf) || 0) + 1));
    }
    const afValue = entry.af === undefined ? `${entry.afi}|${entry.safi}` : String(entry.af);
    if (!facets.addressFamilies.has(afValue)) {
        facets.addressFamilies.set(afValue, { value: afValue, label: entry.afLabel, count: 0 });
    }
    facets.addressFamilies.get(afValue).count += 1;
}

function removeFacetEntry(facets, entry) {
    const meta = getEntryMeta(entry);
    const clientFacet = facets.clients.get(meta.client.key);
    if (clientFacet) {
        clientFacet.count -= 1;
        if (clientFacet.count <= 0) {
            facets.clients.delete(meta.client.key);
        }
    }
    const vrfs = meta.vrfTableNames.length === 0 ? [GLOBAL_VRF] : meta.vrfTableNames;
    vrfs.forEach(vrf => {
        const nextCount = (facets.vrfs.get(vrf) || 0) - 1;
        if (nextCount > 0) {
            facets.vrfs.set(vrf, nextCount);
        } else {
            facets.vrfs.delete(vrf);
        }
    });
    const afValue = meta.af === undefined ? `${meta.afi}|${meta.safi}` : String(meta.af);
    const afFacet = facets.addressFamilies.get(afValue);
    if (afFacet) {
        afFacet.count -= 1;
        if (afFacet.count <= 0) {
            facets.addressFamilies.delete(afValue);
        }
    }
}

function normalizePersistedScope(scopeKind) {
    const normalized = normalizedText(scopeKind);
    return normalized === 'instance' || normalized === 'loc-rib' || normalized === 'locrib' ? 'instance' : 'session';
}

function makePersistedRouteAssuranceSourceKey(context = {}) {
    const sourceId = context.sourceId ?? context.clientKey ?? '';
    const scopeId = context.scopeId ?? '';
    const routeId = context.routeId ?? '';
    if (scopeId && routeId) {
        return ['persisted', sourceId, scopeId, routeId].map(value => String(value ?? '')).join('\u001f');
    }
    return makeRouteAssuranceSourceKey({
        clientKey: sourceId,
        scope: normalizePersistedScope(context.scopeKind ?? context.scope),
        ownerKey: context.ownerKey ?? scopeId,
        stage: context.stage,
        ribType: context.ribType,
        routeKey: context.routeKey ?? routeId
    });
}

function makePersistedOwnerKey(scope, ownerKey, scopeId, peer = {}) {
    if (scope === 'instance') {
        return String(ownerKey || scopeId || ['loc-rib', peer.type, peer.rd, peer.vrf].join('|'));
    }
    if (
        [peer.type, peer.rd, peer.rdRaw, peer.ip, peer.as].some(
            value => value !== null && value !== undefined && value !== ''
        )
    ) {
        return ['peer', peer.type, peer.rd, peer.rdRaw, peer.ip, peer.as]
            .map(value => String(value ?? ''))
            .join('\u001f');
    }
    return String(ownerKey || scopeId || 'peer');
}

function makePersistedRouteContext(row, overrides = {}) {
    if (!row || typeof row !== 'object') {
        return null;
    }
    const isEnvelope =
        row.route &&
        typeof row.route === 'object' &&
        ['sourceId', 'scopeId', 'scopeKind', 'ownerKey', 'routeId', 'ribType'].some(field => row[field] !== undefined);
    const route = overrides.route || (isEnvelope ? row.route : row);
    if (!route || typeof route !== 'object') {
        return null;
    }
    const previous = overrides.previous || row.previous || null;
    const identityRoute = route || previous || {};
    const sourceInfo = overrides.source || row.source || identityRoute.source || previous?.source || {};
    const peer = overrides.peer || row.peer || identityRoute.peer || previous?.peer || {};
    const sourceId =
        overrides.sourceId ??
        row.sourceId ??
        identityRoute.persistentSourceId ??
        previous?.persistentSourceId ??
        sourceInfo.id ??
        sourceInfo.key;
    const scopeId = overrides.scopeId ?? row.scopeId ?? identityRoute.persistentScopeId ?? previous?.persistentScopeId;
    const routeId =
        overrides.routeId ??
        row.routeId ??
        identityRoute.persistentRouteId ??
        previous?.persistentRouteId ??
        identityRoute.routeKey ??
        previous?.routeKey;
    const scopeKind =
        overrides.scopeKind ??
        overrides.scope ??
        row.scopeKind ??
        row.scope ??
        identityRoute.scopeKind ??
        previous?.scopeKind;
    const scope = normalizePersistedScope(scopeKind);
    const ribType =
        overrides.ribType ??
        row.ribType ??
        identityRoute.ribType ??
        previous?.ribType ??
        (scope === 'instance' ? 'loc-rib' : null);
    const stage = overrides.stage || row.stage || getRouteAssuranceStage(ribType, scope);
    if (!sourceId || !routeId || !stage) {
        return null;
    }
    const ownerKey = makePersistedOwnerKey(
        scope,
        overrides.ownerKey ?? row.ownerKey ?? identityRoute.ownerKey ?? previous?.ownerKey,
        scopeId,
        peer
    );
    const afi = Number(overrides.afi ?? row.afi ?? identityRoute.afi ?? previous?.afi);
    const safi = Number(overrides.safi ?? row.safi ?? identityRoute.safi ?? previous?.safi);
    const routeKey = String(
        overrides.routeKey ?? row.routeKey ?? identityRoute.routeKey ?? previous?.routeKey ?? routeId
    );
    const normalizedRoute = {
        ...identityRoute,
        ...(Number.isFinite(afi) ? { afi } : {}),
        ...(Number.isFinite(safi) ? { safi } : {}),
        routeKey
    };
    const clientInfo = {
        sysName: sourceInfo.sysName || '',
        localIp: sourceInfo.localIp || '',
        localPort: sourceInfo.localPort ?? null,
        remoteIp: sourceInfo.remoteIp || '',
        remotePort: sourceInfo.remotePort ?? null
    };
    const vrfTableNames = Array.from(
        new Set(
            [peer.vrf, row.vrfName, identityRoute.vrfName]
                .flatMap(value => (Array.isArray(value) ? value : [value]))
                .filter(value => typeof value === 'string' && value.trim())
                .map(value => value.trim())
        )
    );
    const owner =
        scope === 'instance'
            ? {
                  instanceType: peer.type ?? null,
                  instanceRd: peer.rd || '0:0',
                  instanceIp: peer.ip || '',
                  instanceAs: peer.as ?? null,
                  vrfTableNames
              }
            : {
                  sessionType: peer.type ?? null,
                  sessionRd: peer.rd || '0:0',
                  sessionIp: peer.ip || '',
                  sessionAs: peer.as ?? null,
                  vrfTableNames
              };
    const sourceKey =
        overrides.sourceKey ||
        row.sourceKey ||
        makePersistedRouteAssuranceSourceKey({
            sourceId,
            scopeId,
            routeId,
            scope,
            ownerKey,
            stage,
            ribType,
            routeKey
        });
    return {
        clientKey: String(overrides.clientKey ?? row.clientKey ?? sourceId),
        client: { key: String(overrides.clientKey ?? row.clientKey ?? sourceId), ...clientInfo },
        bmpSession: { getClientInfo: () => clientInfo },
        scope,
        ownerKey,
        owner,
        peer:
            scope === 'session'
                ? {
                      key: ownerKey,
                      ip: peer.ip || '',
                      as: peer.as ?? null,
                      rd: peer.rd || '0:0',
                      type: peer.type ?? null
                  }
                : null,
        stage,
        ribType: scope === 'instance' ? 'loc-rib' : Number(ribType),
        afi,
        safi,
        routeKey,
        route: normalizedRoute,
        sourceKey,
        sourceId: String(sourceId),
        scopeId: scopeId === undefined || scopeId === null ? '' : String(scopeId),
        routeId: String(routeId),
        retainFullRoute: false
    };
}

function normalizeBmpRouteAssuranceCommittedDelta(delta = {}) {
    const action = normalizedText(delta.action);
    if (action !== 'upsert' && action !== 'delete') {
        throw new TypeError("BMP Route Assurance committed delta action 必须是 'upsert' 或 'delete'");
    }
    const scopeDescriptor =
        (delta.scope && typeof delta.scope === 'object' && delta.scope) ||
        (delta.mutation?.scope && typeof delta.mutation.scope === 'object' && delta.mutation.scope) ||
        {};
    const sourceValue =
        (delta.source && typeof delta.source === 'object' && delta.source) ||
        (delta.mutation?.source && typeof delta.mutation.source === 'object' && delta.mutation.source) ||
        null;
    const connectionDescriptor =
        (delta.connection && typeof delta.connection === 'object' && delta.connection) ||
        (delta.mutation?.connection && typeof delta.mutation.connection === 'object' && delta.mutation.connection) ||
        null;
    const sourceDescriptor = sourceValue
        ? {
              ...sourceValue,
              localIp: connectionDescriptor?.localIp ?? sourceValue.localIp,
              localPort: connectionDescriptor?.localPort ?? sourceValue.localPort,
              remoteIp: connectionDescriptor?.remoteIp ?? sourceValue.remoteIp,
              remotePort: connectionDescriptor?.remotePort ?? sourceValue.remotePort
          }
        : connectionDescriptor;
    const currentRoute = delta.route || delta.current || null;
    const identityRoute = currentRoute ||
        delta.previous || {
            routeKey: delta.routeKey || delta.legacyRouteKey || delta.routeId,
            persistentRouteId: delta.routeId,
            persistentScopeId: delta.scopeId,
            persistentSourceId: delta.sourceId,
            afi: delta.afi ?? scopeDescriptor.afi,
            safi: delta.safi ?? scopeDescriptor.safi,
            scopeKind: delta.scopeKind ?? scopeDescriptor.kind,
            ribType: delta.ribType ?? scopeDescriptor.ribType,
            source: sourceDescriptor,
            peer: delta.peer
        };
    const scopePeer = {
        type: scopeDescriptor.peerType,
        rd: scopeDescriptor.peerRd,
        ip: scopeDescriptor.peerIp,
        as: scopeDescriptor.peerAs,
        vrf: scopeDescriptor.vrfName,
        ...(delta.peer || identityRoute.peer || delta.previous?.peer || {})
    };
    const context = makePersistedRouteContext(identityRoute, {
        sourceId: delta.sourceId ?? sourceDescriptor?.id,
        clientKey: delta.clientKey,
        scopeId: delta.scopeId ?? scopeDescriptor.id,
        routeId: delta.routeId,
        scopeKind: delta.scopeKind ?? scopeDescriptor.kind,
        ownerKey: delta.ownerKey ?? scopeDescriptor.ownerKey,
        afi: delta.afi ?? scopeDescriptor.afi,
        safi: delta.safi ?? scopeDescriptor.safi,
        ribType: delta.ribType ?? scopeDescriptor.ribType,
        stage: delta.stage,
        routeKey: delta.routeKey ?? delta.legacyRouteKey,
        sourceKey: delta.sourceKey,
        source: sourceDescriptor || identityRoute.source || delta.previous?.source,
        peer: scopePeer,
        route: identityRoute,
        previous: delta.previous
    });
    if (!context) {
        throw new TypeError('BMP Route Assurance committed delta 缺少 source/scope/route identity 或有效 RIB stage');
    }
    return {
        ...context,
        action,
        previous: delta.previous || null,
        route: action === 'delete' ? currentRoute || delta.previous || context.route : context.route,
        isNew: delta.isNew === true,
        retainFullRoute: false
    };
}

async function* flattenPersistedRouteRows(value) {
    const resolved = await value;
    if (!resolved) {
        return;
    }
    if (Array.isArray(resolved)) {
        for (const row of resolved) {
            yield row;
        }
        return;
    }
    if (Array.isArray(resolved.list) || Array.isArray(resolved.rows)) {
        for (const row of resolved.list || resolved.rows) {
            yield row;
        }
        return;
    }
    if (typeof resolved[Symbol.asyncIterator] === 'function') {
        for await (const item of resolved) {
            yield* flattenPersistedRouteRows(item);
        }
        return;
    }
    if (typeof resolved[Symbol.iterator] === 'function' && typeof resolved !== 'string') {
        for (const item of resolved) {
            yield* flattenPersistedRouteRows(item);
        }
        return;
    }
    yield resolved;
}

async function* iteratePersistedRouteRows(source) {
    if (typeof source !== 'function') {
        yield* flattenPersistedRouteRows(source);
        return;
    }
    let cursor = null;
    const seenCursors = new Set();
    while (true) {
        const page = await source(cursor);
        if (!page) {
            return;
        }
        yield* flattenPersistedRouteRows(page);
        const nextCursor = page.nextCursor ?? null;
        if (!nextCursor) {
            return;
        }
        const cursorKey = typeof nextCursor === 'string' ? nextCursor : JSON.stringify(nextCursor);
        if (seenCursors.has(cursorKey)) {
            throw new Error('BMP Route Assurance 持久化分页游标未向前推进');
        }
        seenCursors.add(cursorKey);
        cursor = nextCursor;
    }
}

function* iterateRouteAssuranceSources(bmpSessionMap, filters) {
    const sourceMap = bmpSessionMap instanceof Map ? bmpSessionMap : new Map();
    for (const [clientKey, bmpSession] of sourceMap) {
        const client = makeClientInfo(clientKey, bmpSession);
        if (!entryMatchesClient({ client }, filters.client)) {
            continue;
        }
        for (const [sessionKey, bgpSession] of bmpSession?.bgpSessionMap || []) {
            const session = bgpSession?.getSessionInfo?.() || bgpSession || {};
            const peer = makePeerInfo(sessionKey, session);
            for (const [, ribTypeRouteMap] of bgpSession?.bgpRoutes || []) {
                if (!(ribTypeRouteMap instanceof Map)) {
                    continue;
                }
                for (const [ribType, routeMap] of ribTypeRouteMap) {
                    const stage = RIB_STAGE_MAP.get(Number(ribType));
                    if (!stage || !(routeMap instanceof Map)) {
                        continue;
                    }
                    for (const route of routeMap.values()) {
                        yield {
                            clientKey,
                            client,
                            ownerKey: sessionKey,
                            owner: session,
                            peer,
                            stage,
                            ribType: Number(ribType),
                            scope: 'session',
                            route
                        };
                    }
                }
            }
        }

        for (const [instanceKey, bgpInstance] of bmpSession?.bgpInstanceMap || []) {
            const instance = bgpInstance?.getInstanceInfo?.() || bgpInstance || {};
            if (!(bgpInstance?.bgpRoutes instanceof Map)) {
                continue;
            }
            for (const route of bgpInstance.bgpRoutes.values()) {
                yield {
                    clientKey,
                    client,
                    ownerKey: instanceKey,
                    owner: instance,
                    peer: null,
                    stage: 'locRib',
                    ribType: 'loc-rib',
                    scope: 'instance',
                    route
                };
            }
        }
    }
}

function countBmpRouteAssuranceSourcePaths(bmpSessionMap, options = {}) {
    const filters = normalizeFilters(options);
    let count = 0;
    const sourceMap = bmpSessionMap instanceof Map ? bmpSessionMap : new Map();
    for (const [clientKey, bmpSession] of sourceMap) {
        const client = makeClientInfo(clientKey, bmpSession);
        if (!entryMatchesClient({ client }, filters.client)) {
            continue;
        }
        for (const bgpSession of bmpSession?.bgpSessionMap?.values?.() || []) {
            for (const ribTypeRouteMap of bgpSession?.bgpRoutes?.values?.() || []) {
                if (!(ribTypeRouteMap instanceof Map)) {
                    continue;
                }
                for (const [ribType, routeMap] of ribTypeRouteMap) {
                    if (getRouteAssuranceStage(ribType, 'session') && routeMap instanceof Map) {
                        count += routeMap.size;
                    }
                }
            }
        }
        for (const bgpInstance of bmpSession?.bgpInstanceMap?.values?.() || []) {
            if (bgpInstance?.bgpRoutes instanceof Map) {
                count += bgpInstance.bgpRoutes.size;
            }
        }
    }
    return count;
}

function makeEmptyCollection() {
    return {
        scannedPathCount: 0,
        filteredPathCount: 0,
        stagePathCounts: Object.fromEntries(STAGES.map(stage => [stage, 0])),
        grouped: new Map(),
        sourceEntries: new WeakMap(),
        sourceEntriesByKey: new Map(),
        sourcePathKeys: new Set(),
        facets: makeFacetAccumulator()
    };
}

function addSourceEntryIndex(index, key, entry) {
    if (!index || key === null || key === undefined || key === '') {
        return;
    }
    const existing = index.get(key);
    if (!existing) {
        index.set(key, entry);
    } else if (Array.isArray(existing)) {
        existing.push(entry);
    } else {
        index.set(key, [existing, entry]);
    }
}

function collectRouteAssuranceSource(collection, source, filters) {
    collection.scannedPathCount += 1;
    if (source.sourceKey) {
        collection.sourcePathKeys.add(source.sourceKey);
    }
    if (!source.route || !routeStateMatches(source.route, filters.routeState)) {
        return;
    }
    const entry = makeEntry(source);
    if (
        !entryMatchesVrf(entry, filters.vrf) ||
        !entryMatchesAf(entry, filters.af) ||
        !entryMatchesQuery(entry, { value: filters.query, parsed: filters.parsedQuery })
    ) {
        return;
    }
    const meta = makeGroupMeta(entry);
    const groupKey = meta.groupKey;
    if (!collection.grouped.has(groupKey)) {
        collection.grouped.set(groupKey, makeEmptyGroup());
        collection.grouped.get(groupKey).meta = meta;
    }
    const group = collection.grouped.get(groupKey);
    const compactEntry = makeCompactEntry(entry, group.meta);
    addGroupStageEntry(group, source.stage, compactEntry);
    if ((typeof source.route === 'object' && source.route !== null) || typeof source.route === 'function') {
        addSourceEntryIndex(collection.sourceEntries, source.route, compactEntry);
    }
    if (source.sourceKey) {
        addSourceEntryIndex(collection.sourceEntriesByKey, source.sourceKey, compactEntry);
    }
    collection.stagePathCounts[source.stage] += 1;
    collection.filteredPathCount += 1;
    recordFacetEntry(collection.facets, entry);
}

function collectGroupedEntries(bmpSessionMap, filters) {
    const collection = makeEmptyCollection();
    for (const source of iterateRouteAssuranceSources(bmpSessionMap, filters)) {
        collectRouteAssuranceSource(collection, source, filters);
    }
    return collection;
}

function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

async function collectGroupedEntriesAsync(bmpSessionMap, filters, options = {}) {
    const collection = makeEmptyCollection();
    const chunkSize = Math.max(100, Math.floor(Number(options.chunkSize)) || 5000);
    let chunkCount = 0;
    for (const source of iterateRouteAssuranceSources(bmpSessionMap, filters)) {
        if (options.shouldCancel?.()) {
            const error = new Error('路由矩阵分析初始化已取消');
            error.code = 'BMP_ROUTE_ASSURANCE_CANCELLED';
            throw error;
        }
        collectRouteAssuranceSource(collection, source, filters);
        chunkCount += 1;
        if (chunkCount >= chunkSize) {
            chunkCount = 0;
            options.onProgress?.({ scannedPathCount: collection.scannedPathCount });
            await yieldToEventLoop();
        }
    }
    options.onProgress?.({ scannedPathCount: collection.scannedPathCount });
    return collection;
}

async function collectPersistedGroupedEntriesAsync(routeRows, filters, options = {}) {
    const collection = makeEmptyCollection();
    const chunkSize = Math.max(100, Math.floor(Number(options.chunkSize)) || 5000);
    let chunkCount = 0;
    for await (const row of iteratePersistedRouteRows(routeRows)) {
        if (options.shouldCancel?.()) {
            const error = new Error('路由矩阵分析初始化已取消');
            error.code = 'BMP_ROUTE_ASSURANCE_CANCELLED';
            throw error;
        }
        const overrides = options.resolveContext?.(row) || {};
        const source = makePersistedRouteContext(row, overrides);
        if (!source || !entryMatchesClient({ client: source.client }, filters.client)) {
            continue;
        }
        collectRouteAssuranceSource(collection, source, filters);
        chunkCount += 1;
        if (chunkCount >= chunkSize) {
            chunkCount = 0;
            options.onProgress?.({ scannedPathCount: collection.scannedPathCount });
            await yieldToEventLoop();
        }
    }
    options.onProgress?.({ scannedPathCount: collection.scannedPathCount });
    return collection;
}

function makeStagePresence(group) {
    return Object.fromEntries(STAGES.map(stage => [stage, getGroupStageCount(group, stage)]));
}

function uniquePeers(entries) {
    const peers = new Map();
    entries.forEach(entry => {
        if (entry.peer && !peers.has(entry.peer.key)) {
            peers.set(entry.peer.key, entry.peer);
        }
    });
    return Array.from(peers.values()).sort((left, right) => left.key.localeCompare(right.key));
}

function makeBaseIssue(category, group, evidence) {
    const allEntries = getAllGroupEntries(group);
    const representative = allEntries[0];
    const meta = group.meta || getEntryMeta(representative);
    const stagePresence = makeStagePresence(group);
    const peers = uniquePeers(allEntries);
    const representativeRoute = getEntryRouteInfo(representative);
    const rd = representativeRoute.nlriDetail?.rd || representativeRoute.rd || '0:0';
    const nlri = {
        key: meta.nlriKey,
        displayPrefix: meta.displayPrefix,
        afi: meta.afi,
        safi: meta.safi,
        af: meta.af,
        afLabel: meta.afLabel,
        rd
    };
    return {
        id: `assurance-issue-${stableId([category, meta.client.key, meta.nlriKey])}`,
        category,
        categoryLabel: CATEGORY_LABELS[category],
        severity: category === 'multi-egress-inconsistent' ? 'info' : 'warning',
        title: `${CATEGORY_LABELS[category]} · ${meta.displayPrefix}`,
        description: evidence.description,
        evidenceType: evidence.evidenceType,
        confidence: evidence.confidence,
        nlri,
        prefix: meta.displayPrefix,
        client: meta.client,
        vrfTableNames: meta.vrfTableNames,
        stagePresence,
        peers,
        differences: [],
        evidence: Array.isArray(evidence.entries)
            ? evidence.entries.map(entry => {
                  const routeInfo = getEntryRouteInfo(entry);
                  return {
                      entryId: makeEvidenceEntryId(entry),
                      stage: entry.stage,
                      peer: entry.peer,
                      pathId: routeInfo.pathId ?? 0,
                      pathStatus: routeInfo.pathStatus ?? null,
                      pathStatusText: routeInfo.pathStatusText || null
                  };
              })
            : [],
        routeLensQuery: meta.routeLensQuery
    };
}

function hasStatus(entries, statusFlag) {
    return entries.some(entry => {
        const status = getEntryRouteInfo(entry).pathStatus;
        return status !== null && status !== undefined && (Number(status) & statusFlag) !== 0;
    });
}

function gapEvidence(entries, filterStatus, description) {
    if (hasStatus(entries, filterStatus)) {
        return {
            evidenceType: 'reported',
            confidence: 'high',
            description: `设备 Path Marking 明确上报该路由被策略过滤。${description}`,
            entries
        };
    }
    return {
        evidenceType: 'inferred',
        confidence: 'low',
        description: `当前 BMP 快照中未观察到对应下一阶段；这是可见性缺口，不能据此确定路由被策略过滤。${description}`,
        entries
    };
}

function peerPathKey(entry) {
    return `${entry.peer?.key || ''}\u001f${getEntryRouteInfo(entry).pathId ?? 0}`;
}

function missingPeerPaths(beforeEntries, afterEntries) {
    const afterKeys = new Set(afterEntries.map(peerPathKey));
    return beforeEntries.filter(entry => !afterKeys.has(peerPathKey(entry)));
}

function comparableValue(value) {
    if (Array.isArray(value)) {
        return `[${value.map(comparableValue).sort().join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${comparableValue(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function findEgressDifferences(entriesByPeer) {
    const differences = [];
    EGRESS_COMPARE_FIELDS.forEach(field => {
        const valuesByPeer = Array.from(entriesByPeer.values(), peerEntries => {
            const pathValues = peerEntries
                .map(entry => {
                    const routeInfo = getEntryRouteInfo(entry);
                    return { pathId: routeInfo.pathId ?? 0, value: routeInfo[field] ?? null };
                })
                .sort(
                    (left, right) =>
                        left.pathId - right.pathId ||
                        comparableValue(left.value).localeCompare(comparableValue(right.value))
                );
            const distinctValues = [];
            const seen = new Set();
            pathValues.forEach(item => {
                const key = comparableValue(item.value);
                if (!seen.has(key)) {
                    seen.add(key);
                    distinctValues.push(item.value);
                }
            });
            const peer = peerEntries[0].peer;
            return {
                peerKey: peer.key,
                peerIp: peer.ip,
                peerAs: peer.as,
                value: distinctValues.length === 1 ? distinctValues[0] : distinctValues,
                pathValues,
                comparableSet: Array.from(seen).sort().join('\u001e')
            };
        });
        const distinctPeerSets = new Set(valuesByPeer.map(item => item.comparableSet));
        if (distinctPeerSets.size > 1) {
            differences.push({
                field,
                values: valuesByPeer.map(({ comparableSet: _comparableSet, ...item }) => item)
            });
        }
    });
    return differences;
}

function buildGroupIssues(group) {
    const issues = [];
    const preIn = getGroupStageEntries(group, 'preIn');
    const postIn = getGroupStageEntries(group, 'postIn');
    const locRib = getGroupStageEntries(group, 'locRib');
    const preOut = getGroupStageEntries(group, 'preOut');
    const postOut = getGroupStageEntries(group, 'postOut');
    const missingPostIn = missingPeerPaths(preIn, postIn);
    if (missingPostIn.length > 0) {
        issues.push(
            makeBaseIssue(
                'inbound-gap',
                group,
                gapEvidence(
                    missingPostIn,
                    BmpConst.BMP_PATH_STATUS.FILTERED_IN_INBOUND_POLICY,
                    `缺口涉及 ${uniquePeers(missingPostIn).length} 个 Peer。`
                )
            )
        );
    }
    if (postIn.length > 0 && locRib.length === 0) {
        const reportedNonselected = hasStatus(postIn, BmpConst.BMP_PATH_STATUS.NONSELECTED);
        issues.push(
            makeBaseIssue('not-selected', group, {
                evidenceType: reportedNonselected ? 'reported' : 'inferred',
                confidence: reportedNonselected ? 'high' : 'low',
                description: reportedNonselected
                    ? '设备 Path Marking 明确上报该路径未被选中。'
                    : '在 Post Adj-RIB-In 中可见，但未在 Loc-RIB 快照中观察到；这不等同于设备明确上报未选中。',
                entries: postIn
            })
        );
    }
    if (locRib.length > 0 && preOut.length === 0) {
        const reportedFilter = hasStatus(locRib, BmpConst.BMP_PATH_STATUS.FILTERED_IN_OUTBOUND_POLICY);
        issues.push(
            makeBaseIssue('not-exported', group, {
                evidenceType: reportedFilter ? 'reported' : 'inferred',
                confidence: reportedFilter ? 'high' : 'low',
                description: reportedFilter
                    ? '设备 Path Marking 明确上报该路由在出站策略中被过滤。'
                    : '在 Loc-RIB 中可见，但未在任何 Pre Adj-RIB-Out 快照中观察到；不能据此确定设备未生成出站路由。',
                entries: locRib
            })
        );
    }
    const missingPostOut = missingPeerPaths(preOut, postOut);
    if (missingPostOut.length > 0) {
        issues.push(
            makeBaseIssue(
                'outbound-gap',
                group,
                gapEvidence(
                    missingPostOut,
                    BmpConst.BMP_PATH_STATUS.FILTERED_IN_OUTBOUND_POLICY,
                    `缺口涉及 ${uniquePeers(missingPostOut).length} 个 Peer。`
                )
            )
        );
    }

    const postOutByPeer = new Map();
    postOut.forEach(entry => {
        if (!entry.peer) {
            return;
        }
        if (!postOutByPeer.has(entry.peer.key)) {
            postOutByPeer.set(entry.peer.key, []);
        }
        postOutByPeer.get(entry.peer.key).push(entry);
    });
    if (postOutByPeer.size >= 2) {
        const differences = findEgressDifferences(postOutByPeer);
        if (differences.length > 0) {
            const issue = makeBaseIssue('multi-egress-inconsistent', group, {
                evidenceType: 'observed',
                confidence: 'high',
                description: `BMP Post Adj-RIB-Out 在 ${postOutByPeer.size} 个出口 Peer 上观察到 ${differences.length} 类属性差异。`,
                entries: postOut
            });
            issue.differences = differences;
            issue.peers = Array.from(postOutByPeer.values(), peerEntries => peerEntries[0].peer).sort((left, right) =>
                left.key.localeCompare(right.key)
            );
            issue.severity = 'warning';
            issues.push(issue);
        }
    }
    return issues;
}

function finalizeIssueIndex(issues) {
    if (issues.length <= MAX_SORTED_ISSUES) {
        issues.sort(
            (left, right) =>
                CATEGORIES.indexOf(left.category) - CATEGORIES.indexOf(right.category) ||
                left.nlri.displayPrefix.localeCompare(right.nlri.displayPrefix) ||
                left.id.localeCompare(right.id)
        );
    }
    const issuesByCategory = Object.fromEntries(CATEGORIES.map(category => [category, []]));
    issues.forEach(issue => issuesByCategory[issue.category].push(issue));
    return { allIssues: issues, issuesByCategory };
}

function buildIssues(grouped) {
    const issues = [];
    grouped.forEach(group => issues.push(...buildGroupIssues(group)));
    return finalizeIssueIndex(issues);
}

function buildStageCounts(grouped) {
    const stageCounts = Object.fromEntries(STAGES.map(stage => [stage, 0]));
    grouped.forEach(group => {
        STAGES.forEach(stage => {
            if (getGroupStageCount(group, stage) > 0) {
                stageCounts[stage] += 1;
            }
        });
    });
    return stageCounts;
}

async function buildIssuesAsync(grouped, options = {}) {
    const issues = [];
    const stageCounts = Object.fromEntries(STAGES.map(stage => [stage, 0]));
    const chunkSize = Math.max(100, Math.floor(Number(options.issueChunkSize)) || 2000);
    let chunkCount = 0;
    let evaluatedNlriCount = 0;
    for (const group of grouped.values()) {
        if (options.shouldCancel?.()) {
            const error = new Error('路由矩阵分析初始化已取消');
            error.code = 'BMP_ROUTE_ASSURANCE_CANCELLED';
            throw error;
        }
        STAGES.forEach(stage => {
            if (getGroupStageCount(group, stage) > 0) {
                stageCounts[stage] += 1;
            }
        });
        issues.push(...buildGroupIssues(group));
        chunkCount += 1;
        evaluatedNlriCount += 1;
        if (chunkCount >= chunkSize) {
            chunkCount = 0;
            options.onIssueProgress?.({ evaluatedNlriCount, totalNlriCount: grouped.size });
            await yieldToEventLoop();
        }
    }
    options.onIssueProgress?.({ evaluatedNlriCount, totalNlriCount: grouped.size });
    return { ...finalizeIssueIndex(issues), stageCounts };
}

function normalizeFilters(options = {}) {
    const page = Math.max(1, Math.floor(Number(options.page)) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(options.pageSize)) || DEFAULT_PAGE_SIZE));
    const rawCategory = options.category;
    const categories = Array.isArray(rawCategory)
        ? rawCategory
        : String(rawCategory || '')
              .split(',')
              .filter(Boolean);
    const query = String(options.query || '').trim();
    const filters = {
        client: String(options.client || '').trim(),
        vrf: String(options.vrf || '').trim(),
        af: String(options.af || '').trim(),
        query,
        category: Array.from(new Set(categories.filter(category => CATEGORIES.includes(category)))),
        routeState: normalizedRouteState(options.routeState),
        page,
        pageSize
    };
    Object.defineProperty(filters, 'parsedQuery', {
        value: query ? parseRouteLensQuery(query) : null,
        enumerable: false
    });
    return filters;
}

function countBy(values, keyGetter) {
    const counts = new Map();
    values.forEach(value => {
        const key = keyGetter(value);
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
}

function buildFacets(facetAccumulator, issues, categoryCounts) {
    const clients = facetAccumulator?.clients || new Map();
    const vrfs = facetAccumulator?.vrfs || new Map();
    const addressFamilies = facetAccumulator?.addressFamilies || new Map();
    return {
        clients: Array.from(clients.values()).sort((left, right) => left.label.localeCompare(right.label)),
        vrfs: Array.from(vrfs, ([value, count]) => ({
            value,
            label: value === GLOBAL_VRF ? 'Global' : value,
            count
        })).sort((left, right) => left.label.localeCompare(right.label)),
        addressFamilies: Array.from(addressFamilies.values()).sort((left, right) =>
            left.label.localeCompare(right.label)
        ),
        categories: CATEGORIES.map(category => ({
            value: category,
            label: CATEGORY_LABELS[category],
            count: categoryCounts[category] || 0
        })),
        evidenceTypes: Array.from(
            countBy(issues, issue => issue.evidenceType),
            ([value, count]) => ({
                value,
                label: value,
                count
            })
        )
    };
}

function makeIncrementalState(collection, issueIndex) {
    const allIssuePositions = new Map();
    issueIndex.allIssues.forEach((issue, index) => allIssuePositions.set(issue.id, index));
    const categoryIssuePositions = Object.fromEntries(
        CATEGORIES.map(category => [
            category,
            new Map(issueIndex.issuesByCategory[category].map((issue, index) => [issue.id, index]))
        ])
    );
    const issuesByGroup = new Map();
    const evidenceCounts = new Map();
    issueIndex.allIssues.forEach(issue => {
        const groupKey = `${issue.client.key}\u001f${issue.nlri.key}`;
        if (!issuesByGroup.has(groupKey)) {
            issuesByGroup.set(groupKey, []);
        }
        issuesByGroup.get(groupKey).push(issue);
        evidenceCounts.set(issue.evidenceType, (evidenceCounts.get(issue.evidenceType) || 0) + 1);
    });
    return {
        grouped: collection.grouped,
        sourceEntries: collection.sourceEntries,
        sourceEntriesByKey: collection.sourceEntriesByKey,
        sourcePathKeys: collection.sourcePathKeys,
        facets: collection.facets,
        issuesByGroup,
        allIssuePositions,
        categoryIssuePositions,
        evidenceCounts,
        updateCount: 0
    };
}

function removeDenseIssue(issues, positions, issueId) {
    const index = positions.get(issueId);
    if (index === undefined) {
        return;
    }
    const lastIndex = issues.length - 1;
    const lastIssue = issues[lastIndex];
    issues.pop();
    positions.delete(issueId);
    if (index < lastIndex) {
        issues[index] = lastIssue;
        positions.set(lastIssue.id, index);
    }
}

function addDenseIssue(issues, positions, issue) {
    const existingIndex = positions.get(issue.id);
    if (existingIndex !== undefined) {
        issues[existingIndex] = issue;
        return;
    }
    positions.set(issue.id, issues.length);
    issues.push(issue);
}

function updateEvidenceCount(state, evidenceType, delta) {
    const next = (state.evidenceCounts.get(evidenceType) || 0) + delta;
    if (next > 0) {
        state.evidenceCounts.set(evidenceType, next);
    } else {
        state.evidenceCounts.delete(evidenceType);
    }
}

function removeGroupIssues(analysis, groupKey) {
    const state = analysis._incremental;
    const previousIssues = state.issuesByGroup.get(groupKey) || [];
    previousIssues.forEach(issue => {
        removeDenseIssue(analysis.allIssues, state.allIssuePositions, issue.id);
        removeDenseIssue(
            analysis.issuesByCategory[issue.category],
            state.categoryIssuePositions[issue.category],
            issue.id
        );
        updateEvidenceCount(state, issue.evidenceType, -1);
    });
    state.issuesByGroup.delete(groupKey);
}

function addGroupIssues(analysis, groupKey) {
    const state = analysis._incremental;
    const group = state.grouped.get(groupKey);
    if (!group) {
        return;
    }
    const nextIssues = buildIssues(new Map([[groupKey, group]])).allIssues;
    if (nextIssues.length === 0) {
        return;
    }
    state.issuesByGroup.set(groupKey, nextIssues);
    nextIssues.forEach(issue => {
        addDenseIssue(analysis.allIssues, state.allIssuePositions, issue);
        addDenseIssue(analysis.issuesByCategory[issue.category], state.categoryIssuePositions[issue.category], issue);
        updateEvidenceCount(state, issue.evidenceType, 1);
    });
}

function refreshIncrementalFacets(analysis) {
    const state = analysis._incremental;
    const categoryCounts = Object.fromEntries(
        CATEGORIES.map(category => [category, analysis.issuesByCategory[category].length])
    );
    const facets = buildFacets(state.facets, [], categoryCounts);
    facets.evidenceTypes = Array.from(state.evidenceCounts, ([value, count]) => ({ value, label: value, count }));
    analysis.facets = facets;
    analysis.summary.categoryCounts = categoryCounts;
    analysis.summary.totalIssueCount = analysis.allIssues.length;
    analysis.summary.clientCount = state.facets.clients.size;
}

function makeRouteAssuranceEntry(context) {
    const scope = context.scope === 'instance' ? 'instance' : 'session';
    const stage = context.stage || getRouteAssuranceStage(context.ribType, scope);
    if (!stage || !STAGES.includes(stage) || !context.route) {
        return null;
    }
    const client = makeClientInfo(context.clientKey, context.bmpSession);
    const owner = context.owner?.getSessionInfo?.() || context.owner?.getInstanceInfo?.() || context.owner || {};
    const peer = scope === 'session' ? makePeerInfo(context.ownerKey, owner) : null;
    return makeEntry({
        client,
        ownerKey: context.ownerKey,
        owner,
        peer,
        stage,
        ribType: scope === 'instance' ? 'loc-rib' : Number(context.ribType),
        route: context.route,
        sourceKey: context.sourceKey,
        retainFullRoute: context.retainFullRoute !== false
    });
}

function entryMatchesAnalysis(entry, filters) {
    return (
        routeStateMatches(entry.route, filters.routeState) &&
        entryMatchesClient(entry, filters.client) &&
        entryMatchesVrf(entry, filters.vrf) &&
        entryMatchesAf(entry, filters.af) &&
        entryMatchesQuery(entry, { value: filters.query, parsed: filters.parsedQuery })
    );
}

function removeSourceEntryIndex(index, key, entry) {
    if (!index || key === null || key === undefined || key === '') {
        return;
    }
    const current = index.get(key);
    if (Array.isArray(current)) {
        const next = current.filter(item => item !== entry);
        if (next.length === 0) {
            index.delete(key);
        } else if (next.length === 1) {
            index.set(key, next[0]);
        } else {
            index.set(key, next);
        }
    } else if (current === entry) {
        index.delete(key);
    }
}

function removeAnalysisEntry(analysis, entry, sourceRoute, sourceKey = entry?.sourceKey) {
    const state = analysis._incremental;
    const groupKey = getEntryMeta(entry).groupKey;
    const group = state.grouped.get(groupKey);
    if (!group) {
        if ((typeof sourceRoute === 'object' && sourceRoute !== null) || typeof sourceRoute === 'function') {
            removeSourceEntryIndex(state.sourceEntries, sourceRoute, entry);
        }
        removeSourceEntryIndex(state.sourceEntriesByKey, sourceKey, entry);
        return;
    }
    const previousStageCount = getGroupStageCount(group, entry.stage);
    if (!removeGroupStageEntry(group, entry.stage, entry)) {
        if ((typeof sourceRoute === 'object' && sourceRoute !== null) || typeof sourceRoute === 'function') {
            removeSourceEntryIndex(state.sourceEntries, sourceRoute, entry);
        }
        removeSourceEntryIndex(state.sourceEntriesByKey, sourceKey, entry);
        return;
    }
    if ((typeof sourceRoute === 'object' && sourceRoute !== null) || typeof sourceRoute === 'function') {
        removeSourceEntryIndex(state.sourceEntries, sourceRoute, entry);
    }
    removeSourceEntryIndex(state.sourceEntriesByKey, sourceKey, entry);
    removeFacetEntry(state.facets, entry);
    analysis.summary.stagePathCounts[entry.stage] = Math.max(
        0,
        (analysis.summary.stagePathCounts[entry.stage] || 0) - 1
    );
    analysis.summary.filteredPathCount = Math.max(0, (analysis.summary.filteredPathCount || 0) - 1);
    if (previousStageCount > 0 && getGroupStageCount(group, entry.stage) === 0) {
        analysis.summary.stageCounts[entry.stage] = Math.max(0, (analysis.summary.stageCounts[entry.stage] || 0) - 1);
        analysis.funnel[entry.stage] = analysis.summary.stageCounts[entry.stage];
    }
    if (STAGES.every(stage => getGroupStageCount(group, stage) === 0)) {
        state.grouped.delete(groupKey);
        analysis.summary.uniqueNlriCount = Math.max(0, (analysis.summary.uniqueNlriCount || 0) - 1);
    }
}

function addAnalysisEntry(analysis, entry, sourceRoute, sourceKey = entry?.sourceKey) {
    const state = analysis._incremental;
    const nextMeta = makeGroupMeta(entry);
    const groupKey = nextMeta.groupKey;
    let group = state.grouped.get(groupKey);
    if (!group) {
        group = makeEmptyGroup();
        group.meta = nextMeta;
        state.grouped.set(groupKey, group);
        analysis.summary.uniqueNlriCount = (analysis.summary.uniqueNlriCount || 0) + 1;
    }
    if (getGroupStageCount(group, entry.stage) === 0) {
        analysis.summary.stageCounts[entry.stage] = (analysis.summary.stageCounts[entry.stage] || 0) + 1;
        analysis.funnel[entry.stage] = analysis.summary.stageCounts[entry.stage];
    }
    const compactEntry = makeCompactEntry(entry, group.meta);
    addGroupStageEntry(group, entry.stage, compactEntry);
    if ((typeof sourceRoute === 'object' && sourceRoute !== null) || typeof sourceRoute === 'function') {
        addSourceEntryIndex(state.sourceEntries, sourceRoute, compactEntry);
    }
    if (sourceKey) {
        addSourceEntryIndex(state.sourceEntriesByKey, sourceKey, compactEntry);
    }
    recordFacetEntry(state.facets, entry);
    analysis.summary.stagePathCounts[entry.stage] = (analysis.summary.stagePathCounts[entry.stage] || 0) + 1;
    analysis.summary.filteredPathCount = (analysis.summary.filteredPathCount || 0) + 1;
}

function applyBmpRouteAssuranceMutation(analysis, mutation = {}) {
    const state = analysis?._incremental;
    if (!state || !mutation.clientKey || !mutation.ownerKey || !mutation.routeKey) {
        return false;
    }
    const startedAt = Date.now();
    const scope = mutation.scope === 'instance' ? 'instance' : 'session';
    const stage = mutation.stage || getRouteAssuranceStage(mutation.ribType, scope);
    if (!stage) {
        return false;
    }
    const filters = normalizeFilters(analysis.filters);
    const mutationClientMatches = entryMatchesClient(
        { client: makeClientInfo(mutation.clientKey, mutation.bmpSession) },
        filters.client
    );
    const previousRoute = mutation.previous || mutation.route;
    const previousSourceEntry =
        (mutation.sourceKey && state.sourceEntriesByKey?.get(mutation.sourceKey)) ||
        (previousRoute && (typeof previousRoute === 'object' || typeof previousRoute === 'function')
            ? state.sourceEntries.get(previousRoute) || null
            : null);
    const oldEntries = Array.isArray(previousSourceEntry)
        ? [...previousSourceEntry]
        : previousSourceEntry
          ? [previousSourceEntry]
          : [];
    let nextEntry = null;
    if (mutation.action !== 'delete') {
        nextEntry = makeRouteAssuranceEntry({ ...mutation, scope, stage });
        if (nextEntry && !entryMatchesAnalysis(nextEntry, filters)) {
            nextEntry = null;
        }
    }
    const affectedGroupKeys = new Set();
    oldEntries.forEach(oldEntry => affectedGroupKeys.add(getEntryMeta(oldEntry).groupKey));
    if (nextEntry) {
        affectedGroupKeys.add(`${nextEntry.client.key}\u001f${nextEntry.nlriKey}`);
    }
    affectedGroupKeys.forEach(groupKey => removeGroupIssues(analysis, groupKey));
    oldEntries.forEach(oldEntry =>
        removeAnalysisEntry(analysis, oldEntry, previousRoute, mutation.sourceKey || oldEntry.sourceKey)
    );
    if (nextEntry) {
        addAnalysisEntry(analysis, nextEntry, mutation.route, mutation.sourceKey || nextEntry.sourceKey);
    }
    affectedGroupKeys.forEach(groupKey => addGroupIssues(analysis, groupKey));

    if (mutation.adjustScannedPathCount !== false && mutation.sourceKey && state.sourcePathKeys) {
        const wasCounted = state.sourcePathKeys.has(mutation.sourceKey);
        const isCounted = mutation.action !== 'delete' && mutationClientMatches;
        if (wasCounted && !isCounted) {
            state.sourcePathKeys.delete(mutation.sourceKey);
            analysis.summary.scannedPathCount = Math.max(0, (analysis.summary.scannedPathCount || 0) - 1);
        } else if (!wasCounted && isCounted) {
            state.sourcePathKeys.add(mutation.sourceKey);
            analysis.summary.scannedPathCount = (analysis.summary.scannedPathCount || 0) + 1;
        }
    } else if (mutation.adjustScannedPathCount !== false) {
        if (mutation.action === 'delete' && mutationClientMatches) {
            analysis.summary.scannedPathCount = Math.max(0, (analysis.summary.scannedPathCount || 0) - 1);
        } else if (mutation.action !== 'delete' && mutation.isNew === true && mutationClientMatches) {
            analysis.summary.scannedPathCount = (analysis.summary.scannedPathCount || 0) + 1;
        }
    }
    state.updateCount += 1;
    analysis.summary.incrementalUpdateCount = state.updateCount;
    analysis.summary.lastIncrementalDurationMs = Date.now() - startedAt;
    analysis.generatedAt = new Date().toISOString();
    refreshIncrementalFacets(analysis);
    return true;
}

function applyBmpRouteAssuranceBootstrapMutation(analysis, mutation = {}) {
    const sourceEntries = analysis?._incremental?.sourceEntries;
    if (!sourceEntries) {
        return false;
    }
    if (mutation.sourceKey) {
        return applyBmpRouteAssuranceMutation(analysis, mutation);
    }
    const candidateRoutes =
        mutation.bootstrapCandidateRoutes instanceof Set
            ? Array.from(mutation.bootstrapCandidateRoutes)
            : [mutation.previous, mutation.route].filter(Boolean);
    const presentRoutes = candidateRoutes.filter(
        route =>
            ((typeof route === 'object' && route !== null) || typeof route === 'function') && sourceEntries.has(route)
    );
    const finalRoutePresent =
        mutation.action !== 'delete' &&
        mutation.route &&
        ((typeof mutation.route === 'object' && mutation.route !== null) || typeof mutation.route === 'function') &&
        sourceEntries.has(mutation.route);
    const primaryPrevious = finalRoutePresent ? mutation.route : presentRoutes[0] || mutation.previous;
    const applied = applyBmpRouteAssuranceMutation(analysis, {
        ...mutation,
        previous: primaryPrevious,
        isNew: primaryPrevious ? false : mutation.bootstrapInitiallyNew === true
    });

    // A Map key is normally visited once. Delete/reinsert can move it while the
    // chunked baseline iterator is yielding, so remove any extra stale object
    // that the baseline happened to retain without changing the path total twice.
    presentRoutes.forEach(route => {
        if (route === primaryPrevious || (mutation.action !== 'delete' && route === mutation.route)) {
            return;
        }
        applyBmpRouteAssuranceMutation(analysis, {
            ...mutation,
            action: 'delete',
            previous: route,
            route,
            isNew: false,
            adjustScannedPathCount: false
        });
    });
    return applied;
}

function finalizeBmpRouteAssuranceAnalysis(collection, filters, startedAt, prebuiltIssueIndex = null) {
    const { grouped, facets, filteredPathCount, scannedPathCount, stagePathCounts } = collection;
    const issueIndex = prebuiltIssueIndex || buildIssues(grouped);
    const stageCounts = issueIndex.stageCounts || buildStageCounts(grouped);
    const { allIssues, issuesByCategory } = issueIndex;
    const categoryCounts = Object.fromEntries(
        CATEGORIES.map(category => [category, issuesByCategory[category].length])
    );
    const uniqueNlriCount = grouped.size;
    const clientCount = facets.clients.size;

    const analysis = {
        filters: {
            client: filters.client,
            vrf: filters.vrf,
            af: filters.af,
            query: filters.query,
            routeState: filters.routeState
        },
        funnel: { ...stageCounts },
        summary: {
            stageCounts,
            stagePathCounts,
            uniqueNlriCount,
            totalIssueCount: allIssues.length,
            categoryCounts,
            clientCount,
            scannedPathCount,
            filteredPathCount,
            scanDurationMs: Date.now() - startedAt
        },
        facets: buildFacets(facets, allIssues, categoryCounts),
        allIssues,
        issuesByCategory,
        generatedAt: new Date().toISOString()
    };
    Object.defineProperty(analysis, '_incremental', {
        value: makeIncrementalState(collection, issueIndex),
        enumerable: false
    });
    return analysis;
}

function buildBmpRouteAssuranceAnalysis(bmpSessionMap, options = {}) {
    const startedAt = Date.now();
    const filters = normalizeFilters(options);
    const collection = collectGroupedEntries(bmpSessionMap, filters);
    return finalizeBmpRouteAssuranceAnalysis(collection, filters, startedAt);
}

async function buildBmpRouteAssuranceAnalysisAsync(bmpSessionMap, options = {}, control = {}) {
    const startedAt = Date.now();
    const filters = normalizeFilters(options);
    const collection = await collectGroupedEntriesAsync(bmpSessionMap, filters, control);
    if (control.shouldCancel?.()) {
        const error = new Error('路由矩阵分析初始化已取消');
        error.code = 'BMP_ROUTE_ASSURANCE_CANCELLED';
        throw error;
    }
    await yieldToEventLoop();
    const issueIndex = await buildIssuesAsync(collection.grouped, {
        issueChunkSize: control.issueChunkSize,
        shouldCancel: control.shouldCancel,
        onIssueProgress: progress => {
            control.onProgress?.({
                scannedPathCount: collection.scannedPathCount,
                ...progress
            });
        }
    });
    return finalizeBmpRouteAssuranceAnalysis(collection, filters, startedAt, issueIndex);
}

async function buildBmpRouteAssuranceAnalysisFromPersistedRoutesAsync(routeRows, options = {}, control = {}) {
    const startedAt = Date.now();
    const filters = normalizeFilters(options);
    const collection = await collectPersistedGroupedEntriesAsync(routeRows, filters, control);
    if (control.shouldCancel?.()) {
        const error = new Error('路由矩阵分析初始化已取消');
        error.code = 'BMP_ROUTE_ASSURANCE_CANCELLED';
        throw error;
    }
    await yieldToEventLoop();
    const issueIndex = await buildIssuesAsync(collection.grouped, {
        issueChunkSize: control.issueChunkSize,
        shouldCancel: control.shouldCancel,
        onIssueProgress: progress => {
            control.onProgress?.({
                scannedPathCount: collection.scannedPathCount,
                ...progress
            });
        }
    });
    return finalizeBmpRouteAssuranceAnalysis(collection, filters, startedAt, issueIndex);
}

function selectIssuePage(analysis, categories, offset, pageSize) {
    const allIssues = Array.isArray(analysis?.allIssues) ? analysis.allIssues : [];
    if (categories.length === 0) {
        return {
            total: allIssues.length,
            issues: allIssues.slice(offset, offset + pageSize)
        };
    }

    const buckets = analysis?.issuesByCategory || {};
    const selectedCategories = CATEGORIES.filter(category => categories.includes(category));
    const total = selectedCategories.reduce(
        (count, category) => count + (Array.isArray(buckets[category]) ? buckets[category].length : 0),
        0
    );
    const issues = [];
    let skipped = 0;
    for (const category of selectedCategories) {
        const bucket = Array.isArray(buckets[category]) ? buckets[category] : [];
        if (skipped + bucket.length <= offset) {
            skipped += bucket.length;
            continue;
        }
        const start = Math.max(0, offset - skipped);
        const remaining = pageSize - issues.length;
        issues.push(...bucket.slice(start, start + remaining));
        skipped += bucket.length;
        if (issues.length >= pageSize) {
            break;
        }
    }
    return { total, issues };
}

function paginateBmpRouteAssuranceAnalysis(analysis, options = {}) {
    const filters = normalizeFilters({ ...analysis?.filters, ...options });
    const allIssueCount = Array.isArray(analysis?.allIssues) ? analysis.allIssues.length : 0;
    const selectedIssueCount =
        filters.category.length === 0
            ? allIssueCount
            : filters.category.reduce(
                  (count, category) => count + (analysis?.issuesByCategory?.[category]?.length || 0),
                  0
              );
    const total = selectedIssueCount;
    const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
    const page = Math.min(filters.page, totalPages);
    const offset = (page - 1) * filters.pageSize;
    const selectedPage = selectIssuePage(analysis, filters.category, offset, filters.pageSize);

    return {
        filters: { ...filters, category: filters.category.length === 1 ? filters.category[0] : filters.category },
        funnel: { ...(analysis?.funnel || {}) },
        summary: {
            ...(analysis?.summary || {}),
            issueCount: total
        },
        facets: analysis?.facets || {},
        issues: selectedPage.issues,
        pagination: {
            page,
            pageSize: filters.pageSize,
            total,
            totalPages
        },
        generatedAt: analysis?.generatedAt || new Date().toISOString()
    };
}

function buildBmpRouteAssurance(bmpSessionMap, options = {}) {
    const analysis = buildBmpRouteAssuranceAnalysis(bmpSessionMap, options);
    return paginateBmpRouteAssuranceAnalysis(analysis, options);
}

module.exports = {
    CATEGORIES,
    CATEGORY_LABELS,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    MAX_SORTED_ISSUES,
    STAGES,
    buildBmpRouteAssurance,
    buildBmpRouteAssuranceAnalysis,
    buildBmpRouteAssuranceAnalysisAsync,
    buildBmpRouteAssuranceAnalysisFromPersistedRoutesAsync,
    countBmpRouteAssuranceSourcePaths,
    paginateBmpRouteAssuranceAnalysis,
    applyBmpRouteAssuranceMutation,
    applyBmpRouteAssuranceBootstrapMutation,
    getRouteAssuranceStage,
    makeRouteAssuranceEntry,
    makeRouteAssuranceSourceKey,
    makePersistedRouteAssuranceSourceKey,
    normalizeBmpRouteAssuranceCommittedDelta
};
