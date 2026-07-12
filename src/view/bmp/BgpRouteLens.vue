<template>
    <div class="nn-container route-lens-page" data-testid="bmp-route-lens-page">
        <nn-card class="route-lens-shell">
            <template #title>
                <span class="page-title">
                    <RouteOutlined />
                    Route Lens
                </span>
            </template>
            <template #extra>
                <span v-if="generatedAt" class="generated-at">更新于 {{ generatedAt }}</span>
            </template>

            <div class="query-panel">
                <div class="query-copy">
                    <div class="query-title">全局路由追踪</div>
                    <div class="query-description">
                        IP / CIDR 做前缀匹配；EVPN、BGP-LS、FlowSpec 等按 NLRI 标识文本匹配
                    </div>
                </div>
                <div class="query-controls">
                    <nn-input
                        v-model:value="routeQuery"
                        data-testid="route-lens-query"
                        allow-clear
                        placeholder="如 203.0.113.1、evpn:mac-ip、bgp-ls:Link"
                        :status="queryError ? 'error' : ''"
                        @press-enter="searchRoute"
                    >
                        <template #prefix><SearchOutlined /></template>
                    </nn-input>
                    <nn-radio-group v-model:value="routeState" size="small" aria-label="路由状态">
                        <nn-radio-button value="active">Current</nn-radio-button>
                        <nn-radio-button value="all">All</nn-radio-button>
                        <nn-radio-button value="stale">Stale</nn-radio-button>
                    </nn-radio-group>
                    <nn-button type="primary" data-testid="route-lens-search" :loading="loading" @click="searchRoute">
                        查询
                    </nn-button>
                </div>
            </div>

            <div class="evidence-legend" aria-label="证据图例">
                <span class="legend-label">证据口径</span>
                <span class="legend-item">
                    <i class="legend-dot reported" />
                    设备上报
                </span>
                <span class="legend-item">
                    <i class="legend-dot observed" />
                    观测事实
                </span>
                <span class="legend-item">
                    <i class="legend-dot inferred" />
                    推测关联
                </span>
                <span class="legend-note">Path Marking 缺失时不会把推测当作设备的真实选路原因</span>
            </div>

            <nn-alert
                v-if="lensResult?.summary?.truncated"
                class="result-alert"
                type="warning"
                show-icon
                message="结果已截断"
                :description="`本次最多展示 ${lensResult.summary.resultLimit || '-'} 条，请缩小查询范围。`"
            />

            <nn-spin :spinning="loading">
                <div v-if="!hasSearched" class="route-lens-empty">
                    <nn-empty description="输入 Prefix、IP 或 NLRI 标识，查看路由从接收到选中再到发出的完整路径" />
                </div>
                <div v-else-if="loading && !hasMatches" class="route-lens-empty" aria-hidden="true" />
                <div v-else-if="!hasMatches" class="route-lens-empty">
                    <nn-empty :description="`未观测到与 ${lastQuery} 匹配的路由`" />
                    <p>这只代表当前 BMP 数据中没有匹配项，不能直接证明设备从未收到该路由。</p>
                </div>

                <div v-show="hasSearched && hasMatches" class="lens-result">
                    <div class="summary-strip">
                        <div v-for="metric in summaryMetrics" :key="metric.label" class="summary-item">
                            <span class="summary-value">{{ metric.value }}</span>
                            <span class="summary-label">{{ metric.label }}</span>
                        </div>
                    </div>

                    <section class="flow-section" aria-labelledby="route-lens-flow-title">
                        <div class="section-heading">
                            <div>
                                <h2 id="route-lens-flow-title">路由生命周期</h2>
                                <p>同一路由在相邻 RIB 之间的连线属于关联分析，虚线表示需要结合设备实现核验。</p>
                            </div>
                            <nn-tag color="orange">虚线 = 推测关联</nn-tag>
                        </div>

                        <div class="flow-viewport">
                            <div class="route-flow" data-testid="route-lens-flow">
                                <template v-for="(stage, index) in stageDefinitions" :key="stage.key">
                                    <section
                                        class="route-stage"
                                        :class="`route-stage-${stage.key}`"
                                        :data-testid="`route-lens-stage-${stage.key}`"
                                    >
                                        <header class="stage-header">
                                            <span class="stage-index">{{ index + 1 }}</span>
                                            <div class="stage-heading-copy">
                                                <strong>{{ stage.title }}</strong>
                                                <span>{{ stage.subtitle }}</span>
                                            </div>
                                            <span class="stage-count">{{ getStageEntries(stage.key).length }}</span>
                                        </header>

                                        <div class="stage-routes">
                                            <button
                                                v-for="entry in getStageEntries(stage.key)"
                                                :key="entry.id || getEntryKey(entry, stage.key)"
                                                type="button"
                                                class="route-lens-route-card"
                                                data-testid="route-lens-route-card"
                                                @click="openEntryDetails(entry, stage)"
                                            >
                                                <div class="route-card-topline">
                                                    <span class="route-prefix">{{ formatPrefix(entry) }}</span>
                                                    <nn-tag :color="getRouteStateColor(entry)">
                                                        {{ getRouteStateText(entry) }}
                                                    </nn-tag>
                                                </div>
                                                <div class="route-owner" :title="getClientLabel(entry)">
                                                    {{ getClientLabel(entry) }}
                                                </div>
                                                <dl class="route-facts">
                                                    <div>
                                                        <dt>{{ entry.session ? 'Peer' : '实例' }}</dt>
                                                        <dd>{{ getPeerLabel(entry) }}</dd>
                                                    </div>
                                                    <div>
                                                        <dt>VRF / RD</dt>
                                                        <dd>{{ getVrfRdLabel(entry) }}</dd>
                                                    </div>
                                                    <div>
                                                        <dt>地址族</dt>
                                                        <dd>{{ getAddressFamilyLabel(entry) }}</dd>
                                                    </div>
                                                    <div>
                                                        <dt>Next Hop</dt>
                                                        <dd>{{ formatValue(getRoute(entry).nextHop) }}</dd>
                                                    </div>
                                                    <div>
                                                        <dt>AS Path</dt>
                                                        <dd>{{ formatValue(getRoute(entry).asPath) }}</dd>
                                                    </div>
                                                </dl>
                                                <div class="route-attributes">
                                                    <span>LP {{ formatValue(getRoute(entry).localPref) }}</span>
                                                    <span>MED {{ formatValue(getRoute(entry).med) }}</span>
                                                    <span v-if="entry.match">{{ getMatchText(entry.match) }}</span>
                                                </div>
                                                <div v-if="hasPathMarking(entry)" class="path-marking reported-marking">
                                                    <span class="evidence-pill reported">设备上报</span>
                                                    <nn-tag
                                                        v-for="name in getPathMarkingNames(entry)"
                                                        :key="name"
                                                        :color="getPathMarkingColor(name)"
                                                    >
                                                        {{ name }}
                                                    </nn-tag>
                                                    <p v-if="getPathMarkingReason(entry)">
                                                        {{ getPathMarkingReason(entry) }}
                                                    </p>
                                                </div>
                                                <div v-else class="path-marking missing-marking">
                                                    <span class="evidence-pill missing">未上报 Path Marking</span>
                                                    <span>选路原因仅可推测</span>
                                                </div>
                                                <span class="detail-hint">
                                                    查看详情
                                                    <EyeOutlined />
                                                </span>
                                            </button>

                                            <div v-if="getStageEntries(stage.key).length === 0" class="stage-empty">
                                                <span>
                                                    {{
                                                        lensResult?.summary?.truncated
                                                            ? '结果截断，阶段数据可能不完整'
                                                            : '未观测到此阶段路由'
                                                    }}
                                                </span>
                                                <small>
                                                    {{
                                                        lensResult?.summary?.truncated
                                                            ? '请缩小查询范围后重新分析。'
                                                            : stage.emptyHint
                                                    }}
                                                </small>
                                            </div>
                                        </div>
                                    </section>

                                    <div v-if="index < stageDefinitions.length - 1" class="stage-connector">
                                        <span>推测关联</span>
                                        <i />
                                        <b aria-hidden="true">›</b>
                                    </div>
                                </template>
                            </div>
                        </div>
                    </section>

                    <div class="analysis-grid">
                        <section class="analysis-panel">
                            <div class="section-heading compact">
                                <div>
                                    <h2>Inbound 属性差异</h2>
                                    <p>Pre Adj-RIB-In → Post Adj-RIB-In</p>
                                </div>
                                <span class="panel-count">{{ inboundDiffs.length }}</span>
                            </div>
                            <div v-if="inboundDiffs.length" class="diff-list">
                                <button
                                    v-for="(diff, index) in inboundDiffs"
                                    :key="diff.id || `inbound-${index}`"
                                    type="button"
                                    class="diff-card"
                                    @click="openDiffDetails(diff, 'Inbound')"
                                >
                                    <div class="diff-header">
                                        <strong>{{ getDiffTitle(diff, 'Inbound', index) }}</strong>
                                        <nn-tag :color="getDiffStatusColor(diff.status)">
                                            {{ getDiffStatusText(diff.status) }}
                                        </nn-tag>
                                    </div>
                                    <span class="evidence-pill" :class="getEvidenceClass(diff.evidenceType)">
                                        {{ getEvidenceText(diff.evidenceType, true) }}
                                    </span>
                                    <div v-if="getDiffChanges(diff).length" class="change-list">
                                        <div
                                            v-for="change in getDiffChanges(diff)"
                                            :key="change.field"
                                            class="change-row"
                                        >
                                            <span>{{ getAttributeLabel(change.field) }}</span>
                                            <code>{{ formatValue(change.before) }}</code>
                                            <b>→</b>
                                            <code>{{ formatValue(change.after) }}</code>
                                        </div>
                                    </div>
                                    <p v-else>{{ diff.description || '相邻阶段属性未发现变化。' }}</p>
                                </button>
                            </div>
                            <nn-empty v-else description="暂无可关联的 Inbound 属性对" />
                        </section>

                        <section class="analysis-panel">
                            <div class="section-heading compact">
                                <div>
                                    <h2>Outbound 属性差异</h2>
                                    <p>Pre Adj-RIB-Out → Post Adj-RIB-Out</p>
                                </div>
                                <span class="panel-count">{{ outboundDiffs.length }}</span>
                            </div>
                            <div v-if="outboundDiffs.length" class="diff-list">
                                <button
                                    v-for="(diff, index) in outboundDiffs"
                                    :key="diff.id || `outbound-${index}`"
                                    type="button"
                                    class="diff-card"
                                    @click="openDiffDetails(diff, 'Outbound')"
                                >
                                    <div class="diff-header">
                                        <strong>{{ getDiffTitle(diff, 'Outbound', index) }}</strong>
                                        <nn-tag :color="getDiffStatusColor(diff.status)">
                                            {{ getDiffStatusText(diff.status) }}
                                        </nn-tag>
                                    </div>
                                    <span class="evidence-pill" :class="getEvidenceClass(diff.evidenceType)">
                                        {{ getEvidenceText(diff.evidenceType, true) }}
                                    </span>
                                    <div v-if="getDiffChanges(diff).length" class="change-list">
                                        <div
                                            v-for="change in getDiffChanges(diff)"
                                            :key="change.field"
                                            class="change-row"
                                        >
                                            <span>{{ getAttributeLabel(change.field) }}</span>
                                            <code>{{ formatValue(change.before) }}</code>
                                            <b>→</b>
                                            <code>{{ formatValue(change.after) }}</code>
                                        </div>
                                    </div>
                                    <p v-else>{{ diff.description || '相邻阶段属性未发现变化。' }}</p>
                                </button>
                            </div>
                            <nn-empty v-else description="暂无可关联的 Outbound 属性对" />
                        </section>
                    </div>

                    <section class="insights-panel">
                        <div class="section-heading compact">
                            <div>
                                <h2>证据与判断</h2>
                                <p>每条结论都标明证据等级；推测结论需要回到设备策略与选路日志核验。</p>
                            </div>
                            <span class="panel-count">{{ insights.length }}</span>
                        </div>
                        <div v-if="insights.length" class="insight-list">
                            <article
                                v-for="(insight, index) in insights"
                                :key="insight.id || `insight-${index}`"
                                class="insight-item"
                                :class="`insight-${getInsightSeverity(insight)}`"
                            >
                                <span class="evidence-pill" :class="getEvidenceClass(getInsightEvidence(insight))">
                                    {{ getEvidenceText(getInsightEvidence(insight)) }}
                                </span>
                                <div>
                                    <strong>{{ getInsightTitle(insight, index) }}</strong>
                                    <p>{{ getInsightDescription(insight) }}</p>
                                </div>
                            </article>
                        </div>
                        <nn-empty v-else description="暂无额外判断" />
                    </section>
                </div>
            </nn-spin>
        </nn-card>

        <nn-drawer v-model:open="drawerOpen" :title="drawerTitle" width="560px" placement="right">
            <template v-if="selectedType === 'route' && selectedRecord">
                <nn-alert
                    class="drawer-evidence-alert"
                    :type="hasPathMarking(selectedRecord) ? 'success' : 'warning'"
                    show-icon
                    :message="hasPathMarking(selectedRecord) ? 'Path Marking：设备上报' : 'Path Marking：观测缺失'"
                    :description="
                        hasPathMarking(selectedRecord)
                            ? '状态与原因来自设备携带的 Path Marking TLV。'
                            : '当前没有设备上报的 Path Marking，阶段关联及未选中原因只能作为推测。'
                    "
                />
                <nn-descriptions :column="1" bordered size="small">
                    <nn-descriptions-item label="阶段">{{ selectedStageTitle }}</nn-descriptions-item>
                    <nn-descriptions-item label="Prefix / NLRI">
                        {{ formatPrefix(selectedRecord) }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="地址族">
                        {{ getAddressFamilyLabel(selectedRecord) }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Client">{{ getClientLabel(selectedRecord) }}</nn-descriptions-item>
                    <nn-descriptions-item label="Peer / 实例">{{ getPeerLabel(selectedRecord) }}</nn-descriptions-item>
                    <nn-descriptions-item label="VRF / RD">{{ getVrfRdLabel(selectedRecord) }}</nn-descriptions-item>
                    <nn-descriptions-item label="Next Hop">
                        {{ formatValue(getRoute(selectedRecord).nextHop) }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="AS Path">
                        {{ formatValue(getRoute(selectedRecord).asPath) }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Local Preference">
                        {{ formatValue(getRoute(selectedRecord).localPref) }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="MED">
                        {{ formatValue(getRoute(selectedRecord).med) }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Communities">
                        {{ formatValue(getRoute(selectedRecord).communities) }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Path Status">
                        {{ getPathMarkingNames(selectedRecord).join(', ') || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="Reason">
                        {{ getPathMarkingReason(selectedRecord) || '-' }}
                    </nn-descriptions-item>
                </nn-descriptions>
            </template>
            <template v-else-if="selectedRecord">
                <nn-alert
                    class="drawer-evidence-alert"
                    type="warning"
                    show-icon
                    message="属性关联说明"
                    description="属性值来自 BMP 观测；前后路径的配对可能是推测关联，不等同于设备策略执行日志。"
                />
            </template>
            <div v-if="selectedRecord" class="raw-detail">
                <div class="raw-detail-title">原始查询结果</div>
                <pre>{{ JSON.stringify(selectedRecord, null, 2) }}</pre>
            </div>
        </nn-drawer>
    </div>
</template>

<script setup>
    import ipaddr from 'ipaddr.js';
    import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
    import { EyeOutlined, RouteOutlined, SearchOutlined } from '../../ui/icons';
    import { ADDRESS_FAMILY_NAME } from '../../const/bgpConst';
    import { BMP_EVENT_PAGE_ID } from '../../const/bmpConst';
    import EventBus from '../../utils/eventBus';
    import { notify } from '../../utils/notify';

    defineOptions({ name: 'BgpRouteLens' });

    const stageDefinitions = [
        {
            key: 'preIn',
            title: 'Pre Adj-RIB-In',
            subtitle: '入站策略前',
            emptyHint: '可能未上报该 RIB，不能据此确认设备未收到。'
        },
        {
            key: 'postIn',
            title: 'Post Adj-RIB-In',
            subtitle: '入站策略后',
            emptyHint: '与 Pre-In 的缺口只能作为策略过滤线索。'
        },
        {
            key: 'locRib',
            title: 'Loc-RIB',
            subtitle: '本地选路结果',
            emptyHint: '未观测到 Loc-RIB 不等同于设备确认“未选中”。'
        },
        {
            key: 'preOut',
            title: 'Pre Adj-RIB-Out',
            subtitle: '出站策略前',
            emptyHint: '可能没有该视图或未向此 Peer 生成路由。'
        },
        {
            key: 'postOut',
            title: 'Post Adj-RIB-Out',
            subtitle: '出站策略后',
            emptyHint: '观测缺口不能单独证明出站策略已过滤。'
        }
    ];

    const emptyStages = () => ({ preIn: [], postIn: [], locRib: [], preOut: [], postOut: [] });
    const emptyResult = () => ({
        query: null,
        stages: emptyStages(),
        policyDiffs: { inbound: [], outbound: [], summary: {} },
        insights: [],
        summary: {},
        generatedAt: null
    });

    const routeQuery = ref('');
    const routeState = ref('active');
    const lastQuery = ref('');
    const hasSearched = ref(false);
    const loading = ref(false);
    const queryError = ref('');
    const lensResult = ref(emptyResult());
    const drawerOpen = ref(false);
    const drawerTitle = ref('');
    const selectedRecord = ref(null);
    const selectedType = ref('');
    const selectedStageTitle = ref('');
    const eventPageId = BMP_EVENT_PAGE_ID.PAGE_ID_BMP_ROUTE_LENS || 'bmp-route-lens';
    const liveEvents = [
        'bmp:routeUpdate',
        'bmp:instanceRouteUpdate',
        'bmp:sessionUpdate',
        'bmp:instanceUpdate',
        'bmp:initiation',
        'bmp:termination'
    ];
    let refreshTimer = null;
    let requestId = 0;
    let lastAutoErrorMessage = '';

    const normalizeResult = payload => {
        const source = payload && typeof payload === 'object' ? payload : {};
        return {
            ...emptyResult(),
            ...source,
            stages: { ...emptyStages(), ...(source.stages || {}) },
            policyDiffs: {
                inbound: [],
                outbound: [],
                summary: {},
                ...(source.policyDiffs || {})
            },
            insights: Array.isArray(source.insights) ? source.insights : [],
            summary: source.summary && typeof source.summary === 'object' ? source.summary : {}
        };
    };

    const getStageEntries = key => {
        const entries = lensResult.value?.stages?.[key];
        return Array.isArray(entries) ? entries : [];
    };

    const totalEntries = computed(() =>
        stageDefinitions.reduce((total, stage) => total + getStageEntries(stage.key).length, 0)
    );
    const hasMatches = computed(() => totalEntries.value > 0);
    const inboundDiffs = computed(() => lensResult.value?.policyDiffs?.inbound || []);
    const outboundDiffs = computed(() => lensResult.value?.policyDiffs?.outbound || []);
    const insights = computed(() => lensResult.value?.insights || []);
    const generatedAt = computed(() => {
        if (!lensResult.value?.generatedAt) return '';
        const date = new Date(lensResult.value.generatedAt);
        return Number.isNaN(date.getTime()) ? String(lensResult.value.generatedAt) : date.toLocaleString();
    });

    const getRoute = entry => entry?.route || entry || {};
    const hasPathMarking = entry => {
        const route = getRoute(entry);
        return (
            entry?.hasPathMarking === true ||
            (route.pathStatus !== null && route.pathStatus !== undefined) ||
            (Array.isArray(route.pathStatusNames) && route.pathStatusNames.length > 0) ||
            Boolean(route.pathStatusText) ||
            Boolean(route.pathStatusReasonText)
        );
    };

    const allEntries = computed(() => stageDefinitions.flatMap(stage => getStageEntries(stage.key)));
    const derivedClientCount = computed(
        () =>
            new Set(
                allEntries.value.map(entry => {
                    const client = entry.client || {};
                    return [client.localIp, client.localPort, client.remoteIp, client.remotePort].join('|');
                })
            ).size
    );
    const derivedSessionCount = computed(
        () =>
            new Set(
                allEntries.value
                    .filter(entry => entry.session)
                    .map(entry =>
                        [entry.session.sessionIp, entry.session.sessionRd, entry.session.sessionAs, entry.af].join('|')
                    )
            ).size
    );
    const derivedInstanceCount = computed(
        () =>
            new Set(
                allEntries.value
                    .filter(entry => entry.instance)
                    .map(entry =>
                        [
                            entry.instance.instanceIp,
                            entry.instance.instanceRd,
                            entry.instance.instanceType,
                            entry.af
                        ].join('|')
                    )
            ).size
    );
    const derivedReportedCount = computed(() => allEntries.value.filter(hasPathMarking).length);
    const summaryMetrics = computed(() => {
        const summary = lensResult.value?.summary || {};
        const peerAndInstanceCount =
            (summary.peerCount ?? derivedSessionCount.value) + (summary.instanceCount ?? derivedInstanceCount.value);
        return [
            { label: '命中路径', value: summary.total ?? totalEntries.value },
            { label: 'BMP Client', value: summary.clientCount ?? derivedClientCount.value },
            { label: 'Peer / 实例', value: peerAndInstanceCount },
            { label: 'Path Marking', value: summary.reportedCount ?? derivedReportedCount.value },
            { label: '推测结论', value: summary.inferredCount ?? 0 }
        ];
    });

    const isBmpUnavailableMessage = message => {
        const value = String(message || '').trim();
        return /BMP.*(?:未启动|未运行|已停止)/i.test(value) || /BMP.*not\s+(?:started|running)/i.test(value);
    };

    const unwrapResponse = response => {
        if (response && Object.prototype.hasOwnProperty.call(response, 'status')) {
            if (response.status !== 'success') {
                throw new Error(response.msg || '查询失败');
            }
            if (isBmpUnavailableMessage(response.msg)) {
                throw new Error(response.msg);
            }
            return response.data;
        }
        return response;
    };

    const notifyQueryError = (message, silent) => {
        const normalizedMessage = String(message || 'Route Lens 查询失败');
        if (!silent || normalizedMessage !== lastAutoErrorMessage) {
            notify.error(`Route Lens 查询失败：${normalizedMessage}`);
        }
        lastAutoErrorMessage = normalizedMessage;
    };

    const runQuery = async (query, silent = false) => {
        const currentRequestId = ++requestId;
        if (!silent) loading.value = true;
        try {
            if (!window.bmpApi?.getRouteLens) {
                throw new Error('当前 BMP 服务不支持 Route Lens 查询，请重启应用后重试。');
            }
            const response = await window.bmpApi.getRouteLens(query, routeState.value);
            if (currentRequestId !== requestId) return;
            lensResult.value = normalizeResult(unwrapResponse(response));
            lastQuery.value = query;
            hasSearched.value = true;
            lastAutoErrorMessage = '';
        } catch (error) {
            if (currentRequestId !== requestId) return;
            const message = error?.message || 'Route Lens 查询失败';
            notifyQueryError(message, silent);
        } finally {
            if (currentRequestId === requestId) loading.value = false;
        }
    };

    const searchRoute = () => {
        const query = String(routeQuery.value || '').trim();
        clearRefreshTimer();
        if (!query) {
            const message = '请输入 Prefix、IP 或 NLRI 标识';
            requestId += 1;
            loading.value = false;
            queryError.value = message;
            notifyQueryError(message, false);
            return;
        }
        queryError.value = '';
        routeQuery.value = query;
        runQuery(query);
    };

    const clearRefreshTimer = () => {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }
    };

    const scheduleRefresh = () => {
        if (!lastQuery.value || !hasSearched.value) return;
        clearRefreshTimer();
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            runQuery(lastQuery.value, true);
        }, 900);
    };

    const registerEvents = () => liveEvents.forEach(event => EventBus.on(event, eventPageId, scheduleRefresh));
    const unregisterEvents = () => liveEvents.forEach(event => EventBus.off(event, eventPageId));

    watch(routeState, () => {
        clearRefreshTimer();
        if (lastQuery.value && hasSearched.value) runQuery(lastQuery.value);
    });

    watch(routeQuery, value => {
        const query = String(value || '').trim();
        if (query) queryError.value = '';
    });

    onActivated(registerEvents);
    onDeactivated(() => {
        clearRefreshTimer();
        unregisterEvents();
    });
    onBeforeUnmount(() => {
        clearRefreshTimer();
        unregisterEvents();
    });

    const formatValue = value => {
        if (value === null || value === undefined || value === '') return '-';
        if (Array.isArray(value)) return value.length ? value.map(formatValue).join(', ') : '-';
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value);
            } catch (_error) {
                return String(value);
            }
        }
        return String(value);
    };

    const formatRouteIdentityValue = value => {
        if (value === null || value === undefined || value === '') return '';
        if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
        if (Array.isArray(value)) return value.map(formatRouteIdentityValue).filter(Boolean).join(' ');
        if (typeof value === 'object') {
            const preferredFields = ['displayPrefix', 'formatted', 'text', 'prefix', 'value', 'label', 'id'];
            for (const field of preferredFields) {
                const formatted = formatRouteIdentityValue(value[field]);
                if (formatted) return formatted;
            }
            try {
                return JSON.stringify(value);
            } catch (_error) {
                return '';
            }
        }
        return String(value).trim();
    };

    const firstRouteIdentity = (...values) => {
        for (const value of values) {
            const formatted = formatRouteIdentityValue(value);
            if (formatted) return formatted;
        }
        return '';
    };

    const nonIpSafis = new Set([5, 65, 70, 71, 72, 132, 133, 134]);
    const hasNonIpNlriSemantics = entry => {
        const route = getRoute(entry);
        const nlriDetail = route.nlriDetail || {};
        const afi = Number(entry?.afi ?? route.afi);
        const safi = Number(entry?.safi ?? route.safi);
        const routeType = firstRouteIdentity(route.routeType, nlriDetail.routeType, nlriDetail.type).toLowerCase();
        return (
            afi === 25 ||
            afi === 16388 ||
            nonIpSafis.has(safi) ||
            /evpn|flow.?spec|bgp.?ls|link.?state|mvpn|vpls|route.?target/.test(routeType)
        );
    };

    const appendPrefixLengthForIp = (entry, identity, ...prefixLengthCandidates) => {
        if (!identity || identity.includes('/') || hasNonIpNlriSemantics(entry) || !ipaddr.isValid(identity)) {
            return identity;
        }
        const address = ipaddr.parse(identity);
        const maxPrefixLength = address.kind() === 'ipv4' ? 32 : 128;
        const rawPrefixLength = prefixLengthCandidates.find(
            value => value !== null && value !== undefined && value !== ''
        );
        const prefixLength = Number(rawPrefixLength);
        if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > maxPrefixLength) {
            return identity;
        }
        return `${identity}/${prefixLength}`;
    };

    const formatPrefix = entry => {
        const route = getRoute(entry);
        const match = entry?.match || {};
        const nlriDetail = route.nlriDetail || {};
        const backendIdentity = firstRouteIdentity(
            match.displayPrefix,
            match.routeIdentity,
            entry?.routeIdentity,
            match.routePrefix
        );
        if (backendIdentity) return backendIdentity;

        const nlriIdentity = firstRouteIdentity(nlriDetail.prefix);
        if (nlriIdentity) {
            return appendPrefixLengthForIp(entry, nlriIdentity, nlriDetail.prefixLength, nlriDetail.length, route.mask);
        }

        const routeIdentity = firstRouteIdentity(route.ip);
        if (!routeIdentity) return '-';
        return appendPrefixLengthForIp(entry, routeIdentity, route.mask, nlriDetail.prefixLength, nlriDetail.length);
    };

    const getEntryKey = (entry, stage) => {
        const route = getRoute(entry);
        return [
            stage,
            formatPrefix(entry),
            route.rd,
            route.pathId,
            entry.session?.sessionIp,
            entry.instance?.instanceIp
        ].join('|');
    };
    const getClientLabel = entry => {
        const client = entry?.client || {};
        const name = client.sysName || client.remoteIp || client.localIp || '-';
        const ip = client.sysName && client.remoteIp ? ` · ${client.remoteIp}` : '';
        return `${name}${ip}`;
    };
    const getPeerLabel = entry =>
        entry?.session?.sessionIp ||
        entry?.session?.peerIp ||
        entry?.instance?.instanceIp ||
        entry?.instance?.instanceRouterId ||
        '-';
    const getAddressFamilyLabel = entry => {
        const route = getRoute(entry);
        const addressFamilyType = entry?.af ?? route.addrFamilyType;
        const knownName = ADDRESS_FAMILY_NAME[addressFamilyType];
        if (knownName) return knownName;
        if (typeof addressFamilyType === 'string' && addressFamilyType && !/^\d+$/.test(addressFamilyType)) {
            return addressFamilyType;
        }
        const afi = entry?.afi ?? route.afi;
        const safi = entry?.safi ?? route.safi;
        if (afi !== null && afi !== undefined && safi !== null && safi !== undefined) {
            return `AFI ${afi} / SAFI ${safi}`;
        }
        return addressFamilyType === null || addressFamilyType === undefined || addressFamilyType === ''
            ? '-'
            : String(addressFamilyType);
    };
    const getVrfRdLabel = entry => {
        const owner = entry?.session || entry?.instance || {};
        const names = Array.isArray(entry?.vrfTableNames)
            ? entry.vrfTableNames.filter(Boolean)
            : Array.isArray(owner.vrfTableNames)
              ? owner.vrfTableNames.filter(Boolean)
              : [];
        const route = getRoute(entry);
        const rd = route.rd || owner.sessionRd || owner.instanceRd;
        return [names.join(', '), rd && rd !== '0:0' ? rd : ''].filter(Boolean).join(' · ') || 'Global';
    };
    const getRouteStateText = entry => (getRoute(entry).routeState === 'stale' ? 'Stale' : 'Current');
    const getRouteStateColor = entry => (getRoute(entry).routeState === 'stale' ? 'orange' : 'green');
    const getMatchText = match => {
        const value = typeof match === 'string' ? match : match?.matchType || match?.type || match?.mode || '';
        if (/text-exact/i.test(value)) return 'NLRI 精确匹配';
        if (/text-contains/i.test(value)) return 'NLRI 文本包含';
        if (/exact/i.test(value)) return '精确匹配';
        if (/cover|longest|contain/i.test(value)) return '覆盖匹配';
        return value ? String(value) : '';
    };

    const getPathMarkingNames = entry => {
        const route = getRoute(entry);
        const unknownBits = Number(route.pathStatusUnknownBits || 0) >>> 0;
        const unknownLabel = unknownBits === 0 ? '' : `Unknown(0x${unknownBits.toString(16).padStart(8, '0')})`;
        if (Array.isArray(route.pathStatusNames) && route.pathStatusNames.length) {
            const names = [
                ...new Set(
                    route.pathStatusNames
                        .map(item => (typeof item === 'object' ? item.name || item.text : item))
                        .filter(Boolean)
                )
            ];
            if (unknownLabel && !names.includes(unknownLabel)) names.push(unknownLabel);
            return names;
        }
        if (route.pathStatusText) return [String(route.pathStatusText)];
        return unknownLabel ? [unknownLabel] : [];
    };
    const getPathMarkingReason = entry => {
        const route = getRoute(entry);
        return route.pathStatusReasonText || route.pathStatusReasonName || '';
    };
    const getPathMarkingColor = name => {
        const value = String(name).toLowerCase();
        if (value.includes('best') || value.includes('primary')) return 'green';
        if (value.includes('backup')) return 'blue';
        if (value.includes('filter') || value.includes('invalid')) return 'red';
        if (value.includes('non') || value.includes('stale') || value.includes('suppress')) return 'orange';
        return 'purple';
    };

    const getDiffChanges = diff => {
        if (Array.isArray(diff?.changes)) return diff.changes;
        if (diff?.changes && typeof diff.changes === 'object') {
            return Object.entries(diff.changes).map(([field, value]) => ({
                field,
                before: value?.before,
                after: value?.after
            }));
        }
        if (Array.isArray(diff?.changedFields)) {
            return diff.changedFields.map(field => ({
                field,
                before: diff.before?.[field],
                after: diff.after?.[field]
            }));
        }
        return [];
    };
    const getDiffTitle = (diff, direction, index) => diff?.title || `${direction} 路径 ${index + 1}`;
    const getDiffStatusText = status =>
        ({
            modified: '属性变化',
            unchanged: '属性一致',
            'missing-after': '后阶段缺失',
            missing_after: '后阶段缺失',
            'post-only': '仅后阶段',
            post_only: '仅后阶段'
        })[status] ||
        status ||
        '待核验';
    const getDiffStatusColor = status => {
        if (status === 'modified') return 'orange';
        if (status === 'unchanged') return 'green';
        if (String(status).includes('missing')) return 'red';
        return 'blue';
    };
    const attributeLabels = {
        origin: 'Origin',
        asPath: 'AS Path',
        nextHop: 'Next Hop',
        localPref: 'Local Pref',
        med: 'MED',
        communities: 'Communities',
        otc: 'OTC',
        prefixSid: 'Prefix SID',
        labels: 'Labels',
        pathStatusText: 'Path Status'
    };
    const getAttributeLabel = field => attributeLabels[field] || field;

    const normalizeEvidence = evidence => {
        const value = String(evidence || '').toLowerCase();
        if (value.includes('report') || value.includes('device')) return 'reported';
        if (value.includes('observ')) return 'observed';
        return 'inferred';
    };
    const getEvidenceClass = evidence => normalizeEvidence(evidence);
    const getEvidenceText = (evidence, linkage = false) => {
        const normalized = normalizeEvidence(evidence);
        if (normalized === 'reported') return '设备上报';
        if (normalized === 'observed') return linkage ? '观测事实 · 关联需核验' : '观测事实';
        return linkage ? '推测关联' : '推测分析';
    };
    const getInsightEvidence = insight => (typeof insight === 'object' ? insight.evidenceType || insight.evidence : '');
    const getInsightTitle = (insight, index) =>
        typeof insight === 'object' ? insight.title || `判断 ${index + 1}` : `判断 ${index + 1}`;
    const getInsightDescription = insight => {
        if (typeof insight === 'string') return insight;
        return insight?.description || insight?.message || insight?.text || '-';
    };
    const getInsightSeverity = insight => {
        const value = String(insight?.severity || 'info').toLowerCase();
        return ['success', 'warning', 'error'].includes(value) ? value : 'info';
    };

    const openEntryDetails = (entry, stage) => {
        selectedRecord.value = entry;
        selectedType.value = 'route';
        selectedStageTitle.value = stage.title;
        drawerTitle.value = `${formatPrefix(entry)} · ${stage.title}`;
        drawerOpen.value = true;
    };
    const openDiffDetails = (diff, direction) => {
        selectedRecord.value = diff;
        selectedType.value = 'diff';
        selectedStageTitle.value = '';
        drawerTitle.value = `${direction} 属性差异`;
        drawerOpen.value = true;
    };
</script>

<style scoped>
    .route-lens-page {
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .route-lens-shell {
        display: flex;
        height: 100%;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
    }

    .route-lens-shell :deep(.nn-card-body) {
        min-height: 0;
        flex: 1;
        overflow: auto;
    }

    .page-title,
    .query-controls,
    .evidence-legend,
    .legend-item,
    .route-card-topline,
    .route-attributes,
    .path-marking,
    .detail-hint,
    .section-heading,
    .diff-header,
    .insight-item {
        display: flex;
        align-items: center;
    }

    .page-title {
        gap: 7px;
    }

    .generated-at {
        font-size: 12px;
        opacity: 0.86;
    }

    .query-panel {
        display: grid;
        grid-template-columns: minmax(180px, 0.7fr) minmax(480px, 1.6fr);
        gap: 6px 20px;
        padding: 15px 16px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        background: var(--nn-color-bg-subtle);
    }

    .query-copy {
        align-self: center;
    }

    .query-title {
        color: var(--nn-color-text-strong);
        font-size: 16px;
        font-weight: 650;
    }

    .query-description,
    .section-heading p,
    .analysis-panel p,
    .insights-panel p {
        margin: 3px 0 0;
        color: var(--nn-color-text-muted);
        font-size: 12px;
        line-height: 1.5;
    }

    .query-controls {
        min-width: 0;
        gap: 8px;
        justify-content: flex-end;
    }

    .query-controls :deep(.nn-input-wrapper) {
        min-width: 260px;
        flex: 1;
    }

    .evidence-legend {
        min-height: 38px;
        gap: 14px;
        padding: 7px 4px;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    .legend-label {
        color: var(--nn-color-text-strong);
        font-weight: 600;
    }

    .legend-item {
        gap: 5px;
        white-space: nowrap;
    }

    .legend-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
    }

    .legend-dot.reported {
        background: var(--nn-color-success);
    }

    .legend-dot.observed {
        background: var(--nn-color-info);
    }

    .legend-dot.inferred {
        border: 1px dashed var(--nn-color-warning);
        background: var(--nn-color-bg-warning-subtle);
    }

    .legend-note {
        min-width: 260px;
        flex: 1;
        color: var(--nn-color-text-muted);
        text-align: right;
    }

    .result-alert {
        margin-bottom: 10px;
    }

    .route-lens-empty {
        min-height: 310px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
    }

    .route-lens-empty p {
        max-width: 520px;
        margin: -4px auto 0;
        color: var(--nn-color-text-muted);
        font-size: 12px;
        text-align: center;
    }

    .lens-result {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .summary-strip {
        display: grid;
        grid-template-columns: repeat(5, minmax(110px, 1fr));
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        background: var(--nn-color-bg-surface);
    }

    .summary-item {
        display: flex;
        min-height: 58px;
        flex-direction: column;
        justify-content: center;
        padding: 8px 14px;
        border-right: 1px solid var(--nn-color-border-light);
    }

    .summary-item:last-child {
        border-right: 0;
    }

    .summary-value {
        color: var(--nn-color-text-strong);
        font-size: 20px;
        font-weight: 700;
        line-height: 1.15;
    }

    .summary-label {
        margin-top: 3px;
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .flow-section,
    .analysis-panel,
    .insights-panel {
        padding: 12px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        background: var(--nn-color-bg-surface);
    }

    .section-heading {
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
    }

    .section-heading h2 {
        margin: 0;
        color: var(--nn-color-text-strong);
        font-size: 14px;
        font-weight: 650;
    }

    .section-heading.compact {
        padding-bottom: 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .section-heading :deep(.nn-tag),
    .route-card-topline :deep(.nn-tag),
    .path-marking :deep(.nn-tag),
    .diff-header :deep(.nn-tag) {
        margin-inline-end: 0;
    }

    .flow-viewport {
        width: 100%;
        overflow-x: auto;
        padding-bottom: 5px;
    }

    .route-flow {
        display: flex;
        width: max-content;
        min-width: 100%;
        align-items: stretch;
    }

    .route-stage {
        width: 252px;
        min-width: 252px;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        background: var(--nn-color-bg-subtle);
    }

    .stage-header {
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;
        min-height: 54px;
        padding: 8px 9px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }

    .stage-index,
    .stage-count,
    .panel-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
    }

    .stage-index {
        width: 24px;
        height: 24px;
        background: var(--nn-color-primary);
        color: var(--nn-color-text-inverse);
    }

    .stage-heading-copy {
        min-width: 0;
        display: flex;
        flex-direction: column;
    }

    .stage-heading-copy strong {
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .stage-heading-copy span {
        color: var(--nn-color-text-muted);
        font-size: 10px;
    }

    .stage-count,
    .panel-count {
        min-width: 22px;
        height: 22px;
        padding: 0 6px;
        background: var(--nn-color-bg-info-subtle);
        color: var(--nn-color-text-info);
    }

    .stage-routes {
        display: flex;
        max-height: 500px;
        min-height: 190px;
        flex-direction: column;
        gap: 8px;
        overflow-y: auto;
        padding: 8px;
    }

    .route-lens-route-card,
    .diff-card {
        width: 100%;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 7px;
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        cursor: pointer;
        font: inherit;
        text-align: left;
        transition:
            border-color 0.15s,
            box-shadow 0.15s,
            transform 0.15s;
    }

    .route-lens-route-card {
        padding: 9px;
    }

    .route-lens-route-card:hover,
    .route-lens-route-card:focus-visible,
    .diff-card:hover,
    .diff-card:focus-visible {
        border-color: var(--nn-color-primary);
        box-shadow: var(--nn-shadow-card-head-control);
        outline: none;
        transform: translateY(-1px);
    }

    .route-card-topline {
        justify-content: space-between;
        gap: 6px;
    }

    .route-prefix {
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        font-weight: 700;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .route-owner {
        margin-top: 5px;
        overflow: hidden;
        color: var(--nn-color-primary);
        font-size: 11px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .route-facts {
        display: grid;
        gap: 5px;
        margin: 8px 0 0;
    }

    .route-facts > div {
        display: grid;
        grid-template-columns: 62px minmax(0, 1fr);
        gap: 5px;
        min-width: 0;
    }

    .route-facts dt,
    .route-facts dd {
        margin: 0;
        overflow: hidden;
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .route-facts dt {
        color: var(--nn-color-text-muted);
    }

    .route-facts dd {
        color: var(--nn-color-text-secondary);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .route-attributes {
        gap: 5px;
        flex-wrap: wrap;
        margin-top: 8px;
    }

    .route-attributes span {
        padding: 2px 5px;
        border-radius: 3px;
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text-secondary);
        font-size: 10px;
    }

    .path-marking {
        gap: 4px;
        flex-wrap: wrap;
        margin-top: 8px;
        padding-top: 7px;
        border-top: 1px dashed var(--nn-color-border-light);
    }

    .path-marking p {
        width: 100%;
        margin: 1px 0 0;
        color: var(--nn-color-text-secondary);
        font-size: 10px;
        line-height: 1.4;
    }

    .missing-marking {
        color: var(--nn-color-text-muted);
        font-size: 10px;
    }

    .evidence-pill {
        display: inline-flex;
        width: fit-content;
        align-items: center;
        min-height: 20px;
        padding: 1px 6px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 999px;
        font-size: 10px;
        font-weight: 650;
        line-height: 16px;
        white-space: nowrap;
    }

    .evidence-pill.reported {
        border-color: var(--nn-color-success);
        background: var(--nn-color-bg-success-subtle);
        color: var(--nn-color-text-success);
    }

    .evidence-pill.observed {
        border-color: var(--nn-color-border-info);
        background: var(--nn-color-bg-info-subtle);
        color: var(--nn-color-text-info);
    }

    .evidence-pill.inferred,
    .evidence-pill.missing {
        border-color: var(--nn-color-warning);
        border-style: dashed;
        background: var(--nn-color-bg-warning-subtle);
        color: var(--nn-color-text-warning);
    }

    .detail-hint {
        gap: 4px;
        justify-content: flex-end;
        margin-top: 6px;
        color: var(--nn-color-text-muted);
        font-size: 10px;
    }

    .stage-empty {
        display: flex;
        min-height: 172px;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 14px;
        color: var(--nn-color-text-muted);
        text-align: center;
    }

    .stage-empty span {
        font-size: 12px;
        font-weight: 600;
    }

    .stage-empty small {
        margin-top: 6px;
        font-size: 10px;
        line-height: 1.5;
    }

    .stage-connector {
        position: relative;
        width: 48px;
        min-width: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .stage-connector span {
        position: absolute;
        top: 17px;
        color: var(--nn-color-text-warning);
        font-size: 9px;
        white-space: nowrap;
    }

    .stage-connector i {
        width: 100%;
        border-top: 1px dashed var(--nn-color-warning);
    }

    .stage-connector b {
        position: absolute;
        right: 0;
        color: var(--nn-color-warning);
        font-size: 20px;
        font-weight: 400;
    }

    .analysis-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
    }

    .diff-list {
        display: grid;
        gap: 8px;
        max-height: 390px;
        overflow-y: auto;
    }

    .diff-card {
        padding: 9px 10px;
    }

    .diff-header {
        justify-content: space-between;
        gap: 8px;
    }

    .diff-header strong {
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .diff-card > .evidence-pill {
        margin-top: 6px;
    }

    .change-list {
        display: grid;
        gap: 4px;
        margin-top: 7px;
    }

    .change-row {
        display: grid;
        grid-template-columns: 80px minmax(0, 1fr) 12px minmax(0, 1fr);
        align-items: center;
        gap: 4px;
        color: var(--nn-color-text-muted);
        font-size: 10px;
    }

    .change-row code {
        overflow: hidden;
        padding: 2px 4px;
        border-radius: 3px;
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text-secondary);
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .change-row b {
        color: var(--nn-color-warning);
        text-align: center;
    }

    .insight-list {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
    }

    .insight-item {
        align-items: flex-start;
        gap: 10px;
        padding: 9px 10px;
        border: 1px solid var(--nn-color-border-light);
        border-left: 3px solid var(--nn-color-info);
        border-radius: 6px;
        background: var(--nn-color-bg-subtle);
    }

    .insight-warning {
        border-left-color: var(--nn-color-warning);
    }

    .insight-error {
        border-left-color: var(--nn-color-error);
    }

    .insight-success {
        border-left-color: var(--nn-color-success);
    }

    .insight-item > div {
        min-width: 0;
    }

    .insight-item strong {
        color: var(--nn-color-text-strong);
        font-size: 12px;
    }

    .insight-item p {
        overflow-wrap: anywhere;
    }

    .drawer-evidence-alert {
        margin-bottom: 12px;
    }

    .raw-detail {
        margin-top: 14px;
    }

    .raw-detail-title {
        margin-bottom: 6px;
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 650;
    }

    .raw-detail pre {
        max-height: 440px;
        margin: 0;
        overflow: auto;
        padding: 10px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-subtle);
        color: var(--nn-color-text-secondary);
        font-size: 11px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
    }

    @media (max-width: 980px) {
        .query-panel {
            grid-template-columns: 1fr;
        }

        .query-controls {
            justify-content: flex-start;
            flex-wrap: wrap;
        }

        .query-controls :deep(.nn-input-wrapper) {
            flex-basis: 100%;
        }

        .legend-note {
            width: 100%;
            min-width: 0;
            text-align: left;
        }

        .evidence-legend {
            flex-wrap: wrap;
        }

        .analysis-grid,
        .insight-list {
            grid-template-columns: 1fr;
        }
    }

    @media (max-width: 640px) {
        .summary-strip {
            grid-template-columns: repeat(2, 1fr);
        }

        .summary-item {
            border-bottom: 1px solid var(--nn-color-border-light);
        }

        .section-heading {
            align-items: flex-start;
        }
    }
</style>
