const logger = require('../log/logger');

/**
 * 统一事件发送器
 * 用于管理主进程到渲染进程的所有事件发送
 */
class EventDispatcher {
    constructor() {
        this.webContents = null;
    }

    /**
     * 设置 webContents 实例
     * @param {Electron.WebContents} webContents
     */
    setWebContents(webContents) {
        this.webContents = webContents;
    }

    /**
     * 发送统一格式的事件
     * @param {string} eventType 事件类型 (如: 'bgp:peerChange')
     * @param {any} data 事件数据
     */
    emit(eventType, data) {
        if (!this.webContents) {
            logger.warn(`EventDispatcher: webContents not set, cannot emit event ${eventType}`);
            return;
        }

        try {
            // 使用统一的事件格式发送
            logger.info('EventDispatcher type:', eventType);
            this.webContents.send('unified-event', {
                type: eventType,
                data: data
            });
        } catch (error) {
            logger.error(`EventDispatcher: Failed to emit event ${eventType}:`, error);
        }
    }

    /**
     * 检查是否可以发送事件
     */
    canEmit() {
        return this.webContents && !this.webContents.isDestroyed();
    }

    /**
     * 清理 webContents 引用
     */
    cleanup() {
        this.webContents = null;
    }
}

module.exports = EventDispatcher;
