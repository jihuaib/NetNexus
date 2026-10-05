const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NODE_ENV = 'test';
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForTest() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpPeer = require('../../electron/worker/bgp/bgpPeer');
const BgpRoute = require('../../electron/worker/bgp/bgpRoute');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');
const registry = require('../../shared/bgpAttributes.json');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');
const {
    buildAttributeRuleContext,
    getGeneratedAttributeValues
} = require('../../electron/utils/bgp/simulator/bgpAttributeRules');
const family = BgpConst.BGP_ADDR_FAMILY;
const type = BgpConst.BGP_PATH_ATTR;

function fixture(dbPath, addressFamily = family.IPV4_UNC, addPath = false) {
    const worker = new BgpWorker();
    const safi = addressFamily === family.IPV4_LABEL_UNICAST ? 4 : 1;
    const store = new BgpRouteSqliteStore(dbPath);
    const instance = new BgpInstance(0, 1, safi, store);
    worker.routeStore = store;
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    worker.messageHandler.sendSuccessResponse = () => {};
    worker.messageHandler.sendErrorResponse = (_id, message) => {
        throw new Error(message);
    };
    const sent = [];
    const session = {
        localIp: '192.0.2.254',
        localAs: 65000,
        peerIp: '192.0.2.1',
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS | (addPath ? BgpConst.BGP_CAP_FLAGS.ADD_PATH : 0),
        isAddPathSendEnabled: () => addPath,
        buildBgpMessageHeader(length, packetType) {
            const header = Buffer.alloc(BgpConst.BGP_HEAD_LEN, 0xff);
            header.writeUInt16BE(length, BgpConst.BGP_MARKER_LEN);
            header[BgpConst.BGP_MARKER_LEN + 2] = packetType;
            return header;
        },
        processCustomPkt: hex => Buffer.from(hex, 'hex'),
        sendRoute: buffer => sent.push(Buffer.from(buffer))
    };
    const peer = new BgpPeer(session, instance);
    peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
    instance.peerMap.set(session.peerIp, peer);
    return {
        worker,
        store,
        instance,
        session,
        peer,
        sent,
        generate(groupId, config = {}) {
            return worker.generateRoutes('generate', {
                groupId,
                addressFamily,
                prefix: '10.90.0.1',
                mask: 32,
                count: 1,
                nlriEncoding: 'mpReach',
                attributeRules: [],
                nlriRules: [],
                ...config
            });
        },
        rows: () => Array.from(instance.routeMap.values()),
        packets: () =>
            sent.map(buffer =>
                parseBgpPacket(buffer, { asnSize: 4, getAddPathReceiveInfo: () => ({ enabled: addPath }) })
            )
    };
}

