const assert = require('assert');

const CliAccessServer = require('../../electron/app/cli/cliAccessServer');
const BgpConst = require('../../electron/const/bgpConst');
const BmpConst = require('../../electron/const/bmpConst');

const mockClient = {
    localIp: '127.0.0.1',
    localPort: 11019,
    remoteIp: '127.0.0.1',
    remotePort: 50000,
    sysName: 'ci-router',
    sysDesc: 'mock bmp client',
    bmpVersion: 4,
    extraClient: 'client verbose field'
};

const mockSession = {
    sessionType: 0,
    sessionRd: '0:0',
    sessionIp: '192.0.2.1',
    sessionAs: 65001,
    sessionRouterId: '192.0.2.254',
    sessionState: 'up',
    enabledAddrFamilyTypes: [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC],
    ribTypes: [BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN],
    extraSession: 'session verbose field'
};

const mockInstance = {
    instanceType: 0,
    instanceRd: '0:0',
    addrFamilyType: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
    instanceIp: '192.0.2.1',
    instanceAs: 65001,
    instanceRouterId: '192.0.2.254',
    instanceState: 'up',
    ribTypes: [BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN],
    extraInstance: 'instance verbose field'
};

const mockRoute = {
    routeKey: '0|0:0|203.0.113.0|24',
    addrFamilyType: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
    afi: 1,
    safi: 1,
    pathId: 0,
    ip: '203.0.113.0',
    mask: 24,
    rd: '0:0',
    origin: 'IGP',
    asPath: '65001 65002',
    med: 0,
    nextHop: '192.0.2.254',
    localPref: 100,
    nlriDetail: {
        prefix: '203.0.113.0/24',
        pathId: 0,
        rawNlri: '18cb0071'
    },
    routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE,
    extraRoute: 'route verbose field'
};

function createPagedRoutes(count) {
    return Array.from({ length: count }, (_, index) => ({
        ...mockRoute,
        routeKey: `0|0:0|203.0.113.${index}|24`,
        ip: `203.0.113.${index}`,
        pathId: index
    }));
}

const mockSessionReport = {
    session: mockSession,
    statistics: [{ type: 0, value: 1 }],
    tlvs: [{ type: 1, value: 'ci' }],
    updatedAt: '2026-06-14T00:00:00.000Z',
    extraReport: 'session statistics verbose field'
};

const mockInstanceReport = {
    instance: mockInstance,
    statistics: [{ type: 0, value: 1 }],
    tlvs: [{ type: 1, value: 'ci' }],
    updatedAt: '2026-06-14T00:00:00.000Z',
    extraReport: 'instance statistics verbose field'
};

