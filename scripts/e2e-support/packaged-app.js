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

function getPackageInfo() {
    const packageJson = require(path.join(projectRoot, 'package.json'));
    return {
        packageName: packageJson.name,
        productName: packageJson.build?.productName || packageJson.productName || packageJson.name
    };
}

function addNameVariants(names, name) {
    if (!name) {
        return;
    }

    const spaced = name.trim();
    const noSpace = spaced.replace(/\s+/g, '');
    const kebab = spaced
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    for (const variant of [spaced, noSpace, spaced.toLowerCase(), noSpace.toLowerCase(), kebab, kebab.toLowerCase()]) {
        if (variant) {
            names.add(variant);
        }
    }
}

function getExecutableNames() {
    const { packageName, productName } = getPackageInfo();
    const names = new Set();
    addNameVariants(names, productName);
    addNameVariants(names, packageName);
    return names;
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

function collectMacAppExecutables(executableNames) {
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
            const names = new Set(executableNames);
            addNameVariants(names, appName);
            return Array.from(names).map(name => path.join(appDir, 'Contents', 'MacOS', name));
        })
        .flat()
        .filter(fileExists);
}

function isLikelyLinuxAppExecutable(filePath, fileName, fsApi = fs) {
    const unpackedDirectory = path.basename(path.dirname(filePath));
    if (
        !/^linux(?:-[A-Za-z0-9_-]+)?-unpacked$/.test(unpackedDirectory) ||
        fileName.includes('.') ||
        fileName === 'chrome-sandbox'
    ) {
        return false;
    }

    try {
        return (fsApi.statSync(filePath).mode & 0o111) !== 0;
    } catch {
        return false;
    }
}

function formatReleaseFiles() {
    const files = collectMatchingFiles(releaseRoot, () => true, 4)
        .map(filePath => path.relative(projectRoot, filePath))
        .sort();

    if (files.length === 0) {
        return 'none';
    }

    const visibleFiles = files.slice(0, 30).join(', ');
    return files.length > 30 ? `${visibleFiles}, ... ${files.length - 30} more` : visibleFiles;
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

    const executableNames = getExecutableNames();
    let candidates = [];

    if (process.platform === 'darwin') {
        candidates = collectMacAppExecutables(executableNames);
    } else if (process.platform === 'win32') {
        candidates = collectMatchingFiles(releaseRoot, (_filePath, fileName) => {
            const lowerName = fileName.toLowerCase();
            return Array.from(executableNames).some(name => lowerName === `${name}.exe`.toLowerCase());
        });
    } else {
        candidates = collectMatchingFiles(
            releaseRoot,
            (filePath, fileName) => executableNames.has(fileName) || isLikelyLinuxAppExecutable(filePath, fileName)
        );
    }

    candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a) || b.localeCompare(a));

    if (candidates.length === 0) {
        throw new Error(
            [
                'Packaged Electron app not found under release/.',
                'Playwright global setup should build it first unless E2E_SKIP_PACK=1 is set.',
                `Expected executable names: ${Array.from(executableNames).join(', ')}.`,
                `Release files: ${formatReleaseFiles()}.`,
                'Set E2E_APP_EXECUTABLE to the packaged app executable to override detection.'
            ].join(' ')
        );
    }

    return candidates[0];
}

function findPackagedAppRoot() {
    if (process.env.E2E_APP_ROOT) {
        const appRoot = path.resolve(projectRoot, process.env.E2E_APP_ROOT);
        if (!dirExists(appRoot)) {
            throw new Error(`E2E_APP_ROOT does not exist: ${appRoot}`);
        }
        return appRoot;
    }

    const executablePath = findPackagedElectronExecutable();
    const candidates =
        process.platform === 'darwin'
            ? [path.resolve(path.dirname(executablePath), '..', 'Resources', 'app')]
            : [path.join(path.dirname(executablePath), 'resources', 'app')];

    for (const candidate of candidates) {
        if (dirExists(candidate)) {
            return candidate;
        }
    }

    throw new Error(`Packaged app root not found for executable: ${executablePath}`);
}

function findPackagedElectronRoot() {
    if (process.env.E2E_ELECTRON_ROOT) {
        const electronRoot = path.resolve(projectRoot, process.env.E2E_ELECTRON_ROOT);
        if (!dirExists(electronRoot)) {
            throw new Error(`E2E_ELECTRON_ROOT does not exist: ${electronRoot}`);
        }
        return electronRoot;
    }

    const electronRoot = path.join(findPackagedAppRoot(), 'electron');
    if (!dirExists(electronRoot)) {
        throw new Error(`Packaged electron root not found: ${electronRoot}`);
    }
    return electronRoot;
}

module.exports = {
    findPackagedAppRoot,
    findPackagedElectronRoot,
    findPackagedElectronExecutable,
    isLikelyLinuxAppExecutable,
    projectRoot
};
