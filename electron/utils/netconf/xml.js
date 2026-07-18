'use strict';

const { XMLParser, XMLValidator } = require('fast-xml-parser');

const DEFAULT_MAX_XML_SIZE = 64 * 1024 * 1024;

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
    }
}

const parser = new XMLParser({
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

function parseXml(xml, options = {}) {
    const value = assertSafeXml(xml, options);
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
        return parser.parse(value);
    } catch (error) {
        throw new NetconfXmlError(`Unable to parse NETCONF XML: ${error.message}`, 'NETCONF_INVALID_XML', error);
    }
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
    const document = parseXml(value, options);
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
    decodeXmlText,
    extractElementContentDetails,
    extractElementContent
};
