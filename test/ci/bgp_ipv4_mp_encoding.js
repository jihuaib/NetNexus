const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForUnitTest() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpPeer = require('../../electron/worker/bgp/bgpPeer');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');
const { parseBgpPacket } = require('../../electron/utils/bgpPacketParser');
const { attributeRegistry } = require('../../electron/utils/bgpAttributeRegistry');

const family = BgpConst.BGP_ADDR_FAMILY.IPV4_UNC;
const afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
const safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;
const clone = value => JSON.parse(JSON.stringify(value));
const attrs = packet => new Map(packet.pathAttributes.map(attr => [attr.typeCode, attr]));

function rules(section) {
    return attributeRegistry.attributes
        .filter(
            entry =>
                entry.defaultNode &&
                (entry.section || 'attributes') === section &&
                (!entry.addressFamilies || entry.addressFamilies.includes(family))
        )
        .map(entry => ({ type: entry.type, ...clone(entry.default) }));
}

function makeFixture(options = {}) {
    const worker = new BgpWorker();
    const instance = new BgpInstance(0, afi, safi, options.dbPath ? new BgpRouteSqliteStore(options.dbPath) : null);
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    const responses = [];
    const sent = [];
    worker.messageHandler.sendSuccessResponse = (id, data) => responses.push({ id, data });
    worker.messageHandler.sendErrorResponse = (_id, error) => {
        throw new Error(error);
    };
    const session = {
        localIp: '192.0.2.254',
        localAs: 65000,
        peerIp: '192.0.2.1',
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS | (options.addPath ? BgpConst.BGP_CAP_FLAGS.ADD_PATH : 0),
        isAddPathSendEnabled: () => options.addPath === true,
        buildBgpMessageHeader(length, type) {
            const header = Buffer.alloc(BgpConst.BGP_HEAD_LEN, 0xff);
            header.writeUInt16BE(length, BgpConst.BGP_MARKER_LEN);
            header[BgpConst.BGP_MARKER_LEN + 2] = type;
            return header;
        },
        processCustomPkt: hex => Buffer.from(hex.replace(/\s/g, ''), 'hex'),
        sendRoute: buffer => sent.push(Buffer.from(buffer))
    };
    const peer = new BgpPeer(session, instance);
    peer.peerState = BgpConst.BGP_PEER_STATE.ESTABLISHED;
    instance.peerMap.set(session.peerIp, peer);
    const parseContext = {
        asnSize: 4,
        isAddPathReceiveEnabled: () => options.addPath === true,
        getAddPathReceiveInfo: () => ({ enabled: options.addPath === true })
    };
    return {
        worker,
        instance,
        peer,
        sent,
        responses,
        packets: () =>
            sent.map(buffer => {
                assert.ok(buffer.length <= BgpConst.BGP_MAX_PKT_SIZE);
                const packet = parseBgpPacket(buffer, parseContext);
                assert.ok(packet.valid);
                return packet;
            }),
        generate(id, config = {}) {
            worker.generateRoutes(id, {
                ...attributeRegistry.route.defaults,
                addressFamily: family,
                attributeRules: rules('attributes'),
                nlriRules: [{ type: 'mpNextHop', mode: 'auto' }, ...rules('nlri')],
                ...config
            });
        }
    };
}

function mpReach(packet) {
    const attr = attrs(packet);
    assert.deepStrictEqual(packet.nlri, [], 'MP announcements must not have trailing traditional NLRI');
    const reach = attr.get(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI)?.mpReach;
    assert.ok(reach);
    assert.strictEqual(reach.afi, afi);
    assert.strictEqual(reach.safi, safi);
    assert.strictEqual(reach.nextHopLength, 4);
    assert.strictEqual(reach.nextHop, '192.0.2.254');
    return reach;
}

function mpWithdraw(packet) {
    assert.deepStrictEqual(packet.withdrawnRoutes, [], 'MP withdrawals must not use the legacy withdrawn-routes field');
    assert.deepStrictEqual(packet.nlri, []);
    const unreach = attrs(packet).get(BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI)?.mpUnreach;
    assert.ok(unreach);
    assert.strictEqual(unreach.afi, afi);
    assert.strictEqual(unreach.safi, safi);
    return unreach;
}

