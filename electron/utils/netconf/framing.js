'use strict';

const NETCONF_10_DELIMITER = Buffer.from(']]>]]>', 'ascii');
const DEFAULT_MAX_MESSAGE_SIZE = 64 * 1024 * 1024;
const DEFAULT_MAX_CHUNK_SIZE = 16 * 1024 * 1024;
const INITIAL_BUFFER_CAPACITY = 64 * 1024;

class NetconfFramingError extends Error {
    constructor(message, code = 'NETCONF_FRAMING_ERROR') {
        super(message);
        this.name = 'NetconfFramingError';
        this.code = code;
    }
}

function toBuffer(value, name = 'message') {
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (typeof value === 'string' || value instanceof Uint8Array) {
        return Buffer.from(value);
    }
    throw new TypeError(`${name} must be a string, Buffer, or Uint8Array`);
}

class FramingBuffer {
    constructor(capacityLimit) {
        this.capacityLimit = capacityLimit;
        this.reset();
    }

    get length() {
        return this.end - this.start;
    }

    get data() {
        return this.storage.subarray(this.start, this.end);
    }

    append(chunk) {
        if (chunk.length === 0) return;
        if (this.storage.length - this.end < chunk.length) {
            const required = this.length + chunk.length;
            const capacity = Math.max(
                required,
                Math.min(this.capacityLimit, Math.max(INITIAL_BUFFER_CAPACITY, this.storage.length * 2))
            );
            const storage = this.storage.length >= required ? this.storage : Buffer.allocUnsafe(capacity);
            const length = this.length;
            this.storage.copy(storage, 0, this.start, this.end);
            this.storage = storage;
            this.start = 0;
            this.end = length;
        }
        chunk.copy(this.storage, this.end);
        this.end += chunk.length;
    }

    consume(length) {
        this.start += length;
        if (this.length === 0) {
            this.start = 0;
            this.end = 0;
            if (this.storage.length > INITIAL_BUFFER_CAPACITY) this.storage = Buffer.alloc(0);
        }
    }

    take() {
        const data = this.data;
        this.reset();
        return data;
    }

    reset() {
        this.storage = Buffer.alloc(0);
        this.start = 0;
        this.end = 0;
    }
}

class DelimiterFramer {
    constructor(options = {}) {
        this.maxMessageSize = options.maxMessageSize || DEFAULT_MAX_MESSAGE_SIZE;
        this.encoding = options.encoding || 'utf8';
        this.pending = new FramingBuffer(this.maxMessageSize + NETCONF_10_DELIMITER.length);
        this.searchOffset = 0;
    }

    get buffer() {
        return this.pending.data;
    }

    push(chunk, maxMessages = Infinity) {
        const input = toBuffer(chunk, 'framing chunk');
        if (!Number.isSafeInteger(maxMessages) && maxMessages !== Infinity) {
            throw new TypeError('maxMessages must be a positive integer or Infinity');
        }
        if (maxMessages <= 0) {
            throw new TypeError('maxMessages must be greater than zero');
        }

        this.pending.append(input);
        const messages = [];

        while (messages.length < maxMessages) {
            const delimiterIndex = this.buffer.indexOf(NETCONF_10_DELIMITER, this.searchOffset);
            if (delimiterIndex < 0) {
                if (this.buffer.length > this.maxMessageSize + NETCONF_10_DELIMITER.length - 1) {
                    throw new NetconfFramingError(
                        `NETCONF 1.0 message exceeds ${this.maxMessageSize} bytes`,
                        'NETCONF_MESSAGE_TOO_LARGE'
                    );
                }
                this.searchOffset = Math.max(0, this.buffer.length - NETCONF_10_DELIMITER.length + 1);
                break;
            }
            if (delimiterIndex > this.maxMessageSize) {
                throw new NetconfFramingError(
                    `NETCONF 1.0 message exceeds ${this.maxMessageSize} bytes`,
                    'NETCONF_MESSAGE_TOO_LARGE'
                );
            }

            const message = this.buffer.subarray(0, delimiterIndex);
            messages.push(message.toString(this.encoding));
            this.pending.consume(delimiterIndex + NETCONF_10_DELIMITER.length);
            this.searchOffset = 0;
        }

        return messages;
    }

