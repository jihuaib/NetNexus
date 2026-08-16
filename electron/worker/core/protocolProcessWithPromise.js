const ProtocolProcessHost = require('./protocolProcessHost');
const WorkerWithPromise = require('./workerWithPromise');
const logger = require('../../log/logger');

class ProtocolProcessWithPromise {
    constructor(processPath, options = {}) {
        this.processPath = processPath;
        this.options = options;
    }

    createLongRunningProcess() {
        const processHost = new ProtocolProcessHost(this.processPath, this.options);
        const callbacks = new Map();
        const eventListeners = new Map();
        const exitListeners = new Set();
        const defaultTimeoutMs = Math.max(0, Number(this.options.defaultTimeoutMs) || 0);
        const pendingDrainTimeoutMs = Math.max(250, Number(this.options.pendingDrainTimeoutMs) || 5000);
        let terminating = false;
        let terminationPromise = null;
        let client = null;

        const createUnavailableError = () => {
            const error = new Error(
                terminating ? 'Protocol process client is terminating' : 'Protocol process client has exited'
            );
            error.code = terminating ? 'WORKER_TERMINATED' : 'WORKER_EXIT';
            return error;
        };

        logger.info(
            `协议进程启动: ${this.options.serviceName || this.processPath}, PID=${processHost.pid || 'pending'}`
        );

        processHost.on('message', result => {
            if (result.eventName && eventListeners.has(result.eventName)) {
                const listeners = eventListeners.get(result.eventName);
                listeners.forEach(listener => {
                    try {
                        listener(result.data);
                    } catch (error) {
                        logger.error(`协议进程事件监听器执行失败 (${result.eventName}):`, error);
                    }
                });
                return;
            }

            if (result.messageId && callbacks.has(result.messageId)) {
                const { resolve, reject, cleanup } = callbacks.get(result.messageId);
                callbacks.delete(result.messageId);
                cleanup();

                if (result.status === 'success') {
                    resolve(result);
                } else {
                    const error = new Error(result.msg || 'Protocol process execution failed');
                    error.code = result.code || 'WORKER_REQUEST_FAILED';
                    error.data = result.data;
                    reject(error);
                }
            } else {
                logger.warn('收到协议进程的未跟踪消息:', result);
            }
        });

        processHost.on('error', error => {
            logger.error('协议进程发生错误:', error);
            for (const { reject, cleanup } of callbacks.values()) {
                cleanup();
                reject(error instanceof Error ? error : new Error(String(error)));
            }
            callbacks.clear();
        });

        processHost.on('exit', code => {
            if (!terminating) {
                logger.error(`协议进程异常退出，退出码: ${code}`);
            } else {
                logger.info(`协议进程已退出，退出码: ${code}`);
            }

            for (const { reject, cleanup } of callbacks.values()) {
                cleanup();
                const error = new Error(`Protocol process stopped with exit code ${code}`);
                error.code = 'WORKER_EXIT';
                reject(error);
            }
            callbacks.clear();
            exitListeners.forEach(listener => {
                try {
                    listener(code);
                } catch (error) {
                    logger.error('协议进程退出监听器执行失败:', error);
                }
            });
            try {
                this.options.onExit?.(code, client, {
                    expected: terminating,
                    signal: processHost.exitSignal
                });
            } catch (error) {
                logger.error('协议进程退出回调执行失败:', error);
            }
        });

        client = {
            worker: processHost,
            process: processHost,
            get pid() {
                return processHost.pid;
            },
            serviceName: processHost.serviceName,
            transport: processHost.runtimeKind,

            sendRequest(op, data = null, options = {}) {
                if (terminating || !processHost.runtime) {
                    return Promise.reject(createUnavailableError());
                }
                if (options.signal?.aborted) {
                    const error = new Error(`Protocol process request cancelled: ${op}`);
                    error.code = 'WORKER_CANCELLED';
                    return Promise.reject(error);
                }

                const request = WorkerWithPromise.createRequest(op, data);
                const timeoutMs =
                    options.timeoutMs === undefined ? defaultTimeoutMs : Math.max(0, Number(options.timeoutMs));
                return new Promise((resolve, reject) => {
                    let timeout = null;
                    let abortHandler = null;
                    const cleanup = () => {
                        if (timeout) clearTimeout(timeout);
                        if (abortHandler && options.signal) options.signal.removeEventListener('abort', abortHandler);
                    };
                    const rejectPending = error => {
                        if (!callbacks.delete(request.messageId)) return;
                        cleanup();
                        reject(error);
                    };

                    if (timeoutMs > 0) {
                        timeout = setTimeout(() => {
                            const error = new Error(`Protocol process request timed out after ${timeoutMs}ms: ${op}`);
                            error.code = 'WORKER_TIMEOUT';
                            rejectPending(error);
                        }, timeoutMs);
                    }
                    if (options.signal) {
                        abortHandler = () => {
                            const error = new Error(`Protocol process request cancelled: ${op}`);
                            error.code = 'WORKER_CANCELLED';
                            rejectPending(error);
                        };
                        options.signal.addEventListener('abort', abortHandler, { once: true });
                    }

                    callbacks.set(request.messageId, { resolve, reject, cleanup });
                    try {
                        processHost.postMessage(request);
                    } catch (error) {
                        callbacks.delete(request.messageId);
                        cleanup();
                        reject(error);
                    }
                });
            },

            addEventListener(eventName, listener) {
                if (!eventListeners.has(eventName)) {
                    eventListeners.set(eventName, new Set());
                }
                eventListeners.get(eventName).add(listener);
            },

            removeEventListener(eventName, listener) {
                eventListeners.get(eventName)?.delete(listener);
            },

            addExitListener(listener) {
                exitListeners.add(listener);
            },

            removeExitListener(listener) {
                exitListeners.delete(listener);
            },

            terminate() {
                if (terminationPromise) return terminationPromise;
                terminating = true;
                if (callbacks.size > 0) {
                    logger.info(`等待 ${callbacks.size} 个协议进程请求完成...`);
                    terminationPromise = new Promise(resolve => {
                        const deadline = Date.now() + pendingDrainTimeoutMs;
                        const checkCallbacks = () => {
                            if (callbacks.size === 0 || Date.now() >= deadline) {
                                if (callbacks.size > 0) {
                                    const error = new Error('Protocol process terminated with pending requests');
                                    for (const { reject, cleanup } of callbacks.values()) {
                                        cleanup();
                                        reject(error);
                                    }
                                    callbacks.clear();
                                }
                                resolve(processHost.terminate());
                            } else {
                                setTimeout(checkCallbacks, 100);
                            }
                        };
                        checkCallbacks();
                    });
                } else {
                    terminationPromise = processHost.terminate();
                }
                terminationPromise = Promise.resolve(terminationPromise).catch(error => {
                    terminationPromise = null;
                    throw error;
                });
                return terminationPromise;
            }
        };
        return client;
    }
}

module.exports = ProtocolProcessWithPromise;
