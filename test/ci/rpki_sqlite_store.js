const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RpkiSqliteStore = require('../../electron/worker/rpki/rpkiSqliteStore');

function roa(ip, mask, asn, maxLength, ipType = 1) {
    return {
        ip,
        mask: String(mask),
        asn: String(asn),
        maxLength: String(maxLength),
        ipType
    };
}

function aspa(customerAsn, providerAsns, afiFlags = 3) {
    return {
        customerAsn: String(customerAsn),
        providerAsns,
        afiFlags
    };
}

function assertBoundedBatches(iterable, maximum, expectedTotal) {
    let total = 0;
    let batches = 0;
    for (const batch of iterable) {
        assert.ok(Array.isArray(batch), 'batch iterators must yield arrays');
        assert.ok(batch.length > 0, 'batch iterators must not yield empty arrays');
        assert.ok(batch.length <= maximum, `batch size must remain bounded by ${maximum}`);
        total += batch.length;
        batches += 1;
    }
    assert.equal(total, expectedTotal);
    assert.equal(batches, Math.ceil(expectedTotal / maximum));
}

function testMemoryStore() {
    const store = new RpkiSqliteStore().open();
    try {
        const status = store.getStatus();
        assert.equal(status.ready, true);
        assert.equal(status.dbPath, ':memory:');
        assert.equal(status.schemaVersion, RpkiSqliteStore.SCHEMA_VERSION);
        assert.equal(status.journalMode, 'memory');
        assert.equal(status.roas, 0);
        assert.equal(status.aspas, 0);
        assert.equal(store.db.pragma('foreign_keys', { simple: true }), 1);
        assert.equal(store.db.pragma('temp_store', { simple: true }), 1);
        assert.equal(store.db.pragma('synchronous', { simple: true }), 1);
        assert.equal(store.db.pragma('busy_timeout', { simple: true }), 5000);

        const schemaObjects = new Set(
            store.db
                .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
                .all()
                .map(row => row.name)
        );
        for (const name of ['rpki_state', 'rpki_roas', 'rpki_aspas']) {
            assert.equal(schemaObjects.has(name), true, `schema object ${name} must exist`);
        }

        const initialSerial = store.getCacheSerial();
        assert.equal(initialSerial, 1);

        const firstRoa = roa('192.0.2.0', 24, 64496, 24);
        const firstInsert = store.addRoa(firstRoa);
        assert.equal(firstInsert.inserted, 1);
        assert.equal(firstInsert.added, 1);
        assert.deepEqual(firstInsert.current, firstRoa);
        assert.equal(firstInsert.total, 1);
        assert.equal(firstInsert.cacheSerial, initialSerial + 1);
        assert.equal(store.hasRoa(firstRoa), true);

        const duplicate = store.addRoa({ ...firstRoa });
        assert.equal(duplicate.inserted, 0);
        assert.equal(duplicate.skipped, 1);
        assert.equal(duplicate.total, 1);
        assert.equal(duplicate.cacheSerial, firstInsert.cacheSerial, 'duplicates must not change cache serial');

        const v4Boundary = roa('0.0.0.0', 0, 0, 32);
        const v6Boundary = roa('2001:db8::1', 128, 4294967295, 128, 2);
        const batch = store.addRoaBatch([
            roa('198.51.100.0', 24, 64497, 28),
            roa('2001:db8::', 32, 64496, 64, 2),
            v4Boundary,
            v6Boundary,
            firstRoa
        ]);
        assert.equal(batch.inserted, 4);
        assert.equal(batch.added, 4);
        assert.equal(batch.skipped, 1);
        assert.equal(batch.total, 5);
        assert.equal(store.getRoaCount(), 5);

        assert.throws(() => store.addRoa(roa('192.0.2.0', 33, 64496, 33)), /ROA|prefix|mask/i);
        assert.throws(() => store.addRoa(roa('192.0.2.0', 24, 4294967296, 24)), /ROA|ASN/i);
        assert.throws(() => store.addRoa(roa('2001:db8::', 32, 64496, 129, 2)), /ROA|max/i);

        const firstPage = store.queryRoaPage({ page: 1, pageSize: 2 });
        assert.equal(firstPage.page, 1);
        assert.equal(firstPage.pageSize, 2);
        assert.equal(firstPage.total, 5);
        assert.equal(firstPage.storageTotal, 5);
        assert.equal(firstPage.items.length, 2);
        const secondPage = store.queryRoaPage({ page: 2, pageSize: 2 });
        assert.equal(secondPage.items.length, 2);
        assert.equal(
            firstPage.items.some(first =>
                secondPage.items.some(
                    second =>
                        first.ip === second.ip &&
                        first.mask === second.mask &&
                        first.asn === second.asn &&
                        first.maxLength === second.maxLength
                )
            ),
            false,
            'stable pages must not overlap'
        );
        assert.equal(store.queryRoaPage({ page: 3, pageSize: 2 }).items.length, 1);
        assert.equal(store.queryRoaPage({ page: 4, pageSize: 2 }).items.length, 0);

        const ipv6Page = store.queryRoaPage({ ipType: 2, page: 1, pageSize: 10 });
        assert.equal(ipv6Page.total, 2);
        assert.equal(ipv6Page.storageTotal, 5);
        assert.equal(
            ipv6Page.items.every(item => item.ipType === 2),
            true
        );
        const asnPage = store.queryRoaPage({ asn: '64496', page: 1, pageSize: 10 });
        assert.equal(asnPage.total, 2);
        assert.equal(
            asnPage.items.every(item => item.asn === '64496'),
            true
        );
        const prefixPage = store.queryRoaPage({ prefixFilter: '198.51.100.0/24', page: 1, pageSize: 10 });
        assert.equal(prefixPage.total, 1);
        assert.equal(prefixPage.items[0].ip, '198.51.100.0');
        const combinedPage = store.queryRoaPage({
            ipType: 2,
            asn: '64496',
            prefixFilter: '2001:db8::/32',
            page: 1,
            pageSize: 10
        });
        assert.equal(combinedPage.total, 1);

        const beforeFailedRoaBatch = {
            count: store.getRoaCount(),
            serial: store.getCacheSerial()
        };
        assert.throws(
            () =>
                store.addRoaBatch([
                    roa('203.0.113.0', 24, 64500, 24),
                    { ip: 'invalid', mask: '24', asn: '64500', maxLength: '24', ipType: 1 },
                    roa('203.0.114.0', 24, 64500, 24)
                ]),
            /ROA|IP|address/i
        );
        assert.equal(store.getRoaCount(), beforeFailedRoaBatch.count, 'failed ROA batch must roll back rows');
        assert.equal(store.getCacheSerial(), beforeFailedRoaBatch.serial, 'failed ROA batch must roll back serial');
        assert.equal(store.hasRoa(roa('203.0.113.0', 24, 64500, 24)), false);

        assert.equal(Array.from(store.iterateRoas()).length, 5);
        assertBoundedBatches(store.iterateRoaBatches({ batchSize: 2 }), 2, 5);

        const firstAspa = aspa(65000, [65002, 65001, 65001], 3);
        const firstAspaInsert = store.upsertAspa(firstAspa);
        assert.equal(firstAspaInsert.inserted, 1);
        assert.equal(firstAspaInsert.added, 1);
        assert.equal(firstAspaInsert.overwritten, 0);
        assert.deepEqual(firstAspaInsert.current, firstAspa);
        assert.deepEqual(store.getAspa(65000), firstAspa);

        store.upsertAspa(aspa(65010, [65011], 1));
        const overwrite = store.upsertAspa(aspa(65000, [], 2));
        assert.equal(overwrite.inserted, 0);
        assert.equal(overwrite.overwritten, 1);
        assert.deepEqual(overwrite.previous, firstAspa);
        assert.deepEqual(overwrite.current.providerAsns, []);
        assert.deepEqual(store.getAspa('65000').providerAsns, []);
        const serialBeforeIdenticalAspa = store.getCacheSerial();
        const identicalAspa = store.upsertAspa(aspa(65000, [], 2));
        assert.equal(identicalAspa.changed, 0, 'identical ASPA upsert must be a no-op');
        assert.equal(identicalAspa.overwritten, 0);
        assert.equal(store.getCacheSerial(), serialBeforeIdenticalAspa, 'identical ASPA must not bump serial');
        assert.deepEqual(
            store.queryAspaPage({ page: 1, pageSize: 10 }).items.map(item => item.customerAsn),
            ['65000', '65010'],
            'ASPA overwrite must preserve insertion order'
        );

        const aspaBatch = store.upsertAspaBatch([
            aspa(65100, [65102, 65101, 65101], 3),
            aspa(65100, [65103, 65103, 65104], 1),
            aspa(65200, [], 2),
            aspa(4294967295, [0, 4294967295, 0], 3)
        ]);
        assert.equal(aspaBatch.inserted, 3);
        assert.equal(aspaBatch.added, 3);
        assert.equal(aspaBatch.overwritten, 1);
        assert.equal(aspaBatch.total, 5);
        assert.deepEqual(store.getAspa(65100).providerAsns, [65103, 65103, 65104]);
        assert.deepEqual(store.getAspa(65200).providerAsns, []);
        assert.deepEqual(store.getAspa(4294967295).providerAsns, [0, 4294967295, 0]);

        const aspaPage = store.queryAspaPage({ page: 2, pageSize: 2 });
        assert.equal(aspaPage.total, 5);
        assert.equal(aspaPage.storageTotal, 5);
        assert.equal(aspaPage.items.length, 2);

        const beforeFailedAspaBatch = {
            count: store.getAspaCount(),
            serial: store.getCacheSerial(),
            existing: store.getAspa(65100)
        };
        assert.throws(
            () => store.upsertAspaBatch([aspa(65100, [1], 1), aspa(65300, [-1], 3), aspa(65400, [65401], 3)]),
            /ASPA|Provider|ASN/i
        );
        assert.equal(store.getAspaCount(), beforeFailedAspaBatch.count, 'failed ASPA batch must roll back rows');
        assert.equal(store.getCacheSerial(), beforeFailedAspaBatch.serial, 'failed ASPA batch must roll back serial');
        assert.deepEqual(store.getAspa(65100), beforeFailedAspaBatch.existing);
        assert.equal(store.getAspa(65300), null);
        assert.throws(() => store.getAspa(''), /Customer ASN/i, 'empty Customer ASN must not alias ASN 0');
        assert.throws(() => store.deleteAspa('AS'), /Customer ASN/i, 'empty AS-prefixed input must be rejected');

        assert.equal(Array.from(store.iterateAspas()).length, 5);
        assertBoundedBatches(store.iterateAspaBatches({ batchSize: 2 }), 2, 5);

        const deletedRoa = store.deleteRoa(firstRoa);
        assert.equal(deletedRoa.deleted, 1);
        assert.deepEqual(deletedRoa.previous, firstRoa);
        assert.equal(store.deleteRoa(firstRoa).deleted, 0);
        assert.equal(store.hasRoa(firstRoa), false);

        const deletedAspa = store.deleteAspa(65000);
        assert.equal(deletedAspa.deleted, 1);
        assert.deepEqual(deletedAspa.previous.providerAsns, []);
        assert.equal(store.deleteAspa(65000).deleted, 0);
        assert.equal(store.getAspa(65000), null);

        assert.equal(store.clearRoas().deleted, 4);
        assert.equal(store.clearRoas().deleted, 0);
        assert.equal(store.getRoaCount(), 0);
        assert.equal(store.clearAspas().deleted, 4);
        assert.equal(store.clearAspas().deleted, 0);
        assert.equal(store.getAspaCount(), 0);

        const beforeStagingSerial = store.getCacheSerial();
        store.beginRoaImport();
        const stagedRoas = store.stageRoaBatch([
            roa('10.0.0.0', 24, 64512, 24),
            roa('10.0.1.0', 24, 64513, 24),
            roa('10.0.0.0', 24, 64512, 24)
        ]);
        assert.equal(stagedRoas.candidates, 2);
        assert.equal(store.getRoaCount(), 0, 'staging must not expose ROAs before commit');
        assert.equal(store.getCacheSerial(), beforeStagingSerial, 'staging must not bump serial');
        store.abortRoaImport();
        assert.equal(store.getRoaCount(), 0, 'aborted ROA staging must leave primary data unchanged');

        store.beginRoaImport();
        store.stageRoaBatch([roa('10.0.0.0', 24, 64512, 24), roa('10.0.1.0', 24, 64513, 24)]);
        const committedRoas = store.commitRoaImport({ maxInserted: 1 });
        assert.equal(committedRoas.inserted, 1);
        assert.equal(committedRoas.ignoredByLimit, 1);
        assert.equal(store.getRoaCount(), 1);

        const serialBeforeAspaStaging = store.getCacheSerial();
        store.beginAspaImport();
        store.stageAspaBatch([aspa(65000, [65001], 3), aspa(65000, [65002], 1)]);
        assert.equal(store.getAspaCount(), 0, 'staging must not expose ASPAs before commit');
        assert.equal(store.getCacheSerial(), serialBeforeAspaStaging, 'ASPA staging must not bump serial');
        const committedAspas = store.commitAspaImport();
        assert.equal(committedAspas.inserted, 1);
        assert.equal(committedAspas.changed, 1);
        assert.deepEqual(store.getAspa(65000).providerAsns, [65002], 'last staged ASPA value must win');
    } finally {
        store.close();
    }
}

