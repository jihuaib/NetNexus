const logger = require('../log/logger');
const RpkiConst = require('../const/rpkiConst');
const BgpConst = require('../const/bgpConst');
const { ipToBytes } = require('../utils/ipUtils');

class RpkiSession {
    constructor(messageHandler, rpkiWorker) {
        this.socket = null;
        this.messageHandler = messageHandler;
        this.rpkiWorker = rpkiWorker;
        this.localIp = null;
        this.localPort = null;
        this.remoteIp = null;
        this.remotePort = null;
        this.messageBuffer = Buffer.alloc(0);
        this.sessionId = null;
        this.protocolVersion = RpkiConst.RPKI_PROTOCOL_VERSION.V0;
        this.aspaFormat = RpkiConst.RPKI_ASPA_FORMAT.LATEST;
    }

    static makeKey(localIp, localPort, remoteIp, remotePort) {
        return `${localIp}|${localPort}|${remoteIp}|${remotePort}`;
    }

    static parseKey(key) {
        const [localIp, localPort, remoteIp, remotePort] = key.split('|');
        return { localIp, localPort, remoteIp, remotePort };
    }

    processMessage(message) {
        try {
            const clientAddress = `${this.remoteIp}:${this.remotePort}`;
            const header = this.parseRpkiHeader(message);

            logger.info(
                `Received message from ${clientAddress}, type: ${RpkiConst.RPKI_MSG_TYPE_NAME[header.type]}, length ${message.length}`
            );

            switch (header.type) {
                case RpkiConst.RPKI_MSG_TYPE.SERIAL_QUERY:
                    this.handleSerialQuery(header, message);
                    break;
                case RpkiConst.RPKI_MSG_TYPE.RESET_QUERY:
                    this.handleResetQuery(header, message);
                    break;
                case RpkiConst.RPKI_MSG_TYPE.ERROR_REPORT:
                    this.handleErrorReport(message);
                    break;
                default:
                    logger.error(`Unsupported PDU type from client: ${header.type}`);
                    this.sendError(RpkiConst.RPKI_ERROR_CODE.UNSUPPORTED_PDU_TYPE);
            }
        } catch (err) {
            logger.error(`Error processing message:`, err);
            this.sendError(RpkiConst.RPKI_ERROR_CODE.INTERNAL_ERROR);
        }
    }

    recvMsg(buffer) {
        this.messageBuffer = Buffer.concat([this.messageBuffer, buffer]);
        this.processBufferedMessages();
    }

    parseRpkiHeader(buffer) {
        const version = buffer[0];
        const type = buffer[1];
        const reserved = buffer.readUInt16BE(2);
        const length = buffer.readUInt32BE(4);
        return { version, type, reserved, length };
    }

    processBufferedMessages() {
        while (this.messageBuffer.length >= RpkiConst.RPKI_HEADER_LENGTH) {
            const header = this.parseRpkiHeader(this.messageBuffer);
            if (this.messageBuffer.length < header.length) {
                logger.info(
                    `Waiting for more data. Have ${this.messageBuffer.length} bytes, need ${header.length} bytes`
                );
                break;
            }

            const completeMessage = this.messageBuffer.subarray(0, header.length);
            this.messageBuffer = this.messageBuffer.subarray(header.length);
            this.processMessage(completeMessage);
        }
    }

