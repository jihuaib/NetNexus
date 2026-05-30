// BMP peer types, 需要和后台定义保持一致, 后台会
// 直接使用这个值处理
export const BMP_VERSION = {
    V3: 3,
    V4: 4
};

export const BMP_V4_TLV_DRAFT = {
    DRAFT_19: 19,
    DRAFT_20: 20
};

export const BMP_V4_TLV_DRAFT_NAME = {
    [BMP_V4_TLV_DRAFT.DRAFT_19]: 'draft-19',
    [BMP_V4_TLV_DRAFT.DRAFT_20]: 'draft-20'
};

export const BMP_PEER_TYPE = {
    GLOBAL: 0,
    L3VPN: 1,
    LOCAL: 2,
    LOCAL_RIB: 3
};

// BMP peer flags, 需要和后台定义保持一致, 后台会
// 直接使用这个值处理
export const BMP_SESSION_FLAGS = {
    IPV6: 0x80, // V 位: 使用 IPv6 地址
    POST_POLICY: 0x40, // P 位: Adj-RIB-In 是策略后导出的（post-policy）
    AS_PATH: 0x20, // L 位: 表示 AS_PATH
    ADJ_RIB_OUT: 0x10, // O 位: Adj-RIB-Out
    FILTERED: 0x08, // F 位: Local-RIB filtered
    EXTENDED_FLAGS: 0x01 // X 位: Extended Flags TLV carries effective flags
};

export const BMP_LOC_RIB_FLAGS = {
    FILTERED: 0x80
};

// 需要和后台定义保持一致, 后台会
// 直接使用这个值处理
export const BMP_SESSION_STATE = {
    PEER_UP: 0,
    PEER_DOWN: 1
};

// BMP route update types, 需要和后台定义保持一致, 后台会
// 直接使用这个值处理
export const BMP_ROUTE_UPDATE_TYPE = {
    ROUTE_DELETE: 0,
    ROUTE_UPDATE: 1
};

export const BMP_SESSION_TYPE_NAME = {
    [BMP_PEER_TYPE.GLOBAL]: 'Global',
    [BMP_PEER_TYPE.L3VPN]: 'L3VPN',
    [BMP_PEER_TYPE.LOCAL]: 'Local',
    [BMP_PEER_TYPE.LOCAL_RIB]: 'Local RIB'
};

export const BMP_SESSION_FLAGS_NAME = {
    [BMP_SESSION_FLAGS.IPV6]: 'IPv6',
    [BMP_SESSION_FLAGS.POST_POLICY]: 'Post Policy',
    [BMP_SESSION_FLAGS.AS_PATH]: 'AS Path',
    [BMP_SESSION_FLAGS.ADJ_RIB_OUT]: 'Adj RIB Out',
    [BMP_SESSION_FLAGS.FILTERED]: 'Filtered',
    [BMP_SESSION_FLAGS.EXTENDED_FLAGS]: 'Extended Flags'
};

export const BMP_LOC_RIB_FLAGS_NAME = {
    [BMP_LOC_RIB_FLAGS.FILTERED]: 'Filtered'
};

export const BMP_SESSION_STATE_NAME = {
    [BMP_SESSION_STATE.PEER_UP]: 'Peer Up',
    [BMP_SESSION_STATE.PEER_DOWN]: 'Peer Down'
};

export const BMP_BGP_RIB_TYPE = {
    PRE_ADJ_RIB_IN: 1,
    ADJ_RIB_IN: 2,
    AS_PATH: 3,
    ADJ_RIB_OUT: 4,
    POST_ADJ_RIB_OUT: 5
};

export const BMP_BGP_RIB_TYPE_NAME = {
    [BMP_BGP_RIB_TYPE.PRE_ADJ_RIB_IN]: 'Pre Adj RIB In',
    [BMP_BGP_RIB_TYPE.ADJ_RIB_IN]: 'Adj RIB In',
    [BMP_BGP_RIB_TYPE.AS_PATH]: 'AS Path',
    [BMP_BGP_RIB_TYPE.ADJ_RIB_OUT]: 'Adj RIB Out',
    [BMP_BGP_RIB_TYPE.POST_ADJ_RIB_OUT]: 'Post Adj RIB Out'
};

