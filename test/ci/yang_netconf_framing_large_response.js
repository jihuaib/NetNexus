'use strict';

const assert = require('node:assert/strict');
const {
    DelimiterFramer,
    ChunkedFramer,
    encodeDelimiter,
    encodeChunked
} = require('../../electron/utils/netconf/framing');

function measureFraming(framer, encoded, fragmentBytes) {
    const originalConcat = Buffer.concat;
    const originalCopy = Buffer.prototype.copy;
    const originalIndexOf = Buffer.prototype.indexOf;
    let copiedBytes = 0;
    let searchedBytes = 0;
    const messages = [];
    Buffer.concat = function (buffers, totalLength) {
        copiedBytes += totalLength ?? buffers.reduce((total, buffer) => total + buffer.length, 0);
        return originalConcat(buffers, totalLength);
    };
    Buffer.prototype.copy = function (...args) {
        const copied = originalCopy.apply(this, args);
        copiedBytes += copied;
        return copied;
    };
    Buffer.prototype.indexOf = function (value, byteOffset = 0, encoding) {
        const found = originalIndexOf.call(this, value, byteOffset, encoding);
        const needleBytes = typeof value === 'number' ? 1 : Buffer.byteLength(value);
        searchedBytes += Math.max(0, (found < 0 ? this.length : found + needleBytes) - byteOffset);
        return found;
    };
    try {
        for (let offset = 0; offset < encoded.length; offset += fragmentBytes) {
            messages.push(...framer.push(encoded.subarray(offset, offset + fragmentBytes)));
        }
    } finally {
        Buffer.concat = originalConcat;
        Buffer.prototype.copy = originalCopy;
        Buffer.prototype.indexOf = originalIndexOf;
    }
    assert(copiedBytes <= encoded.length * 8, `fragmented response copied ${copiedBytes} for ${encoded.length} bytes`);
    assert(searchedBytes <= encoded.length * 8, `fragmented response rescanned ${searchedBytes} bytes`);
    return messages;
}

const largeReply = `<rpc-reply message-id="1"><data>${'x'.repeat(2 * 1024 * 1024)}</data></rpc-reply>`;
for (const [framer, encoded] of [
    [new DelimiterFramer(), encodeDelimiter(largeReply)],
    [new ChunkedFramer(), encodeChunked(largeReply)],
    [new ChunkedFramer(), encodeChunked(largeReply, { chunkSize: 17 * 1024 })]
]) {
    assert.deepEqual(measureFraming(framer, encoded, 4096), [largeReply]);
    assert.equal(framer.buffer.length, 0);
}

for (const [Framer, encode] of [
    [DelimiterFramer, encodeDelimiter],
    [ChunkedFramer, encodeChunked]
]) {
    const framer = new Framer();
    const encoded = Buffer.concat([encode('<one/>'), encode('<two/>'), encode('<three/>')]);
    assert.deepEqual(framer.push(encoded, 1), ['<one/>']);
    assert.deepEqual(framer.push(Buffer.alloc(0), 1), ['<two/>']);
    const remainder = framer.takeBuffered();
    assert.equal(framer.buffer.length, 0);
    assert.deepEqual(new Framer().push(remainder), ['<three/>']);
    assert.deepEqual(framer.push(encode('<reset/>')), ['<reset/>']);
    const partial = encode('<discard/>');
    framer.push(partial.subarray(0, partial.length - 2));
    framer.reset();
    assert.deepEqual(framer.push(encode('<after-reset/>')), ['<after-reset/>']);

    const owned = Buffer.from(encode('<owned/>'));
    const split = owned.length - 4;
    assert.deepEqual(framer.push(owned.subarray(0, split)), []);
    const tail = Buffer.from(owned.subarray(split));
    owned.fill(0, 0, split);
    assert.deepEqual(framer.push(tail), ['<owned/>'], 'retained bytes must not alias the transport input');

    const compactedPayload = 'x'.repeat(65520);
    const compactedFrame = encode(compactedPayload);
    const midpoint = Math.floor(compactedFrame.length / 2);
    assert.deepEqual(framer.push(Buffer.concat([encode('<one/>'), compactedFrame.subarray(0, midpoint)]), 1), [
        '<one/>'
    ]);
    assert.deepEqual(framer.push(compactedFrame.subarray(midpoint)), [compactedPayload]);
}

for (let split = 1; split < 6; split++) {
    const framer = new DelimiterFramer({ maxMessageSize: 4 });
    assert.deepEqual(framer.push(Buffer.from(`four${']]>]]>'.slice(0, split)}`)), []);
    assert.deepEqual(framer.push(Buffer.from(']]>]]>'.slice(split))), ['four']);
}
const oversized = new DelimiterFramer({ maxMessageSize: 4 });
oversized.push(Buffer.from('five!]]>]'));
assert.throws(() => oversized.push(Buffer.from(']>')), { code: 'NETCONF_MESSAGE_TOO_LARGE' });
oversized.reset();
assert.deepEqual(oversized.push(encodeDelimiter('four')), ['four']);

const incomplete = new ChunkedFramer();
incomplete.push(Buffer.from('\n#8\n<par'));
assert.throws(() => incomplete.takeBuffered(), { code: 'NETCONF_INCOMPLETE_MESSAGE' });
assert.equal(incomplete.expectedChunkSize, 4);
assert.deepEqual(incomplete.push(Buffer.from('t/>!\n##\n')), ['<part/>!']);
const bounded = new ChunkedFramer({ maxMessageSize: 5 });
bounded.push(Buffer.from('\n#3\nabc'));
assert.throws(() => bounded.push(Buffer.from('\n#3\n')), { code: 'NETCONF_MESSAGE_TOO_LARGE' });
bounded.reset();
assert.deepEqual(bounded.push(encodeChunked('12345', { chunkSize: 2 })), ['12345']);

console.log('Large NETCONF framing passed (linear copying/scanning, incremental chunks, ownership, limits and reset)');
