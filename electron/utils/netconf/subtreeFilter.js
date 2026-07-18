'use strict';

const { XMLBuilder, XMLParser, XMLValidator } = require('fast-xml-parser');
const { NetconfXmlError, assertSafeXml } = require('./xml');

const NETCONF_BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const DATA_WRAPPER = 'netnexus-subtree-data';
const ORDERED_XML_OPTIONS = Object.freeze({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
    removeNSPrefix: false,
    processEntities: true,
    commentPropName: '#comment',
    cdataPropName: '#cdata'
});

const orderedParser = new XMLParser(ORDERED_XML_OPTIONS);
const orderedBuilder = new XMLBuilder(ORDERED_XML_OPTIONS);

function parseOrderedXml(xml, label) {
    const value = assertSafeXml(xml);
    const validation = XMLValidator.validate(value, {
        allowBooleanAttributes: false,
        unpairedTags: []
    });
    if (validation !== true) {
        const message = validation?.err?.msg || 'unknown XML validation error';
        throw new NetconfXmlError(`Invalid ${label || 'XML'}: ${message}`);
    }
    try {
        return orderedParser.parse(value);
    } catch (error) {
        throw new NetconfXmlError(`Unable to parse ${label || 'XML'}: ${error.message}`, 'NETCONF_INVALID_XML', error);
    }
}

function orderedElement(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const name = Object.keys(item).find(
        key => key !== ':@' && key !== '#text' && key !== '#comment' && key !== '#cdata' && !key.startsWith('?')
    );
    if (!name) return null;
    return {
        name,
        children: Array.isArray(item[name]) ? item[name] : [],
        attributes: item[':@'] && typeof item[':@'] === 'object' ? item[':@'] : {}
    };
}

function namespaceMapFor(parentNamespaces, attributes) {
    const namespaces = new Map(parentNamespaces || []);
    namespaces.set('xml', XML_NAMESPACE);
    for (const [name, value] of Object.entries(attributes || {})) {
        if (name === '@_xmlns') namespaces.set('', String(value));
        else if (name.startsWith('@_xmlns:')) namespaces.set(name.slice('@_xmlns:'.length), String(value));
    }
    return namespaces;
}

function resolveElementName(name, namespaces) {
    const separator = String(name).indexOf(':');
    const prefix = separator < 0 ? '' : String(name).slice(0, separator);
    return {
        localName: separator < 0 ? String(name) : String(name).slice(separator + 1),
        namespace: namespaces.get(prefix) || ''
    };
}

function resolveAttributeName(name, namespaces) {
    const normalized = String(name).replace(/^@_/u, '');
    const separator = normalized.indexOf(':');
    if (separator < 0) return { localName: normalized, namespace: '' };
    const prefix = normalized.slice(0, separator);
    return {
        localName: normalized.slice(separator + 1),
        namespace: namespaces.get(prefix) || ''
    };
}

function directText(children) {
    return (children || [])
        .map(item => item?.['#text'] ?? item?.['#cdata'])
        .filter(value => value !== undefined && value !== null)
        .join('')
        .trim();
}

function normalizeElement(item, parentNamespaces) {
    const element = orderedElement(item);
    if (!element) return null;
    const namespaces = namespaceMapFor(parentNamespaces, element.attributes);
    const resolvedName = resolveElementName(element.name, namespaces);
    const attributes = new Map();
    for (const [name, value] of Object.entries(element.attributes)) {
        if (name === '@_xmlns' || name.startsWith('@_xmlns:')) continue;
        const resolved = resolveAttributeName(name, namespaces);
        attributes.set(`${resolved.namespace}\u0000${resolved.localName}`, String(value ?? ''));
    }
    const node = {
        item,
        element,
        namespaces,
        localName: resolvedName.localName,
        namespace: resolvedName.namespace,
        attributes,
        text: directText(element.children),
        children: []
    };
    node.children = element.children.map(child => normalizeElement(child, namespaces)).filter(Boolean);
    return node;
}

function normalizeDocument(document) {
    const rootNamespaces = new Map([['xml', XML_NAMESPACE]]);
    return (document || []).map(item => normalizeElement(item, rootNamespaces)).filter(Boolean);
}

function directChild(node, localName) {
    return node?.children.find(child => child.localName === localName) || null;
}

function extractFilter(requestXml) {
    const roots = normalizeDocument(parseOrderedXml(requestXml, 'NETCONF filter XML'));
    let current = roots[0] || null;
    if (!current) return null;
    if (current.localName === 'rpc') {
        current = current.children.find(child => child.localName === 'get' || child.localName === 'get-config') || null;
    }
    if (current && (current.localName === 'get' || current.localName === 'get-config')) {
        current = directChild(current, 'filter');
    }
    if (!current || current.localName !== 'filter') return null;
    const type = current.attributes.get('\u0000type') || 'subtree';
    return { node: current, type: type.toLowerCase() };
}

function cloneItem(item) {
    return JSON.parse(JSON.stringify(item));
}

function fullSelection(node) {
    return { node, full: true, children: new Map() };
}

function partialSelection(node) {
    return { node, full: false, children: new Map() };
}

function mergeSelection(target, source) {
    if (!target) return source;
    if (!source || target.full) return target;
    if (source.full) {
        target.full = true;
        target.children.clear();
        return target;
    }
    for (const [childNode, childSelection] of source.children) {
        const existing = target.children.get(childNode);
        target.children.set(childNode, existing ? mergeSelection(existing, childSelection) : childSelection);
    }
    return target;
}

