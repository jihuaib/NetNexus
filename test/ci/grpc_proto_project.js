const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

const { ProtoRegistry } = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'grpc', 'protoRegistry.js'));
const { ProtoProjectStore, PROJECT_MANIFEST_FILE, PROJECT_CACHE_FILE, PROJECT_PROTO_DIR } = require(
    path.join(__dirname, '..', '..', 'electron', 'worker', 'grpc', 'protoProjectStore.js')
);
const { GRPC_PROTO_PRESETS, GRPC_PROTO_TREE_KIND } = require(
    path.join(__dirname, '..', '..', 'electron', 'const', 'grpcConst.js')
);

const USER_PROTO = `syntax = "proto3";
package lab.ifm;
import "common/types.proto";
message Ifm {
  message Interfaces {
    message Interface {
      string ifName = 1;
      lab.common.Status status = 2;
    }
    repeated Interface interface = 1;
  }
  Interfaces interfaces = 1;
}
`;
const COMMON_PROTO = `syntax = "proto3";
package lab.common;
enum Status { DOWN = 0; UP = 1; }
`;

function withTempDir(callback) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netnexus-grpc-project-'));
    try {
        return callback(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function writeUserProtos(dir) {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(path.join(srcDir, 'common'), { recursive: true });
    const ifm = path.join(srcDir, 'lab-ifm.proto');
    fs.writeFileSync(ifm, USER_PROTO);
    fs.writeFileSync(path.join(srcDir, 'common', 'types.proto'), COMMON_PROTO);
    return { srcDir, ifm };
}

function huaweiFiles(registry) {
    const preset = GRPC_PROTO_PRESETS.find(item => item.id === 'huawei-dialout');
    return preset.files.map(name => registry.resolveBuiltinFile(name));
}

function testCacheRoundTrip() {
    withTempDir(dir => {
        const { ifm } = writeUserProtos(dir);
        const cacheFilePath = path.join(dir, 'cache', 'proto-cache.json');
        const registry = new ProtoRegistry();
        const filePaths = [...huaweiFiles(registry), ifm];

        registry.loadOrCompile({ filePaths, cacheFilePath });
        assert.strictEqual(registry.cacheHit, false);
        assert(fs.existsSync(cacheFilePath), 'cache file must be written');

        const restored = new ProtoRegistry();
        restored.loadOrCompile({ filePaths, cacheFilePath });
        assert.strictEqual(restored.cacheHit, true, 'unchanged sources must hit the cache');
        const status = restored.getStatus();
        assert.strictEqual(status.compiled, true);
        assert(
            status.files.some(file => file.name === 'types.proto' && !file.requested),
            'imports listed as loaded'
        );
        assert(
            status.files.some(file => file.builtin),
            'builtin files flagged'
        );
        assert(!('messages' in status), 'status must not carry the full message list');

        // 缓存恢复后仍可编解码、生成模板
        const buffer = restored.encodeMessage('lab.ifm.Ifm', {
            interfaces: { interface: [{ ifName: 'GE0/0/1', status: 'UP' }] }
        });
        const decoded = restored.decodeMessage('lab.ifm.Ifm', buffer).value;
        assert.strictEqual(decoded.interfaces.interface[0].status, 'UP');
        assert.deepStrictEqual(Object.keys(restored.createTemplate('lab.ifm.Ifm.Interfaces.Interface')), [
            'ifName',
            'status'
        ]);

        // 源文件变化 -> 缓存失效
        fs.appendFileSync(ifm, '\n// touched\n');
        const now = Date.now() / 1000 + 5;
        fs.utimesSync(ifm, now, now);
        const recompiled = new ProtoRegistry();
        recompiled.loadOrCompile({ filePaths, cacheFilePath });
        assert.strictEqual(recompiled.cacheHit, false, 'modified source must invalidate the cache');

        // force 编译跳过缓存
        const forced = new ProtoRegistry();
        forced.loadOrCompile({ filePaths, cacheFilePath, force: true });
        assert.strictEqual(forced.cacheHit, false);

        forced.clearCache(cacheFilePath);
        assert(!fs.existsSync(cacheFilePath));
        console.log('[gRPC project CI] cache round trip ok');
    });
}

function testLazyTree() {
    withTempDir(dir => {
        const { ifm } = writeUserProtos(dir);
        const registry = new ProtoRegistry();
        registry.compile({ filePaths: [...huaweiFiles(registry), ifm] });

        const roots = registry.getTreeChildren('');
        assert.deepStrictEqual(
            roots.map(node => node.key),
            ['pkg:huawei_dialout', 'pkg:lab.common', 'pkg:lab.ifm', 'pkg:telemetry']
        );
        assert(roots.every(node => node.kind === GRPC_PROTO_TREE_KIND.PACKAGE && !node.isLeaf));

        const dialout = registry.getTreeChildren('pkg:huawei_dialout');
        assert.deepStrictEqual(
            dialout.map(node => [node.key, node.kind]),
            [
                ['svc:huawei_dialout.gRPCDataservice', GRPC_PROTO_TREE_KIND.SERVICE],
                ['msg:huawei_dialout.serviceArgs', GRPC_PROTO_TREE_KIND.MESSAGE]
            ]
        );
        const methods = registry.getTreeChildren('svc:huawei_dialout.gRPCDataservice');
        assert.strictEqual(methods.length, 1);
        assert.strictEqual(methods[0].methodKind, 'bidi-stream');
        assert.strictEqual(methods[0].isLeaf, true);

        const ifmChildren = registry.getTreeChildren('msg:lab.ifm.Ifm');
        assert.deepStrictEqual(
            ifmChildren.map(node => node.key),
            ['msg:lab.ifm.Ifm.Interfaces', 'field:lab.ifm.Ifm#interfaces'],
            'nested messages come before fields'
        );
        const fields = registry.getTreeChildren('msg:huawei_dialout.serviceArgs');
        assert.strictEqual(fields.find(node => node.title === 'data').oneof, 'MessageData');
        assert(fields.find(node => node.title === 'ReqId').meta.includes('int64'));

        const enumValues = registry.getTreeChildren('enum:lab.common.Status');
        assert.deepStrictEqual(
            enumValues.map(node => node.title),
            ['DOWN', 'UP']
        );

        const node = registry.getTreeNode('lab.ifm.Ifm.Interfaces.Interface');
        assert.strictEqual(node.node.key, 'msg:lab.ifm.Ifm.Interfaces.Interface');
        assert.deepStrictEqual(node.treePath, ['pkg:lab.ifm', 'msg:lab.ifm.Ifm', 'msg:lab.ifm.Ifm.Interfaces']);
        assert.strictEqual(node.detail.fields.length, 2);

        const field = registry.getTreeNode('field:lab.ifm.Ifm.Interfaces.Interface#status');
        assert.strictEqual(field.detail.typeText, 'lab.common.Status');
        assert.strictEqual(field.detail.resolvedKind, 'enum');

        const method = registry.getTreeNode('huawei_dialout.gRPCDataservice.dataPublish');
        assert.strictEqual(method.node.kind, GRPC_PROTO_TREE_KIND.METHOD);
        assert.strictEqual(method.detail.path, '/huawei_dialout.gRPCDataservice/dataPublish');

        assert.throws(() => registry.getTreeNode('nope.Missing'), /节点不存在/u);
        console.log('[gRPC project CI] lazy tree ok');
    });
}

function testProjectSaveImportExport() {
    withTempDir(dir => {
        const { ifm } = writeUserProtos(dir);
        const rootDir = path.join(dir, 'projects');
        const cacheFilePath = path.join(dir, 'proto-cache.json');
        const registry = new ProtoRegistry();
        const store = new ProtoProjectStore(registry);

        assert.throws(() => store.save({ name: 'x', rootDir, cacheFilePath }), /请先导入并编译/u);
        registry.loadOrCompile({ filePaths: [...huaweiFiles(registry), ifm], cacheFilePath });

        const saved = store.save({ name: 'lab ifm/dialout', rootDir, cacheFilePath });
        assert.strictEqual(saved.project.name, 'lab ifm_dialout');
        const projectDir = saved.project.directory;
        assert(fs.existsSync(path.join(projectDir, PROJECT_MANIFEST_FILE)));
        assert(fs.existsSync(path.join(projectDir, PROJECT_CACHE_FILE)), 'project carries its own cache');
        assert(fs.existsSync(path.join(projectDir, PROJECT_PROTO_DIR, 'lab-ifm.proto')));
        assert(
            fs.existsSync(path.join(projectDir, PROJECT_PROTO_DIR, 'common', 'types.proto')),
            'import directory structure preserved'
        );
        assert(
            fs.existsSync(path.join(projectDir, PROJECT_PROTO_DIR, 'huawei-telemetry.proto')),
            'builtin template files are copied so the project is self-contained'
        );
        const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, PROJECT_MANIFEST_FILE), 'utf8'));
        assert.strictEqual(manifest.fileCount, 4);
        assert(
            manifest.requestedFiles.every(file => !path.isAbsolute(file)),
            'manifest paths are relative'
        );
        assert(manifest.services.includes('huawei_dialout.gRPCDataservice'));

        assert.throws(() => store.save({ name: 'lab ifm/dialout', rootDir, cacheFilePath }), /工程名已存在/u);

        const listed = store.list({ rootDir });
        assert.strictEqual(listed.projects.length, 1);
        assert.strictEqual(listed.projects[0].name, 'lab ifm_dialout');
        assert.deepStrictEqual(store.list({ rootDir: path.join(dir, 'none') }).projects, []);

        // 删除原始源文件后仍能从工程导入（工程自包含）
        fs.rmSync(path.join(dir, 'src'), { recursive: true, force: true });
        const fresh = new ProtoRegistry();
        const freshStore = new ProtoProjectStore(fresh);
        const imported = freshStore.import({ name: 'lab ifm_dialout', rootDir, cacheFilePath });
        assert.strictEqual(fresh.isCompiled(), true);
        assert.strictEqual(fresh.cacheHit, true, 'project cache must be reused on import');
        assert(imported.filePaths.every(file => fs.existsSync(file)));
        assert(imported.filePaths.some(file => file.startsWith(projectDir)));
        assert(imported.includeDirs.includes(path.join(projectDir, PROJECT_PROTO_DIR)));
        assert(fresh.tryLookupType('lab.ifm.Ifm.Interfaces.Interface'));
        assert(fresh.tryLookupType('telemetry.Telemetry'), 'copied template files resolved on import');

        // 导出到任意目录，再从该目录导入到另一个工程根
        const exportDir = path.join(dir, 'exported');
        fs.mkdirSync(exportDir);
        const exported = freshStore.export({ name: 'lab ifm_dialout', rootDir, targetDir: exportDir });
        assert(fs.existsSync(path.join(exported.directory, PROJECT_MANIFEST_FILE)));
        assert.throws(() => freshStore.export({ name: 'lab ifm_dialout', rootDir, targetDir: exportDir }), /已存在/u);

        const otherRoot = path.join(dir, 'other-projects');
        const other = new ProtoRegistry();
        const otherStore = new ProtoProjectStore(other);
        const external = otherStore.import({ directory: exported.directory, rootDir: otherRoot, cacheFilePath: '' });
        assert.strictEqual(external.project.name, 'lab ifm_dialout');
        assert(fs.existsSync(path.join(otherRoot, 'lab ifm_dialout', PROJECT_MANIFEST_FILE)));
        assert.strictEqual(other.getTreeNode('lab.common.Status').node.kind, GRPC_PROTO_TREE_KIND.ENUM);
        assert(other.tryLookupType('lab.ifm.Ifm'));

        const removed = freshStore.remove({ name: 'lab ifm_dialout', rootDir });
        assert.strictEqual(removed.name, 'lab ifm_dialout');
        assert.strictEqual(store.list({ rootDir }).projects.length, 0);
        assert.throws(() => freshStore.import({ name: 'lab ifm_dialout', rootDir, cacheFilePath }), /工程清单不存在/u);
        console.log('[gRPC project CI] project save/import/export ok');
    });
}

testCacheRoundTrip();
testLazyTree();
testProjectSaveImportExport();
console.log('gRPC proto project test passed');
