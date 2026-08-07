const DATA_NODE_KEYWORDS = new Set(['container', 'list', 'leaf', 'leaf-list', 'anydata', 'anyxml']);

const schemaKeyword = node =>
    String(node?.keyword || node?.kind || '')
        .trim()
        .toLowerCase();

const schemaLocalName = value => {
    const name = String(value || '').trim();
    return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
};

const normalizeSchemaKeys = value => {
    const values = Array.isArray(value) ? value : String(value || '').split(/\s+/u);
    return [...new Set(values.map(schemaLocalName).filter(name => /^[A-Za-z_][\w.-]*$/u.test(name)))];
};

const normalizeSchemaKeyDetails = node => {
    const details = new Map(
        (Array.isArray(node?.schemaKeyDetails) ? node.schemaKeyDetails : [])
            .map(detail => {
                const name = schemaLocalName(typeof detail === 'string' ? detail : detail?.name);
                return name ? [name, detail] : null;
            })
            .filter(Boolean)
    );
    return normalizeSchemaKeys(node?.schemaKey).map(name => ({
        name,
        acceptsEmptyString: details.get(name)?.acceptsEmptyString === true
    }));
};

const escapeXmlAttribute = value =>
    String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;');

export const isSchemaDataNode = node => DATA_NODE_KEYWORDS.has(schemaKeyword(node));

export const schemaPathSegments = node => {
    const path = String(node?.path || '');
    const segments = path
        .split('/')
        .filter(Boolean)
        .map(segment => segment.replace(/\[[^\]]*\]$/u, ''));
    if (segments[0] === node?.module) segments.shift();
    return segments
        .map(segment => (segment.includes(':') ? segment.slice(segment.lastIndexOf(':') + 1) : segment))
        .filter(segment => /^[A-Za-z_][\w.-]*$/u.test(segment));
};

const fallbackNodeChain = node =>
    schemaPathSegments(node).map((name, index, segments) => ({
        ...node,
        name,
        title: name,
        keyword: index === segments.length - 1 ? node?.keyword : 'container'
    }));

/**
 * Builds the exact subtree/config fragment used by the NETCONF Browser.
 * Callers may supply the authoritative ancestor chain; path-based synthesis is
 * retained as a fallback for partially loaded legacy Schema trees.
 */
export const buildYangNodeXml = ({ node, chain = [], mode = 'filter', resolveNamespace = () => '' } = {}) => {
    if (!isSchemaDataNode(node)) return '';
    const loadedChain = (Array.isArray(chain) ? chain : []).filter(isSchemaDataNode);
    const effectiveChain = loadedChain.length ? loadedChain : fallbackNodeChain(node);
    if (!effectiveChain.length) return '';

    const render = (index, depth) => {
        const current = effectiveChain[index];
        const name = String(current?.name || current?.title || 'node');
        const indentation = '  '.repeat(depth);
        const parent = effectiveChain[index - 1];
        const namespace = resolveNamespace(current);
        const namespaceAttribute =
            namespace && (index === 0 || current?.module !== parent?.module)
                ? ` xmlns="${escapeXmlAttribute(namespace)}"`
                : '';
        const keyword = schemaKeyword(current);
        const isLast = index === effectiveChain.length - 1;
        if (mode === 'filter' && isLast) return `${indentation}<${name}${namespaceAttribute}/>`;

        const body = [];
        if (mode === 'config' && keyword === 'list') {
            const emptyKeyNames = new Set(
                normalizeSchemaKeyDetails(current)
                    .filter(key => key.acceptsEmptyString)
                    .map(key => key.name)
            );
            const keys = normalizeSchemaKeys(current?.schemaKey);
            const nextName = effectiveChain[index + 1]?.name;
            if (keys.length) {
                keys.filter(key => key !== nextName).forEach(key => {
                    if (emptyKeyNames.has(key)) {
                        body.push(`${'  '.repeat(depth + 1)}<${key}/>`);
                        return;
                    }
                    body.push(`${'  '.repeat(depth + 1)}<${key}><!-- NETNEXUS_REQUIRED: 输入 list key 值 --></${key}>`);
                });
            } else {
                body.push(`${'  '.repeat(depth + 1)}<!-- NETNEXUS_REQUIRED: 补充 list "${name}" 的所有 key -->`);
            }
        }
        if (!isLast) {
            body.push(render(index + 1, depth + 1));
        } else if (
            mode === 'config' &&
            ['leaf', 'leaf-list'].includes(keyword) &&
            current?.acceptsEmptyString === true
        ) {
            return `${indentation}<${name}${namespaceAttribute}/>`;
        } else if (mode === 'config' && ['leaf', 'leaf-list'].includes(keyword)) {
            const valueHint = typeof current?.type === 'string' && current.type ? `${current.type} 值` : '值';
            return `${indentation}<${name}${namespaceAttribute}><!-- NETNEXUS_REQUIRED: 输入${valueHint} --></${name}>`;
        } else if (mode === 'config' && keyword !== 'list') {
            body.push(`${'  '.repeat(depth + 1)}<!-- NETNEXUS_REQUIRED: 在此补充配置 -->`);
        }
        return `${indentation}<${name}${namespaceAttribute}>\n${body.join('\n')}\n${indentation}</${name}>`;
    };

    return render(0, 0);
};
