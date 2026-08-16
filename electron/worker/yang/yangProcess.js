'use strict';

const { getParentMessageEndpoint } = require('../core/parentMessageEndpoint');
const { LOG_REQ_TYPES } = require('../../const/toolsConst');
const logger = require('../../log/logger');
const { NETCONF_REQ_TYPES } = require('../../const/yangConst');
const NetconfWorkerService = require('./netconfWorker');
const YangDownloadService = require('./yangDownloadService');
const YangRuntimeHost = require('./yangRuntimeHost');
const { YANG_PROCESS_REQ_TYPES } = require('./yangProcessProtocol');

const endpoint = getParentMessageEndpoint();
const NETCONF_OPERATIONS = new Set(Object.values(NETCONF_REQ_TYPES));

function errorData(error) {
    return {
        name: error?.name || 'Error',
        code: error?.code || 'YANG_PROCESS_ERROR',
        message: error?.message || String(error),
        errors: error?.errors || error?.data?.errors || [],
        messageId: error?.messageId || error?.data?.messageId || null,
        requestXml: error?.requestXml || error?.data?.requestXml || null,
        replyXml: error?.replyXml || error?.data?.replyXml || null,
        subscription: error?.subscription || error?.data?.subscription || null,
        ...(error?.data === undefined ? {} : { details: error.data })
    };
}

class YangProcessService {
    constructor(port = endpoint, options = {}) {
        this.port = port;
        this.netconf = options.netconfService || new NetconfWorkerService(port, { listen: false });
        this.runtime = null;
        this.downloads = null;
        this.deletedProfiles = new Set();
        this.cancelledRequests = new Set();
        this.closing = false;
        this.closed = false;
        this.closePromise = null;
        if (this.port && options.listen !== false) this.port.on('message', message => this.handleMessage(message));
    }

    sendResponse(messageId, status, data = null, msg = '', code = null) {
        this.port?.postMessage({ messageId, status, data, msg, code });
    }

    async configure(data = {}) {
        if (this.runtime) return { configured: true };
        this.runtime = new YangRuntimeHost(this.port, data);
        this.downloads = new YangDownloadService({
            netconfService: this.netconf,
            runtimeHost: this.runtime,
            validateProfile: profileId => this.assertProfileAvailable(profileId)
        });
        for (const profileId of data.pendingWorkspaceDeletions || []) {
            this.deletedProfiles.add(String(profileId));
            await this.runtime.deleteProfileWorkspace(profileId);
        }
        return { configured: true, rootDir: this.runtime.runtime.rootDir };
    }

    requireRuntime() {
        if (this.runtime) return this.runtime;
        const error = new Error('YANG process is not configured');
        error.code = 'YANG_PROCESS_NOT_CONFIGURED';
        throw error;
    }

    requireDownloads() {
        if (this.downloads) return this.downloads;
        const error = new Error('YANG process is not configured');
        error.code = 'YANG_PROCESS_NOT_CONFIGURED';
        throw error;
    }

    assertProfileAvailable(profileId) {
        const id = String(profileId || '');
        if (!this.deletedProfiles.has(id)) return;
        const error = new Error('连接 Profile 正在删除或已被删除');
        error.code = 'NETCONF_PROFILE_DELETING';
        throw error;
    }

    requestProfileId(data, options = {}) {
        const explicit =
            data && typeof data === 'object'
                ? data.profileId || (options.includeId === true ? data.id : null)
                : typeof data === 'string'
                  ? data
                  : null;
        return String(
            explicit || (options.fallbackActive === false ? '' : this.runtime?.runtime?.activeProfileId) || ''
        );
    }

    assertRequestProfileAvailable(data, options = {}) {
        const profileId = this.requestProfileId(data, options);
        if (profileId) this.assertProfileAvailable(profileId);
        return profileId;
    }

    cancelRequest(messageId) {
        if (!messageId) return;
        this.cancelledRequests.add(messageId);
        this.netconf.cancelRequest(messageId);
    }

    close() {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        this.closePromise = (async () => {
            const pendingDownloads = this.downloads?.abortAll() || [];
            await this.netconf.disconnectAll().catch(() => {});
            await Promise.allSettled(pendingDownloads);
            await this.runtime?.close();
            this.closed = true;
            return { closed: true };
        })();
        return this.closePromise;
    }

