const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const BgpConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'bgpConst.js'));
const { iterateMrtRoutes } = require(path.join(__dirname, '..', '..', 'electron', 'utils', 'routeViewsUtils.js'));

function makeIpv4TableDumpRecord(index) {
    const data = Buffer.alloc(22);
    const octet2 = Math.floor(index / 256) % 256;
    const octet3 = index % 256;
    data.set([10, octet2, octet3, 1], 4);
    data[8] = 32;
    data.writeUInt16BE(0, 20);

    const header = Buffer.alloc(12);
    header.writeUInt16BE(12, 4);
    header.writeUInt16BE(1, 6);
    header.writeUInt32BE(data.length, 8);
    return Buffer.concat([header, data]);
}

function makeFixture(routeCount) {
    const records = [];
    for (let index = 0; index < routeCount; index += 1) {
        records.push(makeIpv4TableDumpRecord(index));
    }
    return Buffer.concat(records);
}

async function collectRoutes(iterator) {
    const routes = [];
    for await (const route of iterator) {
        routes.push(route);
    }
    return routes;
}

(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-mrt-stream-'));

    try {
        const rawPath = path.join(tempDir, 'routes.mrt');
        const gzipPath = path.join(tempDir, 'routes.mrt.gz');
        const fixture = makeFixture(1200);
        fs.writeFileSync(rawPath, fixture);
        fs.writeFileSync(gzipPath, zlib.gzipSync(fixture));

        const progress = [];
        const streamedRoutes = [];
        for await (const route of iterateMrtRoutes(rawPath, 600, BgpConst.BGP_AFI_TYPE.AFI_IPV4, message =>
            progress.push(message)
        )) {
            streamedRoutes.push(route);
        }

        assert.strictEqual(streamedRoutes.length, 600);
        assert.deepStrictEqual(streamedRoutes[0], { ip: '10.0.0.1', mask: 32, formatted: '' });
        assert.deepStrictEqual(streamedRoutes[599], { ip: '10.2.87.1', mask: 32, formatted: '' });
        assert.deepStrictEqual(progress, ['正在准备解析 MRT 文件...', '已解析 500 条路由...']);

        const gzipRoutes = [];
        for await (const route of iterateMrtRoutes(gzipPath, 5, BgpConst.BGP_AFI_TYPE.AFI_IPV4)) {
            gzipRoutes.push(route);
        }
        assert.strictEqual(gzipRoutes.length, 5, 'gzip imports should stop at the requested limit');

        let earlyBreakCount = 0;
        for await (const route of iterateMrtRoutes(rawPath, 1200, BgpConst.BGP_AFI_TYPE.AFI_IPV4)) {
            assert.ok(route.ip);
            earlyBreakCount += 1;
            if (earlyBreakCount === 7) break;
        }
        assert.strictEqual(earlyBreakCount, 7, 'the iterator should support cancellation by its consumer');

        const zeroLimitRoutes = await collectRoutes(iterateMrtRoutes(rawPath, 0, BgpConst.BGP_AFI_TYPE.AFI_IPV4));
        assert.deepStrictEqual(zeroLimitRoutes, []);

        await assert.rejects(
            () => collectRoutes(iterateMrtRoutes(path.join(tempDir, 'missing.mrt'), 1, BgpConst.BGP_AFI_TYPE.AFI_IPV4)),
            /文件不存在/
        );

        const corruptPath = path.join(tempDir, 'corrupt.mrt');
        const corruptHeader = Buffer.alloc(12);
        corruptHeader.writeUInt32BE(64 * 1024 * 1024 + 1, 8);
        fs.writeFileSync(corruptPath, corruptHeader);
        await assert.rejects(
            () => collectRoutes(iterateMrtRoutes(corruptPath, 1, BgpConst.BGP_AFI_TYPE.AFI_IPV4)),
            /MRT 记录长度异常/
        );

        console.log('Route Views streaming tests passed');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
