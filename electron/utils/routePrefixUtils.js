const ipaddr = require('ipaddr.js');

function normalizeRoutePrefixPart(value) {
    const text = value === null || value === undefined ? '' : String(value).trim().toLowerCase();
    if (!text) {
        return '';
    }

    if (ipaddr.isValid(text)) {
        return ipaddr.parse(text).toString().toLowerCase();
    }

    return text;
}

function normalizeRouteMask(mask) {
    if (mask === null || mask === undefined || mask === '') {
        return '';
    }

    const num = Number(mask);
    return Number.isFinite(num) ? String(num) : String(mask).trim().toLowerCase();
}

function addRoutePrefixIndexKey(keys, key) {
    if (key && !keys.includes(key)) {
        keys.push(key);
    }
}

function getRoutePrefixIndexKeys(route) {
    const prefix = normalizeRoutePrefixPart(route?.ip);
    if (!prefix) {
        return [];
    }

    const keys = [`prefix:${prefix}`];
    const mask = normalizeRouteMask(route?.mask);
    if (mask) {
        keys.push(`cidr:${prefix}/${mask}`);
    }

    const nlriDetail = route?.nlriDetail || {};
    const nlriIpPrefix = normalizeRoutePrefixPart(nlriDetail.ipPrefix);
    const nlriPrefixLength = normalizeRouteMask(nlriDetail.prefixLength);
    if (nlriIpPrefix) {
        addRoutePrefixIndexKey(keys, `prefix:${nlriIpPrefix}`);
        if (nlriPrefixLength) {
            addRoutePrefixIndexKey(keys, `cidr:${nlriIpPrefix}/${nlriPrefixLength}`);
        }
    }

    const nlriIpAddress = normalizeRoutePrefixPart(nlriDetail.ipAddress);
    if (nlriIpAddress) {
        addRoutePrefixIndexKey(keys, `prefix:${nlriIpAddress}`);
    }

    return keys;
}

function buildRoutePrefixQuery(prefixFilter) {
    const text = prefixFilter === null || prefixFilter === undefined ? '' : String(prefixFilter).trim().toLowerCase();
    if (!text) {
        return { mode: 'none', text: '' };
    }

    const slashIndex = text.lastIndexOf('/');
    if (slashIndex > 0 && slashIndex < text.length - 1) {
        const prefix = text.slice(0, slashIndex).trim();
        const mask = text.slice(slashIndex + 1).trim();
        if (ipaddr.isValid(prefix) && /^\d+$/.test(mask)) {
            return {
                mode: 'index',
                text,
                key: `cidr:${normalizeRoutePrefixPart(prefix)}/${normalizeRouteMask(mask)}`
            };
        }
    }

    if (ipaddr.isValid(text)) {
        return {
            mode: 'index',
            text,
            key: `prefix:${normalizeRoutePrefixPart(text)}`
        };
    }

    return {
        mode: 'index-or-scan',
        text,
        key: `prefix:${normalizeRoutePrefixPart(text)}`
    };
}

function routeMatchesPrefixQuery(route, query) {
    if (!query || query.mode === 'none') {
        return true;
    }

    const rawPrefix = route?.ip === null || route?.ip === undefined ? '' : String(route.ip).trim().toLowerCase();
    const prefix = normalizeRoutePrefixPart(route?.ip);
    const mask = normalizeRouteMask(route?.mask);
    const values = [rawPrefix, prefix];
    if (mask) {
        values.push(`${rawPrefix}/${mask}`, `${prefix}/${mask}`);
    }

    return values.some(value => value.includes(query.text));
}

module.exports = {
    buildRoutePrefixQuery,
    getRoutePrefixIndexKeys,
    normalizeRouteMask,
    normalizeRoutePrefixPart,
    routeMatchesPrefixQuery
};
