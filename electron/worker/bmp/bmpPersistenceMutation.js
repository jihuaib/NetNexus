const crypto = require('crypto');
const ipaddr = require('ipaddr.js');
const {
    canonicalStringify,
    createSourceKey,
    createScopeKey,
    createRouteKey
} = require('../../utils/bmpPersistentRouteKey');
const { canonicalizeBmpRouteAttr } = require('./bmpRouteAttrStore');

let lastConnectionGeneration = 0;
const DUPLICATED_ROUTE_ATTRIBUTE_FIELDS = [
    'origin',
    'asPath',
    'med',
    'nextHop',
    'localPref',
    'communities',
    'otc',
    'prefixSid',
    'attrId',
    'attrRefCount',
    'routeState',
    'ribEpoch',
    'staleEpoch',
    'lastSeenAt',
    'staleAt',
    'staleReason'
];
const ROUTE_IDENTITY_PAYLOAD_FIELDS = [
    'routeKey',
    'addrFamilyType',
    'afi',
    'safi',
    'ip',
    'prefix',
    'mask',
    'length',
    'rd',
    'pathId',
    'rawNlri',
    'nlriDetail'
];
const ZERO_VALUE_PAYLOAD_FIELDS = new Set(['parseStatus', 'pathStatusUnknownBits', 'routeTlvCount']);

function compactRoutePayload(routeInfo) {
    const payload = { ...routeInfo };
    [...DUPLICATED_ROUTE_ATTRIBUTE_FIELDS, ...ROUTE_IDENTITY_PAYLOAD_FIELDS].forEach(field => delete payload[field]);
    Object.entries(payload).forEach(([field, value]) => {
        if (
            value === null ||
            (Array.isArray(value) && value.length === 0) ||
            (value && value.constructor === Object && Object.keys(value).length === 0) ||
            (value === 0 && ZERO_VALUE_PAYLOAD_FIELDS.has(field))
        ) {
            delete payload[field];
        }
    });
    return payload;
}

function nextConnectionGeneration() {
    const wallClockGeneration = Date.now() * 1000;
    lastConnectionGeneration = Math.max(wallClockGeneration, lastConnectionGeneration + 1);
    return lastConnectionGeneration;
}

function stringify(value) {
    return JSON.stringify(value, (_key, item) => {
        if (typeof item === 'bigint') {
            return item.toString();
        }
        if (item instanceof Map) {
            return Object.fromEntries(item);
        }
        if (item instanceof Set) {
            return Array.from(item);
        }
        return item;
    });
}

function normalizePersistedPrefix(value, length) {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value).trim();
    if (!ipaddr.isValid(text)) return text;

    const address = ipaddr.parse(text);
    const prefixLength = length === null || length === undefined || length === '' ? null : Number(length);
    const maximum = address.kind() === 'ipv4' ? 32 : 128;
    if (Number.isInteger(prefixLength) && prefixLength >= 0 && prefixLength <= maximum) {
        return address.constructor.networkAddressFromCIDR(`${address.toString()}/${prefixLength}`).toString();
    }
    return address.toString();
}

function makeConnectionId() {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return crypto.randomBytes(16).toString('hex');
}

function ensurePersistenceContext(bmpSession) {
    if (!bmpSession.persistenceConnectionId) {
        bmpSession.persistenceConnectionId = makeConnectionId();
    }
    if (!bmpSession.persistenceOpenedAtMs) {
        bmpSession.persistenceOpenedAtMs = Date.now();
    }
    if (!Number.isSafeInteger(bmpSession.persistenceConnectionGeneration)) {
        bmpSession.persistenceConnectionGeneration = nextConnectionGeneration();
    }
    if (!bmpSession.persistenceSourceKey) {
        const key = createSourceKey({
            sysName: bmpSession.sysName || undefined,
            sourceAddress: bmpSession.remoteIp
        });
        bmpSession.persistenceSourceKey = key;
    }
    if (!Number.isInteger(bmpSession.persistenceSequence)) {
        bmpSession.persistenceSequence = 0;
    }
}

function nextSequence(bmpSession) {
    ensurePersistenceContext(bmpSession);
    bmpSession.persistenceSequence += 1;
    return bmpSession.persistenceSequence;
}

