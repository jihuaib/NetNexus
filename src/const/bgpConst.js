// 协议规定的BGP open capability code, 需要和后台定义保持一致, 后台会
// 直接使用这个值处理
export const BGP_OPEN_CAP_CODE = {
    MULTIPROTOCOL_EXTENSIONS: 0x01,
    ROUTE_REFRESH: 0x02,
    EXTENDED_NEXT_HOP_ENCODING: 0x05,
    FOUR_OCTET_AS: 0x41,
    ADD_PATH: 0x45,
    BGP_ROLE: 0x09
};

// BGP Role Values, 需要和后台定义保持一致, 后台会
// 直接使用这个值处理
export const BGP_ROLE_TYPE = {
    ROLE_PROVIDER: 0,
    ROLE_RS: 1,
    ROLE_RS_CLIENT: 2,
    ROLE_CUSTOMER: 3,
    ROLE_PEER: 4,
    ROLE_INVALID: 255
};

// Address Family Values, 需要和后台定义保持一致, 后台会
// 直接使用这个值处理
export const BGP_ADDR_FAMILY = {
    IPV4_UNC: 1,
    IPV6_UNC: 2,
    L2VPN_EVPN: 3,
    VPNV4: 4,
    VPNV6: 5,
    IPV4_MVPN: 6,
    IPV6_MVPN: 7,
    IPV4_QP: 8,
    IPV6_QP: 9,
    IPV4_FLOWSPEC: 10,
    IPV6_FLOWSPEC: 11,
    IPV4_LABEL_UNICAST: 12,
    IPV6_LABEL_UNICAST: 13,
    LINK_STATE: 14,
    LINK_STATE_VPN: 15,
    IPV4_MULTICAST: 16,
    IPV6_MULTICAST: 17
};

export const BGP_QP_ROUTE_GROWTH_MODE = {
    IP: 'ip',
    DQPN: 'dqpn',
    IP_DQPN: 'ip_dqpn'
};

export const BGP_QP_BSID_MODE = {
    FIXED: 'fixed',
    CONTINUOUS: 'continuous'
};

export const BGP_LABEL_MODE = {
    FIXED: 'fixed',
    INCREMENT: 'increment'
};

export const BGP_MPLS_LABEL_MAX = 0xfffff;
export const BGP_DEFAULT_PORT = 179;

export const BGP_SRV6_SID_MODE = {
    FIXED: 'fixed',
    INCREMENT: 'increment'
};

export const BGP_SRV6_ENDPOINT_BEHAVIOR = {
    END_DX6: 0x0010,
    END_DX4: 0x0011,
    END_DT6: 0x0012,
    END_DT4: 0x0013,
    END_DT46: 0x0014
};

// IP Type Values, 需要和后台定义保持一致, 后台会
// 直接使用这个值处理
export const IP_TYPE = {
    IPV4: 1,
    IPV6: 2
};

// Peer Type Values, 需要和后台定义保持一致, 后台会
// 直接使用这个值处理
export const BGP_PEER_TYPE = {
    PEER_TYPE_INVALID: 0,
    PEER_TYPE_IBGP: 1,
    PEER_TYPE_EBGP: 2
};

export const ADDRESS_FAMILY_NAME = {
    [BGP_ADDR_FAMILY.IPV4_UNC]: 'IPv4 UNC',
    [BGP_ADDR_FAMILY.IPV6_UNC]: 'IPv6 UNC',
    [BGP_ADDR_FAMILY.L2VPN_EVPN]: 'L2VPN EVPN',
    [BGP_ADDR_FAMILY.VPNV4]: 'VPNV4',
    [BGP_ADDR_FAMILY.VPNV6]: 'VPNV6',
    [BGP_ADDR_FAMILY.IPV4_MVPN]: 'IPv4 MVPN',
    [BGP_ADDR_FAMILY.IPV6_MVPN]: 'IPv6 MVPN',
    [BGP_ADDR_FAMILY.IPV4_QP]: 'IPv4 QP',
    [BGP_ADDR_FAMILY.IPV6_QP]: 'IPv6 QP',
    [BGP_ADDR_FAMILY.IPV4_FLOWSPEC]: 'IPv4 FlowSpec',
    [BGP_ADDR_FAMILY.IPV6_FLOWSPEC]: 'IPv6 FlowSpec',
    [BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST]: 'IPv4 Label',
    [BGP_ADDR_FAMILY.IPV6_LABEL_UNICAST]: 'IPv6 Label',
    [BGP_ADDR_FAMILY.LINK_STATE]: 'Link-State',
    [BGP_ADDR_FAMILY.LINK_STATE_VPN]: 'Link-State VPN',
    [BGP_ADDR_FAMILY.IPV4_MULTICAST]: 'IPv4 Multicast',
    [BGP_ADDR_FAMILY.IPV6_MULTICAST]: 'IPv6 Multicast'
};

