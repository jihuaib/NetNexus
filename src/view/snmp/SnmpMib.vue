<template>
    <div class="nn-container snmp-mib-page">
        <nn-card title="MIB 编译" class="mib-card">
            <template #extra>
                <nn-space wrap class="mib-status-group">
                    <nn-tag v-if="mibCompileLoading || showMibCompileProgress" color="processing">
                        {{ mibCompileProgressTag }}
                    </nn-tag>
                    <nn-tag v-else-if="statusLoading" color="processing">正在读取状态</nn-tag>
                    <nn-tag v-else-if="mibStatus.cacheHit" color="success">缓存命中</nn-tag>
                    <nn-tag color="blue">用户模块 {{ mibStatus.modules.length }}</nn-tag>
                    <nn-tag color="cyan">基础模块 {{ mibStatus.baseModules.length }}</nn-tag>
                    <nn-tag color="green">OID {{ mibStatus.totalObjects }}</nn-tag>
                    <nn-tag color="default">文件 {{ mibStatus.expandedFileCount }}</nn-tag>
                </nn-space>
            </template>

            <div class="mib-compiler">
                <div class="mib-toolbar">
                    <nn-button type="primary" :loading="mibCompileLoading" @click="selectMibFiles">
                        <template #icon><FileSearchOutlined /></template>
                        导入文件
                    </nn-button>
                    <nn-button :loading="mibCompileLoading" @click="selectMibDirectory">
                        <template #icon><FolderOpenOutlined /></template>
                        导入目录
                    </nn-button>
                    <nn-button :disabled="!hasMibSources" :loading="mibCompileLoading" @click="compileStoredMibs">
                        <template #icon><ReloadOutlined /></template>
                        重新编译
                    </nn-button>
                    <nn-button :disabled="!hasMibSources" :loading="projectSaving" @click="showSaveProject">
                        <template #icon><SaveOutlined /></template>
                        保存工程
                    </nn-button>
                    <nn-button :loading="projectLoading || projectImporting" @click="showImportProject">
                        <template #icon><ImportOutlined /></template>
                        导入工程
                    </nn-button>
                    <nn-button danger :disabled="!hasMibSources || mibCompileLoading" @click="clearMibs">
                        <template #icon><DeleteOutlined /></template>
                        清空
                    </nn-button>
                </div>

                <div v-if="showMibCompileProgress" class="mib-compile-progress" role="status" aria-live="polite">
                    <div class="mib-compile-progress-info">
                        <span class="mib-compile-progress-phase">{{ mibCompileProgressTitle }}</span>
                        <span class="mib-compile-progress-file" :title="mibCompileProgress?.filePath || ''">
                            {{ mibCompileProgressFile }}
                        </span>
                        <span class="mib-compile-progress-counts">
                            成功 {{ mibCompileCounts.compiled }} · 跳过 {{ mibCompileCounts.skipped }} · 失败
                            {{ mibCompileCounts.failed }}
                        </span>
                    </div>
                    <div
                        class="mib-compile-progress-bar"
                        role="progressbar"
                        aria-label="MIB编译进度"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        :aria-valuenow="mibCompilePercent"
                    >
                        <div class="mib-compile-progress-fill" :style="{ width: mibCompilePercent + '%' }" />
                    </div>
                </div>

                <div class="mib-results">
                    <section class="mib-file-block">
                        <div class="mib-panel-header">
                            <div class="mib-panel-heading">
                                <span class="mib-panel-title">文件状态</span>
                                <span class="mib-panel-description">逐文件展示最近一次编译结果</span>
                                <nn-select
                                    v-model:value="mibFileStatusFilter"
                                    :options="MIB_FILE_STATUS_OPTIONS"
                                    aria-label="文件状态筛选"
                                    class="mib-file-status-filter"
                                    data-testid="mib-file-status-filter"
                                />
                            </div>
                            <span class="mib-panel-meta">
                                已编译 {{ compiledFileCount }} / 跳过 {{ skippedFileCount }} / 失败
                                {{ failedFileCount }}
                            </span>
                        </div>

                        <nn-table
                            :columns="mibFileColumns"
                            :data-source="filteredMibFiles"
                            :pagination="mibFilePagination"
                            :row-key="getFileKey"
                            :scroll="MIB_FILE_TABLE_SCROLL"
                            aria-label="MIB 文件状态表"
                            class="mib-file-table"
                            size="small"
                            @change="handleMibFileTableChange"
                        >
                            <template #bodyCell="{ column, record }">
                                <template v-if="column.key === 'status'">
                                    <span class="mib-file-status">
                                        <span
                                            class="mib-file-status-icon"
                                            :class="'is-' + getFileStatusMeta(record.status).tone"
                                            aria-hidden="true"
                                        >
                                            <component
                                                :is="getFileStatusMeta(record.status).icon"
                                                :stroke-width="1.9"
                                            />
                                        </span>
                                        <nn-tag :color="getFileStatusMeta(record.status).color" class="mib-file-tag">
                                            {{ getFileStatusMeta(record.status).text }}
                                        </nn-tag>
                                    </span>
                                </template>
                                <template v-else-if="column.key === 'fileName'">
                                    <span class="mib-file-name">
                                        {{ record.fileName || '未命名 MIB 文件' }}
                                    </span>
                                </template>
                                <template v-else-if="column.key === 'filePath'">
                                    <span class="mib-file-path">{{ record.filePath || '-' }}</span>
                                </template>
                                <template v-else-if="column.key === 'msg'">
                                    <span v-if="record.msg" class="mib-file-message">
                                        <InfoCircleOutlined />
                                        <span>{{ record.msg }}</span>
                                    </span>
                                    <span v-else class="mib-file-placeholder">-</span>
                                </template>
                                <template v-else-if="column.key === 'action'">
                                    <nn-button size="small" :disabled="!record.filePath" @click="openMibSource(record)">
                                        源码
                                    </nn-button>
                                </template>
                            </template>
                            <template #emptyText>
                                <nn-empty :description="mibFileEmptyDescription" />
                            </template>
                        </nn-table>
                    </section>
                </div>
            </div>
        </nn-card>

        <nn-modal
            v-model:open="projectSaveOpen"
            title="保存MIB工程"
            ok-text="保存"
            cancel-text="取消"
            :confirm-loading="projectSaving"
            width="520px"
            @ok="saveMibProject"
        >
            <nn-form :model="projectForm" :label-col="{ style: { width: '72px' } }">
                <nn-form-item label="工程名">
                    <nn-input
                        v-model:value="projectForm.name"
                        :maxlength="80"
                        placeholder="请输入工程名"
                        @press-enter="saveMibProject"
                    />
                </nn-form-item>
                <nn-form-item label="内容">
                    <div class="mib-project-meta">
                        文件 {{ mibStatus.expandedFileCount }} / 模块 {{ mibStatus.modules.length }} / OID
                        {{ mibStatus.totalObjects }}
                    </div>
                </nn-form-item>
            </nn-form>
        </nn-modal>

        <nn-modal v-model:open="projectImportOpen" title="导入MIB工程" :footer="null" width="760px">
            <div class="mib-project-header">
                <nn-tooltip :title="projectRootDir">
                    <span class="mib-project-root">{{ projectRootDir || 'userData/snmp-mib-projects' }}</span>
                </nn-tooltip>
                <nn-button size="small" :loading="projectLoading" @click="loadMibProjects">刷新</nn-button>
            </div>
            <nn-table
                :columns="projectColumns"
                :data-source="mibProjects"
                :loading="projectLoading"
                :pagination="{ pageSize: 6, size: 'small' }"
                row-key="name"
                size="small"
                class="mib-project-table"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'name'">
                        <nn-tooltip :title="record.directory">
                            <span class="mib-project-name">{{ record.name || record.projectName }}</span>
                        </nn-tooltip>
                    </template>
                    <template v-else-if="column.key === 'updatedAt'">
                        {{ formatProjectTime(record.updatedAt) }}
                    </template>
                    <template v-else-if="column.key === 'action'">
                        <nn-button
                            type="link"
                            size="small"
                            :loading="
                                projectImporting &&
                                importingProjectName === String(record.name || record.projectName || '')
                            "
                            @click="importMibProject(record)"
                        >
                            导入
                        </nn-button>
                    </template>
                </template>
            </nn-table>
        </nn-modal>

        <nn-drawer v-model:open="mibSourceDrawerOpen" :title="mibSourceDrawerTitle" width="720px" :z-index="1200">
            <nn-spin :spinning="mibSourceLoading">
                <pre class="mib-source-preview">{{ mibSourceText || '暂无源码' }}</pre>
            </nn-spin>
        </nn-drawer>
    </div>
