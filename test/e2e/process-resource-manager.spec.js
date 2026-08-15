const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e } = require('../../scripts/e2e-support');

const FIRST_SNAPSHOT = {
    schemaVersion: 1,
    sampledAt: 1786800000000,
    warmingUp: false,
    app: { name: 'NetNexus', version: '5.0.2', pid: 4100 },
    runtime: {
        platform: 'darwin',
        arch: 'arm64',
        electronVersion: '22.3.27',
        nodeVersion: '16.17.1',
        chromeVersion: '108.0.5359.215'
    },
    summary: {
        processCount: 3,
        totalCpuPercent: 15.5,
        totalWorkingSetBytes: 805306368,
        totalPeakWorkingSetBytes: 890880000,
        appMemoryPercent: 9.375
    },
    systemMemory: {
        totalBytes: 8589934592,
        freeBytes: 3221225472,
        usedBytes: 5368709120,
        usagePercent: 62.5,
        swapTotalBytes: 2147483648,
        swapFreeBytes: 1073741824
    },
    processes: [
        {
            key: '4100:1786798000000',
            pid: 4100,
            type: 'Browser',
            typeLabel: '主进程',
            displayName: 'NetNexus 主进程',
            name: '',
            serviceName: '',
            cpuPercent: 5.2,
            idleWakeupsPerSecond: 1,
            workingSetBytes: 268435456,
            peakWorkingSetBytes: 307200000,
            privateBytes: 201326592,
            sharedBytes: 67108864,
            creationTime: 1786798000000,
            sandboxed: false,
            integrityLevel: 'high'
        },
        {
            key: '4101:1786798010000',
            pid: 4101,
            type: 'Tab',
            typeLabel: '渲染进程',
            displayName: 'NetNexus 主窗口',
            name: '',
            serviceName: '',
            cpuPercent: 8.8,
            idleWakeupsPerSecond: 3,
            workingSetBytes: 402653184,
            peakWorkingSetBytes: 430080000,
            privateBytes: 335544320,
            sharedBytes: 67108864,
            creationTime: 1786798010000,
            sandboxed: true,
            integrityLevel: null
        },
        {
            key: '4102:1786798020000',
            pid: 4102,
            type: 'Utility',
            typeLabel: '辅助进程',
            displayName: 'network.mojom.NetworkService',
            name: '',
            serviceName: 'network.mojom.NetworkService',
            cpuPercent: 1.5,
            idleWakeupsPerSecond: 0,
            workingSetBytes: 134217728,
            peakWorkingSetBytes: 153600000,
            privateBytes: 100663296,
            sharedBytes: 33554432,
            creationTime: 1786798020000,
            sandboxed: true,
            integrityLevel: null
        }
    ]
};

const SECOND_SNAPSHOT = {
    ...FIRST_SNAPSHOT,
    sampledAt: 1786800005000,
    summary: {
        processCount: 2,
        totalCpuPercent: 7.5,
        totalWorkingSetBytes: 536870912,
        totalPeakWorkingSetBytes: 671088640,
        appMemoryPercent: 6.25
    },
    processes: [
        {
            ...FIRST_SNAPSHOT.processes[0],
            cpuPercent: 4,
            workingSetBytes: 268435456,
            peakWorkingSetBytes: 335544320
        },
        {
            key: '4200:1786800001000',
            pid: 4200,
            type: 'GPU',
            typeLabel: 'GPU 进程',
            displayName: 'GPU 进程',
            name: '',
            serviceName: '',
            cpuPercent: 3.5,
            idleWakeupsPerSecond: 0,
            workingSetBytes: 268435456,
            peakWorkingSetBytes: 335544320,
            privateBytes: null,
            sharedBytes: null,
            creationTime: 1786800001000,
            sandboxed: true,
            integrityLevel: null
        }
    ]
};

const WINDOWS_SNAPSHOT = {
    ...FIRST_SNAPSHOT,
    runtime: {
        ...FIRST_SNAPSHOT.runtime,
        platform: 'win32',
        arch: 'x64'
    },
    processes: FIRST_SNAPSHOT.processes.map(processMetric => ({
        ...processMetric,
        idleWakeupsPerSecond: null
    }))
};

