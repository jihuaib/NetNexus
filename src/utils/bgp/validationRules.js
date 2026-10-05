import {
    BGP_MVPN_ROUTE_TYPE,
    BGP_QP_ROUTE_GROWTH_MODE,
    BGP_QP_BSID_MODE,
    BGP_LABEL_MODE,
    BGP_MPLS_LABEL_MAX,
    BGP_SRV6_SID_MODE,
    BGP_SRV6_ENDPOINT_BEHAVIOR,
    BGP_ADDR_FAMILY
} from '../../const/bgpConst';
import ipaddr from 'ipaddr.js';
import { REGEX, validators } from '../validationCommon';

export const isValidMplsLabel = value => {
    if (!REGEX.number.test(`${value}`)) {
        return false;
    }
    const num = Number(value);
    return Number.isInteger(num) && num >= 0 && num <= BGP_MPLS_LABEL_MAX;
};

const IPV6_MAX_BIGINT = (1n << 128n) - 1n;
const ADD_PATH_GENERATION_COUNT_MAX = 255;

const ipv6ToBigIntOrNull = value => {
    try {
        const address = ipaddr.parse(`${value}`);
        if (address.kind() !== 'ipv6') {
            return null;
        }
        return address.toByteArray().reduce((result, byte) => (result << 8n) + BigInt(byte), 0n);
    } catch (_) {
        return null;
    }
};

export const isValidRd = value => {
    if (!value || typeof value !== 'string') return false;

    // 分割 AS:nn 或 IP:nn
    const parts = value.split(':');
    if (parts.length !== 2) return false;

    const [part1, part2] = parts;

    // 验证第二部分是否为数字
    if (!REGEX.number.test(part2)) return false;
    const num2 = Number(part2);

    // 情况 1: IP:nn (Type 1)
    // part1 是 IPv4 地址
    if (REGEX.ipv4.test(part1)) {
        // nn 必须是 0-65535
        return num2 >= 0 && num2 <= 65535;
    }

    // 情况 2: AS:nn (Type 0) 或 AS4:nn (Type 2)
    // part1 必须是数字
    if (!REGEX.number.test(part1)) return false;
    const num1 = Number(part1);

    // AS2:nn (Type 0) -> AS (0-65535) : nn (0-4294967295)
    if (num1 >= 0 && num1 <= 65535) {
        return num2 >= 0 && num2 <= 4294967295;
    }

    // AS4:nn (Type 2) -> AS (0-4294967295) : nn (0-65535)
    if (num1 > 65535 && num1 <= 4294967295) {
        return num2 >= 0 && num2 <= 65535;
    }

    return false;
};

export const isValidRtList = value => {
    if (!value) return true;

    if (typeof value !== 'string') return false;

    const rts = value.trim().split(/\s+/);
    if (rts.length === 0) return false;

    return rts.every(rt => isValidRd(rt));
};

/**
 * 创建BGP配置验证规则
 */
export const createBgpConfigValidationRules = () => {
    return {
        localAs: [
            {
                required: true,
                message: '请输入Peer AS'
            },
            {
                validator: validators.asn,
                message: '请输入有效的ASN'
            }
        ],
        routerId: [
            {
                required: true,
                message: '请输入Router ID'
            },
            {
                validator: validators.ipv4,
                message: '请输入有效的IPv4地址'
            }
        ],
        port: [
            {
                required: true,
                message: '请输入监听端口'
            },
            {
                validator: value => {
                    const normalized = String(value ?? '').trim();
                    if (!/^\d+$/.test(normalized)) {
                        return false;
                    }
                    const port = Number(normalized);
                    return port >= 1 && port <= 65535;
                },
                message: '端口范围 1-65535'
            }
        ]
    };
};

