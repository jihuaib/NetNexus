import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const NETCONF_BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';

const XML_PARSE_OPTIONS = Object.freeze({
    allowBooleanAttributes: false,
    commentPropName: '#comment',
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    processEntities: false,
    trimValues: false
});

const locationAt = (value, rawIndex) => {
    const text = String(value ?? '');
    const index = Math.max(0, Math.min(Number(rawIndex) || 0, text.length));
    let line = 1;
    let lineStart = 0;

    for (let cursor = 0; cursor < index; cursor += 1) {
        if (text[cursor] === '\n') {
            line += 1;
            lineStart = cursor + 1;
        }
    }

    return {
        index,
        line,
        column: index - lineStart + 1
    };
};

const indexAt = (value, rawLine, rawColumn) => {
    const text = String(value ?? '');
    const targetLine = Math.max(1, Number(rawLine) || 1);
    const targetColumn = Math.max(1, Number(rawColumn) || 1);
    let line = 1;
    let index = 0;

    while (line < targetLine && index < text.length) {
        if (text[index] === '\n') line += 1;
        index += 1;
    }

    return Math.min(index + targetColumn - 1, text.length);
};

const diagnosticAt = (value, message, index, length = 1) => ({
    severity: 'error',
    message,
    ...locationAt(value, index),
    length: Math.max(0, Math.min(Number(length) || 0, String(value ?? '').length - Math.max(0, index)))
});

const scanXmlTags = value => {
    const text = String(value ?? '');
    const tags = [];
    let cursor = 0;
    let depth = 0;

    while (cursor < text.length) {
        const openIndex = text.indexOf('<', cursor);
        if (openIndex < 0) break;

        if (text.startsWith('<!--', openIndex)) {
            const end = text.indexOf('-->', openIndex + 4);
            cursor = end < 0 ? text.length : end + 3;
            continue;
        }
        if (text.startsWith('<![CDATA[', openIndex)) {
            const end = text.indexOf(']]>', openIndex + 9);
            cursor = end < 0 ? text.length : end + 3;
            continue;
        }
        if (text.startsWith('<?', openIndex)) {
            const end = text.indexOf('?>', openIndex + 2);
            cursor = end < 0 ? text.length : end + 2;
            continue;
        }

        const closing = text.startsWith('</', openIndex);
        if (text.startsWith('<!', openIndex) && !closing) {
            const end = text.indexOf('>', openIndex + 2);
            cursor = end < 0 ? text.length : end + 1;
            continue;
        }

        let nameIndex = openIndex + (closing ? 2 : 1);
        while (/\s/u.test(text[nameIndex] || '')) nameIndex += 1;
        const nameMatch = text.slice(nameIndex).match(/^[A-Za-z_][\w.:-]*/u);
        if (!nameMatch) {
            cursor = openIndex + 1;
            continue;
        }

        let endIndex = nameIndex + nameMatch[0].length;
        let quote = '';
        while (endIndex < text.length) {
            const character = text[endIndex];
            if (quote) {
                if (character === quote) quote = '';
            } else if (character === '"' || character === "'") {
                quote = character;
            } else if (character === '>') {
                break;
            }
            endIndex += 1;
        }

        if (closing) depth = Math.max(0, depth - 1);
        const beforeClose = text.slice(nameIndex + nameMatch[0].length, endIndex).trimEnd();
        const selfClosing = !closing && beforeClose.endsWith('/');
        tags.push({
            name: nameMatch[0],
            index: openIndex,
            nameIndex,
            length: nameMatch[0].length,
            end: Math.min(endIndex + 1, text.length),
            depth,
            closing,
            selfClosing
        });
        if (!closing && !selfClosing) depth += 1;
        cursor = endIndex < text.length ? endIndex + 1 : text.length;
    }

    return tags;
};

const isElementKey = key => key !== ':@' && !key.startsWith('#') && !key.startsWith('?');

const elementNameOf = entry => (entry && typeof entry === 'object' ? Object.keys(entry).find(isElementKey) || '' : '');

const localNameOf = qualifiedName =>
    String(qualifiedName || '')
        .split(':')
        .pop();

const prefixOf = qualifiedName => {
    const parts = String(qualifiedName || '').split(':');
    return parts.length > 1 ? parts.slice(0, -1).join(':') : '';
};

const attributeNameLocation = (value, tag, attributeName) => {
    if (!tag) return null;
    const openingTag = String(value ?? '').slice(tag.index, tag.end);
    const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = openingTag.match(new RegExp(`(?:^|\\s)(${escapedName})\\s*=`, 'u'));
    if (!match) return null;
    const relativeIndex = match.index + match[0].indexOf(match[1]);
    return {
        index: tag.index + relativeIndex,
        length: match[1].length
    };
};

const pushMatches = (diagnostics, value, pattern, message) => {
    for (const match of String(value ?? '').matchAll(pattern)) {
        diagnostics.push(diagnosticAt(value, message, match.index, match[0].length));
    }
};

const resultFrom = (diagnostics, operation = '') => ({
    valid: diagnostics.length === 0,
    diagnostics: diagnostics.sort((left, right) => left.index - right.index),
    operation
});

/**
 * Validate an editable NETCONF RPC envelope before it is sent to a device.
 * Diagnostic offsets are zero-based; line and column numbers are one-based.
 */
