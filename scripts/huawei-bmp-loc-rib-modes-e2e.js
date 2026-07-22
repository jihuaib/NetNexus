const fs = require('fs');
const path = require('path');
const { BmpE2eController } = require('./e2e-support/bmp');
const { analyzeBmpFile } = require('./e2e-support/bmp-raw-analyzer');
const { HuaweiBmpLiveScenario } = require('./e2e-support/huawei-bmp-live-suite');
const { getScenario } = require('./e2e-support/huawei-bmp-scenarios');

const MODES = Object.freeze(['all', 'all path-marking', 'add-path', 'add-path path-marking']);

function safeName(value) {
    return String(value).replace(/[^0-9a-z._-]/giu, '-');
}

function buildModeScenario(mode) {
    const base = getScenario('public-unicast');
    return {
        ...base,
        key: `loc-rib-${safeName(mode)}`,
        name: `Public IPv4/IPv6 Loc-RIB mode: ${mode}`,
        locRibMode: mode,
        buildCommands(profile, context) {
            const commands = base.buildCommands(profile, context);
            const output = [];
            for (const command of commands) {
                if (mode.startsWith('add-path') && command === 'system-view') {
                    output.push(command);
                    output.push('interface GigabitEthernet0/7/1');
                    output.push(`ip address ${profile.secondaryLocalIpv4} 255.255.255.0 sub`);
                    output.push('quit');
                    continue;
                }
                if (/^route-mode (?:ipv4|ipv6)-family unicast local-rib all$/u.test(command)) {
                    output.push(command.replace(/local-rib all$/u, `local-rib ${mode}`));
                    continue;
                }
                output.push(command);
                if (
                    mode.startsWith('add-path') &&
                    command === `peer ${profile.publicPeerIpv4} as-number ${profile.peerAsn}`
                ) {
                    output.push(`peer ${profile.secondaryPeerIpv4} as-number ${profile.peerAsn}`);
                }
                if (mode.startsWith('add-path') && command === `peer ${profile.publicPeerIpv4} keep-all-routes`) {
                    output.push(`peer ${profile.publicPeerIpv4} capability-advertise add-path both`);
                    output.push(`peer ${profile.publicPeerIpv4} advertise add-path path-number 2`);
                    output.push('bestroute add-path path-number 2');
                    output.push('maximum load-balancing ebgp 2');
                    output.push(`peer ${profile.secondaryPeerIpv4} enable`);
                    output.push(`peer ${profile.secondaryPeerIpv4} keep-all-routes`);
                    output.push(
                        `peer ${profile.secondaryPeerIpv4} route-policy NETNEXUS_E2E_IMPORT_${profile.index + 1} import`
                    );
                    output.push(`peer ${profile.secondaryPeerIpv4} capability-advertise add-path both`);
                    output.push(`peer ${profile.secondaryPeerIpv4} advertise add-path path-number 2`);
                }
                if (mode.startsWith('add-path') && command === `peer ${profile.publicPeerIpv6} keep-all-routes`) {
                    output.push(`peer ${profile.publicPeerIpv6} capability-advertise add-path both`);
                    output.push(`peer ${profile.publicPeerIpv6} advertise add-path path-number 2`);
                    output.push('bestroute add-path path-number 2');
                }
            }
            return output;
        }
    };
}

function summarizeModeReport(live, rawCaptures, mode) {
    const locRoutes = live.report.devices.flatMap(device =>
        device.locRib.flatMap(instance =>
            instance.samples.map(route => ({
                device: device.remoteIp,
                af: instance.af,
                ip: route.ip,
                pathId: route.pathId,
                isAddPath: route.isAddPath,
                pathStatus: route.pathStatus,
                pathStatusText: route.pathStatusText,
                pathStatusReasonText: route.pathStatusReasonText
            }))
        )
    );
    const locTotals = live.report.devices.flatMap(device =>
        device.locRib.map(instance => ({
            device: device.remoteIp,
            af: instance.af,
            total: instance.total,
            isAddPath: instance.isAddPath,
            addPathMap: instance.addPathMap
        }))
    );
    const pathMarkingTlvs = rawCaptures.reduce((sum, capture) => sum + capture.analysis.pathMarkingTlvs, 0);
    const issues = [];
    if (!locTotals.length || locTotals.some(item => item.total === 0)) {
        issues.push('Loc-RIB route data is missing for at least one device/address family');
    }
    if (mode.includes('path-marking') && pathMarkingTlvs === 0) {
        issues.push('Huawei accepted path-marking but no Path Marking TLV was observed');
    }
    const addPathObserved =
        locTotals.some(instance => instance.isAddPath === true) ||
        locRoutes.some(
            route =>
                Number(route.pathId) > 0 ||
                route.isAddPath === true ||
                String(route.pathStatusText || '').includes('Add-Path')
        );
    if (mode.startsWith('add-path') && !addPathObserved) {
        issues.push('Huawei accepted add-path but neither the Loc-RIB instance nor route status reported ADD-PATH');
    }
    const pathIdsByPrefix = new Map();
    for (const route of locRoutes) {
        const key = `${route.device}|${route.af}|${route.ip}`;
        if (!pathIdsByPrefix.has(key)) pathIdsByPrefix.set(key, new Set());
        pathIdsByPrefix.get(key).add(Number(route.pathId));
    }
    const multiPathPrefixes = [...pathIdsByPrefix.entries()]
        .filter(([, pathIds]) => pathIds.size > 1)
        .map(([prefix, pathIds]) => ({ prefix, pathIds: [...pathIds].sort((a, b) => a - b) }));
    if (mode.startsWith('add-path') && multiPathPrefixes.length === 0) {
        issues.push('The ADD-PATH topology did not expose two Path IDs for the same Loc-RIB prefix');
    }
    return { locTotals, locRoutes, pathMarkingTlvs, addPathObserved, multiPathPrefixes, issues };
}

