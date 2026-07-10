<template>
    <div class="nn-tabs" :class="tabsClass">
        <div
            class="nn-tabs-nav"
            role="tablist"
            :aria-orientation="tabPosition === 'left' ? 'vertical' : 'horizontal'"
        >
            <div class="nn-tabs-nav-wrap">
                <div class="nn-tabs-nav-list">
                    <button
                        v-for="tabPane in panes"
                        :key="String(tabPane.key)"
                        type="button"
                        class="nn-tabs-tab"
                        :class="{ 'nn-tabs-tab-active': isPaneActive(tabPane) }"
                        :disabled="tabPane.disabled"
                        role="tab"
                        :aria-selected="isPaneActive(tabPane) ? 'true' : 'false'"
                        :aria-controls="tabPane.panelId"
                        @click="selectPane(tabPane)"
                    >
                        <span class="nn-tabs-tab-button">{{ tabPane.tab }}</span>
                    </button>
                </div>
            </div>
        </div>

        <div class="nn-tabs-content-holder">
            <div class="nn-tabs-content">
                <NnTabPaneRenderer
                    v-for="tabPane in panes"
                    :key="String(tabPane.key)"
                    :pane="tabPane"
                    :active="isPaneActive(tabPane)"
                />
            </div>
        </div>
    </div>
</template>

<script setup>
    import { cloneVNode, computed, defineComponent, Fragment, ref, useSlots, watch } from 'vue';
    import NnTabPane from './NnTabPane.vue';

    const props = defineProps({
        activeKey: {
            type: [String, Number],
            default: undefined
        },
        size: {
            type: String,
            default: 'default'
        },
        tabPosition: {
            type: String,
            default: 'top'
        },
        type: {
            type: String,
            default: 'line'
        }
    });

    const emit = defineEmits(['update:activeKey', 'change']);

    const slots = useSlots();
    const internalActiveKey = ref(undefined);
    const hasControlledActiveKey = computed(
        () => props.activeKey !== undefined && props.activeKey !== null
    );
    const currentActiveKey = computed(() =>
        hasControlledActiveKey.value ? props.activeKey : internalActiveKey.value
    );

    const tabsClass = computed(() => ({
        'nn-tabs-small': props.size === 'small',
        'nn-tabs-card': props.type === 'card',
        'nn-tabs-left': props.tabPosition === 'left'
    }));

    const flattenPanes = nodes =>
        nodes.flatMap(node => {
            if (node.type === Fragment && Array.isArray(node.children)) {
                return flattenPanes(node.children);
            }

            return node.type === NnTabPane ? [node] : [];
        });

    const panes = computed(() =>
        flattenPanes(slots.default?.() ?? []).map((vnode, index) => {
            const key = vnode.key ?? `nn-tab-${index}`;

            return {
                key,
                tab: vnode.props?.tab ?? '',
                disabled: Boolean(vnode.props?.disabled),
                panelId: `nn-tab-panel-${String(key)}-${index}`,
                vnode
            };
        })
    );

    const isPaneActive = pane => pane.key === currentActiveKey.value;

    const selectPane = pane => {
        if (pane.disabled || isPaneActive(pane)) {
            return;
        }

        internalActiveKey.value = pane.key;
        emit('update:activeKey', pane.key);
        emit('change', pane.key);
    };

    const ensureActivePane = nextPanes => {
        if (nextPanes.some(isPaneActive)) {
            return;
        }

        const firstPane = nextPanes.find(pane => !pane.disabled);
        if (firstPane) {
            internalActiveKey.value = firstPane.key;

            if (hasControlledActiveKey.value) {
                emit('update:activeKey', firstPane.key);
            }
        }
    };

    watch(
        panes,
        nextPanes => {
            ensureActivePane(nextPanes);
        },
        { immediate: true }
    );

    const NnTabPaneRenderer = defineComponent({
        name: 'NnTabPaneRenderer',
        props: {
            pane: {
                type: Object,
                required: true
            },
            active: {
                type: Boolean,
                default: false
            }
        },
        setup(rendererProps) {
            return () =>
                cloneVNode(rendererProps.pane.vnode, {
                    active: rendererProps.active,
                    panelId: rendererProps.pane.panelId
                });
        }
    });
