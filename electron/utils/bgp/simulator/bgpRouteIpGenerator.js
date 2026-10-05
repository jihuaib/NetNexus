const ipaddr = require('ipaddr.js');
const BgpConst = require('../../../const/bgpConst');

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

module.exports = { genRouteIps, forEachGeneratedRouteIp };
