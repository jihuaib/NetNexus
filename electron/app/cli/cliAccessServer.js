const net = require('net');
const path = require('path');
const logger = require('../../log/logger');
const { CliCommandTree, displayNode } = require('./commandTree');
const XmlCommandLoader = require('./xmlCommandLoader');
const CliHandlers = require('./handlers');
const CliSession = require('./session');
const { TELNET, negotiationBuffer } = require('./telnet');
const { formatDate, formatTable } = require('./formatters');
const { CliCommandError } = require('./errors');

const DEFAULT_CLI_ACCESS_SETTINGS = {
    host: '127.0.0.1',
    port: 3788,
    maxSessions: 5
};

function normalizeCliSettings(settings = {}) {
    const port = Number(settings.port ?? DEFAULT_CLI_ACCESS_SETTINGS.port);
    const maxSessions = Number(settings.maxSessions ?? DEFAULT_CLI_ACCESS_SETTINGS.maxSessions);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('CLI端口必须是1到65535之间的整数');
    }
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 100) {
        throw new Error('CLI最大会话数必须是1到100之间的整数');
    }

    return {
        enabled: Boolean(settings.enabled),
        host: settings.host || DEFAULT_CLI_ACCESS_SETTINGS.host,
        port,
        maxSessions
    };
}

class CliAccessServer {
    constructor({ bmpApp, externalApiServer, settings = {} } = {}) {
        this.bmpApp = bmpApp;
        this.externalApiServer = externalApiServer;
        this.settings = normalizeCliSettings(settings);
        this.server = null;
        this.sessions = new Map();
        this.nextLineId = 1;
        this.globalHistory = [];
        this.tree = null;
        this.handlers = null;
    }

    getRunning() {
        return this.server !== null;
    }

    getStatus() {
        return {
            running: this.getRunning(),
            enabled: Boolean(this.settings.enabled),
            loaded: Boolean(this.tree && this.handlers),
            host: this.settings.host,
            port: this.settings.port,
            maxSessions: this.settings.maxSessions,
            sessions: this.sessions.size
        };
    }

    async updateSettings(settings) {
        const nextSettings = normalizeCliSettings({
            ...this.settings,
            ...(settings || {})
        });
        const needsRestart =
            this.getRunning() &&
            (this.settings.host !== nextSettings.host ||
                Number(this.settings.port) !== Number(nextSettings.port) ||
                Number(this.settings.maxSessions) !== Number(nextSettings.maxSessions));

        this.settings = nextSettings;

        if (!nextSettings.enabled) {
            await this.stop();
            return;
        }

        if (needsRestart) {
            await this.stop();
        }
        await this.start();
    }

    loadRuntimeData() {
        if (this.tree && this.handlers) {
            return;
        }

        this.sessions = new Map();
        this.nextLineId = 1;
        this.globalHistory = [];
        this.tree = new CliCommandTree();
        new XmlCommandLoader(this.tree).load(path.join(__dirname, 'commands.xml'));
        this.handlers = new CliHandlers(this);
    }

    releaseRuntimeData() {
        this.sessions = new Map();
        this.nextLineId = 1;
        this.globalHistory = [];
        this.tree = null;
        this.handlers = null;
    }

    async start() {
        if (this.server) {
            return;
        }

        this.loadRuntimeData();
        try {
            await new Promise((resolve, reject) => {
                const server = net.createServer(socket => this.handleConnection(socket));
                const onError = error => {
                    server.removeListener('listening', onListening);
                    reject(error);
                };
                const onListening = () => {
                    server.removeListener('error', onError);
                    this.server = server;
                    logger.info(`Telnet CLI server listening on ${this.settings.host}:${this.settings.port}`);
                    resolve();
                };

                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(this.settings.port, this.settings.host);
            });
        } catch (error) {
            this.releaseRuntimeData();
            throw error;
        }
    }

