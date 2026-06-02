/**
 * RPKI PDU 编码 / 协议测试
 * 对照：RFC 6810 (v0)、RFC 8210 (v1)、draft-ietf-sidrops-8210bis (v2)
 *
 * 使用方法：node test/rpki_pdu_test.js
 *
 * 注意：本测试不需要启动 Electron。它通过 mock socket 收集 RpkiSession
 * 发出的字节，然后对照 RFC 的 wire format 逐字段校验。
 */

const path = require('path');

// 静默 logger（避免写文件副作用）
process.env.NODE_ENV = 'test';

const RpkiSession = require(path.join(__dirname, '..', 'electron', 'worker', 'rpkiSession.js'));
const RpkiRoa = require(path.join(__dirname, '..', 'electron', 'worker', 'rpkiRoa.js'));
const RpkiRouterKey = require(path.join(__dirname, '..', 'electron', 'worker', 'rpkiRouterKey.js'));
const RpkiAspa = require(path.join(__dirname, '..', 'electron', 'worker', 'rpkiAspa.js'));
const RpkiConst = require(path.join(__dirname, '..', 'electron', 'const', 'rpkiConst.js'));
const BgpConst = require(path.join(__dirname, '..', 'electron', 'const', 'bgpConst.js'));

// ============ 测试基础设施 ============
let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label) {
    if (cond) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        failures.push(label);
        console.log(`  ✗ ${label}`);
    }
}

function assertEq(actual, expected, label) {
    const ok = actual === expected;
    if (!ok) {
        label = `${label} (expected=${expected}, actual=${actual})`;
    }
    assert(ok, label);
}

function assertBufEq(actualBuf, expectedHex, label) {
    const actualHex = Buffer.from(actualBuf).toString('hex').toUpperCase();
    const expHex = expectedHex.replace(/\s+/g, '').toUpperCase();
    const ok = actualHex === expHex;
    if (!ok) {
        label = `${label}\n      expected: ${expHex}\n      actual:   ${actualHex}`;
    }
    assert(ok, label);
}

function section(name) {
    console.log(`\n[${name}]`);
}

// ============ Mock ============
function makeMockSession(version = RpkiConst.RPKI_PROTOCOL_VERSION.V2) {
    const sentBuffers = [];
    const sentEvents = [];
    const messageHandler = {
        sendEvent: (type, payload) => sentEvents.push({ type, payload })
    };
    const rpkiWorker = {
        rpkiRoaMap: new Map(),
        rpkiRouterKeyMap: new Map(),
        rpkiAspaMap: new Map()
    };
    const session = new RpkiSession(messageHandler, rpkiWorker);
    session.socket = {
        destroyed: false,
        write: buf => sentBuffers.push(Buffer.from(buf))
    };
    session.localIp = '127.0.0.1';
    session.localPort = 1280;
    session.remoteIp = '10.0.0.1';
    session.remotePort = 12345;
    session.protocolVersion = version;
    session.sessionId = 0xabcd;
    return { session, sentBuffers, sentEvents, rpkiWorker };
}

// ============ Tests ============

section('PDU Header parsing (RFC 6810 §5)');
{
    const { session } = makeMockSession();
    // version=1, type=2 (RESET_QUERY), reserved=0, length=8
    const buf = Buffer.from('01020000 00000008'.replace(/\s/g, ''), 'hex');
    const h = session.parseRpkiHeader(buf);
    assertEq(h.version, 1, 'header.version');
    assertEq(h.type, 2, 'header.type (RESET_QUERY)');
    assertEq(h.reserved, 0, 'header.reserved');
    assertEq(h.length, 8, 'header.length');
}

section('Cache Response PDU (type 3, RFC 6810 §5.5)');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V1);
    session.sessionId = 0xabcd;
    session.sendCacheResponse();
    // version=1, type=3, sessionId=0xABCD, length=8
    assertBufEq(sentBuffers[0], '01 03 ABCD 00000008', 'Cache Response wire format');
}

section('Cache Reset PDU (type 8, RFC 6810 §5.9)');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V1);
    session.sendCacheReset();
    // version=1, type=8, reserved=0, length=8
    assertBufEq(sentBuffers[0], '01 08 0000 00000008', 'Cache Reset wire format');
}

