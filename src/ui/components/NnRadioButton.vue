<template>
    <button
        type="button"
        class="nn-radio-button"
        :class="buttonClass"
        :disabled="isDisabled"
        role="radio"
        :aria-checked="checked ? 'true' : 'false'"
        @click="handleClick"
    >
        <slot />
    </button>
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
        }
    });

    const group = inject('nnRadioGroupContext', null);

    const checked = computed(() => (group ? group.value.value === props.value : false));
    const isDisabled = computed(() => props.disabled || Boolean(group?.disabled.value));
    const isSmall = computed(() => group?.size.value === 'small');

    const buttonClass = computed(() => ({
        'nn-radio-button-checked': checked.value,
        'nn-radio-button-disabled': isDisabled.value,
        'nn-radio-button-small': isSmall.value
    }));

    const handleClick = () => {
        if (!isDisabled.value && group) {
            group.setValue(props.value);
        }
    };
</script>

<style scoped>
    .nn-radio-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 32px;
        height: 32px;
        padding: 0 12px;
        border: 1px solid var(--nn-color-border);
        border-radius: 4px;
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        cursor: pointer;
        font-family: inherit;
        font-size: 14px;
        line-height: 30px;
        outline: none;
        transition:
            color 0.2s,
            background-color 0.2s,
            border-color 0.2s,
            box-shadow 0.2s;
        white-space: nowrap;
    }

    .nn-radio-button + .nn-radio-button {
        margin-inline-start: -1px;
    }

    .nn-radio-button:hover:not(.nn-radio-button-disabled) {
        color: var(--nn-color-primary);
        border-color: var(--nn-color-primary);
        z-index: 1;
    }

    .nn-radio-button:focus-visible {
        box-shadow: var(--nn-focus-shadow-primary);
        z-index: 1;
    }

    .nn-radio-button-checked {
        z-index: 1;
        border-color: var(--nn-color-primary);
        background: var(--nn-color-primary);
        color: var(--nn-color-text-inverse);
    }

    .nn-radio-button-checked:hover:not(.nn-radio-button-disabled) {
        border-color: var(--nn-color-primary-hover);
        background: var(--nn-color-primary-hover);
        color: var(--nn-color-text-inverse);
    }

    .nn-radio-button-disabled {
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
        background: var(--nn-color-bg-disabled);
    }

    .nn-radio-button-small {
        height: 24px;
        padding: 0 8px;
        font-size: 12px;
        line-height: 22px;
    }
</style>
