const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BmpPersistenceClient = require('../../electron/worker/bmp/bmpPersistenceClient');
const BmpClientPersistenceStore = require('../../electron/worker/bmp/bmpClientPersistenceStore');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const { buildRouteUpsertMutation } = require('../../electron/worker/bmp/bmpPersistenceMutation');

const SOURCE_A = 'a'.repeat(64);
const SOURCE_B = 'b'.repeat(64);
const BASE_TIME = 1767225600000;
const encoder = new BmpPersistenceClient();

function descriptors(sourceId = SOURCE_A) {
    return {
        source: { id: sourceId, sysName: 'router-a', metadata: { transport: 'tcp' } },
        connection: { id: 'connection-a', sourceId, localPort: 11019, remotePort: 50001 },
        scope: {
            id: 'scope-a',
            sourceId,
            identityJson: JSON.stringify({ sourceKeyHex: sourceId }),
            epoch: 0,
            state: 'ready',
            vrfName: 'blue',
            ownerKey: 'peer-a'
        }
    };
}

function encode(mutations) {
    return encoder.encodeBatchMutations(mutations);
}

function batch(mutations, options = {}) {
    return { batchId: 'descriptor-test', createdAtMs: BASE_TIME, includeDeltas: false, mutations, ...options };
}

function captureStore() {
    const store = new BmpClientPersistenceStore({ dbPath: path.join(os.tmpdir(), 'unused-descriptor-test.sqlite3') });
    const commits = [];
    let ownershipChecks = 0;
    store.opened = true;
    store.owns = () => {
        ownershipChecks += 1;
        return true;
    };
    store.getStore = sourceId => ({
        applyBatch(value) {
            commits.push({ sourceId, batch: value });
            return { duplicate: false, applied: value.mutations.length };
        }
    });
    return { store, commits, ownershipChecks: () => ownershipChecks };
}

function encoderReuse() {
    const shared = descriptors();
    const originalStringify = JSON.stringify;
    const calls = new Map();
    let encoded;
    JSON.stringify = function (value, ...args) {
        if (Object.values(shared).includes(value)) calls.set(value, (calls.get(value) || 0) + 1);
        return originalStringify.call(this, value, ...args);
    };
    try {
        encoded = encode(Array.from({ length: 1000 }, (_, sequence) => ({ ...shared, sequence })));
    } finally {
        JSON.stringify = originalStringify;
    }
    for (const [field, table] of [
        ['source', 'sources'],
        ['connection', 'connections'],
        ['scope', 'scopes']
    ]) {
        assert.equal(encoded.refs[table].length, 1);
        assert.equal(calls.get(shared[field]), 1, `${field} content must be encoded only once per object`);
        assert.ok(encoded.mutations.every(mutation => mutation[`${field}Ref`] === 0));
        assert.ok(encoded.mutations.every(mutation => !Object.hasOwn(mutation, field)));
    }
    const sameContents = JSON.parse(JSON.stringify(shared));
    const equal = encode([shared, sameContents]);
    assert.equal(equal.refs.sources.length, 1, 'equal non-shared DTOs should still be compacted');
    assert.equal(equal.refs.connections.length, 1);
    assert.equal(equal.refs.scopes.length, 1);

    for (const [field, property, changedValue, table] of [
        ['source', 'sysName', 'router-renamed', 'sources'],
        ['source', 'metadata', { transport: 'tcp', authProfileName: 'changed' }, 'sources'],
        ['connection', 'localPort', 11020, 'connections'],
        ['connection', 'sourceId', SOURCE_B, 'connections'],
        ['scope', 'ownerKey', 'peer-renamed', 'scopes'],
        ['scope', 'sourceId', SOURCE_B, 'scopes'],
        ['scope', 'identityJson', JSON.stringify({ sourceKeyHex: SOURCE_B }), 'scopes'],
        ['scope', 'keyJson', '{"changed":true}', 'scopes'],
        ['scope', 'vrfName', 'red', 'scopes']
    ]) {
        const changed = { ...shared, [field]: { ...shared[field], [property]: changedValue } };
        const result = encode([shared, changed, shared]);
        assert.equal(result.refs[table].length, 2, `${field}.${property} must not be merged by identity`);
        assert.deepEqual(
            result.mutations.map(value => value[`${field}Ref`]),
            [0, 1, 0]
        );
        assert.equal(result.refs[table][1][property], changedValue);
    }

    const collisions = encode([
        { source: { id: SOURCE_A } },
        { source: { id: SOURCE_A, extra: undefined } },
        { source: { id: SOURCE_A, extra: null } },
        { source: { id: SOURCE_A, extra: NaN } }
    ]);
    assert.equal(collisions.refs.sources.length, 4, 'equal JSON output must not merge different descriptor values');
    const cyclic = { id: SOURCE_A };
    cyclic.self = cyclic;
    const bigint = { id: SOURCE_A, extra: 1n };
    const fallback = encode([{ source: cyclic }, { source: bigint }, { source: cyclic }, { source: bigint }]);
    assert.equal(fallback.refs.sources.length, 2, 'non-JSON cloneable descriptors must use object identity');
    assert.deepEqual(
        fallback.mutations.map(value => value.sourceRef),
        [0, 1, 0, 1]
    );
    assert.equal(fallback.refs.sources[0].self, cyclic);
}

