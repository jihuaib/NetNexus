const fs = require('fs');
const path = require('path');

const LEGACY_RPKI_DATA_FILES = [
    'rpki-roa.jsonl',
    'rpki-roa.jsonl.migrated',
    'rpki-aspa.jsonl',
    'rpki-aspa.jsonl.migrated'
];

function clearRpkiPersistentData(userDataPath) {
    if (typeof userDataPath !== 'string' || userDataPath.trim() === '') {
        throw new TypeError('userDataPath must be a non-empty string');
    }

    fs.rmSync(path.join(userDataPath, 'rpki'), { recursive: true, force: true });
    for (const fileName of LEGACY_RPKI_DATA_FILES) {
        fs.rmSync(path.join(userDataPath, fileName), { force: true });
    }
}

module.exports = {
    clearRpkiPersistentData
};
