<template>
    <div class="nn-divider" :class="{ 'nn-divider-with-text': $slots.default }" role="separator">
        <span v-if="$slots.default" class="nn-divider-inner-text">
            <slot />
        </span>
    </div>
</template>

<style scoped>
    .nn-divider {
        display: flex;
        align-items: center;
        min-width: 0;
        margin: 5px 0;
        color: var(--nn-color-text-secondary);
        font-size: 12px;
        line-height: 1.5;
    }

    .nn-divider::before,
    .nn-divider::after {
        display: block;
        min-width: 0;
        height: 1px;
        flex: 1;
        background: var(--nn-color-border-light);
        content: '';
    }

    .nn-divider:not(.nn-divider-with-text)::after {
        display: none;
    }

    .nn-divider-inner-text {
        display: inline-block;
        padding: 0 12px;
        white-space: nowrap;
    }
</style>
