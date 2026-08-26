<template>
    <div class="nn-container adaptive-table-page">
        <nn-card title="gRPC消息日志" class="adaptive-table-card">
            <template #extra>
                <nn-space wrap>
                    <nn-select
                        v-model:value="filters.role"
                        style="width: 120px"
                        allow-clear
                        placeholder="角色"
                        @change="() => loadMessageList(1)"
                    >
                        <nn-select-option value="server">服务端</nn-select-option>
                        <nn-select-option value="client">客户端</nn-select-option>
                    </nn-select>
                    <nn-select
                        v-model:value="filters.direction"
                        style="width: 120px"
                        allow-clear
                        placeholder="方向"
                        @change="() => loadMessageList(1)"
                    >
                        <nn-select-option value="inbound">接收</nn-select-option>
                        <nn-select-option value="outbound">发送</nn-select-option>
                    </nn-select>
                    <nn-input-search
                        v-model:value="filters.keyword"
                        placeholder="方法 / 对端 / 内容"
                        allow-clear
                        style="width: 220px"
                        @search="() => loadMessageList(1)"
                    />
                    <nn-button :loading="loading" @click="() => loadMessageList()">刷新</nn-button>
                    <nn-button
                        danger
                        data-testid="clear-grpc-message-history"
                        :loading="clearLoading"
                        @click="clearHistory"
                    >
                        清空历史
                    </nn-button>
                </nn-space>
            </template>

            <nn-table
                :columns="columns"
                :data-source="messageList"
                :loading="loading"
                :pagination="tablePagination"
                :scroll="{ x: 'max-content', y: '100%' }"
                row-key="id"
                size="small"
                class="adaptive-table"
                @change="handleTableChange"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'roleDirection'">
                        <nn-space>
                            <nn-tag>{{ record.role === 'server' ? '服务端' : '客户端' }}</nn-tag>
                            <nn-tag :color="record.direction === 'inbound' ? 'green' : 'blue'">
                                {{ record.direction === 'inbound' ? '接收' : '发送' }}
                            </nn-tag>
                        </nn-space>
                    </template>
                    <template v-else-if="column.key === 'kind'">
                        <nn-tag :color="methodKindColor(record.kind)">{{ methodKindLabel(record.kind) }}</nn-tag>
                    </template>
                    <template v-else-if="column.key === 'status'">
                        <nn-tag :color="messageStatusColor(record.status)">
                            {{ messageStatusText(record.status) }}
                        </nn-tag>
                    </template>
                    <template v-else-if="column.key === 'stream'">
                        {{
                            record.streamId ? `流 #${record.streamId}` : record.callId ? `调用 #${record.callId}` : '-'
                        }}
                    </template>
                    <template v-else-if="column.key === 'summary'">
                        <nn-tooltip :title="record.summary">
                            <span class="message-cell">{{ record.summary || '-' }}</span>
                        </nn-tooltip>
                    </template>
                    <template v-else-if="column.key === 'action'">
                        <nn-button type="link" @click="showDetail(record)">详情</nn-button>
                    </template>
                </template>
            </nn-table>
        </nn-card>

        <nn-drawer
            v-model:open="detailDrawerVisible"
            :title="detailDrawerTitle"
            width="760px"
            placement="right"
            @close="closeDetailDrawer"
        >
            <nn-spin :spinning="detailLoading">
                <nn-empty v-if="!selectedMessage" description="暂无详情" />
                <template v-else>
                    <nn-descriptions title="消息摘要" :column="1" bordered size="small">
                        <nn-descriptions-item label="时间">{{ selectedMessage.timestamp || '-' }}</nn-descriptions-item>
                        <nn-descriptions-item label="角色/方向">
                            {{ selectedMessage.role === 'server' ? '服务端' : '客户端' }} /
                            {{ selectedMessage.direction === 'inbound' ? '接收' : '发送' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="对端">{{ selectedMessage.peer || '-' }}</nn-descriptions-item>
                        <nn-descriptions-item label="方法">{{ selectedMessage.fullName || '-' }}</nn-descriptions-item>
                        <nn-descriptions-item label="调用类型">
                            {{ methodKindLabel(selectedMessage.kind) }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="消息类型">
                            {{ selectedMessage.typeName || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="流 / 调用">
                            {{
                                selectedMessage.streamId
                                    ? `流 #${selectedMessage.streamId}`
                                    : selectedMessage.callId
                                      ? `调用 #${selectedMessage.callId}`
                                      : '-'
                            }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="字节长度">
                            {{ selectedMessage.byteLength ?? '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="状态">
                            <nn-tag :color="messageStatusColor(selectedMessage.status)">
                                {{ messageStatusText(selectedMessage.status) }}
                            </nn-tag>
                        </nn-descriptions-item>
                        <nn-descriptions-item v-if="selectedMessage.error" label="错误">
                            {{ selectedMessage.error }}
                        </nn-descriptions-item>
                        <nn-descriptions-item v-if="selectedMessage.metadata" label="请求 Metadata">
                            <pre class="detail-pre">{{ formatJson(selectedMessage.metadata) }}</pre>
                        </nn-descriptions-item>
                    </nn-descriptions>

                    <nn-alert
                        v-for="(warning, index) in selectedMessage.warnings || []"
                        :key="index"
                        type="warning"
                        show-icon
                        :message="warning"
                        class="detail-section"
                    />

                    <div class="detail-section">
                        <div class="detail-title">解码内容</div>
                        <nn-json-viewer :value="selectedMessage.decoded || {}" :max-height="420" wrap />
                    </div>

                    <div class="detail-section">
                        <div class="detail-title">原始字节 (hex)</div>
                        <pre class="detail-pre">{{ selectedMessage.rawHex || '-' }}</pre>
                    </div>
                </template>
            </nn-spin>
        </nn-drawer>
    </div>
</template>

<script setup>
    import { computed, ref, onActivated, onBeforeUnmount, onDeactivated, onMounted } from 'vue';
    import { notify } from '../../utils/notify';
    import { GRPC_SUB_EVT_TYPES, GRPC_EVENT_PAGE_ID } from '../../const/grpcConst';
    import EventBus from '../../utils/eventBus';
    import { formatJson, messageStatusColor, messageStatusText, methodKindColor, methodKindLabel } from './grpcUtils';

    defineOptions({ name: 'GrpcMessageLog' });

    const loading = ref(false);
    const clearLoading = ref(false);
    const detailLoading = ref(false);
    const messageList = ref([]);
    const filters = ref({ role: undefined, direction: undefined, keyword: '' });
    const pagination = ref({ current: 1, pageSize: 20, total: 0 });
    const detailDrawerVisible = ref(false);
    const selectedMessage = ref(null);
    const selectedMessageId = ref(null);
    const detailDrawerTitle = computed(() =>
        selectedMessageId.value ? `gRPC消息详情 #${selectedMessageId.value}` : 'gRPC消息详情'
    );
    const tablePagination = computed(() => ({
        current: pagination.value.current,
        pageSize: pagination.value.pageSize,
        total: pagination.value.total,
        showSizeChanger: true,
        pageSizeOptions: ['10', '20', '50', '100'],
        position: ['bottomCenter'],
        showTotal: total => '共 ' + total + ' 条'
    }));

    const columns = [
        { title: 'ID', dataIndex: 'id', key: 'id', width: 70 },
        { title: '时间', dataIndex: 'timestamp', key: 'timestamp', width: 170 },
        { title: '角色/方向', key: 'roleDirection', width: 150 },
        { title: '对端', dataIndex: 'peer', key: 'peer', width: 170 },
        { title: '方法', dataIndex: 'fullName', key: 'fullName', width: 260, ellipsis: true },
        { title: '类型', key: 'kind', width: 120 },
        { title: '流/调用', key: 'stream', width: 100 },
        { title: '状态', key: 'status', width: 100 },
        { title: '摘要', key: 'summary', width: 360, ellipsis: true },
        { title: '操作', key: 'action', width: 80, fixed: 'right', align: 'center' }
    ];

    const hasFilter = () => Boolean(filters.value.role || filters.value.direction || filters.value.keyword);

    const loadMessageList = async (page = pagination.value.current, pageSize = pagination.value.pageSize) => {
        try {
            loading.value = true;
            const result = await window.grpcApi.getMessageList({
                page,
                pageSize,
                role: filters.value.role || '',
                direction: filters.value.direction || '',
                keyword: filters.value.keyword || ''
            });
            if (result.status === 'success') {
                const payload = result.data || {};
                messageList.value = payload.list || [];
                pagination.value = {
                    current: payload.page || page,
                    pageSize: payload.pageSize || pageSize,
                    total: payload.total || 0
                };
            } else {
                notify.error(result.msg || '获取gRPC消息日志失败');
            }
        } catch (error) {
            notify.error('获取gRPC消息日志失败: ' + error.message);
        } finally {
            loading.value = false;
        }
    };

    const handleTableChange = pageInfo => {
        loadMessageList(pageInfo.current, pageInfo.pageSize);
    };

    const clearHistory = async () => {
        try {
            clearLoading.value = true;
            const result = await window.grpcApi.clearMessageHistory();
            if (result.status === 'success') {
                messageList.value = [];
                pagination.value = { ...pagination.value, current: 1, total: 0 };
                closeDetailDrawer();
                notify.success(result.msg || 'gRPC消息记录已清空');
            } else {
                notify.error(result.msg || '清空gRPC消息记录失败');
            }
        } catch (error) {
            notify.error('清空gRPC消息记录失败: ' + error.message);
        } finally {
            clearLoading.value = false;
        }
    };

    const showDetail = async record => {
        selectedMessageId.value = record.id;
        selectedMessage.value = null;
        detailDrawerVisible.value = true;
        detailLoading.value = true;
        try {
            const result = await window.grpcApi.getMessageDetail(record.id);
            if (result.status === 'success') {
                selectedMessage.value = result.data;
            } else {
                notify.error(result.msg || '获取gRPC消息详情失败');
            }
        } catch (error) {
            notify.error('获取gRPC消息详情失败: ' + error.message);
        } finally {
            detailLoading.value = false;
        }
    };

    const closeDetailDrawer = () => {
        detailDrawerVisible.value = false;
        selectedMessage.value = null;
        selectedMessageId.value = null;
        detailLoading.value = false;
    };

    const handleGrpcEvent = respData => {
        if (respData.status !== 'success') {
            return;
        }
        const payload = respData.data;
        if (payload.type === GRPC_SUB_EVT_TYPES.MESSAGE_RECEIVED && payload.data) {
            if (hasFilter()) {
                return;
            }
            pagination.value.total = Number.isFinite(Number(payload.stats?.messageCount))
                ? Number(payload.stats.messageCount)
                : pagination.value.total + 1;
            if (pagination.value.current === 1) {
                const others = messageList.value.filter(item => item.id !== payload.data.id);
                messageList.value = [payload.data, ...others].slice(0, pagination.value.pageSize);
            }
        } else if (payload.type === GRPC_SUB_EVT_TYPES.HISTORY_CLEARED) {
            messageList.value = [];
            pagination.value = { ...pagination.value, current: 1, total: 0 };
            closeDetailDrawer();
        } else if (payload.type === GRPC_SUB_EVT_TYPES.SERVER_STATUS && payload.data?.status === 'stopped') {
            messageList.value = [];
            pagination.value = { ...pagination.value, current: 1, total: 0 };
            closeDetailDrawer();
        }
    };

    let pageActive = false;

    const activatePage = async () => {
        if (pageActive) {
            return;
        }
        pageActive = true;
        EventBus.on('grpc:event', GRPC_EVENT_PAGE_ID.PAGE_ID_GRPC_MESSAGE_LOG, handleGrpcEvent);
        await loadMessageList();
    };

    const deactivatePage = () => {
        if (!pageActive) {
            return;
        }
        pageActive = false;
        EventBus.off('grpc:event', GRPC_EVENT_PAGE_ID.PAGE_ID_GRPC_MESSAGE_LOG);
    };

    onMounted(activatePage);
    onActivated(activatePage);
    onDeactivated(deactivatePage);
    onBeforeUnmount(deactivatePage);
</script>

<style scoped>
    .adaptive-table-page {
        height: 100%;
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

    .message-cell {
        display: inline-block;
        max-width: 340px;
        overflow: hidden;
        text-overflow: ellipsis;
        vertical-align: bottom;
        white-space: nowrap;
    }

    .detail-section {
        margin-top: 16px;
    }

    .detail-title {
        margin-bottom: 8px;
        font-weight: 600;
        color: var(--nn-color-text-muted);
    }

    .detail-pre {
        max-height: 260px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-all;
    }
</style>
