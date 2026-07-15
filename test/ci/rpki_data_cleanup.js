const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { clearRpkiPersistentData } = require('../../electron/utils/rpkiDataCleanup');

function touch(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'fixture', 'utf8');
}

function main() {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-rpki-cleanup-'));
    const rpkiFiles = [
        path.join(userDataPath, 'rpki', 'rpki.sqlite3'),
        path.join(userDataPath, 'rpki', 'rpki.sqlite3-wal'),
        path.join(userDataPath, 'rpki', 'rpki.sqlite3-shm'),
        path.join(userDataPath, 'rpki', 'nested', 'stale-file'),
        path.join(userDataPath, 'rpki-roa.jsonl'),
        path.join(userDataPath, 'rpki-roa.jsonl.migrated'),
        path.join(userDataPath, 'rpki-aspa.jsonl'),
        path.join(userDataPath, 'rpki-aspa.jsonl.migrated')
    ];
    const unrelatedFiles = [
        path.join(userDataPath, 'Program Data.json'),
        path.join(userDataPath, 'unrelated', 'keep.txt')
    ];

    try {
        [...rpkiFiles, ...unrelatedFiles].forEach(touch);

        clearRpkiPersistentData(userDataPath);

        for (const filePath of rpkiFiles) {
            assert.equal(fs.existsSync(filePath), false, `${filePath} should be removed`);
        }
        assert.equal(fs.existsSync(path.join(userDataPath, 'rpki')), false, 'RPKI directory should be removed');
        for (const filePath of unrelatedFiles) {
            assert.equal(fs.existsSync(filePath), true, `${filePath} should be preserved`);
        }

        assert.doesNotThrow(
            () => clearRpkiPersistentData(userDataPath),
            'cleanup should be idempotent when RPKI data is already absent'
        );
        assert.throws(() => clearRpkiPersistentData(''), /userDataPath/, 'an empty userData path must be rejected');

        console.log('RPKI incompatible-version data cleanup tests passed');
    } finally {
        fs.rmSync(userDataPath, { recursive: true, force: true });
    }
}

main();
