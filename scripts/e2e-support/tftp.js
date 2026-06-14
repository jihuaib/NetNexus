const dgram = require('dgram');
const { successResponse, timestamp } = require('./common');

const tftpPageApiScript =
    "    window.tftpApi = {\n        saveTftpConfig: config => call('tftp.saveTftpConfig', config),\n        getTftpConfig: () => call('tftp.getTftpConfig'),\n        startTftp: config => call('tftp.startTftp', config),\n        stopTftp: () => call('tftp.stopTftp'),\n        getTransferList: () => call('tftp.getTransferList'),\n        clearTransferHistory: () => call('tftp.clearTransferHistory')\n    };";

function createTftpPageState() {
    return {
        config: {
            port: 0,
            rootDir: '/tmp/netnexus-e2e/tftp',
            blockSize: 512,
            timeout: 3,
            retries: 5,
            allowRead: true,
            allowWrite: true
        },
        transfers: [],
        running: false,
        nextTransferId: 1
    };
}

async function handlePageCall(controller, method, args) {
    const tftp = controller.state.tftp;
    if (method === 'tftp.getTftpConfig') return successResponse(tftp.config);
    if (method === 'tftp.saveTftpConfig') {
        tftp.config = args[0];
        return successResponse(null);
    }
    if (method === 'tftp.startTftp') {
        tftp.config = args[0];
        await startServer(controller);
        tftp.running = true;
        return successResponse({ config: tftp.config }, 'TFTP服务启动成功');
    }
    if (method === 'tftp.stopTftp') {
        await stopServer(controller);
        tftp.running = false;
        tftp.transfers = [];
        return successResponse(null, 'TFTP服务器已停止');
    }
    if (method === 'tftp.getTransferList') return successResponse(tftp.transfers);
    if (method === 'tftp.clearTransferHistory') {
        tftp.transfers = [];
        controller.emitEvent(
            'tftp:event',
            successResponse({ type: 3, data: null, stats: { transferCount: 0, lastTransferAt: '-', lastClient: '-' } })
        );
        return successResponse(null, 'TFTP传输日志已清空');
    }
    return successResponse(null);
}

async function startServer(controller) {
    await stopServer(controller);
    controller.tftpServer = dgram.createSocket('udp4');
    controller.tftpServer.on('message', (message, rinfo) => handleMessage(controller, message, rinfo));
    await new Promise((resolve, reject) => {
        controller.tftpServer.once('error', reject);
        controller.tftpServer.bind(controller.state.tftp.config.port, '127.0.0.1', resolve);
    });
}

function handleMessage(controller, message, rinfo) {
    const opcode = message.readUInt16BE(0);
    if (opcode === 2) {
        const filename = message.subarray(2).toString('ascii').split('\0')[0];
        const record = {
            id: controller.state.tftp.nextTransferId++,
            timestamp: timestamp(),
            clientAddress: rinfo.address,
            clientPort: rinfo.port,
            type: 'write',
            filename,
            mode: 'octet',
            blockSize: 512,
            bytes: 0,
            status: 'transferring',
            message: 'WRQ received'
        };
        controller.state.tftp.activeTransfer = record;
        controller.state.tftp.transfers = [record, ...controller.state.tftp.transfers];
        controller.tftpServer.send(Buffer.from([0, 4, 0, 0]), rinfo.port, rinfo.address);
        emitTransfer(controller, record);
    } else if (opcode === 3) {
        const block = message.readUInt16BE(2);
        const data = message.subarray(4);
        const record = controller.state.tftp.activeTransfer;
        if (record) {
            record.bytes += data.length;
            record.status = 'completed';
            record.message = 'received DATA block ' + block;
            emitTransfer(controller, record);
        }
        const ack = Buffer.alloc(4);
        ack.writeUInt16BE(4, 0);
        ack.writeUInt16BE(block, 2);
        controller.tftpServer.send(ack, rinfo.port, rinfo.address);
    }
}

function emitTransfer(controller, record) {
    controller.emitEvent(
        'tftp:event',
        successResponse({
            type: 1,
            data: { ...record },
            stats: {
                transferCount: controller.state.tftp.transfers.length,
                lastTransferAt: record.timestamp,
                lastClient: record.clientAddress + ':' + record.clientPort
            }
        })
    );
}

async function stopServer(controller) {
    if (!controller.tftpServer) return;
    const server = controller.tftpServer;
    controller.tftpServer = null;
    await new Promise(resolve => server.close(resolve));
}

async function runClient(controller) {
    controller.tftpClientEvents = [];
    return controller.runScript(
        'scripts/mockTftpClient.js',
        [
            '--host',
            '127.0.0.1',
            '--port',
            String(controller.state.tftp.config.port),
            '--mode',
            'write',
            '--filename',
            'netnexus-e2e.txt',
            '--content',
            'NetNexus TFTP E2E payload'
        ],
        controller.tftpClientEvents
    );
}

async function cleanup(controller) {
    await stopServer(controller);
}

module.exports = {
    cleanup,
    createTftpPageState,
    handlePageCall,
    runClient,
    tftpPageApiScript
};