export const getAddrFamilyType = (afi, safi) => {
    if (afi === 1 && safi === 1) return BGP_ADDR_FAMILY.IPV4_UNC;
    if (afi === 1 && safi === 2) return BGP_ADDR_FAMILY.IPV4_MULTICAST;
    if (afi === 1 && safi === 128) return BGP_ADDR_FAMILY.VPNV4;
    if (afi === 1 && safi === 4) return BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST;
    if (afi === 1 && safi === 5) return BGP_ADDR_FAMILY.IPV4_MVPN;
    if (afi === 1 && safi === 133) return BGP_ADDR_FAMILY.IPV4_FLOWSPEC;
    if (afi === 1 && safi === 241) return BGP_ADDR_FAMILY.IPV4_QP;
    if (afi === 2 && safi === 1) return BGP_ADDR_FAMILY.IPV6_UNC;
    if (afi === 2 && safi === 2) return BGP_ADDR_FAMILY.IPV6_MULTICAST;
    if (afi === 2 && safi === 128) return BGP_ADDR_FAMILY.VPNV6;
    if (afi === 2 && safi === 4) return BGP_ADDR_FAMILY.IPV6_LABEL_UNICAST;
    if (afi === 2 && safi === 5) return BGP_ADDR_FAMILY.IPV6_MVPN;
    if (afi === 2 && safi === 133) return BGP_ADDR_FAMILY.IPV6_FLOWSPEC;
    if (afi === 2 && safi === 241) return BGP_ADDR_FAMILY.IPV6_QP;
    if (afi === 25 && safi === 70) return BGP_ADDR_FAMILY.L2VPN_EVPN;
    if (afi === 16388 && safi === 71) return BGP_ADDR_FAMILY.LINK_STATE;
    if (afi === 16388 && safi === 72) return BGP_ADDR_FAMILY.LINK_STATE_VPN;
    return null;
};

// Default Values
export const DEFAULT_VALUES = {
    LOCAL_AS: '65535',
    ROUTER_ID: '192.168.56.1',
    BGP_PORT: String(BGP_DEFAULT_PORT),
    PEER_IP: '192.168.56.11',
    PEER_AS: '100',
    HOLD_TIME: '180',
    DEFAULT_OPEN_CAP: [
        BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
        BGP_OPEN_CAP_CODE.ROUTE_REFRESH,
        BGP_OPEN_CAP_CODE.FOUR_OCTET_AS
    ],
    DEFAULT_ADDRESS_FAMILY: [BGP_ADDR_FAMILY.IPV4_UNC],
    DEFAULT_ROLE: BGP_ROLE_TYPE.ROLE_PROVIDER,
    IPV4_PREFIX: '1.1.1.1',
    IPV4_MASK: '32',
    IPV4_COUNT: '10',
    IPV4_ADD_PATH_ENABLED: false,
    IPV4_ADD_PATH_COUNT: '2',
    IPV4_LABEL_MODE: BGP_LABEL_MODE.FIXED,
    IPV4_LABEL_START: '16',
    IPV4_LABEL_STEP: '1',
    IPV4_SRV6_ENABLED: false,
    IPV4_SRV6_SID_MODE: BGP_SRV6_SID_MODE.FIXED,
    IPV4_SRV6_SID: '2001:db8:1::1',
    IPV4_SRV6_SID_STEP: '1',
    IPV4_SRV6_ENDPOINT_BEHAVIOR: BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT4,
    IPV6_PREFIX: '2001:db8::',
    IPV6_MASK: '64',
    IPV6_COUNT: '10',
    IPV6_ADD_PATH_ENABLED: false,
    IPV6_ADD_PATH_COUNT: '2',
    IPV6_SRV6_ENABLED: false,
    IPV6_SRV6_SID_MODE: BGP_SRV6_SID_MODE.FIXED,
    IPV6_SRV6_SID: '2001:db8:1::1',
    IPV6_SRV6_SID_STEP: '1',
    IPV6_SRV6_ENDPOINT_BEHAVIOR: BGP_SRV6_ENDPOINT_BEHAVIOR.END_DT6,
    PEER_IPV6: '192::11',
    PEER_IPV6_AS: '100',
    HOLD_TIME_IPV6: '180',
    DEFAULT_OPEN_CAP_IPV6: [
        BGP_OPEN_CAP_CODE.MULTIPROTOCOL_EXTENSIONS,
        BGP_OPEN_CAP_CODE.ROUTE_REFRESH,
        BGP_OPEN_CAP_CODE.FOUR_OCTET_AS
    ],
    DEFAULT_ADDRESS_FAMILY_IPV6: [BGP_ADDR_FAMILY.IPV6_UNC]
};

export const BGP_MVPN_ROUTE_TYPE = {
    INTRA_AS_I_PMSI_AD: 1,
    INTER_AS_I_PMSI_AD: 2,
    S_PMSI_AD: 3,
    LEAF_AD: 4,
    SOURCE_ACTIVE_AD: 5,
    SHARED_TREE_JOIN: 6,
    SOURCE_TREE_JOIN: 7
};

export const BGP_EVENT_PAGE_ID = {
    PAGE_ID_BGP_PEER_INFO: 1
};
