'use strict';

const assert = require('assert');
const {
    DelimiterFramer,
    ChunkedFramer,
    NetconfFramingError,
    encodeDelimiter,
    encodeChunked,
    encodeMessage
} = require('../../electron/utils/netconf');

function feedOneByteAtATime(framer, buffer) {
    const messages = [];
    for (const byte of buffer) {
        messages.push(...framer.push(Buffer.from([byte])));
    }
    return messages;
}

const unicodeXml = '<rpc-reply message-id="7"><data>中文🙂</data></rpc-reply>';
const delimiterEncoded = encodeDelimiter(unicodeXml);
assert.deepEqual(feedOneByteAtATime(new DelimiterFramer(), delimiterEncoded), [unicodeXml]);

const limitedFramer = new DelimiterFramer();
const combinedDelimiter = Buffer.concat([encodeDelimiter('<one/>'), encodeDelimiter('<two/>')]);
assert.deepEqual(limitedFramer.push(combinedDelimiter, 1), ['<one/>']);
assert.deepEqual(limitedFramer.push(Buffer.alloc(0)), ['<two/>']);

const chunkedEncoded = encodeChunked(unicodeXml, { chunkSize: 7 });
assert.deepEqual(feedOneByteAtATime(new ChunkedFramer(), chunkedEncoded), [unicodeXml]);
assert(chunkedEncoded.includes(Buffer.from('\n#7\n')));

const combinedChunked = Buffer.concat([
    encodeMessage('<rpc-reply message-id="1"><ok/></rpc-reply>', '1.1'),
    encodeMessage('<notification><eventTime>now</eventTime></notification>', '1.1')
]);
assert.deepEqual(new ChunkedFramer().push(combinedChunked), [
    '<rpc-reply message-id="1"><ok/></rpc-reply>',
    '<notification><eventTime>now</eventTime></notification>'
]);

assert.throws(
    () => new ChunkedFramer().push(Buffer.from('\n#01\na\n##\n')),
    error => error instanceof NetconfFramingError && error.code === 'NETCONF_INVALID_CHUNK_SIZE'
);
assert.throws(
    () => new ChunkedFramer().push(Buffer.from('\n##\n')),
    error => error instanceof NetconfFramingError && error.code === 'NETCONF_EMPTY_CHUNKED_MESSAGE'
);
assert.throws(
    () => new ChunkedFramer({ maxChunkSize: 2 }).push(Buffer.from('\n#3\nabc\n##\n')),
    error => error instanceof NetconfFramingError && error.code === 'NETCONF_CHUNK_TOO_LARGE'
);
assert.throws(
    () => new DelimiterFramer({ maxMessageSize: 3 }).push(encodeDelimiter('four')),
    error => error instanceof NetconfFramingError && error.code === 'NETCONF_MESSAGE_TOO_LARGE'
);

console.log('YANG NETCONF framing tests passed');
