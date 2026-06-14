const assert = require('assert');
const { parseBgpPacket: parsePacketTree } = require('../../electron/pktParser/bgpPacketParser');
const { parseBgpPacket: parsePacketObject, getBgpPacketSummary } = require('../../electron/utils/bgpPacketParser');
const BgpConst = require('../../electron/const/bgpConst');

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

function bgpPacket(type, body = Buffer.alloc(0)) {
    return Buffer.concat([
        Buffer.alloc(BgpConst.BGP_MARKER_LEN, 0xff),
        u16(BgpConst.BGP_HEAD_LEN + body.length),
        Buffer.from([type]),
        body
    ]);
}

function capability(code, value = Buffer.alloc(0)) {
    return Buffer.concat([Buffer.from([code, value.length]), value]);
}

function openPacket(capabilities) {
    const capabilityBuffer = Buffer.concat(capabilities);
    const optionalParameters = Buffer.concat([
        Buffer.from([BgpConst.BGP_OPEN_OPT_TYPE.OPT_TYPE, capabilityBuffer.length]),
        capabilityBuffer
    ]);
    return bgpPacket(
        BgpConst.BGP_PACKET_TYPE.OPEN,
        Buffer.concat([
            Buffer.from([BgpConst.BGP_VERSION]),
            u16(65000),
            u16(90),
            ipBytes('192.0.2.1'),
            Buffer.from([optionalParameters.length]),
            optionalParameters
        ])
    );
}

function pathAttr(typeCode, value, flags = BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE) {
    if (value.length > 255) {
        return Buffer.concat([
            Buffer.from([flags | BgpConst.BGP_PATH_ATTR_FLAGS.EXTENDED_LENGTH, typeCode]),
            u16(value.length),
            value
        ]);
    }
    return Buffer.concat([Buffer.from([flags, typeCode, value.length]), value]);
}

function updatePacket(withdrawnRoutes, attrs, nlri = Buffer.alloc(0)) {
    const withdrawnRoutesBuffer = Buffer.concat(withdrawnRoutes);
    const attrBuffer = Buffer.concat(attrs);
    return bgpPacket(
        BgpConst.BGP_PACKET_TYPE.UPDATE,
        Buffer.concat([
            u16(withdrawnRoutesBuffer.length),
            withdrawnRoutesBuffer,
            u16(attrBuffer.length),
            attrBuffer,
            nlri
        ])
    );
}

function ipv4Prefix(prefixLength, ipAddress) {
    return Buffer.concat([Buffer.from([prefixLength]), ipBytes(ipAddress).subarray(0, Math.ceil(prefixLength / 8))]);
}

function ipv6Bytes(hex) {
    return Buffer.from(hex.replace(/:/g, ''), 'hex');
}

function mplsLabel(label, bottom = true) {
    return u24((label << 4) | (bottom ? 1 : 0));
}

function prefixSidSrv6ServiceAttr() {
    const sidStructure = Buffer.concat([Buffer.from([1]), u16(6), Buffer.from([48, 16, 16, 0, 0, 0])]);
    const sidInformationValue = Buffer.concat([
        Buffer.from([0]),
        ipv6Bytes('20010db80000000000000000000000aa'),
        Buffer.from([0]),
        u16(17),
        Buffer.from([0]),
        sidStructure
    ]);
    const sidInformation = Buffer.concat([Buffer.from([1]), u16(sidInformationValue.length), sidInformationValue]);
    const serviceTlvValue = Buffer.concat([Buffer.from([0]), sidInformation]);
    return Buffer.concat([Buffer.from([5]), u16(serviceTlvValue.length), serviceTlvValue]);
}

function prefixSidAttr() {
    const labelIndex = Buffer.concat([Buffer.from([1]), u16(7), Buffer.from([0]), u16(0), u32(16000)]);
    const originatorSrgb = Buffer.concat([Buffer.from([3]), u16(8), u16(0), u24(16000), u24(8000)]);
    return pathAttr(
        BgpConst.BGP_PATH_ATTR.PREFIX_SID,
        Buffer.concat([labelIndex, originatorSrgb, prefixSidSrv6ServiceAttr()]),
        BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
    );
}