export const createBgpPeerIpv4ConfigValidationRules = () => {
    return {
        peerIp: [
            {
                required: true,
                message: '请输入Peer IP'
            },
            {
                validator: validators.ipv4,
                message: '请输入有效的IPv4地址'
            }
        ],
        peerAs: [
            {
                required: true,
                message: '请输入Peer AS'
            },
            {
                validator: validators.asn,
                message: '请输入有效的ASN'
            }
        ],
        holdTime: [
            {
                required: true,
                message: '请输入Hold Time'
            },
            {
                validator: validators.number,
                message: '请输入数字'
            }
        ]
    };
};

export const createBgpPeerIpv6ConfigValidationRules = () => {
    return {
        peerIpv6: [
            {
                required: true,
                message: '请输入Peer IP'
            },
            {
                validator: validators.ipv6,
                message: '请输入有效的IPv6地址'
            }
        ],
        peerIpv6As: [
            {
                required: true,
                message: '请输入Peer AS'
            },
            {
                validator: validators.asn,
                message: '请输入有效的ASN'
            }
        ],
        holdTimeIpv6: [
            {
                required: true,
                message: '请输入Hold Time'
            },
            {
                validator: validators.number,
                message: '请输入数字'
            }
        ]
    };
};

export const createBgpIpv4RouteConfigValidationRules = () => {
    return {
        prefix: [
            {
                required: true,
                message: '请输入前缀'
            },
            {
                validator: validators.ipv4,
                message: '请输入有效的IPv4地址'
            }
        ],
        mask: [
            {
                required: true,
                message: '请输入掩码'
            },
            {
                validator: validators.ipv4Mask,
                message: '请输入有效的IPv4掩码'
            }
        ],
        count: [
            {
                required: true,
                message: '请输入数量'
            }
        ],
        addPathCount: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_UNC || !formData.addPathEnabled) {
                        return true;
                    }
                    const count = Number(value);
                    return REGEX.number.test(`${value}`) && count > 0 && count <= ADD_PATH_GENERATION_COUNT_MAX;
                },
                message: `ADD-PATH数量范围为 1 ~ ${ADD_PATH_GENERATION_COUNT_MAX}`
            }
        ],
        rt: [
            {
                validator: value => isValidRtList(value),
                message: 'RT格式错误(支持空格分隔多个值)'
            }
        ],
        labelMode: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) return true;
                    return Object.values(BGP_LABEL_MODE).includes(value);
                },
                message: '请选择标签模式'
            }
        ],
        labelStart: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) return true;
                    return isValidMplsLabel(value);
                },
                message: `标签范围为 0 ~ ${BGP_MPLS_LABEL_MAX}`
            }
        ],
        labelStep: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) return true;
                    if (formData.labelMode !== BGP_LABEL_MODE.INCREMENT) return true;
                    return REGEX.number.test(`${value}`) && Number(value) > 0;
                },
                message: '标签步长必须为正整数'
            },
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_LABEL_UNICAST) return true;
                    if (formData.labelMode !== BGP_LABEL_MODE.INCREMENT) return true;
                    const start = Number(formData.labelStart);
                    const step = Number(value);
                    const count = Number(formData.count);
                    if (![start, step, count].every(Number.isFinite) || count <= 0) return true;
                    return start + (Math.floor(count) - 1) * step <= BGP_MPLS_LABEL_MAX;
                },
                message: '标签递增超出20bit范围'
            }
        ],
        srv6SidMode: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_UNC || !formData.srv6Enabled) {
                        return true;
                    }
                    return Object.values(BGP_SRV6_SID_MODE).includes(value);
                },
                message: '请选择SRv6 SID模式'
            }
        ],
        srv6Sid: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_UNC || !formData.srv6Enabled) {
                        return true;
                    }
                    return ipv6ToBigIntOrNull(value) !== null;
                },
                message: '请输入有效的SRv6 SID IPv6地址'
            }
        ],
        srv6SidStep: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_UNC || !formData.srv6Enabled) {
                        return true;
                    }
                    if (formData.srv6SidMode !== BGP_SRV6_SID_MODE.INCREMENT) return true;
                    return REGEX.number.test(`${value}`) && BigInt(value) > 0n;
                },
                message: 'SRv6 SID步长必须为正整数'
            },
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_UNC || !formData.srv6Enabled) {
                        return true;
                    }
                    if (formData.srv6SidMode !== BGP_SRV6_SID_MODE.INCREMENT) return true;
                    const sidBase = ipv6ToBigIntOrNull(formData.srv6Sid);
                    if (sidBase === null || !REGEX.number.test(`${value}`)) return true;
                    const addPathCount =
                        formData.addPathEnabled && REGEX.number.test(`${formData.addPathCount}`)
                            ? Number(formData.addPathCount)
                            : 1;
                    const count = Number(formData.count) * addPathCount;
                    if (!Number.isFinite(count) || count <= 0) return true;
                    return sidBase + BigInt(Math.floor(count) - 1) * BigInt(value) <= IPV6_MAX_BIGINT;
                },
                message: 'SRv6 SID递增超出IPv6地址范围'
            }
        ],
        srv6EndpointBehavior: [
            {
                validator: (value, formData) => {
                    if (Number(formData.addressFamily) !== BGP_ADDR_FAMILY.IPV4_UNC || !formData.srv6Enabled) {
                        return true;
                    }
                    return Object.values(BGP_SRV6_ENDPOINT_BEHAVIOR).includes(Number(value));
                },
                message: '请选择SRv6 Endpoint Behavior'
            }
        ]
    };
};

