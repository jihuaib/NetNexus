const assert = require('assert');
const BgpConst = require('../../electron/const/bgpConst');
const { ipToBytes } = require('../../electron/utils/ipUtils');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');

const u16 = value => Buffer.from([(value >> 8) & 0xff, value & 0xff]);
const u32 = value => Buffer.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
const ip = value => Buffer.from(ipToBytes(value));
const rd = Buffer.concat([u16(1), ip('192.0.2.1'), u16(1)]);
const esi = Buffer.from('01020000000001000000', 'hex');
const implicitNull = Buffer.from('000030', 'hex');

function attribute(type, value, flags = 0xc0) {
    return Buffer.concat([Buffer.from([flags, type, value.length]), value]);
}

function tlv(type, value) {
    return Buffer.concat([Buffer.from([type]), u16(value.length), value]);
}

function service(type, sid, behavior) {
    const structure = tlv(1, Buffer.from([32, 32, 64, 0, 0, 0]));
    const sidInfo = tlv(
        1,
        Buffer.concat([Buffer.from([0]), ip(sid), Buffer.from([0]), u16(behavior), Buffer.from([0]), structure])
    );
    return tlv(type, Buffer.concat([Buffer.from([0]), sidInfo]));
}

function nlri(type, body) {
    return Buffer.concat([Buffer.from([type, body.length]), body]);
}

function parseUpdate(route, extraAttributes, withdraw = false) {
    const family = Buffer.concat([u16(25), Buffer.from([70])]);
    const mpValue = withdraw
        ? Buffer.concat([family, route])
        : Buffer.concat([family, Buffer.from([16]), ip('2001:db8::1'), Buffer.from([0]), route]);
    const attributes = Buffer.concat([attribute(withdraw ? 15 : 14, mpValue, 0x80), ...extraAttributes]);
    const body = Buffer.concat([u16(0), u16(attributes.length), attributes]);
    const packet = parseBgpPacket(
        Buffer.concat([Buffer.alloc(16, 0xff), u16(19 + body.length), Buffer.from([2]), body])
    );
    const mp = packet.pathAttributes.find(item => item.typeCode === (withdraw ? 15 : 14));
    return { packet, route: withdraw ? mp.mpUnreach.withdrawnRoutes[0] : mp.mpReach.nlri[0] };
}

function prefixSid(...services) {
    return attribute(BgpConst.BGP_PATH_ATTR.PREFIX_SID, Buffer.concat(services));
}

const ad = nlri(1, Buffer.concat([rd, esi, u32(0), implicitNull]));
const adParsed = parseUpdate(ad, [prefixSid(service(6, '2001:db8::23', 23))]);
assert.strictEqual(adParsed.packet.valid, true);
assert.strictEqual(
    adParsed.route.encapsulationType,
    'srv6',
    'Prefix-SID alone identifies SRv6 without an Encapsulation EC'
);
assert.strictEqual(adParsed.route.srv6Services[0].endpointBehaviorName, 'End.DT2U');
assert.strictEqual(adParsed.route.labels[0].rawHex, '000030');
assert.strictEqual(adParsed.route.labels[0].type, 'srv6');
assert.strictEqual(adParsed.route.labels[0].display, 'SRv6 Implicit NULL (3)');

const macIp = nlri(
    2,
    Buffer.concat([
        rd,
        esi,
        u32(0),
        Buffer.from([48]),
        Buffer.from('020000000001', 'hex'),
        Buffer.from([32]),
        ip('192.0.2.10'),
        implicitNull,
        implicitNull
    ])
);
const macParsed = parseUpdate(macIp, [prefixSid(service(6, '2001:db8::23', 23), service(5, '2001:db8::19', 19))]);
assert.strictEqual(macParsed.packet.valid, true);
assert.deepStrictEqual(
    macParsed.route.srv6Services.map(item => item.serviceType),
    ['l2', 'l3']
);
assert.deepStrictEqual(
    macParsed.route.srv6Services.map(item => item.sid),
    ['2001:db8::23', '2001:db8::19']
);
assert.deepStrictEqual(
    macParsed.route.labels.map(item => item.display),
    ['SRv6 Implicit NULL (3)', 'SRv6 Implicit NULL (3)']
);
assert.strictEqual(macParsed.packet.pathAttributes.filter(item => item.typeCode === 40).length, 1);
const duplicateService = parseUpdate(macIp, [
    prefixSid(service(6, '2001:db8::23', 23), service(6, '2001:db8::21', 21), service(5, '2001:db8::19', 19))
]);
assert.deepStrictEqual(
    duplicateService.route.srv6Services.map(item => item.sid),
    ['2001:db8::23', '2001:db8::19']
);
assert.strictEqual(
    duplicateService.packet.pathAttributes.find(item => item.typeCode === 40).prefixSid.tlvs[1].ignored,
    true
);