export const BMP_TLV_TYPE = {
    SEQUENCE_NUMBER: 1,
    EXTENDED_FLAGS: 2,
    TIMESTAMP: 3
};

export const BMP_ROUTE_MONITORING_TLV_TYPE = {
    ...BMP_TLV_TYPE,
    GROUP: 4,
    VRF_TABLE_NAME: 5,
    STATELESS_PARSING: 6,
    BGP_MESSAGE: 7
};

export const BMP_ROUTE_MONITORING_TLV_TYPE_LEGACY = {
    STATELESS_PARSING: 1,
    GROUP: 2,
    VRF_TABLE_NAME: 3,
    BGP_MESSAGE: 4
};

export const BMP_STATS_REPORT_TLV_TYPE = {
    STATS: 1,
    ...BMP_TLV_TYPE
};

export const BMP_PEER_DOWN_REASON = {
    LOCAL_SYSTEM_CLOSED_WITH_NOTIFICATION: 1,
    LOCAL_SYSTEM_CLOSED_NO_NOTIFICATION: 2,
    REMOTE_SYSTEM_CLOSED_WITH_NOTIFICATION: 3,
    REMOTE_SYSTEM_CLOSED_NO_NOTIFICATION: 4,
    PEER_DE_CONFIGURED: 5,
    LOCAL_SYSTEM_CLOSED_WITH_TLV: 6
};

export const BMP_PEER_DOWN_REASON_NAME = {
    [BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_NOTIFICATION]: 'Local Notification',
    [BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_NO_NOTIFICATION]: 'Local No Notification',
    [BMP_PEER_DOWN_REASON.REMOTE_SYSTEM_CLOSED_WITH_NOTIFICATION]: 'Remote Notification',
    [BMP_PEER_DOWN_REASON.REMOTE_SYSTEM_CLOSED_NO_NOTIFICATION]: 'Remote No Notification',
    [BMP_PEER_DOWN_REASON.PEER_DE_CONFIGURED]: 'Peer De-configured',
    [BMP_PEER_DOWN_REASON.LOCAL_SYSTEM_CLOSED_WITH_TLV]: 'Local TLV'
};

export const getBmpVersionName = version => {
    if (!version) return '-';
    return `BMPv${version}`;
};

export const getBmpV4TlvDraftName = draft => {
    return BMP_V4_TLV_DRAFT_NAME[Number(draft)] || BMP_V4_TLV_DRAFT_NAME[BMP_V4_TLV_DRAFT.DRAFT_20];
};

export const getBmpFlagsName = flags => {
    if (flags === null || flags === undefined) return '-';
    const names = Object.entries(BMP_SESSION_FLAGS_NAME)
        .filter(([flag]) => (Number(flags) & Number(flag)) !== 0)
        .map(([, name]) => name);
    return names.length > 0 ? names.join(', ') : 'None';
};

export const getBmpLocRibFlagsName = flags => {
    if (flags === null || flags === undefined) return '-';
    const names = Object.entries(BMP_LOC_RIB_FLAGS_NAME)
        .filter(([flag]) => (Number(flags) & Number(flag)) !== 0)
        .map(([, name]) => name);
    return names.length > 0 ? names.join(', ') : 'None';
};

// BMP Statistics Types (RFC 7854 Section 4.8)
export const BMP_STATS_TYPE = {
    NUM_PREFIXES_REJECTED: 0,
    NUM_DUPLICATE_PREFIX_ADVERTISEMENTS: 1,
    NUM_DUPLICATE_WITHDRAWS: 2,
    NUM_UPDATES_INVALIDATED_CLUSTER_LIST: 3,
    NUM_UPDATES_INVALIDATED_AS_PATH_LOOP: 4,
    NUM_UPDATES_INVALIDATED_ORIGINATOR_ID: 5,
    NUM_UPDATES_INVALIDATED_AS_CONFED_LOOP: 6,
    NUM_ADJ_RIB_IN: 7,
    NUM_LOC_RIB: 8,
    NUM_PER_AFI_SAFI_ADJ_RIB_IN: 9,
    NUM_PER_AFI_SAFI_LOC_RIB: 10,
    NUM_UPDATES_TREATED_AS_WITHDRAW: 11,
    NUM_PREFIXES_TREATED_AS_WITHDRAW: 12,
    NUM_DUPLICATE_UPDATE_MESSAGES: 13,
    NUM_PRE_POLICY_ADJ_RIB_OUT: 14,
    NUM_POST_POLICY_ADJ_RIB_OUT: 15,
    NUM_PER_AFI_SAFI_PRE_POLICY_ADJ_RIB_OUT: 16,
    NUM_PER_AFI_SAFI_POST_POLICY_ADJ_RIB_OUT: 17
};

