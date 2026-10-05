const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const electronRoot = path.resolve(__dirname, '..', '..', 'electron');
const bgpRoot = path.join(electronRoot, 'utils', 'bgp');
const bmpRoot = path.join(electronRoot, 'utils', 'bmp');

function relativeName(filePath) {
    return path.relative(electronRoot, filePath).split(path.sep).join('/');
}

function dependencyGraph(filePath) {
    const visited = new Set();
    function visit(loadedModule) {
        if (!loadedModule || visited.has(loadedModule.filename)) return;
        visited.add(loadedModule.filename);
        loadedModule.children.forEach(visit);
    }
    visit(require.cache[require.resolve(filePath)]);
    return [...visited];
}

function assertDependencies(filePath, forbidden, description) {
    for (const dependency of dependencyGraph(filePath)) {
        const relative = relativeName(dependency);
        assert.equal(forbidden(relative), false, `${description}: ${relativeName(filePath)} loads ${relative}`);
    }
}

function jsFiles(directory, skip = () => false) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const filePath = path.join(directory, entry.name);
        if (skip(filePath)) return [];
        if (entry.isDirectory()) return jsFiles(filePath, skip);
        return entry.isFile() && entry.name.endsWith('.js') ? [filePath] : [];
    });
}

function isBusinessDependency(relative) {
    return (
        relative.startsWith('utils/bgp/simulator/') ||
        relative.startsWith('worker/') ||
        relative.startsWith('app/') ||
        /sqlite/i.test(relative)
    );
}

const initialCache = new Set(Object.keys(require.cache));
const ipPath = path.join(electronRoot, 'utils', 'ipUtils.js');
const ipUtils = require(ipPath);
assert.equal(ipUtils.ipv4BufferToString(Buffer.from([192, 0, 2]), 24), '192.0.2.0');
assert.equal(ipUtils.ipv6BufferToString(Buffer.from('20010db8', 'hex'), 32), '2001:db8::');
assertDependencies(
    ipPath,
    relative => /^(?:utils\/(?:bgp|bmp)\/|const\/(?:bgp|bmp)Const\.js$|worker\/|app\/)/.test(relative),
    'generic IP helpers must remain independent of BGP/BMP'
);

const bgpParserPath = path.join(bgpRoot, 'bgpPacketParser.js');
const bgpParser = require(bgpParserPath);
const parseBgpPacket = bgpParser.parseBgpPacket;
const calls = [];
// The public export is instrumented before BMP loads it. This verifies actual
// decoder reuse without depending on source spelling or minified identifiers.
bgpParser.parseBgpPacket = (...args) => {
    const parsed = parseBgpPacket(...args);
    calls.push({ packet: Buffer.from(args[0]), parsed });
    return parsed;
};

const bmpParserPath = path.join(bmpRoot, 'bmpPacketParser.js');
let bmpParser;
try {
    bmpParser = require(bmpParserPath);
    for (const dependency of Object.keys(require.cache).filter(filePath => !initialCache.has(filePath))) {
        assert.equal(
            isBusinessDependency(relativeName(dependency)),
            false,
            `loading protocol decoders must not load simulator, application, worker or SQLite code: ${dependency}`
        );
    }

    const BgpConst = require(path.join(electronRoot, 'const', 'bgpConst'));
    const BmpConst = require(path.join(electronRoot, 'const', 'bmpConst'));
    const { builders } = require('../../scripts/mockBmpClient');
    const updatePacket = builders.ipv4Update(['203.0.113.0'], {
        asns: [65000, 70000],
        nextHop: '192.0.2.254'
    });
    const update = parseBgpPacket(updatePacket, { asnSize: 4 });
    assert.equal(update.valid, true, update.error);
    assert.equal(update.type, BgpConst.BGP_PACKET_TYPE.UPDATE);
    assert.deepEqual(
        update.nlri.map(route => [route.prefix, route.length]),
        [['203.0.113.0', 24]]
    );

    const peerUp = builders.bmpMessage(
        BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION,
        builders.peerUpPayload({ peerAddress: '192.0.2.2', routerId: '192.0.2.1' })
    );
    const parsedBmp = bmpParser.parseBmpPacket(peerUp);
    assert.equal(parsedBmp.valid, true, parsedBmp.error);
    assert.equal(calls.length, 2, 'BMP Peer Up must use the shared decoder for both OPEN messages');
    assert.strictEqual(parsedBmp.payload.sentOpen.parsed, calls[0].parsed);
    assert.strictEqual(parsedBmp.payload.receivedOpen.parsed, calls[1].parsed);
    for (const call of calls) {
        assert.equal(call.parsed.valid, true, call.parsed.error);
        assert.equal(call.parsed.type, BgpConst.BGP_PACKET_TYPE.OPEN);
        assert.deepEqual(call.parsed, parseBgpPacket(call.packet));
    }
    assert.ok(
        dependencyGraph(bmpParserPath).includes(require.resolve(bgpParserPath)),
        'BMP must load the same BGP decoder module'
    );
    for (const filePath of [bgpParserPath, bmpParserPath]) {
        assertDependencies(filePath, isBusinessDependency, 'decoding packets must keep protocol dependencies thin');
    }
} finally {
    bgpParser.parseBgpPacket = parseBgpPacket;
}

const sharedBgpFiles = jsFiles(bgpRoot, filePath => filePath === path.join(bgpRoot, 'simulator'));
assert.ok(sharedBgpFiles.length > 0);
for (const filePath of sharedBgpFiles) {
    require(filePath);
    assertDependencies(
        filePath,
        relative =>
            relative.startsWith('utils/bmp/') ||
            relative === 'const/bmpConst.js' ||
            relative.startsWith('utils/bgp/simulator/') ||
            relative.startsWith('worker/') ||
            relative.startsWith('app/'),
        'shared BGP tools must not depend on BMP or application/simulator code'
    );
}

const bmpFiles = jsFiles(bmpRoot);
assert.ok(bmpFiles.length > 0);
for (const filePath of bmpFiles) {
    require(filePath);
    assertDependencies(
        filePath,
        relative => relative.startsWith('utils/bgp/simulator/'),
        'BMP tools must use shared BGP protocol tools without loading the BGP simulator'
    );
}

console.log(
    `BGP/BMP utility boundaries and shared packet decoding passed (${sharedBgpFiles.length} BGP, ${bmpFiles.length} BMP modules)`
);
