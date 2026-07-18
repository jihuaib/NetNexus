const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;

class YangLexer {
    constructor(source, options = {}) {
        this.source = String(source ?? '').replace(/^\uFEFF/, '');
        this.sourceName = options.sourceName || '<memory>';
        this.offset = 0;
        this.line = 1;
        this.column = 1;
        this.tokens = [];
        this.diagnostics = [];
    }

    current() {
        return this.source[this.offset];
    }

    peek(distance = 1) {
        return this.source[this.offset + distance];
    }

    advance() {
        const value = this.current();
        this.offset += 1;
        if (value === '\n') {
            this.line += 1;
            this.column = 1;
        } else {
            this.column += 1;
        }
        return value;
    }

    location() {
        return {
            offset: this.offset,
            line: this.line,
            column: this.column
        };
    }

    addDiagnostic(code, message, location = this.location(), severity = 'error') {
        this.diagnostics.push({
            severity,
            code,
            message,
            source: this.sourceName,
            line: location.line,
            column: location.column,
            offset: location.offset
        });
    }

    addToken(type, value, start, raw = value) {
        this.tokens.push({
            type,
            value,
            raw,
            source: this.sourceName,
            line: start.line,
            column: start.column,
            offset: start.offset,
            endOffset: this.offset
        });
    }

    skipWhitespaceAndComments() {
        let progressed = true;
        while (progressed) {
            progressed = false;
            while (this.offset < this.source.length && /\s/u.test(this.current())) {
                this.advance();
                progressed = true;
            }

            if (this.current() === '/' && this.peek() === '/') {
                progressed = true;
                this.advance();
                this.advance();
                while (this.offset < this.source.length && this.current() !== '\n') {
                    this.advance();
                }
                continue;
            }

            if (this.current() === '/' && this.peek() === '*') {
                const start = this.location();
                progressed = true;
                this.advance();
                this.advance();
                let closed = false;
                while (this.offset < this.source.length) {
                    if (this.current() === '*' && this.peek() === '/') {
                        this.advance();
                        this.advance();
                        closed = true;
                        break;
                    }
                    this.advance();
                }
                if (!closed) {
                    this.addDiagnostic('UNTERMINATED_COMMENT', 'Unterminated block comment', start);
                }
            }
        }
    }

    readQuotedString(quote) {
        const start = this.location();
        let value = '';
        let raw = this.advance();
        let closed = false;

        while (this.offset < this.source.length) {
            const character = this.advance();
            raw += character;
            if (character === quote) {
                closed = true;
                break;
            }

            if (quote === '"' && character === '\\') {
                if (this.offset >= this.source.length) {
                    break;
                }
                const escaped = this.advance();
                raw += escaped;
                if (escaped === 'n') {
                    value += '\n';
                } else if (escaped === 't') {
                    value += '\t';
                } else if (escaped === '"' || escaped === '\\') {
                    value += escaped;
                } else if (escaped === '\n') {
                    // A backslash followed by a physical newline is folded away.
                } else {
                    value += escaped;
                    this.addDiagnostic(
                        'INVALID_ESCAPE',
                        `Unsupported escape sequence \\${escaped}`,
                        {
                            offset: this.offset - 2,
                            line: this.line,
                            column: Math.max(1, this.column - 2)
                        },
                        'warning'
                    );
                }
            } else {
                value += character;
            }
        }

        if (!closed) {
            this.addDiagnostic('UNTERMINATED_STRING', 'Unterminated quoted string', start);
        }
        this.addToken('string', value, start, raw);
    }

    readWord() {
        const start = this.location();
        let value = '';
        while (this.offset < this.source.length) {
            const character = this.current();
            if (/\s/u.test(character) || ['{', '}', ';', '+', '"', "'"].includes(character)) {
                break;
            }
            if (character === '/' && (this.peek() === '/' || this.peek() === '*')) {
                break;
            }
            value += this.advance();
        }

        if (value.length === 0) {
            const character = this.advance();
            this.addDiagnostic('UNEXPECTED_CHARACTER', `Unexpected character ${JSON.stringify(character)}`, start);
            return;
        }
        this.addToken('word', value, start);
    }

