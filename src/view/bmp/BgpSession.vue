<template>
    <div class="nn-container bmp-full-page" data-testid="bmp-session-page">
        <nn-row class="bmp-full-row">
            <nn-col :span="24">
                <nn-card class="bmp-full-card">
                    <div v-if="monitoredClient && bgpSessionList.length > 0" class="bmp-inner-tabs-shell">
                        <nn-tabs v-model:active-key="activeBgpSessionKey" class="bmp-inner-tabs" size="small">
                            <nn-tab-pane
                                v-for="session in bgpSessionList"
                                :key="getSessionKey(session)"
                                :tab="formatSessionTab(session)"
                            >
                                <template v-if="getSessionKey(session) === activeBgpSessionKey">
                                    <nn-table
                                        class="detail-table"
                                        data-testid="bmp-session-table"
                                        :columns="bgpSessionColumns"
                                        :data-source="[session]"
                                        :pagination="false"
                                        size="small"
                                        style="margin-bottom: 8px"
                                        row-key="peerIp"
                                        :scroll="{ x: 1322 }"
                                    >
                                        <template #bodyCell="{ column, record }">
                                            <template v-if="column.key === 'addPathMap'">
                                                <nn-tooltip
                                                    v-if="
                                                        record.addPathMap &&
                                                        Object.values(record.addPathMap).some(v => v)
                                                    "
                                                >
                                                    <template #title>
                                                        <div v-for="(enabled, key) in record.addPathMap" :key="key">
                                                            <span v-if="enabled">
                                                                {{ ADDRESS_FAMILY_NAME[key] }}: Yes
                                                            </span>
                                                        </div>
                                                    </template>
                                                    <nn-tag color="green">Yes</nn-tag>
                                                </nn-tooltip>
                                                <nn-tag v-else color="red">No</nn-tag>
                                            </template>
                                            <template v-else-if="column.key === 'sessionFlags'">
                                                <nn-tooltip :title="getBmpFlagsName(record.sessionFlags)">
                                                    <span>{{ getBmpFlagsName(record.sessionFlags) }}</span>
                                                </nn-tooltip>
                                            </template>
                                            <template v-else-if="column.key === 'rawSessionFlags'">
                                                <span>{{ formatRawFlags(record.rawSessionFlags) }}</span>
                                            </template>
                                            <template v-else-if="column.key === 'peerDownReason'">
                                                <span>
                                                    {{ formatPeerDownReason(record.peerDownReason) }}
                                                </span>
                                            </template>
                                            <template v-else-if="column.key === 'tlvCount'">
                                                <span>{{ getSessionTlvCount(record) }}</span>
                                            </template>
                                            <template v-else-if="column.key === 'connectionStatus'">
                                                <nn-tag :color="isSessionOnline(record) ? 'green' : 'orange'">
                                                    {{ formatSessionConnectionState(record) }}
                                                </nn-tag>
                                            </template>
                                            <template v-else-if="column.key === 'action'">
                                                <nn-button
                                                    type="link"
                                                    size="small"
                                                    data-testid="bmp-session-detail-button"
                                                    @click="viewSessionDetails(record)"
                                                >
                                                    详情
                                                </nn-button>
                                            </template>
                                        </template>
                                    </nn-table>
                                    <div class="route-toolbar">
                                        <div class="route-toolbar-query">
                                            <nn-select v-model:value="activeLocRibAf" style="width: 200px">
                                                <nn-select-option
                                                    v-for="af in getSessionAddressFamilyTypes(session)"
                                                    :key="af"
                                                    :value="af"
                                                >
                                                    {{ ADDRESS_FAMILY_NAME[af] || af }}
                                                </nn-select-option>
                                            </nn-select>
                                            <nn-select v-model:value="activeLocRibType" style="width: 200px">
                                                <nn-select-option
                                                    v-for="rt in getSessionRibTypesForAf(session, activeLocRibAf)"
                                                    :key="rt"
                                                    :value="rt"
                                                >
                                                    {{ BMP_BGP_RIB_TYPE_NAME[rt] }}
                                                </nn-select-option>
                                            </nn-select>
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
                                                @press-enter="searchBgpRoutes"
                                            />
                                            <nn-button type="primary" @click="searchBgpRoutes">查询</nn-button>
                                        </div>
                                        <div class="route-toolbar-status">
                                            <nn-tag color="green">当前 {{ routeSummary.active }}</nn-tag>
                                            <nn-tag color="orange">过期 {{ routeSummary.stale }}</nn-tag>
                                            <nn-button
                                                danger
                                                :disabled="routeSummary.stale === 0"
                                                @click="purgeStaleRoutes"
                                            >
                                                清理过期
                                            </nn-button>
                                        </div>
                                    </div>
                                    <nn-table
                                        class="route-table"
                                        data-testid="bmp-session-route-table"
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
                                                            data-testid="bmp-session-route-detail"
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

        <BmpSessionDetailModal
            :open="sessionDetailModalVisible"
            :loading="sessionDetailLoading"
            :session="sessionDetailRecord"
            @update:open="handleSessionDetailOpenChange"
        />

        <nn-drawer
            v-model:open="detailsDrawerVisible"
            :title="detailsDrawerTitle"
            placement="right"
            :width="routeEventTarget ? '760px' : '500px'"
            @close="closeDetailsDrawer"
        >
            <nn-spin v-if="routeEventTarget" :spinning="routeDetailLoading">
                <div v-if="routeDetailLoading && !currentDetails" class="route-detail-loading" />
                <nn-empty v-else-if="!currentDetails" description="暂无路由详情" />
                <nn-json-viewer v-else class="route-detail-json" :value="currentDetails" wrap />
            </nn-spin>
            <nn-json-viewer v-else-if="currentDetails" class="route-detail-json" :value="currentDetails" wrap />
        </nn-drawer>
    </div>
