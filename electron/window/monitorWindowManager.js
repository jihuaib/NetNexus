const { app, BrowserWindow } = require('electron');
const logger = require('../log/logger');
const EventDispatcher = require('../utils/eventDispatcher');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const { GET_PROCESS_RESOURCE_SNAPSHOT_CHANNEL, ProcessResourceSampler } = require('./processResourceService');

const OPEN_MONITOR_CHANNEL = 'window:openMonitor';
const MONITOR_CONTEXT_EVENT = 'window:monitorContext';
const RENDERER_READY_CHANNEL = 'app:renderer-ready';
const SUBSCRIBE_EVENT_SCOPE_CHANNEL = 'window:subscribeEventScope';
const UNSUBSCRIBE_EVENT_SCOPE_CHANNEL = 'window:unsubscribeEventScope';
const MAX_MONITOR_WINDOWS = 32;
const MAX_NETCONF_MONITOR_IDENTIFIER_BYTES = 1024;

const EVENT_SCOPE_DEFINITIONS = Object.freeze({
    'bmp-route-assurance': Object.freeze(['bmp:routeAssuranceInvalidated']),
    'bmp-route-lens': Object.freeze(['bmp:routeLensInvalidated'])
});

const BMP_CLIENT_MONITOR_IDS = new Set(['bmp-client']);
const NETCONF_EDIT_CONFIG_MONITOR_IDS = new Set(['netconf-edit-config']);

const MONITOR_ALIASES = Object.freeze({
    'bmp-session': Object.freeze({ monitorId: 'bmp-client', view: 'session' }),
    'bmp-loc-rib': Object.freeze({ monitorId: 'bmp-client', view: 'loc-rib' })
});

const MONITOR_DEFINITIONS = Object.freeze({
    'process-resource-manager': Object.freeze({
        protocol: 'system',
        route: '/monitor/process-resource-manager',
        title: '进程资源管理器 - NetNexus',
        width: 1180,
        height: 760,
        minWidth: 900,
        minHeight: 600,
        eventTypes: Object.freeze([])
    }),
    'syslog-message-log': Object.freeze({
        protocol: 'syslog',
        route: '/monitor/syslog-message-log',
        title: 'Syslog 消息监控 - NetNexus',
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 620,
        eventTypes: Object.freeze(['syslog:event'])
    }),
    'grpc-message-log': Object.freeze({
        protocol: 'grpc',
        route: '/monitor/grpc-message-log',
        title: 'gRPC 消息监控 - NetNexus',
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 620,
        eventTypes: Object.freeze(['grpc:event', 'grpc:runtimeChanged'])
    }),
    'snmp-trap': Object.freeze({
        protocol: 'snmp',
        route: '/monitor/snmp-trap',
        title: 'SNMP Trap 监控 - NetNexus',
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 620,
        eventTypes: Object.freeze(['snmp:event'])
    }),
    'bmp-client': Object.freeze({
        protocol: 'bmp',
        route: '/monitor/bmp-client',
        title: 'BMP Client 监控 - NetNexus',
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 680,
        eventTypes: Object.freeze([
            'bmp:initiation',
            'bmp:sessionUpdate',
            'bmp:routeUpdate',
            'bmp:instanceUpdate',
            'bmp:instanceRouteUpdate',
            'bmp:statisticsReport',
            'bmp:termination'
        ])
    }),
    'netconf-edit-config': Object.freeze({
        protocol: 'netconf',
        route: '/monitor/netconf-edit-config',
        title: 'NETCONF edit-config - NetNexus',
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 680,
        eventTypes: Object.freeze(['netconf:sessionEvent'])
    }),
    'netconf-notifications': Object.freeze({
        protocol: 'netconf',
        route: '/monitor/netconf-notifications',
        title: 'NETCONF Notifications - NetNexus',
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 680,
        eventTypes: Object.freeze(['netconf:notification', 'netconf:subscriptionEvent', 'netconf:sessionEvent'])
    })
});

