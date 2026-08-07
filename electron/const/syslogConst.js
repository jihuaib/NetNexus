const SYSLOG_EVT_TYPES = {
    SYSLOG_EVT: 1
};

const SYSLOG_SUB_EVT_TYPES = {
    MESSAGE_RECEIVED: 1,
    SERVER_STATUS: 2,
    HISTORY_CLEARED: 3,
    STATS_UPDATED: 4
};

const SYSLOG_REQ_TYPES = {
    START_SYSLOG: 1,
    STOP_SYSLOG: 2,
    GET_MESSAGE_LIST: 3,
    CLEAR_MESSAGE_HISTORY: 4,
    GET_MESSAGE_DETAIL: 5
};

const SYSLOG_MESSAGE_STATUS = {
    RECEIVED: 'received',
    TRUNCATED: 'truncated',
    INVALID: 'invalid',
    ERROR: 'error'
};

const SYSLOG_TRANSPORT = {
    UDP: 'UDP',
    TCP: 'TCP'
};

const DEFAULT_SYSLOG_CONFIG = {
    port: 514,
    enableUdp: true,
    enableTcp: true,
    maxMessageLength: 8192
};

const DEFAULT_SYSLOG_SETTINGS = {
    maxHistory: 500,
    maxTcpBufferLength: 1024 * 1024,
    tcpIdleTimeoutMs: 300000
};

module.exports = {
    SYSLOG_EVT_TYPES,
    SYSLOG_SUB_EVT_TYPES,
    SYSLOG_REQ_TYPES,
    SYSLOG_MESSAGE_STATUS,
    SYSLOG_TRANSPORT,
    DEFAULT_SYSLOG_CONFIG,
    DEFAULT_SYSLOG_SETTINGS
};
