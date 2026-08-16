// DHCPv6 事件类型（worker -> app 推送）
const DHCP6_EVT_TYPES = {
    DHCP6_EVT: 'dhcp6:event'
};

// DHCPv6 子事件类型
const DHCP6_SUB_EVT_TYPES = {
    DHCP6_SUB_EVT_LEASE: 1 // 租约变更（add/remove/update）
};

// DHCPv6 请求-响应类型（app -> worker）
const DHCP6_REQ_TYPES = {
    START_DHCP6: 'dhcp6:start',
    STOP_DHCP6: 'dhcp6:stop',
    GET_LEASE_LIST: 'dhcp6:leases:get',
    RELEASE_LEASE: 'dhcp6:lease:release'
};

// DHCPv6 消息类型（RFC 3315）
const DHCP6_MSG_TYPES = {
    SOLICIT: 1,
    ADVERTISE: 2,
    REQUEST: 3,
    CONFIRM: 4,
    RENEW: 5,
    REBIND: 6,
    REPLY: 7,
    RELEASE: 8,
    DECLINE: 9,
    RECONFIGURE: 10,
    INFORMATION_REQUEST: 11
};

// DHCPv6 Options
const DHCP6_OPTS = {
    CLIENTID: 1,
    SERVERID: 2,
    IA_NA: 3,
    IA_TA: 4,
    IAADDR: 5,
    ORO: 6,
    PREFERENCE: 7,
    ELAPSED_TIME: 8,
    RELAY_MSG: 9,
    STATUS_CODE: 13,
    RAPID_COMMIT: 14,
    DNS_SERVERS: 23,
    DOMAIN_LIST: 24
};

// DHCPv6 Status Code
const DHCP6_STATUS = {
    SUCCESS: 0,
    UNSPEC_FAIL: 1,
    NO_ADDRS_AVAIL: 2,
    NO_BINDING: 3,
    NOT_ON_LINK: 4,
    USE_MULTICAST: 5
};

// 默认配置（serverDuid 由 worker 自动生成，无需用户填写）
const DEFAULT_DHCP6_CONFIG = {
    serverPort: 547,
    poolStart: '2001:db8::100',
    poolEnd: '2001:db8::1ff',
    preferredLifetime: 3600,
    validLifetime: 7200,
    dns1: '2001:4860:4860::8888',
    dns2: '2001:4860:4860::8844'
};

module.exports = {
    DHCP6_EVT_TYPES,
    DHCP6_SUB_EVT_TYPES,
    DHCP6_REQ_TYPES,
    DHCP6_MSG_TYPES,
    DHCP6_OPTS,
    DHCP6_STATUS,
    DEFAULT_DHCP6_CONFIG
};
