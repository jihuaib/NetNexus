const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const logger = require('../../log/logger');
const { writeProtocolOutput } = require('../../log/protocolOutputLogger');
const {
    PROTOCOL_PROCESS_IPC_CODEC,
    PROTOCOL_PROCESS_IPC_CODEC_ENV,
    encodeProtocolProcessMessage,
    decodeProtocolProcessMessage
} = require('./protocolProcessSerialization');

const DEFAULT_FORCE_KILL_TIMEOUT_MS = 3000;
const TERMINATION_TIMEOUT_MULTIPLIER = 2;
const MAX_OUTPUT_LINE_LENGTH = 64 * 1024;

function resolveUtilityProcess(explicitUtilityProcess) {
    if (explicitUtilityProcess !== undefined) {
        return explicitUtilityProcess;
    }

    try {
        const electron = require('electron');
        return electron && typeof electron === 'object' ? electron.utilityProcess : null;
    } catch (_error) {
        return null;
    }
}

class ProtocolProcessHost extends EventEmitter {
    constructor(modulePath, options = {}) {
        super();
        this.modulePath = modulePath;
        this.serviceName = String(options.serviceName || 'netnexus.protocol.unknown');
        this.forceKillTimeoutMs = Math.max(250, Number(options.forceKillTimeoutMs) || DEFAULT_FORCE_KILL_TIMEOUT_MS);
        this.runtime = null;
        this.runtimeKind = '';
        this.jsonIpc = false;
        this.lastPid = null;
        this.exitCode = null;
        this.exitSignal = null;
        this.terminating = false;
        this.terminationPromise = null;
        this.forceKillTimer = null;
        this.terminationTimeoutTimer = null;
        this.exitPromise = new Promise(resolve => {
            this.resolveExit = resolve;
        });

        // Avoid EventEmitter's special unhandled-error behavior before the owner has
        // attached its listener. Owners still receive the same error event.
        this.on('error', () => {});
        this.start(options);
    }

    start(options) {
        const utilityProcess = resolveUtilityProcess(options.utilityProcess);
        const environment = {
            ...process.env,
            NETNEXUS_PROTOCOL_SERVICE: this.serviceName
        };
        // A nested host chooses its own transport rather than inheriting the
        // outer fork's codec into a utility process or a plain Node fork.
        delete environment[PROTOCOL_PROCESS_IPC_CODEC_ENV];

        if (utilityProcess && typeof utilityProcess.fork === 'function') {
            this.runtimeKind = 'utility-process';
            this.runtime = utilityProcess.fork(this.modulePath, [], {
                cwd: options.cwd || process.cwd(),
                env: environment,
                serviceName: this.serviceName,
                stdio: 'pipe'
            });
        } else {
            this.runtimeKind = 'child-process';
            if (process.versions.electron) {
                environment.ELECTRON_RUN_AS_NODE = '1';
                environment[PROTOCOL_PROCESS_IPC_CODEC_ENV] = PROTOCOL_PROCESS_IPC_CODEC;
                this.jsonIpc = true;
            }
            this.runtime = fork(this.modulePath, [], {
                cwd: options.cwd || process.cwd(),
                env: environment,
                execArgv: Array.isArray(options.execArgv) ? options.execArgv : undefined,
                serialization: this.jsonIpc ? 'json' : 'advanced',
                stdio: ['ignore', 'pipe', 'pipe', 'ipc']
            });
        }

        this.lastPid = this.runtime.pid || null;
        this.forwardRuntimeEvents(this.runtime);
        this.drainRuntimeOutput(this.runtime);
    }

    clearTerminationTimers() {
        if (this.forceKillTimer) {
            clearTimeout(this.forceKillTimer);
            this.forceKillTimer = null;
        }
        if (this.terminationTimeoutTimer) {
            clearTimeout(this.terminationTimeoutTimer);
            this.terminationTimeoutTimer = null;
        }
    }

    finalizeExit(runtime, code, signal) {
        if (this.runtime !== runtime) return;

        this.exitSignal = signal || null;
        this.exitCode = Number.isInteger(code) ? code : this.exitSignal ? 1 : 0;
        this.lastPid = runtime?.pid || this.lastPid;
        this.runtime = null;
        this.clearTerminationTimers();
        this.resolveExit(this.exitCode);
        this.emit('exit', this.exitCode, this.exitSignal);
    }

