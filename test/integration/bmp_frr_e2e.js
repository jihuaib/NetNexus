const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const ipaddr = require('ipaddr.js');

if (!process.versions.electron) {
    const electronPath = require('electron');
    const result = spawnSync(electronPath, [__filename], {
        cwd: path.join(__dirname, '..', '..'),
        stdio: 'inherit',
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            NODE_ENV: 'test'
        }
    });
    if (result.error) {
        throw result.error;
    }
    process.exit(result.status ?? 1);
}

const BmpConst = require('../../electron/const/bmpConst');
const { getAddrFamilyType } = require('../../electron/utils/bgpUtils');
const {
    FRR_BMP_ADDRESS_FAMILIES,
    FrrBmpLab,
    PEER_AS,
    PEER_ROUTER_ID,
    ROUTER_AS
} = require('../../scripts/e2e-support/frr-bmp-lab');

const REQUEST_TIMEOUT_MS = 30000;
const INTEROP_TIMEOUT_MS = Number(process.env.FRR_BMP_E2E_TIMEOUT_MS) || 4 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const LOC_RIB_TYPE = 'loc-rib';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeIp(value) {
    try {
        return ipaddr.parse(String(value)).toString();
    } catch (_error) {
        return String(value);
    }
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(error => (error ? reject(error) : resolve(port)));
        });
    });
}

function createRequester(worker) {
    const pending = new Map();
    let sequence = 0;

    const rejectAll = error => {
        pending.forEach(request => {
            clearTimeout(request.timeout);
            request.reject(error);
        });
        pending.clear();
    };

    worker.on('message', message => {
        const request = pending.get(message.messageId);
        if (!request) {
            return;
        }
        pending.delete(message.messageId);
        clearTimeout(request.timeout);
        if (message.status === 'success') {
            request.resolve(message);
        } else {
            request.reject(new Error(message.msg || `${request.op} failed`));
        }
    });
    worker.on('error', rejectAll);
    worker.on('exit', code => {
        if (code !== 0) {
            rejectAll(new Error(`BMP worker exited with code ${code}`));
        }
    });

    return (op, data = null, timeoutMs = REQUEST_TIMEOUT_MS) => {
        sequence += 1;
        const messageId = `bmp-frr-e2e-${sequence}`;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pending.delete(messageId);
                reject(new Error(`Timed out waiting for BMP worker request ${op}`));
            }, timeoutMs);
            pending.set(messageId, { op, resolve, reject, timeout });
            worker.postMessage({ messageId, op, data });
        });
    };
}

async function waitFor(description, probe, timeoutMs = INTEROP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const value = await probe();
            if (value) {
                return value;
            }
        } catch (error) {
            lastError = error;
        }
        await delay(POLL_INTERVAL_MS);
    }

    const suffix = lastError ? `: ${lastError.message}` : '';
    throw new Error(`Timed out waiting for ${description}${suffix}`);
}

async function queryPersistedRoutes(request, query = {}) {
    const response = await request(BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTES, {
        page: 1,
        pageSize: 1,
        includeTotal: true,
        ...query
    });
    return response.data;
}

async function queryPersistedRouteEvents(request, query = {}) {
    const response = await request(BmpConst.BMP_REQ_TYPES.GET_PERSISTED_ROUTE_EVENTS, {
        page: 1,
        pageSize: 1,
        includeTotal: true,
        ...query
    });
    return response.data;
}

async function waitForPersistedTotal(request, routeState, expected) {
    let observed = null;
    return waitFor(`${expected} ${routeState} persisted routes`, async () => {
        observed = await queryPersistedRoutes(request, { routeState });
        if (Number(observed.total) === expected) {
            return observed;
        }
        return null;
    }).catch(error => {
        error.message = `${error.message}; last observed total=${observed?.total ?? 'unavailable'}`;
        throw error;
    });
}

async function waitForPersistedEventTotal(request, query, expected) {
    let observed = null;
    return waitFor(`${expected} persisted ${query.eventType || 'route'} events`, async () => {
        observed = await queryPersistedRouteEvents(request, query);
        if (Number(observed.total) === expected) {
            return observed;
        }
        return null;
    }).catch(error => {
        error.message = `${error.message}; last observed event total=${observed?.total ?? 'unavailable'}`;
        throw error;
    });
}

