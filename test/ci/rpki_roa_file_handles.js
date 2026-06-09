const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

const {
    parseRoaJsonFile,
    readJsonlPage,
    renameWithRetry,
    writeRoasToJsonl
} = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'rpkiRoaImport.js'));

function makeRoa(index) {
    return {
        prefix: `192.0.${index}.0/24`,
        asn: `AS${65000 + index}`,
        maxLength: 24
    };
}

async function main() {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'netnexus-rpki-handles-'));

    try {
        const jsonlPath = path.join(tempDir, 'rpki-roa.jsonl');
        const replacementPath = path.join(tempDir, 'rpki-roa.jsonl.tmp');

        await writeRoasToJsonl(
            jsonlPath,
            Array.from({ length: 50 }, (_, index) => makeRoa(index))
        );

        const firstPage = await readJsonlPage(jsonlPath, 1, 10);
        assert.strictEqual(firstPage.length, 10, 'readJsonlPage should return the requested page size');

        await fs.promises.writeFile(replacementPath, `${JSON.stringify(makeRoa(99))}\n`, 'utf8');
        await renameWithRetry(replacementPath, jsonlPath, { retries: 2, delayMs: 1 });

        const replacedPage = await readJsonlPage(jsonlPath, 1, 20);
        assert.strictEqual(replacedPage.length, 1, 'JSONL should be replaceable immediately after page read');

        await writeRoasToJsonl(jsonlPath, Array.from({ length: 5 }, (_, index) => makeRoa(index)));
        await writeRoasToJsonl(jsonlPath, Array.from({ length: 6 }, (_, index) => makeRoa(index)));
        const overwrittenPage = await readJsonlPage(jsonlPath, 1, 20);
        assert.strictEqual(overwrittenPage.length, 6, 'JSONL should be overwritable repeatedly');

        const importJsonPath = path.join(tempDir, 'import-roas.json');
        const movedJsonPath = path.join(tempDir, 'import-roas.moved.json');
        await fs.promises.writeFile(
            importJsonPath,
            JSON.stringify({
                roas: Array.from({ length: 20 }, (_, index) => makeRoa(index))
            }),
            'utf8'
        );

        let parsed = 0;
        const stats = await parseRoaJsonFile(importJsonPath, async () => {
            parsed += 1;
            return parsed < 3;
        });

        assert.strictEqual(parsed, 3, 'parseRoaJsonFile should stop when callback returns false');
        assert.strictEqual(stats.valid, 3, 'parseRoaJsonFile should report parsed valid objects before stop');

        await fs.promises.rename(importJsonPath, movedJsonPath);
        assert.strictEqual(
            await fs.promises
                .access(movedJsonPath, fs.constants.F_OK)
                .then(() => true)
                .catch(() => false),
            true,
            'import JSON should be movable immediately after early stop'
        );

        console.log('RPKI ROA file handle tests passed');
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