    takeBuffered() {
        this.searchOffset = 0;
        return this.pending.take();
    }

    reset() {
        this.pending.reset();
        this.searchOffset = 0;
    }
}

class ChunkedFramer {
    constructor(options = {}) {
        this.maxMessageSize = options.maxMessageSize || DEFAULT_MAX_MESSAGE_SIZE;
        this.maxChunkSize = options.maxChunkSize || Math.min(this.maxMessageSize, DEFAULT_MAX_CHUNK_SIZE);
        this.encoding = options.encoding || 'utf8';
        this.pending = new FramingBuffer(this.maxMessageSize);
        this.message = new FramingBuffer(this.maxMessageSize);
        this.messageSize = 0;
        this.expectedChunkSize = null;
    }

    get buffer() {
        return this.pending.data;
    }

    push(chunk, maxMessages = Infinity) {
        const input = toBuffer(chunk, 'framing chunk');
        if (!Number.isSafeInteger(maxMessages) && maxMessages !== Infinity) {
            throw new TypeError('maxMessages must be a positive integer or Infinity');
        }
        if (maxMessages <= 0) {
            throw new TypeError('maxMessages must be greater than zero');
        }

        this.pending.append(input);
        const messages = [];

        while (messages.length < maxMessages) {
            if (this.expectedChunkSize !== null) {
                const bodyLength = Math.min(this.pending.length, this.expectedChunkSize);
                if (bodyLength === 0) break;
                this.message.append(this.buffer.subarray(0, bodyLength));
                this.pending.consume(bodyLength);
                this.messageSize += bodyLength;
                this.expectedChunkSize -= bodyLength;
                if (this.expectedChunkSize > 0) break;
                this.expectedChunkSize = null;
                continue;
            }

            if (this.buffer.length === 0) {
                break;
            }
            if (this.buffer[0] !== 0x0a) {
                throw new NetconfFramingError(
                    'Malformed NETCONF 1.1 framing: chunk header must start with LF',
                    'NETCONF_INVALID_CHUNK_HEADER'
                );
            }
            if (this.buffer.length < 3) {
                break;
            }
            if (this.buffer[1] !== 0x23) {
                throw new NetconfFramingError(
                    'Malformed NETCONF 1.1 framing: LF must be followed by #',
                    'NETCONF_INVALID_CHUNK_HEADER'
                );
            }

            if (this.buffer[2] === 0x23) {
                if (this.buffer.length < 4) {
                    break;
                }
                if (this.buffer[3] !== 0x0a) {
                    throw new NetconfFramingError(
                        'Malformed NETCONF 1.1 framing: end marker must be LF##LF',
                        'NETCONF_INVALID_END_MARKER'
                    );
                }
                if (this.messageSize === 0) {
                    throw new NetconfFramingError(
                        'Malformed NETCONF 1.1 framing: an empty chunked message is not allowed',
                        'NETCONF_EMPTY_CHUNKED_MESSAGE'
                    );
                }
                this.pending.consume(4);
                messages.push(this.message.data.toString(this.encoding));
                this.message.reset();
                this.messageSize = 0;
                continue;
            }

            const lineEnd = this.buffer.indexOf(0x0a, 2);
            if (lineEnd < 0) {
                if (this.buffer.length > 14) {
                    throw new NetconfFramingError(
                        'Malformed NETCONF 1.1 framing: chunk size header is too long',
                        'NETCONF_INVALID_CHUNK_SIZE'
                    );
                }
                break;
            }

            const sizeText = this.buffer.subarray(2, lineEnd).toString('ascii');
            if (!/^[1-9][0-9]*$/.test(sizeText)) {
                throw new NetconfFramingError(
                    `Malformed NETCONF 1.1 chunk size: ${JSON.stringify(sizeText)}`,
                    'NETCONF_INVALID_CHUNK_SIZE'
                );
            }
            const chunkSize = Number(sizeText);
            if (!Number.isSafeInteger(chunkSize) || chunkSize > 0xffffffff) {
                throw new NetconfFramingError(
                    `NETCONF 1.1 chunk size is outside the RFC 6242 range: ${sizeText}`,
                    'NETCONF_INVALID_CHUNK_SIZE'
                );
            }
            if (chunkSize > this.maxChunkSize) {
                throw new NetconfFramingError(
                    `NETCONF 1.1 chunk exceeds ${this.maxChunkSize} bytes`,
                    'NETCONF_CHUNK_TOO_LARGE'
                );
            }
            if (this.messageSize + chunkSize > this.maxMessageSize) {
                throw new NetconfFramingError(
                    `NETCONF 1.1 message exceeds ${this.maxMessageSize} bytes`,
                    'NETCONF_MESSAGE_TOO_LARGE'
                );
            }

            this.pending.consume(lineEnd + 1);
            this.expectedChunkSize = chunkSize;
        }

        return messages;
    }

