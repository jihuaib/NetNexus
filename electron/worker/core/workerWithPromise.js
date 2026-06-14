const { Worker } = require('worker_threads');
const logger = require('../../log/logger');

class WorkerWithPromise {
    constructor(workerPath, workerData) {
        this.workerPath = workerPath;
        this.workerData = workerData;
    }

    /**
     * 生成唯一的消息ID
     * @returns {string} 唯一消息ID
     */
    static generateMessageId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    }

    /**
     * 创建带有消息ID的请求消息
     * @param {string} op - 操作类型
     * @param {any} data - 请求数据
     * @returns {Object} 带有消息ID的请求消息
     */
    static createRequest(op, data = null) {
        return {
            messageId: this.generateMessageId(),
            op,
            data
        };
    }

    // 创建长期运行的worker，支持请求-响应模式通信
    createLongRunningWorker() {
        const worker = new Worker(this.workerPath);
        const callbacks = new Map();
        const eventListeners = new Map();

        logger.info(`长期运行worker启动: ${this.workerPath}`);

        // 处理worker响应
        worker.on('message', result => {
            // 检查是否是事件通知
            if (result.eventName && eventListeners.has(result.eventName)) {
                const listeners = eventListeners.get(result.eventName);
                listeners.forEach(listener => listener(result.data));
                return;
            }

            // 处理请求-响应
            if (result.messageId && callbacks.has(result.messageId)) {
                const { resolve, reject } = callbacks.get(result.messageId);
                callbacks.delete(result.messageId);

                if (result.status === 'success') {
                    resolve(result);
                } else {
                    reject(new Error(result.msg || 'Worker execution failed'));
                }
            } else {
                logger.warn(`收到未跟踪的消息:`, result);
            }
        });

        worker.on('error', err => {
            logger.error(`发生错误:`, err);
            // 拒绝所有待处理的请求
            for (const { reject } of callbacks.values()) {
                reject(new Error(err));
            }
            callbacks.clear();
        });

        worker.on('exit', code => {
            if (code !== 0) {
                logger.error(`退出异常，退出码:`, code);
            } else {
                logger.info(`this worker has completed successfully.`);
            }

            // 拒绝所有待处理的请求
            for (const { reject } of callbacks.values()) {
                reject(new Error(`Worker stopped with exit code ${code}`));
            }
            callbacks.clear();
        });

        return {
            worker,

            // 发送请求并等待响应
            sendRequest(op, data = null) {
                return new Promise((resolve, reject) => {
                    const request = WorkerWithPromise.createRequest(op, data);
                    callbacks.set(request.messageId, { resolve, reject });
                    worker.postMessage(request);
                });
            },

            // 注册事件监听器
            addEventListener(eventName, listener) {
                if (!eventListeners.has(eventName)) {
                    eventListeners.set(eventName, new Set());
                }
                eventListeners.get(eventName).add(listener);
            },

            // 移除事件监听器
            removeEventListener(eventName, listener) {
                if (eventListeners.has(eventName)) {
                    eventListeners.get(eventName).delete(listener);
                }
            },

            // 终止worker
            terminate() {
                // 检查是否还有未完成的请求
                if (callbacks.size > 0) {
                    logger.info(`等待 ${callbacks.size} 个未完成的请求...`);
                    return new Promise(resolve => {
                        // 创建一个检查函数，定期检查是否所有回调都已完成
                        const checkCallbacks = () => {
                            if (callbacks.size === 0) {
                                logger.info('所有请求已完成，安全终止worker');
                                resolve(worker.terminate());
                            } else {
                                setTimeout(checkCallbacks, 100);
                            }
                        };
                        checkCallbacks();
                    });
                }

                return worker.terminate();
            }
        };
    }

    // 封装 worker 异步操作，支持消息ID跟踪
    runWorkerWithPromise(workerPath, workerData) {
        return new Promise((resolve, reject) => {
            const worker = new Worker(workerPath);

            logger.info(`启动worker: ${workerPath}`);

            // 向 worker 发送数据
            worker.postMessage(workerData);

            // 成功结果
            worker.on('message', result => {
                logger.info(`处理成功: ${JSON.stringify(result)}`);
                if (result.status === 'success') {
                    resolve(result.data);
                } else {
                    reject(new Error(result.msg || 'Worker execution failed'));
                }
                worker.terminate();
            });

            // 错误处理
            worker.on('error', err => {
                // reject会向上抛异常
                logger.error(`发生错误: ${err}`);
                reject(new Error(err.message || 'Worker execution failed'));
                worker.terminate();
            });

            // 提前退出也算失败
            worker.on('exit', code => {
                if (code !== 0) {
                    logger.error(`退出异常，退出码: ${code}`);
                    reject(new Error(`Worker stopped with exit code ${code}`));
                } else {
                    logger.info(`has completed successfully.`);
                }
                worker.terminate();
            });
        });
    }
}

module.exports = WorkerWithPromise;