function storeReuse() {
    for (const useRefs of [false, true]) {
        const shared = descriptors(` ${SOURCE_A.toUpperCase()} `);
        const mutations = Array.from({ length: 1000 }, (_, sequence) => ({ ...shared, sequence }));
        const input = batch(mutations, useRefs ? encode(mutations) : {});
        const captured = captureStore();
        const originalParse = JSON.parse;
        let scopeParses = 0;
        JSON.parse = function (value, ...args) {
            if (value === shared.scope.identityJson) scopeParses += 1;
            return originalParse.call(this, value, ...args);
        };
        try {
            assert.equal(captured.store.applyBatch(input).applied, mutations.length);
        } finally {
            JSON.parse = originalParse;
        }
        assert.equal(scopeParses, 1, 'shared scope identity must only be parsed once per batch');
        assert.equal(captured.ownershipChecks(), 1, 'one source needs one isolation/ownership check per batch');
        assert.equal(captured.commits.length, 1);
        const decoded = captured.commits[0].batch.mutations;
        assert.ok(
            decoded.every(value => value.source === decoded[0].source),
            'normalization must preserve descriptor sharing'
        );
        assert.notEqual(
            decoded[0].source,
            shared.source,
            'non-canonical ID must be normalized without editing the input'
        );
        assert.equal(decoded[0].source.id, SOURCE_A);
        assert.equal(shared.source.id, ` ${SOURCE_A.toUpperCase()} `);
        assert.ok(decoded.every(value => value.connection === shared.connection && value.scope === shared.scope));
        assert.ok(mutations.every(value => value.source === shared.source));
        assert.equal(captured.commits[0].batch.refs, undefined);

        const canonical = descriptors();
        const canonicalCapture = captureStore();
        canonicalCapture.store.applyBatch(batch([{ ...canonical }, { ...canonical }]));
        assert.equal(
            canonicalCapture.commits[0].batch.mutations[0].source,
            canonical.source,
            'already canonical source DTO must not be copied'
        );
    }
}

function rejectBeforeCommit() {
    const shared = descriptors();
    const other = descriptors(SOURCE_B);
    other.connection.id = 'connection-b';
    other.scope.id = 'scope-b';
    const invalid = [
        { ...other, connection: shared.connection },
        { ...other, scope: shared.scope },
        { ...shared, connection: { ...shared.connection, sourceId: SOURCE_B } },
        { ...shared, scope: { ...shared.scope, sourceId: SOURCE_B } },
        { ...shared, scope: { ...shared.scope, identityJson: JSON.stringify({ sourceKeyHex: SOURCE_B }) } },
        { ...shared, scope: { ...shared.scope, identityJson: '{invalid json' } }
    ];
    for (const useRefs of [false, true]) {
        for (const mutation of invalid) {
            const captured = captureStore();
            const mutations = [{ ...shared }, mutation];
            assert.throws(
                () => captured.store.applyBatch(batch(mutations, useRefs ? encode(mutations) : {})),
                /source|scope|connection|JSON/i
            );
            assert.equal(
                captured.commits.length,
                0,
                'all descriptors must be validated before the first Client commit'
            );
        }
        const scoped = captureStore();
        scoped.store.sourceId = SOURCE_A;
        const mutations = [shared, other];
        assert.throws(
            () => scoped.store.applyBatch(batch(mutations, useRefs ? encode(mutations) : {})),
            /source mismatch/i
        );
        assert.equal(scoped.commits.length, 0);
    }
}

