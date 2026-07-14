const assert = require('assert');
const path = require('path');

const routeKey = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'bmpPersistentRouteKey.js'));

const {
    KEY_SCHEMA_VERSION,
    canonicalStringify,
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

console.log('BMP persistent route key tests passed');
