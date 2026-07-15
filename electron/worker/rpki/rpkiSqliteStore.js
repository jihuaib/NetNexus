const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const ipaddr = require('ipaddr.js');
const { normalizeRoaObject } = require('../../utils/rpkiRoaImport');
const { normalizeAspaObject } = require('../../utils/rpkiAspaImport');
const { getNetworkAddress } = require('../../utils/ipUtils');

const SCHEMA_VERSION = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_ITERATION_BATCH_SIZE = 2000;
const MAX_ITERATION_BATCH_SIZE = 10000;
const UINT32_MAX = 0xffffffff;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) {
        return fallback;
    }
    return Math.min(number, maximum);
}

function normalizeCustomerAsn(value) {
    if (value === null || value === undefined) {
        throw new Error(`Invalid RPKI ASPA Customer ASN: ${value}`);
    }
    const text = typeof value === 'string' ? value.trim().replace(/^AS/i, '') : value;
    if (text === '') {
        throw new Error(`Invalid RPKI ASPA Customer ASN: ${value}`);
    }
    const number = Number(text);
    if (!Number.isInteger(number) || number < 0 || number > UINT32_MAX) {
        throw new Error(`Invalid RPKI ASPA Customer ASN: ${value}`);
    }
    return number;
}

function normalizeRoaInput(value) {
    const roa = normalizeRoaObject(value);
    if (!roa) {
        throw new Error('Invalid RPKI ROA prefix, mask, ASN, or max length');
    }
    return roa;
}

function normalizeAspaInput(value) {
    const aspa = normalizeAspaObject(value);
    if (!aspa) {
        throw new Error('Invalid RPKI ASPA Customer ASN, Provider ASN list, or AFI flags');
    }
    return aspa;
}

function parseProviderAsns(value) {
    let providerAsns;
    try {
        providerAsns = JSON.parse(value);
    } catch (error) {
        throw new Error(`Corrupt RPKI ASPA Provider ASN JSON: ${error.message}`);
    }
    if (!Array.isArray(providerAsns)) {
        throw new Error('Corrupt RPKI ASPA Provider ASN JSON: expected an array');
    }
    return providerAsns;
}

function normalizePrefixFilter(value) {
    const text = value === null || value === undefined ? '' : String(value).trim().toLowerCase();
    if (!text) {
        return { mode: 'none' };
    }

    const slashIndex = text.lastIndexOf('/');
    if (slashIndex > 0 && slashIndex < text.length - 1) {
        const prefix = text.slice(0, slashIndex).trim();
        const maskText = text.slice(slashIndex + 1).trim();
        if (ipaddr.isValid(prefix) && /^\d+$/.test(maskText)) {
            const address = ipaddr.parse(prefix);
            const mask = Number(maskText);
            const maximum = address.kind() === 'ipv4' ? 32 : 128;
            if (mask >= 0 && mask <= maximum) {
                return {
                    mode: 'cidr',
                    prefix: getNetworkAddress(address.toString(), mask).split('/')[0].toLowerCase(),
                    mask
                };
            }
        }
    }

    if (ipaddr.isValid(text)) {
        return {
            mode: 'address',
            prefix: ipaddr.parse(text).toNormalizedString().toLowerCase()
        };
    }

    return { mode: 'contains', text };
}

class RpkiSqliteStore {
    constructor(options = {}) {
        if (typeof options === 'string') {
            options = { dbPath: options };
        }
        this.dbPath = options.dbPath || ':memory:';
        if (this.dbPath !== ':memory:') {
            this.dbPath = path.resolve(this.dbPath);
        }
        this.readOnly = options.readOnly === true;
        this.db = null;
        this.statements = null;
        this.transactions = null;
        this.importStatements = null;
        this.dynamicStatements = new Map();
        this.readSnapshotActive = false;
    }

    open() {
        if (this.db) {
            return this;
        }
        if (!this.readOnly && this.dbPath !== ':memory:') {
            fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        }

        this.db = new Database(this.dbPath, {
            readonly: this.readOnly,
            fileMustExist: this.readOnly,
            timeout: 5000
        });
        try {
            this.db.pragma('busy_timeout = 5000');
            this.db.pragma('foreign_keys = ON');
            this.db.pragma(`cache_size = -${this.readOnly ? 4096 : 32768}`);
            this.db.pragma('temp_store = FILE');
            if (!this.readOnly) {
                if (this.dbPath !== ':memory:') {
                    this.db.pragma('journal_mode = WAL');
                    this.db.pragma('wal_autocheckpoint = 2000');
                }
                this.db.pragma('synchronous = NORMAL');
                this.initializeSchema();
            }
            this.validateSchema();
            this.prepareStatements();
        } catch (error) {
            this.db.close();
            this.db = null;
            throw error;
        }
        return this;
    }

