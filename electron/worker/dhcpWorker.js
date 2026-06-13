const dgram = require('dgram');
const os = require('os');
const logger = require('../log/logger');
const WorkerMessageHandler = require('./workerMessageHandler');
const DhcpLease = require('./dhcpLease');
const DhcpConst = require('../const/dhcpConst');

// 自动探测本机第一个非回环 IPv4 地址，用于 DHCP Option 54（服务器标识符）
function detectLocalIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

// DHCP Magic Cookie (RFC 2131)
const MAGIC_COOKIE = Buffer.from([99, 130, 83, 99]);

// IP工具函数
function ipToNum(ip) {
    return ip.split('.').reduce((acc, oct) => (acc << 8) | parseInt(oct, 10), 0) >>> 0;
}

function numToIp(num) {
    return [(num >>> 24) & 0xff, (num >>> 16) & 0xff, (num >>> 8) & 0xff, num & 0xff].join('.');
}

function ipToBuffer(ip) {
    return Buffer.from(ip.split('.').map(Number));
}

class DhcpWorker {
    constructor() {
        this.server = null;
        this.config = null;
        this.leaseMap = new Map(); // macAddr -> DhcpLease
        this.ipToMac = new Map(); // ip -> macAddr
        this.pendingOffers = new Map(); // xid -> { macAddr, ip }
        this.poolStart = 0;
        this.poolEnd = 0;
        this.leaseTimer = null;

        this.messageHandler = new WorkerMessageHandler();
        this.messageHandler.init();
        this.messageHandler.registerHandler(DhcpConst.DHCP_REQ_TYPES.START_DHCP, this.startDhcp.bind(this));
        this.messageHandler.registerHandler(DhcpConst.DHCP_REQ_TYPES.STOP_DHCP, this.stopDhcp.bind(this));
        this.messageHandler.registerHandler(DhcpConst.DHCP_REQ_TYPES.GET_LEASE_LIST, this.getLeaseList.bind(this));
        this.messageHandler.registerHandler(DhcpConst.DHCP_REQ_TYPES.RELEASE_LEASE, this.releaseLease.bind(this));
    }

    parseDhcpPacket(buffer) {
        if (buffer.length < 236) return null;

        const packet = {
            op: buffer.readUInt8(0),
            htype: buffer.readUInt8(1),
            hlen: buffer.readUInt8(2),
            hops: buffer.readUInt8(3),
            xid: buffer.readUInt32BE(4),
            secs: buffer.readUInt16BE(8),
            flags: buffer.readUInt16BE(10),
            ciaddr: buffer.slice(12, 16),
            yiaddr: buffer.slice(16, 20),
            siaddr: buffer.slice(20, 24),
            giaddr: buffer.slice(24, 28),
            chaddr: buffer.slice(28, 44),
            options: {}
        };

        // 解析MAC地址
        const hlen = packet.hlen || 6;
        packet.macAddr = Array.from(packet.chaddr.slice(0, hlen))
            .map(b => b.toString(16).padStart(2, '0'))
            .join(':')
            .toLowerCase();

        // 解析DHCP Options
        if (buffer.length > 240) {
            const magic = buffer.slice(236, 240);
            if (magic.equals(MAGIC_COOKIE)) {
                let i = 240;
                while (i < buffer.length) {
                    const code = buffer.readUInt8(i++);
                    if (code === 255) break; // End option
                    if (code === 0) continue; // Pad option
                    if (i >= buffer.length) break;
                    const len = buffer.readUInt8(i++);
                    packet.options[code] = buffer.slice(i, i + len);
                    i += len;
                }
            }
        }

        // 提取常用字段
        if (packet.options[53] && packet.options[53].length >= 1) {
            packet.msgType = packet.options[53].readUInt8(0);
        }
        if (packet.options[50] && packet.options[50].length >= 4) {
            packet.requestedIp = numToIp(packet.options[50].readUInt32BE(0));
        }
        if (packet.options[12]) {
            packet.hostname = packet.options[12].toString('ascii').replace(/\0/g, '');
        }
        if (packet.options[54] && packet.options[54].length >= 4) {
            packet.serverId = numToIp(packet.options[54].readUInt32BE(0));
        }

        return packet;
    }

