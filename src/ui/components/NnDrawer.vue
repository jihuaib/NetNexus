<template>
    <Teleport to="body">
        <Transition name="nn-drawer-motion">
            <div
                v-if="hasOpened"
                v-show="open"
                class="nn-drawer"
                :class="[`nn-drawer-${safePlacement}`, attrs.class]"
                :style="[layerStyle, attrs.style]"
            >
                <div class="nn-drawer-mask" aria-hidden="true" @click="handleMaskClick" />
                <div
                    class="nn-drawer-content-wrapper"
                    :class="`nn-drawer-content-wrapper-${safePlacement}`"
                    :style="panelSizeStyle"
                >
                    <section
                        ref="dialogRef"
                        v-bind="forwardedAttrs"
                        class="nn-drawer-content"
                        role="dialog"
                        aria-modal="true"
                        :aria-labelledby="attrs['aria-labelledby'] || (hasTitle ? titleId : undefined)"
                        :aria-label="attrs['aria-label'] || (!hasTitle ? '抽屉面板' : undefined)"
                        tabindex="-1"
                    >
                        <header v-if="hasTitle || closable" class="nn-drawer-header">
                            <div v-if="hasTitle" :id="titleId" class="nn-drawer-title">
                                <slot name="title">
                                    <NnRenderContent :content="title" />
                                </slot>
                            </div>
                            <button
                                v-if="closable"
                                class="nn-drawer-close"
                                type="button"
                                aria-label="关闭"
                                @click="requestClose"
                            >
                                <span aria-hidden="true">×</span>
                            </button>
                        </header>

                        <div class="nn-drawer-body" :style="bodyStyle">
                            <slot />
                        </div>

                        <footer v-if="hasFooter" class="nn-drawer-footer" :style="footerStyle">
                            <slot v-if="slots.footer" name="footer" />
                            <NnRenderContent v-else :content="footer" />
                        </footer>
                    </section>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<script setup>
    import { computed, nextTick, onBeforeUnmount, onMounted, ref, useAttrs, useId, useSlots, watch } from 'vue';
    import NnRenderContent from './NnRenderContent';

    defineOptions({
        name: 'NnDrawer',
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
        width: {
            type: [String, Number],
            default: 378
        },
        height: {
            type: [String, Number],
            default: 378
        },
        placement: {
            type: String,
            default: 'right'
        },
        footer: {
            type: [String, Number, Boolean, Object, Array, Function],
            default: undefined
        },
        bodyStyle: {
            type: [Object, Array, String],
            default: () => ({})
        },
        footerStyle: {
            type: [Object, Array, String],
            default: () => ({})
        },
        zIndex: {
            type: [Number, String],
            default: 1000
        },
        maskClosable: {
            type: Boolean,
            default: true
        },
        keyboard: {
            type: Boolean,
            default: true
        },
        closable: {
            type: Boolean,
            default: true
        }
    });

    const emit = defineEmits(['update:open', 'close']);
    const attrs = useAttrs();
    const slots = useSlots();
    const dialogRef = ref(null);
    const hasOpened = ref(props.open);
    const titleId = `nn-drawer-title-${useId()}`;
    const overlayToken = Symbol('nn-drawer');
    const previousFocus = ref(null);
    let overlayActive = false;

    const safePlacement = computed(() =>
        ['left', 'right', 'top', 'bottom'].includes(props.placement) ? props.placement : 'right'
    );
    const hasTitle = computed(
        () => Boolean(slots.title) || (props.title !== '' && props.title !== null && props.title !== undefined)
    );
    const hasFooter = computed(() => Boolean(slots.footer) || (props.footer !== undefined && props.footer !== null));
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

    const panelSizeStyle = computed(() => {
        if (safePlacement.value === 'top' || safePlacement.value === 'bottom') {
            return { height: normalizeSize(props.height) };
        }
        return { width: normalizeSize(props.width) };
    });

    const forwardedAttrs = computed(() => {
        const { class: _class, style: _style, ...rest } = attrs;
        return rest;
    });

    const canUseDom = () => typeof window !== 'undefined' && typeof document !== 'undefined';

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

    const requestClose = event => {
        emit('close', event);
        emit('update:open', false);
    };

    const handleMaskClick = event => {
        if (props.maskClosable) {
            requestClose(event);
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
            requestClose(event);
        } else if (event.key === 'Tab') {
            trapFocus(event);
        }
    };

    watch(
        () => props.open,
        open => {
            if (open) {
                hasOpened.value = true;
                activateOverlay();
                focusDialog();
            } else if (deactivateOverlay()) {
                restoreFocus();
            }
        },
        { immediate: true }
    );

    onMounted(() => {
        document.addEventListener('keydown', handleDocumentKeydown);
    });

    onBeforeUnmount(() => {
        document.removeEventListener('keydown', handleDocumentKeydown);
        if (deactivateOverlay()) {
            restoreFocus();
        }
    });
