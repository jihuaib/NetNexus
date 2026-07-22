<template>
    <div
        class="nn-container snmp-mib-workspace-page"
        :class="{ 'workspace-pane-resizing': treePaneResizing }"
        @click="hideContextMenu"
    >
        <nn-card title="MIB 工作区" class="workspace-card">
            <div class="workspace-toolbar">
                <div class="workspace-status" aria-label="MIB 工作区状态">
                    <nn-tag v-if="loading" color="processing">正在刷新</nn-tag>
                    <nn-tag v-else-if="mibStatus.totalObjects" color="success">MIB 已就绪</nn-tag>
                    <nn-tag v-else color="default">暂无 MIB</nn-tag>
                    <nn-tag v-if="mibStatus.cacheHit" color="green">缓存命中</nn-tag>
                    <nn-tag color="blue">用户模块 {{ mibStatus.modules.length }}</nn-tag>
                    <nn-tag color="cyan">基础模块 {{ mibStatus.baseModules.length }}</nn-tag>
                    <nn-tag color="green">OID {{ mibStatus.totalObjects }}</nn-tag>
                    <nn-tag color="default">文件 {{ mibStatus.expandedFileCount }}</nn-tag>
                </div>

                <div class="workspace-actions">
                    <div class="oid-query-row">
                        <nn-input
                            v-model:value="oidQuery"
                            allow-clear
                            aria-label="OID"
                            placeholder="输入 OID 定位节点，例如 1.3.6.1.2.1.1.3.0"
                            @press-enter="locateOidNode"
                        />
                        <nn-button :loading="oidTranslateLoading" @click="locateOidNode">定位节点</nn-button>
                    </div>
                    <nn-button :loading="loading" @click="loadMibStatus({ force: true })">
                        <template #icon><ReloadOutlined /></template>
                        刷新
                    </nn-button>
                </div>
            </div>

            <div ref="workspaceLayoutRef" class="workspace-layout" :style="workspaceLayoutStyle">
                <section class="mib-tree-panel" aria-label="OID 树">
                    <div class="panel-header">
                        <div class="panel-heading">
                            <span class="panel-title">OID 树</span>
                            <span class="panel-meta">{{ mibStatus.totalObjects }} 个对象</span>
                        </div>
                    </div>
                    <div ref="treeScrollRef" class="mib-tree-scroll">
                        <nn-spin :spinning="loading && mibStatus.oidTree.length === 0">
                            <nn-tree
                                v-if="mibStatus.oidTree.length"
                                ref="treeRef"
                                v-model:expanded-keys="treeExpandedKeys"
                                :selected-keys="treeSelectedKeys"
                                :tree-data="mibStatus.oidTree"
                                block-node
                                @expand="handleTreeExpand"
                                @right-click="handleTreeRightClick"
                                @select="handleTreeSelect"
                            >
                                <template #title="node">
                                    <span class="mib-node-title" :data-tree-oid="node.oid">
                                        <span
                                            class="mib-node-icon"
                                            :class="`mib-node-icon-${mibNodeIconKind(node)}`"
                                            :data-node-icon="mibNodeIconKind(node)"
                                            aria-hidden="true"
                                        >
                                            <component
                                                :is="mibNodeIconComponent(node)"
                                                :spin="node.loading"
                                                :stroke-width="1.8"
                                            />
                                        </span>
                                        <span class="mib-node-name">{{ node.title }}</span>
                                        <span class="mib-node-oid">{{ node.oid }}</span>
                                        <span v-if="node.macro" class="mib-node-macro">{{ node.macro }}</span>
                                        <span
                                            v-if="getNodeRoleText(node)"
                                            :class="['mib-node-role', getNodeRoleClass(node)]"
                                        >
                                            {{ getNodeRoleText(node) }}
                                        </span>
                                        <span v-if="node.moduleName" class="mib-node-module">
                                            {{ node.moduleName }}
                                        </span>
                                    </span>
                                </template>
                            </nn-tree>
                            <nn-empty v-else description="请先在 MIB 编译页导入并编译文件" />
                        </nn-spin>
                    </div>
                </section>

                <div
                    class="workspace-column-resizer"
                    role="separator"
                    aria-label="调整 OID 树宽度"
                    aria-orientation="vertical"
                    :aria-valuemin="treePaneMinWidth"
                    :aria-valuemax="treePaneMaxWidth"
                    :aria-valuenow="treePaneWidth"
                    tabindex="0"
                    title="拖动调整 OID 树宽度；双击恢复默认宽度"
                    @pointerdown="startTreePaneResize"
                    @keydown="handleTreePaneResizeKeydown"
                    @dblclick="resetTreePaneResize"
                >
                    <span class="pane-resizer-grip" aria-hidden="true" />
                </div>

                <section class="workspace-operation-panel" aria-label="SNMP 操作区">
                    <SnmpMibOperations
                        ref="operationsRef"
                        :context-node="operationContext.node"
                        :context-operation="operationContext.operation"
                        :context-revision="operationContext.revision"
                    />
                </section>
            </div>
        </nn-card>

        <div
            v-if="contextMenu.visible"
            ref="contextMenuRef"
            class="mib-context-menu"
            :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
            @click.stop
        >
            <div class="mib-context-menu-title">
                <span>{{ contextMenu.node?.moduleQualifiedName || contextMenu.node?.objectName || 'OID 节点' }}</span>
                <span class="mib-context-menu-kind">
                    {{ contextMenu.node?.macro || contextMenu.node?.nodeRole || '-' }}
                </span>
            </div>
            <div class="mib-context-menu-oid" :title="contextMenu.node?.oid">
                {{ contextMenu.node?.oid || '-' }}
            </div>
            <nn-menu class="mib-context-menu-list" :selectable="false" @click="handleContextMenuClick">
                <nn-menu-item key="properties">
                    <template #icon><EyeOutlined /></template>
                    查看节点属性
                </nn-menu-item>
                <nn-menu-item key="copy" :disabled="!contextMenu.node?.oid">
                    <template #icon><CopyOutlined /></template>
                    复制 OID
                </nn-menu-item>
                <nn-menu-divider />
                <nn-menu-item key="get" :disabled="!canGetNode(contextMenu.node)">
                    <template #icon><ApiOutlined /></template>
                    GET 查询
                </nn-menu-item>
                <nn-menu-item key="getNext" :disabled="!contextMenu.node?.oid">
                    <template #icon><StepForwardOutlined /></template>
                    GET-NEXT 查询
                </nn-menu-item>
                <nn-menu-item key="walk" :disabled="!contextMenu.node?.oid">
                    <template #icon><FileSearchOutlined /></template>
                    WALK 查询
                </nn-menu-item>
                <nn-menu-item key="set" :disabled="!canSetNode(contextMenu.node)">
                    <template #icon><EditOutlined /></template>
                    SET 设置
                </nn-menu-item>
            </nn-menu>
            <div class="mib-context-menu-hint">
                {{ getNodeAbilityText(contextMenu.node) }}
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
                <nn-descriptions v-if="detailNode" :column="2" bordered size="small">
                    <nn-descriptions-item label="名称">
                        {{ detailNode.moduleQualifiedName || detailNode.objectName || detailNode.title || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="模块">
                        {{ detailNode.moduleName || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="OID" :span="2">
                        <nn-typography-text copyable>{{ detailNode.oid || '-' }}</nn-typography-text>
                    </nn-descriptions-item>
                    <nn-descriptions-item label="路径" :span="2">
                        <nn-typography-text copyable>{{ detailNode.pathName || '-' }}</nn-typography-text>
                    </nn-descriptions-item>
                    <nn-descriptions-item label="类型">
                        {{ detailNode.macro || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="语法">
                        {{ detailNode.syntax || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="访问">
                        {{ detailNode.maxAccess || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="能力">
                        {{ getNodeAbilityText(detailNode) }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="查询 OID" :span="2">
                        <nn-typography-text copyable>
                            {{ detailNode.queryOid || detailNode.oid || '-' }}
                        </nn-typography-text>
                    </nn-descriptions-item>
                    <nn-descriptions-item label="状态">
                        {{ detailNode.status || '-' }}
                    </nn-descriptions-item>
                    <nn-descriptions-item label="枚举值" :span="2">
                        <span class="detail-enumerations">{{ formatEnumValues(detailNode.enumValues) }}</span>
                    </nn-descriptions-item>
                    <nn-descriptions-item label="描述" :span="2">
                        <span class="detail-description">{{ detailNode.description || '-' }}</span>
                    </nn-descriptions-item>
                </nn-descriptions>
            </div>
        </nn-modal>
    </div>
</template>

<script setup>
    import { computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from 'vue';
    import { notify } from '../../utils/notify';
    import {
        ApiOutlined,
        BellOutlined,
        CopyOutlined,
        EditOutlined,
        EyeOutlined,
        FileSearchOutlined,
        FileTextOutlined,
        FolderOpenOutlined,
        FolderOutlined,
        KeyOutlined,
        LoadingOutlined,
        ReloadOutlined,
        StepForwardOutlined,
        UnorderedListOutlined
    } from '../../ui/icons';
    import { usePaneResize } from '../yang/usePaneResize';
    import SnmpMibOperations from './SnmpMibOperations.vue';

    defineOptions({ name: 'SnmpMibWorkspace' });

    const CONTEXT_MENU_MARGIN = 8;
    const TREE_RELEASE_DELAY_MS = 300;
    const MIB_NODE_ICONS = Object.freeze({
        loading: LoadingOutlined,
        notification: BellOutlined,
        list: UnorderedListOutlined,
        key: KeyOutlined,
        write: EditOutlined,
        read: EyeOutlined,
        container: FolderOutlined,
        leaf: FileTextOutlined
    });

    const loading = ref(false);
    const oidTranslateLoading = ref(false);
    const oidQuery = ref('');
    const mibStatus = ref(emptyMibStatus());
    const treeRef = ref(null);
    const treeScrollRef = ref(null);
    const treeExpandedKeys = ref([]);
    const treeSelectedKeys = ref([]);
    const contextMenuRef = ref(null);
    const contextMenu = reactive({ visible: false, x: 0, y: 0, node: null });
    const operationsRef = ref(null);
    const operationContext = reactive({ node: null, operation: '', revision: 0 });
    const nodePropertyOpen = ref(false);
    const detailNode = ref(null);
    const workspaceLayoutRef = ref(null);
    const {
        paneSize: treePaneWidth,
        minSize: treePaneMinWidth,
        maxSize: treePaneMaxWidth,
        resizing: treePaneResizing,
        startResize: startTreePaneResize,
        handleResizeKeydown: handleTreePaneResizeKeydown,
        resetResize: resetTreePaneResize,
        stopResize: stopTreePaneResize
    } = usePaneResize({
        containerRef: workspaceLayoutRef,
        orientation: 'vertical',
        defaultRatio: 0,
        minFirst: 320,
        minSecond: 420,
        dividerSize: 8,
        frameSynchronized: true,
        previewStyleProperty: '--mib-tree-pane-width',
        activeWhen: () => window.matchMedia('(min-width: 981px)').matches
    });

    const treeLoadingPromises = new Map();
    const pendingTreeReleaseTimers = new Map();
    let statusLoadPromise = null;
    let statusRequestRevision = 0;
    let treeDataRevision = 0;
    let contextMenuOpenRequest = 0;
    let statusLoaded = false;

    function emptyMibStatus() {
        return {
            loadedFiles: [],
            failedFiles: [],
            skippedFiles: [],
            requestedFiles: [],
            modules: [],
            baseModules: [],
            totalObjects: 0,
            expandedFileCount: 0,
            cacheHit: false,
            oidTree: []
        };
    }

    const workspaceLayoutStyle = computed(() =>
        treePaneWidth.value > 0 ? { '--mib-tree-pane-width': `${treePaneWidth.value}px` } : undefined
    );

    const nodePropertyTitle = computed(() => {
        const name = detailNode.value?.moduleQualifiedName || detailNode.value?.objectName || detailNode.value?.title;
        return name ? `节点属性 · ${name}` : '节点属性';
    });

    const normalizeTreeNodes = nodes =>
        (Array.isArray(nodes) ? nodes : []).map(node => ({
            ...node,
            loading: false,
            children: normalizeTreeNodes(node.children),
            isLeaf: Boolean(node.isLeaf)
        }));

    const normalizeMibStatus = payload => ({
        loadedFiles: Array.isArray(payload?.loadedFiles) ? payload.loadedFiles : [],
        failedFiles: Array.isArray(payload?.failedFiles) ? payload.failedFiles : [],
        skippedFiles: Array.isArray(payload?.skippedFiles) ? payload.skippedFiles : [],
        requestedFiles: Array.isArray(payload?.requestedFiles) ? payload.requestedFiles : [],
        modules: Array.isArray(payload?.modules) ? payload.modules : [],
        baseModules: Array.isArray(payload?.baseModules) ? payload.baseModules : [],
        totalObjects: Number(payload?.totalObjects) || 0,
        expandedFileCount: Number(payload?.expandedFileCount) || 0,
        cacheHit: Boolean(payload?.cacheHit),
        oidTree: normalizeTreeNodes(payload?.oidTree)
    });

    const refreshTreeData = () => {
        mibStatus.value.oidTree = [...mibStatus.value.oidTree];
    };

    const findTreeNode = (nodes, key) => {
        for (const node of nodes || []) {
            if (node.key === key) return node;
            const matched = findTreeNode(node.children, key);
            if (matched) return matched;
        }
        return null;
    };

    const findAncestorKeys = (nodes, key, parents = []) => {
        for (const node of nodes || []) {
            if (node.key === key) return parents;
            const matched = findAncestorKeys(node.children, key, [...parents, node.key]);
            if (matched) return matched;
        }
        return null;
    };

    const collectDescendantKeys = node => {
        const keys = [];
        (node?.children || []).forEach(child => keys.push(child.key, ...collectDescendantKeys(child)));
        return keys;
    };

    const clearPendingTreeReleases = () => {
        pendingTreeReleaseTimers.forEach(timer => clearTimeout(timer));
        pendingTreeReleaseTimers.clear();
    };

    const cancelPendingTreeRelease = key => {
        const timer = pendingTreeReleaseTimers.get(key);
        if (!timer) return;
        clearTimeout(timer);
        pendingTreeReleaseTimers.delete(key);
    };

    const releaseTreeNodeChildren = node => {
        if (!node) return new Set();
        const descendantKeys = new Set(collectDescendantKeys(node));
        node.children = [];
        refreshTreeData();
        return descendantKeys;
    };

    const scheduleTreeNodeChildrenRelease = key => {
        cancelPendingTreeRelease(key);
        const requestedTreeRevision = treeDataRevision;
        const timer = setTimeout(() => {
            pendingTreeReleaseTimers.delete(key);
            nextTick(() => {
                if (requestedTreeRevision !== treeDataRevision || treeExpandedKeys.value.includes(key)) return;
                releaseTreeNodeChildren(findTreeNode(mibStatus.value.oidTree, key));
            });
        }, TREE_RELEASE_DELAY_MS);
        pendingTreeReleaseTimers.set(key, timer);
    };

    const loadTreeNodeChildren = async node => {
        const key = node?.key || node?.eventKey || node?.dataRef?.key;
        if (!key) return [];
        const targetNode = findTreeNode(mibStatus.value.oidTree, key);
        if (!targetNode || targetNode.isLeaf) return [];
        if (targetNode.children?.length) return targetNode.children;
        if (treeLoadingPromises.has(key)) return treeLoadingPromises.get(key);

        const requestedTreeRevision = treeDataRevision;
        let loadPromise;
        loadPromise = (async () => {
            targetNode.loading = true;
            refreshTreeData();
            try {
                const result = await window.snmpApi.getMibTreeChildren(key);
                if (requestedTreeRevision !== treeDataRevision) return [];
                if (result.status !== 'success') {
                    notify.error(result.msg || '获取 MIB 树节点失败');
                    return [];
                }
                const children = normalizeTreeNodes(result.data);
                if (!treeExpandedKeys.value.includes(key)) return [];
                targetNode.children = children;
                refreshTreeData();
                return children;
            } catch (error) {
                if (requestedTreeRevision === treeDataRevision) {
                    notify.error(`获取 MIB 树节点失败：${error.message}`);
                }
                return [];
            } finally {
                targetNode.loading = false;
                if (requestedTreeRevision === treeDataRevision) refreshTreeData();
                if (treeLoadingPromises.get(key) === loadPromise) treeLoadingPromises.delete(key);
            }
        })();
        treeLoadingPromises.set(key, loadPromise);
        return loadPromise;
    };

    const loadTreePath = async treePath => {
        const pathParts = Array.isArray(treePath) ? treePath.filter(Boolean) : [];
        for (let index = 0; index < pathParts.length - 1; index += 1) {
            const node = findTreeNode(mibStatus.value.oidTree, pathParts[index]);
            if (!node) return false;
            treeExpandedKeys.value = [...new Set([...treeExpandedKeys.value, pathParts[index]])];
            await loadTreeNodeChildren(node);
        }
        return true;
    };

    const findRenderedTreeOidElement = oid => {
        if (!treeScrollRef.value || !oid) return null;
        return (
            Array.from(treeScrollRef.value.querySelectorAll('.mib-node-title')).find(
                element => element.dataset.treeOid === oid
            ) || null
        );
    };

    const scrollToOidNode = async oid => {
        if (!oid) return;
        await nextTick();
        treeRef.value?.scrollTo?.({ key: oid, align: 'auto', offset: 24 });
        await nextTick();
        findRenderedTreeOidElement(oid)?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    };

    const revealOidNode = async (oid, treePath = []) => {
        if (treePath.length) await loadTreePath(treePath);
        const node = findTreeNode(mibStatus.value.oidTree, oid);
        if (!node) return null;
        const ancestors = findAncestorKeys(mibStatus.value.oidTree, oid) || [];
        treeSelectedKeys.value = [oid];
        treeExpandedKeys.value = [...new Set([...treeExpandedKeys.value, ...ancestors])];
        await scrollToOidNode(oid);
        return node;
    };

    const setOperationContext = (node, operation) => {
        operationContext.node = node ? { ...node } : null;
        operationContext.operation = operation || '';
        operationContext.revision += 1;
    };

    const resetTreeState = () => {
        treeDataRevision += 1;
        treeLoadingPromises.clear();
        clearPendingTreeReleases();
        treeExpandedKeys.value = [];
        treeSelectedKeys.value = [];
        contextMenu.node = null;
        hideContextMenu();
        detailNode.value = null;
        nodePropertyOpen.value = false;
        setOperationContext(null, '');
    };

    const applyMibStatus = payload => {
        resetTreeState();
        mibStatus.value = normalizeMibStatus(payload);
        statusLoaded = true;
    };

    const loadMibStatus = async ({ force = false } = {}) => {
        if (!force && statusLoaded) return;
        if (statusLoadPromise) return statusLoadPromise;

        const requestRevision = ++statusRequestRevision;
        let currentPromise;
        currentPromise = (async () => {
            loading.value = true;
            try {
                const result = await window.snmpApi.getMibStatus();
                if (requestRevision !== statusRequestRevision) return;
                if (result.status !== 'success') {
                    notify.error(result.msg || '获取 MIB 工作区失败');
                    return;
                }
                applyMibStatus(result.data);
            } catch (error) {
                if (requestRevision === statusRequestRevision) {
                    notify.error(`获取 MIB 工作区失败：${error.message}`);
                }
            } finally {
                if (requestRevision === statusRequestRevision) loading.value = false;
                if (statusLoadPromise === currentPromise) statusLoadPromise = null;
            }
        })();
        statusLoadPromise = currentPromise;
        return currentPromise;
    };

    const canGetNode = node => Boolean(node?.canGet);
    const canSetNode = node => Boolean(node?.canSet);

    const getNodeRoleText = node => {
        if (!node) return '';
        if (node.canSet) return 'GET/SET';
        if (node.canGet) return 'GET';
        if (node.notifyOnly) return 'Trap';
        if (node.nodeRole === 'not-accessible') return '不可访问';
        return '';
    };

    const getNodeRoleClass = node => {
        if (!node) return '';
        if (node.canSet) return 'is-write';
        if (node.canGet) return 'is-read';
        if (node.notifyOnly) return 'is-notify';
        if (node.nodeRole === 'not-accessible') return 'is-disabled';
        return '';
    };

    const getNodeAbilityText = node => {
        if (!node) return '-';
        if (node.canSet && node.isTableColumn) return '表字段可 GET/SET，需要指定表行索引';
        if (node.canSet && node.isScalar) return '标量可 GET/SET，查询时自动追加 .0';
        if (node.canSet) return '允许 GET 查询和 SET 设置';
        if (node.canGet && node.isTableColumn) return '表字段可 GET，需要指定表行索引';
        if (node.canGet && node.isScalar) return '标量可 GET，查询时自动追加 .0';
        if (node.canGet) return '允许 GET 查询，不允许 SET';
        if (node.notifyOnly) return '仅用于 Trap/Inform 通知变量';
        if (node.nodeRole === 'not-accessible') return '不可直接 GET/SET，多为表、行或分组节点';
        return '分组或标识节点，不直接承载查询值';
    };

    const mibNodeIconKind = node => {
        if (node?.loading) return 'loading';
        if (node?.notifyOnly) return 'notification';
        const name = String(node?.objectName || node?.title || '');
        const syntax = String(node?.syntax || '');
        if (/Table$/iu.test(name) || /SEQUENCE\s+OF/iu.test(syntax)) return 'list';
        if (node?.isTableColumn) return 'key';
        if (node?.canSet) return 'write';
        if (node?.canGet) return 'read';
        if (node?.hasChildren || !node?.isLeaf || /Entry$/iu.test(name)) return 'container';
        return 'leaf';
    };

    const mibNodeIconComponent = node => {
        const kind = mibNodeIconKind(node);
        if (kind === 'container' && treeExpandedKeys.value.includes(node?.key)) return FolderOpenOutlined;
        return MIB_NODE_ICONS[kind] || MIB_NODE_ICONS.leaf;
    };

    const handleTreeExpand = async (expandedKeys, { expanded, node }) => {
        const key = node?.key || node?.eventKey || node?.dataRef?.key;
        const matchedNode = findTreeNode(mibStatus.value.oidTree, key);
        if (!matchedNode) {
            treeExpandedKeys.value = expandedKeys;
            return;
        }
        if (expanded) {
            cancelPendingTreeRelease(key);
            treeExpandedKeys.value = expandedKeys;
            await loadTreeNodeChildren(matchedNode);
            return;
        }
        const descendantKeys = new Set(collectDescendantKeys(matchedNode));
        treeExpandedKeys.value = expandedKeys.filter(expandedKey => !descendantKeys.has(expandedKey));
        if (descendantKeys.has(treeSelectedKeys.value[0])) {
            treeSelectedKeys.value = [matchedNode.key];
            setOperationContext(null, '');
        }
        scheduleTreeNodeChildrenRelease(matchedNode.key);
        hideContextMenu();
    };

    const handleTreeSelect = selectedKeys => {
        treeSelectedKeys.value = selectedKeys;
        setOperationContext(null, '');
        hideContextMenu();
    };

    const locateOidNode = async () => {
        const oid = oidQuery.value.trim();
        if (!oid) {
            notify.warning('请输入 OID');
            return;
        }
        setOperationContext(null, '');
        try {
            oidTranslateLoading.value = true;
            const result = await window.snmpApi.translateOid(oid);
            if (result.status !== 'success') {
                notify.error(result.msg || 'OID 定位失败');
                return;
            }
            const translatedNode = result.data || { oid, matched: false };
            const treeNode = translatedNode.matchedOid
                ? await revealOidNode(translatedNode.matchedOid, translatedNode.treePath || [])
                : null;
            if (!treeNode) notify.info('未定位到 MIB 节点');
        } catch (error) {
            notify.error(`OID 定位失败：${error.message}`);
        } finally {
            oidTranslateLoading.value = false;
        }
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
        const matchedNode = findTreeNode(mibStatus.value.oidTree, key) || node?.dataRef || node;
        if (!matchedNode?.key) return;

        treeSelectedKeys.value = [matchedNode.key];
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

    const copyOid = async node => {
        if (!node?.oid) return;
        try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
            await navigator.clipboard.writeText(node.oid);
            notify.success('OID 已复制');
        } catch (_error) {
            oidQuery.value = node.oid;
            notify.warning('系统剪贴板不可用，已将 OID 填入输入框');
        }
    };

    const showNodeProperties = node => {
        if (!node) return;
        detailNode.value = { ...node };
        nodePropertyOpen.value = true;
    };

    const handleContextMenuClick = async ({ key }) => {
        const node = contextMenu.node;
        hideContextMenu();
        if (!node) return;
        if (key === 'properties') {
            showNodeProperties(node);
            return;
        }
        if (key === 'copy') {
            await copyOid(node);
            return;
        }
        if (['get', 'getNext', 'walk', 'set'].includes(key)) {
            setOperationContext(node, key);
        }
    };

    const formatEnumValues = enumValues => {
        if (Array.isArray(enumValues)) return enumValues.length ? enumValues.join('\n') : '-';
        if (!enumValues || typeof enumValues !== 'object') return '-';
        const entries = Object.entries(enumValues);
        return entries.length ? entries.map(([value, label]) => `${value} = ${label}`).join('\n') : '-';
    };

    defineExpose({
        clearValidationErrors: () => operationsRef.value?.clearValidationErrors?.(),
        refresh: () => loadMibStatus({ force: true })
    });

    onDeactivated(() => {
        stopTreePaneResize();
        hideContextMenu();
        nodePropertyOpen.value = false;
    });

    onMounted(() => {
        loadMibStatus({ force: true });
        window.addEventListener('resize', hideContextMenu);
        document.addEventListener('scroll', hideContextMenu, true);
    });

    onBeforeUnmount(() => {
        statusRequestRevision += 1;
        treeDataRevision += 1;
        stopTreePaneResize();
        clearPendingTreeReleases();
        treeLoadingPromises.clear();
        window.removeEventListener('resize', hideContextMenu);
        document.removeEventListener('scroll', hideContextMenu, true);
    });
</script>

<style scoped>
    .snmp-mib-workspace-page,
    .workspace-card {
        height: 100%;
        min-height: 0;
    }

    .snmp-mib-workspace-page {
        overflow: hidden;
    }

    .workspace-card {
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .workspace-card :deep(.nn-card-body) {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
        overflow: hidden;
    }

    .workspace-toolbar {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
    }

    .workspace-status,
    .workspace-actions,
    .oid-query-row {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 6px;
    }

    .workspace-status {
        flex: 1 1 auto;
        flex-wrap: wrap;
    }

    .workspace-status :deep(.nn-tag) {
        margin-inline-end: 0;
    }

    .workspace-actions {
        flex: 0 1 610px;
        justify-content: flex-end;
    }

    .oid-query-row {
        flex: 1 1 520px;
    }

    .oid-query-row :deep(.nn-input-affix-wrapper) {
        min-width: 180px;
    }

    .oid-query-row :deep(.nn-button),
    .workspace-actions > :deep(.nn-button) {
        flex: 0 0 auto;
    }

    .workspace-layout {
        display: grid;
        min-height: 0;
        flex: 1;
        grid-template-columns: var(--mib-tree-pane-width, 320px) 8px minmax(420px, 1fr);
        gap: 0;
        overflow: hidden;
    }

    .mib-tree-panel,
    .workspace-operation-panel {
        display: flex;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
    }

    .mib-tree-panel {
        flex-direction: column;
    }

    .workspace-operation-panel :deep(> *) {
        width: 100%;
        min-width: 0;
        min-height: 0;
        flex: 1;
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

    .panel-heading {
        min-width: 0;
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

    .mib-tree-scroll {
        min-height: 0;
        flex: 1;
        overflow: auto;
        padding: 6px;
    }

    .mib-tree-scroll :deep(.nn-spin-nested-loading),
    .mib-tree-scroll :deep(.nn-spin-container) {
        min-height: 100%;
    }

    .mib-tree-scroll :deep(.nn-tree) {
        display: inline-block;
        min-width: 100%;
    }

    .mib-node-title {
        display: inline-flex;
        min-width: max-content;
        align-items: center;
        gap: 5px;
        font-size: 12px;
        vertical-align: middle;
    }

    .mib-node-icon {
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

    .mib-node-icon-loading,
    .mib-node-icon-container,
    .mib-node-icon-write {
        color: var(--nn-color-primary);
    }

    .mib-node-icon-list,
    .mib-node-icon-key {
        color: var(--nn-color-text-info);
    }

    .mib-node-icon-read {
        color: var(--nn-color-text-success);
    }

    .mib-node-icon-notification {
        color: var(--nn-color-text-warning);
    }

    .mib-node-name {
        color: var(--nn-color-text-strong);
        font-weight: 500;
        white-space: nowrap;
    }

    .mib-node-oid,
    .mib-node-module,
    .mib-node-macro {
        flex: 0 0 auto;
        color: var(--nn-color-text-muted);
        font-size: 11px;
        white-space: nowrap;
    }

    .mib-node-macro {
        color: var(--nn-color-primary);
    }

    .mib-node-role {
        flex: 0 0 auto;
        padding: 0 4px;
        border-radius: 3px;
        font-size: 10px;
        line-height: 17px;
        white-space: nowrap;
    }

    .mib-node-role.is-read {
        color: var(--nn-color-text-info);
        background: var(--nn-color-bg-info-subtle);
    }

    .mib-node-role.is-write {
        color: var(--nn-color-text-success);
        background: var(--nn-color-bg-success-subtle);
    }

    .mib-node-role.is-notify {
        color: var(--nn-color-text-warning);
        background: var(--nn-color-bg-warning-subtle);
    }

    .mib-node-role.is-disabled {
        color: var(--nn-color-text-muted);
        background: var(--nn-color-bg-muted);
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

    .mib-context-menu {
        position: fixed;
        z-index: 1200;
        width: 224px;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        padding: 4px 0;
        overflow-y: auto;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-elevated);
        box-shadow: var(--nn-shadow-elevated);
    }

    .mib-context-menu-title {
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

    .mib-context-menu-title > span:first-child,
    .mib-context-menu-oid {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mib-context-menu-kind {
        flex: 0 0 auto;
        color: var(--nn-color-primary);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        font-weight: 500;
    }

    .mib-context-menu-oid {
        padding: 1px 12px 6px;
        color: var(--nn-color-text-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .mib-context-menu-list {
        border-inline-end: 0;
    }

    .mib-context-menu-list :deep(.nn-menu-item) {
        height: 30px;
        min-height: 30px;
        margin: 2px 4px;
        padding-block: 3px;
        border-radius: 4px;
        line-height: 24px;
    }

    .mib-context-menu-list :deep(.nn-menu-divider) {
        margin: 4px 0;
    }

    .mib-context-menu-hint {
        padding: 6px 12px 4px;
        color: var(--nn-color-text-muted);
        font-size: 11px;
        line-height: 17px;
        border-top: 1px solid var(--nn-color-border-light);
    }

    .node-property-scroll {
        max-height: calc(100vh - 180px);
        overflow-y: auto;
        text-align: left;
    }

    .node-property-scroll :deep(.nn-descriptions-item-bordered) {
        grid-template-columns: 92px minmax(0, 1fr);
    }

    .node-property-scroll :deep(.nn-descriptions-item-label),
    .node-property-scroll :deep(.nn-descriptions-item-content) {
        min-width: 0;
        overflow-wrap: anywhere;
        text-align: left;
    }

    .detail-description,
    .detail-enumerations {
        display: inline-block;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }

    @media (max-width: 1180px) {
        .workspace-toolbar {
            align-items: stretch;
            flex-direction: column;
        }

        .workspace-status,
        .workspace-actions {
            width: 100%;
        }

        .workspace-actions {
            flex-basis: auto;
        }
    }

    @media (max-width: 980px) {
        .workspace-layout {
            grid-template-columns: 1fr;
            grid-template-rows: minmax(340px, 1fr) minmax(560px, 1.5fr);
            overflow: auto;
        }

        .workspace-column-resizer {
            display: none;
        }
    }

    @media (max-width: 640px) {
        .workspace-actions,
        .oid-query-row {
            align-items: stretch;
            flex-direction: column;
        }

        .workspace-actions > :deep(.nn-button),
        .oid-query-row :deep(.nn-button) {
            width: 100%;
        }
    }
</style>
