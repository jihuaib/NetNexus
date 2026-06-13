const { parentPort } = require('worker_threads');
const logger = require('../log/logger');
const { LOG_REQ_TYPES } = require('../const/toolsConst');

class WorkerMessageHandler {
    constructor() {
        this.handlers = new Map();
    }

    /**
     * 创建带有消息ID的响应消息
     * @param {string} messageId - 请求消息ID
     * @param {string} status - 响应状态
     * @param {string} msg - 响应消息
     * @param {any} data - 响应数据
     * @returns {Object} 带有消息ID的响应消息
     */
    static createMessageResponse(messageId, status, msg = '', data = null) {
        return {
            messageId,
            status,
            msg,
            data
        };
    }

    // 初始化消息处理, 用于监听app发送给worker的消息
    init() {
        if (!parentPort) {
            throw new Error('This function must be called in a worker thread');
        }

        parentPort.on('message', message => {
            const { messageId, op, data } = message;
            logger.info(`recv msg: ${JSON.stringify(this.summarizeMessage(message))}`);

            if (!op) {
                this.sendErrorResponse(messageId, 'Invalid message format: missing operation');
                return;
            }

            if (op === LOG_REQ_TYPES.SET_LOG_LEVEL) {
                logger.setLevel(data);
                this.sendSuccessResponse(messageId, null, '日志级别已更新');
                return;
            }

            if (this.handlers.has(op)) {
                try {
                    const handler = this.handlers.get(op);
                    handler(messageId, data);
                } catch (error) {
                    logger.error(`Error handling operation ${op}:`, error);
                    this.sendErrorResponse(messageId, `Error handling operation ${op}: ${error.message}`);
                }
            } else {
                logger.error(`No handler registered for operation: ${op}`);
                this.sendErrorResponse(messageId, `No handler registered for operation: ${op}`);
            }
        });
    }

    summarizeMessage(message) {
        const summarize = value => {
            if (Array.isArray(value)) {
                return `[Array(${value.length})]`;
            }
            if (value && typeof value === 'object') {
                const summary = {};
                for (const [key, item] of Object.entries(value)) {
                    summary[key] = Array.isArray(item) ? `[Array(${item.length})]` : item;
                }
                return summary;
            }
            return value;
        };

        return {
            ...message,
            data: summarize(message.data)
        };
    }

    // worker注册消息处理器
    registerHandler(op, handler) {
        this.handlers.set(op, handler);
    }

    // worker发送成功响应
    sendSuccessResponse(messageId, data = null, msg = '') {
        if (!parentPort) return;

        parentPort.postMessage(WorkerMessageHandler.createMessageResponse(messageId, 'success', msg, data));
    }

    // worker发送错误响应
    sendErrorResponse(messageId, msg = '', data = null) {
        if (!parentPort) return;

        parentPort.postMessage(WorkerMessageHandler.createMessageResponse(messageId, 'error', msg, data));
    }

    // worker发送事件通知（不需要messageId，不是响应）
    sendEvent(eventName, data = null) {
        if (!parentPort) return;

        parentPort.postMessage({
            eventName,
            data
        });
    }
}

module.exports = WorkerMessageHandler;
