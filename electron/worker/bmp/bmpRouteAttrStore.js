const { canonicalizePathAttributes } = require('./bmpRoutePathAttributes');

const DEFAULT_BMP_ROUTE_ATTR = Object.freeze({
    origin: null,
    asPath: null,
    med: 0,
    localPref: 0,
    communities: null,
    otc: null,
    nextHop: null,
    prefixSid: null
});

function normalizeNumber(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizeOptionalValue(value, fallback = null) {
    if (value === undefined) {
        return fallback;
    }
    if (Array.isArray(value)) {
        return value.slice();
    }
    return value;
}

function canonicalizeBmpRouteAttr(attr = {}) {
    const normalized = {
        origin: normalizeOptionalValue(attr.origin, DEFAULT_BMP_ROUTE_ATTR.origin),
        asPath: normalizeOptionalValue(attr.asPath, DEFAULT_BMP_ROUTE_ATTR.asPath),
        med: normalizeNumber(attr.med, DEFAULT_BMP_ROUTE_ATTR.med),
        localPref: normalizeNumber(attr.localPref, DEFAULT_BMP_ROUTE_ATTR.localPref),
        communities: normalizeOptionalValue(attr.communities, DEFAULT_BMP_ROUTE_ATTR.communities),
        otc: normalizeOptionalValue(attr.otc, DEFAULT_BMP_ROUTE_ATTR.otc),
        nextHop: normalizeOptionalValue(attr.nextHop, DEFAULT_BMP_ROUTE_ATTR.nextHop),
        prefixSid: normalizeOptionalValue(attr.prefixSid, DEFAULT_BMP_ROUTE_ATTR.prefixSid)
    };
    if (attr.as4Path !== undefined) {
        normalized.wireAsPath = normalizeOptionalValue(attr.wireAsPath);
        normalized.as4Path = normalizeOptionalValue(attr.as4Path);
    }
    if (attr.pathAttributes !== undefined) {
        normalized.pathAttributes = canonicalizePathAttributes(attr.pathAttributes);
    }
    return normalized;
}

module.exports = {
    DEFAULT_BMP_ROUTE_ATTR,
    canonicalizeBmpRouteAttr
};
