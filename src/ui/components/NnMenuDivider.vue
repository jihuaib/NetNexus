<template>
    <li class="nn-menu-divider" role="separator" aria-orientation="horizontal" />
</template>

<script setup>
    defineOptions({
        name: 'NnMenuDivider'
    });
</script>

<style scoped>
    .nn-menu-divider {
        height: 1px;
        margin: 5px 8px;
        padding: 0;
        overflow: hidden;
        border: 0;
        background: var(--nn-color-border-light);
        line-height: 0;
        list-style: none;
    }
</style>
