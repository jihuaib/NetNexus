'use strict';

const assert = require('node:assert/strict');
const NetconfApp = require('../../electron/app/netconfApp');
const { NETCONF_REQ_TYPES } = require('../../electron/const/yangConst');

class FakeIpcMain {
    constructor() {
        this.handlers = new Map();
    }

    handle(channel, handler) {
        this.handlers.set(channel, handler);
    }
}

class MemoryStore {
    constructor() {
        this.values = new Map();
    }

    get(key, fallback) {
        return this.values.has(key) ? this.values.get(key) : fallback;
    }

    set(key, value) {
        this.values.set(key, value);
    }
}

async function main() {
    const importedBatches = [];
    const app = new NetconfApp(new FakeIpcMain(), new MemoryStore(), {
        yangApp: {
            async importDownloadedContents(contents) {
                importedBatches.push(contents);
                return { summary: { imported: contents.length, failed: 0 } };
            }
        }
    });
    const profileId = 'download-router';
    const inventory = {
        source: 'rfc8525',
        modules: [
            { name: 'example-system', revision: '2026-02-01' },
            { name: 'example-types', revision: '2026-01-01' }
        ]
    };
    const requested = [];
    app.activeProfileId = profileId;
    app.inventories.set(profileId, inventory);
    app.workerClient = {
        async sendRequest(operation, data) {
            if (operation === NETCONF_REQ_TYPES.DISCONNECT_ALL) return { status: 'success', data: [] };
            assert.equal(operation, NETCONF_REQ_TYPES.GET_SCHEMA);
            const name = data.module.name;
            requested.push(name);
            if (name === 'example-system') {
                return {
                    status: 'success',
                    data: {
                        content:
                            'module example-system { namespace "urn:example:system"; prefix es; import example-types { prefix et; revision-date 2026-01-01; } revision 2026-02-01; container system { leaf hostname { type et:label; } } }',
                        dependencies: [{ name: 'example-types', revisionDate: '2026-01-01', kind: 'module' }]
                    }
                };
            }
            return {
                status: 'success',
                data: {
                    content:
                        'module example-types { namespace "urn:example:types"; prefix et; revision 2026-01-01; typedef label { type string; } }',
                    dependencies: []
                }
            };
        },
        async terminate() {}
    };
    const event = {
        sender: {
            isDestroyed: () => false,
            send() {}
        }
    };

    const response = await app.handleDownloadModules(event, {
        modules: [{ name: 'example-system', revision: '2026-02-01' }],
        includeDependencies: true
    });
    assert.equal(response.status, 'success');
    const task = app.taskManager.tasks.get(response.data.taskId);
    await task.promise;
    assert.equal(task.status, 'completed', task.error?.message);
    assert.deepEqual(requested, ['example-system', 'example-types']);
    assert.equal(importedBatches.length, 1);
    assert.deepEqual(
        importedBatches[0].map(item => item.expectedName),
        ['example-system', 'example-types']
    );

    await app.closeAll();
    console.log('NETCONF app get-schema dependency-closure and YANG import tests passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
