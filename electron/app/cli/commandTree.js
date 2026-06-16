const ParamType = require('./paramTypes');

class CommandTreeNode {
    constructor({ name = '', description = '', type = 'command', argName = null, cfgId = null, paramType = null }) {
        this.name = name;
        this.description = description;
        this.type = type;
        this.argName = argName;
        this.cfgId = cfgId;
        this.paramType = paramType;
        this.children = [];
        this.command = null;
    }
}

class CliCommandTree {
    constructor() {
        this.views = new Map();
        this.globalRoot = new CommandTreeNode({ name: 'global-root' });
        this.ensureView('user', '<NetNexus>');
        this.ensureView('config', '<NetNexus(config)>');
    }

    ensureView(name, prompt) {
        if (!this.views.has(name)) {
            this.views.set(name, {
                name,
                prompt,
                root: new CommandTreeNode({ name: `${name}-root` })
            });
        } else if (prompt) {
            this.views.get(name).prompt = prompt;
        }
        return this.views.get(name);
    }

    getView(name) {
        return this.views.get(name) || null;
    }

    getPrompt(name) {
        return this.getView(name)?.prompt || '<NetNexus>';
    }

    registerCommand(command) {
        const roots = command.views.includes('global')
            ? [this.globalRoot]
            : command.views.map(view => this.getView(view)?.root).filter(Boolean);

        const sequences = command.sequences || expandSyntax(command.syntax);
        roots.forEach(root => {
            sequences.forEach(sequence => this.registerSequence(root, sequence, command));
        });
    }

    registerSequence(root, sequence, command) {
        let current = root;
        sequence.forEach((token, index) => {
            current = addOrMergeChild(current, token);
            if (index === sequence.length - 1) {
                current.command = command;
            }
        });
    }

    match(viewName, words) {
        return matchRoot(this.getView(viewName)?.root, words) || matchRoot(this.globalRoot, words) || null;
    }

    getContexts(viewName, words) {
        const roots = [this.getView(viewName)?.root, this.globalRoot].filter(Boolean);
        const contexts = [];
        roots.forEach(root => {
            if (words.length === 0) {
                contexts.push(root);
                return;
            }
            const match = matchRoot(root, words);
            if (match && match.node) {
                contexts.push(match.node);
            }
        });
        return contexts;
    }

    collectCommandRows() {
        const rows = [];
        this.views.forEach(view => collectRows(view.root, view.name, rows));
        collectRows(this.globalRoot, 'global', rows);
        return rows;
    }
}

function addOrMergeChild(parent, token) {
    const existing = parent.children.find(child => isSameToken(child, token));
    if (existing) {
        if (!existing.description && token.description) {
            existing.description = token.description;
        }
        return existing;
    }

    const child = new CommandTreeNode(token);
    parent.children.push(child);
    return child;
}

function isSameToken(node, token) {
    if (node.type !== token.type) {
        return false;
    }
    if (node.type === 'command') {
        return node.name === token.name;
    }
    return node.argName === token.argName;
}

function matchRoot(root, words) {
    if (!root) {
        return null;
    }

    let current = root;
    const args = {};
    const cfgArgs = {};
    const path = [];

    for (const word of words) {
        const child = findMatchingChild(current, word);
        if (!child) {
            return null;
        }
        path.push(child);
        if (child.cfgId) {
            cfgArgs[child.cfgId] = child.type === 'argument' ? word : true;
        }
        if (child.type === 'argument') {
            args[child.argName] = word;
        }
        current = child;
    }

    return {
        node: current,
        command: current.command,
        args,
        cfgArgs,
        path
    };
}

function findMatchingChild(parent, word) {
    const normalized = word.toLowerCase();
    const keywordMatch = parent.children.find(
        child => child.type === 'command' && child.name.toLowerCase().startsWith(normalized)
    );
    if (keywordMatch) {
        return keywordMatch;
    }

    return (
        parent.children.find(
            child => child.type === 'argument' && (!child.paramType || child.paramType.validate(word))
        ) || null
    );
}

function expandSyntax(syntax) {
    const tokens = tokenizeSyntax(syntax);
    const parser = { tokens, index: 0 };
    return expandAst(parseSequence(parser, null));
}

function tokenizeSyntax(syntax) {
    const tokens = [];
    const regex = /<[^>]+>|\[[\s\S]*?\]|\S+/gu;
    let match;
    while ((match = regex.exec(syntax))) {
        const value = match[0];
        if (value.startsWith('[') && value.endsWith(']')) {
            tokens.push('[');
            tokens.push(...tokenizeSyntax(value.slice(1, -1)));
            tokens.push(']');
        } else {
            tokens.push(value);
        }
    }
    return tokens;
}

function parseSequence(parser, endToken) {
    const children = [];
    while (parser.index < parser.tokens.length) {
        const token = parser.tokens[parser.index];
        if (token === endToken) {
            break;
        }
        if (token === '[') {
            parser.index += 1;
            const child = parseSequence(parser, ']');
            if (parser.tokens[parser.index] === ']') {
                parser.index += 1;
            }
            children.push({ type: 'optional', child });
            continue;
        }
        parser.index += 1;
        children.push({ type: 'token', token: parseSyntaxToken(token) });
    }
    return { type: 'sequence', children };
}

function parseSyntaxToken(token) {
    const argMatch = /^<([^:>]+):([^>]+)>$/u.exec(token);
    if (argMatch) {
        return {
            type: 'argument',
            name: token,
            argName: argMatch[1],
            paramType: new ParamType(argMatch[2])
        };
    }
    return {
        type: 'command',
        name: token
    };
}

function expandAst(ast) {
    if (!ast) {
        return [[]];
    }
    if (ast.type === 'token') {
        return [[ast.token]];
    }
    if (ast.type === 'optional') {
        return [[], ...expandAst(ast.child)];
    }
    return ast.children.reduce(
        (prefixes, child) => {
            const expanded = expandAst(child);
            const next = [];
            prefixes.forEach(prefix => {
                expanded.forEach(suffix => next.push([...prefix, ...suffix]));
            });
            return next;
        },
        [[]]
    );
}

function displayNode(node) {
    if (node.type === 'command') {
        return node.name;
    }
    return node.paramType ? `<${node.paramType.displayName()}>` : node.name;
}

function collectRows(root, view, rows, prefix = []) {
    const nextPrefix =
        root.name && !root.name.endsWith('-root') && root.name !== 'global-root'
            ? [...prefix, displayNode(root)]
            : prefix;
    if (root.command) {
        rows.push({
            view,
            group: root.command.groupId,
            syntaxKey: root.command.syntax,
            command: nextPrefix.join(' ')
        });
    }
    root.children.forEach(child => collectRows(child, view, rows, nextPrefix));
}

module.exports = {
    CliCommandTree,
    displayNode
};