function familyType(family) {
    const value = getAddrFamilyType(family.afi, family.safi);
    assert.notEqual(value, undefined, `${family.name} must have a NetNexus address-family mapping`);
    return value;
}

function findSession(sessions, address) {
    const normalizedAddress = normalizeIp(address);
    return sessions.find(
        item => normalizeIp(item.sessionIp) === normalizedAddress && Number(item.sessionAs) === PEER_AS
    );
}

async function waitForInteropPeers(request, lab) {
    return waitFor('FRR IPv4 and IPv6 Peer Up notifications', async () => {
        const clientsResponse = await request(BmpConst.BMP_REQ_TYPES.GET_CLIENT_LIST);
        const client = clientsResponse.data.find(item => item.bmpVersion === BmpConst.BMP_VERSION.V3);
        if (!client) {
            return null;
        }
        const sessionsResponse = await request(BmpConst.BMP_REQ_TYPES.GET_BGP_SESSIONS, client);
        const ipv4Session = findSession(sessionsResponse.data, lab.peerIp);
        const ipv6Session = findSession(sessionsResponse.data, lab.peerIpv6);
        if (
            !ipv4Session ||
            !ipv6Session ||
            ipv4Session.sessionState !== BmpConst.BMP_SESSION_STATE.PEER_UP ||
            ipv6Session.sessionState !== BmpConst.BMP_SESSION_STATE.PEER_UP
        ) {
            return null;
        }
        return { client, ipv4Session, ipv6Session, sessions: sessionsResponse.data };
    });
}

function validatePeerMetadata(snapshot, lab) {
    assert.equal(snapshot.client.bmpVersion, BmpConst.BMP_VERSION.V3);
    assert.equal(snapshot.client.sysName, 'netnexus-frr-router');
    assert.match(snapshot.client.sysDesc, /FRRouting/i);

    for (const [transport, session] of [
        ['ipv4', snapshot.ipv4Session],
        ['ipv6', snapshot.ipv6Session]
    ]) {
        assert.equal(session.sessionRouterId, PEER_ROUTER_ID);
        assert.equal(session.sessionState, BmpConst.BMP_SESSION_STATE.PEER_UP);
        assert.ok(session.ribTypes.includes(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN));
        assert.ok(session.ribTypes.includes(BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN));

        const expectedTypes = FRR_BMP_ADDRESS_FAMILIES.filter(family => family.transport === transport).map(familyType);
        expectedTypes.forEach(type => {
            assert.ok(
                session.enabledAddrFamilyTypes.includes(type),
                `${transport} peer should advertise address-family type ${type}`
            );
        });
    }

    assert.equal(normalizeIp(snapshot.ipv4Session.sessionIp), normalizeIp(lab.peerIp));
    assert.equal(normalizeIp(snapshot.ipv6Session.sessionIp), normalizeIp(lab.peerIpv6));
}

async function loadFamilyContexts(request, snapshot, lab) {
    const instancesResponse = await request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCES, snapshot.client);
    return lab.routePlan.map(plan => {
        const af = familyType(plan.family);
        const session = plan.family.transport === 'ipv4' ? snapshot.ipv4Session : snapshot.ipv6Session;
        const instance = instancesResponse.data.find(item => Number(item.addrFamilyType) === af);
        assert.ok(instance, `${plan.family.name} should have a Loc-RIB instance`);
        return { ...plan, af, instance, session };
    });
}

async function getScopedRouteCounts(request, client, context, routeState) {
    const commonPeerQuery = {
        client,
        session: context.session,
        af: context.af,
        page: 1,
        pageSize: 1,
        routeState
    };
    const [prePolicy, postPolicy, locRib] = await Promise.all([
        request(BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTES, {
            ...commonPeerQuery,
            ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN
        }),
        request(BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTES, {
            ...commonPeerQuery,
            ribType: BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN
        }),
        request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCE_ROUTES, {
            client,
            instance: context.instance,
            page: 1,
            pageSize: 1,
            routeState
        })
    ]);
    return {
        prePolicy: Number(prePolicy.data.total),
        postPolicy: Number(postPolicy.data.total),
        locRib: Number(locRib.data.total)
    };
}

async function assertFamilyViewMatrix(request, client, contexts, expectedForFamily, routeState) {
    const counts = await Promise.all(
        contexts.map(async context => ({
            family: context.family,
            counts: await getScopedRouteCounts(request, client, context, routeState)
        }))
    );
    counts.forEach(({ family, counts: familyCounts }) => {
        assert.deepEqual(
            familyCounts,
            expectedForFamily(family),
            `${family.name} ${routeState} pre/post/Loc-RIB counts`
        );
    });
    return counts;
}

