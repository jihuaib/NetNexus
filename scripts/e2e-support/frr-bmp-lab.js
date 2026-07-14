const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const DEFAULT_FRR_IMAGE =
    'quay.io/frrouting/frr:10.5.4@sha256:17a66aa754b4f60d58fae6cf3c357b62cfb574beb2a4cacd26d50e3df8440b78';
const DEFAULT_ROUTES_PER_FAMILY = 1024;
const MAX_ROUTES_PER_FAMILY = 16000;
const ROUTER_AS = 65000;
const PEER_AS = 65100;
const ROUTER_ID = '192.0.2.1';
const PEER_ROUTER_ID = '192.0.2.2';
const BMP_MONITOR_POLICIES = Object.freeze(['pre-policy', 'post-policy', 'loc-rib']);

const FRR_BMP_ADDRESS_FAMILIES = Object.freeze(
    [
        {
            key: 'ipv4-unicast',
            name: 'IPv4 Unicast',
            afi: 1,
            safi: 1,
            frrFamily: 'ipv4 unicast',
            transport: 'ipv4',
            routeKind: 'ipv4',
            prefixBlock: 0,
            scalable: true,
            liveWithdraw: true
        },
        {
            key: 'ipv6-unicast',
            name: 'IPv6 Unicast',
            afi: 2,
            safi: 1,
            frrFamily: 'ipv6 unicast',
            transport: 'ipv6',
            routeKind: 'ipv6',
            prefixBlock: 1,
            scalable: true,
            liveWithdraw: true
        },
        {
            key: 'ipv4-multicast',
            name: 'IPv4 Multicast',
            afi: 1,
            safi: 2,
            frrFamily: 'ipv4 multicast',
            transport: 'ipv4',
            routeKind: 'default',
            scalable: false,
            liveWithdraw: true
        },
        {
            key: 'ipv6-multicast',
            name: 'IPv6 Multicast',
            afi: 2,
            safi: 2,
            frrFamily: 'ipv6 multicast',
            transport: 'ipv6',
            routeKind: 'default',
            scalable: false,
            liveWithdraw: true
        },
        {
            key: 'vpnv4',
            name: 'VPNv4',
            afi: 1,
            safi: 128,
            frrFamily: 'ipv4 vpn',
            transport: 'ipv4',
            routeKind: 'vpnv4',
            prefixBlock: 128,
            rd: `${PEER_AS}:4`,
            labelBase: 16000,
            scalable: true,
            liveWithdraw: false
        },
        {
            key: 'vpnv6',
            name: 'VPNv6',
            afi: 2,
            safi: 128,
            frrFamily: 'ipv6 vpn',
            transport: 'ipv6',
            routeKind: 'vpnv6',
            prefixBlock: 3,
            rd: `${PEER_AS}:6`,
            labelBase: 18000,
            scalable: true,
            liveWithdraw: false
        },
        {
            key: 'l2vpn-evpn',
            name: 'L2VPN EVPN',
            afi: 25,
            safi: 70,
            frrFamily: 'l2vpn evpn',
            transport: 'ipv4',
            routeKind: 'evpn',
            rd: `${PEER_AS}:70`,
            labelBase: 20000,
            scalable: true,
            liveWithdraw: false
        }
    ].map(Object.freeze)
);

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function dockerLabelArgs(labels = {}) {
    return Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

function normalizeNameSuffix(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const suffix = String(value).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,48}$/u.test(suffix)) {
        throw new Error(`Invalid FRR BMP lab name suffix: ${value}`);
    }
    return suffix;
}

function positiveInteger(value, fallback, name, maximum) {
    const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
        throw new Error(`${name} must be an integer between 1 and ${maximum}, got ${value}`);
    }
    return parsed;
}

function ipv4Prefix(secondOctetBase, index) {
    const secondOctet = secondOctetBase + Math.floor(index / 256);
    const thirdOctet = index % 256;
    return `10.${secondOctet}.${thirdOctet}.0/24`;
}

function ipv6Prefix(block, index) {
    return `2001:db8:${block.toString(16)}:${index.toString(16)}::/64`;
}

