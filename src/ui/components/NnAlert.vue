<template>
    <div class="nn-alert" :class="alertClass" role="alert">
        <span v-if="showIcon" class="nn-alert-icon" aria-hidden="true">{{ iconText }}</span>
        <div class="nn-alert-content">
            <div v-if="message || $slots.message" class="nn-alert-message">
                <slot name="message">{{ message }}</slot>
            </div>
            <div v-if="description || $slots.description || $slots.default" class="nn-alert-description">
                <slot name="description">
                    <slot>{{ description }}</slot>
                </slot>
            </div>
        </div>
    </div>
</template>

<script setup>
    import { computed } from 'vue';

    const props = defineProps({
        type: {
            type: String,
            default: 'info'
        },
        message: {
            type: [String, Number],
            default: ''
        },
        description: {
            type: [String, Number],
            default: ''
        },
        showIcon: {
            type: Boolean,
            default: false
        }
    });

    const safeType = computed(() => {
        const types = new Set(['success', 'info', 'warning', 'error']);
        return types.has(props.type) ? props.type : 'info';
    });

    const alertClass = computed(() => `nn-alert-${safeType.value}`);
    const iconText = computed(() => {
        const icons = {
            success: '✓',
            info: 'i',
            warning: '!',
            error: '!'
        };
        return icons[safeType.value];
    });
</script>

<style scoped>
    .nn-alert {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        padding: 8px 12px;
        color: var(--nn-color-text);
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-muted);
    }

    .nn-alert-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
        margin-top: 1px;
        border-radius: 50%;
        color: var(--nn-color-text-inverse);
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
    }

    .nn-alert-content {
        min-width: 0;
    }

    .nn-alert-message {
        color: var(--nn-color-text-strong);
        font-size: 14px;
        font-weight: 500;
        line-height: 1.5;
        overflow-wrap: anywhere;
        word-break: break-word;
    }

    .nn-alert-description {
        color: var(--nn-color-text-secondary);
        font-size: 13px;
        line-height: 1.6;
        overflow-wrap: anywhere;
        word-break: break-word;
    }

    .nn-alert-message + .nn-alert-description {
        margin-top: 2px;
    }

    .nn-alert-info {
        border-color: var(--nn-color-border-info);
        background: var(--nn-color-bg-info-subtle);
    }

    .nn-alert-success {
        border-color: var(--nn-color-success);
        background: var(--nn-color-bg-success-subtle);
    }

    .nn-alert-warning {
        border-color: var(--nn-color-warning);
        background: var(--nn-color-bg-warning-subtle);
    }

    .nn-alert-error {
        border-color: var(--nn-color-border-danger);
        background: var(--nn-color-bg-danger-subtle);
    }

    .nn-alert-info .nn-alert-icon {
        background: var(--nn-color-info);
    }

    .nn-alert-success .nn-alert-icon {
        background: var(--nn-color-success);
    }

    .nn-alert-warning .nn-alert-icon {
        background: var(--nn-color-warning);
    }

    .nn-alert-error .nn-alert-icon {
        background: var(--nn-color-error);
    }
</style>
