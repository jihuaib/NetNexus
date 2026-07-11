<template>
    <span ref="rootRef" class="nn-popconfirm">
        <span
            ref="triggerRef"
            class="nn-popconfirm-trigger"
            aria-haspopup="dialog"
            :aria-controls="open ? popupId : undefined"
            :aria-expanded="open ? 'true' : 'false'"
            @click.stop="toggleOpen"
        >
            <slot />
        </span>
        <Teleport to="body">
            <span
                v-if="open"
                :id="popupId"
                ref="popupRef"
                class="nn-popconfirm-popup"
                :class="`nn-popconfirm-popup-${resolvedPlacement}`"
                :style="popupStyle"
                role="dialog"
                :aria-label="title || '确认操作'"
                tabindex="-1"
                @click.stop
            >
                <span class="nn-popconfirm-arrow" />
                <span class="nn-popconfirm-title">{{ title }}</span>
                <span class="nn-popconfirm-actions">
                    <NnButton size="small" @click="handleCancel">{{ cancelText }}</NnButton>
                    <NnButton type="primary" size="small" @click="handleConfirm">{{ okText }}</NnButton>
                </span>
            </span>
        </Teleport>
    </span>
</template>

<script setup>
    import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
    import NnButton from './NnButton.vue';

    const props = defineProps({
        title: {
            type: String,
            default: ''
        },
        okText: {
            type: String,
            default: '确定'
        },
        cancelText: {
            type: String,
            default: '取消'
        }
    });

    const emit = defineEmits(['confirm', 'cancel', 'openChange']);

    const rootRef = ref(null);
    const triggerRef = ref(null);
    const popupRef = ref(null);
    const open = ref(false);
    const resolvedPlacement = ref('bottom');
    const popupPosition = ref({ top: 0, left: 0, arrowX: 0 });
    const popupId = `nn-popconfirm-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const viewportMargin = 8;
    const popupGap = 10;
    const arrowMargin = 10;
    let lastFocusedElement = null;

    const popupStyle = computed(() => ({
        top: `${popupPosition.value.top}px`,
        left: `${popupPosition.value.left}px`,
        '--nn-popconfirm-arrow-x': `${popupPosition.value.arrowX}px`
    }));

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

    const updatePopupPosition = async () => {
        await nextTick();

        if (!open.value) return;

        const trigger = triggerRef.value;
        const popup = popupRef.value;
        if (!trigger || !popup) return;

        const triggerRect = trigger.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        const availableBelow = window.innerHeight - triggerRect.bottom - viewportMargin - popupGap;
        const availableAbove = triggerRect.top - viewportMargin - popupGap;
        const placement = popupRect.height > availableBelow && availableAbove > availableBelow ? 'top' : 'bottom';
        const triggerCenterX = triggerRect.left + triggerRect.width / 2;
        let top = placement === 'top' ? triggerRect.top - popupRect.height - popupGap : triggerRect.bottom + popupGap;
        let left = triggerRect.right - popupRect.width;
        const maxLeft = Math.max(viewportMargin, window.innerWidth - popupRect.width - viewportMargin);
        const maxTop = Math.max(viewportMargin, window.innerHeight - popupRect.height - viewportMargin);

        left = clamp(left, viewportMargin, maxLeft);
        top = clamp(top, viewportMargin, maxTop);

        popupPosition.value = {
            top: Math.round(top),
            left: Math.round(left),
            arrowX: Math.round(
                clamp(triggerCenterX - left, arrowMargin, Math.max(arrowMargin, popupRect.width - arrowMargin))
            )
        };
        resolvedPlacement.value = placement;
    };

    const focusPopup = async () => {
        await nextTick();
        popupRef.value?.focus({ preventScroll: true });
    };

    const restoreTriggerFocus = async () => {
        await nextTick();

        if (lastFocusedElement?.isConnected) {
            lastFocusedElement.focus({ preventScroll: true });
        }
    };

    const setOpen = (nextOpen, restoreFocus = false) => {
        if (open.value === nextOpen) return;

        if (nextOpen) {
            lastFocusedElement = document.activeElement;
        }

        open.value = nextOpen;
        emit('openChange', nextOpen);

        if (nextOpen) {
            updatePopupPosition();
            focusPopup();
        } else if (restoreFocus) {
            restoreTriggerFocus();
        }
    };

    const toggleOpen = () => {
        setOpen(!open.value);
    };

    const handleConfirm = event => {
        emit('confirm', event);
        setOpen(false, true);
    };

    const handleCancel = event => {
        emit('cancel', event);
        setOpen(false, true);
    };

    const handleDocumentPointerDown = event => {
        if (
            open.value &&
            rootRef.value &&
            !rootRef.value.contains(event.target) &&
            !popupRef.value?.contains(event.target)
        ) {
            setOpen(false);
        }
    };

    const handleDocumentKeydown = event => {
        if (open.value && event.key === 'Escape') {
            event.preventDefault();
            setOpen(false, true);
        }
    };

    watch(
        [() => props.title, () => props.okText, () => props.cancelText],
        () => {
            if (open.value) updatePopupPosition();
        },
        { flush: 'post' }
    );

    onMounted(() => {
        document.addEventListener('pointerdown', handleDocumentPointerDown);
        document.addEventListener('keydown', handleDocumentKeydown);
        window.addEventListener('resize', updatePopupPosition);
        window.addEventListener('scroll', updatePopupPosition, true);
    });

    onBeforeUnmount(() => {
        document.removeEventListener('pointerdown', handleDocumentPointerDown);
        document.removeEventListener('keydown', handleDocumentKeydown);
        window.removeEventListener('resize', updatePopupPosition);
        window.removeEventListener('scroll', updatePopupPosition, true);
    });
</script>

<style scoped>
    .nn-popconfirm {
        position: relative;
        display: inline-flex;
        max-width: 100%;
        vertical-align: middle;
    }

    .nn-popconfirm-trigger {
        display: inline-flex;
        max-width: 100%;
    }

    .nn-popconfirm-popup {
        position: fixed;
        z-index: 1060;
        display: grid;
        gap: 10px;
        width: max-content;
        min-width: 180px;
        max-width: min(280px, 80vw);
        padding: 12px;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        outline: none;
        background: var(--nn-color-bg-elevated);
        color: var(--nn-color-text);
        box-shadow: var(--nn-shadow-floating);
        font-size: 14px;
        line-height: 1.45;
    }

    .nn-popconfirm-arrow {
        position: absolute;
        left: var(--nn-popconfirm-arrow-x);
        width: 10px;
        height: 10px;
        background: var(--nn-color-bg-elevated);
        transform: translateX(-50%) rotate(45deg);
    }

    .nn-popconfirm-popup-bottom .nn-popconfirm-arrow {
        top: -5px;
        border-top: 1px solid var(--nn-color-border-light);
        border-left: 1px solid var(--nn-color-border-light);
    }

    .nn-popconfirm-popup-top .nn-popconfirm-arrow {
        bottom: -5px;
        border-right: 1px solid var(--nn-color-border-light);
        border-bottom: 1px solid var(--nn-color-border-light);
    }

    .nn-popconfirm-title {
        display: block;
        color: var(--nn-color-text);
        overflow-wrap: anywhere;
    }

    .nn-popconfirm-actions {
        display: inline-flex;
        justify-content: flex-end;
        gap: 8px;
    }
</style>
