<template>
    <ul
        v-bind="forwardedAttrs"
        class="nn-menu"
        :class="[menuClass, attrs.class]"
        :style="attrs.style"
        role="menu"
        :aria-orientation="mode === 'horizontal' ? 'horizontal' : 'vertical'"
    >
        <NnMenuItems v-if="items.length > 0" :items="items" />
        <slot v-else />
    </ul>
</template>

<script setup>
    import { computed, defineComponent, h, inject, provide, ref, useAttrs } from 'vue';
    import NnMenuDivider from './NnMenuDivider.vue';
    import NnMenuItem from './NnMenuItem.vue';

    defineOptions({
        name: 'NnMenu',
        inheritAttrs: false
    });

    const props = defineProps({
        items: {
            type: Array,
            default: () => []
        },
        selectedKeys: {
            type: Array,
            default: undefined
        },
        openKeys: {
            type: Array,
            default: undefined
        },
        inlineCollapsed: {
            type: Boolean,
            default: false
        },
        selectable: {
            type: Boolean,
            default: true
        },
        mode: {
            type: String,
            default: 'vertical'
        }
    });

    const emit = defineEmits(['update:selectedKeys', 'update:openKeys', 'select', 'openChange', 'click']);
    const attrs = useAttrs();
    const internalSelectedKeys = ref([]);
    const internalOpenKeys = ref([]);

    const currentSelectedKeys = computed(() => props.selectedKeys ?? internalSelectedKeys.value);
    const currentOpenKeys = computed(() => props.openKeys ?? internalOpenKeys.value);
    const menuClass = computed(() => ({
        'nn-menu-inline': props.mode === 'inline',
        'nn-menu-horizontal': props.mode === 'horizontal',
        'nn-menu-vertical': props.mode !== 'inline' && props.mode !== 'horizontal',
        'nn-menu-inline-collapsed': props.inlineCollapsed
    }));

    const forwardedAttrs = computed(() => {
        const { class: _class, style: _style, ...rest } = attrs;
        return rest;
    });

    const handleItemClick = info => {
        emit('click', info);
        if (!props.selectable) {
            return;
        }
        const nextKeys = [info.key];
        internalSelectedKeys.value = nextKeys;
        emit('update:selectedKeys', nextKeys);
        emit('select', {
            ...info,
            selected: true,
            selectedKeys: nextKeys
        });
    };

    const toggleOpen = info => {
        if (info.disabled) {
            return;
        }
        const keys = currentOpenKeys.value;
        const isOpen = keys.includes(info.key);
        const nextKeys = isOpen ? keys.filter(key => key !== info.key) : [...keys, info.key];
        internalOpenKeys.value = nextKeys;
        emit('update:openKeys', nextKeys);
        emit('openChange', nextKeys);
    };

    provide('nnMenuContext', {
        selectedKeys: currentSelectedKeys,
        openKeys: currentOpenKeys,
        inlineCollapsed: computed(() => props.inlineCollapsed),
        selectable: computed(() => props.selectable),
        handleItemClick,
        toggleOpen
    });

    const renderValue = value => (typeof value === 'function' ? value() : value);

    const NnMenuItems = defineComponent({
        name: 'NnMenuItems',
        props: {
            items: {
                type: Array,
                default: () => []
            }
        },
        setup(itemsProps) {
            const menu = inject('nnMenuContext');

            const renderItems = (items, parentKeyPath = []) =>
                items.map((item, index) => {
                    if (item?.type === 'divider') {
                        return h(NnMenuDivider, { key: item.key ?? `divider-${parentKeyPath.join('-')}-${index}` });
                    }

                    const normalizedItem = item && typeof item === 'object' ? item : { label: item };
                    const key = normalizedItem.key ?? `${parentKeyPath.join('-') || 'menu'}-${index}`;
                    const keyPath = [...parentKeyPath, key];
                    const children = Array.isArray(normalizedItem.children) ? normalizedItem.children : [];

                    if (children.length > 0) {
                        const open = menu.openKeys.value.includes(key);
                        const childSelected = children.some(child => menu.selectedKeys.value.includes(child?.key));
                        return h(
                            'li',
                            {
                                key,
                                class: [
                                    'nn-menu-submenu',
                                    open && 'nn-menu-submenu-open',
                                    childSelected && 'nn-menu-submenu-selected',
                                    normalizedItem.disabled && 'nn-menu-submenu-disabled'
                                ],
                                role: 'none'
                            },
                            [
                                h(
                                    'button',
                                    {
                                        type: 'button',
                                        class: 'nn-menu-submenu-title',
                                        disabled: Boolean(normalizedItem.disabled),
                                        title: menu.inlineCollapsed.value
                                            ? normalizedItem.title || String(normalizedItem.label || '')
                                            : undefined,
                                        'aria-expanded': open ? 'true' : 'false',
                                        onClick: event =>
                                            menu.toggleOpen({
                                                key,
                                                keyPath,
                                                item: normalizedItem,
                                                disabled: Boolean(normalizedItem.disabled),
                                                domEvent: event
                                            })
                                    },
                                    [
                                        normalizedItem.icon
                                            ? h(
                                                  'span',
                                                  { class: 'nn-menu-item-icon' },
                                                  renderValue(normalizedItem.icon)
                                              )
                                            : null,
                                        h('span', { class: 'nn-menu-item-content' }, renderValue(normalizedItem.label)),
                                        h('span', { class: 'nn-menu-submenu-arrow', 'aria-hidden': 'true' }, '›')
                                    ]
                                ),
                                open && !menu.inlineCollapsed.value
                                    ? h(
                                          'ul',
                                          {
                                              class: 'nn-menu-submenu-list',
                                              role: 'menu'
                                          },
                                          renderItems(children, keyPath)
                                      )
                                    : null
                            ]
                        );
                    }

                    return h(
                        NnMenuItem,
                        {
                            key,
                            itemKey: key,
                            keyPath,
                            item: normalizedItem,
                            route: normalizedItem.route,
                            title: normalizedItem.title,
                            disabled: Boolean(normalizedItem.disabled)
                        },
                        {
                            icon: normalizedItem.icon ? () => renderValue(normalizedItem.icon) : undefined,
                            default: () => renderValue(normalizedItem.label)
                        }
                    );
                });

            return () => renderItems(itemsProps.items);
        }
    });
