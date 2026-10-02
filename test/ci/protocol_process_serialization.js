const assert = require('node:assert/strict');
const {
    encodeProtocolProcessMessage,
    decodeProtocolProcessMessage
} = require('../../electron/worker/core/protocolProcessSerialization');

function roundTrip(message) {
    // Exercise the actual JSON channel, not just the in-memory codec pair.
    const envelope = JSON.parse(JSON.stringify(encodeProtocolProcessMessage(message)));
    return decodeProtocolProcessMessage(envelope);
}

function testScalarsAndSparseArrays() {
    const sparse = new Array(7);
    sparse[1] = undefined;
    sparse[4] = 'present';
    const source = {
        string: '协议消息 🐈 \u0000',
        null: null,
        true: true,
        false: false,
        undefined: undefined,
        nan: NaN,
        positiveInfinity: Infinity,
        negativeInfinity: -Infinity,
        negativeZero: -0,
        bigint: -(2n ** 100n),
        sparse
    };
    const decoded = roundTrip(source);
    assert.equal(decoded.string, source.string);
    assert.equal(decoded.null, null);
    assert.equal(decoded.true, true);
    assert.equal(decoded.false, false);
    assert.equal(Object.hasOwn(decoded, 'undefined'), true);
    assert.equal(decoded.undefined, undefined);
    assert.equal(Number.isNaN(decoded.nan), true);
    assert.equal(decoded.positiveInfinity, Infinity);
    assert.equal(decoded.negativeInfinity, -Infinity);
    assert.equal(Object.is(decoded.negativeZero, -0), true);
    assert.equal(decoded.bigint, source.bigint);
    assert.equal(decoded.sparse.length, 7);
    assert.deepEqual(Object.keys(decoded.sparse), ['1', '4']);
    assert.equal(Object.hasOwn(decoded.sparse, 1), true);
    assert.equal(decoded.sparse[1], undefined);
    assert.equal(Object.hasOwn(decoded.sparse, 0), false);
    assert.equal(decoded.sparse[4], 'present');
    for (const value of [undefined, null, true, false, '', 0, -0, NaN, Infinity, -Infinity, 0n, 42n]) {
        assert.ok(Object.is(roundTrip(value), value), 'root scalar values must retain their exact meaning');
    }
}

function testBuffersAndSharedArrayBufferViews() {
    const small = Buffer.alloc(32 * 1024, 0xa5);
    const large = Buffer.alloc(1024 * 1024, 0x5a);
    small[small.length - 1] = 0x11;
    large[large.length - 1] = 0xff;
    const backing = new ArrayBuffer(64);
    const bytes = new Uint8Array(backing);
    bytes.forEach((_value, index) => {
        bytes[index] = index;
    });
    const source = {
        small,
        large,
        repeatedBuffer: large,
        backing,
        uint8: new Uint8Array(backing, 3, 17),
        uint16: new Uint16Array(backing, 12, 6),
        dataView: new DataView(backing, 11, 8),
        bigint64: new BigInt64Array(backing, 16, 2),
        emptyBuffer: Buffer.alloc(0),
        emptyArrayBuffer: new ArrayBuffer(0)
    };
    const decoded = roundTrip(source);
    assert.equal(Buffer.isBuffer(decoded.small), true, 'Buffer must not become a plain JSON {type,data} object');
    assert.equal(Buffer.isBuffer(decoded.large), true);
    assert.deepEqual(decoded.small, small);
    assert.deepEqual(decoded.large, large);
    assert.strictEqual(decoded.repeatedBuffer, decoded.large);
    assert.notStrictEqual(decoded.large, large, 'IPC decoding must allocate independent bytes');
    assert.equal(decoded.backing instanceof ArrayBuffer, true);
    assert.deepEqual(new Uint8Array(decoded.backing), bytes);
    for (const key of ['uint8', 'uint16', 'dataView', 'bigint64']) {
        assert.equal(decoded[key].constructor, source[key].constructor, `${key} constructor must survive`);
        assert.equal(decoded[key].byteOffset, source[key].byteOffset);
        assert.equal(decoded[key].byteLength, source[key].byteLength);
        assert.strictEqual(decoded[key].buffer, decoded.backing, 'views must retain the same decoded backing store');
        assert.deepEqual(
            new Uint8Array(decoded[key].buffer, decoded[key].byteOffset, decoded[key].byteLength),
            new Uint8Array(source[key].buffer, source[key].byteOffset, source[key].byteLength)
        );
    }
    decoded.uint8[9] = 0xee;
    assert.equal(decoded.dataView.getUint8(1), 0xee, 'overlapping decoded views must observe each other');
    assert.equal(bytes[12], 12, 'decoded mutation must not write the sender backing store');
    assert.equal(decoded.emptyBuffer.length, 0);
    assert.equal(decoded.emptyArrayBuffer.byteLength, 0);

    const types = [
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
    ];
    for (const Type of types) {
        const original = new Type(Type === BigInt64Array || Type === BigUint64Array ? [1n, 42n] : [1, 42]);
        const copy = roundTrip(original);
        assert.equal(copy.constructor, Type);
        assert.deepEqual(copy, original);
    }
}

