// Electron's run-as-node runtime can crash while freeing V8 serialization
// backing stores. Keep its fork IPC channel JSON-only, without losing binary
// values, special primitives, cycles or repeated object references. This codec
// deliberately does not call node:v8.serialize/deserialize.
const PROTOCOL_PROCESS_IPC_CODEC = 'netnexus-json-graph';
const PROTOCOL_PROCESS_IPC_CODEC_ENV = 'NETNEXUS_PROTOCOL_IPC_CODEC';

const VIEW_TYPES = new Map(
    [
        Int8Array,
        Uint8Array,
        Uint8ClampedArray,
        Int16Array,
        Uint16Array,
        Int32Array,
        Uint32Array,
        Float32Array,
        Float64Array,
        BigInt64Array,
        BigUint64Array
    ].map(Type => [Type.name, Type])
);
const ERROR_TYPES = new Map(
    [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError].map(Type => [Type.name, Type])
);

function invalidMessage(message) {
    const error = new TypeError(`Invalid protocol process message: ${message}`);
    error.code = 'PROTOCOL_PROCESS_MESSAGE_INVALID';
    return error;
}

function encodeProtocolProcessMessage(message) {
    const nodes = [];
    const references = new Map();
    const explicitBuffers = new Set();
    const backingBuffers = new Map();
    const encode = (value, fromView = false) => {
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number') {
            if (Number.isFinite(value) && !Object.is(value, -0)) return value;
            return ['number', String(value === 0 ? '-0' : value)];
        }
        if (typeof value === 'undefined') return ['undefined'];
        if (typeof value === 'bigint') return ['bigint', String(value)];
        if (typeof value !== 'object') throw invalidMessage(`cannot clone ${typeof value}`);
        if (value instanceof ArrayBuffer && fromView !== true) explicitBuffers.add(value);
        if (references.has(value)) return ['ref', references.get(value)];
        const index = nodes.length;
        references.set(value, index);
        nodes.push(null);
        let node;
        if (Buffer.isBuffer(value)) {
            // Never transmit unused bytes in a Buffer's shared allocation pool.
            node = ['buffer', value.toString('base64')];
        } else if (value instanceof ArrayBuffer) {
            // Wait until traversal finishes to know whether callers explicitly
            // supplied this buffer or only supplied a small view into a pool.
            node = ['array-buffer', null];
            backingBuffers.set(value, { node, views: [] });
        } else if (ArrayBuffer.isView(value)) {
            if (value instanceof DataView) {
                node = ['data-view', encode(value.buffer, true), value.byteOffset, value.byteLength];
            } else if (VIEW_TYPES.has(value.constructor.name)) {
                node = [
                    'typed-array',
                    value.constructor.name,
                    encode(value.buffer, true),
                    value.byteOffset,
                    value.length
                ];
            } else {
                throw invalidMessage('unsupported typed array');
            }
            backingBuffers.get(value.buffer).views.push({ value, node });
        } else if (Array.isArray(value)) {
            node = ['array', value.length, Object.keys(value).map(key => [key, encode(value[key])])];
        } else if (value instanceof Map) {
            node = ['map', Array.from(value, ([key, entry]) => [encode(key), encode(entry)])];
        } else if (value instanceof Set) {
            node = ['set', Array.from(value, entry => encode(entry))];
        } else if (value instanceof Date) {
            node = ['date', encode(value.getTime())];
        } else if (value instanceof RegExp) {
            node = ['regexp', value.source, value.flags];
        } else if (value instanceof Error) {
            const properties = Object.keys(value).map(key => [key, encode(value[key])]);
            if (Object.hasOwn(value, 'cause') && !Object.keys(value).includes('cause')) {
                properties.push(['cause', encode(value.cause)]);
            }
            node = ['error', String(value.name), String(value.message), value.stack, properties];
        } else {
            const tag = Object.prototype.toString.call(value);
            if (tag !== '[object Object]') throw invalidMessage(`cannot clone ${tag}`);
            node = ['object', Object.keys(value).map(key => [key, encode(value[key])])];
        }
        nodes[index] = node;
        return ['ref', index];
    };
    const root = encode(message);
    for (const [buffer, { node, views }] of backingBuffers) {
        if (explicitBuffers.has(buffer)) {
            node[1] = Buffer.from(buffer).toString('base64');
            continue;
        }
        // A view does not grant access to its entire underlying allocation.
        // Compact the visible ranges, retaining overlap/alias relationships,
        // and zero any gaps so pooled bytes outside all views stay private.
        let first = buffer.byteLength;
        let end = 0;
        let alignment = 1;
        for (const { value } of views) {
            first = Math.min(first, value.byteOffset);
            end = Math.max(end, value.byteOffset + value.byteLength);
            alignment = Math.max(alignment, value.BYTES_PER_ELEMENT || 1);
        }
        first = Math.floor(first / alignment) * alignment;
        const bytes = Buffer.alloc(end - first);
        for (const { value, node: viewNode } of views) {
            Buffer.from(buffer, value.byteOffset, value.byteLength).copy(bytes, value.byteOffset - first);
            viewNode[viewNode[0] === 'data-view' ? 2 : 3] -= first;
        }
        node[1] = bytes.toString('base64');
    }
    return { codec: PROTOCOL_PROCESS_IPC_CODEC, version: 1, root, nodes };
}

