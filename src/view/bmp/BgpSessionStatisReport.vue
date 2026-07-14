<template>
    <div class="nn-container bmp-full-page" data-testid="bmp-session-statistics-page">
        <nn-row class="bmp-full-row">
            <nn-col :span="24">
                <nn-card title="BGP会话统计" class="bmp-full-card">
                    <div v-if="clientList.length > 0" class="bmp-tabs-shell">
                        <nn-tabs
                            v-model:active-key="activeClientKey"
                            tab-position="left"
                            class="client-tabs"
                            :tab-bar-style="clientTabBarStyle"
                        >
                            <nn-tab-pane v-for="client in clientList" :key="getClientKey(client)">
                                <template #tab>
                                    <span class="client-tab-label" data-testid="bmp-statistics-client-tab-label">
                                        <span class="client-tab-address">{{ formatClientTab(client) }}</span>
                                        <span
                                            class="client-tab-status"
                                            :class="{ offline: !isClientOnline(client) }"
                                            data-testid="bmp-statistics-client-status"
                                        >
                                            {{ formatClientConnectionState(client) }}
                                        </span>
                                    </span>
                                </template>
                                <div v-if="getClientReports(client).length > 0" class="bmp-inner-tabs-shell">
                                    <nn-tabs class="bmp-inner-tabs">
                                        <nn-tab-pane
                                            v-for="report in getClientReports(client)"
                                            :key="report.key"
                                            :tab="formatSessionTab(report)"
                                        >
                                            <div class="report-header">
                                                <nn-space>
                                                    <nn-tag color="blue">{{ report.session.sessionIp }}</nn-tag>
                                                    <nn-tag>AS {{ report.session.sessionAs }}</nn-tag>
                                                    <nn-tag>TLV {{ getReportTlvCount(report) }}</nn-tag>
                                                    <nn-button
                                                        type="link"
                                                        size="small"
                                                        @click="viewReportDetails(report)"
                                                    >
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
                                                :row-key="
                                                    record => `${record.type}|${record.afi || ''}|${record.safi || ''}`
                                                "
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
                                    <nn-empty description="暂无统计数据" />
                                </div>
                            </nn-tab-pane>
                        </nn-tabs>
                    </div>

                    <div v-else class="no-result-message">
                        <nn-empty description="暂无数据" />
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
            <pre v-if="currentDetails">{{ JSON.stringify(currentDetails, null, 2) }}</pre>
        </nn-drawer>
    </div>
</template>

