'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
    NetconfClient,
    NetconfRpcError,
    NetconfTimeoutError,
    NetconfRpcCancelledError,
    NetconfConnectionError,
    NetconfProtocolError,
    DelimiterFramer,
    ChunkedFramer,
    encodeDelimiter,
    encodeChunked,
    createSshTransport,
    createHostVerifier,
    calculateFingerprints
} = require('../../electron/utils/netconf');

const BASE_10 = 'urn:ietf:params:netconf:base:1.0';
const BASE_11 = 'urn:ietf:params:netconf:base:1.1';

class FakeTransport extends EventEmitter {
    constructor() {
        super();
        this.writes = [];
        this.ended = false;
        this.destroyed = false;
    }

    write(data) {
        this.writes.push(Buffer.from(data));
        return true;
    }

    end() {
        this.ended = true;
    }

    destroy() {
        this.destroyed = true;
    }

    receive(data) {
        this.emit('data', Buffer.from(data));
    }
}

function serverHello(capabilities, sessionId = '101') {
    const list = capabilities.map(capability => `<capability>${capability}</capability>`).join('');
    return `<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities>${list}</capabilities><session-id>${sessionId}</session-id></hello>`;
}

function decodeChunkedWrite(buffer) {
    const messages = new ChunkedFramer().push(buffer);
    assert.equal(messages.length, 1);
    return messages[0];
}

function extractMessageId(xml) {
    const match = /message-id="([^"]+)"/.exec(xml);
    assert(match, 'RPC envelope must contain a message-id');
    return match[1];
}

