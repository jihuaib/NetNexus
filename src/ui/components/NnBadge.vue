<template>
    <span v-if="visible" class="nn-badge" :style="numberStyle">{{ displayCount }}</span>
</template>

<script setup>
    import { computed } from 'vue';

    const props = defineProps({
        count: {
            type: [Number, String],
            default: 0
        },
        overflowCount: {
            type: [Number, String],
            default: 99
        },
        showZero: {
            type: Boolean,
            default: false
        },
        numberStyle: {
            type: Object,
            default: () => ({})
        }
    });

    const numericCount = computed(() => Number(props.count));
    const visible = computed(() => {
        if (props.showZero) {
            return true;
        }

        return Number.isFinite(numericCount.value) ? numericCount.value !== 0 : Boolean(props.count);
    });
    const displayCount = computed(() => {
        const count = numericCount.value;
        const overflowCount = Number(props.overflowCount);

        if (Number.isFinite(count) && Number.isFinite(overflowCount) && count > overflowCount) {
            return `${overflowCount}+`;
        }

        return props.count;
    });
</script>

<style scoped>
    .nn-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 20px;
        height: 20px;
        padding: 0 6px;
        border-radius: 10px;
        background: var(--nn-color-error);
        color: var(--nn-color-text-inverse);
        font-size: 12px;
        font-weight: 500;
        line-height: 20px;
        white-space: nowrap;
    }
</style>