    async dispatch(operation, data = {}, context = {}) {
        if (operation === YANG_PROCESS_REQ_TYPES.CLOSE) return this.close();
        if (this.closing || this.closed) {
            const error = new Error('YANG process is closing');
            error.code = 'YANG_PROCESS_CLOSING';
            throw error;
        }
        if (operation === YANG_PROCESS_REQ_TYPES.CONFIGURE) return this.configure(data);
        if (operation === YANG_PROCESS_REQ_TYPES.SET_ACTIVE_PROFILE) {
            this.assertRequestProfileAvailable(data, { fallbackActive: false });
            return this.requireRuntime().setActiveProfileId(data?.profileId);
        }
        if (operation === YANG_PROCESS_REQ_TYPES.GET_WORKSPACE_GENERATION) {
            this.assertRequestProfileAvailable(data);
            return this.requireRuntime().getWorkspaceGeneration(data);
        }
        if (operation === YANG_PROCESS_REQ_TYPES.IMPORT_DOWNLOADED_CONTENTS) {
            this.assertRequestProfileAvailable(data?.options || data);
            const runtime = this.requireRuntime();
            return runtime.runtime.importDownloadedContents(data?.contents || [], data?.options || {}, {
                sender: runtime.eventTarget
            });
        }
        if (operation === YANG_PROCESS_REQ_TYPES.DOWNLOAD_MODULES) {
            return this.requireDownloads().startDownload(data);
        }
        if (operation === YANG_PROCESS_REQ_TYPES.GET_TASK) {
            return this.requireDownloads().getTask(data && typeof data === 'object' ? data.taskId : data);
        }
        if (operation === YANG_PROCESS_REQ_TYPES.CANCEL_TASK) {
            return this.requireDownloads().cancelTask(data && typeof data === 'object' ? data.taskId : data);
        }
        if (operation === YANG_PROCESS_REQ_TYPES.DELETE_PROFILE_WORKSPACE) {
            const profileId = String(data?.profileId || '');
            if (!profileId) {
                const error = new Error('删除YANG工作区需要连接 Profile ID');
                error.code = 'NETCONF_PROFILE_REQUIRED';
                throw error;
            }
            this.assertProfileAvailable(profileId);
            this.deletedProfiles.add(profileId);
            const pendingDownloads = this.requireDownloads().abortProfile(profileId);
            try {
                try {
                    await this.netconf.dispatch(NETCONF_REQ_TYPES.PURGE_PROFILE, { profileId }, context);
                } finally {
                    await Promise.allSettled(pendingDownloads);
                }
                return await this.requireRuntime().deleteProfileWorkspace(profileId);
            } catch (error) {
                this.deletedProfiles.delete(profileId);
                throw error;
            }
        }
        if (operation === LOG_REQ_TYPES.SET_LOG_LEVEL) {
            logger.setLevel(data);
            await this.runtime?.runtime?.handleLogLevelChange?.(logger.logLevel);
            return { logLevel: logger.logLevel };
        }
        if (NETCONF_OPERATIONS.has(operation)) {
            if (![NETCONF_REQ_TYPES.CONNECT, NETCONF_REQ_TYPES.PURGE_PROFILE].includes(operation)) {
                this.assertRequestProfileAvailable(data, { includeId: true });
            }
            if (operation === NETCONF_REQ_TYPES.DISCOVER_MODULES) {
                return this.requireDownloads().discoverModules(data, context);
            }
            if (operation === NETCONF_REQ_TYPES.PURGE_PROFILE) {
                this.deletedProfiles.add(String(data?.profileId || ''));
                const pendingDownloads = this.downloads?.abortProfile(data?.profileId) || [];
                try {
                    return await this.netconf.dispatch(operation, data, context);
                } finally {
                    await Promise.allSettled(pendingDownloads);
                }
            }
            if (operation === NETCONF_REQ_TYPES.DISCONNECT) {
                const pendingDownloads = this.downloads?.abortProfile(data?.profileId, { keepInventory: true }) || [];
                try {
                    return await this.netconf.dispatch(operation, data, context);
                } finally {
                    await Promise.allSettled(pendingDownloads);
                    this.runtime?.setActiveProfileId(null);
                }
            }
            if (operation === NETCONF_REQ_TYPES.DISCONNECT_ALL) {
                const pendingDownloads = this.downloads?.abortAll() || [];
                try {
                    return await this.netconf.dispatch(operation, data, context);
                } finally {
                    await Promise.allSettled(pendingDownloads);
                    this.runtime?.setActiveProfileId(null);
                }
            }
            const result = await this.netconf.dispatch(operation, data, context);
            if (operation === NETCONF_REQ_TYPES.CONNECT) {
                this.deletedProfiles.delete(String(result?.profileId || data?.id || ''));
                this.requireRuntime().setActiveProfileId(result?.profileId || data?.id);
            }
            return result;
        }
        const runtime = this.requireRuntime();
        if (runtime.handles(operation)) {
            this.assertRequestProfileAvailable(data);
            return runtime.dispatch(operation, data);
        }
        const error = new Error(`Unsupported YANG process operation: ${operation}`);
        error.code = 'YANG_PROCESS_UNKNOWN_OPERATION';
        throw error;
    }

    async handleMessage(message = {}) {
        const { messageId, op, data } = message;
        if (op === '__cancel__') {
            this.cancelRequest(data?.messageId);
            return;
        }
        try {
            const result = await this.dispatch(op, data || {}, { messageId });
            if (!this.cancelledRequests.has(messageId)) this.sendResponse(messageId, 'success', result);
        } catch (error) {
            const detail = errorData(error);
            if (!this.cancelledRequests.has(messageId)) {
                this.sendResponse(messageId, 'error', detail, detail.message, detail.code);
            }
        } finally {
            this.cancelledRequests.delete(messageId);
        }
    }
}

if (endpoint && require.main === module) new YangProcessService(endpoint);

module.exports = YangProcessService;
