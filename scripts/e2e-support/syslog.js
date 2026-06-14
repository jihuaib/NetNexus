const { successResponse } = require('./common');

const syslogPageApiScript =
    "    window.syslogApi = {\n        saveSyslogConfig: config => call('syslog.saveSyslogConfig', config),\n        getSyslogConfig: () => call('syslog.getSyslogConfig'),\n        startSyslog: config => call('syslog.startSyslog', config),\n        stopSyslog: () => call('syslog.stopSyslog'),\n        getMessageList: query => call('syslog.getMessageList', query),\n        getMessageDetail: id => call('syslog.getMessageDetail', id),\n        clearMessageHistory: () => call('syslog.clearMessageHistory')\n    };";

function createSyslogPageState(now) {
    return {
        config: null,
        messages: [
            {
                id: 1,
                timestamp: now,
                clientAddress: '127.0.0.1',
                clientPort: 5514,
                transport: 'UDP',
                ipVersion: 4,
                byteLength: 72,
                status: 'received',
                format: 'RFC5424',
                priority: 14,
                facilityName: 'user',
                facilityCode: 1,
                severityName: 'info',
                severityCode: 6,
                syslogTimestamp: now,
                hostname: 'netnexus-host',
                appName: 'netnexus-e2e',
                procId: '1234',
                msgId: 'E2E',
                tag: 'netnexus-e2e',
                structuredData: '-',
                message: 'netnexus test syslog message',
                rawMessage: '<14>1 netnexus test syslog message',
                summary: 'netnexus test syslog message',
                note: 'parsed'
            }
        ],
        running: false
    };
}

function handlePageCall(controller, method, args) {
    const syslog = controller.state.syslog;
    if (method === 'syslog.getSyslogConfig') return successResponse(syslog.config);
    if (method === 'syslog.saveSyslogConfig') {
        syslog.config = args[0];
        return successResponse(null);
    }
    if (method === 'syslog.startSyslog') {
        syslog.running = true;
        return successResponse(null, 'Syslog服务启动成功');
    }
    if (method === 'syslog.stopSyslog') {
        syslog.running = false;
        return successResponse(null, 'Syslog服务已停止');
    }
    if (method === 'syslog.getMessageList') {
        const query = args[0] || {};
        return successResponse({
            list: syslog.messages,
            page: query.page || 1,
            pageSize: query.pageSize || 20,
            total: syslog.messages.length
        });
    }
    if (method === 'syslog.getMessageDetail')
        return successResponse(syslog.messages.find(item => item.id === args[0]) || syslog.messages[0]);
    if (method === 'syslog.clearMessageHistory') return successResponse(null);
    return successResponse(null);
}

module.exports = {
    createSyslogPageState,
    handlePageCall,
    syslogPageApiScript
};
