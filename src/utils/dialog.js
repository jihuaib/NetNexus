import { confirmDialogService } from 'netnexus-ui/services';

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
