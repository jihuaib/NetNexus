const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');

const routeKey = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'bmpPersistentRouteKey.js'));

const {
    KEY_SCHEMA_VERSION,
    canonicalStringify,
    canonicalizeRouteIdentity,
    formatRouteLookupKey,
    createSourceKey,
    createScopeKey,
    createRouteKey,
    createScopedRouteIdentity,
    verifyCanonicalKey
} = routeKey;

function assertSameKey(left, right, message) {
    assert.strictEqual(left.keyHex, right.keyHex, message);
    assert.deepStrictEqual(left.canonicalBytes, right.canonicalBytes, `${message}: canonical bytes differ`);
}

function assertDifferentKey(left, right, message) {
    assert.notStrictEqual(left.keyHex, right.keyHex, message);
}

// Source identity is stable across TCP reconnects and later metadata. An explicit
// stable ID has precedence, while sysName and addresses provide deterministic fallbacks.
{
    const first = createSourceKey({
        tenantId: 'tenant-a',
        collectorId: 'collector-1',
        stableId: 'router-shanghai-01',
        sysName: 'old-name',
        remoteIp: '192.0.2.10',
        remotePort: 41000
    });
    const reconnected = createSourceKey({
        tenantId: 'tenant-a',
        collectorId: 'collector-1',
        stableId: 'router-shanghai-01',
        sysName: 'new-name',
        remoteIp: '198.51.100.10',
        remotePort: 51000
    });
    assertSameKey(first, reconnected, 'TCP connection metadata must not change a stable BMP source key');
    assert.strictEqual(first.schemaVersion, KEY_SCHEMA_VERSION);
    assert.strictEqual(first.keyBuffer.length, 32);
    assert.match(first.keyHex, /^[0-9a-f]{64}$/);
    assert.strictEqual(verifyCanonicalKey(first.keyBuffer, first.canonicalBytes), true);

    const sysNameA = createSourceKey({ sysName: 'BMP-ROUTER-1.example.' });
    const sysNameB = createSourceKey({ sysName: 'bmp-router-1.EXAMPLE', remotePort: 65000 });
    assertSameKey(sysNameA, sysNameB, 'sysName source identity must be case and trailing-dot stable');

    const sameNameDifferentAddressA = createSourceKey({ sysName: 'router', sourceAddress: '192.0.2.1' });
    const sameNameDifferentAddressB = createSourceKey({ sysName: 'router', sourceAddress: '192.0.2.2' });
    assertDifferentKey(
        sameNameDifferentAddressA,
        sameNameDifferentAddressB,
        'non-unique sysName values must not merge distinct BMP source addresses'
    );

    const ipv6A = createSourceKey({ sourceAddress: '2001:0db8:0:0:0:0:0:1' });
    const ipv6B = createSourceKey({ sourceAddress: '2001:db8::1' });
    assertSameKey(ipv6A, ipv6B, 'source address identity must normalize IPv6 text');
}

const source = { stableId: 'router-01', tenantId: 'tenant-a' };
const baseScope = {
    source,
    scopeKind: 'peer',
    peer: { type: 0, rd: '0:0', address: '192.0.2.1', asn: 65001 },
    afi: 1,
    safi: 1,
    ribType: 1,
    remotePort: 50000,
    connectionGeneration: 9,
    ribEpoch: 33
};

// A RIB scope excludes connection generation/ports but includes peer and stage.
{
    const first = createScopeKey(baseScope);
    const reconnect = createScopeKey({
        ...baseScope,
        remotePort: 60000,
        connectionGeneration: 10,
        ribEpoch: 34
    });
    const anotherPeer = createScopeKey({
        ...baseScope,
        peer: { ...baseScope.peer, address: '192.0.2.2' }
    });
    const anotherStage = createScopeKey({ ...baseScope, ribType: 2 });

    assertSameKey(first, reconnect, 'ephemeral connection state must not change a RIB scope key');
    assertDifferentKey(first, anotherPeer, 'peer identity must isolate RIB scopes');
    assertDifferentKey(first, anotherStage, 'RIB stage must isolate RIB scopes');

    const rdTypeZero = createScopeKey({
        ...baseScope,
        peer: { ...baseScope.peer, rd: '65000:7', rdRaw: 'raw:0000fde800000007' }
    });
    const rdTypeTwo = createScopeKey({
        ...baseScope,
        peer: { ...baseScope.peer, rd: '65000:7', rdRaw: 'raw:00020000fde80007' }
    });
    assertDifferentKey(rdTypeZero, rdTypeTwo, 'different binary RD encodings must not collide');
}

