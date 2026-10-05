const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
process.env.NODE_ENV = 'test';
const { iterateMrtRoutes } = require('../../electron/utils/bgp/simulator/bgpMrtImport');
const BgpPeer = require('../../electron/worker/bgp/bgpPeer');
const BgpConst = require('../../electron/const/bgpConst');
const { canonicalizeAttr } = require('../../electron/worker/bgp/bgpPathAttrStore');

// Construct records directly from RFC 6396/8050 fields, independently of the
// product encoder, so a shared encoding error cannot make these tests pass.
function u16(value) {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(value);
    return bytes;
}
function u32(value) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
}
function attribute(type, flags, value) {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'hex') : value;
    const extended = Boolean(flags & 0x10) || bytes.length > 255;
    return Buffer.concat([
        Buffer.from([extended ? flags | 0x10 : flags, type]),
        extended ? u16(bytes.length) : Buffer.from([bytes.length]),
        bytes
    ]);
}
function record(type, subtype, body) {
    const header = Buffer.alloc(12);
    header.writeUInt32BE(1700000000);
    header.writeUInt16BE(type, 4);
    header.writeUInt16BE(subtype, 6);
    header.writeUInt32BE(body.length, 8);
    return Buffer.concat([header, body]);
}
function peerIndexTable() {
    return record(
        13,
        1,
        Buffer.concat([
            Buffer.from('01010101', 'hex'),
            u16(4),
            Buffer.from('test'),
            u16(2),
            Buffer.from('0202020202c0000201', 'hex'),
            u32(70000),
            Buffer.from('030303030320010db8000000000000000000000001', 'hex'),
            u32(65001)
        ])
    );
}
function entry({ peer = 0, pathId = 0, attrs = Buffer.alloc(0), time = 1700000001 }, addPath) {
    return Buffer.concat([u16(peer), u32(time), ...(addPath ? [u32(pathId)] : []), u16(attrs.length), attrs]);
}
function ribBody({ addPath = false, mask = 24, prefix = 'c63364', entries = [{}] } = {}) {
    return Buffer.concat([
        u32(123),
        Buffer.from([mask]),
        Buffer.from(prefix, 'hex'),
        u16(entries.length),
        ...entries.map(item => entry(item, addPath))
    ]);
}
function rib(options = {}) {
    const subtype = options.afi === 2 ? (options.addPath ? 10 : 4) : options.addPath ? 8 : 2;
    return record(13, subtype, ribBody(options));
}
function generic({
    afi = 1,
    safi = 4,
    addPath = false,
    pathId = 0,
    bits = 48,
    nlri = '001001c63364',
    entries = [{}]
} = {}) {
    return record(
        13,
        addPath ? 12 : 6,
        Buffer.concat([
            u32(456),
            u16(afi),
            Buffer.from([safi]),
            ...(addPath ? [u32(pathId)] : []),
            Buffer.from([bits]),
            Buffer.from(nlri, 'hex'),
            u16(entries.length),
            ...entries.map(item => entry(item, false))
        ])
    );
}
function tableDump(afi, attrs = Buffer.alloc(0)) {
    const body = Buffer.alloc(afi === 1 ? 22 : 46);
    const prefix = afi === 1 ? 'c63364ff' : '20010db800000000000000000000ffff';
    Buffer.from(prefix, 'hex').copy(body, 4);
    body[afi === 1 ? 8 : 20] = afi === 1 ? 24 : 64;
    body.writeUInt32BE(1700000002, afi === 1 ? 10 : 22);
    body.writeUInt16BE(attrs.length, body.length - 2);
    return record(12, afi === 1 ? 1 : 2, Buffer.concat([body, attrs]));
}
function wirePeer(afi = 1, safi = 1) {
    const instance = { afi, safi, getRouteAttr: route => route.routeAttr };
    return new BgpPeer(
        {
            localAs: 70000,
            localIp: afi === 1 ? '192.0.2.100' : '2001:db8::100',
            routerId: '192.0.2.100',
            peerIp: '::',
            peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_IBGP,
            localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS,
            processCustomPkt: value => Buffer.from(value, 'hex')
        },
        instance,
        { sendSrv6PrefixSid: true }
    );
}

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-mrt-import-parser-'));
    let fixtureIndex = 0;
    const write = (bytes, gzip = false) => {
        const filename = path.join(directory, `${fixtureIndex++}.mrt${gzip ? '.gz' : ''}`);
        fs.writeFileSync(filename, gzip ? zlib.gzipSync(bytes) : bytes);
        return filename;
    };
    const collect = async (filename, afi = 1, safi = 1, limit = 100000, progress) => {
        const routes = [];
        for await (const route of iterateMrtRoutes(filename, limit, afi, progress, safi)) routes.push(route);
        return routes;
    };
    const parse = (bytes, afi = 1, safi = 1) => collect(write(bytes), afi, safi);
    try {
        const community = attribute(8, 0xc0, Buffer.concat([u16(65000), u16(10), u16(65000), u16(10)]));
        const ext = attribute(
            16,
            0xc0,
            '0002fde8000000640103c000020100c8020200011170000302020000fde800044402000102030405'
        );
        const unknown = attribute(99, 0xf0, 'aabbcc');
        const prefixSid = attribute(40, 0x80, '05002020010db8000000000000000000000001');
        const asSet = attribute(2, 0x40, Buffer.concat([Buffer.from([1, 2]), u32(70000), u32(65001)]));
        const confed = attribute(2, 0x40, Buffer.concat([Buffer.from([3, 1]), u32(65002)]));
        const attrs = Buffer.concat([
            attribute(1, 0x40, '00'),
            attribute(2, 0x40, Buffer.concat([Buffer.from([2, 2]), u32(70000), u32(65001)])),
            attribute(3, 0x40, 'c000020a'),
            attribute(4, 0x80, u32(10)),
            attribute(5, 0x40, u32(200)),
            community,
            attribute(8, 0xc0, ''),
            ext,
            attribute(16, 0xc0, '0002fde800000064'),
            attribute(4, 0x80, u32(90)),
            unknown,
            prefixSid,
            asSet,
            confed
        ]);
        const records = Buffer.concat([
            peerIndexTable(),
            rib({
                addPath: true,
                entries: [
                    { peer: 1, pathId: 0, attrs },
                    { peer: 0, pathId: 999, attrs: Buffer.from('800e00', 'hex') },
                    { peer: 1, pathId: 1, attrs }
                ]
            }),
            rib({
                addPath: true,
                prefix: 'c63365',
                entries: [
                    { peer: 0, pathId: 0, attrs },
                    { peer: 1, pathId: 2, attrs }
                ]
            })
        ]);
        const routes = await parse(records);
        assert.equal(routes.length, 3, 'select each RIB first peer and retain all of its Path IDs');
        assert.deepEqual(
            routes.map(item => [item.ip, item.pathId]),
            [
                ['198.51.100.0', 0],
                ['198.51.100.0', 1],
                ['198.51.101.0', 0]
            ]
        );
        const first = routes[0];
        assert.equal(first.asPath, '70000 65001');
        assert.equal(first.med, 10);
        assert.equal(first.nextHop, '192.0.2.10');
        assert.equal(first.localPref, 200);
        assert.equal(first.origin, 0);
        assert.equal(first.attributePolicy, 'configured');
        assert.equal(first.createdAtMs, 1700000001000);
        assert.equal(first.nlriEncoding, 'auto');
        assert.equal(first.mpNextHop, null);
        assert.equal(first.formatted, undefined);
        assert.deepEqual(
            first.pathAttributes.map(item => item.type),
            [
                'origin',
                'asPath',
                'nextHop',
                'med',
                'localPref',
                'communities',
                'communities',
                'extendedCommunities',
                'extendedCommunities',
                'med',
                'custom',
                'custom',
                'custom',
                'custom'
            ]
        );
        assert.deepEqual(first.communities, ['65000:10', '65000:10']);
        assert.deepEqual(first.extendedCommunities, [
            'rt:65000:100',
            'soo:192.0.2.1:200',
            'rt:70000:3',
            'hex:02020000fde80004',
            'hex:4402000102030405'
        ]);
        assert.deepEqual(
            first.pathAttributes.slice(-4).map(item => item.value),
            [unknown, prefixSid, asSet, confed].map(bytes => bytes.toString('hex'))
        );
        assert.deepEqual(
            Buffer.from(wirePeer().buildRoutePathAttributes({ ...first, routeAttr: canonicalizeAttr(first) })),
            attrs,
            'configured route codec must retain every physical attribute, its order and raw unknown values'
        );

        const plain = await parse(
            Buffer.concat([
                rib({
                    entries: [
                        { peer: 1, attrs },
                        { peer: 0, attrs }
                    ]
                }),
                rib({ afi: 2, mask: 65, prefix: '20010db800000000ff', entries: [{ attrs: Buffer.alloc(0) }] })
            ])
        );
        assert.equal(plain.length, 1);
        assert.equal(plain[0].pathId, 0);
        const ipv6 = await parse(
            rib({
                afi: 2,
                addPath: true,
                mask: 65,
                prefix: '20010db800000000ff',
                entries: [{ pathId: 0xffffffff }, { pathId: 0 }]
            }),
            2
        );
        assert.equal(ipv6[0].ip, '2001:db8::8000:0:0:0');
        assert.deepEqual(
            ipv6.map(item => item.pathId),
            [0xffffffff, 0]
        );
        assert.deepEqual(ipv6[0].pathAttributes, []);
        assert.deepEqual(ipv6[0].configuredAttributes, []);
        assert.equal((await parse(rib({ mask: 0, prefix: '' })))[0].ip, '0.0.0.0');
        assert.equal((await parse(rib({ afi: 2, mask: 0, prefix: '' }), 2))[0].ip, '::');

        for (const [hex, expected] of [
            ['', null],
            ['c0000263', '192.0.2.99'],
            ['20010db8000000000000000000000099', '2001:db8::99'],
            ['20010db8000000000000000000000099fe800000000000000000000000000001', '2001:db8::99']
        ]) {
            const mp = attribute(14, 0x80, Buffer.concat([Buffer.from([hex.length / 2]), Buffer.from(hex, 'hex')]));
            const imported = (await parse(rib({ entries: [{ attrs: Buffer.concat([attrs, mp]) }] })))[0];
            assert.equal(imported.nlriEncoding, 'mpReach');
            assert.equal(imported.mpNextHop, expected);
            assert.equal(imported.nextHop, '192.0.2.10', 'Type3 NEXT_HOP stays independent of compact MP NH');
            assert.deepEqual(imported.pathAttributes, first.pathAttributes);
            assert.equal(imported.mrtMpNextHopBytes, hex.length === 64 ? hex : undefined);
            const route = { ...imported, routeAttr: canonicalizeAttr(imported) };
            assert.equal(Buffer.from(wirePeer().getMpReachNextHopBytes(route)).toString('hex'), hex);
        }
        const ipv6Mp = (
            await parse(
                rib({
                    afi: 2,
                    mask: 64,
                    prefix: '20010db800000000',
                    entries: [{ attrs: attribute(14, 0x80, '1020010db8000000000000000000000002') }]
                }),
                2
            )
        )[0];
        assert.equal(ipv6Mp.mpNextHop, '2001:db8::2');

        const labels = Buffer.concat([
            generic({ addPath: true, pathId: 0, entries: [{ attrs }] }),
            generic({ addPath: true, pathId: 1, entries: [{ attrs }] }),
            generic({ bits: 49, nlri: '001001c6336480' })
        ]);
        assert.deepEqual(await parse(labels), [], 'Label Generic records must never enter UNC by default');
        const labeled = await parse(labels, 1, 4);
        assert.deepEqual(
            labeled.map(item => [item.ip, item.mask, item.label, item.pathId]),
            [
                ['198.51.100.0', 24, 256, 0],
                ['198.51.100.0', 24, 256, 1],
                ['198.51.100.128', 25, 256, 0]
            ]
        );
        const genericUnicast = await parse(generic({ safi: 1, bits: 24, nlri: 'c63364', addPath: true, pathId: 17 }));
        assert.equal(genericUnicast[0].pathId, 17, 'generic PathID lives before NLRI, not in its entries');
        assert.equal((await parse(generic({ afi: 2, safi: 1, bits: 64, nlri: '20010db800000000' }), 2))[0].mask, 64);
        assert.deepEqual(
            await parse(Buffer.concat([generic({ bits: 8, nlri: 'ff' }), rib()])),
            await parse(rib()),
            'an unsupported or invalid non-target family cannot block a selected family'
        );

        const as2Sequence = attribute(2, 0x40, '0202fde8fde9');
        const as2Set = attribute(2, 0x40, '0102fde8fde9');
        const as2Confed = attribute(2, 0x60, '0301fdea');
        const old = (await parse(tableDump(1, Buffer.concat([as2Sequence, as2Set, as2Confed]))))[0];
        assert.equal(old.ip, '198.51.100.0');
        assert.equal(old.asPath, '65000 65001');
        assert.deepEqual(
            old.pathAttributes.slice(1).map(item => item.value),
            ['40020a01020000fde80000fde9', '60020603010000fdea']
        );
        const aggregate = (await parse(tableDump(1, attribute(7, 0xc0, 'fde8c000020a'))))[0];
        assert.equal(aggregate.pathAttributes[0].value, 'c007080000fde8c000020a');
        const aggregate4 = attribute(18, 0xc0, '00011170c000020a');
        assert.equal((await parse(tableDump(1, aggregate4)))[0].pathAttributes[0].value, aggregate4.toString('hex'));
        const nonstandardV6NextHop = attribute(3, 0x40, '20010db8000000000000000000000001');
        const old6 = (await parse(tableDump(2, nonstandardV6NextHop), 2))[0];
        assert.equal(old6.ip, '2001:db8::');
        assert.equal(old6.pathAttributes[0].type, 'custom');
        assert.equal(old6.pathAttributes[0].value, nonstandardV6NextHop.toString('hex'));
        const oldMp = (await parse(tableDump(1, attribute(14, 0x80, '00010104c000026300'))))[0];
        assert.equal(oldMp.mpNextHop, '192.0.2.99');

        for (const malformed of [
            rib().subarray(0, 10),
            rib().subarray(0, -1),
            record(13, 8, ribBody({ addPath: true }).subarray(0, -1)),
            record(13, 2, Buffer.concat([ribBody(), Buffer.from([1])])),
            record(13, 1, peerIndexTable().subarray(12, -1)),
            rib({ mask: 33, prefix: 'c63364ff00' }),
            rib({ entries: [{ attrs: Buffer.from('9010', 'hex') }] }),
            rib({ entries: [{ attrs: Buffer.from('901001', 'hex') }] }),
            rib({ entries: [{ attrs: Buffer.from('800401', 'hex') }] }),
            rib({ entries: [{ attrs: attribute(14, 0x80, '10aa') }] }),
            rib({ entries: [{ attrs: Buffer.concat([attribute(14, 0x80, '00'), attribute(14, 0x80, '00')]) }] }),
            tableDump(1).subarray(0, -1),
            generic({ bits: 8, nlri: 'ff' }),
            generic({ nlri: '001000c63364' })
        ]) {
            await assert.rejects(() => parse(malformed, 1, [6, 12].includes(malformed.readUInt16BE(6)) ? 4 : 1), /MRT/);
        }
        // All entry boundaries are checked before yielding even if limit is 1.
        const secondTruncated = ribBody({ entries: [{}, { peer: 1, attrs: Buffer.from([1, 2]) }] }).subarray(0, -1);
        await assert.rejects(() => collect(write(record(13, 2, secondTruncated)), 1, 1, 1), /截断/);
        await assert.rejects(
            () => parse(Buffer.concat([peerIndexTable(), rib({ entries: [{ peer: 2 }] })])),
            /Peer Index/
        );
        const huge = Buffer.alloc(12);
        huge.writeUInt32BE(64 * 1024 * 1024 + 1, 8);
        await assert.rejects(() => parse(huge), /长度异常/);

        const many = Buffer.concat(
            Array.from({ length: 1200 }, (_, index) =>
                rib({
                    mask: 32,
                    prefix: Buffer.from([10, 0, index >>> 8, index & 255]).toString('hex'),
                    entries: [{ attrs: attribute(99, 0xc0, Buffer.alloc(100, 0xaa)) }]
                })
            )
        );
        const plainFile = write(many);
        const progress = [];
        const limited = await collect(plainFile, 1, 1, 600, message => progress.push(message));
        assert.equal(limited.length, 600);
        assert.equal(limited[599].ip, '10.0.2.87');
        assert.deepEqual(progress, ['正在准备解析 MRT 文件...', '已解析 500 条路由...']);
        assert.equal((await collect(write(many, true), 1, 1, 1200)).length, 1200);
        assert.deepEqual(await collect(plainFile, 1, 1, 0), []);
        let count = 0;
        for await (const route of iterateMrtRoutes(plainFile, 100000, 1)) {
            assert.ok(route.ip);
            if (++count === 7) break;
        }
        assert.equal(count, 7);
        await assert.rejects(() => collect(path.join(directory, 'missing.mrt')), /文件不存在/);
        await assert.rejects(() => collect(write(many.subarray(0, -1), true)), /截断/);
        const corruptGzip = path.join(directory, 'corrupt.mrt.gz');
        fs.writeFileSync(corruptGzip, 'not gzip');
        await assert.rejects(() => collect(corruptGzip));

        if (process.argv[2]) {
            const actual = await collect(process.argv[2], 1, 1, 30000);
            assert.equal(actual.length, 20000);
            assert.equal(new Set(actual.map(item => `${item.ip}/${item.mask}`)).size, 10000);
            for (let index = 0; index < actual.length; index++) {
                assert.equal(actual[index].pathId, index % 2);
                assert.equal(actual[index].extendedCommunities.length, 10);
                assert.deepEqual(
                    actual[index].pathAttributes.map(item => item.type),
                    ['origin', 'asPath', 'nextHop', 'localPref', 'communities', 'extendedCommunities', 'med']
                );
            }
            assert.equal(actual[0].ip, '1.1.1.1');
            assert.equal(actual.at(-1).ip, '1.2.18.106');
            console.log('Read-only user MRT check passed: 20000 routes / 10000 prefixes / Path IDs 0 and 1');
        }
        console.log('BGP MRT importer parser tests passed');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
