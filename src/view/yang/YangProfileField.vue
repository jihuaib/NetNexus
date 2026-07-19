<template>
    <div class="yang-profile-field" :data-testid="fieldTestId">
        <span class="yang-profile-label">Profile</span>
        <nn-select
            :value="value"
            :options="options"
            :loading="loading"
            placeholder="选择 Profile"
            aria-label="Profile"
            class="yang-profile-select"
            :data-testid="testId"
            @update:value="emit('update:value', $event)"
        />
    </div>
</template>

<script setup>
    import { computed } from 'vue';

    const props = defineProps({
        value: { type: String, default: '' },
        options: { type: Array, default: () => [] },
        loading: { type: Boolean, default: false },
        testId: { type: String, default: '' }
    });
    const emit = defineEmits(['update:value']);
    const fieldTestId = computed(() => (props.testId ? `${props.testId}-field` : undefined));
</script>

<style scoped>
    .yang-profile-field {
        display: flex;
        width: 280px;
        max-width: 100%;
        min-width: 0;
        flex: 0 1 280px;
        align-items: center;
        gap: 6px;
    }

    .yang-profile-label {
        flex: none;
        color: var(--nn-color-text-muted);
        font-size: 12px;
        white-space: nowrap;
    }

    .yang-profile-field :deep(.yang-profile-select) {
        width: auto;
        min-width: 0;
        flex: 1;
    }
</style>
