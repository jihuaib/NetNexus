<template>
    <div
        ref="treeRootRef"
        class="nn-tree"
        :class="{
            'nn-tree-block-node': blockNode,
            'nn-tree-virtual': virtualEnabled
        }"
        :style="treeStyle"
        :data-nn-tree-virtual="virtualEnabled ? '' : undefined"
        role="tree"
        :aria-multiselectable="multiple ? 'true' : undefined"
        @scroll.passive="handleVirtualScroll"
    >
        <div
            v-if="virtualEnabled"
            class="nn-tree-virtual-spacer"
            :style="{ height: `${virtualWindow.beforeHeight}px` }"
            aria-hidden="true"
        />
        <div
            v-for="(record, index) in renderedNodes"
            :key="record.key"
            :ref="element => setNodeRef(record.key, element)"
            class="nn-tree-node"
            :class="getNodeClass(record)"
            role="treeitem"
            :tabindex="getNodeTabIndex(record, visibleIndex(index))"
            :aria-level="record.level + 1"
            :aria-selected="isSelected(record.key) ? 'true' : 'false'"
            :aria-expanded="record.isLeaf ? undefined : isExpanded(record.key) ? 'true' : 'false'"
            :aria-disabled="record.data.disabled ? 'true' : undefined"
            :style="getNodeStyle(record)"
            :data-nn-tree-virtual-index="virtualEnabled ? visibleIndex(index) : undefined"
            @click="handleSelect(record, $event)"
            @contextmenu="handleRightClick(record, $event)"
            @focus="focusedKey = record.key"
            @keydown="handleKeydown(record, visibleIndex(index), $event)"
        >
            <button
                v-if="!record.isLeaf"
                type="button"
                class="nn-tree-switcher"
                :class="{ 'nn-tree-switcher-open': isExpanded(record.key) }"
                :aria-label="isExpanded(record.key) ? '收起节点' : '展开节点'"
                :disabled="record.data.disableExpand"
                tabindex="-1"
                @click.stop="toggleExpanded(record, $event)"
            >
                <span class="nn-tree-switcher-icon" aria-hidden="true" />
            </button>
            <span v-else class="nn-tree-switcher nn-tree-switcher-noop" aria-hidden="true" />

            <span class="nn-tree-node-content">
                <span class="nn-tree-title">
                    <slot name="title" v-bind="record.data">
                        {{ record.data.title }}
                    </slot>
                </span>
            </span>
        </div>
        <div
            v-if="virtualEnabled"
            class="nn-tree-virtual-spacer"
            :style="{ height: `${virtualWindow.afterHeight}px` }"
            aria-hidden="true"
        />
    </div>
</template>

