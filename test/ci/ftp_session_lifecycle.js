const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const FtpSession = require(path.join(__dirname, '..', '..', 'electron', 'worker', 'transfer', 'ftpSession.js'));
const FtpConst = require(path.join(__dirname, '..', '..', 'electron', 'const', 'ftpConst.js'));

function makeSocket() {
    return {
        destroyed: false,
        ended: false,
        writable: true,
        write() {
            return true;
        },
        end() {
            this.ended = true;
        },
        destroy() {
            this.destroyed = true;
        }
    };
}

const events = [];
const session = new FtpSession(
    {
        sendEvent(type, payload) {
            events.push({ type, payload });
        }
    },
    {
        userConfig: { username: 'user', password: 'pass', rootDir: process.cwd() }
    }
);

const controlSocket = makeSocket();
const dataSocket = makeSocket();
const passiveServer = {
    closed: false,
    close() {
        this.closed = true;
    }
};

session.socket = controlSocket;
session.dataSocket = dataSocket;
session.passiveServer = passiveServer;
session.passive = true;
session.localIp = '127.0.0.1';
session.localPort = 2121;
session.remoteIp = '127.0.0.1';
session.remotePort = 50000;

session.closeSession();

assert.strictEqual(controlSocket.destroyed, true, 'FTP session close should destroy control socket');
assert.strictEqual(dataSocket.ended, true, 'FTP session close should end active data socket');
assert.strictEqual(passiveServer.closed, true, 'FTP session close should close passive data server');
assert.strictEqual(session.socket, null, 'FTP session close should clear control socket reference');
assert.strictEqual(session.dataSocket, null, 'FTP session close should clear data socket reference');
assert.strictEqual(session.passiveServer, null, 'FTP session close should clear passive server reference');
assert.strictEqual(session.passive, false, 'FTP session close should leave passive mode');
assert.deepStrictEqual(
    events.map(event => ({
        type: event.type,
        subType: event.payload.type,
        opType: event.payload.opType
    })),
    [
        {
            type: FtpConst.FTP_EVT_TYPES.FTP_EVT,
            subType: FtpConst.FTP_SUB_EVT_TYPES.FTP_SUB_EVT_CONNCET,
            opType: 'remove'
        }
    ],
    'FTP session close should publish one client remove event'
);

console.log('FTP session lifecycle tests passed');