function normalizeNetconfMonitorIdentifier(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const hasControlCharacter = Array.from(value).some(character => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 31 || codePoint === 127;
    });
    if (
        !value ||
        /^\s+$/u.test(value) ||
        hasControlCharacter ||
        Buffer.byteLength(value, 'utf8') > MAX_NETCONF_MONITOR_IDENTIFIER_BYTES
    ) {
        return null;
    }
    return value;
}

function normalizeBmpClientKey(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const clientKey = value.trim();
    const hasControlCharacter = Array.from(clientKey).some(character => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 31 || codePoint === 127;
    });
    if (!clientKey || clientKey.length > 512 || hasControlCharacter) {
        return null;
    }
    if (/^source:[0-9a-f]{64}$/i.test(clientKey)) {
        return `source:${clientKey.slice('source:'.length).toLowerCase()}`;
    }
    if (!clientKey.startsWith('connection:')) {
        return null;
    }

    const transportParts = clientKey.slice('connection:'.length).split('|');
    if (transportParts.length !== 4 || transportParts.some(part => !part || part.length > 128)) {
        return null;
    }
    const ports = [transportParts[1], transportParts[3]].map(Number);
    if (ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) {
        return null;
    }
    return clientKey;
}

function buildBmpClientKey(client) {
    const sourceId = client?.persistentSourceId || client?.sourceId;
    if (typeof sourceId === 'string' && sourceId.trim()) {
        return `source:${sourceId.trim().toLowerCase()}`;
    }

    const transportParts = [client?.localIp, client?.localPort, client?.remoteIp, client?.remotePort];
    if (transportParts.some(value => value === null || value === undefined || String(value).length === 0)) {
        return null;
    }
    return `connection:${transportParts.map(String).join('|')}`;
}

function matchesBmpClientKey(client, clientKey) {
    if (!client || !clientKey) {
        return false;
    }
    if (clientKey.startsWith('source:')) {
        const sourceId = client.persistentSourceId || client.sourceId;
        return typeof sourceId === 'string' && `source:${sourceId.trim().toLowerCase()}` === clientKey;
    }
    if (clientKey.startsWith('connection:')) {
        const transportParts = [client.localIp, client.localPort, client.remoteIp, client.remotePort];
        return (
            transportParts.every(value => value !== null && value !== undefined && String(value).length > 0) &&
            `connection:${transportParts.map(String).join('|')}` === clientKey
        );
    }
    return false;
}

function filterBmpEventForClient(response, clientKey, eventType) {
    const payload = response?.data;
    if (eventType === 'bmp:termination' && payload === null) {
        return response;
    }
    if (!payload || typeof payload !== 'object') {
        return undefined;
    }

    const matchesClient = update => {
        return matchesBmpClientKey(update?.client, clientKey) || matchesBmpClientKey(update, clientKey);
    };

    if (payload.batch === true && Array.isArray(payload.updates)) {
        const updates = payload.updates.filter(matchesClient);
        if (updates.length === 0) {
            return undefined;
        }
        return {
            ...response,
            data: {
                ...payload,
                updates
            }
        };
    }

    return matchesClient(payload) ? response : undefined;
}

function filterNetconfEventForProfile(response, profileId) {
    const payload = response?.data;
    if (!payload || typeof payload !== 'object') {
        return undefined;
    }
    return payload.profileId === profileId ? response : undefined;
}