function testBuiltinsAndGraphIdentity() {
    const shared = { key: 'shared' };
    const date = new Date('2026-10-02T00:00:00.000Z');
    const regex = /prefix(?<number>\d+)/giu;
    const error = new TypeError('invalid protocol data', { cause: shared });
    const source = {
        shared,
        alias: shared,
        date,
        dateAlias: date,
        invalidDate: new Date(NaN),
        regex,
        error,
        map: new Map(),
        set: new Set(),
        array: [shared]
    };
    source.self = source;
    shared.owner = source;
    source.array.push(source.array);
    source.map.set(shared, source);
    source.map.set(undefined, 42n);
    source.map.set(source.map, source.set);
    source.set.add(shared);
    source.set.add(source);
    source.set.add(source.set);
    const decoded = roundTrip(source);
    assert.notStrictEqual(decoded, source);
    assert.strictEqual(decoded.self, decoded);
    assert.strictEqual(decoded.shared, decoded.alias);
    assert.strictEqual(decoded.shared.owner, decoded);
    assert.strictEqual(decoded.array[0], decoded.shared);
    assert.strictEqual(decoded.array[1], decoded.array);
    assert.equal(decoded.date instanceof Date, true);
    assert.equal(decoded.date.getTime(), date.getTime());
    assert.strictEqual(decoded.date, decoded.dateAlias);
    assert.equal(Number.isNaN(decoded.invalidDate.getTime()), true);
    assert.equal(decoded.regex instanceof RegExp, true);
    assert.equal(decoded.regex.source, regex.source);
    assert.equal(decoded.regex.flags, regex.flags);
    assert.equal(decoded.error instanceof Error, true);
    assert.equal(decoded.error.name, error.name);
    assert.equal(decoded.error.message, error.message);
    assert.equal(decoded.error.stack, error.stack);
    assert.strictEqual(decoded.error.cause, decoded.shared);
    assert.equal(decoded.map instanceof Map, true);
    assert.strictEqual(decoded.map.get(decoded.shared), decoded);
    assert.equal(decoded.map.get(undefined), 42n);
    assert.strictEqual(decoded.map.get(decoded.map), decoded.set);
    assert.equal(decoded.set instanceof Set, true);
    assert.equal(decoded.set.has(decoded.shared), true);
    assert.equal(decoded.set.has(decoded), true);
    assert.equal(decoded.set.has(decoded.set), true);
}

