<template>
    <section class="nn-card" :class="{ 'nn-card-small': size === 'small' }">
        <header v-if="hasHeader" class="nn-card-head">
            <div class="nn-card-head-title">
                <slot name="title">{{ title }}</slot>
            </div>
            <div v-if="$slots.extra" class="nn-card-extra">
                <slot name="extra" />
            </div>
        </header>
        <div class="nn-card-body">
            <slot />
        </div>
    </section>
</template>

<script setup>
    import { computed, useSlots } from 'vue';

    const props = defineProps({
        title: {
            type: [String, Number],
            default: ''
        },
        size: {
            type: String,
            default: 'default'
        }
    });

    const slots = useSlots();
    const hasHeader = computed(() => Boolean(props.title || slots.title || slots.extra));
</script>

<style scoped>
    .nn-card {
        position: relative;
        min-width: 0;
        color: var(--nn-color-text);
        background: var(--nn-color-bg-surface);
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
    }

    .nn-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 40px;
        padding: 0 10px;
        background: var(--nn-color-bg-card-head);
        border-bottom: none;
        border-radius: 8px 8px 0 0;
    }

    .nn-card-head-title {
        min-width: 0;
        overflow: hidden;
        padding: 10px 0;
        color: var(--nn-color-text-inverse);
        font-size: 14px;
        font-weight: 600;
        line-height: 1.4;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .nn-card-extra {
        flex: none;
        color: var(--nn-color-text-inverse);
    }

    .nn-card-body {
        padding: 10px;
    }

    .nn-card-small .nn-card-head {
        min-height: 36px;
    }

    .nn-card-small .nn-card-body {
        padding: 8px;
    }
</style>
