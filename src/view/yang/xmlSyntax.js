const MAX_HIGHLIGHT_LENGTH = 2 * 1024 * 1024;
const MAX_HIGHLIGHT_TOKENS = 60_000;
const XML_ENTITY_PATTERN = /^&(?:#\d+|#x[\da-f]+|[A-Za-z_][\w.:-]*);$/iu;

const isWhitespace = value => /\s/u.test(value);
const isNameBoundary = value => !value || isWhitespace(value) || ['=', '/', '>', '?'].includes(value);

const declarationEnd = (source, start) => {
    let quote = '';
    let subsetDepth = 0;
    for (let index = start + 2; index < source.length; index += 1) {
        const character = source[index];
        if (quote) {
            if (character === quote) quote = '';
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '[') {
            subsetDepth += 1;
        } else if (character === ']' && subsetDepth > 0) {
            subsetDepth -= 1;
        } else if (character === '>' && subsetDepth === 0) {
            return index + 1;
        }
    }
    return source.length;
};

const tokenizeText = (source, start, end, push) => {
    let cursor = start;
    while (cursor < end) {
        const entityStart = source.indexOf('&', cursor);
        if (entityStart < 0 || entityStart >= end) {
            push('text', source.slice(cursor, end));
            return;
        }
        if (entityStart > cursor) push('text', source.slice(cursor, entityStart));
        const entityEnd = source.indexOf(';', entityStart + 1);
        if (entityEnd >= 0 && entityEnd < end && entityEnd - entityStart <= 64) {
            const candidate = source.slice(entityStart, entityEnd + 1);
            if (XML_ENTITY_PATTERN.test(candidate)) {
                push('entity', candidate);
                cursor = entityEnd + 1;
                continue;
            }
        }
        push('text', '&');
        cursor = entityStart + 1;
    }
};

const tokenizeTag = (source, start, push) => {
    let cursor = start;
    if (source.startsWith('</', cursor)) {
        push('punctuation', '</');
        cursor += 2;
    } else {
        push('punctuation', '<');
        cursor += 1;
    }

    const tagStart = cursor;
    while (cursor < source.length && !isNameBoundary(source[cursor])) cursor += 1;
    push('tag', source.slice(tagStart, cursor));

    while (cursor < source.length) {
        if (source.startsWith('/>', cursor)) {
            push('punctuation', '/>');
            return cursor + 2;
        }
        if (source[cursor] === '>') {
            push('punctuation', '>');
            return cursor + 1;
        }
        if (isWhitespace(source[cursor])) {
            const whitespaceStart = cursor;
            while (cursor < source.length && isWhitespace(source[cursor])) cursor += 1;
            push('plain', source.slice(whitespaceStart, cursor));
            continue;
        }

        const attributeStart = cursor;
        while (cursor < source.length && !isNameBoundary(source[cursor])) cursor += 1;
        if (cursor === attributeStart) {
            push('punctuation', source[cursor]);
            cursor += 1;
            continue;
        }
        push('attribute', source.slice(attributeStart, cursor));

        const whitespaceStart = cursor;
        while (cursor < source.length && isWhitespace(source[cursor])) cursor += 1;
        push('plain', source.slice(whitespaceStart, cursor));
        if (source[cursor] !== '=') continue;
        push('punctuation', '=');
        cursor += 1;

        const valueWhitespaceStart = cursor;
        while (cursor < source.length && isWhitespace(source[cursor])) cursor += 1;
        push('plain', source.slice(valueWhitespaceStart, cursor));
        if (cursor >= source.length) break;

        const quote = source[cursor];
        if (quote === '"' || quote === "'") {
            const valueStart = cursor;
            cursor += 1;
            while (cursor < source.length && source[cursor] !== quote) cursor += 1;
            if (cursor < source.length) cursor += 1;
            push('value', source.slice(valueStart, cursor));
        } else {
            const valueStart = cursor;
            while (cursor < source.length && !isWhitespace(source[cursor]) && !['/', '>'].includes(source[cursor])) {
                cursor += 1;
            }
            push('value', source.slice(valueStart, cursor));
        }
    }
    return cursor;
};

export const tokenizeXml = value => {
    const source = String(value ?? '');
    if (!source) return [];
    if (source.length > MAX_HIGHLIGHT_LENGTH) return [{ type: 'text', value: source }];

    const tokens = [];
    let stopped = false;
    const push = (type, tokenValue) => {
        if (!tokenValue || stopped) return;
        if (tokens.length >= MAX_HIGHLIGHT_TOKENS) {
            stopped = true;
            return;
        }
        const previous = tokens[tokens.length - 1];
        if (previous?.type === type) previous.value += tokenValue;
        else tokens.push({ type, value: tokenValue });
    };

    let cursor = 0;
    while (cursor < source.length && !stopped) {
        if (source[cursor] !== '<') {
            const nextTag = source.indexOf('<', cursor);
            const end = nextTag < 0 ? source.length : nextTag;
            tokenizeText(source, cursor, end, push);
            cursor = end;
            continue;
        }

        if (source.startsWith('<!--', cursor)) {
            const end = source.indexOf('-->', cursor + 4);
            const next = end < 0 ? source.length : end + 3;
            push('comment', source.slice(cursor, next));
            cursor = next;
        } else if (source.startsWith('<![CDATA[', cursor)) {
            const end = source.indexOf(']]>', cursor + 9);
            const next = end < 0 ? source.length : end + 3;
            push('cdata', source.slice(cursor, next));
            cursor = next;
        } else if (source.startsWith('<?', cursor)) {
            const end = source.indexOf('?>', cursor + 2);
            const next = end < 0 ? source.length : end + 2;
            push('declaration', source.slice(cursor, next));
            cursor = next;
        } else if (source.startsWith('<!', cursor)) {
            const next = declarationEnd(source, cursor);
            push('declaration', source.slice(cursor, next));
            cursor = next;
        } else {
            cursor = tokenizeTag(source, cursor, push);
        }
    }

    const consumedLength = tokens.reduce((total, token) => total + token.value.length, 0);
    if (consumedLength < source.length) tokens.push({ type: 'text', value: source.slice(consumedLength) });
    return tokens;
};
