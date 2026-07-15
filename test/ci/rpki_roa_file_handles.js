const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

const { parseRoaJsonFile } = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'rpkiRoaImport.js'));

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

        const truncatedJsonPath = path.join(tempDir, 'truncated-roas.json');
        const movedTruncatedJsonPath = path.join(tempDir, 'truncated-roas.moved.json');
        await fs.promises.writeFile(truncatedJsonPath, `{"roas":[${JSON.stringify(makeRoa(1))}`, 'utf8');

        await assert.rejects(
            parseRoaJsonFile(truncatedJsonPath, async () => true),
            /ROA JSON文件不完整或格式错误/,
            'parseRoaJsonFile should reject an unclosed wrapper after a complete ROA object'
        );
        await fs.promises.rename(truncatedJsonPath, movedTruncatedJsonPath);

        console.log('RPKI ROA file handle tests passed');
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
