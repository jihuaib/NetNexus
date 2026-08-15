const os = require('node:os');
const { performance } = require('node:perf_hooks');

const GET_PROCESS_RESOURCE_SNAPSHOT_CHANNEL = 'process-resource:getSnapshot';

const PROCESS_TYPE_DISPLAY_NAMES = Object.freeze({
    Browser: '主进程',
    Tab: '渲染进程',
    Utility: '辅助进程',
    Zygote: 'Zygote',
    'Sandbox helper': '沙箱辅助进程',
    GPU: 'GPU 进程',
    'Pepper Plugin': 'Pepper 插件',
    'Pepper Plugin Broker': 'Pepper 插件代理',
    Unknown: '未知进程'
});

function nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function kilobytesToBytes(value) {
    return Math.round(nonNegativeNumber(value) * 1024);
}

function optionalKilobytesToBytes(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number * 1024) : null;
}

function optionalNonNegativeNumber(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeWindowTitles(windowTitlesByPid, pid) {
    const titles = windowTitlesByPid instanceof Map ? windowTitlesByPid.get(pid) : windowTitlesByPid?.[pid];
    return Array.isArray(titles)
        ? titles.map(title => String(title || '').trim()).filter(Boolean)
        : typeof titles === 'string' && titles.trim()
          ? [titles.trim()]
          : [];
}

function getProcessDisplayName(metric, windowTitlesByPid, appName) {
    const windowTitles = normalizeWindowTitles(windowTitlesByPid, metric.pid);
    if (windowTitles.length > 0) {
        return windowTitles.join(' / ');
    }

    const name = typeof metric.name === 'string' ? metric.name.trim() : '';
    if (metric.type === 'Browser') {
        return `${name || appName || 'NetNexus'} 主进程`;
    }
    if (name) {
        return name;
    }

    const serviceName = typeof metric.serviceName === 'string' ? metric.serviceName.trim() : '';
    if (serviceName) {
        return serviceName;
    }

    return PROCESS_TYPE_DISPLAY_NAMES[metric.type] || PROCESS_TYPE_DISPLAY_NAMES.Unknown;
}

function normalizeProcessMetric(metric, options = {}) {
    const pid = Math.trunc(nonNegativeNumber(metric?.pid));
    const creationTime = nonNegativeNumber(metric?.creationTime);
    const type = typeof metric?.type === 'string' && metric.type ? metric.type : 'Unknown';
    const serviceName = typeof metric?.serviceName === 'string' ? metric.serviceName : '';
    const name = typeof metric?.name === 'string' ? metric.name : '';

    return {
        key: `${pid}:${creationTime || 0}`,
        pid,
        type,
        typeLabel: PROCESS_TYPE_DISPLAY_NAMES[type] || PROCESS_TYPE_DISPLAY_NAMES.Unknown,
        displayName: getProcessDisplayName({ ...metric, pid, type }, options.windowTitlesByPid, options.appName),
        name,
        serviceName,
        cpuPercent: nonNegativeNumber(metric?.cpu?.percentCPUUsage),
        idleWakeupsPerSecond:
            options.platform === 'win32' ? null : optionalNonNegativeNumber(metric?.cpu?.idleWakeupsPerSecond),
        workingSetBytes: kilobytesToBytes(metric?.memory?.workingSetSize),
        peakWorkingSetBytes: kilobytesToBytes(metric?.memory?.peakWorkingSetSize),
        privateBytes: options.platform === 'win32' ? optionalKilobytesToBytes(metric?.memory?.privateBytes) : null,
        creationTime: creationTime || null,
        sandboxed: typeof metric?.sandboxed === 'boolean' ? metric.sandboxed : null,
        integrityLevel: typeof metric?.integrityLevel === 'string' ? metric.integrityLevel : null
    };
}

function normalizeSystemMemory(systemMemory = {}) {
    const totalBytes = kilobytesToBytes(systemMemory.total);
    const freeBytes = Math.min(totalBytes, kilobytesToBytes(systemMemory.free));
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
        totalBytes,
        freeBytes,
        usedBytes,
        usagePercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
        swapTotalBytes: optionalKilobytesToBytes(systemMemory.swapTotal),
        swapFreeBytes: optionalKilobytesToBytes(systemMemory.swapFree)
    };
}

