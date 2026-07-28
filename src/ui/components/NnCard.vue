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
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 40px;
        overflow: hidden;
        padding: 0 10px;
        background: var(--nn-color-bg-card-head);
        border-bottom: none;
        border-radius: 8px 8px 0 0;
    }

    .nn-card-head-title {
        flex: 1 1 auto;
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
        display: flex;
        min-width: 0;
        flex: 0 1 auto;
        align-items: center;
        color: var(--nn-color-text-inverse);
    }

    .nn-card-extra :deep(.nn-space) {
        gap: 6px !important;
    }

    .nn-card-extra :deep(.nn-button) {
        min-width: 24px !important;
        height: 24px !important;
        padding: 0 7px !important;
        border-color: var(--nn-color-border-card-head-ghost) !important;
        border-radius: 4px !important;
        background: var(--nn-color-bg-card-head-ghost) !important;
        color: var(--nn-color-text-card-head-ghost) !important;
        font-size: 12px !important;
    }

    .nn-card-extra :deep(.nn-button:hover:not(.nn-button-disabled)) {
        border-color: var(--nn-color-border-card-head-ghost) !important;
        background: var(--nn-color-bg-card-head-ghost-hover) !important;
        color: var(--nn-color-text-card-head-ghost) !important;
    }

    .nn-card-extra :deep(.nn-button:focus-visible) {
        outline: 2px solid var(--nn-color-text-inverse) !important;
        outline-offset: 1px;
        box-shadow: var(--nn-shadow-card-head-control) !important;
    }

    .nn-card-extra :deep(.nn-button-primary:not(.nn-button-danger)) {
        border-color: var(--nn-color-border-card-head-control) !important;
        background: var(--nn-color-bg-card-head-control) !important;
        color: var(--nn-color-text-card-head-control) !important;
        box-shadow: var(--nn-shadow-card-head-control) !important;
    }

    .nn-card-extra :deep(.nn-button-primary:hover:not(.nn-button-danger):not(.nn-button-disabled)) {
        border-color: var(--nn-color-border-card-head-control) !important;
        background: var(--nn-color-bg-card-head-control-hover) !important;
        color: var(--nn-color-text-card-head-control) !important;
    }

    .nn-card-extra :deep(.nn-button-danger) {
        border-color: #fecaca !important;
        background: #fff1f2 !important;
        color: #b42318 !important;
        box-shadow: var(--nn-shadow-card-head-control) !important;
    }

    .nn-card-extra :deep(.nn-button-danger:hover:not(.nn-button-disabled)) {
        border-color: #fda4af !important;
        background: #ffe4e6 !important;
        color: #991b1b !important;
    }

    .nn-card-extra :deep(.nn-button-icon-only) {
        width: 24px !important;
        padding-inline: 0 !important;
    }

    .nn-card-extra :deep(.nn-button-icon .nn-icon) {
        width: 14px;
        height: 14px;
        color: currentcolor !important;
        font-size: 14px;
    }

    .nn-card-extra :deep(.nn-button-icon + .nn-button-content) {
        margin-left: 5px;
    }

    .nn-card-extra :deep(.nn-card-head-pill) {
        display: inline-flex;
        min-height: 24px;
        align-items: center;
        padding: 2px 8px;
        border: 1px solid var(--nn-color-border-card-head-ghost);
        border-radius: 999px;
        background: var(--nn-color-bg-card-head-ghost);
        color: var(--nn-color-text-card-head-ghost);
        font-size: 12px;
        line-height: 18px;
        white-space: nowrap;
    }

    .nn-card-extra :deep(.nn-card-head-pill .nn-switch) {
        background: var(--nn-color-bg-card-head-ghost-hover) !important;
        box-shadow: inset 0 0 0 1px var(--nn-color-border-card-head-ghost) !important;
    }

    .nn-card-extra :deep(.nn-card-head-pill .nn-switch .nn-switch-handle) {
        background: var(--nn-color-text-card-head-control);
    }

    .nn-card-extra :deep(.nn-card-head-pill .nn-switch-checked) {
        background: var(--nn-color-bg-card-head-control) !important;
        box-shadow: inset 0 0 0 1px var(--nn-color-primary-hover) !important;
    }

    .nn-card-extra :deep(.nn-card-head-pill .nn-switch-checked .nn-switch-handle) {
        background: var(--nn-color-primary-active);
    }

    .nn-card-extra :deep(.nn-card-head-pill .nn-switch:focus-visible) {
        outline: 2px solid var(--nn-color-text-inverse);
        outline-offset: 1px;
    }

    .nn-card-extra :deep(.nn-tag) {
        gap: 5px;
        height: 24px;
        min-height: 24px;
        margin-inline-end: 0;
        padding: 0 7px;
        border-color: var(--nn-color-border-card-head-control);
        background: var(--nn-color-bg-card-head-control);
        color: var(--nn-color-text-card-head-control);
        box-shadow: var(--nn-shadow-card-head-control);
        line-height: 22px;
    }

    .nn-card-extra :deep(.nn-tag::before) {
        width: 6px;
        height: 6px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: currentcolor;
        content: '';
    }

    .nn-card-extra :deep(.nn-tag-blue),
    .nn-card-extra :deep(.nn-tag-processing),
    .nn-card-extra :deep(.nn-tag-cyan) {
        border-color: #91caff;
        background: #e6f4ff;
        color: #0958d9;
    }

    .nn-card-extra :deep(.nn-tag-green),
    .nn-card-extra :deep(.nn-tag-success) {
        border-color: #95de64;
        background: #f6ffed;
        color: #237804;
    }

    .nn-card-extra :deep(.nn-tag-red),
    .nn-card-extra :deep(.nn-tag-error) {
        border-color: #ffa39e;
        background: #fff1f0;
        color: #b42318;
    }

    .nn-card-extra :deep(.nn-tag-orange),
    .nn-card-extra :deep(.nn-tag-warning) {
        border-color: #ffd591;
        background: #fff7e6;
        color: #ad4e00;
    }

    .nn-card-extra :deep(.nn-tag-purple) {
        border-color: #d3adf7;
        background: #f9f0ff;
        color: #531dab;
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
