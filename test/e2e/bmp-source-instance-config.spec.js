const { test, expect } = require('../../scripts/e2e-support/electron-test');
const { getBrowserMockScript } = require('../../scripts/e2e-support');

test('configures BMP source instance extraction and distinguishes clients', async ({ page }, testInfo) => {
    let savedConfig = null;
    let startedConfig = null;
    const clients = ['default', 'blue'].map((bgpInstanceName, index) => ({
        persistentSourceId: String(index + 1).repeat(64),
        remoteIp: '192.168.56.131',
        remotePort: 42637 + index,
        sysName: 'H3C',
        bgpInstanceName,
        isOnline: true
    }));

    await page.exposeFunction('__bmpE2eCall', (method, ...args) => {
        if (method === 'loadBmpConfig') return { status: 'success', data: savedConfig };
        if (method === 'getClientList') return { status: 'success', data: clients };
        if (method === 'saveBmpConfig') savedConfig = args[0];
        if (method === 'startBmp') startedConfig = args[0];
        return { status: 'success', data: [], msg: '完成' };
    });
    await page.addInitScript({ content: getBrowserMockScript('bmp') });
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.goto('/#/bmp/bmp-config');

    const template = page.getByTestId('bmp-source-instance-template-select');
    const tlvType = page.getByTestId('bmp-source-instance-tlv-type-input');
    const preview = page.getByTestId('bmp-source-instance-template-preview');
    await expect(template).toContainText('H3C');
    await expect(tlvType).toHaveValue('0');
    await expect(preview).toContainText('bgp instance name:default');
    await page.screenshot({ path: testInfo.outputPath('bmp-source-instance-h3c.png'), fullPage: true });

    await template.click();
    await page.getByRole('option', { name: '自定义模板', exact: true }).click();
    const customTemplate = page.getByTestId('bmp-source-instance-custom-template-input');
    await customTemplate.fill('process={instance};');
    await tlvType.fill('5');
    await expect(preview).toContainText('Initiation TLV 5 的值 process=default;');
    await page.screenshot({ path: testInfo.outputPath('bmp-source-instance-custom.png'), fullPage: true });

    await page.getByTestId('bmp-start-button').click();
    await expect(page.getByTestId('bmp-stop-button')).toBeEnabled();
    const expectedConfig = {
        sourceInstanceTemplate: 'custom',
        sourceInstanceTlvType: 5,
        sourceInstanceCustomTemplate: 'process={instance};'
    };
    expect(savedConfig).toMatchObject(expectedConfig);
    expect(startedConfig).toMatchObject(expectedConfig);

    for (const instance of ['default', 'blue']) {
        const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: instance, exact: true }) });
        await expect(row).toContainText('H3C');
        await row.getByTestId('bmp-client-detail-button').click();
        await expect(page.getByRole('dialog')).toContainText(`H3C · 192.168.56.131 · BGP ${instance}`);
        await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    }

    await page.getByTestId('bmp-stop-button').click();
    await expect(page.getByTestId('bmp-stop-button')).toBeDisabled();
    await page.reload();
    await expect(template).toContainText('自定义模板');
    await expect(tlvType).toHaveValue('5');
    await expect(customTemplate).toHaveValue('process={instance};');
});
