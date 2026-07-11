<template>
    <NnInput
        ref="inputRef"
        v-bind="$attrs"
        :value="value"
        :type="visible ? 'text' : 'password'"
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
        @press-enter="emit('pressEnter', $event)"
        @focus="emit('focus', $event)"
        @blur="emit('blur', $event)"
        @clear="emit('clear', $event)"
    >
        <template v-if="visibilityToggle" #suffix>
            <button
                class="nn-input-password-toggle"
                type="button"
                :aria-label="visible ? '隐藏密码' : '显示密码'"
                :aria-pressed="visible"
                :disabled="disabled"
                @mousedown.prevent
                @click="toggleVisibility"
            >
                <svg v-if="visible" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
                    <circle cx="12" cy="12" r="2.5" />
                </svg>
                <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 3l18 18" />
                    <path d="M10.6 6.2A11.7 11.7 0 0 1 12 6c6.5 0 10 6 10 6a18 18 0 0 1-2.1 2.8" />
                    <path d="M6.2 6.2C3.5 8 2 12 2 12s3.5 6 10 6a10.8 10.8 0 0 0 3.8-.7" />
                </svg>
            </button>
        </template>
    </NnInput>
</template>

<script setup>
    import { ref } from 'vue';
    import NnInput from './NnInput.vue';

    defineOptions({
        inheritAttrs: false
    });

    defineProps({
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
        visibilityToggle: {
            type: Boolean,
            default: true
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

    const emit = defineEmits([
        'update:value',
        'input',
        'change',
        'pressEnter',
        'focus',
        'blur',
        'clear',
        'visibleChange'
    ]);

    const inputRef = ref(null);
    const visible = ref(false);

    const toggleVisibility = () => {
        visible.value = !visible.value;
        emit('visibleChange', visible.value);
        inputRef.value?.focus();
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
    .nn-input-password-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--nn-color-text-muted);
        cursor: pointer;
    }

    .nn-input-password-toggle:hover:not(:disabled) {
        color: var(--nn-color-text);
    }

    .nn-input-password-toggle:disabled {
        cursor: not-allowed;
        opacity: 0.55;
    }

    .nn-input-password-toggle svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentcolor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 2;
    }
</style>
