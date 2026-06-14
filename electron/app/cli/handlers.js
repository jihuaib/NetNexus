const BgpConst = require('../../const/bgpConst');
const BmpConst = require('../../const/bmpConst');
const { DEFAULT_API_SETTINGS } = require('../../const/apiConst');
const { CliCommandError } = require('./errors');
const {
    formatDate,
    formatJson,
    formatPrefix,
    formatTable
} = require('./formatters');

const BGP_ADDR_FAMILY_VALUES = new Set(Object.values(BgpConst.BGP_ADDR_FAMILY));
const BMP_RIB_TYPE_VALUES = new Set(Object.values(BmpConst.BMP_BGP_RIB_TYPE));
const BGP_ADDR_FAMILY_KEYWORDS = buildKeywordMap(BgpConst.BGP_ADDR_FAMILY);
const BMP_RIB_TYPE_KEYWORDS = buildKeywordMap(BmpConst.BMP_BGP_RIB_TYPE);
const BMP_ROUTE_STATE_KEYWORDS = buildKeywordMap(BmpConst.BMP_ROUTE_STATE_FILTER);
const BGP_ADDR_FAMILY_LABELS = invertKeywordMap(BGP_ADDR_FAMILY_KEYWORDS);
const BMP_RIB_TYPE_LABELS = invertKeywordMap(BMP_RIB_TYPE_KEYWORDS);
const BMP_ROUTE_PAGE_SIZE = 25;

class CliHandlers {
    constructor(server) {
        this.server = server;
        this.handlers = new Map();
        this.registerHandlers();
    }

    registerHandlers() {
        [
            'showCliCommandInfo',
            'showCliHistory',
            'showCliClient',
            'enterConfig',
            'end',
            'exit',
            'terminalLengthDisable',
            'terminalLengthDefault',
            'showApiStatus',
            'showBmpStatus',
            'showBmpClients',
            'showBmpSessions',
            'showBmpInstances',
            'showBmpRoutes',
            'showBmpInstanceRoutes',
            'showBmpSessionStatistics',
            'showBmpInstanceStatistics'
        ].forEach(name => this.handlers.set(name, this[name].bind(this)));
    }

    async dispatch(session, match) {
        const handler = this.handlers.get(match.command.handler);
        if (!handler) {
            throw new CliCommandError(`No handler registered: ${match.command.handler}`);
        }
        await handler(session, match.args, match);
    }

    showCliCommandInfo(session) {
        session.write(
            formatTable(this.server.tree.collectCommandRows(), [
                { key: 'view', title: 'View' },
                { key: 'id', title: 'Id' },
                { key: 'handler', title: 'Handler' },
                { key: 'command', title: 'Command' }
            ])
        );
    }

    showCliHistory(session) {
        const rows = this.server.globalHistory.slice(-50).map((item, index) => ({
            '#': index + 1,
            line: item.lineId,
            peer: item.peer,
            time: formatDate(item.time),
            command: item.command
        }));
        session.write(
            formatTable(rows, [
                { key: '#', title: '#' },
                { key: 'line', title: 'Line' },
                { key: 'peer', title: 'Peer' },
                { key: 'time', title: 'Time' },
                { key: 'command', title: 'Command' }
            ])
        );
    }

    showCliClient(session) {
        session.write(this.server.formatSessions());
    }

    enterConfig() {}

    end() {}

    exit(session) {
        if (session.view !== 'user') {
            session.view = 'user';
            session.context.clear();
            return;
        }
        session.close();
    }

    terminalLengthDisable(session) {
        session.terminalLength = 0;
        session.writeLine('Terminal length is disabled.');
    }

    terminalLengthDefault(session) {
        session.terminalLength = 24;
        session.writeLine('Terminal length is 24.');
    }

