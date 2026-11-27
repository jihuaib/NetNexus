const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const WorkerMessageHandler = require('../../electron/worker/core/workerMessageHandler');
WorkerMessageHandler.prototype.init = function initForTest() {};
const BgpConst = require('../../electron/const/bgpConst');
const BgpInstance = require('../../electron/worker/bgp/bgpInstance');
const BgpRouteSqliteStore = require('../../electron/worker/bgp/bgpRouteSqliteStore');
const BgpWorker = require('../../electron/worker/bgp/bgpWorker');

const QP = BgpConst.BGP_ADDR_FAMILY.IPV6_QP;
const LABEL = BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST;
const qpKey = 'bulk-delete|2|241';
const qpOtherKey = 'bulk-delete-other|2|241';
const labelKey = 'bulk-delete|1|4';
const qpTable = BgpRouteSqliteStore.ROUTE_TABLE_DEFINITIONS.find(family => family.addressFamily === QP).tableName;
const labelTable = BgpRouteSqliteStore.ROUTE_TABLE_DEFINITIONS.find(family => family.addressFamily === LABEL).tableName;

function entry(suffix, med = 10, dqpn = 1) {
    return {
        route: { ip: `2001:db8::${suffix.toString(16)}`, mask: 128, dqpn, mpNextHop: '2001:db8::ffff' },
        attr: { origin: 'IGP', asPath: '65000', med }
    };
}

function replace(store, groupId, routes, options = {}) {
    return store.replaceRouteGroup(groupId, {
        groupName: `Group ${groupId}`,
        addressFamily: QP,
        instanceKey: qpKey,
        includeOldRoutes: false,
        routes,
        ...options
    });
}

function snapshot(store) {
    return {
        routes: store.db.prepare(`SELECT * FROM ${qpTable} ORDER BY route_id`).all(),
        labels: store.db.prepare(`SELECT * FROM ${labelTable} ORDER BY route_id`).all(),
        groups: store.db.prepare('SELECT * FROM bgp_route_groups ORDER BY group_id').all(),
        members: store.db.prepare('SELECT * FROM bgp_route_group_members ORDER BY instance_id, route_key').all(),
        instances: store.db.prepare('SELECT * FROM bgp_route_instances ORDER BY instance_id').all(),
        attributes: store.db.prepare('SELECT * FROM bgp_route_attributes ORDER BY attr_id').all(),
        orphanCandidates: store.db.prepare('SELECT * FROM bgp_route_orphan_candidates ORDER BY attr_id').all()
    };
}