export const validateNetconfRpc = value => {
    const text = String(value ?? '');
    const diagnostics = [];

    if (!text.trim()) {
        diagnostics.push(diagnosticAt(text, 'RPC 报文不能为空', 0, 0));
        return resultFrom(diagnostics);
    }

    pushMatches(diagnostics, text, /<!\s*(?:DOCTYPE|ENTITY)\b/giu, 'RPC 报文不允许包含 DOCTYPE 或 ENTITY 声明');
    pushMatches(diagnostics, text, /NETNEXUS_REQUIRED/gu, '请补全或移除 NETNEXUS_REQUIRED 参数占位');

    // Do not pass declarations that can define entities into an XML parser.
    if (diagnostics.some(item => /DOCTYPE|ENTITY/u.test(item.message))) {
        return resultFrom(diagnostics);
    }

    const validation = XMLValidator.validate(text, { allowBooleanAttributes: false });
    if (validation !== true) {
        const error = validation?.err || {};
        const index = indexAt(text, error.line, error.col);
        diagnostics.push(
            diagnosticAt(text, `XML 格式不合法：${error.msg || '无法解析报文'}`, index, index < text.length ? 1 : 0)
        );
        return resultFrom(diagnostics);
    }

    let parsed;
    try {
        parsed = new XMLParser(XML_PARSE_OPTIONS).parse(text);
    } catch (error) {
        diagnostics.push(diagnosticAt(text, `XML 格式不合法：${error.message || '无法解析报文'}`, 0, 1));
        return resultFrom(diagnostics);
    }

    const tags = scanXmlTags(text);
    const rootTags = tags.filter(tag => !tag.closing && tag.depth === 0);
    const topLevelElements = Array.isArray(parsed) ? parsed.filter(entry => elementNameOf(entry)) : [];
    if (topLevelElements.length !== 1 || rootTags.length !== 1) {
        const invalidRoot = rootTags[1] || rootTags[0];
        diagnostics.push(
            diagnosticAt(
                text,
                'RPC 报文必须且只能包含一个根元素',
                invalidRoot?.nameIndex ?? 0,
                invalidRoot?.length ?? 1
            )
        );
        return resultFrom(diagnostics);
    }

    const rootEntry = topLevelElements[0];
    const rootName = elementNameOf(rootEntry);
    const rootTag = rootTags[0];
    const rootAttributes = rootEntry[':@'] || {};
    const rootLocalName = localNameOf(rootName);
    const rootPrefix = prefixOf(rootName);
    const namespaceAttribute = rootPrefix ? `xmlns:${rootPrefix}` : 'xmlns';
    const rootNamespace = rootAttributes[`@_${namespaceAttribute}`];

    if (rootLocalName !== 'rpc') {
        diagnostics.push(diagnosticAt(text, '根元素必须是 rpc', rootTag.nameIndex, rootTag.length));
    }

    if (rootNamespace !== NETCONF_BASE_NAMESPACE) {
        const attributeLocation = attributeNameLocation(text, rootTag, namespaceAttribute);
        diagnostics.push(
            diagnosticAt(
                text,
                `rpc 根元素必须使用 NETCONF base 命名空间 ${NETCONF_BASE_NAMESPACE}`,
                attributeLocation?.index ?? rootTag.nameIndex,
                attributeLocation?.length ?? rootTag.length
            )
        );
    }

    const messageId = rootAttributes['@_message-id'];
    if (messageId === undefined || !String(messageId).trim()) {
        const attributeLocation = attributeNameLocation(text, rootTag, 'message-id');
        diagnostics.push(
            diagnosticAt(
                text,
                'rpc 根元素缺少非空的 message-id 属性',
                attributeLocation?.index ?? rootTag.nameIndex,
                attributeLocation?.length ?? rootTag.length
            )
        );
    }

    const rootChildren = Array.isArray(rootEntry[rootName]) ? rootEntry[rootName] : [];
    const operationEntries = rootChildren.filter(entry => elementNameOf(entry));
    const operationName = operationEntries.length === 1 ? elementNameOf(operationEntries[0]) : '';
    const operation = localNameOf(operationName);
    const operationTags = tags.filter(tag => !tag.closing && tag.depth === 1);
    const characterData = rootChildren.find(
        entry => Object.prototype.hasOwnProperty.call(entry || {}, '#text') && String(entry['#text']).trim()
    );

    if (operationEntries.length !== 1) {
        const invalidOperation = operationEntries.length > 1 ? operationTags[1] : rootTag;
        diagnostics.push(
            diagnosticAt(
                text,
                'rpc 内必须且只能包含一个操作元素',
                invalidOperation?.nameIndex ?? rootTag.nameIndex,
                invalidOperation?.length ?? rootTag.length
            )
        );
    } else if (characterData) {
        const characterValue = String(characterData['#text']);
        const nonWhitespaceOffset = characterValue.search(/\S/u);
        const characterIndex = text.indexOf(characterValue, rootTag.end);
        diagnostics.push(
            diagnosticAt(
                text,
                'rpc 操作元素之外不能包含文本内容',
                characterIndex >= 0 ? characterIndex + Math.max(0, nonWhitespaceOffset) : rootTag.nameIndex,
                1
            )
        );
    }

    return resultFrom(diagnostics, operation);
};
