'use strict';

const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpIngestClientPool = require('../../electron/worker/bmp/bmpIngestClientPool');
const { createIngestSnapshot } = require('../../electron/worker/bmp/bmpIngestSnapshot');
const { createSourceKey } = require('../../electron/utils/bmp/bmpPersistentRouteKey');
const {
    buildSource,
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');
const { builders } = require('../../scripts/mockBmpClient');

function context(kind) {
    let draftCalls = 0;
    const session = {
        remoteIp: '192.0.2.10',
        remotePort: 55000,
        localIp: '127.0.0.1',
        localPort: 1790,
        sysName: 'compact-router',
        sysDesc: 'initial description',
        bmpVersion: 4,
        persistenceConnectionId: `compact-${kind}`,
        persistenceConnectionGeneration: 1000,
        persistenceOpenedAtMs: 1719811200000,
        getBmpV4TlvDraft() {
            draftCalls += 1;
            return 20;
        }
    };
    const owner = kind === 'peer' ? new BmpBgpSession(session) : new BmpBgpInstance(session);
    Object.assign(
        owner,
        kind === 'peer'
            ? {
                  sessionType: 0,
                  sessionRd: '0:0',
                  sessionRdRaw: 'raw:0000000000000000',
                  sessionIp: '198.51.100.1',
                  sessionAs: 65001
              }
            : {
                  instanceType: 3,
                  instanceRd: '0:0',
                  instanceRdRaw: 'raw:0000000000000000',
                  instanceIp: '198.51.100.1',
                  instanceAs: 65001
              }
    );
    owner.vrfTableNames = ['blue'];
    const ribType = kind === 'peer' ? BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN : 'loc-rib';
    const route = new BmpBgpRoute(null, null);
    Object.assign(route, {
        afi: 1,
        safi: 1,
        pathId: 0,
        ip: '203.0.113.0',
        mask: 24,
        nlriDetail: { prefix: '203.0.113.0', length: 24, pathId: 0, rd: '0:0', valid: true }
    });
    route.assignSharedRouteAttr(Object.freeze({ origin: 'IGP', asPath: '65001', nextHop: '192.0.2.1' }));
    return {
        session,
        owner,
        ribType,
        route,
        get draftCalls() {
            return draftCalls;
        },
        announce(options = {}) {
            return buildRouteUpsertMutation(session, owner, route, 1, 1, ribType, {
                kind,
                scopeState: 'ready',
                ...options
            });
        },
        scope(options = {}) {
            return buildScopeMutation(session, owner, 1, 1, ribType, 'scope_open', {
                kind,
                state: 'ready',
                ...options
            });
        }
    };
}

function testDescriptorReuse(kind) {
    const current = context(kind);
    const count = current.draftCalls;
    const first = current.announce();
    const repeated = Array.from({ length: 64 }, () => current.announce());
    assert.equal(current.draftCalls - count, 65, 'each route resolves its source once, not again from buildScope');
    assert.ok(Object.isFrozen(first.source) && Object.isFrozen(first.source.metadata));
    assert.ok(Object.isFrozen(first.connection) && Object.isFrozen(first.scope));
    repeated.forEach(mutation => {
        assert.equal(mutation.source, first.source);
        assert.equal(mutation.connection, first.connection);
        assert.equal(mutation.scope, first.scope);
        assert.equal(mutation.route.attrId, first.route.attrId);
        assert.equal(mutation.eventType, 'upsert', 'descriptor caching must not infer a committed durable route');
    });
    assert.equal(new Set([first, ...repeated].map(item => item.sequence)).size, 65);
    assert.equal(current.scope().scope, first.scope, 'public scope mutation reuses exactly equal immutable context');
    assert.throws(() => {
        first.source.sysName = 'unsafe';
    }, TypeError);
    assert.throws(() => {
        first.connection.remotePort = 1;
    }, TypeError);
    assert.throws(() => {
        first.scope.state = 'unsafe';
    }, TypeError);

    // Source identity is stable on this connection, but every changed display
    // or authentication field must create a new immutable transport snapshot.
    current.session.sysDesc = 'new description';
    const description = current.announce();
    assert.notEqual(description.source, first.source);
    assert.equal(description.source.id, first.source.id);
    assert.equal(first.source.sysDesc, 'initial description');
    assert.equal(description.connection, first.connection);
    assert.equal(description.scope, first.scope);
    current.session.authentication = 'tcp-ao';
    current.session.authProfileId = 'profile-a';
    const auth = current.announce();
    assert.notEqual(auth.source, description.source);
    assert.equal(description.source.metadata.authentication, 'none');
    assert.equal(auth.source.metadata.authentication, 'tcp-ao');
    current.session.authPeer = { address: '192.0.2.10', options: { keyIds: [1, 2] } };
    const structured = current.announce();
    current.session.authPeer.options.keyIds.push(3);
    const structuredChanged = current.announce();
    assert.notEqual(structured.source, structuredChanged.source);
    assert.deepEqual(structured.source.metadata.authPeer.options.keyIds, [1, 2]);
    assert.deepEqual(structuredChanged.source.metadata.authPeer.options.keyIds, [1, 2, 3]);
    assert.ok(Object.isFrozen(structured.source.metadata.authPeer.options.keyIds));
    assert.equal(Object.isFrozen(current.session.authPeer), false, 'do not freeze or mutate caller-owned metadata');

    current.session.remotePort += 1;
    const port = current.announce();
    assert.notEqual(port.connection, first.connection);
    assert.equal(first.connection.remotePort, 55000);
    assert.equal(port.scope, first.scope);
    current.session.persistenceConnectionId = `reconnect-${kind}`;
    current.session.persistenceConnectionGeneration += 1;
    current.session.persistenceOpenedAtMs += 1;
    const reconnect = current.announce();
    assert.notEqual(reconnect.connection, port.connection);
    assert.equal(reconnect.source.id, first.source.id);
    assert.equal(reconnect.scope, first.scope);

    const syncing = current.announce({ state: 'ready', scopeState: 'syncing' });
    assert.notEqual(syncing.scope, first.scope);
    assert.equal(syncing.scope.state, 'syncing', 'upsert scopeState overrides generic state before freezing');
    assert.equal(first.scope.state, 'ready');
    const reason = current.scope({ reason: 'peer-down', state: 'down' });
    assert.equal(reason.scope.reason, 'peer-down');
    assert.equal(first.scope.reason, null);
    const beforeEpoch = current.announce();
    if (kind === 'peer') current.owner.advanceRibEpoch(1, 1, current.ribType);
    else current.owner.advanceRibEpoch();
    const epoch = current.announce();
    assert.notEqual(epoch.scope, beforeEpoch.scope);
    assert.equal(epoch.scope.epoch, beforeEpoch.scope.epoch + 1);
    assert.equal(epoch.scope.id, beforeEpoch.scope.id);
    current.owner.vrfTableNames[0] = 'green';
    const vrf = current.announce();
    assert.notEqual(vrf.scope, epoch.scope);
    assert.equal(vrf.scope.vrfName, 'green');
    assert.equal(epoch.scope.vrfName, 'blue');
    const rdField = kind === 'peer' ? 'sessionRd' : 'instanceRd';
    const rawField = kind === 'peer' ? 'sessionRdRaw' : 'instanceRdRaw';
    current.owner[rdField] = 'display:updated';
    const rdDisplay = current.announce();
    assert.notEqual(rdDisplay.scope, vrf.scope);
    assert.equal(rdDisplay.scope.id, vrf.scope.id, 'RD display changes do not alter stable raw RD identity');
    assert.equal(vrf.scope.peerRd, '0:0');
    current.owner[rawField] = 'raw:0000fde800000001';
    const rdIdentity = current.announce();
    assert.notEqual(rdIdentity.scope.id, rdDisplay.scope.id);
    const anotherFamily = buildScopeMutation(current.session, current.owner, 2, 1, current.ribType, 'scope_open', {
        kind,
        state: 'ready'
    });
    assert.notEqual(anotherFamily.scope.id, rdIdentity.scope.id);
    const otherStage = buildScopeMutation(current.session, current.owner, 1, 1, 'other-stage', 'scope_open', {
        kind,
        state: 'ready'
    });
    if (kind === 'peer') assert.notEqual(otherStage.scope.id, rdIdentity.scope.id);
    else assert.equal(otherStage.scope.id, rdIdentity.scope.id, 'Loc-RIB always uses its one semantic stage');

    current.session.persistenceSourceKey = createSourceKey({
        sysName: 'different-router',
        sourceAddress: '192.0.2.20'
    });
    const changedSource = current.announce();
    assert.notEqual(changedSource.source.id, first.source.id);
    assert.notEqual(changedSource.connection.sourceId, first.connection.sourceId);
    assert.notEqual(changedSource.scope.sourceId, first.scope.sourceId);
    assert.equal(buildSource(current.session), changedSource.source);
    assert.equal(buildConnectionMutation(current.session, 'source_update').source, changedSource.source);
    assert.equal(
        Object.hasOwn(current.session, 'persistenceSourceDescriptor'),
        false,
        'module caches must not become snapshot fields'
    );
}

function withTimeout(promise, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10000);
        })
    ]).finally(() => clearTimeout(timer));
}

