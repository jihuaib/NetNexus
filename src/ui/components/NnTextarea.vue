<template>
    <textarea
        ref="textareaRef"
        v-bind="$attrs"
        class="nn-textarea nn-input"
        :class="textareaClass"
        :value="displayValue"
        :rows="rows"
        :placeholder="placeholder"
        :disabled="disabled"
        :readonly="readonly"
        :maxlength="maxlength"
        @input="handleInput"
        @focus="emit('focus', $event)"
        @blur="emit('blur', $event)"
        @keydown="handleKeydown"
        @keyup="emit('keyup', $event)"
    />
</template>

<script setup>
    import { computed, nextTick, onMounted, ref, watch } from 'vue';

    defineOptions({
        inheritAttrs: false
    });

    const props = defineProps({
        value: {
            type: [String, Number],
            default: ''
        },
        rows: {
            type: [Number, String],
            default: 2
        },
        placeholder: {
            type: String,
            default: ''
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
        maxlength: {
            type: [Number, String],
            default: undefined
        },
        autoSize: {
            type: [Boolean, Object],
            default: false
        },
        bordered: {
            type: Boolean,
            default: true
        }
    });

    const emit = defineEmits(['update:value', 'input', 'change', 'pressEnter', 'focus', 'blur', 'keydown', 'keyup']);

    const textareaRef = ref(null);

    const displayValue = computed(() => (props.value === null || props.value === undefined ? '' : props.value));
    const textareaClass = computed(() => ({
        'nn-textarea-status-error': props.status === 'error',
        'nn-textarea-status-warning': props.status === 'warning',
        'nn-textarea-borderless': !props.bordered
    }));

    const resizeTextarea = () => {
        if (!props.autoSize || !textareaRef.value) {
            return;
        }

        const textarea = textareaRef.value;
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
    };

    const handleInput = event => {
        resizeTextarea();
        emit('update:value', event.target.value);
        emit('input', event);
        emit('change', event);
    };

    const handleKeydown = event => {
        emit('keydown', event);
        if (event.key === 'Enter') {
            emit('pressEnter', event);
        }
    };

    watch(
        () => props.value,
        () => nextTick(resizeTextarea)
    );

    onMounted(resizeTextarea);

    const focus = options => textareaRef.value?.focus(options);
    const blur = () => textareaRef.value?.blur();
    const select = () => textareaRef.value?.select();

    defineExpose({
        textarea: textareaRef,
        focus,
        blur,
        select
    });
</script>

<style scoped>
    .nn-textarea {
        display: block;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        min-height: 32px;
        padding: 4px 11px;
        border: 1px solid var(--nn-color-border);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        font-family: inherit;
        font-size: 14px;
        line-height: 1.5715;
        outline: none;
        resize: vertical;
        transition:
            border-color 0.2s,
            box-shadow 0.2s,
            background-color 0.2s;
    }

    .nn-textarea:hover:not(:disabled):not(:read-only) {
        border-color: var(--nn-color-primary);
    }

    .nn-textarea:focus {
        border-color: var(--nn-color-primary);
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-textarea::placeholder {
        color: var(--nn-color-text-placeholder);
    }

    .nn-textarea:disabled {
        background: var(--nn-color-bg-disabled);
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-textarea:read-only:not(:disabled) {
        cursor: default;
    }

    .nn-textarea-status-error,
    .nn-textarea-status-error:hover:not(:disabled) {
        border-color: var(--nn-color-error);
    }

    .nn-textarea-status-error:focus {
        border-color: var(--nn-color-error);
        box-shadow: var(--nn-focus-shadow-error);
    }

    .nn-textarea-status-warning,
    .nn-textarea-status-warning:hover:not(:disabled) {
        border-color: var(--nn-color-warning);
    }

    .nn-textarea-borderless {
        border-color: transparent;
        background: transparent;
    }
</style>
