const crypto = require('crypto');
const ipaddr = require('ipaddr.js');

const KEY_SCHEMA_VERSION = 1;
const KEY_ALGORITHM = 'sha256';

const AFI_IPV4 = 1;
const AFI_IPV6 = 2;
const AFI_L2VPN = 25;
const AFI_BGP_LS = 16388;

const SAFI_UNICAST = 1;
const SAFI_MULTICAST = 2;
const SAFI_LABEL_UNICAST = 4;
const SAFI_BGP_LS = 71;
const SAFI_BGP_LS_VPN = 72;
const SAFI_EVPN = 70;
const SAFI_VPN = 128;
const SAFI_FLOW_SPEC = 133;
const SAFI_QP = 241;

// These fields describe an observed path, parser diagnostics, or presentation. They
// must not turn an update of one NLRI into a different persistent route identity.
const NON_NLRI_FIELDS = new Set([
    'afi',
    'safi',
    'pathId',
    'displayPrefix',
    'routeKey',
    'routeTypeName',
    'nlriTypeName',
    'typeName',
    'formatted',
    'display',
    'valid',
    'errors',
    'warnings',
    'parseWarning',
    'parseStatus',
    'origin',
    'asPath',
    'med',
    'localPref',
    'communities',
    'extCommunities',
    'largeCommunities',
    'otc',
    'nextHop',
    'prefixSid',
    'attrId',
    'attrHash',
    'routeState',
    'ribEpoch',
    'staleEpoch',
    'lastSeenAt',
    'staleAt',
    'staleReason',
    'routeTlvs',
    // These fields are copied onto EVPN NLRI objects from BGP path
    // attributes by annotateEvpnPathAttributes(). A withdrawal commonly
    // carries only MP_UNREACH_NLRI, so including them would give the same
    // wire NLRI a different persistent route key on announce and withdraw.
    'encapsulation',
    'encapsulationType',
    'pmsiTunnel',
    'pathStatus',
    'pathStatusNames',
    'pathStatusText',
    'pathStatusReason',
    'pathStatusReasons',
    'labels',
    'label',
    'labelStack',
    'mplsLabel',
    'vni',
    'raw24',
    'rawHex',
    'exp',
    'bottom'
]);

const NORMALIZED_IP_FIELDS = new Set([
    'ipAddress',
    'ipPrefix',
    'gatewayIp',
    'originatingRouterIp',
    'originatorRouterIp',
    'sourceAddress',
    'groupAddress',
    'sourceIp',
    'groupIp',
    'localAddress',
    'remoteAddress'
]);

function firstDefined(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function normalizeInteger(value, name, minimum, maximum, fallback) {
    const resolved = firstDefined(value, fallback);
    const number = Number(resolved);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return number;
}

function normalizeAfi(value) {
    return normalizeInteger(value, 'AFI', 0, 0xffff);
}

function normalizeSafi(value) {
    return normalizeInteger(value, 'SAFI', 0, 0xff);
}

function normalizePathId(value) {
    return normalizeInteger(value, 'pathId', 0, 0xffffffff, 0);
}

function normalizeText(value, name) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (!text) {
        throw new Error(`${name} is required`);
    }
    return text;
}

function normalizeIpAddress(value, expectedAfi = null) {
    const text = normalizeText(value, 'IP address');
    let address;
    try {
        address = ipaddr.parse(text);
    } catch (error) {
        throw new Error(`Invalid IP address: ${text}`);
    }

    const family = address.kind();
    if (expectedAfi === AFI_IPV4 && family !== 'ipv4') {
        throw new Error(`Expected an IPv4 address, got ${text}`);
    }
    if (expectedAfi === AFI_IPV6 && family !== 'ipv6') {
        throw new Error(`Expected an IPv6 address, got ${text}`);
    }

    return {
        family,
        address: address.toString(),
        addressHex: Buffer.from(address.toByteArray()).toString('hex')
    };
}