    tokenize() {
        while (this.offset < this.source.length) {
            this.skipWhitespaceAndComments();
            if (this.offset >= this.source.length) {
                break;
            }

            const start = this.location();
            const character = this.current();
            if (character === '{') {
                this.advance();
                this.addToken('lbrace', character, start);
            } else if (character === '}') {
                this.advance();
                this.addToken('rbrace', character, start);
            } else if (character === ';') {
                this.advance();
                this.addToken('semicolon', character, start);
            } else if (character === '+') {
                this.advance();
                this.addToken('plus', character, start);
            } else if (character === '"' || character === "'") {
                this.readQuotedString(character);
            } else {
                this.readWord();
            }
        }

        const eof = this.location();
        this.tokens.push({
            type: 'eof',
            value: '',
            raw: '',
            source: this.sourceName,
            line: eof.line,
            column: eof.column,
            offset: eof.offset,
            endOffset: eof.offset
        });
        return {
            tokens: this.tokens,
            diagnostics: this.diagnostics
        };
    }
}

class YangStatementParser {
    constructor(tokens, diagnostics = [], options = {}) {
        this.tokens = tokens;
        this.diagnostics = diagnostics;
        this.sourceName = options.sourceName || '<memory>';
        this.position = 0;
    }

    current() {
        return this.tokens[this.position] || this.tokens[this.tokens.length - 1];
    }

    advance() {
        const token = this.current();
        if (token.type !== 'eof') {
            this.position += 1;
        }
        return token;
    }

    addDiagnostic(code, message, token = this.current(), severity = 'error') {
        this.diagnostics.push({
            severity,
            code,
            message,
            source: token.source || this.sourceName,
            line: token.line,
            column: token.column,
            offset: token.offset
        });
    }

    recoverStatement() {
        let nesting = 0;
        while (this.current().type !== 'eof') {
            const token = this.advance();
            if (token.type === 'lbrace') {
                nesting += 1;
            } else if (token.type === 'rbrace') {
                if (nesting === 0) {
                    this.position -= 1;
                    return;
                }
                nesting -= 1;
            } else if (token.type === 'semicolon' && nesting === 0) {
                return;
            }
        }
    }

    parseArgument() {
        const token = this.current();
        if (token.type === 'string') {
            let value = this.advance().value;
            while (this.current().type === 'plus') {
                const plus = this.advance();
                if (this.current().type !== 'string') {
                    this.addDiagnostic('EXPECTED_STRING', 'The + operator must be followed by a quoted string', plus);
                    break;
                }
                value += this.advance().value;
            }
            if (this.current().type === 'string' || this.current().type === 'word') {
                this.addDiagnostic('MISSING_STRING_CONCAT', 'Adjacent argument values must be joined with +');
                while (this.current().type === 'string' || this.current().type === 'word') {
                    value += this.advance().value;
                }
            }
            return value;
        }

        if (token.type === 'word') {
            return this.advance().value;
        }
        return null;
    }

    parseStatement() {
        const keywordToken = this.current();
        if (keywordToken.type !== 'word') {
            this.addDiagnostic('EXPECTED_KEYWORD', `Expected a statement keyword, found ${keywordToken.type}`);
            this.recoverStatement();
            return null;
        }

        this.advance();
        if (!IDENTIFIER_RE.test(keywordToken.value)) {
            this.addDiagnostic('INVALID_KEYWORD', `Invalid statement keyword ${keywordToken.value}`, keywordToken);
        }

        let argument = null;
        if (!['semicolon', 'lbrace', 'rbrace', 'eof'].includes(this.current().type)) {
            argument = this.parseArgument();
        }

        const node = {
            keyword: keywordToken.value,
            argument,
            children: [],
            source: keywordToken.source,
            line: keywordToken.line,
            column: keywordToken.column,
            offset: keywordToken.offset,
            endOffset: keywordToken.endOffset
        };

        if (this.current().type === 'semicolon') {
            node.endOffset = this.advance().endOffset;
            return node;
        }

        if (this.current().type !== 'lbrace') {
            this.addDiagnostic('EXPECTED_TERMINATOR', `Statement ${keywordToken.value} must end with ; or { ... }`);
            this.recoverStatement();
            return node;
        }

        this.advance();
        while (this.current().type !== 'rbrace' && this.current().type !== 'eof') {
            const child = this.parseStatement();
            if (child) {
                node.children.push(child);
            }
        }

        if (this.current().type === 'rbrace') {
            node.endOffset = this.advance().endOffset;
        } else {
            this.addDiagnostic('UNCLOSED_BLOCK', `Statement ${keywordToken.value} has no closing brace`, keywordToken);
        }
        return node;
    }