function buildProcessResourceSnapshot(raw = {}) {
    const appName = typeof raw.appName === 'string' && raw.appName ? raw.appName : 'NetNexus';
    const processes = (Array.isArray(raw.metrics) ? raw.metrics : []).map(metric =>
        normalizeProcessMetric(metric, {
            appName,
            platform: raw.platform,
            windowTitlesByPid: raw.windowTitlesByPid
        })
    );
    const systemMemory = normalizeSystemMemory(raw.systemMemory);
    const totalCpuPercent = processes.reduce((total, processMetric) => total + processMetric.cpuPercent, 0);
    const totalWorkingSetBytes = processes.reduce((total, processMetric) => total + processMetric.workingSetBytes, 0);
    const totalPeakWorkingSetBytes = processes.reduce(
        (total, processMetric) => total + processMetric.peakWorkingSetBytes,
        0
    );

    return {
        schemaVersion: 1,
        sampledAt: nonNegativeNumber(raw.sampledAt) || Date.now(),
        warmingUp: Boolean(raw.warmingUp),
        app: {
            name: appName,
            version: typeof raw.appVersion === 'string' ? raw.appVersion : '',
            pid: Math.trunc(nonNegativeNumber(raw.mainPid))
        },
        runtime: {
            platform: typeof raw.platform === 'string' ? raw.platform : '',
            arch: typeof raw.arch === 'string' ? raw.arch : '',
            electronVersion: typeof raw.electronVersion === 'string' ? raw.electronVersion : '',
            nodeVersion: typeof raw.nodeVersion === 'string' ? raw.nodeVersion : '',
            chromeVersion: typeof raw.chromeVersion === 'string' ? raw.chromeVersion : ''
        },
        summary: {
            processCount: processes.length,
            totalCpuPercent,
            totalWorkingSetBytes,
            totalPeakWorkingSetBytes,
            appMemoryPercent: systemMemory.totalBytes > 0 ? (totalWorkingSetBytes / systemMemory.totalBytes) * 100 : 0
        },
        systemMemory,
        processes
    };
}

class ProcessResourceSampler {
    constructor(options = {}) {
        this.options = options;
        this.minimumIntervalMs = Math.max(250, nonNegativeNumber(options.minimumIntervalMs) || 750);
        this.maximumIntervalMs = Math.max(
            this.minimumIntervalMs,
            nonNegativeNumber(options.maximumIntervalMs) || 30000
        );
        this.wallClock = typeof options.now === 'function' ? options.now : Date.now;
        this.monotonicClock =
            typeof options.monotonicNow === 'function' ? options.monotonicNow : () => performance.now();
        this.lastCollectionTick = null;
        this.cachedSnapshot = null;
        this.hasSuccessfulSample = false;
    }

    getSnapshot() {
        const tick = this.monotonicClock();
        const elapsed = this.lastCollectionTick === null ? null : tick - this.lastCollectionTick;
        if (this.cachedSnapshot && elapsed >= 0 && elapsed < this.minimumIntervalMs) {
            return this.cachedSnapshot;
        }

        const warmingUp = !this.hasSuccessfulSample || elapsed < 0 || elapsed > this.maximumIntervalMs;
        const snapshot = collectProcessResourceSnapshot({ ...this.options, sampledAt: this.wallClock() });
        this.cachedSnapshot = {
            ...snapshot,
            warmingUp
        };
        this.hasSuccessfulSample = true;
        this.lastCollectionTick = tick;
        return this.cachedSnapshot;
    }
}

function collectWindowTitles(BrowserWindowClass) {
    const titlesByPid = new Map();
    const windows = typeof BrowserWindowClass?.getAllWindows === 'function' ? BrowserWindowClass.getAllWindows() : [];

    windows.forEach(window => {
        try {
            if (!window || (typeof window.isDestroyed === 'function' && window.isDestroyed())) {
                return;
            }
            const webContents = window.webContents;
            const pid = Number(webContents?.getOSProcessId?.());
            if (!Number.isInteger(pid) || pid <= 0) {
                return;
            }
            const title = String(window.getTitle?.() || '').trim();
            if (!title) {
                return;
            }
            const currentTitles = titlesByPid.get(pid) || [];
            if (!currentTitles.includes(title)) {
                currentTitles.push(title);
            }
            titlesByPid.set(pid, currentTitles);
        } catch (_error) {
            // A renderer can disappear while the snapshot is being collected.
        }
    });
    return titlesByPid;
}

function getSystemMemoryInfo(processObject) {
    if (typeof processObject?.getSystemMemoryInfo === 'function') {
        return processObject.getSystemMemoryInfo();
    }
    return {
        total: os.totalmem() / 1024,
        free: os.freemem() / 1024,
        swapTotal: 0,
        swapFree: 0
    };
}

function collectProcessResourceSnapshot(options = {}) {
    const appInstance = options.appInstance;
    const processObject = options.processObject || process;
    if (!appInstance || typeof appInstance.getAppMetrics !== 'function') {
        throw new Error('当前环境不支持进程资源指标');
    }

    return buildProcessResourceSnapshot({
        metrics: appInstance.getAppMetrics(),
        systemMemory: getSystemMemoryInfo(processObject),
        windowTitlesByPid: collectWindowTitles(options.BrowserWindowClass),
        sampledAt: nonNegativeNumber(options.sampledAt) || Date.now(),
        appName: typeof appInstance.getName === 'function' ? appInstance.getName() : 'NetNexus',
        appVersion: typeof appInstance.getVersion === 'function' ? appInstance.getVersion() : '',
        mainPid: processObject.pid,
        platform: processObject.platform,
        arch: processObject.arch,
        electronVersion: processObject.versions?.electron,
        nodeVersion: processObject.versions?.node,
        chromeVersion: processObject.versions?.chrome
    });
}

module.exports = {
    GET_PROCESS_RESOURCE_SNAPSHOT_CHANNEL,
    PROCESS_TYPE_DISPLAY_NAMES,
    ProcessResourceSampler,
    buildProcessResourceSnapshot,
    collectProcessResourceSnapshot,
    normalizeProcessMetric,
    normalizeSystemMemory
};
