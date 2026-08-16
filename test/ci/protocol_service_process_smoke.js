const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const BgpConst = require('../../electron/const/bgpConst');
const BmpConst = require('../../electron/const/bmpConst');
const DhcpConst = require('../../electron/const/dhcpConst');
const Dhcp6Const = require('../../electron/const/dhcp6Const');
const FtpConst = require('../../electron/const/ftpConst');
const NtpConst = require('../../electron/const/ntpConst');
const RadiusConst = require('../../electron/const/radiusConst');
const RpkiConst = require('../../electron/const/rpkiConst');
const SnmpConst = require('../../electron/const/snmpConst');
const SyslogConst = require('../../electron/const/syslogConst');
const TftpConst = require('../../electron/const/tftpConst');
const { NETCONF_REQ_TYPES } = require('../../electron/const/yangConst');
const ProtocolProcessWithPromise = require('../../electron/worker/core/protocolProcessWithPromise');
const RequestProcessClient = require('../../electron/worker/core/requestProcessClient');
const { YANG_PROCESS_REQ_TYPES } = require('../../electron/worker/yang/yangProcessProtocol');
const {
    PROTOCOL_PROCESS_SERVICES,
    PROTOCOL_PROCESS_TIMEOUTS
} = require('../../electron/worker/core/protocolProcessServices');

const projectRoot = path.join(__dirname, '..', '..');

function workerPath(relativePath) {
    return path.join(projectRoot, 'electron', 'worker', relativePath);
}

function getFreeTcpPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(error => (error ? reject(error) : resolve(port)));
        });
    });
}

function getFreeUdpPort(type = 'udp4', address = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket(type);
        socket.once('error', reject);
        socket.bind(0, address, () => {
            const port = socket.address().port;
            socket.close(() => resolve(port));
        });
    });
}

function bindUdpSocket(type, address) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket(type);
        socket.once('error', reject);
        socket.bind(0, address, () => resolve(socket));
    });
}

