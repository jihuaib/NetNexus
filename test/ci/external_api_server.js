const assert = require('assert');
const http = require('http');
const net = require('net');

const ExternalApiServer = require('../../electron/app/externalApiServer');
const createBmpApiRoutes = require('../../electron/app/bmpApiRoutes');
const { successResponse } = require('../../electron/utils/responseUtils');

const mockClient = {
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '127.0.0.1',
    remotePort: 50000,
    sysName: 'ci-router',
    sysDesc: 'mock bmp client',
    bmpVersion: 4,
    bmpV4TlvDraft: 20,
    rawTlvs: [],
    terminationTlvs: [],
    receivedAt: '2026-06-12T00:00:00.000Z'
};

const mockSession = {
    sessionType: 0,
    sessionFlags: 64,
    rawSessionFlags: 64,
    sessionRd: '0:0',
    sessionIp: '192.0.2.1',
    sessionAs: 65001,
    sessionRouterId: '192.0.2.254',
    sessionTimestamp: 0,
    sessionTimestampMs: 0,
    localIp: '192.0.2.254',
    localPort: 179,
    remotePort: 50000,
    sessionState: 0,
    enabledAddrFamilyTypes: [3],
    ribTypes: [2],
    routeSummary: { active: 1, stale: 1, total: 2 }
};

const mockInstance = {
    addrFamilyType: 3,
    instanceType: 3,
    instanceFlags: 0,
    rawInstanceFlags: 0,
    instanceRd: '0:0',
    instanceIp: '0.0.0.0',
    instanceAs: 65001,
    instanceRouterId: '192.0.2.254',
    instanceState: 0,
    vrfTableNames: ['global'],
    ribEpoch: 1,
    routeSummary: { active: 1, stale: 0, total: 1 }
};

const mockEvpnPrefix = 'evpn:mac-ip:0:0:tag=100:mac=00:11:22:33:44:55:ip=192.0.2.10';

const mockRoute = {
    routeKey: `0|0:0|${mockEvpnPrefix}|33`,
    addrFamilyType: 3,
    afi: 25,
    safi: 70,
    ip: mockEvpnPrefix,
    mask: 33,
    rd: '0:0',
    origin: 'IGP',
    asPath: '65001 65002',
    med: 0,
    nextHop: '192.0.2.254',
    pathId: 0,
    labels: null,
    parserValid: true,
    parseErrors: null,
    parseWarnings: null,
    pathStatus: null,
    pathStatusNames: [],
    pathStatusText: null,
    pathStatusUnknownBits: 0,
    pathStatusReason: null,
    pathStatusReasonName: null,
    pathStatusReasonText: null,
    routeState: 'active'
};

const mockRouteDetail = {
    ...mockRoute,
    localPref: 100,
    communities: '65001:100',
    otc: null,
    routeType: 2,
    rawNlri: '0221',
    nlriDetail: {
        prefix: mockEvpnPrefix,
        rd: '0:0',
        routeType: 2,
        routeTypeName: 'MAC/IP Advertisement',
        ethernetTagId: 100,
        macAddress: '00:11:22:33:44:55',
        ipAddress: '192.0.2.10',
        length: 33
    },
    pathStatusReasons: [],
    pathStatusTlvs: [],
    ribEpoch: 1,
    staleEpoch: null,
    lastSeenAt: '2026-06-12T00:00:00.000Z',
    staleAt: null,
    staleReason: null
};

const mockStatisticsReport = {
    client: mockClient,
    session: mockSession,
    statistics: [
        {
            type: 0,
            value: 1,
            valueHex: '00000001',
            afi: null,
            safi: null,
            typeName: '拒绝的前缀数'
        }
    ],
    tlvs: [],
    updatedAt: '2026-06-12T00:00:00.000Z'
};

const mockInstanceStatisticsReport = {
    client: mockClient,
    instance: {
        instanceType: mockInstance.instanceType,
        instanceFlags: mockInstance.instanceFlags,
        instanceRd: mockInstance.instanceRd,
        instanceIp: mockInstance.instanceIp,
        instanceAs: mockInstance.instanceAs,
        instanceRouterId: mockInstance.instanceRouterId,
        instanceTimestamp: 0,
        instanceTimestampMs: 0,
        vrfTableNames: ['global']
    },
    statistics: mockStatisticsReport.statistics,
    tlvs: [],
    updatedAt: '2026-06-12T00:00:00.000Z'
};