    ensureOpen() {
        if (!this.db) {
            this.open();
        }
    }

    assertWritable() {
        this.ensureOpen();
        if (this.readOnly) {
            throw new Error('Cannot write to a read-only RPKI SQLite store');
        }
    }

    initializeSchema() {
        const currentVersion = this.db.pragma('user_version', { simple: true });
        if (currentVersion === SCHEMA_VERSION) {
            return;
        }
        if (currentVersion !== 0) {
            throw new Error(
                `RPKI SQLite schema ${currentVersion} is incompatible with schema ${SCHEMA_VERSION}; data migration is not supported across major versions`
            );
        }

        const initializeTransaction = this.db.transaction(() => {
            this.db.exec(`
                CREATE TABLE rpki_state (
                    state_id INTEGER PRIMARY KEY CHECK(state_id = 1),
                    roa_count INTEGER NOT NULL DEFAULT 0 CHECK(roa_count >= 0),
                    aspa_count INTEGER NOT NULL DEFAULT 0 CHECK(aspa_count >= 0),
                    cache_serial INTEGER NOT NULL DEFAULT 1 CHECK(cache_serial >= 0 AND cache_serial <= 4294967295)
                );

                CREATE TABLE rpki_roas (
                    roa_id INTEGER PRIMARY KEY,
                    ip_type INTEGER NOT NULL CHECK(ip_type IN (1, 2)),
                    prefix TEXT NOT NULL,
                    prefix_length INTEGER NOT NULL CHECK(prefix_length >= 0 AND prefix_length <= 128),
                    asn INTEGER NOT NULL CHECK(asn >= 0 AND asn <= 4294967295),
                    max_length INTEGER NOT NULL CHECK(max_length >= prefix_length AND max_length <= 128),
                    UNIQUE(prefix, prefix_length, asn, max_length)
                );

                CREATE TABLE rpki_aspas (
                    aspa_id INTEGER PRIMARY KEY,
                    customer_asn INTEGER NOT NULL UNIQUE CHECK(customer_asn >= 0 AND customer_asn <= 4294967295),
                    provider_asns_json TEXT NOT NULL,
                    afi_flags INTEGER NOT NULL CHECK(afi_flags IN (1, 2, 3))
                );

                CREATE INDEX idx_rpki_roas_ip_type_id
                    ON rpki_roas(ip_type, roa_id);
                CREATE INDEX idx_rpki_roas_asn_id
                    ON rpki_roas(asn, roa_id);
                CREATE INDEX idx_rpki_roas_ip_type_asn_id
                    ON rpki_roas(ip_type, asn, roa_id);
                CREATE INDEX idx_rpki_roas_prefix_length_id
                    ON rpki_roas(prefix, prefix_length, roa_id);
            `);

            this.db
                .prepare(
                    `INSERT INTO rpki_state(state_id, roa_count, aspa_count, cache_serial)
                     VALUES(1, 0, 0, 1)`
                )
                .run();
            this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
        });
        initializeTransaction.immediate();
    }

    validateSchema() {
        const version = this.db.pragma('user_version', { simple: true });
        if (version !== SCHEMA_VERSION) {
            throw new Error(`RPKI SQLite schema ${version} is not readable; expected ${SCHEMA_VERSION}`);
        }
        const requiredTables = ['rpki_state', 'rpki_roas', 'rpki_aspas'];
        const tables = new Set(
            this.db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all()
                .map(row => row.name)
        );
        for (const table of requiredTables) {
            if (!tables.has(table)) {
                throw new Error(`RPKI SQLite schema is missing table ${table}`);
            }
        }
    }