<script setup>
    import { ref, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import EventBus from '../../utils/eventBus';
    import { BMP_EVENT_PAGE_ID } from '../../const/bmpConst';
    import { ADDRESS_FAMILY_NAME, getAddrFamilyType } from '../../const/bgpConst';

    defineOptions({
        name: 'BgpSessionStatisReport'
    });

    const formatAddrFamily = record => {
        if (record.afi === null || record.afi === undefined || record.safi === null || record.safi === undefined) {
            return '-';
        }
        const addrFamilyType = getAddrFamilyType(Number(record.afi), Number(record.safi));
        const name = ADDRESS_FAMILY_NAME[addrFamilyType] || `AFI ${record.afi} / SAFI ${record.safi}`;
        return `${name} (${record.afi}/${record.safi})`;
    };

    const formatClientTab = client => {
        return client.remoteIp || '-';
    };

    const getClientOnlineState = client => {
        if (typeof client?.isOnline === 'boolean') return client.isOnline;
        if (typeof client?.online === 'boolean') return client.online;
        const state = String(client?.connectionState || '').toLowerCase();
        if (['offline', 'disconnected', 'closed', 'down'].includes(state)) return false;
        if (['online', 'connected', 'open', 'up'].includes(state)) return true;
        return null;
    };

    const isClientOnline = client => getClientOnlineState(client) ?? true;

    const formatClientConnectionState = client => (isClientOnline(client) ? '已连接' : '已断开');

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

    // 客户端
    const clientList = ref([]);
    const activeClientKey = ref('');
    const clientTabBarStyle = { width: '128px', flex: '0 0 128px' };
    const reportMap = ref(new Map());
    const detailsDrawerVisible = ref(false);
    const detailsDrawerTitle = ref('');
    const currentDetails = ref(null);

    const getClientSourceId = client => client?.persistentSourceId || client?.sourceId || null;

    const getClientTransportKey = client =>
        `${client?.localIp || ''}|${client?.localPort || ''}|${client?.remoteIp || ''}|${client?.remotePort || ''}`;

    const getClientKey = client => {
        const sourceId = getClientSourceId(client);
        return sourceId ? `source:${sourceId}` : `connection:${getClientTransportKey(client)}`;
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

    const getSessionKey = session => {
        return `${session.sessionType}|${session.sessionRdRaw || session.sessionRd}|${session.sessionIp}|${session.sessionAs}`;
    };

    const getClientReports = client => {
        const clientKey = getClientKey(client);
        return Array.from(reportMap.value.values()).filter(report => report.clientKey === clientKey);
    };

    const formatSessionTab = report => {
        return `${report.session.sessionIp} | AS ${report.session.sessionAs}`;
    };

    const getReportTlvCount = report => {
        return (report.tlvs || []).length;
    };

    const viewReportDetails = report => {
        currentDetails.value = report;
        detailsDrawerTitle.value = `统计详情: ${report.session.sessionIp}`;
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
            const nextKey = `${nextClientKey}|${getSessionKey(report.session)}`;
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

    const upsertReport = (data, fallbackClient = null) => {
        if (data && data.client && data.session && data.statistics) {
            const sourceId = getClientSourceId(data.client) || getClientSourceId(fallbackClient);
            const client = {
                ...(fallbackClient || {}),
                ...data.client,
                ...(sourceId ? { persistentSourceId: sourceId, sourceId } : {})
            };
            const clientKey = getClientKey(client);
            const key = `${clientKey}|${getSessionKey(data.session)}`;
            const nextMap = new Map(reportMap.value);
            nextMap.set(key, {
                key,
                clientKey,
                client,
                session: data.session,
                statistics: data.statistics,
                tlvs: data.tlvs || [],
                updatedAt: data.updatedAt || new Date().toISOString()
            });
            reportMap.value = nextMap;
        }
    };

    const onStatisticsReport = result => {
        if (result.status === 'success') {
            upsertReport(result.data);
        }
    };

    const onTerminationHandler = result => {
        if (result.status === 'success') {
            const data = result.data;
            if (data) {
                const existingIndex = clientList.value.findIndex(client => isSameClient(client, data));
                if (existingIndex !== -1) {
                    const existingClient = clientList.value[existingIndex];
                    const clientKey = getClientKey(existingClient);
                    Object.assign(existingClient, data, { isOnline: false, connectionState: 'closed' });
                    updateReportsForClient(clientKey, existingClient);
                }
            } else {
                for (const client of clientList.value) {
                    const clientKey = getClientKey(client);
                    Object.assign(client, { isOnline: false, connectionState: 'closed' });
                    updateReportsForClient(clientKey, client);
                }
            }
        } else {
            console.error('termination handler error', result.msg);
        }
    };

    const onClientListUpdate = result => {
        if (result.status === 'success') {
            const existingIndex = clientList.value.findIndex(client => isSameClient(client, result.data));
            if (existingIndex !== -1) {
                const existingClient = clientList.value[existingIndex];
                const previousClientKey = getClientKey(existingClient);
                const wasActive = previousClientKey === activeClientKey.value;
                Object.assign(existingClient, result.data, { isOnline: true, connectionState: 'open' });
                updateReportsForClient(previousClientKey, existingClient);
                if (wasActive) activeClientKey.value = getClientKey(existingClient);
            } else {
                clientList.value.push({ ...result.data, isOnline: true, connectionState: 'open' });
            }
            if (clientList.value.length > 0 && !activeClientKey.value) {
                activeClientKey.value = getClientKey(clientList.value[0]);
            }
        } else {
            notify.error('客户端列表获取失败');
        }
    };

    const loadClientList = async () => {
        try {
            const clientListResult = await window.bmpApi.getClientList();
            if (clientListResult.status === 'success') {
                clientList.value = clientListResult.data;

                if (clientList.value.length > 0) {
                    const activeClientExists = clientList.value.some(
                        client => getClientKey(client) === activeClientKey.value
                    );
                    if (!activeClientKey.value || !activeClientExists) {
                        activeClientKey.value = getClientKey(clientList.value[0]);
                    }
                } else {
                    activeClientKey.value = '';
                }
            }
        } catch (error) {
            console.error(error);
            notify.error('加载数据失败');
        }
    };

    const loadStatisticsReports = async () => {
        try {
            for (const client of clientList.value) {
                const result = await window.bmpApi.getBgpStatisticsReports(toPlainClient(client));
                if (result.status === 'success') {
                    (result.data || []).forEach(report => upsertReport(report, client));
                }
            }
        } catch (error) {
            console.error(error);
            notify.error('加载统计数据失败');
        }
    };

    onActivated(async () => {
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT, onClientListUpdate);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT, onTerminationHandler);
        EventBus.on(
            'bmp:statisticsReport',
            BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT,
            onStatisticsReport
        );
        await loadClientList();
        await loadStatisticsReports();
    });

    onDeactivated(() => {
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT);
        EventBus.off('bmp:statisticsReport', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT);
    });
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

    .bmp-tabs-shell,
    .bmp-inner-tabs-shell {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .client-tabs,
    .bmp-inner-tabs {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        overflow: hidden;
    }

    .client-tabs > :deep(.nn-tabs-content-holder),
    .client-tabs > :deep(.nn-tabs-content-holder > .nn-tabs-content),
    .client-tabs > :deep(.nn-tabs-content-holder > .nn-tabs-content > .nn-tabs-tabpane),
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

    .client-tab-label {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        max-width: 112px;
        overflow: hidden;
    }

    .client-tab-address {
        display: block;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .client-tab-status {
        color: var(--nn-color-success);
        font-size: 11px;
        line-height: 16px;
    }

    .client-tab-status.offline {
        color: var(--nn-color-text-muted);
    }

    .client-tabs > :deep(.nn-tabs-nav > .nn-tabs-nav-wrap > .nn-tabs-nav-list > .nn-tabs-tab) {
        justify-content: center;
        padding: 8px;
        text-align: center;
    }

    .client-tabs > :deep(.nn-tabs-nav > .nn-tabs-nav-wrap > .nn-tabs-nav-list > .nn-tabs-tab > .nn-tabs-tab-button) {
        width: 100%;
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
