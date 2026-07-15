const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const RpkiSqliteStore = require('../../electron/worker/rpki/rpkiSqliteStore');

const WRITES_PER_PROCESS = 2000;

function waitUntil(timestamp) {
    const blocker = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < timestamp) {
        Atomics.wait(blocker, 0, 0, Math.min(10, timestamp - Date.now()));
    }
}

function runWriter(dbPath, writes, startAt) {
    const store = new RpkiSqliteStore({ dbPath }).open();
    try {
        waitUntil(startAt);
        for (let index = 0; index < writes; index += 1) {
            store.bumpCacheSerial();
        }
    } finally {
        store.close();
    }
}

function spawnWriter(dbPath, writes, startAt) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [__filename, '--writer', dbPath, String(writes), String(startAt)], {
            cwd: path.join(__dirname, '..', '..'),
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'test' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        child.once('error', reject);
        child.once('exit', code => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`RPKI SQLite writer exited ${code}: ${stderr || stdout}`));
        });
    });
}

async function main() {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'netnexus-rpki-concurrency-'));
    const dbPath = path.join(tempDir, 'rpki.sqlite3');

    try {
        new RpkiSqliteStore({ dbPath }).open().close();
        const startAt = Date.now() + 750;
        await Promise.all([
            spawnWriter(dbPath, WRITES_PER_PROCESS, startAt),
            spawnWriter(dbPath, WRITES_PER_PROCESS, startAt)
        ]);

        const reader = new RpkiSqliteStore({ dbPath, readOnly: true }).open();
        try {
            assert.equal(
                reader.getCacheSerial(),
                1 + WRITES_PER_PROCESS * 2,
                'IMMEDIATE transactions must preserve every serial bump from concurrent writers'
            );
        } finally {
            reader.close();
        }
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }

    console.log('RPKI SQLite concurrent writer tests passed');
}

if (process.argv[2] === '--writer') {
    try {
        runWriter(process.argv[3], Number(process.argv[4]), Number(process.argv[5]));
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
} else {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}
