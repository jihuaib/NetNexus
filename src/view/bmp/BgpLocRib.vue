<template>
    <div class="nn-container bmp-full-page" data-testid="bmp-loc-rib-page">
        <nn-row class="bmp-full-row">
            <nn-col :span="24">
                <nn-card class="bmp-full-card">
                    <div v-if="monitoredClient && bgpInstances.length > 0" class="bmp-inner-tabs-shell">
                        <nn-tabs v-model:active-key="activeInstanceKey" class="bmp-inner-tabs" size="small">
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
                                                <nn-tooltip :title="getBmpLocRibFlagsName(record.instanceFlags)">
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
                                                <nn-tag :color="isInstanceOnline(record) ? 'green' : 'orange'">
                                                    {{ formatInstanceConnectionState(record) }}
                                                </nn-tag>
                                            </template>
                                            <template v-else-if="column.key === 'action'">
                                                <nn-button
                                                    type="link"
                                                    size="small"
                                                    data-testid="bmp-loc-rib-instance-detail-button"
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
                                            <nn-button type="primary" @click="searchInstanceRoutes">查询</nn-button>
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
                                                (record.routeState === BMP_ROUTE_STATE.STALE ? 'route-stale-row' : '')
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
                                                            data-testid="bmp-loc-rib-route-detail"
                                                            @click="viewRouteDetailJson(record)"
                                                        >
                                                            <template #icon><ProfileOutlined /></template>
                                                        </nn-button>
                                                    </nn-tooltip>
                                                </nn-space>
                                            </template>
                                            <template v-else-if="column.key === 'parseStatus'">
                                                <nn-tag :color="getRouteParseStatusColor(record.parseStatus)">
                                                    {{ getRouteParseStatusText(record.parseStatus) }}
                                                </nn-tag>
                                            </template>
                                        </template>
                                    </nn-table>
                                </template>
                            </nn-tab-pane>
                        </nn-tabs>
                    </div>

                    <div v-else class="no-result-message">
                        <nn-empty :description="emptyDescription" />
                    </div>
                </nn-card>
            </nn-col>
        </nn-row>

        <BmpLocRibInstanceDetailModal
            :open="instanceDetailModalVisible"
            :instance="instanceDetailRecord"
            :client="monitoredClient"
            @update:open="handleInstanceDetailOpenChange"
        />

        <nn-drawer
            v-model:open="detailsDrawerVisible"
            :title="detailsDrawerTitle"
            placement="right"
            :width="routeEventTarget ? '760px' : '500px'"
            @close="closeDetailsDrawer"
        >
            <nn-tabs v-if="routeEventTarget" v-model:active-key="detailsTabKey" size="small">
                <nn-tab-pane key="detail" tab="路由详情">
                    <nn-spin :spinning="routeDetailLoading">
                        <div v-if="routeDetailLoading && !currentDetails" class="route-detail-loading" />
                        <nn-empty v-else-if="!currentDetails" description="暂无路由详情" />
                        <nn-json-viewer v-else class="route-detail-json" :value="currentDetails" wrap />
                    </nn-spin>
                </nn-tab-pane>
                <nn-tab-pane key="history" tab="事件轨迹">
                    <BmpRouteEventTimeline
                        :active="detailsDrawerVisible && detailsTabKey === 'history'"
                        :scope-id="routeEventTarget.scopeId"
                        :route-key="routeEventTarget.routeKey"
                        :route-id="routeEventTarget.routeId"
                    />
                </nn-tab-pane>
            </nn-tabs>
            <nn-json-viewer v-else-if="currentDetails" class="route-detail-json" :value="currentDetails" wrap />
        </nn-drawer>
    </div>
</template>

