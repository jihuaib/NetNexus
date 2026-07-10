<template>
    <div class="nn-space" :class="spaceClasses" :style="spaceStyle">
        <slot />
    </div>
</template>

<script setup>
    import { computed } from 'vue';

    const props = defineProps({
        direction: {
            type: String,
            default: 'horizontal'
        },
        size: {
            type: [String, Number, Array],
            default: 'small'
        },
        align: {
            type: String,
            default: 'center'
        },
        wrap: {
            type: Boolean,
            default: false
        }
    });

    const sizeMap = {
        small: 8,
        middle: 16,
        large: 24
    };

    const normalizeSize = value => {
        if (typeof value === 'number') {
            return `${value}px`;
        }

        return `${sizeMap[value] || sizeMap.small}px`;
    };

    const spaceClasses = computed(() => ({
        'nn-space-vertical': props.direction === 'vertical',
        'nn-space-wrap': props.wrap
    }));

    const spaceStyle = computed(() => {
        const gap = Array.isArray(props.size)
            ? `${normalizeSize(props.size[1])} ${normalizeSize(props.size[0])}`
            : normalizeSize(props.size);

        return {
            alignItems: props.align,
            gap
        };
    });
</script>

<style scoped>
    .nn-space {
        display: inline-flex;
        flex-wrap: nowrap;
        max-width: 100%;
        vertical-align: middle;
    }

    .nn-space-wrap {
        flex-wrap: wrap;
    }

    .nn-space-vertical {
        flex-direction: column;
        align-items: stretch;
    }
</style>