export const BMP_STATS_TYPE_NAME = {
    [BMP_STATS_TYPE.NUM_PREFIXES_REJECTED]: '拒绝的前缀数',
    [BMP_STATS_TYPE.NUM_DUPLICATE_PREFIX_ADVERTISEMENTS]: '重复的前缀通告数',
    [BMP_STATS_TYPE.NUM_DUPLICATE_WITHDRAWS]: '重复的撤销数',
    [BMP_STATS_TYPE.NUM_UPDATES_INVALIDATED_CLUSTER_LIST]: '因 Cluster List 无效的更新数',
    [BMP_STATS_TYPE.NUM_UPDATES_INVALIDATED_AS_PATH_LOOP]: '因 AS Path 环路无效的更新数',
    [BMP_STATS_TYPE.NUM_UPDATES_INVALIDATED_ORIGINATOR_ID]: '因 Originator ID 无效的更新数',
    [BMP_STATS_TYPE.NUM_UPDATES_INVALIDATED_AS_CONFED_LOOP]: '因 AS Confed 环路无效的更新数',
    [BMP_STATS_TYPE.NUM_ADJ_RIB_IN]: 'Adj-RIB-In 中的路由数',
    [BMP_STATS_TYPE.NUM_LOC_RIB]: 'Loc-RIB 中的路由数',
    [BMP_STATS_TYPE.NUM_PER_AFI_SAFI_ADJ_RIB_IN]: '每 AFI/SAFI Adj-RIB-In 中的路由数',
    [BMP_STATS_TYPE.NUM_PER_AFI_SAFI_LOC_RIB]: '每 AFI/SAFI Loc-RIB 中的路由数',
    [BMP_STATS_TYPE.NUM_UPDATES_TREATED_AS_WITHDRAW]: '被视为撤销的更新数',
    [BMP_STATS_TYPE.NUM_PREFIXES_TREATED_AS_WITHDRAW]: '被视为撤销的前缀数',
    [BMP_STATS_TYPE.NUM_DUPLICATE_UPDATE_MESSAGES]: '重复的更新消息数',
    [BMP_STATS_TYPE.NUM_PRE_POLICY_ADJ_RIB_OUT]: 'Pre-Policy Adj-RIB-Out 中的路由数',
    [BMP_STATS_TYPE.NUM_POST_POLICY_ADJ_RIB_OUT]: 'Post-Policy Adj-RIB-Out 中的路由数',
    [BMP_STATS_TYPE.NUM_PER_AFI_SAFI_PRE_POLICY_ADJ_RIB_OUT]: '每 AFI/SAFI Pre-Policy Adj-RIB-Out 中的路由数',
    [BMP_STATS_TYPE.NUM_PER_AFI_SAFI_POST_POLICY_ADJ_RIB_OUT]: '每 AFI/SAFI Post-Policy Adj-RIB-Out 中的路由数'
};

export const BMP_LOC_RIB_STATS_TYPE_NAME = {
    [BMP_STATS_TYPE.NUM_LOC_RIB]: 'Loc-RIB 中的路由数',
    [BMP_STATS_TYPE.NUM_PER_AFI_SAFI_LOC_RIB]: '每 AFI/SAFI Loc-RIB 中的路由数'
};

// Default Values
export const DEFAULT_VALUES = {
    DEFAULT_BMP_PORT: '1790',
    DEFAULT_BMP_V4_TLV_DRAFT: BMP_V4_TLV_DRAFT.DRAFT_20,
    DEFAULT_GRPC_PORT: 50051
};

export const BMP_EVENT_PAGE_ID = {
    PAGE_ID_BMP_CONFIG: 1,
    PAGE_ID_BMP_BGP_SESSION: 2,
    PAGE_ID_BMP_BGP_LOC_RIB: 3,
    PAGE_ID_BMP_BGP_SESSION_STATIS_REPORT: 4,
    PAGE_ID_BMP_BGP_LOC_RIB_STATIS_REPORT: 5
};