function buildSource(bmpSession) {
    ensurePersistenceContext(bmpSession);
    const key = bmpSession.persistenceSourceKey;
    return {
        id: key.keyHex,
        keyJson: stringify({
            schemaVersion: key.schemaVersion,
            algorithm: key.algorithm,
            keyHex: key.keyHex
        }),
        identityJson: canonicalStringify(key.canonicalIdentity),
        remoteIp: bmpSession.remoteIp || null,
        sysName: bmpSession.sysName || null,
        sysDesc: bmpSession.sysDesc || null,
        metadata: {
            bmpVersion: bmpSession.bmpVersion || null,
            bmpV4TlvDraft: bmpSession.getBmpV4TlvDraft?.() || null
        }
    };
}

function buildConnection(bmpSession) {
    ensurePersistenceContext(bmpSession);
    return {
        id: bmpSession.persistenceConnectionId,
        localIp: bmpSession.localIp || null,
        localPort: bmpSession.localPort || null,
        remoteIp: bmpSession.remoteIp || null,
        remotePort: bmpSession.remotePort || null,
        openedAtMs: bmpSession.persistenceOpenedAtMs,
        generation: bmpSession.persistenceConnectionGeneration
    };
}

function buildScope(bmpSession, owner, afi, safi, ribType, options = {}) {
    const source = buildSource(bmpSession);
    if (options.kind !== 'peer' && options.kind !== 'loc-rib') {
        throw new Error(`Unsupported BMP route scope kind: ${options.kind}`);
    }
    const isInstance = options.kind === 'loc-rib';
    const peerType = isInstance ? owner.instanceType : owner.sessionType;
    const peerRd = isInstance ? owner.instanceRd : owner.sessionRd;
    const peerRdIdentity = isInstance ? owner.instanceRdRaw || owner.instanceRd : owner.sessionRdRaw || owner.sessionRd;
    const peerIp = isInstance ? owner.instanceIp : owner.sessionIp;
    const peerAs = isInstance ? owner.instanceAs : owner.sessionAs;
    const stage = isInstance ? 'loc-rib' : ribType;
    const scopeInput = {
        sourceKey: source.id,
        scopeKind: isInstance ? 'loc-rib' : 'peer',
        peerType,
        peerRd: peerRdIdentity,
        peerAddress: peerIp || undefined,
        peerAs,
        afi,
        safi,
        ribType: stage
    };
    const key = createScopeKey(scopeInput);
    const epoch = isInstance ? owner.getRibEpoch() : owner.getRibEpoch(afi, safi, ribType);
    const ownerKey = isInstance
        ? `${owner.instanceType}|${peerRdIdentity}|${afi}|${safi}`
        : `${owner.sessionType}|${peerRdIdentity}|${owner.sessionIp}|${owner.sessionAs}`;
    return {
        id: key.keyHex,
        keyJson: stringify({
            schemaVersion: key.schemaVersion,
            algorithm: key.algorithm,
            keyHex: key.keyHex
        }),
        identityJson: canonicalStringify(key.canonicalIdentity),
        kind: isInstance ? 'loc-rib' : 'peer',
        ownerKey,
        peerType,
        peerRd,
        peerIp: peerIp || null,
        peerAs,
        vrfName: Array.isArray(owner.vrfTableNames) ? owner.vrfTableNames[0] || null : null,
        afi: Number(afi),
        safi: Number(safi),
        ribType: String(stage),
        epoch,
        state: options.state || 'syncing',
        reason: options.reason || null
    };
}

function buildRoute(owner, route, afi, safi) {
    const routeInfo = typeof route.getRouteInfo === 'function' ? route.getRouteInfo() : { ...route };
    const compactRouteInfo = compactRoutePayload(routeInfo);
    const key = createRouteKey({
        afi,
        safi,
        pathId: route.pathId,
        route,
        nlri: route.nlriDetail || routeInfo.nlriDetail || route
    });
    const attr = route?.getRouteAttr?.() || owner?.getRouteAttr?.(route) || null;
    const canonicalAttr = attr ? canonicalizeBmpRouteAttr(attr) : null;
    const attrJson = canonicalAttr ? stringify(canonicalAttr) : null;
    const attrId = attrJson ? crypto.createHash('sha256').update(attrJson).digest('hex') : null;
    const rawPrefix = route.ip || route.prefix || routeInfo.ip || routeInfo.prefix || null;
    const prefixLength = route.mask ?? route.length ?? routeInfo.mask ?? routeInfo.length ?? null;
    return {
        id: key.keyHex,
        keyJson: stringify({
            schemaVersion: key.schemaVersion,
            algorithm: key.algorithm,
            keyHex: key.keyHex
        }),
        identityJson: canonicalStringify(key.canonicalIdentity),
        keyVersion: key.schemaVersion,
        legacyRouteKey: routeInfo.routeKey || route.getRouteKey?.() || null,
        afi: Number(afi),
        safi: Number(safi),
        pathId: Number(route.pathId || 0),
        rd: route.rd || null,
        prefix: normalizePersistedPrefix(rawPrefix, prefixLength),
        prefixLength,
        nlriKind: key.canonicalIdentity.nlri.kind,
        nlriJson: stringify(route.nlriDetail || routeInfo.nlriDetail || route),
        attrId,
        attrJson,
        routeJson: stringify(compactRouteInfo)
    };
}

