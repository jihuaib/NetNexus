const { HuaweiTelnetClient } = require('./e2e-support/huawei-telnet');

const READ_ONLY_COMMANDS = Object.freeze([
    ['version', 'display version'],
    ['device', 'display device'],
    ['license', 'display license'],
    ['bgp', 'display bgp peer'],
    ['bmpConfig', 'display current-configuration | include bmp'],
    ['interfaces', 'display ip interface brief']
]);

function parseTargets(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

async function probeTarget(host, credentials) {
    const client = new HuaweiTelnetClient({ host, ...credentials, timeoutMs: 30000 });
    const result = { host, commands: {} };
    try {
        await client.connect();
        for (const [name, command] of READ_ONLY_COMMANDS) {
            try {
                result.commands[name] = { ok: true, output: await client.command(command, { timeoutMs: 60000 }) };
            } catch (error) {
                result.commands[name] = { ok: false, error: error.message };
            }
        }
        return result;
    } finally {
        await client.close();
    }
}

async function main() {
    const targets = parseTargets(process.env.NETNEXUS_HUAWEI_TARGETS);
    const username = process.env.NETNEXUS_HUAWEI_USERNAME;
    const password = process.env.NETNEXUS_HUAWEI_PASSWORD;
    const localAddress = process.env.NETNEXUS_HUAWEI_LOCAL_ADDRESS || undefined;
    if (targets.length === 0 || !username || !password) {
        throw new Error('Set NETNEXUS_HUAWEI_TARGETS, NETNEXUS_HUAWEI_USERNAME, and NETNEXUS_HUAWEI_PASSWORD');
    }

    const results = [];
    for (const host of targets) {
        results.push(await probeTarget(host, { username, password, localAddress }));
    }
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch(error => {
    process.stderr.write(`Huawei BMP probe failed: ${error.message}\n`);
    process.exitCode = 1;
});