const commandCases = [
    { id: 'show-cli-command-info', input: 'show cli command-info', includes: ['show-bmp-route-session', 'verbose'] },
    { id: 'show-cli-history', input: 'show cli history', includes: ['seed command'] },
    { id: 'show-cli-client', input: 'show cli client', includes: ['127.0.0.1:3788'] },
    { id: 'config', input: 'config', view: 'config' },
    { id: 'end', input: 'end', view: 'user' },
    { id: 'terminal-length-disable', input: 'terminal length 0', includes: ['Terminal length is disabled'] },
    { id: 'terminal-length-default', input: 'no terminal length 0', includes: ['Terminal length is 24'] },
    { id: 'show-api-status', input: 'show api status', includes: ['HTTP API', 'Telnet CLI'] },
    { id: 'show-bmp-status', input: 'show bmp status', includes: ['BMP running: true'] },
    { id: 'show-bmp-client', input: 'show bmp client', includes: ['ci-router'], excludes: ['extraClient'] },
    {
        id: 'show-bmp-client-filter',
        input: 'show bmp client client-id 1',
        includes: ['ci-router'],
        excludes: ['extraClient']
    },
    {
        id: 'show-bmp-client-verbose',
        input: 'show bmp client client-id 1 verbose',
        includes: ['extraClient', 'client verbose field']
    },
    {
        id: 'show-bmp-session',
        input: 'show bmp session client-id 1',
        includes: ['PeerIP', 'ipv4-unc', 'adj-rib-in'],
        excludes: ['extraSession']
    },
    {
        id: 'show-bmp-session-filter',
        input: 'show bmp session client-id 1 session-id 1',
        includes: ['PeerIP', 'ipv4-unc', 'adj-rib-in'],
        excludes: ['extraSession']
    },
    {
        id: 'show-bmp-session-verbose',
        input: 'show bmp session client-id 1 session-id 1 verbose',
        includes: ['extraSession', 'session verbose field']
    },
    {
        id: 'show-bmp-instance',
        input: 'show bmp instance client-id 1',
        includes: ['ipv4-unc', 'adj-rib-in'],
        excludes: ['extraInstance']
    },
    {
        id: 'show-bmp-instance-filter',
        input: 'show bmp instance client-id 1 instance-id 1',
        includes: ['ipv4-unc', 'adj-rib-in'],
        excludes: ['extraInstance']
    },
    {
        id: 'show-bmp-instance-verbose',
        input: 'show bmp instance client-id 1 instance-id 1 verbose',
        includes: ['extraInstance', 'instance verbose field']
    },
    {
        id: 'show-bmp-route-session',
        input: 'show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in',
        includes: ['RouteKey', mockRoute.routeKey, 'ipv4-unc'],
        excludes: ['extraRoute', 'null|0:0']
    },
    {
        id: 'show-bmp-route-session',
        input: 'show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in state all',
        includes: ['RouteKey', mockRoute.routeKey, 'ipv4-unc'],
        excludes: ['extraRoute', 'null|0:0']
    },
    {
        id: 'show-bmp-route-session',
        input: 'show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in prefix 203.0.113.0/24',
        includes: ['RouteKey', mockRoute.routeKey, 'ipv4-unc'],
        excludes: ['extraRoute', 'null|0:0']
    },
    {
        id: 'show-bmp-route-session',
        input: 'show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in state all prefix 203.0.113.0/24',
        includes: ['RouteKey', mockRoute.routeKey, 'ipv4-unc'],
        excludes: ['extraRoute', 'null|0:0']
    },
    {
        id: 'show-bmp-route-session-key',
        input: `show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in route-key ${mockRoute.routeKey}`,
        includes: ['RouteKey', mockRoute.routeKey, 'ipv4-unc'],
        excludes: ['extraRoute', 'localPref', 'null|0:0']
    },
    {
        id: 'show-bmp-route-session-key-verbose',
        input: `show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in route-key ${mockRoute.routeKey} verbose`,
        includes: ['extraRoute', 'route verbose field', 'localPref', 'nlriDetail', mockRoute.routeKey],
        excludes: ['null|0:0']
    },
    {
        id: 'show-bmp-route-instance',
        input: 'show bmp route client-id 1 instance-id 1',
        includes: ['RouteKey', mockRoute.routeKey, 'ipv4-unc'],
        excludes: ['extraRoute', 'null|0:0']
    },
    {
        id: 'show-bmp-route-instance',
        input: 'show bmp route client-id 1 instance-id 1 state all',
        includes: ['RouteKey', mockRoute.routeKey, 'ipv4-unc'],
        excludes: ['extraRoute', 'null|0:0']
    },
    {
        id: 'show-bmp-route-instance',
        input: 'show bmp route client-id 1 instance-id 1 prefix 203.0.113.0/24',
        includes: ['RouteKey', mockRoute.routeKey, 'ipv4-unc'],
        excludes: ['extraRoute', 'null|0:0']
    },
    {
        id: 'show-bmp-route-instance',
        input: 'show bmp route client-id 1 instance-id 1 state all prefix 203.0.113.0/24',
        includes: ['RouteKey', mockRoute.routeKey, 'ipv4-unc'],
        excludes: ['extraRoute', 'null|0:0']
    },
    {
        id: 'show-bmp-route-instance-key',
        input: `show bmp route client-id 1 instance-id 1 route-key ${mockRoute.routeKey}`,
        includes: ['RouteKey', mockRoute.routeKey, 'ipv4-unc'],
        excludes: ['extraRoute', 'localPref', 'null|0:0']
    },
    {
        id: 'show-bmp-route-instance-key-verbose',
        input: `show bmp route client-id 1 instance-id 1 route-key ${mockRoute.routeKey} verbose`,
        includes: ['extraRoute', 'route verbose field', 'localPref', 'nlriDetail', mockRoute.routeKey],
        excludes: ['null|0:0']
    },
    {
        id: 'show-bmp-statistic-session',
        input: 'show bmp statistic session client-id 1',
        includes: ['Stats', 'TLVs'],
        excludes: ['extraReport']
    },
    {
        id: 'show-bmp-statistic-session-filter',
        input: 'show bmp statistic session client-id 1 report-id 1',
        includes: ['Stats', 'TLVs'],
        excludes: ['extraReport']
    },
    {
        id: 'show-bmp-statistic-session-verbose',
        input: 'show bmp statistic session client-id 1 report-id 1 verbose',
        includes: ['extraReport', 'session statistics verbose field']
    },
    {
        id: 'show-bmp-statistic-instance',
        input: 'show bmp statistic instance client-id 1',
        includes: ['Stats', 'TLVs'],
        excludes: ['extraReport']
    },
    {
        id: 'show-bmp-statistic-instance-filter',
        input: 'show bmp statistic instance client-id 1 report-id 1',
        includes: ['Stats', 'TLVs'],
        excludes: ['extraReport']
    },
    {
        id: 'show-bmp-statistic-instance-verbose',
        input: 'show bmp statistic instance client-id 1 report-id 1 verbose',
        includes: ['extraReport', 'instance statistics verbose field']
    },
    {
        id: null,
        input: 'show bmp route client-id 1 session-id 1 af 1 rib 1',
        includes: ['Error: Invalid command.']
    },
    {
        id: null,
        input: 'show bmp routes client-id 1 session-id 1 af ipv4-unc rib adj-rib-in',
        includes: ['Error: Invalid command.']
    },
    {
        id: null,
        input: 'show bmp route client id 1 session id 1 af ipv4-unc rib adj-rib-in',
        includes: ['Error: Invalid command.']
    },
    {
        id: null,
        input: 'show bmp route client_id 1 session-id 1 af ipv4-unc rib adj-rib-in',
        includes: ['Error: Invalid command.']
    },
    {
        id: null,
        input: 'show bmp route client-id 1 session_id 1 af ipv4-unc rib adj-rib-in',
        includes: ['Error: Invalid command.']
    },
    {
        id: null,
        input: `show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in route_key ${mockRoute.routeKey}`,
        includes: ['Error: Invalid command.']
    },
    {
        id: null,
        input: 'show bmp route client-id 1 instance_id 1',
        includes: ['Error: Invalid command.']
    },
    {
        id: null,
        input: 'show bmp statistic session client-id 1 report_id 1',
        includes: ['Error: Invalid command.']
    },
    {
        id: 'show-bmp-route-session-key',
        input: 'show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in route-key null|0:0|203.0.113.0|24',
        includes: ['Error: route-key path-id must use 0 instead of null.']
    },
    {
        id: null,
        input: 'show line',
        includes: ['Error: Invalid command.']
    },
    {
        id: null,
        input: 'show bmp instance-routes client-id 1 instance-id 1',
        includes: ['Error: Invalid command.']
    },
    { id: 'exit', input: 'exit', closed: true }
];

