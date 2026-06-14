const { expect } = require('@playwright/test');
const { FeaturePageE2eController } = require('./page-controller');
const { featurePageBrowserMockScript } = require('./page-browser-mocks');

async function setupFeaturePagesE2e(page) {
    const controller = new FeaturePageE2eController();
    await controller.init();
    const pageErrors = [];
    let disposed = false;

    page.on('pageerror', error => {
        pageErrors.push(error.message);
    });

    await page.exposeFunction('__featureE2eCall', (method, ...args) => controller.call(method, ...args));
    controller.onEvent(event => {
        if (disposed) return;
        page.evaluate(({ type, data }) => window.__featureE2eEmit?.(type, data), event).catch(() => {});
    });

    await page.addInitScript({ content: featurePageBrowserMockScript });

    return {
        controller,
        async cleanup() {
            disposed = true;
            await controller.cleanup();
            expect(pageErrors).toEqual([]);
        }
    };
}

async function recordStep(test, title) {
    await test.step(title, async () => {});
}

function formatEvents(events) {
    return events
        .map(event => event.event + (event.command ? ' ' + event.command : '') + (event.line ? ' ' + event.line : ''))
        .join(' -> ');
}

async function verifyPage(test, page, pageCase) {
    await test.step('Verify ' + pageCase.route, async () => {
        await recordStep(test, 'Input: route=' + pageCase.route + ', mockData=enabled');

        await page.goto(pageCase.route);
        await expect(page.getByText(pageCase.title).first()).toBeVisible({ timeout: 10000 });
        if (pageCase.expectText) {
            await expect(page.getByText(pageCase.expectText).first()).toBeVisible({ timeout: 10000 });
        }

        await recordStep(
            test,
            'Output: title="' +
                pageCase.title +
                '" visible=true' +
                (pageCase.expectText ? ', expectedText="' + pageCase.expectText + '" visible=true' : '')
        );
    });
}

module.exports = {
    formatEvents,
    recordStep,
    setupFeaturePagesE2e,
    verifyPage
};
