<template>
    <span class="nn-input-wrapper" :class="[wrapperClass, $attrs.class]" :style="$attrs.style">
        <span v-if="$slots.prefix" class="nn-input-prefix">
            <slot name="prefix" />
        </span>
        <input
            ref="inputRef"
            v-bind="inputAttrs"
            class="nn-input"
            :class="inputClass"
            :type="type"
            :value="displayValue"
            :placeholder="placeholder"
            :disabled="disabled"
            :readonly="readonly"
            :maxlength="maxlength"
            :minlength="minlength"
            @input="handleInput"
            @focus="emit('focus', $event)"
            @blur="emit('blur', $event)"
            @keydown="handleKeydown"
            @keyup="emit('keyup', $event)"
        />
        <span v-if="showActions" class="nn-input-actions">
            <button
                v-if="showClear"
                class="nn-input-clear"
                type="button"
                aria-label="清空输入"
                tabindex="-1"
                @mousedown.prevent
                @click="clearInput"
            >
                <span aria-hidden="true">×</span>
            </button>
            <span v-if="$slots.suffix" class="nn-input-suffix">
                <slot name="suffix" />
            </span>
        </span>
    </span>
</template>

<script setup>
    import { computed, ref, useAttrs, useSlots } from 'vue';

    defineOptions({
        inheritAttrs: false
    });

    const props = defineProps({
        value: {
            type: [String, Number],
            default: ''
        },
        type: {
            type: String,
            default: 'text'
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
        maxlength: {
            type: [Number, String],
            default: undefined
        },
        minlength: {
            type: [Number, String],
            default: undefined
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
        'keydown',
        'keyup',
        'clear'
    ]);

    const attrs = useAttrs();
    const slots = useSlots();
    const inputRef = ref(null);

    const inputAttrs = computed(() =>
        Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== 'class' && key !== 'style'))
    );
    const displayValue = computed(() => (props.value === null || props.value === undefined ? '' : props.value));
    const showClear = computed(
        () => props.allowClear && displayValue.value !== '' && !props.disabled && !props.readonly
    );
    const hasSuffix = computed(() => Boolean(slots.suffix));
    const showActions = computed(() => showClear.value || hasSuffix.value);

    const wrapperClass = computed(() => ({
        'nn-input-wrapper-disabled': props.disabled,
        'nn-input-wrapper-readonly': props.readonly,
        'nn-input-wrapper-borderless': !props.bordered,
        'nn-input-wrapper-small': props.size === 'small',
        'nn-input-wrapper-large': props.size === 'large',
        'nn-input-with-prefix': Boolean(slots.prefix),
        'nn-input-with-actions': showActions.value,
        'nn-input-with-clear-and-suffix': showClear.value && hasSuffix.value
    }));

    const inputClass = computed(() => ({
        'nn-input-status-error': props.status === 'error',
        'nn-input-status-warning': props.status === 'warning',
        'nn-input-borderless': !props.bordered
    }));

    const handleInput = event => {
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

    const clearInput = event => {
        if (!inputRef.value) {
            return;
        }

        inputRef.value.value = '';
        const valueEvent = {
            target: inputRef.value,
            currentTarget: inputRef.value,
            nativeEvent: event
        };
        emit('update:value', '');
        emit('input', valueEvent);
        emit('change', valueEvent);
        emit('clear', event);
        inputRef.value.focus();
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
    .nn-input-wrapper {
        position: relative;
        display: inline-flex;
        align-items: center;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        color: var(--nn-color-text);
        vertical-align: middle;
    }

    .nn-input {
        display: block;
        width: 100%;
        min-width: 0;
        height: 32px;
        padding: 4px 11px;
        border: 1px solid var(--nn-color-border);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        font-family: inherit;
        font-size: 14px;
        line-height: 1.5715;
        outline: none;
        transition:
            border-color 0.2s,
            box-shadow 0.2s,
            background-color 0.2s;
    }

    .nn-input:hover:not(:disabled):not(:read-only) {
        border-color: var(--nn-color-primary);
    }

    .nn-input:focus {
        border-color: var(--nn-color-primary);
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-input::placeholder {
        color: var(--nn-color-text-placeholder);
    }

    .nn-input:disabled {
        background: var(--nn-color-bg-disabled);
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-input:read-only:not(:disabled) {
        cursor: default;
    }

    .nn-input-status-error,
    .nn-input-status-error:hover:not(:disabled) {
        border-color: var(--nn-color-error);
    }

    .nn-input-status-error:focus {
        border-color: var(--nn-color-error);
        box-shadow: var(--nn-focus-shadow-error);
    }

    .nn-input-status-warning,
    .nn-input-status-warning:hover:not(:disabled) {
        border-color: var(--nn-color-warning);
    }

    .nn-input-borderless {
        border-color: transparent;
        background: transparent;
    }

    .nn-input-wrapper-small .nn-input {
        height: 24px;
        padding: 0 7px;
        border-radius: 4px;
        font-size: 12px;
    }

    .nn-input-wrapper-large .nn-input {
        height: 40px;
        padding: 6px 11px;
        border-radius: 8px;
        font-size: 16px;
    }

    .nn-input-with-prefix .nn-input {
        padding-inline-start: 34px;
    }

    .nn-input-with-actions .nn-input {
        padding-inline-end: 34px;
    }

    .nn-input-with-clear-and-suffix .nn-input {
        padding-inline-end: 58px;
    }

    .nn-input-prefix,
    .nn-input-actions {
        position: absolute;
        z-index: 1;
        display: inline-flex;
        align-items: center;
        color: var(--nn-color-text-muted);
    }

    .nn-input-prefix {
        left: 11px;
        pointer-events: none;
    }

    .nn-input-actions {
        right: 8px;
        gap: 4px;
    }

    .nn-input-clear,
    .nn-input-suffix {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
    }

    .nn-input-clear {
        width: 16px;
        height: 16px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: var(--nn-color-text-placeholder);
        color: var(--nn-color-bg-surface);
        cursor: pointer;
        font-family: inherit;
        font-size: 14px;
        line-height: 14px;
        opacity: 0.72;
    }

    .nn-input-clear:hover {
        opacity: 1;
    }

    .nn-input-wrapper-disabled .nn-input-actions {
        pointer-events: none;
        opacity: 0.55;
    }
</style>
