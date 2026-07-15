const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

const { normalizeAspaObject, parseAspaJsonFile } = require(
    path.join(__dirname, '..', '..', 'electron', 'utils', 'rpkiAspaImport.js')
);

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

        const truncatedJsonPath = path.join(tempDir, 'truncated-aspas.json');
        const movedTruncatedJsonPath = path.join(tempDir, 'truncated-aspas.moved.json');
        await fs.promises.writeFile(
            truncatedJsonPath,
            `{"data":[${JSON.stringify({ customerAsn: 65120, providerAsns: [65121], afiFlags: 3 })}`,
            'utf8'
        );

        await assert.rejects(
            parseAspaJsonFile(truncatedJsonPath, async () => true),
            /ASPA JSON文件不完整或格式错误/,
            'parseAspaJsonFile should reject an unclosed wrapper after a complete ASPA object'
        );
        await fs.promises.rename(truncatedJsonPath, movedTruncatedJsonPath);

        console.log('RPKI ASPA JSON import tests passed');
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
