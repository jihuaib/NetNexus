const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BgpConst = require('../../electron/const/bgpConst');
const BmpConst = require('../../electron/const/bmpConst');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const { buildScenario, parseArgs, ROUTE_HISTORY_SCENARIO } = require('../../scripts/mockBmpClient');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-mock-route-history-'));
const store = new BmpPersistenceStore({ dbPath: path.join(tempDir, 'bmp.sqlite3') }).open();
const persistenceFailures = [];
let batchSequence = 0;

try {
    const bmpWorker = {
        bmpSessionMap: new Map(),
        bmpConfigData: {
            bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20
        },
        persistence: store,
        enqueuePersistenceMutation(mutation) {
            batchSequence += 1;
            store.applyBatch({
                batchId: `mock-route-history-${batchSequence}`,
                createdAtMs: Date.now(),
                mutations: [mutation]
            });
            return true;
        },
        handlePersistenceFailure(error) {
            persistenceFailures.push(error);
        },
        enqueueRouteUpdateEvent() {},
        enqueueInstanceRouteUpdateEvent() {},
        invalidateRouteAssurance() {},
        requestPersistenceSweep() {}
    };
    const session = new BmpSession({ sendEvent() {} }, bmpWorker);
    Object.assign(session, {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: '127.0.0.2',
        remotePort: 50000
    });

    const options = parseArgs(['--scenario', 'route-history', '--interval', '0', '--no-dump-packets']);
    buildScenario(options).forEach(message => session.processMessage(message.data));
    assert.deepEqual(persistenceFailures, []);

    const expectedRoutes = [
        {
            identity: ROUTE_HISTORY_SCENARIO.evpnIdentity,
            afi: BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
            nlriKind: 'evpn'
        },
        {
            identity: ROUTE_HISTORY_SCENARIO.bgpLsIdentity,
            afi: BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS,
            nlriKind: 'raw-nlri'
        },
        {
            identity: ROUTE_HISTORY_SCENARIO.flowSpecIdentity,
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC,
            nlriKind: 'raw-nlri'
        }
    ];

    expectedRoutes.forEach(expected => {
        const identity = store.db
            .prepare(
                `SELECT route_pk, route_id, legacy_route_key, afi, safi, prefix, nlri_kind,
                        current_ref_count, event_ref_count
                   FROM bmp_route_identities
                  WHERE prefix = @prefix`
            )
            .get({ prefix: expected.identity });
        assert.ok(identity, `${expected.identity} must be persisted`);
        assert.equal(identity.afi, expected.afi);
        assert.equal(identity.safi, expected.safi);
        assert.equal(identity.nlri_kind, expected.nlriKind);
        assert.ok(identity.legacy_route_key.includes(`|${expected.identity}|`));
        assert.equal(identity.current_ref_count, 0, 'the final MP_UNREACH must remove the current projection');
        assert.equal(identity.event_ref_count, 3);

        const events = store.db
            .prepare(
                `SELECT event_type, attr_id
                   FROM bmp_route_events
                  WHERE route_pk = @routePk
                  ORDER BY event_id`
            )
            .all({ routePk: identity.route_pk });
        assert.deepEqual(
            events.map(event => event.event_type),
            ['announce', 'replace', 'withdraw']
        );
        assert.notEqual(events[0].attr_id, events[1].attr_id, 'the second announcement must be an attribute replace');
        assert.equal(events[2].attr_id, null);

        const groupedHistory = store.queryEvents({
            groupByRoute: true,
            prefix: expected.identity,
            pageSize: 10
        });
        assert.equal(groupedHistory.total, 1);
        assert.equal(groupedHistory.list.length, 1);
        assert.equal(groupedHistory.list[0].route.ip, expected.identity);
        assert.equal(groupedHistory.list[0].latestEvent.eventType, 'withdraw');
        assert.equal(groupedHistory.list[0].eventCount, 3);

        const scope = store.db
            .prepare(
                `SELECT scope_state, current_epoch, eor_epoch
                   FROM bmp_rib_scopes
                  WHERE afi = @afi AND safi = @safi AND rib_type = @ribType`
            )
            .get({
                afi: expected.afi,
                safi: expected.safi,
                ribType: String(BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN)
            });
        assert.ok(scope, `${expected.identity} scope must exist`);
        assert.equal(scope.scope_state, 'ready');
        assert.equal(scope.eor_epoch, scope.current_epoch);
    });

    console.log(
        `BMP mock non-IP route lifecycle passed: EVPN=${ROUTE_HISTORY_SCENARIO.evpnIdentity}, ` +
            `BGP-LS=${ROUTE_HISTORY_SCENARIO.bgpLsIdentity}, FlowSpec=${ROUTE_HISTORY_SCENARIO.flowSpecIdentity}`
    );
} finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
