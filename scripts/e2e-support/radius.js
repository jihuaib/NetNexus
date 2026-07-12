const { successResponse } = require('./common');

const radiusPageApiScript =
    "    window.radiusApi = {\n        saveRadiusConfig: config => call('radius.saveRadiusConfig', config),\n        getRadiusConfig: () => call('radius.getRadiusConfig'),\n        startRadius: config => call('radius.startRadius', config),\n        stopRadius: () => call('radius.stopRadius'),\n        getRequestList: () => call('radius.getRequestList'),\n        clearRequestHistory: () => call('radius.clearRequestHistory'),\n        getSessionList: () => call('radius.getSessionList')\n    };";

function createRadiusPageState(now, protocolRoot) {
    return {
        config: {
            authPort: 1812,
            accountingPort: 1813,
            coaPort: 3799,
            enableAuth: true,
            enableAccounting: true,
            enableDynamicAuth: true,
            sharedSecret: 'testing123',
            requireMessageAuthenticator: false,
            rejectUnknownClients: false,
            configFilePath: protocolRoot + '/radius.json',
            maxHistory: 500,
            duplicateCacheTtlMs: 30000
        },
        requests: [
            {
                id: 1,
                timestamp: now,
                service: 'auth',
                clientAddress: '127.0.0.1',
                clientPort: 49152,
                code: 1,
                codeName: 'Access-Request',
                responseCode: 2,
                responseCodeName: 'Access-Accept',
                identifier: 7,
                userName: 'demo',
                authMethod: 'PAP',
                status: 'accepted',
                message: 'PAP认证通过',
                packetLength: 64,
                attributes: [{ type: 1, name: 'User-Name', value: 'demo' }]
            }
        ],
        sessions: [
            {
                key: 'netnexus-e2e-session',
                userName: 'demo',
                acctSessionId: 'netnexus-e2e-session',
                acctMultiSessionId: '',
                nasAddress: '192.0.2.1',
                nasIpAddress: '192.0.2.1',
                nasIpv6Address: '',
                nasIdentifier: 'netnexus-e2e-nas',
                nasPort: 101,
                nasPortId: 'GigabitEthernet0/0/1',
                framedIpAddress: '192.0.2.100',
                framedIpv6Prefix: '',
                callingStationId: '00-11-22-33-44-55',
                calledStationId: 'netnexus-e2e',
                lastStatusType: 1,
                lastStatusText: 'Start',
                startedAt: now,
                lastUpdateAt: now,
                filterIds: ['netnexus-e2e'],
                sessionTimeout: 3600,
                idleTimeout: 600,
                attributes: [{ type: 44, name: 'Acct-Session-Id', value: 'netnexus-e2e-session' }]
            }
        ],
        running: false
    };
}

function statusData(radius, status) {
    return {
        status,
        authPort: radius.config.authPort,
        authPort6: null,
        accountingPort: radius.config.accountingPort,
        accountingPort6: null,
        coaPort: radius.config.coaPort,
        coaPort6: null,
        enableAuth: radius.config.enableAuth,
        enableAccounting: radius.config.enableAccounting,
        enableDynamicAuth: radius.config.enableDynamicAuth,
        enableIpv6: false,
        requestCount: radius.requests.length,
        sessionCount: radius.sessions.length
    };
}

function emitRadiusEvent(controller, type, data, stats) {
    controller.emitEvent('radius:event', successResponse({ type, data, ...(stats ? { stats } : {}) }));
}

function handlePageCall(controller, method, args) {
    const radius = controller.state.radius;
    if (method === 'radius.getRadiusConfig') return successResponse(radius.config, '配置获取成功');
    if (method === 'radius.saveRadiusConfig') {
        radius.config = { ...radius.config, ...args[0] };
        return successResponse(null, '配置保存成功');
    }
    if (method === 'radius.startRadius') {
        radius.config = { ...radius.config, ...args[0] };
        radius.running = true;
        const data = statusData(radius, 'running');
        emitRadiusEvent(controller, 2, data);
        return successResponse(data, 'RADIUS服务器启动成功');
    }
    if (method === 'radius.stopRadius') {
        radius.running = false;
        radius.requests = [];
        radius.sessions = [];
        emitRadiusEvent(controller, 2, statusData(radius, 'stopped'));
        emitRadiusEvent(controller, 4, { sessions: [], sessionCount: 0 });
        return successResponse(null, 'RADIUS服务器已停止');
    }
    if (method === 'radius.getRequestList') return successResponse(radius.requests, '获取RADIUS请求日志成功');
    if (method === 'radius.clearRequestHistory') {
        radius.requests = [];
        emitRadiusEvent(controller, 3, null, {
            requestCount: 0,
            sessionCount: radius.sessions.length,
            lastRequestAt: '-',
            lastClient: '-'
        });
        return successResponse(null, 'RADIUS请求日志已清空');
    }
    if (method === 'radius.getSessionList') return successResponse(radius.sessions, '获取RADIUS会话列表成功');
    return successResponse(null);
}

module.exports = {
    createRadiusPageState,
    handlePageCall,
    radiusPageApiScript
};