async function runClientTests() {
    const transport = new FakeTransport();
    const client = new NetconfClient({ transport, rpcTimeout: 100, helloTimeout: 100 });
    const notifications = [];
    client.on('notification', notification => notifications.push(notification));

    const connecting = client.connect();
    assert.equal(new DelimiterFramer().push(transport.writes[0]).length, 1, 'client hello must use 1.0 delimiter');
    const earlyNotification =
        '<notification><eventTime>2026-07-18T01:02:03Z</eventTime><data><value>notification-data</value></data><changed/></notification>';
    transport.receive(
        Buffer.concat([
            encodeDelimiter(serverHello([BASE_10, BASE_11])),
            encodeChunked(earlyNotification, { chunkSize: 5 })
        ])
    );
    const session = await connecting;
    assert.equal(session.sessionId, '101');
    assert.equal(session.baseVersion, '1.1');
    assert.equal(client.connected, true);
    assert.equal(notifications.length, 1, 'bytes following hello must be decoded with negotiated framing');
    assert.equal(notifications[0].eventTime, '2026-07-18T01:02:03Z');
    assert.equal(
        notifications[0].root.data.value,
        'notification-data',
        'the rpc-reply data optimization must not make notification payloads opaque'
    );

    const firstPromise = client.rpc('<get><filter type="subtree"><a/></filter></get>');
    const secondPromise = client.rpc('<get-config><source><running/></source></get-config>');
    const firstXml = decodeChunkedWrite(transport.writes[1]);
    const secondXml = decodeChunkedWrite(transport.writes[2]);
    const firstId = /message-id="([^"]+)"/.exec(firstXml)[1];
    const secondId = /message-id="([^"]+)"/.exec(secondXml)[1];
    assert.notEqual(firstId, secondId);

    transport.receive(
        Buffer.concat([
            encodeChunked(`<rpc-reply message-id="${secondId}"><data><value>second</value></data></rpc-reply>`),
            encodeChunked(`<rpc-reply message-id="${firstId}"><ok/></rpc-reply>`)
        ])
    );
    const [firstReply, secondReply] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(firstReply.ok, true);
    assert.equal(firstReply.requestXml, firstXml);
    assert.equal(extractMessageId(firstReply.requestXml), firstReply.messageId);
    assert.equal(secondReply.messageId, secondId);
    assert.equal(secondReply.requestXml, secondXml);
    assert.equal(extractMessageId(secondReply.requestXml), secondReply.messageId);
    assert.deepEqual(secondReply.data, { value: 'second' }, 'ordinary rpc-reply data must retain object semantics');
    assert.equal(client.pending.size, 0);

    const largePromise = client.rpc('<get><filter type="subtree"><items/></filter></get>', {
        rejectOnRpcError: false
    });
    const largeRpc = decodeChunkedWrite(transport.writes[3]);
    const largeId = extractMessageId(largeRpc);
    const largeData = Array.from({ length: 20_000 }, (_value, index) => `<item><name>${index}</name></item>`).join('');
    const largeReplyXml =
        `<nc:rpc-reply xmlns:nc="${BASE_10}" message-id="${largeId}">` +
        `<nc:data>${largeData}</nc:data>` +
        '<nc:rpc-error><nc:error-type>application</nc:error-type><nc:error-tag>operation-failed</nc:error-tag>' +
        '<nc:error-severity>error</nc:error-severity><nc:error-message>large reply error</nc:error-message></nc:rpc-error>' +
        '</nc:rpc-reply>';
    transport.receive(encodeChunked(largeReplyXml));
    const largeReply = await largePromise;
    assert.equal(largeReply.messageId, largeId);
    assert.equal(largeReply.xml, largeReplyXml, 'the exact rpc-reply XML must remain available');
    assert.equal(typeof largeReply.data, 'string', 'rpc-reply data must be retained as opaque inner XML');
    assert.equal(largeReply.data, largeData);
    assert.strictEqual(largeReply.root.data, largeReply.data);
    assert.equal(largeReply.errors[0].tag, 'operation-failed', 'rpc-error fields outside opaque data must be parsed');
    assert.equal(largeReply.errors[0].message, 'large reply error');

    const largeNotificationValue = 'notification-value-'.repeat(16_384);
    transport.receive(
        encodeChunked(
            `<notification><eventTime>2026-07-18T02:03:04Z</eventTime><data><value>${largeNotificationValue}</value></data></notification>`
        )
    );
    assert.equal(notifications.length, 2);
    assert.equal(notifications[1].eventTime, '2026-07-18T02:03:04Z');
    assert.equal(
        notifications[1].root.data.value,
        largeNotificationValue,
        'large notifications must retain their parsed payload semantics'
    );

    const errorPromise = client.rpc('<edit-config><target><running/></target><config/></edit-config>');
    const errorRpc = decodeChunkedWrite(transport.writes[4]);
    const errorId = /message-id="([^"]+)"/.exec(errorRpc)[1];
    transport.receive(
        encodeChunked(
            `<rpc-reply message-id="${errorId}"><rpc-error><error-type>protocol</error-type><error-tag>operation-not-supported</error-tag><error-severity>error</error-severity><error-message xml:lang="en">not supported</error-message></rpc-error></rpc-reply>`
        )
    );
    await assert.rejects(
        errorPromise,
        error =>
            error instanceof NetconfRpcError &&
            error.errors[0].tag === 'operation-not-supported' &&
            error.requestXml === errorRpc &&
            extractMessageId(error.requestXml) === error.messageId
    );

    await assert.rejects(
        client.rpc('<get/>', { timeout: 15 }),
        error =>
            error instanceof NetconfTimeoutError &&
            error.code === 'NETCONF_RPC_TIMEOUT' &&
            error.requestXml.includes('<get/>') &&
            extractMessageId(error.requestXml) === error.messageId
    );
    assert.equal(client.pending.size, 0);

    const pendingAtDisconnect = client.rpc('<get/>');
    let closeEvents = 0;
    client.on('close', () => {
        closeEvents += 1;
    });
    client.disconnect('test disconnect');
    await assert.rejects(
        pendingAtDisconnect,
        error =>
            error instanceof NetconfConnectionError &&
            error.code === 'NETCONF_DISCONNECTED' &&
            error.requestXml.includes('<get/>') &&
            extractMessageId(error.requestXml) === error.messageId
    );
    assert.equal(transport.ended, true);
    assert.equal(client.pending.size, 0);
    assert.equal(closeEvents, 1);
}

