const base = require('@playwright/test');

function observePageDiagnostics(page) {
    const pageErrors = [];
    const consoleErrors = [];

    page.on('pageerror', error => {
        pageErrors.push(error.message);
    });
    page.on('console', message => {
        if (message.type() === 'error') {
            consoleErrors.push(message.text());
        }
    });

    return () => {
        base.expect(pageErrors, 'uncaught page errors').toEqual([]);
        base.expect(consoleErrors, 'browser console errors').toEqual([]);
    };
}

if (process.env.E2E_TARGET === 'browser') {
    const test = base.test.extend({
        page: async ({ page }, use) => {
            const assertClean = observePageDiagnostics(page);
            await use(page);
            assertClean();
        }
    });

    module.exports = {
        test,
        expect: base.expect
    };
} else {
    const { _electron: electron } = require('playwright');
    const { findPackagedElectronExecutable, projectRoot } = require('./packaged-app');

    function toAppUrl(appBaseUrl, url) {
        if (typeof url !== 'string') {
            return url;
        }

        if (url.startsWith('/#/')) {
            return `${appBaseUrl}#/${url.slice(3)}`;
        }

        if (url === '/') {
            return appBaseUrl;
        }

        return url;
    }

    function patchGoto(page, appBaseUrl) {
        const originalGoto = page.goto.bind(page);

        page.goto = (url, options) => originalGoto(toAppUrl(appBaseUrl, url), options);
    }

    async function waitForMainWindow(electronApp) {
        const page = await electronApp.firstWindow({ timeout: 60000 });
        await page.waitForLoadState('domcontentloaded');
        return page;
    }

    async function closeElectronApp(electronApp) {
        const processHandle = electronApp.process();
        const closePromise = electronApp.waitForEvent('close', { timeout: 5000 }).catch(() => {});

        try {
            await electronApp.evaluate(({ app }) => app.exit(0));
            await closePromise;
        } catch (_error) {
            try {
                processHandle.kill('SIGKILL');
            } catch (_killError) {
                // The process may already be gone.
            }
        }
    }

    const test = base.test.extend({
        electronApp: async ({}, use, testInfo) => {
            const executablePath = findPackagedElectronExecutable();
            const testTitle = Array.isArray(testInfo.titlePath)
                ? testInfo.titlePath.join(' > ')
                : testInfo.title || 'unknown e2e test';
            const appEnvironment = { ...process.env };
            delete appEnvironment.ELECTRON_RUN_AS_NODE;

            const electronApp = await electron.launch({
                executablePath,
                cwd: projectRoot,
                env: {
                    ...appEnvironment,
                    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
                    NETNEXUS_E2E: '1',
                    NETNEXUS_E2E_TEST: testTitle
                }
            });

            try {
                await use(electronApp);
            } finally {
                await closeElectronApp(electronApp);
            }
        },

        page: async ({ electronApp }, use) => {
            const page = await waitForMainWindow(electronApp);
            const assertClean = observePageDiagnostics(page);
            const appBaseUrl = page.url().split('#')[0];
            patchGoto(page, appBaseUrl);
            await page.goto('about:blank');
            await use(page);
            assertClean();
        }
    });

    module.exports = {
        test,
        expect: base.expect
    };
}
