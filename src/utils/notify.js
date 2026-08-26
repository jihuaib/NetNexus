import { notificationService } from 'netnexus-ui/services';

const DEFAULT_DURATION_SECONDS = 3;
// 鼠标移出提示后再停留一会儿才关闭，避免刚移出就消失
const CLOSE_AFTER_LEAVE_MS = 800;

/**
 * 在 netnexus-ui 的提示基础上增加：鼠标悬停时不自动关闭（便于复制文本），移出后再关闭。
 * 组件库的提示只有一个固定定时器，因此这里让它不自动关闭，由本层接管计时。
 */
function show(type, content, duration, onClose) {
    const seconds = duration === undefined ? DEFAULT_DURATION_SECONDS : Number(duration);
    const closer = notificationService[type](content, 0, onClose);
    if (!(seconds > 0)) {
        return closer;
    }

    let timer = null;
    const clear = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
    const close = () => {
        clear();
        closer();
    };
    const schedule = ms => {
        clear();
        timer = window.setTimeout(close, ms);
    };

    const element =
        typeof document !== 'undefined' ? document.querySelector(`.nn-toast[data-toast-id="${closer.id}"]`) : null;
    if (element) {
        element.addEventListener('mouseenter', clear);
        element.addEventListener('mouseleave', () => schedule(CLOSE_AFTER_LEAVE_MS));
    }
    schedule(seconds * 1000);

    close.id = closer.id;
    close.key = closer.key;
    return close;
}

export const notify = {
    success(content, duration, onClose) {
        return show('success', content, duration, onClose);
    },
    error(content, duration, onClose) {
        return show('error', content, duration, onClose);
    },
    warning(content, duration, onClose) {
        return show('warning', content, duration, onClose);
    },
    info(content, duration, onClose) {
        return show('info', content, duration, onClose);
    },
    loading(content, duration = 0, onClose) {
        return show('loading', content, duration, onClose);
    },
    destroy(key) {
        return notificationService.destroy(key);
    }
};
