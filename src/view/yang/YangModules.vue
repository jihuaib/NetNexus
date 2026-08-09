<template>
    <div class="nn-container yang-modules-page">
        <nn-card title="YANG 模型库" class="modules-card">
            <template #extra>
                <nn-space>
                    <nn-tag :color="connected ? 'success' : 'default'">
                        {{ connected ? '设备已连接' : '设备未连接' }}
                    </nn-tag>
                    <nn-tag color="blue">共 {{ modules.length }}</nn-tag>
                    <nn-tag color="cyan">本地 {{ localModuleCount }}</nn-tag>
                    <nn-tag :color="failedModuleCount ? 'warning' : 'green'">异常 {{ failedModuleCount }}</nn-tag>
                </nn-space>
            </template>

            <div class="module-toolbar">
                <div class="module-toolbar-row" data-testid="yang-modules-toolbar">
                    <YangCurrentProfile
                        :profile="selectedProfile"
                        :loading="profilesLoading"
                        test-id="yang-modules-current-profile"
                    />
                    <div class="module-actions" data-testid="yang-modules-actions">
                        <nn-tooltip :title="connected ? '' : '请先在连接设置中建立 NETCONF 会话'">
                            <span class="disabled-action-wrap module-action-device-wrap">
                                <nn-button
                                    class="module-action-button module-action-device"
                                    :loading="discovering"
                                    :disabled="!connected || clearingWorkspace"
                                    @click="openDeviceModules"
                                >
                                    <template #icon><SearchOutlined /></template>
                                    获取设备列表
                                </nn-button>
                            </span>
                        </nn-tooltip>
                        <nn-button
                            class="module-action-button"
                            :loading="importing"
                            :disabled="!selectedProfileId || clearingWorkspace"
                            @click="importFiles"
                        >
                            <template #icon><FileSearchOutlined /></template>
                            导入文件
                        </nn-button>
                        <nn-button
                            class="module-action-button"
                            :loading="importing"
                            :disabled="!selectedProfileId || clearingWorkspace"
                            @click="importDirectory"
                        >
                            <template #icon><FolderOpenOutlined /></template>
                            导入目录
                        </nn-button>
                        <nn-tooltip :title="compileDisabledReason">
                            <span class="disabled-action-wrap module-action-standard-wrap">
                                <nn-button
                                    class="module-action-button"
                                    :loading="compiling"
                                    :disabled="Boolean(compileDisabledReason)"
                                    @click="compileSelected"
                                >
                                    <template #icon><CodeOutlined /></template>
                                    编译所选
                                </nn-button>
                            </span>
                        </nn-tooltip>
                        <nn-tooltip :title="clearWorkspaceDisabledReason">
                            <span class="disabled-action-wrap module-action-clear-wrap">
                                <nn-button
                                    danger
                                    class="module-action-button module-action-clear"
                                    :loading="clearingWorkspace"
                                    :disabled="Boolean(clearWorkspaceDisabledReason)"
                                    @click="clearWorkspace"
                                >
                                    <template #icon><DeleteOutlined /></template>
                                    清空工作区
                                </nn-button>
                            </span>
                        </nn-tooltip>
                        <nn-button
                            class="module-action-button module-refresh-action"
                            :loading="loading"
                            :disabled="clearingWorkspace"
                            @click="loadModules"
                        >
                            <template #icon><ReloadOutlined /></template>
                            刷新
                        </nn-button>
                    </div>
                </div>
            </div>

            <div class="selection-row">
                <nn-checkbox
                    :checked="allVisibleSelected"
                    :indeterminate="someVisibleSelected"
                    :disabled="filteredModules.length === 0"
                    @change="toggleAllVisible"
                >
                    选择全部筛选结果
                </nn-checkbox>
                <div class="selection-filters" data-testid="yang-modules-selection-filters">
                    <div class="selection-search">
                        <nn-input-search
                            v-model:value="query"
                            allow-clear
                            aria-label="搜索模型"
                            placeholder="模块名 / namespace / revision"
                            class="module-search"
                        />
                    </div>
                    <div class="selection-status">
                        <nn-select
                            v-model:value="statusFilter"
                            :options="statusOptions"
                            aria-label="模型状态"
                            class="compact-select"
                            data-testid="yang-modules-status-select"
                        />
                    </div>
                </div>
            </div>

            <div
                ref="moduleResultsRef"
                class="module-results-layout"
                :class="{ 'module-results-resizing': compileLogResizing }"
                :style="moduleResultsStyle"
            >
                <nn-table
                    :columns="columns"
                    :data-source="filteredModules"
                    :loading="loading"
                    :pagination="modulePagination"
                    :scroll="MODULE_TABLE_SCROLL"
                    row-key="_key"
                    size="small"
                    class="module-table"
                    @change="handleModuleTableChange"
                >
                    <template #bodyCell="{ column, record }">
                        <template v-if="column.key === 'selection'">
                            <nn-checkbox
                                :checked="selectedKeySet.has(record._key)"
                                :disabled="record.status === 'downloading' || record.status === 'compiling'"
                                @change="event => toggleModule(record, event.target.checked)"
                            />
                        </template>
                        <template v-else-if="column.key === 'name'">
                            <div class="module-name-cell">
                                <span class="module-name">{{ record.name }}</span>
                                <nn-tag v-if="record.submodule" color="default">submodule</nn-tag>
                                <nn-tag v-else-if="record.importOnly" color="default">import-only</nn-tag>
                            </div>
                        </template>
                        <template v-else-if="column.key === 'revision'">
                            <span class="mono-text">{{ record.revision || '-' }}</span>
                        </template>
                        <template v-else-if="column.key === 'namespace'">
                            <nn-tooltip :title="record.namespace || '-'">
                                <span class="ellipsis-text">{{ record.namespace || '-' }}</span>
                            </nn-tooltip>
                        </template>
                        <template v-else-if="column.key === 'features'">
                            <nn-tooltip :title="record.features.join(', ') || '无'">
                                <span>{{ record.features.length }}</span>
                            </nn-tooltip>
                        </template>
                        <template v-else-if="column.key === 'status'">
                            <nn-tooltip :title="record.message || record.error || ''">
                                <nn-tag :color="getStatusMeta(record.status).color">
                                    <LoadingOutlined v-if="['downloading', 'compiling'].includes(record.status)" spin />
                                    {{ getStatusMeta(record.status).text }}
                                </nn-tag>
                            </nn-tooltip>
                        </template>
                        <template v-else-if="column.key === 'compileStatus'">
                            <nn-tooltip :title="record.compileMessage || record.diagnostic || ''">
                                <nn-tag :color="getCompileMeta(record.compileStatus).color">
                                    {{ getCompileMeta(record.compileStatus).text }}
                                </nn-tag>
                            </nn-tooltip>
                        </template>
                        <template v-else-if="column.key === 'action'">
                            <nn-button size="small" :disabled="!record.isLocal" @click="openSource(record)">
                                源码
                            </nn-button>
                        </template>
                    </template>
                </nn-table>

                <div
                    class="compile-log-resizer"
                    role="separator"
                    aria-label="调整模型列表和编译日志高度"
                    aria-orientation="horizontal"
                    :aria-valuemin="compileLogMinHeight"
                    :aria-valuemax="compileLogMaxHeight"
                    :aria-valuenow="compileLogHeight"
                    tabindex="0"
                    title="拖动调整模型列表和编译日志高度；双击恢复默认高度"
                    @pointerdown="startCompileLogResize"
                    @keydown="handleCompileLogResizeKeydown"
                    @dblclick="resetCompileLogResize"
                >
                    <span class="pane-resizer-grip" aria-hidden="true" />
                </div>

                <section class="compile-log-panel" data-testid="yang-compile-log-panel" aria-label="编译日志">
                    <div class="compile-log-header">
                        <div class="compile-log-context">
                            <span class="compile-log-title">编译日志</span>
                            <nn-tag :color="compileContextColor">{{ compileContextLabel }}</nn-tag>
                            <span v-if="compileContext.compiledAt" class="compile-log-time">
                                {{ formatCompileTime(compileContext.compiledAt) }}
                            </span>
                            <span
                                v-if="compileContext.compileId"
                                class="compile-log-id"
                                :title="compileContext.compileId"
                            >
                                {{ compileContext.compileId }}
                            </span>
                        </div>
                        <div class="compile-log-actions">
                            <nn-segmented
                                v-if="hasCompileLogContent"
                                v-model:value="diagnosticFilter"
                                :options="diagnosticFilterOptions"
                            />
                            <span v-if="compileProgressText" class="compile-log-progress" role="status">
                                {{ compileProgressText }}
                            </span>
                            <span v-if="compileContext.compileId" class="compile-log-summary">
                                错误 {{ diagnosticErrorCount }} · 警告 {{ diagnosticWarningCount }}
                            </span>
                            <nn-button size="small" :loading="diagnosticLoading" @click="loadDiagnostics">
                                <template #icon><ReloadOutlined /></template>
                                刷新
                            </nn-button>
                        </div>
                    </div>

                    <div class="compile-log-list">
                        <nn-spin :spinning="diagnosticLoading">
                            <nn-empty v-if="!hasCompileLogContent" description="执行“编译所选”后在这里查看编译日志" />
                            <template v-else>
                                <div
                                    v-for="(diagnostic, index) in visibleDiagnostics"
                                    :key="diagnostic.id || `${diagnostic.file || ''}:${diagnostic.line || 0}:${index}`"
                                    class="compile-log-row"
                                    :data-log-id="diagnostic.id || undefined"
                                >
                                    <nn-tag :color="diagnosticColor(diagnostic.severity)">
                                        {{ diagnosticLabel(diagnostic.severity) }}
                                    </nn-tag>
                                    <span class="compile-log-content">
                                        <span class="compile-log-message">
                                            {{ diagnostic.message || diagnostic.msg || '未知日志' }}
                                        </span>
                                        <span
                                            v-if="!diagnostic.fileStatus && formatDiagnosticLocation(diagnostic)"
                                            class="compile-log-location"
                                        >
                                            {{ formatDiagnosticLocation(diagnostic) }}
                                        </span>
                                    </span>
                                </div>
                                <nn-empty v-if="visibleDiagnostics.length === 0" description="当前筛选下没有编译日志" />
                            </template>
                        </nn-spin>
                    </div>
                    <div
                        v-if="compileLogPageCount > 1"
                        class="compile-log-pagination"
                        data-testid="yang-compile-log-pagination"
                    >
                        <span>
                            {{ compileLogPageStart }}–{{ compileLogPageEnd }} / 共 {{ filteredDiagnostics.length }} 条
                        </span>
                        <nn-button
                            size="small"
                            :disabled="compileLogPage <= 1"
                            aria-label="编译日志上一页"
                            @click="changeCompileLogPage(compileLogPage - 1)"
                        >
                            ‹
                        </nn-button>
                        <span>第 {{ compileLogPage }} / {{ compileLogPageCount }} 页</span>
                        <nn-button
                            size="small"
                            :disabled="compileLogPage >= compileLogPageCount"
                            aria-label="编译日志下一页"
                            @click="changeCompileLogPage(compileLogPage + 1)"
                        >
                            ›
                        </nn-button>
                    </div>
                </section>
            </div>
        </nn-card>

        <nn-modal
            v-model:open="deviceModuleModalOpen"
            title="设备 YANG 模型"
            width="960px"
            :closable="!downloading"
            :keyboard="!downloading"
            :mask-closable="false"
            class="device-module-modal"
            data-testid="device-yang-module-modal"
            @cancel="closeDeviceModules"
        >
            <div class="device-module-dialog">
                <div class="device-module-toolbar">
                    <nn-input-search
                        v-model:value="deviceModuleQuery"
                        allow-clear
                        placeholder="模块名 / namespace / revision"
                        class="device-module-search"
                    />
                    <nn-space>
                        <nn-tag color="blue">设备 {{ deviceModules.length }}</nn-tag>
                        <nn-tag color="cyan">本地已有 {{ deviceLocalCount }}</nn-tag>
                        <nn-button :loading="discovering" :disabled="downloading" @click="loadDeviceModules">
                            <template #icon><ReloadOutlined /></template>
                            重新获取
                        </nn-button>
                    </nn-space>
                </div>

                <nn-alert
                    type="info"
                    show-icon
                    message="依赖会自动下载"
                    description="这里只选择需要的根模型；下载时会读取源码并递归补齐 import、include、submodule 和 deviation 依赖。"
                />

                <nn-alert
                    v-if="deviceModuleError"
                    type="error"
                    show-icon
                    :message="deviceModuleError"
                    class="device-module-message"
                />

                <nn-alert
                    v-if="deviceDownloadFailures.length"
                    type="warning"
                    show-icon
                    message="部分模型或依赖下载失败"
                    :description="deviceDownloadFailureText"
                    class="device-module-message"
                />

                <div class="device-module-selection-row">
                    <nn-checkbox
                        :checked="allVisibleDeviceModulesSelected"
                        :disabled="deviceSelectableVisibleModules.length === 0 || downloading"
                        @change="toggleAllVisibleDeviceModules"
                    >
                        选择全部筛选结果中未下载的模型
                    </nn-checkbox>
                    <span>
                        显示 {{ filteredDeviceModules.length }}，选择 {{ selectedDeviceModules.length }} 个根模型
                    </span>
                </div>

                <nn-table
                    :columns="deviceModuleColumns"
                    :data-source="filteredDeviceModules"
                    :loading="discovering"
                    :pagination="deviceModulePagination"
                    :scroll="{ x: 860, y: 'min(48vh, 430px)' }"
                    row-key="_key"
                    size="small"
                    class="device-module-table"
                    @change="handleDeviceModuleTableChange"
                >
                    <template #bodyCell="{ column, record }">
                        <template v-if="column.key === 'selection'">
                            <nn-checkbox
                                :checked="deviceSelectedKeySet.has(record._key)"
                                :disabled="!canDownloadDeviceModule(record) || downloading"
                                :aria-label="`选择设备模型 ${record.name}`"
                                @change="event => toggleDeviceModule(record, event.target.checked)"
                            />
                        </template>
                        <template v-else-if="column.key === 'name'">
                            <div class="module-name-cell">
                                <span class="module-name">{{ deviceModuleFileName(record) }}</span>
                                <nn-tag v-if="record.importOnly" color="default">import-only</nn-tag>
                            </div>
                        </template>
                        <template v-else-if="column.key === 'revision'">
                            <span class="mono-text">{{ record.revision || '-' }}</span>
                        </template>
                        <template v-else-if="column.key === 'namespace'">
                            <nn-tooltip :title="record.namespace || '-'">
                                <span class="ellipsis-text">{{ record.namespace || '-' }}</span>
                            </nn-tooltip>
                        </template>
                        <template v-else-if="column.key === 'features'">
                            <nn-tooltip :title="record.features.join(', ') || '无'">
                                <span>{{ record.features.length }}</span>
                            </nn-tooltip>
                        </template>
                        <template v-else-if="column.key === 'state'">
                            <nn-tag v-if="isDeviceModuleLocal(record)" color="cyan">本地已有</nn-tag>
                            <nn-tag v-else-if="!isYangDeviceModule(record)" color="warning">
                                不支持 {{ record.format }}
                            </nn-tag>
                            <nn-tag v-else color="blue">待下载</nn-tag>
                        </template>
                    </template>
                </nn-table>

                <div v-if="downloading" class="device-download-progress" role="status">
                    <span>{{ deviceDownloadProgressText }}</span>
                    <span v-if="Number.isFinite(Number(taskProgress?.percent))">
                        {{ Math.round(Number(taskProgress.percent)) }}%
                    </span>
                </div>
            </div>

            <template #footer>
                <div class="device-module-footer">
                    <span>下载结果可能多于所选数量，新增部分为自动解析出的依赖模型。</span>
                    <nn-space>
                        <nn-button :disabled="downloading" @click="closeDeviceModules">取消</nn-button>
                        <nn-button
                            type="primary"
                            :loading="downloading"
                            :disabled="selectedDeviceModules.length === 0 || discovering"
                            @click="downloadDeviceModules"
                        >
                            <template #icon><CloudDownloadOutlined /></template>
                            下载所选 ({{ selectedDeviceModules.length }})
                        </nn-button>
                    </nn-space>
                </div>
            </template>
        </nn-modal>

        <nn-drawer v-model:open="sourceDrawerOpen" :title="sourceDrawerTitle" width="720px" :z-index="1200">
            <nn-spin :spinning="sourceLoading">
                <pre class="source-preview">{{ sourceText || '暂无源码' }}</pre>
            </nn-spin>
        </nn-drawer>
    </div>
