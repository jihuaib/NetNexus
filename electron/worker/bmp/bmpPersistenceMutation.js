const crypto = require('crypto');
const ipaddr = require('ipaddr.js');
const {
    canonicalStringify,
    createSourceKey,
    createScopeKey,
    createRouteKey,
    formatRouteLookupKey
} = require('../../utils/bmp/bmpPersistentRouteKey');

// Per-owner cache of the immutable part of a scope descriptor (key, identity,
// peer columns); only epoch/state/reason vary per mutation.
const SCOPE_DESCRIPTOR_CACHE = new WeakMap();
// Keep transport DTOs outside Session snapshots. A queued mutation retains
// its frozen descriptor even when the live connection metadata later changes.
const SOURCE_DTO_CACHE = new WeakMap();
const CONNECTION_DTO_CACHE = new WeakMap();
const SOURCE_FIELDS = ['remoteIp', 'sysName', 'sysDesc'];
const SOURCE_METADATA_FIELDS = [
    'bmpVersion',
    'bmpV4TlvDraft',
    'transport',
    'authentication',
    'authProfileId',
    'authProfileName',
    'authPeer',
    'tcpAoProfileId',
    'tcpAoProfileName',
    'tcpAoPeer',
    'tcpMd5ProfileId',
    'tcpMd5ProfileName',
    'tcpMd5Peer'
];
const SOURCE_METADATA_DEFAULTS = { transport: 'tcp', authentication: 'none' };
// Per-immutable-attribute-object cache of the canonical JSON + hash. Parser
// routes in one UPDATE/family share that object; mutable public attributes
// continue through their normal fresh snapshot instead of a stale cache key.
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
    'pathAttributes',
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

function compactRoutePayload(routeInfo, nlriFlags) {
    const payload = { ...routeInfo };
    const nlri = payload.nlriDetail;
    [...DUPLICATED_ROUTE_ATTRIBUTE_FIELDS, ...ROUTE_IDENTITY_PAYLOAD_FIELDS].forEach(field => delete payload[field]);
    if (nlri && (nlriFlags === undefined ? !canCompactPayloadNlri(routeInfo, nlri) : nlriFlags === null)) {
        payload.nlriDetail = nlri;
    }
    Object.entries(payload).forEach(([field, value]) => {
        if (isEmptyPayloadValue(field, value)) {
            delete payload[field];
        }
    });
    return payload;
}

function canCompactPayloadNlri(route, nlri = route.nlriDetail) {
    return (
        compactNlri(nlri, {
            prefix: normalizePersistedPrefix(route.ip || route.prefix, route.mask ?? route.length),
            prefixLength: route.mask ?? route.length,
            pathId: route.pathId || 0,
            rd: route.rd || null
        }) !== null
    );
}