    prepareStatements() {
        this.statements = {
            getState: this.db.prepare(
                'SELECT roa_count AS roaCount, aspa_count AS aspaCount, cache_serial AS cacheSerial FROM rpki_state WHERE state_id = 1'
            ),
            updateSerial: this.db.prepare('UPDATE rpki_state SET cache_serial = ? WHERE state_id = 1'),
            incrementRoaCount: this.db.prepare('UPDATE rpki_state SET roa_count = roa_count + ? WHERE state_id = 1'),
            incrementAspaCount: this.db.prepare('UPDATE rpki_state SET aspa_count = aspa_count + ? WHERE state_id = 1'),
            setRoaCount: this.db.prepare('UPDATE rpki_state SET roa_count = ? WHERE state_id = 1'),
            setAspaCount: this.db.prepare('UPDATE rpki_state SET aspa_count = ? WHERE state_id = 1'),
            getRoa: this.db.prepare(
                `SELECT roa_id, ip_type, prefix, prefix_length, asn, max_length
                 FROM rpki_roas
                 WHERE prefix = ? AND prefix_length = ? AND asn = ? AND max_length = ?`
            ),
            insertRoa: this.db.prepare(
                `INSERT OR IGNORE INTO rpki_roas(ip_type, prefix, prefix_length, asn, max_length)
                 VALUES(?, ?, ?, ?, ?)`
            ),
            deleteRoa: this.db.prepare(
                'DELETE FROM rpki_roas WHERE prefix = ? AND prefix_length = ? AND asn = ? AND max_length = ?'
            ),
            deleteAllRoas: this.db.prepare('DELETE FROM rpki_roas'),
            iterateRoas: this.db.prepare(
                'SELECT roa_id, ip_type, prefix, prefix_length, asn, max_length FROM rpki_roas ORDER BY roa_id'
            ),
            getAspa: this.db.prepare(
                `SELECT aspa_id, customer_asn, provider_asns_json, afi_flags
                 FROM rpki_aspas WHERE customer_asn = ?`
            ),
            insertAspa: this.db.prepare(
                'INSERT INTO rpki_aspas(customer_asn, provider_asns_json, afi_flags) VALUES(?, ?, ?)'
            ),
            updateAspa: this.db.prepare(
                'UPDATE rpki_aspas SET provider_asns_json = ?, afi_flags = ? WHERE customer_asn = ?'
            ),
            deleteAspa: this.db.prepare('DELETE FROM rpki_aspas WHERE customer_asn = ?'),
            deleteAllAspas: this.db.prepare('DELETE FROM rpki_aspas'),
            iterateAspas: this.db.prepare(
                'SELECT aspa_id, customer_asn, provider_asns_json, afi_flags FROM rpki_aspas ORDER BY aspa_id'
            )
        };

        const immediateTransaction = callback => this.db.transaction(callback).immediate;
        this.transactions = {
            bumpCacheSerial: immediateTransaction(() => this.bumpCacheSerialInTransaction()),
            addRoa: immediateTransaction(roa => this.addRoaInTransaction(roa)),
            addRoaBatch: immediateTransaction((roas, options) => this.addRoaBatchInTransaction(roas, options)),
            deleteRoa: immediateTransaction(roa => this.deleteRoaInTransaction(roa)),
            clearRoas: immediateTransaction(() => this.clearRoasInTransaction()),
            upsertAspa: immediateTransaction(aspa => this.upsertAspaInTransaction(aspa)),
            upsertAspaBatch: immediateTransaction(aspas => this.upsertAspaBatchInTransaction(aspas)),
            deleteAspa: immediateTransaction(customerAsn => this.deleteAspaInTransaction(customerAsn)),
            clearAspas: immediateTransaction(() => this.clearAspasInTransaction())
        };
    }

    getState() {
        this.ensureOpen();
        const state = this.statements.getState.get();
        if (!state) {
            throw new Error('RPKI SQLite state row is missing');
        }
        return state;
    }

    getCacheSerial() {
        return Number(this.getState().cacheSerial) >>> 0;
    }

    bumpCacheSerialInTransaction() {
        const current = this.getCacheSerial();
        const next = current >= UINT32_MAX ? 0 : current + 1;
        this.statements.updateSerial.run(next);
        return next >>> 0;
    }

    bumpCacheSerial() {
        this.assertWritable();
        return this.transactions.bumpCacheSerial();
    }

    getRoaCount() {
        return Number(this.getState().roaCount) || 0;
    }

    getAspaCount() {
        return Number(this.getState().aspaCount) || 0;
    }

    roaParameters(roa) {
        return [roa.ip, Number(roa.mask), Number(roa.asn), Number(roa.maxLength)];
    }

    hydrateRoa(row) {
        if (!row) {
            return null;
        }
        return {
            ipType: Number(row.ip_type),
            asn: String(row.asn),
            ip: row.prefix,
            mask: String(row.prefix_length),
            maxLength: String(row.max_length)
        };
    }

    hydrateAspa(row) {
        if (!row) {
            return null;
        }
        return {
            customerAsn: String(row.customer_asn),
            providerAsns: parseProviderAsns(row.provider_asns_json),
            afiFlags: Number(row.afi_flags)
        };
    }

    hasRoa(value) {
        this.ensureOpen();
        const roa = normalizeRoaInput(value);
        return Boolean(this.statements.getRoa.get(...this.roaParameters(roa)));
    }

    addRoaInTransaction(value) {
        const roa = normalizeRoaInput(value);
        const result = this.statements.insertRoa.run(
            Number(roa.ipType),
            roa.ip,
            Number(roa.mask),
            Number(roa.asn),
            Number(roa.maxLength)
        );
        let cacheSerial = this.getCacheSerial();
        if (result.changes > 0) {
            this.statements.incrementRoaCount.run(1);
            cacheSerial = this.bumpCacheSerialInTransaction();
        }
        return {
            inserted: result.changes,
            added: result.changes,
            skipped: result.changes > 0 ? 0 : 1,
            duplicate: result.changes === 0,
            current: roa,
            roa,
            total: this.getRoaCount(),
            cacheSerial
        };
    }

