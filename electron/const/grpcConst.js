const GRPC_EVT_TYPES = {
    GRPC_EVT: 1
};

const GRPC_SUB_EVT_TYPES = {
    MESSAGE_RECEIVED: 1,
    SERVER_STATUS: 2,
    HISTORY_CLEARED: 3,
    STATS_UPDATED: 4,
    STREAM_UPDATED: 5,
    CLIENT_CALL_UPDATED: 6
};

const GRPC_REQ_TYPES = {
    COMPILE_PROTOS: 1,
    GET_PROTO_CATALOG: 2,
    GET_MESSAGE_TEMPLATE: 3,
    START_SERVER: 4,
    STOP_SERVER: 5,
    GET_MESSAGE_LIST: 6,
    GET_MESSAGE_DETAIL: 7,
    CLEAR_MESSAGE_HISTORY: 8,
    GET_STREAM_LIST: 9,
    SEND_STREAM_MESSAGE: 10,
    CLOSE_STREAM: 11,
    CLIENT_START_CALL: 12,
    CLIENT_SEND_MESSAGE: 13,
    CLIENT_END_CALL: 14,
    CLIENT_CANCEL_CALL: 15,
    GET_CLIENT_CALL_LIST: 16,
    GET_PROTO_TREE_CHILDREN: 17,
    GET_PROTO_NODE: 18,
    SAVE_PROTO_PROJECT: 19,
    LIST_PROTO_PROJECTS: 20,
    IMPORT_PROTO_PROJECT: 21,
    EXPORT_PROTO_PROJECT: 22,
    CLEAR_PROTOS: 23,
    REMOVE_PROTO_PROJECT: 24
};

const GRPC_MESSAGE_DIRECTION = {
    INBOUND: 'inbound',
    OUTBOUND: 'outbound'
};

const GRPC_MESSAGE_ROLE = {
    SERVER: 'server',
    CLIENT: 'client'
};

const GRPC_MESSAGE_STATUS = {
    DECODED: 'decoded',
    PARTIAL: 'partial',
    ERROR: 'error',
    SENT: 'sent'
};

const GRPC_STREAM_STATE = {
    OPEN: 'open',
    CLOSED: 'closed',
    ERROR: 'error'
};

const GRPC_PROTO_TREE_KIND = {
    PACKAGE: 'package',
    SERVICE: 'service',
    METHOD: 'method',
    MESSAGE: 'message',
    ENUM: 'enum',
    FIELD: 'field',
    ENUM_VALUE: 'enum-value'
};

const GRPC_METHOD_KIND = {
    UNARY: 'unary',
    SERVER_STREAM: 'server-stream',
    CLIENT_STREAM: 'client-stream',
    BIDI_STREAM: 'bidi-stream'
};

// bytes/string 字段的二次解码目标：
// - 具体消息全名（如 telemetry.Telemetry）
// - @proto_path：按最近一层携带 proto_path/encoding_path 的消息，解析出行内容的消息类型
// - @json：把字符串或字节按 JSON 文本解析
const GRPC_DECODE_TARGET = {
    PROTO_PATH: '@proto_path',
    JSON: '@json'
};

const GRPC_PROTO_PRESETS = [
    {
        id: 'huawei-dialout',
        name: '华为 Telemetry gRPC Dial-out',
        files: ['huawei-grpc-dialout.proto', 'huawei-telemetry.proto'],
        services: ['huawei_dialout.gRPCDataservice'],
        decodeRules: [
            { messageType: 'huawei_dialout.serviceArgs', field: 'data', targetType: 'telemetry.Telemetry' },
            { messageType: 'huawei_dialout.serviceArgs', field: 'data_json', targetType: '@json' },
            { messageType: 'telemetry.TelemetryRowGPB', field: 'content', targetType: '@proto_path' }
        ]
    },
    {
        id: 'cisco-mdt-dialout',
        name: 'Cisco IOS-XR MDT gRPC Dial-out',
        files: ['cisco-mdt-grpc-dialout.proto', 'cisco-telemetry.proto'],
        services: ['mdt_dialout.gRPCMdtDialout'],
        decodeRules: [
            { messageType: 'mdt_dialout.MdtDialoutArgs', field: 'data', targetType: 'cisco_telemetry.Telemetry' }
        ]
    },
    {
        id: 'gnmi',
        name: 'OpenConfig gNMI',
        files: ['gnmi.proto', 'gnmi_ext.proto'],
        services: ['gnmi.gNMI'],
        decodeRules: [{ messageType: 'gnmi.TypedValue', field: 'json_val', targetType: '@json' }]
    }
];

const DEFAULT_GRPC_SERVER_CONFIG = {
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

const DEFAULT_GRPC_CLIENT_CONFIG = {
    target: '127.0.0.1:57400',
    tlsEnabled: false,
    tlsCaPath: '',
    tlsCertPath: '',
    tlsKeyPath: '',
    tlsServerName: '',
    metadata: [],
    timeoutMs: 10000
};

const DEFAULT_GRPC_SETTINGS = {
    maxHistory: 1000,
    maxRawHexBytes: 4096,
    maxClientCalls: 200
};

module.exports = {
    GRPC_EVT_TYPES,
    GRPC_SUB_EVT_TYPES,
    GRPC_REQ_TYPES,
    GRPC_MESSAGE_DIRECTION,
    GRPC_MESSAGE_ROLE,
    GRPC_MESSAGE_STATUS,
    GRPC_STREAM_STATE,
    GRPC_METHOD_KIND,
    GRPC_PROTO_TREE_KIND,
    GRPC_DECODE_TARGET,
    GRPC_PROTO_PRESETS,
    DEFAULT_GRPC_SERVER_CONFIG,
    DEFAULT_GRPC_CLIENT_CONFIG,
    DEFAULT_GRPC_SETTINGS
};
