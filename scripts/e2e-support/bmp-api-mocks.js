(function installBmpApiMocks() {
    const unifiedCallbacks = [];

    window.__bmpE2eEmit = (type, data) => {
        unifiedCallbacks.forEach(callback => callback({ type, data }));
    };

    window.commonApi = {
        onUnifiedEvent: callback => {
            unifiedCallbacks.push(callback);
            return () => {
                const index = unifiedCallbacks.indexOf(callback);
                if (index >= 0) {
                    unifiedCallbacks.splice(index, 1);
                }
            };
        },
        notifyRendererReady: () => {},
        getServerDeploymentStatus: async () => ({
            status: 'success',
            data: { success: true }
        }),
        openDeveloperOptions: () => {},
        openSoftwareInfo: () => {}
    };

    window.bmpApi = {
        saveBmpConfig: config => window.__bmpE2eCall('saveBmpConfig', config),
        loadBmpConfig: () => window.__bmpE2eCall('loadBmpConfig'),
        startBmp: config => window.__bmpE2eCall('startBmp', config),
        stopBmp: () => window.__bmpE2eCall('stopBmp'),
        getClientList: () => window.__bmpE2eCall('getClientList'),
        getBgpSessions: client => window.__bmpE2eCall('getBgpSessions', client),
        getBgpRoutes: (client, session, af, ribType, page, pageSize, routeState, prefixFilter) =>
            window.__bmpE2eCall('getBgpRoutes', {
                client,
                session,
                af,
                ribType,
                page,
                pageSize,
                routeState,
                prefixFilter
            }),
        getBgpRouteDetail: (client, session, af, ribType, routeKey, includeSummary = false) =>
            window.__bmpE2eCall('getBgpRouteDetail', {
                client,
                session,
                af,
                ribType,
                routeKey,
                includeSummary
            }),
        getBgpInstances: client => window.__bmpE2eCall('getBgpInstances', client),
        getBgpInstanceRoutes: (client, instance, page, pageSize, routeState, prefixFilter) =>
            window.__bmpE2eCall('getBgpInstanceRoutes', {
                client,
                instance,
                page,
                pageSize,
                routeState,
                prefixFilter
            }),
        getBgpInstanceRouteDetail: (client, instance, routeKey, includeSummary = false) =>
            window.__bmpE2eCall('getBgpInstanceRouteDetail', {
                client,
                instance,
                routeKey,
                includeSummary
            }),
        purgeStaleBgpRoutes: (client, session, af, ribType) =>
            window.__bmpE2eCall('purgeStaleBgpRoutes', {
                client,
                session,
                af,
                ribType
            }),
        purgeStaleBgpInstanceRoutes: (client, instance) =>
            window.__bmpE2eCall('purgeStaleBgpInstanceRoutes', {
                client,
                instance
            }),
        getBgpStatisticsReports: client => window.__bmpE2eCall('getBgpStatisticsReports', client),
        getBgpInstanceStatisticsReports: client => window.__bmpE2eCall('getBgpInstanceStatisticsReports', client)
    };
})();
