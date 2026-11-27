const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ipaddr = require('ipaddr.js');

process.env.NODE_ENV = 'test';
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForTest() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpPeer = require('../../electron/worker/bgp/bgpPeer');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');
const { iterateQpRouteIpInputs } = require('../../electron/utils/bgp/simulator/bgpRouteIpGenerator');
const {
    collectBgpGeneratedRoutes,
    forEachQpGeneratedRoute
} = require('../../electron/utils/bgp/simulator/bgpRouteGenerator');

const family = BgpConst.BGP_ADDR_FAMILY.IPV6_QP;
const ipType = BgpConst.IP_TYPE.IPV6;
const prefix = 'fedc:ba98:7654:3210:fedc:ba98:7654:3210';
const asInteger = ip =>
    ipaddr
        .parse(ip)
        .toByteArray()
        .reduce((value, byte) => value * 256n + BigInt(byte), 0n);
const asIp = value => {
    const bytes = Array(16).fill(0);
    for (let byte = 15; byte >= 0; byte -= 1) {
        bytes[byte] = Number(value & 255n);
        value >>= 8n;
    }
    return ipaddr.fromByteArray(bytes).toString();
};
const baseConfig = {
    addressFamily: family,
    prefix,
    mask: 128,
    count: 3,
    ipGenerationMode: 'rangeIncrement',
    ipRangeStartBit: '112',
    ipStep: 1,
    attributeRules: [{ type: 'med', value: 42 }],
    nlriRules: [
        { type: 'dqpn', mode: 'fixed', value: 1 },
        { type: 'bsid', mode: 'fixed', value: '2001:db8::1' }
    ]
};

function testBitRanges() {
    for (const startBit of [64, 80, 92, 96, 112]) {
        const config = { ...baseConfig, ipRangeStartBit: String(startBit), ipStep: 2 };
        const rows = Array.from(iterateQpRouteIpInputs(config, ipType));
        const lowerMask = (1n << BigInt(128 - startBit)) - 1n;
        const fixed = asInteger(prefix) & ~lowerMask;
        assert.deepEqual(
            rows.map(route => asInteger(route.ip)),
            [asInteger(prefix), asInteger(prefix) + 2n, asInteger(prefix) + 4n]
        );
        assert.ok(rows.every(route => route.mask === 128 && (asInteger(route.ip) & ~lowerMask) === fixed));
        const collected = collectBgpGeneratedRoutes(config);
        assert.deepEqual(
            collected.map(route => route.ip),
            rows.map(route => route.ip)
        );
        assert.ok(collected.every(route => route.dqpn === 1 && route.mpNextHop === '2001:db8::1' && route.med === 42));
        assert.equal(new Set(collected.map(route => `${route.dqpn}|${route.ip}|${route.mask}`)).size, 3);

        const end = fixed | lowerMask;
        const nearEnd = { ...config, prefix: asIp(end - 2n), count: 2 };
        assert.deepEqual(
            Array.from(iterateQpRouteIpInputs(nearEnd, ipType)).map(route => asInteger(route.ip)),
            [end - 2n, end]
        );
        assert.throws(
            () => iterateQpRouteIpInputs({ ...nearEnd, count: 3 }, ipType).next(),
            /最多生成2条/,
            'range exhaustion must be validated before yielding a partial batch'
        );
        assert.equal(
            Array.from(iterateQpRouteIpInputs({ ...nearEnd, prefix: asIp(end), count: 1 }, ipType))[0].ip,
            asIp(end)
        );
        assert.throws(() => iterateQpRouteIpInputs({ ...nearEnd, prefix: asIp(end), count: 2 }, ipType).next());
    }

    for (const routeGrowthMode of ['ip', 'dqpn', 'ip_dqpn']) {
        const collected = collectBgpGeneratedRoutes({
            ...baseConfig,
            routeGrowthMode,
            nlriRules: [{ type: 'dqpn', mode: 'increment', start: 11, step: 2 }]
        });
        assert.deepEqual(
            collected.map(route => route.dqpn),
            [11, 13, 15],
            'legacy growth modes must not suppress the new independent IP and DQPN rules'
        );
        assert.equal(new Set(collected.map(route => route.ip)).size, 3);
    }
    const allSuffixes = collectBgpGeneratedRoutes({ ...baseConfig, prefix: '2001:db8::1234:0', count: 65536 });
    assert.equal(allSuffixes.length, 65536);
    assert.equal(new Set(allSuffixes.map(route => route.ip)).size, 65536);
    assert.ok(allSuffixes.every(route => route.dqpn === 1 && route.mask === 128));
    assert.equal(allSuffixes[0].ip, '2001:db8::1234:0');
    assert.equal(allSuffixes[65535].ip, '2001:db8::1234:ffff');
    assert.throws(() =>
        iterateQpRouteIpInputs({ ...baseConfig, prefix: '2001:db8::1234:0', count: 65537 }, ipType).next()
    );

    const defaultStep = { ...baseConfig };
    delete defaultStep.ipStep;
    assert.deepEqual(
        Array.from(iterateQpRouteIpInputs(defaultStep, ipType)),
        Array.from(iterateQpRouteIpInputs(baseConfig, ipType))
    );
    for (const override of [
        { ipRangeStartBit: undefined },
        { ipRangeStartBit: '' },
        { ipRangeStartBit: '91' },
        { ipRangeStartBit: '92.5' },
        { ipRangeStartBit: '128' },
        { ipStep: 0 },
        { ipStep: -1 },
        { ipStep: 1.5 },
        { ipStep: Number.MAX_SAFE_INTEGER + 1 },
        { mask: 112 },
        { prefix: '192.0.2.1' },
        { prefix: 'bad-ip' }
    ]) {
        assert.throws(() => iterateQpRouteIpInputs({ ...baseConfig, ...override }, ipType).next());
    }
    assert.throws(
        () => iterateQpRouteIpInputs({ ...baseConfig, prefix: '192.0.2.1', mask: 32 }, BgpConst.IP_TYPE.IPV4).next(),
        /仅支持IPv6/
    );
    const snapshot = [{ ip: '2001:db8::1234', mask: 128, dqpn: 100 }];
    assert.deepEqual(
        Array.from(iterateQpRouteIpInputs({ ...baseConfig, prefix: 'bad-draft', routes: snapshot }, ipType)),
        snapshot
    );
    assert.deepEqual(
        collectBgpGeneratedRoutes({ addressFamily: family, routes: snapshot, ipGenerationMode: 'rangeIncrement' }),
        snapshot.map(route => ({ addressFamily: family, ...route }))
    );
    assert.throws(() => forEachQpGeneratedRoute(baseConfig, ipType, () => {}), /树属性和NLRI规则/);
    const legacy = { ...baseConfig };
    delete legacy.attributeRules;
    delete legacy.nlriRules;
    assert.throws(() => collectBgpGeneratedRoutes(legacy), /树属性和NLRI规则/);
    for (const ipGenerationMode of ['random', 'unsupported']) {
        const config = { ...baseConfig, ipGenerationMode };
        assert.throws(() => iterateQpRouteIpInputs(config, ipType).next(), /IP生成方式不支持/);
        assert.throws(() => collectBgpGeneratedRoutes(config), /IP生成方式不支持/);
        assert.throws(() => collectBgpGeneratedRoutes({ ...legacy, ipGenerationMode }), /IP生成方式不支持/);
        assert.throws(() => forEachQpGeneratedRoute(config, ipType, () => {}), /IP生成方式不支持/);
    }
}

