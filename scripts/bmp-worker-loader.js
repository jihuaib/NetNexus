const fs = require('fs');
const Module = require('module');
const path = require('path');

function patchBmpWorkerSource(source) {
    const sourcePatched = source.replace(/new BmpWorker\(\);\s*(?:\/\/ 启动监听)?\s*$/u, 'module.exports = BmpWorker;');
    if (sourcePatched !== source) {
        return sourcePatched;
    }

    const minifiedAliasPatched = source.replace(
        /([$A-Z_a-z][\w$]*)\(([$A-Z_a-z][\w$]*),"BmpWorker"\);let BmpWorker=\2;new BmpWorker;?\s*$/u,
        (_match, keepNameHelper, classRef) =>
            `${keepNameHelper}(${classRef},"BmpWorker");let BmpWorker=${classRef};module.exports=BmpWorker;`
    );
    if (minifiedAliasPatched !== source) {
        return minifiedAliasPatched;
    }

    const minifiedPatched = source.replace(
        /([$A-Z_a-z][\w$]*)\(([$A-Z_a-z][\w$]*),"BmpWorker"\);new \2;?\s*$/u,
        (_match, keepNameHelper, classRef) => `${keepNameHelper}(${classRef},"BmpWorker");module.exports=${classRef};`
    );
    if (minifiedPatched !== source) {
        return minifiedPatched;
    }

    return source;
}

function loadBmpWorkerClassFromFile(filePath, parentModule, label = 'BMP worker') {
    const source = fs.readFileSync(filePath, 'utf8');
    const patched = patchBmpWorkerSource(source);

    if (patched === source) {
        const sourceTail = source.slice(-240).replace(/\s+/g, ' ');
        throw new Error(`failed to patch bmpWorker.js auto-start line for ${label}: ${filePath}; tail=${sourceTail}`);
    }

    const mod = new Module(filePath, parentModule || module);
    mod.filename = filePath;
    mod.paths = Module._nodeModulePaths(path.dirname(filePath));
    mod._compile(patched, filePath);
    return mod.exports;
}

module.exports = {
    loadBmpWorkerClassFromFile,
    patchBmpWorkerSource
};
