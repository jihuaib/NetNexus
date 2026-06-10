<template>
    <div class="mt-container snmp-query-page">
        <a-card title="SNMP 查询监控" class="query-card">
            <template #extra>
                <a-button danger :loading="clearLoading" @click="clearHistory">
                    <template #icon><DeleteOutlined /></template>
                    清空历史
                </a-button>
            </template>

            <a-row :gutter="16" class="stats-row">
                <a-col :span="6">
                    <a-statistic title="总接收数量" :value="totalQueries" prefix="#" />
                </a-col>
                <a-col :span="6">
                    <a-statistic title="今日接收" :value="todayQueries" prefix="#" />
                </a-col>
                <a-col :span="6">
                    <a-statistic title="最近1小时" :value="recentQueries" prefix="#" />
                </a-col>
                <a-col :span="6">
                    <a-statistic title="来源地址" :value="sourceCount" prefix="#" />
                </a-col>
            </a-row>

            <a-row :gutter="16" class="filter-row">
                <a-col :span="6">
                    <a-select
                        v-model:value="filters.operation"
                        placeholder="操作类型"
                        allow-clear
                        style="width: 100%"
                        @change="handleFilterChange"
                    >
                        <a-select-option value="GET">GET</a-select-option>
                        <a-select-option value="GETNEXT">GETNEXT</a-select-option>
                        <a-select-option value="GETBULK">GETBULK</a-select-option>
                        <a-select-option value="SET">SET</a-select-option>
                    </a-select>
                </a-col>
                <a-col :span="6">
                    <a-input
                        v-model:value="filters.sourceIp"
                        placeholder="源IP地址"
                        allow-clear
                        @change="handleFilterChange"
                    />
                </a-col>
                <a-col :span="6">
                    <a-input
                        v-model:value="filters.community"
                        placeholder="Community"
                        allow-clear
                        @change="handleFilterChange"
                    />
                </a-col>
                <a-col :span="6">
                    <a-range-picker
                        v-model:value="filters.timeRange"
                        show-time
                        format="YYYY-MM-DD HH:mm:ss"
                        style="width: 100%"
                        @change="handleFilterChange"
                    />
                </a-col>
            </a-row>

            <a-table
                :columns="columns"
                :data-source="queries"
                :loading="loading"
                :pagination="pagination"
                :scroll="{ x: 1180, y: 'calc(100vh - 350px)' }"
                row-key="id"
                class="mt-margin-top-10 query-list-table"
                @change="handleTableChange"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'operation'">
                        <a-tag :color="getOperationColor(record.operation)">
                            {{ record.operation }}
                        </a-tag>
                    </template>
                    <template v-else-if="column.key === 'version'">
                        <a-tag color="blue">{{ String(record.version || '').toUpperCase() }}</a-tag>
                    </template>
                    <template v-else-if="column.key === 'timestamp'">
                        {{ formatTimestamp(record.timestamp) }}
                    </template>
                    <template v-else-if="column.key === 'action'">
                        <a-button type="link" size="small" @click="showQueryDetail(record)">
                            <template #icon><EyeOutlined /></template>
                            详情
                        </a-button>
                    </template>
                </template>
            </a-table>
        </a-card>

        <a-modal
            v-model:open="detailModalVisible"
            title="查询详情"
            :footer="null"
            class="modal-xlarge query-detail-modal"
        >
            <div v-if="selectedQuery" class="query-detail">
                <div class="query-detail-section-title">基本信息</div>
                <a-descriptions :column="2" bordered size="small">
                    <a-descriptions-item label="查询ID">{{ selectedQuery.id }}</a-descriptions-item>
                    <a-descriptions-item label="接收时间">
                        {{ formatTimestamp(selectedQuery.timestamp) }}
                    </a-descriptions-item>
                    <a-descriptions-item label="源IP地址">{{ selectedQuery.sourceIp }}</a-descriptions-item>
                    <a-descriptions-item label="源端口">{{ selectedQuery.sourcePort }}</a-descriptions-item>
                    <a-descriptions-item label="操作类型">
                        <a-tag :color="getOperationColor(selectedQuery.operation)">
                            {{ selectedQuery.operation }}
                        </a-tag>
                    </a-descriptions-item>
                    <a-descriptions-item label="SNMP版本">
                        {{ String(selectedQuery.version || '').toUpperCase() }}
                    </a-descriptions-item>
                    <a-descriptions-item v-if="selectedQuery.community" label="Community">
                        {{ selectedQuery.community }}
                    </a-descriptions-item>
                    <a-descriptions-item v-if="selectedQuery.user" label="用户">
                        {{ selectedQuery.user }}
                    </a-descriptions-item>
                    <a-descriptions-item label="Request ID">{{ selectedQuery.requestId }}</a-descriptions-item>
                    <a-descriptions-item label="变量数量">{{ selectedQuery.varbindCount }}</a-descriptions-item>
                    <a-descriptions-item v-if="selectedQuery.nonRepeaters !== undefined" label="Non repeaters">
                        {{ selectedQuery.nonRepeaters }}
                    </a-descriptions-item>
                    <a-descriptions-item v-if="selectedQuery.maxRepetitions !== undefined" label="Max repetitions">
                        {{ selectedQuery.maxRepetitions }}
                    </a-descriptions-item>
                </a-descriptions>

                <div class="query-detail-section-title">变量绑定 (Variable Bindings)</div>
                <a-table
                    :columns="varbindColumns"
                    :data-source="selectedQuery.varbinds || []"
                    size="small"
                    row-key="oid"
                    class="varbind-detail-table"
                    :pagination="false"
                    :scroll="{ x: 900, y: 200 }"
                >
                    <template #bodyCell="{ column, record }">
                        <template v-if="column.key === 'value'">
                            <div class="varbind-value">
                                <a-typography-text copyable>{{ record.value }}</a-typography-text>
                                <div v-if="record.valueName" class="varbind-value-name">
                                    {{ record.valueName }}
                                </div>
                            </div>
                        </template>
                    </template>
                </a-table>
            </div>
        </a-modal>
    </div>
