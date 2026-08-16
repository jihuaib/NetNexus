import { onActivated, onBeforeUnmount, onDeactivated, onMounted } from 'vue';
import EventBus from '../../utils/eventBus';
import { BGP_RUNTIME_CHANGED_EVENT } from '../../const/bgpConst';

export function createBgpRouteRuntimeController({ clearRoutes, refreshRoutes }) {
    let active = false;
    let loadedForCurrentRuntime = false;
    let refreshPromise = null;

    const loadIfNeeded = () => {
        if (loadedForCurrentRuntime) return refreshPromise;

        loadedForCurrentRuntime = true;
        let pendingRefresh;
        pendingRefresh = Promise.resolve()
            .then(refreshRoutes)
            .catch(error => console.error('BGP route refresh failed:', error))
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
                clearRoutes();
                return null;
            }

            refreshPromise = null;
            clearRoutes();
            loadedForCurrentRuntime = false;
            return active ? loadIfNeeded() : null;
        }
    };
}

export function useBgpRouteRuntime(pageId, options) {
    const controller = createBgpRouteRuntimeController(options);
    const handleRuntimeChanged = state => {
        const pending = controller.runtimeChanged(state);
        if (pending) void pending;
    };

    onMounted(() => EventBus.on(BGP_RUNTIME_CHANGED_EVENT, pageId, handleRuntimeChanged));
    onActivated(() => {
        void controller.activate();
    });
    onDeactivated(() => {
        controller.deactivate();
    });
    onBeforeUnmount(() => EventBus.off(BGP_RUNTIME_CHANGED_EVENT, pageId));
}
