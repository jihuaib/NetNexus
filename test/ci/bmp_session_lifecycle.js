const assert = require('assert');
const path = require('path');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpConst = require('../../electron/const/bmpConst');
const BmpSession = require('../../electron/worker/bmp/bmpSession');

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

function makeWorker() {
    const BmpWorker = loadBmpWorkerClass(__dirname, module);
    const worker = Object.create(BmpWorker.prototype);
    const events = [];

    worker.bmpSessionMap = new Map();
    worker.bmpConfigData = { bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20 };
    worker.messageHandler = {
        sendEvent(type, payload) {
            events.push({ type, payload });
        }
    };

    return { worker, events };
}

const { worker, events } = makeWorker();

const v3Session = worker.createBmpSession(makeSocket('127.0.0.1', 1790), '10.0.0.1', 50001);
const v4Session = worker.createBmpSession(makeSocket('127.0.0.1', 1790), '10.0.0.2', 50002);
v3Session.bmpVersion = BmpConst.BMP_VERSION.V3;
v4Session.bmpVersion = BmpConst.BMP_VERSION.V4;
v3Session.messageBuffer = Buffer.from([0xff]);
v4Session.sysName = 'router-v4';

assert.strictEqual(v3Session.bmpVersion, BmpConst.BMP_VERSION.V3, 'one BMP client should keep BMPv3 state');
assert.strictEqual(v4Session.bmpVersion, BmpConst.BMP_VERSION.V4, 'another BMP client should keep BMPv4 state');
assert.strictEqual(worker.bmpSessionMap.size, 2, 'distinct BMP clients should create distinct sessions');

const oldSocket = makeSocket('127.0.0.1', 1790);
const oldSession = worker.createBmpSession(oldSocket, '10.0.0.3', 50003);
oldSession.bmpVersion = BmpConst.BMP_VERSION.V4;
oldSession.sysName = 'old-router';
oldSession.sysDesc = 'old session';
oldSession.messageBuffer = Buffer.from([0xaa]);

const replacement = worker.createBmpSession(makeSocket('127.0.0.1', 1790), '10.0.0.3', 50003);

assert.notStrictEqual(replacement, oldSession, 'same-key reconnect should create a fresh BMP session object');
assert.strictEqual(oldSocket.destroyed, true, 'same-key reconnect should close the old BMP socket');
assert.strictEqual(replacement.bmpVersion, null, 'fresh BMP session should not inherit old BMP version');
assert.strictEqual(replacement.sysName, null, 'fresh BMP session should not inherit old initiation data');
assert.strictEqual(replacement.messageBuffer.length, 0, 'fresh BMP session should not inherit buffered bytes');

const reconnectTerminationEvents = events.filter(event => event.type === BmpConst.BMP_EVT_TYPES.TERMINATION);
assert.strictEqual(reconnectTerminationEvents.length, 1, 'same-key reconnect should emit one termination for the old BMP session');
assert.strictEqual(reconnectTerminationEvents[0].payload.data.sysName, 'old-router');

const replacementKey = BmpSession.makeKey(
    replacement.localIp,
    replacement.localPort,
    replacement.remoteIp,
    replacement.remotePort
);
worker.removeBmpSessionByKey(replacementKey);
worker.removeBmpSessionByKey(replacementKey);

const terminationEvents = events.filter(event => event.type === BmpConst.BMP_EVT_TYPES.TERMINATION);
assert.strictEqual(terminationEvents.length, 2, 'BMP session removal should be idempotent after the first cleanup');
assert.strictEqual(worker.bmpSessionMap.has(replacementKey), false, 'removed BMP session should be deleted from map');

console.log('BMP session lifecycle tests passed');
