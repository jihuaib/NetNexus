<template>
    <Teleport to="body">
        <Transition name="nn-modal-fade" @after-leave="handleAfterLeave" @leave-cancelled="handleLeaveCancelled">
            <div v-if="hasOpened" v-show="open" class="nn-modal-root" :style="layerStyle">
                <div class="nn-modal-mask" aria-hidden="true" />
                <div
                    class="nn-modal-wrap"
                    :class="[wrapClassName, { 'nn-modal-wrap-top': !centered }]"
                    @click.self="handleMaskClick"
                >
                    <div
                        ref="positionerRef"
                        class="nn-modal-positioner"
                        :class="{ 'nn-modal-positioner-dragging': dragging }"
                    >
                        <section
                            ref="dialogRef"
                            v-bind="forwardedAttrs"
                            class="nn-modal"
                            :class="attrs.class"
                            :style="[modalStyle, attrs.style]"
                            role="dialog"
                            aria-modal="true"
                            :aria-labelledby="attrs['aria-labelledby'] || (hasTitle ? titleId : undefined)"
                            :aria-label="attrs['aria-label'] || (!hasTitle ? '对话框' : undefined)"
                            tabindex="-1"
                        >
                            <div class="nn-modal-content">
                                <header
                                    v-if="hasTitle || closable"
                                    class="nn-modal-header"
                                    :class="{
                                        'nn-modal-header-draggable': draggable,
                                        'nn-modal-header-dragging': dragging
                                    }"
                                    @pointerdown="startDrag"
                                >
                                    <div v-if="hasTitle" :id="titleId" class="nn-modal-title">
                                        <slot name="title">
                                            <NnRenderContent :content="title" />
                                        </slot>
                                    </div>
                                    <button
                                        v-if="closable"
                                        class="nn-modal-close"
                                        type="button"
                                        aria-label="关闭"
                                        @pointerdown.stop
                                        @click="requestCancel"
                                    >
                                        <span aria-hidden="true">×</span>
                                    </button>
                                </header>

                                <div class="nn-modal-body" :style="bodyStyle">
                                    <slot />
                                </div>

                                <footer v-if="showFooter" class="nn-modal-footer">
                                    <slot v-if="slots.footer" name="footer" />
                                    <NnRenderContent v-else-if="footer !== undefined" :content="footer" />
                                    <template v-else>
                                        <NnButton @click="requestCancel">
                                            {{ cancelText }}
                                        </NnButton>
                                        <NnButton type="primary" :loading="confirmLoading" @click="handleOk">
                                            {{ okText }}
                                        </NnButton>
                                    </template>
                                </footer>
                            </div>
                        </section>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<script setup>
    import { computed, nextTick, onBeforeUnmount, onMounted, ref, useAttrs, useId, useSlots, watch } from 'vue';
    import NnButton from './NnButton.vue';
    import NnRenderContent from './NnRenderContent';

    defineOptions({
        name: 'NnModal',
        inheritAttrs: false
    });

    const props = defineProps({
        open: {
            type: Boolean,
            default: false
        },
        title: {
            type: [String, Number, Object, Array, Function],
            default: ''
        },
        footer: {
            type: [String, Number, Boolean, Object, Array, Function],
            default: undefined
        },
        width: {
            type: [String, Number],
            default: 520
        },
        height: {
            type: [String, Number],
            default: undefined
        },
        bodyStyle: {
            type: [Object, Array, String],
            default: () => ({})
        },
        wrapClassName: {
            type: [String, Array, Object],
            default: ''
        },
        zIndex: {
            type: [Number, String],
            default: 1000
        },
        maskClosable: {
            type: Boolean,
            default: false
        },
        keyboard: {
            type: Boolean,
            default: true
        },
        closable: {
            type: Boolean,
            default: true
        },
        centered: {
            type: Boolean,
            default: true
        },
        draggable: {
            type: Boolean,
            default: true
        },
        confirmLoading: {
            type: Boolean,
            default: false
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

    const emit = defineEmits(['update:open', 'ok', 'cancel']);
    const attrs = useAttrs();
    const slots = useSlots();
    const positionerRef = ref(null);
    const dialogRef = ref(null);
    const hasOpened = ref(props.open);
    const dragging = ref(false);
    const titleId = `nn-modal-title-${useId()}`;
    const overlayToken = Symbol('nn-modal');
    const previousFocus = ref(null);
    let overlayActive = false;
    let dragOrigin = null;
    let dragOffset = { x: 0, y: 0 };
    let pendingDragOffset = null;
    let dragFrameId = 0;
    let activePointerId = null;
    let dragCaptureTarget = null;

    const DRAG_VIEWPORT_MARGIN = 8;

    const hasTitle = computed(
        () => Boolean(slots.title) || (props.title !== '' && props.title !== null && props.title !== undefined)
    );
    const showFooter = computed(() => props.footer !== null);
    const layerStyle = computed(() => ({
        zIndex: Number.isFinite(Number(props.zIndex)) ? Number(props.zIndex) : 1000
    }));

    const normalizeSize = value => {
        if (value === undefined || value === null || value === '') {
            return undefined;
        }
        if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value).trim())) {
            return `${Number(value)}px`;
        }
        return String(value);
    };

    const modalStyle = computed(() => ({
        width: normalizeSize(props.width),
        height: normalizeSize(props.height)
    }));

    const forwardedAttrs = computed(() => {
        const { class: _class, style: _style, ...rest } = attrs;
        return rest;
    });

    const canUseDom = () => typeof window !== 'undefined' && typeof document !== 'undefined';

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

    const applyDragOffset = offset => {
        dragOffset = offset;
        if (positionerRef.value) {
            positionerRef.value.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
        }
    };

    const flushPendingDrag = () => {
        if (dragFrameId && canUseDom()) {
            window.cancelAnimationFrame(dragFrameId);
            dragFrameId = 0;
        }
        if (!pendingDragOffset) return;
        const nextOffset = pendingDragOffset;
        pendingDragOffset = null;
        applyDragOffset(nextOffset);
    };

    const scheduleDragOffset = offset => {
        pendingDragOffset = offset;
        if (dragFrameId) return;
        dragFrameId = window.requestAnimationFrame(() => {
            dragFrameId = 0;
            if (!pendingDragOffset) return;
            const nextOffset = pendingDragOffset;
            pendingDragOffset = null;
            applyDragOffset(nextOffset);
        });
    };

    const stopDrag = event => {
        if (event?.pointerId !== undefined && activePointerId !== null && event.pointerId !== activePointerId) return;
        if (!dragging.value && !dragOrigin && !pendingDragOffset && !dragFrameId) return;

        flushPendingDrag();
        dragging.value = false;
        dragOrigin = null;
        if (dragCaptureTarget && activePointerId !== null) {
            try {
                if (dragCaptureTarget.hasPointerCapture?.(activePointerId)) {
                    dragCaptureTarget.releasePointerCapture(activePointerId);
                }
            } catch (_error) {
                // Pointer capture can already be released by the browser on pointerup/cancel.
            }
        }
        dragCaptureTarget = null;
        activePointerId = null;
        document.removeEventListener('pointermove', handleDragMove);
        document.removeEventListener('pointerup', stopDrag);
        document.removeEventListener('pointercancel', stopDrag);
    };

    const handleDragMove = event => {
        if (
            !dragging.value ||
            !dragOrigin ||
            !dialogRef.value ||
            (activePointerId !== null && event.pointerId !== activePointerId)
        ) {
            return;
        }

        const deltaX = event.clientX - dragOrigin.pointerX;
        const deltaY = event.clientY - dragOrigin.pointerY;
        const minDeltaX = DRAG_VIEWPORT_MARGIN - dragOrigin.rect.left;
        const maxDeltaX = dragOrigin.viewportWidth - DRAG_VIEWPORT_MARGIN - dragOrigin.rect.right;
        const minDeltaY = DRAG_VIEWPORT_MARGIN - dragOrigin.rect.top;
        const maxDeltaY = dragOrigin.viewportHeight - DRAG_VIEWPORT_MARGIN - dragOrigin.rect.bottom;

        scheduleDragOffset({
            x: Math.round(dragOrigin.offsetX + clamp(deltaX, minDeltaX, maxDeltaX)),
            y: Math.round(dragOrigin.offsetY + clamp(deltaY, minDeltaY, maxDeltaY))
        });
    };

    const startDrag = event => {
        if (
            !props.draggable ||
            event.button !== 0 ||
            event.isPrimary === false ||
            !dialogRef.value ||
            event.target.closest('button, a, input, textarea, select, [role="button"], [data-nn-no-drag]')
        ) {
            return;
        }

        event.preventDefault();
        stopDrag();
        const rect = dialogRef.value.getBoundingClientRect();
        dragOrigin = {
            pointerX: event.clientX,
            pointerY: event.clientY,
            offsetX: dragOffset.x,
            offsetY: dragOffset.y,
            rect,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight
        };
        activePointerId = event.pointerId;
        dragCaptureTarget = event.currentTarget;
        try {
            dragCaptureTarget?.setPointerCapture?.(event.pointerId);
        } catch (_error) {
            // Document listeners remain the fallback when pointer capture is unavailable.
        }
        dragging.value = true;
        document.addEventListener('pointermove', handleDragMove);
        document.addEventListener('pointerup', stopDrag);
        document.addEventListener('pointercancel', stopDrag);
    };

    const resetDragPosition = () => {
        stopDrag();
        applyDragOffset({ x: 0, y: 0 });
    };

    const keepModalInViewport = async () => {
        if (!props.open || !dialogRef.value) {
            return;
        }

        await nextTick();
        if (dragging.value) stopDrag();
        const rect = dialogRef.value?.getBoundingClientRect();
        if (!rect) {
            return;
        }

        let correctionX = 0;
        let correctionY = 0;
        if (rect.left < DRAG_VIEWPORT_MARGIN) correctionX = DRAG_VIEWPORT_MARGIN - rect.left;
        else if (rect.right > window.innerWidth - DRAG_VIEWPORT_MARGIN) {
            correctionX = window.innerWidth - DRAG_VIEWPORT_MARGIN - rect.right;
        }
        if (rect.top < DRAG_VIEWPORT_MARGIN) correctionY = DRAG_VIEWPORT_MARGIN - rect.top;
        else if (rect.bottom > window.innerHeight - DRAG_VIEWPORT_MARGIN) {
            correctionY = window.innerHeight - DRAG_VIEWPORT_MARGIN - rect.bottom;
        }

        if (correctionX || correctionY) {
            applyDragOffset({
                x: Math.round(dragOffset.x + correctionX),
                y: Math.round(dragOffset.y + correctionY)
            });
        }
    };

    const getOverlayState = () => {
        const stateKey = '__NETNEXUS_UI_OVERLAY_STATE__';
        if (!globalThis[stateKey]) {
            globalThis[stateKey] = {
                stack: [],
                lockCount: 0,
                bodyOverflow: '',
                bodyPaddingRight: ''
            };
        }
        return globalThis[stateKey];
    };

    const lockBodyScroll = state => {
        if (!canUseDom()) {
            return;
        }
        if (state.lockCount === 0) {
            const body = document.body;
            const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
            state.bodyOverflow = body.style.overflow;
            state.bodyPaddingRight = body.style.paddingRight;
            body.style.overflow = 'hidden';
            if (scrollbarWidth > 0) {
                const currentPadding = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;
                body.style.paddingRight = `${currentPadding + scrollbarWidth}px`;
            }
        }
        state.lockCount += 1;
    };

    const unlockBodyScroll = state => {
        if (!canUseDom() || state.lockCount <= 0) {
            return;
        }
        state.lockCount -= 1;
        if (state.lockCount === 0) {
            document.body.style.overflow = state.bodyOverflow;
            document.body.style.paddingRight = state.bodyPaddingRight;
        }
    };

    const activateOverlay = () => {
        if (!canUseDom() || overlayActive) {
            return false;
        }
        const state = getOverlayState();
        overlayActive = true;
        previousFocus.value = document.activeElement;
        state.stack.push(overlayToken);
        lockBodyScroll(state);
        return true;
    };

    const deactivateOverlay = () => {
        if (!overlayActive) {
            return false;
        }
        const state = getOverlayState();
        const index = state.stack.lastIndexOf(overlayToken);
        if (index >= 0) {
            state.stack.splice(index, 1);
        }
        overlayActive = false;
        unlockBodyScroll(state);
        return true;
    };

    const isTopOverlay = () => {
        const stack = getOverlayState().stack;
        return stack[stack.length - 1] === overlayToken;
    };

    const focusableSelector = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    const getFocusableElements = () =>
        Array.from(dialogRef.value?.querySelectorAll(focusableSelector) || []).filter(
            element => element.getAttribute('aria-hidden') !== 'true'
        );

    const focusDialog = () => {
        nextTick(() => {
            const autofocusTarget = dialogRef.value?.querySelector('[autofocus]');
            const target = autofocusTarget || getFocusableElements()[0] || dialogRef.value;
            target?.focus?.({ preventScroll: true });
        });
    };

    const restoreFocus = () => {
        const target = previousFocus.value;
        previousFocus.value = null;
        nextTick(() => {
            if (target?.isConnected) {
                target.focus?.({ preventScroll: true });
            }
        });
    };

    const requestCancel = event => {
        emit('cancel', event);
        emit('update:open', false);
    };

    const handleMaskClick = event => {
        if (props.maskClosable) {
            requestCancel(event);
        }
    };

    const handleOk = event => {
        if (!props.confirmLoading) {
            emit('ok', event);
        }
    };

    const trapFocus = event => {
        const focusable = getFocusableElements();
        if (focusable.length === 0) {
            event.preventDefault();
            dialogRef.value?.focus?.();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (
            event.shiftKey &&
            (document.activeElement === first || !dialogRef.value?.contains(document.activeElement))
        ) {
            event.preventDefault();
            last.focus();
        } else if (
            !event.shiftKey &&
            (document.activeElement === last || !dialogRef.value?.contains(document.activeElement))
        ) {
            event.preventDefault();
            first.focus();
        }
    };

    const handleDocumentKeydown = event => {
        if (!props.open || !isTopOverlay()) {
            return;
        }
        if (event.key === 'Escape' && props.keyboard && !event.repeat) {
            event.preventDefault();
            requestCancel(event);
        } else if (event.key === 'Tab') {
            trapFocus(event);
        }
    };

    const finishOverlayClose = () => {
        if (!props.open && deactivateOverlay()) {
            restoreFocus();
        }
    };

    const handleAfterLeave = () => {
        finishOverlayClose();
    };

    const handleLeaveCancelled = () => {
        if (props.open) {
            activateOverlay();
        }
    };

    watch(
        () => props.open,
        open => {
            if (open) {
                hasOpened.value = true;
                resetDragPosition();
                activateOverlay();
                focusDialog();
            } else {
                stopDrag();
            }
        },
        { immediate: true }
    );

    onMounted(() => {
        document.addEventListener('keydown', handleDocumentKeydown);
        window.addEventListener('resize', keepModalInViewport);
    });

    onBeforeUnmount(() => {
        stopDrag();
        document.removeEventListener('keydown', handleDocumentKeydown);
        window.removeEventListener('resize', keepModalInViewport);
        if (deactivateOverlay()) {
            restoreFocus();
        }
    });
</script>

<style scoped>
    .nn-modal-root {
        position: fixed;
        inset: 0;
        pointer-events: none;
    }

    .nn-modal-mask {
        position: absolute;
        inset: 0;
        z-index: 0;
        background: rgba(15, 23, 42, 0.48);
        pointer-events: auto;
    }

    .nn-modal-wrap {
        position: absolute;
        inset: 0;
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: auto;
        padding: 16px;
        pointer-events: auto;
    }

    .nn-modal-wrap-top {
        align-items: flex-start;
    }

    .nn-modal-positioner {
        max-width: 100%;
        max-height: 100%;
    }

    .nn-modal-positioner-dragging {
        will-change: transform;
    }

    .nn-modal {
        position: relative;
        max-width: calc(100vw - 32px);
        max-height: calc(100vh - 48px);
        margin: 0 auto;
        color: var(--nn-color-text);
        outline: none;
    }

    .nn-modal-content {
        display: flex;
        max-height: inherit;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 8px;
        background: var(--nn-color-bg-elevated);
        box-shadow: var(--nn-shadow-floating);
    }

    .nn-modal-header {
        display: flex;
        min-height: 52px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-elevated);
    }

    .nn-modal-header-draggable {
        cursor: move;
        touch-action: none;
        user-select: none;
    }

    .nn-modal-header-dragging {
        cursor: grabbing;
    }

    .nn-modal-title {
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-size: 16px;
        font-weight: 600;
        line-height: 1.4;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .nn-modal-close {
        display: inline-flex;
        width: 28px;
        height: 28px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--nn-color-text-muted);
        cursor: pointer;
        font: inherit;
        font-size: 22px;
        line-height: 1;
    }

    .nn-modal-close:hover {
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-text);
    }

    .nn-modal-close:focus-visible {
        box-shadow: var(--nn-focus-shadow-primary);
        outline: none;
    }

    .nn-modal-body {
        min-width: 0;
        min-height: 0;
        flex: 1 1 auto;
        overflow: auto;
        padding: 16px;
        color: var(--nn-color-text);
        background: var(--nn-color-bg-elevated);
    }

    .nn-modal-footer {
        display: flex;
        min-height: 52px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        padding: 10px 16px;
        border-top: 1px solid var(--nn-color-border-light);
        background: var(--nn-color-bg-elevated);
    }

    .nn-modal-fade-enter-active,
    .nn-modal-fade-leave-active {
        transition: opacity 0.16s ease;
    }

    .nn-modal-fade-enter-from,
    .nn-modal-fade-leave-to {
        opacity: 0;
    }

    @media (prefers-reduced-motion: reduce) {
        .nn-modal-fade-enter-active,
        .nn-modal-fade-leave-active {
            transition: none;
        }
    }
</style>
