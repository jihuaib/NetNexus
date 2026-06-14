const { successResponse } = require('./common');

const nativePageApiScript =
    "    window.nativeApi = {\n        getNetworkInfo: () => call('native.getNetworkInfo'),\n        manageNetwork: config => call('native.manageNetwork', config),\n        getListeningPorts: () => call('native.getListeningPorts'),\n        killProcess: pid => call('native.killProcess', pid)\n    };";

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
    return successResponse(null);
}

module.exports = {
    handlePageCall,
    nativePageApiScript
};
