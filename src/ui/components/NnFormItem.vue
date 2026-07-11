<template>
    <div class="nn-form-item" :class="itemClass">
        <div class="nn-form-item-row">
            <div v-if="hasLabel" class="nn-form-item-label" :class="labelColumnClass" :style="labelColumnStyle">
                <label :for="htmlFor" :class="labelClass">
                    <slot name="label">{{ label }}</slot>
                    <span v-if="showColon" class="nn-form-item-colon" aria-hidden="true">:</span>
                </label>
            </div>
            <div class="nn-form-item-control" :class="controlColumnClass" :style="controlColumnStyle">
                <div class="nn-form-item-control-input">
                    <div class="nn-form-item-control-input-content">
                        <slot />
                    </div>
                </div>
                <div v-if="hasHelp" class="nn-form-item-explain" :class="explainClass" role="alert">
                    <slot name="help">{{ help }}</slot>
                </div>
                <div v-if="hasExtra" class="nn-form-item-extra">
                    <slot name="extra">{{ extra }}</slot>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
    import { computed, inject, useSlots } from 'vue';

    const props = defineProps({
        label: {
            type: [String, Number],
            default: ''
        },
        name: {
            type: [String, Number, Array],
            default: undefined
        },
        help: {
            type: [String, Number, Array, Object],
            default: ''
        },
        extra: {
            type: [String, Number, Array, Object],
            default: ''
        },
        validateStatus: {
            type: String,
            default: ''
        },
        required: {
            type: Boolean,
            default: false
        },
        labelCol: {
            type: Object,
            default: undefined
        },
        wrapperCol: {
            type: Object,
            default: undefined
        },
        colon: {
            type: Boolean,
            default: undefined
        },
        htmlFor: {
            type: String,
            default: undefined
        },
        labelAlign: {
            type: String,
            default: 'right'
        }
    });

    const slots = useSlots();
    const formContext = inject('nnFormContext', null);

    const layout = computed(() => formContext?.layout.value || 'horizontal');
    const effectiveLabelCol = computed(() => props.labelCol || formContext?.labelCol.value || {});
    const effectiveWrapperCol = computed(() => props.wrapperCol || formContext?.wrapperCol.value || {});
    const hasLabel = computed(() => Boolean(slots.label) || (props.label !== '' && props.label !== null));
    const hasHelp = computed(() => Boolean(slots.help) || (props.help !== '' && props.help !== null));
    const hasExtra = computed(() => Boolean(slots.extra) || (props.extra !== '' && props.extra !== null));
    const showColon = computed(() => {
        if (!hasLabel.value || layout.value === 'vertical') {
            return false;
        }
        return props.colon === undefined ? formContext?.colon.value !== false : props.colon;
    });

    const normalizeGridValue = value => {
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric >= 0 && numeric <= 24 ? numeric : null;
    };

    const getColumnStyle = (column, isLabel) => {
        if (layout.value === 'vertical') {
            return column.style || {};
        }

        const span = normalizeGridValue(column.span);
        const offset = normalizeGridValue(column.offset);
        const style = {};

        if (span !== null && span > 0) {
            const width = `${(span / 24) * 100}%`;
            style.flex = `0 0 ${width}`;
            style.maxWidth = width;
        } else {
            style.flex = isLabel ? '0 0 auto' : '1 1 0';
            style.maxWidth = isLabel ? undefined : '100%';
        }

        if (offset !== null && offset > 0) {
            style.marginInlineStart = `${(offset / 24) * 100}%`;
        }

        return {
            ...style,
            ...(column.style || {})
        };
    };

    const getColumnClass = column => [column.class, column.className].filter(Boolean);

    const labelColumnStyle = computed(() => getColumnStyle(effectiveLabelCol.value, true));
    const controlColumnStyle = computed(() => getColumnStyle(effectiveWrapperCol.value, false));
    const labelColumnClass = computed(() => getColumnClass(effectiveLabelCol.value));
    const controlColumnClass = computed(() => getColumnClass(effectiveWrapperCol.value));

    const itemClass = computed(() => ({
        [`nn-form-item-${layout.value}`]: true,
        'nn-form-item-has-error': props.validateStatus === 'error',
        'nn-form-item-has-warning': props.validateStatus === 'warning',
        'nn-form-item-has-success': props.validateStatus === 'success',
        'nn-form-item-has-feedback': Boolean(props.validateStatus),
        'nn-form-item-required': props.required,
        'nn-form-item-no-label': !hasLabel.value
    }));

    const labelClass = computed(() => ({
        'nn-form-item-label-required': props.required,
        'nn-form-item-label-left': props.labelAlign === 'left'
    }));

    const explainClass = computed(() => ({
        'nn-form-item-explain-error': props.validateStatus === 'error',
        'nn-form-item-explain-warning': props.validateStatus === 'warning'
    }));