function makeRoute(family, index, count, addresses) {
    let prefix;
    let announce;
    let withdraw;

    switch (family.routeKind) {
        case 'ipv4':
            prefix = ipv4Prefix(family.prefixBlock, index);
            announce = `network ${prefix}`;
            withdraw = `no network ${prefix}`;
            break;
        case 'ipv6':
            prefix = ipv6Prefix(family.prefixBlock, index);
            announce = `network ${prefix}`;
            withdraw = `no network ${prefix}`;
            break;
        case 'vpnv4':
            prefix = ipv4Prefix(family.prefixBlock, index);
            announce = `network ${prefix} rd ${family.rd} label ${family.labelBase + index}`;
            withdraw = `no network ${prefix} rd ${family.rd} label ${family.labelBase + index}`;
            break;
        case 'vpnv6':
            prefix = ipv6Prefix(family.prefixBlock, index);
            announce = `network ${prefix} rd ${family.rd} label ${family.labelBase + index}`;
            withdraw = `no network ${prefix} rd ${family.rd} label ${family.labelBase + index}`;
            break;
        case 'evpn': {
            // FRR 10.5's test-only static RT-5 command aliases IPv4 prefixes
            // that share the first two octets. Keep one IPv4 RT-5 sentinel for
            // parser coverage and scale this AFI/SAFI with distinct IPv6 RT-5s.
            const ipv4 = index === 0;
            const addressIndex = ipv4 ? 0 : index - 1;
            prefix = ipv4 ? ipv4Prefix(192, addressIndex) : ipv6Prefix(5, addressIndex);
            const gateway = ipv4 ? addresses.peerIp : addresses.peerIpv6;
            const common =
                `${prefix} rd ${family.rd} ethtag 0 label ${family.labelBase + index} ` +
                `esi 00:00:00:00:00:00:00:00:00:00 gwip ${gateway}`;
            announce = `network ${common} routermac 02:00:00:00:01:05`;
            withdraw = `no network ${common}`;
            break;
        }
        case 'default': {
            const neighbor = family.transport === 'ipv4' ? addresses.routerIp : addresses.routerIpv6;
            prefix = family.transport === 'ipv4' ? '0.0.0.0/0' : '::/0';
            announce = `neighbor ${neighbor} default-originate`;
            withdraw = `no neighbor ${neighbor} default-originate`;
            break;
        }
        default:
            throw new Error(`Unsupported FRR BMP route kind: ${family.routeKind}`);
    }

    return Object.freeze({ index, prefix, announce, withdraw });
}

function buildRoutePlan(routesPerFamily, addresses) {
    return FRR_BMP_ADDRESS_FAMILIES.map(family => {
        const count = family.scalable ? routesPerFamily : 1;
        const routes = Array.from({ length: count }, (_, index) => makeRoute(family, index, count, addresses));
        return Object.freeze({ family, routes: Object.freeze(routes) });
    });
}

function monitorConfig() {
    return FRR_BMP_ADDRESS_FAMILIES.flatMap(family =>
        BMP_MONITOR_POLICIES.map(policy => `  bmp monitor ${family.frrFamily} ${policy}`)
    ).join('\n');
}

function addressFamilyConfig(addresses, softReconfiguration) {
    return FRR_BMP_ADDRESS_FAMILIES.map(family => {
        const neighbor = family.transport === 'ipv4' ? addresses.peerIp : addresses.peerIpv6;
        const lines = [` address-family ${family.frrFamily}`, `  neighbor ${neighbor} activate`];
        if (softReconfiguration) {
            lines.push(`  neighbor ${neighbor} soft-reconfiguration inbound`);
        }
        lines.push(' exit-address-family');
        return lines.join('\n');
    }).join('\n !\n');
}

function routerConfig({ collectorHost, collectorPort, peerIp, peerIpv6 }) {
    return `
frr defaults traditional
hostname netnexus-frr-router
log stdout
!
router bgp ${ROUTER_AS}
 bgp router-id ${ROUTER_ID}
 no bgp default ipv4-unicast
 no bgp ebgp-requires-policy
 neighbor ${peerIp} remote-as ${PEER_AS}
 neighbor ${peerIpv6} remote-as ${PEER_AS}
 !
${addressFamilyConfig({ peerIp, peerIpv6 }, true)}
 !
 bmp targets netnexus
  bmp connect ${collectorHost} port ${collectorPort} min-retry 100 max-retry 1000
  bmp stats interval 1000
${monitorConfig()}
 exit
exit
!
end
`.trimStart();
}

