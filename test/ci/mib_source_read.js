const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SnmpApp = require('../../electron/app/snmpApp');

class FakeIpcMain {
    constructor() {
        this.handlers = new Map();
    }

    handle(channel, handler) {
        this.handlers.set(channel, handler);
    }
}

async function run() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-mib-source-'));
    const workspaceDir = path.join(tempRoot, 'workspace');
    const outsideDir = path.join(tempRoot, 'outside');
    const sourcePath = path.join(workspaceDir, 'DEMO-MIB.mib');
    const unsupportedPath = path.join(workspaceDir, 'metadata.json');
    const outsidePath = path.join(outsideDir, 'PRIVATE-MIB.mib');

    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(sourcePath, 'DEMO-MIB DEFINITIONS ::= BEGIN\nEND\n', 'utf8');
    fs.writeFileSync(unsupportedPath, '{}\n', 'utf8');
    fs.writeFileSync(outsidePath, 'PRIVATE-MIB DEFINITIONS ::= BEGIN\nEND\n', 'utf8');

    try {
        const ipcMain = new FakeIpcMain();
        const store = {
            get(key) {
                return key === 'snmp-mib-files' ? [workspaceDir] : null;
            },
            set() {}
        };
        new SnmpApp(ipcMain, store);

        const getMibSource = ipcMain.handlers.get('snmp:getMibSource');
        assert.equal(typeof getMibSource, 'function');

        const sourceResponse = await getMibSource(null, { filePath: sourcePath });
        assert.equal(sourceResponse.status, 'success');
        assert.equal(sourceResponse.data.fileName, 'DEMO-MIB.mib');
        assert.match(sourceResponse.data.source, /DEMO-MIB DEFINITIONS ::= BEGIN/u);

        const unsupportedResponse = await getMibSource(null, { filePath: unsupportedPath });
        assert.equal(unsupportedResponse.status, 'error');
        assert.match(unsupportedResponse.msg, /不是支持的MIB源码类型/u);

        const outsideResponse = await getMibSource(null, { filePath: outsidePath });
        assert.equal(outsideResponse.status, 'error');
        assert.match(outsideResponse.msg, /当前MIB编译工作区中不存在该文件/u);

        const escapePath = path.join(workspaceDir, 'ESCAPE-MIB.mib');
        try {
            fs.symlinkSync(outsidePath, escapePath);
            const escapeResponse = await getMibSource(null, { filePath: escapePath });
            assert.equal(escapeResponse.status, 'error');
            assert.match(escapeResponse.msg, /当前MIB编译工作区中不存在该文件/u);
        } catch (error) {
            if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                throw error;
            }
        }

        console.log('MIB source lazy-read IPC tests passed');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
