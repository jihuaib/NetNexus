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
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');
const { parseBgpPacket } = require('../../electron/utils/bgpPacketParser');
const { buildAttributeRuleContext, getGeneratedAttributeValues } = require('../../electron/utils/bgpAttributeRules');
const family = BgpConst.BGP_ADDR_FAMILY.IPV4_UNC;
const type = BgpConst.BGP_PATH_ATTR;

function fixture(dbPath) {
    const worker = new BgpWorker();
    const instance = new BgpInstance(0, 1, 1, new BgpRouteSqliteStore(dbPath));
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    worker.routeStore = instance.routeStore;
    const sent = [];
    const responses = [];
    worker.messageHandler.sendSuccessResponse = (id, data) => responses.push({ id, data });
    worker.messageHandler.sendErrorResponse = (_id, message) => {
        throw new Error(message);
    };
    const session = {
        localIp: '192.0.2.254',
        localAs: 65000,
        peerIp: '192.0.2.1',
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS | BgpConst.BGP_CAP_FLAGS.ADD_PATH,
        isAddPathSendEnabled: () => true,
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
        instance,
        peer,
        sent,
        responses,
        generate(groupId, overrides = {}) {
            return worker.generateRoutes(groupId, {
                groupId,
                groupName: `Group ${groupId}`,
                addressFamily: family,
                prefix: '10.20.0.1',
                mask: 32,
                count: 3,
                nlriEncoding: 'mpReach',
                nlriRules: [
                    { type: 'addPath', count: 2 },
                    { type: 'mpNextHop', mode: 'fixed', value: '192.0.2.200' }
                ],
                attributeRules: [{ type: 'med', mode: 'increment', start: 10, step: 1 }],
                ...overrides
            });
        },
        packets() {
            return sent.map(buffer => {
                const packet = parseBgpPacket(buffer, {
                    asnSize: 4,
                    getAddPathReceiveInfo: () => ({ enabled: session.isAddPathSendEnabled() })
                });
                assert.ok(packet.valid, packet.error);
                return packet;
            });
        },
        rows() {
            return Array.from(instance.routeMap.values());
        }
    };
}
const mp = (packet, code) => packet.pathAttributes.find(attribute => attribute.typeCode === code);
const withdrawn = packets =>
    packets.flatMap(
        packet => mp(packet, type.MP_UNREACH_NLRI)?.mpUnreach.withdrawnRoutes || packet.withdrawnRoutes || []
    );
const announced = packets =>
    packets.flatMap(packet => mp(packet, type.MP_REACH_NLRI)?.mpReach.nlri || packet.nlri || []);
