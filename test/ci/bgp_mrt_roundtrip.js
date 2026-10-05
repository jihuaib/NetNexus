const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
process.env.NODE_ENV = 'test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp-mrt-roundtrip-'));
let userData = directory;
const originalLoad = Module._load;
Module._load = function mockElectron(request, parent, isMain) {
    if (request === 'electron')
        return {
            app: { isPackaged: false, getPath: () => userData },
            shell: { openExternal() {} },
            dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
        };
    return originalLoad.call(this, request, parent, isMain);
};
let BgpApp;
try {
    BgpApp = require('../../electron/app/bgpApp');
} finally {
    Module._load = originalLoad;
}
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForTest() {};
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpRoute = require('../../electron/worker/bgp/bgpRoute');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpConst = require('../../electron/const/bgpConst');
const { getAfiAndSafi } = require('../../electron/utils/bgp/bgpUtils');
const { createMrtEncoder } = require('../../electron/utils/bgp/simulator/bgpMrtEncoder');
const { exportRouteDatabaseMrt } = require('../../electron/utils/bgp/simulator/bgpMrtExport');
const stores = new Set();
const encoding = { routerId: '192.0.2.1', localAs: 70000, localIp: '192.0.2.254', timestamp: 1700000000 };
const emptyAttr = { attributePolicy: 'configured', configuredAttributes: [], pathAttributes: [] };
const sidStructure = {
    locatorBlockLength: 48,
    locatorNodeLength: 16,
    functionLength: 16,
    argumentLength: 0,
    transpositionLength: 0,
    transpositionOffset: 0
};
const richAttr = {
    attributePolicy: 'configured',
    configuredAttributes: [
        'med',
        'origin',
        'asPath',
        'nextHop',
        'localPref',
        'communities',
        'extendedCommunities',
        'custom',
        'srv6'
    ],
    pathAttributes: [
        { type: 'med', value: 0 },
        { type: 'origin', value: 2 },
        { type: 'asPath', value: '70000 65001' },
        { type: 'med', value: 22 },
        { type: 'nextHop', mode: 'fixed', value: '203.0.113.10' },
        { type: 'localPref', value: 1001 },
        { type: 'communities', value: ['65000:1', '65000:2'] },
        { type: 'communities', value: ['65000:3', '65000:4'] },
        { type: 'extendedCommunities', value: ['rt:65000:1', 'soo:65000:2'] },
        { type: 'extendedCommunities', value: ['hex:430a010203040506', 'rt:192.0.2.1:20'] },
        { type: 'custom', value: 'c06301aa' },
        { type: 'custom', value: 'd0630002bbcc' },
        { type: 'srv6', value: '2001:db8:100::1', srv6EndpointBehavior: 19, srv6SidStructure: sidStructure },
        { type: 'srv6', value: '2001:db8:100::2', srv6EndpointBehavior: 19, srv6SidStructure: sidStructure }
    ]
};

