<template>
    <div
        class="bgp-route-tree-workspace"
        :data-testid="`${testPrefix}-route-workspace`"
        :data-active-group-id="activeGroup?.id"
    >
        <aside class="route-tree-panel" aria-label="路由配置树">
            <div class="tree-panel-heading">
                <strong>路由配置树</strong>
                <span class="tree-panel-hint">右键管理节点</span>
                <nn-button
                    size="small"
                    type="text"
                    :data-testid="`${testPrefix}-add-group-button`"
                    :disabled="disabled"
                    @click="$emit('add-group')"
                >
                    <template #icon><PlusOutlined /></template>
                    路由组
                </nn-button>
            </div>
            <div class="route-tree-scroll" :inert="disabled ? '' : undefined">
                <nn-tree
                    v-model:expanded-keys="expandedKeys"
                    :selected-keys="[selectedKey]"
                    :tree-data="treeData"
                    block-node
                    :data-testid="`${testPrefix}-route-tree`"
                    :aria-label="`${getRouteProfile(profileKey).title} 路由组与属性`"
                    @select="handleSelect"
                    @right-click="handleTreeRightClick"
                >
                    <template #title="node">
                        <span
                            class="route-tree-title"
                            :class="[`is-${node.kind}`, { 'route-group-item': node.kind === 'group' }]"
                            :data-testid="node.testId"
                            :data-rule-id="node.ruleId"
                            :data-rule-section="node.ruleSection"
                            :data-rule-instance="node.instance"
                        >
                            <span class="tree-node-name">{{ node.title }}</span>
                            <span v-if="node.badge" class="tree-node-badge">{{ node.badge }}</span>
                            <span v-if="node.summary" class="tree-node-summary" :title="node.summary">
                                {{ node.summary }}
                            </span>
                        </span>
                    </template>
                </nn-tree>
            </div>
        </aside>

        <section v-if="activeGroup" class="route-node-editor" aria-label="选中节点配置">
            <div class="node-editor-topbar">
                <div class="node-editor-breadcrumb">
                    <span>{{ activeGroup.name || '未命名路由组' }}</span>
                    <span class="breadcrumb-separator">/</span>
                    <strong>
                        {{
                            selectedRule
                                ? `${selectedRuleBranch} / ${selectedRuleLabel}`
                                : isAttributesNode
                                  ? 'Path Attributes'
                                  : 'NLRI'
                        }}
                    </strong>
                </div>
            </div>

            <div class="route-node-scroll" :data-testid="`${testPrefix}-node-editor-scroll`">
                <template v-if="selectedRule">
                    <div class="attribute-editor-heading">
                        <div>
                            <h3>{{ selectedRuleLabel }}</h3>
                            <p>{{ selectedCatalog.description }}</p>
                        </div>
                    </div>
                    <nn-form layout="vertical" class="attribute-rule-form">
                        <nn-form-item v-if="modeOptions.length" label="生成方式" class="mode-field">
                            <nn-select
                                :value="selectedRule.mode"
                                :options="modeOptions"
                                :disabled="disabled"
                                aria-label="生成方式"
                                :data-testid="`${testPrefix}-attribute-mode-select`"
                                @update:value="value => updateRuleField('mode', value)"
                            />
                            <div class="generation-mode-help">{{ generationModeHelp }}</div>
                        </nn-form-item>
                        <RouteSchemaForm
                            :model-value="ruleEditorValue"
                            :sections="ruleSections"
                            :errors="ruleErrors"
                            :disabled="disabled"
                            @update:model-value="updateRuleValues"
                        />
                    </nn-form>
                    <div class="attribute-preview" :data-testid="`${testPrefix}-attribute-preview`">
                        <div class="preview-heading">
                            <strong>生成样例</strong>
                            <span>
                                {{
                                    selectedRule.mode === 'random'
                                        ? '随机范围样例，实际生成时独立取值'
                                        : '前 3 条路由的节点值'
                                }}
                            </span>
                        </div>
                        <div class="preview-values">
                            <div v-for="(value, index) in previewValues" :key="index" class="preview-value">
                                <span>路由 {{ index + 1 }}</span>
                                <code>{{ value }}</code>
                            </div>
                        </div>
                    </div>
                </template>

                <template v-else-if="isAttributesNode">
                    <div class="attributes-overview">
                        <h3>Path Attributes</h3>
                        <p>右键 Path Attributes 或属性节点可添加、删除属性；选中属性后配置生成规则。</p>
                        <div v-if="!attributeRules.length" class="attributes-empty">
                            还没有属性，右键 Path Attributes 选择“增加属性”开始配置。
                        </div>
                        <button
                            v-for="rule in attributeRules"
                            :key="rule.id"
                            type="button"
                            class="attribute-overview-row"
                            :disabled="disabled"
                            @click="selectAttribute(rule.id)"
                        >
                            <strong>{{ ruleDisplayLabel(rule, activeGroup.config) }}</strong>
                            <span>{{ describeAttributeRule(rule) }}</span>
                            <span class="attribute-row-edit">编辑 →</span>
                        </button>
                    </div>
                </template>

                <template v-else>
                    <div class="nlri-heading">
                        <h3>NLRI · 路由范围</h3>
                        <span>配置路由范围、编码及 NLRI 节点</span>
                    </div>
                    <label class="route-name-label" :for="`${testPrefix}-route-group-name-input`">路由组名称</label>
                    <nn-input
                        :id="`${testPrefix}-route-group-name-input`"
                        :value="activeGroup.name"
                        :data-testid="`${testPrefix}-route-group-name`"
                        :disabled="disabled"
                        :maxlength="80"
                        placeholder="为这组路由命名"
                        class="route-group-name-input"
                        @update:value="updateGroupName"
                    />
                    <nn-form :model="activeGroup.config" layout="vertical" class="nlri-form">
                        <RouteSchemaForm
                            :model-value="activeGroup.config"
                            :sections="basicSections"
                            :errors="errors"
                            :disabled="disabled"
                            @update:model-value="updateConfig"
                        />
                    </nn-form>
                </template>
            </div>
            <div class="node-editor-footer">
                <div class="route-range-preview" :data-testid="`${testPrefix}-route-range-preview`">
                    <span>{{ describeRouteRange(activeGroup.config) }}</span>
                    <strong>
                        {{ prefixCount.toLocaleString('zh-CN') }} {{ profileKey === 'mvpn' ? '个 NLRI' : '个前缀' }} ×
                        {{ pathCount.toLocaleString('zh-CN') }} 条路径 = {{ routeCount.toLocaleString('zh-CN') }} 条路由
                    </strong>
                </div>
            </div>
        </section>

        <nn-context-menu
            ref="contextMenuRef"
            v-model:open="contextMenuOpen"
            :width="236"
            :title="contextMenuKind === 'group' ? contextGroup?.name || '路由组' : contextNodeTitle"
            :meta="
                contextMenuKind === 'group'
                    ? contextGroupState
                        ? `已生成 ${contextGroupState.routeCount} 条`
                        : '路由组'
                    : contextGroup?.name
            "
            :hint="contextMenuHint"
            :data-testid="contextMenuTestId"
        >
            <nn-menu v-if="contextMenuKind === 'group'" :selectable="false" @click="handleGroupMenuClick">
                <nn-menu-item key="copy" :disabled="disabled" :data-testid="`${testPrefix}-copy-group-button`">
                    <template #icon><CopyOutlined /></template>
                    复制组
                </nn-menu-item>
                <nn-menu-item
                    key="withdraw"
                    :disabled="disabled || removeGroupDisabled || !contextGroupState"
                    :data-testid="`${testPrefix}-withdraw-group-button`"
                >
                    <template #icon><DeleteOutlined /></template>
                    撤销本组路由
                </nn-menu-item>
                <nn-menu-item
                    v-if="exportEnabled"
                    key="export"
                    :disabled="disabled || removeGroupDisabled || !contextGroupState"
                    :data-testid="`${testPrefix}-export-group-button`"
                >
                    导出 MRT
                </nn-menu-item>
                <nn-menu-item
                    key="remove"
                    :disabled="disabled || removeGroupDisabled || groups.length <= 1"
                    :data-testid="`${testPrefix}-remove-group-button`"
                >
                    <template #icon><DeleteOutlined /></template>
                    移除组
                </nn-menu-item>
                <nn-menu-divider />
                <nn-menu-item
                    key="refresh"
                    :disabled="disabled"
                    :data-testid="`${testPrefix}-refresh-group-state-button`"
                >
                    刷新生成状态
                </nn-menu-item>
            </nn-menu>
            <nn-menu
                v-else
                :key="`${contextGroupId}:${contextNodeKind}:${contextRuleId}`"
                :items="nodeMenuItems"
                :selectable="false"
                submenu-mode="popup"
                @click="handleNodeMenuClick"
            />
        </nn-context-menu>
    </div>
