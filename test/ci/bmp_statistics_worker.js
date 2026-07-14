const assert = require('node:assert/strict');

const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

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
const persistedSessionReport = {
    client: { ...client, connectionState: 'open', isOnline: true },
    session: { ...session },
    statistics: [{ type: 0, typeName: 'Prefixes rejected', value: 10 }],
    updatedAt: '2026-07-15T00:00:00.000Z'
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
        return query.kind === 'instance' ? [persistedInstanceReport] : [persistedSessionReport];
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
    assert.equal(offlineSession.data.length, 1);
    assert.equal(offlineSession.data[0].statistics[0].value, 10);
    assert.equal(offlineSession.data[0].client.connectionState, 'closed');
    assert.equal(offlineSession.data[0].client.isOnline, false);
    assert.equal(offlineSession.data[0].session.isOnline, false);

    await worker.getBgpInstanceStatisticsReports('offline-instance', client);
    const offlineInstance = responses.get('offline-instance');
    assert.equal(offlineInstance.status, 'success');
    assert.equal(offlineInstance.data.length, 1);
    assert.equal(offlineInstance.data[0].statistics[0].value, 20);
    assert.equal(offlineInstance.data[0].instance.isOnline, false);

    const liveSessionReport = {
        ...persistedSessionReport,
        statistics: [{ type: 0, typeName: 'Prefixes rejected', value: 11 }],
        updatedAt: '2026-07-15T00:00:02.000Z'
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
    assert.equal(liveSession.data.length, 1, 'live report must replace the persisted sample for the same peer');
    assert.equal(liveSession.data[0].statistics[0].value, 11);
    assert.equal(liveSession.data[0].client.remotePort, 50001);
    assert.equal(liveSession.data[0].client.connectionState, 'open');
    assert.equal(liveSession.data[0].client.isOnline, true);

    console.log('BMP persisted statistics worker tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
