const fs = require('fs');
const path = require('path');
const BmpConst = require('../electron/const/bmpConst');
const BgpConst = require('../electron/const/bgpConst');
const { BmpE2eController } = require('./e2e-support/bmp');
const { analyzeBmpFile } = require('./e2e-support/bmp-raw-analyzer');
const { HuaweiBmpLiveScenario } = require('./e2e-support/huawei-bmp-live-suite');
const { getScenario } = require('./e2e-support/huawei-bmp-scenarios');

const IPV4 = BgpConst.BGP_ADDR_FAMILY.IPV4_UNC;
const DRAFT_19 = BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19;
const ATTRIBUTE_PREFIX = '198.18.101.0';
const ATTRIBUTE_MED = 777;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function summarizeRoute(route) {
    if (!route) return null;
    return {
        ip: route.ip,
        prefixLength: route.prefixLength,
        med: route.med,
        localPreference: route.localPreference,
        communities: route.communities,
        asPath: route.asPath,
        routeState: route.routeState,
        staleAt: route.staleAt,
        staleReason: route.staleReason,
        parseStatus: route.parseStatus
    };
}

async function onlineTopology(live) {
    return clientTopology(live, { onlineOnly: true });
}

async function clientTopology(live, { onlineOnly = true } = {}) {
    const clientsResult = await live.controller.call('getClientList');
    const clients = (clientsResult.data || []).filter(client => !onlineOnly || client.isOnline === true);
    const topology = [];
    for (const client of clients) {
        const sessionsResult = await live.controller.call('getBgpSessions', client);
        const instancesResult = await live.controller.call('getBgpInstances', client);
        topology.push({ client, sessions: sessionsResult.data || [], instances: instancesResult.data || [] });
    }
    return topology;
}

async function queryIpv4Scopes(live, routeState = 'all') {
    const scopes = [];
    for (const { client, sessions } of await onlineTopology(live)) {
        for (const session of sessions) {
            if (!(session.enabledAddrFamilyTypes || []).includes(IPV4)) continue;
            for (const ribType of session.ribTypes || []) {
                const result = await live.controller.call('getBgpRoutes', {
                    client,
                    session,
                    af: IPV4,
                    ribType,
                    page: 1,
                    pageSize: 100,
                    routeState,
                    prefixFilter: ''
                });
                scopes.push({ client, session, ribType, result });
            }
        }
    }
    return scopes;
}

function routeReference(scope, route) {
    return `${scope}|${route.routeKey || `${route.pathId || 0}|${route.rd || '0:0'}|${route.ip}|${route.mask}`}`;
}

async function queryAllScopes(live, routeState = 'all', { onlineOnly = true } = {}) {
    const scopes = [];
    for (const { client, sessions, instances } of await clientTopology(live, { onlineOnly })) {
        const clientKey = client.persistentSourceId || client.sourceId || client.remoteIp;
        for (const session of sessions) {
            for (const af of session.enabledAddrFamilyTypes || []) {
                for (const ribType of session.ribTypes || []) {
                    const result = await live.controller.call('getBgpRoutes', {
                        client,
                        session,
                        af,
                        ribType,
                        page: 1,
                        pageSize: 100,
                        routeState,
                        prefixFilter: ''
                    });
                    scopes.push({
                        kind: 'peer',
                        key: `${clientKey}|peer|${session.sessionIp}|${af}|${ribType}`,
                        client,
                        session,
                        af,
                        ribType,
                        result
                    });
                }
            }
        }
        for (const instance of instances) {
            const result = await live.controller.call('getBgpInstanceRoutes', {
                client,
                instance,
                page: 1,
                pageSize: 100,
                routeState,
                prefixFilter: ''
            });
            scopes.push({
                kind: 'loc-rib',
                key: `${clientKey}|loc-rib|${instance.addrFamilyType}|${(instance.vrfTableNames || []).join(',')}`,
                client,
                instance,
                af: instance.addrFamilyType,
                result
            });
        }
    }
    return scopes;
}