    closeSession() {
        this.messageHandler.sendEvent(RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION, {
            opType: 'delete',
            data: this.getClientInfo()
        });
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    // 协商协议版本：取客户端请求版本与服务端最高支持版本的较小者
    negotiateVersion(clientVersion) {
        if (clientVersion > RpkiConst.RPKI_MAX_SUPPORTED_VERSION) {
            this.protocolVersion = RpkiConst.RPKI_MAX_SUPPORTED_VERSION;
        } else {
            this.protocolVersion = clientVersion;
        }
        return this.protocolVersion;
    }

    handleResetQuery(header, _message) {
        // 版本协商
        if (header.version > RpkiConst.RPKI_MAX_SUPPORTED_VERSION) {
            logger.error(
                `Unsupported protocol version: ${header.version}, max supported: ${RpkiConst.RPKI_MAX_SUPPORTED_VERSION}`
            );
            this.sendError(RpkiConst.RPKI_ERROR_CODE.UNSUPPORTED_PROTOCOL_VERSION);
            return;
        }
        this.negotiateVersion(header.version);
        logger.info(`Negotiated protocol version: ${this.protocolVersion}`);

        // 版本协商完成后通知前端刷新客户端列表
        this.messageHandler.sendEvent(RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION, {
            opType: 'update',
            data: this.getClientInfo()
        });

        this.sendCacheResponse();
        this.sendRoaData();
        if (this.protocolVersion >= RpkiConst.RPKI_PROTOCOL_VERSION.V1) {
            this.sendRouterKeyData();
        }
        if (this.protocolVersion >= RpkiConst.RPKI_PROTOCOL_VERSION.V2) {
            this.sendAspaData();
        }
        this.sendEndOfData();
    }

    handleSerialQuery(header, message) {
        // 版本一致性检查
        if (header.version !== this.protocolVersion) {
            logger.error(
                `Serial Query version mismatch: got ${header.version}, expected ${this.protocolVersion}`
            );
            this.sendError(RpkiConst.RPKI_ERROR_CODE.UNEXPECTED_PROTOCOL_VERSION);
            return;
        }
        const sessionId = message.readUInt16BE(2);
        const serial = message.readUInt32BE(RpkiConst.RPKI_HEADER_LENGTH);
        logger.info(`Serial Query: sessionId=${sessionId}, serial=${serial}`);
        // 模拟器实现：直接发送 Cache Reset，让客户端重新拉取全量
        this.sendCacheReset();
    }

    handleErrorReport(message) {
        const errorCode = message.readUInt16BE(2);
        const encapPduLength = message.readUInt32BE(RpkiConst.RPKI_HEADER_LENGTH);
        const encapPdu = message.subarray(
            RpkiConst.RPKI_HEADER_LENGTH + 4,
            RpkiConst.RPKI_HEADER_LENGTH + 4 + encapPduLength
        );
        logger.error(
            `RPKI Error Report from client: Code ${errorCode}, Encapsulated PDU(hex): ${Buffer.from(encapPdu).toString('hex')}`
        );
    }

    sendMessage(buffer) {
        if (!this.socket || this.socket.destroyed) {
            logger.error(`Cannot send message: socket is closed or destroyed`);
            return;
        }

        try {
            this.socket.write(buffer);
            logger.info(`Sent message to ${this.remoteIp}:${this.remotePort}, length ${buffer.length}`);
        } catch (err) {
            logger.error(`Error sending message: ${err.message}`);
        }
    }

    sendCacheResponse() {
        const buffer = Buffer.alloc(RpkiConst.RPKI_HEADER_LENGTH);

        buffer[0] = this.protocolVersion;
        buffer[1] = RpkiConst.RPKI_MSG_TYPE.CACHE_RESPONSE;
        if (!this.sessionId) {
            this.sessionId = Math.floor(Math.random() * 65536);
        }
        buffer.writeUInt16BE(this.sessionId, 2);
        buffer.writeUInt32BE(RpkiConst.RPKI_HEADER_LENGTH, 4);

        this.sendMessage(buffer);
    }

    writePrefixPdu(rpkiRoa, flags, isIpv6) {
        const prefixLen = isIpv6 ? 16 : 4;
        const totalLen = RpkiConst.RPKI_HEADER_LENGTH + 8 + prefixLen;
        const buffer = Buffer.alloc(totalLen);
        let position = 0;

        buffer[position++] = this.protocolVersion;
        buffer[position++] = isIpv6 ? RpkiConst.RPKI_MSG_TYPE.IPV6_PREFIX : RpkiConst.RPKI_MSG_TYPE.IPV4_PREFIX;
        buffer.writeUInt16BE(0, position);
        position += 2;
        buffer.writeUInt32BE(totalLen, position);
        position += 4;

        buffer[position++] = flags;
        buffer[position++] = rpkiRoa.mask;
        buffer[position++] = rpkiRoa.maxLength;
        buffer[position++] = 0; // Padding

        const ipBytesArray = ipToBytes(rpkiRoa.ip);
        for (let i = 0; i < prefixLen; i++) {
            buffer[position + i] = ipBytesArray[i];
        }
        position += prefixLen;

        buffer.writeUInt32BE(rpkiRoa.asn, position);

        this.sendMessage(buffer);
    }

    sendIPv4Prefix(rpkiRoa) {
        this.writePrefixPdu(rpkiRoa, RpkiConst.RPKI_FLAGS.UPDATE, false);
    }

    sendIPv6Prefix(rpkiRoa) {
        this.writePrefixPdu(rpkiRoa, RpkiConst.RPKI_FLAGS.UPDATE, true);
    }

    withdrawIPv4Prefix(rpkiRoa) {
        this.writePrefixPdu(rpkiRoa, RpkiConst.RPKI_FLAGS.WITHDRAWAL, false);
    }

    withdrawIPv6Prefix(rpkiRoa) {
        this.writePrefixPdu(rpkiRoa, RpkiConst.RPKI_FLAGS.WITHDRAWAL, true);
    }

    // Router Key PDU (RFC 8210 §5.10, v1+)
    // Header(8: Version|Type|Flags|Zero|Length) + SKI(20) + ASN(4) + SPKI(variable)
    writeRouterKeyPdu(rpkiRouterKey, flags) {
        if (this.protocolVersion < RpkiConst.RPKI_PROTOCOL_VERSION.V1) {
            logger.warn(`Cannot send Router Key PDU on protocol version ${this.protocolVersion}`);
            return;
        }
        const skiBuf = Buffer.from(rpkiRouterKey.ski, 'hex');
        const spkiBuf = Buffer.from(rpkiRouterKey.spki, 'hex');
        if (skiBuf.length !== 20) {
            logger.error(`Router Key SKI must be 20 bytes, got ${skiBuf.length}`);
            return;
        }
        const totalLen = RpkiConst.RPKI_HEADER_LENGTH + 20 + 4 + spkiBuf.length;
        const buffer = Buffer.alloc(totalLen);
        let position = 0;

        buffer[position++] = this.protocolVersion;
        buffer[position++] = RpkiConst.RPKI_MSG_TYPE.ROUTER_KEY;
        // RFC 8210 §5.10: header bytes 2-3 = Flags(1) + zero(1)
        buffer[position++] = flags;
        buffer[position++] = 0;
        buffer.writeUInt32BE(totalLen, position);
        position += 4;

        skiBuf.copy(buffer, position);
        position += 20;
        buffer.writeUInt32BE(parseInt(rpkiRouterKey.asn, 10), position);
        position += 4;
        spkiBuf.copy(buffer, position);

        this.sendMessage(buffer);
    }

    sendRouterKey(rpkiRouterKey) {
        this.writeRouterKeyPdu(rpkiRouterKey, RpkiConst.RPKI_FLAGS.UPDATE);
    }

    withdrawRouterKey(rpkiRouterKey) {
        this.writeRouterKeyPdu(rpkiRouterKey, RpkiConst.RPKI_FLAGS.WITHDRAWAL);
    }

    // ASPA PDU (v2+)
    // LATEST  (draft-ietf-sidrops-8210bis-19+):
    //   Header(8: Ver|Type|Flags|Zero|Length) + Customer ASN(4) + Provider ASNs(4*N)
    //   Total = 12 + 4N
    // LEGACY  (draft-ietf-sidrops-8210bis-10 风格, 华为 VRP 兼容):
    //   Header(8: Ver|Type|Flags|AFI|Length) + Provider AS Count(4) + Customer ASN(4) + Provider ASNs(4*N)
    //   Total = 16 + 4N
    writeAspaPdu(rpkiAspa, flags) {
        if (this.protocolVersion < RpkiConst.RPKI_PROTOCOL_VERSION.V2) {
            logger.warn(`Cannot send ASPA PDU on protocol version ${this.protocolVersion}`);
            return;
        }
        const providerCount = rpkiAspa.providerAsns.length;
        const isLegacy = this.aspaFormat === RpkiConst.RPKI_ASPA_FORMAT.LEGACY;
        const totalLen = isLegacy
            ? RpkiConst.RPKI_HEADER_LENGTH + 8 + 4 * providerCount
            : RpkiConst.RPKI_HEADER_LENGTH + 4 + 4 * providerCount;
        const buffer = Buffer.alloc(totalLen);
        let position = 0;

        buffer[position++] = this.protocolVersion;
        buffer[position++] = RpkiConst.RPKI_MSG_TYPE.ASPA;
        buffer[position++] = flags;
        // byte 3: legacy = AFI flags; latest = zero
        buffer[position++] = isLegacy ? rpkiAspa.afiFlags & 0xff : 0;
        buffer.writeUInt32BE(totalLen, position);
        position += 4;

        if (isLegacy) {
            buffer.writeUInt32BE(providerCount, position); // Provider AS Count
            position += 4;
        }

        buffer.writeUInt32BE(parseInt(rpkiAspa.customerAsn, 10), position);
        position += 4;
        for (let i = 0; i < providerCount; i++) {
            buffer.writeUInt32BE(parseInt(rpkiAspa.providerAsns[i], 10), position);
            position += 4;
        }

        this.sendMessage(buffer);
    }

    sendAspa(rpkiAspa) {
        this.writeAspaPdu(rpkiAspa, RpkiConst.RPKI_FLAGS.UPDATE);
    }

    withdrawAspa(rpkiAspa) {
        this.writeAspaPdu(rpkiAspa, RpkiConst.RPKI_FLAGS.WITHDRAWAL);
    }

    sendEndOfData() {
        if (this.protocolVersion >= RpkiConst.RPKI_PROTOCOL_VERSION.V1) {
            // RFC 8210 §5.8: Header(8, sessionID in bytes 2-3) + Serial(4) + Refresh(4) + Retry(4) + Expire(4)
            // Total = 24
            const totalLen = RpkiConst.RPKI_HEADER_LENGTH + 16;
            const buffer = Buffer.alloc(totalLen);

            buffer[0] = this.protocolVersion;
            buffer[1] = RpkiConst.RPKI_MSG_TYPE.END_OF_DATA;
            buffer.writeUInt16BE(this.sessionId, 2);
            buffer.writeUInt32BE(totalLen, 4);

            buffer.writeUInt32BE(1, RpkiConst.RPKI_HEADER_LENGTH); // Serial Number
            buffer.writeUInt32BE(3600, RpkiConst.RPKI_HEADER_LENGTH + 4); // Refresh
            buffer.writeUInt32BE(600, RpkiConst.RPKI_HEADER_LENGTH + 8); // Retry
            buffer.writeUInt32BE(7200, RpkiConst.RPKI_HEADER_LENGTH + 12); // Expire

            this.sendMessage(buffer);
        } else {
            // RFC 6810 §5.8: Header(8, sessionID in bytes 2-3) + Serial(4). Total = 12
            const totalLen = RpkiConst.RPKI_HEADER_LENGTH + 4;
            const buffer = Buffer.alloc(totalLen);

            buffer[0] = this.protocolVersion;
            buffer[1] = RpkiConst.RPKI_MSG_TYPE.END_OF_DATA;
            buffer.writeUInt16BE(this.sessionId, 2);
            buffer.writeUInt32BE(totalLen, 4);
            buffer.writeUInt32BE(0, RpkiConst.RPKI_HEADER_LENGTH); // Serial Number

            this.sendMessage(buffer);
        }
    }

    sendCacheReset() {
        const buffer = Buffer.alloc(RpkiConst.RPKI_HEADER_LENGTH);

        buffer[0] = this.protocolVersion;
        buffer[1] = RpkiConst.RPKI_MSG_TYPE.CACHE_RESET;
        buffer.writeUInt16BE(0, 2);
        buffer.writeUInt32BE(RpkiConst.RPKI_HEADER_LENGTH, 4);

        this.sendMessage(buffer);
    }

    // Error Report PDU: Header + ErrorCode(2 in reserved) + Length(4) + EncapPduLen(4) + EncapPdu + ErrTextLen(4) + ErrText
    sendError(errorCode) {
        const buffer = Buffer.alloc(RpkiConst.RPKI_HEADER_LENGTH + 8);

        buffer[0] = this.protocolVersion;
        buffer[1] = RpkiConst.RPKI_MSG_TYPE.ERROR_REPORT;
        buffer.writeUInt16BE(errorCode, 2);
        buffer.writeUInt32BE(RpkiConst.RPKI_HEADER_LENGTH + 8, 4);
        buffer.writeUInt32BE(0, RpkiConst.RPKI_HEADER_LENGTH); // Encapsulated PDU length = 0
        buffer.writeUInt32BE(0, RpkiConst.RPKI_HEADER_LENGTH + 4); // Error text length = 0

        this.sendMessage(buffer);
    }

    sendRoaData() {
        for (const roa of this.rpkiWorker.rpkiRoaMap.values()) {
            this.sendSingleRoaData(roa);
        }
    }

    sendRouterKeyData() {
        for (const rk of this.rpkiWorker.rpkiRouterKeyMap.values()) {
            this.sendRouterKey(rk);
        }
    }

    sendAspaData() {
        for (const aspa of this.rpkiWorker.rpkiAspaMap.values()) {
            this.sendAspa(aspa);
        }
    }

    withdrawRoaData() {
        for (const roa of this.rpkiWorker.rpkiRoaMap.values()) {
            this.withdrawSingleRoaData(roa);
        }
    }

    sendSingleRoaData(rpkiRoa) {
        if (rpkiRoa.ipType === BgpConst.IP_TYPE.IPV4) {
            this.sendIPv4Prefix(rpkiRoa);
        } else {
            this.sendIPv6Prefix(rpkiRoa);
        }
    }

    withdrawSingleRoaData(rpkiRoa) {
        if (rpkiRoa.ipType === BgpConst.IP_TYPE.IPV4) {
            this.withdrawIPv4Prefix(rpkiRoa);
        } else {
            this.withdrawIPv6Prefix(rpkiRoa);
        }
    }

    getClientInfo() {
        return {
            localIp: this.localIp,
            localPort: this.localPort,
            remoteIp: this.remoteIp,
            remotePort: this.remotePort,
            protocolVersion: this.protocolVersion
        };
    }
}

module.exports = RpkiSession;