    addRoa(value) {
        this.assertWritable();
        return this.transactions.addRoa(value);
    }

    addRoaBatchInTransaction(values, options = {}) {
        if (!values || typeof values[Symbol.iterator] !== 'function') {
            throw new Error('RPKI ROA batch must be iterable');
        }
        const maximumInserted =
            options?.maxInserted === null || options?.maxInserted === undefined
                ? Number.MAX_SAFE_INTEGER
                : Math.max(0, Number(options.maxInserted) || 0);
        let inserted = 0;
        let skipped = 0;
        let processed = 0;
        for (const value of values) {
            if (inserted >= maximumInserted) {
                break;
            }
            const roa = normalizeRoaInput(value);
            const result = this.statements.insertRoa.run(
                Number(roa.ipType),
                roa.ip,
                Number(roa.mask),
                Number(roa.asn),
                Number(roa.maxLength)
            );
            processed += 1;
            if (result.changes > 0) {
                inserted += 1;
            } else {
                skipped += 1;
            }
        }
        let cacheSerial = this.getCacheSerial();
        if (inserted > 0) {
            this.statements.incrementRoaCount.run(inserted);
            cacheSerial = this.bumpCacheSerialInTransaction();
        }
        return {
            inserted,
            added: inserted,
            skipped,
            processed,
            total: this.getRoaCount(),
            cacheSerial
        };
    }

    addRoaBatch(values, options = {}) {
        this.assertWritable();
        return this.transactions.addRoaBatch(values, options);
    }

    deleteRoaInTransaction(value) {
        const roa = normalizeRoaInput(value);
        const row = this.statements.getRoa.get(...this.roaParameters(roa));
        if (!row) {
            return {
                deleted: 0,
                previous: null,
                deletedItem: null,
                total: this.getRoaCount(),
                cacheSerial: this.getCacheSerial()
            };
        }
        this.statements.deleteRoa.run(...this.roaParameters(roa));
        this.statements.incrementRoaCount.run(-1);
        const cacheSerial = this.bumpCacheSerialInTransaction();
        const previous = this.hydrateRoa(row);
        return {
            deleted: 1,
            previous,
            deletedItem: previous,
            total: this.getRoaCount(),
            cacheSerial
        };
    }

    deleteRoa(value) {
        this.assertWritable();
        return this.transactions.deleteRoa(value);
    }

    clearRoasInTransaction() {
        const deleted = this.getRoaCount();
        let cacheSerial = this.getCacheSerial();
        if (deleted > 0) {
            this.statements.deleteAllRoas.run();
            this.statements.setRoaCount.run(0);
            cacheSerial = this.bumpCacheSerialInTransaction();
        }
        return { deleted, total: 0, cacheSerial };
    }

    clearRoas() {
        this.assertWritable();
        return this.transactions.clearRoas();
    }

    getAspa(customerAsn) {
        this.ensureOpen();
        return this.hydrateAspa(this.statements.getAspa.get(normalizeCustomerAsn(customerAsn)));
    }

    upsertAspaInTransaction(value, options = {}) {
        const aspa = normalizeAspaInput(value);
        const customerAsn = Number(aspa.customerAsn);
        const previousRow = this.statements.getAspa.get(customerAsn);
        const previous = this.hydrateAspa(previousRow);
        const providerJson = JSON.stringify(aspa.providerAsns);
        const identical =
            previousRow &&
            previousRow.provider_asns_json === providerJson &&
            Number(previousRow.afi_flags) === Number(aspa.afiFlags);
        if (identical) {
            return {
                inserted: 0,
                added: 0,
                overwritten: 0,
                changed: 0,
                skipped: 1,
                previous,
                oldAspa: previous,
                current: aspa,
                newAspa: aspa,
                total: this.getAspaCount(),
                cacheSerial: this.getCacheSerial()
            };
        }
        if (previousRow) {
            this.statements.updateAspa.run(providerJson, Number(aspa.afiFlags), customerAsn);
        } else {
            this.statements.insertAspa.run(customerAsn, providerJson, Number(aspa.afiFlags));
            this.statements.incrementAspaCount.run(1);
        }
        const cacheSerial = options.bumpSerial === false ? this.getCacheSerial() : this.bumpCacheSerialInTransaction();
        return {
            inserted: previousRow ? 0 : 1,
            added: previousRow ? 0 : 1,
            overwritten: previousRow ? 1 : 0,
            changed: 1,
            skipped: 0,
            previous,
            oldAspa: previous,
            current: aspa,
            newAspa: aspa,
            total: this.getAspaCount(),
            cacheSerial
        };
    }