async function testRealWorkerSharedClone() {
    const results = [];
    const errors = [];
    const pool = new BmpIngestClientPool({
        threadCount: 1,
        config: { bmpV4TlvDraft: 20 },
        onResult(_record, result) {
            results.push(result);
        },
        onError(error) {
            errors.push(error);
        }
    });
    const session = new BmpSession({}, {});
    Object.assign(session, {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: '192.0.2.10',
        remotePort: 55000,
        persistenceConnectionId: 'compact-real-worker',
        persistenceConnectionGeneration: 2000,
        persistenceOpenedAtMs: 1719811200000,
        socket: {
            pause() {},
            resume() {},
            destroy() {
                this.destroyed = true;
            }
        }
    });
    try {
        await withTimeout(pool.open(), 'worker open');
        const record = pool.attach(session, {
            sessionKey: 'compact-worker-key',
            metadata: {
                localIp: session.localIp,
                localPort: session.localPort,
                remoteIp: session.remoteIp,
                remotePort: session.remotePort
            }
        });
        assert.ok(record);
        const prefixes = Array.from({ length: 64 }, (_, index) => `10.2.${index}.0`);
        const update = builders.routeMonitoringMessage({}, builders.ipv4Update(prefixes));
        const packet = Buffer.concat([
            builders.initiationMessage({ sysName: 'compact-wire-router' }),
            builders.bmpMessage(BmpConst.BMP_MSG_TYPE.PEER_UP_NOTIFICATION, builders.peerUpPayload()),
            update,
            builders.routeMonitoringMessage({}, builders.endOfRibUpdate())
        ]);
        const originalBytes = Buffer.from(packet);
        assert.equal(pool.send(record, packet), true);
        await withTimeout(pool.fence(), 'worker initial fence');
        assert.deepEqual(packet, originalBytes, 'owned transport buffers must not detach caller data');
        const response = results.find(result => result.actions.filter(action => action.mutation?.route).length === 64);
        assert.ok(response, 'real Worker must return the complete UPDATE in one ordered action batch');
        const mutations = response.actions.filter(action => action.mutation?.route).map(action => action.mutation);
        mutations.forEach(mutation => {
            assert.equal(
                mutation.source,
                mutations[0].source,
                'native structured clone must preserve source object sharing'
            );
            assert.equal(mutation.connection, mutations[0].connection);
            assert.equal(mutation.scope, mutations[0].scope);
            assert.equal(mutation.scope.state, 'syncing');
            assert.equal(mutation.eventType, 'upsert');
        });
        const eor = response.actions.find(action => action.mutation?.eventType === 'scope_eor').mutation;
        assert.notEqual(eor.scope, mutations[0].scope);
        assert.equal(eor.scope.state, 'ready');
        assert.equal(mutations[0].scope.state, 'syncing', 'EOR cannot retroactively change queued route scopes');
        assert.equal(response.snapshot.session.persistenceSourceDescriptor, undefined);
        const snapshot = createIngestSnapshot(session);
        assert.equal(snapshot.session.persistenceSourceDescriptor, undefined);
        results.length = 0;
        assert.equal(pool.send(record, update), true);
        await withTimeout(pool.fence(), 'worker repeat fence');
        const repeated = results.flatMap(result =>
            result.actions.filter(action => action.mutation?.route).map(action => action.mutation)
        );
        assert.equal(
            repeated.length,
            64,
            'all repeat announcements are still sent for authoritative committed-state comparison'
        );
        assert.ok(repeated.every(mutation => mutation.scope.state === 'ready'));
        assert.deepEqual(
            repeated.map(mutation => mutation.route.id),
            mutations.map(mutation => mutation.route.id)
        );
        assert.deepEqual(errors, []);
        await withTimeout(pool.close(), 'worker close');
        assert.equal(pool.slots.length, 0);
        assert.equal(pool.callbacks.size, 0);
    } finally {
        await withTimeout(pool.close(), 'worker cleanup').catch(() => {});
    }
}

async function main() {
    testDescriptorReuse('peer');
    testDescriptorReuse('loc-rib');
    await testRealWorkerSharedClone();
    console.log('BMP ingest immutable descriptor reuse tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
