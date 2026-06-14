const { successResponse } = require('./common');

const dhcpPageApiScript =
    "    window.dhcpApi = {\n        saveDhcpConfig: config => call('dhcp.saveDhcpConfig', config),\n        getDhcpConfig: () => call('dhcp.getDhcpConfig'),\n        startDhcp: config => call('dhcp.startDhcp', config),\n        stopDhcp: () => call('dhcp.stopDhcp'),\n        getLeaseList: () => call('dhcp.getLeaseList'),\n        releaseLease: macAddr => call('dhcp.releaseLease', macAddr),\n        releaseDhcp6Lease: duid => call('dhcp.releaseDhcp6Lease', duid)\n    };";

function createDhcpPageState(now) {
    return {
        config: null,
        leases: [
            {
                version: 4,
                id: 'aa:bb:cc:dd:ee:ff',
                macAddr: 'aa:bb:cc:dd:ee:ff',
                ip: '192.168.1.101',
                hostname: 'netnexus-client',
                leaseTime: 3600,
                startTime: now,
                expiresAt: now,
                status: 'active'
            }
        ],
        running: false
    };
}

function handlePageCall(controller, method, args) {
    const dhcp = controller.state.dhcp;
    if (method === 'dhcp.getDhcpConfig') return successResponse(dhcp.config);
    if (method === 'dhcp.saveDhcpConfig') {
        dhcp.config = args[0];
        return successResponse(null);
    }
    if (method === 'dhcp.startDhcp') {
        dhcp.running = true;
        return successResponse(null, 'DHCP服务启动成功');
    }
    if (method === 'dhcp.stopDhcp') {
        dhcp.running = false;
        return successResponse(null, 'DHCP服务已停止');
    }
    if (method === 'dhcp.getLeaseList') return successResponse(dhcp.leases);
    if (method === 'dhcp.releaseLease' || method === 'dhcp.releaseDhcp6Lease') return successResponse(null);
    return successResponse(null);
}

module.exports = {
    createDhcpPageState,
    dhcpPageApiScript,
    handlePageCall
};
