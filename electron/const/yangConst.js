const NETCONF_REQ_TYPES = Object.freeze({
    TEST_CONNECTION: 'testConnection',
    CONNECT: 'connect',
    DISCONNECT: 'disconnect',
    DISCONNECT_ALL: 'disconnectAll',
    GET_SESSION_STATE: 'getSessionState',
    GET_SUBSCRIPTIONS: 'getSubscriptions',
    DISCOVER_MODULES: 'discoverModules',
    GET_SCHEMA: 'getSchema',
    EXECUTE_OPERATION: 'executeOperation',
    SEND_RPC: 'sendRpc'
});

const YANG_REQ_TYPES = Object.freeze({
    GET_WORKSPACE: 'getWorkspace',
    IMPORT_FILES: 'importFiles',
    IMPORT_CONTENTS: 'importContents',
    GET_COMPILER_STATUS: 'getCompilerStatus',
    COMPILE: 'compile',
    CLEAR_WORKSPACE: 'clearWorkspace',
    LIST_MODULES: 'listModules',
    GET_SCHEMA_ROOTS: 'getSchemaRoots',
    GET_SCHEMA_CHILDREN: 'getSchemaChildren',
    GET_SCHEMA_NODE: 'getSchemaNode',
    VALIDATE_RPC: 'validateRpc',
    GET_MODULE_SOURCE: 'getModuleSource',
    GET_DIAGNOSTICS: 'getDiagnostics'
});

const YANG_EVT_TYPES = Object.freeze({
    TASK_PROGRESS: 'yang:taskProgress',
    SESSION_EVENT: 'netconf:sessionEvent',
    SUBSCRIPTION_EVENT: 'netconf:subscriptionEvent',
    NOTIFICATION: 'netconf:notification'
});

const NETCONF_CAPABILITIES = Object.freeze({
    NOTIFICATION: 'urn:ietf:params:netconf:capability:notification:1.0',
    INTERLEAVE: 'urn:ietf:params:netconf:capability:interleave:1.0'
});

const DEFAULT_NETCONF_PROFILE = Object.freeze({
    name: '',
    host: '127.0.0.1',
    port: 830,
    username: '',
    authMethod: 'password',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    rememberCredentials: false,
    hostKeyPolicy: 'ask',
    hostKeyFingerprint: '',
    connectTimeout: 15000,
    rpcTimeout: 30000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
    autoReconnect: false
});

const NETCONF_LIMITS = Object.freeze({
    MAX_MESSAGE_BYTES: 32 * 1024 * 1024,
    MAX_SCHEMA_BYTES: 8 * 1024 * 1024,
    MAX_RAW_RPC_BYTES: 8 * 1024 * 1024,
    DEFAULT_RPC_TIMEOUT: 30000,
    DEFAULT_CONNECT_TIMEOUT: 15000,
    DOWNLOAD_CONCURRENCY: 3
});

module.exports = {
    NETCONF_REQ_TYPES,
    YANG_REQ_TYPES,
    YANG_EVT_TYPES,
    NETCONF_CAPABILITIES,
    DEFAULT_NETCONF_PROFILE,
    NETCONF_LIMITS
};
