const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { BrowserWindow, dialog } = require('electron');
const logger = require('../log/logger');
const { successResponse, errorResponse } = require('../utils/responseUtils');
const EventDispatcher = require('../utils/eventDispatcher');
const SecureCredentialStore = require('../utils/secureCredentialStore');
const TaskManager = require('../utils/taskManager');
const RequestWorkerClient = require('../worker/core/requestWorkerClient');
const { resolveWorkerPath } = require('../worker/core/workerPathResolver');
const { NETCONF_REQ_TYPES, YANG_EVT_TYPES, DEFAULT_NETCONF_PROFILE, NETCONF_LIMITS } = require('../const/yangConst');

const PROFILE_STORE_KEY = 'netconf-profiles';
const RPC_TIMEOUT_MIGRATION_STORE_KEY = 'netconf-rpc-timeout-default-v2';
const LEGACY_DEFAULT_RPC_TIMEOUT = 30000;
const ALLOWED_AUTH_METHODS = new Set(['password', 'privateKey', 'agent']);
const ALLOWED_HOST_KEY_POLICIES = new Set(['ask', 'strict', 'accept-new']);
const INITIAL_PASSWORD_CHANGE_REQUIRED_CODE = 'NETCONF_INITIAL_PASSWORD_CHANGE_REQUIRED';
const MAX_SUBSCRIPTION_SNAPSHOTS_PER_PROFILE = 256;
const MAX_SUBSCRIPTION_SNAPSHOT_BYTES_PER_PROFILE = 16 * 1024 * 1024;
const MAX_NOTIFICATION_HISTORY_RECORDS = 500;
const MAX_NOTIFICATION_HISTORY_BYTES = 16 * 1024 * 1024;
const MAX_NOTIFICATION_XML_BYTES = 2 * 1024 * 1024;
const MAX_NOTIFICATION_ACTION_BYTES = 128 * 1024;
const NOTIFICATION_SUMMARY_DELAY_MS = 200;
const MAX_RPC_REPLY_ARTIFACTS = 32;
const MAX_RPC_REPLY_ARTIFACT_BYTES = 256 * 1024 * 1024;
const RPC_REPLY_ARTIFACT_PREFIX = 'netnexus-netconf-replies-';
const NOTIFICATION_ACTIONS = new Set([
    'modify-subscription',
    'delete-subscription',
    'resync-subscription',
    'disconnect-session'
]);

const NOTIFICATION_ACTION_FIELDS = Object.freeze([
    'id',
    'subscriptionId',
    'deviceSubscriptionId',
    'modernSubscriptionId',
    'profileId',
    'profileName',
    'host',
    'port',
    'sessionId',
    'label',
    'subscriptionName',
    'protocol',
    'type',
    'subscriptionType',
    'targetType',
    'stream',
    'datastore',
    'datastoreNamespaces',
    'filter',
    'replayStartTime',
    'stopTime',
    'dscp',
    'weighting',
    'dependency',
    'encoding',
    'encodingNamespaces',
    'updateTrigger',
    'period',
    'anchorTime',
    'dampeningPeriod',
    'syncOnStart',
    'excludedChanges',
    'capabilitySupport',
    'state',
    'status'
]);

const snapshotBytes = value => {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch (_error) {
        return 0;
    }
};

const truncateUtf8Text = (value, maxBytes, markerText) => {
    const text = String(value ?? '');
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { value: text, truncated: false };
    const marker = `\n<!-- ${markerText} -->`;
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    const availableBytes = Math.max(0, maxBytes - markerBytes);
    let low = 0;
    let high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= availableBytes) low = middle;
        else high = middle - 1;
    }
    return { value: `${text.slice(0, low)}${marker}`, truncated: true };
};

const clonePlainValue = value => {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_error) {
        return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
    }
};

const compactActionValue = (value, depth = 0) => {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
        return truncateUtf8Text(value, 64 * 1024, 'NetNexus：动作字段已截断').value;
    }
    if (depth >= 5) return null;
    if (Array.isArray(value)) return value.slice(0, 256).map(item => compactActionValue(item, depth + 1));
    if (typeof value !== 'object') return String(value).slice(0, 1024);
    const result = {};
    for (const [rawKey, item] of Object.entries(value).slice(0, 128)) {
        const key = String(rawKey || '').slice(0, 128);
        if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
        result[key] = compactActionValue(item, depth + 1);
    }
    return result;
};

const rpcReplyPreview = buffer => {
    if (buffer.length <= NETCONF_LIMITS.MAX_INLINE_RPC_REPLY_BYTES) return buffer.toString('utf8');
    const marker = Buffer.from(
        `\n<!-- NetNexus：响应共 ${buffer.length} 字节，中间内容未载入；可另存完整响应 -->\n`,
        'utf8'
    );
    const contentBudget = Math.max(0, NETCONF_LIMITS.MAX_INLINE_RPC_REPLY_BYTES - marker.length);
    const headBytes = Math.ceil(contentBudget * 0.75);
    const tailBytes = contentBudget - headBytes;
    const head = buffer
        .subarray(0, headBytes)
        .toString('utf8')
        .replace(/\uFFFD+$/u, '');
    const tail = tailBytes
        ? buffer
              .subarray(buffer.length - tailBytes)
              .toString('utf8')
              .replace(/^\uFFFD+/u, '')
        : '';
    return `${head}${marker.toString('utf8')}${tail}`;
};

