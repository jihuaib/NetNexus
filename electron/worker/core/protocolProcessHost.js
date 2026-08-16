const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');
const logger = require('../../log/logger');

const DEFAULT_FORCE_KILL_TIMEOUT_MS = 3000;
const TERMINATION_TIMEOUT_MULTIPLIER = 2;

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

function normalizeOutput(chunk) {
    return String(chunk || '').trim();
}

class ProtocolProcessHost extends EventEmitter {
    constructor(modulePath, options = {}) {
        super();
        this.modulePath = modulePath;
        this.serviceName = String(options.serviceName || 'netnexus.protocol.unknown');
        this.forceKillTimeoutMs = Math.max(250, Number(options.forceKillTimeoutMs) || DEFAULT_FORCE_KILL_TIMEOUT_MS);
        this.runtime = null;
        this.runtimeKind = '';
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
            }
            this.runtime = fork(this.modulePath, [], {
                cwd: options.cwd || process.cwd(),
                env: environment,
                execArgv: Array.isArray(options.execArgv) ? options.execArgv : undefined,
                serialization: 'advanced',
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
        runtime.on('message', message => this.emit('message', message));
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
        runtime.stdout?.on('data', chunk => {
            const output = normalizeOutput(chunk);
            if (output) logger.info(`[${this.serviceName}] ${output}`);
        });
        runtime.stderr?.on('data', chunk => {
            const output = normalizeOutput(chunk);
            if (output) logger.error(`[${this.serviceName}] ${output}`);
        });
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

        this.runtime.send(message, error => {
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
