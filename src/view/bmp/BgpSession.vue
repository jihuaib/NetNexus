<template>
    <div class="mt-container">
        <a-row>
            <a-col :span="24">
                <a-card title="BGP会话">
                    <div v-if="clientList.length > 0">
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
                                    <a-tooltip :title="formatClientTitle(client)" placement="right">
                                        <span class="client-tab-label">{{ formatClientTab(client) }}</span>
                                    </a-tooltip>
                                </template>
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
                                                :pagination="{ pageSize: 20, showSizeChanger: false, position: ['bottomCenter'], showTotal: total => '共 ' + total + ' 条，每页 20 条' }"
                                                size="small"
                                                style="margin-bottom: 8px"
                                                row-key="peerIp"
                                                :scroll="{ y: 180 }"
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
                                                <a-input
                                                    v-model:value="routePrefixFilter"
                                                    allow-clear
                                                    placeholder="Prefix 或 Prefix/Mask"
                                                    style="width: 220px"
                                                    @press-enter="searchBgpRoutes"
                                                />
                                                <a-tag color="green">当前 {{ routeSummary.active }}</a-tag>
                                                <a-tag color="orange">过期 {{ routeSummary.stale }}</a-tag>
                                                <a-button type="primary" @click="searchBgpRoutes">查询</a-button>
                                                <a-button
                                                    danger
                                                    :disabled="routeSummary.stale === 0"
                                                    @click="purgeStaleRoutes"
                                                >
                                                    清理过期
                                                </a-button>
                                            </div>
                                            <a-table
                                                class="route-table"
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
                                                :scroll="{ y: 320 }"
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
            <template v-if="currentDetails">
                <template v-if="detailsDrawerMode === 'route'">
                    <pre v-if="currentDetails.summary" class="route-summary-pre">{{ currentDetails.summary }}</pre>
                    <a-empty v-else description="暂无解析结果" />
                </template>
                <pre v-else>{{ JSON.stringify(currentDetails, null, 2) }}</pre>
            </template>
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
    const clientTabBarStyle = { width: '128px', flex: '0 0 128px' };

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
    const detailsDrawerMode = ref('json');
    const currentDetails = ref(null);

    const getClientKey = client =>
        `${client.localIp}|${client.localPort}|${client.remoteIp}|${client.remotePort}`;

    const getSessionKey = session =>
        `${session.sessionType}|${session.sessionRd}|${session.sessionIp}|${session.sessionAs}`;

    // View peer details
    const viewSessionDetails = record => {
        detailsDrawerMode.value = 'json';
        currentDetails.value = record;
        detailsDrawerTitle.value = `Session 详情: ${record.sessionIp}`;
        detailsDrawerVisible.value = true;
    };

    const viewRouteDetails = async record => {
        detailsDrawerMode.value = 'route';
        detailsDrawerTitle.value = `路由详情: ${record.ip || ''}`;
        detailsDrawerVisible.value = true;
        currentDetails.value = null;

        if (
            !activeClientKey.value ||
            !activeBgpSessionKey.value ||
            activeLocRibAf.value === null ||
            activeLocRibAf.value === undefined ||
            !activeLocRibType.value
        ) {
            currentDetails.value = record;
            return;
        }

        const [localIp, localPort, remoteIp, remotePort] = activeClientKey.value.split('|');
        const [sessionType, sessionRd, sessionIp, sessionAs] = activeBgpSessionKey.value.split('|');
        const client = { localIp, localPort, remoteIp, remotePort };
        const sessionInfo = { sessionType, sessionRd, sessionIp, sessionAs };
        const routeKey = record.routeKey || `${record.pathId}|${record.rd}|${record.ip}|${record.mask}`;

        try {
            const res = await window.bmpApi.getBgpRouteDetail(
                client,
                sessionInfo,
                activeLocRibAf.value,
                activeLocRibType.value,
                routeKey
            );
            if (res.status === 'success' && res.data) {
                currentDetails.value = res.data;
            } else {
                currentDetails.value = record;
                message.error('查询路由详情失败');
            }
        } catch (error) {
            console.error(error);
            currentDetails.value = record;
            message.error('查询路由详情失败');
        }
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

    const formatClientTab = client => {
        return client.remoteIp || '-';
    };

    const formatClientTitle = client => {
        const sysDesc = client.sysDesc || client.sysName || '-';
        return `${sysDesc} | ${client.remoteIp || '-'}:${client.remotePort || '-'} -> ${client.localIp || '-'}:${client.localPort || '-'}`;
    };

    // Close details drawer
    const closeDetailsDrawer = () => {
        detailsDrawerVisible.value = false;
        detailsDrawerMode.value = 'json';
        currentDetails.value = null;
    };

    const onTerminationHandler = result => {
        if (result.status === 'success') {
            const data = result.data;
            if (data) {
                // 特定客户端终止的情况
                const existingIndex = clientList.value.findIndex(client => getClientKey(client) === getClientKey(data));
                if (existingIndex !== -1) {
                    clientList.value.splice(existingIndex, 1);

                    if (getClientKey(data) === activeClientKey.value) {
                        activeClientKey.value = clientList.value.length > 0 ? getClientKey(clientList.value[0]) : '';
                    }
                }
            } else {
                // BMP 服务停止，清空所有数据
                clientList.value = [];
                activeClientKey.value = '';
                bgpSessionList.value = [];
                resetSessionAndRouteSelection();
            }

            if (clientList.value.length === 0) {
                activeClientKey.value = '';
                bgpSessionList.value = [];
                resetSessionAndRouteSelection();
            }
        } else {
            console.error('termination handler error', result.msg);
        }
    };

    const onRouteUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const update = result.data;

        const clientKey = getClientKey(update.client);
        if (clientKey !== activeClientKey.value) return;

        const sessKey = getSessionKey(update.session);
        if (sessKey === activeBgpSessionKey.value) {
            if (
                sameSelectorValue(update.af, activeLocRibAf.value) &&
                sameSelectorValue(update.ribType, activeLocRibType.value)
            ) {
                scheduleRouteRefresh();
            }
        }
    };

    const onSessionUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const data = result.data;

        const clientKey = getClientKey(data.client);
        if (clientKey !== activeClientKey.value) return;
        loadBgpSessionList();
    };

    const onClientListUpdate = result => {
        if (result.status === 'success') {
            // 存在则更新，否则添加
            const existingIndex = clientList.value.findIndex(client => getClientKey(client) === getClientKey(result.data));
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

    const activeBgpSessionKey = ref('');
    const activeLocRibAf = ref(null);
    const activeLocRibType = ref('');
    const bgpRouteList = ref([]);
    const routeStateFilter = ref(BMP_ROUTE_STATE_FILTER.ALL);
    const routePrefixFilter = ref('');
    const appliedRoutePrefixFilter = ref('');
    const routeSummary = ref({ active: 0, stale: 0, total: 0 });
    let sessionListRequestId = 0;
    let routeListRequestId = 0;
    const ROUTE_AUTO_REFRESH_INTERVAL_MS = 1500;
    let routeAutoRefreshTimer = null;
    let lastRouteAutoRefreshAt = 0;

    const clearScheduledRouteRefresh = () => {
        if (routeAutoRefreshTimer) {
            clearTimeout(routeAutoRefreshTimer);
            routeAutoRefreshTimer = null;
        }
    };

    const scheduleRouteRefresh = () => {
        if (routeAutoRefreshTimer) {
            return;
        }

        const delay = Math.max(0, ROUTE_AUTO_REFRESH_INTERVAL_MS - (Date.now() - lastRouteAutoRefreshAt));
        routeAutoRefreshTimer = setTimeout(() => {
            routeAutoRefreshTimer = null;
            lastRouteAutoRefreshAt = Date.now();
            bgpRoutePagination.value.current = 1;
            loadBgpRoutes();
        }, delay);
    };

    const resetRouteData = () => {
        clearScheduledRouteRefresh();
        bgpRouteList.value = [];
        bgpRoutePagination.value.total = 0;
        routeSummary.value = { active: 0, stale: 0, total: 0 };
    };

    const resetSessionAndRouteSelection = () => {
        activeBgpSessionKey.value = '';
        activeLocRibAf.value = null;
        activeLocRibType.value = '';
        resetRouteData();
    };

    const sameSelectorValue = (left, right) => `${left}` === `${right}`;

    const getActiveSession = () => {
        return bgpSessionList.value.find(session => getSessionKey(session) === activeBgpSessionKey.value) || null;
    };

    const syncActiveRouteSelectors = session => {
        const enabledAddrFamilyTypes = Array.isArray(session?.enabledAddrFamilyTypes) ? session.enabledAddrFamilyTypes : [];
        const ribTypes = Array.isArray(session?.ribTypes) ? session.ribTypes : [];

        if (!session || enabledAddrFamilyTypes.length === 0 || ribTypes.length === 0) {
            activeLocRibAf.value = null;
            activeLocRibType.value = '';
            resetRouteData();
            return false;
        }

        if (!enabledAddrFamilyTypes.some(af => sameSelectorValue(af, activeLocRibAf.value))) {
            activeLocRibAf.value = enabledAddrFamilyTypes[0];
        }
        if (!ribTypes.some(ribType => sameSelectorValue(ribType, activeLocRibType.value))) {
            activeLocRibType.value = ribTypes[0];
        }

        return true;
    };

    const isActiveRouteSelectionValid = () => {
        const session = getActiveSession();
        if (!session) return false;

        const enabledAddrFamilyTypes = Array.isArray(session.enabledAddrFamilyTypes) ? session.enabledAddrFamilyTypes : [];
        const ribTypes = Array.isArray(session.ribTypes) ? session.ribTypes : [];
        return (
            enabledAddrFamilyTypes.some(af => sameSelectorValue(af, activeLocRibAf.value)) &&
            ribTypes.some(ribType => sameSelectorValue(ribType, activeLocRibType.value))
        );
    };

    // 加载BGP会话列表
    const loadBgpSessionList = async () => {
        if (!activeClientKey.value) {
            bgpSessionList.value = [];
            resetSessionAndRouteSelection();
            return;
        }

        const requestId = ++sessionListRequestId;
        const requestClientKey = activeClientKey.value;
        try {
            const [localIp, localPort, remoteIp, remotePort] = activeClientKey.value.split('|');
            const clientInfo = {
                localIp,
                localPort,
                remoteIp,
                remotePort
            };

            const bgpSessionListResult = await window.bmpApi.getBgpSessions(clientInfo);
            if (requestId !== sessionListRequestId || requestClientKey !== activeClientKey.value) {
                return;
            }

            if (bgpSessionListResult.status === 'success') {
                bgpSessionList.value = bgpSessionListResult.data || [];
                if (bgpSessionList.value.length > 0) {
                    const first = bgpSessionList.value[0];
                    const activeSessionExists = bgpSessionList.value.some(
                        session => getSessionKey(session) === activeBgpSessionKey.value
                    );
                    if (!activeSessionExists) {
                        activeBgpSessionKey.value = getSessionKey(first);
                    }
                    const canLoadRoutes = syncActiveRouteSelectors(getActiveSession());
                    bgpRoutePagination.value.current = 1;
                    if (canLoadRoutes) {
                        loadBgpRoutes();
                    }
                } else {
                    resetSessionAndRouteSelection();
                }
            } else {
                bgpSessionList.value = [];
                resetSessionAndRouteSelection();
                message.error('获取BGP邻居列表失败');
            }
        } catch (error) {
            if (requestId !== sessionListRequestId || requestClientKey !== activeClientKey.value) {
                return;
            }
            console.error(error);
            bgpSessionList.value = [];
            resetSessionAndRouteSelection();
            message.error('获取BGP邻居列表失败');
        }
    };

    // 监听activeClientKey变化，加载对应的peer列表 AND instances
    watch(activeClientKey, newKey => {
        bgpSessionList.value = [];
        resetSessionAndRouteSelection();
        if (newKey) {
            loadBgpSessionList();
        }
    });

    onActivated(async () => {
        clientList.value = [];
        activeClientKey.value = '';
        bgpSessionList.value = [];
        resetSessionAndRouteSelection();

        EventBus.on('bmp:sessionUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onSessionUpdate);
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onClientListUpdate);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onTerminationHandler);
        EventBus.on('bmp:routeUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onRouteUpdate);

        await loadClientList();
    });

    onDeactivated(() => {
        clearScheduledRouteRefresh();
        EventBus.off('bmp:sessionUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION);
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION);
        EventBus.off('bmp:routeUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION);
    });

    const bgpRoutePagination = ref({
        current: 1,
        pageSize: 20,
        total: 0,
        showSizeChanger: false,
        position: ['bottomCenter'],
        showTotal: total => '共 ' + total + ' 条，每页 20 条',
        onChange: page => {
            bgpRoutePagination.value.current = page;
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

    const searchBgpRoutes = () => {
        appliedRoutePrefixFilter.value = (routePrefixFilter.value || '').trim();
        bgpRoutePagination.value.current = 1;
        loadBgpRoutes();
    };

    const loadBgpRoutes = async () => {
        if (
            !activeClientKey.value ||
            !activeBgpSessionKey.value ||
            activeLocRibAf.value === null ||
            activeLocRibAf.value === undefined ||
            !activeLocRibType.value
        ) {
            resetRouteData();
            return;
        }

        if (!isActiveRouteSelectionValid()) {
            syncActiveRouteSelectors(getActiveSession());
            return;
        }

        const requestId = ++routeListRequestId;
        const requestKey = `${activeClientKey.value}|${activeBgpSessionKey.value}|${activeLocRibAf.value}|${activeLocRibType.value}|${bgpRoutePagination.value.current}|${routeStateFilter.value}|${appliedRoutePrefixFilter.value}`;

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
                routeStateFilter.value,
                appliedRoutePrefixFilter.value
            );
            const currentKey = `${activeClientKey.value}|${activeBgpSessionKey.value}|${activeLocRibAf.value}|${activeLocRibType.value}|${bgpRoutePagination.value.current}|${routeStateFilter.value}|${appliedRoutePrefixFilter.value}`;
            if (requestId !== routeListRequestId || requestKey !== currentKey) {
                return;
            }

            if (res.status === 'success' && res.data) {
                bgpRouteList.value = res.data.list;
                bgpRoutePagination.value.total = res.data.total;
                routeSummary.value = res.data.summary || { active: 0, stale: 0, total: 0 };
            } else {
                resetRouteData();
            }
        } catch (e) {
            if (requestId !== routeListRequestId) {
                return;
            }
            resetRouteData();
            console.error(e);
            message.error('Load routes failed');
        }
    };

    const purgeStaleRoutes = async () => {
        if (
            !activeClientKey.value ||
            !activeBgpSessionKey.value ||
            activeLocRibAf.value === null ||
            activeLocRibAf.value === undefined ||
            !activeLocRibType.value ||
            !isActiveRouteSelectionValid()
        )
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

    watch(activeBgpSessionKey, newKey => {
        bgpRoutePagination.value.current = 1;
        if (!newKey) {
            resetRouteData();
            return;
        }

        if (syncActiveRouteSelectors(getActiveSession())) {
            loadBgpRoutes();
        }
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
    .client-tab-label {
        display: inline-block;
        max-width: 104px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: bottom;
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

    .route-summary-pre {
        padding: 8px;
        margin-bottom: 8px;
        white-space: pre-wrap;
        background-color: #f6f8fa;
        border: 1px solid #e5e7eb;
        border-radius: 4px;
    }

    :deep(.ant-table-body) {
        height: 270px;
    }
</style>