function closeUdpSocket(socket) {
    return new Promise((resolve, reject) => socket.close(error => (error ? reject(error) : resolve())));
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForProcessMetric(pid, present, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    do {
        const metric = app.getAppMetrics().find(item => item.pid === pid);
        if (Boolean(metric) === present) return metric || null;
        await delay(25);
    } while (Date.now() < deadline);

    const state = present ? 'appear in' : 'leave';
    throw new Error(`Timed out waiting for protocol PID ${pid} to ${state} app.getAppMetrics()`);
}

async function waitForProcessPid(host, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    do {
        if (Number.isInteger(host.pid) && host.pid > 0) return host.pid;
        if (!host.runtime) throw new Error(`${host.serviceName} exited before exposing its PID`);
        await delay(10);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${host.serviceName} to expose its PID`);
}

async function assertUtilityProcess(host, serviceName) {
    assert(host, `${serviceName} process host must exist`);
    assert.equal(host.runtimeKind, 'utility-process', `${serviceName} must use Electron utilityProcess in CI`);
    const pid = await waitForProcessPid(host);
    assert.notEqual(pid, process.pid, `${serviceName} PID must differ from the Electron main PID`);

    const metric = await waitForProcessMetric(pid, true);
    assert.equal(metric.type, 'Utility', `${serviceName} must be reported as an Electron Utility process`);
    assert(
        metric.name === serviceName || metric.serviceName === serviceName,
        `${serviceName} must be identifiable in app.getAppMetrics()`
    );
    return pid;
}

async function runMessageHandlerService(spec, tempDir) {
    const client = new ProtocolProcessWithPromise(workerPath(spec.worker), {
        serviceName: spec.serviceName
    }).createLongRunningProcess();
    const host = client.process;
    const pid = await assertUtilityProcess(host, spec.serviceName);
    let started = false;

    try {
        const config = await spec.createConfig(tempDir);
        const startResult = await client.sendRequest(spec.startOp, config);
        assert.equal(startResult.status, 'success');
        started = true;
        await spec.verify?.(client, startResult);

        const stopResult = await client.sendRequest(spec.stopOp, null, {
            timeoutMs: spec.stopTimeoutMs || PROTOCOL_PROCESS_TIMEOUTS.STOP
        });
        assert.equal(stopResult.status, 'success');
        started = false;
    } finally {
        if (started) {
            await client
                .sendRequest(spec.stopOp, null, {
                    timeoutMs: spec.stopTimeoutMs || PROTOCOL_PROCESS_TIMEOUTS.STOP
                })
                .catch(() => {});
        }
        await client.terminate();
        assert.equal(host.runtime, null, `${spec.serviceName} host must observe process exit`);
        await waitForProcessMetric(pid, false);
    }

    console.log(`utility process smoke passed: ${spec.serviceName}, pid=${pid}`);
}

async function runDhcpService() {
    const serviceName = PROTOCOL_PROCESS_SERVICES.DHCP;
    const client = new ProtocolProcessWithPromise(workerPath('dhcp/dhcpProcess.js'), {
        serviceName
    }).createLongRunningProcess();
    const host = client.process;
    const pid = await assertUtilityProcess(host, serviceName);
    let v4Started = false;
    let v6Started = false;
    let occupiedV6Socket = null;

    try {
        const v4Config = {
            ...DhcpConst.DEFAULT_DHCP_CONFIG,
            serverPort: await getFreeUdpPort(),
            serverIp: '192.0.2.1',
            poolStart: '192.0.2.100',
            poolEnd: '192.0.2.110',
            gateway: '192.0.2.1'
        };
        const v6Config = {
            ...Dhcp6Const.DEFAULT_DHCP6_CONFIG,
            serverPort: await getFreeUdpPort('udp6', '::1'),
            poolStart: '2001:db8::100',
            poolEnd: '2001:db8::110'
        };

        const v4StartResult = await client.sendRequest(DhcpConst.DHCP_REQ_TYPES.START_DHCP, v4Config);
        assert.equal(v4StartResult.status, 'success');
        v4Started = true;

        occupiedV6Socket = await bindUdpSocket('udp6', '::');
        const occupiedV6Config = {
            ...v6Config,
            serverPort: occupiedV6Socket.address().port
        };
        await assert.rejects(
            client.sendRequest(Dhcp6Const.DHCP6_REQ_TYPES.START_DHCP6, occupiedV6Config),
            error =>
                error.code === 'WORKER_REQUEST_FAILED' &&
                (process.platform === 'win32'
                    ? /EACCES|EADDRINUSE/.test(error.message)
                    : /EADDRINUSE/.test(error.message))
        );
        const v4LeasesAfterV6Failure = await client.sendRequest(DhcpConst.DHCP_REQ_TYPES.GET_LEASE_LIST);
        assert.deepEqual(v4LeasesAfterV6Failure.data, []);
        assert.equal(client.pid, pid, 'a DHCPv6 bind failure must keep DHCPv4 in the shared process alive');
        await closeUdpSocket(occupiedV6Socket);
        occupiedV6Socket = null;

        const v6StartResult = await client.sendRequest(Dhcp6Const.DHCP6_REQ_TYPES.START_DHCP6, v6Config);
        assert.equal(v6StartResult.status, 'success');
        v6Started = true;

        const [v4Leases, v6Leases] = await Promise.all([
            client.sendRequest(DhcpConst.DHCP_REQ_TYPES.GET_LEASE_LIST),
            client.sendRequest(Dhcp6Const.DHCP6_REQ_TYPES.GET_LEASE_LIST)
        ]);
        assert.deepEqual(v4Leases.data, []);
        assert.deepEqual(v6Leases.data, []);
        assert.equal(client.pid, pid, 'DHCPv4 and DHCPv6 must share one protocol process');
    } finally {
        if (occupiedV6Socket) {
            await closeUdpSocket(occupiedV6Socket).catch(() => {});
        }
        if (v6Started) {
            await client
                .sendRequest(Dhcp6Const.DHCP6_REQ_TYPES.STOP_DHCP6, null, {
                    timeoutMs: PROTOCOL_PROCESS_TIMEOUTS.STOP
                })
                .catch(() => {});
        }
        if (v4Started) {
            await client
                .sendRequest(DhcpConst.DHCP_REQ_TYPES.STOP_DHCP, null, {
                    timeoutMs: PROTOCOL_PROCESS_TIMEOUTS.STOP
                })
                .catch(() => {});
        }
        await client.terminate();
        assert.equal(host.runtime, null, `${serviceName} host must observe process exit`);
        await waitForProcessMetric(pid, false);
    }

    console.log(`utility process smoke passed: ${serviceName}, pid=${pid}`);
}

async function runYangService(tempDir) {
    const client = new RequestProcessClient(workerPath('yang/yangProcess.js'), {
        serviceName: PROTOCOL_PROCESS_SERVICES.YANG,
        defaultTimeoutMs: 5000
    }).start();
    const host = client.process;
    const pid = await assertUtilityProcess(host, PROTOCOL_PROCESS_SERVICES.YANG);

    try {
        const configured = await client.sendRequest(
            YANG_PROCESS_REQ_TYPES.CONFIGURE,
            { rootDir: path.join(tempDir, 'yang'), isPackaged: false },
            { timeoutMs: 5000 }
        );
        assert.equal(configured.status, 'success');

        const state = await client.sendRequest(
            NETCONF_REQ_TYPES.GET_SESSION_STATE,
            { profileId: 'ci-netconf-process-smoke' },
            { timeoutMs: 5000 }
        );
        assert.equal(state.status, 'success');
        assert.equal(state.data.profileId, 'ci-netconf-process-smoke');
        assert.equal(state.data.status, 'disconnected');
        assert.equal(state.data.connected, false);

        const models = await client.sendRequest('yang:listModules', { profileId: 'ci-netconf-process-smoke' });
        assert.equal(models.status, 'success');
        assert.equal(models.data.status, 'success');
        assert.deepEqual(models.data.data, []);

        const stopped = await client.sendRequest(YANG_PROCESS_REQ_TYPES.CLOSE, null, { timeoutMs: 5000 });
        assert.equal(stopped.status, 'success');
        assert.deepEqual(stopped.data, { closed: true });
    } finally {
        await client.terminate();
        assert.equal(host.runtime, null, 'YANG host must observe process exit');
        await waitForProcessMetric(pid, false);
    }

    console.log(`utility process smoke passed: ${PROTOCOL_PROCESS_SERVICES.YANG}, pid=${pid}`);
}

function createServiceSpecs() {
    return [
        {
            serviceName: PROTOCOL_PROCESS_SERVICES.BGP,
            worker: 'bgp/bgpWorker.js',
            startOp: BgpConst.BGP_REQ_TYPES.START_BGP,
            stopOp: BgpConst.BGP_REQ_TYPES.STOP_BGP,
            createConfig: async tempDir => ({
                port: await getFreeTcpPort(),
                addressFamily: [BgpConst.BGP_ADDR_FAMILY.IPV4_UNC],
                routeDatabasePath: path.join(tempDir, 'bgp.sqlite3')
            })
        },
        {
            serviceName: PROTOCOL_PROCESS_SERVICES.BMP,
            worker: 'bmp/bmpWorker.js',
            startOp: BmpConst.BMP_REQ_TYPES.START_BMP,
            stopOp: BmpConst.BMP_REQ_TYPES.STOP_BMP,
            stopTimeoutMs: PROTOCOL_PROCESS_TIMEOUTS.BMP_STOP,
            createConfig: async tempDir => ({
                port: await getFreeTcpPort(),
                bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_20,
                pathMarkingTlvType: BmpConst.BMP_ROUTE_MONITORING_TLV_TYPE.PATH_MARKING,
                persistenceEnabled: true,
                persistenceDbPath: path.join(tempDir, 'bmp.sqlite3'),
                persistenceBatchSize: 64,
                persistenceFlushMs: 5,
                persistenceHighWatermarkBytes: 4 * 1024 * 1024,
                persistenceLowWatermarkBytes: 2 * 1024 * 1024
            })
        },
        {
            serviceName: PROTOCOL_PROCESS_SERVICES.RPKI,
            worker: 'rpki/rpkiWorker.js',
            startOp: RpkiConst.RPKI_REQ_TYPES.START_RPKI,
            stopOp: RpkiConst.RPKI_REQ_TYPES.STOP_RPKI,
            createConfig: async tempDir => ({
                port: await getFreeTcpPort(),
                rpkiDatabasePath: path.join(tempDir, 'rpki.sqlite3'),
                initialRouterKeys: [],
                maxProtocolVersion: RpkiConst.RPKI_MAX_SUPPORTED_VERSION
            })
        },
        {
            serviceName: PROTOCOL_PROCESS_SERVICES.FTP,
            worker: 'transfer/ftpWorker.js',
            startOp: FtpConst.FTP_REQ_TYPES.START_FTP,
            stopOp: FtpConst.FTP_REQ_TYPES.STOP_FTP,
            createConfig: async tempDir => ({
                ftpConfig: {
                    port: await getFreeTcpPort(),
                    rootDir: tempDir
                },
                userConfig: []
            })
        },
        {
            serviceName: PROTOCOL_PROCESS_SERVICES.SNMP,
            worker: 'snmp/snmpWorker.js',
            startOp: SnmpConst.SNMP_REQ_TYPES.START_SNMP,
            stopOp: SnmpConst.SNMP_REQ_TYPES.STOP_SNMP,
            createConfig: async () => ({
                port: await getFreeUdpPort(),
                supportedVersions: ['v2c'],
                community: 'public',
                mibFiles: [],
                mibCacheFilePath: '',
                maxTrapHistory: 10
            })
        },
        {
            serviceName: PROTOCOL_PROCESS_SERVICES.NTP,
            worker: 'services/ntpWorker.js',
            startOp: NtpConst.NTP_REQ_TYPES.START_NTP,
            stopOp: NtpConst.NTP_REQ_TYPES.STOP_NTP,
            createConfig: async () => ({
                ...NtpConst.DEFAULT_NTP_CONFIG,
                port: await getFreeUdpPort()
            })
        },
        {
            serviceName: PROTOCOL_PROCESS_SERVICES.RADIUS,
            worker: 'services/radiusWorker.js',
            startOp: RadiusConst.RADIUS_REQ_TYPES.START_RADIUS,
            stopOp: RadiusConst.RADIUS_REQ_TYPES.STOP_RADIUS,
            createConfig: async () => ({
                ...RadiusConst.DEFAULT_RADIUS_CONFIG,
                bindAddress: '127.0.0.1',
                authPort: await getFreeUdpPort(),
                enableAccounting: false,
                enableDynamicAuth: false,
                enableIpv6: false
            }),
            verify: async (_client, result) => {
                assert(result.data.authPort > 0, 'RADIUS must bind a real UDP port');
            }
        },
        {
            serviceName: PROTOCOL_PROCESS_SERVICES.TFTP,
            worker: 'transfer/tftpWorker.js',
            startOp: TftpConst.TFTP_REQ_TYPES.START_TFTP,
            stopOp: TftpConst.TFTP_REQ_TYPES.STOP_TFTP,
            createConfig: async tempDir => ({
                ...TftpConst.DEFAULT_TFTP_CONFIG,
                port: await getFreeUdpPort(),
                rootDir: tempDir
            })
        },
        {
            serviceName: PROTOCOL_PROCESS_SERVICES.SYSLOG,
            worker: 'services/syslogWorker.js',
            startOp: SyslogConst.SYSLOG_REQ_TYPES.START_SYSLOG,
            stopOp: SyslogConst.SYSLOG_REQ_TYPES.STOP_SYSLOG,
            createConfig: async () => ({
                ...SyslogConst.DEFAULT_SYSLOG_CONFIG,
                port: await getFreeUdpPort(),
                enableUdp: true,
                enableTcp: false
            })
        }
    ];
}

async function main() {
    assert.equal(
        process.env.NETNEXUS_EXPECT_UTILITY_PROCESS,
        '1',
        'protocol service smoke must run through the real Electron utility-process runner'
    );
    assert.equal(typeof app?.getAppMetrics, 'function', 'Electron app.getAppMetrics must be available');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-protocol-process-smoke-'));
    const testedServices = [];
    try {
        await runDhcpService();
        testedServices.push(PROTOCOL_PROCESS_SERVICES.DHCP);
        for (const spec of createServiceSpecs()) {
            await runMessageHandlerService(spec, tempDir);
            testedServices.push(spec.serviceName);
        }
        await runYangService(tempDir);
        testedServices.push(PROTOCOL_PROCESS_SERVICES.YANG);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    assert.deepEqual(new Set(testedServices), new Set(Object.values(PROTOCOL_PROCESS_SERVICES)));
    console.log(`All ${testedServices.length} protocol services passed real utility-process smoke tests`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = main;
