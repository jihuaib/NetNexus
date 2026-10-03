const assert = require('node:assert/strict');
const BmpConst = require('../../electron/const/bmpConst');
const Service = require('../../electron/utils/bmpRouteAssuranceService');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');
const BmpWorker = loadBmpWorkerClass(__dirname, module);
const tick = () => new Promise(resolve => setImmediate(resolve));

function gate() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function worker() {
    const instance = Object.create(BmpWorker.prototype);
    instance.responses = [];
    instance.messageHandler = {
        sendSuccessResponse(id, result) {
            instance.responses.push({ id, result });
        },
        sendErrorResponse(id, error) {
            throw new Error(`${id}: ${error}`);
        },
        sendEvent() {}
    };
    return instance;
}

function row(index, rd = '0:0') {
    return {
        persistentSourceId: 'fixture-source',
        persistentScopeId: 'fixture-pre',
        persistentRouteId: `path-${index}`,
        routeKey: `path-${index}`,
        ownerKey: 'peer-owner',
        scopeKind: 'peer',
        afi: 1,
        safi: 1,
        rd,
        ip: '203.0.113.0',
        mask: 24,
        pathId: index,
        ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
        routeState: 'active',
        origin: 'IGP',
        asPath: '65001',
        nextHop: '192.0.2.1',
        source: { id: 'fixture-source', sysName: 'fixture', remoteIp: '192.0.2.10' },
        peer: { ip: '198.51.100.1', as: 65001, rd: '0:0' }
    };
}

function bootstrap(service, rows, loadGroupRows) {
    return service.bootstrapFromRouteStream(
        onChunk => Promise.resolve().then(() => onChunk(rows)),
        {},
        { loadGroupRows }
    );
}

