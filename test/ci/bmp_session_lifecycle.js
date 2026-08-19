const assert = require('assert');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpConst = require('../../electron/const/bmpConst');
const BgpConst = require('../../electron/const/bgpConst');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');

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
    worker.clientDeleteRemoteIpGates = new Map();
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
assert.strictEqual(
    reconnectTerminationEvents.length,
    1,
    'same-key reconnect should emit one termination for the old BMP session'
);
assert.strictEqual(reconnectTerminationEvents[0].payload.data.sysName, 'old-router');
assert.strictEqual(reconnectTerminationEvents[0].payload.data.connectionState, 'closed');
assert.strictEqual(reconnectTerminationEvents[0].payload.data.isOnline, false);

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
assert.strictEqual(terminationEvents[1].payload.data.connectionState, 'closed');
assert.strictEqual(terminationEvents[1].payload.data.isOnline, false);
assert.strictEqual(worker.bmpSessionMap.has(replacementKey), false, 'removed BMP session should be deleted from map');

const { worker: packetTerminationWorker, events: packetTerminationEvents } = makeWorker();
const packetTerminationSession = packetTerminationWorker.createBmpSession(
    makeSocket('127.0.0.1', 1790),
    '10.0.0.30',
    50300
);
packetTerminationSession.processTermination(Buffer.alloc(0));
assert.strictEqual(
    packetTerminationEvents.filter(event => event.type === BmpConst.BMP_EVT_TYPES.TERMINATION).length,
    1,
    'one BMP Termination message must emit exactly one termination event'
);

const sharedSourceId = 'shared-live-source';
const oldSourceSession = worker.createBmpSession(makeSocket('127.0.0.1', 1790), '10.0.0.4', 50004);
oldSourceSession.persistenceSourceKey = { keyHex: sharedSourceId };
oldSourceSession.persistenceConnectionId = 'old-connection';
oldSourceSession.persistenceConnectionGeneration = 100;
oldSourceSession.persistenceOpenedAtMs = 100;
const oldPeer = new BmpBgpSession(oldSourceSession);
oldPeer.addPathMap.set('1|1', true);
oldSourceSession.bgpSessionMap.set('old-peer', oldPeer);
const oldInstance = new BmpBgpInstance(oldSourceSession);
oldInstance.afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
oldInstance.safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;
oldInstance.addPathReceiveMap.set('1|1', true);
oldInstance.isAddPath = true;
oldSourceSession.bgpInstanceMap.set('old-instance', oldInstance);

const newSourceSession = worker.createBmpSession(makeSocket('127.0.0.1', 1790), '10.0.0.4', 50005);
newSourceSession.persistenceSourceKey = { keyHex: sharedSourceId };
newSourceSession.persistenceConnectionId = 'new-connection';
newSourceSession.persistenceConnectionGeneration = 200;
newSourceSession.persistenceOpenedAtMs = 200;
const newPeer = new BmpBgpSession(newSourceSession);
newSourceSession.bgpSessionMap.set('new-peer', newPeer);
const newInstance = new BmpBgpInstance(newSourceSession);
newInstance.afi = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
newInstance.safi = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;
newSourceSession.bgpInstanceMap.set('new-instance', newInstance);
assert.equal(
    newSourceSession.getClientRouteEventInfo().persistentConnectionId,
    newSourceSession.persistenceConnectionId,
    'incremental route events must carry the live connection identity'
);

assert.strictEqual(
    worker.findLiveBmpSession({
        persistentSourceId: sharedSourceId,
        persistentConnectionId: newSourceSession.persistenceConnectionId
    }),
    newSourceSession,
    'a detail request must use the requested live connection instead of an older connection for the same source'
);
assert.strictEqual(
    worker.findLiveBmpSession({
        persistentSourceId: sharedSourceId,
        persistentConnectionId: oldSourceSession.persistenceConnectionId
    }),
    oldSourceSession,
    'an explicit connection ID must win even when another connection for the source is newer'
);
assert.strictEqual(
    worker.findLiveBmpSession({
        persistentSourceId: sharedSourceId,
        persistentConnectionId: 'missing-connection'
    }),
    null,
    'a stale connection selector must not borrow ADD-PATH state from another connection for the source'
);
assert.strictEqual(
    worker.findLiveBmpSession({
        persistentSourceId: sharedSourceId,
        persistentConnectionId: 'missing-connection',
        localIp: newSourceSession.localIp,
        localPort: newSourceSession.localPort,
        remoteIp: newSourceSession.remoteIp,
        remotePort: newSourceSession.remotePort
    }),
    null,
    'a stale connection ID must not fall through to a different connection at the same endpoint'
);
assert.strictEqual(
    worker.findLiveBmpSession({
        persistentSourceId: 'different-source',
        persistentConnectionId: newSourceSession.persistenceConnectionId
    }),
    null,
    'a connection ID must not select a live session from a different persistent source'
);
assert.strictEqual(
    worker.findLiveBmpSession({
        persistentSourceId: 'different-source',
        localIp: newSourceSession.localIp,
        localPort: newSourceSession.localPort,
        remoteIp: newSourceSession.remoteIp,
        remotePort: newSourceSession.remotePort
    }),
    null,
    'an endpoint must not select a live session from a different persistent source'
);
assert.strictEqual(
    worker.findLiveBmpSession({
        persistentSourceId: sharedSourceId,
        localIp: newSourceSession.localIp,
        localPort: newSourceSession.localPort,
        remoteIp: newSourceSession.remoteIp,
        remotePort: newSourceSession.remotePort
    }),
    newSourceSession,
    'the transport endpoint must select the matching live connection before the source fallback'
);
assert.strictEqual(
    worker.getBmpSessionByClient({
        persistentSourceId: sharedSourceId,
        persistentConnectionId: 'missing-connection',
        localIp: newSourceSession.localIp,
        localPort: newSourceSession.localPort,
        remoteIp: newSourceSession.remoteIp,
        remotePort: newSourceSession.remotePort
    }).bmpSession,
    null,
    'route queries must not bypass a stale connection ID with a direct endpoint lookup'
);

assert.strictEqual(
    worker.findLiveBmpSession({ persistentSourceId: sharedSourceId }),
    newSourceSession,
    'a source-only request must prefer the highest connection generation when the older session was inserted first'
);

worker.bmpSessionMap = new Map([
    ['new-source-session', newSourceSession],
    ['old-source-session', oldSourceSession]
]);
assert.strictEqual(
    worker.findLiveBmpSession({ persistentSourceId: sharedSourceId }),
    newSourceSession,
    'a source-only request must select the newest live connection regardless of map insertion order'
);
const selectedCurrentSession = worker.findLiveBmpSession({
    persistentSourceId: sharedSourceId,
    persistentConnectionId: newSourceSession.persistenceConnectionId
});
assert.equal(
    Object.values(Array.from(selectedCurrentSession.bgpSessionMap.values())[0].getSessionInfo().addPathMap).some(
        Boolean
    ),
    false,
    'the selected Session detail DTO must retain the current ADD-PATH disabled state'
);
assert.equal(
    Array.from(selectedCurrentSession.bgpInstanceMap.values())[0].getInstanceInfo().isAddPath,
    false,
    'the selected Loc-RIB detail DTO must retain the current ADD-PATH disabled state'
);

console.log('BMP session lifecycle tests passed');
