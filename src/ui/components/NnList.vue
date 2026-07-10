<template>
    <ul class="nn-list" :class="{ 'nn-list-small': size === 'small' }">
        <template v-for="(item, index) in dataSource" :key="getItemKey(item, index)">
            <slot name="renderItem" :item="item" :index="index" />
        </template>
        <slot v-if="dataSource.length === 0" />
    </ul>
</template>

<script setup>
    defineProps({
        size: {
            type: String,
            default: 'default'
        },
        dataSource: {
            type: Array,
            default: () => []
        }
    });

    const getItemKey = (item, index) => {
        if (item && typeof item === 'object') {
            return item.id || item.key || index;
        }

        return `${item}-${index}`;
    };
</script>

<style scoped>
    .nn-list {
        margin: 0;
        padding: 0;
        list-style: none;
        color: var(--nn-color-text);
        border-top: 1px solid var(--nn-color-border-light);
    }

    .nn-list-small {
        font-size: 13px;
    }
</style>
