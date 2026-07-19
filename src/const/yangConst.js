/**
 * NETCONF / YANG renderer contract.
 *
 * Every bridge method below returns Promise<{ status: 'success' | 'error', msg?: string, data?: any }>.
 * Long-running methods may return { data: { jobId } }; their progress is delivered through
 * EventBus using YANG_EVENT.TASK_PROGRESS. Session changes use YANG_EVENT.SESSION_EVENT.
 *
 * window.netconfApi
 * - listProfiles() -> data: Profile[] | { profiles: Profile[] }
 * - saveProfile(profile) -> data: Profile
 * - deleteProfile(profileId)
 * - testConnection(profile) -> data: { latency?, serverVersion?, capabilities? }
 * - connect(profileId | profile) -> data: SessionState
 * - disconnect(profileId?) -> data: SessionState
 * - getSessionState(profileId?) -> data: SessionState
 * - selectPrivateKey() -> data: string | { filePath, path? } (opens a native file picker)
 * - discoverModules(profileId) -> data: Module[] | { modules: Module[], jobId? }
 * - downloadModules({ profileId, modules: [{ name, revision? }], includeDependencies: true })
 * - executeOperation({ operation, ...operationFields })
 *   -> data: { rpc?, requestXml?, reply?, messageId? } | string
 * - sendRpc({ rpc }) -> data: { rpc?, requestXml?, reply?, messageId? } | string
 *   (`rpc` is the operation fragment; `requestXml` is the complete envelope written to the transport.)
 *
 * window.yangApi
 * - listModules({ profileId, query? }) -> data: Module[] | { modules: Module[] }
 * - selectFiles() -> data: string[] | { filePaths: string[], canceled? }
 * - selectDirectory() -> data: string | { directoryPath, path?, canceled? }
 * - importFiles({ profileId, filePaths: string[] }) -> data: { imported?, failed?, workspace?, taskId? }
 * - importDirectory({ profileId, directoryPath: string }) -> data: { imported?, failed?, workspace?, taskId? }
 * - getCompilerStatus() -> data: {
 *     available, required, engine, executable, version?, path?, source?, error?, installHint?, capabilities?
 *   }
 * - compile({ profileId, moduleIds? }) -> data: CompileResult | { taskId }
 * - clearWorkspace({ profileId })
 * - getWorkspace({ profileId }) -> data: { compileId?, summary?, modules?, diagnostics?, schemaTree? }
 * - getSchemaRoots({ profileId, compileId? }) -> data: SchemaNode[] | { nodes: SchemaNode[] }
 * - getSchemaChildren({ profileId, compileId?, parentId, nodeId? }) -> data: SchemaNode[] | { nodes: SchemaNode[] }
 * - getSchemaNode({ profileId, compileId?, nodeId }) -> data: SchemaNode
 * - validateRpc({ profileId, compileId, rpc }) -> data: { valid, diagnostics, engine, performed, validationType? }
 * - getModuleSource({ profileId, moduleId?, name?, revision? }) -> data: string | { source, module? }
 * - getDiagnostics({ profileId, compileId? }) -> data: Diagnostic[] | { diagnostics: Diagnostic[] }
 */

export const YANG_EVENT = Object.freeze({
    TASK_PROGRESS: 'yang:taskProgress',
    SESSION_EVENT: 'netconf:sessionEvent',
    NOTIFICATION: 'netconf:notification',
    SUBSCRIPTION_EVENT: 'netconf:subscriptionEvent'
});

export const YANG_EVENT_PAGE_ID = Object.freeze({
    CONNECTION: 'yang-connection',
    MODULES: 'yang-modules',
    WORKSPACE: 'yang-workspace',
    OPERATIONS: 'yang-operations',
    NOTIFICATION_COLLECTOR: 'yang-notification-collector',
    TASK_NOTIFICATION: 'yang-task-notification'
});

export const YANG_ROUTE = Object.freeze({
    BASE: '/yang',
    CONNECTION: '/yang/yang-connection',
    MODULES: '/yang/yang-modules',
    WORKSPACE: '/yang/yang-workspace',
    OPERATIONS: '/yang/yang-operations'
});

