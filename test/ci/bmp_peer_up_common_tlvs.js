const assert = require('node:assert/strict');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpConst = require('../../electron/const/bmpConst');
const { parseBmpTlvs, parseBmpPeerUpTlvs, decodeSequenceNumberTlvValue } = require('../../electron/utils/bmp/bmpUtils');
const { parseBmpPacket, getBmpPacketSummary } = require('../../electron/utils/bmp/bmpPacketParser');
const { parseBmpPacket: parseTree } = require('../../electron/pktParser/bmpPacketParser');
const { builders: b } = require('../../scripts/mockBmpClient');

// Peer Up from 111.pcapng: indexed common TLVs followed by a plain VRF TLV.
const peerUp = Buffer.from(
    '04000000d603000100000000000000000000000000000000000000000b01010100000064c0a8e40b6afd11e600015b70' +
        '0000000000000000000000000b01010400b30687' +
        'ffffffffffffffffffffffffffffffff0031010400c800b4c0a8e40e1402060104000100010202020002064104000000c8' +
        'ffffffffffffffffffffffffffffffff00310104006400b4c0a8e40b140206010400010001020202000206410400000064' +
        '000100080000000000000000000100020002000000000003000a000000016afd11e600015b7000050006676c6f62616c',
    'hex'
);
const routeMonitoring = Buffer.from(
    '04000000bf00004100000000000000000000000000000000000000000b01010100000064c0a8e40b6afd11e60001815b' +
        '000100080000000000000000000300020002000000400003000a000000016afd11e60001815b000500060000676c6f62616c' +
        '0006000600000104000100010006000600004104000000640006000200000200000700370000' +
        'ffffffffffffffffffffffffffffffff0037020000001b400101024002060201000000644003040b010101800404000000002002010101',
    'hex'
);
assert.equal(peerUp.length, 214);
assert.equal(routeMonitoring.length, 191);
const offset = 166;
assert(parseBmpTlvs(peerUp, offset).warnings.length > 0, 'the original plain parser reproduces the captured failure');
assert(parseBmpTlvs(peerUp, offset, { indexed: true }).warnings.length > 0, 'VRF does not have an index');
const mixed = parseBmpPeerUpTlvs(peerUp, offset, { allowCommonIndexed: true });
assert.deepEqual(mixed.warnings, []);
assert.equal(mixed.commonIndexed, true);
assert.deepEqual(
    mixed.tlvs.map(tlv => tlv.type),
    [1, 2, 3, 5]
);
assert.deepEqual(
    mixed.tlvs.map(tlv => tlv.rawIndex),
    [0, 0, 0, null]
);
const parsed = parseBmpPacket(peerUp);
assert.deepEqual(parsed.warnings, []);
assert.equal(parsed.payload.tlvs[0].decoded.sequenceNumber, 1);
assert.deepEqual(parsed.payload.tlvs[2].decoded, {
    timestampType: 1,
    seconds: 0x6afd11e6,
    microseconds: 0x15b70
});
assert.equal(parsed.payload.tlvs[2].name, 'Timestamp');
assert.equal(parsed.payload.tlvs[2].valueText, undefined);
assert.equal(parsed.payload.tlvs[3].valueText, 'global');
assert.match(getBmpPacketSummary(parsed), /VRF\/Table Name type=5 len=6 value="global"/);
assert.match(getBmpPacketSummary(parsed), /Sequence Number type=1 len=8 index=0 value=1/);
assert.equal(decodeSequenceNumberTlvValue(Buffer.from('ffffffffffffffff', 'hex')), '18446744073709551615');

const tree = { children: [] };
assert.equal(parseTree(peerUp, tree).valid, true);
const flatten = node => [node, ...(node.children || []).flatMap(flatten)];
const nodes = flatten(tree);
assert(nodes.some(node => node.name === 'TLV 3: Timestamp'));
assert(nodes.some(node => node.name === 'TLV 4: VRF/Table Name'));
assert.equal(nodes.filter(node => node.name === 'Index').length, 3);
assert(!nodes.some(node => (node.name || '').includes('Malformed')));

function harness() {
    const mutations = [],
        updates = [];
    const session = new BmpSession(
        { sendEvent() {} },
        {
            bmpConfigData: { bmpV4TlvDraft: 20 },
            persistence: {},
            enqueuePersistenceMutation(mutation) {
                mutations.push(mutation);
                return true;
            },
            handlePersistenceFailure(error) {
                throw error;
            },
            invalidateRouteAssurance() {},
            requestPersistenceSweep() {},
            enqueueRouteUpdateEvent(update) {
                updates.push(update);
            },
            enqueueInstanceRouteUpdateEvent(update) {
                updates.push(update);
            }
        }
    );
    Object.assign(session, { remoteIp: '192.0.2.10', remotePort: 50000, localIp: '127.0.0.1', localPort: 1790 });
    return { session, mutations, updates };
}

for (const locRib of [false, true]) {
    const h = harness();
    const up = Buffer.from(peerUp),
        rm = Buffer.from(routeMonitoring);
    if (locRib) {
        up[6] = 3;
        rm[6] = 3;
    }
    h.session.processMessage(up);
    const owners = locRib ? h.session.bgpInstanceMap : h.session.bgpSessionMap;
    assert.equal(owners.size, 1, 'a valid captured Peer Up must establish the owner');
    const owner = [...owners.values()][0];
    assert.deepEqual(owner.vrfTableNames, ['global']);
    h.mutations.length = 0;
    h.session.processMessage(rm);
    const routes = h.mutations.filter(mutation => mutation.route);
    assert.equal(routes.length, 1, 'the following UPDATE must no longer be rejected as unknown session');
    assert.equal(routes[0].route.prefix, '2.1.1.1');
    const tlvs = JSON.parse(routes[0].route.routeJson).routeTlvs;
    assert.equal(tlvs.find(tlv => tlv.type === 1).decoded.sequenceNumber, 3);
    assert.deepEqual(tlvs.find(tlv => tlv.type === 3).decoded, {
        timestampType: 1,
        seconds: 0x6afd11e6,
        microseconds: 0x1815b
    });

    for (const invalid of [up.subarray(0, up.length - 1), Buffer.concat([up, Buffer.from([0])])]) {
        const bad = Buffer.from(invalid);
        bad.writeUInt32BE(bad.length, 1);
        h.mutations.length = 0;
        h.updates.length = 0;
        h.session.processMessage(bad);
        assert.equal(h.mutations.length, 0, 'truncated TLVs must not refresh epochs or change a live owner');
        assert.equal(h.updates.length, 0);
        assert.equal([...owners.values()][0], owner);
    }
    const badIndex = Buffer.from(up);
    badIndex.writeUInt16BE(1, offset + 4);
    const fresh = harness();
    fresh.session.processMessage(badIndex);
    assert.equal(fresh.session.bgpSessionMap.size + fresh.session.bgpInstanceMap.size, 0);
}

// Legacy/plain Peer Up remains authoritative for v3 and for complete v4 TLVs.
for (const version of [3, 4]) {
    const h = harness();
    h.session.processMessage(b.bmpMessage(3, b.peerUpPayload({ vrfName: 'legacy-vrf' }), version));
    assert.equal(h.session.bgpSessionMap.size, 1);
    assert.deepEqual([...h.session.bgpSessionMap.values()][0].vrfTableNames, ['legacy-vrf']);
}
console.log('Captured BMPv4 mixed Peer Up TLVs, 64-bit sequence, typed timestamp and following UPDATE tests passed');