// IPv4 host bits and path attributes do not affect an NLRI key.
{
    const announced = createRouteKey({
        afi: 1,
        safi: 1,
        pathId: 0,
        route: {
            ip: '192.0.2.129',
            mask: 24,
            nextHop: '192.0.2.1',
            asPath: '65000 65001',
            med: 10,
            communities: ['65000:1']
        }
    });
    const changedAttributes = createRouteKey({
        afi: 1,
        safi: 1,
        route: {
            ip: '192.0.2.0/24',
            nextHop: '198.51.100.1',
            asPath: '65100',
            med: 999,
            communities: ['65100:9'],
            routeState: 'stale'
        }
    });

    assertSameKey(announced, changedAttributes, 'path attribute changes must retain the route key');
    assert.strictEqual(announced.canonicalIdentity.nlri.prefix.networkHex, 'c0000200');

    const corruptedCanonical = Buffer.from(announced.canonicalBytes);
    corruptedCanonical[corruptedCanonical.length - 1] ^= 1;
    assert.strictEqual(verifyCanonicalKey(announced.keyHex, corruptedCanonical), false);
}

// IPv6 spelling is normalized to network bytes.
{
    const expanded = createRouteKey({
        afi: 2,
        safi: 1,
        nlri: { prefix: '2001:0db8:0001:0002:ffff:ffff:ffff:ffff', length: 64 }
    });
    const compressed = createRouteKey({ afi: 2, safi: 1, nlri: { prefix: '2001:db8:1:2::/64' } });
    assertSameKey(expanded, compressed, 'IPv6 NLRI identity must normalize spelling and host bits');
}

// Multicast NLRI uses the same IP-prefix normalization rules while SAFI remains
// part of the route identity.
{
    const ipv4HostBits = createRouteKey({
        afi: 1,
        safi: 2,
        route: { ip: '239.1.2.129', mask: 24, nextHop: '192.0.2.1' }
    });
    const ipv4Network = createRouteKey({
        afi: 1,
        safi: 2,
        nlri: { prefix: '239.1.2.0/24' }
    });
    assertSameKey(ipv4HostBits, ipv4Network, 'IPv4 multicast keys must normalize host bits');
    assert.strictEqual(ipv4HostBits.canonicalIdentity.nlri.kind, 'ip-prefix');
    assert.strictEqual(ipv4HostBits.canonicalIdentity.nlri.prefix.networkHex, 'ef010200');

    const ipv6Expanded = createRouteKey({
        afi: 2,
        safi: 2,
        nlri: { prefix: 'ff3e:0040:2001:0db8:ffff:ffff:ffff:ffff', length: 64 }
    });
    const ipv6Compressed = createRouteKey({
        afi: 2,
        safi: 2,
        nlri: { prefix: 'ff3e:40:2001:db8::/64' }
    });
    assertSameKey(ipv6Expanded, ipv6Compressed, 'IPv6 multicast keys must normalize spelling and host bits');
    assert.strictEqual(ipv6Expanded.canonicalIdentity.nlri.kind, 'ip-prefix');

    const ipv4Unicast = createRouteKey({ afi: 1, safi: 1, nlri: { prefix: '239.1.2.0/24' } });
    assertDifferentKey(ipv4Network, ipv4Unicast, 'unicast and multicast SAFIs must not share a route key');
}

