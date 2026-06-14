const { test, expect } = require('@playwright/test');
const { getBrowserMockScript } = require('../../scripts/e2e-support');

async function recordStep(title) {
    await test.step(title, async () => {});
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript({ content: getBrowserMockScript('stringGenerator') });
});

test('generates strings from form input and sends the expected API payload', async ({ page }) => {
    await test.step('Open the string generator page', async () => {
        await recordStep('Input: route=/#/tools/string-generator');

        await page.goto('/#/tools/string-generator');
        await expect(page.getByTestId('string-generator-page')).toBeVisible();

        await recordStep('Output: string generator page visible');
    });

    await test.step('Fill the template, placeholder, and range fields', async () => {
        const input = {
            template: 'set interface ge-0/0/{A} description port-{A}',
            placeholder: '{A}',
            start: '7',
            end: '9'
        };
        await recordStep(`Input: ${JSON.stringify(input)}`);

        await page.getByTestId('string-template-input').fill(input.template);
        await page.getByTestId('string-placeholder-input').fill(input.placeholder);
        await page.getByTestId('string-start-input').fill(input.start);
        await page.getByTestId('string-end-input').fill(input.end);

        await recordStep('Output: form fields populated');
    });

    await test.step('Generate strings from the form input', async () => {
        await recordStep('Input: click string-generate-button');

        await page.getByTestId('string-generate-button').click();

        await recordStep('Output: generateString request submitted');
    });

    await test.step('Verify generated textarea content', async () => {
        const expectedLines = [
            'set interface ge-0/0/7 description port-7',
            'set interface ge-0/0/8 description port-8',
            'set interface ge-0/0/9 description port-9'
        ];
        await recordStep(`Input: expectedLines=${JSON.stringify(expectedLines)}`);

        const result = await page.getByTestId('string-result-textarea').inputValue();
        expect(result.replace(/\r\n/g, '\n')).toBe(expectedLines.join('\n'));

        await recordStep(`Output: actualLines=${JSON.stringify(result.replace(/\r\n/g, '\n').split('\n'))}`);
    });

    await test.step('Verify generateString API payload captured by the mock', async () => {
        const expectedPayload = {
            template: 'set interface ge-0/0/{A} description port-{A}',
            placeholder: '{A}',
            start: '7',
            end: '9'
        };
        await recordStep(`Input: expectedPayload=${JSON.stringify(expectedPayload)}`);

        const calls = await page.evaluate(() => window.__netNexusE2e.calls.generateString);
        expect(calls).toEqual([expectedPayload]);

        await recordStep(`Output: capturedPayload=${JSON.stringify(calls[0])}`);
    });
});

test('loads a history item, regenerates its result, and clears history data', async ({ page }) => {
    await test.step('Open the string generator page', async () => {
        await recordStep('Input: route=/#/tools/string-generator');

        await page.goto('/#/tools/string-generator');
        await expect(page.getByTestId('string-generator-page')).toBeVisible();

        await recordStep('Output: string generator page visible');
    });

    await test.step('Open history modal and verify seeded history item', async () => {
        await recordStep('Input: click string-history-button, expected seeded history hostname leaf-{A} 3..4');

        await page.getByTestId('string-history-button').click();

        const historyModal = page.getByTestId('string-history-modal');
        await expect(historyModal).toBeVisible();
        await expect(historyModal).toContainText('hostname leaf-{A}');
        await expect(historyModal).toContainText('3');
        await expect(historyModal).toContainText('4');

        await recordStep('Output: history modal visible with hostname leaf-{A}, start=3, end=4');
    });

    await test.step('Use the history item', async () => {
        await recordStep('Input: click string-history-use-button');

        await page.getByTestId('string-history-use-button').click();

        await recordStep('Output: history item selected and modal action completed');
    });

    await test.step('Verify history item values are loaded into the form', async () => {
        const expectedPayload = {
            template: 'hostname leaf-{A}',
            placeholder: '{A}',
            start: '3',
            end: '4'
        };
        await recordStep(`Input: expectedForm=${JSON.stringify(expectedPayload)}`);

        await expect(page.getByTestId('string-template-input')).toHaveValue('hostname leaf-{A}');
        await expect(page.getByTestId('string-placeholder-input')).toHaveValue('{A}');
        await expect(page.getByTestId('string-start-input')).toHaveValue('3');
        await expect(page.getByTestId('string-end-input')).toHaveValue('4');

        await recordStep(`Output: loadedForm=${JSON.stringify(expectedPayload)}`);
    });

    await test.step('Verify result is regenerated from the history item', async () => {
        const expectedLines = ['hostname leaf-3', 'hostname leaf-4'];
        await recordStep(`Input: expectedLines=${JSON.stringify(expectedLines)}`);

        const historyResult = await page.getByTestId('string-result-textarea').inputValue();
        expect(historyResult.replace(/\r\n/g, '\n')).toBe(expectedLines.join('\n'));

        await recordStep(`Output: actualLines=${JSON.stringify(historyResult.replace(/\r\n/g, '\n').split('\n'))}`);
    });

    await test.step('Verify history use triggered the expected generateString API payload', async () => {
        const expectedPayload = {
            template: 'hostname leaf-{A}',
            placeholder: '{A}',
            start: '3',
            end: '4'
        };
        await recordStep(`Input: expectedPayload=${JSON.stringify(expectedPayload)}`);

        const callsAfterHistoryUse = await page.evaluate(() => window.__netNexusE2e.calls.generateString);
        const capturedPayload = callsAfterHistoryUse[callsAfterHistoryUse.length - 1];
        expect(capturedPayload).toEqual(expectedPayload);

        await recordStep(`Output: capturedPayload=${JSON.stringify(capturedPayload)}`);
    });

    await test.step('Clear generation history from the modal', async () => {
        await recordStep('Input: reopen history modal and click string-history-clear-button');

        await page.getByTestId('string-history-button').click();
        await expect(page.getByTestId('string-history-modal')).toBeVisible();
        await page.getByTestId('string-history-clear-button').click();
        await expect(page.getByTestId('string-history-clear-button')).toBeHidden();

        await recordStep('Output: clear button hidden after history is cleared');
    });

    await test.step('Verify mock history data is empty after clearing', async () => {
        await recordStep('Input: expectedHistory=[]');

        const historyAfterClear = await page.evaluate(() => window.__netNexusE2e.history);
        expect(historyAfterClear).toEqual([]);

        await recordStep(`Output: historyCount=${historyAfterClear.length}`);
    });
});
