const fs = require('fs');
const path = require('path');
const { HuaweiTelnetClient, stripTerminalControl } = require('./huawei-telnet');
const { readManifest, restoreDevice } = require('../huawei-bmp-restore');
const { SCENARIO_DEVICE_PROFILES } = require('./huawei-bmp-scenarios');

const DEFAULT_ARTIFACT_DIRECTORY = '.huawei-bmp-e2e/live-20260721';
const DEFAULT_COLLECTOR_PORT = 11019;
const COMMAND_ERROR_PATTERN =
    /(?:^|\n)\s*(?:\^\s*$|Error:|Failure:|Unrecognized command|Wrong parameter|Incomplete command|Too many parameters|Ambiguous command|The command is not found)/imu;

const HUAWEI_BMP_FAMILIES = Object.freeze([
    Object.freeze({ key: 'ipv4-unicast', name: 'IPv4 Unicast', afi: 1, safi: 1, monitor: 'ipv4' }),
    Object.freeze({ key: 'ipv6-unicast', name: 'IPv6 Unicast', afi: 2, safi: 1, monitor: 'ipv6' }),
    Object.freeze({
        key: 'ipv4-labeled-unicast',
        name: 'IPv4 Labeled-Unicast',
        afi: 1,
        safi: 4,
        monitor: 'ipv4-labeled'
    }),
    Object.freeze({ key: 'vpnv4', name: 'VPNv4', afi: 1, safi: 128, monitor: 'vpnv4', interface: 'GE0/7/2' }),
    Object.freeze({ key: 'vpnv6', name: 'VPNv6', afi: 2, safi: 128, monitor: 'vpnv6', interface: 'GE0/7/2' }),
    Object.freeze({ key: 'l2vpn-evpn', name: 'L2VPN EVPN', afi: 25, safi: 70, monitor: 'evpn' }),
    Object.freeze({ key: 'bgp-ls', name: 'BGP Link-State', afi: 16388, safi: 71, monitor: 'link-state-unicast' })
]);

