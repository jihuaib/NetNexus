const assert = require('node:assert/strict');
const BmpApp = require('../../electron/app/bmpApp');

async function main() {
    const app = Object.create(BmpApp.prototype);
    app.worker = null;

    const result = await app.queryRouteLens('203.0.113.1', 'active');
    assert.equal(result.status, 'error');
    assert.equal(result.msg, 'BMP未启动');

    console.log('BMP Route Lens app-state tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
