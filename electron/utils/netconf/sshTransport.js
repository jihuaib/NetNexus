'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

class NetconfSshError extends Error {
    constructor(message, code = 'NETCONF_SSH_ERROR', cause = null) {
        super(message);
        this.name = 'NetconfSshError';
        this.code = code;
        if (cause) {
            this.cause = cause;
        }
    }
}

function normalizeFingerprint(value) {
    return String(value || '').trim();
}

function calculateFingerprints(key) {
    const keyBuffer = Buffer.isBuffer(key) ? key : Buffer.from(key);
    const sha256 = crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
    const md5Hex = crypto.createHash('md5').update(keyBuffer).digest('hex');
    return {
        sha256: `SHA256:${sha256}`,
        md5: `MD5:${md5Hex.match(/.{2}/g).join(':')}`,
        hex: keyBuffer.toString('hex')
    };
}

function timingSafeStringEqual(left, right) {
    const leftBuffer = Buffer.from(String(left).toLowerCase());
    const rightBuffer = Buffer.from(String(right).toLowerCase());
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createHostVerifier(expectedFingerprint) {
    const expected = normalizeFingerprint(expectedFingerprint);
    if (!expected) {
        throw new TypeError('expectedFingerprint must be a non-empty string');
    }
    return key => {
        const fingerprints = calculateFingerprints(key);
        if (/^sha256:/i.test(expected)) {
            return timingSafeStringEqual(expected.replace(/=+$/, ''), fingerprints.sha256);
        }
        if (/^md5:/i.test(expected)) {
            return timingSafeStringEqual(expected, fingerprints.md5);
        }
        const normalizedExpected = expected.replace(/:/g, '');
        return timingSafeStringEqual(normalizedExpected, fingerprints.hex);
    };
}

class SshNetconfTransport extends EventEmitter {
    constructor(stream, sshClient) {
        super();
        this.stream = stream;
        this.sshClient = sshClient;
        this.closed = false;
        this._lastError = null;

        // Keep transport errors observable without EventEmitter turning a race into an uncaught exception.
        this.on('error', () => {});

        stream.on('data', data => this.emit('data', data));
        stream.on('drain', () => this.emit('drain'));
        stream.on('end', () => this.emit('end'));
        stream.on('error', error => this._handleError(error));
        stream.on('close', () => this._handleClose());
        sshClient.on('error', error => this._handleError(error));
        sshClient.on('close', () => this._handleClose());
    }

    _handleError(error) {
        this._lastError = error;
        this.emit('error', error);
    }

    _handleClose() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.emit('close', this._lastError);
    }

    write(data, callback) {
        if (this.closed) {
            const error = new NetconfSshError(
                'Cannot write to a closed NETCONF SSH transport',
                'NETCONF_TRANSPORT_CLOSED'
            );
            if (typeof callback === 'function') {
                process.nextTick(callback, error);
                return false;
            }
            throw error;
        }
        return this.stream.write(data, callback);
    }

    end() {
        if (this.closed) {
            return;
        }
        if (this.stream && typeof this.stream.end === 'function') {
            this.stream.end();
        }
        if (this.sshClient && typeof this.sshClient.end === 'function') {
            this.sshClient.end();
        }
    }

    destroy(error) {
        if (this.stream && typeof this.stream.destroy === 'function') {
            this.stream.destroy(error);
        }
        if (this.sshClient && typeof this.sshClient.end === 'function') {
            this.sshClient.end();
        }
    }
}

function resolveClientConstructor(dependencies = {}) {
    if (dependencies.Client) {
        return dependencies.Client;
    }
    if (dependencies.ssh2 && dependencies.ssh2.Client) {
        return dependencies.ssh2.Client;
    }
    return require('ssh2').Client;
}

