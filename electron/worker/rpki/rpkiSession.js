const logger = require('../../log/logger');
const RpkiConst = require('../../const/rpkiConst');
const BgpConst = require('../../const/bgpConst');
const { ipToBytes } = require('../../utils/ipUtils');

const ROA_WRITE_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_RESET_SNAPSHOT_TIMEOUT_MS = 120000;

function yieldToIoLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

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
        this.sendQueue = Promise.resolve();
        this.closing = false;
        this.closed = false;
        this.closePromise = null;
        this.pendingDrainCancels = new Set();
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
        if (this.closing) {
            logger.warn(`Ignoring message from ${this.remoteIp}:${this.remotePort}: session is closing`);
            return;
        }

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

    closeSession(options = {}) {
        const { destroySocket = true, graceful = false } = options;
        if (this.closePromise) {
            return this.closePromise;
        }

        this.closed = true;
        this.closing = true;
        this.messageBuffer = Buffer.alloc(0);
        for (const cancelDrain of this.pendingDrainCancels) {
            cancelDrain();
        }

        let resolveClose;
        let rejectClose;
        const closePromise = new Promise((resolve, reject) => {
            resolveClose = resolve;
            rejectClose = reject;
        });
        this.closePromise = closePromise;
        if (typeof this.rpkiWorker?.trackClosingRpkiSession === 'function') {
            this.rpkiWorker.trackClosingRpkiSession(this, closePromise);
        }
        if (typeof this.rpkiWorker?.removeRpkiSession === 'function') {
            this.rpkiWorker.removeRpkiSession(this);
        }
        try {
            this.messageHandler.sendEvent(RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION, {
                opType: 'delete',
                data: this.getClientInfo()
            });
        } catch (error) {
            logger.warn(`RPKI session关闭事件发送失败: ${error.message}`);
        }

        const finishClose = async () => {
            let closeError = null;
            try {
                if (destroySocket) {
                    await this.closeSocket({ graceful });
                }
            } catch (error) {
                closeError = error;
            }

            try {
                await this.awaitQuiescence();
            } catch (error) {
                closeError ||= error;
            }

            if (closeError) {
                throw closeError;
            }
        };
        finishClose().then(resolveClose, rejectClose);
        return closePromise;
    }

    async awaitQuiescence() {
        let queue = this.sendQueue;
        while (queue) {
            await queue;
            if (queue === this.sendQueue) {
                return;
            }
            queue = this.sendQueue;
        }
    }

    closeSocket(options = {}) {
        const { graceful = false } = options;
        if (graceful) {
            return this.endSocket();
        }
        this.destroySocket();
        return Promise.resolve();
    }

    endSocket() {
        const socket = this.socket;
        this.socket = null;
        if (!socket || socket.destroyed) {
            return Promise.resolve();
        }

        if (typeof socket.end !== 'function') {
            if (typeof socket.destroy === 'function') {
                socket.destroy();
            }
            return Promise.resolve();
        }

        if (typeof socket.once !== 'function') {
            try {
                socket.end();
            } catch (_error) {
                if (!socket.destroyed && typeof socket.destroy === 'function') {
                    socket.destroy();
                }
            }
            return Promise.resolve();
        }

        return new Promise(resolve => {
            let fallbackTimer = null;
            let resolved = false;
            const finish = () => {
                if (resolved) {
                    return;
                }
                resolved = true;
                if (fallbackTimer) {
                    clearTimeout(fallbackTimer);
                    fallbackTimer = null;
                }
                resolve();
            };

            socket.once('close', finish);
            socket.once('error', finish);

            try {
                socket.end();
            } catch (_error) {
                if (!socket.destroyed && typeof socket.destroy === 'function') {
                    socket.destroy();
                }
                finish();
            }

            fallbackTimer = setTimeout(() => {
                if (!socket.destroyed && typeof socket.destroy === 'function') {
                    socket.destroy();
                }
                finish();
            }, 1000);
            if (typeof fallbackTimer.unref === 'function') {
                fallbackTimer.unref();
            }
        });
    }

    destroySocket() {
        if (this.socket && typeof this.socket.destroy === 'function') {
            this.socket.destroy();
        }
        this.socket = null;
    }

    getMaxSupportedVersion() {
        const configuredVersion =
            this.rpkiWorker?.rpkiConfigData?.maxProtocolVersion ?? this.rpkiWorker?.maxSupportedVersion;
        const maxSupportedVersion = Number(configuredVersion);
        const supportedVersions = Object.values(RpkiConst.RPKI_PROTOCOL_VERSION);

        return supportedVersions.includes(maxSupportedVersion)
            ? maxSupportedVersion
            : RpkiConst.RPKI_MAX_SUPPORTED_VERSION;
    }

    getResetSnapshotTimeoutMs() {
        const configured = Number(this.rpkiWorker?.rpkiConfigData?.resetSnapshotTimeoutMs);
        if (!Number.isFinite(configured) || configured <= 0) {
            return DEFAULT_RESET_SNAPSHOT_TIMEOUT_MS;
        }
        return Math.min(Math.max(Math.floor(configured), 1000), 10 * 60 * 1000);
    }

    // 协商协议版本：取客户端请求版本与服务端最高配置版本的较小者
    negotiateVersion(clientVersion) {
        const maxSupportedVersion = this.getMaxSupportedVersion();
        this.protocolVersion = clientVersion > maxSupportedVersion ? maxSupportedVersion : clientVersion;
        return this.protocolVersion;
    }

    handleResetQuery(header, _message) {
        // 版本协商
        const maxSupportedVersion = this.getMaxSupportedVersion();
        if (header.version > maxSupportedVersion) {
            logger.error(`Unsupported protocol version: ${header.version}, max supported: ${maxSupportedVersion}`);
            this.sendError(RpkiConst.RPKI_ERROR_CODE.UNSUPPORTED_PROTOCOL_VERSION, maxSupportedVersion, true);
            return;
        }
        this.negotiateVersion(header.version);
        logger.info(`Negotiated protocol version: ${this.protocolVersion}`);

        // 版本协商完成后通知前端刷新客户端列表
        this.messageHandler.sendEvent(RpkiConst.RPKI_EVT_TYPES.CLIENT_CONNECTION, {
            opType: 'update',
            data: this.getClientInfo()
        });

        this.sendResetQueryResponse();
    }

    sendResetQueryResponse() {
        this.enqueueSend(async () => {
            let snapshot = null;
            let snapshotTimeout = null;
            try {
                if (this.closing || this.closed) {
                    return;
                }
                snapshot =
                    typeof this.rpkiWorker?.createDataSnapshot === 'function'
                        ? await this.rpkiWorker.createDataSnapshot()
                        : { cacheSerial: this.getCurrentSerial() };
                snapshotTimeout = setTimeout(() => {
                    logger.warn(
                        `RPKI Reset Query快照超过${this.getResetSnapshotTimeoutMs()}ms，关闭慢客户端 ` +
                            `${this.remoteIp}:${this.remotePort}`
                    );
                    this.closeSession().catch(error => logger.debug(`关闭RPKI慢客户端失败: ${error.message}`));
                }, this.getResetSnapshotTimeoutMs());
                snapshotTimeout.unref?.();
                const snapshotSerial = this.normalizeSerial(snapshot?.cacheSerial, this.getCurrentSerial());
                const roas =
                    typeof this.rpkiWorker?.iterateRoas === 'function'
                        ? this.rpkiWorker.iterateRoas(snapshot)
                        : snapshot?.roas || [];

                if (!(await this.writeBuffer(this.buildCacheResponsePdu()))) {
                    return;
                }
                if (!(await this.writeRoaListData(roas, RpkiConst.RPKI_FLAGS.UPDATE))) {
                    return;
                }
                if (this.protocolVersion >= RpkiConst.RPKI_PROTOCOL_VERSION.V1) {
                    if (!(await this.writeRouterKeyData(snapshot?.routerKeys))) {
                        return;
                    }
                }
                if (this.protocolVersion >= RpkiConst.RPKI_PROTOCOL_VERSION.V2) {
                    const aspas =
                        typeof this.rpkiWorker?.iterateAspas === 'function'
                            ? this.rpkiWorker.iterateAspas(snapshot)
                            : snapshot?.aspas || [];
                    if (!(await this.writeAspaListData(aspas, RpkiConst.RPKI_FLAGS.UPDATE))) {
                        return;
                    }
                }
                await this.writeBuffer(this.buildEndOfDataPdu(snapshotSerial));
            } catch (error) {
                logger.error(`RPKI Reset Query snapshot send failed: ${error.message}`);
                if (this.canWrite()) {
                    await this.writeBuffer(this.buildErrorReportPdu(RpkiConst.RPKI_ERROR_CODE.INTERNAL_ERROR));
                }
            } finally {
                if (snapshotTimeout) {
                    clearTimeout(snapshotTimeout);
                }
                try {
                    if (snapshot && typeof this.rpkiWorker?.closeDataSnapshot === 'function') {
                        await this.rpkiWorker.closeDataSnapshot(snapshot);
                    } else if (snapshot && typeof snapshot.close === 'function') {
                        await snapshot.close();
                    }
                } catch (error) {
                    logger.warn(`RPKI SQLite snapshot close failed: ${error.message}`);
                }
            }
        });
    }

    handleSerialQuery(header, message) {
        // 版本一致性检查
        if (header.version !== this.protocolVersion) {
            logger.error(`Serial Query version mismatch: got ${header.version}, expected ${this.protocolVersion}`);
            this.sendError(RpkiConst.RPKI_ERROR_CODE.UNEXPECTED_PROTOCOL_VERSION);
            return;
        }
        const sessionId = message.readUInt16BE(2);
        const serial = message.readUInt32BE(RpkiConst.RPKI_HEADER_LENGTH);
        const currentSerial = this.getCurrentSerial();
        logger.info(`Serial Query: sessionId=${sessionId}, serial=${serial}, currentSerial=${currentSerial}`);

        if (this.sessionId === null || sessionId !== this.sessionId) {
            logger.error(`Serial Query sessionId mismatch: got ${sessionId}, expected ${this.sessionId}`);
            this.sendError(RpkiConst.RPKI_ERROR_CODE.CORRUPT_DATA);
            return;
        }

        const deltaOperations = this.rpkiWorker.getDeltaOperationsSince
            ? this.rpkiWorker.getDeltaOperationsSince(serial)
            : null;
        if (serial !== currentSerial && !deltaOperations) {
            this.sendCacheReset();
            return;
        }

        this.sendSerialQueryResponse(deltaOperations || [], currentSerial);
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
        if (!this.canWrite()) {
            logger.error(`Cannot send message: socket is closed or destroyed`);
            return;
        }

        try {
            this.socket.write(buffer);
            logger.debug(`Sent message to ${this.remoteIp}:${this.remotePort}, length ${buffer.length}`);
        } catch (err) {
            logger.error(`Error sending message: ${err.message}`);
        }
    }

    enqueueSend(task) {
        if (this.closing || this.closed) {
            return this.sendQueue;
        }
        this.sendQueue = this.sendQueue
            .then(() => {
                if (this.closing || this.closed) {
                    return undefined;
                }
                return task();
            })
            .catch(error => {
                logger.error(`RPKI send queue error: ${error.message}`);
            });
        return this.sendQueue;
    }

    canWrite() {
        return !this.closing && !this.closed && Boolean(this.socket) && !this.socket.destroyed;
    }

    async writeBuffer(buffer) {
        if (!buffer || buffer.length === 0) {
            return false;
        }
        if (!this.canWrite()) {
            return false;
        }

        try {
            if (this.socket.write(buffer) === false) {
                await this.waitForDrain();
            }
            logger.debug(`Sent message to ${this.remoteIp}:${this.remotePort}, length ${buffer.length}`);
            return true;
        } catch (err) {
            logger.error(`Error sending message: ${err.message}`);
            return false;
        }
    }

    async waitForDrain() {
        const socket = this.socket;
        if (!socket || socket.destroyed) {
            return;
        }

        await new Promise((resolve, reject) => {
            const cleanup = () => {
                socket.removeListener('drain', onDrain);
                socket.removeListener('close', onClose);
                socket.removeListener('error', onError);
                this.pendingDrainCancels.delete(onClose);
            };
            const onDrain = () => {
                cleanup();
                resolve();
            };
            const onClose = () => {
                cleanup();
                reject(new Error('Socket closed before drain'));
            };
            const onError = error => {
                cleanup();
                reject(error);
            };

            this.pendingDrainCancels.add(onClose);
            socket.once('drain', onDrain);
            socket.once('close', onClose);
            socket.once('error', onError);
            if (this.closing || this.closed) {
                onClose();
            }
        });
    }

    buildCacheResponsePdu() {
        const buffer = Buffer.alloc(RpkiConst.RPKI_HEADER_LENGTH);

        buffer[0] = this.protocolVersion;
        buffer[1] = RpkiConst.RPKI_MSG_TYPE.CACHE_RESPONSE;
        if (this.sessionId === null) {
            this.sessionId = Math.floor(Math.random() * 65536);
        }
        buffer.writeUInt16BE(this.sessionId, 2);
        buffer.writeUInt32BE(RpkiConst.RPKI_HEADER_LENGTH, 4);

        return buffer;
    }

    sendCacheResponse() {
        this.sendMessage(this.buildCacheResponsePdu());
    }

    normalizeSerial(value, fallback = 1) {
        const number = Number(value);
        return Number.isInteger(number) && number >= 0 ? number >>> 0 : Number(fallback) >>> 0;
    }

    getCurrentSerial() {
        return Number.isInteger(this.rpkiWorker?.cacheSerial) ? this.rpkiWorker.cacheSerial >>> 0 : 1;
    }

    buildSerialNotifyPdu() {
        const totalLen = RpkiConst.RPKI_HEADER_LENGTH + 4;
        const buffer = Buffer.alloc(totalLen);

        buffer[0] = this.protocolVersion;
        buffer[1] = RpkiConst.RPKI_MSG_TYPE.SERIAL_NOTIFY;
        buffer.writeUInt16BE(this.sessionId, 2);
        buffer.writeUInt32BE(totalLen, 4);
        buffer.writeUInt32BE(this.getCurrentSerial(), RpkiConst.RPKI_HEADER_LENGTH);

        return buffer;
    }

    sendSerialNotify() {
        if (this.sessionId === null) {
            return;
        }
        this.enqueueSend(() => this.writeBuffer(this.buildSerialNotifyPdu()));
    }

    buildPrefixPdu(rpkiRoa, flags, isIpv6) {
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
        buffer[position++] = Number(rpkiRoa.mask);
        buffer[position++] = Number(rpkiRoa.maxLength);
        buffer[position++] = 0; // Padding

        const ipBytesArray = ipToBytes(rpkiRoa.ip);
        for (let i = 0; i < prefixLen; i++) {
            buffer[position + i] = ipBytesArray[i];
        }
        position += prefixLen;

        buffer.writeUInt32BE(Number(rpkiRoa.asn), position);

        return buffer;
    }

    writePrefixPdu(rpkiRoa, flags, isIpv6) {
        this.sendMessage(this.buildPrefixPdu(rpkiRoa, flags, isIpv6));
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
    buildRouterKeyPdu(rpkiRouterKey, flags) {
        if (this.protocolVersion < RpkiConst.RPKI_PROTOCOL_VERSION.V1) {
            logger.warn(`Cannot send Router Key PDU on protocol version ${this.protocolVersion}`);
            return null;
        }
        const skiBuf = Buffer.from(rpkiRouterKey.ski, 'hex');
        const spkiBuf = Buffer.from(rpkiRouterKey.spki, 'hex');
        if (skiBuf.length !== 20) {
            logger.error(`Router Key SKI must be 20 bytes, got ${skiBuf.length}`);
            return null;
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

        return buffer;
    }

    writeRouterKeyPdu(rpkiRouterKey, flags) {
        const buffer = this.buildRouterKeyPdu(rpkiRouterKey, flags);
        if (buffer) {
            this.sendMessage(buffer);
        }
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
    //   Header(8: Ver|Type|Zero|Length) + Flags(1) + AFI Flags(1) + Provider AS Count(2)
    //   + Customer ASN(4) + Provider ASNs(4*N)
    //   Total = 16 + 4N
    getLegacyAspaAfiFlags(rpkiAspa) {
        const afiFlags = Number(rpkiAspa.afiFlags);
        const legacyAfiFlags = [];

        if ((afiFlags & RpkiConst.RPKI_ASPA_AFI_FLAGS.IPV4) !== 0) {
            legacyAfiFlags.push(0);
        }
        if ((afiFlags & RpkiConst.RPKI_ASPA_AFI_FLAGS.IPV6) !== 0) {
            legacyAfiFlags.push(1);
        }

        return legacyAfiFlags.length > 0 ? legacyAfiFlags : [0];
    }

    buildAspaLegacyPdu(rpkiAspa, flags, legacyAfiFlags) {
        const isWithdrawal = flags === RpkiConst.RPKI_FLAGS.WITHDRAWAL;
        const providerCount = isWithdrawal ? 0 : rpkiAspa.providerAsns.length;
        const totalLen = RpkiConst.RPKI_HEADER_LENGTH + 8 + 4 * providerCount;
        const buffer = Buffer.alloc(totalLen);
        let position = 0;

        buffer[position++] = this.protocolVersion;
        buffer[position++] = RpkiConst.RPKI_MSG_TYPE.ASPA;
        buffer.writeUInt16BE(0, position);
        position += 2;
        buffer.writeUInt32BE(totalLen, position);
        position += 4;
        buffer[position++] = flags;
        buffer[position++] = legacyAfiFlags;
        buffer.writeUInt16BE(providerCount, position);
        position += 2;
        buffer.writeUInt32BE(parseInt(rpkiAspa.customerAsn, 10), position);
        position += 4;

        for (let i = 0; i < providerCount; i++) {
            buffer.writeUInt32BE(parseInt(rpkiAspa.providerAsns[i], 10), position);
            position += 4;
        }

        return buffer;
    }

    writeAspaLegacyPdu(rpkiAspa, flags, legacyAfiFlags) {
        this.sendMessage(this.buildAspaLegacyPdu(rpkiAspa, flags, legacyAfiFlags));
    }

    buildAspaPdus(rpkiAspa, flags) {
        if (this.protocolVersion < RpkiConst.RPKI_PROTOCOL_VERSION.V2) {
            logger.warn(`Cannot send ASPA PDU on protocol version ${this.protocolVersion}`);
            return [];
        }
        const providerCount = rpkiAspa.providerAsns.length;
        const isLegacy = this.aspaFormat === RpkiConst.RPKI_ASPA_FORMAT.LEGACY;
        if (isLegacy) {
            return this.getLegacyAspaAfiFlags(rpkiAspa).map(legacyAfiFlags =>
                this.buildAspaLegacyPdu(rpkiAspa, flags, legacyAfiFlags)
            );
        }

        const isWithdrawal = flags === RpkiConst.RPKI_FLAGS.WITHDRAWAL;
        const pduProviderCount = isWithdrawal ? 0 : providerCount;
        const totalLen = RpkiConst.RPKI_HEADER_LENGTH + 4 + 4 * pduProviderCount;
        const buffer = Buffer.alloc(totalLen);
        let position = 0;

        buffer[position++] = this.protocolVersion;
        buffer[position++] = RpkiConst.RPKI_MSG_TYPE.ASPA;
        buffer[position++] = flags;
        // byte 3 is zero in the latest ASPA PDU format.
        buffer[position++] = 0;
        buffer.writeUInt32BE(totalLen, position);
        position += 4;

        buffer.writeUInt32BE(parseInt(rpkiAspa.customerAsn, 10), position);
        position += 4;
        for (let i = 0; i < pduProviderCount; i++) {
            buffer.writeUInt32BE(parseInt(rpkiAspa.providerAsns[i], 10), position);
            position += 4;
        }

        return [buffer];
    }

    writeAspaPdu(rpkiAspa, flags) {
        for (const buffer of this.buildAspaPdus(rpkiAspa, flags)) {
            this.sendMessage(buffer);
        }
    }

    sendAspa(rpkiAspa) {
        this.writeAspaPdu(rpkiAspa, RpkiConst.RPKI_FLAGS.UPDATE);
    }

    withdrawAspa(rpkiAspa) {
        this.writeAspaPdu(rpkiAspa, RpkiConst.RPKI_FLAGS.WITHDRAWAL);
    }

    buildAspaReplacementPdus(oldAspa, newAspa) {
        if (this.protocolVersion < RpkiConst.RPKI_PROTOCOL_VERSION.V2) {
            logger.warn(`Cannot replace ASPA PDU on protocol version ${this.protocolVersion}`);
            return [];
        }

        if (this.aspaFormat !== RpkiConst.RPKI_ASPA_FORMAT.LEGACY) {
            return this.buildAspaPdus(newAspa, RpkiConst.RPKI_FLAGS.UPDATE);
        }

        const buffers = [];
        const oldAfiFlags = new Set(this.getLegacyAspaAfiFlags(oldAspa));
        const newAfiFlags = new Set(this.getLegacyAspaAfiFlags(newAspa));

        for (const legacyAfiFlags of newAfiFlags) {
            buffers.push(this.buildAspaLegacyPdu(newAspa, RpkiConst.RPKI_FLAGS.UPDATE, legacyAfiFlags));
        }
        for (const legacyAfiFlags of oldAfiFlags) {
            if (!newAfiFlags.has(legacyAfiFlags)) {
                buffers.push(this.buildAspaLegacyPdu(oldAspa, RpkiConst.RPKI_FLAGS.WITHDRAWAL, legacyAfiFlags));
            }
        }

        return buffers;
    }

    replaceAspa(oldAspa, newAspa) {
        if (this.protocolVersion < RpkiConst.RPKI_PROTOCOL_VERSION.V2) {
            logger.warn(`Cannot replace ASPA PDU on protocol version ${this.protocolVersion}`);
            return;
        }

        for (const buffer of this.buildAspaReplacementPdus(oldAspa, newAspa)) {
            this.sendMessage(buffer);
        }
    }

    buildDeltaOperationBuffers(operation) {
        if (!operation || !operation.type) {
            return [];
        }

        if (operation.type === 'roa') {
            const flags =
                operation.action === 'withdraw' ? RpkiConst.RPKI_FLAGS.WITHDRAWAL : RpkiConst.RPKI_FLAGS.UPDATE;
            const roa = operation.data;
            const isIpv6 = roa.ipType !== BgpConst.IP_TYPE.IPV4;
            return [this.buildPrefixPdu(roa, flags, isIpv6)];
        }

        if (operation.type === 'routerKey') {
            const flags =
                operation.action === 'withdraw' ? RpkiConst.RPKI_FLAGS.WITHDRAWAL : RpkiConst.RPKI_FLAGS.UPDATE;
            const buffer = this.buildRouterKeyPdu(operation.data, flags);
            return buffer ? [buffer] : [];
        }

        if (operation.type === 'aspa') {
            if (operation.action === 'replace') {
                return this.buildAspaReplacementPdus(operation.oldData, operation.newData);
            }
            const flags =
                operation.action === 'withdraw' ? RpkiConst.RPKI_FLAGS.WITHDRAWAL : RpkiConst.RPKI_FLAGS.UPDATE;
            return this.buildAspaPdus(operation.data, flags);
        }

        return [];
    }

    async writeDeltaOperations(operations) {
        for (const operation of operations || []) {
            for (const buffer of this.buildDeltaOperationBuffers(operation)) {
                if (!(await this.writeBuffer(buffer))) {
                    return false;
                }
            }
        }
        return true;
    }

    sendSerialQueryResponse(operations, serial = this.getCurrentSerial()) {
        const responseSerial = this.normalizeSerial(serial, this.getCurrentSerial());
        this.enqueueSend(async () => {
            if (!(await this.writeBuffer(this.buildCacheResponsePdu()))) {
                return;
            }
            if (!(await this.writeDeltaOperations(operations))) {
                return;
            }
            await this.writeBuffer(this.buildEndOfDataPdu(responseSerial));
        });
    }

    buildEndOfDataPdu(serial = this.getCurrentSerial()) {
        const endOfDataSerial = this.normalizeSerial(serial, this.getCurrentSerial());
        if (this.protocolVersion >= RpkiConst.RPKI_PROTOCOL_VERSION.V1) {
            // RFC 8210 §5.8: Header(8, sessionID in bytes 2-3) + Serial(4) + Refresh(4) + Retry(4) + Expire(4)
            // Total = 24
            const totalLen = RpkiConst.RPKI_HEADER_LENGTH + 16;
            const buffer = Buffer.alloc(totalLen);

            buffer[0] = this.protocolVersion;
            buffer[1] = RpkiConst.RPKI_MSG_TYPE.END_OF_DATA;
            buffer.writeUInt16BE(this.sessionId, 2);
            buffer.writeUInt32BE(totalLen, 4);

            buffer.writeUInt32BE(endOfDataSerial, RpkiConst.RPKI_HEADER_LENGTH); // Serial Number
            buffer.writeUInt32BE(3600, RpkiConst.RPKI_HEADER_LENGTH + 4); // Refresh
            buffer.writeUInt32BE(600, RpkiConst.RPKI_HEADER_LENGTH + 8); // Retry
            buffer.writeUInt32BE(7200, RpkiConst.RPKI_HEADER_LENGTH + 12); // Expire

            return buffer;
        } else {
            // RFC 6810 §5.8: Header(8, sessionID in bytes 2-3) + Serial(4). Total = 12
            const totalLen = RpkiConst.RPKI_HEADER_LENGTH + 4;
            const buffer = Buffer.alloc(totalLen);

            buffer[0] = this.protocolVersion;
            buffer[1] = RpkiConst.RPKI_MSG_TYPE.END_OF_DATA;
            buffer.writeUInt16BE(this.sessionId, 2);
            buffer.writeUInt32BE(totalLen, 4);
            buffer.writeUInt32BE(endOfDataSerial, RpkiConst.RPKI_HEADER_LENGTH); // Serial Number

            return buffer;
        }
    }

    sendEndOfData(serial = this.getCurrentSerial()) {
        this.sendMessage(this.buildEndOfDataPdu(serial));
    }

    sendCacheReset() {
        const buffer = Buffer.alloc(RpkiConst.RPKI_HEADER_LENGTH);

        buffer[0] = this.protocolVersion;
        buffer[1] = RpkiConst.RPKI_MSG_TYPE.CACHE_RESET;
        buffer.writeUInt16BE(0, 2);
        buffer.writeUInt32BE(RpkiConst.RPKI_HEADER_LENGTH, 4);

        this.sendMessage(buffer);
    }

    buildErrorReportPdu(errorCode, protocolVersion = this.protocolVersion) {
        const buffer = Buffer.alloc(RpkiConst.RPKI_HEADER_LENGTH + 8);

        buffer[0] = protocolVersion;
        buffer[1] = RpkiConst.RPKI_MSG_TYPE.ERROR_REPORT;
        buffer.writeUInt16BE(errorCode, 2);
        buffer.writeUInt32BE(RpkiConst.RPKI_HEADER_LENGTH + 8, 4);
        buffer.writeUInt32BE(0, RpkiConst.RPKI_HEADER_LENGTH); // Encapsulated PDU length = 0
        buffer.writeUInt32BE(0, RpkiConst.RPKI_HEADER_LENGTH + 4); // Error text length = 0

        return buffer;
    }

    // Error Report PDU: Header + ErrorCode(2 in reserved) + Length(4) + EncapPduLen(4) + EncapPdu + ErrTextLen(4) + ErrText
    sendError(errorCode, protocolVersion = this.protocolVersion, closeAfterSend = false) {
        const buffer = this.buildErrorReportPdu(errorCode, protocolVersion);

        if (!closeAfterSend) {
            this.sendMessage(buffer);
            return;
        }

        if (!this.socket || this.socket.destroyed) {
            logger.error(`Cannot send error report: socket is closed or destroyed`);
            this.closeSession();
            return;
        }

        try {
            this.closing = true;
            if (typeof this.socket.end === 'function') {
                const socket = this.socket;
                this.socket.end(buffer, () => {
                    if (!socket.destroyed && typeof socket.destroy === 'function') {
                        socket.destroy();
                    }
                    if (this.socket === socket) {
                        this.socket = null;
                    }
                });
                this.closeSession({ destroySocket: false });
            } else {
                this.socket.write(buffer);
                this.closeSession();
            }
            logger.debug(`Sent error report and closed ${this.remoteIp}:${this.remotePort}, length ${buffer.length}`);
        } catch (err) {
            logger.error(`Error sending error report: ${err.message}`);
            this.closeSession();
        }
    }

    async writeChunkedPduList(items, buildPdus, description) {
        let chunkBuffers = [];
        let chunkBytes = 0;
        let count = 0;

        const flush = async () => {
            if (chunkBytes === 0) {
                return true;
            }

            const buffer = Buffer.concat(chunkBuffers, chunkBytes);
            chunkBuffers = [];
            chunkBytes = 0;
            const written = await this.writeBuffer(buffer);
            if (written) {
                await yieldToIoLoop();
            }
            return written;
        };

        for (const item of items || []) {
            if (!this.canWrite()) {
                return false;
            }
            const built = buildPdus(item);
            const pdus = Array.isArray(built) ? built : built ? [built] : [];
            for (const pdu of pdus) {
                if (!Buffer.isBuffer(pdu) || pdu.length === 0) {
                    continue;
                }
                if (chunkBytes > 0 && chunkBytes + pdu.length > ROA_WRITE_CHUNK_SIZE) {
                    if (!(await flush())) {
                        return false;
                    }
                }

                if (pdu.length > ROA_WRITE_CHUNK_SIZE) {
                    if (!(await this.writeBuffer(pdu))) {
                        return false;
                    }
                    await yieldToIoLoop();
                } else {
                    chunkBuffers.push(pdu);
                    chunkBytes += pdu.length;
                }
            }
            count += 1;
        }

        if (!(await flush())) {
            return false;
        }
        logger.info(`RPKI ${description}批量发送完成: count=${count}`);
        return true;
    }

    async writeRoaListData(roas, flags) {
        return this.writeChunkedPduList(
            roas,
            roa => {
                const isIpv6 = roa.ipType !== BgpConst.IP_TYPE.IPV4;
                return this.buildPrefixPdu(roa, flags, isIpv6);
            },
            `ROA flags=${flags} `
        );
    }

    async writeRouterKeyData(routerKeys = this.rpkiWorker?.rpkiRouterKeyMap?.values?.() || []) {
        return this.writeChunkedPduList(
            routerKeys,
            rk => this.buildRouterKeyPdu(rk, RpkiConst.RPKI_FLAGS.UPDATE),
            'Router Key '
        );
    }

    async writeAspaListData(aspas, flags) {
        return this.writeChunkedPduList(aspas, aspa => this.buildAspaPdus(aspa, flags), `ASPA flags=${flags} `);
    }

    sendRouterKeyData() {
        for (const rk of this.rpkiWorker.rpkiRouterKeyMap.values()) {
            this.sendRouterKey(rk);
        }
    }

    sendAspaData(aspas = []) {
        return this.enqueueSend(() => this.writeAspaListData(aspas, RpkiConst.RPKI_FLAGS.UPDATE));
    }

    async sendRoaData(roas = []) {
        return this.writeRoaListData(roas, RpkiConst.RPKI_FLAGS.UPDATE);
    }

    async withdrawRoaData(roas = []) {
        return this.writeRoaListData(roas, RpkiConst.RPKI_FLAGS.WITHDRAWAL);
    }

    sendRoaBatchData(roas) {
        this.enqueueSend(() => this.writeRoaListData(roas, RpkiConst.RPKI_FLAGS.UPDATE));
    }

    withdrawRoaBatchData(roas) {
        this.enqueueSend(() => this.writeRoaListData(roas, RpkiConst.RPKI_FLAGS.WITHDRAWAL));
    }

    sendSingleRoaData(rpkiRoa) {
        this.sendRoaBatchData([rpkiRoa]);
    }

    withdrawSingleRoaData(rpkiRoa) {
        this.withdrawRoaBatchData([rpkiRoa]);
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
