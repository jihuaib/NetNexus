const { successResponse } = require('./common');

const snmpPageApiScript = `
    window.snmpApi = {
        saveSnmpConfig: config => call('snmp.saveSnmpConfig', config),
        getSnmpConfig: () => call('snmp.getSnmpConfig'),
        startSnmp: config => call('snmp.startSnmp', config),
        stopSnmp: () => call('snmp.stopSnmp'),
        getTrapList: query => call('snmp.getTrapList', query),
        clearTrapHistory: () => call('snmp.clearTrapHistory'),
        selectMibFiles: () => call('snmp.selectMibFiles'),
        selectMibDirectory: () => call('snmp.selectMibDirectory'),
        compileMibs: async (filePaths, options = {}) => {
            const payload = { filePaths: [...filePaths], force: Boolean(options.force) };
            const cloneProbe = new MessageChannel();
            try {
                cloneProbe.port1.postMessage(payload);
            } finally {
                cloneProbe.port1.close();
                cloneProbe.port2.close();
            }

            const progressId = 'e2e-mib-' + Date.now();
            const emitProgress = progress =>
                window.__featureE2eEmit('snmp:mibCompileProgress', {
                    status: 'success',
                    msg: 'MIB编译进度',
                    data: { progressId, ...progress }
                });
            emitProgress({
                phase: 'preparing',
                completed: 0,
                total: 3,
                percent: 0,
                counts: { compiled: 0, skipped: 0, failed: 0 },
                message: '正在准备 MIB 编译'
            });
            await new Promise(resolve => setTimeout(resolve, 120));
            for (let index = 1; index <= 3; index += 1) {
                emitProgress({
                    phase: 'compiling',
                    completed: index,
                    total: 3,
                    percent: Math.round((index / 3) * 100),
                    counts: { compiled: index, skipped: 0, failed: 0 },
                    fileName: 'NETNEXUS-DEMO-' + index + '-MIB.mib',
                    filePath: 'scripts/manual/snmp/mibs/NETNEXUS-DEMO-' + index + '-MIB.mib',
                    fileStatus: 'compiled'
                });
                await new Promise(resolve => setTimeout(resolve, 120));
            }

            const result = await call('snmp.compileMibs', payload.filePaths);
            emitProgress({
                phase: 'completed',
                completed: 3,
                total: 3,
                percent: 100,
                counts: { compiled: 3, skipped: 0, failed: 0 },
                fileName: '',
                filePath: '',
                message: 'MIB 编译完成'
            });
            return result;
        },
        getMibStatus: () => call('snmp.getMibStatus'),
        getMibTreeChildren: oid => call('snmp.getMibTreeChildren', oid),
        saveMibProject: payload => call('snmp.saveMibProject', payload),
        listMibProjects: () => call('snmp.listMibProjects'),
        importMibProject: payload => call('snmp.importMibProject', payload),
        clearMibs: () => call('snmp.clearMibs'),
        translateOid: oid => call('snmp.translateOid', oid),
        sendGetRequest: request => call('snmp.sendGetRequest', request),
        sendGetNextRequest: request => call('snmp.sendGetNextRequest', request),
        sendWalkRequest: request => call('snmp.sendWalkRequest', request),
        sendSetRequest: request => call('snmp.sendSetRequest', request),
        listOidInstances: request => call('snmp.listOidInstances', request)
    };`;

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
            loadedFiles: [
                {
                    fileName: 'NETNEXUS-DEMO-MIB.mib',
                    filePath: 'scripts/manual/snmp/mibs/NETNEXUS-DEMO-MIB.mib',
                    status: 'compiled'
                }
            ],
            failedFiles: [],
            requestedFiles: ['scripts/manual/snmp/mibs/NETNEXUS-DEMO-MIB.mib']
        }
    };
}

function handlePageCall(controller, method, args) {
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
        return successResponse({
            ...snmp.mibStatus.oidTree[0],
            oid: typeof args?.[0] === 'string' ? args[0] : snmp.mibStatus.oidTree[0].oid,
            matched: true,
            matchedOid: '1.3.6.1.2.1.1.1'
        });
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