function testFileStore() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-rpki-sqlite-'));
    const dbPath = path.join(tempDir, 'rpki.sqlite3');
    const originalRoa = roa('203.0.113.0', 24, 64512, 24);
    const snapshotRoa = roa('203.0.114.0', 24, 64513, 24);
    const originalAspa = aspa(64512, [64513, 64513, 64514], 3);
    let writer;
    let reader;

    try {
        writer = new RpkiSqliteStore({ dbPath }).open();
        assert.equal(writer.getStatus().journalMode, 'wal');
        writer.addRoa(originalRoa);
        writer.upsertAspa(originalAspa);
        const persistedSerial = writer.getCacheSerial();
        writer.close();
        writer = null;

        writer = new RpkiSqliteStore({ dbPath }).open();
        assert.equal(writer.getRoaCount(), 1);
        assert.equal(writer.getAspaCount(), 1);
        assert.equal(writer.getCacheSerial(), persistedSerial, 'cache serial must survive reopen');
        assert.equal(writer.hasRoa(originalRoa), true);
        assert.deepEqual(writer.getAspa(64512), originalAspa);

        reader = new RpkiSqliteStore({ dbPath, readOnly: true }).open();
        assert.equal(reader.db.pragma('cache_size', { simple: true }), -4096);
        const snapshot = reader.beginReadSnapshot();
        assert.deepEqual(snapshot, {
            cacheSerial: persistedSerial,
            roaCount: 1,
            aspaCount: 1
        });

        const writeDuringSnapshot = writer.addRoa(snapshotRoa);
        writer.upsertAspa(aspa(64520, [], 1));
        assert.equal(writeDuringSnapshot.inserted, 1, 'WAL writer must not be blocked by a read snapshot');
        assert.equal(reader.getRoaCount(), 1, 'read transaction must retain its ROA snapshot');
        assert.equal(reader.getAspaCount(), 1, 'read transaction must retain its ASPA snapshot');
        assert.deepEqual(Array.from(reader.iterateRoas()), [originalRoa]);
        assert.deepEqual(Array.from(reader.iterateAspas()), [originalAspa]);

        reader.endReadSnapshot();
        assert.equal(reader.getRoaCount(), 2, 'ending snapshot must expose newly committed ROAs');
        assert.equal(reader.getAspaCount(), 2, 'ending snapshot must expose newly committed ASPAs');
        assert.equal(reader.getCacheSerial(), writer.getCacheSerial());
        assert.throws(() => reader.addRoa(roa('203.0.115.0', 24, 64514, 24)), /read.?only/i);
        assert.throws(() => reader.bumpCacheSerial(), /read.?only/i);

        reader.close();
        reader = null;
        writer.close();
        writer = null;

        reader = new RpkiSqliteStore({ dbPath, readOnly: true }).open();
        assert.equal(reader.getRoaCount(), 2);
        assert.equal(reader.getAspaCount(), 2);
        assert.equal(reader.hasRoa(snapshotRoa), true);
        assert.deepEqual(reader.getAspa(64520).providerAsns, []);
    } finally {
        reader?.close();
        writer?.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function testIncompatibleSchemaIsRejected() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-rpki-schema-'));
    const dbPath = path.join(tempDir, 'rpki.sqlite3');
    let store;

    try {
        store = new RpkiSqliteStore({ dbPath }).open();
        store.db.pragma(`user_version = ${RpkiSqliteStore.SCHEMA_VERSION + 1}`);
        store.close();
        store = null;

        assert.throws(
            () => new RpkiSqliteStore({ dbPath }).open(),
            /schema .* incompatible.*migration is not supported/i,
            'schema upgrades must be rejected instead of migrating old RPKI data'
        );
    } finally {
        store?.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

testMemoryStore();
testFileStore();
testIncompatibleSchemaIsRejected();

console.log('RPKI SQLite store tests passed');
