<template>
    <div class="nn-container bmp-full-page" data-testid="bmp-loc-rib-statistics-page">
        <nn-row class="bmp-full-row">
            <nn-col :span="24">
                <nn-card class="bmp-full-card">
                    <div v-if="monitoredClient && monitoredClientReports.length > 0" class="bmp-inner-tabs-shell">
                        <nn-tabs class="bmp-inner-tabs" size="small">
                            <nn-tab-pane
                                v-for="report in monitoredClientReports"
                                :key="report.key"
                                :tab="formatInstanceTab(report)"
                            >
                                <div class="report-header">
                                    <nn-space>
                                        <nn-tag color="blue">Type {{ report.instance.instanceType }}</nn-tag>
                                        <nn-tag>RD {{ report.instance.instanceRd }}</nn-tag>
                                        <nn-tag v-if="formatVrfTableName(report)">
                                            {{ formatVrfTableName(report) }}
                                        </nn-tag>
                                        <nn-tag>TLV {{ getReportTlvCount(report) }}</nn-tag>
                                        <nn-button type="link" size="small" @click="viewReportDetails(report)">
                                            详情
                                        </nn-button>
                                    </nn-space>
                                </div>
                                <nn-table
                                    class="report-table"
                                    :columns="columns"
                                    :data-source="report.statistics"
                                    :pagination="{
                                        pageSize: 20,
                                        showSizeChanger: false,
                                        position: ['bottomCenter'],
                                        showTotal: total => '共 ' + total + ' 条，每页 20 条'
                                    }"
                                    :row-key="record => `${record.type}|${record.afi || ''}|${record.safi || ''}`"
                                    size="small"
                                    bordered
                                    :scroll="{ y: '100%' }"
                                >
                                    <template #bodyCell="{ column, record }">
                                        <template v-if="column.key === 'typeName'">
                                            {{ record.typeName }}
                                        </template>
                                        <template v-if="column.key === 'value'">
                                            {{ record.value }}
                                        </template>
                                    </template>
                                </nn-table>
                            </nn-tab-pane>
                        </nn-tabs>
                    </div>

                    <div v-else class="no-result-message">
                        <nn-empty :description="emptyDescription" />
                    </div>
                </nn-card>
            </nn-col>
        </nn-row>

        <nn-drawer
            v-model:open="detailsDrawerVisible"
            :title="detailsDrawerTitle"
            placement="right"
            width="520px"
            @close="closeDetailsDrawer"
        >
            <nn-json-viewer v-if="currentDetails" :value="currentDetails" wrap />
        </nn-drawer>
    </div>
</template>

