const fs = require('fs');
const path = require('path');
const BmpConst = require('../electron/const/bmpConst');
const { BmpE2eController } = require('./e2e-support/bmp');
const { analyzeBmpFile } = require('./e2e-support/bmp-raw-analyzer');
const { HuaweiBmpLiveScenario } = require('./e2e-support/huawei-bmp-live-suite');
const { getScenario, SCENARIO_DEVICE_PROFILES } = require('./e2e-support/huawei-bmp-scenarios');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function safeName(value) {
    return String(value).replace(/[^0-9a-z._-]/giu, '-');
}

function flattenScopes(devices) {
    return devices.flatMap(device =>
        device.sessions.flatMap(session =>
            session.routes.map(route => ({
                device: device.remoteIp,
                sessionIp: session.sessionIp,
                vrfs: session.vrfTableNames,
                af: route.af,
                ribType: route.ribType,
                total: route.total,
                summary: route.summary,
                samples: route.samples
            }))
        )
    );
}

function scopeKey(scope) {
    return [scope.device, scope.sessionIp, (scope.vrfs || []).join(','), scope.af, scope.ribType].join('|');
}

function expectedScopeKeys(devices, scenario) {
    const keys = [];
    for (const device of devices) {
        for (const session of device.sessions) {
            for (const family of scenario.families) {
                const familyEnabled = (session.addressFamilies || []).includes(family.af);
                const vrfs = session.vrfTableNames || [];
                const vrfMatches = family.vrf ? vrfs.includes(family.vrf) : !vrfs.length || vrfs.includes('global');
                if (!familyEnabled || !vrfMatches) continue;
                for (const ribType of session.ribTypes || []) {
                    if (ribType === BmpConst.BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN && !family.prePolicy) continue;
                    keys.push(
                        scopeKey({
                            device: device.remoteIp,
                            sessionIp: session.sessionIp,
                            vrfs,
                            af: family.af,
                            ribType
                        })
                    );
                }
            }
        }
    }
    return [...new Set(keys)];
}

async function collectDeviceEvidence(live) {
    const evidence = [];
    for (let index = 0; index < live.lab.clients.length; index += 1) {
        const profile = SCENARIO_DEVICE_PROFILES[index];
        const commands = [
            'display bgp bmp-monitor all',
            'display bmp session',
            'display bgp vpnv4 all peer',
            'display bgp vpnv6 all peer',
            'display bgp vpnv4 all routing-table',
            'display bgp vpnv6 all routing-table',
            `display bgp vpnv4 all routing-table peer ${profile.publicPeerIpv4} advertised-routes`,
            `display bgp vpnv6 all routing-table peer ${profile.publicPeerIpv4} advertised-routes`,
            `display bgp vpnv4 vpn-instance NETNEXUS_E2E routing-table peer ${profile.privatePeerIpv4} advertised-routes`,
            `display bgp vpnv6 vpn-instance NETNEXUS_E2E routing-table peer ${profile.privatePeerIpv6} advertised-routes`
        ];
        const item = { host: live.lab.targets[index], commands: {} };
        for (const command of commands) {
            item.commands[command] = await live.lab.runCommand(index, command, {
                allowError: true,
                timeoutMs: 120000
            });
        }
        evidence.push(item);
    }
    return evidence;
}

async function collectPersistenceEvidence(controller, prefixes) {
    const status = await controller.call('getPersistenceStatus');
    const events = {};
    for (const prefix of prefixes) {
        events[prefix] = await controller.call('getPersistedRouteEvents', {
            groupByRoute: true,
            prefixExact: prefix,
            pageSize: 100,
            includeTotal: true
        });
    }
    return { status, events };
}