const helpCases = [
    {
        input: 'show bmp route client-id 1 session-id 1 af ',
        includes: ['ipv4-unc', 'ipv6-unc', 'l2vpn-evpn', 'Address family'],
        excludes: ['<ipv4-unc|ipv6-unc']
    },
    {
        input: 'show bmp route client-id 1 session-id 1 af ipv4-unc rib ',
        includes: ['pre-adj-rib-in', 'adj-rib-in', 'post-adj-rib-out', 'RIB type'],
        excludes: ['<pre-adj-rib-in|adj-rib-in']
    },
    {
        input: 'show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in state ',
        includes: ['active', 'stale', 'all', 'Route state'],
        excludes: ['<active|stale|all>']
    }
];

const completionCases = [
    {
        input: 'show bmp route client-id 1 session-id 1 af ipv4-u',
        includes: ['ipv4-unc']
    },
    {
        input: 'show bmp route client-id 1 session-id 1 af ipv4-unc rib adj',
        includes: ['adj-rib-in', 'adj-rib-out']
    },
    {
        input: 'show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in state st',
        includes: ['stale']
    }
];

function success(data) {
    return { status: 'success', data };
}

function createMockBmpApp(options = {}) {
    const routes = options.routes || [mockRoute];
    const routeQueries = options.routeQueries || [];

    return {
        getBmpRunning: () => true,
        queryClientList: async () => success([mockClient]),
        queryBgpSessions: async () => success([mockSession]),
        queryBgpInstances: async () => success([mockInstance]),
        queryBgpStatisticsReports: async () => success([mockSessionReport]),
        queryBgpInstanceStatisticsReports: async () => success([mockInstanceReport]),
        queryBgpRoutes: async query => {
            routeQueries.push({ type: 'session', ...query });
            return success(queryRouteList(query, routes));
        },
        queryBgpRouteDetail: async query => success(queryRouteDetail(query)),
        queryBgpInstanceRoutes: async query => {
            routeQueries.push({ type: 'instance', ...query });
            return success(queryRouteList(query, routes));
        },
        queryBgpInstanceRouteDetail: async query => success(queryRouteDetail(query))
    };
}