export const createBgpIpv6RouteConfigValidationRules = () => {
    return {
        prefix: [
            {
                required: true,
                message: '请输入前缀'
            },
            {
                validator: validators.ipv6,
                message: '请输入有效的IPv6地址'
            }
        ],
        mask: [
            {
                required: true,
                message: '请输入掩码'
            },
            {
                validator: validators.ipv6Mask,
                message: '请输入有效的IPv6掩码'
            }
        ],
        count: [
            {
                required: true,
                message: '请输入数量'
            }
        ],
        addPathCount: [
            {
                validator: (value, formData) => {
                    if (!formData.addPathEnabled) return true;
                    const count = Number(value);
                    return REGEX.number.test(`${value}`) && count > 0 && count <= ADD_PATH_GENERATION_COUNT_MAX;
                },
                message: `ADD-PATH数量范围为 1 ~ ${ADD_PATH_GENERATION_COUNT_MAX}`
            }
        ],
        rt: [
            {
                validator: value => isValidRtList(value),
                message: 'RT格式错误(支持空格分隔多个值)'
            }
        ],
        srv6SidMode: [
            {
                validator: (value, formData) => {
                    if (!formData.srv6Enabled) return true;
                    return Object.values(BGP_SRV6_SID_MODE).includes(value);
                },
                message: '请选择SRv6 SID模式'
            }
        ],
        srv6Sid: [
            {
                validator: (value, formData) => {
                    if (!formData.srv6Enabled) return true;
                    return ipv6ToBigIntOrNull(value) !== null;
                },
                message: '请输入有效的SRv6 SID IPv6地址'
            }
        ],
        srv6SidStep: [
            {
                validator: (value, formData) => {
                    if (!formData.srv6Enabled) return true;
                    if (formData.srv6SidMode !== BGP_SRV6_SID_MODE.INCREMENT) return true;
                    return REGEX.number.test(`${value}`) && BigInt(value) > 0n;
                },
                message: 'SRv6 SID步长必须为正整数'
            },
            {
                validator: (value, formData) => {
                    if (!formData.srv6Enabled) return true;
                    if (formData.srv6SidMode !== BGP_SRV6_SID_MODE.INCREMENT) return true;
                    const sidBase = ipv6ToBigIntOrNull(formData.srv6Sid);
                    if (sidBase === null || !REGEX.number.test(`${value}`)) return true;
                    const addPathCount =
                        formData.addPathEnabled && REGEX.number.test(`${formData.addPathCount}`)
                            ? Number(formData.addPathCount)
                            : 1;
                    const count = Number(formData.count) * addPathCount;
                    if (!Number.isFinite(count) || count <= 0) return true;
                    return sidBase + BigInt(Math.floor(count) - 1) * BigInt(value) <= IPV6_MAX_BIGINT;
                },
                message: 'SRv6 SID递增超出IPv6地址范围'
            }
        ],
        srv6EndpointBehavior: [
            {
                validator: (value, formData) => {
                    if (!formData.srv6Enabled) return true;
                    return Object.values(BGP_SRV6_ENDPOINT_BEHAVIOR).includes(Number(value));
                },
                message: '请选择SRv6 Endpoint Behavior'
            }
        ]
    };
};