</template>

<script setup>
    import { computed, inject, ref, watch, onActivated, onBeforeUnmount, onDeactivated, onMounted } from 'vue';
    import { useRoute } from 'vue-router';
    import { notify } from '../../utils/notify';
    import { formatBmpClientLabel } from '../../utils/bmpClientLabel';
    import { ProfileOutlined } from 'netnexus-ui/icons';
    import BmpSessionDetailModal from '../../components/BmpSessionDetailModal.vue';
    import {
        BMP_SESSION_TYPE_NAME,
        BMP_SESSION_STATE_NAME,
        BMP_BGP_RIB_TYPE_NAME,
        BMP_EVENT_PAGE_ID,
        BMP_PEER_DOWN_REASON_NAME,
        BMP_ROUTE_STATE,
        BMP_ROUTE_STATE_FILTER,
        getBmpFlagsName
    } from '../../const/bmpConst';
    import { ADDRESS_FAMILY_NAME, getAddrFamilyType } from '../../const/bgpConst';
    import {
        getRouteParseStatusColor,
        getRouteParseStatusRowClass,
        getRouteParseStatusText
    } from '../../utils/routeParseStatus';
    import EventBus from '../../utils/eventBus';
    defineOptions({
        name: 'BgpSession'
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
    const bgpSessionList = ref([]);
    let clientLoadRequestId = 0;
    let clientRevision = 0;
    let clientReloadTimer = null;
    let pageActive = false;

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
            title: 'RD / VRF',
            dataIndex: 'sessionRd',
            key: 'sessionRd',
            width: 140,
            ellipsis: true,
            customRender: ({ record }) => formatSessionVrfOrRd(record)
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
    const routeEventTarget = ref(null);
    const routeDetailLoading = ref(false);
    const sessionDetailModalVisible = ref(false);
    const sessionDetailLoading = ref(false);
    const selectedSessionDetail = ref(null);
    let routeDetailRequestId = 0;
    let sessionDetailRequestId = 0;
    let sessionDetailRefreshTimer = null;
    const SESSION_DETAIL_REFRESH_DEBOUNCE_MS = 120;

    const getClientTransportKey = client =>
        `${client?.localIp || ''}|${client?.localPort || ''}|${client?.remoteIp || ''}|${client?.remotePort || ''}`;

    const getClientKey = client => {
        const sourceId = client?.persistentSourceId || client?.sourceId;
        return sourceId
            ? `source:${String(sourceId).trim().toLowerCase()}`
            : `connection:${getClientTransportKey(client)}`;
    };

    const monitoredClientKey = computed(() => (monitoredClient.value ? getClientKey(monitoredClient.value) : ''));

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

    const getClientConnectionId = client => client?.persistentConnectionId || client?.connectionId || null;

    const hasCompleteClientTransport = client =>
        [client?.localIp, client?.localPort, client?.remoteIp, client?.remotePort].every(
            value => value !== null && value !== undefined && value !== ''
        );

    const isSameClientConnection = (left, right) => {
        if (!isSameClient(left, right)) return false;
        const leftConnectionId = getClientConnectionId(left);
        const rightConnectionId = getClientConnectionId(right);
        if (leftConnectionId && rightConnectionId) {
            return leftConnectionId === rightConnectionId;
        }
        if (hasCompleteClientTransport(left) && hasCompleteClientTransport(right)) {
            return getClientTransportKey(left) === getClientTransportKey(right);
        }
        return true;
    };

    const getMonitoredClientApiInfo = () => {
        const client = monitoredClient.value;
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

    const isSessionOnline = session => getRecordOnlineState(session) ?? isRecordOnline(monitoredClient.value);

    const monitorWindowTitleText = computed(() => {
        const client = monitoredClient.value;
        const clientLabel = client ? formatBmpClientLabel(client) : '';
        return ['BGP会话', clientLabel].filter(Boolean).join(' · ');
    });
    const monitorWindowTitle = inject('monitorWindowTitle', null);
    const monitorTitleOwner = Symbol('bmp-session-monitor-title');
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
        return monitoredClient.value ? '当前 Client 暂无会话数据' : '未找到指定 Client';
    });

    const formatSessionConnectionState = session => (isSessionOnline(session) ? '在线' : '已断开');

    const getSessionKey = session =>
        session?.persistentOwnerKey
            ? `owner:${session.persistentOwnerKey}`
            : `${session.sessionType}|${session.sessionRdRaw || session.sessionRd}|${session.sessionIp}|${session.sessionAs}`;

    const getSessionIdentityKey = session =>
        `${session?.sessionType}|${session?.sessionRdRaw || session?.sessionRd}|${session?.sessionIp}|${
            session?.sessionAs
        }`;

    const isSameSession = (left, right) => {
        if (!left || !right) return false;
        if (left.persistentOwnerKey && right.persistentOwnerKey) {
            return left.persistentOwnerKey === right.persistentOwnerKey;
        }
        return getSessionIdentityKey(left) === getSessionIdentityKey(right);
    };

    const sessionDetailRecord = computed(() => {
        if (!selectedSessionDetail.value) return null;
        return (
            bgpSessionList.value.find(session => isSameSession(session, selectedSessionDetail.value)) ||
            selectedSessionDetail.value
        );
    });

    const clearScheduledSessionDetailRefresh = () => {
        if (sessionDetailRefreshTimer) {
            clearTimeout(sessionDetailRefreshTimer);
            sessionDetailRefreshTimer = null;
        }
    };

    const isCurrentSessionDetailRequest = ({ requestId, clientKey, revision, targetSession }) =>
        requestId === sessionDetailRequestId &&
        pageActive &&
        sessionDetailModalVisible.value &&
        clientKey === monitoredClientKey.value &&
        revision === clientRevision &&
        Boolean(sessionDetailRecord.value) &&
        isSameSession(sessionDetailRecord.value, targetSession);

    const commitRefreshedSessionDetail = refreshedSession => {
        const existingIndex = bgpSessionList.value.findIndex(session => isSameSession(session, refreshedSession));
        if (existingIndex >= 0) {
            const existingSession = bgpSessionList.value[existingIndex];
            const wasActive = getSessionKey(existingSession) === activeBgpSessionKey.value;
            Object.assign(existingSession, refreshedSession);
            selectedSessionDetail.value = existingSession;

            if (wasActive) {
                const nextActiveKey = getSessionKey(existingSession);
                if (nextActiveKey !== activeBgpSessionKey.value) {
                    clearScheduledRouteRefresh();
                    suppressSessionSelectionReloadForKey = nextActiveKey;
                    activeBgpSessionKey.value = nextActiveKey;
                }
            }
            return;
        }

        bgpSessionList.value.push(refreshedSession);
        selectedSessionDetail.value = refreshedSession;
    };

    const refreshSessionDetails = async ({ targetSession = sessionDetailRecord.value, silent = false } = {}) => {
        clearScheduledSessionDetailRefresh();
        const requestId = ++sessionDetailRequestId;
        const clientKey = monitoredClientKey.value;
        const revision = clientRevision;
        const clientInfo = getMonitoredClientApiInfo();

        if (!targetSession || !clientInfo || !sessionDetailModalVisible.value) {
            sessionDetailLoading.value = false;
            return;
        }

        sessionDetailLoading.value = true;
        const request = { requestId, clientKey, revision, targetSession };
        try {
            const result = await window.bmpApi.getBgpSessions(clientInfo);
            if (!isCurrentSessionDetailRequest(request)) return;

            if (result.status !== 'success') {
                if (!silent) notify.error('刷新 Session 详情失败');
                return;
            }

            const refreshedSession = (Array.isArray(result.data) ? result.data : []).find(session =>
                isSameSession(session, targetSession)
            );
            if (refreshedSession) {
                commitRefreshedSessionDetail(refreshedSession);
            }
        } catch (error) {
            if (!isCurrentSessionDetailRequest(request)) return;
            console.error(error);
            if (!silent) notify.error('刷新 Session 详情失败');
        } finally {
            if (requestId === sessionDetailRequestId) {
                sessionDetailLoading.value = false;
            }
        }
    };

    const scheduleSessionDetailRefresh = () => {
        if (!sessionDetailModalVisible.value || !sessionDetailRecord.value) return;
        clearScheduledSessionDetailRefresh();
        sessionDetailRefreshTimer = setTimeout(() => {
            sessionDetailRefreshTimer = null;
            refreshSessionDetails({ silent: true });
        }, SESSION_DETAIL_REFRESH_DEBOUNCE_MS);
    };

    const normalizeRibType = value => (value === null || value === undefined || value === '' ? null : String(value));

    const getSessionRouteScopes = session => {
        const scopes = Array.isArray(session?.routeScopes) ? session.routeScopes : [];
        if (scopes.length > 0) {
            return scopes
                .map(scope => ({
                    ...scope,
                    persistentScopeId: scope.persistentScopeId || scope.scopeId || null,
                    addrFamilyType:
                        scope.addrFamilyType ??
                        (scope.afi !== undefined && scope.safi !== undefined
                            ? getAddrFamilyType(Number(scope.afi), Number(scope.safi))
                            : null),
                    // Live sessions report numeric RIB types while persisted scopes
                    // store TEXT; normalize so select options and the bound value
                    // share one type and the dropdown never falls back to the raw id.
                    ribType: scope.ribType === null || scope.ribType === undefined ? null : String(scope.ribType)
                }))
                .filter(scope => scope.addrFamilyType !== null && scope.ribType !== null);
        }
        if (session?.persistentScopeId) {
            return [
                {
                    persistentScopeId: session.persistentScopeId,
                    addrFamilyType: session.addrFamilyType ?? session.enabledAddrFamilyTypes?.[0] ?? null,
                    ribType: normalizeRibType(session.ribType ?? session.ribTypes?.[0] ?? null)
                }
            ].filter(scope => scope.addrFamilyType !== null && scope.ribType !== null);
        }
        return [];
    };

    const uniqueSelectorValues = values =>
        values
            .filter(value => value !== null && value !== undefined && value !== '')
            .filter((value, index, items) => items.findIndex(item => `${item}` === `${value}`) === index);

    const getSessionAddressFamilyTypes = session =>
        uniqueSelectorValues([
            ...(Array.isArray(session?.enabledAddrFamilyTypes) ? session.enabledAddrFamilyTypes : []),
            ...getSessionRouteScopes(session).map(scope => scope.addrFamilyType)
        ]);

    const getSessionRibTypes = session =>
        uniqueSelectorValues([
            ...(Array.isArray(session?.ribTypes) ? session.ribTypes.map(normalizeRibType) : []),
            ...getSessionRouteScopes(session).map(scope => scope.ribType)
        ]);

    const getSessionRibTypesForAf = (session, af) => {
        const routeScopes = getSessionRouteScopes(session);
        if (routeScopes.length === 0) return getSessionRibTypes(session);
        return uniqueSelectorValues(
            routeScopes.filter(scope => sameSelectorValue(scope.addrFamilyType, af)).map(scope => scope.ribType)
        );
    };

    const getSelectedSessionRouteScope = (session, af, ribType) =>
        getSessionRouteScopes(session).find(
            scope => sameSelectorValue(scope.addrFamilyType, af) && sameSelectorValue(scope.ribType, ribType)
        ) || null;

    const getSessionApiInfo = (session, af = activeLocRibAf.value, ribType = activeLocRibType.value) => {
        if (!session) {
            return null;
        }

        const routeScope = getSelectedSessionRouteScope(session, af, ribType);

        return {
            sessionType: session.sessionType,
            sessionRd: session.sessionRd,
            sessionRdRaw: session.sessionRdRaw || null,
            sessionIp: session.sessionIp,
            sessionAs: session.sessionAs,
            persistentOwnerKey: session.persistentOwnerKey || null,
            persistentScopeId: routeScope?.persistentScopeId || session.persistentScopeId || null
        };
    };

    // View peer details
    const viewSessionDetails = record => {
        selectedSessionDetail.value = record;
        sessionDetailModalVisible.value = true;
        refreshSessionDetails({ targetSession: record });
    };

    const closeSessionDetails = () => {
        sessionDetailRequestId += 1;
        clearScheduledSessionDetailRefresh();
        sessionDetailLoading.value = false;
        sessionDetailModalVisible.value = false;
        selectedSessionDetail.value = null;
    };

    const handleSessionDetailOpenChange = open => {
        if (open) {
            sessionDetailModalVisible.value = true;
            return;
        }
        closeSessionDetails();
    };

    const viewRouteDetailJson = async record => {
        const requestId = ++routeDetailRequestId;
        const routeKey = getRouteKey(record);
        const sessionInfo = getSessionApiInfo(getActiveSession());

        detailsDrawerTitle.value = `路由detail: ${record.ip || ''}`;
        detailsDrawerVisible.value = true;
        currentDetails.value = null;
        routeDetailLoading.value = true;
        routeEventTarget.value = {
            scopeId: record.persistentScopeId || sessionInfo?.persistentScopeId || '',
            routeKey,
            routeId: record.persistentRouteId || ''
        };

        if (
            !monitoredClient.value ||
            !activeBgpSessionKey.value ||
            activeLocRibAf.value === null ||
            activeLocRibAf.value === undefined ||
            !activeLocRibType.value
        ) {
            currentDetails.value = record;
            routeDetailLoading.value = false;
            return;
        }

        if (!sessionInfo) {
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

        try {
            const res = await window.bmpApi.getBgpRouteDetail(
                client,
                sessionInfo,
                activeLocRibAf.value,
                activeLocRibType.value,
                routeKey
            );
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

    const formatRawFlags = flags => {
        if (flags === null || flags === undefined) return '-';
        return `0x${Number(flags).toString(16).padStart(2, '0')}`;
    };

    const formatPeerDownReason = reason => {
        if (reason === null || reason === undefined) return '-';
        return BMP_PEER_DOWN_REASON_NAME[reason] || reason;
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

    const getSessionTlvCount = record => {
        return (record.peerUpTlvs || []).length + (record.peerDownTlvs || []).length;
    };

    const getSessionVrfTableNames = session => {
        return Array.isArray(session?.vrfTableNames) ? session.vrfTableNames.filter(Boolean) : [];
    };

    const formatSessionVrfOrRd = session => {
        const vrfTableNames = getSessionVrfTableNames(session);
        if (vrfTableNames.length > 0) {
            return vrfTableNames.join(', ');
        }
        return session.sessionRd === '0:0' ? 'global' : session.sessionRd;
    };

    const formatSessionTab = session => {
        return `${formatSessionVrfOrRd(session)} | ${session.sessionIp} | ${session.sessionAs}`;
    };

    // Close details drawer
    const closeDetailsDrawer = () => {
        routeDetailRequestId += 1;
        detailsDrawerVisible.value = false;
        currentDetails.value = null;
        routeEventTarget.value = null;
        routeDetailLoading.value = false;
    };

    const clearClientReloadTimer = () => {
        if (clientReloadTimer) {
            clearTimeout(clientReloadTimer);
            clientReloadTimer = null;
        }
    };

    const invalidateClientDataRequests = () => {
        clientRevision += 1;
        sessionListRequestId += 1;
        routeListRequestId += 1;
        routeDetailRequestId += 1;
        sessionDetailRequestId += 1;
        routeDetailLoading.value = false;
        sessionDetailLoading.value = false;
        clearScheduledSessionDetailRefresh();
        clearScheduledRouteRefresh();
    };

    const commitMonitoredClient = (client, { forceInvalidate = false } = {}) => {
        const previousClient = monitoredClient.value;
        const previousKey = previousClient ? getClientKey(previousClient) : '';
        const nextClient = client || null;
        const nextKey = nextClient ? getClientKey(nextClient) : '';
        const identityChanged = previousKey !== nextKey;
        const connectionChanged =
            Boolean(previousClient) !== Boolean(nextClient) ||
            (previousClient && nextClient && !isSameClientConnection(previousClient, nextClient));

        if (forceInvalidate || identityChanged || connectionChanged) {
            invalidateClientDataRequests();
        }

        monitoredClient.value = nextClient;
        if (!nextClient || identityChanged || connectionChanged) {
            bgpSessionList.value = [];
            resetSessionAndRouteSelection();
        }

        return { identityChanged, connectionChanged };
    };

    const markMonitoredClientOffline = client => {
        if (!monitoredClient.value || !isSameClientConnection(client, monitoredClient.value)) {
            return false;
        }

        commitMonitoredClient(
            {
                ...monitoredClient.value,
                isOnline: false,
                connectionState: 'offline'
            },
            { forceInvalidate: true }
        );
        bgpSessionList.value = bgpSessionList.value.map(session => ({
            ...session,
            isOnline: false,
            connectionState: 'offline'
        }));
        return true;
    };

    const scheduleMonitoredClientReload = () => {
        clearClientReloadTimer();
        const expectedClientKey = lockedClientKey.value;
        const expectedClientRevision = clientRevision;
        clientReloadTimer = setTimeout(() => {
            clientReloadTimer = null;
            if (
                !pageActive ||
                lockedClientKey.value !== expectedClientKey ||
                clientRevision !== expectedClientRevision
            ) {
                return;
            }
            loadMonitoredClient({ refreshSessions: true });
        }, 50);
    };

    const onTerminationHandler = result => {
        if (result.status === 'success') {
            const data = result.data;
            if (data) {
                if (!clientMatchesKey(data, lockedClientKey.value)) {
                    return;
                }
                if (!monitoredClient.value) {
                    clearClientReloadTimer();
                    clientLoadRequestId += 1;
                    commitMonitoredClient(
                        { ...data, isOnline: false, connectionState: 'offline' },
                        { forceInvalidate: true }
                    );
                } else if (!markMonitoredClientOffline(data)) {
                    return;
                }
                scheduleMonitoredClientReload();
            } else {
                clearClientReloadTimer();
                clientLoadRequestId += 1;
                commitMonitoredClient(null, { forceInvalidate: true });
            }
        } else {
            console.error('termination handler error', result.msg);
        }
    };

    const routeUpdateMatchesSessionDetail = (update, session) => {
        if (!update || !session) return false;
        if (update.client && !isSameClientConnection(update.client, monitoredClient.value)) return false;

        const updateSourceId =
            update.persistentSourceId ||
            update.sourceId ||
            update.client?.persistentSourceId ||
            update.client?.sourceId ||
            null;
        const sessionSourceId =
            session.persistentSourceId ||
            session.sourceId ||
            monitoredClient.value?.persistentSourceId ||
            monitoredClient.value?.sourceId ||
            null;
        if (updateSourceId && sessionSourceId && updateSourceId !== sessionSourceId) return false;

        if (update.session && !isSameSession(update.session, session)) return false;

        const updateOwnerKey =
            update.persistentOwnerKey ||
            update.ownerKey ||
            update.session?.persistentOwnerKey ||
            update.session?.ownerKey ||
            null;
        const sessionOwnerKey = session.persistentOwnerKey || session.ownerKey || null;
        if (updateOwnerKey && sessionOwnerKey) return updateOwnerKey === sessionOwnerKey;

        const updateScopeId =
            update.persistentScopeId ||
            update.scopeId ||
            update.session?.persistentScopeId ||
            update.session?.scopeId ||
            null;
        if (!updateScopeId) return Boolean(update.session && isSameSession(update.session, session));

        const sessionScopeIds = new Set(
            [
                session.persistentScopeId,
                session.scopeId,
                ...(Array.isArray(session.routeScopes)
                    ? session.routeScopes.flatMap(scope => [scope?.persistentScopeId, scope?.scopeId])
                    : [])
            ].filter(Boolean)
        );
        return sessionScopeIds.has(updateScopeId);
    };

    const onRouteUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const updates = Array.isArray(result.data.updates) ? result.data.updates : [result.data];
        const detailSession = sessionDetailRecord.value;
        if (
            sessionDetailModalVisible.value &&
            detailSession &&
            updates.some(
                update => update?.projectionReset === true && routeUpdateMatchesSessionDetail(update, detailSession)
            )
        ) {
            scheduleSessionDetailRefresh();
        }

        const activeClient = monitoredClient.value;
        const activeSession = getActiveSession();
        if (!activeClient || !activeSession) return;

        const activeSourceId = activeClient.persistentSourceId || activeClient.sourceId || null;
        const activeScope = getSelectedSessionRouteScope(activeSession, activeLocRibAf.value, activeLocRibType.value);
        const activeScopeId =
            activeScope?.persistentScopeId ||
            activeScope?.scopeId ||
            activeSession.persistentScopeId ||
            activeSession.scopeId ||
            null;
        const shouldRefresh = updates.some(update => {
            if (!update) return false;
            if (update.client && !isSameClientConnection(update.client, activeClient)) return false;
            const updateSourceId =
                update.sourceId ||
                update.persistentSourceId ||
                update.client?.sourceId ||
                update.client?.persistentSourceId ||
                null;
            const sourceMatches =
                activeSourceId && updateSourceId
                    ? activeSourceId === updateSourceId
                    : clientMatchesKey(update.client, lockedClientKey.value);
            if (!sourceMatches) return false;

            const updateScopeId =
                update.scopeId ||
                update.persistentScopeId ||
                update.session?.scopeId ||
                update.session?.persistentScopeId ||
                null;
            if (activeScopeId && updateScopeId) {
                return activeScopeId === updateScopeId;
            }

            return (
                getSessionKey(update.session) === activeBgpSessionKey.value &&
                sameSelectorValue(update.af, activeLocRibAf.value) &&
                sameSelectorValue(update.ribType, activeLocRibType.value)
            );
        });

        if (shouldRefresh) scheduleRouteRefresh();
    };

    const onSessionUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const data = result.data;

        if (!data.session || !isSameClientConnection(data.client, monitoredClient.value)) return;

        const shouldRefreshSessionDetail =
            sessionDetailModalVisible.value &&
            Boolean(sessionDetailRecord.value) &&
            isSameSession(sessionDetailRecord.value, data.session);

        const existingIndex = bgpSessionList.value.findIndex(session => isSameSession(session, data.session));
        if (existingIndex >= 0) {
            const existingSession = bgpSessionList.value[existingIndex];
            const wasActive = getSessionKey(existingSession) === activeBgpSessionKey.value;
            Object.assign(existingSession, data.session);

            if (wasActive) {
                const nextActiveKey = getSessionKey(existingSession);
                if (nextActiveKey !== activeBgpSessionKey.value) {
                    clearScheduledRouteRefresh();
                    suppressSessionSelectionReloadForKey = nextActiveKey;
                    activeBgpSessionKey.value = nextActiveKey;
                }
            }
            if (shouldRefreshSessionDetail) scheduleSessionDetailRefresh();
            return;
        }

        bgpSessionList.value.push(data.session);
        if (!activeBgpSessionKey.value) {
            activeBgpSessionKey.value = getSessionKey(data.session);
        }
        if (shouldRefreshSessionDetail) scheduleSessionDetailRefresh();
    };

    const onMonitoredClientUpdate = result => {
        if (result.status === 'success') {
            const client = result.data;
            if (!clientMatchesKey(client, lockedClientKey.value)) {
                return;
            }

            clearClientReloadTimer();
            clientLoadRequestId += 1;
            const hadMonitoredClient = Boolean(monitoredClient.value);
            const { identityChanged, connectionChanged } = commitMonitoredClient(client);
            if (!hadMonitoredClient || identityChanged || connectionChanged) {
                loadBgpSessionList();
            }
        } else {
            notify.error('Client 信息更新失败');
        }
    };

    const getClientFromResponse = response => {
        if (response?.status === 'success') {
            return response.data || null;
        }
        if (response?.status) {
            throw new Error(response.msg || '获取 Client 失败');
        }
        return response || null;
    };

    const loadMonitoredClient = async ({ refreshSessions = false } = {}) => {
        const requestClientKey = lockedClientKey.value;
        const requestId = ++clientLoadRequestId;
        if (!requestClientKey) {
            commitMonitoredClient(null, { forceInvalidate: true });
            return null;
        }

        try {
            const response = await window.bmpApi.getClient(requestClientKey);
            if (!pageActive || requestId !== clientLoadRequestId || requestClientKey !== lockedClientKey.value) {
                return null;
            }

            const client = getClientFromResponse(response);
            const nextClient = client && clientMatchesKey(client, requestClientKey) ? client : null;
            const { identityChanged, connectionChanged } = commitMonitoredClient(nextClient);
            if (refreshSessions && nextClient && (identityChanged || connectionChanged)) {
                await loadBgpSessionList();
            }
            return nextClient;
        } catch (error) {
            if (!pageActive || requestId !== clientLoadRequestId || requestClientKey !== lockedClientKey.value) {
                return null;
            }
            console.error(error);
            notify.error('加载 Client 失败');
            return null;
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
    let scheduledRouteSelection = null;
    let lastRouteAutoRefreshAt = 0;
    let suppressSessionSelectionReloadForKey = '';

    const captureRouteSelection = () => ({
        clientKey: lockedClientKey.value,
        clientRevision,
        sessionKey: activeBgpSessionKey.value,
        af: activeLocRibAf.value,
        ribType: activeLocRibType.value,
        page: bgpRoutePagination.value.current,
        routeState: routeStateFilter.value,
        prefix: appliedRoutePrefixFilter.value
    });

    const getRouteSelectionKey = selection =>
        `${selection.clientKey}|${selection.clientRevision}|${selection.sessionKey}|${selection.af}|${selection.ribType}|${selection.page}|${selection.routeState}|${selection.prefix}`;

    const isCurrentRouteSelection = selection =>
        Boolean(selection) && getRouteSelectionKey(selection) === getRouteSelectionKey(captureRouteSelection());

    const clearScheduledRouteRefresh = () => {
        if (routeAutoRefreshTimer) {
            clearTimeout(routeAutoRefreshTimer);
            routeAutoRefreshTimer = null;
        }
        scheduledRouteSelection = null;
    };

    const scheduleRouteRefresh = () => {
        const selection = captureRouteSelection();
        if (routeAutoRefreshTimer) {
            if (getRouteSelectionKey(selection) === getRouteSelectionKey(scheduledRouteSelection)) {
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
            loadBgpRoutes({ background: true, expectedSelection: selection, clampOutOfRange: true });
        }, delay);
    };

    const resetRouteData = () => {
        clearScheduledRouteRefresh();
        bgpRouteList.value = [];
        bgpRoutePagination.value.total = 0;
        routeSummary.value = { active: 0, stale: 0, total: 0 };
    };

    const resetSessionAndRouteSelection = () => {
        closeSessionDetails();
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
        const enabledAddrFamilyTypes = getSessionAddressFamilyTypes(session);
        const ribTypes = getSessionRibTypes(session);

        if (!session || enabledAddrFamilyTypes.length === 0 || ribTypes.length === 0) {
            activeLocRibAf.value = null;
            activeLocRibType.value = '';
            resetRouteData();
            return false;
        }

        const routeScopes = getSessionRouteScopes(session);
        if (routeScopes.length > 0) {
            const currentScope = getSelectedSessionRouteScope(session, activeLocRibAf.value, activeLocRibType.value);
            const selectedScope = currentScope || routeScopes[0];
            activeLocRibAf.value = selectedScope.addrFamilyType;
            activeLocRibType.value = normalizeRibType(selectedScope.ribType) ?? '';
        } else {
            if (!enabledAddrFamilyTypes.some(af => sameSelectorValue(af, activeLocRibAf.value))) {
                activeLocRibAf.value = enabledAddrFamilyTypes[0];
            }
            if (!ribTypes.some(ribType => sameSelectorValue(ribType, activeLocRibType.value))) {
                activeLocRibType.value = normalizeRibType(ribTypes[0]) ?? '';
            }
        }

        return true;
    };

    const isActiveRouteSelectionValid = () => {
        const session = getActiveSession();
        if (!session) return false;

        const routeScopes = getSessionRouteScopes(session);
        if (routeScopes.length > 0) {
            return Boolean(getSelectedSessionRouteScope(session, activeLocRibAf.value, activeLocRibType.value));
        }

        const enabledAddrFamilyTypes = getSessionAddressFamilyTypes(session);
        const ribTypes = getSessionRibTypes(session);
        return (
            enabledAddrFamilyTypes.some(af => sameSelectorValue(af, activeLocRibAf.value)) &&
            ribTypes.some(ribType => sameSelectorValue(ribType, activeLocRibType.value))
        );
    };

    // 加载BGP会话列表
    const loadBgpSessionList = async () => {
        if (!monitoredClient.value) {
            bgpSessionList.value = [];
            resetSessionAndRouteSelection();
            return;
        }

        const requestId = ++sessionListRequestId;
        const requestClientKey = monitoredClientKey.value;
        const requestClientRevision = clientRevision;
        try {
            const clientInfo = getMonitoredClientApiInfo();
            if (!clientInfo) {
                bgpSessionList.value = [];
                resetSessionAndRouteSelection();
                return;
            }

            const bgpSessionListResult = await window.bmpApi.getBgpSessions(clientInfo);
            if (
                requestId !== sessionListRequestId ||
                requestClientKey !== monitoredClientKey.value ||
                requestClientRevision !== clientRevision
            ) {
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
                notify.error('获取BGP邻居列表失败');
            }
        } catch (error) {
            if (
                requestId !== sessionListRequestId ||
                requestClientKey !== monitoredClientKey.value ||
                requestClientRevision !== clientRevision
            ) {
                return;
            }
            console.error(error);
            bgpSessionList.value = [];
            resetSessionAndRouteSelection();
            notify.error('获取BGP邻居列表失败');
        }
    };

    watch(lockedClientKey, async () => {
        clearClientReloadTimer();
        clientLoadRequestId += 1;
        commitMonitoredClient(null, { forceInvalidate: true });
        if (!pageActive) return;
        const client = await loadMonitoredClient();
        if (client && pageActive) {
            await loadBgpSessionList();
        }
    });

    const activatePage = async () => {
        if (pageActive) {
            return;
        }
        pageActive = true;

        EventBus.on('bmp:sessionUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onSessionUpdate);
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onMonitoredClientUpdate);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onTerminationHandler);
        EventBus.on('bmp:routeUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onRouteUpdate);

        const client = await loadMonitoredClient();
        if (client && pageActive) {
            await loadBgpSessionList();
        }
    };

    const deactivatePage = () => {
        if (!pageActive) {
            return;
        }
        pageActive = false;
        clearClientReloadTimer();
        clientLoadRequestId += 1;
        invalidateClientDataRequests();
        clearScheduledRouteRefresh();
        closeSessionDetails();
        EventBus.off('bmp:sessionUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION);
        EventBus.off('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION);
        EventBus.off('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION);
        EventBus.off('bmp:routeUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION);
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
            loadBgpRoutes();
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

    const searchBgpRoutes = () => {
        clearScheduledRouteRefresh();
        appliedRoutePrefixFilter.value = (routePrefixFilter.value || '').trim();
        bgpRoutePagination.value.current = 1;
        loadBgpRoutes();
    };

    const loadBgpRoutes = async ({ background = false, expectedSelection = null, clampOutOfRange = false } = {}) => {
        if (expectedSelection && !isCurrentRouteSelection(expectedSelection)) {
            return;
        }

        if (
            !monitoredClient.value ||
            !activeBgpSessionKey.value ||
            activeLocRibAf.value === null ||
            activeLocRibAf.value === undefined ||
            !activeLocRibType.value
        ) {
            if (!background) {
                resetRouteData();
            }
            return;
        }

        if (!isActiveRouteSelectionValid()) {
            if (!background) {
                syncActiveRouteSelectors(getActiveSession());
            }
            return;
        }

        const requestSelection = captureRouteSelection();
        const requestId = ++routeListRequestId;
        const requestKey = getRouteSelectionKey(requestSelection);

        const sessionInfo = getSessionApiInfo(getActiveSession(), activeLocRibAf.value, activeLocRibType.value);
        if (!sessionInfo) {
            if (!background) {
                resetRouteData();
            }
            return;
        }

        const client = getMonitoredClientApiInfo();
        if (!client) {
            if (!background) {
                resetRouteData();
            }
            return;
        }
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
            const currentKey = getRouteSelectionKey(captureRouteSelection());
            if (requestId !== routeListRequestId || requestKey !== currentKey) {
                return;
            }

            if (res.status === 'success' && res.data) {
                const total = Math.max(0, Number(res.data.total) || 0);
                const lastPage = Math.max(1, Math.ceil(total / pageSize));
                if (clampOutOfRange && page > lastPage) {
                    bgpRoutePagination.value.current = lastPage;
                    return loadBgpRoutes({
                        background,
                        expectedSelection: captureRouteSelection(),
                        clampOutOfRange: false
                    });
                }

                bgpRouteList.value = res.data.list || [];
                bgpRoutePagination.value.total = total;
                routeSummary.value = res.data.summary || { active: 0, stale: 0, total: 0 };
            } else if (!background) {
                resetRouteData();
            }
        } catch (e) {
            const currentKey = getRouteSelectionKey(captureRouteSelection());
            if (requestId !== routeListRequestId || requestKey !== currentKey) {
                return;
            }
            console.error(e);
            if (!background) {
                resetRouteData();
                notify.error('Load routes failed');
            }
        }
    };

    const purgeStaleRoutes = async () => {
        if (
            !monitoredClient.value ||
            !activeBgpSessionKey.value ||
            activeLocRibAf.value === null ||
            activeLocRibAf.value === undefined ||
            !activeLocRibType.value ||
            !isActiveRouteSelectionValid()
        )
            return;
        const sessionInfo = getSessionApiInfo(getActiveSession(), activeLocRibAf.value, activeLocRibType.value);
        if (!sessionInfo) {
            return;
        }

        const client = getMonitoredClientApiInfo();
        if (!client) return;

        try {
            const res = await window.bmpApi.purgeStaleBgpRoutes(
                client,
                sessionInfo,
                activeLocRibAf.value,
                activeLocRibType.value
            );
            if (res.status === 'success') {
                notify.success(`已清理 ${res.data?.deleted || 0} 条过期路由`);
                bgpRoutePagination.value.current = 1;
                loadBgpRoutes();
            } else {
                notify.error('清理过期路由失败');
            }
        } catch (e) {
            console.error(e);
            notify.error('清理过期路由失败');
        }
    };

    watch(activeBgpSessionKey, newKey => {
        clearScheduledRouteRefresh();
        if (newKey && newKey === suppressSessionSelectionReloadForKey) {
            suppressSessionSelectionReloadForKey = '';
            return;
        }
        suppressSessionSelectionReloadForKey = '';
        bgpRoutePagination.value.current = 1;
        if (!newKey) {
            resetRouteData();
            return;
        }

        if (syncActiveRouteSelectors(getActiveSession())) {
            loadBgpRoutes();
        }
    });

    watch(activeLocRibAf, () => {
        clearScheduledRouteRefresh();
        if (!activeBgpSessionKey.value) return;
        const session = getActiveSession();
        const validRibTypes = getSessionRibTypesForAf(session, activeLocRibAf.value);
        if (!validRibTypes.some(ribType => sameSelectorValue(ribType, activeLocRibType.value))) {
            activeLocRibType.value = validRibTypes[0] ?? '';
            return;
        }
        bgpRoutePagination.value.current = 1;
        loadBgpRoutes();
    });

    watch(activeLocRibType, () => {
        clearScheduledRouteRefresh();
        if (!activeBgpSessionKey.value || !activeLocRibType.value) return;
        bgpRoutePagination.value.current = 1;
        loadBgpRoutes();
    });

    watch(routeStateFilter, () => {
        clearScheduledRouteRefresh();
        bgpRoutePagination.value.current = 1;
        loadBgpRoutes();
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
