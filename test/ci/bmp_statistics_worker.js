const assert = require('node:assert/strict');

const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');
const BmpConst = require('../../electron/const/bmpConst');

const BmpWorker = loadBmpWorkerClass(__dirname, module);

const sourceId = 'statistics-source';
const client = {
    persistentSourceId: sourceId,
    sourceId,
    persistentConnectionId: 'connection-1',
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '192.0.2.10',
    remotePort: 50000,
    connectionState: 'closed',
    isOnline: false
};
const session = {
    sessionType: 0,
    sessionRd: '0:0',
    sessionRdRaw: 'raw:0000000000000000',
    sessionIp: '192.0.2.2',
    sessionAs: 65000
};
const instance = {
    instanceType: 3,
    instanceRd: '0:0',
    instanceRdRaw: 'raw:0000000000000000'
};
const persistedPreInReport = {
    client: { ...client, connectionState: 'open', isOnline: true },
    session: { ...session },
    statistics: [{ type: BmpConst.BMP_STATS_TYPE.NUM_ADJ_RIB_IN, value: 10 }],
    updatedAt: '2026-07-15T00:00:00.000Z'
};
const persistedPostInReport = {
    client: { ...client, connectionState: 'open', isOnline: true },
    session: { ...session },
    effectiveSessionFlags: BmpConst.BMP_SESSION_FLAGS.POST_POLICY,
    statistics: [{ type: BmpConst.BMP_STATS_TYPE.NUM_ADJ_RIB_IN, value: 20 }],
    updatedAt: '2026-07-15T00:00:01.000Z'
};
const persistedMixedOutReport = {
    client: { ...client, connectionState: 'open', isOnline: true },
    session: { ...session },
    statistics: [
        { type: BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_OUT, value: 30 },
        { type: BmpConst.BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_OUT, value: 40 }
    ],
    updatedAt: '2026-07-15T00:00:02.000Z'
};
const persistedInstanceReport = {
    client: { ...client, connectionState: 'open', isOnline: true },
    instance: { ...instance },
    statistics: [{ type: 7, typeName: 'Routes in Loc-RIB', value: 20 }],
    updatedAt: '2026-07-15T00:00:01.000Z'
};
const topologyClient = {
    ...client,
    sessions: [{ ...session, connectionState: 'closed', isOnline: false }],
    instances: [{ ...instance, afi: 1, safi: 1, connectionState: 'closed', isOnline: false }]
};

async function main() {
    const worker = Object.create(BmpWorker.prototype);
    worker.persistence = {};
    worker.bmpSessionMap = new Map();
    worker.queryClientTopology = async queryClient => {
        assert.equal(queryClient.persistentSourceId, sourceId);
        return { topology: { clients: [topologyClient] }, client: topologyClient };
    };
    worker.readPersistence = async (method, query, options) => {
        assert.equal(method, 'queryStatisticsReports');
        assert.equal(query.sourceId, sourceId);
        assert.equal(options.fence, false);
        return query.kind === 'instance'
            ? [persistedInstanceReport]
            : [persistedMixedOutReport, persistedPostInReport, persistedPreInReport];
    };

    const responses = new Map();
    worker.messageHandler = {
        sendSuccessResponse(messageId, data) {
            responses.set(messageId, { status: 'success', data });
        },
        sendErrorResponse(messageId, message) {
            responses.set(messageId, { status: 'error', message });
        }
    };

    await worker.getBgpStatisticsReports('offline-session', client);
    const offlineSession = responses.get('offline-session');
    assert.equal(offlineSession.status, 'success');
    assert.equal(offlineSession.data.length, 4);
    const offlinePreIn = offlineSession.data.find(
        report => report.ribType === BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
    );
    const offlinePostIn = offlineSession.data.find(report => report.ribType === BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN);
    const offlinePreOut = offlineSession.data.find(report => report.ribType === BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT);
    const offlinePostOut = offlineSession.data.find(
        report => report.ribType === BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT
    );
    assert.equal(offlinePreIn.statistics[0].value, 10);
    assert.equal(offlinePostIn.statistics[0].value, 20);
    assert.equal(offlinePreOut.statistics[0].value, 30);
    assert.equal(offlinePostOut.statistics[0].value, 40);
    assert.equal(offlinePreIn.client.connectionState, 'closed');
    assert.equal(offlinePreIn.client.isOnline, false);
    assert.equal(offlinePreIn.session.isOnline, false);
    assert.equal(offlinePostOut.session.isOnline, false);

    await worker.getBgpInstanceStatisticsReports('offline-instance', client);
    const offlineInstance = responses.get('offline-instance');
    assert.equal(offlineInstance.status, 'success');
    assert.equal(offlineInstance.data.length, 1);
    assert.equal(offlineInstance.data[0].statistics[0].value, 20);
    assert.equal(offlineInstance.data[0].instance.isOnline, false);

    const liveSessionReport = {
        ...persistedPreInReport,
        ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
        statistics: [{ type: BmpConst.BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_IN, value: 11 }],
        updatedAt: '2026-07-15T00:00:03.000Z'
    };
    const liveBmpSession = {
        getPersistentSourceId: () => sourceId,
        getClientInfo: () => ({ ...client, remotePort: 50001, connectionState: 'open', isOnline: true }),
        bgpStatisticsReportMap: new Map([['session', liveSessionReport]]),
        bgpInstanceStatisticsReportMap: new Map()
    };
    worker.bmpSessionMap.set('live', liveBmpSession);

    await worker.getBgpStatisticsReports('live-session', client);
    const liveSession = responses.get('live-session');
    assert.equal(liveSession.status, 'success');
    assert.equal(liveSession.data.length, 4, 'a live pre-in report must not replace the other three RIB stages');
    const livePreIn = liveSession.data.find(report => report.ribType === BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN);
    const livePostIn = liveSession.data.find(report => report.ribType === BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN);
    const livePreOut = liveSession.data.find(report => report.ribType === BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_OUT);
    const livePostOut = liveSession.data.find(report => report.ribType === BmpConst.BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT);
    assert.equal(livePreIn.statistics[0].value, 11);
    assert.equal(livePostIn.statistics[0].value, 20);
    assert.equal(livePreOut.statistics[0].value, 30);
    assert.equal(livePostOut.statistics[0].value, 40);
    assert.equal(livePreIn.client.remotePort, 50001);
    assert.equal(livePreIn.client.connectionState, 'open');
    assert.equal(livePreIn.client.isOnline, true);
    assert.equal(livePostOut.session.isOnline, false);

    console.log('BMP persisted statistics worker tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
