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
                    <nn-tag v-if="compileId && compileSucceeded" color="success">Schema 已就绪</nn-tag>
                    <nn-tag v-else-if="compileId" color="error">Schema 生成失败</nn-tag>
                    <nn-tag v-else color="default">暂无 Schema</nn-tag>
                    <nn-tag color="blue">模块 {{ workspaceSummary.moduleCount }}</nn-tag>
                    <nn-tag color="cyan">节点 {{ workspaceSummary.nodeCount }}</nn-tag>
                </nn-space>
            </template>

            <div class="workspace-toolbar">
                <div class="workspace-actions">
                    <nn-button :loading="loading" @click="loadWorkspace">
                        <template #icon><ReloadOutlined /></template>
                        刷新
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
                            <span class="panel-meta">libyang effective schema · 单击选择 · 右键查看属性或执行操作</span>
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
                        :context-revision="operationContextRevision"
                        :context-node="operationContext.node || deviceOperationRoot"
                        :context-subtree="operationContext.subtree"
                        :context-config="operationContext.config"
                        :context-raw-rpc="operationContext.rawRpc"
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
            <nn-menu class="schema-context-menu-list" :selectable="false" @click="handleContextMenuClick">
                <nn-menu-item key="node-properties" :disabled="contextMenu.node?.virtualDevice">
                    <template #icon><EyeOutlined /></template>
                    查看节点属性
                </nn-menu-item>
                <nn-menu-item key="copy-path" :disabled="!contextMenu.node?.path">
                    <template #icon><CopyOutlined /></template>
                    复制 Schema 路径
                </nn-menu-item>
                <nn-menu-divider />
                <nn-menu-item key="get" :disabled="Boolean(operationDisabledReason('get', contextMenu.node))">
                    <template #icon><ApiOutlined /></template>
                    {{ isDataNode(contextMenu.node) ? '读取当前节点（get）' : '读取全部数据（get）' }}
                </nn-menu-item>
                <nn-menu-item
                    key="get-config"
                    :disabled="Boolean(operationDisabledReason('get-config', contextMenu.node))"
                >
                    <template #icon><FileSearchOutlined /></template>
                    {{ isConfigDataNode(contextMenu.node) ? '读取节点配置（get-config）' : '读取配置（get-config）' }}
                </nn-menu-item>
                <nn-menu-item
                    key="edit-config"
                    :disabled="Boolean(operationDisabledReason('edit-config', contextMenu.node))"
                >
                    <template #icon><EditOutlined /></template>
                    编辑当前节点（edit-config）
                </nn-menu-item>
                <nn-menu-divider />
                <nn-menu-item key="copy-config" :disabled="Boolean(operationDisabledReason('copy-config'))">
                    <template #icon><CopyOutlined /></template>
                    复制配置存储（copy-config）
                </nn-menu-item>
                <nn-menu-item key="delete-config" :disabled="Boolean(operationDisabledReason('delete-config'))">
                    <template #icon><DeleteOutlined /></template>
                    删除整个配置存储（delete-config）
                </nn-menu-item>
                <nn-menu-item key="lock" :disabled="Boolean(operationDisabledReason('lock'))">
                    <template #icon><SafetyOutlined /></template>
                    锁定配置存储（lock）
                </nn-menu-item>
                <nn-menu-item key="unlock" :disabled="Boolean(operationDisabledReason('unlock'))">
                    <template #icon><SafetyOutlined /></template>
                    解锁配置存储（unlock）
                </nn-menu-item>
                <nn-menu-item key="validate" :disabled="Boolean(operationDisabledReason('validate'))">
                    <template #icon><CodeOutlined /></template>
                    校验配置（validate）
                </nn-menu-item>
                <nn-menu-item key="commit" :disabled="Boolean(operationDisabledReason('commit'))">
                    <template #icon><SendOutlined /></template>
                    提交 candidate（commit）
                </nn-menu-item>
                <nn-menu-item key="discard-changes" :disabled="Boolean(operationDisabledReason('discard-changes'))">
                    <template #icon><DeleteOutlined /></template>
                    放弃 candidate 修改
                </nn-menu-item>
                <nn-menu-divider />
                <nn-menu-item key="raw-rpc" :disabled="Boolean(operationDisabledReason('raw-rpc'))">
                    <template #icon><CodeOutlined /></template>
                    {{ isRpcNode(contextMenu.node) ? `执行 ${contextMenu.node.keyword}` : '原始 RPC' }}
                </nn-menu-item>
                <nn-menu-item v-if="!connected" key="connection">
                    <template #icon><ApiOutlined /></template>
                    前往连接设置
                </nn-menu-item>
            </nn-menu>
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
    </div>
