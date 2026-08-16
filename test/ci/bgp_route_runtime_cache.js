const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

function loadRuntimeController() {
    const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.join(__dirname, '..', '..'));
    const sourcePath = path.join(projectRoot, 'src', 'view', 'bgp', 'useBgpRouteRuntime.js');
    const result = esbuild.buildSync({
        entryPoints: [sourcePath],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        write: false,
        external: ['vue']
    });
    const compiled = result.outputFiles[0].text;
    const loaded = new Module(sourcePath, module);
    loaded.filename = sourcePath;
    loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
    loaded._compile(compiled, sourcePath);
    return loaded.exports.createBgpRouteRuntimeController;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

(async () => {
    const createController = loadRuntimeController();
    let refreshCount = 0;
    let clearCount = 0;
    const controller = createController({
        clearRoutes() {
            clearCount += 1;
        },
        async refreshRoutes() {
            refreshCount += 1;
        }
    });

    await controller.activate();
    assert.equal(refreshCount, 1, 'the first visit must load the route page');

    controller.deactivate();
    await controller.activate();
    assert.equal(refreshCount, 1, 'switching away and back must reuse the current BGP runtime cache');

    controller.runtimeChanged({ running: false });
    assert.equal(clearCount, 1, 'stopping BGP must clear cached routes immediately');
    controller.deactivate();
    await controller.activate();
    assert.equal(refreshCount, 1, 'switching tabs while BGP is stopped must not query routes again');

    controller.deactivate();
    controller.runtimeChanged({ running: true });
    assert.equal(clearCount, 2, 'starting a new BGP runtime must clear the previous runtime cache immediately');
    assert.equal(refreshCount, 1, 'an inactive route page must not query eagerly when BGP starts');
    await controller.activate();
    assert.equal(refreshCount, 2, 'the first visit in a new BGP runtime must reload once');

    controller.deactivate();
    await controller.activate();
    assert.equal(refreshCount, 2, 'later tab switches in the same runtime must remain query-free');

    await controller.runtimeChanged({ running: true });
    assert.equal(clearCount, 3, 'replacing an active BGP runtime must clear its cached routes before reloading');
    assert.equal(refreshCount, 3, 'an active page must reload once when a new BGP runtime starts');

    const firstRefresh = deferred();
    const secondRefresh = deferred();
    let pendingRefreshCount = 0;
    let pendingClearCount = 0;
    const pendingController = createController({
        clearRoutes() {
            pendingClearCount += 1;
        },
        refreshRoutes() {
            pendingRefreshCount += 1;
            return pendingRefreshCount === 1 ? firstRefresh.promise : secondRefresh.promise;
        }
    });

    const firstPending = pendingController.activate();
    const duplicateActivation = pendingController.activate();
    assert.strictEqual(duplicateActivation, firstPending, 'synchronous duplicate activation must share one refresh');
    await Promise.resolve();
    assert.equal(pendingRefreshCount, 1, 'synchronous duplicate activation must query routes once');

    pendingController.runtimeChanged({ running: false });
    assert.equal(pendingClearCount, 1, 'stopping must clear routes while the old refresh is pending');
    assert.strictEqual(
        pendingController.activate(),
        null,
        'a stopped runtime must detach activation from the old pending refresh'
    );
    const secondPending = pendingController.runtimeChanged({ running: true });
    assert.equal(pendingClearCount, 2, 'starting a new runtime must clear data left by pending old-runtime requests');
    await Promise.resolve();
    assert.equal(pendingRefreshCount, 2, 'a new runtime must start its own refresh after stopping');

    firstRefresh.resolve();
    await firstPending;
    assert.strictEqual(
        pendingController.activate(),
        secondPending,
        'the old refresh completion must not clear the new runtime refresh promise'
    );

    secondRefresh.resolve();
    await secondPending;
    pendingController.deactivate();
    await pendingController.activate();
    assert.equal(pendingRefreshCount, 2, 'tab switches after the new runtime load must remain query-free');

    console.log('BGP route runtime cache tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