// VPN labels are forwarding data, not the stable business prefix identity.
{
    const firstLabel = createRouteKey({
        afi: 1,
        safi: 128,
        nlri: {
            prefix: '10.20.30.99',
            length: 24,
            rd: '065000:0007',
            labels: [{ label: 100, bottom: true }],
            rawNlri: '0006410000fde8000000070a141e'
        }
    });
    const changedLabel = createRouteKey({
        afi: 1,
        safi: 128,
        nlri: {
            prefix: '10.20.30.0/24',
            rd: '65000:7',
            labels: [{ label: 900, bottom: true }],
            rawNlri: '0038410000fde8000000070a141e'
        }
    });
    assertSameKey(firstLabel, changedLabel, 'VPN label changes must retain the route key');

    const rdTypeZero = createRouteKey({
        afi: 1,
        safi: 128,
        nlri: { prefix: '10.20.30.0/24', rd: '65000:7', rdRaw: 'raw:0000fde800000007' }
    });
    const rdTypeTwo = createRouteKey({
        afi: 1,
        safi: 128,
        nlri: { prefix: '10.20.30.0/24', rd: '65000:7', rdRaw: 'raw:00020000fde80007' }
    });
    assertDifferentKey(rdTypeZero, rdTypeTwo, 'VPN route IDs must preserve the binary RD type');
}

// Add-Path is part of the route identity.
{
    const pathOne = createRouteKey({ afi: 1, safi: 1, pathId: 1, nlri: { prefix: '203.0.113.0/24' } });
    const pathTwo = createRouteKey({ afi: 1, safi: 1, pathId: 2, nlri: { prefix: '203.0.113.0/24' } });
    assertDifferentKey(pathOne, pathTwo, 'different ADD-PATH IDs must not collide');
}

// Storage identity is the composite (scope_id, route_key). The NLRI key remains
// reusable while the scope component provides isolation.
{
    const route = { afi: 1, safi: 1, nlri: { prefix: '198.51.100.0/24' } };
    const peerOne = createScopedRouteIdentity({ scope: baseScope, route });
    const peerTwo = createScopedRouteIdentity({
        scope: { ...baseScope, peer: { ...baseScope.peer, address: '192.0.2.2' } },
        route
    });
    assert.strictEqual(peerOne.routeKey.keyHex, peerTwo.routeKey.keyHex);
    assert.notStrictEqual(peerOne.scopeKey.keyHex, peerTwo.scopeKey.keyHex);
    assert.notDeepStrictEqual(peerOne.primaryKey, peerTwo.primaryKey);
}

// EVPN uses sorted structural fields, excludes labels and presentation/diagnostic
// fields, and still distinguishes an actual NLRI identity change.
{
    const evpnA = createRouteKey({
        afi: 25,
        safi: 70,
        pathId: 7,
        nlri: {
            routeType: 2,
            routeTypeName: 'MAC/IP Advertisement',
            rd: '65000:1',
            esi: '00:00:00:00:00:00:00:00:00:00',
            ethernetTagId: 100,
            macLength: 48,
            macAddress: 'AA-BB-CC-DD-EE-FF',
            ipLength: 128,
            ipAddress: '2001:0db8:0:0:0:0:0:10',
            labels: [{ mplsLabel: 625, vni: 10000 }],
            rawNlri: 'raw bytes containing label are intentionally ignored',
            valid: true,
            warnings: []
        },
        nextHop: '192.0.2.1'
    });
    const evpnB = createRouteKey({
        safi: 70,
        afi: 25,
        pathId: 7,
        nlri: {
            ipAddress: '2001:db8::10',
            ipLength: 128,
            macAddress: 'aa:bb:cc:dd:ee:ff',
            macLength: 48,
            ethernetTagId: 100,
            esi: '00:00:00:00:00:00:00:00:00:00',
            rd: '65000:1',
            routeType: 2,
            labels: [{ mplsLabel: 999, vni: 15984 }],
            rawNlri: 'different label bytes',
            errors: ['presentation-only parser diagnostic']
        },
        communities: ['65000:100']
    });
    const differentMac = createRouteKey({
        afi: 25,
        safi: 70,
        pathId: 7,
        nlri: { ...evpnB.canonicalIdentity.nlri.semantic, macAddress: 'aa:bb:cc:dd:ee:00' }
    });

    assertSameKey(evpnA, evpnB, 'EVPN field order, labels, and diagnostics must not change the key');
    assertDifferentKey(evpnA, differentMac, 'an EVPN NLRI field change must change the key');
}

