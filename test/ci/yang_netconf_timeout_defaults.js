'use strict';

const assert = require('node:assert/strict');
const NetconfApp = require('../../electron/app/netconfApp');
const { NetconfClient } = require('../../electron/utils/netconf');
const { DEFAULT_NETCONF_PROFILE, NETCONF_LIMITS } = require('../../electron/const/yangConst');

const PROFILE_STORE_KEY = 'netconf-profiles';

class FakeIpcMain {
    handle() {}
}

class MemoryStore {
    constructor(values = {}) {
        this.values = new Map(Object.entries(values));
    }

    get(key, fallback) {
        return this.values.has(key) ? this.values.get(key) : fallback;
    }

    set(key, value) {
        this.values.set(key, value);
    }
}

const validProfile = {
    id: 'timeout-router',
    name: 'Timeout router',
    host: '192.0.2.1',
    username: 'netconf',
    authMethod: 'password'
};

assert.equal(DEFAULT_NETCONF_PROFILE.rpcTimeout, 300000);
assert.equal(NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT, 300000);
assert.equal(new NetconfClient().rpcTimeout, 300000);

const store = new MemoryStore({
    [PROFILE_STORE_KEY]: [
        { ...validProfile, id: 'legacy-router', rpcTimeout: 30000 },
        { ...validProfile, id: 'custom-router', rpcTimeout: 180000 },
        { ...validProfile, id: 'missing-router' }
    ]
});
const app = new NetconfApp(new FakeIpcMain(), store, {
    yangApp: { setActiveProfileId() {}, profileWorkspaceId() {} }
});
const storedProfiles = store.get(PROFILE_STORE_KEY, []);

assert.equal(storedProfiles.find(profile => profile.id === 'legacy-router').rpcTimeout, 300000);
assert.equal(storedProfiles.find(profile => profile.id === 'custom-router').rpcTimeout, 180000);
assert.equal(
    Object.hasOwn(
        storedProfiles.find(profile => profile.id === 'missing-router'),
        'rpcTimeout'
    ),
    false
);
assert.equal(app.normalizeProfile(validProfile).rpcTimeout, 300000);
assert.equal(app.normalizeProfile({ ...validProfile, rpcTimeout: 30000 }).rpcTimeout, 30000);
assert.equal(app.normalizeProfile({ ...validProfile, rpcTimeout: 180000 }).rpcTimeout, 180000);
assert.equal(app.operationWorkerTimeoutMs('legacy-router'), 305000);

storedProfiles.find(profile => profile.id === 'legacy-router').rpcTimeout = 30000;
new NetconfApp(new FakeIpcMain(), store, {
    yangApp: { setActiveProfileId() {}, profileWorkspaceId() {} }
});
assert.equal(
    store.get(PROFILE_STORE_KEY, []).find(profile => profile.id === 'legacy-router').rpcTimeout,
    30000,
    'the legacy migration must run once so a later explicit 30-second value remains configurable'
);

console.log('NETCONF 300-second RPC timeout defaults and legacy profile migration tests passed');
