#!/usr/bin/env node

const dgram = require('dgram');

const OP = {
    RRQ: 1,
    WRQ: 2,
    DATA: 3,
    ACK: 4,
    ERROR: 5
};

const DEFAULT_OPTIONS = {
    host: '127.0.0.1',
    port: 69,
    mode: 'write',
    filename: 'netnexus-e2e.txt',
    content: 'NetNexus TFTP E2E payload\n',
    blockSize: 512,
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
        mode: getArgValue('mode', DEFAULT_OPTIONS.mode),
        filename: getArgValue('filename', DEFAULT_OPTIONS.filename),
        content: getArgValue('content', DEFAULT_OPTIONS.content),
        blockSize: Number(getArgValue('block-size', DEFAULT_OPTIONS.blockSize)),
        timeout: Number(getArgValue('timeout', DEFAULT_OPTIONS.timeout))
    };
}

function emit(event, data = {}) {
    process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
}

function zstr(value) {
    return Buffer.from(`${value}\0`, 'ascii');
}

function buildRequest(opcode, filename) {
    const header = Buffer.alloc(2);
    header.writeUInt16BE(opcode, 0);
    return Buffer.concat([header, zstr(filename), zstr('octet')]);
}

function buildData(block, data) {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(OP.DATA, 0);
    header.writeUInt16BE(block, 2);
    return Buffer.concat([header, data]);
}

function buildAck(block) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt16BE(OP.ACK, 0);
    buffer.writeUInt16BE(block, 2);
    return buffer;
}

async function main() {
    const options = parseOptions();
    const socket = dgram.createSocket('udp4');
    const payload = Buffer.from(options.content);
    let serverPort = options.port;
    let completed = false;

    const timeout = setTimeout(() => {
        emit('error', { message: 'TFTP client timed out' });
        socket.close();
        process.exitCode = 1;
    }, options.timeout);

    const send = buffer => {
        socket.send(buffer, serverPort, options.host);
    };

    socket.on('message', message => {
        const opcode = message.readUInt16BE(0);
        serverPort = serverPort || options.port;

        if (opcode === OP.ERROR) {
            const code = message.readUInt16BE(2);
            const text = message.subarray(4, -1).toString('utf8');
            emit('received-error', { code, text });
            process.exitCode = 1;
            socket.close();
            return;
        }

        if (options.mode === 'write') {
            if (opcode === OP.ACK) {
                const block = message.readUInt16BE(2);
                emit('received-ack', { block });
                if (block === 0) {
                    send(buildData(1, payload));
                    emit('sent-data', { block: 1, bytes: payload.length });
                } else if (block === 1) {
                    completed = true;
                    emit('completed', { mode: 'write', bytes: payload.length });
                    socket.close();
                }
            }
        } else if (options.mode === 'read' && opcode === OP.DATA) {
            const block = message.readUInt16BE(2);
            const data = message.subarray(4);
            emit('received-data', { block, bytes: data.length, content: data.toString('utf8') });
            send(buildAck(block));
            emit('sent-ack', { block });
            if (data.length < options.blockSize) {
                completed = true;
                emit('completed', { mode: 'read', bytes: data.length });
                socket.close();
            }
        }
    });

    socket.on('error', error => {
        emit('error', { message: error.message });
        process.exitCode = 1;
    });

    socket.on('close', () => {
        clearTimeout(timeout);
        emit('closed', { completed });
        if (!completed) {
            process.exitCode = 1;
        }
    });

    socket.bind(0, '127.0.0.1', () => {
        const opcode = options.mode === 'read' ? OP.RRQ : OP.WRQ;
        send(buildRequest(opcode, options.filename));
        emit('sent-request', {
            mode: options.mode,
            host: options.host,
            port: options.port,
            filename: options.filename
        });
    });
}

main().catch(error => {
    emit('error', { message: error.message });
    process.exit(1);
});
