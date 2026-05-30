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
    selectDirectory: () => ipcRenderer.invoke('common:selectDirectory'),
    saveUpdateSettings: settings => ipcRenderer.invoke('common:saveUpdateSettings', settings),
    getUpdateSettings: () => ipcRenderer.invoke('common:getUpdateSettings'),

    // 服务器部署
    deployServer: deployConfig => ipcRenderer.invoke('common:deployServer', deployConfig),
    saveDeploymentConfig: config => ipcRenderer.invoke('common:saveDeploymentConfig', config),
    loadDeploymentConfig: () => ipcRenderer.invoke('common:loadDeploymentConfig'),
    testSSHConnection: config => ipcRenderer.invoke('common:testSSHConnection', config),
    getServerDeploymentStatus: () => ipcRenderer.invoke('common:getServerDeploymentStatus'),

    // Keychain 管理
    saveKeychain: keychain => ipcRenderer.invoke('common:saveKeychain', keychain),
    loadKeychains: () => ipcRenderer.invoke('common:loadKeychains'),
    deleteKeychain: id => ipcRenderer.invoke('common:deleteKeychain', id),
    getActiveKey: (keychainId, time) => ipcRenderer.invoke('common:getActiveKey', keychainId, time),

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
    getTcpAoMacState: () => ipcRenderer.invoke('tools:getTcpAoMacState')
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
    deleteAllRoutesByFamily: addressFamily => ipcRenderer.invoke('bgp:deleteAllRoutesByFamily', addressFamily),
    getRoutes: (addressFamily, page, pageSize) => ipcRenderer.invoke('bgp:getRoutes', addressFamily, page, pageSize),

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
    getBgpSessions: client => ipcRenderer.invoke('bmp:getBgpSessions', client),
    getBgpRoutes: (client, session, af, ribType, page, pageSize, routeState) =>
        ipcRenderer.invoke('bmp:getBgpRoutes', client, session, af, ribType, page, pageSize, routeState),
    getBgpInstances: client => ipcRenderer.invoke('bmp:getBgpInstances', client),
    getBgpInstanceRoutes: (client, instance, page, pageSize, routeState) =>
        ipcRenderer.invoke('bmp:getBgpInstanceRoutes', client, instance, page, pageSize, routeState),
    purgeStaleBgpRoutes: (client, session, af, ribType) =>
        ipcRenderer.invoke('bmp:purgeStaleBgpRoutes', client, session, af, ribType),
    purgeStaleBgpInstanceRoutes: (client, instance) =>
        ipcRenderer.invoke('bmp:purgeStaleBgpInstanceRoutes', client, instance),
    getBgpStatisticsReports: client => ipcRenderer.invoke('bmp:getBgpStatisticsReports', client),
    getBgpInstanceStatisticsReports: client => ipcRenderer.invoke('bmp:getBgpInstanceStatisticsReports', client)
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
    getRoaList: () => ipcRenderer.invoke('rpki:getRoaList'),
    getClientList: () => ipcRenderer.invoke('rpki:getClientList')
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
    stopSnmp: () => ipcRenderer.invoke('snmp:stopSnmp')
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

// 依赖本地工具模块
contextBridge.exposeInMainWorld('nativeApi', {
    // 抓包工具模块
    getNetworkInterfaces: () => ipcRenderer.invoke('native:getNetworkInterfaces'),
    getNetworkInfo: () => ipcRenderer.invoke('native:getNetworkInfo'),
    manageNetwork: config => ipcRenderer.invoke('native:manageNetwork', config),
    startPacketCapture: config => ipcRenderer.invoke('native:startPacketCapture', config),
    stopPacketCapture: () => ipcRenderer.invoke('native:stopPacketCapture'),
    getPacketHistory: () => ipcRenderer.invoke('native:getPacketHistory'),
    exportPacketsToPcap: packets => ipcRenderer.invoke('native:exportPacketsToPcap', packets),

    // 格式化工具模块
    formatData: formatterData => ipcRenderer.invoke('native:formatData', formatterData),
    getFormatterHistory: () => ipcRenderer.invoke('native:getFormatterHistory'),
    clearFormatterHistory: () => ipcRenderer.invoke('native:clearFormatterHistory'),

    // 端口监听工具模块
    getListeningPorts: () => ipcRenderer.invoke('native:getListeningPorts'),
    killProcess: pid => ipcRenderer.invoke('native:killProcess', pid)
});