const suggestedReplyName = value => {
    const leaf = String(value || '')
        .split(/[\\/]/u)
        .pop()
        .replace(/\p{Cc}/gu, '-')
        .replace(/[<>:"/\\|?*]/gu, '-')
        .replace(/[. ]+$/u, '')
        .slice(0, 120);
    const fallback = `netconf-rpc-reply-${new Date().toISOString().replace(/[:.]/gu, '-')}.xml`;
    if (!leaf) return fallback;
    return /\.xml$/iu.test(leaf) ? leaf : `${leaf}.xml`;
};

class NetconfApp {
    constructor(ipcMain, store, options = {}) {
        this.ipcMain = ipcMain;
        this.store = store;
        this.yangApp = options.yangApp || null;
        this.primaryWebContents = options.primaryWebContents || null;
        this.hasFixedPrimaryWebContents = Boolean(this.primaryWebContents);
        this.closeProfileMonitorWindowsHandler =
            typeof options.closeProfileMonitorWindows === 'function' ? options.closeProfileMonitorWindows : null;
        this.closeMonitorWindowsHandler =
            typeof options.closeMonitorWindows === 'function' ? options.closeMonitorWindows : null;
        this.workerClient = null;
        this.eventDispatcher = new EventDispatcher();
        if (this.primaryWebContents && !this.primaryWebContents.isDestroyed?.()) {
            this.eventDispatcher.setWebContents(this.primaryWebContents);
        }
        this.credentialStore = options.credentialStore || new SecureCredentialStore();
        this.transientSecrets = new Map();
        this.inventories = new Map();
        this.deletingProfiles = new Set();
        this.profileGenerations = new Map();
        this.profileDeletionPromises = new Map();
        this.sessionSnapshots = new Map();
        this.subscriptionSnapshots = new Map();
        this.notificationHistory = [];
        this.notificationHistoryBytes = 0;
        this.notificationHistoryReceived = 0;
        this.notificationHistoryDropped = 0;
        this.notificationSummaryTimer = null;
        this.notificationSummaryDelayMs = Number.isFinite(Number(options.notificationSummaryDelayMs))
            ? Math.max(0, Math.min(5000, Number(options.notificationSummaryDelayMs)))
            : NOTIFICATION_SUMMARY_DELAY_MS;
        this.profileRpcTimeouts = new Map();
        this.pendingProfileConnections = new Set();
        this.activeRpcOperations = new Map();
        this.rpcReplyArtifacts = new Map();
        this.rpcReplyArtifactDirectory = null;
        this.rpcReplyArtifactDirectoryPromise = null;
        this.rpcReplyArtifactWrites = new Set();
        this.rpcReplyArtifactBaseDirectory = options.rpcReplyArtifactBaseDirectory || os.tmpdir();
        this.netconfDialog = options.dialog || dialog;
        this.closing = false;
        this.closePromise = null;
        this.activeProfileId = null;
        this.yangApp?.setActiveProfileId?.(null);
        this.logLevel = null;
        this.taskManager = new TaskManager({
            onProgress: progress => {
                if (this.eventDispatcher.canEmit(YANG_EVT_TYPES.TASK_PROGRESS)) {
                    this.eventDispatcher.emit(YANG_EVT_TYPES.TASK_PROGRESS, successResponse(progress, 'YANG任务进度'));
                }
            }
        });
        this.migrateLegacyRpcTimeouts();
        this.registerIpcHandlers();
    }

    registerIpcHandlers() {
        const handle = (channel, handler) => this.ipcMain.handle(channel, handler.bind(this));
        handle('netconf:listProfiles', this.handleListProfiles);
        handle('netconf:saveProfile', this.handleSaveProfile);
        handle('netconf:deleteProfile', this.handleDeleteProfile);
        handle('netconf:selectPrivateKey', this.handleSelectPrivateKey);
        handle('netconf:testConnection', this.handleTestConnection);
        handle('netconf:connect', this.handleConnect);
        handle('netconf:disconnect', this.handleDisconnect);
        handle('netconf:getSessionState', this.handleGetSessionState);
        handle('netconf:getSubscriptions', this.handleGetSubscriptions);
        handle('netconf:getNotificationHistory', this.handleGetNotificationHistory);
        handle('netconf:getNotificationSummary', this.handleGetNotificationSummary);
        handle('netconf:markNotificationRead', this.handleMarkNotificationRead);
        handle('netconf:deleteNotificationHistory', this.handleDeleteNotificationHistory);
        handle('netconf:clearNotificationHistory', this.handleClearNotificationHistory);
        handle('netconf:requestNotificationAction', this.handleRequestNotificationAction);
        handle('netconf:discoverModules', this.handleDiscoverModules);
        handle('netconf:downloadModules', this.handleDownloadModules);
        handle('netconf:executeOperation', this.handleExecuteOperation);
        handle('netconf:sendRpc', this.handleSendRpc);
        handle('netconf:cancelOperation', this.handleCancelOperation);
        handle('netconf:saveRpcReply', this.handleSaveRpcReply);
        handle('netconf:getTask', this.handleGetTask);
        handle('netconf:cancelTask', this.handleCancelTask);
    }

    async ensureRpcReplyArtifactDirectory() {
        if (this.rpcReplyArtifactDirectory) return this.rpcReplyArtifactDirectory;
        if (this.rpcReplyArtifactDirectoryPromise) return this.rpcReplyArtifactDirectoryPromise;
        const creation = (async () => {
            await fs.promises.mkdir(this.rpcReplyArtifactBaseDirectory, { recursive: true, mode: 0o700 });
            const directory = await fs.promises.mkdtemp(
                path.join(this.rpcReplyArtifactBaseDirectory, RPC_REPLY_ARTIFACT_PREFIX)
            );
            if (process.platform !== 'win32') await fs.promises.chmod(directory, 0o700);
            this.rpcReplyArtifactDirectory = directory;
            return directory;
        })();
        this.rpcReplyArtifactDirectoryPromise = creation;
        try {
            return await creation;
        } finally {
            if (this.rpcReplyArtifactDirectoryPromise === creation) this.rpcReplyArtifactDirectoryPromise = null;
        }
    }

    async removeRpcReplyArtifact(token) {
        const artifact = this.rpcReplyArtifacts.get(token);
        if (!artifact || !this.rpcReplyArtifacts.delete(token)) return false;
        await fs.promises.unlink(artifact.filePath).catch(error => {
            if (error?.code !== 'ENOENT') logger.warn('清理 NETCONF RPC 响应临时文件失败:', error.message);
        });
        return true;
    }

    async pruneRpcReplyArtifacts() {
        const artifacts = [...this.rpcReplyArtifacts.values()].sort((left, right) => left.createdAt - right.createdAt);
        let totalBytes = artifacts.reduce((total, artifact) => total + artifact.replyBytes, 0);
        let totalCount = artifacts.length;
        for (const artifact of artifacts) {
            if (totalCount <= MAX_RPC_REPLY_ARTIFACTS && totalBytes <= MAX_RPC_REPLY_ARTIFACT_BYTES) break;
            if (await this.removeRpcReplyArtifact(artifact.token)) {
                totalCount -= 1;
                totalBytes = Math.max(0, totalBytes - artifact.replyBytes);
            }
        }
    }

    createRpcReplyArtifact(replyXml) {
        if (this.closing) {
            const error = new Error('NETCONF 服务正在关闭，无法保留 RPC 响应');
            error.code = 'NETCONF_APP_CLOSING';
            return Promise.reject(error);
        }
        const operation = (async () => {
            const buffer = Buffer.from(String(replyXml || ''), 'utf8');
            const directory = await this.ensureRpcReplyArtifactDirectory();
            const token = randomUUID();
            const filePath = path.join(directory, `${token}.xml`);
            try {
                await fs.promises.writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 });
                if (process.platform !== 'win32') await fs.promises.chmod(filePath, 0o600);
                const artifact = {
                    token,
                    filePath,
                    replyBytes: buffer.length,
                    createdAt: Date.now()
                };
                this.rpcReplyArtifacts.set(token, artifact);
                await this.pruneRpcReplyArtifacts();
                const preview = rpcReplyPreview(buffer);
                return { ...artifact, preview, previewBytes: Buffer.byteLength(preview, 'utf8') };
            } catch (error) {
                this.rpcReplyArtifacts.delete(token);
                await fs.promises.unlink(filePath).catch(() => {});
                throw error;
            }
        })();
        this.rpcReplyArtifactWrites.add(operation);
        void operation.then(
            () => this.rpcReplyArtifactWrites.delete(operation),
            () => this.rpcReplyArtifactWrites.delete(operation)
        );
        return operation;
    }

    async externalizeRpcPayload(payload, replyField = 'reply') {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
        const replyXml = payload[replyField];
        if (typeof replyXml !== 'string') return payload;
        const replyBytes = Buffer.byteLength(replyXml, 'utf8');
        if (replyBytes <= NETCONF_LIMITS.MAX_INLINE_RPC_REPLY_BYTES) {
            return {
                ...payload,
                replyBytes,
                replyPreviewBytes: replyBytes,
                replyTruncated: false
            };
        }

        let externalized;
        try {
            const artifact = await this.createRpcReplyArtifact(replyXml);
            externalized = {
                ...payload,
                [replyField]: artifact.preview,
                replyBytes: artifact.replyBytes,
                replyPreviewBytes: artifact.previewBytes,
                replyTruncated: true,
                replyFileToken: artifact.token
            };
        } catch (error) {
            logger.warn('写入 NETCONF RPC 响应临时文件失败，仅返回有界预览:', error.message);
            const buffer = Buffer.from(replyXml, 'utf8');
            const preview = rpcReplyPreview(buffer);
            externalized = {
                ...payload,
                [replyField]: preview,
                replyBytes: buffer.length,
                replyPreviewBytes: Buffer.byteLength(preview, 'utf8'),
                replyTruncated: true,
                replyArtifactError: {
                    code: error?.code || 'NETCONF_RPC_REPLY_ARTIFACT_WRITE_FAILED',
                    message: String(error?.message || error).slice(0, 512)
                }
            };
            delete externalized.replyFileToken;
        }
        // Defense in depth for older workers: never copy a second response string
        // or its expanded <data> object into renderer IPC for a large reply.
        delete externalized.xml;
        delete externalized.data;
        return externalized;
    }

    async cleanupRpcReplyArtifacts() {
        await Promise.allSettled([...this.rpcReplyArtifactWrites]);
        const directory = this.rpcReplyArtifactDirectory;
        this.rpcReplyArtifacts.clear();
        this.rpcReplyArtifactDirectory = null;
        this.rpcReplyArtifactDirectoryPromise = null;
        if (!directory || path.basename(directory).indexOf(RPC_REPLY_ARTIFACT_PREFIX) !== 0) return;
        await fs.promises.rm(directory, { recursive: true, force: true }).catch(error => {
            logger.warn('清理 NETCONF RPC 响应临时目录失败:', error.message);
        });
    }

    async handleSaveRpcReply(event, request = {}) {
        try {
            const token = String(typeof request === 'string' ? request : request.token || '').trim();
            const artifact = this.rpcReplyArtifacts.get(token);
            if (!artifact) {
                const error = new Error('完整 RPC 响应已过期或不存在');
                error.code = 'NETCONF_RPC_REPLY_ARTIFACT_NOT_FOUND';
                throw error;
            }
            const sourceStat = await fs.promises.lstat(artifact.filePath);
            if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
                const error = new Error('完整 RPC 响应临时文件无效');
                error.code = 'NETCONF_RPC_REPLY_ARTIFACT_INVALID';
                throw error;
            }
            let win = null;
            try {
                win = event?.sender
                    ? BrowserWindow?.fromWebContents?.(event.sender)
                    : BrowserWindow?.getFocusedWindow?.();
            } catch (_error) {
                win = BrowserWindow?.getFocusedWindow?.() || null;
            }
            const options = {
                title: '保存完整 NETCONF RPC 响应',
                defaultPath: suggestedReplyName(request?.suggestedName),
                filters: [{ name: 'XML 文件', extensions: ['xml'] }]
            };
            const selection = win
                ? await this.netconfDialog.showSaveDialog(win, options)
                : await this.netconfDialog.showSaveDialog(options);
            if (selection.canceled || !selection.filePath) {
                return successResponse({ canceled: true }, '已取消保存完整 RPC 响应');
            }
            await fs.promises.copyFile(artifact.filePath, selection.filePath);
            return successResponse({ canceled: false, filePath: selection.filePath }, '完整 RPC 响应已保存');
        } catch (error) {
            return errorResponse('保存完整 RPC 响应失败: ' + error.message, { code: error.code });
        }
    }

    setWebContents(event) {
        if (this.hasFixedPrimaryWebContents) {
            if (this.primaryWebContents && !this.primaryWebContents.isDestroyed?.()) {
                this.eventDispatcher.setWebContents(this.primaryWebContents);
            }
            return;
        }
        if (event?.sender && !event.sender.isDestroyed?.()) this.eventDispatcher.setWebContents(event.sender);
    }

    closeProfileMonitorWindows(profileId) {
        if (!this.closeProfileMonitorWindowsHandler || !profileId) return;
        try {
            this.closeProfileMonitorWindowsHandler(String(profileId));
        } catch (error) {
            logger.warn(`关闭 NETCONF Profile 独立窗口失败: ${error.message}`);
        }
    }

    closeMonitorWindows() {
        if (!this.closeMonitorWindowsHandler) return;
        try {
            this.closeMonitorWindowsHandler();
        } catch (error) {
            logger.warn(`关闭 NETCONF 独立窗口失败: ${error.message}`);
        }
    }

    profileGeneration(profileId) {
        return this.profileGenerations.get(String(profileId || '')) || 0;
    }

    assertProfileAvailable(profileId, expectedGeneration = undefined) {
        const id = String(profileId || '');
        if (this.closing) {
            const error = new Error('NETCONF 服务正在关闭');
            error.code = 'NETCONF_APP_CLOSING';
            throw error;
        }
        if (
            this.deletingProfiles.has(id) ||
            (expectedGeneration !== undefined && this.profileGeneration(id) !== expectedGeneration)
        ) {
            const error = new Error('连接 Profile 正在删除或已被删除');
            error.code = 'NETCONF_PROFILE_DELETING';
            throw error;
        }
        return this.profileGeneration(id);
    }

    beginProfileDeletion(profileId) {
        const id = String(profileId || '');
        this.deletingProfiles.add(id);
        const generation = this.profileGeneration(id) + 1;
        this.profileGenerations.set(id, generation);
        return generation;
    }

    getStoredProfiles() {
        const profiles = this.store.get(PROFILE_STORE_KEY, []);
        return Array.isArray(profiles) ? profiles : [];
    }

    migrateLegacyRpcTimeouts() {
        if (this.store.get(RPC_TIMEOUT_MIGRATION_STORE_KEY, false) === true) return;
        const profiles = this.getStoredProfiles();
        let changed = false;
        const migrated = profiles.map(profile => {
            if (Number(profile?.rpcTimeout) !== LEGACY_DEFAULT_RPC_TIMEOUT) return profile;
            changed = true;
            return { ...profile, rpcTimeout: NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT };
        });
        if (changed) this.saveStoredProfiles(migrated);
        this.store.set(RPC_TIMEOUT_MIGRATION_STORE_KEY, true);
    }

    saveStoredProfiles(profiles) {
        this.store.set(PROFILE_STORE_KEY, profiles);
    }

    findStoredProfile(profileId) {
        return this.getStoredProfiles().find(profile => profile.id === profileId) || null;
    }

    operationWorkerTimeoutMs(profileId, requestedTimeout) {
        const requested = Number(requestedTimeout);
        const cached = Number(this.profileRpcTimeouts.get(String(profileId || '')));
        const stored = Number(this.findStoredProfile(String(profileId || ''))?.rpcTimeout);
        const rpcTimeout =
            (Number.isFinite(requested) && requested > 0 && requested) ||
            (Number.isFinite(cached) && cached > 0 && cached) ||
            (Number.isFinite(stored) && stored > 0 && stored) ||
            NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT;
        // The worker-side NETCONF timer must always win. Otherwise the IPC call can
        // report a timeout while the in-flight create-subscription later succeeds.
        return Math.max(120000, rpcTimeout + 5000);
    }

    rpcOperationKey(event, operationId) {
        const id = String(operationId || '').trim();
        if (!id) return '';
        return `${String(event?.sender?.id ?? 'unknown')}:${id}`;
    }

    registerRpcOperation(event, request, profileId) {
        const operationId = String(request?.operationId || '').trim();
        if (!operationId) return null;
        if (operationId.length > 160) {
            const error = new Error('NETCONF operationId 超过长度限制');
            error.code = 'NETCONF_OPERATION_ID_INVALID';
            throw error;
        }
        const key = this.rpcOperationKey(event, operationId);
        if (this.activeRpcOperations.has(key)) {
            const error = new Error('相同 NETCONF operationId 的操作仍在执行');
            error.code = 'NETCONF_OPERATION_ID_DUPLICATE';
            throw error;
        }
        const operation = {
            key,
            operationId,
            profileId: String(profileId || ''),
            controller: new AbortController(),
            sender: event?.sender || null,
            senderDestroyedListener: null
        };
        this.activeRpcOperations.set(key, operation);
        if (operation.sender && typeof operation.sender.once === 'function') {
            operation.senderDestroyedListener = () => {
                if (this.activeRpcOperations.get(operation.key) !== operation) return;
                operation.controller.abort();
                this.finishRpcOperation(operation);
            };
            operation.sender.once('destroyed', operation.senderDestroyedListener);
        }
        return operation;
    }

    finishRpcOperation(operation) {
        if (!operation) return;
        if (operation.senderDestroyedListener && operation.sender) {
            if (typeof operation.sender.removeListener === 'function') {
                operation.sender.removeListener('destroyed', operation.senderDestroyedListener);
            } else if (typeof operation.sender.off === 'function') {
                operation.sender.off('destroyed', operation.senderDestroyedListener);
            }
            operation.senderDestroyedListener = null;
        }
        if (this.activeRpcOperations.get(operation.key) === operation) {
            this.activeRpcOperations.delete(operation.key);
        }
    }

    rememberSessionSnapshot(state) {
        if (!state?.profileId) return;
        const profileId = String(state.profileId);
        this.sessionSnapshots.set(profileId, {
            ...(this.sessionSnapshots.get(profileId) || {}),
            ...state,
            profileId
        });
    }

    rememberSubscriptionSnapshot(subscription) {
        const subscriptionId = String(subscription?.subscriptionId || subscription?.id || '');
        if (!subscriptionId) return;
        this.subscriptionSnapshots.set(subscriptionId, {
            ...(this.subscriptionSnapshots.get(subscriptionId) || {}),
            ...subscription,
            id: subscription.id || subscriptionId,
            subscriptionId
        });
        this.pruneSubscriptionSnapshots(subscription.profileId);
    }

    pruneSubscriptionSnapshots(profileId) {
        const normalizedProfileId = String(profileId || '');
        if (!normalizedProfileId) return;
        const records = [...this.subscriptionSnapshots.values()].filter(
            subscription => String(subscription.profileId || '') === normalizedProfileId
        );
        let totalBytes = records.reduce((total, subscription) => total + snapshotBytes(subscription), 0);
        let totalCount = records.length;
        const removable = records
            .filter(
                subscription =>
                    !['ACTIVE', 'SUSPENDED', 'UNKNOWN'].includes(String(subscription.state || '').toUpperCase())
            )
            .sort((left, right) =>
                String(left.terminatedAt || left.updatedAt || left.createdAt || '').localeCompare(
                    String(right.terminatedAt || right.updatedAt || right.createdAt || '')
                )
            );
        for (const subscription of removable) {
            if (
                totalCount <= MAX_SUBSCRIPTION_SNAPSHOTS_PER_PROFILE &&
                totalBytes <= MAX_SUBSCRIPTION_SNAPSHOT_BYTES_PER_PROFILE
            ) {
                break;
            }
            const subscriptionId = String(subscription.subscriptionId || subscription.id || '');
            if (!subscriptionId || !this.subscriptionSnapshots.delete(subscriptionId)) continue;
            totalCount -= 1;
            totalBytes = Math.max(0, totalBytes - snapshotBytes(subscription));
        }
    }

    subscriptionSnapshot(profileId = null) {
        const normalizedProfileId = profileId ? String(profileId) : null;
        const subscriptions = [...this.subscriptionSnapshots.values()]
            .filter(subscription => !normalizedProfileId || subscription.profileId === normalizedProfileId)
            .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
        return {
            profileId: normalizedProfileId,
            subscriptions,
            activeCount: subscriptions.filter(subscription => String(subscription.state).toUpperCase() === 'ACTIVE')
                .length,
            suspendedCount: subscriptions.filter(
                subscription => String(subscription.state).toUpperCase() === 'SUSPENDED'
            ).length,
            unknownCount: subscriptions.filter(subscription => String(subscription.state).toUpperCase() === 'UNKNOWN')
                .length,
            liveCount: subscriptions.filter(subscription =>
                ['ACTIVE', 'SUSPENDED'].includes(String(subscription.state).toUpperCase())
            ).length,
            total: subscriptions.length,
            queriedAt: new Date().toISOString()
        };
    }

    normalizeNotificationScope(input = null) {
        const request = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
        const source = request.scope && typeof request.scope === 'object' ? request.scope : request;
        let kind = String(source.kind || '').toLowerCase();
        if (!kind) {
            if (source.subscriptionId) kind = 'subscription';
            else if (source.sessionId) kind = 'session';
            else if (source.profileId) kind = 'profile';
            else kind = 'all';
        }
        if (!['all', 'profile', 'session', 'subscription'].includes(kind)) kind = 'all';
        return {
            kind,
            profileId: String(source.profileId || ''),
            sessionId: String(source.sessionId || ''),
            subscriptionId: String(source.subscriptionId || '')
        };
    }

    notificationMatchesScope(notification, scope = { kind: 'all' }) {
        if (!scope.kind || scope.kind === 'all') return true;
        if (String(notification.profileId || '') !== scope.profileId) return false;
        if (scope.kind === 'profile') return true;
        if (String(notification.sessionId || '') !== scope.sessionId) return false;
        if (scope.kind === 'session') return true;
        return String(notification.subscriptionId || '') === scope.subscriptionId;
    }

    notificationSubscriptionMatchesScope(subscription, scope = { kind: 'all' }) {
        if (!scope.kind || scope.kind === 'all') return true;
        if (String(subscription.profileId || '') !== scope.profileId) return false;
        if (scope.kind === 'profile') return true;
        if (String(subscription.sessionId || '') !== scope.sessionId) return false;
        if (scope.kind === 'session') return true;
        return String(subscription.subscriptionId || subscription.id || '') === scope.subscriptionId;
    }

    notificationSummary() {
        const latest = this.notificationHistory[0] || null;
        const last = latest
            ? {
                  historyId: latest.historyId,
                  id: latest.id,
                  profileId: latest.profileId || '',
                  profileName: latest.profileName || '',
                  host: latest.host || '',
                  port: latest.port ?? '',
                  sessionId: latest.sessionId || '',
                  subscriptionId: latest.subscriptionId || '',
                  eventName: latest.eventName || '',
                  namespace: latest.namespace || '',
                  receivedAt: latest.receivedAt || '',
                  eventTime: latest.eventTime || ''
              }
            : null;
        return {
            total: this.notificationHistory.length,
            unread: this.notificationHistory.reduce((total, notification) => total + (notification.read ? 0 : 1), 0),
            totalBytes: this.notificationHistoryBytes,
            received: this.notificationHistoryReceived,
            dropped: this.notificationHistoryDropped,
            lastReceivedAt: latest?.receivedAt || '',
            lastEventName: latest?.eventName || '',
            latest: last,
            updatedAt: new Date().toISOString()
        };
    }

    emitNotificationSummary() {
        if (this.notificationSummaryTimer) {
            clearTimeout(this.notificationSummaryTimer);
            this.notificationSummaryTimer = null;
        }
        const target = this.eventDispatcher.webContents;
        if (!target || target.isDestroyed?.()) return 0;
        return this.eventDispatcher.emitToPrimary(
            YANG_EVT_TYPES.NOTIFICATION_SUMMARY,
            successResponse(this.notificationSummary(), 'NETCONF 通知摘要')
        );
    }

    scheduleNotificationSummary() {
        if (this.closing) return;
        if (this.notificationSummaryTimer) return;
        const target = this.eventDispatcher.webContents;
        if (!target || target.isDestroyed?.()) return;
        this.notificationSummaryTimer = setTimeout(() => {
            this.notificationSummaryTimer = null;
            this.emitNotificationSummary();
        }, this.notificationSummaryDelayMs);
        this.notificationSummaryTimer.unref?.();
    }

    normalizeNotificationRecord(data) {
        const payload = clonePlainValue(data && typeof data === 'object' ? data : {});
        const rawXml = String(payload.xml || payload.notificationXml || payload.payloadXml || '');
        const xml = truncateUtf8Text(rawXml, MAX_NOTIFICATION_XML_BYTES, 'NetNexus：通知 XML 已截断');
        const historyId = `netconf-notification-${Date.now()}-${randomUUID()}`;
        const receivedAt = String(payload.receivedAt || payload.receivedTime || new Date().toISOString());
        const sourceEventId = payload.id === undefined || payload.id === null ? '' : String(payload.id);
        const record = {
            ...payload,
            ...(sourceEventId ? { sourceEventId } : {}),
            id: historyId,
            historyId,
            read: false,
            receivedAt,
            xml: xml.value,
            xmlTruncated: xml.truncated || Boolean(payload.xmlTruncated)
        };
        delete record.notificationXml;
        delete record.payloadXml;

        // Parsed documents can duplicate the complete XML tree. Keep small documents
        // for compatibility, but discard the duplicate when one record would dominate
        // the bounded history.
        if (snapshotBytes(record) > MAX_NOTIFICATION_XML_BYTES + 256 * 1024 && record.document !== undefined) {
            delete record.document;
            record.documentOmitted = true;
        }

        let bytes = snapshotBytes(record);
        if (bytes > MAX_NOTIFICATION_HISTORY_BYTES) {
            const compact = {
                id: record.id,
                historyId: record.historyId,
                sourceEventId: record.sourceEventId,
                profileId: record.profileId || '',
                profileName: record.profileName || '',
                host: record.host || '',
                port: record.port ?? '',
                sessionId: record.sessionId || '',
                subscriptionId: record.subscriptionId || '',
                publisherSubscriptionId: record.publisherSubscriptionId || '',
                subscriptionType: record.subscriptionType || '',
                targetType: record.targetType || '',
                stream: record.stream || '',
                datastore: record.datastore || '',
                state: record.state || '',
                receivedAt: record.receivedAt,
                eventTime: record.eventTime || '',
                eventName: record.eventName || '',
                namespace: record.namespace || '',
                xml: record.xml,
                xmlTruncated: true,
                documentOmitted: record.document !== undefined || record.documentOmitted === true,
                metadataOmitted: true,
                read: false
            };
            bytes = snapshotBytes(compact);
            compact.estimatedBytes = bytes;
            return compact;
        }
        record.estimatedBytes = bytes;
        return record;
    }

    rememberNotification(data) {
        const notification = this.normalizeNotificationRecord(data);
        const bytes = Number(notification.estimatedBytes) || snapshotBytes(notification);
        this.notificationHistory.unshift(notification);
        this.notificationHistoryBytes += bytes;
        this.notificationHistoryReceived += 1;
        while (
            this.notificationHistory.length > MAX_NOTIFICATION_HISTORY_RECORDS ||
            this.notificationHistoryBytes > MAX_NOTIFICATION_HISTORY_BYTES
        ) {
            const removed = this.notificationHistory.pop();
            if (!removed) break;
            this.notificationHistoryBytes = Math.max(
                0,
                this.notificationHistoryBytes - (Number(removed.estimatedBytes) || snapshotBytes(removed))
            );
            this.notificationHistoryDropped += 1;
        }
        this.scheduleNotificationSummary();
        return notification;
    }

    notificationHistoryLimits() {
        return {
            maxRecords: MAX_NOTIFICATION_HISTORY_RECORDS,
            maxTotalBytes: MAX_NOTIFICATION_HISTORY_BYTES,
            maxXmlBytes: MAX_NOTIFICATION_XML_BYTES,
            maxSubscriptions: MAX_SUBSCRIPTION_SNAPSHOTS_PER_PROFILE
        };
    }

    async handleGetNotificationHistory(_event, request = null) {
        try {
            const scope = this.normalizeNotificationScope(request);
            const notifications = this.notificationHistory
                .filter(notification => this.notificationMatchesScope(notification, scope))
                .map(notification => clonePlainValue(notification));
            const subscriptions = [...this.subscriptionSnapshots.values()]
                .filter(subscription => this.notificationSubscriptionMatchesScope(subscription, scope))
                .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
                .map(subscription => clonePlainValue(subscription));
            return successResponse(
                {
                    notifications,
                    subscriptions,
                    total: notifications.length,
                    summary: this.notificationSummary(),
                    limits: this.notificationHistoryLimits(),
                    scope
                },
                'NETCONF 通知历史获取成功'
            );
        } catch (error) {
            return errorResponse('获取 NETCONF 通知历史失败: ' + error.message, { code: error.code });
        }
    }

    async handleGetNotificationSummary() {
        return successResponse(this.notificationSummary(), 'NETCONF 通知摘要获取成功');
    }

    notificationMutationPredicate(request, defaultAll = true) {
        const source = typeof request === 'string' ? { id: request } : request || {};
        const ids = new Set(
            [source.id, source.notificationId, ...(Array.isArray(source.ids) ? source.ids : [])]
                .map(value => String(value || ''))
                .filter(Boolean)
        );
        if (ids.size > 0) {
            return notification => ids.has(String(notification.historyId || notification.id || ''));
        }
        if (!defaultAll && !source.scope && !source.kind && !source.profileId) {
            const error = new Error('缺少 NETCONF 通知历史目标');
            error.code = 'NETCONF_NOTIFICATION_TARGET_REQUIRED';
            throw error;
        }
        const scope = this.normalizeNotificationScope(source);
        return notification => this.notificationMatchesScope(notification, scope);
    }

    async handleMarkNotificationRead(_event, request = {}) {
        try {
            const predicate = this.notificationMutationPredicate(request, true);
            const read = request?.read !== false;
            let updated = 0;
            this.notificationHistory = this.notificationHistory.map(notification => {
                if (!predicate(notification) || notification.read === read) return notification;
                updated += 1;
                return { ...notification, read };
            });
            this.scheduleNotificationSummary();
            return successResponse({ updated, read, summary: this.notificationSummary() }, 'NETCONF 通知状态已更新');
        } catch (error) {
            return errorResponse('更新 NETCONF 通知状态失败: ' + error.message, { code: error.code });
        }
    }

    deleteNotificationRecords(predicate) {
        let removed = 0;
        let removedBytes = 0;
        this.notificationHistory = this.notificationHistory.filter(notification => {
            if (!predicate(notification)) return true;
            removed += 1;
            removedBytes += Number(notification.estimatedBytes) || snapshotBytes(notification);
            return false;
        });
        this.notificationHistoryBytes = Math.max(0, this.notificationHistoryBytes - removedBytes);
        this.scheduleNotificationSummary();
        return removed;
    }

    async handleDeleteNotificationHistory(_event, request = {}) {
        try {
            const removed = this.deleteNotificationRecords(this.notificationMutationPredicate(request, false));
            return successResponse({ removed, summary: this.notificationSummary() }, 'NETCONF 通知已删除');
        } catch (error) {
            return errorResponse('删除 NETCONF 通知失败: ' + error.message, { code: error.code });
        }
    }

    async handleClearNotificationHistory(_event, request = {}) {
        try {
            const removed = this.deleteNotificationRecords(this.notificationMutationPredicate(request, true));
            return successResponse({ removed, summary: this.notificationSummary() }, 'NETCONF 通知历史已清空');
        } catch (error) {
            return errorResponse('清空 NETCONF 通知历史失败: ' + error.message, { code: error.code });
        }
    }

    findNotificationActionSubscription(request) {
        const profileId = String(request.profileId || '');
        const localId = String(request.subscriptionId || request.id || '');
        const deviceId = String(request.deviceSubscriptionId || request.modernSubscriptionId || '');
        return (
            [...this.subscriptionSnapshots.values()].find(subscription => {
                if (profileId && String(subscription.profileId || '') !== profileId) return false;
                if (
                    localId &&
                    [subscription.subscriptionId, subscription.id].some(value => String(value || '') === localId)
                ) {
                    return true;
                }
                return (
                    deviceId &&
                    [subscription.publisherSubscriptionId, subscription.deviceSubscriptionId].some(
                        value => String(value || '') === deviceId
                    )
                );
            }) || null
        );
    }

    compactNotificationAction(request, operation) {
        const snapshot = this.findNotificationActionSubscription(request);
        const source = { ...request, ...(snapshot || {}), operation };
        const action = { operation };
        for (const field of NOTIFICATION_ACTION_FIELDS) {
            if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
            action[field] = compactActionValue(source[field]);
        }
        action.profileId = String(action.profileId || '').trim();
        action.sessionId = String(action.sessionId || '').trim();
        action.subscriptionId = String(action.subscriptionId || action.id || '').trim();
        action.deviceSubscriptionId = String(
            action.deviceSubscriptionId || action.modernSubscriptionId || source.publisherSubscriptionId || ''
        ).trim();
        action.modernSubscriptionId = action.deviceSubscriptionId;
        if (!action.profileId || action.profileId.length > 160) {
            const error = new Error('通知动作缺少有效 Profile');
            error.code = 'NETCONF_NOTIFICATION_ACTION_PROFILE_INVALID';
            throw error;
        }
        if (action.sessionId.length > 160 || action.subscriptionId.length > 160) {
            const error = new Error('通知动作的 Session 或订阅标识无效');
            error.code = 'NETCONF_NOTIFICATION_ACTION_ID_INVALID';
            throw error;
        }
        if (operation === 'disconnect-session' && !action.sessionId) {
            const error = new Error('断开订阅 Session 时缺少 Session 标识');
            error.code = 'NETCONF_NOTIFICATION_ACTION_SESSION_REQUIRED';
            throw error;
        }
        if (operation !== 'disconnect-session' && !action.deviceSubscriptionId) {
            const error = new Error('现代订阅动作缺少设备订阅 ID');
            error.code = 'NETCONF_NOTIFICATION_ACTION_SUBSCRIPTION_REQUIRED';
            throw error;
        }
        if (snapshotBytes(action) > MAX_NOTIFICATION_ACTION_BYTES) {
            const error = new Error('通知动作上下文超过大小限制');
            error.code = 'NETCONF_NOTIFICATION_ACTION_TOO_LARGE';
            throw error;
        }
        return action;
    }

    focusPrimaryWindow() {
        const target = this.eventDispatcher.webContents;
        if (!target || target.isDestroyed?.()) return;
        try {
            const win = BrowserWindow?.fromWebContents?.(target);
            if (!win || win.isDestroyed?.()) return;
            if (win.isMinimized?.()) win.restore?.();
            win.show?.();
            win.focus?.();
        } catch (error) {
            logger.warn(`激活 NETCONF 主窗口失败: ${error.message}`);
        }
    }

    async handleRequestNotificationAction(_event, request = {}) {
        try {
            const operation = String(request?.operation || request?.action || '').trim();
            if (!NOTIFICATION_ACTIONS.has(operation)) {
                const error = new Error('不支持的 NETCONF 通知动作');
                error.code = 'NETCONF_NOTIFICATION_ACTION_UNSUPPORTED';
                throw error;
            }
            const action = this.compactNotificationAction(request, operation);
            const sent = this.eventDispatcher.emitToPrimary(
                YANG_EVT_TYPES.NOTIFICATION_ACTION,
                successResponse(action, 'NETCONF 通知动作请求')
            );
            if (!sent) {
                const error = new Error('NETCONF 主窗口当前不可用');
                error.code = 'NETCONF_NOTIFICATION_ACTION_TARGET_UNAVAILABLE';
                throw error;
            }
            this.focusPrimaryWindow();
            return successResponse({ accepted: true, operation }, '已转交 NETCONF 主窗口处理');
        } catch (error) {
            return errorResponse('转交通知动作失败: ' + error.message, { code: error.code });
        }
    }

    relayWorkerEvent(eventName, data) {
        const state = data && typeof data === 'object' ? data : null;
        if (eventName === YANG_EVT_TYPES.SESSION_EVENT) {
            this.rememberSessionSnapshot(state);
            if (state?.profileId && !this.closing && !this.deletingProfiles.has(state.profileId)) {
                if (state.status === 'connected' && !this.pendingProfileConnections.has(String(state.profileId))) {
                    this.activeProfileId = state.profileId;
                    this.yangApp?.setActiveProfileId?.(state.profileId);
                } else if (
                    this.activeProfileId === state.profileId &&
                    ['disconnected', 'error'].includes(state.status)
                ) {
                    this.activeProfileId = null;
                    this.yangApp?.setActiveProfileId?.(null);
                }
            }
        } else if (eventName === YANG_EVT_TYPES.SUBSCRIPTION_EVENT) {
            this.rememberSubscriptionSnapshot(state);
        }
        if (eventName === YANG_EVT_TYPES.NOTIFICATION) {
            const notification = this.rememberNotification(data);
            this.eventDispatcher.emitToSubscribers(YANG_EVT_TYPES.NOTIFICATION, successResponse(notification));
            return;
        }
        const relayEventType =
            eventName === YANG_EVT_TYPES.SUBSCRIPTION_EVENT
                ? YANG_EVT_TYPES.SUBSCRIPTION_EVENT
                : YANG_EVT_TYPES.SESSION_EVENT;
        if (!this.eventDispatcher.canEmit(relayEventType)) return;
        this.eventDispatcher.emit(relayEventType, successResponse(data));
    }

    handleWorkerExit(client, code) {
        if (this.workerClient !== client) return;
        if (!this.closing && !client.closed) {
            const terminatedAt = new Date().toISOString();
            const workerError = {
                name: 'Error',
                code: 'NETCONF_WORKER_EXIT',
                message: `NETCONF Worker 异常退出（退出码 ${code}）`
            };
            for (const subscription of [...this.subscriptionSnapshots.values()]) {
                if (!['ACTIVE', 'SUSPENDED'].includes(String(subscription.state).toUpperCase())) continue;
                this.relayWorkerEvent(YANG_EVT_TYPES.SUBSCRIPTION_EVENT, {
                    ...subscription,
                    state: 'TERMINATED',
                    terminatedAt,
                    terminationReason: 'worker-exit',
                    error: workerError
                });
            }
            for (const state of [...this.sessionSnapshots.values()]) {
                if (String(state.status || state.state).toLowerCase() === 'disconnected') continue;
                this.relayWorkerEvent(YANG_EVT_TYPES.SESSION_EVENT, {
                    ...state,
                    status: 'disconnected',
                    state: 'disconnected',
                    connected: false,
                    capabilities: [],
                    serverCapabilities: [],
                    supportsNotification: false,
                    supportsInterleave: false,
                    supportsSubscribedNotifications: false,
                    supportsYangPush: false,
                    notificationFeatures: {
                        rfc5277: false,
                        rfc8639: false,
                        rfc8640: false,
                        rfc8641: false,
                        yangPush: false,
                        subscribedNotificationFeatures: [],
                        yangPushFeatures: []
                    },
                    capabilitySupport: {
                        notification: false,
                        interleave: false,
                        subscribedNotifications: false,
                        modernNotifications: false,
                        yangPush: false,
                        subscribedNotificationFeatures: [],
                        yangPushFeatures: []
                    },
                    subscription: null,
                    activeSubscription: null,
                    activeSubscriptions: [],
                    subscriptionActive: false,
                    activeSubscriptionCount: 0,
                    disconnectedAt: terminatedAt,
                    lastError: workerError
                });
            }
        }
        this.workerClient = null;
        this.activeProfileId = null;
        this.yangApp?.setActiveProfileId?.(null);
    }

    normalizeProfile(input = {}, existing = null) {
        const id = String(input.id || existing?.id || randomUUID());
        this.yangApp?.profileWorkspaceId?.(id);
        const name = String(input.name || existing?.name || input.host || '')
            .trim()
            .slice(0, 80);
        const host = String(input.host || existing?.host || '').trim();
        const port = Number(input.port ?? existing?.port ?? DEFAULT_NETCONF_PROFILE.port);
        const username = String(input.username ?? existing?.username ?? '').trim();
        const authMethod =
            input.authMethod || input.authType || existing?.authMethod || DEFAULT_NETCONF_PROFILE.authMethod;
        const hostKeyPolicy = input.hostKeyPolicy || existing?.hostKeyPolicy || DEFAULT_NETCONF_PROFILE.hostKeyPolicy;

        if (!name) throw new Error('请输入连接名称');
        if (!host || /[\s\0]/u.test(host)) throw new Error('请输入有效的设备地址');
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在1到65535之间');
        if (!username) throw new Error('请输入NETCONF用户名');
        if (!ALLOWED_AUTH_METHODS.has(authMethod)) throw new Error(`不支持的认证方式: ${authMethod}`);
        if (!ALLOWED_HOST_KEY_POLICIES.has(hostKeyPolicy)) throw new Error(`不支持的主机密钥策略: ${hostKeyPolicy}`);

        const number = (value, fallback, min, max) => {
            const normalized = Number(value ?? fallback);
            return Number.isFinite(normalized) ? Math.max(min, Math.min(max, Math.trunc(normalized))) : fallback;
        };

        return {
            ...DEFAULT_NETCONF_PROFILE,
            ...existing,
            ...input,
            id,
            name,
            host,
            port,
            username,
            authMethod,
            hostKeyPolicy,
            privateKeyPath: String(input.privateKeyPath ?? existing?.privateKeyPath ?? '').trim(),
            hostKeyFingerprint: String(input.hostKeyFingerprint ?? existing?.hostKeyFingerprint ?? '').trim(),
            rememberCredentials: Boolean(input.rememberCredentials ?? existing?.rememberCredentials),
            autoReconnect: Boolean(input.autoReconnect ?? existing?.autoReconnect),
            connectTimeout: number(input.connectTimeout, existing?.connectTimeout || 15000, 1000, 120000),
            rpcTimeout: number(
                input.rpcTimeout,
                existing?.rpcTimeout || DEFAULT_NETCONF_PROFILE.rpcTimeout,
                1000,
                300000
            ),
            keepaliveInterval: number(input.keepaliveInterval, existing?.keepaliveInterval || 30000, 0, 300000),
            keepaliveCountMax: number(input.keepaliveCountMax, existing?.keepaliveCountMax || 3, 1, 20)
        };
    }

    captureTransientSecrets(profile) {
        if (!profile?.id) return;
        const previous = this.transientSecrets.get(profile.id) || {};
        const secrets = { ...previous };
        ['password', 'passphrase', 'privateKey'].forEach(field => {
            if (!Object.prototype.hasOwnProperty.call(profile, field)) return;
            if (profile[field]) secrets[field] = String(profile[field]);
            else delete secrets[field];
        });
        if (Object.keys(secrets).length > 0) this.transientSecrets.set(profile.id, secrets);
        else this.transientSecrets.delete(profile.id);
    }

    resolveRuntimeProfile(profileOrId) {
        const provided = profileOrId && typeof profileOrId === 'object' ? profileOrId : null;
        const profileId = provided?.id || profileOrId || this.activeProfileId;
        const stored = profileId ? this.findStoredProfile(String(profileId)) : null;
        const normalized = this.normalizeProfile(provided || stored || {}, stored);
        this.captureTransientSecrets({ ...provided, id: normalized.id });
        const runtime = this.credentialStore.hydrateProfile(
            stored ? { ...stored, ...normalized } : normalized,
            this.transientSecrets.get(normalized.id) || provided || {}
        );
        if (runtime.authMethod === 'password' && !runtime.password) {
            throw new Error('该连接没有可用密码，请重新输入凭据');
        }
        if (runtime.authMethod === 'privateKey' && !runtime.privateKey && !runtime.privateKeyPath) {
            throw new Error('请选择私钥文件');
        }
        return runtime;
    }

    ensureWorker(event) {
        if (this.closing) {
            const error = new Error('NETCONF 服务正在关闭');
            error.code = 'NETCONF_APP_CLOSING';
            throw error;
        }
        this.setWebContents(event);
        if (this.workerClient) return this.workerClient;
        const client = new RequestWorkerClient(resolveWorkerPath('yang/netconfWorker.js'), {
            defaultTimeoutMs: NETCONF_LIMITS.DEFAULT_RPC_TIMEOUT + 5000
        });
        this.workerClient = client;
        client.on('event', (eventName, data) => this.relayWorkerEvent(eventName, data));
        client.on('exit', code => this.handleWorkerExit(client, code));
        return client;
    }

    async handleListProfiles() {
        try {
            return successResponse({
                profiles: this.getStoredProfiles().map(profile => this.credentialStore.sanitizeProfile(profile)),
                activeProfileId: this.activeProfileId
            });
        } catch (error) {
            return errorResponse('获取NETCONF连接失败: ' + error.message);
        }
    }

    async handleSaveProfile(_event, input = {}) {
        try {
            if (this.closing) this.assertProfileAvailable(input.id);
            const requestedGeneration = input.id ? this.assertProfileAvailable(input.id) : undefined;
            const profiles = this.getStoredProfiles();
            const index = input.id ? profiles.findIndex(profile => profile.id === input.id) : -1;
            const existing = index >= 0 ? profiles[index] : null;
            const normalized = this.normalizeProfile(input, existing);
            this.assertProfileAvailable(normalized.id, requestedGeneration);
            this.captureTransientSecrets(normalized);
            const protectedProfile = this.credentialStore.protectProfile(normalized, existing || {});
            if (index >= 0) profiles.splice(index, 1, protectedProfile);
            else profiles.push(protectedProfile);
            this.saveStoredProfiles(profiles);
            return successResponse(this.credentialStore.sanitizeProfile(protectedProfile), '连接配置已保存');
        } catch (error) {
            logger.error('保存NETCONF连接失败:', error);
            return errorResponse('保存连接失败: ' + error.message);
        }
    }

    async handleDeleteProfile(event, profileId) {
        const id = String(profileId || '');
        if (!id) return errorResponse('缺少连接ID');
        if (this.closing) return errorResponse('NETCONF 服务正在关闭');
        if (this.deletingProfiles.has(id)) return errorResponse('连接 Profile 正在删除');
        this.closeProfileMonitorWindows(id);
        this.beginProfileDeletion(id);
        const deletionPromise = (async () => {
            const pending = [];
            for (const task of this.taskManager.tasks.values()) {
                if (task.status === 'running' && task.metadata?.profileId === id) {
                    this.taskManager.cancel(task.taskId);
                    if (task.promise) pending.push(task.promise);
                }
            }
            await Promise.allSettled(pending);
            if (this.workerClient) {
                await this.disconnectProfile(event, id);
                await this.workerClient.sendRequest(
                    NETCONF_REQ_TYPES.PURGE_PROFILE,
                    { profileId: id },
                    { timeoutMs: 10000 }
                );
            }
            await this.yangApp?.deleteProfileWorkspace?.(id, event);
            this.saveStoredProfiles(this.getStoredProfiles().filter(profile => profile.id !== id));
            this.transientSecrets.delete(id);
            this.inventories.delete(id);
            this.profileRpcTimeouts.delete(id);
            this.sessionSnapshots.delete(id);
            for (const [subscriptionId, subscription] of this.subscriptionSnapshots.entries()) {
                if (String(subscription.profileId || '') === id) this.subscriptionSnapshots.delete(subscriptionId);
            }
            return successResponse(null, '连接配置已删除');
        })();
        this.profileDeletionPromises.set(id, deletionPromise);
        try {
            return await deletionPromise;
        } catch (error) {
            return errorResponse('删除连接失败: ' + error.message);
        } finally {
            if (this.profileDeletionPromises.get(id) === deletionPromise) this.profileDeletionPromises.delete(id);
            this.deletingProfiles.delete(id);
        }
    }

    async handleSelectPrivateKey(event) {
        try {
            const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
            const options = {
                title: '选择SSH私钥',
                properties: ['openFile'],
                filters: [{ name: 'SSH私钥', extensions: ['pem', 'key', 'ppk', '*'] }]
            };
            const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
            return successResponse(result.canceled ? null : result.filePaths[0] || null);
        } catch (error) {
            return errorResponse('选择私钥失败: ' + error.message);
        }
    }

    async handleTestConnection(event, profile) {
        const startedAt = Date.now();
        try {
            const requestedId = profile && typeof profile === 'object' ? profile.id : profile || this.activeProfileId;
            const requestedGeneration = requestedId ? this.assertProfileAvailable(requestedId) : undefined;
            const runtime = this.resolveRuntimeProfile(profile);
            const generation = this.assertProfileAvailable(runtime.id, requestedGeneration);
            if (runtime.privateKeyPath && !fs.existsSync(runtime.privateKeyPath)) throw new Error('私钥文件不存在');
            const result = await this.ensureWorker(event).sendRequest(NETCONF_REQ_TYPES.TEST_CONNECTION, runtime, {
                timeoutMs: runtime.connectTimeout + runtime.rpcTimeout + 5000
            });
            this.assertProfileAvailable(runtime.id, generation);
            return successResponse({ ...result.data, latency: Date.now() - startedAt }, 'NETCONF连接测试成功');
        } catch (error) {
            logger.error('NETCONF连接测试失败:', error.message);
            return errorResponse('连接测试失败: ' + error.message, { code: error.code });
        }
    }

    async handleConnect(event, profileOrId) {
        let pendingProfileId = '';
        const previousProfileId = this.activeProfileId ? String(this.activeProfileId) : '';
        try {
            const requestedId =
                profileOrId && typeof profileOrId === 'object' ? profileOrId.id : profileOrId || this.activeProfileId;
            const requestedGeneration = requestedId ? this.assertProfileAvailable(requestedId) : undefined;
            const runtime = this.resolveRuntimeProfile(profileOrId);
            const generation = this.assertProfileAvailable(runtime.id, requestedGeneration);
            this.profileRpcTimeouts.set(runtime.id, runtime.rpcTimeout);
            pendingProfileId = String(runtime.id);
            this.pendingProfileConnections.add(pendingProfileId);
            const client = this.ensureWorker(event);
            const result = await client.sendRequest(NETCONF_REQ_TYPES.CONNECT, runtime, {
                timeoutMs: runtime.connectTimeout + runtime.rpcTimeout + 5000
            });
            try {
                this.assertProfileAvailable(runtime.id, generation);
            } catch (error) {
                await client
                    .sendRequest(NETCONF_REQ_TYPES.DISCONNECT, { profileId: runtime.id }, { timeoutMs: 10000 })
                    .catch(() => {});
                if (this.activeProfileId === runtime.id) {
                    this.activeProfileId = null;
                    this.yangApp?.setActiveProfileId?.(null);
                }
                throw error;
            }
            if (previousProfileId && previousProfileId !== String(runtime.id)) {
                this.closeProfileMonitorWindows(previousProfileId);
            }
            this.activeProfileId = runtime.id;
            this.yangApp?.setActiveProfileId?.(runtime.id);
            this.rememberObservedFingerprint(runtime.id, result.data?.hostKeyFingerprint);
            return successResponse(result.data, 'NETCONF连接成功');
        } catch (error) {
            logger.error('NETCONF连接失败:', error.message);
            return errorResponse('NETCONF连接失败: ' + error.message, { code: error.code, details: error.data });
        } finally {
            if (pendingProfileId) this.pendingProfileConnections.delete(pendingProfileId);
        }
    }

    rememberObservedFingerprint(profileId, fingerprint) {
        if (!profileId || !fingerprint) return;
        const profiles = this.getStoredProfiles();
        const index = profiles.findIndex(profile => profile.id === profileId);
        if (index < 0 || profiles[index].hostKeyFingerprint) return;
        profiles[index] = { ...profiles[index], hostKeyFingerprint: fingerprint };
        this.saveStoredProfiles(profiles);
    }

    async disconnectProfile(event, profileId) {
        if (!this.workerClient) return { profileId, status: 'disconnected' };
        this.setWebContents(event);
        const result = await this.workerClient.sendRequest(
            NETCONF_REQ_TYPES.DISCONNECT,
            { profileId },
            { timeoutMs: 10000 }
        );
        if (this.activeProfileId === profileId) this.activeProfileId = null;
        if (!this.activeProfileId) this.yangApp?.setActiveProfileId?.(null);
        return result.data;
    }

    async handleDisconnect(event, profileId) {
        try {
            const id = String(profileId || this.activeProfileId || '');
            if (!id) return successResponse({ status: 'disconnected' }, '当前没有活动连接');
            this.closeProfileMonitorWindows(id);
            return successResponse(await this.disconnectProfile(event, id), 'NETCONF连接已断开');
        } catch (error) {
            return errorResponse('断开NETCONF连接失败: ' + error.message);
        }
    }

    async handleGetSessionState(event, profileId) {
        try {
            const id = String(profileId || this.activeProfileId || '');
            if (!id || !this.workerClient) {
                const cached = id ? this.sessionSnapshots.get(id) : null;
                return successResponse({
                    ...(cached || {}),
                    profileId: id || null,
                    status: 'disconnected',
                    state: 'disconnected',
                    connected: false,
                    capabilities: [],
                    serverCapabilities: [],
                    supportsNotification: false,
                    supportsInterleave: false,
                    supportsSubscribedNotifications: false,
                    supportsYangPush: false,
                    notificationFeatures: {
                        rfc5277: false,
                        rfc8639: false,
                        rfc8640: false,
                        rfc8641: false,
                        yangPush: false,
                        subscribedNotificationFeatures: [],
                        yangPushFeatures: []
                    },
                    capabilitySupport: {
                        notification: false,
                        interleave: false,
                        subscribedNotifications: false,
                        modernNotifications: false,
                        yangPush: false,
                        subscribedNotificationFeatures: [],
                        yangPushFeatures: []
                    },
                    subscription: null,
                    activeSubscription: null,
                    activeSubscriptions: [],
                    subscriptionActive: false,
                    activeSubscriptionCount: 0,
                    activeProfileId: this.activeProfileId
                });
            }
            const result = await this.ensureWorker(event).sendRequest(NETCONF_REQ_TYPES.GET_SESSION_STATE, {
                profileId: id
            });
            this.rememberSessionSnapshot(result.data);
            return successResponse({ ...result.data, activeProfileId: this.activeProfileId });
        } catch (error) {
            return errorResponse('获取NETCONF状态失败: ' + error.message);
        }
    }

    async handleGetSubscriptions(event, request = null) {
        try {
            const profileId = request && typeof request === 'object' ? request.profileId : request;
            if (!this.workerClient) {
                return successResponse(this.subscriptionSnapshot(profileId));
            }
            const result = await this.ensureWorker(event).sendRequest(NETCONF_REQ_TYPES.GET_SUBSCRIPTIONS, {
                profileId: profileId ? String(profileId) : null
            });
            for (const subscription of result.data?.subscriptions || []) {
                this.rememberSubscriptionSnapshot(subscription);
            }
            return successResponse(this.subscriptionSnapshot(profileId));
        } catch (error) {
            return errorResponse('获取 NETCONF 订阅状态失败: ' + error.message, {
                code: error.code,
                details: error.data
            });
        }
    }

    resolveProfileId(request = null) {
        const value = request && typeof request === 'object' ? request.profileId : request;
        const profileId = value || this.activeProfileId;
        if (!profileId) throw new Error('请先连接NETCONF设备');
        return String(profileId);
    }

    async discoverModules(event, profileId, expectedGeneration = undefined) {
        const id = this.resolveProfileId(profileId);
        const generation = this.assertProfileAvailable(id, expectedGeneration);
        const result = await this.ensureWorker(event).sendRequest(
            NETCONF_REQ_TYPES.DISCOVER_MODULES,
            { profileId: id },
            { timeoutMs: 120000 }
        );
        this.assertProfileAvailable(id, generation);
        const inventory = result.data || { modules: [] };
        this.inventories.set(id, inventory);
        return inventory;
    }

    async handleDiscoverModules(event, profileId) {
        try {
            return successResponse(await this.discoverModules(event, profileId), 'YANG模型列表读取成功');
        } catch (error) {
            logger.error('读取YANG模型列表失败:', error.message);
            return errorResponse('读取YANG模型列表失败: ' + error.message, { code: error.code, details: error.data });
        }
    }

    selectInventoryModules(inventory, requested = []) {
        const modules = Array.isArray(inventory?.modules) ? inventory.modules : [];
        if (!Array.isArray(requested) || requested.length === 0) return modules;
        const keys = new Set(
            requested.map(item => {
                if (typeof item === 'string') return item;
                return `${item.name || item.identifier || ''}@${item.revision || item.version || ''}`;
            })
        );
        return modules.filter(module => {
            const name = module.name || module.identifier || '';
            const revision = module.revision || module.version || '';
            return keys.has(name) || keys.has(`${name}@${revision}`);
        });
    }

    async downloadOne(profileId, module, signal) {
        const result = await this.workerClient.sendRequest(
            NETCONF_REQ_TYPES.GET_SCHEMA,
            { profileId, module },
            { timeoutMs: 120000, signal }
        );
        const content = result.data?.content ?? result.data?.schema ?? result.data;
        if (typeof content !== 'string' || !content.trim()) throw new Error('设备返回了空的YANG模型');
        if (Buffer.byteLength(content, 'utf8') > NETCONF_LIMITS.MAX_SCHEMA_BYTES) {
            throw new Error('设备返回的YANG模型超过大小限制');
        }
        return {
            content,
            expectedName: module.name || module.identifier,
            revision: module.revision || module.version || '',
            fileName: `${module.name || module.identifier}${module.revision || module.version ? `@${module.revision || module.version}` : ''}.yang`,
            source: result.data?.source || `netconf://${profileId}/${module.name || module.identifier}`,
            dependencies: Array.isArray(result.data?.dependencies) ? result.data.dependencies : []
        };
    }

    moduleKey(module) {
        const name = module?.name || module?.identifier || '';
        const revision = module?.revision || module?.version || '';
        return `${name}@${revision}`;
    }

    inventoryDependencyCandidates(inventory, name, kind = '') {
        const candidates = [];
        for (const module of inventory?.modules || []) {
            const moduleName = module.name || module.identifier;
            const moduleKind = module.kind || (module.submodule || module.isSubmodule ? 'submodule' : 'module');
            if (moduleName === name && (!kind || moduleKind === kind)) candidates.push(module);
            for (const submodule of module.submodules || []) {
                const descriptor = {
                    ...submodule,
                    kind: 'submodule',
                    submodule: true,
                    parentModule: moduleName
                };
                if ((descriptor.name || descriptor.identifier) === name && (!kind || kind === 'submodule')) {
                    candidates.push(descriptor);
                }
            }
        }
        return candidates;
    }

    findInventoryDependency(inventory, name, revision = '', kind = '') {
        const candidates = this.inventoryDependencyCandidates(inventory, name, kind);
        if (revision) {
            const exact = candidates.find(module => (module.revision || module.version || '') === revision);
            return exact;
        }
        return candidates.sort((left, right) =>
            (right.revision || right.version || '').localeCompare(left.revision || left.version || '')
        )[0];
    }

    dependencyDescriptor(item, fallbackKind = 'module') {
        const descriptor = typeof item === 'string' ? { name: item } : item || {};
        const name = descriptor.name || descriptor.identifier || '';
        if (!name) return null;
        const kind = descriptor.kind || fallbackKind;
        const revision = descriptor.revision || descriptor.version || descriptor.revisionDate || '';
        return {
            name,
            revision,
            format: descriptor.format || 'yang',
            kind,
            submodule: kind === 'submodule'
        };
    }

    resolveDependency(inventory, item, fallbackKind = 'module') {
        const descriptor = this.dependencyDescriptor(item, fallbackKind);
        if (!descriptor) return null;
        return (
            this.findInventoryDependency(inventory, descriptor.name, descriptor.revision, descriptor.kind) || descriptor
        );
    }

    inventoryDeclaredDependencies(inventory, module) {
        const dependencies = [];
        const add = (item, kind) => {
            const target = this.resolveDependency(inventory, item, kind);
            if (target) dependencies.push(target);
        };
        (module.submodules || []).forEach(item => add(item, 'submodule'));
        (module.deviations || []).forEach(item => add(item, 'module'));
        return dependencies;
    }

    parsedDependencies(inventory, downloaded) {
        return (downloaded.dependencies || [])
            .map(item => this.resolveDependency(inventory, item, item.kind === 'submodule' ? 'submodule' : 'module'))
            .filter(Boolean);
    }

    downloadErrorText(error) {
        const rpcErrors = Array.isArray(error?.data?.errors) ? error.data.errors : [];
        return [
            error?.message,
            error?.data?.message,
            ...rpcErrors.flatMap(item => [item?.message, item?.tag, item?.appTag, item?.path])
        ]
            .map(value => String(value || '').trim())
            .filter(Boolean)
            .join(' ');
    }

    isInitialPasswordChangeError(error) {
        const text = this.downloadErrorText(error);
        return (
            error?.code === INITIAL_PASSWORD_CHANGE_REQUIRED_CODE ||
            (/initial\s+password/iu.test(text) && /change/iu.test(text)) ||
            (/初始密码/u.test(text) && /(修改|更改|变更)/u.test(text))
        );
    }

    downloadFailure(module, error) {
        const initialPassword = this.isInitialPasswordChangeError(error);
        const details = Array.isArray(error?.data?.errors)
            ? error.data.errors.map(item => ({
                  type: item?.type || '',
                  tag: item?.tag || '',
                  severity: item?.severity || '',
                  appTag: item?.appTag || '',
                  path: item?.path || '',
                  message: item?.message || ''
              }))
            : [];
        return {
            name: module.name || module.identifier,
            revision: module.revision || module.version || '',
            error: initialPassword
                ? '设备要求先修改初始密码；已停止后续下载，请通过 STelnet 或 Console 修改密码后重试'
                : error?.message || String(error),
            code: initialPassword ? INITIAL_PASSWORD_CHANGE_REQUIRED_CODE : error?.code || 'YANG_DOWNLOAD_FAILED',
            ...(details.length ? { details } : {})
        };
    }

    async handleDownloadModules(event, request = {}) {
        try {
            this.setWebContents(event);
            const profileId = this.resolveProfileId(request);
            const profileGeneration = this.assertProfileAvailable(profileId);
            const workspaceGeneration = this.yangApp?.getWorkspaceGeneration?.({ profileId });
            const task = this.taskManager.start(
                'download',
                async ({ signal, report }) => {
                    this.assertProfileAvailable(profileId, profileGeneration);
                    let inventory = this.inventories.get(profileId);
                    if (!inventory) {
                        report({ phase: 'discovering', percent: 5, message: '正在读取设备YANG列表' });
                        inventory = await this.discoverModules(event, profileId, profileGeneration);
                    }
                    const selected = this.selectInventoryModules(inventory, request.modules);
                    if (selected.length === 0) throw new Error('没有匹配的YANG模型可下载');
                    const downloaded = [];
                    const failed = [];
                    let stopReason = null;
                    const queuedKeys = new Set();
                    const queue = [];
                    const enqueue = module => {
                        const key = this.moduleKey(module);
                        if (!key || queuedKeys.has(key)) return;
                        queuedKeys.add(key);
                        queue.push(module);
                    };
                    selected.forEach(enqueue);
                    if (request.includeDependencies !== false) {
                        selected
                            .flatMap(module => this.inventoryDeclaredDependencies(inventory, module))
                            .forEach(enqueue);
                    }
                    for (let index = 0; index < queue.length; index += 1) {
                        if (signal.aborted) break;
                        const module = queue[index];
                        report({
                            phase: 'downloading',
                            percent: 10 + Math.round((index / Math.max(1, queue.length)) * 70),
                            completed: index,
                            total: queue.length,
                            module: module.name || module.identifier,
                            counts: { downloaded: downloaded.length, failed: failed.length }
                        });
                        try {
                            const item = await this.downloadOne(profileId, module, signal);
                            downloaded.push(item);
                            if (request.includeDependencies !== false) {
                                this.parsedDependencies(inventory, item).forEach(enqueue);
                                this.inventoryDeclaredDependencies(inventory, module).forEach(enqueue);
                            }
                        } catch (error) {
                            const failure = this.downloadFailure(module, error);
                            failed.push(failure);
                            if (failure.code === INITIAL_PASSWORD_CHANGE_REQUIRED_CODE) {
                                stopReason = failure;
                                break;
                            }
                        }
                    }
                    if (signal.aborted) {
                        throw new Error('YANG 下载已取消');
                    }
                    this.assertProfileAvailable(profileId, profileGeneration);
                    if (downloaded.length === 0) {
                        const initialPasswordRequired = stopReason?.code === INITIAL_PASSWORD_CHANGE_REQUIRED_CODE;
                        const detail = initialPasswordRequired
                            ? '设备要求先修改初始密码；本次 get-schema 没有返回任何模型。请先通过 STelnet 或 Console 修改密码，再更新连接 Profile 后重试'
                            : failed[0]?.error || '设备未返回模型内容';
                        report({
                            phase: 'downloading',
                            percent: 100,
                            completed: failed.length,
                            total: queue.length,
                            message: detail,
                            counts: { downloaded: 0, failed: failed.length }
                        });
                        const error = new Error(`YANG下载失败: ${detail}`);
                        error.code = stopReason?.code || 'YANG_DOWNLOAD_FAILED';
                        throw error;
                    }
                    report({
                        phase: 'importing',
                        percent: 85,
                        message: '正在写入本地YANG仓库',
                        counts: { downloaded: downloaded.length, failed: failed.length }
                    });
                    const imported = this.yangApp
                        ? await this.yangApp.importDownloadedContents(
                              downloaded,
                              {
                                  profileId,
                                  inventory,
                                  workspaceGeneration
                              },
                              event
                          )
                        : { downloaded };
                    this.assertProfileAvailable(profileId, profileGeneration);
                    const importFailures = Array.isArray(imported?.failed)
                        ? imported.failed.map(item => ({
                              name: item.expectedName || item.name || '未知模型',
                              revision: item.revision || '',
                              error: item.error || item.message || '写入本地YANG仓库失败',
                              code: item.code || 'YANG_IMPORT_FAILED'
                          }))
                        : [];
                    failed.push(...importFailures);
                    const persisted = Math.max(
                        0,
                        Number(imported?.summary?.imported ?? downloaded.length - importFailures.length) || 0
                    );
                    if (persisted === 0) {
                        const error = new Error('YANG下载成功，但没有模型能够写入本地YANG仓库');
                        error.code = 'YANG_DOWNLOAD_PERSIST_FAILED';
                        throw error;
                    }
                    const attempted = downloaded.length + failed.length - importFailures.length;
                    const unattempted = Math.max(0, queue.length - attempted);
                    const partial = failed.length > 0;
                    const finalMessage = stopReason
                        ? [
                              `已保存 ${persisted} 个模型`,
                              `${failed.length} 个失败`,
                              unattempted ? `${unattempted} 个未尝试` : '',
                              '请先修改设备初始密码后重试'
                          ]
                              .filter(Boolean)
                              .join('，')
                        : partial
                          ? `已保存 ${persisted} 个模型，${failed.length} 个失败`
                          : `已保存 ${persisted} 个模型`;
                    report({
                        phase: 'importing',
                        percent: 99,
                        completed: attempted,
                        total: queue.length,
                        message: finalMessage,
                        counts: { downloaded: persisted, failed: failed.length }
                    });
                    return {
                        profileId,
                        downloaded: downloaded.length,
                        persisted,
                        attempted,
                        unattempted,
                        total: queue.length,
                        partial,
                        stoppedEarly: Boolean(stopReason),
                        stopReason,
                        failed,
                        imported
                    };
                },
                { profileId }
            );
            return successResponse(task, 'YANG下载任务已开始');
        } catch (error) {
            return errorResponse('启动YANG下载失败: ' + error.message);
        }
    }

    async handleExecuteOperation(event, request = {}) {
        let activeOperation = null;
        try {
            const profileId = this.resolveProfileId(request);
            const generation = this.assertProfileAvailable(profileId);
            activeOperation = this.registerRpcOperation(event, request, profileId);
            const timeoutMs = this.operationWorkerTimeoutMs(profileId, request.timeout);
            const result = await this.ensureWorker(event).sendRequest(
                NETCONF_REQ_TYPES.EXECUTE_OPERATION,
                { ...request, profileId },
                { timeoutMs, signal: activeOperation?.controller.signal }
            );
            this.assertProfileAvailable(profileId, generation);
            return successResponse(await this.externalizeRpcPayload(result.data), 'NETCONF操作完成');
        } catch (error) {
            let details = error.data;
            try {
                details = await this.externalizeRpcPayload(error.data, 'replyXml');
            } catch (artifactError) {
                logger.warn('保留 NETCONF RPC 错误响应失败:', artifactError.message);
                details = error.data && typeof error.data === 'object' ? { ...error.data } : error.data;
                if (details && typeof details === 'object') delete details.replyXml;
            }
            return errorResponse('NETCONF操作失败: ' + error.message, { code: error.code, details });
        } finally {
            this.finishRpcOperation(activeOperation);
        }
    }

    async handleSendRpc(event, request = {}) {
        let activeOperation = null;
        try {
            const profileId = this.resolveProfileId(request);
            const generation = this.assertProfileAvailable(profileId);
            activeOperation = this.registerRpcOperation(event, request, profileId);
            const timeoutMs = this.operationWorkerTimeoutMs(profileId, request.timeout);
            const result = await this.ensureWorker(event).sendRequest(
                NETCONF_REQ_TYPES.SEND_RPC,
                { ...request, profileId },
                { timeoutMs, signal: activeOperation?.controller.signal }
            );
            this.assertProfileAvailable(profileId, generation);
            return successResponse(await this.externalizeRpcPayload(result.data), 'NETCONF RPC完成');
        } catch (error) {
            let details = error.data;
            try {
                details = await this.externalizeRpcPayload(error.data, 'replyXml');
            } catch (artifactError) {
                logger.warn('保留 NETCONF RPC 错误响应失败:', artifactError.message);
                details = error.data && typeof error.data === 'object' ? { ...error.data } : error.data;
                if (details && typeof details === 'object') delete details.replyXml;
            }
            return errorResponse('NETCONF RPC失败: ' + error.message, { code: error.code, details });
        } finally {
            this.finishRpcOperation(activeOperation);
        }
    }

    async handleCancelOperation(event, request = {}) {
        try {
            const operationId = String(request?.operationId || '').trim();
            const key = this.rpcOperationKey(event, operationId);
            const operation = key ? this.activeRpcOperations.get(key) : null;
            if (!operation) {
                const error = new Error('NETCONF RPC 已结束或不存在');
                error.code = 'NETCONF_RPC_NOT_PENDING';
                throw error;
            }
            const profileId = String(request?.profileId || '');
            if (profileId && profileId !== operation.profileId) {
                const error = new Error('NETCONF RPC 与目标 Profile 不匹配');
                error.code = 'NETCONF_RPC_CANCEL_PROFILE_MISMATCH';
                throw error;
            }
            operation.controller.abort();
            return successResponse(
                { operationId: operation.operationId, profileId: operation.profileId, cancelled: true },
                'NETCONF RPC 本地等待已终止'
            );
        } catch (error) {
            return errorResponse('终止 NETCONF RPC 失败: ' + error.message, { code: error.code });
        }
    }

    async handleGetTask(_event, taskId) {
        const task = this.taskManager.get(taskId);
        return task ? successResponse(task) : errorResponse('任务不存在');
    }

    async handleCancelTask(_event, taskId) {
        return this.taskManager.cancel(taskId)
            ? successResponse(null, '任务已取消')
            : errorResponse('任务不存在或已经结束');
    }

    getRunning() {
        return Boolean(
            (this.workerClient && this.activeProfileId) ||
                this.taskManager.list().some(task => task.status === 'running')
        );
    }

    async handleLogLevelChange(logLevel) {
        this.logLevel = logLevel;
    }

    async closeAll() {
        if (this.closePromise) return this.closePromise;
        const closePromise = (async () => {
            this.closing = true;
            if (this.notificationSummaryTimer) {
                clearTimeout(this.notificationSummaryTimer);
                this.notificationSummaryTimer = null;
            }
            this.closeMonitorWindows();
            for (const operation of [...this.activeRpcOperations.values()]) {
                operation.controller.abort();
                this.finishRpcOperation(operation);
            }
            const pendingTasks = [];
            for (const task of this.taskManager.tasks.values()) {
                if (task.status !== 'running') continue;
                this.taskManager.cancel(task.taskId);
                if (task.promise) pendingTasks.push(task.promise);
            }
            await Promise.allSettled(pendingTasks);
            await Promise.allSettled([...this.profileDeletionPromises.values()]);

            const worker = this.workerClient;
            if (worker) {
                try {
                    await worker.sendRequest(NETCONF_REQ_TYPES.DISCONNECT_ALL, null, { timeoutMs: 10000 });
                } catch (error) {
                    logger.warn('关闭NETCONF会话失败:', error.message);
                } finally {
                    await worker.terminate().catch(error => logger.warn('终止 NETCONF Worker 失败:', error.message));
                    if (this.workerClient === worker) this.workerClient = null;
                }
            }
            await this.cleanupRpcReplyArtifacts();
            this.activeProfileId = null;
            this.yangApp?.setActiveProfileId?.(null);
            this.deletingProfiles.clear();
            this.pendingProfileConnections.clear();
            this.activeRpcOperations.clear();
            this.profileDeletionPromises.clear();
            this.eventDispatcher.cleanup();
        })();
        this.closePromise = closePromise;
        try {
            await closePromise;
        } finally {
            this.closing = false;
            if (this.closePromise === closePromise) this.closePromise = null;
        }
    }
}

module.exports = NetconfApp;