function makeMockBmpApp() {
    return {
        running: true,
        getBmpRunning() {
            return this.running;
        },
        async queryClientList() {
            return successResponse([mockClient], 'mock clients');
        },
        async queryBgpSessions(client) {
            assert.strictEqual(client.localIp, mockClient.localIp);
            return successResponse([mockSession], 'mock sessions');
        },
        async queryBgpInstances(client) {
            assert.strictEqual(client.remotePort, mockClient.remotePort);
            return successResponse([mockInstance], 'mock instances');
        },
        async queryBgpRoutes(payload) {
            assert.strictEqual(payload.af, 3);
            assert.strictEqual(payload.ribType, 2);
            assert.strictEqual(payload.page, 1);
            assert.strictEqual(payload.pageSize, 2);
            assert.strictEqual(payload.routeState, 'all');
            assert.strictEqual(payload.prefixFilter, 'evpn:mac-ip');
            return successResponse(
                {
                    list: [mockRoute],
                    total: 1,
                    summary: { active: 1, stale: 0, total: 1 }
                },
                'mock routes'
            );
        },
        async queryBgpRouteDetail(payload) {
            assert.strictEqual(payload.routeKey, mockRoute.routeKey);
            return successResponse(mockRouteDetail, 'mock route detail');
        },
        async queryBgpInstanceRoutes(payload) {
            assert.strictEqual(payload.instance.addrFamilyType, 3);
            assert.strictEqual(payload.pageSize, 2);
            return successResponse(
                {
                    list: [mockRoute],
                    total: 1,
                    summary: { active: 1, stale: 0, total: 1 }
                },
                'mock instance routes'
            );
        },
        async queryBgpInstanceRouteDetail(payload) {
            assert.strictEqual(payload.routeKey, mockRoute.routeKey);
            return successResponse(mockRouteDetail, 'mock instance route detail');
        },
        async queryBgpStatisticsReports(client) {
            assert.strictEqual(client.localPort, mockClient.localPort);
            return successResponse([mockStatisticsReport], 'mock session statistics');
        },
        async queryBgpInstanceStatisticsReports(client) {
            assert.strictEqual(client.remoteIp, mockClient.remoteIp);
            return successResponse([mockInstanceStatisticsReport], 'mock instance statistics');
        }
    };
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(error => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(port);
            });
        });
    });
}

function requestJson(port, method, path, options = {}) {
    const { body, rawBody, headers = {} } = options;
    const requestBody = rawBody !== undefined ? rawBody : body === undefined ? '' : JSON.stringify(body);

    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                method,
                path,
                headers: {
                    ...(requestBody
                        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) }
                        : {}),
                    ...headers
                }
            },
            res => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => {
                    data += chunk;
                });
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: data ? JSON.parse(data) : null
                    });
                });
            }
        );

        req.on('error', reject);
        if (requestBody) {
            req.write(requestBody);
        }
        req.end();
    });
}

function assertSuccess(response, label) {
    assert.strictEqual(response.statusCode, 200, `${label} should return HTTP 200`);
    assert.strictEqual(response.body.status, 'success', `${label} should return success body`);
}

function assertError(response, statusCode, code, label) {
    assert.strictEqual(response.statusCode, statusCode, `${label} should return HTTP ${statusCode}`);
    assert.strictEqual(response.body.status, 'error', `${label} should return error body`);
    assert.strictEqual(response.body.code, code, `${label} should return ${code}`);
}

function printPayload(title, value) {
    console.log(`${title}: ${JSON.stringify(value === undefined ? null : value, null, 2)}`);
}

async function checkedRequest(port, method, path, options = {}) {
    const requestBody = options.rawBody !== undefined ? options.rawBody : options.body;
    console.log(`\n[External API CI] ${method} ${path}`);
    printPayload('request', requestBody);

    const response = await requestJson(port, method, path, options);
    console.log(`statusCode: ${response.statusCode}`);
    printPayload('response', response.body);
    return response;
}