    takeBuffered() {
        if (this.expectedChunkSize !== null || this.messageSize > 0) {
            throw new NetconfFramingError(
                'Cannot take buffered data while a NETCONF 1.1 message is incomplete',
                'NETCONF_INCOMPLETE_MESSAGE'
            );
        }
        return this.pending.take();
    }

    reset() {
        this.pending.reset();
        this.message.reset();
        this.messageSize = 0;
        this.expectedChunkSize = null;
    }
}

function encodeDelimiter(message) {
    const body = toBuffer(message);
    return Buffer.concat([body, NETCONF_10_DELIMITER], body.length + NETCONF_10_DELIMITER.length);
}

function encodeChunked(message, options = {}) {
    const body = toBuffer(message);
    if (body.length === 0) {
        throw new NetconfFramingError('NETCONF 1.1 cannot encode an empty message', 'NETCONF_EMPTY_CHUNKED_MESSAGE');
    }

    const requestedChunkSize = options.chunkSize || body.length;
    if (!Number.isSafeInteger(requestedChunkSize) || requestedChunkSize <= 0 || requestedChunkSize > 0xffffffff) {
        throw new TypeError('chunkSize must be an integer between 1 and 4294967295');
    }

    const parts = [];
    for (let offset = 0; offset < body.length; offset += requestedChunkSize) {
        const chunk = body.subarray(offset, Math.min(offset + requestedChunkSize, body.length));
        parts.push(Buffer.from(`\n#${chunk.length}\n`, 'ascii'), chunk);
    }
    parts.push(Buffer.from('\n##\n', 'ascii'));
    return Buffer.concat(parts);
}

function createFramer(baseVersion, options = {}) {
    if (baseVersion === '1.1') {
        return new ChunkedFramer(options);
    }
    if (baseVersion === '1.0') {
        return new DelimiterFramer(options);
    }
    throw new TypeError(`Unsupported NETCONF base version: ${baseVersion}`);
}

function encodeMessage(message, baseVersion = '1.0', options = {}) {
    if (baseVersion === '1.1') {
        return encodeChunked(message, options);
    }
    if (baseVersion === '1.0') {
        return encodeDelimiter(message);
    }
    throw new TypeError(`Unsupported NETCONF base version: ${baseVersion}`);
}

module.exports = {
    NETCONF_10_DELIMITER,
    DEFAULT_MAX_MESSAGE_SIZE,
    DEFAULT_MAX_CHUNK_SIZE,
    NetconfFramingError,
    DelimiterFramer,
    Netconf10Framer: DelimiterFramer,
    ChunkedFramer,
    Netconf11Framer: ChunkedFramer,
    encodeDelimiter,
    encodeChunked,
    createFramer,
    encodeMessage
};
