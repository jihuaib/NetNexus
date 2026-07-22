const fs = require('fs');
const path = require('path');
const { HuaweiTelnetClient } = require('./e2e-support/huawei-telnet');
const { normalizeConfiguration, normalizeConfigurationForComparison, sha256 } = require('./huawei-bmp-baseline');

function readManifest(artifactDirectory) {
    const manifestPath = path.join(artifactDirectory, 'baseline-manifest.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Huawei BMP baseline manifest does not exist: ${manifestPath}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.devices) || manifest.devices.length !== 2) {
        throw new Error('Huawei BMP baseline manifest must contain exactly two devices');
    }
    manifest.devices = manifest.devices.map(device => {
        if (device.comparisonConfigurationSha256) return device;
        const baselinePath = path.join(artifactDirectory, device.host.replace(/[^0-9a-z.-]/giu, '_'), 'current.cfg');
        if (!fs.existsSync(baselinePath)) {
            throw new Error(`Huawei baseline configuration does not exist: ${baselinePath}`);
        }
        return {
            ...device,
            comparisonConfigurationSha256: sha256(
                normalizeConfigurationForComparison(fs.readFileSync(baselinePath, 'utf8'))
            )
        };
    });
    return manifest;
}

async function currentConfigurationState(client) {
    const configuration = normalizeConfiguration(
        await client.command('display current-configuration', { timeoutMs: 120000 })
    );
    return {
        sha256: sha256(configuration),
        comparisonSha256: sha256(normalizeConfigurationForComparison(configuration)),
        bytes: Buffer.byteLength(configuration, 'utf8')
    };
}

async function restoreDevice(device, credentials, { verifyOnly = false } = {}) {
    const client = new HuaweiTelnetClient({ host: device.host, ...credentials, timeoutMs: 30000 });
    try {
        await client.connect();
        const before = await currentConfigurationState(client);
        if (before.comparisonSha256 === device.comparisonConfigurationSha256) {
            return {
                host: device.host,
                commitId: device.commitId,
                changed: false,
                before,
                after: before,
                verified: true
            };
        }
        if (verifyOnly) {
            return {
                host: device.host,
                commitId: device.commitId,
                changed: false,
                before,
                after: before,
                verified: false
            };
        }

        const rollbackOutput = await client.interactiveCommand(
            `rollback configuration to commit-id ${device.commitId}`,
            {
                confirmations: [
                    {
                        pattern: /Continue\?\s*\[Y\/N\]:\s*$/iu,
                        response: 'y'
                    }
                ],
                timeoutMs: 180000
            }
        );
        if (/system is in trial configuration mode/iu.test(rollbackOutput)) {
            const trialStatus = await client.command('display configuration trial status', { timeoutMs: 60000 });
            throw new Error(
                `Cannot roll back ${device.host} from a different session while trial configuration is active: ${trialStatus}`
            );
        }
        const rollbackResult = await client.command('display configuration rollback result', { timeoutMs: 60000 });
        const after = await currentConfigurationState(client);
        return {
            host: device.host,
            commitId: device.commitId,
            changed: true,
            before,
            after,
            rollbackOutput,
            rollbackResult,
            verified: after.comparisonSha256 === device.comparisonConfigurationSha256
        };
    } finally {
        await client.close();
    }
}

async function main() {
    const username = process.env.NETNEXUS_HUAWEI_USERNAME;
    const password = process.env.NETNEXUS_HUAWEI_PASSWORD;
    const localAddress = process.env.NETNEXUS_HUAWEI_LOCAL_ADDRESS || undefined;
    const verifyOnly = process.env.NETNEXUS_HUAWEI_VERIFY_ONLY === '1';
    const artifactDirectory = path.resolve(process.env.NETNEXUS_HUAWEI_ARTIFACT_DIR || '.huawei-bmp-e2e/live-20260721');
    if (!username || !password) {
        throw new Error('Set NETNEXUS_HUAWEI_USERNAME and NETNEXUS_HUAWEI_PASSWORD');
    }

    const manifest = readManifest(artifactDirectory);
    const results = [];
    for (const device of manifest.devices) {
        try {
            results.push(await restoreDevice(device, { username, password, localAddress }, { verifyOnly }));
        } catch (error) {
            results.push({ host: device.host, commitId: device.commitId, verified: false, error: error.message });
        }
    }

    const report = { restoredAt: new Date().toISOString(), artifactDirectory, results };
    fs.writeFileSync(path.join(artifactDirectory, 'restore-results.json'), `${JSON.stringify(report, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (results.some(result => !result.verified)) {
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`Huawei BMP restore failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    currentConfigurationState,
    readManifest,
    restoreDevice
};
