import { notificationService } from 'netnexus-ui/services';

export const notify = {
    success(content, duration, onClose) {
        return notificationService.success(content, duration, onClose);
    },
    error(content, duration, onClose) {
        return notificationService.error(content, duration, onClose);
    },
    warning(content, duration, onClose) {
        return notificationService.warning(content, duration, onClose);
    },
    info(content, duration, onClose) {
        return notificationService.info(content, duration, onClose);
    },
    loading(content, duration, onClose) {
        return notificationService.loading(content, duration, onClose);
    },
    destroy(key) {
        return notificationService.destroy(key);
    }
};
