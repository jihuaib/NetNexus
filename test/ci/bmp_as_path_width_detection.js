const assert = require('node:assert/strict');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpConst = require('../../electron/const/bmpConst');
const logger = require('../../electron/log/logger');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');
const { builders } = require('../../scripts/mockBmpClient');

const { u16, u32, ip } = builders;
const warnings = [];
const errors = [];
const originalWarn = logger.warn;
const originalError = logger.error;
const attribute = (type, value) => Buffer.concat([Buffer.from([0x40, type, value.length]), value]);

function update(pathHex, nlri = Buffer.from([24, 203, 0, 113]), extraAttributes = []) {
    const attributes = Buffer.concat([
        attribute(1, Buffer.from([0])),
        attribute(2, Buffer.from(pathHex, 'hex')),
        attribute(3, ip('192.0.2.254')),
        ...extraAttributes
    ]);
    const body = Buffer.concat([u16(0), u16(attributes.length), attributes, nlri]);
    return Buffer.concat([Buffer.alloc(16, 255), u16(19 + body.length), Buffer.from([2]), body]);
}

function harness(draft = 20) {
    const mutations = [];
    const session = new BmpSession(
        { sendEvent() {} },
        {
            bmpConfigData: { bmpV4TlvDraft: draft },
            persistence: {},
            enqueuePersistenceMutation(mutation) {
                mutations.push(mutation);
                return true;
            },
            handlePersistenceFailure(error) {
                throw error;
            },
            enqueueRouteUpdateEvent() {},
            enqueueInstanceRouteUpdateEvent() {},
            invalidateRouteAssurance() {},
            requestPersistenceSweep() {}
        }
    );
    Object.assign(session, { remoteIp: '192.0.2.10', remotePort: 50000, localIp: '127.0.0.1', localPort: 1790 });
    return { session, mutations };
}

function payload(packet, version, draft) {
    return version === 3 ? packet : Buffer.concat([u16(draft === 19 ? 4 : 7), u16(packet.length), u16(0), packet]);
}

