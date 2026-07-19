const path = require('path');
const { PROJECT_ROOT, verifyPinnedIanaModules } = require('./libyang-runtime-config');

function optionValue(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
    const runtimeDirectory = optionValue('--runtime');
    const status = verifyPinnedIanaModules({
        projectRoot: PROJECT_ROOT,
        runtimeDirectory: runtimeDirectory ? path.resolve(runtimeDirectory) : undefined
    });
    process.stdout.write(
        `Verified ${status.modules.length} pinned IANA YANG modules` +
            `${runtimeDirectory ? ' in the bundled runtime' : ''}.\n`
    );
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
}
