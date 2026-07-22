const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { HuaweiTelnetClient } = require('./e2e-support/huawei-telnet');

function parseTargets(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function normalizeConfiguration(value) {
    return String(value || '')
        .replace(/\r\n/gu, '\n')
        .trim();
}

function normalizeConfigurationForComparison(value) {
    return normalizeConfiguration(value)
        .split('\n')
        .filter(line => !/^!Last configuration was updated at /u.test(line))
        .join('\n');
}

function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function latestCommitId(output) {
    const match = String(output || '').match(/^\s*1\s+(\d{10})\s+/mu);
    if (!match) {
        throw new Error('Unable to determine the latest Huawei configuration commit-id');
    }
    return match[1];
}

function defaultArtifactDirectory() {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    return path.resolve('.huawei-bmp-e2e', stamp);
}

async function captureDeviceBaseline(host, credentials, artifactDirectory) {
    const client = new HuaweiTelnetClient({ host, ...credentials, timeoutMs: 30000 });
    try {
        await client.connect();
        const commitList = await client.command('display configuration commit list 1', { timeoutMs: 60000 });
        const currentConfiguration = await client.command('display current-configuration', { timeoutMs: 120000 });
        const startup = await client.command('display startup', { timeoutMs: 60000 });
        const version = await client.command('display version', { timeoutMs: 60000 });
        const normalizedConfiguration = normalizeConfiguration(currentConfiguration);
        const metadata = {
            host,
            capturedAt: new Date().toISOString(),
            commitId: latestCommitId(commitList),
            currentConfigurationSha256: sha256(normalizedConfiguration),
            comparisonConfigurationSha256: sha256(normalizeConfigurationForComparison(normalizedConfiguration)),
            currentConfigurationBytes: Buffer.byteLength(normalizedConfiguration, 'utf8'),
            version: String(version).split(/\r?\n/u).slice(0, 3).join('\n'),
            startup
        };
        const deviceDirectory = path.join(artifactDirectory, host.replace(/[^0-9a-z.-]/giu, '_'));
        fs.mkdirSync(deviceDirectory, { recursive: true });
        fs.writeFileSync(path.join(deviceDirectory, 'current.cfg'), `${normalizedConfiguration}\n`, {
            encoding: 'utf8',
            mode: 0o600
        });
        fs.writeFileSync(path.join(deviceDirectory, 'commit-list.txt'), `${commitList.trim()}\n`, {
            encoding: 'utf8',
            mode: 0o600
        });
        fs.writeFileSync(path.join(deviceDirectory, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600
        });
        return metadata;
    } finally {
        await client.close();
    }
}

async function main() {
    const targets = parseTargets(process.env.NETNEXUS_HUAWEI_TARGETS);
    const username = process.env.NETNEXUS_HUAWEI_USERNAME;
    const password = process.env.NETNEXUS_HUAWEI_PASSWORD;
    const localAddress = process.env.NETNEXUS_HUAWEI_LOCAL_ADDRESS || undefined;
    if (targets.length !== 2 || !username || !password) {
        throw new Error('Set exactly two NETNEXUS_HUAWEI_TARGETS plus username and password environment variables');
    }

    const artifactDirectory = path.resolve(process.env.NETNEXUS_HUAWEI_ARTIFACT_DIR || defaultArtifactDirectory());
    const manifestPath = path.join(artifactDirectory, 'baseline-manifest.json');
    if (fs.existsSync(manifestPath) && process.env.NETNEXUS_HUAWEI_BASELINE_REPLACE !== '1') {
        throw new Error(`Baseline already exists; refusing to overwrite ${manifestPath}`);
    }
    fs.mkdirSync(artifactDirectory, { recursive: true });
    const devices = [];
    for (const host of targets) {
        devices.push(await captureDeviceBaseline(host, { username, password, localAddress }, artifactDirectory));
    }

    const manifest = {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        artifactDirectory,
        devices
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
    });
    process.stdout.write(
        `${JSON.stringify(
            {
                artifactDirectory,
                devices: devices.map(device => ({
                    host: device.host,
                    commitId: device.commitId,
                    sha256: device.currentConfigurationSha256,
                    bytes: device.currentConfigurationBytes
                }))
            },
            null,
            2
        )}\n`
    );
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`Huawei BMP baseline capture failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    captureDeviceBaseline,
    latestCommitId,
    normalizeConfiguration,
    normalizeConfigurationForComparison,
    sha256
};
