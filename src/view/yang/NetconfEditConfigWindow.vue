<template>
    <div class="netconf-edit-config-window" data-testid="netconf-edit-config-monitor-page">
        <div v-if="loading" class="netconf-edit-config-state">
            <nn-spin size="large" tip="正在恢复 NETCONF Content Editor…" />
        </div>
        <div v-else-if="initialError" class="netconf-edit-config-state">
            <nn-alert type="error" show-icon message="无法打开 NETCONF Content Editor" :description="initialError" />
        </div>
        <template v-else>
            <nn-alert
                v-if="executionBlockedReason"
                class="netconf-edit-config-warning"
                type="warning"
                show-icon
                message="当前草稿已保留，但不能继续下发"
                :description="executionBlockedReason"
            />
            <YangOperations
                :key="editorKey"
                embedded
                show-execution-history
                operation="edit-config"
                :profile-id="profileId"
                :compile-id="compileId"
                :schema-tree="schemaTree"
                :context-revision="contextRevision"
                :context-node="contextNode"
                :context-subtree="contextSubtree"
                :context-config="contextConfig"
                :context-params="{ target }"
                :execution-blocked-reason="executionBlockedReason"
            />
        </template>
    </div>
</template>

<script setup>
    import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
    import { useRoute, useRouter } from 'vue-router';
    import EventBus from '../../utils/eventBus';
    import YangOperations from './YangOperations.vue';
    import { buildYangNodeXml, isSchemaDataNode } from './yangSchemaDraft';
    import { invokeBridge, unwrapArray } from './yangUiUtils';

    defineOptions({ name: 'NetconfEditConfigWindow' });

    const MAX_IDENTIFIER_BYTES = 1024;
    const ROOT_NODE_ID = 'yang-schema-root';
    const MAX_SCHEMA_DEPTH = 256;
    const MONITOR_CONTEXT_EVENT = 'window:monitorContext';
    const MONITOR_CONTEXT_LISTENER_ID = 'netconf-edit-config-monitor-context';
    const route = useRoute();
    const router = useRouter();
    const monitorWindowTitle = inject('monitorWindowTitle', null);
    const titleOwner = Symbol('netconf-edit-config-window-title');
    const loading = ref(true);
    const initialError = ref('');
    const executionBlockedReason = ref('');
    const profileName = ref('');
    const contextNode = shallowRef(null);
    const schemaTree = shallowRef([]);
    const contextSubtree = ref('');
    const contextConfig = ref('');
    const contextRevision = ref(0);
    const editorKey = ref(0);
    const profileId = ref('');
    const compileId = ref('');
    const nodeId = ref('');
    const target = ref('');
    let mounted = false;
    let contextLoadRevision = 0;
    let workspaceValidationRevision = 0;

    const hasControlCharacter = value =>
        Array.from(value).some(character => {
            const codePoint = character.codePointAt(0);
            return codePoint <= 31 || codePoint === 127;
        });

    const normalizeIdentifier = raw => {
        if (typeof raw !== 'string' || !raw || /^\s+$/u.test(raw) || hasControlCharacter(raw)) return '';
        return new TextEncoder().encode(raw).byteLength <= MAX_IDENTIFIER_BYTES ? raw : '';
    };

    const normalizeEditorContext = value => {
        const targetValue = normalizeIdentifier(value?.target);
        return {
            profileId: normalizeIdentifier(value?.profileId),
            compileId: normalizeIdentifier(value?.compileId),
            nodeId: normalizeIdentifier(value?.nodeId),
            target: ['candidate', 'running'].includes(targetValue) ? targetValue : ''
        };
    };

    const routeEditorContext = () =>
        normalizeEditorContext({
            profileId: route.query.profileId,
            compileId: route.query.compileId,
            nodeId: route.query.nodeId,
            target: route.query.target
        });

    const nodeLabel = computed(() => contextNode.value?.path || contextNode.value?.name || nodeId.value);
    const nativeTitle = computed(() =>
        ['edit-config', profileName.value || profileId.value, nodeLabel.value, target.value].filter(Boolean).join(' · ')
    );
    watch(nativeTitle, title => monitorWindowTitle?.setTitle(titleOwner, title || 'edit-config'), { immediate: true });

    const normalizeSchemaKeys = value => {
        const values = Array.isArray(value) ? value : String(value || '').split(/\s+/u);
        return [
            ...new Set(
                values
                    .map(item =>
                        String(item || '')
                            .split(':')
                            .at(-1)
                    )
                    .filter(name => /^[A-Za-z_][\w.-]*$/u.test(name))
            )
        ];
    };

    const normalizeSchemaChain = chain => {
        const normalized = chain.map((node, index) => {
            const id = node?.id || node?.nodeId || node?.key || `schema-node-${index}`;
            const keyword = String(node?.keyword || node?.kind || '')
                .trim()
                .toLowerCase();
            const name = node?.name || node?.title || id;
            const parent = chain[index - 1];
            const parentKeys =
                String(parent?.keyword || parent?.kind || '')
                    .trim()
                    .toLowerCase() === 'list'
                    ? normalizeSchemaKeys(parent?.schemaKey ?? parent?.listKey ?? parent?.listKeys)
                    : [];
            const hasChildren = Boolean(
                node?.hasChildren || Number(node?.childCount || 0) > 0 || index < chain.length - 1
            );
            return {
                ...node,
                id,
                key: id,
                name,
                title: node?.title || name,
                keyword: node?.keyword || node?.kind || '',
                schemaKey: node?.schemaKey ?? node?.listKey ?? node?.listKeys ?? [],
                isListKey:
                    node?.isListKey === true ||
                    (keyword === 'leaf' && parentKeys.includes(String(name).split(':').at(-1))),
                isLeaf: !hasChildren,
                children: [],
                // The chain only contains the selected branch. Keep lazy loading enabled
                // so parameter actions can still discover siblings from the compiled Schema.
                childrenLoaded: false,
                loading: false
            };
        });
        for (let index = normalized.length - 2; index >= 0; index -= 1) {
            normalized[index].children = [normalized[index + 1]];
        }
        return normalized;
    };

    const moduleNamespaceResolver = modules => node => {
        if (node?.namespace) return node.namespace;
        const module = modules.find(item => item?.name === node?.module || item?.id === node?.moduleId);
        return module?.namespace || module?.metadata?.namespace || '';
    };

    const resolveProfileName = async contextProfileId => {
        try {
            const { data } = await invokeBridge('netconfApi', 'listProfiles');
            const profile = unwrapArray(data, ['profiles', 'items']).find(
                item => (item?.id || item?.profileId) === contextProfileId
            );
            return profile?.name || profile?.profileName || '';
        } catch (_error) {
            // The stable Profile identifier still keeps the native title unambiguous.
            return '';
        }
    };

    const loadSchemaChain = async context => {
        const chain = [];
        const visited = new Set();
        let currentNodeId = context.nodeId;
        while (currentNodeId && currentNodeId !== ROOT_NODE_ID) {
            if (visited.has(currentNodeId) || chain.length >= MAX_SCHEMA_DEPTH) {
                throw new Error('Schema 祖先链无效或超过安全深度，请在主窗口重新打开该节点');
            }
            visited.add(currentNodeId);
            const { data } = await invokeBridge('yangApi', 'getSchemaNode', {
                profileId: context.profileId,
                compileId: context.compileId,
                nodeId: currentNodeId
            });
            const node = data?.node || data;
            if (!node || typeof node !== 'object') {
                throw new Error('指定的 Schema 节点不存在，请在主窗口重新打开');
            }
            chain.unshift(node);
            currentNodeId = node.parentId;
        }
        if (!chain.length || (currentNodeId && currentNodeId !== ROOT_NODE_ID)) {
            throw new Error('无法恢复完整的 Schema 上下文，请在主窗口重新打开');
        }
        return chain;
    };

    const buildEditorContext = async context => {
        if (!context.profileId || !context.compileId || !context.nodeId || !context.target) {
            throw new Error('窗口参数无效，请从 NETCONF Schema Browser 重新打开');
        }
        const { data } = await invokeBridge('yangApi', 'getWorkspace', { profileId: context.profileId });
        const workspace = data?.workspace || data || {};
        if (workspace.compileId !== context.compileId) {
            throw new Error('该 Schema 编译上下文已经更新，请从主窗口重新选择节点');
        }
        const chain = await loadSchemaChain(context);
        const selectedNode = chain.at(-1);
        if (!isSchemaDataNode(selectedNode) || selectedNode?.config === false) {
            throw new Error('指定节点不是可编辑的 config 数据节点');
        }
        const normalizedChain = normalizeSchemaChain(chain);
        const normalizedNode = normalizedChain.at(-1);
        const resolveNamespace = moduleNamespaceResolver(unwrapArray(workspace.modules, ['modules']));
        const dataChain = normalizedChain.filter(isSchemaDataNode);
        const subtree = buildYangNodeXml({
            node: normalizedNode,
            chain: dataChain,
            mode: 'filter',
            resolveNamespace
        });
        const config = buildYangNodeXml({
            node: normalizedNode,
            chain: dataChain,
            mode: 'config',
            resolveNamespace
        });
        if (!subtree || !config) throw new Error('无法为该 Schema 节点生成 edit-config 草稿');

        return {
            node: normalizedNode,
            schemaTree: normalizedChain.length ? [normalizedChain[0]] : [],
            subtree,
            config
        };
    };

    const syncRouteContext = context => {
        void router
            .replace({
                path: route.path,
                query: {
                    profileId: context.profileId,
                    compileId: context.compileId,
                    nodeId: context.nodeId,
                    target: context.target
                }
            })
            .catch(() => {});
    };

    const applyEditorContext = async (rawContext, { syncRoute = false } = {}) => {
        const nextContext = normalizeEditorContext(rawContext);
        const revision = ++contextLoadRevision;
        workspaceValidationRevision += 1;

        profileId.value = nextContext.profileId;
        compileId.value = nextContext.compileId;
        nodeId.value = nextContext.nodeId;
        target.value = nextContext.target;
        profileName.value = '';
        contextNode.value = null;
        schemaTree.value = [];
        contextSubtree.value = '';
        contextConfig.value = '';
        executionBlockedReason.value = '';
        initialError.value = '';
        loading.value = true;

        if (syncRoute && Object.values(nextContext).every(Boolean)) {
            syncRouteContext(nextContext);
        }

        try {
            const [editorContext, nextProfileName] = await Promise.all([
                buildEditorContext(nextContext),
                resolveProfileName(nextContext.profileId)
            ]);
            if (!mounted || revision !== contextLoadRevision) return;

            profileName.value = nextProfileName;
            contextNode.value = editorContext.node;
            schemaTree.value = editorContext.schemaTree;
            contextSubtree.value = editorContext.subtree;
            contextConfig.value = editorContext.config;
            contextRevision.value += 1;
            editorKey.value += 1;
        } catch (error) {
            if (mounted && revision === contextLoadRevision) initialError.value = error.message;
        } finally {
            if (mounted && revision === contextLoadRevision) loading.value = false;
        }
    };

    const validateWorkspaceContext = async () => {
        if (loading.value || initialError.value) return;
        const revision = ++workspaceValidationRevision;
        const contextProfileId = profileId.value;
        const contextCompileId = compileId.value;
        try {
            const { data } = await invokeBridge('yangApi', 'getWorkspace', { profileId: contextProfileId });
            if (!mounted || revision !== workspaceValidationRevision) return;
            const workspace = data?.workspace || data || {};
            executionBlockedReason.value =
                workspace.compileId === contextCompileId
                    ? ''
                    : '主窗口的 Schema 已重新编译或清空。当前 XML 草稿仍可复制，请重新打开节点后再执行。';
        } catch (error) {
            if (!mounted || revision !== workspaceValidationRevision) return;
            executionBlockedReason.value = `无法确认当前 Schema 上下文：${error.message}。为避免误下发，已暂停执行。`;
        }
    };

    const handleWindowFocus = () => {
        void validateWorkspaceContext();
    };

    const handleMonitorContext = payload => {
        if (payload?.monitorId !== 'netconf-edit-config') return;
        void applyEditorContext(payload, { syncRoute: true });
    };

    onMounted(async () => {
        mounted = true;
        window.addEventListener('focus', handleWindowFocus);
        EventBus.on(MONITOR_CONTEXT_EVENT, MONITOR_CONTEXT_LISTENER_ID, handleMonitorContext);
        await applyEditorContext(routeEditorContext());
    });

    onBeforeUnmount(() => {
        mounted = false;
        contextLoadRevision += 1;
        workspaceValidationRevision += 1;
        window.removeEventListener('focus', handleWindowFocus);
        EventBus.off(MONITOR_CONTEXT_EVENT, MONITOR_CONTEXT_LISTENER_ID);
        monitorWindowTitle?.clearTitle(titleOwner);
    });
</script>

<style scoped>
    .netconf-edit-config-window {
        display: flex;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
    }

    .netconf-edit-config-state {
        display: grid;
        min-height: 0;
        flex: 1 1 auto;
        place-items: center;
        padding: 24px;
    }

    .netconf-edit-config-state :deep(.nn-alert) {
        width: min(720px, 100%);
    }

    .netconf-edit-config-warning {
        flex: 0 0 auto;
        margin-bottom: 8px;
    }

    .netconf-edit-config-window > :deep(.yang-operations-page) {
        min-height: 0;
        flex: 1 1 auto;
    }
</style>