function buildWithdrawRoute(owner, withdrawn, afi, safi, existingRoute = null) {
    if (existingRoute) {
        return buildRoute(owner, existingRoute, afi, safi);
    }

    const route = {
        afi: Number(afi),
        safi: Number(safi),
        pathId: Number(withdrawn.pathId || 0),
        rd: withdrawn.rd || '0:0',
        ip: withdrawn.prefix,
        mask: withdrawn.length,
        nlriDetail: withdrawn
    };
    const key = createRouteKey({ afi, safi, route, nlri: withdrawn });
    const legacyRouteKey = `${route.pathId}|${route.rd}|${route.ip}|${route.mask}`;
    return {
        id: key.keyHex,
        keyJson: stringify({
            schemaVersion: key.schemaVersion,
            algorithm: key.algorithm,
            keyHex: key.keyHex
        }),
        identityJson: canonicalStringify(key.canonicalIdentity),
        keyVersion: key.schemaVersion,
        legacyRouteKey,
        afi: route.afi,
        safi: route.safi,
        pathId: route.pathId,
        rd: route.rd,
        prefix: normalizePersistedPrefix(route.ip, route.mask),
        prefixLength: route.mask,
        nlriKind: key.canonicalIdentity.nlri.kind,
        nlriJson: stringify(withdrawn),
        attrId: null,
        attrJson: null,
        routeJson: stringify(
            compactRoutePayload({
                routeKey: legacyRouteKey,
                afi: route.afi,
                safi: route.safi,
                pathId: route.pathId,
                rd: route.rd,
                ip: route.ip,
                mask: route.mask,
                nlriDetail: withdrawn
            })
        )
    };
}

function buildBaseMutation(bmpSession, eventType, options = {}) {
    return {
        eventType,
        sequence: nextSequence(bmpSession),
        eventAtMs: options.eventAtMs || Date.now(),
        sourceTimestampMs: options.sourceTimestampMs ?? null,
        reason: options.reason || null,
        source: buildSource(bmpSession),
        connection: buildConnection(bmpSession)
    };
}

function buildConnectionMutation(bmpSession, eventType, options = {}) {
    return buildBaseMutation(bmpSession, eventType, options);
}

function buildScopeMutation(bmpSession, owner, afi, safi, ribType, eventType, options = {}) {
    const mutation = buildBaseMutation(bmpSession, eventType, options);
    mutation.scope = buildScope(bmpSession, owner, afi, safi, ribType, options);
    return mutation;
}

function buildRouteUpsertMutation(bmpSession, owner, route, afi, safi, ribType, options = {}) {
    const routeData = buildRoute(owner, route, afi, safi);
    let eventType = options.isNewRoute === undefined ? 'upsert' : 'announce';
    if (options.isNewRoute === false) {
        eventType = options.previousAttrHash === routeData.attrId ? 'refresh' : 'replace';
    }
    const mutation = buildScopeMutation(bmpSession, owner, afi, safi, ribType, eventType, options);
    mutation.scope.state = options.scopeState || 'syncing';
    mutation.route = routeData;
    return mutation;
}

function buildRouteWithdrawMutation(bmpSession, owner, withdrawn, existingRoute, afi, safi, ribType, options = {}) {
    const eventType = options.eventType === 'purge' ? 'purge' : 'withdraw';
    const mutation = buildScopeMutation(bmpSession, owner, afi, safi, ribType, eventType, options);
    mutation.route = buildWithdrawRoute(owner, withdrawn, afi, safi, existingRoute);
    return mutation;
}

function buildRoutePurgeMutation(bmpSession, owner, route, afi, safi, ribType, options = {}) {
    return buildRouteWithdrawMutation(bmpSession, owner, route, route, afi, safi, ribType, {
        ...options,
        eventType: 'purge',
        reason: options.reason || 'manual-stale-purge'
    });
}

module.exports = {
    ensurePersistenceContext,
    buildSource,
    buildScope,
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation,
    buildRouteWithdrawMutation,
    buildRoutePurgeMutation
};
