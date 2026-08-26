const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const ipaddr = require('ipaddr.js');
const { getAddrFamilyType } = require('../../utils/bgpUtils');
const { getSessionStatisticsReportIdentityParts } = require('../../utils/bmpStatistics');
const logger = require('../../log/logger');
const { installBmpSqlTrace } = require('./bmpSqlTrace');
const { rebuildCompactNlri } = require('./bmpPersistenceMutation');
const {
    BMP_ROUTE_FAMILIES,
    BMP_ROUTE_PARTITIONS,
    resolveBmpRoutePartition,
    getBmpRoutePartitionById,
    selectBmpRoutePartitions,
    assertBmpRouteMatchesScope
} = require('./bmpRoutePartitionManifest');

const SCHEMA_VERSION = 13;
const ROUTE_KEY_ALGORITHM = 'sha256';
const DEFAULT_PAGE_SIZE = 100;
const GC_KIND = Object.freeze({ IDENTITY: 1, PAYLOAD: 2, ATTRIBUTE: 3 });
// Rows per multi-row INSERT in prefillRouteObjectCaches (14 columns x 250 =
// 3,500 bound parameters, well under SQLite's default limit).
const BULK_ROWS = 250;
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

function storedNlriDetail(row) {
    if (row.nlri_json) {
        return parseJson(row.nlri_json, {});
    }
    if (row.prefix === null || row.prefix === undefined) {
        return {};
    }
    return rebuildCompactNlri({
        prefix: row.prefix,
        prefixLength: row.prefix_length,
        pathId: row.path_id,
        rd: row.rd,
        flags: Number(row.nlri_flags) || 0
    });
}

function buildStoredRouteProjection(row, options = {}) {
    const nlriDetail = storedNlriDetail(row);
    const payload = parseJson(options.routeJson ?? row.route_json, {});
    const attributes = parseJson(options.attrJson ?? row.attr_json, {});
    const routeTlvs = Array.isArray(payload.routeTlvs) ? payload.routeTlvs : [];
    return {
        routeKey: row.legacy_route_key || null,
        addrFamilyType: getAddrFamilyType(Number(row.afi), Number(row.safi)),
        afi: Number(row.afi),
        safi: Number(row.safi),
        ip: row.prefix || null,
        mask: finiteNumber(row.prefix_length),
        rd: row.rd || null,
        rdRaw: payload.rdRaw ?? nlriDetail?.rdRaw ?? null,
        pathId: finiteNumber(row.path_id, 0),
        labels: null,
        routeType: nlriDetail?.routeType ?? null,
        rawNlri: nlriDetail?.rawNlri ?? null,
        nlriDetail,
        parseStatus: 0,
        pathStatus: null,
        pathStatusNames: [],
        pathStatusText: null,
        pathStatusUnknownBits: 0,
        pathStatusReason: null,
        pathStatusReasonName: null,
        pathStatusReasonText: null,
        pathStatusReasons: [],
        routeTlvs,
        routeTlvCount: routeTlvs.length,
        ...payload,
        ...attributes,
        attrId: row.attr_id || ''
    };
}

// Inverse of BmpPersistenceClient.encodeBatchMutations(): descriptors that
// were sent once per batch are attached back to every mutation.
function decodeBatchMutations(batch) {
    const mutations = Array.isArray(batch?.mutations) ? batch.mutations : [];
    const refs = batch?.refs;
    if (!refs || typeof refs !== 'object') {
        return mutations;
    }
    const sources = Array.isArray(refs.sources) ? refs.sources : [];
    const connections = Array.isArray(refs.connections) ? refs.connections : [];
    const scopes = Array.isArray(refs.scopes) ? refs.scopes : [];
    return mutations.map(mutation => {
        if (!mutation || typeof mutation !== 'object') {
            return mutation;
        }
        if (
            mutation.sourceRef === undefined &&
            mutation.connectionRef === undefined &&
            mutation.scopeRef === undefined
        ) {
            return mutation;
        }
        const decoded = { ...mutation };
        if (mutation.sourceRef !== undefined) {
            decoded.source = sources[mutation.sourceRef];
            delete decoded.sourceRef;
        }
        if (mutation.connectionRef !== undefined) {
            decoded.connection = connections[mutation.connectionRef];
            delete decoded.connectionRef;
        }
        if (mutation.scopeRef !== undefined) {
            decoded.scope = scopes[mutation.scopeRef];
            delete decoded.scopeRef;
        }
        return decoded;
    });
}