function normalizeIpPrefix(prefixValue, lengthValue, afi) {
    let prefix = normalizeText(prefixValue, 'NLRI prefix');
    let cidrLength = null;
    const slash = prefix.lastIndexOf('/');
    if (slash !== -1) {
        cidrLength = prefix.slice(slash + 1);
        prefix = prefix.slice(0, slash);
    }

    const parsed = normalizeIpAddress(prefix, afi);
    const maximum = parsed.family === 'ipv4' ? 32 : 128;
    const prefixLength = normalizeInteger(firstDefined(lengthValue, cidrLength), 'prefix length', 0, maximum);
    if (
        cidrLength !== null &&
        lengthValue !== undefined &&
        lengthValue !== null &&
        Number(cidrLength) !== prefixLength
    ) {
        throw new Error(`Conflicting prefix lengths: ${cidrLength} and ${lengthValue}`);
    }

    const network = Buffer.from(parsed.addressHex, 'hex');
    const wholeBytes = Math.floor(prefixLength / 8);
    const remainingBits = prefixLength % 8;
    if (remainingBits !== 0) {
        network[wholeBytes] &= (0xff << (8 - remainingBits)) & 0xff;
    }
    for (let index = wholeBytes + (remainingBits === 0 ? 0 : 1); index < network.length; index += 1) {
        network[index] = 0;
    }

    return {
        family: parsed.family,
        prefixLength,
        networkHex: network.toString('hex')
    };
}

function normalizeRouteDistinguisher(value) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        const bytes = Buffer.from(value);
        if (bytes.length !== 8) {
            throw new Error('Route distinguisher bytes must be exactly 8 octets');
        }
        return `raw:${bytes.toString('hex')}`;
    }

    const text = String(firstDefined(value, '0:0')).trim();
    if (/^raw:[0-9a-f]{16}$/i.test(text)) {
        return text.toLowerCase();
    }
    const match = /^(.+):(\d+)$/.exec(text);
    if (!match) {
        return text.toLowerCase();
    }

    let administrator = match[1];
    if (administrator.includes('.') && ipaddr.IPv4.isValid(administrator)) {
        administrator = ipaddr.parse(administrator).toString();
    } else if (/^\d+$/.test(administrator)) {
        administrator = BigInt(administrator).toString();
    }
    return `${administrator}:${BigInt(match[2]).toString()}`;
}

function normalizeRawNlri(value) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return Buffer.from(value).toString('hex');
    }
    const text = normalizeText(value, 'raw NLRI')
        .replace(/^0x/i, '')
        .replace(/[\s:-]/g, '');
    if (!/^[0-9a-f]+$/i.test(text) || text.length % 2 !== 0) {
        throw new Error('raw NLRI must be an even-length hexadecimal value');
    }
    return text.toLowerCase();
}

function normalizeCanonicalValue(value, stack = new Set()) {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
        return undefined;
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('Canonical identities cannot contain non-finite numbers');
        }
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === 'bigint') {
        return { $bigint: value.toString() };
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return { $bytes: Buffer.from(value).toString('hex') };
    }
    if (value instanceof Date) {
        return { $date: value.toISOString() };
    }
    if (stack.has(value)) {
        throw new Error('Canonical identities cannot contain circular references');
    }

    stack.add(value);
    let normalized;
    if (Array.isArray(value)) {
        normalized = value.map(item => {
            const result = normalizeCanonicalValue(item, stack);
            return result === undefined ? null : result;
        });
    } else {
        normalized = {};
        Object.keys(value)
            .sort()
            .forEach(key => {
                const result = normalizeCanonicalValue(value[key], stack);
                if (result !== undefined) {
                    normalized[key] = result;
                }
            });
    }
    stack.delete(value);
    return normalized;
}

function canonicalStringify(value) {
    return JSON.stringify(normalizeCanonicalValue(value));
}

function buildKey(domain, canonicalIdentity) {
    const canonicalJson = canonicalStringify({
        domain,
        schemaVersion: KEY_SCHEMA_VERSION,
        identity: canonicalIdentity
    });
    const canonicalBytes = Buffer.from(canonicalJson, 'utf8');
    const keyBuffer = crypto.createHash(KEY_ALGORITHM).update(canonicalBytes).digest();
    return {
        schemaVersion: KEY_SCHEMA_VERSION,
        algorithm: KEY_ALGORITHM,
        keyBuffer,
        keyBlob: keyBuffer,
        keyHex: keyBuffer.toString('hex'),
        canonicalIdentity,
        canonicalBytes,
        canonicalJson
    };
}

