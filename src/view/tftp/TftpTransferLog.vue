<template>
    <div class="mt-container adaptive-table-page">
        <nn-card title="TFTP传输日志" class="adaptive-table-card">
            <template #extra>
                <nn-space>
                    <nn-button :loading="loading" @click="loadTransferList">刷新</nn-button>
                    <nn-button danger :loading="clearLoading" @click="clearHistory">清空历史</nn-button>
                </nn-space>
            </template>

            <a-table
                :columns="columns"
                :data-source="transferList"
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
                    <template v-if="column.key === 'type'">
                        <nn-tag :color="record.type === TFTP_TRANSFER_TYPE.READ ? 'blue' : 'purple'">
                            {{ typeText(record.type) }}
                        </nn-tag>
                    </template>
                    <template v-else-if="column.key === 'status'">
                        <nn-tag :color="statusColor(record.status)">
                            {{ statusText(record.status) }}
                        </nn-tag>
                    </template>
                </template>
            </a-table>
        </nn-card>
    </div>
</template>

<script setup>
    import { ref, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import {
        TFTP_SUB_EVT_TYPES,
        TFTP_EVENT_PAGE_ID,
        TFTP_TRANSFER_STATUS,
        TFTP_TRANSFER_TYPE
    } from '../../const/tftpConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'TftpTransferLog' });

    const loading = ref(false);
    const clearLoading = ref(false);
    const transferList = ref([]);

    const columns = [
        { title: 'ID', dataIndex: 'id', key: 'id', width: 70 },
        { title: '时间', dataIndex: 'timestamp', key: 'timestamp', width: 190 },
        { title: '客户端地址', dataIndex: 'clientAddress', key: 'clientAddress', width: 150 },
        { title: '端口', dataIndex: 'clientPort', key: 'clientPort', width: 80 },
        { title: '类型', dataIndex: 'type', key: 'type', width: 90 },
        { title: '文件名', dataIndex: 'filename', key: 'filename', width: 200, ellipsis: true },
        { title: '模式', dataIndex: 'mode', key: 'mode', width: 90 },
        { title: '块大小', dataIndex: 'blockSize', key: 'blockSize', width: 90 },
        { title: '已传字节', dataIndex: 'bytes', key: 'bytes', width: 110 },
        { title: '状态', dataIndex: 'status', key: 'status', width: 90 },
        { title: '说明', dataIndex: 'message', key: 'message', width: 200, ellipsis: true }
    ];

    const typeText = type => (type === TFTP_TRANSFER_TYPE.READ ? '下载(RRQ)' : '上传(WRQ)');

    const statusColor = status => {
        switch (status) {
            case TFTP_TRANSFER_STATUS.COMPLETED:
                return 'success';
            case TFTP_TRANSFER_STATUS.TRANSFERRING:
                return 'processing';
            case TFTP_TRANSFER_STATUS.ERROR:
                return 'error';
            default:
                return 'default';
        }
    };

    const statusText = status => {
        switch (status) {
            case TFTP_TRANSFER_STATUS.COMPLETED:
                return '已完成';
            case TFTP_TRANSFER_STATUS.TRANSFERRING:
                return '传输中';
            case TFTP_TRANSFER_STATUS.ERROR:
                return '错误';
            default:
                return status || '-';
        }
    };

    const loadTransferList = async () => {
        try {
            loading.value = true;
            const result = await window.tftpApi.getTransferList();
            if (result.status === 'success') {
                transferList.value = result.data || [];
            } else {
                notify.error(result.msg || '获取TFTP传输日志失败');
            }
        } catch (error) {
            notify.error('获取TFTP传输日志失败: ' + error.message);
        } finally {
            loading.value = false;
        }
    };

    const clearHistory = async () => {
        try {
            clearLoading.value = true;
            const result = await window.tftpApi.clearTransferHistory();
            if (result.status === 'success') {
                transferList.value = [];
                notify.success(result.msg || 'TFTP传输日志已清空');
            } else {
                notify.error(result.msg || '清空TFTP传输日志失败');
            }
        } catch (error) {
            notify.error('清空TFTP传输日志失败: ' + error.message);
        } finally {
            clearLoading.value = false;
        }
    };

    const handleTftpEvent = respData => {
        if (respData.status !== 'success') {
            return;
        }

        const payload = respData.data;
        if (payload.type === TFTP_SUB_EVT_TYPES.TRANSFER_UPDATE) {
            const others = transferList.value.filter(item => item.id !== payload.data.id);
            transferList.value = [payload.data, ...others].sort((a, b) => b.id - a.id);
        } else if (payload.type === TFTP_SUB_EVT_TYPES.HISTORY_CLEARED) {
            transferList.value = [];
        } else if (payload.type === TFTP_SUB_EVT_TYPES.SERVER_STATUS && payload.data.status === 'stopped') {
            transferList.value = [];
        }
    };

    onActivated(async () => {
        EventBus.on('tftp:event', TFTP_EVENT_PAGE_ID.PAGE_ID_TFTP_TRANSFER_LOG, handleTftpEvent);
        await loadTransferList();
    });

    onDeactivated(() => {
        EventBus.off('tftp:event', TFTP_EVENT_PAGE_ID.PAGE_ID_TFTP_TRANSFER_LOG);
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
    .adaptive-table :deep(.ant-spin-nested-loading),
    .adaptive-table :deep(.ant-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
    }

    .adaptive-table :deep(.ant-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.ant-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .adaptive-table :deep(.ant-table-container),
    .adaptive-table :deep(.ant-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .adaptive-table :deep(.ant-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .adaptive-table :deep(.ant-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .adaptive-table :deep(.ant-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .adaptive-table :deep(.ant-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
