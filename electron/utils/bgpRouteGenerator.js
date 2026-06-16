const ipaddr = require('ipaddr.js');
const BgpConst = require('../const/bgpConst');
const { forEachGeneratedRouteIp } = require('./ipUtils');

const MAX_QP_DQPN = 0xffffff;
const MAX_IPV6_INT = (1n << 128n) - 1n;
const MAX_IPV4_INT = (1n << 32n) - 1n;

function normalizePositiveInteger(value, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.floor(number);
}

function normalizeOptionalPositiveInteger(value, fallback = 1) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    return Number(value);
}

function normalizeQpRouteGrowthMode(mode) {
    return Object.values(BgpConst.BGP_QP_ROUTE_GROWTH_MODE).includes(mode)
        ? mode
        : BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN;
}

function normalizeQpBsidMode(mode) {
    return Object.values(BgpConst.BGP_QP_BSID_MODE).includes(mode) ? mode : BgpConst.BGP_QP_BSID_MODE.FIXED;
}

function routeGrowthIncludesIp(mode) {
    return mode === BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP || mode === BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN;
}

function routeGrowthIncludesDqpn(mode) {
    return mode === BgpConst.BGP_QP_ROUTE_GROWTH_MODE.DQPN || mode === BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN;
}

function ipToBigInt(ip, ipType) {
    const address = ipaddr.parse(ip);
    const expectedKind = ipType === BgpConst.IP_TYPE.IPV4 ? 'ipv4' : 'ipv6';
    if (address.kind() !== expectedKind) {
        throw new Error(ipType === BgpConst.IP_TYPE.IPV4 ? '请输入有效的IPv4地址' : '请输入有效的IPv6地址');
    }

    return address.toByteArray().reduce((result, byte) => (result << 8n) + BigInt(byte), 0n);
}

function getIpRouteStep(ipType, mask, ipStep) {
    const maxMask = ipType === BgpConst.IP_TYPE.IPV4 ? 32 : 128;
    const routeStep = mask === maxMask ? 1n : 1n << BigInt(maxMask - mask);
    return routeStep * BigInt(ipStep);
}

function ipv6ToBigInt(ip) {
    const address = ipaddr.parse(ip);
    if (address.kind() !== 'ipv6') {
        throw new Error('BSID必须是IPv6地址');
    }

    return address.toByteArray().reduce((result, byte) => (result << 8n) + BigInt(byte), 0n);
}

function bigIntToIpv6(value) {
    const bytes = [];
    for (let i = 15; i >= 0; i--) {
        bytes[i] = Number(value & 0xffn);
        value >>= 8n;
    }

    return ipaddr.fromByteArray(bytes).toString();
}

function getQpBaseRoute(ipType, prefix, mask) {
    let baseRoute = null;
    forEachGeneratedRouteIp(ipType, prefix, mask, 1, route => {
        baseRoute = route;
    });
    if (!baseRoute) {
        throw new Error('QP路由前缀配置无效');
    }
    return baseRoute;
}

function buildQpGenerationContext(config, ipType, options = {}) {
    const requireBsid = options.requireBsid !== false;
    const routeGrowthMode = normalizeQpRouteGrowthMode(config.routeGrowthMode);
    const bsidMode = normalizeQpBsidMode(config.bsidMode);
    const growIp = routeGrowthIncludesIp(routeGrowthMode);
    const growDqpn = routeGrowthIncludesDqpn(routeGrowthMode);

    const count = normalizePositiveInteger(config.count, 0);
    if (count <= 0) {
        return { count: 0 };
    }

    const ipStep = normalizeOptionalPositiveInteger(config.ipStep, 1);
    if (growIp) {
        if (!Number.isInteger(ipStep) || ipStep <= 0) {
            throw new Error('IP步长必须为正整数');
        }
        const startIp = ipToBigInt(config.prefix, ipType);
        const mask = normalizePositiveInteger(config.mask, NaN);
        const maxMask = ipType === BgpConst.IP_TYPE.IPV4 ? 32 : 128;
        if (!Number.isInteger(mask) || mask < 1 || mask > maxMask) {
            throw new Error(ipType === BgpConst.IP_TYPE.IPV4 ? '请输入有效的IPv4掩码' : '请输入有效的IPv6掩码');
        }
        const lastIp = startIp + BigInt(count - 1) * getIpRouteStep(ipType, mask, ipStep);
        const maxIp = ipType === BgpConst.IP_TYPE.IPV4 ? MAX_IPV4_INT : MAX_IPV6_INT;
        if (lastIp > maxIp) {
            throw new Error('IP连续生成超出地址范围');
        }
    }

    const startDqpn = normalizePositiveInteger(config.startDqpn, 0);
    const dqpnStep = normalizePositiveInteger(config.dqpnStep, 1);
    if (!Number.isInteger(startDqpn) || startDqpn < 0 || startDqpn > MAX_QP_DQPN) {
        throw new Error('DQPN范围为 0 ~ 16777215（24bit）');
    }
    if (growDqpn) {
        if (!Number.isInteger(dqpnStep) || dqpnStep <= 0) {
            throw new Error('DQPN步长必须为正整数');
        }
        const lastDqpn = startDqpn + (count - 1) * dqpnStep;
        if (lastDqpn > MAX_QP_DQPN) {
            throw new Error('DQPN连续生成超出 24bit 范围');
        }
    }

    const baseRoute = growIp ? null : getQpBaseRoute(ipType, config.prefix, config.mask);
    const bsidBase = `${config.bsid || ''}`.trim();
    if (requireBsid && !bsidBase) {
        throw new Error('请输入BSID');
    }
    const resolveBsid = requireBsid || Boolean(bsidBase);
    let bsidBaseInt = null;
    let bsidStep = 0n;
    if (resolveBsid && bsidMode === BgpConst.BGP_QP_BSID_MODE.CONTINUOUS) {
        bsidBaseInt = ipv6ToBigInt(bsidBase);
        bsidStep = BigInt(normalizePositiveInteger(config.bsidStep, 1));
        if (bsidStep <= 0n) {
            throw new Error('BSID步长必须为正整数');
        }
        if (bsidBaseInt + BigInt(count - 1) * bsidStep > MAX_IPV6_INT) {
            throw new Error('BSID连续生成超出IPv6地址范围');
        }
    } else if (resolveBsid) {
        ipv6ToBigInt(bsidBase);
    }

    return {
        count,
        bsidMode,
        growIp,
        growDqpn,
        ipStep,
        startDqpn,
        dqpnStep,
        baseRoute,
        bsidBase,
        bsidBaseInt,
        bsidStep,
        resolveBsid
    };
}