function testStoreDeletion() {
    const store = new BgpRouteSqliteStore().open();
    try {
        replace(store, 'target', [entry(1, 10), entry(2, 20), entry(3, 30, null)]);
        replace(store, 'neighbor', [entry(4, 10)]);
        replace(store, 'mirror', [entry(3, 30, null)], { instanceKey: qpOtherKey });
        store.upsertRoutes(qpKey, [entry(5, 10)]);
        const expectedRoutes = store.getRouteGroupRoutes('target');
        const beforeFailure = snapshot(store);
        for (const action of ["ABORT, 'injected bulk delete failure'", 'IGNORE']) {
            store.db.exec(`
                CREATE TEMP TRIGGER bulk_fail_delete BEFORE DELETE ON main.${qpTable}
                WHEN OLD.prefix = '2001:db8::2'
                BEGIN SELECT RAISE(${action}); END
            `);
            assert.throws(
                () => store.withdrawRouteGroup('target'),
                /injected bulk delete failure|failed|incomplete|delet|withdraw/i,
                'an ignored or rejected route deletion must fail the complete group operation'
            );
            assert.deepEqual(
                snapshot(store),
                beforeFailure,
                'failed deletion rolls back rows, ownership and statistics'
            );
            store.db.exec('DROP TRIGGER bulk_fail_delete');
        }
        store.db.exec(`
            CREATE TEMP TRIGGER bulk_fail_group_delete BEFORE DELETE ON main.bgp_route_groups
            WHEN OLD.group_id = 'target'
            BEGIN SELECT RAISE(ABORT, 'injected group deletion failure'); END
        `);
        assert.throws(() => store.withdrawRouteGroup('target'), /injected group deletion failure/);
        assert.deepEqual(snapshot(store), beforeFailure, 'group metadata failure restores the deleted route rows');
        store.db.exec('DROP TRIGGER bulk_fail_group_delete');

        const beforeStats = store.getInstanceStats(qpKey);
        const mirrorStats = store.getInstanceStats(qpOtherKey);
        const result = store.withdrawRouteGroup('target');
        assert.equal(result.deleted, 3);
        assert.deepEqual(result.routes, expectedRoutes, 'the default API retains exact stored withdrawal snapshots');
        assert.equal(result.routes[2].dqpn, null, 'an absent QP field remains absent during withdrawal');
        assert.ok(result.routes.every(route => route.instanceKey === qpKey));
        assert.equal(store.getRouteCount(qpKey), 2, 'other groups and legacy rows remain in the same instance');
        assert.equal(store.getInstanceStats(qpKey).revision, beforeStats.revision + 1);
        assert.deepEqual(store.getInstanceStats(qpOtherKey), mirrorStats, 'another instance is unchanged');
        assert.deepEqual(
            store.getRouteGroupRoutes('neighbor').map(route => route.ip),
            ['2001:db8::4']
        );
        assert.equal(store.getRouteGroupRoutes('mirror')[0].dqpn, null);
        assert.equal(
            store.getStatus().attributes,
            2,
            'shared attributes survive and unreferenced attributes are reclaimed'
        );
        assert.equal(store.sweepOrphanAttributes(), 0, 'bulk deletion leaves no orphan attributes behind');
        assert.equal(
            store.db.prepare("SELECT COUNT(*) AS count FROM bgp_route_group_members WHERE group_id = 'target'").get()
                .count,
            0
        );
        const afterDeletion = snapshot(store);
        assert.deepEqual(store.withdrawRouteGroup('missing'), { deleted: 0, routes: [] });
        assert.deepEqual(snapshot(store), afterDeletion, 'a missing group does not mutate statistics or attributes');

        const labelRoutes = [
            { route: { ip: '192.0.2.1', mask: 32, label: 16, pathId: 7, nlriEncoding: 'mpReach' }, attr: { med: 10 } },
            {
                route: { ip: '192.0.2.2', mask: 32, label: null, pathId: 8, nlriEncoding: 'mpReach' },
                attr: { attributePolicy: 'configured', configuredAttributes: ['med'], med: 10 }
            }
        ];
        replace(store, 'labels', labelRoutes, { addressFamily: LABEL, instanceKey: labelKey });
        const expectedLabels = store.getRouteGroupRoutes('labels');
        assert.deepEqual(store.withdrawRouteGroup('labels').routes, expectedLabels);
        assert.deepEqual(
            expectedLabels.map(route => [route.ip, route.pathId, route.label]),
            [
                ['192.0.2.1', 7, 16],
                ['192.0.2.2', 8, null]
            ]
        );
        assert.equal(store.getRouteCount(labelKey), 0);
        assert.deepEqual(store.db.pragma('foreign_key_check'), []);
    } finally {
        store.close();
    }
}

