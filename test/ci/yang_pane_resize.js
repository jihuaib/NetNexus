'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');

const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.join(__dirname, '..', '..'));
const sourcePath = path.join(projectRoot, 'src', 'view', 'yang', 'usePaneResize.js');
const operationsPath = path.join(projectRoot, 'src', 'view', 'yang', 'YangOperations.vue');
const workspacePath = path.join(projectRoot, 'src', 'view', 'yang', 'YangWorkspace.vue');
const modulesPath = path.join(projectRoot, 'src', 'view', 'yang', 'YangModules.vue');
const mountedCallbacks = [];
const beforeUnmountCallbacks = [];
const vueStub = {
    nextTick(callback) {
        callback?.();
        return Promise.resolve();
    },
    onMounted(callback) {
        mountedCallbacks.push(callback);
    },
    onBeforeUnmount(callback) {
        beforeUnmountCallbacks.push(callback);
    },
    ref(value) {
        return { value };
    }
};

const transformed = transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    format: 'cjs',
    loader: 'js',
    target: 'node16'
}).code;
const paneResizeModule = new Module(sourcePath, module);
paneResizeModule.filename = sourcePath;
paneResizeModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
const originalModuleLoad = Module._load;
Module._load = function loadWithVueStub(request, parent, isMain) {
    if (request === 'vue' && parent?.filename === sourcePath) return vueStub;
    return originalModuleLoad.call(this, request, parent, isMain);
};
try {
    paneResizeModule._compile(transformed, sourcePath);
} finally {
    Module._load = originalModuleLoad;
}

const { usePaneResize } = paneResizeModule.exports;

const createListeners = () => {
    const listeners = new Map();
    return {
        add(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        remove(type, listener) {
            listeners.get(type)?.delete(listener);
        },
        dispatch(type, event = {}) {
            for (const listener of [...(listeners.get(type) || [])]) listener({ ...event, type });
        },
        count(type) {
            return listeners.get(type)?.size || 0;
        }
    };
};

const createStyle = () => {
    const properties = new Map();
    return {
        cursor: '',
        userSelect: '',
        setProperty(name, value) {
            properties.set(name, String(value));
        },
        getPropertyValue(name) {
            return properties.get(name) || '';
        }
    };
};

const documentListeners = createListeners();
const windowListeners = createListeners();
const animationFrames = new Map();
const cancelledFrames = [];
let nextAnimationFrameId = 1;
const fakeDocument = {
    body: { style: createStyle() },
    addEventListener: documentListeners.add,
    removeEventListener: documentListeners.remove
};
const fakeWindow = {
    addEventListener: windowListeners.add,
    removeEventListener: windowListeners.remove,
    requestAnimationFrame(callback) {
        const id = nextAnimationFrameId;
        nextAnimationFrameId += 1;
        animationFrames.set(id, callback);
        return id;
    },
    cancelAnimationFrame(id) {
        cancelledFrames.push(id);
        animationFrames.delete(id);
    }
};
const resizeObservers = [];
class FakeResizeObserver {
    constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        resizeObservers.push(this);
    }

    observe(target) {
        this.target = target;
    }

    disconnect() {
        this.disconnected = true;
    }
}

const previousDocument = global.document;
const previousWindow = global.window;
const previousResizeObserver = global.ResizeObserver;
global.document = fakeDocument;
global.window = fakeWindow;
global.ResizeObserver = FakeResizeObserver;

const flushAnimationFrames = () => {
    const pending = [...animationFrames.entries()];
    animationFrames.clear();
    pending.forEach(([, callback]) => callback());
};
const pointerEvent = overrides => ({
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: 500,
    clientY: 300,
    preventDefault() {},
    ...overrides
});
const createContainer = () => {
    let rect = { left: 100, right: 900, top: 50, bottom: 650, width: 800, height: 600 };
    let rectReads = 0;
    const style = createStyle();
    return {
        ref: {
            value: {
                style,
                getBoundingClientRect() {
                    rectReads += 1;
                    return { ...rect };
                }
            }
        },
        style,
        rectReads: () => rectReads,
        setRect(nextRect) {
            rect = { ...rect, ...nextRect };
        }
    };
};

