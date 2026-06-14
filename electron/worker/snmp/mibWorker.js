const logger = require('../../log/logger');
const WorkerMessageHandler = require('../core/workerMessageHandler');
const SnmpConst = require('../../const/snmpConst');
const MibRegistry = require('../../utils/mibRegistry');

class MibWorker {
    constructor() {
        this.mibRegistry = new MibRegistry();
        this.messageHandler = new WorkerMessageHandler();
        this.messageHandler.init();
        this.messageHandler.registerHandler(SnmpConst.MIB_REQ_TYPES.COMPILE_MIBS, this.compileMibs.bind(this));
        this.messageHandler.registerHandler(SnmpConst.MIB_REQ_TYPES.GET_MIB_STATUS, this.getMibStatus.bind(this));
        this.messageHandler.registerHandler(
            SnmpConst.MIB_REQ_TYPES.GET_MIB_TREE_CHILDREN,
            this.getMibTreeChildren.bind(this)
        );
        this.messageHandler.registerHandler(SnmpConst.MIB_REQ_TYPES.CLEAR_MIBS, this.clearMibs.bind(this));
        this.messageHandler.registerHandler(SnmpConst.MIB_REQ_TYPES.TRANSLATE_OID, this.translateOid.bind(this));
    }

    normalizeRequest(data = {}) {
        if (Array.isArray(data)) {
            return {
                filePaths: data,
                cacheFilePath: '',
                force: false
            };
        }

        return {
            filePaths: data.filePaths || data.requestedFiles || [],
            cacheFilePath: data.cacheFilePath || '',
            force: Boolean(data.force)
        };
    }

    compileIfNeeded(data = {}) {
        const request = this.normalizeRequest(data);
        return this.mibRegistry.loadOrCompileMibFiles(request.filePaths, {
            cacheFilePath: request.cacheFilePath,
            force: request.force
        });
    }

    compileMibs(messageId, data = {}) {
        try {
            const request = this.normalizeRequest(data);
            const summary = this.mibRegistry.loadOrCompileMibFiles(request.filePaths, {
                cacheFilePath: request.cacheFilePath,
                force: request.force
            });
            this.messageHandler.sendSuccessResponse(messageId, summary, 'MIB编译完成');
        } catch (error) {
            logger.error('MIB后台编译失败:', error);
            this.messageHandler.sendErrorResponse(messageId, 'MIB编译失败: ' + error.message);
        }
    }

    getMibStatus(messageId, data = {}) {
        try {
            const summary = this.compileIfNeeded(data);
            this.messageHandler.sendSuccessResponse(messageId, summary, '获取MIB状态成功');
        } catch (error) {
            logger.error('获取MIB状态失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '获取MIB状态失败: ' + error.message);
        }
    }

    getMibTreeChildren(messageId, data = {}) {
        try {
            this.compileIfNeeded(data);
            const parentOid = typeof data.parentOid === 'string' ? data.parentOid : '';
            this.messageHandler.sendSuccessResponse(
                messageId,
                this.mibRegistry.getOidTreeChildren(parentOid),
                '获取MIB树节点成功'
            );
        } catch (error) {
            logger.error('获取MIB树节点失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '获取MIB树节点失败: ' + error.message);
        }
    }

    clearMibs(messageId, data = {}) {
        try {
            const request = this.normalizeRequest(data);
            this.mibRegistry.reset();
            this.mibRegistry.clearCache(request.cacheFilePath);
            this.messageHandler.sendSuccessResponse(messageId, this.mibRegistry.getSummary(), 'MIB配置已清空');
        } catch (error) {
            logger.error('清空MIB配置失败:', error);
            this.messageHandler.sendErrorResponse(messageId, '清空MIB配置失败: ' + error.message);
        }
    }

    translateOid(messageId, data = {}) {
        try {
            this.compileIfNeeded(data);
            this.messageHandler.sendSuccessResponse(messageId, this.mibRegistry.translateOid(data.oid), 'OID解析成功');
        } catch (error) {
            logger.error('OID解析失败:', error);
            this.messageHandler.sendErrorResponse(messageId, 'OID解析失败: ' + error.message);
        }
    }
}

new MibWorker();
