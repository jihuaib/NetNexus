const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');
const logger = require('../../electron/log/logger');
const { installBmpSqlTrace } = require('../../electron/worker/bmp/bmpSqlTrace');

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-sql-routing-'));
    const runtimePath = path.join(directory, 'protocol-bmp.log');
    const sqlPath = path.join(directory, 'sqlite', 'protocol-bmp-main.log');
    const raw = logger.raw();
    const originalCreate = raw.create;
    const originalResolvePath = raw.transports.file.resolvePathFn;
    const originalConsoleWrite = raw.transports.console.writeFn;
    const originalLevel = logger.logLevel;
    const consoleMessages = [];
    const forwardedSql = [];
    let dedicatedLogger;
    let worker;
    const db = new Database(':memory:');

    try {
        raw.transports.file.resolvePathFn = () => runtimePath;
        raw.transports.console.writeFn = ({ message }) => consoleMessages.push(message.data.join(' '));
        raw.create = options => {
            dedicatedLogger = originalCreate(options);
            // Simulate enabled development transports before the SQL logger
            // configures itself, so accidental console/IPC forwarding is caught.
            for (const name of ['console', 'ipc', 'remote']) {
                dedicatedLogger.transports[name] = Object.assign(message => forwardedSql.push({ name, message }), {
                    level: 'debug'
                });
            }
            return dedicatedLogger;
        };

        logger.setLevel('debug');
        const trace = installBmpSqlTrace(db);
        db.exec('CREATE TABLE test_sql_log (value TEXT UNIQUE)');
        const insert = db.prepare('INSERT INTO test_sql_log(value) VALUES (?)');
        insert.run('before-tracing');
        assert.equal(fs.existsSync(sqlPath), false, 'disabled SQL tracing must not create a log');

        trace.setLogLevel('debug');
        const secret = 'BOUND-VALUE-NOT-FOR-LOGS';
        insert.run(secret);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM test_sql_log').get().count, 2);
        assert.throws(() => insert.run(secret), /UNIQUE|constraint/i);
        logger.info('ordinary BMP event');
        logger.error('ordinary database failure');

        const sqlOutput = fs.readFileSync(sqlPath, 'utf8');
        assert.match(sqlOutput, /\[BMP SQLite\] run .*changes=1 sql=INSERT INTO test_sql_log/);
        assert.match(sqlOutput, /status=error code=SQLITE_CONSTRAINT/);
        assert.equal(sqlOutput.includes(secret), false, 'bound values must remain private');
        assert.equal(sqlOutput.includes('ordinary BMP event'), false);
        assert.equal(dedicatedLogger.transports.file.maxSize, 5 * 1024 * 1024);
        assert.equal(
            raw.errorHandler.logFn,
            raw.error,
            'a dedicated logger must not replace the runtime error handler'
        );
        assert.deepEqual(forwardedSql, [], 'SQL must not reach console, renderer IPC or remote transports');

        const runtimeOutput = fs.readFileSync(runtimePath, 'utf8');
        assert.match(runtimeOutput, /ordinary BMP event/);
        assert.match(runtimeOutput, /ordinary database failure/);
        assert.equal(runtimeOutput.includes('[BMP SQLite]'), false, 'SQL must not enter the ordinary log');
        assert.equal(
            consoleMessages.some(line => line.includes('[BMP SQLite]')),
            false
        );
        assert.ok(consoleMessages.some(line => line.includes('ordinary database failure')));

        for (const level of ['info', 'warn', 'error', 'off']) {
            trace.setLogLevel(level);
            db.prepare('SELECT 1').get();
            assert.equal(fs.readFileSync(sqlPath, 'utf8'), sqlOutput, `${level} must stop SQL tracing immediately`);
        }
        trace.setLogLevel('debug');
        logger.setLevel('off');
        db.prepare('SELECT 1').get();
        assert.equal(fs.readFileSync(sqlPath, 'utf8'), sqlOutput, 'the runtime off level must also stop SQL output');

        const source = `
            const { parentPort, workerData, threadId } = require('node:worker_threads');
            const Database = require(workerData.databaseModule);
            const logger = require(workerData.loggerModule);
            const { installBmpSqlTrace } = require(workerData.traceModule);
            logger.raw().transports.file.resolvePathFn = () => workerData.runtimePath;
            logger.setLevel('debug');
            const db = new Database(':memory:');
            installBmpSqlTrace(db, { logLevel: 'debug' });
            const value = db.prepare('SELECT 42 AS value').get().value;
            db.close();
            parentPort.postMessage({ threadId, value });
        `;
        worker = new Worker(source, {
            eval: true,
            workerData: {
                runtimePath,
                databaseModule: require.resolve('better-sqlite3'),
                loggerModule: require.resolve('../../electron/log/logger'),
                traceModule: require.resolve('../../electron/worker/bmp/bmpSqlTrace')
            }
        });
        const result = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.once('exit', code => {
                if (code !== 0) reject(new Error(`SQL routing worker exited with code ${code}`));
            });
        });
        assert.equal(result.value, 42);
        const workerPath = path.join(directory, 'sqlite', `protocol-bmp-worker-${result.threadId}.log`);
        assert.match(fs.readFileSync(workerPath, 'utf8'), /sql=SELECT 42 AS value/);
        assert.equal(fs.readFileSync(sqlPath, 'utf8'), sqlOutput, 'workers must not share the main SQL log');
        assert.equal(fs.readFileSync(runtimePath, 'utf8').includes('[BMP SQLite]'), false);

        const failureDb = new Database(':memory:');
        try {
            installBmpSqlTrace(failureDb, {
                logLevel: 'debug',
                log() {
                    throw new Error('unavailable log destination');
                }
            });
            assert.equal(
                failureDb.prepare('SELECT 7 AS value').get().value,
                7,
                'logging failure must not fail a query'
            );
        } finally {
            failureDb.close();
        }
        console.log('BMP SQLite isolated file and worker logging tests passed');
    } finally {
        await worker?.terminate();
        logger.setLevel(originalLevel);
        raw.create = originalCreate;
        raw.transports.file.resolvePathFn = originalResolvePath;
        raw.transports.console.writeFn = originalConsoleWrite;
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
