const NETCONF_BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';

const XML_NAME_START = /[A-Za-z_]/u;
const XML_NAME_CHARACTER = /[A-Za-z0-9_.:-]/u;

function maskXml(value) {
    return String(value || '').replace(/[^\n]/gu, ' ');
}

function lineAt(value, rawIndex) {
    const text = String(value || '');
    const index = Math.max(0, Math.min(Number(rawIndex) || 0, text.length));
    return text.slice(0, index).split('\n').length;
}

function lineStartAt(value, rawLine) {
    const text = String(value || '');
    const targetLine = Math.max(1, Number(rawLine) || 1);
    let line = 1;
    let index = 0;
    while (line < targetLine && index < text.length) {
        if (text[index] === '\n') line += 1;
        index += 1;
    }
    return index;
}

function findTagEnd(value, start) {
    let quote = '';
    for (let index = start; index < value.length; index += 1) {
        const character = value[index];
        if (quote) {
            if (character === quote) quote = '';
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '>') {
            return index;
        }
    }
    return value.length - 1;
}

function parseAttributes(value, start, end) {
    const attributes = [];
    const source = value.slice(start, end);
    const pattern = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])([\s\S]*?)\2/gu;
    for (const match of source.matchAll(pattern)) {
        attributes.push({
            name: match[1],
            value: match[3],
            index: start + match.index,
            length: match[0].length
        });
    }
    return attributes;
}

function scanXmlElements(value) {
    const text = String(value || '');
    const roots = [];
    const elements = [];
    const stack = [];
    let cursor = 0;

    while (cursor < text.length) {
        const start = text.indexOf('<', cursor);
        if (start < 0) break;
        if (text.startsWith('<!--', start)) {
            const end = text.indexOf('-->', start + 4);
            cursor = end < 0 ? text.length : end + 3;
            continue;
        }
        if (text.startsWith('<![CDATA[', start)) {
            const end = text.indexOf(']]>', start + 9);
            cursor = end < 0 ? text.length : end + 3;
            continue;
        }
        if (text.startsWith('<?', start)) {
            const end = text.indexOf('?>', start + 2);
            cursor = end < 0 ? text.length : end + 2;
            continue;
        }
        if (text.startsWith('<!', start)) {
            const end = findTagEnd(text, start + 2);
            cursor = end + 1;
            continue;
        }

        const closing = text.startsWith('</', start);
        let nameStart = start + (closing ? 2 : 1);
        while (/\s/u.test(text[nameStart] || '')) nameStart += 1;
        if (!XML_NAME_START.test(text[nameStart] || '')) {
            cursor = start + 1;
            continue;
        }
        let nameEnd = nameStart + 1;
        while (XML_NAME_CHARACTER.test(text[nameEnd] || '')) nameEnd += 1;
        const qualifiedName = text.slice(nameStart, nameEnd);
        const tagEnd = findTagEnd(text, nameEnd);

        if (closing) {
            for (let index = stack.length - 1; index >= 0; index -= 1) {
                if (stack[index].qualifiedName !== qualifiedName) continue;
                const node = stack[index];
                node.closeStart = start;
                node.end = tagEnd + 1;
                stack.length = index;
                break;
            }
            cursor = tagEnd + 1;
            continue;
        }

        const parent = stack.at(-1) || null;
        const attributes = parseAttributes(text, nameEnd, tagEnd);
        const namespaceMap = new Map(parent?.namespaceMap || []);
        const declaredNamespaces = new Set();
        attributes.forEach(attribute => {
            if (attribute.name === 'xmlns') {
                namespaceMap.set('', attribute.value);
                declaredNamespaces.add('');
            } else if (attribute.name.startsWith('xmlns:')) {
                const prefix = attribute.name.slice('xmlns:'.length);
                namespaceMap.set(prefix, attribute.value);
                declaredNamespaces.add(prefix);
            }
        });
        const separator = qualifiedName.indexOf(':');
        const prefix = separator >= 0 ? qualifiedName.slice(0, separator) : '';
        const localName = separator >= 0 ? qualifiedName.slice(separator + 1) : qualifiedName;
        const beforeClose = text.slice(nameEnd, tagEnd).trimEnd();
        const selfClosing = beforeClose.endsWith('/');
        const node = {
            qualifiedName,
            prefix,
            localName,
            namespace: namespaceMap.get(prefix) || '',
            namespaceMap,
            declaredNamespaces,
            attributes,
            start,
            nameStart,
            nameEnd,
            openEnd: tagEnd + 1,
            closeStart: selfClosing ? tagEnd : null,
            end: selfClosing ? tagEnd + 1 : null,
            selfClosing,
            parent,
            children: []
        };
        if (parent) parent.children.push(node);
        else roots.push(node);
        elements.push(node);
        if (!selfClosing) stack.push(node);
        cursor = tagEnd + 1;
    }

    stack.forEach(node => {
        if (node.end === null) node.end = text.length;
        if (node.closeStart === null) node.closeStart = text.length;
    });
    return { roots, elements };
}