// Same result as compactRoutePayload(route.getRouteInfo()) for a BmpBgpRoute,
// without materializing the full route info object first.
function buildRoutePayload(route, nlriFlags) {
    if (typeof route?.getPathStatusInfo !== 'function' || typeof route.getRouteTlvInfo !== 'function') {
        const routeInfo = typeof route?.getRouteInfo === 'function' ? route.getRouteInfo() : { ...route };
        return compactRoutePayload(routeInfo, nlriFlags);
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
    // Labels, warnings, wire bytes and other non-identity NLRI annotations
    // belong to this path, not the identity shared by every peer/stage.
    if (route.nlriDetail && (nlriFlags === undefined ? !canCompactPayloadNlri(route) : nlriFlags === null)) {
        payload.nlriDetail = route.nlriDetail;
    }
    return payload;
}

function resolveRouteAttrIdentity(route, owner) {
    const attr = route?.getImmutableRouteAttr?.() || route?.getRouteAttr?.() || owner?.getRouteAttr?.(route) || null;
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

// Allocate these in the coordinator before dispatching a connection to its
// parser. Worker-local counters cannot order reconnects across parser slots.
function allocatePersistenceConnection() {
    return {
        persistenceConnectionId: makeConnectionId(),
        persistenceOpenedAtMs: Date.now(),
        persistenceConnectionGeneration: nextConnectionGeneration()
    };
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
    const draft = bmpSession.getBmpV4TlvDraft?.() || null;
    const cached = SOURCE_DTO_CACHE.get(bmpSession);
    let reusable = cached?.source.id === key.keyHex;
    if (reusable) {
        for (const field of SOURCE_FIELDS) {
            if (!sameDescriptorValue(bmpSession[field] || null, cached.source[field], cached.tokens[field])) {
                reusable = false;
                break;
            }
        }
    }
    if (reusable) {
        for (const field of SOURCE_METADATA_FIELDS) {
            const value =
                field === 'bmpV4TlvDraft' ? draft : bmpSession[field] || SOURCE_METADATA_DEFAULTS[field] || null;
            if (!sameDescriptorValue(value, cached.source.metadata[field], cached.tokens[field])) {
                reusable = false;
                break;
            }
        }
    }
    if (reusable) return cached.source;

    const tokens = {};
    const source = {
        id: key.keyHex,
        keyJson:
            cached?.source.id === key.keyHex
                ? cached.source.keyJson
                : stringify({
                      schemaVersion: key.schemaVersion,
                      algorithm: key.algorithm,
                      keyHex: key.keyHex
                  }),
        identityJson:
            cached?.source.id === key.keyHex ? cached.source.identityJson : canonicalStringify(key.canonicalIdentity)
    };
    for (const field of SOURCE_FIELDS) {
        source[field] = snapshotDescriptorValue(bmpSession[field] || null, tokens, field);
    }
    const metadata = {};
    for (const field of SOURCE_METADATA_FIELDS) {
        const value = field === 'bmpV4TlvDraft' ? draft : bmpSession[field] || SOURCE_METADATA_DEFAULTS[field] || null;
        metadata[field] = snapshotDescriptorValue(value, tokens, field);
    }
    source.metadata = Object.freeze(metadata);
    Object.freeze(source);
    SOURCE_DTO_CACHE.set(bmpSession, { source, tokens });
    return source;
}

function sameDescriptorValue(value, snapshot, token) {
    // Runtime authentication metadata is scalar. Retain correct snapshots for
    // public callers that supply and subsequently mutate structured metadata.
    return value && typeof value === 'object' ? stringify(value) === token : value === snapshot;
}

function snapshotDescriptorValue(value, tokens, field) {
    if (!value || typeof value !== 'object') return value;
    const token = stringify(value);
    tokens[field] = token;
    const snapshot = JSON.parse(token);
    const freeze = item => {
        if (item && typeof item === 'object') {
            for (const value of Object.values(item)) freeze(value);
            Object.freeze(item);
        }
        return item;
    };
    return freeze(snapshot);
}

function buildConnection(bmpSession) {
    ensurePersistenceContext(bmpSession);
    const cached = CONNECTION_DTO_CACHE.get(bmpSession);
    if (
        cached &&
        cached.id === bmpSession.persistenceConnectionId &&
        cached.sourceId === bmpSession.persistenceSourceKey.keyHex &&
        cached.localIp === (bmpSession.localIp || null) &&
        cached.localPort === (bmpSession.localPort || null) &&
        cached.remoteIp === (bmpSession.remoteIp || null) &&
        cached.remotePort === (bmpSession.remotePort || null) &&
        cached.openedAtMs === bmpSession.persistenceOpenedAtMs &&
        cached.generation === bmpSession.persistenceConnectionGeneration
    )
        return cached;
    const connection = Object.freeze({
        id: bmpSession.persistenceConnectionId,
        sourceId: bmpSession.persistenceSourceKey.keyHex,
        localIp: bmpSession.localIp || null,
        localPort: bmpSession.localPort || null,
        remoteIp: bmpSession.remoteIp || null,
        remotePort: bmpSession.remotePort || null,
        openedAtMs: bmpSession.persistenceOpenedAtMs,
        generation: bmpSession.persistenceConnectionGeneration
    });
    CONNECTION_DTO_CACHE.set(bmpSession, connection);
    return connection;
}

function buildScope(
    bmpSession,
    owner,
    afi,
    safi,
    ribType,
    options = {},
    source = buildSource(bmpSession),
    stateOverride
) {
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
    let cached = descriptors.get(descriptorKey);
    let descriptor = cached?.descriptor;
    // Peer identity fields live on the owner and can in principle be
    // re-assigned; validate the cached descriptor against them cheaply.
    if (
        descriptor &&
        (descriptor.sourceId !== source.id ||
            descriptor.kind !== options.kind ||
            descriptor.peerType !== peerType ||
            descriptor.peerRd !== peerRd ||
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
        descriptor = Object.freeze({
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
        });
        cached = { descriptor, scope: null };
        descriptors.set(descriptorKey, cached);
    }
    const vrfName = Array.isArray(owner.vrfTableNames) ? owner.vrfTableNames[0] || null : null;
    const epoch = isInstance ? owner.getRibEpoch() : owner.getRibEpoch(afi, safi, ribType);
    const state = stateOverride === undefined ? options.state || 'syncing' : stateOverride;
    const reason = options.reason || null;
    if (
        cached.scope &&
        cached.scope.vrfName === vrfName &&
        cached.scope.epoch === epoch &&
        cached.scope.state === state &&
        cached.scope.reason === reason
    ) {
        return cached.scope;
    }
    const scope = Object.freeze({
        id: descriptor.id,
        sourceId: descriptor.sourceId,
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
        vrfName,
        epoch,
        state,
        reason
    });
    cached.scope = scope;
    return scope;
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
    // Parsers may expose optional diagnostics as enumerable undefined values.
    // JSON omits them, so they do not require a per-prefix payload object.
    if (!keys.every(key => nlriDetail[key] === undefined || COMPACT_NLRI_KEYS.has(key))) {
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
    if (nlriDetail.valid !== undefined) {
        if (nlriDetail.valid !== true) {
            return null;
        }
        flags |= NLRI_FLAG_VALID;
    }
    if (nlriDetail.rd !== undefined) {
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
        // Reuse the normalized NLRI already computed for persistence. The
        // public lookup key must identify the same complete NLRI, without a
        // second normalization/hash or a lossy display-prefix fallback.
        legacyRouteKey: formatRouteLookupKey(key.canonicalIdentity, route, key.canonicalJson),
        afi: Number(afi),
        safi: Number(safi),
        pathId: Number(route.pathId || 0),
        rd: route.rd || null,
        prefix: persistedPrefix,
        prefixLength,
        nlriKind: key.canonicalIdentity.nlri.kind,
        nlriJson: null,
        nlriFlags: nlriFlags ?? 0,
        attrId,
        attrJson,
        routeJson: stringify(buildRoutePayload(route, nlriFlags))
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
        rdRaw: withdrawn.rdRaw || null,
        ip: withdrawn.prefix,
        mask: withdrawn.length,
        nlriDetail: withdrawn
    };
    const key = createRouteKey({ afi, safi, route, nlri: withdrawn });
    const legacyRouteKey = formatRouteLookupKey(key.canonicalIdentity, route, key.canonicalJson);
    const withdrawnPrefix =
        key.canonicalIdentity.nlri.prefix?.networkText || normalizePersistedPrefix(route.ip, route.mask);
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
        nlriJson: null,
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

function buildScopeMutation(bmpSession, owner, afi, safi, ribType, eventType, options = {}, stateOverride) {
    const mutation = buildBaseMutation(bmpSession, eventType, options);
    mutation.scope = buildScope(bmpSession, owner, afi, safi, ribType, options, mutation.source, stateOverride);
    return mutation;
}

function buildRouteUpsertMutation(bmpSession, owner, route, afi, safi, ribType, options = {}) {
    const routeData = buildRoute(owner, route, afi, safi);
    let eventType = options.isNewRoute === undefined ? 'upsert' : 'announce';
    if (options.isNewRoute === false) {
        eventType = options.previousAttrHash === routeData.attrId ? 'refresh' : 'replace';
    }
    const mutation = buildScopeMutation(
        bmpSession,
        owner,
        afi,
        safi,
        ribType,
        eventType,
        options,
        options.scopeState || 'syncing'
    );
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
    allocatePersistenceConnection,
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
