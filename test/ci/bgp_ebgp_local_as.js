const assert = require('assert');
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
const { getAfiAndSafi } = require('../../electron/utils/bgp/bgpUtils');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');
const { ATTRIBUTE_DEFAULTS } = require('../../electron/utils/bgp/bgpAttributeRegistry');

const family = BgpConst.BGP_ADDR_FAMILY;
const type = BgpConst.BGP_PATH_ATTR;
const peerType = BgpConst.BGP_PEER_TYPE;

function fixture(addressFamily, nlriEncoding, asnSize, localAs, dbPath) {
    const worker = new BgpWorker();
    const store = new BgpRouteSqliteStore(dbPath);
    const { afi, safi } = getAfiAndSafi(addressFamily);
    const instance = new BgpInstance(0, afi, safi, store);
    worker.routeStore = store;
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    worker.messageHandler.sendSuccessResponse = () => {};
    worker.messageHandler.sendErrorResponse = (_id, message) => {
        throw new Error(message);
    };
    const sent = [];
    const session = {
        localIp: afi === 2 ? '2001:db8::254' : '192.0.2.254',
        routerId: '192.0.2.254',
        localAs,
        peerIp: afi === 2 ? '2001:db8::1' : '192.0.2.1',
        peerType: peerType.PEER_TYPE_EBGP,
        localCapFlags: asnSize === 4 ? BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS : 0,
        isAddPathSendEnabled: () => false,
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
    const vpn = addressFamily === family.VPNV4 || addressFamily === family.VPNV6;
    return {
        instance,
        store,
        session,
        peer,
        sent,
        generate(index, asPathRule = { ...ATTRIBUTE_DEFAULTS.asPath }, overrides = {}) {
            const attributeRules = [
                { type: 'origin', value: 0 },
                { type: 'asPath', ...asPathRule },
                ...(nlriEncoding === 'auto' && afi === 1 && !vpn ? [{ type: 'nextHop', mode: 'auto' }] : []),
                ...(vpn ? [{ type: 'extendedCommunities', value: ['rt:65000:1'] }] : [])
            ];
            const config = {
                addressFamily,
                prefix: afi === 2 ? `2001:db8:100:${index}::` : `198.51.100.${index}`,
                mask: afi === 2 ? 64 : 32,
                count: 1,
                nlriEncoding,
                attributeRules,
                nlriRules: [
                    ...(vpn
                        ? [
                              { type: 'rd', value: '65000:1' },
                              { type: 'label', value: 16000 }
                          ]
                        : []),
                    ...(vpn || afi === 2 || nlriEncoding === 'mpReach'
                        ? [{ type: 'mpNextHop', mode: 'fixed', value: session.localIp }]
                        : [])
                ],
                ...overrides
            };
            return vpn ? worker.generateVpnEvpnRoutes('generate', config) : worker.generateRoutes('generate', config);
        },
        packets() {
            return sent.map(buffer => {
                const packet = parseBgpPacket(buffer, { asnSize });
                assert.ok(packet.valid, packet.error);
                return packet;
            });
        }
    };
}

function asPaths(packet) {
    const attributes = packet.pathAttributes.filter(item => item.typeCode === type.AS_PATH);
    assert.ok(attributes.length, 'the configured AS Path node must be encoded');
    return attributes.map(attribute => attribute.segments.flatMap(segment => segment.asNumbers));
}

async function testOutboundPrepend() {
    for (const [addressFamily, encoding] of [
        [family.IPV4_UNC, 'auto'],
        [family.IPV4_UNC, 'mpReach'],
        [family.IPV6_UNC, 'auto'],
        [family.VPNV4, 'auto'],
        [family.VPNV6, 'auto']
    ]) {
        for (const [asnSize, localAs] of [
            [2, 65000],
            [4, 4200000000]
        ]) {
            const f = fixture(addressFamily, encoding, asnSize, localAs);
            try {
                let index = 0;
                for (const configuredPath of ['', '64512 64513', `${localAs} 64512`]) {
                    for (const prependLocalAs of [undefined, true, false]) {
                        const rule = { mode: 'fixed', value: configuredPath };
                        if (prependLocalAs !== undefined) rule.prependLocalAs = prependLocalAs;
                        f.sent.length = 0;
                        await f.generate(++index, rule);
                        assert.equal(f.sent.length, 1);
                        const inputPath = configuredPath ? configuredPath.split(' ').map(Number) : [];
                        const outboundPath = prependLocalAs === false ? inputPath : [localAs, ...inputPath];
                        assert.deepStrictEqual(asPaths(f.packets()[0]), [outboundPath]);
                        assert.equal(
                            f.packets()[0].pathAttributes.some(attribute => attribute.typeCode === type.MP_REACH_NLRI),
                            addressFamily !== family.IPV4_UNC || encoding === 'mpReach'
                        );
                        const route = Array.from(f.instance.routeMap.values()).at(-1);
                        const storedAttr = f.instance.getRouteAttr(route);
                        const descriptor = storedAttr.pathAttributes.find(entry => entry.type === 'asPath');
                        assert.equal(storedAttr.asPath, configuredPath);
                        assert.deepStrictEqual(descriptor, {
                            type: 'asPath',
                            value: configuredPath,
                            ...(prependLocalAs === false ? { prependLocalAs: false } : {})
                        });
                        const before = JSON.stringify(storedAttr);
                        for (const [outboundPeerType, expected] of [
                            [peerType.PEER_TYPE_EBGP, outboundPath],
                            [peerType.PEER_TYPE_IBGP, inputPath],
                            [peerType.PEER_TYPE_EBGP, outboundPath]
                        ]) {
                            f.session.peerType = outboundPeerType;
                            f.sent.length = 0;
                            f.peer.sendRouteBatchNow([route]);
                            assert.deepStrictEqual(asPaths(f.packets()[0]), [expected]);
                        }
                        f.session.localAs = localAs + 1;
                        f.sent.length = 0;
                        f.peer.sendRouteBatchNow([route]);
                        assert.deepStrictEqual(asPaths(f.packets()[0]), [
                            prependLocalAs === false ? inputPath : [localAs + 1, ...inputPath]
                        ]);
                        assert.equal(JSON.stringify(f.instance.getRouteAttr(route)), before);
                        f.session.localAs = localAs;
                    }
                }
            } finally {
                f.store.close();
            }
        }
    }
}

async function testPersistenceAndCustomBytes() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-ebgp-local-as-'));
    let f;
    try {
        const dbPath = path.join(directory, 'routes.sqlite');
        f = fixture(family.IPV4_UNC, 'mpReach', 4, 65000, dbPath);
        await f.generate(1, { mode: 'fixed', value: '64512 64513' });
        await f.generate(2, { mode: 'fixed', value: '64512 64513', prependLocalAs: false });
        assert.notStrictEqual(...Array.from(f.instance.routeMap.values()).map(route => route.attrId));
        const stored = Array.from(f.instance.routeMap.values()).map(route => f.instance.getRouteAttr(route));
        f.store.close();
        f = fixture(family.IPV4_UNC, 'mpReach', 4, 65001, dbPath);
        const routes = Array.from(f.instance.routeMap.values());
        assert.deepStrictEqual(
            routes.map(route => f.instance.getRouteAttr(route)),
            stored
        );
        f.peer.sendRoute();
        assert.deepStrictEqual(f.packets().map(asPaths), [[[65001, 64512, 64513]], [[64512, 64513]]]);
        f.sent.length = 0;
        await f.generate(3, undefined, {
            attributeRules: [
                { type: 'origin', value: 0 },
                { type: 'custom', typeCode: type.AS_PATH, flags: 64, value: '02010000fde9' }
            ]
        });
        assert.deepStrictEqual(asPaths(f.packets()[0]), [[65001]], 'custom raw AS_PATH bytes must remain exact');
    } finally {
        f?.store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function testNodeIndependenceAndRegeneration() {
    const f = fixture(family.IPV4_UNC, 'mpReach', 4, 65000);
    try {
        await f.generate(1, undefined, {
            attributeRules: [
                { type: 'origin', value: 0 },
                { type: 'asPath', value: '64512', prependLocalAs: false },
                { type: 'med', value: 7 },
                { type: 'asPath', mode: 'list', values: ['64513'], prependLocalAs: true },
                {
                    type: 'asPath',
                    mode: 'random',
                    min: 64514,
                    max: 64514,
                    minLength: 1,
                    maxLength: 1,
                    prependLocalAs: false
                },
                { type: 'asPath', mode: 'increment', start: 64515, step: 1, prependLocalAs: true },
                { type: 'asPath', value: '', prependLocalAs: false }
            ]
        });
        assert.deepStrictEqual(asPaths(f.packets()[0]), [[64512], [65000, 64513], [64514], [65000, 64515], []]);
        assert.deepStrictEqual(
            f.packets()[0].pathAttributes.map(attribute => attribute.typeCode),
            [1, 2, 4, 2, 2, 2, 2, 14],
            'each repeated AS Path node must keep its setting and position'
        );
        const toggle = prependLocalAs =>
            f.generate(
                42,
                { mode: 'fixed', value: '64512', ...(prependLocalAs === undefined ? {} : { prependLocalAs }) },
                { groupId: 'toggle' }
            );
        const current = () => Array.from(f.instance.routeMap.values()).find(route => route.ip === '198.51.100.42');
        f.sent.length = 0;
        await toggle(false);
        const disabledAttrId = current().attrId;
        assert.deepStrictEqual(asPaths(f.packets().at(-1)), [[64512]]);
        f.sent.length = 0;
        await toggle(true);
        const enabledAttrId = current().attrId;
        assert.notEqual(enabledAttrId, disabledAttrId, 'changing the node switch must update attribute identity');
        assert.deepStrictEqual(asPaths(f.packets().at(-1)), [[65000, 64512]]);
        await toggle(undefined);
        assert.equal(current().attrId, enabledAttrId, 'missing and true flags must preserve the same default hash');
        f.sent.length = 0;
        await toggle(false);
        assert.equal(current().attrId, disabledAttrId);
        assert.deepStrictEqual(asPaths(f.packets().at(-1)), [[64512]]);
    } finally {
        f.store.close();
    }
}

async function main() {
    await testOutboundPrepend();
    await testPersistenceAndCustomBytes();
    await testNodeIndependenceAndRegeneration();
    console.log(
        'Per-node eBGP local AS prepend, defaults/overrides, ASN widths, immutable replay and regeneration passed'
    );
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
