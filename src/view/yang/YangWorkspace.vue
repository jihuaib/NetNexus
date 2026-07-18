<template>
    <div
        class="nn-container yang-workspace-page"
        :class="{ 'workspace-pane-resizing': schemaPaneResizing }"
        @click="hideContextMenu"
    >
        <nn-card title="Schema 与设备操作" class="workspace-card">
            <template #extra>
                <nn-space>
                    <nn-tag :color="connected ? 'success' : 'default'">
                        NETCONF {{ connected ? '已连接' : '未连接' }}
                    </nn-tag>
                    <nn-tag v-if="schemaStatus === 'ready'" color="success">Schema 已就绪</nn-tag>
                    <nn-tag v-else-if="schemaStatus === 'compile-failed'" color="error">Schema 生成失败</nn-tag>
                    <nn-tag v-else-if="schemaStatus === 'restore-failed'" color="error" :title="schemaStatusMessage">
                        Schema 恢复失败
                    </nn-tag>
                    <nn-tag v-else-if="schemaStatus === 'restoring'" color="processing">Schema 恢复中</nn-tag>
                    <nn-tag v-else-if="compileId" color="default">Schema 状态未知</nn-tag>
                    <nn-tag v-else color="default">暂无 Schema</nn-tag>
                    <nn-tag color="blue">模块 {{ workspaceSummary.moduleCount }}</nn-tag>
                    <nn-tag color="cyan">节点 {{ workspaceSummary.nodeCount }}</nn-tag>
                </nn-space>
            </template>

            <div class="workspace-toolbar">
                <div class="workspace-actions">
                    <nn-button :loading="loading" @click="loadWorkspace()">
                        <template #icon><ReloadOutlined /></template>
                        刷新
                    </nn-button>
                    <nn-button class="execution-history-trigger" @click="executionHistoryOpen = true">
                        <template #icon><ClockCircleOutlined /></template>
                        执行记录
                    </nn-button>
                    <nn-button
                        danger
                        :disabled="operationExecuting || (!compileId && workspaceModules.length === 0)"
                        @click="clearWorkspace"
                    >
                        <template #icon><DeleteOutlined /></template>
                        清空
                    </nn-button>
                </div>
                <div class="workspace-context">
                    <span v-if="compileId" class="compile-id" :title="compileId">Compile ID: {{ compileId }}</span>
                    <span v-if="workspaceSummary.cacheHit" class="cache-hint">缓存命中</span>
                </div>
            </div>

            <div
                ref="workspaceLayoutRef"
                class="workspace-layout"
                :class="{ 'workspace-layout-empty': !compileId }"
                :style="workspaceLayoutStyle"
            >
                <section class="schema-panel">
                    <div class="panel-header">
                        <div class="panel-heading">
                            <span class="panel-title">Schema 索引</span>
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
                                @right-click="handleTreeRightClick"
                            >
                                <template #title="node">
                                    <span class="schema-node-title">
                                        <span
                                            class="schema-node-icon"
                                            :class="`schema-node-icon-${schemaNodeIconKind(node)}`"
                                            :data-node-icon="schemaNodeIconKind(node)"
                                            aria-hidden="true"
                                        >
                                            <component
                                                :is="schemaNodeIconComponent(node)"
                                                :spin="node.loading"
                                                :stroke-width="1.8"
                                            />
                                        </span>
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

                <div
                    class="workspace-column-resizer"
                    role="separator"
                    aria-label="调整 Schema 树宽度"
                    aria-orientation="vertical"
                    :aria-valuemin="schemaPaneMinWidth"
                    :aria-valuemax="schemaPaneMaxWidth"
                    :aria-valuenow="schemaPaneWidth"
                    tabindex="0"
                    title="拖动调整 Schema 树宽度；双击恢复默认宽度"
                    @pointerdown="startSchemaPaneResize"
                    @keydown="handleSchemaPaneResizeKeydown"
                    @dblclick="resetSchemaPaneResize"
                >
                    <span class="pane-resizer-grip" aria-hidden="true" />
                </div>

                <section class="workspace-operation-panel">
                    <YangOperations
                        embedded
                        :operation="operationContext.operation"
                        :compile-id="compileId"
                        :schema-tree="treeData"
                        :context-revision="operationContextRevision"
                        :context-node="operationContext.node || deviceOperationRoot"
                        :context-subtree="operationContext.subtree"
                        :context-config="operationContext.config"
                        :context-raw-rpc="operationContext.rawRpc"
                        :context-params="operationContext.params"
                        @executing-change="handleOperationExecutingChange"
                    />
                </section>
            </div>
        </nn-card>

        <div
            v-if="contextMenu.visible"
            ref="contextMenuRef"
            class="schema-context-menu"
            :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
            @click.stop
        >
            <div class="schema-context-menu-title">
                <span>{{ contextMenu.node?.name || contextMenu.node?.title || 'Schema 节点' }}</span>
                <span class="schema-context-menu-keyword">
                    {{ contextMenu.node?.keyword || contextMenu.node?.kind || '-' }}
                </span>
            </div>
            <div class="schema-context-menu-path" :title="contextMenu.node?.path">
                {{ contextMenu.node?.path || '设备级操作' }}
            </div>
            <nn-menu
                class="schema-context-menu-list"
                submenu-mode="popup"
                :items="schemaContextMenuItems"
                :selectable="false"
                @click="handleContextMenuClick"
            />
            <div class="schema-context-menu-hint">
                {{ contextMenuHint }}
            </div>
        </div>

        <nn-modal
            v-model:open="nodePropertyOpen"
            :title="nodePropertyTitle"
            :footer="null"
            width="760px"
            :body-style="{ padding: '12px', overflow: 'hidden' }"
        >
            <div class="node-property-scroll">
                <nn-spin :spinning="detailLoading">
                    <nn-descriptions v-if="detailNode" :column="2" bordered size="small">
                        <nn-descriptions-item label="名称">
                            {{ detailNode.name || detailNode.title || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="关键字">
                            {{ detailNode.keyword || detailNode.kind || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="模块">
                            {{ detailNode.module || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="数据类型">
                            {{ formatNodeType(detailNode.type) }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="访问">
                            {{ detailNode.config === false ? 'state / config false' : 'config true' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="Mandatory">
                            {{ formatBoolean(detailNode.mandatory) }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="Status">
                            {{ detailNode.status || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="Units">
                            {{ detailNode.units || '-' }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="Default" :span="2">
                            {{ formatValue(detailNode.default) }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="If Feature" :span="2">
                            {{ formatValue(detailNode.ifFeatures) }}
                        </nn-descriptions-item>
                        <nn-descriptions-item label="Schema 路径" :span="2">
                            <nn-typography-text copyable>{{ detailNode.path || '-' }}</nn-typography-text>
                        </nn-descriptions-item>
                        <nn-descriptions-item label="描述" :span="2">
                            <span class="detail-description">{{ detailNode.description || '-' }}</span>
                        </nn-descriptions-item>
                    </nn-descriptions>
                </nn-spin>
            </div>
        </nn-modal>

        <YangExecutionHistoryDrawer v-model:open="executionHistoryOpen" />
    </div>
</template>

<script setup>
    import { computed, h, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from 'vue';
    import { useRouter } from 'vue-router';
    import {
        NETCONF_CAPABILITY_HINTS,
        NETCONF_SESSION_STATUS,
        YANG_EVENT,
        YANG_EVENT_PAGE_ID,
        YANG_ROUTE
    } from '../../const/yangConst';
    import EventBus from '../../utils/eventBus';
    import { dialog } from '../../utils/dialog';
    import { notify } from '../../utils/notify';
    import {
        ApiOutlined,
        BellOutlined,
        ClockCircleOutlined,
        CloudServerOutlined,
        ClusterOutlined,
        CodeOutlined,
        CopyOutlined,
        DeleteOutlined,
        EditOutlined,
        EyeOutlined,
        FileSearchOutlined,
        FileTextOutlined,
        FolderOpenOutlined,
        FolderOutlined,
        KeyOutlined,
        LoadingOutlined,
        ReloadOutlined,
        SafetyOutlined,
        SendOutlined,
        UnorderedListOutlined
    } from '../../ui/icons';
    import YangExecutionHistoryDrawer from './YangExecutionHistoryDrawer.vue';
    import YangOperations from './YangOperations.vue';
    import {
        invokeBridge,
        isTaskTerminal,
        normalizeCapability,
        normalizeSessionEvent,
        unwrapArray
    } from './yangUiUtils';
    import { usePaneResize } from './usePaneResize';

    defineOptions({ name: 'YangWorkspace' });

    const router = useRouter();
    const DATA_NODE_KEYWORDS = new Set(['container', 'list', 'leaf', 'leaf-list', 'anydata', 'anyxml']);
    const RPC_NODE_KEYWORDS = new Set(['rpc', 'action']);
    const LEAF_NODE_KEYWORDS = new Set(['leaf', 'leaf-list', 'anydata', 'anyxml']);
    const CONTEXT_MENU_MARGIN = 8;
    const SCHEMA_NODE_ICONS = Object.freeze({
        device: CloudServerOutlined,
        module: CodeOutlined,
        container: FolderOutlined,
        list: UnorderedListOutlined,
        key: KeyOutlined,
        leaf: FileTextOutlined,
        state: EyeOutlined,
        operation: ApiOutlined,
        notification: BellOutlined,
        branch: ClusterOutlined,
        io: SendOutlined,
        loading: LoadingOutlined,
        fallback: FileSearchOutlined
    });

    const loading = ref(false);
    const treeLoading = ref(false);
    const compileId = ref('');
    const schemaStatus = ref('none');
    const schemaStatusMessage = ref('');
    const workspaceSummary = ref({ moduleCount: 0, nodeCount: 0, cacheHit: false });
    const workspaceModules = ref([]);
    const treeData = ref([]);
    const expandedKeys = ref([]);
    const selectedKeys = ref([]);
    const detailNode = ref(null);
    const detailLoading = ref(false);
    const treeQuery = ref('');
    const session = ref({ status: NETCONF_SESSION_STATUS.DISCONNECTED, connected: false, capabilities: [] });
    const contextMenuRef = ref(null);
    const contextMenu = reactive({ visible: false, x: 0, y: 0, node: null });
    const operationContext = reactive({
        operation: 'get',
        node: null,
        subtree: '',
        config: '',
        rawRpc: '',
        params: {}
    });
    const operationContextRevision = ref(0);
    const operationExecuting = ref(false);
    const nodePropertyOpen = ref(false);
    const executionHistoryOpen = ref(false);
    const workspaceLayoutRef = ref(null);
    const {
        paneSize: schemaPaneWidth,
        minSize: schemaPaneMinWidth,
        maxSize: schemaPaneMaxWidth,
        resizing: schemaPaneResizing,
        startResize: startSchemaPaneResize,
        handleResizeKeydown: handleSchemaPaneResizeKeydown,
        resetResize: resetSchemaPaneResize,
        stopResize: stopSchemaPaneResize
    } = usePaneResize({
        containerRef: workspaceLayoutRef,
        orientation: 'vertical',
        defaultRatio: 0,
        minFirst: 320,
        minSecond: 420,
        dividerSize: 8,
        activeWhen: () => window.matchMedia('(min-width: 981px)').matches
    });
    let contextMenuOpenRequest = 0;
    let detailRequestRevision = 0;
    let workspaceRequestRevision = 0;
    let schemaRootsPromise = null;
    let schemaRootsPromiseCompileId = '';
    let schemaRestoreFailedCompileId = '';
    let clearWorkspaceConfirmHandle = null;

    const normalizeModule = (module, index) => {
        if (typeof module === 'string') return { id: '', name: module, revision: '', _key: module };
        const metadata = module?.metadata || {};
        const name = module?.name || module?.moduleName || metadata.name || `module-${index}`;
        const revision = module?.revision || module?.revisionDate || metadata.revision || '';
        const id = module?.id || module?.moduleId || module?.hash || '';
        return { ...module, id, name, revision, _key: id || `${name}@${revision || 'none'}` };
    };

    const schemaNodeKeyword = node =>
        String(node?.keyword || node?.kind || '')
            .trim()
            .toLowerCase();
    const schemaLocalName = value => {
        const name = String(value || '').trim();
        return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
    };
    const normalizeSchemaKeys = value => {
        const values = Array.isArray(value) ? value : String(value || '').split(/\s+/u);
        return [...new Set(values.map(schemaLocalName).filter(name => /^[A-Za-z_][\w.-]*$/u.test(name)))];
    };
    const schemaChildContext = node => ({
        parentKeyword: schemaNodeKeyword(node),
        listKeys: schemaNodeKeyword(node) === 'list' ? normalizeSchemaKeys(node?.schemaKey) : []
    });

    const normalizeNode = (node, index = 0, parentContext = {}) => {
        const id = node?.id || node?.nodeId || node?.key || `${node?.path || node?.name || 'node'}-${index}`;
        const hasChildren = Boolean(node?.hasChildren || Number(node?.childCount || 0) > 0 || node?.children?.length);
        const keyword = node?.keyword || node?.kind || '';
        const normalizedKeyword = String(keyword).trim().toLowerCase();
        const name = node?.name || node?.title || '';
        const schemaKey = node?.schemaKey ?? node?.listKey ?? node?.listKeys ?? [];
        const parentListKeys = Array.isArray(parentContext.listKeys) ? parentContext.listKeys : [];
        const isListKey = Boolean(
            node?.isListKey === true ||
                node?.isKey === true ||
                node?.keyLeaf === true ||
                (normalizedKeyword === 'leaf' &&
                    parentContext.parentKeyword === 'list' &&
                    parentListKeys.includes(schemaLocalName(name)))
        );
        const childContext = {
            parentKeyword: normalizedKeyword,
            listKeys: normalizedKeyword === 'list' ? normalizeSchemaKeys(schemaKey) : []
        };
        return {
            ...node,
            id,
            key: id,
            title: node?.title || node?.name || node?.keyword || id,
            name,
            keyword,
            schemaKey,
            isListKey,
            isLeaf: !hasChildren,
            children: Array.isArray(node?.children)
                ? node.children.map((child, childIndex) => normalizeNode(child, childIndex, childContext))
                : [],
            childrenLoaded: Array.isArray(node?.children) && node.children.length > 0,
            loading: false
        };
    };

    const schemaNodeIconKind = node => {
        if (node?.loading) return 'loading';
        if (node?.virtualDevice) return 'device';
        if (node?.isListKey) return 'key';
        const keyword = schemaNodeKeyword(node);
        if (['module', 'submodule'].includes(keyword)) return 'module';
        if (keyword === 'container') return 'container';
        if (keyword === 'list') return 'list';
        if (node?.config === false && LEAF_NODE_KEYWORDS.has(keyword)) return 'state';
        if (LEAF_NODE_KEYWORDS.has(keyword)) return 'leaf';
        if (RPC_NODE_KEYWORDS.has(keyword)) return 'operation';
        if (keyword === 'notification') return 'notification';
        if (['choice', 'case'].includes(keyword)) return 'branch';
        if (['input', 'output'].includes(keyword)) return 'io';
        return 'fallback';
    };

    const schemaNodeIconComponent = node => {
        const kind = schemaNodeIconKind(node);
        if (kind === 'container' && expandedKeys.value.includes(node?.key)) return FolderOpenOutlined;
        return SCHEMA_NODE_ICONS[kind] || SCHEMA_NODE_ICONS.fallback;
    };

    const capabilities = computed(() => {
        const values = session.value.capabilities || session.value.serverCapabilities || [];
        return [...new Set(unwrapArray(values).map(normalizeCapability).filter(Boolean))];
    });
    const connected = computed(() => {
        const status = session.value.status || session.value.state;
        return session.value.connected === true || status === NETCONF_SESSION_STATUS.CONNECTED;
    });
    const workspaceLayoutStyle = computed(() =>
        schemaPaneWidth.value > 0 ? { '--schema-pane-width': `${schemaPaneWidth.value}px` } : undefined
    );
    const nodePropertyTitle = computed(() => {
        const nodeName = detailNode.value?.name || detailNode.value?.title;
        return nodeName ? `节点属性 · ${nodeName}` : '节点属性';
    });
    const contextMenuHint = computed(() => {
        if (operationExecuting.value) return '设备操作执行中，请等待 rpc-reply 后再切换操作';
        if (!connected.value) return '设备未连接；Schema 仍可查看，设备操作需先建立连接';
        const node = contextMenu.node;
        if (node?.config === false) return 'state 节点只允许 get；datastore 操作作用于整个配置存储';
        if (isRpcNode(node)) return `${node.keyword} 将以原始 RPC 草稿打开，请确认实例路径和参数`;
        return '节点操作会自动预填 XML；Candidate 工作区和配置存储菜单始终作用于整个 datastore';
    });
    const deviceOperationRoot = computed(() => ({
        id: 'netconf-device-root',
        key: 'netconf-device-root',
        title: `当前设备：${session.value.profileName || session.value.host || 'NETCONF'}`,
        name: session.value.profileName || session.value.host || '当前设备',
        keyword: 'device',
        virtualDevice: true,
        selectable: false,
        isLeaf: true,
        children: []
    }));
    const displayTree = computed(() => {
        const query = treeQuery.value.trim().toLowerCase();
        if (!query) return [deviceOperationRoot.value, ...treeData.value];
        const filterNodes = nodes =>
            nodes.flatMap(node => {
                const children = filterNodes(node.children || []);
                const haystack = [node.title, node.module, node.path, node.keyword].join(' ').toLowerCase();
                if (haystack.includes(query) || children.length) return [{ ...node, children }];
                return [];
            });
        return [deviceOperationRoot.value, ...filterNodes(treeData.value)];
    });
    const resetOperationContext = () => {
        Object.assign(operationContext, {
            operation: 'get',
            node: null,
            subtree: '',
            config: '',
            rawRpc: '',
            params: {}
        });
        operationContextRevision.value += 1;
    };
    const applyWorkspace = (data, { preserveTree = false } = {}) => {
        const workspace = data?.workspace || data || {};
        const nextCompileId = workspace.compileId || workspace.id || '';
        if (nextCompileId !== compileId.value) {
            schemaRestoreFailedCompileId = '';
            schemaStatusMessage.value = '';
        }
        compileId.value = nextCompileId;
        const summary = workspace.summary || {};
        const nextModules = unwrapArray(workspace.modules, ['modules']);
        workspaceModules.value = nextModules.map(normalizeModule);
        const schemaTree = workspace.schemaTree || {};
        const authoritativeSchema = schemaTree.authoritative === true && schemaTree.source === 'libyang-effective';
        const workspaceSucceeded = workspace.success === true || workspace.validation?.succeeded === true;
        const workspaceFailed = workspace.success === false;
        if (!compileId.value) {
            schemaStatus.value = 'none';
            schemaStatusMessage.value = '';
        } else if (workspaceFailed) {
            schemaStatus.value = 'compile-failed';
            schemaStatusMessage.value = '';
        } else if (authoritativeSchema && workspaceSucceeded) {
            schemaStatus.value = 'ready';
            schemaStatusMessage.value = '';
            schemaRestoreFailedCompileId = '';
        } else if (preserveTree && treeData.value.length && workspaceSucceeded) {
            schemaStatus.value = 'ready';
        } else if (workspaceSucceeded) {
            schemaStatus.value = schemaRestoreFailedCompileId === compileId.value ? 'restore-failed' : 'restoring';
        } else {
            schemaStatus.value = 'unknown';
        }
        const inlineRoots = authoritativeSchema
            ? unwrapArray(schemaTree.roots || workspace.roots, ['nodes', 'roots'])
            : [];
        if (!preserveTree) treeData.value = inlineRoots.map((node, index) => normalizeNode(node, index));
        workspaceSummary.value = {
            ...workspaceSummary.value,
            ...summary,
            cacheHit: Boolean(workspace.cacheHit || summary.cacheHit),
            moduleCount: Number(
                summary.moduleCount ?? workspace.modules?.length ?? workspaceSummary.value.moduleCount ?? 0
            ),
            nodeCount:
                authoritativeSchema || preserveTree || workspaceSucceeded
                    ? Number(summary.nodeCount ?? schemaTree.nodeCount ?? workspaceSummary.value.nodeCount ?? 0)
                    : 0
        };
    };

    const loadRoots = async ({ force = false } = {}) => {
        if (!compileId.value) {
            treeData.value = [];
            schemaStatus.value = 'none';
            schemaStatusMessage.value = '';
            return false;
        }
        const requestedCompileId = compileId.value;
        if (!force && schemaRestoreFailedCompileId === requestedCompileId) return false;
        if (schemaRootsPromise && schemaRootsPromiseCompileId === requestedCompileId) return schemaRootsPromise;

        schemaStatus.value = 'restoring';
        schemaStatusMessage.value = '';
        treeLoading.value = true;
        schemaRootsPromiseCompileId = requestedCompileId;
        const request = (async () => {
            try {
                const { data } = await invokeBridge('yangApi', 'getSchemaRoots', {
                    compileId: requestedCompileId
                });
                if (compileId.value !== requestedCompileId) return false;
                treeData.value = unwrapArray(data, ['nodes', 'roots']).map((node, index) => normalizeNode(node, index));
                schemaStatus.value = 'ready';
                schemaStatusMessage.value = '';
                schemaRestoreFailedCompileId = '';
                return true;
            } catch (error) {
                if (compileId.value !== requestedCompileId) return false;
                schemaStatus.value = 'restore-failed';
                schemaStatusMessage.value = error.message;
                schemaRestoreFailedCompileId = requestedCompileId;
                notify.error(`恢复 Schema 树失败：${error.message}`);
                return false;
            } finally {
                if (schemaRootsPromiseCompileId === requestedCompileId) {
                    treeLoading.value = false;
                    schemaRootsPromise = null;
                    schemaRootsPromiseCompileId = '';
                }
            }
        })();
        schemaRootsPromise = request;
        return request;
    };

    const workspaceHasSuccessfulCompilation = workspace =>
        Boolean(
            (workspace?.compileId || workspace?.id) &&
                (workspace?.success === true || workspace?.validation?.succeeded === true)
        );

    const loadWorkspace = async ({ preserveTree = false, retrySchemaRestore = true } = {}) => {
        const requestRevision = ++workspaceRequestRevision;
        loading.value = true;
        const previousCompileId = compileId.value;
        try {
            const { data } = await invokeBridge('yangApi', 'getWorkspace');
            if (requestRevision !== workspaceRequestRevision) return;
            const workspace = data?.workspace || data || {};
            const nextCompileId = workspace.compileId || workspace.id || '';
            const preserveExistingTree = Boolean(
                preserveTree &&
                    previousCompileId &&
                    previousCompileId === nextCompileId &&
                    workspace.success !== false &&
                    treeData.value.length
            );

            if (!preserveExistingTree) {
                workspaceModules.value = [];
                treeData.value = [];
                expandedKeys.value = [];
                selectedKeys.value = [];
                detailRequestRevision += 1;
                detailNode.value = null;
                detailLoading.value = false;
                nodePropertyOpen.value = false;
            }

            applyWorkspace(data, { preserveTree: preserveExistingTree });
            if (!preserveExistingTree && previousCompileId && previousCompileId !== compileId.value) {
                resetOperationContext();
            }
            if (
                workspaceHasSuccessfulCompilation(workspace) &&
                treeData.value.length === 0 &&
                schemaStatus.value !== 'ready'
            ) {
                await loadRoots({ force: retrySchemaRestore });
            }
            if (workspaceModules.value.length === 0) await loadWorkspaceModules();
        } catch (error) {
            if (requestRevision === workspaceRequestRevision) {
                notify.error(`加载 Schema 工作区失败：${error.message}`);
            }
        } finally {
            if (requestRevision === workspaceRequestRevision) loading.value = false;
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
            // The tree remains usable when module metadata enumeration is unavailable.
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

    const findNodeChain = (nodes, key, ancestors = []) => {
        for (const node of nodes) {
            const chain = [...ancestors, node];
            if (node.key === key) return chain;
            const found = findNodeChain(node.children || [], key, chain);
            if (found.length) return found;
        }
        return [];
    };

    const isDataNode = node => DATA_NODE_KEYWORDS.has(String(node?.keyword || node?.kind || '').toLowerCase());
    const isConfigDataNode = node => isDataNode(node) && node?.config !== false;
    const isRpcNode = node => RPC_NODE_KEYWORDS.has(String(node?.keyword || node?.kind || '').toLowerCase());
    const capabilityIncludes = hint =>
        capabilities.value.some(capability => capability.toLowerCase().includes(hint.toLowerCase()));
    const hasCapability = name => capabilityIncludes(NETCONF_CAPABILITY_HINTS[name] || name);

    const operationDisabledReason = (operation, node = null, params = {}) => {
        if (operationExecuting.value) return '设备操作执行中，请等待 rpc-reply';
        if (!connected.value) return '请先建立 NETCONF 会话';
        if (operation === 'get-config' && isDataNode(node) && node?.config === false) {
            return 'state 节点不属于配置 datastore';
        }
        if (operation === 'edit-config' && !isConfigDataNode(node)) {
            return '只有 config 数据节点可以编辑';
        }
        const hasEditableDatastore = hasCapability('candidate') || hasCapability('writableRunning');
        const hasCopyTarget = hasEditableDatastore || hasCapability('startup');
        if (operation === 'edit-config' && !hasEditableDatastore) {
            return '设备未声明 :candidate 或 :writable-running 能力';
        }
        if (operation === 'copy-config' && !hasCopyTarget) return '设备没有可复制的目标 datastore';
        if (operation === 'delete-config' && !hasCapability('startup')) {
            return '标准 delete-config 需要设备声明 :startup 能力';
        }
        if (operation === 'validate' && !hasCapability('validate')) return '设备未声明 :validate 能力';
        if (['commit', 'cancel-commit', 'discard-changes'].includes(operation) && !hasCapability('candidate')) {
            return '设备未声明 :candidate 能力';
        }
        if (operation === 'cancel-commit' && !hasCapability('confirmedCommit')) {
            return '设备未声明 :confirmed-commit 能力';
        }
        if (operation === 'commit' && params.confirmed && !hasCapability('confirmedCommit')) {
            return '设备未声明 :confirmed-commit 能力';
        }

        const source = params.source || params.copySource || params.validateSource;
        const target = params.target || params.copyTarget || params.deleteTarget || params.lockTarget;
        const datastoreCapabilityReason = datastore => {
            if (datastore === 'candidate' && !hasCapability('candidate')) return '设备未声明 :candidate 能力';
            if (datastore === 'startup' && !hasCapability('startup')) return '设备未声明 :startup 能力';
            return '';
        };
        const sourceReason = datastoreCapabilityReason(source);
        if (sourceReason) return sourceReason;
        const targetReason = datastoreCapabilityReason(target);
        if (targetReason) return targetReason;
        if (operation === 'edit-config' && target === 'running' && !hasCapability('writableRunning')) {
            return '设备未声明 :writable-running 能力';
        }
        if (operation === 'copy-config' && target === 'running' && !hasCapability('writableRunning')) {
            return '设备未声明 :writable-running 能力';
        }
        return '';
    };

    const menuIcon = component => () => h(component, { strokeWidth: 1.8 });
    const operationMenuItem = ({ key, label, operation, icon, scope = 'node', params = {} }) => {
        const node = scope === 'node' ? contextMenu.node : null;
        const disabledReason = operationDisabledReason(operation, node, params);
        return {
            key,
            label,
            icon: menuIcon(icon),
            disabled: Boolean(disabledReason),
            title: disabledReason || label,
            action: { type: 'operation', operation, scope, params }
        };
    };
    const allMenuActionsDisabled = items =>
        items
            .filter(item => item?.type !== 'divider')
            .every(item => item.disabled || (item.children?.length && allMenuActionsDisabled(item.children)));

    const schemaContextMenuItems = computed(() => {
        const node = contextMenu.node;
        if (!node) return [];

        const getConfigChildren = [
            operationMenuItem({
                key: 'get-config:running',
                label: 'Running',
                operation: 'get-config',
                icon: FileSearchOutlined,
                params: { source: 'running' }
            })
        ];
        if (hasCapability('candidate')) {
            getConfigChildren.push(
                operationMenuItem({
                    key: 'get-config:candidate',
                    label: 'Candidate',
                    operation: 'get-config',
                    icon: FileSearchOutlined,
                    params: { source: 'candidate' }
                })
            );
        }
        if (hasCapability('startup')) {
            getConfigChildren.push(
                operationMenuItem({
                    key: 'get-config:startup',
                    label: 'Startup',
                    operation: 'get-config',
                    icon: FileSearchOutlined,
                    params: { source: 'startup' }
                })
            );
        }

        const editConfigChildren = [];
        if (hasCapability('candidate')) {
            editConfigChildren.push(
                operationMenuItem({
                    key: 'edit-config:candidate',
                    label: 'Candidate',
                    operation: 'edit-config',
                    icon: EditOutlined,
                    params: { target: 'candidate' }
                })
            );
        }
        if (hasCapability('writableRunning')) {
            editConfigChildren.push(
                operationMenuItem({
                    key: 'edit-config:running',
                    label: 'Running',
                    operation: 'edit-config',
                    icon: EditOutlined,
                    params: { target: 'running' }
                })
            );
        }

        const candidateChildren = [];
        if (hasCapability('validate')) {
            candidateChildren.push(
                operationMenuItem({
                    key: 'candidate:validate',
                    label: '校验 Candidate（validate）',
                    operation: 'validate',
                    icon: CodeOutlined,
                    scope: 'datastore',
                    params: { validateSource: 'candidate' }
                })
            );
        }
        candidateChildren.push(
            operationMenuItem({
                key: 'candidate:commit',
                label: '提交整个 Candidate → Running',
                operation: 'commit',
                icon: SendOutlined,
                scope: 'datastore',
                params: { confirmed: false }
            })
        );
        if (hasCapability('confirmedCommit')) {
            candidateChildren.push(
                operationMenuItem({
                    key: 'candidate:confirmed-commit',
                    label: 'Confirmed Commit → Running…',
                    operation: 'commit',
                    icon: SendOutlined,
                    scope: 'datastore',
                    params: { confirmed: true }
                }),
                operationMenuItem({
                    key: 'candidate:cancel-commit',
                    label: '取消 Confirmed Commit',
                    operation: 'cancel-commit',
                    icon: DeleteOutlined,
                    scope: 'datastore'
                })
            );
        }
        candidateChildren.push(
            operationMenuItem({
                key: 'candidate:discard',
                label: '放弃全部未提交修改',
                operation: 'discard-changes',
                icon: DeleteOutlined,
                scope: 'datastore'
            }),
            { type: 'divider', key: 'candidate-divider-lock' },
            operationMenuItem({
                key: 'candidate:lock',
                label: '锁定 Candidate',
                operation: 'lock',
                icon: SafetyOutlined,
                scope: 'datastore',
                params: { lockTarget: 'candidate' }
            }),
            operationMenuItem({
                key: 'candidate:unlock',
                label: '解锁 Candidate',
                operation: 'unlock',
                icon: SafetyOutlined,
                scope: 'datastore',
                params: { lockTarget: 'candidate' }
            })
        );

        const validateChildren = [
            operationMenuItem({
                key: 'datastore:validate:running',
                label: 'Running',
                operation: 'validate',
                icon: CodeOutlined,
                scope: 'datastore',
                params: { validateSource: 'running' }
            })
        ];
        if (hasCapability('startup')) {
            validateChildren.push(
                operationMenuItem({
                    key: 'datastore:validate:startup',
                    label: 'Startup',
                    operation: 'validate',
                    icon: CodeOutlined,
                    scope: 'datastore',
                    params: { validateSource: 'startup' }
                })
            );
        }
        const lockChildren = ['running', ...(hasCapability('startup') ? ['startup'] : [])].map(datastore =>
            operationMenuItem({
                key: `datastore:lock:${datastore}`,
                label: datastore === 'running' ? 'Running' : 'Startup',
                operation: 'lock',
                icon: SafetyOutlined,
                scope: 'datastore',
                params: { lockTarget: datastore }
            })
        );
        const unlockChildren = ['running', ...(hasCapability('startup') ? ['startup'] : [])].map(datastore =>
            operationMenuItem({
                key: `datastore:unlock:${datastore}`,
                label: datastore === 'running' ? 'Running' : 'Startup',
                operation: 'unlock',
                icon: SafetyOutlined,
                scope: 'datastore',
                params: { lockTarget: datastore }
            })
        );
        const datastoreChildren = [
            operationMenuItem({
                key: 'datastore:copy-config',
                label: '复制配置存储（copy-config）…',
                operation: 'copy-config',
                icon: CopyOutlined,
                scope: 'datastore'
            })
        ];
        if (hasCapability('validate')) {
            datastoreChildren.push({
                key: 'datastore:validate',
                label: '校验配置（validate）',
                icon: menuIcon(CodeOutlined),
                disabled: allMenuActionsDisabled(validateChildren),
                children: validateChildren
            });
        }
        datastoreChildren.push(
            {
                key: 'datastore:lock',
                label: '锁定配置存储（lock）',
                icon: menuIcon(SafetyOutlined),
                disabled: allMenuActionsDisabled(lockChildren),
                children: lockChildren
            },
            {
                key: 'datastore:unlock',
                label: '解锁配置存储（unlock）',
                icon: menuIcon(SafetyOutlined),
                disabled: allMenuActionsDisabled(unlockChildren),
                children: unlockChildren
            }
        );
        if (hasCapability('startup')) {
            const startupChildren = [
                operationMenuItem({
                    key: 'startup:save-running',
                    label: '保存 Running → Startup',
                    operation: 'copy-config',
                    icon: CopyOutlined,
                    scope: 'datastore',
                    params: { copySource: 'running', copyTarget: 'startup' }
                }),
                operationMenuItem({
                    key: 'startup:delete',
                    label: '删除整个 Startup…',
                    operation: 'delete-config',
                    icon: DeleteOutlined,
                    scope: 'datastore',
                    params: { deleteTarget: 'startup' }
                })
            ];
            datastoreChildren.push({
                key: 'datastore:startup',
                label: 'Startup',
                icon: menuIcon(FileSearchOutlined),
                disabled: allMenuActionsDisabled(startupChildren),
                children: startupChildren
            });
        }

        const items = [
            {
                key: 'node-properties',
                label: '查看节点属性',
                icon: menuIcon(EyeOutlined),
                disabled: Boolean(node.virtualDevice),
                action: { type: 'properties' }
            },
            {
                key: 'copy-path',
                label: '复制 Schema 路径',
                icon: menuIcon(CopyOutlined),
                disabled: !node.path,
                action: { type: 'copy-path' }
            },
            { type: 'divider', key: 'node-divider-read' },
            operationMenuItem({
                key: 'get',
                label: isDataNode(node) ? '读取当前节点（get）' : '读取全部数据（get）',
                operation: 'get',
                icon: ApiOutlined
            }),
            {
                key: 'get-config',
                label: isConfigDataNode(node) ? '读取节点配置（get-config）' : '读取配置（get-config）',
                icon: menuIcon(FileSearchOutlined),
                disabled: allMenuActionsDisabled(getConfigChildren),
                children: getConfigChildren
            }
        ];
        if (editConfigChildren.length) {
            items.push({
                key: 'edit-config',
                label: '编辑当前节点（edit-config）',
                icon: menuIcon(EditOutlined),
                disabled: allMenuActionsDisabled(editConfigChildren),
                children: editConfigChildren
            });
        }
        items.push({ type: 'divider', key: 'node-divider-datastore' });
        if (hasCapability('candidate')) {
            items.push({
                key: 'candidate-workspace',
                label: 'Candidate 工作区',
                icon: menuIcon(EditOutlined),
                disabled: allMenuActionsDisabled(candidateChildren),
                children: candidateChildren
            });
        }
        items.push(
            {
                key: 'datastore-workspace',
                label: '配置存储',
                icon: menuIcon(SafetyOutlined),
                disabled: allMenuActionsDisabled(datastoreChildren),
                children: datastoreChildren
            },
            { type: 'divider', key: 'node-divider-advanced' },
            operationMenuItem({
                key: 'raw-rpc',
                label: isRpcNode(node) ? `执行 ${node.keyword}` : '原始 RPC',
                operation: 'raw-rpc',
                icon: CodeOutlined
            })
        );
        if (!connected.value) {
            items.push({
                key: 'connection',
                label: '前往连接设置',
                icon: menuIcon(ApiOutlined),
                action: { type: 'connection' }
            });
        }
        return items;
    });

    const moduleForNode = node =>
        workspaceModules.value.find(module => module.name === node?.module || module.id === node?.moduleId);

    const namespaceForNode = node =>
        node?.namespace || moduleForNode(node)?.namespace || moduleForNode(node)?.metadata?.namespace || '';

    const escapeXmlAttribute = value =>
        String(value || '')
            .replaceAll('&', '&amp;')
            .replaceAll('"', '&quot;')
            .replaceAll('<', '&lt;');

    const schemaPathSegments = node => {
        const path = String(node?.path || '');
        const segments = path
            .split('/')
            .filter(Boolean)
            .map(segment => segment.replace(/\[[^\]]*\]$/u, ''));
        if (segments[0] === node?.module) segments.shift();
        return segments
            .map(segment => (segment.includes(':') ? segment.slice(segment.lastIndexOf(':') + 1) : segment))
            .filter(segment => /^[A-Za-z_][\w.-]*$/u.test(segment));
    };

    const schemaNodeChain = node => {
        const loadedChain = findNodeChain(treeData.value, node?.key).filter(isDataNode);
        if (loadedChain.length) return loadedChain;
        const segments = schemaPathSegments(node);
        return segments.map((name, index) => ({
            ...node,
            name,
            title: name,
            keyword: index === segments.length - 1 ? node?.keyword : 'container'
        }));
    };

    const buildNodeXml = (node, mode = 'filter') => {
        if (!isDataNode(node)) return '';
        const chain = schemaNodeChain(node);
        if (chain.length === 0) return '';
        const render = (index, depth) => {
            const current = chain[index];
            const name = String(current?.name || current?.title || 'node');
            const indentation = '  '.repeat(depth);
            const parent = chain[index - 1];
            const namespace = namespaceForNode(current);
            const namespaceAttribute =
                namespace && (index === 0 || current?.module !== parent?.module)
                    ? ` xmlns="${escapeXmlAttribute(namespace)}"`
                    : '';
            const keyword = String(current?.keyword || '').toLowerCase();
            const isLast = index === chain.length - 1;
            if (mode === 'filter' && isLast) return `${indentation}<${name}${namespaceAttribute}/>`;

            const body = [];
            if (mode === 'config' && keyword === 'list') {
                const rawKeys = Array.isArray(current?.schemaKey)
                    ? current.schemaKey
                    : String(current?.schemaKey || '').split(/\s+/u);
                const keys = rawKeys
                    .map(value => (value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value))
                    .filter(value => /^[A-Za-z_][\w.-]*$/u.test(value));
                const nextName = chain[index + 1]?.name;
                if (keys.length) {
                    keys.filter(key => key !== nextName).forEach(key => {
                        body.push(
                            `${'  '.repeat(depth + 1)}<${key}><!-- NETNEXUS_REQUIRED: 输入 list key 值 --></${key}>`
                        );
                    });
                } else {
                    body.push(`${'  '.repeat(depth + 1)}<!-- NETNEXUS_REQUIRED: 补充 list "${name}" 的所有 key -->`);
                }
            }
            if (!isLast) {
                body.push(render(index + 1, depth + 1));
            } else if (mode === 'config' && ['leaf', 'leaf-list'].includes(keyword)) {
                const valueHint = typeof current?.type === 'string' && current.type ? `${current.type} 值` : '值';
                return `${indentation}<${name}${namespaceAttribute}><!-- NETNEXUS_REQUIRED: 输入${valueHint} --></${name}>`;
            } else if (mode === 'config' && keyword !== 'list') {
                body.push(`${'  '.repeat(depth + 1)}<!-- NETNEXUS_REQUIRED: 在此补充配置 -->`);
            }
            return `${indentation}<${name}${namespaceAttribute}>\n${body.join('\n')}\n${indentation}</${name}>`;
        };
        return render(0, 0);
    };

    const buildRawRpcDraft = node => {
        if (!isRpcNode(node)) {
            return '<get>\n  <filter type="subtree">\n    <!-- subtree filter -->\n  </filter>\n</get>';
        }
        const name = String(node?.name || node?.title || node?.keyword || 'rpc').replace(/[^\w.-]/gu, '');
        const namespace = namespaceForNode(node);
        const namespaceAttribute = namespace ? ` xmlns="${escapeXmlAttribute(namespace)}"` : '';
        return `<${name}${namespaceAttribute}>\n  <!-- NETNEXUS_REQUIRED: 根据 YANG input 补充参数；无参数时删除本注释 -->\n</${name}>`;
    };

    const getContextMenuPosition = (anchor, menuRect) => {
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const maxX = Math.max(CONTEXT_MENU_MARGIN, viewportWidth - menuRect.width - CONTEXT_MENU_MARGIN);
        const maxY = Math.max(CONTEXT_MENU_MARGIN, viewportHeight - menuRect.height - CONTEXT_MENU_MARGIN);
        return {
            x: Math.min(Math.max(CONTEXT_MENU_MARGIN, anchor.clientX), maxX),
            y: Math.min(Math.max(CONTEXT_MENU_MARGIN, anchor.clientY), maxY)
        };
    };

    const handleTreeRightClick = async ({ event, node }) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const openRequest = ++contextMenuOpenRequest;
        const key = node?.key || node?.eventKey || node?.dataRef?.key;
        const matchedNode = findNode(treeData.value, key) || node?.dataRef || node;
        if (!matchedNode?.key) return;

        selectedKeys.value = [matchedNode.key];
        nodePropertyOpen.value = false;
        contextMenu.node = matchedNode;
        const anchor = {
            clientX: Number.isFinite(event?.clientX) ? event.clientX : CONTEXT_MENU_MARGIN,
            clientY: Number.isFinite(event?.clientY) ? event.clientY : CONTEXT_MENU_MARGIN
        };
        contextMenu.x = Math.max(CONTEXT_MENU_MARGIN, anchor.clientX);
        contextMenu.y = Math.max(CONTEXT_MENU_MARGIN, anchor.clientY);
        contextMenu.visible = true;

        await nextTick();
        if (!contextMenuRef.value) await new Promise(resolve => window.requestAnimationFrame(resolve));
        if (!contextMenu.visible || openRequest !== contextMenuOpenRequest || !contextMenuRef.value) return;
        const position = getContextMenuPosition(anchor, contextMenuRef.value.getBoundingClientRect());
        contextMenu.x = position.x;
        contextMenu.y = position.y;
    };

    const hideContextMenu = () => {
        contextMenuOpenRequest += 1;
        contextMenu.visible = false;
    };

    const copyText = async (value, successMessage) => {
        if (!value) return;
        try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
            await navigator.clipboard.writeText(value);
            notify.success(successMessage);
        } catch (_error) {
            notify.warning('系统剪贴板不可用，请从节点详情中手动复制');
        }
    };

    const openOperation = (operation, { scope = 'node', params = {} } = {}) => {
        const contextNode = contextMenu.node;
        const node = scope === 'node' ? contextNode : null;
        const disabledReason = operationDisabledReason(operation, node, params);
        if (disabledReason) {
            notify.warning(disabledReason);
            return;
        }
        Object.assign(operationContext, {
            operation,
            node: node?.virtualDevice ? null : node,
            subtree: ['get', 'get-config', 'edit-config'].includes(operation) ? buildNodeXml(node, 'filter') : '',
            config: operation === 'edit-config' ? buildNodeXml(node, 'config') : '',
            rawRpc: operation === 'raw-rpc' ? buildRawRpcDraft(node) : '',
            params: { ...params }
        });
        operationContextRevision.value += 1;
    };

    const handleOperationExecutingChange = value => {
        operationExecuting.value = Boolean(value);
    };

    const handleContextMenuClick = ({ item }) => {
        const node = contextMenu.node;
        const action = item?.action;
        if (action?.type === 'properties') showNodeProperties(node);
        else if (action?.type === 'copy-path') copyText(node?.path, 'Schema 路径已复制');
        else if (action?.type === 'connection') router.push(YANG_ROUTE.CONNECTION);
        else if (action?.type === 'operation') openOperation(action.operation, action);
        hideContextMenu();
    };

    const loadSession = async () => {
        try {
            const { data } = await invokeBridge('netconfApi', 'getSessionState');
            session.value = { ...session.value, ...(data || {}) };
        } catch (error) {
            session.value = {
                status: NETCONF_SESSION_STATUS.DISCONNECTED,
                connected: false,
                capabilities: []
            };
            console.warn('Unable to load NETCONF session state:', error.message);
        }
    };

    const handleSessionEvent = payload => {
        session.value = normalizeSessionEvent(payload, session.value);
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
            const parentContext = schemaChildContext(node);
            node.children = unwrapArray(data, ['nodes', 'children']).map((child, index) =>
                normalizeNode(child, index, parentContext)
            );
            node.childrenLoaded = true;
            node.isLeaf = node.children.length === 0;
        } catch (error) {
            notify.error(`加载子节点失败：${error.message}`);
        } finally {
            node.loading = false;
            treeData.value = [...treeData.value];
        }
    };

    const showNodeProperties = async node => {
        if (!node || node.virtualDevice) return;
        const requestRevision = ++detailRequestRevision;
        detailNode.value = node;
        detailLoading.value = true;
        nodePropertyOpen.value = true;
        try {
            const { data } = await invokeBridge('yangApi', 'getSchemaNode', {
                compileId: compileId.value,
                nodeId: node.id || node.key
            });
            if (requestRevision === detailRequestRevision) detailNode.value = { ...node, ...(data || {}) };
        } catch (_error) {
            // The summary already carried by the tree node is sufficient for basic inspection.
        } finally {
            if (requestRevision === detailRequestRevision) detailLoading.value = false;
        }
    };

    const handleTreeSelect = (_keys, info) => {
        if (!info?.node) return;
        const fallbackNode = findNode(treeData.value, info.node.key) || info.node;
        selectedKeys.value = [fallbackNode.key];
    };

    const closeClearWorkspaceConfirm = () => {
        clearWorkspaceConfirmHandle?.destroy?.();
        clearWorkspaceConfirmHandle = null;
    };

    const clearWorkspace = () => {
        if (operationExecuting.value) {
            notify.warning('设备操作执行中，请等待 rpc-reply 后再清空工作区');
            return;
        }
        closeClearWorkspaceConfirm();
        clearWorkspaceConfirmHandle = dialog.confirm({
            title: '清空 Schema 工作区',
            content: '将清除当前编译上下文、Schema 索引和编译诊断；本地 YANG 源文件仍保留在模型库中。',
            okText: '清空',
            okType: 'danger',
            onCancel: () => {
                clearWorkspaceConfirmHandle = null;
            },
            onOk: async () => {
                try {
                    await invokeBridge('yangApi', 'clearWorkspace');
                    compileId.value = '';
                    schemaStatus.value = 'none';
                    schemaStatusMessage.value = '';
                    schemaRestoreFailedCompileId = '';
                    workspaceSummary.value = { moduleCount: 0, nodeCount: 0, cacheHit: false };
                    workspaceModules.value = [];
                    treeData.value = [];
                    expandedKeys.value = [];
                    selectedKeys.value = [];
                    detailRequestRevision += 1;
                    detailNode.value = null;
                    detailLoading.value = false;
                    nodePropertyOpen.value = false;
                    resetOperationContext();
                    notify.success('Schema 工作区已清空');
                } catch (error) {
                    notify.error(`清空失败：${error.message}`);
                } finally {
                    clearWorkspaceConfirmHandle = null;
                }
            }
        });
    };

    const handleCompileProgress = payload => {
        if (payload?.status === 'error') return;
        const data = payload?.status === 'success' ? payload.data : payload?.data || payload;
        if (!data || typeof data !== 'object') return;
        const action = data.action || data.taskType || data.kind || data.type || '';
        if (action !== 'compile' || !isTaskTerminal(data.phase || data.status)) return;
        loadWorkspace();
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
    const handleContextMenuKeydown = event => {
        if (event.key === 'Escape') hideContextMenu();
    };

    const handleWorkspaceScroll = event => {
        if (event.target instanceof Node && contextMenuRef.value?.contains(event.target)) return;
        hideContextMenu();
    };

    const handleWorkspaceDeactivated = () => {
        stopSchemaPaneResize();
        hideContextMenu();
        closeClearWorkspaceConfirm();
        detailRequestRevision += 1;
        nodePropertyOpen.value = false;
        executionHistoryOpen.value = false;
    };

    onMounted(() => {
        EventBus.on(YANG_EVENT.TASK_PROGRESS, YANG_EVENT_PAGE_ID.WORKSPACE, handleCompileProgress);
        EventBus.on(YANG_EVENT.SESSION_EVENT, `${YANG_EVENT_PAGE_ID.WORKSPACE}-session`, handleSessionEvent);
        document.addEventListener('keydown', handleContextMenuKeydown);
        window.addEventListener('resize', hideContextMenu);
        window.addEventListener('scroll', handleWorkspaceScroll, true);
        Promise.all([loadWorkspace(), loadSession()]);
    });

    onActivated(() => Promise.all([loadWorkspace({ preserveTree: true, retrySchemaRestore: false }), loadSession()]));

    onDeactivated(handleWorkspaceDeactivated);

    onBeforeUnmount(() => {
        closeClearWorkspaceConfirm();
        EventBus.off(YANG_EVENT.TASK_PROGRESS, YANG_EVENT_PAGE_ID.WORKSPACE);
        EventBus.off(YANG_EVENT.SESSION_EVENT, `${YANG_EVENT_PAGE_ID.WORKSPACE}-session`);
        document.removeEventListener('keydown', handleContextMenuKeydown);
        window.removeEventListener('resize', hideContextMenu);
        window.removeEventListener('scroll', handleWorkspaceScroll, true);
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

    .execution-history-trigger {
        width: 100px;
        flex: 0 0 100px;
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
        grid-template-columns: var(--schema-pane-width, 320px) 8px minmax(420px, 1fr);
        gap: 0;
    }

    .workspace-layout-empty {
        min-height: 360px;
    }

    .schema-panel {
        display: flex;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
    }

    .workspace-operation-panel {
        display: flex;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
    }

    .workspace-column-resizer {
        display: flex;
        min-width: 8px;
        align-items: center;
        justify-content: center;
        cursor: col-resize;
        outline: none;
        touch-action: none;
        user-select: none;
    }

    .workspace-column-resizer .pane-resizer-grip {
        width: 2px;
        height: 34px;
        border-radius: 999px;
        background: var(--nn-color-border-light);
        transition:
            width 0.15s ease,
            background-color 0.15s ease;
    }

    .workspace-column-resizer:hover .pane-resizer-grip,
    .workspace-column-resizer:focus-visible .pane-resizer-grip,
    .workspace-pane-resizing .workspace-column-resizer .pane-resizer-grip {
        width: 3px;
        background: var(--nn-color-primary);
    }

    .workspace-operation-panel :deep(.yang-operations-embedded),
    .workspace-operation-panel :deep(.operation-form-card),
    .workspace-operation-panel :deep(.operation-result-card) {
        min-width: 0;
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

    .panel-heading {
        min-width: 0;
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

    .schema-context-menu {
        position: fixed;
        z-index: 1200;
        width: 276px;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        padding: 4px 0;
        overflow-y: auto;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-elevated);
        box-shadow: var(--nn-shadow-elevated);
    }

    .schema-context-menu-title {
        display: flex;
        min-width: 0;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 5px 12px 0;
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
    }

    .schema-context-menu-title > span:first-child,
    .schema-context-menu-path {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .schema-context-menu-keyword {
        flex: 0 0 auto;
        color: var(--nn-color-primary);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        font-weight: 500;
    }

    .schema-context-menu-path {
        padding: 1px 12px 6px;
        color: var(--nn-color-text-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .schema-context-menu-list {
        border-inline-end: 0;
    }

    .schema-context-menu-list :deep(.nn-menu-item) {
        height: 30px;
        min-height: 30px;
        margin: 2px 4px;
        padding-block: 3px;
        border-radius: 4px;
        line-height: 24px;
    }

    .schema-context-menu-list :deep(.nn-menu-divider) {
        margin: 4px 0;
    }

    .schema-context-menu-hint {
        padding: 6px 12px 4px;
        color: var(--nn-color-text-muted);
        font-size: 11px;
        line-height: 17px;
        border-top: 1px solid var(--nn-color-border-light);
    }

    .schema-node-title {
        display: inline-flex;
        max-width: 100%;
        align-items: center;
        gap: 5px;
        font-size: 12px;
    }

    .schema-node-icon {
        display: inline-flex;
        width: 14px;
        height: 14px;
        flex: 0 0 14px;
        align-items: center;
        justify-content: center;
        color: var(--nn-color-text-muted);
        font-size: 14px;
        line-height: 1;
    }

    .schema-node-icon-device,
    .schema-node-icon-container,
    .schema-node-icon-operation,
    .schema-node-icon-loading {
        color: var(--nn-color-primary);
    }

    .schema-node-icon-module,
    .schema-node-icon-list,
    .schema-node-icon-branch {
        color: var(--nn-color-text-info);
    }

    .schema-node-icon-leaf {
        color: var(--nn-color-text-success);
    }

    .schema-node-icon-key,
    .schema-node-icon-notification {
        color: var(--nn-color-text-warning);
    }

    .schema-node-icon-state,
    .schema-node-icon-io,
    .schema-node-icon-fallback {
        color: var(--nn-color-text-muted);
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

    .detail-description {
        display: inline-block;
        white-space: pre-wrap;
    }

    .node-property-scroll {
        max-height: calc(100vh - 180px);
        overflow-y: auto;
    }

    @media (max-width: 980px) {
        .workspace-layout {
            grid-template-columns: 1fr;
            grid-template-rows: minmax(340px, 1fr) minmax(560px, 1.5fr);
        }

        .workspace-column-resizer {
            display: none;
        }
    }
</style>
