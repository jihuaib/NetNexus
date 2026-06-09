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

// 默认更新设置
const DEFAULT_UPDATE_SETTINGS = {
    autoCheckOnStartup: true,
    autoDownload: false
};

module.exports = {
    PROTOCOL_TYPE,
    START_LAYER,
    TRANSPORT_PROTOCOL,
    DEFAULT_TOOLS_SETTINGS,
    DEFAULT_LOG_SETTINGS,
    DEFAULT_UPDATE_SETTINGS
};