try {
    const optimizedContainer = createContainer();
    const optimizedUnmountIndex = beforeUnmountCallbacks.length;
    const optimized = usePaneResize({
        containerRef: optimizedContainer.ref,
        orientation: 'horizontal',
        defaultRatio: 0.5,
        minFirst: 260,
        minSecond: 200,
        dividerSize: 8,
        frameSynchronized: true,
        previewStyleProperty: '--request-pane-height'
    });

    optimized.startResize(pointerEvent({ pointerId: 11, clientY: 300 }));
    assert.equal(optimizedContainer.rectReads(), 1, 'optimized drag must cache the container rect at pointerdown');
    assert.equal(optimized.paneSize.value, 296);
    assert.equal(optimizedContainer.style.getPropertyValue('--request-pane-height'), '296px');
    assert.equal(animationFrames.size, 1);

    documentListeners.dispatch('pointermove', pointerEvent({ pointerId: 11, clientY: 320 }));
    documentListeners.dispatch('pointermove', pointerEvent({ pointerId: 11, clientY: 360 }));
    documentListeners.dispatch('pointermove', pointerEvent({ pointerId: 11, clientY: 400 }));
    assert.equal(animationFrames.size, 1, 'multiple pointer moves must share one animation frame');
    assert.equal(optimizedContainer.rectReads(), 1, 'pointer moves must reuse the pointerdown rect');
    assert.equal(optimized.paneSize.value, 296, 'DOM preview must not invalidate Vue state during drag');
    assert.equal(optimizedContainer.style.getPropertyValue('--request-pane-height'), '296px');

    flushAnimationFrames();
    assert.equal(optimizedContainer.style.getPropertyValue('--request-pane-height'), '346px');
    assert.equal(optimized.paneSize.value, 296, 'the frame preview must stay outside Vue reactivity');

    documentListeners.dispatch('pointerup', pointerEvent({ pointerId: 11, clientY: 420 }));
    assert.equal(optimized.paneSize.value, 366, 'pointerup must commit its final coordinate');
    assert.equal(optimizedContainer.style.getPropertyValue('--request-pane-height'), '366px');
    assert.equal(optimized.resizing.value, false);
    assert.equal(documentListeners.count('pointermove'), 0);
    assert.equal(fakeDocument.body.style.cursor, '');

    optimized.startResize(pointerEvent({ pointerId: 12, clientY: 300 }));
    documentListeners.dispatch('pointermove', pointerEvent({ pointerId: 12, clientY: 380 }));
    const pendingCancelFrame = [...animationFrames.keys()][0];
    documentListeners.dispatch('pointercancel', pointerEvent({ pointerId: 12, clientY: 640 }));
    assert(cancelledFrames.includes(pendingCancelFrame), 'pointercancel must cancel its queued animation frame');
    assert.equal(animationFrames.size, 0);
    assert.equal(optimized.paneSize.value, 326, 'pointercancel must retain the last accepted pointer move');

    optimized.startResize(pointerEvent({ pointerId: 13, clientY: 300 }));
    documentListeners.dispatch('pointermove', pointerEvent({ pointerId: 13, clientY: 410 }));
    const pendingUnmountFrame = [...animationFrames.keys()][0];
    beforeUnmountCallbacks[optimizedUnmountIndex]();
    assert(cancelledFrames.includes(pendingUnmountFrame), 'unmount must cancel its queued drag frame');
    assert.equal(animationFrames.size, 0);
    assert.equal(optimized.paneSize.value, 356);

    const legacyContainer = createContainer();
    const legacy = usePaneResize({
        containerRef: legacyContainer.ref,
        orientation: 'horizontal',
        defaultRatio: 0.5,
        minFirst: 260,
        minSecond: 200,
        dividerSize: 8,
        previewStyleProperty: '--must-not-be-used-without-opt-in'
    });
    legacy.startResize(pointerEvent({ pointerId: 21, clientY: 300 }));
    assert.equal(legacyContainer.rectReads(), 2, 'the default path must preserve the original synchronous reads');
    assert.equal(legacy.paneSize.value, 260);
    assert.equal(animationFrames.size, 0, 'the default path must not schedule animation frames');
    assert.equal(legacyContainer.style.getPropertyValue('--must-not-be-used-without-opt-in'), '');
    documentListeners.dispatch('pointermove', pointerEvent({ pointerId: 21, clientY: 360 }));
    documentListeners.dispatch('pointermove', pointerEvent({ pointerId: 21, clientY: 390 }));
    assert.equal(legacy.paneSize.value, 336, 'the default path must update synchronously on every pointer move');
    assert.equal(legacyContainer.rectReads(), 4);
    documentListeners.dispatch('pointerup', pointerEvent({ pointerId: 21, clientY: 420 }));
    assert.equal(legacy.paneSize.value, 336, 'the default path must preserve the original pointerup behavior');

    const requestAnimationFrame = fakeWindow.requestAnimationFrame;
    const cancelAnimationFrame = fakeWindow.cancelAnimationFrame;
    fakeWindow.requestAnimationFrame = undefined;
    fakeWindow.cancelAnimationFrame = undefined;
    const fallbackContainer = createContainer();
    const fallback = usePaneResize({
        containerRef: fallbackContainer.ref,
        orientation: 'horizontal',
        defaultRatio: 0.5,
        minFirst: 260,
        minSecond: 200,
        dividerSize: 8,
        frameSynchronized: true,
        previewStyleProperty: '--fallback-pane-height'
    });
    fallback.startResize(pointerEvent({ pointerId: 31, clientY: 300 }));
    documentListeners.dispatch('pointermove', pointerEvent({ pointerId: 31, clientY: 400 }));
    assert.equal(fallbackContainer.rectReads(), 1);
    assert.equal(fallbackContainer.style.getPropertyValue('--fallback-pane-height'), '346px');
    documentListeners.dispatch('pointerup', pointerEvent({ pointerId: 31, clientY: 410 }));
    assert.equal(fallback.paneSize.value, 356, 'missing RAF must fall back without losing the final size');
    fakeWindow.requestAnimationFrame = requestAnimationFrame;
    fakeWindow.cancelAnimationFrame = cancelAnimationFrame;

    const observedContainer = createContainer();
    const observedMountIndex = mountedCallbacks.length;
    const observedUnmountIndex = beforeUnmountCallbacks.length;
    const observed = usePaneResize({
        containerRef: observedContainer.ref,
        orientation: 'horizontal',
        defaultRatio: 0.5,
        minFirst: 260,
        minSecond: 200,
        dividerSize: 8,
        frameSynchronized: true,
        previewStyleProperty: '--observed-pane-height'
    });
    mountedCallbacks[observedMountIndex]();
    const observer = resizeObservers[resizeObservers.length - 1];
    assert.equal(observedContainer.rectReads(), 1);
    observer.callback([{ contentRect: { width: 800, height: 600 } }]);
    assert.equal(animationFrames.size, 1);
    flushAnimationFrames();
    assert.equal(observedContainer.rectReads(), 1, 'ResizeObserver contentRect must avoid another layout read');
    observer.callback([{ contentRect: { width: 720, height: 600 } }]);
    assert.equal(animationFrames.size, 0, 'a width-only resize must not update a horizontal splitter');
    observer.callback([{ contentRect: { width: 720, height: 620 } }]);
    assert.equal(animationFrames.size, 1);
    flushAnimationFrames();
    assert.equal(observed.maxSize.value, 412);
    assert.equal(observedContainer.rectReads(), 1);

    observedContainer.setRect({ bottom: 680, height: 630 });
    windowListeners.dispatch('resize');
    observer.callback([{ contentRect: { width: 720, height: 630 } }]);
    assert.equal(animationFrames.size, 1, 'window and observer updates must share one bounds frame');
    flushAnimationFrames();
    assert.equal(observedContainer.rectReads(), 2, 'the shared window frame may measure the final viewport once');
    beforeUnmountCallbacks[observedUnmountIndex]();
    assert.equal(observer.disconnected, true);

    const operationsSource = fs.readFileSync(operationsPath, 'utf8');
    const workspaceSource = fs.readFileSync(workspacePath, 'utf8');
    const modulesSource = fs.readFileSync(modulesPath, 'utf8');
    assert.equal(
        (operationsSource.match(/frameSynchronized:\s*true/gu) || []).length,
        2,
        'both embedded workspace splitters must opt in'
    );
    assert.match(operationsSource, /previewStyleProperty:\s*'--request-pane-height'/u);
    assert.match(operationsSource, /previewStyleProperty:\s*'--parameter-pane-width'/u);
    assert.equal(
        (workspaceSource.match(/frameSynchronized:\s*true/gu) || []).length,
        1,
        'the outer Schema workspace splitter must opt in'
    );
    assert.match(workspaceSource, /previewStyleProperty:\s*'--schema-pane-width'/u);
    assert.equal(
        (modulesSource.match(/frameSynchronized:\s*true/gu) || []).length,
        1,
        'the compile log splitter must coalesce pointer updates'
    );
    assert.match(modulesSource, /previewStyleProperty:\s*'--compile-log-preview-height'/u);
} finally {
    global.document = previousDocument;
    global.window = previousWindow;
    global.ResizeObserver = previousResizeObserver;
}

console.log('YANG pane resize scheduling tests passed');
