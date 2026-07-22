import { createApp, h, nextTick, ref } from 'vue';

const activeDialogs = new Set();
let dialogId = 0;
const overlayStateKey = '__NETNEXUS_UI_OVERLAY_STATE__';

function canUseDom() {
    return typeof document !== 'undefined';
}

function renderContent(content) {
    if (typeof content === 'function') {
        return content();
    }

    return h('div', { class: 'nn-confirm-message' }, String(content || ''));
}

function createDialogRoot() {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return root;
}

function getOverlayState() {
    if (!globalThis[overlayStateKey]) {
        globalThis[overlayStateKey] = {
            stack: [],
            lockCount: 0,
            bodyOverflow: '',
            bodyPaddingRight: ''
        };
    }
    return globalThis[overlayStateKey];
}

function lockBodyScroll(state) {
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
}

function unlockBodyScroll(state) {
    if (state.lockCount <= 0) return;

    state.lockCount -= 1;
    if (state.lockCount === 0) {
        document.body.style.overflow = state.bodyOverflow;
        document.body.style.paddingRight = state.bodyPaddingRight;
    }
}

function createConfirmDialog(options = {}) {
    if (!canUseDom()) {
        return {
            destroy() {}
        };
    }

    const root = createDialogRoot();
    const open = ref(true);
    const loading = ref(false);
    const dialogRef = ref(null);
    const titleId = `nn-confirm-title-${++dialogId}`;
    const bodyId = `nn-confirm-body-${dialogId}`;
    const previousFocus = document.activeElement;
    const overlayToken = Symbol('nn-confirm');
    const overlayState = getOverlayState();
    let settling = false;
    let app = null;
    let overlayActive = true;

    overlayState.stack.push(overlayToken);
    lockBodyScroll(overlayState);

    const isTopOverlay = () => overlayState.stack[overlayState.stack.length - 1] === overlayToken;
    const isTopDialog = () => Array.from(activeDialogs).at(-1) === destroy && isTopOverlay();

    const deactivateOverlay = () => {
        if (!overlayActive) return false;

        const wasTop = isTopOverlay();
        const index = overlayState.stack.lastIndexOf(overlayToken);
        if (index >= 0) overlayState.stack.splice(index, 1);
        overlayActive = false;
        unlockBodyScroll(overlayState);
        return wasTop;
    };

    const focusableSelector = [
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    const getFocusableElements = () => Array.from(dialogRef.value?.querySelectorAll(focusableSelector) || []);

    const restoreFocus = () => {
        if (previousFocus?.isConnected) {
            previousFocus.focus?.({ preventScroll: true });
        }
    };

    const destroy = () => {
        if (!open.value) {
            return;
        }

        open.value = false;
        document.removeEventListener('keydown', handleDocumentKeydown);
        window.setTimeout(() => {
            activeDialogs.delete(destroy);
            const shouldRestoreFocus = deactivateOverlay();
            app?.unmount();
            root.remove();
            if (shouldRestoreFocus) restoreFocus();
        }, 160);
    };

    const handleCancel = async () => {
        if (loading.value || settling) {
            return;
        }

        settling = true;
        try {
            if (typeof options.onCancel === 'function') {
                await options.onCancel();
            }
        } catch (error) {
            console.warn('确认弹窗取消回调执行失败:', error);
        } finally {
            destroy();
        }
    };

    const handleOk = async () => {
        if (loading.value || settling) {
            return;
        }

        try {
            settling = true;
            loading.value = true;
            if (typeof options.onOk === 'function') {
                await options.onOk();
            }
            destroy();
        } catch (error) {
            console.warn('确认弹窗执行失败:', error);
            settling = false;
            loading.value = false;
        }
    };

    const trapFocus = event => {
        const focusable = getFocusableElements();
        if (focusable.length === 0) {
            event.preventDefault();
            dialogRef.value?.focus();
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    const handleDocumentKeydown = event => {
        if (!open.value || !isTopDialog()) {
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            handleCancel();
        } else if (event.key === 'Tab') {
            event.stopImmediatePropagation();
            trapFocus(event);
        }
    };

    const ConfirmDialog = {
        setup() {
            nextTick(() => {
                const focusTarget =
                    root.querySelector('.nn-confirm-input') || getFocusableElements()[0] || dialogRef.value;
                focusTarget?.focus?.({ preventScroll: true });
            });

            return () =>
                open.value
                    ? h('div', { class: 'nn-confirm-wrap' }, [
                          h('div', {
                              class: 'nn-confirm-mask',
                              onClick: options.maskClosable ? handleCancel : undefined
                          }),
                          h(
                              'section',
                              {
                                  ref: dialogRef,
                                  class: 'nn-confirm-dialog',
                                  role: 'dialog',
                                  'aria-modal': 'true',
                                  'aria-labelledby': titleId,
                                  'aria-describedby': bodyId,
                                  tabindex: -1
                              },
                              [
                                  h('header', { class: 'nn-confirm-header' }, [
                                      h('div', { id: titleId, class: 'nn-confirm-title' }, options.title || '确认操作'),
                                      h(
                                          'button',
                                          {
                                              class: 'nn-confirm-x',
                                              type: 'button',
                                              disabled: loading.value,
                                              'aria-label': '关闭',
                                              onClick: handleCancel
                                          },
                                          '×'
                                      )
                                  ]),
                                  h('div', { id: bodyId, class: 'nn-confirm-body' }, [renderContent(options.content)]),
                                  h('footer', { class: 'nn-confirm-footer' }, [
                                      h(
                                          'button',
                                          {
                                              class: 'nn-confirm-button nn-confirm-button-default',
                                              type: 'button',
                                              disabled: loading.value,
                                              onClick: handleCancel
                                          },
                                          options.cancelText || '取消'
                                      ),
                                      h(
                                          'button',
                                          {
                                              class: [
                                                  'nn-confirm-button',
                                                  options.okType === 'danger'
                                                      ? 'nn-confirm-button-danger'
                                                      : 'nn-confirm-button-primary'
                                              ],
                                              type: 'button',
                                              disabled: loading.value,
                                              onClick: handleOk
                                          },
                                          loading.value ? '处理中...' : options.okText || '确定'
                                      )
                                  ])
                              ]
                          )
                      ])
                    : null;
        }
    };

    app = createApp(ConfirmDialog);
    app.mount(root);
    activeDialogs.add(destroy);
    document.addEventListener('keydown', handleDocumentKeydown);

    return { destroy };
}

function createTextInput(options = {}) {
    return h('input', {
        class: 'nn-confirm-input',
        value: options.value,
        maxlength: options.maxlength,
        placeholder: options.placeholder,
        onInput: event => {
            options['onUpdate:value']?.(event.target.value);
        },
        onKeydown: event => {
            if (event.key === 'Enter') {
                options.onPressEnter?.(event);
            }
        }
    });
}

export const confirmDialogService = {
    confirm(options) {
        return createConfirmDialog(options);
    },
    textInput(options) {
        return createTextInput(options);
    },
    destroyAll() {
        Array.from(activeDialogs).forEach(destroy => destroy());
    }
};
