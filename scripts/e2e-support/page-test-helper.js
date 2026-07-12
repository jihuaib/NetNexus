const { expect } = require('@playwright/test');
const { FeaturePageE2eController } = require('./page-controller');
const { featurePageBrowserMockScript } = require('./page-browser-mocks');

async function setupFeaturePagesE2e(page) {
    const controller = new FeaturePageE2eController();
    await controller.init();
    let disposed = false;

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
        }
    };
}

async function recordStep(test, title) {
    await test.step(title, async () => {});
}

async function expectAnyTextVisible(page, text, options = {}) {
    const timeout = options.timeout || 10000;
    const locator = page.getByText(text);

    await expect
        .poll(
            async () => {
                const count = await locator.count();
                for (let index = 0; index < count; index += 1) {
                    if (await locator.nth(index).isVisible()) {
                        return true;
                    }
                }
                return false;
            },
            { timeout }
        )
        .toBe(true);
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
        await expectAnyTextVisible(page, pageCase.title, { timeout: 10000 });
        if (pageCase.expectText) {
            await expectAnyTextVisible(page, pageCase.expectText, { timeout: 10000 });
        }
        await page.waitForTimeout(100);
        await expect(
            page.locator('.nn-toast-error'),
            'error notifications after opening ' + pageCase.route
        ).toHaveCount(0);

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
    expectAnyTextVisible,
    verifyPage
};
