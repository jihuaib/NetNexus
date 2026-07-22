const fs = require('fs');
const path = require('path');
const BmpConst = require('../electron/const/bmpConst');
const { BmpE2eController } = require('./e2e-support/bmp');
const { HuaweiBmpLab } = require('./e2e-support/huawei-bmp-lab');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForClients(controller, expected, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let lastResult = null;
    while (Date.now() < deadline) {
        lastResult = await controller.call('getClientList');
        const online = Array.isArray(lastResult?.data)
            ? lastResult.data.filter(client => client?.isOnline === true)
            : [];
        if (online.length >= expected) return online;
        await delay(1000);
    }
    throw new Error(`Expected ${expected} online BMP clients: ${JSON.stringify(lastResult)}`);
}

async function waitForInstances(controller, clients, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let lastResults = null;
    while (Date.now() < deadline) {
        lastResults = await Promise.all(clients.map(client => controller.call('getBgpInstances', client)));
        if (lastResults.every(result => result.status === 'success' && result.data?.length > 0)) return lastResults;
        await delay(1000);
    }
    throw new Error(`Expected BMP BGP instances from both devices: ${JSON.stringify(lastResults)}`);
}

async function main() {
    const controller = new BmpE2eController();
    const collectorPort = Number(process.env.NETNEXUS_BMP_COLLECTOR_PORT || 11019);
    const lab = HuaweiBmpLab.fromEnvironment({ collectorPort });
    const reportPath = path.join(lab.artifactDirectory, 'live-smoke-report.json');
    let primaryError = null;
    let restoreResults = null;
    const report = {
        startedAt: new Date().toISOString(),
        collector: {
            host: lab.collectorHost,
            port: collectorPort,
            listenHost: '0.0.0.0',
            bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19
        }
    };

    try {
        const startResult = await controller.call('startBmp', {
            port: collectorPort,
            listenHost: '0.0.0.0',
            bmpV4TlvDraft: BmpConst.BMP_V4_TLV_DRAFT.DRAFT_19,
            logLevel: 'off'
        });
        if (startResult.status !== 'success') {
            throw new Error(`Unable to start BMP collector: ${JSON.stringify(startResult)}`);
        }

        await lab.applyPublicConfiguration({ trialSeconds: 600 });
        report.bgpPeers = await lab.waitForPublicPeers();
        const clients = await waitForClients(controller, 2);
        report.clients = clients;
        report.bgpPeersAfterReset = await lab.resetPublicPeers();
        report.deviceState = await lab.collectPublicState();
        const instances = await waitForInstances(controller, clients, 30000);
        report.instances = instances.map(result => result.data);
        report.controllerTimeline = controller.timeline;
    } catch (error) {
        primaryError = error;
        report.error = { message: error.message, stack: error.stack };
        if (!report.deviceState && lab.clients.length === lab.targets.length) {
            try {
                report.deviceState = await lab.collectPublicState();
            } catch (stateError) {
                report.deviceStateError = stateError.message;
            }
        }
    } finally {
        report.controllerTimeline = controller.timeline;
        try {
            await controller.cleanup();
        } catch (error) {
            report.collectorCleanupError = error.message;
            primaryError ||= error;
        }
        try {
            restoreResults = await lab.restore();
            report.restoreResults = restoreResults;
        } catch (error) {
            report.restoreError = error.message;
            primaryError ||= error;
        }
        report.finishedAt = new Date().toISOString();
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }

    if (primaryError) throw primaryError;
    if (!restoreResults?.every(result => result.verified)) {
        throw new Error('Huawei live smoke completed without verified device restoration');
    }
    process.stdout.write(
        `${JSON.stringify({ reportPath, clients: report.clients?.length, restored: true }, null, 2)}\n`
    );
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`Huawei BMP live smoke failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    waitForClients,
    waitForInstances
};
