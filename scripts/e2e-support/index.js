const { bgpBrowserMockScript, BgpE2eController } = require('./bgp');
const { bmpBrowserMockScript, BmpE2eController } = require('./bmp');
const { featurePageBrowserMockScript } = require('./page-browser-mocks');
const { formatEvents, recordStep, setupFeaturePagesE2e, verifyPage } = require('./page-test-helper');
const { stringGeneratorBrowserMockScript } = require('./string-generator');

const browserMockScripts = Object.freeze({
    bgp: bgpBrowserMockScript,
    bmp: bmpBrowserMockScript,
    featurePages: featurePageBrowserMockScript,
    stringGenerator: stringGeneratorBrowserMockScript
});

function getBrowserMockScript(name) {
    const script = browserMockScripts[name];
    if (!script) {
        throw new Error('Unknown E2E browser mock script: ' + name);
    }
    return script;
}

module.exports = {
    BgpE2eController,
    BmpE2eController,
    formatEvents,
    getBrowserMockScript,
    recordStep,
    setupFeaturePagesE2e,
    verifyPage
};
