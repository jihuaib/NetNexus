const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BmpPersistenceStore = require('../../electron/worker/bmp/bmpPersistenceStore');
const { MAX_SQL_LENGTH, isSqlTraceLevel, normalizeSql } = require('../../electron/worker/bmp/bmpSqlTrace');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bmp-sql-trace-'));
const logs = [];
let store;

try {
    assert.equal(isSqlTraceLevel('debug'), true);
    ['off', 'info', 'warn', 'error', 'DEBUG', undefined].forEach(level => {
        assert.equal(isSqlTraceLevel(level), false);
    });

    assert.equal(normalizeSql('  SELECT\n    *\tFROM routes  '), 'SELECT * FROM routes');
    const cappedSql = normalizeSql(`SELECT ${'prefix_column '.repeat(200)}`);
    assert.equal(cappedSql.length, MAX_SQL_LENGTH);
    assert.equal(cappedSql.endsWith('…'), true);

    store = new BmpPersistenceStore({
        dbPath: path.join(tempDir, 'bmp.sqlite3'),
        sqlTraceLog: line => logs.push(line)
    }).open();

    assert.equal(store.isSqlTraceEnabled(), false);
    assert.equal(logs.length, 0, 'SQL tracing must be disabled by default, including during migrations');

    store.db.exec('CREATE TABLE bmp_sql_trace_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)');
    const insert = store.db.prepare('INSERT INTO bmp_sql_trace_test(value) VALUES (?)');
    const getByValue = store.db.prepare('SELECT id, value FROM bmp_sql_trace_test WHERE value = ?');
    const listByValue = store.db.prepare('SELECT id, value FROM bmp_sql_trace_test WHERE value <> ? ORDER BY id');
    const iterateById = store.db.prepare('SELECT id, value FROM bmp_sql_trace_test WHERE id >= ? ORDER BY id');
    const boundLookup = store.db.prepare('SELECT id FROM bmp_sql_trace_test WHERE value = ?');

    const firstSecret = 'TOP-SECRET-bound-value';
    insert.run(firstSecret);
    assert.equal(logs.length, 0);

    store.setLogLevel('info');
    assert.equal(store.isSqlTraceEnabled(), false);
    getByValue.get(firstSecret);
    assert.equal(logs.length, 0, 'non-debug levels must not emit SQL traces');

    store.setLogLevel('debug');
    assert.equal(store.isSqlTraceEnabled(), true);

    const secondSecret = JSON.stringify({ token: 'BOUND-JSON-TOKEN', payload: 'x'.repeat(4096) });
    insert.run(secondSecret);
    assert.equal(getByValue.get(firstSecret).value, firstSecret);
    assert.equal(listByValue.all(firstSecret).length, 1);
    assert.equal([...iterateById.iterate(1)].length, 2);
    assert.equal(boundLookup.bind(secondSecret).get().id, 2);
    store.db.exec('CREATE INDEX idx_bmp_sql_trace_value ON bmp_sql_trace_test(value)');
    store.db.pragma('cache_size = 1000');

    assert.throws(() => insert.run(firstSecret), /UNIQUE|constraint/i);

    const output = logs.join('\n');
    assert.match(output, /\[BMP SQLite\] run \d+\.\d{3}ms changes=1 sql=INSERT INTO bmp_sql_trace_test/);
    assert.match(output, /\[BMP SQLite\] get \d+\.\d{3}ms rows=1 sql=SELECT id, value/);
    assert.match(output, /\[BMP SQLite\] all \d+\.\d{3}ms rows=1 sql=SELECT id, value/);
    assert.match(output, /\[BMP SQLite\] iterate \d+\.\d{3}ms rows=2 sql=SELECT id, value/);
    assert.match(output, /\[BMP SQLite\] exec \d+\.\d{3}ms status=ok sql=CREATE INDEX/);
    assert.match(output, /\[BMP SQLite\] pragma \d+\.\d{3}ms rows=\d+ sql=cache_size = 1000/);
    assert.match(output, /\[BMP SQLite\] run \d+\.\d{3}ms status=error code=SQLITE_CONSTRAINT/);
    assert.equal(output.includes(firstSecret), false, 'bound string values must never be logged');
    assert.equal(output.includes('BOUND-JSON-TOKEN'), false, 'bound JSON values must never be logged');
    assert.equal(output.includes('x'.repeat(100)), false, 'large bound payloads must never be logged');
    logs.forEach(line => {
        const sql = line.slice(line.indexOf(' sql=') + 5);
        assert.ok(sql.length <= MAX_SQL_LENGTH, `logged SQL exceeded ${MAX_SQL_LENGTH} characters`);
    });

    const enabledLogCount = logs.length;
    store.setLogLevel('error');
    assert.equal(store.isSqlTraceEnabled(), false);
    getByValue.get(firstSecret);
    insert.run('another-bound-value');
    assert.equal(logs.length, enabledLogCount, 'already-prepared statements must stop tracing after a runtime toggle');

    console.log('BMP SQLite SQL trace tests passed');
} finally {
    store?.setLogLevel('off');
    store?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
