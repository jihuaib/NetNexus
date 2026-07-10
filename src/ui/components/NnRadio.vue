<template>
    <label class="nn-radio-wrapper" :class="wrapperClass">
        <input
            class="nn-radio-input"
            type="radio"
            :checked="checked"
            :disabled="isDisabled"
            :value="value"
            @change="handleChange"
        />
        <span class="nn-radio" aria-hidden="true">
            <span class="nn-radio-inner" />
        </span>
        <span class="nn-radio-label">
            <slot />
        </span>
    </label>
</template>

<script setup>
    import { computed, inject } from 'vue';

    const props = defineProps({
        value: {
            type: [String, Number, Boolean],
            default: ''
        },
        disabled: {
            type: Boolean,
            default: false
        },
        checked: {
            type: Boolean,
            default: false
        }
    });

    const emit = defineEmits(['update:checked', 'change']);

    const group = inject('nnRadioGroupContext', null);

    const checked = computed(() => (group ? group.value.value === props.value : props.checked));
    const isDisabled = computed(() => props.disabled || Boolean(group?.disabled.value));

    const wrapperClass = computed(() => ({
        'nn-radio-wrapper-checked': checked.value,
        'nn-radio-wrapper-disabled': isDisabled.value
    }));

    const handleChange = event => {
        if (isDisabled.value) {
            return;
        }

        if (group) {
            group.setValue(props.value);
        } else {
            emit('update:checked', event.target.checked);
            emit('change', { target: { checked: event.target.checked, value: props.value } });
        }
    };
</script>

<style scoped>
    .nn-radio-wrapper {
        position: relative;
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        color: var(--nn-color-text);
        cursor: pointer;
        font-size: 14px;
        line-height: 1.5715;
        vertical-align: middle;
        white-space: nowrap;
    }

    .nn-radio-input {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        opacity: 0;
    }

    .nn-radio {
        position: relative;
        display: inline-flex;
        flex: none;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        margin-inline-end: 8px;
    }

    .nn-radio-inner {
        position: relative;
        display: block;
        width: 16px;
        height: 16px;
        border: 1px solid var(--nn-color-border);
        border-radius: 50%;
        background: var(--nn-color-bg-surface);
        transition:
            background-color 0.2s,
            border-color 0.2s,
            box-shadow 0.2s;
    }

    .nn-radio-input:focus-visible + .nn-radio .nn-radio-inner {
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-radio-wrapper:hover:not(.nn-radio-wrapper-disabled) .nn-radio-inner {
        border-color: var(--nn-color-primary);
    }

    .nn-radio-wrapper-checked .nn-radio-inner {
        border-color: var(--nn-color-primary);
    }

    .nn-radio-wrapper-checked .nn-radio-inner::after {
        position: absolute;
        top: 3px;
        left: 3px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--nn-color-primary);
        content: '';
    }

    .nn-radio-wrapper-disabled {
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-radio-wrapper-disabled .nn-radio-inner {
        border-color: var(--nn-color-border);
        background: var(--nn-color-bg-disabled);
    }

    .nn-radio-label {
        min-width: 0;
        overflow-wrap: anywhere;
    }
</style>
