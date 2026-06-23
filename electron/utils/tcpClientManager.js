const net = require('net');
const { TCP_TOOL_STATE, TCP_TOOL_EVT_TYPES, TCP_TOOL_DEFAULT } = require('../const/toolsConst');

/**
 * 将用户输入的报文内容解析为 Buffer
 * @param {string|Buffer} data 报文内容
 * @param {string} encoding 编码方式: 'hex' | 'utf8' | 'base64'
 * @returns {Buffer}
 */
function parsePayload(data, encoding) {
    if (data === undefined || data === null) {
        return Buffer.alloc(0);
    }
    if (Buffer.isBuffer(data)) {
        return data;
    }

    const normalizedEncoding = String(encoding || 'utf8').toLowerCase();
    if (normalizedEncoding === 'hex') {
        const cleaned = String(data).replace(/[\s:,-]/g, '');
        if (cleaned.length === 0) {
            return Buffer.alloc(0);
        }
        if (cleaned.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleaned)) {
            throw new Error('无效的十六进制报文');
        }
        return Buffer.from(cleaned, 'hex');
    }
    if (normalizedEncoding === 'base64') {
        return Buffer.from(String(data), 'base64');
    }

    return Buffer.from(String(data), 'utf8');
}

/**
 * TCP 客户端连接管理器
 * 负责发起/发送/关闭 TCP 连接，并通过 emit 回调推送状态与收包事件
 */
class TcpClientManager {
    /**
     * @param {(eventType: string, data: any) => void} emit 事件推送回调
     */
    constructor(emit) {
        this.emit = typeof emit === 'function' ? emit : () => {};
        this.connections = new Map();
        this.nextId = 1;
    }

    _emitState(conn, state, message) {
        this.emit(TCP_TOOL_EVT_TYPES.STATE_CHANGE, {
            id: conn.id,
            state,
            message: message || '',
            host: conn.host,
            port: conn.port,
            remoteAddress: conn.remoteAddress,
            remotePort: conn.remotePort,
            bytesSent: conn.bytesSent,
            bytesReceived: conn.bytesReceived
        });
    }

    /**
     * 发起一个 TCP 连接
     * @param {{host: string, port: number, timeout?: number}} options
     * @returns {{id: string, host: string, port: number}}
     */
    connect(options = {}) {
        const host = String(options.host || '').trim();
        const port = Number(options.port);
        if (!host) {
            throw new Error('请输入目标地址');
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('端口范围为 1 ~ 65535');
        }

        const connectTimeout = Number(options.timeout) > 0 ? Number(options.timeout) : TCP_TOOL_DEFAULT.CONNECT_TIMEOUT;

        const id = `tcp-${this.nextId++}`;
        const conn = {
            id,
            host,
            port,
            socket: null,
            connected: false,
            bytesSent: 0,
            bytesReceived: 0,
            remoteAddress: null,
            remotePort: null
        };
        this.connections.set(id, conn);

        const socket = new net.Socket();
        conn.socket = socket;
        socket.setNoDelay(true);

        const connectTimer = setTimeout(() => {
            if (!conn.connected) {
                this._emitState(conn, TCP_TOOL_STATE.ERROR, '连接超时');
                socket.destroy();
            }
        }, connectTimeout);

        socket.on('connect', () => {
            clearTimeout(connectTimer);
            conn.connected = true;
            conn.remoteAddress = socket.remoteAddress || null;
            conn.remotePort = socket.remotePort || null;
            this._emitState(conn, TCP_TOOL_STATE.CONNECTED, '已连接');
        });

        socket.on('data', chunk => {
            conn.bytesReceived += chunk.length;
            this.emit(TCP_TOOL_EVT_TYPES.DATA, {
                id,
                dataHex: chunk.toString('hex'),
                dataText: chunk.toString('utf8'),
                length: chunk.length,
                totalReceived: conn.bytesReceived
            });
        });

        socket.on('error', error => {
            clearTimeout(connectTimer);
            this._emitState(conn, TCP_TOOL_STATE.ERROR, error.message);
        });

        socket.on('close', () => {
            clearTimeout(connectTimer);
            conn.connected = false;
            this._emitState(conn, TCP_TOOL_STATE.CLOSED, '连接已关闭');
            this.connections.delete(id);
        });

        this._emitState(conn, TCP_TOOL_STATE.CONNECTING, '正在连接');
        socket.connect(port, host);

        return { id, host, port };
    }

    /**
     * 通过指定连接发送 TCP 报文
     * @param {string} id 连接 id
     * @param {{data: string|Buffer, encoding?: string}} options
     * @returns {{id: string, length: number, bytesSent: number}}
     */
    send(id, options = {}) {
        const conn = this.connections.get(id);
        if (!conn || !conn.socket) {
            throw new Error('连接不存在或已关闭');
        }
        if (!conn.connected) {
            throw new Error('连接尚未建立');
        }

        const buffer = parsePayload(options.data, options.encoding);
        if (buffer.length === 0) {
            throw new Error('报文内容为空');
        }

        conn.socket.write(buffer);
        conn.bytesSent += buffer.length;
        return { id, length: buffer.length, bytesSent: conn.bytesSent };
    }

    /**
     * 关闭指定 TCP 连接
     * @param {string} id 连接 id
     * @returns {{id: string, closed: boolean}}
     */
    close(id) {
        const conn = this.connections.get(id);
        if (!conn || !conn.socket) {
            return { id, closed: false };
        }

        conn.socket.end();
        return { id, closed: true };
    }

    /**
     * 关闭并清理所有连接
     */
    closeAll() {
        for (const conn of this.connections.values()) {
            if (conn.socket) {
                conn.socket.destroy();
            }
        }
        this.connections.clear();
    }

    getConnection(id) {
        return this.connections.get(id) || null;
    }
}

module.exports = {
    TcpClientManager,
    parsePayload
};
