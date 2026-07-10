<template>
    <div class="nn-empty nn-empty-normal">
        <div class="nn-empty-icon" aria-hidden="true">--</div>
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
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 96px;
        color: var(--nn-color-text-muted);
        text-align: center;
    }

    .nn-empty-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 42px;
        height: 42px;
        margin-bottom: 8px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 50%;
        background: var(--nn-color-bg-muted);
        color: var(--nn-color-text-placeholder);
        font-size: 20px;
        line-height: 1;
    }

    .nn-empty-description {
        color: var(--nn-color-text-muted);
        font-size: 14px;
        line-height: 1.5;
    }

    .nn-empty-actions {
        margin-top: 12px;
    }
</style>