function fixture(dbPath) {
    const worker = new BgpWorker();
    const store = new BgpRouteSqliteStore(dbPath);
    const instance = new BgpInstance(0, 2, 241, store);
    worker.routeStore = store;
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    const sent = [];
    worker.messageHandler.sendSuccessResponse = () => {};
    worker.messageHandler.sendErrorResponse = (_id, message) => {
        throw new Error(message);
    };
    const session = {
        localIp: '192.0.2.254',
        localAs: 65000,
        peerIp: '192.0.2.1',
        peerType: BgpConst.BGP_PEER_TYPE.PEER_TYPE_EBGP,
        localCapFlags: BgpConst.BGP_CAP_FLAGS.FOUR_OCTET_AS,
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
    return {
        worker,
        store,
        instance,
        peer,
        sent,
        generate: config => worker.generateQpRoutes('generate', { ...baseConfig, groupId: 'range', ...config }),
        rows: () => Array.from(instance.routeMap.values())
    };
}
const identities = routes =>
    routes.map(route => [route.ip || route.prefix, route.dqpn, route.mask ?? route.length]).sort();
const wireRoutes = (fixture, withdrawal = false) =>
    fixture.sent.flatMap(buffer => {
        const packet = parseBgpPacket(buffer, { asnSize: 4 });
        assert.ok(packet.valid, packet.error);
        const type = BgpConst.BGP_PATH_ATTR;
        const attribute = packet.pathAttributes.find(
            attr => attr.typeCode === (withdrawal ? type.MP_UNREACH_NLRI : type.MP_REACH_NLRI)
        );
        return withdrawal ? attribute?.mpUnreach.withdrawnRoutes || [] : attribute?.mpReach.nlri || [];
    });

async function testSnapshots() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-qp-range-'));
    const dbPath = path.join(directory, 'routes.sqlite');
    let f;
    try {
        f = fixture(dbPath);
        await f.generate({ prefix: '2001:db8::1234:fffd', count: 3 });
        const rows = f.rows();
        assert.deepEqual(
            rows.map(route => route.ip),
            ['2001:db8::1234:fffd', '2001:db8::1234:fffe', '2001:db8::1234:ffff']
        );
        assert.ok(rows.every(route => route.dqpn === 1));
        assert.deepEqual(identities(wireRoutes(f)), identities(rows));
        const snapshot = f.store.getRouteGroupRoutes('range');
        f.sent.length = 0;
        for (const invalid of [
            { prefix: '2001:db8::1234:fffd', count: 4 },
            { prefix: '2001:db8::1234:ffff', count: 2 },
            { prefix: '2001:db8::1234:fffd', count: 3, ipStep: 2 },
            { ipRangeStartBit: '91' },
            { ipGenerationMode: 'random' },
            { ipGenerationMode: 'unsupported' },
            { mask: 127 },
            { prefix: 'bad-prefix' }
        ]) {
            await assert.rejects(async () => f.generate(invalid));
            assert.deepEqual(f.store.getRouteGroupRoutes('range'), snapshot);
            assert.equal(f.sent.length, 0, 'range exhaustion must preserve the old group without withdrawal');
        }
        assert.throws(() => f.worker.deleteQpRoute('delete-template', baseConfig), /快照或路由组/);
        f.store.close();
        f = fixture(dbPath);
        await f.peer.sendRoute();
        assert.deepEqual(identities(f.rows()), identities(rows));
        assert.deepEqual(identities(wireRoutes(f)), identities(rows));
        f.sent.length = 0;
        await f.worker.withdrawRouteGroup('withdraw', {
            groupId: 'range',
            prefix: 'invalid-edited-template',
            ipRangeStartBit: '64',
            count: 1
        });
        assert.equal(f.rows().length, 0);
        assert.deepEqual(identities(wireRoutes(f, true)), identities(rows));
    } finally {
        f?.store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function main() {
    testBitRanges();
    await testSnapshots();
    console.log('BGP QP IPv6 range increment tests passed');
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
