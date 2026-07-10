<template>
    <span class="nn-tag" :class="tagClass">
        <slot />
    </span>
</template>

<script setup>
    import { computed } from 'vue';

    const props = defineProps({
        color: {
            type: String,
            default: 'default'
        }
    });

    const supportedColors = new Set([
        'blue',
        'green',
        'red',
        'orange',
        'purple',
        'cyan',
        'success',
        'error',
        'warning',
        'processing',
        'default'
    ]);

    const tagClass = computed(() => {
        const color = supportedColors.has(props.color) ? props.color : 'default';

        return `nn-tag-${color}`;
    });
</script>

<style scoped>
    .nn-tag {
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        min-height: 22px;
        margin-inline-end: 8px;
        padding: 0 7px;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 4px;
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text-secondary);
        font-size: 12px;
        line-height: 20px;
        vertical-align: middle;
        white-space: nowrap;
    }

    .nn-tag-blue,
    .nn-tag-processing {
        border-color: var(--nn-color-border-info);
        background: var(--nn-color-bg-info-subtle);
        color: var(--nn-color-text-info);
    }

    .nn-tag-green,
    .nn-tag-success {
        border-color: var(--nn-color-success);
        background: var(--nn-color-bg-success-subtle);
        color: var(--nn-color-text-success);
    }

    .nn-tag-red,
    .nn-tag-error {
        border-color: var(--nn-color-border-danger);
        background: var(--nn-color-bg-danger-subtle);
        color: var(--nn-color-error);
    }

    .nn-tag-orange,
    .nn-tag-warning {
        border-color: var(--nn-color-warning);
        background: var(--nn-color-bg-warning-subtle);
        color: var(--nn-color-text-warning);
    }

    .nn-tag-purple {
        border-color: var(--nn-color-border-info);
        background: var(--nn-color-bg-info-subtle);
        color: var(--nn-color-text-stale);
    }

    .nn-tag-cyan {
        border-color: var(--nn-color-border-info);
        background: var(--nn-color-bg-info-subtle);
        color: var(--nn-color-info);
    }
</style>
