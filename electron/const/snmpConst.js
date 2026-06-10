// SNMP事件类型
const SNMP_EVT_TYPES = {
    TRAP_EVT: 1
};

const SNMP_SUB_EVT_TYPES = {
    TRAP_RECEIVED: 1,
    AGENT_CONNECTION: 2,
    AGENT_DISCONNECTION: 3,
    TRAP_PROCESSED: 4,
    TRAP_ERROR: 5,
    SERVER_STATUS: 6,
    TRAP_BATCH_RECEIVED: 7,
    QUERY_BATCH_RECEIVED: 8,
    QUERY_ERROR: 9
};

// SNMP请求-响应类型
const SNMP_REQ_TYPES = {
    START_SNMP: 1,
    STOP_SNMP: 2,
    GET_TRAP_LIST: 3,
    GET_TRAP_DETAIL: 4,
    CLEAR_TRAP_HISTORY: 5,
    UPDATE_CONFIG: 6,
    COMPILE_MIBS: 7,
    GET_QUERY_LIST: 8,
    CLEAR_QUERY_HISTORY: 9
};

const MIB_REQ_TYPES = {
    COMPILE_MIBS: 'compileMibs',
    GET_MIB_STATUS: 'getMibStatus',
    CLEAR_MIBS: 'clearMibs',
    TRANSLATE_OID: 'translateOid'
};

// SNMP版本
const SNMP_VERSION = {
    v1: 1,
    v2c: 2,
    v3: 3
};

// SNMP PDU类型
const SNMP_PDU_TYPE = {
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
const SNMP_SECURITY_LEVEL = {
    NO_AUTH_NO_PRIV: 1,
    AUTH_NO_PRIV: 2,
    AUTH_PRIV: 3
};

// 默认设置
const DEFAULT_SNMP_SETTINGS = {
    maxTrapHistory: 1000,
    maxQueryHistory: 1000,
    targetHost: '127.0.0.1',
    port: 162,
    queryPort: 10161,
    enableQueryMonitor: true,
    timeout: 5000
};

module.exports = {
    SNMP_EVT_TYPES,
    SNMP_REQ_TYPES,
    MIB_REQ_TYPES,
    SNMP_VERSION,
    SNMP_PDU_TYPE,
    SNMP_SECURITY_LEVEL,
    DEFAULT_SNMP_SETTINGS,
    SNMP_SUB_EVT_TYPES
};
