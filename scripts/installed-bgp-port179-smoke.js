const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { _electron: electron } = require('playwright');
const { findPackagedElectronExecutable, projectRoot } = require('./e2e-support/packaged-app');

const BGP_PORT = 179;
const BGP_SERVICE_NAME = 'netnexus.protocol.bgp';

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(operation, description, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;

    do {
        try {
            const result = await operation();
            if (result) return result;
        } catch (error) {
            lastError = error;
        }
        await delay(100);
    } while (Date.now() < deadline);

    const detail = lastError?.message ? `: ${lastError.message}` : '';
    throw new Error(`Timed out waiting for ${description}${detail}`);
}

function connectToBgpPort() {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: BGP_PORT });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`Timed out connecting to TCP/${BGP_PORT}`));
        }, 5000);

        socket.once('connect', () => {
            clearTimeout(timer);
            socket.destroy();
            resolve();
        });
        socket.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function findProductionMainWindow(electronApp) {
    return waitFor(
        async () => {
            for (const page of electronApp.windows()) {
                const hasBgpApi = await page
                    .evaluate(() => typeof window.bgpApi?.startBgp === 'function')
                    .catch(() => false);
                if (hasBgpApi) return page;
            }
            return null;
        },
        'the production main window and BGP preload API',
        60000
    );
}

async function findBgpUtilityMetric(electronApp) {
    return waitFor(async () => {
        const metrics = await electronApp.evaluate(({ app }) =>
            app.getAppMetrics().map(metric => ({
                pid: metric.pid,
                type: metric.type,
                name: metric.name,
                serviceName: metric.serviceName
            }))
        );
        return metrics.find(
            metric =>
                metric.type === 'Utility' &&
                (metric.name === BGP_SERVICE_NAME || metric.serviceName === BGP_SERVICE_NAME)
        );
    }, 'the production BGP utility process');
}

async function closeApplication(electronApp) {
    const processHandle = electronApp.process();
    const closePromise = electronApp.waitForEvent('close', { timeout: 5000 }).catch(() => null);
    await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await closePromise;

    if (processHandle.exitCode === null) {
        processHandle.kill('SIGKILL');
    }
}

async function main() {
    assert.equal(process.platform, 'linux', 'installed BGP TCP/179 smoke is Linux-only');
    assert.notEqual(process.getuid?.(), 0, 'installed BGP TCP/179 smoke must run as an ordinary user');

    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-bgp179-'));
    const environment = {
        ...process.env,
        XDG_CONFIG_HOME: configRoot
    };
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.NETNEXUS_E2E;
    delete environment.E2E_NO_SANDBOX;

    let electronApp = null;
    let mainPage = null;
    let bgpStarted = false;

    try {
        electronApp = await electron.launch({
            executablePath: findPackagedElectronExecutable(),
            args: [],
            cwd: projectRoot,
            env: environment
        });

        assert(
            !electronApp.process().spawnargs.includes('--no-sandbox'),
            'installed package smoke must exercise the configured Chromium sandbox'
        );
        assert.notEqual(
            await electronApp.evaluate(() => process.getuid?.()),
            0,
            'the installed Electron application must not run as root'
        );

        mainPage = await findProductionMainWindow(electronApp);
        await waitFor(
            () => mainPage.evaluate(() => window.bgpApi.loadBgpConfig()).then(result => result?.status === 'success'),
            'production BGP IPC registration'
        );

        const startResult = await mainPage.evaluate(config => window.bgpApi.startBgp(config), {
            port: BGP_PORT,
            localAs: '65000',
            routerId: '192.0.2.1',
            addressFamily: [1]
        });
        assert.equal(startResult?.status, 'success', startResult?.msg || 'BGP start returned no result');
        bgpStarted = true;

        const metric = await findBgpUtilityMetric(electronApp);
        await connectToBgpPort();
        console.log(
            `Installed BGP TCP/179 smoke passed: utility pid=${metric.pid}, sandbox=enabled, uid=${process.getuid()}`
        );
    } finally {
        if (bgpStarted && mainPage && !mainPage.isClosed()) {
            await mainPage.evaluate(() => window.bgpApi.stopBgp()).catch(() => {});
        }
        if (electronApp) await closeApplication(electronApp);
        fs.rmSync(configRoot, { recursive: true, force: true });
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.stack || error.message);
        process.exit(1);
    });
}

module.exports = {
    connectToBgpPort,
    findBgpUtilityMetric,
    findProductionMainWindow,
    main,
    waitFor
};
