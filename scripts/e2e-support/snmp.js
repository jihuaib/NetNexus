const { delay, errorResponse, successResponse } = require('./common');

const snmpPageApiScript = `
    window.snmpApi = {
        saveSnmpConfig: config => call('snmp.saveSnmpConfig', config),
        getSnmpConfig: () => call('snmp.getSnmpConfig'),
        getSnmpRuntimeState: () => call('snmp.getSnmpRuntimeState'),
        startSnmp: config => call('snmp.startSnmp', config),
        stopSnmp: () => call('snmp.stopSnmp'),
        startSnmpTrap: config => call('snmp.startSnmpTrap', config),
        stopSnmpTrap: () => call('snmp.stopSnmpTrap'),
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
        getMibSource: request => call('snmp.getMibSource', request),
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
    const systemOid = '1.3.6.1.2.1.1';
    const sysDescrOid = systemOid + '.1';
    const sysContactOid = systemOid + '.4';
    const ifTableOid = '1.3.6.1.2.1.2.2';
    const linkDownOid = '1.3.6.1.6.3.1.1.5.3';

    return {
        config: {
            targetHost: '192.0.2.10',
            queryPort: 161,
            port: 162,
            community: 'public',
            supportedVersions: ['v2c']
        },
        runtime: {
            running: false,
            ready: false,
            trapRunning: false
        },
        mibStatusDelayMs: 0,
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
            modules: ['NETNEXUS-DEMO-MIB', 'IF-MIB'],
            baseModules: ['SNMPv2-SMI', 'SNMPv2-MIB'],
            totalObjects: 5,
            expandedFileCount: 3,
            oidTree: [
                {
                    title: 'system',
                    key: systemOid,
                    oid: systemOid,
                    objectName: 'system',
                    moduleQualifiedName: 'SNMPv2-MIB::system',
                    moduleName: 'SNMPv2-MIB',
                    pathName: 'iso.org.dod.internet.mgmt.mib-2.system',
                    macro: 'OBJECT IDENTIFIER',
                    syntax: '',
                    maxAccess: 'not-accessible',
                    canGet: false,
                    canSet: false,
                    notifyOnly: false,
                    nodeRole: 'container',
                    isScalar: false,
                    isTableColumn: false,
                    queryOid: systemOid,
                    hasChildren: true,
                    isLeaf: false,
                    treePath: [systemOid],
                    children: [
                        {
                            title: 'sysDescr',
                            key: sysDescrOid,
                            oid: sysDescrOid,
                            objectName: 'sysDescr',
                            moduleQualifiedName: 'SNMPv2-MIB::sysDescr',
                            moduleName: 'SNMPv2-MIB',
                            pathName: 'iso.org.dod.internet.mgmt.mib-2.system.sysDescr',
                            macro: 'OBJECT-TYPE',
                            syntax: 'DisplayString',
                            maxAccess: 'read-only',
                            status: 'current',
                            canGet: true,
                            canSet: false,
                            notifyOnly: false,
                            nodeRole: 'read-only',
                            isScalar: true,
                            isTableColumn: false,
                            queryOid: sysDescrOid + '.0',
                            hasChildren: false,
                            isLeaf: true,
                            treePath: [systemOid, sysDescrOid]
                        },
                        {
                            title: 'sysContact',
                            key: sysContactOid,
                            oid: sysContactOid,
                            objectName: 'sysContact',
                            moduleQualifiedName: 'SNMPv2-MIB::sysContact',
                            moduleName: 'SNMPv2-MIB',
                            pathName: 'iso.org.dod.internet.mgmt.mib-2.system.sysContact',
                            macro: 'OBJECT-TYPE',
                            syntax: 'DisplayString',
                            maxAccess: 'read-write',
                            status: 'current',
                            canGet: true,
                            canSet: true,
                            notifyOnly: false,
                            nodeRole: 'read-write',
                            isScalar: true,
                            isTableColumn: false,
                            queryOid: sysContactOid + '.0',
                            hasChildren: false,
                            isLeaf: true,
                            treePath: [systemOid, sysContactOid]
                        }
                    ]
                },
                {
                    title: 'ifTable',
                    key: ifTableOid,
                    oid: ifTableOid,
                    objectName: 'ifTable',
                    moduleQualifiedName: 'IF-MIB::ifTable',
                    moduleName: 'IF-MIB',
                    pathName: 'iso.org.dod.internet.mgmt.mib-2.interfaces.ifTable',
                    macro: 'OBJECT-TYPE',
                    syntax: 'SEQUENCE OF IfEntry',
                    maxAccess: 'not-accessible',
                    status: 'current',
                    canGet: false,
                    canSet: false,
                    notifyOnly: false,
                    nodeRole: 'not-accessible',
                    isScalar: false,
                    isTableColumn: false,
                    queryOid: ifTableOid,
                    hasChildren: false,
                    isLeaf: true,
                    treePath: [ifTableOid]
                },
                {
                    title: 'linkDown',
                    key: linkDownOid,
                    oid: linkDownOid,
                    objectName: 'linkDown',
                    moduleQualifiedName: 'SNMPv2-MIB::linkDown',
                    moduleName: 'SNMPv2-MIB',
                    pathName: 'iso.org.dod.internet.snmpV2.snmpModules.snmpMIB.snmpMIBObjects.snmpTraps.linkDown',
                    macro: 'NOTIFICATION-TYPE',
                    syntax: '',
                    maxAccess: 'accessible-for-notify',
                    status: 'current',
                    canGet: false,
                    canSet: false,
                    notifyOnly: true,
                    nodeRole: 'notify-only',
                    isScalar: false,
                    isTableColumn: false,
                    queryOid: linkDownOid,
                    hasChildren: false,
                    isLeaf: true,
                    treePath: [linkDownOid]
                }
            ],
            loadedFiles: [
                {
                    fileName: 'NETNEXUS-DEMO-MIB.mib',
                    filePath: 'scripts/manual/snmp/mibs/NETNEXUS-DEMO-MIB.mib',
                    status: 'compiled'
                }
            ],
            skippedFiles: [
                {
                    fileName: 'NETNEXUS-DUPLICATE-MIB.mib',
                    filePath: 'scripts/manual/snmp/mibs/NETNEXUS-DUPLICATE-MIB.mib',
                    status: 'skipped',
                    msg: '模块已由更高优先级文件提供'
                }
            ],
            failedFiles: [
                {
                    fileName: 'NETNEXUS-BROKEN-MIB.mib',
                    filePath: 'scripts/manual/snmp/mibs/NETNEXUS-BROKEN-MIB.mib',
                    status: 'failed',
                    msg: '第 12 行缺少 END'
                }
            ],
            requestedFiles: ['scripts/manual/snmp/mibs']
        }
    };
}

function flattenMibTree(nodes) {
    return (Array.isArray(nodes) ? nodes : []).flatMap(node => [node, ...flattenMibTree(node.children)]);
}

function findMibNode(nodes, oid) {
    return flattenMibTree(nodes).find(node => node.oid === oid || node.key === oid);
}

async function handlePageCall(controller, method, args) {
    const snmp = controller.state.snmp;
    if (method === 'snmp.getSnmpConfig') return successResponse(snmp.config);
    if (method === 'snmp.getSnmpRuntimeState') return successResponse({ ...snmp.runtime });
    if (method === 'snmp.saveSnmpConfig') {
        snmp.config = { ...snmp.config, ...(args?.[0] || {}) };
        return successResponse(null, '配置保存成功');
    }
    if (method === 'snmp.startSnmp') {
        snmp.runtime = { running: true, ready: true, trapRunning: false };
        controller.emitEvent('snmp:runtimeChanged', { ...snmp.runtime });
        return successResponse({ ...snmp.runtime }, 'SNMP进程启动成功');
    }
    if (method === 'snmp.stopSnmp') {
        snmp.runtime = { running: false, ready: false, trapRunning: false };
        controller.emitEvent('snmp:runtimeChanged', { ...snmp.runtime });
        return successResponse({ ...snmp.runtime }, 'SNMP进程停止成功');
    }
    if (method === 'snmp.startSnmpTrap') {
        if (!snmp.runtime.ready) return errorResponse('SNMP进程尚未就绪');
        snmp.runtime = { ...snmp.runtime, trapRunning: true };
        controller.emitEvent('snmp:runtimeChanged', { ...snmp.runtime });
        return successResponse({ ...snmp.runtime }, 'Trap服务启动成功');
    }
    if (method === 'snmp.stopSnmpTrap') {
        snmp.runtime = { ...snmp.runtime, trapRunning: false };
        controller.emitEvent('snmp:runtimeChanged', { ...snmp.runtime });
        return successResponse({ ...snmp.runtime }, 'Trap服务停止成功');
    }
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
    if (method === 'snmp.getMibStatus') {
        if (snmp.mibStatusDelayMs > 0) await delay(snmp.mibStatusDelayMs);
        return successResponse(snmp.mibStatus);
    }
    if (method === 'snmp.getMibSource') {
        const request = args?.[0] || {};
        const filePath = typeof request === 'string' ? request : String(request.filePath || '');
        const fileName = filePath.split(/[\\/]/u).pop() || 'UNKNOWN-MIB.mib';
        const moduleName = fileName.replace(/\.(mib|txt|my)$/iu, '');
        return successResponse({
            filePath,
            fileName,
            source: `${moduleName} DEFINITIONS ::= BEGIN\n\nIMPORTS\n    MODULE-IDENTITY\n        FROM SNMPv2-SMI;\n\nEND\n`
        });
    }
    if (method === 'snmp.getMibTreeChildren') {
        const node = findMibNode(snmp.mibStatus.oidTree, args?.[0]);
        return successResponse(node?.children || []);
    }
    if (method === 'snmp.translateOid') {
        const requestedOid = typeof args?.[0] === 'string' ? args[0] : String(args?.[0]?.oid || '1.3.6.1.2.1.1.1.0');
        const matchedNode = flattenMibTree(snmp.mibStatus.oidTree)
            .filter(node => requestedOid === node.oid || requestedOid.startsWith(node.oid + '.'))
            .sort((left, right) => right.oid.length - left.oid.length)[0];
        const instanceSuffix =
            matchedNode && requestedOid !== matchedNode.oid ? requestedOid.slice(matchedNode.oid.length + 1) : '';

        return successResponse({
            ...(matchedNode || {}),
            oid: requestedOid,
            matched: Boolean(matchedNode),
            matchedOid: matchedNode?.oid || '',
            instanceSuffix
        });
    }
    if (method === 'snmp.listMibProjects') return successResponse({ rootDir: controller.protocolRoot, projects: [] });
    if (method === 'snmp.selectMibFiles')
        return successResponse({ filePaths: ['scripts/manual/snmp/mibs/NETNEXUS-DEMO-MIB.mib'] });
    if (method === 'snmp.selectMibDirectory') return successResponse({ directoryPath: 'scripts/manual/snmp/mibs' });
    if (method === 'snmp.compileMibs') return successResponse(snmp.mibStatus);
    if (method === 'snmp.sendGetRequest' || method === 'snmp.sendGetNextRequest') {
        const request = args?.[0] || {};
        const oid = method === 'snmp.sendGetNextRequest' ? '1.3.6.1.2.1.1.4.0' : request.oid || '1.3.6.1.2.1.1.1.0';
        return successResponse({
            targetHost: snmp.config.targetHost,
            targetPort: snmp.config.queryPort,
            version: 'v2c',
            varbinds: [
                {
                    oid,
                    type: 'OctetString',
                    value: method === 'snmp.sendGetNextRequest' ? 'noc@example.test' : 'NetNexus E2E',
                    displayValue: method === 'snmp.sendGetNextRequest' ? 'noc@example.test' : 'NetNexus E2E'
                }
            ]
        });
    }
    if (method === 'snmp.sendWalkRequest') {
        const request = args?.[0] || {};
        return successResponse({
            targetHost: snmp.config.targetHost,
            targetPort: snmp.config.queryPort,
            version: 'v2c',
            baseOid: request.oid || '1.3.6.1.2.1.1',
            limit: request.limit || 100,
            maxRepetitions: request.maxRepetitions || 20,
            rows: [
                {
                    oid: '1.3.6.1.2.1.1.1.0',
                    type: 'OctetString',
                    value: 'NetNexus E2E',
                    displayValue: 'NetNexus E2E'
                },
                {
                    oid: '1.3.6.1.2.1.1.4.0',
                    type: 'OctetString',
                    value: 'noc@example.test',
                    displayValue: 'noc@example.test'
                }
            ],
            stoppedBy: 'endOfSubtree',
            limitReached: false
        });
    }
    if (method === 'snmp.sendSetRequest') {
        const request = args?.[0] || {};
        return successResponse({
            targetHost: snmp.config.targetHost,
            targetPort: snmp.config.queryPort,
            version: 'v2c',
            varbinds: [
                {
                    oid: request.oid || '1.3.6.1.2.1.1.4.0',
                    type: request.type || 'OctetString',
                    value: request.value || 'updated@example.test',
                    displayValue: request.value || 'updated@example.test'
                }
            ]
        });
    }
    if (method === 'snmp.listOidInstances') {
        const request = args?.[0] || {};
        return successResponse({
            targetHost: snmp.config.targetHost,
            targetPort: snmp.config.queryPort,
            version: 'v2c',
            baseOid: request.oid || '1.3.6.1.2.1.2.2',
            limit: request.limit || 100,
            maxRepetitions: request.maxRepetitions || 20,
            rows: [
                {
                    oid: '1.3.6.1.2.1.2.2.1.2.1',
                    instance: '1',
                    type: 'OctetString',
                    value: 'Ethernet0',
                    displayValue: 'Ethernet0'
                }
            ],
            stoppedBy: 'endOfSubtree',
            limitReached: false
        });
    }
    return successResponse(null);
}

module.exports = {
    createSnmpPageState,
    handlePageCall,
    snmpPageApiScript
};
