const assert = require('assert');
const { parseBgpPacket: parsePacketTree } = require('../../electron/pktParser/bgpPacketParser');
const { parseBgpPacket: parsePacketObject, getBgpPacketSummary } = require('../../electron/utils/bgpPacketParser');
const BgpConst = require('../../electron/const/bgpConst');
const { getAddrFamilyType, getAfiAndSafi } = require('../../electron/utils/bgpUtils');

function u16(value) {
    return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function u24(value) {
    return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function u32(value) {
    return Buffer.from([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function ipBytes(ipAddress) {
    return Buffer.from(ipAddress.split('.').map(part => parseInt(part, 10)));
}

function ipv6Bytes(hex) {
    return Buffer.from(hex.replace(/:/g, ''), 'hex');
}

function ipv4MappedIpv6Bytes(ipAddress) {
    return Buffer.concat([Buffer.alloc(10), Buffer.from([0xff, 0xff]), ipBytes(ipAddress)]);
}

function bgpPacket(type, body = Buffer.alloc(0)) {
    return Buffer.concat([
        Buffer.alloc(BgpConst.BGP_MARKER_LEN, 0xff),
        u16(BgpConst.BGP_HEAD_LEN + body.length),
        Buffer.from([type]),
        body
    ]);
}

function pathAttr(typeCode, value, flags = BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL) {
    if (value.length > 255) {
        return Buffer.concat([
            Buffer.from([flags | BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH, typeCode]),
            u16(value.length),
            value
        ]);
    }
    return Buffer.concat([Buffer.from([flags, typeCode, value.length]), value]);
}

function updatePacket(attrs, nlri = Buffer.alloc(0), withdrawnRoutes = Buffer.alloc(0)) {
    const attrBuffer = Buffer.concat(attrs);
    return bgpPacket(
        BgpConst.BGP_PACKET_TYPE.UPDATE,
        Buffer.concat([u16(withdrawnRoutes.length), withdrawnRoutes, u16(attrBuffer.length), attrBuffer, nlri])
    );
}

function mpReachUpdate(afi, safi, nextHop, nlri) {
    return updatePacket([
        pathAttr(
            BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI,
            Buffer.concat([u16(afi), Buffer.from([safi, nextHop.length]), nextHop, Buffer.from([0]), nlri])
        )
    ]);
}

function mpUnreachUpdate(afi, safi, nlri) {
    return updatePacket([
        pathAttr(BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI, Buffer.concat([u16(afi), Buffer.from([safi]), nlri]))
    ]);
}

function addPathContextFor(afi, safi) {
    return {
        getAddPathReceiveInfo(queryAfi, querySafi) {
            return {
                enabled: Number(queryAfi) === Number(afi) && Number(querySafi) === Number(safi)
            };
        }
    };
}

function addPathNlri(pathId, nlri) {
    return Buffer.concat([u32(pathId), nlri]);
}

function ipv4Prefix(prefixLength, ipAddress) {
    return Buffer.concat([Buffer.from([prefixLength]), ipBytes(ipAddress).subarray(0, Math.ceil(prefixLength / 8))]);
}

function ipv6Prefix(prefixLength, hexAddress) {
    return Buffer.concat([Buffer.from([prefixLength]), ipv6Bytes(hexAddress).subarray(0, Math.ceil(prefixLength / 8))]);
}

function mplsLabel(label, bottom = true) {
    return u24((label << 4) | (bottom ? 1 : 0));
}

function labeledUnicastNlri(prefixLength, prefixBytes, label = 100) {
    return Buffer.concat([Buffer.from([24 + prefixLength]), mplsLabel(label), prefixBytes]);
}

function labeledUnicastWithdrawNlri(prefixLength, prefixBytes) {
    return Buffer.concat([Buffer.from([24 + prefixLength, 0, 0, 0]), prefixBytes]);
}

function vpnNlri(prefixLength, prefixBytes, label = 200) {
    return Buffer.concat([
        Buffer.from([24 + BgpConst.BGP_RD_LEN * 8 + prefixLength]),
        mplsLabel(label),
        rd65000,
        prefixBytes
    ]);
}

function vpnWithdrawNlri(prefixLength, prefixBytes) {
    return Buffer.concat([
        Buffer.from([24 + BgpConst.BGP_RD_LEN * 8 + prefixLength, 0x80, 0, 0]),
        rd65000,
        prefixBytes
    ]);
}

function evpnNlri(routeType, body) {
    return Buffer.concat([Buffer.from([routeType, body.length]), body]);
}

function evpnRaw24(value) {
    return u24(value);
}

function evpnIpField(ipAddress) {
    return Buffer.concat([Buffer.from([BgpConst.IP_HOST_LEN]), ipBytes(ipAddress)]);
}

function flowSpecNlri(components) {
    const body = Buffer.concat(components);
    assert.ok(body.length < 240, 'test FlowSpec helper only emits one-byte lengths');
    return Buffer.concat([Buffer.from([body.length]), body]);
}

function flowSpecPrefixComponent(type, prefixLength, ipAddress, afi) {
    if (afi === BgpConst.BGP_AFI_TYPE.AFI_IPV6) {
        return Buffer.concat([
            Buffer.from([type, prefixLength, 0]),
            ipv6Bytes(ipAddress).subarray(0, Math.ceil(prefixLength / 8))
        ]);
    }
    return Buffer.concat([
        Buffer.from([type, prefixLength]),
        ipBytes(ipAddress).subarray(0, Math.ceil(prefixLength / 8))
    ]);
}

function flowSpecOp1Component(type, operator, value) {
    return Buffer.from([type, operator, value]);
}

function qpNlri(prefixLength, prefixBytes, dqpn, dqpnBitLength = 16) {
    const dqpnBytes = dqpnBitLength === 8 ? Buffer.from([dqpn]) : u16(dqpn);
    const body = Buffer.concat([
        Buffer.from([1, dqpnBitLength]),
        dqpnBytes,
        Buffer.from([2, prefixLength]),
        prefixBytes
    ]);
    return Buffer.concat([Buffer.from([body.length]), body]);
}

function mvpnNlri(routeType, value) {
    return Buffer.concat([Buffer.from([routeType, value.length]), value]);
}

function tlv(type, value) {
    return Buffer.concat([u16(type), u16(value.length), value]);
}

function bgpLsNlri(type, body) {
    return Buffer.concat([u16(type), u16(body.length), body]);
}

function bgpLsBody(protocolId, tlvs) {
    return Buffer.concat([Buffer.from([protocolId]), Buffer.from('0000000000000001', 'hex'), ...tlvs]);
}

function walk(node, predicate) {
    if (predicate(node)) {
        return node;
    }
    for (const child of node.children || []) {
        const result = walk(child, predicate);
        if (result) {
            return result;
        }
    }
    return null;
}

function findNode(tree, predicate) {
    return walk(tree, predicate);
}

function findNodeByName(tree, name) {
    return findNode(tree, node => node.name === name);
}

function parseTree(packet) {
    const tree = {
        name: `Packet ${packet.length} bytes`,
        offset: 0,
        length: packet.length,
        value: '',
        children: []
    };
    const result = parsePacketTree(packet, tree);
    assert.equal(result.valid, true, result.error);
    return tree;
}

function assertTreeFamily(packet, fixture, direction) {
    const tree = parseTree(packet);
    const bgpNode = findNodeByName(tree, 'BGP Packet');
    assert.ok(bgpNode, `${fixture.name} ${direction} tree should contain BGP Packet`);

    const attrNodeName = direction === 'reach' ? 'MP_REACH_NLRI' : 'MP_UNREACH_NLRI';
    const attrNode = findNodeByName(bgpNode, attrNodeName);
    assert.ok(attrNode, `${fixture.name} ${direction} tree should contain ${attrNodeName}`);
    assert.ok(String(findNodeByName(attrNode, 'AFI').value).startsWith(`${fixture.afi} (`), `${fixture.name} AFI`);
    assert.ok(String(findNodeByName(attrNode, 'SAFI').value).startsWith(`${fixture.safi} (`), `${fixture.name} SAFI`);

    if (direction === 'reach') {
        assert.ok(findNodeByName(attrNode, 'Next Hop'), `${fixture.name} reach tree should contain Next Hop`);
        assert.ok(
            findNodeByName(attrNode, fixture.simpleTreeNlri ? 'NLRI' : 'NLRI Data'),
            `${fixture.name} reach tree should contain NLRI node`
        );
    } else {
        assert.ok(
            findNodeByName(attrNode, fixture.simpleTreeNlri ? 'Withdrawn Routes' : 'Withdrawn Routes Data'),
            `${fixture.name} unreach tree should contain withdrawn NLRI node`
        );
    }
}

function assertRouteValid(route, fixture, direction) {
    if (route.valid !== undefined) {
        assert.equal(
            route.valid,
            true,
            `${fixture.name} ${direction} route should be valid: ${(route.errors || []).join('; ')}`
        );
    }
}

function assertSummary(parsed, route, fixture, attrName, direction) {
    const summary = getBgpPacketSummary(parsed);
    assert.ok(summary.startsWith('BGP UPDATE Message'), `${fixture.name} ${direction} summary should be UPDATE`);
    assert.ok(summary.includes(attrName), `${fixture.name} ${direction} summary should include ${attrName}`);
    assert.ok(summary.includes('Routes:'), `${fixture.name} ${direction} summary should include route section`);
    assert.ok(summary.includes(route.prefix), `${fixture.name} ${direction} summary should include ${route.prefix}`);
}

function assertReach(fixture) {
    const packet = mpReachUpdate(fixture.afi, fixture.safi, fixture.nextHop, fixture.nlri);
    const parsed = parsePacketObject(packet);
    assert.equal(parsed.valid, true, parsed.error || `${fixture.name} MP_REACH should parse`);
    const attr = parsed.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI);
    assert.ok(attr, `${fixture.name} MP_REACH attribute should exist`);
    assert.equal(attr.mpReach.afi, fixture.afi);
    assert.equal(attr.mpReach.safi, fixture.safi);
    assert.equal(attr.mpReach.nlri.length, 1, `${fixture.name} MP_REACH should contain one NLRI`);
    assert.equal(getAddrFamilyType(attr.mpReach.afi, attr.mpReach.safi), fixture.family);
    const route = attr.mpReach.nlri[0];
    assertRouteValid(route, fixture, 'reach');
    fixture.assertReach(route, attr.mpReach);
    assertSummary(parsed, route, fixture, 'MP_REACH_NLRI', 'reach');
    assertTreeFamily(packet, fixture, 'reach');
}

function assertReachAddPath(fixture, pathId) {
    const packet = mpReachUpdate(fixture.afi, fixture.safi, fixture.nextHop, addPathNlri(pathId, fixture.nlri));
    const parsed = parsePacketObject(packet, addPathContextFor(fixture.afi, fixture.safi));
    assert.equal(parsed.valid, true, parsed.error || `${fixture.name} ADD-PATH MP_REACH should parse`);
    const attr = parsed.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI);
    assert.ok(attr, `${fixture.name} ADD-PATH MP_REACH attribute should exist`);
    assert.equal(attr.mpReach.afi, fixture.afi);
    assert.equal(attr.mpReach.safi, fixture.safi);
    assert.equal(attr.mpReach.nlri.length, 1, `${fixture.name} ADD-PATH MP_REACH should contain one NLRI`);
    assert.equal(getAddrFamilyType(attr.mpReach.afi, attr.mpReach.safi), fixture.family);
    const route = attr.mpReach.nlri[0];
    assert.equal(route.pathId, pathId, `${fixture.name} ADD-PATH MP_REACH should preserve path-id`);
    assertRouteValid(route, fixture, 'add-path reach');
    fixture.assertReach(route, attr.mpReach);
    assertSummary(parsed, route, fixture, 'MP_REACH_NLRI', 'add-path reach');
}

function assertUnreach(fixture) {
    const packet = mpUnreachUpdate(fixture.afi, fixture.safi, fixture.withdrawNlri || fixture.nlri);
    const parsed = parsePacketObject(packet);
    assert.equal(parsed.valid, true, parsed.error || `${fixture.name} MP_UNREACH should parse`);
    const attr = parsed.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI);
    assert.ok(attr, `${fixture.name} MP_UNREACH attribute should exist`);
    assert.equal(attr.mpUnreach.afi, fixture.afi);
    assert.equal(attr.mpUnreach.safi, fixture.safi);
    assert.equal(attr.mpUnreach.withdrawnRoutes.length, 1, `${fixture.name} MP_UNREACH should contain one NLRI`);
    assert.equal(getAddrFamilyType(attr.mpUnreach.afi, attr.mpUnreach.safi), fixture.family);
    const route = attr.mpUnreach.withdrawnRoutes[0];
    assertRouteValid(route, fixture, 'unreach');
    fixture.assertUnreach ? fixture.assertUnreach(route, attr.mpUnreach) : fixture.assertReach(route, attr.mpUnreach);
    assertSummary(parsed, route, fixture, 'MP_UNREACH_NLRI', 'unreach');
    assertTreeFamily(packet, fixture, 'unreach');
}

function assertUnreachAddPath(fixture, pathId) {
    const packet = mpUnreachUpdate(
        fixture.afi,
        fixture.safi,
        addPathNlri(pathId, fixture.withdrawNlri || fixture.nlri)
    );
    const parsed = parsePacketObject(packet, addPathContextFor(fixture.afi, fixture.safi));
    assert.equal(parsed.valid, true, parsed.error || `${fixture.name} ADD-PATH MP_UNREACH should parse`);
    const attr = parsed.pathAttributes.find(item => item.typeCode === BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI);
    assert.ok(attr, `${fixture.name} ADD-PATH MP_UNREACH attribute should exist`);
    assert.equal(attr.mpUnreach.afi, fixture.afi);
    assert.equal(attr.mpUnreach.safi, fixture.safi);
    assert.equal(
        attr.mpUnreach.withdrawnRoutes.length,
        1,
        `${fixture.name} ADD-PATH MP_UNREACH should contain one NLRI`
    );
    assert.equal(getAddrFamilyType(attr.mpUnreach.afi, attr.mpUnreach.safi), fixture.family);
    const route = attr.mpUnreach.withdrawnRoutes[0];
    assert.equal(route.pathId, pathId, `${fixture.name} ADD-PATH MP_UNREACH should preserve path-id`);
    assertRouteValid(route, fixture, 'add-path unreach');
    fixture.assertUnreach ? fixture.assertUnreach(route, attr.mpUnreach) : fixture.assertReach(route, attr.mpUnreach);
    assertSummary(parsed, route, fixture, 'MP_UNREACH_NLRI', 'add-path unreach');
}

function withAfiSafi(fixture) {
    const { afi, safi } = getAfiAndSafi(fixture.family);
    return {
        ...fixture,
        afi,
        safi
    };
}

const rd65000 = Buffer.from([0, 0, 0xfd, 0xe8, 0, 0, 0, 1]);
const esi = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const bgpLsNodeDescriptor = tlv(256, tlv(512, u32(65000)));
const bgpLsIpv4Reachability = tlv(265, Buffer.from([24, 203, 0, 113]));

const fixtures = [
    withAfiSafi({
        name: 'IPV4_UNC',
        family: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
        nextHop: ipBytes('192.0.2.1'),
        nlri: ipv4Prefix(24, '203.0.113.0'),
        simpleTreeNlri: true,
        assertReach(route, mpReach) {
            assert.equal(mpReach.nextHop, '192.0.2.1');
            assert.equal(route.prefix, '203.0.113.0');
            assert.equal(route.length, 24);
        },
        assertUnreach(route) {
            assert.equal(route.prefix, '203.0.113.0');
            assert.equal(route.length, 24);
        }
    }),
    withAfiSafi({
        name: 'IPV6_UNC',
        family: BgpConst.BGP_ADDR_FAMILY.IPV6_UNC,
        nextHop: ipv6Bytes('20010db8000000000000000000000001'),
        nlri: ipv6Prefix(48, '20010db8000100000000000000000000'),
        simpleTreeNlri: true,
        assertReach(route, mpReach) {
            assert.equal(mpReach.nextHop, '2001:db8::1');
            assert.equal(route.prefix, '2001:db8:1::');
            assert.equal(route.length, 48);
        },
        assertUnreach(route) {
            assert.equal(route.prefix, '2001:db8:1::');
            assert.equal(route.length, 48);
        }
    }),
    withAfiSafi({
        name: 'IPV4_MULTICAST',
        family: BgpConst.BGP_ADDR_FAMILY.IPV4_MULTICAST,
        nextHop: ipBytes('192.0.2.2'),
        nlri: ipv4Prefix(24, '198.51.100.0'),
        simpleTreeNlri: true,
        assertReach(route, mpReach) {
            assert.equal(mpReach.nextHop, '192.0.2.2');
            assert.equal(route.prefix, '198.51.100.0');
            assert.equal(route.length, 24);
        },
        assertUnreach(route) {
            assert.equal(route.prefix, '198.51.100.0');
            assert.equal(route.length, 24);
        }
    }),
    withAfiSafi({
        name: 'IPV6_MULTICAST',
        family: BgpConst.BGP_ADDR_FAMILY.IPV6_MULTICAST,
        nextHop: ipv6Bytes('20010db8000000000000000000000002'),
        nlri: ipv6Prefix(48, '20010db8000200000000000000000000'),
        simpleTreeNlri: true,
        assertReach(route, mpReach) {
            assert.equal(mpReach.nextHop, '2001:db8::2');
            assert.equal(route.prefix, '2001:db8:2::');
            assert.equal(route.length, 48);
        },
        assertUnreach(route) {
            assert.equal(route.prefix, '2001:db8:2::');
            assert.equal(route.length, 48);
        }
    }),
    withAfiSafi({
        name: 'L2VPN_EVPN',
        family: BgpConst.BGP_ADDR_FAMILY.L2VPN_EVPN,
        nextHop: ipBytes('192.0.2.1'),
        nlri: evpnNlri(
            2,
            Buffer.concat([
                rd65000,
                esi,
                u32(100),
                Buffer.from([48]),
                Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
                Buffer.from([BgpConst.IP_HOST_LEN]),
                ipBytes('192.0.2.10'),
                evpnRaw24(10000)
            ])
        ),
        assertReach(route) {
            assert.equal(route.routeType, 2);
            assert.equal(route.macAddress, 'aa:bb:cc:dd:ee:ff');
            assert.equal(route.ipAddress, '192.0.2.10');
            assert.ok(route.prefix.includes('evpn:mac-ip:65000:1'));
        }
    }),
    withAfiSafi({
        name: 'VPNV4',
        family: BgpConst.BGP_ADDR_FAMILY.VPNV4,
        nextHop: Buffer.concat([rd65000, ipBytes('192.0.2.254')]),
        nlri: vpnNlri(24, ipBytes('203.0.113.0').subarray(0, 3), 200),
        withdrawNlri: vpnWithdrawNlri(24, ipBytes('203.0.113.0').subarray(0, 3)),
        assertReach(route, mpReach) {
            assert.equal(mpReach.nextHop, '192.0.2.254');
            assert.equal(route.rd, '65000:1');
            assert.equal(route.prefix, '203.0.113.0');
            assert.equal(route.labels[0].label, 200);
        },
        assertUnreach(route) {
            assert.equal(route.rd, '65000:1');
            assert.equal(route.prefix, '203.0.113.0');
            assert.equal(route.compatibilityField, '800000');
        }
    }),
    withAfiSafi({
        name: 'VPNV6',
        family: BgpConst.BGP_ADDR_FAMILY.VPNV6,
        nextHop: Buffer.concat([rd65000, ipv6Bytes('20010db8000000000000000000000001')]),
        nlri: vpnNlri(32, ipv6Bytes('20010db8000100000000000000000000').subarray(0, 4), 201),
        withdrawNlri: vpnWithdrawNlri(32, ipv6Bytes('20010db8000100000000000000000000').subarray(0, 4)),
        assertReach(route, mpReach) {
            assert.equal(mpReach.nextHop, '2001:db8::1');
            assert.equal(route.rd, '65000:1');
            assert.equal(route.prefix, '2001:db8::');
            assert.equal(route.labels[0].label, 201);
        },
        assertUnreach(route) {
            assert.equal(route.rd, '65000:1');
            assert.equal(route.prefix, '2001:db8::');
            assert.equal(route.compatibilityField, '800000');
        }
    }),
    withAfiSafi({
        name: 'IPV4_MVPN',
        family: BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN,
        nextHop: ipBytes('192.0.2.1'),
        nlri: mvpnNlri(BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD, Buffer.concat([rd65000, ipBytes('10.0.0.1')])),
        assertReach(route) {
            assert.equal(route.routeType, BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD);
            assert.equal(route.length, 12);
            assert.equal(route.rawNlri, Buffer.concat([rd65000, ipBytes('10.0.0.1')]).toString('hex'));
        }
    }),
    withAfiSafi({
        name: 'IPV6_MVPN',
        family: BgpConst.BGP_ADDR_FAMILY.IPV6_MVPN,
        nextHop: ipv6Bytes('20010db8000000000000000000000001'),
        nlri: mvpnNlri(
            BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD,
            Buffer.concat([rd65000, ipv6Bytes('20010db8000000000000000000000002')])
        ),
        assertReach(route) {
            assert.equal(route.routeType, BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD);
            assert.equal(route.length, 24);
            assert.equal(
                route.rawNlri,
                Buffer.concat([rd65000, ipv6Bytes('20010db8000000000000000000000002')]).toString('hex')
            );
        }
    }),
    withAfiSafi({
        name: 'IPV4_QP',
        family: BgpConst.BGP_ADDR_FAMILY.IPV4_QP,
        nextHop: ipBytes('192.0.2.254'),
        nlri: qpNlri(24, ipBytes('192.0.2.0').subarray(0, 3), 0x1234),
        assertReach(route, mpReach) {
            assert.equal(mpReach.nextHop, '192.0.2.254');
            assert.equal(route.prefix, '192.0.2.0');
            assert.equal(route.length, 24);
            assert.equal(route.dqpn, 0x1234);
            assert.equal(route.dqpnBits, 16);
        },
        assertUnreach(route) {
            assert.equal(route.prefix, '192.0.2.0');
            assert.equal(route.length, 24);
            assert.equal(route.dqpn, 0x1234);
            assert.equal(route.dqpnBits, 16);
        }
    }),
    withAfiSafi({
        name: 'IPV6_QP',
        family: BgpConst.BGP_ADDR_FAMILY.IPV6_QP,
        nextHop: ipv6Bytes('20010db8000000000000000000000001'),
        nlri: qpNlri(48, ipv6Bytes('20010db8000200000000000000000000').subarray(0, 6), 0x2345),
        assertReach(route, mpReach) {
            assert.equal(mpReach.nextHop, '2001:db8::1');
            assert.equal(route.prefix, '2001:db8:2::');
            assert.equal(route.length, 48);
            assert.equal(route.dqpn, 0x2345);
            assert.equal(route.dqpnBits, 16);
        },
        assertUnreach(route) {
            assert.equal(route.prefix, '2001:db8:2::');
            assert.equal(route.length, 48);
            assert.equal(route.dqpn, 0x2345);
            assert.equal(route.dqpnBits, 16);
        }
    }),
    withAfiSafi({
        name: 'IPV4_FLOWSPEC',
        family: BgpConst.BGP_ADDR_FAMILY.IPV4_FLOWSPEC,
        nextHop: Buffer.alloc(0),
        nlri: flowSpecNlri([
            flowSpecPrefixComponent(1, 32, '192.0.2.1', BgpConst.BGP_AFI_TYPE.AFI_IPV4),
            flowSpecOp1Component(12, 0x80, 0x05)
        ]),
        assertReach(route) {
            assert.equal(route.valid, true);
            assert.equal(route.length, 9);
            assert.ok(route.prefix.includes('dst=192.0.2.1/32'));
            assert.ok(route.prefix.includes('fragment any 5'));
        }
    }),
    withAfiSafi({
        name: 'IPV6_FLOWSPEC',
        family: BgpConst.BGP_ADDR_FAMILY.IPV6_FLOWSPEC,
        nextHop: Buffer.alloc(0),
        nlri: flowSpecNlri([
            flowSpecPrefixComponent(1, 32, '20010db8000000000000000000000000', BgpConst.BGP_AFI_TYPE.AFI_IPV6),
            flowSpecOp1Component(3, 0x81, 6)
        ]),
        assertReach(route) {
            assert.equal(route.valid, true);
            assert.equal(route.length, 10);
            assert.ok(route.prefix.includes('dst=2001:db8::/32'));
            assert.ok(route.prefix.includes('proto = 6'));
        }
    }),
    withAfiSafi({
        name: 'IPV4_LABEL_UNICAST',
        family: BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST,
        nextHop: ipBytes('192.0.2.1'),
        nlri: labeledUnicastNlri(24, ipBytes('203.0.113.0').subarray(0, 3), 300),
        withdrawNlri: labeledUnicastWithdrawNlri(24, ipBytes('203.0.113.0').subarray(0, 3)),
        assertReach(route) {
            assert.equal(route.prefix, '203.0.113.0');
            assert.equal(route.length, 24);
            assert.equal(route.labels[0].label, 300);
        },
        assertUnreach(route) {
            assert.equal(route.prefix, '203.0.113.0');
            assert.equal(route.length, 24);
            assert.equal(route.compatibilityField, '000000');
        }
    }),
    withAfiSafi({
        name: 'IPV6_LABEL_UNICAST',
        family: BgpConst.BGP_ADDR_FAMILY.IPV6_LABEL_UNICAST,
        nextHop: ipv6Bytes('20010db8000000000000000000000001'),
        nlri: labeledUnicastNlri(32, ipv6Bytes('20010db8000100000000000000000000').subarray(0, 4), 301),
        withdrawNlri: labeledUnicastWithdrawNlri(32, ipv6Bytes('20010db8000100000000000000000000').subarray(0, 4)),
        assertReach(route) {
            assert.equal(route.prefix, '2001:db8::');
            assert.equal(route.length, 32);
            assert.equal(route.labels[0].label, 301);
        },
        assertUnreach(route) {
            assert.equal(route.prefix, '2001:db8::');
            assert.equal(route.length, 32);
            assert.equal(route.compatibilityField, '000000');
        }
    }),
    withAfiSafi({
        name: 'LINK_STATE',
        family: BgpConst.BGP_ADDR_FAMILY.LINK_STATE,
        nextHop: Buffer.alloc(0),
        nlri: bgpLsNlri(3, bgpLsBody(3, [bgpLsNodeDescriptor, bgpLsIpv4Reachability])),
        assertReach(route) {
            assert.equal(route.valid, true);
            assert.equal(route.prefix, 'bgp-ls:IPv4 Prefix:203.0.113.0/24');
            assert.equal(route.length, 24);
            assert.equal(route.routeType, 3);
        }
    }),
    withAfiSafi({
        name: 'LINK_STATE_VPN',
        family: BgpConst.BGP_ADDR_FAMILY.LINK_STATE_VPN,
        nextHop: Buffer.alloc(0),
        nlri: bgpLsNlri(3, Buffer.concat([rd65000, bgpLsBody(3, [bgpLsNodeDescriptor, bgpLsIpv4Reachability])])),
        assertReach(route) {
            assert.equal(route.valid, true);
            assert.equal(route.prefix, 'bgp-ls-vpn:IPv4 Prefix:203.0.113.0/24');
            assert.equal(route.rd, '65000:1');
            assert.equal(route.vpn, true);
        }
    })
];

assert.deepEqual(
    fixtures.map(item => item.family).sort((a, b) => a - b),
    Object.values(BgpConst.BGP_ADDR_FAMILY).sort((a, b) => a - b),
    'address-family consistency fixtures must cover every BGP_ADDR_FAMILY value'
);

fixtures.forEach(fixture => {
    assertReach(fixture);
    assertUnreach(fixture);
    assertReachAddPath(fixture, 1000 + fixture.family);
    assertUnreachAddPath(fixture, 2000 + fixture.family);
});

const ipv4TopLevelAddPathPacket = updatePacket([], addPathNlri(3001, ipv4Prefix(24, '203.0.250.0')));
const ipv4TopLevelAddPathParsed = parsePacketObject(
    ipv4TopLevelAddPathPacket,
    addPathContextFor(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
);
assert.equal(ipv4TopLevelAddPathParsed.valid, true, ipv4TopLevelAddPathParsed.error);
assert.equal(ipv4TopLevelAddPathParsed.nlri.length, 1);
assert.deepEqual(
    {
        prefix: ipv4TopLevelAddPathParsed.nlri[0].prefix,
        length: ipv4TopLevelAddPathParsed.nlri[0].length,
        pathId: ipv4TopLevelAddPathParsed.nlri[0].pathId
    },
    {
        prefix: '203.0.250.0',
        length: 24,
        pathId: 3001
    },
    'top-level IPv4 unicast ADD-PATH NLRI should preserve path-id'
);

const ipv4TopLevelWithdrawAddPathPacket = updatePacket(
    [],
    Buffer.alloc(0),
    addPathNlri(3002, ipv4Prefix(24, '203.0.251.0'))
);
const ipv4TopLevelWithdrawAddPathParsed = parsePacketObject(
    ipv4TopLevelWithdrawAddPathPacket,
    addPathContextFor(BgpConst.BGP_AFI_TYPE.AFI_IPV4, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST)
);
assert.equal(ipv4TopLevelWithdrawAddPathParsed.valid, true, ipv4TopLevelWithdrawAddPathParsed.error);
assert.equal(ipv4TopLevelWithdrawAddPathParsed.withdrawnRoutes.length, 1);
assert.deepEqual(
    {
        prefix: ipv4TopLevelWithdrawAddPathParsed.withdrawnRoutes[0].prefix,
        length: ipv4TopLevelWithdrawAddPathParsed.withdrawnRoutes[0].length,
        pathId: ipv4TopLevelWithdrawAddPathParsed.withdrawnRoutes[0].pathId
    },
    {
        prefix: '203.0.251.0',
        length: 24,
        pathId: 3002
    },
    'top-level IPv4 unicast ADD-PATH withdrawn route should preserve path-id'
);

const sixPeFixture = withAfiSafi({
    name: 'IPV6_LABEL_UNICAST_6PE',
    family: BgpConst.BGP_ADDR_FAMILY.IPV6_LABEL_UNICAST,
    nextHop: ipv4MappedIpv6Bytes('192.0.2.250'),
    nlri: labeledUnicastNlri(64, ipv6Bytes('20010db8006000000000000000000000').subarray(0, 8), 401),
    withdrawNlri: labeledUnicastWithdrawNlri(64, ipv6Bytes('20010db8006000000000000000000000').subarray(0, 8)),
    assertReach(route, mpReach) {
        assert.equal(mpReach.nextHop, '::ffff:192.0.2.250');
        assert.equal(route.prefix, '2001:db8:60::');
        assert.equal(route.length, 64);
        assert.equal(route.labels[0].label, 401);
    },
    assertUnreach(route) {
        assert.equal(route.prefix, '2001:db8:60::');
        assert.equal(route.length, 64);
        assert.equal(route.compatibilityField, '000000');
    }
});
assertReach(sixPeFixture);
assertUnreach(sixPeFixture);
assertReachAddPath(sixPeFixture, 3013);
assertUnreachAddPath(sixPeFixture, 4013);

console.log('BGP packet parser address-family consistency tests passed');
