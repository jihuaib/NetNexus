const { contextBridge, ipcRenderer } = require('electron');

// ================================
// 统一事件监听分配器 (仅用于单级转发)
// ================================

// 通用模块
contextBridge.exposeInMainWorld('commonApi', {
    openDeveloperOptions: () => ipcRenderer.send('common:openDeveloperOptions'),
    openSoftwareInfo: () => ipcRenderer.send('common:openSoftwareInfo'),
    saveGeneralSettings: settings => ipcRenderer.invoke('common:saveGeneralSettings', settings),
    getGeneralSettings: () => ipcRenderer.invoke('common:getGeneralSettings'),
    saveToolsSettings: settings => ipcRenderer.invoke('common:saveToolsSettings', settings),
    getToolsSettings: () => ipcRenderer.invoke('common:getToolsSettings'),
    saveFtpSettings: settings => ipcRenderer.invoke('common:saveFtpSettings', settings),
    getFtpSettings: () => ipcRenderer.invoke('common:getFtpSettings'),
    saveApiSettings: settings => ipcRenderer.invoke('common:saveApiSettings', settings),
    getApiSettings: () => ipcRenderer.invoke('common:getApiSettings'),
    getApiServerStatus: () => ipcRenderer.invoke('common:getApiServerStatus'),
    selectDirectory: () => ipcRenderer.invoke('common:selectDirectory'),
    saveUpdateSettings: settings => ipcRenderer.invoke('common:saveUpdateSettings', settings),
    getUpdateSettings: () => ipcRenderer.invoke('common:getUpdateSettings'),
    getWiresharkBmpPluginStatus: () => ipcRenderer.invoke('common:getWiresharkBmpPluginStatus'),
    installWiresharkBmpPlugin: () => ipcRenderer.invoke('common:installWiresharkBmpPlugin'),
    uninstallWiresharkBmpPlugin: () => ipcRenderer.invoke('common:uninstallWiresharkBmpPlugin'),
    openWiresharkPluginDirectory: () => ipcRenderer.invoke('common:openWiresharkPluginDirectory'),
    notifyRendererReady: () => ipcRenderer.send('app:renderer-ready'),

    // 服务器部署
    deployServer: deployConfig => ipcRenderer.invoke('common:deployServer', deployConfig),
    saveDeploymentConfig: config => ipcRenderer.invoke('common:saveDeploymentConfig', config),
    loadDeploymentConfig: () => ipcRenderer.invoke('common:loadDeploymentConfig'),
    testSSHConnection: config => ipcRenderer.invoke('common:testSSHConnection', config),
    getServerDeploymentStatus: () => ipcRenderer.invoke('common:getServerDeploymentStatus'),

    // 提供一个统一的事件监听接口给渲染进程，由渲染进程的 EventBus 负责分发
    onUnifiedEvent: callback => {
        const subscription = (event, { type, data }) => callback({ type, data });
        ipcRenderer.on('unified-event', subscription);
        return () => ipcRenderer.removeListener('unified-event', subscription);
    }
});

// 更新模块
contextBridge.exposeInMainWorld('updaterApi', {
    checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
    downloadUpdate: () => ipcRenderer.invoke('updater:downloadUpdate'),
    quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall'),
    getCurrentVersion: () => ipcRenderer.invoke('updater:getCurrentVersion')
});

