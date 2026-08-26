const crypto = require('crypto');
const ipaddr = require('ipaddr.js');
const {
    canonicalStringify,
    createSourceKey,
    createScopeKey,
    createRouteKey
} = require('../../utils/bmpPersistentRouteKey');

// Per-owner cache of the immutable part of a scope descriptor (key, identity,
// peer columns); only epoch/state/reason vary per mutation.
const SCOPE_DESCRIPTOR_CACHE = new WeakMap();
// Per-attribute-object cache of the canonical JSON + hash. Routes announced in
// one UPDATE share the attribute object, so one hash serves the whole batch.
const ATTR_OBJECT_CACHE = new WeakMap();
const ATTR_ID_CACHE = new Map();
const ATTR_ID_CACHE_LIMIT = 50_000;
const PAYLOAD_FIELDS = [
    'rdRaw',
    'labels',
    'routeType',
    'parseStatus',
    'pathStatus',
    'pathStatusNames',
    'pathStatusText',
    'pathStatusUnknownBits',
    'pathStatusReason',
    'pathStatusReasonName',
    'pathStatusReasonText',
    'pathStatusReasons',
    'routeTlvs',
    'routeTlvCount'
];
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

function isEmptyPayloadValue(field, value) {
    return (
        value === null ||
        (Array.isArray(value) && value.length === 0) ||
        (value && value.constructor === Object && Object.keys(value).length === 0) ||
        (value === 0 && ZERO_VALUE_PAYLOAD_FIELDS.has(field))
    );
}

function compactRoutePayload(routeInfo) {
    const payload = { ...routeInfo };
    [...DUPLICATED_ROUTE_ATTRIBUTE_FIELDS, ...ROUTE_IDENTITY_PAYLOAD_FIELDS].forEach(field => delete payload[field]);
    Object.entries(payload).forEach(([field, value]) => {
        if (isEmptyPayloadValue(field, value)) {
            delete payload[field];
        }
    });
    return payload;
}

// Same result as compactRoutePayload(route.getRouteInfo()) for a BmpBgpRoute,
// without materializing the full route info object first.
function buildRoutePayload(route) {
    if (typeof route?.getPathStatusInfo !== 'function' || typeof route.getRouteTlvInfo !== 'function') {
        const routeInfo = typeof route?.getRouteInfo === 'function' ? route.getRouteInfo() : { ...route };
        return compactRoutePayload(routeInfo);
    }
    const source = {
        rdRaw: route.rdRaw,
        labels: route.labels,
        routeType: route.routeType,
        parseStatus: route.parseStatus || route.constructor.makeParseStatus(),
        ...route.getPathStatusInfo(),
        ...route.getRouteTlvInfo()
    };
    const payload = {};
    PAYLOAD_FIELDS.forEach(field => {
        const value = source[field];
        if (value !== undefined && !isEmptyPayloadValue(field, value)) {
            payload[field] = value;
        }
    });
    return payload;
}