    showApiStatus(session) {
        const apiStatus = this.server.externalApiServer
            ? this.server.externalApiServer.getStatus()
            : { running: false, enabled: false, host: DEFAULT_API_SETTINGS.host, port: DEFAULT_API_SETTINGS.port };
        session.write(
            formatTable(
                [
                    {
                        service: 'HTTP API',
                        running: apiStatus.running,
                        listen: `${apiStatus.host}:${apiStatus.port}`,
                        enabled: apiStatus.enabled
                    },
                    {
                        service: 'Telnet CLI',
                        running: this.server.getRunning(),
                        listen: `${this.server.settings.host}:${this.server.settings.port}`,
                        enabled: this.server.getRunning()
                    }
                ],
                [
                    { key: 'service', title: 'Service' },
                    { key: 'running', title: 'Running' },
                    { key: 'listen', title: 'Listen' },
                    { key: 'enabled', title: 'Enabled' }
                ]
            )
        );
    }

    showBmpStatus(session) {
        session.writeLine(`BMP running: ${this.server.bmpApp && this.server.bmpApp.getBmpRunning() ? 'true' : 'false'}`);
    }

    async showBmpClients(session, args, match) {
        if (args.clientId) {
            const client = await this.resolveClient(session, args.clientId);
            session.write(isVerboseCommand(match) ? formatJson(client) : this.formatClientList([client]));
            return;
        }
        session.write(this.formatClientList(this.assignClientIds(session, await this.queryClients())));
    }

    async showBmpSessions(session, args, match) {
        if (args.sessionId) {
            const { session: bmpSession } = await this.resolveSession(session, args.clientId, args.sessionId);
            session.write(isVerboseCommand(match) ? formatJson(bmpSession) : this.formatSessionList([bmpSession]));
            return;
        }
        const client = await this.resolveClient(session, args.clientId);
        session.write(this.formatSessionList(await this.querySessionRows(session, client)));
    }

    async showBmpInstances(session, args, match) {
        if (args.instanceId) {
            const { instance } = await this.resolveInstance(session, args.clientId, args.instanceId);
            session.write(isVerboseCommand(match) ? formatJson(instance) : this.formatInstanceList([instance]));
            return;
        }
        const client = await this.resolveClient(session, args.clientId);
        session.write(this.formatInstanceList(await this.queryInstanceRows(session, client)));
    }

    async showBmpRoutes(session, args, match) {
        const { client, session: bmpSession } = await this.resolveSession(session, args.clientId, args.sessionId);
        const af = parseAfKeyword(args.af);
        const ribType = parseRibTypeKeyword(args.ribType);
        validateAfAndRib(af, ribType);

        if (args.routeKey) {
            const routeKey = parseRouteKeyArg(args.routeKey);
            const route = await this.queryBmp(() =>
                this.server.bmpApp.queryBgpRouteDetail({
                    client,
                    session: bmpSession,
                    af,
                    ribType,
                    routeKey,
                    includeSummary: isVerboseCommand(match)
                })
            );
            const normalizedRoute = normalizeRouteForCli(route);
            session.write(isVerboseCommand(match) ? formatJson(normalizedRoute) : this.formatSingleRoute(normalizedRoute));
            return;
        }

        await this.writePagedRouteList(session, (page, pageSize) =>
            this.queryBmp(() =>
                this.server.bmpApp.queryBgpRoutes({
                    client,
                    session: bmpSession,
                    af,
                    ribType,
                    ...getRouteOptions(args, page, pageSize)
                })
            )
        );
    }

    async showBmpInstanceRoutes(session, args, match) {
        const { client, instance } = await this.resolveInstance(session, args.clientId, args.instanceId);

        if (args.routeKey) {
            const routeKey = parseRouteKeyArg(args.routeKey);
            const route = await this.queryBmp(() =>
                this.server.bmpApp.queryBgpInstanceRouteDetail({
                    client,
                    instance,
                    routeKey,
                    includeSummary: isVerboseCommand(match)
                })
            );
            const normalizedRoute = normalizeRouteForCli(route);
            session.write(isVerboseCommand(match) ? formatJson(normalizedRoute) : this.formatSingleRoute(normalizedRoute));
            return;
        }

        await this.writePagedRouteList(session, (page, pageSize) =>
            this.queryBmp(() =>
                this.server.bmpApp.queryBgpInstanceRoutes({
                    client,
                    instance,
                    ...getRouteOptions(args, page, pageSize)
                })
            )
        );
    }