const DEVICE_PROFILES = Object.freeze([
    Object.freeze({
        index: 0,
        asn: 65001,
        peerAsn: 65002,
        routerId: '198.18.0.1',
        publicPeerIpv4: '11.1.1.2',
        publicPeerIpv6: '11::2',
        loopbackIpv4: '198.18.1.1',
        loopbackIpv6: '2001:db8:101::1',
        privateIpv4: '172.31.12.1',
        privatePeerIpv4: '172.31.12.2',
        privateIpv6: '2001:db8:12::1',
        privatePeerIpv6: '2001:db8:12::2',
        routeIpv4: '198.18.101.0',
        routeIpv6: '2001:db8:1101::',
        med: 101,
        localPreference: 201,
        community: '65001:101'
    }),
    Object.freeze({
        index: 1,
        asn: 65002,
        peerAsn: 65001,
        routerId: '198.18.0.2',
        publicPeerIpv4: '11.1.1.1',
        publicPeerIpv6: '11::1',
        loopbackIpv4: '198.18.2.2',
        loopbackIpv6: '2001:db8:102::2',
        privateIpv4: '172.31.12.2',
        privatePeerIpv4: '172.31.12.1',
        privateIpv6: '2001:db8:12::2',
        privatePeerIpv6: '2001:db8:12::1',
        routeIpv4: '198.18.102.0',
        routeIpv6: '2001:db8:1102::',
        med: 102,
        localPreference: 202,
        community: '65002:102'
    })
]);

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseTargets(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function assertValidPort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid BMP collector port: ${value}`);
    }
    return port;
}

function commandFailed(output) {
    COMMAND_ERROR_PATTERN.lastIndex = 0;
    return COMMAND_ERROR_PATTERN.test(stripTerminalControl(output));
}

function peerLineEstablished(output, address) {
    return String(output || '')
        .split(/\r?\n/u)
        .some(line => line.includes(address) && /\bEstablished\b/u.test(line));
}

function publicBgpConfiguration(profile) {
    const policy = `NETNEXUS_E2E_EXPORT_${profile.index + 1}`;
    return [
        'system-view',
        'interface LoopBack100',
        'description NETNEXUS_E2E_PUBLIC',
        `ip address ${profile.loopbackIpv4} 255.255.255.255`,
        'ipv6 enable',
        `ipv6 address ${profile.loopbackIpv6}/128`,
        'quit',
        `ip route-static ${profile.routeIpv4} 255.255.255.0 NULL0`,
        `ipv6 route-static ${profile.routeIpv6} 64 NULL0`,
        `route-policy ${policy} permit node 10`,
        `apply cost ${profile.med}`,
        `apply local-preference ${profile.localPreference}`,
        `apply community ${profile.community} additive`,
        'quit',
        `bgp ${profile.asn}`,
        `router-id ${profile.routerId}`,
        'timer connect-retry 5',
        `peer ${profile.publicPeerIpv4} as-number ${profile.peerAsn}`,
        `peer ${profile.publicPeerIpv6} as-number ${profile.peerAsn}`,
        'ipv4-family unicast',
        `network ${profile.routeIpv4} 255.255.255.0 route-policy ${policy}`,
        `peer ${profile.publicPeerIpv4} enable`,
        'quit',
        'ipv6-family unicast',
        `network ${profile.routeIpv6} 64 route-policy ${policy}`,
        `peer ${profile.publicPeerIpv6} enable`,
        'quit',
        'quit'
    ];
}

function bmpConfiguration(host, collectorHost, collectorPort) {
    const publicFamilies = [
        'ipv4-family unicast',
        'ipv6-family unicast',
        'ipv4-family labeled-unicast',
        'ipv4-family vpnv4',
        'ipv6-family vpnv6',
        'l2vpn-family evpn',
        'link-state-family unicast'
    ];
    const publicRouteModes = publicFamilies.flatMap(family => [
        `route-mode ${family} adj-rib-in pre-policy`,
        `route-mode ${family} adj-rib-in post-policy`,
        `route-mode ${family} adj-rib-out pre-policy`,
        `route-mode ${family} adj-rib-out post-policy`,
        `route-mode ${family} local-rib all`
    ]);
    return [
        'system-view',
        'bmp',
        'statistics-timer 15',
        `bmp-session ${collectorHost}`,
        'bmp-version 4',
        `connect-interface ${host}`,
        `tcp connect port ${collectorPort}`,
        'monitor public',
        ...publicRouteModes,
        'quit',
        'quit',
        'quit'
    ];
}

class HuaweiBmpLab {
    constructor(options = {}) {
        this.targets = options.targets || [];
        this.username = options.username;
        this.password = options.password;
        this.localAddress = options.localAddress;
        this.collectorHost = options.collectorHost;
        this.collectorPort = assertValidPort(options.collectorPort || DEFAULT_COLLECTOR_PORT);
        this.artifactDirectory = path.resolve(options.artifactDirectory || DEFAULT_ARTIFACT_DIRECTORY);
        this.transcriptPath = path.join(this.artifactDirectory, 'huawei-lab-transcript.jsonl');
        this.clients = [];
        this.committed = false;
        this.trialCommittedIndexes = new Set();
        this.closed = false;
        this.activeScenario = null;

        if (this.targets.length !== 2 || !this.username || !this.password || !this.collectorHost) {
            throw new Error('HuaweiBmpLab requires exactly two targets, credentials, and a collector host');
        }
        const manifest = readManifest(this.artifactDirectory);
        const baselineHosts = manifest.devices.map(device => device.host);
        if (baselineHosts.some((host, index) => host !== this.targets[index])) {
            throw new Error(`Huawei target order does not match the baseline: ${baselineHosts.join(', ')}`);
        }
        this.baseline = manifest;
        fs.mkdirSync(this.artifactDirectory, { recursive: true });
    }

    static fromEnvironment(overrides = {}) {
        return new HuaweiBmpLab({
            targets: parseTargets(process.env.NETNEXUS_HUAWEI_TARGETS),
            username: process.env.NETNEXUS_HUAWEI_USERNAME,
            password: process.env.NETNEXUS_HUAWEI_PASSWORD,
            localAddress: process.env.NETNEXUS_HUAWEI_LOCAL_ADDRESS || undefined,
            collectorHost: process.env.NETNEXUS_BMP_COLLECTOR_HOST,
            collectorPort: process.env.NETNEXUS_BMP_COLLECTOR_PORT || DEFAULT_COLLECTOR_PORT,
            artifactDirectory: process.env.NETNEXUS_HUAWEI_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIRECTORY,
            ...overrides
        });
    }

    record(entry) {
        fs.appendFileSync(this.transcriptPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
            encoding: 'utf8',
            mode: 0o600
        });
    }

    async connect() {
        if (this.clients.length) return;
        for (let index = 0; index < this.targets.length; index += 1) {
            const client = new HuaweiTelnetClient({
                host: this.targets[index],
                username: this.username,
                password: this.password,
                localAddress: this.localAddress,
                timeoutMs: 30000
            });
            await client.connect();
            this.clients.push(client);
            this.record({ host: this.targets[index], event: 'connected' });
        }
    }

    async runCommand(index, command, options = {}) {
        const client = this.clients[index];
        if (!client) throw new Error(`Huawei device ${index + 1} is not connected`);
        const output = await client.interactiveCommand(command, {
            confirmations: [
                {
                    pattern: /Continue\?\s*\[Y\/N\]:\s*$/iu,
                    response: 'y'
                }
            ],
            timeoutMs: options.timeoutMs || 60000
        });
        this.record({ host: this.targets[index], command, output });
        if (!options.allowError && commandFailed(output)) {
            throw new Error(`${this.targets[index]} rejected "${command}": ${output}`);
        }
        return output;
    }

    async runCommands(index, commands) {
        const outputs = [];
        for (const command of commands) {
            outputs.push(await this.runCommand(index, command));
        }
        return outputs;
    }

    async applyPublicConfiguration({ trialSeconds = 600 } = {}) {
        await this.connect();
        for (let index = 0; index < this.targets.length; index += 1) {
            await this.runCommands(index, publicBgpConfiguration(DEVICE_PROFILES[index]));
        }
        for (let index = 0; index < this.targets.length; index += 1) {
            await this.runCommand(index, 'commit', { timeoutMs: 180000 });
            await this.runCommand(index, 'return');
        }
        await this.waitForPublicPeers({ timeoutMs: 90000 });
        for (let index = 0; index < this.targets.length; index += 1) {
            await this.runCommands(
                index,
                bmpConfiguration(this.targets[index], this.collectorHost, this.collectorPort)
            );
        }
        for (let index = 0; index < this.targets.length; index += 1) {
            await this.runCommand(index, `commit trial ${trialSeconds}`, { timeoutMs: 180000 });
            this.trialCommittedIndexes.add(index);
            await this.runCommand(index, 'return');
        }
        this.committed = true;
    }

    async applyScenario(scenario, { trialSeconds = 900 } = {}) {
        if (!scenario || typeof scenario.buildCommands !== 'function') {
            throw new Error('Huawei BMP scenario must provide buildCommands');
        }
        await this.connect();
        for (let index = 0; index < this.targets.length; index += 1) {
            const commands = scenario.buildCommands(SCENARIO_DEVICE_PROFILES[index], {
                host: this.targets[index],
                collectorHost: this.collectorHost,
                collectorPort: this.collectorPort
            });
            await this.runCommands(index, commands);
        }
        for (let index = 0; index < this.targets.length; index += 1) {
            await this.runCommand(index, `commit trial ${trialSeconds}`, { timeoutMs: 180000 });
            this.trialCommittedIndexes.add(index);
            await this.runCommand(index, 'return');
        }
        this.committed = true;
        this.activeScenario = scenario.key;
    }

    async applyTrialMutation(index, commands, { trialSeconds = 900 } = {}) {
        if (!this.clients[index]) throw new Error(`Huawei device ${index + 1} is not connected`);
        try {
            await this.runCommands(index, commands);
            await this.runCommand(index, `commit trial ${trialSeconds}`, { timeoutMs: 180000 });
            this.trialCommittedIndexes.add(index);
            await this.runCommand(index, 'return');
        } catch (error) {
            await this.runCommand(index, 'return', { allowError: true }).catch(() => {});
            throw error;
        }
    }

    async collectScenarioDeviceState() {
        const commands = [
            'display bmp session',
            'display bgp bmp-monitor all',
            'display bgp peer',
            'display bgp routing-table',
            'display bgp ipv6 peer',
            'display bgp labeled peer',
            'display bgp vpnv4 all peer',
            'display bgp vpnv6 all peer',
            'display bgp evpn peer',
            'display bgp evpn all routing-table',
            'display bgp link-state peer',
            'display interface GigabitEthernet0/7/2'
        ];
        const results = [];
        for (let index = 0; index < this.targets.length; index += 1) {
            const state = { host: this.targets[index], commands: {} };
            for (const command of commands) {
                state.commands[command] = await this.runCommand(index, command, {
                    allowError: true,
                    timeoutMs: 120000
                });
            }
            results.push(state);
        }
        return results;
    }

    async collectPublicState() {
        const results = [];
        for (let index = 0; index < this.targets.length; index += 1) {
            const commands = [
                'display bgp peer',
                'display bgp ipv6 peer',
                'display bgp routing-table',
                'display bgp ipv6 routing-table',
                'display bgp bmp-monitor all',
                'display bmp session',
                'display current-configuration | section include bmp'
            ];
            const state = { host: this.targets[index], commands: {} };
            for (const command of commands) {
                state.commands[command] = await this.runCommand(index, command, {
                    allowError: true,
                    timeoutMs: 120000
                });
            }
            results.push(state);
        }
        fs.writeFileSync(
            path.join(this.artifactDirectory, 'public-state.json'),
            `${JSON.stringify(results, null, 2)}\n`,
            {
                encoding: 'utf8',
                mode: 0o600
            }
        );
        return results;
    }

    async resetPublicPeers() {
        for (let index = 0; index < this.targets.length; index += 1) {
            const profile = DEVICE_PROFILES[index];
            await this.runCommand(index, `reset bgp ${profile.publicPeerIpv4}`, { timeoutMs: 60000 });
            await this.runCommand(index, `reset bgp ipv6 ${profile.publicPeerIpv6}`, { timeoutMs: 60000 });
        }
        return this.waitForPublicPeers({ timeoutMs: 90000 });
    }

    async waitForPublicPeers({ timeoutMs = 90000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        let lastState = null;
        while (Date.now() < deadline) {
            lastState = await Promise.all(
                this.clients.map(async (client, index) => ({
                    host: this.targets[index],
                    ipv4: await client.command('display bgp peer', { timeoutMs: 30000 }),
                    ipv6: await client.command('display bgp ipv6 peer', { timeoutMs: 30000 })
                }))
            );
            const established = lastState.every((state, index) => {
                const profile = DEVICE_PROFILES[index];
                return (
                    peerLineEstablished(state.ipv4, profile.publicPeerIpv4) &&
                    peerLineEstablished(state.ipv6, profile.publicPeerIpv6)
                );
            });
            if (established) return lastState;
            await delay(2000);
        }
        throw new Error(`Huawei public BGP peers did not establish: ${JSON.stringify(lastState)}`);
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        const clients = this.clients.splice(0);
        await Promise.allSettled(clients.map(client => client.close()));
    }

    async abortTrial() {
        if (this.trialCommittedIndexes.size === 0 || this.clients.length !== this.targets.length) return [];
        const results = [];
        for (const index of [...this.trialCommittedIndexes]) {
            await this.runCommand(index, 'return', { allowError: true });
            await this.runCommand(index, 'system-view');
            const output = await this.runCommand(index, 'abort trial', { timeoutMs: 180000 });
            await this.runCommand(index, 'return');
            results.push({ host: this.targets[index], output });
            this.trialCommittedIndexes.delete(index);
        }
        this.committed = false;
        return results;
    }

    async restore() {
        let abortResults = [];
        let abortError = null;
        try {
            abortResults = await this.abortTrial();
        } catch (error) {
            abortError = error;
        } finally {
            await this.close();
        }
        const results = [];
        for (const device of this.baseline.devices) {
            try {
                results.push(
                    await restoreDevice(
                        device,
                        { username: this.username, password: this.password, localAddress: this.localAddress },
                        { verifyOnly: false }
                    )
                );
            } catch (error) {
                results.push({ host: device.host, commitId: device.commitId, verified: false, error: error.message });
            }
        }
        if (results.some(result => !result.verified)) {
            throw new Error(
                `Huawei baseline restore verification failed: ${JSON.stringify({ abortError: abortError?.message, results })}`
            );
        }
        results.forEach(result => {
            result.trialAbort = abortResults.find(item => item.host === result.host) || null;
            result.abortError = abortError?.message || null;
        });
        return results;
    }
}

module.exports = {
    DEFAULT_COLLECTOR_PORT,
    DEVICE_PROFILES,
    HUAWEI_BMP_FAMILIES,
    HuaweiBmpLab,
    commandFailed,
    peerLineEstablished,
    bmpConfiguration,
    publicBgpConfiguration
};
