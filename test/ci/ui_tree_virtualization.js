'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');
const { compileScript, compileStyle, compileTemplate, parse } = require('@vue/compiler-sfc');

const projectRoot = path.resolve(process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.join(__dirname, '..', '..'));
const helperPath = path.join(projectRoot, 'src', 'ui', 'treeVirtualization.js');
const transformed = transformSync(fs.readFileSync(helperPath, 'utf8'), {
    format: 'cjs',
    loader: 'js',
    target: 'node16'
}).code;
const helperModule = new Module(helperPath, module);
helperModule.filename = helperPath;
helperModule.paths = Module._nodeModulePaths(path.dirname(helperPath));
helperModule._compile(transformed, helperPath);

const { resolveTreeVirtualScrollTop, resolveTreeVirtualWindow } = helperModule.exports;

const topWindow = resolveTreeVirtualWindow({
    itemCount: 1000,
    itemHeight: 24,
    viewportHeight: 240,
    scrollTop: 0,
    overscan: 3
});
assert.deepEqual(
    {
        start: topWindow.start,
        end: topWindow.end,
        beforeHeight: topWindow.beforeHeight,
        totalHeight: topWindow.totalHeight,
        maximumScrollTop: topWindow.maximumScrollTop
    },
    { start: 0, end: 13, beforeHeight: 0, totalHeight: 24_000, maximumScrollTop: 23_760 }
);

const middleWindow = resolveTreeVirtualWindow({
    itemCount: 1000,
    itemHeight: 24,
    viewportHeight: 240,
    scrollTop: 12_000,
    overscan: 3
});
assert.equal(middleWindow.start, 497);
assert.equal(middleWindow.end, 513);
assert.equal(middleWindow.beforeHeight, 497 * 24);
assert.equal(middleWindow.afterHeight, (1000 - 513) * 24);
assert.equal(middleWindow.end - middleWindow.start, 16, 'only viewport rows plus overscan are rendered');

const bottomWindow = resolveTreeVirtualWindow({
    itemCount: 1000,
    itemHeight: 24,
    viewportHeight: 240,
    scrollTop: Number.MAX_SAFE_INTEGER,
    overscan: 3
});
assert.equal(bottomWindow.scrollTop, 23_760);
assert.equal(bottomWindow.start, 987);
assert.equal(bottomWindow.end, 1000);
assert.equal(bottomWindow.afterHeight, 0);

const contractedWindow = resolveTreeVirtualWindow({
    itemCount: 8,
    itemHeight: 24,
    viewportHeight: 240,
    scrollTop: 23_760,
    overscan: 3
});
assert.equal(contractedWindow.scrollTop, 0, 'scroll position clamps when expansion state reduces the row count');
assert.equal(contractedWindow.start, 0);
assert.equal(contractedWindow.end, 8);

assert.equal(
    resolveTreeVirtualScrollTop({
        index: 5,
        itemCount: 1000,
        itemHeight: 24,
        viewportHeight: 240,
        currentScrollTop: 0
    }),
    0,
    'auto alignment leaves an already visible item in place'
);
assert.equal(
    resolveTreeVirtualScrollTop({
        index: 20,
        itemCount: 1000,
        itemHeight: 24,
        viewportHeight: 240,
        currentScrollTop: 0
    }),
    264,
    'auto alignment reveals an item below the viewport'
);
assert.equal(
    resolveTreeVirtualScrollTop({
        index: 20,
        itemCount: 1000,
        itemHeight: 24,
        viewportHeight: 240,
        currentScrollTop: 0,
        align: 'top',
        offset: 8
    }),
    472
);
assert.equal(
    resolveTreeVirtualScrollTop({
        index: 20,
        itemCount: 1000,
        itemHeight: 24,
        viewportHeight: 240,
        currentScrollTop: 0,
        align: 'bottom',
        offset: 8
    }),
    272
);
assert.equal(
    resolveTreeVirtualScrollTop({
        index: 999,
        itemCount: 1000,
        itemHeight: 24,
        viewportHeight: 240,
        currentScrollTop: 0,
        align: 'top'
    }),
    23_760,
    'scrollTo clamps alignment at the end of the tree'
);

const componentPath = path.join(projectRoot, 'src', 'ui', 'components', 'NnTree.vue');
const componentSource = fs.readFileSync(componentPath, 'utf8');
const parsed = parse(componentSource, { filename: componentPath });
assert.deepEqual(parsed.errors, []);
assert(parsed.descriptor.template);
assert(parsed.descriptor.scriptSetup);
assert(parsed.descriptor.styles.length > 0);
const compiledScript = compileScript(parsed.descriptor, { id: 'nn-tree-virtualization' });
const templateResult = compileTemplate({
    id: 'nn-tree-virtualization',
    filename: componentPath,
    source: parsed.descriptor.template.content,
    scoped: true,
    compilerOptions: { bindingMetadata: compiledScript.bindings }
});
assert.deepEqual(templateResult.errors, []);
const styleResult = compileStyle({
    id: 'data-v-nn-tree-virtualization',
    filename: componentPath,
    source: parsed.descriptor.styles[0].content,
    scoped: true
});
assert.deepEqual(styleResult.errors, []);
assert.match(
    parsed.descriptor.scriptSetup.content,
    /virtual:\s*\{[\s\S]*?default:\s*false/u,
    'virtual rendering must remain explicit opt-in'
);
assert.match(parsed.descriptor.template.content, /v-for="\(record, index\) in renderedNodes"/u);
assert.match(parsed.descriptor.template.content, /data-nn-tree-virtual-index/u);

console.log('NnTree virtual windowing tests passed');