function peerConfig({ routerIp, routerIpv6 }) {
    return `
frr defaults traditional
hostname netnexus-frr-peer
log stdout
!
router bgp ${PEER_AS}
 bgp router-id ${PEER_ROUTER_ID}
 no bgp default ipv4-unicast
 no bgp ebgp-requires-policy
 no bgp network import-check
 neighbor ${routerIp} remote-as ${ROUTER_AS}
 neighbor ${routerIpv6} remote-as ${ROUTER_AS}
 !
${addressFamilyConfig({ peerIp: routerIp, peerIpv6: routerIpv6 }, false)}
exit
!
end
`.trimStart();
}

function routeCommandConfig(routePlan, action, sentinelsOnly = false) {
    const lines = [`router bgp ${PEER_AS}`];
    routePlan.forEach(({ family, routes }) => {
        if (sentinelsOnly && !family.liveWithdraw) {
            return;
        }
        lines.push(` address-family ${family.frrFamily}`);
        const selectedRoutes = sentinelsOnly ? routes.slice(0, 1) : routes;
        selectedRoutes.forEach(route => lines.push(`  ${route[action]}`));
        lines.push(' exit-address-family');
    });
    lines.push('exit', 'end');
    return `${lines.join('\n')}\n`;
}

function commandFailure(error, args) {
    const output = [error.stdout, error.stderr]
        .filter(Boolean)
        .map(value => String(value).trim())
        .filter(Boolean)
        .join('\n');
    const suffix = output ? `\n${output}` : '';
    return new Error(`docker ${args.join(' ')} failed: ${error.message}${suffix}`);
}

async function docker(args, options = {}) {
    try {
        return await execFileAsync('docker', args, {
            cwd: options.cwd,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            timeout: options.timeout || 120000
        });
    } catch (error) {
        if (options.allowFailure) {
            return {
                stdout: error.stdout || '',
                stderr: error.stderr || '',
                error
            };
        }
        throw commandFailure(error, args);
    }
}

class FrrBmpLab {
    constructor(options = {}) {
        this.image = options.image || process.env.FRR_IMAGE || DEFAULT_FRR_IMAGE;
        this.collectorHost = options.collectorHost || process.env.BMP_COLLECTOR_HOST || 'host.docker.internal';
        this.collectorPort = Number(options.collectorPort);
        this.routesPerFamily = positiveInteger(
            options.routesPerFamily ?? process.env.FRR_BMP_ROUTES_PER_FAMILY,
            DEFAULT_ROUTES_PER_FAMILY,
            'FRR BMP routes per scalable family',
            MAX_ROUTES_PER_FAMILY
        );
        this.nameSuffix = normalizeNameSuffix(options.nameSuffix);
        this.dockerLabels = { ...(options.dockerLabels || {}) };
        this.routerDockerLabels = { ...(options.routerDockerLabels || {}) };
        this.peerDockerLabels = { ...(options.peerDockerLabels || {}) };
        this.tempDir = null;
        this.networkName = null;
        this.routerName = null;
        this.peerName = null;
        this.routerIp = null;
        this.peerIp = null;
        this.routerIpv6 = null;
        this.peerIpv6 = null;
        this.routePlan = [];
        this.started = false;
        this.announceDurationMs = null;

        if (!Number.isInteger(this.collectorPort) || this.collectorPort < 1 || this.collectorPort > 65535) {
            throw new Error(`Invalid BMP collector port: ${options.collectorPort}`);
        }
    }

    get expectedSourceRouteCount() {
        return this.routePlan.reduce((total, item) => total + item.routes.length, 0);
    }

    get expectedPersistedRouteCount() {
        return this.expectedSourceRouteCount * BMP_MONITOR_POLICIES.length;
    }

