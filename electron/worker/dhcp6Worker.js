const dgram = require('dgram');
const os = require('os');
const net = require('net');
const logger = require('../log/logger');
const WorkerMessageHandler = require('./workerMessageHandler');
const Dhcp6Lease = require('./dhcp6Lease');
const Dhcp6Const = require('../const/dhcp6Const');

// ========== IPv6 工具函数 ==========
function ipv6ToBuffer(addr) {
    if (!net.isIPv6(addr)) throw new Error(`无效IPv6地址: ${addr}`);
    const halves = addr.split('::');
    let groups;
    if (halves.length === 2) {
        const left = halves[0] ? halves[0].split(':') : [];
        const right = halves[1] ? halves[1].split(':') : [];
        const fill = Array(8 - left.length - right.length).fill('0');
        groups = [...left, ...fill, ...right];
    } else {
        groups = addr.split(':');
    }
    const buf = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) buf.writeUInt16BE(parseInt(groups[i] || '0', 16), i * 2);
    return buf;
}

function bufferToIpv6(buf) {
    const groups = [];
    for (let i = 0; i < 8; i++) groups.push(buf.readUInt16BE(i * 2).toString(16));

    // :: 压缩：找最长连续零段
    let bestStart = -1,
        bestLen = 0,
        curStart = -1,
        curLen = 0;
    for (let i = 0; i < 8; i++) {
        if (groups[i] === '0') {
            if (curStart === -1) {
                curStart = i;
                curLen = 0;
            }
            curLen++;
            if (curLen > bestLen) {
                bestLen = curLen;
                bestStart = curStart;
            }
        } else {
            curStart = -1;
            curLen = 0;
        }
    }
    if (bestLen > 1) {
        const left = groups.slice(0, bestStart);
        const right = groups.slice(bestStart + bestLen);
        return (left.length ? left.join(':') : '') + '::' + (right.length ? right.join(':') : '');
    }
    return groups.join(':');
}

function incrementIpv6(buf) {
    const result = Buffer.from(buf);
    for (let i = 15; i >= 0; i--) {
        if (result[i] < 255) {
            result[i]++;
            break;
        }
        result[i] = 0;
    }
    return result;
}

// 生成服务器 DUID-LL（类型3: link-layer address）
function generateServerDuid() {
    const duid = Buffer.alloc(10);
    duid.writeUInt16BE(3, 0); // DUID-LL type
    duid.writeUInt16BE(1, 2); // hardware type: Ethernet
    for (let i = 4; i < 10; i++) duid[i] = Math.floor(Math.random() * 256);
    return duid;
}

// ========== DHCPv6 报文解析 ==========
function parseDhcp6Packet(buf) {
    if (buf.length < 4) return null;
    const packet = {
        msgType: buf.readUInt8(0),
        txId: buf.slice(1, 4),
        options: {}
    };
    let i = 4;
    while (i + 4 <= buf.length) {
        const code = buf.readUInt16BE(i);
        const len = buf.readUInt16BE(i + 2);
        i += 4;
        if (i + len > buf.length) break;
        packet.options[code] = buf.slice(i, i + len);
        i += len;
    }
    // 提取常用字段
    if (packet.options[Dhcp6Const.DHCP6_OPTS.CLIENTID]) {
        packet.clientDuid = packet.options[Dhcp6Const.DHCP6_OPTS.CLIENTID].toString('hex');
    }
    if (packet.options[Dhcp6Const.DHCP6_OPTS.SERVERID]) {
        packet.serverDuid = packet.options[Dhcp6Const.DHCP6_OPTS.SERVERID].toString('hex');
    }
    if (packet.options[Dhcp6Const.DHCP6_OPTS.IA_NA]) {
        const iaNa = packet.options[Dhcp6Const.DHCP6_OPTS.IA_NA];
        if (iaNa.length >= 12) {
            packet.iaid = iaNa.slice(0, 4).toString('hex');
            packet.iaNaT1 = iaNa.readUInt32BE(4);
            packet.iaNaT2 = iaNa.readUInt32BE(8);
            // 解析 IA_NA 内的子选项
            if (iaNa.length > 12) {
                let j = 12;
                while (j + 4 <= iaNa.length) {
                    const subCode = iaNa.readUInt16BE(j);
                    const subLen = iaNa.readUInt16BE(j + 2);
                    j += 4;
                    if (subCode === Dhcp6Const.DHCP6_OPTS.IAADDR && subLen >= 24) {
                        packet.requestedIp = bufferToIpv6(iaNa.slice(j, j + 16));
                    }
                    j += subLen;
                }
            }
        }
    }
    return packet;
}

