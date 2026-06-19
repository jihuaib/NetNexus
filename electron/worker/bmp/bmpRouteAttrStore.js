const crypto = require('crypto');

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
    return {
        origin: normalizeOptionalValue(attr.origin, DEFAULT_BMP_ROUTE_ATTR.origin),
        asPath: normalizeOptionalValue(attr.asPath, DEFAULT_BMP_ROUTE_ATTR.asPath),
        med: normalizeNumber(attr.med, DEFAULT_BMP_ROUTE_ATTR.med),
        localPref: normalizeNumber(attr.localPref, DEFAULT_BMP_ROUTE_ATTR.localPref),
        communities: normalizeOptionalValue(attr.communities, DEFAULT_BMP_ROUTE_ATTR.communities),
        otc: normalizeOptionalValue(attr.otc, DEFAULT_BMP_ROUTE_ATTR.otc),
        nextHop: normalizeOptionalValue(attr.nextHop, DEFAULT_BMP_ROUTE_ATTR.nextHop),
        prefixSid: normalizeOptionalValue(attr.prefixSid, DEFAULT_BMP_ROUTE_ATTR.prefixSid)
    };
}

function hashCanonicalAttr(canonicalJson) {
    return crypto.createHash('sha256').update(canonicalJson).digest('hex');
}

class BmpRouteAttrStore {
    constructor() {
        this.attrMap = new Map();
        this.hashIndex = new Map();
        this.nextId = 1;
    }

    intern(attr) {
        const canonical = canonicalizeBmpRouteAttr(attr);
        const canonicalJson = JSON.stringify(canonical);
        const hash = hashCanonicalAttr(canonicalJson);

        const hashIds = this.hashIndex.get(hash);
        if (hashIds) {
            for (const attrId of hashIds) {
                const existing = this.attrMap.get(attrId);
                if (existing?.canonicalJson === canonicalJson) {
                    existing.refCount += 1;
                    return existing.id;
                }
            }
        }

        const id = this.nextId;
        this.nextId += 1;
        this.attrMap.set(id, {
            id,
            hash,
            canonicalJson,
            attr: canonical,
            refCount: 1
        });

        if (!this.hashIndex.has(hash)) {
            this.hashIndex.set(hash, new Set());
        }
        this.hashIndex.get(hash).add(id);
        return id;
    }

    release(attrId) {
        const entry = this.attrMap.get(attrId);
        if (!entry) {
            return;
        }

        entry.refCount -= 1;
        if (entry.refCount <= 0) {
            this.attrMap.delete(attrId);
            const hashIds = this.hashIndex.get(entry.hash);
            if (hashIds) {
                hashIds.delete(attrId);
                if (hashIds.size === 0) {
                    this.hashIndex.delete(entry.hash);
                }
            }
        }
    }

    get(attrId) {
        return this.attrMap.get(attrId)?.attr || null;
    }

    getEntry(attrId) {
        const entry = this.attrMap.get(attrId);
        if (!entry) {
            return null;
        }

        return {
            id: entry.id,
            hash: entry.hash,
            attr: entry.attr,
            refCount: entry.refCount
        };
    }

    clear() {
        this.attrMap.clear();
        this.hashIndex.clear();
        this.nextId = 1;
    }
}

module.exports = {
    BmpRouteAttrStore,
    DEFAULT_BMP_ROUTE_ATTR,
    canonicalizeBmpRouteAttr
};
