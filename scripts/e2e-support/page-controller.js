const path = require('path');
const { spawn } = require('child_process');
const bgp = require('./bgp');
const dhcp = require('./dhcp');
const ftp = require('./ftp');
const grpc = require('./grpc');
const native = require('./native');
const ntp = require('./ntp');
const radius = require('./radius');
const rpki = require('./rpki');
const snmp = require('./snmp');
const syslog = require('./syslog');
const tftp = require('./tftp');
const tools = require('./tools');
const yang = require('./yang');
const { errorResponse, getFreeTcpPort, getFreeUdpPort, successResponse, timestamp } = require('./common');

const projectRoot = path.join(__dirname, '..', '..');

const featureHandlers = {
    bgp,
    dhcp,
    ftp,
    grpc,
    native,
    ntp,
    radius,
    rpki,
    snmp,
    syslog,
    tftp,
    tools,
    yang
};

class FeaturePageE2eController {
    constructor() {
        const now = timestamp();
        this.timeline = [];
        this.eventListeners = new Set();
        this.ftpPort = null;
        this.tftpPort = null;
        this.ftpServer = null;
        this.tftpServer = null;
        this.ftpClientEvents = [];
        this.tftpClientEvents = [];
        this.protocolRoot = '/tmp/netnexus-e2e';
        this.state = {
            bgp: bgp.createBgpPageState(),
            dhcp: dhcp.createDhcpPageState(now),
            ftp: ftp.createFtpPageState(this.protocolRoot),
            grpc: grpc.createGrpcPageState(now),
            ntp: ntp.createNtpPageState(now),
            radius: radius.createRadiusPageState(now, this.protocolRoot),
            rpki: rpki.createRpkiPageState(),
            snmp: snmp.createSnmpPageState(),
            syslog: syslog.createSyslogPageState(now),
            tftp: tftp.createTftpPageState(),
            tools: tools.createToolsPageState(),
            yang: yang.createYangPageState()
        };
    }

    async init() {
        this.ftpPort = await getFreeTcpPort();
        this.tftpPort = await getFreeUdpPort();
        this.state.ftp.config.port = this.ftpPort;
        this.state.tftp.config.port = this.tftpPort;
        this.record('allocated protocol ports', { ftpPort: this.ftpPort, tftpPort: this.tftpPort });
    }

    onEvent(listener) {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    record(message, data = null) {
        const item = { at: new Date().toISOString(), message };
        if (data !== null && data !== undefined) item.data = data;
        this.timeline.push(item);
    }

    emitEvent(type, data) {
        this.record('renderer event emitted', { type, data });
        this.eventListeners.forEach(listener => listener({ type, data }));
    }

    async call(method, ...args) {
        this.record('renderer API call: ' + method);
        try {
            if (method === 'common.selectDirectory') return successResponse({ filePaths: [this.protocolRoot] });
            const featureName = method.split('.')[0];
            const feature = featureHandlers[featureName];
            if (!feature) return errorResponse('Unsupported feature page E2E method: ' + method);
            return await feature.handlePageCall(this, method, args);
        } catch (error) {
            return errorResponse(error.message);
        }
    }

    async runFtpClient() {
        return ftp.runClient(this);
    }

    async runTftpClient() {
        return tftp.runClient(this);
    }

    async runScript(scriptRelativePath, args, eventSink) {
        const output = [];
        const child = spawn(process.execPath, [path.join(projectRoot, scriptRelativePath), ...args], {
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const handleOutput = chunk => {
            chunk
                .toString('utf8')
                .split(/\r?\n/u)
                .filter(Boolean)
                .forEach(line => {
                    output.push(line);
                    try {
                        eventSink.push(JSON.parse(line));
                    } catch (_error) {
                        eventSink.push({ event: 'raw-output', line });
                    }
                });
        };
        child.stdout.on('data', handleOutput);
        child.stderr.on('data', handleOutput);

        const code = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', resolve);
        });
        if (code !== 0) {
            throw new Error(scriptRelativePath + ' exited with code ' + code + ':\n' + output.join('\n'));
        }
        return eventSink;
    }

    async cleanup() {
        await ftp.cleanup(this);
        await tftp.cleanup(this);
    }
}

module.exports = {
    FeaturePageE2eController
};
