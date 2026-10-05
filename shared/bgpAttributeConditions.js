function conditionModel(config = {}) {
    return {
        ...config,
        addressFamily: Number(config.addressFamily),
        routeType: Number(config.routeType),
        ethernetTagId: Number(config.ethernetTagId ?? config.ethernetTag ?? 0),
        encapsulationType: config.encapsulationType ?? 'mpls',
        ipAddress: String(config.ipAddress ?? '').trim()
    };
}

function matchesCondition(condition, config = {}) {
    if (!condition) return true;
    if (condition.all) return condition.all.every(entry => matchesCondition(entry, config));
    if (condition.any) return condition.any.some(entry => matchesCondition(entry, config));
    const model = conditionModel(config);
    if (Object.prototype.hasOwnProperty.call(condition, 'equals')) return model[condition.field] === condition.equals;
    if (Object.prototype.hasOwnProperty.call(condition, 'enabled'))
        return Boolean(model[condition.field]) === condition.enabled;
    return false;
}

function isAttributeApplicable(metadata, config = {}) {
    return (
        (!metadata.addressFamilies || metadata.addressFamilies.includes(Number(config.addressFamily))) &&
        matchesCondition(metadata.visibleWhen, config)
    );
}

function isAttributeRequired(metadata, config = {}) {
    return (
        isAttributeApplicable(metadata, config) &&
        (metadata.requiredAddressFamilies || []).includes(Number(config.addressFamily)) &&
        matchesCondition(metadata.requiredWhen, config)
    );
}

module.exports = { matchesCondition, isAttributeApplicable, isAttributeRequired };