</template>

<script setup>
    import { computed, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue';
    import { MIB_COMPILE_PROGRESS_EVENT, SNMP_EVENT_PAGE_ID } from '../../const/snmpConst';
    import {
        CheckCircleOutlined,
        DeleteOutlined,
        ExclamationCircleOutlined,
        FileSearchOutlined,
        FolderOpenOutlined,
        ImportOutlined,
        InfoCircleOutlined,
        ReloadOutlined,
        SaveOutlined
    } from '../../ui/icons';
    import EventBus from '../../utils/eventBus';
    import { notify } from '../../utils/notify';

    defineOptions({ name: 'SnmpMibCompiler' });

    const createEmptyMibStatus = () => ({
        loadedFiles: [],
        failedFiles: [],
        skippedFiles: [],
        requestedFiles: [],
        modules: [],
        baseModules: [],
        totalObjects: 0,
        expandedFileCount: 0,
        cacheHit: false
    });

    const FILE_STATUS_META = Object.freeze({
        compiled: {
            text: '已编译',
            color: 'green',
            tone: 'success',
            icon: CheckCircleOutlined
        },
        skipped: {
            text: '已跳过',
            color: 'gold',
            tone: 'warning',
            icon: InfoCircleOutlined
        },
        failed: {
            text: '失败',
            color: 'red',
            tone: 'error',
            icon: ExclamationCircleOutlined
        },
        pending: {
            text: '待编译',
            color: 'default',
            tone: 'muted',
            icon: FileSearchOutlined
        }
    });

    const MIB_FILE_TABLE_PAGE_SIZE = 50;
    const MIB_FILE_TABLE_SCROLL = Object.freeze({ x: 1112, y: '100%' });
    const MIB_FILE_STATUS_OPTIONS = Object.freeze([
        { label: '全部状态', value: 'all' },
        { label: '已编译', value: 'compiled' },
        { label: '已跳过', value: 'skipped' },
        { label: '失败', value: 'failed' }
    ]);
    const mibFileColumns = [
        {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 112
        },
        {
            title: '文件名',
            dataIndex: 'fileName',
            key: 'fileName',
            width: 260
        },
        {
            title: '文件路径',
            dataIndex: 'filePath',
            key: 'filePath',
            width: 400
        },
        {
            title: '编译信息',
            dataIndex: 'msg',
            key: 'msg',
            width: 268
        },
        {
            title: '操作',
            key: 'action',
            width: 72,
            fixed: 'right'
        }
    ];

    const projectColumns = [
        {
            title: '工程名',
            dataIndex: 'name',
            key: 'name'
        },
        {
            title: '文件',
            dataIndex: 'fileCount',
            key: 'fileCount',
            width: 72
        },
        {
            title: '模块',
            dataIndex: 'moduleCount',
            key: 'moduleCount',
            width: 72
        },
        {
            title: 'OID',
            dataIndex: 'totalObjects',
            key: 'totalObjects',
            width: 86
        },
        {
            title: '更新时间',
            dataIndex: 'updatedAt',
            key: 'updatedAt',
            width: 160
        },
        {
            title: '操作',
            key: 'action',
            width: 72
        }
    ];

    const mibCompileLoading = ref(false);
    const statusLoading = ref(false);
    const mibCompileProgress = ref(null);
    const mibStatus = ref(createEmptyMibStatus());
    const mibFiles = ref([]);
    const mibFileStatusFilter = ref('all');
    const mibFilePage = ref(1);
    const mibFilePageSize = ref(MIB_FILE_TABLE_PAGE_SIZE);
    const mibSourceDrawerOpen = ref(false);
    const mibSourceLoading = ref(false);
    const mibSourceText = ref('');
    const mibSourceFile = ref(null);
    const projectSaveOpen = ref(false);
    const projectSaving = ref(false);
    const projectImportOpen = ref(false);
    const projectLoading = ref(false);
    const projectImporting = ref(false);
    const importingProjectName = ref('');
    const projectRootDir = ref('');
    const mibProjects = ref([]);
    const projectForm = reactive({
        name: ''
    });
    let mibStatusLoaded = false;
    let mibStatusLoadPromise = null;
    let mibSourceRequestRevision = 0;

    const normalizeSelectionPaths = payload => {
        const candidates = [];

        if (Array.isArray(payload)) {
            candidates.push(...payload);
        } else if (payload && typeof payload === 'object') {
            if (Array.isArray(payload.filePaths)) {
                candidates.push(...payload.filePaths);
            } else if (payload.filePaths) {
                candidates.push(payload.filePaths);
            }
            candidates.push(payload.directoryPath, payload.path, payload.filePath);
        } else if (payload) {
            candidates.push(payload);
        }

        return Array.from(
            new Set(
                candidates
                    .filter(candidate => typeof candidate === 'string')
                    .map(candidate => candidate.trim())
                    .filter(Boolean)
            )
        );
    };

    const getPathBaseName = filePath => {
        const parts = String(filePath || '').split(/[\\/]/u);
        return parts[parts.length - 1] || '';
    };

    const normalizeFileRecord = (file, status) => {
        const source = typeof file === 'string' ? { filePath: file } : file || {};
        const filePath = source.filePath || source.path || '';
        return {
            ...source,
            filePath,
            fileName: source.fileName || getPathBaseName(filePath),
            status: source.status || status || 'pending',
            msg: source.msg || source.message || ''
        };
    };

    const normalizeMibStatus = payload => {
        const source = payload && typeof payload === 'object' ? payload : {};
        const loadedFiles = Array.isArray(source.loadedFiles) ? source.loadedFiles : [];
        const failedFiles = Array.isArray(source.failedFiles) ? source.failedFiles : [];
        const skippedFiles = Array.isArray(source.skippedFiles) ? source.skippedFiles : [];
        const fallbackFileCount = loadedFiles.length + failedFiles.length + skippedFiles.length;

        return {
            loadedFiles,
            failedFiles,
            skippedFiles,
            requestedFiles: normalizeSelectionPaths(source.requestedFiles),
            modules: Array.isArray(source.modules) ? source.modules : [],
            baseModules: Array.isArray(source.baseModules) ? source.baseModules : [],
            totalObjects: Number(source.totalObjects) || 0,
            expandedFileCount:
                source.expandedFileCount === undefined ? fallbackFileCount : Number(source.expandedFileCount) || 0,
            cacheHit: Boolean(source.cacheHit)
        };
    };

    const setMibStatus = payload => {
        mibStatus.value = normalizeMibStatus(payload);
        mibFiles.value = [
            ...mibStatus.value.loadedFiles.map(file => normalizeFileRecord(file, 'compiled')),
            ...mibStatus.value.skippedFiles.map(file => normalizeFileRecord(file, 'skipped')),
            ...mibStatus.value.failedFiles.map(file => normalizeFileRecord(file, 'failed'))
        ];
        mibFilePage.value = 1;
        mibStatusLoaded = true;
    };

    const getCurrentMibPaths = () => {
        const requestedFiles = normalizeSelectionPaths(mibStatus.value.requestedFiles);
        if (requestedFiles.length) {
            return requestedFiles;
        }
        return normalizeSelectionPaths(mibFiles.value.map(file => file.filePath));
    };

    const compiledFileCount = computed(() => mibStatus.value.loadedFiles.length);
    const failedFileCount = computed(() => mibStatus.value.failedFiles.length);
    const skippedFileCount = computed(() => mibStatus.value.skippedFiles.length);
    const hasMibSources = computed(() => getCurrentMibPaths().length > 0 || mibFiles.value.length > 0);
    const filteredMibFiles = computed(() =>
        mibFileStatusFilter.value === 'all'
            ? mibFiles.value
            : mibFiles.value.filter(file => file.status === mibFileStatusFilter.value)
    );
    const mibFileEmptyDescription = computed(() =>
        mibFiles.value.length ? '当前筛选条件下暂无 MIB 文件' : '暂无 MIB 文件，请导入文件或目录后开始编译'
    );
    const mibSourceDrawerTitle = computed(() => mibSourceFile.value?.fileName || 'MIB 源码');
    const mibFilePagination = computed(() =>
        filteredMibFiles.value.length > mibFilePageSize.value
            ? {
                  current: mibFilePage.value,
                  pageSize: mibFilePageSize.value,
                  showSizeChanger: true,
                  pageSizeOptions: [25, 50, 100],
                  showQuickJumper: true,
                  position: ['bottomCenter'],
                  showTotal: total => `共 ${total} 个文件`
              }
            : false
    );
    const showMibCompileProgress = computed(
        () => mibCompileProgress.value && !['completed', 'failed'].includes(mibCompileProgress.value.phase)
    );
    const mibCompileCounts = computed(() => ({
        compiled: Number(mibCompileProgress.value?.counts?.compiled) || 0,
        skipped: Number(mibCompileProgress.value?.counts?.skipped) || 0,
        failed: Number(mibCompileProgress.value?.counts?.failed) || 0
    }));
    const mibCompilePercent = computed(() =>
        Math.max(0, Math.min(100, Math.round(Number(mibCompileProgress.value?.percent) || 0)))
    );
    const mibCompileProgressTitle = computed(() => {
        const progress = mibCompileProgress.value || {};
        switch (progress.phase) {
            case 'scanning':
                return '扫描 ' + (progress.scanned || 0) + '/' + (progress.scanTotal || 0);
            case 'compiling':
                return '编译 ' + (progress.completed || 0) + '/' + (progress.total || 0);
            case 'planning':
                return '分析依赖关系';
            case 'serializing':
                return '解析批次 ' + (progress.completed || 0) + '/' + (progress.total || 0);
            case 'indexing':
                return '生成 OID 索引';
            case 'caching':
                return '保存缓存';
            case 'syncing':
                return '同步 SNMP 服务';
            default:
                return '准备编译';
        }
    });
    const mibCompileProgressFile = computed(
        () => mibCompileProgress.value?.fileName || mibCompileProgress.value?.message || '请稍候'
    );
    const mibCompileProgressTag = computed(() =>
        showMibCompileProgress.value ? mibCompileProgressTitle.value : '编译处理中'
    );

    const getFileStatusMeta = status => FILE_STATUS_META[status] || FILE_STATUS_META.pending;
    const getFileKey = (record, index) =>
        String(record.filePath || record.fileName || 'mib-file') + ':' + record.status + ':' + index;
    const handleMibFileTableChange = pagination => {
        mibFilePage.value = Number(pagination?.current) || 1;
        mibFilePageSize.value = Number(pagination?.pageSize) || MIB_FILE_TABLE_PAGE_SIZE;
    };

    const openMibSource = async record => {
        const requestRevision = ++mibSourceRequestRevision;
        mibSourceFile.value = record;
        mibSourceDrawerOpen.value = true;
        mibSourceLoading.value = true;
        mibSourceText.value = '';

        try {
            const result = await window.snmpApi.getMibSource({ filePath: record.filePath });
            if (result?.status !== 'success') {
                throw new Error(result?.msg || 'MIB 源码读取失败');
            }
            if (requestRevision === mibSourceRequestRevision) {
                const data = result.data;
                mibSourceText.value = typeof data === 'string' ? data : data?.source || data?.content || '';
            }
        } catch (error) {
            if (requestRevision === mibSourceRequestRevision) {
                mibSourceText.value = `-- 读取源码失败：${error.message}`;
            }
        } finally {
            if (requestRevision === mibSourceRequestRevision) {
                mibSourceLoading.value = false;
            }
        }
    };

    watch(mibFileStatusFilter, () => {
        mibFilePage.value = 1;
    });

    const loadMibStatus = async ({ force = false } = {}) => {
        if (!force && mibStatusLoaded) {
            return;
        }
        if (mibStatusLoadPromise) {
            return mibStatusLoadPromise;
        }

        mibStatusLoadPromise = (async () => {
            try {
                statusLoading.value = true;
                const result = await window.snmpApi.getMibStatus();
                if (result.status === 'success') {
                    setMibStatus(result.data?.summary || result.data);
                } else {
                    notify.error(result.msg || '获取MIB状态失败');
                }
            } catch (error) {
                notify.error('获取MIB状态失败: ' + error.message);
            } finally {
                statusLoading.value = false;
                mibStatusLoadPromise = null;
            }
        })();

        return mibStatusLoadPromise;
    };

    const compileMibFiles = async (filePaths, { force = false } = {}) => {
        const plainFilePaths = normalizeSelectionPaths(filePaths);
        if (plainFilePaths.length === 0) {
            notify.warning('请先导入 MIB 文件或目录');
            return;
        }

        try {
            mibCompileLoading.value = true;
            mibCompileProgress.value = null;
            const result = await window.snmpApi.compileMibs([...plainFilePaths], { force });
            if (result.status === 'success') {
                setMibStatus(result.data?.summary || result.data);
            } else {
                notify.error(result.msg || 'MIB编译失败');
            }
        } catch (error) {
            notify.error('MIB编译失败: ' + error.message);
        } finally {
            mibCompileLoading.value = false;
        }
    };

    const selectMibFiles = async () => {
        try {
            const result = await window.snmpApi.selectMibFiles();
            if (result.status !== 'success') {
                notify.error(result.msg || '选择MIB文件失败');
                return;
            }

            const selectedFiles = normalizeSelectionPaths(result.data);
            if (selectedFiles.length === 0) {
                return;
            }

            await compileMibFiles([...getCurrentMibPaths(), ...selectedFiles]);
        } catch (error) {
            notify.error('选择MIB文件失败: ' + error.message);
        }
    };

    const selectMibDirectory = async () => {
        try {
            const result = await window.snmpApi.selectMibDirectory();
            if (result.status !== 'success') {
                notify.error(result.msg || '选择MIB目录失败');
                return;
            }

            const selectedDirectories = normalizeSelectionPaths(result.data);
            if (selectedDirectories.length === 0) {
                return;
            }

            await compileMibFiles([...getCurrentMibPaths(), ...selectedDirectories]);
        } catch (error) {
            notify.error('选择MIB目录失败: ' + error.message);
        }
    };

    const compileStoredMibs = async () => {
        await compileMibFiles(getCurrentMibPaths(), { force: true });
    };

    const padTime = value => String(value).padStart(2, '0');

    const formatProjectTimestamp = date => {
        const year = date.getFullYear();
        const month = padTime(date.getMonth() + 1);
        const day = padTime(date.getDate());
        const hour = padTime(date.getHours());
        const minute = padTime(date.getMinutes());
        return String(year) + month + day + '-' + hour + minute;
    };

    const getDefaultProjectName = () => {
        const moduleName = mibStatus.value.modules[0] || 'mib-project';
        return moduleName + '-' + formatProjectTimestamp(new Date());
    };

    const formatProjectTime = value => {
        if (!value) {
            return '-';
        }

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return value;
        }

        return (
            date.getFullYear() +
            '-' +
            padTime(date.getMonth() + 1) +
            '-' +
            padTime(date.getDate()) +
            ' ' +
            padTime(date.getHours()) +
            ':' +
            padTime(date.getMinutes())
        );
    };

    const showSaveProject = () => {
        projectForm.name = getDefaultProjectName();
        projectSaveOpen.value = true;
    };

    const saveMibProject = async () => {
        const name = projectForm.name.trim();
        if (!name) {
            notify.warning('请输入工程名');
            return;
        }

        try {
            projectSaving.value = true;
            const result = await window.snmpApi.saveMibProject({ name });
            if (result.status !== 'success') {
                notify.error(result.msg || '保存MIB工程失败');
                return;
            }

            if (result.data?.summary) {
                setMibStatus(result.data.summary);
            }
            projectSaveOpen.value = false;
            notify.success(result.msg || 'MIB工程保存成功');
            if (projectImportOpen.value) {
                await loadMibProjects();
            }
        } catch (error) {
            notify.error('保存MIB工程失败: ' + error.message);
        } finally {
            projectSaving.value = false;
        }
    };

    const loadMibProjects = async () => {
        try {
            projectLoading.value = true;
            const result = await window.snmpApi.listMibProjects();
            if (result.status !== 'success') {
                notify.error(result.msg || '获取MIB工程列表失败');
                return;
            }

            const data = result.data;
            projectRootDir.value = data?.rootDir || '';
            mibProjects.value = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : [];
        } catch (error) {
            notify.error('获取MIB工程列表失败: ' + error.message);
        } finally {
            projectLoading.value = false;
        }
    };

    const showImportProject = async () => {
        projectImportOpen.value = true;
        await loadMibProjects();
    };

    const importMibProject = async record => {
        const projectName = String(record?.name || record?.projectName || '');
        if (!projectName || projectImporting.value) {
            return;
        }

        try {
            projectImporting.value = true;
            mibCompileLoading.value = true;
            importingProjectName.value = projectName;
            const result = await window.snmpApi.importMibProject({ name: projectName });
            if (result.status !== 'success') {
                notify.error(result.msg || '导入MIB工程失败');
                return;
            }

            setMibStatus(result.data?.summary || result.data);
            projectImportOpen.value = false;
            notify.success(result.msg || 'MIB工程导入成功');
        } catch (error) {
            notify.error('导入MIB工程失败: ' + error.message);
        } finally {
            projectImporting.value = false;
            importingProjectName.value = '';
            mibCompileLoading.value = false;
        }
    };

    const clearMibs = async () => {
        try {
            const result = await window.snmpApi.clearMibs();
            if (result.status === 'success') {
                setMibStatus(result.data);
                mibCompileProgress.value = null;
                notify.success(result.msg || 'MIB配置已清空');
            } else {
                notify.error(result.msg || '清空MIB配置失败');
            }
        } catch (error) {
            notify.error('清空MIB配置失败: ' + error.message);
        }
    };

    const handleMibCompileProgress = response => {
        if (response?.status !== 'success' || !response.data?.progressId) {
            return;
        }

        const next = response.data;
        if (
            mibCompileProgress.value?.progressId &&
            mibCompileProgress.value.progressId !== next.progressId &&
            next.phase !== 'preparing' &&
            !['completed', 'failed'].includes(mibCompileProgress.value.phase)
        ) {
            return;
        }
        if (
            mibCompileProgress.value?.progressId === next.progressId &&
            !['preparing', 'scanning'].includes(next.phase) &&
            Number(next.completed) < Number(mibCompileProgress.value.completed)
        ) {
            return;
        }

        mibCompileProgress.value = {
            ...mibCompileProgress.value,
            ...next,
            counts: next.counts || mibCompileProgress.value?.counts
        };
    };

    defineExpose({
        clearValidationErrors: () => {}
    });

    onMounted(() => {
        EventBus.on(MIB_COMPILE_PROGRESS_EVENT, SNMP_EVENT_PAGE_ID.PAGE_ID_SNMP_MIB_COMPILER, handleMibCompileProgress);
        loadMibStatus();
    });

    onBeforeUnmount(() => {
        mibSourceRequestRevision += 1;
        EventBus.off(MIB_COMPILE_PROGRESS_EVENT, SNMP_EVENT_PAGE_ID.PAGE_ID_SNMP_MIB_COMPILER);
    });

    onDeactivated(() => {
        mibSourceRequestRevision += 1;
        mibSourceDrawerOpen.value = false;
        mibSourceLoading.value = false;
    });
