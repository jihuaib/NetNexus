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
                <div class="module-profile-row" data-testid="yang-modules-profile-row">
                    <YangProfileField
                        :value="selectedProfileId"
                        :options="profileOptions"
                        :loading="profilesLoading"
                        test-id="yang-modules-profile-select"
                        @update:value="selectProfile"
                    />
                    <nn-button class="module-refresh-action" :loading="loading" @click="loadModules">
                        <template #icon><ReloadOutlined /></template>
                        刷新
                    </nn-button>
                </div>

                <div class="module-actions" data-testid="yang-modules-actions">
                    <nn-tooltip :title="connected ? '' : '请先在连接设置中建立 NETCONF 会话'">
                        <span class="disabled-action-wrap module-action-device-wrap">
                            <nn-button
                                class="module-action-button module-action-device"
                                :loading="discovering"
                                :disabled="!connected"
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
                        :disabled="!selectedProfileId"
                        @click="importFiles"
                    >
                        <template #icon><FileSearchOutlined /></template>
                        导入文件
                    </nn-button>
                    <nn-button
                        class="module-action-button"
                        :loading="importing"
                        :disabled="!selectedProfileId"
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
                    <nn-button
                        class="module-action-button module-action-diagnostics"
                        :loading="diagnosticLoading"
                        @click="openDiagnostics"
                    >
                        <template #icon><FileSearchOutlined /></template>
                        编译诊断 ({{ diagnosticCountHint }})
                    </nn-button>
                </div>
            </div>

            <div class="selection-row">
                <nn-checkbox
                    :checked="allVisibleSelected"
                    :indeterminate="someVisibleSelected"
                    :disabled="filteredModules.length === 0"
                    @change="toggleAllVisible"
                >
                    选择当前筛选结果
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

            <nn-table
                :columns="columns"
                :data-source="filteredModules"
                :loading="loading"
                :pagination="false"
                :scroll="{ x: 990, y: 'calc(100vh - 350px)' }"
                row-key="_key"
                size="small"
                class="module-table"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'selection'">
                        <nn-checkbox
                            :checked="selectedKeys.includes(record._key)"
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
                        选择当前结果中未下载的模型
                    </nn-checkbox>
                    <span>
                        显示 {{ filteredDeviceModules.length }}，选择 {{ selectedDeviceModules.length }} 个根模型
                    </span>
                </div>

                <nn-table
                    :columns="deviceModuleColumns"
                    :data-source="filteredDeviceModules"
                    :loading="discovering"
                    :pagination="false"
                    :scroll="{ x: 860, y: 'min(48vh, 430px)' }"
                    row-key="_key"
                    size="small"
                    class="device-module-table"
                >
                    <template #bodyCell="{ column, record }">
                        <template v-if="column.key === 'selection'">
                            <nn-checkbox
                                :checked="deviceSelectedKeys.includes(record._key)"
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
                            <nn-tag v-else-if="!isYangDeviceModule(record)" color="warning">不支持 {{ record.format }}</nn-tag>
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

        <nn-modal
            v-model:open="diagnosticModalOpen"
            title="编译诊断"
            :footer="null"
            width="900px"
            :body-style="{ padding: '12px', overflow: 'hidden' }"
        >
            <div class="diagnostic-context-bar">
                <div class="diagnostic-context-main">
                    <nn-tag :color="compileContextColor">{{ compileContextLabel }}</nn-tag>
                    <span v-if="compileContext.compiledAt">{{ formatCompileTime(compileContext.compiledAt) }}</span>
                    <span
                        v-if="compileContext.compileId"
                        class="diagnostic-compile-id"
                        :title="compileContext.compileId"
                    >
                        {{ compileContext.compileId }}
                    </span>
                </div>
                <nn-button size="small" :loading="diagnosticLoading" @click="loadDiagnostics">刷新</nn-button>
            </div>

            <div v-if="compileContext.compileId" class="diagnostic-filter-bar">
                <nn-segmented v-model:value="diagnosticFilter" :options="diagnosticFilterOptions" />
                <span>错误 {{ diagnosticErrorCount }} · 警告 {{ diagnosticWarningCount }}</span>
            </div>

            <div class="diagnostic-list">
                <nn-spin :spinning="diagnosticLoading">
                    <nn-empty v-if="!compileContext.compileId" description="请先选择本地模型并执行“编译所选”" />
                    <template v-else>
                        <div
                            v-for="(diagnostic, index) in filteredDiagnostics"
                            :key="diagnostic.id || `${diagnostic.file || ''}:${diagnostic.line || 0}:${index}`"
                            class="diagnostic-row"
                        >
                            <nn-tag :color="diagnosticColor(diagnostic.severity)">
                                {{ diagnosticLabel(diagnostic.severity) }}
                            </nn-tag>
                            <span class="diagnostic-content">
                                <span class="diagnostic-message">
                                    {{ diagnostic.message || diagnostic.msg || '未知诊断' }}
                                </span>
                                <span class="diagnostic-location">
                                    {{ formatDiagnosticLocation(diagnostic) }}
                                </span>
                            </span>
                            <nn-button
                                v-if="moduleForDiagnostic(diagnostic)"
                                size="small"
                                @click="openDiagnosticSource(diagnostic)"
                            >
                                查看源码
                            </nn-button>
                        </div>
                        <nn-empty v-if="filteredDiagnostics.length === 0" description="当前筛选下没有编译诊断" />
                    </template>
                </nn-spin>
            </div>
        </nn-modal>
    </div>