// 工具模块
contextBridge.exposeInMainWorld('toolsApi', {
    generateString: templateData => ipcRenderer.invoke('tools:generateString', templateData),
    getGenerateStringHistory: () => ipcRenderer.invoke('tools:getGenerateStringHistory'),
    clearGenerateStringHistory: () => ipcRenderer.invoke('tools:clearGenerateStringHistory'),
    parsePacket: packetData => ipcRenderer.invoke('tools:parsePacket', packetData),
    parsePacketNoSaveHistory: packetData => ipcRenderer.invoke('tools:parsePacketNoSaveHistory', packetData),
    getPacketParserHistory: () => ipcRenderer.invoke('tools:getPacketParserHistory'),
    clearPacketParserHistory: () => ipcRenderer.invoke('tools:clearPacketParserHistory'),
    calculateTcpAoMac: data => ipcRenderer.invoke('tools:calculateTcpAoMac', data),
    saveTcpAoMacState: state => ipcRenderer.invoke('tools:saveTcpAoMacState', state),
    getTcpAoMacState: () => ipcRenderer.invoke('tools:getTcpAoMacState'),
    sendHttpApiRequest: requestConfig => ipcRenderer.invoke('tools:sendHttpApiRequest', requestConfig),
    getHttpApiConnections: () => ipcRenderer.invoke('tools:getHttpApiConnections'),
    saveHttpApiConnections: connections => ipcRenderer.invoke('tools:saveHttpApiConnections', connections),
    resetHttpApiConnections: () => ipcRenderer.invoke('tools:resetHttpApiConnections'),
    tcpConnect: options => ipcRenderer.invoke('tools:tcpConnect', options),
    tcpSend: payload => ipcRenderer.invoke('tools:tcpSend', payload),
    tcpClose: payload => ipcRenderer.invoke('tools:tcpClose', payload),
    udpOpen: options => ipcRenderer.invoke('tools:udpOpen', options),
    udpSend: payload => ipcRenderer.invoke('tools:udpSend', payload),
    udpClose: payload => ipcRenderer.invoke('tools:udpClose', payload)
});

// bgp模块
contextBridge.exposeInMainWorld('bgpApi', {
    // 配置相关
    saveBgpConfig: config => ipcRenderer.invoke('bgp:saveBgpConfig', config),
    loadBgpConfig: () => ipcRenderer.invoke('bgp:loadBgpConfig'),
    saveIpv4PeerConfig: config => ipcRenderer.invoke('bgp:saveIpv4PeerConfig', config),
    loadIpv4PeerConfig: () => ipcRenderer.invoke('bgp:loadIpv4PeerConfig'),
    saveIpv6PeerConfig: config => ipcRenderer.invoke('bgp:saveIpv6PeerConfig', config),
    loadIpv6PeerConfig: () => ipcRenderer.invoke('bgp:loadIpv6PeerConfig'),
    saveIpv4UNCRouteConfig: config => ipcRenderer.invoke('bgp:saveIpv4UNCRouteConfig', config),
    loadIpv4UNCRouteConfig: () => ipcRenderer.invoke('bgp:loadIpv4UNCRouteConfig'),
    saveIpv6UNCRouteConfig: config => ipcRenderer.invoke('bgp:saveIpv6UNCRouteConfig', config),
    loadIpv6UNCRouteConfig: () => ipcRenderer.invoke('bgp:loadIpv6UNCRouteConfig'),

    // bgp操作
    startBgp: bgpConfigData => ipcRenderer.invoke('bgp:startBgp', bgpConfigData),
    stopBgp: () => ipcRenderer.invoke('bgp:stopBgp'),

    // peer操作
    configIpv4Peer: ipv4PeerConfigData => ipcRenderer.invoke('bgp:configIpv4Peer', ipv4PeerConfigData),
    configIpv6Peer: ipv6PeerConfigData => ipcRenderer.invoke('bgp:configIpv6Peer', ipv6PeerConfigData),
    getPeerInfo: () => ipcRenderer.invoke('bgp:getPeerInfo'),
    deletePeer: peer => ipcRenderer.invoke('bgp:deletePeer', peer),

    // route操作
    generateIpv4Routes: config => ipcRenderer.invoke('bgp:generateIpv4Routes', config),
    generateIpv6Routes: config => ipcRenderer.invoke('bgp:generateIpv6Routes', config),
    deleteIpv4Routes: config => ipcRenderer.invoke('bgp:deleteIpv4Routes', config),
    deleteIpv6Routes: config => ipcRenderer.invoke('bgp:deleteIpv6Routes', config),
    deleteAllRoutesByFamily: (addressFamily, options = {}) =>
        ipcRenderer.invoke('bgp:deleteAllRoutesByFamily', addressFamily, options),
    getRoutes: (addressFamily, page, pageSize, options = {}) =>
        ipcRenderer.invoke('bgp:getRoutes', addressFamily, page, pageSize, options),
    getRouteDetail: (addressFamily, route) => ipcRenderer.invoke('bgp:getRouteDetail', addressFamily, route),

    saveIpv4QpRouteConfig: config => ipcRenderer.invoke('bgp:saveIpv4QpRouteConfig', config),
    loadIpv4QpRouteConfig: () => ipcRenderer.invoke('bgp:loadIpv4QpRouteConfig'),
    saveIpv6QpRouteConfig: config => ipcRenderer.invoke('bgp:saveIpv6QpRouteConfig', config),
    loadIpv6QpRouteConfig: () => ipcRenderer.invoke('bgp:loadIpv6QpRouteConfig'),
    generateIpv4QpRoutes: config => ipcRenderer.invoke('bgp:generateIpv4QpRoutes', config),
    generateIpv6QpRoutes: config => ipcRenderer.invoke('bgp:generateIpv6QpRoutes', config),
    deleteIpv4QpRoutes: config => ipcRenderer.invoke('bgp:deleteIpv4QpRoutes', config),
    deleteIpv6QpRoutes: config => ipcRenderer.invoke('bgp:deleteIpv6QpRoutes', config),

    saveIpv4MvpnRouteConfig: config => ipcRenderer.invoke('bgp:saveIpv4MvpnRouteConfig', config),
    loadIpv4MvpnRouteConfig: () => ipcRenderer.invoke('bgp:loadIpv4MvpnRouteConfig'),
    generateIpv4MvpnRoutes: config => ipcRenderer.invoke('bgp:generateIpv4MvpnRoutes', config),
    deleteIpv4MvpnRoutes: config => ipcRenderer.invoke('bgp:deleteIpv4MvpnRoutes', config),

    // RouteViews 导入
    selectMrtFile: () => ipcRenderer.invoke('bgp:selectMrtFile'),
    importRouteViewsData: (filePath, limit, addressFamily) =>
        ipcRenderer.invoke('bgp:importRouteViewsData', filePath, limit, addressFamily),
    openExternal: url => ipcRenderer.invoke('bgp:openExternal', url),
    getInstanceInfo: () => ipcRenderer.invoke('bgp:getInstanceInfo'),
    getDefaultMrtFiles: () => ipcRenderer.invoke('bgp:getDefaultMrtFiles')
});