    buildDhcpResponse(packet, msgType, assignedIp, serverIp) {
        const buf = Buffer.alloc(576, 0);

        // Fixed header
        buf.writeUInt8(2, 0); // op: BOOTREPLY
        buf.writeUInt8(packet.htype, 1);
        buf.writeUInt8(packet.hlen, 2);
        buf.writeUInt8(0, 3); // hops
        buf.writeUInt32BE(packet.xid, 4);
        buf.writeUInt16BE(0, 8); // secs
        buf.writeUInt16BE(packet.flags, 10); // 保留广播标志

        // ciaddr (为0，由OFFER/ACK决定yiaddr)
        buf.fill(0, 12, 16);

        // yiaddr (分配给客户端的IP)
        ipToBuffer(assignedIp).copy(buf, 16);

        // siaddr (服务器IP)
        ipToBuffer(serverIp).copy(buf, 20);

        // giaddr
        packet.giaddr.copy(buf, 24);

        // chaddr
        packet.chaddr.copy(buf, 28);

        // Magic Cookie
        MAGIC_COOKIE.copy(buf, 236);

        let offset = 240;

        // Option 53: DHCP Message Type
        buf.writeUInt8(53, offset++);
        buf.writeUInt8(1, offset++);
        buf.writeUInt8(msgType, offset++);

        if (msgType !== DhcpConst.DHCP_MSG_TYPES.NAK) {
            // Option 54: Server Identifier
            buf.writeUInt8(54, offset++);
            buf.writeUInt8(4, offset++);
            ipToBuffer(serverIp).copy(buf, offset);
            offset += 4;

            // Option 51: IP Address Lease Time
            buf.writeUInt8(51, offset++);
            buf.writeUInt8(4, offset++);
            buf.writeUInt32BE(this.config.leaseTime, offset);
            offset += 4;

            // Option 1: Subnet Mask
            buf.writeUInt8(1, offset++);
            buf.writeUInt8(4, offset++);
            ipToBuffer(this.config.subnetMask).copy(buf, offset);
            offset += 4;

            // Option 3: Router (Gateway)
            if (this.config.gateway) {
                buf.writeUInt8(3, offset++);
                buf.writeUInt8(4, offset++);
                ipToBuffer(this.config.gateway).copy(buf, offset);
                offset += 4;
            }

            // Option 6: DNS Servers
            const dnsServers = [this.config.dns1, this.config.dns2].filter(Boolean);
            if (dnsServers.length > 0) {
                buf.writeUInt8(6, offset++);
                buf.writeUInt8(dnsServers.length * 4, offset++);
                dnsServers.forEach(dns => {
                    ipToBuffer(dns).copy(buf, offset);
                    offset += 4;
                });
            }
        } else {
            // NAK仅包含Server Identifier
            buf.writeUInt8(54, offset++);
            buf.writeUInt8(4, offset++);
            ipToBuffer(serverIp).copy(buf, offset);
            offset += 4;
        }

        // Option 255: End
        buf.writeUInt8(255, offset++);

        return buf.slice(0, offset);
    }

    allocateIp(macAddr) {
        // 已有租约，返回同一个IP
        if (this.leaseMap.has(macAddr)) {
            return this.leaseMap.get(macAddr).ip;
        }
        // 从池中分配空闲IP
        for (let num = this.poolStart; num <= this.poolEnd; num++) {
            const ip = numToIp(num);
            if (!this.ipToMac.has(ip)) {
                return ip;
            }
        }
        return null; // IP池已耗尽
    }

