const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'electron', 'main.js'), 'utf8');
const splashSource = fs.readFileSync(path.join(projectRoot, 'electron', 'splash.html'), 'utf8');

const splashWindowStart = mainSource.indexOf('async function createSplashWindow()');
const splashWindowEnd = mainSource.indexOf('\nfunction getRendererUrl()', splashWindowStart);
assert.ok(
    splashWindowStart >= 0 && splashWindowEnd > splashWindowStart,
    'startup window factory must remain discoverable'
);

const splashWindowSource = mainSource.slice(splashWindowStart, splashWindowEnd);
assert.match(splashWindowSource, /transparent:\s*false/u, 'startup window must not use a transparent Windows layer');
assert.match(splashWindowSource, /backgroundColor:\s*SPLASH_BACKGROUND_COLOR/u);
assert.match(splashWindowSource, /show:\s*false/u, 'startup window must stay hidden until its first frame is ready');

const readyListenerIndex = splashWindowSource.indexOf("splash.once('ready-to-show'");
const loadIndex = splashWindowSource.indexOf('await splash.loadFile');
const readyAwaitIndex = splashWindowSource.indexOf('await readyToShow');
const showIndex = splashWindowSource.indexOf('splash.show();');
assert.ok(readyListenerIndex >= 0 && readyListenerIndex < loadIndex, 'ready-to-show must be observed before loading');
assert.ok(
    loadIndex < readyAwaitIndex && readyAwaitIndex < showIndex,
    'the first frame must be ready before showing splash'
);

assert.doesNotMatch(splashSource, /backdrop-filter\s*:/u, 'startup UI must avoid Windows blur composition layers');
assert.doesNotMatch(
    splashSource,
    /fadeIn(?:Down|Up)/u,
    'startup content must not remain on a half-transparent entrance-animation frame'
);
assert.match(
    splashSource,
    /background:\s*linear-gradient/u,
    'the opaque startup window must retain its own background'
);

const coreProgressIndex = mainSource.indexOf("updateSplashProgress(10, '正在加载核心组件...')");
const systemAppRequireIndex = mainSource.indexOf("require('./app/systemApp')", coreProgressIndex);
assert.ok(coreProgressIndex >= 0 && systemAppRequireIndex > coreProgressIndex);
assert.match(
    mainSource.slice(coreProgressIndex, systemAppRequireIndex),
    /await new Promise\(resolve => setImmediate\(resolve\)\)/u,
    'startup must yield once before synchronous protocol-module loading'
);

console.log('Startup splash stays opaque, crisp, and hidden until its first frame is ready');
