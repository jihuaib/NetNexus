<template>
    <div class="nn-container bmp-full-page" data-testid="bmp-session-page">
        <nn-row class="bmp-full-row">
            <nn-col :span="24">
                <nn-card title="BGP会话" class="bmp-full-card">
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
                                    v-if="getClientKey(client) === activeClientKey && bgpSessionList.length > 0"
                                    class="bmp-inner-tabs-shell"
                                >
                                    <nn-tabs v-model:active-key="activeBgpSessionKey" class="bmp-inner-tabs">
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
                                                                    <div
                                                                        v-for="(enabled, key) in record.addPathMap"
                                                                        :key="key"
                                                                    >
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
                                                            <nn-tag
                                                                :color="isSessionOnline(record) ? 'green' : 'orange'"
                                                            >
                                                                {{ formatSessionConnectionState(record) }}
                                                            </nn-tag>
                                                        </template>
                                                        <template v-else-if="column.key === 'action'">
                                                            <nn-button
                                                                type="link"
                                                                size="small"
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
                                                        <nn-select
                                                            v-model:value="activeLocRibType"
                                                            style="width: 200px"
                                                        >
                                                            <nn-select-option
                                                                v-for="rt in getSessionRibTypesForAf(
                                                                    session,
                                                                    activeLocRibAf
                                                                )"
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
                                                        <nn-button type="primary" @click="searchBgpRoutes">
                                                            查询
                                                        </nn-button>
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
                                                                        data-testid="bmp-session-route-detail"
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
            :width="routeEventTarget ? '760px' : '500px'"
            @close="closeDetailsDrawer"
        >
            <nn-tabs v-if="routeEventTarget" v-model:active-key="detailsTabKey" size="small">
                <nn-tab-pane key="detail" tab="路由详情">
                    <nn-spin :spinning="routeDetailLoading">
                        <div v-if="routeDetailLoading && !currentDetails" class="route-detail-loading" />
                        <nn-empty v-else-if="!currentDetails" description="暂无路由详情" />
                        <pre v-else class="route-detail-json">{{ JSON.stringify(currentDetails, null, 2) }}</pre>
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
            <pre v-else-if="currentDetails" class="route-detail-json">{{
                JSON.stringify(currentDetails, null, 2)
            }}</pre>
        </nn-drawer>
    </div>
</template>

