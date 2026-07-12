import { confirmDialogService } from '../ui/services/confirmDialogService';

export const dialog = {
    confirm(options) {
        return confirmDialogService.confirm(options);
    },
    textInput(options) {
        return confirmDialogService.textInput(options);
    },
    destroyAll() {
        return confirmDialogService.destroyAll();
    }
};
