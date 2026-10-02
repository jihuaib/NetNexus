<template>
    <div class="route-schema-form">
        <section
            v-for="section in visibleSections"
            :key="section.id"
            class="route-schema-section"
            :class="{ 'advanced-section': section.advanced }"
            :data-route-section="section.id"
        >
            <div v-if="section.title || section.description" class="route-schema-section-heading">
                <div v-if="section.title" class="section-title">{{ section.title }}</div>
                <div v-if="section.description" class="section-description">{{ section.description }}</div>
            </div>
            <div class="route-schema-fields">
                <nn-form-item
                    v-for="field in visibleFields(section)"
                    :key="field.key"
                    class="route-schema-field"
                    :class="{ 'wide-field': field.fullWidth || field.type === 'textarea' }"
                    :label="field.label"
                    :name="field.key"
                    :html-for="fieldId(field)"
                    :help="errors[field.key] || ''"
                    :extra="field.help || ''"
                    :validate-status="errors[field.key] ? 'error' : ''"
                >
                    <nn-input
                        v-if="field.type === 'input'"
                        :id="fieldId(field)"
                        :value="modelValue[field.key]"
                        :placeholder="field.placeholder || ''"
                        :disabled="disabled || isRouteFieldDisabled(field, modelValue)"
                        :status="errors[field.key] ? 'error' : ''"
                        :data-testid="field.testId || `route-field-${field.key}`"
                        :aria-invalid="errors[field.key] ? 'true' : undefined"
                        @update:value="value => updateField(field.key, value)"
                    />
                    <nn-textarea
                        v-else-if="field.type === 'textarea'"
                        :id="fieldId(field)"
                        :value="modelValue[field.key]"
                        :height="field.height || '90px'"
                        resize="vertical"
                        :placeholder="field.placeholder || ''"
                        :disabled="disabled || isRouteFieldDisabled(field, modelValue)"
                        :status="errors[field.key] ? 'error' : ''"
                        :data-testid="field.testId || `route-field-${field.key}`"
                        :aria-invalid="errors[field.key] ? 'true' : undefined"
                        @update:value="value => updateField(field.key, value)"
                    />
                    <nn-select
                        v-else-if="field.type === 'select'"
                        :id="fieldId(field)"
                        :value="modelValue[field.key]"
                        :options="field.options"
                        :disabled="disabled || isRouteFieldDisabled(field, modelValue)"
                        :status="errors[field.key] ? 'error' : ''"
                        :data-testid="field.testId || `route-field-${field.key}`"
                        :aria-label="field.label"
                        :aria-invalid="errors[field.key] ? 'true' : undefined"
                        @update:value="value => updateField(field.key, value)"
                    />
                    <nn-switch
                        v-else-if="field.type === 'switch'"
                        :id="fieldId(field)"
                        :checked="Boolean(modelValue[field.key])"
                        :disabled="disabled || isRouteFieldDisabled(field, modelValue)"
                        :data-testid="field.testId || `route-field-${field.key}`"
                        :aria-label="field.label"
                        size="small"
                        @update:checked="value => updateField(field.key, value)"
                    />
                    <nn-radio-group
                        v-else-if="field.type === 'radio'"
                        :id="fieldId(field)"
                        :value="modelValue[field.key]"
                        :options="field.options"
                        :disabled="disabled || isRouteFieldDisabled(field, modelValue)"
                        :data-testid="field.testId || `route-field-${field.key}`"
                        :aria-label="field.label"
                        size="small"
                        @update:value="value => updateField(field.key, value)"
                    />
                </nn-form-item>
            </div>
        </section>
    </div>
</template>

<script setup>
    import { computed, useId } from 'vue';
    import {
        isSchemaFieldDisabled as isRouteFieldDisabled,
        isSchemaFieldVisible as isRouteFieldVisible
    } from '../utils/schemaForm';

    const props = defineProps({
        modelValue: { type: Object, required: true },
        sections: { type: Array, required: true },
        errors: { type: Object, default: () => ({}) },
        disabled: { type: Boolean, default: false }
    });
    const emit = defineEmits(['update:modelValue']);
    const formId = useId();
    const fieldId = field => `${formId}-${field.key}`;
    const visibleSections = computed(() =>
        props.sections.filter(section => isRouteFieldVisible(section, props.modelValue))
    );
    const visibleFields = section => section.fields.filter(field => isRouteFieldVisible(field, props.modelValue));
    const updateField = (key, value) => {
        if (!props.disabled) emit('update:modelValue', { ...props.modelValue, [key]: value });
    };
</script>

<style scoped>
    .route-schema-form {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 0;
    }

    .route-schema-section {
        min-width: 0;
    }

    .advanced-section {
        padding: 12px 14px 2px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-muted);
    }

    .route-schema-section-heading {
        margin-bottom: 10px;
    }

    .section-title {
        color: var(--nn-color-text-strong);
        font-size: 13px;
        font-weight: 600;
        line-height: 20px;
    }

    .section-description {
        margin-top: 2px;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
        line-height: 18px;
    }

    .route-schema-fields {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
        column-gap: 16px;
        align-items: start;
    }

    .route-schema-field {
        min-width: 0;
        margin-bottom: 10px;
    }

    .wide-field {
        grid-column: 1 / -1;
    }

    .route-schema-field :deep(.nn-form-item-control) {
        min-width: 0;
    }

    .route-schema-field :deep(.nn-form-item-label > label) {
        min-height: 28px;
        font-size: 12px;
    }

    .route-schema-field :deep(.nn-form-item-control-input) {
        min-height: 28px;
    }

    .route-schema-field :deep(.nn-input-wrapper),
    .route-schema-field :deep(.nn-select) {
        width: 100%;
    }

    .route-schema-field :deep(.nn-input) {
        height: 28px;
        padding: 2px 8px;
        font-size: 13px;
    }

    .route-schema-field :deep(.nn-select) {
        min-height: 28px;
        font-size: 13px;
    }

    .route-schema-field :deep(.nn-form-item-explain),
    .route-schema-field :deep(.nn-form-item-extra) {
        font-size: 11px;
        line-height: 16px;
    }

    .route-schema-field :deep(.nn-radio-wrapper) {
        font-size: 13px;
    }

    @media (max-width: 720px) {
        .route-schema-fields {
            grid-template-columns: 1fr;
        }

        .advanced-section {
            padding: 10px 12px 0;
        }
    }
</style>