section('IPv4 Prefix PDU (type 4, RFC 6810 §5.6)');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V1);
    const roa = new RpkiRoa('192.0.2.0', 24, 65001, 24, BgpConst.IP_TYPE.IPV4);
    session.sendIPv4Prefix(roa);
    // version=1, type=4, reserved=0, length=20, flags=1(announce), prefixLen=24, maxLen=24, zero=0
    //   IPv4=192.0.2.0(C0000200), ASN=65001(0000FDE9)
    assertBufEq(
        sentBuffers[0],
        '01 04 0000 00000014 01 18 18 00 C0000200 0000FDE9',
        'IPv4 Prefix wire format (announce)'
    );
    assertEq(sentBuffers[0].length, 20, 'IPv4 Prefix total length = 20');
}

section('IPv4 Prefix withdraw');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V1);
    const roa = new RpkiRoa('192.0.2.0', 24, 65001, 24, BgpConst.IP_TYPE.IPV4);
    session.withdrawIPv4Prefix(roa);
    assertEq(sentBuffers[0][8], 0x00, 'Withdraw flag = 0');
}

section('IPv6 Prefix PDU (type 6, RFC 6810 §5.7)');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V1);
    const roa = new RpkiRoa('2001:db8::', 32, 65001, 32, BgpConst.IP_TYPE.IPV6);
    session.sendIPv6Prefix(roa);
    // length = 32
    assertEq(sentBuffers[0].length, 32, 'IPv6 Prefix total length = 32');
    assertEq(sentBuffers[0].readUInt32BE(4), 32, 'IPv6 length field = 32');
    assertEq(sentBuffers[0][1], 6, 'IPv6 PDU type = 6');
    assertEq(sentBuffers[0].readUInt32BE(28), 65001, 'IPv6 trailing ASN');
}

section('End of Data v0 (RFC 6810 §5.8)');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V0);
    session.sendEndOfData();
    // version=0, type=7, sessionId=0xABCD, length=12, serial=0
    assertBufEq(sentBuffers[0], '00 07 ABCD 0000000C 00000000', 'End of Data v0 wire format');
    assertEq(sentBuffers[0].length, 12, 'End of Data v0 length = 12');
}

section('End of Data v1+ (RFC 8210 §5.8)');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V1);
    session.sendEndOfData();
    // version=1, type=7, sessionId=0xABCD, length=24, serial=1, refresh=3600, retry=600, expire=7200
    assertBufEq(
        sentBuffers[0],
        '01 07 ABCD 00000018 00000001 00000E10 00000258 00001C20',
        'End of Data v1 wire format'
    );
    assertEq(sentBuffers[0].length, 24, 'End of Data v1 length = 24');
}

section('End of Data v2');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V2);
    session.sendEndOfData();
    assertEq(sentBuffers[0][0], 2, 'End of Data v2 version byte');
    assertEq(sentBuffers[0].length, 24, 'End of Data v2 length = 24');
}

section('Router Key PDU (type 9, v1+, RFC 8210 §5.10)');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V1);
    const ski = '0123456789ABCDEF0123456789ABCDEF01234567'; // 20 bytes hex
    const spki = 'AABBCCDD'; // 4 bytes
    const rk = new RpkiRouterKey(ski, 65001, spki);
    session.sendRouterKey(rk);
    // Total = 8 (header) + 20 (SKI) + 4 (ASN) + 4 (SPKI) = 36
    assertEq(sentBuffers[0].length, 36, 'Router Key total = 8+20+4+4 = 36');
    assertEq(sentBuffers[0].readUInt32BE(4), 36, 'Router Key length field = 36');
    assertEq(sentBuffers[0][1], 9, 'Router Key PDU type = 9');
    assertEq(sentBuffers[0][2], RpkiConst.RPKI_FLAGS.UPDATE, 'Router Key flag = UPDATE');
    assertEq(sentBuffers[0][3], 0, 'Router Key zero byte');
    assertEq(
        sentBuffers[0].slice(8, 28).toString('hex').toUpperCase(),
        ski.toUpperCase(),
        'Router Key SKI body'
    );
    assertEq(sentBuffers[0].readUInt32BE(28), 65001, 'Router Key ASN');
    assertEq(sentBuffers[0].slice(32).toString('hex').toUpperCase(), 'AABBCCDD', 'Router Key SPKI');
}

section('Router Key cannot send on v0');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V0);
    const rk = new RpkiRouterKey('0123456789ABCDEF0123456789ABCDEF01234567', 1, 'AA');
    session.sendRouterKey(rk);
    assertEq(sentBuffers.length, 0, 'No Router Key sent on v0');
}

