const fs = require('fs');
const path = require('path');

const SOURCE_ID_PATTERN = /^[0-9a-f]{64}$/;
const CLIENT_ARTIFACT_PATTERN = /^([0-9a-f]{64})\.sqlite3(-wal|-shm|-journal)?$/;
const ARTIFACT_KINDS = Object.freeze({ '': 'database', '-wal': 'wal', '-shm': 'shm', '-journal': 'journal' });

function normalizeClientSourceId(sourceId) {
    const normalized = typeof sourceId === 'string' ? sourceId.trim().toLowerCase() : '';
    if (!SOURCE_ID_PATTERN.test(normalized)) {
        const error = new Error('BMP client sourceId must be a 64-character hexadecimal value');
        error.code = 'BMP_PERSISTENCE_INVALID_SOURCE_ID';
        throw error;
    }
    return normalized;
}

function getClientDatabaseDirectory(dbPath) {
    if (typeof dbPath !== 'string' || !dbPath) {
        throw new Error('BMP persistence dbPath is required');
    }
    return `${path.resolve(dbPath)}.clients`;
}

function assertClientDatabaseDirectory(dbPath, options = {}) {
    const directory = getClientDatabaseDirectory(dbPath);
    let stats;
    try {
        stats = fs.lstatSync(directory);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (options.create === true) {
            fs.mkdirSync(directory, { recursive: true });
            stats = fs.lstatSync(directory);
        } else {
            return null;
        }
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`BMP client database directory is not a regular directory: ${directory}`);
    }
    return directory;
}

function getClientDatabasePath(dbPath, sourceId) {
    return path.join(getClientDatabaseDirectory(dbPath), `${normalizeClientSourceId(sourceId)}.sqlite3`);
}

function getClientWorkerIndex(sourceId, workerCount = 1) {
    const count = Number(workerCount);
    if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error('BMP persistence workerCount must be a positive integer');
    }
    return Number.parseInt(normalizeClientSourceId(sourceId).slice(0, 8), 16) % count;
}

function listClientDatabaseArtifacts(dbPath, options = {}) {
    const directory = assertClientDatabaseDirectory(dbPath);
    if (!directory) return [];
    const artifacts = [];
    for (const name of fs.readdirSync(directory)) {
        const match = CLIENT_ARTIFACT_PATTERN.exec(name);
        if (!match) continue;
        const suffix = match[2] || '';
        if (options.databaseOnly === true && suffix) continue;
        if (options.sourceIdFilter && !options.sourceIdFilter(match[1])) continue;
        const artifactPath = path.join(directory, name);
        let stats;
        try {
            stats = fs.lstatSync(artifactPath);
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        const isSymbolicLink = stats.isSymbolicLink();
        const isFile = stats.isFile() && !isSymbolicLink;
        if (!isFile && options.strict !== false) {
            throw new Error(`BMP client database artifact is not a regular file: ${artifactPath}`);
        }
        artifacts.push({
            sourceId: match[1],
            kind: ARTIFACT_KINDS[suffix],
            suffix,
            path: artifactPath,
            databasePath: getClientDatabasePath(dbPath, match[1]),
            isFile,
            isSymbolicLink,
            size: isFile ? stats.size : null
        });
    }
    return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

function listClientDatabases(dbPath, options = {}) {
    // Discovery only needs main files. A different writer may be deleting its
    // sidecars, and Windows can report EPERM while those files are delete-pending.
    return listClientDatabaseArtifacts(dbPath, { ...options, databaseOnly: true })
        .filter(artifact => artifact.kind === 'database' && artifact.isFile)
        .map(artifact => ({ sourceId: artifact.sourceId, dbPath: artifact.databasePath }));
}

function assertClientDatabaseArtifacts(dbPath, sourceId) {
    assertClientDatabaseDirectory(dbPath);
    const databasePath = getClientDatabasePath(dbPath, sourceId);
    for (const suffix of Object.keys(ARTIFACT_KINDS)) {
        try {
            const stats = fs.lstatSync(`${databasePath}${suffix}`);
            if (stats.isSymbolicLink() || !stats.isFile()) {
                throw new Error(`BMP client database artifact is not a regular file: ${databasePath}${suffix}`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    return databasePath;
}

module.exports = {
    normalizeClientSourceId,
    getClientDatabaseDirectory,
    getClientDatabasePath,
    getClientWorkerIndex,
    assertClientDatabaseDirectory,
    assertClientDatabaseArtifacts,
    listClientDatabases,
    listClientDatabaseArtifacts
};