</script>

<style scoped>
    .snmp-mib-page {
        height: 100%;
        overflow: hidden;
    }

    .mib-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .mib-card :deep(.nn-card-body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    .mib-status-group {
        justify-content: flex-end;
    }

    .mib-compiler {
        display: flex;
        flex-direction: column;
        gap: 10px;
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .mib-toolbar {
        display: flex;
        flex-shrink: 0;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
    }

    .mib-compile-progress {
        flex-shrink: 0;
        min-width: 0;
        padding: 7px 10px;
        background: var(--nn-color-bg-info-subtle);
        border: 1px solid var(--nn-color-border-info);
        border-radius: 6px;
    }

    .mib-compile-progress-info {
        display: flex;
        gap: 10px;
        align-items: center;
        min-width: 0;
        font-size: 12px;
        line-height: 18px;
    }

    .mib-compile-progress-phase {
        flex-shrink: 0;
        color: var(--nn-color-primary);
        font-weight: 600;
    }

    .mib-compile-progress-file {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-strong);
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mib-compile-progress-counts {
        flex-shrink: 0;
        color: var(--nn-color-text-muted);
        white-space: nowrap;
    }

    .mib-compile-progress-bar {
        height: 3px;
        margin-top: 5px;
        overflow: hidden;
        background: var(--nn-color-bg-progress);
        border-radius: 2px;
    }

    .mib-compile-progress-fill {
        height: 100%;
        background: var(--nn-gradient-progress);
        border-radius: 2px;
        transition: width 0.2s ease;
    }

    .mib-results {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 10px;
        min-height: 0;
        overflow: hidden;
    }

    .mib-file-block {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: var(--nn-color-bg-surface);
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
    }

    .mib-panel-header {
        display: flex;
        flex-shrink: 0;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
        min-height: 42px;
        padding: 6px 12px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .mib-panel-heading {
        display: flex;
        gap: 8px;
        align-items: center;
        min-width: 0;
    }

    .mib-file-status-filter {
        flex: 0 0 116px;
        width: 116px;
    }

    .mib-panel-title {
        flex-shrink: 0;
        color: var(--nn-color-text-strong);
        font-weight: 600;
        font-size: 13px;
        line-height: 1.4;
    }

    .mib-panel-description,
    .mib-panel-meta {
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-size: 12px;
        line-height: 18px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mib-panel-meta {
        flex-shrink: 0;
    }

    .mib-file-table {
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    .mib-file-table :deep(.nn-spin-nested-loading),
    .mib-file-table :deep(.nn-spin-container) {
        height: 100%;
        min-height: 0;
    }

    .mib-file-table :deep(.nn-spin-container),
    .mib-file-table :deep(.nn-table),
    .mib-file-table :deep(.nn-table-container) {
        display: flex;
        flex-direction: column;
        min-height: 0;
    }

    .mib-file-table :deep(.nn-table),
    .mib-file-table :deep(.nn-table-container),
    .mib-file-table :deep(.nn-table-content) {
        flex: 1 1 0;
        min-height: 0;
    }

    .mib-file-table :deep(.nn-table-content) {
        max-height: none !important;
        overflow: auto;
    }

    .mib-file-table :deep(.nn-table-cell) {
        min-width: 0;
    }

    .mib-file-status {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        white-space: nowrap;
    }

    .mib-file-status-icon {
        display: inline-flex;
        flex: 0 0 20px;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        font-size: 13px;
        background: var(--nn-color-bg-muted);
        border-radius: 5px;
    }

    .mib-file-status-icon.is-success {
        color: var(--nn-color-success);
        background: var(--nn-color-bg-success-subtle);
    }

    .mib-file-status-icon.is-warning {
        color: var(--nn-color-warning);
        background: var(--nn-color-bg-warning-subtle);
    }

    .mib-file-status-icon.is-error {
        color: var(--nn-color-error);
        background: var(--nn-color-bg-danger-subtle);
    }

    .mib-file-status-icon.is-muted {
        color: var(--nn-color-text-muted);
    }

    .mib-file-name {
        display: block;
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-weight: 500;
        font-size: 13px;
        line-height: 1.4;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mib-file-tag {
        margin-inline-end: 0;
    }

    .mib-file-path {
        display: block;
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
        font-size: 11px;
        line-height: 17px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mib-file-message {
        display: flex;
        gap: 5px;
        align-items: center;
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-warning);
        font-size: 12px;
        line-height: 18px;
    }

    .mib-file-message :deep(.nn-icon) {
        flex-shrink: 0;
    }

    .mib-file-message span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mib-file-placeholder {
        color: var(--nn-color-text-muted);
    }

    .mib-source-preview {
        min-height: calc(100vh - 160px);
        margin: 0;
        padding: 12px;
        overflow: auto;
        color: var(--nn-color-text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        line-height: 1.6;
        white-space: pre;
        background: var(--nn-color-bg-code);
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
    }

    .mib-project-meta {
        min-height: 32px;
        padding: 0 11px;
        color: var(--nn-color-text-strong);
        line-height: 30px;
        background: var(--nn-color-bg-subtle);
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
    }

    .mib-project-header {
        display: flex;
        gap: 8px;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
        min-width: 0;
    }

    .mib-project-root,
    .mib-project-name {
        display: inline-block;
        max-width: 100%;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mib-project-root {
        flex: 1;
        color: var(--nn-color-text-muted);
        font-size: 12px;
    }

    .mib-project-table :deep(.nn-table-cell) {
        min-width: 0;
    }

    @media (max-width: 760px) {
        .mib-card :deep(.nn-card-head) {
            align-items: flex-start;
        }

        .mib-panel-header,
        .mib-panel-heading {
            align-items: flex-start;
        }

        .mib-panel-header {
            flex-direction: column;
            gap: 2px;
        }

        .mib-panel-heading {
            flex-direction: column;
            gap: 0;
        }

        .mib-file-status-filter {
            width: 100%;
        }

        .mib-panel-meta {
            white-space: normal;
        }

        .mib-compile-progress-info {
            flex-wrap: wrap;
            gap: 2px 10px;
        }

        .mib-compile-progress-file {
            flex-basis: calc(100% - 90px);
        }

        .mib-compile-progress-counts {
            width: 100%;
        }
    }

    @media (max-height: 660px) {
        .mib-panel-description {
            display: none;
        }
    }
</style>