function attributes(f, code) {
    return f.packets().flatMap(packet => packet.pathAttributes.filter(attribute => attribute.typeCode === code));
}
function reaches(f) {
    return attributes(f, type.MP_REACH_NLRI);
}
function reachNlri(attribute) {
    return attribute.value.subarray(5 + attribute.value[3]);
}
function withdrawNlri(attribute) {
    return attribute.value.subarray(3);
}
function assertEmptyMpHop(f) {
    assert.ok(reaches(f).length > 0);
    for (const attribute of reaches(f)) {
        assert.equal(attribute.value[3], 0, 'an absent MP Next Hop node must encode zero Next Hop bytes');
        assert.deepEqual(Array.from(reachNlri(attribute)), [32, 10, 90, 0, 1]);
    }
}

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-tree-presence-'));
    let f;
    try {
        const context = buildAttributeRuleContext({
            count: 1,
            attributeRules: [
                { type: 'med', value: 7, enabled: false },
                { type: 'med', value: 8, enabled: false }
            ],
            nlriRules: [{ type: 'addPath', count: 2, enabled: false }]
        });
        assert.equal(context.enabled, true, 'context enabled remains the tree/legacy mode discriminator');
        assert.equal(context.pathCount, 2, 'ADD-PATH node presence controls path count despite an old flag');
        assert.ok(context.rules.every(rule => !Object.hasOwn(rule, 'enabled')));
        assert.deepEqual(getGeneratedAttributeValues(context, 1).attr.pathAttributes, [
            { type: 'med', value: 7 },
            { type: 'med', value: 8 }
        ]);
        assert.equal(buildAttributeRuleContext({}).enabled, false);

        const dbPath = path.join(directory, 'unicast.sqlite');
        f = fixture(dbPath);
        await f.generate('sparse', {
            attributeRules: [
                { type: 'nextHop', mode: 'fixed', value: '192.0.2.10', enabled: false },
                { type: 'med', value: 7, enabled: false },
                { type: 'srv6', value: '2001:db8::1', enabled: false }
            ]
        });
        assertEmptyMpHop(f);
        assert.deepEqual(
            f.packets()[0].pathAttributes.map(attribute => attribute.typeCode),
            [3, 4, 40, 14]
        );
        assert.equal(attributes(f, type.NEXT_HOP)[0].value.toString('hex'), 'c000020a');
        assert.equal(attributes(f, type.MED)[0].value.readUInt32BE(), 7);
        assert.equal(f.rows()[0].mpNextHop, null);
        assert.equal(f.rows()[0].getRouteInfo(f.instance.getRouteAttr(f.rows()[0])).mpNextHop, null);
        assert.equal(f.store.getRouteGroupRoutes('sparse', { includeAttr: false })[0].mpNextHop, null);
        const attrId = f.rows()[0].attrId;
        f.sent.length = 0;
        await f.generate('sparse', {
            attributeRules: [
                { type: 'nextHop', mode: 'fixed', value: '192.0.2.10' },
                { type: 'med', value: 7 },
                { type: 'srv6', value: '2001:db8::1' }
            ],
            nlriRules: [{ type: 'mpNextHop', mode: 'auto', enabled: false }]
        });
        assert.equal(f.rows()[0].mpNextHop, '');
        assert.equal(f.rows()[0].attrId, attrId, 'MP Next Hop presence is NLRI state, outside the path attribute hash');
        assert.equal(f.packets()[0].pathAttributes[0].typeCode, type.MP_UNREACH_NLRI);
        assert.equal(reaches(f)[0].value[3], 4);
        assert.equal(reaches(f)[0].value.subarray(4, 8).toString('hex'), 'c00002fe');
        f.sent.length = 0;
        await f.generate('sparse');
        assert.equal(attributes(f, type.NEXT_HOP).length, 0, 'removed Type 3 must not be injected into MP UPDATE');
        assert.equal(f.packets()[0].pathAttributes[0].typeCode, type.MP_UNREACH_NLRI);
        assertEmptyMpHop(f);
        assert.deepEqual(
            f
                .packets()
                .at(-1)
                .pathAttributes.map(attribute => attribute.typeCode),
            [14]
        );
        const emptyAttrId = f.rows()[0].attrId;
        f.sent.length = 0;
        await f.generate('auto', { prefix: '10.90.0.2', nlriRules: [{ type: 'mpNextHop', mode: 'auto' }] });
        assert.equal(f.rows()[1].attrId, emptyAttrId);
        f.store.close();
        f = fixture(dbPath);
        assert.deepEqual(
            f.rows().map(route => route.mpNextHop),
            [null, '']
        );
        f.session.localIp = '192.0.2.253';
        f.peer.sendRoute();
        assert.equal(
            reaches(f).length,
            2,
            'absent and auto next hops with equal attributes must use distinct UPDATE groups'
        );
        assert.deepEqual(
            reaches(f)
                .map(attribute => attribute.value[3])
                .sort(),
            [0, 4]
        );
        assert.equal(
            reaches(f)
                .find(attribute => attribute.value[3] === 4)
                .value.subarray(4, 8)
                .toString('hex'),
            'c00002fd'
        );
        f.store.close();

        const labelDbPath = path.join(directory, 'label.sqlite');
        f = fixture(labelDbPath, family.IPV4_LABEL_UNICAST, true);
        await f.generate('label', {
            routes: [{ ip: '10.90.0.1', mask: 32, pathId: 7, label: 999 }],
            nlriRules: []
        });
        assert.equal(f.rows()[0].label, null, 'no Label node means no label, even when an input row supplies one');
        assert.equal(f.rows()[0].pathId, 7);
        assert.equal(f.rows()[0].getRouteInfo(f.instance.getRouteAttr(f.rows()[0])).label, null);
        assert.equal(reachNlri(reaches(f)[0]).toString('hex'), '00000007200a5a0001');
        f.store.close();
        f = fixture(labelDbPath, family.IPV4_LABEL_UNICAST, true);
        assert.equal(f.rows()[0].label, null);
        assert.equal(f.rows()[0].pathId, 7, 'a missing Label must not erase Path ID during SQLite rehydrate');
        f.peer.sendRoute();
        assert.equal(reachNlri(reaches(f)[0]).toString('hex'), '00000007200a5a0001');
        f.sent.length = 0;
        await f.generate('label', {
            routes: [{ ip: '10.90.0.1', mask: 32, pathId: 7 }],
            nlriRules: [{ type: 'label', value: 16000, enabled: false }]
        });
        assert.equal(f.packets()[0].pathAttributes[0].typeCode, type.MP_UNREACH_NLRI);
        assert.equal(withdrawNlri(attributes(f, type.MP_UNREACH_NLRI)[0]).toString('hex'), '00000007200a5a0001');
        assert.equal(reachNlri(reaches(f)[0]).toString('hex'), '000000073803e8010a5a0001');
        f.sent.length = 0;
        await f.generate('label', { routes: [{ ip: '10.90.0.1', mask: 32, pathId: 7 }] });
        assert.equal(withdrawNlri(attributes(f, type.MP_UNREACH_NLRI)[0]).toString('hex'), '000000073803e8010a5a0001');
        assert.equal(reachNlri(reaches(f)[0]).toString('hex'), '00000007200a5a0001');
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('withdraw', { groupId: 'label' });
        assert.equal(withdrawNlri(attributes(f, type.MP_UNREACH_NLRI)[0]).toString('hex'), '00000007200a5a0001');
        assert.equal(f.rows().length, 0);

        const legacyRoute = new BgpRoute(f.instance);
        legacyRoute.ip = '10.90.0.1';
        legacyRoute.mask = 32;
        assert.equal(
            f.peer.getMpReachNextHopBytes(legacyRoute).length,
            4,
            'legacy MP next hops retain session fallback'
        );
        const labelDefault = registry.attributes.find(attribute => attribute.type === 'label').default.value;
        assert.deepEqual(
            Array.from(f.peer.buildLabeledUnicastNlri(legacyRoute)),
            [
                56,
                (labelDefault >>> 12) & 0xff,
                (labelDefault >>> 4) & 0xff,
                ((labelDefault & 0xf) << 4) | 1,
                10,
                90,
                0,
                1
            ],
            'legacy Label encoding retains metadata defaults'
        );
        console.log('BGP tree node presence CI passed');
    } finally {
        if (f) f.store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
