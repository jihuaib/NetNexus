const { successResponse } = require('./common');

const ntpPageApiScript =
    "    window.ntpApi = {\n        saveNtpConfig: config => call('ntp.saveNtpConfig', config),\n        getNtpConfig: () => call('ntp.getNtpConfig'),\n        startNtp: config => call('ntp.startNtp', config),\n        stopNtp: () => call('ntp.stopNtp'),\n        getRequestList: () => call('ntp.getRequestList'),\n        clearRequestHistory: () => call('ntp.clearRequestHistory')\n    };";

function createNtpPageState(now) {
    return {
        config: null,
        requests: [
            {
                id: 1,
                timestamp: now,
                clientAddress: '127.0.0.1',
                clientPort: 41234,
                ipVersion: 4,
                version: 4,
                modeName: 'client',
                clientTransmitTime: now,
                receiveTime: now,
                transmitTime: now,
                status: 'replied',
                message: 'mock NTP response sent'
            }
        ],
        running: false
    };
}

function handlePageCall(controller, method, args) {
    const ntp = controller.state.ntp;
    if (method === 'ntp.getNtpConfig') return successResponse(ntp.config);
    if (method === 'ntp.saveNtpConfig') {
        ntp.config = args[0];
        return successResponse(null);
    }
    if (method === 'ntp.startNtp') {
        ntp.running = true;
        return successResponse(null, 'NTP服务启动成功');
    }
    if (method === 'ntp.stopNtp') {
        ntp.running = false;
        return successResponse(null, 'NTP服务已停止');
    }
    if (method === 'ntp.getRequestList') return successResponse(ntp.requests);
    if (method === 'ntp.clearRequestHistory') return successResponse(null);
    return successResponse(null);
}

module.exports = {
    createNtpPageState,
    handlePageCall,
    ntpPageApiScript
};
