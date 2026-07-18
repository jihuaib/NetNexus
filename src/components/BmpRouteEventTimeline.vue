<template>
    <section class="bmp-route-event-timeline" data-testid="bmp-route-event-timeline">
        <div v-if="hasQueryIdentity" class="timeline-toolbar">
            <div class="timeline-summary">
                <strong>事件轨迹</strong>
                <span v-if="total !== null">共 {{ total }} 条</span>
                <span v-else-if="events.length > 0">已加载 {{ events.length }} 条</span>
                <span class="timeline-order">最新在前</span>
                <span v-if="normalizedAsOfEventId !== null" class="timeline-order">
                    截至 Event #{{ normalizedAsOfEventId }}
                </span>
            </div>
            <nn-button size="small" :loading="initialLoading" @click="reload">刷新</nn-button>
        </div>

        <nn-alert
            v-if="!hasQueryIdentity"
            type="warning"
            show-icon
            message="缺少路由持久化标识，无法查询事件轨迹"
            description="事件查询必须同时包含当前 Scope 和 Route Key/Route ID，避免混入其他 RIB 的同前缀路由。"
        />

        <div v-else-if="initialError" class="timeline-error">
            <nn-alert type="error" show-icon message="事件轨迹加载失败" :description="initialError" />
            <nn-button size="small" @click="reload">重试</nn-button>
        </div>

        <nn-spin v-else :spinning="initialLoading">
            <div v-if="initialLoading && events.length === 0" class="timeline-loading-placeholder" />
            <nn-empty v-else-if="events.length === 0" description="当前保留期内没有这条路由的事件" />

            <div v-else class="timeline-list">
                <article
                    v-for="(event, index) in events"
                    :key="event.eventId"
                    class="timeline-item"
                    data-testid="bmp-route-event-item"
                    :data-event-type="event.eventType"
                >
                    <div class="timeline-rail" aria-hidden="true">
                        <span class="timeline-dot" :class="getEventTone(event.eventType)" />
                        <span v-if="index < events.length - 1 || canLoadMore" class="timeline-line" />
                    </div>

                    <div class="event-card">
                        <header class="event-header">
                            <div class="event-title">
                                <nn-tag :color="getEventColor(event.eventType)">
                                    {{ getEventLabel(event.eventType) }}
                                </nn-tag>
                                <strong>{{ formatObservedAt(event) }}</strong>
                            </div>
                            <span class="event-id">#{{ event.eventId }}</span>
                        </header>

                        <div class="event-meta">
                            <span>Epoch {{ formatNullable(event.ribEpoch) }}</span>
                            <span v-if="event.sourceTimestampMs !== null && event.sourceTimestampMs !== undefined">
                                设备时间 {{ formatTimestamp(event.sourceTimestampMs) }}
                            </span>
                            <span v-if="event.connectionId" :title="event.connectionId">
                                Connection {{ compactId(event.connectionId) }}
                            </span>
                        </div>

                        <p class="event-summary">{{ getEventSummary(event, index) }}</p>

                        <div v-if="getAttributeChanges(event, index).length > 0" class="attribute-changes">
                            <div class="section-label">关键属性变化</div>
                            <div
                                v-for="change in getAttributeChanges(event, index)"
                                :key="change.key"
                                class="attribute-change"
                            >
                                <strong>{{ change.label }}</strong>
                                <span class="old-value" :title="change.before">{{ change.before }}</span>
                                <span aria-hidden="true">→</span>
                                <span class="new-value" :title="change.after">{{ change.after }}</span>
                            </div>
                        </div>

                        <div v-if="getSnapshotItems(event).length > 0" class="route-snapshot">
                            <div class="section-label">{{ getSnapshotLabel(event) }}</div>
                            <dl>
                                <div v-for="item in getSnapshotItems(event)" :key="item.key">
                                    <dt>{{ item.label }}</dt>
                                    <dd :title="item.value">{{ item.value }}</dd>
                                </div>
                            </dl>
                        </div>

                        <div v-if="event.reason || event.attrId" class="event-footnotes">
                            <span v-if="event.reason">
                                <strong>Reason:</strong>
                                {{ event.reason }}
                            </span>
                            <span v-if="event.attrId" :title="event.attrId">
                                <strong>Attr:</strong>
                                {{ compactId(event.attrId) }}
                            </span>
                        </div>
                    </div>
                </article>
            </div>
        </nn-spin>

        <div v-if="loadMoreError" class="load-more-error">
            <nn-alert type="error" show-icon message="更早事件加载失败" :description="loadMoreError" />
        </div>

        <div v-if="events.length > 0" class="timeline-footer">
            <nn-button v-if="canLoadMore" :loading="loadingMore" @click="loadMore">加载更早事件</nn-button>
            <span v-else-if="limitReached" class="limit-note">
                为避免抽屉渲染过重，最多展示最近 {{ maxEvents }} 条事件
            </span>
            <span v-else class="limit-note">已到当前保留历史的最早事件</span>
        </div>
    </section>
