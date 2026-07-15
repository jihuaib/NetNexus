const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (!process.versions.electron) {
    const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    if (result.error) throw result.error;
    process.exit(result.status || 0);
}

const RpkiSqliteStore = require('../../electron/worker/rpki/rpkiSqliteStore');

const DEFAULT_ROA_COUNT = 1_000_000;
const DEFAULT_ASPA_COUNT = 1_000_000;
const DEFAULT_BATCH_SIZE = 5000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_RSS_MB = 256;
const DEFAULT_MAX_HEAP_MB = 96;

function getArgValue(name, defaultValue) {
    const prefix = `--${name}=`;
    const arg = process.argv.find(item => item.startsWith(prefix));
    if (!arg) return defaultValue;
    const value = Number(arg.slice(prefix.length));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultValue;
}

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(2)} ${units[unit]}`;
}

function memory(label) {
    const usage = process.memoryUsage();
    console.log(
        `${label}: rss=${formatBytes(usage.rss)}, heapUsed=${formatBytes(usage.heapUsed)}, ` +
            `external=${formatBytes(usage.external)}`
    );
    return usage;
}

function timed(label, fn) {
    const started = process.hrtime.bigint();
    const result = fn();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`${label}: ${elapsedMs.toFixed(2)} ms`);
    return result;
}

function ipFromIndex(index) {
    const value = (0x0a000000 + index) >>> 0;
    return `${value >>> 24}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

function makeRoa(index) {
    return {
        ipType: 1,
        asn: String(64512 + (index % 1000)),
        ip: ipFromIndex(index),
        mask: '32',
        maxLength: '32'
    };
}

function makeAspa(index) {
    const customerAsn = 1_000_000_000 + index;
    const firstProvider = 2_000_000_000 + (index % 1_000_000);
    return {
        customerAsn: String(customerAsn),
        providerAsns: [firstProvider, firstProvider + 1, firstProvider + 1],
        afiFlags: (index % 3) + 1
    };
}

function assertPage(result, expectedTotal, page, pageSize) {
    const expectedLength = Math.max(0, Math.min(pageSize, expectedTotal - (page - 1) * pageSize));
    if (
        result.total !== expectedTotal ||
        result.storageTotal !== expectedTotal ||
        result.items.length !== expectedLength
    ) {
        throw new Error(
            `unexpected page ${page}: total=${result.total}, storageTotal=${result.storageTotal}, ` +
                `rows=${result.items.length}, expectedRows=${expectedLength}`
        );
    }
}

function verifyPages(store, kind, count, pageSize) {
    const query = kind === 'ROA' ? options => store.queryRoaPage(options) : options => store.queryAspaPage(options);
    const lastPage = Math.max(1, Math.ceil(count / pageSize));
    const middlePage = Math.max(1, Math.floor((lastPage + 1) / 2));
    timed(`${kind} first page`, () => assertPage(query({ page: 1, pageSize }), count, 1, pageSize));
    timed(`${kind} middle page (${middlePage})`, () =>
        assertPage(query({ page: middlePage, pageSize }), count, middlePage, pageSize)
    );
    timed(`${kind} last page (${lastPage})`, () =>
        assertPage(query({ page: lastPage, pageSize }), count, lastPage, pageSize)
    );
}

function verifyBatchIteration(iterable, expectedCount, batchSize, label) {
    let count = 0;
    let batches = 0;
    for (const batch of iterable) {
        if (!Array.isArray(batch) || batch.length === 0 || batch.length > batchSize) {
            throw new Error(`${label} yielded an invalid batch of ${batch?.length ?? 'unknown'} rows`);
        }
        count += batch.length;
        batches += 1;
    }
    if (count !== expectedCount) {
        throw new Error(`${label} count mismatch: iterated=${count}, expected=${expectedCount}`);
    }
    console.log(`${label}: rows=${count}, batches=${batches}, maxBatch=${batchSize}`);
}

function fileSizes(dbPath) {
    const result = {};
    let total = 0;
    for (const [name, filePath] of [
        ['database', dbPath],
        ['wal', `${dbPath}-wal`],
        ['shm', `${dbPath}-shm`]
    ]) {
        const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        result[name] = size;
        total += size;
    }
    return { ...result, total };
}

