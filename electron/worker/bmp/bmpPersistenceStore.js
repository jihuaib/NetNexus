const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const ipaddr = require('ipaddr.js');
const { getAddrFamilyType } = require('../../utils/bgpUtils');
const { installBmpSqlTrace } = require('./bmpSqlTrace');

const SCHEMA_VERSION = 8;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 5000;

function asJson(value) {
    if (value === undefined) {
        return null;
    }
    return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
    if (!value) {
        return fallback;
    }
    try {
        return JSON.parse(value);
    } catch (_error) {
        return fallback;
    }
}

function makeStatisticsReportIdentity(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
        return null;
    }
    const hasSession = report.session && typeof report.session === 'object' && !Array.isArray(report.session);
    const hasInstance = report.instance && typeof report.instance === 'object' && !Array.isArray(report.instance);
    if (Boolean(hasSession) === Boolean(hasInstance)) {
        return null;
    }

    const stringifyPart = value => String(value ?? '');
    if (hasSession) {
        const session = report.session;
        return {
            kind: 'session',
            key: JSON.stringify(
                [
                    session.sessionType,
                    session.sessionRdRaw || session.sessionRd,
                    session.sessionIp,
                    session.sessionAs
                ].map(stringifyPart)
            )
        };
    }

    const instance = report.instance;
    return {
        kind: 'instance',
        key: JSON.stringify([instance.instanceType, instance.instanceRdRaw || instance.instanceRd].map(stringifyPart))
    };
}

function finiteNumber(value, fallback = null) {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) {
        return fallback;
    }
    return Math.min(number, maximum);
}

function normalizePrefixCidrs(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const normalized = [];
    const seen = new Set();
    value.forEach(item => {
        let prefix;
        let prefixLength;
        if (typeof item === 'string') {
            const separator = item.lastIndexOf('/');
            if (separator <= 0) {
                return;
            }
            prefix = item.slice(0, separator).trim();
            prefixLength = finiteNumber(item.slice(separator + 1));
        } else if (item && typeof item === 'object') {
            prefix = String(item.prefix ?? item.ip ?? '').trim();
            prefixLength = finiteNumber(item.prefixLength ?? item.mask ?? item.length);
        }
        if (!prefix || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 128) {
            return;
        }
        const key = `${prefix}\u0000${prefixLength}`;
        if (!seen.has(key)) {
            seen.add(key);
            normalized.push({ prefix, prefixLength });
        }
    });
    return normalized;
}

function isStrictIpAddress(value) {
    const text = String(value || '').trim();
    return ipaddr.IPv4.isValidFourPartDecimal(text) || ipaddr.IPv6.isValid(text);
}

