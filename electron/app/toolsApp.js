const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const logger = require('../log/logger');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const WorkerWithPromise = require('../worker/core/workerWithPromise');
const { DEFAULT_TOOLS_SETTINGS } = require('../const/toolsConst');
const { createHashCompat, createHmacCompat } = require('../utils/hashUtils');
const EventDispatcher = require('../utils/eventDispatcher');
const { TcpClientManager } = require('../utils/tcpClientManager');
const { UdpClientManager } = require('../utils/udpClientManager');

class ToolsApp {
    constructor(ipc, store) {
        this.stringGeneratorConfigFileKey = 'string-generator';
        this.packetParserConfigFileKey = 'packet-parser';
        this.tcpAoMacStateKey = 'tcp-ao-mac';
        this.httpApiTesterConfigFileKey = 'http-api-tester';

        // TCP 工具：连接管理器与事件推送
        this.tcpEventDispatcher = new EventDispatcher();
        this.tcpClientManager = new TcpClientManager((eventType, data) => {
            this.tcpEventDispatcher.emit(eventType, data);
        });

        // UDP 工具：收发管理器与事件推送
        this.udpEventDispatcher = new EventDispatcher();
        this.udpClientManager = new UdpClientManager((eventType, data) => {
            this.udpEventDispatcher.emit(eventType, data);
        });

        this.registerHandlers(ipc);
        this.store = store;

        this.maxMessageHistory = DEFAULT_TOOLS_SETTINGS.packetParser.maxMessageHistory;
        this.maxStringHistory = DEFAULT_TOOLS_SETTINGS.stringGenerator.maxStringHistory;
    }

    registerHandlers(ipc) {
        // 字符串生成器
        ipc.handle('tools:generateString', async (event, templateData) =>
            this.handleGenerateString(event, templateData)
        );
        ipc.handle('tools:getGenerateStringHistory', async () => this.handleGetGenerateStringHistory());
        ipc.handle('tools:clearGenerateStringHistory', async () => this.handleClearGenerateStringHistory());

        // 报文解析器
        ipc.handle('tools:parsePacket', async (event, packetData) => this.handleParsePacket(event, packetData));
        ipc.handle('tools:parsePacketNoSaveHistory', async (event, packetData) =>
            this.handleParsePacketNoSaveHistory(event, packetData)
        );
        ipc.handle('tools:getPacketParserHistory', async () => this.handleGetPacketParserHistory());
        ipc.handle('tools:clearPacketParserHistory', async () => this.handleClearPacketParserHistory());

        // TCP-AO MAC 计算器
        ipc.handle('tools:calculateTcpAoMac', async (event, data) => this.handleCalculateTcpAoMac(event, data));
        ipc.handle('tools:saveTcpAoMacState', async (_event, state) => this.handleSaveTcpAoMacState(state));
        ipc.handle('tools:getTcpAoMacState', async () => this.handleGetTcpAoMacState());

        // HTTP API 测试
        ipc.handle('tools:sendHttpApiRequest', async (_event, requestConfig) =>
            this.handleSendHttpApiRequest(requestConfig)
        );
        ipc.handle('tools:getHttpApiConnections', async () => this.handleGetHttpApiConnections());
        ipc.handle('tools:saveHttpApiConnections', async (_event, connections) =>
            this.handleSaveHttpApiConnections(connections)
        );
        ipc.handle('tools:resetHttpApiConnections', async () => this.handleResetHttpApiConnections());

        // TCP 报文工具
        ipc.handle('tools:tcpConnect', async (event, options) => this.handleTcpConnect(event, options));
        ipc.handle('tools:tcpSend', async (_event, payload) => this.handleTcpSend(payload));
        ipc.handle('tools:tcpClose', async (_event, payload) => this.handleTcpClose(payload));

        // UDP 报文工具
        ipc.handle('tools:udpOpen', async (event, options) => this.handleUdpOpen(event, options));
        ipc.handle('tools:udpSend', async (_event, payload) => this.handleUdpSend(payload));
        ipc.handle('tools:udpClose', async (_event, payload) => this.handleUdpClose(payload));
    }

    handleTcpConnect(event, options) {
        try {
            this.tcpEventDispatcher.setWebContents(event.sender);
            const result = this.tcpClientManager.connect(options || {});
            return successResponse(result, 'TCP连接已发起');
        } catch (error) {
            logger.error('TCP连接失败:', error.message);
            return errorResponse(error.message);
        }
    }

    handleTcpSend(payload = {}) {
        try {
            const result = this.tcpClientManager.send(payload.id, payload);
            return successResponse(result, 'TCP报文已发送');
        } catch (error) {
            logger.error('TCP报文发送失败:', error.message);
            return errorResponse(error.message);
        }
    }

    handleTcpClose(payload = {}) {
        try {
            const result = this.tcpClientManager.close(payload.id);
            return successResponse(result, 'TCP连接已关闭');
        } catch (error) {
            logger.error('TCP连接关闭失败:', error.message);
            return errorResponse(error.message);
        }
    }

