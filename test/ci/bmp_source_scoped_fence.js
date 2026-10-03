const assert = require('node:assert/strict');
const BmpClientPersistenceClient = require('../../electron/worker/bmp/bmpClientPersistenceClient');
const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const BmpIngestClientPool = require('../../electron/worker/bmp/bmpIngestClientPool');
const { getClientWorkerIndex } = require('../../electron/worker/bmp/bmpClientPersistencePaths');
const { BMP_PERSISTENCE_OP } = require('../../electron/worker/bmp/bmpPersistenceConst');

const SOURCE_A = '00000000' + 'a'.repeat(56);
const SOURCE_B = '00000001' + 'b'.repeat(56);

async function main() {
    const calls = [];
    const pool = new BmpClientPersistenceClient({ dbPath: '/unused/bmp.sqlite3', writerWorkerCount: 2 });
    pool.clients = [0, 1].map(index => ({
        workerAlive: true,
        fence: async () => calls.push(['writer-fence', index]),
        purgeStaleRoutes: async (query, options) => {
            calls.push(['purge', index, query, options]);
            return { purged: index + 1 };
        }
    }));
    const query = { sourceId: SOURCE_B, scopeId: 'scope-b', includeDetails: false };
    await pool.fence(SOURCE_B.toUpperCase());
    assert.deepEqual(calls, [['writer-fence', getClientWorkerIndex(SOURCE_B, 2)]]);
    calls.length = 0;
    assert.equal((await pool.purgeStaleRoutes(query, { fence: false })).purged, 2);
    assert.deepEqual(calls, [['purge', 1, query, { fence: false }]]);
    calls.length = 0;
    await pool.fence();
    assert.deepEqual(calls, [
        ['writer-fence', 0],
        ['writer-fence', 1]
    ]);
    assert.throws(() => pool.fence('invalid-client'), /sourceId/);

    const writer = new BmpPersistenceClient();
    writer.fence = async () => calls.push(['single-fence']);
    writer.sendRequest = async (op, data) => {
        calls.push([op, data]);
        return { purged: 1 };
    };
    calls.length = 0;
    await writer.purgeStaleRoutes(query);
    assert.deepEqual(calls, [['single-fence'], [BMP_PERSISTENCE_OP.PURGE_STALE_ROUTES, query]]);
    calls.length = 0;
    await writer.purgeStaleRoutes(query, { fence: false });
    assert.deepEqual(calls, [[BMP_PERSISTENCE_OP.PURGE_STALE_ROUTES, query]]);

    const parsers = new BmpIngestClientPool({ threadCount: 2 });
    parsers.slots = [SOURCE_A, SOURCE_B].map((sourceId, index) => ({
        index,
        record: {
            token: `token-${index}`,
            session: { getPersistentSourceId: () => sourceId, socket: { destroyed: false } }
        }
    }));
    parsers.request = async (slot, message) => calls.push(['parser-fence', slot.index, message.op]);
    parsers.closeSession = async record => calls.push(['parser-close', record.token]);
    calls.length = 0;
    await parsers.fence(SOURCE_A.toUpperCase());
    assert.deepEqual(calls, [['parser-fence', 0, 'barrier']]);
    calls.length = 0;
    parsers.slots[0].record.session.socket.destroyed = true;
    await parsers.fence(SOURCE_A);
    assert.deepEqual(calls, [['parser-close', 'token-0']]);
    calls.length = 0;
    await parsers.fence();
    assert.deepEqual(calls, [
        ['parser-close', 'token-0'],
        ['parser-fence', 1, 'barrier']
    ]);
    calls.length = 0;
    parsers.slots.push({
        index: 2,
        record: { token: 'unknown-reconnect', session: { getPersistentSourceId: () => null, socket: {} } }
    });
    await parsers.fence(SOURCE_A);
    assert.deepEqual(
        calls,
        [
            ['parser-close', 'token-0'],
            ['parser-fence', 2, 'barrier']
        ],
        'a reconnect with Initiation still in the parser FIFO must be fenced'
    );
    assert.throws(() => parsers.fence('invalid-client'), /sourceId/);
    console.log('BMP source-scoped parser/writer fences passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
