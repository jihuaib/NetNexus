const { successResponse } = require('./common');

const snmpPageApiScript =
    "    window.snmpApi = {\n        saveSnmpConfig: config => call('snmp.saveSnmpConfig', config),\n        getSnmpConfig: () => call('snmp.getSnmpConfig'),\n        startSnmp: config => call('snmp.startSnmp', config),\n        stopSnmp: () => call('snmp.stopSnmp'),\n        getTrapList: query => call('snmp.getTrapList', query),\n        clearTrapHistory: () => call('snmp.clearTrapHistory'),\n        selectMibFiles: () => call('snmp.selectMibFiles'),\n        selectMibDirectory: () => call('snmp.selectMibDirectory'),\n        compileMibs: filePaths => call('snmp.compileMibs', filePaths),\n        getMibStatus: () => call('snmp.getMibStatus'),\n        getMibTreeChildren: oid => call('snmp.getMibTreeChildren', oid),\n        saveMibProject: payload => call('snmp.saveMibProject', payload),\n        listMibProjects: () => call('snmp.listMibProjects'),\n        importMibProject: payload => call('snmp.importMibProject', payload),\n        clearMibs: () => call('snmp.clearMibs'),\n        translateOid: oid => call('snmp.translateOid', oid),\n        sendGetRequest: request => call('snmp.sendGetRequest', request),\n        sendGetNextRequest: request => call('snmp.sendGetNextRequest', request),\n        sendWalkRequest: request => call('snmp.sendWalkRequest', request),\n        sendSetRequest: request => call('snmp.sendSetRequest', request),\n        listOidInstances: request => call('snmp.listOidInstances', request)\n    };";

function createSnmpPageState() {
    return {
        config: null,
        traps: [
            {
                id: 1,
                timestamp: new Date().toISOString(),
                sourceIp: '192.0.2.80',
                sourcePort: 4162,
                version: 'v2c',
                community: 'public',
                enterpriseOid: '1.3.6.1.4.1.8072',
                trapOid: '1.3.6.1.6.3.1.1.5.3',
                trapName: 'linkDown',
                status: 'processed',
                varbinds: [{ oid: '1.3.6.1.2.1.1.3.0', oidName: 'sysUpTime.0', type: 'TimeTicks', value: '12345' }]
            }
        ],
        mibStatus: {
            cacheHit: true,
            modules: ['NETNEXUS-DEMO-MIB'],
            baseModules: ['SNMPv2-SMI'],
            totalObjects: 1,
            expandedFileCount: 1,
            oidTree: [
                {
                    title: 'sysDescr',
                    key: '1.3.6.1.2.1.1.1',
                    oid: '1.3.6.1.2.1.1.1',
                    objectName: 'sysDescr',
                    moduleQualifiedName: 'SNMPv2-MIB::sysDescr',
                    moduleName: 'SNMPv2-MIB',
                    macro: 'OBJECT-TYPE',
                    syntax: 'DisplayString',
                    maxAccess: 'read-only',
                    canGet: true,
                    canSet: false,
                    notifyOnly: false,
                    nodeRole: 'scalar'
                }
            ],
            files: [
                {
                    fileName: 'NETNEXUS-DEMO-MIB.mib',
                    filePath: 'scripts/manual/snmp/mibs/NETNEXUS-DEMO-MIB.mib',
                    status: 'compiled'
                }
            ]
        }
    };
}

function handlePageCall(controller, method) {
    const snmp = controller.state.snmp;
    if (method === 'snmp.getSnmpConfig') return successResponse(snmp.config);
    if (method === 'snmp.getTrapList') {
        return successResponse({
            list: snmp.traps,
            page: 1,
            pageSize: 20,
            total: snmp.traps.length,
            totalTraps: snmp.traps.length,
            todayTraps: snmp.traps.length,
            recentTraps: snmp.traps.length,
            onlineAgents: 1
        });
    }
    if (method === 'snmp.clearTrapHistory') return successResponse(null);
    if (method === 'snmp.getMibStatus') return successResponse(snmp.mibStatus);
    if (method === 'snmp.getMibTreeChildren') return successResponse([]);
    if (method === 'snmp.translateOid')
        return successResponse({ ...snmp.mibStatus.oidTree[0], matched: true, matchedOid: '1.3.6.1.2.1.1.1' });
    if (method === 'snmp.listMibProjects') return successResponse({ rootDir: controller.protocolRoot, projects: [] });
    if (method === 'snmp.selectMibFiles')
        return successResponse({ filePaths: ['scripts/manual/snmp/mibs/NETNEXUS-DEMO-MIB.mib'] });
    if (method === 'snmp.selectMibDirectory') return successResponse({ filePaths: ['scripts/manual/snmp/mibs'] });
    if (method === 'snmp.compileMibs') return successResponse(snmp.mibStatus);
    if (method === 'snmp.sendGetRequest' || method === 'snmp.sendGetNextRequest')
        return successResponse({ value: 'NetNexus E2E' });
    if (method === 'snmp.sendWalkRequest')
        return successResponse([{ oid: '1.3.6.1.2.1.1.1.0', value: 'NetNexus E2E' }]);
    if (method === 'snmp.listOidInstances') return successResponse([{ oid: '1.3.6.1.2.1.1.1.0' }]);
    return successResponse(null);
}

module.exports = {
    createSnmpPageState,
    handlePageCall,
    snmpPageApiScript
};