// Opaque complex families use exact raw NLRI bytes plus route type. Hex formatting
// and unrelated attributes are normalized away.
{
    const flowSpecA = createRouteKey({
        afi: 1,
        safi: 133,
        nlri: { rawNlri: Buffer.from('010218c00002', 'hex'), components: [{ type: 1, value: '192.0.2.0/24' }] },
        nextHop: '192.0.2.1'
    });
    const flowSpecB = createRouteKey({
        afi: 1,
        safi: 133,
        nlri: { rawNlri: '01 02 18 c0 00 02', components: [{ value: 'changed display', type: 1 }] },
        localPref: 200
    });
    assertSameKey(flowSpecA, flowSpecB, 'raw complex NLRI bytes must be deterministic');
}

// Stable JSON is also exposed for collision verification and migration tooling.
assert.strictEqual(canonicalStringify({ z: 1, a: { y: 2, x: 3 } }), canonicalStringify({ a: { x: 3, y: 2 }, z: 1 }));

function makeLookupRoute(afi, safi, nlri, pathId = 3) {
    const route = new BmpBgpRoute(null, null);
    Object.assign(route, {
        afi,
        safi,
        pathId,
        rd: nlri.rd || '0:0',
        rdRaw: nlri.rdRaw || null,
        ip: nlri.prefix || 'identical display prefix',
        mask: nlri.length ?? 0,
        nlriDetail: nlri
    });
    return route;
}

function lookupKey(route) {
    const identity = canonicalizeRouteIdentity(route);
    const formatted = formatRouteLookupKey(identity, route);
    assert.strictEqual(route.getRouteKey(), formatted, 'in-memory and persistence lookup keys must agree');
    return formatted;
}

// Ordinary IP lookup formatting reuses the canonical network. It must not add
// hashing, JSON serialization, or prefix normalization to the mutation hot path.
{
    const identity = canonicalizeRouteIdentity({ afi: 1, safi: 1, pathId: 3, nlri: { prefix: '192.0.2.129/24' } });
    const createHash = crypto.createHash;
    const stringify = JSON.stringify;
    crypto.createHash = () => {
        throw new Error('route lookup formatting must not hash');
    };
    JSON.stringify = () => {
        throw new Error('ordinary IP route lookup formatting must not serialize JSON');
    };
    try {
        assert.strictEqual(formatRouteLookupKey(identity), '3|0:0|192.0.2.0|24');
        assert.strictEqual(
            formatRouteLookupKey(identity, { rd: '65000:7', rdRaw: 'raw:0000fde800000007' }),
            '3|raw:0000fde800000007|192.0.2.0|24'
        );
        assert.strictEqual(
            makeLookupRoute(1, 1, { prefix: '192.0.2.129', length: 24 }).getRouteKey(),
            '3|0:0|192.0.2.0|24'
        );
    } finally {
        crypto.createHash = createHash;
        JSON.stringify = stringify;
    }
    const ipv6 = makeLookupRoute(2, 1, { prefix: '2001:0db8:1:2:ffff:ffff:ffff:ffff', length: 64 });
    assert.strictEqual(lookupKey(ipv6), '3|0:0|2001:db8:1:2::|64');
    const legacy = new BmpBgpRoute(null, null);
    Object.assign(legacy, { pathId: 3, ip: '192.0.2.129', mask: 24 });
    assert.strictEqual(
        legacy.getRouteKey(),
        '3|0:0|192.0.2.129|24',
        'AF-less synthetic routes retain the static key path'
    );
}