    async stop() {
        const server = this.server;
        if (!server) {
            this.releaseRuntimeData();
            return;
        }

        this.server = null;
        this.sessions.forEach(session => {
            session.writeLine('');
            session.writeLine('CLI session closed.');
            session.socket.destroy();
        });
        this.sessions.clear();

        await new Promise(resolve => {
            server.close(error => {
                if (error) {
                    logger.error(`Telnet CLI server close error: ${error.message}`);
                } else {
                    logger.info('Telnet CLI server stopped');
                }
                resolve();
            });
        });
        this.releaseRuntimeData();
    }

    handleConnection(socket) {
        if (!this.tree || !this.handlers) {
            socket.write('Telnet CLI is not ready.\r\n');
            socket.end();
            return;
        }
        if (this.sessions.size >= this.settings.maxSessions) {
            socket.write('Line pool is full.\r\n');
            socket.end();
            return;
        }

        socket.setNoDelay(true);
        const lineId = this.nextLineId;
        this.nextLineId += 1;

        const session = new CliSession(this, socket, lineId);
        this.sessions.set(lineId, session);

        socket.write(negotiationBuffer());
        session.writeLine('');
        session.writeLine('Welcome to NetNexus CLI');
        session.writeLine("Type '?' for available commands");
        session.writeLine('');
        session.sendPrompt();

        socket.on('data', chunk => this.handleData(session, chunk));
        socket.on('close', () => this.removeSession(session));
        socket.on('error', error => {
            logger.error(`Telnet CLI socket error from ${session.peer}: ${error.message}`);
            this.removeSession(session);
        });

        logger.info(`Telnet CLI client connected: line=${lineId} peer=${session.peer}`);
    }

    removeSession(session) {
        if (!session || !this.sessions.has(session.lineId)) {
            return;
        }
        session.closed = true;
        this.sessions.delete(session.lineId);
        logger.info(`Telnet CLI client disconnected: line=${session.lineId} peer=${session.peer}`);
    }

    handleData(session, chunk) {
        for (const byte of chunk) {
            this.handleByte(session, byte);
        }
    }

    handleByte(session, byte) {
        if (this.handleTelnetByte(session, byte)) {
            return;
        }

        if (byte === TELNET.IAC) {
            session.telnetState = 'iac';
            return;
        }
        if (session.pager && this.handlePagerByte(session, byte)) {
            return;
        }
        if (byte !== 9) {
            this.resetTabCycle(session);
        }
        if (this.handleAnsiByte(session, byte)) {
            return;
        }
        if (byte === 0 && session.ignoreNextLineFeed) {
            session.ignoreNextLineFeed = false;
            return;
        }
        if (byte === 10 && session.ignoreNextLineFeed) {
            session.ignoreNextLineFeed = false;
            return;
        }
        if (byte === 13) {
            session.ignoreNextLineFeed = true;
            this.submitLine(session);
            return;
        }
        if (byte === 10) {
            this.submitLine(session);
            return;
        }
        if (byte === 3) {
            session.line = '';
            session.cursor = 0;
            session.write('^C\r\n');
            session.sendPrompt();
            return;
        }
        if (byte === 4 && session.line.length === 0) {
            session.close();
            return;
        }
        if (byte === 8 || byte === 127) {
            this.backspace(session);
            return;
        }
        if (byte === 9) {
            this.completeLine(session);
            return;
        }
        if (byte === 27) {
            session.inputState = 'esc';
            return;
        }
        if (byte === 63) {
            this.showInlineHelp(session);
            return;
        }
        if (byte >= 32 && byte <= 126) {
            this.insertChar(session, String.fromCharCode(byte));
        }
    }

    handlePagerByte(session, byte) {
        if (byte === 0 && session.ignoreNextLineFeed) {
            session.ignoreNextLineFeed = false;
            return true;
        }
        if (byte === 10 && session.ignoreNextLineFeed) {
            session.ignoreNextLineFeed = false;
            return true;
        }
        if (byte === 13) {
            session.ignoreNextLineFeed = true;
            this.continuePager(session);
            return true;
        }
        if (byte === 10 || byte === 32) {
            this.continuePager(session);
            return true;
        }
        if (byte === 3 || byte === 113 || byte === 81) {
            this.cancelPager(session, byte === 3);
            return true;
        }
        return true;
    }

