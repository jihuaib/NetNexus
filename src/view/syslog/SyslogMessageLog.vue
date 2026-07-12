<template>
    <div class="nn-container adaptive-table-page">
        <nn-card title="Syslog消息日志" class="adaptive-table-card">
            <template #extra>
                <nn-space>
                    <nn-button :loading="loading" @click="() => loadMessageList()">刷新</nn-button>
                    <nn-button danger :loading="clearLoading" @click="clearHistory">清空历史</nn-button>
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
                    <template v-if="column.key === 'status'">
                        <nn-tag :color="statusColor(record.status)">
                            {{ statusText(record.status) }}
                        </nn-tag>
                    </template>
                    <template v-else-if="column.key === 'severityName'">
                        <nn-tag :color="severityColor(record.severityName)">
                            {{ record.severityName || '-' }}
                        </nn-tag>
                    </template>
                    <template v-else-if="column.key === 'format'">
                        <nn-tag :color="record.format === 'RAW' ? 'default' : 'blue'">
                            {{ record.format || '-' }}
                        </nn-tag>
                    </template>
                    <template v-else-if="column.key === 'transportFormat'">
                        <nn-space>
                            <nn-tag>{{ record.transport || '-' }}</nn-tag>
                            <nn-tag :color="record.format === 'RAW' ? 'default' : 'blue'">
                                {{ record.format || '-' }}
                            </nn-tag>
                        </nn-space>
                    </template>
                    <template v-else-if="column.key === 'client'">
                        {{ record.clientAddress }}:{{ record.clientPort }}
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
            width="720px"
            placement="right"
            @close="closeDetailDrawer"
        >
            <nn-spin :spinning="detailLoading">
                <nn-empty v-if="!selectedMessage" description="暂无详情" />
                <template v-else>
                    <nn-descriptions title="接收摘要" :column="1" bordered size="small">
                        <nn-descriptions-item label="接收时间">
                            {{ selectedMessage.timestamp || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="客户端">
                            {{ selectedMessage.clientAddress || '-' }}:{{ selectedMessage.clientPort || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="传输协议">
                            {{ selectedMessage.transport || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="IP版本">
                            {{ selectedMessage.ipVersion || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="字节长度">
                            {{ selectedMessage.byteLength ?? '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="状态">
                            <nn-tag :color="statusColor(selectedMessage.status)">
                                {{ statusText(selectedMessage.status) }}
                            </nn-tag>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="解析说明">{{ selectedMessage.note || '-' }}</nn-descriptions-item>
                    </nn-descriptions>

                    <nn-descriptions title="Syslog字段" :column="1" bordered size="small" class="detail-section">
                        <nn-descriptions-item label="格式">{{ selectedMessage.format || '-' }}</nn-descriptions-item>
                        <nn-descriptions-item label="PRI">{{ selectedMessage.priority ?? '-' }}</nn-descriptions-item>
                        <nn-descriptions-item label="Facility">
                            {{ selectedMessage.facilityName || '-' }} ({{ selectedMessage.facilityCode ?? '-' }})
                        </nn-descriptions-item>
                        <nn-descriptions-item label="Severity">
                            <nn-tag :color="severityColor(selectedMessage.severityName)">
                                {{ selectedMessage.severityName || '-' }}
                            </nn-tag>
                            <span>({{ selectedMessage.severityCode ?? '-' }})</span>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="报文时间">
                            {{ selectedMessage.syslogTimestamp || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="主机名">
                            {{ selectedMessage.hostname || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="应用">{{ selectedMessage.appName || '-' }}</nn-descriptions-item>
                        <nn-descriptions-item label="进程ID">{{ selectedMessage.procId || '-' }}</nn-descriptions-item>
                        <nn-descriptions-item label="MsgID">{{ selectedMessage.msgId || '-' }}</nn-descriptions-item>
                        <nn-descriptions-item label="Tag">{{ selectedMessage.tag || '-' }}</nn-descriptions-item>
                        <nn-descriptions-item label="结构化数据">
                            <pre class="detail-pre">{{ selectedMessage.structuredData || '-' }}</pre>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="解析错误">
                            {{ selectedMessage.parseError || '-' }}
                        </nn-descriptions-item>
                    </nn-descriptions>

                    <div class="detail-section">
                        <div class="detail-title">消息内容</div>
                        <pre class="detail-pre">{{ selectedMessage.message || '-' }}</pre>
                    </div>

                    <div class="detail-section">
                        <div class="detail-title">原始报文</div>
                        <pre class="detail-pre">{{ selectedMessage.rawMessage || '-' }}</pre>
                    </div>
                </template>
            </nn-spin>
        </nn-drawer>
    </div>
</template>

<script setup>
    import { computed, ref, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import {
        SYSLOG_SUB_EVT_TYPES,
        SYSLOG_EVENT_PAGE_ID,
        SYSLOG_MESSAGE_STATUS,
        SYSLOG_SEVERITY
    } from '../../const/syslogConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'SyslogMessageLog' });

    const loading = ref(false);
    const clearLoading = ref(false);
    const detailLoading = ref(false);
    const messageList = ref([]);
    const pagination = ref({
        current: 1,
        pageSize: 20,
        total: 0
    });
    const detailDrawerVisible = ref(false);
    const selectedMessage = ref(null);
    const selectedMessageId = ref(null);
    const detailDrawerTitle = computed(() =>
        selectedMessageId.value ? `Syslog消息详情 #${selectedMessageId.value}` : 'Syslog消息详情'
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
        { title: '接收时间', dataIndex: 'timestamp', key: 'timestamp', width: 190 },
        { title: '客户端', key: 'client', width: 180 },
        { title: '协议/格式', key: 'transportFormat', width: 150 },
        { title: 'Severity', dataIndex: 'severityName', key: 'severityName', width: 110 },
        { title: '状态', dataIndex: 'status', key: 'status', width: 100 },
        { title: '消息摘要', dataIndex: 'summary', key: 'summary', width: 360, ellipsis: true },
        { title: '操作', key: 'action', width: 90, fixed: 'right', align: 'center' }
    ];

    const statusColor = status => {
        switch (status) {
            case SYSLOG_MESSAGE_STATUS.RECEIVED:
                return 'success';
            case SYSLOG_MESSAGE_STATUS.TRUNCATED:
                return 'warning';
            case SYSLOG_MESSAGE_STATUS.INVALID:
                return 'default';
            case SYSLOG_MESSAGE_STATUS.ERROR:
                return 'error';
            default:
                return 'default';
        }
    };

    const statusText = status => {
        switch (status) {
            case SYSLOG_MESSAGE_STATUS.RECEIVED:
                return '已接收';
            case SYSLOG_MESSAGE_STATUS.TRUNCATED:
                return '已截断';
            case SYSLOG_MESSAGE_STATUS.INVALID:
                return '格式异常';
            case SYSLOG_MESSAGE_STATUS.ERROR:
                return '错误';
            default:
                return status || '-';
        }
    };

    const severityColor = severity => {
        switch (severity) {
            case SYSLOG_SEVERITY.EMERGENCY:
            case SYSLOG_SEVERITY.ALERT:
            case SYSLOG_SEVERITY.CRITICAL:
            case SYSLOG_SEVERITY.ERROR:
                return 'error';
            case SYSLOG_SEVERITY.WARNING:
                return 'warning';
            case SYSLOG_SEVERITY.NOTICE:
                return 'purple';
            case SYSLOG_SEVERITY.INFO:
                return 'processing';
            case SYSLOG_SEVERITY.DEBUG:
                return 'default';
            default:
                return 'default';
        }
    };

    const loadMessageList = async (page = pagination.value.current, pageSize = pagination.value.pageSize) => {
        try {
            loading.value = true;
            const result = await window.syslogApi.getMessageList({ page, pageSize });
            if (result.status === 'success') {
                const payload = result.data || {};
                messageList.value = payload.list || [];
                pagination.value = {
                    current: payload.page || page,
                    pageSize: payload.pageSize || pageSize,
                    total: payload.total || 0
                };
            } else {
                notify.error(result.msg || '获取Syslog消息日志失败');
            }
        } catch (error) {
            notify.error('获取Syslog消息日志失败: ' + error.message);
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
            const result = await window.syslogApi.clearMessageHistory();
            if (result.status === 'success') {
                messageList.value = [];
                pagination.value = {
                    ...pagination.value,
                    current: 1,
                    total: 0
                };
                closeDetailDrawer();
                notify.success(result.msg || 'Syslog消息日志已清空');
            } else {
                notify.error(result.msg || '清空Syslog消息日志失败');
            }
        } catch (error) {
            notify.error('清空Syslog消息日志失败: ' + error.message);
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
            const result = await window.syslogApi.getMessageDetail(record.id);
            if (result.status === 'success') {
                selectedMessage.value = result.data;
            } else {
                notify.error(result.msg || '获取Syslog消息详情失败');
            }
        } catch (error) {
            notify.error('获取Syslog消息详情失败: ' + error.message);
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

    const handleSyslogEvent = respData => {
        if (respData.status !== 'success') {
            return;
        }

        const payload = respData.data;
        if (payload.type === SYSLOG_SUB_EVT_TYPES.MESSAGE_RECEIVED) {
            pagination.value.total += 1;
            if (pagination.value.current === 1) {
                const others = messageList.value.filter(item => item.id !== payload.data.id);
                messageList.value = [payload.data, ...others].slice(0, pagination.value.pageSize);
            }
        } else if (payload.type === SYSLOG_SUB_EVT_TYPES.HISTORY_CLEARED) {
            messageList.value = [];
            pagination.value = {
                ...pagination.value,
                current: 1,
                total: 0
            };
            closeDetailDrawer();
        } else if (payload.type === SYSLOG_SUB_EVT_TYPES.SERVER_STATUS && payload.data.status === 'stopped') {
            messageList.value = [];
            pagination.value = {
                ...pagination.value,
                current: 1,
                total: 0
            };
            closeDetailDrawer();
        }
    };

    onActivated(async () => {
        EventBus.on('syslog:event', SYSLOG_EVENT_PAGE_ID.PAGE_ID_SYSLOG_MESSAGE_LOG, handleSyslogEvent);
        await loadMessageList();
    });

    onDeactivated(() => {
        EventBus.off('syslog:event', SYSLOG_EVENT_PAGE_ID.PAGE_ID_SYSLOG_MESSAGE_LOG);
    });
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
    }
</style>
