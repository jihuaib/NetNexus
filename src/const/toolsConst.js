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
