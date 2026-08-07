<template>
    <div class="netconf-notification-window" data-testid="netconf-notification-monitor-page">
        <YangNotificationDrawer
            standalone
            :open="true"
            :disconnecting="requestingAction"
            @export="exportNotifications"
            @mark-history-read="payload => persistHistoryMutation('markNotificationRead', payload)"
            @delete-history="payload => persistHistoryMutation('deleteNotificationHistory', payload)"
            @clear-history="payload => persistHistoryMutation('clearNotificationHistory', payload)"
            @disconnect-session="requestNotificationAction"
            @modify-subscription="requestNotificationAction"
            @delete-subscription="requestNotificationAction"
            @resync-subscription="requestNotificationAction"
        />
    </div>
</template>

<script setup>
    import { onMounted, ref } from 'vue';
    import { notify } from '../../utils/notify';
    import YangNotificationDrawer from './YangNotificationDrawer.vue';
    import { useNetconfNotificationHistory } from './useNetconfNotificationHistory';
    import { invokeBridge } from './yangUiUtils';

    defineOptions({ name: 'NetconfNotificationWindow' });

    const requestingAction = ref(false);
    const { hydrateHistory } = useNetconfNotificationHistory();

    const loadHistorySnapshot = async ({ quiet = false } = {}) => {
        try {
            const { data } = await invokeBridge('netconfApi', 'getNotificationHistory', {});
            const snapshot = data?.history && typeof data.history === 'object' ? data.history : data || {};
            hydrateHistory({
                notifications: snapshot.notifications || snapshot.records || snapshot.items || [],
                subscriptions: snapshot.subscriptions || []
            });
        } catch (error) {
            if (!quiet) notify.error(`加载 NETCONF 通知历史失败：${error.message}`);
        }
    };

    const persistHistoryMutation = async (method, payload) => {
        try {
            await invokeBridge('netconfApi', method, payload || {});
        } catch (error) {
            notify.error(`保存通知历史状态失败：${error.message}`);
            await loadHistorySnapshot({ quiet: true });
        }
    };

    const requestNotificationAction = async subscription => {
        if (requestingAction.value) return;
        requestingAction.value = true;
        try {
            await invokeBridge('netconfApi', 'requestNotificationAction', subscription || {});
            notify.info('已在主窗口打开订阅操作');
        } catch (error) {
            notify.error(`打开订阅操作失败：${error.message}`);
        } finally {
            requestingAction.value = false;
        }
    };

    const exportNotifications = descriptor => {
        const content = String(descriptor?.content || '');
        if (!content) {
            notify.warning('当前筛选下没有可导出的通知');
            return;
        }
        try {
            const blob = new Blob([content], {
                type: descriptor.mimeType || 'application/json;charset=utf-8'
            });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = descriptor.filename || 'netconf-notifications.json';
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
            notify.success('通知记录已导出');
        } catch (error) {
            notify.error(`导出通知失败：${error.message}`);
        }
    };

    onMounted(() => loadHistorySnapshot());
</script>

<style scoped>
    .netconf-notification-window {
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
    }
</style>
