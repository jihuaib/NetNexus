<template>
    <div class="mt-container">
        <a-row>
            <a-col :span="24">
                <a-card title="BGP Loc-RIB">
                    <div v-if="clientList.length > 0">
                        <a-tabs v-model:active-key="activeClientKey" tab-position="left">
                            <a-tab-pane
                                v-for="client in clientList"
                                :key="`${client.localIp}|${client.localPort}|${client.remoteIp}|${client.remotePort}`"
                                :tab="`${client.sysDesc}[${client.remoteIp}]`"
                            >
                                <div v-if="bgpInstances.length > 0">
                                    <a-tabs v-model:active-key="activeInstanceKey">
                                        <a-tab-pane
                                            v-for="instance in bgpInstances"
                                            :key="`${instance.instanceType}|${instance.instanceRd}|${instance.addrFamilyType}`"
                                            :tab="`${formatVrfTableName(instance)} | ${ADDRESS_FAMILY_NAME[instance.addrFamilyType]}`"
                                        >
                                            <a-table
                                                :columns="bgpInstanceColumns"
                                                :data-source="[instance]"
                                                :pagination="false"
                                                size="small"
                                                style="margin-bottom: 8px"
                                                row-key="peerIp"
                                                :scroll="{ x: 'max-content' }"
                                            >
                                                <template #bodyCell="{ column, record }">
                                                    <template v-if="column.key === 'addPath'">
                                                        <a-tag v-if="record.isAddPath" color="green">Yes</a-tag>
                                                        <a-tag v-else color="red">No</a-tag>
                                                    </template>
                                                    <template v-else-if="column.key === 'instanceFlags'">
                                                        <a-tooltip :title="getBmpLocRibFlagsName(record.instanceFlags)">
                                                            <span>{{ getBmpLocRibFlagsName(record.instanceFlags) }}</span>
                                                        </a-tooltip>
                                                    </template>
                                                    <template v-else-if="column.key === 'rawInstanceFlags'">
                                                        <span>{{ formatRawFlags(record.rawInstanceFlags) }}</span>
                                                    </template>
                                                    <template v-else-if="column.key === 'tlvCount'">
                                                        <span>{{ getInstanceTlvCount(record) }}</span>
                                                    </template>
                                                    <template v-else-if="column.key === 'action'">
                                                        <a-button
                                                            type="link"
                                                            size="small"
                                                            @click="viewInstanceDetails(record)"
                                                        >
                                                            详情
                                                        </a-button>
                                                    </template>
                                                </template>
                                            </a-table>
                                            <a-table
                                                :columns="bgpRouteColumns"
                                                :data-source="bgpRouteList"
                                                :pagination="bgpRoutePagination"
                                                size="small"
                                                :scroll="{ y: 360 }"
                                            >
                                                <template #bodyCell="{ column, record }">
                                                    <template v-if="column.key === 'routeAction'">
                                                        <a-button type="link" size="small" @click="viewRouteDetails(record)">
                                                            查询详情
                                                        </a-button>
                                                    </template>
                                                </template>
                                            </a-table>
                                        </a-tab-pane>
                                    </a-tabs>
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
            width="500px"
            @close="closeDetailsDrawer"
        >
            <pre v-if="currentDetails">{{ JSON.stringify(currentDetails, null, 2) }}</pre>
        </a-drawer>
    </div>
</template>