</template>

<script setup>
    import { ref, reactive, onActivated, onDeactivated } from 'vue';
    import { message } from 'ant-design-vue';
    import { DeleteOutlined, EyeOutlined } from '@ant-design/icons-vue';
    import { SNMP_SUB_EVT_TYPES, SNMP_EVENT_PAGE_ID } from '../../const/snmpConst';
    import dayjs from 'dayjs';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'SnmpQuery' });

    const loading = ref(false);
    const clearLoading = ref(false);
    const detailModalVisible = ref(false);
    const selectedQuery = ref(null);
    const queries = ref([]);
    const totalQueries = ref(0);
    const todayQueries = ref(0);
    const recentQueries = ref(0);
    const sourceCount = ref(0);
    const QUERY_LIST_REFRESH_INTERVAL_MS = 1000;
    let queryListLoading = false;
    let queryListRefreshTimer = null;
    let lastQueryListRefreshAt = 0;
    let pendingQueryListRefresh = false;

    const filters = reactive({
        operation: null,
        sourceIp: '',
        community: '',
        timeRange: null
    });

    const pagination = reactive({
        current: 1,
        pageSize: 20,
        total: 0,
        showSizeChanger: false,
        showQuickJumper: true,
        showTotal: total => '共 ' + total + ' 条，每页 20 条'
    });

    const columns = [
        { title: '查询ID', dataIndex: 'id', key: 'id', width: 150 },
        { title: '接收时间', dataIndex: 'timestamp', key: 'timestamp', width: 160 },
        { title: '源IP', dataIndex: 'sourceIp', key: 'sourceIp', width: 130 },
        { title: '源端口', dataIndex: 'sourcePort', key: 'sourcePort', width: 90 },
        { title: '操作', dataIndex: 'operation', key: 'operation', width: 100 },
        { title: '版本', dataIndex: 'version', key: 'version', width: 90 },
        { title: 'Community', dataIndex: 'community', key: 'community', width: 120 },
        { title: 'Request ID', dataIndex: 'requestId', key: 'requestId', width: 120 },
        { title: '变量数', dataIndex: 'varbindCount', key: 'varbindCount', width: 90 },
        { title: '操作', key: 'action', width: 90, fixed: 'right' }
    ];

    const varbindColumns = [
        { title: '#', dataIndex: 'index', key: 'index', width: 60 },
        { title: 'OID', dataIndex: 'oid', key: 'oid', width: 240 },
        { title: '名称', dataIndex: 'oidName', key: 'oidName', width: 220 },
        { title: '类型', dataIndex: 'type', key: 'type', width: 120 },
        { title: '值', dataIndex: 'value', key: 'value', width: 280 }
    ];

    const buildQueryRequest = () => {
        const request = {
            page: pagination.current,
            pageSize: pagination.pageSize,
            filters: {
                operation: filters.operation,
                sourceIp: filters.sourceIp,
                community: filters.community
            }
        };

        if (filters.timeRange?.length === 2) {
            request.filters.timeRange = {
                start: filters.timeRange[0].toISOString(),
                end: filters.timeRange[1].toISOString()
            };
        }

        return request;
    };

    const loadQueryList = async () => {
        if (queryListLoading) {
            pendingQueryListRefresh = true;
            return;
        }

        queryListLoading = true;
        loading.value = true;
        try {
            const result = await window.snmpApi.getQueryList(buildQueryRequest());
            if (result.status === 'success') {
                const data = result.data || {};
                queries.value = data.list || [];
                pagination.total = Number(data.total) || 0;
                pagination.current = Number(data.page) || pagination.current;
                totalQueries.value = Number(data.totalQueries) || 0;
                todayQueries.value = Number(data.todayQueries) || 0;
                recentQueries.value = Number(data.recentQueries) || 0;
                sourceCount.value = Number(data.sourceCount) || 0;
            } else {
                message.error(result.msg || '获取查询列表失败');
            }
        } catch (error) {
            message.error('获取查询列表失败: ' + error.message);
        } finally {
            queryListLoading = false;
            loading.value = false;
            lastQueryListRefreshAt = Date.now();
            if (pendingQueryListRefresh) {
                pendingQueryListRefresh = false;
                scheduleQueryListRefresh();
            }
        }
    };

    const scheduleQueryListRefresh = () => {
        const elapsed = Date.now() - lastQueryListRefreshAt;
        if (elapsed >= QUERY_LIST_REFRESH_INTERVAL_MS) {
            loadQueryList();
            return;
        }

        if (queryListRefreshTimer) {
            return;
        }

        queryListRefreshTimer = setTimeout(() => {
            queryListRefreshTimer = null;
            loadQueryList();
        }, QUERY_LIST_REFRESH_INTERVAL_MS - elapsed);
    };

    const handleFilterChange = () => {
        pagination.current = 1;
        loadQueryList();
    };

    const handleTableChange = page => {
        pagination.current = page.current;
        loadQueryList();
    };

    const clearHistory = async () => {
        try {
            clearLoading.value = true;
            const result = await window.snmpApi.clearQueryHistory();
            if (result.status === 'success') {
                message.success(result.msg || '查询历史已清空');
                pagination.current = 1;
                await loadQueryList();
            } else {
                message.error(result.msg || '清空查询历史失败');
            }
        } catch (error) {
            message.error('清空查询历史失败: ' + error.message);
        } finally {
            clearLoading.value = false;
        }
    };

    const showQueryDetail = record => {
        selectedQuery.value = record;
        detailModalVisible.value = true;
    };

    const getOperationColor = operation => {
        const colorMap = {
            GET: 'blue',
            GETNEXT: 'cyan',
            GETBULK: 'purple',
            SET: 'orange'
        };
        return colorMap[operation] || 'default';
    };

    const formatTimestamp = timestamp => {
        if (!timestamp) {
            return '';
        }
        return dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss');
    };

    const handleSnmpEvent = respData => {
        if (respData.status !== 'success') {
            return;
        }

        const payload = respData.data || {};
        if (payload.type === SNMP_SUB_EVT_TYPES.QUERY_BATCH_RECEIVED) {
            scheduleQueryListRefresh();
        } else if (payload.type === SNMP_SUB_EVT_TYPES.SERVER_STATUS && payload.data?.status === 'stopped') {
            queries.value = [];
            pagination.total = 0;
            totalQueries.value = 0;
            todayQueries.value = 0;
            recentQueries.value = 0;
            sourceCount.value = 0;
        }
    };

    onActivated(() => {
        EventBus.on('snmp:event', SNMP_EVENT_PAGE_ID.PAGE_ID_SNMP_QUERY, handleSnmpEvent);
        loadQueryList();
    });

    onDeactivated(() => {
        EventBus.off('snmp:event', SNMP_EVENT_PAGE_ID.PAGE_ID_SNMP_QUERY);
        if (queryListRefreshTimer) {
            clearTimeout(queryListRefreshTimer);
            queryListRefreshTimer = null;
        }
    });
</script>

<style scoped>
    .snmp-query-page {
        height: calc(100vh - 68px);
        overflow: hidden;
    }

    .query-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .query-card :deep(.ant-card-body) {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
    }

    .stats-row {
        flex-shrink: 0;
        margin-bottom: 12px;
    }

    .filter-row {
        flex-shrink: 0;
        margin-bottom: 6px;
    }

    .query-list-table {
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    .query-list-table :deep(.ant-table-body) {
        height: calc(100vh - 350px) !important;
        overflow-y: auto !important;
    }

    .query-detail-section-title {
        margin: 10px 0 6px;
        color: #262626;
        font-weight: 600;
    }

    .query-detail-section-title:first-child {
        margin-top: 0;
    }

    .varbind-value {
        min-width: 0;
    }

    .varbind-value-name {
        margin-top: 2px;
        color: #8c8c8c;
        font-size: 12px;
    }

    .varbind-detail-table :deep(.ant-table-body) {
        height: 200px !important;
        overflow-y: auto !important;
    }

    @media (max-height: 620px) {
        .query-list-table :deep(.ant-table-body) {
            height: calc(100vh - 365px) !important;
        }

        .varbind-detail-table :deep(.ant-table-body) {
            height: 160px !important;
        }
    }
</style>