// Decode only the record framing, not BGP attribute values. This independent
// expectation retains physical attribute order, flags, lengths and raw bytes.
function readRib(filePath) {
    const bytes = fs.readFileSync(filePath);
    const rows = [];
    for (let offset = 0; offset < bytes.length; ) {
        assert.ok(offset + 12 <= bytes.length, 'complete MRT header');
        const type = bytes.readUInt16BE(offset + 4);
        const subtype = bytes.readUInt16BE(offset + 6);
        const length = bytes.readUInt32BE(offset + 8);
        const end = offset + 12 + length;
        assert.ok(end <= bytes.length, 'complete MRT record body');
        const body = bytes.subarray(offset + 12, end);
        offset = end;
        assert.equal(type, 13, 'roundtrip fixtures contain TABLE_DUMP_V2');
        if (subtype === 1) continue; // Peer-index table and timestamps are not route identity.
        assert.ok([2, 4, 6, 8, 10, 12].includes(subtype), `supported RIB subtype ${subtype}`);
        const generic = subtype === 6 || subtype === 12;
        const addPath = subtype >= 8;
        let pos = 4; // Sequence number.
        const afi = generic ? body.readUInt16BE(pos) : [4, 10].includes(subtype) ? 2 : 1;
        const safi = generic ? body[pos + 2] : 1;
        if (generic) pos += 3;
        let nlriPathId = 0;
        if (generic && addPath) {
            nlriPathId = body.readUInt32BE(pos);
            pos += 4;
        }
        const nlriStart = pos;
        const bits = body[pos++];
        pos += Math.ceil(bits / 8);
        assert.ok(pos + 2 <= body.length, 'complete NLRI and entry count');
        const nlri = body.subarray(nlriStart, pos).toString('hex');
        const count = body.readUInt16BE(pos);
        pos += 2;
        for (let index = 0; index < count; index += 1) {
            assert.ok(pos + 8 <= body.length, 'complete RIB entry');
            pos += 6; // Peer index and originated timestamp.
            let pathId = nlriPathId;
            if (addPath && !generic) {
                pathId = body.readUInt32BE(pos);
                pos += 4;
            }
            const attrLength = body.readUInt16BE(pos);
            pos += 2;
            assert.ok(pos + attrLength <= body.length, 'complete path attributes');
            rows.push({ afi, safi, nlri, pathId, attrs: body.subarray(pos, pos + attrLength).toString('hex') });
            pos += attrLength;
        }
        assert.equal(pos, body.length, 'all RIB entry bytes consumed');
    }
    return rows;
}
function attributes(row) {
    const bytes = Buffer.from(row.attrs, 'hex');
    const attrs = [];
    for (let offset = 0; offset < bytes.length; ) {
        assert.ok(offset + 3 <= bytes.length);
        const flags = bytes[offset];
        const type = bytes[offset + 1];
        const extended = Boolean(flags & 0x10);
        const length = extended ? bytes.readUInt16BE(offset + 2) : bytes[offset + 2];
        const header = extended ? 4 : 3;
        const end = offset + header + length;
        assert.ok(end <= bytes.length);
        attrs.push({ type, flags, value: bytes.subarray(offset + header, end) });
        offset = end;
    }
    return attrs;
}
function canonicalRows(rows) {
    return rows.map(row => JSON.stringify(row)).sort();
}
function writeFixture(name, addressFamily, rows, options = {}) {
    const filePath = path.join(directory, `${name}.mrt`);
    const encoder = createMrtEncoder({ ...encoding, addressFamily, ...options });
    const records = [encoder.peerIndexTable()];
    let sequence = 0;
    for (const row of rows) records.push(encoder.encodeRoute(row, { sequence: sequence++ }));
    fs.writeFileSync(filePath, Buffer.concat(records));
    return filePath;
}
function row(ip, options = {}, routeAttr = emptyAttr) {
    return { ip, mask: ip.includes(':') ? 64 : 24, pathId: 0, mpNextHop: null, ...options, routeAttr };
}
function* many() {
    for (let index = 0; index < 20000; index += 1) {
        const prefix = Math.floor(index / 2);
        yield row(`10.0.${prefix >> 8}.${prefix & 255}`, { mask: 32, pathId: index % 2 });
    }
}
function fixture(name) {
    userData = path.join(directory, name);
    const values = new Map();
    const app = new BgpApp(
        { handle() {} },
        { get: key => values.get(key), set: (key, value) => values.set(key, value) }
    );
    const dbPath = app.getBgpRouteDatabasePath();
    const store = new BgpRouteSqliteStore({ dbPath }).open();
    stores.add(store);
    const worker = new BgpWorker();
    worker.routeStore = store;
    for (const addressFamily of [1, 2, 12]) {
        const { afi, safi } = getAfiAndSafi(addressFamily);
        const instance = new BgpInstance(0, afi, safi, store);
        worker.bgpInstanceMap.set(instance.instanceKey, instance);
    }
    const calls = [];
    app.startedAddressFamilies = new Set([1, 2, 12]);
    app.worker = {
        sendRequest(op, payload) {
            assert.equal(op, BgpConst.BGP_REQ_TYPES.IMPORT_ROUTES, 'use the real import handler');
            calls.push({ op, count: payload.routes.length });
            return new Promise((resolve, reject) => {
                worker.messageHandler.sendSuccessResponse = (_id, data, msg) =>
                    resolve({ status: 'success', data, msg });
                worker.messageHandler.sendErrorResponse = (_id, msg) => reject(new Error(msg));
                try {
                    worker.importRoutes('roundtrip', payload);
                } catch (error) {
                    reject(error);
                }
            });
        }
    };
    return { app, store, dbPath, calls };
}
async function roundtrip(name, inputPath, addressFamily, limit = Number.MAX_SAFE_INTEGER, expectedCount) {
    const source = readRib(inputPath);
    const expected = source.slice(0, limit === undefined ? 10000 : limit);
    if (expectedCount !== undefined) assert.equal(expected.length, expectedCount);
    const f = fixture(name);
    try {
        const imported = await f.app.handleImportRouteViewsData(null, inputPath, limit, addressFamily);
        assert.equal(imported.status, 'success', imported.msg);
        assert.deepEqual(imported.data, {
            imported: expected.length,
            added: expected.length,
            updated: 0,
            unchanged: 0,
            total: expected.length
        });
        const { afi, safi } = getAfiAndSafi(addressFamily);
        const instanceKey = BgpInstance.makeKey(0, afi, safi);
        const rows = Array.from(f.store.iterateRoutes(instanceKey));
        assert.equal(rows.length, expected.length, 'all Path IDs survive SQLite keys');
        assert.ok(
            rows.every(saved => saved.routeAttr.attributePolicy === 'configured'),
            'no implicit path defaults'
        );
        const outputPath = path.join(directory, `${name}-reexport.mrt`);
        const exported = await exportRouteDatabaseMrt({
            ...encoding,
            dbPath: f.dbPath,
            filePath: outputPath,
            addressFamily
        });
        assert.equal(exported.routeCount, expected.length);
        assert.deepEqual(
            canonicalRows(readRib(outputPath)),
            canonicalRows(expected),
            `${name}: exact NLRI, Path ID and ordered attribute bytes`
        );
        const again = await f.app.handleImportRouteViewsData(null, inputPath, limit, addressFamily);
        assert.equal(again.status, 'success', again.msg);
        assert.deepEqual(
            again.data,
            {
                imported: expected.length,
                added: 0,
                updated: 0,
                unchanged: expected.length,
                total: expected.length
            },
            'repeat import must preserve stable attributes and all path identities'
        );
        return { source, rows, imported: imported.data };
    } finally {
        f.store.close();
        stores.delete(f.store);
    }
}