async function assertFamilyMatrix(request, client, contexts, countForFamily, routeState) {
    return assertFamilyViewMatrix(
        request,
        client,
        contexts,
        family => {
            const expected = countForFamily(family);
            return { prePolicy: expected, postPolicy: expected, locRib: expected };
        },
        routeState
    );
}

function assertSampleSemantics(family, routes) {
    routes.forEach(route => {
        assert.equal(Number(route.afi), family.afi, `${family.name} sample AFI`);
        assert.equal(Number(route.safi), family.safi, `${family.name} sample SAFI`);
        assert.equal(Number(route.addrFamilyType), familyType(family), `${family.name} sample address-family type`);
        assert.equal(route.routeState, BmpConst.BMP_ROUTE_STATE.ACTIVE, `${family.name} sample state`);
    });

    if (family.key === 'vpnv4' || family.key === 'vpnv6') {
        routes.forEach(route => assert.equal(route.rd, family.rd, `${family.name} route distinguisher`));
    }
    if (family.key === 'l2vpn-evpn') {
        routes.forEach(route => assert.equal(Number(route.routeType), 5, 'FRR static EVPN routes should be RT-5'));
    }
}

async function assertBoundarySamples(request, contexts) {
    for (const context of contexts) {
        const prefixes = [...new Set([context.routes[0].prefix, context.routes[context.routes.length - 1].prefix])];
        for (const prefixFilter of prefixes) {
            const sample = await queryPersistedRoutes(request, {
                afi: context.family.afi,
                safi: context.family.safi,
                prefixFilter,
                routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE,
                pageSize: 10
            });
            assert.equal(sample.total, 3, `${context.family.name} ${prefixFilter} should exist in all three views`);
            assertSampleSemantics(context.family, sample.list);
            assert.deepEqual(
                new Set(sample.list.map(route => route.scopeKind)),
                new Set(['peer', 'loc-rib']),
                `${context.family.name} sample scopes`
            );
        }
    }
}

async function assertLiveSentinelProjection(request, contexts, routeState, expected) {
    for (const context of contexts.filter(item => item.family.liveWithdraw)) {
        const sample = await queryPersistedRoutes(request, {
            afi: context.family.afi,
            safi: context.family.safi,
            prefixFilter: context.routes[0].prefix,
            routeState,
            pageSize: 10
        });
        assert.equal(
            sample.total,
            expected,
            `${context.family.name} sentinel should have ${expected} current ${routeState} projections`
        );
    }
}

async function waitForStatistics(request, client) {
    return waitFor('FRR Statistics Reports with Adj-RIB-In and Loc-RIB counts', async () => {
        const response = await request(BmpConst.BMP_REQ_TYPES.GET_BGP_STATISTICS_REPORTS, client);
        const statistics = response.data.flatMap(report => report.statistics || []);
        const hasAdjRibIn = statistics.some(
            item => Number(item.type) === BmpConst.BMP_STATS_TYPE.NUM_ADJ_RIB_IN && Number(item.value) > 0
        );
        const hasLocRib = statistics.some(
            item => Number(item.type) === BmpConst.BMP_STATS_TYPE.NUM_LOC_RIB && Number(item.value) > 0
        );
        return hasAdjRibIn && hasLocRib ? response.data : null;
    });
}

async function waitForPeerDown(request, client, lab) {
    return waitFor('FRR IPv4 and IPv6 Peer Down notifications', async () => {
        const response = await request(BmpConst.BMP_REQ_TYPES.GET_BGP_SESSIONS, client);
        const sessions = [findSession(response.data, lab.peerIp), findSession(response.data, lab.peerIpv6)];
        if (sessions.some(session => !session || session.sessionState !== BmpConst.BMP_SESSION_STATE.PEER_DOWN)) {
            return null;
        }
        return sessions;
    });
}

