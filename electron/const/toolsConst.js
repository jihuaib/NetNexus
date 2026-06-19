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

const TRANSPORT_PROTOCOL = {
    TCP: 6,
    UDP: 17
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
    }
};

// 默认日志设置
const DEFAULT_LOG_SETTINGS = {
    logLevel: 'off'
};

const LOG_REQ_TYPES = {
    SET_LOG_LEVEL: 'SET_LOG_LEVEL'
};

// 默认更新设置
const DEFAULT_UPDATE_SETTINGS = {
    autoCheckOnStartup: true,
    autoDownload: false
};

// TCP 工具：连接状态
const TCP_TOOL_STATE = {
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    CLOSED: 'closed',
    ERROR: 'error'
};

// TCP 工具：事件类型（主进程 -> 渲染进程）
const TCP_TOOL_EVT_TYPES = {
    STATE_CHANGE: 'tools:tcpStateChange',
    DATA: 'tools:tcpData'
};

// TCP 工具：默认值
const TCP_TOOL_DEFAULT = {
    CONNECT_TIMEOUT: 10000
};

// UDP 工具：socket 状态
const UDP_TOOL_STATE = {
    OPENING: 'opening',
    LISTENING: 'listening',
    CLOSED: 'closed',
    ERROR: 'error'
};

// UDP 工具：事件类型（主进程 -> 渲染进程）
const UDP_TOOL_EVT_TYPES = {
    STATE_CHANGE: 'tools:udpStateChange',
    DATA: 'tools:udpData'
};

module.exports = {
    PROTOCOL_TYPE,
    START_LAYER,
    TRANSPORT_PROTOCOL,
    DEFAULT_TOOLS_SETTINGS,
    DEFAULT_LOG_SETTINGS,
    LOG_REQ_TYPES,
    DEFAULT_UPDATE_SETTINGS,
    TCP_TOOL_STATE,
    TCP_TOOL_EVT_TYPES,
    TCP_TOOL_DEFAULT,
    UDP_TOOL_STATE,
    UDP_TOOL_EVT_TYPES
};
