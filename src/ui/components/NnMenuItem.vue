<template>
    <li
        v-bind="forwardedAttrs"
        class="nn-menu-item"
        :class="[itemClass, attrs.class]"
        :style="attrs.style"
        role="menuitem"
        :tabindex="disabled ? -1 : 0"
        :aria-disabled="disabled ? 'true' : undefined"
        :aria-current="selected ? 'page' : undefined"
        :title="collapsedTitle"
        @click="handleClick"
        @keydown.enter.prevent="handleClick"
        @keydown.space.prevent="handleClick"
    >
        <span v-if="$slots.icon" class="nn-menu-item-icon" aria-hidden="true">
            <slot name="icon" />
        </span>
        <span class="nn-menu-item-content">
            <slot />
        </span>
    </li>
</template>

<script setup>
    import { computed, getCurrentInstance, inject, useAttrs } from 'vue';

    defineOptions({
        name: 'NnMenuItem',
        inheritAttrs: false
    });

    const props = defineProps({
        itemKey: {
            type: [String, Number, Boolean],
            default: undefined
        },
        value: {
            type: [String, Number, Boolean],
            default: undefined
        },
        keyPath: {
            type: Array,
            default: () => []
        },
        item: {
            type: Object,
            default: null
        },
        route: {
            type: [String, Object],
            default: undefined
        },
        title: {
            type: [String, Number],
            default: ''
        },
        disabled: {
            type: Boolean,
            default: false
        }
    });

    const emit = defineEmits(['click']);
    const attrs = useAttrs();
    const instance = getCurrentInstance();
    const menu = inject('nnMenuContext', null);

    const resolvedKey = computed(() => props.itemKey ?? props.value ?? instance?.vnode.key);
    const resolvedKeyPath = computed(() => (props.keyPath.length > 0 ? props.keyPath : [resolvedKey.value]));
    const selected = computed(() => Boolean(menu?.selectedKeys.value.includes(resolvedKey.value)));
    const collapsedTitle = computed(() => {
        if (!menu?.inlineCollapsed.value) {
            return props.title || undefined;
        }
        return props.title || String(props.item?.label || '') || undefined;
    });
    const itemClass = computed(() => ({
        'nn-menu-item-selected': selected.value,
        'nn-menu-item-disabled': props.disabled
    }));

    const forwardedAttrs = computed(() => {
        const { class: _class, style: _style, ...rest } = attrs;
        return rest;
    });

    const handleClick = event => {
        if (props.disabled || resolvedKey.value === undefined || resolvedKey.value === null) {
            event?.preventDefault?.();
            return;
        }
        const item = props.item || {
            key: resolvedKey.value,
            route: props.route
        };
        const info = {
            key: resolvedKey.value,
            keyPath: resolvedKeyPath.value,
            item,
            domEvent: event
        };
        emit('click', info);
        menu?.handleItemClick(info);
    };
</script>

<style scoped>
    .nn-menu-item {
        position: relative;
        display: flex;
        min-width: 0;
        min-height: 36px;
        align-items: center;
        gap: 10px;
        margin: 2px 4px;
        padding: 6px 12px;
        border-radius: 6px;
        color: var(--nn-color-text);
        cursor: pointer;
        line-height: 24px;
        list-style: none;
        outline: none;
        transition:
            color 0.2s,
            background-color 0.2s,
            box-shadow 0.2s;
        user-select: none;
    }

    .nn-menu-item:hover:not(.nn-menu-item-disabled) {
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-primary);
    }

    .nn-menu-item:focus-visible {
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-menu-item-selected {
        background: var(--nn-color-bg-selected);
        color: var(--nn-color-primary);
        font-weight: 500;
    }

    .nn-menu-item-disabled {
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-menu-item-icon {
        display: inline-flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        font-size: 16px;
    }

    .nn-menu-item-content {
        min-width: 0;
        overflow: hidden;
        flex: 1 1 auto;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    @media (prefers-reduced-motion: reduce) {
        .nn-menu-item {
            transition: none;
        }
    }
</style>
