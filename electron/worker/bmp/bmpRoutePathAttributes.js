const BgpConst = require('../../const/bgpConst');

const IMMUTABLE_PATH_ATTRIBUTES = new WeakSet();
const MP_NLRI_FIELDS = new Set(['nlri', 'withdrawnRoutes', 'valid', 'errors', 'warnings']);

function cloneAttributeValue(value) {
    if (Buffer.isBuffer(value)) return value.toString('hex');
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(cloneAttributeValue);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) result[key] = cloneAttributeValue(item);
        return result;
    }
    return value;
}

function freezeAttributeValue(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freezeAttributeValue);
        Object.freeze(value);
    }
    return value;
}

function freezePathAttributes(attributes) {
    freezeAttributeValue(attributes);
    IMMUTABLE_PATH_ATTRIBUTES.add(attributes);
    return attributes;
}

function canonicalizePathAttributes(attributes) {
    // Only arrays created here are trusted immutable snapshots. An externally
    // frozen array can still contain mutable parsed objects.
    return IMMUTABLE_PATH_ATTRIBUTES.has(attributes) ? attributes : cloneAttributeValue(attributes);
}

function snapshotPathAttribute(attribute) {
    const isReach = attribute.typeCode === BgpConst.BGP_PATH_ATTR.MP_REACH_NLRI;
    const isUnreach = attribute.typeCode === BgpConst.BGP_PATH_ATTR.MP_UNREACH_NLRI;
    const mp = isReach ? attribute.mpReach : isUnreach ? attribute.mpUnreach : null;
    const result = {};
    for (const [key, value] of Object.entries(attribute)) {
        if (key === 'value' || key === 'mpReach' || key === 'mpUnreach') continue;
        if ((isReach || isUnreach) && (key === 'length' || MP_NLRI_FIELDS.has(key))) continue;
        result[key] = cloneAttributeValue(value);
    }
    const raw = Buffer.isBuffer(attribute.value) ? attribute.value : null;
    if (isReach || isUnreach) {
        // MP length, Extended Length and parser diagnostics describe the whole
        // UPDATE's NLRI batch. They must not change a shared attribute identity.
        result.flags = Number(attribute.flags || 0) & ~0x10;
        const headerLength = isReach ? 5 + Number(mp?.nextHopLength ?? raw?.[3] ?? 0) : 3;
        result.headerLength = raw ? Math.min(headerLength, raw.length) : headerLength;
        result.nlriOmitted = true;
        if (raw) result.rawValueHex = raw.subarray(0, result.headerLength).toString('hex');
        if (mp) {
            const header = {};
            for (const [key, value] of Object.entries(mp)) {
                if (!MP_NLRI_FIELDS.has(key)) header[key] = cloneAttributeValue(value);
            }
            if (isReach && raw && raw.length >= headerLength) header.reserved = raw[headerLength - 1];
            result[isReach ? 'mpReach' : 'mpUnreach'] = header;
        }
    } else if (raw) {
        result.rawValueHex = raw.toString('hex');
    }
    return freezeAttributeValue(result);
}

function createPathAttributeContext(attributes = []) {
    return attributes.map(attribute => ({
        attribute: snapshotPathAttribute(attribute),
        mpReach: attribute.mpReach || null,
        mp: attribute.mpReach || attribute.mpUnreach || null,
        typeCode: attribute.typeCode
    }));
}

function selectPathAttributes(context, afi = null, safi = null, mpReach = undefined) {
    return freezePathAttributes(
        context
            .filter(entry => {
                if (!entry.mp) return true;
                if (afi !== null && safi !== null && (entry.mp.afi !== afi || entry.mp.safi !== safi)) return false;
                // A classical NLRI group has no MP_REACH attribute; an MP group
                // uses its own header even when several groups share a next hop.
                return mpReach === undefined || !entry.mpReach || entry.mpReach === mpReach;
            })
            .map(entry => entry.attribute)
    );
}

module.exports = {
    cloneAttributeValue,
    canonicalizePathAttributes,
    createPathAttributeContext,
    selectPathAttributes
};
