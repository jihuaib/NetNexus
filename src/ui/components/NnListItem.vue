<template>
    <li class="nn-list-item">
        <slot />
    </li>
</template>

<style scoped>
    .nn-list-item {
        display: flex;
        align-items: flex-start;
        min-width: 0;
        padding: 10px 0;
        border-bottom: 1px solid var(--nn-color-border-light);
    }
</style>
