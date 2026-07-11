<template>
    <div class="mt-container radius-table-page">
        <nn-card title="RADIUS会话状态" class="radius-table-card">
            <template #extra>
                <nn-button :loading="loading" @click="loadSessionList">刷新</nn-button>
            </template>

            <nn-table
                :columns="columns"
                :data-source="sessionList"
                :loading="loading"
                :pagination="{
                    pageSize: 20,
                    showSizeChanger: false,
                    position: ['bottomCenter'],
                    showTotal: total => '共 ' + total + ' 条，每页 20 条'
                }"
                :scroll="{ x: 'max-content', y: '100%' }"
                row-key="key"
                size="small"
                class="radius-table"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'framedAddress'">
                        {{ framedAddress(record) }}
                    </template>
                    <template v-else-if="column.key === 'lastStatusText'">
                        <nn-tag color="processing">{{ record.lastStatusText || '-' }}</nn-tag>
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
            width="760px"
            placement="right"
            @close="closeDetailDrawer"
        >
            <nn-empty v-if="!selectedSession" description="暂无详情" />
            <template v-else>
                <nn-descriptions title="会话摘要" size="small" bordered :column="1">
                    <nn-descriptions-item label="会话Key">{{ selectedSession.key || '-' }}</nn-descriptions-item>
                    <nn-descriptions-item label="用户">{{ selectedSession.userName || '-' }}</nn-descriptions-item>
                    <nn-descriptions-item label="Acct-Session-Id">
                        {{ selectedSession.acctSessionId || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Acct-Multi-Session-Id">
                        {{ selectedSession.acctMultiSessionId || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="最后状态">
                        <nn-tag color="processing">{{ selectedSession.lastStatusText || '-' }}</nn-tag>
                    </nn-descriptions-item>
                    <nn-descriptions-item label="开始时间">{{ selectedSession.startedAt || '-' }}</nn-descriptions-item>
                    <nn-descriptions-item label="更新时间">
                        {{ selectedSession.lastUpdateAt || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="最近CoA">{{ selectedSession.lastCoaAt || '-' }}</nn-descriptions-item>
                </nn-descriptions>

                <nn-descriptions title="NAS 与地址" size="small" bordered :column="1" class="detail-section">
                    <nn-descriptions-item label="NAS地址">{{ selectedSession.nasAddress || '-' }}</nn-descriptions-item>
                    <nn-descriptions-item label="NAS-IPv4">
                        {{ selectedSession.nasIpAddress || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="NAS-IPv6">
                        {{ selectedSession.nasIpv6Address || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="NAS-Identifier">
                        {{ selectedSession.nasIdentifier || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="NAS-Port">
                        {{ valueText(selectedSession.nasPort) }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="NAS-Port-Id">
                        {{ selectedSession.nasPortId || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Calling-Station-Id">
                        {{ selectedSession.callingStationId || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Called-Station-Id">
                        {{ selectedSession.calledStationId || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Framed-IP">
                        {{ selectedSession.framedIpAddress || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Framed-IPv6-Prefix">
                        {{ selectedSession.framedIpv6Prefix || '-' }}
                    </nn-descriptions-item>
                </nn-descriptions>

                <nn-descriptions title="授权更新" size="small" bordered :column="1" class="detail-section">
                    <nn-descriptions-item label="Filter-Id">
                        {{ arrayText(selectedSession.filterIds) }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Session-Timeout">
                        {{ valueText(selectedSession.sessionTimeout) }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Idle-Timeout">
                        {{ valueText(selectedSession.idleTimeout) }}
                    </nn-descriptions-item>
                </nn-descriptions>

                <div class="detail-section">
                    <div class="detail-section-title">最近计费属性</div>
                    <nn-table
                        :columns="attributeColumns"
                        :data-source="selectedSession.attributes || []"
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
    import { RADIUS_EVENT_PAGE_ID, RADIUS_SUB_EVT_TYPES } from '../../const/radiusConst';
    import EventBus from '../../utils/eventBus';

    defineOptions({ name: 'RadiusSession' });

    const loading = ref(false);
    const sessionList = ref([]);
    const detailDrawerVisible = ref(false);
    const detailDrawerTitle = ref('');
    const selectedSession = ref(null);

    const columns = [
        { title: '用户', dataIndex: 'userName', key: 'userName', width: 140 },
        { title: '会话ID', dataIndex: 'acctSessionId', key: 'acctSessionId', width: 180, ellipsis: true },
        { title: 'NAS地址', dataIndex: 'nasAddress', key: 'nasAddress', width: 180, ellipsis: true },
        { title: 'Framed地址', key: 'framedAddress', width: 190, ellipsis: true },
        { title: '状态', dataIndex: 'lastStatusText', key: 'lastStatusText', width: 130 },
        { title: '开始时间', dataIndex: 'startedAt', key: 'startedAt', width: 190 },
        { title: '更新时间', dataIndex: 'lastUpdateAt', key: 'lastUpdateAt', width: 190 },
        { title: '操作', key: 'action', width: 90, fixed: 'right' }
    ];

    const attributeColumns = [
        { title: '类型', dataIndex: 'type', key: 'type', width: 90 },
        { title: '名称', dataIndex: 'name', key: 'name', width: 220 },
        { title: '值', dataIndex: 'value', key: 'value' }
    ];

    const attributeRowKey = (record, index) => `${record.type}-${record.name}-${index}`;

    const valueText = value => {
        return value === null || value === undefined || value === '' ? '-' : value;
    };

    const arrayText = value => {
        return Array.isArray(value) && value.length > 0 ? value.join(', ') : '-';
    };

    const framedAddress = record => {
        return record.framedIpAddress || record.framedIpv6Prefix || '-';
    };

    const showDetail = record => {
        selectedSession.value = record;
        detailDrawerTitle.value = `RADIUS会话详情: ${record.acctSessionId || record.userName || '-'}`;
        detailDrawerVisible.value = true;
    };

    const closeDetailDrawer = () => {
        detailDrawerVisible.value = false;
        selectedSession.value = null;
    };

    const loadSessionList = async () => {
        try {
            loading.value = true;
            const result = await window.radiusApi.getSessionList();
            if (result.status === 'success') {
                sessionList.value = result.data || [];
            } else {
                notify.error(result.msg || '获取RADIUS会话列表失败');
            }
        } catch (error) {
            notify.error('获取RADIUS会话列表失败: ' + error.message);
        } finally {
            loading.value = false;
        }
    };

    const handleRadiusEvent = respData => {
        if (respData.status !== 'success') {
            return;
        }
        const payload = respData.data;
        if (payload.type === RADIUS_SUB_EVT_TYPES.SESSION_UPDATED) {
            sessionList.value = payload.data.sessions || [];
        } else if (payload.type === RADIUS_SUB_EVT_TYPES.SERVER_STATUS && payload.data.status === 'stopped') {
            sessionList.value = [];
            closeDetailDrawer();
        }
    };

    onActivated(async () => {
        EventBus.on('radius:event', RADIUS_EVENT_PAGE_ID.PAGE_ID_RADIUS_SESSION, handleRadiusEvent);
        await loadSessionList();
    });

    onDeactivated(() => {
        EventBus.off('radius:event', RADIUS_EVENT_PAGE_ID.PAGE_ID_RADIUS_SESSION);
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
