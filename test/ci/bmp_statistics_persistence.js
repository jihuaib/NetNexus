const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const { buildConnectionMutation } = require('../../electron/worker/bmp/bmpPersistenceMutation');

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-statistics-persistence-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    let store;
    let client;
    try {
        const bmpSession = {
            localIp: '127.0.0.1',
            localPort: 11019,
            remoteIp: '192.0.2.80',
            remotePort: 58000,
            sysName: 'statistics-rpc-test',
            getBmpV4TlvDraft: () => 20
        };
        const report = {
            client: {
                localIp: bmpSession.localIp,
                localPort: bmpSession.localPort,
                remoteIp: bmpSession.remoteIp,
                remotePort: bmpSession.remotePort
            },
            session: { sessionType: 0, sessionRd: '0:0', sessionIp: '198.51.100.80', sessionAs: 65080 },
            statistics: [{ type: 0, value: 80 }],
            tlvs: [],
            updatedAt: '2026-01-03T00:00:00.000Z'
        };
        const mutation = buildConnectionMutation(bmpSession, 'statistics');
        mutation.statistics = report;

        store = new BmpPersistenceStore({ dbPath }).open();
        store.applyBatch({
            batchId: 'statistics-rpc-seed',
            createdAtMs: Date.now(),
            mutations: [mutation]
        });
        store.close();
        store = null;

        client = new BmpPersistenceClient({ dbPath, readOnly: true });
        await client.open();
        assert.deepEqual(await client.queryStatisticsReports({ sourceId: mutation.source.id, kind: 'session' }), [
            report
        ]);
        assert.deepEqual(await client.queryStatisticsReports({ sourceId: mutation.source.id, kind: 'instance' }), []);

        console.log('BMP SQLite statistics persistence RPC tests passed');
    } finally {
        await client?.close({ suppressErrors: true });
        store?.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
