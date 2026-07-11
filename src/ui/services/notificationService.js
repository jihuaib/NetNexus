const DEFAULT_DURATION_SECONDS = 3;
let toastId = 0;
let toastHost = null;
const activeToasts = new Map();

function canUseDom() {
    return typeof document !== 'undefined';
}

function getToastHost() {
    if (!canUseDom()) {
        return null;
    }

    if (toastHost) {
        return toastHost;
    }

    toastHost = document.createElement('div');
    toastHost.className = 'nn-toast-host';
    document.body.appendChild(toastHost);
    return toastHost;
}

function normalizeContent(content) {
    if (content instanceof Error) {
        return content.message;
    }

    return content === undefined || content === null ? '' : String(content);
}

function getIcon(type) {
    const icons = {
        success: '✓',
        error: '!',
        warning: '!',
        info: 'i',
        loading: '…'
    };

    return icons[type] || icons.info;
}

function showToast(type, content, duration = DEFAULT_DURATION_SECONDS, onClose) {
    const host = getToastHost();

    if (!host) {
        if (typeof onClose === 'function') {
            onClose();
        }
        return () => {};
    }

    const id = `toast-${++toastId}`;
    const node = document.createElement('div');
    node.className = `nn-toast nn-toast-${type}`;
    node.dataset.toastId = id;
    node.setAttribute('role', type === 'error' || type === 'warning' ? 'alert' : 'status');
    node.setAttribute('aria-live', type === 'error' || type === 'warning' ? 'assertive' : 'polite');
    node.setAttribute('aria-atomic', 'true');
    node.innerHTML = `
        <span class="nn-toast-icon" aria-hidden="true">${getIcon(type)}</span>
        <span class="nn-toast-content"></span>
        <button class="nn-toast-close" type="button" aria-label="关闭">×</button>
    `;
    node.querySelector('.nn-toast-content').textContent = normalizeContent(content);

    let closed = false;
    let timer = null;
    const close = () => {
        if (closed) {
            return;
        }

        closed = true;
        activeToasts.delete(id);
        if (timer) {
            clearTimeout(timer);
        }
        node.classList.add('nn-toast-leaving');
        window.setTimeout(() => {
            node.remove();
            if (typeof onClose === 'function') {
                onClose();
            }
        }, 160);
    };

    node.querySelector('.nn-toast-close').addEventListener('click', close);
    host.appendChild(node);
    activeToasts.set(id, close);
    close.id = id;
    close.key = id;

    const durationSeconds = Number(duration);
    if (durationSeconds > 0) {
        timer = window.setTimeout(close, durationSeconds * 1000);
    }

    return close;
}

export const notificationService = {
    success(content, duration, onClose) {
        return showToast('success', content, duration, onClose);
    },
    error(content, duration, onClose) {
        return showToast('error', content, duration, onClose);
    },
    warning(content, duration, onClose) {
        return showToast('warning', content, duration, onClose);
    },
    info(content, duration, onClose) {
        return showToast('info', content, duration, onClose);
    },
    loading(content, duration = 0, onClose) {
        return showToast('loading', content, duration, onClose);
    },
    destroy(key) {
        if (key && activeToasts.has(key)) {
            activeToasts.get(key)();
            return;
        }

        Array.from(activeToasts.values()).forEach(close => close());
    }
};