</script>

<style scoped>
    .nn-drawer {
        --nn-drawer-panel-bg: var(--nn-color-bg-elevated);

        position: fixed;
        inset: 0;
        pointer-events: none;
    }

    .nn-drawer-mask {
        position: absolute;
        inset: 0;
        background: rgba(15, 23, 42, 0.48);
        backdrop-filter: blur(1px);
        pointer-events: auto;
    }

    .nn-drawer-content-wrapper {
        position: absolute;
        max-width: 100vw;
        max-height: 100vh;
        pointer-events: auto;
        transition: transform 0.2s ease;
    }

    .nn-drawer-content-wrapper-right {
        top: 0;
        right: 0;
        bottom: 0;
    }

    .nn-drawer-content-wrapper-left {
        top: 0;
        bottom: 0;
        left: 0;
    }

    .nn-drawer-content-wrapper-top {
        top: 0;
        right: 0;
        left: 0;
    }

    .nn-drawer-content-wrapper-bottom {
        right: 0;
        bottom: 0;
        left: 0;
    }

    .nn-drawer-content {
        display: flex;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--nn-color-border-light);
        background: var(--nn-drawer-panel-bg);
        color: var(--nn-color-text);
        box-shadow: var(--nn-shadow-floating);
        outline: none;
    }

    .nn-drawer-header {
        display: flex;
        min-height: 52px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--nn-color-border-light);
        background: var(--nn-drawer-panel-bg);
    }

    .nn-drawer-title {
        min-width: 0;
        overflow: hidden;
        color: var(--nn-color-text-strong);
        font-size: 16px;
        font-weight: 600;
        line-height: 1.4;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .nn-drawer-close {
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

    .nn-drawer-close:hover {
        background: var(--nn-color-bg-hover);
        color: var(--nn-color-text);
    }

    .nn-drawer-close:focus-visible {
        box-shadow: var(--nn-focus-shadow-primary);
        outline: none;
    }

    .nn-drawer-body {
        min-width: 0;
        min-height: 0;
        flex: 1 1 auto;
        overflow: auto;
        padding: 16px;
        background: var(--nn-drawer-panel-bg);
    }

    .nn-drawer-body :deep(pre) {
        box-sizing: border-box;
        display: block;
        max-width: 100%;
        margin: 0;
        padding: 12px;
        overflow: auto;
        border: 1px solid var(--nn-color-border-light);
        border-radius: 6px;
        background: var(--nn-color-bg-code);
        color: var(--nn-color-text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
    }

    .nn-drawer-footer {
        display: flex;
        min-height: 52px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        padding: 10px 16px;
        border-top: 1px solid var(--nn-color-border-light);
        background: var(--nn-drawer-panel-bg);
    }

    .nn-drawer-motion-enter-active,
    .nn-drawer-motion-leave-active {
        transition: opacity 0.2s ease;
    }

    .nn-drawer-motion-enter-from,
    .nn-drawer-motion-leave-to {
        opacity: 0;
    }

    .nn-drawer-motion-enter-from .nn-drawer-content-wrapper-right,
    .nn-drawer-motion-leave-to .nn-drawer-content-wrapper-right {
        transform: translateX(100%);
    }

    .nn-drawer-motion-enter-from .nn-drawer-content-wrapper-left,
    .nn-drawer-motion-leave-to .nn-drawer-content-wrapper-left {
        transform: translateX(-100%);
    }

    .nn-drawer-motion-enter-from .nn-drawer-content-wrapper-top,
    .nn-drawer-motion-leave-to .nn-drawer-content-wrapper-top {
        transform: translateY(-100%);
    }

    .nn-drawer-motion-enter-from .nn-drawer-content-wrapper-bottom,
    .nn-drawer-motion-leave-to .nn-drawer-content-wrapper-bottom {
        transform: translateY(100%);
    }

    @media (prefers-reduced-motion: reduce) {
        .nn-drawer-content-wrapper,
        .nn-drawer-motion-enter-active,
        .nn-drawer-motion-leave-active {
            transition: none;
        }
    }
</style>
