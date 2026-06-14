const { successResponse } = require('./common');

const rpkiPageApiScript =
    "    window.rpkiApi = {\n        saveRpkiConfig: config => call('rpki.saveRpkiConfig', config),\n        loadRpkiConfig: () => call('rpki.loadRpkiConfig'),\n        startRpki: config => call('rpki.startRpki', config),\n        stopRpki: () => call('rpki.stopRpki'),\n        addRoa: roa => call('rpki.addRoa', roa),\n        deleteRoa: roa => call('rpki.deleteRoa', roa),\n        deleteAllRoa: () => call('rpki.deleteAllRoa'),\n        getRoaList: query => call('rpki.getRoaList', query),\n        selectRoaJsonFile: () => call('rpki.selectRoaJsonFile'),\n        importRoaJson: options => call('rpki.importRoaJson', options),\n        getClientList: () => call('rpki.getClientList'),\n        addRouterKey: routerKey => call('rpki.addRouterKey', routerKey),\n        deleteRouterKey: routerKey => call('rpki.deleteRouterKey', routerKey),\n        getRouterKeyList: () => call('rpki.getRouterKeyList'),\n        addAspa: aspa => call('rpki.addAspa', aspa),\n        deleteAspa: aspa => call('rpki.deleteAspa', aspa),\n        deleteAllAspa: () => call('rpki.deleteAllAspa'),\n        selectAspaJsonFile: () => call('rpki.selectAspaJsonFile'),\n        importAspaJson: options => call('rpki.importAspaJson', options),\n        getAspaList: query => call('rpki.getAspaList', query)\n    };";

function createRpkiPageState() {
    return {
        config: { port: '1280', maxProtocolVersion: 2 },
        clients: [
            {
                localIp: '127.0.0.1',
                localPort: 1280,
                remoteIp: '192.0.2.10',
                remotePort: 30000,
                version: 2,
                status: '已连接'
            }
        ],
        roas: [{ ipType: 1, asn: '65000', ip: '203.0.113.0', mask: '24', maxLength: '24' }],
        routerKeys: [
            {
                ski: '0123456789ABCDEF0123456789ABCDEF01234567',
                asn: '65000',
                spki: '3059301306072A8648CE3D020106082A8648CE3D03010703420004'
            }
        ],
        aspas: [{ customerAsn: '65010', providerAsns: [65011, 65012], afiFlags: 3, format: 'latest' }]
    };
}

function handlePageCall(controller, method, args) {
    const rpki = controller.state.rpki;
    if (method === 'rpki.loadRpkiConfig') return successResponse(rpki.config);
    if (method === 'rpki.saveRpkiConfig') {
        rpki.config = args[0];
        return successResponse(null);
    }
    if (method === 'rpki.startRpki') return successResponse(null, 'RPKI启动成功');
    if (method === 'rpki.stopRpki') return successResponse(null, 'RPKI停止成功');
    if (method === 'rpki.getClientList') return successResponse(rpki.clients);
    if (method === 'rpki.getRoaList') {
        return successResponse({
            items: rpki.roas,
            page: 1,
            pageSize: 20,
            total: rpki.roas.length,
            storageTotal: rpki.roas.length
        });
    }
    if (method === 'rpki.addRoa') {
        rpki.roas.push(args[0]);
        return successResponse(null);
    }
    if (method === 'rpki.deleteRoa') return successResponse(null);
    if (method === 'rpki.deleteAllRoa') {
        const deleted = rpki.roas.length;
        rpki.roas = [];
        return successResponse({ deleted });
    }
    if (method === 'rpki.getRouterKeyList') return successResponse(rpki.routerKeys);
    if (method === 'rpki.addRouterKey') {
        rpki.routerKeys.push(args[0]);
        return successResponse(null);
    }
    if (method === 'rpki.deleteRouterKey') return successResponse(null);
    if (method === 'rpki.getAspaList') {
        return successResponse({
            items: rpki.aspas,
            page: 1,
            pageSize: 20,
            total: rpki.aspas.length,
            storageTotal: rpki.aspas.length
        });
    }
    if (method === 'rpki.addAspa') {
        rpki.aspas.push(args[0]);
        return successResponse(null);
    }
    if (method === 'rpki.deleteAspa') return successResponse(null);
    if (method === 'rpki.deleteAllAspa') return successResponse({ deleted: rpki.aspas.length });
    return successResponse(null);
}

module.exports = {
    createRpkiPageState,
    handlePageCall,
    rpkiPageApiScript
};
