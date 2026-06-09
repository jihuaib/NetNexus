const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const WorkerMessageHandler = require(path.join(
    __dirname,
    '..',
    '..',
    'electron',
    'worker',
    'workerMessageHandler.js'
));

WorkerMessageHandler.prototype.init = function initForUnitTest() {};

const RpkiWorker = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'rpkiWorker.js'));
const RpkiConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'rpkiConst.js'));
const BgpConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'bgpConst.js'));

function makeWorker() {
    const worker = new RpkiWorker();
    const responses = [];
    const errors = [];
    const notifications = [];
    const directPayloadPushes = [];

    worker.messageHandler.sendSuccessResponse = (messageId, data, msg) => {
        responses.push({ messageId, data, msg });
    };
    worker.messageHandler.sendErrorResponse = (messageId, msg, data) => {
        errors.push({ messageId, msg, data });
    };
    worker.rpkiSessionMap.set('mock-session', {
        protocolVersion: RpkiConst.RPKI_PROTOCOL_VERSION.V2,
        sendSerialNotify: () => notifications.push(worker.cacheSerial),
        closeSession: () => {},
        sendSingleRoaData: () => directPayloadPushes.push('sendSingleRoaData'),
        sendRoaBatchData: () => directPayloadPushes.push('sendRoaBatchData'),
        withdrawSingleRoaData: () => directPayloadPushes.push('withdrawSingleRoaData'),
        withdrawRoaBatchData: () => directPayloadPushes.push('withdrawRoaBatchData'),
        sendRouterKey: () => directPayloadPushes.push('sendRouterKey'),
        withdrawRouterKey: () => directPayloadPushes.push('withdrawRouterKey'),
        sendAspa: () => directPayloadPushes.push('sendAspa'),
        withdrawAspa: () => directPayloadPushes.push('withdrawAspa'),
        replaceAspa: () => directPayloadPushes.push('replaceAspa')
    });

    return { worker, responses, errors, notifications, directPayloadPushes };
}

function makeSocket(localAddress, localPort) {
    return {
        localAddress,
        localPort,
        destroyed: false,
        destroy() {
            this.destroyed = true;
        },
        write() {
            return true;
        }
    };
}

{
    const worker = new RpkiWorker();
    const events = [];
    worker.rpkiConfigData = { aspaFormat: RpkiConst.RPKI_ASPA_FORMAT.LEGACY };
    worker.messageHandler.sendEvent = (type, payload) => events.push({ type, payload });

    const v1Session = worker.createRpkiSession(makeSocket('127.0.0.1', 8282), '10.0.0.1', 10001);
    const v2Session = worker.createRpkiSession(makeSocket('127.0.0.1', 8282), '10.0.0.2', 10002);
    v1Session.negotiateVersion(RpkiConst.RPKI_PROTOCOL_VERSION.V1);
    v2Session.negotiateVersion(RpkiConst.RPKI_PROTOCOL_VERSION.V2);

    assert.strictEqual(v1Session.protocolVersion, 1, 'one RPKI client should keep its negotiated v1');
    assert.strictEqual(v2Session.protocolVersion, 2, 'another RPKI client should keep its negotiated v2');
    assert.strictEqual(v1Session.aspaFormat, RpkiConst.RPKI_ASPA_FORMAT.LEGACY);
    assert.strictEqual(v2Session.aspaFormat, RpkiConst.RPKI_ASPA_FORMAT.LEGACY);

    const oldSocket = makeSocket('127.0.0.1', 8282);
    const oldSession = worker.createRpkiSession(oldSocket, '10.0.0.3', 10003);
    oldSession.protocolVersion = RpkiConst.RPKI_PROTOCOL_VERSION.V2;
    oldSession.sessionId = 0xabcd;
    oldSession.messageBuffer = Buffer.from([0xff]);

    const newSession = worker.createRpkiSession(makeSocket('127.0.0.1', 8282), '10.0.0.3', 10003);

    assert.notStrictEqual(newSession, oldSession, 'same-key reconnect should create a fresh RPKI session object');
    assert.strictEqual(oldSocket.destroyed, true, 'same-key reconnect should close the old socket');
    assert.strictEqual(newSession.protocolVersion, RpkiConst.RPKI_PROTOCOL_VERSION.V0);
    assert.strictEqual(newSession.sessionId, null);
    assert.strictEqual(newSession.messageBuffer.length, 0);
    assert.deepStrictEqual(
        events.map(event => event.payload.opType),
        ['add', 'add', 'add', 'delete', 'add'],
        'same-key reconnect should emit delete for the old session before add for the fresh one'
    );
}

const { worker, responses, errors, notifications, directPayloadPushes } = makeWorker();

worker.addRoa('add-roa', {
    ip: '192.0.2.0',
    mask: 24,
    asn: 65001,
    maxLength: 24,
    ipType: BgpConst.IP_TYPE.IPV4
});

