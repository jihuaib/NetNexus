import { onActivated, onBeforeUnmount, onDeactivated, onMounted } from 'vue';
import { RPKI_RUNTIME_CHANGED_EVENT } from '../../const/rpkiConst';
import EventBus from '../../utils/eventBus';

export function createRpkiDatasetRuntimeController({ clearDataset, refreshDataset }) {
    let active = false;
    let loadedForCurrentRuntime = false;
    let refreshPromise = null;

    const loadIfNeeded = () => {
        if (loadedForCurrentRuntime) return refreshPromise;

        loadedForCurrentRuntime = true;
        let pendingRefresh;
        pendingRefresh = Promise.resolve()
            .then(refreshDataset)
            .catch(error => console.error('RPKI dataset refresh failed:', error))
            .finally(() => {
                if (refreshPromise === pendingRefresh) {
                    refreshPromise = null;
                }
            });
        refreshPromise = pendingRefresh;
        return pendingRefresh;
    };

    return {
        activate() {
            active = true;
            return loadIfNeeded();
        },
        deactivate() {
            active = false;
        },
        runtimeChanged(state) {
            if (!state?.running) {
                loadedForCurrentRuntime = true;
                refreshPromise = null;
                clearDataset();
                return null;
            }

            loadedForCurrentRuntime = false;
            return active ? loadIfNeeded() : null;
        }
    };
}

export function useRpkiDatasetRuntime(pageId, options) {
    const controller = createRpkiDatasetRuntimeController(options);
    const handleRuntimeChanged = state => {
        const pending = controller.runtimeChanged(state);
        if (pending) void pending;
    };

    onMounted(() => EventBus.on(RPKI_RUNTIME_CHANGED_EVENT, pageId, handleRuntimeChanged));
    onActivated(() => {
        void controller.activate();
    });
    onDeactivated(() => {
        controller.deactivate();
    });
    onBeforeUnmount(() => EventBus.off(RPKI_RUNTIME_CHANGED_EVENT, pageId));
}