</script>

<style scoped>
    .nn-form-item {
        box-sizing: border-box;
        margin: 0 0 8px;
        color: var(--nn-color-text);
        font-size: 14px;
        line-height: 1.5715;
    }

    .nn-form-item-row {
        display: flex;
        flex-wrap: nowrap;
        width: 100%;
        min-width: 0;
    }

    .nn-form-item-label {
        min-width: 0;
        padding: 0 12px 0 0;
        overflow: hidden;
        text-align: right;
        white-space: nowrap;
    }

    .nn-form-item-label > label {
        position: relative;
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        min-height: 32px;
        color: var(--nn-color-text);
        line-height: 1.5715;
        white-space: normal;
    }

    .nn-form-item-label-required::before {
        display: inline-block;
        margin-inline-end: 4px;
        color: var(--nn-color-error);
        content: '*';
        font-family: SimSun, sans-serif;
        font-size: 14px;
        line-height: 1;
    }

    .nn-form-item-colon {
        margin-inline-start: 2px;
    }

    .nn-form-item-label-left {
        width: 100%;
        justify-content: flex-start;
        text-align: left;
    }

    .nn-form-item-control {
        display: flex;
        flex-direction: column;
        min-width: 0;
    }

    .nn-form-item-control-input {
        display: flex;
        align-items: center;
        min-height: 32px;
    }

    .nn-form-item-control-input-content {
        width: 100%;
        max-width: 100%;
        min-width: 0;
    }

    .nn-form-item-explain,
    .nn-form-item-extra {
        min-height: 22px;
        color: var(--nn-color-text-muted);
        font-size: 13px;
        line-height: 1.5715;
    }

    .nn-form-item-explain-error {
        color: var(--nn-color-error);
    }

    .nn-form-item-explain-warning {
        color: var(--nn-color-warning);
    }

    .nn-form-item-vertical .nn-form-item-row {
        display: block;
    }

    .nn-form-item-vertical .nn-form-item-label {
        width: 100%;
        padding: 0 0 4px;
        text-align: left;
    }

    .nn-form-item-vertical .nn-form-item-label > label {
        min-height: 22px;
    }

    .nn-form-item-vertical .nn-form-item-control {
        width: 100%;
        max-width: 100%;
    }

    .nn-form-item-inline {
        display: inline-flex;
        flex: none;
        margin-bottom: 0;
        vertical-align: top;
    }

    .nn-form-item-inline .nn-form-item-row {
        width: auto;
    }

    .nn-form-item-inline .nn-form-item-label {
        padding-inline-end: 8px;
    }

    .nn-form-item-inline .nn-form-item-control {
        flex: none !important;
        width: auto;
        max-width: none !important;
    }

    @media (max-width: 720px) {
        .nn-form-item-horizontal .nn-form-item-row {
            display: block;
        }

        .nn-form-item-horizontal .nn-form-item-label,
        .nn-form-item-horizontal .nn-form-item-control {
            width: 100% !important;
            max-width: 100% !important;
            margin-inline-start: 0 !important;
        }

        .nn-form-item-horizontal .nn-form-item-label {
            padding: 0 0 4px;
            text-align: left;
        }

        .nn-form-item-horizontal .nn-form-item-label > label {
            min-height: 22px;
        }
    }
</style>
