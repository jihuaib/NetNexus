<template>
    <div class="mt-container bmp-full-page">
        <a-row class="bmp-full-row">
            <a-col :span="24">
                <a-card title="BGP会话统计" class="bmp-full-card">
                    <div v-if="clientList.length > 0" class="bmp-tabs-shell">
                        <a-tabs
                            v-model:active-key="activeClientKey"
                            tab-position="left"
                            class="client-tabs"
                            :tab-bar-style="clientTabBarStyle"
                        >
                            <a-tab-pane
                                v-for="client in clientList"
                                :key="`${client.localIp}|${client.localPort}|${client.remoteIp}|${client.remotePort}`"
                            >
                                <template #tab>
                                    <span class="client-tab-label">{{ formatClientTab(client) }}</span>
                                </template>
                                <div v-if="getClientReports(client).length > 0" class="bmp-inner-tabs-shell">
                                    <a-tabs class="bmp-inner-tabs">
                                        <a-tab-pane
                                            v-for="report in getClientReports(client)"
                                            :key="report.key"
                                            :tab="formatSessionTab(report)"
                                        >
                                            <div class="report-header">
                                                <a-space>
                                                    <a-tag color="blue">{{ report.session.sessionIp }}</a-tag>
                                                    <a-tag>AS {{ report.session.sessionAs }}</a-tag>
                                                    <a-tag>TLV {{ getReportTlvCount(report) }}</a-tag>
                                                    <a-button
                                                        type="link"
                                                        size="small"
                                                        @click="viewReportDetails(report)"
                                                    >
                                                        详情
                                                    </a-button>
                                                </a-space>
                                            </div>
                                            <a-table
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
                                            </a-table>
                                        </a-tab-pane>
                                    </a-tabs>
                                </div>
                                <div v-else class="no-result-message">
                                    <a-empty description="暂无统计数据" />
                                </div>
                            </a-tab-pane>
                        </a-tabs>
                    </div>

                    <div v-else class="no-result-message">
                        <a-empty description="暂无数据" />
                    </div>
                </a-card>
            </a-col>
        </a-row>

        <a-drawer
            v-model:open="detailsDrawerVisible"
            :title="detailsDrawerTitle"
            placement="right"
            width="520px"
            @close="closeDetailsDrawer"
        >
            <pre v-if="currentDetails">{{ JSON.stringify(currentDetails, null, 2) }}</pre>
        </a-drawer>
    </div>
</template>

<script setup>
    import { ref, onActivated, onDeactivated } from 'vue';
    import { message } from 'ant-design-vue';
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

    const getClientKey = client => {
        return `${client.localIp}|${client.localPort}|${client.remoteIp}|${client.remotePort}`;
    };

    const toPlainClient = client => ({
        localIp: client.localIp,
        localPort: client.localPort,
        remoteIp: client.remoteIp,
        remotePort: client.remotePort
    });

    const getSessionKey = session => {
        return `${session.sessionType}|${session.sessionRd}|${session.sessionIp}|${session.sessionAs}`;
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

    const deleteReportsByClient = clientKey => {
        const nextMap = new Map(reportMap.value);
        for (const key of nextMap.keys()) {
            if (key.startsWith(`${clientKey}|`)) {
                nextMap.delete(key);
            }
        }
        reportMap.value = nextMap;
    };

    const upsertReport = data => {
        if (data && data.client && data.session && data.statistics) {
            const clientKey = getClientKey(data.client);
            const key = `${clientKey}|${getSessionKey(data.session)}`;
            const nextMap = new Map(reportMap.value);
            nextMap.set(key, {
                key,
                clientKey,
                client: data.client,
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
                // 特定客户端终止的情况
                const existingIndex = clientList.value.findIndex(
                    client =>
                        `${client.localIp || ''}-${client.localPort || ''}-${client.remoteIp || ''}-${client.remotePort || ''}` ===
                        `${data.localIp || ''}-${data.localPort || ''}-${data.remoteIp || ''}-${data.remotePort || ''}`
                );
                if (existingIndex !== -1) {
                    clientList.value.splice(existingIndex, 1);
                    deleteReportsByClient(getClientKey(data));

                    if (clientList.value.length > 0 && !activeClientKey.value) {
                        activeClientKey.value = getClientKey(clientList.value[0]);
                    }
                }
            } else {
                // BMP 服务停止，清空所有数据
                clientList.value = [];
                activeClientKey.value = '';
                reportMap.value = new Map();
            }

            if (clientList.value.length === 0) {
                activeClientKey.value = '';
            }
        } else {
            console.error('termination handler error', result.msg);
        }
    };

    const onClientListUpdate = result => {
        if (result.status === 'success') {
            // 存在则更新，否则添加
            const existingIndex = clientList.value.findIndex(
                client =>
                    `${client.localIp || ''}-${client.localPort || ''}-${client.remoteIp || ''}-${client.remotePort || ''}` ===
                    `${result.data.localIp || ''}-${result.data.localPort || ''}-${result.data.remoteIp || ''}-${result.data.remotePort || ''}`
            );
            if (existingIndex !== -1) {
                clientList.value[existingIndex] = result.data;
            } else {
                clientList.value.push(result.data);
            }
            if (clientList.value.length > 0 && !activeClientKey.value) {
                activeClientKey.value = getClientKey(clientList.value[0]);
            }
        } else {
            message.error('客户端列表获取失败');
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
            message.error('加载数据失败');
        }
    };

    const loadStatisticsReports = async () => {
        try {
            for (const client of clientList.value) {
                const result = await window.bmpApi.getBgpStatisticsReports(toPlainClient(client));
                if (result.status === 'success') {
                    (result.data || []).forEach(report => upsertReport(report));
                }
            }
        } catch (error) {
            console.error(error);
            message.error('加载统计数据失败');
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
        height: calc(100vh - 70px);
        min-height: 0;
        overflow: hidden;
    }

    .bmp-full-row,
    .bmp-full-row :deep(.ant-col) {
        height: 100%;
        min-height: 0;
    }

    .bmp-full-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .bmp-full-card :deep(.ant-card-body) {
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

    .client-tabs :deep(.ant-tabs-content-holder),
    .client-tabs :deep(.ant-tabs-content),
    .client-tabs :deep(.ant-tabs-tabpane),
    .bmp-inner-tabs :deep(.ant-tabs-content-holder),
    .bmp-inner-tabs :deep(.ant-tabs-content),
    .bmp-inner-tabs :deep(.ant-tabs-tabpane) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .bmp-inner-tabs :deep(.ant-tabs-nav) {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .report-header {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .report-table,
    .report-table :deep(.ant-spin-nested-loading),
    .report-table :deep(.ant-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
    }

    .report-table :deep(.ant-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .report-table :deep(.ant-table) {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .report-table :deep(.ant-table-container),
    .report-table :deep(.ant-table-content) {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
    }

    .report-table :deep(.ant-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .report-table :deep(.ant-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .report-table :deep(.ant-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .report-table :deep(.ant-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }

    .client-tab-label {
        display: block;
        max-width: 112px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .client-tabs :deep(.ant-tabs-tab) {
        justify-content: flex-start;
        padding: 8px;
        text-align: left;
    }

    .client-tabs :deep(.ant-tabs-tab-btn) {
        width: 100%;
    }

    .no-result-message {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100%;
        width: 100%;
        color: #999;
        overflow: auto;
    }
</style>
