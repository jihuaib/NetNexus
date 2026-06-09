const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const RpkiRoaQueryIndex = require('../electron/utils/rpkiRoaQueryIndex');

const DEFAULT_ROA_COUNT = 1_000_000;
const DEFAULT_PAGE_SIZE = 10;

function getArgValue(name, defaultValue) {
    const prefix = `--${name}=`;
    const arg = process.argv.find(item => item.startsWith(prefix));
    if (!arg) {
        return defaultValue;
    }

    const value = Number(arg.slice(prefix.length));
    return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

function formatMs(ms) {
    return `${ms.toFixed(2)} ms`;
}

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(2)} ${units[index]}`;
}

function printMemory(label) {
    const usage = process.memoryUsage();
    console.log(
        `${label}: rss=${formatBytes(usage.rss)}, heapUsed=${formatBytes(usage.heapUsed)}, heapTotal=${formatBytes(
            usage.heapTotal
        )}, external=${formatBytes(usage.external)}`
    );
}

async function timeStep(label, fn) {
    const start = process.hrtime.bigint();
    const result = await fn();
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    console.log(`${label}: ${formatMs(ms)}`);
    return { result, ms };
}

function ipFromIndex(index) {
    const second = (index >>> 16) & 0xff;
    const third = (index >>> 8) & 0xff;
    const fourth = index & 0xff;
    return `10.${second}.${third}.${fourth}`;
}

function makeRoa(index) {
    return {
        ipType: 1,
        asn: String(65000 + (index % 1000)),
        ip: ipFromIndex(index),
        mask: '32',
        maxLength: '32'
    };
}

async function writeLine(stream, line) {
    if (!stream.write(`${line}\n`)) {
        await once(stream, 'drain');
    }
}

async function buildRoaFile(filePath, roaCount) {
    const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
    try {
        for (let i = 0; i < roaCount; i += 1) {
            await writeLine(stream, JSON.stringify(makeRoa(i)));
        }
    } finally {
        await new Promise((resolve, reject) => {
            stream.once('error', reject);
            stream.end(resolve);
        });
    }
}

function assertPage(result, expectedTotal, expectedLength) {
    if (result.total !== expectedTotal || result.items.length !== expectedLength) {
        throw new Error(
            `unexpected query result: total=${result.total}, items=${result.items.length}, expectedTotal=${expectedTotal}, expectedLength=${expectedLength}`
        );
    }
}

async function main() {
    const roaCount = getArgValue('roas', DEFAULT_ROA_COUNT);
    const pageSize = getArgValue('pageSize', DEFAULT_PAGE_SIZE);
    const lastPage = Math.ceil(roaCount / pageSize);
    const middlePage = Math.max(1, Math.floor(lastPage / 2));
    const filePath = path.join(os.tmpdir(), `netnexus-rpki-roa-query-${process.pid}.jsonl`);
    const index = new RpkiRoaQueryIndex();
    const exactIndex = Math.floor(roaCount / 2);
    const exactPrefix = `${ipFromIndex(exactIndex)}/32`;
    const exactAsn = String(65000 + (exactIndex % 1000));
    const exactAsnRemainder = exactIndex % 1000;
    const expectedAsnTotal =
        exactAsnRemainder < roaCount ? Math.floor((roaCount - 1 - exactAsnRemainder) / 1000) + 1 : 0;

    console.log(`RPKI ROA query benchmark: roas=${roaCount}, pageSize=${pageSize}`);
    printMemory('before');

    try {
        await timeStep('write ROA JSONL', () => buildRoaFile(filePath, roaCount));
        printMemory('after file write');

        await timeStep('build query index', () => index.ensureBuilt(filePath));
        printMemory('after index build');

        await timeStep('first page indexed read', async () => {
            const result = await index.query(filePath, { page: 1, pageSize });
            assertPage(result, roaCount, Math.min(pageSize, roaCount));
        });

        await timeStep(`middle page indexed read (page ${middlePage})`, async () => {
            const result = await index.query(filePath, { page: middlePage, pageSize });
            assertPage(result, roaCount, Math.min(pageSize, roaCount - (middlePage - 1) * pageSize));
        });

        await timeStep(`last page indexed read (page ${lastPage})`, async () => {
            const result = await index.query(filePath, { page: lastPage, pageSize });
            assertPage(result, roaCount, Math.min(pageSize, roaCount - (lastPage - 1) * pageSize));
        });

        await timeStep('exact prefix query', async () => {
            const result = await index.query(filePath, { prefixFilter: exactPrefix, page: 1, pageSize });
            assertPage(result, 1, 1);
        });

        await timeStep('ASN query', async () => {
            const result = await index.query(filePath, { asn: exactAsn, page: 1, pageSize });
            assertPage(result, expectedAsnTotal, Math.min(pageSize, expectedAsnTotal));
        });

        await timeStep('missing exact prefix query', async () => {
            const result = await index.query(filePath, { prefixFilter: '203.0.113.255/32', page: 1, pageSize });
            assertPage(result, 0, 0);
        });

        printMemory('after queries');
    } finally {
        await fs.promises.unlink(filePath).catch(() => {});
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
