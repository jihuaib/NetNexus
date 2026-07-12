<template>
    <div class="nn-row" :style="rowStyle">
        <slot />
    </div>
</template>

<script setup>
    import { computed } from 'vue';

    const props = defineProps({
        gutter: {
            type: [Number, String, Array],
            default: 0
        }
    });

    const normalizeGutter = value => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : 0;
    };

    const rowStyle = computed(() => {
        const [horizontal, vertical] = Array.isArray(props.gutter)
            ? [normalizeGutter(props.gutter[0]), normalizeGutter(props.gutter[1])]
            : [normalizeGutter(props.gutter), 0];

        return {
            '--nn-row-gutter-x': `${horizontal}px`,
            '--nn-row-gutter-y': `${vertical}px`,
            marginLeft: horizontal ? `${horizontal / -2}px` : undefined,
            marginRight: horizontal ? `${horizontal / -2}px` : undefined,
            rowGap: vertical ? `${vertical}px` : undefined
        };
    });
</script>

<style scoped>
    .nn-row {
        display: flex;
        flex-flow: row wrap;
        min-width: 0;
    }
</style>
