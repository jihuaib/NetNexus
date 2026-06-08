const PROTOCOL_TYPE = {
    AUTO: 1,
    BGP: 2
};

const START_LAYER = {
    L2: 1,
    L3: 2,
    L4: 3,
    L5: 4
};

// 默认工具设置
const DEFAULT_TOOLS_SETTINGS = {
    packetParser: {
        maxMessageHistory: 10
    },
    stringGenerator: {
        maxStringHistory: 10
    },
    ftpServer: {
        maxFtpUser: 10
    },
    formatter: {
        maxFormatterHistory: 10
    }
};

// 默认日志设置
const DEFAULT_LOG_SETTINGS = {
    logLevel: 'off'
};

// 默认更新设置
const DEFAULT_UPDATE_SETTINGS = {
    autoCheckOnStartup: true,
    autoDownload: false
};

// 工具事件类型
const TOOLS_EVT_TYPES = {
    PACKET_EVENT: 1
};

const PACKET_SUB_EVT_TYPES = {
    PACKET_CAPTURED: 1,
    PACKET_ERROR: 2,
    PACKET_CAPTURE_START: 3,
    PACKET_CAPTURE_STOP: 4
};

// 工具请求-响应类型
const TOOLS_REQ_TYPES = {
    START_CAPTURE: 1,
    STOP_CAPTURE: 2,
    GET_NETWORK_INTERFACES: 3
};

module.exports = {
    PROTOCOL_TYPE,
    START_LAYER,
    DEFAULT_TOOLS_SETTINGS,
    DEFAULT_LOG_SETTINGS,
    DEFAULT_UPDATE_SETTINGS,
    TOOLS_EVT_TYPES,
    TOOLS_REQ_TYPES,
    PACKET_SUB_EVT_TYPES
};