function buildSshConfig(profile) {
    if (!profile || typeof profile !== 'object') {
        throw new TypeError('NETCONF SSH profile is required');
    }
    if (typeof profile.host !== 'string' || profile.host.trim() === '') {
        throw new TypeError('NETCONF SSH profile.host is required');
    }
    if (typeof profile.username !== 'string' || profile.username.trim() === '') {
        throw new TypeError('NETCONF SSH profile.username is required');
    }

    const port = profile.port === undefined || profile.port === null ? 830 : Number(profile.port);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
        throw new TypeError('NETCONF SSH profile.port must be between 1 and 65535');
    }

    const config = {
        host: profile.host.trim(),
        port,
        username: profile.username,
        readyTimeout: profile.readyTimeout === undefined ? 20000 : Number(profile.readyTimeout),
        keepaliveInterval: profile.keepaliveInterval === undefined ? 10000 : Number(profile.keepaliveInterval),
        keepaliveCountMax: profile.keepaliveCountMax === undefined ? 3 : Number(profile.keepaliveCountMax)
    };
    const forwardedKeys = [
        'password',
        'privateKey',
        'passphrase',
        'agent',
        'agentForward',
        'tryKeyboard',
        'localHostname',
        'localUsername',
        'algorithms',
        'sock'
    ];
    for (const key of forwardedKeys) {
        if (profile[key] !== undefined && profile[key] !== null) {
            config[key] = profile[key];
        }
    }

    if (!Number.isFinite(config.readyTimeout) || config.readyTimeout <= 0) {
        throw new TypeError('readyTimeout must be a positive number');
    }
    if (!Number.isFinite(config.keepaliveInterval) || config.keepaliveInterval < 0) {
        throw new TypeError('keepaliveInterval must be a non-negative number');
    }
    if (!Number.isSafeInteger(config.keepaliveCountMax) || config.keepaliveCountMax < 0) {
        throw new TypeError('keepaliveCountMax must be a non-negative integer');
    }

    const expectedFingerprint = profile.hostKeyFingerprint || profile.hostFingerprint;
    if (typeof profile.hostVerifier === 'function') {
        config.hostVerifier = profile.hostVerifier;
    } else if (expectedFingerprint) {
        config.hostVerifier = createHostVerifier(expectedFingerprint);
    } else if (profile.requireHostVerification) {
        throw new NetconfSshError(
            'Host verification is required but no hostVerifier or hostKeyFingerprint was provided',
            'NETCONF_HOST_VERIFICATION_REQUIRED'
        );
    }
    return config;
}

async function createSshTransport(profile, dependencies = {}) {
    const Client = resolveClientConstructor(dependencies);
    const config = buildSshConfig(profile);

    return new Promise((resolve, reject) => {
        const sshClient = new Client();
        let settled = false;

        const rejectOnce = error => {
            if (settled) {
                return;
            }
            settled = true;
            if (typeof sshClient.end === 'function') {
                sshClient.end();
            }
            reject(
                error instanceof NetconfSshError
                    ? error
                    : new NetconfSshError(
                          `NETCONF SSH connection failed: ${error.message}`,
                          'NETCONF_SSH_CONNECT_FAILED',
                          error
                      )
            );
        };

        sshClient.once('error', rejectOnce);
        sshClient.once('close', () => {
            rejectOnce(new NetconfSshError('NETCONF SSH connection closed before subsystem setup'));
        });
        if (config.tryKeyboard && profile.password) {
            sshClient.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
                finish(prompts.map(() => profile.password));
            });
        }

        sshClient.once('ready', () => {
            sshClient.subsys('netconf', (error, stream) => {
                if (error) {
                    rejectOnce(
                        new NetconfSshError(
                            `Unable to open SSH netconf subsystem: ${error.message}`,
                            'NETCONF_SUBSYSTEM_FAILED',
                            error
                        )
                    );
                    return;
                }
                if (settled) {
                    if (stream && typeof stream.end === 'function') {
                        stream.end();
                    }
                    return;
                }
                settled = true;
                sshClient.removeListener('error', rejectOnce);
                resolve(new SshNetconfTransport(stream, sshClient));
            });
        });

        try {
            sshClient.connect(config);
        } catch (error) {
            rejectOnce(error);
        }
    });
}

module.exports = {
    NetconfSshError,
    SshNetconfTransport,
    calculateFingerprints,
    createHostVerifier,
    buildSshConfig,
    createSshTransport,
    connectSsh: createSshTransport
};