// ========== DHCPv6 报文构建 ==========
function buildOption(code, data) {
    const buf = Buffer.alloc(4 + data.length);
    buf.writeUInt16BE(code, 0);
    buf.writeUInt16BE(data.length, 2);
    data.copy(buf, 4);
    return buf;
}

function buildIaAddr(ipv6Buf, preferredLifetime, validLifetime) {
    const data = Buffer.alloc(24);
    ipv6Buf.copy(data, 0);
    data.writeUInt32BE(preferredLifetime, 16);
    data.writeUInt32BE(validLifetime, 20);
    return buildOption(Dhcp6Const.DHCP6_OPTS.IAADDR, data);
}

function buildIaNa(iaidBuf, t1, t2, iaAddrOpt) {
    const data = Buffer.alloc(12 + iaAddrOpt.length);
    iaidBuf.copy(data, 0);
    data.writeUInt32BE(t1, 4);
    data.writeUInt32BE(t2, 8);
    iaAddrOpt.copy(data, 12);
    return buildOption(Dhcp6Const.DHCP6_OPTS.IA_NA, data);
}

function buildStatusCode(code, msg) {
    const msgBuf = Buffer.from(msg, 'utf8');
    const data = Buffer.alloc(2 + msgBuf.length);
    data.writeUInt16BE(code, 0);
    msgBuf.copy(data, 2);
    return buildOption(Dhcp6Const.DHCP6_OPTS.STATUS_CODE, data);
}

function buildDhcp6Response(msgType, txId, optionList) {
    let totalLen = 4;
    for (const opt of optionList) totalLen += opt.length;

    const buf = Buffer.alloc(totalLen);
    buf.writeUInt8(msgType, 0);
    txId.copy(buf, 1);

    let off = 4;
    for (const opt of optionList) {
        opt.copy(buf, off);
        off += opt.length;
    }
    return buf;
}

// ========== DHCPv6 Worker ==========
class Dhcp6Worker {
    constructor() {
        this.server = null;
        this.config = null;
        this.serverDuid = generateServerDuid();
        this.leaseMap = new Map(); // clientDuid -> Dhcp6Lease
        this.ipToClient = new Map(); // ipStr -> clientDuid
        this.poolStartBuf = null;
        this.poolEndBuf = null;
        this.leaseTimer = null;

        this.messageHandler = new WorkerMessageHandler();
        this.messageHandler.init();
        this.messageHandler.registerHandler(Dhcp6Const.DHCP6_REQ_TYPES.START_DHCP6, this.startDhcp6.bind(this));
        this.messageHandler.registerHandler(Dhcp6Const.DHCP6_REQ_TYPES.STOP_DHCP6, this.stopDhcp6.bind(this));
        this.messageHandler.registerHandler(Dhcp6Const.DHCP6_REQ_TYPES.GET_LEASE_LIST, this.getLeaseList.bind(this));
        this.messageHandler.registerHandler(Dhcp6Const.DHCP6_REQ_TYPES.RELEASE_LEASE, this.releaseLease.bind(this));
    }

    allocateIp(clientDuid) {
        if (this.leaseMap.has(clientDuid)) return this.leaseMap.get(clientDuid).ip;

        let cur = Buffer.from(this.poolStartBuf);
        while (Buffer.compare(cur, this.poolEndBuf) <= 0) {
            const ipStr = bufferToIpv6(cur);
            if (!this.ipToClient.has(ipStr)) return ipStr;
            cur = incrementIpv6(cur);
        }
        return null; // 池已耗尽
    }