function testStoreSnapshotLifecycle() {
    const store = new BgpRouteSqliteStore().open();
    try {
        const configuredAttr = {
            attributePolicy: 'configured',
            configuredAttributes: ['med'],
            med: 42,
            pathAttributes: [{ type: 'med', value: 42 }]
        };
        replace(
            store,
            'paged',
            Array.from({ length: 4501 }, (_, index) => ({
                ...entry(index + 1, 10, index === 4500 ? null : 1),
                attr: configuredAttr
            })),
            {
                instanceKey: qpKey
            }
        );
        const expected = store.getRouteGroupRoutes('paged');
        let mapped = 0;
        const originalMap = store.mapRouteRow.bind(store);
        store.mapRouteRow = (...args) => {
            mapped += 1;
            return originalMap(...args);
        };
        const result = store.withdrawRouteGroup('paged', { snapshot: true });
        assert.equal(result.deleted, 4501);
        assert.equal(store.getRouteCount(qpKey), 0);
        assert.equal(mapped, 0, 'creating a withdrawal snapshot must not eagerly parse all routes');
        assert.equal(Array.isArray(result.routes), false, 'snapshot mode returns a bounded-memory iterable');
        assert.equal(typeof result.routes[Symbol.iterator], 'function');
        const rows = Array.from(result.routes);
        assert.equal(rows.length, 4501);
        assert.deepEqual(
            rows.map(route => route.routeKey),
            expected.map(route => route.routeKey)
        );
        const nlri = route => [
            route.ip,
            route.mask,
            route.dqpn,
            route.mpNextHop,
            route.nlriEncoding,
            route.instanceKey
        ];
        assert.deepEqual(rows.map(nlri), expected.map(nlri), 'withdrawal NLRI survives live route removal');
        assert.ok(
            rows.every(route => (route.routeAttr?.attributePolicy ?? route.attributePolicy) === 'configured'),
            'withdrawal keeps the policy needed to distinguish absent NLRI fields'
        );
        assert.equal(typeof result.release, 'function');
        result.release();
        assert.doesNotThrow(() => result.release(), 'snapshot release is idempotent');
        assert.equal(store.getStatus().attributes, 0);

        replace(store, 'unread', [entry(1, 99)]);
        const unread = store.withdrawRouteGroup('unread', { snapshot: true });
        assert.equal(unread.deleted, 1);
        unread.release();
        assert.equal(store.getStatus().attributes, 0, 'an unread snapshot can be released');

        replace(
            store,
            'absent-label',
            [{ route: { ip: '192.0.2.1', mask: 32, pathId: 7, label: null }, attr: configuredAttr }],
            {
                addressFamily: LABEL,
                instanceKey: labelKey
            }
        );
        const labels = store.withdrawRouteGroup('absent-label', { snapshot: true });
        const labelRows = Array.from(labels.routes);
        assert.deepEqual(
            labelRows.map(route => [route.ip, route.pathId, route.label]),
            [['192.0.2.1', 7, null]]
        );
        labels.release();

        replace(
            store,
            'zero-source-as',
            [
                {
                    route: {
                        routeType: 6,
                        rd: '65000:1',
                        sourceAs: 0,
                        sourceIp: '198.51.100.1',
                        groupIp: '239.1.1.1',
                        mpNextHop: null
                    },
                    attr: configuredAttr
                }
            ],
            { addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN, instanceKey: 'bulk-delete|1|5' }
        );
        const mvpn = store.withdrawRouteGroup('zero-source-as', { snapshot: true });
        const mvpnRows = Array.from(mvpn.routes);
        assert.deepEqual(
            mvpnRows.map(route => [route.routeType, route.sourceAs, route.mpNextHop]),
            [[6, 0, null]]
        );
        mvpn.release();

        replace(store, 'offline', [entry(1, 42), entry(2, 42)]);
        store.mapRouteRow = () => assert.fail('includeRoutes:false must bypass withdrawal-row hydration');
        const offline = store.withdrawRouteGroup('offline', { includeRoutes: false });
        assert.equal(offline.deleted, 2);
        assert.deepEqual(offline.routes, []);
        assert.equal(store.getStatus().attributes, 0);
        assert.equal(store.sweepOrphanAttributes(), 0);
        assert.deepEqual(store.db.pragma('foreign_key_check'), []);
    } finally {
        store.close();
    }
}

