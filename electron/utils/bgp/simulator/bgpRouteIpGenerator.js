const ipaddr = require('ipaddr.js');
const BgpConst = require('../../../const/bgpConst');

const QP_RANGE_START_BITS = [64, 80, 92, 96, 112];

function validateQpIpGenerationMode(config) {
    if (
        config.ipGenerationMode !== undefined &&
        !['fixed', 'increment', 'rangeIncrement'].includes(config.ipGenerationMode)
    )
        throw new Error(`QP IP生成方式不支持: ${config.ipGenerationMode}`);
}

/** Iterate QP DIP templates without retaining the generated routes. */
function* iterateQpRouteIpInputs(config, ipType) {
    validateQpIpGenerationMode(config);
    if (Array.isArray(config.routes)) {
        yield* config.routes;
        return;
    }

    const rangeIncrementIp = config.ipGenerationMode === 'rangeIncrement';
    const bits = ipType === BgpConst.IP_TYPE.IPV6 ? 128 : 32;
    const mask = Number(config.mask);
    const rangeStartBit = Number(config.ipRangeStartBit);
    if (rangeIncrementIp && ipType !== BgpConst.IP_TYPE.IPV6) throw new Error('QP指定范围递增仅支持IPv6地址族');
    if (rangeIncrementIp && mask !== 128) throw new Error('QP指定范围递增IPv6主机路由掩码必须为128');
    if (rangeIncrementIp && !QP_RANGE_START_BITS.includes(rangeStartBit))
        throw new Error('QP递增起始位必须为64、80、92、96或112');
    if (!Number.isInteger(mask) || mask < 0 || mask > bits) throw new Error('路由前缀长度无效');
    const address = ipaddr.parse(config.prefix);
    if ((address.kind() === 'ipv6' ? 128 : 32) !== bits) throw new Error('路由前缀地址族无效');
    const count = Number(config.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('QP路由数量必须为非负安全整数');

    if (rangeIncrementIp) {
        const ipStep = Number(config.ipStep ?? 1);
        if (!Number.isSafeInteger(ipStep) || ipStep <= 0) throw new Error('QP指定范围递增IP步长必须为正整数');
        const raw = address.toByteArray().reduce((value, byte) => value * 256n + BigInt(byte), 0n);
        const suffixMask = (1n << BigInt(128 - rangeStartBit)) - 1n;
        const remainingCount = (suffixMask - (raw & suffixMask)) / BigInt(ipStep) + 1n;
        if (BigInt(count) > remainingCount)
            throw new Error(`QP指定范围递增超出低位地址范围，当前起点及步长最多生成${remainingCount}条路由`);
        for (let index = 0; index < count; index += 1) {
            let value = raw + BigInt(index) * BigInt(ipStep);
            const bytes = Array(16).fill(0);
            for (let byte = 15; byte >= 0; byte -= 1) {
                bytes[byte] = Number(value & 255n);
                value >>= 8n;
            }
            yield { ip: ipaddr.fromByteArray(bytes).toString(), mask: 128 };
        }
        return;
    }

    const mode = config.routeGrowthMode ?? BgpConst.BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN;
    if (!Object.values(BgpConst.BGP_QP_ROUTE_GROWTH_MODE).includes(mode)) throw new Error('QP增长模式无效');
    const growIp = mode !== BgpConst.BGP_QP_ROUTE_GROWTH_MODE.DQPN;
    const ipStep = Number(config.ipStep ?? 1);
    if (!Number.isSafeInteger(ipStep) || ipStep < 0) throw new Error('QP IP步长必须为非负整数');
    const networkStep = 1n << BigInt(bits - mask);
    const raw = address.toByteArray().reduce((value, byte) => value * 256n + BigInt(byte), 0n);
    const base = (raw / networkStep) * networkStep;
    const step = growIp ? networkStep * BigInt(ipStep) : 0n;
    if (base + BigInt(Math.max(count - 1, 0)) * step > (1n << BigInt(bits)) - 1n)
        throw new Error('路由前缀递增超出地址范围');
    for (let index = 0; index < count; index += 1) {
        let number = base + BigInt(index) * step;
        const bytes = Array(bits / 8).fill(0);
        for (let byte = bytes.length - 1; byte >= 0; byte -= 1) {
            bytes[byte] = Number(number & 255n);
            number >>= 8n;
        }
        yield { ip: ipaddr.fromByteArray(bytes).toString(), mask, rd: config.rd, pathId: 0 };
    }
}

function normalizeRouteCount(routeCnt) {
    const count = Number(routeCnt);
    if (!Number.isFinite(count) || count <= 0) {
        return 0;
    }

    return Math.floor(count);
}

function normalizeRouteStep(routeStep) {
    const step = Number(routeStep);
    if (!Number.isFinite(step) || step <= 0) {
        return 1;
    }

    return Math.max(1, Math.floor(step));
}

/**
 * Iterate generated IP networks without materializing the full list.
 * @param {number} routeType - IP_TYPE.IPV4 or IP_TYPE.IPV6
 * @param {string} routeIp - Starting IP address
 * @param {number} routeMask - Network mask
 * @param {number} routeCnt - Number of routes to generate
 * @param {Function} callback - Called with ({ ip, mask }, index)
 * @param {number} routeStep - Prefix step multiplier
 * @returns {number} Generated route count
 */
function forEachGeneratedRouteIp(routeType, routeIp, routeMask, routeCnt, callback, routeStep = 1) {
    const count = normalizeRouteCount(routeCnt);
    if (count === 0 || typeof callback !== 'function') {
        return 0;
    }

    let generatedCount = 0;
    const stepMultiplier = normalizeRouteStep(routeStep);

    if (routeType === BgpConst.IP_TYPE.IPV4) {
        const baseAddress = ipaddr.parse(routeIp);
        const baseBytes = baseAddress.toByteArray();
        let baseInt = (baseBytes[0] << 24) | (baseBytes[1] << 16) | (baseBytes[2] << 8) | baseBytes[3];

        const step = (routeMask === 32 ? 1 : Math.pow(2, 32 - routeMask)) * stepMultiplier;

        for (let i = 0; i < count; i++) {
            const currentInt = baseInt + i * step;
            const bytes = [
                (currentInt >> 24) & 0xff,
                (currentInt >> 16) & 0xff,
                (currentInt >> 8) & 0xff,
                currentInt & 0xff
            ];
            const ip = ipaddr.fromByteArray(bytes);
            const networkAddress = ipaddr.IPv4.networkAddressFromCIDR(`${ip}/${routeMask}`);
            callback({ ip: networkAddress.toString(), mask: routeMask }, i);
            generatedCount += 1;
        }
    } else if (routeType === BgpConst.IP_TYPE.IPV6) {
        const baseAddress = ipaddr.parse(routeIp);
        const baseBytes = baseAddress.toByteArray(); // 16 bytes
        let baseBigInt = BigInt(0);
        for (let i = 0; i < 16; i++) {
            baseBigInt = (baseBigInt << 8n) + BigInt(baseBytes[i]);
        }

        const step = routeMask === 128 ? 1n : 1n << BigInt(128 - routeMask);
        const effectiveStep = step * BigInt(stepMultiplier);

        for (let i = 0n; i < BigInt(count); i++) {
            const currentBigInt = baseBigInt + i * effectiveStep;
            const bytes = [];
            for (let j = 15; j >= 0; j--) {
                bytes[j] = Number((currentBigInt >> BigInt((15 - j) * 8)) & 0xffn);
            }
            const ip = ipaddr.fromByteArray(bytes);
            const networkAddress = ipaddr.IPv6.networkAddressFromCIDR(`${ip}/${routeMask}`);
            const index = Number(i);
            callback({ ip: networkAddress.toString(), mask: routeMask }, index);
            generatedCount += 1;
        }
    }

    return generatedCount;
}

/**
 * Generate a list of IP networks based on route type, IP, mask and count
 * @param {number} routeType - IP_TYPE.IPV4 or IP_TYPE.IPV6
 * @param {string} routeIp - Starting IP address
 * @param {number} routeMask - Network mask
 * @param {number} routeCnt - Number of routes to generate
 * @returns {Array} Array of objects containing IP and mask
 */
function genRouteIps(routeType, routeIp, routeMask, routeCnt) {
    const routes = [];
    forEachGeneratedRouteIp(routeType, routeIp, routeMask, routeCnt, route => {
        routes.push(route);
    });

    return routes;
}

module.exports = { genRouteIps, forEachGeneratedRouteIp, iterateQpRouteIpInputs, validateQpIpGenerationMode };
