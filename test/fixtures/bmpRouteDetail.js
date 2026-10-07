const assert = require('node:assert/strict');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const { parseBgpPacket, parsePathAttributes } = require('../../electron/utils/bgp/bgpPacketParser');
const { builders } = require('../../scripts/mockBmpClient');

function pathAttribute(type, value, flags = 0x40) {
    const header =
        value.length > 255
            ? Buffer.concat([Buffer.from([flags | 0x10, type]), builders.u16(value.length)])
            : Buffer.from([flags, type, value.length]);
    return Buffer.concat([header, value]);
}

function richAttributes(revision = 1, communities = [0xffffff01, 0xffffff02, 0xffffff03, 65000 * 65536 + 100]) {
    const bytes = Buffer.concat([
        pathAttribute(1, Buffer.from([0])),
        pathAttribute(2, Buffer.concat([Buffer.from([2, 2]), builders.u32(65000), builders.u32(65100 + revision)])),
        pathAttribute(3, builders.ip('192.0.2.254')),
        pathAttribute(4, builders.u32(0), 0x80),
        pathAttribute(5, builders.u32(100)),
        pathAttribute(6, Buffer.alloc(0)),
        pathAttribute(7, Buffer.concat([builders.u32(65010), builders.ip('192.0.2.10')]), 0xc0),
        pathAttribute(8, Buffer.concat(communities.map(value => builders.u32(value))), 0xc0),
        pathAttribute(9, builders.ip('192.0.2.9'), 0x80),
        pathAttribute(10, Buffer.concat([builders.ip('192.0.2.11'), builders.ip('192.0.2.12')]), 0x80),
        pathAttribute(16, Buffer.from('0002fde8000001900003fde8000001f4', 'hex'), 0xc0),
        pathAttribute(32, Buffer.concat([builders.u32(65000), builders.u32(200), builders.u32(300)]), 0xc0),
        pathAttribute(99, Buffer.from('deadbeef', 'hex'), 0xc0)
    ]);
    const parsed = parsePathAttributes(bytes, 0, bytes.length, { asnSize: 4 });
    assert.deepEqual(parsed.errors, []);
    return JSON.parse(JSON.stringify(BmpSession.prototype.extractRouteAttributes.call({}, parsed)));
}

function multiprotocolRoute(afi, safi, bytes, options = {}) {
    const parsed = parseBgpPacket(builders.multiprotocolUpdate(afi, safi, bytes, options));
    assert.equal(parsed.valid, true, parsed.error);
    const nlri = parsed.pathAttributes.find(attribute => attribute.mpReach).mpReach.nlri[0];
    assert.notEqual(nlri.valid, false);
    return {
        afi,
        safi,
        ip: nlri.displayPrefix || nlri.prefix,
        mask: nlri.length,
        rd: nlri.rd || '0:0',
        routeType: nlri.routeType,
        nlriDetail: nlri,
        ...BmpSession.prototype.extractRouteAttributes.call({}, parsed)
    };
}

function evpnRoute() {
    const body = Buffer.concat([
        builders.rd(65000, 1),
        Buffer.from('00010203040506070809', 'hex'),
        builders.u32(100),
        Buffer.from([48]),
        Buffer.from('aabbccddee01', 'hex'),
        Buffer.from([32]),
        builders.ip('192.0.2.11'),
        Buffer.from([0, 0x27, 0x10])
    ]);
    return multiprotocolRoute(25, 70, Buffer.concat([Buffer.from([2, body.length]), body]), {
        nextHop: '10.0.0.1',
        additionalAttrs: [pathAttribute(16, Buffer.from('030c000000000008', 'hex'), 0xc0)]
    });
}

function bgpLsRoute() {
    const tlv = (type, value) => Buffer.concat([builders.u16(type), builders.u16(value.length), value]);
    const node = (type, asn, routerId) =>
        tlv(type, Buffer.concat([tlv(512, builders.u32(asn)), tlv(515, builders.ip(routerId))]));
    const body = Buffer.concat([
        Buffer.from([3]),
        builders.u32(0),
        builders.u32(20001),
        node(256, 65009, '10.100.0.1'),
        node(257, 65109, '10.200.0.1'),
        tlv(259, builders.ip('10.10.0.1')),
        tlv(260, builders.ip('10.10.0.2'))
    ]);
    return multiprotocolRoute(16388, 71, Buffer.concat([builders.u16(2), builders.u16(body.length), body]));
}

function flowSpecRoute() {
    const components = Buffer.concat([
        Buffer.from([1, 24]),
        builders.ip('203.0.113.0').subarray(0, 3),
        Buffer.from([3, 0x81, 6, 5, 0x91]),
        builders.u16(443)
    ]);
    return multiprotocolRoute(1, 133, Buffer.concat([Buffer.from([components.length]), components]));
}

module.exports = { pathAttribute, richAttributes, evpnRoute, bgpLsRoute, flowSpecRoute };
