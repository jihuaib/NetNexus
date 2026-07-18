const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { clearMajorVersionData } = require('../../electron/utils/majorVersionDataCleanup');

function touch(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'fixture', 'utf8');
}

function main() {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-major-cleanup-'));
    const removedFiles = [
        path.join(userDataPath, 'bgp', 'bgp.sqlite3'),
        path.join(userDataPath, 'bgp', 'bgp.sqlite3-wal'),
        path.join(userDataPath, 'bgp', 'bgp.sqlite3-shm'),
        path.join(userDataPath, 'rpki', 'rpki.sqlite3'),
        path.join(userDataPath, 'rpki', 'rpki.sqlite3-wal'),
        path.join(userDataPath, 'rpki', 'rpki.sqlite3-shm'),
        path.join(userDataPath, 'yang', 'yang.sqlite3'),
        path.join(userDataPath, 'bgp-routes.sqlite3'),
        path.join(userDataPath, 'bgp-routes.sqlite3-wal'),
        path.join(userDataPath, 'bgp-routes.sqlite3-shm'),
        path.join(userDataPath, 'bgp-routes.sqlite3-journal'),
        path.join(userDataPath, 'Program Data.json'),
        path.join(userDataPath, 'Settings Data.json'),
        path.join(userDataPath, 'bgp-routes.jsonl'),
        path.join(userDataPath, 'bgp-routes-1.jsonl.migrated'),
        path.join(userDataPath, 'rpki-roa.jsonl'),
        path.join(userDataPath, 'radius', 'radius-config.json'),
        path.join(userDataPath, 'snmp-mib-projects', 'project.json'),
        path.join(userDataPath, 'nested', 'module-config.JSON')
    ];
    const preservedFiles = [
        path.join(userDataPath, 'bmp', 'bmp.sqlite3'),
        path.join(userDataPath, 'logs', 'main.log'),
        path.join(userDataPath, 'snmp-mib-projects', 'router.mib'),
        path.join(userDataPath, 'Preferences')
    ];

    try {
        [...removedFiles, ...preservedFiles].forEach(touch);

        const result = clearMajorVersionData(userDataPath);

        assert.equal(result.removedJsonFiles, 8);
        for (const filePath of removedFiles) {
            assert.equal(fs.existsSync(filePath), false, `${filePath} should be removed`);
        }
        assert.equal(fs.existsSync(path.join(userDataPath, 'bgp')), false);
        assert.equal(fs.existsSync(path.join(userDataPath, 'rpki')), false);
        assert.equal(fs.existsSync(path.join(userDataPath, 'yang')), false);
        for (const filePath of preservedFiles) {
            assert.equal(fs.existsSync(filePath), true, `${filePath} should be preserved`);
        }

        assert.deepEqual(clearMajorVersionData(userDataPath), { removedJsonFiles: 0 });
        assert.throws(() => clearMajorVersionData(''), /userDataPath/);
        assert.throws(() => clearMajorVersionData('.'), /absolute non-root/);
        assert.throws(() => clearMajorVersionData(path.parse(userDataPath).root), /absolute non-root/);
        console.log('Major-version data cleanup tests passed');
    } finally {
        fs.rmSync(userDataPath, { recursive: true, force: true });
    }
}

main();