function resolveRouteAttrIdentity(route, owner) {
    const attr = route?.getRouteAttr?.() || owner?.getRouteAttr?.(route) || null;
    if (!attr) {
        return { attrId: null, attrJson: null };
    }
    let cached = typeof attr === 'object' ? ATTR_OBJECT_CACHE.get(attr) : undefined;
    if (cached) {
        return cached;
    }
    const memoryAttrId = typeof route?.attrId === 'string' && route.attrId ? route.attrId : null;
    if (memoryAttrId) {
        cached = ATTR_ID_CACHE.get(memoryAttrId);
        if (cached) {
            if (typeof attr === 'object') {
                ATTR_OBJECT_CACHE.set(attr, cached);
            }
            return cached;
        }
    }
    const attrJson = JSON.stringify(canonicalizeBmpRouteAttr(attr));
    cached = { attrId: crypto.createHash('sha256').update(attrJson).digest('hex'), attrJson };
    if (typeof attr === 'object') {
        ATTR_OBJECT_CACHE.set(attr, cached);
    }
    if (memoryAttrId) {
        if (ATTR_ID_CACHE.size >= ATTR_ID_CACHE_LIMIT) {
            ATTR_ID_CACHE.clear();
        }
        ATTR_ID_CACHE.set(memoryAttrId, cached);
    }
    return cached;
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
    // The key/identity JSON never changes for a session; build it once.
    let sourceDescriptor = bmpSession.persistenceSourceDescriptor;
    if (!sourceDescriptor || sourceDescriptor.id !== key.keyHex) {
        sourceDescriptor = {
            id: key.keyHex,
            keyJson: stringify({
                schemaVersion: key.schemaVersion,
                algorithm: key.algorithm,
                keyHex: key.keyHex
            }),
            identityJson: canonicalStringify(key.canonicalIdentity)
        };
        bmpSession.persistenceSourceDescriptor = sourceDescriptor;
    }
    return {
        id: sourceDescriptor.id,
        keyJson: sourceDescriptor.keyJson,
        identityJson: sourceDescriptor.identityJson,
        remoteIp: bmpSession.remoteIp || null,
        sysName: bmpSession.sysName || null,
        sysDesc: bmpSession.sysDesc || null,
        metadata: {
            bmpVersion: bmpSession.bmpVersion || null,
            bmpV4TlvDraft: bmpSession.getBmpV4TlvDraft?.() || null,
            transport: bmpSession.transport || 'tcp',
            authentication: bmpSession.authentication || 'none',
            authProfileId: bmpSession.authProfileId || null,
            authProfileName: bmpSession.authProfileName || null,
            authPeer: bmpSession.authPeer || null,
            tcpAoProfileId: bmpSession.tcpAoProfileId || null,
            tcpAoProfileName: bmpSession.tcpAoProfileName || null,
            tcpAoPeer: bmpSession.tcpAoPeer || null,
            tcpMd5ProfileId: bmpSession.tcpMd5ProfileId || null,
            tcpMd5ProfileName: bmpSession.tcpMd5ProfileName || null,
            tcpMd5Peer: bmpSession.tcpMd5Peer || null
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
    const descriptorKey = `${afi}|${safi}|${stage}`;
    let descriptors = SCOPE_DESCRIPTOR_CACHE.get(owner);
    if (!descriptors) {
        descriptors = new Map();
        SCOPE_DESCRIPTOR_CACHE.set(owner, descriptors);
    }
    let descriptor = descriptors.get(descriptorKey);
    // Peer identity fields live on the owner and can in principle be
    // re-assigned; validate the cached descriptor against them cheaply.
    if (
        descriptor &&
        (descriptor.sourceId !== source.id ||
            descriptor.peerType !== peerType ||
            descriptor.peerRdIdentity !== peerRdIdentity ||
            descriptor.peerIp !== (peerIp || null) ||
            descriptor.peerAs !== peerAs)
    ) {
        descriptor = null;
    }
    if (!descriptor) {
        const key = createScopeKey({
            sourceKey: source.id,
            scopeKind: isInstance ? 'loc-rib' : 'peer',
            peerType,
            peerRd: peerRdIdentity,
            peerAddress: peerIp || undefined,
            peerAs,
            afi,
            safi,
            ribType: stage
        });
        descriptor = {
            sourceId: source.id,
            peerRdIdentity,
            id: key.keyHex,
            keyJson: stringify({
                schemaVersion: key.schemaVersion,
                algorithm: key.algorithm,
                keyHex: key.keyHex
            }),
            identityJson: canonicalStringify(key.canonicalIdentity),
            kind: isInstance ? 'loc-rib' : 'peer',
            ownerKey: isInstance
                ? `${owner.instanceType}|${peerRdIdentity}|${afi}|${safi}`
                : `${owner.sessionType}|${peerRdIdentity}|${owner.sessionIp}|${owner.sessionAs}`,
            peerType,
            peerRd,
            peerIp: peerIp || null,
            peerAs,
            afi: Number(afi),
            safi: Number(safi),
            ribType: String(stage)
        };
        descriptors.set(descriptorKey, descriptor);
    }
    return {
        id: descriptor.id,
        keyJson: descriptor.keyJson,
        identityJson: descriptor.identityJson,
        kind: descriptor.kind,
        ownerKey: descriptor.ownerKey,
        peerType: descriptor.peerType,
        peerRd: descriptor.peerRd,
        peerIp: descriptor.peerIp,
        peerAs: descriptor.peerAs,
        afi: descriptor.afi,
        safi: descriptor.safi,
        ribType: descriptor.ribType,
        vrfName: Array.isArray(owner.vrfTableNames) ? owner.vrfTableNames[0] || null : null,
        epoch: isInstance ? owner.getRibEpoch() : owner.getRibEpoch(afi, safi, ribType),
        state: options.state || 'syncing',
        reason: options.reason || null
    };
}

// Plain IP prefixes carry an NLRI detail that only repeats the identity
// columns (prefix, length, path id, rd, valid). Those are not stored as JSON:
// nlriJson becomes null and nlriFlags records which optional keys were
// present so the reader can rebuild the identical object.
const COMPACT_NLRI_KEYS = new Set(['pathId', 'prefix', 'length', 'rd', 'valid']);
const NLRI_FLAG_VALID = 1;
const NLRI_FLAG_RD = 2;

function compactNlri(nlriDetail, { prefix, prefixLength, pathId, rd }) {
    if (!nlriDetail || typeof nlriDetail !== 'object' || Array.isArray(nlriDetail)) {
        return null;
    }
    const keys = Object.keys(nlriDetail);
    if (!keys.every(key => COMPACT_NLRI_KEYS.has(key))) {
        return null;
    }
    if (
        !('pathId' in nlriDetail) ||
        !('prefix' in nlriDetail) ||
        !('length' in nlriDetail) ||
        nlriDetail.prefix !== prefix ||
        Number(nlriDetail.length) !== Number(prefixLength) ||
        Number(nlriDetail.pathId) !== Number(pathId)
    ) {
        return null;
    }
    let flags = 0;
    if ('valid' in nlriDetail) {
        if (nlriDetail.valid !== true) {
            return null;
        }
        flags |= NLRI_FLAG_VALID;
    }
    if ('rd' in nlriDetail) {
        if (nlriDetail.rd !== rd) {
            return null;
        }
        flags |= NLRI_FLAG_RD;
    }
    return flags;
}

function rebuildCompactNlri({ prefix, prefixLength, pathId, rd, flags }) {
    const nlriDetail = { pathId: Number(pathId || 0), prefix, length: Number(prefixLength) };
    if ((flags & NLRI_FLAG_RD) !== 0) {
        nlriDetail.rd = rd;
    }
    if ((flags & NLRI_FLAG_VALID) !== 0) {
        nlriDetail.valid = true;
    }
    return nlriDetail;
}

function buildRoute(owner, route, afi, safi) {
    const nlriDetail = route.nlriDetail || route;
    const key = createRouteKey({
        afi,
        safi,
        pathId: route.pathId,
        route,
        nlri: nlriDetail
    });
    const { attrId, attrJson } = resolveRouteAttrIdentity(route, owner);
    const rawPrefix = route.ip || route.prefix || null;
    const prefixLength = route.mask ?? route.length ?? null;
    const canonicalPrefix = key.canonicalIdentity.nlri.prefix;
    // For IP kinds the key already normalized the network text; other NLRI
    // keep the parser's semantic identity string as the persisted prefix.
    const persistedPrefix =
        canonicalPrefix && canonicalPrefix.networkText
            ? canonicalPrefix.networkText
            : normalizePersistedPrefix(rawPrefix, prefixLength);
    const nlriFlags =
        key.canonicalIdentity.nlri.kind === 'ip-prefix'
            ? compactNlri(nlriDetail, {
                  prefix: persistedPrefix,
                  prefixLength,
                  pathId: Number(route.pathId || 0),
                  rd: route.rd || null
              })
            : null;
    return {
        id: key.keyHex,
        // Canonical identity string (not JSON): what the route id hashes.
        identityJson: key.canonicalJson,
        keyVersion: key.schemaVersion,
        legacyRouteKey: route.getRouteKey?.() || route.routeKey || null,
        afi: Number(afi),
        safi: Number(safi),
        pathId: Number(route.pathId || 0),
        rd: route.rd || null,
        prefix: persistedPrefix,
        prefixLength,
        nlriKind: key.canonicalIdentity.nlri.kind,
        nlriJson: nlriFlags === null ? stringify(nlriDetail) : null,
        nlriFlags: nlriFlags ?? 0,
        attrId,
        attrJson,
        routeJson: stringify(buildRoutePayload(route))
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
    const withdrawnPrefix = normalizePersistedPrefix(route.ip, route.mask);
    const withdrawnFlags =
        key.canonicalIdentity.nlri.kind === 'ip-prefix'
            ? compactNlri(withdrawn, {
                  prefix: withdrawnPrefix,
                  prefixLength: route.mask,
                  pathId: route.pathId,
                  rd: route.rd
              })
            : null;
    return {
        id: key.keyHex,
        identityJson: key.canonicalJson,
        keyVersion: key.schemaVersion,
        legacyRouteKey,
        afi: route.afi,
        safi: route.safi,
        pathId: route.pathId,
        rd: route.rd,
        prefix: withdrawnPrefix,
        prefixLength: route.mask,
        nlriKind: key.canonicalIdentity.nlri.kind,
        nlriJson: withdrawnFlags === null ? stringify(withdrawn) : null,
        nlriFlags: withdrawnFlags ?? 0,
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
    rebuildCompactNlri,
    compactRoutePayload,
    ensurePersistenceContext,
    buildSource,
    buildScope,
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation,
    buildRouteWithdrawMutation,
    buildRoutePurgeMutation
};
