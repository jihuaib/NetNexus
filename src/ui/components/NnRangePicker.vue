<template>
    <span class="nn-range-picker" :class="pickerClass">
        <input
            class="nn-range-picker-input"
            :type="inputType"
            :value="startDraft"
            :step="inputStep"
            :max="endDraft || undefined"
            :disabled="disabled"
            :aria-label="normalizedPlaceholder[0]"
            @input="handleInput('start', $event)"
            @change="commitDraft"
        />
        <span class="nn-range-picker-separator" aria-hidden="true">→</span>
        <input
            class="nn-range-picker-input"
            :type="inputType"
            :value="endDraft"
            :step="inputStep"
            :min="startDraft || undefined"
            :disabled="disabled"
            :aria-label="normalizedPlaceholder[1]"
            @input="handleInput('end', $event)"
            @change="commitDraft"
        />
        <button
            v-if="allowClear && hasDraftValue && !disabled"
            type="button"
            class="nn-range-picker-clear"
            aria-label="清除日期范围"
            @click="clearValue"
        >
            ×
        </button>
        <span v-else class="nn-range-picker-calendar" aria-hidden="true" />
    </span>
</template>

<script setup>
    import { computed, ref, watch } from 'vue';

    defineOptions({ name: 'NnRangePicker' });

    const props = defineProps({
        value: {
            type: Array,
            default: null
        },
        showTime: {
            type: [Boolean, Object],
            default: false
        },
        format: {
            type: String,
            default: ''
        },
        placeholder: {
            type: Array,
            default: () => ['开始日期', '结束日期']
        },
        allowClear: {
            type: Boolean,
            default: true
        },
        disabled: {
            type: Boolean,
            default: false
        },
        status: {
            type: String,
            default: ''
        }
    });

    const emit = defineEmits(['update:value', 'change']);
    const startDraft = ref('');
    const endDraft = ref('');

    const inputType = computed(() => (props.showTime ? 'datetime-local' : 'date'));
    const inputStep = computed(() => (props.showTime ? 1 : undefined));
    const hasDraftValue = computed(() => Boolean(startDraft.value || endDraft.value));
    const normalizedPlaceholder = computed(() => [
        props.placeholder?.[0] || '开始日期',
        props.placeholder?.[1] || '结束日期'
    ]);
    const pickerClass = computed(() => ({
        'nn-range-picker-disabled': props.disabled,
        'nn-range-picker-status-error': props.status === 'error'
    }));

    const padNumber = value => String(value).padStart(2, '0');

    const toDate = value => {
        if (!value) {
            return null;
        }

        if (value instanceof Date) {
            return Number.isNaN(value.getTime()) ? null : value;
        }

        if (typeof value.toDate === 'function') {
            const date = value.toDate();
            return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
        }

        if (typeof value.toISOString === 'function') {
            const date = new Date(value.toISOString());
            return Number.isNaN(date.getTime()) ? null : date;
        }

        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    };

    const toInputValue = value => {
        const date = toDate(value);
        if (!date) {
            return '';
        }

        const datePart = `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
        if (!props.showTime) {
            return datePart;
        }

        return `${datePart}T${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`;
    };

    const parseInputValue = value => {
        if (!value) {
            return null;
        }

        const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
        if (!match) {
            return null;
        }

        const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
        const date = new Date(
            Number(year),
            Number(month) - 1,
            Number(day),
            Number(hour),
            Number(minute),
            Number(second)
        );

        return Number.isNaN(date.getTime()) ? null : date;
    };

    const getFormatPattern = () => props.format || (props.showTime ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD');

    const formatDate = date => {
        if (!date) {
            return '';
        }

        const replacements = {
            YYYY: String(date.getFullYear()),
            MM: padNumber(date.getMonth() + 1),
            DD: padNumber(date.getDate()),
            HH: padNumber(date.getHours()),
            mm: padNumber(date.getMinutes()),
            ss: padNumber(date.getSeconds())
        };

        return getFormatPattern().replace(/YYYY|MM|DD|HH|mm|ss/g, token => replacements[token]);
    };

    const syncFromValue = value => {
        startDraft.value = toInputValue(value?.[0]);
        endDraft.value = toInputValue(value?.[1]);
    };

    const emitValue = nextValue => {
        emit('update:value', nextValue);
        emit('change', nextValue, nextValue ? nextValue.map(date => formatDate(date)) : ['', '']);
    };

    const commitDraft = () => {
        if (!startDraft.value || !endDraft.value) {
            return;
        }

        const start = parseInputValue(startDraft.value);
        const end = parseInputValue(endDraft.value);
        if (!start || !end) {
            return;
        }

        emitValue([start, end]);
    };

    const handleInput = (target, event) => {
        if (target === 'start') {
            startDraft.value = event.target.value;
        } else {
            endDraft.value = event.target.value;
        }

        if (!event.target.value) {
            emitValue(null);
            return;
        }
    };

    const clearValue = () => {
        startDraft.value = '';
        endDraft.value = '';
        emitValue(null);
    };

    watch(
        () => [props.value, props.showTime],
        () => syncFromValue(props.value),
        { immediate: true, deep: true }
    );
</script>

<style scoped>
    .nn-range-picker {
        display: inline-flex;
        align-items: center;
        width: 100%;
        max-width: 100%;
        min-height: 32px;
        padding: 0 10px;
        border: 1px solid var(--nn-color-border);
        border-radius: 6px;
        background: var(--nn-color-bg-surface);
        color: var(--nn-color-text);
        vertical-align: middle;
        transition:
            border-color 0.2s,
            box-shadow 0.2s,
            background-color 0.2s;
    }

    .nn-range-picker:hover:not(.nn-range-picker-disabled) {
        border-color: var(--nn-color-primary);
    }

    .nn-range-picker:focus-within:not(.nn-range-picker-disabled) {
        border-color: var(--nn-color-primary);
        box-shadow: var(--nn-focus-shadow-primary);
    }

    .nn-range-picker-status-error {
        border-color: var(--nn-color-error);
    }

    .nn-range-picker-status-error:focus-within {
        box-shadow: var(--nn-focus-shadow-error);
    }

    .nn-range-picker-disabled {
        background: var(--nn-color-bg-disabled);
        color: var(--nn-color-text-disabled);
        cursor: not-allowed;
    }

    .nn-range-picker-input {
        flex: 1 1 0;
        width: 0;
        min-width: 116px;
        height: 30px;
        padding: 0;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 14px;
        line-height: 30px;
        outline: none;
        color-scheme: inherit;
    }

    .nn-range-picker-input:disabled {
        cursor: not-allowed;
    }

    .nn-range-picker-separator {
        flex: none;
        margin: 0 8px;
        color: var(--nn-color-text-muted);
        font-size: 12px;
    }

    .nn-range-picker-clear {
        flex: none;
        width: 18px;
        height: 18px;
        margin-left: 4px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: var(--nn-color-text-muted);
        color: var(--nn-color-bg-surface);
        cursor: pointer;
        font: inherit;
        font-size: 14px;
        line-height: 17px;
    }

    .nn-range-picker-clear:hover {
        background: var(--nn-color-text-secondary);
    }

    .nn-range-picker-calendar {
        flex: none;
        width: 14px;
        height: 14px;
        margin-left: 6px;
        border: 1px solid currentColor;
        border-radius: 2px;
        color: var(--nn-color-text-muted);
    }

    @media (max-width: 640px) {
        .nn-range-picker {
            flex-wrap: wrap;
            gap: 2px 6px;
            padding-block: 4px;
        }

        .nn-range-picker-separator {
            margin: 0 2px;
        }
    }
</style>
