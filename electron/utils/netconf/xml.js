'use strict';

const { XMLBuilder, XMLParser, XMLValidator } = require('fast-xml-parser');

const DEFAULT_MAX_XML_SIZE = 64 * 1024 * 1024;
const DEFAULT_MAX_CONFIG_XML_SIZE = 8 * 1024 * 1024;
const NETCONF_BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';
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

class NetconfXmlError extends Error {
    constructor(message, code = 'NETCONF_INVALID_XML', cause = null) {
        super(message);
        this.name = 'NetconfXmlError';
        this.code = code;
        if (cause) {
            this.cause = cause;
        }
    }
}

class NetconfRpcError extends Error {
    constructor(errors, options = {}) {
        const normalizedErrors = Array.isArray(errors) ? errors : [];
        const first = normalizedErrors[0] || {};
        const detail = first.message || first.tag || 'unspecified RPC error';
        super(`NETCONF RPC failed: ${detail}`);
        this.name = 'NetconfRpcError';
        this.code = 'NETCONF_RPC_ERROR';
        this.errors = normalizedErrors;
        this.messageId = options.messageId || null;
        this.replyXml = options.replyXml || null;
        this.requestXml = options.requestXml || null;
    }
}

const XML_PARSER_OPTIONS = Object.freeze({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    removeNSPrefix: true,
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
    allowBooleanAttributes: false,
    processEntities: true
});
const parser = new XMLParser(XML_PARSER_OPTIONS);
const opaqueRpcReplyDataParser = new XMLParser({
    ...XML_PARSER_OPTIONS,
    // NETCONF operational replies can contain hundreds of thousands of data
    // nodes. Keep their inner XML opaque so the client does not materialize a
    // much larger JavaScript object graph merely to return reply.xml.
    stopNodes: ['rpc-reply.data']
});

function assertSafeXml(xml, options = {}) {
    if (typeof xml !== 'string' && !Buffer.isBuffer(xml)) {
        throw new TypeError('NETCONF XML must be a string or Buffer');
    }
    const value = Buffer.isBuffer(xml) ? xml.toString('utf8') : xml;
    const byteLength = Buffer.byteLength(value, 'utf8');
    const maxXmlSize = options.maxXmlSize || DEFAULT_MAX_XML_SIZE;
    if (byteLength > maxXmlSize) {
        throw new NetconfXmlError(`NETCONF XML exceeds ${maxXmlSize} bytes`, 'NETCONF_XML_TOO_LARGE');
    }
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(value)) {
        throw new NetconfXmlError(
            'NETCONF XML containing DOCTYPE or ENTITY declarations is not allowed',
            'NETCONF_UNSAFE_XML'
        );
    }
    return value;
}

function parseValidatedXml(value, selectedParser) {
    const validation = XMLValidator.validate(value, {
        allowBooleanAttributes: false,
        unpairedTags: []
    });
    if (validation !== true) {
        const message = validation && validation.err ? validation.err.msg : 'unknown XML validation error';
        const line = validation && validation.err ? validation.err.line : null;
        const suffix = line ? ` at line ${line}` : '';
        throw new NetconfXmlError(`Invalid NETCONF XML${suffix}: ${message}`);
    }

    try {
        return selectedParser.parse(value);
    } catch (error) {
        throw new NetconfXmlError(`Unable to parse NETCONF XML: ${error.message}`, 'NETCONF_INVALID_XML', error);
    }
}

function parseXmlWithParser(xml, options, selectedParser) {
    return parseValidatedXml(assertSafeXml(xml, options), selectedParser);
}

function parseXml(xml, options = {}) {
    return parseXmlWithParser(xml, options, parser);
}

function localName(name) {
    const value = String(name);
    const separatorIndex = value.indexOf(':');
    return separatorIndex < 0 ? value : value.slice(separatorIndex + 1);
}

function asArray(value) {
    if (value === undefined || value === null) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

function textValue(value) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value).trim();
    }
    if (Array.isArray(value)) {
        const values = value.map(textValue).filter(item => item !== null && item !== '');
        return values.length > 0 ? values.join('') : null;
    }
    if (typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '#text')) {
        return textValue(value['#text']);
    }
    return null;
}

function entriesByLocalName(node, wantedName) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return [];
    }
    const wanted = localName(wantedName);
    const result = [];
    for (const [key, value] of Object.entries(node)) {
        if (!key.startsWith('@_') && key !== '#text' && localName(key) === wanted) {
            result.push(...asArray(value));
        }
    }
    return result;
}

function childValues(node, wantedName) {
    return entriesByLocalName(node, wantedName);
}

function childText(node, wantedName) {
    const values = childValues(node, wantedName);
    return values.length > 0 ? textValue(values[0]) : null;
}

function childTexts(node, wantedName) {
    return childValues(node, wantedName)
        .map(textValue)
        .filter(value => value !== null && value !== '');
}

