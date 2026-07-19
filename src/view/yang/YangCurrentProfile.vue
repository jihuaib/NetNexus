<template>
    <div class="yang-current-profile" :data-testid="testId" aria-label="当前 Profile">
        <span class="yang-current-profile-label">当前 Profile</span>
        <span class="yang-current-profile-value" :class="{ 'yang-current-profile-value-empty': !profileLabel }">
            {{ displayLabel }}
        </span>
    </div>
</template>

<script setup>
    import { computed } from 'vue';

    const props = defineProps({
        profile: { type: Object, default: null },
        loading: { type: Boolean, default: false },
        testId: { type: String, default: '' }
    });

    const profileLabel = computed(() => props.profile?.name || props.profile?.host || props.profile?.id || '');
    const displayLabel = computed(() => {
        if (props.loading && !profileLabel.value) return '加载中…';
        return profileLabel.value || '未连接';
    });
</script>

<style scoped>
    .yang-current-profile {
        display: inline-flex;
        max-width: min(280px, 100%);
        min-width: 0;
        align-items: center;
        gap: 6px;
    }

    .yang-current-profile-label {
        flex: none;
        color: var(--nn-color-text-muted);
        font-size: 12px;
        white-space: nowrap;
    }

    .yang-current-profile-value {
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-size: 12px;
        font-weight: 500;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .yang-current-profile-value-empty {
        color: var(--nn-color-text-muted);
        font-weight: 400;
    }
</style>
