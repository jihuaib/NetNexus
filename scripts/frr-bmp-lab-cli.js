const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
    BMP_MONITOR_POLICIES,
    DEFAULT_FRR_IMAGE,
    DEFAULT_ROUTES_PER_FAMILY,
    FRR_BMP_ADDRESS_FAMILIES,
    FrrBmpLab,
    MAX_ROUTES_PER_FAMILY
} = require('./e2e-support/frr-bmp-lab');

const execFileAsync = promisify(execFile);
const DEFAULT_COLLECTOR_HOST = 'host.docker.internal';
const DEFAULT_COLLECTOR_PORT = 1790;
const PROJECT_ROOT = fs.realpathSync(path.join(__dirname, '..'));
const PROJECT_ID = crypto.createHash('sha256').update(PROJECT_ROOT).digest('hex').slice(0, 12);
const LABEL_PREFIX = 'com.netnexus.frr-bmp-lab';
const LABELS = Object.freeze({
    managed: `${LABEL_PREFIX}.managed`,
    project: `${LABEL_PREFIX}.project`,
    role: `${LABEL_PREFIX}.role`,
    collectorHost: `${LABEL_PREFIX}.collector-host`,
    collectorPort: `${LABEL_PREFIX}.collector-port`,
    routesPerFamily: `${LABEL_PREFIX}.routes-per-family`
});
const MANAGED_VALUE = 'true';

const VALUE_OPTIONS = new Map([
    ['--port', 'collectorPort'],
    ['--collector-port', 'collectorPort'],
    ['--routes', 'routesPerFamily'],
    ['--routes-per-family', 'routesPerFamily'],
    ['--collector-host', 'collectorHost'],
    ['--image', 'image']
]);
const BOOLEAN_OPTIONS = new Map([
    ['--replace', 'replace'],
    ['--json', 'json']
]);
const START_ONLY_OPTIONS = new Set(['collectorPort', 'routesPerFamily', 'collectorHost', 'image', 'replace']);

