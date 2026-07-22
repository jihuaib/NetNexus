const fs = require('fs');
const path = require('path');
const { HuaweiTelnetClient } = require('./e2e-support/huawei-telnet');
const { readManifest, restoreDevice } = require('./huawei-bmp-restore');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function trialActive(output) {
    return /Trial status:\s*ACTIVE/iu.test(String(output || ''));
}

async function getTrialStatus(device, credentials) {
    const client = new HuaweiTelnetClient({ host: device.host, ...credentials, timeoutMs: 30000 });
    try {
        await client.connect();
        return await client.command('display configuration trial status', { timeoutMs: 60000 });
    } finally {
        await client.close();
    }
}

async function main() {
    const username = process.env.NETNEXUS_HUAWEI_USERNAME;
    const password = process.env.NETNEXUS_HUAWEI_PASSWORD;
    const localAddress = process.env.NETNEXUS_HUAWEI_LOCAL_ADDRESS || undefined;
    if (!username || !password) throw new Error('Set Huawei username and password environment variables');
    const credentials = { username, password, localAddress };
    const artifactDirectory = path.resolve(process.env.NETNEXUS_HUAWEI_ARTIFACT_DIR || '.huawei-bmp-e2e/live-20260721');
    const manifest = readManifest(artifactDirectory);
    const pollMs = Number(process.env.NETNEXUS_HUAWEI_TRIAL_POLL_MS || 30000);
    const deadline = Date.now() + Number(process.env.NETNEXUS_HUAWEI_TRIAL_WAIT_MS || 25 * 60 * 1000);
    const observations = [];

    while (Date.now() < deadline) {
        const statuses = [];
        for (const device of manifest.devices) {
            const output = await getTrialStatus(device, credentials);
            statuses.push({ host: device.host, active: trialActive(output), output });
        }
        const observation = { at: new Date().toISOString(), statuses };
        observations.push(observation);
        process.stdout.write(
            `${observation.at} ${statuses.map(item => `${item.host}=${item.active ? 'ACTIVE' : 'INACTIVE'}`).join(' ')}\n`
        );
        if (statuses.every(item => !item.active)) break;
        await delay(pollMs);
    }

    if (observations.at(-1)?.statuses.some(item => item.active)) {
        throw new Error('Timed out waiting for Huawei trial configurations to leave ACTIVE state');
    }

    const results = [];
    for (const device of manifest.devices) {
        results.push(await restoreDevice(device, credentials, { verifyOnly: false }));
    }
    const report = {
        restoredAt: new Date().toISOString(),
        artifactDirectory,
        observations,
        results,
        verified: results.length === 2 && results.every(result => result.verified)
    };
    const reportPath = path.join(artifactDirectory, 'trial-wait-restore-results.json');
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ reportPath, verified: report.verified, results }, null, 2)}\n`);
    if (!report.verified) process.exitCode = 1;
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`Huawei trial wait/restore failed: ${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { getTrialStatus, main, trialActive };
