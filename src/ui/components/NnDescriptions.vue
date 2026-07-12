<template>
    <section class="nn-descriptions" :class="descriptionsClass">
        <div v-if="hasTitle" class="nn-descriptions-title">
            <slot name="title">{{ title }}</slot>
        </div>
        <div class="nn-descriptions-view" :style="viewStyle">
            <slot />
        </div>
    </section>
</template>

<script setup>
    import { computed, provide, useSlots } from 'vue';

    const props = defineProps({
        title: {
            type: [String, Number],
            default: ''
        },
        column: {
            type: [Number, String],
            default: 3
        },
        bordered: {
            type: Boolean,
            default: false
        },
        size: {
            type: String,
            default: 'default'
        }
    });

    const slots = useSlots();

    const normalizedColumn = computed(() => {
        const column = Number(props.column);

        return Number.isFinite(column) && column > 0 ? Math.max(1, Math.floor(column)) : 3;
    });

    const hasTitle = computed(() => Boolean(props.title || slots.title));
    const isBordered = computed(() => props.bordered);

    const descriptionsClass = computed(() => ({
        'nn-descriptions-bordered': props.bordered,
        'nn-descriptions-small': props.size === 'small'
    }));

    const viewStyle = computed(() => ({
        '--nn-descriptions-columns': normalizedColumn.value
    }));

    provide('nnDescriptionsContext', {
        column: normalizedColumn,
        bordered: isBordered
    });
</script>

<style scoped>
    .nn-descriptions {
        min-width: 0;
        color: var(--nn-color-text);
        font-size: 14px;
        line-height: 1.5715;
    }

    .nn-descriptions-title {
        margin-bottom: 12px;
        color: var(--nn-color-text-strong);
        font-size: 15px;
        font-weight: 600;
        line-height: 1.4;
    }

    .nn-descriptions-view {
        display: grid;
        grid-template-columns: repeat(var(--nn-descriptions-columns), minmax(0, 1fr));
        gap: 12px 18px;
        min-width: 0;
    }

    .nn-descriptions-bordered .nn-descriptions-view {
        gap: 0;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-right: 0;
        border-bottom: 0;
        border-radius: 4px;
    }

    .nn-descriptions-small {
        font-size: 13px;
    }

    .nn-descriptions-small .nn-descriptions-title {
        margin-bottom: 8px;
        font-size: 14px;
    }

    @media (max-width: 720px) {
        .nn-descriptions-view {
            grid-template-columns: 1fr;
        }
    }
</style>
