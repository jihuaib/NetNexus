// TFTP 服务器相关常量
export const DEFAULT_VALUES = {
    DEFAULT_TFTP_PORT: 69,
    DEFAULT_TFTP_ROOT_DIR: '',
    DEFAULT_TFTP_BLOCK_SIZE: 512,
    DEFAULT_TFTP_TIMEOUT: 3,
    DEFAULT_TFTP_RETRIES: 5,
    DEFAULT_TFTP_ALLOW_READ: true,
    DEFAULT_TFTP_ALLOW_WRITE: true
};

// 事件类型
export const TFTP_EVT_TYPES = {
    TFTP_EVT: 1
};

// 子事件类型
export const TFTP_SUB_EVT_TYPES = {
    TRANSFER_UPDATE: 1,
    SERVER_STATUS: 2,
    HISTORY_CLEARED: 3
};

// 页面事件 ID (每个页面唯一)
export const TFTP_EVENT_PAGE_ID = {
    PAGE_ID_TFTP_CONFIG: 1,
    PAGE_ID_TFTP_TRANSFER_LOG: 2
};

// 传输状态
export const TFTP_TRANSFER_STATUS = {
    TRANSFERRING: 'transferring',
    COMPLETED: 'completed',
    ERROR: 'error'
};

// 传输类型
export const TFTP_TRANSFER_TYPE = {
    READ: 'read',
    WRITE: 'write'
};