function testInstanceDeletion() {
    const store = new BgpRouteSqliteStore().open();
    try {
        replace(store, 'first', [entry(1), entry(2)]);
        replace(store, 'second', [entry(3)]);
        replace(store, 'other-instance', [entry(1)], { instanceKey: qpOtherKey });
        store.upsertRoutes(qpKey, [entry(4)]);
        const before = snapshot(store);
        store.db.exec(`
            CREATE TEMP TRIGGER instance_ignore_delete BEFORE DELETE ON main.${qpTable}
            WHEN OLD.prefix = '2001:db8::2'
            BEGIN SELECT RAISE(IGNORE); END
        `);
        assert.throws(
            () => store.withdrawInstanceRoutes(qpKey, { snapshot: true }),
            /failed|incomplete|delet|withdraw/i
        );
        assert.deepEqual(
            snapshot(store),
            before,
            'an incomplete instance deletion rolls back all groups and legacy rows'
        );
        store.db.exec('DROP TRIGGER instance_ignore_delete');
        const stats = store.getInstanceStats(qpKey);
        const cleared = store.withdrawInstanceRoutes(qpKey, { snapshot: true });
        assert.equal(cleared.deleted, 4);
        assert.deepEqual(
            Array.from(cleared.routes).map(route => route.ip),
            ['2001:db8::1', '2001:db8::2', '2001:db8::3', '2001:db8::4']
        );
        cleared.release();
        assert.equal(store.getRouteCount(qpKey), 0);
        assert.equal(store.getInstanceStats(qpKey).revision, stats.revision + 1);
        assert.equal(store.getRouteCount(qpOtherKey), 1);
        assert.deepEqual(
            store.listRouteGroups().map(group => group.groupId),
            ['other-instance']
        );

        const mvpnKey = 'bulk-delete|1|5';
        const mvpnEntry = (routeType, suffix) => ({
            route: {
                routeType,
                rd: '65000:1',
                sourceAs: 0,
                sourceIp: `198.51.100.${suffix}`,
                groupIp: '239.1.1.1',
                mpNextHop: null
            },
            attr: { attributePolicy: 'configured', configuredAttributes: [] }
        });
        const mvpnOptions = { addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN, instanceKey: mvpnKey };
        replace(store, 'mixed-types', [mvpnEntry(6, 1), mvpnEntry(5, 2)], mvpnOptions);
        replace(store, 'only-selected-type', [mvpnEntry(6, 3)], mvpnOptions);
        const beforeSelected = store.getInstanceStats(mvpnKey);
        const selected = store.withdrawInstanceRoutes(mvpnKey, { routeType: 6, snapshot: true });
        assert.equal(selected.deleted, 2);
        assert.deepEqual(
            Array.from(selected.routes).map(route => [route.routeType, route.sourceAs]),
            [
                [6, 0],
                [6, 0]
            ]
        );
        selected.release();
        assert.equal(store.getInstanceStats(mvpnKey).revision, beforeSelected.revision + 1);
        assert.equal(store.getRouteCount(mvpnKey), 1);
        assert.deepEqual(
            store.getRouteGroupRoutes('mixed-types').map(route => route.routeType),
            [5]
        );
        assert.equal(store.listRouteGroups().find(group => group.groupId === 'mixed-types').routeCount, 1);
        assert.ok(!store.listRouteGroups().some(group => group.groupId === 'only-selected-type'));
        assert.equal(store.withdrawInstanceRoutes(mvpnKey, { routeType: 5, includeRoutes: false }).deleted, 1);
        assert.equal(store.getRouteCount(mvpnKey), 0);
        assert.equal(store.getStatus().attributes, 1, 'only the other instance retains a path attribute record');
        assert.equal(store.sweepOrphanAttributes(), 0);
        assert.deepEqual(store.db.pragma('foreign_key_check'), []);
    } finally {
        store.close();
    }
}

