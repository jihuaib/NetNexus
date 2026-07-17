<template>
    <div class="nn-container bmp-full-page" data-testid="bmp-loc-rib-page">
        <nn-row class="bmp-full-row">
            <nn-col :span="24">
                <nn-card title="BGP Loc-RIB" class="bmp-full-card">
                    <div v-if="clientList.length > 0" class="bmp-tabs-shell">
                        <nn-tabs
                            v-model:active-key="activeClientKey"
                            tab-position="left"
                            class="client-tabs"
                            :tab-bar-style="clientTabBarStyle"
                        >
                            <nn-tab-pane v-for="client in clientList" :key="getClientKey(client)">
                                <template #tab>
                                    <span class="client-tab-label">
                                        <nn-tooltip
                                            class="client-tab-tooltip"
                                            :title="formatClientTab(client)"
                                            placement="right"
                                        >
                                            <span class="client-tab-address">{{ formatClientTab(client) }}</span>
                                        </nn-tooltip>
                                        <span
                                            class="client-connection-state"
                                            :class="isRecordOnline(client) ? 'is-online' : 'is-offline'"
                                        >
                                            {{ formatConnectionState(client) }}
                                        </span>
                                    </span>
                                </template>
                                <div
                                    v-if="getClientKey(client) === activeClientKey && bgpInstances.length > 0"
                                    class="bmp-inner-tabs-shell"
                                >
                                    <nn-tabs v-model:active-key="activeInstanceKey" class="bmp-inner-tabs">
                                        <nn-tab-pane
                                            v-for="instance in bgpInstances"
                                            :key="getInstanceKey(instance)"
                                            :tab="`${formatVrfTableName(instance)} | ${ADDRESS_FAMILY_NAME[instance.addrFamilyType]}`"
                                        >
                                            <template v-if="getInstanceKey(instance) === activeInstanceKey">
                                                <nn-table
                                                    class="detail-table"
                                                    data-testid="bmp-loc-rib-instance-table"
                                                    :columns="bgpInstanceColumns"
                                                    :data-source="[instance]"
                                                    :pagination="false"
                                                    size="small"
                                                    style="margin-bottom: 8px"
                                                    row-key="peerIp"
                                                    :scroll="{ x: 1242 }"
                                                >
                                                    <template #bodyCell="{ column, record }">
                                                        <template v-if="column.key === 'addPath'">
                                                            <nn-tag v-if="record.isAddPath" color="green">Yes</nn-tag>
                                                            <nn-tag v-else color="red">No</nn-tag>
                                                        </template>
                                                        <template v-else-if="column.key === 'instanceFlags'">
                                                            <nn-tooltip
                                                                :title="getBmpLocRibFlagsName(record.instanceFlags)"
                                                            >
                                                                <span>
                                                                    {{ getBmpLocRibFlagsName(record.instanceFlags) }}
                                                                </span>
                                                            </nn-tooltip>
                                                        </template>
                                                        <template v-else-if="column.key === 'rawInstanceFlags'">
                                                            <span>{{ formatRawFlags(record.rawInstanceFlags) }}</span>
                                                        </template>
                                                        <template v-else-if="column.key === 'tlvCount'">
                                                            <span>{{ getInstanceTlvCount(record) }}</span>
                                                        </template>
                                                        <template v-else-if="column.key === 'connectionStatus'">
                                                            <nn-tag
                                                                :color="isInstanceOnline(record) ? 'green' : 'orange'"
                                                            >
                                                                {{ formatInstanceConnectionState(record) }}
                                                            </nn-tag>
                                                        </template>
                                                        <template v-else-if="column.key === 'action'">
                                                            <nn-button
                                                                type="link"
                                                                size="small"
                                                                @click="viewInstanceDetails(record)"
                                                            >
                                                                详情
                                                            </nn-button>
                                                        </template>
                                                    </template>
                                                </nn-table>
                                                <div class="route-toolbar">
                                                    <div class="route-toolbar-query">
                                                        <nn-radio-group v-model:value="routeStateFilter" size="small">
                                                            <nn-radio-button :value="BMP_ROUTE_STATE_FILTER.ACTIVE">
                                                                当前
                                                            </nn-radio-button>
                                                            <nn-radio-button :value="BMP_ROUTE_STATE_FILTER.ALL">
                                                                全部
                                                            </nn-radio-button>
                                                            <nn-radio-button :value="BMP_ROUTE_STATE_FILTER.STALE">
                                                                过期
                                                            </nn-radio-button>
                                                        </nn-radio-group>
                                                        <nn-input
                                                            v-model:value="routePrefixFilter"
                                                            allow-clear
                                                            placeholder="Prefix 或 Prefix/Mask"
                                                            style="width: 220px"
                                                            @press-enter="searchInstanceRoutes"
                                                        />
                                                        <nn-button type="primary" @click="searchInstanceRoutes">
                                                            查询
                                                        </nn-button>
                                                    </div>
                                                    <div class="route-toolbar-status">
                                                        <nn-tag color="green">当前 {{ routeSummary.active }}</nn-tag>
                                                        <nn-tag color="orange">过期 {{ routeSummary.stale }}</nn-tag>
                                                        <nn-button
                                                            danger
                                                            :disabled="routeSummary.stale === 0"
                                                            @click="purgeStaleInstanceRoutes"
                                                        >
                                                            清理过期
                                                        </nn-button>
                                                    </div>
                                                </div>
                                                <nn-table
                                                    class="route-table"
                                                    data-testid="bmp-loc-rib-route-table"
                                                    :columns="bgpRouteColumns"
                                                    :data-source="bgpRouteList"
                                                    :pagination="bgpRoutePagination"
                                                    :row-key="getRouteRowKey"
                                                    :row-class-name="
                                                        record =>
                                                            getRouteParseStatusRowClass(record.parseStatus) ||
                                                            (record.routeState === BMP_ROUTE_STATE.STALE
                                                                ? 'route-stale-row'
                                                                : '')
                                                    "
                                                    size="small"
                                                    :scroll="{ x: 1546, y: '100%' }"
                                                >
                                                    <template #bodyCell="{ column, record }">
                                                        <template v-if="column.key === 'routeAction'">
                                                            <nn-space size="small">
                                                                <nn-tooltip title="查询路由detail">
                                                                    <nn-button
                                                                        type="text"
                                                                        size="small"
                                                                        @click="viewRouteDetailJson(record)"
                                                                    >
                                                                        <template #icon><ProfileOutlined /></template>
                                                                    </nn-button>
                                                                </nn-tooltip>
                                                            </nn-space>
                                                        </template>
                                                        <template v-else-if="column.key === 'parseStatus'">
                                                            <nn-tag
                                                                :color="getRouteParseStatusColor(record.parseStatus)"
                                                            >
                                                                {{ getRouteParseStatusText(record.parseStatus) }}
                                                            </nn-tag>
                                                        </template>
                                                    </template>
                                                </nn-table>
                                            </template>
                                        </nn-tab-pane>
                                    </nn-tabs>
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
            width="500px"
            @close="closeDetailsDrawer"
        >
            <template v-if="currentDetails">
                <pre>{{ JSON.stringify(currentDetails, null, 2) }}</pre>
            </template>
        </nn-drawer>
    </div>