<script setup>
    import { ref, watch, onActivated, onDeactivated } from 'vue';
    import { notify } from '../../utils/notify';
    import { formatBmpClientLabel } from '../../utils/bmpClientLabel';
    import { ProfileOutlined } from '../../ui/icons';
    import BmpRouteEventTimeline from '../../components/BmpRouteEventTimeline.vue';
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

    // 客户端
    const clientList = ref([]);
    const activeClientKey = ref('');
    const clientTabBarStyle = { width: '148px', flex: '0 0 148px' };

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
    const detailsTabKey = ref('detail');
    const routeEventTarget = ref(null);
    const routeDetailLoading = ref(false);
    let routeDetailRequestId = 0;

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

    const isSessionOnline = session => getRecordOnlineState(session) ?? isRecordOnline(getActiveClient());

    const formatConnectionState = record => (isRecordOnline(record) ? '在线' : '已断开');

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
                    ribType: scope.ribType ?? null
                }))
                .filter(scope => scope.addrFamilyType !== null && scope.ribType !== null);
        }
        if (session?.persistentScopeId) {
            return [
                {
                    persistentScopeId: session.persistentScopeId,
                    addrFamilyType: session.addrFamilyType ?? session.enabledAddrFamilyTypes?.[0] ?? null,
                    ribType: session.ribType ?? session.ribTypes?.[0] ?? null
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
            ...(Array.isArray(session?.ribTypes) ? session.ribTypes : []),
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
        routeDetailRequestId += 1;
        routeDetailLoading.value = false;
        detailsTabKey.value = 'detail';
        routeEventTarget.value = null;
        currentDetails.value = record;
        detailsDrawerTitle.value = `Session 详情: ${record.sessionIp}`;
        detailsDrawerVisible.value = true;
    };

    const viewRouteDetailJson = async record => {
        const requestId = ++routeDetailRequestId;
        const routeKey = getRouteKey(record);
        const sessionInfo = getSessionApiInfo(getActiveSession());

        detailsDrawerTitle.value = `路由detail: ${record.ip || ''}`;
        detailsDrawerVisible.value = true;
        detailsTabKey.value = 'detail';
        currentDetails.value = null;
        routeDetailLoading.value = true;
        routeEventTarget.value = {
            scopeId: record.persistentScopeId || sessionInfo?.persistentScopeId || '',
            routeKey,
            routeId: record.persistentRouteId || ''
        };

        if (
            !activeClientKey.value ||
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

        const client = getActiveClientApiInfo();
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

    const formatClientTab = client => {
        return formatBmpClientLabel(client);
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
        detailsTabKey.value = 'detail';
        routeEventTarget.value = null;
        routeDetailLoading.value = false;
    };

    const markClientOffline = client => {
        const existing = clientList.value.find(item => isSameClient(item, client));
        if (existing) {
            existing.isOnline = false;
            existing.connectionState = 'offline';
        }
        if (isSameClient(client, getActiveClient())) {
            bgpSessionList.value = bgpSessionList.value.map(session => ({
                ...session,
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
                bgpSessionList.value = [];
                resetSessionAndRouteSelection();
            }
        } else {
            console.error('termination handler error', result.msg);
        }
    };

    const onRouteUpdate = result => {
        if (result.status !== 'success' || !result.data) return;
        const updates = Array.isArray(result.data.updates) ? result.data.updates : [result.data];
        const activeClient = getActiveClient();
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

        if (!data.session || !isSameClient(data.client, getActiveClient())) return;

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
            return;
        }

        bgpSessionList.value.push(data.session);
        if (!activeBgpSessionKey.value) {
            activeBgpSessionKey.value = getSessionKey(data.session);
        }
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
        clientKey: activeClientKey.value,
        sessionKey: activeBgpSessionKey.value,
        af: activeLocRibAf.value,
        ribType: activeLocRibType.value,
        page: bgpRoutePagination.value.current,
        routeState: routeStateFilter.value,
        prefix: appliedRoutePrefixFilter.value
    });

    const getRouteSelectionKey = selection =>
        `${selection.clientKey}|${selection.sessionKey}|${selection.af}|${selection.ribType}|${selection.page}|${selection.routeState}|${selection.prefix}`;

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
            activeLocRibType.value = selectedScope.ribType;
        } else {
            if (!enabledAddrFamilyTypes.some(af => sameSelectorValue(af, activeLocRibAf.value))) {
                activeLocRibAf.value = enabledAddrFamilyTypes[0];
            }
            if (!ribTypes.some(ribType => sameSelectorValue(ribType, activeLocRibType.value))) {
                activeLocRibType.value = ribTypes[0];
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
        if (!activeClientKey.value) {
            bgpSessionList.value = [];
            resetSessionAndRouteSelection();
            return;
        }

        const requestId = ++sessionListRequestId;
        const requestClientKey = activeClientKey.value;
        try {
            const clientInfo = getActiveClientApiInfo();
            if (!clientInfo) {
                bgpSessionList.value = [];
                resetSessionAndRouteSelection();
                return;
            }

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
                notify.error('获取BGP邻居列表失败');
            }
        } catch (error) {
            if (requestId !== sessionListRequestId || requestClientKey !== activeClientKey.value) {
                return;
            }
            console.error(error);
            bgpSessionList.value = [];
            resetSessionAndRouteSelection();
            notify.error('获取BGP邻居列表失败');
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
        const previousActiveClientKey = activeClientKey.value;

        EventBus.on('bmp:sessionUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onSessionUpdate);
        EventBus.on('bmp:initiation', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onClientListUpdate);
        EventBus.on('bmp:termination', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onTerminationHandler);
        EventBus.on('bmp:routeUpdate', BMP_EVENT_PAGE_ID.PAGE_ID_BMP_BGP_SESSION, onRouteUpdate);

        await loadClientList();
        // activeClientKey 变化时 watcher 会负责加载；缓存回切且选择未变时在后台刷新当前数据。
        if (activeClientKey.value && activeClientKey.value === previousActiveClientKey) {
            await loadBgpSessionList();
        }
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
            !activeClientKey.value ||
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

        const client = getActiveClientApiInfo();
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
            !activeClientKey.value ||
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

        const client = getActiveClientApiInfo();
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

    .route-detail-json {
        margin: 0;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
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