function resolveMonitorRequest(monitorId, rawOptions) {
    const alias =
        typeof monitorId === 'string' && Object.prototype.hasOwnProperty.call(MONITOR_ALIASES, monitorId)
            ? MONITOR_ALIASES[monitorId]
            : null;
    const resolvedMonitorId = alias?.monitorId || monitorId;
    if (
        typeof resolvedMonitorId !== 'string' ||
        !Object.prototype.hasOwnProperty.call(MONITOR_DEFINITIONS, resolvedMonitorId)
    ) {
        return { error: `不支持的监控窗口: ${String(monitorId)}` };
    }

    const options = rawOptions === undefined ? {} : rawOptions;
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return { error: '监控窗口参数无效' };
    }

    const allowedKeys = BMP_CLIENT_MONITOR_IDS.has(resolvedMonitorId)
        ? ['clientKey']
        : NETCONF_EDIT_CONFIG_MONITOR_IDS.has(resolvedMonitorId)
          ? ['profileId', 'compileId', 'nodeId', 'target']
          : [];
    if (Object.keys(options).some(key => !allowedKeys.includes(key))) {
        return { error: '监控窗口包含不支持的参数' };
    }

    const definition = MONITOR_DEFINITIONS[resolvedMonitorId];
    if (NETCONF_EDIT_CONFIG_MONITOR_IDS.has(resolvedMonitorId)) {
        const profileId = normalizeNetconfMonitorIdentifier(options.profileId);
        const compileId = normalizeNetconfMonitorIdentifier(options.compileId);
        const nodeId = normalizeNetconfMonitorIdentifier(options.nodeId);
        const target = options.target;
        if (!profileId) {
            return { error: 'NETCONF edit-config 窗口需要有效的 Profile 标识' };
        }
        if (!compileId) {
            return { error: 'NETCONF edit-config 窗口需要有效的编译标识' };
        }
        if (!nodeId) {
            return { error: 'NETCONF edit-config 窗口需要有效的 Schema 节点标识' };
        }
        if (!['candidate', 'running'].includes(target)) {
            return { error: 'NETCONF edit-config 窗口目标仅支持 candidate 或 running' };
        }

        const query = new URLSearchParams({ profileId, compileId, nodeId, target });
        return {
            definition,
            // Content Editor is a single native tool window. Its active Schema
            // context is replaced through MONITOR_CONTEXT_EVENT when reused.
            instanceKey: resolvedMonitorId,
            route: `${definition.route}?${query.toString()}`,
            subscriptionOptions: {
                transform: response => filterNetconfEventForProfile(response, profileId)
            },
            responseData: { monitorId: resolvedMonitorId, profileId, compileId, nodeId, target }
        };
    }

    if (!BMP_CLIENT_MONITOR_IDS.has(resolvedMonitorId)) {
        return {
            definition,
            instanceKey: resolvedMonitorId,
            route: definition.route,
            subscriptionOptions: undefined,
            responseData: { monitorId: resolvedMonitorId }
        };
    }

    const clientKey = normalizeBmpClientKey(options.clientKey);
    if (!clientKey) {
        return { error: 'BMP 监控窗口需要有效的 Client 标识' };
    }

    const query = new URLSearchParams({ clientKey });
    if (alias?.view) {
        query.set('view', alias.view);
    }
    return {
        definition,
        instanceKey: `${resolvedMonitorId}:${clientKey}`,
        route: `${definition.route}?${query.toString()}`,
        subscriptionOptions: {
            transform: (response, eventType) => filterBmpEventForClient(response, clientKey, eventType)
        },
        responseData: { monitorId: resolvedMonitorId, clientKey }
    };
}

function buildMonitorUrl(rendererUrl, route) {
    const baseUrl = String(rendererUrl || '').split('#')[0];
    const normalizedRoute = String(route || '').startsWith('/') ? route : `/${route}`;
    return `${baseUrl}#${normalizedRoute}`;
}

function monitorContextsEqual(currentContext, nextContext) {
    if (!currentContext || !nextContext) {
        return false;
    }
    return ['monitorId', 'profileId', 'compileId', 'nodeId', 'target'].every(
        key => currentContext[key] === nextContext[key]
    );
}

function sendMonitorContext(entry, context) {
    const target = entry?.webContents;
    if (!target || (typeof target.isDestroyed === 'function' && target.isDestroyed())) {
        return false;
    }
    try {
        target.send('unified-event', {
            type: MONITOR_CONTEXT_EVENT,
            data: context
        });
        return true;
    } catch (error) {
        logger.error(`监控窗口上下文切换失败: ${error.message}`);
        return false;
    }
}