export const createBgpMvpnRouteConfigValidationRules = () => {
    return {
        rd: [
            {
                required: true,
                message: '请输入RD'
            },
            {
                validator: value => isValidRd(value),
                message: 'RD格式错误(支持 IP:nn, AS2:nn, AS4:nn)'
            }
        ],
        rt: [
            {
                required: true,
                message: '请输入RT'
            },
            {
                validator: value => isValidRtList(value),
                message: 'RT格式错误(支持空格分隔多个值, 格式同RD)'
            }
        ],
        count: [
            {
                required: true,
                message: '请输入数量'
            },
            {
                validator: validators.number,
                message: '请输入有效的数字'
            }
        ],
        originatingRouterIp: [
            {
                validator: validators.conditionalRequired(formData =>
                    [
                        BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD,
                        BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                        BGP_MVPN_ROUTE_TYPE.LEAF_AD
                    ].includes(formData.routeType)
                ),
                message: '请输入Originating Router IP'
            },
            {
                validator: (value, formData) => {
                    if (
                        value &&
                        [
                            BGP_MVPN_ROUTE_TYPE.INTRA_AS_I_PMSI_AD,
                            BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                            BGP_MVPN_ROUTE_TYPE.LEAF_AD
                        ].includes(formData.routeType)
                    ) {
                        return validators.ipv4(value);
                    }
                    return true;
                },
                message: '请输入有效的IPv4地址'
            }
        ],
        sourceAs: [
            {
                validator: validators.conditionalRequired(formData =>
                    [
                        BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD,
                        BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
                        BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                    ].includes(formData.routeType)
                ),
                message: '请输入Source AS'
            },
            {
                validator: (value, formData) => {
                    if (
                        value &&
                        [
                            BGP_MVPN_ROUTE_TYPE.INTER_AS_I_PMSI_AD,
                            BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
                            BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                        ].includes(formData.routeType)
                    ) {
                        return validators.asn(value);
                    }
                    return true;
                },
                message: '请输入有效的ASN'
            }
        ],
        sourceIp: [
            {
                validator: validators.conditionalRequired(formData =>
                    [
                        BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                        BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD,
                        BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
                        BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                    ].includes(formData.routeType)
                ),
                message: '请输入Source IP'
            },
            {
                validator: (value, formData) => {
                    if (
                        value &&
                        [
                            BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                            BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD,
                            BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
                            BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                        ].includes(formData.routeType)
                    ) {
                        return validators.ipv4(value);
                    }
                    return true;
                },
                message: '请输入有效的IPv4地址'
            }
        ],
        groupIp: [
            {
                validator: validators.conditionalRequired(formData =>
                    [
                        BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                        BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD,
                        BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
                        BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                    ].includes(formData.routeType)
                ),
                message: '请输入Group IP'
            },
            {
                validator: (value, formData) => {
                    if (
                        value &&
                        [
                            BGP_MVPN_ROUTE_TYPE.S_PMSI_AD,
                            BGP_MVPN_ROUTE_TYPE.SOURCE_ACTIVE_AD,
                            BGP_MVPN_ROUTE_TYPE.SHARED_TREE_JOIN,
                            BGP_MVPN_ROUTE_TYPE.SOURCE_TREE_JOIN
                        ].includes(formData.routeType)
                    ) {
                        return validators.ipv4(value);
                    }
                    return true;
                },
                message: '请输入有效的IPv4地址'
            }
        ]
    };
};