    async showBmpSessionStatistics(session, args, match) {
        if (args.reportId) {
            const report = await this.resolveSessionStatisticsReport(session, args.clientId, args.reportId);
            session.write(isVerboseCommand(match) ? formatJson(report) : this.formatSessionStatisticsList([report]));
            return;
        }
        const client = await this.resolveClient(session, args.clientId);
        session.write(this.formatSessionStatisticsList(await this.querySessionStatisticsRows(session, client)));
    }

    async showBmpInstanceStatistics(session, args, match) {
        if (args.reportId) {
            const report = await this.resolveInstanceStatisticsReport(session, args.clientId, args.reportId);
            session.write(isVerboseCommand(match) ? formatJson(report) : this.formatInstanceStatisticsList([report]));
            return;
        }
        const client = await this.resolveClient(session, args.clientId);
        session.write(this.formatInstanceStatisticsList(await this.queryInstanceStatisticsRows(session, client)));
    }

    async queryBmp(query) {
        if (!this.server.bmpApp || !this.server.bmpApp.getBmpRunning()) {
            throw new CliCommandError('BMP未启动');
        }

        const result = await query();
        if (!result || result.status !== 'success') {
            throw new CliCommandError((result && result.msg) || 'BMP查询失败');
        }
        if (result.msg === 'BMP未启动') {
            throw new CliCommandError('BMP未启动');
        }
        return result.data;
    }

    async queryClients() {
        return this.queryBmp(() => this.server.bmpApp.queryClientList());
    }

    assignClientIds(session, clients) {
        return assignTemporaryIds(session.bmpIds.client, clients, getClientKey);
    }

    async resolveClient(session, clientId) {
        const clients = this.assignClientIds(session, await this.queryClients());
        const client = clients.find(item => String(item.__cliId) === String(clientId));
        if (!client) {
            throw new CliCommandError(`client-id ${clientId}不存在，请先执行 show bmp client`);
        }
        return client;
    }

    async querySessionRows(session, client) {
        const store = getChildIdStore(session.bmpIds.session, getClientKey(client));
        const sessions = await this.queryBmp(() => this.server.bmpApp.queryBgpSessions(client));
        return assignTemporaryIds(store, sessions, getSessionKey);
    }

    async queryInstanceRows(session, client) {
        const store = getChildIdStore(session.bmpIds.instance, getClientKey(client));
        const instances = await this.queryBmp(() => this.server.bmpApp.queryBgpInstances(client));
        return assignTemporaryIds(store, instances, getInstanceKey);
    }

    async querySessionStatisticsRows(session, client) {
        const store = getChildIdStore(session.bmpIds.sessionStatistics, getClientKey(client));
        const reports = await this.queryBmp(() => this.server.bmpApp.queryBgpStatisticsReports(client));
        return assignTemporaryIds(store, reports, getSessionStatisticsKey);
    }

    async queryInstanceStatisticsRows(session, client) {
        const store = getChildIdStore(session.bmpIds.instanceStatistics, getClientKey(client));
        const reports = await this.queryBmp(() => this.server.bmpApp.queryBgpInstanceStatisticsReports(client));
        return assignTemporaryIds(store, reports, getInstanceStatisticsKey);
    }

    async resolveSession(session, clientId, sessionId) {
        const client = await this.resolveClient(session, clientId);
        const sessions = await this.querySessionRows(session, client);
        const bmpSession = sessions.find(item => String(item.__cliId) === String(sessionId));
        if (!bmpSession) {
            throw new CliCommandError(`session-id ${sessionId}不存在，请先执行 show bmp session client-id ${clientId}`);
        }
        return { client, session: bmpSession };
    }

    async resolveInstance(session, clientId, instanceId) {
        const client = await this.resolveClient(session, clientId);
        const instances = await this.queryInstanceRows(session, client);
        const instance = instances.find(item => String(item.__cliId) === String(instanceId));
        if (!instance) {
            throw new CliCommandError(`instance-id ${instanceId}不存在，请先执行 show bmp instance client-id ${clientId}`);
        }
        return { client, instance };
    }