</template>

<script setup>
    import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
    import {
        NETCONF_SESSION_STATUS,
        YANG_EVENT,
        YANG_EVENT_PAGE_ID,
        YANG_MODULE_STATUS_META
    } from '../../const/yangConst';
    import EventBus from '../../utils/eventBus';
    import { notify } from '../../utils/notify';
    import {
        CloudDownloadOutlined,
        CodeOutlined,
        FileSearchOutlined,
        FolderOpenOutlined,
        LoadingOutlined,
        ReloadOutlined,
        SearchOutlined
    } from '../../ui/icons';
    import YangProfileField from './YangProfileField.vue';
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

    const modules = ref([]);
    const selectedKeys = ref([]);
    const query = ref('');
    const statusFilter = ref('all');
    const deviceModuleModalOpen = ref(false);
    const deviceModules = ref([]);
    const deviceSelectedKeys = ref([]);
    const deviceModuleQuery = ref('');
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
    const diagnosticModalOpen = ref(false);
    const diagnosticLoading = ref(false);
    const diagnostics = ref([]);
    const diagnosticFilter = ref('all');
    const diagnosticLoadedCompileId = ref('');
    const compileContext = ref({ compileId: '', success: null, compiledAt: null, summary: {} });
    let diagnosticRequestRevision = 0;
    let compileContextRequestRevision = 0;
    let sourceRequestRevision = 0;
    let profileRequestRevision = 0;
    let profileContextReady = false;
    const { compilerAvailable, refreshCompilerStatus } = useYangCompilerStatus();
    const {
        profilesLoading,
        selectedProfileId,
        profileOptions,
        refreshProfiles,
        selectProfile,
        taskMatchesProfile
    } = useYangProfileContext();
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
    const deviceSelectableVisibleModules = computed(() =>
        filteredDeviceModules.value.filter(canDownloadDeviceModule)
    );
    const selectedDeviceModules = computed(() =>
        deviceModules.value.filter(
            module => deviceSelectedKeys.value.includes(module._key) && canDownloadDeviceModule(module)
        )
    );
    const allVisibleDeviceModulesSelected = computed(
        () =>
            deviceSelectableVisibleModules.value.length > 0 &&
            deviceSelectableVisibleModules.value.every(module => deviceSelectedKeys.value.includes(module._key))
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
        const count = Number(progress.total || 0)
            ? `${Number(progress.completed || 0)}/${Number(progress.total)}`
            : '';
        return [progress.module || progress.message || '正在下载模型及其依赖', count].filter(Boolean).join(' · ');
    });
    const allVisibleSelected = computed(
        () =>
            filteredModules.value.length > 0 &&
            filteredModules.value.every(module => selectedKeys.value.includes(module._key))
    );
    const someVisibleSelected = computed(
        () =>
            !allVisibleSelected.value &&
            filteredModules.value.some(module => selectedKeys.value.includes(module._key))
    );
    const selectedModules = computed(() => modules.value.filter(module => selectedKeys.value.includes(module._key)));
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
    const diagnosticCountHint = computed(() => {
        if (!compileContext.value.compileId) return 0;
        if (diagnosticLoadedCompileId.value === compileContext.value.compileId) return diagnostics.value.length;
        return Number(compileContext.value.summary?.errors || 0) + Number(compileContext.value.summary?.warnings || 0);
    });
    const compileContextColor = computed(() => {
        if (!compileContext.value.compileId) return 'default';
        return compileContext.value.success === true ? 'success' : 'error';
    });
    const compileContextLabel = computed(() => {
        if (!compileContext.value.compileId) return '尚未编译';
        return compileContext.value.success === true ? '编译成功' : '编译失败';
    });
    const filteredDiagnostics = computed(() => {
        if (diagnosticFilter.value === 'all') return diagnostics.value;
        if (diagnosticFilter.value === 'error') {
            return diagnostics.value.filter(item => ['error', 'fatal'].includes(item.severity));
        }
        if (diagnosticFilter.value === 'warning') {
            return diagnostics.value.filter(item => ['warning', 'warn'].includes(item.severity));
        }
        return diagnostics.value.filter(item => !['error', 'fatal', 'warning', 'warn'].includes(item.severity));
    });
    const compileDisabledReason = computed(() => {
        if (!selectedProfileId.value) return '请先选择连接 Profile';
        if (!compilerAvailable.value) return 'YANG 编译暂不可用，请在“设置 → 运行时诊断”中检查';
        if (selectedLocalModules.value.length === 0) return '请先选择已下载或已导入的本地模块';
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

    const toggleAllVisible = event => {
        const keys = filteredModules.value.map(module => module._key);
        if (event.target.checked) selectedKeys.value = [...new Set([...selectedKeys.value, ...keys])];
        else selectedKeys.value = selectedKeys.value.filter(key => !keys.includes(key));
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
        else deviceSelectedKeys.value = deviceSelectedKeys.value.filter(key => !keys.includes(key));
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
            summary: workspace.summary || {}
        };
    };

    const applyCompileContext = context => {
        if (!context.compileId || context.compileId !== compileContext.value.compileId) {
            diagnostics.value = [];
            diagnosticLoadedCompileId.value = '';
            diagnosticFilter.value = 'all';
        }
        compileContext.value = context;
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
        diagnosticLoading.value = true;
        try {
            const context = await fetchCompileContext(profileId);
            if (
                requestRevision !== diagnosticRequestRevision ||
                contextRequestRevision !== compileContextRequestRevision ||
                profileRevision !== profileRequestRevision ||
                profileId !== selectedProfileId.value
            ) {
                return;
            }
            applyCompileContext(context);
            if (!context.compileId) return;
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
                return;
            }
            const confirmedContext = await fetchCompileContext(profileId);
            if (
                requestRevision !== diagnosticRequestRevision ||
                contextRequestRevision !== compileContextRequestRevision
            ) {
                return;
            }
            applyCompileContext(confirmedContext);
            if (confirmedContext.compileId !== context.compileId) return;
            diagnostics.value = unwrapArray(data, ['diagnostics', 'items']).map(normalizeDiagnostic);
            diagnosticLoadedCompileId.value = context.compileId;
        } catch (error) {
            const requestIsCurrent =
                requestRevision === diagnosticRequestRevision &&
                contextRequestRevision === compileContextRequestRevision;
            if (requestIsCurrent && requestedCompileId) {
                diagnostics.value = [];
                diagnosticLoadedCompileId.value = '';
                try {
                    const latestContext = await fetchCompileContext(profileId);
                    if (
                        requestRevision === diagnosticRequestRevision &&
                        contextRequestRevision === compileContextRequestRevision
                    ) {
                        applyCompileContext(latestContext);
                    }
                } catch (_contextError) {
                    // Keep the last known compile context while ensuring stale diagnostic rows are not displayed.
                }
            }
            if (
                requestRevision === diagnosticRequestRevision &&
                contextRequestRevision === compileContextRequestRevision &&
                !quiet
            ) {
                notify.error(`加载编译诊断失败：${error.message}`);
            }
        } finally {
            if (requestRevision === diagnosticRequestRevision) diagnosticLoading.value = false;
        }
    };

    const openDiagnostics = () => {
        diagnosticModalOpen.value = true;
        loadDiagnostics();
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
            notify.warning(`已下载可用模型，但有 ${deviceDownloadFailures.value.length} 个模型或依赖失败`);
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
                method === 'importFiles'
                    ? { profileId, filePaths: target }
                    : { profileId, directoryPath: target };
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
            notify.error(`编译失败：${error.message}`);
        }
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

    const moduleForDiagnostic = diagnostic => {
        const localModules = modules.value.filter(module => module.isLocal);
        const moduleId = diagnostic?.moduleId;
        if (moduleId) {
            const idMatch = localModules.find(module =>
                [module.id, module.moduleId, module.hash].filter(Boolean).includes(moduleId)
            );
            if (idMatch) return idMatch;
        }

        const sourceValues = [diagnostic?.source, diagnostic?.file, diagnostic?.filePath, diagnostic?.fileName]
            .filter(Boolean)
            .map(String);
        const exactPathMatch = localModules.find(module =>
            [module.filePath, module.path, module.localPath].filter(Boolean).some(value => sourceValues.includes(value))
        );
        if (exactPathMatch) return exactPathMatch;

        const sourceFileNames = new Set(sourceValues.map(fileBaseName));
        const fileMatches = localModules.filter(module => {
            const canonicalName = `${module.name}${module.revision ? `@${module.revision}` : ''}.yang`;
            const hashSuffixName = module.hash
                ? `${module.name}${module.revision ? `@${module.revision}` : ''}-${String(module.hash).slice(0, 12)}.yang`
                : '';
            return [
                module.fileName,
                fileBaseName(module.filePath),
                fileBaseName(module.path),
                fileBaseName(module.localPath),
                canonicalName,
                hashSuffixName
            ]
                .filter(Boolean)
                .some(value => sourceFileNames.has(value));
        });
        if (fileMatches.length === 1) return fileMatches[0];

        const namedMatches = localModules.filter(module => {
            const diagnosticModule = diagnostic?.module || diagnostic?.moduleName;
            const diagnosticRevision = diagnostic?.revision || diagnostic?.revisionDate;
            return diagnosticModule === module.name && (!diagnosticRevision || diagnosticRevision === module.revision);
        });
        return namedMatches.length === 1 ? namedMatches[0] : null;
    };

    const openDiagnosticSource = diagnostic => {
        const module = moduleForDiagnostic(diagnostic);
        if (!module) return;
        openSource(module);
    };

    const diagnosticColor = severity => {
        if (['error', 'fatal'].includes(severity)) return 'error';
        if (['warning', 'warn'].includes(severity)) return 'warning';
        return 'blue';
    };

    const diagnosticLabel = severity => {
        if (['error', 'fatal'].includes(severity)) return '错误';
        if (['warning', 'warn'].includes(severity)) return '警告';
        return '信息';
    };

    const formatDiagnosticLocation = diagnostic => {
        const location = diagnostic?.fileName || diagnostic?.file || diagnostic?.module || '-';
        if (!diagnostic?.line) return location;
        return `${location}:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''}`;
    };

    const formatCompileTime = value => {
        const timestamp = Date.parse(value);
        return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : String(value || '-');
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
        taskProgress.value = { ...data, action };
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
                if (taskFailed) notify.error(deviceModuleError.value);
                Promise.all([loadModules(), loadCompileContext({ quiet: true })]);
            } else {
                finishDeviceDownload(data.result || {}, selectedProfileId.value, profileRequestRevision);
            }
        }
        if (action === 'compile' && taskFailed) {
            refreshCompilerStatus({ force: true });
            modules.value.forEach(module => {
                if (module.compileStatus === 'compiling') {
                    module.compileStatus = 'failed';
                    module.compileMessage = data.message || data.error?.message || '编译失败';
                }
            });
        }
        if (action !== 'download' && (data.phase || data.status) === 'failed') {
            notify.error(data.message || data.error?.message || 'YANG 任务失败');
        }
        if (action !== 'download') {
            Promise.all([
                loadModules(),
                action === 'compile' ? loadDiagnostics({ quiet: true }) : loadCompileContext({ quiet: true })
            ]);
        }
        window.setTimeout(() => {
            if (taskProgress.value && getTaskId(taskProgress.value) === taskId) taskProgress.value = null;
        }, 4000);
    };

    const handleSessionEvent = payload => {
        const data = normalizeSessionEvent(payload);
        if (data?.profileId && data.profileId !== selectedProfileId.value) return;
        const status = data?.status || data?.state;
        connected.value = data?.connected === true || status === NETCONF_SESSION_STATUS.CONNECTED;
    };

    const resetProfileState = () => {
        profileRequestRevision += 1;
        diagnosticRequestRevision += 1;
        compileContextRequestRevision += 1;
        sourceRequestRevision += 1;
        modules.value = [];
        selectedKeys.value = [];
        deviceModules.value = [];
        deviceSelectedKeys.value = [];
        deviceModuleQuery.value = '';
        deviceModuleError.value = '';
        deviceDownloadFailures.value = [];
        deviceDownloadTerminalHandled.value = false;
        diagnostics.value = [];
        diagnosticLoadedCompileId.value = '';
        compileContext.value = { compileId: '', success: null, compiledAt: null, summary: {} };
        connected.value = false;
        activeTasks.value = { discover: '', download: '', import: '', compile: '' };
        taskProgress.value = null;
        loading.value = false;
        discovering.value = false;
        downloading.value = false;
        importing.value = false;
        compiling.value = false;
        diagnosticLoading.value = false;
        sourceLoading.value = false;
        deviceModuleModalOpen.value = false;
        diagnosticModalOpen.value = false;
        sourceDrawerOpen.value = false;
        sourceModule.value = null;
        sourceText.value = '';
    };

    const reloadCurrentProfile = () =>
        Promise.all([loadModules(), loadSession(), loadCompileContext({ quiet: true })]);

    watch(selectedProfileId, (profileId, previousProfileId) => {
        if (profileId === previousProfileId) return;
        resetProfileState();
        if (profileContextReady) reloadCurrentProfile();
    });

    onMounted(async () => {
        EventBus.on(YANG_EVENT.TASK_PROGRESS, YANG_EVENT_PAGE_ID.MODULES, handleTaskProgress);
        EventBus.on(YANG_EVENT.SESSION_EVENT, `${YANG_EVENT_PAGE_ID.MODULES}-session`, handleSessionEvent);
        await refreshProfiles();
        profileContextReady = true;
        await Promise.all([reloadCurrentProfile(), refreshCompilerStatus()]);
    });

    onActivated(async () => {
        await refreshProfiles();
        profileContextReady = true;
        await Promise.all([reloadCurrentProfile(), refreshCompilerStatus()]);
    });

    onDeactivated(() => {
        diagnosticRequestRevision += 1;
        compileContextRequestRevision += 1;
        sourceRequestRevision += 1;
        diagnosticLoading.value = false;
        sourceLoading.value = false;
        deviceModuleModalOpen.value = false;
        diagnosticModalOpen.value = false;
        sourceDrawerOpen.value = false;
    });

    onBeforeUnmount(() => {
        EventBus.off(YANG_EVENT.TASK_PROGRESS, YANG_EVENT_PAGE_ID.MODULES);
        EventBus.off(YANG_EVENT.SESSION_EVENT, `${YANG_EVENT_PAGE_ID.MODULES}-session`);
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
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 8px;
    }

    .module-profile-row,
    .module-actions {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .module-profile-row {
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
        min-height: 32px;
        flex-wrap: wrap;
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

    .module-action-diagnostics {
        width: 150px;
        flex-basis: 150px;
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

    .module-table {
        min-height: 0;
        flex: 1;
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

    .diagnostic-context-bar,
    .diagnostic-filter-bar,
    .diagnostic-context-main {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 8px;
    }

    .diagnostic-context-bar,
    .diagnostic-filter-bar {
        justify-content: space-between;
    }

    .diagnostic-context-bar {
        padding-bottom: 9px;
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .diagnostic-filter-bar {
        padding: 8px 0;
        border-top: 1px solid var(--nn-color-border-light);
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .diagnostic-compile-id {
        max-width: 360px;
        overflow: hidden;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .diagnostic-list {
        min-height: 240px;
        max-height: calc(100vh - 260px);
        overflow-y: auto;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
    }

    .diagnostic-row {
        display: flex;
        width: 100%;
        align-items: flex-start;
        gap: 8px;
        padding: 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
        color: var(--nn-color-text);
    }

    .diagnostic-row:last-child {
        border-bottom: 0;
    }

    .diagnostic-content {
        display: flex;
        min-width: 0;
        flex: 1;
        flex-direction: column;
    }

    .diagnostic-message {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }

    .diagnostic-location {
        margin-top: 2px;
        color: var(--nn-color-text-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
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
        .device-module-selection-row,
        .device-module-footer {
            align-items: flex-start;
            flex-direction: column;
        }
    }
</style>
