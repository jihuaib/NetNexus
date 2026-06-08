const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ciTestDir = __dirname;
const runnerFile = path.basename(__filename);
const testScripts = fs
    .readdirSync(ciTestDir)
    .filter(file => file.endsWith('.js') && file !== runnerFile)
    .sort()
    .map(file => path.join(ciTestDir, file));

let failed = 0;

if (testScripts.length === 0) {
    console.error(`No CI test scripts found in ${ciTestDir}`);
    process.exit(1);
}

for (const scriptPath of testScripts) {
    const scriptName = path.relative(__dirname, scriptPath);
    console.log(`\n==> ${scriptName}`);

    const result = spawnSync(process.execPath, [scriptPath], {
        cwd: path.join(__dirname, '..', '..'),
        stdio: 'inherit',
        env: {
            ...process.env,
            NODE_ENV: 'test'
        }
    });

    if (result.status !== 0) {
        failed += 1;
        console.error(`\n${scriptName} failed with exit code ${result.status}`);
    }
}

if (failed > 0) {
    console.error(`\n${failed} test script(s) failed`);
    process.exit(1);
}

console.log('\nAll test scripts passed');