function richUpdatePacket() {
    const mpReachValue = Buffer.concat([
        u16(BgpConst.BGP_AFI_TYPE.AFI_IPV6),
        Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST, BgpConst.IPV6_HOST_BYTE_LEN]),
        ipv6Bytes('20010db8000000000000000000000001'),
        Buffer.from([0]),
        Buffer.from([48]),
        ipv6Bytes('20010db8000100000000000000000000').subarray(0, 6)
    ]);
    const mpUnreachValue = Buffer.concat([
        u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
        Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST]),
        ipv4Prefix(24, '203.0.113.0')
    ]);

    return updatePacket(
        [ipv4Prefix(24, '198.51.100.0')],
        [
            pathAttr(BgpConst.BGP_PATH_ATTR.ORIGIN, Buffer.from([BgpConst.BGP_ORIGIN_TYPE.IGP])),
            pathAttr(
                BgpConst.BGP_PATH_ATTR.AS_PATH,
                Buffer.concat([Buffer.from([BgpConst.BGP_AS_PATH_TYPE.AS_SEQUENCE, 2]), u32(65000), u32(65001)])
            ),
            pathAttr(BgpConst.BGP_PATH_ATTR.NEXT_HOP, ipBytes('192.0.2.254')),
            pathAttr(BgpConst.BGP_PATH_ATTR.MED, u32(100), BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL),
            pathAttr(BgpConst.BGP_PATH_ATTR.LOCAL_PREF, u32(200)),
            pathAttr(BgpConst.BGP_PATH_ATTR.ATOMIC_AGGREGATE, Buffer.alloc(0)),
            pathAttr(BgpConst.BGP_PATH_ATTR.AGGREGATOR, Buffer.concat([u16(65000), ipBytes('192.0.2.2')])),
            pathAttr(BgpConst.BGP_PATH_ATTR.COMMUNITY, Buffer.concat([u16(65000), u16(100), u16(65535), u16(65281)])),
            pathAttr(BgpConst.BGP_PATH_ATTR.ORIGINATOR_ID, ipBytes('192.0.2.3'), BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL),
            pathAttr(
                BgpConst.BGP_PATH_ATTR.CLUSTER_LIST,
                Buffer.concat([ipBytes('192.0.2.4'), ipBytes('192.0.2.5')]),
                BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL
            ),
            pathAttr(
                BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES,
                Buffer.concat([Buffer.from([0x00, 0x02]), u16(65000), u32(100)]),
                BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
            ),
            pathAttr(
                BgpConst.BGP_PATH_ATTR.AS4_PATH,
                Buffer.concat([Buffer.from([BgpConst.BGP_AS_PATH_TYPE.AS_SEQUENCE, 1]), u32(65536)]),
                BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
            ),
            pathAttr(
                BgpConst.BGP_PATH_ATTR.AS4_AGGREGATOR,
                Buffer.concat([u32(65536), ipBytes('192.0.2.6')]),
                BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
            ),
            pathAttr(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI, mpReachValue, BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL),
            pathAttr(BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI, mpUnreachValue, BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL),
            pathAttr(
                BgpConst.BGP_PATH_ATTR.PMSI_TUNNEL,
                Buffer.concat([Buffer.from([0, 6]), mplsLabel(3000), ipBytes('192.0.2.7')]),
                BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
            ),
            pathAttr(
                BgpConst.BGP_PATH_ATTR.TUNNEL_ENCAPSULATION,
                Buffer.concat([u16(8), u16(0)]),
                BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
            ),
            pathAttr(
                BgpConst.BGP_PATH_ATTR.PATH_OTC,
                u32(65000),
                BgpConst.BGP_PATH_ATTR_FLAGS.OPTIONAL | BgpConst.BGP_PATH_ATTR_FLAGS.TRANSITIVE
            ),
            prefixSidAttr()
        ],
        ipv4Prefix(24, '10.0.0.0')
    );
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

function parseBoth(fixture) {
    const packet = fixture.packet;
    const parsedObject = parsePacketObject(packet);
    assert.equal(parsedObject.valid, true, parsedObject.error || `${fixture.name} object parser should accept packet`);
    assert.equal(parsedObject.type, fixture.type, `${fixture.name} object parser type`);
    assert.equal(
        parsedObject.length,
        packet.readUInt16BE(BgpConst.BGP_MARKER_LEN),
        `${fixture.name} object parser length`
    );

    const tree = parseTree(packet);
    const bgpNode = findNode(tree, node => node.name === 'BGP Packet');
    assert.ok(bgpNode, `${fixture.name} tree parser should create a BGP Packet node`);
    assert.equal(bgpNode.length, parsedObject.length, `${fixture.name} tree parser length`);

    const typeNode = findNode(bgpNode, node => node.name === 'Type');
    assert.ok(typeNode, `${fixture.name} tree parser should create Type node`);
    assert.ok(String(typeNode.value).startsWith(`${fixture.type} (`), `${fixture.name} tree parser type`);

    return { parsedObject, tree, bgpNode };
}