try {
    logger.warn = message => warnings.push(message);
    logger.error = message => errors.push(message);
    for (const [version, draft] of [
        [3, 20],
        [4, 19],
        [4, 20]
    ]) {
        const { session, mutations } = harness(draft);
        const parse = (packet, flags = 0, context = null, peerType = BmpConst.BMP_PEER_TYPE.GLOBAL) =>
            session.parseRouteMonitoringBgpUpdates(
                payload(packet, version, draft),
                0,
                version,
                context,
                flags,
                peerType
            );

        for (const [hex, width, expected] of [
            ['0201000007d1', 4, '2001'],
            ['0201000003e9', 4, '1001'],
            ['020107d1', 2, '2001'],
            ['020200c803e9', 2, '200 1001'],
            ['02020000fde80000fde9020100011170', 4, '65000 65001 70000']
        ]) {
            for (const flags of [0, 0x20, 0x30, 0x60]) {
                warnings.length = 0;
                errors.length = 0;
                const packet = update(hex);
                const raw = Buffer.from(packet);
                const result = parse(packet, flags);
                assert.equal(result.error, undefined);
                assert.equal(result.updates.length, 1);
                const parsed = result.updates[0].parsedBgpUpdate;
                assert.equal(parsed.asnSize, width);
                assert.equal(session.extractRouteAttributes(parsed).asPath, expected);
                assert.deepEqual(packet, raw, 'width detection must not rewrite the captured packet');
                const mismatch = width !== (flags & 0x20 ? 2 : 4);
                assert.equal(warnings.length, mismatch ? 1 : 0);
                assert.equal(parsed.warnings.length, mismatch ? 1 : 0);
                assert.equal(errors.length, 0, 'successful fallback must not log a rejected UPDATE');
                if (mismatch) {
                    assert.match(warnings[0], /BMP AS_PATH encoding mismatch/);
                    assert.match(warnings[0], /192\.0\.2\.10:50000/);
                    assert.match(warnings[0], new RegExp(`decoded ${width}-byte ASNs`));
                }
            }
        }

        for (const flags of [0, 0x20]) {
            const mixed = parse(Buffer.concat([update('020107d1'), update('0201000007d1')]), flags);
            assert.deepEqual(
                mixed.updates.map(item => item.parsedBgpUpdate.asnSize),
                [2, 4]
            );
            for (const hex of ['02020001000202010003', '0202fde8fde90201fdea']) {
                warnings.length = 0;
                const packet = update(hex);
                assert.equal(parseBgpPacket(packet, { asnSize: 2 }).valid, true);
                assert.equal(parseBgpPacket(packet, { asnSize: 4 }).valid, true);
                const width = flags & 0x20 ? 2 : 4;
                const expected = { ...parseBgpPacket(packet, { asnSize: width }), asnSize: width };
                const parsed = parse(packet, flags).updates[0].parsedBgpUpdate;
                assert.equal(parsed.asnSize, width, 'the A flag must resolve ambiguous AS_PATH encodings');
                assert.equal(
                    session.extractRouteAttributes(parsed).asPath,
                    session.extractRouteAttributes(expected).asPath
                );
                assert.equal(warnings.length, 0, 'valid declared encoding must not trigger fallback');
            }
        }

        for (const [hex, width] of [
            ['020107d1', 2],
            ['0201000007d1', 4]
        ]) {
            const context = {
                asnSize: 4,
                isAddPathReceiveEnabled: () => true,
                getAddPathReceiveInfo: () => ({ enabled: true })
            };
            const result = parse(update(hex, Buffer.concat([u32(42), Buffer.from([24, 203, 0, 113])])), 0x20, context);
            assert.equal(result.error, undefined);
            assert.equal(result.updates[0].parsedBgpUpdate.asnSize, width);
            assert.equal(result.updates[0].parsedBgpUpdate.nlri[0].pathId, 42);
            assert.equal(context.asnSize, 4, 'a shared Peer Up context must not be mutated');
        }

        const as4Path = attribute(17, Buffer.from('020100011170', 'hex'));
        for (const [hex, flags, width, expected] of [
            ['0202fde85ba0', 0, 2, '65000 70000'],
            ['02020000fde800005ba0', 0x20, 4, '65000 23456']
        ]) {
            const result = parse(update(hex, undefined, [as4Path]), flags);
            const parsed = result.updates[0].parsedBgpUpdate;
            assert.equal(parsed.asnSize, width);
            assert.equal(session.extractRouteAttributes(parsed).asPath, expected);
        }

        for (const hex of ['020107', '0200', '0501000007d1', '0202000007']) {
            for (const flags of [0, 0x20]) {
                warnings.length = 0;
                assert.ok(parse(update(hex), flags).error, 'invalid AS_PATH must fail both width checks');
                assert.equal(warnings.length, 0);
            }
        }
        const invalidOrigin = update('020107d1', undefined, [attribute(1, Buffer.from([3]))]);
        assert.ok(parse(invalidOrigin, 0).error, 'ASN inference must not mask other invalid attributes');
        assert.ok(parse(update('020107d1', Buffer.from([33])), 0).error, 'NLRI validation remains mandatory');
        assert.ok(parse(update('0201000007d1').subarray(0, -1), 0x20).error);
        assert.ok(parse(Buffer.concat([update('0201000007d1'), update('020107')]), 0x20).error);

        warnings.length = 0;
        const eor = parse(builders.endOfRibUpdate(), 0x20);
        assert.equal(eor.error, undefined);
        assert.equal(warnings.length, 0, 'an UPDATE without AS_PATH has no width mismatch');
        const emptyPath = parse(update(''), 0x20);
        assert.equal(emptyPath.error, undefined);
        assert.equal(warnings.length, 0, 'an empty AS_PATH has no width mismatch');
        const locRib = parse(update('0201000007d1'), 0xa0, null, BmpConst.BMP_PEER_TYPE.LOCAL_RIB);
        assert.equal(locRib.updates[0].parsedBgpUpdate.asnSize, 4);
        assert.ok(parse(update('020107d1'), 0xa0, null, BmpConst.BMP_PEER_TYPE.LOCAL_RIB).error);
        assert.equal(warnings.length, 0);

        session.processMessage(builders.bmpMessage(3, builders.peerUpPayload(), version));
        const header = Buffer.from(builders.peerUpPayload().subarray(0, 42));
        header[1] = 0x20;
        mutations.length = 0;
        session.processMessage(
            builders.bmpMessage(0, Buffer.concat([header, payload(update('0201000007d1'), version, draft)]), version)
        );
        const routes = mutations.filter(item => item.route);
        assert.equal(routes.length, 1, 'an inferred UPDATE must reach persistence');
        assert.equal(JSON.parse(routes[0].route.attrJson).asPath, '2001');
        mutations.length = 0;
        session.processMessage(
            builders.bmpMessage(
                0,
                Buffer.concat([
                    header,
                    payload(Buffer.concat([update('0201000007d1'), update('020107')]), version, draft)
                ]),
                version
            )
        );
        assert.equal(mutations.length, 0, 'a corrupt later UPDATE must reject the entire BMP message');
    }

    assert.equal(parseBgpPacket(update('0201000007d1'), { asnSize: 2 }).valid, false);
    assert.equal(parseBgpPacket(update('020107d1'), { asnSize: 4 }).valid, false);
} finally {
    logger.warn = originalWarn;
    logger.error = originalError;
}

console.log('BMP A-first AS_PATH width fallback, ambiguity handling, warnings and strict boundary tests passed');
