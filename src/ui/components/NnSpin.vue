<template>
    <div v-if="$slots.default" class="nn-spin-nested-loading">
        <div v-if="spinning" class="nn-spin-overlay" aria-live="polite" aria-busy="true">
            <span class="nn-spin-dot" :class="spinSizeClass" />
        </div>
        <div class="nn-spin-container" :class="{ 'nn-spin-blur': spinning }">
            <slot />
        </div>
    </div>
    <span v-else-if="spinning" class="nn-spin" aria-live="polite" aria-busy="true">
        <span class="nn-spin-dot" :class="spinSizeClass" />
    </span>
</template>

<script setup>
    import { computed } from 'vue';

    const props = defineProps({
        spinning: {
            type: Boolean,
            default: true
        },
        size: {
            type: String,
            default: 'default'
        }
    });

    const spinSizeClass = computed(() => ({
        'nn-spin-dot-small': props.size === 'small',
        'nn-spin-dot-large': props.size === 'large'
    }));
</script>

<style scoped>
    .nn-spin {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        vertical-align: middle;
    }

    .nn-spin-nested-loading {
        position: relative;
    }

    .nn-spin-overlay {
        position: absolute;
        inset: 0;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: center;
        background: color-mix(in srgb, var(--nn-color-bg-surface) 72%, transparent);
    }

    .nn-spin-container {
        min-height: 0;
        transition: opacity 0.2s;
    }

    .nn-spin-blur {
        opacity: 0.62;
        pointer-events: none;
        user-select: none;
    }

    .nn-spin-dot {
        width: 18px;
        height: 18px;
        border: 2px solid var(--nn-color-primary);
        border-right-color: transparent;
        border-radius: 50%;
        animation: nn-spin-rotate 0.8s linear infinite;
    }

    .nn-spin-dot-small {
        width: 14px;
        height: 14px;
        border-width: 2px;
    }

    .nn-spin-dot-large {
        width: 28px;
        height: 28px;
        border-width: 3px;
    }

    @keyframes nn-spin-rotate {
        to {
            transform: rotate(360deg);
        }
    }
</style>