function firstChild(node, localName) {
    return node?.children?.find(child => child.localName === localName) || null;
}

function configPayloadNodes(operation) {
    if (operation.localName === 'edit-config') {
        return firstChild(operation, 'config')?.children || [];
    }
    if (operation.localName === 'copy-config' || operation.localName === 'validate') {
        return firstChild(firstChild(operation, 'source'), 'config')?.children || [];
    }
    return [];
}

function resolveRpcValidationTarget(value) {
    const text = String(value || '');
    const scanned = scanXmlElements(text);
    const root = scanned.roots[0] || null;
    if (!root || root.localName !== 'rpc' || root.namespace !== NETCONF_BASE_NAMESPACE) {
        return {
            operation: '',
            validationType: null,
            nodes: [],
            skipped: true,
            reason: 'not-netconf-rpc'
        };
    }
    const operation = root.children[0] || null;
    if (!operation) {
        return {
            operation: '',
            validationType: null,
            nodes: [],
            skipped: true,
            reason: 'missing-operation'
        };
    }

    if (operation.namespace === NETCONF_BASE_NAMESPACE) {
        const nodes = configPayloadNodes(operation);
        if (nodes.length) {
            return {
                operation: operation.localName,
                validationType: 'edit',
                nodes,
                skipped: false,
                reason: ''
            };
        }
        if (operation.localName === 'action' && operation.children.length) {
            return {
                operation: operation.localName,
                validationType: 'rpc',
                nodes: operation.children,
                skipped: false,
                reason: ''
            };
        }
        return {
            operation: operation.localName,
            validationType: null,
            nodes: [],
            skipped: true,
            reason: 'no-yang-instance-data'
        };
    }

    return {
        operation: operation.localName,
        validationType: 'rpc',
        nodes: [operation],
        skipped: false,
        reason: ''
    };
}

function escapeXmlAttribute(value) {
    return String(value || '')
        .replace(/&/gu, '&amp;')
        .replace(/"/gu, '&quot;')
        .replace(/</gu, '&lt;');
}

function standaloneNodeXml(value, node) {
    const text = String(value || '');
    const sourceCharacters = text.slice(node.start, node.end).split('');
    const queue = [node];
    while (queue.length) {
        const current = queue.shift();
        queue.push(...current.children);
        current.attributes.forEach(attribute => {
            const separator = attribute.name.indexOf(':');
            if (separator < 0 || attribute.name.startsWith('xmlns:')) return;
            const prefix = attribute.name.slice(0, separator);
            if (current.namespaceMap.get(prefix) !== NETCONF_BASE_NAMESPACE) return;
            const relativeStart = attribute.index - node.start;
            for (let offset = 0; offset < attribute.length; offset += 1) {
                const index = relativeStart + offset;
                if (sourceCharacters[index] !== '\n') sourceCharacters[index] = ' ';
            }
        });
    }
    const source = sourceCharacters.join('');
    const declarations = [];
    for (const [prefix, namespace] of node.namespaceMap) {
        if (!namespace || node.declaredNamespaces.has(prefix) || prefix === 'xml') continue;
        const name = prefix ? `xmlns:${prefix}` : 'xmlns';
        declarations.push(`${name}="${escapeXmlAttribute(namespace)}"`);
    }
    if (!declarations.length) return source;
    const relativeNameEnd = node.nameEnd - node.start;
    return `${source.slice(0, relativeNameEnd)} ${declarations.join(' ')}${source.slice(relativeNameEnd)}`;
}

function buildRpcValidationPayload(value, nodes) {
    const text = String(value || '');
    const sorted = [...nodes].sort((left, right) => left.start - right.start);
    let cursor = 0;
    let payload = '';
    sorted.forEach(node => {
        payload += maskXml(text.slice(cursor, node.start));
        payload += standaloneNodeXml(text, node);
        cursor = node.end;
    });
    payload += maskXml(text.slice(cursor));
    return payload;
}

function diagnosticDataPath(message) {
    return String(message || '').match(/\((\/[^)]+)\)\s*(?:\(line|$)/u)?.[1] || '';
}

function diagnosticLine(message, fallback) {
    const match = String(message || '').match(/\(line(?: number)?\s*:?\s*(\d+)\)/iu);
    return match ? Number(match[1]) : Number(fallback) || 1;
}

function quotedInvalidValue(message) {
    const match = String(message || '').match(/\bvalue\s+"([^"]*)"/iu);
    return match ? match[1] : null;
}