const MANY_PROCESSES_SNAPSHOT = {
    ...FIRST_SNAPSHOT,
    summary: {
        ...FIRST_SNAPSHOT.summary,
        processCount: 60
    },
    processes: Array.from({ length: 60 }, (_, index) => ({
        ...FIRST_SNAPSHOT.processes[1],
        key: `${5000 + index}:${1786798010000 + index}`,
        pid: 5000 + index,
        displayName: `渲染进程 ${String(index + 1).padStart(2, '0')}`,
        cpuPercent: 60 - index
    }))
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

async function installProcessResourceMock(page, snapshots = [FIRST_SNAPSHOT]) {
    const calls = [];
    let activeSnapshotIndex = 0;
    await page.exposeFunction('__processResourceE2eGetSnapshot', async () => {
        calls.push({ at: Date.now(), snapshotIndex: activeSnapshotIndex });
        const snapshot = snapshots[Math.min(activeSnapshotIndex, snapshots.length - 1)];
        return { status: 'success', msg: '进程资源指标获取成功', data: clone(snapshot) };
    });
    await page.addInitScript(() => {
        window.processResourceApi = {
            getSnapshot: () => window.__processResourceE2eGetSnapshot()
        };
    });
    return {
        calls,
        useSnapshot(index) {
            activeSnapshotIndex = index;
        }
    };
}

test.describe('Process resource manager', () => {
    let featureHarness;

    test.beforeEach(async ({ page }) => {
        featureHarness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        await featureHarness?.cleanup();
        featureHarness = null;
    });

    test('opens the singleton resource window from More options', async ({ page }) => {
        await page.goto('/#/tools/packet-parser');
        await expect(page.getByText('报文解析器', { exact: true })).toBeVisible();

        await page.getByRole('button', { name: '更多选项' }).click();
        const resourceItem = page.getByRole('menuitem', { name: '进程资源管理器', exact: true });
        await expect(resourceItem).toBeVisible();
        await resourceItem.click();

        await expect
            .poll(() => page.evaluate(() => window.__featureMonitorRequestDetails?.at(-1) || null))
            .toEqual({ monitorId: 'process-resource-manager', options: null });
        await expect(page.locator('.nn-toast-error')).toHaveCount(0);
    });

    test('renders deterministic CPU and memory metrics and supports manual refresh', async ({ page }) => {
        const resourceMock = await installProcessResourceMock(page, [FIRST_SNAPSHOT, SECOND_SNAPSHOT]);
        await page.goto('/#/monitor/process-resource-manager');

        const shell = page.getByTestId('process-resource-manager-shell');
        const resourcePage = page.getByTestId('process-resource-manager-page');
        const processTable = page.getByTestId('process-resource-table');
        await expect(shell).toBeVisible();
        await expect(resourcePage).toBeVisible();
        await expect(page.locator('.sider')).toHaveCount(0);
        await expect(page).toHaveTitle('进程资源管理器 - NetNexus');
        await expect.poll(() => resourceMock.calls.length).toBe(1);

        const autoRefresh = page.getByTestId('process-resource-auto-refresh');
        await expect(autoRefresh).toHaveAttribute('aria-checked', 'true');
        await autoRefresh.click();
        await expect(autoRefresh).toHaveAttribute('aria-checked', 'false');

        await expect(page.getByTestId('process-resource-process-count')).toContainText('3');
        await expect(page.getByTestId('process-resource-total-cpu')).toContainText('15.5%');
        await expect(page.getByTestId('process-resource-total-memory')).toContainText('768 MB');
        await expect(page.getByTestId('process-resource-system-memory')).toContainText('62.5%');
        await expect(page.getByTestId('process-resource-system-memory')).toContainText('5 GB / 8 GB');
        await expect(resourcePage).toContainText('NetNexus 5.0.2 · darwin / arm64 · Electron 22.3.27');
        await expect(resourcePage).toContainText('主进程 PID 4100');

        const initialRows = processTable.locator('.nn-table-tbody > .nn-table-row');
        await expect(initialRows).toHaveCount(3);
        await expect(initialRows.nth(0)).toContainText('NetNexus 主窗口');
        await expect(initialRows.nth(0)).toContainText('4101');
        await expect(initialRows.nth(0)).toContainText('8.8%');
        await expect(processTable).toContainText('NetNexus 主进程');
        await expect(processTable).toContainText('network.mojom.NetworkService');
        await expect(processTable).toContainText('384 MB');
        await expect(processTable).toContainText('256 MB');
        await expect(processTable).toContainText('128 MB');
        await expect(processTable.locator('.nn-table-thead')).toContainText('唤醒/秒');
        await expect(processTable.locator('.nn-table-thead')).not.toContainText('私有内存');

        const callsBeforeManualRefresh = resourceMock.calls.length;
        resourceMock.useSnapshot(1);
        await page.getByTestId('process-resource-refresh').click();
        await expect.poll(() => resourceMock.calls.length).toBe(callsBeforeManualRefresh + 1);

        await expect(page.getByTestId('process-resource-process-count')).toContainText('2');
        await expect(page.getByTestId('process-resource-total-cpu')).toContainText('7.5%');
        await expect(page.getByTestId('process-resource-total-memory')).toContainText('512 MB');
        await expect(processTable.locator('.nn-table-tbody > .nn-table-row')).toHaveCount(2);
        await expect(processTable).toContainText('4200');
        await expect(processTable).toContainText('GPU 进程');
        await expect(processTable).not.toContainText('4101');
        await expect(processTable).not.toContainText('4102');
    });

    test('keeps a long process list inside the window with an internal scrollbar', async ({ page }) => {
        await installProcessResourceMock(page, [MANY_PROCESSES_SNAPSHOT]);
        await page.goto('/#/monitor/process-resource-manager');

        const processTable = page.getByTestId('process-resource-table');
        await expect(processTable.locator('.nn-table-tbody > .nn-table-row')).toHaveCount(60);
        const tableBody = processTable.locator('.nn-table-content');
        await expect(tableBody).toBeVisible();
        await expect
            .poll(() =>
                tableBody.evaluate(element => ({
                    clientHeight: element.clientHeight,
                    overflowY: getComputedStyle(element).overflowY,
                    scrollHeight: element.scrollHeight
                }))
            )
            .toMatchObject({ overflowY: 'auto' });
        const geometry = await tableBody.evaluate(element => ({
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight
        }));
        expect(geometry.clientHeight).toBeGreaterThan(0);
        expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
        await tableBody.evaluate(element => {
            element.scrollTop = element.scrollHeight;
        });
        await expect.poll(() => tableBody.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    });

    test('shows the platform-specific memory column on Windows', async ({ page }) => {
        await installProcessResourceMock(page, [WINDOWS_SNAPSHOT]);
        await page.goto('/#/monitor/process-resource-manager');

        const tableHeader = page.getByTestId('process-resource-table').locator('.nn-table-thead');
        await expect(tableHeader).toContainText('私有内存');
        await expect(tableHeader).not.toContainText('唤醒/秒');
        await expect(page.getByTestId('process-resource-table')).toContainText('192 MB');
    });

    test('adapts the overview and table at the default and minimum window sizes', async ({ page }) => {
        await installProcessResourceMock(page, [FIRST_SNAPSHOT]);
        await page.setViewportSize({ width: 1180, height: 760 });
        await page.goto('/#/monitor/process-resource-manager');

        const resourcePage = page.getByTestId('process-resource-manager-page');
        const processTable = page.getByTestId('process-resource-table');
        const summary = resourcePage.locator('.resource-summary');
        await expect(processTable.locator('.nn-table-thead')).toContainText('启动时间');

        const defaultGeometry = await resourcePage.evaluate(element => ({
            pageClientWidth: element.clientWidth,
            pageScrollWidth: element.scrollWidth,
            viewportWidth: window.innerWidth,
            documentScrollWidth: document.documentElement.scrollWidth
        }));
        expect(defaultGeometry.pageScrollWidth).toBeLessThanOrEqual(defaultGeometry.pageClientWidth);
        expect(defaultGeometry.documentScrollWidth).toBeLessThanOrEqual(defaultGeometry.viewportWidth);

        await page.setViewportSize({ width: 900, height: 600 });
        await expect
            .poll(() => summary.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length))
            .toBe(2);

        const minimumGeometry = await resourcePage.evaluate(element => ({
            pageClientWidth: element.clientWidth,
            pageScrollWidth: element.scrollWidth,
            viewportWidth: window.innerWidth,
            documentScrollWidth: document.documentElement.scrollWidth
        }));
        expect(minimumGeometry.pageScrollWidth).toBeLessThanOrEqual(minimumGeometry.pageClientWidth);
        expect(minimumGeometry.documentScrollWidth).toBeLessThanOrEqual(minimumGeometry.viewportWidth);

        const tableContent = processTable.locator('.nn-table-content');
        await expect(tableContent).toBeVisible();
        await expect.poll(() => tableContent.evaluate(element => getComputedStyle(element).overflowX)).toBe('auto');
    });
});