<script setup>
    import {
        computed,
        nextTick,
        onActivated,
        onBeforeUnmount,
        onBeforeUpdate,
        onDeactivated,
        onMounted,
        ref,
        watch
    } from 'vue';
    import { resolveTreeVirtualScrollTop, resolveTreeVirtualWindow } from '../treeVirtualization';

    defineOptions({ name: 'NnTree' });

    const props = defineProps({
        treeData: {
            type: Array,
            default: () => []
        },
        selectedKeys: {
            type: Array,
            default: () => []
        },
        expandedKeys: {
            type: Array,
            default: () => []
        },
        blockNode: {
            type: Boolean,
            default: false
        },
        virtual: {
            type: Boolean,
            default: false
        },
        height: {
            type: Number,
            default: undefined
        },
        itemHeight: {
            type: Number,
            default: 24
        },
        overscan: {
            type: Number,
            default: 4
        },
        multiple: {
            type: Boolean,
            default: false
        }
    });

    const emit = defineEmits(['update:selectedKeys', 'update:expandedKeys', 'select', 'expand', 'rightClick']);

    const treeRootRef = ref(null);
    const nodeRefs = new Map();
    const focusedKey = ref(undefined);
    const virtualScrollTop = ref(0);
    const measuredVirtualViewportHeight = ref(0);
    let retainedVirtualScrollTop = 0;
    let activationFrameId = 0;
    let activationSettleFrameId = 0;
    let virtualViewportResizeObserver = null;
    let componentActive = true;

    const virtualViewportHeight = computed(() =>
        Number.isFinite(props.height) && props.height > 0 ? props.height : 0
    );
    const virtualItemHeight = computed(() =>
        Number.isFinite(props.itemHeight) && props.itemHeight > 0 ? props.itemHeight : 24
    );
    const virtualOverscan = computed(() =>
        Number.isFinite(props.overscan) && props.overscan > 0 ? Math.floor(props.overscan) : 0
    );
    const virtualEnabled = computed(() => props.virtual === true && virtualViewportHeight.value > 0);
    const effectiveVirtualViewportHeight = computed(
        () => measuredVirtualViewportHeight.value || virtualViewportHeight.value
    );
    const treeStyle = computed(() =>
        virtualEnabled.value
            ? {
                  height: `${virtualViewportHeight.value}px`,
                  '--nn-tree-virtual-item-height': `${virtualItemHeight.value}px`
              }
            : undefined
    );

    const valuesEqual = (left, right) => Object.is(left, right);
    const includesKey = (keys, key) => (Array.isArray(keys) ? keys : []).some(item => valuesEqual(item, key));
    const getNodeKey = (node, path) => node?.key ?? node?.eventKey ?? `nn-tree-${path.join('-')}`;

    const isLeafNode = node => {
        if (node?.isLeaf === true) {
            return true;
        }

        if (Array.isArray(node?.children) && node.children.length > 0) {
            return false;
        }

        if (Object.prototype.hasOwnProperty.call(node || {}, 'isLeaf')) {
            return Boolean(node.isLeaf);
        }

        return true;
    };

    const allNodes = computed(() => {
        const records = [];

        const visit = (nodes, level = 0, parent = null, path = []) => {
            (Array.isArray(nodes) ? nodes : []).forEach((node, index) => {
                const nextPath = [...path, index];
                const record = {
                    key: getNodeKey(node, nextPath),
                    data: node,
                    level,
                    parent,
                    isLeaf: isLeafNode(node)
                };
                records.push(record);
                visit(node?.children, level + 1, record, nextPath);
            });
        };

        visit(props.treeData);
        return records;
    });

    const nodeMap = computed(() => new Map(allNodes.value.map(record => [record.key, record])));

    const visibleNodes = computed(() => {
        const records = [];

        const visit = (nodes, level = 0, parent = null, path = []) => {
            (Array.isArray(nodes) ? nodes : []).forEach((node, index) => {
                const nextPath = [...path, index];
                const key = getNodeKey(node, nextPath);
                const record = {
                    key,
                    data: node,
                    level,
                    parent,
                    isLeaf: isLeafNode(node)
                };
                records.push(record);

                if (!record.isLeaf && includesKey(props.expandedKeys, key)) {
                    visit(node?.children, level + 1, record, nextPath);
                }
            });
        };

        visit(props.treeData);
        return records;
    });

    const virtualWindow = computed(() =>
        resolveTreeVirtualWindow({
            itemCount: visibleNodes.value.length,
            itemHeight: virtualItemHeight.value,
            viewportHeight: effectiveVirtualViewportHeight.value,
            scrollTop: virtualScrollTop.value,
            overscan: virtualOverscan.value
        })
    );
    const renderedNodes = computed(() =>
        virtualEnabled.value
            ? visibleNodes.value.slice(virtualWindow.value.start, virtualWindow.value.end)
            : visibleNodes.value
    );
    const visibleNodeIndexMap = computed(() => new Map(visibleNodes.value.map((record, index) => [record.key, index])));
    const virtualTabStopKey = computed(() => {
        if (!virtualEnabled.value) return undefined;
        const renderedKeys = new Set(renderedNodes.value.map(record => record.key));
        if (renderedKeys.has(focusedKey.value)) return focusedKey.value;
        const selectedKey = props.selectedKeys.find(key => renderedKeys.has(key));
        return selectedKey ?? renderedNodes.value[0]?.key;
    });

    const visibleIndex = renderedIndex =>
        virtualEnabled.value ? virtualWindow.value.start + renderedIndex : renderedIndex;

    const getNodeStyle = record => ({ paddingInlineStart: `${record.level * 18}px` });

    const syncVirtualViewportHeight = () => {
        if (!virtualEnabled.value || !treeRootRef.value) return;
        const nextHeight = treeRootRef.value.clientHeight;
        if (nextHeight > 0 && nextHeight !== measuredVirtualViewportHeight.value) {
            measuredVirtualViewportHeight.value = nextHeight;
        }
    };

    const stopObservingVirtualViewport = () => {
        virtualViewportResizeObserver?.disconnect();
        virtualViewportResizeObserver = null;
    };

    const observeVirtualViewport = () => {
        stopObservingVirtualViewport();
        syncVirtualViewportHeight();
        if (!virtualEnabled.value || !treeRootRef.value || typeof ResizeObserver === 'undefined') return;
        virtualViewportResizeObserver = new ResizeObserver(syncVirtualViewportHeight);
        virtualViewportResizeObserver.observe(treeRootRef.value);
    };

    const handleVirtualScroll = event => {
        if (!componentActive || !virtualEnabled.value) return;
        syncVirtualViewportHeight();
        const nextScrollTop = event.currentTarget?.scrollTop || 0;
        retainedVirtualScrollTop = nextScrollTop;
        virtualScrollTop.value = nextScrollTop;
    };

    const isSelected = key => includesKey(props.selectedKeys, key);
    const isExpanded = key => includesKey(props.expandedKeys, key);

    const getNodeInfo = record => ({
        ...record.data,
        dataRef: record.data?.dataRef ?? record.data,
        eventKey: record.key,
        key: record.key
    });

    const getNodeClass = record => ({
        'nn-tree-node-selected': isSelected(record.key),
        'nn-tree-node-disabled': Boolean(record.data?.disabled),
        'nn-tree-node-leaf': record.isLeaf
    });

    const getNodeTabIndex = (record, index) => {
        if (virtualEnabled.value) {
            return valuesEqual(virtualTabStopKey.value, record.key) ? 0 : -1;
        }

        if (valuesEqual(focusedKey.value, record.key)) {
            return 0;
        }

        if (focusedKey.value === undefined && (isSelected(record.key) || index === 0)) {
            return 0;
        }

        return -1;
    };

    const getSelectedNodeData = keys => keys.map(key => nodeMap.value.get(key)?.data).filter(Boolean);

    const handleSelect = (record, nativeEvent) => {
        if (record.data?.disabled || record.data?.selectable === false) {
            return;
        }

        const wasSelected = isSelected(record.key);
        let nextKeys;
        if (props.multiple) {
            nextKeys = wasSelected
                ? props.selectedKeys.filter(key => !valuesEqual(key, record.key))
                : [...props.selectedKeys, record.key];
        } else {
            nextKeys = wasSelected ? [] : [record.key];
        }

        focusedKey.value = record.key;
        emit('update:selectedKeys', nextKeys);
        emit('select', nextKeys, {
            selected: !wasSelected,
            selectedNodes: getSelectedNodeData(nextKeys),
            node: getNodeInfo(record),
            event: 'select',
            nativeEvent
        });
    };

    const toggleExpanded = (record, nativeEvent) => {
        if (record.isLeaf || record.data?.disableExpand) {
            return;
        }

        const wasExpanded = isExpanded(record.key);
        const nextKeys = wasExpanded
            ? props.expandedKeys.filter(key => !valuesEqual(key, record.key))
            : [...props.expandedKeys, record.key];

        emit('update:expandedKeys', nextKeys);
        emit('expand', nextKeys, {
            expanded: !wasExpanded,
            node: getNodeInfo(record),
            nativeEvent
        });
    };

    const handleRightClick = (record, event) => {
        emit('rightClick', {
            event,
            node: getNodeInfo(record)
        });
    };

    const setVirtualScrollTop = value => {
        const nextScrollTop = Number(value) || 0;
        retainedVirtualScrollTop = nextScrollTop;
        virtualScrollTop.value = nextScrollTop;
        if (treeRootRef.value && treeRootRef.value.scrollTop !== nextScrollTop) {
            treeRootRef.value.scrollTop = nextScrollTop;
        }
    };

    const refreshVirtualLayout = async () => {
        await nextTick();
        if (!virtualEnabled.value || !treeRootRef.value) return false;
        syncVirtualViewportHeight();
        const restoredWindow = resolveTreeVirtualWindow({
            itemCount: visibleNodes.value.length,
            itemHeight: virtualItemHeight.value,
            viewportHeight: effectiveVirtualViewportHeight.value,
            scrollTop: retainedVirtualScrollTop,
            overscan: virtualOverscan.value
        });
        setVirtualScrollTop(restoredWindow.scrollTop);
        await nextTick();
        if (treeRootRef.value && treeRootRef.value.scrollTop !== restoredWindow.scrollTop) {
            treeRootRef.value.scrollTop = restoredWindow.scrollTop;
        }
        return true;
    };

    const cancelActivationRefresh = () => {
        if (typeof window === 'undefined') return;
        if (activationFrameId) window.cancelAnimationFrame(activationFrameId);
        if (activationSettleFrameId) window.cancelAnimationFrame(activationSettleFrameId);
        activationFrameId = 0;
        activationSettleFrameId = 0;
    };

    const scheduleActivationRefresh = () => {
        cancelActivationRefresh();
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
            void refreshVirtualLayout();
            return;
        }
        nextTick(() => {
            activationFrameId = window.requestAnimationFrame(() => {
                activationFrameId = 0;
                activationSettleFrameId = window.requestAnimationFrame(() => {
                    activationSettleFrameId = 0;
                    void refreshVirtualLayout();
                });
            });
        });
    };

    const scrollVirtualIndexIntoView = (index, align = 'auto', offset = 0) => {
        if (!virtualEnabled.value || index < 0) return;
        syncVirtualViewportHeight();
        setVirtualScrollTop(
            resolveTreeVirtualScrollTop({
                index,
                itemCount: visibleNodes.value.length,
                itemHeight: virtualItemHeight.value,
                viewportHeight: effectiveVirtualViewportHeight.value,
                currentScrollTop: virtualScrollTop.value,
                align,
                offset
            })
        );
    };

    const focusRecord = async record => {
        if (!record) {
            return;
        }

        focusedKey.value = record.key;
        if (virtualEnabled.value) {
            scrollVirtualIndexIntoView(visibleNodeIndexMap.value.get(record.key) ?? -1);
        }
        await nextTick();
        nodeRefs.get(record.key)?.focus();
    };

    const handleKeydown = (record, index, event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusRecord(visibleNodes.value[index + 1]);
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusRecord(visibleNodes.value[index - 1]);
            return;
        }

        if (event.key === 'ArrowRight' && !record.isLeaf) {
            event.preventDefault();
            if (!isExpanded(record.key)) {
                toggleExpanded(record, event);
            } else {
                focusRecord(visibleNodes.value[index + 1]);
            }
            return;
        }

        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            if (!record.isLeaf && isExpanded(record.key)) {
                toggleExpanded(record, event);
            } else {
                focusRecord(record.parent);
            }
            return;
        }

        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleSelect(record, event);
        }
    };

    const setNodeRef = (key, element) => {
        if (element) {
            nodeRefs.set(key, element);
        } else {
            nodeRefs.delete(key);
        }
    };

    const findScrollParent = element => {
        let parent = element?.parentElement;
        while (parent && parent !== document.body) {
            const style = window.getComputedStyle(parent);
            if (/(auto|scroll|overlay)/.test(`${style.overflow}${style.overflowY}`)) {
                return parent;
            }
            parent = parent.parentElement;
        }

        return null;
    };

    const scrollTo = async ({ key, align = 'auto', offset = 0 } = {}) => {
        await nextTick();
        if (virtualEnabled.value) {
            const index = visibleNodeIndexMap.value.get(key);
            if (index === undefined) return;
            scrollVirtualIndexIntoView(index, align, offset);
            await nextTick();
            return;
        }

        const element = nodeRefs.get(key);
        if (!element) {
            return;
        }

        const scrollParent = findScrollParent(element);
        if (!scrollParent) {
            element.scrollIntoView({ block: align === 'top' ? 'start' : align === 'bottom' ? 'end' : 'nearest' });
            return;
        }

        const elementRect = element.getBoundingClientRect();
        const parentRect = scrollParent.getBoundingClientRect();
        const numericOffset = Number(offset) || 0;

        if (align === 'top') {
            scrollParent.scrollTop += elementRect.top - parentRect.top - numericOffset;
        } else if (align === 'bottom') {
            scrollParent.scrollTop += elementRect.bottom - parentRect.bottom + numericOffset;
        } else if (elementRect.top < parentRect.top + numericOffset) {
            scrollParent.scrollTop += elementRect.top - parentRect.top - numericOffset;
        } else if (elementRect.bottom > parentRect.bottom) {
            scrollParent.scrollTop += elementRect.bottom - parentRect.bottom;
        }
    };

    watch(
        [
            virtualEnabled,
            () => visibleNodes.value.length,
            virtualViewportHeight,
            effectiveVirtualViewportHeight,
            virtualItemHeight
        ],
        () => {
            if (!virtualEnabled.value) {
                stopObservingVirtualViewport();
                measuredVirtualViewportHeight.value = 0;
                retainedVirtualScrollTop = 0;
                virtualScrollTop.value = 0;
                return;
            }
            const nextScrollTop = virtualWindow.value.scrollTop;
            retainedVirtualScrollTop = nextScrollTop;
            if (nextScrollTop !== virtualScrollTop.value) virtualScrollTop.value = nextScrollTop;
            nextTick(() => {
                if (treeRootRef.value && treeRootRef.value.scrollTop !== nextScrollTop) {
                    treeRootRef.value.scrollTop = nextScrollTop;
                }
            });
        },
        { flush: 'post' }
    );

    onBeforeUpdate(() => {
        nodeRefs.clear();
    });

    onMounted(() => {
        observeVirtualViewport();
    });

    onActivated(() => {
        componentActive = true;
        nextTick(observeVirtualViewport);
        scheduleActivationRefresh();
    });

    onDeactivated(() => {
        componentActive = false;
        stopObservingVirtualViewport();
        cancelActivationRefresh();
    });

    onBeforeUnmount(() => {
        componentActive = false;
        stopObservingVirtualViewport();
        cancelActivationRefresh();
    });

    defineExpose({
        scrollTo,
        refreshVirtualLayout,
        focus: () => treeRootRef.value?.querySelector('[tabindex="0"]')?.focus()
    });
