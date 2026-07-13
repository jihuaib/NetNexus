const assert = require('node:assert/strict');
const BmpApp = require('../../electron/app/bmpApp');

async function main() {
    const app = Object.create(BmpApp.prototype);
    app.worker = null;

    const result = await app.queryRouteAssurance({ routeState: 'active' });
    assert.equal(result.status, 'error');
    assert.equal(result.msg, 'BMP未启动');

    console.log('BMP Route Assurance app-state tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
