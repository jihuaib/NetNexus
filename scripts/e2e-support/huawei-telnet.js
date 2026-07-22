const net = require('net');

/* eslint-disable no-control-regex */

const TELNET = Object.freeze({
    IAC: 255,
    DONT: 254,
    DO: 253,
    WONT: 252,
    WILL: 251,
    SB: 250,
    SE: 240
});

const DEFAULT_TIMEOUT_MS = 15000;
const PROMPT_PATTERN = /(?:^|\r?\n)(?:<[^<>\r\n]+>|\[[^\]\r\n]+\])\s*$/u;
const MORE_PATTERN = /(?:----\s*More\s*----|--\s*More\s*--)/iu;

function stripTerminalControl(value) {
    return String(value || '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
        .replace(/[\u0000\u0007]/gu, '')
        .replace(/.{0,32}\bMore\b.{0,32}(?:\x08|\r)+/giu, '')
        .replace(/\x08/gu, '');
}

function decodeTelnetData(chunk) {
    const payload = [];
    const replies = [];

    for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index];
        if (byte !== TELNET.IAC) {
            payload.push(byte);
            continue;
        }

        if (index + 1 >= chunk.length) {
            break;
        }

        const command = chunk[++index];
        if (command === TELNET.IAC) {
            payload.push(TELNET.IAC);
            continue;
        }

        if (command === TELNET.WILL || command === TELNET.WONT || command === TELNET.DO || command === TELNET.DONT) {
            if (index + 1 >= chunk.length) {
                break;
            }
            const option = chunk[++index];
            if (command === TELNET.WILL) {
                replies.push(Buffer.from([TELNET.IAC, TELNET.DONT, option]));
            } else if (command === TELNET.DO) {
                replies.push(Buffer.from([TELNET.IAC, TELNET.WONT, option]));
            }
            continue;
        }

        if (command === TELNET.SB) {
            while (index + 1 < chunk.length) {
                index += 1;
                if (chunk[index] === TELNET.IAC && index + 1 < chunk.length && chunk[index + 1] === TELNET.SE) {
                    index += 1;
                    break;
                }
            }
        }
    }

    return { payload: Buffer.from(payload), replies };
}

class HuaweiTelnetClient {
    constructor({ host, port = 23, localAddress, username, password, timeoutMs = DEFAULT_TIMEOUT_MS }) {
        this.host = host;
        this.port = port;
        this.localAddress = localAddress;
        this.username = username;
        this.password = password;
        this.timeoutMs = timeoutMs;
        this.socket = null;
        this.transcript = '';
        this.waiters = new Set();
        this.pagerPending = false;
    }

    async connect() {
        if (!this.host || !this.username || !this.password) {
            throw new Error('Huawei Telnet host, username, and password are required');
        }

        this.socket = net.createConnection({ host: this.host, port: this.port, localAddress: this.localAddress });
        this.socket.setNoDelay(true);
        this.socket.on('data', chunk => this.handleData(chunk));
        this.socket.on('error', error => this.rejectWaiters(error));
        this.socket.on('close', () => this.rejectWaiters(new Error(`Telnet connection to ${this.host} closed`)));

        await this.waitFor(/(?:Username|Login):\s*$/iu);
        this.writeLine(this.username);
        await this.waitFor(/Password:\s*$/iu);
        this.writeLine(this.password);
        await this.waitForPrompt();

        await this.command('screen-length 0 temporary');
        return this;
    }

    handleData(chunk) {
        const decoded = decodeTelnetData(chunk);
        decoded.replies.forEach(reply => this.socket?.write(reply));
        if (decoded.payload.length === 0) {
            return;
        }

        this.transcript += decoded.payload.toString('utf8');
        if (MORE_PATTERN.test(this.transcript) && !this.pagerPending) {
            this.pagerPending = true;
            this.socket?.write(' ');
            this.transcript = this.transcript.replace(MORE_PATTERN, '');
            setImmediate(() => {
                this.pagerPending = false;
            });
        }
        this.resolveWaiters();
    }

