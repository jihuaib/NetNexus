<template>
    <div class="mt-container">
        <a-row>
            <a-col :span="24">
                <a-card title="BGP会话">
                    <div v-if="clientList.length > 0">
                        <a-tabs v-model:active-key="activeClientKey" tab-position="left">
                            <a-tab-pane
                                v-for="client in clientList"
                                :key="`${client.localIp}|${client.localPort}|${client.remoteIp}|${client.remotePort}`"
                                :tab="`${client.sysDesc}[${client.remoteIp}]`"
                            >
                                <div v-if="bgpSessionList.length > 0">
                                    <a-tabs v-model:active-key="activeBgpSessionKey">
                                        <a-tab-pane
                                            v-for="session in bgpSessionList"
                                            :key="`${session.sessionType}|${session.sessionRd}|${session.sessionIp}|${session.sessionAs}`"
                                            :tab="`${session.sessionType} | rd(${session.sessionRd}) | ip(${session.sessionIp}) | as(${session.sessionAs})`"
                                        >
                                            <a-table
                                                :columns="bgpSessionColumns"
                                                :data-source="[session]"
                                                :pagination="false"
                                                size="small"
                                                style="margin-bottom: 8px"
                                                row-key="peerIp"
                                                ,
                                                :scroll="{ x: 'max-content' }"
                                            >
                                                <template #bodyCell="{ column, record }">
                                                    <template v-if="column.key === 'addPathMap'">
                                                        <a-tooltip
                                                            v-if="
                                                                record.addPathMap &&
                                                                Object.values(record.addPathMap).some(v => v)
                                                            "
                                                        >
                                                            <template #title>
                                                                <div
                                                                    v-for="(enabled, key) in record.addPathMap"
                                                                    :key="key"
                                                                >
                                                                    <span v-if="enabled">
                                                                        {{ ADDRESS_FAMILY_NAME[key] }}: Yes
                                                                    </span>
                                                                </div>
                                                            </template>
                                                            <a-tag color="green">Yes</a-tag>
                                                        </a-tooltip>
                                                        <a-tag v-else color="red">No</a-tag>
                                                    </template>
                                                    <template v-else-if="column.key === 'sessionFlags'">
                                                        <a-tooltip :title="getBmpFlagsName(record.sessionFlags)">
                                                            <span>{{ getBmpFlagsName(record.sessionFlags) }}</span>
                                                        </a-tooltip>
                                                    </template>
                                                    <template v-else-if="column.key === 'rawSessionFlags'">
                                                        <span>{{ formatRawFlags(record.rawSessionFlags) }}</span>
                                                    </template>
                                                    <template v-else-if="column.key === 'peerDownReason'">
                                                        <span>{{ formatPeerDownReason(record.peerDownReason) }}</span>
                                                    </template>
                                                    <template v-else-if="column.key === 'tlvCount'">
                                                        <span>{{ getSessionTlvCount(record) }}</span>
                                                    </template>
                                                    <template v-else-if="column.key === 'action'">
                                                        <a-button
                                                            type="link"
                                                            size="small"
                                                            @click="viewSessionDetails(record)"
                                                        >
                                                            详情
                                                        </a-button>
                                                    </template>
                                                </template>
                                            </a-table>
                                            <div
                                                style="
                                                    margin-bottom: 8px;
                                                    display: flex;
                                                    gap: 16px;
                                                    align-items: center;
                                                    flex-wrap: wrap;
                                                "
                                            >
                                                <a-select v-model:value="activeLocRibAf" style="width: 200px">
                                                    <a-select-option
                                                        v-for="af in session.enabledAddrFamilyTypes"
                                                        :key="af"
                                                        :value="af"
                                                    >
                                                        {{ ADDRESS_FAMILY_NAME[af] || af }}
                                                    </a-select-option>
                                                </a-select>
                                                <a-select v-model:value="activeLocRibType" style="width: 200px">
                                                    <a-select-option
                                                        v-for="rt in session.ribTypes"
                                                        :key="rt"
                                                        :value="rt"
                                                    >
                                                        {{ BMP_BGP_RIB_TYPE_NAME[rt] }}
                                                    </a-select-option>
                                                </a-select>
                                                <a-radio-group v-model:value="routeStateFilter" size="small">
                                                    <a-radio-button :value="BMP_ROUTE_STATE_FILTER.ACTIVE">
                                                        当前
                                                    </a-radio-button>
                                                    <a-radio-button :value="BMP_ROUTE_STATE_FILTER.ALL">
                                                        全部
                                                    </a-radio-button>
                                                    <a-radio-button :value="BMP_ROUTE_STATE_FILTER.STALE">
                                                        过期
                                                    </a-radio-button>
                                                </a-radio-group>
                                                <a-tag color="green">当前 {{ routeSummary.active }}</a-tag>
                                                <a-tag color="orange">过期 {{ routeSummary.stale }}</a-tag>
                                                <a-button type="primary" @click="loadBgpRoutes">查询</a-button>
                                                <a-button
                                                    danger
                                                    :disabled="routeSummary.stale === 0"
                                                    @click="purgeStaleRoutes"
                                                >
                                                    清理过期
                                                </a-button>
                                            </div>
                                            <a-table
                                                :columns="bgpRouteColumns"
                                                :data-source="bgpRouteList"
                                                :pagination="bgpRoutePagination"
                                                :row-key="
                                                    record =>
                                                        `${record.addrFamilyType}|${record.pathId}|${record.rd}|${record.ip}|${record.mask}`
                                                "
                                                :row-class-name="
                                                    record =>
                                                        record.routeState === BMP_ROUTE_STATE.STALE
                                                            ? 'route-stale-row'
                                                            : ''
                                                "
                                                size="small"
                                                :scroll="{ y: 320, x: 'max-content' }"
                                            >
                                                <template #bodyCell="{ column, record }">
                                                    <template v-if="column.key === 'routeState'">
                                                        <a-tag
                                                            :color="
                                                                record.routeState === BMP_ROUTE_STATE.STALE
                                                                    ? 'orange'
                                                                    : 'green'
                                                            "
                                                        >
                                                            {{
                                                                BMP_ROUTE_STATE_NAME[record.routeState] ||
                                                                BMP_ROUTE_STATE_NAME[BMP_ROUTE_STATE.ACTIVE]
                                                            }}
                                                        </a-tag>
                                                    </template>
                                                    <template v-else-if="column.key === 'routeAction'">
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
    import { ref, watch, onActivated, onDeactivated } from 'vue';
    import { message } from 'ant-design-vue';
    import {
        BMP_SESSION_TYPE_NAME,
        BMP_SESSION_STATE_NAME,
        BMP_BGP_RIB_TYPE_NAME,
        BMP_EVENT_PAGE_ID,
        BMP_PEER_DOWN_REASON_NAME,
        BMP_ROUTE_STATE,
        BMP_ROUTE_STATE_FILTER,
        BMP_ROUTE_STATE_NAME,
        getBmpFlagsName
    } from '../../const/bmpConst';
    import { ADDRESS_FAMILY_NAME } from '../../const/bgpConst';
    import EventBus from '../../utils/eventBus';
    defineOptions({
        name: 'BgpSession'
    });

    // 客户端
    const clientList = ref([]);
    const activeClientKey = ref('');

    const bgpSessionList = ref([]);

    // 对等体列表
    const bgpSessionColumns = [
        {
            title: 'Session Type',
            dataIndex: 'sessionType',
            key: 'sessionType',
            ellipsis: true,
            width: 100,
            customRender: ({ text }) => {
                return BMP_SESSION_TYPE_NAME[text] || text;
            }
        },
        {
            title: 'Session IP',
            dataIndex: 'sessionIp',
            key: 'sessionIp',
            width: 100,
            ellipsis: true
        },
        {
            title: 'AS',
            dataIndex: 'sessionAs',
            key: 'sessionAs',
            width: 100,
            ellipsis: true
        },
        {
            title: 'RD',
            dataIndex: 'sessionRd',
            key: 'sessionRd',
            width: 100,
            ellipsis: true
        },
        {
            title: 'Router ID',
            dataIndex: 'sessionRouterId',
            key: 'sessionRouterId',
            width: 100,
            ellipsis: true
        },
        {
            title: 'ADD-PATH',
            dataIndex: 'addPathMap',
            key: 'addPathMap',
            ellipsis: true,
            width: 80
        },
        {
            title: 'Flags',
            dataIndex: 'sessionFlags',
            key: 'sessionFlags',
            ellipsis: true,
            width: 140
        },
        {
            title: 'Raw Flags',
            dataIndex: 'rawSessionFlags',
            key: 'rawSessionFlags',
            ellipsis: true,
            width: 90
        },
        {
            title: 'Down Reason',
            dataIndex: 'peerDownReason',
            key: 'peerDownReason',
            ellipsis: true,
            width: 140
        },
        {
            title: 'TLV数量',
            key: 'tlvCount',
            width: 80,
            align: 'right'
        },
        {
            title: 'Session状态',
            dataIndex: 'sessionState',
            key: 'sessionState',
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

    // View peer details
    const viewSessionDetails = record => {
        currentDetails.value = record;
        detailsDrawerTitle.value = `Session 详情: ${record.sessionIp}`;
        detailsDrawerVisible.value = true;
    };

    const viewRouteDetails = record => {
        currentDetails.value = record;
        detailsDrawerTitle.value = `路由详情: ${record.ip || ''}`;
        detailsDrawerVisible.value = true;
    };

    const formatRawFlags = flags => {
        if (flags === null || flags === undefined) return '-';
        return `0x${Number(flags).toString(16).padStart(2, '0')}`;
    };

    const formatPeerDownReason = reason => {
        if (reason === null || reason === undefined) return '-';
        return BMP_PEER_DOWN_REASON_NAME[reason] || reason;
    };

    const getSessionTlvCount = record => {
        return (
            (record.peerUpTlvs || []).length +
            (record.peerDownTlvs || []).length +
            (record.lastRouteMonitoringTlvs || []).length
        );
    };

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
                bgpSessionList.value = [];
            }

            if (clientList.value.length === 0) {
                activeClientKey.value = '';
                bgpSessionList.value = [];
            }
        } else {
            console.error('termination handler error', result.msg);
        }
    };

    const onRouteUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const update = result.data;

        const clientKey = `${update.client.localIp}|${update.client.localPort}|${update.client.remoteIp}|${update.client.remotePort}`;
        if (clientKey !== activeClientKey.value) return;

        const sessKey = `${update.session.sessionType}|${update.session.sessionRd}|${update.session.sessionIp}|${update.session.sessionAs}`;
        if (sessKey === activeBgpSessionKey.value) {
            if (update.af === activeLocRibAf.value && update.ribType === activeLocRibType.value) {
                bgpRoutePagination.value.current = 1;
                loadBgpRoutes();
            }
        }
    };

    const onSessionUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const data = result.data;

        const clientKey = `${data.client.localIp}|${data.client.localPort}|${data.client.remoteIp}|${data.client.remotePort}`;
        if (clientKey !== activeClientKey.value) return;
        loadBgpSessionList();
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

    // 加载BGP会话列表
    const loadBgpSessionList = async () => {
        if (!activeClientKey.value) return;

        try {
            const [localIp, localPort, remoteIp, remotePort] = activeClientKey.value.split('|');
            const clientInfo = {
                localIp,
                localPort,
                remoteIp,
                remotePort
            };

            const bgpSessionListResult = await window.bmpApi.getBgpSessions(clientInfo);
            if (bgpSessionListResult.status === 'success') {
                bgpSessionList.value = bgpSessionListResult.data || [];
                if (bgpSessionList.value.length > 0) {
                    const first = bgpSessionList.value[0];
                    const key = `${first.sessionType}|${first.sessionRd}|${first.sessionIp}|${first.sessionAs}`;
                    activeBgpSessionKey.value = key;
                    if (first.enabledAddrFamilyTypes.length > 0) {
                        activeLocRibAf.value = first.enabledAddrFamilyTypes[0];
                    }
                    if (first.ribTypes.length > 0) {
                        activeLocRibType.value = first.ribTypes[0];
                    }
                    bgpRoutePagination.value.current = 1;
                    loadBgpRoutes();
                }
            } else {
                bgpSessionList.value = [];
                message.error('获取BGP邻居列表失败');
            }
        } catch (error) {
            console.error(error);
            bgpSessionList.value = [];
            message.error('获取BGP邻居列表失败');
        }
    };

    const activeBgpSessionKey = ref('');
    const activeLocRibAf = ref(null);
    const activeLocRibType = ref('');
    const bgpRouteList = ref([]);
    const routeStateFilter = ref(BMP_ROUTE_STATE_FILTER.ALL);
    const routeSummary = ref({ active: 0, stale: 0, total: 0 });

    // 监听activeClientKey变化，加载对应的peer列表 AND instances
    watch(activeClientKey, _newKey => {
        activeBgpSessionKey.value = '';
        bgpRouteList.value = [];
        bgpSessionList.value = [];
        loadBgpSessionList();
    });

    onActivated(async () => {
        clientList.value = [];
        activeClientKey.value = '';
        bgpSessionList.value = [];

        EventBus.on('bmp:sessionUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onSessionUpdate);
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onClientListUpdate);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onTerminationHandler);
        EventBus.on('bmp:routeUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onRouteUpdate);

        await loadClientList();
        // 如果有选中的客户端，则加载对应的BGP会话列表
        if (activeClientKey.value) {
            await loadBgpSessionList();
        }
    });

    onDeactivated(() => {
        EventBus.off('bmp:sessionUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION);
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION);
        EventBus.off('bmp:routeUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION);
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
            loadBgpRoutes();
        }
    });

    const bgpRouteColumns = [
        {
            title: '状态',
            dataIndex: 'routeState',
            key: 'routeState',
            width: 80
        },
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

    const loadBgpRoutes = async () => {
        if (!activeClientKey.value || !activeBgpSessionKey.value || !activeLocRibAf.value || !activeLocRibType.value)
            return;
        const [localIp, localPort, remoteIp, remotePort] = activeClientKey.value.split('|');
        const [sessionType, sessionRd, sessionIp, sessionAs] = activeBgpSessionKey.value.split('|');

        const client = { localIp, localPort, remoteIp, remotePort };
        const sessionInfo = { sessionType, sessionRd, sessionIp, sessionAs };
        const af = activeLocRibAf.value;
        const ribType = activeLocRibType.value;
        const page = bgpRoutePagination.value.current;
        const pageSize = bgpRoutePagination.value.pageSize;

        try {
            const res = await window.bmpApi.getBgpRoutes(
                client,
                sessionInfo,
                af,
                ribType,
                page,
                pageSize,
                routeStateFilter.value
            );
            if (res.status === 'success' && res.data) {
                bgpRouteList.value = res.data.list;
                bgpRoutePagination.value.total = res.data.total;
                routeSummary.value = res.data.summary || { active: 0, stale: 0, total: 0 };
            } else {
                bgpRouteList.value = [];
                bgpRoutePagination.value.total = 0;
                routeSummary.value = { active: 0, stale: 0, total: 0 };
            }
        } catch (e) {
            console.error(e);
            message.error('Load routes failed');
        }
    };

    const purgeStaleRoutes = async () => {
        if (!activeClientKey.value || !activeBgpSessionKey.value || !activeLocRibAf.value || !activeLocRibType.value)
            return;
        const [localIp, localPort, remoteIp, remotePort] = activeClientKey.value.split('|');
        const [sessionType, sessionRd, sessionIp, sessionAs] = activeBgpSessionKey.value.split('|');

        const client = { localIp, localPort, remoteIp, remotePort };
        const sessionInfo = { sessionType, sessionRd, sessionIp, sessionAs };

        try {
            const res = await window.bmpApi.purgeStaleBgpRoutes(
                client,
                sessionInfo,
                activeLocRibAf.value,
                activeLocRibType.value
            );
            if (res.status === 'success') {
                message.success(`已清理 ${res.data?.deleted || 0} 条过期路由`);
                bgpRoutePagination.value.current = 1;
                loadBgpRoutes();
            } else {
                message.error('清理过期路由失败');
            }
        } catch (e) {
            console.error(e);
            message.error('清理过期路由失败');
        }
    };

    watch(activeBgpSessionKey, _newKey => {
        bgpRoutePagination.value.current = 1;
        loadBgpRoutes();
    });

    watch([activeLocRibAf, activeLocRibType], () => {
        if (activeBgpSessionKey.value) {
            bgpRoutePagination.value.current = 1;
            loadBgpRoutes();
        }
    });

    watch(routeStateFilter, () => {
        bgpRoutePagination.value.current = 1;
        loadBgpRoutes();
    });
</script>

<style scoped>
    :deep(.ant-table-body) {
        height: 320px !important;
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

    :deep(.route-stale-row) {
        color: #8c6d1f;
        background-color: #fffbe6;
    }
</style>