<script setup>
    import { ref, onActivated, watch, onDeactivated } from 'vue';
    import { message } from 'ant-design-vue';
    import {
        BMP_SESSION_TYPE_NAME,
        BMP_SESSION_STATE_NAME,
        BMP_EVENT_PAGE_ID,
        getBmpLocRibFlagsName
    } from '../../const/bmpConst';
    import { ADDRESS_FAMILY_NAME } from '../../const/bgpConst';
    import EventBus from '../../utils/eventBus';
    defineOptions({
        name: 'BgpLocRib'
    });

    // 客户端
    const clientList = ref([]);
    const activeClientKey = ref('');

    const formatRawFlags = flags => {
        if (flags === null || flags === undefined) return '-';
        return `0x${Number(flags).toString(16).padStart(2, '0')}`;
    };

    const getInstanceTlvCount = record => {
        return (record.peerUpTlvs || []).length + (record.lastRouteMonitoringTlvs || []).length;
    };

    const formatVrfTableName = instance => {
        return Array.isArray(instance.vrfTableNames) && instance.vrfTableNames.length > 0
            ? instance.vrfTableNames.join(', ')
            : `${instance.instanceType} | ${instance.instanceRd}`;
    };

    const bgpInstanceColumns = [
        {
            title: 'Instance Type',
            dataIndex: 'instanceType',
            key: 'instanceType',
            ellipsis: true,
            width: 100,
            customRender: ({ text }) => {
                return BMP_SESSION_TYPE_NAME[text] || text;
            }
        },
        {
            title: 'VRF/Table',
            dataIndex: 'vrfTableNames',
            key: 'vrfTableNames',
            width: 100,
            ellipsis: true,
            customRender: ({ text }) => {
                return Array.isArray(text) && text.length > 0 ? text.join(', ') : '-';
            }
        },
        {
            title: 'Instance IP',
            dataIndex: 'instanceIp',
            key: 'instanceIp',
            width: 100,
            ellipsis: true
        },
        {
            title: 'AS',
            dataIndex: 'instanceAs',
            key: 'instanceAs',
            width: 100,
            ellipsis: true
        },
        {
            title: 'RD',
            dataIndex: 'instanceRd',
            key: 'instanceRd',
            width: 100,
            ellipsis: true
        },
        {
            title: 'Router ID',
            dataIndex: 'instanceRouterId',
            key: 'instanceRouterId',
            width: 100,
            ellipsis: true
        },
        {
            title: 'ADD-PATH',
            key: 'addPath',
            ellipsis: true,
            width: 80
        },
        {
            title: 'Flags',
            dataIndex: 'instanceFlags',
            key: 'instanceFlags',
            ellipsis: true,
            width: 140
        },
        {
            title: 'Raw Flags',
            dataIndex: 'rawInstanceFlags',
            key: 'rawInstanceFlags',
            ellipsis: true,
            width: 90
        },
        {
            title: 'TLV数量',
            key: 'tlvCount',
            width: 80,
            align: 'right'
        },
        {
            title: 'Instance状态',
            dataIndex: 'instanceState',
            key: 'instanceState',
            ellipsis: true,
            width: 100,
            customRender: ({ text }) => {
                return BMP_SESSION_STATE_NAME[text] || text;
            }
        },
        {
            title: '操作',
            key: 'action',
            fixed: 'right',
            width: 200
        }
    ];

    // Details drawer
    const detailsDrawerVisible = ref(false);
    const detailsDrawerTitle = ref('');
    const currentDetails = ref(null);

    // Close details drawer
    const closeDetailsDrawer = () => {
        detailsDrawerVisible.value = false;
        currentDetails.value = null;
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

                    if (clientList.value.length > 0 && !activeClientKey.value) {
                        activeClientKey.value = `${clientList.value[0].localIp}|${clientList.value[0].localPort}|${clientList.value[0].remoteIp}|${clientList.value[0].remotePort}`;
                    }
                }
            } else {
                // BMP 服务停止，清空所有数据
                clientList.value = [];
                activeClientKey.value = '';
                bgpInstances.value = [];
            }

            if (clientList.value.length === 0) {
                activeClientKey.value = '';
                bgpInstances.value = [];
            }
        } else {
            console.error('termination handler error', result.msg);
        }
    };

    const onInstanceRouteUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const update = result.data;

        const clientKey = `${update.client.localIp}|${update.client.localPort}|${update.client.remoteIp}|${update.client.remotePort}`;
        if (clientKey !== activeClientKey.value) return;

        const instKey = `${update.instance.instanceType}|${update.instance.instanceRd}|${update.instance.addrFamilyType}`;

        if (instKey === activeInstanceKey.value) {
            bgpRoutePagination.value.current = 1;
            loadInstanceRoutes();
        }
    };

    const onInstanceUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const data = result.data;

        const clientKey = `${data.client.localIp}|${data.client.localPort}|${data.client.remoteIp}|${data.client.remotePort}`;
        if (clientKey !== activeClientKey.value) return;

        loadBgpInstances();
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
                activeClientKey.value = `${clientList.value[0].localIp}|${clientList.value[0].localPort}|${clientList.value[0].remoteIp}|${clientList.value[0].remotePort}`;
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
                    activeClientKey.value = `${clientList.value[0].localIp}|${clientList.value[0].localPort}|${clientList.value[0].remoteIp}|${clientList.value[0].remotePort}`;
                }
            }
        } catch (error) {
            console.error(error);
            message.error('加载数据失败');
        }
    };

    const bgpRouteList = ref([]);

    // Instance Logic
    const bgpInstances = ref([]);
    const activeInstanceKey = ref('');

    const loadBgpInstances = async () => {
        if (!activeClientKey.value) return;
        try {
            const [localIp, localPort, remoteIp, remotePort] = activeClientKey.value.split('|');
            const clientInfo = { localIp, localPort, remoteIp, remotePort };
            const res = await window.bmpApi.getBgpInstances(clientInfo);
            if (res.status === 'success') {
                bgpInstances.value = res.data || [];
                if (bgpInstances.value.length > 0) {
                    const first = bgpInstances.value[0];
                    const key = `${first.instanceType}|${first.instanceRd}|${first.addrFamilyType}`;
                    activeInstanceKey.value = key;
                    bgpRoutePagination.value.current = 1;
                    loadInstanceRoutes();
                } else {
                    bgpRouteList.value = [];
                    activeInstanceKey.value = '';
                }
            } else {
                bgpInstances.value = [];
                activeInstanceKey.value = '';
            }
        } catch (error) {
            console.error(error);
            bgpInstances.value = [];
            message.error('Load BMP instances failed');
        }
    };

    const loadInstanceRoutes = async () => {
        if (!activeClientKey.value) return;

        const [localIp, localPort, remoteIp, remotePort] = activeClientKey.value.split('|');
        const client = { localIp, localPort, remoteIp, remotePort };

        const instance = {
            instanceType: activeInstanceKey.value.split('|')[0],
            instanceRd: activeInstanceKey.value.split('|')[1],
            addrFamilyType: activeInstanceKey.value.split('|')[2]
        };

        const page = bgpRoutePagination.value.current;
        const pageSize = bgpRoutePagination.value.pageSize;

        try {
            const res = await window.bmpApi.getBgpInstanceRoutes(client, instance, page, pageSize);
            if (res.status === 'success' && res.data) {
                bgpRouteList.value = res.data.list;
                bgpRoutePagination.value.total = res.data.total;
            } else {
                bgpRouteList.value = [];
                bgpRoutePagination.value.total = 0;
            }
        } catch (e) {
            console.error(e);
            message.error('Load instance routes failed');
        }
    };

    const viewInstanceDetails = record => {
        currentDetails.value = record;
        detailsDrawerTitle.value = `Instance 详情: ${record.instanceRd}`;
        detailsDrawerVisible.value = true;
    };

    const viewRouteDetails = record => {
        currentDetails.value = record;
        detailsDrawerTitle.value = `路由详情: ${record.ip || ''}`;
        detailsDrawerVisible.value = true;
    };

    // 监听activeClientKey变化，加载对应的peer列表 AND instances
    watch(activeClientKey, _newKey => {
        activeInstanceKey.value = '';
        bgpRouteList.value = [];
        bgpInstances.value = [];
        loadBgpInstances();
    });

    onActivated(async () => {
        clientList.value = [];
        activeClientKey.value = '';
        bgpInstances.value = [];

        EventBus.on('bmp:instanceUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onInstanceUpdate);
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onClientListUpdate);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onTerminationHandler);
        EventBus.on('bmp:instanceRouteUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onInstanceRouteUpdate);

        await loadClientList();
        // 如果有选中的客户端，则加载对应的BGP会话列表
        if (activeClientKey.value) {
            await loadBgpInstances();
        }
    });

    onDeactivated(() => {
        EventBus.off('bmp:instanceUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
        EventBus.off('bmp:instanceRouteUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
    });

    const bgpRoutePagination = ref({
        current: 1,
        pageSize: 10,
        total: 0,
        showSizeChanger: false,
        position: ['bottomCenter'],
        showTotal: total => `共 ${total} 条`,
        onChange: (page, pageSize) => {
            bgpRoutePagination.value.current = page;
            bgpRoutePagination.value.pageSize = pageSize;
            loadInstanceRoutes();
        }
    });

    const bgpRouteColumns = [
        {
            title: 'Addr Family',
            dataIndex: 'addrFamilyType',
            key: 'addrFamilyType',
            ellipsis: true,
            width: 100,
            customRender: ({ text }) => ADDRESS_FAMILY_NAME[text] || text
        },
        { title: 'Path ID', dataIndex: 'pathId', key: 'pathId', ellipsis: true, width: 100 },
        { title: 'RD', dataIndex: 'rd', key: 'rd', ellipsis: true, width: 100 },
        { title: 'Labels', dataIndex: 'labels', key: 'labels', ellipsis: true, width: 100 },
        {
            title: 'Parse',
            dataIndex: 'parserValid',
            key: 'parserValid',
            ellipsis: true,
            width: 120,
            customRender: ({ record }) => {
                if (record.parserValid === false) return record.parseErrors || 'Invalid';
                return record.parseWarnings || 'OK';
            }
        },
        { title: 'Prefix', dataIndex: 'ip', key: 'ip', ellipsis: true, width: 120 },
        { title: 'Mask', dataIndex: 'mask', key: 'mask', ellipsis: true, width: 60 },
        { title: 'Origin', dataIndex: 'origin', key: 'origin', ellipsis: true, width: 80 },
        { title: 'AS Path', dataIndex: 'asPath', key: 'asPath', ellipsis: true },
        { title: 'Next Hop', dataIndex: 'nextHop', key: 'nextHop', ellipsis: true, width: 120 },
        { title: 'MED', dataIndex: 'med', key: 'med', ellipsis: true, width: 80 },
        { title: '操作', key: 'routeAction', width: 100 }
    ];

    watch(activeInstanceKey, newKey => {
        if (newKey) {
            bgpRoutePagination.value.current = 1;
            loadInstanceRoutes();
        }
    });
</script>

<style scoped>
    :deep(.ant-table-body) {
        height: 360px !important;
        overflow-y: auto !important;
    }

    .bgp-peer-info-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        padding: 8px;
        background-color: #f5f5f5;
        border-radius: 4px;
    }

    .bgp-peer-info-header-text {
        margin-right: 8px;
        font-weight: 500;
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