function queryRouteList(query, sourceRoutes = [mockRoute]) {
    const routes = sourceRoutes.filter(route => {
        const state = query.routeState || BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE;
        const stateMatched = state === BmpConst.BMP_ROUTE_STATE_FILTER.ALL || route.routeState === state;
        const prefixMatched = !query.prefixFilter || `${route.ip}/${route.mask}` === query.prefixFilter;
        return stateMatched && prefixMatched;
    });
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.max(1, Number(query.pageSize) || 25);
    const start = (page - 1) * pageSize;

    return {
        list: routes.slice(start, start + pageSize),
        total: routes.length,
        summary: {
            active: routes.filter(route => route.routeState === BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE).length,
            stale: routes.filter(route => route.routeState === BmpConst.BMP_ROUTE_STATE_FILTER.STALE).length,
            total: routes.length
        }
    };
}

function queryRouteDetail(query) {
    assert.strictEqual(query.routeKey, mockRoute.routeKey);
    return { ...mockRoute };
}

function createIdStore() {
    return {
        nextId: 1,
        keyToId: new Map(),
        idToValue: new Map()
    };
}

function createSession() {
    let output = '';
    return {
        lineId: 1,
        peer: '127.0.0.1:3788',
        view: 'user',
        context: new Map(),
        connectTime: new Date('2026-06-14T00:00:00.000Z'),
        busy: false,
        telnetState: 'data',
        inputState: 'normal',
        line: '',
        cursor: 0,
        terminalLength: 24,
        closed: false,
        pager: null,
        bmpIds: {
            client: createIdStore(),
            session: new Map(),
            instance: new Map(),
            sessionStatistics: new Map(),
            instanceStatistics: new Map()
        },
        write(text) {
            output += String(text);
        },
        writeLine(text = '') {
            this.write(`${text}\r\n`);
        },
        sendPrompt() {},
        close() {
            this.closed = true;
        },
        clearOutput() {
            output = '';
        },
        readOutput() {
            return output;
        }
    };
}

