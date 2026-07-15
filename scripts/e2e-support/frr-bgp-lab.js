const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const BgpConst = require('../../electron/const/bgpConst');
const { DEFAULT_FRR_IMAGE } = require('./frr-bmp-lab');

const execFileAsync = promisify(execFile);

const FRR_BGP_LOCAL_AS = 65000;
const FRR_BGP_ROUTER_ID = '192.0.2.200';
const DEFAULT_WAIT_TIMEOUT_MS = Number(process.env.FRR_BGP_WAIT_TIMEOUT_MS || 60000);

const FRR_BGP_ADDRESS_FAMILIES = Object.freeze(
    [
        {
            key: 'ipv4-unicast',
            name: 'IPv4 Unicast',
            addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_UNC,
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
            frrFamily: 'ipv4 unicast',
            pageRoute: '/#/bgp/route-ipv4',
            pageTestId: 'bgp-route-ipv4-page',
            tableTestId: 'bgp-ipv4-route-table',
            fullPacketNlri: 809,
            fullPacketLength: 4096
        },
        {
            key: 'ipv6-unicast',
            name: 'IPv6 Unicast',
            addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV6_UNC,
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV6,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_UNICAST,
            frrFamily: 'ipv6 unicast',
            pageRoute: '/#/bgp/route-ipv6',
            pageTestId: 'bgp-route-ipv6-page',
            tableTestId: 'bgp-ipv6-route-table',
            fullPacketNlri: 236,
            fullPacketLength: 4081
        },
        {
            key: 'ipv4-labeled-unicast',
            name: 'IPv4 Labeled-Unicast',
            addressFamily: BgpConst.BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST,
            afi: BgpConst.BGP_AFI_TYPE.AFI_IPV4,
            safi: BgpConst.BGP_SAFI_TYPE.SAFI_LABEL_UNICAST,
            frrFamily: 'ipv4 labeled-unicast',
            pageRoute: '/#/bgp/route-ipv4',
            pageTestId: 'bgp-route-ipv4-page',
            tableTestId: 'bgp-ipv4-route-table',
            fullPacketNlri: 504,
            fullPacketLength: 4089
        }
    ].map(family => Object.freeze(family))
);

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function dockerLabelArgs(labels = {}) {
    return Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

function normalizeNameSuffix(value) {
    if (value === undefined || value === null || value === '') return '';
    const normalized = String(value)
        .replace(/[^a-zA-Z0-9_.-]/g, '-')
        .slice(0, 48);
    if (!normalized) throw new Error(`Invalid FRR BGP lab name suffix: ${value}`);
    return normalized;
}

function commandFailure(error, args) {
    const command = ['docker', ...args].join(' ');
    const output = `${String(error.stdout || '')}${String(error.stderr || '')}`.trim();
    const wrapped = new Error(`${command} failed${output ? `:\n${output}` : `: ${error.message}`}`);
    wrapped.cause = error;
    return wrapped;
}

async function docker(args, options = {}) {
    try {
        return await execFileAsync('docker', args, {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            timeout: options.timeout || 120000
        });
    } catch (error) {
        if (options.allowFailure) {
            return { stdout: error.stdout || '', stderr: error.stderr || '', error };
        }
        throw commandFailure(error, args);
    }
}

function buildFrrBgpConfig({ family, neighborAddress, neighborPort, localAs = FRR_BGP_LOCAL_AS }) {
    return `frr defaults traditional
hostname netnexus-frr-bgp-peer
!
router bgp ${localAs}
 bgp router-id ${FRR_BGP_ROUTER_ID}
 no bgp default ipv4-unicast
 neighbor ${neighborAddress} remote-as ${localAs}
 neighbor ${neighborAddress} port ${neighborPort}
 neighbor ${neighborAddress} timers 3 9
 neighbor ${neighborAddress} timers connect 1
 !
 address-family ${family.frrFamily}
  neighbor ${neighborAddress} activate
 exit-address-family
!
end
`;
}

class FrrBgpLab {
    constructor(options = {}) {
        this.image = options.image || process.env.FRR_IMAGE || DEFAULT_FRR_IMAGE;
        this.family = options.family;
        this.bgpPort = Number(options.bgpPort);
        this.localAs = Number(options.localAs || FRR_BGP_LOCAL_AS);
        this.nameSuffix = normalizeNameSuffix(options.nameSuffix);
        this.dockerLabels = { ...(options.dockerLabels || {}) };
        this.tempDir = null;
        this.networkName = null;
        this.containerName = null;
        this.containerIp = null;
        this.containerIpv6 = null;
        this.gatewayIp = null;
        this.neighborAddress = null;
        this.netNexusPeerIp = null;
        this.prepared = false;
        this.started = false;

        if (!FRR_BGP_ADDRESS_FAMILIES.includes(this.family)) {
            throw new Error('FrrBgpLab requires a family from FRR_BGP_ADDRESS_FAMILIES');
        }
        if (!Number.isInteger(this.bgpPort) || this.bgpPort < 1 || this.bgpPort > 65535) {
            throw new Error(`Invalid BGP port: ${options.bgpPort}`);
        }
    }

    async ensureDocker() {
        const result = await docker(['info', '--format', '{{.ServerVersion}}'], { allowFailure: true, timeout: 30000 });
        if (result.error) {
            throw new Error(
                `FRR BGP E2E requires a running Docker daemon. ${String(result.stderr || result.error.message).trim()}`
            );
        }
    }

    async ensureImage() {
        const inspect = await docker(['image', 'inspect', this.image], { allowFailure: true, timeout: 30000 });
        if (!inspect.error) return;
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
            const networkName = `netnexus-bgp-${token}-${attempt}`;
            const subnet = `172.29.${subnetOctet}.0/24`;
            const ipv6Base = `fd29:${ipv6Token[0]}:${ipv6Token[1]}`;
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
            if (result.error) continue;

            this.networkName = networkName;
            this.gatewayIp = `172.29.${subnetOctet}.1`;
            this.containerIp = `172.29.${subnetOctet}.2`;
            this.containerIpv6 = `${ipv6Base}::2`;
            return;
        }
        throw new Error('Unable to allocate a non-overlapping Docker network for the FRR BGP E2E lab');
    }

    async resolveDockerHost() {
        if (process.platform === 'linux') {
            this.neighborAddress = this.gatewayIp;
            this.netNexusPeerIp = this.containerIp;
            return;
        }

        const result = await docker([
            'run',
            '--rm',
            '--network',
            this.networkName,
            '--entrypoint',
            'getent',
            this.image,
            'ahostsv4',
            'host.docker.internal'
        ]);
        const address = String(result.stdout || '')
            .split(/\s+/)
            .find(value => /^\d+\.\d+\.\d+\.\d+$/.test(value));
        if (!address) throw new Error('Unable to resolve host.docker.internal from the FRR container network');
        this.neighborAddress = address;
        // Docker Desktop proxies container-to-host connections through loopback.
        this.netNexusPeerIp = '127.0.0.1';
    }

    async prepare() {
        if (this.prepared) return;
        await this.ensureDocker();
        await this.ensureImage();
        await this.createNetwork();
        await this.resolveDockerHost();

        const token = this.nameSuffix || crypto.randomBytes(5).toString('hex');
        this.containerName = `netnexus-frr-bgp-${this.family.key}-${token}`;
        this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-frr-bgp-'));
        this.prepared = true;
    }

    async assertContainerRunning() {
        await delay(350);
        const result = await docker(['inspect', '--format', '{{.State.Running}}', this.containerName], {
            allowFailure: true,
            timeout: 30000
        });
        if (!result.error && result.stdout.trim() === 'true') return;
        const logs = await docker(['logs', this.containerName], { allowFailure: true, timeout: 30000 });
        throw new Error(
            `${this.containerName} exited while starting:\n${String(logs.stdout || '')}${String(logs.stderr || '')}`
        );
    }

    async start() {
        if (this.started) return;
        if (!this.prepared) await this.prepare();

        const configPath = path.join(this.tempDir, 'bgpd.conf');
        fs.writeFileSync(
            configPath,
            buildFrrBgpConfig({
                family: this.family,
                neighborAddress: this.neighborAddress,
                neighborPort: this.bgpPort,
                localAs: this.localAs
            })
        );

        try {
            await docker([
                'create',
                '--name',
                this.containerName,
                '--hostname',
                'netnexus-frr-bgp-peer',
                ...dockerLabelArgs(this.dockerLabels),
                '--network',
                this.networkName,
                '--ip',
                this.containerIp,
                '--ip6',
                this.containerIpv6,
                '--entrypoint',
                '/usr/lib/frr/bgpd',
                this.image,
                '-f',
                '/tmp/netnexus-bgpd.conf',
                '-Z',
                '-S',
                '--v6-with-v4-nexthop',
                '-A',
                '127.0.0.1',
                '--log',
                'stdout',
                '--log-level',
                'info',
                '--limit-fds',
                '10000'
            ]);
            await docker(['cp', configPath, `${this.containerName}:/tmp/netnexus-bgpd.conf`]);
            await docker(['start', this.containerName]);
            await this.assertContainerRunning();
            this.started = true;
        } catch (error) {
            const diagnostics = await this.getDiagnostics().catch(() => '');
            throw new Error(`${error.message}\n${diagnostics}`.trim());
        }
    }

    async runVtysh(command, options = {}) {
        return docker(['exec', this.containerName, 'vtysh', '-c', command], {
            allowFailure: options.allowFailure,
            timeout: options.timeout || 30000
        });
    }

    async readJson(command) {
        const result = await this.runVtysh(`${command} json`);
        try {
            return JSON.parse(String(result.stdout || ''));
        } catch (error) {
            throw new Error(`Unable to parse FRR JSON for "${command}": ${error.message}\n${result.stdout}`);
        }
    }

    async getSummary() {
        return this.readJson(`show bgp ${this.family.frrFamily} summary`);
    }

    async getRoutes() {
        const table = await this.readJson(`show bgp ${this.family.frrFamily} neighbor ${this.neighborAddress} routes`);
        return Object.entries(table.routes || {}).flatMap(([prefix, paths]) =>
            (Array.isArray(paths) ? paths : []).map(route => ({ ...route, prefix }))
        );
    }

    async getRouteDetail(prefix) {
        return this.readJson(`show bgp ${this.family.frrFamily} ${prefix}`);
    }

    async waitForEstablished(timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
        const deadline = Date.now() + timeoutMs;
        let lastSummary = null;
        while (Date.now() < deadline) {
            try {
                lastSummary = await this.getSummary();
                if (Object.values(lastSummary.peers || {}).some(peer => peer.state === 'Established'))
                    return lastSummary;
            } catch (_error) {
                // bgpd may not have opened its vty socket yet.
            }
            await delay(200);
        }
        const diagnostics = await this.getDiagnostics().catch(error => error.message);
        throw new Error(
            `FRR ${this.family.name} peer did not establish:\n${JSON.stringify(lastSummary)}\n${diagnostics}`.trim()
        );
    }

    async waitForRouteCount(expected, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
        const deadline = Date.now() + timeoutMs;
        let routes = [];
        while (Date.now() < deadline) {
            routes = await this.getRoutes().catch(() => []);
            if (routes.length === expected) return routes;
            await delay(200);
        }
        const diagnostics = await this.getDiagnostics().catch(error => error.message);
        throw new Error(
            `FRR ${this.family.name} expected ${expected} routes, received ${routes.length}\n${diagnostics}`.trim()
        );
    }

    async getDiagnostics() {
        const sections = [];
        if (this.containerName) {
            const logs = await docker(['logs', '--tail', '80', this.containerName], {
                allowFailure: true,
                timeout: 30000
            });
            sections.push(`--- FRR logs ---\n${String(logs.stdout || '')}${String(logs.stderr || '')}`);
            const summary = await this.runVtysh(`show bgp ${this.family.frrFamily} summary`, {
                allowFailure: true
            });
            sections.push(
                `--- FRR ${this.family.name} summary ---\n${String(summary.stdout || '')}${String(summary.stderr || '')}`
            );
        }
        return sections.join('\n').trim();
    }

    async cleanup() {
        if (this.containerName) {
            await docker(['rm', '--force', this.containerName], { allowFailure: true, timeout: 30000 });
        }
        if (this.networkName) {
            await docker(['network', 'rm', this.networkName], { allowFailure: true, timeout: 30000 });
        }
        if (this.tempDir) fs.rmSync(this.tempDir, { recursive: true, force: true });
        this.tempDir = null;
        this.prepared = false;
        this.started = false;
    }
}

module.exports = {
    DEFAULT_WAIT_TIMEOUT_MS,
    FRR_BGP_ADDRESS_FAMILIES,
    FRR_BGP_LOCAL_AS,
    FRR_BGP_ROUTER_ID,
    FrrBgpLab,
    buildFrrBgpConfig
};