</template>

<script setup>
    import { ref, onActivated, watch, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import { formatBmpClientLabel } from '../../utils/bmpClientLabel';
    import { ProfileOutlined } from '../../ui/icons';
    import {
        BMP_SESSION_TYPE_NAME,
        BMP_SESSION_STATE_NAME,
        BMP_EVENT_PAGE_ID,
        BMP_ROUTE_STATE,
        BMP_ROUTE_STATE_FILTER,
        getBmpLocRibFlagsName
    } from '../../const/bmpConst';
    import { ADDRESS_FAMILY_NAME } from '../../const/bgpConst';
    import {
        getRouteParseStatusColor,
        getRouteParseStatusRowClass,
        getRouteParseStatusText
    } from '../../utils/routeParseStatus';
    import EventBus from '../../utils/eventBus';
    defineOptions({
        name: 'BgpLocRib'
    });

    // 客户端
    const clientList = ref([]);
    const activeClientKey = ref('');
    const clientTabBarStyle = { width: '148px', flex: '0 0 148px' };

    const getClientTransportKey = client =>
        `${client?.localIp || ''}|${client?.localPort || ''}|${client?.remoteIp || ''}|${client?.remotePort || ''}`;

    const getClientKey = client =>
        client?.persistentSourceId
            ? `source:${client.persistentSourceId}`
            : `connection:${getClientTransportKey(client)}`;

    const isSameClient = (left, right) => {
        if (!left || !right) return false;
        if (left.persistentSourceId && right.persistentSourceId) {
            return left.persistentSourceId === right.persistentSourceId;
        }
        return getClientTransportKey(left) === getClientTransportKey(right);
    };

    const getActiveClient = () =>
        clientList.value.find(client => getClientKey(client) === activeClientKey.value) || null;

    const getActiveClientApiInfo = () => {
        const client = getActiveClient();
        if (!client) return null;
        return {
            localIp: client.localIp,
            localPort: client.localPort,
            remoteIp: client.remoteIp,
            remotePort: client.remotePort,
            persistentSourceId: client.persistentSourceId || null,
            persistentConnectionId: client.persistentConnectionId || null
        };
    };

    const getRecordOnlineState = record => {
        if (typeof record?.isOnline === 'boolean') return record.isOnline;
        if (typeof record?.online === 'boolean') return record.online;
        const state = String(record?.connectionState || '').toLowerCase();
        if (['offline', 'disconnected', 'closed', 'down'].includes(state)) return false;
        if (['online', 'connected', 'open', 'up'].includes(state)) return true;
        return null;
    };

    const isRecordOnline = record => getRecordOnlineState(record) ?? true;

    const isInstanceOnline = instance => getRecordOnlineState(instance) ?? isRecordOnline(getActiveClient());

    const formatConnectionState = record => (isRecordOnline(record) ? '在线' : '已断开');

    const formatInstanceConnectionState = instance => (isInstanceOnline(instance) ? '在线' : '已断开');

    const formatRawFlags = flags => {
        if (flags === null || flags === undefined) return '-';
        return `0x${Number(flags).toString(16).padStart(2, '0')}`;
    };

    const normalizeRoutePathId = pathId => {
        const numericPathId = Number(pathId);
        return Number.isInteger(numericPathId) ? numericPathId : 0;
    };

    const normalizeRouteRd = rd => (rd === null || rd === undefined || rd === '' ? '0:0' : String(rd));

    const getRouteKey = record => {
        if (record.routeKey) {
            return record.routeKey;
        }
        return `${normalizeRoutePathId(record.pathId)}|${record.rdRaw || normalizeRouteRd(record.rd)}|${record.ip}|${record.mask}`;
    };

    const getRouteRowKey = record => `${record.addrFamilyType}|${getRouteKey(record)}`;

    const formatClientTab = client => {
        return formatBmpClientLabel(client);
    };

    const getInstanceIdentityKey = instance =>
        `${instance?.instanceType}|${instance?.instanceRdRaw || instance?.instanceRd}|${instance?.addrFamilyType}`;

    const getInstanceScopeId = instance => instance?.persistentScopeId || instance?.scopeId || null;

    const getInstanceKey = instance =>
        getInstanceScopeId(instance) ? `scope:${getInstanceScopeId(instance)}` : getInstanceIdentityKey(instance);

    const isSameInstance = (left, right) => {
        if (!left || !right) return false;
        const leftScopeId = getInstanceScopeId(left);
        const rightScopeId = getInstanceScopeId(right);
        if (leftScopeId && rightScopeId) {
            return leftScopeId === rightScopeId;
        }
        return getInstanceIdentityKey(left) === getInstanceIdentityKey(right);
    };

    const formatVrfTableName = instance => {
        return Array.isArray(instance.vrfTableNames) && instance.vrfTableNames.length > 0
            ? instance.vrfTableNames.join(', ')
            : `${instance.instanceType} | ${instance.instanceRd}`;
    };

    const getInstanceTlvCount = record => {
        return (record.peerUpTlvs || []).length + (record.lastRouteMonitoringTlvs || []).length;
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
            title: '连接',
            key: 'connectionStatus',
            width: 80,
            align: 'center'
        },
        {
            title: '操作',
            key: 'action',
            fixed: 'right',
            width: 72,
            align: 'center'
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

    const markClientOffline = client => {
        const existing = clientList.value.find(item => isSameClient(item, client));
        if (existing) {
            existing.isOnline = false;
            existing.connectionState = 'offline';
        }
        if (isSameClient(client, getActiveClient())) {
            bgpInstances.value = bgpInstances.value.map(instance => ({
                ...instance,
                isOnline: false,
                connectionState: 'offline'
            }));
        }
    };

    const onTerminationHandler = result => {
        if (result.status === 'success') {
            const data = result.data;
            if (data) {
                markClientOffline(data);
                setTimeout(loadClientList, 50);
            } else {
                clientList.value = [];
                activeClientKey.value = '';
                bgpInstances.value = [];
                resetInstanceAndRouteSelection();
            }
        } else {
            console.error('termination handler error', result.msg);
        }
    };

    const onInstanceRouteUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const updates = Array.isArray(result.data.updates) ? result.data.updates : [result.data];
        const activeClient = getActiveClient();
        const activeInstance = getActiveInstance();
        if (!activeClient || !activeInstance) return;

        const activeSourceId = activeClient.persistentSourceId || activeClient.sourceId || null;
        const activeScopeId = getInstanceScopeId(activeInstance);
        const shouldRefresh = updates.some(update => {
            if (!update) return false;
            const updateSourceId =
                update.sourceId ||
                update.persistentSourceId ||
                update.client?.sourceId ||
                update.client?.persistentSourceId ||
                null;
            const sourceMatches =
                activeSourceId && updateSourceId
                    ? activeSourceId === updateSourceId
                    : getClientKey(update.client) === activeClientKey.value;
            if (!sourceMatches) return false;

            const updateScopeId =
                update.scopeId ||
                update.persistentScopeId ||
                update.instance?.scopeId ||
                update.instance?.persistentScopeId ||
                null;
            if (activeScopeId && updateScopeId) {
                return activeScopeId === updateScopeId;
            }

            return getInstanceKey(update.instance) === activeInstanceKey.value;
        });

        if (!shouldRefresh) return;

        const selection = captureRouteSelection();
        if (selection) scheduleRouteRefresh(selection);
    };

    const onInstanceUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const { client, instance } = result.data;

        if (!client || !instance || !isSameClient(client, getActiveClient())) return;

        upsertBgpInstance(instance);
    };

    const onClientListUpdate = result => {
        if (result.status === 'success') {
            // 存在则更新，否则添加
            const existingIndex = clientList.value.findIndex(client => isSameClient(client, result.data));
            if (existingIndex !== -1) {
                const wasActive = getClientKey(clientList.value[existingIndex]) === activeClientKey.value;
                clientList.value[existingIndex] = result.data;
                if (wasActive) {
                    activeClientKey.value = getClientKey(result.data);
                }
            } else {
                clientList.value.push(result.data);
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
                const nextClientList = clientListResult.data || [];
                const selectedClient = getActiveClient();
                clientList.value = nextClientList;

                if (clientList.value.length > 0) {
                    const matchingClient = selectedClient
                        ? clientList.value.find(client => isSameClient(client, selectedClient))
                        : null;
                    activeClientKey.value = getClientKey(matchingClient || clientList.value[0]);
                } else {
                    activeClientKey.value = '';
                }
            }
        } catch (error) {
            console.error(error);
            notify.error('加载数据失败');
        }
    };

    const bgpRouteList = ref([]);
    const routeStateFilter = ref(BMP_ROUTE_STATE_FILTER.ALL);
    const routePrefixFilter = ref('');
    const appliedRoutePrefixFilter = ref('');
    const routeSummary = ref({ active: 0, stale: 0, total: 0 });
    let instanceListRequestId = 0;
    let routeListRequestId = 0;
    const ROUTE_AUTO_REFRESH_INTERVAL_MS = 1500;
    let routeAutoRefreshTimer = null;
    let scheduledRouteSelection = null;
    let lastRouteAutoRefreshAt = 0;

    const captureRouteSelection = () => {
        const instance = getActiveInstance();
        if (!activeClientKey.value || !activeInstanceKey.value || !instance) return null;
        return {
            clientKey: activeClientKey.value,
            instanceKey: activeInstanceKey.value,
            scopeId: getInstanceScopeId(instance),
            page: bgpRoutePagination.value.current,
            pageSize: bgpRoutePagination.value.pageSize,
            routeState: routeStateFilter.value,
            prefixFilter: appliedRoutePrefixFilter.value
        };
    };

    const isCurrentRouteSelection = selection => {
        if (!selection) return false;
        const current = captureRouteSelection();
        if (!current) return false;
        return (
            current.clientKey === selection.clientKey &&
            current.instanceKey === selection.instanceKey &&
            current.scopeId === selection.scopeId &&
            current.page === selection.page &&
            current.pageSize === selection.pageSize &&
            current.routeState === selection.routeState &&
            current.prefixFilter === selection.prefixFilter
        );
    };

    const isSameRouteSelection = (left, right) => {
        if (!left || !right) return false;
        return (
            left.clientKey === right.clientKey &&
            left.instanceKey === right.instanceKey &&
            left.scopeId === right.scopeId &&
            left.page === right.page &&
            left.pageSize === right.pageSize &&
            left.routeState === right.routeState &&
            left.prefixFilter === right.prefixFilter
        );
    };

    const clearScheduledRouteRefresh = () => {
        if (routeAutoRefreshTimer) {
            clearTimeout(routeAutoRefreshTimer);
            routeAutoRefreshTimer = null;
        }
        scheduledRouteSelection = null;
    };

    const scheduleRouteRefresh = selection => {
        if (!selection || !isCurrentRouteSelection(selection)) {
            return;
        }
        if (routeAutoRefreshTimer) {
            if (isSameRouteSelection(selection, scheduledRouteSelection)) {
                return;
            }
            clearScheduledRouteRefresh();
        }

        scheduledRouteSelection = selection;
        const delay = Math.max(0, ROUTE_AUTO_REFRESH_INTERVAL_MS - (Date.now() - lastRouteAutoRefreshAt));
        routeAutoRefreshTimer = setTimeout(() => {
            routeAutoRefreshTimer = null;
            scheduledRouteSelection = null;
            if (!isCurrentRouteSelection(selection)) {
                return;
            }
            lastRouteAutoRefreshAt = Date.now();
            loadInstanceRoutes({ background: true, expectedSelection: selection, clampOutOfRange: true });
        }, delay);
    };

    const resetRouteData = () => {
        clearScheduledRouteRefresh();
        bgpRouteList.value = [];
        bgpRoutePagination.value.total = 0;
        routeSummary.value = { active: 0, stale: 0, total: 0 };
    };

    const resetInstanceAndRouteSelection = () => {
        activeInstanceKey.value = '';
        resetRouteData();
    };

    // Instance Logic
    const bgpInstances = ref([]);
    const activeInstanceKey = ref('');
    let activeInstanceKeyWithoutRouteReload = null;

    const getActiveInstance = () =>
        bgpInstances.value.find(instance => getInstanceKey(instance) === activeInstanceKey.value) || null;

    const upsertBgpInstance = instance => {
        const existingIndex = bgpInstances.value.findIndex(item => {
            const itemScopeId = getInstanceScopeId(item);
            const updateScopeId = getInstanceScopeId(instance);
            return (itemScopeId && updateScopeId && itemScopeId === updateScopeId) || isSameInstance(item, instance);
        });

        if (existingIndex >= 0) {
            const existing = bgpInstances.value[existingIndex];
            const previousKey = getInstanceKey(existing);
            const wasActive = previousKey === activeInstanceKey.value;
            Object.assign(existing, instance);
            const nextKey = getInstanceKey(existing);
            if (wasActive && nextKey !== previousKey) {
                clearScheduledRouteRefresh();
                activeInstanceKeyWithoutRouteReload = nextKey;
                activeInstanceKey.value = nextKey;
            }
            return;
        }

        bgpInstances.value.push(instance);
        if (!activeInstanceKey.value) {
            activeInstanceKey.value = getInstanceKey(instance);
        }
    };

    const getActiveInstanceApiInfo = () => {
        const instance = getActiveInstance();
        if (!instance) {
            return null;
        }
        return {
            instanceType: instance.instanceType,
            instanceRd: instance.instanceRd,
            instanceRdRaw: instance.instanceRdRaw || null,
            addrFamilyType: instance.addrFamilyType,
            persistentOwnerKey: instance.persistentOwnerKey || null,
            persistentScopeId: getInstanceScopeId(instance)
        };
    };

    const loadBgpInstances = async () => {
        if (!activeClientKey.value) {
            bgpInstances.value = [];
            resetInstanceAndRouteSelection();
            return;
        }

        const requestId = ++instanceListRequestId;
        const requestClientKey = activeClientKey.value;
        try {
            const clientInfo = getActiveClientApiInfo();
            if (!clientInfo) {
                bgpInstances.value = [];
                resetInstanceAndRouteSelection();
                return;
            }
            const selectedInstance = getActiveInstance();
            const res = await window.bmpApi.getBgpInstances(clientInfo);
            if (requestId !== instanceListRequestId || requestClientKey !== activeClientKey.value) {
                return;
            }
            if (res.status === 'success') {
                bgpInstances.value = res.data || [];
                if (bgpInstances.value.length > 0) {
                    const matchingInstance = selectedInstance
                        ? bgpInstances.value.find(instance => isSameInstance(instance, selectedInstance))
                        : null;
                    activeInstanceKey.value = getInstanceKey(matchingInstance || bgpInstances.value[0]);
                    bgpRoutePagination.value.current = 1;
                    loadInstanceRoutes();
                } else {
                    resetInstanceAndRouteSelection();
                }
            } else {
                bgpInstances.value = [];
                resetInstanceAndRouteSelection();
            }
        } catch (error) {
            if (requestId !== instanceListRequestId || requestClientKey !== activeClientKey.value) {
                return;
            }
            console.error(error);
            bgpInstances.value = [];
            resetInstanceAndRouteSelection();
            notify.error('Load BMP instances failed');
        }
    };

    const searchInstanceRoutes = () => {
        clearScheduledRouteRefresh();
        appliedRoutePrefixFilter.value = (routePrefixFilter.value || '').trim();
        bgpRoutePagination.value.current = 1;
        loadInstanceRoutes();
    };

    const loadInstanceRoutes = async (options = {}) => {
        const background = options.background === true;
        if (options.expectedSelection && !isCurrentRouteSelection(options.expectedSelection)) {
            return;
        }
        if (!activeClientKey.value || !activeInstanceKey.value) {
            if (!background) resetRouteData();
            return;
        }

        const client = getActiveClientApiInfo();
        if (!client) {
            if (!background) resetRouteData();
            return;
        }

        const instance = getActiveInstanceApiInfo();
        if (!instance) {
            if (!background) resetRouteData();
            return;
        }

        const requestSelection = captureRouteSelection();
        if (!requestSelection) {
            if (!background) resetRouteData();
            return;
        }
        const page = requestSelection.page;
        const pageSize = requestSelection.pageSize;
        const requestId = ++routeListRequestId;

        try {
            const res = await window.bmpApi.getBgpInstanceRoutes(
                client,
                instance,
                page,
                pageSize,
                requestSelection.routeState,
                requestSelection.prefixFilter
            );
            if (requestId !== routeListRequestId || !isCurrentRouteSelection(requestSelection)) {
                return;
            }
            if (res.status === 'success' && res.data) {
                const total = Math.max(0, Number(res.data.total) || 0);
                const lastPage = Math.max(1, Math.ceil(total / pageSize));
                if (options.clampOutOfRange === true && page > lastPage) {
                    bgpRoutePagination.value.current = lastPage;
                    const clampedSelection = captureRouteSelection();
                    if (clampedSelection) {
                        await loadInstanceRoutes({
                            background,
                            expectedSelection: clampedSelection,
                            clampOutOfRange: false
                        });
                    }
                    return;
                }
                bgpRouteList.value = Array.isArray(res.data.list) ? res.data.list : [];
                bgpRoutePagination.value.total = total;
                routeSummary.value = res.data.summary || { active: 0, stale: 0, total: 0 };
            } else if (!background) {
                resetRouteData();
            }
        } catch (e) {
            if (requestId !== routeListRequestId || !isCurrentRouteSelection(requestSelection)) return;
            console.error(e);
            if (!background) {
                resetRouteData();
                notify.error('Load instance routes failed');
            }
        }
    };

    const purgeStaleInstanceRoutes = async () => {
        if (!activeClientKey.value || !activeInstanceKey.value) return;

        const client = getActiveClientApiInfo();
        if (!client) return;

        const instance = getActiveInstanceApiInfo();
        if (!instance) return;

        try {
            const res = await window.bmpApi.purgeStaleBgpInstanceRoutes(client, instance);
            if (res.status === 'success') {
                notify.success(`已清理 ${res.data?.deleted || 0} 条过期路由`);
                bgpRoutePagination.value.current = 1;
                loadInstanceRoutes();
            } else {
                notify.error('清理过期路由失败');
            }
        } catch (e) {
            console.error(e);
            notify.error('清理过期路由失败');
        }
    };

    const viewInstanceDetails = record => {
        currentDetails.value = record;
        detailsDrawerTitle.value = `Instance 详情: ${record.instanceRd}`;
        detailsDrawerVisible.value = true;
    };

    const viewRouteDetailJson = async record => {
        detailsDrawerTitle.value = `路由detail: ${record.ip || ''}`;
        detailsDrawerVisible.value = true;
        currentDetails.value = null;

        if (!activeClientKey.value || !activeInstanceKey.value) {
            currentDetails.value = record;
            return;
        }

        const client = getActiveClientApiInfo();
        if (!client) {
            currentDetails.value = record;
            return;
        }
        const instance = getActiveInstanceApiInfo();
        if (!instance) {
            currentDetails.value = record;
            return;
        }
        const routeKey = getRouteKey(record);

        try {
            const res = await window.bmpApi.getBgpInstanceRouteDetail(client, instance, routeKey);
            if (res.status === 'success' && res.data) {
                currentDetails.value = res.data;
            } else {
                currentDetails.value = record;
                notify.error('查询路由detail失败');
            }
        } catch (error) {
            console.error(error);
            currentDetails.value = record;
            notify.error('查询路由detail失败');
        }
    };

    // 监听activeClientKey变化，加载对应的peer列表 AND instances
    watch(activeClientKey, newKey => {
        clearScheduledRouteRefresh();
        activeInstanceKey.value = '';
        resetRouteData();
        bgpInstances.value = [];
        if (newKey) {
            loadBgpInstances();
        }
    });

    onActivated(async () => {
        const previousActiveClientKey = activeClientKey.value;

        EventBus.on('bmp:instanceUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onInstanceUpdate);
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onClientListUpdate);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onTerminationHandler);
        EventBus.on('bmp:instanceRouteUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onInstanceRouteUpdate);

        await loadClientList();
        // activeClientKey 变化时 watcher 会负责加载；缓存回切且选择未变时只刷新一次。
        if (activeClientKey.value && activeClientKey.value === previousActiveClientKey) {
            await loadBgpInstances();
        }
    });

    onDeactivated(() => {
        clearScheduledRouteRefresh();
        EventBus.off('bmp:instanceUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
        EventBus.off('bmp:instanceRouteUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
    });

    const bgpRoutePagination = ref({
        current: 1,
        pageSize: 25,
        total: 0,
        showSizeChanger: false,
        position: ['bottomCenter'],
        showTotal: total => '共 ' + total + ' 条，每页 25 条',
        onChange: page => {
            clearScheduledRouteRefresh();
            bgpRoutePagination.value.current = page;
            loadInstanceRoutes();
        }
    });

    const bgpRouteColumns = [
        { title: 'Prefix', dataIndex: 'ip', key: 'ip', ellipsis: true, width: 120 },
        { title: 'Mask', dataIndex: 'mask', key: 'mask', ellipsis: true, width: 60 },
        { title: 'Next Hop', dataIndex: 'nextHop', key: 'nextHop', ellipsis: true, width: 120 },
        { title: 'AS Path', dataIndex: 'asPath', key: 'asPath', ellipsis: true, width: 180 },
        { title: 'RD', dataIndex: 'rd', key: 'rd', ellipsis: true, width: 100 },
        { title: 'Path ID', dataIndex: 'pathId', key: 'pathId', ellipsis: true, width: 100 },
        { title: 'Labels', dataIndex: 'labels', key: 'labels', ellipsis: true, width: 100 },
        { title: '解析', dataIndex: 'parseStatus', key: 'parseStatus', width: 90, align: 'center' },
        {
            title: 'TLV数量',
            dataIndex: 'routeTlvCount',
            key: 'routeTlvCount',
            width: 80,
            align: 'right',
            customRender: ({ text }) => text || 0
        },
        { title: 'Origin', dataIndex: 'origin', key: 'origin', ellipsis: true, width: 80 },
        { title: 'MED', dataIndex: 'med', key: 'med', ellipsis: true, width: 80 },
        { title: 'Path Status', dataIndex: 'pathStatusText', key: 'pathStatusText', ellipsis: true, width: 160 },
        {
            title: 'Reason',
            dataIndex: 'pathStatusReasonText',
            key: 'pathStatusReasonText',
            ellipsis: true,
            width: 180
        },
        { title: '详情', key: 'routeAction', fixed: 'right', width: 96, align: 'center' }
    ];

    watch(activeInstanceKey, newKey => {
        clearScheduledRouteRefresh();
        const skipRouteReload = activeInstanceKeyWithoutRouteReload === newKey;
        activeInstanceKeyWithoutRouteReload = null;
        if (skipRouteReload) return;
        if (newKey) {
            bgpRoutePagination.value.current = 1;
            loadInstanceRoutes();
        }
    });

    watch(routeStateFilter, () => {
        clearScheduledRouteRefresh();
        bgpRoutePagination.value.current = 1;
        loadInstanceRoutes();
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

    .client-tab-label {
        display: flex;
        width: 100%;
        max-width: 132px;
        min-width: 0;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        font-size: 14px;
        line-height: 22px;
        overflow: hidden;
    }

    .client-tab-address {
        display: block;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .client-tab-tooltip {
        width: 100%;
        max-width: 100%;
        min-width: 0;
    }

    .client-tab-tooltip :deep(.nn-tooltip-trigger) {
        max-width: 100%;
        min-width: 0;
    }

    .client-connection-state {
        font-size: 12px;
        line-height: 1;
    }

    .client-connection-state.is-online {
        color: #389e0d;
    }

    .client-connection-state.is-offline {
        color: #d46b08;
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

    .bmp-inner-tabs > :deep(.nn-tabs-nav > .nn-tabs-nav-wrap > .nn-tabs-nav-list > .nn-tabs-tab) {
        padding: 8px 0 !important;
    }

    .client-tabs > :deep(.nn-tabs-nav > .nn-tabs-nav-wrap > .nn-tabs-nav-list > .nn-tabs-tab) {
        justify-content: center;
        padding: 8px;
        text-align: center;
    }

    .client-tabs > :deep(.nn-tabs-nav > .nn-tabs-nav-wrap > .nn-tabs-nav-list > .nn-tabs-tab > .nn-tabs-tab-button) {
        width: 100%;
    }

    .route-toolbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px 16px;
        flex-wrap: wrap;
        margin-bottom: 8px;
    }

    .route-toolbar-query,
    .route-toolbar-status {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        min-width: 0;
    }

    .route-toolbar-query {
        flex: 1 1 auto;
    }

    .route-toolbar-status {
        flex: 0 0 auto;
        margin-left: auto;
    }

    .route-toolbar-status :deep(.nn-tag) {
        margin-inline-end: 0;
    }

    .bgp-peer-info-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        padding: 8px;
        background-color: var(--nn-color-bg-muted);
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
        color: var(--nn-color-text-muted);
        overflow: auto;
    }

    .route-table :deep(.route-stale-row > .nn-table-cell) {
        color: var(--nn-color-text-stale);
        background-color: var(--nn-color-bg-stale) !important;
    }

    .route-table :deep(.route-parse-warning-row > .nn-table-cell) {
        background-color: var(--nn-color-bg-warning-subtle) !important;
    }

    .route-table :deep(.route-parse-error-row > .nn-table-cell) {
        background-color: var(--nn-color-bg-danger-subtle) !important;
    }

    .detail-table {
        flex: 0 0 auto;
        min-width: 0;
    }

    .route-table,
    .route-table :deep(.nn-spin-nested-loading),
    .route-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        height: 100%;
        min-height: 0;
        min-width: 0;
    }

    .route-table :deep(.nn-spin-container) {
        display: flex;
        flex-direction: column;
    }

    .route-table :deep(.nn-table) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .route-table :deep(.nn-table-container) {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .route-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow: auto !important;
    }

    .route-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        margin: 10px 0 0;
    }

    .route-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }
</style>
