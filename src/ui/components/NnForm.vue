<template>
    <form ref="formRef" class="nn-form" :class="formClass" @submit="handleSubmit">
        <slot />
    </form>
</template>

<script setup>
    import { computed, provide, ref, toRef } from 'vue';

    const props = defineProps({
        model: {
            type: Object,
            default: () => ({})
        },
        layout: {
            type: String,
            default: 'horizontal'
        },
        labelCol: {
            type: Object,
            default: () => ({})
        },
        wrapperCol: {
            type: Object,
            default: () => ({})
        },
        colon: {
            type: Boolean,
            default: true
        },
        disabled: {
            type: Boolean,
            default: false
        }
    });

    const emit = defineEmits(['finish', 'submit']);
    const formRef = ref(null);

    const normalizedLayout = computed(() => {
        const layouts = new Set(['horizontal', 'vertical', 'inline']);
        return layouts.has(props.layout) ? props.layout : 'horizontal';
    });

    const formClass = computed(() => ({
        [`nn-form-${normalizedLayout.value}`]: true,
        'nn-form-disabled': props.disabled
    }));

    provide('nnFormContext', {
        layout: normalizedLayout,
        labelCol: toRef(props, 'labelCol'),
        wrapperCol: toRef(props, 'wrapperCol'),
        colon: toRef(props, 'colon'),
        disabled: toRef(props, 'disabled'),
        model: toRef(props, 'model')
    });

    const handleSubmit = event => {
        event.preventDefault();
        emit('submit', event);
        emit('finish', props.model);
    };

    const submit = () => formRef.value?.requestSubmit();
    const validate = () => Promise.resolve(props.model);
    const resetFields = () => formRef.value?.reset();

    defineExpose({
        submit,
        validate,
        validateFields: validate,
        resetFields
    });
</script>

<style scoped>
    .nn-form {
        box-sizing: border-box;
        margin: 0;
        color: var(--nn-color-text);
        font-family: var(--nn-font-family);
        font-size: 14px;
        line-height: 1.5715;
    }

    .nn-form-inline {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        gap: 8px 16px;
    }

    .nn-form-disabled {
        cursor: not-allowed;
    }
</style>