assert.strictEqual(worker.cacheSerial, 2, 'addRoa should increment cache serial');
assert.deepStrictEqual(notifications, [2], 'addRoa should send Serial Notify for the new serial');
assert.strictEqual(worker.getDeltaOperationsSince(2).length, 0, 'current serial should have an empty delta');

let deltas = worker.getDeltaOperationsSince(1);
assert.strictEqual(deltas.length, 1, 'stale serial should get the ROA delta');
assert.strictEqual(deltas[0].type, 'roa');
assert.strictEqual(deltas[0].action, 'announce');
assert.strictEqual(deltas[0].data.asn, 65001);

worker.addAspa('add-aspa', {
    customerAsn: 65000,
    providerAsns: [65002, 65001, 65001],
    afiFlags: RpkiConst.RPKI_ASPA_AFI_FLAGS.BOTH
});

assert.strictEqual(worker.cacheSerial, 3, 'addAspa should increment cache serial');
deltas = worker.getDeltaOperationsSince(2);
assert.strictEqual(deltas.length, 1, 'ASPA add should be recorded as one delta');
assert.strictEqual(deltas[0].type, 'aspa');
assert.strictEqual(deltas[0].action, 'announce');
assert.deepStrictEqual(
    deltas[0].data.providerAsns,
    [65002, 65001, 65001],
    'ASPA history should preserve Provider ASN order and duplicates'
);

deltas = worker.getDeltaOperationsSince(1);
assert.strictEqual(deltas.length, 2, 'history should replay all operations since the requested serial');

worker.addAspa('replace-aspa', {
    customerAsn: 65000,
    providerAsns: [65003],
    afiFlags: RpkiConst.RPKI_ASPA_AFI_FLAGS.IPV4
});

assert.strictEqual(worker.cacheSerial, 4, 'ASPA overwrite should increment cache serial');
deltas = worker.getDeltaOperationsSince(3);
assert.strictEqual(deltas.length, 1, 'ASPA overwrite should be recorded as one replacement delta');
assert.strictEqual(deltas[0].action, 'replace');
assert.deepStrictEqual(deltas[0].oldData.providerAsns, [65002, 65001, 65001]);
assert.deepStrictEqual(deltas[0].newData.providerAsns, [65003]);

worker.deleteAspaBatch('delete-all-aspa', { all: true });

assert.strictEqual(worker.cacheSerial, 5, 'delete all ASPA should increment cache serial');
deltas = worker.getDeltaOperationsSince(4);
assert.strictEqual(deltas.length, 1, 'delete all ASPA should record withdrawals');
assert.strictEqual(deltas[0].type, 'aspa');
assert.strictEqual(deltas[0].action, 'withdraw');
assert.strictEqual(worker.rpkiAspaMap.size, 0);

assert.deepStrictEqual(
    directPayloadPushes,
    [],
    'data mutations should only notify serial changes and should not directly push payload PDUs'
);
assert.deepStrictEqual(notifications, [2, 3, 4, 5], 'each announced mutation should send one Serial Notify');
assert.strictEqual(errors.length, 0, 'serial history operations should not produce handler errors');
assert.strictEqual(responses.length, 4, 'mutating requests should still send success responses');

const serialBeforeNonAnnouncedBatch = worker.cacheSerial;
worker.addRoaBatch('batch-no-announce', {
    announce: false,
    roas: [
        {
            ip: '198.51.100.0',
            mask: 24,
            asn: 65002,
            maxLength: 24,
            ipType: BgpConst.IP_TYPE.IPV4
        }
    ]
});
assert.strictEqual(
    worker.cacheSerial,
    serialBeforeNonAnnouncedBatch,
    'non-announced batch loads should not create serial history'
);

const serialBeforeTrim = worker.cacheSerial;
worker.maxSerialHistoryEntries = 2;
worker.recordSerialDeltaAndNotify([{ type: 'manual', action: 'one', data: { id: 1 } }]);
worker.recordSerialDeltaAndNotify([{ type: 'manual', action: 'two', data: { id: 2 } }]);
worker.recordSerialDeltaAndNotify([{ type: 'manual', action: 'three', data: { id: 3 } }]);

assert.strictEqual(worker.serialHistory.length, 2, 'serial history should be trimmed by entry count');
assert.strictEqual(
    worker.getDeltaOperationsSince(serialBeforeTrim),
    null,
    'old serials outside retained history should require Cache Reset'
);
deltas = worker.getDeltaOperationsSince(worker.cacheSerial - 1);
assert.strictEqual(deltas.length, 1, 'recent retained history should still be replayable');
assert.strictEqual(deltas[0].action, 'three');

worker.stopRpki('stop');
assert.strictEqual(worker.serialHistory.length, 0, 'stopRpki should clear serial history');
assert.strictEqual(worker.serialHistoryOperationCount, 0, 'stopRpki should reset history operation count');

console.log('RPKI serial history tests passed');
