// TFTP 操作码 (RFC 1350)
const TFTP_OPCODES = {
    RRQ: 1, // 读请求 (下载)
    WRQ: 2, // 写请求 (上传)
    DATA: 3, // 数据块
    ACK: 4, // 确认
    ERROR: 5, // 错误
    OACK: 6 // 选项确认 (RFC 2347)
};

// TFTP 错误码 (RFC 1350 + 2347)
const TFTP_ERROR_CODES = {
    NOT_DEFINED: 0,
    FILE_NOT_FOUND: 1,
    ACCESS_VIOLATION: 2,
    DISK_FULL: 3,
    ILLEGAL_OPERATION: 4,
    UNKNOWN_TID: 5,
    FILE_EXISTS: 6,
    NO_SUCH_USER: 7,
    OPTION_NEGOTIATION: 8
};

// 事件类型
const TFTP_EVT_TYPES = {
    TFTP_EVT: 1
};

// 子事件类型
const TFTP_SUB_EVT_TYPES = {
    TRANSFER_UPDATE: 1, // 传输状态更新
    SERVER_STATUS: 2, // 服务器状态
    HISTORY_CLEARED: 3 // 历史已清空
};

// 请求-响应类型
const TFTP_REQ_TYPES = {
    START_TFTP: 1,
    STOP_TFTP: 2,
    GET_TRANSFER_LIST: 3,
    CLEAR_TRANSFER_HISTORY: 4
};

// 传输状态
const TFTP_TRANSFER_STATUS = {
    TRANSFERRING: 'transferring',
    COMPLETED: 'completed',
    ERROR: 'error'
};

// 传输类型
const TFTP_TRANSFER_TYPE = {
    READ: 'read', // 客户端下载 (RRQ)
    WRITE: 'write' // 客户端上传 (WRQ)
};

// 块大小限制 (RFC 2348)
const TFTP_BLOCK_SIZE = {
    MIN: 8,
    MAX: 65464,
    DEFAULT: 512
};

const DEFAULT_TFTP_CONFIG = {
    port: 69,
    rootDir: '',
    blockSize: 512,
    timeout: 3, // 秒
    retries: 5,
    allowRead: true,
    allowWrite: true
};

const DEFAULT_TFTP_SETTINGS = {
    maxHistory: 200
};

module.exports = {
    TFTP_OPCODES,
    TFTP_ERROR_CODES,
    TFTP_EVT_TYPES,
    TFTP_SUB_EVT_TYPES,
    TFTP_REQ_TYPES,
    TFTP_TRANSFER_STATUS,
    TFTP_TRANSFER_TYPE,
    TFTP_BLOCK_SIZE,
    DEFAULT_TFTP_CONFIG,
    DEFAULT_TFTP_SETTINGS
};