class MonitorWindowManager {
    constructor(options = {}) {
        this.BrowserWindowClass = options.BrowserWindowClass || BrowserWindow;
        this.rendererUrl = options.rendererUrl;
        this.preloadPath = options.preloadPath || null;
        this.icon = options.icon || null;
        this.isPackagedE2e = Boolean(options.isPackagedE2e);
        this.maxWindows =
            Number.isInteger(options.maxWindows) && options.maxWindows > 0 ? options.maxWindows : MAX_MONITOR_WINDOWS;
        this.monitorWindows = new Map();
        this.ipcRegistered = false;
        const processResourceSampler =
            options.processResourceSampler ||
            new ProcessResourceSampler({
                appInstance: options.appInstance || app,
                BrowserWindowClass: this.BrowserWindowClass,
                processObject: options.processObject || process
            });
        this.processResourceSnapshotProvider =
            typeof options.processResourceSnapshotProvider === 'function'
                ? options.processResourceSnapshotProvider
                : () => processResourceSampler.getSnapshot();

        if (!this.rendererUrl) {
            throw new Error('MonitorWindowManager requires rendererUrl');
        }
    }

    registerIpcHandlers(ipcMain) {
        if (this.ipcRegistered) {
            return;
        }
        if (!ipcMain || typeof ipcMain.handle !== 'function') {
            throw new Error('MonitorWindowManager requires ipcMain.handle');
        }

        ipcMain.handle(OPEN_MONITOR_CHANNEL, (event, monitorId, options) =>
            this.handleOpenMonitor(event, monitorId, options)
        );
        ipcMain.handle(SUBSCRIBE_EVENT_SCOPE_CHANNEL, (event, scopeId) =>
            this.handleEventScopeSubscription(event, scopeId, true)
        );
        ipcMain.handle(UNSUBSCRIBE_EVENT_SCOPE_CHANNEL, (event, scopeId) =>
            this.handleEventScopeSubscription(event, scopeId, false)
        );
        ipcMain.handle(GET_PROCESS_RESOURCE_SNAPSHOT_CHANNEL, event => this.handleGetProcessResourceSnapshot(event));
        if (typeof ipcMain.on === 'function') {
            ipcMain.on(RENDERER_READY_CHANNEL, event => this.handleRendererReady(event));
        }
        this.ipcRegistered = true;
    }

    resolveSender(event) {
        const fromWebContents = this.BrowserWindowClass.fromWebContents;
        if (
            !event?.sender ||
            typeof fromWebContents !== 'function' ||
            !fromWebContents.call(this.BrowserWindowClass, event.sender)
        ) {
            return null;
        }
        return event.sender;
    }

    handleOpenMonitor(event, monitorId, options) {
        if (!this.resolveSender(event)) {
            return errorResponse('无法识别窗口来源');
        }
        return this.openMonitor(monitorId, options);
    }

    async handleGetProcessResourceSnapshot(event) {
        const sender = this.resolveSender(event);
        const resourceWindowEntry = this.monitorWindows.get('process-resource-manager');
        if (!sender || !resourceWindowEntry || resourceWindowEntry.webContents !== sender) {
            return errorResponse('无法识别窗口来源');
        }
        try {
            const snapshot = await this.processResourceSnapshotProvider();
            return successResponse(snapshot, '进程资源指标获取成功');
        } catch (error) {
            logger.error(`获取进程资源指标失败: ${error.message}`);
            return errorResponse(error.message || '进程资源指标获取失败');
        }
    }

    handleEventScopeSubscription(event, scopeId, subscribe) {
        const sender = this.resolveSender(event);
        if (!sender) {
            return errorResponse('无法识别窗口来源');
        }
        if (typeof scopeId !== 'string' || !Object.prototype.hasOwnProperty.call(EVENT_SCOPE_DEFINITIONS, scopeId)) {
            return errorResponse(`不支持的事件订阅范围: ${String(scopeId)}`);
        }

        const eventTypes = EVENT_SCOPE_DEFINITIONS[scopeId];
        if (subscribe) {
            EventDispatcher.subscribe(sender, eventTypes);
            return successResponse({ scopeId }, '事件订阅已启用');
        }
        EventDispatcher.unsubscribe(sender, eventTypes);
        return successResponse({ scopeId }, '事件订阅已取消');
    }

    handleRendererReady(event) {
        const entry = [...this.monitorWindows.values()].find(item => item.webContents === event?.sender);
        if (!entry) {
            return;
        }

        entry.rendererReady = true;
        const pendingContext = entry.pendingContext;
        entry.pendingContext = null;
        if (!pendingContext || sendMonitorContext(entry, pendingContext)) {
            return;
        }

        entry.expectedClose = true;
        entry.cleanup();
        if (!entry.window.isDestroyed()) {
            entry.window.destroy();
        }
    }

