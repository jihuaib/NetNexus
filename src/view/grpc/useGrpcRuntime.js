import { reactive } from 'vue';
import { GRPC_RUNTIME_CHANGED_EVENT } from '../../const/grpcConst';
import EventBus from '../../utils/eventBus';

const GRPC_RUNTIME_EVENT_LISTENER_ID = 'grpc-runtime-store';

const runtimeState = reactive({
    initialized: false,
    running: false,
    starting: false,
    serverRunning: false,
    runtimeRevision: 0
});

let listenerInstalled = false;
let stateRequestRevision = 0;
let stateLoadPromise = null;

const unwrapRuntimeState = payload => {
    if (payload?.status && Object.prototype.hasOwnProperty.call(payload, 'data')) {
        return payload.data;
    }
    return payload;
};

export function applyGrpcRuntimeState(payload) {
    const next = unwrapRuntimeState(payload);
    if (!next || typeof next !== 'object') return false;

    stateRequestRevision += 1;
    const running = Boolean(next.running);
    const runtimeChanged = runtimeState.running !== running;
    runtimeState.initialized = true;
    runtimeState.running = running;
    runtimeState.starting = Boolean(next.starting);
    runtimeState.serverRunning = running && Boolean(next.serverRunning);
    if (runtimeChanged) runtimeState.runtimeRevision += 1;
    return true;
}

export function refreshGrpcRuntimeState({ force = false } = {}) {
    if (!force && runtimeState.initialized) return Promise.resolve(runtimeState);
    if (stateLoadPromise) return stateLoadPromise;
    if (typeof window.grpcApi?.getRuntimeState !== 'function') {
        runtimeState.initialized = true;
        return Promise.resolve(runtimeState);
    }

    const requestRevision = ++stateRequestRevision;
    let pending;
    pending = Promise.resolve()
        .then(() => window.grpcApi.getRuntimeState())
        .then(result => {
            if (requestRevision !== stateRequestRevision) return runtimeState;
            if (result?.status === 'success') applyGrpcRuntimeState(result);
            return runtimeState;
        })
        .catch(error => {
            if (requestRevision === stateRequestRevision) {
                runtimeState.initialized = true;
                console.error('gRPC runtime state query failed:', error);
            }
            return runtimeState;
        })
        .finally(() => {
            if (stateLoadPromise === pending) stateLoadPromise = null;
        });
    stateLoadPromise = pending;
    return pending;
}

export function useGrpcRuntime() {
    if (!listenerInstalled) {
        EventBus.on(GRPC_RUNTIME_CHANGED_EVENT, GRPC_RUNTIME_EVENT_LISTENER_ID, applyGrpcRuntimeState);
        listenerInstalled = true;
    }
    void refreshGrpcRuntimeState();
    return runtimeState;
}