    forwardRuntimeEvents(runtime) {
        runtime.on('message', message => {
            if (!this.jsonIpc) {
                this.emit('message', message);
                return;
            }
            let decoded;
            try {
                decoded = decodeProtocolProcessMessage(message);
            } catch (error) {
                this.emit('error', error);
                return;
            }
            this.emit('message', decoded);
        });
        runtime.on('spawn', () => {
            this.lastPid = runtime.pid || this.lastPid;
            this.emit('spawn');
        });
        runtime.on('error', error => {
            this.emit('error', error);
            // child_process does not emit `exit` when spawning itself fails.
            if (!runtime.pid) this.finalizeExit(runtime, 1, null);
        });
        runtime.on('exit', (code, signal) => this.finalizeExit(runtime, code, signal));
        runtime.on('close', (code, signal) => this.finalizeExit(runtime, code, signal));
    }

    drainRuntimeOutput(runtime) {
        const drain = (stream, level) => {
            if (!stream) return;

            const decoder = new StringDecoder('utf8');
            let pending = '';
            let ended = false;
            const emit = line => {
                const output = line.replace(/\r$/, '');
                if (output.trim()) writeProtocolOutput(this.serviceName, level, output);
            };
            const append = text => {
                pending += text;
                while (pending.length > 0) {
                    const newline = pending.indexOf('\n');
                    if (newline >= 0 && newline <= MAX_OUTPUT_LINE_LENGTH) {
                        emit(pending.slice(0, newline));
                        pending = pending.slice(newline + 1);
                    } else if (pending.length >= MAX_OUTPUT_LINE_LENGTH) {
                        // Bound buffering even if native output never ends its line.
                        let length = MAX_OUTPUT_LINE_LENGTH;
                        const lastCode = pending.charCodeAt(length - 1);
                        // Keep UTF-16 surrogate pairs together when writing fragments.
                        if (lastCode >= 0xd800 && lastCode <= 0xdbff) length -= 1;
                        emit(pending.slice(0, length));
                        pending = pending.slice(length);
                    } else {
                        break;
                    }
                }
            };
            const finish = () => {
                if (ended) return;
                ended = true;
                append(decoder.end());
                emit(pending);
                pending = '';
            };

            stream.on('data', chunk => append(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
            stream.once('end', finish);
            stream.once('close', finish);
        };
        drain(runtime.stdout, 'info');
        drain(runtime.stderr, 'error');
    }

    get pid() {
        return this.runtime?.pid || this.lastPid || undefined;
    }

    postMessage(message) {
        if (!this.runtime) {
            throw new Error(`${this.serviceName} process is not running`);
        }

        if (this.runtimeKind === 'utility-process') {
            this.runtime.postMessage(message);
            return;
        }

        this.runtime.send(this.jsonIpc ? encodeProtocolProcessMessage(message) : message, error => {
            if (error && !this.terminating) {
                this.emit('error', error);
            }
        });
    }

    async terminate() {
        if (!this.runtime) {
            return this.exitCode;
        }
        if (this.terminationPromise) return this.terminationPromise;

        this.terminating = true;
        const runtime = this.runtime;
        if (this.runtimeKind === 'child-process') {
            if (runtime.connected) {
                try {
                    runtime.disconnect();
                } catch (error) {
                    logger.warn(`[${this.serviceName}] disconnect IPC failed before termination: ${error.message}`);
                }
            }
            this.forceKillTimer = setTimeout(() => {
                if (this.runtime === runtime) {
                    try {
                        runtime.kill('SIGKILL');
                    } catch (error) {
                        logger.error(`[${this.serviceName}] force kill failed: ${error.message}`);
                    }
                }
            }, this.forceKillTimeoutMs);
            this.forceKillTimer.unref?.();
        } else {
            let killAccepted = false;
            try {
                killAccepted = runtime.kill();
            } catch (error) {
                this.terminating = false;
                throw error;
            }
            if (killAccepted === false) {
                this.terminating = false;
                const error = new Error(`${this.serviceName} utility process rejected the terminate request`);
                error.code = 'PROCESS_TERMINATE_FAILED';
                throw error;
            }
        }

        const terminationTimeoutMs = this.forceKillTimeoutMs * TERMINATION_TIMEOUT_MULTIPLIER;
        const timeoutPromise = new Promise((_, reject) => {
            this.terminationTimeoutTimer = setTimeout(() => {
                const error = new Error(
                    `${this.serviceName} process did not exit within ${terminationTimeoutMs}ms after termination`
                );
                error.code = 'PROCESS_TERMINATE_TIMEOUT';
                reject(error);
            }, terminationTimeoutMs);
            this.terminationTimeoutTimer.unref?.();
        });
        this.terminationPromise = Promise.race([this.exitPromise, timeoutPromise]).catch(error => {
            this.clearTerminationTimers();
            this.terminationPromise = null;
            this.terminating = false;
            throw error;
        });
        return this.terminationPromise;
    }
}

module.exports = ProtocolProcessHost;
