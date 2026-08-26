export const GRPC_ROUTE = Object.freeze({
    BASE: '/grpc',
    PROTO: '/grpc/grpc-proto',
    WORKSPACE: '/grpc/grpc-workspace'
});

export const GRPC_TABS = Object.freeze([
    { key: 'grpc-proto', label: 'Proto编译', route: GRPC_ROUTE.PROTO },
    { key: 'grpc-workspace', label: 'gRPC工作区', route: GRPC_ROUTE.WORKSPACE }
]);

export const GRPC_RUNTIME_CHANGED_EVENT = 'grpc:runtimeChanged';

export const GRPC_SUB_EVT_TYPES = {
    MESSAGE_RECEIVED: 1,
    SERVER_STATUS: 2,
    HISTORY_CLEARED: 3,
    STATS_UPDATED: 4,
    STREAM_UPDATED: 5,
    CLIENT_CALL_UPDATED: 6
};

export const GRPC_EVENT_PAGE_ID = {
    PAGE_ID_GRPC_PROTO: 1,
    PAGE_ID_GRPC_WORKSPACE: 2,
    PAGE_ID_GRPC_MESSAGE_LOG: 3
};

export const GRPC_MESSAGE_DIRECTION = {
    INBOUND: 'inbound',
    OUTBOUND: 'outbound'
};

export const GRPC_MESSAGE_ROLE = {
    SERVER: 'server',
    CLIENT: 'client'
};

export const GRPC_MESSAGE_STATUS = {
    DECODED: 'decoded',
    PARTIAL: 'partial',
    ERROR: 'error',
    SENT: 'sent'
};

export const GRPC_STREAM_STATE = {
    OPEN: 'open',
    CLOSED: 'closed',
    ERROR: 'error'
};

export const GRPC_PROTO_TREE_KIND = {
    PACKAGE: 'package',
    SERVICE: 'service',
    METHOD: 'method',
    MESSAGE: 'message',
    ENUM: 'enum',
    FIELD: 'field',
    ENUM_VALUE: 'enum-value'
};

export const GRPC_METHOD_KIND = {
    UNARY: 'unary',
    SERVER_STREAM: 'server-stream',
    CLIENT_STREAM: 'client-stream',
    BIDI_STREAM: 'bidi-stream'
};

export const GRPC_METHOD_KIND_LABELS = {
    [GRPC_METHOD_KIND.UNARY]: 'Unary',
    [GRPC_METHOD_KIND.SERVER_STREAM]: 'Server Stream',
    [GRPC_METHOD_KIND.CLIENT_STREAM]: 'Client Stream',
    [GRPC_METHOD_KIND.BIDI_STREAM]: 'Bidi Stream'
};

export const GRPC_DECODE_TARGET = {
    PROTO_PATH: '@proto_path',
    JSON: '@json'
};

export const DEFAULT_GRPC_SERVER_CONFIG = {
    host: '0.0.0.0',
    port: 57400,
    services: [],
    decodeRules: [],
    unaryReplyTemplates: {},
    tlsEnabled: false,
    tlsCertPath: '',
    tlsKeyPath: '',
    tlsCaPath: '',
    tlsRequireClientCert: false,
    maxMessageBytes: 16 * 1024 * 1024
};

export const DEFAULT_GRPC_CLIENT_CONFIG = {
    target: '127.0.0.1:57400',
    tlsEnabled: false,
    tlsCaPath: '',
    tlsCertPath: '',
    tlsKeyPath: '',
    tlsServerName: '',
    metadata: [],
    timeoutMs: 10000
};