    continuePager(session) {
        const pager = session.pager;
        if (!pager || pager.busy || session.busy) {
            return;
        }

        pager.busy = true;
        session.busy = true;
        session.write('\r\x1b[2K');
        Promise.resolve(pager.continue())
            .catch(error => {
                logger.error(`Telnet CLI pager failed: ${error.message}`);
                session.pager = null;
                session.writeLine(`Error: ${error.message}`);
            })
            .finally(() => {
                pager.busy = false;
                session.busy = false;
                if (!session.closed && !session.pager) {
                    session.sendPrompt();
                }
            });
    }

    cancelPager(session, interrupted = false) {
        session.pager = null;
        session.write('\r\x1b[2K');
        session.writeLine(interrupted ? '^C' : '');
        if (!session.closed) {
            session.sendPrompt();
        }
    }

    handleTelnetByte(session, byte) {
        if (session.telnetState === 'data') {
            return false;
        }
        if (session.telnetState === 'iac') {
            if ([TELNET.DO, TELNET.DONT, TELNET.WILL, TELNET.WONT].includes(byte)) {
                session.telnetState = 'iac-option';
            } else if (byte === TELNET.SB) {
                session.telnetState = 'subneg';
            } else {
                session.telnetState = 'data';
            }
            return true;
        }
        if (session.telnetState === 'iac-option') {
            session.telnetState = 'data';
            return true;
        }
        if (session.telnetState === 'subneg') {
            session.telnetState = byte === TELNET.IAC ? 'subneg-iac' : 'subneg';
            return true;
        }
        if (session.telnetState === 'subneg-iac') {
            session.telnetState = byte === TELNET.SE ? 'data' : 'subneg';
            return true;
        }
        session.telnetState = 'data';
        return true;
    }

    handleAnsiByte(session, byte) {
        if (session.inputState === 'normal') {
            return false;
        }
        if (session.inputState === 'esc') {
            session.inputState = byte === 91 ? 'csi' : 'normal';
            return true;
        }
        if (session.inputState === 'csi') {
            session.inputState = 'normal';
            if (byte === 65) this.historyPrevious(session);
            if (byte === 66) this.historyNext(session);
            if (byte === 67) this.moveCursor(session, 1);
            if (byte === 68) this.moveCursor(session, -1);
            return true;
        }
        session.inputState = 'normal';
        return true;
    }

    insertChar(session, char) {
        session.historyIndex = null;
        if (session.cursor === session.line.length) {
            session.line += char;
            session.cursor += 1;
            session.write(char);
            return;
        }
        session.line = `${session.line.slice(0, session.cursor)}${char}${session.line.slice(session.cursor)}`;
        session.cursor += 1;
        session.redrawLine();
    }

    backspace(session) {
        if (session.cursor === 0) {
            return;
        }
        session.line = `${session.line.slice(0, session.cursor - 1)}${session.line.slice(session.cursor)}`;
        session.cursor -= 1;
        session.redrawLine();
    }

    moveCursor(session, offset) {
        const next = Math.max(0, Math.min(session.line.length, session.cursor + offset));
        if (next === session.cursor) {
            return;
        }
        session.write(next > session.cursor ? '\x1b[C' : '\x1b[D');
        session.cursor = next;
    }

    historyPrevious(session) {
        if (session.history.length === 0) {
            return;
        }
        session.historyIndex =
            session.historyIndex === null ? session.history.length - 1 : Math.max(0, session.historyIndex - 1);
        session.line = session.history[session.historyIndex];
        session.cursor = session.line.length;
        session.redrawLine();
    }

    historyNext(session) {
        if (session.historyIndex === null) {
            return;
        }
        session.historyIndex += 1;
        if (session.historyIndex >= session.history.length) {
            session.historyIndex = null;
            session.line = '';
        } else {
            session.line = session.history[session.historyIndex];
        }
        session.cursor = session.line.length;
        session.redrawLine();
    }

