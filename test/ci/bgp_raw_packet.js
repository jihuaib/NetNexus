const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter } = require('node:events');

process.env.NODE_ENV = 'test';

const BgpConst = require('../../electron/const/bgpConst');
const BgpSession = require('../../electron/worker/bgp/bgpSession');
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpApp = require('../../electron/app/bgpApp');
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
const { parseBgpRawPacket } = require('../../electron/utils/bgp/bgpRawPacket');

const STATE = BgpConst.BGP_PEER_STATE;
const TYPE = BgpConst.BGP_PACKET_TYPE;

function frame(type, body = Buffer.alloc(0)) {
    const header = Buffer.alloc(19, 0xff);
    header.writeUInt16BE(19 + body.length, 16);
    header[18] = type;
    return Buffer.concat([header, body]);
}

function update(attributes, nlri = Buffer.alloc(0)) {
    const lengths = Buffer.alloc(4);
    lengths.writeUInt16BE(attributes.length, 2);
    return frame(TYPE.UPDATE, Buffer.concat([lengths, attributes, nlri]));
}

const keepalive = frame(TYPE.KEEPALIVE);
const originAsPath = Buffer.from('400101004002040201fde9', 'hex');
// Unknown optional/transitive attribute, including its extended length and partial flag.
// A raw send must preserve even attributes the application's route model cannot represent.
const unknownAttribute = Buffer.from('f0fe000500ff7e8099', 'hex');
const ipv4Update = update(
    Buffer.concat([originAsPath, Buffer.from('400304c0000201', 'hex'), unknownAttribute]),
    Buffer.from('18cb0071', 'hex')
);
const mpReachValue = Buffer.from('0002011020010db8000000000000000000000001004020010db800010000', 'hex');
const ipv6Update = update(
    Buffer.concat([originAsPath, Buffer.from([0x80, 14, mpReachValue.length]), mpReachValue, unknownAttribute])
);
const peerOpen = frame(TYPE.OPEN, Buffer.from('04fde90000c63364021002060104000100010206010400020001', 'hex'));

function spacedHex(buffer) {
    return buffer.toString('hex').toUpperCase().match(/.{2}/g).join(' \t\r\n');
}

function makeSession(peerIp = '192.0.2.2') {
    const session = new BgpSession(0, peerIp, new Map(), { sendEvent() {} });
    session.localAs = 65000;
    session.routerId = '192.0.2.1';
    session.holdTime = 0;
    return session;
}

function makeSocket() {
    const socket = new EventEmitter();
    Object.assign(socket, {
        destroyed: false,
        writable: true,
        writableEnded: false,
        writes: [],
        callbacks: [],
        write(buffer, callback) {
            this.writes.push(Buffer.from(buffer));
            this.callbacks.push(callback);
            return true;
        }
    });
    return socket;
}

function establishedSession() {
    const session = makeSession();
    session.sessState = STATE.ESTABLISHED;
    session.socket = makeSocket();
    return session;
}

function nextTurn() {
    return new Promise(resolve => setImmediate(resolve));
}

