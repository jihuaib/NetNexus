const assert = require('node:assert/strict');
const BmpApp = require('../../electron/app/bmpApp');
const BmpConst = require('../../electron/const/bmpConst');
const EventDispatcher = require('../../electron/utils/eventDispatcher');

function target() {
    const messages = [];
    return { messages, isDestroyed: () => false, send: (_channel, message) => messages.push(message) };
}

async function main() {
    const primary = target();
    const assurance = target();
    const lens = target();
    const workers = [];
    const app = Object.create(BmpApp.prototype);
    Object.assign(app, {
        bmpStartGeneration: 0,
        bmpStarting: false,
        bmpStopping: false,
        worker: null,
        persistenceDbPath: 'not-opened-by-this-test',
        async closeOfflinePersistenceReader() {},
        createBmpProcess() {
            const listeners = new Map();
            const worker = {
                listeners,
                addEventListener: (type, handler) => listeners.set(type, handler),
                removeEventListener: (type, handler) => {
                    if (listeners.get(type) === handler) listeners.delete(type);
                },
                async sendRequest() {
                    return { msg: 'stub' };
                },
                async terminate() {}
            };
            workers.push(worker);
            return worker;
        }
    });
    EventDispatcher.subscribe(assurance, 'bmp:routeAssuranceInvalidated');
    EventDispatcher.subscribe(lens, 'bmp:routeLensInvalidated');
    try {
        assert.equal((await app.startBmpOperation({ sender: primary }, { port: 11019 })).status, 'success');
        primary.messages.length = 0;
        const handler = workers[0].listeners.get(BmpConst.BMP_EVT_TYPES.ROUTE_ASSURANCE_UPDATE);
        assert.equal(typeof handler, 'function');
        const metadata = { enabled: true, state: 'ready', dataRevision: 2 };
        handler({ data: metadata });
        assert.equal(primary.messages.length, 0, 'completion must not broadcast to the main renderer');
        assert.equal(lens.messages.length, 0, 'Route Assurance completion must not invalidate Route Lens');
        assert.equal(assurance.messages.length, 1);
        assert.equal(assurance.messages[0].type, 'bmp:routeAssuranceInvalidated');
        assert.deepEqual(assurance.messages[0].data.data, metadata);

        const dispatcher = app.eventDispatcher;
        app.eventDispatcher = null;
        assert.doesNotThrow(() => handler({ data: metadata }));
        app.eventDispatcher = dispatcher;
        await app.stopBmpOperation();
        assert.equal(workers[0].listeners.has(BmpConst.BMP_EVT_TYPES.ROUTE_ASSURANCE_UPDATE), false);
        handler({ data: metadata });
        assert.equal(assurance.messages.length, 1, 'late stopped-worker completions are ignored');
        assert.equal((await app.startBmpOperation({ sender: primary }, { port: 11019 })).status, 'success');
        handler({ data: metadata });
        assert.equal(assurance.messages.length, 1, 'an old worker cannot invalidate a restarted runtime');
        workers[1].listeners.get(BmpConst.BMP_EVT_TYPES.ROUTE_ASSURANCE_UPDATE)({
            data: { ...metadata, dataRevision: 3 }
        });
        assert.equal(assurance.messages.length, 2);
        await app.stopBmpOperation();
    } finally {
        EventDispatcher.unsubscribe(assurance);
        EventDispatcher.unsubscribe(lens);
        app.eventDispatcher?.cleanup();
    }
    console.log('BMP Route Assurance completion subscription tests passed');
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
