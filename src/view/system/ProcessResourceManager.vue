<template>
    <div class="process-resource-manager-page" data-testid="process-resource-manager-page">
        <nn-card class="resource-overview-card">
            <div class="resource-toolbar">
                <div class="resource-heading">
                    <h1 class="resource-title">进程资源管理器</h1>
                    <div class="resource-subtitle">
                        {{ runtimeText }}
                    </div>
                </div>
                <nn-space class="resource-actions">
                    <span class="auto-refresh-label">自动刷新</span>
                    <nn-switch
                        v-model:checked="autoRefresh"
                        aria-label="自动刷新"
                        data-testid="process-resource-auto-refresh"
                    />
                    <nn-select
                        v-model:value="refreshInterval"
                        :disabled="!autoRefresh"
                        aria-label="刷新间隔"
                        class="refresh-interval-select"
                    >
                        <nn-select-option :value="1000">1 秒</nn-select-option>
                        <nn-select-option :value="2000">2 秒</nn-select-option>
                        <nn-select-option :value="5000">5 秒</nn-select-option>
                        <nn-select-option :value="10000">10 秒</nn-select-option>
                    </nn-select>
                    <nn-button
                        :loading="manualRefreshing"
                        data-testid="process-resource-refresh"
                        @click="refreshSnapshot({ manual: true })"
                    >
                        <template #icon><ReloadOutlined /></template>
                        刷新
                    </nn-button>
                </nn-space>
            </div>

            <nn-alert
                v-if="loadError"
                type="error"
                show-icon
                message="资源指标刷新失败"
                :description="loadError"
                class="resource-error"
            />

            <div class="resource-summary">
                <div class="summary-tile" data-testid="process-resource-process-count">
                    <span class="summary-label">Electron 进程</span>
                    <strong class="summary-value">{{ snapshot.summary.processCount }}</strong>
                    <span class="summary-detail">主进程、渲染、GPU 与辅助进程</span>
                </div>
                <div class="summary-tile" data-testid="process-resource-total-cpu">
                    <span class="summary-label">CPU 合计</span>
                    <strong class="summary-value">{{ totalCpuText }}</strong>
                    <span class="summary-detail">多核场景下可能超过 100%</span>
                </div>
                <div class="summary-tile" data-testid="process-resource-total-memory">
                    <span class="summary-label">工作集合计</span>
                    <strong class="summary-value">{{ formatBytes(snapshot.summary.totalWorkingSetBytes) }}</strong>
                    <span class="summary-detail">
                        峰值 {{ formatBytes(snapshot.summary.totalPeakWorkingSetBytes) }}
                    </span>
                </div>
                <div class="summary-tile" data-testid="process-resource-system-memory">
                    <span class="summary-label">系统内存</span>
                    <strong class="summary-value">{{ formatPercent(snapshot.systemMemory.usagePercent) }}</strong>
                    <span class="summary-detail">
                        {{ formatBytes(snapshot.systemMemory.usedBytes) }} /
                        {{ formatBytes(snapshot.systemMemory.totalBytes) }}
                    </span>
                </div>
            </div>

            <div class="sample-meta">
                <span>{{ sampleStatusText }}</span>
                <span v-if="snapshot.app.pid">主进程 PID {{ snapshot.app.pid }}</span>
            </div>
        </nn-card>

        <nn-card class="process-list-card">
            <template #title>
                <div class="process-list-title">
                    <h2>进程列表</h2>
                    <nn-tag color="blue">{{ filteredProcesses.length }} 项</nn-tag>
                </div>
            </template>
            <template #extra>
                <nn-space>
                    <nn-select
                        v-model:value="typeFilter"
                        allow-clear
                        placeholder="全部类型"
                        aria-label="进程类型筛选"
                        class="type-filter"
                    >
                        <nn-select-option v-for="option in typeOptions" :key="option.value" :value="option.value">
                            {{ option.label }}
                        </nn-select-option>
                    </nn-select>
                    <nn-input-search
                        v-model:value="searchText"
                        allow-clear
                        placeholder="搜索名称、服务或 PID"
                        aria-label="搜索进程"
                        class="process-search"
                    />
                </nn-space>
            </template>

            <nn-table
                :columns="columns"
                :data-source="filteredProcesses"
                :loading="initialLoading"
                :pagination="false"
                :scroll="{ x: tableMinimumWidth, y: '100%' }"
                row-key="key"
                size="small"
                class="process-resource-table"
                data-testid="process-resource-table"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'process'">
                        <div class="process-name-cell">
                            <strong :title="record.displayName">{{ record.displayName }}</strong>
                            <span v-if="record.serviceName && record.serviceName !== record.displayName">
                                {{ record.serviceName }}
                            </span>
                        </div>
                    </template>
                    <template v-else-if="column.key === 'type'">
                        <nn-tag :color="processTypeColor(record.type)">{{ record.typeLabel }}</nn-tag>
                    </template>
                    <template v-else-if="column.key === 'pid'">
                        <span class="numeric-value">{{ record.pid || '-' }}</span>
                    </template>
                    <template v-else-if="column.key === 'cpu'">
                        <div class="usage-cell">
                            <span class="numeric-value">{{ processCpuText(record) }}</span>
                            <span class="usage-track" aria-hidden="true">
                                <span class="usage-bar cpu-bar" :style="{ width: usageBarWidth(record.cpuPercent) }" />
                            </span>
                        </div>
                    </template>
                    <template v-else-if="column.key === 'workingSet'">
                        <span class="numeric-value">{{ formatBytes(record.workingSetBytes) }}</span>
                    </template>
                    <template v-else-if="column.key === 'peakWorkingSet'">
                        <span class="numeric-value">{{ formatBytes(record.peakWorkingSetBytes) }}</span>
                    </template>
                    <template v-else-if="column.key === 'privateMemory'">
                        <span class="numeric-value">{{ formatOptionalBytes(record.privateBytes) }}</span>
                    </template>
                    <template v-else-if="column.key === 'wakeups'">
                        <span class="numeric-value">{{ formatWakeups(record.idleWakeupsPerSecond) }}</span>
                    </template>
                    <template v-else-if="column.key === 'createdAt'">
                        {{ formatTimestamp(record.creationTime) }}
                    </template>
                </template>
            </nn-table>
        </nn-card>

        <div class="resource-footnote">
            工作集合计包含进程间共享页，因此是近似值；BGP、BMP 等 worker_threads 的消耗会计入主进程。
        </div>
    </div>