    handleDiscover(packet, rinfo) {
        const macAddr = packet.macAddr;
        const offeredIp = this.allocateIp(macAddr);

        if (!offeredIp) {
            logger.warn(`DHCP: IP池已耗尽，拒绝 ${macAddr}`);
            return;
        }

        this.pendingOffers.set(packet.xid, { macAddr, ip: offeredIp });
        logger.info(`DHCP DISCOVER from ${macAddr} (${rinfo.address}), offering ${offeredIp}`);

        const response = this.buildDhcpResponse(
            packet,
            DhcpConst.DHCP_MSG_TYPES.OFFER,
            offeredIp,
            this.config.serverIp
        );
        this.sendResponse(response, packet, rinfo);
    }

    handleRequest(packet, rinfo) {
        const macAddr = packet.macAddr;

        // 如果客户端选择了其他服务器，忽略
        if (packet.serverId && packet.serverId !== this.config.serverIp) {
            // 如果该客户端有pending offer，清理掉
            if (this.pendingOffers.has(packet.xid)) {
                this.pendingOffers.delete(packet.xid);
            }
            logger.info(`DHCP REQUEST: 客户端 ${macAddr} 选择了其他服务器 ${packet.serverId}`);
            return;
        }

        // 确定请求的IP
        let requestedIp = packet.requestedIp;
        if (!requestedIp) {
            const ciaddrNum = packet.ciaddr.readUInt32BE(0);
            if (ciaddrNum !== 0) {
                requestedIp = numToIp(ciaddrNum);
            }
        }

        if (!requestedIp) {
            logger.warn(`DHCP REQUEST: 无法确定请求IP，发送NAK`);
            const nak = this.buildDhcpResponse(packet, DhcpConst.DHCP_MSG_TYPES.NAK, '0.0.0.0', this.config.serverIp);
            this.sendResponse(nak, packet, rinfo);
            return;
        }

        // 验证IP是否在池范围内
        const requestedNum = ipToNum(requestedIp);
        if (requestedNum < this.poolStart || requestedNum > this.poolEnd) {
            logger.warn(`DHCP REQUEST: IP ${requestedIp} 不在池范围内，发送NAK`);
            const nak = this.buildDhcpResponse(packet, DhcpConst.DHCP_MSG_TYPES.NAK, '0.0.0.0', this.config.serverIp);
            this.sendResponse(nak, packet, rinfo);
            return;
        }

        // 验证IP未被其他MAC占用
        if (this.ipToMac.has(requestedIp) && this.ipToMac.get(requestedIp) !== macAddr) {
            logger.warn(`DHCP REQUEST: IP ${requestedIp} 已被 ${this.ipToMac.get(requestedIp)} 占用`);
            const nak = this.buildDhcpResponse(packet, DhcpConst.DHCP_MSG_TYPES.NAK, '0.0.0.0', this.config.serverIp);
            this.sendResponse(nak, packet, rinfo);
            return;
        }

        const hostname = packet.hostname || '未知';

        if (this.leaseMap.has(macAddr)) {
            // 续约
            const lease = this.leaseMap.get(macAddr);
            lease.renew(this.config.leaseTime);
            lease.hostname = hostname;
            logger.info(`DHCP续约: ${macAddr} -> ${requestedIp}`);

            this.messageHandler.sendEvent(DhcpConst.DHCP_EVT_TYPES.DHCP_EVT, {
                type: DhcpConst.DHCP_SUB_EVT_TYPES.DHCP_SUB_EVT_LEASE,
                opType: 'update',
                data: lease.getInfo()
            });
        } else {
            // 新租约
            const lease = new DhcpLease(macAddr, requestedIp, hostname, this.config.leaseTime);
            this.leaseMap.set(macAddr, lease);
            this.ipToMac.set(requestedIp, macAddr);
            logger.info(`DHCP新租约: ${macAddr} -> ${requestedIp}`);

            this.messageHandler.sendEvent(DhcpConst.DHCP_EVT_TYPES.DHCP_EVT, {
                type: DhcpConst.DHCP_SUB_EVT_TYPES.DHCP_SUB_EVT_LEASE,
                opType: 'add',
                data: lease.getInfo()
            });
        }

        this.pendingOffers.delete(packet.xid);

        const ack = this.buildDhcpResponse(packet, DhcpConst.DHCP_MSG_TYPES.ACK, requestedIp, this.config.serverIp);
        this.sendResponse(ack, packet, rinfo);
    }

