const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NODE_ENV = 'test';
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForTest() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpSession = require('../../electron/worker/bgp/bgpSession');
const BgpRoute = require('../../electron/worker/bgp/bgpRoute');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');
const family = BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST;
const type = BgpConst.BGP_PATH_ATTR;

function fixture(dbPath, negotiated = true) {
    const worker = new BgpWorker();
    const store = new BgpRouteSqliteStore(dbPath);
    const instance = new BgpInstance(0, 1, 4, store);
    worker.routeStore = store;
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    worker.bgpConfigData = { localAs: 65000, routerId: '192.0.2.254' };
    const sent = [];
    const responses = [];
    worker.messageHandler.sendSuccessResponse = (id, data) => responses.push({ id, data });
    worker.messageHandler.sendErrorResponse = (_id, message) => {
        throw new Error(message);
    };
    worker.configIpv4Peer('configure', {
        peerIp: '192.0.2.1',
        peerAs: 65001,
        holdTime: 90,
        addressFamily: [family],
        openCap: [
            BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
            BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS,
            BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH
        ],
        addressFamilyConfig: { [family]: { sendAddPath: true } }
    });
    const session = worker.bgpSessionMap.get(BgpSession.makeKey(0, '192.0.2.1'));
    session.localIp = '192.0.2.254';
    session.sendRoute = buffer => sent.push(Buffer.from(buffer));
    if (negotiated) session.setPeerAddPath(1, 4, BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY);
    const peer = instance.peerMap.get(session.peerIp);
    peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
    return {
        worker,
        store,
        instance,
        session,
        peer,
        sent,
        responses,
        generate(groupId, config = {}) {
            return worker.generateRoutes('generate', {
                groupId,
                groupName: groupId,
                addressFamily: family,
                prefix: '10.60.0.1',
                mask: 32,
                count: 3,
                attributeRules: [],
                nlriRules: [
                    { type: 'addPath', count: 2 },
                    { type: 'label', mode: 'increment', start: 16000, step: 1 }
                ],
                ...config
            });
        },
        rows() {
            return Array.from(instance.routeMap.values());
        },
        packets() {
            return sent.map(buffer => {
                const packet = parseBgpPacket(buffer, {
                    asnSize: 4,
                    getAddPathReceiveInfo: (afi, safi) => ({ enabled: session.isAddPathSendEnabled(afi, safi) })
                });
                assert.ok(packet.valid, packet.error);
                return packet;
            });
        }
    };
}
function reaches(f) {
    return f
        .packets()
        .flatMap(
            packet => packet.pathAttributes.find(attr => attr.typeCode === type.MP_REACH_NLRI)?.mpReach.nlri || []
        );
}
function withdrawals(f) {
    return f
        .packets()
        .flatMap(
            packet =>
                packet.pathAttributes.find(attr => attr.typeCode === type.MP_UNREACH_NLRI)?.mpUnreach.withdrawnRoutes ||
                []
        );
}
function paths(routes) {
    return routes.map(route => [route.ip || route.prefix, route.pathId]).sort();
}
async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-label-add-path-'));
    let f;
    try {
        const dbPath = path.join(directory, 'routes.sqlite');
        f = fixture(dbPath);
        const open = parseBgpPacket(f.session.buildOpenMsg());
        assert.ok(
            open.capabilities.some(
                cap =>
                    cap.code === BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH &&
                    cap.addPaths.some(tuple => tuple.afi === 1 && tuple.safi === 4 && tuple.sendReceive === 3)
            ),
            'worker peer config must advertise ADD-PATH for the exact AFI1/SAFI4'
        );
        assert.equal(f.peer.getPeerInfo().addPathSendEnabled, true);
        assert.equal(f.peer.getPeerInfo().addPathReceiveEnabled, false);
        assert.equal(
            f.session.isAddPathSendEnabled(1, 1),
            false,
            'Label negotiation must not imply Unicast negotiation'
        );
        await f.generate('label-group');
        assert.equal(f.rows().length, 6);
        assert.deepEqual(paths(f.rows()), [
            ['10.60.0.1', 0],
            ['10.60.0.1', 1],
            ['10.60.0.2', 0],
            ['10.60.0.2', 1],
            ['10.60.0.3', 0],
            ['10.60.0.3', 1]
        ]);
        assert.equal(reaches(f).length, 6);
        assert.deepEqual(
            reaches(f).map(route => route.labels[0].label),
            [16000, 16001, 16002, 16003, 16004, 16005]
        );
        const reach = f.packets()[0].pathAttributes.find(attr => attr.typeCode === type.MP_REACH_NLRI);
        assert.equal(reach.mpReach.afi, 1);
        assert.equal(reach.mpReach.safi, 4);
        assert.ok(reach.mpReach.nlri.every(route => route.length === 32));
        assert.equal(
            reach.value[5 + reach.mpReach.nextHopLength + 4],
            56,
            'Path ID precedes the NLRI bit length and is not counted in that length'
        );
        assert.equal(reach.value.readUInt32BE(5 + reach.mpReach.nextHopLength), 0);
        assert.deepEqual(
            f.rows().map(route => route.getRouteInfo(f.instance.getRouteAttr(route)).pathId),
            [0, 1, 0, 1, 0, 1]
        );
        assert.equal(
            f.rows()[0].routeKey,
            BgpRoute.makeKey('10.60.0.1', 32),
            'Path ID zero keeps the legacy Label key'
        );
        assert.equal(f.rows()[1].routeKey, BgpRoute.makeLabelUnicastKey(1, '10.60.0.1', 32));
        const before = f.store.getRouteGroupRoutes('label-group');
        f.sent.length = 0;
        await assert.rejects(
            f.generate('other-group', {
                count: 1,
                nlriRules: [
                    { type: 'addPath', count: 3 },
                    { type: 'label', value: 20000 }
                ]
            }),
            /conflicts/
        );
        assert.deepEqual(f.store.getRouteGroupRoutes('label-group'), before);
        assert.equal(f.sent.length, 0);
        assert.throws(
            () => f.generate('label-group', { attributeRules: [{ type: 'srv6', value: '2001:db8::1' }] }),
            /不适用|SRv6/,
            'Label ADD-PATH must not enable SRv6'
        );
        await f.generate('label-group', {
            count: 2,
            nlriRules: [
                { type: 'addPath', count: 1 },
                { type: 'label', value: 17000 }
            ]
        });
        assert.equal(f.rows().length, 2);
        assert.equal(withdrawals(f).length, 4);
        assert.deepEqual(paths(withdrawals(f)), [
            ['10.60.0.1', 1],
            ['10.60.0.2', 1],
            ['10.60.0.3', 0],
            ['10.60.0.3', 1]
        ]);
        assert.equal(reaches(f).length, 2);
        f.store.close();
        f = fixture(dbPath);
        assert.deepEqual(
            f.rows().map(route => [route.ip, route.pathId, route.label]),
            [
                ['10.60.0.1', 0, 17000],
                ['10.60.0.2', 0, 17000]
            ]
        );
        await f.generate('label-group');
        const savedPaths = paths(f.rows());
        f.store.close();
        f = fixture(dbPath);
        assert.deepEqual(paths(f.rows()), savedPaths, 'SQLite reopen must preserve every nonzero Label Path ID');
        f.peer.sendRoute();
        assert.equal(reaches(f).length, 6);
        f.sent.length = 0;
        f.worker.deleteRoute('single-path', {
            addressFamily: family,
            routes: [{ ip: '10.60.0.1', mask: 32, pathId: 1 }]
        });
        assert.equal(f.rows().length, 5);
        assert.deepEqual(paths(withdrawals(f)), [['10.60.0.1', 1]]);
        assert.equal(f.store.listRouteGroups()[0].routeCount, 5);
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('edited-draft', {
            groupId: 'label-group',
            prefix: '203.0.113.1',
            count: 999
        });
        assert.equal(f.rows().length, 0);
        assert.equal(withdrawals(f).length, 5);
        assert.equal(f.store.listRouteGroups().length, 0);
        f.sent.length = 0;
        await f.generate('large', {
            count: 1500,
            prefix: '10.70.0.0',
            nlriRules: [
                { type: 'addPath', count: 3 },
                { type: 'label', value: 16000 }
            ]
        });
        assert.equal(f.rows().length, 4500);
        assert.equal(reaches(f).length, 4500, 'managed pages must send all paths exactly once');
        assert.ok(f.sent.every(buffer => buffer.length <= 4096));
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('large-remove', { groupId: 'large' });
        assert.equal(withdrawals(f).length, 4500);
        assert.ok(f.sent.every(buffer => buffer.length <= 4096));
        f.store.close();
        f = fixture(undefined, false);
        f.session.setLocalAddPath(1, 1, BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE);
        f.session.setPeerAddPath(1, 1, BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY);
        assert.equal(f.session.isAddPathSendEnabled(1, 1), true);
        assert.equal(f.peer.shouldSendAddPath(), false, 'Unicast negotiation must not enable Label ADD-PATH');
        await f.generate('fallback', {
            count: 2,
            nlriRules: [
                { type: 'addPath', count: 3 },
                { type: 'label', mode: 'increment', start: 16000, step: 1 }
            ]
        });
        assert.equal(f.rows().length, 6);
        assert.equal(reaches(f).length, 2, 'an unnegotiated peer must receive one path per prefix');
        assert.deepEqual(
            reaches(f).map(route => route.labels[0].label),
            [16000, 16003]
        );
        assert.ok(reaches(f).every(route => route.pathId === 0));
        assert.equal(
            f.packets()[0].pathAttributes.find(attr => attr.typeCode === type.MP_REACH_NLRI).value[
                5 +
                    f.packets()[0].pathAttributes.find(attr => attr.typeCode === type.MP_REACH_NLRI).mpReach
                        .nextHopLength
            ],
            56,
            'fallback NLRI starts with its length rather than a Path ID'
        );
        f.sent.length = 0;
        f.peer.sendRoute();
        assert.equal(reaches(f).length, 2, 'full-table paging must use the same fallback selection');
        f.sent.length = 0;
        await f.generate('fallback', {
            count: 2,
            nlriRules: [
                { type: 'addPath', count: 1 },
                { type: 'label', value: 17000 }
            ]
        });
        assert.equal(withdrawals(f).length, 0, 'path shrink must keep surviving prefixes for an unnegotiated peer');
        assert.equal(reaches(f).length, 2);
        f.sent.length = 0;
        f.worker.deleteRoute('fallback-selected', {
            addressFamily: family,
            routes: [{ ip: '10.60.0.1', mask: 32, pathId: 0 }]
        });
        assert.equal(withdrawals(f).length, 1);
        await f.worker.withdrawRouteGroup('fallback-remove', { groupId: 'fallback' });
        assert.equal(f.rows().length, 0);
        f.sent.length = 0;
        f.worker.generateRoutes('legacy-label', {
            addressFamily: family,
            prefix: '10.80.0.1',
            mask: 32,
            count: 2,
            label: 18000,
            addPathEnabled: true,
            addPathCount: 3
        });
        assert.equal(f.rows().length, 2, 'legacy Label generation keeps its old one-route-per-prefix behavior');
        assert.equal(f.rows()[0].routeKey, BgpRoute.makeKey('10.80.0.1', 32));
        f.sent.length = 0;
        await f.generate('explicit-label-ids', {
            routes: [
                { ip: '10.90.0.1', mask: 32, pathId: 7 },
                { ip: '10.90.0.1', mask: 32, pathId: 0xffffffff }
            ],
            nlriRules: [{ type: 'label', mode: 'increment', start: 22000, step: 1 }]
        });
        assert.deepEqual(
            f.store.getRouteGroupRoutes('explicit-label-ids').map(route => route.pathId),
            [7, 0xffffffff]
        );
        assert.equal(
            reaches(f).length,
            1,
            'explicit input rows are not multiplied and fallback chooses their lowest ID'
        );
        assert.equal(reaches(f)[0].labels[0].label, 22000);
        f.sent.length = 0;
        f.worker.deleteRoute('fallback-explicit-best', {
            addressFamily: family,
            routes: [{ ip: '10.90.0.1', mask: 32, pathId: 7 }]
        });
        assert.equal(withdrawals(f).length, 0, 'deleting a selected path must retain the surviving fallback prefix');
        assert.equal(reaches(f).length, 1);
        assert.equal(
            reaches(f)[0].labels[0].label,
            22001,
            'a remaining nonzero Path ID must be announced as the replacement'
        );
        f.sent.length = 0;
        f.session.setPeerAddPath(1, 4, BgpConst.BGP_ADD_PATH_TYPE.RECEIVE_ONLY);
        f.peer.sendRoute();
        assert.ok(
            reaches(f).some(route => route.pathId === 0xffffffff && route.prefix === '10.90.0.1'),
            'Label Path IDs use all 32 bits on the wire'
        );
        await f.worker.withdrawRouteGroup('explicit-remove', { groupId: 'explicit-label-ids' });
        f.store.upsertRoutes(f.instance.instanceKey, [
            { route: { ip: '10.95.0.1', mask: 32, label: 23000, pathId: 0 }, attr: {} },
            { route: { ip: '10.95.0.1', mask: 32, label: 23001, pathId: 13 }, attr: {} }
        ]);
        assert.equal(f.instance.routeMap.get(BgpRoute.makeKey('10.95.0.1', 32)).pathId, 0);
        assert.equal(
            f.instance.routeMap.get(BgpRoute.makeLabelUnicastKey(13, '10.95.0.1', 32)).pathId,
            13,
            'direct store inputs derive distinct Label path keys'
        );
        console.log(
            'IPv4 Label ADD-PATH negotiation, Count × paths, MP wire identifiers, ownership, SQLite replay, replacement/withdrawal, packetization, fallback selection, and legacy compatibility tests passed'
        );
    } finally {
        f?.store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