    upsertAspa(value) {
        this.assertWritable();
        return this.transactions.upsertAspa(value);
    }

    upsertAspaBatchInTransaction(values) {
        if (!values || typeof values[Symbol.iterator] !== 'function') {
            throw new Error('RPKI ASPA batch must be iterable');
        }
        let inserted = 0;
        let overwritten = 0;
        let changed = 0;
        for (const value of values) {
            const result = this.upsertAspaInTransaction(value, { bumpSerial: false });
            inserted += result.inserted;
            overwritten += result.overwritten;
            changed += result.changed;
        }
        let cacheSerial = this.getCacheSerial();
        if (changed > 0) {
            cacheSerial = this.bumpCacheSerialInTransaction();
        }
        return {
            inserted,
            added: inserted,
            overwritten,
            changed,
            total: this.getAspaCount(),
            cacheSerial
        };
    }

    upsertAspaBatch(values) {
        this.assertWritable();
        return this.transactions.upsertAspaBatch(values);
    }

    deleteAspaInTransaction(value) {
        const customerAsn = normalizeCustomerAsn(value);
        const row = this.statements.getAspa.get(customerAsn);
        if (!row) {
            return {
                deleted: 0,
                previous: null,
                deletedItem: null,
                total: this.getAspaCount(),
                cacheSerial: this.getCacheSerial()
            };
        }
        this.statements.deleteAspa.run(customerAsn);
        this.statements.incrementAspaCount.run(-1);
        const cacheSerial = this.bumpCacheSerialInTransaction();
        const previous = this.hydrateAspa(row);
        return {
            deleted: 1,
            previous,
            deletedItem: previous,
            total: this.getAspaCount(),
            cacheSerial
        };
    }

    deleteAspa(customerAsn) {
        this.assertWritable();
        return this.transactions.deleteAspa(customerAsn);
    }

    clearAspasInTransaction() {
        const deleted = this.getAspaCount();
        let cacheSerial = this.getCacheSerial();
        if (deleted > 0) {
            this.statements.deleteAllAspas.run();
            this.statements.setAspaCount.run(0);
            cacheSerial = this.bumpCacheSerialInTransaction();
        }
        return { deleted, total: 0, cacheSerial };
    }

    clearAspas() {
        this.assertWritable();
        return this.transactions.clearAspas();
    }

