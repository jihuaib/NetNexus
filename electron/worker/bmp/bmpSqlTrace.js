const logger = require('../../log/logger');

const MAX_SQL_LENGTH = 1200;
const TRACE_LEVEL = 'debug';

function normalizeSql(sql, maximumLength = MAX_SQL_LENGTH) {
    const limit = Math.max(1, Number.isFinite(maximumLength) ? Math.floor(maximumLength) : MAX_SQL_LENGTH);
    const normalized = String(sql ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    if (normalized.length <= limit) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function isSqlTraceLevel(level) {
    return level === TRACE_LEVEL;
}

function durationMilliseconds(startedAt) {
    return (Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(3);
}

function errorMetadata(error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? ` code=${error.code}` : '';
    return `status=error${code}`;
}

function emitTrace(state, method, startedAt, sql, metadata) {
    const line = `[BMP SQLite] ${method} ${durationMilliseconds(startedAt)}ms ${metadata} sql=${normalizeSql(sql)}`;
    try {
        state.log(line);
    } catch (_error) {
        // Logging must never change SQLite operation semantics.
    }
}

function traceOperation(state, method, sql, operation, describeResult) {
    const startedAt = process.hrtime.bigint();
    try {
        const result = operation();
        emitTrace(state, method, startedAt, sql, describeResult(result));
        return result;
    } catch (error) {
        emitTrace(state, method, startedAt, sql, errorMetadata(error));
        throw error;
    }
}

function wrapStatement(statement, sql, state) {
    const methods = {
        run: result => `changes=${Number(result?.changes) || 0}`,
        get: result => `rows=${result === undefined ? 0 : 1}`,
        all: result => `rows=${Array.isArray(result) ? result.length : 0}`
    };

    Object.entries(methods).forEach(([method, describeResult]) => {
        const original = statement[method];
        statement[method] = function tracedStatementMethod(...args) {
            if (!state.enabled) {
                return original.apply(statement, args);
            }
            return traceOperation(state, method, sql, () => original.apply(statement, args), describeResult);
        };
    });

    const originalIterate = statement.iterate;
    statement.iterate = function tracedStatementIterator(...args) {
        if (!state.enabled) {
            return originalIterate.apply(statement, args);
        }

        const startedAt = process.hrtime.bigint();
        let iterator;
        try {
            iterator = originalIterate.apply(statement, args);
        } catch (error) {
            emitTrace(state, 'iterate', startedAt, sql, errorMetadata(error));
            throw error;
        }

        return (function* iterateWithTrace() {
            let rows = 0;
            let failure = null;
            try {
                for (const row of iterator) {
                    rows += 1;
                    yield row;
                }
            } catch (error) {
                failure = error;
                throw error;
            } finally {
                emitTrace(state, 'iterate', startedAt, sql, failure ? errorMetadata(failure) : `rows=${rows}`);
            }
        })();
    };

    return statement;
}

function installBmpSqlTrace(db, options = {}) {
    if (!db) {
        throw new Error('SQLite database is required for BMP SQL tracing');
    }

    const state = {
        enabled: isSqlTraceLevel(options.logLevel),
        log: typeof options.log === 'function' ? options.log : message => logger.debug(message)
    };
    const originalPrepare = db.prepare;
    const originalExec = db.exec;
    const originalPragma = db.pragma;

    db.prepare = function tracedPrepare(...args) {
        const statement = originalPrepare.apply(this, args);
        return wrapStatement(statement, args[0], state);
    };

    db.exec = function tracedExec(...args) {
        if (!state.enabled) {
            return originalExec.apply(this, args);
        }
        return traceOperation(
            state,
            'exec',
            args[0],
            () => originalExec.apply(this, args),
            () => 'status=ok'
        );
    };

    db.pragma = function tracedPragma(...args) {
        if (!state.enabled) {
            return originalPragma.apply(this, args);
        }
        return traceOperation(
            state,
            'pragma',
            args[0],
            () => originalPragma.apply(this, args),
            result => {
                const rows = Array.isArray(result) ? result.length : result === undefined ? 0 : 1;
                return `rows=${rows}`;
            }
        );
    };

    return {
        setLogLevel(level) {
            state.enabled = isSqlTraceLevel(level);
        },
        isEnabled() {
            return state.enabled;
        }
    };
}

module.exports = {
    MAX_SQL_LENGTH,
    installBmpSqlTrace,
    isSqlTraceLevel,
    normalizeSql
};