</template>

<script setup>
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
    import { ReloadOutlined } from 'netnexus-ui/icons';

    defineOptions({ name: 'ProcessResourceManager' });

    const EMPTY_SNAPSHOT = Object.freeze({
        sampledAt: 0,
        warmingUp: true,
        app: Object.freeze({ name: 'NetNexus', version: '', pid: 0 }),
        runtime: Object.freeze({ platform: '', arch: '', electronVersion: '' }),
        summary: Object.freeze({
            processCount: 0,
            totalCpuPercent: 0,
            totalWorkingSetBytes: 0,
            totalPeakWorkingSetBytes: 0
        }),
        systemMemory: Object.freeze({ totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePercent: 0 }),
        processes: Object.freeze([])
    });
    const PROCESS_TYPE_COLORS = Object.freeze({
        Browser: 'blue',
        Tab: 'green',
        GPU: 'purple',
        Utility: 'orange',
        Zygote: 'cyan',
        'Sandbox helper': 'default'
    });
    const COMMON_COLUMNS = Object.freeze([
        { title: '进程 / 窗口', key: 'process', width: 250 },
        { title: '类型', key: 'type', width: 100 },
        { title: 'PID', key: 'pid', width: 80 },
        { title: 'CPU', key: 'cpu', width: 105 },
        { title: '工作集', key: 'workingSet', width: 105 },
        { title: '峰值', key: 'peakWorkingSet', width: 105 }
    ]);
    const PRIVATE_MEMORY_COLUMN = Object.freeze({
        title: '私有内存',
        key: 'privateMemory',
        width: 110
    });
    const WAKEUPS_COLUMN = Object.freeze({ title: '唤醒/秒', key: 'wakeups', width: 90 });
    const CREATED_AT_COLUMN = Object.freeze({ title: '启动时间', key: 'createdAt', width: 165 });

    const snapshot = ref(EMPTY_SNAPSHOT);
    const initialLoading = ref(true);
    const manualRefreshing = ref(false);
    const autoRefresh = ref(true);
    const refreshInterval = ref(2000);
    const searchText = ref('');
    const typeFilter = ref(undefined);
    const loadError = ref('');
    let refreshTimer = null;
    let requestGeneration = 0;
    let requestInFlight = false;
    let pendingManualRefresh = false;
    let disposed = false;

    const normalizeSnapshot = value => ({
        ...EMPTY_SNAPSHOT,
        ...(value && typeof value === 'object' ? value : {}),
        app: { ...EMPTY_SNAPSHOT.app, ...(value?.app || {}) },
        runtime: { ...EMPTY_SNAPSHOT.runtime, ...(value?.runtime || {}) },
        summary: { ...EMPTY_SNAPSHOT.summary, ...(value?.summary || {}) },
        systemMemory: { ...EMPTY_SNAPSHOT.systemMemory, ...(value?.systemMemory || {}) },
        processes: Array.isArray(value?.processes) ? value.processes : []
    });

    const columns = computed(() => [
        ...COMMON_COLUMNS,
        snapshot.value.runtime.platform === 'win32' ? PRIVATE_MEMORY_COLUMN : WAKEUPS_COLUMN,
        CREATED_AT_COLUMN
    ]);
    const tableMinimumWidth = computed(() =>
        columns.value.reduce((total, column) => total + Number(column.width || 0), 0)
    );

    const runtimeText = computed(() => {
        const parts = [];
        if (snapshot.value.app.version) parts.push(`NetNexus ${snapshot.value.app.version}`);
        const platform = [snapshot.value.runtime.platform, snapshot.value.runtime.arch].filter(Boolean).join(' / ');
        if (platform) parts.push(platform);
        if (snapshot.value.runtime.electronVersion) parts.push(`Electron ${snapshot.value.runtime.electronVersion}`);
        return parts.join(' · ') || '实时查看 NetNexus 关联的 Electron 进程';
    });
    const totalCpuText = computed(() =>
        snapshot.value.warmingUp ? '采样中…' : formatPercent(snapshot.value.summary.totalCpuPercent)
    );
    const sampleStatusText = computed(() => {
        if (!snapshot.value.sampledAt) return '等待首次采样';
        const prefix = snapshot.value.warmingUp ? 'CPU 首次采样中' : '更新于';
        return `${prefix} ${formatTimestamp(snapshot.value.sampledAt)}`;
    });
    const typeOptions = computed(() => {
        const values = new Map();
        snapshot.value.processes.forEach(processMetric => {
            if (!values.has(processMetric.type)) values.set(processMetric.type, processMetric.typeLabel);
        });
        return [...values.entries()]
            .map(([value, label]) => ({ value, label }))
            .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
    });
    const filteredProcesses = computed(() => {
        const query = searchText.value.trim().toLowerCase();
        return snapshot.value.processes
            .filter(processMetric => !typeFilter.value || processMetric.type === typeFilter.value)
            .filter(processMetric => {
                if (!query) return true;
                return [
                    processMetric.displayName,
                    processMetric.name,
                    processMetric.serviceName,
                    processMetric.typeLabel,
                    processMetric.pid
                ].some(value =>
                    String(value || '')
                        .toLowerCase()
                        .includes(query)
                );
            })
            .slice()
            .sort(
                (left, right) =>
                    Number(right.cpuPercent || 0) - Number(left.cpuPercent || 0) ||
                    Number(right.workingSetBytes || 0) - Number(left.workingSetBytes || 0) ||
                    Number(left.pid || 0) - Number(right.pid || 0)
            );
    });

    const formatNumber = (value, maximumFractionDigits = 1) =>
        Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits });
    const formatPercent = value => `${formatNumber(value, 1)}%`;
    const formatBytes = value => {
        const bytes = Number(value || 0);
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const amount = bytes / 1024 ** unitIndex;
        const maximumFractionDigits = amount >= 100 || unitIndex === 0 ? 0 : amount >= 10 ? 1 : 2;
        return `${formatNumber(amount, maximumFractionDigits)} ${units[unitIndex]}`;
    };
    const formatOptionalBytes = value => (value === null || value === undefined ? '-' : formatBytes(value));
    const formatWakeups = value => (value === null || value === undefined ? '-' : formatNumber(value, 1));
    const formatTimestamp = value => {
        const timestamp = Number(value);
        if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
        return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
    };
    const processTypeColor = type => PROCESS_TYPE_COLORS[type] || 'default';
    const processCpuText = processMetric => (snapshot.value.warmingUp ? '-' : formatPercent(processMetric.cpuPercent));
    const usageBarWidth = value => `${Math.min(100, Math.max(0, Number(value) || 0))}%`;

    const clearRefreshTimer = () => {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }
    };
    const scheduleRefresh = () => {
        clearRefreshTimer();
        if (disposed || !autoRefresh.value || document.hidden) return;
        refreshTimer = setTimeout(() => refreshSnapshot(), refreshInterval.value);
    };
    const refreshSnapshot = async ({ manual = false } = {}) => {
        clearRefreshTimer();
        if (disposed) return;
        if (requestInFlight) {
            if (manual) {
                pendingManualRefresh = true;
                manualRefreshing.value = true;
            }
            return;
        }
        if (typeof window.processResourceApi?.getSnapshot !== 'function') {
            initialLoading.value = false;
            manualRefreshing.value = false;
            autoRefresh.value = false;
            loadError.value = '当前环境不支持进程资源指标';
            return;
        }

        const generation = ++requestGeneration;
        requestInFlight = true;
        if (manual) manualRefreshing.value = true;
        try {
            const result = await window.processResourceApi.getSnapshot();
            if (disposed || generation !== requestGeneration) return;
            if (result?.status !== 'success' || !result.data) {
                loadError.value = result?.msg || '进程资源指标获取失败';
                return;
            }
            snapshot.value = normalizeSnapshot(result.data);
            loadError.value = '';
        } catch (error) {
            if (!disposed && generation === requestGeneration) {
                loadError.value = error.message || '进程资源指标获取失败';
            }
        } finally {
            if (generation === requestGeneration) {
                requestInFlight = false;
                initialLoading.value = false;
                if (pendingManualRefresh && !disposed) {
                    pendingManualRefresh = false;
                    manualRefreshing.value = false;
                    queueMicrotask(() => refreshSnapshot({ manual: true }));
                } else {
                    manualRefreshing.value = false;
                    scheduleRefresh();
                }
            }
        }
    };
    const handleVisibilityChange = () => {
        if (document.hidden) {
            clearRefreshTimer();
            return;
        }
        if (autoRefresh.value) refreshSnapshot();
    };

    watch([autoRefresh, refreshInterval], () => {
        if (autoRefresh.value && !document.hidden) {
            scheduleRefresh();
        } else {
            clearRefreshTimer();
        }
    });

    onMounted(() => {
        document.addEventListener('visibilitychange', handleVisibilityChange);
        refreshSnapshot();
    });

    onBeforeUnmount(() => {
        disposed = true;
        requestGeneration += 1;
        clearRefreshTimer();
        document.removeEventListener('visibilitychange', handleVisibilityChange);
    });