section('ASPA PDU (type 11, v2, draft-ietf-sidrops-8210bis §5.12)');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V2);
    const aspa = new RpkiAspa(65000, [65001, 65002], 0); // afiFlags ignored in PDU per latest draft
    session.sendAspa(aspa);
    // Total = 8 (header) + 4 (customer) + 4*2 (providers) = 20
    assertEq(sentBuffers[0].length, 20, 'ASPA total = 8+4+8 = 20');
    assertEq(sentBuffers[0].readUInt32BE(4), 20, 'ASPA length field = 20');
    assertEq(sentBuffers[0][0], 2, 'ASPA version = 2');
    assertEq(sentBuffers[0][1], 11, 'ASPA PDU type = 11');
    assertEq(sentBuffers[0][2], RpkiConst.RPKI_FLAGS.UPDATE, 'ASPA flag = UPDATE');
    assertEq(sentBuffers[0][3], 0, 'ASPA byte 3 = zero (per latest draft, no AFI flags)');
    assertEq(sentBuffers[0].readUInt32BE(8), 65000, 'ASPA Customer ASN');
    assertEq(sentBuffers[0].readUInt32BE(12), 65001, 'ASPA Provider ASN[0]');
    assertEq(sentBuffers[0].readUInt32BE(16), 65002, 'ASPA Provider ASN[1]');
}

section('ASPA PDU LEGACY format (draft-10, Huawei VRP compat)');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V2);
    session.aspaFormat = RpkiConst.RPKI_ASPA_FORMAT.LEGACY;
    const aspa = new RpkiAspa(65000, [65001, 65002], RpkiConst.RPKI_ASPA_AFI_FLAGS.IPV4 | RpkiConst.RPKI_ASPA_AFI_FLAGS.IPV6);
    session.sendAspa(aspa);
    // Total = 8 (header) + 4 (provider count) + 4 (customer) + 4*2 (providers) = 24
    assertEq(sentBuffers[0].length, 24, 'ASPA LEGACY total = 8+4+4+8 = 24');
    assertEq(sentBuffers[0].readUInt32BE(4), 24, 'ASPA LEGACY length field = 24');
    assertEq(sentBuffers[0][0], 2, 'ASPA LEGACY version = 2');
    assertEq(sentBuffers[0][1], 11, 'ASPA LEGACY PDU type = 11');
    assertEq(sentBuffers[0][2], RpkiConst.RPKI_FLAGS.UPDATE, 'ASPA LEGACY flag = UPDATE');
    assertEq(sentBuffers[0][3], 0x03, 'ASPA LEGACY byte 3 = AFI flags (IPv4|IPv6)');
    assertEq(sentBuffers[0].readUInt32BE(8), 2, 'ASPA LEGACY Provider AS Count = 2');
    assertEq(sentBuffers[0].readUInt32BE(12), 65000, 'ASPA LEGACY Customer ASN');
    assertEq(sentBuffers[0].readUInt32BE(16), 65001, 'ASPA LEGACY Provider ASN[0]');
    assertEq(sentBuffers[0].readUInt32BE(20), 65002, 'ASPA LEGACY Provider ASN[1]');
}

section('ASPA cannot send on v1');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V1);
    const aspa = new RpkiAspa(65000, [65001], 0);
    session.sendAspa(aspa);
    assertEq(sentBuffers.length, 0, 'No ASPA sent on v1');
}

section('Error Report PDU (type 10, RFC 6810 §5.10)');
{
    const { session, sentBuffers } = makeMockSession(RpkiConst.RPKI_PROTOCOL_VERSION.V1);
    session.sendError(RpkiConst.RPKI_ERROR_CODE.UNSUPPORTED_PROTOCOL_VERSION);
    // version=1, type=10, errorCode=4, length=16, encapLen=0, textLen=0
    assertBufEq(
        sentBuffers[0],
        '01 0A 0004 00000010 00000000 00000000',
        'Error Report wire format (empty encap & text)'
    );
    assertEq(sentBuffers[0].length, 16, 'Error Report length = 16');
}