function integerOption(value, name, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${name} 必须是 ${minimum}-${maximum} 之间的整数，当前值：${value}`);
    }
    return parsed;
}

function collectorHostOption(value) {
    const host = String(value || '').trim();
    const normalized = host.toLowerCase();
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(normalized)) {
        throw new Error(
            `--collector-host 不能使用 ${host}：它在 FRR 容器中指向容器自身；本机 NetNexus 请使用 ${DEFAULT_COLLECTOR_HOST}`
        );
    }
    if (!host || !/^[a-zA-Z0-9_.:%-]+$/u.test(host)) {
        throw new Error(`无效的 --collector-host：${value}`);
    }
    return host;
}

function parseArgs(argv, env = process.env) {
    if (!Array.isArray(argv) || argv.length === 0) {
        throw new Error('缺少命令，请使用 start、status 或 stop');
    }

    const requestedCommand = argv[0];
    if (['help', '--help', '-h'].includes(requestedCommand)) {
        return { command: 'help', json: false };
    }
    if (!['start', 'status', 'stop'].includes(requestedCommand)) {
        throw new Error(`未知命令：${requestedCommand}`);
    }

    const values = {};
    const seen = new Set();
    for (let index = 1; index < argv.length; index += 1) {
        const token = argv[index];
        if (['--help', '-h'].includes(token)) {
            return { command: 'help', json: false };
        }
        if (!String(token).startsWith('--')) {
            throw new Error(`无法识别的参数：${token}`);
        }

        const equalsIndex = token.indexOf('=');
        const optionName = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
        const inlineValue = equalsIndex === -1 ? null : token.slice(equalsIndex + 1);
        const valueKey = VALUE_OPTIONS.get(optionName);
        const booleanKey = BOOLEAN_OPTIONS.get(optionName);
        const key = valueKey || booleanKey;
        if (!key) {
            throw new Error(`未知参数：${optionName}`);
        }
        if (seen.has(key)) {
            throw new Error(`参数重复：${optionName}`);
        }
        seen.add(key);

        if (booleanKey) {
            if (inlineValue !== null) {
                throw new Error(`${optionName} 不接受参数值`);
            }
            values[booleanKey] = true;
            continue;
        }

        let optionValue = inlineValue;
        if (optionValue === null) {
            optionValue = argv[index + 1];
            if (optionValue === undefined || String(optionValue).startsWith('--')) {
                throw new Error(`${optionName} 缺少参数值`);
            }
            index += 1;
        }
        if (optionValue === '') {
            throw new Error(`${optionName} 缺少参数值`);
        }
        values[valueKey] = optionValue;
    }

    for (const key of seen) {
        if (requestedCommand !== 'start' && START_ONLY_OPTIONS.has(key)) {
            throw new Error(`${requestedCommand} 不支持参数 ${key}`);
        }
    }

    const base = {
        command: requestedCommand,
        json: values.json === true
    };
    if (requestedCommand !== 'start') {
        return base;
    }

    const image = String(values.image || env.FRR_IMAGE || DEFAULT_FRR_IMAGE).trim();
    if (!image || /[\r\n]/u.test(image)) {
        throw new Error(`无效的 --image：${values.image}`);
    }

    return {
        ...base,
        collectorHost: collectorHostOption(values.collectorHost || env.BMP_COLLECTOR_HOST || DEFAULT_COLLECTOR_HOST),
        collectorPort: integerOption(
            values.collectorPort || env.FRR_BMP_COLLECTOR_PORT || DEFAULT_COLLECTOR_PORT,
            '--port',
            1,
            65535
        ),
        routesPerFamily: integerOption(
            values.routesPerFamily || env.FRR_BMP_ROUTES_PER_FAMILY || DEFAULT_ROUTES_PER_FAMILY,
            '--routes',
            1,
            MAX_ROUTES_PER_FAMILY
        ),
        image,
        replace: values.replace === true
    };
}

function formatHelp() {
    return `FRR BMP 手工联调环境

用法：
  npm run frr:bmp:lab -- start [选项]
  npm run frr:bmp:lab -- status [--json]
  npm run frr:bmp:lab -- stop [--json]

start 选项：
  --port, --collector-port <端口>       NetNexus BMP 服务端端口（默认 ${DEFAULT_COLLECTOR_PORT}）
  --routes, --routes-per-family <数量>  每个可扩展地址族的路由数（默认 ${DEFAULT_ROUTES_PER_FAMILY}，最大 ${MAX_ROUTES_PER_FAMILY}）
  --collector-host <主机>               FRR 连接的宿主机地址（默认 ${DEFAULT_COLLECTOR_HOST}）
  --image <镜像>                        FRR Docker 镜像
  --replace                             删除本工作区已有手工环境后重新创建
  --json                                输出 JSON

环境变量：FRR_BMP_COLLECTOR_PORT、FRR_BMP_ROUTES_PER_FAMILY、BMP_COLLECTOR_HOST、FRR_IMAGE`;
}

function expectedRouteCounts(routesPerFamily) {
    const scalableFamilies = FRR_BMP_ADDRESS_FAMILIES.filter(family => family.scalable).length;
    const fixedRoutes = FRR_BMP_ADDRESS_FAMILIES.filter(family => !family.scalable).length;
    const sourceRoutes = routesPerFamily * scalableFamilies + fixedRoutes;
    return {
        sourceRoutes,
        persistedRoutes: sourceRoutes * BMP_MONITOR_POLICIES.length
    };
}

function dockerError(error, args) {
    const detail = [error.stdout, error.stderr]
        .filter(Boolean)
        .map(value => String(value).trim())
        .filter(Boolean)
        .join('\n');
    return new Error(`docker ${args.join(' ')} 执行失败：${detail || error.message}`);
}

async function docker(args, options = {}) {
    try {
        return await execFileAsync('docker', args, {
            cwd: PROJECT_ROOT,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            timeout: options.timeout || 120000
        });
    } catch (error) {
        if (options.allowFailure) {
            return { stdout: error.stdout || '', stderr: error.stderr || '', error };
        }
        throw dockerError(error, args);
    }
}

async function ensureDocker() {
    const result = await docker(['info', '--format', '{{.ServerVersion}}'], { allowFailure: true, timeout: 30000 });
    if (result.error) {
        throw new Error(`Docker 未运行或不可访问：${String(result.stderr || result.error.message).trim()}`);
    }
}

function resourceFilters() {
    return [
        '--filter',
        `label=${LABELS.managed}=${MANAGED_VALUE}`,
        '--filter',
        `label=${LABELS.project}=${PROJECT_ID}`
    ];
}

async function inspectResources(kind, ids) {
    if (ids.length === 0) {
        return [];
    }
    const command = kind === 'container' ? ['inspect', ...ids] : ['network', 'inspect', ...ids];
    const result = await docker(command, { timeout: 30000 });
    return JSON.parse(result.stdout);
}

async function listManualResources() {
    const filters = resourceFilters();
    const [containerResult, networkResult] = await Promise.all([
        docker(['ps', '-aq', ...filters], { timeout: 30000 }),
        docker(['network', 'ls', '-q', ...filters], { timeout: 30000 })
    ]);
    const containerIds = String(containerResult.stdout || '')
        .trim()
        .split(/\s+/u)
        .filter(Boolean);
    const networkIds = String(networkResult.stdout || '')
        .trim()
        .split(/\s+/u)
        .filter(Boolean);
    const [containers, networks] = await Promise.all([
        inspectResources('container', containerIds),
        inspectResources('network', networkIds)
    ]);
    return { containers, networks };
}

function containerLabels(container) {
    return container?.Config?.Labels || {};
}

function containerName(container) {
    return String(container?.Name || '').replace(/^\//u, '');
}

function containerRole(container) {
    return containerLabels(container)[LABELS.role] || 'unknown';
}

function primaryLabels(resources) {
    const router = resources.containers.find(container => containerRole(container) === 'router');
    if (router) {
        return containerLabels(router);
    }
    if (resources.containers[0]) {
        return containerLabels(resources.containers[0]);
    }
    return resources.networks[0]?.Labels || {};
}

function summaryHasEstablishedPeer(result) {
    if (result.error) {
        return false;
    }
    try {
        const parsed = JSON.parse(String(result.stdout || ''));
        return Object.values(parsed.peers || {}).some(peer => peer.state === 'Established');
    } catch (_error) {
        return false;
    }
}

async function readRouterStatus(router) {
    if (!router || router.State?.Running !== true) {
        return {
            ipv4Established: false,
            ipv6Established: false,
            bgpEstablished: false,
            bmpConnected: false,
            bmpOutput: ''
        };
    }

    const name = containerName(router);
    const [ipv4, ipv6, bmp] = await Promise.all([
        docker(['exec', name, 'vtysh', '-c', 'show bgp ipv4 unicast summary json'], {
            allowFailure: true,
            timeout: 30000
        }),
        docker(['exec', name, 'vtysh', '-c', 'show bgp ipv6 unicast summary json'], {
            allowFailure: true,
            timeout: 30000
        }),
        docker(['exec', name, 'vtysh', '-c', 'show bmp'], { allowFailure: true, timeout: 30000 })
    ]);
    const ipv4Established = summaryHasEstablishedPeer(ipv4);
    const ipv6Established = summaryHasEstablishedPeer(ipv6);
    const bmpOutput = `${String(bmp.stdout || '')}${String(bmp.stderr || '')}`.trim();
    const connectedClients = Number(bmpOutput.match(/(\d+)\s+connected clients?/iu)?.[1] || 0);
    return {
        ipv4Established,
        ipv6Established,
        bgpEstablished: ipv4Established && ipv6Established,
        bmpConnected: /\bUp\b/iu.test(bmpOutput) && connectedClients > 0,
        bmpOutput
    };
}

async function getManualStatus(options = {}) {
    if (options.ensureDocker !== false) {
        await ensureDocker();
    }
    const resources = await listManualResources();
    const labels = primaryLabels(resources);
    const router = resources.containers.find(container => containerRole(container) === 'router') || null;
    const peer = resources.containers.find(container => containerRole(container) === 'peer') || null;
    const runtime = await readRouterStatus(router);
    const routesPerFamilyValue = Number(labels[LABELS.routesPerFamily]);
    const routesPerFamily = Number.isInteger(routesPerFamilyValue) ? routesPerFamilyValue : null;
    const collectorPortValue = Number(labels[LABELS.collectorPort]);
    const collectorPort = Number.isInteger(collectorPortValue) ? collectorPortValue : null;
    const counts =
        routesPerFamily === null ? { sourceRoutes: null, persistedRoutes: null } : expectedRouteCounts(routesPerFamily);

    return {
        exists: resources.containers.length > 0 || resources.networks.length > 0,
        projectId: PROJECT_ID,
        collectorHost: labels[LABELS.collectorHost] || null,
        collectorPort,
        routesPerFamily,
        expectedSourceRoutes: counts.sourceRoutes,
        expectedPersistedRoutes: counts.persistedRoutes,
        router: router
            ? {
                  name: containerName(router),
                  running: router.State?.Running === true,
                  status: router.State?.Status || 'unknown'
              }
            : null,
        peer: peer
            ? {
                  name: containerName(peer),
                  running: peer.State?.Running === true,
                  status: peer.State?.Status || 'unknown'
              }
            : null,
        networks: resources.networks.map(network => network.Name),
        ...runtime
    };
}

async function removeManualResources(resources) {
    const orderedContainers = [...resources.containers].sort((left, right) => {
        const order = { router: 0, peer: 1, unknown: 2 };
        return order[containerRole(left)] - order[containerRole(right)];
    });
    for (const container of orderedContainers) {
        const name = containerName(container);
        await docker(['stop', '--time', '2', name], { allowFailure: true, timeout: 30000 });
        await docker(['rm', '--force', name], { allowFailure: true, timeout: 30000 });
    }
    for (const network of resources.networks) {
        await docker(['network', 'rm', network.Id], { allowFailure: true, timeout: 30000 });
    }
    return {
        containers: orderedContainers.length,
        networks: resources.networks.length
    };
}

function registerSignalCleanup(lab) {
    let handlingSignal = false;
    const handlers = new Map();
    for (const [signal, exitCode] of [
        ['SIGINT', 130],
        ['SIGTERM', 143]
    ]) {
        const handler = () => {
            if (handlingSignal) {
                return;
            }
            handlingSignal = true;
            process.stderr.write(`\n收到 ${signal}，正在清理 FRR BMP 实验环境...\n`);
            Promise.resolve(lab.cleanup()).finally(() => process.exit(exitCode));
        };
        handlers.set(signal, handler);
        process.once(signal, handler);
    }
    return () => {
        handlers.forEach((handler, signal) => process.removeListener(signal, handler));
    };
}

async function startManualLab(options) {
    await ensureDocker();
    let resources = await listManualResources();
    const exists = resources.containers.length > 0 || resources.networks.length > 0;
    if (exists && !options.replace) {
        throw new Error('本工作区的 FRR BMP 实验环境已经存在；请先执行 status/stop，或在 start 后添加 --replace');
    }
    if (exists) {
        await removeManualResources(resources);
        resources = await listManualResources();
        if (resources.containers.length > 0 || resources.networks.length > 0) {
            throw new Error('旧 FRR BMP 实验环境清理不完整，无法重新创建');
        }
    }

    const commonLabels = {
        [LABELS.managed]: MANAGED_VALUE,
        [LABELS.project]: PROJECT_ID,
        [LABELS.collectorHost]: options.collectorHost,
        [LABELS.collectorPort]: String(options.collectorPort),
        [LABELS.routesPerFamily]: String(options.routesPerFamily)
    };
    const lab = new FrrBmpLab({
        collectorHost: options.collectorHost,
        collectorPort: options.collectorPort,
        routesPerFamily: options.routesPerFamily,
        image: options.image,
        nameSuffix: `manual-${PROJECT_ID}`,
        dockerLabels: commonLabels,
        routerDockerLabels: { [LABELS.role]: 'router' },
        peerDockerLabels: { [LABELS.role]: 'peer' }
    });
    const unregisterSignalCleanup = registerSignalCleanup(lab);
    try {
        await lab.start({ waitForCollector: false });
        lab.releaseTempDir();
    } finally {
        unregisterSignalCleanup();
    }
    return getManualStatus({ ensureDocker: false });
}

async function stopManualLab() {
    await ensureDocker();
    const resources = await listManualResources();
    const removed = await removeManualResources(resources);
    const remaining = await listManualResources();
    if (remaining.containers.length > 0 || remaining.networks.length > 0) {
        throw new Error('FRR BMP 实验环境清理不完整，请检查 Docker 状态');
    }
    return {
        stopped: removed.containers > 0 || removed.networks > 0,
        projectId: PROJECT_ID,
        removed
    };
}

function runningText(resource) {
    if (!resource) {
        return '不存在';
    }
    return `${resource.name}（${resource.running ? '运行中' : resource.status}）`;
}

function formatStatus(status) {
    if (!status.exists) {
        return (
            'FRR BMP 实验环境未启动。\n' +
            `启动命令：npm run frr:bmp:lab -- start --port ${DEFAULT_COLLECTOR_PORT} --routes ${DEFAULT_ROUTES_PER_FAMILY}`
        );
    }

    const bgp = status.bgpEstablished
        ? 'IPv4/IPv6 均已 Established'
        : `IPv4=${status.ipv4Established ? 'Established' : '未建立'}，IPv6=${
              status.ipv6Established ? 'Established' : '未建立'
          }`;
    const collector = `${status.collectorHost || '未知主机'}:${status.collectorPort || '未知端口'}`;
    const bmp = status.bmpConnected
        ? `已连接 NetNexus（${collector}）`
        : `等待 NetNexus（${collector}，FRR 会持续重试）`;
    const routes =
        status.routesPerFamily === null
            ? '未知'
            : `每个可扩展地址族 ${status.routesPerFamily} 条；预计 ${status.expectedSourceRoutes} 条源路由 / ${status.expectedPersistedRoutes} 条三视图路由`;

    return [
        'FRR BMP 实验环境状态：',
        `  Router: ${runningText(status.router)}`,
        `  Peer: ${runningText(status.peer)}`,
        `  Network: ${status.networks.join(', ') || '不存在'}`,
        `  BGP: ${bgp}`,
        `  BMP: ${bmp}`,
        `  路由: ${routes}`
    ].join('\n');
}

function formatStart(status) {
    return [
        'FRR BMP 实验环境已启动并完成路由配置。',
        '',
        formatStatus(status),
        '',
        '下一步：',
        '  1. 执行 npm run dev 启动 NetNexus',
        `  2. 打开“BMP → BMP配置”，将“服务端端口”设为 ${status.collectorPort}，不启用认证，点击“启动服务器”`,
        '  3. 执行 npm run frr:bmp:lab -- status，确认 BMP 显示“已连接”',
        '  4. 在“BGP会话 / BGP Loc-RIB”及统计页面查看真实 FRR 数据',
        '  5. 完成后执行 npm run frr:bmp:lab -- stop'
    ].join('\n');
}

function formatStop(result) {
    if (!result.stopped) {
        return 'FRR BMP 实验环境原本就未启动，无需清理。';
    }
    return `FRR BMP 实验环境已停止并清理：${result.removed.containers} 个容器，${result.removed.networks} 个网络。`;
}

async function execute(options, dependencies = {}) {
    const write = dependencies.write || (value => console.log(value));
    if (options.command === 'help') {
        const output = formatHelp();
        write(output);
        return output;
    }

    const operations = {
        start: dependencies.startManualLab || startManualLab,
        status: dependencies.getManualStatus || getManualStatus,
        stop: dependencies.stopManualLab || stopManualLab
    };
    const result = await operations[options.command](options);
    const output = options.json
        ? JSON.stringify(result, null, 2)
        : options.command === 'start'
          ? formatStart(result)
          : options.command === 'status'
            ? formatStatus(result)
            : formatStop(result);
    write(output);
    return result;
}

async function main() {
    try {
        const options = parseArgs(process.argv.slice(2));
        await execute(options);
    } catch (error) {
        console.error(`FRR BMP 实验环境操作失败：${error.message}`);
        console.error('运行 npm run frr:bmp:lab -- --help 查看用法。');
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    DEFAULT_COLLECTOR_HOST,
    DEFAULT_COLLECTOR_PORT,
    LABELS,
    PROJECT_ID,
    execute,
    expectedRouteCounts,
    formatHelp,
    formatStart,
    formatStatus,
    formatStop,
    getManualStatus,
    parseArgs,
    startManualLab,
    stopManualLab
};
