<template>
    <div class="mt-container snmp-trap-page">
        <a-card title="SNMP Trap 监控" class="trap-card">
            <template #extra>
                <a-space>
                    <a-button danger :loading="clearLoading" @click="clearHistory">
                        <template #icon><DeleteOutlined /></template>
                        清空历史
                    </a-button>
                </a-space>
            </template>

            <!-- 统计信息 -->
            <a-row :gutter="16" class="stats-row">
                <a-col :span="6">
                    <a-statistic title="总接收数量" :value="totalTraps" prefix="#" />
                </a-col>
                <a-col :span="6">
                    <a-statistic title="今日接收" :value="todayTraps" prefix="#" />
                </a-col>
                <a-col :span="6">
                    <a-statistic title="最近1小时" :value="recentTraps" prefix="#" />
                </a-col>
                <a-col :span="6">
                    <a-statistic title="在线代理" :value="onlineAgents" prefix="#" />
                </a-col>
            </a-row>

            <!-- 筛选器 -->
            <a-row :gutter="16" class="filter-row">
                <a-col :span="6">
                    <a-select
                        v-model:value="filters.version"
                        placeholder="选择SNMP版本"
                        allow-clear
                        style="width: 100%"
                        @change="handleFilterChange"
                    >
                        <a-select-option value="v1">SNMPv1</a-select-option>
                        <a-select-option value="v2c">SNMPv2c</a-select-option>
                        <a-select-option value="v3">SNMPv3</a-select-option>
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

            <!-- Trap列表表格 -->
            <a-table
                :columns="columns"
                :data-source="traps"
                :loading="loading"
                :pagination="pagination"
                :scroll="{ x: 1200, y: 'calc(100vh - 350px)' }"
                row-key="id"
                class="mt-margin-top-10 trap-list-table"
                @change="handleTableChange"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'version'">
                        <a-tag :color="getVersionColor(record.version)">
                            {{ record.version.toUpperCase() }}
                        </a-tag>
                    </template>
                    <template v-else-if="column.key === 'status'">
                        <a-tag :color="getStatusColor(record.status)">
                            {{ getStatusText(record.status) }}
                        </a-tag>
                    </template>
                    <template v-else-if="column.key === 'timestamp'">
                        {{ formatTimestamp(record.timestamp) }}
                    </template>
                    <template v-else-if="column.key === 'action'">
                        <a-space>
                            <a-button type="link" size="small" @click="showTrapDetail(record)">
                                <template #icon><EyeOutlined /></template>
                                详情
                            </a-button>
                        </a-space>
                    </template>
                </template>
            </a-table>
        </a-card>

        <!-- Trap详情模态框 -->
        <a-modal
            v-model:open="detailModalVisible"
            title="Trap 详情"
            :footer="null"
            class="modal-xlarge trap-detail-modal"
        >
            <div v-if="selectedTrap" class="trap-detail">
                <div class="trap-detail-section-title">基本信息</div>
                <a-descriptions :column="2" bordered size="small">
                    <a-descriptions-item label="Trap ID">{{ selectedTrap.id }}</a-descriptions-item>
                    <a-descriptions-item label="接收时间">
                        {{ formatTimestamp(selectedTrap.timestamp) }}
                    </a-descriptions-item>
                    <a-descriptions-item label="源IP地址">{{ selectedTrap.sourceIp }}</a-descriptions-item>
                    <a-descriptions-item label="源端口">{{ selectedTrap.sourcePort }}</a-descriptions-item>
                    <a-descriptions-item label="SNMP版本">
                        <a-tag :color="getVersionColor(selectedTrap.version)">
                            {{ selectedTrap.version.toUpperCase() }}
                        </a-tag>
                    </a-descriptions-item>
                    <a-descriptions-item label="状态">
                        <a-tag :color="getStatusColor(selectedTrap.status)">
                            {{ getStatusText(selectedTrap.status) }}
                        </a-tag>
                    </a-descriptions-item>
                    <a-descriptions-item v-if="selectedTrap.community" label="Community">
                        {{ selectedTrap.community }}
                    </a-descriptions-item>
                    <a-descriptions-item v-if="selectedTrap.enterpriseOid" label="企业OID">
                        {{ selectedTrap.enterpriseOid }}
                    </a-descriptions-item>
                    <a-descriptions-item v-if="selectedTrap.enterpriseName" label="企业名称">
                        {{ selectedTrap.enterpriseName }}
                    </a-descriptions-item>
                    <a-descriptions-item v-if="selectedTrap.trapOid" label="Trap OID">
                        {{ selectedTrap.trapOid }}
                    </a-descriptions-item>
                    <a-descriptions-item v-if="selectedTrap.trapName" label="Trap 名称">
                        {{ selectedTrap.trapName }}
                    </a-descriptions-item>
                    <a-descriptions-item
                        v-if="hasTrapField(selectedTrap.genericType) || hasTrapField(selectedTrap.specificType)"
                        label="Trap类型"
                    >
                        <div class="trap-type-inline">
                            <span v-if="hasTrapField(selectedTrap.genericType)">通用: {{ selectedTrap.genericType }}</span>
                            <span v-if="hasTrapField(selectedTrap.specificType)">特定: {{ selectedTrap.specificType }}</span>
                        </div>
                    </a-descriptions-item>
                </a-descriptions>

                <!-- 变量绑定 -->
                <div class="trap-detail-section-title">变量绑定 (Variable Bindings)</div>
                <a-table
                    :columns="varbindColumns"
                    :data-source="selectedTrap.varbinds || []"
                    size="small"
                    row-key="oid"
                    class="varbind-detail-table"
                    :pagination="false"
                    :scroll="{ x: 900, y: 180 }"
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
    import DeleteOutlined from '@ant-design/icons-vue/es/icons/DeleteOutlined';
    import EyeOutlined from '@ant-design/icons-vue/es/icons/EyeOutlined';
    import { SNMP_TRAP_STATUS, SNMP_SUB_EVT_TYPES, SNMP_EVENT_PAGE_ID } from '../../const/snmpConst';
    import dayjs from 'dayjs';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'SnmpTrap' });

    const loading = ref(false);
    const clearLoading = ref(false);
    const detailModalVisible = ref(false);
    const selectedTrap = ref(null);
    const traps = ref([]);
    const TRAP_LIST_REFRESH_INTERVAL_MS = 1000;
    let trapListLoading = false;
    let trapListRefreshTimer = null;
    let lastTrapListRefreshAt = 0;
    let pendingTrapListRefresh = false;

    // 统计数据
    const totalTraps = ref(0);
    const todayTraps = ref(0);
    const recentTraps = ref(0);
    const onlineAgents = ref(0);

    // 筛选器
    const filters = reactive({
        version: null,
        sourceIp: '',
        community: '',
        timeRange: null
    });

    // 分页配置
    const pagination = reactive({
        current: 1,
        pageSize: 20,
        total: 0,
        showSizeChanger: false,
        showQuickJumper: true,
        showTotal: total => '共 ' + total + ' 条，每页 20 条'
    });

    // 表格列定义
    const columns = [
        {
            title: 'Trap ID',
            dataIndex: 'id',
            key: 'id',
            width: 120,
            sorter: true
        },
        {
            title: '接收时间',
            dataIndex: 'timestamp',
            key: 'timestamp',
            width: 160,
            sorter: true
        },
        {
            title: '源IP',
            dataIndex: 'sourceIp',
            key: 'sourceIp',
            width: 120
        },
        {
            title: 'SNMP版本',
            dataIndex: 'version',
            key: 'version',
            width: 100
        },
        {
            title: 'Community',
            dataIndex: 'community',
            key: 'community',
            width: 120,
            ellipsis: true
        },
        {
            title: '企业OID',
            dataIndex: 'enterpriseOid',
            key: 'enterpriseOid',
            width: 200,
            ellipsis: true
        },
        {
            title: 'Trap名称',
            dataIndex: 'trapName',
            key: 'trapName',
            width: 180,
            ellipsis: true
        },
        {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 100
        },
        {
            title: '操作',
            key: 'action',
            width: 100,
            fixed: 'right'
        }
    ];

    // 变量绑定表格列
    const varbindColumns = [
        {
            title: 'OID',
            dataIndex: 'oid',
            key: 'oid',
            width: 260,
            ellipsis: true
        },
        {
            title: '名称',
            dataIndex: 'oidName',
            key: 'oidName',
            width: 220,
            ellipsis: true
        },
        {
            title: '类型',
            dataIndex: 'type',
            key: 'type',
            width: 100,
            ellipsis: true
        },
        {
            title: '值',
            dataIndex: 'value',
            key: 'value',
            ellipsis: true
        }
    ];

    const getVersionColor = version => {
        const colors = {
            v1: 'blue',
            v2c: 'green',
            v3: 'purple'
        };
        return colors[version] || 'default';
    };

    const getStatusColor = status => {
        const colors = {
            [SNMP_TRAP_STATUS.WAITING]: 'orange',
            [SNMP_TRAP_STATUS.RECEIVED]: 'green',
            [SNMP_TRAP_STATUS.PROCESSED]: 'blue',
            [SNMP_TRAP_STATUS.ERROR]: 'red'
        };
        return colors[status] || 'default';
    };

    const getStatusText = status => {
        const texts = {
            [SNMP_TRAP_STATUS.WAITING]: '等待中',
            [SNMP_TRAP_STATUS.RECEIVED]: '已接收',
            [SNMP_TRAP_STATUS.PROCESSED]: '已处理',
            [SNMP_TRAP_STATUS.ERROR]: '错误'
        };
        return texts[status] || status;
    };

    const formatTimestamp = timestamp => {
        return dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss');
    };

    const hasTrapField = value => value !== null && value !== undefined && value !== '';

    const toQueryTime = value => {
        if (!value) {
            return null;
        }

        return typeof value.toISOString === 'function' ? value.toISOString() : dayjs(value).toISOString();
    };

    const buildTrapListQuery = () => {
        const query = {
            page: pagination.current,
            pageSize: pagination.pageSize,
            filters: {
                version: filters.version,
                sourceIp: (filters.sourceIp || '').trim(),
                community: (filters.community || '').trim()
            }
        };

        if (filters.timeRange && filters.timeRange.length === 2) {
            query.filters.timeRange = {
                start: toQueryTime(filters.timeRange[0]),
                end: toQueryTime(filters.timeRange[1])
            };
        }

        return query;
    };

    const getPageStatsFallback = list => {
        const now = dayjs();
        const todayStart = now.startOf('day');
        const recentStart = now.subtract(1, 'hour');
        const sourceIps = new Set();
        let today = 0;
        let recent = 0;

        list.forEach(trap => {
            if (trap.sourceIp) {
                sourceIps.add(trap.sourceIp);
            }

            const trapTime = dayjs(trap.timestamp);
            if (trapTime.isAfter(todayStart) || trapTime.isSame(todayStart)) {
                today++;
            }
            if (trapTime.isAfter(recentStart)) {
                recent++;
            }
        });

        return {
            todayTraps: today,
            recentTraps: recent,
            onlineAgents: sourceIps.size
        };
    };

    const normalizeTrapListPayload = payload => {
        if (Array.isArray(payload)) {
            const stats = getPageStatsFallback(payload);
            return {
                list: payload,
                page: 1,
                pageSize: pagination.pageSize,
                total: payload.length,
                totalTraps: payload.length,
                ...stats
            };
        }

        const list = Array.isArray(payload?.list) ? payload.list : [];
        const fallbackStats = getPageStatsFallback(list);
        const page = Number(payload?.page);
        const filteredTotal = Number(payload?.total);
        const receivedTotal = Number(payload?.totalTraps);
        const todayTotal = Number(payload?.todayTraps);
        const recentTotal = Number(payload?.recentTraps);
        const agentTotal = Number(payload?.onlineAgents);

        return {
            list,
            page: Number.isFinite(page) ? page : pagination.current,
            pageSize: pagination.pageSize,
            total: Number.isFinite(filteredTotal) ? filteredTotal : list.length,
            totalTraps: Number.isFinite(receivedTotal) ? receivedTotal : list.length,
            todayTraps: Number.isFinite(todayTotal) ? todayTotal : fallbackStats.todayTraps,
            recentTraps: Number.isFinite(recentTotal) ? recentTotal : fallbackStats.recentTraps,
            onlineAgents: Number.isFinite(agentTotal) ? agentTotal : fallbackStats.onlineAgents
        };
    };

    const setTrapPage = payload => {
        traps.value = payload.list;
        pagination.current = payload.page;
        pagination.total = payload.total;
        totalTraps.value = payload.totalTraps;
        todayTraps.value = payload.todayTraps;
        recentTraps.value = payload.recentTraps;
        onlineAgents.value = payload.onlineAgents;
    };

    const clearScheduledTrapRefresh = () => {
        if (trapListRefreshTimer) {
            clearTimeout(trapListRefreshTimer);
            trapListRefreshTimer = null;
        }
        pendingTrapListRefresh = false;
    };

    const scheduleTrapListRefresh = () => {
        if (trapListRefreshTimer) {
            return;
        }

        const delay = Math.max(0, TRAP_LIST_REFRESH_INTERVAL_MS - (Date.now() - lastTrapListRefreshAt));
        trapListRefreshTimer = setTimeout(() => {
            trapListRefreshTimer = null;
            lastTrapListRefreshAt = Date.now();
            pagination.current = 1;
            loadTrapList(false);
        }, delay);
    };

    const loadTrapList = async (showLoading = true) => {
        if (trapListLoading) {
            pendingTrapListRefresh = true;
            return;
        }

        try {
            trapListLoading = true;
            if (showLoading) {
                loading.value = true;
            }

            const result = await window.snmpApi.getTrapList(buildTrapListQuery());
            if (result.status === 'success') {
                setTrapPage(normalizeTrapListPayload(result.data));
            } else if (showLoading) {
                message.error(result.msg || '获取Trap列表失败');
            }
        } catch (error) {
            if (showLoading) {
                message.error('获取Trap列表失败: ' + error.message);
            }
        } finally {
            trapListLoading = false;
            if (showLoading) {
                loading.value = false;
            }

            if (pendingTrapListRefresh) {
                pendingTrapListRefresh = false;
                scheduleTrapListRefresh();
            }
        }
    };

    const clearHistory = async () => {
        try {
            clearLoading.value = true;
            const result = await window.snmpApi.clearTrapHistory();
            if (result.status === 'success') {
                clearScheduledTrapRefresh();
                setTrapPage({
                    list: [],
                    page: 1,
                    pageSize: pagination.pageSize,
                    total: 0,
                    totalTraps: 0,
                    todayTraps: 0,
                    recentTraps: 0,
                    onlineAgents: 0
                });
                message.success(result.msg || '历史记录清空成功');
            } else {
                message.error(result.msg || '清空失败');
            }
        } catch (error) {
            message.error('清空失败: ' + error.message);
        } finally {
            clearLoading.value = false;
        }
    };

    const handleFilterChange = () => {
        pagination.current = 1;
        loadTrapList();
    };

    const handleTableChange = pag => {
        pagination.current = pag.current;
        loadTrapList();
    };

    const showTrapDetail = trap => {
        selectedTrap.value = trap;
        detailModalVisible.value = true;
    };

    defineExpose({
        clearValidationErrors: () => {
            // 此组件无表单验证
        }
    });

    const handleSnmpEvent = respData => {
        if (respData.status === 'success') {
            const payload = respData.data || {};
            const type = payload.type;
            if (type === SNMP_SUB_EVT_TYPES.TRAP_BATCH_RECEIVED || type === SNMP_SUB_EVT_TYPES.TRAP_RECEIVED) {
                scheduleTrapListRefresh();
            } else if (type === SNMP_SUB_EVT_TYPES.SERVER_STATUS && payload.data?.status === 'stopped') {
                clearScheduledTrapRefresh();
                setTrapPage({
                    list: [],
                    page: 1,
                    pageSize: pagination.pageSize,
                    total: 0,
                    totalTraps: 0,
                    todayTraps: 0,
                    recentTraps: 0,
                    onlineAgents: 0
                });
            }
        }
    };

    onActivated(async () => {
        EventBus.on('snmp:event', SNMP_EVENT_PAGE_ID.PAGE_ID_SNMP_TRAP, handleSnmpEvent);
        await loadTrapList();
    });

    onDeactivated(() => {
        clearScheduledTrapRefresh();
        EventBus.off('snmp:event', SNMP_EVENT_PAGE_ID.PAGE_ID_SNMP_TRAP);
    });