    async resolveSessionStatisticsReport(session, clientId, reportId) {
        const client = await this.resolveClient(session, clientId);
        const reports = await this.querySessionStatisticsRows(session, client);
        const report = reports.find(item => String(item.__cliId) === String(reportId));
        if (!report) {
            throw new CliCommandError(`report-id ${reportId}不存在，请先执行 show bmp statistic session client-id ${clientId}`);
        }
        return report;
    }

    async resolveInstanceStatisticsReport(session, clientId, reportId) {
        const client = await this.resolveClient(session, clientId);
        const reports = await this.queryInstanceStatisticsRows(session, client);
        const report = reports.find(item => String(item.__cliId) === String(reportId));
        if (!report) {
            throw new CliCommandError(`report-id ${reportId}不存在，请先执行 show bmp statistic instance client-id ${clientId}`);
        }
        return report;
    }

    formatClientList(clients) {
        return formatTable(clients, [
            { key: '__cliId', title: 'ID' },
            { key: 'sysName', title: 'SysName' },
            { key: 'local', title: 'Local', formatter: row => `${row.localIp || '-'}:${row.localPort || '-'}` },
            { key: 'remote', title: 'Remote', formatter: row => `${row.remoteIp || '-'}:${row.remotePort || '-'}` }
        ]);
    }

    formatSessionList(sessions) {
        return formatTable(sessions, [
            { key: '__cliId', title: 'ID' },
            { key: 'sessionIp', title: 'PeerIP' },
            { key: 'sessionAs', title: 'PeerAS' },
            { key: 'sessionState', title: 'State' },
            {
                key: 'enabledAddrFamilyTypes',
                title: 'AFs',
                formatter: row => formatKeywordArray(row.enabledAddrFamilyTypes, BGP_ADDR_FAMILY_LABELS)
            },
            { key: 'ribTypes', title: 'RIBs', formatter: row => formatKeywordArray(row.ribTypes, BMP_RIB_TYPE_LABELS) }
        ]);
    }

    formatInstanceList(instances) {
        return formatTable(instances, [
            { key: '__cliId', title: 'ID' },
            { key: 'instanceRd', title: 'RD' },
            { key: 'addrFamilyType', title: 'AF', formatter: row => formatKeyword(row.addrFamilyType, BGP_ADDR_FAMILY_LABELS) },
            { key: 'instanceIp', title: 'PeerIP' },
            { key: 'instanceAs', title: 'PeerAS' },
            { key: 'instanceState', title: 'State' },
            { key: 'ribTypes', title: 'RIBs', formatter: row => formatKeywordArray(row.ribTypes, BMP_RIB_TYPE_LABELS) }
        ]);
    }

    formatSessionStatisticsList(reports) {
        return formatTable(reports, [
            { key: '__cliId', title: 'ID' },
            { key: 'peer', title: 'Peer', formatter: row => `${row.session?.sessionIp || '-'} AS ${row.session?.sessionAs || '-'}` },
            { key: 'statistics', title: 'Stats', formatter: row => (Array.isArray(row.statistics) ? row.statistics.length : 0) },
            { key: 'tlvs', title: 'TLVs', formatter: row => (Array.isArray(row.tlvs) ? row.tlvs.length : 0) },
            { key: 'updatedAt', title: 'UpdatedAt' }
        ]);
    }

    formatInstanceStatisticsList(reports) {
        return formatTable(reports, [
            { key: '__cliId', title: 'ID' },
            { key: 'instance', title: 'Instance', formatter: row => `${row.instance?.instanceType ?? '-'} ${row.instance?.instanceRd || '-'}` },
            { key: 'statistics', title: 'Stats', formatter: row => (Array.isArray(row.statistics) ? row.statistics.length : 0) },
            { key: 'tlvs', title: 'TLVs', formatter: row => (Array.isArray(row.tlvs) ? row.tlvs.length : 0) },
            { key: 'updatedAt', title: 'UpdatedAt' }
        ]);
    }

