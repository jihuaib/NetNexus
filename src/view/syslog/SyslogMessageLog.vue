<template>
    <div class="mt-container adaptive-table-page">
        <a-card title="Syslog消息日志" class="adaptive-table-card">
            <template #extra>
                <a-space>
                    <a-button :loading="loading" @click="() => loadMessageList()">刷新</a-button>
                    <a-button danger :loading="clearLoading" @click="clearHistory">清空历史</a-button>
                </a-space>
            </template>

            <a-table
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
                        <a-tag :color="statusColor(record.status)">
                            {{ statusText(record.status) }}
                        </a-tag>
                    </template>
                    <template v-else-if="column.key === 'severityName'">
                        <a-tag :color="severityColor(record.severityName)">
                            {{ record.severityName || '-' }}
                        </a-tag>
                    </template>
                    <template v-else-if="column.key === 'format'">
                        <a-tag :color="record.format === 'RAW' ? 'default' : 'blue'">
                            {{ record.format || '-' }}
                        </a-tag>
                    </template>
                    <template v-else-if="column.key === 'transportFormat'">
                        <a-space>
                            <a-tag>{{ record.transport || '-' }}</a-tag>
                            <a-tag :color="record.format === 'RAW' ? 'default' : 'blue'">
                                {{ record.format || '-' }}
                            </a-tag>
                        </a-space>
                    </template>
                    <template v-else-if="column.key === 'client'">
                        {{ record.clientAddress }}:{{ record.clientPort }}
                    </template>
                    <template v-else-if="column.key === 'summary'">
                        <a-tooltip :title="record.summary">
                            <span class="message-cell">{{ record.summary || '-' }}</span>
                        </a-tooltip>
                    </template>
                    <template v-else-if="column.key === 'action'">
                        <a-button type="link" @click="showDetail(record)">详情</a-button>
                    </template>
                </template>
            </a-table>
        </a-card>

        <a-drawer
            v-model:open="detailDrawerVisible"
            :title="detailDrawerTitle"
            width="720px"
            placement="right"
            @close="closeDetailDrawer"
        >
            <a-spin :spinning="detailLoading">
                <a-empty v-if="!selectedMessage" description="暂无详情" />
                <template v-else>
                    <a-descriptions title="接收摘要" :column="1" bordered size="small">
                        <a-descriptions-item label="接收时间">
                            {{ selectedMessage.timestamp || '-' }}
                        </a-descriptions-item>
                        <a-descriptions-item label="客户端">
                            {{ selectedMessage.clientAddress || '-' }}:{{ selectedMessage.clientPort || '-' }}
                        </a-descriptions-item>
                        <a-descriptions-item label="传输协议">
                            {{ selectedMessage.transport || '-' }}
                        </a-descriptions-item>
                        <a-descriptions-item label="IP版本">{{ selectedMessage.ipVersion || '-' }}</a-descriptions-item>
                        <a-descriptions-item label="字节长度">
                            {{ selectedMessage.byteLength ?? '-' }}
                        </a-descriptions-item>
                        <a-descriptions-item label="状态">
                            <a-tag :color="statusColor(selectedMessage.status)">
                                {{ statusText(selectedMessage.status) }}
                            </a-tag>
                        </a-descriptions-item>
                        <a-descriptions-item label="解析说明">{{ selectedMessage.note || '-' }}</a-descriptions-item>
                    </a-descriptions>

                    <a-descriptions title="Syslog字段" :column="1" bordered size="small" class="detail-section">
                        <a-descriptions-item label="格式">{{ selectedMessage.format || '-' }}</a-descriptions-item>
                        <a-descriptions-item label="PRI">{{ selectedMessage.priority ?? '-' }}</a-descriptions-item>
                        <a-descriptions-item label="Facility">
                            {{ selectedMessage.facilityName || '-' }} ({{ selectedMessage.facilityCode ?? '-' }})
                        </a-descriptions-item>
                        <a-descriptions-item label="Severity">
                            <a-tag :color="severityColor(selectedMessage.severityName)">
                                {{ selectedMessage.severityName || '-' }}
                            </a-tag>
                            <span>({{ selectedMessage.severityCode ?? '-' }})</span>
                        </a-descriptions-item>
                        <a-descriptions-item label="报文时间">
                            {{ selectedMessage.syslogTimestamp || '-' }}
                        </a-descriptions-item>
                        <a-descriptions-item label="主机名">{{ selectedMessage.hostname || '-' }}</a-descriptions-item>
                        <a-descriptions-item label="应用">{{ selectedMessage.appName || '-' }}</a-descriptions-item>
                        <a-descriptions-item label="进程ID">{{ selectedMessage.procId || '-' }}</a-descriptions-item>
                        <a-descriptions-item label="MsgID">{{ selectedMessage.msgId || '-' }}</a-descriptions-item>
                        <a-descriptions-item label="Tag">{{ selectedMessage.tag || '-' }}</a-descriptions-item>
                        <a-descriptions-item label="结构化数据">
                            <pre class="detail-pre">{{ selectedMessage.structuredData || '-' }}</pre>
                        </a-descriptions-item>
                        <a-descriptions-item label="解析错误">
                            {{ selectedMessage.parseError || '-' }}
                        </a-descriptions-item>
                    </a-descriptions>

                    <div class="detail-section">
                        <div class="detail-title">消息内容</div>
                        <pre class="detail-pre">{{ selectedMessage.message || '-' }}</pre>
                    </div>

                    <div class="detail-section">
                        <div class="detail-title">原始报文</div>
                        <pre class="detail-pre">{{ selectedMessage.rawMessage || '-' }}</pre>
                    </div>
                </template>
            </a-spin>
        </a-drawer>
    </div>
</template>

<script setup>
    import { computed, ref, onActivated, onDeactivated } from 'vue';
    import { message } from 'ant-design-vue';
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
                message.error(result.msg || '获取Syslog消息日志失败');
            }
        } catch (error) {
            message.error('获取Syslog消息日志失败: ' + error.message);
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
                message.success(result.msg || 'Syslog消息日志已清空');
            } else {
                message.error(result.msg || '清空Syslog消息日志失败');
            }
        } catch (error) {
            message.error('清空Syslog消息日志失败: ' + error.message);
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
                message.error(result.msg || '获取Syslog消息详情失败');
            }
        } catch (error) {
            message.error('获取Syslog消息详情失败: ' + error.message);
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

    .adaptive-table-card :deep(.ant-card-body) {
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
        color: rgba(0, 0, 0, 0.45);
    }

    .detail-pre {
        max-height: 260px;
        margin: 0;
        padding: 8px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        background: #f5f5f5;
        border: 1px solid #f0f0f0;
        border-radius: 4px;
    }
</style>
