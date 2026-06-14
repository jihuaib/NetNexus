const net = require('net');
const { successResponse, timestamp } = require('./common');

const ftpPageApiScript =
    "    window.ftpApi = {\n        addFtpUser: user => call('ftp.addFtpUser', user),\n        getFtpUserList: () => call('ftp.getFtpUserList'),\n        deleteFtpUser: user => call('ftp.deleteFtpUser', user),\n        saveFtpConfig: config => call('ftp.saveFtpConfig', config),\n        getFtpConfig: () => call('ftp.getFtpConfig'),\n        startFtp: (config, user) => call('ftp.startFtp', config, user),\n        stopFtp: () => call('ftp.stopFtp'),\n        getFtpStatus: () => call('ftp.getFtpStatus'),\n        getClientList: () => call('ftp.getClientList')\n    };";

function createFtpPageState(protocolRoot) {
    return {
        config: { port: 0 },
        users: [{ rootDir: protocolRoot + '/ftp', username: 'e2e-user', password: 'e2e-pass' }],
        clients: [],
        running: false
    };
}

async function handlePageCall(controller, method, args) {
    const ftp = controller.state.ftp;
    if (method === 'ftp.getFtpConfig') return successResponse(ftp.config);
    if (method === 'ftp.saveFtpConfig') {
        ftp.config = args[0];
        return successResponse(null, '配置保存成功');
    }
    if (method === 'ftp.getFtpUserList') return successResponse(ftp.users);
    if (method === 'ftp.addFtpUser') {
        ftp.users = [args[0], ...ftp.users.filter(user => user.username !== args[0].username)];
        return successResponse(null, '用户添加成功');
    }
    if (method === 'ftp.deleteFtpUser') {
        ftp.users = ftp.users.filter(user => user.username !== args[0].username);
        return successResponse(null, '用户删除成功');
    }
    if (method === 'ftp.startFtp') {
        ftp.config = args[0];
        ftp.users = [args[1]];
        await startServer(controller);
        ftp.running = true;
        return successResponse(null, 'ftp协议启动成功');
    }
    if (method === 'ftp.stopFtp') {
        await stopServer(controller);
        ftp.running = false;
        ftp.clients = [];
        return successResponse(null, 'ftp协议停止成功');
    }
    if (method === 'ftp.getClientList') return successResponse(ftp.clients);
    if (method === 'ftp.getFtpStatus') return successResponse({ running: ftp.running });
    return successResponse(null);
}

async function startServer(controller) {
    await stopServer(controller);
    controller.ftpServer = net.createServer(socket => handleConnection(controller, socket));
    await new Promise((resolve, reject) => {
        controller.ftpServer.once('error', reject);
        controller.ftpServer.listen(controller.state.ftp.config.port, '127.0.0.1', resolve);
    });
}

function handleConnection(controller, socket) {
    const client = {
        localIp: socket.localAddress,
        localPort: socket.localPort,
        remoteIp: socket.remoteAddress,
        remotePort: socket.remotePort,
        username: '匿名',
        authenticated: false,
        status: '已连接',
        connectedTime: timestamp()
    };
    controller.state.ftp.clients = [client];
    controller.emitEvent('ftp:event', successResponse({ type: 1, opType: 'add', data: client }));
    socket.write('220 Welcome to the NetNexus E2E FTP server\r\n');

    socket.on('data', data => {
        const commands = data
            .toString('utf8')
            .split(/\r?\n/u)
            .map(line => line.trim())
            .filter(Boolean);
        for (const command of commands) {
            const [verb, ...rest] = command.split(/\s+/u);
            const arg = rest.join(' ');
            if (verb.toUpperCase() === 'USER') {
                client.username = arg;
                socket.write('331 Username OK, password required\r\n');
            } else if (verb.toUpperCase() === 'PASS') {
                client.authenticated = true;
                client.status = '已登录';
                controller.state.ftp.clients = [{ ...client }];
                controller.emitEvent('ftp:event', successResponse({ type: 1, opType: 'add', data: { ...client } }));
                socket.write('230 User logged in, proceed\r\n');
            } else if (verb.toUpperCase() === 'PWD') {
                socket.write('257 "/" is the current directory\r\n');
            } else if (verb.toUpperCase() === 'NOOP') {
                socket.write('200 NOOP ok\r\n');
            } else if (verb.toUpperCase() === 'QUIT') {
                socket.write('221 Goodbye\r\n');
                socket.end();
            } else {
                socket.write('200 OK\r\n');
            }
        }
    });
}

async function stopServer(controller) {
    if (!controller.ftpServer) return;
    const server = controller.ftpServer;
    controller.ftpServer = null;
    await new Promise(resolve => server.close(resolve));
}

async function runClient(controller) {
    controller.ftpClientEvents = [];
    return controller.runScript(
        'scripts/mockFtpClient.js',
        [
            '--host',
            '127.0.0.1',
            '--port',
            String(controller.state.ftp.config.port),
            '--username',
            controller.state.ftp.users[0].username,
            '--password',
            controller.state.ftp.users[0].password
        ],
        controller.ftpClientEvents
    );
}

async function cleanup(controller) {
    await stopServer(controller);
}

module.exports = {
    cleanup,
    createFtpPageState,
    ftpPageApiScript,
    handlePageCall,
    runClient
};