async function runMode(mode, rootDirectory) {
    const modeDirectory = path.join(rootDirectory, safeName(mode));
    fs.mkdirSync(modeDirectory, { recursive: true });
    const controller = new BmpE2eController({
        artifactDirectory: modeDirectory,
        preserveArtifacts: true,
        captureRawBmp: true
    });
    const live = new HuaweiBmpLiveScenario({ scenario: buildModeScenario(mode), controller });
    const result = { mode, startedAt: new Date().toISOString(), setupIssues: [] };
    try {
        await live.startCollector();
        await live.apply({ trialSeconds: Number(process.env.NETNEXUS_HUAWEI_TRIAL_SECONDS || 900) });
        await live.waitForData({ timeoutMs: Number(process.env.NETNEXUS_HUAWEI_LOC_RIB_MODE_TIMEOUT_MS || 90000) });
        await live.collectFinal();
    } catch (error) {
        result.setupIssues.push({ message: error.message, stack: error.stack });
    } finally {
        try {
            result.restore = await live.cleanup();
        } catch (error) {
            result.setupIssues.push({ message: `cleanup: ${error.message}`, stack: error.stack });
        }
    }
    const captureFiles = fs.existsSync(controller.persistenceTempDir)
        ? fs
              .readdirSync(controller.persistenceTempDir)
              .filter(name => name.endsWith('.bin'))
              .map(name => path.join(controller.persistenceTempDir, name))
        : [];
    result.rawCaptures = captureFiles.map(filePath => ({ filePath, analysis: analyzeBmpFile(filePath) }));
    result.observations = summarizeModeReport(live, result.rawCaptures, mode);
    result.devices = live.report.devices;
    result.deviceState = live.report.deviceState;
    result.restored = result.restore?.length === 2 && result.restore.every(item => item.verified === true);
    result.finishedAt = new Date().toISOString();
    const reportPath = path.join(modeDirectory, 'report.json');
    fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return {
        mode,
        reportPath,
        setupIssues: result.setupIssues.length,
        observations: result.observations,
        restored: result.restored
    };
}

async function main() {
    const configuredModes = String(process.env.NETNEXUS_HUAWEI_LOC_RIB_MODES || MODES.join(','))
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
    const rootDirectory = path.resolve(
        process.env.NETNEXUS_HUAWEI_LOC_RIB_ARTIFACT_DIR ||
            `.huawei-bmp-e2e/live-20260721/loc-rib-modes-${new Date().toISOString().replace(/[:.]/gu, '-')}`
    );
    fs.mkdirSync(rootDirectory, { recursive: true });
    const summary = { startedAt: new Date().toISOString(), modes: configuredModes, results: [] };
    for (const mode of configuredModes) {
        process.stdout.write(`[Loc-RIB mode] ${mode}\n`);
        const result = await runMode(mode, rootDirectory);
        summary.results.push(result);
        process.stdout.write(
            `${JSON.stringify({
                mode,
                issues: result.observations.issues,
                pathMarkingTlvs: result.observations.pathMarkingTlvs,
                restored: result.restored
            })}\n`
        );
    }
    summary.finishedAt = new Date().toISOString();
    const summaryPath = path.join(rootDirectory, 'summary.json');
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(`Loc-RIB mode summary: ${summaryPath}\n`);
    if (
        summary.results.some(result => result.setupIssues || result.observations.issues.length > 0 || !result.restored)
    ) {
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`Huawei BMP Loc-RIB mode E2E failed: ${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { MODES, buildModeScenario, runMode, summarizeModeReport };
