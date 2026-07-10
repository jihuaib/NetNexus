import { createApp, h, nextTick, ref } from 'vue';

const activeDialogs = new Set();

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

function createConfirmDialog(options = {}) {
    if (!canUseDom()) {
        return {
            destroy() {}
        };
    }

    const root = createDialogRoot();
    const open = ref(true);
    const loading = ref(false);
    let app = null;

    const destroy = () => {
        if (!open.value) {
            return;
        }

        open.value = false;
        window.setTimeout(() => {
            activeDialogs.delete(destroy);
            app?.unmount();
            root.remove();
        }, 160);
    };

    const handleCancel = () => {
        if (loading.value) {
            return;
        }

        if (typeof options.onCancel === 'function') {
            options.onCancel();
        }
        destroy();
    };

    const handleOk = async () => {
        if (loading.value) {
            return;
        }

        try {
            loading.value = true;
            if (typeof options.onOk === 'function') {
                await options.onOk();
            }
            destroy();
        } catch (error) {
            console.warn('确认弹窗执行失败:', error);
            loading.value = false;
        }
    };

    const ConfirmDialog = {
        setup() {
            nextTick(() => {
                root.querySelector('.nn-confirm-input')?.focus();
            });

            return () =>
                open.value
                    ? h('div', { class: 'nn-confirm-wrap' }, [
                          h('div', { class: 'nn-confirm-mask' }),
                          h('section', { class: 'nn-confirm-dialog', role: 'dialog', 'aria-modal': 'true' }, [
                              h('header', { class: 'nn-confirm-header' }, [
                                  h('div', { class: 'nn-confirm-title' }, options.title || '确认操作'),
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
                              h('div', { class: 'nn-confirm-body' }, [renderContent(options.content)]),
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
                          ])
                      ])
                    : null;
        }
    };

    app = createApp(ConfirmDialog);
    app.mount(root);
    activeDialogs.add(destroy);

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
