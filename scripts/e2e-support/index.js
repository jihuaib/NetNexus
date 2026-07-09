const { bgpBrowserMockScript, BgpE2eController } = require('./bgp');
const { bmpBrowserMockScript, BmpE2eController } = require('./bmp');
const { featurePageBrowserMockScript } = require('./page-browser-mocks');
const {
    expectAnyTextVisible,
    formatEvents,
    recordStep,
    setupFeaturePagesE2e,
    verifyPage
} = require('./page-test-helper');
const { rpkiBrowserMockScript, RpkiE2eController } = require('./rpki');
const { stringGeneratorBrowserMockScript } = require('./string-generator');

const browserMockScripts = Object.freeze({
    bgp: bgpBrowserMockScript,
    bmp: bmpBrowserMockScript,
    featurePages: featurePageBrowserMockScript,
    rpki: rpkiBrowserMockScript,
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
    expectAnyTextVisible,
    formatEvents,
    getBrowserMockScript,
    recordStep,
    RpkiE2eController,
    setupFeaturePagesE2e,
    verifyPage
};
