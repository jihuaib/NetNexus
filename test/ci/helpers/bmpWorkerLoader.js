const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

function patchBmpWorkerSource(source) {
    const sourcePatched = source.replace(/new BmpWorker\(\);\s*\/\/ 启动监听\s*$/u, 'module.exports = BmpWorker;');
    if (sourcePatched !== source) {
        return sourcePatched;
    }

    const minifiedAliasPatched = source.replace(
        /m\(([$A-Z_a-z][\w$]*),"BmpWorker"\);let BmpWorker=\1;new BmpWorker;?\s*$/u,
        (_match, classRef) => `m(${classRef},"BmpWorker");let BmpWorker=${classRef};module.exports=BmpWorker;`
    );
    if (minifiedAliasPatched !== source) {
        return minifiedAliasPatched;
    }

    const minifiedPatched = source.replace(/m\(([$A-Z_a-z][\w$]*),"BmpWorker"\);new \1;?\s*$/u, (_match, classRef) => {
        return `m(${classRef},"BmpWorker");module.exports=${classRef};`;
    });
    if (minifiedPatched !== source) {
        return minifiedPatched;
    }

    return source;
}

function loadBmpWorkerClass(testDir, parentModule) {
    const filePath = path.join(testDir, '..', '..', 'electron', 'worker', 'bmp', 'bmpWorker.js');
    const source = fs.readFileSync(filePath, 'utf8');
    const patched = patchBmpWorkerSource(source);
    assert.notStrictEqual(patched, source, 'failed to patch bmpWorker.js auto-start line for CI loading');

    const mod = new Module(filePath, parentModule || module);
    mod.filename = filePath;
    mod.paths = Module._nodeModulePaths(path.dirname(filePath));
    mod._compile(patched, filePath);
    return mod.exports;
}

module.exports = {
    loadBmpWorkerClass
};
