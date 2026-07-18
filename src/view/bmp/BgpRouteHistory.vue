<template>
    <div class="nn-container bmp-full-page route-history-page" data-testid="bmp-route-history-page">
        <nn-row class="bmp-full-row">
            <nn-col :span="24">
                <nn-card title="路由轨迹" class="bmp-full-card">
                    <div class="route-toolbar" aria-label="路由轨迹筛选">
                        <div class="route-toolbar-query">
                            <nn-input
                                id="route-history-prefix"
                                v-model:value="draftFilters.prefix"
                                data-testid="route-history-prefix"
                                allow-clear
                                placeholder="IP、CIDR 或 NLRI 标识（evpn:、bgp-ls:、dst=）"
                                :status="queryError ? 'error' : ''"
                                style="width: 360px"
                                @update:value="queryError = ''"
                                @press-enter="search"
                            />
                            <nn-select
                                v-model:value="draftFilters.scopeKind"
                                data-testid="route-history-scope-kind"
                                :options="scopeKindOptions"
                                allow-clear
                                placeholder="全部 Scope"
                                style="width: 160px"
                                @change="handleScopeKindChange"
                            />
                            <nn-select
                                v-model:value="draftFilters.ribType"
                                data-testid="route-history-rib-type"
                                :options="ribTypeOptions"
                                :allow-clear="draftFilters.scopeKind === 'peer'"
                                :disabled="!draftFilters.scopeKind || draftFilters.scopeKind === 'loc-rib'"
                                :placeholder="ribTypePlaceholder"
                                style="width: 180px"
                            />
                            <nn-button
                                type="primary"
                                data-testid="route-history-search"
                                :loading="initialLoading"
                                @click="search"
                            >
                                查询
                            </nn-button>
                            <nn-button :disabled="loading" @click="resetFilters">重置</nn-button>
                        </div>
                        <div v-if="hasSearched" class="route-toolbar-status">
                            <nn-tag color="blue">Scope 轨迹 {{ formatCount(total) }}</nn-tag>
                            <nn-tag>已加载 {{ formatCount(histories.length) }}</nn-tag>
                            <span class="event-boundary">Event 上界 #{{ asOfEventId ?? '-' }}</span>
                        </div>
                    </div>
                    <nn-alert
                        class="history-notice"
                        type="info"
                        show-icon
                        message="轨迹包含仍在 RIB 以及已撤销、已清理的路由"
                        :description="retentionDescription"
                    />

                    <div v-if="initialError" class="history-error">
                        <nn-alert type="error" show-icon message="路由轨迹查询失败" :description="initialError" />
                        <nn-button data-testid="route-history-retry" @click="retry">重试</nn-button>
                    </div>

                    <div v-else class="history-table-shell" data-testid="route-history-results">
                        <nn-table
                            class="route-table history-table"
                            data-testid="route-history-table"
                            :columns="historyColumns"
                            :data-source="histories"
                            :loading="loading"
                            :pagination="false"
                            :row-key="getHistoryKey"
                            :custom-row="getHistoryRowAttributes"
                            :scroll="{ x: 1740, y: '100%' }"
                            size="small"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'prefix'">
                                    <div class="stacked-cell route-cell">
                                        <strong :title="formatRouteIdentity(record.route)">
                                            {{ formatRouteIdentity(record.route) }}
                                        </strong>
                                        <span :title="record.routeId">Route {{ compactId(record.routeId) }}</span>
                                    </div>
                                </template>
                                <template v-else-if="column.key === 'latestEvent'">
                                    <div class="stacked-cell latest-event-cell">
                                        <nn-tag :color="getEventColor(record.latestEvent?.eventType)">
                                            最近保留事件：{{ getEventLabel(record.latestEvent?.eventType) }}
                                        </nn-tag>
                                        <span>{{ formatTimestamp(record.latestEvent?.observedAtMs) }}</span>
                                        <span v-if="record.latestEvent?.reason" :title="record.latestEvent.reason">
                                            Reason: {{ record.latestEvent.reason }}
                                        </span>
                                    </div>
                                </template>
                                <template v-else-if="column.key === 'source'">
                                    <span class="ellipsis-cell" :title="formatSource(record.source)">
                                        {{ formatSource(record.source) }}
                                    </span>
                                </template>
                                <template v-else-if="column.key === 'scope'">
                                    <div class="stacked-cell">
                                        <span :title="formatScope(record.scope)">{{ formatScope(record.scope) }}</span>
                                        <span :title="record.scopeId">Scope {{ compactId(record.scopeId) }}</span>
                                    </div>
                                </template>
                                <template v-else-if="column.key === 'addressFamily'">
                                    <div class="stacked-cell">
                                        <span>{{ formatAddressFamily(record.scope, record.route) }}</span>
                                        <span>{{ formatRibType(record.scope) }}</span>
                                    </div>
                                </template>
                                <template v-else-if="column.key === 'identity'">
                                    <div class="stacked-cell">
                                        <span>RD {{ formatIdentityValue(record.route?.rd) }}</span>
                                        <span>Path ID {{ formatIdentityValue(record.route?.pathId) }}</span>
                                    </div>
                                </template>
                                <template v-else-if="column.key === 'eventCount'">
                                    {{ formatCount(record.eventCount) }}
                                </template>
                                <template v-else-if="column.key === 'retainedRange'">
                                    <div class="stacked-cell retained-range-cell">
                                        <span>最早 {{ formatTimestamp(record.firstObservedAtMs) }}</span>
                                        <span>最近 {{ formatTimestamp(record.latestEvent?.observedAtMs) }}</span>
                                    </div>
                                </template>
                                <template v-else-if="column.key === 'action'">
                                    <nn-button
                                        type="link"
                                        size="small"
                                        data-testid="route-history-open"
                                        @click="openTimeline(record)"
                                    >
                                        查看轨迹
                                    </nn-button>
                                </template>
                            </template>
                            <template #emptyText>
                                <div
                                    :data-testid="hasSearched && !loading ? 'route-history-empty' : undefined"
                                    class="history-empty"
                                >
                                    <nn-empty
                                        :description="
                                            hasSearched
                                                ? `当前保留期内没有 ${lastQueryLabel || '该 Prefix / NLRI'} 的路由事件`
                                                : '输入 IP、CIDR 或 NLRI 标识，查询已撤销、已清理及仍保留的路由轨迹'
                                        "
                                    />
                                </div>
                            </template>
                        </nn-table>

                        <div v-if="loadMoreError" class="load-more-error">
                            <nn-alert type="error" show-icon message="更多轨迹加载失败" :description="loadMoreError" />
                        </div>
                        <footer v-if="histories.length > 0" class="result-footer">
                            <nn-button
                                v-if="nextCursor"
                                data-testid="route-history-load-more"
                                :loading="loadingMore"
                                @click="loadMore"
                            >
                                加载更多轨迹
                            </nn-button>
                            <span v-else>已加载该 Event 上界内的全部轨迹</span>
                        </footer>
                    </div>
                </nn-card>
            </nn-col>
        </nn-row>

        <nn-drawer v-model:open="drawerOpen" :title="drawerTitle" width="760px" placement="right">
            <div v-if="selectedHistory" class="drawer-history-identity">
                <strong>{{ formatRouteIdentity(selectedHistory.route) }}</strong>
                <span :title="selectedHistory.scopeId">Scope {{ compactId(selectedHistory.scopeId) }}</span>
                <span>{{ formatScope(selectedHistory.scope) }}</span>
            </div>
            <BmpRouteEventTimeline
                v-if="selectedHistory"
                :active="drawerOpen"
                :scope-id="selectedHistory.scopeId"
                :route-id="selectedHistory.routeId"
                :route-key="selectedHistory.route?.routeKey || ''"
                :as-of-event-id="asOfEventId"
            />
        </nn-drawer>
    </div>
