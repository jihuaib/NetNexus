const dgram = require('dgram');
const { parsePayload } = require('./tcpClientManager');
const { UDP_TOOL_STATE, UDP_TOOL_EVT_TYPES } = require('../const/toolsConst');

function isIpv6Host(host) {
    return typeof host === 'string' && host.includes(':');
}

/**
 * UDP 收发管理器
 * UDP 无连接：打开一个本地 socket，向目标地址发送数据报，并接收回包（带来源信息）。
 * 通过 emit 回调推送状态与收包事件。
 */
class UdpClientManager {
    /**
     * @param {(eventType: string, data: any) => void} emit 事件推送回调
     */
    constructor(emit) {
        this.emit = typeof emit === 'function' ? emit : () => {};
        this.sockets = new Map();
        this.nextId = 1;
    }

    _emitState(conn, state, message) {
        this.emit(UDP_TOOL_EVT_TYPES.STATE_CHANGE, {
            id: conn.id,
            state,
            message: message || '',
            host: conn.host,
            port: conn.port,
            localAddress: conn.localAddress,
            localPort: conn.localPort,
            bytesSent: conn.bytesSent,
            bytesReceived: conn.bytesReceived
        });
    }

    /**
     * 打开一个 UDP socket（绑定本地端口以接收回包），并记录默认发送目标
     * @param {{host: string, port: number, localPort?: number}} options
     * @returns {{id: string, host: string, port: number}}
     */
    open(options = {}) {
        const host = String(options.host || '').trim();
        const port = Number(options.port);
        if (!host) {
            throw new Error('请输入目标地址');
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('端口范围为 1 ~ 65535');
        }

        const localPort = Number(options.localPort);
        const bindPort = Number.isInteger(localPort) && localPort >= 0 && localPort <= 65535 ? localPort : 0;

        const id = `udp-${this.nextId++}`;
        const conn = {
            id,
            host,
            port,
            socket: null,
            ready: false,
            bytesSent: 0,
            bytesReceived: 0,
            localAddress: null,
            localPort: null
        };
        this.sockets.set(id, conn);

        const socket = dgram.createSocket(isIpv6Host(host) ? 'udp6' : 'udp4');
        conn.socket = socket;

        socket.on('listening', () => {
            const address = socket.address();
            conn.ready = true;
            conn.localAddress = address.address;
            conn.localPort = address.port;
            this._emitState(conn, UDP_TOOL_STATE.LISTENING, '已就绪');
        });

        socket.on('message', (msg, rinfo) => {
            conn.bytesReceived += msg.length;
            this.emit(UDP_TOOL_EVT_TYPES.DATA, {
                id,
                dataHex: msg.toString('hex'),
                dataText: msg.toString('utf8'),
                length: msg.length,
                totalReceived: conn.bytesReceived,
                sourceAddress: rinfo.address,
                sourcePort: rinfo.port
            });
        });

        socket.on('error', error => {
            this._emitState(conn, UDP_TOOL_STATE.ERROR, error.message);
            socket.close();
        });

        socket.on('close', () => {
            conn.ready = false;
            this._emitState(conn, UDP_TOOL_STATE.CLOSED, 'socket 已关闭');
            this.sockets.delete(id);
        });

        this._emitState(conn, UDP_TOOL_STATE.OPENING, '正在打开');
        socket.bind(bindPort);

        return { id, host, port };
    }

    /**
     * 发送一个 UDP 数据报
     * @param {string} id socket id
     * @param {{data: string|Buffer, encoding?: string, host?: string, port?: number}} options
     * @returns {Promise<{id: string, length: number, bytesSent: number}>}
     */
    async send(id, options = {}) {
        const conn = this.sockets.get(id);
        if (!conn || !conn.socket) {
            throw new Error('socket 不存在或已关闭');
        }
        if (!conn.ready) {
            throw new Error('socket 尚未就绪');
        }

        const targetHost = options.host ? String(options.host).trim() : conn.host;
        const targetPort = options.port !== undefined && options.port !== null ? Number(options.port) : conn.port;
        if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
            throw new Error('端口范围为 1 ~ 65535');
        }

        const buffer = parsePayload(options.data, options.encoding);
        if (buffer.length === 0) {
            throw new Error('报文内容为空');
        }

        return new Promise((resolve, reject) => {
            conn.socket.send(buffer, targetPort, targetHost, error => {
                if (error) {
                    reject(error);
                    return;
                }
                conn.bytesSent += buffer.length;
                resolve({ id, length: buffer.length, bytesSent: conn.bytesSent });
            });
        });
    }

    /**
     * 关闭指定 UDP socket
     * @param {string} id socket id
     * @returns {{id: string, closed: boolean}}
     */
    close(id) {
        const conn = this.sockets.get(id);
        if (!conn || !conn.socket) {
            return { id, closed: false };
        }

        conn.socket.close();
        return { id, closed: true };
    }

    /**
     * 关闭并清理所有 socket
     */
    closeAll() {
        for (const conn of this.sockets.values()) {
            if (conn.socket) {
                try {
                    conn.socket.close();
                } catch (_error) {
                    // 忽略重复关闭错误
                }
            }
        }
        this.sockets.clear();
    }

    getConnection(id) {
        return this.sockets.get(id) || null;
    }
}

module.exports = {
    UdpClientManager
};
