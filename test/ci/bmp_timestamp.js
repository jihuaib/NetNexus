const assert = require('node:assert/strict');

const { parsePeerHeader, toUnixTimestampMs } = require('../../electron/utils/bmpUtils');

const seconds = 1700000000;
const microseconds = 123456;
const peerHeader = Buffer.alloc(42);
peerHeader.writeUInt16BE(0, 2);
peerHeader.writeUInt32BE(65000, 26);
peerHeader.writeUInt32BE(seconds, 34);
peerHeader.writeUInt32BE(microseconds, 38);

const parsed = parsePeerHeader(peerHeader);
assert.equal(parsed.valid, true);
assert.equal(parsed.peer.peerTimestamp, seconds);
assert.equal(parsed.peer.peerTimestampMicroseconds, microseconds);
assert.equal(parsed.peer.peerTimestampMs, seconds * 1000 + 123);
assert.equal(toUnixTimestampMs(seconds, 1000000), seconds * 1000);

console.log('BMP timestamp normalization tests passed');
