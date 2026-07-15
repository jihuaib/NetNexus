const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const BgpConst = require('../../const/bgpConst');
const { getAfiAndSafi } = require('../../utils/bgpUtils');
const BgpRoute = require('./bgpRoute');
const { canonicalizeAttr } = require('./bgpPathAttrStore');

const SCHEMA_VERSION = 3;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 10000;
const DEFAULT_ITERATION_BATCH_SIZE = 2000;
const MAX_ITERATION_BATCH_SIZE = 10000;
const ATTRIBUTE_FIELDS = [
    'nextHop',
    'origin',
    'asPath',
    'med',
    'localPref',
    'communities',
    'customAttr',
    'rt',
    'srv6Sid',
    'srv6EndpointBehavior'
];

const ROUTE_TABLE_FAMILY_NAMES = Object.freeze([
    'IPV4_UNC',
    'IPV6_UNC',
    'L2VPN_EVPN',
    'VPNV4',
    'VPNV6',
    'IPV4_MVPN',
    'IPV6_MVPN',
    'IPV4_QP',
    'IPV6_QP',
    'IPV4_FLOWSPEC',
    'IPV6_FLOWSPEC',
    'IPV4_LABEL_UNICAST',
    'IPV6_LABEL_UNICAST',
    'LINK_STATE',
    'LINK_STATE_VPN',
    'IPV4_MULTICAST',
    'IPV6_MULTICAST'
]);
const ROUTE_TABLE_DEFINITIONS = Object.freeze(
    ROUTE_TABLE_FAMILY_NAMES.map(name => {
        const addressFamily = BgpConst.BGP_ADDR_FAMILY[name];
        const { afi, safi } = getAfiAndSafi(addressFamily);
        if (!Number.isInteger(afi) || !Number.isInteger(safi)) {
            throw new Error(`BGP address family ${name} does not have a valid AFI/SAFI mapping`);
        }
        return Object.freeze({
            name,
            addressFamily,
            afi,
            safi,
            key: `${afi}|${safi}`,
            tableName: `bgp_routes_${name.toLowerCase()}`
        });
    })
);
const ROUTE_TABLE_BY_FAMILY_KEY = new Map(ROUTE_TABLE_DEFINITIONS.map(definition => [definition.key, definition]));
const ROUTE_TABLE_NAMES = new Set(ROUTE_TABLE_DEFINITIONS.map(definition => definition.tableName));

function parseInstanceFamily(instanceKey) {
    const parts = normalizeInstanceKey(instanceKey).split('|');
    if (parts.length < 3) {
        throw new Error(`BGP route SQLite instanceKey ${instanceKey} must end with AFI|SAFI`);
    }
    const afiText = parts[parts.length - 2];
    const safiText = parts[parts.length - 1];
    if (!/^\d+$/.test(afiText) || !/^\d+$/.test(safiText)) {
        throw new Error(`BGP route SQLite instanceKey ${instanceKey} must end with numeric AFI|SAFI`);
    }
    const afi = Number(afiText);
    const safi = Number(safiText);
    const definition = ROUTE_TABLE_BY_FAMILY_KEY.get(`${afi}|${safi}`);
    if (!definition) {
        throw new Error(`BGP route SQLite does not support AFI ${afi} SAFI ${safi}`);
    }
    return definition;
}

function routeTableSchemaSql(tableName) {
    if (!ROUTE_TABLE_NAMES.has(tableName)) {
        throw new Error(`Invalid BGP route SQLite table name: ${tableName}`);
    }
    return `
        CREATE TABLE ${tableName} (
            route_id INTEGER PRIMARY KEY,
            instance_id INTEGER NOT NULL,
            route_key TEXT NOT NULL,
            prefix TEXT,
            prefix_length INTEGER,
            rd TEXT,
            path_id INTEGER NOT NULL DEFAULT 0,
            route_type INTEGER,
            originating_router_ip TEXT,
            source_ip TEXT,
            group_ip TEXT,
            source_as INTEGER,
            dqpn INTEGER,
            label INTEGER,
            attr_id INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            UNIQUE(instance_id, route_key),
            FOREIGN KEY (instance_id) REFERENCES bgp_route_instances(instance_id) ON DELETE CASCADE,
            FOREIGN KEY (attr_id) REFERENCES bgp_route_attributes(attr_id)
        );

        CREATE INDEX idx_${tableName}_instance_order
            ON ${tableName}(instance_id, route_id);
        CREATE INDEX idx_${tableName}_instance_prefix
            ON ${tableName}(instance_id, prefix, prefix_length, path_id, route_id);
        CREATE INDEX idx_${tableName}_instance_unicast_best
            ON ${tableName}(instance_id, rd, prefix, prefix_length, path_id, route_id);
        CREATE INDEX idx_${tableName}_instance_attr
            ON ${tableName}(instance_id, attr_id, route_id);
        CREATE INDEX idx_${tableName}_attr
            ON ${tableName}(attr_id);
        CREATE INDEX idx_${tableName}_instance_type
            ON ${tableName}(instance_id, route_type, route_id);
    `;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) {
        return fallback;
    }
    return Math.min(number, maximum);
}

function nullableInteger(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
}