async function main() {
    try {
        const dualNextHop = '20010db8000000000000000000000001fe800000000000000000000000000001';
        const ipv4 = writeFixture('ipv4-rich', 1, [
            row('192.0.2.0', { pathId: 0 }, richAttr),
            row('192.0.2.0', { pathId: 1 }, richAttr),
            row('192.0.3.0'),
            row('192.0.4.0', { nlriEncoding: 'mpReach', mpNextHop: '192.0.2.200' }, richAttr),
            row('192.0.5.0', { nlriEncoding: 'mpReach' }),
            row('192.0.6.0', { nlriEncoding: 'mpReach', mpNextHop: '2001:db8::1' }),
            row(
                '192.0.7.0',
                { nlriEncoding: 'mpReach', mpNextHop: '2001:db8::1' },
                { ...emptyAttr, mrtMpNextHopBytes: dualNextHop }
            )
        ]);
        const source4 = readRib(ipv4);
        assert.deepEqual(
            attributes(source4[0]).map(attr => attr.type),
            [4, 1, 2, 4, 3, 5, 8, 8, 16, 16, 99, 99, 40, 40]
        );
        assert.equal(
            attributes(source4[0])
                .find(attr => attr.type === 2)
                .value.readUInt32BE(2),
            70000
        );
        assert.equal(source4[2].attrs, '', 'empty classic fixture has no hidden defaults');
        assert.deepEqual(
            source4.slice(3).map(saved => attributes(saved).find(attr => attr.type === 14).value[0]),
            [4, 0, 16, 32]
        );
        const v4Result = await roundtrip('ipv4-roundtrip', ipv4, 1, Number.MAX_SAFE_INTEGER, 7);
        assert.equal(v4Result.rows.find(saved => saved.ip === '192.0.5.0').mpNextHop, null);
        assert.equal(v4Result.rows.find(saved => saved.ip === '192.0.7.0').routeAttr.mrtMpNextHopBytes, dualNextHop);

        const standard = writeFixture('without-add-path', 1, [row('198.18.0.0', {}, richAttr)], { addPath: false });
        await roundtrip('standard-roundtrip', standard, 1, Number.MAX_SAFE_INTEGER, 1);
        const ipv6 = writeFixture('ipv6-rich', 2, [
            row('2001:db8:1::', { mpNextHop: '2001:db8::1' }, richAttr),
            row('2001:db8:1::', { pathId: 1, mpNextHop: '2001:db8::1' }, richAttr),
            row('2001:db8:2::'),
            row('2001:db8:3::', { mpNextHop: '2001:db8::1' }, { ...emptyAttr, mrtMpNextHopBytes: dualNextHop })
        ]);
        await roundtrip('ipv6-roundtrip', ipv6, 2, Number.MAX_SAFE_INTEGER, 4);
        const label = writeFixture('label', 12, [
            row('198.51.100.0', { label: 16000, mpNextHop: '192.0.2.200' }, richAttr),
            row('198.51.100.0', { label: 16000, pathId: 1, mpNextHop: '192.0.2.200' })
        ]);
        const labelResult = await roundtrip('label-roundtrip', label, 12, Number.MAX_SAFE_INTEGER, 2);
        assert.ok(labelResult.rows.every(saved => saved.label === 16000));

        // The store's inline API must retain the same 32-byte pair as the real
        // worker's split route/attribute API, without leaking it into NLRI keys.
        const inline = fixture('inline-dual-next-hop');
        try {
            const route = row('203.0.113.0', { nlriEncoding: 'mpReach', mpNextHop: '2001:db8::1' });
            delete route.routeAttr;
            const inlineAttr = { ...emptyAttr, mrtMpNextHopBytes: dualNextHop };
            inline.store.upsertRoute('0|1|1', BgpRoute.makeUnicastKey(0, '0:0', route.ip, route.mask), {
                ...route,
                ...inlineAttr
            });
            const saved = Array.from(inline.store.iterateRoutes('0|1|1'))[0];
            assert.equal(saved.routeAttr.mrtMpNextHopBytes, dualNextHop);
            const output = path.join(directory, 'inline-dual-next-hop.mrt');
            await exportRouteDatabaseMrt({ ...encoding, dbPath: inline.dbPath, addressFamily: 1, filePath: output });
            assert.equal(
                attributes(readRib(output)[0])
                    .find(attr => attr.type === 14)
                    .value.toString('hex'),
                `20${dualNextHop}`
            );
        } finally {
            inline.store.close();
            stores.delete(inline.store);
        }

        const empty = writeFixture('empty', 1, []);
        const rejected = fixture('zero-and-mismatch');
        try {
            for (const input of [empty, ipv6, label]) {
                const result = await rejected.app.handleImportRouteViewsData(null, input, 10000, 1);
                assert.equal(result.status, 'error');
                assert.match(result.msg, /没有可导入.*IPv4.*路由.*地址族.*格式/);
                assert.equal(rejected.calls.length, 0, 'empty or mismatching records must not invoke worker mutations');
                assert.equal(rejected.store.getRouteCount('0|1|1'), 0);
            }
        } finally {
            rejected.store.close();
            stores.delete(rejected.store);
        }

        const large = writeFixture('default-limit', 1, many());
        // Pass undefined directly to App so iterateMrtRoutes uses its 10,000 default.
        const defaultLimit = fixture('default-limit-import');
        try {
            const result = await defaultLimit.app.handleImportRouteViewsData(null, large, undefined, 1);
            assert.equal(result.status, 'success', result.msg);
            assert.equal(result.data.imported, 10000);
            assert.equal(defaultLimit.store.getRouteCount('0|1|1'), 10000);
        } finally {
            defaultLimit.store.close();
            stores.delete(defaultLimit.store);
        }
        console.log(
            'MRT roundtrip: IPv4 classic/MP, IPv6, Label, Path ID 0/1, ordered multi-value/repeated attributes, empty defaults, 32-byte next hop, zero/mismatch and default limit passed'
        );

        if (process.argv[2]) {
            const userFile = path.resolve(process.argv[2]);
            const original = createHash('sha256').update(fs.readFileSync(userFile)).digest('hex');
            const { source, imported } = await roundtrip(
                'user-file-roundtrip',
                userFile,
                1,
                Number.MAX_SAFE_INTEGER,
                20000
            );
            const pathIds = source.reduce((counts, entry) => {
                counts[entry.pathId] = (counts[entry.pathId] || 0) + 1;
                return counts;
            }, {});
            assert.deepEqual(pathIds, { 0: 10000, 1: 10000 });
            assert.equal(
                createHash('sha256').update(fs.readFileSync(userFile)).digest('hex'),
                original,
                'user MRT stays unchanged'
            );
            console.log(
                `User MRT read-only roundtrip: ${JSON.stringify({ imported: imported.imported, pathIds, exactNlriAndOrderedAttributes: true, sourceUnchanged: true })}`
            );
        }
    } finally {
        for (const store of stores) store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