    completeLine(session) {
        const sourceLine = session.tabCycle ? session.tabCycle.originalLine : session.line;
        const sourceCursor = session.tabCycle ? session.tabCycle.originalCursor : session.cursor;
        const completion = this.getCompletion(session, sourceLine.slice(0, sourceCursor));

        if (completion.candidates.length === 0) {
            this.resetTabCycle(session);
            this.redrawLineOnNewPrompt(session);
            return;
        }
        if (completion.candidates.length === 1) {
            if (session.tabCycle) {
                session.line = session.tabCycle.originalLine.slice(0, session.tabCycle.originalCursor);
                session.cursor = session.line.length;
            }
            this.resetTabCycle(session);
            this.applyTabCandidate(session, completion.candidates[0], true);
            this.redrawLineOnNewPrompt(session);
            return;
        }

        if (!session.tabCycle) {
            session.tabCycle = {
                originalLine: session.line,
                originalCursor: session.cursor,
                matchIndex: 0
            };
        } else {
            session.tabCycle.matchIndex = (session.tabCycle.matchIndex + 1) % completion.candidates.length;
        }

        session.line = session.tabCycle.originalLine.slice(0, session.tabCycle.originalCursor);
        session.cursor = session.line.length;
        this.applyTabCandidate(session, completion.candidates[session.tabCycle.matchIndex], false);
        this.redrawLineOnNewPrompt(session);
    }

    resetTabCycle(session) {
        session.tabCycle = null;
    }

    redrawLineOnNewPrompt(session) {
        session.writeLine('');
        session.sendPrompt();
        session.write(session.line);
    }

    applyTabCandidate(session, candidate, appendSpace) {
        let start = session.cursor;
        while (start > 0 && !/\s/u.test(session.line[start - 1])) {
            start -= 1;
        }

        session.line = `${session.line.slice(0, start)}${candidate}${appendSpace ? ' ' : ''}`;
        session.cursor = session.line.length;
        session.historyIndex = null;
    }

    showInlineHelp(session) {
        session.writeLine('');
        session.write(this.getHelpText(session, session.line.slice(0, session.cursor)));
        session.redrawLine();
    }

    submitLine(session) {
        if (session.busy) {
            session.writeLine('');
            session.writeLine('Command is still running.');
            session.sendPrompt();
            return;
        }

        const rawLine = session.line;
        session.line = '';
        session.cursor = 0;
        session.historyIndex = null;
        session.writeLine('');

        const trimmed = rawLine.trim();
        if (trimmed) {
            session.history.push(trimmed);
            if (session.history.length > 100) {
                session.history.shift();
            }
            this.globalHistory.push({
                lineId: session.lineId,
                peer: session.peer,
                command: trimmed,
                time: new Date()
            });
            if (this.globalHistory.length > 200) {
                this.globalHistory.shift();
            }
        }

        session.busy = true;
        this.executeLine(session, trimmed)
            .catch(error => {
                logger.error(`Telnet CLI command failed: ${error.message}`);
                session.writeLine(`Error: ${error.message}`);
            })
            .finally(() => {
                session.busy = false;
                if (!session.closed && !session.pager) {
                    session.sendPrompt();
                }
            });
    }

    async executeLine(session, line) {
        if (!line || line[0] === '!') {
            return;
        }
        if (line === '?' || line.toLowerCase() === 'help') {
            session.write(this.getHelpText(session, ''));
            return;
        }

        const parsed = tokenizeCommand(line);
        if (!parsed.ok) {
            session.writeLine(parsed.error);
            return;
        }

        const match = this.tree.match(session.view, parsed.tokens);
        if (!match) {
            session.writeLine('Error: Invalid command.');
            return;
        }
        if (!match.command) {
            session.writeLine('Error: Incomplete command.');
            return;
        }

        try {
            await this.handlers.dispatch(session, match);
            this.applyViewSwitch(session, match);
        } catch (error) {
            if (error instanceof CliCommandError) {
                session.writeLine(`Error: ${error.message}`);
                return;
            }
            throw error;
        }
    }

