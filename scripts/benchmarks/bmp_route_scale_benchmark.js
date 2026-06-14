const BmpConst = require('../../electron/const/bmpConst');
const BgpConst = require('../../electron/const/bgpConst');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const RouteUpdateAggregator = require('../../electron/utils/routeUpdateAggregator');
const { buildRoutePrefixQuery, routeMatchesPrefixQuery } = require('../../electron/utils/routePrefixUtils');

const DEFAULT_ROUTE_COUNT = 1_000_000;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;
const AFI = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
const SAFI = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;
const RIB_TYPE = BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN;

function getArgValue(name, defaultValue) {
    const prefix = `--${name}=`;
    const arg = process.argv.find(item => item.startsWith(prefix));
    if (!arg) {
        return defaultValue;
    }
    const value = Number(arg.slice(prefix.length));
    return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

function formatMs(ms) {
    return `${ms.toFixed(2)} ms`;
}

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(2)} ${units[index]}`;
}

function getMemoryUsage() {
    const usage = process.memoryUsage();
    return {
        rss: usage.rss,
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        external: usage.external
    };
}

function printMemory(label) {
    const usage = getMemoryUsage();
    console.log(
        `${label}: rss=${formatBytes(usage.rss)}, heapUsed=${formatBytes(usage.heapUsed)}, heapTotal=${formatBytes(
            usage.heapTotal
        )}, external=${formatBytes(usage.external)}`
    );
}

function timeStep(label, fn) {
    const start = process.hrtime.bigint();
    const result = fn();
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    console.log(`${label}: ${formatMs(ms)}`);
    return { result, ms };
}

function ipFromIndex(index) {
    const second = (index >>> 16) & 0xff;
    const third = (index >>> 8) & 0xff;
    const fourth = index & 0xff;
    return `10.${second}.${third}.${fourth}`;
}

function makeRoute(session, index) {
    const route = new BmpBgpRoute(session, null);
    route.pathId = 0;
    route.rd = '0:0';
    route.ip = ipFromIndex(index);
    route.mask = 32;
    route.afi = AFI;
    route.safi = SAFI;
    route.origin = 'IGP';
    route.asPath = '65000 65001';
    route.nextHop = '192.0.2.1';
    route.med = index % 100;
    route.localPref = 100;
    route.routeState = BmpConst.BMP_ROUTE_STATE.ACTIVE;
    return route;
}

function buildSession(routeCount) {
    const session = new BmpBgpSession(null);
    session.sessionType = 0;
    session.sessionRd = '0:0';
    session.sessionIp = '192.0.2.254';
    session.sessionAs = 65000;
    session.bgpRoutes.set(`${AFI}|${SAFI}`, new Map([[RIB_TYPE, new Map()]]));
    session.ribTypes.push(RIB_TYPE);
    session.enabledAddressFamilies.push({ afi: AFI, safi: SAFI });

    const routeMap = session.bgpRoutes.get(`${AFI}|${SAFI}`).get(RIB_TYPE);
    for (let i = 0; i < routeCount; i += 1) {
        const route = makeRoute(session, i);
        const routeKey = route.getRouteKey();
        routeMap.set(routeKey, route);
        session.recordRouteAdd(AFI, SAFI, RIB_TYPE, route);
        session.addRouteToPrefixIndex(AFI, SAFI, RIB_TYPE, routeKey, route);
    }

    return { session, routeMap };
}

function getPagedRouteResult(routeMap, options) {
    const page = Math.max(1, Number(options.page) || 1);
    const pageSize = Math.max(1, Number(options.pageSize) || 10);
    const routeState = options.routeState || BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE;
    const prefixQuery = buildRoutePrefixQuery(options.prefixFilter);
    const start = (page - 1) * pageSize;
    const list = [];
    let total = 0;

    const isRouteStateMatched = route => {
        if (routeState === BmpConst.BMP_ROUTE_STATE_FILTER.ALL) {
            return true;
        }
        const state = route.routeState || BmpConst.BMP_ROUTE_STATE.ACTIVE;
        return state === routeState;
    };

    const appendRoute = route => {
        if (!route || !isRouteStateMatched(route)) {
            return;
        }
        if (
            (prefixQuery.mode === 'scan' || prefixQuery.mode === 'index-or-scan') &&
            !routeMatchesPrefixQuery(route, prefixQuery)
        ) {
            return;
        }
        if (total >= start && list.length < pageSize) {
            list.push(route.getRouteListInfo());
        }
        total += 1;
    };

    const canUsePrefixIndex =
        (prefixQuery.mode === 'index' || prefixQuery.mode === 'index-or-scan') &&
        typeof options.getIndexedRouteKeys === 'function';
    const indexedRouteKeys = canUsePrefixIndex ? options.getIndexedRouteKeys(prefixQuery.key) : [];

    if (canUsePrefixIndex && (prefixQuery.mode === 'index' || indexedRouteKeys.length > 0)) {
        indexedRouteKeys.forEach(routeKey => {
            appendRoute(routeMap.get(routeKey));
        });
    } else {
        routeMap.forEach(route => {
            appendRoute(route);
        });
    }

    return { list, total };
}

function main() {
    const routeCount = getArgValue('routes', DEFAULT_ROUTE_COUNT);
    const page = getArgValue('page', DEFAULT_PAGE);
    const pageSize = getArgValue('pageSize', DEFAULT_PAGE_SIZE);
    const exactPrefix = ipFromIndex(Math.floor(routeCount / 2));
    const missingPrefix = '203.0.113.255';
    const scanText = '.255';

    console.log(`BMP route scale benchmark: routes=${routeCount}, page=${page}, pageSize=${pageSize}`);
    printMemory('before');

    const { result: built } = timeStep('build route map + prefix index + route summary', () =>
        buildSession(routeCount)
    );
    const { session, routeMap } = built;
    printMemory('after build');

    timeStep('route update aggregation enqueue x routes', () => {
        const aggregator = new RouteUpdateAggregator();
        const update = {
            type: BmpConst.BMP_ROUTE_UPDATE_TYPE.ROUTE_UPDATE,
            client: {
                localIp: '127.0.0.1',
                localPort: 1790,
                remoteIp: '192.0.2.254',
                remotePort: 50000
            },
            session: {
                sessionType: 0,
                sessionRd: '0:0',
                sessionIp: '192.0.2.254',
                sessionAs: 65000
            },
            af: 1,
            ribType: RIB_TYPE
        };
        for (let i = 0; i < routeCount; i += 1) {
            aggregator.enqueueRouteUpdate(update);
        }
        const flushed = aggregator.flushRouteUpdates();
        if (flushed.length !== 1 || flushed[0].changedCount !== routeCount) {
            throw new Error(`unexpected aggregation result: ${JSON.stringify(flushed[0])}`);
        }
    });

    timeStep('read maintained route summary', () => {
        const summary = session.getRouteSummary(AFI, SAFI, RIB_TYPE);
        if (summary.total !== routeCount || summary.active !== routeCount) {
            throw new Error(`unexpected summary: ${JSON.stringify(summary)}`);
        }
    });

    timeStep('exact prefix indexed query + page serialization', () => {
        const result = getPagedRouteResult(routeMap, {
            page,
            pageSize,
            routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
            prefixFilter: exactPrefix,
            getIndexedRouteKeys: prefixKey => session.getRouteKeysByPrefix(AFI, SAFI, RIB_TYPE, prefixKey)
        });
        if (result.total !== 1 || result.list.length !== 1) {
            throw new Error(`unexpected exact query result: total=${result.total}, list=${result.list.length}`);
        }
    });

    timeStep('missing exact prefix indexed query', () => {
        const result = getPagedRouteResult(routeMap, {
            page,
            pageSize,
            routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
            prefixFilter: missingPrefix,
            getIndexedRouteKeys: prefixKey => session.getRouteKeysByPrefix(AFI, SAFI, RIB_TYPE, prefixKey)
        });
        if (result.total !== 0 || result.list.length !== 0) {
            throw new Error(`unexpected missing query result: total=${result.total}, list=${result.list.length}`);
        }
    });

    timeStep('first page serialization without prefix filter', () => {
        const result = getPagedRouteResult(routeMap, {
            page,
            pageSize,
            routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
            prefixFilter: '',
            getIndexedRouteKeys: prefixKey => session.getRouteKeysByPrefix(AFI, SAFI, RIB_TYPE, prefixKey)
        });
        if (result.total !== routeCount || result.list.length !== pageSize) {
            throw new Error(`unexpected page result: total=${result.total}, list=${result.list.length}`);
        }
    });

    timeStep('route detail lookup by route key', () => {
        const routeKey = BmpBgpRoute.makeKey(0, '0:0', exactPrefix, 32);
        const route = routeMap.get(routeKey);
        const detail = route ? route.getRouteInfo({ includeSummary: false }) : null;
        if (!detail || detail.routeKey !== routeKey) {
            throw new Error(`unexpected detail lookup: ${routeKey}`);
        }
    });

    timeStep('short text scan query + first page serialization', () => {
        const result = getPagedRouteResult(routeMap, {
            page,
            pageSize,
            routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
            prefixFilter: scanText,
            getIndexedRouteKeys: prefixKey => session.getRouteKeysByPrefix(AFI, SAFI, RIB_TYPE, prefixKey)
        });
        if (result.total === 0 || result.list.length === 0) {
            throw new Error(`unexpected scan result: total=${result.total}, list=${result.list.length}`);
        }
    });

    printMemory('after queries');
}

main();
