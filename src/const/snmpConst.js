// SNMP事件类型
export const SNMP_EVT_TYPES = {
    TRAP_EVT: 1
};

export const SNMP_SUB_EVT_TYPES = {
    TRAP_RECEIVED: 1,
    AGENT_CONNECTION: 2,
    AGENT_DISCONNECTION: 3,
    TRAP_PROCESSED: 4,
    TRAP_ERROR: 5,
    SERVER_STATUS: 6,
    TRAP_BATCH_RECEIVED: 7
};

// SNMP版本
export const SNMP_VERSION = {
    v1: 'v1',
    v2c: 'v2c',
    v3: 'v3'
};

// SNMP Trap状态
export const SNMP_TRAP_STATUS = {
    WAITING: 'waiting',
    RECEIVED: 'received',
    PROCESSED: 'processed',
    ERROR: 'error'
};

// SNMP默认配置
export const DEFAULT_VALUES = {
    DEFAULT_SNMP_PORT: 162,
    DEFAULT_COMMUNITY: 'public',
    DEFAULT_VERSION: SNMP_VERSION.v2c
};

// SNMP PDU类型
export const SNMP_PDU_TYPE = {
    GET_REQUEST: 0xa0,
    GET_NEXT_REQUEST: 0xa1,
    GET_RESPONSE: 0xa2,
    SET_REQUEST: 0xa3,
    TRAP: 0xa4,
    GET_BULK_REQUEST: 0xa5,
    INFORM_REQUEST: 0xa6,
    SNMPV2_TRAP: 0xa7,
    REPORT: 0xa8
};

// SNMP安全级别（SNMPv3）
export const SNMP_SECURITY_LEVEL = {
    NO_AUTH_NO_PRIV: 'noAuthNoPriv',
    AUTH_NO_PRIV: 'authNoPriv',
    AUTH_PRIV: 'authPriv'
};

// SNMP认证协议
export const SNMP_AUTH_PROTOCOL = {
    NONE: 'none',
    MD5: 'MD5',
    SHA: 'SHA',
    SHA224: 'SHA224',
    SHA256: 'SHA256',
    SHA384: 'SHA384',
    SHA512: 'SHA512'
};

// SNMP加密协议
export const SNMP_PRIV_PROTOCOL = {
    NONE: 'none',
    DES: 'DES',
    AES: 'AES',
    AES192: 'AES192',
    AES256: 'AES256'
};

export const SNMP_EVENT_PAGE_ID = {
    PAGE_ID_SNMP_CONFIG: 1,
    PAGE_ID_SNMP_TRAP: 2
};