function decodeProtocolProcessMessage(envelope) {
    if (
        !envelope ||
        envelope.codec !== PROTOCOL_PROCESS_IPC_CODEC ||
        envelope.version !== 1 ||
        !Array.isArray(envelope.nodes)
    ) {
        throw invalidMessage('unknown codec or envelope');
    }
    const { nodes } = envelope;
    const values = new Array(nodes.length);
    const decode = value => {
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (!Array.isArray(value)) throw invalidMessage('invalid value token');
        switch (value[0]) {
            case 'undefined':
                if (value.length === 1) return undefined;
                break;
            case 'bigint':
                if (value.length === 2 && typeof value[1] === 'string' && /^-?\d+$/.test(value[1])) {
                    return BigInt(value[1]);
                }
                break;
            case 'number':
                if (value.length === 2 && ['NaN', 'Infinity', '-Infinity', '-0'].includes(value[1])) {
                    return value[1] === '-0' ? -0 : Number(value[1]);
                }
                break;
            case 'ref':
                if (
                    value.length === 2 &&
                    Number.isSafeInteger(value[1]) &&
                    value[1] >= 0 &&
                    value[1] < values.length &&
                    values[value[1]] !== undefined
                ) {
                    return values[value[1]];
                }
                break;
            default:
                break;
        }
        throw invalidMessage('invalid value or reference');
    };
    const decodeBytes = value => {
        if (
            typeof value !== 'string' ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
        ) {
            throw invalidMessage('invalid binary data');
        }
        return Buffer.from(value, 'base64');
    };
    const defineProperties = (target, entries) => {
        if (!Array.isArray(entries)) throw invalidMessage('invalid object properties');
        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
                throw invalidMessage('invalid object property');
            }
            // Assignment to __proto__ must not change any receiver's prototype.
            Object.defineProperty(target, entry[0], {
                value: decode(entry[1]),
                enumerable: true,
                writable: true,
                configurable: true
            });
        }
    };
    try {
        // Allocate the graph before filling references, including cycles.
        for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index];
            if (!Array.isArray(node)) throw invalidMessage('invalid graph node');
            switch (node[0]) {
                case 'object':
                    values[index] = {};
                    break;
                case 'array':
                    if (!Number.isSafeInteger(node[1]) || node[1] < 0 || node[1] > 0xffffffff) {
                        throw invalidMessage('invalid array length');
                    }
                    values[index] = new Array(node[1]);
                    break;
                case 'map':
                    values[index] = new Map();
                    break;
                case 'set':
                    values[index] = new Set();
                    break;
                case 'date':
                    values[index] = new Date(decode(node[1]));
                    break;
                case 'regexp':
                    if (typeof node[1] !== 'string' || typeof node[2] !== 'string') {
                        throw invalidMessage('invalid regular expression');
                    }
                    values[index] = new RegExp(node[1], node[2]);
                    break;
                case 'error': {
                    if (typeof node[1] !== 'string' || typeof node[2] !== 'string') {
                        throw invalidMessage('invalid error');
                    }
                    const Type = ERROR_TYPES.get(node[1]) || Error;
                    const error = new Type(node[2]);
                    error.name = node[1];
                    if (typeof node[3] === 'string') error.stack = node[3];
                    values[index] = error;
                    break;
                }
                case 'buffer':
                    values[index] = decodeBytes(node[1]);
                    break;
                case 'array-buffer': {
                    const bytes = decodeBytes(node[1]);
                    const buffer = new ArrayBuffer(bytes.length);
                    new Uint8Array(buffer).set(bytes);
                    values[index] = buffer;
                    break;
                }
                case 'data-view':
                case 'typed-array':
                    break;
                default:
                    throw invalidMessage('unsupported graph node');
            }
        }
        // Views can refer to a backing buffer appearing later in the graph.
        for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index];
            if (node[0] !== 'data-view' && node[0] !== 'typed-array') continue;
            const offset = node[0] === 'data-view' ? 2 : 3;
            const buffer = decode(node[offset - 1]);
            if (
                !(buffer instanceof ArrayBuffer) ||
                !Number.isSafeInteger(node[offset]) ||
                node[offset] < 0 ||
                !Number.isSafeInteger(node[offset + 1]) ||
                node[offset + 1] < 0
            ) {
                throw invalidMessage('invalid view backing buffer or bounds');
            }
            if (node[0] === 'data-view') {
                values[index] = new DataView(buffer, node[offset], node[offset + 1]);
            } else {
                const Type = VIEW_TYPES.get(node[1]);
                if (!Type) throw invalidMessage('unsupported typed array');
                values[index] = new Type(buffer, node[offset], node[offset + 1]);
            }
        }
        for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index];
            const target = values[index];
            if (node[0] === 'object') defineProperties(target, node[1]);
            else if (node[0] === 'array') defineProperties(target, node[2]);
            else if (node[0] === 'error') defineProperties(target, node[4]);
            else if (node[0] === 'map') {
                if (!Array.isArray(node[1])) throw invalidMessage('invalid map entries');
                for (const entry of node[1]) {
                    if (!Array.isArray(entry) || entry.length !== 2) throw invalidMessage('invalid map entry');
                    target.set(decode(entry[0]), decode(entry[1]));
                }
            } else if (node[0] === 'set') {
                if (!Array.isArray(node[1])) throw invalidMessage('invalid set entries');
                for (const entry of node[1]) target.add(decode(entry));
            }
        }
        return decode(envelope.root);
    } catch (error) {
        if (error.code === 'PROTOCOL_PROCESS_MESSAGE_INVALID') throw error;
        throw invalidMessage(error.message);
    }
}

module.exports = {
    PROTOCOL_PROCESS_IPC_CODEC,
    PROTOCOL_PROCESS_IPC_CODEC_ENV,
    encodeProtocolProcessMessage,
    decodeProtocolProcessMessage
};