const identities = routes => routes.map(route => [route.ip || route.prefix, route.pathId]).sort();
const tick = () => new Promise(resolve => setImmediate(resolve));

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-route-groups-'));
    let f;
    try {
        const dbPath = path.join(directory, 'routes.sqlite');
        f = fixture(dbPath);
        await f.generate('alpha');
        assert.equal(f.rows().length, 6, 'Count is prefixes; ADD-PATH multiplies the number of paths');
        assert.deepEqual(identities(f.rows()), [
            ['10.20.0.1', 0],
            ['10.20.0.1', 1],
            ['10.20.0.2', 0],
            ['10.20.0.2', 1],
            ['10.20.0.3', 0],
            ['10.20.0.3', 1]
        ]);
        assert.deepEqual(
            f
                .rows()
                .map(route => f.instance.getRouteAttr(route).med)
                .sort((a, b) => a - b),
            [10, 11, 12, 13, 14, 15]
        );
        assert.equal(announced(f.packets()).length, 6);
        f.worker.getRouteGroupStates('states');
        assert.equal(f.responses.at(-1).data.groups[0].routeCount, 6);
        assert.equal(f.responses.at(-1).data.groups[0].groupName, 'Group alpha');
        const before = f.instance.routeStore.getRouteGroupRoutes('alpha');
        f.sent.length = 0;
        await assert.rejects(
            f.generate('beta', { count: 1, nlriRules: [{ type: 'addPath', count: 3 }] }),
            /conflicts with route group/
        );
        assert.deepEqual(f.instance.routeStore.getRouteGroupRoutes('alpha'), before);
        assert.equal(f.sent.length, 0, 'a rejected cross-group collision must not send a packet');
        await assert.rejects(
            f.generate('alpha', {
                routes: [
                    { ip: '10.21.0.1', mask: 32 },
                    { ip: 'bad-address', mask: 32 }
                ]
            }),
            /address|IP|ip|Invalid/
        );
        assert.deepEqual(f.instance.routeStore.getRouteGroupRoutes('alpha'), before);
        assert.equal(f.sent.length, 0, 'late candidate validation must not withdraw the old snapshot');
        await f.generate('alpha', {
            count: 2,
            nlriRules: [
                { type: 'addPath', count: 1 },
                { type: 'mpNextHop', mode: 'fixed', value: '192.0.2.200' }
            ]
        });
        assert.equal(f.rows().length, 2);
        assert.equal(withdrawn(f.packets()).length, 4, 'prefix and path count shrink withdraws only removed keys');
        assert.deepEqual(identities(withdrawn(f.packets())), [
            ['10.20.0.1', 1],
            ['10.20.0.2', 1],
            ['10.20.0.3', 0],
            ['10.20.0.3', 1]
        ]);
        assert.equal(announced(f.packets()).length, 2);
        assert.ok(mp(f.packets()[0], type.MP_UNREACH_NLRI), 'withdraw old keys before announcing replacement');
        f.sent.length = 0;
        await f.generate('alpha', { count: 2, nlriEncoding: 'auto', nlriRules: [] });
        assert.equal(withdrawn(f.packets()).length, 2, 'an encoding change withdraws the original MP NLRI');
        assert.equal(announced(f.packets()).length, 2);
        assert.deepEqual(
            announced(f.packets()).map(route => route.pathId),
            [0, 0]
        );
        f.instance.routeStore.close();
        f = fixture(dbPath);
        f.worker.getRouteGroupStates('reopen');
        assert.equal(f.responses.at(-1).data.groups[0].routeCount, 2);
        assert.equal(f.responses.at(-1).data.groups[0].groupId, 'alpha');
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('draft-ignored', {
            groupId: 'alpha',
            prefix: '203.0.113.1',
            count: 999,
            mask: 32
        });
        assert.equal(
            f.responses.at(-1).data.deleted,
            2,
            'withdraw uses stored snapshot, independently of edited draft'
        );
        assert.equal(f.rows().length, 0);
        assert.equal(withdrawn(f.packets()).length, 2);
        await f.worker.withdrawRouteGroup('missing', { groupId: 'alpha' });
        assert.equal(f.responses.at(-1).data.deleted, 0);

        await f.generate('network', { prefix: '10.22.0.200', mask: 24, count: 1, nlriRules: [] });
        assert.equal(f.rows()[0].ip, '10.22.0.0');
        f.sent.length = 0;
        await assert.rejects(f.generate('same-network', { prefix: '10.22.0.17', mask: 24, count: 1 }), /conflicts/);
        assert.equal(f.sent.length, 0);
        await f.generate('different-mask', { prefix: '10.22.0.17', mask: 25, count: 1, nlriRules: [] });
        await f.generate('different-rd', { prefix: '10.22.0.17', mask: 24, rd: '65000:7', count: 1, nlriRules: [] });
        assert.equal(f.rows().length, 3, 'different mask and RD are separate identities');
        f.sent.length = 0;
        const rowCount = f.rows().length;
        assert.throws(
            () =>
                f.worker.generateRoutes('legacy-collision-late', {
                    addressFamily: family,
                    prefix: '10.21.248.0',
                    mask: 24,
                    count: 2057,
                    attributeRules: [],
                    nlriRules: []
                }),
            /conflicts/
        );
        assert.equal(f.rows().length, rowCount, 'legacy preflight catches collisions before its first chunk');
        assert.equal(f.sent.length, 0);
        f.worker.deleteRoute('single', { addressFamily: family, routes: [{ ip: '10.22.0.0', mask: 25 }] });
        assert.equal(
            f.instance.routeStore.listRouteGroups().some(group => group.groupId === 'different-mask'),
            false
        );
        await f.worker.deleteAllRoutesByFamily('all', { addressFamily: family });
        assert.equal(f.instance.routeStore.listRouteGroups().length, 0);

        f.peer.session.isAddPathSendEnabled = () => false;
        f.peer.session.localCapFlags &= ~BgpConst.BGP_CAP_FLAGS.ADD_PATH;
        f.sent.length = 0;
        await f.generate('no-add-path', { count: 1, attributeRules: [], nlriRules: [{ type: 'addPath', count: 2 }] });
        assert.equal(announced(f.packets()).length, 1, 'a peer without ADD-PATH receives the selected path');
        f.sent.length = 0;
        await f.generate('no-add-path', {
            count: 1,
            nlriEncoding: 'auto',
            attributeRules: [],
            nlriRules: [{ type: 'addPath', count: 2 }]
        });
        assert.equal(
            withdrawn(f.packets()).length,
            1,
            'an encoding replacement must withdraw the old MP NLRI even when its prefix still exists'
        );
        assert.ok(mp(f.packets()[0], type.MP_UNREACH_NLRI));
        assert.equal(announced(f.packets()).length, 1);
        assert.equal(f.packets().at(-1).nlri.length, 1);
        f.sent.length = 0;
        await f.generate('no-add-path', {
            count: 1,
            nlriEncoding: 'auto',
            attributeRules: [],
            nlriRules: [{ type: 'addPath', count: 1 }]
        });
        assert.equal(
            withdrawn(f.packets()).length,
            0,
            'path shrink must retain the existing prefix for a peer without ADD-PATH'
        );
        assert.equal(announced(f.packets()).length, 1);
        await f.worker.withdrawRouteGroup('remove-no-add', { groupId: 'no-add-path' });
        f.peer.session.isAddPathSendEnabled = () => true;
        f.peer.session.localCapFlags |= BgpConst.BGP_CAP_FLAGS.ADD_PATH;

        f.sent.length = 0;
        await f.generate('large', {
            prefix: '10.30.0.0',
            count: 2050,
            nlriRules: [{ type: 'addPath', count: 2 }],
            attributeRules: []
        });
        assert.equal(f.rows().length, 4100);
        assert.equal(announced(f.packets()).length, 4100, 'group pagination must send every route exactly once');
        assert.ok(f.sent.every(buffer => buffer.length <= 4096));
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('large-remove', { groupId: 'large' });
        assert.equal(f.rows().length, 0);
        assert.equal(withdrawn(f.packets()).length, 4100, 'group withdrawal must send every stored path exactly once');
        assert.ok(f.sent.every(buffer => buffer.length <= 4096));

        let release;
        const gate = new Promise(resolve => {
            release = resolve;
        });
        const originalAnnounce = f.worker.announceStoredGroup.bind(f.worker);
        f.worker.announceStoredGroup = async (...args) => {
            await gate;
            return originalAnnounce(...args);
        };
        const active = f.generate('busy', { count: 1, nlriRules: [] });
        await tick();
        assert.throws(
            () => f.worker.deleteRoute('concurrent-delete', { addressFamily: family, routes: [] }),
            /正在进行/
        );
        assert.throws(
            () => f.worker.importRoutes('concurrent-import', { addressFamily: family, routes: [] }),
            /正在进行/
        );
        assert.throws(
            () =>
                f.worker.generateRoutes('concurrent-legacy', {
                    addressFamily: family,
                    count: 1,
                    prefix: '10.99.0.1',
                    mask: 32
                }),
            /正在进行/
        );
        let stopped = false;
        const stopping = f.worker.stopBgp('wait-stop').then(() => {
            stopped = true;
        });
        await tick();
        assert.equal(stopped, false);
        assert.ok(f.worker.routeStore.db, 'stop must wait before closing the database');
        release();
        await active;
        await stopping;
        assert.equal(f.worker.routeStore, null);

        const huge = buildAttributeRuleContext({ count: 1, nlriRules: [{ type: 'addPath', count: 4294967296 }] });
        assert.equal(huge.pathCount, 4294967296);
        assert.equal(huge.pathIds, undefined, 'Path IDs must not allocate an array');
        assert.equal(getGeneratedAttributeValues(huge, 4294967295).pathId, 0xffffffff);
        assert.throws(
            () =>
                buildAttributeRuleContext({
                    count: Number.MAX_SAFE_INTEGER,
                    nlriRules: [{ type: 'addPath', count: 2 }]
                }),
            /安全整数/
        );
        console.log(
            'BGP group snapshot replacement, persisted ownership, collision rollback, exact identity, Count × paths, chunked wire updates, and mutation lifecycle tests passed'
        );
    } finally {
        f?.instance.routeStore.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