function buildCanonicalRouteKey(routeId, keyVersion) {
    if (!routeId) {
        return null;
    }
    return { schemaVersion: finiteNumber(keyVersion, 1), algorithm: ROUTE_KEY_ALGORITHM, keyHex: routeId };
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
        return {
            kind: 'session',
            key: JSON.stringify(getSessionStatisticsReportIdentityParts(report).map(stringifyPart))
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

function sha256Buffer(value) {
    return crypto
        .createHash('sha256')
        .update(String(value ?? ''), 'utf8')
        .digest();
}

function buildExpandedPartitionSelect(partition) {
    return `SELECT current.partition_id, current.path_pk, current.scope_pk,
                   current.route_pk AS route_pk, identity.route_id,
                   identity.route_key_version,
                   identity.legacy_route_key, identity.afi, identity.safi,
                   identity.path_id, identity.rd, identity.prefix, identity.prefix_length,
                   identity.nlri_kind, identity.nlri_json, identity.nlri_flags,
                   current.payload_id, payload.route_json,
                   current.attr_pk, current.connection_pk, current.rib_epoch,
                   current.explicit_state, current.first_seen_ms, current.last_seen_ms,
                   current.source_timestamp_ms, current.last_sequence
              FROM ${partition.quotedTableName} current
              JOIN bmp_route_identities identity ON identity.route_pk = current.route_pk
              JOIN bmp_route_payloads payload ON payload.payload_id = current.payload_id`;
}

function buildExpandedCurrentRoutesSql(partitions = BMP_ROUTE_PARTITIONS) {
    if (!Array.isArray(partitions) || partitions.length === 0) {
        return `SELECT NULL AS partition_id, NULL AS path_pk, NULL AS scope_pk,
                       NULL AS route_pk, NULL AS route_id,
                       NULL AS route_key_version,
                       NULL AS legacy_route_key, NULL AS afi, NULL AS safi,
                       NULL AS path_id, NULL AS rd, NULL AS prefix, NULL AS prefix_length,
                       NULL AS nlri_kind, NULL AS nlri_json, NULL AS nlri_flags, NULL AS payload_id,
                       NULL AS route_json, NULL AS attr_pk, NULL AS connection_pk,
                       NULL AS rib_epoch, NULL AS explicit_state, NULL AS first_seen_ms,
                       NULL AS last_seen_ms, NULL AS source_timestamp_ms, NULL AS last_sequence
                 WHERE 0`;
    }
    return partitions.map(buildExpandedPartitionSelect).join('\nUNION ALL\n');
}

// Lightweight union of every partition's reference columns. Garbage collection
// of identities, payloads, and attributes probes this view instead of the fully
// expanded read view so each arm is a plain index lookup without joins.
function buildCurrentRouteRefsSql(partitions = BMP_ROUTE_PARTITIONS) {
    return partitions
        .map(partition => `SELECT scope_pk, route_pk, payload_id, attr_pk FROM ${partition.quotedTableName}`)
        .join('\nUNION ALL\n');
}

function buildKnownFamilyPredicate(alias = 'identity') {
    return BMP_ROUTE_FAMILIES.filter(family => family.fallback !== true)
        .map(family => `(${alias}.afi = ${family.afi} AND ${alias}.safi = ${family.safi})`)
        .join(' OR ');
}

function buildScopePartitionPredicate(alias = 'NEW') {
    return BMP_ROUTE_PARTITIONS.map(partition => {
        const familyPredicate = partition.fallback
            ? `NOT (${buildKnownFamilyPredicate(alias)})`
            : `${alias}.afi = ${partition.afi} AND ${alias}.safi = ${partition.safi}`;
        return `(${alias}.partition_id = ${partition.partitionId}
            AND ${alias}.scope_kind = '${partition.scopeKind}'
            AND ${familyPredicate})`;
    }).join(' OR ');
}

function buildPartitionDdl(partition) {
    const table = partition.quotedTableName;
    const token = partition.tableName;
    const familyPredicate = partition.fallback
        ? `NOT (${buildKnownFamilyPredicate('identity')})`
        : `identity.afi = ${partition.afi} AND identity.safi = ${partition.safi}`;
    const bucketChanged = `(
        OLD.connection_pk IS NOT NEW.connection_pk
        OR OLD.rib_epoch IS NOT NEW.rib_epoch
        OR OLD.explicit_state IS NOT NEW.explicit_state
    )`;
    return `
        CREATE TABLE ${table} (
            path_pk INTEGER PRIMARY KEY,
            partition_id INTEGER NOT NULL DEFAULT ${partition.partitionId}
                CHECK(partition_id = ${partition.partitionId}),
            scope_pk INTEGER NOT NULL,
            route_pk INTEGER NOT NULL,
            payload_id INTEGER NOT NULL,
            attr_pk INTEGER,
            connection_pk INTEGER NOT NULL,
            rib_epoch INTEGER NOT NULL,
            explicit_state TEXT NOT NULL DEFAULT 'active',
            first_seen_ms INTEGER NOT NULL,
            last_seen_ms INTEGER NOT NULL,
            source_timestamp_ms INTEGER,
            last_sequence INTEGER NOT NULL,
            UNIQUE(scope_pk, route_pk),
            FOREIGN KEY (scope_pk, partition_id)
                REFERENCES bmp_rib_scopes(scope_pk, partition_id) ON DELETE CASCADE,
            FOREIGN KEY (route_pk) REFERENCES bmp_route_identities(route_pk),
            FOREIGN KEY (payload_id) REFERENCES bmp_route_payloads(payload_id),
            FOREIGN KEY (attr_pk) REFERENCES bmp_route_attributes(attr_pk),
            FOREIGN KEY (connection_pk) REFERENCES bmp_connections(connection_pk)
        );

        CREATE INDEX idx_${token}_scope_first_seen
            ON ${table}(scope_pk, first_seen_ms, path_pk);
        CREATE INDEX idx_${token}_scope_epoch
            ON ${table}(scope_pk, connection_pk, rib_epoch, path_pk);
        CREATE INDEX idx_${token}_route
            ON ${table}(route_pk, scope_pk);
        CREATE INDEX idx_${token}_attr
            ON ${table}(attr_pk);
        CREATE INDEX idx_${token}_payload
            ON ${table}(payload_id);

        CREATE TRIGGER trg_${token}_validate_insert
        BEFORE INSERT ON ${table}
        BEGIN
            SELECT CASE WHEN NOT EXISTS (
                SELECT 1
                  FROM bmp_route_identities identity
                  JOIN bmp_rib_scopes scope ON scope.scope_pk = NEW.scope_pk
                 WHERE identity.route_pk = NEW.route_pk
                   AND scope.partition_id = ${partition.partitionId}
                   AND scope.scope_kind = '${partition.scopeKind}'
                   AND scope.afi = identity.afi
                   AND scope.safi = identity.safi
                   AND ${familyPredicate}
            ) THEN RAISE(ABORT, 'BMP route identity does not match target partition') END;
        END;

        CREATE TRIGGER trg_${token}_validate_update
        BEFORE UPDATE OF scope_pk, partition_id, route_pk ON ${table}
        WHEN OLD.scope_pk IS NOT NEW.scope_pk
          OR OLD.partition_id IS NOT NEW.partition_id
          OR OLD.route_pk IS NOT NEW.route_pk
        BEGIN
            SELECT RAISE(ABORT, 'BMP current route scope, partition, and identity are immutable');
        END;

        CREATE TRIGGER trg_${token}_insert_refs
        AFTER INSERT ON ${table}
        BEGIN
            INSERT INTO bmp_scope_route_counts(
                scope_pk, connection_pk, rib_epoch, explicit_state, route_count
            ) VALUES (
                NEW.scope_pk, NEW.connection_pk, NEW.rib_epoch, NEW.explicit_state, 1
            )
            ON CONFLICT(scope_pk, connection_pk, rib_epoch, explicit_state)
            DO UPDATE SET route_count = route_count + 1;
        END;

        CREATE TRIGGER trg_${token}_delete_refs
        AFTER DELETE ON ${table}
        BEGIN
            UPDATE bmp_scope_route_counts
               SET route_count = route_count - 1
             WHERE scope_pk = OLD.scope_pk
               AND connection_pk = OLD.connection_pk
               AND rib_epoch = OLD.rib_epoch
               AND explicit_state = OLD.explicit_state;
            DELETE FROM bmp_scope_route_counts
             WHERE scope_pk = OLD.scope_pk
               AND connection_pk = OLD.connection_pk
               AND rib_epoch = OLD.rib_epoch
               AND explicit_state = OLD.explicit_state
               AND route_count = 0;
        END;

        CREATE TRIGGER trg_${token}_update_refs
        AFTER UPDATE OF connection_pk, rib_epoch, explicit_state ON ${table}
        WHEN ${bucketChanged}
        BEGIN
            UPDATE bmp_scope_route_counts
               SET route_count = route_count - 1
             WHERE scope_pk = OLD.scope_pk
               AND connection_pk = OLD.connection_pk
               AND rib_epoch = OLD.rib_epoch
               AND explicit_state = OLD.explicit_state;
            DELETE FROM bmp_scope_route_counts
             WHERE scope_pk = OLD.scope_pk
               AND connection_pk = OLD.connection_pk
               AND rib_epoch = OLD.rib_epoch
               AND explicit_state = OLD.explicit_state
               AND route_count = 0;
            INSERT INTO bmp_scope_route_counts(
                scope_pk, connection_pk, rib_epoch, explicit_state, route_count
            ) VALUES (NEW.scope_pk, NEW.connection_pk, NEW.rib_epoch, NEW.explicit_state, 1)
            ON CONFLICT(scope_pk, connection_pk, rib_epoch, explicit_state)
            DO UPDATE SET route_count = route_count + 1;
        END;
    `;
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
        this.partitionStatements = null;
        this.bulkStatements = new Map();
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
            // Foreign keys stay declared in the DDL (they document the model and
            // `PRAGMA foreign_key_check` still verifies them), but the writer does
            // not enforce them: every referenced row is created by the same batch
            // and the checks cost one index probe per reference per path. The
            // former ON DELETE CASCADE paths are deleted explicitly (purgeSource).
            this.db.pragma('foreign_keys = OFF');

            if (!this.readOnly) {
                this.db.pragma('journal_mode = WAL');
                // BMP data is a projection that peers re-send on reconnect, and a
                // damaged database is rebuilt on open, so commits do not wait for
                // the disk. A process crash loses nothing; an OS crash or power
                // loss may lose the last seconds of writes.
                this.db.pragma('synchronous = OFF');
                this.db.pragma('temp_store = MEMORY');
                // Route ingest touches ~20 B-tree indexes per mutation; keep the
                // hot index pages resident instead of re-reading them from the
                // OS cache on every batch.
                this.db.pragma('cache_size = -65536');
                this.db.pragma('wal_autocheckpoint = 2000');
                this.migrate();
                this.validateReadableSchema();
                this.db.exec(`
                    CREATE TEMP TABLE IF NOT EXISTS bmp_gc_candidates (
                        kind INTEGER NOT NULL,
                        pk INTEGER NOT NULL,
                        PRIMARY KEY (kind, pk)
                    ) WITHOUT ROWID
                `);
                this.recoverInterruptedConnections();
                this.prepareStatements();
            } else {
                // Readers scan large ranges (route pages, the Route Assurance
                // stream); mapping the file avoids a copy per page read.
                this.db.pragma('mmap_size = 268435456');
                this.validateReadableSchema();
            }
        } catch (error) {
            this.db.close();
            this.db = null;
            this.statements = null;
            this.partitionStatements = null;
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
                    ? 'BMP_PERSISTENCE_SCHEMA_INCOMPATIBLE'
                    : 'BMP_PERSISTENCE_SCHEMA_TOO_NEW';
            throw error;
        }
        const requiredSchema = {
            bmp_sources: ['source_pk', 'source_id', 'source_identity_json'],
            bmp_connections: [
                'connection_pk',
                'connection_id',
                'source_pk',
                'connection_generation',
                'connection_state',
                'last_sequence'
            ],
            bmp_rib_scopes: [
                'scope_pk',
                'scope_id',
                'source_pk',
                'partition_id',
                'current_epoch',
                'refresh_started_ms',
                'cleanup_pending_epoch',
                'last_connection_pk'
            ],
            bmp_scope_route_counts: ['scope_pk', 'connection_pk', 'rib_epoch', 'explicit_state', 'route_count'],
            bmp_route_identities: ['route_pk', 'route_id', 'route_key_version', 'afi', 'safi', 'nlri_flags'],
            bmp_route_payloads: ['payload_id', 'payload_hash', 'route_json'],
            bmp_route_attributes: ['attr_pk', 'attr_id', 'attr_json'],
            bmp_ingest_batches: ['batch_id', 'created_at_ms'],
            bmp_statistics_samples: ['sample_id', 'source_id', 'report_kind', 'report_key', 'statistics_json'],
            bmp_statistics_latest: ['source_id', 'report_kind', 'report_key', 'sample_id', 'observed_at_ms']
        };
        BMP_ROUTE_PARTITIONS.forEach(partition => {
            requiredSchema[partition.tableName] = [
                'path_pk',
                'partition_id',
                'scope_pk',
                'route_pk',
                'payload_id',
                'attr_pk',
                'connection_pk',
                'rib_epoch',
                'last_sequence'
            ];
        });
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
        const unifiedView = this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'bmp_current_routes_all'")
            .get();
        if (!unifiedView) {
            throw new Error('BMP persistence schema is missing required view bmp_current_routes_all');
        }
    }

    // The persisted schema is an implementation detail of this build. Whenever
    // the stored user_version differs from SCHEMA_VERSION (older, newer, or a
    // non-empty file without a version) the writer drops every object and
    // recreates the schema instead of attempting a migration. BMP data is a
    // projection of what peers re-send on reconnect, so starting empty is the
    // supported upgrade path.
    migrate() {
        const currentVersion = this.db.pragma('user_version', { simple: true });
        const existingObjects = this.db
            .prepare(
                `SELECT type, name
                   FROM sqlite_master
                  WHERE name NOT LIKE 'sqlite_%'
                  ORDER BY type, name`
            )
            .all();
        if (currentVersion === SCHEMA_VERSION) {
            try {
                this.validateReadableSchema();
                return { reset: false, previousVersion: currentVersion };
            } catch (error) {
                logger.warn(`BMP persistence schema ${currentVersion} is damaged (${error.message}); rebuilding`);
            }
        }
        const needsReset = currentVersion !== SCHEMA_VERSION || existingObjects.length > 0;
        if (needsReset && existingObjects.length > 0) {
            logger.warn(
                `BMP persistence schema ${currentVersion} does not match schema ${SCHEMA_VERSION}; ` +
                    `dropping ${existingObjects.length} existing objects and rebuilding the database`
            );
            this.dropAllObjects(existingObjects);
        }

        const initialize = this.db.transaction(() => {
            this.db.exec(`
                CREATE TABLE bmp_sources (
                    source_pk INTEGER PRIMARY KEY,
                    source_id TEXT NOT NULL UNIQUE,
                    source_key_json TEXT NOT NULL,
                    source_identity_json TEXT NOT NULL,
                    remote_ip TEXT,
                    sys_name TEXT,
                    sys_desc TEXT,
                    first_seen_ms INTEGER NOT NULL,
                    last_seen_ms INTEGER NOT NULL,
                    metadata_json TEXT
                );

                CREATE TABLE bmp_connections (
                    connection_pk INTEGER PRIMARY KEY,
                    connection_id TEXT NOT NULL UNIQUE,
                    source_pk INTEGER NOT NULL,
                    connection_generation INTEGER NOT NULL,
                    local_ip TEXT,
                    local_port INTEGER,
                    remote_ip TEXT,
                    remote_port INTEGER,
                    opened_at_ms INTEGER NOT NULL,
                    closed_at_ms INTEGER,
                    close_reason TEXT,
                    connection_state TEXT NOT NULL,
                    last_sequence INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (source_pk) REFERENCES bmp_sources(source_pk)
                );

                CREATE INDEX idx_bmp_connections_source_time
                    ON bmp_connections(source_pk, opened_at_ms DESC);

                CREATE TABLE bmp_rib_scopes (
                    scope_pk INTEGER PRIMARY KEY,
                    scope_id TEXT NOT NULL UNIQUE,
                    source_pk INTEGER NOT NULL,
                    partition_id INTEGER NOT NULL,
                    scope_key_json TEXT NOT NULL,
                    scope_identity_json TEXT NOT NULL,
                    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('peer', 'loc-rib')),
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
                    last_connection_pk INTEGER,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    UNIQUE(scope_pk, partition_id),
                    FOREIGN KEY (source_pk) REFERENCES bmp_sources(source_pk),
                    FOREIGN KEY (last_connection_pk) REFERENCES bmp_connections(connection_pk)
                );

                CREATE INDEX idx_bmp_scopes_source_af
                    ON bmp_rib_scopes(source_pk, afi, safi, rib_type);
                CREATE INDEX idx_bmp_scopes_state
                    ON bmp_rib_scopes(scope_state, updated_at_ms);
                CREATE INDEX idx_bmp_scopes_stale_since
                    ON bmp_rib_scopes(scope_state, stale_since_ms, scope_pk);
                CREATE INDEX idx_bmp_scopes_refresh_since
                    ON bmp_rib_scopes(scope_state, refresh_started_ms, scope_pk);
                CREATE INDEX idx_bmp_scopes_cleanup_pending
                    ON bmp_rib_scopes(cleanup_pending_epoch, scope_pk);
                CREATE INDEX idx_bmp_scopes_connection
                    ON bmp_rib_scopes(last_connection_pk, scope_pk);

                CREATE TRIGGER trg_bmp_rib_scopes_validate_partition_insert
                BEFORE INSERT ON bmp_rib_scopes
                WHEN NOT (${buildScopePartitionPredicate('NEW')})
                BEGIN
                    SELECT RAISE(ABORT, 'BMP scope does not match its route partition');
                END;

                CREATE TRIGGER trg_bmp_rib_scopes_validate_partition_update
                BEFORE UPDATE OF partition_id, scope_kind, afi, safi ON bmp_rib_scopes
                WHEN NOT (${buildScopePartitionPredicate('NEW')})
                BEGIN
                    SELECT RAISE(ABORT, 'BMP scope does not match its route partition');
                END;

                CREATE TABLE bmp_scope_route_counts (
                    scope_pk INTEGER NOT NULL,
                    connection_pk INTEGER NOT NULL,
                    rib_epoch INTEGER NOT NULL,
                    explicit_state TEXT NOT NULL,
                    route_count INTEGER NOT NULL CHECK(route_count >= 0),
                    PRIMARY KEY (scope_pk, connection_pk, rib_epoch, explicit_state),
                    FOREIGN KEY (scope_pk) REFERENCES bmp_rib_scopes(scope_pk) ON DELETE CASCADE,
                    FOREIGN KEY (connection_pk) REFERENCES bmp_connections(connection_pk)
                ) WITHOUT ROWID;

                CREATE INDEX idx_bmp_scope_route_counts_connection
                    ON bmp_scope_route_counts(connection_pk, scope_pk);

                CREATE TABLE bmp_route_attributes (
                    attr_pk INTEGER PRIMARY KEY,
                    attr_id TEXT NOT NULL UNIQUE,
                    attr_json TEXT NOT NULL,
                    first_seen_ms INTEGER NOT NULL,
                    last_seen_ms INTEGER NOT NULL
                );

                CREATE TABLE bmp_route_identities (
                    route_pk INTEGER PRIMARY KEY,
                    route_id TEXT NOT NULL UNIQUE,
                    route_key_version INTEGER NOT NULL,
                    legacy_route_key TEXT,
                    afi INTEGER NOT NULL,
                    safi INTEGER NOT NULL,
                    path_id INTEGER NOT NULL,
                    rd TEXT,
                    prefix TEXT,
                    prefix_length INTEGER,
                    nlri_kind TEXT,
                    nlri_json TEXT,
                    nlri_flags INTEGER NOT NULL DEFAULT 0,
                    first_seen_ms INTEGER NOT NULL,
                    last_seen_ms INTEGER NOT NULL
                );

                CREATE INDEX idx_bmp_route_identities_prefix
                    ON bmp_route_identities(prefix, prefix_length, route_pk);
                CREATE INDEX idx_bmp_route_identities_legacy
                    ON bmp_route_identities(legacy_route_key, route_pk);

                CREATE TABLE bmp_route_payloads (
                    payload_id INTEGER PRIMARY KEY,
                    payload_hash BLOB NOT NULL UNIQUE,
                    route_json TEXT NOT NULL,
                    first_seen_ms INTEGER NOT NULL,
                    last_seen_ms INTEGER NOT NULL
                );

                CREATE TABLE bmp_ingest_batches (
                    batch_id TEXT PRIMARY KEY,
                    created_at_ms INTEGER NOT NULL,
                    mutation_count INTEGER NOT NULL
                ) WITHOUT ROWID;

                CREATE INDEX idx_bmp_ingest_batches_created
                    ON bmp_ingest_batches(created_at_ms);

                CREATE TABLE bmp_statistics_samples (
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

                CREATE INDEX idx_bmp_statistics_scope_time
                    ON bmp_statistics_samples(scope_id, observed_at_ms DESC);
                CREATE INDEX idx_bmp_statistics_observed
                    ON bmp_statistics_samples(observed_at_ms, sample_id);
                CREATE INDEX idx_bmp_statistics_report_time
                    ON bmp_statistics_samples(
                        source_id, report_kind, report_key, observed_at_ms DESC, sample_id DESC
                    );
                CREATE INDEX idx_bmp_statistics_connection
                    ON bmp_statistics_samples(connection_id, sample_id);

                CREATE TABLE bmp_statistics_latest (
                    source_id TEXT NOT NULL,
                    report_kind TEXT NOT NULL CHECK(report_kind IN ('session', 'instance')),
                    report_key TEXT NOT NULL,
                    sample_id INTEGER NOT NULL,
                    observed_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (source_id, report_kind, report_key),
                    FOREIGN KEY (source_id) REFERENCES bmp_sources(source_id),
                    FOREIGN KEY (sample_id) REFERENCES bmp_statistics_samples(sample_id)
                ) WITHOUT ROWID;

                CREATE INDEX idx_bmp_statistics_latest_sample
                    ON bmp_statistics_latest(sample_id);

                ${BMP_ROUTE_PARTITIONS.map(buildPartitionDdl).join('\n')}

                CREATE VIEW bmp_current_routes_all AS
                ${buildExpandedCurrentRoutesSql()};

                CREATE VIEW bmp_current_route_refs AS
                ${buildCurrentRouteRefsSql()};
            `);
            this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
            this.validateReadableSchema();
        });
        initialize.immediate();
        if (existingObjects.length > 0) {
            // Reclaim the space held by the dropped tables of the previous schema.
            this.db.exec('VACUUM');
        }
        return { reset: existingObjects.length > 0, previousVersion: currentVersion };
    }

    dropAllObjects(existingObjects) {
        // Foreign keys are already off for the writer; make it explicit here
        // because SQLite would otherwise run an implicit DELETE on DROP TABLE
        // that trips the constraints of the schema being removed.
        this.db.pragma('foreign_keys = OFF');
        {
            const drop = this.db.transaction(() => {
                const order = { trigger: 0, view: 1, index: 2, table: 3 };
                [...existingObjects]
                    .sort((left, right) => order[left.type] - order[right.type])
                    .forEach(object => {
                        if (object.type === 'index' && object.name.startsWith('sqlite_')) {
                            return;
                        }
                        this.db.exec(`DROP ${object.type.toUpperCase()} IF EXISTS "${object.name}"`);
                    });
                this.db.pragma('user_version = 0');
            });
            drop.immediate();
        }
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
                     WHERE last_connection_pk IN (
                         SELECT connection_pk
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
            bmp_rib_scopes.last_connection_pk IS NOT excluded.last_connection_pk
            AND (
                COALESCE((
                    SELECT connection_generation
                      FROM bmp_connections
                     WHERE connection_pk = excluded.last_connection_pk
                ), 0) > COALESCE((
                    SELECT connection_generation
                      FROM bmp_connections
                     WHERE connection_pk = bmp_rib_scopes.last_connection_pk
                ), 0)
                OR (
                    COALESCE((
                        SELECT connection_state
                          FROM bmp_connections
                         WHERE connection_pk = bmp_rib_scopes.last_connection_pk
                    ), 'closed') = 'closed'
                    AND COALESCE((
                        SELECT connection_state
                          FROM bmp_connections
                         WHERE connection_pk = excluded.last_connection_pk
                    ), 'closed') = 'open'
                )
            )
        )`;
        const acceptsScopeConnection = `(
            bmp_rib_scopes.last_connection_pk IS excluded.last_connection_pk
            OR ${replacesScopeConnection}
        )`;
        const acceptsScopeProgress = `(
            (
                ${replacesScopeConnection}
                OR (
                    bmp_rib_scopes.last_connection_pk IS excluded.last_connection_pk
                    AND excluded.current_epoch >= bmp_rib_scopes.current_epoch
                )
            )
            AND NOT (
                @scopeTimeout = 1
                AND COALESCE(bmp_rib_scopes.eor_epoch, -1) >= bmp_rib_scopes.current_epoch
            )
        )`;
        this.statements = {
            findScopePartition: this.db.prepare(`
                SELECT scope_pk, source_pk, partition_id, scope_kind, afi, safi
                  FROM bmp_rib_scopes
                 WHERE scope_id = @scopeId
                 LIMIT 1
            `),
            findSourcePk: this.db.prepare('SELECT source_pk FROM bmp_sources WHERE source_id = @sourceId LIMIT 1'),
            findConnectionPk: this.db.prepare(
                'SELECT connection_pk FROM bmp_connections WHERE connection_id = @connectionId LIMIT 1'
            ),
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
                RETURNING source_pk
            `),
            upsertConnection: this.db.prepare(`
                INSERT INTO bmp_connections(
                    connection_id, source_pk, connection_generation, local_ip, local_port, remote_ip, remote_port,
                    opened_at_ms, connection_state
                ) VALUES (
                    @id, @sourcePk, @generation, @localIp, @localPort, @remoteIp, @remotePort,
                    @openedAtMs, 'open'
                )
                ON CONFLICT(connection_id) DO UPDATE SET
                    source_pk = excluded.source_pk,
                    local_ip = COALESCE(excluded.local_ip, bmp_connections.local_ip),
                    local_port = COALESCE(excluded.local_port, bmp_connections.local_port),
                    remote_ip = COALESCE(excluded.remote_ip, bmp_connections.remote_ip),
                    remote_port = COALESCE(excluded.remote_port, bmp_connections.remote_port)
                RETURNING connection_pk, last_sequence
            `),
            // Replay protection: mutations arrive in source_sequence order per
            // connection, so a mutation at or below the connection's committed
            // sequence has already been applied.
            advanceConnectionSequence: this.db.prepare(`
                UPDATE bmp_connections
                   SET last_sequence = @sequence
                 WHERE connection_pk = @connectionPk AND last_sequence < @sequence
            `),
            closeConnection: this.db.prepare(`
                UPDATE bmp_connections
                   SET connection_state = 'closed', closed_at_ms = @eventAtMs, close_reason = @reason
                 WHERE connection_pk = @connectionPk
            `),
            closeConnectionScopes: this.db.prepare(`
                UPDATE bmp_rib_scopes
                   SET scope_state = 'down', stale_reason = @reason,
                       stale_since_ms = COALESCE(stale_since_ms, @eventAtMs),
                       refresh_started_ms = NULL, cleanup_pending_epoch = NULL,
                       updated_at_ms = MAX(updated_at_ms, @eventAtMs)
                 WHERE last_connection_pk = @connectionPk
            `),
            upsertScope: this.db.prepare(`
                INSERT INTO bmp_rib_scopes(
                    scope_id, source_pk, partition_id, scope_key_json, scope_identity_json, scope_kind, owner_key,
                    peer_type, peer_rd, peer_ip, peer_as, vrf_name, afi, safi, rib_type,
                    current_epoch, scope_state, stale_reason, stale_since_ms, refresh_started_ms,
                    cleanup_pending_epoch, last_connection_pk,
                    created_at_ms, updated_at_ms
                ) VALUES (
                    @id, @sourcePk, @partitionId, @keyJson, @identityJson, @kind, @ownerKey,
                    @peerType, @peerRd, @peerIp, @peerAs, @vrfName, @afi, @safi, @ribType,
                    @epoch, @state, @reason, @staleSinceMs, @refreshStartedMs, NULL, @connectionPk,
                    @eventAtMs, @eventAtMs
                )
                ON CONFLICT(scope_id) DO UPDATE SET
                    current_epoch = CASE
                        WHEN ${replacesScopeConnection}
                        THEN excluded.current_epoch
                        WHEN bmp_rib_scopes.last_connection_pk IS excluded.last_connection_pk
                        THEN MAX(bmp_rib_scopes.current_epoch, excluded.current_epoch)
                        ELSE bmp_rib_scopes.current_epoch
                    END,
                    eor_epoch = CASE
                        WHEN ${replacesScopeConnection}
                          OR (
                              bmp_rib_scopes.last_connection_pk IS excluded.last_connection_pk
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
                    last_connection_pk = CASE
                        WHEN ${acceptsScopeConnection} THEN excluded.last_connection_pk
                        ELSE bmp_rib_scopes.last_connection_pk
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
                WHERE bmp_rib_scopes.partition_id = excluded.partition_id
                  AND bmp_rib_scopes.source_pk = excluded.source_pk
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
                 WHERE scope_pk = @scopePk AND last_connection_pk = @connectionPk
                   AND current_epoch = @epoch
            `),
            markScopeTimeout: this.db.prepare(`
                UPDATE bmp_rib_scopes
                   SET scope_state = 'ready', stale_reason = 'refresh-timeout', stale_since_ms = NULL,
                       refresh_started_ms = NULL, cleanup_pending_epoch = @epoch,
                       updated_at_ms = MAX(updated_at_ms, @eventAtMs)
                 WHERE scope_pk = @scopePk AND last_connection_pk = @connectionPk
                   AND current_epoch = @epoch
                   AND COALESCE(eor_epoch, -1) < current_epoch
            `),
            upsertAttribute: this.db.prepare(`
                INSERT INTO bmp_route_attributes(attr_id, attr_json, first_seen_ms, last_seen_ms)
                VALUES (@id, @attrJson, @eventAtMs, @eventAtMs)
                ON CONFLICT(attr_id) DO UPDATE SET
                    last_seen_ms = MAX(bmp_route_attributes.last_seen_ms, excluded.last_seen_ms)
                RETURNING attr_pk
            `),
            upsertRouteIdentity: this.db.prepare(`
                INSERT INTO bmp_route_identities(
                    route_id, route_key_version,
                    legacy_route_key, afi, safi, path_id, rd, prefix, prefix_length,
                    nlri_kind, nlri_json, nlri_flags, first_seen_ms, last_seen_ms
                ) VALUES (
                    @routeId, @keyVersion,
                    @legacyRouteKey, @afi, @safi, @pathId, @rd, @prefix, @prefixLength,
                    @nlriKind, @nlriJson, @nlriFlags, @eventAtMs, @eventAtMs
                )
                ON CONFLICT(route_id) DO UPDATE SET
                    legacy_route_key = COALESCE(excluded.legacy_route_key, bmp_route_identities.legacy_route_key),
                    last_seen_ms = MAX(bmp_route_identities.last_seen_ms, excluded.last_seen_ms)
                RETURNING route_pk
            `),
            upsertRoutePayload: this.db.prepare(`
                INSERT INTO bmp_route_payloads(
                    payload_hash, route_json, first_seen_ms, last_seen_ms
                ) VALUES (
                    @payloadHash, @routeJson, @eventAtMs, @eventAtMs
                )
                ON CONFLICT(payload_hash) DO UPDATE SET
                    last_seen_ms = MAX(bmp_route_payloads.last_seen_ms, excluded.last_seen_ms)
                WHERE bmp_route_payloads.route_json = excluded.route_json
                RETURNING payload_id
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
            `),
            // Garbage collection of shared rows is candidate driven: whenever a
            // current route that referenced an identity, payload, or attribute is
            // deleted or re-pointed, the old keys are recorded here and the
            // anti-join deletes below remove the rows nothing references any more.
            addGcCandidate: this.db.prepare(
                'INSERT OR IGNORE INTO temp.bmp_gc_candidates(kind, pk) VALUES (@kind, @pk)'
            ),
            clearGcCandidates: this.db.prepare('DELETE FROM temp.bmp_gc_candidates'),
            gcAttributes: this.db.prepare(`
                DELETE FROM bmp_route_attributes
                 WHERE attr_pk IN (SELECT pk FROM temp.bmp_gc_candidates WHERE kind = ${GC_KIND.ATTRIBUTE})
                   AND NOT EXISTS (
                       SELECT 1 FROM bmp_current_route_refs c WHERE c.attr_pk = bmp_route_attributes.attr_pk
                   )
            `),
            gcPayloads: this.db.prepare(`
                DELETE FROM bmp_route_payloads
                 WHERE payload_id IN (SELECT pk FROM temp.bmp_gc_candidates WHERE kind = ${GC_KIND.PAYLOAD})
                   AND NOT EXISTS (
                       SELECT 1 FROM bmp_current_route_refs c WHERE c.payload_id = bmp_route_payloads.payload_id
                   )
            `),
            gcIdentities: this.db.prepare(`
                DELETE FROM bmp_route_identities
                 WHERE route_pk IN (SELECT pk FROM temp.bmp_gc_candidates WHERE kind = ${GC_KIND.IDENTITY})
                   AND NOT EXISTS (
                       SELECT 1 FROM bmp_current_route_refs c WHERE c.route_pk = bmp_route_identities.route_pk
                   )
            `)
        };

        this.partitionStatements = new Map(
            BMP_ROUTE_PARTITIONS.map(partition => {
                const table = partition.quotedTableName;
                const expanded = buildExpandedPartitionSelect(partition);
                return [
                    partition.partitionId,
                    {
                        findCurrentRoute: this.db.prepare(`
                            SELECT r.*, s.scope_id, conn.connection_id, route_attr.attr_id, route_attr.attr_json
                              FROM (${expanded}) r
                              JOIN bmp_rib_scopes s ON s.scope_pk = r.scope_pk
                              JOIN bmp_connections conn ON conn.connection_pk = r.connection_pk
                              LEFT JOIN bmp_route_attributes route_attr ON route_attr.attr_pk = r.attr_pk
                             WHERE r.scope_pk = @scopePk AND r.route_pk = @routePk
                             LIMIT 1
                        `),
                        findCurrentRouteRefs: this.db.prepare(`
                            SELECT payload_id, attr_pk
                              FROM ${table}
                             WHERE scope_pk = @scopePk AND route_pk = @routePk
                        `),
                        upsertRoute: this.db.prepare(`
                            INSERT INTO ${table}(
                                partition_id, scope_pk, route_pk, payload_id, attr_pk,
                                connection_pk, rib_epoch, explicit_state, first_seen_ms,
                                last_seen_ms, source_timestamp_ms, last_sequence
                            )
                            SELECT @partitionId, @scopePk, @routePk, @payloadId, @attrPk,
                                   @connectionPk, @epoch, 'active', @eventAtMs,
                                   @eventAtMs, @sourceTimestampMs, @sequence
                             WHERE EXISTS (
                                 SELECT 1
                                   FROM bmp_rib_scopes scope
                                  WHERE scope.scope_pk = @scopePk
                                    AND scope.partition_id = @partitionId
                                    AND scope.last_connection_pk = @connectionPk
                                    AND scope.current_epoch = @epoch
                             )
                            ON CONFLICT(scope_pk, route_pk) DO UPDATE SET
                                payload_id = excluded.payload_id,
                                attr_pk = excluded.attr_pk,
                                connection_pk = excluded.connection_pk,
                                rib_epoch = excluded.rib_epoch,
                                explicit_state = 'active',
                                last_seen_ms = MAX(last_seen_ms, excluded.last_seen_ms),
                                source_timestamp_ms = excluded.source_timestamp_ms,
                                last_sequence = excluded.last_sequence
                            WHERE connection_pk <> @connectionPk
                               OR (
                                   excluded.rib_epoch >= rib_epoch
                                   AND excluded.last_sequence >= last_sequence
                               )
                        `),
                        withdrawRoute: this.db.prepare(`
                            DELETE FROM ${table}
                             WHERE scope_pk = @scopePk AND route_pk = @routePk
                               AND EXISTS (
                                   SELECT 1
                                     FROM bmp_rib_scopes scope
                                    WHERE scope.scope_pk = @scopePk
                                      AND scope.partition_id = @partitionId
                                      AND scope.last_connection_pk = @connectionPk
                                      AND scope.current_epoch = @epoch
                               )
                            RETURNING route_pk, payload_id, attr_pk
                        `),
                        deleteRoute: this.db.prepare(`
                            DELETE FROM ${table}
                             WHERE scope_pk = @scopePk AND route_pk = @routePk
                            RETURNING route_pk, payload_id, attr_pk
                        `)
                    }
                ];
            })
        );
    }

    getPartitionStatements(partition) {
        const statements = this.partitionStatements?.get(partition.partitionId);
        if (!statements) {
            throw new Error(`BMP route partition statements are unavailable for ${partition.key}`);
        }
        return statements;
    }

    mapDeltaRouteRow(row) {
        if (!row) {
            return null;
        }
        const route = buildStoredRouteProjection(row);
        return {
            ...route,
            persistentRouteId: row.route_id,
            persistentScopeId: row.scope_id,
            routeKey: route.routeKey || row.legacy_route_key,
            canonicalRouteKey: buildCanonicalRouteKey(row.route_id, row.route_key_version),
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
        const route = buildStoredRouteProjection(
            {
                afi: routeData.afi,
                safi: routeData.safi,
                path_id: routeData.pathId,
                rd: routeData.rd,
                prefix: routeData.prefix,
                prefix_length: routeData.prefixLength,
                nlri_json: routeData.nlriJson ?? null,
                nlri_flags: routeData.nlriFlags ?? 0,
                legacy_route_key: routeData.legacyRouteKey,
                attr_id: routeData.attrId
            },
            { routeJson: routeData.routeJson, attrJson: routeData.attrJson }
        );
        return {
            ...route,
            persistentRouteId: routeData.id,
            persistentScopeId: mutation.scope?.id || null,
            routeKey: route.routeKey || routeData.legacyRouteKey,
            canonicalRouteKey:
                parseJson(routeData.keyJson) || buildCanonicalRouteKey(routeData.id, routeData.keyVersion),
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

    buildCommittedRouteDelta(mutation, options = {}) {
        const route = mutation.route || {};
        return {
            action: options.action,
            classification: options.classification,
            requestedEventType: mutation.eventType,
            eventType: options.eventType || options.classification,
            sequence: finiteNumber(mutation.sequence),
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

    buildApplyBatchResult(duplicate, applied, deltas, includeDeltas = true) {
        const result = { duplicate, applied };
        if (!includeDeltas) {
            return result;
        }
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

    addGcCandidates(rows) {
        if (!Array.isArray(rows) || rows.length === 0) {
            return;
        }
        rows.forEach(row => {
            if (!row) {
                return;
            }
            if (row.route_pk !== null && row.route_pk !== undefined) {
                this.statements.addGcCandidate.run({ kind: GC_KIND.IDENTITY, pk: Number(row.route_pk) });
            }
            if (row.payload_id !== null && row.payload_id !== undefined) {
                this.statements.addGcCandidate.run({ kind: GC_KIND.PAYLOAD, pk: Number(row.payload_id) });
            }
            if (row.attr_pk !== null && row.attr_pk !== undefined) {
                this.statements.addGcCandidate.run({ kind: GC_KIND.ATTRIBUTE, pk: Number(row.attr_pk) });
            }
        });
    }

    // Deletes every candidate row that is no longer referenced by any event or
    // current route, then clears the candidate set. Must run inside the same
    // transaction as the deletions that produced the candidates.
    collectGarbage() {
        const attributes = this.statements.gcAttributes.run().changes;
        const payloads = this.statements.gcPayloads.run().changes;
        const identities = this.statements.gcIdentities.run().changes;
        this.statements.clearGcCandidates.run();
        return { attributes, payloads, identities };
    }

    resolveSourcePk(source, eventAtMs, batchCache) {
        const sourceSignature = `${source.identityJson}|${source.remoteIp || ''}|${source.sysName || ''}|${
            source.sysDesc || ''
        }|${asJson(source.metadata) || ''}`;
        const cached = batchCache?.sources.get(source.id);
        if (cached && cached.signature === sourceSignature) {
            return cached.pk;
        }
        const row = this.statements.upsertSource.get({
            id: source.id,
            keyJson: source.keyJson,
            identityJson: source.identityJson,
            remoteIp: source.remoteIp || null,
            sysName: source.sysName || null,
            sysDesc: source.sysDesc || null,
            eventAtMs,
            metadataJson: asJson(source.metadata)
        });
        const pk = Number(row.source_pk);
        batchCache?.sources.set(source.id, { signature: sourceSignature, pk });
        return pk;
    }

    resolveConnection(connection, sourcePk, eventAtMs, batchCache) {
        const cached = batchCache?.connections.get(connection.id);
        if (cached !== undefined) {
            return cached;
        }
        const row = this.statements.upsertConnection.get({
            id: connection.id,
            sourcePk,
            generation: finiteNumber(connection.generation, 0),
            localIp: connection.localIp || null,
            localPort: finiteNumber(connection.localPort),
            remoteIp: connection.remoteIp || null,
            remotePort: finiteNumber(connection.remotePort),
            openedAtMs: finiteNumber(connection.openedAtMs, eventAtMs)
        });
        const state = { pk: Number(row.connection_pk), lastSequence: finiteNumber(row.last_sequence, 0) };
        batchCache?.connections.set(connection.id, state);
        return state;
    }

    // Records the highest applied sequence per connection. Within a batch the
    // value is tracked in the cache and written once at commit time.
    commitConnectionSequences(batchCache) {
        batchCache.connections.forEach(state => {
            if (state.dirty) {
                this.statements.advanceConnectionSequence.run({ connectionPk: state.pk, sequence: state.lastSequence });
                state.dirty = false;
            }
        });
    }

    resolveAttrPk(route, eventAtMs, batchCache) {
        if (!route?.attrId || !route.attrJson) {
            return null;
        }
        const cached = batchCache?.attributes.get(route.attrId);
        if (cached !== undefined) {
            return cached;
        }
        const row = this.statements.upsertAttribute.get({
            id: route.attrId,
            attrJson: route.attrJson,
            eventAtMs
        });
        const pk = Number(row.attr_pk);
        batchCache?.attributes.set(route.attrId, pk);
        return pk;
    }

    applyMutation(batchId, mutation, batchCache = null, options = {}) {
        const source = mutation.source;
        const connection = mutation.connection;
        const scope = mutation.scope || null;
        const route = mutation.route || null;
        const eventAtMs = finiteNumber(mutation.eventAtMs, Date.now());
        const includeDeltas = options.includeDeltas !== false;

        if (!source?.id || !connection?.id) {
            throw new Error('BMP persistence mutation requires source and connection identities');
        }

        const partition = scope
            ? route
                ? assertBmpRouteMatchesScope(route, scope)
                : resolveBmpRoutePartition({ scopeKind: scope.kind, afi: scope.afi, safi: scope.safi })
            : null;

        const sourcePk = this.resolveSourcePk(source, eventAtMs, batchCache);
        const connectionState = this.resolveConnection(connection, sourcePk, eventAtMs, batchCache);
        const connectionPk = connectionState.pk;
        // A replayed (connection, sequence) pair must be a complete no-op: the
        // scope and route upserts below would otherwise roll newer state back.
        const sequence = finiteNumber(mutation.sequence);
        if (sequence !== null) {
            if (sequence <= connectionState.lastSequence) {
                return { applied: false, delta: null };
            }
            connectionState.lastSequence = sequence;
            connectionState.dirty = true;
            if (!batchCache) {
                this.statements.advanceConnectionSequence.run({ connectionPk, sequence });
            }
        }

        let scopePk = null;
        if (scope) {
            // The partition check only depends on the scope's immutable identity
            // columns, so within one batch it is enough to validate each scope once.
            const scopeValidationKey = `${scope.id}|${sourcePk}|${partition.partitionId}|${scope.kind}|${scope.afi}|${scope.safi}`;
            let existingScope = null;
            if (!batchCache || !batchCache.validatedScopes.has(scopeValidationKey)) {
                existingScope = this.statements.findScopePartition.get({ scopeId: scope.id }) || null;
                if (
                    existingScope &&
                    (Number(existingScope.source_pk) !== sourcePk ||
                        Number(existingScope.partition_id) !== partition.partitionId ||
                        existingScope.scope_kind !== scope.kind ||
                        Number(existingScope.afi) !== Number(scope.afi) ||
                        Number(existingScope.safi) !== Number(scope.safi))
                ) {
                    throw new Error(
                        `BMP scope identity collision for ${scope.id}; existing scope does not match source, kind, or AFI/SAFI partition`
                    );
                }
                batchCache?.validatedScopes.add(scopeValidationKey);
                if (existingScope) {
                    batchCache?.scopePks.set(scope.id, Number(existingScope.scope_pk));
                }
            }

            const scopeSignature = `${partition.partitionId}|${connectionPk}|${scope.epoch}|${scope.state || 'syncing'}|${
                mutation.reason || scope.reason || ''
            }|${scope.vrfName || ''}|${mutation.eventType}`;
            if (!batchCache || batchCache.scopes.get(scope.id) !== scopeSignature) {
                this.statements.upsertScope.run({
                    id: scope.id,
                    sourcePk,
                    partitionId: partition.partitionId,
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
                    connectionPk,
                    eventAtMs
                });
                batchCache?.scopes.set(scope.id, scopeSignature);
            }
            scopePk = batchCache?.scopePks.get(scope.id) ?? null;
            if (scopePk === null) {
                const row = this.statements.findScopePartition.get({ scopeId: scope.id });
                if (!row) {
                    throw new Error(`BMP scope ${scope.id} could not be persisted`);
                }
                scopePk = Number(row.scope_pk);
                batchCache?.scopePks.set(scope.id, scopePk);
            }
        }

        const attrPk = this.resolveAttrPk(route, eventAtMs, batchCache);

        let routePk = null;
        let payloadId = null;
        if (route) {
            routePk = batchCache?.routeIdentities.get(route.id) ?? null;
            if (routePk === null) {
                const identity = this.statements.upsertRouteIdentity.get({
                    routeId: route.id,
                    keyVersion: Number(route.keyVersion),
                    legacyRouteKey: route.legacyRouteKey || null,
                    afi: Number(route.afi),
                    safi: Number(route.safi),
                    pathId: Number(route.pathId || 0),
                    rd: route.rd || null,
                    prefix: route.prefix || null,
                    prefixLength: finiteNumber(route.prefixLength),
                    nlriKind: route.nlriKind || null,
                    nlriJson: route.nlriJson ?? null,
                    nlriFlags: Number(route.nlriFlags) || 0,
                    eventAtMs
                });
                routePk = Number(identity.route_pk);
                batchCache?.routeIdentities.set(route.id, routePk);
            }

            let payloadHash = null;
            let payloadCacheKey = batchCache?.routePayloadHashes.get(route.routeJson);
            if (payloadCacheKey === undefined) {
                payloadHash = sha256Buffer(route.routeJson);
                payloadCacheKey = payloadHash.toString('hex');
            }
            payloadId = batchCache?.routePayloads.get(payloadCacheKey) ?? null;
            if (payloadId === null) {
                payloadHash = payloadHash || Buffer.from(payloadCacheKey, 'hex');
                const payload = this.statements.upsertRoutePayload.get({
                    payloadHash,
                    routeJson: route.routeJson,
                    eventAtMs
                });
                if (!payload) {
                    throw new Error(`BMP route payload hash collision for route ${route.id}`);
                }
                payloadId = Number(payload.payload_id);
                batchCache?.routePayloads.set(payloadCacheKey, payloadId);
            }
        }

        const isRouteUpsert = ['upsert', 'announce', 'replace', 'refresh'].includes(mutation.eventType);
        const isRouteDelete = ['delete', 'withdraw', 'purge'].includes(mutation.eventType);
        const routeStatements = partition ? this.getPartitionStatements(partition) : null;
        // The fully expanded previous row is only needed to describe the delta;
        // without deltas a primary-key probe for the replaced object references
        // (garbage-collection candidates) is enough.
        const previousRow =
            route && scope && (isRouteUpsert || isRouteDelete)
                ? includeDeltas
                    ? routeStatements.findCurrentRoute.get({ scopePk, routePk })
                    : routeStatements.findCurrentRouteRefs.get({ scopePk, routePk })
                : null;
        const previousRoute = includeDeltas ? this.mapDeltaRouteRow(previousRow) : null;

        let delta = null;
        switch (mutation.eventType) {
            case 'upsert':
            case 'announce':
            case 'replace':
            case 'refresh': {
                const routeResult = routeStatements.upsertRoute.run({
                    partitionId: partition.partitionId,
                    scopePk,
                    routePk,
                    payloadId,
                    attrPk,
                    epoch: finiteNumber(scope.epoch, 0),
                    eventAtMs,
                    sourceTimestampMs: finiteNumber(mutation.sourceTimestampMs),
                    sequence: sequence ?? 0,
                    connectionPk
                });
                const projectionChanged = routeResult.changes > 0;
                const classification = projectionChanged
                    ? previousRow
                        ? (previousRow.attr_id || null) === (route.attrId || null)
                            ? 'refresh'
                            : 'replace'
                        : 'announce'
                    : 'upsert-noop';
                if (projectionChanged && previousRow) {
                    // The replaced payload/attribute may now be unreferenced.
                    this.addGcCandidates([{ payload_id: previousRow.payload_id, attr_pk: previousRow.attr_pk }]);
                }
                if (includeDeltas) {
                    delta = this.buildCommittedRouteDelta(mutation, {
                        action: 'upsert',
                        classification,
                        projectionChanged,
                        previous: previousRoute,
                        current: projectionChanged ? this.mapDeltaMutationRoute(mutation) : previousRoute
                    });
                }
                break;
            }
            case 'delete':
            case 'withdraw':
            case 'purge': {
                const deletedRows = routeStatements.withdrawRoute.all({
                    scopePk,
                    routePk,
                    partitionId: partition.partitionId,
                    connectionPk,
                    epoch: finiteNumber(scope.epoch, 0)
                });
                const projectionChanged = deletedRows.length > 0;
                const classification = projectionChanged
                    ? mutation.eventType === 'purge'
                        ? 'purge'
                        : 'withdraw'
                    : 'withdraw-noop';
                this.addGcCandidates(deletedRows);
                if (includeDeltas) {
                    delta = this.buildCommittedRouteDelta(mutation, {
                        action: 'delete',
                        classification,
                        projectionChanged,
                        previous: previousRoute,
                        current: projectionChanged ? null : previousRoute
                    });
                }
                break;
            }
            case 'scope_eor':
                this.statements.markScopeEor.run({
                    scopePk,
                    epoch: scope.epoch,
                    eventAtMs,
                    connectionPk
                });
                break;
            case 'scope_timeout':
                this.statements.markScopeTimeout.run({
                    scopePk,
                    epoch: scope.epoch,
                    eventAtMs,
                    connectionPk
                });
                break;
            case 'connection_close':
                this.statements.closeConnection.run({
                    connectionPk,
                    eventAtMs,
                    reason: mutation.reason || 'connection-close'
                });
                this.statements.closeConnectionScopes.run({
                    connectionPk,
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

    getBulkStatement(kind, rowCount) {
        const key = `${kind}:${rowCount}`;
        let statement = this.bulkStatements.get(key);
        if (statement) {
            return statement;
        }
        const placeholders = width => `(${Array.from({ length: width }, () => '?').join(', ')})`;
        const rows = width => Array.from({ length: rowCount }, () => placeholders(width)).join(',\n');
        const list = Array.from({ length: rowCount }, () => '?').join(', ');
        switch (kind) {
            case 'insertIdentities':
                statement = this.db.prepare(`
                    INSERT OR IGNORE INTO bmp_route_identities(
                        route_id, route_key_version, legacy_route_key, afi, safi, path_id,
                        rd, prefix, prefix_length, nlri_kind, nlri_json, nlri_flags, first_seen_ms, last_seen_ms
                    ) VALUES ${rows(14)}
                `);
                break;
            case 'selectIdentities':
                statement = this.db.prepare(`
                    SELECT route_id, route_pk
                      FROM bmp_route_identities
                     WHERE route_id IN (${list})
                `);
                break;
            case 'insertPayloads':
                statement = this.db.prepare(`
                    INSERT OR IGNORE INTO bmp_route_payloads(payload_hash, route_json, first_seen_ms, last_seen_ms)
                    VALUES ${rows(4)}
                `);
                break;
            case 'selectPayloads':
                statement = this.db.prepare(`
                    SELECT payload_id, payload_hash, route_json
                      FROM bmp_route_payloads
                     WHERE payload_hash IN (${list})
                `);
                break;
            case 'insertAttributes':
                statement = this.db.prepare(`
                    INSERT OR IGNORE INTO bmp_route_attributes(attr_id, attr_json, first_seen_ms, last_seen_ms)
                    VALUES ${rows(4)}
                `);
                break;
            case 'selectAttributes':
                statement = this.db.prepare(`
                    SELECT attr_id, attr_pk
                      FROM bmp_route_attributes
                     WHERE attr_id IN (${list})
                `);
                break;
            default:
                throw new Error(`Unknown bulk statement ${kind}`);
        }
        this.bulkStatements.set(key, statement);
        return statement;
    }

    // Resolves the shared route objects of a whole batch up front: one
    // multi-row INSERT OR IGNORE plus one SELECT per object kind and chunk,
    // instead of a RETURNING upsert per path. Hash collisions are detected by
    // comparing the stored canonical JSON with what the batch carries.
    prefillRouteObjectCaches(mutations, batchCache) {
        const identities = new Map();
        const payloads = new Map();
        const attributes = new Map();
        mutations.forEach(mutation => {
            const route = mutation?.route;
            if (!route) {
                return;
            }
            const eventAtMs = finiteNumber(mutation.eventAtMs, Date.now());
            if (route.id && !identities.has(route.id)) {
                identities.set(route.id, { route, eventAtMs });
            }
            if (typeof route.routeJson === 'string') {
                let hashHex = batchCache.routePayloadHashes.get(route.routeJson);
                if (hashHex === undefined) {
                    const hash = sha256Buffer(route.routeJson);
                    hashHex = hash.toString('hex');
                    batchCache.routePayloadHashes.set(route.routeJson, hashHex);
                    if (!payloads.has(hashHex)) {
                        payloads.set(hashHex, { hash, routeJson: route.routeJson, eventAtMs });
                    }
                }
            }
            if (route.attrId && route.attrJson && !attributes.has(route.attrId)) {
                attributes.set(route.attrId, { attrJson: route.attrJson, eventAtMs });
            }
        });

        const chunked = (items, size, handler) => {
            for (let index = 0; index < items.length; index += size) {
                handler(items.slice(index, index + size));
            }
        };

        chunked(Array.from(identities.entries()), BULK_ROWS, chunk => {
            const params = [];
            chunk.forEach(([routeId, { route, eventAtMs }]) => {
                params.push(
                    routeId,
                    Number(route.keyVersion),
                    route.legacyRouteKey || null,
                    Number(route.afi),
                    Number(route.safi),
                    Number(route.pathId || 0),
                    route.rd || null,
                    route.prefix || null,
                    finiteNumber(route.prefixLength),
                    route.nlriKind || null,
                    route.nlriJson ?? null,
                    Number(route.nlriFlags) || 0,
                    eventAtMs,
                    eventAtMs
                );
            });
            this.getBulkStatement('insertIdentities', chunk.length).run(...params);
            this.getBulkStatement('selectIdentities', chunk.length)
                .all(...chunk.map(([routeId]) => routeId))
                .forEach(row => batchCache.routeIdentities.set(row.route_id, Number(row.route_pk)));
        });

        chunked(Array.from(payloads.entries()), BULK_ROWS, chunk => {
            const params = [];
            chunk.forEach(([, { hash, routeJson, eventAtMs }]) => params.push(hash, routeJson, eventAtMs, eventAtMs));
            this.getBulkStatement('insertPayloads', chunk.length).run(...params);
            this.getBulkStatement('selectPayloads', chunk.length)
                .all(...chunk.map(([, { hash }]) => hash))
                .forEach(row => {
                    const hashHex = row.payload_hash.toString('hex');
                    const expected = payloads.get(hashHex);
                    if (expected && row.route_json !== expected.routeJson) {
                        throw new Error(`BMP route payload hash collision for payload ${hashHex}`);
                    }
                    batchCache.routePayloads.set(hashHex, Number(row.payload_id));
                });
        });

        chunked(Array.from(attributes.entries()), BULK_ROWS, chunk => {
            const params = [];
            chunk.forEach(([attrId, { attrJson, eventAtMs }]) => params.push(attrId, attrJson, eventAtMs, eventAtMs));
            this.getBulkStatement('insertAttributes', chunk.length).run(...params);
            this.getBulkStatement('selectAttributes', chunk.length)
                .all(...chunk.map(([attrId]) => attrId))
                .forEach(row => batchCache.attributes.set(row.attr_id, Number(row.attr_pk)));
        });
    }

    applyBatch(batch = {}) {
        if (this.readOnly) {
            throw new Error('Cannot apply a BMP persistence batch to a read-only store');
        }
        if (!this.db) {
            this.open();
        }

        const mutations = decodeBatchMutations(batch);
        const batchId = String(batch.batchId || '');
        const includeDeltas = batch.includeDeltas !== false;
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
                return this.buildApplyBatchResult(true, 0, includeDeltas ? [] : null, includeDeltas);
            }

            let applied = 0;
            const deltas = includeDeltas ? [] : null;
            const batchCache = {
                sources: new Map(),
                connections: new Map(),
                scopes: new Map(),
                scopePks: new Map(),
                validatedScopes: new Set(),
                attributes: new Map(),
                routeIdentities: new Map(),
                routePayloads: new Map(),
                routePayloadHashes: new Map()
            };
            this.prefillRouteObjectCaches(mutations, batchCache);
            mutations.forEach(mutation => {
                const mutationResult = this.applyMutation(batchId, mutation, batchCache, { includeDeltas });
                if (mutationResult.applied) {
                    applied += 1;
                }
                if (includeDeltas && mutationResult.delta) {
                    deltas.push(mutationResult.delta);
                }
            });
            this.commitConnectionSequences(batchCache);
            return this.buildApplyBatchResult(false, applied, deltas, includeDeltas);
        });

        return transaction();
    }

    buildRouteStateSql() {
        return `CASE
            WHEN r.explicit_state = 'stale'
              OR s.scope_state IN ('stale', 'down')
              OR r.connection_pk IS NOT s.last_connection_pk
              OR r.rib_epoch < s.current_epoch
            THEN 'stale' ELSE 'active' END`;
    }

    resolveQueryPartitions(query = {}) {
        if (query.scopeId !== undefined && query.scopeId !== null && query.scopeId !== '') {
            const row = this.statements?.findScopePartition
                ? this.statements.findScopePartition.get({ scopeId: String(query.scopeId) })
                : this.db
                      .prepare('SELECT partition_id FROM bmp_rib_scopes WHERE scope_id = @scopeId LIMIT 1')
                      .get({ scopeId: String(query.scopeId) });
            return row ? [getBmpRoutePartitionById(row.partition_id)] : [];
        }

        let partitionQuery = query;
        if (query.routeId !== undefined && query.routeId !== null && query.routeId !== '') {
            const identity = this.db
                .prepare('SELECT afi, safi FROM bmp_route_identities WHERE route_id = @routeId LIMIT 1')
                .get({ routeId: String(query.routeId) });
            if (!identity) {
                return [];
            }
            partitionQuery = { ...query, afi: identity.afi, safi: identity.safi };
        }

        const scopeWhere = [];
        const params = {};
        const addScopeFilter = (column, name, value) => {
            if (value !== undefined && value !== null && value !== '') {
                scopeWhere.push(`${column} = @${name}`);
                params[name] = value;
            }
        };
        addScopeFilter('src.source_id', 'sourceId', query.sourceId);
        addScopeFilter('s.owner_key', 'ownerKey', query.ownerKey);
        addScopeFilter('s.rib_type', 'ribType', query.ribType);
        addScopeFilter('s.scope_state', 'scopeState', query.scopeState);
        if (scopeWhere.length > 0) {
            const rows = this.db
                .prepare(
                    `SELECT DISTINCT s.partition_id
                       FROM bmp_rib_scopes s
                       JOIN bmp_sources src ON src.source_pk = s.source_pk
                      WHERE ${scopeWhere.join(' AND ')}`
                )
                .all(params);
            const presentIds = new Set(rows.map(row => Number(row.partition_id)));
            return selectBmpRoutePartitions(partitionQuery).filter(partition => presentIds.has(partition.partitionId));
        }
        return selectBmpRoutePartitions(partitionQuery);
    }

    queryRouteCountFromCounters(query = {}) {
        const hasValue = value => value !== undefined && value !== null && value !== '';
        if (
            hasValue(query.routeId) ||
            hasValue(query.legacyRouteKey || query.routeKey) ||
            hasValue(query.prefixLength) ||
            hasValue(query.prefixExact) ||
            hasValue(query.prefix) ||
            normalizePrefixCidrs(query.prefixCidrs).length > 0 ||
            String(query.searchText ?? '').trim() !== '' ||
            String(query.routeIdentityText ?? '').trim() !== '' ||
            String(query.prefixFilter ?? '').trim() !== ''
        ) {
            return null;
        }

        const where = [];
        const params = {};
        const addFilter = (column, name, value) => {
            if (hasValue(value)) {
                where.push(`${column} = @${name}`);
                params[name] = value;
            }
        };
        addFilter('src.source_id', 'sourceId', query.sourceId);
        addFilter('s.scope_id', 'scopeId', query.scopeId);
        addFilter('s.owner_key', 'ownerKey', query.ownerKey);
        addFilter('s.scope_kind', 'scopeKind', query.scopeKind);
        addFilter('s.afi', 'afi', finiteNumber(query.afi));
        addFilter('s.safi', 'safi', finiteNumber(query.safi));
        addFilter('s.rib_type', 'ribType', query.ribType);
        addFilter('s.scope_state', 'scopeState', query.scopeState);
        if (hasValue(query.connectionId)) {
            where.push(
                'count.connection_pk = (SELECT connection_pk FROM bmp_connections WHERE connection_id = @connectionId)'
            );
            params.connectionId = query.connectionId;
        }

        const active = `(
            s.scope_state NOT IN ('stale', 'down')
            AND count.explicit_state <> 'stale'
            AND count.connection_pk IS s.last_connection_pk
            AND count.rib_epoch >= s.current_epoch
        )`;
        let aggregate = 'count.route_count';
        if (query.routeState && query.routeState !== 'all') {
            if (query.routeState === 'active') {
                aggregate = `CASE WHEN ${active} THEN count.route_count ELSE 0 END`;
            } else if (query.routeState === 'stale') {
                aggregate = `CASE WHEN ${active} THEN 0 ELSE count.route_count END`;
            } else {
                return 0;
            }
        }
        const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        return Number(
            this.db
                .prepare(
                    `SELECT COALESCE(SUM(${aggregate}), 0) AS total
                       FROM bmp_rib_scopes s
                       JOIN bmp_sources src ON src.source_pk = s.source_pk
                       LEFT JOIN bmp_scope_route_counts count ON count.scope_pk = s.scope_pk
                       ${whereSql}`
                )
                .get(params).total || 0
        );
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
        const partitions = this.resolveQueryPartitions(query);
        const currentRoutesSql = `(${buildExpandedCurrentRoutesSql(partitions)})`;
        const identityPrefixOnly =
            partitions.length > 0 &&
            partitions.every(partition => ['ipv4-unicast', 'ipv6-unicast'].includes(partition.familyKey));
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
            lower(COALESCE(json_extract(r.nlri_json, '$.prefix'), '')),
            lower(COALESCE(json_extract(r.nlri_json, '$.ipPrefix'), '')),
            lower(COALESCE(json_extract(r.nlri_json, '$.ipAddress'), ''))
        )`;
        const exactCidrPredicate = (prefixParam, lengthParam) =>
            identityPrefixOnly
                ? `r.route_pk IN (
                    SELECT candidate.route_pk
                      FROM bmp_route_identities candidate
                     WHERE candidate.prefix = @${prefixParam}
                       AND candidate.prefix_length = @${lengthParam}
                )`
                : `(
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
                    lower(COALESCE(json_extract(r.nlri_json, '$.prefix'), '')) = @${prefixParam}
                    OR lower(COALESCE(json_extract(r.nlri_json, '$.ipPrefix'), '')) = @${prefixParam}
                )
                AND COALESCE(
                    json_extract(r.nlri_json, '$.prefixLength'),
                    json_extract(r.nlri_json, '$.length')
                ) = @${lengthParam}
            )
            OR (
                lower(COALESCE(json_extract(r.nlri_json, '$.ipAddress'), '')) = @${prefixParam}
                AND @${lengthParam} IN (32, 128)
            )
        )`;

        addFilter('src.source_id = @sourceId', 'sourceId', query.sourceId);
        addFilter('s.scope_id = @scopeId', 'scopeId', query.scopeId);
        addFilter('s.owner_key = @ownerKey', 'ownerKey', query.ownerKey);
        addFilter('conn.connection_id = @connectionId', 'connectionId', query.connectionId);
        if (query.routeId !== undefined && query.routeId !== null && query.routeId !== '') {
            params.routeId = query.routeId;
            where.push(`r.route_pk = (
                SELECT candidate.route_pk
                  FROM bmp_route_identities candidate
                 WHERE candidate.route_id = @routeId
            )`);
        }
        if (query.legacyRouteKey || query.routeKey) {
            params.legacyRouteKey = query.legacyRouteKey || query.routeKey;
            where.push(`r.route_pk IN (
                SELECT candidate.route_pk
                  FROM bmp_route_identities candidate
                 WHERE candidate.legacy_route_key = @legacyRouteKey
            )`);
        }
        addFilter('s.scope_kind = @scopeKind', 'scopeKind', query.scopeKind);
        addFilter('r.afi = @afi', 'afi', finiteNumber(query.afi));
        addFilter('r.safi = @safi', 'safi', finiteNumber(query.safi));
        addFilter('r.prefix_length = @prefixLength', 'prefixLength', finiteNumber(query.prefixLength));
        addFilter('s.rib_type = @ribType', 'ribType', query.ribType);
        addFilter('s.scope_state = @scopeState', 'scopeState', query.scopeState);
        if (query.prefixExact !== undefined && query.prefixExact !== null && query.prefixExact !== '') {
            params.prefixExact = String(query.prefixExact);
            where.push(`r.route_pk IN (
                SELECT candidate.route_pk
                  FROM bmp_route_identities candidate
                 WHERE candidate.prefix = @prefixExact
            )`);
        } else if (query.prefix) {
            params.prefixStart = String(query.prefix);
            params.prefixEnd = `${params.prefixStart}\uffff`;
            where.push(`r.route_pk IN (
                SELECT candidate.route_pk
                  FROM bmp_route_identities candidate
                 WHERE candidate.prefix >= @prefixStart AND candidate.prefix < @prefixEnd
            )`);
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
                COALESCE(r.nlri_json, '') || char(31) ||
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
                COALESCE(r.nlri_json, '') || char(31) ||
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
                where.push(
                    identityPrefixOnly
                        ? `r.route_pk IN (
                            SELECT candidate.route_pk
                              FROM bmp_route_identities candidate
                             WHERE candidate.prefix = @prefixFilterValue
                        )`
                        : `@prefixFilterValue IN ${routePrefixValuesSql}`
                );
            } else {
                params.prefixFilterText = prefixFilter.toLowerCase();
                where.push(
                    identityPrefixOnly
                        ? `instr(lower(COALESCE(r.prefix, '')), @prefixFilterText) > 0`
                        : `instr(lower(
                    COALESCE(r.prefix, '') || char(31) ||
                    COALESCE(json_extract(r.route_json, '$.ip'), '') || char(31) ||
                    COALESCE(json_extract(r.route_json, '$.prefix'), '') || char(31) ||
                    COALESCE(json_extract(r.nlri_json, '$.prefix'), '') || char(31) ||
                    COALESCE(json_extract(r.nlri_json, '$.ipPrefix'), '') || char(31) ||
                    COALESCE(json_extract(r.nlri_json, '$.ipAddress'), '') || char(31) ||
                    COALESCE(json_extract(r.nlri_json, '$.formatted'), '')
                ), @prefixFilterText) > 0`
                );
            }
        }
        if (query.routeState && query.routeState !== 'all') {
            where.push(`${stateSql} = @routeState`);
            params.routeState = query.routeState;
        }
        const countWhereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const countParams = { ...params };
        if (cursor) {
            const cursorRoutePk = finiteNumber(cursor.routePk);
            const cursorScopePk = finiteNumber(cursor.scopePk);
            if (cursorScopePk === null || cursorRoutePk === null) {
                throw new Error('Invalid BMP persistence routes cursor fields');
            }
            where.push('(r.scope_pk, r.route_pk) > (@cursorScopePk, @cursorRoutePk)');
            params.cursorScopePk = cursorScopePk;
            params.cursorRoutePk = cursorRoutePk;
        }

        const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const orderSql =
            orderBy === 'firstSeen'
                ? partitions.length === 1 && query.scopeId
                    ? 'r.first_seen_ms, r.path_pk'
                    : 'r.first_seen_ms, r.partition_id, r.path_pk'
                : 'r.scope_pk, r.route_pk';
        const readSnapshot = this.db.transaction(() => {
            let total = null;
            if (includeTotal) {
                total = this.queryRouteCountFromCounters(query);
            }
            if (includeTotal && total === null) {
                total = this.db
                    .prepare(
                        `
                      SELECT COUNT(*) AS total
                        FROM ${currentRoutesSql} r
                        JOIN bmp_rib_scopes s ON s.scope_pk = r.scope_pk
                        JOIN bmp_sources src ON src.source_pk = s.source_pk
                        JOIN bmp_connections conn ON conn.connection_pk = r.connection_pk
                        LEFT JOIN bmp_route_attributes route_attr ON route_attr.attr_pk = r.attr_pk
                        ${countWhereSql}
                  `
                    )
                    .get(countParams).total;
            }

            const rows = this.db
                .prepare(
                    this.buildRouteRowsSql({
                        currentRoutesSql,
                        whereSql,
                        orderSql,
                        limitSql: 'LIMIT @limit OFFSET @offset'
                    })
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
                          scopePk: lastRow.scope_pk,
                          routePk: lastRow.route_pk
                      })
                    : null
        };
    }

    // Full route row projection shared by the paged route query and the
    // ordered Route Assurance scan; mapRouteRow() understands its columns.
    buildRouteRowsSql({ currentRoutesSql, whereSql = '', orderSql, limitSql = '' }) {
        return `
                SELECT r.*, s.scope_id, src.source_id, s.scope_kind, s.owner_key, s.scope_identity_json,
                       s.peer_type, s.peer_rd,
                       s.peer_ip, s.peer_as, s.vrf_name, s.rib_type, s.current_epoch,
                       s.eor_epoch, s.scope_state, s.stale_reason AS scope_stale_reason,
                       s.stale_since_ms, s.refresh_started_ms, s.updated_at_ms AS scope_updated_at_ms,
                       s.cleanup_pending_epoch,
                       route_attr.attr_id, route_attr.attr_json AS attr_json,
                       src.remote_ip AS source_remote_ip, src.sys_name, src.sys_desc,
                       conn.connection_id,
                       conn.local_ip AS connection_local_ip, conn.local_port AS connection_local_port,
                       conn.remote_ip AS connection_remote_ip, conn.remote_port AS connection_remote_port,
                       ${this.buildRouteStateSql()} AS effective_state
                  FROM ${currentRoutesSql} r
                  JOIN bmp_rib_scopes s ON s.scope_pk = r.scope_pk
                  JOIN bmp_sources src ON src.source_pk = s.source_pk
                  JOIN bmp_connections conn ON conn.connection_pk = r.connection_pk
                  LEFT JOIN bmp_route_attributes route_attr ON route_attr.attr_pk = r.attr_pk
                  ${whereSql}
                 ORDER BY ${orderSql}
                 ${limitSql}
            `;
    }

    // Ordered scan for the Route Assurance matrix. Rows are emitted in chunks
    // sorted so that every path of one NLRI within one source is contiguous:
    // (source, afi, safi, rd, prefix, prefix_length, route_pk, scope_pk).
    // The consumer can therefore evaluate one NLRI group at a time and never
    // has to retain the whole RIB in memory. SQLite sorts the union with a
    // temporary B-tree once; iterating the statement then streams rows.
    streamRouteAssuranceRows(query = {}, emit) {
        if (!this.db) {
            this.open();
        }
        if (typeof emit !== 'function') {
            throw new Error('BMP route assurance stream requires an emit callback');
        }
        const chunkSize = positiveInteger(query.chunkSize, 2000, 20000);
        const partitionQuery = {};
        if (finiteNumber(query.afi) !== null) {
            partitionQuery.afi = Number(query.afi);
        }
        if (finiteNumber(query.safi) !== null) {
            partitionQuery.safi = Number(query.safi);
        }
        const partitions = this.resolveQueryPartitions({ ...partitionQuery, sourceId: query.sourceId });
        const where = [];
        const params = {};
        if (query.sourceId !== undefined && query.sourceId !== null && query.sourceId !== '') {
            where.push('src.source_id = @sourceId');
            params.sourceId = String(query.sourceId);
        }
        if (finiteNumber(query.afi) !== null) {
            where.push('r.afi = @afi');
            params.afi = Number(query.afi);
        }
        if (finiteNumber(query.safi) !== null) {
            where.push('r.safi = @safi');
            params.safi = Number(query.safi);
        }
        if (query.routeState && query.routeState !== 'all') {
            where.push(`${this.buildRouteStateSql()} = @routeState`);
            params.routeState = query.routeState;
        }
        const orderSql = 'src.source_pk, r.afi, r.safi, r.rd, r.prefix, r.prefix_length, r.route_pk, r.scope_pk';
        const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const currentRoutesSql = `(${buildExpandedCurrentRoutesSql(partitions)})`;
        const lean = query.lean !== false;
        const sql = lean
            ? `
                SELECT r.route_id, r.legacy_route_key, r.afi, r.safi, r.path_id, r.rd, r.prefix, r.prefix_length,
                       r.nlri_kind, r.nlri_json, r.nlri_flags, r.payload_id, r.route_json, r.attr_pk, r.scope_pk,
                       route_attr.attr_id, route_attr.attr_json,
                       ${this.buildRouteStateSql()} AS effective_state
                  FROM ${currentRoutesSql} r
                  JOIN bmp_rib_scopes s ON s.scope_pk = r.scope_pk
                  JOIN bmp_sources src ON src.source_pk = s.source_pk
                  LEFT JOIN bmp_route_attributes route_attr ON route_attr.attr_pk = r.attr_pk
                  ${whereSql}
                 ORDER BY ${orderSql}`
            : this.buildRouteRowsSql({ currentRoutesSql, whereSql, orderSql });
        const mapRow = lean ? this.createRouteAssuranceRowMapper() : row => this.mapRouteRow(row);
        let rows = 0;
        let chunk = [];
        for (const row of this.db.prepare(sql).iterate(params)) {
            chunk.push(mapRow(row));
            rows += 1;
            if (chunk.length >= chunkSize) {
                if (emit(chunk) === false) {
                    return { rows, cancelled: true };
                }
                chunk = [];
            }
        }
        if (chunk.length > 0 && emit(chunk) === false) {
            return { rows, cancelled: true };
        }
        return { rows, cancelled: false };
    }

    // Lean projection for the Route Assurance scan. Scope/source/connection
    // details are resolved once per scope, parsed attribute JSON is cached per
    // attr_pk (thousands of paths share one attribute set), empty payloads are
    // not parsed and plain IP prefixes skip nlri_json entirely. The resulting
    // envelope carries exactly the fields makePersistedRouteContext() and the
    // issue rules read, so it evaluates identically to a mapRouteRow() row.
    createRouteAssuranceRowMapper() {
        const scopeInfo = new Map();
        const attrCache = new Map();
        const payloadCache = new Map();
        const scopeStatement = this.db.prepare(`
            SELECT s.scope_id, s.scope_kind, s.owner_key, s.scope_identity_json, s.peer_type, s.peer_rd,
                   s.peer_ip, s.peer_as, s.vrf_name, s.rib_type,
                   src.source_id, src.remote_ip AS source_remote_ip, src.sys_name, src.sys_desc,
                   conn.local_ip AS connection_local_ip, conn.local_port AS connection_local_port,
                   conn.remote_ip AS connection_remote_ip, conn.remote_port AS connection_remote_port
              FROM bmp_rib_scopes s
              JOIN bmp_sources src ON src.source_pk = s.source_pk
              LEFT JOIN bmp_connections conn ON conn.connection_pk = s.last_connection_pk
             WHERE s.scope_pk = @scopePk
        `);
        const resolveScope = scopePk => {
            let info = scopeInfo.get(scopePk);
            if (info) {
                return info;
            }
            const row = scopeStatement.get({ scopePk });
            const scopeIdentity = parseJson(row?.scope_identity_json, {});
            const peerRdIdentity = scopeIdentity?.peer?.rd;
            info = {
                scopeId: row?.scope_id ?? null,
                sourceId: row?.source_id ?? null,
                scopeKind: row?.scope_kind ?? null,
                ribType: row?.rib_type ?? null,
                ownerKey: row?.owner_key ?? null,
                vrfName: row?.vrf_name ?? null,
                peer: {
                    type: row?.peer_type ?? null,
                    rd: row?.peer_rd ?? null,
                    rdRaw:
                        typeof peerRdIdentity === 'string' && peerRdIdentity.startsWith('raw:') ? peerRdIdentity : null,
                    ip: row?.peer_ip ?? null,
                    as: row?.peer_as ?? null,
                    vrf: row?.vrf_name ?? null
                },
                source: {
                    localIp: row?.connection_local_ip ?? null,
                    localPort: row?.connection_local_port ?? null,
                    remoteIp: row?.connection_remote_ip || row?.source_remote_ip || null,
                    remotePort: row?.connection_remote_port ?? null,
                    sysName: row?.sys_name ?? null,
                    sysDesc: row?.sys_desc ?? null
                }
            };
            scopeInfo.set(scopePk, info);
            return info;
        };
        const resolveAttributes = (attrPk, attrJson) => {
            if (attrPk === null || attrPk === undefined) {
                return null;
            }
            let attributes = attrCache.get(attrPk);
            if (attributes === undefined) {
                attributes = parseJson(attrJson, {});
                attrCache.set(attrPk, attributes);
            }
            return attributes;
        };
        const resolvePayload = (payloadId, routeJson) => {
            if (!routeJson || routeJson === '{}') {
                return null;
            }
            let payload = payloadCache.get(payloadId);
            if (payload === undefined) {
                payload = parseJson(routeJson, {});
                if (payloadCache.size > 4096) {
                    payloadCache.clear();
                }
                payloadCache.set(payloadId, payload);
            }
            return payload;
        };
        return row => {
            const scope = resolveScope(row.scope_pk);
            const afi = Number(row.afi);
            const safi = Number(row.safi);
            const nlriDetail = storedNlriDetail(row);
            const payload = resolvePayload(row.payload_id, row.route_json);
            const attributes = resolveAttributes(row.attr_pk, row.attr_json);
            const route = {
                routeKey: row.legacy_route_key || null,
                addrFamilyType: getAddrFamilyType(afi, safi),
                afi,
                safi,
                ip: row.prefix || null,
                mask: finiteNumber(row.prefix_length),
                rd: row.rd || null,
                pathId: finiteNumber(row.path_id, 0),
                routeType: nlriDetail?.routeType ?? null,
                nlriDetail,
                ...(payload || {}),
                ...(attributes || {}),
                attrId: row.attr_id || '',
                persistentRouteId: row.route_id,
                persistentScopeId: scope.scopeId,
                persistentSourceId: scope.sourceId,
                ownerKey: scope.ownerKey,
                routeState: row.effective_state,
                scopeKind: scope.scopeKind,
                ribType: scope.ribType,
                peer: scope.peer,
                source: scope.source,
                vrfName: scope.vrfName
            };
            return route;
        };
    }

    mapRouteRow(row) {
        const route = buildStoredRouteProjection(row);
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
            canonicalRouteKey: buildCanonicalRouteKey(row.route_id, row.route_key_version),
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
        const scopeWhereSql = sourceWhere.length > 0 ? 'WHERE src.source_id = @sourceId' : '';
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
                      LEFT JOIN bmp_connections conn ON conn.connection_pk = (
                          SELECT candidate.connection_pk
                            FROM bmp_connections candidate
                           WHERE candidate.source_pk = src.source_pk
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
                    SELECT s.*, src.source_id,
                           conn.connection_id AS last_connection_id,
                           conn.connection_id AS scope_connection_id,
                           conn.connection_generation AS scope_connection_generation,
                           conn.connection_state AS scope_connection_state,
                           conn.local_ip AS scope_local_ip, conn.local_port AS scope_local_port,
                           conn.remote_ip AS scope_remote_ip, conn.remote_port AS scope_remote_port,
                           conn.opened_at_ms AS scope_opened_at_ms,
                           conn.closed_at_ms AS scope_closed_at_ms,
                           conn.close_reason AS scope_close_reason,
                           COALESCE(SUM(CASE
                               WHEN s.scope_state NOT IN ('stale', 'down')
                                AND count.explicit_state <> 'stale'
                                AND count.connection_pk = s.last_connection_pk
                                AND count.rib_epoch >= s.current_epoch
                               THEN count.route_count ELSE 0
                           END), 0) AS active,
                           COALESCE(SUM(count.route_count), 0) - COALESCE(SUM(CASE
                               WHEN s.scope_state NOT IN ('stale', 'down')
                                AND count.explicit_state <> 'stale'
                                AND count.connection_pk = s.last_connection_pk
                                AND count.rib_epoch >= s.current_epoch
                               THEN count.route_count ELSE 0
                           END), 0) AS stale,
                           COALESCE(SUM(count.route_count), 0) AS total
                      FROM bmp_rib_scopes s
                      JOIN bmp_sources src ON src.source_pk = s.source_pk
                      LEFT JOIN bmp_scope_route_counts count ON count.scope_pk = s.scope_pk
                      LEFT JOIN bmp_connections conn ON conn.connection_pk = s.last_connection_pk
                      ${scopeWhereSql}
                     GROUP BY s.scope_pk
                     ORDER BY src.source_id, s.scope_kind, s.owner_key, s.afi, s.safi, s.rib_type, s.scope_id
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
                transport: metadata?.transport || null,
                authentication: metadata?.authentication || null,
                authProfileId: metadata?.authProfileId || metadata?.tcpAoProfileId || metadata?.tcpMd5ProfileId || null,
                authProfileName:
                    metadata?.authProfileName || metadata?.tcpAoProfileName || metadata?.tcpMd5ProfileName || null,
                authPeer: metadata?.authPeer || metadata?.tcpAoPeer || metadata?.tcpMd5Peer || null,
                tcpAoProfileId: metadata?.tcpAoProfileId || null,
                tcpAoProfileName: metadata?.tcpAoProfileName || null,
                tcpAoPeer: metadata?.tcpAoPeer || null,
                tcpMd5ProfileId: metadata?.tcpMd5ProfileId || null,
                tcpMd5ProfileName: metadata?.tcpMd5ProfileName || null,
                tcpMd5Peer: metadata?.tcpMd5Peer || null,
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
        addFilter('src.source_id = @sourceId', 'sourceId', query.sourceId);
        addFilter('s.scope_id = @scopeId', 'scopeId', query.scopeId);
        addFilter('s.owner_key = @ownerKey', 'ownerKey', query.ownerKey);
        addFilter('conn.connection_id = @connectionId', 'connectionId', query.connectionId);
        addFilter('s.scope_kind = @scopeKind', 'scopeKind', query.scopeKind);
        addFilter('s.afi = @afi', 'afi', finiteNumber(query.afi));
        addFilter('s.safi = @safi', 'safi', finiteNumber(query.safi));
        addFilter('s.rib_type = @ribType', 'ribType', query.ribType);
        addFilter('s.scope_state = @scopeState', 'scopeState', query.scopeState);
        const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const rows = this.db
            .prepare(
                `
                SELECT s.scope_id, src.source_id, conn.connection_id AS last_connection_id, s.owner_key,
                       s.scope_kind, s.afi, s.safi, s.rib_type, s.scope_state,
                       s.current_epoch, s.eor_epoch, s.stale_reason,
                       COALESCE(SUM(CASE
                           WHEN s.scope_state NOT IN ('stale', 'down')
                            AND count.explicit_state <> 'stale'
                            AND count.connection_pk = s.last_connection_pk
                            AND count.rib_epoch >= s.current_epoch
                           THEN count.route_count ELSE 0
                       END), 0) AS active,
                       COALESCE(SUM(count.route_count), 0) - COALESCE(SUM(CASE
                           WHEN s.scope_state NOT IN ('stale', 'down')
                            AND count.explicit_state <> 'stale'
                            AND count.connection_pk = s.last_connection_pk
                            AND count.rib_epoch >= s.current_epoch
                           THEN count.route_count ELSE 0
                       END), 0) AS stale,
                       COALESCE(SUM(count.route_count), 0) AS total
                  FROM bmp_rib_scopes s
                  JOIN bmp_sources src ON src.source_pk = s.source_pk
                  LEFT JOIN bmp_connections conn ON conn.connection_pk = s.last_connection_pk
                  LEFT JOIN bmp_scope_route_counts count ON count.scope_pk = s.scope_pk
                  ${whereSql}
                 GROUP BY s.scope_pk
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
        addFilter('src.source_id = @sourceId', 'sourceId', query.sourceId);
        addFilter('s.scope_id = @scopeId', 'scopeId', query.scopeId);
        addFilter('s.owner_key = @ownerKey', 'ownerKey', query.ownerKey);
        addFilter('last_conn.connection_id = @connectionId', 'connectionId', query.connectionId);
        addFilter('s.scope_kind = @scopeKind', 'scopeKind', query.scopeKind);
        addFilter('r.afi = @afi', 'afi', finiteNumber(query.afi));
        addFilter('r.safi = @safi', 'safi', finiteNumber(query.safi));
        addFilter('s.rib_type = @ribType', 'ribType', query.ribType);
        addFilter('r.rib_epoch < @ribEpochBefore', 'ribEpochBefore', finiteNumber(query.ribEpochBefore));
        addFilter('r.prefix = @prefixExact', 'prefixExact', query.prefixExact);
        addFilter('r.prefix_length = @prefixLength', 'prefixLength', finiteNumber(query.prefixLength));
        const whereSql = `WHERE ${where.join(' AND ')}`;
        const reason = query.reason || 'manual-stale-purge';
        const currentRoutesSql = `(${buildExpandedCurrentRoutesSql(this.resolveQueryPartitions(query))})`;

        const purge = this.db.transaction(() => {
            const rows = this.db
                .prepare(
                    `
                    SELECT r.*, s.scope_id, src.source_id, s.source_pk, s.scope_kind, s.owner_key,
                           s.scope_identity_json,
                           s.peer_type, s.peer_rd, s.peer_ip, s.peer_as, s.vrf_name, s.rib_type,
                           s.current_epoch, s.eor_epoch, s.scope_state,
                           s.last_connection_pk, last_conn.connection_id AS last_connection_id,
                           s.stale_reason AS scope_stale_reason,
                           s.stale_since_ms, s.refresh_started_ms, s.updated_at_ms AS scope_updated_at_ms,
                           s.cleanup_pending_epoch,
                           route_attr.attr_id, route_attr.attr_json AS attr_json,
                           src.remote_ip AS source_remote_ip, src.sys_name, src.sys_desc,
                           conn.connection_id,
                           conn.local_ip AS connection_local_ip, conn.local_port AS connection_local_port,
                           conn.remote_ip AS connection_remote_ip, conn.remote_port AS connection_remote_port,
                           ${this.buildRouteStateSql()} AS effective_state
                      FROM ${currentRoutesSql} r
                      JOIN bmp_rib_scopes s ON s.scope_pk = r.scope_pk
                      JOIN bmp_sources src ON src.source_pk = s.source_pk
                      JOIN bmp_connections conn ON conn.connection_pk = r.connection_pk
                      LEFT JOIN bmp_connections last_conn ON last_conn.connection_pk = s.last_connection_pk
                      LEFT JOIN bmp_route_attributes route_attr ON route_attr.attr_pk = r.attr_pk
                      ${whereSql}
                     ORDER BY r.scope_pk, r.route_pk
                     LIMIT @limit
                `
                )
                .all({ ...params, limit: routeLimit + 1 });
            const hasMore = rows.length > routeLimit;
            const candidates = hasMore ? rows.slice(0, routeLimit) : rows;
            const deletedRows = [];
            candidates.forEach(row => {
                const partition = getBmpRoutePartitionById(row.partition_id);
                const deleted = this.getPartitionStatements(partition).deleteRoute.all({
                    scopePk: row.scope_pk,
                    routePk: row.route_pk
                });
                if (deleted.length > 0) {
                    this.addGcCandidates(deleted);
                    deletedRows.push(row);
                }
            });
            if (deletedRows.length > 0) {
                this.collectGarbage();
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
                sequence: null,
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

    purgeSource(query = {}) {
        if (this.readOnly) {
            throw new Error('Cannot purge a source from a read-only BMP persistence store');
        }
        if (!this.db) {
            this.open();
        }

        const sourceId = typeof query.sourceId === 'string' ? query.sourceId.trim().toLowerCase() : '';
        if (!/^[0-9a-f]{64}$/.test(sourceId)) {
            const error = new Error('BMP persistence sourceId must be a 64-character hexadecimal value');
            error.code = 'BMP_PERSISTENCE_INVALID_SOURCE_ID';
            throw error;
        }

        const purge = this.db.transaction(() => {
            const params = { sourceId };
            const counts = {
                sources: 0,
                connections: 0,
                scopes: 0,
                currentRoutes: 0,
                statisticsSamples: 0,
                statisticsLatest: 0,
                routeAttributes: 0,
                ingestBatches: 0,
                routeIdentities: 0,
                routePayloads: 0
            };
            const exists = this.db
                .prepare('SELECT source_pk FROM bmp_sources WHERE source_id = @sourceId LIMIT 1')
                .get(params);
            if (!exists) {
                return { sourceId, deleted: false, counts };
            }
            params.sourcePk = Number(exists.source_pk);

            const targetScopePks = 'SELECT scope_pk FROM bmp_rib_scopes WHERE source_pk = @sourcePk';
            const targetScopeIds = 'SELECT scope_id FROM bmp_rib_scopes WHERE source_pk = @sourcePk';
            const targetConnectionIds = 'SELECT connection_id FROM bmp_connections WHERE source_pk = @sourcePk';
            const sourcePartitions = this.db
                .prepare('SELECT DISTINCT partition_id FROM bmp_rib_scopes WHERE source_pk = @sourcePk')
                .all(params)
                .map(row => getBmpRoutePartitionById(row.partition_id));
            const remove = sql => this.db.prepare(sql).run(params).changes;
            const removeReturningRefs = sql => {
                const rows = this.db.prepare(sql).all(params);
                this.addGcCandidates(rows);
                return rows.length;
            };

            counts.statisticsLatest = remove(
                `DELETE FROM bmp_statistics_latest
                  WHERE source_id = @sourceId
                     OR sample_id IN (
                         SELECT sample_id
                           FROM bmp_statistics_samples
                          WHERE source_id = @sourceId
                             OR scope_id IN (${targetScopeIds})
                             OR connection_id IN (${targetConnectionIds})
                     )`
            );
            sourcePartitions.forEach(partition => {
                counts.currentRoutes += removeReturningRefs(
                    `DELETE FROM ${partition.quotedTableName}
                      WHERE scope_pk IN (${targetScopePks})
                  RETURNING route_pk, payload_id, attr_pk`
                );
            });
            counts.statisticsSamples = remove(
                `DELETE FROM bmp_statistics_samples
                  WHERE source_id = @sourceId
                     OR scope_id IN (${targetScopeIds})
                     OR connection_id IN (${targetConnectionIds})`
            );
            // Without foreign-key enforcement the counters no longer cascade
            // from the scope rows; remove them explicitly.
            remove(`DELETE FROM bmp_scope_route_counts WHERE scope_pk IN (${targetScopePks})`);
            counts.scopes = remove('DELETE FROM bmp_rib_scopes WHERE source_pk = @sourcePk');
            counts.connections = remove('DELETE FROM bmp_connections WHERE source_pk = @sourcePk');
            counts.sources = remove('DELETE FROM bmp_sources WHERE source_pk = @sourcePk');

            const garbage = this.collectGarbage();
            counts.routeAttributes = garbage.attributes;
            counts.routePayloads = garbage.payloads;
            counts.routeIdentities = garbage.identities;
            // Batch idempotency records only matter while some source still owns
            // data; once the last source is gone there is nothing left to guard.
            const remainingSources = this.db.prepare('SELECT 1 FROM bmp_sources LIMIT 1').get();
            counts.ingestBatches = remainingSources ? 0 : remove('DELETE FROM bmp_ingest_batches');

            return { sourceId, deleted: counts.sources > 0, counts };
        });

        return purge();
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
                  currentRoutes: this.db
                      .prepare('SELECT COALESCE(SUM(route_count), 0) AS count FROM bmp_scope_route_counts')
                      .get().count
              }
            : {
                  sources: null,
                  connections: null,
                  scopes: null,
                  currentRoutes: null
              };
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
        const mode = options.mode === 'lifecycle' ? 'lifecycle' : 'maintenance';
        const sourceId = mode === 'lifecycle' && typeof options.sourceId === 'string' ? options.sourceId.trim() : '';
        if (mode === 'lifecycle' && !sourceId) {
            throw new Error('BMP lifecycle persistence sweep requires sourceId');
        }
        const purgeExpiredStaleRoutes = mode === 'maintenance' && options.purgeExpiredStaleRoutes === true ? 1 : 0;
        const staleBeforeMs = finiteNumber(options.staleBeforeMs, Date.now() - 24 * 60 * 60 * 1000);
        const eventsBeforeMs = finiteNumber(options.eventsBeforeMs, Date.now() - 7 * 24 * 60 * 60 * 1000);
        const refreshTimeoutBeforeMs = finiteNumber(options.refreshTimeoutBeforeMs, Date.now() - 30 * 60 * 1000);
        const result = this.db.transaction(() => {
            // A lifecycle sweep for a source that was never persisted has nothing
            // to age; the sentinel matches no rows while deadline discovery below
            // stays global.
            const sourcePk = sourceId ? (this.statements.findSourcePk.get({ sourceId })?.source_pk ?? -1) : null;
            const sweepParams = {
                sourcePk: sourcePk === null ? null : Number(sourcePk),
                purgeExpiredStaleRoutes,
                staleBeforeMs,
                refreshTimeoutBeforeMs
            };
            const candidateScopes = this.db
                .prepare(
                    `
                    WITH single_open_connections AS (
                        SELECT source_pk,
                               MIN(connection_generation) AS connection_generation,
                               MIN(opened_at_ms) AS opened_at_ms
                          FROM bmp_connections
                         WHERE connection_state = 'open'
                           AND (@sourcePk IS NULL OR source_pk = @sourcePk)
                         GROUP BY source_pk
                        HAVING COUNT(*) = 1
                    ), reconnect_candidates AS (
                        SELECT scope.scope_pk, replacement.opened_at_ms AS refresh_started_ms
                          FROM bmp_rib_scopes scope
                          JOIN bmp_connections previous
                            ON previous.connection_pk = scope.last_connection_pk
                          JOIN single_open_connections replacement
                            ON replacement.source_pk = scope.source_pk
                         WHERE scope.scope_state IN ('stale', 'down')
                           AND COALESCE(scope.stale_reason, '') <> 'reconnect-refresh-timeout'
                           AND previous.connection_state = 'closed'
                           AND replacement.connection_generation > previous.connection_generation
                    )
                    SELECT scope.scope_pk, scope.scope_id, src.source_id, scope.partition_id, scope.scope_kind,
                           scope.owner_key, scope.afi, scope.safi, scope.rib_type,
                           scope.last_connection_pk, scope.current_epoch,
                           CASE
                               WHEN (
                                   @purgeExpiredStaleRoutes = 1
                                   AND
                                   scope.scope_state IN ('stale', 'down')
                                   AND scope.stale_since_ms <= @staleBeforeMs
                               ) OR reconnect.refresh_started_ms <= @refreshTimeoutBeforeMs
                               THEN 1 ELSE 0
                           END AS purge_all,
                           CASE
                               WHEN reconnect.refresh_started_ms <= @refreshTimeoutBeforeMs
                               THEN 1 ELSE 0
                           END AS reconnect_timeout
                      FROM bmp_rib_scopes scope
                      JOIN bmp_sources src ON src.source_pk = scope.source_pk
                      LEFT JOIN reconnect_candidates reconnect ON reconnect.scope_pk = scope.scope_pk
                     WHERE (@sourcePk IS NULL OR scope.source_pk = @sourcePk)
                       AND (
                            scope.cleanup_pending_epoch >= scope.current_epoch
                            OR (
                                scope.scope_state = 'syncing'
                                AND scope.refresh_started_ms <= @refreshTimeoutBeforeMs
                            )
                            OR (
                                @purgeExpiredStaleRoutes = 1
                                AND scope.scope_state IN ('stale', 'down')
                                AND scope.stale_since_ms <= @staleBeforeMs
                            )
                            OR reconnect.refresh_started_ms <= @refreshTimeoutBeforeMs
                       )
                     ORDER BY scope.scope_id
                `
                )
                .all(sweepParams);
            const candidateStatements = new Map();
            const affectedScopes = new Map();
            let routes = 0;
            for (const scope of candidateScopes) {
                if (routes >= routeLimit) {
                    break;
                }
                const partition = getBmpRoutePartitionById(scope.partition_id);
                let selectCandidates = candidateStatements.get(partition.partitionId);
                if (!selectCandidates) {
                    selectCandidates = this.db.prepare(`
                        SELECT route_pk
                          FROM ${partition.quotedTableName}
                         WHERE scope_pk = @scopePk
                           AND (
                               @purgeAll = 1
                               OR rib_epoch < @currentEpoch
                               OR connection_pk IS NOT @lastConnectionPk
                           )
                         ORDER BY route_pk
                         LIMIT @limit
                    `);
                    candidateStatements.set(partition.partitionId, selectCandidates);
                }
                const candidates = selectCandidates.all({
                    scopePk: scope.scope_pk,
                    purgeAll: scope.purge_all,
                    currentEpoch: scope.current_epoch,
                    lastConnectionPk: scope.last_connection_pk,
                    limit: routeLimit - routes
                });
                candidates.forEach(candidate => {
                    const deletedRows = this.getPartitionStatements(partition).deleteRoute.all({
                        scopePk: scope.scope_pk,
                        routePk: candidate.route_pk
                    });
                    const deleted = deletedRows.length;
                    this.addGcCandidates(deletedRows);
                    routes += deleted;
                    if (deleted > 0) {
                        const affected = affectedScopes.get(scope.scope_id) || {
                            sourceId: scope.source_id,
                            scopeId: scope.scope_id,
                            scopeKind: scope.scope_kind,
                            ownerKey: scope.owner_key,
                            afi: Number(scope.afi),
                            safi: Number(scope.safi),
                            ribType: scope.rib_type,
                            deletedRoutes: 0,
                            reason: scope.reconnect_timeout === 1 ? 'reconnect-refresh-timeout' : 'persistence-sweep'
                        };
                        affected.deletedRoutes += deleted;
                        affectedScopes.set(scope.scope_id, affected);
                    }
                });
            }
            const finalizedCleanupScopes = this.db
                .prepare(
                    `
                    UPDATE bmp_rib_scopes AS scope INDEXED BY idx_bmp_scopes_cleanup_pending
                       SET cleanup_pending_epoch = NULL
                     WHERE scope.cleanup_pending_epoch >= scope.current_epoch
                       AND scope.cleanup_pending_epoch IS NOT NULL
                       AND (@sourcePk IS NULL OR scope.source_pk = @sourcePk)
                       AND NOT EXISTS (
                           SELECT 1
                             FROM bmp_scope_route_counts count
                            WHERE count.scope_pk = scope.scope_pk
                              AND (
                                  count.connection_pk IS NOT scope.last_connection_pk
                                  OR count.rib_epoch < scope.current_epoch
                              )
                       )
                `
                )
                .run({ sourcePk: sweepParams.sourcePk }).changes;
            const refreshTimeoutScopes = this.db
                .prepare(
                    `
                    UPDATE bmp_rib_scopes AS scope
                       SET scope_state = 'ready', stale_reason = 'refresh-timeout',
                           refresh_started_ms = NULL,
                           updated_at_ms = MAX(updated_at_ms, @finalizedAtMs)
                     WHERE scope.scope_state = 'syncing'
                       AND (@sourcePk IS NULL OR scope.source_pk = @sourcePk)
                       AND scope.refresh_started_ms <= @refreshTimeoutBeforeMs
                       AND NOT EXISTS (
                           SELECT 1
                             FROM bmp_scope_route_counts count
                            WHERE count.scope_pk = scope.scope_pk
                              AND (
                                  count.connection_pk IS NOT scope.last_connection_pk
                                  OR count.rib_epoch < scope.current_epoch
                              )
                       )
                `
                )
                .run({
                    sourcePk: sweepParams.sourcePk,
                    refreshTimeoutBeforeMs,
                    finalizedAtMs: Date.now()
                }).changes;
            const reconnectTimeoutScopes = this.db
                .prepare(
                    `
                    WITH single_open_connections AS (
                        SELECT source_pk,
                               MIN(connection_generation) AS connection_generation,
                               MIN(opened_at_ms) AS opened_at_ms
                          FROM bmp_connections
                         WHERE connection_state = 'open'
                           AND (@sourcePk IS NULL OR source_pk = @sourcePk)
                         GROUP BY source_pk
                        HAVING COUNT(*) = 1
                    )
                    UPDATE bmp_rib_scopes AS scope
                       SET stale_reason = 'reconnect-refresh-timeout',
                           updated_at_ms = MAX(updated_at_ms, @finalizedAtMs)
                     WHERE scope.scope_state IN ('stale', 'down')
                       AND (@sourcePk IS NULL OR scope.source_pk = @sourcePk)
                       AND COALESCE(scope.stale_reason, '') <> 'reconnect-refresh-timeout'
                       AND EXISTS (
                           SELECT 1
                             FROM bmp_connections previous
                             JOIN single_open_connections replacement
                               ON replacement.source_pk = previous.source_pk
                            WHERE previous.connection_pk = scope.last_connection_pk
                              AND previous.connection_state = 'closed'
                              AND replacement.connection_generation > previous.connection_generation
                              AND replacement.opened_at_ms <= @refreshTimeoutBeforeMs
                       )
                       AND NOT EXISTS (
                           SELECT 1
                             FROM bmp_scope_route_counts count
                            WHERE count.scope_pk = scope.scope_pk
                       )
                `
                )
                .run({
                    sourcePk: sweepParams.sourcePk,
                    refreshTimeoutBeforeMs,
                    finalizedAtMs: Date.now()
                }).changes;
            const statistics =
                mode === 'lifecycle'
                    ? 0
                    : this.db
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
            const batches =
                mode === 'lifecycle'
                    ? 0
                    : this.db
                          .prepare(
                              `
                    DELETE FROM bmp_ingest_batches
                     WHERE batch_id IN (
                        SELECT batch.batch_id FROM bmp_ingest_batches batch
                         WHERE batch.created_at_ms <= @eventsBeforeMs
                         ORDER BY batch.created_at_ms
                         LIMIT @auxiliaryLimit
                     )
                `
                          )
                          .run({ eventsBeforeMs, auxiliaryLimit }).changes;
            const garbage =
                mode === 'lifecycle' ? { attributes: 0, payloads: 0, identities: 0 } : this.collectGarbage();
            if (mode !== 'lifecycle') {
                // Cheap incremental statistics refresh so the planner sees the
                // real table shapes after large ingests; no-op when nothing changed.
                this.db.pragma('optimize');
            }
            const attributes = garbage.attributes;
            const payloads = garbage.payloads;
            const identities = garbage.identities;
            const nextRefresh = this.db
                .prepare(
                    `
                    WITH single_open_connections AS (
                        SELECT source_pk,
                               MIN(connection_generation) AS connection_generation,
                               MIN(opened_at_ms) AS opened_at_ms
                          FROM bmp_connections
                         WHERE connection_state = 'open'
                         GROUP BY source_pk
                        HAVING COUNT(*) = 1
                    ), refresh_starts AS (
                        SELECT source_pk, refresh_started_ms AS started_at_ms
                          FROM bmp_rib_scopes
                         WHERE scope_state = 'syncing'
                           AND refresh_started_ms IS NOT NULL
                        UNION ALL
                        SELECT scope.source_pk, replacement.opened_at_ms AS started_at_ms
                          FROM bmp_rib_scopes scope
                          JOIN bmp_connections previous
                            ON previous.connection_pk = scope.last_connection_pk
                          JOIN single_open_connections replacement
                            ON replacement.source_pk = scope.source_pk
                         WHERE scope.scope_state IN ('stale', 'down')
                           AND COALESCE(scope.stale_reason, '') <> 'reconnect-refresh-timeout'
                           AND previous.connection_state = 'closed'
                           AND replacement.connection_generation > previous.connection_generation
                    )
                    SELECT src.source_id, refresh_starts.started_at_ms
                      FROM refresh_starts
                      JOIN bmp_sources src ON src.source_pk = refresh_starts.source_pk
                     ORDER BY refresh_starts.started_at_ms, src.source_id
                     LIMIT 1
                `
                )
                .get();
            return {
                routes,
                statistics,
                batches,
                attributes,
                payloads,
                identities,
                finalizedCleanupScopes,
                refreshTimeoutScopes,
                reconnectTimeoutScopes,
                affectedScopes: Array.from(affectedScopes.values()),
                nextRefreshStartedMs: finiteNumber(nextRefresh?.started_at_ms),
                nextRefreshSourceId: nextRefresh?.source_id || null,
                effectiveLimits: { routeLimit, eventLimit, auxiliaryLimit },
                hasMore:
                    routes >= routeLimit ||
                    statistics >= auxiliaryLimit ||
                    batches >= auxiliaryLimit ||
                    attributes >= auxiliaryLimit ||
                    payloads >= auxiliaryLimit ||
                    identities >= auxiliaryLimit
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
        this.partitionStatements = null;
        this.sqlTrace = null;
    }
}

BmpPersistenceStore.SCHEMA_VERSION = SCHEMA_VERSION;

module.exports = BmpPersistenceStore;