</template>

<script setup>
    import { computed, h, nextTick, onDeactivated, ref, watch } from 'vue';
    import { CopyOutlined, DeleteOutlined, PlusOutlined } from 'netnexus-ui/icons';
    import RouteSchemaForm from './RouteSchemaForm.vue';
    import { BGP_ADDR_FAMILY } from '../const/bgpConst';
    import {
        getRouteSections,
        describeRouteRange,
        describeRouteNlri,
        getRouteProfile
    } from '../view/bgp/bgpRouteWorkspace';
    import {
        ATTRIBUTE_CATALOG,
        ATTRIBUTE_MODES,
        getRouteTreeRules,
        getRuleSection,
        isAttributeRuleApplicable,
        isMpNlriEncoding,
        getGeneratedRouteCount,
        getGeneratedPrefixCount,
        getGeneratedPathCount,
        getRuleModeLabel,
        getRuleModeHelp,
        normalizeRouteRuleSections,
        createAttributeRule,
        getAttributeRuleFields,
        describeAttributeRule,
        previewAttributeRule
    } from '../view/bgp/bgpAttributeRules';

    const props = defineProps({
        profileKey: { type: String, default: 'ipv4' },
        testPrefix: { type: String, default: 'bgp-ipv4' },
        groups: { type: Array, required: true },
        activeGroupId: { type: String, required: true },
        disabled: { type: Boolean, default: false },
        removeGroupDisabled: { type: Boolean, default: false },
        exportEnabled: { type: Boolean, default: false },
        generationStates: { type: Array, default: () => [] },
        errors: { type: Object, default: () => ({}) }
    });
    const emit = defineEmits([
        'update:groups',
        'update:activeGroupId',
        'add-group',
        'copy-group',
        'remove-group',
        'withdraw-group',
        'export-group',
        'refresh-group-state'
    ]);
    const contextMenuRef = ref(null);
    const contextMenuOpen = ref(false);
    const contextGroupId = ref(null);
    const contextMenuKind = ref('group');
    const contextNodeKind = ref('group');
    const contextNodeTitle = ref('');
    const contextRuleId = ref(null);
    let contextMenuRequest = 0;
    const contextGroup = computed(() => props.groups.find(group => group.id === contextGroupId.value));
    const contextGroupState = computed(() =>
        props.generationStates.find(state => state.groupId === contextGroupId.value && Number(state.routeCount) > 0)
    );
    const contextRule = computed(
        () =>
            contextGroup.value &&
            visibleRouteRules(contextGroup.value.config).find(rule => rule.id === contextRuleId.value)
    );
    const contextMenuTestId = computed(
        () =>
            `${props.testPrefix}-${contextMenuKind.value === 'group' ? 'group' : contextMenuKind.value === 'nlri' ? 'nlri' : 'attribute'}-context-menu`
    );
    const contextMenuHint = computed(() =>
        contextMenuKind.value === 'group'
            ? props.removeGroupDisabled
                ? '请启动 BGP 后刷新生成状态，再撤销或移除组。'
                : '撤销按实际生成记录执行，配置会保留。'
            : contextMenuKind.value === 'nlri'
              ? '管理当前组的 NLRI 节点；MP Next Hop 在 MP 编码下使用。'
              : '可重复添加属性，每个节点独立配置。'
    );
    const selectedNode = ref({ kind: 'nlri', ruleId: null });
    const expandedKeys = ref([]);
    const fieldDrafts = ref({});
    const catalogFor = type =>
        ATTRIBUTE_CATALOG.find(entry => entry.type === type) || { type, label: type, modes: ['fixed'] };
    const isRuleVisible = (rule, config) =>
        isAttributeRuleApplicable(rule, config) &&
        (catalogFor(rule.type).treeGroup !== 'mpNlri' || isMpNlriEncoding(config));
    const visibleRouteRules = config => getRouteTreeRules(config).filter(rule => isRuleVisible(rule, config));
    const visibleAttributeRules = config => (config.attributeRules || []).filter(rule => isRuleVisible(rule, config));
    const activeGroup = computed(() => props.groups.find(group => group.id === props.activeGroupId) || props.groups[0]);
    const attributeRules = computed(() => visibleAttributeRules(activeGroup.value.config));
    const treeRules = computed(() => visibleRouteRules(activeGroup.value.config));
    const selectedRule = computed(() => treeRules.value.find(rule => rule.id === selectedNode.value.ruleId));
    const ruleStorageKey = rule => (getRuleSection(rule) === 'nlri' ? 'nlriRules' : 'attributeRules');
    const selectedRuleBranch = computed(() => {
        if (getRuleSection(selectedRule.value) !== 'nlri') return 'Path Attributes';
        return selectedCatalog.value.treeGroup === 'mpNlri' ? 'NLRI / MP_REACH_NLRI' : 'NLRI';
    });
    const isAttributesNode = computed(() => selectedNode.value.kind === 'attributes');
    const selectedCatalog = computed(() => catalogFor(selectedRule.value?.type));
    const rulesOfType = (rule, config) => visibleRouteRules(config).filter(item => item.type === rule.type);
    const ruleDisplayLabel = (rule, config) => {
        const siblings = rulesOfType(rule, config);
        const label = catalogFor(rule.type).label;
        return siblings.length > 1 ? `${label} #${siblings.findIndex(item => item.id === rule.id) + 1}` : label;
    };
    const selectedRuleLabel = computed(() => ruleDisplayLabel(selectedRule.value, activeGroup.value.config));
    const basicSections = computed(() =>
        getRouteSections(activeGroup.value.config, props.profileKey).map(section => ({
            ...section,
            title: '',
            description: '',
            fields: section.fields
        }))
    );
    const selectedKey = computed(() => {
        const groupId = activeGroup.value?.id;
        if (selectedNode.value.kind === 'group') return `${groupId}:group`;
        if (selectedNode.value.kind === 'mpNlri' && selectedRule.value) return `${groupId}:mpNlri`;
        if (selectedRule.value) return `${groupId}:rule:${selectedRule.value.id}`;
        return `${groupId}:${isAttributesNode.value ? 'attributes' : 'nlri'}`;
    });
    const ruleTreeNode = (rule, group) => ({
        key: `${group.id}:rule:${rule.id}`,
        kind: 'rule',
        groupId: group.id,
        ruleId: rule.id,
        ruleSection: getRuleSection(rule),
        title: ruleDisplayLabel(rule, group.config),
        instance: rulesOfType(rule, group.config).findIndex(item => item.id === rule.id) + 1,
        badge: getRuleModeLabel(rule),
        summary: describeAttributeRule(rule),
        testId: `${props.testPrefix}-tree-attribute-${rule.type}`
    });
    const nlriTreeChildren = group => {
        const rules = (group.config.nlriRules || []).filter(rule => isRuleVisible(rule, group.config));
        const mpRules = rules.filter(rule => catalogFor(rule.type).treeGroup === 'mpNlri');
        const children = rules
            .filter(rule => catalogFor(rule.type).treeGroup !== 'mpNlri')
            .map(rule => ruleTreeNode(rule, group));
        if (mpRules.length) {
            children.push({
                key: `${group.id}:mpNlri`,
                kind: 'mpNlri',
                groupId: group.id,
                ruleId: mpRules[0].id,
                ruleSection: 'nlri',
                title: 'MP_REACH_NLRI',
                badge: 'MP 编码',
                testId: `${props.testPrefix}-tree-mp-nlri-${group.id}`,
                children: mpRules.map(rule => ruleTreeNode(rule, group))
            });
        }
        return children;
    };
    const treeData = computed(() =>
        props.groups.map(group => ({
            key: `${group.id}:group`,
            kind: 'group',
            groupId: group.id,
            title: group.name || '未命名路由组',
            badge:
                props.profileKey === 'ipv4'
                    ? group.config.addressFamily === BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST
                        ? 'Label'
                        : 'UNC'
                    : getRouteProfile(props.profileKey).title,
            summary: props.generationStates.some(state => state.groupId === group.id)
                ? `已生成 ${props.generationStates.find(state => state.groupId === group.id).routeCount} 条`
                : '',
            testId: `${props.testPrefix}-tree-group-${group.id}`,
            children: [
                {
                    key: `${group.id}:nlri`,
                    kind: 'nlri',
                    groupId: group.id,
                    title: 'NLRI',
                    summary: describeRouteNlri(group.config),
                    testId: `${props.testPrefix}-tree-nlri-${group.id}`,
                    children: nlriTreeChildren(group)
                },
                {
                    key: `${group.id}:attributes`,
                    kind: 'attributes',
                    groupId: group.id,
                    title: 'Path Attributes',
                    badge: String(visibleAttributeRules(group.config).length),
                    testId: `${props.testPrefix}-tree-attributes-${group.id}`,
                    children: visibleAttributeRules(group.config).map(rule => ruleTreeNode(rule, group))
                }
            ]
        }))
    );
    const canAddRule = (entry, group) =>
        !!group &&
        isRuleVisible({ type: entry.type }, group.config) &&
        (entry.repeatable || !getRouteTreeRules(group.config).some(rule => rule.type === entry.type));
    const menuLabel = (label, testId) => () => h('span', { 'data-testid': testId }, label);
    const nodeMenuItems = computed(() => {
        const group = contextGroup.value;
        if (!group) return [];
        const entries = ATTRIBUTE_CATALOG.filter(
            entry =>
                getRuleSection(entry) === contextMenuKind.value && isRuleVisible({ type: entry.type }, group.config)
        );
        const items = [
            {
                key: 'add',
                label: menuLabel(
                    contextMenuKind.value === 'nlri' ? '增加 NLRI 节点' : '增加属性',
                    `${props.testPrefix}-add-attribute-button`
                ),
                icon: () => h(PlusOutlined),
                disabled: props.disabled || !entries.length,
                children: entries.map(entry => ({
                    key: `add:${entry.type}`,
                    label: menuLabel(entry.label, `${props.testPrefix}-add-attribute-${entry.type}`),
                    disabled: props.disabled || !canAddRule(entry, group),
                    title:
                        !entry.repeatable && getRouteTreeRules(group.config).some(rule => rule.type === entry.type)
                            ? '当前组已有此节点'
                            : entry.description
                }))
            }
        ];
        if (contextNodeKind.value === 'rule' && contextRule.value) {
            items.push(
                { type: 'divider' },
                {
                    key: 'remove-node',
                    label: menuLabel('删除节点', `${props.testPrefix}-remove-attribute-button`),
                    icon: () => h(DeleteOutlined),
                    disabled: props.disabled
                }
            );
        }
        return items;
    });
    const modeOptions = computed(() =>
        ATTRIBUTE_MODES.filter(option => (selectedCatalog.value.modes || []).includes(option.value))
    );
    const ruleFields = computed(() =>
        (selectedRule.value ? getAttributeRuleFields(selectedRule.value) : [])
            .filter(field => field.key !== 'mode')
            .map(field => ({
                ...field,
                testId:
                    field.testId ||
                    `${props.testPrefix}-attribute-${field.key}-${field.type === 'select' ? 'select' : field.type === 'switch' ? 'switch' : 'input'}`
            }))
    );
    const ruleSections = computed(() => [{ id: 'attributeRule', fields: ruleFields.value }]);
    const ruleEditorValue = computed(() => {
        const model = { ...selectedRule.value };
        const ruleKey = `${activeGroup.value.id}:${selectedRule.value?.id}`;
        ruleFields.value
            .filter(field => field.array)
            .forEach(field => {
                model[field.key] =
                    fieldDrafts.value[ruleKey]?.[field.key] ??
                    (Array.isArray(model[field.key]) ? model[field.key].join('\n') : String(model[field.key] || ''));
            });
        return model;
    });
    const ruleErrors = computed(() =>
        Object.fromEntries(ruleFields.value.map(field => [field.key, ruleFieldError(field.key)]))
    );
    const generationModeHelp = computed(() => getRuleModeHelp(selectedRule.value, activeGroup.value.config));
    const previewValues = computed(() =>
        [0, 1, 2].map(index => {
            try {
                const value = previewAttributeRule(selectedRule.value, index, activeGroup.value.config);
                return Array.isArray(value)
                    ? value.join(' ')
                    : typeof value === 'object'
                      ? JSON.stringify(value)
                      : String(value ?? '—');
            } catch (error) {
                return error.message || '请完善属性配置';
            }
        })
    );
    const routeCount = computed(() => getGeneratedRouteCount(activeGroup.value.config));
    const prefixCount = computed(() => getGeneratedPrefixCount(activeGroup.value.config));
    const pathCount = computed(() => getGeneratedPathCount(activeGroup.value.config));
    const updateGroupConfig = (groupId, config) => {
        const targetGroup = props.groups.find(group => group.id === groupId);
        if (props.disabled || !targetGroup) return;
        const normalizedConfig = normalizeRouteRuleSections(config);
        emit(
            'update:groups',
            props.groups.map(group => (group.id === groupId ? { ...group, config: normalizedConfig } : group))
        );
    };
    const updateConfig = config => updateGroupConfig(activeGroup.value.id, config);
    const updateGroupName = name => {
        if (props.disabled) return;
        emit(
            'update:groups',
            props.groups.map(group => (group.id === activeGroup.value.id ? { ...group, name } : group))
        );
    };
    const updateRuleField = (key, value) => {
        if (!selectedRule.value || props.disabled) return;
        const field = ruleFields.value.find(item => item.key === key);
        if (field?.array) {
            const ruleKey = `${activeGroup.value.id}:${selectedRule.value.id}`;
            fieldDrafts.value = {
                ...fieldDrafts.value,
                [ruleKey]: { ...fieldDrafts.value[ruleKey], [key]: String(value) }
            };
        }
        const parsedValue = field?.array
            ? String(value)
                  .split(/\r?\n/)
                  .map(item => item.trim())
                  .filter(Boolean)
            : value;
        const storageKey = ruleStorageKey(selectedRule.value);
        const rules = activeGroup.value.config[storageKey].map(rule =>
            rule.id === selectedRule.value.id ? { ...rule, [key]: parsedValue } : rule
        );
        updateConfig({ ...activeGroup.value.config, [storageKey]: rules });
    };
    const updateRuleValues = model => {
        const changedKey = Object.keys(model).find(key => model[key] !== ruleEditorValue.value[key]);
        if (changedKey) updateRuleField(changedKey, model[changedKey]);
    };
    const ruleFieldError = key => {
        const storageKey = ruleStorageKey(selectedRule.value);
        return (
            props.errors[`${storageKey}.${selectedRule.value?.id}.${key}`] ||
            props.errors[`${storageKey}.${selectedRule.value?.id}`] ||
            ''
        );
    };
    const handleSelect = (_keys, { node }) => {
        if (props.disabled || !node?.groupId) return;
        selectedNode.value = { kind: node.kind, ruleId: node.ruleId || null };
        emit('update:activeGroupId', node.groupId);
    };
    const closeContextMenu = () => {
        contextMenuRequest += 1;
        contextMenuRef.value?.close({ reason: 'api' });
        contextMenuOpen.value = false;
    };
    const handleTreeRightClick = async ({ event, node }) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (props.disabled || !node?.groupId) return;
        closeContextMenu();
        const request = ++contextMenuRequest;
        contextGroupId.value = node.groupId;
        contextNodeKind.value = node.kind;
        contextNodeTitle.value = node.title;
        contextRuleId.value = node.ruleId || null;
        contextMenuKind.value =
            node.kind === 'group'
                ? 'group'
                : node.kind === 'attributes'
                  ? 'attributes'
                  : node.kind === 'rule'
                    ? node.ruleSection
                    : 'nlri';
        selectedNode.value = { kind: node.kind, ruleId: node.ruleId || null };
        emit('update:activeGroupId', node.groupId);
        await nextTick();
        // A shorter editor can reset its scroll position; finish that layout before opening the menu.
        await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
        if (request !== contextMenuRequest || props.disabled || !contextGroup.value) return;
        await contextMenuRef.value?.openAt(event);
    };
    const handleGroupMenuClick = ({ key }) => {
        const groupId = contextGroupId.value;
        if (props.disabled || !contextGroup.value || contextMenuKind.value !== 'group') return;
        if (key === 'remove' && (props.removeGroupDisabled || props.groups.length <= 1)) return;
        if (key === 'withdraw' && (props.removeGroupDisabled || !contextGroupState.value)) return;
        if (key === 'export' && (!props.exportEnabled || props.removeGroupDisabled || !contextGroupState.value)) return;
        closeContextMenu();
        const events = {
            copy: 'copy-group',
            remove: 'remove-group',
            withdraw: 'withdraw-group',
            export: 'export-group',
            refresh: 'refresh-group-state'
        };
        if (events[key]) emit(events[key], groupId);
    };
    const selectAttribute = (
        ruleId,
        rule = treeRules.value.find(item => item.id === ruleId),
        groupId = activeGroup.value.id
    ) => {
        const group = props.groups.find(item => item.id === groupId);
        if (props.disabled || !rule || !group || !isRuleVisible(rule, group.config)) return;
        selectedNode.value = { kind: 'rule', ruleId };
        emit('update:activeGroupId', groupId);
        const keys = [`${groupId}:group`, `${groupId}:${getRuleSection(rule)}`];
        if (catalogFor(rule.type).treeGroup === 'mpNlri') keys.push(`${groupId}:mpNlri`);
        expandedKeys.value = [...new Set([...expandedKeys.value, ...keys])];
    };
    const addAttribute = (type, groupId) => {
        const group = props.groups.find(item => item.id === groupId);
        const entry = catalogFor(type);
        if (props.disabled || !canAddRule(entry, group)) return;
        const rule = createAttributeRule(type, group.config.addressFamily);
        const storageKey = ruleStorageKey(rule);
        updateGroupConfig(groupId, {
            ...group.config,
            [storageKey]: [...(group.config[storageKey] || []), rule]
        });
        selectAttribute(rule.id, rule, groupId);
    };
    const removeAttribute = (groupId, ruleId) => {
        const group = props.groups.find(item => item.id === groupId);
        const rule = group && getRouteTreeRules(group.config).find(item => item.id === ruleId);
        if (props.disabled || !rule) return;
        const section = getRuleSection(rule);
        const storageKey = ruleStorageKey(rule);
        updateGroupConfig(groupId, {
            ...group.config,
            [storageKey]: group.config[storageKey].filter(item => item.id !== ruleId)
        });
        selectedNode.value = { kind: section, ruleId: null };
        emit('update:activeGroupId', groupId);
    };
    const handleNodeMenuClick = ({ key }) => {
        if (props.disabled || !contextGroup.value || contextMenuKind.value === 'group') return;
        const groupId = contextGroupId.value;
        if (key.startsWith('add:')) {
            const type = key.slice(4);
            const entry = ATTRIBUTE_CATALOG.find(item => item.type === type);
            if (!entry || getRuleSection(entry) !== contextMenuKind.value || !canAddRule(entry, contextGroup.value))
                return;
            closeContextMenu();
            addAttribute(type, groupId);
        } else if (key === 'remove-node' && contextNodeKind.value === 'rule' && contextRule.value) {
            const ruleId = contextRuleId.value;
            closeContextMenu();
            removeAttribute(groupId, ruleId);
        }
    };

    watch(
        () => props.groups.map(group => group.id).join('|'),
        groupIds => {
            const ids = groupIds.split('|').filter(Boolean);
            const keys = ids.flatMap(id => [`${id}:group`, `${id}:nlri`, `${id}:mpNlri`, `${id}:attributes`]);
            expandedKeys.value = [...new Set([...expandedKeys.value.filter(key => keys.includes(key)), ...keys])];
        },
        { immediate: true }
    );
    watch(treeRules, rules => {
        if (selectedNode.value.ruleId && !rules.some(rule => rule.id === selectedNode.value.ruleId)) {
            selectedNode.value = { kind: 'nlri', ruleId: null };
        }
    });
    watch(
        () => props.disabled,
        disabled => {
            if (disabled) closeContextMenu();
        }
    );
    watch(contextGroup, group => {
        if (!group) closeContextMenu();
    });
    watch(contextRule, rule => {
        if (contextMenuOpen.value && contextNodeKind.value === 'rule' && !rule) closeContextMenu();
    });
    onDeactivated(closeContextMenu);
    defineExpose({ selectAttribute });