    handleSolicit(packet, rinfo) {
        const { clientDuid, iaid, txId } = packet;
        if (!clientDuid || !iaid) return;

        const assignedIp = this.allocateIp(clientDuid);
        if (!assignedIp) {
            logger.warn(`DHCPv6: IP池已耗尽，拒绝 ${clientDuid}`);
            return;
        }

        logger.info(`DHCPv6 SOLICIT from ${clientDuid}, 提供 ${assignedIp}`);

        const t1 = Math.floor(this.config.validLifetime * 0.5);
        const t2 = Math.floor(this.config.validLifetime * 0.875);
        const iaAddrOpt = buildIaAddr(
            ipv6ToBuffer(assignedIp),
            this.config.preferredLifetime,
            this.config.validLifetime
        );
        const iaNaOpt = buildIaNa(Buffer.from(iaid, 'hex'), t1, t2, iaAddrOpt);

        const opts = [
            buildOption(Dhcp6Const.DHCP6_OPTS.SERVERID, this.serverDuid),
            buildOption(Dhcp6Const.DHCP6_OPTS.CLIENTID, Buffer.from(clientDuid, 'hex')),
            iaNaOpt
        ];
        if (this.config.dns1 || this.config.dns2) {
            const dnsList = [this.config.dns1, this.config.dns2].filter(Boolean).map(ipv6ToBuffer);
            opts.push(buildOption(Dhcp6Const.DHCP6_OPTS.DNS_SERVERS, Buffer.concat(dnsList)));
        }

        const resp = buildDhcp6Response(Dhcp6Const.DHCP6_MSG_TYPES.ADVERTISE, txId, opts);
        this.server.send(resp, 0, resp.length, rinfo.port, rinfo.address, err => {
            if (err) logger.error(`DHCPv6: 发送ADVERTISE失败: ${err.message}`);
        });
    }

    handleRequest(packet, rinfo) {
        const { clientDuid, iaid, serverDuid, txId, requestedIp } = packet;
        if (!clientDuid || !iaid) return;

        // 校验 Server ID 是否匹配
        if (serverDuid && serverDuid !== this.serverDuid.toString('hex')) {
            logger.info(`DHCPv6 REQUEST: 目标服务器不是本机，忽略`);
            return;
        }

        const assignedIp = requestedIp || this.allocateIp(clientDuid);
        if (!assignedIp) {
            // 无地址可用
            const naOpt = buildIaNa(
                Buffer.from(iaid, 'hex'),
                0,
                0,
                buildStatusCode(Dhcp6Const.DHCP6_STATUS.NO_ADDRS_AVAIL, 'No addresses available')
            );
            const opts = [
                buildOption(Dhcp6Const.DHCP6_OPTS.SERVERID, this.serverDuid),
                buildOption(Dhcp6Const.DHCP6_OPTS.CLIENTID, Buffer.from(clientDuid, 'hex')),
                naOpt
            ];
            const resp = buildDhcp6Response(Dhcp6Const.DHCP6_MSG_TYPES.REPLY, txId, opts);
            this.server.send(resp, 0, resp.length, rinfo.port, rinfo.address, err => {
                if (err) logger.error(`DHCPv6: 发送REPLY(NoAddrs)失败: ${err.message}`);
            });
            return;
        }

        // 记录租约
        const t1 = Math.floor(this.config.validLifetime * 0.5);
        const t2 = Math.floor(this.config.validLifetime * 0.875);

        if (this.leaseMap.has(clientDuid)) {
            const lease = this.leaseMap.get(clientDuid);
            lease.renew(this.config.preferredLifetime, this.config.validLifetime);
            this.messageHandler.sendEvent(Dhcp6Const.DHCP6_EVT_TYPES.DHCP6_EVT, {
                type: Dhcp6Const.DHCP6_SUB_EVT_TYPES.DHCP6_SUB_EVT_LEASE,
                opType: 'update',
                data: lease.getInfo()
            });
            logger.info(`DHCPv6 续约: ${clientDuid} -> ${assignedIp}`);
        } else {
            const lease = new Dhcp6Lease(
                clientDuid,
                assignedIp,
                iaid,
                this.config.preferredLifetime,
                this.config.validLifetime
            );
            this.leaseMap.set(clientDuid, lease);
            this.ipToClient.set(assignedIp, clientDuid);
            this.messageHandler.sendEvent(Dhcp6Const.DHCP6_EVT_TYPES.DHCP6_EVT, {
                type: Dhcp6Const.DHCP6_SUB_EVT_TYPES.DHCP6_SUB_EVT_LEASE,
                opType: 'add',
                data: lease.getInfo()
            });
            logger.info(`DHCPv6 新租约: ${clientDuid} -> ${assignedIp}`);
        }

        const iaAddrOpt = buildIaAddr(
            ipv6ToBuffer(assignedIp),
            this.config.preferredLifetime,
            this.config.validLifetime
        );
        const iaNaOpt = buildIaNa(Buffer.from(iaid, 'hex'), t1, t2, iaAddrOpt);
        const opts = [
            buildOption(Dhcp6Const.DHCP6_OPTS.SERVERID, this.serverDuid),
            buildOption(Dhcp6Const.DHCP6_OPTS.CLIENTID, Buffer.from(clientDuid, 'hex')),
            iaNaOpt
        ];
        if (this.config.dns1 || this.config.dns2) {
            const dnsList = [this.config.dns1, this.config.dns2].filter(Boolean).map(ipv6ToBuffer);
            opts.push(buildOption(Dhcp6Const.DHCP6_OPTS.DNS_SERVERS, Buffer.concat(dnsList)));
        }
        const resp = buildDhcp6Response(Dhcp6Const.DHCP6_MSG_TYPES.REPLY, txId, opts);
        this.server.send(resp, 0, resp.length, rinfo.port, rinfo.address, err => {
            if (err) logger.error(`DHCPv6: 发送REPLY失败: ${err.message}`);
        });
    }