function findAll(node, wantedName, output = []) {
    if (Array.isArray(node)) {
        for (const value of node) {
            findAll(value, wantedName, output);
        }
        return output;
    }
    if (!node || typeof node !== 'object') {
        return output;
    }

    const wanted = localName(wantedName);
    for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('@_') || key === '#text') {
            continue;
        }
        if (localName(key) === wanted) {
            output.push(...asArray(value));
        }
        findAll(value, wanted, output);
    }
    return output;
}

function findFirst(node, wantedName) {
    const values = findAll(node, wantedName, []);
    return values.length > 0 ? values[0] : null;
}

function findRoot(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
        return null;
    }
    for (const [key, value] of Object.entries(document)) {
        if (!key.startsWith('?') && !key.startsWith('@_') && key !== '#text') {
            return { name: localName(key), value };
        }
    }
    return null;
}

function getAttribute(node, wantedName) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return null;
    }
    const wanted = localName(wantedName);
    for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('@_') && localName(key.slice(2)) === wanted) {
            return value === undefined || value === null ? null : String(value);
        }
    }
    return null;
}

function normalizeRpcError(node) {
    const errorInfo = childValues(node, 'error-info')[0] || null;
    return {
        type: childText(node, 'error-type'),
        tag: childText(node, 'error-tag'),
        severity: childText(node, 'error-severity'),
        appTag: childText(node, 'error-app-tag'),
        path: childText(node, 'error-path'),
        message: childText(node, 'error-message'),
        messageLanguage: getAttribute(childValues(node, 'error-message')[0], 'lang'),
        info: errorInfo
    };
}

