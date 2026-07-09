const { successResponse } = require('./common');

const nativePageApiScript =
    "    window.nativeApi = {\n        getNetworkInfo: () => call('native.getNetworkInfo'),\n        manageNetwork: config => call('native.manageNetwork', config),\n        getRoutes: () => call('native.getRoutes'),\n        manageRoute: config => call('native.manageRoute', config),\n        getListeningPorts: () => call('native.getListeningPorts'),\n        killProcess: pid => call('native.killProcess', pid)\n    };";

function handlePageCall(_controller, method) {
    if (method === 'native.getListeningPorts') {
        return successResponse([
            {
                protocol: 'TCP',
                address: '127.0.0.1',
                port: 3000,
                remoteAddress: '-',
                remotePort: '-',
                state: 'LISTENING',
                pid: 4242,
                process: 'node'
            }
        ]);
    }
    if (method === 'native.getNetworkInfo') {
        return successResponse([
            {
                name: 'e2e0',
                displayName: 'NetNexus E2E Interface',
                isUp: true,
                mac: '02:00:00:00:00:01',
                addresses: [
                    { family: 'IPv4', address: '10.0.0.10', netmask: '255.255.255.0' },
                    { family: 'IPv6', address: '2001:db8::10', prefixLength: 64 }
                ]
            }
        ]);
    }
    if (method === 'native.getRoutes') {
        return successResponse([
            {
                id: 'e2e-route-v4-default',
                family: 'IPv4',
                destinationPrefix: '0.0.0.0/0',
                rawDestination: '0.0.0.0/0',
                gateway: '10.0.0.1',
                interfaceName: 'e2e0',
                interfaceIndex: 1,
                metric: 10,
                protocol: 'E2E',
                state: 'Active',
                flags: ''
            },
            {
                id: 'e2e-route-v6-prefix',
                family: 'IPv6',
                destinationPrefix: '2001:db8::/64',
                rawDestination: '2001:db8::/64',
                gateway: 'fe80::1',
                interfaceName: 'e2e0',
                interfaceIndex: 1,
                metric: 20,
                protocol: 'E2E',
                state: 'Active',
                flags: ''
            }
        ]);
    }
    if (method === 'native.manageRoute') {
        return successResponse(null);
    }
    return successResponse(null);
}

module.exports = {
    handlePageCall,
    nativePageApiScript
};
