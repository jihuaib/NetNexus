#!/usr/bin/env node

const net = require('net');

const DEFAULT_OPTIONS = {
    host: '127.0.0.1',
    port: 21,
    username: 'netnexus',
    password: 'netnexus',
    timeout: 10000
};

function getArgValue(name, defaultValue) {
    const prefix = `--${name}`;
    const index = process.argv.indexOf(prefix);
    if (index >= 0 && process.argv[index + 1]) {
        return process.argv[index + 1];
    }
    const inlineArg = process.argv.find(item => item.startsWith(`${prefix}=`));
    if (inlineArg) {
        return inlineArg.slice(prefix.length + 1);
    }
    return defaultValue;
}

function parseOptions() {
    return {
        host: getArgValue('host', DEFAULT_OPTIONS.host),
        port: Number(getArgValue('port', DEFAULT_OPTIONS.port)),
        username: getArgValue('username', DEFAULT_OPTIONS.username),
        password: getArgValue('password', DEFAULT_OPTIONS.password),
        timeout: Number(getArgValue('timeout', DEFAULT_OPTIONS.timeout))
    };
}

function emit(event, data = {}) {
    process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
}

function sendCommand(socket, command) {
    emit('sent-command', { command });
    socket.write(`${command}\r\n`);
}

async function main() {
    const options = parseOptions();
    const socket = net.createConnection({ host: options.host, port: options.port });
    let buffer = '';
    let step = 'greeting';
    let completed = false;

    const timeout = setTimeout(() => {
        emit('error', { message: 'FTP client timed out', step });
        socket.destroy();
        process.exitCode = 1;
    }, options.timeout);

    socket.on('connect', () => {
        emit('connected', { host: options.host, port: options.port });
    });

    socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) {
                continue;
            }
            const code = Number(line.slice(0, 3));
            emit('received-reply', { code, line });

            if (step === 'greeting' && code === 220) {
                step = 'user';
                sendCommand(socket, `USER ${options.username}`);
            } else if (step === 'user' && code === 331) {
                step = 'pass';
                sendCommand(socket, `PASS ${options.password}`);
            } else if (step === 'pass' && code === 230) {
                step = 'pwd';
                emit('authenticated', { username: options.username });
                sendCommand(socket, 'PWD');
            } else if (step === 'pwd' && code === 257) {
                step = 'noop';
                sendCommand(socket, 'NOOP');
            } else if (step === 'noop' && code === 200) {
                step = 'quit';
                sendCommand(socket, 'QUIT');
            } else if (step === 'quit' && code === 221) {
                completed = true;
                emit('completed');
                socket.end();
            } else if (code >= 400) {
                emit('error', { message: line, step });
                process.exitCode = 1;
                socket.end();
            }
        }
    });

    socket.on('error', error => {
        emit('error', { message: error.message, step });
        process.exitCode = 1;
    });

    socket.on('close', () => {
        clearTimeout(timeout);
        emit('closed', { completed });
        if (!completed) {
            process.exitCode = 1;
        }
    });
}

main().catch(error => {
    emit('error', { message: error.message });
    process.exit(1);
});