async function runVersion10Test() {
    const transport = new FakeTransport();
    const client = new NetconfClient({
        transport,
        clientCapabilities: [BASE_10],
        rpcTimeout: 100,
        helloTimeout: 100
    });
    const connected = client.connect();
    const hello = encodeDelimiter(serverHello([BASE_10], '22'));
    transport.receive(hello.subarray(0, 4));
    transport.receive(hello.subarray(4));
    assert.equal((await connected).baseVersion, '1.0');

    const rpcPromise = client.rpc('<get/>', { messageId: 'custom-7' });
    const outgoing = new DelimiterFramer().push(transport.writes[1])[0];
    assert(outgoing.includes('message-id="custom-7"'));
    transport.receive(encodeDelimiter('<rpc-reply message-id="custom-7"><ok/></rpc-reply>'));
    const reply = await rpcPromise;
    assert.equal(reply.ok, true);
    assert.equal(reply.requestXml, outgoing);
    assert.equal(extractMessageId(reply.requestXml), reply.messageId);
    client.disconnect();
}

async function runRpcCancellationTest() {
    const transport = new FakeTransport();
    const client = new NetconfClient({
        transport,
        rpcTimeout: 100,
        helloTimeout: 100,
        initialMessageId: 12
    });
    const orphanReplies = [];
    client.on('orphan-reply', reply => orphanReplies.push(reply));

    const connected = client.connect();
    transport.receive(encodeDelimiter(serverHello([BASE_10, BASE_11], 'cancel-test')));
    await connected;

    const cancelledMessageId = client.reserveMessageId();
    assert.equal(cancelledMessageId, 12);
    assert.equal(typeof cancelledMessageId, 'number');
    const cancelledPromise = client.rpc('<get><filter type="subtree"><cancelled/></filter></get>', {
        messageId: cancelledMessageId
    });
    const survivingPromise = client.rpc('<get><filter type="subtree"><surviving/></filter></get>');
    const cancelledRequest = decodeChunkedWrite(transport.writes[1]);
    const survivingRequest = decodeChunkedWrite(transport.writes[2]);
    assert.equal(extractMessageId(cancelledRequest), '12');
    assert.equal(extractMessageId(survivingRequest), '13');
    const timedOutMessageId = client.reserveMessageId();
    assert.equal(timedOutMessageId, 14);
    assert.equal(client.pending.size, 2);

    assert.equal(client.cancelRpc(cancelledMessageId), true);
    assert.equal(client.pending.size, 1);
    assert.equal(client.connected, true);
    assert.equal(transport.ended, false);
    assert.equal(transport.destroyed, false);
    await assert.rejects(
        cancelledPromise,
        error =>
            error instanceof NetconfRpcCancelledError &&
            error.code === 'NETCONF_RPC_CANCELLED' &&
            error.messageId === '12' &&
            error.requestXml === cancelledRequest
    );

    const writesBeforeRetiredReuse = transport.writes.length;
    await assert.rejects(
        client.rpc('<get><filter type="subtree"><too-early/></filter></get>', {
            messageId: cancelledMessageId
        }),
        error => error instanceof NetconfProtocolError && error.code === 'NETCONF_RETIRED_MESSAGE_ID'
    );
    assert.equal(transport.writes.length, writesBeforeRetiredReuse);

    transport.receive(
        Buffer.concat([
            encodeChunked('<rpc-reply message-id="12"><ok/></rpc-reply>'),
            encodeChunked('<rpc-reply message-id="13"><ok/></rpc-reply>')
        ])
    );
    const survivingReply = await survivingPromise;
    assert.equal(survivingReply.ok, true);
    assert.equal(survivingReply.messageId, '13');
    assert.equal(orphanReplies.length, 1);
    assert.equal(orphanReplies[0].messageId, '12');
    assert.equal(client.pending.size, 0);
    assert.equal(client.connected, true);
    assert.equal(client.cancelRpc(cancelledMessageId), false);

    const reusedPromise = client.rpc('<get><filter type="subtree"><reused/></filter></get>', {
        messageId: cancelledMessageId
    });
    assert.equal(extractMessageId(decodeChunkedWrite(transport.writes[3])), '12');
    transport.receive(encodeChunked('<rpc-reply message-id="12"><ok/></rpc-reply>'));
    assert.equal((await reusedPromise).messageId, '12');

    const timedOutPromise = client.rpc('<get><filter type="subtree"><timed-out/></filter></get>', {
        messageId: timedOutMessageId,
        timeout: 10
    });
    await assert.rejects(
        timedOutPromise,
        error => error instanceof NetconfTimeoutError && error.code === 'NETCONF_RPC_TIMEOUT'
    );
    await assert.rejects(
        client.rpc('<get><filter type="subtree"><timeout-reuse/></filter></get>', {
            messageId: timedOutMessageId
        }),
        error => error instanceof NetconfProtocolError && error.code === 'NETCONF_RETIRED_MESSAGE_ID'
    );

    client.disconnect();

    const reconnectTransport = new FakeTransport();
    const reconnected = client.connect(reconnectTransport);
    reconnectTransport.receive(encodeDelimiter(serverHello([BASE_10, BASE_11], 'reconnected')));
    await reconnected;
    const reusedAfterReconnect = client.rpc('<get><filter type="subtree"><new-session/></filter></get>', {
        messageId: timedOutMessageId
    });
    assert.equal(extractMessageId(decodeChunkedWrite(reconnectTransport.writes[1])), '14');
    reconnectTransport.receive(encodeChunked('<rpc-reply message-id="14"><ok/></rpc-reply>'));
    assert.equal((await reusedAfterReconnect).messageId, '14');
    assert.equal(client.connected, true);
    client.disconnect();
}

