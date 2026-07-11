<template>
    <span class="nn-select-option-content">
        <slot>{{ label }}</slot>
    </span>
</template>

<script setup>
    defineOptions({ name: 'NnSelectOption' });

    defineProps({
        value: {
            type: [String, Number, Boolean, Object],
            default: undefined
        },
        label: {
            type: [String, Number],
            default: ''
        },
        disabled: {
            type: Boolean,
            default: false
        }
    });
</script>

<style scoped>
    .nn-select-option-content {
        display: inline;
    }
</style>