const imet = nlri(3, Buffer.concat([rd, u32(0), Buffer.from([32]), ip('192.0.2.1')]));
const imetParsed = parseUpdate(imet, [
    prefixSid(service(6, '2001:db8::24', 24)),
    attribute(22, Buffer.concat([Buffer.from([0, 6, 0, 0, 0]), ip('192.0.2.1')])),
    attribute(16, Buffer.from('030c00000000000e', 'hex'))
]);
assert.strictEqual(imetParsed.packet.valid, true);
assert.strictEqual(imetParsed.route.encapsulationType, 'srv6');
assert.strictEqual(imetParsed.route.srv6Services[0].endpointBehaviorName, 'End.DT2M');
assert.strictEqual(imetParsed.route.srv6Services[0].sidStructure.argumentLength, 0);
assert.strictEqual(imetParsed.route.pmsiTunnel.tunnelType, 6);
assert.strictEqual(imetParsed.route.pmsiTunnel.label.raw24, 0);
assert.strictEqual(imetParsed.route.pmsiTunnel.label.type, 'srv6');
assert.strictEqual(imetParsed.packet.pathAttributes.find(item => item.typeCode === 22).pmsiTunnel.label.type, 'srv6');
assert.strictEqual(imetParsed.route.labels, undefined, 'The zero PMSI field does not advertise a forwarding label');

const ipPrefix = nlri(
    5,
    Buffer.concat([
        rd,
        Buffer.alloc(10),
        u32(0),
        Buffer.from([64]),
        ip('2001:db8:100::'),
        Buffer.alloc(16),
        implicitNull
    ])
);
const prefixParsed = parseUpdate(ipPrefix, [prefixSid(service(5, '2001:db8::18', 18))]);
assert.strictEqual(prefixParsed.packet.valid, true);
assert.strictEqual(prefixParsed.route.srv6Services[0].serviceType, 'l3');
assert.strictEqual(prefixParsed.route.srv6Services[0].endpointBehaviorName, 'End.DT6');

const es = nlri(4, Buffer.concat([rd, esi, Buffer.from([32]), ip('192.0.2.1')]));
const esParsed = parseUpdate(es, [prefixSid(service(6, '2001:db8::23', 23))]);
assert.strictEqual(esParsed.packet.valid, true);
assert.strictEqual(
    esParsed.route.srv6Services,
    undefined,
    'Ethernet Segment routes do not carry a forwarding Service SID'
);

const unrelatedService = parseUpdate(ad, [prefixSid(service(5, '2001:db8::19', 19))]);
assert.strictEqual(
    unrelatedService.route.srv6Services,
    undefined,
    'An L3 Service SID must not annotate a per-EVI route'
);
const malformedService = parseUpdate(ad, [attribute(40, Buffer.from([6, 0, 20, 0]))]);
assert.strictEqual(malformedService.packet.pathAttributes.find(item => item.typeCode === 40).valid, false);
assert.strictEqual(
    malformedService.route.srv6Services,
    undefined,
    'Invalid Prefix-SID data must not identify a service'
);

const withdrawn = parseUpdate(macIp, [], true);
assert.strictEqual(withdrawn.packet.valid, true);
assert.strictEqual(withdrawn.route.routeType, 2);
assert.strictEqual(withdrawn.route.macAddress, '02:00:00:00:00:01');
assert.strictEqual(withdrawn.route.labels.length, 2);

console.log(
    'EVPN SRv6 parser passed: L2/L3 association, two services, IMET PMSI, IPv6 prefix, invalid TLV, withdrawal'
);