async function main() {
    {
        const f = makeFixture();
        f.generate('classic', { prefix: '10.20.0.1', mask: 32, count: 3 });
        f.generate('forced-mp', { prefix: '10.21.0.1', mask: 32, count: 3, nlriEncoding: 'mpReach' });
        const routes = Array.from(f.instance.routeMap.values());
        assert.deepStrictEqual(
            routes.map(route => route.nlriEncoding),
            ['auto', 'auto', 'auto', 'mpReach', 'mpReach', 'mpReach']
        );
        assert.strictEqual(
            new Set(routes.map(route => route.attrId)).size,
            1,
            'encoding must not contaminate the shared path-attribute hash'
        );
        assert.strictEqual(
            f.peer.getOutboundRouteGroups().length,
            2,
            'same attributes with different encoding need different UPDATE groups'
        );
        assert.ok(routes.every(route => !Object.hasOwn(f.instance.getRouteAttr(route), 'nlriEncoding')));
        assert.ok(routes.every(route => !f.instance.getRouteAttr(route).configuredAttributes.includes('addPath')));
        assert.strictEqual(routes[3].getRouteInfo(f.instance.getRouteAttr(routes[3])).nlriEncoding, 'mpReach');
        f.sent.length = 0;
        f.peer.sendRoute();
        const packets = f.packets();
        assert.strictEqual(packets.length, 2);
        assert.ok(attrs(packets[0]).has(BgpConst.BGP_PATH_ATTR.NEXT_HOP));
        assert.strictEqual(packets[0].nlri.length, 3);
        assert.strictEqual(mpReach(packets[1]).nlri.length, 3);
        assert.throws(
            () => f.generate('invalid-encoding', { prefix: '10.22.0.1', nlriEncoding: 'invalid' }),
            /NLRI编码/
        );
        assert.strictEqual(f.instance.routeMap.size, 6);
        f.sent.length = 0;
        f.worker.deleteRoute('delete-both-modes', { addressFamily: family, routes });
        const withdrawals = f.packets();
        assert.strictEqual(withdrawals.length, 2);
        assert.strictEqual(withdrawals[0].withdrawnRoutes.length, 3);
        assert.strictEqual(attrs(withdrawals[0]).has(BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI), false);
        assert.strictEqual(mpWithdraw(withdrawals[1]).withdrawnRoutes.length, 3);
        assert.strictEqual(f.instance.routeMap.size, 0);
        f.instance.routeStore.close();
    }

    {
        const f = makeFixture();
        f.generate('mp-many-batches', { prefix: '10.40.0.1', mask: 32, count: 5000, nlriEncoding: 'mpReach' });
        const packets = f.packets();
        const counts = packets.map(packet => mpReach(packet).nlri.length);
        const perPacket = Math.floor((BgpConst.BGP_MAX_PKT_SIZE - (f.sent[0].length - counts[0] * 5)) / 5);
        assert.deepStrictEqual(
            counts,
            [...Array(Math.floor(5000 / perPacket)).fill(perPacket), 5000 % perPacket],
            'streaming across 2000-route persistence batches must pack MP packets completely'
        );
        f.generate('classic-other-group', { prefix: '10.50.0.1', mask: 32, count: 3, nlriEncoding: 'auto' });
        f.sent.length = 0;
        f.peer.sendRoute();
        const refreshed = f.packets();
        assert.strictEqual(
            refreshed
                .filter(packet => attrs(packet).has(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI))
                .reduce((count, packet) => count + mpReach(packet).nlri.length, 0),
            5000
        );
        assert.strictEqual(
            refreshed
                .filter(packet => !attrs(packet).has(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI))
                .reduce((count, packet) => count + packet.nlri.length, 0),
            3
        );
        f.sent.length = 0;
        await f.worker.deleteAllRoutesByFamily('delete-mixed-all', { addressFamily: family });
        const withdrawals = f.packets();
        assert.ok(withdrawals.length > 2);
        assert.strictEqual(
            withdrawals
                .filter(packet => attrs(packet).has(BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI))
                .reduce((count, packet) => count + mpWithdraw(packet).withdrawnRoutes.length, 0),
            5000
        );
        assert.strictEqual(
            withdrawals
                .filter(packet => !attrs(packet).has(BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI))
                .reduce((count, packet) => count + packet.withdrawnRoutes.length, 0),
            3
        );
        assert.strictEqual(f.instance.routeMap.size, 0);
        f.instance.routeStore.close();
    }

    {
        const f = makeFixture({ addPath: true });
        f.generate('mp-add-path-many-batches', {
            prefix: '10.60.0.1',
            mask: 32,
            count: 3000,
            nlriEncoding: 'mpReach',
            nlriRules: [
                { type: 'mpNextHop', mode: 'auto' },
                { type: 'addPath', count: 3 }
            ]
        });
        const packets = f.packets();
        const counts = packets.map(packet => mpReach(packet).nlri.length);
        const perPacket = Math.floor((BgpConst.BGP_MAX_PKT_SIZE - (f.sent[0].length - counts[0] * 9)) / 9);
        assert.deepStrictEqual(counts, [...Array(Math.floor(9000 / perPacket)).fill(perPacket), 9000 % perPacket]);
        const nlri = packets.flatMap(packet => mpReach(packet).nlri);
        assert.strictEqual(nlri.length, 9000);
        assert.strictEqual(new Set(nlri.map(route => `${route.prefix}|${route.pathId}`)).size, 9000);
        assert.strictEqual(
            new Set(nlri.map(route => route.prefix)).size,
            3000,
            'Count is the distinct prefix count, while each prefix has three paths'
        );
        assert.deepStrictEqual(
            nlri.slice(0, 3).map(route => route.pathId),
            [0, 1, 2]
        );
        f.sent.length = 0;
        await f.worker.deleteAllRoutesByFamily('delete-add-path', { addressFamily: family });
        const withdrawn = f.packets().flatMap(packet => mpWithdraw(packet).withdrawnRoutes);
        assert.strictEqual(withdrawn.length, 9000);
        assert.strictEqual(new Set(withdrawn.map(route => `${route.prefix}|${route.pathId}`)).size, 9000);
        f.instance.routeStore.close();
    }

    {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-mp-encoding-'));
        const dbPath = path.join(directory, 'routes.sqlite');
        let active;
        try {
            active = makeFixture({ dbPath });
            active.generate('saved-auto', { prefix: '10.70.0.1', mask: 32, count: 1 });
            active.generate('saved-mp', { prefix: '10.70.1.1', mask: 32, count: 1, nlriEncoding: 'mpReach' });
            const ids = Array.from(active.instance.routeMap.values()).map(route => route.attrId);
            active.instance.routeStore.close();
            active = makeFixture({ dbPath });
            const saved = Array.from(active.instance.routeMap.values());
            assert.deepStrictEqual(
                saved.map(route => route.nlriEncoding),
                ['auto', 'mpReach']
            );
            assert.deepStrictEqual(
                saved.map(route => route.attrId),
                ids
            );
            active.peer.sendRoute();
            assert.strictEqual(active.packets().length, 2);
            assert.strictEqual(active.packets()[0].nlri.length, 1);
            mpReach(active.packets()[1]);
            active.sent.length = 0;
            active.generate('switch-encoding-only', {
                prefix: '10.70.0.1',
                mask: 32,
                count: 1,
                nlriEncoding: 'mpReach'
            });
            assert.strictEqual(
                active.responses[0].data.updated,
                1,
                'an encoding-only SQL update must be counted and announced'
            );
            assert.strictEqual(active.packets().length, 1);
            mpReach(active.packets()[0]);
            assert.strictEqual(Array.from(active.instance.routeMap.values())[0].attrId, ids[0]);
            active.instance.routeStore.close();
        } finally {
            active?.instance.routeStore.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
    console.log(
        'IPv4 MP_REACH selection, mixed encoding, ADD-PATH, streaming, withdraw, and SQLite persistence tests passed'
    );
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
