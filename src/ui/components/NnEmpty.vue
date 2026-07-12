<template>
    <div class="nn-empty nn-empty-normal">
        <svg class="nn-empty-image" viewBox="0 0 96 72" aria-hidden="true" focusable="false">
            <ellipse class="nn-empty-image-shadow" cx="48" cy="65" rx="30" ry="4" />
            <path class="nn-empty-image-surface" d="M29 18h38l8 32H59c-1.2 5.3-5.6 9-11 9s-9.8-3.7-11-9H21l8-32Z" />
            <path class="nn-empty-image-line" d="M21 50v7a4 4 0 0 0 4 4h46a4 4 0 0 0 4-4v-7" />
            <path class="nn-empty-image-accent" d="M39 31h18M42 38h12" />
        </svg>
        <div class="nn-empty-description">
            <slot name="description">
                {{ description }}
            </slot>
        </div>
        <div v-if="$slots.default" class="nn-empty-actions">
            <slot />
        </div>
    </div>
</template>

<script setup>
    defineProps({
        description: {
            type: String,
            default: '暂无数据'
        }
    });
</script>

<style scoped>
    .nn-empty {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 104px;
        padding: 12px;
        color: var(--nn-empty-color, var(--nn-color-text-muted));
        text-align: center;
    }

    .nn-empty-image {
        display: block;
        width: 72px;
        height: 54px;
        margin-bottom: 8px;
        overflow: visible;
    }

    .nn-empty-image-shadow {
        fill: var(--nn-empty-image-line, var(--nn-color-text-placeholder));
        opacity: 0.16;
    }

    .nn-empty-image-surface {
        fill: var(--nn-empty-image-surface, var(--nn-color-bg-muted));
        stroke: var(--nn-empty-image-border, var(--nn-color-border));
        stroke-linejoin: round;
        stroke-width: 1.5;
    }

    .nn-empty-image-line,
    .nn-empty-image-accent {
        fill: none;
        stroke-linecap: round;
        stroke-width: 1.5;
    }

    .nn-empty-image-line {
        stroke: var(--nn-empty-image-line, var(--nn-color-text-placeholder));
        stroke-linejoin: round;
    }

    .nn-empty-image-accent {
        stroke: var(--nn-color-primary);
        opacity: 0.5;
    }

    .nn-empty-description {
        color: inherit;
        font-size: 13px;
        line-height: 1.5;
    }

    .nn-empty-actions {
        margin-top: 12px;
    }
</style>