function mixedDescriptors() {
    const shared = descriptors();
    const direct = { ...shared, sequence: 3, sourceRef: undefined, connectionRef: undefined, scopeRef: undefined };
    const partial = { sourceRef: 0, connection: shared.connection, scope: shared.scope, sequence: 2 };
    const referenced = { sourceRef: 0, connectionRef: 0, scopeRef: 0, sequence: 1 };
    const refs = { sources: [shared.source], connections: [shared.connection], scopes: [shared.scope] };
    const captured = captureStore();
    captured.store.applyBatch(batch([referenced, partial, direct], { refs }));
    const decoded = captured.commits[0].batch.mutations;
    assert.deepEqual(
        decoded.map(value => value.sequence),
        [1, 2, 3]
    );
    assert.ok(decoded.every(value => value.source === shared.source));
    assert.ok(decoded.every(value => value.connection === shared.connection));
    assert.ok(decoded.every(value => value.scope === shared.scope));
    assert.notEqual(decoded[0], referenced);
    assert.notEqual(decoded[1], partial);
    assert.equal(decoded[2], direct, 'a canonical direct DTO must not be copied merely because batch.refs exists');
    assert.equal(Object.hasOwn(decoded[0], 'sourceRef'), false);
    assert.equal(Object.hasOwn(decoded[1], 'sourceRef'), false);
    assert.equal(Object.hasOwn(decoded[2], 'sourceRef'), true, 'undefined refs retain direct DTO semantics');
    assert.equal(referenced.sourceRef, 0);
    assert.equal(partial.sourceRef, 0);
    assert.equal(referenced.source, undefined);
    assert.equal(partial.source, undefined);

    for (const [mutation, malformedRefs] of [
        [{ ...direct, sourceRef: 99 }, refs],
        [
            { ...direct, sourceRef: 0 },
            { connections: refs.connections, scopes: refs.scopes }
        ],
        [{ ...direct, connectionRef: 99 }, refs],
        [
            { ...direct, connectionRef: 0 },
            { sources: refs.sources, scopes: refs.scopes }
        ],
        [
            { ...direct, scopeRef: 0 },
            { ...refs, scopes: [{ ...shared.scope, identityJson: 'invalid json' }] }
        ]
    ]) {
        const invalid = captureStore();
        assert.throws(
            () => invalid.store.applyBatch(batch([direct, mutation], { refs: malformedRefs })),
            /sourceId|connection|JSON/i
        );
        assert.equal(invalid.commits.length, 0, 'malformed mixed refs must reject before any commit');
    }
    const absentScope = captureStore();
    absentScope.store.applyBatch(batch([{ ...direct, scopeRef: 99 }], { refs }));
    assert.equal(
        absentScope.commits[0].batch.mutations[0].scope,
        undefined,
        'an unresolved optional scope ref retains the prior decoder semantics'
    );
}