    writeLine(value) {
        if (!this.socket || this.socket.destroyed) {
            throw new Error(`Telnet connection to ${this.host} is not open`);
        }
        this.socket.write(`${value}\r\n`);
    }

    write(value) {
        if (!this.socket || this.socket.destroyed) {
            throw new Error(`Telnet connection to ${this.host} is not open`);
        }
        this.socket.write(value);
    }

    waitFor(pattern, timeoutMs = this.timeoutMs) {
        return new Promise((resolve, reject) => {
            const waiter = { pattern, resolve, reject, timeout: null };
            waiter.timeout = setTimeout(() => {
                this.waiters.delete(waiter);
                reject(new Error(`Timed out waiting for ${pattern} from ${this.host}`));
            }, timeoutMs);
            this.waiters.add(waiter);
            this.resolveWaiters();
        });
    }

    waitForPrompt(timeoutMs = this.timeoutMs) {
        return this.waitFor(PROMPT_PATTERN, timeoutMs);
    }

    async waitForIdle({ idleMs = 250, timeoutMs = this.timeoutMs } = {}) {
        const startedAt = Date.now();
        let previousLength = -1;
        while (Date.now() - startedAt < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, idleMs));
            if (this.transcript.length === previousLength) {
                return stripTerminalControl(this.transcript);
            }
            previousLength = this.transcript.length;
        }
        throw new Error(`Timed out waiting for idle Telnet output from ${this.host}`);
    }

    resolveWaiters() {
        const text = stripTerminalControl(this.transcript);
        for (const waiter of [...this.waiters]) {
            waiter.pattern.lastIndex = 0;
            if (!waiter.pattern.test(text)) {
                continue;
            }
            clearTimeout(waiter.timeout);
            this.waiters.delete(waiter);
            waiter.resolve(text);
        }
    }

    rejectWaiters(error) {
        for (const waiter of this.waiters) {
            clearTimeout(waiter.timeout);
            waiter.reject(error);
        }
        this.waiters.clear();
    }

    async command(command, { timeoutMs = this.timeoutMs } = {}) {
        this.transcript = '';
        this.writeLine(command);
        const output = await this.waitForPrompt(timeoutMs);
        return stripTerminalControl(output)
            .replace(new RegExp(`^\\s*${command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*\\r?\\n`, 'u'), '')
            .replace(PROMPT_PATTERN, '')
            .trim();
    }

    async interactiveCommand(command, { confirmations = [], timeoutMs = this.timeoutMs } = {}) {
        this.transcript = '';
        this.writeLine(command);
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            const remaining = timeoutMs - (Date.now() - startedAt);
            const patterns = [PROMPT_PATTERN, ...confirmations.map(item => item.pattern)];
            const combined = new RegExp(patterns.map(pattern => `(?:${pattern.source})`).join('|'), 'imu');
            await this.waitFor(combined, remaining);
            const output = stripTerminalControl(this.transcript);
            if (PROMPT_PATTERN.test(output)) {
                return output.replace(PROMPT_PATTERN, '').trim();
            }
            const confirmation = confirmations.find(item => {
                item.pattern.lastIndex = 0;
                return item.pattern.test(output);
            });
            if (!confirmation) {
                continue;
            }
            this.transcript = '';
            this.writeLine(confirmation.response);
        }

        throw new Error(`Timed out running interactive command on ${this.host}: ${command}`);
    }

    async help(prefix, { timeoutMs = this.timeoutMs } = {}) {
        this.transcript = '';
        this.write(`${prefix}?`);
        const output = await this.waitForIdle({ timeoutMs });
        this.write(Buffer.from([0x15]));
        await this.waitForIdle({ timeoutMs });
        return output.trim();
    }

    async close() {
        if (!this.socket || this.socket.destroyed) {
            return;
        }
        this.socket.end('quit\r\n');
        await new Promise(resolve => {
            const timeout = setTimeout(resolve, 500);
            this.socket.once('close', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
        this.socket.destroy();
    }
}

module.exports = {
    HuaweiTelnetClient,
    decodeTelnetData,
    stripTerminalControl
};
