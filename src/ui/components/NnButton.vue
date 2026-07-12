<template>
    <button
        class="nn-button"
        :class="buttonClasses"
        :type="htmlType"
        :disabled="isDisabled"
        :aria-busy="loading ? 'true' : undefined"
        @click="handleClick"
    >
        <span v-if="loading" class="nn-button-spinner" aria-hidden="true" />
        <span v-else-if="$slots.icon" class="nn-button-icon">
            <slot name="icon" />
        </span>
        <span v-if="$slots.default" class="nn-button-content">
            <slot />
        </span>
    </button>
</template>

<script setup>
    import { computed, useSlots } from 'vue';

    const props = defineProps({
        type: {
            type: String,
            default: 'default'
        },
        htmlType: {
            type: String,
            default: 'button'
        },
        size: {
            type: String,
            default: 'middle'
        },
        danger: {
            type: Boolean,
            default: false
        },
        loading: {
            type: Boolean,
            default: false
        },
        disabled: {
            type: Boolean,
            default: false
        }
    });

    const emit = defineEmits(['click']);
    const slots = useSlots();

    const supportedTypes = new Set(['default', 'primary', 'link', 'text', 'dashed']);

    const visualType = computed(() => (supportedTypes.has(props.type) ? props.type : 'default'));
    const isDanger = computed(() => props.danger || props.type === 'danger');
    const isDisabled = computed(() => props.disabled || props.loading);

    const buttonClasses = computed(() => ({
        [`nn-button-${visualType.value}`]: true,
        'nn-button-small': props.size === 'small',
        'nn-button-danger': isDanger.value,
        'nn-button-loading': props.loading,
        'nn-button-disabled': isDisabled.value,
        'nn-button-icon-only': Boolean(slots.icon) && !slots.default
    }));

    const handleClick = event => {
        if (isDisabled.value) {
            event.preventDefault();
            return;
        }

        emit('click', event);
    };
</script>

<style scoped>
    .nn-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        max-width: 100%;
        min-width: 32px;
        height: 32px;
        padding: 4px 15px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        box-shadow: none;
        color: var(--nn-color-text);
        cursor: pointer;
        font-family: inherit;
        font-size: 14px;
        line-height: 1.4;
        outline: none;
        text-align: center;
        vertical-align: middle;
        white-space: nowrap;
        transition:
            color 0.2s,
            background-color 0.2s,
            border-color 0.2s,
            box-shadow 0.2s,
            opacity 0.2s;
        user-select: none;
    }

    .nn-button:hover:not(.nn-button-disabled) {
        color: var(--nn-color-primary);
        border-color: var(--nn-color-primary);
    }

    .nn-button:focus-visible {
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-button-disabled {
        cursor: not-allowed;
    }

    .nn-button-small {
        min-width: 24px;
        height: 24px;
        padding: 0 7px;
        border-radius: 4px;
        font-size: 12px;
    }

    .nn-button-icon-only {
        width: 32px;
        padding-inline: 0;
    }

    .nn-button-icon-only.nn-button-small {
        width: 24px;
    }

    .nn-button-default {
        border-color: var(--nn-color-border);
        background: var(--nn-color-bg-surface);
    }

    .nn-button-primary {
        border-color: var(--nn-color-primary);
        background: var(--nn-color-primary);
        color: var(--nn-color-text-inverse);
    }

    .nn-button-primary:hover:not(.nn-button-disabled) {
        border-color: var(--nn-color-primary-hover);
        background: var(--nn-color-primary-hover);
        color: var(--nn-color-text-inverse);
    }

    .nn-button-dashed {
        border-color: var(--nn-color-border);
        border-style: dashed;
        background: var(--nn-color-bg-surface);
    }

    .nn-button-link,
    .nn-button-text {
        min-width: 0;
        padding-inline: 4px;
        border-color: transparent;
        background: transparent;
        color: var(--nn-color-link);
    }

    .nn-button-text {
        color: var(--nn-color-text);
    }

    .nn-button-link:hover:not(.nn-button-disabled),
    .nn-button-text:hover:not(.nn-button-disabled) {
        border-color: transparent;
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-primary-hover);
    }

    .nn-button-default.nn-button-danger,
    .nn-button-dashed.nn-button-danger {
        border-color: var(--nn-color-border-danger);
        color: var(--nn-color-error);
    }

    .nn-button-default.nn-button-danger:hover:not(.nn-button-disabled),
    .nn-button-dashed.nn-button-danger:hover:not(.nn-button-disabled) {
        border-color: var(--nn-color-error);
        color: var(--nn-color-error);
    }

    .nn-button-primary.nn-button-danger,
    .nn-button-default.nn-button-danger.nn-button-loading,
    .nn-button-dashed.nn-button-danger.nn-button-loading {
        border-color: var(--nn-color-error);
        background: var(--nn-color-error);
        color: var(--nn-color-text-inverse);
    }

    .nn-button-primary.nn-button-danger:hover:not(.nn-button-disabled) {
        border-color: var(--nn-color-error);
        background: var(--nn-color-error);
        color: var(--nn-color-text-inverse);
        filter: brightness(1.04);
    }

    .nn-button-link.nn-button-danger,
    .nn-button-text.nn-button-danger {
        color: var(--nn-color-error);
    }

    .nn-button-default.nn-button-disabled,
    .nn-button-dashed.nn-button-disabled,
    .nn-button-primary.nn-button-disabled {
        border-color: var(--nn-color-border);
        background: var(--nn-color-bg-disabled);
        color: var(--nn-color-text-disabled);
        filter: none;
        opacity: 1;
    }

    .nn-button-link.nn-button-disabled,
    .nn-button-text.nn-button-disabled {
        border-color: transparent;
        background: transparent;
        color: var(--nn-color-text-disabled);
        filter: none;
        opacity: 1;
    }

    .nn-button-icon,
    .nn-button-spinner {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
    }

    .nn-button-icon + .nn-button-content,
    .nn-button-spinner + .nn-button-content {
        margin-left: 6px;
    }

    .nn-button-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid currentcolor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: nn-button-spin 0.8s linear infinite;
        opacity: 0.86;
    }

    @keyframes nn-button-spin {
        to {
            transform: rotate(360deg);
        }
    }
</style>
