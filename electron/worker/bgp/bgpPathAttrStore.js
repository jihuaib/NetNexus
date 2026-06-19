const crypto = require('crypto');

function normalizeString(value) {
    return value === undefined || value === null ? '' : `${value}`.trim();
}

function normalizeNumber(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizeCommunities(communities) {
    if (!Array.isArray(communities)) {
        return [];
    }
    return communities.map(item => `${item}`.trim()).filter(Boolean);
}

function canonicalizeAttr(attr = {}) {
    return {
        nextHop: normalizeString(attr.nextHop),
        origin: attr.origin === undefined || attr.origin === null || attr.origin === '' ? null : attr.origin,
        asPath: normalizeString(attr.asPath),
        med: normalizeNumber(attr.med, 0),
        localPref: normalizeNumber(attr.localPref, 100),
        communities: normalizeCommunities(attr.communities),
        customAttr: normalizeString(attr.customAttr),
        rt: normalizeString(attr.rt),
        srv6Sid: normalizeString(attr.srv6Sid),
        srv6EndpointBehavior: normalizeNumber(attr.srv6EndpointBehavior, null)
    };
}

function hashCanonicalAttr(canonicalJson) {
    return crypto.createHash('sha256').update(canonicalJson).digest('hex');
}

class BgpPathAttrStore {
    constructor() {
        this.attrMap = new Map();
        this.hashIndex = new Map();
    }

    intern(attr) {
        const canonical = canonicalizeAttr(attr);
        const canonicalJson = JSON.stringify(canonical);
        const hash = hashCanonicalAttr(canonicalJson);

        const hashIds = this.hashIndex.get(hash);
        if (hashIds) {
            for (const attrId of hashIds) {
                const existing = this.attrMap.get(attrId);
                if (existing?.canonicalJson === canonicalJson) {
                    existing.refCount++;
                    return existing.id;
                }
            }
        }

        const id = hashIds ? `${hash}:${hashIds.size}` : hash;
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

    retain(attrId) {
        const entry = this.attrMap.get(attrId);
        if (entry) {
            entry.refCount++;
        }
    }

    release(attrId) {
        const entry = this.attrMap.get(attrId);
        if (!entry) {
            return;
        }

        entry.refCount--;
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
    }
}

module.exports = {
    BgpPathAttrStore,
    canonicalizeAttr
};
