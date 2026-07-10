<template>
    <button
        type="button"
        class="nn-switch"
        :class="switchClass"
        :disabled="disabled"
        role="switch"
        :aria-checked="isChecked ? 'true' : 'false'"
        @click="toggle"
    >
        <span class="nn-switch-handle" />
    </button>
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
        size: {
            type: String,
            default: 'default'
        }
    });

    const emit = defineEmits(['update:checked', 'change']);

    const isChecked = computed(() => Boolean(props.checked));

    const switchClass = computed(() => ({
        'nn-switch-checked': isChecked.value,
        'nn-switch-disabled': props.disabled,
        'nn-switch-small': props.size === 'small'
    }));

    const toggle = event => {
        if (props.disabled) {
            return;
        }

        const nextChecked = !isChecked.value;
        emit('update:checked', nextChecked);
        emit('change', nextChecked, event);
    };
</script>

<style scoped>
    .nn-switch {
        position: relative;
        display: inline-flex;
        align-items: center;
        width: 44px;
        min-width: 44px;
        height: 22px;
        padding: 0;
        border: 0;
        border-radius: 999px;
        background: var(--nn-color-text-placeholder);
        cursor: pointer;
        outline: none;
        vertical-align: middle;
        transition:
            background-color 0.2s,
            opacity 0.2s,
            box-shadow 0.2s;
    }

    .nn-switch:focus-visible {
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-switch-checked {
        background: var(--nn-color-primary);
    }

    .nn-switch-disabled {
        cursor: not-allowed;
        opacity: 0.55;
    }

    .nn-switch-handle {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #ffffff;
        box-shadow: 0 2px 4px rgba(15, 23, 42, 0.2);
        transition: transform 0.2s;
    }

    .nn-switch-checked .nn-switch-handle {
        transform: translateX(22px);
    }

    .nn-switch-small {
        width: 32px;
        min-width: 32px;
        height: 18px;
    }

    .nn-switch-small .nn-switch-handle {
        width: 14px;
        height: 14px;
    }

    .nn-switch-small.nn-switch-checked .nn-switch-handle {
        transform: translateX(14px);
    }
</style>