function main() {
    const roaCount = getArgValue('roas', DEFAULT_ROA_COUNT);
    const aspaCount = getArgValue('aspas', DEFAULT_ASPA_COUNT);
    const batchSize = getArgValue('batch', DEFAULT_BATCH_SIZE);
    const pageSize = getArgValue('pageSize', DEFAULT_PAGE_SIZE);
    const maxRssBytes = getArgValue('maxRssMb', DEFAULT_MAX_RSS_MB) * 1024 * 1024;
    const maxHeapBytes = getArgValue('maxHeapMb', DEFAULT_MAX_HEAP_MB) * 1024 * 1024;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-rpki-sqlite-benchmark-'));
    const dbPath = path.join(tempDir, 'rpki.sqlite3');
    let store;

    console.log(
        `RPKI SQLite scale benchmark: roas=${roaCount}, aspas=${aspaCount}, batch=${batchSize}, ` +
            `pageSize=${pageSize}, db=${dbPath}`
    );
    const before = memory('before');

    try {
        store = new RpkiSqliteStore({ dbPath }).open();

        timed('staged atomic ROA import', () => {
            store.beginRoaImport();
            for (let start = 0; start < roaCount; start += batchSize) {
                const end = Math.min(roaCount, start + batchSize);
                const batch = [];
                for (let index = start; index < end; index += 1) batch.push(makeRoa(index));
                const result = store.stageRoaBatch(batch, { countCandidates: false });
                if (result.processed !== batch.length) {
                    throw new Error(
                        `ROA staging mismatch at ${start}: processed=${result.processed}, batch=${batch.length}`
                    );
                }
            }
            const result = store.commitRoaImport();
            if (result.inserted !== roaCount) {
                throw new Error(`ROA commit mismatch: inserted=${result.inserted}, expected=${roaCount}`);
            }
        });
        const afterRoas = memory('after ROA insert');

        timed('staged atomic ASPA import', () => {
            store.beginAspaImport();
            for (let start = 0; start < aspaCount; start += batchSize) {
                const end = Math.min(aspaCount, start + batchSize);
                const batch = [];
                for (let index = start; index < end; index += 1) batch.push(makeAspa(index));
                const result = store.stageAspaBatch(batch);
                if (result.processed !== batch.length) {
                    throw new Error(
                        `ASPA staging mismatch at ${start}: processed=${result.processed}, batch=${batch.length}`
                    );
                }
            }
            const result = store.commitAspaImport();
            if (result.inserted !== aspaCount || result.changed !== aspaCount) {
                throw new Error(
                    `ASPA commit mismatch: inserted=${result.inserted}, changed=${result.changed}, expected=${aspaCount}`
                );
            }
        });
        const afterAspas = memory('after ASPA insert');

        if (store.getRoaCount() !== roaCount) {
            throw new Error(`ROA count mismatch: ${store.getRoaCount()} !== ${roaCount}`);
        }
        if (store.getAspaCount() !== aspaCount) {
            throw new Error(`ASPA count mismatch: ${store.getAspaCount()} !== ${aspaCount}`);
        }
        if (store.getCacheSerial() !== 3) {
            throw new Error(`atomic imports should produce two serial boundaries, got ${store.getCacheSerial()}`);
        }

        verifyPages(store, 'ROA', roaCount, pageSize);
        verifyPages(store, 'ASPA', aspaCount, pageSize);

        timed('exact ROA lookup', () => {
            const target = makeRoa(Math.floor(roaCount / 2));
            if (!store.hasRoa(target)) throw new Error('exact ROA is missing');
            const result = store.queryRoaPage({
                prefixFilter: `${target.ip}/${target.mask}`,
                asn: target.asn,
                ipType: target.ipType,
                page: 1,
                pageSize: 1
            });
            if (result.total !== 1 || result.items.length !== 1) {
                throw new Error(`exact ROA query mismatch: total=${result.total}, rows=${result.items.length}`);
            }
        });
        timed('exact ASPA lookup', () => {
            const target = makeAspa(Math.floor(aspaCount / 2));
            const result = store.getAspa(target.customerAsn);
            if (!result || result.customerAsn !== target.customerAsn) throw new Error('exact ASPA is missing');
        });

        timed('full bounded ROA batch iteration', () =>
            verifyBatchIteration(store.iterateRoaBatches({ batchSize }), roaCount, batchSize, 'ROA iteration')
        );
        timed('full bounded ASPA batch iteration', () =>
            verifyBatchIteration(store.iterateAspaBatches({ batchSize }), aspaCount, batchSize, 'ASPA iteration')
        );
        memory('after queries and full iteration');

        const serialBeforeClose = store.getCacheSerial();
        store.close();
        store = null;

        timed('read-only reopen and validation', () => {
            const reader = new RpkiSqliteStore({ dbPath, readOnly: true }).open();
            try {
                if (reader.getRoaCount() !== roaCount || reader.getAspaCount() !== aspaCount) {
                    throw new Error(
                        `reopen count mismatch: roas=${reader.getRoaCount()}, aspas=${reader.getAspaCount()}`
                    );
                }
                if (reader.getCacheSerial() !== serialBeforeClose) {
                    throw new Error(`reopen serial mismatch: ${reader.getCacheSerial()} !== ${serialBeforeClose}`);
                }
                if (roaCount > 0 && !reader.hasRoa(makeRoa(roaCount - 1))) {
                    throw new Error('last ROA is missing after reopen');
                }
                if (aspaCount > 0 && !reader.getAspa(makeAspa(aspaCount - 1).customerAsn)) {
                    throw new Error('last ASPA is missing after reopen');
                }
            } finally {
                reader.close();
            }
        });

        const after = memory('after reopen');
        const rssDelta = Math.max(0, after.rss - before.rss);
        const heapDelta = Math.max(0, after.heapUsed - before.heapUsed);
        if (rssDelta > maxRssBytes || heapDelta > maxHeapBytes) {
            throw new Error(
                `memory budget exceeded: rss=${formatBytes(rssDelta)}/${formatBytes(maxRssBytes)}, ` +
                    `heap=${formatBytes(heapDelta)}/${formatBytes(maxHeapBytes)}`
            );
        }
        const sizes = fileSizes(dbPath);
        console.log(
            `files: database=${formatBytes(sizes.database)}, wal=${formatBytes(sizes.wal)}, ` +
                `shm=${formatBytes(sizes.shm)}, total=${formatBytes(sizes.total)}`
        );
        console.log(
            `memory delta: rss=${formatBytes(rssDelta)}/${formatBytes(maxRssBytes)}, ` +
                `heapUsed=${formatBytes(heapDelta)}/${formatBytes(maxHeapBytes)}, ` +
                `ROA-rss=${formatBytes(Math.max(0, afterRoas.rss - before.rss))}, ` +
                `ASPA-rss=${formatBytes(Math.max(0, afterAspas.rss - afterRoas.rss))}`
        );
    } finally {
        store?.close();
        if (process.argv.includes('--keep')) {
            console.log(`kept benchmark database: ${dbPath}`);
        } else {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
}

main();
