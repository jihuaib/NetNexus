<template>
    <div class="nn-col" :style="colStyle">
        <slot />
    </div>
</template>

<script setup>
    import { computed } from 'vue';

    const props = defineProps({
        span: {
            type: [Number, String],
            default: undefined
        },
        xs: {
            type: [Number, String],
            default: undefined
        },
        sm: {
            type: [Number, String],
            default: undefined
        },
        md: {
            type: [Number, String],
            default: undefined
        },
        lg: {
            type: [Number, String],
            default: undefined
        },
        xl: {
            type: [Number, String],
            default: undefined
        }
    });

    const toBasis = value => {
        const span = Number(value);
        if (!Number.isFinite(span)) {
            return undefined;
        }

        const clamped = Math.min(Math.max(span, 0), 24);
        return `${(clamped / 24) * 100}%`;
    };

    const setBasis = (style, key, value) => {
        const basis = toBasis(value);
        if (basis) {
            style[key] = basis;
        }
    };

    const colStyle = computed(() => {
        const style = {};
        setBasis(style, '--nn-col-base', props.span ?? props.xs ?? 24);
        setBasis(style, '--nn-col-xs', props.xs);
        setBasis(style, '--nn-col-sm', props.sm);
        setBasis(style, '--nn-col-md', props.md);
        setBasis(style, '--nn-col-lg', props.lg);
        setBasis(style, '--nn-col-xl', props.xl);
        return style;
    });
</script>

<style scoped>
    .nn-col {
        position: relative;
        max-width: var(--nn-col-base, 100%);
        min-height: 1px;
        flex: 0 0 var(--nn-col-base, 100%);
        padding-right: calc(var(--nn-row-gutter-x, 0px) / 2);
        padding-left: calc(var(--nn-row-gutter-x, 0px) / 2);
    }

    @media (max-width: 575px) {
        .nn-col {
            max-width: var(--nn-col-xs, var(--nn-col-base, 100%));
            flex-basis: var(--nn-col-xs, var(--nn-col-base, 100%));
        }
    }

    @media (min-width: 576px) {
        .nn-col {
            max-width: var(--nn-col-sm, var(--nn-col-xs, var(--nn-col-base, 100%)));
            flex-basis: var(--nn-col-sm, var(--nn-col-xs, var(--nn-col-base, 100%)));
        }
    }

    @media (min-width: 768px) {
        .nn-col {
            max-width: var(--nn-col-md, var(--nn-col-sm, var(--nn-col-xs, var(--nn-col-base, 100%))));
            flex-basis: var(--nn-col-md, var(--nn-col-sm, var(--nn-col-xs, var(--nn-col-base, 100%))));
        }
    }

    @media (min-width: 992px) {
        .nn-col {
            max-width: var(--nn-col-lg, var(--nn-col-md, var(--nn-col-sm, var(--nn-col-xs, var(--nn-col-base, 100%)))));
            flex-basis: var(
                --nn-col-lg,
                var(--nn-col-md, var(--nn-col-sm, var(--nn-col-xs, var(--nn-col-base, 100%))))
            );
        }
    }

    @media (min-width: 1200px) {
        .nn-col {
            max-width: var(
                --nn-col-xl,
                var(--nn-col-lg, var(--nn-col-md, var(--nn-col-sm, var(--nn-col-xs, var(--nn-col-base, 100%)))))
            );
            flex-basis: var(
                --nn-col-xl,
                var(--nn-col-lg, var(--nn-col-md, var(--nn-col-sm, var(--nn-col-xs, var(--nn-col-base, 100%)))))
            );
        }
    }
</style>
