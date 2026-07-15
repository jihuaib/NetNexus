const assert = require('node:assert/strict');
const { MessageChannel } = require('node:worker_threads');
const BmpApp = require('../../electron/app/bmpApp');
const BmpConst = require('../../electron/const/bmpConst');

async function main() {
    const sourceId = 'a'.repeat(64);
    let workerPayload = null;
    const app = Object.create(BmpApp.prototype);
    app.worker = {
        async sendRequest(requestType, payload) {
            assert.equal(requestType, BmpConst.BMP_REQ_TYPES.DELETE_CLIENT_DATA);
            workerPayload = payload;
            return {
                data: { sourceId: payload.sourceId, deleted: true },
                msg: 'deleted'
            };
        }
    };

    const result = await app.handleDeleteClientData(null, {
        sourceId: ` ${sourceId} `,
        remoteIp: ' 192.0.2.10 ',
        nestedReactiveData: { rawTlvs: [] },
        callback: () => {}
    });

    assert.deepEqual(workerPayload, {
        sourceId,
        remoteIp: '192.0.2.10'
    });
    const { port1, port2 } = new MessageChannel();
    assert.doesNotThrow(() => port1.postMessage(workerPayload));
    port1.close();
    port2.close();
    assert.equal(result.status, 'success');
    assert.equal(result.data.deleted, true);

    app.worker = null;
    const stoppedResult = await app.handleDeleteClientData(null, { sourceId, remoteIp: '192.0.2.10' });
    assert.equal(stoppedResult.status, 'error');
    assert.equal(stoppedResult.msg, '请先启动 BMP 服务后删除离线客户端');

    console.log('BMP client-delete app tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
