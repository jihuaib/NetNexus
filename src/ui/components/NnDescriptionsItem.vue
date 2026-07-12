<template>
    <div class="nn-descriptions-item" :class="itemClass" :style="itemStyle">
        <div class="nn-descriptions-item-label">
            <slot name="label">{{ label }}</slot>
        </div>
        <div class="nn-descriptions-item-content">
            <slot />
        </div>
    </div>
</template>

<script setup>
    import { computed, inject } from 'vue';

    const props = defineProps({
        label: {
            type: [String, Number],
            default: ''
        },
        span: {
            type: [Number, String],
            default: 1
        }
    });

    const context = inject('nnDescriptionsContext', {
        column: computed(() => 3),
        bordered: computed(() => false)
    });

    const normalizedSpan = computed(() => {
        const span = Number(props.span);
        const column = Number(context.column.value) || 1;

        if (!Number.isFinite(span) || span < 1) {
            return 1;
        }

        return Math.min(Math.floor(span), column);
    });

    const itemClass = computed(() => ({
        'nn-descriptions-item-bordered': Boolean(context.bordered.value)
    }));

    const itemStyle = computed(() => ({
        gridColumn: `span ${normalizedSpan.value}`
    }));
</script>

<style scoped>
    .nn-descriptions-item {
        display: grid;
        grid-template-columns: minmax(88px, max-content) minmax(0, 1fr);
        min-width: 0;
        color: var(--nn-color-text);
    }

    .nn-descriptions-item-label,
    .nn-descriptions-item-content {
        min-width: 0;
        overflow-wrap: anywhere;
    }

    .nn-descriptions-item-label {
        color: var(--nn-color-text-secondary);
        font-weight: 500;
    }

    .nn-descriptions-item-content {
        color: var(--nn-color-text);
    }

    .nn-descriptions-item:not(.nn-descriptions-item-bordered) {
        gap: 8px;
        align-items: baseline;
    }

    .nn-descriptions-item-bordered {
        grid-template-columns: minmax(104px, 34%) minmax(0, 1fr);
        border-right: 1px solid var(--nn-color-border-light);
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .nn-descriptions-item-bordered .nn-descriptions-item-label {
        padding: 8px 10px;
        background: var(--nn-color-bg-subtle);
        border-right: 1px solid var(--nn-color-border-light);
        color: var(--nn-color-text-secondary);
    }

    .nn-descriptions-item-bordered .nn-descriptions-item-content {
        padding: 8px 10px;
        background: var(--nn-color-bg-surface);
    }

    @media (max-width: 720px) {
        .nn-descriptions-item {
            grid-column: span 1 !important;
        }

        .nn-descriptions-item-bordered {
            grid-template-columns: minmax(96px, 36%) minmax(0, 1fr);
        }
    }
</style>
