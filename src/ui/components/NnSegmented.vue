<template>
    <div class="nn-segmented" role="tablist">
        <button
            v-for="option in normalizedOptions"
            :key="String(option.value)"
            type="button"
            class="nn-segmented-item"
            :class="{ 'nn-segmented-item-active': option.value === value }"
            :disabled="option.disabled"
            role="tab"
            :aria-selected="option.value === value ? 'true' : 'false'"
            @click="selectOption(option)"
        >
            {{ option.label }}
        </button>
    </div>
</template>

<script setup>
    import { computed } from 'vue';

    const props = defineProps({
        value: {
            type: [String, Number, Boolean],
            default: ''
        },
        options: {
            type: Array,
            default: () => []
        }
    });

    const emit = defineEmits(['update:value', 'change']);

    const normalizedOptions = computed(() =>
        props.options.map(option => {
            if (option && typeof option === 'object') {
                return {
                    label: option.label,
                    value: option.value,
                    disabled: Boolean(option.disabled)
                };
            }

            return {
                label: option,
                value: option,
                disabled: false
            };
        })
    );

    const selectOption = option => {
        if (option.disabled || option.value === props.value) {
            return;
        }

        emit('update:value', option.value);
        emit('change', option.value);
    };
</script>

<style scoped>
    .nn-segmented {
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        padding: 2px;
        border-radius: 6px;
        background: var(--nn-color-bg-muted);
        vertical-align: middle;
    }

    .nn-segmented-item {
        min-width: 44px;
        height: 28px;
        padding: 0 10px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--nn-color-text-secondary);
        cursor: pointer;
        font-family: inherit;
        font-size: 13px;
        line-height: 28px;
        outline: none;
        transition:
            background-color 0.2s,
            color 0.2s,
            box-shadow 0.2s;
        white-space: nowrap;
    }

    .nn-segmented-item:hover:not(:disabled) {
        color: var(--nn-color-primary);
    }

    .nn-segmented-item:focus-visible {
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-segmented-item-active {
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-primary);
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12);
    }

    .nn-segmented-item:disabled {
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }
</style>
