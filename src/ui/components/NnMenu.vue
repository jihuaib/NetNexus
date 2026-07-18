<template>
    <ul
        ref="menuRootRef"
        v-bind="forwardedAttrs"
        class="nn-menu"
        :class="[menuClass, attrs.class]"
        :style="attrs.style"
        role="menu"
        :aria-orientation="mode === 'horizontal' ? 'horizontal' : 'vertical'"
        @keydown="handleRootKeydown"
    >
        <NnMenuItems v-if="items.length > 0" :items="items" />
        <slot v-else />
    </ul>
</template>

<script setup>
    import { computed, defineComponent, h, inject, nextTick, provide, reactive, ref, useAttrs } from 'vue';
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
        },
        submenuMode: {
            type: String,
            default: 'inline',
            validator: value => ['inline', 'popup'].includes(value)
        }
    });

    const emit = defineEmits(['update:selectedKeys', 'update:openKeys', 'select', 'openChange', 'click']);
    const attrs = useAttrs();
    const menuRootRef = ref(null);
    const internalSelectedKeys = ref([]);
    const internalOpenKeys = ref([]);
    const submenuKeyPaths = new Map();
    const popupPositions = reactive(new Map());

    const currentSelectedKeys = computed(() => props.selectedKeys ?? internalSelectedKeys.value);
    const currentOpenKeys = computed(() => props.openKeys ?? internalOpenKeys.value);
    const popupSubmenus = computed(() => props.submenuMode === 'popup');
    const menuClass = computed(() => ({
        'nn-menu-inline': props.mode === 'inline',
        'nn-menu-horizontal': props.mode === 'horizontal',
        'nn-menu-vertical': props.mode !== 'inline' && props.mode !== 'horizontal',
        'nn-menu-inline-collapsed': props.inlineCollapsed,
        'nn-menu-popup-submenus': popupSubmenus.value
    }));

    const forwardedAttrs = computed(() => {
        const { class: _class, style: _style, ...rest } = attrs;
        return rest;
    });

    const updateOpenKeys = nextKeys => {
        internalOpenKeys.value = nextKeys;
        emit('update:openKeys', nextKeys);
        emit('openChange', nextKeys);
    };

    const isPathPrefix = (prefix, path) =>
        prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);

    const registerSubmenu = (key, keyPath) => {
        submenuKeyPaths.set(key, keyPath);
    };

    const setSubmenuOpen = (info, nextOpen) => {
        if (info.disabled) return;

        const keys = currentOpenKeys.value;
        let nextKeys;
        if (popupSubmenus.value) {
            if (nextOpen) {
                const ancestorKeys = info.keyPath.slice(0, -1);
                nextKeys = keys.filter(key => ancestorKeys.includes(key));
                if (!nextKeys.includes(info.key)) nextKeys.push(info.key);
            } else {
                nextKeys = keys.filter(key => {
                    const registeredPath = submenuKeyPaths.get(key);
                    return !registeredPath || !isPathPrefix(info.keyPath, registeredPath);
                });
                for (const key of keys) {
                    if (!nextKeys.includes(key)) popupPositions.delete(key);
                }
            }
        } else {
            nextKeys = nextOpen ? [...keys, info.key] : keys.filter(key => key !== info.key);
        }
        updateOpenKeys([...new Set(nextKeys)]);
    };

    const toggleOpen = info => {
        setSubmenuOpen(info, !currentOpenKeys.value.includes(info.key));
    };

    const closePopupSubmenus = () => {
        if (!popupSubmenus.value || currentOpenKeys.value.length === 0) return;
        popupPositions.clear();
        updateOpenKeys([]);
    };

    const setInitialPopupPosition = (key, titleElement) => {
        const rect = titleElement?.getBoundingClientRect?.();
        if (!rect) return;
        popupPositions.set(key, {
            top: Math.round(rect.top - 4),
            left: Math.round(rect.right - 2),
            minWidth: Math.max(180, Math.round(rect.width))
        });
    };

    const positionPopup = async (key, titleElement) => {
        if (!popupSubmenus.value || !titleElement) return;
        setInitialPopupPosition(key, titleElement);
        await nextTick();

        const submenu = titleElement.parentElement?.querySelector(':scope > .nn-menu-submenu-list');
        if (!submenu) return;
        const titleRect = titleElement.getBoundingClientRect();
        const submenuRect = submenu.getBoundingClientRect();
        const viewportMargin = 8;
        let left = titleRect.right - 2;
        let top = titleRect.top - 4;

        if (left + submenuRect.width > window.innerWidth - viewportMargin) {
            left = titleRect.left - submenuRect.width + 2;
        }
        left = Math.min(
            Math.max(viewportMargin, left),
            Math.max(viewportMargin, window.innerWidth - submenuRect.width - viewportMargin)
        );
        if (top + submenuRect.height > window.innerHeight - viewportMargin) {
            top = window.innerHeight - submenuRect.height - viewportMargin;
        }
        top = Math.max(viewportMargin, top);
        popupPositions.set(key, {
            top: Math.round(top),
            left: Math.round(left),
            minWidth: Math.max(180, Math.round(titleRect.width))
        });
    };

    const handleItemClick = info => {
        emit('click', info);
        if (popupSubmenus.value) closePopupSubmenus();
        if (!props.selectable) return;

        const nextKeys = [info.key];
        internalSelectedKeys.value = nextKeys;
        emit('update:selectedKeys', nextKeys);
        emit('select', {
            ...info,
            selected: true,
            selectedKeys: nextKeys
        });
    };

    const handleRootKeydown = event => {
        if (event.key !== 'Escape' || !popupSubmenus.value || currentOpenKeys.value.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        closePopupSubmenus();
    };

    provide('nnMenuContext', {
        selectedKeys: currentSelectedKeys,
        openKeys: currentOpenKeys,
        inlineCollapsed: computed(() => props.inlineCollapsed),
        popupSubmenus,
        popupPositions,
        selectable: computed(() => props.selectable),
        handleItemClick,
        registerSubmenu,
        setSubmenuOpen,
        toggleOpen,
        positionPopup
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
                        menu.registerSubmenu(key, keyPath);
                        const open = menu.openKeys.value.includes(key);
                        const childSelected = children.some(child => menu.selectedKeys.value.includes(child?.key));
                        const submenuInfo = event => ({
                            key,
                            keyPath,
                            item: normalizedItem,
                            disabled: Boolean(normalizedItem.disabled),
                            domEvent: event
                        });
                        const focusFirstChild = async titleElement => {
                            await nextTick();
                            const submenu = titleElement.parentElement?.querySelector(':scope > .nn-menu-submenu-list');
                            submenu
                                ?.querySelector(
                                    ':scope > .nn-menu-item:not(.nn-menu-item-disabled), :scope > .nn-menu-submenu > .nn-menu-submenu-title:not(:disabled)'
                                )
                                ?.focus();
                        };
                        const focusParentTitle = titleElement => {
                            titleElement.parentElement?.parentElement?.parentElement
                                ?.querySelector(':scope > .nn-menu-submenu-title')
                                ?.focus();
                        };
                        const closeParentSubmenu = (event, titleElement) => {
                            if (keyPath.length <= 1) return false;
                            const parentKeyPath = keyPath.slice(0, -1);
                            menu.setSubmenuOpen(
                                {
                                    key: parentKeyPath.at(-1),
                                    keyPath: parentKeyPath,
                                    disabled: false,
                                    domEvent: event
                                },
                                false
                            );
                            focusParentTitle(titleElement);
                            return true;
                        };
                        const handleTitleKeydown = event => {
                            if (!menu.popupSubmenus.value || normalizedItem.disabled) return;
                            const titleElement = event.currentTarget;
                            if (event.key === 'ArrowRight') {
                                event.preventDefault();
                                event.stopPropagation();
                                menu.setSubmenuOpen(submenuInfo(event), true);
                                menu.positionPopup(key, titleElement);
                                focusFirstChild(titleElement);
                                return;
                            }
                            if (!['ArrowLeft', 'Escape'].includes(event.key)) return;
                            if (!open && !closeParentSubmenu(event, titleElement)) return;
                            event.preventDefault();
                            event.stopPropagation();
                            if (open) {
                                menu.setSubmenuOpen(submenuInfo(event), false);
                                titleElement.focus();
                            }
                        };
                        const handleSubmenuKeydown = event => {
                            if (
                                !menu.popupSubmenus.value ||
                                !['ArrowLeft', 'Escape'].includes(event.key) ||
                                event.target?.classList?.contains('nn-menu-submenu-title')
                            ) {
                                return;
                            }
                            event.preventDefault();
                            event.stopPropagation();
                            menu.setSubmenuOpen(submenuInfo(event), false);
                            event.currentTarget?.parentElement
                                ?.querySelector(':scope > .nn-menu-submenu-title')
                                ?.focus();
                        };
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
                                role: 'none',
                                onMouseenter: event => {
                                    if (!menu.popupSubmenus.value || normalizedItem.disabled) return;
                                    const titleElement = event.currentTarget?.querySelector(
                                        ':scope > .nn-menu-submenu-title'
                                    );
                                    menu.setSubmenuOpen(submenuInfo(event), true);
                                    menu.positionPopup(key, titleElement);
                                },
                                onMouseleave: event => {
                                    if (!menu.popupSubmenus.value) return;
                                    menu.setSubmenuOpen(submenuInfo(event), false);
                                }
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
                                        role: 'menuitem',
                                        'aria-haspopup': 'menu',
                                        'aria-expanded': open ? 'true' : 'false',
                                        onClick: event => {
                                            const info = {
                                                key,
                                                keyPath,
                                                item: normalizedItem,
                                                disabled: Boolean(normalizedItem.disabled),
                                                domEvent: event
                                            };
                                            if (menu.popupSubmenus.value) {
                                                menu.setSubmenuOpen(info, true);
                                                menu.positionPopup(key, event.currentTarget);
                                            } else {
                                                menu.toggleOpen(info);
                                            }
                                        },
                                        onKeydown: handleTitleKeydown
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
                                              role: 'menu',
                                              style: menu.popupSubmenus.value
                                                  ? {
                                                        top: `${menu.popupPositions.get(key)?.top ?? 0}px`,
                                                        left: `${menu.popupPositions.get(key)?.left ?? 0}px`,
                                                        minWidth: `${menu.popupPositions.get(key)?.minWidth ?? 180}px`
                                                    }
                                                  : undefined,
                                              onKeydown: handleSubmenuKeydown
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

    .nn-menu-popup-submenus :deep(.nn-menu-submenu-list) {
        position: fixed;
        z-index: 1300;
        width: max-content;
        min-width: 180px;
        max-width: min(320px, calc(100vw - 16px));
        max-height: min(480px, calc(100vh - 16px));
        margin: 0;
        padding: 4px;
        overflow: auto;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-elevated);
        box-shadow: var(--nn-shadow-floating);
    }

    .nn-menu-popup-submenus :deep(.nn-menu-submenu-open > .nn-menu-submenu-title .nn-menu-submenu-arrow) {
        transform: none;
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