    parse() {
        const statements = [];
        while (this.current().type !== 'eof') {
            if (this.current().type === 'rbrace') {
                this.addDiagnostic('UNEXPECTED_RBRACE', 'Unexpected closing brace');
                this.advance();
                continue;
            }
            const statement = this.parseStatement();
            if (statement) {
                statements.push(statement);
            }
        }
        return {
            statements,
            ast: statements.length === 1 ? statements[0] : null,
            diagnostics: this.diagnostics
        };
    }
}

function findChildren(statement, keyword) {
    if (!statement || !Array.isArray(statement.children)) {
        return [];
    }
    return statement.children.filter(child => child.keyword === keyword);
}

function findChild(statement, keyword) {
    return findChildren(statement, keyword)[0] || null;
}

function statementValue(statement, keyword, defaultValue = null) {
    const child = findChild(statement, keyword);
    return child && child.argument !== null ? child.argument : defaultValue;
}

function collectMetadata(parseResult, options = {}) {
    const diagnostics = [...(parseResult.diagnostics || [])];
    const statements = parseResult.statements || [];
    const rootCandidates = statements.filter(statement => ['module', 'submodule'].includes(statement.keyword));
    const root = rootCandidates[0] || null;

    if (statements.length !== 1 || !root) {
        diagnostics.push({
            severity: 'error',
            code: 'INVALID_DOCUMENT_ROOT',
            message: 'A YANG document must contain exactly one module or submodule statement',
            source: options.sourceName || '<memory>',
            line: statements[0]?.line || 1,
            column: statements[0]?.column || 1,
            offset: statements[0]?.offset || 0
        });
    }

    if (!root) {
        return {
            ast: null,
            metadata: null,
            diagnostics
        };
    }

    const revisions = findChildren(root, 'revision')
        .map(statement => statement.argument)
        .filter(Boolean);
    const duplicateRevisions = revisions.filter((revision, index) => revisions.indexOf(revision) !== index);
    for (const revision of [...new Set(duplicateRevisions)]) {
        diagnostics.push({
            severity: 'error',
            code: 'DUPLICATE_REVISION_STATEMENT',
            message: `Revision ${revision} is declared more than once in ${root.argument}`,
            source: root.source,
            line: root.line,
            column: root.column,
            offset: root.offset
        });
    }

    const dependencies = (keyword, kind) =>
        findChildren(root, keyword).map(statement => ({
            kind,
            name: statement.argument,
            revisionDate: statementValue(statement, 'revision-date'),
            prefix: statementValue(statement, 'prefix'),
            description: statementValue(statement, 'description'),
            line: statement.line,
            column: statement.column
        }));

    const metadata = {
        kind: root.keyword,
        name: root.argument,
        yangVersion: statementValue(root, 'yang-version', '1'),
        namespace: statementValue(root, 'namespace'),
        prefix: statementValue(root, 'prefix'),
        belongsTo: statementValue(root, 'belongs-to'),
        belongsToPrefix: findChild(root, 'belongs-to') ? statementValue(findChild(root, 'belongs-to'), 'prefix') : null,
        revisions,
        revision: revisions.slice().sort().reverse()[0] || null,
        imports: dependencies('import', 'import'),
        includes: dependencies('include', 'include'),
        features: findChildren(root, 'feature')
            .map(statement => statement.argument)
            .filter(Boolean),
        deviations: findChildren(root, 'deviation').map(statement => ({
            target: statement.argument,
            line: statement.line,
            column: statement.column
        })),
        organization: statementValue(root, 'organization'),
        description: statementValue(root, 'description')
    };

    if (!metadata.name) {
        diagnostics.push({
            severity: 'error',
            code: 'MISSING_MODULE_NAME',
            message: `${root.keyword} statement is missing its name`,
            source: root.source,
            line: root.line,
            column: root.column,
            offset: root.offset
        });
    }
    if (!['1', '1.1'].includes(metadata.yangVersion)) {
        diagnostics.push({
            severity: 'error',
            code: 'UNSUPPORTED_YANG_VERSION',
            message: `Unsupported YANG version ${metadata.yangVersion}`,
            source: root.source,
            line: root.line,
            column: root.column,
            offset: root.offset
        });
    }

    return {
        ast: root,
        metadata,
        diagnostics
    };
}

function parseYang(source, options = {}) {
    const lexer = new YangLexer(source, options);
    const lexical = lexer.tokenize();
    const parser = new YangStatementParser(lexical.tokens, lexical.diagnostics, options);
    const parsed = parser.parse();
    return collectMetadata(parsed, options);
}

module.exports = {
    YangLexer,
    YangStatementParser,
    parseYang,
    collectMetadata,
    findChild,
    findChildren,
    statementValue
};