    handleUdpOpen(event, options) {
        try {
            this.udpEventDispatcher.setWebContents(event.sender);
            const result = this.udpClientManager.open(options || {});
            return successResponse(result, 'UDP socket已打开');
        } catch (error) {
            logger.error('UDP打开失败:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleUdpSend(payload = {}) {
        try {
            const result = await this.udpClientManager.send(payload.id, payload);
            return successResponse(result, 'UDP报文已发送');
        } catch (error) {
            logger.error('UDP报文发送失败:', error.message);
            return errorResponse(error.message);
        }
    }

    handleUdpClose(payload = {}) {
        try {
            const result = this.udpClientManager.close(payload.id);
            return successResponse(result, 'UDP socket已关闭');
        } catch (error) {
            logger.error('UDP socket关闭失败:', error.message);
            return errorResponse(error.message);
        }
    }

    cloneJson(value) {
        return JSON.parse(JSON.stringify(value));
    }

    makeHttpApiConnectionId(prefix = 'http-api') {
        if (typeof crypto.randomUUID === 'function') {
            return `${prefix}-${crypto.randomUUID()}`;
        }
        return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    jsonBody(value) {
        return JSON.stringify(value, null, 4);
    }

    createDefaultHttpApiConnections() {
        const baseUrl = 'http://127.0.0.1:18080';
        const client = {
            localIp: '127.0.0.1',
            localPort: 11019,
            remoteIp: '127.0.0.1',
            remotePort: 50000
        };
        const session = {
            sessionType: 0,
            sessionRd: '0:0',
            sessionIp: '192.0.2.1',
            sessionAs: 65001
        };
        const instance = {
            instanceType: 3,
            instanceRd: '0:0',
            addrFamilyType: 1
        };
        const routeQuery = {
            client,
            session,
            af: 1,
            ribType: 2,
            page: 1,
            pageSize: 20,
            routeState: 'all',
            prefixFilter: ''
        };
        const instanceRouteQuery = {
            client,
            instance,
            page: 1,
            pageSize: 20,
            routeState: 'all',
            prefixFilter: ''
        };
        const routeKey = '请替换为路由列表接口返回的routeKey';
        const jsonHeaders = [
            { enabled: true, key: 'Accept', value: 'application/json' },
            { enabled: true, key: 'Content-Type', value: 'application/json' }
        ];
        const getHeaders = [{ enabled: true, key: 'Accept', value: 'application/json' }];
        const create = ({ id, name, method, path: apiPath, headers, body = '' }) => ({
            id,
            name,
            method,
            url: `${baseUrl}${apiPath}`,
            headers,
            body,
            timeout: 15000
        });

        return [
            create({
                id: 'api-status',
                name: 'API服务状态',
                method: 'GET',
                path: '/api/v1/status',
                headers: getHeaders
            }),
            create({
                id: 'bmp-status',
                name: 'BMP状态',
                method: 'GET',
                path: '/api/v1/bmp/status',
                headers: getHeaders
            }),
            create({
                id: 'bmp-clients',
                name: 'BMP客户端列表',
                method: 'GET',
                path: '/api/v1/bmp/clients',
                headers: getHeaders
            }),
            create({
                id: 'bmp-sessions',
                name: 'BMP会话列表',
                method: 'POST',
                path: '/api/v1/bmp/sessions',
                headers: jsonHeaders,
                body: this.jsonBody({ client })
            }),
            create({
                id: 'bmp-instances',
                name: 'BMP实例列表',
                method: 'POST',
                path: '/api/v1/bmp/instances',
                headers: jsonHeaders,
                body: this.jsonBody({ client })
            }),
            create({
                id: 'bmp-routes',
                name: 'BMP路由列表',
                method: 'POST',
                path: '/api/v1/bmp/routes',
                headers: jsonHeaders,
                body: this.jsonBody(routeQuery)
            }),
            create({
                id: 'bmp-route-detail',
                name: 'BMP路由详情',
                method: 'POST',
                path: '/api/v1/bmp/routes/detail',
                headers: jsonHeaders,
                body: this.jsonBody({
                    ...routeQuery,
                    routeKey
                })
            }),
            create({
                id: 'bmp-instance-routes',
                name: 'BMP实例路由列表',
                method: 'POST',
                path: '/api/v1/bmp/instances/routes',
                headers: jsonHeaders,
                body: this.jsonBody(instanceRouteQuery)
            }),
            create({
                id: 'bmp-instance-route-detail',
                name: 'BMP实例路由详情',
                method: 'POST',
                path: '/api/v1/bmp/instances/routes/detail',
                headers: jsonHeaders,
                body: this.jsonBody({
                    client,
                    instance,
                    routeKey
                })
            }),
            create({
                id: 'bmp-statistics-session',
                name: 'BMP会话统计',
                method: 'POST',
                path: '/api/v1/bmp/statistics/session',
                headers: jsonHeaders,
                body: this.jsonBody({ client })
            }),
            create({
                id: 'bmp-statistics-instance',
                name: 'BMP实例统计',
                method: 'POST',
                path: '/api/v1/bmp/statistics/instance',
                headers: jsonHeaders,
                body: this.jsonBody({ client })
            })
        ];
    }

    normalizeHeaderRows(headers) {
        if (!Array.isArray(headers)) {
            return [];
        }

        return headers
            .slice(0, 100)
            .map(header => ({
                enabled: header.enabled !== false,
                key: String(header.key || '')
                    .trim()
                    .slice(0, 256),
                value: String(header.value || '').slice(0, 4096)
            }))
            .filter(header => header.key || header.value);
    }

    hasControlChars(value) {
        const text = String(value || '');
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code <= 31 || code === 127) {
                return true;
            }
        }
        return false;
    }

    normalizeHttpApiConnections(connections) {
        if (!Array.isArray(connections)) {
            throw new Error('API连接信息必须是数组');
        }
        if (connections.length > 100) {
            throw new Error('API连接信息最多保存100条');
        }

        const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
        return connections.map((connection, index) => {
            const method = String(connection.method || 'GET').toUpperCase();
            const body =
                typeof connection.body === 'string'
                    ? connection.body
                    : connection.body === undefined || connection.body === null
                      ? ''
                      : this.jsonBody(connection.body);
            const timeout = Number(connection.timeout);

            return {
                id: String(connection.id || this.makeHttpApiConnectionId()).slice(0, 128),
                name: String(connection.name || `API ${index + 1}`)
                    .trim()
                    .slice(0, 80),
                method: methods.has(method) ? method : 'GET',
                url: String(connection.url || '')
                    .trim()
                    .slice(0, 2048),
                headers: this.normalizeHeaderRows(connection.headers),
                body: body.slice(0, 1024 * 1024),
                timeout: Number.isInteger(timeout) && timeout >= 1000 && timeout <= 600000 ? timeout : 15000
            };
        });
    }

    buildRequestHeaders(headers) {
        const requestHeaders = {};
        for (const header of this.normalizeHeaderRows(headers)) {
            if (!header.enabled || !header.key) {
                continue;
            }
            if (this.hasControlChars(header.key) || this.hasControlChars(header.value)) {
                throw new Error(`请求头包含非法控制字符: ${header.key}`);
            }
            requestHeaders[header.key] = header.value;
        }
        return requestHeaders;
    }

    async handleGetHttpApiConnections() {
        try {
            const savedConnections = this.store.get(this.httpApiTesterConfigFileKey);
            const connections = Array.isArray(savedConnections)
                ? this.normalizeHttpApiConnections(savedConnections)
                : this.createDefaultHttpApiConnections();
            return successResponse(this.cloneJson(connections), '获取HTTP API连接信息成功');
        } catch (error) {
            logger.error('获取HTTP API连接信息失败:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleSaveHttpApiConnections(connections) {
        try {
            const normalizedConnections = this.normalizeHttpApiConnections(connections);
            this.store.set(this.httpApiTesterConfigFileKey, normalizedConnections);
            return successResponse(this.cloneJson(normalizedConnections), '保存HTTP API连接信息成功');
        } catch (error) {
            logger.error('保存HTTP API连接信息失败:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleResetHttpApiConnections() {
        try {
            const defaults = this.createDefaultHttpApiConnections();
            this.store.set(this.httpApiTesterConfigFileKey, defaults);
            return successResponse(this.cloneJson(defaults), '重置HTTP API连接信息成功');
        } catch (error) {
            logger.error('重置HTTP API连接信息失败:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleSendHttpApiRequest(requestConfig) {
        try {
            const method = String(requestConfig.method || 'GET').toUpperCase();
            const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
            if (!allowedMethods.has(method)) {
                throw new Error(`不支持的HTTP方法: ${method}`);
            }

            const targetUrl = new URL(String(requestConfig.url || '').trim());
            if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
                throw new Error('仅支持HTTP和HTTPS协议');
            }

            const timeout = Number(requestConfig.timeout);
            const timeoutMs = Number.isInteger(timeout) && timeout >= 1000 && timeout <= 600000 ? timeout : 15000;
            const requestBody = method === 'GET' || method === 'HEAD' ? '' : String(requestConfig.body || '');
            const headers = this.buildRequestHeaders(requestConfig.headers);
            if (requestBody && !Object.keys(headers).some(key => key.toLowerCase() === 'content-length')) {
                headers['Content-Length'] = Buffer.byteLength(requestBody);
            }

            const startedAt = Date.now();
            const client = targetUrl.protocol === 'https:' ? https : http;
            const requestOptions = {
                protocol: targetUrl.protocol,
                hostname: targetUrl.hostname,
                port: targetUrl.port,
                method,
                path: `${targetUrl.pathname}${targetUrl.search}`,
                headers
            };

            if (targetUrl.protocol === 'https:') {
                requestOptions.rejectUnauthorized = requestConfig.rejectUnauthorized !== false;
            }

            const result = await new Promise((resolve, reject) => {
                const req = client.request(requestOptions, res => {
                    const chunks = [];
                    let sizeBytes = 0;

                    res.on('data', chunk => {
                        chunks.push(chunk);
                        sizeBytes += chunk.length;
                    });

                    res.on('end', () => {
                        const responseBuffer = Buffer.concat(chunks);
                        resolve({
                            statusCode: res.statusCode,
                            statusMessage: res.statusMessage,
                            headers: res.headers,
                            body: responseBuffer.toString('utf8'),
                            durationMs: Date.now() - startedAt,
                            sizeBytes,
                            method,
                            url: targetUrl.toString()
                        });
                    });
                });

                req.on('error', reject);
                req.setTimeout(timeoutMs, () => {
                    req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
                });

                if (requestBody) {
                    req.write(requestBody);
                }
                req.end();
            });

            return successResponse(result, 'HTTP API请求完成');
        } catch (error) {
            logger.error('HTTP API请求失败:', error.message);
            return errorResponse(error.message);
        }
    }

    async handleGetGenerateStringHistory() {
        const config = this.store.get(this.stringGeneratorConfigFileKey);
        if (!config) {
            return successResponse([], '获取字符串生成历史记录成功');
        }
        return successResponse(config, '获取字符串生成历史记录成功');
    }

    async handleClearGenerateStringHistory() {
        this.store.set(this.stringGeneratorConfigFileKey, []);
        return successResponse(null, '清空字符串生成历史记录成功');
    }

    async handleGenerateString(event, templateData) {
        logger.info(`${JSON.stringify(templateData)}`);

        try {
            const workerPath = resolveWorkerPath('tools/stringGeneratorWorker.js');

            const workerFactory = new WorkerWithPromise(workerPath);
            const result = await workerFactory.runWorkerWithPromise(workerPath, templateData);

            this.saveGenerateStringToHistory(templateData);

            logger.info('Worker处理结果:', result);
            return successResponse(result, 'Worker处理成功');
        } catch (err) {
            logger.error('Worker处理错误:', err.message);
            return errorResponse(err.message);
        }
    }

    async saveGenerateStringToHistory(result) {
        let config = this.store.get(this.stringGeneratorConfigFileKey);
        if (!config) {
            config = [];
        }

        let isExist = false;
        config.forEach(element => {
            if (
                element.template === result.template &&
                element.placeholder === result.placeholder &&
                element.start === result.start &&
                element.end === result.end
            ) {
                isExist = true;
            }
        });

        if (isExist) {
            return;
        }

        if (config.length >= this.maxStringHistory) {
            config.splice(0, 1);
        }

        config.push(result);
        this.store.set(this.stringGeneratorConfigFileKey, config);
    }

    async saveToHistory(data) {
        let config = this.store.get(this.packetParserConfigFileKey);
        if (!config) {
            config = [];
        }

        let isExist = false;
        config.forEach(element => {
            if (
                element.packetData === data.packetData &&
                element.protocolPort === data.protocolPort &&
                element.protocolType === data.protocolType &&
                element.transportProtocol === data.transportProtocol &&
                element.startLayer === data.startLayer
            ) {
                isExist = true;
            }
        });

        if (isExist) {
            return;
        }

        if (config.length >= this.maxMessageHistory) {
            config.splice(0, 1);
        }

        config.push(data);
        this.store.set(this.packetParserConfigFileKey, config);
    }

    async handleParsePacket(event, packetData) {
        logger.info(`解析报文: ${JSON.stringify(packetData)}`);

        try {
            const workerPath = resolveWorkerPath('tools/packetParserWorker.js');

            // 保存到历史记录
            this.saveToHistory(packetData);

            const workerFactory = new WorkerWithPromise(workerPath);
            const result = await workerFactory.runWorkerWithPromise(workerPath, packetData);

            logger.info('报文解析结果:', result);
            return successResponse(result, '报文解析成功');
        } catch (err) {
            logger.error('报文解析错误:', err.message);
            return errorResponse(err.message);
        }
    }

    async handleParsePacketNoSaveHistory(event, packetData) {
        logger.info(`解析报文: ${JSON.stringify(packetData)}`);

        try {
            const workerPath = resolveWorkerPath('tools/packetParserWorker.js');

            const workerFactory = new WorkerWithPromise(workerPath);
            const result = await workerFactory.runWorkerWithPromise(workerPath, packetData);

            logger.info('报文解析结果:', result);
            return successResponse(result, '报文解析成功');
        } catch (err) {
            logger.error('报文解析错误:', err.message);
            return errorResponse(err.message);
        }
    }

    async handleClearPacketParserHistory() {
        this.store.set(this.packetParserConfigFileKey, []);
        return successResponse(null, '清空报文解析历史记录成功');
    }

    async handleGetPacketParserHistory() {
        const config = this.store.get(this.packetParserConfigFileKey);
        if (!config) {
            return successResponse([], '获取报文解析历史记录成功');
        }

        return successResponse(config, '获取报文解析历史记录成功');
    }

    hexToBuffer(hex) {
        const cleaned = hex.replace(/\s+/g, '').replace(/:/g, '');
        if (cleaned.length === 0) return Buffer.alloc(0);
        if (cleaned.length % 2 !== 0) throw new Error(`十六进制字符串长度不合法: "${hex}"`);
        if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error(`十六进制字符串包含非法字符: "${hex}"`);
        return Buffer.from(cleaned, 'hex');
    }

    parseIpPacket(buf) {
        if (buf.length < 1) throw new Error('IP 报文长度不足');
        const version = buf[0] >> 4;
        if (version === 4) return this.parseIpv4Packet(buf);
        if (version === 6) return this.parseIpv6Packet(buf);
        throw new Error(`不支持的 IP 版本号: ${version}`);
    }

    parseIpv4Packet(buf) {
        if (buf.length < 20) throw new Error('IPv4 报文长度不足（最少 20 字节）');

        const ihl = (buf[0] & 0x0f) * 4;
        if (ihl < 20) throw new Error(`IP 头部长度非法: ${ihl}`);

        const totalLength = buf.readUInt16BE(2);
        if (buf.length < totalLength)
            throw new Error(`报文实际长度 ${buf.length} 小于 Total Length 字段 ${totalLength}`);

        const protocol = buf[9];
        if (protocol !== 6) throw new Error(`IPv4 协议字段不是 TCP，实际: ${protocol}`);

        const srcIp = Buffer.from(buf.subarray(12, 16));
        const dstIp = Buffer.from(buf.subarray(16, 20));

        const tcpLength = totalLength - ihl;
        if (tcpLength < 20) throw new Error(`TCP 段长度不足（最少 20 字节）: ${tcpLength}`);

        const rawTcpSegment = Buffer.from(buf.subarray(ihl, totalLength));

        // IPv4 伪头部：源IP(4) + 目的IP(4) + 00(1) + 协议(1) + TCP段长度(2)
        const pseudoHeader = Buffer.alloc(12);
        srcIp.copy(pseudoHeader, 0);
        dstIp.copy(pseudoHeader, 4);
        pseudoHeader[8] = 0;
        pseudoHeader[9] = protocol;
        pseudoHeader.writeUInt16BE(tcpLength, 10);

        return { version: 4, pseudoHeader, rawTcpSegment, srcIp, dstIp };
    }

    parseIpv6Packet(buf) {
        if (buf.length < 40) throw new Error('IPv6 报文长度不足（最少 40 字节）');

        const payloadLength = buf.readUInt16BE(4);
        let nextHeader = buf[6];
        const srcIp = Buffer.from(buf.subarray(8, 24));
        const dstIp = Buffer.from(buf.subarray(24, 40));

        const declaredEnd = 40 + payloadLength;
        if (buf.length < declaredEnd) {
            throw new Error(`报文实际长度 ${buf.length} 小于 IPv6 Payload Length+40 字段 ${declaredEnd}`);
        }

        // 需要按 Next Header 链逐级跳过扩展头，直到遇到 TCP(6)。
        // 0:HBH, 43:Routing, 44:Fragment(定长 8B), 51:AH(长度单位为 4B), 60:DstOpts, 135:Mobility, 139:HIP, 140:Shim6
        const EXT_HEADERS = new Set([0, 43, 44, 51, 60, 135, 139, 140]);
        let offset = 40;
        while (EXT_HEADERS.has(nextHeader)) {
            if (offset + 2 > declaredEnd) throw new Error('IPv6 扩展头部解析越界');
            const kind = nextHeader;
            nextHeader = buf[offset];
            let extLen;
            if (kind === 44) {
                extLen = 8; // Fragment header
            } else if (kind === 51) {
                extLen = (buf[offset + 1] + 2) * 4; // AH: Payload Length 以 4 字节为单位，再 +2
            } else {
                extLen = (buf[offset + 1] + 1) * 8; // 其它扩展头: Hdr Ext Len 以 8 字节为单位，再 +1
            }
            offset += extLen;
            if (offset > declaredEnd) throw new Error('IPv6 扩展头部超出 Payload Length');
        }

        if (nextHeader !== 6) throw new Error(`IPv6 上层协议不是 TCP，实际: ${nextHeader}`);

        const tcpLength = declaredEnd - offset;
        if (tcpLength < 20) throw new Error(`TCP 段长度不足（最少 20 字节）: ${tcpLength}`);

        const rawTcpSegment = Buffer.from(buf.subarray(offset, declaredEnd));

        // IPv6 伪头部 (RFC 8200 §8.1)：源IP(16) + 目的IP(16) + 上层包长度(4) + 零(3) + Next Header(1)
        const pseudoHeader = Buffer.alloc(40);
        srcIp.copy(pseudoHeader, 0);
        dstIp.copy(pseudoHeader, 16);
        pseudoHeader.writeUInt32BE(tcpLength, 32);
        pseudoHeader[36] = 0;
        pseudoHeader[37] = 0;
        pseudoHeader[38] = 0;
        pseudoHeader[39] = 6;

        return { version: 6, pseudoHeader, rawTcpSegment, srcIp, dstIp };
    }

    extractTcpAoOptions(tcpSegment) {
        const dataOffset = (tcpSegment[12] >> 4) * 4;
        if (dataOffset <= 20 || dataOffset > tcpSegment.length) return Buffer.alloc(0);
        const options = [];
        let i = 20;
        while (i < dataOffset) {
            const kind = tcpSegment[i];
            if (kind === 0) break;
            if (kind === 1) {
                i++;
                continue;
            }
            if (i + 1 >= dataOffset) break;
            const len = tcpSegment[i + 1];
            if (len < 2 || i + len > dataOffset) break;
            if (kind === 29) {
                options.push(Buffer.from(tcpSegment.subarray(i, i + len)));
            }
            i += len;
        }
        return Buffer.concat(options);
    }

    buildTcpSegmentForMac(rawTcpSegment, includeOtherOptions) {
        const normalized = Buffer.from(rawTcpSegment);
        normalized[16] = 0;
        normalized[17] = 0;

        const dataOffset = (normalized[12] >> 4) * 4;
        if (dataOffset < 20 || dataOffset > rawTcpSegment.length) {
            throw new Error(`TCP Data Offset 非法: ${dataOffset}`);
        }

        const header = Buffer.from(normalized.subarray(0, 20));
        const options = includeOtherOptions
            ? Buffer.from(normalized.subarray(20, dataOffset))
            : this.extractTcpAoOptions(normalized);
        const payload = Buffer.from(normalized.subarray(dataOffset));

        return Buffer.concat([header, options, payload]);
    }

    // RFC 4615: 将任意长度的 master key 规范化为 16 字节 AES 密钥
    normalizeAesKey(keyBuf) {
        if (keyBuf.length === 16) return keyBuf;
        return this.computeAesCmac(Buffer.alloc(16, 0), keyBuf);
    }

    // RFC 4493: AES-128-CMAC
    computeAesCmac(key, msg) {
        const Rb = Buffer.from('00000000000000000000000000000087', 'hex');
        const aesBlock = data => {
            const c = crypto.createCipheriv('aes-128-ecb', key, null);
            c.setAutoPadding(false);
            return Buffer.concat([c.update(data), c.final()]);
        };
        const shiftLeft = buf => {
            const out = Buffer.allocUnsafe(16);
            for (let i = 0; i < 15; i++) out[i] = ((buf[i] << 1) | (buf[i + 1] >> 7)) & 0xff;
            out[15] = (buf[15] << 1) & 0xff;
            return out;
        };
        const xor16 = (a, b) => {
            const r = Buffer.allocUnsafe(16);
            for (let i = 0; i < 16; i++) r[i] = a[i] ^ b[i];
            return r;
        };
        const L = aesBlock(Buffer.alloc(16, 0));
        const K1 = shiftLeft(L);
        if (L[0] & 0x80) for (let i = 0; i < 16; i++) K1[i] ^= Rb[i];
        const K2 = shiftLeft(K1);
        if (K1[0] & 0x80) for (let i = 0; i < 16; i++) K2[i] ^= Rb[i];

        const n = Math.max(1, Math.ceil(msg.length / 16));
        const complete = msg.length > 0 && msg.length % 16 === 0;
        let last = Buffer.alloc(16, 0);
        if (complete) {
            msg.copy(last, 0, (n - 1) * 16);
            last = xor16(last, K1);
        } else {
            const rem = msg.length % 16;
            msg.copy(last, 0, msg.length - rem);
            last[rem] = 0x80;
            last = xor16(last, K2);
        }
        let X = Buffer.alloc(16, 0);
        for (let i = 0; i < n - 1; i++) {
            X = aesBlock(xor16(X, msg.subarray(i * 16, (i + 1) * 16)));
        }
        return aesBlock(xor16(X, last));
    }

    zeroTcpAoMacField(tcpSegment) {
        const result = Buffer.from(tcpSegment);
        const dataOffset = Math.min((result[12] >> 4) * 4, result.length);
        let i = 20;
        while (i < dataOffset) {
            const kind = result[i];
            if (kind === 0) break;
            if (kind === 1) {
                i++;
                continue;
            }
            if (i + 1 >= dataOffset) break;
            const len = result[i + 1];
            if (len < 2 || i + len > dataOffset) break;
            if (kind === 29 && len >= 4) {
                result.fill(0, i + 4, i + len);
            }
            i += len;
        }
        return result;
    }

    getTcpAoMacFieldLength(tcpSegment) {
        const dataOffset = Math.min((tcpSegment[12] >> 4) * 4, tcpSegment.length);
        let i = 20;
        while (i < dataOffset) {
            const kind = tcpSegment[i];
            if (kind === 0) break;
            if (kind === 1) {
                i++;
                continue;
            }
            if (i + 1 >= dataOffset) break;
            const len = tcpSegment[i + 1];
            if (len < 2 || i + len > dataOffset) break;
            if (kind === 29 && len >= 4) {
                return len - 4;
            }
            i += len;
        }
        return null;
    }

    extractTcpAoKdfContext(parsed, rawTcpSegment) {
        return {
            srcIp: parsed.srcIp,
            dstIp: parsed.dstIp,
            srcPort: rawTcpSegment.readUInt16BE(0),
            dstPort: rawTcpSegment.readUInt16BE(2),
            isnA: rawTcpSegment.readUInt32BE(4),
            isnB: rawTcpSegment.readUInt32BE(8)
        };
    }

    buildTcpAoKdfInput(srcIp, dstIp, srcPort, dstPort, isnA, isnB, outputBits) {
        // RFC 5926 §3.1.1.2: CONTEXT = src_IP || dst_IP || src_port || dst_port || src_ISN || dst_ISN
        // IPv4 地址占 4 字节、IPv6 地址占 16 字节，上层端口和 ISN 字段宽度不变。
        if (srcIp.length !== dstIp.length) {
            throw new Error(`TCP-AO KDF context 中源/目的地址长度不一致: ${srcIp.length} vs ${dstIp.length}`);
        }
        const label = Buffer.from('TCP-AO', 'ascii');
        const ipLen = srcIp.length;
        const context = Buffer.alloc(ipLen * 2 + 12);
        srcIp.copy(context, 0);
        dstIp.copy(context, ipLen);
        context.writeUInt16BE(srcPort, ipLen * 2);
        context.writeUInt16BE(dstPort, ipLen * 2 + 2);
        context.writeUInt32BE(isnA, ipLen * 2 + 4);
        context.writeUInt32BE(isnB, ipLen * 2 + 8);

        const length = Buffer.alloc(2);
        length.writeUInt16BE(outputBits, 0);
        return Buffer.concat([Buffer.from([0x01]), label, context, length]);
    }

    computePlainHashWithKey(algorithm, keyBuf, msgBuf) {
        const hash = createHashCompat(algorithm);
        hash.update(msgBuf);
        hash.update(keyBuf);
        return hash.digest();
    }

    parseOptionalUint32Input(value, fieldName) {
        if (value === undefined || value === null) return null;
        const text = String(value).trim();
        if (!text) return null;

        let num;
        if (/^0x[0-9a-fA-F]+$/.test(text)) {
            num = Number.parseInt(text.slice(2), 16);
        } else if (/^\d+$/.test(text)) {
            num = Number.parseInt(text, 10);
        } else {
            throw new Error(`${fieldName} 必须是十进制或 0x 十六进制的 32 位无符号整数`);
        }

        if (!Number.isInteger(num) || num < 0 || num > 0xffffffff) {
            throw new Error(`${fieldName} 超出 32 位无符号整数范围`);
        }
        return num >>> 0;
    }

    deriveTrafficKey(masterKeyBuf, srcIp, dstIp, srcPort, dstPort, isnA, isnB, hashAlgo) {
        // RFC 5926 标准定义了 HMAC-SHA1 / AES-128-CMAC。
        // 这里保留 SHA-256 / HMAC-MD5 这类实验性 PRF，方便和厂商实现做比对。
        const lengthBitsMap = {
            sha1: 0x00a0,
            md5: 0x0080,
            sha256: 0x0100,
            sha384: 0x0180,
            sha512: 0x0200,
            sm3: 0x0100,
            'aes-cmac': 0x0080
        };
        const outputBits = lengthBitsMap[hashAlgo];
        if (!outputBits) {
            throw new Error(`Unsupported TCP-AO KDF algorithm: ${hashAlgo}`);
        }

        const kdfInput = this.buildTcpAoKdfInput(srcIp, dstIp, srcPort, dstPort, isnA, isnB, outputBits);
        if (hashAlgo === 'aes-cmac') {
            return this.computeAesCmac(this.normalizeAesKey(masterKeyBuf), kdfInput);
        }

        const prfMap = {
            sha1: 'sha1',
            md5: 'md5',
            sha256: 'sha256',
            sha384: 'sha384',
            sha512: 'sha512',
            sm3: 'sm3'
        };
        const prfAlgo = prfMap[hashAlgo];
        if (!prfAlgo) {
            throw new Error(`Unsupported TCP-AO PRF algorithm: ${hashAlgo}`);
        }

        return createHmacCompat(prfAlgo, masterKeyBuf).update(kdfInput).digest();
    }

    derivePlainTrafficKey(masterKeyBuf, srcIp, dstIp, srcPort, dstPort, isnA, isnB, algorithm) {
        const outputBitsMap = { md5: 0x0080, sha1: 0x00a0, sha256: 0x0100, sm3: 0x0100 };
        const outputBits = outputBitsMap[algorithm];
        if (!outputBits) {
            throw new Error(`Unsupported plain KDF algorithm: ${algorithm}`);
        }

        const kdfInput = this.buildTcpAoKdfInput(srcIp, dstIp, srcPort, dstPort, isnA, isnB, outputBits);
        return this.computePlainHashWithKey(algorithm, masterKeyBuf, kdfInput);
    }

    async handleCalculateTcpAoMac(
        _event,
        { key, sne, ipPacket, includeOtherOptions, algorithm, skipKdf, isnA, isnB, includePseudoHeader }
    ) {
        try {
            const keyBuf = Buffer.from(key, 'utf8');
            const sneBuf = sne && sne.trim() ? this.hexToBuffer(sne) : Buffer.alloc(0);
            const ipBuf = this.hexToBuffer(ipPacket);

            const parsed = this.parseIpPacket(ipBuf);
            const { pseudoHeader, rawTcpSegment } = parsed;
            const tcpSegment = this.buildTcpSegmentForMac(this.zeroTcpAoMacField(rawTcpSegment), includeOtherOptions);

            const pseudoPart = includePseudoHeader ? pseudoHeader : Buffer.alloc(0);
            const msgBuf = Buffer.concat([sneBuf, pseudoPart, tcpSegment]);
            let macFull,
                trafficKeyHex = null;

            // 各算法标准 MAC 截断长度（字节）
            const macLenMap = {
                'hmac-sha1': 12,
                'hmac-sha1-20': 20,
                'hmac-md5': 12,
                'hmac-sha256': 12,
                'hmac-sha384': 12,
                'hmac-sha512': 12,
                'hmac-sm3': 12,
                'aes-cmac': 12,
                md5: 16,
                sha1: 20,
                sha256: 32,
                sm3: 32
            };
            const packetMacLen = this.getTcpAoMacFieldLength(rawTcpSegment);
            const macLen = packetMacLen ?? macLenMap[algorithm] ?? 12;
            const kdfContext = this.extractTcpAoKdfContext(parsed, rawTcpSegment);
            const effectiveIsnA = this.parseOptionalUint32Input(isnA, 'ISN A') ?? kdfContext.isnA;
            const effectiveIsnB = this.parseOptionalUint32Input(isnB, 'ISN B') ?? kdfContext.isnB;

            const PLAIN_ALGOS = ['md5', 'sha1', 'sha256', 'sm3'];
            if (PLAIN_ALGOS.includes(algorithm)) {
                let plainKeyBuf = keyBuf;
                if (!skipKdf) {
                    plainKeyBuf = this.derivePlainTrafficKey(
                        keyBuf,
                        kdfContext.srcIp,
                        kdfContext.dstIp,
                        kdfContext.srcPort,
                        kdfContext.dstPort,
                        effectiveIsnA,
                        effectiveIsnB,
                        algorithm
                    );
                    trafficKeyHex = plainKeyBuf.toString('hex').toUpperCase();
                }
                macFull = this.computePlainHashWithKey(algorithm, plainKeyBuf, msgBuf);
            } else {
                // HMAC / AES-128-CMAC
                const kdfAlgoMap = {
                    'hmac-sha1': 'sha1',
                    'hmac-sha1-20': 'sha1',
                    'hmac-md5': 'md5',
                    'hmac-sha256': 'sha256',
                    'hmac-sha384': 'sha384',
                    'hmac-sha512': 'sha512',
                    'hmac-sm3': 'sm3',
                    'aes-cmac': 'aes-cmac'
                };
                let hmacKey;
                if (skipKdf) {
                    hmacKey = keyBuf;
                } else {
                    hmacKey = this.deriveTrafficKey(
                        keyBuf,
                        kdfContext.srcIp,
                        kdfContext.dstIp,
                        kdfContext.srcPort,
                        kdfContext.dstPort,
                        effectiveIsnA,
                        effectiveIsnB,
                        kdfAlgoMap[algorithm]
                    );
                    trafficKeyHex = hmacKey.toString('hex').toUpperCase();
                }
                if (algorithm === 'aes-cmac') {
                    macFull = this.computeAesCmac(this.normalizeAesKey(hmacKey), msgBuf);
                } else {
                    const nodeAlgo = {
                        'hmac-sha1': 'sha1',
                        'hmac-sha1-20': 'sha1',
                        'hmac-md5': 'md5',
                        'hmac-sha256': 'sha256',
                        'hmac-sha384': 'sha384',
                        'hmac-sha512': 'sha512',
                        'hmac-sm3': 'sm3'
                    }[algorithm];
                    if (!nodeAlgo) {
                        throw new Error(`Unsupported TCP-AO MAC algorithm: ${algorithm}`);
                    }
                    macFull = createHmacCompat(nodeAlgo, hmacKey).update(msgBuf).digest();
                }
            }

            const mac96 = macFull.subarray(0, macLen).toString('hex').toUpperCase();
            return successResponse(
                {
                    ipVersion: parsed.version,
                    pseudoHeaderHex: pseudoHeader.toString('hex').toUpperCase(),
                    messageHex: msgBuf.toString('hex').toUpperCase(),
                    trafficKeyHex,
                    mac: macFull.toString('hex').toUpperCase(),
                    mac96,
                    macLen
                },
                'TCP-AO MAC 计算成功'
            );
        } catch (err) {
            logger.error('TCP-AO MAC 计算错误:', err.message);
            return errorResponse(err.message);
        }
    }

    handleSaveTcpAoMacState(state) {
        this.store.set(this.tcpAoMacStateKey, state);
        return successResponse(null, '保存成功');
    }

    handleGetTcpAoMacState() {
        const state = this.store.get(this.tcpAoMacStateKey);
        return successResponse(state || null, '获取成功');
    }

    setMaxMessageHistory(maxMessageHistory) {
        this.maxMessageHistory = maxMessageHistory;
    }

    setMaxStringHistory(maxStringHistory) {
        this.maxStringHistory = maxStringHistory;
    }
}

module.exports = ToolsApp;