    async writePagedRouteList(session, fetchPage) {
        const pager = {
            page: 0,
            pageSize: BMP_ROUTE_PAGE_SIZE,
            displayed: 0,
            total: 0,
            continue: null
        };

        if (session.terminalLength === 0) {
            let hasMore = true;
            while (hasMore && !session.closed) {
                hasMore = await this.writeRoutePage(session, fetchPage, pager, false);
            }
            session.pager = null;
            return;
        }

        pager.continue = async () => this.writeRoutePage(session, fetchPage, pager);
        await pager.continue();
    }

    async writeRoutePage(session, fetchPage, pager, interactive = true) {
        const page = pager.page + 1;
        const result = await fetchPage(page, pager.pageSize);
        const list = Array.isArray(result && result.list) ? result.list : [];
        const total = Number(result && result.total) || 0;
        const displayed = Math.min(total || page * pager.pageSize, (page - 1) * pager.pageSize + list.length);
        const hasMore = list.length > 0 && displayed < total;

        pager.page = page;
        pager.total = total;
        pager.displayed = displayed;
        session.write(this.formatRouteList(result, { page, pageSize: pager.pageSize, displayed }));

        if (hasMore && interactive) {
            session.pager = pager;
            session.write(`--More-- ${displayed}/${total} (Space/Enter: next, q: quit)`);
            return true;
        }

        session.pager = null;
        return hasMore;
    }

    formatRouteList(result, pageInfo = {}) {
        const list = Array.isArray(result && result.list) ? result.list.map(normalizeRouteForCli) : [];
        const total = Number(result && result.total) || 0;
        let output = `Page: ${pageInfo.page || 1}, PageSize: ${pageInfo.pageSize || BMP_ROUTE_PAGE_SIZE}, Total: ${total}, Displayed: ${pageInfo.displayed ?? list.length}\r\n`;
        if (result && result.summary) {
            output += `Summary: ${JSON.stringify(result.summary)}\r\n`;
        }
        output += '\r\n';
        output += formatTable(list, [
            { key: 'routeState', title: 'State' },
            { key: 'addrFamilyType', title: 'AF', formatter: row => formatKeyword(row.addrFamilyType, BGP_ADDR_FAMILY_LABELS) },
            { key: 'prefix', title: 'Prefix', formatter: row => formatPrefix(row) },
            { key: 'rd', title: 'RD' },
            { key: 'nextHop', title: 'NextHop' },
            { key: 'routeKey', title: 'RouteKey' }
        ]);
        return output;
    }

    formatSingleRoute(route) {
        return this.formatRouteList(
            {
                list: route ? [route] : [],
                total: route ? 1 : 0
            },
            {
                page: 1,
                pageSize: 1,
                displayed: route ? 1 : 0
            }
        );
    }
}

function isVerboseCommand(match) {
    return String(match?.command?.id || '').endsWith('-verbose');
}

function parseRouteKeyArg(routeKey) {
    const text = String(routeKey);
    if (/^null\|/iu.test(text)) {
        throw new CliCommandError('route-key path-id must use 0 instead of null.');
    }
    return normalizeRouteKey(text);
}

function normalizeRouteForCli(route) {
    if (!route || typeof route !== 'object') {
        return route;
    }

    const next = { ...route };
    if (next.routeKey) {
        next.routeKey = normalizeRouteKey(next.routeKey);
    } else if (next.ip !== undefined && next.mask !== undefined) {
        next.routeKey = `${normalizeRoutePathId(next.pathId)}|${normalizeRouteRd(next.rd)}|${next.ip}|${next.mask}`;
    }
    next.pathId = normalizeRoutePathId(next.pathId);
    next.rd = normalizeRouteRd(next.rd);
    return next;
}

function normalizeRouteKey(routeKey) {
    const parts = String(routeKey).split('|');
    if (parts.length >= 4 && /^null$/iu.test(parts[0])) {
        parts[0] = '0';
        return parts.join('|');
    }
    return String(routeKey);
}

function normalizeRoutePathId(pathId) {
    if (pathId === null || pathId === undefined || pathId === '') {
        return 0;
    }
    const numericPathId = Number(pathId);
    return Number.isInteger(numericPathId) ? numericPathId : 0;
}

function normalizeRouteRd(rd) {
    if (rd === null || rd === undefined || rd === '') {
        return '0:0';
    }
    return String(rd);
}