export const YANG_TABS = Object.freeze([
    { key: 'yang-connection', label: '连接设置', route: YANG_ROUTE.CONNECTION },
    { key: 'yang-modules', label: '模型列表', route: YANG_ROUTE.MODULES },
    { key: 'yang-workspace', label: 'Schema 工作区', route: YANG_ROUTE.WORKSPACE }
]);

export const NETCONF_SESSION_STATUS = Object.freeze({
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    DISCONNECTING: 'disconnecting',
    ERROR: 'error'
});

export const NETCONF_SESSION_STATUS_META = Object.freeze({
    disconnected: { text: '未连接', color: 'default' },
    connecting: { text: '连接中', color: 'processing' },
    connected: { text: '已连接', color: 'success' },
    reconnecting: { text: '重连中', color: 'processing' },
    disconnecting: { text: '断开中', color: 'processing' },
    error: { text: '连接异常', color: 'error' }
});

export const NETCONF_AUTH_OPTIONS = Object.freeze([
    { label: '密码', value: 'password' },
    { label: '私钥', value: 'privateKey' }
]);

export const DEFAULT_NETCONF_PROFILE = Object.freeze({
    id: '',
    name: '',
    host: '',
    port: 830,
    username: '',
    authMethod: 'password',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    rememberCredentials: false,
    hostKeyFingerprint: '',
    connectTimeout: 15000,
    keepaliveInterval: 30000,
    autoReconnect: false
});

export const YANG_MODULE_STATUS_META = Object.freeze({
    remote: { text: '远端', color: 'blue' },
    discovered: { text: '已发现', color: 'blue' },
    downloading: { text: '下载中', color: 'processing' },
    downloaded: { text: '已下载', color: 'cyan' },
    imported: { text: '已导入', color: 'cyan' },
    compiling: { text: '编译中', color: 'processing' },
    compiled: { text: '已编译', color: 'success' },
    warning: { text: '有警告', color: 'warning' },
    missing: { text: '缺少依赖', color: 'warning' },
    failed: { text: '失败', color: 'error' }
});

export const YANG_COMPILER_STATUS_META = Object.freeze({
    checking: { text: '检测中', color: 'processing' },
    available: { text: 'libyang 就绪', color: 'success' },
    unavailable: { text: 'libyang 不可用', color: 'error' }
});

export const YANG_TASK_TERMINAL_PHASES = Object.freeze(['completed', 'failed', 'cancelled']);

export const NETCONF_DATASTORE_OPTIONS = Object.freeze([
    { label: 'running', value: 'running' },
    { label: 'candidate', value: 'candidate' },
    { label: 'startup', value: 'startup' }
]);

export const NETCONF_FILTER_TYPE_OPTIONS = Object.freeze([
    { label: '不过滤', value: 'none' },
    { label: 'subtree', value: 'subtree' },
    { label: 'xpath', value: 'xpath' }
]);

export const NETCONF_OPERATIONS = Object.freeze([
    { key: 'get', label: 'get', category: 'read' },
    { key: 'get-config', label: 'get-config', category: 'read' },
    { key: 'edit-config', label: 'edit-config', category: 'write' },
    { key: 'copy-config', label: 'copy-config', category: 'write' },
    { key: 'delete-config', label: 'delete-config', category: 'danger' },
    { key: 'lock', label: 'lock', category: 'write' },
    { key: 'unlock', label: 'unlock', category: 'write' },
    { key: 'validate', label: 'validate', category: 'read', capability: 'validate' },
    { key: 'commit', label: 'commit', category: 'write', capability: 'candidate' },
    { key: 'cancel-commit', label: 'cancel-commit', category: 'danger', capability: 'confirmedCommit' },
    { key: 'discard-changes', label: 'discard-changes', category: 'danger', capability: 'candidate' },
    { key: 'create-subscription', label: 'create-subscription', category: 'write', capability: 'notification' },
    { key: 'raw-rpc', label: '原始 RPC', category: 'danger' }
]);

export const NETCONF_CAPABILITY_HINTS = Object.freeze({
    candidate: ':candidate',
    validate: ':validate',
    startup: ':startup',
    writableRunning: ':writable-running',
    xpath: ':xpath',
    notification: ':notification',
    interleave: ':interleave',
    confirmedCommit: ':confirmed-commit',
    rollbackOnError: ':rollback-on-error'
});
