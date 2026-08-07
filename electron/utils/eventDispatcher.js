const logger = require('../log/logger');

// 额外的主题订阅者用于拆分窗口。协议模块原有的主目标仍由实例的
// webContents 保存，因此未订阅拆窗事件的模块不会改变现有投递行为。
const topicSubscribers = new Map();

function canSend(target) {
    return (
        target &&
        typeof target.send === 'function' &&
        !(typeof target.isDestroyed === 'function' && target.isDestroyed())
    );
}

function normalizeEventTypes(eventTypes) {
    const values = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
    return values.map(value => String(value || '').trim()).filter(Boolean);
}

function normalizeSubscriptionOptions(options = {}) {
    return {
        transform: typeof options?.transform === 'function' ? options.transform : null
    };
}

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
     * 为拆分窗口订阅指定主题。订阅与 EventDispatcher 实例无关，确保协议
     * 服务重启并创建新的 dispatcher 后，窗口仍能继续收到相同主题。
     * @param {Electron.WebContents} webContents
     * @param {string|string[]} eventTypes
     * @param {{transform?: (data: any, eventType: string) => any}} [options]
     * transform 返回 undefined 时跳过该订阅者，可用于按 Client 裁剪批量事件。
     */
    static subscribe(webContents, eventTypes, options = {}) {
        if (!canSend(webContents)) {
            return false;
        }

        const normalizedTypes = normalizeEventTypes(eventTypes);
        if (normalizedTypes.length === 0) {
            return false;
        }

        let subscriptions = topicSubscribers.get(webContents);
        if (!subscriptions) {
            subscriptions = new Map();
            topicSubscribers.set(webContents, subscriptions);
            if (typeof webContents.once === 'function') {
                webContents.once('destroyed', () => {
                    topicSubscribers.delete(webContents);
                });
            }
        }

        const normalizedOptions = normalizeSubscriptionOptions(options);
        normalizedTypes.forEach(eventType => subscriptions.set(eventType, normalizedOptions));
        return true;
    }

    /**
     * 清理窗口的全部主题，或只清理给定主题。
     * @param {Electron.WebContents} webContents
     * @param {string|string[]} [eventTypes]
     */
    static unsubscribe(webContents, eventTypes) {
        const subscriptions = topicSubscribers.get(webContents);
        if (!subscriptions) {
            return;
        }

        if (eventTypes === undefined) {
            topicSubscribers.delete(webContents);
            return;
        }

        normalizeEventTypes(eventTypes).forEach(eventType => subscriptions.delete(eventType));
        if (subscriptions.size === 0) {
            topicSubscribers.delete(webContents);
        }
    }

    static getSubscriberDeliveries(eventType, data) {
        const deliveries = [];
        topicSubscribers.forEach((subscriptions, target) => {
            if (!canSend(target)) {
                topicSubscribers.delete(target);
                return;
            }

            const subscription = subscriptions.get(eventType);
            if (!subscription) {
                return;
            }

            let deliveryData = data;
            if (subscription.transform) {
                try {
                    deliveryData = subscription.transform(data, eventType);
                } catch (error) {
                    logger.error(`EventDispatcher: subscription transform failed for ${eventType}:`, error);
                    return;
                }
                if (deliveryData === undefined) {
                    return;
                }
            }

            deliveries.push({ target, data: deliveryData });
        });
        return deliveries;
    }

    static getSubscriberTargets(eventType) {
        const targets = [];
        topicSubscribers.forEach((subscriptions, target) => {
            if (!canSend(target)) {
                topicSubscribers.delete(target);
                return;
            }
            if (subscriptions.has(eventType)) {
                targets.push(target);
            }
        });
        return targets;
    }

    sendToDeliveries(eventType, deliveries, excludedTargets = new Set(), logWhenSent = true) {
        const deliveredTargets = new Set();
        let sentCount = 0;

        deliveries.forEach(({ target, data }) => {
            if (excludedTargets.has(target) || deliveredTargets.has(target) || !canSend(target)) {
                return;
            }
            try {
                target.send('unified-event', {
                    type: eventType,
                    data
                });
                deliveredTargets.add(target);
                sentCount += 1;
            } catch (error) {
                EventDispatcher.unsubscribe(target);
                logger.error(`EventDispatcher: Failed to emit event ${eventType}:`, error);
            }
        });

        if (logWhenSent && sentCount > 0) {
            logger.info('EventDispatcher type:', eventType);
        }
        return sentCount;
    }

    sendToTargets(eventType, data, targets, warnWhenEmpty = true, logWhenSent = true) {
        const uniqueTargets = new Set(targets);
        if (uniqueTargets.size === 0) {
            if (warnWhenEmpty) {
                logger.warn(`EventDispatcher: webContents not set, cannot emit event ${eventType}`);
            }
            return 0;
        }

        let sentCount = 0;
        if (logWhenSent) {
            logger.info('EventDispatcher type:', eventType);
        }
        uniqueTargets.forEach(target => {
            try {
                target.send('unified-event', {
                    type: eventType,
                    data: data
                });
                sentCount += 1;
            } catch (error) {
                EventDispatcher.unsubscribe(target);
                logger.error(`EventDispatcher: Failed to emit event ${eventType}:`, error);
            }
        });
        return sentCount;
    }

    /**
     * 发送统一格式的事件
     * @param {string} eventType 事件类型 (如: 'bgp:peerChange')
     * @param {any} data 事件数据
     */
    emit(eventType, data) {
        const primaryTargets = new Set();
        if (canSend(this.webContents)) {
            primaryTargets.add(this.webContents);
        }

        const primaryCount = this.sendToTargets(eventType, data, primaryTargets, false, false);
        const subscriberCount = this.sendToDeliveries(
            eventType,
            EventDispatcher.getSubscriberDeliveries(eventType, data),
            primaryTargets,
            false
        );

        if (primaryCount + subscriberCount > 0) {
            logger.info('EventDispatcher type:', eventType);
        } else {
            logger.warn(`EventDispatcher: webContents not set, cannot emit event ${eventType}`);
        }
        return primaryCount + subscriberCount;
    }

    /**
     * 只向原始渲染目标发送。用于配置页的低频状态更新。
     */
    emitToPrimary(eventType, data) {
        const targets = canSend(this.webContents) ? [this.webContents] : [];
        return this.sendToTargets(eventType, data, targets);
    }

    /**
     * 只向显式订阅窗口发送。没有独立监控窗口时直接返回，不产生 renderer IPC。
     */
    emitToSubscribers(eventType, data) {
        return this.sendToDeliveries(eventType, EventDispatcher.getSubscriberDeliveries(eventType, data));
    }

    /**
     * 检查是否可以发送事件
     */
    canEmit(eventType) {
        return (
            canSend(this.webContents) ||
            (typeof eventType === 'string' && EventDispatcher.getSubscriberTargets(eventType).length > 0)
        );
    }

    /**
     * 清理 webContents 引用
     */
    cleanup() {
        this.webContents = null;
    }
}

module.exports = EventDispatcher;
