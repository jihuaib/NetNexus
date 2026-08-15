const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BgpConst = require('../../electron/const/bgpConst');
const BmpConst = require('../../electron/const/bmpConst');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const { buildScenario, parseArgs } = require('../../scripts/mockBmpClient');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-mock-loc-rib-'));
const store = new BmpPersistenceStore({ dbPath: path.join(tempDir, 'bmp.sqlite3') }).open();
const persistenceFailures = [];
const topologyEvents = [];
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
                batchId: `mock-loc-rib-${batchSequence}`,
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
    const session = new BmpSession(
        {
            sendEvent(type, payload) {
                if (type === BmpConst.BMP_EVT_TYPES.SESSION_UPDATE || type === BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE) {
                    topologyEvents.push({ type, payload });
                }
            }
        },
        bmpWorker
    );
    Object.assign(session, {
        localIp: '127.0.0.1',
        localPort: 1790,
        remoteIp: '127.0.0.2',
        remotePort: 50000
    });

    const options = parseArgs(['--routes', '1', '--interval', '0', '--no-dump-packets']);
    const eorEventBatches = new Map();
    buildScenario(options).forEach(message => {
        const topologyEventCount = topologyEvents.length;
        session.processMessage(message.data);
        if (message.name === 'eor-loc-rib-default-ipv4-unicast') {
            eorEventBatches.set(message.name, topologyEvents.slice(topologyEventCount));
        }
    });
    assert.deepEqual(persistenceFailures, []);

    const defaultLocRibEorEvents = eorEventBatches.get('eor-loc-rib-default-ipv4-unicast') || [];
    assert.equal(defaultLocRibEorEvents.length, 1, 'one Loc-RIB EOR message must emit one topology update');
    assert.equal(defaultLocRibEorEvents[0].type, BmpConst.BMP_EVT_TYPES.INSTANCE_UPDATE);
    assert.ok(
        defaultLocRibEorEvents[0].payload?.data?.instance?.routeScopes?.some(scope => scope.scopeState === 'ready'),
        'a Loc-RIB EOR must emit a ready INSTANCE_UPDATE topology event'
    );

    const globalSessionReports = Array.from(session.bgpStatisticsReportMap.values()).filter(
        report =>
            report.session.sessionType === BmpConst.BMP_PEER_TYPE.GLOBAL &&
            report.session.sessionRd === '0:0' &&
            report.session.sessionIp === '192.0.2.2' &&
            report.session.sessionAs === 65000
    );
    assert.equal(globalSessionReports.length, 4, 'mock must expose four independent session RIB statistics stages');
    const globalSessionReportsByRibType = new Map(globalSessionReports.map(report => [report.ribType, report]));
    const expectedSessionStatistics = new Map([
        [
            BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
            { globalType: BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_IN, value: options.routes }
        ],
        [
            BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
            { globalType: BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_IN, value: Math.max(0, options.routes - 1) }
        ],
        [
            BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT,
            { globalType: BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_OUT, value: options.routes + 2 }
        ],
        [
            BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT,
            { globalType: BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_OUT, value: options.routes + 1 }
        ]
    ]);
    expectedSessionStatistics.forEach(({ globalType, value }, ribType) => {
        const report = globalSessionReportsByRibType.get(ribType);
        assert.ok(report, `mock must contain session statistics for ribType ${ribType}`);
        assert.equal(report.statistics.length, 2);
        const globalStatistic = report.statistics.find(statistic => statistic.type === globalType);
        const perAfStatistic = report.statistics.find(
            statistic =>
                statistic.afi === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
                statistic.safi === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        );
        assert.equal(globalStatistic.value, value);
        assert.equal(globalStatistic.valueHex.length, 16, 'global Gauge mock values must use the RFC 8-byte format');
        assert.equal(perAfStatistic.value, value);
        assert.equal(perAfStatistic.valueHex.length, 22, 'per-AFI/SAFI Gauge mock values must use 11 bytes');
    });

    const locRibStatisticsReports = Array.from(session.bgpInstanceStatisticsReportMap.values());
    const locRibStatisticsByRd = new Map(locRibStatisticsReports.map(report => [report.instance.instanceRd, report]));
    assert.deepEqual(
        Array.from(locRibStatisticsByRd.keys()).sort(),
        ['0:0', '65000:100', '65000:102', '65000:120'],
        'mock must report Loc-RIB statistics for the global table and three distinct private RDs'
    );
    const expectedLocRibCounts = new Map([
        ['0:0', Math.max(8, Math.min(25, options.routes)) + 2],
        ['65000:100', 1],
        ['65000:102', 2],
        ['65000:120', 4]
    ]);
    expectedLocRibCounts.forEach((value, instanceRd) => {
        const report = locRibStatisticsByRd.get(instanceRd);
        const globalStatistic = report.statistics.find(
            statistic => statistic.type === BmpConst.BMP_STATS_TYPE.NUM_LOC_RIB
        );
        assert.equal(globalStatistic.value, value, `unexpected Loc-RIB statistics value for RD ${instanceRd}`);
        assert.equal(globalStatistic.valueHex.length, 16, 'Loc-RIB Gauge mock values must use the RFC 8-byte format');
    });
    assert.deepEqual(
        locRibStatisticsByRd
            .get('65000:102')
            .statistics.filter(statistic => statistic.type === BmpConst.BMP_STATS_TYPE.NUM_PER_AFI_SAFI_LOC_RIB)
            .map(statistic => statistic.safi)
            .sort((left, right) => left - right),
        [BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST, BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST],
        'RD 65000:102 must report both IPv4 unicast and labeled-unicast Loc-RIB statistics'
    );

    const defaultIpv4Instance = Array.from(session.bgpInstanceMap.values()).find(
        instance =>
            instance.instanceType === BmpConst.BMP_PEER_TYPE.LOCAL_RIB &&
            instance.instanceRd === '0:0' &&
            Number(instance.afi) === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
            Number(instance.safi) === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
    );
    assert.ok(defaultIpv4Instance, 'mock scenario should create the default-RD IPv4 Loc-RIB instance');
    assert.equal(
        defaultIpv4Instance.enabledAddressFamilies.some(
            family =>
                Number(family.afi) === BgpConst.BGP_AFI_TYPE.AFI_IPV4 &&
                Number(family.safi) === BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST
        ),
        true,
        'the combined default-RD Peer Up must advertise IPv4 unicast'
    );
    assert.equal(
        defaultIpv4Instance.enabledAddressFamilies.some(
            family =>
                Number(family.afi) === BgpConst.BGP_AFI_TYPE.AFI_L2VPN &&
                Number(family.safi) === BgpConst.BGP_SAFI_TYPE.SAFI_EVPN
        ),
        true,
        'the combined default-RD Peer Up must also advertise EVPN'
    );

    const scopeId = session.getPersistenceScopeId(
        defaultIpv4Instance,
        BgpConst.BGP_AFI_TYPE.AFI_IPV4,
        BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
        'loc-rib',
        'loc-rib'
    );
    const expectedRouteCount = Math.max(8, Math.min(25, options.routes)) + 2;
    const summary = store.queryScopeSummary({ scopeId });
    assert.equal(summary.scopes.length, 1);
    assert.equal(summary.scopes[0].scopeState, 'ready');
    assert.equal(summary.scopes[0].eorEpoch, summary.scopes[0].currentEpoch);
    assert.equal(summary.scopes[0].staleReason, null);
    assert.deepEqual(
        { active: summary.active, stale: summary.stale, total: summary.total },
        { active: expectedRouteCount, stale: 0, total: expectedRouteCount }
    );

    const routes = store.queryRoutes({ scopeId, routeState: 'all', pageSize: 5000 });
    assert.equal(routes.total, expectedRouteCount);
    assert.equal(
        routes.list.every(route => route.routeState === BmpConst.BMP_ROUTE_STATE.ACTIVE),
        true,
        'default-RD IPv4 Loc-RIB routes produced by the real mock scenario must remain active'
    );
    assert.equal(
        routes.list.every(
            route =>
                route.ribEpoch === summary.scopes[0].currentEpoch &&
                route.persistentConnectionId === summary.scopes[0].connectionId
        ),
        true,
        'the completed scope must not expose routes from an older epoch or connection'
    );
    assert.ok(routes.list.some(route => route.ip === '10.30.0.0'));
    assert.ok(routes.list.some(route => route.ip === '198.51.101.0'));
    assert.ok(routes.list.some(route => route.ip === '198.51.102.0'));

    const staleRemovalEvents = store
        .queryEvents({ scopeId, pageSize: 5000 })
        .list.filter(event => event.reason === 'peer-up-af-removed');
    assert.equal(staleRemovalEvents.length, 0);

    console.log(
        `BMP mock statistics and Loc-RIB lifecycle regression passed: active=${summary.active}, stale=${summary.stale}, scope=${summary.scopes[0].scopeState}`
    );
} finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
