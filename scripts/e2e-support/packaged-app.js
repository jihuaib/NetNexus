const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..', '..');
const releaseRoot = path.join(projectRoot, 'release');

function fileExists(filePath) {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function dirExists(dirPath) {
    try {
        return fs.statSync(dirPath).isDirectory();
    } catch {
        return false;
    }
}

function getProductName() {
    const packageJson = require(path.join(projectRoot, 'package.json'));
    return packageJson.build?.productName || packageJson.productName || packageJson.name;
}

function collectMatchingFiles(dir, predicate, depth = 6) {
    if (depth < 0 || !dirExists(dir)) {
        return [];
    }

    const matches = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isFile() && predicate(fullPath, entry.name)) {
            matches.push(fullPath);
            continue;
        }

        if (entry.isDirectory()) {
            matches.push(...collectMatchingFiles(fullPath, predicate, depth - 1));
        }
    }

    return matches;
}

function collectMacAppExecutables(productName) {
    const appDirs = [];
    const visit = (dir, depth = 4) => {
        if (depth < 0 || !dirExists(dir)) {
            return;
        }

        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && entry.name.endsWith('.app')) {
                appDirs.push(fullPath);
                continue;
            }
            if (entry.isDirectory()) {
                visit(fullPath, depth - 1);
            }
        }
    };

    visit(releaseRoot);

    return appDirs
        .map(appDir => {
            const appName = path.basename(appDir, '.app');
            const executableNames = Array.from(new Set([productName, appName]));
            return executableNames.map(name => path.join(appDir, 'Contents', 'MacOS', name));
        })
        .flat()
        .filter(fileExists);
}

function scoreCandidate(filePath) {
    const normalized = filePath.split(path.sep).join('/');
    let score = 0;

    if (process.platform === 'darwin') {
        if (process.arch === 'arm64' && normalized.includes('/mac-arm64/')) score += 100;
        if (process.arch === 'x64' && normalized.includes('/mac/')) score += 100;
        if (normalized.includes('/mac-universal/')) score += 50;
    }

    if (process.platform === 'win32' && normalized.includes('/win-unpacked/')) score += 100;
    if (process.platform === 'linux' && normalized.includes('/linux-unpacked/')) score += 100;

    return score;
}

function findPackagedElectronExecutable() {
    if (process.env.E2E_APP_EXECUTABLE) {
        const executablePath = path.resolve(projectRoot, process.env.E2E_APP_EXECUTABLE);
        if (!fileExists(executablePath)) {
            throw new Error(`E2E_APP_EXECUTABLE does not exist: ${executablePath}`);
        }
        return executablePath;
    }

    const productName = getProductName();
    let candidates = [];

    if (process.platform === 'darwin') {
        candidates = collectMacAppExecutables(productName);
    } else if (process.platform === 'win32') {
        candidates = collectMatchingFiles(releaseRoot, (_filePath, fileName) => fileName === `${productName}.exe`);
    } else {
        const normalizedNames = new Set([productName, productName.toLowerCase(), productName.replace(/\s+/g, '-')]);
        candidates = collectMatchingFiles(releaseRoot, (_filePath, fileName) => normalizedNames.has(fileName));
    }

    candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a) || b.localeCompare(a));

    if (candidates.length === 0) {
        throw new Error(
            [
                'Packaged Electron app not found under release/.',
                'Run npm run test:e2e so the pretest:e2e hook builds it first,',
                'or set E2E_APP_EXECUTABLE to the packaged app executable.'
            ].join(' ')
        );
    }

    return candidates[0];
}

module.exports = {
    findPackagedElectronExecutable,
    projectRoot
};