    get sentinelCount() {
        return this.routePlan.filter(item => item.family.liveWithdraw).length;
    }

    getFamilyPlan(key) {
        return this.routePlan.find(item => item.family.key === key) || null;
    }

    async ensureDocker() {
        const result = await docker(['info', '--format', '{{.ServerVersion}}'], { allowFailure: true, timeout: 30000 });
        if (result.error) {
            throw new Error(
                `FRR BMP E2E requires a running Docker daemon. ${String(result.stderr || result.error.message).trim()}`
            );
        }
    }

    async ensureImage() {
        const inspect = await docker(['image', 'inspect', this.image], { allowFailure: true, timeout: 30000 });
        if (!inspect.error) {
            return;
        }
        await docker(['pull', this.image], { timeout: 10 * 60 * 1000 });
    }

    async createNetwork() {
        const token = this.nameSuffix || crypto.randomBytes(4).toString('hex');
        for (let attempt = 0; attempt < 24; attempt += 1) {
            const subnetOctet = crypto.randomInt(32, 224);
            const ipv6Token = crypto
                .randomBytes(4)
                .toString('hex')
                .match(/.{1,4}/g);
            const networkName = `netnexus-bmp-${token}-${attempt}`;
            const subnet = `172.28.${subnetOctet}.0/24`;
            const ipv6Base = `fd28:${ipv6Token[0]}:${ipv6Token[1]}`;
            const ipv6Subnet = `${ipv6Base}::/64`;
            const result = await docker(
                [
                    'network',
                    'create',
                    ...dockerLabelArgs(this.dockerLabels),
                    '--ipv6',
                    '--subnet',
                    subnet,
                    '--subnet',
                    ipv6Subnet,
                    networkName
                ],
                { allowFailure: true, timeout: 30000 }
            );
            if (result.error) {
                continue;
            }

            this.networkName = networkName;
            this.routerIp = `172.28.${subnetOctet}.2`;
            this.peerIp = `172.28.${subnetOctet}.3`;
            this.routerIpv6 = `${ipv6Base}::2`;
            this.peerIpv6 = `${ipv6Base}::3`;
            return;
        }
        throw new Error('Unable to allocate a non-overlapping dual-stack Docker network for the FRR BMP E2E lab');
    }

    async createBgpdContainer({ name, hostname, ip, ip6, configPath, bmp = false }) {
        const labels = {
            ...this.dockerLabels,
            ...(bmp ? this.routerDockerLabels : this.peerDockerLabels)
        };
        const args = [
            'create',
            '--name',
            name,
            '--hostname',
            hostname,
            ...dockerLabelArgs(labels),
            '--network',
            this.networkName,
            '--ip',
            ip,
            '--ip6',
            ip6
        ];
        if (bmp && process.platform === 'linux') {
            args.push('--add-host', 'host.docker.internal:host-gateway');
        }
        args.push(
            '--entrypoint',
            '/usr/lib/frr/bgpd',
            this.image,
            '-f',
            '/tmp/netnexus-bgpd.conf',
            '-Z',
            '-S',
            '-A',
            '127.0.0.1',
            '--log',
            'stdout',
            '--log-level',
            'info',
            '--limit-fds',
            '10000'
        );
        if (bmp) {
            args.push('-M', 'bmp');
        }

        await docker(args);
        await docker(['cp', configPath, `${name}:/tmp/netnexus-bgpd.conf`]);
        await docker(['start', name]);
    }

    async assertContainerRunning(name) {
        await delay(350);
        const result = await docker(['inspect', '--format', '{{.State.Running}}', name], {
            allowFailure: true,
            timeout: 30000
        });
        if (!result.error && result.stdout.trim() === 'true') {
            return;
        }
        const logs = await docker(['logs', name], { allowFailure: true, timeout: 30000 });
        throw new Error(
            `${name} exited while starting:\n${String(logs.stdout || '')}${String(logs.stderr || '')}`.trimEnd()
        );
    }

    async readSummary(command) {
        return docker(['exec', this.routerName, 'vtysh', '-c', `${command} json`], {
            allowFailure: true,
            timeout: 30000
        });
    }