function createServer(options = {}) {
    const server = new CliAccessServer({
        bmpApp: createMockBmpApp(options),
        externalApiServer: {
            getStatus: () => ({
                running: true,
                enabled: true,
                host: '127.0.0.1',
                port: 3787
            })
        },
        settings: {
            enabled: true,
            host: '127.0.0.1',
            port: 3788,
            maxSessions: 5
        }
    });
    server.loadRuntimeData();
    server.globalHistory.push({
        lineId: 1,
        peer: '127.0.0.1:3788',
        time: new Date('2026-06-14T00:00:00.000Z'),
        command: 'seed command'
    });
    return server;
}

function getCommandSyntaxKeys(server) {
    return new Set(server.tree.collectCommandRows().map(row => row.syntaxKey));
}

function expectedGroupId(id) {
    if (!id) {
        return null;
    }
    if (id.startsWith('show-bmp-route-session')) return 'show-bmp-route-session';
    if (id.startsWith('show-bmp-route-instance')) return 'show-bmp-route-instance';
    if (id.startsWith('show-bmp-statistic-session')) return 'show-bmp-statistic-session';
    if (id.startsWith('show-bmp-statistic-instance')) return 'show-bmp-statistic-instance';
    if (id.startsWith('show-bmp-client')) return 'show-bmp-client';
    if (id.startsWith('show-bmp-session')) return 'show-bmp-session';
    if (id.startsWith('show-bmp-instance')) return 'show-bmp-instance';
    return id;
}

function assertText(output, values, label) {
    (values || []).forEach(value => {
        assert.ok(output.includes(value), `${label} missing "${value}" in output:\n${output}`);
    });
}

function assertNotText(output, values, label) {
    (values || []).forEach(value => {
        assert.ok(!output.includes(value), `${label} unexpectedly included "${value}" in output:\n${output}`);
    });
}

function waitImmediate() {
    return new Promise(resolve => setImmediate(resolve));
}

async function waitForPagerIdle(session) {
    for (let index = 0; index < 10; index += 1) {
        await waitImmediate();
        if (!session.busy && (!session.pager || !session.pager.busy)) {
            return;
        }
    }
    assert.strictEqual(session.busy, false, 'pager session is still busy');
}

async function runCommandCase(server, session, item, coveredSyntaxKeys) {
    console.log(`\n[cli] input: ${item.input}`);
    session.clearOutput();

    const words = item.input.split(/\s+/u);
    const match = server.tree.match(session.view, words);
    const actualGroupId = match && match.command ? match.command.groupId : null;
    const expectedGroup = expectedGroupId(item.id);
    assert.strictEqual(
        actualGroupId,
        expectedGroup,
        `${item.input} matched group ${actualGroupId}, expected ${expectedGroup}`
    );
    if (match && match.command) {
        coveredSyntaxKeys.add(match.command.syntax);
    }

    await server.executeLine(session, item.input);
    const output = session.readOutput();
    console.log(`[cli] output:\n${output || '(no output)'}`);

    assertText(output, item.includes, item.input);
    assertNotText(output, item.excludes, item.input);
    if (item.view) {
        assert.strictEqual(session.view, item.view, `${item.input} view`);
    }
    if (item.closed !== undefined) {
        assert.strictEqual(session.closed, item.closed, `${item.input} closed`);
    }
}

function runHelpCase(server, session, item) {
    console.log(`\n[cli] input: ${item.input}?`);
    const output = server.getHelpText(session, item.input);
    console.log(`[cli] output:\n${output || '(no output)'}`);
    assertText(output, item.includes, item.input);
    assertNotText(output, item.excludes, item.input);
}

function runCompletionCase(server, session, item) {
    console.log(`\n[cli] input: ${item.input}<Tab>`);
    const completion = server.getCompletion(session, item.input);
    const output = completion.candidates.join('\r\n');
    console.log(`[cli] output:\n${output || '(no output)'}`);
    assertText(output, item.includes, item.input);
}

