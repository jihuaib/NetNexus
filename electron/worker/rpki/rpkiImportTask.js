const path = require('path');
const RpkiSqliteStore = require('./rpkiSqliteStore');
const RPKI_IMPORT_OP = require('./rpkiImportConst');
const { parseRoaJsonFile } = require('../../utils/rpkiRoaImport');
const { parseAspaJsonFile } = require('../../utils/rpkiAspaImport');

const DEFAULT_BATCH_SIZE = 5000;
const MAX_BATCH_SIZE = 100000;

function normalizeImportLimit(limit) {
    const value = Number(limit);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function normalizeBatchSize(batchSize) {
    const value = Number(batchSize);
    if (!Number.isInteger(value) || value < 1) {
        return DEFAULT_BATCH_SIZE;
    }
    return Math.min(value, MAX_BATCH_SIZE);
}

function normalizeFilePath(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new Error('RPKI import file path is required');
    }
    return path.resolve(filePath.trim());
}

function normalizeDatabasePath(dbPath) {
    if (typeof dbPath !== 'string' || !dbPath.trim()) {
        throw new Error('RPKI SQLite database path is required');
    }
    const normalizedPath = dbPath.trim();
    return normalizedPath === ':memory:' ? normalizedPath : path.resolve(normalizedPath);
}

function normalizeImportOptions(options = {}) {
    return {
        filePath: normalizeFilePath(options.filePath),
        dbPath: normalizeDatabasePath(options.dbPath),
        limit: normalizeImportLimit(options.limit),
        batchSize: normalizeBatchSize(options.batchSize)
    };
}

function yieldToWorkerEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

function abortImport(store, methodName, originalError) {
    try {
        store?.[methodName]?.();
    } catch (abortError) {
        if (originalError && !originalError.abortError) {
            originalError.abortError = abortError;
        }
    }
}

async function importRoaJson(options = {}) {
    const normalizedOptions = normalizeImportOptions(options);
    const { filePath, dbPath, limit, batchSize } = normalizedOptions;
    const sqliteStore = new RpkiSqliteStore({ dbPath }).open();
    let importStarted = false;

    try {
        const stats = {
            filePath,
            limit,
            existing: sqliteStore.getRoaCount(),
            parsed: 0,
            imported: 0,
            duplicate: 0,
            invalid: 0,
            total: 0
        };
        let batch = [];
        let candidates = 0;

        sqliteStore.beginRoaImport();
        importStarted = true;

        const flush = async () => {
            if (batch.length === 0) {
                return;
            }
            const result = sqliteStore.stageRoaBatch(batch, { countCandidates: Boolean(limit) });
            if (result.candidates !== null) {
                candidates = result.candidates;
            }
            stats.duplicate += result.skipped || 0;
            batch = [];
            await yieldToWorkerEventLoop();
        };

        const parseStats = await parseRoaJsonFile(filePath, async roa => {
            batch.push(roa);
            if (batch.length >= batchSize) {
                await flush();
            }
            if (limit && candidates >= limit) {
                return false;
            }
            return undefined;
        });
        await flush();

        const result = sqliteStore.commitRoaImport({ maxInserted: limit });
        importStarted = false;
        stats.parsed = parseStats.valid;
        stats.invalid = parseStats.invalid;
        stats.imported = result.inserted || result.added || 0;
        stats.duplicate += Math.max(0, result.staged - result.candidates);
        stats.ignoredByLimit = result.ignoredByLimit || 0;
        stats.total = result.total;
        stats.cacheSerial = result.cacheSerial;
        stats.changed = stats.imported;
        return stats;
    } catch (error) {
        if (importStarted) {
            abortImport(sqliteStore, 'abortRoaImport', error);
        }
        throw error;
    } finally {
        sqliteStore.close();
    }
}

async function importAspaJson(options = {}) {
    const normalizedOptions = normalizeImportOptions(options);
    const { filePath, dbPath, limit, batchSize } = normalizedOptions;
    const sqliteStore = new RpkiSqliteStore({ dbPath }).open();
    let importStarted = false;

    try {
        const stats = {
            filePath,
            limit,
            existing: sqliteStore.getAspaCount(),
            parsed: 0,
            imported: 0,
            overwritten: 0,
            invalid: 0,
            total: 0
        };
        let batch = [];
        let parsedCount = 0;

        sqliteStore.beginAspaImport();
        importStarted = true;

        const flush = async () => {
            if (batch.length === 0) {
                return;
            }
            sqliteStore.stageAspaBatch(batch);
            batch = [];
            await yieldToWorkerEventLoop();
        };

        const parseStats = await parseAspaJsonFile(filePath, async aspa => {
            batch.push(aspa);
            parsedCount += 1;
            if (batch.length >= batchSize || (limit && parsedCount >= limit)) {
                await flush();
            }
            if (limit && parsedCount >= limit) {
                return false;
            }
            return undefined;
        });
        await flush();

        const result = sqliteStore.commitAspaImport();
        importStarted = false;
        stats.parsed = parseStats.valid;
        stats.invalid = parseStats.invalid;
        stats.imported = result.inserted || result.added || 0;
        stats.overwritten = result.overwritten || 0;
        stats.unchanged = result.skipped || 0;
        stats.total = result.total;
        stats.cacheSerial = result.cacheSerial;
        stats.changed = result.changed || 0;
        return stats;
    } catch (error) {
        if (importStarted) {
            abortImport(sqliteStore, 'abortAspaImport', error);
        }
        throw error;
    } finally {
        sqliteStore.close();
    }
}

function runImportTask(operation, options = {}) {
    switch (operation) {
        case RPKI_IMPORT_OP.IMPORT_ROA_JSON:
            return importRoaJson(options);
        case RPKI_IMPORT_OP.IMPORT_ASPA_JSON:
            return importAspaJson(options);
        default:
            return Promise.reject(new Error(`Unknown RPKI import operation: ${operation}`));
    }
}

module.exports = {
    DEFAULT_BATCH_SIZE,
    MAX_BATCH_SIZE,
    RPKI_IMPORT_OP,
    normalizeImportOptions,
    importRoaJson,
    importAspaJson,
    runImportTask
};