// bmp模块
contextBridge.exposeInMainWorld('bmpApi', {
    // 配置相关
    saveBmpConfig: config => ipcRenderer.invoke('bmp:saveBmpConfig', config),
    loadBmpConfig: () => ipcRenderer.invoke('bmp:loadBmpConfig'),

    // bmp操作
    startBmp: config => ipcRenderer.invoke('bmp:startBmp', config),
    stopBmp: () => ipcRenderer.invoke('bmp:stopBmp'),

    // 数据获取
    getClientList: () => ipcRenderer.invoke('bmp:getClientList'),
    deleteClientData: (request = {}) =>
        ipcRenderer.invoke('bmp:deleteClientData', {
            sourceId: typeof request?.sourceId === 'string' ? request.sourceId : '',
            remoteIp: typeof request?.remoteIp === 'string' ? request.remoteIp : ''
        }),
    getRouteLens: (query, routeState = 'active') => ipcRenderer.invoke('bmp:getRouteLens', query, routeState),
    getRouteAssurance: (filters = {}) => ipcRenderer.invoke('bmp:getRouteAssurance', filters),
    setRouteAssuranceEnabled: (enabled, filters = {}) =>
        ipcRenderer.invoke('bmp:setRouteAssuranceEnabled', { enabled, filters }),
    getBgpSessions: client => ipcRenderer.invoke('bmp:getBgpSessions', client),
    getBgpRoutes: (client, session, af, ribType, page, pageSize, routeState, prefixFilter) =>
        ipcRenderer.invoke('bmp:getBgpRoutes', client, session, af, ribType, page, pageSize, routeState, prefixFilter),
    getBgpRouteDetail: (client, session, af, ribType, routeKey) =>
        ipcRenderer.invoke('bmp:getBgpRouteDetail', client, session, af, ribType, routeKey),
    getBgpInstances: client => ipcRenderer.invoke('bmp:getBgpInstances', client),
    getBgpInstanceRoutes: (client, instance, page, pageSize, routeState, prefixFilter) =>
        ipcRenderer.invoke('bmp:getBgpInstanceRoutes', client, instance, page, pageSize, routeState, prefixFilter),
    getBgpInstanceRouteDetail: (client, instance, routeKey) =>
        ipcRenderer.invoke('bmp:getBgpInstanceRouteDetail', client, instance, routeKey),
    purgeStaleBgpRoutes: (client, session, af, ribType) =>
        ipcRenderer.invoke('bmp:purgeStaleBgpRoutes', client, session, af, ribType),
    purgeStaleBgpInstanceRoutes: (client, instance) =>
        ipcRenderer.invoke('bmp:purgeStaleBgpInstanceRoutes', client, instance),
    getBgpStatisticsReports: client => ipcRenderer.invoke('bmp:getBgpStatisticsReports', client),
    getBgpInstanceStatisticsReports: client => ipcRenderer.invoke('bmp:getBgpInstanceStatisticsReports', client),
    getPersistenceStatus: () => ipcRenderer.invoke('bmp:getPersistenceStatus'),
    getPersistedRoutes: (query = {}) => ipcRenderer.invoke('bmp:getPersistedRoutes', query),
    getPersistedRouteEvents: (query = {}) => ipcRenderer.invoke('bmp:getPersistedRouteEvents', query)
});