    handleRelease(packet, rinfo) {
        const { clientDuid, iaid, txId } = packet;
        if (!clientDuid) return;

        if (this.leaseMap.has(clientDuid)) {
            const lease = this.leaseMap.get(clientDuid);
            this.ipToClient.delete(lease.ip);
            this.leaseMap.delete(clientDuid);
            logger.info(`DHCPv6 RELEASE: ${clientDuid} 释放 ${lease.ip}`);
            this.messageHandler.sendEvent(Dhcp6Const.DHCP6_EVT_TYPES.DHCP6_EVT, {
                type: Dhcp6Const.DHCP6_SUB_EVT_TYPES.DHCP6_SUB_EVT_LEASE,
                opType: 'remove',
                data: { duid: clientDuid, ip: lease.ip }
            });
        }

        // 回复 REPLY
        if (txId && iaid) {
            const naOpt = buildIaNa(
                Buffer.from(iaid, 'hex'),
                0,
                0,
                buildStatusCode(Dhcp6Const.DHCP6_STATUS.SUCCESS, 'Released')
            );
            const opts = [
                buildOption(Dhcp6Const.DHCP6_OPTS.SERVERID, this.serverDuid),
                buildOption(Dhcp6Const.DHCP6_OPTS.CLIENTID, Buffer.from(clientDuid, 'hex')),
                naOpt
            ];
            const resp = buildDhcp6Response(Dhcp6Const.DHCP6_MSG_TYPES.REPLY, txId, opts);
            this.server.send(resp, 0, resp.length, rinfo.port, rinfo.address, () => {});
        }
    }

