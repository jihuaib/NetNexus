const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { findPackagedAppRoot, findPackagedElectronExecutable } = require('./e2e-support/packaged-app');

const CHILD_ARGUMENT = '--run-packaged-sqlite-smoke';

function makeMutationFixture() {
    const now = Date.now();
    const sourceId = 'a'.repeat(64);
    const connectionId = `packaged-smoke-${process.pid}-${now}`;
    const scopeId = 'b'.repeat(64);
    const routeId = 'c'.repeat(64);
    const source = {
        id: sourceId,
        keyJson: JSON.stringify({ schemaVersion: 1, algorithm: 'sha256', keyHex: sourceId }),
        identityJson: JSON.stringify({ kind: 'bmp-source', sourceAddress: '192.0.2.10' }),
        remoteIp: '192.0.2.10',
        sysName: 'packaged-sqlite-smoke',
        sysDesc: null,
        metadata: { smoke: true }
    };
    const connection = {
        id: connectionId,
        generation: now * 1000,
        localIp: '127.0.0.1',
        localPort: 11019,
        remoteIp: '192.0.2.10',
        remotePort: 49152,
        openedAtMs: now
    };
    const scope = {
        id: scopeId,
        keyJson: JSON.stringify({ schemaVersion: 1, algorithm: 'sha256', keyHex: scopeId }),
        identityJson: JSON.stringify({
            kind: 'bmp-rib-scope',
            peer: { type: 0, rd: 'raw:0000000000000000', address: '198.51.100.1', as: 65001 },
            addressFamily: { afi: 1, safi: 1 },
            ribType: '2'
        }),
        kind: 'peer',
        ownerKey: 'packaged-smoke-peer',
        peerType: 0,
        peerRd: '0:0',
        peerIp: '198.51.100.1',
        peerAs: 65001,
        vrfName: null,
        afi: 1,
        safi: 1,
        ribType: '2',
        epoch: 0,
        state: 'ready',
        reason: null
    };
    const legacyRouteKey = '0|0:0|203.0.113.0|24';
    const route = {
        id: routeId,
        keyJson: JSON.stringify({ schemaVersion: 1, algorithm: 'sha256', keyHex: routeId }),
        identityJson: JSON.stringify({
            kind: 'bmp-route',
            afi: 1,
            safi: 1,
            pathId: 0,
            nlri: { kind: 'ip-prefix', prefix: '203.0.113.0', length: 24 }
        }),
        keyVersion: 1,
        legacyRouteKey,
        afi: 1,
        safi: 1,
        pathId: 0,
        rd: '0:0',
        prefix: '203.0.113.0',
        prefixLength: 24,
        nlriKind: 'ip-prefix',
        nlriJson: JSON.stringify({ prefix: '203.0.113.0', length: 24, pathId: 0, rd: '0:0' }),
        attrId: null,
        attrJson: null,
        routeJson: JSON.stringify({
            routeKey: legacyRouteKey,
            afi: 1,
            safi: 1,
            pathId: 0,
            rd: '0:0',
            ip: '203.0.113.0',
            mask: 24
        })
    };

    return {
        source,
        connection,
        scope,
        route,
        mutations: [
            {
                eventType: 'connection_open',
                sequence: 1,
                eventAtMs: now,
                sourceTimestampMs: null,
                reason: null,
                source,
                connection
            },
            {
                eventType: 'announce',
                sequence: 2,
                eventAtMs: now + 1,
                sourceTimestampMs: now + 1,
                reason: null,
                source,
                connection,
                scope,
                route
            }
        ]
    };
}

async function runPackagedChild() {
    assert.ok(process.versions.electron, 'smoke child must run with the packaged Electron executable');

    const expectedArch = process.env.PACKAGED_SQLITE_EXPECTED_ARCH;
    if (expectedArch) {
        assert.equal(process.arch, expectedArch, `packaged Electron architecture must be ${expectedArch}`);
    }

    const appRoot = process.env.PACKAGED_SQLITE_APP_ROOT;
    assert.ok(appRoot, 'PACKAGED_SQLITE_APP_ROOT is required in the smoke child');
    const clientPath = path.join(appRoot, 'electron', 'worker', 'bmp', 'bmpPersistenceClient.js');
    assert.ok(fs.statSync(clientPath).isFile(), `packaged BMP persistence client not found: ${clientPath}`);

    // Loading the client from Resources/app is intentional: its worker resolves the packaged
    // better-sqlite3 binary, so this exercises the exact native module shipped to users.
    const BmpPersistenceClient = require(clientPath);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-packaged-sqlite-'));
    const dbPath = path.join(tempDir, 'bmp.sqlite3');
    let writer;
    let reader;

    try {
        writer = new BmpPersistenceClient({ dbPath, batchSize: 1, flushMs: 1 });
        const opened = await writer.open();
        assert.equal(opened.ready, true);
        assert.equal(String(opened.journalMode).toLowerCase(), 'wal');

        const fixture = makeMutationFixture();
        fixture.mutations.forEach(mutation => writer.enqueue(mutation));
        await writer.drain();

        const liveRoutes = await writer.queryRoutes({ routeState: 'all', pageSize: 10 });
        assert.equal(liveRoutes.total, 1);
        assert.equal(liveRoutes.list[0].persistentRouteId, fixture.route.id);
        assert.equal(liveRoutes.list[0].routeKey, fixture.route.legacyRouteKey);

        await writer.close();
        writer = null;

        reader = new BmpPersistenceClient({ dbPath, readOnly: true });
        const readerStatus = await reader.open();
        assert.equal(readerStatus.ready, true);
        const persistedRoutes = await reader.queryRoutes({ routeState: 'all', pageSize: 10 });
        assert.equal(persistedRoutes.total, 1);
        assert.equal(persistedRoutes.list[0].persistentRouteId, fixture.route.id);
        await reader.close();
        reader = null;

        console.log(
            `Packaged BMP SQLite smoke passed (electron=${process.versions.electron}, arch=${process.arch}, schema=${opened.schemaVersion})`
        );
    } finally {
        await writer?.close({ suppressErrors: true }).catch(() => {});
        await reader?.close({ suppressErrors: true }).catch(() => {});
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function runParent() {
    const executable = findPackagedElectronExecutable();
    const appRoot = findPackagedAppRoot();
    const expectedArch = process.env.PACKAGED_SQLITE_EXPECTED_ARCH || process.arch;
    const result = spawnSync(executable, [__filename, CHILD_ARGUMENT], {
        cwd: path.dirname(executable),
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            PACKAGED_SQLITE_APP_ROOT: appRoot,
            PACKAGED_SQLITE_EXPECTED_ARCH: expectedArch
        },
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024
    });

    if (result.stdout) {
        process.stdout.write(result.stdout);
    }
    if (result.stderr) {
        process.stderr.write(result.stderr);
    }
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`packaged BMP SQLite smoke exited with code ${result.status}`);
    }
}

if (process.argv.includes(CHILD_ARGUMENT)) {
    runPackagedChild().catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
} else {
    try {
        runParent();
    } catch (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    }
}