// rpki模块
contextBridge.exposeInMainWorld('rpkiApi', {
    // 配置相关
    saveRpkiConfig: config => ipcRenderer.invoke('rpki:saveRpkiConfig', config),
    loadRpkiConfig: () => ipcRenderer.invoke('rpki:loadRpkiConfig'),

    // rpki操作
    startRpki: config => ipcRenderer.invoke('rpki:startRpki', config),
    stopRpki: () => ipcRenderer.invoke('rpki:stopRpki'),

    // roa操作
    addRoa: roa => ipcRenderer.invoke('rpki:addRoa', roa),
    deleteRoa: roa => ipcRenderer.invoke('rpki:deleteRoa', roa),
    deleteAllRoa: () => ipcRenderer.invoke('rpki:deleteAllRoa'),
    getRoaList: options => ipcRenderer.invoke('rpki:getRoaList', options),
    selectRoaJsonFile: () => ipcRenderer.invoke('rpki:selectRoaJsonFile'),
    importRoaJson: options => ipcRenderer.invoke('rpki:importRoaJson', options),
    getClientList: () => ipcRenderer.invoke('rpki:getClientList'),

    // router key (v1+)
    addRouterKey: rk => ipcRenderer.invoke('rpki:addRouterKey', rk),
    deleteRouterKey: rk => ipcRenderer.invoke('rpki:deleteRouterKey', rk),
    getRouterKeyList: () => ipcRenderer.invoke('rpki:getRouterKeyList'),

    // aspa (v2+)
    addAspa: aspa => ipcRenderer.invoke('rpki:addAspa', aspa),
    deleteAspa: aspa => ipcRenderer.invoke('rpki:deleteAspa', aspa),
    deleteAllAspa: () => ipcRenderer.invoke('rpki:deleteAllAspa'),
    selectAspaJsonFile: () => ipcRenderer.invoke('rpki:selectAspaJsonFile'),
    importAspaJson: options => ipcRenderer.invoke('rpki:importAspaJson', options),
    getAspaList: options => ipcRenderer.invoke('rpki:getAspaList', options)
});

// ftp模块
contextBridge.exposeInMainWorld('ftpApi', {
    // 配置相关
    addFtpUser: user => ipcRenderer.invoke('ftp:addFtpUser', user),
    getFtpUserList: () => ipcRenderer.invoke('ftp:getFtpUserList'),
    deleteFtpUser: user => ipcRenderer.invoke('ftp:deleteFtpUser', user),
    saveFtpConfig: config => ipcRenderer.invoke('ftp:saveFtpConfig', config),
    getFtpConfig: () => ipcRenderer.invoke('ftp:getFtpConfig'),

    // ftp操作
    startFtp: (config, user) => ipcRenderer.invoke('ftp:startFtp', config, user),
    stopFtp: () => ipcRenderer.invoke('ftp:stopFtp'),
    getFtpStatus: () => ipcRenderer.invoke('ftp:getFtpStatus'),
    getClientList: () => ipcRenderer.invoke('ftp:getClientList')
});