</script>

<style scoped>
    .nn-menu {
        min-width: 0;
        margin: 0;
        padding: 4px;
        border: 0;
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        font-size: 14px;
        line-height: 1.5;
        list-style: none;
        outline: none;
    }

    .nn-menu-horizontal {
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .nn-menu :deep(.nn-menu-item),
    .nn-menu :deep(.nn-menu-submenu-title) {
        width: calc(100% - 8px);
        margin: 2px 4px;
    }

    .nn-menu :deep(.nn-menu-submenu) {
        margin: 0;
        padding: 0;
        list-style: none;
    }

    .nn-menu :deep(.nn-menu-submenu-title) {
        display: flex;
        min-height: 36px;
        align-items: center;
        gap: 10px;
        padding: 6px 12px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: inherit;
        text-align: left;
    }

    .nn-menu :deep(.nn-menu-submenu-title:hover:not(:disabled)) {
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-primary);
    }

    .nn-menu :deep(.nn-menu-submenu-title:focus-visible) {
        box-shadow: var(--nn-focus-shadow-primary);
        outline: none;
    }

    .nn-menu :deep(.nn-menu-submenu-selected > .nn-menu-submenu-title) {
        color: var(--nn-color-primary);
    }

    .nn-menu :deep(.nn-menu-submenu-disabled > .nn-menu-submenu-title) {
        color: var(--nn-color-text-muted);
        cursor: not-allowed;
    }

    .nn-menu :deep(.nn-menu-submenu-list) {
        margin: 0;
        padding: 0 0 0 16px;
        list-style: none;
    }

    .nn-menu :deep(.nn-menu-submenu-arrow) {
        margin-inline-start: auto;
        transition: transform 0.2s;
    }

    .nn-menu :deep(.nn-menu-submenu-open > .nn-menu-submenu-title .nn-menu-submenu-arrow) {
        transform: rotate(90deg);
    }

    .nn-menu-inline-collapsed {
        width: 52px;
        padding-inline: 4px;
    }

    .nn-menu-inline-collapsed :deep(.nn-menu-item),
    .nn-menu-inline-collapsed :deep(.nn-menu-submenu-title) {
        justify-content: center;
        padding-inline: 0;
    }

    .nn-menu-inline-collapsed :deep(.nn-menu-item-content),
    .nn-menu-inline-collapsed :deep(.nn-menu-submenu-arrow) {
        display: none;
    }

    @media (prefers-reduced-motion: reduce) {
        .nn-menu :deep(.nn-menu-submenu-arrow) {
            transition: none;
        }
    }
</style>