function canonicalizeSourceIdentity(source = {}) {
    const namespace = firstDefined(source.namespace, source.tenantId, source.tenant);
    const collector = firstDefined(source.collectorId, source.collector);
    const stableId = firstDefined(source.stableId, source.sourceId, source.deviceId);
    const routerId = firstDefined(source.routerId, source.sourceRouterId, source.bmpRouterId);
    const sysName = firstDefined(source.sysName, source.systemName);
    const address = firstDefined(source.sourceAddress, source.routerAddress, source.remoteIp, source.address);

    let discriminator;
    if (stableId !== undefined) {
        discriminator = { kind: 'stable-id', value: normalizeText(stableId, 'source stable ID') };
    } else if (routerId !== undefined) {
        discriminator = { kind: 'router-id', value: normalizeIpAddress(routerId).addressHex };
    } else if (sysName !== undefined) {
        const normalizedSysName = normalizeText(sysName, 'BMP sysName').replace(/\.$/, '').toLowerCase();
        discriminator = {
            kind: address === undefined ? 'sys-name' : 'sys-name-address',
            value: normalizedSysName,
            ...(address === undefined ? {} : { addressHex: normalizeIpAddress(address).addressHex })
        };
    } else if (address !== undefined) {
        discriminator = { kind: 'source-address', value: normalizeIpAddress(address).addressHex };
    } else {
        throw new Error('A stableId, routerId, sysName, or sourceAddress is required for a BMP source key');
    }

    return {
        namespace: namespace === undefined ? null : normalizeText(namespace, 'source namespace'),
        collector: collector === undefined ? null : normalizeText(collector, 'collector ID'),
        discriminator
    };
}

function createSourceKey(source) {
    return buildKey('bmp-source', canonicalizeSourceIdentity(source));
}

function normalizeKeyHex(value, name) {
    const candidate = value && value.keyBuffer ? value.keyBuffer : value && value.keyHex ? value.keyHex : value;
    if (Buffer.isBuffer(candidate) || candidate instanceof Uint8Array) {
        const buffer = Buffer.from(candidate);
        if (buffer.length !== 32) {
            throw new Error(`${name} must be a 32-byte SHA-256 value`);
        }
        return buffer.toString('hex');
    }
    const text = String(candidate || '')
        .replace(/^v\d+:/, '')
        .toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(text)) {
        throw new Error(`${name} must be a 64-character SHA-256 hex value`);
    }
    return text;
}

function normalizePeerAs(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) {
        throw new Error('peer AS must be an unsigned integer');
    }
    const asn = BigInt(text);
    if (asn > 0xffffffffn) {
        throw new Error('peer AS must be at most 4294967295');
    }
    return asn.toString();
}

function normalizeScopeStage(value, scopeKind) {
    if (value === undefined || value === null || value === '') {
        if (scopeKind === 'loc-rib') {
            return 'loc-rib';
        }
        throw new Error('RIB stage/ribType is required for a BMP scope key');
    }
    if (typeof value === 'number' || /^\d+$/.test(String(value))) {
        return normalizeInteger(value, 'RIB type', 0, 0xffff);
    }
    return normalizeText(value, 'RIB stage')
        .toLowerCase()
        .replace(/[\s_]+/g, '-');
}

