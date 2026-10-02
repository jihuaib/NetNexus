function matchesCondition(condition, model) {
    if (!condition) return true;
    if (condition.all) return condition.all.every(rule => matchesCondition(rule, model));
    if (condition.any) return condition.any.some(rule => matchesCondition(rule, model));
    if (Object.prototype.hasOwnProperty.call(condition, 'equals')) {
        return model[condition.field] === condition.equals;
    }
    if (Object.prototype.hasOwnProperty.call(condition, 'enabled')) {
        return Boolean(model[condition.field]) === condition.enabled;
    }
    return false;
}

export const isSchemaFieldVisible = (field, model) => matchesCondition(field.visibleWhen, model);
export const isSchemaFieldDisabled = (field, model) =>
    Boolean(field.disabledWhen) && matchesCondition(field.disabledWhen, model);
