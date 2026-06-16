const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const WorkerMessageHandler = require(
    path.join(__dirname, '..', '..', 'electron', 'worker', 'core', 'workerMessageHandler.js')
);

WorkerMessageHandler.prototype.init = function initForUnitTest() {};

const RpkiWorker = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'rpki', 'rpkiWorker.js'));
const RpkiConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'rpkiConst.js'));

function buildResetQuery(version) {
    const buffer = Buffer.alloc(RpkiConst.RPKI_HEADER_LENGTH);
    buffer[0] = version;
    buffer[1] = RpkiConst.RPKI_MSG_TYPE.RESET_QUERY;
    buffer.writeUInt16BE(0, 2);
    buffer.writeUInt32BE(RpkiConst.RPKI_HEADER_LENGTH, 4);
    return buffer;
}

function makeSocket(localAddress, localPort) {
    const sentBuffers = [];
    const socket = {
        localAddress,
        localPort,
        destroyed: false,
        ended: false,
        write(buffer) {
            sentBuffers.push(Buffer.from(buffer));
            return true;
        },
        end(buffer, callback) {
            if (buffer) {
                sentBuffers.push(Buffer.from(buffer));
            }
            this.ended = true;
            if (callback) {
                callback();
            }
        },
        destroy() {
            this.destroyed = true;
        }
    };

    return { socket, sentBuffers };
}

const worker = new RpkiWorker();
const events = [];
worker.rpkiConfigData = {
    maxProtocolVersion: RpkiConst.RPKI_PROTOCOL_VERSION.V0
};
worker.messageHandler.sendEvent = (type, payload) => events.push({ type, payload });

const { socket, sentBuffers } = makeSocket('127.0.0.1', 8282);
const session = worker.createRpkiSession(socket, '10.0.0.1', 10001);

assert.strictEqual(worker.rpkiSessionMap.size, 1, 'session should be tracked after TCP accept');

session.recvMsg(buildResetQuery(RpkiConst.RPKI_PROTOCOL_VERSION.V2));

assert.strictEqual(sentBuffers.length, 1, 'unsupported version should send exactly one Error Report');
assert.strictEqual(
    sentBuffers[0][0],
    RpkiConst.RPKI_PROTOCOL_VERSION.V0,
    'Error Report should use the server max version'
);
assert.strictEqual(sentBuffers[0][1], RpkiConst.RPKI_MSG_TYPE.ERROR_REPORT, 'response should be Error Report');
assert.strictEqual(
    sentBuffers[0].readUInt16BE(2),
    RpkiConst.RPKI_ERROR_CODE.UNSUPPORTED_PROTOCOL_VERSION,
    'Error Report code should be UNSUPPORTED_PROTOCOL_VERSION'
);
assert.strictEqual(socket.ended, true, 'transport should be ended after version downgrade rejection');
assert.strictEqual(session.closing, true, 'session should be marked closing after rejection');

const eventOps = events.map(event => event.payload.opType);
console.log(`RPKI downgrade cleanup: remainingSessions=${worker.rpkiSessionMap.size}, events=${eventOps.join(',')}`);

assert.strictEqual(
    worker.rpkiSessionMap.size,
    0,
    'server-side close after unsupported version must remove the session from rpkiSessionMap'
);
assert.deepStrictEqual(eventOps, ['add', 'delete'], 'unsupported version close should publish add then delete');

console.log('RPKI version downgrade session cleanup test passed');
