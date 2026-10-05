const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BmpConst = require('../../electron/const/bmpConst');
const BgpConst = require('../../electron/const/bgpConst');
const BmpApp = require('../../electron/app/bmpApp');
const createBmpApiRoutes = require('../../electron/app/bmpApiRoutes');
const { successResponse } = require('../../electron/utils/responseUtils');
const BmpSession = require('../../electron/worker/bmp/bmpSession');
const BmpBgpSession = require('../../electron/worker/bmp/bmpBgpSession');
const BmpBgpInstance = require('../../electron/worker/bmp/bmpBgpInstance');
const BmpBgpRoute = require('../../electron/worker/bmp/bmpBgpRoute');
const BmpClientPersistenceStore = require('../../electron/worker/bmp/bmpClientPersistenceStore');
const { parseBgpPacket } = require('../../electron/utils/bgp/bgpPacketParser');
const { builders } = require('../../scripts/mockBmpClient');
const { loadBmpWorkerClass } = require('./helpers/bmpWorkerLoader');
const {
    buildConnectionMutation,
    buildScopeMutation,
    buildRouteUpsertMutation,
    buildRouteWithdrawMutation
} = require('../../electron/worker/bmp/bmpPersistenceMutation');
const BmpWorker = loadBmpWorkerClass(__dirname, module);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-route-detail-id-'));
const store = new BmpClientPersistenceStore({ dbPath: path.join(directory, 'bmp.sqlite3') }).open();
let batchId = 0;
function apply(mutations) {
    return store.applyBatch({ batchId: `detail-${++batchId}`, createdAtMs: Date.now(), mutations });
}

function context(kind, label = kind) {
    const session = {
        sysName: `detail-${label}`,
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort: 50000,
        persistenceConnectionGeneration: 1,
        persistenceOpenedAtMs: 1719811200000
    };
    const owner = kind === 'peer' ? new BmpBgpSession(session) : new BmpBgpInstance(session);
    Object.assign(
        owner,
        kind === 'peer'
            ? { sessionType: 0, sessionRd: '0:0', sessionIp: '198.51.100.1', sessionAs: 65001 }
            : { instanceType: 3, instanceRd: '0:0', instanceAs: 65001 }
    );
    return { kind, session, owner, ribType: kind === 'peer' ? BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN : 'loc-rib' };
}

function parseNlri(afi, safi, bytes) {
    const parsed = parseBgpPacket(builders.multiprotocolUpdate(afi, safi, bytes));
    assert.equal(parsed.valid, true, parsed.error);
    const result = parsed.pathAttributes.find(attribute => attribute.mpReach).mpReach.nlri[0];
    assert.notEqual(result.valid, false);
    return result;
}

function announce(current, afi, safi, nlri) {
    const route = new BmpBgpRoute(
        current.kind === 'peer' ? current.owner : null,
        current.kind === 'peer' ? null : current.owner
    );
    BmpSession.prototype.setRouteNlri.call({}, route, nlri, afi, safi);
    route.ribType = current.ribType;
    route.assignRouteAttr({ origin: 'IGP', asPath: '65001', nextHop: '192.0.2.254' });
    route.markActive(0);
    return buildRouteUpsertMutation(current.session, current.owner, route, afi, safi, current.ribType, {
        kind: current.kind,
        scopeState: 'ready',
        isNewRoute: true
    });
}

function openContext(current, afi, safi) {
    current.opening = [
        buildConnectionMutation(current.session, 'connection_open'),
        buildScopeMutation(current.session, current.owner, afi, safi, current.ribType, 'scope_open', {
            kind: current.kind,
            state: 'ready'
        })
    ];
}

function seed(current, mutations) {
    apply([...current.opening, ...mutations]);
    return { sourceId: mutations[0].source.id, scopeId: mutations[0].scope.id };
}

const worker = Object.create(BmpWorker.prototype);
worker.readPersistence = async (method, query) => store[method](query);
worker.messageHandler = {
    sendSuccessResponse(id, result) {
        worker.response = { id, result };
    },
    sendErrorResponse(id, error) {
        throw new Error(`${id}: ${error}`);
    }
};

