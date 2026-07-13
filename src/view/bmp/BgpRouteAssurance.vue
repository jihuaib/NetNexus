<template>
    <div class="nn-container route-assurance-page" data-testid="bmp-route-assurance-page">
        <nn-card class="assurance-shell">
            <template #title>
                <span class="page-title">
                    <SafetyOutlined />
                    路由矩阵
                </span>
            </template>
            <template #extra>
                <span v-if="generatedAt" class="generated-at">更新于 {{ generatedAt }}</span>
            </template>

            <section class="filter-panel" aria-label="路由保障筛选">
                <div class="filter-control">
                    <label>Client</label>
                    <nn-select
                        v-model:value="draftFilters.client"
                        data-testid="route-assurance-client"
                        :options="clientOptions"
                        allow-clear
                        placeholder="全部 Client"
                    />
                </div>
                <div class="filter-control">
                    <label>VRF / Table</label>
                    <nn-select
                        v-model:value="draftFilters.vrf"
                        data-testid="route-assurance-vrf"
                        :options="vrfOptions"
                        allow-clear
                        placeholder="全部 VRF"
                    />
                </div>
                <div class="filter-control">
                    <label>地址族</label>
                    <nn-select
                        v-model:value="draftFilters.af"
                        data-testid="route-assurance-af"
                        :options="addressFamilyOptions"
                        allow-clear
                        placeholder="全部地址族"
                    />
                </div>
                <div class="filter-control">
                    <label>异常类型</label>
                    <nn-select
                        v-model:value="draftFilters.category"
                        data-testid="route-assurance-category"
                        :options="categoryOptions"
                        allow-clear
                        placeholder="全部异常"
                    />
                </div>
                <div class="filter-control route-state-control">
                    <label>路由状态</label>
                    <nn-radio-group v-model:value="draftFilters.routeState" size="small" aria-label="路由状态">
                        <nn-radio-button value="active">Current</nn-radio-button>
                        <nn-radio-button value="all">All</nn-radio-button>
                        <nn-radio-button value="stale">Stale</nn-radio-button>
                    </nn-radio-group>
                </div>
                <div class="filter-control query-control">
                    <label>Prefix / NLRI</label>
                    <nn-input
                        v-model:value="draftFilters.query"
                        data-testid="route-assurance-query"
                        allow-clear
                        placeholder="IP、CIDR、EVPN 或 BGP-LS NLRI"
                        @press-enter="applyFilters"
                    >
                        <template #prefix><SearchOutlined /></template>
                    </nn-input>
                </div>
                <div class="filter-actions">
                    <nn-button @click="resetFilters">重置</nn-button>
                    <nn-button
                        type="primary"
                        data-testid="route-assurance-search"
                        :loading="loading"
                        @click="applyFilters"
                    >
                        查询
                    </nn-button>
                </div>
            </section>

            <section class="funnel-section" aria-labelledby="route-assurance-funnel-title">
                <div class="section-heading">
                    <div>
                        <h2 id="route-assurance-funnel-title">全局 RIB 漏斗</h2>
                        <p>按当前筛选范围统计；阶段间缺口用于定位异常候选，不等同于设备策略执行日志。</p>
                    </div>
                    <div class="summary-chips" aria-label="统计摘要">
                        <span>
                            <b>{{ formatCount(summary.uniqueNlriCount) }}</b>
                            NLRI
                        </span>
                        <span>
                            <b>{{ formatCount(summary.issueCount) }}</b>
                            异常
                        </span>
                        <span>
                            <b>{{ formatCount(summary.clientCount) }}</b>
                            Client
                        </span>
                    </div>
                </div>

                <div class="funnel-viewport">
                    <div class="rib-funnel" data-testid="route-assurance-funnel">
                        <template v-for="(stage, index) in funnelStages" :key="stage.key">
                            <div v-if="index > 0" class="funnel-connector" :class="getTransition(stage).tone">
                                <span>{{ getTransition(stage).rate }}</span>
                                <i aria-hidden="true">›</i>
                                <small>{{ getTransition(stage).gap }}</small>
                            </div>
                            <article
                                class="funnel-stage"
                                :class="`funnel-stage-${stage.key}`"
                                :data-testid="`route-assurance-stage-${stage.key}`"
                            >
                                <span class="stage-kicker">{{ stage.shortTitle }}</span>
                                <strong>{{ formatCount(getFunnelCount(stage.key)) }}</strong>
                                <span>{{ stage.subtitle }}</span>
                            </article>
                        </template>
                    </div>
                </div>
            </section>

            <section class="matrix-section" aria-labelledby="route-assurance-matrix-title">
                <div class="section-heading matrix-heading">
                    <div>
                        <h2 id="route-assurance-matrix-title">异常矩阵</h2>
                        <p>每一行均来自当前 BMP 快照；缺失 Path Marking 时，异常原因只标记为推测。</p>
                    </div>
                    <div class="evidence-legend" aria-label="证据等级">
                        <span>
                            <i class="evidence-dot reported" />
                            设备上报
                        </span>
                        <span>
                            <i class="evidence-dot observed" />
                            观测事实
                        </span>
                        <span>
                            <i class="evidence-dot inferred" />
                            推测分析
                        </span>
                    </div>
                </div>

                <nn-table
                    class="assurance-table"
                    data-testid="route-assurance-issue-table"
                    :columns="columns"
                    :data-source="issues"
                    :loading="loading"
                    :pagination="tablePagination"
                    :row-key="getIssueKey"
                    :custom-row="getIssueRowAttributes"
                    :scroll="{ x: 1710, y: '100%' }"
                    size="small"
                >
                    <template #bodyCell="{ column, record }">
                        <template v-if="column.key === 'issue'">
                            <div class="issue-cell">
                                <div class="issue-title-line">
                                    <nn-tag :color="getSeverityColor(record.severity)">
                                        {{ getSeverityText(record.severity) }}
                                    </nn-tag>
                                    <strong :title="getIssueTitle(record)">{{ getIssueTitle(record) }}</strong>
                                </div>
                                <p v-if="record.description" :title="formatValue(record.description)">
                                    {{ formatValue(record.description) }}
                                </p>
                                <span class="category-label">
                                    {{ record.categoryLabel || getCategoryLabel(record.category) }}
                                </span>
                            </div>
                        </template>
                        <template v-else-if="column.key === 'nlri'">
                            <div class="nlri-cell">
                                <code :title="getNlriLabel(record)">{{ getNlriLabel(record) }}</code>
                                <span v-if="record.nlri?.rd">RD {{ record.nlri.rd }}</span>
                            </div>
                        </template>
                        <template v-else-if="column.key === 'client'">
                            <span class="ellipsis-cell" :title="getClientLabel(record.client)">
                                {{ getClientLabel(record.client) }}
                            </span>
                        </template>
                        <template v-else-if="column.key === 'vrf'">
                            <span class="ellipsis-cell" :title="getVrfLabel(record)">{{ getVrfLabel(record) }}</span>
                        </template>
                        <template v-else-if="column.key === 'af'">
                            {{ getAddressFamilyLabel(record) }}
                        </template>
                        <template v-else-if="stageKeys.has(column.key)">
                            <span
                                class="stage-presence"
                                :class="getStagePresence(record, column.key).tone"
                                :title="getStagePresence(record, column.key).title"
                            >
                                <i />
                                {{ getStagePresence(record, column.key).text }}
                            </span>
                        </template>
                        <template v-else-if="column.key === 'evidence'">
                            <div class="evidence-cell">
                                <span class="evidence-pill" :class="getEvidence(record).tone">
                                    {{ getEvidence(record).label }}
                                </span>
                                <small v-if="getConfidenceLabel(record.confidence)">
                                    {{ getConfidenceLabel(record.confidence) }}
                                </small>
                            </div>
                        </template>
                        <template v-else-if="column.key === 'action'">
                            <nn-button
                                type="link"
                                size="small"
                                data-testid="route-assurance-open-lens"
                                @click="openRouteLens(record)"
                            >
                                追踪
                                <RouteOutlined />
                            </nn-button>
                        </template>
                    </template>
                    <template #emptyText>
                        <nn-empty
                            :description="
                                hasLoaded
                                    ? '当前筛选范围未发现路由保障异常'
                                    : loading
                                      ? '正在加载路由保障数据'
                                      : '暂无路由保障数据'
                            "
                        />
                    </template>
                </nn-table>
            </section>
        </nn-card>
    </div>
