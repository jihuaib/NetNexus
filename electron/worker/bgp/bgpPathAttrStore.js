const crypto = require('crypto');
const { ATTRIBUTE_DEFAULTS } = require('../../utils/bgp/bgpAttributeRegistry');
const { normalizeExtendedCommunities } = require('../../../shared/bgpExtendedCommunities');

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
    const configured = attr.attributePolicy === 'configured';
    const configuredAttributes = Array.isArray(attr.configuredAttributes)
        ? [...new Set(attr.configuredAttributes.filter(field => typeof field === 'string'))].sort()
        : [];
    const canonical = {
        nextHop: normalizeString(attr.nextHop),
        origin: attr.origin === undefined || attr.origin === null || attr.origin === '' ? null : attr.origin,
        asPath: normalizeString(attr.asPath),
        med:
            configured && !configuredAttributes.includes('med')
                ? null
                : normalizeNumber(attr.med, ATTRIBUTE_DEFAULTS.med.value),
        localPref:
            configured && !configuredAttributes.includes('localPref')
                ? null
                : normalizeNumber(attr.localPref, ATTRIBUTE_DEFAULTS.localPref.value),
        communities: normalizeCommunities(attr.communities),
        customAttr: normalizeString(attr.customAttr),
        rt: normalizeString(attr.rt),
        srv6Sid: normalizeString(attr.srv6Sid),
        srv6EndpointBehavior: normalizeNumber(attr.srv6EndpointBehavior, null)
    };
    if (Object.prototype.hasOwnProperty.call(attr, 'extendedCommunities')) {
        canonical.extendedCommunities = normalizeExtendedCommunities(attr.extendedCommunities);
    }
    if (Object.prototype.hasOwnProperty.call(attr, 'srv6Services')) {
        canonical.srv6Services = attr.srv6Services.map(service => ({
            serviceType: service.serviceType,
            sid: normalizeString(service.sid),
            endpointBehavior: normalizeNumber(service.endpointBehavior, null),
            sidStructure: { ...service.sidStructure }
        }));
    }
    // MRT can contain both the global and link-local IPv6 next hop. Keep the
    // full encoded pair while the route's mpNextHop remains its display address.
    if (attr.mrtMpNextHopBytes !== undefined) {
        if (typeof attr.mrtMpNextHopBytes !== 'string' || !/^[0-9a-f]{64}$/i.test(attr.mrtMpNextHopBytes))
            throw new Error('MRT IPv6 双下一跳必须为32字节十六进制值');
        canonical.mrtMpNextHopBytes = attr.mrtMpNextHopBytes.toLowerCase();
    }
    if (configured) {
        canonical.attributePolicy = 'configured';
        canonical.configuredAttributes = configuredAttributes;
        canonical.pathAttributes = (Array.isArray(attr.pathAttributes) ? attr.pathAttributes : []).map(entry => {
            const result = {
                type: entry.type,
                value:
                    entry.type === 'extendedCommunities'
                        ? normalizeExtendedCommunities(entry.value)
                        : Array.isArray(entry.value)
                          ? [...entry.value]
                          : entry.value
            };
            if (entry.type === 'asPath' && entry.prependLocalAs === false) result.prependLocalAs = false;
            if (['srv6', 'srv6L2', 'srv6L3'].includes(entry.type)) {
                result.srv6EndpointBehavior = entry.srv6EndpointBehavior;
                result.srv6SidStructure = { ...entry.srv6SidStructure };
            }
            return result;
        });
        if (attr.srv6SidStructure && canonical.srv6Sid) {
            canonical.srv6SidStructure = {
                locatorBlockLength: normalizeNumber(attr.srv6SidStructure.locatorBlockLength, null),
                locatorNodeLength: normalizeNumber(attr.srv6SidStructure.locatorNodeLength, null),
                functionLength: normalizeNumber(attr.srv6SidStructure.functionLength, null),
                argumentLength: normalizeNumber(attr.srv6SidStructure.argumentLength, null),
                transpositionLength: normalizeNumber(attr.srv6SidStructure.transpositionLength, null),
                transpositionOffset: normalizeNumber(attr.srv6SidStructure.transpositionOffset, null)
            };
        }
    }
    return canonical;
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