async function verifyQp(kind) {
    const current = context(kind);
    openContext(current, 1, 241);
    // Same prefix/path/RD, distinct DQPN presence, values and bit lengths.
    const wires = [
        Buffer.from([5, 2, 24, 203, 0, 113]),
        Buffer.from([7, 1, 0, 2, 24, 203, 0, 113]),
        Buffer.from([8, 1, 8, 1, 2, 24, 203, 0, 113]),
        Buffer.from([8, 1, 8, 2, 2, 24, 203, 0, 113]),
        Buffer.from([8, 1, 7, 2, 2, 24, 203, 0, 113])
    ];
    const mutations = wires.map(bytes => announce(current, 1, 241, parseNlri(1, 241, bytes)));
    const lookup = seed(current, mutations);
    assert.equal(new Set(mutations.map(mutation => mutation.route.legacyRouteKey)).size, wires.length);
    assert.equal(new Set(mutations.map(mutation => mutation.route.id)).size, wires.length);
    const snapshot = await worker.queryRouteScope(lookup, { pageSize: 10, routeState: 'all' });
    assert.equal(snapshot.list.length, wires.length);
    assert.equal(new Set(snapshot.list.map(route => route.routeKey)).size, wires.length);
    assert.ok(snapshot.list.every(route => !Object.prototype.hasOwnProperty.call(route, 'persistentRouteId')));
    worker.getBgpSessionRouteScope = () => lookup;
    worker.getBgpInstanceRouteScope = () => lookup;
    const app = Object.create(BmpApp.prototype);
    app.getBmpRunning = () => true;
    app.sendWorkerQuery = async (_operation, payload) => {
        assert.equal(Object.prototype.hasOwnProperty.call(payload, 'routeId'), false);
        return successResponse(await worker.queryRouteDetail(lookup, payload.routeKey));
    };
    const httpRoute = createBmpApiRoutes(app).find(
        route => route.path === (kind === 'peer' ? '/api/v1/bmp/routes/detail' : '/api/v1/bmp/instances/routes/detail')
    );
    const httpBody = {
        client: current.session,
        ...(kind === 'peer'
            ? { session: current.owner, af: BgpConst.BGP_ADDR_FAMILY.IPV4_QP, ribType: current.ribType }
            : { instance: { ...current.owner, addrFamilyType: BgpConst.BGP_ADDR_FAMILY.IPV4_QP } })
    };
    for (const mutation of mutations) {
        const listRow = snapshot.list.find(route => route.routeKey === mutation.route.legacyRouteKey);
        assert.ok(listRow);
        const data = {
            client: {},
            session: {},
            instance: {},
            af: 1,
            ribType: current.ribType,
            routeKey: listRow.routeKey
        };
        if (kind === 'peer') await worker.getBgpRouteDetail(`qp-${kind}`, data);
        else await worker.getBgpInstanceRouteDetail(`qp-${kind}`, data);
        assert.equal(worker.response.result.persistentRouteId, mutation.route.id);
        const expected = JSON.parse(mutation.route.routeJson).nlriDetail;
        const routeInfo = {
            afi: 1,
            safi: 241,
            pathId: 0,
            rd: '0:0',
            ip: '203.0.113.0',
            mask: 24,
            nlriDetail: expected
        };
        assert.equal(worker.getRouteKey('', routeInfo), mutation.route.legacyRouteKey);
        assert.equal(
            worker.getRouteKey('', {
                ...routeInfo,
                afi: undefined,
                safi: undefined,
                addrFamilyType: BgpConst.BGP_ADDR_FAMILY.IPV4_QP
            }),
            mutation.route.legacyRouteKey
        );
        assert.equal(
            worker.getRouteKey('', { ...routeInfo, afi: undefined, safi: undefined }, { afi: 1, safi: 241 }),
            mutation.route.legacyRouteKey
        );
        assert.deepEqual(
            [worker.response.result.nlriDetail.dqpn, worker.response.result.nlriDetail.dqpnBits],
            [expected.dqpn, expected.dqpnBits]
        );
        const httpDetail = await httpRoute.handler({
            body: { ...httpBody, routeKey: listRow.routeKey }
        });
        assert.equal(httpDetail.status, 'success');
        assert.equal(
            httpDetail.data.persistentRouteId,
            mutation.route.id,
            'HTTP adapter must preserve the complete routeKey'
        );
    }
    const key = mutations[0].route.legacyRouteKey;
    assert.equal(
        await worker.queryRouteDetail(lookup, 'missing-route-key'),
        null,
        'unknown routeKey must not fall back to another same-prefix route'
    );
    assert.equal(await worker.queryRouteDetail({ ...lookup, scopeId: 'e'.repeat(64) }, key), null);
    assert.equal(
        await worker.queryRouteDetail(lookup, mutations[3].route.id.toUpperCase()),
        null,
        'routeKey must not implicitly interpret a hexadecimal string as a route ID'
    );
    const remainingKeys = new Set(mutations.map(mutation => mutation.route.legacyRouteKey));
    for (const [index, mutation] of mutations.entries()) {
        const withdrawn = buildRouteWithdrawMutation(
            current.session,
            current.owner,
            parseNlri(1, 241, wires[index]),
            null,
            1,
            241,
            current.ribType,
            { kind, state: 'ready' }
        );
        assert.equal(withdrawn.route.legacyRouteKey, mutation.route.legacyRouteKey);
        apply([withdrawn]);
        remainingKeys.delete(mutation.route.legacyRouteKey);
        assert.equal(await worker.queryRouteDetail(lookup, mutation.route.legacyRouteKey), null);
        const remaining = await worker.queryRouteScope(lookup, { pageSize: 10, routeState: 'all' });
        assert.deepEqual(new Set(remaining.list.map(route => route.routeKey)), remainingKeys);
        for (const key of remainingKeys) assert.equal((await worker.queryRouteDetail(lookup, key)).routeKey, key);
    }
    // Leave a real same-key route in both client databases for the isolation probe.
    apply([announce(current, 1, 241, parseNlri(1, 241, wires[0]))]);
    return { lookup, mutation: mutations[0] };
}