    handleRelease(packet) {
        const macAddr = packet.macAddr;

        if (this.leaseMap.has(macAddr)) {
            const lease = this.leaseMap.get(macAddr);
            const ip = lease.ip;
            this.leaseMap.delete(macAddr);
            this.ipToMac.delete(ip);
            logger.info(`DHCP RELEASE: ${macAddr} 释放 ${ip}`);

            this.messageHandler.sendEvent(DhcpConst.DHCP_EVT_TYPES.DHCP_EVT, {
                type: DhcpConst.DHCP_SUB_EVT_TYPES.DHCP_SUB_EVT_LEASE,
                opType: 'remove',
                data: { macAddr, ip }
            });
        }
    }

    sendResponse(response, packet, rinfo) {
        // 广播标志位置1或ciaddr为0时广播
        const ciaddrNum = packet.ciaddr.readUInt32BE(0);
        const broadcast = (packet.flags & 0x8000) !== 0 || ciaddrNum === 0;
        const destAddress = broadcast ? '255.255.255.255' : rinfo.address;
        // 响应发回请求来源端口（标准客户端用68，测试脚本可使用任意端口）
        const destPort = rinfo.port;

        this.server.send(response, 0, response.length, destPort, destAddress, err => {
            if (err) {
                logger.error(`DHCP: 发送响应到 ${destAddress}:${destPort} 失败: ${err.message}`);
            }
        });
    }

    startDhcp(messageId, config) {
        this.config = config;
        if (this.config.logLevel) {
            logger.setLevel(this.config.logLevel);
            logger.info(`Worker log level set to: ${this.config.logLevel}`);
        }
        const listenPort = Number.isInteger(Number(this.config.serverPort))
            ? Number(this.config.serverPort)
            : DhcpConst.DEFAULT_DHCP_CONFIG.serverPort;
        // 未配置 serverIp 时自动探测本机 IP，和其他协议一样绑定 0.0.0.0 即可
        if (!this.config.serverIp) {
            this.config.serverIp = detectLocalIp();
            logger.info(`DHCP: 自动探测服务器IP: ${this.config.serverIp}`);
        }
        this.poolStart = ipToNum(config.poolStart);
        this.poolEnd = ipToNum(config.poolEnd);

        try {
            this.server = dgram.createSocket({ type: 'udp4', reuseAddr: true });

            // 统一错误处理：区分启动阶段（messageId有效）和运行阶段
            let started = false;
            this.server.on('error', err => {
                logger.error(`DHCP服务器错误: ${err.message}`);
                if (!started) {
                    // 绑定/启动阶段失败，通知 app
                    let hint = '';
                    if (err.code === 'EACCES' || err.code === 'EPERM') {
                        hint = `（绑定 UDP ${listenPort} 端口需要管理员/root 权限）`;
                    } else if (err.code === 'EADDRINUSE') {
                        hint = `（UDP ${listenPort} 端口已被占用，可修改监听端口后重试）`;
                    }
                    this.messageHandler.sendErrorResponse(messageId, `DHCP服务器启动失败: ${err.message}${hint}`);
                    this.server = null;
                }
            });

            this.server.on('message', (msg, rinfo) => {
                try {
                    const packet = this.parseDhcpPacket(msg);
                    if (!packet || packet.op !== 1) return; // 只处理BOOTREQUEST

                    logger.info(`DHCP收到消息类型 ${packet.msgType} from ${rinfo.address}:${rinfo.port}`);

                    switch (packet.msgType) {
                        case DhcpConst.DHCP_MSG_TYPES.DISCOVER:
                            this.handleDiscover(packet, rinfo);
                            break;
                        case DhcpConst.DHCP_MSG_TYPES.REQUEST:
                            this.handleRequest(packet, rinfo);
                            break;
                        case DhcpConst.DHCP_MSG_TYPES.RELEASE:
                            this.handleRelease(packet);
                            break;
                        default:
                            logger.info(`DHCP: 忽略消息类型 ${packet.msgType}`);
                    }
                } catch (e) {
                    logger.error(`DHCP处理消息出错: ${e.message}`);
                }
            });

            this.server.bind({ port: listenPort, address: '0.0.0.0' }, () => {
                started = true;
                this.server.setBroadcast(true);
                logger.info(`DHCP服务器启动成功，监听 0.0.0.0:${listenPort}`);
                this.messageHandler.sendSuccessResponse(
                    messageId,
                    null,
                    `DHCP服务器启动成功，监听 0.0.0.0:${listenPort}`
                );

                // 每60秒检查过期租约
                this.leaseTimer = setInterval(() => {
                    this.checkExpiredLeases();
                }, 60000);
            });
        } catch (err) {
            logger.error(`DHCP服务器启动失败: ${err.message}`);
            this.messageHandler.sendErrorResponse(messageId, `DHCP服务器启动失败: ${err.message}`);
        }
    }