// dhcp模块
contextBridge.exposeInMainWorld('dhcpApi', {
    saveDhcpConfig: config => ipcRenderer.invoke('dhcp:saveDhcpConfig', config),
    getDhcpConfig: () => ipcRenderer.invoke('dhcp:getDhcpConfig'),
    startDhcp: config => ipcRenderer.invoke('dhcp:startDhcp', config),
    stopDhcp: () => ipcRenderer.invoke('dhcp:stopDhcp'),
    getLeaseList: () => ipcRenderer.invoke('dhcp:getLeaseList'),
    releaseLease: macAddr => ipcRenderer.invoke('dhcp:releaseLease', macAddr),
    releaseDhcp6Lease: duid => ipcRenderer.invoke('dhcp:releaseDhcp6Lease', duid)
});

// snmp模块
contextBridge.exposeInMainWorld('snmpApi', {
    // 配置相关
    saveSnmpConfig: config => ipcRenderer.invoke('snmp:saveSnmpConfig', config),
    getSnmpConfig: () => ipcRenderer.invoke('snmp:getSnmpConfig'),

    // snmp服务
    startSnmp: config => ipcRenderer.invoke('snmp:startSnmp', config),
    stopSnmp: () => ipcRenderer.invoke('snmp:stopSnmp'),
    getTrapList: query => ipcRenderer.invoke('snmp:getTrapList', query),
    clearTrapHistory: () => ipcRenderer.invoke('snmp:clearTrapHistory'),
    selectMibFiles: () => ipcRenderer.invoke('snmp:selectMibFiles'),
    selectMibDirectory: () => ipcRenderer.invoke('snmp:selectMibDirectory'),
    compileMibs: (filePaths, options = {}) =>
        ipcRenderer.invoke('snmp:compileMibs', {
            filePaths,
            force: Boolean(options.force)
        }),
    getMibStatus: () => ipcRenderer.invoke('snmp:getMibStatus'),
    getMibTreeChildren: parentOid => ipcRenderer.invoke('snmp:getMibTreeChildren', parentOid),
    saveMibProject: payload => ipcRenderer.invoke('snmp:saveMibProject', payload),
    listMibProjects: () => ipcRenderer.invoke('snmp:listMibProjects'),
    importMibProject: payload => ipcRenderer.invoke('snmp:importMibProject', payload),
    clearMibs: () => ipcRenderer.invoke('snmp:clearMibs'),
    translateOid: oid => ipcRenderer.invoke('snmp:translateOid', oid),
    sendGetRequest: request => ipcRenderer.invoke('snmp:sendGetRequest', request),
    sendGetNextRequest: request => ipcRenderer.invoke('snmp:sendGetNextRequest', request),
    sendWalkRequest: request => ipcRenderer.invoke('snmp:sendWalkRequest', request),
    sendSetRequest: request => ipcRenderer.invoke('snmp:sendSetRequest', request),
    listOidInstances: request => ipcRenderer.invoke('snmp:listOidInstances', request)
});

// NETCONF 连接与设备操作
contextBridge.exposeInMainWorld('netconfApi', {
    listProfiles: () => ipcRenderer.invoke('netconf:listProfiles'),
    saveProfile: profile => ipcRenderer.invoke('netconf:saveProfile', profile),
    deleteProfile: profileId => ipcRenderer.invoke('netconf:deleteProfile', profileId),
    selectPrivateKey: () => ipcRenderer.invoke('netconf:selectPrivateKey'),
    testConnection: profile => ipcRenderer.invoke('netconf:testConnection', profile),
    connect: profileId => ipcRenderer.invoke('netconf:connect', profileId),
    disconnect: profileId => ipcRenderer.invoke('netconf:disconnect', profileId),
    getSessionState: profileId => ipcRenderer.invoke('netconf:getSessionState', profileId),
    getSubscriptions: request => ipcRenderer.invoke('netconf:getSubscriptions', request),
    discoverModules: profileId => ipcRenderer.invoke('netconf:discoverModules', profileId),
    downloadModules: request => ipcRenderer.invoke('netconf:downloadModules', request),
    executeOperation: request => ipcRenderer.invoke('netconf:executeOperation', request),
    sendRpc: request => ipcRenderer.invoke('netconf:sendRpc', request)
});

