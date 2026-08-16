import { reactive } from 'vue';
import { SNMP_RUNTIME_CHANGED_EVENT } from '../../const/snmpConst';
import EventBus from '../../utils/eventBus';

const SNMP_RUNTIME_EVENT_LISTENER_ID = 'snmp-runtime-store';

const runtimeState = reactive({
    initialized: false,
    running: false,
    ready: false,
    trapRunning: false,
    runtimeRevision: 0,
    trapRevision: 0
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

export function applySnmpRuntimeState(payload) {
    const next = unwrapRuntimeState(payload);
    if (!next || typeof next !== 'object') return false;

    stateRequestRevision += 1;
    const running = Boolean(next.running);
    const ready = running && Boolean(next.ready);
    const trapRunning = ready && Boolean(next.trapRunning);
    const runtimeChanged = runtimeState.running !== running || runtimeState.ready !== ready;
    const trapChanged = runtimeState.trapRunning !== trapRunning;

    runtimeState.initialized = true;
    runtimeState.running = running;
    runtimeState.ready = ready;
    runtimeState.trapRunning = trapRunning;
    if (runtimeChanged) runtimeState.runtimeRevision += 1;
    if (trapChanged) runtimeState.trapRevision += 1;
    return true;
}

export function refreshSnmpRuntimeState({ force = false } = {}) {
    if (!force && runtimeState.initialized) return Promise.resolve(runtimeState);
    if (stateLoadPromise) return stateLoadPromise;
    if (typeof window.snmpApi?.getSnmpRuntimeState !== 'function') {
        runtimeState.initialized = true;
        return Promise.resolve(runtimeState);
    }

    const requestRevision = ++stateRequestRevision;
    let pending;
    pending = Promise.resolve()
        .then(() => window.snmpApi.getSnmpRuntimeState())
        .then(result => {
            if (requestRevision !== stateRequestRevision) return runtimeState;
            if (result?.status === 'success') applySnmpRuntimeState(result);
            return runtimeState;
        })
        .catch(error => {
            if (requestRevision === stateRequestRevision) {
                runtimeState.initialized = true;
                console.error('SNMP runtime state query failed:', error);
            }
            return runtimeState;
        })
        .finally(() => {
            if (stateLoadPromise === pending) stateLoadPromise = null;
        });
    stateLoadPromise = pending;
    return pending;
}

const handleRuntimeChanged = payload => {
    applySnmpRuntimeState(payload);
};

export function useSnmpRuntime() {
    if (!listenerInstalled) {
        EventBus.on(SNMP_RUNTIME_CHANGED_EVENT, SNMP_RUNTIME_EVENT_LISTENER_ID, handleRuntimeChanged);
        listenerInstalled = true;
    }
    void refreshSnmpRuntimeState();
    return runtimeState;
}