function getChildIdStore(map, parentKey) {
    const key = String(parentKey || '');
    if (!map.has(key)) {
        map.set(key, {
            nextId: 1,
            keyToId: new Map(),
            idToValue: new Map()
        });
    }
    return map.get(key);
}

function assignTemporaryIds(store, rows, keyFn) {
    return (Array.isArray(rows) ? rows : []).map(row => {
        const key = keyFn(row);
        let id = store.keyToId.get(key);
        if (!id) {
            id = store.nextId;
            store.nextId += 1;
            store.keyToId.set(key, id);
        }
        const value = {
            __cliId: id,
            ...row
        };
        store.idToValue.set(String(id), value);
        return value;
    });
}

function joinKeyParts(parts) {
    return parts.map(part => String(part ?? '')).join('|');
}

function getClientKey(client) {
    return joinKeyParts([client.localIp, client.localPort, client.remoteIp, client.remotePort]);
}

function getSessionKey(session) {
    return joinKeyParts([session.sessionType, session.sessionRd, session.sessionIp, session.sessionAs]);
}

function getInstanceKey(instance) {
    return joinKeyParts([instance.instanceType, instance.instanceRd, instance.addrFamilyType]);
}

function getSessionStatisticsKey(report) {
    return report && report.session ? getSessionKey(report.session) : joinKeyParts([report.updatedAt, 'session']);
}

function getInstanceStatisticsKey(report) {
    if (report && report.instance) {
        return joinKeyParts([report.instance.instanceType, report.instance.instanceRd]);
    }
    return joinKeyParts([report.updatedAt, 'instance']);
}

function buildKeywordMap(source) {
    return new Map(
        Object.entries(source).map(([key, value]) => [
            key.toLowerCase().replace(/_/gu, '-'),
            value
        ])
    );
}

function invertKeywordMap(keywordMap) {
    const labels = new Map();
    keywordMap.forEach((value, keyword) => {
        labels.set(String(value), keyword);
    });
    return labels;
}

function normalizeKeyword(value) {
    return String(value ?? '').trim().toLowerCase();
}

function parseKeywordValue(value, keywordMap, name) {
    const keyword = normalizeKeyword(value);
    if (keywordMap.has(keyword)) {
        return keywordMap.get(keyword);
    }

    throw new CliCommandError(`${name}必须是${Array.from(keywordMap.keys()).join('|')}`);
}

function parseAfKeyword(value) {
    return parseKeywordValue(value, BGP_ADDR_FAMILY_KEYWORDS, 'af');
}

function parseRibTypeKeyword(value) {
    return parseKeywordValue(value, BMP_RIB_TYPE_KEYWORDS, 'rib');
}

function parseRouteStateKeyword(value) {
    if (!value) {
        return BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE;
    }
    const keyword = normalizeKeyword(value);
    if (!BMP_ROUTE_STATE_KEYWORDS.has(keyword)) {
        throw new CliCommandError(`state必须是${Array.from(BMP_ROUTE_STATE_KEYWORDS.keys()).join('|')}`);
    }
    return BMP_ROUTE_STATE_KEYWORDS.get(keyword);
}

function formatKeyword(value, labels) {
    if (value === null || value === undefined || value === '') {
        return '-';
    }
    return labels.get(String(value)) || String(value);
}

function formatKeywordArray(value, labels) {
    return Array.isArray(value) ? value.map(item => formatKeyword(item, labels)).join(',') : '-';
}

function getRouteOptions(args, page = 1, pageSize = BMP_ROUTE_PAGE_SIZE) {
    return {
        page,
        pageSize,
        routeState: parseRouteStateKeyword(args.routeState),
        prefixFilter: args.prefixFilter || ''
    };
}

function validateAfAndRib(af, ribType) {
    if (!BGP_ADDR_FAMILY_VALUES.has(af)) {
        throw new CliCommandError(`af ${af}不支持`);
    }
    if (!BMP_RIB_TYPE_VALUES.has(ribType)) {
        throw new CliCommandError(`rib ${ribType}不支持`);
    }
}

module.exports = CliHandlers;