</script>

<style scoped>
    .bgp-route-tree-workspace {
        display: grid;
        grid-template-columns: 330px minmax(0, 1fr);
        grid-template-rows: minmax(0, 1fr);
        min-width: 0;
        height: min(560px, calc(100vh - 350px));
    }
    .route-tree-panel {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        border-right: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }
    .tree-panel-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 9px 12px;
        gap: 8px;
        border-bottom: 1px solid var(--nn-color-border-light);
        font-size: 12px;
    }
    .tree-panel-heading strong {
        color: var(--nn-color-text-strong);
    }
    .tree-panel-hint {
        margin-left: auto;
        color: var(--nn-color-text-secondary);
        font-size: 10px;
        white-space: nowrap;
    }
    .route-tree-scroll {
        flex: 1;
        padding: 8px 6px;
        min-height: 0;
        overflow: auto;
    }
    .route-tree-title {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        width: 100%;
        font-size: 12px;
    }
    .tree-node-name {
        flex: 0 0 auto;
        color: var(--nn-color-text);
    }
    .is-group .tree-node-name {
        font-weight: 600;
    }
    .tree-node-badge {
        flex: 0 0 auto;
        color: var(--nn-color-text-info);
        background: var(--nn-color-bg-selected);
        border-radius: 3px;
        padding: 0 4px;
        font-size: 10px;
        line-height: 18px;
    }
    .tree-node-summary {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--nn-color-text-secondary);
        font-size: 10px;
    }
    .route-node-editor {
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }
    .route-node-scroll {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 0 16px 12px;
    }
    .node-editor-topbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 8px 16px;
        flex-shrink: 0;
        padding: 10px 16px;
        border-bottom: 1px solid var(--nn-color-border-light);
    }
    .node-editor-breadcrumb {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        font-size: 12px;
        color: var(--nn-color-text-secondary);
    }
    .node-editor-breadcrumb > span:first-child {
        max-width: 170px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .node-editor-breadcrumb strong {
        color: var(--nn-color-text-strong);
        font-weight: 600;
    }
    .breadcrumb-separator {
        color: var(--nn-color-border);
    }
    .attribute-editor-heading {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
    }
    h3 {
        margin: 0;
        color: var(--nn-color-text-strong);
        font-size: 14px;
        font-weight: 600;
        line-height: 22px;
    }
    p {
        margin: 3px 0 0;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
        line-height: 18px;
    }
    .attribute-rule-form :deep(.nn-form-item) {
        margin-bottom: 10px;
    }
    .attribute-rule-form :deep(.nn-form-item-label) {
        padding-bottom: 4px;
        font-size: 12px;
    }
    .attribute-rule-form :deep(.nn-input) {
        height: 28px;
        font-size: 12px;
    }
    .attribute-rule-form :deep(.nn-select) {
        min-height: 28px;
    }
    .mode-field {
        max-width: 540px;
    }
    .mode-field :deep(.nn-select) {
        width: 190px;
    }
    .generation-mode-help {
        margin-top: 5px;
        color: var(--nn-color-text-secondary);
        font-size: 11px;
    }
    .attribute-rule-fields {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr));
        gap: 0 14px;
    }
    .wide-field {
        grid-column: 1 / -1;
    }
    .attribute-rule-fields :deep(.nn-form-item-extra),
    .attribute-rule-fields :deep(.nn-form-item-explain) {
        font-size: 11px;
        line-height: 16px;
    }
    .attribute-preview {
        padding: 10px 12px;
        margin-top: 2px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-muted);
    }
    .preview-heading {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 5px;
        font-size: 11px;
        color: var(--nn-color-text-secondary);
    }
    .preview-heading strong {
        color: var(--nn-color-text);
        font-size: 12px;
    }
    .preview-values {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin-top: 8px;
    }
    .preview-value {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
    }
    .preview-value > span {
        color: var(--nn-color-text-secondary);
        font-size: 10px;
    }
    .preview-value code {
        color: var(--nn-color-text-strong);
        font-size: 12px;
        overflow-wrap: anywhere;
    }
    .nlri-heading {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        margin-bottom: 10px;
    }
    .nlri-heading > span {
        color: var(--nn-color-text-secondary);
        font-size: 11px;
    }
    .route-name-label {
        display: block;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
        margin-bottom: 4px;
    }
    .route-group-name-input {
        max-width: 260px;
        height: 28px;
        margin-bottom: 8px;
    }
    .nlri-form :deep(.route-schema-section-heading) {
        display: none;
    }
    .nlri-form :deep(.nn-form-item-label) {
        padding-bottom: 3px;
    }
    .attributes-overview {
        flex: 1;
    }
    .attributes-overview p {
        margin-bottom: 12px;
    }
    .attributes-empty {
        padding: 28px 10px;
        text-align: center;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
    }
    .attribute-overview-row {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 9px 10px;
        margin-bottom: 5px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 5px;
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        text-align: left;
        cursor: pointer;
    }
    .attribute-overview-row:hover {
        border-color: var(--nn-color-border-info);
    }
    .attribute-overview-row strong {
        min-width: 102px;
        font-size: 12px;
    }
    .attribute-overview-row > span {
        color: var(--nn-color-text-secondary);
        font-size: 11px;
    }
    .attribute-overview-row .attribute-row-edit {
        margin-left: auto;
        color: var(--nn-color-text-info);
        white-space: nowrap;
    }
    .node-editor-footer {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 6px 12px;
        flex-shrink: 0;
        min-height: 40px;
        padding: 8px 16px;
        border-top: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-muted);
    }
    .route-range-preview {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        align-items: center;
        gap: 4px 12px;
        color: var(--nn-color-text-secondary);
        font-size: 11px;
    }
    .route-range-preview strong {
        color: var(--nn-color-text);
        font-weight: 600;
    }
    @media (max-width: 1050px) {
        .bgp-route-tree-workspace {
            grid-template-columns: 280px minmax(0, 1fr);
        }
        .node-editor-breadcrumb {
            width: 100%;
        }
    }
    @media (max-width: 720px) {
        .bgp-route-tree-workspace {
            grid-template-columns: 1fr;
            grid-template-rows: 140px minmax(0, 1fr);
            height: min(540px, calc(100vh - 280px));
        }
        .route-tree-panel {
            border-right: 0;
            border-bottom: 1px solid var(--nn-color-border-light);
        }
        .route-tree-scroll {
            min-height: 0;
        }
        .preview-values {
            grid-template-columns: 1fr;
        }
    }
</style>