<script setup>
    import { computed, inject, ref, onActivated, onBeforeUnmount, watch, onDeactivated, onMounted } from 'vue';
    import { useRoute } from 'vue-router';
    import { notify } from '../../utils/notify';
    import { formatBmpClientLabel } from '../../utils/bmpClientLabel';
    import { ProfileOutlined } from 'netnexus-ui/icons';
    import BmpLocRibInstanceDetailModal from '../../components/BmpLocRibInstanceDetailModal.vue';
    import BmpRouteEventTimeline from '../../components/BmpRouteEventTimeline.vue';
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

    const getRouteQueryString = value => {
        const queryValue = Array.isArray(value) ? value[0] : value;
        if (typeof queryValue !== 'string' || queryValue.length === 0 || queryValue.length > 512) {
            return '';
        }
        return hasControlCharacter(queryValue) ? '' : queryValue;
    };

    const lockedClientKey = computed(
        () => getRouteQueryString(props.clientKey) || getRouteQueryString(route.query.clientKey)
    );

    // 客户端
    const monitoredClient = ref(null);
    let monitoredClientRequestId = 0;
    let terminationReloadTimer = null;

    const getClientTransportKey = client =>
        `${client?.localIp || ''}|${client?.localPort || ''}|${client?.remoteIp || ''}|${client?.remotePort || ''}`;

    const getClientKey = client => {
        const sourceId = client?.persistentSourceId || client?.sourceId;
        return sourceId
            ? `source:${String(sourceId).trim().toLowerCase()}`
            : `connection:${getClientTransportKey(client)}`;
    };

    const clientMatchesKey = (client, clientKey) => {
        if (!client || !clientKey) return false;
        if (clientKey.startsWith('source:')) {
            const sourceId = client.persistentSourceId || client.sourceId || '';
            return `source:${String(sourceId).trim().toLowerCase()}` === clientKey;
        }
        if (clientKey.startsWith('connection:')) {
            return `connection:${getClientTransportKey(client)}` === clientKey;
        }
        return false;
    };

    const isSameClient = (left, right) => {
        if (!left || !right) return false;
        const leftSourceId = left.persistentSourceId || left.sourceId;
        const rightSourceId = right.persistentSourceId || right.sourceId;
        if (leftSourceId && rightSourceId) {
            return leftSourceId === rightSourceId;
        }
        return getClientTransportKey(left) === getClientTransportKey(right);
    };

    const getClientConnectionId = client => client?.persistentConnectionId || client?.connectionId || '';

    const getClientRequestIdentity = client => {
        if (!client) return '';
        return `${getClientKey(client)}|${getClientConnectionId(client) || getClientTransportKey(client)}`;
    };

    const monitoredClientKey = computed(() => (monitoredClient.value ? getClientKey(monitoredClient.value) : ''));

    const getMonitoredClientApiInfo = (client = monitoredClient.value) => {
        if (!client) return null;
        return {
            localIp: client.localIp,
            localPort: client.localPort,
            remoteIp: client.remoteIp,
            remotePort: client.remotePort,
            persistentSourceId: client.persistentSourceId || client.sourceId || null,
            persistentConnectionId: client.persistentConnectionId || client.connectionId || null
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

    const isInstanceOnline = instance => getRecordOnlineState(instance) ?? isRecordOnline(monitoredClient.value);

    const monitorWindowTitleText = computed(() => {
        const client = monitoredClient.value;
        const clientLabel = client ? formatBmpClientLabel(client) : '';
        return ['Loc-RIB', clientLabel].filter(Boolean).join(' · ');
    });
    const monitorWindowTitle = inject('monitorWindowTitle', null);
    const monitorTitleOwner = Symbol('bmp-loc-rib-monitor-title');
    watch(
        monitorWindowTitleText,
        title => {
            if (!monitorWindowTitle) return;
            monitorWindowTitle.setTitle(monitorTitleOwner, title);
        },
        { immediate: true }
    );
    onBeforeUnmount(() => monitorWindowTitle?.clearTitle(monitorTitleOwner));

    const emptyDescription = computed(() => {
        if (!lockedClientKey.value) {
            return '缺少有效的 Client 标识';
        }
        return monitoredClient.value ? '当前 Client 暂无 Loc-RIB 数据' : '未找到指定 Client';
    });

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
        return (record.peerUpTlvs || []).length;
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
    const detailsTabKey = ref('detail');
    const routeEventTarget = ref(null);
    const routeDetailLoading = ref(false);
    const instanceDetailModalVisible = ref(false);
    const selectedInstanceDetail = ref(null);
    let routeDetailRequestId = 0;
    let instanceDetailRequestId = 0;
    let instanceDetailRefreshTimer = null;
    const INSTANCE_DETAIL_REFRESH_DEBOUNCE_MS = 120;

    const clearScheduledInstanceDetailRefresh = () => {
        if (instanceDetailRefreshTimer) {
            clearTimeout(instanceDetailRefreshTimer);
            instanceDetailRefreshTimer = null;
        }
    };

    const closeInstanceDetails = () => {
        instanceDetailRequestId += 1;
        clearScheduledInstanceDetailRefresh();
        instanceDetailModalVisible.value = false;
        selectedInstanceDetail.value = null;
    };

    const handleInstanceDetailOpenChange = open => {
        if (open) {
            instanceDetailModalVisible.value = true;
            return;
        }
        closeInstanceDetails();
    };

    // Close details drawer
    const closeDetailsDrawer = () => {
        routeDetailRequestId += 1;
        detailsDrawerVisible.value = false;
        currentDetails.value = null;
        detailsTabKey.value = 'detail';
        routeEventTarget.value = null;
        routeDetailLoading.value = false;
    };

    const clearTerminationReloadTimer = () => {
        if (terminationReloadTimer) {
            clearTimeout(terminationReloadTimer);
            terminationReloadTimer = null;
        }
    };

    const invalidateMonitoredClientRequest = () => {
        monitoredClientRequestId += 1;
        clearTerminationReloadTimer();
    };

    const invalidateClientDependentRequests = () => {
        instanceListRequestId += 1;
        routeListRequestId += 1;
        routeDetailRequestId += 1;
        instanceDetailRequestId += 1;
        routeDetailLoading.value = false;
        clearScheduledInstanceDetailRefresh();
        clearScheduledRouteRefresh();
    };

    const replaceMonitoredClient = (client, options = {}) => {
        const previousClient = monitoredClient.value;
        const previousIdentity = getClientRequestIdentity(previousClient);
        const nextIdentity = getClientRequestIdentity(client);
        const connectionChanged = previousIdentity !== nextIdentity;
        const reconnected = previousClient && client && !isRecordOnline(previousClient) && isRecordOnline(client);

        monitoredClient.value = client;

        if (!client || connectionChanged || reconnected) {
            invalidateClientDependentRequests();
            bgpInstances.value = [];
            resetInstanceAndRouteSelection();
        }

        return Boolean(client) && (options.refreshInstances === true || connectionChanged || reconnected);
    };

    const isTerminationForMonitoredConnection = (terminationClient, currentClient) => {
        if (!isSameClient(terminationClient, currentClient)) return false;

        const terminationConnectionId = getClientConnectionId(terminationClient);
        const currentConnectionId = getClientConnectionId(currentClient);
        if (terminationConnectionId && currentConnectionId) {
            return terminationConnectionId === currentConnectionId;
        }

        return getClientTransportKey(terminationClient) === getClientTransportKey(currentClient);
    };

    const markMonitoredClientOffline = client => {
        invalidateClientDependentRequests();
        monitoredClient.value = {
            ...(monitoredClient.value || {}),
            ...client,
            isOnline: false,
            connectionState: 'offline'
        };
        bgpInstances.value = bgpInstances.value.map(instance => ({
            ...instance,
            isOnline: false,
            connectionState: 'offline'
        }));
    };

    const onTerminationHandler = result => {
        if (result?.status !== 'success') {
            console.error('termination handler error', result.msg);
            return;
        }

        const data = result.data;
        if (!data) {
            invalidateMonitoredClientRequest();
            replaceMonitoredClient(null);
            return;
        }
        if (!clientMatchesKey(data, lockedClientKey.value)) return;

        const currentClient = monitoredClient.value;
        if (currentClient && !isTerminationForMonitoredConnection(data, currentClient)) return;

        const refreshInstances = !currentClient;
        invalidateMonitoredClientRequest();
        if (!currentClient) {
            replaceMonitoredClient({ ...data, isOnline: false, connectionState: 'offline' });
        } else {
            markMonitoredClientOffline(data);
        }

        const terminatedClient = monitoredClient.value;
        const expectedClientKey = lockedClientKey.value;
        terminationReloadTimer = setTimeout(() => {
            terminationReloadTimer = null;
            if (!pageActive || expectedClientKey !== lockedClientKey.value) return;
            if (
                monitoredClient.value &&
                !isTerminationForMonitoredConnection(terminatedClient, monitoredClient.value)
            ) {
                return;
            }
            loadMonitoredClient({ refreshInstances });
        }, 50);
    };

    const onInstanceRouteUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const updates = Array.isArray(result.data.updates) ? result.data.updates : [result.data];
        const detailInstance = instanceDetailRecord.value;
        if (
            instanceDetailModalVisible.value &&
            detailInstance &&
            updates.some(
                update => update?.projectionReset === true && routeUpdateMatchesInstanceDetail(update, detailInstance)
            )
        ) {
            scheduleInstanceDetailRefresh();
        }

        const activeClient = monitoredClient.value;
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
                    : Boolean(update.client) && getClientKey(update.client) === monitoredClientKey.value;
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

        if (!client || !instance || !isSameClient(client, monitoredClient.value)) return;

        const shouldRefreshInstanceDetail =
            instanceDetailModalVisible.value &&
            Boolean(instanceDetailRecord.value) &&
            isSameInstance(instanceDetailRecord.value, instance);

        upsertBgpInstance(instance);
        if (shouldRefreshInstanceDetail) scheduleInstanceDetailRefresh();
    };

    const onMonitoredClientUpdate = result => {
        if (result?.status !== 'success') {
            notify.error('客户端获取失败');
            return;
        }

        const client = result.data;
        if (!clientMatchesKey(client, lockedClientKey.value)) return;

        invalidateMonitoredClientRequest();
        const shouldRefreshInstances = replaceMonitoredClient(client);
        if (shouldRefreshInstances && pageActive) {
            loadBgpInstances();
        }
    };

    const loadMonitoredClient = async (options = {}) => {
        const requestedClientKey = lockedClientKey.value;
        const requestId = ++monitoredClientRequestId;
        if (!requestedClientKey) {
            replaceMonitoredClient(null);
            return null;
        }

        try {
            const result = await window.bmpApi.getClient(requestedClientKey);
            if (requestId !== monitoredClientRequestId || requestedClientKey !== lockedClientKey.value || !pageActive) {
                return null;
            }

            if (result.status !== 'success') {
                notify.error('加载 Client 失败');
                return null;
            }

            const client = clientMatchesKey(result.data, requestedClientKey) ? result.data : null;
            const shouldRefreshInstances = replaceMonitoredClient(client, options);
            if (shouldRefreshInstances && pageActive) {
                await loadBgpInstances();
            }
            return client;
        } catch (error) {
            if (requestId !== monitoredClientRequestId || requestedClientKey !== lockedClientKey.value || !pageActive) {
                return null;
            }
            console.error(error);
            notify.error('加载数据失败');
            return null;
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
        const client = monitoredClient.value;
        const instance = getActiveInstance();
        if (!client || !activeInstanceKey.value || !instance) return null;
        return {
            clientKey: monitoredClientKey.value,
            clientIdentity: getClientRequestIdentity(client),
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
            current.clientIdentity === selection.clientIdentity &&
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
            left.clientIdentity === right.clientIdentity &&
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
        closeInstanceDetails();
        activeInstanceKey.value = '';
        resetRouteData();
    };

    // Instance Logic
    const bgpInstances = ref([]);
    const activeInstanceKey = ref('');
    let activeInstanceKeyWithoutRouteReload = null;

    const getActiveInstance = () =>
        bgpInstances.value.find(instance => getInstanceKey(instance) === activeInstanceKey.value) || null;

    const instanceDetailRecord = computed(() => {
        if (!selectedInstanceDetail.value) return null;
        return (
            bgpInstances.value.find(instance => isSameInstance(instance, selectedInstanceDetail.value)) ||
            selectedInstanceDetail.value
        );
    });

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

    const routeUpdateMatchesInstanceDetail = (update, instance) => {
        if (!update || !instance) return false;
        if (update.client && !isSameClient(update.client, monitoredClient.value)) return false;

        const updateSourceId =
            update.persistentSourceId ||
            update.sourceId ||
            update.client?.persistentSourceId ||
            update.client?.sourceId ||
            null;
        const instanceSourceId =
            instance.persistentSourceId ||
            instance.sourceId ||
            monitoredClient.value?.persistentSourceId ||
            monitoredClient.value?.sourceId ||
            null;
        if (updateSourceId && instanceSourceId && updateSourceId !== instanceSourceId) return false;

        if (update.instance && !isSameInstance(update.instance, instance)) return false;

        const updateScopeId =
            update.persistentScopeId ||
            update.scopeId ||
            update.instance?.persistentScopeId ||
            update.instance?.scopeId ||
            null;
        if (updateScopeId) {
            const instanceScopeIds = new Set(
                [
                    instance.persistentScopeId,
                    instance.scopeId,
                    ...(Array.isArray(instance.routeScopes)
                        ? instance.routeScopes.flatMap(scope => [scope?.persistentScopeId, scope?.scopeId])
                        : [])
                ].filter(Boolean)
            );
            return instanceScopeIds.has(updateScopeId);
        }

        const updateOwnerKey =
            update.persistentOwnerKey ||
            update.ownerKey ||
            update.instance?.persistentOwnerKey ||
            update.instance?.ownerKey ||
            null;
        const instanceOwnerKey = instance.persistentOwnerKey || instance.ownerKey || null;
        if (updateOwnerKey && instanceOwnerKey) return updateOwnerKey === instanceOwnerKey;

        return Boolean(update.instance && isSameInstance(update.instance, instance));
    };

    const isCurrentInstanceDetailRequest = ({ requestId, clientIdentity, targetInstance }) =>
        requestId === instanceDetailRequestId &&
        pageActive &&
        instanceDetailModalVisible.value &&
        clientIdentity === getClientRequestIdentity(monitoredClient.value) &&
        Boolean(instanceDetailRecord.value) &&
        isSameInstance(instanceDetailRecord.value, targetInstance);

    const commitRefreshedInstanceDetail = refreshedInstance => {
        const existingIndex = bgpInstances.value.findIndex(instance => isSameInstance(instance, refreshedInstance));
        const existingInstance =
            existingIndex >= 0 && isSameInstance(bgpInstances.value[existingIndex], instanceDetailRecord.value)
                ? bgpInstances.value[existingIndex]
                : null;
        const targetInstance = existingInstance || selectedInstanceDetail.value;
        if (!targetInstance || !isSameInstance(targetInstance, refreshedInstance)) return;

        const previousKey = getInstanceKey(targetInstance);
        const wasActive = previousKey === activeInstanceKey.value;
        Object.assign(targetInstance, refreshedInstance);
        selectedInstanceDetail.value = targetInstance;

        const nextKey = getInstanceKey(targetInstance);
        if (wasActive && nextKey !== previousKey) {
            clearScheduledRouteRefresh();
            activeInstanceKeyWithoutRouteReload = nextKey;
            activeInstanceKey.value = nextKey;
        }
    };

    const refreshInstanceDetails = async ({ targetInstance = instanceDetailRecord.value, silent = false } = {}) => {
        clearScheduledInstanceDetailRefresh();
        const requestId = ++instanceDetailRequestId;
        const clientIdentity = getClientRequestIdentity(monitoredClient.value);
        const clientInfo = getMonitoredClientApiInfo();

        if (!targetInstance || !clientInfo || !instanceDetailModalVisible.value) return;

        const request = { requestId, clientIdentity, targetInstance };
        try {
            const result = await window.bmpApi.getBgpInstances(clientInfo);
            if (!isCurrentInstanceDetailRequest(request)) return;

            if (result.status !== 'success') {
                if (!silent) notify.error('刷新 Loc-RIB 详情失败');
                return;
            }

            const refreshedInstance = (Array.isArray(result.data) ? result.data : []).find(instance =>
                isSameInstance(instance, targetInstance)
            );
            if (refreshedInstance) commitRefreshedInstanceDetail(refreshedInstance);
        } catch (error) {
            if (!isCurrentInstanceDetailRequest(request)) return;
            console.error(error);
            if (!silent) notify.error('刷新 Loc-RIB 详情失败');
        }
    };

    const scheduleInstanceDetailRefresh = () => {
        if (!instanceDetailModalVisible.value || !instanceDetailRecord.value) return;
        clearScheduledInstanceDetailRefresh();
        instanceDetailRefreshTimer = setTimeout(() => {
            instanceDetailRefreshTimer = null;
            refreshInstanceDetails({ silent: true });
        }, INSTANCE_DETAIL_REFRESH_DEBOUNCE_MS);
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
        const requestClient = monitoredClient.value;
        if (!requestClient) {
            bgpInstances.value = [];
            resetInstanceAndRouteSelection();
            return;
        }

        const requestId = ++instanceListRequestId;
        const requestClientIdentity = getClientRequestIdentity(requestClient);
        try {
            const clientInfo = getMonitoredClientApiInfo(requestClient);
            if (!clientInfo) {
                bgpInstances.value = [];
                resetInstanceAndRouteSelection();
                return;
            }
            const selectedInstance = getActiveInstance();
            const res = await window.bmpApi.getBgpInstances(clientInfo);
            if (
                requestId !== instanceListRequestId ||
                requestClientIdentity !== getClientRequestIdentity(monitoredClient.value) ||
                !pageActive
            ) {
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
            if (
                requestId !== instanceListRequestId ||
                requestClientIdentity !== getClientRequestIdentity(monitoredClient.value) ||
                !pageActive
            ) {
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
        if (!monitoredClient.value || !activeInstanceKey.value) {
            if (!background) resetRouteData();
            return;
        }

        const client = getMonitoredClientApiInfo();
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
        if (!monitoredClient.value || !activeInstanceKey.value) return;

        const client = getMonitoredClientApiInfo();
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
        selectedInstanceDetail.value = record;
        instanceDetailModalVisible.value = true;
        refreshInstanceDetails({ targetInstance: record });
    };

    const viewRouteDetailJson = async record => {
        const requestId = ++routeDetailRequestId;
        const routeKey = getRouteKey(record);
        const instance = getActiveInstanceApiInfo();

        detailsDrawerTitle.value = `路由detail: ${record.ip || ''}`;
        detailsDrawerVisible.value = true;
        detailsTabKey.value = 'detail';
        currentDetails.value = null;
        routeDetailLoading.value = true;
        routeEventTarget.value = {
            scopeId: record.persistentScopeId || instance?.persistentScopeId || '',
            routeKey,
            routeId: record.persistentRouteId || ''
        };

        if (!monitoredClient.value || !activeInstanceKey.value) {
            currentDetails.value = record;
            routeDetailLoading.value = false;
            return;
        }

        const client = getMonitoredClientApiInfo();
        if (!client) {
            currentDetails.value = record;
            routeDetailLoading.value = false;
            return;
        }
        if (!instance) {
            currentDetails.value = record;
            routeDetailLoading.value = false;
            return;
        }

        try {
            const res = await window.bmpApi.getBgpInstanceRouteDetail(client, instance, routeKey);
            if (requestId !== routeDetailRequestId) return;
            if (res.status === 'success' && res.data) {
                currentDetails.value = res.data;
                routeEventTarget.value = {
                    scopeId: res.data.persistentScopeId || routeEventTarget.value.scopeId,
                    routeKey: res.data.routeKey || routeEventTarget.value.routeKey,
                    routeId: res.data.persistentRouteId || routeEventTarget.value.routeId
                };
            } else {
                currentDetails.value = record;
                notify.error('查询路由detail失败');
            }
        } catch (error) {
            if (requestId !== routeDetailRequestId) return;
            console.error(error);
            currentDetails.value = record;
            notify.error('查询路由detail失败');
        } finally {
            if (requestId === routeDetailRequestId) routeDetailLoading.value = false;
        }
    };

    watch(lockedClientKey, (clientKey, previousClientKey) => {
        if (clientKey === previousClientKey) return;

        invalidateMonitoredClientRequest();
        replaceMonitoredClient(null);
        if (pageActive) {
            loadMonitoredClient({ refreshInstances: true });
        }
    });

    let pageActive = false;

    const activatePage = async () => {
        if (pageActive) {
            return;
        }
        pageActive = true;

        EventBus.on('bmp:instanceUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onInstanceUpdate);
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onMonitoredClientUpdate);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onTerminationHandler);
        EventBus.on('bmp:instanceRouteUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB, onInstanceRouteUpdate);

        await loadMonitoredClient({ refreshInstances: true });
    };

    const deactivatePage = () => {
        if (!pageActive) {
            return;
        }
        pageActive = false;
        invalidateMonitoredClientRequest();
        invalidateClientDependentRequests();
        closeInstanceDetails();
        EventBus.off('bmp:instanceUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
        EventBus.off('bmp:instanceRouteUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_LOC_RIB);
    };

    onMounted(activatePage);
    onActivated(activatePage);
    onDeactivated(deactivatePage);
    onBeforeUnmount(deactivatePage);

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
    .route-detail-loading {
        min-height: 160px;
    }

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
