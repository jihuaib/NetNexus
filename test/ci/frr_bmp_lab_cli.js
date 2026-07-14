const assert = require('node:assert/strict');
const {
    DEFAULT_COLLECTOR_HOST,
    DEFAULT_COLLECTOR_PORT,
    execute,
    expectedRouteCounts,
    formatHelp,
    formatStatus,
    parseArgs
} = require('../../scripts/frr-bmp-lab-cli');
const {
    DEFAULT_FRR_IMAGE,
    DEFAULT_ROUTES_PER_FAMILY,
    MAX_ROUTES_PER_FAMILY
} = require('../../scripts/e2e-support/frr-bmp-lab');

function assertArgumentError(argv, pattern) {
    assert.throws(() => parseArgs(argv, {}), pattern);
}

function sampleStatus(overrides = {}) {
    return {
        exists: true,
        projectId: 'test-project',
        collectorHost: DEFAULT_COLLECTOR_HOST,
        collectorPort: DEFAULT_COLLECTOR_PORT,
        routesPerFamily: 2,
        expectedSourceRoutes: 12,
        expectedPersistedRoutes: 36,
        router: { name: 'router', running: true, status: 'running' },
        peer: { name: 'peer', running: true, status: 'running' },
        networks: ['network'],
        ipv4Established: true,
        ipv6Established: true,
        bgpEstablished: true,
        bmpConnected: false,
        bmpOutput: '',
        ...overrides
    };
}

async function main() {
    assert.deepEqual(parseArgs(['start'], {}), {
        command: 'start',
        json: false,
        collectorHost: DEFAULT_COLLECTOR_HOST,
        collectorPort: DEFAULT_COLLECTOR_PORT,
        routesPerFamily: DEFAULT_ROUTES_PER_FAMILY,
        image: DEFAULT_FRR_IMAGE,
        replace: false
    });
    assert.deepEqual(
        parseArgs(
            [
                'start',
                '--collector-port=21790',
                '--routes-per-family',
                '2048',
                '--collector-host',
                '192.0.2.10',
                '--image',
                'frr:test',
                '--replace',
                '--json'
            ],
            {}
        ),
        {
            command: 'start',
            json: true,
            collectorHost: '192.0.2.10',
            collectorPort: 21790,
            routesPerFamily: 2048,
            image: 'frr:test',
            replace: true
        }
    );
    assert.deepEqual(
        parseArgs(['start'], {
            FRR_BMP_COLLECTOR_PORT: '31790',
            FRR_BMP_ROUTES_PER_FAMILY: '5',
            BMP_COLLECTOR_HOST: 'gateway.example',
            FRR_IMAGE: 'frr:env'
        }),
        {
            command: 'start',
            json: false,
            collectorHost: 'gateway.example',
            collectorPort: 31790,
            routesPerFamily: 5,
            image: 'frr:env',
            replace: false
        }
    );
    assert.deepEqual(parseArgs(['status', '--json'], {}), { command: 'status', json: true });
    assert.deepEqual(parseArgs(['stop'], {}), { command: 'stop', json: false });
    assert.deepEqual(parseArgs(['start', '--help'], {}), { command: 'help', json: false });

    assertArgumentError([], /缺少命令/u);
    assertArgumentError(['launch'], /未知命令/u);
    assertArgumentError(['start', '--unknown'], /未知参数/u);
    assertArgumentError(['start', 'unexpected'], /无法识别/u);
    assertArgumentError(['start', '--port'], /缺少参数值/u);
    assertArgumentError(['start', '--port', '0'], /1-65535/u);
    assertArgumentError(['start', '--port', '65536'], /1-65535/u);
    assertArgumentError(['start', '--port', '1.5'], /1-65535/u);
    assertArgumentError(['start', '--routes', '0'], /1-16000/u);
    assertArgumentError(['start', '--routes', String(MAX_ROUTES_PER_FAMILY + 1)], /1-16000/u);
    assertArgumentError(['start', '--routes', '2', '--routes-per-family', '3'], /参数重复/u);
    assertArgumentError(['start', '--port', '1790', '--collector-port', '1791'], /参数重复/u);
    assertArgumentError(['start', '--replace=true'], /不接受参数值/u);
    assertArgumentError(['start', '--collector-host', 'localhost'], /容器自身/u);
    assertArgumentError(['start', '--collector-host', '127.0.0.1'], /容器自身/u);
    assertArgumentError(['status', '--routes', '2'], /status 不支持参数/u);
    assertArgumentError(['stop', '--replace'], /stop 不支持参数/u);

    assert.deepEqual(expectedRouteCounts(1), { sourceRoutes: 7, persistedRoutes: 21 });
    assert.deepEqual(expectedRouteCounts(1024), { sourceRoutes: 5122, persistedRoutes: 15366 });
    assert.match(formatHelp(), /npm run frr:bmp:lab -- start/u);
    assert.match(formatHelp(), /--routes-per-family/u);
    assert.match(formatStatus({ exists: false }), /未启动/u);
    assert.match(formatStatus(sampleStatus()), /等待 NetNexus/u);
    assert.match(formatStatus(sampleStatus({ bmpConnected: true })), /已连接 NetNexus/u);

    const calls = [];
    const output = [];
    const status = sampleStatus();
    await execute(
        {
            command: 'start',
            json: false,
            collectorHost: DEFAULT_COLLECTOR_HOST,
            collectorPort: DEFAULT_COLLECTOR_PORT,
            routesPerFamily: 2,
            image: DEFAULT_FRR_IMAGE,
            replace: false
        },
        {
            startManualLab: async options => {
                calls.push(['start', options.routesPerFamily]);
                return status;
            },
            write: value => output.push(value)
        }
    );
    await execute(
        { command: 'status', json: true },
        {
            getManualStatus: async () => {
                calls.push(['status']);
                return status;
            },
            write: value => output.push(value)
        }
    );
    await execute(
        { command: 'stop', json: false },
        {
            stopManualLab: async () => {
                calls.push(['stop']);
                return { stopped: true, removed: { containers: 2, networks: 1 } };
            },
            write: value => output.push(value)
        }
    );
    await execute(
        { command: 'help', json: false },
        {
            write: value => output.push(value)
        }
    );

    assert.deepEqual(calls, [['start', 2], ['status'], ['stop']]);
    assert.match(output[0], /已启动并完成路由配置/u);
    assert.equal(JSON.parse(output[1]).expectedSourceRoutes, 12);
    assert.match(output[2], /2 个容器/u);
    assert.match(output[3], /FRR BMP 手工联调环境/u);

    console.log('FRR BMP manual lab CLI tests passed');
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