    stopDhcp(messageId) {
        if (this.leaseTimer) {
            clearInterval(this.leaseTimer);
            this.leaseTimer = null;
        }

        if (this.server) {
            this.server.close();
            this.server = null;
        }

        this.leaseMap.clear();
        this.ipToMac.clear();
        this.pendingOffers.clear();
        this.config = null;

        this.messageHandler.sendSuccessResponse(messageId, null, 'DHCP服务器已停止');
    }

    getLeaseList(messageId) {
        const leases = [];
        this.leaseMap.forEach(lease => {
            leases.push(lease.getInfo());
        });
        this.messageHandler.sendSuccessResponse(messageId, leases, '获取租约列表成功');
    }

    releaseLease(messageId, macAddr) {
        if (this.leaseMap.has(macAddr)) {
            const lease = this.leaseMap.get(macAddr);
            const ip = lease.ip;
            this.leaseMap.delete(macAddr);
            this.ipToMac.delete(ip);

            this.messageHandler.sendEvent(DhcpConst.DHCP_EVT_TYPES.DHCP_EVT, {
                type: DhcpConst.DHCP_SUB_EVT_TYPES.DHCP_SUB_EVT_LEASE,
                opType: 'remove',
                data: { macAddr, ip }
            });

            this.messageHandler.sendSuccessResponse(messageId, null, `租约 ${macAddr} 已释放`);
        } else {
            this.messageHandler.sendErrorResponse(messageId, `未找到 ${macAddr} 的租约`);
        }
    }

    checkExpiredLeases() {
        const expired = [];
        this.leaseMap.forEach((lease, macAddr) => {
            if (lease.isExpired()) {
                expired.push(macAddr);
            }
        });

        expired.forEach(macAddr => {
            const lease = this.leaseMap.get(macAddr);
            const ip = lease.ip;
            this.leaseMap.delete(macAddr);
            this.ipToMac.delete(ip);
            logger.info(`DHCP: 租约过期: ${macAddr} -> ${ip}`);

            this.messageHandler.sendEvent(DhcpConst.DHCP_EVT_TYPES.DHCP_EVT, {
                type: DhcpConst.DHCP_SUB_EVT_TYPES.DHCP_SUB_EVT_LEASE,
                opType: 'remove',
                data: { macAddr, ip }
            });
        });
    }
}

new DhcpWorker();