</template>

<script setup>
    import { computed, ref, watch } from 'vue';

    const PAGE_SIZE = 50;
    const MAX_EVENTS = 500;

    const ATTRIBUTE_FIELDS = [
        { key: 'nextHop', label: 'Next Hop' },
        { key: 'asPath', label: 'AS Path' },
        { key: 'localPref', label: 'Local Pref' },
        { key: 'med', label: 'MED' },
        { key: 'origin', label: 'Origin' },
        { key: 'communities', label: 'Communities' }
    ];

    const EVENT_PRESENTATION = {
        announce: { label: '宣告', color: 'green', tone: 'success' },
        replace: { label: '属性变更', color: 'blue', tone: 'info' },
        refresh: { label: '刷新', color: 'cyan', tone: 'info' },
        'upsert-noop': { label: '重复上报', color: 'default', tone: 'muted' },
        withdraw: { label: '撤销', color: 'red', tone: 'danger' },
        'withdraw-noop': { label: '无效撤销', color: 'orange', tone: 'warning' },
        purge: { label: '清理', color: 'purple', tone: 'warning' }
    };

    const props = defineProps({
        active: {
            type: Boolean,
            default: true
        },
        scopeId: {
            type: String,
            default: ''
        },
        routeKey: {
            type: String,
            default: ''
        },
        routeId: {
            type: String,
            default: ''
        },
        asOfEventId: {
            type: [Number, String],
            default: null
        }
    });

    const events = ref([]);
    const total = ref(null);
    const nextCursor = ref(null);
    const loading = ref(false);
    const initialError = ref('');
    const loadMoreError = ref('');
    const loadedIdentity = ref('');
    let stateIdentity = '';
    let requestSequence = 0;

    const normalizedScopeId = computed(() => String(props.scopeId || '').trim());
    const normalizedRouteKey = computed(() => String(props.routeKey || '').trim());
    const normalizedRouteId = computed(() => String(props.routeId || '').trim());
    const normalizedAsOfEventId = computed(() => {
        if (props.asOfEventId === null || props.asOfEventId === undefined || props.asOfEventId === '') return null;
        const value = Number(props.asOfEventId);
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    });
    const hasQueryIdentity = computed(() =>
        Boolean(normalizedScopeId.value && (normalizedRouteKey.value || normalizedRouteId.value))
    );
    const queryIdentity = computed(() => {
        const routeIdentity = normalizedRouteId.value
            ? `id:${normalizedRouteId.value}`
            : `key:${normalizedRouteKey.value}`;
        return `${normalizedScopeId.value}\u0000${routeIdentity}\u0000as-of:${normalizedAsOfEventId.value ?? 'live'}`;
    });
    const initialLoading = computed(() => loading.value && events.value.length === 0);
    const loadingMore = computed(() => loading.value && events.value.length > 0);
    const limitReached = computed(() => events.value.length >= MAX_EVENTS && Boolean(nextCursor.value));
    const canLoadMore = computed(
        () => Boolean(nextCursor.value) && events.value.length < MAX_EVENTS && !initialLoading.value
    );
    const maxEvents = MAX_EVENTS;

    const resetState = () => {
        events.value = [];
        total.value = null;
        nextCursor.value = null;
        loading.value = false;
        initialError.value = '';
        loadMoreError.value = '';
        loadedIdentity.value = '';
    };

    const unwrapResponse = response => {
        if (!response) {
            throw new Error('未收到事件查询响应');
        }
        const nestedError = typeof response.error === 'string' ? response.error : response.error?.message;
        if ((response.status && response.status !== 'success') || response.error) {
            throw new Error(response.msg || response.message || nestedError || '事件查询失败');
        }
        const data = response.data ?? response;
        if (!data || !Array.isArray(data.list)) {
            throw new Error('事件查询响应格式无效');
        }
        return data;
    };

    const buildQuery = (cursor = null) => {
        const remaining = Math.max(1, MAX_EVENTS - events.value.length);
        const query = {
            scopeId: normalizedScopeId.value,
            pageSize: Math.min(PAGE_SIZE, remaining),
            includeTotal: cursor ? false : true
        };
        if (normalizedRouteId.value) {
            query.routeId = normalizedRouteId.value;
        } else if (normalizedRouteKey.value) {
            query.routeKey = normalizedRouteKey.value;
        }
        if (normalizedAsOfEventId.value !== null) query.toEventId = normalizedAsOfEventId.value;
        if (cursor) query.cursor = cursor;
        return query;
    };

    const queryEvents = async ({ append = false } = {}) => {
        if (!hasQueryIdentity.value || !props.active || loading.value) return;
        const identityAtRequest = queryIdentity.value;
        const cursor = append ? nextCursor.value : null;
        if (append && !cursor) return;

        const currentRequest = ++requestSequence;
        loading.value = true;
        if (append) {
            loadMoreError.value = '';
        } else {
            initialError.value = '';
        }

        try {
            if (!window.bmpApi?.getPersistedRouteEvents) {
                throw new Error('当前 BMP 服务不支持持久化事件查询，请重启应用后重试');
            }
            const data = unwrapResponse(await window.bmpApi.getPersistedRouteEvents(buildQuery(cursor)));
            if (currentRequest !== requestSequence || identityAtRequest !== queryIdentity.value) return;

            const incoming = data.list.filter(item => item && item.eventId !== null && item.eventId !== undefined);
            if (append) {
                const knownIds = new Set(events.value.map(item => item.eventId));
                events.value = [...events.value, ...incoming.filter(item => !knownIds.has(item.eventId))].slice(
                    0,
                    MAX_EVENTS
                );
            } else {
                events.value = incoming.slice(0, MAX_EVENTS);
                total.value = Number.isFinite(Number(data.total)) ? Number(data.total) : null;
            }
            nextCursor.value = data.nextCursor || null;
            loadedIdentity.value = identityAtRequest;
        } catch (error) {
            if (currentRequest !== requestSequence || identityAtRequest !== queryIdentity.value) return;
            const message = error?.message || '事件查询失败';
            if (append) {
                loadMoreError.value = message;
            } else {
                initialError.value = message;
            }
        } finally {
            if (currentRequest === requestSequence) loading.value = false;
        }
    };

    const reload = () => {
        requestSequence += 1;
        resetState();
        if (props.active && hasQueryIdentity.value) queryEvents();
    };

    const loadMore = () => queryEvents({ append: true });

    watch(
        [() => props.active, queryIdentity],
        ([active, identity]) => {
            if (identity !== stateIdentity) {
                requestSequence += 1;
                stateIdentity = identity;
                resetState();
            }
            if (active && hasQueryIdentity.value && loadedIdentity.value !== identity && !loading.value) {
                queryEvents();
            }
        },
        { immediate: true }
    );

    const isMissing = value => value === null || value === undefined || value === '';

    const formatValue = value => {
        if (isMissing(value)) return '-';
        if (Array.isArray(value)) return value.length > 0 ? value.map(formatValue).join(' ') : '-';
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value);
            } catch (_error) {
                return String(value);
            }
        }
        return String(value);
    };

    const valuesEqual = (left, right) => {
        if (isMissing(left) && isMissing(right)) return true;
        if (typeof left === 'object' || typeof right === 'object') {
            try {
                return JSON.stringify(left) === JSON.stringify(right);
            } catch (_error) {
                return String(left) === String(right);
            }
        }
        return left === right;
    };

    const getEventPresentation = eventType =>
        EVENT_PRESENTATION[eventType] || { label: eventType || '未知事件', color: 'default', tone: 'muted' };

    const getEventLabel = eventType => getEventPresentation(eventType).label;
    const getEventColor = eventType => getEventPresentation(eventType).color;
    const getEventTone = eventType => `is-${getEventPresentation(eventType).tone}`;

    const formatTimestamp = value => {
        const timestamp = Number(value);
        if (!Number.isFinite(timestamp)) return '-';
        return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
    };

    const formatObservedAt = event =>
        event.observedAtMs !== null && event.observedAtMs !== undefined
            ? formatTimestamp(event.observedAtMs)
            : event.observedAt || '-';

    const formatNullable = value => (value === null || value === undefined ? '-' : value);
    const compactId = value => {
        const text = String(value || '');
        return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
    };

    const APPLIED_SNAPSHOT_EVENT_TYPES = new Set(['announce', 'replace', 'refresh']);
    const DELETE_EVENT_TYPES = new Set(['withdraw', 'withdraw-noop', 'purge']);

    const hasAttributeSnapshot = event =>
        Boolean(event?.attrId) ||
        Boolean(event?.route && ATTRIBUTE_FIELDS.some(field => !isMissing(event.route[field.key])));

    const getPreviousAppliedSnapshot = index => {
        for (let candidateIndex = index + 1; candidateIndex < events.value.length; candidateIndex += 1) {
            const candidate = events.value[candidateIndex];
            if (candidate?.eventType === 'withdraw' || candidate?.eventType === 'purge') {
                return { status: 'absent', route: null };
            }
            if (APPLIED_SNAPSHOT_EVENT_TYPES.has(candidate?.eventType)) {
                return candidate.route
                    ? { status: 'available', route: candidate.route }
                    : { status: 'unavailable', route: null };
            }
            // upsert-noop / withdraw-noop did not change the current projection and
            // therefore cannot be the "before" side of a successful replace.
        }
        if (nextCursor.value && events.value.length < MAX_EVENTS) {
            return { status: 'pending', route: null };
        }
        return { status: 'unavailable', route: null };
    };

    const getAttributeChanges = (event, index) => {
        if (!event?.route || event.eventType !== 'replace') return [];
        const baseline = getPreviousAppliedSnapshot(index);
        if (baseline.status !== 'available') return [];
        return ATTRIBUTE_FIELDS.filter(field => !valuesEqual(baseline.route[field.key], event.route[field.key])).map(
            field => ({
                ...field,
                before: formatValue(baseline.route[field.key]),
                after: formatValue(event.route[field.key])
            })
        );
    };

    const getSnapshotItems = event => {
        if (!event?.route || (DELETE_EVENT_TYPES.has(event.eventType) && !hasAttributeSnapshot(event))) return [];
        return ATTRIBUTE_FIELDS.filter(field => !isMissing(event.route[field.key])).map(field => ({
            ...field,
            value: formatValue(event.route[field.key])
        }));
    };

    const getSnapshotLabel = event => {
        switch (event?.eventType) {
            case 'upsert-noop':
                return '未应用的上报快照';
            case 'withdraw':
                return '撤销前属性快照';
            case 'withdraw-noop':
                return '撤销事件携带的属性快照';
            case 'purge':
                return '清理前属性快照';
            default:
                return '当次属性快照';
        }
    };

    const getEventSummary = (event, index) => {
        switch (event.eventType) {
            case 'announce':
                return '路由进入当前 RIB。';
            case 'replace': {
                const baseline = getPreviousAppliedSnapshot(index);
                if (baseline.status === 'pending') {
                    return '路由属性已替换；加载更早事件后可计算变化前的基线。';
                }
                if (baseline.status !== 'available') {
                    return '路由属性已替换；更早属性基线不在当前可用历史中，无法计算字段变化。';
                }
                return getAttributeChanges(event, index).length > 0
                    ? '路由仍在当前 RIB，关键 Path Attributes 已变化。'
                    : '路由仍在当前 RIB，变化位于其他属性或载荷字段。';
            }
            case 'refresh':
                return '路由重新上报，关键 Path Attributes 未变化。';
            case 'upsert-noop':
                return hasAttributeSnapshot(event)
                    ? '收到路由上报，但未改变当前 RIB 投影；下方是未应用的上报值。'
                    : '收到路由上报，但未改变当前 RIB 投影。';
            case 'withdraw':
                return hasAttributeSnapshot(event)
                    ? '路由从当前 RIB 撤销；本事件保留了撤销前属性快照。'
                    : '路由从当前 RIB 撤销。本事件只保存 NLRI；撤销前属性请查看下一条较早事件。';
            case 'withdraw-noop':
                return hasAttributeSnapshot(event)
                    ? '收到撤销，但没有删除当前 RIB 中的路由；下方属性是事件携带值，不代表当前投影改变。'
                    : '收到撤销，但没有删除当前 RIB 中的路由。本事件只保存 NLRI；此前属性请查看下一条较早事件。';
            case 'purge':
                return hasAttributeSnapshot(event)
                    ? 'Collector 清理了这条路由；本事件保留了清理前属性快照。'
                    : 'Collector 清理了这条路由。清理事件只保存 NLRI；清理前属性请查看下一条较早事件。';
            default:
                return event.eventType ? `记录事件 ${event.eventType}。` : '记录了一次路由事件。';
        }
    };
