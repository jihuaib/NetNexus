<template>
    <label class="nn-checkbox-wrapper" :class="wrapperClass">
        <input
            class="nn-checkbox-input"
            type="checkbox"
            :checked="checked"
            :disabled="disabled"
            :value="value"
            @change="handleChange"
        />
        <span class="nn-checkbox" aria-hidden="true">
            <span class="nn-checkbox-inner" />
        </span>
        <span v-if="$slots.default" class="nn-checkbox-label">
            <slot />
        </span>
    </label>
</template>

<script setup>
    import { computed } from 'vue';

    const props = defineProps({
        checked: {
            type: Boolean,
            default: false
        },
        disabled: {
            type: Boolean,
            default: false
        },
        value: {
            type: [String, Number, Boolean],
            default: true
        }
    });

    const emit = defineEmits(['update:checked', 'change']);

    const wrapperClass = computed(() => ({
        'nn-checkbox-wrapper-checked': props.checked,
        'nn-checkbox-wrapper-disabled': props.disabled
    }));

    const handleChange = event => {
        const nextChecked = event.target.checked;
        emit('update:checked', nextChecked);
        emit('change', {
            target: {
                checked: nextChecked,
                value: props.value
            },
            nativeEvent: event
        });
    };
</script>

<style scoped>
    .nn-checkbox-wrapper {
        position: relative;
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        color: var(--nn-color-text);
        cursor: pointer;
        font-size: 14px;
        line-height: 1.5715;
        vertical-align: middle;
    }

    .nn-checkbox-wrapper + .nn-checkbox-wrapper {
        margin-inline-start: 8px;
    }

    .nn-checkbox-input {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        opacity: 0;
    }

    .nn-checkbox {
        position: relative;
        display: inline-flex;
        flex: none;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        margin-inline-end: 8px;
    }

    .nn-checkbox-inner {
        position: relative;
        display: block;
        width: 16px;
        height: 16px;
        border: 1px solid var(--nn-color-border);
        border-radius: 3px;
        background: var(--nn-color-bg-surface);
        transition:
            background-color 0.2s,
            border-color 0.2s,
            box-shadow 0.2s;
    }

    .nn-checkbox-input:focus-visible + .nn-checkbox .nn-checkbox-inner {
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-checkbox-wrapper:hover:not(.nn-checkbox-wrapper-disabled) .nn-checkbox-inner {
        border-color: var(--nn-color-primary);
    }

    .nn-checkbox-wrapper-checked .nn-checkbox-inner {
        border-color: var(--nn-color-primary);
        background: var(--nn-color-primary);
    }

    .nn-checkbox-wrapper-checked .nn-checkbox-inner::after {
        position: absolute;
        top: 1px;
        left: 5px;
        width: 4px;
        height: 8px;
        border: solid #ffffff;
        border-width: 0 2px 2px 0;
        content: '';
        transform: rotate(45deg);
    }

    .nn-checkbox-wrapper-disabled {
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-checkbox-wrapper-disabled .nn-checkbox-inner {
        border-color: var(--nn-color-border);
        background: var(--nn-color-bg-disabled);
    }

    .nn-checkbox-wrapper-disabled.nn-checkbox-wrapper-checked .nn-checkbox-inner::after {
        border-color: var(--nn-color-text-muted);
    }

    .nn-checkbox-label {
        min-width: 0;
        overflow-wrap: anywhere;
    }
</style>