function namesMatch(dataNode, filterNode) {
    return (
        dataNode.localName === filterNode.localName &&
        (filterNode.namespace === '' || dataNode.namespace === filterNode.namespace)
    );
}

function attributesMatch(dataNode, filterNode) {
    for (const [name, value] of filterNode.attributes) {
        if (!dataNode.attributes.has(name) || dataNode.attributes.get(name) !== value) return false;
    }
    return true;
}

function isContentMatchNode(node) {
    return node.children.length === 0 && node.text !== '';
}

function matchFilterNode(dataNode, filterNode) {
    if (!namesMatch(dataNode, filterNode) || !attributesMatch(dataNode, filterNode)) return null;

    if (filterNode.children.length === 0) {
        if (filterNode.text !== '' && dataNode.text !== filterNode.text) return null;
        return fullSelection(dataNode);
    }

    const contentFilters = filterNode.children.filter(isContentMatchNode);
    const structuralFilters = filterNode.children.filter(child => !isContentMatchNode(child));
    const selectedContent = new Map();

    for (const contentFilter of contentFilters) {
        const matches = dataNode.children.map(child => matchFilterNode(child, contentFilter)).filter(Boolean);
        if (matches.length === 0) return null;
        for (const match of matches) selectedContent.set(match.node, match);
    }

    if (structuralFilters.length === 0) return fullSelection(dataNode);

    const selection = partialSelection(dataNode);
    for (const match of selectedContent.values()) selection.children.set(match.node, match);
    let structuralMatchCount = 0;
    for (const structuralFilter of structuralFilters) {
        for (const child of dataNode.children) {
            const match = matchFilterNode(child, structuralFilter);
            if (!match) continue;
            structuralMatchCount += 1;
            const existing = selection.children.get(child);
            selection.children.set(child, existing ? mergeSelection(existing, match) : match);
        }
    }
    return structuralMatchCount > 0 ? selection : null;
}

function normalizedKeyDefinitions(keyDefinitions) {
    return (Array.isArray(keyDefinitions) ? keyDefinitions : []).map(definition => ({
        namespace: String(definition.namespace || ''),
        element: String(definition.element || ''),
        keys: (Array.isArray(definition.keys) ? definition.keys : []).map(key => ({
            namespace: String(key.namespace || definition.namespace || ''),
            name: String(key.name || '')
        }))
    }));
}

function includeListKeys(selection, keyDefinitions) {
    if (selection.full) return;
    const definition = keyDefinitions.find(
        item => item.element === selection.node.localName && item.namespace === selection.node.namespace
    );
    if (!definition) return;
    for (const key of definition.keys) {
        const child = selection.node.children.find(
            item => item.localName === key.name && item.namespace === key.namespace
        );
        if (child && !selection.children.has(child)) selection.children.set(child, fullSelection(child));
    }
}

function selectionToItem(selection, keyDefinitions) {
    if (selection.full) return cloneItem(selection.node.item);
    includeListKeys(selection, keyDefinitions);
    const children = selection.node.children
        .filter(child => selection.children.has(child))
        .map(child => selectionToItem(selection.children.get(child), keyDefinitions));
    const item = { [selection.node.element.name]: children };
    if (Object.keys(selection.node.element.attributes).length > 0) {
        item[':@'] = { ...selection.node.element.attributes };
    }
    return item;
}

function filterSubtreeXml(dataXml, requestXml, options = {}) {
    const dataSource = String(dataXml || '');
    const requestSource = String(requestXml || '');
    if (!requestSource.trim()) return dataSource;
    const filter = extractFilter(requestSource);
    if (!filter) return dataSource;
    if (filter.type !== 'subtree') {
        if (options.passthroughUnsupported === true) return dataSource;
        throw new NetconfXmlError(`Unsupported NETCONF filter type: ${filter.type}`, 'NETCONF_UNSUPPORTED_FILTER');
    }
    if (filter.node.children.length === 0) return '';

    const wrapped = `<${DATA_WRAPPER}>${dataSource}</${DATA_WRAPPER}>`;
    const wrapperRoot = normalizeDocument(parseOrderedXml(wrapped, 'NETCONF datastore XML'))[0];
    if (!wrapperRoot) return '';
    const selections = new Map();
    for (const dataNode of wrapperRoot.children) {
        for (const filterNode of filter.node.children) {
            const match = matchFilterNode(dataNode, filterNode);
            if (!match) continue;
            const existing = selections.get(dataNode);
            selections.set(dataNode, existing ? mergeSelection(existing, match) : match);
        }
    }
    const keyDefinitions = normalizedKeyDefinitions(options.keyDefinitions);
    const output = wrapperRoot.children
        .filter(node => selections.has(node))
        .map(node => selectionToItem(selections.get(node), keyDefinitions));
    return orderedBuilder.build(output).trim();
}

function hasSubtreeFilter(requestXml) {
    const source = String(requestXml || '');
    if (!source.trim()) return false;
    const filter = extractFilter(source);
    return Boolean(filter && filter.type === 'subtree');
}

module.exports = {
    NETCONF_BASE_NAMESPACE,
    filterSubtreeXml,
    hasSubtreeFilter
};
