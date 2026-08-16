const path = require('node:path');
const { app } = require('electron');

app.disableHardwareAcceleration();

async function runTarget() {
    const configuredTarget = String(process.env.NETNEXUS_UTILITY_TEST_TARGET || '').trim();
    if (!configuredTarget) {
        throw new Error('NETNEXUS_UTILITY_TEST_TARGET is required');
    }
    const targetPath = path.resolve(configuredTarget);

    process.env.NETNEXUS_EXPECT_UTILITY_PROCESS = '1';
    const run = require(targetPath);
    if (typeof run !== 'function') {
        throw new Error(`Utility-process CI target must export an async function: ${targetPath}`);
    }
    await run();
}

app.whenReady()
    .then(runTarget)
    .then(() => app.exit(Number.isInteger(process.exitCode) ? process.exitCode : 0))
    .catch(error => {
        console.error(error.stack || error.message);
        app.exit(1);
    });