function testViewOnlyBackingStorePrivacy() {
    const pooled = Buffer.allocUnsafe(256);
    pooled.fill(0x7f);
    const secret = 'DO_NOT_LEAK_BMP_AUTH_SECRET_9b8cc74f';
    pooled.write(secret, 104, 'utf8');
    const uint8 = new Uint8Array(pooled.buffer, pooled.byteOffset + 96, 4);
    uint8.set([1, 3, 5, 7]);
    const dataView = new DataView(pooled.buffer, pooled.byteOffset + 144, 6);
    for (let index = 0; index < dataView.byteLength; index += 1) dataView.setUint8(index, 10 + index);
    const encoded = encodeProtocolProcessMessage({ uint8, dataView, repeatedView: uint8 });
    const wire = JSON.stringify(encoded);
    const decoded = decodeProtocolProcessMessage(JSON.parse(wire));
    assert.strictEqual(decoded.uint8, decoded.repeatedView);
    assert.strictEqual(
        decoded.uint8.buffer,
        decoded.dataView.buffer,
        'separate views must retain a shared backing store'
    );
    assert.deepEqual(decoded.uint8, uint8);
    assert.deepEqual(
        new Uint8Array(decoded.dataView.buffer, decoded.dataView.byteOffset, decoded.dataView.byteLength),
        new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength)
    );
    assert.equal(decoded.dataView.byteOffset - decoded.uint8.byteOffset, dataView.byteOffset - uint8.byteOffset);
    assert.ok(decoded.uint8.buffer.byteLength <= 54, 'view-only backing stores must not copy the unused Buffer pool');
    const visibleRanges = [decoded.uint8, decoded.dataView].map(view => [
        view.byteOffset,
        view.byteOffset + view.byteLength
    ]);
    const backingBytes = new Uint8Array(decoded.uint8.buffer);
    for (let index = 0; index < backingBytes.length; index += 1) {
        if (!visibleRanges.some(([start, end]) => index >= start && index < end)) {
            assert.equal(
                backingBytes[index],
                0,
                'gaps between visible views must be zeroed, not copied from the sender'
            );
        }
    }
    assert.equal(wire.includes(secret), false);
    for (const node of encoded.nodes) {
        if (node[0] === 'array-buffer' || node[0] === 'buffer') {
            assert.equal(
                Buffer.from(node[1], 'base64').includes(Buffer.from(secret)),
                false,
                'wire binary nodes must not contain secrets outside the exposed view ranges'
            );
        }
    }

    const rootView = new Uint16Array(pooled.buffer, pooled.byteOffset + 64, 3);
    rootView.set([0x1234, 0xabcd, 0x55aa]);
    const decodedRootView = roundTrip(rootView);
    assert.deepEqual(decodedRootView, rootView);
    assert.ok(
        decodedRootView.byteOffset < Uint16Array.BYTES_PER_ELEMENT,
        'a root view must compact its backing store, retaining at most alignment padding'
    );
    assert.ok(decodedRootView.buffer.byteLength <= rootView.byteLength + Uint16Array.BYTES_PER_ELEMENT - 1);
    for (let index = 0; index < decodedRootView.byteOffset; index += 1) {
        assert.equal(new Uint8Array(decodedRootView.buffer)[index], 0);
    }

    const unaligned = new Uint8Array(pooled.buffer, pooled.byteOffset + 81, 1);
    const aligned = new Uint32Array(pooled.buffer, pooled.byteOffset + 84, 1);
    unaligned[0] = 0x71;
    aligned[0] = 0xdeadbeef;
    const mixed = roundTrip({ unaligned, aligned });
    assert.strictEqual(mixed.unaligned.buffer, mixed.aligned.buffer);
    assert.deepEqual(mixed.unaligned, unaligned);
    assert.deepEqual(mixed.aligned, aligned);
    assert.equal(mixed.aligned.byteOffset % Uint32Array.BYTES_PER_ELEMENT, 0);
    assert.ok(mixed.unaligned.buffer.byteLength <= 8);
    const mixedBytes = new Uint8Array(mixed.unaligned.buffer);
    for (let index = 0; index < mixedBytes.length; index += 1) {
        if (
            index !== mixed.unaligned.byteOffset &&
            !(index >= mixed.aligned.byteOffset && index < mixed.aligned.byteOffset + mixed.aligned.byteLength)
        ) {
            assert.equal(mixedBytes[index], 0, 'alignment padding and gaps must not expose pooled bytes');
        }
    }

    // Explicitly transmitting the ArrayBuffer is an intentional full-buffer
    // exposure and must override compaction even when it follows the first view.
    const explicitlyExposed = roundTrip({ uint8, dataView, backing: pooled.buffer });
    assert.strictEqual(explicitlyExposed.uint8.buffer, explicitlyExposed.backing);
    assert.strictEqual(explicitlyExposed.dataView.buffer, explicitlyExposed.backing);
    assert.equal(explicitlyExposed.uint8.byteOffset, uint8.byteOffset);
    assert.equal(explicitlyExposed.dataView.byteOffset, dataView.byteOffset);
    assert.deepEqual(new Uint8Array(explicitlyExposed.backing), new Uint8Array(pooled.buffer));
    const explicitMap = roundTrip(
        new Map([
            ['view', uint8],
            ['backing', pooled.buffer]
        ])
    );
    assert.strictEqual(explicitMap.get('view').buffer, explicitMap.get('backing'));
    assert.equal(explicitMap.get('view').byteOffset, uint8.byteOffset);
    const explicitSet = Array.from(roundTrip(new Set([uint8, pooled.buffer])));
    assert.strictEqual(explicitSet[0].buffer, explicitSet[1]);
    assert.equal(explicitSet[0].byteOffset, uint8.byteOffset);
}

