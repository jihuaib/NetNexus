<template>
    <div class="mt-container adaptive-table-page">
        <nn-card title="NTP请求日志" class="adaptive-table-card">
            <template #extra>
                <nn-space>
                    <nn-button :loading="loading" @click="loadRequestList">刷新</nn-button>
                    <nn-button danger :loading="clearLoading" @click="clearHistory">清空历史</nn-button>
                </nn-space>
            </template>

            <nn-table
                :columns="columns"
                :data-source="requestList"
                :loading="loading"
                :pagination="{
                    pageSize: 20,
                    showSizeChanger: false,
                    position: ['bottomCenter'],
                    showTotal: total => '共 ' + total + ' 条，每页 20 条'
                }"
                :scroll="{ x: 'max-content', y: '100%' }"
                row-key="id"
                size="small"
                class="adaptive-table"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'status'">
                        <nn-tag :color="statusColor(record.status)">
                            {{ statusText(record.status) }}
                        </nn-tag>
                    </template>
                </template>
            </nn-table>
        </nn-card>
    </div>
</template>

<script setup>
    import { ref, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import { NTP_SUB_EVT_TYPES, NTP_EVENT_PAGE_ID, NTP_REQUEST_STATUS } from '../../const/ntpConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'NtpRequestLog' });

    const loading = ref(false);
    const clearLoading = ref(false);
    const requestList = ref([]);

    const columns = [
        { title: 'ID', dataIndex: 'id', key: 'id', width: 80 },
        { title: '接收时间', dataIndex: 'timestamp', key: 'timestamp', width: 200 },
        { title: '客户端地址', dataIndex: 'clientAddress', key: 'clientAddress', width: 160 },
        { title: '客户端端口', dataIndex: 'clientPort', key: 'clientPort', width: 100 },
        { title: 'IP版本', dataIndex: 'ipVersion', key: 'ipVersion', width: 90 },
        { title: 'NTP版本', dataIndex: 'version', key: 'version', width: 90 },
        { title: '模式', dataIndex: 'modeName', key: 'modeName', width: 120 },
        { title: '客户端发起时间', dataIndex: 'clientTransmitTime', key: 'clientTransmitTime', width: 220 },
        { title: '服务器接收时间', dataIndex: 'receiveTime', key: 'receiveTime', width: 220 },
        { title: '服务器发送时间', dataIndex: 'transmitTime', key: 'transmitTime', width: 220 },
        { title: '状态', dataIndex: 'status', key: 'status', width: 100 },
        { title: '说明', dataIndex: 'message', key: 'message', width: 220, ellipsis: true }
    ];

    const statusColor = status => {
        switch (status) {
            case NTP_REQUEST_STATUS.REPLIED:
                return 'success';
            case NTP_REQUEST_STATUS.IGNORED:
                return 'default';
            case NTP_REQUEST_STATUS.ERROR:
                return 'error';
            default:
                return 'default';
        }
    };

    const statusText = status => {
        switch (status) {
            case NTP_REQUEST_STATUS.REPLIED:
                return '已响应';
            case NTP_REQUEST_STATUS.IGNORED:
                return '已忽略';
            case NTP_REQUEST_STATUS.ERROR:
                return '错误';
            default:
                return status || '-';
        }
    };

    const loadRequestList = async () => {
        try {
            loading.value = true;
            const result = await window.ntpApi.getRequestList();
            if (result.status === 'success') {
                requestList.value = result.data || [];
            } else {
                notify.error(result.msg || '获取NTP请求日志失败');
            }
        } catch (error) {
            notify.error('获取NTP请求日志失败: ' + error.message);
        } finally {
            loading.value = false;
        }
    };

    const clearHistory = async () => {
        try {
            clearLoading.value = true;
            const result = await window.ntpApi.clearRequestHistory();
            if (result.status === 'success') {
                requestList.value = [];
                notify.success(result.msg || 'NTP请求日志已清空');
            } else {
                notify.error(result.msg || '清空NTP请求日志失败');
            }
        } catch (error) {
            notify.error('清空NTP请求日志失败: ' + error.message);
        } finally {
            clearLoading.value = false;
        }
    };

    const handleNtpEvent = respData => {
        if (respData.status !== 'success') {
            return;
        }

        const payload = respData.data;
        if (payload.type === NTP_SUB_EVT_TYPES.REQUEST_RECEIVED) {
            requestList.value = [payload.data, ...requestList.value.filter(item => item.id !== payload.data.id)];
        } else if (payload.type === NTP_SUB_EVT_TYPES.HISTORY_CLEARED) {
            requestList.value = [];
        } else if (payload.type === NTP_SUB_EVT_TYPES.SERVER_STATUS && payload.data.status === 'stopped') {
            requestList.value = [];
        }
    };

    onActivated(async () => {
        EventBus.on('ntp:event', NTP_EVENT_PAGE_ID.PAGE_ID_NTP_REQUEST_LOG, handleNtpEvent);
        await loadRequestList();
    });

    onDeactivated(() => {
        EventBus.off('ntp:event', NTP_EVENT_PAGE_ID.PAGE_ID_NTP_REQUEST_LOG);
    });
</script>

<style scoped>
    .adaptive-table-page {
        height: calc(100vh - 70px);
        min-height: 0;
        overflow: hidden;
    }

    .adaptive-table-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .adaptive-table-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        min-width: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table,
    .adaptive-table :deep(.nn-spin-nested-loading),
    .adaptive-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
    }

    .adaptive-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .adaptive-table :deep(.nn-table-container),
    .adaptive-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.nn-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .adaptive-table :deep(.nn-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .adaptive-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .adaptive-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
