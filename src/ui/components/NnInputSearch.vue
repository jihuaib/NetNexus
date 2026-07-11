<template>
    <NnInput
        ref="inputRef"
        v-bind="inputAttrs"
        :class="['nn-input-search', $attrs.class]"
        :style="$attrs.style"
        :value="value"
        :placeholder="placeholder"
        :allow-clear="allowClear"
        :status="status"
        :disabled="disabled"
        :readonly="readonly"
        :size="size"
        :bordered="bordered"
        @update:value="emit('update:value', $event)"
        @input="emit('input', $event)"
        @change="emit('change', $event)"
        @press-enter="handlePressEnter"
        @focus="emit('focus', $event)"
        @blur="emit('blur', $event)"
        @clear="emit('clear', $event)"
    >
        <template #suffix>
            <button
                class="nn-input-search-button"
                :class="{ 'nn-input-search-button-primary': enterButton }"
                type="button"
                aria-label="搜索"
                :disabled="disabled || loading"
                @mousedown.prevent
                @click="handleSearch"
            >
                <span v-if="loading" class="nn-input-search-spinner" aria-hidden="true" />
                <span v-else-if="typeof enterButton === 'string'" class="nn-input-search-label">
                    {{ enterButton }}
                </span>
                <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-4-4" />
                </svg>
            </button>
        </template>
    </NnInput>
</template>

<script setup>
    import { computed, ref, useAttrs } from 'vue';
    import NnInput from './NnInput.vue';

    defineOptions({
        inheritAttrs: false
    });

    const props = defineProps({
        value: {
            type: [String, Number],
            default: ''
        },
        placeholder: {
            type: String,
            default: ''
        },
        allowClear: {
            type: Boolean,
            default: false
        },
        status: {
            type: String,
            default: ''
        },
        disabled: {
            type: Boolean,
            default: false
        },
        readonly: {
            type: Boolean,
            default: false
        },
        loading: {
            type: Boolean,
            default: false
        },
        enterButton: {
            type: [Boolean, String],
            default: false
        },
        size: {
            type: String,
            default: 'middle'
        },
        bordered: {
            type: Boolean,
            default: true
        }
    });

    const emit = defineEmits(['update:value', 'input', 'change', 'pressEnter', 'focus', 'blur', 'clear', 'search']);

    const attrs = useAttrs();
    const inputRef = ref(null);

    const inputAttrs = computed(() =>
        Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== 'class' && key !== 'style'))
    );

    const handleSearch = event => {
        emit('search', props.value === null || props.value === undefined ? '' : props.value, event);
    };

    const handlePressEnter = event => {
        emit('pressEnter', event);
        handleSearch(event);
    };

    const focus = options => inputRef.value?.focus(options);
    const blur = () => inputRef.value?.blur();
    const select = () => inputRef.value?.select();

    defineExpose({
        input: inputRef,
        focus,
        blur,
        select
    });
</script>

<style scoped>
    .nn-input-search-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 20px;
        height: 22px;
        padding: 0 2px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--nn-color-text-muted);
        cursor: pointer;
        font-family: inherit;
        font-size: 13px;
    }

    .nn-input-search-button:hover:not(:disabled) {
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-primary);
    }

    .nn-input-search-button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
    }

    .nn-input-search-button svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentcolor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 2;
    }

    .nn-input-search-button-primary {
        padding-inline: 7px;
        background: var(--nn-color-primary);
        color: var(--nn-color-text-inverse);
    }

    .nn-input-search-button-primary:hover:not(:disabled) {
        background: var(--nn-color-primary-hover);
        color: var(--nn-color-text-inverse);
    }

    .nn-input-search-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid currentcolor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: nn-input-search-spin 0.8s linear infinite;
    }

    .nn-input-search-label {
        white-space: nowrap;
    }

    @keyframes nn-input-search-spin {
        to {
            transform: rotate(360deg);
        }
    }
</style>
