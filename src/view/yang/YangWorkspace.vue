<template>
    <div
        class="nn-container yang-workspace-page"
        :class="{ 'workspace-pane-resizing': schemaPaneResizing }"
        @click="hideContextMenu"
    >
        <nn-card title="Schema 与设备操作" class="workspace-card">
            <template #extra>
                <nn-space>
                    <nn-tag v-if="schemaStatus === 'ready'" color="success">Schema 已就绪</nn-tag>
                    <nn-tag v-else-if="schemaStatus === 'partial'" color="warning" :title="schemaStatusMessage">
                        Schema 部分可用
                    </nn-tag>
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
                <div class="workspace-context">
                    <YangCurrentProfile
                        :profile="selectedProfile"
                        :loading="profilesLoading"
                        test-id="yang-workspace-current-profile"
                    />
                    <span v-if="workspaceSummary.cacheHit" class="cache-hint">缓存命中</span>
                </div>
                <div class="workspace-actions">
                    <nn-button :loading="loading" @click="loadWorkspace()">
                        <template #icon><ReloadOutlined /></template>
                        刷新
                    </nn-button>
                    <nn-button class="execution-history-trigger" @click="executionHistoryOpen = true">
                        <template #icon><ClockCircleOutlined /></template>
                        执行记录
                    </nn-button>
                    <nn-button class="notification-history-trigger" @click="openNotificationWindow">
                        <template #icon><BellOutlined /></template>
                        通知记录
                        <span
                            v-if="notificationUnreadCount"
                            class="notification-history-badge"
                            :aria-label="`${notificationUnreadCount} 条未读通知`"
                        >
                            {{ notificationUnreadCount > 99 ? '99+' : notificationUnreadCount }}
                        </span>
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
                    <div ref="schemaTreeScrollRef" class="schema-tree-scroll">
                        <nn-spin :spinning="treeLoading">
                            <nn-tree
                                v-if="displayTree.length"
                                ref="schemaTreeRef"
                                v-model:expanded-keys="expandedKeys"
                                v-model:selected-keys="selectedKeys"
                                :tree-data="displayTree"
                                :height="schemaTreeViewportHeight"
                                :item-height="24"
                                :overscan="8"
                                block-node
                                virtual
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
                        :profile-id="selectedProfileId"
                        :operation="operationContext.operation"
                        :auto-execute="operationContext.autoExecute"
                        :compile-id="compileId"
                        :schema-tree="treeData"
                        :context-revision="operationContextRevision"
                        :context-node="operationContext.node"
                        :context-subtree="operationContext.subtree"
                        :context-config="operationContext.config"
                        :context-raw-rpc="operationContext.rawRpc"
                        :context-params="operationContext.params"
                        @executing-change="handleOperationExecutingChange"
                    />
                </section>
            </div>
        </nn-card>

        <nn-context-menu
            ref="contextMenuRef"
            v-model:open="contextMenu.visible"
            :width="276"
            root-class="schema-context-menu"
            title-class="schema-context-menu-title"
            meta-class="schema-context-menu-keyword"
            description-class="schema-context-menu-path"
            hint-class="schema-context-menu-hint"
            :title="contextMenu.node?.name || contextMenu.node?.title || 'Schema 节点'"
            :meta="contextMenu.node?.keyword || contextMenu.node?.kind || '-'"
            :description="contextMenu.node?.path || '-'"
            :hint="contextMenuHint"
        >
            <nn-menu
                class="schema-context-menu-list"
                submenu-mode="popup"
                :items="schemaContextMenuItems"
                :selectable="false"
                @click="handleContextMenuClick"
            />
        </nn-context-menu>

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
    import {
        computed,
        h,
        nextTick,
        onActivated,
        onBeforeUnmount,
        onDeactivated,
        onMounted,
        reactive,
        ref,
        watch
    } from 'vue';
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
    } from 'netnexus-ui/icons';
    import YangExecutionHistoryDrawer from './YangExecutionHistoryDrawer.vue';
    import YangOperations from './YangOperations.vue';
    import YangCurrentProfile from './YangCurrentProfile.vue';
    import { buildYangNodeXml } from './yangSchemaDraft';
    import { resolveNetconfSubscriptionCapabilities } from './netconfSubscriptionCapabilities';
    import {
        invokeBridge,
        isTaskTerminal,
        normalizeCapability,
        normalizeSessionEvent,
        unwrapArray
    } from './yangUiUtils';
    import { usePaneResize } from './usePaneResize';
    import { useYangProfileContext } from './useYangProfileContext';

    defineOptions({ name: 'YangWorkspace' });

    const router = useRouter();
    const DATA_NODE_KEYWORDS = new Set(['container', 'list', 'leaf', 'leaf-list', 'anydata', 'anyxml']);
    const RPC_NODE_KEYWORDS = new Set(['rpc', 'action']);
    const LEAF_NODE_KEYWORDS = new Set(['leaf', 'leaf-list', 'anydata', 'anyxml']);
    const NOTIFICATION_SUMMARY_EVENT = YANG_EVENT.NOTIFICATION_SUMMARY || 'netconf:notificationSummary';
    const NOTIFICATION_ACTION_EVENT = YANG_EVENT.NOTIFICATION_ACTION || 'netconf:notificationAction';
    const CONTEXT_MENU_MARGIN = 8;
    const SCHEMA_NODE_ICONS = Object.freeze({
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
    const schemaPartial = ref(false);
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
    const contextMenu = reactive({ visible: false, node: null });
    const operationContext = reactive({
        operation: 'get',
        autoExecute: false,
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
    const notificationDisconnecting = ref(false);
    const notificationSummary = ref({ total: 0, unread: 0 });
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
        frameSynchronized: true,
        previewStyleProperty: '--schema-pane-width',
        activeWhen: () => window.matchMedia('(min-width: 981px)').matches
    });
    const schemaTreeScrollRef = ref(null);
    const schemaTreeRef = ref(null);
    const schemaTreeViewportHeight = ref(480);
    let schemaTreeResizeObserver = null;
    let detailRequestRevision = 0;
    let workspaceRequestRevision = 0;
    let profileRequestRevision = 0;
    let profileContextReady = false;
    let schemaRootsPromise = null;
    let schemaRootsPromiseKey = '';
    let schemaRestoreFailedCompileId = '';
    let clearWorkspaceConfirmHandle = null;
    let notificationDisconnectConfirmHandle = null;
    let initialWorkspaceLoadSettled = false;
    const { profilesLoading, selectedProfileId, selectedProfile, refreshProfiles, taskMatchesProfile } =
        useYangProfileContext();
    const notificationUnreadCount = computed(() => Math.max(0, Number(notificationSummary.value.unread) || 0));

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
    const subscriptionCapabilities = computed(() =>
        resolveNetconfSubscriptionCapabilities({ ...session.value, capabilities: capabilities.value })
    );
    const supportsModernNotifications = computed(() => subscriptionCapabilities.value.supportsModernNotifications);
    const supportsYangPush = computed(() => subscriptionCapabilities.value.supportsYangPush);
    const supportsRfc8640 = computed(() => subscriptionCapabilities.value.supportsRfc8640);
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
        if (isNotificationNode(node)) {
            return supportsModernNotifications.value && supportsRfc8640.value
                ? '优先使用 RFC 8639 动态订阅；也可在独立 Session 使用 RFC 5277'
                : '此节点可生成 RFC 5277 subtree filter；订阅绑定当前 Session';
        }
        if (node?.config === false) return 'state 节点本身只允许 get；Candidate 与配置存储菜单作用于整个 datastore';
        if (isRpcNode(node)) return `${node.keyword} 将以原始 RPC 草稿打开，请确认实例路径和参数`;
        return '参数已确定的操作会直接下发；需要编辑的操作会根据当前 Schema 路径预填 XML';
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
    const resetOperationContext = () => {
        Object.assign(operationContext, {
            operation: 'get',
            autoExecute: false,
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
        const nextCompileId = workspace.compileId || '';
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
        const partialSchema = Boolean(
            workspace.partialSchema === true || schemaTree.partial === true || (authoritativeSchema && workspaceFailed)
        );
        schemaPartial.value = partialSchema;
        if (!compileId.value) {
            schemaStatus.value = 'none';
            schemaStatusMessage.value = '';
        } else if (authoritativeSchema && partialSchema) {
            schemaStatus.value = 'partial';
            schemaStatusMessage.value = `已载入 ${Number(summary.compiledFiles || 0)} 个有效文件，排除 ${Number(summary.failedFiles || 0)} 个编译失败文件`;
            schemaRestoreFailedCompileId = '';
        } else if (workspaceFailed && workspace.schemaAvailable === true) {
            schemaStatus.value = schemaRestoreFailedCompileId === compileId.value ? 'restore-failed' : 'restoring';
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
            schemaPartial.value = false;
            schemaStatus.value = 'none';
            schemaStatusMessage.value = '';
            return false;
        }
        const requestedCompileId = compileId.value;
        const profileId = selectedProfileId.value;
        const requestRevision = profileRequestRevision;
        const requestKey = `${requestRevision}\u0000${profileId}\u0000${requestedCompileId}`;
        if (!force && schemaRestoreFailedCompileId === requestedCompileId) return false;
        if (schemaRootsPromise && schemaRootsPromiseKey === requestKey) return schemaRootsPromise;

        schemaStatus.value = 'restoring';
        schemaStatusMessage.value = '';
        treeLoading.value = true;
        const request = (async () => {
            try {
                const { data } = await invokeBridge('yangApi', 'getSchemaRoots', {
                    profileId,
                    compileId: requestedCompileId
                });
                if (
                    compileId.value !== requestedCompileId ||
                    profileId !== selectedProfileId.value ||
                    requestRevision !== profileRequestRevision
                ) {
                    return false;
                }
                treeData.value = unwrapArray(data, ['nodes', 'roots']).map((node, index) => normalizeNode(node, index));
                schemaStatus.value = schemaPartial.value ? 'partial' : 'ready';
                schemaStatusMessage.value = schemaPartial.value
                    ? `已载入 ${Number(workspaceSummary.value.compiledFiles || 0)} 个有效文件，排除 ${Number(workspaceSummary.value.failedFiles || 0)} 个编译失败文件`
                    : '';
                schemaRestoreFailedCompileId = '';
                return true;
            } catch (error) {
                if (
                    compileId.value !== requestedCompileId ||
                    profileId !== selectedProfileId.value ||
                    requestRevision !== profileRequestRevision
                ) {
                    return false;
                }
                schemaStatus.value = 'restore-failed';
                schemaStatusMessage.value = error.message;
                schemaRestoreFailedCompileId = requestedCompileId;
                notify.error(`恢复 Schema 树失败：${error.message}`);
                return false;
            } finally {
                if (schemaRootsPromise === request) {
                    treeLoading.value = false;
                    schemaRootsPromise = null;
                    schemaRootsPromiseKey = '';
                }
            }
        })();
        schemaRootsPromise = request;
        schemaRootsPromiseKey = requestKey;
        return request;
    };

    const workspaceHasSchemaCompilation = workspace =>
        Boolean(
            workspace?.compileId &&
            (workspace?.success === true ||
                workspace?.schemaAvailable === true ||
                workspace?.schemaTree?.authoritative === true ||
                workspace?.validation?.schemaAvailable === true ||
                workspace?.validation?.succeeded === true)
        );

    const loadWorkspace = async ({ preserveTree = false, retrySchemaRestore = true } = {}) => {
        const requestRevision = ++workspaceRequestRevision;
        const profileId = selectedProfileId.value;
        const profileRevision = profileRequestRevision;
        if (!profileId) {
            loading.value = false;
            return;
        }
        loading.value = true;
        const previousCompileId = compileId.value;
        try {
            const { data } = await invokeBridge('yangApi', 'getWorkspace', { profileId });
            if (
                requestRevision !== workspaceRequestRevision ||
                profileRevision !== profileRequestRevision ||
                profileId !== selectedProfileId.value
            ) {
                return;
            }
            const workspace = data?.workspace || data || {};
            const nextCompileId = workspace.compileId || '';
            const preserveExistingTree = Boolean(
                preserveTree && previousCompileId && previousCompileId === nextCompileId && treeData.value.length
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
            if (workspaceHasSchemaCompilation(workspace) && treeData.value.length === 0) {
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
        const profileId = selectedProfileId.value;
        const requestRevision = profileRequestRevision;
        if (!profileId) return;
        try {
            const { data } = await invokeBridge('yangApi', 'listModules', { profileId });
            if (requestRevision !== profileRequestRevision || profileId !== selectedProfileId.value) return;
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
    const isNotificationNode = node => schemaNodeKeyword(node) === 'notification';
    const capabilityIncludes = hint =>
        capabilities.value.some(capability => capability.toLowerCase().includes(hint.toLowerCase()));
    const hasCapability = name => capabilityIncludes(NETCONF_CAPABILITY_HINTS[name] || name);
    const sessionSubscriptions = () => {
        const values = session.value.subscriptions || session.value.activeSubscriptions || [];
        return Array.isArray(values) ? values : [];
    };
    const modernSubscriptionActive = () => {
        if (session.value.modernSubscriptionActive === true || session.value.subscriptionMode === 'modern') return true;
        if (Number(session.value.modernSubscriptionCount) > 0) return true;
        if (Array.isArray(session.value.modernSubscriptionIds) && session.value.modernSubscriptionIds.length)
            return true;
        return sessionSubscriptions().some(item => {
            const type = String(item?.subscriptionType || item?.type || item?.protocol || '').toLowerCase();
            return ['rfc8639', 'rfc8641', 'yang-push', 'modern'].includes(type);
        });
    };
    const legacySubscriptionActive = () => {
        const active = session.value.activeSubscription || session.value.subscription || null;
        const type = String(active?.subscriptionType || active?.type || active?.protocol || '').toLowerCase();
        if (['rfc5277', 'legacy'].includes(type)) return true;
        if (session.value.legacySubscriptionActive === true || session.value.subscriptionMode === 'legacy') return true;
        if (
            sessionSubscriptions().some(
                item => String(item?.subscriptionType || item?.type).toLowerCase() === 'rfc5277'
            )
        ) {
            return true;
        }
        return session.value.subscriptionActive === true && !modernSubscriptionActive();
    };

    const operationDisabledReason = (operation, node = null, params = {}) => {
        if (operationExecuting.value) return '设备操作执行中，请等待 rpc-reply';
        if (!connected.value) return '请先建立 NETCONF 会话';
        const legacyActive = legacySubscriptionActive();
        const modernActive = modernSubscriptionActive();
        if (operation === 'create-subscription' && legacyActive) {
            return '当前 NETCONF Session 已存在 RFC 5277 订阅';
        }
        if (operation === 'create-subscription' && modernActive) {
            return '当前 Session 已使用 RFC 8639 动态订阅，不能混用 RFC 5277';
        }
        if (operation === 'establish-subscription' && legacyActive) {
            return '当前 Session 已使用 RFC 5277 订阅，不能建立现代动态订阅';
        }
        if (legacyActive && !hasCapability('interleave') && operation !== 'raw-rpc') {
            return '当前订阅 Session 未声明 :interleave；普通 RPC 暂不可用';
        }
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
        if (operation === 'create-subscription' && !hasCapability('notification')) {
            return '设备未声明 :notification 能力';
        }
        if (
            ['establish-subscription', 'modify-subscription', 'delete-subscription', 'resync-subscription'].includes(
                operation
            ) &&
            !subscriptionCapabilities.value.subscribedNotificationsModule
        ) {
            return 'YANG Library 未声明 ietf-subscribed-notifications';
        }
        if (
            ['establish-subscription', 'modify-subscription', 'delete-subscription', 'resync-subscription'].includes(
                operation
            ) &&
            !supportsRfc8640.value
        ) {
            return '设备未声明 RFC 8640 所需的 encode-xml feature';
        }
        if (
            ['establish-subscription', 'modify-subscription'].includes(operation) &&
            params.modernSubscriptionTarget === 'datastore' &&
            !supportsYangPush.value
        ) {
            return 'YANG Library 未声明 ietf-yang-push';
        }
        if (
            ['establish-subscription', 'modify-subscription'].includes(operation) &&
            params.filterType === 'subtree' &&
            !subscriptionCapabilities.value.hasSubscribedNotificationFeature('subtree')
        ) {
            return '设备未启用 ietf-subscribed-notifications subtree feature';
        }
        if (
            ['establish-subscription', 'modify-subscription'].includes(operation) &&
            params.filterType === 'xpath' &&
            !subscriptionCapabilities.value.hasSubscribedNotificationFeature('xpath')
        ) {
            return '设备未启用 ietf-subscribed-notifications xpath feature';
        }
        if (
            operation === 'establish-subscription' &&
            (params.subscriptionStartTime || params.replayStartTime) &&
            !subscriptionCapabilities.value.hasSubscribedNotificationFeature('replay')
        ) {
            return '设备未启用 ietf-subscribed-notifications replay feature';
        }
        if (
            (operation === 'resync-subscription' || params.updateTrigger === 'on-change') &&
            !subscriptionCapabilities.value.hasYangPushFeature('on-change')
        ) {
            return '设备未启用 ietf-yang-push on-change feature';
        }
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
    const operationMenuItem = ({
        key,
        label,
        operation,
        icon,
        scope = 'node',
        params = {},
        executeImmediately = false
    }) => {
        const node = ['node', 'notification'].includes(scope) ? contextMenu.node : null;
        const disabledReason = operationDisabledReason(operation, node, params);
        return {
            key,
            label,
            icon: menuIcon(icon),
            disabled: Boolean(disabledReason),
            title: disabledReason || label,
            action: { type: 'operation', operation, scope, params, executeImmediately }
        };
    };
    const allMenuActionsDisabled = items =>
        items
            .filter(item => item?.type !== 'divider')
            .every(item => item.disabled || (item.children?.length && allMenuActionsDisabled(item.children)));

    const schemaContextMenuItems = computed(() => {
        const node = contextMenu.node;
        if (!node) return [];

        if (isNotificationNode(node)) {
            const items = [
                {
                    key: 'node-properties',
                    label: '查看节点属性',
                    icon: menuIcon(EyeOutlined),
                    action: { type: 'properties' }
                },
                {
                    key: 'copy-path',
                    label: '复制 Schema 路径',
                    icon: menuIcon(CopyOutlined),
                    disabled: !node.path,
                    action: { type: 'copy-path' }
                },
                { type: 'divider', key: 'notification-divider-subscribe' },
                operationMenuItem({
                    key: 'notification:establish-subscription',
                    label: '建立动态订阅（RFC 8639）',
                    operation: 'establish-subscription',
                    icon: BellOutlined,
                    scope: 'notification',
                    params: {
                        modernSubscriptionTarget: 'stream',
                        subscriptionStream: 'NETCONF',
                        filterType: 'subtree'
                    }
                }),
                operationMenuItem({
                    key: 'notification:create-subscription',
                    label: '订阅此通知（RFC 5277）',
                    operation: 'create-subscription',
                    icon: BellOutlined,
                    scope: 'notification',
                    params: { subscriptionStream: 'NETCONF', filterType: 'subtree' }
                })
            ];
            if (!connected.value) {
                items.push({
                    key: 'connection',
                    label: '前往连接设置',
                    icon: menuIcon(ApiOutlined),
                    action: { type: 'connection' }
                });
            }
            return items;
        }

        const getConfigChildren = [
            operationMenuItem({
                key: 'get-config:running',
                label: 'Running',
                operation: 'get-config',
                icon: FileSearchOutlined,
                params: { source: 'running' },
                executeImmediately: true
            })
        ];
        if (hasCapability('candidate')) {
            getConfigChildren.push(
                operationMenuItem({
                    key: 'get-config:candidate',
                    label: 'Candidate',
                    operation: 'get-config',
                    icon: FileSearchOutlined,
                    params: { source: 'candidate' },
                    executeImmediately: true
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
                    params: { source: 'startup' },
                    executeImmediately: true
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
                    params: { validateSource: 'candidate' },
                    executeImmediately: true
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
                params: { confirmed: false },
                executeImmediately: true
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
                    scope: 'datastore',
                    executeImmediately: true
                })
            );
        }
        candidateChildren.push(
            operationMenuItem({
                key: 'candidate:discard',
                label: '放弃全部未提交修改',
                operation: 'discard-changes',
                icon: DeleteOutlined,
                scope: 'datastore',
                executeImmediately: true
            }),
            { type: 'divider', key: 'candidate-divider-lock' },
            operationMenuItem({
                key: 'candidate:lock',
                label: '锁定 Candidate',
                operation: 'lock',
                icon: SafetyOutlined,
                scope: 'datastore',
                params: { lockTarget: 'candidate' },
                executeImmediately: true
            }),
            operationMenuItem({
                key: 'candidate:unlock',
                label: '解锁 Candidate',
                operation: 'unlock',
                icon: SafetyOutlined,
                scope: 'datastore',
                params: { lockTarget: 'candidate' },
                executeImmediately: true
            })
        );

        const validateChildren = [
            operationMenuItem({
                key: 'datastore:validate:running',
                label: 'Running',
                operation: 'validate',
                icon: CodeOutlined,
                scope: 'datastore',
                params: { validateSource: 'running' },
                executeImmediately: true
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
                    params: { validateSource: 'startup' },
                    executeImmediately: true
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
                params: { lockTarget: datastore },
                executeImmediately: true
            })
        );
        const unlockChildren = ['running', ...(hasCapability('startup') ? ['startup'] : [])].map(datastore =>
            operationMenuItem({
                key: `datastore:unlock:${datastore}`,
                label: datastore === 'running' ? 'Running' : 'Startup',
                operation: 'unlock',
                icon: SafetyOutlined,
                scope: 'datastore',
                params: { lockTarget: datastore },
                executeImmediately: true
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
                    params: { copySource: 'running', copyTarget: 'startup' },
                    executeImmediately: true
                }),
                operationMenuItem({
                    key: 'startup:delete',
                    label: '删除整个 Startup',
                    operation: 'delete-config',
                    icon: DeleteOutlined,
                    scope: 'datastore',
                    params: { deleteTarget: 'startup' },
                    executeImmediately: true
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
                icon: ApiOutlined,
                executeImmediately: true
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
        items.push({
            key: 'datastore-workspace',
            label: '配置存储',
            icon: menuIcon(SafetyOutlined),
            disabled: allMenuActionsDisabled(datastoreChildren),
            children: datastoreChildren
        });
        if (isDataNode(node)) {
            items.push(
                { type: 'divider', key: 'node-divider-yang-push' },
                operationMenuItem({
                    key: 'yang-push:establish-subscription',
                    label: '订阅当前节点（YANG-Push）',
                    operation: 'establish-subscription',
                    icon: BellOutlined,
                    params: {
                        modernSubscriptionTarget: 'datastore',
                        datastore: 'ds:operational',
                        updateTrigger: 'periodic',
                        period: 500,
                        filterType: 'subtree'
                    }
                })
            );
        }
        items.push(
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

    const buildNodeXml = (node, mode = 'filter') =>
        buildYangNodeXml({
            node,
            chain: schemaNodeChain(node),
            mode,
            resolveNamespace: namespaceForNode
        });

    const buildRawRpcDraft = node => {
        if (!isRpcNode(node)) {
            return '<get>\n  <filter type="subtree">\n    <!-- subtree filter -->\n  </filter>\n</get>';
        }
        const name = String(node?.name || node?.title || node?.keyword || 'rpc').replace(/[^\w.-]/gu, '');
        const namespace = namespaceForNode(node);
        const namespaceAttribute = namespace ? ` xmlns="${escapeXmlAttribute(namespace)}"` : '';
        return `<${name}${namespaceAttribute}>\n  <!-- NETNEXUS_REQUIRED: 根据 YANG input 补充参数；无参数时删除本注释 -->\n</${name}>`;
    };

    const buildNotificationFilter = node => {
        if (!isNotificationNode(node)) return '';
        const name = schemaLocalName(node?.name || node?.title || 'notification').replace(/[^\w.-]/gu, '');
        const namespace = namespaceForNode(node);
        const namespaceAttribute = namespace ? ` xmlns="${escapeXmlAttribute(namespace)}"` : '';
        return `<${name || 'notification'}${namespaceAttribute}/>`;
    };

    const handleTreeRightClick = async ({ event, node }) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const key = node?.key || node?.eventKey || node?.dataRef?.key;
        const matchedNode = findNode(treeData.value, key) || node?.dataRef || node;
        if (!matchedNode?.key) return;

        selectedKeys.value = [matchedNode.key];
        nodePropertyOpen.value = false;
        contextMenu.node = matchedNode;
        await nextTick();
        await contextMenuRef.value?.openAt(
            Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
                ? event
                : { x: CONTEXT_MENU_MARGIN, y: CONTEXT_MENU_MARGIN }
        );
    };

    const hideContextMenu = () => {
        contextMenuRef.value?.close({ reason: 'api' });
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

    const applyNotificationSummary = payload => {
        const data = payload?.status === 'success' ? payload.data : payload?.data || payload;
        const summary = data?.summary && typeof data.summary === 'object' ? data.summary : data;
        if (!summary || typeof summary !== 'object') return;
        notificationSummary.value = {
            ...notificationSummary.value,
            ...summary,
            total: Math.max(0, Number(summary.total ?? summary.count) || 0),
            unread: Math.max(0, Number(summary.unread ?? summary.unreadCount) || 0)
        };
    };

    const loadNotificationSummary = async () => {
        try {
            const { data } = await invokeBridge('netconfApi', 'getNotificationSummary');
            applyNotificationSummary(data);
        } catch (error) {
            console.warn('Unable to load NETCONF notification summary:', error.message);
        }
    };

    const openNotificationWindow = async () => {
        const openMonitor = window.windowApi?.openMonitor;
        if (typeof openMonitor !== 'function') {
            notify.error('当前环境不支持打开 NETCONF 通知窗口');
            return;
        }
        try {
            const result = await openMonitor('netconf-notifications');
            if (result?.status !== 'success') notify.error(result?.msg || '打开 NETCONF 通知窗口失败');
        } catch (error) {
            notify.error(`打开 NETCONF 通知窗口失败：${error.message}`);
        }
    };

    const closeNotificationDisconnectConfirm = () => {
        notificationDisconnectConfirmHandle?.destroy?.();
        notificationDisconnectConfirmHandle = null;
    };

    const disconnectNotificationSession = subscription => {
        const profileId = String(subscription?.profileId || '');
        const sessionId = String(subscription?.sessionId || '');
        const subscriptionId = String(subscription?.subscriptionId || '');
        if (!profileId || notificationDisconnecting.value) return;
        closeNotificationDisconnectConfirm();
        const subscriptionLabel = subscription?.label || subscription?.subscriptionId || '当前订阅';
        const sessionLabel = sessionId ? `Session ${sessionId}` : '所属 NETCONF Session';
        let confirmHandle = null;
        confirmHandle = dialog.confirm({
            title: '结束 RFC 5277 订阅',
            content: `RFC 5277 没有单独的取消订阅 RPC。结束“${subscriptionLabel}”必须断开 ${sessionLabel}，该 Session 上正在进行或后续的其他操作也会终止。是否继续？`,
            okText: '断开 Session',
            okType: 'danger',
            onCancel: () => {
                if (notificationDisconnectConfirmHandle === confirmHandle) {
                    notificationDisconnectConfirmHandle = null;
                }
            },
            onOk: async () => {
                notificationDisconnecting.value = true;
                try {
                    const { data: currentState } = await invokeBridge('netconfApi', 'getSessionState', profileId);
                    const currentConnected =
                        currentState?.connected === true ||
                        String(currentState?.status || currentState?.state || '').toLowerCase() ===
                            NETCONF_SESSION_STATUS.CONNECTED;
                    const currentSessionId = String(currentState?.sessionId || '');
                    const currentSubscriptionId = String(
                        currentState?.activeSubscription?.id ||
                            currentState?.activeSubscription?.subscriptionId ||
                            currentState?.subscription?.id ||
                            currentState?.subscription?.subscriptionId ||
                            ''
                    );
                    if (!currentConnected) {
                        notify.info(`${sessionLabel} 已不再连接，订阅状态已刷新`);
                        return;
                    }
                    if (sessionId && currentSessionId !== sessionId) {
                        notify.warning(
                            `订阅所属 ${sessionLabel} 已变化，未断开当前 Session ${currentSessionId || '未知'}`
                        );
                        return;
                    }
                    if (subscriptionId && currentSubscriptionId !== subscriptionId) {
                        notify.warning('当前 Session 已没有所选活动订阅，未执行断开');
                        return;
                    }
                    const { data } = await invokeBridge('netconfApi', 'disconnect', profileId);
                    if (selectedProfileId.value === profileId) {
                        session.value = {
                            ...(data || {}),
                            profileId,
                            status: NETCONF_SESSION_STATUS.DISCONNECTED,
                            connected: false,
                            capabilities: []
                        };
                    }
                    notify.success(`${sessionLabel} 已断开，RFC 5277 订阅已结束`);
                } catch (error) {
                    notify.error(`结束订阅失败：${error.message}`);
                } finally {
                    notificationDisconnecting.value = false;
                    if (notificationDisconnectConfirmHandle === confirmHandle) {
                        notificationDisconnectConfirmHandle = null;
                    }
                }
            }
        });
        notificationDisconnectConfirmHandle = confirmHandle;
    };

    const openEditConfigMonitor = async (node, params) => {
        const openMonitor = window.windowApi?.openMonitor;
        if (typeof openMonitor !== 'function') return false;
        try {
            const result = await openMonitor('netconf-edit-config', {
                profileId: selectedProfileId.value,
                compileId: compileId.value,
                nodeId: node?.id || node?.key,
                target: params.target
            });
            if (result?.status !== 'success') {
                notify.error(result?.msg || '打开 NETCONF Content Editor 失败');
            }
            return true;
        } catch (error) {
            notify.error(`打开 NETCONF Content Editor 失败：${error.message}`);
            return true;
        }
    };

    const openOperation = async (operation, { scope = 'node', params = {}, executeImmediately = false } = {}) => {
        const contextNode = contextMenu.node;
        const node = ['node', 'notification'].includes(scope) ? contextNode : null;
        const disabledReason = operationDisabledReason(operation, node, params);
        if (disabledReason) {
            notify.warning(disabledReason);
            return;
        }
        if (operation === 'edit-config' && (await openEditConfigMonitor(node, params))) return;
        Object.assign(operationContext, {
            operation,
            autoExecute: executeImmediately,
            node,
            subtree:
                operation === 'create-subscription'
                    ? buildNotificationFilter(node)
                    : operation === 'establish-subscription'
                      ? params.modernSubscriptionTarget === 'datastore'
                          ? buildNodeXml(node, 'filter')
                          : buildNotificationFilter(node)
                      : ['get', 'get-config', 'edit-config'].includes(operation)
                        ? buildNodeXml(node, 'filter')
                        : '',
            config: operation === 'edit-config' ? buildNodeXml(node, 'config') : '',
            rawRpc: operation === 'raw-rpc' ? buildRawRpcDraft(node) : '',
            params: { ...params }
        });
        operationContextRevision.value += 1;
    };

    const storedSubscriptionFilter = subscription => {
        const raw = subscription?.filter;
        if (!raw) return { filterType: 'none', xpath: '', subtree: '' };
        let filter = raw;
        if (typeof raw === 'string') {
            try {
                filter = JSON.parse(raw);
            } catch (_error) {
                return { filterType: 'subtree', xpath: '', subtree: raw };
            }
        }
        if (!filter || typeof filter !== 'object') return { filterType: 'none', xpath: '', subtree: '' };
        if (filter.type === 'xpath') {
            const namespaces = Object.entries(filter.namespaces || {})
                .map(([prefix, namespace]) => `${prefix || 'xmlns'}=${namespace}`)
                .join(', ');
            return {
                filterType: 'xpath',
                xpath: filter.select || filter.expression || filter.value || '',
                subtree: '',
                modernXpathNamespaces: namespaces
            };
        }
        if (filter.type === 'reference') {
            return {
                filterType: 'reference',
                xpath: '',
                subtree: '',
                modernFilterReference: filter.name || filter.value || ''
            };
        }
        return {
            filterType: 'subtree',
            xpath: '',
            subtree: filter.content || filter.xml || '',
            modernXpathNamespaces: Object.entries(filter.namespaces || {})
                .map(([prefix, namespace]) => `${prefix || 'xmlns'}=${namespace}`)
                .join(', ')
        };
    };

    const activateSubscriptionManagement = subscription => {
        const operation = String(subscription?.operation || '');
        const storedFilter = storedSubscriptionFilter(subscription);
        const namespaceBindings = new Map();
        Object.entries(subscription?.datastoreNamespaces || {}).forEach(([prefix, namespace]) => {
            if (prefix && namespace) namespaceBindings.set(prefix, namespace);
        });
        String(storedFilter.modernXpathNamespaces || '')
            .split(',')
            .map(entry => entry.trim())
            .filter(Boolean)
            .forEach(entry => {
                const separator = entry.indexOf('=');
                if (separator > 0) {
                    const inputPrefix = entry.slice(0, separator).trim();
                    namespaceBindings.set(
                        ['default', 'xmlns'].includes(inputPrefix) ? '' : inputPrefix,
                        entry.slice(separator + 1).trim()
                    );
                }
            });
        const params = {
            ...subscription,
            modernSubscriptionId: subscription?.deviceSubscriptionId ?? subscription?.modernSubscriptionId ?? '',
            modernSubscriptionTarget: subscription?.targetType === 'datastore' ? 'datastore' : 'stream',
            subscriptionStream: subscription?.stream || 'NETCONF',
            subscriptionStartTime: subscription?.replayStartTime || '',
            subscriptionStopTime: subscription?.stopTime || '',
            ...storedFilter,
            modernXpathNamespaces: [...namespaceBindings]
                .map(([prefix, namespace]) => `${prefix || 'xmlns'}=${namespace}`)
                .join(', ')
        };
        const disabledReason = operationDisabledReason(operation, null, params);
        if (disabledReason) {
            notify.warning(disabledReason);
            return;
        }
        Object.assign(operationContext, {
            operation,
            autoExecute: false,
            node: null,
            subtree: params.subtree || '',
            config: '',
            rawRpc: '',
            params
        });
        operationContextRevision.value += 1;
        notify.info(`已在操作区打开 ${operation}，检查参数后即可执行`);
    };

    const openSubscriptionManagement = subscription => {
        const targetProfileId = String(subscription?.profileId || '');
        if (
            !targetProfileId ||
            subscription?.deviceSubscriptionId === undefined ||
            subscription?.deviceSubscriptionId === null ||
            subscription?.deviceSubscriptionId === ''
        ) {
            notify.warning('订阅缺少 Profile 或设备订阅 ID，无法执行管理操作');
            return;
        }
        if (targetProfileId !== selectedProfileId.value) {
            notify.warning('该订阅不属于当前 Profile，请先在连接设置中连接对应 Profile');
            return;
        }
        activateSubscriptionManagement(subscription);
    };

    const handleNotificationAction = async payload => {
        const data = payload?.status === 'success' ? payload.data : payload?.data || payload;
        if (!data || typeof data !== 'object') return;
        if (router.currentRoute.value.path !== YANG_ROUTE.WORKSPACE) {
            await router.push(YANG_ROUTE.WORKSPACE);
            await nextTick();
        }
        if (data.operation === 'disconnect-session') disconnectNotificationSession(data);
        else openSubscriptionManagement(data);
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
        const profileId = selectedProfileId.value;
        const requestRevision = profileRequestRevision;
        if (!profileId) {
            session.value = { status: NETCONF_SESSION_STATUS.DISCONNECTED, connected: false, capabilities: [] };
            return;
        }
        try {
            const { data } = await invokeBridge('netconfApi', 'getSessionState', profileId);
            if (requestRevision !== profileRequestRevision || profileId !== selectedProfileId.value) return;
            session.value = { ...session.value, ...(data || {}) };
        } catch (error) {
            if (requestRevision === profileRequestRevision && profileId === selectedProfileId.value) {
                session.value = {
                    status: NETCONF_SESSION_STATUS.DISCONNECTED,
                    connected: false,
                    capabilities: []
                };
                console.warn('Unable to load NETCONF session state:', error.message);
            }
        }
    };

    const handleSessionEvent = payload => {
        const next = normalizeSessionEvent(payload, session.value);
        if (next?.profileId && next.profileId !== selectedProfileId.value) return;
        session.value = next;
    };

    const handleTreeExpand = async (_keys, info) => {
        const node = findNode(treeData.value, info?.node?.key);
        if (!info?.expanded || !node || node.isLeaf || node.childrenLoaded || node.loading) return;
        const profileId = selectedProfileId.value;
        const requestedCompileId = compileId.value;
        const requestRevision = profileRequestRevision;
        const requestIsCurrent = () =>
            requestRevision === profileRequestRevision &&
            profileId === selectedProfileId.value &&
            requestedCompileId === compileId.value;
        node.loading = true;
        treeData.value = [...treeData.value];
        try {
            const { data } = await invokeBridge('yangApi', 'getSchemaChildren', {
                profileId,
                compileId: requestedCompileId,
                parentId: node.id,
                nodeId: node.id
            });
            if (!requestIsCurrent()) return;
            const parentContext = schemaChildContext(node);
            node.children = unwrapArray(data, ['nodes', 'children']).map((child, index) =>
                normalizeNode(child, index, parentContext)
            );
            node.childrenLoaded = true;
            node.isLeaf = node.children.length === 0;
        } catch (error) {
            if (requestIsCurrent()) notify.error(`加载子节点失败：${error.message}`);
        } finally {
            node.loading = false;
            if (requestIsCurrent()) treeData.value = [...treeData.value];
        }
    };

    const showNodeProperties = async node => {
        if (!node) return;
        const requestRevision = ++detailRequestRevision;
        const profileId = selectedProfileId.value;
        const requestedCompileId = compileId.value;
        const profileRevision = profileRequestRevision;
        const requestIsCurrent = () =>
            requestRevision === detailRequestRevision &&
            profileRevision === profileRequestRevision &&
            profileId === selectedProfileId.value &&
            requestedCompileId === compileId.value;
        detailNode.value = node;
        detailLoading.value = true;
        nodePropertyOpen.value = true;
        try {
            const { data } = await invokeBridge('yangApi', 'getSchemaNode', {
                profileId,
                compileId: requestedCompileId,
                nodeId: node.id || node.key
            });
            if (requestIsCurrent()) detailNode.value = { ...node, ...(data || {}) };
        } catch (_error) {
            // The summary already carried by the tree node is sufficient for basic inspection.
        } finally {
            if (requestIsCurrent()) detailLoading.value = false;
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
                const profileId = selectedProfileId.value;
                const requestRevision = profileRequestRevision;
                try {
                    await invokeBridge('yangApi', 'clearWorkspace', { profileId });
                    if (requestRevision !== profileRequestRevision || profileId !== selectedProfileId.value) {
                        if (profileId === selectedProfileId.value) void loadWorkspace();
                        return;
                    }
                    compileId.value = '';
                    schemaPartial.value = false;
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
                    EventBus.emit(YANG_EVENT.PROFILE_DATA_REFRESH, {
                        profileId,
                        reason: 'workspace-cleared',
                        sourcePageId: YANG_EVENT_PAGE_ID.WORKSPACE,
                        profileChanged: false
                    });
                    notify.success('YANG 工作区已清空，本地托管副本已删除');
                } catch (error) {
                    if (requestRevision === profileRequestRevision && profileId === selectedProfileId.value) {
                        notify.error(`清空失败：${error.message}`);
                    }
                } finally {
                    if (clearWorkspaceConfirmHandle === confirmHandle) clearWorkspaceConfirmHandle = null;
                }
            }
        });
        clearWorkspaceConfirmHandle = confirmHandle;
    };

    const handleCompileProgress = payload => {
        if (payload?.status === 'error') return;
        const data = payload?.status === 'success' ? payload.data : payload?.data || payload;
        if (!data || typeof data !== 'object') return;
        if (!taskMatchesProfile(data, selectedProfileId.value)) return;
        const action = data.action || data.taskType || data.kind || data.type || '';
        if (!['compile', 'download', 'import'].includes(action) || !isTaskTerminal(data.phase || data.status)) return;
        void loadWorkspace({ preserveTree: true });
    };

    const handleProfileDataRefresh = payload => {
        const profileId = String(payload?.profileId || '');
        if (!profileId) return;
        if (
            payload?.reason === 'workspace-cleared' &&
            payload?.sourcePageId === YANG_EVENT_PAGE_ID.WORKSPACE &&
            profileId === selectedProfileId.value
        )
            return;
        if (profileId !== selectedProfileId.value) return;
        if (profileContextReady) void reloadCurrentProfile({ preserveTree: true });
    };

    const resetProfileWorkspace = () => {
        profileRequestRevision += 1;
        workspaceRequestRevision += 1;
        detailRequestRevision += 1;
        schemaRootsPromise = null;
        schemaRootsPromiseKey = '';
        schemaRestoreFailedCompileId = '';
        compileId.value = '';
        schemaPartial.value = false;
        schemaStatus.value = 'none';
        schemaStatusMessage.value = '';
        workspaceSummary.value = { moduleCount: 0, nodeCount: 0, cacheHit: false };
        workspaceModules.value = [];
        treeData.value = [];
        expandedKeys.value = [];
        selectedKeys.value = [];
        detailNode.value = null;
        detailLoading.value = false;
        nodePropertyOpen.value = false;
        executionHistoryOpen.value = false;
        notificationDisconnecting.value = false;
        treeLoading.value = false;
        loading.value = false;
        session.value = { status: NETCONF_SESSION_STATUS.DISCONNECTED, connected: false, capabilities: [] };
        hideContextMenu();
        closeClearWorkspaceConfirm();
        closeNotificationDisconnectConfirm();
        resetOperationContext();
    };

    const reloadCurrentProfile = options => Promise.all([loadWorkspace(options), loadSession()]);

    watch(selectedProfileId, async (profileId, previousProfileId) => {
        if (profileId === previousProfileId) return;
        resetProfileWorkspace();
        if (profileContextReady) await reloadCurrentProfile();
    });

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
    const updateSchemaTreeViewportHeight = observedHeight => {
        const scrollElement = schemaTreeScrollRef.value;
        const fallbackHeight = scrollElement ? Math.max(0, scrollElement.clientHeight - 12) : 0;
        const measuredHeight = Number.isFinite(Number(observedHeight)) ? Number(observedHeight) : fallbackHeight;
        if (measuredHeight <= 0) return;
        const nextHeight = Math.max(120, Math.floor(measuredHeight));
        if (nextHeight !== schemaTreeViewportHeight.value) schemaTreeViewportHeight.value = nextHeight;
    };

    const observeSchemaTreeViewport = () => {
        schemaTreeResizeObserver?.disconnect();
        schemaTreeResizeObserver = null;
        updateSchemaTreeViewportHeight();
        if (typeof ResizeObserver === 'undefined' || !schemaTreeScrollRef.value) return;
        schemaTreeResizeObserver = new ResizeObserver(entries => {
            const entry = entries[entries.length - 1];
            updateSchemaTreeViewportHeight(entry?.contentRect?.height);
        });
        schemaTreeResizeObserver.observe(schemaTreeScrollRef.value);
    };

    const refreshSchemaTreeLayout = async () => {
        await nextTick();
        observeSchemaTreeViewport();
        await schemaTreeRef.value?.refreshVirtualLayout?.();
    };

    const handleWorkspaceDeactivated = () => {
        stopSchemaPaneResize();
        hideContextMenu();
        closeClearWorkspaceConfirm();
        closeNotificationDisconnectConfirm();
        detailRequestRevision += 1;
        nodePropertyOpen.value = false;
        executionHistoryOpen.value = false;
        schemaTreeResizeObserver?.disconnect();
        schemaTreeResizeObserver = null;
    };

    onMounted(async () => {
        EventBus.on(YANG_EVENT.TASK_PROGRESS, YANG_EVENT_PAGE_ID.WORKSPACE, handleCompileProgress);
        EventBus.on(YANG_EVENT.SESSION_EVENT, `${YANG_EVENT_PAGE_ID.WORKSPACE}-session`, handleSessionEvent);
        EventBus.on(
            NOTIFICATION_SUMMARY_EVENT,
            `${YANG_EVENT_PAGE_ID.WORKSPACE}-notification-summary`,
            applyNotificationSummary
        );
        EventBus.on(
            NOTIFICATION_ACTION_EVENT,
            `${YANG_EVENT_PAGE_ID.WORKSPACE}-notification-action`,
            handleNotificationAction
        );
        EventBus.on(
            YANG_EVENT.PROFILE_DATA_REFRESH,
            `${YANG_EVENT_PAGE_ID.WORKSPACE}-profile-data`,
            handleProfileDataRefresh
        );
        window.addEventListener('resize', updateSchemaTreeViewportHeight);
        await nextTick();
        observeSchemaTreeViewport();
        try {
            await loadNotificationSummary();
            await refreshProfiles();
            profileContextReady = true;
            await reloadCurrentProfile();
        } finally {
            initialWorkspaceLoadSettled = true;
        }
    });

    onActivated(async () => {
        if (!initialWorkspaceLoadSettled) return;
        await refreshSchemaTreeLayout();
        await loadNotificationSummary();
        await refreshProfiles();
        profileContextReady = true;
        await reloadCurrentProfile({ preserveTree: true });
        await refreshSchemaTreeLayout();
    });

    onDeactivated(handleWorkspaceDeactivated);

    onBeforeUnmount(() => {
        closeClearWorkspaceConfirm();
        closeNotificationDisconnectConfirm();
        EventBus.off(YANG_EVENT.TASK_PROGRESS, YANG_EVENT_PAGE_ID.WORKSPACE);
        EventBus.off(YANG_EVENT.SESSION_EVENT, `${YANG_EVENT_PAGE_ID.WORKSPACE}-session`);
        EventBus.off(NOTIFICATION_SUMMARY_EVENT, `${YANG_EVENT_PAGE_ID.WORKSPACE}-notification-summary`);
        EventBus.off(NOTIFICATION_ACTION_EVENT, `${YANG_EVENT_PAGE_ID.WORKSPACE}-notification-action`);
        EventBus.off(YANG_EVENT.PROFILE_DATA_REFRESH, `${YANG_EVENT_PAGE_ID.WORKSPACE}-profile-data`);
        window.removeEventListener('resize', updateSchemaTreeViewportHeight);
        schemaTreeResizeObserver?.disconnect();
        schemaTreeResizeObserver = null;
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

    .workspace-context {
        min-width: 0;
        flex: 1;
    }

    .workspace-actions {
        flex: none;
        flex-wrap: wrap;
        justify-content: flex-end;
    }

    .execution-history-trigger,
    .notification-history-trigger {
        width: 100px;
        flex: 0 0 100px;
    }

    .notification-history-trigger {
        position: relative;
    }

    .notification-history-badge {
        position: absolute;
        top: -6px;
        right: -6px;
        display: inline-flex;
        min-width: 18px;
        height: 18px;
        align-items: center;
        justify-content: center;
        padding: 0 5px;
        border: 2px solid var(--nn-color-bg-surface);
        border-radius: 999px;
        background: var(--nn-color-error);
        color: #fff;
        font-size: 10px;
        font-weight: 600;
        line-height: 14px;
        pointer-events: none;
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
        overflow: hidden;
        padding: 6px;
    }

    :global(.schema-context-menu) {
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

    :global(.schema-context-menu-title) {
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

    :global(.schema-context-menu-title > span:first-child),
    :global(.schema-context-menu-path) {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    :global(.schema-context-menu-keyword) {
        flex: 0 0 auto;
        color: var(--nn-color-primary);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        font-weight: 500;
    }

    :global(.schema-context-menu-path) {
        padding: 1px 12px 6px;
        color: var(--nn-color-text-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    :global(.schema-context-menu-list) {
        border-inline-end: 0;
    }

    :global(.schema-context-menu-list .nn-menu-item) {
        height: 30px;
        min-height: 30px;
        margin: 2px 4px;
        padding-block: 3px;
        border-radius: 4px;
        line-height: 24px;
    }

    :global(.schema-context-menu-list .nn-menu-divider) {
        margin: 4px 0;
    }

    :global(.schema-context-menu-hint) {
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

    @media (max-width: 720px) {
        .workspace-toolbar {
            align-items: flex-start;
            flex-direction: column;
        }

        .workspace-context,
        .workspace-actions {
            width: 100%;
        }

        .workspace-actions {
            justify-content: flex-start;
        }
    }
</style>