section('Version negotiation - handleResetQuery (RFC 8210 §7)');
{
    // v0 client → server accepts
    const { session, sentBuffers } = makeMockSession();
    session.protocolVersion = RpkiConst.RPKI_PROTOCOL_VERSION.V0;
    session.handleResetQuery({ version: 0, type: 2, reserved: 0, length: 8 }, Buffer.alloc(8));
    assertEq(session.protocolVersion, 0, 'Negotiated to v0 for v0 client');
    assert(sentBuffers.length >= 2, 'Cache Response + End of Data sent for v0');
}
{
    // v1 client → server accepts, sends Router Keys
    const { session, sentBuffers, rpkiWorker } = makeMockSession();
    rpkiWorker.rpkiRouterKeyMap.set(
        'k',
        new RpkiRouterKey('0123456789ABCDEF0123456789ABCDEF01234567', 100, 'AA')
    );
    session.protocolVersion = RpkiConst.RPKI_PROTOCOL_VERSION.V0;
    session.handleResetQuery({ version: 1, type: 2, reserved: 0, length: 8 }, Buffer.alloc(8));
    assertEq(session.protocolVersion, 1, 'Negotiated to v1');
    const hasRouterKey = sentBuffers.some(b => b[1] === RpkiConst.RPKI_MSG_TYPE.ROUTER_KEY);
    assert(hasRouterKey, 'Router Key PDU sent for v1 client');
}
{
    // v2 client → server accepts, sends Router Keys + ASPA
    const { session, sentBuffers, rpkiWorker } = makeMockSession();
    rpkiWorker.rpkiAspaMap.set('a', new RpkiAspa(65000, [65001], 0));
    session.protocolVersion = RpkiConst.RPKI_PROTOCOL_VERSION.V0;
    session.handleResetQuery({ version: 2, type: 2, reserved: 0, length: 8 }, Buffer.alloc(8));
    assertEq(session.protocolVersion, 2, 'Negotiated to v2');
    const hasAspa = sentBuffers.some(b => b[1] === RpkiConst.RPKI_MSG_TYPE.ASPA);
    assert(hasAspa, 'ASPA PDU sent for v2 client');
}
{
    // v3 client (unsupported) → server rejects with Error Report code=4
    const { session, sentBuffers } = makeMockSession();
    session.protocolVersion = RpkiConst.RPKI_PROTOCOL_VERSION.V0;
    session.handleResetQuery({ version: 3, type: 2, reserved: 0, length: 8 }, Buffer.alloc(8));
    assertEq(sentBuffers.length, 1, 'Only Error Report sent for unsupported version');
    assertEq(sentBuffers[0][1], RpkiConst.RPKI_MSG_TYPE.ERROR_REPORT, 'PDU is Error Report');
    assertEq(
        sentBuffers[0].readUInt16BE(2),
        RpkiConst.RPKI_ERROR_CODE.UNSUPPORTED_PROTOCOL_VERSION,
        'Error code = 4 (UNSUPPORTED_PROTOCOL_VERSION)'
    );
}

section('Buffered message reassembly');
{
    const { session } = makeMockSession();
    let processed = 0;
    session.processMessage = () => processed++;
    // 拼接两个完整 PDU + 一个不完整的
    const pdu1 = Buffer.from('010200000000000801020000', 'hex'); // first 12 bytes = 1 complete + 4 stray
    // 实际：第一个 8 字节是 Reset Query；剩余 4 字节不够下一个 PDU
    session.recvMsg(pdu1);
    assertEq(processed, 1, 'One complete PDU processed, partial buffered');
}

section('Version mismatch in Serial Query (RFC 8210 §7)');
{
    const { session, sentBuffers } = makeMockSession();
    session.protocolVersion = RpkiConst.RPKI_PROTOCOL_VERSION.V2;
    // Serial Query header with mismatched version (v1)
    const buf = Buffer.alloc(12);
    buf[0] = 1; // version mismatch
    buf[1] = RpkiConst.RPKI_MSG_TYPE.SERIAL_QUERY;
    buf.writeUInt16BE(0xabcd, 2);
    buf.writeUInt32BE(12, 4);
    buf.writeUInt32BE(0, 8);
    session.handleSerialQuery({ version: 1, type: 1, reserved: 0xabcd, length: 12 }, buf);
    assertEq(sentBuffers.length, 1, 'Error Report sent on version mismatch');
    assertEq(
        sentBuffers[0].readUInt16BE(2),
        RpkiConst.RPKI_ERROR_CODE.UNEXPECTED_PROTOCOL_VERSION,
        'Error code = 8 (UNEXPECTED_PROTOCOL_VERSION)'
    );
}

// ============ 收尾 ============
console.log(`\n========================================`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
    console.log(`\nFailures:`);
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
}
process.exit(0);