    async openMonitor(monitorId, options) {
        const request = resolveMonitorRequest(monitorId, options);
        if (request.error) {
            return errorResponse(request.error);
        }

        const { definition, instanceKey } = request;

        let existingEntry = this.monitorWindows.get(instanceKey);
        let existingWindow = existingEntry?.window;
        if (existingWindow && !existingWindow.isDestroyed()) {
            const contextChanged = !monitorContextsEqual(existingEntry.context, request.responseData);
            if (contextChanged && NETCONF_EDIT_CONFIG_MONITOR_IDS.has(request.responseData.monitorId)) {
                // Re-registering replaces the transform for this webContents/topic,
                // so Session events immediately follow the newly active Profile.
                EventDispatcher.subscribe(
                    existingEntry.webContents,
                    definition.eventTypes,
                    request.subscriptionOptions
                );
                existingEntry.profileId = request.responseData.profileId || null;
                existingEntry.context = request.responseData;

                if (existingEntry.rendererReady) {
                    if (!sendMonitorContext(existingEntry, request.responseData)) {
                        existingEntry.expectedClose = true;
                        existingEntry.cleanup();
                        if (!existingWindow.isDestroyed()) {
                            existingWindow.destroy();
                        }
                        existingEntry = null;
                        existingWindow = null;
                    }
                } else {
                    // The renderer may still be loading when the user quickly
                    // chooses a second node. Keep only the newest context and
                    // deliver it after main.js announces that Vue has mounted.
                    existingEntry.pendingContext = request.responseData;
                }
            }
        }
        if (existingWindow && !existingWindow.isDestroyed()) {
            if (existingWindow.isMinimized()) {
                existingWindow.restore();
            }
            existingWindow.show();
            existingWindow.focus();
            return successResponse({ ...request.responseData, reused: true }, '已切换到现有监控窗口');
        }
        if (this.getOpenCount() >= this.maxWindows) {
            return errorResponse(`监控窗口数量已达到上限（${this.maxWindows}）`);
        }

        const webPreferences = {
            nodeIntegration: false,
            contextIsolation: true
        };
        if (!this.isPackagedE2e && this.preloadPath) {
            webPreferences.preload = this.preloadPath;
        }

        const windowOptions = {
            width: definition.width,
            height: definition.height,
            minWidth: definition.minWidth,
            minHeight: definition.minHeight,
            title: definition.title,
            show: false,
            autoHideMenuBar: true,
            backgroundColor: '#f5f7fa',
            webPreferences
        };
        if (this.icon) {
            windowOptions.icon = this.icon;
        }

        const monitorWindow = new this.BrowserWindowClass(windowOptions);
        // BrowserWindow 销毁后再次读取 window.webContents 在部分 Electron 版本中会抛出
        // "Object has been destroyed"，因此在窗口存活时保存引用，清理阶段只使用该引用。
        const monitorWebContents = monitorWindow.webContents;
        const monitorEntry = {
            definition,
            expectedClose: false,
            monitorId,
            profileId: request.responseData.profileId || null,
            context: request.responseData,
            rendererReady: false,
            pendingContext: null,
            window: monitorWindow,
            webContents: monitorWebContents,
            cleanup: null
        };
        this.monitorWindows.set(instanceKey, monitorEntry);

        let cleaned = false;
        const cleanup = () => {
            if (cleaned) {
                return;
            }
            cleaned = true;
            EventDispatcher.unsubscribe(monitorWebContents);
            if (this.monitorWindows.get(instanceKey) === monitorEntry) {
                this.monitorWindows.delete(instanceKey);
            }
        };
        monitorEntry.cleanup = cleanup;

        monitorWindow.once('close', () => {
            monitorEntry.expectedClose = true;
            cleanup();
        });
        monitorWindow.once('closed', cleanup);
        monitorWebContents.once('render-process-gone', () => {
            const expectedClose = monitorEntry.expectedClose;
            cleanup();
            if (!expectedClose && !monitorWindow.isDestroyed()) {
                monitorWindow.destroy();
            }
        });
        monitorWindow.once('ready-to-show', () => {
            if (!monitorWindow.isDestroyed()) {
                monitorWindow.show();
                monitorWindow.focus();
            }
        });

        // 先建立订阅再开始导航，使 renderer 注册全局监听和执行首次快照查询期间
        // 到达的增量事件不会落入 loadURL 完成后的订阅空窗。
        EventDispatcher.subscribe(monitorWebContents, definition.eventTypes, request.subscriptionOptions);

        const monitorUrl = buildMonitorUrl(this.rendererUrl, request.route);
        try {
            await monitorWindow.loadURL(monitorUrl);
        } catch (error) {
            cleanup();
            if (monitorEntry.expectedClose) {
                return successResponse({ ...request.responseData, reused: false, closed: true }, '监控窗口已关闭');
            }
            if (!monitorWindow.isDestroyed()) {
                monitorWindow.destroy();
            }
            logger.error(`监控窗口加载失败: ${error.message}`);
            return errorResponse(`监控窗口加载失败: ${error.message}`);
        }

        if (monitorWindow.isDestroyed() || this.monitorWindows.get(instanceKey) !== monitorEntry) {
            cleanup();
            if (monitorEntry.expectedClose) {
                return successResponse({ ...request.responseData, reused: false, closed: true }, '监控窗口已关闭');
            }
            return errorResponse('监控窗口在加载完成前异常关闭');
        }

        return successResponse({ ...request.responseData, reused: false }, '监控窗口已打开');
    }

