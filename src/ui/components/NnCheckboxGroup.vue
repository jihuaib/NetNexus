<template>
    <div class="nn-checkbox-group">
        <NnCheckbox
            v-for="option in normalizedOptions"
            :key="String(option.value)"
            :checked="isChecked(option.value)"
            :disabled="disabled || option.disabled"
            :value="option.value"
            @update:checked="checked => updateOption(option.value, checked)"
        >
            {{ option.label }}
        </NnCheckbox>
    </div>
</template>

<script setup>
    import { computed } from 'vue';
    import NnCheckbox from './NnCheckbox.vue';

    const props = defineProps({
        value: {
            type: Array,
            default: () => []
        },
        options: {
            type: Array,
            default: () => []
        },
        disabled: {
            type: Boolean,
            default: false
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

    const isChecked = value => props.value.includes(value);

    const updateOption = (optionValue, checked) => {
        const nextValue = checked
            ? [...props.value, optionValue].filter((value, index, list) => list.indexOf(value) === index)
            : props.value.filter(value => value !== optionValue);

        emit('update:value', nextValue);
        emit('change', nextValue);
    };
</script>

<style scoped>
    .nn-checkbox-group {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 12px;
        max-width: 100%;
        vertical-align: middle;
    }

    .nn-checkbox-group :deep(.nn-checkbox-wrapper + .nn-checkbox-wrapper) {
        margin-inline-start: 0;
    }
</style>