async function getWorkerDiagnostics(request, lab) {
    const clientsResponse = await request(BmpConst.BMP_REQ_TYPES.GET_CLIENT_LIST);
    const client = clientsResponse.data[0];
    const diagnostics = {
        clients: clientsResponse.data.map(item => ({
            bmpVersion: item.bmpVersion,
            sysName: item.sysName,
            remoteIp: item.remoteIp,
            connectionState: item.connectionState,
            isOnline: item.isOnline,
            routeSummary: item.routeSummary
        }))
    };
    if (!client) {
        return JSON.stringify(diagnostics, null, 2);
    }

    const [sessions, instances, statistics, persistence, active, stale, all] = await Promise.all([
        request(BmpConst.BMP_REQ_TYPES.GET_BGP_SESSIONS, client),
        request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCES, client),
        request(BmpConst.BMP_REQ_TYPES.GET_BGP_STATISTICS_REPORTS, client),
        request(BmpConst.BMP_REQ_TYPES.GET_PERSISTENCE_STATUS),
        queryPersistedRoutes(request, { routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE }),
        queryPersistedRoutes(request, { routeState: BmpConst.BMP_ROUTE_STATE_FILTER.STALE }),
        queryPersistedRoutes(request, { routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL })
    ]);
    diagnostics.sessions = sessions.data.map(session => ({
        sessionIp: session.sessionIp,
        sessionAs: session.sessionAs,
        sessionState: session.sessionState,
        peerDownReason: session.peerDownReason,
        ribTypes: session.ribTypes,
        scopeStates: (session.routeScopes || []).reduce((totals, scope) => {
            totals[scope.scopeState || 'unknown'] = (totals[scope.scopeState || 'unknown'] || 0) + 1;
            return totals;
        }, {}),
        routeSummary: session.routeSummary
    }));
    diagnostics.instances = instances.data.map(instance => ({
        afi: instance.afi,
        safi: instance.safi,
        instanceState: instance.instanceState,
        scopeState: instance.scopeState,
        routeSummary: instance.routeSummary
    }));
    diagnostics.statistics = statistics.data.map(report => ({
        sessionIp: report.session?.sessionIp,
        statistics: (report.statistics || []).map(item => ({ type: item.type, value: item.value }))
    }));
    diagnostics.persistence = persistence.data;
    diagnostics.routeTotals = { active: active.total, stale: stale.total, all: all.total };
    diagnostics.familyTotals = {};
    for (const family of FRR_BMP_ADDRESS_FAMILIES) {
        diagnostics.familyTotals[family.key] = {};
        for (const [view, filters] of [
            ['prePolicy', { scopeKind: 'peer', ribType: String(BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN) }],
            ['postPolicy', { scopeKind: 'peer', ribType: String(BmpConst.BMP_BGP_RIB_TYPE.ADJ_RIB_IN) }],
            ['locRib', { scopeKind: 'loc-rib', ribType: LOC_RIB_TYPE }]
        ]) {
            const result = await queryPersistedRoutes(request, {
                afi: family.afi,
                safi: family.safi,
                routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ALL,
                ...filters
            });
            diagnostics.familyTotals[family.key][view] = result.total;
        }
    }
    diagnostics.expected = {
        sourceRoutes: lab.expectedSourceRouteCount,
        persistedRoutes: lab.expectedPersistedRouteCount
    };
    return JSON.stringify(diagnostics, null, 2);
}

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-frr-e2e-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    const port = await getFreePort();
    const worker = new Worker(path.join(__dirname, '..', '..', 'electron', 'worker', 'bmp', 'bmpWorker.js'));
    const request = createRequester(worker);
    const lab = new FrrBmpLab({ collectorPort: port });
    let bmpStarted = false;
    let failureDiagnostics = '';

    try {
        const e2eStartedAt = Date.now();
        await lab.start({ waitForCollector: false });

        await request(BmpConst.BMP_REQ_TYPES.START_BMP, {
            port,
            bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20,
            pathMarkingTlvType: BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING,
            persistenceEnabled: true,
            persistenceDbPath: dbPath,
            persistenceBatchSize: 512,
            persistenceBatchBytes: 4 * 1024 * 1024,
            persistenceFlushMs: 10,
            persistenceHighWatermarkBytes: 64 * 1024 * 1024,
            persistenceLowWatermarkBytes: 32 * 1024 * 1024
        });
        bmpStarted = true;

        const peerSnapshot = await waitForInteropPeers(request, lab);
        validatePeerMetadata(peerSnapshot, lab);

        await waitForPersistedTotal(request, BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE, lab.expectedPersistedRouteCount);
        const ingestDurationMs = Date.now() - e2eStartedAt;
        const contexts = await loadFamilyContexts(request, peerSnapshot, lab);
        await assertFamilyMatrix(
            request,
            peerSnapshot.client,
            contexts,
            family => lab.getFamilyPlan(family.key).routes.length,
            BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE
        );
        await assertBoundarySamples(request, contexts);

        const ipv4Unicast = contexts.find(item => item.family.key === 'ipv4-unicast');
        const ipv4PrePolicy = await request(BmpConst.BMP_REQ_TYPES.GET_BGP_ROUTES, {
            client: peerSnapshot.client,
            session: ipv4Unicast.session,
            af: ipv4Unicast.af,
            ribType: BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN,
            page: 1,
            pageSize: 10,
            routeState: BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE,
            prefixFilter: ipv4Unicast.routes[0].prefix
        });
        assert.equal(ipv4PrePolicy.data.total, 1);
        assert.equal(ipv4PrePolicy.data.list[0].nextHop, lab.peerIp);
        assert.equal(String(ipv4PrePolicy.data.list[0].asPath).trim(), `${ROUTER_AS} ${PEER_AS}`);

        await waitForStatistics(request, peerSnapshot.client);

        await lab.withdrawSentinels();
        const routesAfterLiveWithdraw = lab.expectedPersistedRouteCount - lab.sentinelCount * 3;
        await waitForPersistedTotal(request, BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE, routesAfterLiveWithdraw);
        await assertFamilyMatrix(
            request,
            peerSnapshot.client,
            contexts,
            family => lab.getFamilyPlan(family.key).routes.length - (family.liveWithdraw ? 1 : 0),
            BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE
        );
        await assertLiveSentinelProjection(request, contexts, BmpConst.BMP_ROUTE_STATE_FILTER.ALL, 0);

        await lab.restoreSentinels();
        await waitForPersistedTotal(request, BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE, lab.expectedPersistedRouteCount);
        await assertLiveSentinelProjection(request, contexts, BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE, 3);

        const peerPurgeEventQuery = {
            sourceId: peerSnapshot.client.persistentSourceId || peerSnapshot.client.sourceId,
            scopeKind: 'peer',
            eventType: 'purge'
        };
        const locRibPurgeEventQuery = {
            sourceId: peerSnapshot.client.persistentSourceId || peerSnapshot.client.sourceId,
            scopeKind: 'loc-rib',
            eventType: 'purge'
        };
        const peerPurgeEventsBeforeDown = await queryPersistedRouteEvents(request, peerPurgeEventQuery);
        const locRibPurgeEventsBeforeDown = await queryPersistedRouteEvents(request, locRibPurgeEventQuery);
        assert.equal(Number(peerPurgeEventsBeforeDown.total), 0, 'FRR peer purge history must start empty');
        assert.equal(Number(locRibPurgeEventsBeforeDown.total), 0, 'FRR Loc-RIB purge history must start empty');
        await lab.shutdownPeerBgp();
        const peerDownSessions = await waitForPeerDown(request, peerSnapshot.client, lab);
        peerDownSessions.forEach(session => {
            assert.equal(
                session.peerDownReason,
                BmpConst.BMP_PEER_DOWN_REASON.REMOTE_SYSTEM_CLOSED_WITH_NOTIFICATION,
                `FRR peer ${session.sessionIp} must carry a remote BGP Notification in its Peer Down`
            );
        });

        // A valid Notification proves that both real FRR BGP neighbors are
        // down, so every peer RIB view is purged. RFC 9069 Loc-RIB instances
        // are independent and must remain online with their routes active.
        await waitForPersistedTotal(request, BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE, lab.expectedSourceRouteCount);
        await waitForPersistedTotal(request, BmpConst.BMP_ROUTE_STATE_FILTER.STALE, 0);
        await waitForPersistedTotal(request, BmpConst.BMP_ROUTE_STATE_FILTER.ALL, lab.expectedSourceRouteCount);
        await assertFamilyViewMatrix(
            request,
            peerSnapshot.client,
            contexts,
            family => {
                const expected = lab.getFamilyPlan(family.key).routes.length;
                return { prePolicy: 0, postPolicy: 0, locRib: expected };
            },
            BmpConst.BMP_ROUTE_STATE_FILTER.ACTIVE
        );
        await assertFamilyViewMatrix(
            request,
            peerSnapshot.client,
            contexts,
            () => ({ prePolicy: 0, postPolicy: 0, locRib: 0 }),
            BmpConst.BMP_ROUTE_STATE_FILTER.STALE
        );
        await assertFamilyViewMatrix(
            request,
            peerSnapshot.client,
            contexts,
            family => {
                const expected = lab.getFamilyPlan(family.key).routes.length;
                return { prePolicy: 0, postPolicy: 0, locRib: expected };
            },
            BmpConst.BMP_ROUTE_STATE_FILTER.ALL
        );

        const instancesAfterPeerDown = await request(BmpConst.BMP_REQ_TYPES.GET_BGP_INSTANCES, peerSnapshot.client);
        contexts.forEach(context => {
            const instance = instancesAfterPeerDown.data.find(
                item =>
                    (item.persistentOwnerKey || item.ownerKey) ===
                    (context.instance.persistentOwnerKey || context.instance.ownerKey)
            );
            assert.ok(instance, `${context.family.name} Loc-RIB instance must remain present`);
            assert.equal(
                instance.instanceState,
                BmpConst.BMP_SESSION_STATE.PEER_UP,
                `${context.family.name} Loc-RIB instance must remain up`
            );
            assert.equal(instance.isOnline, true, `${context.family.name} Loc-RIB instance must remain online`);
            const expected = lab.getFamilyPlan(context.family.key).routes.length;
            assert.deepEqual(
                instance.routeSummary,
                { active: expected, stale: 0, total: expected },
                `${context.family.name} Loc-RIB route summary must remain active`
            );
            assert.ok(
                (instance.routeScopes || []).length > 0,
                `${context.family.name} Loc-RIB must retain its persisted route scope`
            );
            assert.equal(
                (instance.routeScopes || []).every(scope => scope.scopeState === 'ready'),
                true,
                `${context.family.name} Loc-RIB scopes must remain ready`
            );
        });

        const expectedPeerPurgeEvents = lab.expectedSourceRouteCount * 2;
        const peerPurgeEventsAfterDown = await waitForPersistedEventTotal(
            request,
            peerPurgeEventQuery,
            expectedPeerPurgeEvents
        );
        assert.equal(
            peerPurgeEventsAfterDown.list[0].reason,
            `peer-down-notification:${BmpConst.BMP_PEER_DOWN_REASON.REMOTE_SYSTEM_CLOSED_WITH_NOTIFICATION}`,
            'FRR peer route purge history must identify the Notification Peer Down reason'
        );
        const locRibPurgeEventsAfterDown = await queryPersistedRouteEvents(request, locRibPurgeEventQuery);
        assert.equal(
            Number(locRibPurgeEventsAfterDown.total),
            0,
            'FRR Notification Peer Down must not add Loc-RIB purge events'
        );

        const persistenceStatus = await request(BmpConst.BMP_REQ_TYPES.GET_PERSISTENCE_STATUS);
        assert.equal(persistenceStatus.data.ready, true);
        assert.equal(persistenceStatus.data.journalMode, 'wal');

        console.log(
            `FRR BMP scale E2E passed: BMPv${peerSnapshot.client.bmpVersion}, ` +
                `families=${FRR_BMP_ADDRESS_FAMILIES.length}, sourceRoutes=${lab.expectedSourceRouteCount}, ` +
                `persistedRoutes=${lab.expectedPersistedRouteCount}, ` +
                `routesPerScalableFamily=${lab.routesPerFamily}, ingestMs=${ingestDurationMs}`
        );
    } catch (error) {
        failureDiagnostics = await lab.getDiagnostics().catch(() => '');
        const workerDiagnostics = await getWorkerDiagnostics(request, lab).catch(() => '');
        if (workerDiagnostics) {
            failureDiagnostics = `${failureDiagnostics}\n--- NetNexus BMP worker ---\n${workerDiagnostics}`.trim();
        }
        if (failureDiagnostics) {
            const baseStack = error.stack || error.message;
            error.message = `${error.message}\n${failureDiagnostics}`;
            error.stack = `${baseStack}\n${failureDiagnostics}`;
        }
        throw error;
    } finally {
        await lab.cleanup().catch(() => {});
        if (bmpStarted) {
            await request(BmpConst.BMP_REQ_TYPES.STOP_BMP).catch(() => {});
        }
        await worker.terminate().catch(() => {});
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
