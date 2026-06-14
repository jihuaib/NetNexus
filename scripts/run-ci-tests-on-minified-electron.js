const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { minifyElectronRoot } = require('./minify-electron-js');

const projectRoot = path.join(__dirname, '..');

function copyDirectory(source, target) {
    fs.cpSync(source, target, {
        recursive: true,
        filter: filePath => !filePath.includes(`${path.sep}.DS_Store`)
    });
}

function linkDirectory(source, target) {
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(source, target, type);
}

function prepareWorkspace() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-ci-minified-'));

    copyDirectory(path.join(projectRoot, 'electron'), path.join(tempRoot, 'electron'));
    copyDirectory(path.join(projectRoot, 'test', 'ci'), path.join(tempRoot, 'test', 'ci'));
    fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(tempRoot, 'package.json'));

    linkDirectory(path.join(projectRoot, 'node_modules'), path.join(tempRoot, 'node_modules'));

    const optionalLinks = ['scripts', 'bgpdata'];
    for (const dirName of optionalLinks) {
        const source = path.join(projectRoot, dirName);
        if (fs.existsSync(source)) {
            linkDirectory(source, path.join(tempRoot, dirName));
        }
    }

    return tempRoot;
}

async function main() {
    const tempRoot = prepareWorkspace();
    const electronRoot = path.join(tempRoot, 'electron');

    console.log(`[test:ci:minified] workspace: ${tempRoot}`);
    await minifyElectronRoot(electronRoot);

    const result = spawnSync(process.execPath, [path.join(tempRoot, 'test', 'ci', 'run-tests.js')], {
        cwd: tempRoot,
        stdio: 'inherit',
        env: {
            ...process.env,
            NODE_ENV: 'test',
            NETNEXUS_MINIFIED_CI: '1'
        }
    });

    if (process.env.KEEP_MINIFIED_CI_WORKDIR === '1') {
        console.log(`[test:ci:minified] kept workspace: ${tempRoot}`);
    } else {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    if (result.error) {
        throw result.error;
    }

    process.exit(result.status || 0);
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
