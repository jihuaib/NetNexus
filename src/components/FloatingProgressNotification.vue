<template>
    <teleport to="body">
        <transition name="floating-slide-up">
            <div
                v-if="visible"
                :class="['floating-progress-notification', rootClass, `is-${status}`]"
                :role="status === 'error' || status === 'warning' ? 'alert' : 'status'"
                :aria-live="status === 'error' || status === 'warning' ? 'assertive' : 'polite'"
                aria-atomic="true"
                @click="$emit('click')"
            >
                <div class="notification-content">
                    <div class="notification-icon" aria-hidden="true">
                        <slot name="icon" />
                    </div>
                    <div class="notification-text">
                        <div class="notification-title">{{ title }}</div>
                        <div v-if="description" class="notification-description" :title="description">
                            {{ description }}
                        </div>
                        <div
                            v-if="showProgress"
                            class="progress-bar"
                            role="progressbar"
                            aria-label="任务进度"
                            aria-valuemin="0"
                            aria-valuemax="100"
                            :aria-valuenow="normalizedPercent"
                        >
                            <div class="progress-fill" :style="{ width: `${normalizedPercent}%` }" />
                        </div>
                    </div>
                    <div v-if="$slots.actions || closable" class="notification-actions" @click.stop>
                        <slot name="actions" />
                        <nn-button v-if="closable" size="small" @click="$emit('close')">关闭</nn-button>
                    </div>
                </div>
            </div>
        </transition>
    </teleport>
</template>

<script setup>
    import { computed } from 'vue';

    defineOptions({ name: 'FloatingProgressNotification' });

    const props = defineProps({
        visible: {
            type: Boolean,
            default: false
        },
        rootClass: {
            type: [String, Array, Object],
            default: ''
        },
        title: {
            type: String,
            default: ''
        },
        description: {
            type: String,
            default: ''
        },
        percent: {
            type: Number,
            default: 0
        },
        showProgress: {
            type: Boolean,
            default: false
        },
        status: {
            type: String,
            default: 'loading'
        },
        closable: {
            type: Boolean,
            default: true
        }
    });

    defineEmits(['click', 'close']);

    const normalizedPercent = computed(() => Math.max(0, Math.min(100, Math.round(props.percent || 0))));
</script>

<style scoped>
    .floating-progress-notification {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 9999;
        min-width: 300px;
        max-width: 400px;
        background: var(--nn-color-bg-elevated);
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        box-shadow: var(--nn-shadow-floating);
        cursor: pointer;
        transition: all 0.3s ease;
    }

    .floating-progress-notification:hover {
        box-shadow: var(--nn-shadow-floating-hover);
        transform: translateY(-2px);
    }

    .notification-content {
        display: flex;
        gap: 12px;
        align-items: flex-start;
        padding: 16px;
    }

    .notification-icon {
        flex-shrink: 0;
        margin-top: 2px;
        color: var(--nn-color-primary);
        font-size: 20px;
    }

    .notification-text {
        flex: 1;
        min-width: 0;
    }

    .notification-title {
        margin-bottom: 4px;
        color: var(--nn-color-text);
        font-weight: 500;
        font-size: 14px;
    }

    .notification-description {
        display: -webkit-box;
        margin-bottom: 8px;
        overflow: hidden;
        color: var(--nn-color-text-muted);
        font-size: 12px;
        line-height: 1.4;
        overflow-wrap: anywhere;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
    }

    .progress-bar {
        width: 100%;
        height: 4px;
        margin-top: 8px;
        overflow: hidden;
        background: var(--nn-color-bg-progress);
        border-radius: 2px;
    }

    .progress-fill {
        height: 100%;
        background: var(--nn-gradient-progress);
        border-radius: 2px;
        transition: width 0.2s ease;
    }

    .notification-actions {
        display: flex;
        flex-shrink: 0;
        gap: 8px;
    }

    .notification-actions :deep(.nn-button) {
        height: 24px;
        padding: 0 8px;
        font-size: 12px;
    }

    .floating-slide-up-enter-active,
    .floating-slide-up-leave-active {
        transition: all 0.3s ease;
    }

    .floating-slide-up-enter-from,
    .floating-slide-up-leave-to {
        opacity: 0;
        transform: translateY(100%);
    }

    .notification-icon :deep(.notification-icon-primary) {
        color: var(--nn-color-primary);
    }

    .notification-icon :deep(.notification-icon-success) {
        color: var(--nn-color-success);
    }

    .notification-icon :deep(.notification-icon-warning) {
        color: var(--nn-color-warning);
    }

    .notification-icon :deep(.notification-icon-error) {
        color: var(--nn-color-error);
    }

    @media (max-width: 480px) {
        .floating-progress-notification {
            right: 20px;
            left: 20px;
            min-width: 0;
            max-width: none;
        }
    }
</style>