async function runMorePagerCase() {
    const routeQueries = [];
    const routes = createPagedRoutes(30);
    const server = createServer({ routes, routeQueries });
    const session = createSession();
    const command = 'show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in';
    server.sessions.set(session.lineId, session);

    console.log(`\n[cli] input: ${command}`);
    await server.executeLine(session, command);
    let output = session.readOutput();
    console.log(`[cli] output:\n${output || '(no output)'}`);

    assertText(
        output,
        ['Page: 1, PageSize: 25, Total: 30, Displayed: 25', routes[0].routeKey, routes[24].routeKey, '--More-- 25/30'],
        command
    );
    assertNotText(output, [routes[25].routeKey], command);
    assert.ok(session.pager, `${command} did not create pager`);
    assert.deepStrictEqual(
        routeQueries.map(query => query.page),
        [1]
    );
    assert.deepStrictEqual(
        routeQueries.map(query => query.pageSize),
        [25]
    );

    session.clearOutput();
    console.log('\n[cli] input: <Space>');
    server.handleByte(session, 32);
    await waitForPagerIdle(session);
    output = session.readOutput();
    console.log(`[cli] output:\n${output || '(no output)'}`);

    assertText(
        output,
        ['Page: 2, PageSize: 25, Total: 30, Displayed: 30', routes[25].routeKey, routes[29].routeKey],
        '<Space>'
    );
    assertNotText(output, ['--More--'], '<Space>');
    assert.strictEqual(session.pager, null, '<Space> should finish pager');
    assert.deepStrictEqual(
        routeQueries.map(query => query.page),
        [1, 2]
    );
    assert.deepStrictEqual(
        routeQueries.map(query => query.pageSize),
        [25, 25]
    );
}

async function runTerminalLengthZeroPagerCase() {
    const routeQueries = [];
    const routes = createPagedRoutes(30);
    const server = createServer({ routes, routeQueries });
    const session = createSession();
    const command = 'show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in';
    session.terminalLength = 0;
    server.sessions.set(session.lineId, session);

    console.log(`\n[cli] input: terminal length 0 + ${command}`);
    await server.executeLine(session, command);
    const output = session.readOutput();
    console.log(`[cli] output:\n${output || '(no output)'}`);

    assertText(
        output,
        [
            'Page: 1, PageSize: 25, Total: 30, Displayed: 25',
            'Page: 2, PageSize: 25, Total: 30, Displayed: 30',
            routes[0].routeKey,
            routes[29].routeKey
        ],
        'terminal length 0'
    );
    assertNotText(output, ['--More--'], 'terminal length 0');
    assert.strictEqual(session.pager, null, 'terminal length 0 should not create pager');
    assert.deepStrictEqual(
        routeQueries.map(query => query.page),
        [1, 2]
    );
    assert.deepStrictEqual(
        routeQueries.map(query => query.pageSize),
        [25, 25]
    );
}

async function main() {
    const server = createServer();
    const session = createSession();
    server.sessions.set(session.lineId, session);

    const registeredSyntaxKeys = getCommandSyntaxKeys(server);
    const coveredSyntaxKeys = new Set();

    helpCases.forEach(item => runHelpCase(server, session, item));
    completionCases.forEach(item => runCompletionCase(server, session, item));
    await runMorePagerCase();
    await runTerminalLengthZeroPagerCase();

    for (const item of commandCases) {
        await runCommandCase(server, session, item, coveredSyntaxKeys);
    }

    const missingSyntaxKeys = Array.from(registeredSyntaxKeys)
        .filter(syntaxKey => !coveredSyntaxKeys.has(syntaxKey))
        .sort();
    assert.deepStrictEqual(missingSyntaxKeys, [], `Missing CLI command coverage: ${missingSyntaxKeys.join(', ')}`);

    console.log(`\nCLI command test passed. Covered ${coveredSyntaxKeys.size} command syntaxes.`);
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
