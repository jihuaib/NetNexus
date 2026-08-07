const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = process.env.NETNEXUS_SOURCE_PROJECT_ROOT || path.join(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'electron', 'main.js'), 'utf8');
const splashSource = fs.readFileSync(path.join(projectRoot, 'electron', 'splash.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(projectRoot, 'src', 'main.js'), 'utf8');

const focusWindowStart = mainSource.indexOf('function focusAvailableWindow()');
const focusWindowEnd = mainSource.indexOf('\nasync function createSplashWindow()', focusWindowStart);
assert.ok(focusWindowStart >= 0 && focusWindowEnd > focusWindowStart, 'window focus helper must remain discoverable');
const focusWindowSource = mainSource.slice(focusWindowStart, focusWindowEnd);
assert.match(
    focusWindowSource,
    /if \(splashReadyToShow\)\s*\{[\s\S]*?splashWindow\.show\(\)/u,
    'a second launch must not show the splash before its first frame is ready'
);

const splashWindowStart = mainSource.indexOf('async function createSplashWindow()');
const splashWindowEnd = mainSource.indexOf('\nfunction getRendererUrl()', splashWindowStart);
assert.ok(
    splashWindowStart >= 0 && splashWindowEnd > splashWindowStart,
    'startup window factory must remain discoverable'
);

const splashWindowSource = mainSource.slice(splashWindowStart, splashWindowEnd);
assert.match(splashWindowSource, /transparent:\s*false/u, 'startup window must not use a transparent Windows layer');
assert.match(splashWindowSource, /backgroundColor:\s*SPLASH_BACKGROUND_COLOR/u);
assert.match(splashWindowSource, /const showImmediately = process\.platform === 'win32'/u);
assert.match(
    splashWindowSource,
    /show:\s*showImmediately/u,
    'Windows must expose the native splash background while Chromium prepares its first frame'
);

const readyListenerIndex = splashWindowSource.indexOf("splash.once('ready-to-show'");
const loadIndex = splashWindowSource.indexOf('await splash.loadFile');
const readyAwaitIndex = splashWindowSource.indexOf('await readyToShow');
const showIndex = splashWindowSource.indexOf('splash.show();');
assert.ok(readyListenerIndex >= 0 && readyListenerIndex < loadIndex, 'ready-to-show must be observed before loading');
assert.ok(
    loadIndex < readyAwaitIndex && readyAwaitIndex < showIndex,
    'the first frame must be ready before showing splash'
);
assert.ok(
    showIndex < splashWindowSource.indexOf('await waitForVisibleWindowFrame(splash)'),
    'the splash must wait for a visible renderer frame after showing'
);
assert.ok(
    splashWindowSource.indexOf('await waitForVisibleWindowFrame(splash)') <
        splashWindowSource.indexOf('splashReadyToShow = !splash.isDestroyed()'),
    'the splash may only be refocused after its visible frame has been submitted'
);
assert.match(
    splashWindowSource,
    /executeJavaScript\([\s\S]*?requestAnimationFrame\(\(\) => requestAnimationFrame\(resolve\)\)/u,
    'splash readiness must cross a full animation frame while the native window is visible'
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
assert.ok(
    splashWindowSource.indexOf('await waitForVisibleWindowFrame(splash)') <
        splashWindowSource.indexOf('return splash;'),
    'synchronous protocol-module loading must start only after the visible splash frame is ready'
);

const finishStartupStart = mainSource.indexOf('function finishStartup()');
const finishStartupEnd = mainSource.indexOf('\nasync function startApplication()', finishStartupStart);
assert.ok(finishStartupStart >= 0 && finishStartupEnd > finishStartupStart, 'startup handoff must remain discoverable');
const finishStartupSource = mainSource.slice(finishStartupStart, finishStartupEnd);
assert.ok(
    finishStartupSource.indexOf('mainWindow.show();') < finishStartupSource.indexOf('splashWindow.destroy();'),
    'the painted main window must be shown behind the splash before the splash is destroyed'
);

const paintWaitIndex = rendererSource.indexOf('await waitForPaint();');
const rendererReadyIndex = rendererSource.indexOf('window.commonApi?.notifyRendererReady?.();');
assert.ok(
    paintWaitIndex >= 0 && paintWaitIndex < rendererReadyIndex,
    'renderer readiness must wait for a painted frame'
);
assert.match(
    rendererSource,
    /requestAnimationFrame\(\(\) => requestAnimationFrame\(resolve\)\)/u,
    'renderer readiness must cross a full animation frame before notifying the main process'
);

console.log('Startup windows stay painted throughout the splash-to-main handoff');
