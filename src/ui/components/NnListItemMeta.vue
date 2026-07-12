<template>
    <div class="nn-list-item-meta">
        <div v-if="$slots.avatar" class="nn-list-item-meta-avatar">
            <slot name="avatar" />
        </div>
        <div class="nn-list-item-meta-content">
            <div v-if="$slots.title" class="nn-list-item-meta-title">
                <slot name="title" />
            </div>
            <div v-if="$slots.description" class="nn-list-item-meta-description">
                <slot name="description" />
            </div>
        </div>
    </div>
</template>

<style scoped>
    .nn-list-item-meta {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        min-width: 0;
    }

    .nn-list-item-meta-avatar {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        color: var(--nn-color-success);
    }

    .nn-list-item-meta-content {
        min-width: 0;
    }

    .nn-list-item-meta-title {
        color: var(--nn-color-text);
        font-size: 14px;
        line-height: 1.5;
    }

    .nn-list-item-meta-description {
        color: var(--nn-color-text-secondary);
        font-size: 13px;
        line-height: 1.5;
    }
</style>