async function runHelloTimeoutTest() {
    const transport = new FakeTransport();
    const client = new NetconfClient({ transport, helloTimeout: 15 });
    await assert.rejects(
        client.connect(),
        error => error instanceof NetconfConnectionError && error.code === 'NETCONF_HELLO_TIMEOUT'
    );
    assert.equal(transport.destroyed, true);
}

class FakeSshStream extends EventEmitter {
    constructor() {
        super();
        this.writes = [];
    }

    write(data) {
        this.writes.push(Buffer.from(data));
        return true;
    }

    end() {}
}

class FakeSshClient extends EventEmitter {
    constructor() {
        super();
        this.stream = new FakeSshStream();
        FakeSshClient.instance = this;
    }

    connect(config) {
        this.config = config;
        process.nextTick(() => this.emit('ready'));
    }

    subsys(name, callback) {
        this.subsystem = name;
        process.nextTick(() => callback(null, this.stream));
    }

    end() {}
}

async function runSshInjectionTest() {
    const key = Buffer.from('test-host-public-key');
    const expected = calculateFingerprints(key).sha256;
    assert.equal(createHostVerifier(expected)(key), true);
    assert.equal(createHostVerifier('SHA256:not-the-key')(key), false);

    const transport = await createSshTransport(
        {
            host: 'router.example',
            username: 'netconf',
            password: 'secret',
            hostKeyFingerprint: expected,
            readyTimeout: 5000,
            keepaliveInterval: 2000,
            keepaliveCountMax: 5
        },
        { Client: FakeSshClient }
    );
    assert.equal(FakeSshClient.instance.config.port, 830);
    assert.equal(FakeSshClient.instance.config.keepaliveInterval, 2000);
    assert.equal(FakeSshClient.instance.config.hostVerifier(key), true);
    assert.equal(FakeSshClient.instance.subsystem, 'netconf');
    transport.write('hello');
    assert.equal(FakeSshClient.instance.stream.writes[0].toString(), 'hello');
    transport.end();
}

async function run() {
    await runClientTests();
    await runVersion10Test();
    await runRpcCancellationTest();
    await runHelloTimeoutTest();
    await runSshInjectionTest();
    console.log('YANG NETCONF client and SSH transport tests passed');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