</template>

<script setup>
    import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from 'vue';
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
        CodeOutlined,
        CopyOutlined,
        DeleteOutlined,
        EditOutlined,
        EyeOutlined,
        FileSearchOutlined,
        LoadingOutlined,
        ReloadOutlined,
        SafetyOutlined,
        SendOutlined
    } from '../../ui/icons';
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
    const CONTEXT_MENU_MARGIN = 8;

    const loading = ref(false);
    const treeLoading = ref(false);
    const compileId = ref('');
    const compileSucceeded = ref(false);
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
    const operationContext = reactive({ operation: 'get', node: null, subtree: '', config: '', rawRpc: '' });
    const operationContextRevision = ref(0);
    const operationExecuting = ref(false);
    const nodePropertyOpen = ref(false);
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
        defaultRatio: 0.36,
        minFirst: 320,
        minSecond: 420,
        dividerSize: 8,
        activeWhen: () => window.matchMedia('(min-width: 981px)').matches
    });
    let contextMenuOpenRequest = 0;
    let detailRequestRevision = 0;
    let clearWorkspaceConfirmHandle = null;

    const normalizeModule = (module, index) => {
        if (typeof module === 'string') return { id: '', name: module, revision: '', _key: module };
        const metadata = module?.metadata || {};
        const name = module?.name || module?.moduleName || metadata.name || `module-${index}`;
        const revision = module?.revision || module?.revisionDate || metadata.revision || '';
        const id = module?.id || module?.moduleId || module?.hash || '';
        return { ...module, id, name, revision, _key: id || `${name}@${revision || 'none'}` };
    };

    const normalizeNode = (node, index = 0) => {
        const id = node?.id || node?.nodeId || node?.key || `${node?.path || node?.name || 'node'}-${index}`;
        const hasChildren = Boolean(node?.hasChildren || Number(node?.childCount || 0) > 0 || node?.children?.length);
        const keyword = node?.keyword || node?.kind || '';
        const schemaKey =
            node?.schemaKey ||
            node?.listKey ||
            node?.listKeys ||
            (keyword === 'list' && node?.id ? node?.key || '' : '');
        return {
            ...node,
            id,
            key: id,
            title: node?.title || node?.name || node?.keyword || id,
            name: node?.name || node?.title || '',
            keyword,
            schemaKey,
            isLeaf: !hasChildren,
            children: Array.isArray(node?.children) ? node.children.map(normalizeNode) : [],
            childrenLoaded: Array.isArray(node?.children) && node.children.length > 0,
            loading: false
        };
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
        return '节点操作会自动预填 XML 草稿；delete-config 删除的是整个 datastore';
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
        Object.assign(operationContext, { operation: 'get', node: null, subtree: '', config: '', rawRpc: '' });
        operationContextRevision.value += 1;
    };
    const applyWorkspace = data => {
        const workspace = data?.workspace || data || {};
        compileId.value = workspace.compileId || workspace.id || compileId.value || '';
        const summary = workspace.summary || {};
        const nextModules = unwrapArray(workspace.modules, ['modules']);
        if (nextModules.length) workspaceModules.value = nextModules.map(normalizeModule);
        const schemaTree = workspace.schemaTree || {};
        const authoritativeSchema = schemaTree.authoritative === true && schemaTree.source === 'libyang-effective';
        compileSucceeded.value =
            authoritativeSchema && (workspace.success === true || workspace.validation?.succeeded === true);
        const inlineRoots = authoritativeSchema
            ? unwrapArray(schemaTree.roots || workspace.roots, ['nodes', 'roots'])
            : [];
        if (inlineRoots.length) treeData.value = inlineRoots.map(normalizeNode);
        workspaceSummary.value = {
            ...workspaceSummary.value,
            ...summary,
            cacheHit: Boolean(workspace.cacheHit || summary.cacheHit),
            moduleCount: Number(
                summary.moduleCount ?? workspace.modules?.length ?? workspaceSummary.value.moduleCount ?? 0
            ),
            nodeCount: authoritativeSchema
                ? Number(summary.nodeCount ?? schemaTree.nodeCount ?? workspaceSummary.value.nodeCount ?? 0)
                : 0
        };
    };

    const loadRoots = async () => {
        if (!compileId.value) {
            treeData.value = [];
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
        const previousCompileId = compileId.value;
        try {
            const { data } = await invokeBridge('yangApi', 'getWorkspace');
            compileId.value = '';
            compileSucceeded.value = false;
            workspaceModules.value = [];
            treeData.value = [];
            selectedKeys.value = [];
            detailRequestRevision += 1;
            detailNode.value = null;
            detailLoading.value = false;
            nodePropertyOpen.value = false;
            applyWorkspace(data);
            if (previousCompileId && previousCompileId !== compileId.value) resetOperationContext();
            if (compileSucceeded.value && compileId.value && treeData.value.length === 0) await loadRoots();
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

    const operationDisabledReason = (operation, node = null) => {
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
        if (['commit', 'discard-changes'].includes(operation) && !hasCapability('candidate')) {
            return '设备未声明 :candidate 能力';
        }
        return '';
    };

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

    const openOperation = operation => {
        const node = contextMenu.node;
        const disabledReason = operationDisabledReason(operation, node);
        if (disabledReason) {
            notify.warning(disabledReason);
            return;
        }
        Object.assign(operationContext, {
            operation,
            node: node?.virtualDevice ? null : node,
            subtree: ['get', 'get-config'].includes(operation) ? buildNodeXml(node, 'filter') : '',
            config: operation === 'edit-config' ? buildNodeXml(node, 'config') : '',
            rawRpc: operation === 'raw-rpc' ? buildRawRpcDraft(node) : ''
        });
        operationContextRevision.value += 1;
    };

    const handleOperationExecutingChange = value => {
        operationExecuting.value = Boolean(value);
    };

    const handleContextMenuClick = ({ key }) => {
        const node = contextMenu.node;
        if (key === 'node-properties') showNodeProperties(node);
        else if (key === 'copy-path') copyText(node?.path, 'Schema 路径已复制');
        else if (key === 'connection') router.push(YANG_ROUTE.CONNECTION);
        else openOperation(key);
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
                    compileSucceeded.value = false;
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
    };

    onMounted(() => {
        EventBus.on(YANG_EVENT.TASK_PROGRESS, YANG_EVENT_PAGE_ID.WORKSPACE, handleCompileProgress);
        EventBus.on(YANG_EVENT.SESSION_EVENT, `${YANG_EVENT_PAGE_ID.WORKSPACE}-session`, handleSessionEvent);
        document.addEventListener('keydown', handleContextMenuKeydown);
        window.addEventListener('resize', hideContextMenu);
        window.addEventListener('scroll', handleWorkspaceScroll, true);
        Promise.all([loadWorkspace(), loadSession()]);
    });

    onActivated(() => Promise.all([loadWorkspace(), loadSession()]));

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
        grid-template-columns: var(--schema-pane-width, 36%) 8px minmax(420px, 1fr);
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