</template>

<script setup>
    import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
    import {
        NETCONF_SESSION_STATUS,
        YANG_EVENT,
        YANG_EVENT_PAGE_ID,
        YANG_MODULE_STATUS_META
    } from '../../const/yangConst';
    import EventBus from '../../utils/eventBus';
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';
    import {
        CloudDownloadOutlined,
        CodeOutlined,
        DeleteOutlined,
        FileSearchOutlined,
        FolderOpenOutlined,
        LoadingOutlined,
        ReloadOutlined,
        SearchOutlined
    } from 'netnexus-ui/icons';
    import YangCurrentProfile from './YangCurrentProfile.vue';
    import { usePaneResize } from './usePaneResize';
    import { useYangCompilerStatus } from './yangCompilerStatus';
    import { useYangProfileContext } from './useYangProfileContext';
    import {
        fileBaseName,
        getTaskId,
        invokeBridge,
        isTaskTerminal,
        normalizeSessionEvent,
        unwrapArray
    } from './yangUiUtils';

    defineOptions({ name: 'YangModules' });

    const columns = [
        { title: '选择', key: 'selection', width: 54, align: 'center' },
        { title: '模块名', dataIndex: 'name', key: 'name', width: 220, sorter: (a, b) => a.name.localeCompare(b.name) },
        { title: 'Revision', dataIndex: 'revision', key: 'revision', width: 112 },
        { title: 'Namespace', dataIndex: 'namespace', key: 'namespace', width: 250 },
        { title: 'Feature', key: 'features', width: 70, align: 'center' },
        { title: '文件状态', key: 'status', width: 105 },
        { title: '编译状态', key: 'compileStatus', width: 105 },
        { title: '操作', key: 'action', width: 72, fixed: 'right' }
    ];
    const deviceModuleColumns = [
        { title: '选择', key: 'selection', width: 54, align: 'center' },
        { title: '模型文件', key: 'name', width: 260 },
        { title: 'Revision', key: 'revision', width: 112 },
        { title: 'Namespace', key: 'namespace', width: 260 },
        { title: 'Feature', key: 'features', width: 70, align: 'center' },
        { title: '状态', key: 'state', width: 104 }
    ];
    const statusOptions = [
        { label: '全部状态', value: 'all' },
        { label: '未编译', value: 'pending' },
        { label: '已编译', value: 'compiled' },
        { label: '异常', value: 'problem' }
    ];
    const MODULE_TABLE_PAGE_SIZE = 50;
    const MODULE_TABLE_SCROLL = Object.freeze({ x: 990, y: '100%' });
    const COMPILE_LOG_PAGE_SIZE = 100;
    const COMPILE_PHASE_LABELS = Object.freeze({
        queued: '编译任务已排队',
        preparing: '正在准备编译',
        runtime: '正在检查 libyang 运行时',
        parsing: '正在解析 YANG 文件',
        dependencies: '正在解析依赖关系',
        external: '正在生成有效 Schema',
        schema: '有效 Schema 已生成',
        'file-validation': '正在确认逐文件编译结果',
        'file-result': '正在更新逐文件编译结果',
        'partial-schema': '正在生成部分有效 Schema',
        caching: '正在保存编译缓存',
        completed: 'YANG 编译完成',
        failed: 'YANG 编译失败',
        cancelled: 'YANG 编译已取消'
    });

    const modules = ref([]);
    const selectedKeys = ref([]);
    const query = ref('');
    const statusFilter = ref('all');
    const modulePage = ref(1);
    const clearingWorkspace = ref(false);
    const modulePageSize = ref(MODULE_TABLE_PAGE_SIZE);
    const deviceModuleModalOpen = ref(false);
    const deviceModules = ref([]);
    const deviceSelectedKeys = ref([]);
    const deviceModuleQuery = ref('');
    const deviceModulePage = ref(1);
    const deviceModulePageSize = ref(50);
    const deviceModuleError = ref('');
    const deviceDownloadFailures = ref([]);
    const deviceDownloadTerminalHandled = ref(false);
    const loading = ref(false);
    const discovering = ref(false);
    const downloading = ref(false);
    const importing = ref(false);
    const compiling = ref(false);
    const connected = ref(false);
    const activeTasks = ref({ discover: '', download: '', import: '', compile: '' });
    const taskProgress = ref(null);
    const sourceDrawerOpen = ref(false);
    const sourceLoading = ref(false);
    const sourceText = ref('');
    const sourceModule = ref(null);
    const diagnosticLoading = ref(false);
    const diagnostics = ref([]);
    const diagnosticFilter = ref('all');
    const liveCompileLogs = ref([]);
    const compileLogPage = ref(1);
    const compileContext = ref({ compileId: '', success: null, compiledAt: null, summary: {}, modules: [] });
    const moduleResultsRef = ref(null);
    const {
        paneSize: compileLogHeight,
        minSize: compileLogMinHeight,
        maxSize: compileLogMaxHeight,
        resizing: compileLogResizing,
        startResize: startCompileLogResize,
        handleResizeKeydown: handleCompileLogResizeKeydown,
        resetResize: resetCompileLogResize,
        stopResize: stopCompileLogResize
    } = usePaneResize({
        containerRef: moduleResultsRef,
        orientation: 'horizontal',
        reverse: true,
        defaultRatio: 0.32,
        minFirst: 140,
        minSecond: 220,
        dividerSize: 8,
        frameSynchronized: true,
        previewStyleProperty: '--compile-log-preview-height'
    });
    let diagnosticRequestRevision = 0;
    let compileContextRequestRevision = 0;
    let sourceRequestRevision = 0;
    let profileRequestRevision = 0;
    let clearWorkspaceRequestRevision = 0;
    let profileContextReady = false;
    let liveCompileLogFrame = 0;
    let liveCompileTaskId = '';
    let pendingCompileProgress = null;
    let clearWorkspaceConfirmHandle = null;
    const pendingLiveCompileLogs = new Map();
    const { compilerAvailable, refreshCompilerStatus } = useYangCompilerStatus();
    const { profilesLoading, selectedProfileId, selectedProfile, refreshProfiles, taskMatchesProfile } =
        useYangProfileContext();
    const profileRequestMatches = (profileId, requestRevision) =>
        requestRevision === profileRequestRevision && profileId === selectedProfileId.value;

    const diagnosticFilterOptions = [
        { label: '全部', value: 'all' },
        { label: '错误', value: 'error' },
        { label: '警告', value: 'warning' },
        { label: '信息', value: 'info' }
    ];

    const normalizeModule = (module, index = 0) => {
        const metadata = module?.metadata || {};
        const name = module?.name || module?.moduleName || module?.identifier || metadata.name || `unknown-${index}`;
        const revision = module?.revision || module?.revisionDate || metadata.revision || '';
        const localPath = module?.filePath || module?.path || module?.localPath || '';
        const isLocal = Boolean(
            module?.isLocal || localPath || module?.hash || module?.contentHash || module?.sha256 || module?.sourceText
        );
        const compileStatus =
            module?.compileStatus || (module?.compiled ? 'compiled' : module?.compileError ? 'failed' : 'pending');
        let status = module?.downloadStatus || module?.status;
        if (!status || status === 'pending')
            status = isLocal ? (module?.imported ? 'imported' : 'downloaded') : 'remote';
        if (compileStatus === 'compiled') status = 'compiled';
        if (compileStatus === 'failed') status = 'failed';
        const id = module?.id || module?.moduleId || module?.hash || '';
        const diagnostics = Array.isArray(module?.diagnostics) ? module.diagnostics : [];
        if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) status = 'failed';
        else if (diagnostics.some(diagnostic => ['warning', 'warn'].includes(diagnostic.severity))) status = 'warning';
        return {
            ...module,
            id,
            name,
            revision,
            namespace: module?.namespace || metadata.namespace || '',
            features: Array.isArray(module?.features)
                ? module.features
                : Array.isArray(metadata.features)
                  ? metadata.features
                  : [],
            deviations: Array.isArray(module?.deviations)
                ? module.deviations
                : Array.isArray(metadata.deviations)
                  ? metadata.deviations
                  : [],
            submodule: Boolean(module?.submodule || module?.isSubmodule || metadata.kind === 'submodule'),
            importOnly: Boolean(module?.importOnly || module?.conformanceType === 'import'),
            imported: Boolean(module?.imported || module?.source === 'import'),
            isLocal,
            localPath,
            fileName: module?.fileName || fileBaseName(localPath),
            status,
            compileStatus,
            _key: `${name}@${revision || 'none'}`
        };
    };

    const normalizeDiagnostic = diagnostic => ({
        ...diagnostic,
        severity: String(diagnostic?.severity || diagnostic?.level || 'error').toLowerCase(),
        fileName: diagnostic?.fileName || fileBaseName(diagnostic?.file || diagnostic?.filePath || diagnostic?.source)
    });

    const mergeModules = nextModules => {
        const merged = new Map(modules.value.map(module => [module._key, module]));
        nextModules.map(normalizeModule).forEach(module => {
            const existing = merged.get(module._key);
            merged.set(module._key, existing ? { ...existing, ...module } : module);
        });
        modules.value = [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
        const validKeys = new Set(modules.value.map(module => module._key));
        selectedKeys.value = selectedKeys.value.filter(key => validKeys.has(key));
    };

    const replaceLocalModules = nextModules => {
        modules.value = nextModules
            .map(normalizeModule)
            .filter(module => module.isLocal)
            .sort((left, right) => left.name.localeCompare(right.name));
        const validKeys = new Set(modules.value.map(module => module._key));
        selectedKeys.value = selectedKeys.value.filter(key => validKeys.has(key));
    };

    const filteredModules = computed(() => {
        const search = query.value.trim().toLowerCase();
        return modules.value.filter(module => {
            const matchesSearch =
                !search ||
                [module.name, module.revision, module.namespace].some(value =>
                    String(value || '')
                        .toLowerCase()
                        .includes(search)
                );
            let matchesStatus = true;
            if (statusFilter.value === 'pending') matchesStatus = module.compileStatus === 'pending';
            else if (statusFilter.value === 'compiled') matchesStatus = module.compileStatus === 'compiled';
            else if (statusFilter.value === 'problem') {
                matchesStatus =
                    ['failed', 'missing', 'warning'].includes(module.status) || module.compileStatus === 'failed';
            }
            return matchesSearch && matchesStatus;
        });
    });
    const modulePageCount = computed(() => Math.max(1, Math.ceil(filteredModules.value.length / modulePageSize.value)));
    const modulePagination = computed(() =>
        filteredModules.value.length > modulePageSize.value
            ? {
                  current: modulePage.value,
                  pageSize: modulePageSize.value,
                  showSizeChanger: true,
                  pageSizeOptions: [25, 50, 100],
                  showQuickJumper: true,
                  position: ['bottomCenter'],
                  showTotal: total => `共 ${total} 个模型`
              }
            : false
    );
    const isYangDeviceModule = module => String(module?.format || 'yang').toLowerCase() === 'yang';
    const isDeviceModuleLocal = module =>
        modules.value.some(
            localModule =>
                localModule.isLocal &&
                localModule.name === module.name &&
                (!module.revision || localModule.revision === module.revision)
        );
    const canDownloadDeviceModule = module => isYangDeviceModule(module) && !isDeviceModuleLocal(module);
    const filteredDeviceModules = computed(() => {
        const search = deviceModuleQuery.value.trim().toLowerCase();
        if (!search) return deviceModules.value;
        return deviceModules.value.filter(module =>
            [module.name, module.revision, module.namespace].some(value =>
                String(value || '')
                    .toLowerCase()
                    .includes(search)
            )
        );
    });
    const deviceSelectedKeySet = computed(() => new Set(deviceSelectedKeys.value));
    const deviceSelectableVisibleModules = computed(() => filteredDeviceModules.value.filter(canDownloadDeviceModule));
    const selectedDeviceModules = computed(() =>
        deviceModules.value.filter(
            module => deviceSelectedKeySet.value.has(module._key) && canDownloadDeviceModule(module)
        )
    );
    const allVisibleDeviceModulesSelected = computed(
        () =>
            deviceSelectableVisibleModules.value.length > 0 &&
            deviceSelectableVisibleModules.value.every(module => deviceSelectedKeySet.value.has(module._key))
    );
    const deviceModulePagination = computed(() =>
        filteredDeviceModules.value.length > deviceModulePageSize.value
            ? {
                  current: deviceModulePage.value,
                  pageSize: deviceModulePageSize.value,
                  showSizeChanger: true,
                  pageSizeOptions: [25, 50, 100],
                  showQuickJumper: true,
                  position: ['bottomCenter']
              }
            : false
    );
    const deviceLocalCount = computed(() => deviceModules.value.filter(isDeviceModuleLocal).length);
    const deviceDownloadFailureText = computed(() =>
        deviceDownloadFailures.value
            .map(item => `${item.name || item.identifier || '未知模型'}：${item.error || item.message || '下载失败'}`)
            .join('；')
    );
    const deviceDownloadProgressText = computed(() => {
        const progress = taskProgress.value;
        if (!progress || progress.action !== 'download') return '正在准备下载';
        if (progress.phase === 'discovering') return '正在刷新设备 YANG 列表';
        if (progress.phase === 'importing') return '正在写入本地 YANG 仓库';
        const count = Number(progress.total || 0) ? `${Number(progress.completed || 0)}/${Number(progress.total)}` : '';
        return [progress.module || progress.message || '正在下载模型及其依赖', count].filter(Boolean).join(' · ');
    });
    const selectedKeySet = computed(() => new Set(selectedKeys.value));
    const allVisibleSelected = computed(
        () =>
            filteredModules.value.length > 0 &&
            filteredModules.value.every(module => selectedKeySet.value.has(module._key))
    );
    const someVisibleSelected = computed(
        () => !allVisibleSelected.value && filteredModules.value.some(module => selectedKeySet.value.has(module._key))
    );
    const selectedModules = computed(() => modules.value.filter(module => selectedKeySet.value.has(module._key)));
    const selectedLocalModules = computed(() => selectedModules.value.filter(module => module.isLocal && module.id));
    const localModuleCount = computed(() => modules.value.filter(module => module.isLocal).length);
    const failedModuleCount = computed(
        () => modules.value.filter(module => ['failed', 'missing', 'warning'].includes(module.status)).length
    );
    const diagnosticErrorCount = computed(
        () => diagnostics.value.filter(item => ['error', 'fatal'].includes(item.severity)).length
    );
    const diagnosticWarningCount = computed(
        () => diagnostics.value.filter(item => ['warning', 'warn'].includes(item.severity)).length
    );
    const compileProgressText = computed(() => {
        const progress = taskProgress.value;
        if (!progress || progress.action !== 'compile' || !compiling.value) return '';
        const completed = Number(progress.completed);
        const total = Number(progress.total);
        const count = Number.isFinite(completed) && Number.isFinite(total) && total > 0 ? `${completed}/${total}` : '';
        const percent = Number(progress.percent);
        const percentage = Number.isFinite(percent) ? `${Math.round(percent)}%` : '';
        return [count, percentage].filter(Boolean).join(' · ');
    });
    const compileFileLogs = computed(() =>
        (compileContext.value.modules || [])
            .filter(module => ['compiled', 'failed'].includes(module.compileStatus))
            .map(module => {
                const fileName =
                    module.fileName || `${module.name}${module.revision ? `@${module.revision}` : ''}.yang`;
                const compiled = module.compileStatus === 'compiled';
                const compileDiagnostic = module.compileDiagnostic
                    ? normalizeDiagnostic(module.compileDiagnostic)
                    : null;
                const failureReason = String(compileDiagnostic?.message || module.compileMessage || '').trim();
                return {
                    id: `compile-file:${module.id || module._key}:${module.compileStatus}`,
                    severity: compiled ? 'success' : 'error',
                    fileStatus: module.compileStatus,
                    moduleId: module.id || module.moduleId || module.hash,
                    module: module.name,
                    revision: module.revision,
                    file: module.filePath || module.localPath || fileName,
                    fileName,
                    code: compileDiagnostic?.code,
                    line: compileDiagnostic?.line,
                    column: compileDiagnostic?.column,
                    message: `${fileName} 编译${compiled ? '成功' : `失败${failureReason ? `：${failureReason}` : ''}`}`
                };
            })
    );
    const compileContextPartial = computed(
        () =>
            Number(compileContext.value.summary?.compiledFiles || 0) > 0 &&
            Number(compileContext.value.summary?.failedFiles || 0) > 0
    );
    const compileContextColor = computed(() => {
        if (compiling.value) return 'processing';
        if (!compileContext.value.compileId) return 'default';
        if (compileContextPartial.value) return 'warning';
        return compileContext.value.success === true ? 'success' : 'error';
    });
    const compileContextLabel = computed(() => {
        if (compiling.value) return '编译中';
        if (!compileContext.value.compileId) return '尚未编译';
        if (compileContextPartial.value) return '部分编译成功';
        return compileContext.value.success === true ? '编译成功' : '编译失败';
    });
    const moduleResultsStyle = computed(() =>
        compileLogHeight.value > 0 ? { '--compile-log-height': `${compileLogHeight.value}px` } : undefined
    );
    const filteredDiagnostics = computed(() => {
        const compileLogs = [...liveCompileLogs.value, ...diagnostics.value, ...compileFileLogs.value];
        if (diagnosticFilter.value === 'all') return compileLogs;
        if (diagnosticFilter.value === 'error') {
            return compileLogs.filter(item => ['error', 'fatal'].includes(item.severity));
        }
        if (diagnosticFilter.value === 'warning') {
            return compileLogs.filter(item => ['warning', 'warn'].includes(item.severity));
        }
        return compileLogs.filter(item => !['error', 'fatal', 'warning', 'warn'].includes(item.severity));
    });
    const hasCompileLogContent = computed(
        () => compiling.value || Boolean(compileContext.value.compileId) || liveCompileLogs.value.length > 0
    );
    const compileLogPageCount = computed(() =>
        Math.max(1, Math.ceil(filteredDiagnostics.value.length / COMPILE_LOG_PAGE_SIZE))
    );
    const visibleDiagnostics = computed(() => {
        const page = Math.min(compileLogPage.value, compileLogPageCount.value);
        const offset = (page - 1) * COMPILE_LOG_PAGE_SIZE;
        return filteredDiagnostics.value.slice(offset, offset + COMPILE_LOG_PAGE_SIZE);
    });
    const compileLogPageStart = computed(() =>
        filteredDiagnostics.value.length ? (compileLogPage.value - 1) * COMPILE_LOG_PAGE_SIZE + 1 : 0
    );
    const compileLogPageEnd = computed(() =>
        Math.min(filteredDiagnostics.value.length, compileLogPage.value * COMPILE_LOG_PAGE_SIZE)
    );
    const compileDisabledReason = computed(() => {
        if (clearingWorkspace.value) return '正在清空 YANG 工作区';
        if (!selectedProfileId.value) return '请先选择连接 Profile';
        if (!compilerAvailable.value) return 'YANG 编译暂不可用，请在“设置 → 运行时”中检查';
        if (selectedLocalModules.value.length === 0) return '请先选择已下载或已导入的本地模块';
        return '';
    });
    const workspaceTaskInProgress = computed(
        () =>
            discovering.value ||
            downloading.value ||
            importing.value ||
            compiling.value ||
            Object.values(activeTasks.value).some(Boolean)
    );
    const clearWorkspaceDisabledReason = computed(() => {
        if (!selectedProfileId.value) return '请先选择连接 Profile';
        if (clearingWorkspace.value) return '正在清空 YANG 工作区';
        if (workspaceTaskInProgress.value) return '模型任务执行中，请等待任务结束后再清空工作区';
        if (modules.value.length === 0 && !hasCompileLogContent.value && diagnostics.value.length === 0) {
            return '当前 YANG 工作区为空';
        }
        return '';
    });
    const sourceDrawerTitle = computed(() => {
        if (!sourceModule.value) return 'YANG 源码';
        return `${sourceModule.value.name}${sourceModule.value.revision ? `@${sourceModule.value.revision}` : ''}`;
    });
    const getStatusMeta = status =>
        YANG_MODULE_STATUS_META[status] || {
            text: status && status !== 'pending' ? status : '待处理',
            color: 'default'
        };
    const getCompileMeta = status => {
        if (status === 'compiled') return YANG_MODULE_STATUS_META.compiled;
        if (status === 'compiling') return YANG_MODULE_STATUS_META.compiling;
        if (status === 'failed') return YANG_MODULE_STATUS_META.failed;
        if (status === 'warning') return YANG_MODULE_STATUS_META.warning;
        return { text: '未编译', color: 'default' };
    };

    const toggleModule = (module, checked) => {
        if (checked && !selectedKeys.value.includes(module._key)) selectedKeys.value.push(module._key);
        if (!checked) selectedKeys.value = selectedKeys.value.filter(key => key !== module._key);
    };

    const changeCompileLogPage = page => {
        compileLogPage.value = Math.min(compileLogPageCount.value, Math.max(1, Number(page) || 1));
    };

    const handleModuleTableChange = pagination => {
        modulePage.value = Number(pagination?.current) || 1;
        modulePageSize.value = Number(pagination?.pageSize) || MODULE_TABLE_PAGE_SIZE;
    };

    const toggleAllVisible = event => {
        const keys = filteredModules.value.map(module => module._key);
        if (event.target.checked) selectedKeys.value = [...new Set([...selectedKeys.value, ...keys])];
        else {
            const keySet = new Set(keys);
            selectedKeys.value = selectedKeys.value.filter(key => !keySet.has(key));
        }
    };

    const toggleDeviceModule = (module, checked) => {
        if (!canDownloadDeviceModule(module)) return;
        if (checked && !deviceSelectedKeys.value.includes(module._key)) {
            deviceSelectedKeys.value.push(module._key);
        }
        if (!checked) deviceSelectedKeys.value = deviceSelectedKeys.value.filter(key => key !== module._key);
    };

    const toggleAllVisibleDeviceModules = event => {
        const keys = deviceSelectableVisibleModules.value.map(module => module._key);
        if (event.target.checked) deviceSelectedKeys.value = [...new Set([...deviceSelectedKeys.value, ...keys])];
        else {
            const keySet = new Set(keys);
            deviceSelectedKeys.value = deviceSelectedKeys.value.filter(key => !keySet.has(key));
        }
    };

    const handleDeviceModuleTableChange = pagination => {
        deviceModulePage.value = Number(pagination?.current) || 1;
        deviceModulePageSize.value = Number(pagination?.pageSize) || 50;
    };

    const deviceModuleFileName = module =>
        `${module.name}${module.revision ? `@${module.revision}` : ''}.${String(module.format || 'yang').toLowerCase()}`;

    const loadModules = async () => {
        const profileId = selectedProfileId.value;
        const requestRevision = profileRequestRevision;
        if (!profileId) {
            modules.value = [];
            loading.value = false;
            return;
        }
        loading.value = true;
        try {
            const { data } = await invokeBridge('yangApi', 'listModules', { profileId });
            if (requestRevision !== profileRequestRevision || profileId !== selectedProfileId.value) return;
            replaceLocalModules(unwrapArray(data, ['modules', 'items', 'records']));
        } catch (error) {
            if (requestRevision === profileRequestRevision && profileId === selectedProfileId.value) {
                notify.error(`加载 YANG 模型失败：${error.message}`);
            }
        } finally {
            if (requestRevision === profileRequestRevision && profileId === selectedProfileId.value) {
                loading.value = false;
            }
        }
    };

    const normalizeCompileContext = data => {
        const workspace = data?.workspace || data || {};
        return {
            compileId: workspace.compileId || '',
            success: workspace.success ?? null,
            compiledAt: workspace.compiledAt || null,
            summary: workspace.summary || {},
            modules: Array.isArray(workspace.modules) ? workspace.modules.map(normalizeModule) : [],
            diagnostics: Array.isArray(workspace.diagnostics) ? workspace.diagnostics.map(normalizeDiagnostic) : null,
            diagnosticsTruncated: workspace.diagnosticsTruncated === true,
            restoreError: workspace.restoreError || ''
        };
    };

    const applyCompileContext = context => {
        const compileChanged = !context.compileId || context.compileId !== compileContext.value.compileId;
        if (compileChanged) {
            diagnostics.value = [];
            diagnosticFilter.value = 'all';
        }
        compileContext.value = context;
        if (context.diagnostics?.length) diagnostics.value = context.diagnostics;
    };

    const fetchCompileContext = async (profileId = selectedProfileId.value) => {
        if (!profileId) return normalizeCompileContext(null);
        const { data } = await invokeBridge('yangApi', 'getWorkspace', { profileId });
        return normalizeCompileContext(data);
    };

    const loadCompileContext = async ({ quiet = false } = {}) => {
        const contextRequestRevision = ++compileContextRequestRevision;
        const profileId = selectedProfileId.value;
        const requestRevision = profileRequestRevision;
        try {
            const context = await fetchCompileContext(profileId);
            if (
                contextRequestRevision !== compileContextRequestRevision ||
                requestRevision !== profileRequestRevision ||
                profileId !== selectedProfileId.value
            ) {
                return null;
            }
            applyCompileContext(context);
            return context;
        } catch (error) {
            if (contextRequestRevision === compileContextRequestRevision && !quiet) {
                notify.error(`加载编译上下文失败：${error.message}`);
            }
            return null;
        }
    };

    const loadDiagnostics = async options => {
        const quiet = options?.quiet === true;
        const requestRevision = ++diagnosticRequestRevision;
        const contextRequestRevision = ++compileContextRequestRevision;
        const profileRevision = profileRequestRevision;
        const profileId = selectedProfileId.value;
        let requestedCompileId = '';
        let restoreError = '';
        diagnosticLoading.value = true;
        try {
            const context = await fetchCompileContext(profileId);
            if (
                requestRevision !== diagnosticRequestRevision ||
                contextRequestRevision !== compileContextRequestRevision ||
                profileRevision !== profileRequestRevision ||
                profileId !== selectedProfileId.value
            ) {
                return { loaded: false, stale: true, count: diagnostics.value.length };
            }
            applyCompileContext(context);
            restoreError = context.restoreError;
            if (!context.compileId) return { loaded: true, count: diagnostics.value.length };
            requestedCompileId = context.compileId;
            const { data } = await invokeBridge('yangApi', 'getDiagnostics', {
                profileId,
                compileId: context.compileId
            });
            if (
                requestRevision !== diagnosticRequestRevision ||
                contextRequestRevision !== compileContextRequestRevision ||
                compileContext.value.compileId !== context.compileId
            ) {
                return { loaded: false, stale: true, count: diagnostics.value.length };
            }
            const confirmedContext = await fetchCompileContext(profileId);
            if (
                requestRevision !== diagnosticRequestRevision ||
                contextRequestRevision !== compileContextRequestRevision
            ) {
                return { loaded: false, stale: true, count: diagnostics.value.length };
            }
            applyCompileContext(confirmedContext);
            if (confirmedContext.compileId !== context.compileId) {
                return { loaded: false, stale: true, count: diagnostics.value.length };
            }
            diagnostics.value = unwrapArray(data, ['diagnostics', 'items']).map(normalizeDiagnostic);
            return { loaded: true, count: diagnostics.value.length };
        } catch (error) {
            const requestIsCurrent =
                requestRevision === diagnosticRequestRevision &&
                contextRequestRevision === compileContextRequestRevision;
            if (requestIsCurrent && requestedCompileId) {
                try {
                    const latestContext = await fetchCompileContext(profileId);
                    if (
                        requestRevision === diagnosticRequestRevision &&
                        contextRequestRevision === compileContextRequestRevision
                    ) {
                        applyCompileContext(latestContext);
                    }
                } catch (_contextError) {
                    // Keep the last known diagnostic rows when the persisted compile context is also unavailable.
                }
            }
            if (requestIsCurrent && diagnostics.value.length === 0) {
                diagnostics.value = [
                    normalizeDiagnostic({
                        severity: 'error',
                        code: error.code || 'YANG_DIAGNOSTICS_UNAVAILABLE',
                        message: restoreError || `无法读取详细编译诊断：${error.message}`
                    })
                ];
            }
            if (
                requestRevision === diagnosticRequestRevision &&
                contextRequestRevision === compileContextRequestRevision &&
                !quiet
            ) {
                notify.error(`加载编译诊断失败：${error.message}`);
            }
            return { loaded: false, count: diagnostics.value.length };
        } finally {
            if (requestRevision === diagnosticRequestRevision) diagnosticLoading.value = false;
        }
    };

    const loadSession = async () => {
        const profileId = selectedProfileId.value;
        const requestRevision = profileRequestRevision;
        if (!profileId) {
            connected.value = false;
            return;
        }
        try {
            const { data } = await invokeBridge('netconfApi', 'getSessionState', profileId);
            if (requestRevision !== profileRequestRevision || profileId !== selectedProfileId.value) return;
            const status = data?.status || data?.state;
            connected.value = data?.connected === true || status === NETCONF_SESSION_STATUS.CONNECTED;
        } catch (_error) {
            if (requestRevision === profileRequestRevision && profileId === selectedProfileId.value) {
                connected.value = false;
            }
        }
    };

    const handleImmediateTask = (action, data, arrays = []) => {
        const taskId = getTaskId(data);
        if (taskId) {
            activeTasks.value[action] = taskId;
            return true;
        }
        const resultModules = unwrapArray(data, arrays);
        if (resultModules.length) mergeModules(resultModules);
        return false;
    };

    const openDeviceModules = () => {
        if (!connected.value || !selectedProfileId.value) return;
        deviceModuleModalOpen.value = true;
        deviceModuleQuery.value = '';
        deviceModulePage.value = 1;
        deviceSelectedKeys.value = [];
        deviceDownloadFailures.value = [];
        deviceModuleError.value = '';
        loadDeviceModules();
    };

    const closeDeviceModules = () => {
        if (downloading.value) return;
        deviceModuleModalOpen.value = false;
    };

    const loadDeviceModules = async () => {
        const profileId = selectedProfileId.value;
        const requestRevision = profileRequestRevision;
        if (!profileId) return;
        discovering.value = true;
        deviceModulePage.value = 1;
        deviceModuleError.value = '';
        deviceDownloadFailures.value = [];
        deviceSelectedKeys.value = [];
        try {
            const { data } = await invokeBridge('netconfApi', 'discoverModules', profileId);
            if (!profileRequestMatches(profileId, requestRevision)) return;
            deviceModules.value = unwrapArray(data, ['modules', 'items'])
                .map(normalizeModule)
                .sort((left, right) => left.name.localeCompare(right.name));
        } catch (error) {
            if (profileRequestMatches(profileId, requestRevision)) {
                deviceModules.value = [];
                deviceModuleError.value = `获取设备 YANG 列表失败：${error.message}`;
            }
        } finally {
            if (profileRequestMatches(profileId, requestRevision)) {
                discovering.value = false;
            }
        }
    };

    const moduleIdentity = module => ({
        id: module.id || undefined,
        name: module.name,
        revision: module.revision || undefined
    });

    const finishDeviceDownload = async (data, profileId, requestRevision) => {
        deviceDownloadFailures.value = Array.isArray(data?.failed) ? data.failed : [];
        downloading.value = false;
        await Promise.all([loadModules(), loadCompileContext({ quiet: true })]);
        if (!profileRequestMatches(profileId, requestRevision)) return;
        if (deviceDownloadFailures.value.length) {
            return;
        }
        deviceModuleModalOpen.value = false;
        notify.success('YANG 模型及其依赖下载完成');
    };

    const downloadDeviceModules = async () => {
        const profileId = selectedProfileId.value;
        const requestRevision = profileRequestRevision;
        const targets = [...selectedDeviceModules.value];
        if (!profileId || targets.length === 0) return;
        downloading.value = true;
        deviceDownloadTerminalHandled.value = false;
        deviceModuleError.value = '';
        deviceDownloadFailures.value = [];
        try {
            const { data } = await invokeBridge('netconfApi', 'downloadModules', {
                profileId,
                modules: targets.map(moduleIdentity),
                includeDependencies: true
            });
            if (!profileRequestMatches(profileId, requestRevision)) return;
            const taskId = getTaskId(data);
            if (taskId) activeTasks.value.download = taskId;
            else if (!deviceDownloadTerminalHandled.value) {
                await finishDeviceDownload(data, profileId, requestRevision);
            }
        } catch (error) {
            if (!profileRequestMatches(profileId, requestRevision)) return;
            downloading.value = false;
            deviceModuleError.value = `下载失败：${error.message}`;
            notify.error(deviceModuleError.value);
        }
    };

    const selectImportTarget = async method => {
        const selector = method === 'importFiles' ? 'selectFiles' : 'selectDirectory';
        const { data } = await invokeBridge('yangApi', selector);
        if (data?.cancelled || data?.canceled) return null;
        if (method === 'importFiles') {
            const paths = Array.isArray(data) ? data : data?.filePaths || data?.paths || [];
            return paths.length ? paths : null;
        }
        const directoryPath = typeof data === 'string' ? data : data?.directoryPath || data?.path || '';
        return directoryPath || null;
    };

    const runImport = async method => {
        const profileId = selectedProfileId.value;
        const requestRevision = profileRequestRevision;
        if (!profileId) return;
        importing.value = true;
        try {
            const target = await selectImportTarget(method);
            if (!profileRequestMatches(profileId, requestRevision)) return;
            if (!target) {
                importing.value = false;
                return;
            }
            const request =
                method === 'importFiles' ? { profileId, filePaths: target } : { profileId, directoryPath: target };
            const { data } = await invokeBridge('yangApi', method, request);
            if (!profileRequestMatches(profileId, requestRevision)) return;
            const asyncTask = handleImmediateTask('import', data, ['modules']);
            if (!asyncTask) {
                importing.value = false;
                await Promise.all([loadModules(), loadCompileContext({ quiet: true })]);
                if (!profileRequestMatches(profileId, requestRevision)) return;
                notify.success('YANG 文件导入完成');
            }
        } catch (error) {
            if (profileRequestMatches(profileId, requestRevision)) {
                importing.value = false;
                notify.error(`导入失败：${error.message}`);
            }
        }
    };

    const importFiles = () => runImport('importFiles');
    const importDirectory = () => runImport('importDirectory');

    const compileSelected = async () => {
        if (compileDisabledReason.value) {
            notify.error(compileDisabledReason.value);
            return;
        }
        const profileId = selectedProfileId.value;
        const requestRevision = profileRequestRevision;
        const targets = [...selectedLocalModules.value];
        compiling.value = true;
        beginCompileLog(targets);
        targets.forEach(module => {
            module.compileStatus = 'compiling';
        });
        try {
            const { data } = await invokeBridge('yangApi', 'compile', {
                profileId,
                moduleIds: targets.map(moduleIdentity)
            });
            if (!profileRequestMatches(profileId, requestRevision)) return;
            const asyncTask = handleImmediateTask('compile', data, ['modules']);
            if (!asyncTask) {
                compiling.value = false;
                await Promise.all([loadModules(), loadDiagnostics({ quiet: true })]);
                if (!profileRequestMatches(profileId, requestRevision)) return;
                clearLiveCompileLogs();
                notify.success(data?.cacheHit ? '编译完成（缓存命中）' : 'YANG 编译完成');
            }
        } catch (error) {
            if (!profileRequestMatches(profileId, requestRevision)) return;
            await refreshCompilerStatus({ force: true });
            if (!profileRequestMatches(profileId, requestRevision)) return;
            targets.forEach(module => {
                module.compileStatus = 'failed';
                module.compileMessage = error.message;
            });
            compiling.value = false;
            queueCompileProgressLog({ phase: 'failed', percent: 100, message: error.message });
            notify.error(`编译失败：${error.message}`);
        }
    };

    const closeClearWorkspaceConfirm = () => {
        clearWorkspaceConfirmHandle?.destroy?.();
        clearWorkspaceConfirmHandle = null;
    };

    const resetClearedWorkspaceState = () => {
        diagnosticRequestRevision += 1;
        compileContextRequestRevision += 1;
        sourceRequestRevision += 1;
        modules.value = [];
        selectedKeys.value = [];
        modulePage.value = 1;
        diagnostics.value = [];
        diagnosticFilter.value = 'all';
        clearLiveCompileLogs();
        compileContext.value = { compileId: '', success: null, compiledAt: null, summary: {}, modules: [] };
        taskProgress.value = null;
        sourceDrawerOpen.value = false;
        sourceLoading.value = false;
        sourceModule.value = null;
        sourceText.value = '';
    };

    const clearWorkspace = () => {
        const disabledReason = clearWorkspaceDisabledReason.value;
        if (disabledReason) {
            notify.warning(disabledReason);
            return;
        }
        closeClearWorkspaceConfirm();
        let confirmHandle = null;
        confirmHandle = dialog.confirm({
            title: '清空 YANG 工作区',
            content:
                '将永久删除当前 Profile 工作区内已下载和已导入的 YANG 托管副本，并清除编译上下文、Schema 索引和编译诊断。外部导入目录中的原始文件不会被删除。此操作不可恢复。',
            okText: '清空',
            okType: 'danger',
            onCancel: () => {
                if (clearWorkspaceConfirmHandle === confirmHandle) clearWorkspaceConfirmHandle = null;
            },
            onOk: async () => {
                const disabledReason = clearWorkspaceDisabledReason.value;
                if (disabledReason) {
                    notify.warning(disabledReason);
                    return;
                }
                const profileId = selectedProfileId.value;
                const requestRevision = profileRequestRevision;
                const clearRequestRevision = ++clearWorkspaceRequestRevision;
                clearingWorkspace.value = true;
                try {
                    await invokeBridge('yangApi', 'clearWorkspace', { profileId });
                    if (!profileRequestMatches(profileId, requestRevision)) return;
                    profileRequestRevision += 1;
                    const refreshedRequestRevision = profileRequestRevision;
                    resetClearedWorkspaceState();
                    await loadModules();
                    if (!profileRequestMatches(profileId, refreshedRequestRevision)) return;
                    EventBus.emit(YANG_EVENT.PROFILE_DATA_REFRESH, {
                        profileId,
                        reason: 'workspace-cleared',
                        sourcePageId: YANG_EVENT_PAGE_ID.MODULES,
                        profileChanged: false
                    });
                    notify.success('YANG 工作区已清空，本地托管副本已删除');
                } catch (error) {
                    if (profileRequestMatches(profileId, requestRevision)) {
                        notify.error(`清空失败：${error.message}`);
                    }
                } finally {
                    if (clearRequestRevision === clearWorkspaceRequestRevision) clearingWorkspace.value = false;
                    if (clearWorkspaceConfirmHandle === confirmHandle) clearWorkspaceConfirmHandle = null;
                }
            }
        });
        clearWorkspaceConfirmHandle = confirmHandle;
    };

    const openSource = async module => {
        const requestRevision = ++sourceRequestRevision;
        sourceModule.value = module;
        sourceDrawerOpen.value = true;
        sourceLoading.value = true;
        sourceText.value = '';
        try {
            const { data } = await invokeBridge('yangApi', 'getModuleSource', {
                profileId: selectedProfileId.value,
                ...moduleIdentity(module)
            });
            if (requestRevision === sourceRequestRevision) {
                sourceText.value = typeof data === 'string' ? data : data?.source || data?.content || '';
            }
        } catch (error) {
            if (requestRevision === sourceRequestRevision) {
                sourceText.value = `// 读取源码失败：${error.message}`;
            }
        } finally {
            if (requestRevision === sourceRequestRevision) sourceLoading.value = false;
        }
    };

    const diagnosticColor = severity => {
        if (severity === 'success') return 'success';
        if (['error', 'fatal'].includes(severity)) return 'error';
        if (['warning', 'warn'].includes(severity)) return 'warning';
        return 'blue';
    };

    const diagnosticLabel = severity => {
        if (severity === 'success') return '成功';
        if (['error', 'fatal'].includes(severity)) return '错误';
        if (['warning', 'warn'].includes(severity)) return '警告';
        return '信息';
    };

    const formatDiagnosticLocation = diagnostic => {
        const location = diagnostic?.fileName || diagnostic?.file || diagnostic?.module || '';
        if (!location) return '';
        if (!diagnostic?.line) return location;
        return `${location}:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''}`;
    };

    const formatCompileTime = value => {
        const timestamp = Date.parse(value);
        return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : String(value || '-');
    };

    const flushLiveCompileLogs = () => {
        liveCompileLogFrame = 0;
        liveCompileLogs.value = [...pendingLiveCompileLogs.values()].reverse();
        if (pendingCompileProgress) {
            taskProgress.value = pendingCompileProgress;
            pendingCompileProgress = null;
        }
    };

    const scheduleLiveCompileLogFlush = () => {
        if (liveCompileLogFrame) return;
        liveCompileLogFrame = window.requestAnimationFrame(flushLiveCompileLogs);
    };

    const clearLiveCompileLogs = ({ keepTaskId = false } = {}) => {
        if (liveCompileLogFrame) {
            window.cancelAnimationFrame(liveCompileLogFrame);
            liveCompileLogFrame = 0;
        }
        pendingLiveCompileLogs.clear();
        pendingCompileProgress = null;
        liveCompileLogs.value = [];
        compileLogPage.value = 1;
        if (!keepTaskId) liveCompileTaskId = '';
    };

    const compileProgressCountText = data => {
        const completed = Number(data?.completed);
        const total = Number(data?.total);
        return Number.isFinite(completed) && Number.isFinite(total) && total > 0 ? `${completed}/${total}` : '';
    };

    const compileProgressPercentText = data => {
        const percent = Number(data?.percent);
        return Number.isFinite(percent) ? `${Math.round(percent)}%` : '';
    };

    const compileProgressDiagnostic = data => {
        const candidates = [
            data?.diagnostic,
            ...(Array.isArray(data?.diagnostics) ? data.diagnostics : []),
            ...(Array.isArray(data?.error?.details?.diagnostics) ? data.error.details.diagnostics : [])
        ].filter(Boolean);
        return (
            candidates.find(diagnostic => ['error', 'fatal'].includes(String(diagnostic.severity).toLowerCase())) ||
            candidates[0] ||
            null
        );
    };

    const compileFailureMessage = (data, { includeMessage = true } = {}) =>
        String(
            compileProgressDiagnostic(data)?.message ||
                data?.reason ||
                data?.error?.message ||
                (includeMessage ? data?.message : '') ||
                ''
        ).trim();

    const queueCompileProgressLog = data => {
        const taskId = getTaskId(data);
        if (taskId && liveCompileTaskId && taskId !== liveCompileTaskId) clearLiveCompileLogs();
        if (taskId) liveCompileTaskId = taskId;

        const phase = String(data?.phase || data?.status || 'preparing');
        const countText = compileProgressCountText(data);
        const percentText = compileProgressPercentText(data);
        const phaseLabel =
            phase === 'failed'
                ? compileFailureMessage(data) || COMPILE_PHASE_LABELS.failed
                : COMPILE_PHASE_LABELS[phase] || data?.message || '正在编译 YANG';
        const phaseSeverity = phase === 'failed' ? 'error' : phase === 'completed' ? 'success' : 'info';
        const phaseKey = `phase:${phase}`;
        pendingLiveCompileLogs.delete(phaseKey);
        pendingLiveCompileLogs.set(phaseKey, {
            id: `compile-progress:${taskId || 'pending'}:${phaseKey}`,
            severity: phaseSeverity,
            progressKind: 'phase',
            message: [phaseLabel, countText, percentText].filter(Boolean).join(' · ')
        });

        const currentFile = String(data?.currentFile || data?.fileName || '');
        if (currentFile) {
            let fileStatus = String(data?.fileStatus || '');
            if (!fileStatus && phase === 'parsing') fileStatus = 'parsed';
            if (!fileStatus && phase === 'file-validation') {
                fileStatus = /fail|error/u.test(String(data?.message || '').toLowerCase()) ? 'failed' : 'compiled';
            }
            const fileName = fileBaseName(currentFile) || currentFile;
            const fileIdentity = String(data?.currentHash || data?.hash || currentFile || data?.completed || fileName);
            const fileKey = `file:${fileIdentity}`;
            const failed = fileStatus === 'failed';
            const compiled = fileStatus === 'compiled';
            const actionLabel = compiled ? '编译成功' : failed ? '编译失败' : '解析完成';
            const fileDiagnostic = failed ? compileProgressDiagnostic(data) : null;
            const failureReason = failed ? compileFailureMessage(data, { includeMessage: false }) : '';
            pendingLiveCompileLogs.delete(fileKey);
            pendingLiveCompileLogs.set(fileKey, {
                id: `compile-progress:${taskId || 'pending'}:${fileKey}`,
                severity: compiled ? 'success' : failed ? 'error' : 'info',
                fileStatus,
                file: currentFile,
                fileName,
                code: fileDiagnostic?.code,
                line: fileDiagnostic?.line,
                column: fileDiagnostic?.column,
                progressKind: 'file',
                message: `${fileName} ${actionLabel}${failureReason ? `：${failureReason}` : ''}${countText ? ` · ${countText}` : ''}`
            });
        }
        scheduleLiveCompileLogFlush();
    };

    const beginCompileLog = targets => {
        clearLiveCompileLogs();
        diagnosticFilter.value = 'all';
        queueCompileProgressLog({
            phase: 'queued',
            completed: 0,
            total: targets.length,
            percent: 0
        });
    };

    const handleTaskProgress = payload => {
        if (payload?.status === 'error') return;
        const data = payload?.status === 'success' ? payload.data : payload?.data || payload;
        if (!data || typeof data !== 'object') return;
        if (!taskMatchesProfile(data, selectedProfileId.value)) return;
        const taskId = getTaskId(data);
        const actionFromPayload = data.action || data.taskType || data.kind || data.type || '';
        const action =
            Object.entries(activeTasks.value).find(([_key, value]) => value && value === taskId)?.[0] ||
            actionFromPayload;
        if (!['discover', 'download', 'import', 'compile'].includes(action)) return;
        if (action === 'compile') {
            pendingCompileProgress = { ...data, action };
            queueCompileProgressLog(data);
            if (!isTaskTerminal(data.phase || data.status)) compiling.value = true;
        } else taskProgress.value = { ...data, action };
        if (!isTaskTerminal(data.phase || data.status)) return;

        activeTasks.value[action] = '';
        if (action === 'discover') discovering.value = false;
        if (action === 'import') importing.value = false;
        if (action === 'compile') compiling.value = false;
        const taskFailed = (data.phase || data.status) === 'failed';
        if (action === 'download') {
            deviceDownloadTerminalHandled.value = true;
            if (taskFailed || (data.phase || data.status) === 'cancelled') {
                downloading.value = false;
                deviceModuleError.value =
                    data.message || data.error?.message || (taskFailed ? '模型或依赖下载失败' : '模型下载已取消');
                Promise.all([loadModules(), loadCompileContext({ quiet: true })]);
            } else {
                finishDeviceDownload(data.result || {}, selectedProfileId.value, profileRequestRevision);
            }
        }
        if (action === 'compile' && taskFailed) {
            refreshCompilerStatus({ force: true });
            const failureMessage = compileFailureMessage(data) || '编译失败';
            modules.value.forEach(module => {
                if (module.compileStatus === 'compiling') {
                    module.compileStatus = 'failed';
                    module.compileMessage = failureMessage;
                }
            });
        }
        if (!['download', 'compile'].includes(action) && (data.phase || data.status) === 'failed') {
            notify.error(data.message || data.error?.message || 'YANG 任务失败');
        }
        if (action !== 'download') {
            const refresh = Promise.all([
                loadModules(),
                action === 'compile' ? loadDiagnostics({ quiet: true }) : loadCompileContext({ quiet: true })
            ]);
            if (action === 'compile') {
                const completedTaskId = taskId;
                refresh.then(([_modulesResult, diagnosticResult]) => {
                    const hasReplacementDiagnostics =
                        diagnosticResult?.loaded === true && (!taskFailed || diagnosticResult.count > 0);
                    if (hasReplacementDiagnostics && (!completedTaskId || liveCompileTaskId === completedTaskId)) {
                        clearLiveCompileLogs();
                    }
                });
            }
        }
        window.setTimeout(() => {
            if (taskProgress.value && getTaskId(taskProgress.value) === taskId) taskProgress.value = null;
        }, 4000);
    };

    const handleSessionEvent = payload => {
        const data = normalizeSessionEvent(payload);
        const status = data?.status || data?.state;
        const isConnected = data?.connected === true || status === NETCONF_SESSION_STATUS.CONNECTED;
        if (data?.profileId && data.profileId !== selectedProfileId.value) return;
        connected.value = isConnected;
    };

    const handleProfileDataRefresh = payload => {
        const profileId = String(payload?.profileId || '');
        if (!profileId) return;
        if (profileId !== selectedProfileId.value) return;
        if (payload?.reason === 'workspace-cleared' && payload?.sourcePageId === YANG_EVENT_PAGE_ID.MODULES) return;
        if (profileContextReady) void reloadCurrentProfile();
    };

    const resetProfileState = () => {
        closeClearWorkspaceConfirm();
        profileRequestRevision += 1;
        diagnosticRequestRevision += 1;
        compileContextRequestRevision += 1;
        clearWorkspaceRequestRevision += 1;
        sourceRequestRevision += 1;
        modules.value = [];
        selectedKeys.value = [];
        modulePage.value = 1;
        deviceModules.value = [];
        deviceSelectedKeys.value = [];
        deviceModuleQuery.value = '';
        deviceModulePage.value = 1;
        deviceModuleError.value = '';
        deviceDownloadFailures.value = [];
        deviceDownloadTerminalHandled.value = false;
        diagnostics.value = [];
        clearLiveCompileLogs();
        compileContext.value = { compileId: '', success: null, compiledAt: null, summary: {}, modules: [] };
        connected.value = false;
        activeTasks.value = { discover: '', download: '', import: '', compile: '' };
        taskProgress.value = null;
        loading.value = false;
        discovering.value = false;
        downloading.value = false;
        importing.value = false;
        compiling.value = false;
        diagnosticLoading.value = false;
        clearingWorkspace.value = false;
        sourceLoading.value = false;
        deviceModuleModalOpen.value = false;
        sourceDrawerOpen.value = false;
        sourceModule.value = null;
        sourceText.value = '';
    };

    const reloadCurrentProfile = () => Promise.all([loadModules(), loadSession(), loadDiagnostics({ quiet: true })]);

    watch(selectedProfileId, (profileId, previousProfileId) => {
        if (profileId === previousProfileId) return;
        resetProfileState();
        if (profileContextReady) reloadCurrentProfile();
    });

    watch([query, statusFilter], () => {
        modulePage.value = 1;
    });

    watch(modulePageCount, pageCount => {
        if (modulePage.value > pageCount) modulePage.value = pageCount;
    });

    watch(deviceModuleQuery, () => {
        deviceModulePage.value = 1;
    });

    watch(diagnosticFilter, () => {
        compileLogPage.value = 1;
    });

    watch(compileLogPageCount, pageCount => {
        if (compileLogPage.value > pageCount) compileLogPage.value = pageCount;
    });

    onMounted(async () => {
        EventBus.on(YANG_EVENT.TASK_PROGRESS, YANG_EVENT_PAGE_ID.MODULES, handleTaskProgress);
        EventBus.on(YANG_EVENT.SESSION_EVENT, `${YANG_EVENT_PAGE_ID.MODULES}-session`, handleSessionEvent);
        EventBus.on(
            YANG_EVENT.PROFILE_DATA_REFRESH,
            `${YANG_EVENT_PAGE_ID.MODULES}-profile-data`,
            handleProfileDataRefresh
        );
        await refreshProfiles();
        profileContextReady = true;
        await Promise.all([reloadCurrentProfile(), refreshCompilerStatus()]);
    });

    onDeactivated(() => {
        closeClearWorkspaceConfirm();
        stopCompileLogResize();
        diagnosticRequestRevision += 1;
        compileContextRequestRevision += 1;
        sourceRequestRevision += 1;
        diagnosticLoading.value = false;
        sourceLoading.value = false;
        deviceModuleModalOpen.value = false;
        sourceDrawerOpen.value = false;
    });

    onBeforeUnmount(() => {
        closeClearWorkspaceConfirm();
        clearLiveCompileLogs();
        EventBus.off(YANG_EVENT.TASK_PROGRESS, YANG_EVENT_PAGE_ID.MODULES);
        EventBus.off(YANG_EVENT.SESSION_EVENT, `${YANG_EVENT_PAGE_ID.MODULES}-session`);
        EventBus.off(YANG_EVENT.PROFILE_DATA_REFRESH, `${YANG_EVENT_PAGE_ID.MODULES}-profile-data`);
    });
</script>

<style scoped>
    .yang-modules-page,
    .modules-card {
        height: 100%;
        min-height: 0;
    }

    .modules-card {
        display: flex;
        flex-direction: column;
    }

    .modules-card :deep(.nn-card-body) {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
    }

    .module-toolbar {
        margin-bottom: 8px;
    }

    .module-toolbar-row,
    .module-actions {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .module-toolbar-row {
        min-width: 0;
        min-height: 32px;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 8px 12px;
    }

    .module-refresh-action {
        width: 88px;
        flex: 0 0 88px;
    }

    .module-actions {
        flex: none;
        min-width: 0;
        min-height: 32px;
        flex-wrap: wrap;
        justify-content: flex-end;
    }

    .module-action-button {
        width: 112px;
        flex: 0 0 112px;
    }

    .module-action-device,
    .module-action-device-wrap {
        width: 136px;
        flex-basis: 136px;
    }

    .module-action-clear,
    .module-action-clear-wrap {
        width: 136px;
        flex-basis: 136px;
    }

    .module-action-standard-wrap {
        width: 112px;
        flex-basis: 112px;
    }

    .disabled-action-wrap {
        display: inline-flex;
        flex: none;
    }

    .selection-row {
        display: flex;
        container: module-selection / inline-size;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        min-height: 42px;
        padding: 4px 8px;
        border: 1px solid var(--nn-color-border-light);
        border-bottom: 0;
        border-radius: 6px 6px 0 0;
        background: var(--nn-color-bg-muted);
    }

    .selection-filters {
        display: flex;
        width: min(498px, 100%);
        min-width: 0;
        flex: 0 1 498px;
        align-items: center;
        gap: 8px;
    }

    .selection-search {
        width: 340px;
        min-width: 220px;
        flex: 0 1 340px;
    }

    .selection-status {
        width: 150px;
        flex: 0 0 150px;
    }

    .selection-search :deep(.module-search),
    .selection-status :deep(.compact-select) {
        width: 100%;
    }

    .module-results-layout {
        display: grid;
        min-height: 0;
        flex: 1;
        grid-template-rows:
            minmax(220px, 1fr) 8px
            var(--compile-log-preview-height, var(--compile-log-height, 190px));
        overflow: hidden;
    }

    .module-table,
    .module-table :deep(.nn-spin-nested-loading),
    .module-table :deep(.nn-spin-container) {
        height: 100%;
        min-height: 0;
    }

    .module-table {
        overflow: hidden;
    }

    .module-table :deep(.nn-spin-container),
    .module-table :deep(.nn-table),
    .module-table :deep(.nn-table-container) {
        display: flex;
        min-height: 0;
        flex-direction: column;
    }

    .module-table :deep(.nn-table),
    .module-table :deep(.nn-table-container),
    .module-table :deep(.nn-table-content) {
        min-height: 0;
        flex: 1 1 0;
    }

    .module-table :deep(.nn-table-content) {
        max-height: none !important;
        overflow: auto;
    }

    .module-results-resizing .module-table :deep(.nn-table-content),
    .module-results-resizing .compile-log-list {
        content-visibility: hidden;
        pointer-events: none;
    }

    .module-name-cell {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 5px;
    }

    .module-name,
    .ellipsis-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .module-name {
        color: var(--nn-color-text-strong);
        font-weight: 500;
    }

    .mono-text {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
    }

    .device-module-dialog {
        display: flex;
        min-height: min(560px, calc(100vh - 190px));
        flex-direction: column;
        gap: 10px;
    }

    .device-module-toolbar,
    .device-module-selection-row,
    .device-module-footer,
    .device-download-progress {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
    }

    .device-module-toolbar {
        flex-wrap: wrap;
    }

    .device-module-search {
        width: min(420px, 100%);
    }

    .device-module-message {
        flex: none;
    }

    .device-module-selection-row {
        min-height: 34px;
        padding: 5px 8px;
        border: 1px solid var(--nn-color-border-light);
        border-bottom: 0;
        border-radius: 6px 6px 0 0;
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text-muted);
        font-size: 11px;
        white-space: nowrap;
    }

    .device-module-table {
        min-height: 0;
        flex: 1;
        margin-top: -10px;
    }

    .device-download-progress {
        padding: 8px 10px;
        border: 1px solid var(--nn-color-border-info);
        border-radius: 6px;
        background: var(--nn-color-bg-info-subtle);
        color: var(--nn-color-text-info);
        font-size: 12px;
    }

    .device-module-footer {
        width: 100%;
    }

    .device-module-footer > span {
        color: var(--nn-color-text-muted);
        font-size: 11px;
        text-align: left;
    }

    .compile-log-resizer {
        display: flex;
        min-height: 8px;
        align-items: center;
        justify-content: center;
        cursor: row-resize;
        outline: none;
        touch-action: none;
        user-select: none;
    }

    .compile-log-resizer .pane-resizer-grip {
        width: 34px;
        height: 2px;
        border-radius: 999px;
        background: var(--nn-color-border-light);
        transition:
            height 0.15s ease,
            background-color 0.15s ease;
    }

    .compile-log-resizer:hover .pane-resizer-grip,
    .compile-log-resizer:focus-visible .pane-resizer-grip,
    .module-results-resizing .compile-log-resizer .pane-resizer-grip {
        height: 3px;
        background: var(--nn-color-primary);
    }

    .compile-log-panel {
        display: flex;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
        contain: layout paint;
    }

    .compile-log-header,
    .compile-log-context,
    .compile-log-actions {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 8px;
    }

    .compile-log-header {
        min-height: 42px;
        flex: none;
        justify-content: space-between;
        padding: 5px 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }

    .compile-log-context {
        flex: 1;
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .compile-log-actions {
        flex: none;
        justify-content: flex-end;
    }

    .compile-log-title {
        flex: none;
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
    }

    .compile-log-time,
    .compile-log-summary,
    .compile-log-progress {
        flex: none;
        color: var(--nn-color-text-muted);
        font-size: 11px;
        white-space: nowrap;
    }

    .compile-log-id {
        min-width: 0;
        max-width: 240px;
        overflow: hidden;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .compile-log-list {
        min-height: 0;
        flex: 1;
        overflow-y: auto;
    }

    .compile-log-row {
        display: flex;
        width: 100%;
        align-items: flex-start;
        gap: 8px;
        padding: 5px 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
        color: var(--nn-color-text);
        font-size: 12px;
        line-height: 18px;
        content-visibility: auto;
        contain: layout paint style;
        contain-intrinsic-size: auto 29px;
    }

    .compile-log-row:last-child {
        border-bottom: 0;
    }

    .compile-log-content {
        display: flex;
        min-width: 0;
        flex: 1;
        flex-direction: column;
    }

    .compile-log-message {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }

    .compile-log-location {
        margin-top: 1px;
        color: var(--nn-color-text-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        line-height: 15px;
    }

    .compile-log-context :deep(.nn-tag),
    .compile-log-row :deep(.nn-tag) {
        margin-inline-end: 0;
    }

    .compile-log-pagination {
        display: flex;
        min-height: 34px;
        flex: none;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 3px 8px;
        border-top: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text-muted);
        font-size: 11px;
        white-space: nowrap;
    }

    .compile-log-pagination :deep(.nn-button) {
        min-width: 28px;
        padding-inline: 7px;
    }

    .source-preview {
        min-height: calc(100vh - 160px);
        margin: 0;
        padding: 12px;
        overflow: auto;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-code);
        color: var(--nn-color-text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        line-height: 1.6;
        white-space: pre;
    }

    @container module-selection (max-width: 600px) {
        .selection-filters {
            width: 100%;
            flex-basis: 100%;
        }

        .selection-search {
            flex: 1 1 auto;
        }
    }

    @container module-selection (max-width: 390px) {
        .selection-filters {
            align-items: stretch;
            flex-direction: column;
        }

        .selection-search,
        .selection-status {
            width: 100%;
            min-width: 0;
            flex-basis: auto;
        }
    }

    @media (max-width: 1100px) {
        .module-toolbar-row {
            align-items: flex-start;
            flex-direction: column;
        }

        .module-toolbar-row,
        .module-actions {
            width: 100%;
        }

        .module-actions {
            justify-content: flex-start;
        }

        .compile-log-id {
            display: none;
        }

        .device-module-selection-row,
        .device-module-footer {
            align-items: flex-start;
            flex-direction: column;
        }
    }

    @media (max-width: 720px) {
        .compile-log-time {
            display: none;
        }
    }
</style>