function evpn(type, changed) {
    const label = value => Buffer.from([(value >> 12) & 255, (value >> 4) & 255, ((value & 15) << 4) | 1]);
    const common = [builders.rd(65000, 1), Buffer.alloc(10), builders.u32(100)];
    const body =
        type === 2
            ? Buffer.concat([
                  ...common,
                  Buffer.from([48]),
                  Buffer.from('aabbccddee01', 'hex'),
                  Buffer.from([32]),
                  builders.ip('192.0.2.1'),
                  label(100),
                  ...(changed ? [label(200)] : [])
              ])
            : Buffer.concat([
                  ...common,
                  Buffer.from([24]),
                  builders.ip('198.51.100.0'),
                  builders.ip(changed ? '192.0.2.2' : '192.0.2.1'),
                  label(changed ? 200 : 100)
              ]);
    return parseNlri(25, 70, Buffer.concat([Buffer.from([type, body.length]), body]));
}

async function verifyEvpn(kind, type) {
    const current = context(kind, `${kind}-evpn-${type}`);
    openContext(current, 25, 70);
    const first = announce(current, 25, 70, evpn(type, false));
    const changed = announce(current, 25, 70, evpn(type, true));
    assert.equal(changed.route.id, first.route.id, 'RT2 label/RT5 gateway is payload, not route identity');
    assert.equal(
        changed.route.legacyRouteKey,
        first.route.legacyRouteKey,
        'stable EVPN identity keeps its complete routeKey'
    );
    const lookup = seed(current, [first]);
    apply([changed]);
    const list = await worker.queryRouteScope(lookup, { pageSize: 10, routeState: 'all' });
    assert.equal(list.list.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(list.list[0], 'persistentRouteId'), false);
    const detail = await worker.queryRouteDetail(lookup, list.list[0].routeKey);
    assert.equal(detail.persistentRouteId, changed.route.id);
    assert.deepEqual(detail.nlriDetail, JSON.parse(changed.route.routeJson).nlriDetail);
}

