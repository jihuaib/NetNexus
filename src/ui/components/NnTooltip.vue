<template>
    <span
        class="nn-tooltip"
        :class="tooltipClass"
        @mouseenter="hovered = true"
        @mouseleave="hovered = false"
        @focusin="focused = true"
        @focusout="focused = false"
    >
        <span class="nn-tooltip-trigger">
            <slot />
        </span>
        <span v-if="visible" class="nn-tooltip-popup" role="tooltip">
            <span class="nn-tooltip-arrow" />
            <span class="nn-tooltip-inner">
                <slot name="title">{{ title }}</slot>
            </span>
        </span>
    </span>
</template>

<script setup>
    import { computed, ref, useSlots } from 'vue';

    const props = defineProps({
        title: {
            type: [String, Number],
            default: ''
        },
        open: {
            type: Boolean,
            default: undefined
        }
    });

    const slots = useSlots();
    const hovered = ref(false);
    const focused = ref(false);

    const isControlled = computed(() => props.open !== undefined);
    const hasContent = computed(() => props.title !== '' || Boolean(slots.title));

    const visible = computed(() => {
        if (!hasContent.value) {
            return false;
        }

        return isControlled.value ? props.open : hovered.value || focused.value;
    });

    const tooltipClass = computed(() => ({
        'nn-tooltip-controlled': isControlled.value,
        'nn-tooltip-open': visible.value
    }));
</script>

<style scoped>
    .nn-tooltip {
        position: relative;
        display: inline-flex;
        max-width: 100%;
        vertical-align: middle;
    }

    .nn-tooltip-controlled {
        display: block;
        width: 100%;
    }

    .nn-tooltip-trigger {
        display: inline-flex;
        width: 100%;
        max-width: 100%;
        min-width: 0;
    }

    .nn-tooltip:not(.nn-tooltip-controlled) .nn-tooltip-trigger {
        width: auto;
    }

    .nn-tooltip-popup {
        position: absolute;
        bottom: calc(100% + 8px);
        left: 50%;
        z-index: 1000;
        width: max-content;
        max-width: min(320px, 80vw);
        transform: translateX(-50%);
        pointer-events: none;
    }

    .nn-tooltip-inner {
        display: block;
        min-height: 24px;
        padding: 8px 12px;
        border-radius: 4px;
        background: var(--nn-color-tooltip-bg);
        color: var(--nn-color-tooltip-text);
        font-size: 12px;
        line-height: 1.45;
        overflow-wrap: anywhere;
        box-shadow: var(--nn-shadow-floating);
    }

    .nn-tooltip-arrow {
        position: absolute;
        bottom: -4px;
        left: 50%;
        width: 8px;
        height: 8px;
        background: var(--nn-color-tooltip-bg);
        transform: translateX(-50%) rotate(45deg);
    }
</style>
