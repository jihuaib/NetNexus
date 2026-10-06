function tokenizeCommand(line, { tree = null, view = 'user' } = {}) {
    const tokens = [];
    const ranges = [];
    let current = '';
    let quote = null;
    let tokenStart = null;
    let index = 0;

    while (index < line.length) {
        const char = line[index];
        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            index += 1;
            continue;
        }
        if (/\s/u.test(char)) {
            if (tokenStart !== null) {
                tokens.push(current);
                ranges.push({ start: tokenStart, end: index, inputMode: 'normal' });
                current = '';
                tokenStart = null;
            }
            index += 1;
            continue;
        }
        if (tokenStart === null) {
            const node = findOpaqueArgument(tree, view, tokens, line.slice(index));
            if (node) {
                const argument = readOpaqueArgument(line, index, node, tree, view, tokens);
                if (argument.error) {
                    return { ok: false, error: argument.error, ranges };
                }
                tokens.push(argument.value);
                ranges.push({ start: index, end: argument.end, inputMode: 'opaque' });
                index = argument.end;
                continue;
            }
            tokenStart = index;
        }
        if (char === '"' || char === "'") {
            quote = char;
        } else {
            current += char;
        }
        index += 1;
    }

    if (tokenStart !== null) {
        tokens.push(current);
        ranges.push({ start: tokenStart, end: line.length, inputMode: 'normal' });
    }
    if (quote) {
        return { ok: false, error: 'Error: Unclosed quote.', ranges };
    }
    return {
        ok: true,
        tokens,
        ranges,
        nextInputMode: findOpaqueArgument(tree, view, tokens, '') ? 'opaque' : 'normal'
    };
}

function findOpaqueArgument(tree, view, tokens, remainder) {
    if (!tree) {
        return null;
    }
    const firstWord = readFirstToken(remainder).toLowerCase();
    for (const match of tree.getContextMatches(view, tokens)) {
        if (
            firstWord &&
            match.node.children.some(
                child => child.type === 'command' && child.name.toLowerCase().startsWith(firstWord)
            )
        ) {
            return null;
        }
        const argument = match.node.children.find(
            child =>
                child.type === 'argument' &&
                (child.inputMode === 'opaque' || !child.paramType || child.paramType.validate(firstWord))
        );
        if (argument) {
            return argument.inputMode === 'opaque' ? argument : null;
        }
    }
    return null;
}

function readFirstToken(line) {
    let value = '';
    let quote = null;
    for (const char of line) {
        if (quote) {
            if (char === quote) quote = null;
            else value += char;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (/\s/u.test(char)) {
            break;
        } else {
            value += char;
        }
    }
    return value;
}

function readOpaqueArgument(line, start, node, tree, view, tokens) {
    const end = line.trimEnd().length;
    let result = { ...decodeOpaqueValue(line.slice(start, end)), end };
    const maxSuffixTokens = getSuffixDepth(node);
    let quote = null;
    let suffixTokens = 0;

    // A declared command suffix takes precedence over the unquoted value.
    // Reverse quote tracking keeps whitespace inside a suffix argument together.
    for (let index = end - 1; index >= start && suffixTokens < maxSuffixTokens; index -= 1) {
        const char = line[index];
        if (quote) {
            if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (!/\s/u.test(char)) {
            continue;
        }
        const suffixStart = index + 1;
        while (index > start && /\s/u.test(line[index - 1])) index -= 1;
        const valueEnd = index;
        suffixTokens += 1;
        const decoded = decodeOpaqueValue(line.slice(start, valueEnd));
        const suffixText = line.slice(suffixStart, end);
        if (/["']/u.test(suffixText)) {
            continue;
        }
        const suffix = tokenizeCommand(suffixText);
        if (decoded.error || !suffix.ok) {
            continue;
        }
        const match = tree.match(view, [...tokens, decoded.value, ...suffix.tokens]);
        if (match && match.command && match.path[tokens.length] === node) {
            result = { ...decoded, end: valueEnd };
        }
    }
    return result;
}

function decodeOpaqueValue(value) {
    if (value[0] !== '"' && value[0] !== "'") {
        return { value };
    }
    if (value.length < 2 || value[value.length - 1] !== value[0]) {
        return { error: 'Error: Unclosed quote.' };
    }
    return { value: value.slice(1, -1) };
}

function getSuffixDepth(node) {
    return node.children.reduce((depth, child) => Math.max(depth, 1 + getSuffixDepth(child)), 0);
}

module.exports = tokenizeCommand;