async function runIteration(index, rootDirectory, durationMs) {
    const iterationDirectory = path.join(rootDirectory, `iteration-${String(index).padStart(2, '0')}`);
    fs.mkdirSync(iterationDirectory, { recursive: true });
    const controller = new BmpE2eController({
        artifactDirectory: iterationDirectory,
        preserveArtifacts: true,
        captureRawBmp: true
    });
    const scenario = getScenario('vpn-and-private');
    const live = new HuaweiBmpLiveScenario({ scenario, controller });
    const report = {
        iteration: index,
        startedAt: new Date().toISOString(),
        durationMs,
        scopeTimeline: [],
        firstSeenAtMs: {},
        missingScopes: [],
        setupIssues: []
    };
    const startedAt = Date.now();
    try {
        await live.startCollector();
        await live.apply({ trialSeconds: Number(process.env.NETNEXUS_HUAWEI_TRIAL_SECONDS || 900) });
        const deadline = Date.now() + durationMs;
        while (Date.now() < deadline) {
            const clients = await live.getOnlineClients();
            const devices = [];
            for (const client of clients.slice(0, 2)) devices.push(await live.collectDevice(client));
            const scopes = flattenScopes(devices);
            const atMs = Date.now() - startedAt;
            for (const scope of scopes) {
                if (scope.total > 0 && report.firstSeenAtMs[scopeKey(scope)] === undefined) {
                    report.firstSeenAtMs[scopeKey(scope)] = atMs;
                }
            }
            report.scopeTimeline.push({
                atMs,
                clients: clients.length,
                scopes: scopes.map(scope => ({ ...scope, samples: undefined }))
            });
            await delay(2000);
        }
        const clients = await live.getOnlineClients();
        report.devices = [];
        for (const client of clients.slice(0, 2)) report.devices.push(await live.collectDevice(client));
        const expected = expectedScopeKeys(report.devices, scenario);
        const finalScopes = new Map(flattenScopes(report.devices).map(scope => [scopeKey(scope), scope]));
        report.missingScopes = expected.filter(key => (finalScopes.get(key)?.total || 0) === 0);
        report.deviceEvidence = await collectDeviceEvidence(live);
        report.persistence = await collectPersistenceEvidence(controller, scenario.expectedPrefixes);
        const timelinePath = path.join(iterationDirectory, 'controller-timeline.jsonl');
        fs.writeFileSync(timelinePath, `${controller.timeline.map(entry => JSON.stringify(entry)).join('\n')}\n`, {
            encoding: 'utf8',
            mode: 0o600
        });
        report.controllerTimelinePath = timelinePath;
    } catch (error) {
        report.setupIssues.push({ message: error.message, stack: error.stack });
    } finally {
        try {
            report.restore = await live.cleanup();
        } catch (error) {
            report.setupIssues.push({ message: `cleanup: ${error.message}`, stack: error.stack });
        }
    }

    const captureDirectory = controller.persistenceTempDir;
    const captureFiles = fs.existsSync(captureDirectory)
        ? fs
              .readdirSync(captureDirectory)
              .filter(name => name.endsWith('.bin'))
              .map(name => path.join(captureDirectory, name))
        : [];
    report.rawCaptures = captureFiles.map(filePath => ({
        filePath,
        analysis: analyzeBmpFile(filePath)
    }));
    report.rawEorOnlyScopes = report.rawCaptures.flatMap(capture =>
        capture.analysis.routeScopes
            .filter(scope => scope.peerType !== 3 && scope.eor > 0 && scope.announced === 0)
            .map(scope => ({ filePath: capture.filePath, ...scope }))
    );
    report.finishedAt = new Date().toISOString();
    report.restored = report.restore?.length === 2 && report.restore.every(item => item.verified === true);
    const reportPath = path.join(iterationDirectory, 'report.json');
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return {
        iteration: index,
        reportPath,
        missingScopes: report.missingScopes,
        setupIssues: report.setupIssues,
        restored: report.restored,
        rawCaptureFiles: captureFiles.map(filePath => safeName(path.basename(filePath)))
    };
}

async function main() {
    const iterations = Math.max(1, Number(process.env.NETNEXUS_HUAWEI_FLAKE_ITERATIONS || 5));
    const durationMs = Math.max(10000, Number(process.env.NETNEXUS_HUAWEI_FLAKE_DURATION_MS || 60000));
    const rootDirectory = path.resolve(
        process.env.NETNEXUS_HUAWEI_FLAKE_ARTIFACT_DIR ||
            `.huawei-bmp-e2e/live-20260721/vpn-flake-${new Date().toISOString().replace(/[:.]/gu, '-')}`
    );
    fs.mkdirSync(rootDirectory, { recursive: true });
    const summary = {
        startedAt: new Date().toISOString(),
        iterations,
        durationMs,
        results: []
    };
    for (let index = 1; index <= iterations; index += 1) {
        process.stdout.write(`[VPN flake] iteration ${index}/${iterations}\n`);
        const result = await runIteration(index, rootDirectory, durationMs);
        summary.results.push(result);
        process.stdout.write(
            `${JSON.stringify({
                iteration: result.iteration,
                missingScopes: result.missingScopes.length,
                setupIssues: result.setupIssues.length,
                restored: result.restored
            })}\n`
        );
    }
    summary.finishedAt = new Date().toISOString();
    const summaryPath = path.join(rootDirectory, 'summary.json');
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(`VPN flake summary: ${summaryPath}\n`);
    if (summary.results.some(result => result.missingScopes.length || result.setupIssues.length || !result.restored)) {
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`Huawei BMP VPN flake diagnostic failed: ${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { collectDeviceEvidence, expectedScopeKeys, flattenScopes, runIteration, scopeKey };