// YANG 本地仓库与编译
contextBridge.exposeInMainWorld('yangApi', {
    listModules: query => ipcRenderer.invoke('yang:listModules', query),
    selectFiles: () => ipcRenderer.invoke('yang:selectFiles'),
    selectDirectory: () => ipcRenderer.invoke('yang:selectDirectory'),
    importFiles: request => ipcRenderer.invoke('yang:importFiles', request),
    importDirectory: request => ipcRenderer.invoke('yang:importDirectory', request),
    getCompilerStatus: options => ipcRenderer.invoke('yang:getCompilerStatus', options),
    compile: options => ipcRenderer.invoke('yang:compile', options),
    clearWorkspace: request => ipcRenderer.invoke('yang:clearWorkspace', request),
    getWorkspace: request => ipcRenderer.invoke('yang:getWorkspace', request),
    getSchemaRoots: query => ipcRenderer.invoke('yang:getSchemaRoots', query),
    getSchemaChildren: request => ipcRenderer.invoke('yang:getSchemaChildren', request),
    getSchemaNode: request => ipcRenderer.invoke('yang:getSchemaNode', request),
    validateRpc: request => ipcRenderer.invoke('yang:validateRpc', request),
    getModuleSource: request => ipcRenderer.invoke('yang:getModuleSource', request),
    getDiagnostics: query => ipcRenderer.invoke('yang:getDiagnostics', query)
});

// ntp模块
contextBridge.exposeInMainWorld('ntpApi', {
    saveNtpConfig: config => ipcRenderer.invoke('ntp:saveNtpConfig', config),
    getNtpConfig: () => ipcRenderer.invoke('ntp:getNtpConfig'),
    startNtp: config => ipcRenderer.invoke('ntp:startNtp', config),
    stopNtp: () => ipcRenderer.invoke('ntp:stopNtp'),
    getRequestList: () => ipcRenderer.invoke('ntp:getRequestList'),
    clearRequestHistory: () => ipcRenderer.invoke('ntp:clearRequestHistory')
});

// radius模块
contextBridge.exposeInMainWorld('radiusApi', {
    saveRadiusConfig: config => ipcRenderer.invoke('radius:saveRadiusConfig', config),
    getRadiusConfig: () => ipcRenderer.invoke('radius:getRadiusConfig'),
    startRadius: config => ipcRenderer.invoke('radius:startRadius', config),
    stopRadius: () => ipcRenderer.invoke('radius:stopRadius'),
    getRequestList: () => ipcRenderer.invoke('radius:getRequestList'),
    clearRequestHistory: () => ipcRenderer.invoke('radius:clearRequestHistory'),
    getSessionList: () => ipcRenderer.invoke('radius:getSessionList')
});

// tftp模块
contextBridge.exposeInMainWorld('tftpApi', {
    saveTftpConfig: config => ipcRenderer.invoke('tftp:saveTftpConfig', config),
    getTftpConfig: () => ipcRenderer.invoke('tftp:getTftpConfig'),
    startTftp: config => ipcRenderer.invoke('tftp:startTftp', config),
    stopTftp: () => ipcRenderer.invoke('tftp:stopTftp'),
    getTransferList: () => ipcRenderer.invoke('tftp:getTransferList'),
    clearTransferHistory: () => ipcRenderer.invoke('tftp:clearTransferHistory')
});

// syslog模块
contextBridge.exposeInMainWorld('syslogApi', {
    saveSyslogConfig: config => ipcRenderer.invoke('syslog:saveSyslogConfig', config),
    getSyslogConfig: () => ipcRenderer.invoke('syslog:getSyslogConfig'),
    startSyslog: config => ipcRenderer.invoke('syslog:startSyslog', config),
    stopSyslog: () => ipcRenderer.invoke('syslog:stopSyslog'),
    getMessageList: query => ipcRenderer.invoke('syslog:getMessageList', query),
    getMessageDetail: id => ipcRenderer.invoke('syslog:getMessageDetail', id),
    clearMessageHistory: () => ipcRenderer.invoke('syslog:clearMessageHistory')
});

// 依赖本地工具模块
contextBridge.exposeInMainWorld('nativeApi', {
    // 网络信息工具模块
    getNetworkInfo: () => ipcRenderer.invoke('native:getNetworkInfo'),
    manageNetwork: config => ipcRenderer.invoke('native:manageNetwork', config),
    getRoutes: () => ipcRenderer.invoke('native:getRoutes'),
    manageRoute: config => ipcRenderer.invoke('native:manageRoute', config),

    // 端口监听工具模块
    getListeningPorts: () => ipcRenderer.invoke('native:getListeningPorts'),
    killProcess: pid => ipcRenderer.invoke('native:killProcess', pid)
});
