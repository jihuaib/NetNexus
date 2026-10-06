const assert = require('assert');

const CliAccessServer = require('../../electron/app/cli/cliAccessServer');
const ParamType = require('../../electron/app/cli/paramTypes');
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

const mockEvpnRoute = {
    ...mockRoute,
    routeKey:
        '0|raw:0000fe4c00000046|25:70:evpn:' +
        // Lookup keys are opaque text: retain JSON escapes as returned by the API.
        JSON.stringify({
            kind: 'evpn',
            semantic: {
                ethernetTagId: 0,
                ipPrefix: '2001:db8:5:7c::',
                prefixLength: 64,
                rd: 'raw:0000fe4c00000046',
                routeType: 5
            }
        }).replace('2001', '\\u0032001'),
    addrFamilyType: BgpConst.BGP_ADDR_FAMILY.L2VPN_EVPN,
    afi: 25,
    safi: 70,
    ip: 'evpn:ip-prefix:65100:70:tag=0:2001:db8:5:7c::/64:gw=::',
    mask: 64,
    rd: '65100:70',
    nextHop: '::ffff:172.28.131.3',
    routeState: BmpConst.BMP_ROUTE_STATE_FILTER.STALE
};

function createLongFlowSpecRoute() {
    const operands = Array.from({ length: 400 }, (_, index) => Buffer.from([index === 399 ? 0x91 : 0x11, 0x01, 0xbb]));
    const body = Buffer.concat([Buffer.from([1, 24, 192, 0, 2, 5]), ...operands]);
    const wire = Buffer.concat([Buffer.from([0xf0 | (body.length >> 8), body.length & 255]), body]);
    const route = {
        ...mockRoute,
        routeKey:
            '0|0:0|1:133:raw-nlri:' +
            JSON.stringify({ kind: 'raw-nlri', rawNlriHex: wire.toString('hex'), rd: null, routeType: null }),
        addrFamilyType: BgpConst.BGP_ADDR_FAMILY.IPV4_FLOWSPEC,
        afi: 1,
        safi: 133,
        ip: 'flowspec:192.0.2.0/24:destination-port=443',
        mask: 0
    };
    assert.ok(route.routeKey.length > 2048, 'FlowSpec fixture must exceed the former route-key argument limit');
    return route;
}

function createQuotedRouteKeyRoute() {
    return {
        ...mockEvpnRoute,
        routeKey:
            '0|raw:0000fe4c00000046|25:70:evpn:' +
            JSON.stringify({
                kind: 'evpn',
                semantic: {
                    ethernetTagId: 0,
                    ipPrefix: '2001:db8:5:7c::',
                    prefixLength: 64,
                    rd: 'raw:0000fe4c00000046',
                    routeType: 5,
                    note: 'west campus "edge" O\'Brien \\server\\switch literal\\u0032 verbose'
                }
            })
    };
}

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
        id: 'show-bmp-route-session-state-key',
        input: `show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in state all route-key ${mockRoute.routeKey}`,
        includes: ['RouteKey', mockRoute.routeKey, 'ipv4-unc'],
        excludes: ['extraRoute', 'localPref', 'null|0:0']
    },
    {
        id: 'show-bmp-route-session-state-key-verbose',
        input: `show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in state all route-key ${mockRoute.routeKey} verbose`,
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
        id: 'show-bmp-route-instance-state-key',
        input: `show bmp route client-id 1 instance-id 1 state all route-key ${mockRoute.routeKey}`,
        includes: ['RouteKey', mockRoute.routeKey, 'ipv4-unc'],
        excludes: ['extraRoute', 'localPref', 'null|0:0']
    },
    {
        id: 'show-bmp-route-instance-state-key-verbose',
        input: `show bmp route client-id 1 instance-id 1 state all route-key ${mockRoute.routeKey} verbose`,
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
        input: 'show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in state all ',
        includes: ['prefix', 'route-key']
    },
    {
        input: 'show bmp route client-id 1 instance-id 1 state all ',
        includes: ['prefix', 'route-key']
    },
    {
        input: 'show bmp route client-id 1 session-id 1 af ',
        includes: ['ipv4-unc', 'ipv6-unc', 'ipv4-multicast', 'ipv6-multicast', 'l2vpn-evpn', 'Address family'],
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
        input: 'show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in state all rou',
        includes: ['route-key']
    },
    {
        input: 'show bmp route client-id 1 instance-id 1 state all rou',
        includes: ['route-key']
    },
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
    const detailQueries = options.detailQueries || [];

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
        queryBgpRouteDetail: async query => {
            detailQueries.push({ type: 'session', ...query });
            return success(queryRouteDetail(query, routes));
        },
        queryBgpInstanceRoutes: async query => {
            routeQueries.push({ type: 'instance', ...query });
            return success(queryRouteList(query, routes));
        },
        queryBgpInstanceRouteDetail: async query => {
            detailQueries.push({ type: 'instance', ...query });
            return success(queryRouteDetail(query, routes));
        }
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

