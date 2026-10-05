const assert = require('node:assert/strict');
const { normalizeIpPrefix, createRouteKey } = require('../../electron/utils/bmp/bmpPersistentRouteKey');

function reference(prefix, prefixLength) {
    const bytes = Buffer.from(prefix.split('.').map(Number));
    const wholeBytes = Math.floor(prefixLength / 8);
    const remainder = prefixLength % 8;
    if (remainder) bytes[wholeBytes] &= (0xff << (8 - remainder)) & 0xff;
    for (let index = wholeBytes + (remainder ? 1 : 0); index < bytes.length; index += 1) bytes[index] = 0;
    return {
        family: 'ipv4',
        prefixLength,
        networkHex: bytes.toString('hex'),
        networkText: [...bytes].join('.')
    };
}

const prefixes = ['0.0.0.0', '255.255.255.255', '128.0.0.1', '192.0.2.255', '10.255.254.253'];
let randomBits = 0x12345678;
for (let index = 0; index < 128; index += 1) {
    randomBits = (Math.imul(randomBits, 1664525) + 1013904223) >>> 0;
    prefixes.push(`${randomBits >>> 24}.${(randomBits >>> 16) & 255}.${(randomBits >>> 8) & 255}.${randomBits & 255}`);
}
for (const prefix of prefixes) {
    for (let length = 0; length <= 32; length += 1) {
        const expected = reference(prefix, length);
        assert.deepEqual(normalizeIpPrefix(prefix, length, 1), expected);
        assert.deepEqual(normalizeIpPrefix(`${prefix}/${length}`, undefined, 1), expected);
        const original = createRouteKey({ afi: 1, safi: 1, nlri: { prefix, length } });
        const masked = createRouteKey({ afi: 1, safi: 1, nlri: { prefix: expected.networkText, length } });
        assert.equal(original.keyHex, masked.keyHex, 'host bits must never change canonical route identity');
    }
}

const originalFrom = Buffer.from;
let allocations = 0;
try {
    Buffer.from = function (...args) {
        allocations += 1;
        return originalFrom.apply(this, args);
    };
    assert.deepEqual(normalizeIpPrefix('192.0.9.45', 27, 1), reference('192.0.9.45', 27));
    // The reference above allocates once; normalization must allocate none.
    assert.equal(allocations, 1);
} finally {
    Buffer.from = originalFrom;
}
assert.deepEqual(normalizeIpPrefix('2001:db8:ffff::1', 48, 2), {
    family: 'ipv6',
    prefixLength: 48,
    networkHex: '20010db8ffff00000000000000000000',
    networkText: '2001:db8:ffff::'
});
assert.throws(() => normalizeIpPrefix('192.0.2.1/24', 25, 1), /Conflicting prefix lengths/);
assert.throws(() => normalizeIpPrefix('192.0.2.1', 33, 1), /prefix length/);
assert.throws(() => normalizeIpPrefix('192.0.2.1', 24, 2), /Expected an IPv6 address/);
console.log('bmp_prefix_normalization_fast passed');