    startDhcp6(messageId, config) {
        this.config = config;
        if (this.config.logLevel) {
            logger.setLevel(this.config.logLevel);
            logger.info(`Worker log level set to: ${this.config.logLevel}`);
        }
        const listenPort = Number.isInteger(Number(this.config.serverPort))
            ? Number(this.config.serverPort)
            : Dhcp6Const.DEFAULT_DHCP6_CONFIG.serverPort;
        this.poolStartBuf = ipv6ToBuffer(config.poolStart);
        this.poolEndBuf = ipv6ToBuffer(config.poolEnd);

        try {
            this.server = dgram.createSocket({ type: 'udp6', reuseAddr: true });

            let started = false;
            this.server.on('error', err => {
                logger.error(`DHCPv6服务器错误: ${err.message}`);
                if (!started) {
                    let hint = '';
                    if (err.code === 'EACCES' || err.code === 'EPERM') {
                        hint = `（绑定 UDP ${listenPort} 端口需要管理员/root 权限）`;
                    } else if (err.code === 'EADDRINUSE') {
                        hint = `（UDP ${listenPort} 端口已被占用，可修改监听端口后重试）`;
                    }
                    this.messageHandler.sendErrorResponse(messageId, `DHCPv6服务器启动失败: ${err.message}${hint}`);
                    this.server = null;
                }
            });

            this.server.on('message', (msg, rinfo) => {
                try {
                    const packet = parseDhcp6Packet(msg);
                    if (!packet) return;
                    logger.info(`DHCPv6收到消息类型 ${packet.msgType} from [${rinfo.address}]:${rinfo.port}`);

                    switch (packet.msgType) {
                        case Dhcp6Const.DHCP6_MSG_TYPES.SOLICIT:
                            this.handleSolicit(packet, rinfo);
                            break;
                        case Dhcp6Const.DHCP6_MSG_TYPES.REQUEST:
                        case Dhcp6Const.DHCP6_MSG_TYPES.RENEW:
                        case Dhcp6Const.DHCP6_MSG_TYPES.REBIND:
                        case Dhcp6Const.DHCP6_MSG_TYPES.CONFIRM:
                            this.handleRequest(packet, rinfo);
                            break;
                        case Dhcp6Const.DHCP6_MSG_TYPES.RELEASE:
                            this.handleRelease(packet, rinfo);
                            break;
                        default:
                            logger.info(`DHCPv6: 忽略消息类型 ${packet.msgType}`);
                    }
                } catch (e) {
                    logger.error(`DHCPv6处理消息出错: ${e.message}`);
                }
            });

            this.server.bind({ port: listenPort, address: '::' }, () => {
                started = true;
                // 加入所有非回环 IPv6 接口的多播组
                const ifaces = os.networkInterfaces();
                for (const addrs of Object.values(ifaces)) {
                    for (const addr of addrs) {
                        if (addr.family === 'IPv6' && !addr.internal) {
                            try {
                                this.server.addMembership('ff02::1:2', addr.address);
                                logger.info(`DHCPv6: 加入多播组 ff02::1:2 on ${addr.address}`);
                            } catch (e) {
                                logger.warn(`DHCPv6: 多播组加入失败(${addr.address}): ${e.message}`);
                            }
                        }
                    }
                }

                logger.info(`DHCPv6服务器启动成功，监听 [::]:${listenPort}`);
                this.messageHandler.sendSuccessResponse(
                    messageId,
                    null,
                    `DHCPv6服务器启动成功，监听 [::]:${listenPort}`
                );

                this.leaseTimer = setInterval(() => this.checkExpiredLeases(), 60000);
            });
        } catch (err) {
            logger.error(`DHCPv6服务器启动失败: ${err.message}`);
            this.messageHandler.sendErrorResponse(messageId, `DHCPv6服务器启动失败: ${err.message}`);
        }
    }

    stopDhcp6(messageId) {
        if (this.leaseTimer) {
            clearInterval(this.leaseTimer);
            this.leaseTimer = null;
        }
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        this.leaseMap.clear();
        this.ipToClient.clear();
        this.config = null;
        this.messageHandler.sendSuccessResponse(messageId, null, 'DHCPv6服务器已停止');
    }

    getLeaseList(messageId) {
        const leases = [];
        this.leaseMap.forEach(lease => leases.push(lease.getInfo()));
        this.messageHandler.sendSuccessResponse(messageId, leases, '获取租约列表成功');
    }

    releaseLease(messageId, duid) {
        if (this.leaseMap.has(duid)) {
            const lease = this.leaseMap.get(duid);
            this.ipToClient.delete(lease.ip);
            this.leaseMap.delete(duid);
            this.messageHandler.sendEvent(Dhcp6Const.DHCP6_EVT_TYPES.DHCP6_EVT, {
                type: Dhcp6Const.DHCP6_SUB_EVT_TYPES.DHCP6_SUB_EVT_LEASE,
                opType: 'remove',
                data: { duid, ip: lease.ip }
            });
            this.messageHandler.sendSuccessResponse(messageId, null, `租约 ${duid} 已释放`);
        } else {
            this.messageHandler.sendErrorResponse(messageId, `未找到 ${duid} 的租约`);
        }
    }

    checkExpiredLeases() {
        const expired = [];
        this.leaseMap.forEach((lease, duid) => {
            if (lease.isExpired()) expired.push(duid);
        });
        expired.forEach(duid => {
            const lease = this.leaseMap.get(duid);
            this.ipToClient.delete(lease.ip);
            this.leaseMap.delete(duid);
            logger.info(`DHCPv6: 租约过期: ${duid} -> ${lease.ip}`);
            this.messageHandler.sendEvent(Dhcp6Const.DHCP6_EVT_TYPES.DHCP6_EVT, {
                type: Dhcp6Const.DHCP6_SUB_EVT_TYPES.DHCP6_SUB_EVT_LEASE,
                opType: 'remove',
                data: { duid, ip: lease.ip }
            });
        });
    }
}

new Dhcp6Worker();