// QP's complete variable-prefix identity includes DQPN presence AND bit length.
{
    const prefix = { prefix: '203.0.113.0', length: 24 };
    const variants = [
        { ...prefix, dqpn: null, dqpnBits: null },
        { ...prefix, dqpn: 0, dqpnBits: 0 },
        { ...prefix, dqpn: 1, dqpnBits: 8 },
        { ...prefix, dqpn: 1, dqpnBits: 16 }
    ].map(nlri => makeLookupRoute(1, 241, nlri));
    const keys = variants.map(lookupKey);
    assert.strictEqual(new Set(keys).size, variants.length);
    assert.strictEqual(keys[0], '3|0:0|qp:1:203.0.113.0/24;dqpn=absent');
    assert.strictEqual(keys[1], '3|0:0|qp:1:203.0.113.0/24;dqpn=0/0');
    assert.strictEqual(keys[2], '3|0:0|qp:1:203.0.113.0/24;dqpn=1/8');
    assert.strictEqual(
        lookupKey(makeLookupRoute(1, 241, { ...prefix, prefix: '203.0.113.129', dqpn: 1, dqpnBits: 8 })),
        keys[2]
    );
    assert.notStrictEqual(lookupKey(makeLookupRoute(1, 241, { ...prefix, length: 25, dqpn: 1, dqpnBits: 8 })), keys[2]);
    assert.notStrictEqual(lookupKey(makeLookupRoute(1, 241, variants[2].nlriDetail, 4)), keys[2]);
    assert.throws(
        () => canonicalizeRouteIdentity(makeLookupRoute(1, 241, { ...prefix, dqpn: 1 })),
        /both be present or absent/
    );
}

// RD's canonical identity takes precedence over mutable/display metadata. Its
// binary type remains significant even when the printable RD is identical.
{
    const typeZero = makeLookupRoute(1, 128, {
        prefix: '10.20.30.129',
        length: 24,
        rd: '65000:7',
        rdRaw: 'raw:0000fde800000007'
    });
    const typeTwo = makeLookupRoute(1, 128, { ...typeZero.nlriDetail, rdRaw: 'raw:00020000fde80007' });
    assert.strictEqual(lookupKey(typeZero), '3|raw:0000fde800000007|10.20.30.0|24');
    assert.notStrictEqual(lookupKey(typeZero), lookupKey(typeTwo));
    const identity = canonicalizeRouteIdentity(typeZero);
    assert.strictEqual(
        formatRouteLookupKey(identity, { rd: 'wrong:9', rdRaw: 'raw:ffffffffffffffff' }),
        lookupKey(typeZero)
    );
    assert.strictEqual(
        lookupKey(makeLookupRoute(1, 128, { prefix: '10.20.30.0', length: 24, rd: '065000:0007' })),
        '3|65000:7|10.20.30.0|24'
    );
}

// Each EVPN type uses its RFC identity, not the formatted prefix, ESI/Gateway
// where mutable, labels, or NLRI's encoded length. No lookup formatting hashes.
{
    const esi = '00:00:00:00:00:00:00:00:00:01';
    const families = [
        [{ routeType: 1, rd: '65000:1', esi, ethernetTagId: 100 }, 'esi', '00:00:00:00:00:00:00:00:00:02'],
        [
            {
                routeType: 2,
                rd: '65000:1',
                esi,
                ethernetTagId: 100,
                macLength: 48,
                macAddress: 'aa:bb:cc:dd:ee:ff',
                ipLength: 32,
                ipAddress: '192.0.2.1'
            },
            'macAddress',
            'aa:bb:cc:dd:ee:00'
        ],
        [
            { routeType: 3, rd: '65000:1', ethernetTagId: 100, ipLength: 32, originatingRouterIp: '192.0.2.1' },
            'originatingRouterIp',
            '192.0.2.2'
        ],
        [
            { routeType: 4, rd: '65000:1', esi, ipLength: 32, originatingRouterIp: '192.0.2.1' },
            'esi',
            '00:00:00:00:00:00:00:00:00:02'
        ],
        [
            {
                routeType: 5,
                rd: '65000:1',
                esi,
                ethernetTagId: 100,
                prefixLength: 24,
                ipPrefix: '192.0.2.129',
                gatewayIp: '192.0.2.1'
            },
            'ipPrefix',
            '198.51.100.0'
        ]
    ];
    const createHash = crypto.createHash;
    crypto.createHash = () => {
        throw new Error('complete lookup keys must not add a second hash');
    };
    try {
        for (const [nlri, changedField, changedValue] of families) {
            const first = makeLookupRoute(25, 70, { ...nlri, labels: [{ label: 100 }], length: 216 });
            const key = lookupKey(first);
            assert.ok(
                key.startsWith('3|65000:1|25:70:evpn:'),
                'EVPN lookup keys carry family and type-specific identity'
            );
            const updated = makeLookupRoute(25, 70, {
                ...nlri,
                ...(nlri.routeType === 2 || nlri.routeType === 5 ? { esi: 'mutable-new-esi' } : {}),
                gatewayIp: '198.51.100.1',
                labels: [{ label: 300 }, { label: 400 }],
                length: 240,
                nextHop: '192.0.2.254',
                rawNlri: 'new forwarding bytes',
                warnings: ['annotation']
            });
            assert.strictEqual(
                lookupKey(updated),
                key,
                `EVPN RT${nlri.routeType} path updates retain their lookup key`
            );
            assert.notStrictEqual(lookupKey(makeLookupRoute(25, 70, { ...nlri, [changedField]: changedValue })), key);
        }
    } finally {
        crypto.createHash = createHash;
    }
}