</script>

<style scoped>
    .bmp-route-event-timeline {
        min-height: 180px;
    }

    .timeline-toolbar,
    .timeline-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
    }

    .timeline-toolbar {
        margin-bottom: 16px;
    }

    .timeline-summary {
        display: flex;
        align-items: baseline;
        gap: 10px;
        color: var(--nn-color-text-secondary);
    }

    .timeline-summary strong {
        color: var(--nn-color-text-strong);
    }

    .timeline-order,
    .event-id,
    .limit-note {
        color: var(--nn-color-text-muted);
        font-size: 12px;
    }

    .timeline-error,
    .load-more-error {
        display: grid;
        gap: 12px;
    }

    .timeline-error :deep(.nn-button) {
        justify-self: start;
    }

    .load-more-error {
        margin-top: 12px;
    }

    .timeline-loading-placeholder {
        min-height: 180px;
    }

    .timeline-list {
        display: grid;
    }

    .timeline-item {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr);
        gap: 10px;
    }

    .timeline-rail {
        display: flex;
        flex-direction: column;
        align-items: center;
    }

    .timeline-dot {
        z-index: 1;
        width: 11px;
        height: 11px;
        margin-top: 18px;
        border: 2px solid var(--nn-color-bg-elevated);
        border-radius: 50%;
        background: var(--nn-color-text-muted);
        box-shadow: 0 0 0 2px var(--nn-color-border-light);
    }

    .timeline-dot.is-success {
        background: var(--nn-color-success);
    }

    .timeline-dot.is-info {
        background: var(--nn-color-info);
    }

    .timeline-dot.is-warning {
        background: var(--nn-color-warning);
    }

    .timeline-dot.is-danger {
        background: var(--nn-color-error);
    }

    .timeline-line {
        flex: 1;
        width: 1px;
        min-height: 18px;
        background: var(--nn-color-border-light);
    }

    .event-card {
        min-width: 0;
        margin-bottom: 14px;
        padding: 14px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        background: var(--nn-color-bg-surface);
    }

    .event-header,
    .event-title,
    .event-meta,
    .event-footnotes {
        display: flex;
        align-items: center;
        gap: 8px 12px;
        flex-wrap: wrap;
    }

    .event-header {
        justify-content: space-between;
    }

    .event-title {
        min-width: 0;
    }

    .event-title :deep(.nn-tag) {
        margin-inline-end: 0;
    }

    .event-meta,
    .event-footnotes {
        margin-top: 8px;
        color: var(--nn-color-text-muted);
        font-size: 12px;
    }

    .event-summary {
        margin: 10px 0 0;
        color: var(--nn-color-text-secondary);
    }

    .attribute-changes,
    .route-snapshot {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px dashed var(--nn-color-border-light);
    }

    .section-label {
        margin-bottom: 7px;
        color: var(--nn-color-text-muted);
        font-size: 12px;
        font-weight: 600;
    }

    .attribute-change {
        display: grid;
        grid-template-columns: minmax(80px, 0.5fr) minmax(0, 1fr) auto minmax(0, 1fr);
        gap: 8px;
        align-items: baseline;
        padding: 4px 0;
        font-size: 12px;
    }

    .attribute-change span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .old-value {
        color: var(--nn-color-text-muted);
        text-decoration: line-through;
    }

    .new-value {
        color: var(--nn-color-text-strong);
    }

    .route-snapshot dl {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px 16px;
        margin: 0;
    }

    .route-snapshot dl > div {
        min-width: 0;
    }

    .route-snapshot dt {
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .route-snapshot dd {
        margin: 2px 0 0;
        overflow: hidden;
        color: var(--nn-color-text);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .timeline-footer {
        justify-content: center;
        margin-top: 4px;
        padding-top: 12px;
        border-top: 1px solid var(--nn-color-border-light);
    }

    @media (max-width: 640px) {
        .attribute-change {
            grid-template-columns: 1fr;
        }

        .attribute-change > span[aria-hidden='true'] {
            display: none;
        }

        .route-snapshot dl {
            grid-template-columns: 1fr;
        }
    }
</style>