</script>

<style scoped>
    .nn-tabs {
        display: flex;
        flex-direction: column;
        min-width: 0;
        max-width: 100%;
        color: var(--nn-color-text);
    }

    .nn-tabs-nav {
        flex: 0 0 auto;
        min-width: 0;
        margin: 0 0 16px;
        border-bottom: 1px solid var(--nn-color-border);
    }

    .nn-tabs-nav-wrap {
        display: flex;
        align-items: stretch;
        overflow-x: auto;
        scrollbar-width: thin;
    }

    .nn-tabs-nav-list {
        display: flex;
        align-items: stretch;
        gap: 16px;
        min-width: max-content;
    }

    .nn-tabs-tab {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 40px;
        margin: 0;
        padding: 8px 0;
        border: 0;
        background: transparent;
        color: var(--nn-color-text-secondary);
        cursor: pointer;
        font: inherit;
        font-size: 14px;
        line-height: 22px;
        outline: none;
        white-space: nowrap;
        transition:
            color 0.2s,
            background-color 0.2s,
            border-color 0.2s,
            box-shadow 0.2s;
    }

    .nn-tabs-tab:hover:not(:disabled),
    .nn-tabs-tab-active {
        color: var(--nn-color-primary);
    }

    .nn-tabs-tab:focus-visible {
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-tabs-tab-active::after {
        position: absolute;
        right: 0;
        bottom: -1px;
        left: 0;
        height: 2px;
        background: var(--nn-color-primary);
        content: '';
    }

    .nn-tabs-tab:disabled {
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-tabs-content-holder,
    .nn-tabs-content,
    :deep(.nn-tabs-tabpane) {
        min-width: 0;
    }

    .nn-tabs-small .nn-tabs-nav {
        margin-bottom: 8px;
    }

    .nn-tabs-small .nn-tabs-tab {
        min-height: 32px;
        padding: 5px 0;
        font-size: 13px;
        line-height: 20px;
    }

    .nn-tabs-small .nn-tabs-nav-list {
        gap: 12px;
    }

    .nn-tabs-card .nn-tabs-nav {
        border-bottom: 0;
    }

    .nn-tabs-card .nn-tabs-nav-list {
        gap: 4px;
    }

    .nn-tabs-card .nn-tabs-tab {
        min-height: 34px;
        margin: 0;
        padding: 5px 14px;
        border: 1px solid var(--nn-color-border);
        border-radius: 4px;
        background: var(--nn-color-bg-muted);
    }

    .nn-tabs-card .nn-tabs-tab-active {
        border-color: var(--nn-color-primary);
        background: var(--nn-color-bg-surface);
    }

    .nn-tabs-card .nn-tabs-tab-active::after {
        display: none;
    }

    .nn-tabs-left {
        flex-direction: row;
        align-items: stretch;
    }

    .nn-tabs-left .nn-tabs-nav {
        flex: 0 0 auto;
        margin: 0 16px 0 0;
        border-right: 1px solid var(--nn-color-border);
        border-bottom: 0;
    }

    .nn-tabs-left .nn-tabs-nav-wrap {
        overflow-x: visible;
        overflow-y: auto;
    }

    .nn-tabs-left .nn-tabs-nav-list {
        flex-direction: column;
        align-items: stretch;
        gap: 0;
    }

    .nn-tabs-left .nn-tabs-tab {
        justify-content: flex-start;
        margin: 0;
        padding: 8px 20px 8px 0;
        text-align: left;
    }

    .nn-tabs-left .nn-tabs-tab-active::after {
        top: 0;
        right: -1px;
        bottom: 0;
        left: auto;
        width: 2px;
        height: auto;
    }

    .nn-tabs-left .nn-tabs-content-holder {
        flex: 1 1 0;
        min-width: 0;
    }
</style>