<script setup>
    import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
    import { useRoute } from 'vue-router';
    import { notify } from '../../utils/notify';
    import EventBus from '../../utils/eventBus';
    import { BMP_EVENT_PAGE_ID } from '../../const/bmpConst';
    import { ADDRESS_FAMILY_NAME, getAddrFamilyType } from '../../const/bgpConst';

    defineOptions({
        name: 'BgpLocRibStatisReport'
    });

    const props = defineProps({
        clientKey: {
            type: String,
            default: ''
        }
    });

    const route = useRoute();

    const hasControlCharacter = value =>
        Array.from(value).some(character => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || code === 0x7f;
        });

    const normalizeClientKey = value => {
        const candidate = Array.isArray(value) ? value[0] : value;
        if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 512) return '';
        if (hasControlCharacter(candidate)) return '';
        if (candidate.startsWith('source:')) {
            return `source:${candidate.slice('source:'.length).trim().toLowerCase()}`;
        }
        return candidate.startsWith('connection:') ? candidate : '';
    };

    const lockedClientKey = computed(
        () => normalizeClientKey(props.clientKey) || normalizeClientKey(route.query.clientKey)
    );

    const formatAddrFamily = record => {
        if (record.afi === null || record.afi === undefined || record.safi === null || record.safi === undefined) {
            return '-';
        }
        const addrFamilyType = getAddrFamilyType(Number(record.afi), Number(record.safi));
        const name = ADDRESS_FAMILY_NAME[addrFamilyType] || `AFI ${record.afi} / SAFI ${record.safi}`;
        return `${name} (${record.afi}/${record.safi})`;
    };

    const columns = [
        {
            title: 'Type',
            dataIndex: 'type',
            key: 'type',
            width: 80
        },
        {
            title: '统计类型',
            dataIndex: 'typeName',
            key: 'typeName',
            width: 320
        },
        {
            title: '地址族',
            key: 'addrFamily',
            width: 180,
            customRender: ({ record }) => formatAddrFamily(record)
        },
        {
            title: '数值',
            dataIndex: 'value',
            key: 'value',
            width: 120,
            align: 'right'
        }
    ];

    const monitoredClient = ref(null);
    const reportMap = ref(new Map());
    const detailsDrawerVisible = ref(false);
    const detailsDrawerTitle = ref('');
    const currentDetails = ref(null);

    const getClientSourceId = client => client?.persistentSourceId || client?.sourceId || null;

    const getClientTransportKey = client =>
        `${client?.localIp || ''}|${client?.localPort || ''}|${client?.remoteIp || ''}|${client?.remotePort || ''}`;

    const getClientKey = client => {
        const sourceId = getClientSourceId(client);
        return sourceId
            ? `source:${String(sourceId).trim().toLowerCase()}`
            : `connection:${getClientTransportKey(client)}`;
    };

    const clientMatchesKey = (client, clientKey) => {
        if (!client || !clientKey) return false;
        return getClientKey(client) === clientKey;
    };

    const isSameClient = (left, right) => {
        if (!left || !right) return false;
        const leftSourceId = getClientSourceId(left);
        const rightSourceId = getClientSourceId(right);
        if (leftSourceId && rightSourceId) return leftSourceId === rightSourceId;
        return getClientTransportKey(left) === getClientTransportKey(right);
    };

    const toPlainClient = client => {
        const sourceId = getClientSourceId(client);
        return {
            localIp: client.localIp,
            localPort: client.localPort,
            remoteIp: client.remoteIp,
            remotePort: client.remotePort,
            persistentSourceId: sourceId,
            sourceId,
            persistentConnectionId: client.persistentConnectionId || client.connectionId || null,
            connectionId: client.connectionId || client.persistentConnectionId || null
        };
    };

    const getInstanceKey = instance => {
        return `${instance.instanceType}|${instance.instanceRdRaw || instance.instanceRd}`;
    };

    const getClientReports = client => {
        if (!client) return [];
        const clientKey = getClientKey(client);
        return Array.from(reportMap.value.values()).filter(report => report.clientKey === clientKey);
    };

    const monitoredClientReports = computed(() => getClientReports(monitoredClient.value));
    const emptyDescription = computed(() => {
        if (!lockedClientKey.value) return '未指定监控 Client';
        return monitoredClient.value ? '暂无统计数据' : '暂无数据';
    });

    const formatInstanceTab = report => {
        const vrfName = formatVrfTableName(report);
        return vrfName || `${report.instance.instanceType} | ${report.instance.instanceRd}`;
    };

    const formatVrfTableName = report => {
        return Array.isArray(report.instance.vrfTableNames) && report.instance.vrfTableNames.length > 0
            ? report.instance.vrfTableNames.join(', ')
            : '';
    };

    const getReportTlvCount = report => {
        return (report.tlvs || []).length;
    };

    const viewReportDetails = report => {
        currentDetails.value = report;
        detailsDrawerTitle.value = `Loc-RIB统计详情: ${report.instance.instanceRd}`;
        detailsDrawerVisible.value = true;
    };

    const closeDetailsDrawer = () => {
        detailsDrawerVisible.value = false;
        currentDetails.value = null;
    };

    const updateReportsForClient = (previousClientKey, client) => {
        const nextClientKey = getClientKey(client);
        const nextMap = new Map(reportMap.value);
        for (const [key, report] of Array.from(nextMap.entries())) {
            if (report.clientKey !== previousClientKey) continue;
            const nextKey = `${nextClientKey}|${getInstanceKey(report.instance)}`;
            nextMap.delete(key);
            nextMap.set(nextKey, {
                ...report,
                key: nextKey,
                clientKey: nextClientKey,
                client: { ...report.client, ...client }
            });
        }
        reportMap.value = nextMap;
    };

    let clientRequestId = 0;
    let statisticsRequestId = 0;
    let clientEventRevision = 0;
    let pageActive = false;

    const invalidateRequests = () => {
        clientRequestId += 1;
        statisticsRequestId += 1;
    };

    const upsertReport = (data, fallbackClient = null) => {
        if (!data?.client || !data?.instance || !Array.isArray(data.statistics)) return;

        const sourceId = getClientSourceId(data.client) || getClientSourceId(fallbackClient);
        const client = {
            ...(fallbackClient || {}),
            ...data.client,
            ...(sourceId ? { persistentSourceId: sourceId, sourceId } : {})
        };
        if (!clientMatchesKey(client, lockedClientKey.value)) return;

        const clientKey = getClientKey(client);
        const key = `${clientKey}|${getInstanceKey(data.instance)}`;
        const nextMap = new Map(reportMap.value);
        nextMap.set(key, {
            key,
            clientKey,
            client,
            instance: data.instance,
            statistics: data.statistics,
            tlvs: data.tlvs || [],
            updatedAt: data.updatedAt || new Date().toISOString()
        });
        reportMap.value = nextMap;
    };

    const getEventUpdates = data => (data?.batch === true && Array.isArray(data.updates) ? data.updates : [data]);

    const onStatisticsReport = result => {
        if (result.status !== 'success') return;
        getEventUpdates(result.data).forEach(data => {
            if (!clientMatchesKey(data?.client, lockedClientKey.value)) return;
            upsertReport(data, monitoredClient.value);
        });
    };

    const markMonitoredClientOffline = data => {
        if (!monitoredClient.value && !data) return;
        const previousClientKey = monitoredClient.value ? getClientKey(monitoredClient.value) : lockedClientKey.value;
        const nextClient = {
            ...(monitoredClient.value || {}),
            ...(data || {}),
            isOnline: false,
            connectionState: 'closed'
        };
        monitoredClient.value = nextClient;
        updateReportsForClient(previousClientKey, nextClient);
    };

    const onTerminationHandler = result => {
        if (result.status !== 'success') {
            console.error('termination handler error', result.msg);
            return;
        }

        const data = result.data;
        if (!lockedClientKey.value) return;
        if (data && !clientMatchesKey(data, lockedClientKey.value) && !isSameClient(monitoredClient.value, data)) {
            return;
        }
        clientEventRevision += 1;
        markMonitoredClientOffline(data);
    };

    const loadStatisticsReports = async client => {
        if (!client || !clientMatchesKey(client, lockedClientKey.value)) return;
        const requestId = ++statisticsRequestId;
        const requestedClientKey = lockedClientKey.value;
        try {
            const result = await window.bmpApi.getBgpInstanceStatisticsReports(toPlainClient(client));
            if (requestId !== statisticsRequestId || !pageActive) return;
            if (lockedClientKey.value !== requestedClientKey || !clientMatchesKey(client, requestedClientKey)) return;
            if (result.status === 'success') {
                (result.data || []).forEach(report => upsertReport(report, client));
            }
        } catch (error) {
            if (requestId !== statisticsRequestId) return;
            console.error(error);
            notify.error('加载统计数据失败');
        }
    };

    const onClientUpdate = result => {
        if (result.status !== 'success' || !result.data) {
            if (result.status !== 'success') notify.error('Client 更新失败');
            return;
        }

        if (!clientMatchesKey(result.data, lockedClientKey.value)) return;
        clientEventRevision += 1;
        const previousClientKey = monitoredClient.value ? getClientKey(monitoredClient.value) : null;
        const nextClient = {
            ...(monitoredClient.value || {}),
            ...result.data,
            isOnline: true,
            connectionState: 'open'
        };
        monitoredClient.value = nextClient;
        if (previousClientKey) updateReportsForClient(previousClientKey, nextClient);
        void loadStatisticsReports(nextClient);
    };

    const loadMonitoredClient = async () => {
        const clientKey = lockedClientKey.value;
        const requestId = ++clientRequestId;
        const eventRevision = clientEventRevision;
        if (!clientKey) {
            monitoredClient.value = null;
            return;
        }

        try {
            const result = await window.bmpApi.getClient(clientKey);
            if (requestId !== clientRequestId || !pageActive || lockedClientKey.value !== clientKey) return;
            if (eventRevision !== clientEventRevision) {
                if (monitoredClient.value && clientMatchesKey(monitoredClient.value, clientKey)) {
                    await loadStatisticsReports(monitoredClient.value);
                }
                return;
            }
            if (result.status !== 'success' || !result.data || !clientMatchesKey(result.data, clientKey)) {
                monitoredClient.value = null;
                reportMap.value = new Map();
                return;
            }

            const previousClientKey = monitoredClient.value ? getClientKey(monitoredClient.value) : null;
            monitoredClient.value = { ...(monitoredClient.value || {}), ...result.data };
            if (previousClientKey) updateReportsForClient(previousClientKey, monitoredClient.value);
            await loadStatisticsReports(monitoredClient.value);
        } catch (error) {
            if (requestId !== clientRequestId) return;
            console.error(error);
            notify.error('加载数据失败');
        }
    };

    const activatePage = async () => {
        if (pageActive) return;
        pageActive = true;
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB_STATIS_REPORT, onClientUpdate);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB_STATIS_REPORT, onTerminationHandler);
        EventBus.on(
            'bmp:statisticsReport',
            BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB_STATIS_REPORT,
            onStatisticsReport
        );
        await loadMonitoredClient();
    };

    const deactivatePage = () => {
        if (!pageActive) return;
        pageActive = false;
        invalidateRequests();
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB_STATIS_REPORT);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB_STATIS_REPORT);
        EventBus.off('bmp:statisticsReport', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB_STATIS_REPORT);
    };

    watch(lockedClientKey, (clientKey, previousClientKey) => {
        if (clientKey === previousClientKey) return;
        invalidateRequests();
        clientEventRevision += 1;
        monitoredClient.value = null;
        reportMap.value = new Map();
        if (pageActive) void loadMonitoredClient();
    });

    onMounted(activatePage);
    onActivated(activatePage);
    onDeactivated(deactivatePage);
    onBeforeUnmount(deactivatePage);
</script>

<style scoped>
    .bmp-full-page {
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .bmp-full-row,
    .bmp-full-row :deep(.nn-col) {
        height: 100%;
        min-height: 0;
    }

    .bmp-full-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .bmp-full-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        min-width: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .bmp-inner-tabs-shell {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bmp-inner-tabs {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        overflow: hidden;
    }

    .bmp-inner-tabs > :deep(.nn-tabs-content-holder),
    .bmp-inner-tabs > :deep(.nn-tabs-content-holder > .nn-tabs-content),
    .bmp-inner-tabs > :deep(.nn-tabs-content-holder > .nn-tabs-content > .nn-tabs-tabpane) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bmp-inner-tabs > :deep(.nn-tabs-nav) {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .report-header {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .report-table,
    .report-table :deep(.nn-spin-nested-loading),
    .report-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
    }

    .report-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .report-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .report-table :deep(.nn-table-container) {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .report-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow: auto !important;
    }

    .report-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .report-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }

    .no-result-message {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100%;
        width: 100%;
        color: var(--nn-color-text-muted);
        overflow: auto;
    }
</style>