    applyViewSwitch(session, match) {
        const { command, args } = match;
        if (!command.toView) {
            return;
        }
        session.view = command.toView;
        if (command.clearContext) {
            session.context.clear();
        }
        command.context.forEach(entry => {
            const value = entry.fromArg ? args[entry.fromArg] : entry.value;
            if (value !== undefined && value !== null) {
                session.context.set(entry.name, value);
            }
        });
    }

    getCompletion(session, line) {
        if (!line.trim() || /\s$/u.test(line)) {
            return { candidates: [] };
        }
        const parsed = tokenizeCommand(line);
        if (!parsed.ok) {
            return { candidates: [] };
        }
        const tokens = parsed.tokens;
        const prefix = tokens.pop() || '';
        const contexts = this.tree.getContexts(session.view, tokens);
        const candidates = new Set();

        contexts.forEach(node => {
            node.children.forEach(child => {
                if (child.type === 'command' && child.name.toLowerCase().startsWith(prefix.toLowerCase())) {
                    candidates.add(child.name);
                } else if (child.type === 'argument' && child.paramType) {
                    child.paramType.completionCandidates(prefix).forEach(candidate => candidates.add(candidate));
                }
            });
        });

        return { candidates: Array.from(candidates) };
    }

    getHelpText(session, line) {
        const hasTrailingSpace = /\s$/u.test(line);
        const parsed = tokenizeCommand(line.trimEnd());
        if (!parsed.ok) {
            return `${parsed.error}\r\n`;
        }

        const tokens = parsed.tokens;
        const prefix = hasTrailingSpace ? '' : tokens.pop() || '';
        const contexts = this.tree.getContexts(session.view, tokens);
        const rows = [];

        contexts.forEach(node => {
            node.children.forEach(child => {
                if (child.type === 'argument' && child.paramType) {
                    const candidates = child.paramType.completionCandidates(prefix);
                    if (candidates.length > 0) {
                        candidates.forEach(candidate => {
                            rows.push({
                                token: candidate,
                                description: getEnumCandidateDescription(child)
                            });
                        });
                        return;
                    }
                }

                if (nodeMatchesPrefix(child, prefix)) {
                    rows.push({
                        token: displayNode(child),
                        description: child.description || ''
                    });
                }
            });
            if (node.command && prefix === '') {
                rows.unshift({ token: '<cr>', description: 'Execute command' });
            }
        });

        if (rows.length === 0) {
            return 'Error: Invalid command.\r\n';
        }
        return formatTable(rows, [
            { key: 'token', title: 'Token' },
            { key: 'description', title: 'Description' }
        ]);
    }

    formatSessions() {
        const rows = Array.from(this.sessions.values()).map(session => ({
            line: session.lineId,
            peer: session.peer,
            view: session.view,
            connected: formatDate(session.connectTime),
            busy: session.busy
        }));
        return formatTable(rows, [
            { key: 'line', title: 'Line' },
            { key: 'peer', title: 'Peer' },
            { key: 'view', title: 'View' },
            { key: 'connected', title: 'Connected' },
            { key: 'busy', title: 'Busy' }
        ]);
    }

}

function nodeMatchesPrefix(node, prefix) {
    if (!prefix) {
        return true;
    }
    if (node.type === 'command') {
        return node.name.toLowerCase().startsWith(prefix.toLowerCase());
    }
    return !node.paramType || node.paramType.matchesPrefix(prefix);
}

function getEnumCandidateDescription(node) {
    if (node.description) {
        return node.description;
    }
    const descriptions = {
        af: 'Address family',
        ribType: 'RIB type',
        routeState: 'Route state'
    };
    return descriptions[node.argName] || humanizeArgName(node.argName);
}

function humanizeArgName(value) {
    return String(value || '')
        .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
        .replace(/[-_]+/gu, ' ')
        .trim()
        .toLowerCase();
}

function tokenizeCommand(line) {
    const tokens = [];
    let current = '';
    let quote = null;

    for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/u.test(char)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }

    if (quote) {
        return { ok: false, error: 'Error: Unclosed quote.' };
    }
    if (current) {
        tokens.push(current);
    }
    return { ok: true, tokens };
}

module.exports = CliAccessServer;