async function main() {
    // A pending enable must not undo a later disable, including its filter state.
    {
        const instance = worker();
        const fenced = gate();
        instance.routeAssuranceService = new Service({ enabled: false });
        instance.persistence = { fence: () => fenced.promise };
        let bootstraps = 0;
        instance.bootstrapRouteAssurance = async () => {
            bootstraps++;
        };
        const enabling = instance.setRouteAssuranceEnabled('old-enable', { enabled: true, filters: { client: 'old' } });
        await instance.setRouteAssuranceEnabled('disable', { enabled: false });
        fenced.resolve();
        await enabling;
        assert.equal(bootstraps, 0);
        assert.equal(instance.routeAssuranceService.enabled, false);
        assert.deepEqual(instance.routeAssuranceFilters, {});
        assert.equal(instance.responses.at(-1).result.enabled, false);
    }
    // Fence errors from superseded requests cannot overwrite the latest state.
    {
        const instance = worker();
        const fenced = gate();
        instance.routeAssuranceService = new Service({ enabled: false });
        instance.persistence = { fence: () => fenced.promise };
        const enabling = instance.setRouteAssuranceEnabled('old-enable', { enabled: true });
        await instance.setRouteAssuranceEnabled('disable', { enabled: false });
        fenced.reject(new Error('old fence failed'));
        await enabling;
        assert.equal(instance.responses.at(-1).result.enabled, false);
    }
    // Lazy open is single-flight; closing during open also closes the unopened owner.
    {
        const instance = worker();
        const opened = gate();
        let created = 0;
        let closed = 0;
        instance.bmpConfigData = { persistenceDbPath: '/unused/fixture.sqlite3' };
        instance.createPersistenceClient = () => {
            created++;
            return {
                open: () => opened.promise,
                async close() {
                    closed++;
                }
            };
        };
        const first = instance.ensureRouteAssuranceReader();
        const second = instance.ensureRouteAssuranceReader();
        assert.equal(created, 1);
        opened.resolve();
        assert.equal(await first, await second);
        await instance.closeRouteAssuranceReader();
        assert.equal(closed, 1);
        assert.equal(instance.routeAssuranceReader, null);
    }
    {
        const instance = worker();
        const opened = gate();
        let closed = 0;
        instance.bmpConfigData = { persistenceDbPath: '/unused/fixture.sqlite3' };
        instance.createPersistenceClient = () => ({
            open: () => opened.promise,
            async close() {
                closed++;
            }
        });
        const opening = instance.ensureRouteAssuranceReader();
        const cancelled = assert.rejects(opening, { code: 'BMP_ROUTE_ASSURANCE_CANCELLED' });
        const closing = instance.closeRouteAssuranceReader();
        opened.resolve();
        await Promise.all([cancelled, closing]);
        assert.equal(closed, 1);
        assert.equal(instance.routeAssuranceReader, null);
        assert.equal(instance.routeAssuranceReaderPromise, null);
    }
    // Every Add-Path observation is read from one stream snapshot, even past 5000 rows.
    {
        const instance = worker();
        const rows = Array.from({ length: 5001 }, (_, index) => row(index, '65000:7'));
        const queries = [];
        instance.persistenceReader = {
            async streamRouteAssuranceRows(query, { onChunk }) {
                queries.push({ ...query });
                assert.equal(query.sourceId, 'fixture-source');
                assert.equal(query.afi, 1);
                assert.equal(query.safi, 1);
                assert.equal(query.prefixExact, '203.0.113.0');
                assert.equal(query.prefixLength, 24);
                assert.equal(query.rd, '65000:7');
                assert.equal(query.routeState, 'all');
                for (let offset = 0; offset < rows.length; offset += 2000) {
                    await onChunk(rows.slice(offset, offset + 2000));
                }
                return { rows: rows.length, cancelled: false };
            }
        };
        const service = new Service({ enabled: false, groupRefreshDelayMs: 100000 });
        await bootstrap(service, rows, locator => instance.loadRouteAssuranceGroupRows(locator));
        assert.equal(service.queryPersisted({}).summary.scannedPathCount, 5001);
        assert.equal(service.applyCommittedDelta({ action: 'upsert', committed: true, current: rows[0] }), true);
        await service.flushGroupRefreshes();
        assert.equal(queries.length, 1);
        assert.equal(service.queryPersisted({}).summary.scannedPathCount, 5001);
        service.setEnabled(false);
    }
    {
        const instance = worker();
        const queries = [];
        instance.persistenceReader = {
            async streamRouteAssuranceRows(query) {
                queries.push(query);
                return { rows: 0, cancelled: false };
            }
        };
        const routeLookupIdentity = 'raw:0000fde800000001|25:70:evpn:{"kind":"evpn","semantic":{"routeType":5}}';
        await instance.loadRouteAssuranceGroupRows({
            sourceId: 'complex-source',
            afi: 25,
            safi: 70,
            rd: '65000:1',
            prefix: 'evpn:ip-prefix:65000:1:tag=100:198.51.100.0/24:gw=192.0.2.2',
            prefixLength: 34,
            routeLookupIdentity
        });
        assert.deepEqual(queries[0], {
            sourceId: 'complex-source',
            routeState: 'all',
            routeLookupIdentity,
            afi: 25,
            safi: 70,
            rd: '65000:1'
        });
        assert.equal('prefixExact' in queries[0], false, 'a mutable gateway must not restrict the stable NLRI group');
        assert.equal('prefixLength' in queries[0], false, 'EVPN encoded length is not part of the stable NLRI key');
    }
    {
        const instance = worker();
        instance.persistenceReader = {
            async streamRouteAssuranceRows(query, { onChunk }) {
                await onChunk([row(1)]);
                return { rows: 1, cancelled: true };
            }
        };
        await assert.rejects(instance.loadRouteAssuranceGroupRows({ prefix: '203.0.113.0' }), {
            code: 'BMP_ROUTE_ASSURANCE_CANCELLED'
        });
    }
    // Queries await an in-flight committed refresh, and its completion emits metadata.
    {
        const completed = [];
        const service = new Service({
            enabled: false,
            groupRefreshDelayMs: 100000,
            onRefreshed: status => completed.push(status)
        });
        const rows = [row(1)];
        const loaded = gate();
        await bootstrap(service, rows, () => loaded.promise);
        completed.length = 0;
        service.applyCommittedDelta({ action: 'delete', committed: true, previous: rows[0] });
        const refreshing = service.flushGroupRefreshes();
        let queried = false;
        const query = service.queryPersistedAsync({}).then(result => {
            queried = true;
            return result;
        });
        await tick();
        assert.equal(queried, false);
        assert.equal(service.groupRefreshRunning, true);
        loaded.resolve([]);
        await refreshing;
        assert.equal((await query).summary.scannedPathCount, 0);
        assert.equal(completed.length, 1);
        assert.equal(completed[0].state, 'ready');
        service.setEnabled(false);
    }
    // Continuous updates cannot make a query chase an unbounded refresh queue.
    {
        const rows = Array.from({ length: 3 }, (_, index) => ({ ...row(index), ip: `203.0.11${index}.0` }));
        const service = new Service({ enabled: false, groupRefreshDelayMs: 100000, groupRefreshBatchSize: 2 });
        let loads = 0;
        await bootstrap(service, rows, async locator => {
            loads++;
            const current = rows.find(item => item.ip === locator.prefix);
            service.applyCommittedDelta({ action: 'upsert', committed: true, current });
            return [current];
        });
        rows.forEach(current => service.applyCommittedDelta({ action: 'upsert', committed: true, current }));
        const result = await service.queryPersistedAsync({});
        assert.equal(loads, 2);
        assert.equal(result.summary.refreshPending, true);
        assert.equal(result.summary.scannedPathCount, 3);
        service.setEnabled(false);
    }
    // An old loader must not overwrite a different bootstrap generation.
    {
        const service = new Service({ enabled: false, groupRefreshDelayMs: 100000 });
        const oldRows = [row(1)];
        const loaded = gate();
        await bootstrap(service, oldRows, () => loaded.promise);
        service.applyCommittedDelta({ action: 'upsert', committed: true, current: oldRows[0] });
        const refreshing = service.flushGroupRefreshes();
        await tick();
        service.invalidate('different-snapshot', { prepareBootstrap: true });
        await bootstrap(service, [row(1), row(2)], async () => []);
        loaded.resolve([]);
        await refreshing;
        assert.equal(service.queryPersisted({}).summary.scannedPathCount, 2);
        service.setEnabled(false);
    }
    console.log('BMP Route Assurance race and complete-group tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