    ensureImportStatements() {
        this.assertWritable();
        if (this.importStatements) {
            return;
        }

        this.db.exec(`
            CREATE TEMP TABLE IF NOT EXISTS rpki_roa_import_stage (
                stage_id INTEGER PRIMARY KEY,
                ip_type INTEGER NOT NULL,
                prefix TEXT NOT NULL,
                prefix_length INTEGER NOT NULL,
                asn INTEGER NOT NULL,
                max_length INTEGER NOT NULL,
                UNIQUE(prefix, prefix_length, asn, max_length)
            );

            CREATE TEMP TABLE IF NOT EXISTS rpki_aspa_import_stage (
                stage_id INTEGER PRIMARY KEY,
                customer_asn INTEGER NOT NULL UNIQUE,
                provider_asns_json TEXT NOT NULL,
                afi_flags INTEGER NOT NULL
            );
        `);

        this.importStatements = {
            clearRoaStage: this.db.prepare('DELETE FROM temp.rpki_roa_import_stage'),
            insertRoaStage: this.db.prepare(
                `INSERT OR IGNORE INTO temp.rpki_roa_import_stage(
                    ip_type, prefix, prefix_length, asn, max_length
                 ) VALUES(?, ?, ?, ?, ?)`
            ),
            countRoaStage: this.db.prepare('SELECT COUNT(*) AS total FROM temp.rpki_roa_import_stage'),
            countRoaCandidates: this.db.prepare(
                `SELECT COUNT(*) AS total
                 FROM temp.rpki_roa_import_stage AS stage
                 WHERE NOT EXISTS (
                    SELECT 1 FROM rpki_roas AS current
                    WHERE current.prefix = stage.prefix
                      AND current.prefix_length = stage.prefix_length
                      AND current.asn = stage.asn
                      AND current.max_length = stage.max_length
                 )`
            ),
            commitRoaStage: this.db.prepare(
                `INSERT INTO rpki_roas(ip_type, prefix, prefix_length, asn, max_length)
                 SELECT stage.ip_type, stage.prefix, stage.prefix_length, stage.asn, stage.max_length
                 FROM temp.rpki_roa_import_stage AS stage
                 WHERE NOT EXISTS (
                    SELECT 1 FROM rpki_roas AS current
                    WHERE current.prefix = stage.prefix
                      AND current.prefix_length = stage.prefix_length
                      AND current.asn = stage.asn
                      AND current.max_length = stage.max_length
                 )
                 ORDER BY stage.stage_id
                 LIMIT ?`
            ),
            clearAspaStage: this.db.prepare('DELETE FROM temp.rpki_aspa_import_stage'),
            upsertAspaStage: this.db.prepare(
                `INSERT INTO temp.rpki_aspa_import_stage(customer_asn, provider_asns_json, afi_flags)
                 VALUES(?, ?, ?)
                 ON CONFLICT(customer_asn) DO UPDATE SET
                    provider_asns_json = excluded.provider_asns_json,
                    afi_flags = excluded.afi_flags`
            ),
            countAspaStage: this.db.prepare('SELECT COUNT(*) AS total FROM temp.rpki_aspa_import_stage'),
            countNewAspaCandidates: this.db.prepare(
                `SELECT COUNT(*) AS total
                 FROM temp.rpki_aspa_import_stage AS stage
                 WHERE NOT EXISTS (
                    SELECT 1 FROM rpki_aspas AS current WHERE current.customer_asn = stage.customer_asn
                 )`
            ),
            countChangedAspaCandidates: this.db.prepare(
                `SELECT COUNT(*) AS total
                 FROM temp.rpki_aspa_import_stage AS stage
                 LEFT JOIN rpki_aspas AS current ON current.customer_asn = stage.customer_asn
                 WHERE current.customer_asn IS NULL
                    OR current.provider_asns_json <> stage.provider_asns_json
                    OR current.afi_flags <> stage.afi_flags`
            ),
            commitAspaStage: this.db.prepare(
                `INSERT INTO rpki_aspas(customer_asn, provider_asns_json, afi_flags)
                 SELECT stage.customer_asn, stage.provider_asns_json, stage.afi_flags
                 FROM temp.rpki_aspa_import_stage AS stage
                 LEFT JOIN rpki_aspas AS current ON current.customer_asn = stage.customer_asn
                 WHERE current.customer_asn IS NULL
                    OR current.provider_asns_json <> stage.provider_asns_json
                    OR current.afi_flags <> stage.afi_flags
                 ORDER BY stage.stage_id
                 ON CONFLICT(customer_asn) DO UPDATE SET
                    provider_asns_json = excluded.provider_asns_json,
                    afi_flags = excluded.afi_flags`
            )
        };

        const immediateTransaction = callback => this.db.transaction(callback).immediate;
        this.transactions.stageRoaBatch = immediateTransaction((values, options) =>
            this.stageRoaBatchInTransaction(values, options)
        );
        this.transactions.commitRoaImport = immediateTransaction(options => this.commitRoaImportInTransaction(options));
        this.transactions.stageAspaBatch = immediateTransaction(values => this.stageAspaBatchInTransaction(values));
        this.transactions.commitAspaImport = immediateTransaction(() => this.commitAspaImportInTransaction());
    }

    beginRoaImport() {
        this.ensureImportStatements();
        this.importStatements.clearRoaStage.run();
    }

    stageRoaBatchInTransaction(values, options = {}) {
        if (!values || typeof values[Symbol.iterator] !== 'function') {
            throw new Error('RPKI ROA import batch must be iterable');
        }
        let staged = 0;
        let skipped = 0;
        let processed = 0;
        for (const value of values) {
            const roa = normalizeRoaInput(value);
            const result = this.importStatements.insertRoaStage.run(
                Number(roa.ipType),
                roa.ip,
                Number(roa.mask),
                Number(roa.asn),
                Number(roa.maxLength)
            );
            processed += 1;
            if (result.changes > 0) {
                staged += 1;
            } else {
                skipped += 1;
            }
        }
        return {
            processed,
            staged,
            skipped,
            candidates:
                options.countCandidates === false
                    ? null
                    : Number(this.importStatements.countRoaCandidates.get().total) || 0
        };
    }

    stageRoaBatch(values, options = {}) {
        this.ensureImportStatements();
        return this.transactions.stageRoaBatch(values, options);
    }

    commitRoaImportInTransaction(options = {}) {
        const requestedMaximum = options?.maxInserted;
        const maximumInserted =
            requestedMaximum === null || requestedMaximum === undefined
                ? -1
                : Math.max(0, Math.floor(Number(requestedMaximum) || 0));
        const staged = Number(this.importStatements.countRoaStage.get().total) || 0;
        const candidates = Number(this.importStatements.countRoaCandidates.get().total) || 0;
        const result =
            maximumInserted === 0 ? { changes: 0 } : this.importStatements.commitRoaStage.run(maximumInserted);
        const inserted = Number(result.changes) || 0;
        let cacheSerial = this.getCacheSerial();
        if (inserted > 0) {
            this.statements.incrementRoaCount.run(inserted);
            cacheSerial = this.bumpCacheSerialInTransaction();
        }
        this.importStatements.clearRoaStage.run();
        return {
            staged,
            candidates,
            inserted,
            added: inserted,
            ignoredByLimit: Math.max(0, candidates - inserted),
            total: this.getRoaCount(),
            cacheSerial
        };
    }