function queryRouteDetail(query, sourceRoutes = [mockRoute]) {
    const route = sourceRoutes.find(item => item.routeKey === query.routeKey);
    assert.ok(route, `Route detail received an unknown or altered route-key: ${query.routeKey}`);
    return { ...route };
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
        history: [],
        historyIndex: null,
        tabCycle: null,
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
        redrawLine() {
            this.write(this.line);
        },
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
        bmpApp: options.bmpApp || createMockBmpApp(options),
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

async function runHelpCase(server, session, item) {
    console.log(`\n[cli] input: ${item.input}?`);
    const output = await server.getHelpText(session, item.input);
    console.log(`[cli] output:\n${output || '(no output)'}`);
    assertText(output, item.includes, item.input);
    assertNotText(output, item.excludes, item.input);
}

async function runCompletionCase(server, session, item) {
    console.log(`\n[cli] input: ${item.input}<Tab>`);
    const completion = await server.getCompletion(session, item.input);
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

async function runRouteKeyRoundTripCase(route, label, afKeyword) {
    assert.ok(route.routeKey.length > 80, `${label} must exercise a key longer than the table column limit`);
    const detailQueries = [];
    const lookupRoutes = [{ ...route }];
    const server = createServer({ routes: lookupRoutes, detailQueries });
    const session = createSession();
    server.sessions.set(session.lineId, session);

    for (const [type, baseCommand] of [
        ['session', `show bmp route client-id 1 session-id 1 af ${afKeyword} rib adj-rib-in`],
        ['instance', 'show bmp route client-id 1 instance-id 1']
    ]) {
        lookupRoutes[0] = { ...route };
        session.clearOutput();
        await server.executeLine(session, `${baseCommand} state all`);
        const lines = session.readOutput().split('\r\n');
        const headerIndex = lines.findIndex(line => line.includes('RouteKey'));
        assert.ok(headerIndex >= 0, `${label} ${type} list is missing its RouteKey column`);
        const routeKeyOffset = lines[headerIndex].indexOf('RouteKey');
        const copiedKey = lines[headerIndex + 2].slice(routeKeyOffset).trim();
        assert.strictEqual(copiedKey, route.routeKey, `${label} ${type} list must display the complete RouteKey`);
        const prefixOffset = lines[headerIndex].indexOf('Prefix');
        const rdOffset = lines[headerIndex].indexOf('RD');
        assert.strictEqual(
            lines[headerIndex + 2].slice(prefixOffset, rdOffset).trim(),
            route.ip,
            `${label} ${type} list must preserve the raw prefix without appending a mask`
        );

        for (const state of ['', ' state all']) {
            // Keep legacy raw-key and quote compatibility on active routes while
            // state all still verifies the original route state.
            lookupRoutes[0] = {
                ...route,
                routeState: state ? route.routeState : BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE
            };
            for (const [quoting, quote] of [
                ['bare', ''],
                ['single quotes', "'"],
                ['double quotes', '"']
            ]) {
                for (const [verbose, suffix] of [
                    [false, ''],
                    [true, ' verbose'],
                    [true, ' v'],
                    [true, ' ver']
                ]) {
                    session.clearOutput();
                    const command = `${baseCommand}${state} route-key ${quote}${copiedKey}${quote}${suffix}`;
                    const caseLabel = `${label} ${type}${state} ${quoting}${suffix}`;
                    const priorQueries = detailQueries.length;
                    await server.executeLine(session, command);
                    const output = session.readOutput();
                    assertNotText(output, ['Error:'], `${caseLabel} copied route-key`);
                    assert.strictEqual(
                        detailQueries.length,
                        priorQueries + 1,
                        `${caseLabel} copied route-key must reach the detail interface exactly once`
                    );
                    const query = detailQueries[detailQueries.length - 1];
                    assert.strictEqual(query.type, type);
                    assert.strictEqual(
                        query.routeKey,
                        route.routeKey,
                        `${caseLabel} route-key must retain its JSON quotes, whitespace and backslashes`
                    );
                    if (verbose) {
                        const detail = JSON.parse(output);
                        assert.strictEqual(detail.routeKey, route.routeKey);
                        assert.strictEqual(detail.ip, route.ip);
                        assert.strictEqual(detail.routeState, lookupRoutes[0].routeState);
                    } else {
                        assertText(output, [route.routeKey, route.ip], `${caseLabel} detail`);
                    }
                }
            }
        }
    }
    assert.strictEqual(
        detailQueries.length,
        48,
        `${label} should query both scopes with and without state, all quote styles and verbosity`
    );
    console.log(`[cli] ${label} RouteKey round trip passed (${route.routeKey.length} characters).`);
}

async function runStateRouteKeyCase() {
    const staleRoute = {
        ...mockRoute,
        routeKey: '0|0:0|203.0.114.0|24',
        ip: '203.0.114.0',
        routeState: BmpConst.BMP_ROUTE_STATE_FILTER.STALE
    };
    const detailQueries = [];
    const routeQueries = [];
    const server = createServer({ routes: [mockRoute, staleRoute], detailQueries, routeQueries });
    const session = createSession();
    for (const [type, base] of [
        ['session', 'show bmp route client-id 1 session-id 1 af ipv4-unc rib adj-rib-in'],
        ['instance', 'show bmp route client-id 1 instance-id 1']
    ]) {
        session.line = `${base} state all rou`;
        session.cursor = session.line.length;
        server.resetTabCycle(session);
        await server.completeLine(session);
        assert.strictEqual(session.line, `${base} state all route-key `, 'state all Tab must complete route-key');
        session.clearOutput();
        await server.executeLine(session, `${session.line}${staleRoute.routeKey}`);
        assertText(session.readOutput(), [staleRoute.routeKey, 'stale'], 'Tab-completed state all route-key');

        for (const route of [mockRoute, staleRoute]) {
            const matchingStates = route === mockRoute ? ['', 'active', 'all'] : ['stale', 'all'];
            for (const state of ['', 'active', 'stale', 'all']) {
                const matched = matchingStates.includes(state);
                for (const verbose of [false, true]) {
                    const command = `${base}${state ? ` state ${state}` : ''} route-key ${route.routeKey}${verbose ? ' verbose' : ''}`;
                    const priorQueries = detailQueries.length;
                    session.clearOutput();
                    await server.executeLine(session, command);
                    const output = session.readOutput();
                    assertNotText(output, ['Error:'], command);
                    assert.strictEqual(
                        detailQueries.length,
                        priorQueries + 1,
                        'state lookup must query route detail once'
                    );
                    const query = detailQueries[detailQueries.length - 1];
                    assert.strictEqual(query.type, type, 'state route-key must preserve its lookup scope');
                    assert.strictEqual(query.routeKey, route.routeKey, 'state route-key must query the original key');
                    assert.strictEqual(query.client.__cliId, 1, 'state route-key must preserve its client ID context');
                    assert.strictEqual(query.client.sysName, mockClient.sysName);
                    if (type === 'session') {
                        assert.strictEqual(query.session.__cliId, 1, 'state route-key must preserve its session ID');
                        assert.strictEqual(query.session.sessionIp, mockSession.sessionIp);
                    } else {
                        assert.strictEqual(query.instance.__cliId, 1, 'state route-key must preserve its instance ID');
                        assert.strictEqual(query.instance.instanceRd, mockInstance.instanceRd);
                    }
                    if (verbose) {
                        const detail = JSON.parse(output);
                        if (matched) {
                            assert.strictEqual(
                                detail.routeKey,
                                route.routeKey,
                                'matching state must retain verbose detail'
                            );
                            assert.strictEqual(detail.routeState, route.routeState);
                        } else {
                            assert.strictEqual(detail, null, 'a filtered-out route must hide verbose detail');
                        }
                    } else if (matched) {
                        assertText(output, [route.routeKey, route.routeState, 'Total: 1'], command);
                    } else {
                        assertText(output, ['Total: 0', 'No data.'], command);
                        assertNotText(output, [route.routeKey, 'route verbose field'], command);
                    }
                }
            }
        }
        session.clearOutput();
        const queriesBeforeInvalid = detailQueries.length;
        await server.executeLine(session, `${base} state all prefix 203.0.113.0/24 route-key ${mockRoute.routeKey}`);
        assertText(
            session.readOutput(),
            ['Error: Invalid command.'],
            'prefix and route-key must be mutually exclusive'
        );
        assert.strictEqual(detailQueries.length, queriesBeforeInvalid, 'invalid mixed filters must not query details');
    }
    assert.deepStrictEqual(routeQueries, [], 'route-key lookup must not load route lists for state filtering');
    console.log(
        '[cli] route-key defaults to active, filters detail states, preserves ID context and remains exclusive with prefix.'
    );
}

function createDynamicBmpFixture() {
    const clients = [
        { ...mockClient, sysName: 'router-a', remoteIp: '192.0.2.10', remotePort: 51001 },
        { ...mockClient, sysName: 'router-b', remoteIp: '198.51.100.10', remotePort: 51002 }
    ];
    const sessions = new Map([
        [
            '192.0.2.10',
            [
                { ...mockSession, sessionIp: '192.0.2.11', sessionAs: 65101 },
                { ...mockSession, sessionIp: '192.0.2.12', sessionAs: 65102 }
            ]
        ],
        ['198.51.100.10', [{ ...mockSession, sessionIp: '198.51.100.21', sessionAs: 65201 }]]
    ]);
    const instances = new Map([
        [
            '192.0.2.10',
            [
                { ...mockInstance, instanceRd: '65100:11', instanceIp: '192.0.2.11' },
                {
                    ...mockInstance,
                    instanceRd: '65100:12',
                    instanceIp: '2001:db8::12',
                    addrFamilyType: BgpConst.BGP_ADDR_FAMILY.IPV6_UNC
                }
            ]
        ],
        [
            '198.51.100.10',
            [
                {
                    ...mockInstance,
                    instanceRd: '65200:21',
                    instanceIp: '198.51.100.21',
                    addrFamilyType: BgpConst.BGP_ADDR_FAMILY.L2VPN_EVPN
                }
            ]
        ]
    ]);
    const queries = [];
    const bmpApp = {
        ...createMockBmpApp(),
        queryClientList: async () => {
            queries.push({ type: 'client' });
            return success(clients);
        },
        queryBgpSessions: async client => {
            queries.push({ type: 'session', client: client.remoteIp });
            return success(sessions.get(client.remoteIp) || []);
        },
        queryBgpInstances: async client => {
            queries.push({ type: 'instance', client: client.remoteIp });
            return success(instances.get(client.remoteIp) || []);
        }
    };
    return { clients, sessions, instances, queries, bmpApp };
}

function assertCompletionRows(completion, values, label) {
    assert.deepStrictEqual(
        completion.candidates,
        values.map(([value]) => value),
        `${label} candidates`
    );
    values.forEach(([value, descriptions]) => {
        const row = completion.rows.find(item => item.token === value);
        assert.ok(row, `${label} missing row ${value}`);
        assertText(row.description, descriptions, `${label} ${value} description`);
    });
}

function assertParameterTypeRow(completion, token, description, label) {
    const row = completion.rows.find(item => item.token === token);
    assert.ok(row, `${label} must keep the original parameter type ${token}`);
    assertText(row.description, [description], `${label} original parameter description`);
    assert.ok(!completion.candidates.includes(token), `${label} must not complete the parameter placeholder`);
}

async function runDynamicBmpParameterCase() {
    const fixture = createDynamicBmpFixture();
    fixture.sessions.get('192.0.2.10')[0].sessionState = 0;
    fixture.instances.get('192.0.2.10')[0].instanceState = 0;
    const server = createServer({ bmpApp: fixture.bmpApp });
    const session = createSession();
    server.sessions.set(session.lineId, session);

    assert.strictEqual(session.bmpIds.client.nextId, 1, 'fixture must begin without a prior show command');
    const clientHelp = await server.getHelpText(session, 'show bmp route client-id ');
    assertText(
        clientHelp,
        ['<uint(1-65535)>', 'BMP client ID', 'router-a', 'router-b', '192.0.2.10', '198.51.100.10'],
        'dynamic client help'
    );
    const clients = await server.getCompletion(session, 'show bmp route client-id ');
    assert.strictEqual(clients.dynamic, true, 'XML parameter must select the registered dynamic provider');
    assertParameterTypeRow(clients, '<uint(1-65535)>', 'BMP client ID', 'dynamic client Tab');
    assertCompletionRows(
        clients,
        [
            ['1', ['router-a', '192.0.2.10']],
            ['2', ['router-b', '198.51.100.10']]
        ],
        'dynamic client Tab'
    );

    for (const scope of ['session', 'instance']) {
        const parameter = `${scope}-id`;
        const parameterDescription = scope === 'session' ? 'BGP session ID' : 'Loc-RIB instance ID';
        const first = await server.getCompletion(session, `show bmp route client-id 1 ${parameter} `);
        const second = await server.getCompletion(session, `show bmp route client-id 2 ${parameter} `);
        if (scope === 'session') {
            assertCompletionRows(
                first,
                [
                    ['1', ['192.0.2.11', '65101', 'State: 0']],
                    ['2', ['192.0.2.12', '65102', 'State: up']]
                ],
                'client 1 sessions'
            );
            assertCompletionRows(second, [['1', ['198.51.100.21', '65201']]], 'client 2 sessions');
        } else {
            assertCompletionRows(
                first,
                [
                    ['1', ['65100:11', 'ipv4-unc', 'State: 0']],
                    ['2', ['65100:12', 'ipv6-unc', 'State: up']]
                ],
                'client 1 instances'
            );
            assertCompletionRows(second, [['1', ['65200:21', 'l2vpn-evpn']]], 'client 2 instances');
        }
        assert.strictEqual(first.dynamic, true, `${scope} must use dynamic completion`);
        assertParameterTypeRow(first, '<uint(1-65535)>', parameterDescription, `${scope} Tab`);
        const numericStateLine = `show bmp route client-id 1 ${parameter} 1`;
        const numericStateHelp = await server.getHelpText(session, numericStateLine);
        assertText(numericStateHelp, ['State: 0'], `${scope} help must retain numeric peer-up state`);
        session.line = numericStateLine;
        session.cursor = session.line.length;
        session.clearOutput();
        await server.completeLine(session);
        assertText(session.readOutput(), ['State: 0'], `${scope} Tab must render numeric peer-up state`);
        assert.strictEqual(
            session.line,
            `${numericStateLine} `,
            `${scope} Tab must keep numeric state metadata out of input`
        );
        const filtered = await server.getCompletion(session, `show bmp route client-id 1 ${parameter} 2`);
        assert.deepStrictEqual(filtered.candidates, ['2'], `${scope} numeric prefix must filter candidates`);
        assertParameterTypeRow(filtered, '<uint(1-65535)>', parameterDescription, `${scope} filtered Tab`);
        const help = await server.getHelpText(session, `show bmp route client-id 2 ${parameter} `);
        assertText(
            help,
            ['<uint(1-65535)>', parameterDescription, scope === 'session' ? '198.51.100.21' : '65200:21'],
            `${scope} contextual help`
        );
        assertNotText(help, ['192.0.2.11', '192.0.2.12', '65100:11'], `${scope} client isolation`);
    }

    session.line = 'show bmp route client-id 2';
    session.cursor = session.line.length;
    session.clearOutput();
    await server.completeLine(session);
    assert.strictEqual(session.line, 'show bmp route client-id 2 ', 'Tab must apply an ID and append a space');
    assertText(session.readOutput(), ['<uint(1-65535)>', 'BMP client ID'], 'client Tab original type rendering');
    session.line = 'show bmp route client-id 2 session-id ';
    session.cursor = session.line.length;
    session.clearOutput();
    await server.completeLine(session);
    assert.strictEqual(
        session.line,
        'show bmp route client-id 2 session-id 1 ',
        'Tab after a space must complete the available dynamic parameter'
    );
    assertText(session.readOutput(), ['<uint(1-65535)>', 'BGP session ID'], 'session Tab original type rendering');
    session.line = 'show bmp route client-id ';
    session.cursor = session.line.length;
    server.resetTabCycle(session);
    for (const id of ['1', '2', '1']) {
        session.clearOutput();
        await server.completeLine(session);
        assert.strictEqual(session.line, `show bmp route client-id ${id}`, 'Tab must cycle only real dynamic IDs');
        assertText(session.readOutput(), ['<uint(1-65535)>', 'BMP client ID'], 'multiple ID Tab type rendering');
    }

    fixture.clients.reverse();
    fixture.sessions.get('192.0.2.10').reverse();
    fixture.instances.get('192.0.2.10').reverse();
    const reorderedClients = await server.getCompletion(session, 'show bmp client client-id ');
    const routerA = reorderedClients.rows.find(row => row.description.includes('router-a'));
    const routerB = reorderedClients.rows.find(row => row.description.includes('router-b'));
    assert.strictEqual(routerA.token, '1', 'client ID must survive query reordering');
    assert.strictEqual(routerB.token, '2', 'client ID must survive query reordering');
    const reorderedSessions = await server.getCompletion(session, 'show bmp session client-id 1 session-id ');
    const reorderedInstances = await server.getCompletion(session, 'show bmp instance client-id 1 instance-id ');
    assert.strictEqual(
        reorderedSessions.rows.find(row => row.description.includes('192.0.2.11')).token,
        '1',
        'session ID must survive query reordering'
    );
    assert.strictEqual(
        reorderedInstances.rows.find(row => row.description.includes('65100:11')).token,
        '1',
        'instance ID must survive query reordering'
    );

    for (const command of [
        'show bmp client client-id 1',
        'show bmp session client-id 1 session-id 1',
        'show bmp instance client-id 1 instance-id 1'
    ]) {
        session.clearOutput();
        await server.executeLine(session, command);
        assertNotText(session.readOutput(), ['Error:'], `${command} must reuse completion IDs`);
    }
    assertText(session.readOutput(), ['65100:11'], 'instance ID assigned by completion');

    fixture.sessions.get('192.0.2.10').pop();
    fixture.instances.get('192.0.2.10').pop();
    for (const scope of ['session', 'instance']) {
        const completion = await server.getCompletion(session, `show bmp route client-id 1 ${scope}-id `);
        assert.deepStrictEqual(completion.candidates, ['2'], `removed ${scope} ID must not be suggested`);
    }
    fixture.clients.pop();
    const remainingClients = await server.getCompletion(session, 'show bmp route client-id ');
    assert.deepStrictEqual(remainingClients.candidates, ['2'], 'removed client ID must not be suggested');
    const beforeUnknownClient = fixture.queries.filter(query => query.type === 'session').length;
    const unknownClient = await server.getCompletion(session, 'show bmp route client-id 1 session-id ');
    assert.deepStrictEqual(unknownClient.candidates, [], 'removed parent client must not expose child IDs');
    assert.strictEqual(
        fixture.queries.filter(query => query.type === 'session').length,
        beforeUnknownClient,
        'removed parent client must not query a different client'
    );
    fixture.bmpApp.queryClientList = async () => ({ status: 'error', msg: 'BMP query unavailable' });
    const unavailable = await server.getCompletion(session, 'show bmp client client-id ');
    assert.deepStrictEqual(unavailable.candidates, [], 'BMP query failures must not return cached client IDs');
    const unavailableHelp = await server.getHelpText(session, 'show bmp client client-id ');
    assertText(unavailableHelp, ['uint(1-65535)', 'BMP client ID'], 'BMP failure type fallback');
    assert.ok(
        server.tree.match('user', ['show', 'bmp', 'client', 'client-id', '999']).command,
        'a legal manually entered ID must remain syntactically valid without a working provider'
    );
    console.log('[cli] dynamic BMP IDs, context, descriptions and live refresh passed.');
}

function registerTestParameterCommand(server, provider = 'test.targets', inputMode = null) {
    const sequence = [
        { type: 'command', name: 'inspect' },
        { type: 'command', name: 'site' },
        { type: 'argument', argName: 'site', cfgId: '71', paramType: new ParamType('uint(1-99)') },
        { type: 'command', name: 'target' },
        {
            type: 'argument',
            argName: 'target',
            cfgId: '72',
            paramType: new ParamType('string(1-128)'),
            inputMode,
            completionProvider: provider,
            description: 'Target name'
        }
    ];
    server.tree.registerCommand({
        views: ['user'],
        groupId: 'test-dynamic-parameter',
        syntax: 'inspect site <site:uint(1-99)> target <target:string(1-128)> [extra]',
        sequences: [sequence, [...sequence, { type: 'command', name: 'extra' }]]
    });
}

async function runGenericParameterProviderCase() {
    const server = createServer();
    const session = createSession();
    registerTestParameterCommand(server);
    const contexts = [];
    server.registerParameterProvider('test.targets', async context => {
        contexts.push(context);
        await waitImmediate();
        return [
            { value: 'alpha', description: 'First target at site 4' },
            { value: 'beta', description: 'Second target at site 4' }
        ];
    });

    const completion = await server.getCompletion(session, 'inspect site 4 target a');
    assertCompletionRows(completion, [['alpha', ['First target at site 4']]], 'generic provider prefix');
    assertParameterTypeRow(completion, '<string(1-128)>', 'Target name', 'generic provider prefix');
    const context = contexts[0];
    assert.strictEqual(context.session, session);
    assert.strictEqual(context.server, server);
    assert.strictEqual(context.node.argName, 'target');
    assert.strictEqual(context.args.site, '4');
    assert.strictEqual(context.cfgArgs['71'], '4');
    assert.deepStrictEqual(context.tokens, ['inspect', 'site', '4', 'target']);
    assert.strictEqual(context.prefix, 'a');
    assert.strictEqual(context.view, 'user');
    const help = await server.getHelpText(session, 'inspect site 4 target ');
    assertText(
        help,
        ['<string(1-128)>', 'Target name', 'alpha', 'beta', 'First target', 'Second target'],
        'generic provider help'
    );
    assert.strictEqual(contexts.length, 2, 'help and Tab must refresh the provider independently');

    session.line = 'inspect site 4 target a extra';
    session.cursor = 'inspect site 4 target a'.length;
    await server.completeLine(session);
    assert.strictEqual(session.line, 'inspect site 4 target alpha extra', 'completion must preserve cursor suffix');
    assert.strictEqual(session.cursor, 'inspect site 4 target alpha'.length, 'cursor must stay before suffix');
    assertText(session.readOutput(), ['<string(1-128)>', 'Target name'], 'generic Tab type rendering');

    server.registerParameterProvider('test.targets', async () => [
        { value: 'alpha', description: 'First\r\ntarget' },
        { value: 'alpha', description: 'Duplicate target' },
        { value: 'bad\x1b[2K', description: 'Terminal control sequence' },
        { value: '', description: 'Empty value' },
        { value: null, description: 'Invalid value' }
    ]);
    const normalized = await server.getCompletion(session, 'inspect site 4 target ');
    assert.deepStrictEqual(normalized.candidates, ['alpha'], 'provider candidates must be normalized and deduplicated');
    const normalizedCandidate = normalized.rows.find(row => row.token === 'alpha');
    assert.ok(
        !['\r', '\n', '\x1b'].some(character => normalizedCandidate.description.includes(character)),
        'descriptions must not control the terminal'
    );

    for (const value of ['west campus', "router's west", 'campus "west" O\'Brien']) {
        let received;
        server.registerParameterProvider('test.targets', async () => [{ value, description: 'Quoted target' }]);
        server.handlers.dispatch = async (_session, match) => {
            received = match.args.target;
        };
        session.line = 'inspect site 4 target ';
        session.cursor = session.line.length;
        server.resetTabCycle(session);
        await server.completeLine(session);
        await server.executeLine(session, session.line);
        assert.strictEqual(received, value, 'Tab must quote a string parameter for an exact command round trip');
    }

    for (const [sourceToken, expectedToken, value] of [
        ["'west cam'", "'west campus'", 'west campus'],
        [`'router'"'"'s we'`, `'router'"'"'s west'`, "router's west"]
    ]) {
        let received;
        server.registerParameterProvider('test.targets', async () => [{ value, description: 'Quoted prefix target' }]);
        server.handlers.dispatch = async (_session, match) => {
            received = match.args.target;
        };
        const prefixLine = `inspect site 4 target ${sourceToken}`;
        const quotedCompletion = await server.getCompletion(session, prefixLine);
        assert.deepStrictEqual(quotedCompletion.candidates, [value], 'closed quoted prefix must select its candidate');
        session.line = `${prefixLine} extra`;
        session.cursor = prefixLine.length;
        server.resetTabCycle(session);
        await server.completeLine(session);
        assert.strictEqual(
            session.line,
            `inspect site 4 target ${expectedToken} extra`,
            'Tab must replace the entire quoted token and preserve its suffix'
        );
        assert.strictEqual(
            session.cursor,
            `inspect site 4 target ${expectedToken}`.length,
            'quoted completion must leave the cursor before the suffix'
        );
        await server.executeLine(session, session.line);
        assert.strictEqual(received, value, 'a completed quoted prefix must round trip through command execution');
    }

    for (const failure of ['throw', 'timeout', 'empty', 'unknown']) {
        server.parameterProviders.timeoutMs = 10;
        const unregister = server.registerParameterProvider('test.targets', async () => {
            if (failure === 'throw') {
                throw new Error('Test provider is unavailable');
            }
            if (failure === 'timeout') {
                return new Promise(() => {});
            }
            return [];
        });
        if (failure === 'unknown') unregister();
        const failedCompletion = await server.getCompletion(session, 'inspect site 4 target ');
        assert.deepStrictEqual(failedCompletion.candidates, [], `${failure} must not invent candidates`);
        assertParameterTypeRow(failedCompletion, '<string(1-128)>', 'Target name', `${failure} completion`);
        const failedHelp = await server.getHelpText(session, 'inspect site 4 target ');
        assertText(failedHelp, ['string(1-128)', 'Target name'], `${failure} must retain parameter type help`);
        session.line = 'inspect site 4 target ';
        session.cursor = session.line.length;
        server.resetTabCycle(session);
        session.clearOutput();
        await server.completeLine(session);
        assert.strictEqual(session.line, 'inspect site 4 target ', `${failure} Tab must not insert a placeholder`);
        assertText(session.readOutput(), ['<string(1-128)>', 'Target name'], `${failure} Tab type rendering`);
        const match = server.tree.match(session.view, ['inspect', 'site', '4', 'target', 'manual']);
        assert.ok(match && match.command, `${failure} must allow a manually entered legal parameter`);
        assert.strictEqual(match.args.target, 'manual');
    }
    console.log('[cli] generic async provider context and fallback passed.');
}

async function runGenericOpaqueParameterCase() {
    const server = createServer();
    const session = createSession();
    registerTestParameterCommand(server, 'test.opaque', 'opaque');
    const value = 'target:' + JSON.stringify({ site: 'west campus "edge" O\'Brien \\switch', note: 'inside extra' });
    const base = 'inspect site 4 target ';
    let received;
    let receivedGroup;
    server.handlers.dispatch = async (_session, match) => {
        received = match.args.target;
        receivedGroup = match.command.groupId;
    };
    server.registerParameterProvider('test.opaque', async () => [{ value, description: 'Opaque target metadata' }]);

    for (const quote of ['', "'", '"']) {
        const argument = `${quote}${value}${quote}`;
        session.clearOutput();
        await server.executeLine(session, `${base}${argument} extra`);
        assertNotText(session.readOutput(), ['Error:'], 'non-BMP opaque parameter command');
        assert.strictEqual(received, value, 'opaque parameters must retain internal quotes and backslashes');
        const help = await server.getHelpText(session, `${base}${argument} `);
        assertText(help, ['<cr>', 'extra'], 'opaque argument suffix help');
        session.line = `${base}${argument} ex`;
        session.cursor = session.line.length;
        server.resetTabCycle(session);
        await server.completeLine(session);
        assert.strictEqual(session.line, `${base}${argument} extra `, 'Tab must complete a declared opaque suffix');
        await server.executeLine(session, session.line);
        assert.strictEqual(received, value, 'suffix completion must retain the opaque parameter value');
    }

    const prefix = 'target:{"site":"west cam';
    const completion = await server.getCompletion(session, `${base}${prefix}`);
    assertCompletionRows(completion, [[value, ['Opaque target metadata']]], 'opaque dynamic parameter');
    assertParameterTypeRow(completion, '<string(1-128)>', 'Target name', 'opaque dynamic parameter');
    const help = await server.getHelpText(session, `${base}${prefix}`);
    assertText(help, [value, '<string(1-128)>', 'Opaque target metadata'], 'opaque prefix help');
    session.line = `${base}${prefix} extra`;
    session.cursor = `${base}${prefix}`.length;
    server.resetTabCycle(session);
    await server.completeLine(session);
    assert.strictEqual(
        session.line,
        `${base}"${value}" extra`,
        'opaque dynamic Tab must replace the complete raw prefix'
    );
    assert.strictEqual(
        session.cursor,
        `${base}"${value}"`.length,
        'opaque dynamic Tab must keep the cursor before suffix'
    );
    await server.executeLine(session, session.line);
    assert.strictEqual(received, value, 'opaque dynamic completion must round trip a mixed-quote candidate');

    server.tree.registerCommand({
        views: ['user'],
        groupId: 'test-opaque-sibling',
        syntax: 'inspect site <site:uint(1-99)> target show next',
        sequences: [
            [
                { type: 'command', name: 'inspect' },
                { type: 'command', name: 'site' },
                { type: 'argument', argName: 'site', cfgId: '71', paramType: new ParamType('uint(1-99)') },
                { type: 'command', name: 'target' },
                { type: 'command', name: 'show' },
                { type: 'command', name: 'next' }
            ]
        ]
    });
    for (const keyword of ["'show'", '"show"', `'sh'"ow"`]) {
        session.clearOutput();
        await server.executeLine(session, `${base}${keyword} next`);
        assertNotText(session.readOutput(), ['Error:'], 'quoted sibling keyword execution');
        assert.strictEqual(receivedGroup, 'test-opaque-sibling', 'quoted sibling keywords must keep normal matching');
        assert.strictEqual(received, undefined, 'a quoted sibling keyword must not be consumed as an opaque value');
    }
    console.log('[cli] non-BMP opaque execution, help and dynamic Tab preserve raw values and suffixes.');
}

async function runOpaqueKeywordBoundaryCase() {
    const server = createServer();
    const session = createSession();
    const sequence = [
        { type: 'command', name: 'inspect' },
        { type: 'command', name: 'payload' },
        {
            type: 'argument',
            name: '<payload>',
            argName: 'payload',
            paramType: new ParamType('string(1-128)'),
            inputMode: 'opaque',
            completionProvider: 'test.opaque-tail',
            description: 'Raw payload'
        }
    ];
    server.tree.registerCommand({
        views: ['user'],
        groupId: 'test-opaque-keyword-tail',
        syntax: 'inspect payload <payload:string(1-128)> [verbose]',
        sequences: [sequence, [...sequence, { type: 'command', name: 'verbose', cfgId: '2' }]]
    });
    let received;
    let verbose;
    server.handlers.dispatch = async (_session, match) => {
        received = match.args.payload;
        verbose = Boolean(match.cfgArgs['2']);
    };
    for (const value of ['foo " verbose"', 'foo verbose', 'foo v', 'foo ver']) {
        server.registerParameterProvider('test.opaque-tail', async () => [
            { value, description: 'Raw tail candidate' }
        ]);
        session.line = 'inspect payload foo';
        session.cursor = session.line.length;
        server.resetTabCycle(session);
        await server.completeLine(session);
        await server.executeLine(session, session.line);
        assert.strictEqual(
            received,
            value,
            'opaque Tab must retain reserved words and literal quotes at the value tail'
        );
        assert.strictEqual(verbose, false, 'opaque Tab must keep a wrapped reserved word inside the value');
        for (const quote of ["'", '"']) {
            for (const suffix of ['', ' verbose', ' v', ' ver']) {
                await server.executeLine(session, `inspect payload ${quote}${value}${quote}${suffix}`);
                assert.strictEqual(received, value, 'an outer wrapper must protect opaque values ending in a keyword');
                assert.strictEqual(verbose, Boolean(suffix), 'only a keyword outside the wrapper may act as a suffix');
            }
        }
    }
    console.log('[cli] opaque wrappers protect literal quotes and reserved keyword tails.');
}

function runOpaqueRegistrationGuardCase() {
    const server = createServer();
    const parameter = {
        type: 'argument',
        name: '<payload>',
        argName: 'payload',
        paramType: new ParamType('string(1-128)')
    };
    const suffix = [
        { type: 'command', name: 'tag' },
        { type: 'argument', name: '<tag>', argName: 'tag', paramType: new ParamType('string(1-128)') }
    ];
    assert.throws(
        () =>
            server.tree.registerCommand({
                views: ['user'],
                groupId: 'test-invalid-opaque-suffix',
                syntax: 'invalid <payload> tag <tag>',
                sequences: [[{ type: 'command', name: 'invalid' }, { ...parameter, inputMode: 'opaque' }, ...suffix]]
            }),
        /only supports keyword suffixes/u,
        'a free parameter after an opaque argument must be rejected at registration'
    );
    assert.strictEqual(
        server.tree.match('user', ['invalid']),
        null,
        'a rejected registration must not add partial nodes'
    );
    server.tree.registerCommand({
        views: ['user'],
        groupId: 'test-normal-suffix',
        syntax: 'promote <payload> tag <tag>',
        sequences: [[{ type: 'command', name: 'promote' }, parameter, ...suffix]]
    });
    assert.throws(
        () =>
            server.tree.registerCommand({
                views: ['user'],
                groupId: 'test-invalid-opaque-promotion',
                syntax: 'promote <payload>',
                sequences: [
                    [
                        { type: 'command', name: 'promote' },
                        { ...parameter, inputMode: 'opaque' }
                    ]
                ]
            }),
        /only supports keyword suffixes/u,
        'promoting an existing parameter with argument descendants to opaque must be rejected'
    );
    const original = server.tree.match('user', ['promote', 'value', 'tag', 'west']);
    assert.strictEqual(
        original.command.groupId,
        'test-normal-suffix',
        'a rejected promotion must preserve the command'
    );
    assert.strictEqual(
        original.path[1].inputMode,
        'normal',
        'a rejected promotion must preserve the normal input mode'
    );
    console.log('[cli] opaque registration rejects parameter suffixes and preserves existing trees.');
}

function createDeferred() {
    let resolve;
    const promise = new Promise(done => {
        resolve = done;
    });
    return { promise, resolve };
}

async function runAsyncParameterInputCase() {
    for (const action of ['type', 'restore', 'cancel', 'submit', 'stop', 'close', 'view', 'cursor']) {
        for (const mode of ['completeLine', 'showInlineHelp']) {
            const server = createServer();
            const session = createSession();
            registerTestParameterCommand(server);
            const started = createDeferred();
            const result = createDeferred();
            server.registerParameterProvider('test.targets', async () => {
                started.resolve();
                return result.promise;
            });
            session.line = 'inspect site 4 target a';
            session.cursor = session.line.length;
            const pending = server[mode](session);
            await started.promise;
            if (action === 'type' || action === 'restore') {
                server.handleByte(session, 120);
                if (action === 'restore') server.handleByte(session, 127);
            } else if (action === 'close') {
                session.close();
            } else if (action === 'cancel') {
                server.handleByte(session, 3);
            } else if (action === 'submit') {
                server.handlers.dispatch = async () => {};
                server.handleByte(session, 13);
                await waitImmediate();
            } else if (action === 'stop') {
                await server.stop();
            } else if (action === 'view') {
                session.view = 'config';
            } else {
                server.moveCursor(session, -1);
            }
            const expectedLine = session.line;
            const expectedCursor = session.cursor;
            session.clearOutput();
            result.resolve([{ value: 'alpha', description: 'Delayed target' }]);
            await pending;
            assert.strictEqual(session.line, expectedLine, `${mode} ${action} must not replace newer input`);
            assert.strictEqual(session.cursor, expectedCursor, `${mode} ${action} must not move the cursor`);
            assert.strictEqual(session.readOutput(), '', `${mode} ${action} must not render a stale result`);
        }
    }
    console.log('[cli] delayed completion and help preserve changed input and closed sessions.');
}

async function runCrossedAssistanceCase() {
    for (const [firstMode, secondMode] of [
        ['showInlineHelp', 'completeLine'],
        ['completeLine', 'showInlineHelp']
    ]) {
        const server = createServer();
        const session = createSession();
        registerTestParameterCommand(server);
        const started = createDeferred();
        const result = createDeferred();
        let calls = 0;
        server.registerParameterProvider('test.targets', async () => {
            calls += 1;
            if (calls === 1) {
                started.resolve();
                return result.promise;
            }
            return [{ value: 'alpha', description: 'Current target' }];
        });
        session.line = 'inspect site 4 target a';
        session.cursor = session.line.length;
        const first = server[firstMode](session);
        await started.promise;
        await server[secondMode](session);
        const expectedLine = session.line;
        const expectedCursor = session.cursor;
        session.clearOutput();
        result.resolve([{ value: 'amber', description: 'Outdated target' }]);
        await first;
        assert.strictEqual(session.line, expectedLine, `${secondMode} must supersede pending ${firstMode}`);
        assert.strictEqual(session.cursor, expectedCursor, `${firstMode} must not move the newer cursor`);
        assert.strictEqual(session.readOutput(), '', `${firstMode} must not render after newer ${secondMode}`);
    }
    console.log('[cli] help and Tab supersede older assistance requests.');
}

async function runRepeatedAsyncTabCase() {
    const server = createServer();
    const session = createSession();
    registerTestParameterCommand(server);
    const started = createDeferred();
    const result = createDeferred();
    let queries = 0;
    server.registerParameterProvider('test.targets', async () => {
        queries += 1;
        started.resolve();
        return result.promise;
    });
    session.line = 'inspect site 4 target a';
    session.cursor = session.line.length;
    const firstTab = server.completeLine(session);
    await started.promise;
    const secondTab = server.completeLine(session);
    result.resolve([
        { value: 'alpha', description: 'First target' },
        { value: 'amber', description: 'Second target' }
    ]);
    await Promise.all([firstTab, secondTab]);
    assert.strictEqual(queries, 1, 'repeated pending Tab must share one provider query');
    assert.strictEqual(session.line, 'inspect site 4 target amber', 'two Tabs must select the second candidate');
    assertText(session.readOutput(), ['<string(1-128)>', 'Target name'], 'repeated Tab original type rendering');
    await server.completeLine(session);
    assert.strictEqual(session.line, 'inspect site 4 target alpha', 'the next Tab must cycle from the original prefix');
    console.log('[cli] repeated async Tab queries once and cycles candidates.');
}

async function main() {
    const server = createServer();
    const session = createSession();
    server.sessions.set(session.lineId, session);

    const registeredSyntaxKeys = getCommandSyntaxKeys(server);
    const coveredSyntaxKeys = new Set();

    for (const item of helpCases) {
        await runHelpCase(server, session, item);
    }
    for (const item of completionCases) {
        await runCompletionCase(server, session, item);
    }
    await runDynamicBmpParameterCase();
    await runGenericParameterProviderCase();
    await runGenericOpaqueParameterCase();
    await runOpaqueKeywordBoundaryCase();
    runOpaqueRegistrationGuardCase();
    await runAsyncParameterInputCase();
    await runCrossedAssistanceCase();
    await runRepeatedAsyncTabCase();
    await runMorePagerCase();
    await runTerminalLengthZeroPagerCase();
    await runRouteKeyRoundTripCase(mockEvpnRoute, 'EVPN', 'l2vpn-evpn');
    await runRouteKeyRoundTripCase(createQuotedRouteKeyRoute(), 'quoted JSON EVPN', 'l2vpn-evpn');
    await runRouteKeyRoundTripCase(createLongFlowSpecRoute(), 'long FlowSpec', 'ipv4-flowspec');
    await runStateRouteKeyCase();

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
