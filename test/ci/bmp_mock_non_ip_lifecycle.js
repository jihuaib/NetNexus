const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BgpConst = require('../../electron/const/bgpConst');
const BmpConst = require('../../electron/const/bmpConst');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const { canonicalStringify } = require('../../electron/utils/bmpPersistentRouteKey');
const { buildScenario, parseArgs, ROUTE_HISTORY_SCENARIO } = require('../../scripts/mockBmpClient');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-mock-non-ip-lifecycle-'));
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
                batchId: `mock-non-ip-lifecycle-${batchSequence}`,
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

    const options = parseArgs(['--scenario', 'non-ip-lifecycle', '--interval', '0', '--no-dump-packets']);
    buildScenario(options).forEach(message => session.processMessage(message.data));
    assert.deepEqual(persistenceFailures, []);

    const expectedRoutes = [
        {
            identity: ROUTE_HISTORY_SCENARIO.evpnIdentity,
            afi: BgpConst.BGP_AFI_TYPE.AFI_L2VPN,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_EVPN,
            nlriKind: 'evpn',
            canonicalNlri: {
                kind: 'evpn',
                semantic: {
                    routeType: 2,
                    rd: 'raw:0000fde800000029',
                    ethernetTagId: 141,
                    macLength: 48,
                    macAddress: 'aa:bb:cc:dd:ee:29',
                    ipLength: 32,
                    ipAddress: 'c0000233'
                }
            }
        },
        {
            identity: ROUTE_HISTORY_SCENARIO.bgpLsIdentity,
            afi: BgpConst.BGP_AFI_TYPE.AFI_BGP_LS,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_BGP_LS,
            nlriKind: 'raw-nlri',
            canonicalNlri: {
                kind: 'raw-nlri',
                routeType: 2,
                rd: null,
                // Protocol/identifier, both node descriptors and link addresses.
                rawNlriHex:
                    '0300000000000061a9' +
                    '01000010020000040000fdf1020300040a640001' +
                    '01010010020000040000fe55020300040ac80001' +
                    '010300040afa0001010400040afa0002'
            }
        },
        {
            identity: ROUTE_HISTORY_SCENARIO.flowSpecIdentity,
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_FLOW_SPEC,
            nlriKind: 'raw-nlri',
            canonicalNlri: {
                kind: 'raw-nlri',
                routeType: null,
                rd: null,
                // Destination /24, IP protocol = TCP, destination port = 443.
                rawNlriHex: '0118c612fd038106059101bb'
            }
        }
    ];

    expectedRoutes.forEach(expected => {
        const identities = store.db
            .prepare(
                `SELECT route_pk, route_id, legacy_route_key, afi, safi, prefix, nlri_kind
                   FROM bmp_route_identities
                  WHERE prefix = @prefix`
            )
            .all({ prefix: expected.identity });
        assert.equal(identities.length, 1, `${expected.identity} announce/replace/withdraw must share one identity`);
        const [identity] = identities;
        assert.equal(identity.afi, expected.afi);
        assert.equal(identity.safi, expected.safi);
        assert.equal(identity.nlri_kind, expected.nlriKind);
        const rdIdentity = expected.canonicalNlri.rd || expected.canonicalNlri.semantic?.rd || '0:0';
        const completeNlriJson = canonicalStringify(expected.canonicalNlri).replace(/\|/g, '\\u007c');
        assert.equal(
            identity.legacy_route_key,
            `0|${rdIdentity}|${expected.afi}:${expected.safi}:${expected.nlriKind}:${completeNlriJson}`,
            'the public route key must carry the entire canonical NLRI rather than its display prefix'
        );
        assert.equal(
            store.db
                .prepare('SELECT COUNT(*) AS count FROM bmp_current_route_refs WHERE route_pk = @routePk')
                .get({ routePk: identity.route_pk }).count,
            0,
            'the final MP_UNREACH must remove the current projection'
        );

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
