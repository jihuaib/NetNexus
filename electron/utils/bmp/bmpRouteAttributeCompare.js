// Keep ordered attributes (label stacks, AS paths, Prefix-SID structures)
// ordered. Only COMMUNITIES has set semantics. BMP DTOs carry communities as
// a space-separated string; legacy adapters also use arrays or parser objects.
function stableValue(value) {
    if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${stableValue(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function communityValue(value) {
    if (value && typeof value === 'object') {
        if (value.formatted !== undefined) return String(value.formatted);
        return communityValue(value.value);
    }
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
        return `${value >>> 16}:${value & 0xffff}`;
    }
    return String(value ?? '').trim();
}

function routeAttributeComparisonKey(field, value) {
    if (field !== 'communities') return stableValue(value);
    const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
    const communities = values.flatMap(item => communityValue(item).split(/[\s,]+/)).filter(Boolean);
    return stableValue(Array.from(new Set(communities)).sort());
}

function routeAttributesEqual(field, left, right) {
    return routeAttributeComparisonKey(field, left) === routeAttributeComparisonKey(field, right);
}

module.exports = { routeAttributeComparisonKey, routeAttributesEqual };