function summarizeScopeRoutes(scopes) {
    const references = new Set();
    const routeSamples = [];
    for (const scope of scopes) {
        for (const route of scope.result.data?.list || []) {
            references.add(routeReference(scope.key, route));
            if (routeSamples.length < 20) {
                routeSamples.push({
                    scope: scope.key,
                    ip: route.ip,
                    rd: route.rd,
                    routeState: route.routeState,
                    staleReason: route.staleReason
                });
            }
        }
    }
    return { count: references.size, references, routeSamples };
}

function findPrefix(scopes, prefix = ATTRIBUTE_PREFIX, predicate = () => true) {
    for (const scope of scopes) {
        const route = (scope.result.data?.list || []).find(item => item.ip === prefix && predicate(item, scope));
        if (route) return { scope, route };
    }
    return null;
}

async function poll(description, callback, { timeoutMs = 90000, intervalMs = 2000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastValue = null;
    while (Date.now() < deadline) {
        lastValue = await callback();
        if (lastValue) return lastValue;
        await delay(intervalMs);
    }
    throw new Error(`Timed out waiting for ${description}; last=${JSON.stringify(lastValue)}`);
}

function resultStep(report, name, status, evidence = null) {
    const step = { name, status, at: new Date().toISOString(), evidence };
    report.steps.push(step);
    process.stdout.write(`[Huawei BMP lifecycle] ${name}: ${status}\n`);
    return step;
}

async function waitForPrefix(live, predicate, description) {
    return poll(description, async () => {
        const match = findPrefix(await queryIpv4Scopes(live), ATTRIBUTE_PREFIX, predicate);
        return match ? summarizeRoute(match.route) : null;
    });
}

async function switchCollector(live, port) {
    await live.controller.call('stopBmp');
    live.collectorStarted = false;
    const result = await live.controller.call('startBmp', {
        port,
        listenHost: '0.0.0.0',
        bmpV4TlvDraft: DRAFT_19,
        logLevel: 'off'
    });
    if (result.status !== 'success') throw new Error(`Unable to start collector on ${port}: ${JSON.stringify(result)}`);
    live.collectorStarted = true;
}

async function mutateExportAttributes(live, trialSeconds) {
    await live.lab.applyTrialMutation(
        0,
        [
            'system-view',
            'route-policy NETNEXUS_E2E_EXPORT_1 permit node 10',
            `apply cost ${ATTRIBUTE_MED}`,
            'apply community 65001:777 additive',
            'quit'
        ],
        { trialSeconds }
    );
}

async function setIpv4Network(live, enabled, trialSeconds) {
    const command = enabled
        ? 'network 198.18.101.0 255.255.255.0 route-policy NETNEXUS_E2E_EXPORT_1'
        : 'undo network 198.18.101.0 255.255.255.0';
    await live.lab.applyTrialMutation(0, ['system-view', 'bgp 65001', 'ipv4-family unicast', command, 'quit', 'quit'], {
        trialSeconds
    });
}

async function setIpv4PeerShutdown(live, shutdown, trialSeconds) {
    await live.lab.applyTrialMutation(
        0,
        [
            'system-view',
            'bgp 65001',
            'ipv4-family unicast',
            `${shutdown ? 'undo ' : ''}peer 11.1.1.2 enable`,
            'quit',
            'quit'
        ],
        { trialSeconds }
    );
}

async function setBmpPort(live, port, trialSeconds) {
    for (let index = 0; index < live.lab.targets.length; index += 1) {
        await live.lab.applyTrialMutation(
            index,
            ['system-view', 'bmp', `bmp-session ${live.lab.collectorHost}`, `tcp connect port ${port}`, 'quit', 'quit'],
            { trialSeconds }
        );
    }
}

async function run() {
    const scenario = getScenario('public-unicast');
    const captureRoot = path.resolve(
        process.env.NETNEXUS_HUAWEI_LIFECYCLE_CAPTURE_DIR ||
            `.huawei-bmp-e2e/live-20260721/lifecycle-capture-${new Date().toISOString().replace(/[:.]/gu, '-')}`
    );
    fs.mkdirSync(captureRoot, { recursive: true });
    const controller = new BmpE2eController({
        artifactDirectory: captureRoot,
        preserveArtifacts: true,
        captureRawBmp: true
    });
    const live = new HuaweiBmpLiveScenario({ scenario, controller });
    const trialSeconds = Number(process.env.NETNEXUS_HUAWEI_TRIAL_SECONDS || 1200);
    const alternatePort = Number(process.env.NETNEXUS_HUAWEI_ALTERNATE_BMP_PORT || live.lab.collectorPort + 1);
    const report = {
        schemaVersion: 1,
        scenario: 'lifecycle-and-mutation',
        startedAt: new Date().toISOString(),
        steps: [],
        issues: [],
        restore: []
    };
    let thrownError = null;

    try {
        await live.startCollector();
        resultStep(report, 'collector-before-bgp', 'collector-started', { port: live.lab.collectorPort });
        await live.apply({ trialSeconds });
        await live.waitForData({ timeoutMs: 120000 });
        if (live.report.setupIssues.length) throw new Error(live.report.setupIssues[0].detail);

        const initial = await waitForPrefix(live, route => route.routeState === 'active', 'initial active IPv4 route');
        resultStep(report, 'initial-route-dump', 'passed', initial);

        await mutateExportAttributes(live, trialSeconds);
        const mutated = await waitForPrefix(
            live,
            route => Number(route.med) === ATTRIBUTE_MED,
            `MED ${ATTRIBUTE_MED} propagation`
        );
        resultStep(report, 'route-attribute-change', 'passed', mutated);

        await setIpv4Network(live, false, trialSeconds);
        await poll('IPv4 route withdrawal', async () => {
            const match = findPrefix(await queryIpv4Scopes(live), ATTRIBUTE_PREFIX);
            return match ? false : true;
        });
        resultStep(report, 'route-withdraw', 'passed', { prefix: ATTRIBUTE_PREFIX });

        await setIpv4Network(live, true, trialSeconds);
        const reAdvertised = await waitForPrefix(
            live,
            route => Number(route.med) === ATTRIBUTE_MED && route.routeState === 'active',
            'IPv4 route re-advertisement'
        );
        resultStep(report, 'route-readvertise', 'passed', reAdvertised);

        await setIpv4PeerShutdown(live, true, trialSeconds);
        const staleMatch = await poll('Peer Down stale routes', async () => {
            const scopes = await queryIpv4Scopes(live, 'stale');
            return findPrefix(scopes, ATTRIBUTE_PREFIX, route => route.routeState === 'stale');
        });
        resultStep(report, 'peer-down-route-aging', 'passed', summarizeRoute(staleMatch.route));

        const purgeResult = await live.controller.call('purgeStaleBgpRoutes', {
            client: staleMatch.scope.client,
            session: staleMatch.scope.session,
            af: IPV4,
            ribType: staleMatch.scope.ribType
        });
        if (purgeResult.status !== 'success')
            throw new Error(`Stale route purge failed: ${JSON.stringify(purgeResult)}`);
        await poll('stale route purge', async () => {
            const staleScopes = await queryIpv4Scopes(live, 'stale');
            return findPrefix(staleScopes, ATTRIBUTE_PREFIX) ? false : true;
        });
        resultStep(report, 'stale-route-purge', 'passed', purgeResult.data);

        await setIpv4PeerShutdown(live, false, trialSeconds);
        await live.lab.waitForPublicPeers({ timeoutMs: 90000 });
        const recovered = await waitForPrefix(live, route => route.routeState === 'active', 'Peer Up route recovery');
        resultStep(report, 'peer-up-recovery', 'passed', recovered);

        const beforeBmpChange = summarizeScopeRoutes(await queryAllScopes(live, 'active'));
        if (beforeBmpChange.count === 0)
            throw new Error('No active routes existed before the BMP configuration change');
        resultStep(report, 'bmp-config-change-active-snapshot', 'passed', {
            activeRoutes: beforeBmpChange.count,
            samples: beforeBmpChange.routeSamples
        });

        await setBmpPort(live, alternatePort, trialSeconds);
        await poll('all BMP clients offline after device BMP port change', async () => {
            const clients = await live.controller.call('getClientList');
            return (clients.data || []).every(client => client.isOnline !== true);
        });
        let allStale = null;
        try {
            allStale = await poll(
                'all routes stale after BMP configuration change',
                async () => {
                    const stale = summarizeScopeRoutes(await queryAllScopes(live, 'stale', { onlineOnly: false }));
                    const missing = [...beforeBmpChange.references].filter(
                        reference => !stale.references.has(reference)
                    );
                    return missing.length === 0 ? { stale, missing } : false;
                },
                { timeoutMs: 15000, intervalMs: 1000 }
            );
            resultStep(report, 'bmp-config-change-peer-down-all-route-aging', 'passed', {
                activeBefore: beforeBmpChange.count,
                staleAfter: allStale.stale.count,
                samples: allStale.stale.routeSamples
            });
        } catch (error) {
            const stale = summarizeScopeRoutes(await queryAllScopes(live, 'stale', { onlineOnly: false }));
            const missing = [...beforeBmpChange.references].filter(reference => !stale.references.has(reference));
            const evidence = {
                activeBefore: beforeBmpChange.count,
                staleAfter: stale.count,
                missingCount: missing.length,
                missing,
                staleSamples: stale.routeSamples
            };
            report.issues.push({
                detail: 'BMP configuration change did not age every previously active route',
                evidence
            });
            resultStep(report, 'bmp-config-change-peer-down-all-route-aging', 'failed', evidence);
        }

        await switchCollector(live, alternatePort);
        await live.waitForData({ timeoutMs: 180000 });
        if (live.report.setupIssues.length) throw new Error(live.report.setupIssues.at(-1).detail);
        resultStep(report, 'bmp-port-change', 'passed', { from: live.lab.collectorPort, to: alternatePort });

        await setBmpPort(live, live.lab.collectorPort, trialSeconds);
        await switchCollector(live, live.lab.collectorPort);
        await live.waitForData({ timeoutMs: 180000 });
        if (live.report.setupIssues.length) throw new Error(live.report.setupIssues.at(-1).detail);
        resultStep(report, 'bmp-config-restore-and-redump', 'passed', { port: live.lab.collectorPort });

        await live.controller.call('stopBmp');
        live.collectorStarted = false;
        await poll('all BMP clients offline after collector stop', async () => {
            const clients = await live.controller.call('getClientList');
            return (clients.data || []).every(client => client.isOnline !== true);
        });
        resultStep(report, 'bmp-stop-after-bgp', 'passed');

        await switchCollector(live, live.lab.collectorPort);
        await live.waitForData({ timeoutMs: 180000 });
        if (live.report.setupIssues.length) throw new Error(live.report.setupIssues.at(-1).detail);
        resultStep(report, 'bmp-start-and-redump', 'passed', { port: live.lab.collectorPort });
    } catch (error) {
        thrownError = error;
        report.issues.push({ detail: error.message, stack: error.stack });
        resultStep(report, 'scenario', 'failed', { detail: error.message });
    } finally {
        try {
            report.restore = await live.cleanup();
        } catch (error) {
            thrownError ||= error;
            report.issues.push({ detail: `Cleanup failed: ${error.message}`, stack: error.stack });
        }
        report.finishedAt = new Date().toISOString();
        report.restored = report.restore.length === 2 && report.restore.every(result => result.verified);
        const captureFiles = fs.existsSync(controller.persistenceTempDir)
            ? fs
                  .readdirSync(controller.persistenceTempDir)
                  .filter(name => name.endsWith('.bin'))
                  .map(name => path.join(controller.persistenceTempDir, name))
            : [];
        report.rawCaptures = captureFiles.map(filePath => ({ filePath, analysis: analyzeBmpFile(filePath) }));
        report.peerDownNotifications = report.rawCaptures.reduce(
            (sum, capture) =>
                sum + Number(capture.analysis.messageTypes[BmpConst.BMP_MSG_TYPE.PEER_DOWN_NOTIFICATION] || 0),
            0
        );
        const reportPath = path.join(live.lab.artifactDirectory, 'scenario-lifecycle-and-mutation.json');
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        process.stdout.write(`Huawei BMP lifecycle report: ${reportPath}\n`);
        if (!report.restored) process.exitCode = 1;
    }
    if (thrownError) throw thrownError;
}

if (require.main === module) {
    run().catch(error => {
        process.stderr.write(`Huawei BMP lifecycle E2E failed: ${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    clientTopology,
    findPrefix,
    onlineTopology,
    poll,
    queryAllScopes,
    queryIpv4Scopes,
    run,
    summarizeScopeRoutes,
    summarizeRoute
};
