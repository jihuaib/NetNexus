import { IP_TYPE } from './bgpConst';

// 默认值
export const DEFAULT_VALUES = {
    DEFAULT_RPKI_PORT: '1280',
    DEFAULT_RPKI_ASN: '65535',
    DEFAULT_RPKI_IPV4: '1.1.1.1',
    DEFAULT_RPKI_IPV6: '2001:db8::1',
    DEFAULT_RPKI_MASKV4: '24',
    DEFAULT_RPKI_MASKV6: '128',
    DEFAULT_RPKI_MAX_LENGTHV4: '32',
    DEFAULT_RPKI_MAX_LENGTHV6: '128',
    DEFAULT_RPKI_IP_TYPE: IP_TYPE.IPV4,
    // Router Key (v1+) - SKI 是 20 字节 hex（40 字符），SPKI 是 DER 编码 hex
    DEFAULT_RPKI_RK_SKI: '0123456789ABCDEF0123456789ABCDEF01234567',
    DEFAULT_RPKI_RK_SPKI: '3059301306072A8648CE3D020106082A8648CE3D03010703420004',
    // ASPA (v2+)
    DEFAULT_RPKI_ASPA_CUSTOMER_ASN: '65000',
    DEFAULT_RPKI_ASPA_PROVIDER_ASNS: '65001,65002',
    DEFAULT_RPKI_ASPA_AFI_FLAGS: 3, // 0x01 IPv4 | 0x02 IPv6
    DEFAULT_RPKI_MAX_PROTOCOL_VERSION: 2
};

export const RPKI_EVENT_PAGE_ID = {
    PAGE_ID_RPKI_CONFIG: 1,
    PAGE_ID_RPKI_ROA_CONFIG: 'rpki-roa-config-runtime',
    PAGE_ID_RPKI_ASPA_CONFIG: 'rpki-aspa-config-runtime'
};

export const RPKI_RUNTIME_CHANGED_EVENT = 'rpki:runtimeChanged';

// RPKI Protocol Version（与后端 RPKI_PROTOCOL_VERSION 对齐）
export const RPKI_PROTOCOL_VERSION = {
    V0: 0,
    V1: 1,
    V2: 2
};

// ASPA AFI Flags
export const RPKI_ASPA_AFI_FLAGS = {
    IPV4: 0x01,
    IPV6: 0x02,
    BOTH: 0x03
};

// ASPA PDU 编码格式（与后端 RPKI_ASPA_FORMAT 对齐）
// LATEST = current draft-ietf-sidrops-8210bis format (byte3=zero, 无 Provider Count)
// LEGACY = draft-ietf-sidrops-8210bis-10 风格 (body 含 Flags/AFI Flags/Provider AS Count，华为 VRP 兼容)
export const RPKI_ASPA_FORMAT = {
    LATEST: 'latest',
    LEGACY: 'legacy'
};