</template>

<script setup>
    import { computed, onActivated, onBeforeUnmount, onDeactivated, reactive, ref } from 'vue';
    import { useRouter } from 'vue-router';
    import { ADDRESS_FAMILY_NAME } from '../../const/bgpConst';
    import { BMP_EVENT_PAGE_ID } from '../../const/bmpConst';
    import { RouteOutlined, SafetyOutlined, SearchOutlined } from '../../ui/icons';
    import EventBus from '../../utils/eventBus';
    import { notify } from '../../utils/notify';

    defineOptions({ name: 'BgpRouteAssurance' });

    const router = useRouter();
    const funnelStages = [
        { key: 'preIn', shortTitle: 'Pre-In', subtitle: '入站策略前' },
        { key: 'postIn', shortTitle: 'Post-In', subtitle: '入站策略后' },
        { key: 'locRib', shortTitle: 'Loc-RIB', subtitle: '本地选路' },
        { key: 'preOut', shortTitle: 'Pre-Out', subtitle: '出站策略前' },
        { key: 'postOut', shortTitle: 'Post-Out', subtitle: '出站策略后' }
    ];
    const stageKeys = new Set(funnelStages.map(stage => stage.key));
    const categoryLabels = {
        'inbound-gap': '入站策略后缺失',
        'not-selected': '收到但未选中',
        'not-exported': '已选中但未生成出口',
        'outbound-gap': '出站策略后缺失',
        'multi-egress-inconsistent': '多出口属性不一致'
    };
    const columns = [
        { title: '异常', key: 'issue', width: 250, fixed: 'left' },
        { title: 'Prefix / NLRI', key: 'nlri', width: 235, fixed: 'left' },
        { title: 'Client', key: 'client', width: 150 },
        { title: 'VRF / Table', key: 'vrf', width: 150 },
        { title: '地址族', key: 'af', width: 125 },
        { title: 'Pre-In', key: 'preIn', width: 100, align: 'center' },
        { title: 'Post-In', key: 'postIn', width: 100, align: 'center' },
        { title: 'Loc-RIB', key: 'locRib', width: 100, align: 'center' },
        { title: 'Pre-Out', key: 'preOut', width: 100, align: 'center' },
        { title: 'Post-Out', key: 'postOut', width: 100, align: 'center' },
        { title: '证据等级', key: 'evidence', width: 120, align: 'center' },
        { title: '操作', key: 'action', width: 80, fixed: 'right', align: 'center' }
    ];
    const emptyResult = () => ({
        filters: {},
        funnel: {},
        summary: {},
        facets: {},
        issues: [],
        pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
        generatedAt: null
    });
    const createDefaultFilters = () => ({
        client: undefined,
        vrf: undefined,
        af: undefined,
        category: undefined,
        query: '',
        routeState: 'active'
    });

    const draftFilters = reactive(createDefaultFilters());
    const appliedFilters = ref(createDefaultFilters());
    const assuranceResult = ref(emptyResult());
    const loading = ref(false);
    const hasLoaded = ref(false);
    const eventPageId = BMP_EVENT_PAGE_ID.PAGE_ID_BMP_ROUTE_ASSURANCE || 'bmp-route-assurance';
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
    let lastAutoError = '';

    const normalizeResult = payload => {
        const source = payload && typeof payload === 'object' ? payload : {};
        const sourcePagination = source.pagination && typeof source.pagination === 'object' ? source.pagination : {};
        const sourceIssues = Array.isArray(source.issues)
            ? source.issues
            : Array.isArray(source.anomalies)
              ? source.anomalies
              : [];
        return {
            ...emptyResult(),
            ...source,
            filters: source.filters && typeof source.filters === 'object' ? source.filters : {},
            funnel: source.funnel && typeof source.funnel === 'object' ? source.funnel : {},
            summary: source.summary && typeof source.summary === 'object' ? source.summary : {},
            facets: source.facets && typeof source.facets === 'object' ? source.facets : {},
            issues: sourceIssues,
            pagination: {
                page: Number(sourcePagination.page) || 1,
                pageSize: Number(sourcePagination.pageSize) || 25,
                total: Number(sourcePagination.total ?? sourceIssues.length) || 0,
                totalPages: Number(sourcePagination.totalPages) || 0
            }
        };
    };

    const unwrapResponse = response => {
        if (response && Object.prototype.hasOwnProperty.call(response, 'status')) {
            if (response.status !== 'success') throw new Error(response.msg || '查询失败');
            return response.data;
        }
        return response;
    };

    const buildRequest = (page, pageSize) => ({
        client: appliedFilters.value.client,
        vrf: appliedFilters.value.vrf,
        af: appliedFilters.value.af,
        query: String(appliedFilters.value.query || '').trim(),
        category: appliedFilters.value.category,
        routeState: appliedFilters.value.routeState || 'active',
        page,
        pageSize
    });

    const showQueryError = (message, silent) => {
        const normalized = String(message || 'Route Assurance 查询失败');
        if (!silent || normalized !== lastAutoError) notify.error(`Route Assurance 查询失败：${normalized}`);
        lastAutoError = normalized;
    };

    const loadAssurance = async ({ page = 1, pageSize = 25, silent = false } = {}) => {
        const currentRequestId = ++requestId;
        if (!silent) loading.value = true;
        try {
            if (!window.bmpApi?.getRouteAssurance) {
                throw new Error('当前 BMP 服务不支持 Route Assurance，请重启应用后重试。');
            }
            const response = await window.bmpApi.getRouteAssurance(buildRequest(page, pageSize));
            if (currentRequestId !== requestId) return;
            assuranceResult.value = normalizeResult(unwrapResponse(response));
            hasLoaded.value = true;
            lastAutoError = '';
        } catch (error) {
            if (currentRequestId !== requestId) return;
            showQueryError(error?.message, silent);
        } finally {
            if (currentRequestId === requestId) loading.value = false;
        }
    };

    const applyFilters = () => {
        clearRefreshTimer();
        appliedFilters.value = {
            client: draftFilters.client,
            vrf: draftFilters.vrf,
            af: draftFilters.af,
            category: draftFilters.category,
            query: String(draftFilters.query || '').trim(),
            routeState: draftFilters.routeState || 'active'
        };
        draftFilters.query = appliedFilters.value.query;
        loadAssurance({ page: 1, pageSize: assuranceResult.value.pagination.pageSize || 25 });
    };

    const resetFilters = () => {
        Object.assign(draftFilters, createDefaultFilters());
        applyFilters();
    };

    const clearRefreshTimer = () => {
        if (!refreshTimer) return;
        clearTimeout(refreshTimer);
        refreshTimer = null;
    };

    const scheduleRefresh = () => {
        clearRefreshTimer();
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            loadAssurance({
                page: assuranceResult.value.pagination.page || 1,
                pageSize: assuranceResult.value.pagination.pageSize || 25,
                silent: true
            });
        }, 900);
    };

    const registerEvents = () => liveEvents.forEach(event => EventBus.on(event, eventPageId, scheduleRefresh));
    const unregisterEvents = () => liveEvents.forEach(event => EventBus.off(event, eventPageId));

    const issues = computed(() => assuranceResult.value.issues || []);
    const summary = computed(() => assuranceResult.value.summary || {});
    const generatedAt = computed(() => {
        const value = assuranceResult.value.generatedAt;
        if (!value) return '';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    });
    const tablePagination = computed(() => ({
        current: assuranceResult.value.pagination.page || 1,
        pageSize: assuranceResult.value.pagination.pageSize || 25,
        total: assuranceResult.value.pagination.total || 0,
        showSizeChanger: true,
        showQuickJumper: true,
        pageSizeOptions: ['25', '50', '100'],
        position: ['bottomCenter'],
        showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条，共 ${total} 条异常`,
        onChange: (page, pageSize) => loadAssurance({ page, pageSize })
    }));

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
    const formatCount = value => {
        const number = Number(value);
        return Number.isFinite(number) ? number.toLocaleString() : '-';
    };
    const getFunnelRaw = key =>
        assuranceResult.value.funnel?.[key] ?? assuranceResult.value.summary?.stageCounts?.[key];
    const getFunnelCount = key => {
        const raw = getFunnelRaw(key);
        if (raw && typeof raw === 'object') return raw.count ?? raw.total ?? raw.value;
        return raw;
    };
    const formatRate = value => {
        if (value === null || value === undefined || value === '') return '';
        const number = Number(value);
        if (!Number.isFinite(number)) return '';
        const normalized = number > 0 && number <= 1 ? number * 100 : number;
        return `${normalized.toFixed(normalized < 10 ? 1 : 0)}%`;
    };
    const getTransition = stage => {
        const index = funnelStages.findIndex(item => item.key === stage.key);
        if (index <= 0) return { rate: '', gap: '', tone: '' };
        const previous = Number(getFunnelCount(funnelStages[index - 1].key));
        const current = Number(getFunnelCount(stage.key));
        const raw = getFunnelRaw(stage.key);
        const suppliedRate = raw && typeof raw === 'object' ? (raw.conversionRate ?? raw.conversion ?? raw.rate) : null;
        const suppliedGap = raw && typeof raw === 'object' ? raw.gap : null;
        if (!Number.isFinite(previous) || !Number.isFinite(current)) {
            return { rate: formatRate(suppliedRate) || '--', gap: '缺口 --', tone: 'unknown' };
        }
        const difference =
            suppliedGap !== null && suppliedGap !== undefined && Number.isFinite(Number(suppliedGap))
                ? Number(suppliedGap)
                : previous - current;
        const rate = formatRate(suppliedRate) || (previous > 0 ? formatRate((current / previous) * 100) : '--');
        if (difference > 0) return { rate, gap: `缺口 ${formatCount(difference)}`, tone: 'loss' };
        if (difference < 0) return { rate, gap: `展开 +${formatCount(Math.abs(difference))}`, tone: 'expansion' };
        return { rate, gap: '无缺口', tone: 'steady' };
    };

    const normalizeFacetOptions = (items, type) => {
        if (!Array.isArray(items)) return [];
        const options = [];
        const seen = new Set();
        items.forEach(item => {
            const source = item && typeof item === 'object' ? item : { value: item, label: item };
            const value =
                source.value ??
                source.key ??
                source.id ??
                source.clientKey ??
                source.af ??
                source.category ??
                source.name;
            if (value === null || value === undefined || value === '' || seen.has(String(value))) return;
            let label = source.label ?? source.text ?? source.name;
            if (type === 'client' && !label) label = getClientLabel(source);
            if (type === 'af' && !label) label = ADDRESS_FAMILY_NAME[value] || value;
            if (type === 'category' && !label) label = getCategoryLabel(value);
            const count = Number(source.count);
            options.push({
                value,
                label: `${formatValue(label ?? value)}${Number.isFinite(count) ? ` (${count})` : ''}`
            });
            seen.add(String(value));
        });
        return options;
    };
    const facets = computed(() => assuranceResult.value.facets || {});
    const clientOptions = computed(() => normalizeFacetOptions(facets.value.clients, 'client'));
    const vrfOptions = computed(() => normalizeFacetOptions(facets.value.vrfs, 'vrf'));
    const addressFamilyOptions = computed(() =>
        normalizeFacetOptions(facets.value.addressFamilies || facets.value.afs, 'af')
    );
    const categoryOptions = computed(() => normalizeFacetOptions(facets.value.categories, 'category'));

    const getCategoryLabel = category => categoryLabels[category] || formatValue(category);
    const getSeverityText = severity => {
        const value = String(severity || '').toLowerCase();
        return (
            {
                critical: '严重',
                error: '严重',
                high: '高',
                warning: '警告',
                medium: '中',
                info: '提示',
                low: '低'
            }[value] || formatValue(severity)
        );
    };
    const getSeverityColor = severity => {
        const value = String(severity || '').toLowerCase();
        if (['critical', 'error', 'high'].includes(value)) return 'red';
        if (['warning', 'medium'].includes(value)) return 'orange';
        if (value === 'low') return 'blue';
        return 'default';
    };
    const getIssueTitle = record => record.title || getCategoryLabel(record.category);
    const getNlriLabel = record =>
        record.nlri?.displayPrefix ||
        record.nlri?.prefix ||
        record.nlri?.key ||
        record.routeLensQuery?.q ||
        record.routeLensQuery?.query ||
        (typeof record.routeLensQuery === 'string' ? record.routeLensQuery : '') ||
        '-';
    const getClientLabel = client => {
        if (!client) return '-';
        if (typeof client !== 'object') return formatValue(client);
        const name = client.sysName || client.name || client.remoteIp || client.localIp || client.key;
        const remoteIp = client.remoteIp && client.remoteIp !== name ? client.remoteIp : '';
        return [name, remoteIp].filter(Boolean).join(' · ') || '-';
    };
    const getVrfLabel = record => {
        const names = Array.isArray(record.vrfTableNames)
            ? record.vrfTableNames.filter(Boolean)
            : record.vrfTableNames
              ? [record.vrfTableNames]
              : record.vrf
                ? [record.vrf]
                : [];
        const rd = record.nlri?.rd;
        return [names.join(', '), rd && !names.includes(rd) ? rd : ''].filter(Boolean).join(' · ') || 'Global';
    };
    const getAddressFamilyLabel = record => {
        const value = record.nlri?.af ?? record.af;
        if (ADDRESS_FAMILY_NAME[value]) return ADDRESS_FAMILY_NAME[value];
        if (record.nlri?.afLabel) return record.nlri.afLabel;
        if (value !== null && value !== undefined && value !== '') return String(value);
        const afi = record.nlri?.afi;
        const safi = record.nlri?.safi;
        return afi !== undefined && safi !== undefined ? `AFI ${afi} / SAFI ${safi}` : '-';
    };

    const getStagePresence = (record, key) => {
        const raw = record.stagePresence?.[key] ?? record.stages?.[key];
        if (raw === null || raw === undefined) return { text: '-', title: '未提供阶段证据', tone: 'unknown' };
        if (typeof raw === 'boolean') {
            return raw
                ? { text: '已观测', title: 'BMP 快照中观测到该阶段路由', tone: 'present' }
                : { text: '未观测', title: 'BMP 快照中未观测到该阶段路由', tone: 'missing' };
        }
        if (typeof raw === 'number') {
            return {
                text: formatCount(raw),
                title: raw > 0 ? `观测到 ${formatCount(raw)} 条阶段路径` : 'BMP 快照中未观测到该阶段路由',
                tone: raw > 0 ? 'present' : 'missing'
            };
        }
        if (typeof raw === 'string') {
            const value = raw.toLowerCase();
            if (['present', 'observed', 'yes', 'true'].includes(value)) {
                return { text: '已观测', title: raw, tone: 'present' };
            }
            if (['missing', 'absent', 'no', 'false'].includes(value)) {
                return { text: '未观测', title: raw, tone: 'missing' };
            }
            return { text: raw, title: raw, tone: value.includes('partial') ? 'partial' : 'unknown' };
        }
        const count = raw.count ?? raw.total ?? raw.value;
        const present = raw.present ?? raw.observed;
        const status = String(raw.status || '').toLowerCase();
        const tone =
            present === true || Number(count) > 0 || ['present', 'observed'].includes(status)
                ? 'present'
                : present === false || Number(count) === 0 || ['missing', 'absent'].includes(status)
                  ? 'missing'
                  : status.includes('partial')
                    ? 'partial'
                    : 'unknown';
        const text = count !== undefined ? formatCount(count) : raw.label || raw.text || status || '-';
        return { text, title: raw.description || raw.title || text, tone };
    };

    const getEvidence = record => {
        const value = String(record.evidenceType || record.evidence || '').toLowerCase();
        if (value.includes('report') || value.includes('device')) return { tone: 'reported', label: '设备上报' };
        if (value.includes('observ')) return { tone: 'observed', label: '观测事实' };
        if (value.includes('infer') || value.includes('estimate')) return { tone: 'inferred', label: '推测分析' };
        return { tone: 'unknown', label: '未标注' };
    };
    const getConfidenceLabel = confidence => {
        if (confidence === null || confidence === undefined || confidence === '') return '';
        const number = Number(confidence);
        if (Number.isFinite(number)) {
            const percent = number >= 0 && number <= 1 ? number * 100 : number;
            return percent >= 0 && percent <= 100 ? `置信度 ${percent.toFixed(0)}%` : `置信度 ${confidence}`;
        }
        const value = String(confidence).toLowerCase();
        return `置信度 ${{ high: '高', medium: '中', low: '低' }[value] || confidence}`;
    };
    const getIssueKey = (record, index) =>
        record.id ||
        [record.category, record.nlri?.key || getNlriLabel(record), getClientLabel(record.client), index].join('|');
    const getIssueRowAttributes = () => ({ 'data-testid': 'route-assurance-issue-row' });

    const openRouteLens = record => {
        const routeLensQuery = record.routeLensQuery;
        const q =
            (routeLensQuery && typeof routeLensQuery === 'object' ? routeLensQuery.q || routeLensQuery.query : null) ||
            (typeof routeLensQuery === 'string' ? routeLensQuery : null) ||
            record.nlri?.displayPrefix ||
            record.nlri?.key;
        if (!q) {
            notify.error('该异常未提供可追踪的 Prefix / NLRI 标识');
            return;
        }
        const rawState =
            (routeLensQuery && typeof routeLensQuery === 'object' ? routeLensQuery.state : null) ||
            appliedFilters.value.routeState ||
            'active';
        const state = ['active', 'all', 'stale'].includes(rawState) ? rawState : 'active';
        router.push({ name: 'BgpRouteLens', query: { q: String(q), state } });
    };

    onActivated(() => {
        registerEvents();
        if (!hasLoaded.value) loadAssurance();
    });
    onDeactivated(() => {
        clearRefreshTimer();
        unregisterEvents();
    });
    onBeforeUnmount(() => {
        clearRefreshTimer();
        unregisterEvents();
    });
</script>

<style scoped>
    .route-assurance-page {
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .assurance-shell {
        display: flex;
        height: 100%;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
    }

    .assurance-shell :deep(.nn-card-body) {
        display: flex;
        flex: 1;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
    }

    .page-title,
    .section-heading,
    .summary-chips,
    .evidence-legend,
    .evidence-legend span,
    .issue-title-line,
    .stage-presence,
    .evidence-cell,
    .evidence-pill {
        display: flex;
        align-items: center;
    }

    .page-title {
        gap: 7px;
    }

    .generated-at {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 2px 9px;
        border: 1px solid var(--nn-color-border-card-head-ghost);
        border-radius: 999px;
        background: var(--nn-color-bg-card-head-ghost);
        color: var(--nn-color-text-card-head-ghost);
        font-size: 12px;
        white-space: nowrap;
    }

    .filter-panel {
        display: grid;
        flex: 0 0 auto;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 10px;
        padding: 12px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        background: var(--nn-color-bg-subtle);
    }

    .filter-control {
        min-width: 0;
        grid-column: span 2;
    }

    .filter-control > label {
        display: block;
        margin-bottom: 5px;
        color: var(--nn-color-text-secondary);
        font-size: 11px;
        font-weight: 600;
    }

    .filter-control :deep(.nn-select),
    .filter-control :deep(.nn-input-wrapper) {
        width: 100%;
    }

    .route-state-control {
        grid-column: span 3;
    }

    .query-control {
        grid-column: span 3;
    }

    .filter-actions {
        display: flex;
        grid-column: span 2;
        align-items: flex-end;
        justify-content: flex-end;
        gap: 8px;
    }

    .funnel-section,
    .matrix-section {
        margin-top: 12px;
        padding: 12px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        background: var(--nn-color-bg-surface);
    }

    .funnel-section {
        flex: 0 0 auto;
    }

    .matrix-section {
        display: flex;
        min-height: 0;
        flex: 1 1 0;
        flex-direction: column;
        overflow: hidden;
    }

    .section-heading {
        justify-content: space-between;
        gap: 14px;
        margin-bottom: 10px;
    }

    .section-heading h2 {
        margin: 0;
        color: var(--nn-color-text-strong);
        font-size: 14px;
        font-weight: 650;
    }

    .section-heading p {
        margin: 3px 0 0;
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .summary-chips {
        gap: 7px;
        flex-wrap: wrap;
        justify-content: flex-end;
    }

    .summary-chips span {
        padding: 4px 8px;
        border-radius: 999px;
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text-secondary);
        font-size: 10px;
        white-space: nowrap;
    }

    .summary-chips b {
        margin-right: 3px;
        color: var(--nn-color-text-strong);
        font-size: 12px;
    }

    .funnel-viewport {
        overflow-x: auto;
        padding-bottom: 2px;
    }

    .rib-funnel {
        display: flex;
        width: 100%;
        min-width: 850px;
        align-items: stretch;
    }

    .funnel-stage {
        display: flex;
        min-width: 126px;
        flex: 1;
        flex-direction: column;
        justify-content: center;
        padding: 9px 12px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 7px;
        background: var(--nn-color-bg-subtle);
    }

    .funnel-stage .stage-kicker {
        color: var(--nn-color-primary);
        font-size: 11px;
        font-weight: 700;
    }

    .funnel-stage strong {
        margin: 2px 0;
        color: var(--nn-color-text-strong);
        font-size: 22px;
        line-height: 1.1;
    }

    .funnel-stage > span:last-child {
        color: var(--nn-color-text-muted);
        font-size: 10px;
    }

    .funnel-connector {
        position: relative;
        width: 60px;
        min-width: 60px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: var(--nn-color-text-muted);
    }

    .funnel-connector span {
        font-size: 11px;
        font-weight: 700;
    }

    .funnel-connector i {
        margin: -2px 0;
        font-size: 20px;
        font-style: normal;
    }

    .funnel-connector small {
        font-size: 9px;
        white-space: nowrap;
    }

    .funnel-connector.loss {
        color: var(--nn-color-text-warning);
    }

    .funnel-connector.expansion {
        color: var(--nn-color-text-info);
    }

    .funnel-connector.steady {
        color: var(--nn-color-text-success);
    }

    .matrix-heading {
        flex: 0 0 auto;
        padding-bottom: 9px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .evidence-legend {
        gap: 12px;
        color: var(--nn-color-text-secondary);
        font-size: 10px;
    }

    .evidence-legend span {
        gap: 4px;
        white-space: nowrap;
    }

    .evidence-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
    }

    .evidence-dot.reported {
        background: var(--nn-color-success);
    }

    .evidence-dot.observed {
        background: var(--nn-color-info);
    }

    .evidence-dot.inferred {
        border: 1px dashed var(--nn-color-warning);
        background: var(--nn-color-bg-warning-subtle);
    }

    .assurance-table :deep(.nn-table-cell) {
        vertical-align: middle;
    }

    .assurance-table,
    .assurance-table :deep(.nn-spin-nested-loading),
    .assurance-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        width: 100%;
        height: 100%;
        min-height: 0;
        min-width: 0;
    }

    .assurance-table :deep(.nn-spin-container),
    .assurance-table :deep(.nn-table),
    .assurance-table :deep(.nn-table-container) {
        display: flex;
        min-height: 0;
        flex-direction: column;
    }

    .assurance-table :deep(.nn-table) {
        flex: 1 1 0;
        overflow: hidden;
    }

    .assurance-table :deep(.nn-table-container),
    .assurance-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
        min-width: 0;
    }

    .assurance-table :deep(.nn-table-container) {
        overflow: hidden;
    }

    .assurance-table :deep(.nn-table-content) {
        height: auto !important;
        max-height: none !important;
        overflow: auto !important;
    }

    .assurance-table :deep(.nn-pagination) {
        flex: 0 0 auto;
        min-height: 30px;
        margin: 10px 0 0;
    }

    .assurance-table :deep(.nn-table-thead > tr > th) {
        position: sticky;
        top: 0;
        z-index: 1;
    }

    .issue-cell,
    .nlri-cell,
    .evidence-cell {
        min-width: 0;
        display: flex;
        flex-direction: column;
    }

    .issue-title-line {
        min-width: 0;
        gap: 5px;
    }

    .issue-title-line :deep(.nn-tag) {
        flex: none;
        margin-inline-end: 0;
    }

    .issue-title-line strong,
    .issue-cell p,
    .nlri-cell code,
    .ellipsis-cell {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .issue-title-line strong {
        color: var(--nn-color-text-strong);
        font-size: 11px;
    }

    .issue-cell p {
        margin: 4px 0 0;
        color: var(--nn-color-text-secondary);
        font-size: 10px;
    }

    .category-label {
        margin-top: 3px;
        color: var(--nn-color-text-muted);
        font-size: 9px;
    }

    .nlri-cell code {
        color: var(--nn-color-text-strong);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
    }

    .nlri-cell span {
        margin-top: 3px;
        color: var(--nn-color-text-muted);
        font-size: 9px;
    }

    .ellipsis-cell {
        display: block;
    }

    .stage-presence {
        width: fit-content;
        min-width: 58px;
        justify-content: center;
        gap: 4px;
        margin: 0 auto;
        color: var(--nn-color-text-secondary);
        font-size: 10px;
        white-space: nowrap;
    }

    .stage-presence i {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--nn-color-text-muted);
    }

    .stage-presence.present i {
        background: var(--nn-color-success);
    }

    .stage-presence.missing i {
        background: var(--nn-color-error);
    }

    .stage-presence.partial i {
        background: var(--nn-color-warning);
    }

    .evidence-cell {
        align-items: center;
        gap: 3px;
    }

    .evidence-pill {
        width: fit-content;
        min-height: 20px;
        justify-content: center;
        padding: 1px 6px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 999px;
        font-size: 9px;
        font-weight: 650;
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

    .evidence-pill.inferred {
        border-color: var(--nn-color-warning);
        border-style: dashed;
        background: var(--nn-color-bg-warning-subtle);
        color: var(--nn-color-text-warning);
    }

    .evidence-cell small {
        color: var(--nn-color-text-muted);
        font-size: 8px;
    }

    @media (max-width: 1250px) {
        .filter-control {
            grid-column: span 3;
        }

        .route-state-control,
        .query-control {
            grid-column: span 4;
        }

        .filter-actions {
            grid-column: span 4;
        }
    }

    @media (max-width: 850px) {
        .filter-control,
        .route-state-control,
        .query-control {
            grid-column: span 6;
        }

        .filter-actions {
            grid-column: span 12;
        }

        .section-heading {
            align-items: flex-start;
            flex-direction: column;
        }

        .summary-chips,
        .evidence-legend {
            justify-content: flex-start;
        }
    }
</style>