function nullableString(value) {
    return value === undefined || value === null || value === '' ? null : String(value);
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

function normalizeInstanceKey(value) {
    const instanceKey = String(value ?? '').trim();
    if (!instanceKey) {
        throw new Error('BGP route SQLite instanceKey is required');
    }
    return instanceKey;
}

function makeMvpnRouteKey(route) {
    const routeType = Number(route?.routeType);
    const sourceAs = [
        BgpConst.BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD,
        BgpConst.BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
        BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
    ].includes(routeType)
        ? route?.sourceAs || ''
        : '';
    return [
        route?.routeType,
        route?.rd,
        sourceAs,
        route?.sourceIp || '',
        route?.groupIp || '',
        route?.originatingRouterIp || ''
    ].join('|');
}

function deriveRouteKey(route) {
    if (route?.routeKey !== undefined && route?.routeKey !== null && route.routeKey !== '') {
        return String(route.routeKey);
    }
    if (route?.dqpn !== undefined && route?.dqpn !== null && route?.dqpn !== '') {
        return BgpRoute.makeQpKey(route.dqpn, route.ip, route.mask);
    }
    if (route?.routeType !== undefined && route?.routeType !== null && route?.routeType !== '') {
        return makeMvpnRouteKey(route);
    }
    if (
        (route?.rd !== undefined && route?.rd !== null && route?.rd !== '') ||
        (route?.pathId !== undefined && route?.pathId !== null && route?.pathId !== '')
    ) {
        return BgpRoute.makeUnicastKey(route.pathId, route.rd, route.ip, route.mask);
    }
    if (route?.ip !== undefined && route?.mask !== undefined) {
        return BgpRoute.makeKey(route.ip, route.mask);
    }
    throw new Error('BGP route SQLite routeKey is required for a route without a derivable NLRI key');
}

function extractInlineAttribute(route) {
    const attr = {};
    ATTRIBUTE_FIELDS.forEach(field => {
        if (Object.prototype.hasOwnProperty.call(route || {}, field)) {
            attr[field] = route[field];
        }
    });
    return attr;
}

function canonicalAttributeJson(attr) {
    return JSON.stringify(canonicalizeAttr(attr || {}));
}

function attributeHash(canonicalJson) {
    return crypto.createHash('sha256').update(canonicalJson).digest();
}

function normalizeRouteInput(input, options = {}) {
    const wrapper = input && input.route && typeof input.route === 'object' ? input : null;
    const route = wrapper ? wrapper.route : input;
    if (!route || typeof route !== 'object') {
        throw new Error('BGP route SQLite upsert requires a route object');
    }

    const explicitRouteKey =
        options.routeKey ?? wrapper?.routeKey ?? (route.routeKey === undefined ? null : route.routeKey);
    const routeKey =
        explicitRouteKey === null || explicitRouteKey === undefined || explicitRouteKey === ''
            ? deriveRouteKey(route)
            : String(explicitRouteKey);
    let attr = options.attr ?? wrapper?.attr ?? wrapper?.routeAttr ?? route.routeAttr;
    if (attr === undefined && typeof route.bgpInstance?.getRouteAttr === 'function') {
        attr = route.bgpInstance.getRouteAttr(route);
    }
    if (attr === undefined) {
        attr = extractInlineAttribute(route);
    }

    return {
        routeKey,
        prefix: nullableString(route.ip ?? route.prefix),
        prefixLength: nullableInteger(route.mask ?? route.prefixLength ?? route.length),
        rd: nullableString(route.rd),
        pathId: nullableInteger(route.pathId) ?? 0,
        routeType: nullableInteger(route.routeType),
        originatingRouterIp: nullableString(route.originatingRouterIp),
        sourceIp: nullableString(route.sourceIp),
        groupIp: nullableString(route.groupIp),
        sourceAs: nullableInteger(route.sourceAs),
        dqpn: nullableInteger(route.dqpn),
        label: nullableInteger(route.label),
        attr
    };
}

function getDeleteRouteKey(value) {
    if (typeof value === 'string' || typeof value === 'number') {
        const key = String(value);
        if (key) {
            return key;
        }
    }
    if (value && typeof value === 'object') {
        if (value.routeKey !== undefined && value.routeKey !== null && value.routeKey !== '') {
            return String(value.routeKey);
        }
        return deriveRouteKey(value.route || value);
    }
    throw new Error('BGP route SQLite delete requires a route key');
}

class BgpRouteMapFacade {
    constructor(store, instanceKey, options = {}) {
        this.store = store;
        this.instanceKey = normalizeInstanceKey(instanceKey);
        this.serialize = typeof options.serialize === 'function' ? options.serialize : null;
        this.hydrate = typeof options.hydrate === 'function' ? options.hydrate : null;
    }

    get size() {
        return this.store.getRouteCount(this.instanceKey);
    }

    get [Symbol.toStringTag]() {
        return 'BgpRouteMapFacade';
    }

    serializeValue(key, value) {
        if (!this.serialize) {
            return { routeKey: key, route: value };
        }
        const serialized = this.serialize(value, key, this.instanceKey);
        if (serialized && serialized.route && typeof serialized.route === 'object') {
            return { routeKey: key, ...serialized };
        }
        return { routeKey: key, route: serialized };
    }

    hydrateValue(value, context = {}) {
        if (!value || !this.hydrate) {
            return value;
        }
        return this.hydrate(value, value.routeKey, {
            instanceKey: this.instanceKey,
            ...context
        });
    }

    set(key, value) {
        this.store.upsertRoutes(this.instanceKey, [this.serializeValue(String(key), value)]);
        return this;
    }

    setWithAttr(key, value, attr) {
        this.store.upsertRoutes(this.instanceKey, [{ ...this.serializeValue(String(key), value), attr }]);
        return this;
    }

    setRouteAttr(key, attr) {
        return this.store.updateRouteAttr(this.instanceKey, String(key), attr);
    }

    get(key) {
        return this.hydrateValue(this.store.getRoute(this.instanceKey, String(key)));
    }

    has(key) {
        return this.store.hasRoute(this.instanceKey, String(key));
    }

    delete(key) {
        return this.store.deleteRoute(this.instanceKey, String(key));
    }

    clear() {
        this.store.clearInstance(this.instanceKey);
    }

    *keys() {
        yield* this.store.iterateRouteKeys(this.instanceKey);
    }

    *values() {
        for (const route of this.store.iterateRoutes(this.instanceKey)) {
            yield this.hydrateValue(route);
        }
    }

    *entries() {
        for (const route of this.store.iterateRoutes(this.instanceKey)) {
            yield [route.routeKey, this.hydrateValue(route)];
        }
    }

    [Symbol.iterator]() {
        return this.entries();
    }

    forEach(callback, thisArg = undefined) {
        if (typeof callback !== 'function') {
            throw new TypeError('BgpRouteMapFacade.forEach callback must be a function');
        }
        for (const [key, value] of this.entries()) {
            callback.call(thisArg, value, key, this);
        }
    }

    upsertMany(entries, options = {}) {
        const routes = [];
        for (const entry of entries || []) {
            if (Array.isArray(entry)) {
                routes.push(this.serializeValue(String(entry[0]), entry[1]));
            } else {
                routes.push(entry);
            }
        }
        return this.store.upsertRoutes(this.instanceKey, routes, options);
    }

    deleteMany(keys) {
        return this.store.deleteRoutes(this.instanceKey, Array.from(keys || []));
    }

    queryPage(options = {}) {
        const result = this.store.queryPage(this.instanceKey, options);
        return {
            ...result,
            list: result.list.map(route => this.hydrateValue(route))
        };
    }

    queryPrefix(prefix, options = {}) {
        const result = this.store.queryPrefix(this.instanceKey, prefix, options);
        return {
            ...result,
            list: result.list.map(route => this.hydrateValue(route))
        };
    }

    *iterateBatches(options = {}) {
        for (const batch of this.store.iterateRouteBatches(this.instanceKey, options)) {
            yield batch.map(route => this.hydrateValue(route));
        }
    }

    *iterateAttrGroups(options = {}) {
        for (const group of this.store.iterateAttrGroups(this.instanceKey, options)) {
            yield {
                ...group,
                routes: group.routes.map(route => this.hydrateValue(route, { attr: group.attr }))
            };
        }
    }
}

class BgpRouteSqliteStore {
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
        this.instances = new Map();
        this.routeStatements = new Map();
        this.dynamicStatements = new Map();
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
            if (!this.readOnly) {
                if (this.dbPath !== ':memory:') {
                    this.db.pragma('journal_mode = WAL');
                    this.db.pragma('wal_autocheckpoint = 2000');
                }
                this.db.pragma('synchronous = NORMAL');
                this.db.pragma('temp_store = MEMORY');
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
            throw new Error('Cannot write to a read-only BGP route SQLite store');
        }
    }

    initializeSchema() {
        const currentVersion = this.db.pragma('user_version', { simple: true });
        if (currentVersion === SCHEMA_VERSION) {
            return;
        }
        if (currentVersion !== 0) {
            throw new Error(
                `BGP route SQLite schema ${currentVersion} is incompatible with schema ${SCHEMA_VERSION}; data migration is not supported across major versions`
            );
        }

        const initializeTransaction = this.db.transaction(() => {
            const existingObjects = this.db
                .prepare(
                    `SELECT type, name
                       FROM sqlite_master
                      WHERE name NOT LIKE 'sqlite_%'
                      ORDER BY type, name`
                )
                .all();
            if (existingObjects.length > 0) {
                throw new Error(
                    `BGP route SQLite schema 0 is not empty; data migration is not supported across major versions`
                );
            }

            this.db.exec(`
                CREATE TABLE bgp_route_instances (
                    instance_id INTEGER PRIMARY KEY,
                    instance_key TEXT NOT NULL UNIQUE,
                    afi INTEGER NOT NULL,
                    safi INTEGER NOT NULL,
                    route_count INTEGER NOT NULL DEFAULT 0 CHECK(route_count >= 0),
                    revision INTEGER NOT NULL DEFAULT 0,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );

                CREATE TABLE bgp_route_attributes (
                    attr_id INTEGER PRIMARY KEY,
                    attr_hash BLOB NOT NULL UNIQUE,
                    attr_json TEXT NOT NULL
                );
            `);
            ROUTE_TABLE_DEFINITIONS.forEach(definition => {
                this.db.exec(routeTableSchemaSql(definition.tableName));
            });
            this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
        });
        initializeTransaction.immediate();
    }

    validateSchema() {
        const version = this.db.pragma('user_version', { simple: true });
        if (version !== SCHEMA_VERSION) {
            throw new Error(`BGP route SQLite schema ${version} does not match expected schema ${SCHEMA_VERSION}`);
        }
        const required = {
            bgp_route_instances: ['instance_id', 'instance_key', 'afi', 'safi', 'route_count', 'revision'],
            bgp_route_attributes: ['attr_id', 'attr_hash', 'attr_json']
        };
        ROUTE_TABLE_DEFINITIONS.forEach(definition => {
            required[definition.tableName] = ['route_id', 'instance_id', 'route_key', 'prefix', 'attr_id'];
        });
        Object.entries(required).forEach(([table, columns]) => {
            const actual = new Set(this.db.pragma(`table_info(${table})`).map(column => column.name));
            columns.forEach(column => {
                if (!actual.has(column)) {
                    throw new Error(`BGP route SQLite schema is missing ${table}.${column}`);
                }
            });
        });
    }

    prepareStatements() {
        if (!this.readOnly) {
            this.db.exec(`
                CREATE TEMP TABLE IF NOT EXISTS bgp_route_orphan_candidates (
                    attr_id INTEGER PRIMARY KEY
                ) WITHOUT ROWID;
            `);
        }
        const orphanAttributePredicates = ROUTE_TABLE_DEFINITIONS.map(
            definition => `NOT EXISTS (SELECT 1 FROM ${definition.tableName} route WHERE route.attr_id = attr.attr_id)`
        ).join('\n                        AND ');
        this.statements = {
            insertInstance: this.db.prepare(`
                INSERT OR IGNORE INTO bgp_route_instances(
                    instance_key, afi, safi, route_count, revision, created_at_ms, updated_at_ms
                ) VALUES (@instanceKey, @afi, @safi, 0, 0, @now, @now)
            `),
            findInstance: this.db.prepare(`
                SELECT instance_id, instance_key, afi, safi, route_count, revision, created_at_ms, updated_at_ms
                  FROM bgp_route_instances
                 WHERE instance_key = @instanceKey
                 LIMIT 1
            `),
            updateInstance: this.db.prepare(`
                UPDATE bgp_route_instances
                   SET route_count = MAX(0, route_count + @countDelta),
                       revision = revision + @revisionDelta,
                       updated_at_ms = CASE WHEN @revisionDelta > 0 THEN @now ELSE updated_at_ms END
                 WHERE instance_id = @instanceId
            `),
            insertAttribute: this.db.prepare(`
                INSERT OR IGNORE INTO bgp_route_attributes(attr_hash, attr_json)
                VALUES (@attrHash, @attrJson)
            `),
            findAttribute: this.db.prepare(`
                SELECT attr_id, attr_hash, attr_json
                  FROM bgp_route_attributes
                 WHERE attr_hash = @attrHash
                 LIMIT 1
            `),
            deleteOrphanAttributes: this.db.prepare(`
                DELETE FROM bgp_route_attributes
                 WHERE attr_id IN (
                     SELECT attr.attr_id
                       FROM bgp_route_attributes attr
                      WHERE ${orphanAttributePredicates}
                      ORDER BY attr.attr_id
                      LIMIT @limit
                 )
            `),
            countInstances: this.db.prepare('SELECT COUNT(*) AS count FROM bgp_route_instances'),
            countAttributes: this.db.prepare('SELECT COUNT(*) AS count FROM bgp_route_attributes'),
            sumRoutes: this.db.prepare('SELECT COALESCE(SUM(route_count), 0) AS count FROM bgp_route_instances')
        };
        if (!this.readOnly) {
            this.statements.deleteCandidateOrphanAttributes = this.db.prepare(`
                DELETE FROM bgp_route_attributes
                 WHERE attr_id IN (
                     SELECT attr.attr_id
                       FROM bgp_route_orphan_candidates candidate
                       JOIN bgp_route_attributes attr ON attr.attr_id = candidate.attr_id
                      WHERE ${orphanAttributePredicates}
                      ORDER BY attr.attr_id
                      LIMIT @limit
                 )
            `);
            this.statements.rememberAttributeCandidate = this.db.prepare(`
                INSERT OR IGNORE INTO bgp_route_orphan_candidates(attr_id) VALUES (@attrId)
            `);
            this.statements.clearOrphanCandidates = this.db.prepare('DELETE FROM bgp_route_orphan_candidates');
        }
    }

    getRouteTableDefinition(instance) {
        const afi = Number(instance?.afi);
        const safi = Number(instance?.safi);
        const definition = ROUTE_TABLE_BY_FAMILY_KEY.get(`${afi}|${safi}`);
        if (!definition) {
            throw new Error(`BGP route SQLite instance uses unsupported AFI ${afi} SAFI ${safi}`);
        }
        return definition;
    }

    getRouteStatements(instance) {
        const definition = this.getRouteTableDefinition(instance);
        const { tableName } = definition;
        let statements = this.routeStatements.get(tableName);
        if (statements) {
            return statements;
        }
        statements = {
            countAttributeRefs: this.db.prepare(`
                SELECT COUNT(*) AS count
                  FROM ${tableName}
                 WHERE instance_id = @instanceId AND attr_id = @attrId
            `),
            insertRoute: this.db.prepare(`
                INSERT OR IGNORE INTO ${tableName}(
                    instance_id, route_key, prefix, prefix_length, rd, path_id, route_type,
                    originating_router_ip, source_ip, group_ip, source_as, dqpn, label, attr_id,
                    created_at_ms, updated_at_ms
                ) VALUES (
                    @instanceId, @routeKey, @prefix, @prefixLength, @rd, @pathId, @routeType,
                    @originatingRouterIp, @sourceIp, @groupIp, @sourceAs, @dqpn, @label, @attrId,
                    @now, @now
                )
            `),
            updateRoute: this.db.prepare(`
                UPDATE ${tableName}
                   SET prefix = @prefix,
                       prefix_length = @prefixLength,
                       rd = @rd,
                       path_id = @pathId,
                       route_type = @routeType,
                       originating_router_ip = @originatingRouterIp,
                       source_ip = @sourceIp,
                       group_ip = @groupIp,
                       source_as = @sourceAs,
                       dqpn = @dqpn,
                       label = @label,
                       attr_id = @attrId,
                       updated_at_ms = @now
                 WHERE instance_id = @instanceId AND route_key = @routeKey
                   AND (
                       prefix IS NOT @prefix OR prefix_length IS NOT @prefixLength OR rd IS NOT @rd
                       OR path_id IS NOT @pathId OR route_type IS NOT @routeType
                       OR originating_router_ip IS NOT @originatingRouterIp OR source_ip IS NOT @sourceIp
                       OR group_ip IS NOT @groupIp OR source_as IS NOT @sourceAs OR dqpn IS NOT @dqpn
                       OR label IS NOT @label OR attr_id IS NOT @attrId
                   )
            `),
            updateRouteAttribute: this.db.prepare(`
                UPDATE ${tableName}
                   SET attr_id = @attrId, updated_at_ms = @now
                 WHERE instance_id = @instanceId AND route_key = @routeKey AND attr_id IS NOT @attrId
            `),
            deleteRoute: this.db.prepare(`
                DELETE FROM ${tableName} WHERE instance_id = @instanceId AND route_key = @routeKey
            `),
            clearInstance: this.db.prepare(`DELETE FROM ${tableName} WHERE instance_id = @instanceId`),
            hasRoute: this.db.prepare(`
                SELECT 1 AS present
                  FROM ${tableName}
                 WHERE instance_id = @instanceId AND route_key = @routeKey
                 LIMIT 1
            `),
            getRoute: this.db.prepare(`${this.routeSelectSql(tableName)}
                 WHERE r.instance_id = @instanceId AND r.route_key = @routeKey
                 LIMIT 1`),
            iterateKeys: this.db.prepare(`
                SELECT route_key FROM ${tableName} WHERE instance_id = @instanceId ORDER BY route_id
            `)
        };
        if (!this.readOnly) {
            statements.rememberRouteAttribute = this.db.prepare(`
                INSERT OR IGNORE INTO bgp_route_orphan_candidates(attr_id)
                SELECT attr_id
                  FROM ${tableName}
                 WHERE instance_id = @instanceId AND route_key = @routeKey
            `);
            statements.rememberInstanceAttributes = this.db.prepare(`
                INSERT OR IGNORE INTO bgp_route_orphan_candidates(attr_id)
                SELECT DISTINCT attr_id
                  FROM ${tableName}
                 WHERE instance_id = @instanceId
            `);
        }
        this.routeStatements.set(tableName, statements);
        return statements;
    }

    routeSelectSql(tableName) {
        if (!ROUTE_TABLE_NAMES.has(tableName)) {
            throw new Error(`Invalid BGP route SQLite table name: ${tableName}`);
        }
        return `SELECT r.*, attr.attr_hash, attr.attr_json
                  FROM ${tableName} r
                  JOIN bgp_route_attributes attr ON attr.attr_id = r.attr_id`;
    }

    getInstance(instanceKey) {
        this.ensureOpen();
        const normalized = normalizeInstanceKey(instanceKey);
        const cached = this.instances.get(normalized);
        if (cached) {
            return cached;
        }
        const row = this.statements.findInstance.get({ instanceKey: normalized });
        if (row) {
            this.getRouteTableDefinition(row);
            this.instances.set(normalized, row);
        }
        return row || null;
    }

    ensureInstance(instanceKey, now = Date.now()) {
        const normalized = normalizeInstanceKey(instanceKey);
        const definition = parseInstanceFamily(normalized);
        const existing = this.getInstance(normalized);
        if (existing) {
            if (Number(existing.afi) !== definition.afi || Number(existing.safi) !== definition.safi) {
                throw new Error(`BGP route SQLite instance ${normalized} has inconsistent AFI/SAFI metadata`);
            }
            return existing;
        }
        this.statements.insertInstance.run({
            instanceKey: normalized,
            afi: definition.afi,
            safi: definition.safi,
            now
        });
        const row = this.statements.findInstance.get({ instanceKey: normalized });
        if (!row) {
            throw new Error(`Failed to create BGP route SQLite instance ${normalized}`);
        }
        this.instances.set(normalized, row);
        return row;
    }

    resolveAttribute(attr, cache = null) {
        const attrJson = canonicalAttributeJson(attr);
        const cached = cache?.get(attrJson);
        if (cached !== undefined) {
            return cached;
        }
        const attrHash = attributeHash(attrJson);
        this.statements.insertAttribute.run({ attrHash, attrJson });
        const row = this.statements.findAttribute.get({ attrHash });
        if (!row || row.attr_json !== attrJson) {
            throw new Error('BGP route SQLite attribute hash collision or insertion failure');
        }
        cache?.set(attrJson, row.attr_id);
        return row.attr_id;
    }

    buildRouteParams(instanceId, route, attrId, now) {
        return {
            instanceId,
            routeKey: route.routeKey,
            prefix: route.prefix,
            prefixLength: route.prefixLength,
            rd: route.rd,
            pathId: route.pathId,
            routeType: route.routeType,
            originatingRouterIp: route.originatingRouterIp,
            sourceIp: route.sourceIp,
            groupIp: route.groupIp,
            sourceAs: route.sourceAs,
            dqpn: route.dqpn,
            label: route.label,
            attrId,
            now
        };
    }

    applyBatch(batch = {}) {
        this.assertWritable();
        const instanceKey = normalizeInstanceKey(batch.instanceKey);
        const upserts = Array.isArray(batch.upserts) ? batch.upserts : Array.isArray(batch.routes) ? batch.routes : [];
        const deletes = Array.isArray(batch.deletes)
            ? batch.deletes
            : Array.isArray(batch.deleteKeys)
              ? batch.deleteKeys
              : [];
        const now = Number.isFinite(Number(batch.updatedAtMs)) ? Number(batch.updatedAtMs) : Date.now();
        const transaction = this.db.transaction(() => {
            const instance = this.ensureInstance(instanceKey, now);
            const instanceId = instance.instance_id;
            const routeStatements = this.getRouteStatements(instance);
            const attrCache = new Map();
            let inserted = 0;
            let updated = 0;
            let unchanged = 0;
            let deleted = 0;

            if (batch.clear === true) {
                routeStatements.rememberInstanceAttributes.run({ instanceId });
                deleted += routeStatements.clearInstance.run({ instanceId }).changes;
            }
            deletes.forEach(value => {
                const routeKey = getDeleteRouteKey(value);
                routeStatements.rememberRouteAttribute.run({ instanceId, routeKey });
                deleted += routeStatements.deleteRoute.run({ instanceId, routeKey }).changes;
            });
            upserts.forEach(input => {
                const wrapperAttr = input && input.route && typeof input.route === 'object' ? input.attr : undefined;
                const route = normalizeRouteInput(input, {
                    attr: wrapperAttr === undefined ? (batch.attr ?? batch.routeAttr) : wrapperAttr
                });
                const attrId = this.resolveAttribute(route.attr, attrCache);
                const params = this.buildRouteParams(instanceId, route, attrId, now);
                const insertResult = routeStatements.insertRoute.run(params);
                if (insertResult.changes > 0) {
                    inserted += 1;
                    return;
                }
                routeStatements.rememberRouteAttribute.run({
                    instanceId,
                    routeKey: route.routeKey
                });
                const updateResult = routeStatements.updateRoute.run(params);
                if (updateResult.changes > 0) {
                    updated += 1;
                } else {
                    unchanged += 1;
                }
            });

            const changed = inserted + updated + deleted;
            this.statements.updateInstance.run({
                instanceId,
                countDelta: inserted - deleted,
                revisionDelta: changed > 0 ? 1 : 0,
                now
            });
            this.cleanupOrphanCandidates();
            const stats = this.statements.findInstance.get({ instanceKey });
            return {
                instanceKey,
                inserted,
                updated,
                unchanged,
                deleted,
                changed,
                total: Number(stats?.route_count || 0),
                revision: Number(stats?.revision || 0)
            };
        });
        try {
            return transaction();
        } catch (error) {
            this.instances.delete(instanceKey);
            throw error;
        }
    }

    upsertRoutes(instanceKey, routes, options = {}) {
        return this.applyBatch({
            instanceKey,
            upserts: Array.from(routes || []),
            attr: options.attr,
            routeAttr: options.routeAttr,
            updatedAtMs: options.updatedAtMs
        });
    }

    upsertRoute(instanceKey, routeKey, route, attr = undefined) {
        if (route === undefined && routeKey && typeof routeKey === 'object') {
            route = routeKey;
            routeKey = undefined;
        }
        return this.upsertRoutes(instanceKey, [{ routeKey, route, attr }]);
    }

    deleteRoutes(instanceKey, routeKeys) {
        return this.applyBatch({ instanceKey, deletes: Array.from(routeKeys || []) });
    }

    deleteRoute(instanceKey, routeKey) {
        return this.deleteRoutes(instanceKey, [routeKey]).deleted > 0;
    }

    clearInstance(instanceKey) {
        return this.applyBatch({ instanceKey, clear: true });
    }

    updateRouteAttr(instanceKey, routeKey, attr) {
        this.assertWritable();
        const normalized = normalizeInstanceKey(instanceKey);
        const now = Date.now();
        const transaction = this.db.transaction(() => {
            const instance = this.getInstance(normalized);
            if (!instance) {
                return false;
            }
            const routeStatements = this.getRouteStatements(instance);
            routeStatements.rememberRouteAttribute.run({
                instanceId: instance.instance_id,
                routeKey: String(routeKey)
            });
            const attrId = this.resolveAttribute(attr);
            this.statements.rememberAttributeCandidate.run({ attrId });
            const changed = routeStatements.updateRouteAttribute.run({
                instanceId: instance.instance_id,
                routeKey: String(routeKey),
                attrId,
                now
            }).changes;
            if (changed > 0) {
                this.statements.updateInstance.run({
                    instanceId: instance.instance_id,
                    countDelta: 0,
                    revisionDelta: 1,
                    now
                });
            }
            this.cleanupOrphanCandidates();
            return changed > 0;
        });
        return transaction();
    }

    deletePrefix(instanceKey, prefix, options = {}) {
        this.assertWritable();
        const normalized = normalizeInstanceKey(instanceKey);
        const instance = this.getInstance(normalized);
        if (!instance) {
            return { deleted: 0, total: 0, revision: 0 };
        }
        const where = ['instance_id = @instanceId', 'prefix = @prefix'];
        const params = { instanceId: instance.instance_id, prefix: String(prefix) };
        if (nullableInteger(options.prefixLength) !== null) {
            where.push('prefix_length = @prefixLength');
            params.prefixLength = Number(options.prefixLength);
        }
        if (nullableInteger(options.pathId) !== null) {
            where.push('path_id = @pathId');
            params.pathId = Number(options.pathId);
        }
        if (options.rd !== undefined && options.rd !== null && options.rd !== '') {
            where.push('rd = @rd');
            params.rd = String(options.rd);
        }
        const { tableName } = this.getRouteTableDefinition(instance);
        const statementKey = `${tableName}:delete-prefix:${where.join('|')}`;
        const rememberAttributes = this.getDynamicStatement(`${statementKey}:attributes`, () =>
            this.db.prepare(`
                INSERT OR IGNORE INTO bgp_route_orphan_candidates(attr_id)
                SELECT DISTINCT attr_id FROM ${tableName} WHERE ${where.join(' AND ')}
            `)
        );
        const statement = this.getDynamicStatement(statementKey, () =>
            this.db.prepare(`DELETE FROM ${tableName} WHERE ${where.join(' AND ')}`)
        );
        const now = Date.now();
        return this.db.transaction(() => {
            rememberAttributes.run(params);
            const deleted = statement.run(params).changes;
            this.statements.updateInstance.run({
                instanceId: instance.instance_id,
                countDelta: -deleted,
                revisionDelta: deleted > 0 ? 1 : 0,
                now
            });
            this.cleanupOrphanCandidates();
            const stats = this.statements.findInstance.get({ instanceKey: normalized });
            return {
                deleted,
                total: Number(stats?.route_count || 0),
                revision: Number(stats?.revision || 0)
            };
        })();
    }

    getRouteCount(instanceKey = null) {
        this.ensureOpen();
        if (instanceKey === null || instanceKey === undefined) {
            return Number(this.statements.sumRoutes.get().count || 0);
        }
        const instance = this.statements.findInstance.get({ instanceKey: normalizeInstanceKey(instanceKey) });
        return Number(instance?.route_count || 0);
    }

    getInstanceStats(instanceKey) {
        this.ensureOpen();
        const row = this.statements.findInstance.get({ instanceKey: normalizeInstanceKey(instanceKey) });
        return row
            ? {
                  instanceKey: row.instance_key,
                  routeCount: Number(row.route_count),
                  revision: Number(row.revision),
                  createdAtMs: Number(row.created_at_ms),
                  updatedAtMs: Number(row.updated_at_ms)
              }
            : { instanceKey: normalizeInstanceKey(instanceKey), routeCount: 0, revision: 0 };
    }

    resolveAttributeId(attrId) {
        let attrHash = null;
        if (Buffer.isBuffer(attrId)) {
            attrHash = attrId;
        } else if (typeof attrId === 'string' && /^[a-f0-9]{64}$/i.test(attrId)) {
            attrHash = Buffer.from(attrId, 'hex');
        }
        if (!attrHash && Number.isInteger(Number(attrId)) && String(attrId).trim() !== '') {
            return Number(attrId);
        }
        if (!attrHash) {
            return null;
        }
        return this.statements.findAttribute.get({ attrHash })?.attr_id ?? null;
    }

    getAttributeRefCount(instanceKey, attrId) {
        this.ensureOpen();
        const instance = this.getInstance(instanceKey);
        const resolvedAttrId = this.resolveAttributeId(attrId);
        if (!instance || resolvedAttrId === null) {
            return 0;
        }
        return Number(
            this.getRouteStatements(instance).countAttributeRefs.get({
                instanceId: instance.instance_id,
                attrId: resolvedAttrId
            }).count || 0
        );
    }

    getAttributeCount(instanceKey, attrId) {
        return this.getAttributeRefCount(instanceKey, attrId);
    }

    getInstanceAttributeCount(instanceKey) {
        this.ensureOpen();
        const instance = this.getInstance(instanceKey);
        if (!instance) {
            return 0;
        }
        const { tableName } = this.getRouteTableDefinition(instance);
        const statement = this.getDynamicStatement(`${tableName}:count-instance-attributes`, () =>
            this.db.prepare(`SELECT COUNT(DISTINCT attr_id) AS count FROM ${tableName} WHERE instance_id = @instanceId`)
        );
        return Number(statement.get({ instanceId: instance.instance_id }).count || 0);
    }

    hasRoute(instanceKey, routeKey) {
        this.ensureOpen();
        const instance = this.getInstance(instanceKey);
        return Boolean(
            instance &&
                this.getRouteStatements(instance).hasRoute.get({
                    instanceId: instance.instance_id,
                    routeKey: String(routeKey)
                })
        );
    }

    mapRouteRow(row, options = {}) {
        if (!row) {
            return null;
        }
        const attr = parseJson(row.attr_json, {});
        const route = {
            routeKey: row.route_key,
            persistentRouteId: Number(row.route_id),
            attrId: Buffer.isBuffer(row.attr_hash) ? row.attr_hash.toString('hex') : String(row.attr_hash || ''),
            createdAtMs: Number(row.created_at_ms),
            updatedAtMs: Number(row.updated_at_ms)
        };
        const fields = [
            ['ip', row.prefix],
            ['mask', row.prefix_length],
            ['rd', row.rd],
            ['routeType', row.route_type],
            ['originatingRouterIp', row.originating_router_ip],
            ['sourceIp', row.source_ip],
            ['groupIp', row.group_ip],
            ['sourceAs', row.source_as],
            ['dqpn', row.dqpn],
            ['label', row.label]
        ];
        fields.forEach(([name, value]) => {
            if (value !== null && value !== undefined) {
                route[name] = value;
            }
        });
        if (row.route_type === null && row.dqpn === null && row.label === null && row.rd !== null) {
            route.pathId = row.path_id;
        }
        if (options.includeAttr === false) {
            return route;
        }
        return { ...route, ...attr, routeAttr: attr };
    }

    getRoute(instanceKey, routeKey) {
        this.ensureOpen();
        const instance = this.getInstance(instanceKey);
        if (!instance) {
            return null;
        }
        return this.mapRouteRow(
            this.getRouteStatements(instance).getRoute.get({
                instanceId: instance.instance_id,
                routeKey: String(routeKey)
            })
        );
    }

    queryDetail(instanceKey, routeKey) {
        const key = routeKey && typeof routeKey === 'object' ? deriveRouteKey(routeKey) : routeKey;
        return this.getRoute(instanceKey, key);
    }

    deriveRouteKey(route) {
        return deriveRouteKey(route);
    }

    buildFilters(instanceId, tableName, options = {}) {
        if (!ROUTE_TABLE_NAMES.has(tableName)) {
            throw new Error(`Invalid BGP route SQLite table name: ${tableName}`);
        }
        const where = ['r.instance_id = @instanceId'];
        const params = { instanceId };
        if (options.prefixExact !== undefined && options.prefixExact !== null && options.prefixExact !== '') {
            where.push('r.prefix = @prefixExact');
            params.prefixExact = String(options.prefixExact);
        } else if (options.prefix !== undefined && options.prefix !== null && options.prefix !== '') {
            where.push('r.prefix = @prefixExact');
            params.prefixExact = String(options.prefix);
        } else if (options.prefixStart !== undefined && options.prefixStart !== null && options.prefixStart !== '') {
            params.prefixStart = String(options.prefixStart);
            params.prefixEnd = `${params.prefixStart}\uffff`;
            where.push('r.prefix >= @prefixStart AND r.prefix < @prefixEnd');
        }
        const prefixLength = nullableInteger(options.prefixLength);
        if (prefixLength !== null) {
            where.push('r.prefix_length = @prefixLength');
            params.prefixLength = prefixLength;
        }
        const routeType = nullableInteger(options.routeType);
        if (routeType !== null) {
            where.push('r.route_type = @routeType');
            params.routeType = routeType;
        }
        if (options.bestPathOnly === true) {
            where.push(`NOT EXISTS (
                SELECT 1
                  FROM ${tableName} best
                 WHERE best.instance_id = r.instance_id
                   AND best.prefix IS r.prefix
                   AND best.prefix_length IS r.prefix_length
                   AND best.rd IS r.rd
                   AND best.path_id < r.path_id
            )`);
        }
        const afterRouteId = nullableInteger(options.afterRouteId ?? options.cursor);
        if (afterRouteId !== null) {
            where.push('r.route_id > @afterRouteId');
            params.afterRouteId = afterRouteId;
        }
        return { where, params };
    }

    getDynamicStatement(key, factory) {
        let statement = this.dynamicStatements.get(key);
        if (!statement) {
            statement = factory();
            this.dynamicStatements.set(key, statement);
        }
        return statement;
    }

    queryPage(instanceKey, options = {}) {
        this.ensureOpen();
        const normalized = normalizeInstanceKey(instanceKey);
        const instance = this.getInstance(normalized);
        const page = positiveInteger(options.page, 1);
        const pageSize = positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        if (!instance) {
            return { list: [], total: 0, page, pageSize, nextCursor: null };
        }
        const { tableName } = this.getRouteTableDefinition(instance);
        const { where, params } = this.buildFilters(instance.instance_id, tableName, options);
        const hasFilter = where.length > 1;
        const useCursor = nullableInteger(options.afterRouteId ?? options.cursor) !== null;
        const countWhere = where.filter(clause => !clause.includes('route_id >'));
        const countParams = { ...params };
        delete countParams.afterRouteId;
        let total = null;
        if (options.includeTotal !== false) {
            if (!hasFilter || (countWhere.length === 1 && countWhere[0] === 'r.instance_id = @instanceId')) {
                total = Number(this.statements.findInstance.get({ instanceKey: normalized })?.route_count || 0);
            } else {
                const countKey = `${tableName}:count:${countWhere.join('|')}`;
                const countStatement = this.getDynamicStatement(countKey, () =>
                    this.db.prepare(`SELECT COUNT(*) AS total FROM ${tableName} r WHERE ${countWhere.join(' AND ')}`)
                );
                total = Number(countStatement.get(countParams).total || 0);
            }
        }
        const listKey = `${tableName}:page:${where.join('|')}`;
        const listStatement = this.getDynamicStatement(listKey, () =>
            this.db.prepare(`${this.routeSelectSql(tableName)}
                 WHERE ${where.join(' AND ')}
                 ORDER BY r.route_id
                 LIMIT @limit OFFSET @offset`)
        );
        const rows = listStatement.all({
            ...params,
            limit: pageSize + 1,
            offset: useCursor ? 0 : (page - 1) * pageSize
        });
        const hasMore = rows.length > pageSize;
        const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
        return {
            list: pageRows.map(row => this.mapRouteRow(row)),
            total,
            page,
            pageSize,
            nextCursor: hasMore && pageRows.length > 0 ? Number(pageRows[pageRows.length - 1].route_id) : null
        };
    }

    queryRoutes(query = {}) {
        return this.queryPage(query.instanceKey, query);
    }

    queryPrefix(instanceKey, prefix, options = {}) {
        return this.queryPage(instanceKey, { ...options, prefixExact: prefix });
    }

    *iterateRouteKeys(instanceKey) {
        this.ensureOpen();
        const instance = this.getInstance(instanceKey);
        if (!instance) {
            return;
        }
        for (const row of this.getRouteStatements(instance).iterateKeys.iterate({ instanceId: instance.instance_id })) {
            yield row.route_key;
        }
    }

    getIterationStatement(instance, options = {}, orderBy = 'route') {
        const { tableName } = this.getRouteTableDefinition(instance);
        const { where, params } = this.buildFilters(instance.instance_id, tableName, options);
        const orderSql = orderBy === 'attr' ? 'r.attr_id, r.route_id' : 'r.route_id';
        const key = `${tableName}:iterate:${orderBy}:${where.join('|')}`;
        const statement = this.getDynamicStatement(key, () =>
            this.db.prepare(`${this.routeSelectSql(tableName)} WHERE ${where.join(' AND ')} ORDER BY ${orderSql}`)
        );
        return { statement, params };
    }

    *iterateRoutes(instanceKey, options = {}) {
        this.ensureOpen();
        const instance = this.getInstance(instanceKey);
        if (!instance) {
            return;
        }
        const { statement, params } = this.getIterationStatement(instance, options);
        for (const row of statement.iterate(params)) {
            yield this.mapRouteRow(row);
        }
    }

    *iterateRouteBatches(instanceKey, options = {}) {
        const batchSize = positiveInteger(options.batchSize, DEFAULT_ITERATION_BATCH_SIZE, MAX_ITERATION_BATCH_SIZE);
        let batch = [];
        for (const route of this.iterateRoutes(instanceKey, options)) {
            batch.push(route);
            if (batch.length >= batchSize) {
                yield batch;
                batch = [];
            }
        }
        if (batch.length > 0) {
            yield batch;
        }
    }

    *iterateAttrGroups(instanceKey, options = {}) {
        this.ensureOpen();
        const instance = this.getInstance(instanceKey);
        if (!instance) {
            return;
        }
        const batchSize = positiveInteger(options.batchSize, DEFAULT_ITERATION_BATCH_SIZE, MAX_ITERATION_BATCH_SIZE);
        const { statement, params } = this.getIterationStatement(instance, options, 'attr');
        let currentAttrId = null;
        let currentAttr = null;
        let routes = [];
        let chunkIndex = 0;
        for (const row of statement.iterate(params)) {
            const attrId = Number(row.attr_id);
            if (currentAttrId !== null && (attrId !== currentAttrId || routes.length >= batchSize)) {
                yield { attrId: currentAttrId, attr: currentAttr, routes, chunkIndex };
                if (attrId !== currentAttrId) {
                    chunkIndex = 0;
                } else {
                    chunkIndex += 1;
                }
                routes = [];
            }
            if (attrId !== currentAttrId) {
                currentAttrId = attrId;
                currentAttr = parseJson(row.attr_json, {});
            }
            routes.push(this.mapRouteRow(row, { includeAttr: false }));
        }
        if (routes.length > 0) {
            yield { attrId: currentAttrId, attr: currentAttr, routes, chunkIndex };
        }
    }

    createRouteMap(instanceKey, options = {}) {
        this.ensureOpen();
        return new BgpRouteMapFacade(this, instanceKey, options);
    }

    cleanupOrphanCandidates(limit = 20000) {
        this.assertWritable();
        const batchSize = positiveInteger(limit, 20000, 20000);
        let deleted = 0;
        let changes;
        do {
            changes = this.statements.deleteCandidateOrphanAttributes.run({ limit: batchSize }).changes;
            deleted += changes;
        } while (changes >= batchSize);
        this.statements.clearOrphanCandidates.run();
        return deleted;
    }

    sweepOrphanAttributes(limit = 2000) {
        this.assertWritable();
        return this.statements.deleteOrphanAttributes.run({
            limit: positiveInteger(limit, 2000, 20000)
        }).changes;
    }

    getStatus() {
        this.ensureOpen();
        const fileSize = this.dbPath !== ':memory:' && fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0;
        const walPath = `${this.dbPath}-wal`;
        const walSize = this.dbPath !== ':memory:' && fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
        return {
            ready: true,
            dbPath: this.dbPath,
            schemaVersion: this.db.pragma('user_version', { simple: true }),
            journalMode: this.db.pragma('journal_mode', { simple: true }),
            instances: Number(this.statements.countInstances.get().count || 0),
            routes: Number(this.statements.sumRoutes.get().count || 0),
            attributes: Number(this.statements.countAttributes.get().count || 0),
            fileSize,
            walSize,
            totalSize: fileSize + walSize
        };
    }

    checkpoint(mode = 'PASSIVE') {
        this.ensureOpen();
        if (this.readOnly || this.dbPath === ':memory:') {
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
        if (!this.readOnly && this.dbPath !== ':memory:') {
            this.checkpoint('PASSIVE');
        }
        this.db.close();
        this.db = null;
        this.statements = null;
        this.instances.clear();
        this.routeStatements.clear();
        this.dynamicStatements.clear();
    }
}

BgpRouteSqliteStore.SCHEMA_VERSION = SCHEMA_VERSION;
BgpRouteSqliteStore.ROUTE_TABLE_DEFINITIONS = ROUTE_TABLE_DEFINITIONS;
BgpRouteSqliteStore.BgpRouteMapFacade = BgpRouteMapFacade;

module.exports = BgpRouteSqliteStore;
module.exports.BgpRouteSqliteStore = BgpRouteSqliteStore;
module.exports.BgpRouteMapFacade = BgpRouteMapFacade;