async function testWorkerPagedDeletion() {
    const store = new BgpRouteSqliteStore().open();
    const worker = new BgpWorker();
    const instance = new BgpInstance(0, 2, BgpConst.BGP_SAFI_TYPE.SAFI_QP, store);
    worker.routeStore = store;
    worker.bgpInstanceMap.set(instance.instanceKey, instance);
    const responses = [];
    worker.messageHandler.sendSuccessResponse = (id, data) => responses.push({ id, data });
    const batches = [];
    let release;
    const backpressure = new Promise(resolve => {
        release = resolve;
    });
    instance.peerMap.set('established', { peerState: BgpConst.BGP_PEER_STATE.ESTABLISHED });
    instance.withdrawRoute = routes => {
        assert.equal(
            store.getRouteCount(instance.instanceKey),
            0,
            'the entire deletion commits before wire withdrawal'
        );
        batches.push(routes);
        return batches.length === 1 ? backpressure : null;
    };
    try {
        replace(
            store,
            'large',
            Array.from({ length: 4501 }, (_, index) => entry(index + 1, 10, index === 4500 ? null : 1)),
            {
                instanceKey: instance.instanceKey
            }
        );
        const expected = store.getRouteGroupRoutes('large');
        store.getRouteGroupRoutes = () => assert.fail('worker deletion must not materialize the complete group');
        let hydrated = 0;
        const originalHydrate = instance.hydrateRoute.bind(instance);
        instance.hydrateRoute = row => {
            hydrated += 1;
            return originalHydrate(row);
        };
        const pending = worker.withdrawRouteGroup('large-remove', { groupId: 'large', prefix: 'invalid-draft' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(batches.length, 1, 'socket backpressure must stop the next withdrawal batch');
        assert.equal(batches[0].length, 2000);
        assert.equal(hydrated, 2000, 'later batches must not be hydrated while waiting for the socket');
        assert.equal(responses.length, 0, 'the operation stays pending until withdrawal backpressure clears');
        assert.equal(worker.pendingRouteGroupMutations, 1);
        release();
        await pending;
        assert.deepEqual(
            batches.map(batch => batch.length),
            [2000, 2000, 501]
        );
        assert.deepEqual(
            batches.flat().map(route => route.routeKey),
            expected.map(route => route.routeKey)
        );
        assert.equal(batches.at(-1).at(-1)._dqpnAbsent, true, 'a paged snapshot retains null QP identity');
        assert.deepEqual(responses, [{ id: 'large-remove', data: { deleted: 4501 } }]);
        assert.equal(worker.pendingRouteGroupMutations, 0);

        replace(store, 'failed', [entry(1), entry(2)], { instanceKey: instance.instanceKey });
        const beforeFailure = snapshot(store);
        batches.length = 0;
        store.db.exec(`
            CREATE TEMP TRIGGER bulk_worker_fail_delete BEFORE DELETE ON main.${qpTable}
            WHEN OLD.prefix = '2001:db8::2'
            BEGIN SELECT RAISE(ABORT, 'injected worker deletion failure'); END
        `);
        await assert.rejects(
            worker.withdrawRouteGroup('failed-remove', { groupId: 'failed' }),
            /injected worker deletion failure/
        );
        assert.deepEqual(snapshot(store), beforeFailure);
        assert.equal(batches.length, 0, 'failed persistence must never emit a withdrawal');
        assert.equal(worker.pendingRouteGroupMutations, 0, 'failure releases the mutation lifecycle');
        store.db.exec('DROP TRIGGER bulk_worker_fail_delete');

        replace(store, 'wire-failed', [entry(3), entry(4)], { instanceKey: instance.instanceKey });
        instance.withdrawRoute = () => {
            throw new Error('injected withdrawal failure');
        };
        await assert.rejects(
            worker.withdrawRouteGroup('wire-failed-remove', { groupId: 'wire-failed' }),
            /injected withdrawal failure/
        );
        assert.equal(store.getRouteCount(instance.instanceKey), 2, 'the committed deletion survives a wire failure');
        assert.equal(worker.pendingRouteGroupMutations, 0, 'wire failure releases the mutation lifecycle');
        replace(store, 'after-wire-failure', [entry(5)], { instanceKey: instance.instanceKey });
        instance.withdrawRoute = routes => batches.push(routes);
        await worker.withdrawRouteGroup('after-wire-failure-remove', { groupId: 'after-wire-failure' });
        assert.equal(
            store.getRouteCount(instance.instanceKey),
            2,
            'a failed snapshot is released before the next deletion'
        );

        instance.peerMap.clear();
        instance.peerMap.set('idle', { peerState: BgpConst.BGP_PEER_STATE.IDLE });
        instance.hydrateRoute = () => assert.fail('offline deletion must not hydrate withdrawal objects');
        store.mapRouteRow = () => assert.fail('offline deletion must not read or parse route snapshots');
        instance.withdrawRoute = () => assert.fail('offline deletion must not build withdrawal batches');
        await worker.withdrawRouteGroup('offline-remove', { groupId: 'failed' });
        assert.equal(store.getRouteCount(instance.instanceKey), 0);
        assert.deepEqual(responses.at(-1), { id: 'offline-remove', data: { deleted: 2 } });
        assert.deepEqual(store.db.pragma('foreign_key_check'), []);
    } finally {
        release();
        store.close();
    }
}

(async () => {
    testStoreDeletion();
    testStoreSnapshotLifecycle();
    testInstanceDeletion();
    if (!process.argv.includes('--store-only')) await testWorkerPagedDeletion();
    console.log('BGP route group bulk deletion tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