function canonicalizeScopeIdentity(scope = {}) {
    let sourceKeyHex;
    if (scope.sourceKey !== undefined && scope.sourceKey !== null) {
        sourceKeyHex = normalizeKeyHex(scope.sourceKey, 'source key');
    } else {
        const source = scope.source || {
            namespace: scope.namespace,
            tenantId: scope.tenantId,
            collectorId: scope.collectorId,
            stableId: scope.sourceStableId || scope.sourceId,
            routerId: scope.sourceRouterId,
            sysName: scope.sysName,
            sourceAddress: scope.sourceAddress || scope.remoteIp
        };
        sourceKeyHex = createSourceKey(source).keyHex;
    }

    const peer = scope.peer || {};
    const peerType = firstDefined(peer.type, scope.peerType, scope.sessionType, scope.instanceType);
    const peerRd = firstDefined(
        peer.rdRaw,
        scope.peerRdRaw,
        scope.sessionRdRaw,
        scope.instanceRdRaw,
        peer.rd,
        scope.peerRd,
        scope.sessionRd,
        scope.instanceRd,
        '0:0'
    );
    const peerAddress = firstDefined(peer.address, scope.peerAddress, scope.sessionIp, scope.instanceIp);
    const peerAs = firstDefined(peer.asn, peer.as, scope.peerAs, scope.sessionAs, scope.instanceAs);
    const rawKind = firstDefined(scope.scopeKind, scope.kind);
    const scopeKind = rawKind
        ? normalizeText(rawKind, 'scope kind')
              .toLowerCase()
              .replace(/[\s_]+/g, '-')
        : Number(peerType) === 3
          ? 'loc-rib'
          : 'peer';

    return {
        sourceKeyHex,
        scopeKind,
        peer: {
            type:
                peerType === undefined
                    ? null
                    : /^\d+$/.test(String(peerType))
                      ? Number(peerType)
                      : normalizeText(peerType, 'peer type').toLowerCase(),
            rd: normalizeRouteDistinguisher(peerRd),
            address: peerAddress === undefined ? null : normalizeIpAddress(peerAddress).addressHex,
            asn: normalizePeerAs(peerAs)
        },
        afi: normalizeAfi(firstDefined(scope.afi, peer.afi)),
        safi: normalizeSafi(firstDefined(scope.safi, peer.safi)),
        stage: normalizeScopeStage(firstDefined(scope.stage, scope.ribStage, scope.ribType), scopeKind)
    };
}

function createScopeKey(scope) {
    return buildKey('bmp-rib-scope', canonicalizeScopeIdentity(scope));
}

function sanitizeComplexNlri(value, fieldName = null) {
    if (fieldName && NON_NLRI_FIELDS.has(fieldName)) {
        return undefined;
    }
    if (value === undefined || typeof value === 'function') {
        return undefined;
    }
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'string' && fieldName && NORMALIZED_IP_FIELDS.has(fieldName)) {
            try {
                return normalizeIpAddress(value).addressHex;
            } catch (error) {
                return value.trim().toLowerCase();
            }
        }
        if (typeof value === 'string' && fieldName === 'rd') {
            return normalizeRouteDistinguisher(value);
        }
        if (typeof value === 'string' && fieldName === 'macAddress') {
            return value.replace(/[-.]/g, ':').toLowerCase();
        }
        return value;
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return Buffer.from(value);
    }
    if (Array.isArray(value)) {
        return value.map(item => sanitizeComplexNlri(item)).filter(item => item !== undefined);
    }

    const result = {};
    Object.keys(value)
        .sort()
        .forEach(key => {
            const child = sanitizeComplexNlri(value[key], key);
            if (child !== undefined) {
                result[key] = child;
            }
        });
    return result;
}

function resolveRouteInput(input = {}) {
    const route = input.route || input;
    const nlri = input.nlri || input.nlriDetail || route.nlriDetail || route;
    return {
        route,
        nlri,
        afi: normalizeAfi(firstDefined(input.afi, route.afi, nlri.afi)),
        safi: normalizeSafi(firstDefined(input.safi, route.safi, nlri.safi)),
        pathId: normalizePathId(firstDefined(input.pathId, route.pathId, nlri.pathId, 0))
    };
}