</script>

<style scoped>
    .snmp-trap-page {
        height: calc(100vh - 68px);
        overflow: hidden;
    }

    .trap-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .trap-card :deep(.ant-card-body) {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
    }

    .stats-row,
    .filter-row {
        flex-shrink: 0;
    }

    .stats-row :deep(.ant-statistic-title) {
        margin-bottom: 2px;
        font-size: 13px;
    }

    .stats-row :deep(.ant-statistic-content) {
        font-size: 20px;
        line-height: 28px;
    }

    .filter-row {
        margin-top: 8px;
    }

    .varbind-value {
        min-width: 120px;
    }

    .varbind-value-name {
        margin-top: 4px;
        color: #666;
        font-size: 12px;
    }

    /* Trap 列表表格样式 */
    .trap-list-table {
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    .trap-list-table :deep(.ant-spin-nested-loading),
    .trap-list-table :deep(.ant-spin-container) {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
    }

    .trap-list-table :deep(.ant-table) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    .trap-list-table :deep(.ant-table-body) {
        height: calc(100vh - 350px) !important;
        overflow-y: auto !important;
    }

    .trap-detail {
        min-height: 0;
    }

    .trap-detail-section-title {
        margin: 8px 0;
        color: #262626;
        font-weight: 600;
        line-height: 22px;
    }

    .trap-detail-section-title:first-child {
        margin-top: 0;
    }

    .trap-detail :deep(.ant-descriptions-item-label) {
        width: 92px;
    }

    .trap-detail :deep(.ant-descriptions-item-content) {
        min-width: 0;
        word-break: break-all;
    }

    .trap-type-inline {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        line-height: 22px;
    }

    /* 变量绑定详情表格样式 */
    .varbind-detail-table {
        min-height: 0;
    }

    .varbind-detail-table :deep(.ant-table-body) {
        height: 180px !important;
        overflow-y: auto !important;
    }

    @media (max-height: 760px) {
        .trap-list-table :deep(.ant-table-body) {
            height: calc(100vh - 365px) !important;
        }

        .varbind-detail-table :deep(.ant-table-body) {
            height: 150px !important;
        }
    }
</style>
