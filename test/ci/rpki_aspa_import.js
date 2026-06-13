const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

const {
    countJsonlAspas,
    readAspaJsonlPage,
    normalizeAspaObject,
    parseAspaJsonFile,
    writeAspasToJsonl,
    removeAspaFromJsonl
} = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'rpkiAspaImport.js'));

async function main() {
    const normalized = normalizeAspaObject({
        customer_asid: 'AS65000',
        providers: ['AS65002', '65001', '65001'],
        afi: ['ipv4', 'ipv6']
    });

    assert.deepStrictEqual(
        normalized,
        {
            customerAsn: '65000',
            providerAsns: [65002, 65001, 65001],
            afiFlags: 3
        },
        'normalizeAspaObject should preserve provider order and duplicates'
    );

    assert.deepStrictEqual(
        normalizeAspaObject({
            customerAsn: 65010,
            providerAsns: '',
            addressFamily: 'IPv4'
        }),
        {
            customerAsn: '65010',
            providerAsns: [],
            afiFlags: 1
        },
        'normalizeAspaObject should allow an empty Provider ASN list'
    );

    assert.strictEqual(
        normalizeAspaObject({ customerAsn: 65000, providerAsns: ['bad'] }),
        null,
        'normalizeAspaObject should reject invalid Provider ASNs'
    );

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'netnexus-rpki-aspa-import-'));

    try {
        const jsonlPath = path.join(tempDir, 'rpki-aspa.jsonl');
        await writeAspasToJsonl(jsonlPath, [
            { customerAsn: 65000, providerAsns: [65002, 65001, 65001], afiFlags: 3 },
            { customerAsn: 65010, providerAsns: [65011], afiFlags: 1 },
            { customerAsn: 65000, providerAsns: [65003], afiFlags: 2 }
        ]);

        const jsonlPage = await readAspaJsonlPage(jsonlPath, 1, 20);
        assert.strictEqual(await countJsonlAspas(jsonlPath), 2, 'writeAspasToJsonl should keep one ASPA per Customer ASN');
        assert.strictEqual(jsonlPage[0].customerAsn, '65010', 'writeAspasToJsonl should remove overwritten old position');
        assert.deepStrictEqual(
            jsonlPage[1],
            {
                customerAsn: '65000',
                providerAsns: [65003],
                afiFlags: 2
            },
            'writeAspasToJsonl should keep the latest ASPA for repeated Customer ASN'
        );

        const largeJsonlPath = path.join(tempDir, 'large-rpki-aspa.jsonl');
        const largeProviderAsns = Array.from({ length: 1024 }, (_, index) => 65000 + index);
        await writeAspasToJsonl(largeJsonlPath, [
            { customerAsn: 65200, providerAsns: largeProviderAsns, afiFlags: 3 },
            { customerAsn: 65210, providerAsns: [65211], afiFlags: 1 }
        ]);

        const deleteResult = await removeAspaFromJsonl(largeJsonlPath, 65200);
        const largeJsonlPage = await readAspaJsonlPage(largeJsonlPath, 1, 20);
        assert.strictEqual(deleteResult.deleted, 1, 'removeAspaFromJsonl should delete one large ASPA record');
        assert.strictEqual(
            deleteResult.deletedAspa.providerAsns.length,
            1024,
            'removeAspaFromJsonl should return the deleted ASPA with all Provider ASNs'
        );
        assert.strictEqual(deleteResult.total, 1, 'removeAspaFromJsonl should report the remaining total');
        assert.strictEqual(await countJsonlAspas(largeJsonlPath), 1, 'large ASPA delete should update JSONL storage');
        assert.strictEqual(
            largeJsonlPage[0].customerAsn,
            '65210',
            'large ASPA delete should keep unrelated records'
        );

        const wrappedJsonPath = path.join(tempDir, 'wrapped-aspas.json');
        await fs.promises.writeFile(
            wrappedJsonPath,
            JSON.stringify({
                data: [
                    {
                        customerAsn: 65000,
                        providerAsns: [65002, 65001, 65001],
                        afiFlags: 3
                    },
                    {
                        customer_asn: 'AS65010',
                        provider_asns: 'AS65020,65021',
                        address_family: 'IPv4'
                    },
                    {
                        customerAsn: 65030,
                        providerAsns: ['invalid']
                    }
                ]
            }),
            'utf8'
        );

        const wrappedItems = [];
        const wrappedStats = await parseAspaJsonFile(wrappedJsonPath, async aspa => {
            wrappedItems.push(aspa);
        });

        assert.strictEqual(wrappedStats.objects, 3, 'parseAspaJsonFile should scan ASPA objects in data arrays');
        assert.strictEqual(wrappedStats.valid, 2, 'parseAspaJsonFile should count valid ASPA objects');
        assert.strictEqual(wrappedStats.invalid, 1, 'parseAspaJsonFile should count invalid ASPA objects');
        assert.deepStrictEqual(
            wrappedItems[0].providerAsns,
            [65002, 65001, 65001],
            'parseAspaJsonFile should preserve provider order and duplicates'
        );
        assert.deepStrictEqual(
            wrappedItems[1],
            {
                customerAsn: '65010',
                providerAsns: [65020, 65021],
                afiFlags: 1
            },
            'parseAspaJsonFile should accept common ASPA field aliases'
        );

        const rootArrayPath = path.join(tempDir, 'root-array-aspas.json');
        const movedRootArrayPath = path.join(tempDir, 'root-array-aspas.moved.json');
        await fs.promises.writeFile(
            rootArrayPath,
            JSON.stringify([
                { customerAsn: 65100, providerAsns: [65101], afiFlags: 3 },
                { customerAsn: 65110, providerAsns: [65111], afiFlags: 3 }
            ]),
            'utf8'
        );

        let parsed = 0;
        const rootArrayStats = await parseAspaJsonFile(rootArrayPath, async () => {
            parsed += 1;
            return false;
        });

        assert.strictEqual(parsed, 1, 'parseAspaJsonFile should stop when callback returns false');
        assert.strictEqual(rootArrayStats.valid, 1, 'parseAspaJsonFile should report parsed valid objects before stop');

        await fs.promises.rename(rootArrayPath, movedRootArrayPath);
        assert.strictEqual(
            await fs.promises
                .access(movedRootArrayPath, fs.constants.F_OK)
                .then(() => true)
                .catch(() => false),
            true,
            'ASPA import JSON should be movable immediately after early stop'
        );

        console.log('RPKI ASPA JSON import tests passed');
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