async function main() {
    const bmpApp = makeMockBmpApp();
    const apiServer = new ExternalApiServer();
    const port = await getFreePort();

    apiServer.setRoutes([
        {
            method: 'GET',
            path: '/api/v1/status',
            handler: async () =>
                successResponse(
                    {
                        ...apiServer.getStatus(),
                        modules: ['bmp']
                    },
                    'mock api status'
                )
        },
        ...createBmpApiRoutes(bmpApp)
    ]);

    await apiServer.updateSettings({
        enabled: true,
        host: '0.0.0.0',
        port,
        maxPageSize: 50
    });

    try {
        const routePayload = {
            client: mockClient,
            session: mockSession,
            af: 3,
            ribType: 2,
            page: 1,
            pageSize: 2,
            routeState: 'all',
            prefixFilter: 'evpn:mac-ip'
        };
        const instanceRoutePayload = {
            client: mockClient,
            instance: mockInstance,
            page: 1,
            pageSize: 2,
            routeState: 'all',
            prefixFilter: 'evpn:mac-ip'
        };

        const endpointChecks = [
            [
                'GET',
                '/api/v1/status',
                undefined,
                response => {
                    assert.deepStrictEqual(response.body.data.modules, ['bmp']);
                    assert.strictEqual(response.body.data.host, '127.0.0.1');
                }
            ],
            ['GET', '/api/v1/bmp/status', undefined, response => assert.strictEqual(response.body.data.running, true)],
            [
                'GET',
                '/api/v1/bmp/clients',
                undefined,
                response => assert.strictEqual(response.body.data[0].sysName, 'ci-router')
            ],
            [
                'POST',
                '/api/v1/bmp/sessions',
                { client: mockClient },
                response => assert.strictEqual(response.body.data[0].sessionAs, 65001)
            ],
            [
                'POST',
                '/api/v1/bmp/instances',
                { client: mockClient },
                response => assert.strictEqual(response.body.data[0].addrFamilyType, 3)
            ],
            ['POST', '/api/v1/bmp/routes', routePayload, response => assert.strictEqual(response.body.data.total, 1)],
            [
                'POST',
                '/api/v1/bmp/routes/detail',
                { ...routePayload, routeKey: mockRoute.routeKey },
                response => {
                    assert.strictEqual(response.body.data.nlriDetail.routeTypeName, 'MAC/IP Advertisement');
                    assert.strictEqual(Object.prototype.hasOwnProperty.call(response.body.data, 'summary'), false);
                }
            ],
            [
                'POST',
                '/api/v1/bmp/instances/routes',
                instanceRoutePayload,
                response => assert.strictEqual(response.body.data.list[0].routeKey, mockRoute.routeKey)
            ],
            [
                'POST',
                '/api/v1/bmp/instances/routes/detail',
                { client: mockClient, instance: mockInstance, routeKey: mockRoute.routeKey },
                response => {
                    assert.strictEqual(response.body.data.localPref, 100);
                    assert.strictEqual(Object.prototype.hasOwnProperty.call(response.body.data, 'summary'), false);
                }
            ],
            [
                'POST',
                '/api/v1/bmp/statistics/session',
                { client: mockClient },
                response => assert.strictEqual(response.body.data[0].statistics[0].value, 1)
            ],
            [
                'POST',
                '/api/v1/bmp/statistics/instance',
                { client: mockClient },
                response => assert.strictEqual(response.body.data[0].instance.vrfTableNames[0], 'global')
            ]
        ];

        for (const [method, path, body, extraAssert] of endpointChecks) {
            const response = await checkedRequest(port, method, path, { body });
            assertSuccess(response, `${method} ${path}`);
            extraAssert(response);
        }

        assertError(
            await checkedRequest(port, 'GET', '/api/v1/no-such-route'),
            404,
            'ROUTE_NOT_FOUND',
            'unknown route'
        );
        assertError(await checkedRequest(port, 'GET', '/api/v1/bmp/routes'), 405, 'METHOD_NOT_ALLOWED', 'wrong method');
        assertError(
            await checkedRequest(port, 'POST', '/api/v1/bmp/sessions', { rawBody: '{"client":' }),
            400,
            'INVALID_JSON',
            'invalid JSON'
        );
        assertError(
            await checkedRequest(port, 'POST', '/api/v1/bmp/routes', { body: { ...routePayload, pageSize: 51 } }),
            400,
            'INVALID_PARAMETER',
            'pageSize over maxPageSize'
        );

        bmpApp.running = false;
        assertError(
            await checkedRequest(port, 'GET', '/api/v1/bmp/clients'),
            409,
            'BMP_NOT_RUNNING',
            'BMP not running'
        );
    } finally {
        await apiServer.stop();
    }

    console.log('External API server endpoint tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