</script>

<style scoped>
    .process-resource-manager-page {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
        height: 100%;
        min-height: 0;
        color: var(--nn-color-text);
    }

    .resource-overview-card {
        flex: 0 0 auto;
    }

    .resource-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
    }

    .resource-heading {
        min-width: 0;
    }

    .resource-title {
        margin: 0;
        color: var(--nn-color-text-strong);
        font-size: 18px;
        font-weight: 600;
        line-height: 1.4;
    }

    .resource-subtitle,
    .summary-detail,
    .sample-meta,
    .resource-footnote,
    .process-name-cell span {
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    .resource-subtitle {
        margin-top: 2px;
    }

    .resource-actions {
        flex: 0 0 auto;
        white-space: nowrap;
    }

    .auto-refresh-label {
        flex: 0 0 auto;
        color: var(--nn-color-text-secondary);
        font-size: 13px;
        white-space: nowrap;
    }

    .refresh-interval-select {
        width: 88px;
    }

    .resource-error {
        margin-top: 10px;
    }

    .resource-summary {
        display: grid;
        grid-template-columns: repeat(4, minmax(150px, 1fr));
        gap: 10px;
        margin-top: 12px;
    }

    .summary-tile {
        display: flex;
        flex-direction: column;
        min-width: 0;
        padding: 10px 12px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-subtle);
    }

    .summary-label {
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }

    .summary-value {
        margin: 3px 0 1px;
        color: var(--nn-color-text-strong);
        font-size: 22px;
        font-variant-numeric: tabular-nums;
        line-height: 1.25;
    }

    .summary-detail {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .sample-meta {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-top: 8px;
    }

    .process-list-card {
        display: flex;
        flex: 1 1 0;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
    }

    .process-list-card :deep(.nn-card-head) {
        flex: 0 0 auto;
    }

    .process-list-card :deep(.nn-card-body) {
        padding-bottom: 10px;
    }

    .process-list-card :deep(.nn-card-body),
    .process-list-card :deep(.nn-card-body > div) {
        display: flex;
        flex: 1 1 0;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
    }

    .process-list-title {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .process-list-title h2 {
        margin: 0;
        font: inherit;
    }

    .type-filter {
        width: 130px;
    }

    .process-search {
        width: 230px;
    }

    .process-resource-table,
    .process-resource-table :deep(.nn-spin-nested-loading),
    .process-resource-table :deep(.nn-spin-container) {
        flex: 1 1 0;
        min-width: 0;
        min-height: 0;
        height: 100%;
    }

    .process-resource-table :deep(.nn-spin-container),
    .process-resource-table :deep(.nn-table),
    .process-resource-table :deep(.nn-table-container),
    .process-resource-table :deep(.nn-table-content) {
        display: flex;
        flex: 1 1 0;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
    }

    .process-resource-table :deep(.nn-table) {
        overflow: hidden;
    }

    .process-resource-table :deep(.nn-table-content) {
        overflow-y: auto !important;
    }

    .process-resource-table :deep(.nn-table-header) {
        flex: 0 0 auto;
        overflow: hidden !important;
    }

    .process-resource-table :deep(.nn-table-body) {
        flex: 1 1 0;
        min-height: 0;
        height: auto !important;
        max-height: none !important;
        overflow-y: auto !important;
    }

    .process-name-cell {
        display: flex;
        flex-direction: column;
        min-width: 0;
    }

    .process-name-cell strong,
    .process-name-cell span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .numeric-value {
        font-family: var(--nn-font-family-mono);
        font-variant-numeric: tabular-nums;
    }

    .usage-cell {
        display: flex;
        flex-direction: column;
        gap: 3px;
    }

    .usage-track {
        display: block;
        width: 74px;
        height: 3px;
        overflow: hidden;
        border-radius: 2px;
        background: var(--nn-color-bg-muted);
    }

    .usage-bar {
        display: block;
        height: 100%;
        border-radius: inherit;
    }

    .cpu-bar {
        background: var(--nn-color-primary);
    }

    .resource-footnote {
        flex: 0 0 auto;
        padding: 0 4px 2px;
        line-height: 1.4;
    }

    @media (max-width: 960px) {
        .resource-toolbar {
            align-items: flex-start;
        }

        .resource-summary {
            grid-template-columns: repeat(2, minmax(150px, 1fr));
        }

        .process-search {
            width: 190px;
        }
    }

    @media (max-width: 720px) {
        .resource-toolbar,
        .sample-meta {
            flex-direction: column;
        }

        .resource-actions {
            width: 100%;
            flex-wrap: wrap;
        }

        .resource-summary {
            grid-template-columns: 1fr;
        }
    }
</style>
