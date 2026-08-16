// DHCP事件类型（worker -> app 推送）
const DHCP_EVT_TYPES = {
    DHCP_EVT: 'dhcp:event'
};

// DHCP子事件类型
const DHCP_SUB_EVT_TYPES = {
    DHCP_SUB_EVT_LEASE: 1, // 租约变更（add/remove/update）
    DHCP_SUB_EVT_LOG: 2 // 日志事件
};

// DHCP请求-响应类型（app -> worker）
const DHCP_REQ_TYPES = {
    START_DHCP: 'dhcp:start',
    STOP_DHCP: 'dhcp:stop',
    GET_LEASE_LIST: 'dhcp:leases:get',
    RELEASE_LEASE: 'dhcp:lease:release'
};

// DHCP消息类型（RFC 2132）
const DHCP_MSG_TYPES = {
    DISCOVER: 1,
    OFFER: 2,
    REQUEST: 3,
    DECLINE: 4,
    ACK: 5,
    NAK: 6,
    RELEASE: 7,
    INFORM: 8
};

// 默认DHCP配置（serverIp 留空，由 worker 自动探测本机 IP）
const DEFAULT_DHCP_CONFIG = {
    serverPort: 67,
    serverIp: '',
    poolStart: '192.168.1.100',
    poolEnd: '192.168.1.200',
    subnetMask: '255.255.255.0',
    gateway: '192.168.1.1',
    dns1: '8.8.8.8',
    dns2: '8.8.4.4',
    leaseTime: 86400 // 24小时（秒）
};

module.exports = {
    DHCP_EVT_TYPES,
    DHCP_SUB_EVT_TYPES,
    DHCP_REQ_TYPES,
    DHCP_MSG_TYPES,
    DEFAULT_DHCP_CONFIG
};