    commitRoaImport(options = {}) {
        this.ensureImportStatements();
        return this.transactions.commitRoaImport(options);
    }

    abortRoaImport() {
        if (this.importStatements) {
            this.importStatements.clearRoaStage.run();
        }
    }

    beginAspaImport() {
        this.ensureImportStatements();
        this.importStatements.clearAspaStage.run();
    }

    stageAspaBatchInTransaction(values) {
        if (!values || typeof values[Symbol.iterator] !== 'function') {
            throw new Error('RPKI ASPA import batch must be iterable');
        }
        let processed = 0;
        for (const value of values) {
            const aspa = normalizeAspaInput(value);
            this.importStatements.upsertAspaStage.run(
                Number(aspa.customerAsn),
                JSON.stringify(aspa.providerAsns),
                Number(aspa.afiFlags)
            );
            processed += 1;
        }
        return {
            processed,
            staged: Number(this.importStatements.countAspaStage.get().total) || 0
        };
    }

    stageAspaBatch(values) {
        this.ensureImportStatements();
        return this.transactions.stageAspaBatch(values);
    }

    commitAspaImportInTransaction() {
        const staged = Number(this.importStatements.countAspaStage.get().total) || 0;
        const inserted = Number(this.importStatements.countNewAspaCandidates.get().total) || 0;
        const changed = Number(this.importStatements.countChangedAspaCandidates.get().total) || 0;
        if (changed > 0) {
            this.importStatements.commitAspaStage.run();
            if (inserted > 0) {
                this.statements.incrementAspaCount.run(inserted);
            }
        }
        const cacheSerial = changed > 0 ? this.bumpCacheSerialInTransaction() : this.getCacheSerial();
        this.importStatements.clearAspaStage.run();
        return {
            staged,
            inserted,
            added: inserted,
            overwritten: Math.max(0, changed - inserted),
            changed,
            skipped: Math.max(0, staged - changed),
            total: this.getAspaCount(),
            cacheSerial
        };
    }

    commitAspaImport() {
        this.ensureImportStatements();
        return this.transactions.commitAspaImport();
    }

    abortAspaImport() {
        if (this.importStatements) {
            this.importStatements.clearAspaStage.run();
        }
    }

    getDynamicStatement(key, sql) {
        let statement = this.dynamicStatements.get(key);
        if (!statement) {
            statement = this.db.prepare(sql);
            this.dynamicStatements.set(key, statement);
        }
        return statement;
    }

    buildRoaWhere(options = {}) {
        const clauses = [];
        const parameters = [];
        const ipType = String(options.ipType ?? '').trim();
        if (ipType === '1' || ipType === '2') {
            clauses.push('ip_type = ?');
            parameters.push(Number(ipType));
        }
        const asnText = String(options.asn ?? '')
            .trim()
            .replace(/^AS/i, '');
        if (asnText) {
            const asn = Number(asnText);
            if (Number.isInteger(asn) && asn >= 0 && asn <= UINT32_MAX) {
                clauses.push('asn = ?');
                parameters.push(asn);
            }
        }

        const prefixFilter = normalizePrefixFilter(options.prefixFilter);
        if (prefixFilter.mode === 'cidr') {
            clauses.push('prefix = ? AND prefix_length = ?');
            parameters.push(prefixFilter.prefix, prefixFilter.mask);
        } else if (prefixFilter.mode === 'address') {
            clauses.push('prefix = ?');
            parameters.push(prefixFilter.prefix);
        } else if (prefixFilter.mode === 'contains') {
            clauses.push("instr(lower(prefix || '/' || prefix_length), ?) > 0");
            parameters.push(prefixFilter.text);
        }

        return {
            sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
            parameters
        };
    }

    queryRoaPage(options = {}) {
        this.ensureOpen();
        const page = positiveInteger(options.page, 1);
        const pageSize = positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const { sql: whereSql, parameters } = this.buildRoaWhere(options);
        const key = whereSql || 'all';
        const countStatement = this.getDynamicStatement(
            `roa-count:${key}`,
            `SELECT COUNT(*) AS total FROM rpki_roas${whereSql}`
        );
        const pageStatement = this.getDynamicStatement(
            `roa-page:${key}`,
            `SELECT roa_id, ip_type, prefix, prefix_length, asn, max_length
             FROM rpki_roas${whereSql} ORDER BY roa_id LIMIT ? OFFSET ?`
        );
        const total = Number(countStatement.get(...parameters).total) || 0;
        const offset = (page - 1) * pageSize;
        const items = pageStatement.all(...parameters, pageSize, offset).map(row => this.hydrateRoa(row));
        return {
            items,
            total,
            storageTotal: this.getRoaCount(),
            page,
            pageSize
        };
    }

