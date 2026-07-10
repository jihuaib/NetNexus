<template>
    <span class="nn-input-number" :class="inputNumberClass">
        <input
            class="nn-input-number-input"
            type="number"
            :value="displayValue"
            :min="min"
            :max="max"
            :step="step"
            :disabled="disabled"
            :placeholder="placeholder"
            @input="handleInput"
            @blur="handleBlur"
            @keydown.enter="emit('pressEnter', $event)"
        />
        <span v-if="addonAfter" class="nn-input-number-addon">{{ addonAfter }}</span>
    </span>
</template>

<script setup>
    import { computed } from 'vue';

    const props = defineProps({
        value: {
            type: [Number, String],
            default: null
        },
        min: {
            type: [Number, String],
            default: undefined
        },
        max: {
            type: [Number, String],
            default: undefined
        },
        step: {
            type: [Number, String],
            default: 1
        },
        precision: {
            type: [Number, String],
            default: undefined
        },
        status: {
            type: String,
            default: ''
        },
        disabled: {
            type: Boolean,
            default: false
        },
        placeholder: {
            type: String,
            default: ''
        },
        addonAfter: {
            type: [String, Number],
            default: ''
        }
    });

    const emit = defineEmits(['update:value', 'change', 'pressEnter']);

    const displayValue = computed(() => (props.value === null || props.value === undefined ? '' : props.value));

    const inputNumberClass = computed(() => ({
        'nn-input-number-disabled': props.disabled,
        'nn-input-number-status-error': props.status === 'error',
        'nn-input-number-with-addon': Boolean(props.addonAfter)
    }));

    const toFiniteNumber = value => {
        if (value === '' || value === null || value === undefined) {
            return null;
        }

        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) {
            return null;
        }

        const precision = Number(props.precision);
        if (Number.isInteger(precision) && precision >= 0) {
            return Number(numberValue.toFixed(precision));
        }

        return numberValue;
    };

    const handleInput = event => {
        const nextValue = toFiniteNumber(event.target.value);
        emit('update:value', nextValue);
        emit('change', nextValue);
    };

    const handleBlur = event => {
        const nextValue = toFiniteNumber(event.target.value);
        if (nextValue !== props.value) {
            emit('update:value', nextValue);
            emit('change', nextValue);
        }
    };
</script>

<style scoped>
    .nn-input-number {
        display: inline-flex;
        align-items: stretch;
        max-width: 100%;
        min-width: 0;
        color: var(--nn-color-text);
        vertical-align: middle;
    }

    .nn-input-number-input {
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

    .nn-input-number-input:hover:not(:disabled) {
        border-color: var(--nn-color-primary);
    }

    .nn-input-number-input:focus {
        border-color: var(--nn-color-primary);
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-input-number-input::placeholder {
        color: var(--nn-color-text-placeholder);
    }

    .nn-input-number-input:disabled {
        background: var(--nn-color-bg-disabled);
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-input-number-status-error .nn-input-number-input {
        border-color: var(--nn-color-error);
    }

    .nn-input-number-status-error .nn-input-number-input:focus {
        border-color: var(--nn-color-error);
        box-shadow: var(--nn-focus-shadow-error);
    }

    .nn-input-number-with-addon .nn-input-number-input {
        border-start-end-radius: 0;
        border-end-end-radius: 0;
    }

    .nn-input-number-addon {
        display: inline-flex;
        flex: none;
        align-items: center;
        min-width: 36px;
        height: 32px;
        padding: 0 11px;
        border: 1px solid var(--nn-color-border);
        border-left: 0;
        border-radius: 0 6px 6px 0;
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text-secondary);
        font-size: 14px;
        line-height: 30px;
        white-space: nowrap;
    }
</style>
