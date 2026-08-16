'use strict';

const LocalYangCompilerClient = require('./localYangCompilerClient');
const YangRuntimeService = require('./yangRuntimeService');
const { STATE_STORE_KEY } = YangRuntimeService;
const { YANG_PROCESS_EVT_TYPES, YANG_RENDERER_CHANNELS } = require('./yangProcessProtocol');

class RuntimeIpcMain {
    constructor() {
        this.handlers = new Map();
    }

    handle(channel, handler) {
        this.handlers.set(channel, handler);
    }
}

class RuntimeStateStore {
    constructor(initialState, onChange) {
        this.values = new Map();
        if (initialState !== undefined && initialState !== null) {
            this.values.set(STATE_STORE_KEY, initialState);
        }
        this.onChange = onChange;
    }

    get(key, fallback = undefined) {
        return this.values.has(key) ? this.values.get(key) : fallback;
    }

    set(key, value) {
        this.values.set(key, value);
        this.onChange?.(key, value);
    }

    delete(key) {
        const deleted = this.values.delete(key);
        if (deleted) this.onChange?.(key, null);
        return deleted;
    }
}

class YangRuntimeHost {
    constructor(endpoint, configuration = {}) {
        this.endpoint = endpoint;
        this.configuration = configuration;
        this.ipcMain = new RuntimeIpcMain();
        this.compilerClient = new LocalYangCompilerClient();
        this.compilerClient.configure(configuration);
        this.store = new RuntimeStateStore(configuration.persistedCompileState, (key, value) => {
            this.endpoint?.postMessage({
                eventName: YANG_PROCESS_EVT_TYPES.STATE_UPDATE,
                data: { key, value }
            });
        });
        this.eventTarget = {
            isDestroyed: () => false,
            send: (channel, payload) => {
                if (channel !== 'unified-event' || !payload?.type) return;
                this.endpoint?.postMessage({ eventName: payload.type, data: payload.data });
            }
        };
        this.runtime = new YangRuntimeService(this.ipcMain, this.store, {
            ...configuration,
            compilerClient: this.compilerClient,
            primaryWebContents: this.eventTarget
        });
        this.channels = new Set(YANG_RENDERER_CHANNELS);
    }

    handles(operation) {
        return this.channels.has(operation);
    }

    async dispatch(operation, data = {}) {
        const handler = this.ipcMain.handlers.get(operation);
        if (!handler) {
            const error = new Error(`Unsupported YANG process operation: ${operation}`);
            error.code = 'YANG_UNKNOWN_OPERATION';
            throw error;
        }
        return handler({ sender: this.eventTarget }, data);
    }

    setActiveProfileId(profileId) {
        this.runtime.setActiveProfileId(profileId);
        return { profileId: this.runtime.activeProfileId };
    }

    getWorkspaceGeneration(request = {}) {
        return this.runtime.getWorkspaceGeneration(request);
    }

    deleteProfileWorkspace(profileId) {
        return this.runtime.deleteProfileWorkspace(profileId, { sender: this.eventTarget });
    }

    async close() {
        await this.runtime.close();
    }
}

module.exports = YangRuntimeHost;
