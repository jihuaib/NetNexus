export const DEFAULT_VALUES = {
    DEFAULT_SYSLOG_PORT: 514,
    DEFAULT_ENABLE_UDP: true,
    DEFAULT_ENABLE_TCP: true,
    DEFAULT_MAX_MESSAGE_LENGTH: 8192
};

export const SYSLOG_SUB_EVT_TYPES = {
    MESSAGE_RECEIVED: 1,
    SERVER_STATUS: 2,
    HISTORY_CLEARED: 3,
    STATS_UPDATED: 4
};

export const SYSLOG_EVENT_PAGE_ID = {
    PAGE_ID_SYSLOG_CONFIG: 1,
    PAGE_ID_SYSLOG_MESSAGE_LOG: 2
};

export const SYSLOG_MESSAGE_STATUS = {
    RECEIVED: 'received',
    TRUNCATED: 'truncated',
    INVALID: 'invalid',
    ERROR: 'error'
};

export const SYSLOG_SEVERITY = {
    EMERGENCY: 'emergency',
    ALERT: 'alert',
    CRITICAL: 'critical',
    ERROR: 'error',
    WARNING: 'warning',
    NOTICE: 'notice',
    INFO: 'info',
    DEBUG: 'debug'
};
