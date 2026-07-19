const { expect, test } = require('../../scripts/e2e-support/electron-test');
const { setupFeaturePagesE2e } = require('../../scripts/e2e-support');

const MAX_RENDERED_REPLY_CHARACTERS = 256 * 1024;
const LARGE_REPLY_HEAD_PROBE = 'NETNEXUS_LARGE_RPC_REPLY_HEAD_PROBE';
const OMITTED_PAYLOAD_SENTINEL = 'NETNEXUS_FULL_RPC_REPLY_MUST_NOT_REACH_RENDERER';
const REPLY_FILE_TOKEN = 'e2e-large-rpc-reply-token';

const compactItems = count => '<item><name>x</name></item>'.repeat(count);

function largeReplyFixture() {
    const fullReply =
        '<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="large-rpc-42">' +
        `<data><probe>${LARGE_REPLY_HEAD_PROBE}</probe><items xmlns="urn:netnexus:test:large-reply">` +
        compactItems(20_000) +
        `<probe>${OMITTED_PAYLOAD_SENTINEL}</probe>` +
        compactItems(20_000) +
        '</items></data></rpc-reply>';
    const marker = '\n<!-- NetNexus: RPC response truncated; save the complete response to inspect it -->\n';
    const retainedCharacters = MAX_RENDERED_REPLY_CHARACTERS - marker.length;
    const headLength = Math.ceil(retainedCharacters * 0.75);
    const tailLength = retainedCharacters - headLength;
    const preview = `${fullReply.slice(0, headLength)}${marker}${fullReply.slice(-tailLength)}`;
    return {
        fullReply,
        preview,
        replyBytes: Buffer.byteLength(fullReply, 'utf8')
    };
}

test.describe('large NETCONF RPC replies', () => {
    let harness;

    test.beforeEach(async ({ page }) => {
        harness = await setupFeaturePagesE2e(page);
    });

    test.afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('keeps the response and execution-history UI lightweight while preserving save access', async ({ page }) => {
        const fixture = largeReplyFixture();
        const saveRequests = [];
        const originalControllerCall = harness.controller.call.bind(harness.controller);
        harness.controller.call = async (method, ...args) => {
            if (method === 'yang.netconf.saveRpcReply') {
                saveRequests.push(args[0]);
                return { status: 'success', data: { saved: true, canceled: false } };
            }
            if (method !== 'yang.netconf.executeOperation') return originalControllerCall(method, ...args);
            const requestXml =
                '<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="large-rpc-42"><get/></rpc>';
            return {
                status: 'success',
                data: {
                    operation: 'get',
                    messageId: 'large-rpc-42',
                    rpc: requestXml,
                    requestXml,
                    reply: fixture.preview,
                    xml: fixture.preview,
                    data: null,
                    errors: [],
                    replyBytes: fixture.replyBytes,
                    replyTruncated: true,
                    replyFileToken: REPLY_FILE_TOKEN
                }
            };
        };

        await page.goto('/#/yang/yang-workspace');
        await page.evaluate(() => {
            window.netconfApi.saveRpcReply = request => window.__featureE2eCall('yang.netconf.saveRpcReply', request);
            window.__largeRpcReplyParseCount = 0;
            const nativeParseFromString = DOMParser.prototype.parseFromString;
            DOMParser.prototype.parseFromString = function parseFromString(source, type) {
                if (String(source).includes('NETNEXUS_LARGE_RPC_REPLY_HEAD_PROBE')) {
                    window.__largeRpcReplyParseCount += 1;
                }
                return nativeParseFromString.call(this, source, type);
            };
        });

        const operationPanel = page.locator('.workspace-operation-panel');
        await operationPanel.getByRole('button', { name: '执行 get', exact: true }).click();

        const resultCard = operationPanel.locator('.operation-result-card');
        await expect(resultCard).toContainText('成功');
        await expect(resultCard).toContainText(/(?:响应|内容).*(?:截断|预览)/u);
        const resultEditor = resultCard.locator('.rpc-result');
        const resultInput = resultEditor.getByRole('textbox', { name: 'RPC 响应 XML' });
        await expect(resultInput).toBeVisible();
        const renderedReply = await resultInput.inputValue();
        expect(renderedReply.length).toBeLessThanOrEqual(MAX_RENDERED_REPLY_CHARACTERS);
        expect(renderedReply).toContain(LARGE_REPLY_HEAD_PROBE);
        expect(renderedReply).not.toContain(OMITTED_PAYLOAD_SENTINEL);
        await expect(resultEditor.locator('[data-xml-highlight-layer]')).toHaveCount(0);
        await expect(resultEditor.locator('[data-xml-line-number-gutter]')).toHaveCount(0);
        await expect(resultCard.locator('.xml-display-toggle')).toHaveCount(0);
        expect(await page.evaluate(() => window.__largeRpcReplyParseCount)).toBe(0);

        const saveButton = resultCard.getByRole('button', { name: /保存完整响应/u });
        await expect(saveButton).toBeEnabled();
        await saveButton.click();
        await expect.poll(() => saveRequests.length).toBe(1);
        expect(saveRequests[0]).toMatchObject({ token: REPLY_FILE_TOKEN });

        await page.getByRole('button', { name: '执行记录', exact: true }).click();
        const historyDrawer = page.getByRole('dialog', { name: 'NETCONF 执行记录' });
        await expect(historyDrawer).toBeVisible();
        const historyItems = historyDrawer.getByTestId('netconf-history-item');
        await expect(historyItems).toHaveCount(1);
        await expect(historyItems.first()).toContainText('成功');
        await expect(historyDrawer.getByText(/(?:内容已截断|仅显示预览)/u)).toBeVisible();

        const historyReply = historyDrawer.getByTestId('netconf-history-reply');
        const historyReplyValue = await historyReply.inputValue();
        expect(historyReplyValue.length).toBeLessThanOrEqual(MAX_RENDERED_REPLY_CHARACTERS);
        expect(historyReplyValue).not.toContain(OMITTED_PAYLOAD_SENTINEL);
        const historyEditor = historyReply.locator('xpath=..');
        await expect(historyEditor.locator('[data-xml-highlight-layer]')).toHaveCount(0);
        await expect(historyEditor.locator('[data-xml-line-number-gutter]')).toHaveCount(0);
        await expect(historyDrawer.getByRole('button', { name: /保存完整响应/u })).toBeEnabled();
        expect(await page.evaluate(() => window.__largeRpcReplyParseCount)).toBe(0);

        await historyDrawer.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(historyDrawer).toBeHidden();
        await resultCard.getByRole('button', { name: '清空', exact: true }).click();
        await expect(resultCard.getByText('执行操作后在这里查看 rpc-reply', { exact: true })).toBeVisible();
    });
});
