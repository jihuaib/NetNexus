const fs = require('fs');
const path = require('path');
const BgpConst = require('../const/bgpConst');
const { fileExists, ensureParentDir, writeLine, closeWriteStream, renameWithRetry } = require('./rpkiRoaImport');

function getBgpRouteDataFilePath(userDataPath, addressFamily = null) {
    const normalizedAddressFamily = addressFamily === null ? null : normalizeAddressFamily(addressFamily);
    if (normalizedAddressFamily) {
        return path.join(userDataPath, `bgp-routes-${normalizedAddressFamily}.jsonl`);
    }

    return path.join(userDataPath, 'bgp-routes.jsonl');
}

function normalizeAddressFamily(value) {
    const addressFamily = Number(value);
    return Object.values(BgpConst.BGP_ADDR_FAMILY).includes(addressFamily) ? addressFamily : null;
}

function pickDefinedRouteField(route, field) {
    return route[field] === undefined ? null : route[field];
}

function normalizeBgpRouteObject(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
    }

    const addressFamily = normalizeAddressFamily(item.addressFamily);
    if (!addressFamily) {
        return null;
    }

    const route = {
        addressFamily,
        ip: pickDefinedRouteField(item, 'ip'),
        mask: pickDefinedRouteField(item, 'mask'),
        asPath: pickDefinedRouteField(item, 'asPath'),
        med: pickDefinedRouteField(item, 'med'),
        localPref: pickDefinedRouteField(item, 'localPref'),
        communities: Array.isArray(item.communities) ? item.communities : pickDefinedRouteField(item, 'communities'),
        nextHop: pickDefinedRouteField(item, 'nextHop'),
        origin: pickDefinedRouteField(item, 'origin'),
        customAttr: pickDefinedRouteField(item, 'customAttr'),
        rt: pickDefinedRouteField(item, 'rt'),
        label: pickDefinedRouteField(item, 'label'),
        srv6Sid: pickDefinedRouteField(item, 'srv6Sid'),
        srv6EndpointBehavior: pickDefinedRouteField(item, 'srv6EndpointBehavior'),
        routeType: pickDefinedRouteField(item, 'routeType'),
        rd: pickDefinedRouteField(item, 'rd'),
        originatingRouterIp: pickDefinedRouteField(item, 'originatingRouterIp'),
        sourceIp: pickDefinedRouteField(item, 'sourceIp'),
        groupIp: pickDefinedRouteField(item, 'groupIp'),
        sourceAs: pickDefinedRouteField(item, 'sourceAs'),
        dqpn: pickDefinedRouteField(item, 'dqpn')
    };

    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC || addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC) {
        return route.ip && route.mask !== null ? route : null;
    }

    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN) {
        return route.routeType && route.rd ? route : null;
    }

    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) {
        return route.ip && route.mask !== null && route.label !== null ? route : null;
    }

    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_QP || addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_QP) {
        return route.ip && route.mask !== null && route.dqpn !== null ? route : null;
    }

    return route.ip && route.mask !== null ? route : null;
}

function makeBgpRouteStorageKey(route) {
    const normalizedRoute = normalizeBgpRouteObject(route);
    if (!normalizedRoute) {
        return null;
    }

    const addressFamily = normalizedRoute.addressFamily;
    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN) {
        return [
            addressFamily,
            normalizedRoute.routeType,
            normalizedRoute.rd,
            normalizedRoute.sourceAs || '',
            normalizedRoute.sourceIp || '',
            normalizedRoute.groupIp || '',
            normalizedRoute.originatingRouterIp || ''
        ].join('|');
    }

    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_QP || addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_QP) {
        return [addressFamily, normalizedRoute.dqpn, normalizedRoute.ip, normalizedRoute.mask].join('|');
    }

    return [addressFamily, normalizedRoute.ip, normalizedRoute.mask].join('|');
}

function safeJsonParse(line) {
    try {
        return JSON.parse(line);
    } catch (_) {
        return null;
    }
}

async function* iterateJsonlBgpRoutes(filePath) {
    if (!(await fileExists(filePath))) {
        return;
    }

    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    let rest = '';

    try {
        for await (const chunk of input) {
            const lines = `${rest}${chunk}`.split(/\r?\n/);
            rest = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                const route = normalizeBgpRouteObject(safeJsonParse(trimmed));
                if (route) {
                    yield route;
                }
            }
        }

        const trimmed = rest.trim();
        if (trimmed) {
            const route = normalizeBgpRouteObject(safeJsonParse(trimmed));
            if (route) {
                yield route;
            }
        }
    } finally {
        if (!input.closed && !input.destroyed) {
            input.destroy();
        }
    }
}

async function countBgpRoutes(filePath, addressFamily = null) {
    const normalizedAddressFamily = addressFamily ? normalizeAddressFamily(addressFamily) : null;
    let count = 0;
    for await (const route of iterateJsonlBgpRoutes(filePath)) {
        if (!normalizedAddressFamily || route.addressFamily === normalizedAddressFamily) {
            count += 1;
        }
    }
    return count;
}

