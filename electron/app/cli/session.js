const { toTelnetNewlines } = require('./telnet');

function renderPrompt(template, context) {
    return String(template || '<NetNexus>').replace(/\{ctx:([^}]+)\}/gu, (_match, name) =>
        String(context.get(name) ?? 0)
    );
}

function normalizeRemoteAddress(address) {
    if (!address) {
        return 'unknown';
    }
    return address.startsWith('::ffff:') ? address.slice(7) : address;
}

class CliSession {
    constructor(server, socket, lineId) {
        this.server = server;
        this.socket = socket;
        this.lineId = lineId;
        this.view = 'user';
        this.context = new Map();
        this.line = '';
        this.cursor = 0;
        this.history = [];
        this.historyIndex = null;
        this.closed = false;
        this.busy = false;
        this.terminalLength = 24;
        this.telnetState = 'data';
        this.inputState = 'normal';
        this.ignoreNextLineFeed = false;
        this.connectTime = new Date();
        this.peer = `${normalizeRemoteAddress(socket.remoteAddress)}:${socket.remotePort || 0}`;
        this.pager = null;
        this.tabCycle = null;
        this.bmpIds = {
            client: createIdStore(),
            session: new Map(),
            instance: new Map(),
            sessionStatistics: new Map(),
            instanceStatistics: new Map()
        };
    }

    getPrompt() {
        return renderPrompt(this.server.tree.getPrompt(this.view), this.context);
    }

    write(text) {
        if (!this.closed) {
            this.socket.write(toTelnetNewlines(text));
        }
    }

    writeLine(text = '') {
        this.write(`${text}\r\n`);
    }

    sendPrompt() {
        this.write(`${this.getPrompt()} `);
    }

    redrawLine() {
        const prompt = `${this.getPrompt()} `;
        this.write(`\r\x1b[2K${prompt}${this.line}`);
        const moveLeft = this.line.length - this.cursor;
        if (moveLeft > 0) {
            this.write(`\x1b[${moveLeft}D`);
        }
    }

    close() {
        this.closed = true;
        this.socket.end();
    }
}

function createIdStore() {
    return {
        nextId: 1,
        keyToId: new Map(),
        idToValue: new Map()
    };
}

module.exports = CliSession;
