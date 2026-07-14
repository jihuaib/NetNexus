const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BgpConst = require('../../electron/const/bgpConst');
const { parseBgpPacket } = require('../../electron/utils/bgpPacketParser');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const {
    buildRouteUpsertMutation,
    buildRouteWithdrawMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');

const AFI = BgpConst.BGP_AFI_TYPE;
const SAFI = BgpConst.BGP_SAFI_TYPE;
const RIB_TYPE = 1;

function u16(value) {
    return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u24(value) {
    return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
    return Buffer.from([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function ipBytes(address) {
    return Buffer.from(address.split('.').map(part => Number(part)));
}

function ipv6Bytes(address) {
    return Buffer.from(address.replace(/:/g, ''), 'hex');
}

function pathAttr(typeCode, value, flags = BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL) {
    return Buffer.concat([Buffer.from([flags, typeCode, value.length]), value]);
}

function updatePacket(attributes) {
    const attributeBytes = Buffer.concat(attributes);
    const body = Buffer.concat([u16(0), u16(attributeBytes.length), attributeBytes]);
    return Buffer.concat([
        Buffer.alloc(BgpConst.BGP_MARKER_LEN, 0xff),
        u16(BgpConst.BGP_HEAD_LEN + body.length),
        Buffer.from([BgpConst.BGP_PACKET_TYPE.UPDATE]),
        body
    ]);
}

function addPathContext(afi, safi) {
    return {
        getAddPathReceiveInfo(queryAfi, querySafi) {
            return { enabled: Number(queryAfi) === Number(afi) && Number(querySafi) === Number(safi) };
        }
    };
}

function parseNlriPair({ afi, safi, nlri, withdrawNlri = nlri, nextHop = Buffer.alloc(0), pathId, extraAttrs = [] }) {
    const context = pathId === undefined ? undefined : addPathContext(afi, safi);
    const reachNlri = pathId === undefined ? nlri : Buffer.concat([u32(pathId), nlri]);
    const unreachNlri = pathId === undefined ? withdrawNlri : Buffer.concat([u32(pathId), withdrawNlri]);
    const reachValue = Buffer.concat([
        u16(afi),
        Buffer.from([safi, nextHop.length]),
        nextHop,
        Buffer.from([0]),
        reachNlri
    ]);
    const unreachValue = Buffer.concat([u16(afi), Buffer.from([safi]), unreachNlri]);
    const reachPacket = parseBgpPacket(
        updatePacket([pathAttr(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI, reachValue), ...extraAttrs]),
        context
    );
    const unreachPacket = parseBgpPacket(
        updatePacket([pathAttr(BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI, unreachValue)]),
        context
    );

    assert.equal(reachPacket.valid, true, reachPacket.error || 'MP_REACH must parse');
    assert.equal(unreachPacket.valid, true, unreachPacket.error || 'MP_UNREACH must parse');
    const announced = reachPacket.pathAttributes.find(attr => attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI)
        .mpReach.nlri[0];
    const withdrawn = unreachPacket.pathAttributes.find(
        attr => attr.typeCode === BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI
    ).mpUnreach.withdrawnRoutes[0];
    assert.ok(announced, 'MP_REACH must contain one route');
    assert.ok(withdrawn, 'MP_UNREACH must contain one route');
    if (pathId !== undefined) {
        assert.equal(announced.pathId, pathId);
        assert.equal(withdrawn.pathId, pathId);
    }
    return { announced, withdrawn };
}

function ipv4Prefix(prefixLength, address) {
    return Buffer.concat([Buffer.from([prefixLength]), ipBytes(address).subarray(0, Math.ceil(prefixLength / 8))]);
}

function ipv6Prefix(prefixLength, address) {
    return Buffer.concat([Buffer.from([prefixLength]), ipv6Bytes(address).subarray(0, Math.ceil(prefixLength / 8))]);
}

function mplsLabel(label) {
    return u24((label << 4) | 1);
}

const rd65000 = Buffer.from([0, 0, 0xfd, 0xe8, 0, 0, 0, 1]);

function vpnNlri(prefixLength, prefixBytes, label = 200) {
    return Buffer.concat([
        Buffer.from([24 + 8 * rd65000.length + prefixLength]),
        mplsLabel(label),
        rd65000,
        prefixBytes
    ]);
}

function vpnWithdrawNlri(prefixLength, prefixBytes) {
    return Buffer.concat([Buffer.from([24 + 8 * rd65000.length + prefixLength, 0x80, 0, 0]), rd65000, prefixBytes]);
}

function evpnNlri(routeType, body) {
    return Buffer.concat([Buffer.from([routeType, body.length]), body]);
}

function encapsulationExtCommunity(tunnelType) {
    return pathAttr(
        BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES,
        Buffer.concat([Buffer.from([0x03, 0x0c, 0, 0, 0, 0]), u16(tunnelType)]),
        BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
    );
}

function pmsiTunnelAttr(tunnelType, raw24, tunnelIdentifier = Buffer.alloc(0)) {
    return pathAttr(
        BgpConst.BGP_PATH_ATTR.PMSI_TUNNEL,
        Buffer.concat([Buffer.from([0, tunnelType]), u24(raw24), tunnelIdentifier]),
        BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
    );
}

function tlv(type, value) {
    return Buffer.concat([u16(type), u16(value.length), value]);
}

function makeRoute(nlri, afi, safi) {
    const route = new BmpBgpRoute(null, null);
    const pathId = BmpBgpRoute.normalizePathId(nlri.pathId);
    const rd = BmpBgpRoute.normalizeRd(nlri.rd);
    Object.assign(route, {
        pathId,
        rd,
        rdRaw: nlri.rdRaw || null,
        ip: nlri.displayPrefix || nlri.prefix,
        mask: nlri.length,
        afi,
        safi,
        ribType: RIB_TYPE,
        routeType: nlri.routeType ?? null,
        nlriDetail: { ...nlri, pathId, rd },
        parseStatus: BmpBgpRoute.makeParseStatus(nlri.valid !== false, nlri.errors, nlri.warnings)
    });
    route.assignRouteAttr({ origin: 'IGP', asPath: '65000', nextHop: '192.0.2.254', localPref: 100 });
    route.markActive(0);
    return route;
}

const cases = [
    {
        name: 'IPv4 unicast',
        afi: AFI.AFI_IPV4,
        safi: SAFI.SAFI_UNICAST,
        pair: parseNlriPair({
            afi: AFI.AFI_IPV4,
            safi: SAFI.SAFI_UNICAST,
            nlri: ipv4Prefix(24, '203.0.113.0'),
            nextHop: ipBytes('192.0.2.1')
        })
    },
    {
        name: 'IPv6 unicast',
        afi: AFI.AFI_IPV6,
        safi: SAFI.SAFI_UNICAST,
        pair: parseNlriPair({
            afi: AFI.AFI_IPV6,
            safi: SAFI.SAFI_UNICAST,
            nlri: ipv6Prefix(64, '20010db8000100020000000000000000'),
            nextHop: ipv6Bytes('20010db8000000000000000000000001')
        })
    },
    {
        name: 'IPv4 multicast ADD-PATH',
        afi: AFI.AFI_IPV4,
        safi: SAFI.SAFI_MULTICAST,
        pathId: 434343,
        pair: parseNlriPair({
            afi: AFI.AFI_IPV4,
            safi: SAFI.SAFI_MULTICAST,
            nlri: ipv4Prefix(24, '239.1.2.0'),
            nextHop: ipBytes('192.0.2.2'),
            pathId: 434343
        })
    },
    {
        name: 'IPv6 multicast',
        afi: AFI.AFI_IPV6,
        safi: SAFI.SAFI_MULTICAST,
        pair: parseNlriPair({
            afi: AFI.AFI_IPV6,
            safi: SAFI.SAFI_MULTICAST,
            nlri: ipv6Prefix(64, 'ff3e004020010db80000000000000000'),
            nextHop: ipv6Bytes('20010db8000000000000000000000002')
        })
    },
    {
        name: 'IPv4 ADD-PATH',
        afi: AFI.AFI_IPV4,
        safi: SAFI.SAFI_UNICAST,
        pathId: 424242,
        pair: parseNlriPair({
            afi: AFI.AFI_IPV4,
            safi: SAFI.SAFI_UNICAST,
            nlri: ipv4Prefix(24, '198.51.100.0'),
            nextHop: ipBytes('192.0.2.1'),
            pathId: 424242
        })
    },
    {
        name: 'VPNv4',
        afi: AFI.AFI_IPV4,
        safi: SAFI.SAFI_VPN,
        pair: parseNlriPair({
            afi: AFI.AFI_IPV4,
            safi: SAFI.SAFI_VPN,
            nlri: vpnNlri(24, ipBytes('10.20.30.0').subarray(0, 3)),
            withdrawNlri: vpnWithdrawNlri(24, ipBytes('10.20.30.0').subarray(0, 3)),
            nextHop: Buffer.concat([rd65000, ipBytes('192.0.2.254')])
        })
    },
    {
        name: 'EVPN tunnel encapsulation',
        afi: AFI.AFI_L2VPN,
        safi: SAFI.SAFI_EVPN,
        pair: parseNlriPair({
            afi: AFI.AFI_L2VPN,
            safi: SAFI.SAFI_EVPN,
            nlri: evpnNlri(
                2,
                Buffer.concat([
                    rd65000,
                    Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
                    u32(100),
                    Buffer.from([48, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 32, 192, 0, 2, 10]),
                    u24(10000)
                ])
            ),
            nextHop: ipBytes('192.0.2.1'),
            extraAttrs: [encapsulationExtCommunity(8)]
        }),
        assertParserDifference(pair) {
            assert.equal(pair.announced.encapsulationType, 'vni');
            assert.equal(pair.withdrawn.encapsulationType, undefined);
        }
    },
    {
        name: 'EVPN PMSI tunnel',
        afi: AFI.AFI_L2VPN,
        safi: SAFI.SAFI_EVPN,
        pair: parseNlriPair({
            afi: AFI.AFI_L2VPN,
            safi: SAFI.SAFI_EVPN,
            nlri: evpnNlri(3, Buffer.concat([rd65000, u32(200), Buffer.from([32, 10, 0, 0, 3])])),
            nextHop: ipBytes('192.0.2.1'),
            extraAttrs: [encapsulationExtCommunity(8), pmsiTunnelAttr(6, 20000, Buffer.from([10, 0, 0, 3]))]
        }),
        assertParserDifference(pair) {
            assert.equal(pair.announced.encapsulationType, 'vni');
            assert.ok(pair.announced.pmsiTunnel);
            assert.equal(pair.withdrawn.pmsiTunnel, undefined);
        }
    },
    {
        name: 'IPv4 FlowSpec',
        afi: AFI.AFI_IPV4,
        safi: SAFI.SAFI_FLOW_SPEC,
        pair: parseNlriPair({
            afi: AFI.AFI_IPV4,
            safi: SAFI.SAFI_FLOW_SPEC,
            nlri: Buffer.from([5, 1, 24, 192, 0, 2])
        })
    },
    {
        name: 'BGP-LS',
        afi: AFI.AFI_BGP_LS,
        safi: SAFI.SAFI_BGP_LS,
        pair: (() => {
            const nodeDescriptor = tlv(256, tlv(512, u32(65000)));
            const reachability = tlv(265, Buffer.from([24, 203, 0, 113]));
            const body = Buffer.concat([
                Buffer.from([3]),
                Buffer.from('0000000000000001', 'hex'),
                nodeDescriptor,
                reachability
            ]);
            const nlri = Buffer.concat([u16(3), u16(body.length), body]);
            return parseNlriPair({ afi: AFI.AFI_BGP_LS, safi: SAFI.SAFI_BGP_LS, nlri });
        })()
    }
];

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-withdraw-identity-'));
const store = new BmpPersistenceStore({ dbPath: path.join(tempDir, 'bmp.sqlite3') });
const bmpSession = {
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '192.0.2.10',
    remotePort: 50000,
    sysName: 'withdraw-identity-router'
};
const owner = {
    sessionType: 0,
    sessionRd: '0:0',
    sessionRdRaw: 'raw:0000000000000000',
    sessionIp: '198.51.100.1',
    sessionAs: 65000,
    vrfTableNames: ['identity-test'],
    getRibEpoch() {
        return 0;
    }
};

function batch(batchId, mutations) {
    return { batchId, createdAtMs: Date.now(), mutations };
}

try {
    store.open();
    cases.forEach((fixture, index) => {
        fixture.assertParserDifference?.(fixture.pair);
        const route = makeRoute(fixture.pair.announced, fixture.afi, fixture.safi);
        const announce = buildRouteUpsertMutation(bmpSession, owner, route, fixture.afi, fixture.safi, RIB_TYPE, {
            kind: 'peer',
            scopeState: 'syncing'
        });
        const withdraw = buildRouteWithdrawMutation(
            bmpSession,
            owner,
            fixture.pair.withdrawn,
            null,
            fixture.afi,
            fixture.safi,
            RIB_TYPE,
            { kind: 'peer', state: 'syncing' }
        );

        assert.equal(withdraw.route.id, announce.route.id, `${fixture.name}: announce/withdraw route IDs must match`);
        assert.equal(
            withdraw.route.identityJson,
            announce.route.identityJson,
            `${fixture.name}: identities must match`
        );
        assert.equal(
            withdraw.reason,
            null,
            `${fixture.name}: a DB-backed withdraw must not pre-claim the route is missing`
        );

        const announceResult = store.applyBatch(batch(`withdraw-identity-${index}-announce`, [announce]));
        assert.equal(announceResult.deltas[0].classification, 'announce', `${fixture.name}: announce classification`);
        assert.equal(store.queryRoutes({ scopeId: announce.scope.id, routeId: announce.route.id }).total, 1);

        if (fixture.pathId !== undefined) {
            const wrongPathWithdraw = buildRouteWithdrawMutation(
                bmpSession,
                owner,
                { ...fixture.pair.withdrawn, pathId: fixture.pathId + 1 },
                null,
                fixture.afi,
                fixture.safi,
                RIB_TYPE,
                { kind: 'peer', state: 'syncing' }
            );
            assert.notEqual(wrongPathWithdraw.route.id, announce.route.id, 'ADD-PATH IDs must isolate paths');
            const wrongResult = store.applyBatch(batch(`withdraw-identity-${index}-wrong-path`, [wrongPathWithdraw]));
            assert.equal(wrongResult.deltas[0].classification, 'withdraw-noop');
            assert.equal(store.queryRoutes({ scopeId: announce.scope.id, routeId: announce.route.id }).total, 1);
        }

        const withdrawResult = store.applyBatch(batch(`withdraw-identity-${index}-withdraw`, [withdraw]));
        assert.equal(withdrawResult.deltas[0].classification, 'withdraw', `${fixture.name}: withdraw classification`);
        assert.equal(
            withdrawResult.deltas[0].projectionChanged,
            true,
            `${fixture.name}: withdraw must change projection`
        );
        assert.equal(withdrawResult.deltas[0].current, null, `${fixture.name}: current delta must be empty`);
        assert.equal(
            store.queryRoutes({ scopeId: announce.scope.id, routeId: announce.route.id }).total,
            0,
            `${fixture.name}: SQLite current route must be deleted`
        );

        const eventResult = store.queryEvents({
            scopeId: announce.scope.id,
            routeId: announce.route.id,
            eventType: 'withdraw',
            pageSize: 10
        });
        assert.equal(eventResult.total, 1, `${fixture.name}: one successful withdraw event must be committed`);
        assert.equal(eventResult.list[0].eventType, 'withdraw');
        assert.equal(eventResult.list[0].reason, null);
    });

    assert.equal(store.queryRoutes({ pageSize: 100 }).total, 0, 'all announced routes must be withdrawn');
    console.log(`BMP persistence withdrawal identity tests passed (${cases.length} NLRI cases)`);
} finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