async function readBgpRouteJsonlPage(filePath, addressFamily, page, pageSize) {
    const normalizedAddressFamily = normalizeAddressFamily(addressFamily);
    if (!normalizedAddressFamily) {
        return {
            items: [],
            total: 0,
            page: Math.max(1, Number(page) || 1),
            pageSize: Math.min(1000, Math.max(1, Number(pageSize) || 10))
        };
    }

    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.min(1000, Math.max(1, Number(pageSize) || 10));
    const startIndex = (safePage - 1) * safePageSize;
    const endIndex = startIndex + safePageSize;
    const items = [];
    let index = 0;
    let total = 0;

    for await (const route of iterateJsonlBgpRoutes(filePath)) {
        if (route.addressFamily !== normalizedAddressFamily) {
            continue;
        }

        if (index >= startIndex && index < endIndex) {
            items.push(route);
        }
        index += 1;
        total += 1;
    }

    return {
        items,
        total,
        page: safePage,
        pageSize: safePageSize
    };
}

async function upsertBgpRoutesToJsonl(filePath, routes) {
    await ensureParentDir(filePath);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.upsert.tmp`;
    const stream = fs.createWriteStream(tempPath, { encoding: 'utf8' });
    const incomingRoutes = new Map();

    for (const route of routes || []) {
        const normalizedRoute = normalizeBgpRouteObject(route);
        const key = normalizedRoute ? makeBgpRouteStorageKey(normalizedRoute) : null;
        if (key) {
            incomingRoutes.set(key, normalizedRoute);
        }
    }

    let total = 0;
    let added = 0;
    let updated = 0;
    let unchanged = 0;

    try {
        for await (const existingRoute of iterateJsonlBgpRoutes(filePath)) {
            const key = makeBgpRouteStorageKey(existingRoute);
            if (key && incomingRoutes.has(key)) {
                const nextRoute = incomingRoutes.get(key);
                incomingRoutes.delete(key);
                if (JSON.stringify(existingRoute) === JSON.stringify(nextRoute)) {
                    unchanged += 1;
                } else {
                    updated += 1;
                }
                await writeLine(stream, JSON.stringify(nextRoute));
                total += 1;
                continue;
            }

            await writeLine(stream, JSON.stringify(existingRoute));
            total += 1;
        }

        for (const route of incomingRoutes.values()) {
            await writeLine(stream, JSON.stringify(route));
            added += 1;
            total += 1;
        }

        await closeWriteStream(stream);
        await renameWithRetry(tempPath, filePath);
        return { added, updated, unchanged, total };
    } catch (error) {
        stream.destroy();
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
    }
}

async function deleteBgpRoutesFromJsonl(filePath, routes) {
    await ensureParentDir(filePath);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.delete.tmp`;
    const stream = fs.createWriteStream(tempPath, { encoding: 'utf8' });
    const targetKeys = new Set(
        (routes || [])
            .map(route => makeBgpRouteStorageKey(route))
            .filter(key => typeof key === 'string' && key.length > 0)
    );

    let total = 0;
    let deleted = 0;

    try {
        for await (const existingRoute of iterateJsonlBgpRoutes(filePath)) {
            const key = makeBgpRouteStorageKey(existingRoute);
            if (targetKeys.has(key)) {
                deleted += 1;
                continue;
            }
            await writeLine(stream, JSON.stringify(existingRoute));
            total += 1;
        }

        await closeWriteStream(stream);
        await renameWithRetry(tempPath, filePath);
        return { deleted, total };
    } catch (error) {
        stream.destroy();
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
    }
}

async function deleteBgpRoutesByFamilyFromJsonl(filePath, addressFamily) {
    await ensureParentDir(filePath);
    const normalizedAddressFamily = normalizeAddressFamily(addressFamily);
    if (!normalizedAddressFamily) {
        throw new Error('不支持的BGP地址族');
    }

    const tempPath = `${filePath}.${process.pid}.${Date.now()}.delete-family.tmp`;
    const stream = fs.createWriteStream(tempPath, { encoding: 'utf8' });
    let total = 0;
    let deleted = 0;

    try {
        for await (const existingRoute of iterateJsonlBgpRoutes(filePath)) {
            if (existingRoute.addressFamily === normalizedAddressFamily) {
                deleted += 1;
                continue;
            }
            await writeLine(stream, JSON.stringify(existingRoute));
            total += 1;
        }

        await closeWriteStream(stream);
        await renameWithRetry(tempPath, filePath);
        return { deleted, total };
    } catch (error) {
        stream.destroy();
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
    }
}

async function clearBgpRouteJsonl(filePath) {
    await ensureParentDir(filePath);
    await fs.promises.writeFile(filePath, '', 'utf8');
    return { deleted: null, total: 0 };
}

module.exports = {
    getBgpRouteDataFilePath,
    normalizeBgpRouteObject,
    makeBgpRouteStorageKey,
    iterateJsonlBgpRoutes,
    countBgpRoutes,
    readBgpRouteJsonlPage,
    upsertBgpRoutesToJsonl,
    deleteBgpRoutesFromJsonl,
    deleteBgpRoutesByFamilyFromJsonl,
    clearBgpRouteJsonl
};
