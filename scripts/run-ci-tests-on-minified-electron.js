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

function prepareWorkspace(sourceRoot = projectRoot) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-ci-minified-'));

    copyDirectory(path.join(sourceRoot, 'electron'), path.join(tempRoot, 'electron'));
    copyDirectory(path.join(sourceRoot, 'shared'), path.join(tempRoot, 'shared'));
    copyDirectory(path.join(sourceRoot, 'src'), path.join(tempRoot, 'src'));
    copyDirectory(path.join(sourceRoot, 'test', 'ci'), path.join(tempRoot, 'test', 'ci'));
    copyDirectory(path.join(sourceRoot, 'test', 'fixtures'), path.join(tempRoot, 'test', 'fixtures'));
    copyDirectory(path.join(sourceRoot, '.github', 'workflows'), path.join(tempRoot, '.github', 'workflows'));
    copyDirectory(path.join(sourceRoot, 'docs'), path.join(tempRoot, 'docs'));
    copyDirectory(path.join(sourceRoot, 'resources', 'grpc'), path.join(tempRoot, 'resources', 'grpc'));
    fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(tempRoot, 'package.json'));
    fs.copyFileSync(path.join(sourceRoot, 'package-lock.json'), path.join(tempRoot, 'package-lock.json'));
    fs.copyFileSync(path.join(sourceRoot, 'README.md'), path.join(tempRoot, 'README.md'));
    fs.copyFileSync(path.join(sourceRoot, 'vite.config.js'), path.join(tempRoot, 'vite.config.js'));

    linkDirectory(path.join(sourceRoot, 'node_modules'), path.join(tempRoot, 'node_modules'));

    const optionalLinks = ['scripts'];
    for (const dirName of optionalLinks) {
        const source = path.join(sourceRoot, dirName);
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

    const result = spawnSync(require('electron'), [path.join(tempRoot, 'test', 'ci', 'run-tests.js')], {
        cwd: tempRoot,
        stdio: 'inherit',
        env: {
            ...process.env,
            NODE_ENV: 'test',
            ELECTRON_RUN_AS_NODE: '1',
            NETNEXUS_MINIFIED_CI: '1',
            NETNEXUS_SOURCE_PROJECT_ROOT: projectRoot
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
    if (!Number.isInteger(result.status)) {
        console.error(`[test:ci:minified] Electron runner terminated by signal ${result.signal || 'unknown'}`);
        process.exit(1);
    }

    process.exit(result.status);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.stack || error.message);
        process.exit(1);
    });
}

module.exports = { prepareWorkspace };