    queryAspaPage(options = {}) {
        this.ensureOpen();
        const page = positiveInteger(options.page, 1);
        const pageSize = positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const total = this.getAspaCount();
        const statement = this.getDynamicStatement(
            'aspa-page',
            `SELECT aspa_id, customer_asn, provider_asns_json, afi_flags
             FROM rpki_aspas ORDER BY aspa_id LIMIT ? OFFSET ?`
        );
        const items = statement.all(pageSize, (page - 1) * pageSize).map(row => this.hydrateAspa(row));
        return { items, total, storageTotal: total, page, pageSize };
    }

    *iterateRoas() {
        this.ensureOpen();
        for (const row of this.statements.iterateRoas.iterate()) {
            yield this.hydrateRoa(row);
        }
    }

    *iterateAspas() {
        this.ensureOpen();
        for (const row of this.statements.iterateAspas.iterate()) {
            yield this.hydrateAspa(row);
        }
    }

    *iterateRoaBatches(options = {}) {
        const batchSize = positiveInteger(options.batchSize, DEFAULT_ITERATION_BATCH_SIZE, MAX_ITERATION_BATCH_SIZE);
        let batch = [];
        for (const roa of this.iterateRoas()) {
            batch.push(roa);
            if (batch.length >= batchSize) {
                yield batch;
                batch = [];
            }
        }
        if (batch.length > 0) {
            yield batch;
        }
    }

    *iterateAspaBatches(options = {}) {
        const batchSize = positiveInteger(options.batchSize, DEFAULT_ITERATION_BATCH_SIZE, MAX_ITERATION_BATCH_SIZE);
        let batch = [];
        for (const aspa of this.iterateAspas()) {
            batch.push(aspa);
            if (batch.length >= batchSize) {
                yield batch;
                batch = [];
            }
        }
        if (batch.length > 0) {
            yield batch;
        }
    }

    beginReadSnapshot() {
        this.ensureOpen();
        if (this.readSnapshotActive) {
            throw new Error('RPKI SQLite read snapshot is already active');
        }
        this.db.exec('BEGIN');
        try {
            const state = this.getState();
            this.readSnapshotActive = true;
            return {
                cacheSerial: Number(state.cacheSerial) >>> 0,
                roaCount: Number(state.roaCount) || 0,
                aspaCount: Number(state.aspaCount) || 0
            };
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    endReadSnapshot() {
        this.ensureOpen();
        if (!this.readSnapshotActive) {
            return;
        }
        this.db.exec('COMMIT');
        this.readSnapshotActive = false;
    }

    getStatus() {
        this.ensureOpen();
        const state = this.getState();
        return {
            ready: true,
            dbPath: this.dbPath,
            readOnly: this.readOnly,
            schemaVersion: this.db.pragma('user_version', { simple: true }),
            journalMode: this.db.pragma('journal_mode', { simple: true }),
            roas: Number(state.roaCount) || 0,
            aspas: Number(state.aspaCount) || 0,
            cacheSerial: Number(state.cacheSerial) >>> 0
        };
    }

    checkpoint(mode = 'PASSIVE') {
        this.assertWritable();
        const normalizedMode = String(mode).toUpperCase();
        if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(normalizedMode)) {
            throw new Error(`Unsupported SQLite checkpoint mode: ${mode}`);
        }
        return this.db.pragma(`wal_checkpoint(${normalizedMode})`);
    }

    close() {
        if (!this.db) {
            return;
        }
        if (this.readSnapshotActive) {
            try {
                this.db.exec('ROLLBACK');
            } catch (_) {
                // The connection is being closed; SQLite will release the read transaction.
            }
            this.readSnapshotActive = false;
        }
        this.dynamicStatements.clear();
        this.importStatements = null;
        this.statements = null;
        this.transactions = null;
        this.db.close();
        this.db = null;
    }
}

RpkiSqliteStore.SCHEMA_VERSION = SCHEMA_VERSION;
RpkiSqliteStore.DEFAULT_ITERATION_BATCH_SIZE = DEFAULT_ITERATION_BATCH_SIZE;
RpkiSqliteStore.MAX_ITERATION_BATCH_SIZE = MAX_ITERATION_BATCH_SIZE;

module.exports = RpkiSqliteStore;
