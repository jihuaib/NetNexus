const attributeRegistry = require('../../../shared/bgpAttributes.json');

const ATTRIBUTE_BY_TYPE = new Map(attributeRegistry.attributes.map(entry => [entry.type, entry]));
const ATTRIBUTE_DEFAULTS = Object.fromEntries(attributeRegistry.attributes.map(entry => [entry.type, entry.default]));

module.exports = { attributeRegistry, ATTRIBUTE_BY_TYPE, ATTRIBUTE_DEFAULTS };