function testPrototypeKeys() {
    const poison = JSON.parse(
        '{"__proto__":{"polluted":"no"},"constructor":{"prototype":{"polluted":"no"}},"prototype":"ordinary data"}'
    );
    const decoded = roundTrip({ poison });
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.hasOwn(decoded.poison, '__proto__'), true);
    assert.deepEqual(decoded.poison.__proto__, { polluted: 'no' });
    assert.deepEqual(decoded.poison.constructor, { prototype: { polluted: 'no' } });
    assert.equal(decoded.poison.prototype, 'ordinary data');
    assert.notStrictEqual(Object.getPrototypeOf(decoded.poison), decoded.poison.__proto__);
}

function testInvalidInputs() {
    const valid = encodeProtocolProcessMessage({ value: 'valid' });
    const clone = value => JSON.parse(JSON.stringify(value));
    const corruptReference = clone(valid);
    if (Array.isArray(corruptReference.root)) corruptReference.root[corruptReference.root.length - 1] = 999999;
    else if (corruptReference.root && typeof corruptReference.root === 'object') {
        const refKey = Object.keys(corruptReference.root).find(key => typeof corruptReference.root[key] === 'number');
        assert.ok(refKey, 'the object root must carry an explicit graph node reference');
        corruptReference.root[refKey] = 999999;
    } else throw new Error('the object root must carry an explicit graph node reference');
    for (const envelope of [
        null,
        undefined,
        {},
        'not a codec envelope',
        [],
        { ...clone(valid), codec: 'unknown-codec' },
        { ...clone(valid), version: 999 },
        { ...clone(valid), nodes: null },
        { ...clone(valid), nodes: {} },
        { ...clone(valid), nodes: [null] },
        { ...clone(valid), root: { invalid: 'value' } },
        corruptReference
    ])
        assert.throws(
            () => decodeProtocolProcessMessage(envelope),
            undefined,
            'malformed graph envelopes must be rejected'
        );

    const graph = (nodes, root = ['ref', 0]) => ({ codec: valid.codec, version: valid.version, root, nodes });
    for (const envelope of [
        graph([['object', []]], ['ref', -1]),
        graph([['object', []]], ['ref', 0.5]),
        graph([['object', []]], ['ref', '0']),
        graph([['object', []]], ['ref', 0, 'extra']),
        graph([['object', [['nested', ['ref', 99]]]]]),
        graph([['object', [[7, 'invalid-property-key']]]]),
        graph([['unsupported-node-kind']]),
        graph([['buffer', 'not/base64!']]),
        graph([['buffer', 42]]),
        graph([['array', -1, []]]),
        graph([['array', 0.5, []]]),
        graph([['array', 0x100000000, []]]),
        graph([
            ['data-view', ['ref', 1], 0, 1],
            ['object', []]
        ]),
        graph([
            ['data-view', ['ref', 1], -1, 1],
            ['array-buffer', 'AAAAAA==']
        ]),
        graph([
            ['data-view', ['ref', 1], 3, 2],
            ['array-buffer', 'AAAAAA==']
        ]),
        graph([
            ['typed-array', 'UnknownArray', ['ref', 1], 0, 1],
            ['array-buffer', 'AAAAAA==']
        ]),
        graph([
            ['typed-array', 'Uint16Array', ['ref', 1], 1, 1],
            ['array-buffer', 'AAAAAA==']
        ]),
        graph([
            ['typed-array', 'Uint16Array', ['ref', 1], 0, 3],
            ['array-buffer', 'AAAAAA==']
        ]),
        graph([['regexp', '[', 'g']]),
        graph([['regexp', 'valid', 'invalid-flags']]),
        graph([], ['bigint', '123n']),
        graph([], ['number', 'not-a-number-token'])
    ])
        assert.throws(
            () => decodeProtocolProcessMessage(envelope),
            undefined,
            'invalid graph contents must be rejected'
        );

    for (const value of [
        () => {},
        Symbol('message'),
        { fn() {} },
        { symbol: Symbol('value') },
        [() => {}],
        new WeakMap(),
        new WeakSet(),
        Promise.resolve(1)
    ]) {
        assert.throws(
            () => encodeProtocolProcessMessage(value),
            undefined,
            'unsupported values must not be silently dropped'
        );
    }
}

testScalarsAndSparseArrays();
testBuffersAndSharedArrayBufferViews();
testViewOnlyBackingStorePrivacy();
testBuiltinsAndGraphIdentity();
testPrototypeKeys();
testInvalidInputs();
console.log(
    'Protocol process serialization tests passed: JSON wire, binary/views, graph identity, builtins and invalid input rejection'
);
