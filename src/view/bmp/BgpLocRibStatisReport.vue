<template>
    <div class="mt-container">
        <a-row>
            <a-col :span="24">
                <a-card title="BGP LocRib统计">
                    <div v-if="clientList.length > 0">
                        <a-tabs v-model:active-key="activeClientKey" tab-position="left">
                            <a-tab-pane
                                v-for="client in clientList"
                                :key="`${client.localIp}|${client.localPort}|${client.remoteIp}|${client.remotePort}`"
                                :tab="`${client.sysDesc}[${client.remoteIp}]`"
                            >
                                <div v-if="getClientReports(client).length > 0">
                                    <a-tabs>
                                        <a-tab-pane
                                            v-for="report in getClientReports(client)"
                                            :key="report.key"
                                            :tab="formatInstanceTab(report)"
                                        >
                                            <div class="report-header">
                                                <a-space>
                                                    <a-tag color="blue">Type {{ report.instance.instanceType }}</a-tag>
                                                    <a-tag>RD {{ report.instance.instanceRd }}</a-tag>
                                                    <a-tag v-if="formatVrfTableName(report)">{{ formatVrfTableName(report) }}</a-tag>
                                                    <a-tag>TLV {{ getReportTlvCount(report) }}</a-tag>
                                                    <a-button type="link" size="small" @click="viewReportDetails(report)">
                                                        详情
                                                    </a-button>
                                                </a-space>
                                            </div>
                                            <a-table
                                                :columns="columns"
                                                :data-source="report.statistics"
                                                :pagination="false"
                                                :row-key="record => `${record.type}`"
                                                size="small"
                                                bordered
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

    defineOptions({
        name: 'BgpLocRibStatisReport'
    });

    const columns = [
        {
            title: '统计类型',
            dataIndex: 'typeName',
            key: 'typeName',
            width: '50%'
        },
        {
            title: 'AFI',
            dataIndex: 'afi',
            key: 'afi',
            width: '15%',
            customRender: ({ text }) => text || '-'
        },
        {
            title: 'SAFI',
            dataIndex: 'safi',
            key: 'safi',
            width: '15%',
            customRender: ({ text }) => text || '-'
        },
        {
            title: '数值',
            dataIndex: 'value',
            key: 'value',
            width: '20%',
            align: 'right'
        }
    ];

    // 客户端
    const clientList = ref([]);
    const activeClientKey = ref('');
    const reportMap = ref(new Map());
    const detailsDrawerVisible = ref(false);
    const detailsDrawerTitle = ref('');
    const currentDetails = ref(null);

    const getClientKey = client => {
        return `${client.localIp}|${client.localPort}|${client.remoteIp}|${client.remotePort}`;
    };

    const getInstanceKey = instance => {
        return `${instance.instanceType}|${instance.instanceRd}`;
    };

    const getClientReports = client => {
        const clientKey = getClientKey(client);
        return Array.from(reportMap.value.values()).filter(report => report.clientKey === clientKey);
    };

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

    const deleteReportsByClient = clientKey => {
        const nextMap = new Map(reportMap.value);
        for (const key of nextMap.keys()) {
            if (key.startsWith(`${clientKey}|`)) {
                nextMap.delete(key);
            }
        }
        reportMap.value = nextMap;
    };

    const onStatisticsReport = result => {
        if (result.status === 'success') {
            const data = result.data;
            if (data && data.client && data.instance && data.statistics) {
                const clientKey = getClientKey(data.client);
                const key = `${clientKey}|${getInstanceKey(data.instance)}`;
                const nextMap = new Map(reportMap.value);
                nextMap.set(key, {
                    key,
                    clientKey,
                    client: data.client,
                    instance: data.instance,
                    statistics: data.statistics,
                    tlvs: data.tlvs || [],
                    updatedAt: new Date().toISOString()
                });
                reportMap.value = nextMap;
            }
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

                // 设置默认选中第一个客户端
                if (clientList.value.length > 0 && !activeClientKey.value) {
                    activeClientKey.value = getClientKey(clientList.value[0]);
                }
            }
        } catch (error) {
            console.error(error);
            message.error('加载数据失败');
        }
    };

    onActivated(async () => {
        clientList.value = [];
        activeClientKey.value = '';
        reportMap.value = new Map();
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB_STATIS_REPORT, onClientListUpdate);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB_STATIS_REPORT, onTerminationHandler);
        EventBus.on(
            'bmp:statisticsReport',
            BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB_STATIS_REPORT,
            onStatisticsReport
        );
        await loadClientList();
    });

    onDeactivated(() => {
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB_STATIS_REPORT);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB_STATIS_REPORT);
        EventBus.off('bmp:statisticsReport', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB_STATIS_REPORT);
    });
</script>

<style scoped>
    .report-header {
        margin-bottom: 8px;
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