function closestValueLocation(value, expectedLine, expectedValue) {
    const text = String(value || '');
    if (expectedValue === null || expectedValue === '') return null;
    const candidates = [];
    let cursor = 0;
    while (cursor <= text.length) {
        const index = text.indexOf(expectedValue, cursor);
        if (index < 0) break;
        candidates.push({ index, line: lineAt(text, index) });
        cursor = index + Math.max(1, expectedValue.length);
    }
    return (
        candidates.sort((left, right) => Math.abs(left.line - expectedLine) - Math.abs(right.line - expectedLine))[0] ||
        null
    );
}

function localizeLibyangMessage(message) {
    const text = String(message || '').trim();
    let match = text.match(/^Invalid boolean value "([^"]*)"\./iu);
    if (match) return `YANG boolean 值不合法：“${match[1]}”，只允许 true 或 false`;
    match = text.match(/^Invalid type ([^ ]+) value "([^"]*)"\./iu);
    if (match) return `YANG ${match[1]} 值不合法：“${match[2]}”`;
    match = text.match(/^Invalid value "([^"]*)"/iu);
    if (match) return `YANG 值不合法：“${match[1]}”`;
    return `YANG 校验失败：${text.replace(/\s*\(\/[^)]+\)\s*\(line(?: number)?\s*:?\s*\d+\)\s*$/iu, '')}`;
}

function normalizeLibyangRpcDiagnostic(value, diagnostic, fallbackLine = 1) {
    const text = String(value || '');
    let line = Math.max(1, diagnosticLine(diagnostic?.message, diagnostic?.line || fallbackLine));
    const invalidValue = quotedInvalidValue(diagnostic?.message);
    const closest = closestValueLocation(text, line, invalidValue);
    let index;
    let length;
    if (closest) {
        line = closest.line;
        index = closest.index;
        length = Math.max(1, invalidValue.length);
    } else {
        const start = lineStartAt(text, line);
        const end = text.indexOf('\n', start);
        const lineText = text.slice(start, end < 0 ? text.length : end);
        const offset = Math.max(0, lineText.search(/\S/u));
        index = start + offset;
        length = Math.max(1, lineText.trim().length ? 1 : 0);
    }
    return {
        severity: 'error',
        code: diagnostic?.code || 'LIBYANG_DATA',
        message: localizeLibyangMessage(diagnostic?.message),
        rawMessage: String(diagnostic?.message || ''),
        dataPath: diagnosticDataPath(diagnostic?.message),
        authoritative: true,
        engine: 'libyang',
        line,
        column: index - lineStartAt(text, line) + 1,
        index,
        length
    };
}

function isSecondaryYanglintDiagnostic(diagnostic) {
    return /Failed to parse input data file|Failed to parse input data/u.test(String(diagnostic?.message || ''));
}

module.exports = {
    NETCONF_BASE_NAMESPACE,
    buildRpcValidationPayload,
    isSecondaryYanglintDiagnostic,
    lineAt,
    normalizeLibyangRpcDiagnostic,
    resolveRpcValidationTarget,
    scanXmlElements
};