    summaryHasEstablishedPeer(summary) {
        try {
            const parsed = JSON.parse(String(summary.stdout || ''));
            return Object.values(parsed.peers || {}).some(peer => peer.state === 'Established');
        } catch (_error) {
            return false;
        }
    }

    async waitForControlPlane(options = {}) {
        const waitForCollector = options.waitForCollector !== false;
        const deadline = Date.now() + 45000;
        let lastIpv4Summary = '';
        let lastIpv6Summary = '';
        let lastBmp = '';
        while (Date.now() < deadline) {
            const [ipv4Summary, ipv6Summary, bmp] = await Promise.all([
                this.readSummary('show bgp ipv4 unicast summary'),
                this.readSummary('show bgp ipv6 unicast summary'),
                docker(['exec', this.routerName, 'vtysh', '-c', 'show bmp'], {
                    allowFailure: true,
                    timeout: 30000
                })
            ]);
            lastIpv4Summary = String(ipv4Summary.stdout || '');
            lastIpv6Summary = String(ipv6Summary.stdout || '');
            lastBmp = String(bmp.stdout || '');

            const bmpConnected = /\bUp\b/.test(lastBmp) && /1 connected clients?/.test(lastBmp);
            if (
                this.summaryHasEstablishedPeer(ipv4Summary) &&
                this.summaryHasEstablishedPeer(ipv6Summary) &&
                (!waitForCollector || bmpConnected)
            ) {
                return;
            }
            await delay(200);
        }
        throw new Error(
            `FRR control plane did not converge${waitForCollector ? ' or BMP collector did not connect' : ''}` +
                `\n--- IPv4 summary ---\n${lastIpv4Summary}` +
                `\n--- IPv6 summary ---\n${lastIpv6Summary}\n--- BMP status ---\n${lastBmp}`
        );
    }

    async applyRouteCommands(action, sentinelsOnly = false) {
        const suffix = sentinelsOnly ? 'sentinels' : 'all';
        const localPath = path.join(this.tempDir, `routes-${action}-${suffix}.conf`);
        const containerPath = `/tmp/routes-${action}-${suffix}.conf`;
        fs.writeFileSync(localPath, routeCommandConfig(this.routePlan, action, sentinelsOnly));
        await docker(['cp', localPath, `${this.peerName}:${containerPath}`], { timeout: 30000 });
        const result = await docker(['exec', this.peerName, 'vtysh', '-f', containerPath], { timeout: 5 * 60 * 1000 });
        const output = `${String(result.stdout || '')}\n${String(result.stderr || '')}`;
        if (/% (Unknown command|Ambiguous command|Command incomplete)/.test(output)) {
            throw new Error(`FRR rejected generated ${action} commands:\n${output.trim()}`);
        }
    }

    async withdrawSentinels() {
        await this.applyRouteCommands('withdraw', true);
    }

    async restoreSentinels() {
        await this.applyRouteCommands('announce', true);
    }

    async start(options = {}) {
        if (this.started) {
            return;
        }

        await this.ensureDocker();
        await this.ensureImage();

        try {
            await this.createNetwork();
            this.routePlan = buildRoutePlan(this.routesPerFamily, {
                routerIp: this.routerIp,
                routerIpv6: this.routerIpv6,
                peerIp: this.peerIp,
                peerIpv6: this.peerIpv6
            });

            const token = this.nameSuffix || crypto.randomBytes(5).toString('hex');
            this.routerName = `netnexus-frr-router-${token}`;
            this.peerName = `netnexus-frr-peer-${token}`;
            this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-frr-bmp-'));
            const routerConfigPath = path.join(this.tempDir, 'router-bgpd.conf');
            const peerConfigPath = path.join(this.tempDir, 'peer-bgpd.conf');
            fs.writeFileSync(
                routerConfigPath,
                routerConfig({
                    collectorHost: this.collectorHost,
                    collectorPort: this.collectorPort,
                    peerIp: this.peerIp,
                    peerIpv6: this.peerIpv6
                })
            );
            fs.writeFileSync(peerConfigPath, peerConfig({ routerIp: this.routerIp, routerIpv6: this.routerIpv6 }));

            await this.createBgpdContainer({
                name: this.peerName,
                hostname: 'netnexus-frr-peer',
                ip: this.peerIp,
                ip6: this.peerIpv6,
                configPath: peerConfigPath
            });
            await this.assertContainerRunning(this.peerName);

            await this.createBgpdContainer({
                name: this.routerName,
                hostname: 'netnexus-frr-router',
                ip: this.routerIp,
                ip6: this.routerIpv6,
                configPath: routerConfigPath,
                bmp: true
            });
            await this.assertContainerRunning(this.routerName);
            await this.waitForControlPlane({ waitForCollector: options.waitForCollector });
            const announceStartedAt = Date.now();
            await this.applyRouteCommands('announce');
            this.announceDurationMs = Date.now() - announceStartedAt;
            this.started = true;
        } catch (error) {
            const diagnostics = await this.getDiagnostics().catch(() => '');
            await this.cleanup().catch(() => {});
            throw new Error(`${error.message}\n${diagnostics}`.trim());
        }
    }

