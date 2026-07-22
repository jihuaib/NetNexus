const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const artifactDirectory = path.resolve(process.env.NETNEXUS_HUAWEI_ARTIFACT_DIR || '.huawei-bmp-e2e/live-20260721');
const forwardedPlaywrightArgs = process.argv.slice(2);
let activeChild = null;
let stopRequested = false;

function timestamp() {
    return new Date().toISOString();
}

function childEnvironment(overrides = {}) {
    return { ...process.env, ...overrides };
}

function runStage(name, executable, args, env = {}) {
    const startedAt = timestamp();
    const startedMs = Date.now();
    process.stdout.write(`\n========== Huawei BMP full E2E: ${name} ==========\n`);

    return new Promise(resolve => {
        const child = spawn(executable, args, {
            cwd: projectRoot,
            env: childEnvironment(env),
            stdio: 'inherit',
            windowsHide: false
        });
        activeChild = child;
        let spawnError = null;
        child.once('error', error => {
            spawnError = error;
        });
        child.once('close', (code, signal) => {
            activeChild = null;
            const result = {
                name,
                startedAt,
                finishedAt: timestamp(),
                durationMs: Date.now() - startedMs,
                code: Number.isInteger(code) ? code : null,
                signal: signal || null,
                error: spawnError?.message || null,
                passed: code === 0 && !signal && !spawnError
            };
            process.stdout.write(
                `========== ${name}: ${result.passed ? 'PASSED' : 'FAILED'} (${result.durationMs} ms) ==========\n`
            );
            resolve(result);
        });
    });
}

function writeSummary(summary) {
    fs.mkdirSync(artifactDirectory, { recursive: true });
    const summaryPath = path.join(artifactDirectory, 'full-suite-summary.json');
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(`\nHuawei BMP full E2E summary: ${summaryPath}\n`);
    return summaryPath;
}

function requestStop(signal) {
    if (stopRequested) return;
    stopRequested = true;
    process.stderr.write(`\nReceived ${signal}; stopping after the active stage and restoring the device baseline.\n`);
    if (activeChild) activeChild.kill(signal);
}

process.once('SIGINT', () => requestStop('SIGINT'));
process.once('SIGTERM', () => requestStop('SIGTERM'));

async function main() {
    const node = process.execPath;
    const electron = require('electron');
    const playwrightCli = path.join(projectRoot, 'node_modules', '@playwright', 'test', 'cli.js');
    const summary = {
        schemaVersion: 1,
        startedAt: timestamp(),
        artifactDirectory,
        stages: [],
        stopped: false
    };

    const preflight = await runStage(
        'baseline preflight',
        node,
        [path.join(projectRoot, 'scripts', 'huawei-bmp-restore.js')],
        { NETNEXUS_HUAWEI_VERIFY_ONLY: '1' }
    );
    summary.stages.push(preflight);
    if (!preflight.passed) {
        summary.finishedAt = timestamp();
        summary.result = 'preflight-failed';
        summary.summaryPath = writeSummary(summary);
        process.exitCode = 1;
        return;
    }

    const stages = [
        {
            name: 'lifecycle and mutation',
            executable: node,
            args: [path.join(projectRoot, 'scripts', 'huawei-bmp-lifecycle-e2e.js')]
        },
        {
            name: 'VPN and private initial-dump repetitions',
            executable: node,
            args: [path.join(projectRoot, 'scripts', 'huawei-bmp-vpn-flake-e2e.js')]
        },
        {
            name: 'Loc-RIB all/add-path/path-marking raw validation',
            executable: node,
            args: [path.join(projectRoot, 'scripts', 'huawei-bmp-loc-rib-modes-e2e.js')]
        },
        {
            name: 'all real-device UI scenarios',
            executable: electron,
            args: [
                playwrightCli,
                'test',
                'test/e2e/bmp-huawei-live.spec.js',
                'test/e2e/bmp-huawei-loc-rib-modes-live.spec.js',
                '--workers=1',
                ...forwardedPlaywrightArgs
            ],
            env: {
                E2E_TARGET: 'browser',
                E2E_SKIP_PACK: '1',
                HUAWEI_BMP_E2E: '1',
                NETNEXUS_BMP_E2E_LISTEN_HOST: '0.0.0.0',
                ELECTRON_RUN_AS_NODE: '1'
            }
        }
    ];

    try {
        for (const stage of stages) {
            if (stopRequested) break;
            summary.stages.push(await runStage(stage.name, stage.executable, stage.args, stage.env));
        }
    } finally {
        summary.stages.push(
            await runStage(
                'final baseline restore and verification',
                node,
                [path.join(projectRoot, 'scripts', 'huawei-bmp-restore.js')],
                { NETNEXUS_HUAWEI_VERIFY_ONLY: '0' }
            )
        );
    }

    summary.stopped = stopRequested;
    summary.finishedAt = timestamp();
    summary.result = !stopRequested && summary.stages.every(stage => stage.passed) ? 'passed' : 'failed';
    summary.summaryPath = writeSummary(summary);
    if (summary.result !== 'passed') process.exitCode = 1;
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`Huawei BMP full E2E failed: ${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { childEnvironment, runStage, writeSummary };