// Opaque/structured NLRI keys retain all canonical fields and escape delimiters
// reversibly; equal display prefixes and injected pipes cannot alias another key.
{
    const raw = makeLookupRoute(1, 133, { prefix: 'same display', rawNlri: '010218c00002', routeType: 1 });
    const key = lookupKey(raw);
    assert.notStrictEqual(lookupKey(makeLookupRoute(1, 133, { ...raw.nlriDetail, rawNlri: '010218c00003' })), key);
    assert.notStrictEqual(lookupKey(makeLookupRoute(1, 133, { ...raw.nlriDetail, routeType: 2 })), key);
    assert.notStrictEqual(lookupKey(makeLookupRoute(2, 133, raw.nlriDetail)), key);
    const structured = makeLookupRoute(3, 99, { prefix: 'same display', descriptor: { value: 'left|right', code: 1 } });
    const escaped = lookupKey(structured);
    assert.strictEqual(escaped.split('|').length, 3);
    assert.ok(escaped.includes('left\\u007cright'));
    const completeNlriJson = escaped.slice(escaped.indexOf(':structured-nlri:') + ':structured-nlri:'.length);
    assert.deepStrictEqual(JSON.parse(completeNlriJson), canonicalizeRouteIdentity(structured).nlri);
    assert.notStrictEqual(
        lookupKey(
            makeLookupRoute(3, 99, { ...structured.nlriDetail, descriptor: { value: 'left\\u007cright', code: 1 } })
        ),
        escaped
    );
    assert.notStrictEqual(
        lookupKey(makeLookupRoute(3, 99, { ...structured.nlriDetail, descriptor: { value: 'left|right', code: 2 } })),
        escaped
    );
}

// Persistence's existing canonical string supplies EVPN/structured semantic
// JSON once. Its literal separator cannot be confused with an escaped NLRI
// control character, and the optimized lookup string remains byte-identical.
{
    const identities = [
        createRouteKey({
            afi: 25,
            safi: 70,
            pathId: 3,
            nlri: {
                routeType: 2,
                rd: '65000:1',
                ethernetTagId: 100,
                macLength: 48,
                macAddress: 'aa:bb:cc:dd:ee:ff',
                ipLength: 32,
                ipAddress: '192.0.2.1'
            }
        }),
        createRouteKey({
            afi: 3,
            safi: 99,
            pathId: 3,
            nlri: { prefix: 'display', descriptor: { value: 'left\u001fright|tail', code: 1 } }
        })
    ];
    const expected = identities.map(key => formatRouteLookupKey(key.canonicalIdentity));
    const stringify = JSON.stringify;
    JSON.stringify = () => {
        throw new Error('precomputed canonical route strings must not serialize semantic JSON twice');
    };
    try {
        identities.forEach((key, index) => {
            assert.strictEqual(formatRouteLookupKey(key.canonicalIdentity, {}, key.canonicalJson), expected[index]);
        });
    } finally {
        JSON.stringify = stringify;
    }
}

console.log('BMP persistent route key tests passed');
