<template>
    <div class="nn-container yang-workspace-page">
        <nn-card title="Schema 工作区" class="workspace-card">
            <template #extra>
                <nn-space>
                    <nn-tag v-if="compileId && compileSucceeded" color="success">libyang 已编译</nn-tag>
                    <nn-tag v-else-if="compileId" color="error">libyang 编译失败</nn-tag>
                    <nn-tag v-else color="default">未编译</nn-tag>
                    <nn-tag color="blue">模块 {{ workspaceSummary.moduleCount }}</nn-tag>
                    <nn-tag color="cyan">节点 {{ workspaceSummary.nodeCount }}</nn-tag>
                    <nn-tag :color="diagnosticErrorCount ? 'error' : diagnosticWarningCount ? 'warning' : 'green'">
                        诊断 {{ diagnostics.length }}
                    </nn-tag>
                </nn-space>
            </template>

            <div class="workspace-toolbar">
                <div class="workspace-actions">
                    <nn-tooltip :title="compilerAvailable ? '' : compilerUnavailableMessage">
                        <span class="disabled-action-wrap">
                            <nn-button
                                type="primary"
                                :loading="compiling"
                                :disabled="!compilerAvailable"
                                @click="compileWorkspace"
                            >
                                <template #icon><CodeOutlined /></template>
                                编译工作区
                            </nn-button>
                        </span>
                    </nn-tooltip>
                    <nn-button :loading="loading" @click="loadWorkspace">
                        <template #icon><ReloadOutlined /></template>
                        刷新
                    </nn-button>
                    <nn-button danger :disabled="!compileId && workspaceModules.length === 0" @click="clearWorkspace">
                        <template #icon><DeleteOutlined /></template>
                        清空
                    </nn-button>
                </div>
                <div class="workspace-context">
                    <span v-if="compileId" class="compile-id" :title="compileId">Compile ID: {{ compileId }}</span>
                    <span v-if="workspaceSummary.cacheHit" class="cache-hint">缓存命中</span>
                </div>
            </div>

            <div class="workspace-layout" :class="{ 'workspace-layout-empty': !compileId }">
                <section class="schema-panel">
                    <div class="panel-header">
                        <div>
                            <span class="panel-title">Schema 索引</span>
                            <span class="panel-meta">
                                {{ schemaAuthoritative ? 'libyang effective schema' : '结构预览（非权威）' }}
                            </span>
                        </div>
                        <nn-input-search
                            v-model:value="treeQuery"
                            allow-clear
                            placeholder="筛选已加载节点"
                            class="tree-search"
                        />
                    </div>
                    <div class="schema-tree-scroll">
                        <nn-spin :spinning="treeLoading">
                            <nn-tree
                                v-if="displayTree.length"
                                v-model:expanded-keys="expandedKeys"
                                v-model:selected-keys="selectedKeys"
                                :tree-data="displayTree"
                                block-node
                                @expand="handleTreeExpand"
                                @select="handleTreeSelect"
                            >
                                <template #title="node">
                                    <span class="schema-node-title">
                                        <LoadingOutlined v-if="node.loading" spin class="node-loading" />
                                        <span class="schema-node-name">{{ node.title }}</span>
                                        <span class="schema-node-keyword">{{ node.keyword || node.kind }}</span>
                                        <span v-if="node.config === false" class="schema-node-access schema-node-state">
                                            state
                                        </span>
                                        <span v-else-if="node.config === true" class="schema-node-access">config</span>
                                        <span v-if="node.module" class="schema-node-module">{{ node.module }}</span>
                                    </span>
                                </template>
                            </nn-tree>
                            <nn-empty v-else description="暂无 Schema 节点" />
                        </nn-spin>
                    </div>
                </section>

                <section class="inspector-panel">
                    <nn-tabs v-model:active-key="inspectorTab" size="small" class="inspector-tabs">
                        <nn-tab-pane key="detail" tab="节点详情" force-render>
                            <div class="inspector-scroll">
                                <nn-descriptions v-if="selectedNode" :column="1" bordered size="small">
                                    <nn-descriptions-item label="名称">
                                        {{ selectedNode.name || selectedNode.title || '-' }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="Schema 路径">
                                        <nn-typography-text copyable>{{ selectedNode.path || '-' }}</nn-typography-text>
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="关键字">
                                        {{ selectedNode.keyword || selectedNode.kind || '-' }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="模块">
                                        {{ selectedNode.module || '-' }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="数据类型">
                                        {{ formatNodeType(selectedNode.type) }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="访问">
                                        {{ selectedNode.config === false ? 'state / config false' : 'config true' }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="Mandatory">
                                        {{ formatBoolean(selectedNode.mandatory) }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="Status">
                                        {{ selectedNode.status || '-' }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="Default">
                                        {{ formatValue(selectedNode.default) }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="Units">
                                        {{ selectedNode.units || '-' }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="If Feature">
                                        {{ formatValue(selectedNode.ifFeatures) }}
                                    </nn-descriptions-item>
                                    <nn-descriptions-item label="描述">
                                        <span class="detail-description">{{ selectedNode.description || '-' }}</span>
                                    </nn-descriptions-item>
                                </nn-descriptions>
                                <nn-empty v-else description="请选择 Schema 节点" />
                            </div>
                        </nn-tab-pane>

                        <nn-tab-pane key="source" tab="YANG 源码" force-render>
                            <div class="source-toolbar">
                                <nn-select
                                    v-model:value="sourceModuleKey"
                                    :options="moduleOptions"
                                    allow-clear
                                    placeholder="选择模块"
                                    class="source-module-select"
                                    @change="loadSource"
                                />
                                <nn-button :loading="sourceLoading" :disabled="!sourceModuleKey" @click="loadSource">
                                    刷新源码
                                </nn-button>
                            </div>
                            <nn-spin :spinning="sourceLoading" class="source-spin">
                                <pre class="source-code">{{ sourceText || '请选择一个模块查看源码' }}</pre>
                            </nn-spin>
                        </nn-tab-pane>

                        <nn-tab-pane key="diagnostics" :tab="`诊断 (${diagnostics.length})`" force-render>
                            <div class="diagnostic-toolbar">
                                <nn-segmented v-model:value="diagnosticFilter" :options="diagnosticFilterOptions" />
                                <nn-button size="small" :loading="diagnosticLoading" @click="loadDiagnostics">
                                    刷新
                                </nn-button>
                            </div>
                            <div class="diagnostic-list">
                                <button
                                    v-for="(diagnostic, index) in filteredDiagnostics"
                                    :key="diagnostic.id || `${diagnostic.file || ''}:${diagnostic.line || 0}:${index}`"
                                    type="button"
                                    class="diagnostic-row"
                                    @click="openDiagnosticSource(diagnostic)"
                                >
                                    <nn-tag :color="diagnosticColor(diagnostic.severity)">
                                        {{ diagnosticLabel(diagnostic.severity) }}
                                    </nn-tag>
                                    <span class="diagnostic-content">
                                        <span class="diagnostic-message">
                                            {{ diagnostic.message || diagnostic.msg || '未知诊断' }}
                                        </span>
                                        <span class="diagnostic-location">
                                            {{ diagnostic.fileName || diagnostic.file || diagnostic.module || '-' }}
                                            <template v-if="diagnostic.line">
                                                :{{ diagnostic.line }}
                                                <template v-if="diagnostic.column">:{{ diagnostic.column }}</template>
                                            </template>
                                        </span>
                                    </span>
                                </button>
                                <nn-empty v-if="filteredDiagnostics.length === 0" description="当前筛选下没有诊断" />
                            </div>
                        </nn-tab-pane>
                    </nn-tabs>
                </section>
            </div>
        </nn-card>
    </div>
</template>

<script setup>
    import { computed, onActivated, onBeforeUnmount, onMounted, ref } from 'vue';
    import { YANG_EVENT, YANG_EVENT_PAGE_ID } from '../../const/yangConst';
    import EventBus from '../../utils/eventBus';
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';
    import { CodeOutlined, DeleteOutlined, LoadingOutlined, ReloadOutlined } from '../../ui/icons';
    import { useYangCompilerStatus } from './yangCompilerStatus';
    import { fileBaseName, getTaskId, invokeBridge, isTaskTerminal, unwrapArray } from './yangUiUtils';

    defineOptions({ name: 'YangWorkspace' });

    const loading = ref(false);
    const compiling = ref(false);
    const treeLoading = ref(false);
    const sourceLoading = ref(false);
    const diagnosticLoading = ref(false);
    const compileId = ref('');
    const compileSucceeded = ref(false);
    const compileTaskId = ref('');
    const compileProgress = ref(null);
    const workspaceSummary = ref({ moduleCount: 0, nodeCount: 0, cacheHit: false });
    const workspaceModules = ref([]);
    const diagnostics = ref([]);
    const treeData = ref([]);
    const expandedKeys = ref([]);
    const selectedKeys = ref([]);
    const selectedNode = ref(null);
    const treeQuery = ref('');
    const inspectorTab = ref('detail');
    const sourceModuleKey = ref('');
    const sourceText = ref('');
    const diagnosticFilter = ref('all');
    const schemaAuthoritative = ref(false);
    const { compilerAvailable, refreshCompilerStatus } = useYangCompilerStatus();
    const compilerUnavailableMessage = 'YANG 编译暂不可用，请在“设置 → 运行时诊断”中检查';

    const diagnosticFilterOptions = [
        { label: '全部', value: 'all' },
        { label: '错误', value: 'error' },
        { label: '警告', value: 'warning' },
        { label: '信息', value: 'info' }
    ];

    const normalizeModule = (module, index) => {
        if (typeof module === 'string') return { id: '', name: module, revision: '', _key: module };
        const metadata = module?.metadata || {};
        const name = module?.name || module?.moduleName || metadata.name || `module-${index}`;
        const revision = module?.revision || module?.revisionDate || metadata.revision || '';
        const id = module?.id || module?.moduleId || module?.hash || '';
        return { ...module, id, name, revision, _key: id || `${name}@${revision || 'none'}` };
    };

    const normalizeDiagnostic = diagnostic => ({
        ...diagnostic,
        severity: String(diagnostic?.severity || diagnostic?.level || 'error').toLowerCase(),
        fileName: diagnostic?.fileName || fileBaseName(diagnostic?.file || diagnostic?.filePath || diagnostic?.source)
    });

    const normalizeNode = (node, index = 0) => {
        const id = node?.id || node?.nodeId || node?.key || `${node?.path || node?.name || 'node'}-${index}`;
        const hasChildren = Boolean(node?.hasChildren || Number(node?.childCount || 0) > 0 || node?.children?.length);
        return {
            ...node,
            id,
            key: id,
            title: node?.title || node?.name || node?.keyword || id,
            name: node?.name || node?.title || '',
            keyword: node?.keyword || node?.kind || '',
            isLeaf: !hasChildren,
            children: Array.isArray(node?.children) ? node.children.map(normalizeNode) : [],
            childrenLoaded: Array.isArray(node?.children) && node.children.length > 0,
            loading: false
        };
    };

    const moduleOptions = computed(() =>
        workspaceModules.value.map(module => ({
            label: `${module.name}${module.revision ? `@${module.revision}` : ''}`,
            value: module._key
        }))
    );
    const diagnosticErrorCount = computed(
        () => diagnostics.value.filter(item => ['error', 'fatal'].includes(item.severity)).length
    );
    const diagnosticWarningCount = computed(
        () => diagnostics.value.filter(item => ['warning', 'warn'].includes(item.severity)).length
    );
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
    const displayTree = computed(() => {
        const query = treeQuery.value.trim().toLowerCase();
        if (!query) return treeData.value;
        const filterNodes = nodes =>
            nodes.flatMap(node => {
                const children = filterNodes(node.children || []);
                const haystack = [node.title, node.module, node.path, node.keyword].join(' ').toLowerCase();
                if (haystack.includes(query) || children.length) return [{ ...node, children }];
                return [];
            });
        return filterNodes(treeData.value);
    });
    const applyWorkspace = data => {
        const workspace = data?.workspace || data || {};
        compileId.value = workspace.compileId || workspace.id || compileId.value || '';
        compileSucceeded.value = workspace.success === true || workspace.validation?.succeeded === true;
        const summary = workspace.summary || {};
        const nextModules = unwrapArray(workspace.modules, ['modules']);
        if (nextModules.length) workspaceModules.value = nextModules.map(normalizeModule);
        const nextDiagnostics = unwrapArray(workspace.diagnostics, ['diagnostics']);
        diagnostics.value = nextDiagnostics.map(normalizeDiagnostic);
        const schemaTree = workspace.schemaTree || {};
        schemaAuthoritative.value = schemaTree.authoritative === true;
        const inlineRoots = unwrapArray(schemaTree.roots || workspace.roots, ['nodes', 'roots']);
        if (inlineRoots.length) treeData.value = inlineRoots.map(normalizeNode);
        workspaceSummary.value = {
            ...workspaceSummary.value,
            ...summary,
            cacheHit: Boolean(workspace.cacheHit || summary.cacheHit),
            moduleCount: Number(
                summary.moduleCount ?? workspace.modules?.length ?? workspaceSummary.value.moduleCount ?? 0
            ),
            nodeCount: Number(summary.nodeCount ?? schemaTree.nodeCount ?? workspaceSummary.value.nodeCount ?? 0)
        };
    };

    const loadRoots = async () => {
        if (!compileId.value) {
            treeData.value = [];
            schemaAuthoritative.value = false;
            return;
        }
        treeLoading.value = true;
        try {
            const { data } = await invokeBridge('yangApi', 'getSchemaRoots', { compileId: compileId.value });
            treeData.value = unwrapArray(data, ['nodes', 'roots']).map(normalizeNode);
        } catch (error) {
            notify.error(`加载 Schema 树失败：${error.message}`);
        } finally {
            treeLoading.value = false;
        }
    };

    const loadWorkspace = async () => {
        loading.value = true;
        try {
            const { data } = await invokeBridge('yangApi', 'getWorkspace');
            compileId.value = '';
            compileSucceeded.value = false;
            workspaceModules.value = [];
            diagnostics.value = [];
            treeData.value = [];
            selectedKeys.value = [];
            selectedNode.value = null;
            applyWorkspace(data);
            if (compileId.value && treeData.value.length === 0) await loadRoots();
            if (compileId.value && diagnostics.value.length === 0) await loadDiagnostics({ quiet: true });
            if (workspaceModules.value.length === 0) await loadWorkspaceModules();
        } catch (error) {
            notify.error(`加载 Schema 工作区失败：${error.message}`);
        } finally {
            loading.value = false;
        }
    };

    const loadWorkspaceModules = async () => {
        try {
            const { data } = await invokeBridge('yangApi', 'listModules');
            workspaceModules.value = unwrapArray(data, ['modules', 'items'])
                .filter(
                    module =>
                        module?.isLocal || module?.filePath || module?.path || module?.contentHash || module?.compiled
                )
                .map(normalizeModule);
        } catch (_error) {
            // The workspace can still display its tree when module source enumeration is unavailable.
        }
    };

    const compileWorkspace = async () => {
        if (!compilerAvailable.value) {
            notify.error(compilerUnavailableMessage);
            return;
        }
        compiling.value = true;
        compileProgress.value = { phase: 'preparing', completed: 0, total: 0, percent: 0, counts: {} };
        try {
            const { data } = await invokeBridge('yangApi', 'compile', {});
            const taskId = getTaskId(data);
            if (taskId) {
                compileTaskId.value = taskId;
                return;
            }
            applyWorkspace(data);
            if (compileId.value && treeData.value.length === 0) await loadRoots();
            compiling.value = false;
            compileProgress.value = null;
            notify.success(data?.cacheHit ? 'YANG 编译完成（缓存命中）' : 'YANG 编译完成');
        } catch (error) {
            await refreshCompilerStatus({ force: true });
            compiling.value = false;
            compileProgress.value = null;
            notify.error(`YANG 编译失败：${error.message}`);
        }
    };

    const findNode = (nodes, key) => {
        for (const node of nodes) {
            if (node.key === key) return node;
            const found = findNode(node.children || [], key);
            if (found) return found;
        }
        return null;
    };

    const handleTreeExpand = async (_keys, info) => {
        const node = findNode(treeData.value, info?.node?.key);
        if (!info?.expanded || !node || node.isLeaf || node.childrenLoaded || node.loading) return;
        node.loading = true;
        treeData.value = [...treeData.value];
        try {
            const { data } = await invokeBridge('yangApi', 'getSchemaChildren', {
                compileId: compileId.value,
                parentId: node.id,
                nodeId: node.id
            });
            node.children = unwrapArray(data, ['nodes', 'children']).map(normalizeNode);
            node.childrenLoaded = true;
            node.isLeaf = node.children.length === 0;
        } catch (error) {
            notify.error(`加载子节点失败：${error.message}`);
        } finally {
            node.loading = false;
            treeData.value = [...treeData.value];
        }
    };

    const handleTreeSelect = async (_keys, info) => {
        if (!info?.node || info.selected === false) {
            selectedNode.value = null;
            return;
        }
        const fallbackNode = findNode(treeData.value, info.node.key) || info.node;
        selectedNode.value = fallbackNode;
        inspectorTab.value = 'detail';
        try {
            const { data } = await invokeBridge('yangApi', 'getSchemaNode', {
                compileId: compileId.value,
                nodeId: fallbackNode.id || fallbackNode.key
            });
            selectedNode.value = { ...fallbackNode, ...(data || {}) };
        } catch (_error) {
            // The summary already carried by the tree node is sufficient for basic inspection.
        }
    };

    const loadSource = async () => {
        const module = workspaceModules.value.find(item => item._key === sourceModuleKey.value);
        if (!module) {
            sourceText.value = '';
            return;
        }
        sourceLoading.value = true;
        try {
            const { data } = await invokeBridge('yangApi', 'getModuleSource', {
                moduleId: module.id || undefined,
                name: module.name,
                revision: module.revision || undefined
            });
            sourceText.value = typeof data === 'string' ? data : data?.source || data?.content || '';
        } catch (error) {
            sourceText.value = `// 读取源码失败：${error.message}`;
        } finally {
            sourceLoading.value = false;
        }
    };

    const loadDiagnostics = async ({ quiet = false } = {}) => {
        diagnosticLoading.value = true;
        try {
            const { data } = await invokeBridge('yangApi', 'getDiagnostics', {
                compileId: compileId.value || undefined
            });
            diagnostics.value = unwrapArray(data, ['diagnostics', 'items']).map(normalizeDiagnostic);
        } catch (error) {
            if (!quiet) notify.error(`加载诊断失败：${error.message}`);
        } finally {
            diagnosticLoading.value = false;
        }
    };

    const openDiagnosticSource = diagnostic => {
        const module = workspaceModules.value.find(
            item =>
                item.id === diagnostic.moduleId ||
                item.name === diagnostic.module ||
                item.name === diagnostic.source ||
                [diagnostic.file, diagnostic.source]
                    .filter(Boolean)
                    .some(value => [item.filePath, item.path, item.fileName].includes(value))
        );
        if (module) {
            sourceModuleKey.value = module._key;
            inspectorTab.value = 'source';
            loadSource();
        }
    };

    const clearWorkspace = () => {
        dialog.confirm({
            title: '清空 Schema 工作区',
            content: '将清除当前编译上下文、Schema 索引和诊断；本地 YANG 源文件仍保留在模型库中。',
            okText: '清空',
            okType: 'danger',
            onOk: async () => {
                try {
                    await invokeBridge('yangApi', 'clearWorkspace');
                    compileId.value = '';
                    compileSucceeded.value = false;
                    compileTaskId.value = '';
                    compileProgress.value = null;
                    workspaceSummary.value = { moduleCount: 0, nodeCount: 0, cacheHit: false };
                    workspaceModules.value = [];
                    diagnostics.value = [];
                    treeData.value = [];
                    schemaAuthoritative.value = false;
                    expandedKeys.value = [];
                    selectedKeys.value = [];
                    selectedNode.value = null;
                    sourceText.value = '';
                    notify.success('Schema 工作区已清空');
                } catch (error) {
                    notify.error(`清空失败：${error.message}`);
                }
            }
        });
    };

    const handleCompileProgress = payload => {
        if (payload?.status === 'error') return;
        const data = payload?.status === 'success' ? payload.data : payload?.data || payload;
        if (!data || typeof data !== 'object') return;
        const action = data.action || data.taskType || data.kind || data.type || '';
        const taskId = getTaskId(data);
        if (action && action !== 'compile' && taskId !== compileTaskId.value) return;
        if (compileTaskId.value && taskId && taskId !== compileTaskId.value) return;
        compileProgress.value = {
            ...compileProgress.value,
            ...data,
            counts: data.counts || compileProgress.value?.counts || {}
        };
        compiling.value = !isTaskTerminal(data.phase || data.status);
        if (!isTaskTerminal(data.phase || data.status)) return;
        compileTaskId.value = '';
        if ((data.phase || data.status) === 'failed') {
            refreshCompilerStatus({ force: true });
            notify.error(data.message || data.error?.message || 'YANG 编译失败');
        }
        loadWorkspace();
        window.setTimeout(() => {
            if (compileProgress.value && isTaskTerminal(compileProgress.value.phase || compileProgress.value.status)) {
                compileProgress.value = null;
            }
        }, 4500);
    };

    const formatBoolean = value => (value === true ? 'true' : value === false ? 'false' : '-');
    const formatNodeType = value => {
        if (!value) return '-';
        if (typeof value === 'string') return value;
        return value.name || value.base || JSON.stringify(value);
    };
    const formatValue = value => {
        if (value === null || value === undefined || value === '') return '-';
        return Array.isArray(value) ? value.join(', ') || '-' : String(value);
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

    onMounted(() => {
        EventBus.on(YANG_EVENT.TASK_PROGRESS, YANG_EVENT_PAGE_ID.WORKSPACE, handleCompileProgress);
        refreshCompilerStatus();
        loadWorkspace();
    });

    onActivated(() => Promise.all([loadWorkspace(), refreshCompilerStatus()]));

    onBeforeUnmount(() => {
        EventBus.off(YANG_EVENT.TASK_PROGRESS, YANG_EVENT_PAGE_ID.WORKSPACE);
    });
</script>

<style scoped>
    .yang-workspace-page,
    .workspace-card {
        height: 100%;
        min-height: 0;
    }

    .workspace-card {
        display: flex;
        flex-direction: column;
    }

    .workspace-card :deep(.nn-card-body) {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
    }

    .workspace-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
    }

    .workspace-actions,
    .workspace-context {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .disabled-action-wrap {
        display: inline-flex;
    }

    .compile-id {
        max-width: 300px;
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .cache-hint {
        color: var(--nn-color-text-success);
        font-size: 11px;
    }

    .workspace-layout {
        display: grid;
        min-height: 0;
        flex: 1;
        grid-template-columns: minmax(360px, 46%) minmax(400px, 1fr);
        gap: 8px;
    }

    .workspace-layout-empty {
        min-height: 360px;
    }

    .schema-panel,
    .inspector-panel {
        display: flex;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
    }

    .panel-header {
        display: flex;
        min-height: 42px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 9px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }

    .panel-title {
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
    }

    .panel-meta {
        margin-left: 6px;
        color: var(--nn-color-text-muted);
        font-size: 11px;
    }

    .tree-search {
        width: 190px;
    }

    .schema-tree-scroll {
        min-height: 0;
        flex: 1;
        overflow: auto;
        padding: 6px;
    }

    .schema-node-title {
        display: inline-flex;
        max-width: 100%;
        align-items: center;
        gap: 5px;
        font-size: 12px;
    }

    .schema-node-name {
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-weight: 500;
        text-overflow: ellipsis;
    }

    .schema-node-keyword,
    .schema-node-module,
    .schema-node-access {
        flex: 0 0 auto;
        padding: 0 4px;
        border-radius: 3px;
        background: var(--nn-color-bg-info-subtle);
        color: var(--nn-color-text-info);
        font-size: 10px;
        line-height: 17px;
    }

    .schema-node-module {
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text-muted);
    }

    .schema-node-access {
        background: var(--nn-color-bg-success-subtle);
        color: var(--nn-color-text-success);
    }

    .schema-node-state {
        background: var(--nn-color-bg-warning-subtle);
        color: var(--nn-color-warning);
    }

    .node-loading {
        flex: 0 0 auto;
        color: var(--nn-color-primary);
    }

    .inspector-tabs {
        min-height: 0;
        flex: 1;
    }

    .inspector-tabs :deep(.nn-tabs-nav) {
        margin: 0;
        padding: 0 8px;
        background: var(--nn-color-bg-muted);
    }

    .inspector-tabs :deep(.nn-tabs-content-holder),
    .inspector-tabs :deep(.nn-tabs-content),
    .inspector-tabs :deep(.nn-tabs-tabpane) {
        min-height: 0;
        flex: 1;
    }

    .inspector-tabs :deep(.nn-tabs-content) {
        display: flex;
        flex-direction: column;
    }

    .inspector-scroll {
        height: 100%;
        overflow: auto;
        padding: 8px;
    }

    .detail-description {
        display: inline-block;
        white-space: pre-wrap;
    }

    .source-toolbar,
    .diagnostic-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .source-module-select {
        min-width: 240px;
        flex: 1;
    }

    .source-spin {
        display: block;
        height: calc(100% - 48px);
    }

    .source-code {
        height: 100%;
        min-height: 360px;
        margin: 0;
        padding: 10px 12px;
        overflow: auto;
        background: var(--nn-color-bg-code);
        color: var(--nn-color-text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        line-height: 1.55;
        white-space: pre;
    }

    .diagnostic-list {
        height: calc(100% - 48px);
        overflow-y: auto;
        padding: 6px;
    }

    .diagnostic-row {
        display: flex;
        width: 100%;
        align-items: flex-start;
        gap: 8px;
        padding: 7px;
        border: 0;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: transparent;
        color: var(--nn-color-text);
        cursor: pointer;
        font: inherit;
        text-align: left;
    }

    .diagnostic-row:hover {
        background: var(--nn-color-bg-hover);
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

    @media (max-width: 1000px) {
        .workspace-layout {
            grid-template-columns: 1fr;
            grid-template-rows: minmax(340px, 1fr) minmax(400px, 1fr);
        }
    }
</style>
