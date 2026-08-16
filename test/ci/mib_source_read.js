const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SnmpApp = require('../../electron/app/snmpApp');

class FakeIpcMain {
    constructor() {
        this.handlers = new Map();
    }

    handle(channel, handler) {
        this.handlers.set(channel, handler);
    }
}

class MemoryStore {
    constructor(initial = {}) {
        this.values = new Map(Object.entries(initial));
    }

    get(key) {
        return this.values.get(key);
    }

    set(key, value) {
        this.values.set(key, value);
    }
}

function assertError(response, pattern, description) {
    assert.equal(response.status, 'error', `${description} should fail`);
    assert.match(response.msg, pattern, description);
}

async function main() {
    assert.equal(
        process.env.NETNEXUS_EXPECT_UTILITY_PROCESS,
        '1',
        'MIB source ownership must be tested with a real Electron Utility Process'
    );

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-mib-source-'));
    const workspaceDir = path.join(tempRoot, 'workspace');
    const outsideDir = path.join(tempRoot, 'outside');
    const sourcePath = path.join(workspaceDir, 'DEMO-MIB.mib');
    const unsupportedPath = path.join(workspaceDir, 'metadata.json');
    const outsidePath = path.join(outsideDir, 'PRIVATE-MIB.mib');
    const escapePath = path.join(workspaceDir, 'ESCAPE-MIB.mib');

    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(sourcePath, 'DEMO-MIB DEFINITIONS ::= BEGIN\nEND\n', 'utf8');
    fs.writeFileSync(unsupportedPath, '{}\n', 'utf8');
    fs.writeFileSync(outsidePath, 'PRIVATE-MIB DEFINITIONS ::= BEGIN\nEND\n', 'utf8');

    let symlinkCreated = false;
    try {
        fs.symlinkSync(outsidePath, escapePath);
        symlinkCreated = true;
    } catch (error) {
        if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    }

    const ipcMain = new FakeIpcMain();
    const store = new MemoryStore({ 'snmp-mib-files': [workspaceDir] });
    const snmpApp = new SnmpApp(ipcMain, store);
    snmpApp.getMibCacheFilePath = () => path.join(tempRoot, 'snmp-mib-cache.json');
    snmpApp.getMibProjectRootDir = () => path.join(tempRoot, 'snmp-mib-projects');
    const sender = {
        id: 81,
        send() {},
        isDestroyed: () => false
    };
    const getMibSource = ipcMain.handlers.get('snmp:getMibSource');
    assert.equal(typeof getMibSource, 'function');

    const originalFsMethods = new Map();
    const mainFilesystemCalls = [];
    for (const methodName of ['stat', 'realpath', 'readFile']) {
        const original = fs.promises[methodName];
        originalFsMethods.set(methodName, original);
        fs.promises[methodName] = async (...args) => {
            const requestedPath = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
            if (requestedPath === tempRoot || requestedPath.startsWith(`${tempRoot}${path.sep}`)) {
                mainFilesystemCalls.push({ methodName, requestedPath });
            }
            return original.apply(fs.promises, args);
        };
    }

    try {
        const stoppedResponse = await getMibSource(null, { filePath: sourcePath });
        assertError(stoppedResponse, /SNMP运行时未启动/u, 'stopped runtime source read');
        assert.equal(snmpApp.worker, null, 'source read must not lazily start the SNMP runtime');
        assert.deepEqual(mainFilesystemCalls, [], 'stopped SnmpApp must not inspect or read the MIB source');

        const startResponse = await snmpApp.handleStartSnmp(
            { sender },
            {
                targetHost: '127.0.0.1',
                queryPort: 10161,
                community: 'public',
                supportedVersions: ['v2c']
            }
        );
        assert.equal(startResponse.status, 'success', startResponse.msg);
        assert.equal(snmpApp.worker.transport, 'utility-process');
        assert.notEqual(snmpApp.worker.pid, process.pid);

        const sourceResponse = await getMibSource(null, { filePath: sourcePath });
        assert.equal(sourceResponse.status, 'success', sourceResponse.msg);
        assert.equal(sourceResponse.data.fileName, 'DEMO-MIB.mib');
        assert.match(sourceResponse.data.source, /DEMO-MIB DEFINITIONS ::= BEGIN/u);
        assert(
            Number.isInteger(Number(sourceResponse.data.mibWorkerThreadId)) &&
                Number(sourceResponse.data.mibWorkerThreadId) > 0,
            `source read must run in the nested MIB worker thread, got ${sourceResponse.data.mibWorkerThreadId}`
        );
        assert.deepEqual(mainFilesystemCalls, [], 'Electron main must not read an allowed MIB source');

        const unsupportedResponse = await getMibSource(null, { filePath: unsupportedPath });
        assertError(unsupportedResponse, /不是支持的MIB源码类型/u, 'unsupported source type');

        const outsideResponse = await getMibSource(null, { filePath: outsidePath });
        assertError(outsideResponse, /当前MIB编译工作区中不存在该文件/u, 'outside workspace source');

        if (symlinkCreated) {
            const escapeResponse = await getMibSource(null, { filePath: escapePath });
            assertError(escapeResponse, /当前MIB编译工作区中不存在该文件/u, 'symlink workspace escape');
        }

        assert.deepEqual(mainFilesystemCalls, [], 'all MIB path checks and reads must stay outside Electron main');
        console.log('MIB source nested-worker ownership and path-boundary tests passed');
    } finally {
        for (const [methodName, original] of originalFsMethods) fs.promises[methodName] = original;
        if (snmpApp.worker) await snmpApp.handleStopSnmp().catch(() => {});
        await snmpApp.worker?.terminate().catch(() => {});
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = main;