function forEachQpGeneratedRoute(config, ipType, callback, options = {}) {
    const context = buildQpGenerationContext(config, ipType, options);
    if (context.count === 0 || typeof callback !== 'function') {
        return 0;
    }

    const emit = (route, index) => {
        const dqpn = context.growDqpn ? context.startDqpn + index * context.dqpnStep : context.startDqpn;
        const bsid =
            context.resolveBsid && context.bsidMode === BgpConst.BGP_QP_BSID_MODE.CONTINUOUS
                ? bigIntToIpv6(context.bsidBaseInt + BigInt(index) * context.bsidStep)
                : context.bsidBase;

        callback({ ip: route.ip, mask: route.mask, dqpn, bsid }, index);
    };

    if (context.growIp) {
        return forEachGeneratedRouteIp(ipType, config.prefix, config.mask, context.count, emit, context.ipStep);
    }

    for (let index = 0; index < context.count; index++) {
        emit(context.baseRoute, index);
    }

    return context.count;
}

function getMvpnBaseIp(config) {
    if (config.routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD) {
        return config.originatingRouterIp;
    }

    if (
        config.routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.S_PMSI_AD ||
        config.routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD ||
        config.routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN ||
        config.routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
    ) {
        return config.groupIp;
    }

    return '';
}

function forEachMvpnGeneratedRoute(config, callback) {
    const emit = ipObj => {
        const currentIp = ipObj.ip;
        let currentGroupIp = config.groupIp;
        let currentOrigRouterIp = config.originatingRouterIp;

        if (config.routeType === BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD) {
            currentOrigRouterIp = currentIp;
        } else if (
            [
                BgpConst.BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD,
                BgpConst.BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
                BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
            ].includes(config.routeType)
        ) {
            currentGroupIp = currentIp;
        }

        const route = {
            addressFamily: config.addressFamily,
            routeType: config.routeType,
            rd: config.rd,
            rt: config.rt || null,
            sourceAs: null,
            sourceIp: null,
            groupIp: null,
            originatingRouterIp: null
        };

        switch (config.routeType) {
            case BgpConst.BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD:
                route.originatingRouterIp = currentOrigRouterIp;
                break;
            case BgpConst.BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD:
                route.sourceAs = config.sourceAs;
                break;
            case BgpConst.BGP_MVPN_ROUTE_TYPE.S_PMSI_AD:
                route.sourceIp = config.sourceIp;
                route.groupIp = currentGroupIp;
                route.originatingRouterIp = config.originatingRouterIp;
                break;
            case BgpConst.BGP_MVPN_ROUTE_TYPE.LEAF_AD:
                route.originatingRouterIp = config.originatingRouterIp;
                break;
            case BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD:
                route.sourceIp = config.sourceIp;
                route.groupIp = currentGroupIp;
                break;
            case BgpConst.BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN:
                route.sourceAs = config.sourceAs;
                route.groupIp = currentGroupIp;
                break;
            case BgpConst.BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN:
                route.sourceAs = config.sourceAs;
                route.sourceIp = config.sourceIp;
                route.groupIp = currentGroupIp;
                break;
        }

        callback(route);
    };

    const baseIp = getMvpnBaseIp(config);
    if (baseIp) {
        return forEachGeneratedRouteIp(BgpConst.IP_TYPE.IPV4, baseIp, BgpConst.IP_HOST_LEN, config.count, emit);
    }

    emit({ ip: '' });
    return 1;
}

function collectBgpGeneratedRoutes(config, options = {}) {
    const routes = [];
    const addressFamily = config.addressFamily;

    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC || addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_UNC) {
        const ipType =
            addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_UNC ? BgpConst.IP_TYPE.IPV4 : BgpConst.IP_TYPE.IPV6;
        forEachGeneratedRouteIp(ipType, config.prefix, config.mask, config.count, route => {
            routes.push({
                addressFamily,
                ip: route.ip,
                mask: route.mask,
                customAttr: config.customAttr || null,
                rt: config.rt || null
            });
        });
        return routes;
    }

    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_MVPN) {
        forEachMvpnGeneratedRoute(config, route => routes.push(route));
        return routes;
    }

    if (addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_QP || addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV6_QP) {
        const ipType =
            addressFamily === BgpConst.BGP_ADDR_FAMILY.IPV4_QP ? BgpConst.IP_TYPE.IPV4 : BgpConst.IP_TYPE.IPV6;
        forEachQpGeneratedRoute(
            config,
            ipType,
            route => {
                routes.push({
                    addressFamily,
                    ip: route.ip,
                    mask: route.mask,
                    dqpn: route.dqpn,
                    nextHop: route.bsid,
                    customAttr: config.customAttr || null
                });
            },
            options
        );
        return routes;
    }

    return routes;
}

module.exports = {
    collectBgpGeneratedRoutes,
    forEachMvpnGeneratedRoute,
    forEachQpGeneratedRoute
};
