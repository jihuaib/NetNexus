const assert = require('node:assert/strict');

const {
    ProcessResourceSampler,
    buildProcessResourceSnapshot,
    collectProcessResourceSnapshot,
    normalizeProcessMetric,
    normalizeSystemMemory
} = require('../../electron/window/processResourceService');

function createRawMetrics() {
    return [
        {
            pid: 4100,
            type: 'Browser',
            creationTime: 1786798000000,
            cpu: { percentCPUUsage: 5.25, idleWakeupsPerSecond: 1 },
            memory: {
                workingSetSize: 262144,
                peakWorkingSetSize: 300000,
                privateBytes: 196608,
                sharedBytes: 65536
            },
            sandboxed: false,
            integrityLevel: 'high'
        },
        {
            pid: 4101,
            type: 'Tab',
            creationTime: 1786798010000,
            cpu: { percentCPUUsage: 8.75, idleWakeupsPerSecond: 3 },
            memory: {
                workingSetSize: 393216,
                peakWorkingSetSize: 420000,
                privateBytes: 327680,
                sharedBytes: 65536
            },
            sandboxed: true
        },
        {
            pid: 4102,
            type: 'Utility',
            serviceName: 'network.mojom.NetworkService',
            creationTime: 1786798020000,
            cpu: { percentCPUUsage: 1.5, idleWakeupsPerSecond: 0 },
            memory: {
                workingSetSize: 131072,
                peakWorkingSetSize: 150000,
                privateBytes: 98304,
                sharedBytes: 32768
            }
        }
    ];
}

function verifyNormalization() {
    const snapshot = buildProcessResourceSnapshot({
        metrics: createRawMetrics(),
        systemMemory: {
            total: 8388608,
            free: 3145728,
            swapTotal: 2097152,
            swapFree: 1048576
        },
        windowTitlesByPid: new Map([
            [4100, ['NetNexus']],
            [4101, ['NetNexus 主窗口', '进程资源管理器 - NetNexus']]
        ]),
        sampledAt: 1786800000000,
        appName: 'NetNexus',
        appVersion: '5.0.2',
        mainPid: 4100,
        platform: 'win32',
        arch: 'x64',
        electronVersion: '22.3.27',
        nodeVersion: '16.17.1',
        chromeVersion: '108.0.5359.215'
    });

    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.sampledAt, 1786800000000);
    assert.equal(snapshot.warmingUp, false);
    assert.deepEqual(snapshot.app, { name: 'NetNexus', version: '5.0.2', pid: 4100 });
    assert.deepEqual(snapshot.runtime, {
        platform: 'win32',
        arch: 'x64',
        electronVersion: '22.3.27',
        nodeVersion: '16.17.1',
        chromeVersion: '108.0.5359.215'
    });
    assert.deepEqual(snapshot.summary, {
        processCount: 3,
        totalCpuPercent: 15.5,
        totalWorkingSetBytes: 805306368,
        totalPeakWorkingSetBytes: 890880000,
        appMemoryPercent: 9.375
    });
    assert.deepEqual(snapshot.systemMemory, {
        totalBytes: 8589934592,
        freeBytes: 3221225472,
        usedBytes: 5368709120,
        usagePercent: 62.5,
        swapTotalBytes: 2147483648,
        swapFreeBytes: 1073741824
    });

    const [browser, tab, utility] = snapshot.processes;
    assert.equal(browser.key, '4100:1786798000000');
    assert.equal(browser.typeLabel, '主进程');
    assert.equal(browser.displayName, 'NetNexus');
    assert.equal(browser.cpuPercent, 5.25);
    assert.equal(browser.workingSetBytes, 268435456);
    assert.equal(browser.peakWorkingSetBytes, 307200000);
    assert.equal(browser.privateBytes, 201326592);
    assert.equal(browser.idleWakeupsPerSecond, null);
    assert.equal(browser.sandboxed, false);
    assert.equal(browser.integrityLevel, 'high');

    assert.equal(tab.typeLabel, '渲染进程');
    assert.equal(tab.displayName, 'NetNexus 主窗口 / 进程资源管理器 - NetNexus');
    assert.equal(tab.workingSetBytes, 402653184);
    assert.equal(utility.typeLabel, '辅助进程');
    assert.equal(utility.displayName, 'network.mojom.NetworkService');
    assert.equal(utility.serviceName, 'network.mojom.NetworkService');
}