    closeMatching(predicate) {
        let closedCount = 0;
        [...this.monitorWindows.values()].forEach(entry => {
            if (!predicate(entry)) {
                return;
            }

            // 先移出注册表和事件订阅，再销毁窗口，避免 closed/render-process-gone
            // 回调与批量关闭流程重复操作同一个窗口。
            entry.expectedClose = true;
            entry.cleanup();
            if (!entry.window.isDestroyed()) {
                entry.window.destroy();
            }
            closedCount += 1;
        });
        return closedCount;
    }

    closeByProtocol(protocol) {
        const normalizedProtocol = typeof protocol === 'string' ? protocol.trim().toLowerCase() : '';
        if (!normalizedProtocol) {
            return 0;
        }
        return this.closeMatching(entry => entry.definition.protocol === normalizedProtocol);
    }

    closeByProtocolProfile(protocol, profileId) {
        const normalizedProtocol = typeof protocol === 'string' ? protocol.trim().toLowerCase() : '';
        const normalizedProfileId = normalizeNetconfMonitorIdentifier(profileId);
        if (!normalizedProtocol || !normalizedProfileId) {
            return 0;
        }
        return this.closeMatching(
            entry => entry.definition.protocol === normalizedProtocol && entry.profileId === normalizedProfileId
        );
    }

    closeAll() {
        return this.closeMatching(() => true);
    }

    getOpenCount() {
        return [...this.monitorWindows.values()].filter(entry => !entry.window.isDestroyed()).length;
    }
}

module.exports = {
    MonitorWindowManager,
    EVENT_SCOPE_DEFINITIONS,
    GET_PROCESS_RESOURCE_SNAPSHOT_CHANNEL,
    MAX_MONITOR_WINDOWS,
    MAX_NETCONF_MONITOR_IDENTIFIER_BYTES,
    MONITOR_CONTEXT_EVENT,
    MONITOR_DEFINITIONS,
    OPEN_MONITOR_CHANNEL,
    RENDERER_READY_CHANNEL,
    SUBSCRIBE_EVENT_SCOPE_CHANNEL,
    UNSUBSCRIBE_EVENT_SCOPE_CHANNEL,
    buildMonitorUrl,
    buildBmpClientKey,
    filterBmpEventForClient,
    filterNetconfEventForProfile,
    matchesBmpClientKey,
    monitorContextsEqual,
    normalizeBmpClientKey,
    normalizeNetconfMonitorIdentifier,
    resolveMonitorRequest
};