async function waitFor(predicate, description, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    do {
        const result = predicate();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${description}`);
}

function testValidation() {
    for (const invalid of [
        undefined,
        null,
        42,
        {},
        Buffer.from('ff', 'hex'),
        '',
        ' \r\n\t',
        'f',
        'fg',
        '0xff',
        'ff:ff'
    ]) {
        assert.throws(() => parseBgpRawPacket(invalid), Error, `invalid hex must be rejected: ${String(invalid)}`);
    }

    const packets = [ipv4Update, ipv6Update, keepalive];
    const combined = Buffer.concat(packets);
    const parsed = parseBgpRawPacket(spacedHex(combined));
    assert.deepEqual(parsed.buffer, combined);
    assert.equal(parsed.byteLength, combined.length);
    assert.equal(parsed.packetCount, packets.length);
    assert.deepEqual(
        parsed.packets.map(({ offset, length, type }) => ({ offset, length, type })),
        [
            { offset: 0, length: ipv4Update.length, type: TYPE.UPDATE },
            { offset: ipv4Update.length, length: ipv6Update.length, type: TYPE.UPDATE },
            { offset: ipv4Update.length + ipv6Update.length, length: 19, type: TYPE.KEEPALIVE }
        ]
    );

    const wrongMarker = Buffer.from(ipv4Update);
    wrongMarker[7] = 0;
    const tooShortLength = Buffer.from(keepalive);
    tooShortLength.writeUInt16BE(18, 16);
    const invalidFrames = [
        Buffer.from([0xff]),
        keepalive.subarray(0, 18),
        ipv4Update.subarray(0, -1),
        wrongMarker,
        tooShortLength,
        frame(0),
        frame(6),
        frame(TYPE.OPEN, Buffer.alloc(9)),
        frame(TYPE.UPDATE, Buffer.alloc(3)),
        frame(TYPE.NOTIFICATION, Buffer.alloc(1)),
        frame(TYPE.KEEPALIVE, Buffer.alloc(1)),
        frame(TYPE.ROUTE_REFRESH, Buffer.alloc(3)),
        frame(TYPE.UPDATE, Buffer.alloc(4097 - 19)),
        Buffer.concat([ipv4Update, wrongMarker]),
        Buffer.concat([ipv4Update, Buffer.from([0xff])])
    ];
    for (const packet of invalidFrames) {
        assert.throws(() => parseBgpRawPacket(packet.toString('hex')), Error, `invalid frame (${packet.length} bytes)`);
    }
    assert.equal(parseBgpRawPacket(frame(TYPE.UPDATE, Buffer.alloc(4096 - 19)).toString('hex')).byteLength, 4096);
    for (const packet of [
        peerOpen,
        frame(TYPE.NOTIFICATION, Buffer.from([6, 0])),
        frame(TYPE.ROUTE_REFRESH, Buffer.from([0, 2, 0, 1]))
    ]) {
        assert.deepEqual(parseBgpRawPacket(packet.toString('hex')).buffer, packet);
    }
}

async function testSessionSend() {
    for (const state of Object.values(STATE).filter(state => state !== STATE.ESTABLISHED)) {
        const session = establishedSession();
        session.sessState = state;
        await assert.rejects(() => session.sendRawPacket(ipv4Update.toString('hex')));
        assert.equal(session.socket.writes.length, 0, `state ${state} must never write raw data`);
    }
    for (const state of [STATE.IDLE, STATE.CONNECT, STATE.ACTIVE, STATE.OPEN_SENT]) {
        const session = establishedSession();
        session.sessState = state;
        session.recvMsg(keepalive);
        assert.equal(session.sessState, state, 'KEEPALIVE without the peer OPEN cannot establish a BGP session');
        await assert.rejects(() => session.sendRawPacket(ipv4Update.toString('hex')));
    }
    for (const unavailable of [
        null,
        { destroyed: true },
        { writable: false },
        { writableEnded: true },
        { writableFinished: true },
        { readableEnded: true },
        { connecting: true }
    ]) {
        const session = establishedSession();
        const socket = session.socket;
        if (unavailable === null) session.socket = null;
        else Object.assign(socket, unavailable);
        await assert.rejects(() => session.sendRawPacket(ipv4Update.toString('hex')));
        assert.equal(socket.writes.length, 0);
    }

    const session = establishedSession();
    const socket = session.socket;
    const combined = Buffer.concat([ipv4Update, ipv6Update]);
    await assert.rejects(() => session.sendRawPacket(combined.toString('hex') + 'ff'));
    assert.equal(socket.writes.length, 0, 'validate the entire batch before sending its first byte');

    let completed = false;
    const sending = session.sendRawPacket(spacedHex(combined)).then(result => {
        completed = true;
        return result;
    });
    await nextTurn();
    assert.equal(completed, false, 'write return value alone does not prove completion');
    assert.deepEqual(Buffer.concat(socket.writes), combined);
    socket.callbacks[0]();
    assert.deepEqual(await sending, { peerIp: session.peerIp, byteLength: combined.length, packetCount: 2 });
    for (const event of ['close', 'end', 'error']) assert.equal(socket.listenerCount(event), 0);

    const backpressured = establishedSession();
    const originalWrite = backpressured.socket.write;
    backpressured.socket.write = function (...args) {
        originalWrite.apply(this, args);
        return false;
    };
    let settled = false;
    const blockedSend = backpressured.sendRawPacket(ipv6Update.toString('hex')).then(result => {
        settled = true;
        return result;
    });
    await nextTurn();
    assert.equal(settled, false, 'backpressure must remain pending until the write callback');
    backpressured.socket.emit('drain');
    await nextTurn();
    assert.equal(settled, false, 'drain must not bypass write completion');
    backpressured.socket.callbacks[0]();
    assert.equal((await blockedSend).byteLength, ipv6Update.length);

    for (const failure of ['callback', 'throw', 'error', 'close', 'end', 'replaced', 'state', 'destroyed']) {
        const failing = establishedSession();
        const failedSocket = failing.socket;
        if (failure === 'throw')
            failedSocket.write = () => {
                throw new Error('raw write failed');
            };
        await assert.rejects(
            () => {
                const pending = failing.sendRawPacket(ipv4Update.toString('hex'));
                if (failure === 'callback') failedSocket.callbacks[0](new Error('raw write failed'));
                if (failure === 'error') failedSocket.emit('error', new Error('raw write failed'));
                if (failure === 'close' || failure === 'end') failedSocket.emit(failure);
                if (failure === 'replaced') failing.socket = makeSocket();
                if (failure === 'state') failing.sessState = STATE.IDLE;
                if (failure === 'destroyed') failedSocket.destroyed = true;
                if (['replaced', 'state', 'destroyed'].includes(failure)) failedSocket.callbacks[0]();
                return pending;
            },
            Error,
            `write failure ${failure} must not report success`
        );
        // Real sockets can invoke the callback after their close/error event.
        if (['close', 'end', 'error'].includes(failure)) failedSocket.callbacks[0]();
        for (const event of ['close', 'end', 'error']) assert.equal(failedSocket.listenerCount(event), 0);
    }
}

async function testWorkerDispatch() {
    const endpoint = new EventEmitter();
    const responses = [];
    endpoint.postMessage = message => responses.push(message);
    const originalInit = WorkerMessageHandler.prototype.init;
    let worker;
    WorkerMessageHandler.prototype.init = function () {
        this.parentEndpoint = endpoint;
        return originalInit.call(this);
    };
    try {
        worker = new BgpWorker();
    } finally {
        WorkerMessageHandler.prototype.init = originalInit;
    }
    let sequence = 0;
    const request = async config => {
        const messageId = `raw-${++sequence}`;
        endpoint.emit('message', { messageId, op: BgpConst.BGP_REQ_TYPES.SEND_RAW_PACKET, data: config });
        const response = await waitFor(() => responses.find(item => item.messageId === messageId), messageId);
        assert.equal(responses.filter(item => item.messageId === messageId).length, 1);
        return response;
    };
    assert.notEqual(BgpConst.BGP_REQ_TYPES.SEND_RAW_PACKET, undefined);
    assert.equal(worker.messageHandler.handlers.has(BgpConst.BGP_REQ_TYPES.SEND_RAW_PACKET), true);
    for (const config of [
        undefined,
        {},
        { peerIp: 'not-an-ip', packetHex: 'ff' },
        { peerIp: '192.0.2.2', packetHex: ipv4Update.toString('hex') }
    ]) {
        assert.equal((await request(config)).status, 'error');
    }
    for (const peerIp of ['192.0.2.2', '2001:db8::2']) {
        const session = establishedSession();
        session.peerIp = peerIp;
        session.socket.write = function (buffer, callback) {
            this.writes.push(Buffer.from(buffer));
            setImmediate(callback);
            return true;
        };
        worker.bgpSessionMap.set(BgpSession.makeKey(0, peerIp), session);
        const config = { vrfIndex: 0, peerIp, packetHex: spacedHex(ipv6Update) };
        for (const vrfIndex of [-1, '0', 1.5, 1]) {
            assert.equal((await request({ ...config, vrfIndex })).status, 'error');
        }
        session.sessState = STATE.OPEN_CONFIRM;
        assert.equal((await request(config)).status, 'error');
        assert.equal(session.socket.writes.length, 0);
        session.sessState = STATE.ESTABLISHED;
        const response = await request(config);
        assert.equal(response.status, 'success', response.msg);
        assert.deepEqual(response.data, { peerIp, byteLength: ipv6Update.length, packetCount: 1 });
        assert.deepEqual(session.socket.writes[0], ipv6Update);
        assert.equal((await request({ ...config, packetHex: 'not hex' })).status, 'error');
        if (peerIp.includes(':')) {
            assert.equal((await request({ ...config, peerIp: '2001:0db8:0:0:0:0:0:2' })).status, 'success');
        }
        session.handleSocketClosed(session.socket);
        assert.equal((await request(config)).status, 'error');
    }
    await nextTurn();
    assert.equal(responses.length, sequence, 'each IPC operation must produce exactly one response');
}

async function testAppIpc() {
    const handlers = new Map();
    const app = new BgpApp({ handle: (channel, handler) => handlers.set(channel, handler) }, {});
    const send = handlers.get('bgp:sendRawPacket');
    assert.equal(typeof send, 'function', 'main process must expose the raw-send IPC channel');
    const config = { vrfIndex: 0, peerIp: '2001:db8::2', packetHex: spacedHex(ipv6Update) };
    assert.equal((await send({}, config)).status, 'error', 'stopped BGP service must reject raw send');

    const data = { peerIp: config.peerIp, byteLength: ipv6Update.length, packetCount: 1 };
    const calls = [];
    app.worker = {
        async sendRequest(op, payload) {
            calls.push({ op, payload });
            return { status: 'success', data, msg: 'raw sent' };
        }
    };
    assert.deepEqual(await send({}, config), { status: 'success', data, msg: 'raw sent' });
    assert.deepEqual(calls, [{ op: BgpConst.BGP_REQ_TYPES.SEND_RAW_PACKET, payload: config }]);
    app.worker.sendRequest = async () => {
        throw new Error('session disconnected before write');
    };
    const failed = await send({}, config);
    assert.equal(failed.status, 'error');
    assert.equal(failed.msg, 'session disconnected before write');
    assert.equal(failed.data, null);
}

async function testTcpHandshake(host) {
    const session = makeSession(host);
    const received = [];
    const errors = [];
    let pendingBytes = Buffer.alloc(0);
    let receivedDataCount = 0;
    let accepted;
    let client;
    const server = net.createServer(socket => {
        accepted = socket;
        socket.on('error', error => errors.push(error));
        socket.on('data', data => {
            session.recvMsg(data);
            receivedDataCount += 1;
        });
        socket.on('close', () => session.handleSocketClosed(socket));
        session.tcpConnectSuccess(socket);
    });
    try {
        await assert.rejects(() => session.sendRawPacket(ipv4Update.toString('hex')));
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen({ host, port: 0, ipv6Only: host.includes(':') }, resolve);
        });
        client = net.createConnection({ host, port: server.address().port });
        client.on('error', error => errors.push(error));
        client.on('data', chunk => {
            pendingBytes = Buffer.concat([pendingBytes, chunk]);
            while (pendingBytes.length >= 19) {
                const length = pendingBytes.readUInt16BE(16);
                if (length < 19) throw new Error('Invalid BGP frame received by test peer');
                if (pendingBytes.length < length) return;
                received.push(Buffer.from(pendingBytes.subarray(0, length)));
                pendingBytes = pendingBytes.subarray(length);
            }
        });
        await waitFor(() => received.some(packet => packet[18] === TYPE.OPEN), `${host} OPEN`);
        assert.equal(session.sessState, STATE.OPEN_SENT);
        await assert.rejects(() => session.sendRawPacket(ipv4Update.toString('hex')));
        client.write(keepalive);
        await waitFor(() => receivedDataCount > 0, `${host} premature KEEPALIVE`);
        assert.equal(session.sessState, STATE.OPEN_SENT, 'TCP connection and premature KEEPALIVE are insufficient');
        await assert.rejects(() => session.sendRawPacket(ipv4Update.toString('hex')));
        client.write(peerOpen);
        await waitFor(() => session.sessState === STATE.OPEN_CONFIRM, `${host} OpenConfirm`);
        await assert.rejects(() => session.sendRawPacket(ipv6Update.toString('hex')));
        assert.equal(received.filter(packet => packet[18] === TYPE.UPDATE).length, 0);
        client.write(keepalive);
        await waitFor(() => session.sessState === STATE.ESTABLISHED, `${host} Established`);

        const ipv4Result = await session.sendRawPacket(spacedHex(ipv4Update));
        assert.equal(ipv4Result.byteLength, ipv4Update.length);
        const ipv6Result = await session.sendRawPacket(spacedHex(ipv6Update));
        assert.equal(ipv6Result.byteLength, ipv6Update.length);
        const batch = Buffer.concat([ipv6Update, ipv4Update]);
        assert.equal((await session.sendRawPacket(batch.toString('hex'))).packetCount, 2);
        await waitFor(() => received.filter(packet => packet[18] === TYPE.UPDATE).length === 4, `${host} raw updates`);
        assert.deepEqual(
            received.filter(packet => packet[18] === TYPE.UPDATE),
            [ipv4Update, ipv6Update, ipv6Update, ipv4Update]
        );
        assert.equal(errors.length, 0, errors.map(error => error.message).join(', '));
        client.destroy();
        await waitFor(() => session.sessState === STATE.IDLE, `${host} disconnect`);
        await assert.rejects(() => session.sendRawPacket(ipv4Update.toString('hex')));
        console.log(`BGP raw packets: ${host} TCP handshake, IPv4/IPv6 UPDATE bytes, and disconnect passed`);
    } finally {
        session.clearHoldTimer();
        if (client) client.destroy();
        if (accepted) accepted.destroy();
        if (server.listening) await new Promise(resolve => server.close(resolve));
    }
}

async function main() {
    testValidation();
    await testSessionSend();
    await testWorkerDispatch();
    await testAppIpc();
    await testTcpHandshake('127.0.0.1');
    await testTcpHandshake('::1');
    console.log('BGP raw packet validation, session, worker, IPv4 and IPv6 TCP tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
