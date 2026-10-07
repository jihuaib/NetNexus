const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ARTIFACT_SUFFIXES = ['-wal', '-shm', '-journal', ''];

function createSqliteDatabaseVersionCheck({ name, errorCode }) {
    function versionCheckError(databasePath, message, cause) {
        const error = new Error(`${name} database version check failed for ${databasePath}: ${message}`);
        error.code = errorCode;
        if (cause) error.cause = cause;
        return error;
    }

    function validateExpectedVersion(expectedVersion) {
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion > 0x7fffffff) {
            throw new Error(`${name} expected database schema version must be a positive 32-bit integer`);
        }
    }

    function inspectArtifacts(databasePath) {
        const artifacts = [];
        for (const suffix of ARTIFACT_SUFFIXES) {
            const artifactPath = `${databasePath}${suffix}`;
            let stats;
            try {
                stats = fs.lstatSync(artifactPath);
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                throw versionCheckError(databasePath, `cannot inspect ${artifactPath}: ${error.message}`, error);
            }
            if (stats.isSymbolicLink() || !stats.isFile()) {
                throw versionCheckError(databasePath, `artifact is not a regular file: ${artifactPath}`);
            }
            artifacts.push({ path: artifactPath, stats });
        }
        return artifacts;
    }

    function assertUnchanged(databasePath, artifacts, allowNewSidecars = false) {
        const current = inspectArtifacts(databasePath);
        const previous = new Map(artifacts.map(artifact => [artifact.path, artifact.stats]));
        for (const artifact of current) {
            const old = previous.get(artifact.path);
            if (!old && allowNewSidecars && artifact.path !== databasePath) continue;
            if (!old || old.dev !== artifact.stats.dev || old.ino !== artifact.stats.ino) {
                throw versionCheckError(databasePath, `artifact changed after validation: ${artifact.path}`);
            }
            previous.delete(artifact.path);
        }
        if (previous.size > 0) {
            throw versionCheckError(
                databasePath,
                `artifact disappeared after validation: ${previous.keys().next().value}`
            );
        }
        return current;
    }

    function inspectDatabaseVersion(dbPath, expectedVersion) {
        if (typeof dbPath !== 'string' || !dbPath) throw new Error(`${name} persistence dbPath is required`);
        const databasePath = path.resolve(dbPath);
        const artifacts = inspectArtifacts(databasePath);
        const exists = artifacts.some(artifact => artifact.path === databasePath);
        const result = { dbPath: databasePath, exists, previousVersion: null, reset: false, deletedFiles: [] };
        // Orphan sidecars provide no reliable schema version. Do not create a
        // database or remove any of them without a readable main file.
        if (!exists) return { result, artifacts, expectedVersion };
        let database;
        try {
            database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 5000 });
            result.previousVersion = database.pragma('user_version', { simple: true });
            if (
                !Number.isInteger(result.previousVersion) ||
                result.previousVersion < -0x80000000 ||
                result.previousVersion > 0x7fffffff
            ) {
                throw new Error('invalid SQLite user_version');
            }
        } catch (error) {
            throw versionCheckError(databasePath, `cannot read SQLite user_version: ${error.message}`, error);
        } finally {
            if (database) database.close();
        }
        // SQLite can create an empty WAL/SHM even for a readonly connection to a
        // WAL-mode file. Validate these new regular sidecars too, and use their
        // identities as the baseline for any subsequent version reset.
        const checkedArtifacts = assertUnchanged(databasePath, artifacts, true);
        result.reset = result.previousVersion !== expectedVersion;
        return { result, artifacts: checkedArtifacts, expectedVersion };
    }

    function resetInspectedDatabase(inspection) {
        const { result, artifacts, expectedVersion } = inspection;
        if (!result.reset) return result;
        // Recheck only files selected for deletion: an external tool could have
        // changed user_version without replacing the file's inode during preflight.
        const latest = inspectDatabaseVersion(result.dbPath, expectedVersion);
        if (!latest.result.exists || latest.result.previousVersion !== result.previousVersion || !latest.result.reset) {
            throw versionCheckError(result.dbPath, 'SQLite user_version changed before reset');
        }
        // Validate all targets again before the first unlink. Files are removed in
        // sidecar-first/main-last order; no directory, glob, or symlink is followed.
        const targets = assertUnchanged(result.dbPath, artifacts);
        for (const artifact of targets) {
            try {
                const stats = fs.lstatSync(artifact.path);
                if (
                    stats.isSymbolicLink() ||
                    !stats.isFile() ||
                    stats.dev !== artifact.stats.dev ||
                    stats.ino !== artifact.stats.ino
                ) {
                    throw new Error('artifact changed after validation');
                }
                fs.unlinkSync(artifact.path);
                result.deletedFiles.push(artifact.path);
            } catch (error) {
                throw versionCheckError(result.dbPath, `cannot remove ${artifact.path}: ${error.message}`, error);
            }
        }
        return result;
    }

    function resetDatabaseIfVersionChanged(dbPath, expectedVersion) {
        validateExpectedVersion(expectedVersion);
        return resetInspectedDatabase(inspectDatabaseVersion(dbPath, expectedVersion));
    }

    return {
        validateExpectedVersion,
        inspectDatabaseVersion,
        assertUnchanged,
        resetInspectedDatabase,
        resetDatabaseIfVersionChanged
    };
}

module.exports = { createSqliteDatabaseVersionCheck };