</template>

<script setup>
    import ipaddr from 'ipaddr.js';
    import { computed, onMounted, reactive, ref } from 'vue';
    import BmpRouteEventTimeline from '../../components/BmpRouteEventTimeline.vue';
    import { ADDRESS_FAMILY_NAME } from '../../const/bgpConst';
    import { BMP_BGP_RIB_TYPE, BMP_BGP_RIB_TYPE_NAME } from '../../const/bmpConst';
    import { notify } from '../../utils/notify';

    defineOptions({ name: 'BgpRouteHistory' });

    const PAGE_SIZE = 30;
    const EVENT_PRESENTATION = {
        announce: { label: '宣告', color: 'green' },
        replace: { label: '属性变更', color: 'blue' },
        refresh: { label: '刷新', color: 'cyan' },
        'upsert-noop': { label: '重复上报', color: 'default' },
        withdraw: { label: '撤销', color: 'red' },
        'withdraw-noop': { label: '无效撤销', color: 'orange' },
        purge: { label: '清理', color: 'purple' }
    };
    const LOC_RIB_TYPE = 'loc-rib';
    const PEER_RIB_TYPES = [
        BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
        BMP_BGP_RIB_TYPE.ADJ_RIB_IN,
        BMP_BGP_RIB_TYPE.ADJ_RIB_OUT,
        BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT
    ];
    const PEER_RIB_TYPE_NAMES = Object.fromEntries(
        PEER_RIB_TYPES.map(ribType => [ribType, BMP_BGP_RIB_TYPE_NAME[ribType]])
    );
    const RIB_TYPE_NAMES = {
        ...PEER_RIB_TYPE_NAMES,
        [BMP_BGP_RIB_TYPE.AS_PATH]: 'Legacy 2-byte AS_PATH（兼容数据）',
        [LOC_RIB_TYPE]: 'Loc-RIB'
    };
    const scopeKindOptions = [
        { label: 'BGP Peer RIB', value: 'peer' },
        { label: 'Loc-RIB', value: 'loc-rib' }
    ];
    const peerRibTypeOptions = Object.entries(PEER_RIB_TYPE_NAMES).map(([value, label]) => ({ value, label }));
    const historyColumns = [
        { title: 'Prefix / NLRI', key: 'prefix', fixed: 'left', width: 300 },
        { title: '最近保留事件', key: 'latestEvent', width: 240 },
        { title: 'Collector', key: 'source', width: 180, ellipsis: true },
        { title: 'Scope', key: 'scope', width: 220 },
        { title: '地址族 / RIB', key: 'addressFamily', width: 180 },
        { title: 'RD / Path ID', key: 'identity', width: 150 },
        { title: '保留事件数', key: 'eventCount', width: 100, align: 'center' },
        { title: '保留时间范围', key: 'retainedRange', width: 280 },
        { title: '操作', key: 'action', fixed: 'right', width: 90, align: 'center' }
    ];

    const draftFilters = reactive({ prefix: '', scopeKind: undefined, ribType: undefined });
    const appliedQuery = ref(null);
    const histories = ref([]);
    const total = ref(null);
    const nextCursor = ref(null);
    const asOfEventId = ref(null);
    const loading = ref(false);
    const hasSearched = ref(false);
    const initialError = ref('');
    const loadMoreError = ref('');
    const queryError = ref('');
    const lastQueryLabel = ref('');
    const oldestRetainedEventAtMs = ref(null);
    const selectedHistory = ref(null);
    const drawerOpen = ref(false);
    let requestSequence = 0;

    const initialLoading = computed(() => loading.value && histories.value.length === 0);
    const loadingMore = computed(() => loading.value && histories.value.length > 0);
    const ribTypeOptions = computed(() => {
        if (draftFilters.scopeKind === 'peer') return peerRibTypeOptions;
        if (draftFilters.scopeKind === LOC_RIB_TYPE) return [{ label: 'Loc-RIB', value: LOC_RIB_TYPE }];
        return [];
    });
    const ribTypePlaceholder = computed(() => {
        if (!draftFilters.scopeKind) return '请先选择 Scope';
        if (draftFilters.scopeKind === LOC_RIB_TYPE) return 'Loc-RIB';
        return '全部 Peer RIB 阶段';
    });
    const drawerTitle = computed(() =>
        selectedHistory.value ? `事件轨迹：${formatRouteIdentity(selectedHistory.value.route)}` : '事件轨迹'
    );
    const retentionDescription = computed(() => {
        const scopeCopy =
            '每行按 Scope ID + Route ID 隔离；当前仍在 RIB 的路由也会显示。“上界内最近保留事件”只是当前留存轨迹在 Event 上界内的最后一条。Event 上界只隔离后续摄入，保留清理或删除 Source 仍可能改变结果。';
        if (!Number.isFinite(oldestRetainedEventAtMs.value)) return scopeCopy;
        return `${scopeCopy} 数据库当前最早保留到 ${formatTimestamp(oldestRetainedEventAtMs.value)}，更早轨迹无法还原。`;
    });

    const parseRouteSelector = rawValue => {
        const input = String(rawValue || '').trim();
        if (!input) throw new Error('请输入要查询的 Prefix 或 NLRI 标识');

        const looksLikeIpv4 = /^\d+(?:\.\d+){3}(?:\/\d+)?$/u.test(input);
        const looksLikeIpv6 = input.includes(':') && /^[0-9a-f:.]+(?:\/\d+)?$/iu.test(input);
        if (ipaddr.isValid(input) || looksLikeIpv4 || looksLikeIpv6) {
            try {
                if (!input.includes('/')) {
                    const address = ipaddr.parse(input);
                    const prefixExact = address.toString();
                    return {
                        prefixExact,
                        afi: address.kind() === 'ipv4' ? 1 : 2,
                        label: prefixExact
                    };
                }
                const [address, prefixLength] = ipaddr.parseCIDR(input);
                const network = address.constructor
                    .networkAddressFromCIDR(`${address.toString()}/${prefixLength}`)
                    .toString();
                return {
                    prefixExact: network,
                    prefixLength,
                    afi: address.kind() === 'ipv4' ? 1 : 2,
                    label: `${network}/${prefixLength}`
                };
            } catch (_error) {
                throw new Error('请输入有效的 IPv4、IPv6 或 CIDR Prefix');
            }
        }

        const flowSpecMatch = /^flowspec\s*:\s*(.+)$/iu.exec(input);
        const identityPrefix = (flowSpecMatch?.[1] || input)
            .replace(/^evpn:/iu, 'evpn:')
            .replace(/^bgp-ls:/iu, 'bgp-ls:');
        return { prefix: identityPrefix, label: input };
    };

    const unwrapResponse = response => {
        if (!response) throw new Error('未收到路由轨迹查询响应');
        const nestedError = typeof response.error === 'string' ? response.error : response.error?.message;
        if ((response.status && response.status !== 'success') || response.error) {
            throw new Error(response.msg || response.message || nestedError || '路由轨迹查询失败');
        }
        const data = response.data ?? response;
        if (data?.kind !== 'route-histories' || !Array.isArray(data.list)) {
            throw new Error('路由轨迹查询响应格式无效');
        }
        return data;
    };

    const buildRequest = cursor => ({
        ...appliedQuery.value,
        groupByRoute: true,
        pageSize: PAGE_SIZE,
        includeTotal: !cursor,
        ...(cursor ? { cursor } : {})
    });

    const queryHistories = async ({ append = false } = {}) => {
        if (!appliedQuery.value) return;
        const cursor = append ? nextCursor.value : null;
        if (append && (loading.value || !cursor)) return;
        const currentRequest = ++requestSequence;
        loading.value = true;
        if (append) loadMoreError.value = '';
        else initialError.value = '';

        try {
            if (!window.bmpApi?.getPersistedRouteEvents) {
                throw new Error('当前 BMP 服务不支持路由轨迹查询，请重启应用后重试');
            }
            const data = unwrapResponse(await window.bmpApi.getPersistedRouteEvents(buildRequest(cursor)));
            if (currentRequest !== requestSequence) return;
            if (append) {
                const known = new Set(histories.value.map(getHistoryKey));
                histories.value = [...histories.value, ...data.list.filter(item => !known.has(getHistoryKey(item)))];
            } else {
                histories.value = data.list;
                total.value = Number.isFinite(Number(data.total)) ? Number(data.total) : data.list.length;
                asOfEventId.value = data.asOfEventId ?? null;
            }
            nextCursor.value = data.nextCursor || null;
        } catch (error) {
            if (currentRequest !== requestSequence) return;
            const message = error?.message || '路由轨迹查询失败';
            if (append) loadMoreError.value = message;
            else initialError.value = message;
        } finally {
            if (currentRequest === requestSequence) loading.value = false;
        }
    };

    const search = () => {
        let parsed;
        try {
            parsed = parseRouteSelector(draftFilters.prefix);
        } catch (error) {
            const message = error?.message || '请输入有效的 Prefix 或 NLRI 标识';
            queryError.value = message;
            notify.error(message);
            return;
        }
        queryError.value = '';
        requestSequence += 1;
        histories.value = [];
        total.value = null;
        nextCursor.value = null;
        asOfEventId.value = null;
        initialError.value = '';
        loadMoreError.value = '';
        selectedHistory.value = null;
        drawerOpen.value = false;
        hasSearched.value = true;
        lastQueryLabel.value = parsed.label;
        appliedQuery.value = {
            ...(parsed.prefixExact ? { prefixExact: parsed.prefixExact } : {}),
            ...(parsed.prefix ? { prefix: parsed.prefix } : {}),
            ...(parsed.prefixLength === undefined ? {} : { prefixLength: parsed.prefixLength }),
            ...(parsed.afi === undefined ? {} : { afi: parsed.afi }),
            ...(draftFilters.scopeKind ? { scopeKind: draftFilters.scopeKind } : {}),
            ...(draftFilters.ribType ? { ribType: draftFilters.ribType } : {})
        };
        queryHistories();
    };

    const retry = () => queryHistories();
    const loadMore = () => queryHistories({ append: true });
    const handleScopeKindChange = scopeKind => {
        draftFilters.ribType = scopeKind === LOC_RIB_TYPE ? LOC_RIB_TYPE : undefined;
    };
    const resetFilters = () => {
        draftFilters.prefix = '';
        draftFilters.scopeKind = undefined;
        draftFilters.ribType = undefined;
        queryError.value = '';
    };
    const openTimeline = history => {
        selectedHistory.value = history;
        drawerOpen.value = true;
    };

    const getHistoryKey = history => `${history?.scopeId || ''}\u0000${history?.routeId || ''}`;
    const getHistoryRowAttributes = () => ({ 'data-testid': 'route-history-row' });
    const formatCount = value => (Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '-');
    const formatTimestamp = value => {
        const timestamp = Number(value);
        return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '-';
    };
    const formatRouteIdentity = route => {
        if (!route) return '-';
        const identity = route.nlriDetail?.prefix || route.ip || route.rawNlri || route.routeKey;
        if (!identity) return '-';
        if (!ipaddr.isValid(String(identity))) return identity;
        const address = ipaddr.parse(String(identity));
        const prefixLength = Number(route.mask ?? route.nlriDetail?.prefixLength ?? route.nlriDetail?.length);
        const maximum = address.kind() === 'ipv4' ? 32 : 128;
        return Number.isInteger(prefixLength) && prefixLength >= 0 && prefixLength <= maximum
            ? `${address.toString()}/${prefixLength}`
            : address.toString();
    };
    const compactId = value => {
        const text = String(value || '');
        return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text || '-';
    };
    const formatIdentityValue = value => (value === null || value === undefined || value === '' ? '-' : value);
    const formatSource = source => [source?.sysName, source?.remoteIp].filter(Boolean).join(' · ') || '-';
    const formatScope = scope => {
        if (scope?.kind === 'loc-rib') return scope.vrfName ? `Loc-RIB · ${scope.vrfName}` : 'Loc-RIB';
        const peer = scope?.peerIp || '未知 Peer';
        return scope?.peerAs ? `${peer} · AS${scope.peerAs}` : peer;
    };
    const formatAddressFamily = (scope, route) => {
        const familyType = route?.addrFamilyType;
        if (ADDRESS_FAMILY_NAME[familyType]) return ADDRESS_FAMILY_NAME[familyType];
        if (typeof familyType === 'string' && familyType && !/^\d+$/u.test(familyType)) return familyType;
        return `AFI ${scope?.afi ?? '-'} / SAFI ${scope?.safi ?? '-'}`;
    };
    const formatRibType = scope => RIB_TYPE_NAMES[scope?.ribType] || scope?.ribType || '-';
    const getEventPresentation = eventType =>
        EVENT_PRESENTATION[eventType] || { label: eventType || '未知事件', color: 'default' };
    const getEventLabel = eventType => getEventPresentation(eventType).label;
    const getEventColor = eventType => getEventPresentation(eventType).color;

    const loadRetentionStatus = async () => {
        if (!window.bmpApi?.getPersistenceStatus) return;
        try {
            const response = await window.bmpApi.getPersistenceStatus();
            if (!response || (response.status && response.status !== 'success') || response.error) return;
            const status = response.data ?? response;
            const rawOldest = status?.oldestEventAtMs;
            const oldest = rawOldest === null || rawOldest === undefined || rawOldest === '' ? null : Number(rawOldest);
            oldestRetainedEventAtMs.value = Number.isFinite(oldest) ? oldest : null;
        } catch (_error) {
            // Retention status is advisory; history search remains usable if it cannot be loaded.
        }
    };

    onMounted(loadRetentionStatus);
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
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .route-toolbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px 16px;
        flex-wrap: wrap;
        margin-bottom: 8px;
        padding: 12px;
        border-radius: 8px;
        background: var(--nn-color-bg-muted);
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

    .event-boundary,
    .result-footer,
    .stacked-cell > span:last-child,
    .drawer-history-identity span {
        color: var(--nn-color-text-muted);
    }

    .event-boundary {
        font-size: 12px;
        white-space: nowrap;
    }

    .history-notice {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .history-error {
        flex: 1 1 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: flex-start;
        gap: 12px;
        overflow: auto;
    }

    .history-error :deep(.nn-alert) {
        width: 100%;
    }

    .history-table-shell {
        flex: 1 1 0;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .route-table,
    .route-table :deep(.nn-spin-nested-loading),
    .route-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
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

    .route-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 3;
    }

    .history-empty {
        display: grid;
        min-height: 220px;
        place-items: center;
    }

    .stacked-cell {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 3px;
        line-height: 18px;
    }

    .stacked-cell > span,
    .ellipsis-cell {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .route-cell strong {
        display: block;
        overflow: hidden;
        font-family: var(--nn-font-family-mono, monospace);
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .route-cell span,
    .latest-event-cell > span,
    .retained-range-cell,
    .stacked-cell > span:last-child {
        font-size: 12px;
    }

    .latest-event-cell :deep(.nn-tag) {
        width: fit-content;
        max-width: 100%;
        margin-inline-end: 0;
    }

    .load-more-error {
        flex: 0 0 auto;
        margin-top: 8px;
    }

    .result-footer {
        flex: 0 0 auto;
        display: flex;
        min-height: 44px;
        align-items: center;
        justify-content: center;
        font-size: 12px;
    }

    .drawer-history-identity {
        display: flex;
        align-items: center;
        gap: 6px 14px;
        flex-wrap: wrap;
        margin-bottom: 16px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }
</style>
