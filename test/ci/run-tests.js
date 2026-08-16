const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

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
    if (!Number.isInteger(result.status)) {
        console.error(`Electron CI runner terminated by signal ${result.signal || 'unknown'}`);
        process.exit(1);
    }
    process.exit(result.status);
}

const ciTestDir = __dirname;
const runnerFile = path.basename(__filename);
const utilityProcessRunner = path.join(ciTestDir, 'fixtures', 'electron_utility_test_runner.js');
const utilityProcessTests = new Set([
    'bgp_process_route_ownership.js',
    'bmp_persistence_worker_e2e.js',
    'bmp_reconnect_no_eor_timeout.js',
    'bmp_restart_page_restore.js',
    'mib_source_read.js',
    'protocol_process_transport.js',
    'protocol_service_process_smoke.js',
    'radius_protocol.js',
    'rpki_sqlite_app.js',
    'snmp_process_runtime.js',
    'yang_process_lifecycle.js'
]);
const testScripts = fs
    .readdirSync(ciTestDir)
    .filter(file => file.endsWith('.js') && file !== runnerFile)
    .sort()
    .map(file => path.join(ciTestDir, file));

let failed = 0;
const testTimeoutMs = Math.max(30000, Number(process.env.NETNEXUS_CI_TEST_TIMEOUT_MS) || 10 * 60 * 1000);

if (testScripts.length === 0) {
    console.error(`No CI test scripts found in ${ciTestDir}`);
    process.exit(1);
}

for (const scriptPath of testScripts) {
    const scriptName = path.relative(__dirname, scriptPath);
    console.log(`\n==> ${scriptName}`);

    const useUtilityProcess = utilityProcessTests.has(scriptName);
    const childEnv = {
        ...process.env,
        NODE_ENV: 'test'
    };
    let args = [scriptPath];
    if (useUtilityProcess) {
        for (const key of Object.keys(childEnv)) {
            if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete childEnv[key];
        }
        childEnv.NETNEXUS_UTILITY_TEST_TARGET = scriptPath;
        args = ['--disable-gpu', utilityProcessRunner];
    }

    const result = spawnSync(process.execPath, args, {
        cwd: path.join(__dirname, '..', '..'),
        stdio: 'inherit',
        env: childEnv,
        timeout: testTimeoutMs
    });

    if (result.error || result.signal || result.status !== 0) {
        failed += 1;
        if (result.error) {
            console.error(`\n${scriptName} failed to run: ${result.error.message}`);
        } else if (result.signal) {
            console.error(`\n${scriptName} terminated by signal ${result.signal}`);
        } else {
            console.error(`\n${scriptName} failed with exit code ${result.status}`);
        }
    }
}

if (failed > 0) {
    console.error(`\n${failed} test script(s) failed`);
    process.exit(1);
}

console.log('\nAll test scripts passed');