function realMutations() {
    const session = {
        sysName: 'descriptor-router',
        remoteIp: '192.0.2.10',
        remotePort: 50001,
        localIp: '127.0.0.1',
        localPort: 11019,
        persistenceConnectionId: 'real-descriptor-connection',
        persistenceConnectionGeneration: 1,
        persistenceOpenedAtMs: BASE_TIME
    };
    const owner = new BmpBgpSession(session);
    Object.assign(owner, {
        sessionType: 0,
        sessionRd: '0:0',
        sessionIp: '198.51.100.1',
        sessionAs: 65001,
        vrfTableNames: ['blue']
    });
    const mutations = [];
    for (let index = 0; index < 40; index += 1) {
        const route = new BmpBgpRoute(owner, null);
        const prefix = `10.0.${index}.0`;
        Object.assign(route, {
            afi: 1,
            safi: 1,
            ribType: 2,
            ip: prefix,
            mask: 24,
            pathId: 0,
            rd: '0:0',
            nlriDetail: { prefix, length: 24, pathId: 0, rd: '0:0' }
        });
        route.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop: '192.0.2.1' });
        route.markActive(0);
        const mutation = buildRouteUpsertMutation(session, owner, route, 1, 1, 2, {
            kind: 'peer',
            scopeState: 'ready',
            eventAtMs: BASE_TIME + index,
            sourceTimestampMs: BASE_TIME
        });
        const contextVersion = index < 20 ? 0 : 1;
        mutation.source = { ...mutation.source, sysName: contextVersion ? 'descriptor-renamed' : 'descriptor-router' };
        mutation.connection = { ...mutation.connection, localPort: contextVersion ? 11020 : 11019 };
        mutation.scope = { ...mutation.scope, vrfName: contextVersion ? 'red' : 'blue' };
        mutations.push(mutation);
    }
    return mutations;
}

function physicalState(store, sourceId) {
    const physical = store.getStore(sourceId);
    return Object.fromEntries(
        [
            'bmp_sources',
            'bmp_connections',
            'bmp_rib_scopes',
            'bmp_route_identities',
            'bmp_route_attributes',
            'bmp_route_payloads',
            'bmp_current_route_refs',
            'bmp_scope_route_counts'
        ].map(table => [table, physical.db.prepare(`SELECT * FROM ${table}`).all()])
    );
}

function realStoreEquivalence(directory) {
    const direct = new BmpClientPersistenceStore({ dbPath: path.join(directory, 'direct.sqlite3') }).open();
    const compact = new BmpClientPersistenceStore({ dbPath: path.join(directory, 'compact.sqlite3') }).open();
    try {
        const mutations = realMutations();
        const before = JSON.stringify(mutations);
        const sourceId = mutations[0].source.id;
        const directBatch = batch(mutations, { includeDeltas: true });
        const encodedBatch = batch(mutations, { ...encode(mutations), includeDeltas: true });
        const directResult = direct.applyBatch(directBatch);
        const compactResult = compact.applyBatch(encodedBatch);
        assert.deepEqual(compactResult, directResult);
        assert.deepEqual(compactResult.deltas, directResult.deltas);
        assert.deepEqual(
            physicalState(compact, sourceId),
            physicalState(direct, sourceId),
            'encoded descriptors must retain FIFO context and exact physical persistence semantics'
        );
        const state = physicalState(compact, sourceId);
        assert.equal(state.bmp_sources[0].sys_name, 'descriptor-renamed');
        assert.equal(state.bmp_connections[0].local_port, 11020);
        assert.equal(state.bmp_rib_scopes[0].vrf_name, 'red');
        assert.equal(state.bmp_current_route_refs.length, mutations.length);
        assert.equal(state.bmp_route_attributes.length, 1);
        assert.equal(JSON.stringify(mutations), before, 'input DTOs must remain unchanged');
        assert.equal(compact.applyBatch(encodedBatch).duplicate, true);

        const valid = { ...mutations[0], sequence: mutations[mutations.length - 1].sequence + 1 };
        const foreign = {
            ...valid,
            scope: { ...valid.scope, identityJson: JSON.stringify({ sourceKeyHex: SOURCE_B }) }
        };
        const baseline = physicalState(compact, sourceId);
        assert.throws(
            () =>
                compact.applyBatch(
                    batch([valid, foreign], {
                        ...encode([valid, foreign]),
                        batchId: 'foreign-scope-descriptor'
                    })
                ),
            /scope source/i
        );
        assert.deepEqual(physicalState(compact, sourceId), baseline);
    } finally {
        direct.close();
        compact.close();
    }
}

function main() {
    encoderReuse();
    storeReuse();
    rejectBeforeCommit();
    mixedDescriptors();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-descriptor-reuse-'));
    try {
        realStoreEquivalence(directory);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    console.log('BMP persistence descriptor reuse tests passed');
}

main();