async function verifyLongHttpRouteKey(kind) {
    // A valid FlowSpec numeric component can contain many comparison operands.
    // Its canonical raw-NLRI hex is larger than the former 2048-character cap.
    const operands = Array.from({ length: 400 }, (_, index) => Buffer.from([index === 399 ? 0x91 : 0x11, 0x01, 0xbb]));
    const body = Buffer.concat([Buffer.from([1, 24, 192, 0, 2, 5]), ...operands]);
    const wire = Buffer.concat([Buffer.from([0xf0 | (body.length >> 8), body.length & 255]), body]);
    const current = context(kind, `long-flowspec-${kind}`);
    openContext(current, 1, 133);
    const mutation = announce(current, 1, 133, parseNlri(1, 133, wire));
    const lookup = seed(current, [mutation]);
    assert.ok(mutation.route.legacyRouteKey.length > 2048);
    assert.ok(mutation.route.legacyRouteKey.length < 256 * 1024);
    const app = Object.create(BmpApp.prototype);
    let queries = 0;
    app.getBmpRunning = () => true;
    app.sendWorkerQuery = async (_operation, payload) => {
        queries += 1;
        assert.equal(Object.prototype.hasOwnProperty.call(payload, 'routeId'), false);
        return successResponse(await worker.queryRouteDetail(lookup, payload.routeKey));
    };
    const handler = createBmpApiRoutes(app).find(
        route => route.path === (kind === 'peer' ? '/api/v1/bmp/routes/detail' : '/api/v1/bmp/instances/routes/detail')
    ).handler;
    const query = {
        client: current.session,
        ...(kind === 'peer'
            ? { session: current.owner, af: BgpConst.BGP_ADDR_FAMILY.IPV4_FLOWSPEC, ribType: current.ribType }
            : { instance: { ...current.owner, addrFamilyType: BgpConst.BGP_ADDR_FAMILY.IPV4_FLOWSPEC } }),
        routeKey: mutation.route.legacyRouteKey
    };
    const detail = await handler({ body: query });
    assert.equal(detail.status, 'success');
    assert.equal(detail.data.routeKey, query.routeKey);
    assert.equal(detail.data.persistentRouteId, mutation.route.id);
    const atLimit = await handler({ body: { ...query, routeKey: 'x'.repeat(256 * 1024) } });
    assert.equal(atLimit.status, 'success', 'the exact bounded key length is accepted');
    const count = queries;
    const oversized = await handler({ body: { ...query, routeKey: 'x'.repeat(256 * 1024 + 1) } });
    assert.equal(oversized.code, 'INVALID_PARAMETER');
    assert.equal(queries, count, 'oversized keys must be rejected before a persistence query');
}

async function main() {
    assert.equal(worker.getRouteKey('explicit', { routeKey: 'other' }), 'explicit');
    assert.equal(worker.getRouteKey('', { routeKey: 'existing' }), 'existing');
    assert.equal(worker.getRouteKey('', { pathId: 0, rd: '0:0', ip: '203.0.113.0', mask: 24 }), '0|0:0|203.0.113.0|24');
    assert.throws(() => worker.getRouteKey('', { afi: 1, safi: 241, ip: '203.0.113.0', mask: 24 }), /完整 NLRI/);
    assert.throws(() => worker.getRouteKey('', { afi: 25, safi: 70, nlriDetail: {} }), /完整 NLRI/);
    const peer = await verifyQp('peer');
    const loc = await verifyQp('loc-rib');
    assert.equal(
        await worker.queryRouteDetail(
            { ...loc.lookup, sourceId: peer.lookup.sourceId },
            peer.mutation.route.legacyRouteKey
        ),
        null,
        'the same NLRI routeKey is scoped to the selected client and scope'
    );
    for (const kind of ['peer', 'loc-rib']) for (const type of [2, 5]) await verifyEvpn(kind, type);
    for (const kind of ['peer', 'loc-rib']) await verifyLongHttpRouteKey(kind);
    console.log('BMP unique routeKey detail identity tests passed');
}
main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