function parseNetconfMessage(xml, options = {}) {
    const value = assertSafeXml(xml, options);
    const document = parseValidatedXml(value, options.opaqueRpcReplyData === true ? opaqueRpcReplyDataParser : parser);
    const root = findRoot(document);
    if (!root) {
        throw new NetconfXmlError('NETCONF XML has no document element');
    }

    if (root.name === 'hello') {
        const capabilitiesNode = childValues(root.value, 'capabilities')[0] || {};
        const capabilities = childTexts(capabilitiesNode, 'capability');
        return {
            type: 'hello',
            xml: value,
            document,
            root: root.value,
            sessionId: childText(root.value, 'session-id'),
            capabilities
        };
    }

    if (root.name === 'rpc-reply') {
        const messageId = getAttribute(root.value, 'message-id');
        const errors = childValues(root.value, 'rpc-error').map(normalizeRpcError);
        return {
            type: 'rpc-reply',
            xml: value,
            document,
            root: root.value,
            messageId,
            ok: childValues(root.value, 'ok').length > 0,
            data: childValues(root.value, 'data')[0] || null,
            errors
        };
    }

    if (root.name === 'notification') {
        return {
            type: 'notification',
            xml: value,
            document,
            root: root.value,
            eventTime: childText(root.value, 'eventTime')
        };
    }

    return {
        type: root.name,
        xml: value,
        document,
        root: root.value
    };
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

function hasNonWhitespaceText(items) {
    return (items || []).some(item => {
        const text = item?.['#text'] ?? item?.['#cdata'];
        return text !== undefined && String(text).trim() !== '';
    });
}

function assertNoEditOperationAttributes(items, parentNamespaces) {
    for (const item of items || []) {
        const element = orderedElement(item);
        if (!element) continue;
        const namespaces = namespaceMapFor(parentNamespaces, element.attributes);
        for (const name of Object.keys(element.attributes)) {
            if (!name.startsWith('@_') || name === '@_xmlns' || name.startsWith('@_xmlns:')) continue;
            const attributeName = name.slice(2);
            const separator = attributeName.indexOf(':');
            const prefix = separator < 0 ? '' : attributeName.slice(0, separator);
            const attributeLocalName = separator < 0 ? attributeName : attributeName.slice(separator + 1);
            if (
                attributeLocalName === 'operation' &&
                (prefix === '' || namespaces.get(prefix) === NETCONF_BASE_NAMESPACE)
            ) {
                throw new NetconfXmlError(
                    'get-config data contains an edit operation attribute',
                    'NETCONF_CONFIG_UNSAFE_OPERATION'
                );
            }
        }
        assertNoEditOperationAttributes(element.children, namespaces);
    }
}

function preserveDataDefaultNamespace(items, dataNamespaces) {
    const inheritedDefaultNamespace = dataNamespaces.get('') || '';
    if (!inheritedDefaultNamespace || inheritedDefaultNamespace === NETCONF_BASE_NAMESPACE) return;
    for (const item of items || []) {
        const element = orderedElement(item);
        if (!element || Object.prototype.hasOwnProperty.call(element.attributes, '@_xmlns')) continue;
        item[':@'] = { ...element.attributes, '@_xmlns': inheritedDefaultNamespace };
    }
}

function rpcReplyDataToConfig(xml, options = {}) {
    const value = assertSafeXml(xml, {
        maxXmlSize: Number(options.maxXmlSize) || DEFAULT_MAX_CONFIG_XML_SIZE
    });
    const validation = XMLValidator.validate(value, {
        allowBooleanAttributes: false,
        unpairedTags: []
    });
    if (validation !== true) {
        const message = validation && validation.err ? validation.err.msg : 'unknown XML validation error';
        throw new NetconfXmlError(`Invalid NETCONF rpc-reply XML: ${message}`);
    }

    const document = new XMLParser(ORDERED_XML_OPTIONS).parse(value);
    const rootItems = document.filter(item => orderedElement(item));
    if (rootItems.length !== 1 || hasNonWhitespaceText(document)) {
        throw new NetconfXmlError('NETCONF rpc-reply must contain exactly one document element');
    }

    const root = orderedElement(rootItems[0]);
    const rootNamespaces = namespaceMapFor(null, root.attributes);
    const rootName = resolveElementName(root.name, rootNamespaces);
    if (rootName.localName !== 'rpc-reply' || rootName.namespace !== NETCONF_BASE_NAMESPACE) {
        throw new NetconfXmlError('Expected a NETCONF rpc-reply in the base namespace');
    }

    const directElements = root.children.map(item => {
        const element = orderedElement(item);
        if (!element) return null;
        const namespaces = namespaceMapFor(rootNamespaces, element.attributes);
        return { element, namespaces, resolvedName: resolveElementName(element.name, namespaces) };
    });
    if (hasNonWhitespaceText(root.children)) {
        throw new NetconfXmlError('NETCONF rpc-reply contains unexpected text content');
    }
    if (
        directElements.some(
            entry =>
                entry?.resolvedName.localName === 'rpc-error' && entry.resolvedName.namespace === NETCONF_BASE_NAMESPACE
        )
    ) {
        throw new NetconfXmlError('NETCONF rpc-reply contains rpc-error', 'NETCONF_RPC_ERROR');
    }

    const dataElements = directElements.filter(
        entry => entry?.resolvedName.localName === 'data' && entry.resolvedName.namespace === NETCONF_BASE_NAMESPACE
    );
    if (dataElements.length !== 1) {
        throw new NetconfXmlError('NETCONF rpc-reply must contain exactly one data element');
    }

    const data = dataElements[0];
    if (hasNonWhitespaceText(data.element.children)) {
        throw new NetconfXmlError('NETCONF data contains unexpected direct text content');
    }
    preserveDataDefaultNamespace(data.element.children, data.namespaces);
    assertNoEditOperationAttributes(data.element.children, data.namespaces);

    const configAttributes = { '@_xmlns': NETCONF_BASE_NAMESPACE };
    for (const [prefix, namespace] of data.namespaces.entries()) {
        if (prefix && prefix !== 'xml') configAttributes[`@_xmlns:${prefix}`] = namespace;
    }
    const configDocument = [
        {
            config: data.element.children,
            ':@': configAttributes
        }
    ];
    const configXml = new XMLBuilder(ORDERED_XML_OPTIONS).build(configDocument).trim();
    const sourceMessageId = Object.entries(root.attributes).find(
        ([name]) => name.startsWith('@_') && localName(name.slice(2)) === 'message-id'
    )?.[1];

    return {
        configXml,
        empty: !data.element.children.some(item => orderedElement(item)),
        sourceMessageId: sourceMessageId === undefined ? null : String(sourceMessageId)
    };
}

function decodeXmlText(value) {
    return String(value)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#([0-9]+);/g, (_match, decimal) => String.fromCodePoint(parseInt(decimal, 10)));
}

function extractElementContentDetails(xml, elementName) {
    const value = assertSafeXml(xml);
    const escapedName = String(elementName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(
        `<(?:[A-Za-z_][\\w.-]*:)?${escapedName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escapedName}\\s*>`,
        'i'
    );
    const match = expression.exec(value);
    if (!match) {
        return null;
    }
    const content = match[1];
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(content);
    return {
        content: cdata ? cdata[1] : content,
        cdata: Boolean(cdata)
    };
}

function extractElementContent(xml, elementName) {
    const details = extractElementContentDetails(xml, elementName);
    return details ? details.content : null;
}

module.exports = {
    DEFAULT_MAX_XML_SIZE,
    NetconfXmlError,
    NetconfRpcError,
    assertSafeXml,
    parseXml,
    parseNetconfMessage,
    localName,
    asArray,
    textValue,
    childValues,
    childText,
    childTexts,
    findAll,
    findFirst,
    findRoot,
    getAttribute,
    normalizeRpcError,
    rpcReplyDataToConfig,
    decodeXmlText,
    extractElementContentDetails,
    extractElementContent
};
