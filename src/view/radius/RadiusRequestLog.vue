<template>
    <div class="mt-container radius-table-page">
        <nn-card title="RADIUS请求日志" class="radius-table-card">
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
                class="radius-table"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'status'">
                        <nn-tag :color="statusColor(record.status)">
                            {{ statusText(record.status) }}
                        </nn-tag>
                    </template>
                    <template v-else-if="column.key === 'codeName'">{{ record.codeName }}({{ record.code }})</template>
                    <template v-else-if="column.key === 'responseCodeName'">
                        <span v-if="record.responseCodeName">
                            {{ record.responseCodeName }}({{ record.responseCode }})
                        </span>
                        <span v-else>-</span>
                    </template>
                    <template v-else-if="column.key === 'client'">
                        {{ clientText(record) }}
                    </template>
                    <template v-else-if="column.key === 'message'">
                        <span class="single-line-text" :title="record.message">{{ record.message || '-' }}</span>
                    </template>
                    <template v-else-if="column.key === 'action'">
                        <nn-button type="link" size="small" @click="showDetail(record)">详情</nn-button>
                    </template>
                </template>
            </nn-table>
        </nn-card>

        <nn-drawer
            v-model:open="detailDrawerVisible"
            :title="detailDrawerTitle"
            width="720px"
            placement="right"
            @close="closeDetailDrawer"
        >
            <nn-empty v-if="!selectedRequest" description="暂无详情" />
            <template v-else>
                <nn-descriptions title="请求摘要" size="small" bordered :column="1">
                    <nn-descriptions-item label="ID">{{ selectedRequest.id }}</nn-descriptions-item>
                    <nn-descriptions-item label="接收时间">{{ selectedRequest.timestamp || '-' }}</nn-descriptions-item>
                    <nn-descriptions-item label="服务">{{ selectedRequest.service || '-' }}</nn-descriptions-item>
                    <nn-descriptions-item label="客户端">
                        {{ selectedRequest.clientAddress || '-' }}:{{ selectedRequest.clientPort || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="请求Code">
                        {{ selectedRequest.codeName || '-' }}({{ selectedRequest.code || '-' }})
                    </nn-descriptions-item>
                    <nn-descriptions-item label="响应Code">
                        <span v-if="selectedRequest.responseCodeName">
                            {{ selectedRequest.responseCodeName }}({{ selectedRequest.responseCode }})
                        </span>
                        <span v-else>-</span>
                    </nn-descriptions-item>
                    <nn-descriptions-item label="状态">
                        <nn-tag :color="statusColor(selectedRequest.status)">
                            {{ statusText(selectedRequest.status) }}
                        </nn-tag>
                    </nn-descriptions-item>
                    <nn-descriptions-item label="用户">{{ selectedRequest.userName || '-' }}</nn-descriptions-item>
                    <nn-descriptions-item label="认证方式">
                        {{ selectedRequest.authMethod || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Identifier">{{ selectedRequest.identifier }}</nn-descriptions-item>
                    <nn-descriptions-item label="报文长度">
                        {{ selectedRequest.packetLength || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Session Key">
                        {{ selectedRequest.sessionKey || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="说明">{{ selectedRequest.message || '-' }}</nn-descriptions-item>
                </nn-descriptions>

                <div class="detail-section">
                    <div class="detail-section-title">属性</div>
                    <nn-table
                        :columns="attributeColumns"
                        :data-source="selectedRequest.attributes || []"
                        :pagination="false"
                        size="small"
                        :row-key="attributeRowKey"
                        class="detail-attribute-table"
                    />
                </div>
            </template>
        </nn-drawer>
    </div>
</template>

<script setup>
    import { ref, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import { RADIUS_EVENT_PAGE_ID, RADIUS_REQUEST_STATUS, RADIUS_SUB_EVT_TYPES } from '../../const/radiusConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'RadiusRequestLog' });

    const loading = ref(false);
    const clearLoading = ref(false);
    const requestList = ref([]);
    const detailDrawerVisible = ref(false);
    const detailDrawerTitle = ref('');
    const selectedRequest = ref(null);

    const columns = [
        { title: '时间', dataIndex: 'timestamp', key: 'timestamp', width: 190 },
        { title: '服务', dataIndex: 'service', key: 'service', width: 120 },
        { title: '客户端', key: 'client', width: 180 },
        { title: '请求', dataIndex: 'codeName', key: 'codeName', width: 170 },
        { title: '响应', dataIndex: 'responseCodeName', key: 'responseCodeName', width: 180 },
        { title: '用户', dataIndex: 'userName', key: 'userName', width: 140 },
        { title: '状态', dataIndex: 'status', key: 'status', width: 100 },
        { title: '说明', dataIndex: 'message', key: 'message', width: 260, ellipsis: true },
        { title: '操作', key: 'action', width: 90, fixed: 'right' }
    ];

    const attributeColumns = [
        { title: '类型', dataIndex: 'type', key: 'type', width: 90 },
        { title: '名称', dataIndex: 'name', key: 'name', width: 220 },
        { title: '值', dataIndex: 'value', key: 'value' }
    ];

    const attributeRowKey = (record, index) => `${record.type}-${record.name}-${index}`;

    const statusColor = status => {
        switch (status) {
            case RADIUS_REQUEST_STATUS.ACCEPTED:
            case RADIUS_REQUEST_STATUS.ACCOUNTED:
            case RADIUS_REQUEST_STATUS.ACK:
                return 'success';
            case RADIUS_REQUEST_STATUS.CHALLENGED:
                return 'processing';
            case RADIUS_REQUEST_STATUS.REJECTED:
            case RADIUS_REQUEST_STATUS.NAK:
            case RADIUS_REQUEST_STATUS.ERROR:
                return 'error';
            case RADIUS_REQUEST_STATUS.IGNORED:
                return 'default';
            default:
                return 'default';
        }
    };

    const statusText = status => {
        switch (status) {
            case RADIUS_REQUEST_STATUS.ACCEPTED:
                return '已接受';
            case RADIUS_REQUEST_STATUS.REJECTED:
                return '已拒绝';
            case RADIUS_REQUEST_STATUS.CHALLENGED:
                return '已挑战';
            case RADIUS_REQUEST_STATUS.ACCOUNTED:
                return '已计费';
            case RADIUS_REQUEST_STATUS.ACK:
                return 'ACK';
            case RADIUS_REQUEST_STATUS.NAK:
                return 'NAK';
            case RADIUS_REQUEST_STATUS.IGNORED:
                return '已忽略';
            case RADIUS_REQUEST_STATUS.ERROR:
                return '错误';
            default:
                return status || '-';
        }
    };

    const clientText = record => {
        if (!record.clientAddress) {
            return '-';
        }
        return record.clientPort ? `${record.clientAddress}:${record.clientPort}` : record.clientAddress;
    };

    const showDetail = record => {
        selectedRequest.value = record;
        detailDrawerTitle.value = `RADIUS请求详情: ${record.codeName || '-'} #${record.identifier ?? '-'}`;
        detailDrawerVisible.value = true;
    };

    const closeDetailDrawer = () => {
        detailDrawerVisible.value = false;
        selectedRequest.value = null;
    };

    const loadRequestList = async () => {
        try {
            loading.value = true;
            const result = await window.radiusApi.getRequestList();
            if (result.status === 'success') {
                requestList.value = result.data || [];
            } else {
                notify.error(result.msg || '获取RADIUS请求日志失败');
            }
        } catch (error) {
            notify.error('获取RADIUS请求日志失败: ' + error.message);
        } finally {
            loading.value = false;
        }
    };

    const clearHistory = async () => {
        try {
            clearLoading.value = true;
            const result = await window.radiusApi.clearRequestHistory();
            if (result.status === 'success') {
                requestList.value = [];
                notify.success(result.msg || 'RADIUS请求日志已清空');
            } else {
                notify.error(result.msg || '清空RADIUS请求日志失败');
            }
        } catch (error) {
            notify.error('清空RADIUS请求日志失败: ' + error.message);
        } finally {
            clearLoading.value = false;
        }
    };

    const handleRadiusEvent = respData => {
        if (respData.status !== 'success') {
            return;
        }
        const payload = respData.data;
        if (payload.type === RADIUS_SUB_EVT_TYPES.REQUEST_RECEIVED) {
            requestList.value = [payload.data, ...requestList.value.filter(item => item.id !== payload.data.id)];
        } else if (payload.type === RADIUS_SUB_EVT_TYPES.HISTORY_CLEARED) {
            requestList.value = [];
            closeDetailDrawer();
        } else if (payload.type === RADIUS_SUB_EVT_TYPES.SERVER_STATUS && payload.data.status === 'stopped') {
            requestList.value = [];
            closeDetailDrawer();
        }
    };

    onActivated(async () => {
        EventBus.on('radius:event', RADIUS_EVENT_PAGE_ID.PAGE_ID_RADIUS_REQUEST_LOG, handleRadiusEvent);
        await loadRequestList();
    });

    onDeactivated(() => {
        EventBus.off('radius:event', RADIUS_EVENT_PAGE_ID.PAGE_ID_RADIUS_REQUEST_LOG);
    });
</script>

<style scoped>
    .radius-table-page {
        height: calc(100vh - 70px);
        min-height: 0;
        overflow: hidden;
    }

    .radius-table-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .radius-table-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        min-width: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .radius-table,
    .radius-table :deep(.nn-spin-nested-loading),
    .radius-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
    }

    .radius-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .radius-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .radius-table :deep(.nn-table-container),
    .radius-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .radius-table :deep(.nn-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .radius-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .single-line-text {
        display: inline-block;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        vertical-align: bottom;
        white-space: nowrap;
    }

    .detail-section-title {
        margin: 10px 0 6px;
        color: var(--nn-color-text-secondary);
        font-weight: 600;
    }

    .detail-section {
        margin-top: 12px;
    }

    .detail-attribute-table :deep(.nn-table-body),
    .detail-attribute-table :deep(.nn-table-content) {
        overflow: auto !important;
    }

    .detail-attribute-table :deep(.nn-table-cell) {
        white-space: normal !important;
    }
</style>
