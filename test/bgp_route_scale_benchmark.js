const BgpConst = require('../electron/const/bgpConst');
const BgpInstance = require('../electron/worker/bgpInstance');
const BgpRoute = require('../electron/worker/bgpRoute');
const { forEachGeneratedRouteIp } = require('../electron/utils/ipUtils');

const DEFAULT_ROUTE_COUNT = 1_000_000;
const DEFAULT_PAGE_SIZE = 10;
const AFI = BgpConst.BGP_AFI_TYPE.AFI_IPV4;
const SAFI = BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST;

function getArgValue(name, defaultValue) {
    const prefix = `--${name}=`;
    const arg = process.argv.find(item => item.startsWith(prefix));
    if (!arg) {
        return defaultValue;
    }

    const value = Number(arg.slice(prefix.length));
    return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

function hasArg(name) {
    return process.argv.includes(`--${name}`);
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

function printMemory(label) {
    const usage = process.memoryUsage();
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

function buildInstance(routeCount) {
    const instance = new BgpInstance(0, AFI, SAFI);
    const generatedCount = forEachGeneratedRouteIp(
        BgpConst.IP_TYPE.IPV4,
        '10.0.0.0',
        32,
        routeCount,
        route => {
            const bgpRoute = new BgpRoute(instance);
            bgpRoute.ip = route.ip;
            bgpRoute.mask = route.mask;
            bgpRoute.asPath = '65000 65001';
            bgpRoute.med = 0;
            bgpRoute.localPref = 100;
            bgpRoute.nextHop = '192.0.2.1';
            bgpRoute.origin = 'IGP';

            instance.routeMap.set(BgpRoute.makeKey(route.ip, route.mask), bgpRoute);
        }
    );

    if (generatedCount !== routeCount || instance.routeMap.size !== routeCount) {
        throw new Error(`unexpected route count: generated=${generatedCount}, stored=${instance.routeMap.size}`);
    }

    return instance;
}

function getPagedRoutes(instance, page, pageSize) {
    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const currentPageSize = Math.max(1, parseInt(pageSize, 10) || 10);
    const total = instance.routeMap.size;
    const startIndex = (currentPage - 1) * currentPageSize;
    const list = [];

    let index = 0;
    for (const route of instance.routeMap.values()) {
        if (index >= startIndex) {
            list.push(route.getRouteInfo());
            if (list.length >= currentPageSize) {
                break;
            }
        }
        index += 1;
    }

    return { list, total };
}

function getPagedRoutesLegacy(instance, page, pageSize) {
    const routes = [];
    instance.routeMap.forEach(route => {
        routes.push(route.getRouteInfo());
    });

    return {
        list: routes.slice((page - 1) * pageSize, page * pageSize),
        total: routes.length
    };
}

function assertPage(result, routeCount, page, pageSize) {
    const expectedLength = Math.max(0, Math.min(pageSize, routeCount - (page - 1) * pageSize));
    if (result.total !== routeCount || result.list.length !== expectedLength) {
        throw new Error(
            `unexpected page result: page=${page}, total=${result.total}, list=${result.list.length}, expected=${expectedLength}`
        );
    }
}

function deleteRoutes(instance, routeCount) {
    const deletedCount = forEachGeneratedRouteIp(BgpConst.IP_TYPE.IPV4, '10.0.0.0', 32, routeCount, route => {
        instance.routeMap.delete(BgpRoute.makeKey(route.ip, route.mask));
    });

    if (deletedCount !== routeCount || instance.routeMap.size !== 0) {
        throw new Error(`unexpected delete result: deleted=${deletedCount}, stored=${instance.routeMap.size}`);
    }
}

function main() {
    const routeCount = getArgValue('routes', DEFAULT_ROUTE_COUNT);
    const pageSize = getArgValue('pageSize', DEFAULT_PAGE_SIZE);
    const firstPage = 1;
    const lastPage = Math.ceil(routeCount / pageSize);
    const middlePage = Math.max(firstPage, Math.floor(lastPage / 2));

    console.log(`BGP route scale benchmark: routes=${routeCount}, pageSize=${pageSize}`);
    console.log('Note: this measures local routeMap storage and pagination, not peer UPDATE encoding/sending.');
    printMemory('before');

    const { result: instance } = timeStep('stream-generate routes into routeMap', () => buildInstance(routeCount));
    printMemory('after build');

    timeStep('first page serialization', () => {
        const result = getPagedRoutes(instance, firstPage, pageSize);
        assertPage(result, routeCount, firstPage, pageSize);
    });

    timeStep(`middle page serialization (page ${middlePage})`, () => {
        const result = getPagedRoutes(instance, middlePage, pageSize);
        assertPage(result, routeCount, middlePage, pageSize);
    });

    timeStep(`last page serialization (page ${lastPage})`, () => {
        const result = getPagedRoutes(instance, lastPage, pageSize);
        assertPage(result, routeCount, lastPage, pageSize);
    });

    timeStep('route detail serialization by key', () => {
        const key = BgpRoute.makeKey(ipFromIndex(Math.floor(routeCount / 2)), 32);
        const route = instance.routeMap.get(key);
        if (!route) {
            throw new Error(`route not found: ${key}`);
        }
        route.getRouteInfo();
    });

    if (hasArg('legacy')) {
        timeStep('legacy full-list serialization + slice', () => {
            const result = getPagedRoutesLegacy(instance, firstPage, pageSize);
            assertPage(result, routeCount, firstPage, pageSize);
        });
        printMemory('after legacy page');
    }

    timeStep('stream-delete generated routes from routeMap', () => deleteRoutes(instance, routeCount));
    printMemory('after delete');
}

main();