function encodeCursor(kind, data) {
    return Buffer.from(JSON.stringify({ version: 1, kind, ...data }), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function decodeCursor(value, kind) {
    if (!value) {
        return null;
    }
    try {
        const encoded = String(value).replace(/-/g, '+').replace(/_/g, '/');
        const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
        const cursor = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
        if (cursor.version !== 1 || cursor.kind !== kind) {
            throw new Error('cursor type mismatch');
        }
        return cursor;
    } catch (error) {
        throw new Error(`Invalid BMP persistence ${kind} cursor: ${error.message}`);
    }
}

class BmpPersistenceStore {
    constructor(options = {}) {
        if (!options.dbPath) {
            throw new Error('BMP persistence dbPath is required');
        }

        this.dbPath = path.resolve(options.dbPath);
        this.readOnly = options.readOnly === true;
        this.logLevel = options.logLevel;
        this.sqlTraceLog = options.sqlTraceLog;
        this.sqlTrace = null;
        this.db = null;
        this.statements = null;
    }

    open() {
        if (this.db) {
            return this;
        }

        if (!this.readOnly) {
            fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        }

        this.db = new Database(this.dbPath, {
            readonly: this.readOnly,
            fileMustExist: this.readOnly,
            timeout: 5000
        });
        this.sqlTrace = installBmpSqlTrace(this.db, {
            logLevel: this.logLevel,
            log: this.sqlTraceLog
        });
        try {
            this.db.pragma('busy_timeout = 5000');
            this.db.pragma('foreign_keys = ON');

            if (!this.readOnly) {
                this.db.pragma('journal_mode = WAL');
                this.db.pragma('synchronous = NORMAL');
                this.db.pragma('temp_store = MEMORY');
                this.db.pragma('wal_autocheckpoint = 2000');
                this.migrate();
                this.validateReadableSchema();
                this.recoverInterruptedConnections();
                this.prepareStatements();
            } else {
                this.validateReadableSchema();
            }
        } catch (error) {
            this.db.close();
            this.db = null;
            this.sqlTrace = null;
            throw error;
        }

        return this;
    }

    setLogLevel(level) {
        this.logLevel = level;
        this.sqlTrace?.setLogLevel(level);
        return this;
    }

    isSqlTraceEnabled() {
        return this.sqlTrace?.isEnabled() === true;
    }

    validateReadableSchema() {
        const currentVersion = this.db.pragma('user_version', { simple: true });
        if (currentVersion !== SCHEMA_VERSION) {
            const error = new Error(
                `BMP persistence schema ${currentVersion} is not readable by expected schema ${SCHEMA_VERSION}`
            );
            error.code =
                currentVersion < SCHEMA_VERSION
                    ? 'BMP_PERSISTENCE_SCHEMA_MIGRATION_REQUIRED'
                    : 'BMP_PERSISTENCE_SCHEMA_TOO_NEW';
            throw error;
        }
        const requiredSchema = {
            bmp_sources: ['source_id', 'source_identity_json'],
            bmp_connections: ['connection_id', 'source_id', 'connection_generation', 'connection_state'],
            bmp_rib_scopes: [
                'scope_id',
                'source_id',
                'current_epoch',
                'refresh_started_ms',
                'cleanup_pending_epoch',
                'last_connection_id'
            ],
            bmp_route_events: [
                'event_id',
                'connection_id',
                'source_sequence',
                'event_type',
                'afi',
                'safi',
                'prefix',
                'legacy_route_key'
            ],
            bmp_current_routes: ['scope_id', 'route_id', 'connection_id', 'rib_epoch', 'last_event_id', 'attr_id'],
            bmp_route_attributes: ['attr_id', 'attr_json'],
            bmp_ingest_batches: ['batch_id', 'created_at_ms'],
            bmp_statistics_samples: ['sample_id', 'source_id', 'report_kind', 'report_key', 'statistics_json'],
            bmp_statistics_latest: ['source_id', 'report_kind', 'report_key', 'sample_id', 'observed_at_ms']
        };
        const existingTables = new Set(
            this.db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all()
                .map(row => row.name)
        );
        Object.entries(requiredSchema).forEach(([table, requiredColumns]) => {
            if (!existingTables.has(table)) {
                throw new Error(`BMP persistence schema is missing required table ${table}`);
            }
            const columns = new Set(this.db.pragma(`table_info(${table})`).map(column => column.name));
            requiredColumns.forEach(column => {
                if (!columns.has(column)) {
                    throw new Error(`BMP persistence schema is missing required column ${table}.${column}`);
                }
            });
        });
    }

    migrate() {
        const currentVersion = this.db.pragma('user_version', { simple: true });
        if (currentVersion > SCHEMA_VERSION) {
            throw new Error(
                `BMP persistence schema ${currentVersion} is newer than supported schema ${SCHEMA_VERSION}`
            );
        }
        if (currentVersion === SCHEMA_VERSION) {
            return;
        }

        const migration = this.db.transaction(() => {
            this.db.exec(`
            CREATE TABLE IF NOT EXISTS bmp_sources (
                source_id TEXT PRIMARY KEY,
                source_key_json TEXT NOT NULL,
                source_identity_json TEXT NOT NULL,
                remote_ip TEXT,
                sys_name TEXT,
                sys_desc TEXT,
                first_seen_ms INTEGER NOT NULL,
                last_seen_ms INTEGER NOT NULL,
                metadata_json TEXT
            ) WITHOUT ROWID;

            CREATE TABLE IF NOT EXISTS bmp_connections (
                connection_id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                connection_generation INTEGER NOT NULL,
                local_ip TEXT,
                local_port INTEGER,
                remote_ip TEXT,
                remote_port INTEGER,
                opened_at_ms INTEGER NOT NULL,
                closed_at_ms INTEGER,
                close_reason TEXT,
                connection_state TEXT NOT NULL,
                FOREIGN KEY (source_id) REFERENCES bmp_sources(source_id)
            ) WITHOUT ROWID;

            CREATE INDEX IF NOT EXISTS idx_bmp_connections_source_time
                ON bmp_connections(source_id, opened_at_ms DESC);

            CREATE TABLE IF NOT EXISTS bmp_rib_scopes (
                scope_id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                scope_key_json TEXT NOT NULL,
                scope_identity_json TEXT NOT NULL,
                scope_kind TEXT NOT NULL,
                owner_key TEXT,
                peer_type TEXT,
                peer_rd TEXT,
                peer_ip TEXT,
                peer_as TEXT,
                vrf_name TEXT,
                afi INTEGER NOT NULL,
                safi INTEGER NOT NULL,
                rib_type TEXT NOT NULL,
                current_epoch INTEGER NOT NULL DEFAULT 0,
                eor_epoch INTEGER,
                scope_state TEXT NOT NULL DEFAULT 'syncing',
                stale_reason TEXT,
                stale_since_ms INTEGER,
                refresh_started_ms INTEGER,
                cleanup_pending_epoch INTEGER,
                last_connection_id TEXT,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                FOREIGN KEY (source_id) REFERENCES bmp_sources(source_id),
                FOREIGN KEY (last_connection_id) REFERENCES bmp_connections(connection_id)
            ) WITHOUT ROWID;

            CREATE INDEX IF NOT EXISTS idx_bmp_scopes_source_af
                ON bmp_rib_scopes(source_id, afi, safi, rib_type);
            CREATE INDEX IF NOT EXISTS idx_bmp_scopes_state
                ON bmp_rib_scopes(scope_state, updated_at_ms);
            CREATE INDEX IF NOT EXISTS idx_bmp_scopes_stale_since
                ON bmp_rib_scopes(scope_state, stale_since_ms, scope_id);
            CREATE INDEX IF NOT EXISTS idx_bmp_scopes_connection
                ON bmp_rib_scopes(last_connection_id, scope_id);

            CREATE TABLE IF NOT EXISTS bmp_route_attributes (
                attr_id TEXT PRIMARY KEY,
                attr_json TEXT NOT NULL,
                first_seen_ms INTEGER NOT NULL,
                last_seen_ms INTEGER NOT NULL
            ) WITHOUT ROWID;

            CREATE INDEX IF NOT EXISTS idx_bmp_route_attributes_last_seen
                ON bmp_route_attributes(last_seen_ms, attr_id);

            CREATE TABLE IF NOT EXISTS bmp_route_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_id TEXT NOT NULL,
                source_id TEXT NOT NULL,
                connection_id TEXT NOT NULL,
                source_sequence INTEGER NOT NULL,
                scope_id TEXT,
                route_id TEXT,
                event_type TEXT NOT NULL,
                observed_at_ms INTEGER NOT NULL,
                source_timestamp_ms INTEGER,
                rib_epoch INTEGER,
                attr_id TEXT,
                reason TEXT,
                afi INTEGER,
                safi INTEGER,
                prefix TEXT,
                legacy_route_key TEXT,
                route_json TEXT,
                UNIQUE(connection_id, source_sequence),
                FOREIGN KEY (source_id) REFERENCES bmp_sources(source_id),
                FOREIGN KEY (connection_id) REFERENCES bmp_connections(connection_id),
                FOREIGN KEY (scope_id) REFERENCES bmp_rib_scopes(scope_id),
                FOREIGN KEY (attr_id) REFERENCES bmp_route_attributes(attr_id)
            );

            CREATE INDEX IF NOT EXISTS idx_bmp_route_events_scope_time
                ON bmp_route_events(scope_id, observed_at_ms DESC, event_id DESC);
            CREATE INDEX IF NOT EXISTS idx_bmp_route_events_route_time
                ON bmp_route_events(scope_id, route_id, observed_at_ms DESC, event_id DESC);
            CREATE INDEX IF NOT EXISTS idx_bmp_route_events_type_time
                ON bmp_route_events(event_type, observed_at_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_bmp_route_events_observed
                ON bmp_route_events(observed_at_ms, event_id);
            CREATE INDEX IF NOT EXISTS idx_bmp_route_events_attr
                ON bmp_route_events(attr_id);

            CREATE TABLE IF NOT EXISTS bmp_current_routes (
                scope_id TEXT NOT NULL,
                route_id TEXT NOT NULL,
                route_key_json TEXT NOT NULL,
                route_identity_json TEXT NOT NULL,
                route_key_version INTEGER NOT NULL,
                legacy_route_key TEXT,
                afi INTEGER NOT NULL,
                safi INTEGER NOT NULL,
                path_id INTEGER NOT NULL,
                rd TEXT,
                prefix TEXT,
                prefix_length INTEGER,
                nlri_kind TEXT,
                nlri_json TEXT NOT NULL,
                attr_id TEXT,
                route_json TEXT NOT NULL,
                connection_id TEXT NOT NULL,
                rib_epoch INTEGER NOT NULL,
                explicit_state TEXT NOT NULL DEFAULT 'active',
                first_seen_ms INTEGER NOT NULL,
                last_seen_ms INTEGER NOT NULL,
                source_timestamp_ms INTEGER,
                last_event_id INTEGER NOT NULL,
                PRIMARY KEY (scope_id, route_id),
                FOREIGN KEY (scope_id) REFERENCES bmp_rib_scopes(scope_id),
                FOREIGN KEY (connection_id) REFERENCES bmp_connections(connection_id),
                FOREIGN KEY (attr_id) REFERENCES bmp_route_attributes(attr_id),
                FOREIGN KEY (last_event_id) REFERENCES bmp_route_events(event_id)
            ) WITHOUT ROWID;

            CREATE INDEX IF NOT EXISTS idx_bmp_current_routes_prefix
                ON bmp_current_routes(afi, safi, prefix, prefix_length);
            CREATE INDEX IF NOT EXISTS idx_bmp_current_routes_epoch
                ON bmp_current_routes(scope_id, rib_epoch, last_seen_ms);
            CREATE INDEX IF NOT EXISTS idx_bmp_current_routes_attr
                ON bmp_current_routes(attr_id);
            CREATE INDEX IF NOT EXISTS idx_bmp_current_routes_last_seen
                ON bmp_current_routes(last_seen_ms DESC, scope_id, route_id);
            CREATE INDEX IF NOT EXISTS idx_bmp_current_routes_last_event
                ON bmp_current_routes(last_event_id);

            CREATE TABLE IF NOT EXISTS bmp_ingest_batches (
                batch_id TEXT PRIMARY KEY,
                created_at_ms INTEGER NOT NULL,
                mutation_count INTEGER NOT NULL
            ) WITHOUT ROWID;

            CREATE INDEX IF NOT EXISTS idx_bmp_ingest_batches_created
                ON bmp_ingest_batches(created_at_ms);

            CREATE TABLE IF NOT EXISTS bmp_statistics_samples (
                sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id TEXT NOT NULL,
                connection_id TEXT NOT NULL,
                scope_id TEXT,
                report_kind TEXT,
                report_key TEXT,
                observed_at_ms INTEGER NOT NULL,
                source_timestamp_ms INTEGER,
                statistics_json TEXT NOT NULL,
                FOREIGN KEY (source_id) REFERENCES bmp_sources(source_id),
                FOREIGN KEY (connection_id) REFERENCES bmp_connections(connection_id),
                FOREIGN KEY (scope_id) REFERENCES bmp_rib_scopes(scope_id)
            );

            CREATE INDEX IF NOT EXISTS idx_bmp_statistics_scope_time
                ON bmp_statistics_samples(scope_id, observed_at_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_bmp_statistics_observed
                ON bmp_statistics_samples(observed_at_ms, sample_id);

            CREATE TABLE IF NOT EXISTS bmp_statistics_latest (
                source_id TEXT NOT NULL,
                report_kind TEXT NOT NULL CHECK(report_kind IN ('session', 'instance')),
                report_key TEXT NOT NULL,
                sample_id INTEGER NOT NULL,
                observed_at_ms INTEGER NOT NULL,
                PRIMARY KEY (source_id, report_kind, report_key),
                FOREIGN KEY (source_id) REFERENCES bmp_sources(source_id),
                FOREIGN KEY (sample_id) REFERENCES bmp_statistics_samples(sample_id)
            ) WITHOUT ROWID;

            `);

            const connectionColumns = new Set(this.db.pragma('table_info(bmp_connections)').map(column => column.name));
            if (!connectionColumns.has('connection_generation')) {
                this.db.exec('ALTER TABLE bmp_connections ADD COLUMN connection_generation INTEGER');
            }
            const scopeColumns = new Set(this.db.pragma('table_info(bmp_rib_scopes)').map(column => column.name));
            if (!scopeColumns.has('refresh_started_ms')) {
                this.db.exec('ALTER TABLE bmp_rib_scopes ADD COLUMN refresh_started_ms INTEGER');
            }
            if (!scopeColumns.has('cleanup_pending_epoch')) {
                this.db.exec('ALTER TABLE bmp_rib_scopes ADD COLUMN cleanup_pending_epoch INTEGER');
            }
            const eventColumns = new Set(this.db.pragma('table_info(bmp_route_events)').map(column => column.name));
            const eventColumnDefinitions = {
                afi: 'INTEGER',
                safi: 'INTEGER',
                prefix: 'TEXT',
                legacy_route_key: 'TEXT'
            };
            Object.entries(eventColumnDefinitions).forEach(([column, type]) => {
                if (!eventColumns.has(column)) {
                    this.db.exec(`ALTER TABLE bmp_route_events ADD COLUMN ${column} ${type}`);
                }
            });
            const currentRouteColumns = new Set(
                this.db.pragma('table_info(bmp_current_routes)').map(column => column.name)
            );
            if (!currentRouteColumns.has('connection_id')) {
                this.db.exec('ALTER TABLE bmp_current_routes ADD COLUMN connection_id TEXT');
            }
            const statisticsColumns = new Set(
                this.db.pragma('table_info(bmp_statistics_samples)').map(column => column.name)
            );
            if (!statisticsColumns.has('report_kind')) {
                this.db.exec('ALTER TABLE bmp_statistics_samples ADD COLUMN report_kind TEXT');
            }
            if (!statisticsColumns.has('report_key')) {
                this.db.exec('ALTER TABLE bmp_statistics_samples ADD COLUMN report_key TEXT');
            }
            this.db.exec(`
                UPDATE bmp_current_routes
                   SET connection_id = (
                       SELECT connection_id
                         FROM bmp_route_events
                        WHERE event_id = bmp_current_routes.last_event_id
                   )
                 WHERE connection_id IS NULL;
            `);
            const routesWithoutConnection = this.db
                .prepare('SELECT COUNT(*) AS count FROM bmp_current_routes WHERE connection_id IS NULL')
                .get().count;
            if (routesWithoutConnection > 0) {
                throw new Error('BMP persistence migration could not recover current-route connection identity');
            }
            this.db.exec(`
                UPDATE bmp_route_events
                   SET afi = COALESCE(afi, (SELECT afi FROM bmp_rib_scopes WHERE scope_id = bmp_route_events.scope_id)),
                       safi = COALESCE(safi, (SELECT safi FROM bmp_rib_scopes WHERE scope_id = bmp_route_events.scope_id))
                 WHERE scope_id IS NOT NULL AND (afi IS NULL OR safi IS NULL);

                UPDATE bmp_route_events
                   SET prefix = COALESCE(prefix, json_extract(route_json, '$.ip')),
                       legacy_route_key = COALESCE(legacy_route_key, json_extract(route_json, '$.routeKey'))
                 WHERE route_id IS NOT NULL AND (prefix IS NULL OR legacy_route_key IS NULL);

                CREATE INDEX IF NOT EXISTS idx_bmp_current_routes_route_id
                    ON bmp_current_routes(route_id, scope_id);
                CREATE INDEX IF NOT EXISTS idx_bmp_current_routes_legacy_key
                    ON bmp_current_routes(legacy_route_key, scope_id);
                CREATE INDEX IF NOT EXISTS idx_bmp_current_routes_prefix_global
                    ON bmp_current_routes(prefix, scope_id, route_id);
                CREATE INDEX IF NOT EXISTS idx_bmp_route_events_source_time
                    ON bmp_route_events(source_id, observed_at_ms DESC, event_id DESC);
                CREATE INDEX IF NOT EXISTS idx_bmp_route_events_route_global_time
                    ON bmp_route_events(route_id, observed_at_ms DESC, event_id DESC);
                CREATE INDEX IF NOT EXISTS idx_bmp_route_events_legacy_time
                    ON bmp_route_events(legacy_route_key, observed_at_ms DESC, event_id DESC);
                CREATE INDEX IF NOT EXISTS idx_bmp_route_events_af_prefix_time
                    ON bmp_route_events(afi, safi, prefix, observed_at_ms DESC, event_id DESC);
                CREATE INDEX IF NOT EXISTS idx_bmp_route_events_prefix_time
                    ON bmp_route_events(prefix, observed_at_ms DESC, event_id DESC);
                CREATE INDEX IF NOT EXISTS idx_bmp_scopes_stale_since
                    ON bmp_rib_scopes(scope_state, stale_since_ms, scope_id);
                CREATE INDEX IF NOT EXISTS idx_bmp_scopes_refresh_since
                    ON bmp_rib_scopes(scope_state, refresh_started_ms, scope_id);
                CREATE INDEX IF NOT EXISTS idx_bmp_scopes_cleanup_pending
                    ON bmp_rib_scopes(cleanup_pending_epoch, scope_id);
                CREATE INDEX IF NOT EXISTS idx_bmp_scopes_connection
                    ON bmp_rib_scopes(last_connection_id, scope_id);
                CREATE INDEX IF NOT EXISTS idx_bmp_route_attributes_last_seen
                    ON bmp_route_attributes(last_seen_ms, attr_id);
                CREATE INDEX IF NOT EXISTS idx_bmp_current_routes_last_event
                    ON bmp_current_routes(last_event_id);
                CREATE INDEX IF NOT EXISTS idx_bmp_current_routes_connection
                    ON bmp_current_routes(scope_id, connection_id, rib_epoch, last_seen_ms);
                CREATE INDEX IF NOT EXISTS idx_bmp_statistics_report_time
                    ON bmp_statistics_samples(
                        source_id, report_kind, report_key, observed_at_ms DESC, sample_id DESC
                    );
            `);
            const classifyStatistics = this.db.prepare(`
                UPDATE bmp_statistics_samples
                   SET report_kind = @reportKind, report_key = @reportKey
                 WHERE sample_id = @sampleId
            `);
            this.db
                .prepare(
                    `SELECT sample_id, statistics_json
                       FROM bmp_statistics_samples
                      WHERE report_kind IS NULL OR report_key IS NULL`
                )
                .all()
                .forEach(row => {
                    const identity = makeStatisticsReportIdentity(parseJson(row.statistics_json));
                    if (identity) {
                        classifyStatistics.run({
                            sampleId: row.sample_id,
                            reportKind: identity.kind,
                            reportKey: identity.key
                        });
                    }
                });
            const upsertLatestStatistics = this.db.prepare(`
                INSERT INTO bmp_statistics_latest(source_id, report_kind, report_key, sample_id, observed_at_ms)
                VALUES (@sourceId, @reportKind, @reportKey, @sampleId, @observedAtMs)
                ON CONFLICT(source_id, report_kind, report_key) DO UPDATE SET
                    sample_id = excluded.sample_id,
                    observed_at_ms = excluded.observed_at_ms
                WHERE excluded.observed_at_ms > bmp_statistics_latest.observed_at_ms
                   OR (
                       excluded.observed_at_ms = bmp_statistics_latest.observed_at_ms
                       AND excluded.sample_id > bmp_statistics_latest.sample_id
                   )
            `);
            this.db
                .prepare(
                    `SELECT sample_id, source_id, report_kind, report_key, observed_at_ms
                       FROM bmp_statistics_samples
                      WHERE report_kind IN ('session', 'instance') AND report_key IS NOT NULL
                      ORDER BY observed_at_ms, sample_id`
                )
                .all()
                .forEach(row => {
                    upsertLatestStatistics.run({
                        sourceId: row.source_id,
                        reportKind: row.report_kind,
                        reportKey: row.report_key,
                        sampleId: row.sample_id,
                        observedAtMs: row.observed_at_ms
                    });
                });
            const connectionsWithoutGeneration = this.db
                .prepare(
                    `SELECT connection_id
                       FROM bmp_connections
                      WHERE connection_generation IS NULL
                      ORDER BY opened_at_ms, connection_id`
                )
                .all();
            const updateGeneration = this.db.prepare(
                'UPDATE bmp_connections SET connection_generation = @generation WHERE connection_id = @connectionId'
            );
            connectionsWithoutGeneration.forEach((connection, index) => {
                updateGeneration.run({ connectionId: connection.connection_id, generation: index + 1 });
            });
            this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
            this.validateReadableSchema();
        });
        migration();
    }

    recoverInterruptedConnections(recoveredAtMs = Date.now()) {
        const recover = this.db.transaction(() => {
            const openConnections = this.db
                .prepare("SELECT COUNT(*) AS count FROM bmp_connections WHERE connection_state = 'open'")
                .get().count;
            if (openConnections === 0) {
                return 0;
            }

            this.db
                .prepare(
                    `
                    UPDATE bmp_rib_scopes
                       SET scope_state = 'down', stale_reason = 'collector-restart',
                           stale_since_ms = COALESCE(stale_since_ms, @recoveredAtMs),
                           refresh_started_ms = NULL, cleanup_pending_epoch = NULL,
                           updated_at_ms = MAX(updated_at_ms, @recoveredAtMs)
                     WHERE last_connection_id IN (
                         SELECT connection_id
                           FROM bmp_connections
                          WHERE connection_state = 'open'
                     )
                `
                )
                .run({ recoveredAtMs });
            return this.db
                .prepare(
                    `
                    UPDATE bmp_connections
                       SET connection_state = 'closed',
                           closed_at_ms = COALESCE(closed_at_ms, @recoveredAtMs),
                           close_reason = COALESCE(close_reason, 'collector-restart')
                     WHERE connection_state = 'open'
                `
                )
                .run({ recoveredAtMs }).changes;
        });
        return recover();
    }

    prepareStatements() {
        const replacesScopeConnection = `(
            bmp_rib_scopes.last_connection_id <> excluded.last_connection_id
            AND (
                COALESCE((
                    SELECT connection_generation
                      FROM bmp_connections
                     WHERE connection_id = excluded.last_connection_id
                ), 0) > COALESCE((
                    SELECT connection_generation
                      FROM bmp_connections
                     WHERE connection_id = bmp_rib_scopes.last_connection_id
                ), 0)
                OR (
                    COALESCE((
                        SELECT connection_state
                          FROM bmp_connections
                         WHERE connection_id = bmp_rib_scopes.last_connection_id
                    ), 'closed') = 'closed'
                    AND COALESCE((
                        SELECT connection_state
                          FROM bmp_connections
                         WHERE connection_id = excluded.last_connection_id
                    ), 'closed') = 'open'
                )
            )
        )`;
        const acceptsScopeConnection = `(
            bmp_rib_scopes.last_connection_id = excluded.last_connection_id
            OR ${replacesScopeConnection}
        )`;
        const acceptsScopeProgress = `(
            (
                ${replacesScopeConnection}
                OR (
                    bmp_rib_scopes.last_connection_id = excluded.last_connection_id
                    AND excluded.current_epoch >= bmp_rib_scopes.current_epoch
                )
            )
            AND NOT (
                @scopeTimeout = 1
                AND COALESCE(bmp_rib_scopes.eor_epoch, -1) >= bmp_rib_scopes.current_epoch
            )
        )`;
        this.statements = {
            findEventBySequence: this.db.prepare(`
                SELECT event_id
                  FROM bmp_route_events
                 WHERE connection_id = @connectionId AND source_sequence = @sequence
                 LIMIT 1
            `),
            findCurrentRoute: this.db.prepare(`
                SELECT r.*, route_attr.attr_json AS attr_json
                  FROM bmp_current_routes r
                  LEFT JOIN bmp_route_attributes route_attr ON route_attr.attr_id = r.attr_id
                 WHERE r.scope_id = @scopeId AND r.route_id = @routeId
                 LIMIT 1
            `),
            insertBatch: this.db.prepare(`
                INSERT OR IGNORE INTO bmp_ingest_batches(batch_id, created_at_ms, mutation_count)
                VALUES (@batchId, @createdAtMs, @mutationCount)
            `),
            upsertSource: this.db.prepare(`
                INSERT INTO bmp_sources(
                    source_id, source_key_json, source_identity_json, remote_ip, sys_name, sys_desc,
                    first_seen_ms, last_seen_ms, metadata_json
                ) VALUES (
                    @id, @keyJson, @identityJson, @remoteIp, @sysName, @sysDesc,
                    @eventAtMs, @eventAtMs, @metadataJson
                )
                ON CONFLICT(source_id) DO UPDATE SET
                    remote_ip = COALESCE(excluded.remote_ip, bmp_sources.remote_ip),
                    sys_name = COALESCE(NULLIF(excluded.sys_name, ''), bmp_sources.sys_name),
                    sys_desc = COALESCE(NULLIF(excluded.sys_desc, ''), bmp_sources.sys_desc),
                    last_seen_ms = MAX(bmp_sources.last_seen_ms, excluded.last_seen_ms),
                    metadata_json = COALESCE(excluded.metadata_json, bmp_sources.metadata_json)
            `),
            upsertConnection: this.db.prepare(`
                INSERT INTO bmp_connections(
                    connection_id, source_id, connection_generation, local_ip, local_port, remote_ip, remote_port,
                    opened_at_ms, connection_state
                ) VALUES (
                    @id, @sourceId, @generation, @localIp, @localPort, @remoteIp, @remotePort,
                    @openedAtMs, 'open'
                )
                ON CONFLICT(connection_id) DO UPDATE SET
                    source_id = excluded.source_id,
                    local_ip = COALESCE(excluded.local_ip, bmp_connections.local_ip),
                    local_port = COALESCE(excluded.local_port, bmp_connections.local_port),
                    remote_ip = COALESCE(excluded.remote_ip, bmp_connections.remote_ip),
                    remote_port = COALESCE(excluded.remote_port, bmp_connections.remote_port)
            `),
            closeConnection: this.db.prepare(`
                UPDATE bmp_connections
                   SET connection_state = 'closed', closed_at_ms = @eventAtMs, close_reason = @reason
                 WHERE connection_id = @connectionId
            `),
            closeConnectionScopes: this.db.prepare(`
                UPDATE bmp_rib_scopes
                   SET scope_state = 'down', stale_reason = @reason,
                       stale_since_ms = COALESCE(stale_since_ms, @eventAtMs),
                       refresh_started_ms = NULL, cleanup_pending_epoch = NULL,
                       updated_at_ms = MAX(updated_at_ms, @eventAtMs)
                 WHERE last_connection_id = @connectionId
            `),
            upsertScope: this.db.prepare(`
                INSERT INTO bmp_rib_scopes(
                    scope_id, source_id, scope_key_json, scope_identity_json, scope_kind, owner_key,
                    peer_type, peer_rd, peer_ip, peer_as, vrf_name, afi, safi, rib_type,
                    current_epoch, scope_state, stale_reason, stale_since_ms, refresh_started_ms,
                    cleanup_pending_epoch, last_connection_id,
                    created_at_ms, updated_at_ms
                ) VALUES (
                    @id, @sourceId, @keyJson, @identityJson, @kind, @ownerKey,
                    @peerType, @peerRd, @peerIp, @peerAs, @vrfName, @afi, @safi, @ribType,
                    @epoch, @state, @reason, @staleSinceMs, @refreshStartedMs, NULL, @connectionId,
                    @eventAtMs, @eventAtMs
                )
                ON CONFLICT(scope_id) DO UPDATE SET
                    current_epoch = CASE
                        WHEN ${replacesScopeConnection}
                        THEN excluded.current_epoch
                        WHEN bmp_rib_scopes.last_connection_id = excluded.last_connection_id
                        THEN MAX(bmp_rib_scopes.current_epoch, excluded.current_epoch)
                        ELSE bmp_rib_scopes.current_epoch
                    END,
                    eor_epoch = CASE
                        WHEN ${replacesScopeConnection}
                          OR (
                              bmp_rib_scopes.last_connection_id = excluded.last_connection_id
                              AND (
                                  excluded.current_epoch > bmp_rib_scopes.current_epoch
                                  OR (
                                      @resetRefresh = 1
                                      AND excluded.current_epoch = bmp_rib_scopes.current_epoch
                                  )
                              )
                          )
                        THEN NULL
                        ELSE bmp_rib_scopes.eor_epoch
                    END,
                    scope_state = CASE
                        WHEN ${acceptsScopeProgress} THEN excluded.scope_state
                        ELSE bmp_rib_scopes.scope_state
                    END,
                    stale_reason = CASE
                        WHEN ${acceptsScopeProgress}
                          AND excluded.scope_state IN ('stale', 'down')
                        THEN COALESCE(excluded.stale_reason, bmp_rib_scopes.stale_reason)
                        WHEN ${acceptsScopeProgress} THEN excluded.stale_reason
                        ELSE bmp_rib_scopes.stale_reason
                    END,
                    stale_since_ms = CASE
                        WHEN ${acceptsScopeProgress}
                          AND excluded.scope_state IN ('stale', 'down')
                          AND bmp_rib_scopes.scope_state IN ('stale', 'down')
                        THEN COALESCE(bmp_rib_scopes.stale_since_ms, excluded.stale_since_ms)
                        WHEN ${acceptsScopeProgress} THEN excluded.stale_since_ms
                        ELSE bmp_rib_scopes.stale_since_ms
                    END,
                    refresh_started_ms = CASE
                        WHEN NOT ${acceptsScopeProgress} THEN bmp_rib_scopes.refresh_started_ms
                        WHEN excluded.scope_state <> 'syncing' THEN NULL
                        WHEN ${replacesScopeConnection}
                          OR excluded.current_epoch > bmp_rib_scopes.current_epoch
                          OR @resetRefresh = 1
                          OR bmp_rib_scopes.scope_state <> 'syncing'
                        THEN excluded.refresh_started_ms
                        ELSE COALESCE(bmp_rib_scopes.refresh_started_ms, excluded.refresh_started_ms)
                    END,
                    cleanup_pending_epoch = CASE
                        WHEN NOT ${acceptsScopeProgress} THEN bmp_rib_scopes.cleanup_pending_epoch
                        WHEN ${replacesScopeConnection}
                          OR excluded.current_epoch > bmp_rib_scopes.current_epoch
                          OR @resetRefresh = 1
                          OR excluded.scope_state IN ('stale', 'down')
                        THEN NULL
                        ELSE bmp_rib_scopes.cleanup_pending_epoch
                    END,
                    last_connection_id = CASE
                        WHEN ${acceptsScopeConnection} THEN excluded.last_connection_id
                        ELSE bmp_rib_scopes.last_connection_id
                    END,
                    vrf_name = CASE
                        WHEN ${acceptsScopeConnection}
                        THEN COALESCE(excluded.vrf_name, bmp_rib_scopes.vrf_name)
                        ELSE bmp_rib_scopes.vrf_name
                    END,
                    updated_at_ms = CASE
                        WHEN ${acceptsScopeProgress}
                        THEN MAX(bmp_rib_scopes.updated_at_ms, excluded.updated_at_ms)
                        ELSE bmp_rib_scopes.updated_at_ms
                    END
            `),
            markScopeEor: this.db.prepare(`
                UPDATE bmp_rib_scopes
                   SET eor_epoch = MAX(COALESCE(eor_epoch, -1), @epoch), scope_state = 'ready',
                       stale_reason = NULL, stale_since_ms = NULL, refresh_started_ms = NULL,
                       cleanup_pending_epoch = CASE
                           WHEN COALESCE(eor_epoch, -1) < @epoch THEN @epoch
                           ELSE cleanup_pending_epoch
                       END,
                       updated_at_ms = MAX(updated_at_ms, @eventAtMs)
                 WHERE scope_id = @scopeId AND last_connection_id = @connectionId
                   AND current_epoch = @epoch
            `),
            markScopeTimeout: this.db.prepare(`
                UPDATE bmp_rib_scopes
                   SET scope_state = 'ready', stale_reason = 'refresh-timeout', stale_since_ms = NULL,
                       refresh_started_ms = NULL, cleanup_pending_epoch = @epoch,
                       updated_at_ms = MAX(updated_at_ms, @eventAtMs)
                 WHERE scope_id = @scopeId AND last_connection_id = @connectionId
                   AND current_epoch = @epoch
                   AND COALESCE(eor_epoch, -1) < current_epoch
            `),
            upsertAttribute: this.db.prepare(`
                INSERT INTO bmp_route_attributes(attr_id, attr_json, first_seen_ms, last_seen_ms)
                VALUES (@id, @attrJson, @eventAtMs, @eventAtMs)
                ON CONFLICT(attr_id) DO UPDATE SET
                    last_seen_ms = MAX(bmp_route_attributes.last_seen_ms, excluded.last_seen_ms)
            `),
            insertEvent: this.db.prepare(`
                INSERT INTO bmp_route_events(
                    batch_id, source_id, connection_id, source_sequence, scope_id, route_id,
                    event_type, observed_at_ms, source_timestamp_ms, rib_epoch, attr_id, reason,
                    afi, safi, prefix, legacy_route_key, route_json
                ) VALUES (
                    @batchId, @sourceId, @connectionId, @sequence, @scopeId, @routeId,
                    @eventType, @eventAtMs, @sourceTimestampMs, @epoch, @attrId, @reason,
                    @afi, @safi, @prefix, @legacyRouteKey, @routeJson
                )
                ON CONFLICT(connection_id, source_sequence) DO NOTHING
            `),
            updateEventType: this.db.prepare(`
                UPDATE bmp_route_events
                   SET event_type = @eventType
                 WHERE event_id = @eventId
            `),
            upsertRoute: this.db.prepare(`
                INSERT INTO bmp_current_routes(
                    scope_id, route_id, route_key_json, route_identity_json, route_key_version,
                    legacy_route_key, afi, safi, path_id, rd, prefix, prefix_length, nlri_kind,
                    nlri_json, attr_id, route_json, connection_id, rib_epoch, explicit_state, first_seen_ms,
                    last_seen_ms, source_timestamp_ms, last_event_id
                ) SELECT
                    @scopeId, @routeId, @keyJson, @identityJson, @keyVersion,
                    @legacyRouteKey, @afi, @safi, @pathId, @rd, @prefix, @prefixLength, @nlriKind,
                    @nlriJson, @attrId, @routeJson, @connectionId, @epoch, 'active', @eventAtMs,
                    @eventAtMs, @sourceTimestampMs, @eventId
                 WHERE @connectionId = (
                           SELECT last_connection_id FROM bmp_rib_scopes WHERE scope_id = @scopeId
                       )
                   AND @epoch = (
                           SELECT current_epoch FROM bmp_rib_scopes WHERE scope_id = @scopeId
                       )
                ON CONFLICT(scope_id, route_id) DO UPDATE SET
                    route_key_json = excluded.route_key_json,
                    route_identity_json = excluded.route_identity_json,
                    legacy_route_key = excluded.legacy_route_key,
                    rd = excluded.rd,
                    prefix = excluded.prefix,
                    prefix_length = excluded.prefix_length,
                    nlri_kind = excluded.nlri_kind,
                    nlri_json = excluded.nlri_json,
                    attr_id = excluded.attr_id,
                    route_json = excluded.route_json,
                    connection_id = excluded.connection_id,
                    rib_epoch = excluded.rib_epoch,
                    explicit_state = 'active',
                    last_seen_ms = MAX(bmp_current_routes.last_seen_ms, excluded.last_seen_ms),
                    source_timestamp_ms = excluded.source_timestamp_ms,
                    last_event_id = excluded.last_event_id
                WHERE excluded.last_event_id >= bmp_current_routes.last_event_id
                  AND (
                      bmp_current_routes.connection_id <> @connectionId
                      OR excluded.rib_epoch >= bmp_current_routes.rib_epoch
                  )
                  AND @connectionId = (
                      SELECT last_connection_id
                        FROM bmp_rib_scopes
                       WHERE scope_id = @scopeId
                  )
            `),
            withdrawRoute: this.db.prepare(`
                DELETE FROM bmp_current_routes
                 WHERE scope_id = @scopeId AND route_id = @routeId
                   AND EXISTS (
                       SELECT 1
                         FROM bmp_rib_scopes scope
                        WHERE scope.scope_id = bmp_current_routes.scope_id
                          AND scope.last_connection_id = @connectionId
                          AND scope.current_epoch = @epoch
                   )
            `),
            insertStatistics: this.db.prepare(`
                INSERT INTO bmp_statistics_samples(
                    source_id, connection_id, scope_id, report_kind, report_key,
                    observed_at_ms, source_timestamp_ms, statistics_json
                ) VALUES (
                    @sourceId, @connectionId, @scopeId, @reportKind, @reportKey,
                    @eventAtMs, @sourceTimestampMs, @statisticsJson
                )
            `),
            upsertLatestStatistics: this.db.prepare(`
                INSERT INTO bmp_statistics_latest(source_id, report_kind, report_key, sample_id, observed_at_ms)
                VALUES (@sourceId, @reportKind, @reportKey, @sampleId, @eventAtMs)
                ON CONFLICT(source_id, report_kind, report_key) DO UPDATE SET
                    sample_id = excluded.sample_id,
                    observed_at_ms = excluded.observed_at_ms
                WHERE excluded.observed_at_ms > bmp_statistics_latest.observed_at_ms
                   OR (
                       excluded.observed_at_ms = bmp_statistics_latest.observed_at_ms
                       AND excluded.sample_id > bmp_statistics_latest.sample_id
                   )
            `)
        };
    }

    mapDeltaRouteRow(row) {
        if (!row) {
            return null;
        }
        const route = {
            ...parseJson(row.route_json, {}),
            ...parseJson(row.attr_json, {})
        };
        return {
            ...route,
            persistentRouteId: row.route_id,
            persistentScopeId: row.scope_id,
            routeKey: route.routeKey || row.legacy_route_key,
            canonicalRouteKey: parseJson(row.route_key_json),
            afi: route.afi ?? row.afi,
            safi: route.safi ?? row.safi,
            pathId: route.pathId ?? row.path_id,
            rd: route.rd ?? row.rd,
            ip: route.ip ?? route.prefix ?? row.prefix,
            mask: route.mask ?? route.length ?? row.prefix_length,
            attrId: row.attr_id || '',
            ribEpoch: row.rib_epoch
        };
    }

    mapDeltaMutationRoute(mutation) {
        const routeData = mutation.route;
        if (!routeData) {
            return null;
        }
        const route = {
            ...parseJson(routeData.routeJson, {}),
            ...parseJson(routeData.attrJson, {})
        };
        return {
            ...route,
            persistentRouteId: routeData.id,
            persistentScopeId: mutation.scope?.id || null,
            routeKey: route.routeKey || routeData.legacyRouteKey,
            canonicalRouteKey: parseJson(routeData.keyJson),
            afi: route.afi ?? finiteNumber(routeData.afi),
            safi: route.safi ?? finiteNumber(routeData.safi),
            pathId: route.pathId ?? finiteNumber(routeData.pathId, 0),
            rd: route.rd ?? routeData.rd ?? null,
            ip: route.ip ?? route.prefix ?? routeData.prefix ?? null,
            mask: route.mask ?? route.length ?? finiteNumber(routeData.prefixLength),
            attrId: routeData.attrId || '',
            ribEpoch: finiteNumber(mutation.scope?.epoch, 0)
        };
    }

    buildCommittedRouteDelta(mutation, eventId, options = {}) {
        const route = mutation.route || {};
        return {
            action: options.action,
            classification: options.classification,
            requestedEventType: mutation.eventType,
            eventType: options.eventType || options.classification,
            eventId,
            committed: true,
            projectionChanged: options.projectionChanged === true,
            sourceId: mutation.source?.id || null,
            connectionId: mutation.connection?.id || null,
            scopeId: mutation.scope?.id || null,
            ownerKey: mutation.scope?.ownerKey || null,
            source: mutation.source || null,
            connection: mutation.connection || null,
            scope: mutation.scope || null,
            scopeKind: mutation.scope?.kind || null,
            afi: finiteNumber(route.afi ?? mutation.scope?.afi),
            safi: finiteNumber(route.safi ?? mutation.scope?.safi),
            ribType: mutation.scope?.ribType ?? null,
            routeId: route.id || null,
            legacyRouteKey: route.legacyRouteKey || options.previous?.routeKey || null,
            routeKey: route.legacyRouteKey || options.previous?.routeKey || null,
            reason: mutation.reason || null,
            previous: options.previous || null,
            current: options.current || null,
            context: mutation.context ?? null,
            mutation: {
                eventType: mutation.eventType,
                sequence: mutation.sequence,
                eventAtMs: mutation.eventAtMs,
                sourceTimestampMs: mutation.sourceTimestampMs ?? null,
                reason: mutation.reason || null,
                context: mutation.context ?? null,
                source: mutation.source,
                connection: mutation.connection,
                scope: mutation.scope || null
            }
        };
    }

    buildApplyBatchResult(duplicate, applied, deltas) {
        const result = { duplicate, applied };
        // Keep the historic enumerable response shape for strict callers while exposing
        // committed deltas to direct store consumers. The worker explicitly serializes it.
        Object.defineProperty(result, 'deltas', {
            configurable: false,
            enumerable: false,
            writable: false,
            value: deltas
        });
        return result;
    }

    applyMutation(batchId, mutation, batchCache = null) {
        const source = mutation.source;
        const connection = mutation.connection;
        const scope = mutation.scope || null;
        const route = mutation.route || null;
        const eventAtMs = finiteNumber(mutation.eventAtMs, Date.now());

        if (!source?.id || !connection?.id) {
            throw new Error('BMP persistence mutation requires source and connection identities');
        }
        if (
            this.statements.findEventBySequence.get({
                connectionId: connection.id,
                sequence: mutation.sequence
            })
        ) {
            return { applied: false, delta: null };
        }

        const sourceSignature = `${source.identityJson}|${source.remoteIp || ''}|${source.sysName || ''}|${
            source.sysDesc || ''
        }|${asJson(source.metadata) || ''}`;
        if (!batchCache || batchCache.sources.get(source.id) !== sourceSignature) {
            this.statements.upsertSource.run({
                id: source.id,
                keyJson: source.keyJson,
                identityJson: source.identityJson,
                remoteIp: source.remoteIp || null,
                sysName: source.sysName || null,
                sysDesc: source.sysDesc || null,
                eventAtMs,
                metadataJson: asJson(source.metadata)
            });
            batchCache?.sources.set(source.id, sourceSignature);
        }
        if (!batchCache || !batchCache.connections.has(connection.id)) {
            this.statements.upsertConnection.run({
                id: connection.id,
                sourceId: source.id,
                generation: finiteNumber(connection.generation, 0),
                localIp: connection.localIp || null,
                localPort: finiteNumber(connection.localPort),
                remoteIp: connection.remoteIp || null,
                remotePort: finiteNumber(connection.remotePort),
                openedAtMs: finiteNumber(connection.openedAtMs, eventAtMs)
            });
            batchCache?.connections.add(connection.id);
        }

        if (scope) {
            const scopeSignature = `${connection.id}|${scope.epoch}|${scope.state || 'syncing'}|${
                mutation.reason || scope.reason || ''
            }|${scope.vrfName || ''}|${mutation.eventType}`;
            if (!batchCache || batchCache.scopes.get(scope.id) !== scopeSignature) {
                this.statements.upsertScope.run({
                    id: scope.id,
                    sourceId: source.id,
                    keyJson: scope.keyJson,
                    identityJson: scope.identityJson,
                    kind: scope.kind,
                    ownerKey: scope.ownerKey || null,
                    peerType: scope.peerType === undefined ? null : String(scope.peerType),
                    peerRd: scope.peerRd || null,
                    peerIp: scope.peerIp || null,
                    peerAs: scope.peerAs === undefined || scope.peerAs === null ? null : String(scope.peerAs),
                    vrfName: scope.vrfName || null,
                    afi: Number(scope.afi),
                    safi: Number(scope.safi),
                    ribType: String(scope.ribType),
                    epoch: finiteNumber(scope.epoch, 0),
                    state: scope.state || 'syncing',
                    reason: mutation.reason || scope.reason || null,
                    staleSinceMs: scope.state === 'stale' || scope.state === 'down' ? eventAtMs : null,
                    refreshStartedMs: scope.state === 'syncing' ? eventAtMs : null,
                    resetRefresh: mutation.eventType === 'scope_open' ? 1 : 0,
                    scopeTimeout: mutation.eventType === 'scope_timeout' ? 1 : 0,
                    connectionId: connection.id,
                    eventAtMs
                });
                batchCache?.scopes.set(scope.id, scopeSignature);
            }
        }

        if (route?.attrId && route.attrJson && (!batchCache || !batchCache.attributes.has(route.attrId))) {
            this.statements.upsertAttribute.run({
                id: route.attrId,
                attrJson: route.attrJson,
                eventAtMs
            });
            batchCache?.attributes.add(route.attrId);
        }

        const isRouteUpsert = ['upsert', 'announce', 'replace', 'refresh'].includes(mutation.eventType);
        const isRouteDelete = ['delete', 'withdraw', 'purge'].includes(mutation.eventType);
        const previousRow =
            route && scope && (isRouteUpsert || isRouteDelete)
                ? this.statements.findCurrentRoute.get({ scopeId: scope.id, routeId: route.id })
                : null;
        const previousRoute = this.mapDeltaRouteRow(previousRow);

        const eventResult = this.statements.insertEvent.run({
            batchId,
            sourceId: source.id,
            connectionId: connection.id,
            sequence: mutation.sequence,
            scopeId: scope?.id || null,
            routeId: route?.id || null,
            eventType: mutation.eventType,
            eventAtMs,
            sourceTimestampMs: finiteNumber(mutation.sourceTimestampMs),
            epoch: finiteNumber(scope?.epoch),
            attrId: route?.attrId || null,
            reason: mutation.reason || null,
            afi: finiteNumber(route?.afi ?? scope?.afi),
            safi: finiteNumber(route?.safi ?? scope?.safi),
            prefix: route?.prefix || null,
            legacyRouteKey: route?.legacyRouteKey || null,
            routeJson: route ? route.routeJson : null
        });
        if (eventResult.changes === 0) {
            return { applied: false, delta: null };
        }

        const eventId = Number(eventResult.lastInsertRowid);
        let delta = null;
        switch (mutation.eventType) {
            case 'upsert':
            case 'announce':
            case 'replace':
            case 'refresh': {
                const routeResult = this.statements.upsertRoute.run({
                    scopeId: scope.id,
                    routeId: route.id,
                    keyJson: route.keyJson,
                    identityJson: route.identityJson,
                    keyVersion: route.keyVersion,
                    legacyRouteKey: route.legacyRouteKey || null,
                    afi: Number(route.afi),
                    safi: Number(route.safi),
                    pathId: Number(route.pathId || 0),
                    rd: route.rd || null,
                    prefix: route.prefix || null,
                    prefixLength: finiteNumber(route.prefixLength),
                    nlriKind: route.nlriKind || null,
                    nlriJson: route.nlriJson,
                    attrId: route.attrId || null,
                    routeJson: route.routeJson,
                    epoch: finiteNumber(scope.epoch, 0),
                    eventAtMs,
                    sourceTimestampMs: finiteNumber(mutation.sourceTimestampMs),
                    eventId,
                    connectionId: connection.id
                });
                const projectionChanged = routeResult.changes > 0;
                const classification = projectionChanged
                    ? previousRow
                        ? (previousRow.attr_id || null) === (route.attrId || null)
                            ? 'refresh'
                            : 'replace'
                        : 'announce'
                    : 'upsert-noop';
                this.statements.updateEventType.run({ eventId, eventType: classification });
                delta = this.buildCommittedRouteDelta(mutation, eventId, {
                    action: 'upsert',
                    classification,
                    projectionChanged,
                    previous: previousRoute,
                    current: projectionChanged ? this.mapDeltaMutationRoute(mutation) : previousRoute
                });
                break;
            }
            case 'delete':
            case 'withdraw':
            case 'purge': {
                const routeResult = this.statements.withdrawRoute.run({
                    scopeId: scope.id,
                    routeId: route.id,
                    connectionId: connection.id,
                    epoch: finiteNumber(scope.epoch, 0)
                });
                const projectionChanged = routeResult.changes > 0;
                const classification = projectionChanged
                    ? mutation.eventType === 'purge'
                        ? 'purge'
                        : 'withdraw'
                    : 'withdraw-noop';
                this.statements.updateEventType.run({ eventId, eventType: classification });
                delta = this.buildCommittedRouteDelta(mutation, eventId, {
                    action: 'delete',
                    classification,
                    projectionChanged,
                    previous: previousRoute,
                    current: projectionChanged ? null : previousRoute
                });
                break;
            }
            case 'scope_eor':
                this.statements.markScopeEor.run({
                    scopeId: scope.id,
                    epoch: scope.epoch,
                    eventAtMs,
                    connectionId: connection.id
                });
                break;
            case 'scope_timeout':
                this.statements.markScopeTimeout.run({
                    scopeId: scope.id,
                    epoch: scope.epoch,
                    eventAtMs,
                    connectionId: connection.id
                });
                break;
            case 'connection_close':
                this.statements.closeConnection.run({
                    connectionId: connection.id,
                    eventAtMs,
                    reason: mutation.reason || 'connection-close'
                });
                this.statements.closeConnectionScopes.run({
                    connectionId: connection.id,
                    eventAtMs,
                    reason: mutation.reason || 'connection-close'
                });
                break;
            case 'statistics':
                {
                    const statistics = mutation.statistics || {};
                    const identity = makeStatisticsReportIdentity(statistics);
                    const result = this.statements.insertStatistics.run({
                        sourceId: source.id,
                        connectionId: connection.id,
                        scopeId: scope?.id || null,
                        reportKind: identity?.kind || null,
                        reportKey: identity?.key || null,
                        eventAtMs,
                        sourceTimestampMs: finiteNumber(mutation.sourceTimestampMs),
                        statisticsJson: asJson(statistics)
                    });
                    if (identity) {
                        this.statements.upsertLatestStatistics.run({
                            sourceId: source.id,
                            reportKind: identity.kind,
                            reportKey: identity.key,
                            sampleId: Number(result.lastInsertRowid),
                            eventAtMs
                        });
                    }
                }
                break;
            default:
                break;
        }

        return { applied: true, delta };
    }

    applyBatch(batch = {}) {
        if (this.readOnly) {
            throw new Error('Cannot apply a BMP persistence batch to a read-only store');
        }
        if (!this.db) {
            this.open();
        }

        const mutations = Array.isArray(batch.mutations) ? batch.mutations : [];
        const batchId = String(batch.batchId || '');
        if (!batchId) {
            throw new Error('BMP persistence batchId is required');
        }

        const transaction = this.db.transaction(() => {
            const batchResult = this.statements.insertBatch.run({
                batchId,
                createdAtMs: finiteNumber(batch.createdAtMs, Date.now()),
                mutationCount: mutations.length
            });
            if (batchResult.changes === 0) {
                return this.buildApplyBatchResult(true, 0, []);
            }

            let applied = 0;
            const deltas = [];
            const batchCache = {
                sources: new Map(),
                connections: new Set(),
                scopes: new Map(),
                attributes: new Set()
            };
            mutations.forEach(mutation => {
                const mutationResult = this.applyMutation(batchId, mutation, batchCache);
                if (mutationResult.applied) {
                    applied += 1;
                }
                if (mutationResult.delta) {
                    deltas.push(mutationResult.delta);
                }
            });
            return this.buildApplyBatchResult(false, applied, deltas);
        });

        return transaction();
    }

    buildRouteStateSql() {
        return `CASE
            WHEN r.explicit_state = 'stale'
              OR s.scope_state IN ('stale', 'down')
              OR r.connection_id <> s.last_connection_id
              OR r.rib_epoch < s.current_epoch
            THEN 'stale' ELSE 'active' END`;
    }

    queryRoutes(query = {}) {
        if (!this.db) {
            this.open();
        }

        const page = positiveInteger(query.page, 1);
        const pageSize = positiveInteger(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const cursor = decodeCursor(query.cursor, 'routes-by-id');
        const orderBy = query.orderBy || 'routeId';
        if (!['routeId', 'firstSeen'].includes(orderBy)) {
            throw new Error(`Unsupported BMP persistence route order: ${orderBy}`);
        }
        if (cursor && orderBy === 'firstSeen') {
            throw new Error('BMP persistence routes cursor cannot be combined with orderBy firstSeen');
        }
        const includeTotal = query.includeTotal !== false;
        const where = [];
        const params = {};
        const stateSql = this.buildRouteStateSql();
        const addFilter = (sql, name, value) => {
            if (value !== undefined && value !== null && value !== '') {
                where.push(sql);
                params[name] = value;
            }
        };
        const routePrefixValuesSql = `(
            lower(COALESCE(r.prefix, '')),
            lower(COALESCE(json_extract(r.route_json, '$.ip'), '')),
            lower(COALESCE(json_extract(r.route_json, '$.prefix'), '')),
            lower(COALESCE(json_extract(r.route_json, '$.nlriDetail.prefix'), '')),
            lower(COALESCE(json_extract(r.route_json, '$.nlriDetail.ipPrefix'), '')),
            lower(COALESCE(json_extract(r.route_json, '$.nlriDetail.ipAddress'), ''))
        )`;
        const exactCidrPredicate = (prefixParam, lengthParam) => `(
            (lower(COALESCE(r.prefix, '')) = @${prefixParam} AND r.prefix_length = @${lengthParam})
            OR (
                lower(COALESCE(json_extract(r.route_json, '$.ip'), '')) = @${prefixParam}
                AND COALESCE(
                    json_extract(r.route_json, '$.mask'),
                    json_extract(r.route_json, '$.length')
                ) = @${lengthParam}
            )
            OR (
                (
                    lower(COALESCE(json_extract(r.route_json, '$.nlriDetail.prefix'), '')) = @${prefixParam}
                    OR lower(COALESCE(json_extract(r.route_json, '$.nlriDetail.ipPrefix'), '')) = @${prefixParam}
                )
                AND COALESCE(
                    json_extract(r.route_json, '$.nlriDetail.prefixLength'),
                    json_extract(r.route_json, '$.nlriDetail.length')
                ) = @${lengthParam}
            )
            OR (
                lower(COALESCE(json_extract(r.route_json, '$.nlriDetail.ipAddress'), '')) = @${prefixParam}
                AND @${lengthParam} IN (32, 128)
            )
        )`;

        addFilter('s.source_id = @sourceId', 'sourceId', query.sourceId);
        addFilter('s.scope_id = @scopeId', 'scopeId', query.scopeId);
        addFilter('s.owner_key = @ownerKey', 'ownerKey', query.ownerKey);
        addFilter('r.connection_id = @connectionId', 'connectionId', query.connectionId);
        addFilter('r.route_id = @routeId', 'routeId', query.routeId);
        addFilter('r.legacy_route_key = @legacyRouteKey', 'legacyRouteKey', query.legacyRouteKey || query.routeKey);
        addFilter('s.scope_kind = @scopeKind', 'scopeKind', query.scopeKind);
        addFilter('r.afi = @afi', 'afi', finiteNumber(query.afi));
        addFilter('r.safi = @safi', 'safi', finiteNumber(query.safi));
        addFilter('r.prefix_length = @prefixLength', 'prefixLength', finiteNumber(query.prefixLength));
        addFilter('s.rib_type = @ribType', 'ribType', query.ribType);
        addFilter('s.scope_state = @scopeState', 'scopeState', query.scopeState);
        if (query.prefixExact !== undefined && query.prefixExact !== null && query.prefixExact !== '') {
            params.prefixExact = String(query.prefixExact);
            where.push('r.prefix = @prefixExact');
        } else if (query.prefix) {
            params.prefixStart = String(query.prefix);
            params.prefixEnd = `${params.prefixStart}\uffff`;
            where.push('r.prefix >= @prefixStart AND r.prefix < @prefixEnd');
        }
        const prefixCidrs = normalizePrefixCidrs(query.prefixCidrs);
        if (prefixCidrs.length > 400) {
            throw new Error('BMP persistence prefixCidrs supports at most 400 entries');
        }
        if (prefixCidrs.length > 0) {
            const cidrWhere = prefixCidrs.map((cidr, index) => {
                params[`cidrPrefix${index}`] = cidr.prefix.toLowerCase();
                params[`cidrLength${index}`] = cidr.prefixLength;
                return exactCidrPredicate(`cidrPrefix${index}`, `cidrLength${index}`);
            });
            where.push(`(${cidrWhere.join(' OR ')})`);
        }
        const searchText = String(query.searchText ?? '')
            .trim()
            .toLowerCase();
        if (searchText) {
            params.searchText = searchText;
            where.push(`instr(lower(
                COALESCE(r.prefix, '') || char(31) ||
                COALESCE(r.legacy_route_key, '') || char(31) ||
                COALESCE(r.route_id, '') || char(31) ||
                COALESCE(r.route_json, '') || char(31) ||
                COALESCE(route_attr.attr_json, '') || char(31) ||
                COALESCE(s.owner_key, '') || char(31) ||
                COALESCE(s.peer_ip, '') || char(31) ||
                COALESCE(s.peer_as, '') || char(31) ||
                COALESCE(s.vrf_name, '') || char(31) ||
                COALESCE(src.sys_name, '') || char(31) ||
                COALESCE(src.remote_ip, '')
            ), @searchText) > 0`);
        }
        const routeIdentityText = String(query.routeIdentityText ?? '')
            .trim()
            .toLowerCase();
        if (routeIdentityText) {
            params.routeIdentityText = routeIdentityText;
            where.push(`instr(lower(
                COALESCE(r.prefix, '') || char(31) ||
                COALESCE(r.legacy_route_key, '') || char(31) ||
                COALESCE(r.route_json, '') || char(31) ||
                CASE r.afi
                    WHEN 1 THEN 'ipv4'
                    WHEN 2 THEN 'ipv6'
                    WHEN 25 THEN 'l2vpn'
                    WHEN 16388 THEN 'bgp-ls'
                    ELSE 'unknown (' || r.afi || ')'
                END || ' ' ||
                CASE r.safi
                    WHEN 1 THEN 'unicast'
                    WHEN 2 THEN 'multicast'
                    WHEN 4 THEN 'labeled unicast'
                    WHEN 5 THEN 'mvpn'
                    WHEN 70 THEN 'evpn'
                    WHEN 71 THEN 'bgp-ls'
                    WHEN 72 THEN 'bgp-ls-vpn'
                    WHEN 128 THEN 'vpn'
                    WHEN 133 THEN 'flowspec'
                    ELSE 'unknown (' || r.safi || ')'
                END
            ), @routeIdentityText) > 0`);
        }
        const prefixFilter = String(query.prefixFilter ?? '').trim();
        if (prefixFilter) {
            let parsedCidr = null;
            try {
                const separator = prefixFilter.lastIndexOf('/');
                if (separator > 0 && isStrictIpAddress(prefixFilter.slice(0, separator))) {
                    parsedCidr = ipaddr.parseCIDR(prefixFilter);
                }
            } catch (_error) {
                // A non-CIDR prefix filter is handled as an exact IP or plain text below.
            }
            if (parsedCidr) {
                const [address, length] = parsedCidr;
                params.prefixFilterValue = address.constructor
                    .networkAddressFromCIDR(`${address.toString()}/${length}`)
                    .toString()
                    .toLowerCase();
                params.prefixFilterLength = length;
                where.push(exactCidrPredicate('prefixFilterValue', 'prefixFilterLength'));
            } else if (isStrictIpAddress(prefixFilter)) {
                params.prefixFilterValue = ipaddr.parse(prefixFilter).toString().toLowerCase();
                where.push(`@prefixFilterValue IN ${routePrefixValuesSql}`);
            } else {
                params.prefixFilterText = prefixFilter.toLowerCase();
                where.push(`instr(lower(
                    COALESCE(r.prefix, '') || char(31) ||
                    COALESCE(json_extract(r.route_json, '$.ip'), '') || char(31) ||
                    COALESCE(json_extract(r.route_json, '$.prefix'), '') || char(31) ||
                    COALESCE(json_extract(r.route_json, '$.nlriDetail.prefix'), '') || char(31) ||
                    COALESCE(json_extract(r.route_json, '$.nlriDetail.ipPrefix'), '') || char(31) ||
                    COALESCE(json_extract(r.route_json, '$.nlriDetail.ipAddress'), '') || char(31) ||
                    COALESCE(json_extract(r.route_json, '$.nlriDetail.formatted'), '')
                ), @prefixFilterText) > 0`);
            }
        }
        if (query.routeState && query.routeState !== 'all') {
            where.push(`${stateSql} = @routeState`);
            params.routeState = query.routeState;
        }
        const countWhereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const countParams = { ...params };
        if (cursor) {
            if (typeof cursor.scopeId !== 'string' || typeof cursor.routeId !== 'string') {
                throw new Error('Invalid BMP persistence routes cursor fields');
            }
            where.push('(r.scope_id, r.route_id) > (@cursorScopeId, @cursorRouteId)');
            params.cursorScopeId = cursor.scopeId;
            params.cursorRouteId = cursor.routeId;
        }

        const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const readSnapshot = this.db.transaction(() => {
            const total = includeTotal
                ? this.db
                      .prepare(
                          `
                      SELECT COUNT(*) AS total
                        FROM bmp_current_routes r
                        JOIN bmp_rib_scopes s ON s.scope_id = r.scope_id
                        JOIN bmp_sources src ON src.source_id = s.source_id
                        LEFT JOIN bmp_route_attributes route_attr ON route_attr.attr_id = r.attr_id
                        ${countWhereSql}
                  `
                      )
                      .get(countParams).total
                : null;

            const rows = this.db
                .prepare(
                    `
                SELECT r.*, s.source_id, s.scope_kind, s.owner_key, s.scope_identity_json,
                       s.peer_type, s.peer_rd,
                       s.peer_ip, s.peer_as, s.vrf_name, s.rib_type, s.current_epoch,
                       s.eor_epoch, s.scope_state, s.stale_reason AS scope_stale_reason,
                       s.stale_since_ms, s.refresh_started_ms, s.updated_at_ms AS scope_updated_at_ms,
                       s.cleanup_pending_epoch,
                       route_attr.attr_json AS attr_json,
                       src.remote_ip AS source_remote_ip, src.sys_name, src.sys_desc,
                       conn.local_ip AS connection_local_ip, conn.local_port AS connection_local_port,
                       conn.remote_ip AS connection_remote_ip, conn.remote_port AS connection_remote_port,
                       ${stateSql} AS effective_state
                  FROM bmp_current_routes r
                  JOIN bmp_rib_scopes s ON s.scope_id = r.scope_id
                  JOIN bmp_sources src ON src.source_id = s.source_id
                  JOIN bmp_connections conn ON conn.connection_id = r.connection_id
                  LEFT JOIN bmp_route_attributes route_attr ON route_attr.attr_id = r.attr_id
                  ${whereSql}
                 ORDER BY ${
                     orderBy === 'firstSeen'
                         ? 'r.first_seen_ms, r.last_event_id, r.scope_id, r.route_id'
                         : 'r.scope_id, r.route_id'
                 }
                 LIMIT @limit OFFSET @offset
            `
                )
                .all({ ...params, limit: pageSize + 1, offset: cursor ? 0 : (page - 1) * pageSize });
            return { total, rows };
        });
        const { total, rows } = readSnapshot();
        const hasMore = rows.length > pageSize;
        const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
        const lastRow = pageRows[pageRows.length - 1];

        return {
            list: pageRows.map(row => this.mapRouteRow(row)),
            total,
            page,
            pageSize,
            nextCursor:
                orderBy === 'routeId' && hasMore && lastRow
                    ? encodeCursor('routes-by-id', {
                          scopeId: lastRow.scope_id,
                          routeId: lastRow.route_id
                      })
                    : null
        };
    }

    mapRouteRow(row) {
        const route = {
            ...parseJson(row.route_json, {}),
            ...parseJson(row.attr_json, {}),
            attrId: row.attr_id || ''
        };
        const scopeIdentity = parseJson(row.scope_identity_json, {});
        const peerRdIdentity = scopeIdentity?.peer?.rd;
        return {
            ...route,
            persistentRouteId: row.route_id,
            persistentScopeId: row.scope_id,
            persistentSourceId: row.source_id,
            persistentConnectionId: row.connection_id,
            ownerKey: row.owner_key,
            routeKey: route.routeKey || row.legacy_route_key,
            canonicalRouteKey: parseJson(row.route_key_json),
            routeState: row.effective_state,
            staleReason:
                row.effective_state === 'stale'
                    ? route.staleReason ||
                      row.scope_stale_reason ||
                      (row.rib_epoch < row.current_epoch ? 'refresh-pending' : 'connection-replaced')
                    : null,
            staleAt:
                row.effective_state === 'stale'
                    ? route.staleAt ||
                      (row.stale_since_ms === null &&
                      row.refresh_started_ms === null &&
                      row.scope_updated_at_ms === null
                          ? null
                          : new Date(
                                row.stale_since_ms ?? row.refresh_started_ms ?? row.scope_updated_at_ms
                            ).toISOString())
                    : null,
            staleEpoch: row.effective_state === 'stale' ? (route.staleEpoch ?? row.current_epoch ?? null) : null,
            scopeStaleReason: row.scope_stale_reason,
            ribEpoch: row.rib_epoch,
            currentEpoch: row.current_epoch,
            eorEpoch: row.eor_epoch,
            refreshStartedAt: row.refresh_started_ms === null ? null : new Date(row.refresh_started_ms).toISOString(),
            cleanupPendingEpoch: row.cleanup_pending_epoch,
            scopeState: row.scope_state,
            scopeKind: row.scope_kind,
            ribType: row.rib_type,
            peer: {
                type: row.peer_type,
                rd: row.peer_rd,
                rdRaw: typeof peerRdIdentity === 'string' && peerRdIdentity.startsWith('raw:') ? peerRdIdentity : null,
                ip: row.peer_ip,
                as: row.peer_as,
                vrf: row.vrf_name
            },
            source: {
                localIp: row.connection_local_ip,
                localPort: row.connection_local_port,
                remoteIp: row.connection_remote_ip || row.source_remote_ip,
                remotePort: row.connection_remote_port,
                sysName: row.sys_name,
                sysDesc: row.sys_desc
            },
            firstSeenAt: new Date(row.first_seen_ms).toISOString(),
            lastSeenAt: new Date(row.last_seen_ms).toISOString(),
            sourceTimestampMs: row.source_timestamp_ms
        };
    }

    queryRouteScope(query = {}) {
        if (!this.db) {
            this.open();
        }
        const routeQuery = query.routeQuery || {};
        const summaryQuery = query.summaryQuery || {};
        return this.db.transaction(() => ({
            routes: this.queryRoutes(routeQuery),
            summary: this.queryScopeSummary(summaryQuery)
        }))();
    }

    queryTopology(query = {}) {
        if (!this.db) {
            this.open();
        }

        const params = {};
        const sourceWhere = [];
        if (query.sourceId !== undefined && query.sourceId !== null && query.sourceId !== '') {
            params.sourceId = String(query.sourceId);
            sourceWhere.push('src.source_id = @sourceId');
        }
        const sourceWhereSql = sourceWhere.length > 0 ? `WHERE ${sourceWhere.join(' AND ')}` : '';
        const scopeWhereSql = sourceWhere.length > 0 ? 'WHERE s.source_id = @sourceId' : '';
        const stateSql = this.buildRouteStateSql();

        const readSnapshot = this.db.transaction(() => {
            const sourceRows = this.db
                .prepare(
                    `
                    SELECT src.*,
                           conn.connection_id AS latest_connection_id,
                           conn.connection_generation AS latest_connection_generation,
                           conn.local_ip AS latest_local_ip, conn.local_port AS latest_local_port,
                           conn.remote_ip AS latest_remote_ip, conn.remote_port AS latest_remote_port,
                           conn.opened_at_ms AS latest_opened_at_ms,
                           conn.closed_at_ms AS latest_closed_at_ms,
                           conn.close_reason AS latest_close_reason,
                           conn.connection_state AS latest_connection_state
                      FROM bmp_sources src
                      LEFT JOIN bmp_connections conn ON conn.connection_id = (
                          SELECT candidate.connection_id
                            FROM bmp_connections candidate
                           WHERE candidate.source_id = src.source_id
                           ORDER BY candidate.connection_generation DESC,
                                    candidate.opened_at_ms DESC, candidate.connection_id DESC
                           LIMIT 1
                      )
                      ${sourceWhereSql}
                     ORDER BY src.source_id
                `
                )
                .all(params);
            const scopeRows = this.db
                .prepare(
                    `
                    SELECT s.*,
                           conn.connection_id AS scope_connection_id,
                           conn.connection_generation AS scope_connection_generation,
                           conn.connection_state AS scope_connection_state,
                           conn.local_ip AS scope_local_ip, conn.local_port AS scope_local_port,
                           conn.remote_ip AS scope_remote_ip, conn.remote_port AS scope_remote_port,
                           conn.opened_at_ms AS scope_opened_at_ms,
                           conn.closed_at_ms AS scope_closed_at_ms,
                           conn.close_reason AS scope_close_reason,
                           SUM(CASE
                               WHEN r.route_id IS NOT NULL AND ${stateSql} = 'active' THEN 1 ELSE 0
                           END) AS active,
                           SUM(CASE
                               WHEN r.route_id IS NOT NULL AND ${stateSql} = 'stale' THEN 1 ELSE 0
                           END) AS stale,
                           COUNT(r.route_id) AS total
                      FROM bmp_rib_scopes s
                      LEFT JOIN bmp_current_routes r ON r.scope_id = s.scope_id
                      LEFT JOIN bmp_connections conn ON conn.connection_id = s.last_connection_id
                      ${scopeWhereSql}
                     GROUP BY s.scope_id
                     ORDER BY s.source_id, s.scope_kind, s.owner_key, s.afi, s.safi, s.rib_type, s.scope_id
                `
                )
                .all(params);
            return { sourceRows, scopeRows };
        });

        const { sourceRows, scopeRows } = readSnapshot();
        const emptySummary = () => ({ active: 0, stale: 0, total: 0 });
        const addSummary = (target, value) => {
            target.active += Number(value.active || 0);
            target.stale += Number(value.stale || 0);
            target.total += Number(value.total || 0);
        };
        const mapConnection = (row, prefix = '') => {
            const connectionId = row[`${prefix}connection_id`] ?? row.last_connection_id ?? null;
            if (!connectionId) {
                return null;
            }
            return {
                connectionId,
                generation: finiteNumber(row[`${prefix}connection_generation`], 0),
                state: row[`${prefix}connection_state`] || null,
                localIp: row[`${prefix}local_ip`] || null,
                localPort: finiteNumber(row[`${prefix}local_port`]),
                remoteIp: row[`${prefix}remote_ip`] || null,
                remotePort: finiteNumber(row[`${prefix}remote_port`]),
                openedAtMs: finiteNumber(row[`${prefix}opened_at_ms`]),
                closedAtMs: finiteNumber(row[`${prefix}closed_at_ms`]),
                closeReason: row[`${prefix}close_reason`] || null
            };
        };
        const normalizePeerNumber = value => {
            if (value === null || value === undefined || value === '') {
                return null;
            }
            const number = Number(value);
            return Number.isSafeInteger(number) ? number : value;
        };

        const clients = sourceRows.map(row => {
            const metadata = parseJson(row.metadata_json, {});
            const connection = mapConnection(row, 'latest_');
            const routeSummary = emptySummary();
            return {
                persistentSourceId: row.source_id,
                sourceId: row.source_id,
                sourceIdentity: parseJson(row.source_identity_json, {}),
                sysName: row.sys_name,
                sysDesc: row.sys_desc,
                bmpVersion: metadata?.bmpVersion ?? null,
                bmpV4TlvDraft: metadata?.bmpV4TlvDraft ?? null,
                metadata,
                remoteIp: connection?.remoteIp || row.remote_ip,
                localIp: connection?.localIp || null,
                localPort: connection?.localPort ?? null,
                remotePort: connection?.remotePort ?? null,
                persistentConnectionId: connection?.connectionId || null,
                connectionId: connection?.connectionId || null,
                connectionState: connection?.state || null,
                isOnline: connection?.state === 'open',
                connection,
                firstSeenMs: finiteNumber(row.first_seen_ms),
                lastSeenMs: finiteNumber(row.last_seen_ms),
                receivedAt: connection?.openedAtMs ?? null,
                routeSummary,
                sessions: [],
                instances: []
            };
        });
        const clientBySourceId = new Map(clients.map(client => [client.sourceId, client]));
        const sessionByKey = new Map();
        const scopes = [];

        scopeRows.forEach(row => {
            const scopeIdentity = parseJson(row.scope_identity_json, {});
            const peerRdIdentity = scopeIdentity?.peer?.rd;
            const connection = mapConnection(row, 'scope_');
            const routeSummary = {
                active: Number(row.active || 0),
                stale: Number(row.stale || 0),
                total: Number(row.total || 0)
            };
            const scope = {
                persistentScopeId: row.scope_id,
                scopeId: row.scope_id,
                persistentSourceId: row.source_id,
                sourceId: row.source_id,
                persistentOwnerKey: row.owner_key,
                ownerKey: row.owner_key,
                persistentConnectionId: row.last_connection_id,
                connectionId: row.last_connection_id,
                scopeIdentity,
                scopeKind: row.scope_kind,
                peerType: normalizePeerNumber(row.peer_type),
                peerRd: row.peer_rd,
                peerRdRaw:
                    typeof peerRdIdentity === 'string' && peerRdIdentity.startsWith('raw:') ? peerRdIdentity : null,
                peerIp: row.peer_ip,
                peerAs: normalizePeerNumber(row.peer_as),
                vrfName: row.vrf_name,
                afi: Number(row.afi),
                safi: Number(row.safi),
                addrFamilyType: getAddrFamilyType(Number(row.afi), Number(row.safi)),
                ribType: row.rib_type,
                currentEpoch: Number(row.current_epoch || 0),
                eorEpoch: finiteNumber(row.eor_epoch),
                scopeState: row.scope_state,
                staleReason: row.stale_reason,
                staleSinceMs: finiteNumber(row.stale_since_ms),
                refreshStartedMs: finiteNumber(row.refresh_started_ms),
                cleanupPendingEpoch: finiteNumber(row.cleanup_pending_epoch),
                connectionState: connection?.state || null,
                isOnline: connection?.state === 'open',
                connection,
                createdAtMs: finiteNumber(row.created_at_ms),
                updatedAtMs: finiteNumber(row.updated_at_ms),
                routeSummary
            };
            scopes.push(scope);

            const client = clientBySourceId.get(scope.sourceId);
            if (!client) {
                return;
            }
            addSummary(client.routeSummary, routeSummary);
            if (scope.scopeKind === 'loc-rib') {
                client.instances.push({
                    persistentSourceId: scope.sourceId,
                    sourceId: scope.sourceId,
                    persistentOwnerKey: scope.ownerKey,
                    ownerKey: scope.ownerKey,
                    persistentScopeId: scope.scopeId,
                    scopeId: scope.scopeId,
                    persistentConnectionId: scope.connectionId,
                    connectionId: scope.connectionId,
                    connectionState: scope.connectionState,
                    isOnline: scope.isOnline,
                    connection: scope.connection,
                    instanceType: scope.peerType,
                    instanceFlags: null,
                    rawInstanceFlags: null,
                    instanceRd: scope.peerRd,
                    instanceRdRaw: scope.peerRdRaw,
                    instanceIp: scope.peerIp,
                    instanceAs: scope.peerAs,
                    instanceRouterId: null,
                    instanceState: null,
                    afi: scope.afi,
                    safi: scope.safi,
                    addrFamilyType: scope.addrFamilyType,
                    ribTypes: [scope.ribType],
                    vrfTableNames: scope.vrfName ? [scope.vrfName] : [],
                    ribEpoch: scope.currentEpoch,
                    scopeState: scope.scopeState,
                    staleReason: scope.staleReason,
                    routeSummary: { ...routeSummary },
                    routeScopes: [scope]
                });
                return;
            }

            const sessionKey = `${scope.sourceId}\u0000${scope.ownerKey || scope.scopeId}`;
            let session = sessionByKey.get(sessionKey);
            if (!session) {
                session = {
                    persistentSourceId: scope.sourceId,
                    sourceId: scope.sourceId,
                    persistentOwnerKey: scope.ownerKey,
                    ownerKey: scope.ownerKey,
                    persistentConnectionId: scope.connectionId,
                    connectionId: scope.connectionId,
                    connectionState: scope.connectionState,
                    isOnline: scope.isOnline,
                    connection: scope.connection,
                    sessionType: scope.peerType,
                    sessionFlags: null,
                    rawSessionFlags: null,
                    sessionRd: scope.peerRd,
                    sessionRdRaw: scope.peerRdRaw,
                    sessionIp: scope.peerIp,
                    sessionAs: scope.peerAs,
                    sessionRouterId: null,
                    sessionState: null,
                    enabledAddressFamilies: [],
                    ribTypes: [],
                    vrfTableNames: [],
                    ribEpochMap: {},
                    routeSummary: emptySummary(),
                    routeScopes: []
                };
                sessionByKey.set(sessionKey, session);
                client.sessions.push(session);
            }
            const sessionConnectionGeneration = finiteNumber(session.connection?.generation, -1);
            if ((connection?.generation ?? -1) > sessionConnectionGeneration) {
                session.persistentConnectionId = scope.connectionId;
                session.connectionId = scope.connectionId;
                session.connectionState = scope.connectionState;
                session.connection = scope.connection;
            }
            session.isOnline = session.isOnline || scope.isOnline;
            session.routeScopes.push(scope);
            addSummary(session.routeSummary, routeSummary);
            if (!session.enabledAddressFamilies.some(item => item.afi === scope.afi && item.safi === scope.safi)) {
                session.enabledAddressFamilies.push({ afi: scope.afi, safi: scope.safi });
            }
            if (!session.ribTypes.includes(scope.ribType)) {
                session.ribTypes.push(scope.ribType);
            }
            if (scope.vrfName && !session.vrfTableNames.includes(scope.vrfName)) {
                session.vrfTableNames.push(scope.vrfName);
            }
            session.ribEpochMap[`${scope.afi}|${scope.safi}|${scope.ribType}`] = scope.currentEpoch;
        });

        clients.forEach(client => {
            client.sessions.sort((left, right) => String(left.ownerKey).localeCompare(String(right.ownerKey)));
            client.instances.sort((left, right) => String(left.ownerKey).localeCompare(String(right.ownerKey)));
        });
        const routeSummary = emptySummary();
        clients.forEach(client => addSummary(routeSummary, client.routeSummary));
        return {
            clients,
            scopes,
            routeSummary,
            sourceCount: clients.length,
            sessionCount: clients.reduce((total, client) => total + client.sessions.length, 0),
            instanceCount: clients.reduce((total, client) => total + client.instances.length, 0),
            scopeCount: scopes.length
        };
    }

    queryScopeSummary(query = {}) {
        if (!this.db) {
            this.open();
        }

        const where = [];
        const params = {};
        const addFilter = (sql, name, value) => {
            if (value !== undefined && value !== null && value !== '') {
                where.push(sql);
                params[name] = value;
            }
        };
        addFilter('s.source_id = @sourceId', 'sourceId', query.sourceId);
        addFilter('s.scope_id = @scopeId', 'scopeId', query.scopeId);
        addFilter('s.owner_key = @ownerKey', 'ownerKey', query.ownerKey);
        addFilter('s.last_connection_id = @connectionId', 'connectionId', query.connectionId);
        addFilter('s.scope_kind = @scopeKind', 'scopeKind', query.scopeKind);
        addFilter('s.afi = @afi', 'afi', finiteNumber(query.afi));
        addFilter('s.safi = @safi', 'safi', finiteNumber(query.safi));
        addFilter('s.rib_type = @ribType', 'ribType', query.ribType);
        addFilter('s.scope_state = @scopeState', 'scopeState', query.scopeState);
        const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const stateSql = this.buildRouteStateSql();
        const rows = this.db
            .prepare(
                `
                SELECT s.scope_id, s.source_id, s.last_connection_id, s.owner_key,
                       s.scope_kind, s.afi, s.safi, s.rib_type, s.scope_state,
                       s.current_epoch, s.eor_epoch, s.stale_reason,
                       SUM(CASE WHEN r.route_id IS NOT NULL AND ${stateSql} = 'active' THEN 1 ELSE 0 END) AS active,
                       SUM(CASE WHEN r.route_id IS NOT NULL AND ${stateSql} = 'stale' THEN 1 ELSE 0 END) AS stale,
                       COUNT(r.route_id) AS total
                  FROM bmp_rib_scopes s
                  LEFT JOIN bmp_current_routes r ON r.scope_id = s.scope_id
                  ${whereSql}
                 GROUP BY s.scope_id
                 ORDER BY s.scope_id
            `
            )
            .all(params)
            .map(row => ({
                scopeId: row.scope_id,
                sourceId: row.source_id,
                connectionId: row.last_connection_id,
                ownerKey: row.owner_key,
                scopeKind: row.scope_kind,
                afi: row.afi,
                safi: row.safi,
                ribType: row.rib_type,
                scopeState: row.scope_state,
                currentEpoch: row.current_epoch,
                eorEpoch: row.eor_epoch,
                staleReason: row.stale_reason,
                active: Number(row.active || 0),
                stale: Number(row.stale || 0),
                total: Number(row.total || 0)
            }));
        return {
            active: rows.reduce((total, row) => total + row.active, 0),
            stale: rows.reduce((total, row) => total + row.stale, 0),
            total: rows.reduce((total, row) => total + row.total, 0),
            scopes: rows
        };
    }

    purgeStaleRoutes(query = {}) {
        if (this.readOnly) {
            throw new Error('Cannot purge stale routes from a read-only BMP persistence store');
        }
        if (!this.db) {
            this.open();
        }
        if (!query.scopeId && !query.ownerKey) {
            throw new Error('BMP stale route purge requires scopeId or ownerKey');
        }

        const routeLimit = positiveInteger(query.routeLimit, 2000, 20000);
        const where = [`${this.buildRouteStateSql()} = 'stale'`];
        const params = {};
        const addFilter = (sql, name, value) => {
            if (value !== undefined && value !== null && value !== '') {
                where.push(sql);
                params[name] = value;
            }
        };
        addFilter('s.source_id = @sourceId', 'sourceId', query.sourceId);
        addFilter('s.scope_id = @scopeId', 'scopeId', query.scopeId);
        addFilter('s.owner_key = @ownerKey', 'ownerKey', query.ownerKey);
        addFilter('s.last_connection_id = @connectionId', 'connectionId', query.connectionId);
        addFilter('s.scope_kind = @scopeKind', 'scopeKind', query.scopeKind);
        addFilter('r.afi = @afi', 'afi', finiteNumber(query.afi));
        addFilter('r.safi = @safi', 'safi', finiteNumber(query.safi));
        addFilter('s.rib_type = @ribType', 'ribType', query.ribType);
        addFilter('r.prefix = @prefixExact', 'prefixExact', query.prefixExact);
        addFilter('r.prefix_length = @prefixLength', 'prefixLength', finiteNumber(query.prefixLength));
        const whereSql = `WHERE ${where.join(' AND ')}`;
        const eventAtMs = finiteNumber(query.eventAtMs, Date.now());
        const reason = query.reason || 'manual-stale-purge';
        const batchId = `manual-purge-${eventAtMs}-${crypto.randomBytes(8).toString('hex')}`;

        const purge = this.db.transaction(() => {
            const rows = this.db
                .prepare(
                    `
                    SELECT r.*, s.source_id, s.scope_kind, s.owner_key, s.scope_identity_json,
                           s.peer_type, s.peer_rd, s.peer_ip, s.peer_as, s.vrf_name, s.rib_type,
                           s.current_epoch, s.eor_epoch, s.scope_state,
                           s.last_connection_id, s.stale_reason AS scope_stale_reason,
                           s.stale_since_ms, s.refresh_started_ms, s.updated_at_ms AS scope_updated_at_ms,
                           s.cleanup_pending_epoch,
                           route_attr.attr_json AS attr_json,
                           src.remote_ip AS source_remote_ip, src.sys_name, src.sys_desc,
                           conn.local_ip AS connection_local_ip, conn.local_port AS connection_local_port,
                           conn.remote_ip AS connection_remote_ip, conn.remote_port AS connection_remote_port,
                           ${this.buildRouteStateSql()} AS effective_state
                      FROM bmp_current_routes r
                      JOIN bmp_rib_scopes s ON s.scope_id = r.scope_id
                      JOIN bmp_sources src ON src.source_id = s.source_id
                      JOIN bmp_connections conn ON conn.connection_id = r.connection_id
                      LEFT JOIN bmp_route_attributes route_attr ON route_attr.attr_id = r.attr_id
                      ${whereSql}
                     ORDER BY r.scope_id, r.route_id
                     LIMIT @limit
                `
                )
                .all({ ...params, limit: routeLimit + 1 });
            const hasMore = rows.length > routeLimit;
            const candidates = hasMore ? rows.slice(0, routeLimit) : rows;
            const deleteRoute = this.db.prepare(
                'DELETE FROM bmp_current_routes WHERE scope_id = @scopeId AND route_id = @routeId'
            );
            const minimumSequence = this.db.prepare(`
                SELECT MIN(source_sequence) AS value
                  FROM bmp_route_events
                 WHERE connection_id = @connectionId
            `);
            const nextSequenceByConnection = new Map();
            const takeSyntheticSequence = connectionId => {
                if (!nextSequenceByConnection.has(connectionId)) {
                    const currentMinimum = finiteNumber(minimumSequence.get({ connectionId })?.value);
                    nextSequenceByConnection.set(
                        connectionId,
                        currentMinimum !== null && currentMinimum < 0 ? currentMinimum - 1 : -1
                    );
                }
                const sequence = nextSequenceByConnection.get(connectionId);
                nextSequenceByConnection.set(connectionId, sequence - 1);
                return sequence;
            };
            const deletedRows = [];
            candidates.forEach(row => {
                const result = deleteRoute.run({ scopeId: row.scope_id, routeId: row.route_id });
                if (result.changes > 0) {
                    const eventResult = this.statements.insertEvent.run({
                        batchId,
                        sourceId: row.source_id,
                        connectionId: row.last_connection_id,
                        sequence: takeSyntheticSequence(row.last_connection_id),
                        scopeId: row.scope_id,
                        routeId: row.route_id,
                        eventType: 'purge',
                        eventAtMs,
                        sourceTimestampMs: null,
                        epoch: row.current_epoch,
                        attrId: row.attr_id || null,
                        reason,
                        afi: row.afi,
                        safi: row.safi,
                        prefix: row.prefix || null,
                        legacyRouteKey: row.legacy_route_key || null,
                        routeJson: row.route_json
                    });
                    deletedRows.push({ ...row, purge_event_id: Number(eventResult.lastInsertRowid) });
                }
            });
            if (deletedRows.length > 0) {
                this.statements.insertBatch.run({
                    batchId,
                    createdAtMs: eventAtMs,
                    mutationCount: deletedRows.length
                });
            }
            return { hasMore, rows: deletedRows };
        });
        const result = purge();
        const routes = result.rows.map(row => this.mapRouteRow(row));
        return {
            purged: routes.length,
            hasMore: result.hasMore,
            routes,
            deltas: result.rows.map((row, index) => ({
                action: 'delete',
                classification: 'purge',
                eventType: 'purge',
                eventId: row.purge_event_id,
                committed: true,
                projectionChanged: true,
                sourceId: row.source_id,
                connectionId: row.last_connection_id,
                scopeId: row.scope_id,
                ownerKey: row.owner_key,
                source: { id: row.source_id },
                connection: { id: row.last_connection_id },
                scope: {
                    id: row.scope_id,
                    ownerKey: row.owner_key,
                    kind: row.scope_kind,
                    afi: row.afi,
                    safi: row.safi,
                    ribType: row.rib_type,
                    epoch: row.current_epoch,
                    state: row.scope_state
                },
                scopeKind: row.scope_kind,
                afi: row.afi,
                safi: row.safi,
                ribType: row.rib_type,
                routeId: row.route_id,
                legacyRouteKey: row.legacy_route_key,
                routeKey: row.legacy_route_key,
                reason,
                previous: routes[index],
                current: null,
                context: query.context ?? null,
                mutation: null
            }))
        };
    }

    queryStatisticsReports(query = {}) {
        if (!this.db) {
            this.open();
        }
        const sourceId = String(query.sourceId || '').trim();
        if (!sourceId) {
            throw new Error('BMP statistics report query requires sourceId');
        }
        const kind = String(query.kind || '').trim();
        if (kind !== 'session' && kind !== 'instance') {
            throw new Error('BMP statistics report query kind must be session or instance');
        }

        return this.db
            .prepare(
                `SELECT sample.statistics_json
                   FROM bmp_statistics_latest latest
                   JOIN bmp_statistics_samples sample ON sample.sample_id = latest.sample_id
                  WHERE latest.source_id = @sourceId AND latest.report_kind = @kind
                  ORDER BY latest.observed_at_ms DESC, latest.sample_id DESC`
            )
            .all({ sourceId, kind })
            .map(row => parseJson(row.statistics_json))
            .filter(report => report && typeof report === 'object' && !Array.isArray(report));
    }

    queryEvents(query = {}) {
        if (!this.db) {
            this.open();
        }

        const page = positiveInteger(query.page, 1);
        const pageSize = positiveInteger(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const cursor = decodeCursor(query.cursor, 'events');
        const includeTotal = query.includeTotal !== false;
        const where = [];
        const params = {};
        const addFilter = (sql, name, value) => {
            if (value !== undefined && value !== null && value !== '') {
                where.push(sql);
                params[name] = value;
            }
        };
        addFilter('e.source_id = @sourceId', 'sourceId', query.sourceId);
        addFilter('e.scope_id = @scopeId', 'scopeId', query.scopeId);
        addFilter('e.route_id = @routeId', 'routeId', query.routeId);
        addFilter('e.event_type = @eventType', 'eventType', query.eventType);
        addFilter('s.scope_kind = @scopeKind', 'scopeKind', query.scopeKind);
        addFilter('e.afi = @afi', 'afi', finiteNumber(query.afi));
        addFilter('e.safi = @safi', 'safi', finiteNumber(query.safi));
        addFilter('s.rib_type = @ribType', 'ribType', query.ribType);
        addFilter('e.legacy_route_key = @legacyRouteKey', 'legacyRouteKey', query.legacyRouteKey || query.routeKey);
        if (query.prefix) {
            params.prefixStart = String(query.prefix);
            params.prefixEnd = `${params.prefixStart}\uffff`;
            where.push('e.prefix >= @prefixStart AND e.prefix < @prefixEnd');
        }
        if (finiteNumber(query.fromMs) !== null) {
            where.push('e.observed_at_ms >= @fromMs');
            params.fromMs = Number(query.fromMs);
        }
        if (finiteNumber(query.toMs) !== null) {
            where.push('e.observed_at_ms <= @toMs');
            params.toMs = Number(query.toMs);
        }
        const countWhereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const countParams = { ...params };
        if (cursor) {
            const cursorObservedAtMs = finiteNumber(cursor.observedAtMs);
            const cursorEventId = finiteNumber(cursor.eventId);
            if (cursorObservedAtMs === null || cursorEventId === null) {
                throw new Error('Invalid BMP persistence events cursor fields');
            }
            where.push('(e.observed_at_ms, e.event_id) < (@cursorObservedAtMs, @cursorEventId)');
            params.cursorObservedAtMs = cursorObservedAtMs;
            params.cursorEventId = cursorEventId;
        }
        const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

        const readSnapshot = this.db.transaction(() => {
            const total = includeTotal
                ? this.db
                      .prepare(
                          `
                      SELECT COUNT(*) AS total
                        FROM bmp_route_events e
                        LEFT JOIN bmp_rib_scopes s ON s.scope_id = e.scope_id
                        ${countWhereSql}
                  `
                      )
                      .get(countParams).total
                : null;
            const rows = this.db
                .prepare(
                    `
                SELECT e.*, src.remote_ip, src.sys_name, s.scope_kind, s.scope_identity_json,
                       e.afi, e.safi, s.rib_type, event_attr.attr_json AS attr_json
                  FROM bmp_route_events e
                  JOIN bmp_sources src ON src.source_id = e.source_id
                  LEFT JOIN bmp_rib_scopes s ON s.scope_id = e.scope_id
                  LEFT JOIN bmp_route_attributes event_attr ON event_attr.attr_id = e.attr_id
                  ${whereSql}
                 ORDER BY e.observed_at_ms DESC, e.event_id DESC
                 LIMIT @limit OFFSET @offset
            `
                )
                .all({ ...params, limit: pageSize + 1, offset: cursor ? 0 : (page - 1) * pageSize });
            return { total, rows };
        });
        const { total, rows } = readSnapshot();
        const hasMore = rows.length > pageSize;
        const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
        const lastRow = pageRows[pageRows.length - 1];

        return {
            list: pageRows.map(row => ({
                eventId: row.event_id,
                sourceId: row.source_id,
                connectionId: row.connection_id,
                sequence: row.source_sequence,
                scopeId: row.scope_id,
                routeId: row.route_id,
                eventType: row.event_type,
                observedAt: new Date(row.observed_at_ms).toISOString(),
                observedAtMs: row.observed_at_ms,
                sourceTimestampMs: row.source_timestamp_ms,
                ribEpoch: row.rib_epoch,
                attrId: row.attr_id,
                reason: row.reason,
                route:
                    row.route_json === null
                        ? null
                        : {
                              ...parseJson(row.route_json, {}),
                              ...parseJson(row.attr_json, {}),
                              attrId: row.attr_id || ''
                          },
                source: { remoteIp: row.remote_ip, sysName: row.sys_name },
                scope: {
                    kind: row.scope_kind,
                    afi: row.afi,
                    safi: row.safi,
                    ribType: row.rib_type,
                    rdRaw: parseJson(row.scope_identity_json, {})?.peer?.rd || null
                }
            })),
            total,
            page,
            pageSize,
            nextCursor:
                hasMore && lastRow
                    ? encodeCursor('events', {
                          observedAtMs: lastRow.observed_at_ms,
                          eventId: lastRow.event_id
                      })
                    : null
        };
    }

    getStatus(options = {}) {
        if (!this.db) {
            this.open();
        }

        const fileSize = fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0;
        const walPath = `${this.dbPath}-wal`;
        const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
        const reclaimableBytes =
            Number(this.db.pragma('freelist_count', { simple: true })) *
            Number(this.db.pragma('page_size', { simple: true }));
        let availableDiskBytes = null;
        try {
            const disk = fs.statfsSync(path.dirname(this.dbPath));
            availableDiskBytes = Number(disk.bavail) * Number(disk.bsize);
        } catch (_error) {
            // Disk availability is advisory and is not supported by every runtime/filesystem.
        }
        const includeCounts = options.includeCounts === true;
        const counts = includeCounts
            ? {
                  sources: this.db.prepare('SELECT COUNT(*) AS count FROM bmp_sources').get().count,
                  connections: this.db.prepare('SELECT COUNT(*) AS count FROM bmp_connections').get().count,
                  scopes: this.db.prepare('SELECT COUNT(*) AS count FROM bmp_rib_scopes').get().count,
                  currentRoutes: this.db.prepare('SELECT COUNT(*) AS count FROM bmp_current_routes').get().count,
                  routeEvents: this.db.prepare('SELECT COUNT(*) AS count FROM bmp_route_events').get().count
              }
            : {
                  sources: null,
                  connections: null,
                  scopes: null,
                  currentRoutes: null,
                  routeEvents: null
              };
        const oldestEvent = this.db
            .prepare('SELECT observed_at_ms FROM bmp_route_events ORDER BY observed_at_ms, event_id LIMIT 1')
            .get();
        return {
            ready: true,
            dbPath: this.dbPath,
            schemaVersion: this.db.pragma('user_version', { simple: true }),
            journalMode: this.db.pragma('journal_mode', { simple: true }),
            fileSize,
            walSize,
            totalSize: fileSize + walSize,
            reclaimableBytes,
            logicalSize: Math.max(0, fileSize + walSize - reclaimableBytes),
            availableDiskBytes,
            oldestEventAtMs: oldestEvent?.observed_at_ms ?? null,
            countsExact: includeCounts,
            ...counts
        };
    }

    sweep(options = {}) {
        if (this.readOnly) {
            throw new Error('Cannot sweep a read-only BMP persistence store');
        }
        if (!this.db) {
            this.open();
        }

        const routeLimit = positiveInteger(options.routeLimit, 2000, 20000);
        const eventLimit = positiveInteger(options.eventLimit, 5000, 50000);
        const auxiliaryLimit = positiveInteger(options.auxiliaryLimit, eventLimit, 50000);
        const staleBeforeMs = finiteNumber(options.staleBeforeMs, Date.now() - 24 * 60 * 60 * 1000);
        const eventsBeforeMs = finiteNumber(options.eventsBeforeMs, Date.now() - 7 * 24 * 60 * 60 * 1000);
        const refreshTimeoutBeforeMs = finiteNumber(options.refreshTimeoutBeforeMs, Date.now() - 10 * 60 * 1000);
        const result = this.db.transaction(() => {
            const routes = this.db
                .prepare(
                    `
                    WITH candidate_scopes(scope_id) AS MATERIALIZED (
                        SELECT scope_id
                          FROM bmp_rib_scopes
                         WHERE cleanup_pending_epoch IS NOT NULL
                        UNION
                        SELECT scope_id
                          FROM bmp_rib_scopes
                         WHERE scope_state = 'syncing'
                           AND refresh_started_ms <= @refreshTimeoutBeforeMs
                        UNION
                        SELECT scope_id
                          FROM bmp_rib_scopes
                         WHERE scope_state IN ('stale', 'down')
                           AND stale_since_ms <= @staleBeforeMs
                    )
                    DELETE FROM bmp_current_routes
                     WHERE (scope_id, route_id) IN (
                         SELECT r.scope_id, r.route_id
                           FROM candidate_scopes candidate
                           JOIN bmp_rib_scopes s ON s.scope_id = candidate.scope_id
                           JOIN bmp_current_routes r ON r.scope_id = candidate.scope_id
                          WHERE (
                              (
                                  (
                                      s.cleanup_pending_epoch >= s.current_epoch
                                      OR (
                                          s.scope_state = 'syncing'
                                          AND s.refresh_started_ms <= @refreshTimeoutBeforeMs
                                      )
                                  )
                                  AND (
                                      r.rib_epoch < s.current_epoch
                                      OR r.connection_id <> s.last_connection_id
                                  )
                              )
                              OR (
                                  s.scope_state IN ('stale', 'down')
                                  AND s.stale_since_ms <= @staleBeforeMs
                              )
                          )
                          ORDER BY r.scope_id, r.route_id
                          LIMIT @routeLimit
                     )
                `
                )
                .run({ staleBeforeMs, refreshTimeoutBeforeMs, routeLimit }).changes;
            const finalizedCleanupScopes = this.db
                .prepare(
                    `
                    UPDATE bmp_rib_scopes AS scope INDEXED BY idx_bmp_scopes_cleanup_pending
                       SET cleanup_pending_epoch = NULL
                     WHERE scope.cleanup_pending_epoch >= scope.current_epoch
                       AND scope.cleanup_pending_epoch IS NOT NULL
                       AND NOT EXISTS (
                           SELECT 1
                             FROM bmp_current_routes route
                            WHERE route.scope_id = scope.scope_id
                              AND (
                                  route.connection_id <> scope.last_connection_id
                                  OR route.rib_epoch < scope.current_epoch
                              )
                       )
                `
                )
                .run().changes;
            const refreshTimeoutScopes = this.db
                .prepare(
                    `
                    UPDATE bmp_rib_scopes AS scope
                       SET scope_state = 'ready', stale_reason = 'refresh-timeout',
                           refresh_started_ms = NULL,
                           updated_at_ms = MAX(updated_at_ms, @finalizedAtMs)
                     WHERE scope.scope_state = 'syncing'
                       AND scope.refresh_started_ms <= @refreshTimeoutBeforeMs
                       AND NOT EXISTS (
                           SELECT 1
                             FROM bmp_current_routes route
                            WHERE route.scope_id = scope.scope_id
                              AND (
                                  route.connection_id <> scope.last_connection_id
                                  OR route.rib_epoch < scope.current_epoch
                              )
                       )
                `
                )
                .run({ refreshTimeoutBeforeMs, finalizedAtMs: Date.now() }).changes;
            const events = this.db
                .prepare(
                    `
                    DELETE FROM bmp_route_events
                     WHERE event_id IN (
                        SELECT event_id FROM bmp_route_events
                          WHERE observed_at_ms <= @eventsBeforeMs
                            AND NOT EXISTS (
                                SELECT 1 FROM bmp_current_routes r
                                 WHERE r.last_event_id = bmp_route_events.event_id
                            )
                          ORDER BY observed_at_ms, event_id
                          LIMIT @eventLimit
                     )
                `
                )
                .run({ eventsBeforeMs, eventLimit }).changes;
            const statistics = this.db
                .prepare(
                    `
                    DELETE FROM bmp_statistics_samples
                     WHERE sample_id IN (
                        SELECT sample_id FROM bmp_statistics_samples
                         WHERE observed_at_ms <= @eventsBeforeMs
                           AND NOT EXISTS (
                               SELECT 1 FROM bmp_statistics_latest latest
                                WHERE latest.sample_id = bmp_statistics_samples.sample_id
                           )
                         ORDER BY observed_at_ms, sample_id
                         LIMIT @auxiliaryLimit
                     )
                `
                )
                .run({ eventsBeforeMs, auxiliaryLimit }).changes;
            const batches = this.db
                .prepare(
                    `
                    DELETE FROM bmp_ingest_batches
                     WHERE batch_id IN (
                        SELECT batch_id FROM bmp_ingest_batches
                         WHERE created_at_ms <= @eventsBeforeMs
                         ORDER BY created_at_ms
                         LIMIT @auxiliaryLimit
                     )
                `
                )
                .run({ eventsBeforeMs, auxiliaryLimit }).changes;
            const attributes = this.db
                .prepare(
                    `
                    DELETE FROM bmp_route_attributes
                     WHERE attr_id IN (
                        SELECT attr.attr_id
                          FROM bmp_route_attributes attr
                         WHERE attr.last_seen_ms <= @eventsBeforeMs
                           AND NOT EXISTS (
                               SELECT 1 FROM bmp_current_routes route
                                WHERE route.attr_id = attr.attr_id
                           )
                           AND NOT EXISTS (
                               SELECT 1 FROM bmp_route_events event
                                WHERE event.attr_id = attr.attr_id
                           )
                         ORDER BY attr.last_seen_ms
                         LIMIT @auxiliaryLimit
                     )
                `
                )
                .run({ eventsBeforeMs, auxiliaryLimit }).changes;
            return {
                routes,
                events,
                statistics,
                batches,
                attributes,
                finalizedCleanupScopes,
                refreshTimeoutScopes,
                effectiveLimits: { routeLimit, eventLimit, auxiliaryLimit },
                hasMore:
                    routes >= routeLimit ||
                    events >= eventLimit ||
                    statistics >= auxiliaryLimit ||
                    batches >= auxiliaryLimit ||
                    attributes >= auxiliaryLimit
            };
        })();
        return result;
    }

    checkpoint(mode = 'PASSIVE') {
        if (!this.db || this.readOnly) {
            return null;
        }
        const normalized = String(mode).toUpperCase();
        if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(normalized)) {
            throw new Error(`Unsupported SQLite checkpoint mode: ${mode}`);
        }
        return this.db.pragma(`wal_checkpoint(${normalized})`);
    }

    close() {
        if (!this.db) {
            return;
        }
        if (!this.readOnly) {
            this.checkpoint('PASSIVE');
        }
        this.db.close();
        this.db = null;
        this.statements = null;
        this.sqlTrace = null;
    }
}

BmpPersistenceStore.SCHEMA_VERSION = SCHEMA_VERSION;

module.exports = BmpPersistenceStore;