function verifyEmptyAndPlatformSpecificFields() {
    const unknown = normalizeProcessMetric({
        pid: -7,
        type: 'Future Process',
        creationTime: -1,
        cpu: { percentCPUUsage: -5, idleWakeupsPerSecond: Number.NaN },
        memory: {
            workingSetSize: -1,
            peakWorkingSetSize: undefined,
            privateBytes: 'invalid',
            sharedBytes: ''
        },
        sandboxed: 'yes',
        integrityLevel: 42
    });
    assert.deepEqual(unknown, {
        key: '0:0',
        pid: 0,
        type: 'Future Process',
        typeLabel: '未知进程',
        displayName: '未知进程',
        name: '',
        serviceName: '',
        cpuPercent: 0,
        idleWakeupsPerSecond: null,
        workingSetBytes: 0,
        peakWorkingSetBytes: 0,
        privateBytes: null,
        creationTime: null,
        sandboxed: null,
        integrityLevel: null
    });

    const macProcess = normalizeProcessMetric(
        {
            pid: 88,
            type: 'Tab',
            cpu: { idleWakeupsPerSecond: 2 },
            memory: { privateBytes: 1024 }
        },
        { platform: 'darwin' }
    );
    assert.equal(macProcess.privateBytes, null, 'private memory is not reported outside Windows');
    assert.equal(macProcess.idleWakeupsPerSecond, 2);

    assert.deepEqual(normalizeSystemMemory({ total: 1024, free: 2048 }), {
        totalBytes: 1048576,
        freeBytes: 1048576,
        usedBytes: 0,
        usagePercent: 0,
        swapTotalBytes: null,
        swapFreeBytes: null
    });

    const appInstance = {
        getAppMetrics: () => [null, { pid: 99, type: 'GPU' }],
        getName: () => undefined,
        getVersion: () => undefined
    };
    const processObject = {
        pid: undefined,
        platform: undefined,
        arch: null,
        versions: {},
        getSystemMemoryInfo: () => ({})
    };
    const snapshot = collectProcessResourceSnapshot({
        appInstance,
        processObject,
        BrowserWindowClass: { getAllWindows: () => [] },
        sampledAt: 1234
    });
    assert.deepEqual(snapshot.app, { name: 'NetNexus', version: '', pid: 0 });
    assert.deepEqual(snapshot.runtime, {
        platform: '',
        arch: '',
        electronVersion: '',
        nodeVersion: '',
        chromeVersion: ''
    });
    assert.equal(snapshot.summary.processCount, 2);
    assert.equal(snapshot.summary.totalCpuPercent, 0);
    assert.equal(snapshot.summary.totalWorkingSetBytes, 0);
    assert.equal(snapshot.processes[0].privateBytes, null);
    assert.equal(snapshot.processes[1].typeLabel, 'GPU 进程');
    assert.deepEqual(snapshot.systemMemory, {
        totalBytes: 0,
        freeBytes: 0,
        usedBytes: 0,
        usagePercent: 0,
        swapTotalBytes: null,
        swapFreeBytes: null
    });

    assert.throws(
        () => collectProcessResourceSnapshot({ appInstance: null, processObject }),
        /当前环境不支持进程资源指标/
    );
}

function verifySamplerCacheAndWarmup() {
    let wallNow = 1000;
    let monotonicNow = 100;
    let metricsCalls = 0;
    const appInstance = {
        getAppMetrics() {
            metricsCalls += 1;
            return [
                {
                    pid: 4100,
                    type: 'Browser',
                    cpu: { percentCPUUsage: metricsCalls },
                    memory: { workingSetSize: 1024 * metricsCalls, peakWorkingSetSize: 2048 }
                }
            ];
        },
        getName: () => 'NetNexus',
        getVersion: () => '5.0.2'
    };
    const processObject = {
        pid: 4100,
        platform: 'linux',
        arch: 'x64',
        versions: { electron: '22.3.27', node: '16.17.1', chrome: '108' },
        getSystemMemoryInfo: () => ({ total: 8192, free: 4096, swapTotal: 0, swapFree: 0 })
    };
    const sampler = new ProcessResourceSampler({
        appInstance,
        processObject,
        BrowserWindowClass: { getAllWindows: () => [] },
        minimumIntervalMs: 500,
        maximumIntervalMs: 1000,
        now: () => wallNow,
        monotonicNow: () => monotonicNow
    });

    const first = sampler.getSnapshot();
    assert.equal(first.warmingUp, true);
    assert.equal(first.sampledAt, 1000);
    assert.equal(first.summary.totalCpuPercent, 1);
    assert.equal(metricsCalls, 1);

    wallNow = 1499;
    monotonicNow = 599;
    const cached = sampler.getSnapshot();
    assert.strictEqual(cached, first, 'requests inside the minimum interval return the cached object');
    assert.equal(metricsCalls, 1);

    wallNow = 1500;
    monotonicNow = 600;
    const refreshed = sampler.getSnapshot();
    assert.notStrictEqual(refreshed, first);
    assert.equal(refreshed.warmingUp, false);
    assert.equal(refreshed.sampledAt, 1500);
    assert.equal(refreshed.summary.totalCpuPercent, 2);
    assert.equal(refreshed.summary.totalWorkingSetBytes, 2097152);
    assert.equal(metricsCalls, 2);

    wallNow = 900;
    monotonicNow = 1100;
    const wallClockRollback = sampler.getSnapshot();
    assert.equal(wallClockRollback.sampledAt, 900, 'wall clock changes do not control cache expiry');
    assert.equal(wallClockRollback.warmingUp, false);
    assert.equal(metricsCalls, 3);

    wallNow = 32000;
    monotonicNow = 32000;
    const resumedAfterLongGap = sampler.getSnapshot();
    assert.equal(resumedAfterLongGap.warmingUp, true, 'a long sampling gap establishes a fresh CPU baseline');
    assert.equal(metricsCalls, 4);
}

function verifyFailedSampleDoesNotConsumeWarmup() {
    let attempts = 0;
    const sampler = new ProcessResourceSampler({
        appInstance: {
            getAppMetrics() {
                attempts += 1;
                if (attempts === 1) throw new Error('mock sampling failure');
                return [];
            },
            getName: () => 'NetNexus',
            getVersion: () => '5.0.2'
        },
        processObject: {
            pid: 4100,
            platform: 'darwin',
            arch: 'arm64',
            versions: {},
            getSystemMemoryInfo: () => ({ total: 8192, free: 4096 })
        },
        BrowserWindowClass: { getAllWindows: () => [] },
        now: () => 2000,
        monotonicNow: () => 200
    });

    assert.throws(() => sampler.getSnapshot(), /mock sampling failure/);
    assert.equal(sampler.getSnapshot().warmingUp, true, 'the first successful sample still warms the CPU baseline');
}

function main() {
    verifyNormalization();
    verifyEmptyAndPlatformSpecificFields();
    verifySamplerCacheAndWarmup();
    verifyFailedSampleDoesNotConsumeWarmup();
    console.log('Process resource metrics normalization and sampler tests passed');
}

main();
