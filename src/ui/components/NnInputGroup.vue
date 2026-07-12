<template>
    <span class="nn-input-group" :class="{ 'nn-input-group-compact': compact }" role="group">
        <slot />
    </span>
</template>

<script setup>
    defineProps({
        compact: {
            type: Boolean,
            default: false
        }
    });
</script>

<style scoped>
    .nn-input-group {
        display: inline-flex;
        align-items: stretch;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        vertical-align: middle;
    }

    .nn-input-group:not(.nn-input-group-compact) {
        gap: 8px;
    }

    .nn-input-group-compact {
        gap: 0;
    }

    .nn-input-group-compact :deep(> *) {
        position: relative;
        border-radius: 0;
    }

    .nn-input-group-compact :deep(> * .nn-input),
    .nn-input-group-compact :deep(> * .nn-input-number-input),
    .nn-input-group-compact :deep(> * .nn-button) {
        border-radius: 0;
    }

    .nn-input-group-compact :deep(> *:first-child),
    .nn-input-group-compact :deep(> *:first-child .nn-input),
    .nn-input-group-compact :deep(> *:first-child .nn-input-number-input),
    .nn-input-group-compact :deep(> *:first-child .nn-button) {
        border-start-start-radius: 6px;
        border-end-start-radius: 6px;
    }

    .nn-input-group-compact :deep(> *:last-child),
    .nn-input-group-compact :deep(> *:last-child .nn-input),
    .nn-input-group-compact :deep(> *:last-child .nn-input-number-input),
    .nn-input-group-compact :deep(> *:last-child .nn-button) {
        border-start-end-radius: 6px;
        border-end-end-radius: 6px;
    }

    .nn-input-group-compact :deep(> *:not(:first-child)) {
        margin-inline-start: -1px;
    }

    .nn-input-group-compact :deep(> *:focus-within),
    .nn-input-group-compact :deep(> *:hover) {
        z-index: 1;
    }
</style>