    async stopPeer() {
        if (!this.peerName) {
            return;
        }
        await docker(['stop', '--time', '1', this.peerName], { allowFailure: true, timeout: 30000 });
    }

    releaseTempDir() {
        if (!this.tempDir) {
            return;
        }
        fs.rmSync(this.tempDir, { recursive: true, force: true });
        this.tempDir = null;
    }

    async getDiagnostics() {
        const sections = [];
        for (const [label, name] of [
            ['FRR router', this.routerName],
            ['FRR peer', this.peerName]
        ]) {
            if (!name) {
                continue;
            }
            const logs = await docker(['logs', '--tail', '40', name], { allowFailure: true, timeout: 30000 });
            const usefulLogs = `${String(logs.stdout || '')}${String(logs.stderr || '')}`
                .split('\n')
                .filter(line => line && !line.includes('bgp_zebra_label_manager_connect'))
                .slice(-20)
                .join('\n');
            if (usefulLogs) {
                sections.push(`--- ${label} (${name}) ---\n${usefulLogs}`);
            }
        }
        if (this.routerName) {
            const bmp = await docker(['exec', this.routerName, 'vtysh', '-c', 'show bmp'], {
                allowFailure: true,
                timeout: 30000
            });
            sections.push(`--- FRR BMP status ---\n${String(bmp.stdout || '')}${String(bmp.stderr || '')}`);
            for (const family of FRR_BMP_ADDRESS_FAMILIES) {
                const summary = await this.readSummary(`show bgp ${family.frrFamily} summary`);
                try {
                    const parsed = JSON.parse(String(summary.stdout || ''));
                    const peers = Object.entries(parsed.peers || {}).map(([address, peer]) => ({
                        address,
                        state: peer.state,
                        pfxRcd: peer.pfxRcd,
                        pfxSnt: peer.pfxSnt,
                        outq: peer.outq
                    }));
                    sections.push(
                        `--- FRR ${family.name} summary ---\n${JSON.stringify({ ribCount: parsed.ribCount, peers })}`
                    );
                } catch (_error) {
                    sections.push(`--- FRR ${family.name} summary ---\n${String(summary.stdout || '').slice(0, 2000)}`);
                }
            }
        }
        return sections.join('\n').trim();
    }

    async cleanup() {
        for (const name of [this.routerName, this.peerName]) {
            if (name) {
                await docker(['rm', '--force', name], { allowFailure: true, timeout: 30000 });
            }
        }
        if (this.networkName) {
            await docker(['network', 'rm', this.networkName], { allowFailure: true, timeout: 30000 });
        }
        this.releaseTempDir();
        this.started = false;
    }
}

module.exports = {
    BMP_MONITOR_POLICIES,
    DEFAULT_FRR_IMAGE,
    DEFAULT_ROUTES_PER_FAMILY,
    FRR_BMP_ADDRESS_FAMILIES,
    FrrBmpLab,
    MAX_ROUTES_PER_FAMILY,
    PEER_AS,
    PEER_ROUTER_ID,
    ROUTER_AS,
    ROUTER_ID,
    buildRoutePlan,
    peerConfig,
    routeCommandConfig,
    routerConfig
};
