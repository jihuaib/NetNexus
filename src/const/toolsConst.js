// 需要和后台定义保持一致, 后台会
// 直接使用这个值处理
export const PROTOCOL_TYPE = {
    AUTO: 1,
    BGP: 2
};

// 需要和后台定义保持一致, 后台会
// 直接使用这个值处理
export const START_LAYER = {
    L2: 1,
    L3: 2,
    L4: 3,
    L5: 4
};

export const TRANSPORT_PROTOCOL = {
    TCP: 6,
    UDP: 17
};

// 默认工具设置
export const DEFAULT_TOOLS_SETTINGS = {
    packetParser: {
        maxMessageHistory: 10
    },
    stringGenerator: {
        maxStringHistory: 10
    }
};

// 默认日志设置
export const DEFAULT_LOG_SETTINGS = {
    logLevel: 'off'
};

export const START_LAYER_NAME = {
    [START_LAYER.L2]: '数据链路层',
    [START_LAYER.L3]: '网络层',
    [START_LAYER.L4]: '传输层',
    [START_LAYER.L5]: '应用层'
};

export const PROTOCOL_TYPE_NAME = {
    [PROTOCOL_TYPE.AUTO]: '自动识别',
    [PROTOCOL_TYPE.BGP]: 'BGP'
};

export const TRANSPORT_PROTOCOL_NAME = {
    [TRANSPORT_PROTOCOL.TCP]: 'TCP',
    [TRANSPORT_PROTOCOL.UDP]: 'UDP'
};

export const TOOLS_EVENT_PAGE_ID = {
    PAGE_ID_TOOLS_UPDATE_SETTINGS: 1,
    PAGE_ID_TOOLS_UPDATE_NOTIFICATION: 2
};

// TCP 工具：连接状态（需要和后台定义保持一致）
export const TCP_TOOL_STATE = {
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    CLOSED: 'closed',
    ERROR: 'error'
};

export const TCP_TOOL_STATE_NAME = {
    [TCP_TOOL_STATE.CONNECTING]: '连接中',
    [TCP_TOOL_STATE.CONNECTED]: '已连接',
    [TCP_TOOL_STATE.CLOSED]: '已关闭',
    [TCP_TOOL_STATE.ERROR]: '错误'
};

// TCP 工具：事件类型（主进程 -> 渲染进程，需要和后台定义保持一致）
export const TCP_TOOL_EVT_TYPES = {
    STATE_CHANGE: 'tools:tcpStateChange',
    DATA: 'tools:tcpData'
};

// TCP 工具：报文编码方式
export const TCP_TOOL_ENCODING = {
    UTF8: 'utf8',
    HEX: 'hex',
    BASE64: 'base64'
};

// UDP 工具：socket 状态（需要和后台定义保持一致）
export const UDP_TOOL_STATE = {
    OPENING: 'opening',
    LISTENING: 'listening',
    CLOSED: 'closed',
    ERROR: 'error'
};

export const UDP_TOOL_STATE_NAME = {
    [UDP_TOOL_STATE.OPENING]: '打开中',
    [UDP_TOOL_STATE.LISTENING]: '就绪',
    [UDP_TOOL_STATE.CLOSED]: '已关闭',
    [UDP_TOOL_STATE.ERROR]: '错误'
};

// UDP 工具：事件类型（主进程 -> 渲染进程，需要和后台定义保持一致）
export const UDP_TOOL_EVT_TYPES = {
    STATE_CHANGE: 'tools:udpStateChange',
    DATA: 'tools:udpData'
};

// UDP 工具：报文编码方式
export const UDP_TOOL_ENCODING = {
    UTF8: 'utf8',
    HEX: 'hex',
    BASE64: 'base64'
};
