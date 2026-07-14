const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const BmpRouteAssuranceService = require('../../electron/utils/bmpRouteAssuranceService');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');

const BmpWorker = loadBmpWorkerClass(__dirname, module);
const worker = Object.create(BmpWorker.prototype);
const responses = [];

const route = {
    afi: 1,
    safi: 1,
    rd: '0:0',
    ip: '203.0.113.0',
    mask: 24,
    pathId: 1,
    routeState: BmpConst.BMP_ROUTE_STATE.ACTIVE,
    routeTlvs: [{ name: 'VRF/Table Name', value: 'worker-cache' }]
};
const routeMap = new Map([['route', route]]);
worker.bmpSessionMap = new Map([
    [
        'cache-client',
        {
            getClientInfo: () => ({ sysName: 'cache-router', remoteIp: '192.0.2.1' }),
            bgpSessionMap: new Map([
                [
                    'cache-peer',
                    {
                        sessionIp: '198.51.100.1',
                        sessionAs: 65001,
                        sessionRd: '0:0',
                        vrfTableNames: ['worker-cache'],
                        bgpRoutes: new Map([['1|1', new Map([[BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN, routeMap]])]])
                    }
                ]
            ]),
            bgpInstanceMap: new Map()
        }
    ]
]);
worker.routeAssuranceService = new BmpRouteAssuranceService();
worker.routeUpdateAggregator = {
    enqueueRouteUpdate() {},
    enqueueInstanceRouteUpdate() {}
};
worker.scheduleRouteUpdateFlush = () => {};
worker.messageHandler = {
    sendSuccessResponse(messageId, data, msg) {
        responses.push({ messageId, data, msg });
    },
    sendErrorResponse(messageId, msg) {
        throw new Error(`${messageId}: ${msg}`);
    }
};

async function waitForRouteAssuranceRebuild() {
    await new Promise(resolve => setImmediate(resolve));
    if (worker.routeAssuranceService.bootstrapPromise) {
        await worker.routeAssuranceService.bootstrapPromise;
    }
}

async function verifyWorkerCache() {
    await worker.getRouteAssurance('first', { page: 1, pageSize: 1 });
    await worker.getRouteAssurance('second', { page: 2, pageSize: 1 });
    assert.equal(responses[0].data.summary.cacheHit, false);
    assert.equal(responses[1].data.summary.cacheHit, true);

    const revisionBeforeUpdate = worker.routeAssuranceService.getStats().dataRevision;
    worker.enqueueRouteUpdateEvent({ changedCount: 1 });
    assert.equal(worker.routeAssuranceService.getStats().dataRevision, revisionBeforeUpdate + 1);
    await waitForRouteAssuranceRebuild();
    await worker.getRouteAssurance('after-update', { page: 1, pageSize: 1 });
    assert.equal(responses[2].data.summary.cacheHit, true);
    assert.equal(responses[2].data.summary.dataRevision, revisionBeforeUpdate + 1);

    const revisionBeforeInstanceUpdate = worker.routeAssuranceService.getStats().dataRevision;
    worker.enqueueInstanceRouteUpdateEvent({ changedCount: 1 });
    assert.equal(worker.routeAssuranceService.getStats().dataRevision, revisionBeforeInstanceUpdate + 1);
    await waitForRouteAssuranceRebuild();

    const revisionBeforeSessionClose = worker.routeAssuranceService.getStats().dataRevision;
    const closingSession = new BmpSession(worker.messageHandler, worker);
    closingSession.closeSession();
    assert.equal(worker.routeAssuranceService.getStats().dataRevision, revisionBeforeSessionClose + 1);
    await waitForRouteAssuranceRebuild();
}

verifyWorkerCache()
    .then(() => console.log('BMP Route Assurance worker cache integration tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