function canonicalizeNlriIdentity(input = {}) {
    const { route, nlri, afi, safi } = resolveRouteInput(input);
    const prefixValue = firstDefined(nlri.ipPrefix, nlri.prefix, route.ip, route.prefix);
    const prefixLength = firstDefined(nlri.prefixLength, nlri.length, route.mask, route.length);

    if (
        (afi === AFI_IPV4 || afi === AFI_IPV6) &&
        (safi === SAFI_UNICAST || safi === SAFI_MULTICAST || safi === SAFI_LABEL_UNICAST || safi === SAFI_VPN)
    ) {
        const identity = {
            kind: safi === SAFI_VPN ? 'vpn-prefix' : 'ip-prefix',
            prefix: normalizeIpPrefix(prefixValue, prefixLength, afi)
        };
        if (safi === SAFI_VPN) {
            identity.rd = normalizeRouteDistinguisher(firstDefined(nlri.rdRaw, route.rdRaw, nlri.rd, route.rd, '0:0'));
        }
        return identity;
    }

    if ((afi === AFI_IPV4 || afi === AFI_IPV6) && safi === SAFI_QP) {
        return {
            kind: 'qp-prefix',
            prefix: normalizeIpPrefix(prefixValue, prefixLength, afi),
            dqpn: normalizeInteger(firstDefined(nlri.dqpn, route.dqpn), 'DQPN', 0, Number.MAX_SAFE_INTEGER),
            dqpnBits: normalizeInteger(firstDefined(nlri.dqpnBits, route.dqpnBits, 0), 'DQPN bits', 0, 64)
        };
    }

    const routeType = firstDefined(nlri.routeType, nlri.nlriType, route.routeType, route.nlriType);
    const rawNlri = firstDefined(nlri.rawNlri, route.rawNlri);

    if (afi === AFI_L2VPN && safi === SAFI_EVPN) {
        const semantic = sanitizeComplexNlri(nlri);
        delete semantic.rawNlri;
        // Parsed EVPN fields are authoritative. Labels are deliberately absent because
        // a label/VNI change is a path change for the same business route identity.
        if (Object.keys(semantic).length > 0) {
            return { kind: 'evpn', semantic };
        }
    }

    if (
        rawNlri !== undefined &&
        (safi === SAFI_FLOW_SPEC || safi === SAFI_BGP_LS || safi === SAFI_BGP_LS_VPN || afi === AFI_BGP_LS)
    ) {
        return {
            kind: 'raw-nlri',
            routeType: routeType === undefined ? null : routeType,
            rd:
                safi === SAFI_BGP_LS_VPN
                    ? normalizeRouteDistinguisher(firstDefined(nlri.rdRaw, route.rdRaw, nlri.rd, route.rd, '0:0'))
                    : null,
            rawNlriHex: normalizeRawNlri(rawNlri)
        };
    }

    if (rawNlri !== undefined) {
        return {
            kind: 'raw-nlri',
            routeType: routeType === undefined ? null : routeType,
            rd:
                firstDefined(nlri.rdRaw, route.rdRaw, nlri.rd, route.rd) === undefined
                    ? null
                    : normalizeRouteDistinguisher(firstDefined(nlri.rdRaw, route.rdRaw, nlri.rd, route.rd)),
            rawNlriHex: normalizeRawNlri(rawNlri)
        };
    }

    const semantic = sanitizeComplexNlri(nlri);
    if (!semantic || Object.keys(semantic).length === 0) {
        throw new Error(`No canonical NLRI identity is available for AFI ${afi}, SAFI ${safi}`);
    }
    return { kind: 'structured-nlri', semantic };
}

function canonicalizeRouteIdentity(input = {}) {
    const resolved = resolveRouteInput(input);
    return {
        afi: resolved.afi,
        safi: resolved.safi,
        pathId: resolved.pathId,
        nlri: canonicalizeNlriIdentity(input)
    };
}

function createRouteKey(input) {
    return buildKey('bmp-route', canonicalizeRouteIdentity(input));
}

function createScopedRouteIdentity(input = {}) {
    const scopeKey = createScopeKey(input.scope || input);
    const routeKey = createRouteKey(input.route || input);
    return {
        schemaVersion: KEY_SCHEMA_VERSION,
        scopeKey,
        routeKey,
        primaryKey: {
            scopeKeyHex: scopeKey.keyHex,
            routeKeyHex: routeKey.keyHex
        }
    };
}

function verifyCanonicalKey(key, canonicalBytes) {
    const expected = Buffer.from(normalizeKeyHex(key, 'key'), 'hex');
    const actual = crypto.createHash(KEY_ALGORITHM).update(Buffer.from(canonicalBytes)).digest();
    return crypto.timingSafeEqual(expected, actual);
}

module.exports = {
    KEY_SCHEMA_VERSION,
    KEY_ALGORITHM,
    canonicalStringify,
    normalizeIpPrefix,
    normalizeRouteDistinguisher,
    canonicalizeSourceIdentity,
    canonicalizeScopeIdentity,
    canonicalizeNlriIdentity,
    canonicalizeRouteIdentity,
    createSourceKey,
    createScopeKey,
    createRouteKey,
    createScopedRouteIdentity,
    verifyCanonicalKey
};