</script>

<style scoped>
    .nn-tree {
        display: inline-block;
        min-width: 100%;
        color: var(--nn-color-text);
        font-size: 14px;
        line-height: 1.5715;
        outline: none;
    }

    .nn-tree-virtual {
        display: block;
        width: 100%;
        overflow: auto;
        overflow-anchor: none;
        contain: layout;
    }

    .nn-tree-virtual-spacer {
        width: 1px;
        min-height: 0;
        pointer-events: none;
    }

    .nn-tree-node {
        display: flex;
        align-items: center;
        min-width: max-content;
        min-height: 24px;
        outline: none;
    }

    .nn-tree-virtual .nn-tree-node {
        box-sizing: border-box;
        height: var(--nn-tree-virtual-item-height);
        min-height: var(--nn-tree-virtual-item-height);
        overflow: hidden;
    }

    .nn-tree-block-node .nn-tree-node {
        width: 100%;
    }

    .nn-tree-switcher {
        display: inline-flex;
        flex: 0 0 24px;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--nn-color-text-muted);
        cursor: pointer;
        outline: none;
    }

    .nn-tree-switcher:hover:not(:disabled) {
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-primary);
    }

    .nn-tree-switcher:focus-visible {
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-tree-switcher:disabled {
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-tree-switcher-icon {
        width: 0;
        height: 0;
        border-top: 4px solid transparent;
        border-bottom: 4px solid transparent;
        border-left: 6px solid currentColor;
        transition: transform 0.16s ease;
    }

    .nn-tree-switcher-open .nn-tree-switcher-icon {
        transform: rotate(90deg);
    }

    .nn-tree-switcher-noop {
        cursor: default;
    }

    .nn-tree-node-content {
        display: inline-flex;
        flex: 1 1 auto;
        align-items: center;
        min-width: 0;
        min-height: 22px;
        padding: 0 5px;
        border-radius: 4px;
        cursor: pointer;
        transition:
            color 0.16s,
            background-color 0.16s,
            box-shadow 0.16s;
    }

    .nn-tree-node:hover > .nn-tree-node-content {
        background: var(--nn-color-bg-hover);
    }

    .nn-tree-node:focus-visible > .nn-tree-node-content {
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-tree-node-selected > .nn-tree-node-content {
        background: var(--nn-color-bg-selected);
        color: var(--nn-color-primary);
    }

    .nn-tree-node-disabled > .nn-tree-node-content {
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-tree-title {
        display: block;
        min-width: 0;
        max-width: 100%;
    }
</style>