const QP_MAX_DQPN = 0xffffff;

const isPositiveInteger = value => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0;
};

const isNonNegativeIntegerInRange = (value, max) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= max;
};

const qpRouteGrowthIncludesDqpn = formData =>
    !formData.routeGrowthMode ||
    formData.routeGrowthMode === BGP_QP_ROUTE_GROWTH_MODE.DQPN ||
    formData.routeGrowthMode === BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN;

const qpRouteGrowthIncludesIp = formData =>
    !formData.routeGrowthMode ||
    formData.routeGrowthMode === BGP_QP_ROUTE_GROWTH_MODE.IP ||
    formData.routeGrowthMode === BGP_QP_ROUTE_GROWTH_MODE.IP_DQPN;

const createBgpQpRouteConfigValidationRules = (prefixValidator, maskValidator, prefixMessage, maskMessage) => {
    return {
        prefix: [
            {
                required: true,
                message: '请输入前缀'
            },
            {
                validator: prefixValidator,
                message: prefixMessage
            }
        ],
        mask: [
            {
                required: true,
                message: '请输入掩码'
            },
            {
                validator: maskValidator,
                message: maskMessage
            }
        ],
        count: [
            {
                validator: isPositiveInteger,
                message: '请输入数量'
            }
        ],
        ipStep: [
            {
                validator: (value, formData) => {
                    if (!qpRouteGrowthIncludesIp(formData)) return true;
                    return isPositiveInteger(value);
                },
                message: 'IP步长必须为正整数'
            }
        ],
        startDqpn: [
            {
                required: true,
                message: '请输入起始DQPN'
            },
            {
                validator: value => isNonNegativeIntegerInRange(value, QP_MAX_DQPN),
                message: 'DQPN范围为 0 ~ 16777215（24bit）'
            }
        ],
        dqpnStep: [
            {
                validator: (value, formData) => {
                    if (!qpRouteGrowthIncludesDqpn(formData)) return true;
                    return isPositiveInteger(value);
                },
                message: 'DQPN步长必须为正整数'
            },
            {
                validator: (value, formData) => {
                    if (!qpRouteGrowthIncludesDqpn(formData)) return true;
                    const count = Number(formData.count);
                    const start = Number(formData.startDqpn);
                    const step = Number(value);
                    if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(start) || !Number.isInteger(step)) {
                        return false;
                    }
                    return start + (count - 1) * step <= QP_MAX_DQPN;
                },
                message: 'DQPN连续生成超出 24bit 范围'
            }
        ],
        bsid: [
            {
                required: true,
                message: '请输入BSID'
            },
            {
                validator: validators.ipv6,
                message: '请输入有效的IPv6地址'
            }
        ],
        bsidStep: [
            {
                validator: (value, formData) => {
                    if (formData.bsidMode !== BGP_QP_BSID_MODE.CONTINUOUS) return true;
                    return isPositiveInteger(value);
                },
                message: 'BSID步长必须为正整数'
            }
        ]
    };
};

export const createBgpIpv4QpRouteConfigValidationRules = () =>
    createBgpQpRouteConfigValidationRules(
        validators.ipv4,
        validators.ipv4Mask,
        '请输入有效的IPv4地址',
        '请输入有效的IPv4掩码'
    );

export const createBgpIpv6QpRouteConfigValidationRules = () =>
    createBgpQpRouteConfigValidationRules(
        validators.ipv6,
        validators.ipv6Mask,
        '请输入有效的IPv6地址',
        '请输入有效的IPv6掩码'
    );
