<template>
    <div class="nn-statistic">
        <div v-if="title || $slots.title" class="nn-statistic-title">
            <slot name="title">{{ title }}</slot>
        </div>
        <div class="nn-statistic-content">
            <span v-if="prefix || $slots.prefix" class="nn-statistic-prefix">
                <slot name="prefix">{{ prefix }}</slot>
            </span>
            <span class="nn-statistic-value">
                <slot>{{ value }}</slot>
            </span>
            <span v-if="suffix || $slots.suffix" class="nn-statistic-suffix">
                <slot name="suffix">{{ suffix }}</slot>
            </span>
        </div>
    </div>
</template>

<script setup>
    defineProps({
        title: {
            type: [String, Number],
            default: ''
        },
        value: {
            type: [String, Number],
            default: ''
        },
        prefix: {
            type: [String, Number],
            default: ''
        },
        suffix: {
            type: [String, Number],
            default: ''
        }
    });
</script>

<style scoped>
    .nn-statistic {
        min-width: 0;
    }

    .nn-statistic-title {
        margin-bottom: 4px;
        color: var(--nn-color-text-secondary);
        font-size: 14px;
        line-height: 1.5;
    }

    .nn-statistic-content {
        display: flex;
        align-items: baseline;
        gap: 2px;
        min-width: 0;
        color: var(--nn-color-text-strong);
        font-size: 24px;
        line-height: 1.35;
        white-space: nowrap;
    }

    .nn-statistic-prefix,
    .nn-statistic-suffix {
        color: var(--nn-color-text-secondary);
        font-size: 0.72em;
    }
</style>
