const fs = require('fs');
const path = require('path');
const { clearRpkiPersistentData } = require('./rpkiDataCleanup');

const LEGACY_BGP_DATABASE_FILES = [
    'bgp-routes.sqlite3',
    'bgp-routes.sqlite3-wal',
    'bgp-routes.sqlite3-shm',
    'bgp-routes.sqlite3-journal'
];
const JSON_DATA_FILE_PATTERN = /\.jsonl?(?:\.migrated)?$/i;

function validateUserDataPath(userDataPath) {
    if (typeof userDataPath !== 'string' || userDataPath.trim() === '') {
        throw new TypeError('userDataPath must be a non-empty string');
    }
    const resolvedPath = path.resolve(userDataPath);
    if (!path.isAbsolute(userDataPath) || resolvedPath === path.parse(resolvedPath).root) {
        throw new TypeError('userDataPath must be an absolute non-root path');
    }
    return resolvedPath;
}

function removeJsonDataFiles(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return 0;
    }

    let removed = 0;
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            removed += removeJsonDataFiles(entryPath);
        } else if (entry.isFile() && JSON_DATA_FILE_PATTERN.test(entry.name)) {
            fs.rmSync(entryPath, { force: true });
            removed += 1;
        }
    }
    return removed;
}

function clearMajorVersionData(userDataPath) {
    const resolvedUserDataPath = validateUserDataPath(userDataPath);

    const removedJsonFiles = removeJsonDataFiles(resolvedUserDataPath);
    clearRpkiPersistentData(resolvedUserDataPath);
    fs.rmSync(path.join(resolvedUserDataPath, 'bgp'), { recursive: true, force: true });
    fs.rmSync(path.join(resolvedUserDataPath, 'yang'), { recursive: true, force: true });
    for (const fileName of LEGACY_BGP_DATABASE_FILES) {
        fs.rmSync(path.join(resolvedUserDataPath, fileName), { force: true });
    }

    return {
        removedJsonFiles
    };
}

module.exports = {
    clearMajorVersionData
};
