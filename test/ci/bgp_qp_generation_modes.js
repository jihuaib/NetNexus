const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const WorkerMessageHandler = require(path.join(
    __dirname,
    '..',
    '..',
    'electron',
    'worker',
    'workerMessageHandler.js'
));

WorkerMessageHandler.prototype.init = function initForUnitTest() {};

const BgpWorker = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgpWorker.js'));
const BgpInstance = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'bgpInstance.js'));
const BgpConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'bgpConst.js'));
const { getAfiAndSafi } = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'bgpUtils.js'));
const { collectBgpGeneratedRoutes } = require(path.join(
    __dirname,
    '..',
    '..',
    'electron',
    'utils',
    'bgpRouteGenerator.js'
));

function makeWorkerWithInstance(addressFamily) {
    const worker = new BgpWorker();
    const responses = [];
    const errors = [];

    worker.messageHandler.sendSuccessResponse = (messageId, data, msg) => {
        responses.push({ messageId, data, msg });
    };
    worker.messageHandler.sendErrorResponse = (messageId, msg, data) => {
        errors.push({ messageId, msg, data });
    };

    const { afi, safi } = getAfiAndSafi(addressFamily);
    const instance = new BgpInstance(0, afi, safi);
    worker.bgpInstanceMap.set(BgpInstance.makeKey(0, afi, safi), instance);

    return { worker, instance, responses, errors };
}

function routeInfoList(instance) {
    return Array.from(instance.routeMap.values()).map(route => route.getRouteInfo());
}

function assertGenerate(config, expectedRoutes) {
    const { worker, instance, responses, errors } = makeWorkerWithInstance(config.addressFamily);

    worker.generateQpRoutes('generate', config);

    assert.deepStrictEqual(errors, [], 'QP route generation should not report errors');
    assert.strictEqual(responses.length, 1, 'QP route generation should send one success response');
    assert.deepStrictEqual(
        routeInfoList(instance).map(route => ({
            dqpn: route.dqpn,
            ip: route.ip,
            mask: route.mask,
            nextHop: route.nextHop
        })),
        expectedRoutes
    );

    return { worker, instance, responses, errors };
}

function assertCollect(config, expectedRoutes) {
    assert.deepStrictEqual(
        collectBgpGeneratedRoutes(config).map(route => ({
            dqpn: route.dqpn,
            ip: route.ip,
            mask: route.mask,
            nextHop: route.nextHop
        })),
        expectedRoutes,
        'QP stored-route generator should match worker route generation'
    );
}

function assertRouteDetail(worker, responses, errors, addressFamily, route, expectedDetail) {
    worker.getRouteDetail('detail', { addressFamily, route });

    assert.deepStrictEqual(errors, [], 'QP route detail should not report errors');
    assert.strictEqual(responses.length, 2, 'QP route detail should send one extra success response');
    assert.deepStrictEqual(
        {
            dqpn: responses[1].data.dqpn,
            ip: responses[1].data.ip,
            mask: responses[1].data.mask,
            nextHop: responses[1].data.nextHop
        },
        expectedDetail
    );
}

{
    const config = {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_QP,
        prefix: '10.0.0.1',
        mask: 32,
        count: 3,
        ipStep: 2,
        routeGrowthMode: BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP,
        startDqpn: 7,
        dqpnStep: 9,
        bsidMode: BgpConst.BGP_QP_BSID_MODE.FIXED,
        bsid: '2001:db8::7',
        bsidStep: 1,
        customAttr: ''
    };

    const expectedRoutes = [
        { dqpn: 7, ip: '10.0.0.1', mask: 32, nextHop: '2001:db8::7' },
        { dqpn: 7, ip: '10.0.0.3', mask: 32, nextHop: '2001:db8::7' },
        { dqpn: 7, ip: '10.0.0.5', mask: 32, nextHop: '2001:db8::7' }
    ];

    assertGenerate(config, expectedRoutes);
    assertCollect(config, expectedRoutes);
}

{
    const config = {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_QP,
        prefix: '10.0.0.99',
        mask: 32,
        count: 3,
        ipStep: 9,
        routeGrowthMode: BgpConst.BGP_QP_ROUTE_GROWTH_MODE.DQPN,
        startDqpn: 10,
        dqpnStep: 2,
        bsidMode: BgpConst.BGP_QP_BSID_MODE.FIXED,
        bsid: '2001:db8::9',
        bsidStep: 1,
        customAttr: ''
    };

    assertGenerate(config, [
        { dqpn: 10, ip: '10.0.0.99', mask: 32, nextHop: '2001:db8::9' },
        { dqpn: 12, ip: '10.0.0.99', mask: 32, nextHop: '2001:db8::9' },
        { dqpn: 14, ip: '10.0.0.99', mask: 32, nextHop: '2001:db8::9' }
    ]);
}

{
    const config = {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_QP,
        prefix: '10.0.0.1',
        mask: 32,
        count: 3,
        ipStep: 2,
        routeGrowthMode: BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN,
        startDqpn: 100,
        dqpnStep: 1,
        bsidMode: BgpConst.BGP_QP_BSID_MODE.CONTINUOUS,
        bsid: '2001:db8::1',
        bsidStep: 1,
        customAttr: ''
    };

    const expectedRoutes = [
        { dqpn: 100, ip: '10.0.0.1', mask: 32, nextHop: '2001:db8::1' },
        { dqpn: 101, ip: '10.0.0.3', mask: 32, nextHop: '2001:db8::2' },
        { dqpn: 102, ip: '10.0.0.5', mask: 32, nextHop: '2001:db8::3' }
    ];

    const { worker, instance, responses, errors } = assertGenerate(config, expectedRoutes);
    assertCollect(config, expectedRoutes);
    assertRouteDetail(worker, responses, errors, config.addressFamily, expectedRoutes[1], expectedRoutes[1]);

    const deleteConfig = {
        ...config,
        bsid: ''
    };
    worker.deleteQpRoute('delete', deleteConfig);

    assert.deepStrictEqual(errors, [], 'QP route deletion should not require BSID');
    assert.strictEqual(instance.routeMap.size, 0, 'delete should remove routes generated from the same QP iterator');
}

{
    const config = {
        addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV6_QP,
        prefix: '2001:db8::1',
        mask: 128,
        count: 2,
        ipStep: 2,
        routeGrowthMode: BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP,
        startDqpn: 77,
        dqpnStep: 1,
        bsidMode: BgpConst.BGP_QP_BSID_MODE.FIXED,
        bsid: '2001:db8::77',
        bsidStep: 1,
        customAttr: ''
    };

    const expectedRoutes = [
        { dqpn: 77, ip: '2001:db8::1', mask: 128, nextHop: '2001:db8::77' },
        { dqpn: 77, ip: '2001:db8::3', mask: 128, nextHop: '2001:db8::77' }
    ];

    assertGenerate(config, expectedRoutes);
    assertCollect(config, expectedRoutes);
}

console.log('BGP QP generation mode tests passed');