function assertSummary(parsedObject, fixture) {
    const summary = getBgpPacketSummary(parsedObject);
    assert.ok(summary.startsWith(fixture.summaryStartsWith), `${fixture.name} summary should start correctly`);
    fixture.summaryIncludes.forEach(text => {
        assert.ok(summary.includes(text), `${fixture.name} summary should include ${text}`);
    });
}

const fixtures = [
    {
        name: 'OPEN with all parsed capabilities',
        type: BgpConst.BGP_PACKET_TYPE.OPEN,
        packet: openPacket([
            capability(
                BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
                Buffer.concat([
                    u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
                    Buffer.from([0, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST])
                ])
            ),
            capability(BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH),
            capability(BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS, u32(65000)),
            capability(BgpConst.BGP_OPEN_CAP_CODE.BGP_ROLE, Buffer.from([BgpConst.BGP_ROLE_TYPE.ROLE_PROVIDER])),
            capability(
                BgpConst.BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING,
                Buffer.concat([
                    u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
                    u16(BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST),
                    u16(BgpConst.IP_TYPE.IPV6)
                ])
            ),
            capability(
                BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH,
                Buffer.concat([
                    u16(BgpConst.BGP_AFI_TYPE.AFI_IPV4),
                    Buffer.from([BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST, BgpConst.BGP_ADD_PATH_TYPE.SEND_RECEIVE])
                ])
            )
        ]),
        summaryStartsWith: 'BGP OPEN Message',
        summaryIncludes: [
            'Version: 4',
            'AS: 65000',
            'Hold Time: 90 seconds',
            'Router ID: 192.0.2.1',
            'Capabilities:',
            'Multiprotocol Extensions (IPv4/Unicast)',
            'Route Refresh',
            '4-octet AS Number (AS65000)',
            'BGP Role (Provider)',
            'Extended Next Hop Encoding',
            'IPv4/Unicast/IPv6',
            'ADD-PATH',
            'IPv4/Unicast: Send/Receive'
        ],
        validate({ parsedObject, bgpNode }) {
            assert.equal(parsedObject.version, BgpConst.BGP_VERSION);
            assert.equal(parsedObject.asn, 65000);
            assert.equal(parsedObject.routerId, '192.0.2.1');
            assert.equal(parsedObject.capabilities.length, 6);
            assert.ok(
                parsedObject.capabilities.some(cap => cap.code === BgpConst.BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS)
            );
            assert.ok(parsedObject.capabilities.some(cap => cap.code === BgpConst.BGP_OPEN_CAP_CODE.ROUTE_REFRESH));
            assert.ok(parsedObject.capabilities.some(cap => cap.code === BgpConst.BGP_OPEN_CAP_CODE.FOUR_OCTET_AS));
            assert.ok(parsedObject.capabilities.some(cap => cap.code === BgpConst.BGP_OPEN_CAP_CODE.BGP_ROLE));
            assert.ok(
                parsedObject.capabilities.some(
                    cap => cap.code === BgpConst.BGP_OPEN_CAP_CODE.EXTENDED_NEXT_HOP_ENCODING
                )
            );
            assert.ok(parsedObject.capabilities.some(cap => cap.code === BgpConst.BGP_OPEN_CAP_CODE.ADD_PATH));
            assert.ok(findNode(bgpNode, node => node.name === 'Next Hop Tuple 1'));
            assert.ok(findNode(bgpNode, node => node.name === 'ADD-PATH Tuple 1'));
        }
    },
    {
        name: 'UPDATE with parsed attributes and routes',
        type: BgpConst.BGP_PACKET_TYPE.UPDATE,
        packet: richUpdatePacket(),
        summaryStartsWith: 'BGP UPDATE Message',
        summaryIncludes: [
            'Withdrawn Routes:',
            '198.51.100.0/24',
            'Path Attributes:',
            'ORIGIN: IGP',
            'AS_PATH: 65000 65001',
            'NEXT_HOP: 192.0.2.254',
            'LOCAL_PREF: 200',
            'COMMUNITY: 65000:100 65535:65281',
            'EXTENDED_COMMUNITIES: RT 65000:100',
            'PMSI_TUNNEL: Ingress Replication',
            'TUNNEL_ENCAPSULATION: VXLAN',
            'PREFIX_SID: Label-Index 16000, SRGB 16000+8000, SRv6 L3 2001:db8::aa End.DX4',
            'MULTI_EXIT_DISC: 100',
            'IPv6/Unicast: 2001:db8::1',
            '2001:db8:1::/48',
            'MP_UNREACH_NLRI',
            '203.0.113.0/24',
            'OTC: 65000',
            'Routes:',
            '10.0.0.0/24'
        ],
        validate({ parsedObject, bgpNode }) {
            assert.equal(parsedObject.withdrawnRoutes.length, 1);
            assert.equal(parsedObject.withdrawnRoutes[0].prefix, '198.51.100.0');
            assert.equal(parsedObject.nlri.length, 1);
            assert.equal(parsedObject.nlri[0].prefix, '10.0.0.0');

            const attrsByType = new Map(parsedObject.pathAttributes.map(attr => [attr.typeCode, attr]));
            [
                BgpConst.BGP_PATH_ATTR.ORIGIN,
                BgpConst.BGP_PATH_ATTR.AS_PATH,
                BgpConst.BGP_PATH_ATTR.NEXT_HOP,
                BgpConst.BGP_PATH_ATTR.MED,
                BgpConst.BGP_PATH_ATTR.LOCAL_PREF,
                BgpConst.BGP_PATH_ATTR.ATOMIC_AGGREGATE,
                BgpConst.BGP_PATH_ATTR.AGGREGATOR,
                BgpConst.BGP_PATH_ATTR.COMMUNITY,
                BgpConst.BGP_PATH_ATTR.ORIGINATOR_ID,
                BgpConst.BGP_PATH_ATTR.CLUSTER_LIST,
                BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES,
                BgpConst.BGP_PATH_ATTR.AS4_PATH,
                BgpConst.BGP_PATH_ATTR.AS4_AGGREGATOR,
                BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI,
                BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI,
                BgpConst.BGP_PATH_ATTR.PMSI_TUNNEL,
                BgpConst.BGP_PATH_ATTR.TUNNEL_ENCAPSULATION,
                BgpConst.BGP_PATH_ATTR.PATH_OTC,
                BgpConst.BGP_PATH_ATTR.PREFIX_SID
            ].forEach(typeCode => assert.ok(attrsByType.has(typeCode), `missing path attribute ${typeCode}`));

            assert.equal(attrsByType.get(BgpConst.BGP_PATH_ATTR.ORIGIN).origin, 'IGP');
            assert.deepEqual(attrsByType.get(BgpConst.BGP_PATH_ATTR.AS_PATH).segments[0].asNumbers, [65000, 65001]);
            assert.equal(attrsByType.get(BgpConst.BGP_PATH_ATTR.NEXT_HOP).nextHop, '192.0.2.254');
            assert.equal(attrsByType.get(BgpConst.BGP_PATH_ATTR.MED).med, 100);
            assert.equal(attrsByType.get(BgpConst.BGP_PATH_ATTR.LOCAL_PREF).localPref, 200);
            assert.equal(attrsByType.get(BgpConst.BGP_PATH_ATTR.AGGREGATOR).aggregatorAs, 65000);
            assert.equal(attrsByType.get(BgpConst.BGP_PATH_ATTR.COMMUNITY).communities[0].formatted, '65000:100');
            assert.equal(attrsByType.get(BgpConst.BGP_PATH_ATTR.EXTENDED_COMMUNITIES).extCommunities.length, 1);
            assert.equal(attrsByType.get(BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI).mpReach.nlri[0].prefix, '2001:db8:1::');
            assert.equal(
                attrsByType.get(BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI).mpUnreach.withdrawnRoutes[0].prefix,
                '203.0.113.0'
            );
            assert.equal(attrsByType.get(BgpConst.BGP_PATH_ATTR.PMSI_TUNNEL).pmsiTunnel.tunnelType, 6);
            assert.equal(
                attrsByType.get(BgpConst.BGP_PATH_ATTR.TUNNEL_ENCAPSULATION).tunnelEncapsulation.tlvs[0].tunnelType,
                8
            );
            assert.equal(attrsByType.get(BgpConst.BGP_PATH_ATTR.PATH_OTC).otc, 65000);
            assert.equal(attrsByType.get(BgpConst.BGP_PATH_ATTR.PREFIX_SID).prefixSid.labelIndex.labelIndex, 16000);
            assert.equal(
                attrsByType.get(BgpConst.BGP_PATH_ATTR.PREFIX_SID).prefixSid.originatorSrgb.ranges[0].start,
                16000
            );
            assert.equal(attrsByType.get(BgpConst.BGP_PATH_ATTR.PREFIX_SID).prefixSid.srv6Services.length, 1);

            [
                'Withdrawn Routes',
                'Path Attributes',
                'AS_PATH',
                'Next Hop',
                'MED',
                'Local Preference',
                'Atomic Aggregate',
                'Aggregator',
                'Communities',
                'Originator ID',
                'Cluster List',
                'Extended Communities',
                'AS4_PATH',
                'AS4 Aggregator',
                'MP_REACH_NLRI',
                'MP_UNREACH_NLRI',
                'PMSI Tunnel',
                'Tunnel Encapsulation',
                'Only-To-Customer AS',
                'PREFIX_SID',
                'NLRI'
            ].forEach(name =>
                assert.ok(
                    findNode(bgpNode, node => node.name === name),
                    `missing tree node ${name}`
                )
            );
        }
    },
    {
        name: 'NOTIFICATION',
        type: BgpConst.BGP_PACKET_TYPE.NOTIFICATION,
        packet: bgpPacket(
            BgpConst.BGP_PACKET_TYPE.NOTIFICATION,
            Buffer.concat([
                Buffer.from([
                    BgpConst.BGP_ERROR_CODE.OPEN_MESSAGE_ERROR,
                    BgpConst.BGP_ERROR_OPEN_MESSAGE_SUBCODE.UNSUPPORTED_CAPABILITY
                ]),
                Buffer.from([0x41, 0x04])
            ])
        ),
        summaryStartsWith: 'BGP NOTIFICATION Message',
        summaryIncludes: ['Error: Unsupported Capability', 'Error Code: 2', 'Error Subcode: 7'],
        validate({ parsedObject, bgpNode }) {
            assert.equal(parsedObject.errorCode, BgpConst.BGP_ERROR_CODE.OPEN_MESSAGE_ERROR);
            assert.equal(parsedObject.errorSubcode, BgpConst.BGP_ERROR_OPEN_MESSAGE_SUBCODE.UNSUPPORTED_CAPABILITY);
            assert.equal(parsedObject.data.toString('hex'), '4104');
            assert.ok(findNode(bgpNode, node => node.name === 'Error Code'));
            assert.ok(findNode(bgpNode, node => node.name === 'Error Subcode'));
            assert.ok(findNode(bgpNode, node => node.name === 'Data'));
        }
    },
    {
        name: 'KEEPALIVE',
        type: BgpConst.BGP_PACKET_TYPE.KEEPALIVE,
        packet: bgpPacket(BgpConst.BGP_PACKET_TYPE.KEEPALIVE),
        summaryStartsWith: 'BGP KEEPALIVE Message',
        summaryIncludes: [],
        validate({ parsedObject, bgpNode }) {
            assert.equal(parsedObject.length, BgpConst.BGP_HEAD_LEN);
            assert.equal(
                bgpNode.children.some(child => child.name === 'Type'),
                true
            );
        }
    },
    {
        name: 'ROUTE_REFRESH',
        type: BgpConst.BGP_PACKET_TYPE.ROUTE_REFRESH,
        packet: bgpPacket(
            BgpConst.BGP_PACKET_TYPE.ROUTE_REFRESH,
            Buffer.concat([u16(BgpConst.BGP_AFI_TYPE.AFI_IPV6), Buffer.from([0, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST])])
        ),
        summaryStartsWith: 'BGP ROUTE_REFRESH Message',
        summaryIncludes: ['Address Family: IPv6', 'Subsequent Address Family: Unicast'],
        validate({ parsedObject, bgpNode }) {
            assert.equal(parsedObject.afi, BgpConst.BGP_AFI_TYPE.AFI_IPV6);
            assert.equal(parsedObject.subType, 0);
            assert.equal(parsedObject.safi, BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST);
            assert.ok(findNode(bgpNode, node => node.name === 'AFI'));
            assert.ok(findNode(bgpNode, node => node.name === 'Reserved'));
            assert.ok(findNode(bgpNode, node => node.name === 'SAFI'));
        }
    }
];

fixtures.forEach(fixture => {
    const result = parseBoth(fixture);
    fixture.validate(result);
    assertSummary(result.parsedObject, fixture);
});

console.log('BGP packet parser consistency tests passed');
