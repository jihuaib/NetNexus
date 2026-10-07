import ipaddr from 'ipaddr.js';

const FIELD_LABELS = {
    origin: 'Origin',
    asPath: 'AS Path',
    wireAsPath: '报文 AS Path',
    as4Path: 'AS4 Path',
    med: 'MED',
    localPref: 'Local Preference',
    nextHop: '下一跳',
    communities: '标准 Community',
    largeCommunities: 'Large Community',
    extendedCommunities: 'Extended Community',
    otc: 'OTC',
    prefixSid: 'Prefix SID',
    pathAttributes: '报文路径属性',
    unknownAttributes: '未知属性',
    attrId: '属性标识',
    attrRefCount: '属性引用数',
    addrFamilyType: '地址族',
    addressFamily: '地址族',
    afi: 'AFI',
    safi: 'SAFI',
    ip: '前缀 / 地址',
    prefix: '前缀',
    mask: '掩码长度',
    prefixLength: '前缀长度',
    rd: 'RD',
    rdRaw: '原始 RD',
    pathId: 'Path ID',
    labels: 'MPLS 标签',
    routeType: '路由类型',
    rawNlri: '原始 NLRI',
    nlriDetail: 'NLRI 明细',
    routeTlvs: '路由 TLV',
    routeTlvCount: 'TLV 数量',
    parseStatus: '解析状态',
    pathStatus: 'Path Marking 状态值',
    pathStatusNames: 'Path Marking 状态',
    pathStatusText: 'Path Marking 状态说明',
    pathStatusUnknownBits: '未知 Path Marking 位',
    pathStatusReason: 'Path Marking 原因值',
    pathStatusReasonName: 'Path Marking 原因',
    pathStatusReasonText: 'Path Marking 原因说明',
    pathStatusReasons: 'Path Marking 原因明细',
    routeState: '路由状态',
    scopeKind: 'Scope 类型',
    ribType: 'RIB 视图',
    scopeState: 'Scope 状态',
    ribEpoch: '路由 Epoch',
    currentEpoch: '当前 Epoch',
    eorEpoch: 'EOR Epoch',
    cleanupPendingEpoch: '待清理 Epoch',
    staleEpoch: '过期 Epoch',
    staleReason: '过期原因',
    scopeStaleReason: 'Scope 过期原因',
    staleAt: '过期时间',
    refreshStartedAt: '刷新开始时间',
    firstSeenAt: '首次观测时间',
    lastSeenAt: '最后观测时间',
    sourceTimestampMs: '设备上报时间',
    routeKey: '路由键',
    canonicalRouteKey: '规范路由键',
    persistentRouteId: '路由标识',
    persistentScopeId: 'Scope 标识',
    persistentSourceId: '数据源标识',
    persistentConnectionId: '连接标识',
    ownerKey: '所属对象标识',
    peer: 'Peer / 实例',
    source: 'BMP 数据源',
    client: 'BMP Client',
    session: 'BGP 会话',
    instance: 'Loc-RIB 实例',
    flags: 'Flags',
    typeCode: '属性类型码',
    type: '类型',
    length: '长度',
    rawValueHex: '原始属性值（十六进制）',
    rawValueIncludesNlri: '原始值是否包含 NLRI',
    rawValueHexDescription: '原始属性值说明',
    headerLength: '属性头长度',
    nlriOmitted: 'NLRI 是否单独展示',
    errors: '错误',
    warnings: '告警',
    valid: '有效',
    value: '属性值'
};

const ATTRIBUTE_NAMES = {
    1: 'ORIGIN',
    2: 'AS_PATH',
    3: 'NEXT_HOP',
    4: 'MULTI_EXIT_DISC',
    5: 'LOCAL_PREF',
    6: 'ATOMIC_AGGREGATE',
    7: 'AGGREGATOR',
    8: 'COMMUNITIES',
    9: 'ORIGINATOR_ID',
    10: 'CLUSTER_LIST',
    14: 'MP_REACH_NLRI',
    15: 'MP_UNREACH_NLRI',
    16: 'EXTENDED_COMMUNITIES',
    17: 'AS4_PATH',
    18: 'AS4_AGGREGATOR',
    22: 'PMSI_TUNNEL',
    23: 'TUNNEL_ENCAPSULATION',
    25: 'IPV6_EXTENDED_COMMUNITIES',
    29: 'BGP_LS',
    32: 'LARGE_COMMUNITIES',
    35: 'OTC',
    40: 'PREFIX_SID'
};

const ATTRIBUTE_KEYS = new Set([
    'origin',
    'asPath',
    'wireAsPath',
    'as4Path',
    'asPathSegments',
    'med',
    'localPref',
    'communities',
    'largeCommunities',
    'extendedCommunities',
    'otc',
    'nextHop',
    'prefixSid',
    'atomicAggregate',
    'aggregator',
    'as4Aggregator',
    'originatorId',
    'clusterList',
    'mpReachNlri',
    'mpUnreachNlri',
    'mpReach',
    'mpUnreach',
    'pmsiTunnel',
    'tunnelEncapsulation'
]);
const NLRI_KEYS = new Set([
    'addrFamilyType',
    'addressFamily',
    'afi',
    'safi',
    'ip',
    'prefix',
    'mask',
    'prefixLength',
    'rd',
    'rdRaw',
    'pathId',
    'labels',
    'routeType',
    'rawNlri',
    'nlriDetail'
]);
const LIFECYCLE_KEYS = new Set([
    'attrId',
    'attrRefCount',
    'routeState',
    'scopeKind',
    'ribType',
    'scopeState',
    'ribEpoch',
    'currentEpoch',
    'eorEpoch',
    'cleanupPendingEpoch',
    'staleEpoch',
    'staleReason',
    'scopeStaleReason',
    'staleAt',
    'refreshStartedAt',
    'firstSeenAt',
    'lastSeenAt',
    'sourceTimestampMs',
    'routeKey',
    'canonicalRouteKey',
    'persistentRouteId',
    'persistentScopeId',
    'persistentSourceId',
    'persistentConnectionId',
    'ownerKey'
]);

export const getRouteDetailRecord = value =>
    value?.route && typeof value.route === 'object' && !Array.isArray(value.route) ? value.route : value || {};

export const formatRouteDetailPrefix = value => {
    const route = getRouteDetailRecord(value);
    const nlri = route.nlriDetail || {};
    const match = value?.match || {};
    const prefix = [
        match.displayPrefix,
        nlri.displayPrefix,
        nlri.formatted,
        match.routeIdentity,
        value?.routeIdentity,
        match.routePrefix,
        nlri.prefix,
        route.ip,
        route.prefix
    ]
        .filter(candidate => typeof candidate === 'string' || typeof candidate === 'number')
        .map(candidate => String(candidate).trim())
        .find(Boolean);
    if (!prefix) return '-';
    const afi = Number(value?.afi ?? route.afi);
    const safi = Number(value?.safi ?? route.safi);
    const routeType = String(route.routeType ?? nlri.routeType ?? nlri.type ?? '');
    const nonIp =
        afi === 25 ||
        afi === 16388 ||
        [5, 65, 70, 71, 72, 132, 133, 134].includes(safi) ||
        /evpn|flow.?spec|bgp.?ls|link.?state|mvpn|vpls|route.?target/iu.test(routeType);
    if (prefix.includes('/') || nonIp || !ipaddr.isValid(prefix)) return prefix;
    const rawMask = [nlri.prefixLength, nlri.length, route.mask, route.prefixLength].find(
        candidate => candidate !== null && candidate !== undefined && candidate !== ''
    );
    if (rawMask === undefined) return prefix;
    const mask = Number(rawMask);
    const maximum = ipaddr.parse(prefix).kind() === 'ipv4' ? 32 : 128;
    return Number.isInteger(mask) && mask >= 0 && mask <= maximum ? `${prefix}/${mask}` : prefix;
};

export const formatRouteDetailTimestamp = value => {
    if (value === null || value === undefined || value === '') return '-';
    const numeric = Number(value);
    const date = new Date(Number.isFinite(numeric) ? numeric : value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
};

export const formatRouteDetailValue = value => {
    if (value === null) return 'null';
    if (value === undefined) return '-';
    if (value === '') return '空字符串';
    if (typeof value === 'boolean') return value ? 'true（是）' : 'false（否）';
    if (Array.isArray(value)) return value.length ? value.map(formatRouteDetailValue).join(', ') : '空数组';
    if (typeof value === 'object') {
        const count = Object.keys(value).length;
        return count ? `对象（${count} 个字段）` : '空对象';
    }
    return String(value);
};

export function flattenRouteDetailFields(value, prefix = '', group = '') {
    const rows = [];
    const ancestors = new Set();
    const visit = (entry, field) => {
        const leaf = field
            .split('.')
            .pop()
            .replace(/\[\d+\]$/u, '');
        const append = (type, text) =>
            rows.push({ key: field, field, group, label: FIELD_LABELS[leaf] || leaf || '值', type, value: text });
        if (entry && typeof entry === 'object') {
            if (ancestors.has(entry)) {
                append('循环引用', '循环引用');
                return;
            }
            const bytes =
                entry.type === 'Buffer' && Array.isArray(entry.data)
                    ? entry.data
                    : ArrayBuffer.isView(entry)
                      ? Array.from(new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength))
                      : null;
            if (bytes) {
                append('二进制', bytes.map(byte => Number(byte).toString(16).padStart(2, '0')).join(' '));
                return;
            }
            const entries = Array.isArray(entry)
                ? entry.map((item, index) => [`[${index}]`, item])
                : Object.entries(entry);
            if (entries.length === 0) {
                append(Array.isArray(entry) ? '数组' : '对象', formatRouteDetailValue(entry));
                return;
            }
            ancestors.add(entry);
            entries.forEach(([key, item]) =>
                visit(item, field ? `${field}${key.startsWith('[') ? '' : '.'}${key}` : key)
            );
            ancestors.delete(entry);
            return;
        }
        const type = entry === null ? 'null' : typeof entry;
        let text = /(?:At|TimestampMs)$/u.test(leaf)
            ? formatRouteDetailTimestamp(entry)
            : formatRouteDetailValue(entry);
        if (field.startsWith('pathAttributes[') && leaf === 'flags' && Number.isInteger(entry)) {
            const names = [
                [0x80, '可选'],
                [0x40, '可传递'],
                [0x20, '部分'],
                [0x10, '扩展长度']
            ]
                .filter(([bit]) => (entry & bit) !== 0)
                .map(([, name]) => name);
            text = `${entry} · 0x${entry.toString(16).padStart(2, '0')} · ${names.join(', ') || '无标志'}`;
        }
        append(type, text);
    };
    visit(value, prefix);
    return rows;
}

export function buildRouteDetailModel(value) {
    const route = getRouteDetailRecord(value);
    const model = {
        route,
        attributes: [],
        nlri: [],
        tlvs: [],
        diagnostics: [],
        lifecycle: [],
        source: [],
        additional: []
    };
    for (const [key, entry] of Object.entries(route)) {
        if (key === 'pathAttributes' && Array.isArray(entry)) {
            entry.forEach((attribute, index) => {
                const code = attribute?.typeCode ?? attribute?.type;
                const name = ATTRIBUTE_NAMES[code] || `未知属性 (${code ?? '?'})`;
                model.attributes.push(...flattenRouteDetailFields(attribute, `pathAttributes[${index}]`, name));
            });
            if (entry.length === 0) model.attributes.push(...flattenRouteDetailFields(entry, key, FIELD_LABELS[key]));
            continue;
        }
        const category =
            ATTRIBUTE_KEYS.has(key) || /attribute|communit/iu.test(key)
                ? 'attributes'
                : NLRI_KEYS.has(key)
                  ? 'nlri'
                  : key === 'routeTlvs' || key === 'routeTlvCount'
                    ? 'tlvs'
                    : /^(?:parse|pathStatus|_parse)/u.test(key)
                      ? 'diagnostics'
                      : LIFECYCLE_KEYS.has(key)
                        ? 'lifecycle'
                        : ['source', 'peer', 'client', 'session', 'instance'].includes(key)
                          ? 'source'
                          : 'additional';
        model[category].push(...flattenRouteDetailFields(entry, key, FIELD_LABELS[key] || key));
    }
    if (value !== route && value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
            if (key === 'route') continue;
            const category = ['client', 'session', 'instance'].includes(key) ? 'source' : 'additional';
            model[category].push(...flattenRouteDetailFields(entry, `context.${key}`, FIELD_LABELS[key] || key));
        }
    }
    return model;
}

const READABLE_ATTRIBUTE_NAMES = {
    1: '路由来源',
    2: 'AS 路径',
    3: '下一跳',
    4: '出口优先级（MED）',
    5: '本地优先级',
    6: '路由聚合提示',
    7: '聚合信息',
    8: '标准 Community',
    9: '路由发起者',
    10: '路由反射路径',
    14: '多协议可达路由',
    15: '多协议路由撤销',
    16: '扩展 Community',
    17: 'AS4 路径',
    18: '四字节 AS 聚合信息',
    22: '组播隧道（PMSI）',
    23: '隧道封装',
    25: 'IPv6 扩展 Community',
    29: '链路状态属性（BGP-LS）',
    32: 'Large Community',
    35: '仅向客户传播（OTC）',
    40: '分段路由（Prefix SID）'
};
const BUSINESS_LABELS = {
    ...FIELD_LABELS,
    esi: '以太网段标识（ESI）',
    ethernetTagId: '以太网标签',
    macAddress: 'MAC 地址',
    ipAddress: 'IP 地址',
    ipPrefix: 'IP 前缀',
    gatewayIp: '网关',
    originatingRouterIp: '发起路由器',
    originatorRouterIp: '发起路由器',
    sourceAddress: '组播源',
    groupAddress: '组播组',
    maximumResponseTime: '最大响应时间',
    regionId: '区域标识',
    routeKeyPrefix: '关联的组播路由',
    routeKeyRouteTypeName: '关联路由类型',
    routeKeyRoute: '关联路由',
    protocol: 'IGP 协议',
    identifier: '拓扑标识',
    dqpn: '目标队列号（DQPN）',
    dqpnBits: '队列号位数',
    encapsulation: '封装方式',
    tunnelTypeName: '隧道类型',
    tunnelIdentifier: '隧道端点',
    label: '标签',
    vni: 'VXLAN 网络标识（VNI）',
    sid: 'SID 地址',
    endpointBehaviorName: '端点行为',
    srv6Services: 'SRv6 服务',
    sidStructure: 'SID 结构',
    locatorBlockLength: '定位器块位数',
    locatorNodeLength: '节点位数',
    functionLength: '功能位数',
    argumentLength: '参数位数',
    transpositionLength: '转置位数',
    transpositionOffset: '转置位置',
    serviceType: '服务类型',
    sequenceNumber: '上报序号',
    statusNames: '设备标记的状态',
    reasonName: '设备标记的原因',
    indexes: '关联路由序号',
    appliedNlriIndex: '适用路由序号',
    enterpriseNumber: '企业编号',
    addPaths: '多路径能力',
    afiName: '地址类型',
    safiName: '路由类型',
    sendReceiveName: '发送 / 接收',
    sysName: '设备名称',
    sysDesc: '设备描述',
    remoteIp: '设备地址',
    remotePort: '设备端口',
    localIp: '采集地址',
    localPort: '采集端口',
    as: '自治系统',
    vrf: 'VRF',
    display: '标签含义',
    routeTypeName: '路由类型',
    bgpSummary: 'BGP 消息摘要',
    bgpHeader: 'BGP 消息',
    typeName: '消息类型'
};
const HIDDEN_BUSINESS_FIELDS = new Set([
    'flags',
    'typeCode',
    'type',
    'subType',
    'code',
    'length',
    'headerLength',
    'nlriLength',
    'nlriBits',
    'valid',
    'errors',
    'warnings',
    'error',
    'position',
    'offset',
    'nlriOmitted',
    'source',
    'rawType',
    'rawIndex',
    'index',
    'group',
    'enterprise',
    'raw24',
    'exp',
    'bottom',
    'isMpls',
    'isVni',
    'labelPresent',
    'interpretation',
    'labelType',
    'mplsLabel',
    'ipLength',
    'macLength',
    'sourceLength',
    'groupLength',
    'originatorLength',
    'protocolId',
    'tunnelType',
    'endpointBehavior',
    'afi',
    'safi',
    'sendReceive',
    'bodyLength',
    'encapsulationType',
    'tunnelTypes'
]);
const FLOW_COMPONENT_LABELS = {
    1: '目标地址',
    2: '源地址',
    3: 'IP 协议',
    4: '任一端口',
    5: '目标端口',
    6: '源端口',
    7: 'ICMP 类型',
    8: 'ICMP 代码',
    9: 'TCP 标志',
    10: '报文长度',
    11: 'DSCP',
    12: '分片条件',
    13: 'IPv6 流标签'
};
const LS_DESCRIPTOR_LABELS = {
    256: '本地节点',
    257: '远端节点',
    258: '本地 / 远端链路标识',
    259: '本地 IPv4 接口',
    260: '邻居 IPv4 地址',
    261: '本地 IPv6 接口',
    262: '邻居 IPv6 地址',
    263: '多拓扑标识',
    264: 'OSPF 路由类型',
    265: '可达前缀',
    512: '自治系统',
    513: 'BGP-LS 标识',
    514: 'OSPF 区域',
    515: 'IGP 路由器标识'
};
const ORIGIN_LABELS = {
    0: 'IGP（本 AS 内部起源）',
    1: 'EGP（通过 EGP 协议学习）',
    2: 'INCOMPLETE（其他方式学习）',
    IGP: 'IGP（本 AS 内部起源）',
    EGP: 'EGP（通过 EGP 协议学习）',
    INCOMPLETE: 'INCOMPLETE（其他方式学习）'
};
// RFC 6514 MCAST-VPN route types; route bodies can remain opaque in old DTOs.
const MVPN_ROUTE_NAMES = {
    1: 'AS 内组播自动发现（I-PMSI）',
    2: '跨 AS 组播自动发现（I-PMSI）',
    3: '选择性组播自动发现（S-PMSI）',
    4: '叶节点自动发现',
    5: '活跃组播源通告',
    6: '共享组播树加入',
    7: '源组播树加入'
};
// RFC 1997 well-known communities. Other values remain operator-defined.
const WELL_KNOWN_COMMUNITIES = {
    '65535:65281': ['NO_EXPORT', '不向本 AS 或本 AS 联邦之外发布'],
    '65535:65282': ['NO_ADVERTISE', '不向任何 BGP 邻居发布'],
    '65535:65283': ['NO_EXPORT_SUBCONFED', '不向其他 AS 发布，包括同一联邦中的其他成员 AS']
};

const hasReadableValue = value => value !== undefined && value !== null && value !== '';
const readableScalar = value => (typeof value === 'boolean' ? (value ? '是' : '否') : String(value));
const card = (key, title, description = '') => ({ key, title, description, items: [], tags: [] });
const addItem = (group, label, value, kind = 'text') => {
    if (!hasReadableValue(value) || (Array.isArray(value) && value.length === 0)) return;
    group.items.push({
        key: `${group.key}-${group.items.length}`,
        label,
        value: Array.isArray(value) ? value.map(readableScalar) : readableScalar(value),
        kind: Array.isArray(value) ? 'list' : kind === 'list' ? 'text' : kind
    });
};
const friendlyLabel = key => BUSINESS_LABELS[key] || key.replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/_/gu, ' ');
const isBinaryValue = value =>
    value &&
    typeof value === 'object' &&
    (ArrayBuffer.isView(value) || (value.type === 'Buffer' && Array.isArray(value.data)));

function appendBusinessFields(group, value, excluded = new Set(), parent = '', ancestors = new Set()) {
    if (!value || typeof value !== 'object' || isBinaryValue(value) || ancestors.has(value)) return;
    ancestors.add(value);
    for (const [key, entry] of Object.entries(value)) {
        if (
            excluded.has(key) ||
            HIDDEN_BUSINESS_FIELDS.has(key) ||
            /(?:^raw|Raw$|Hex$|^reserved|^parse|RefCount$|Epoch$)/u.test(key)
        )
            continue;
        const label = parent ? `${parent} · ${friendlyLabel(key)}` : friendlyLabel(key);
        if (Array.isArray(entry)) {
            if (entry.every(item => item === null || typeof item !== 'object'))
                addItem(group, label, entry.filter(hasReadableValue));
            else
                entry.forEach((item, index) =>
                    appendBusinessFields(
                        group,
                        item,
                        new Set(),
                        entry.length > 1 ? `${label} ${index + 1}` : label,
                        ancestors
                    )
                );
        } else if (entry && typeof entry === 'object') {
            appendBusinessFields(group, entry, new Set(), label, ancestors);
        } else {
            addItem(group, label, entry);
        }
    }
    ancestors.delete(value);
}

function hexBytes(value) {
    if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-f]*$/iu.test(value)) return null;
    return Array.from({ length: value.length / 2 }, (_, index) => parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function unsignedBytes(bytes, start, length) {
    if (!bytes || start + length > bytes.length) return null;
    let result = 0;
    for (let index = start; index < start + length; index += 1) result = result * 256 + bytes[index];
    return result;
}

export function formatReadableNextHop(value) {
    if (!hasReadableValue(value)) return '';
    return String(value).replace(/[^\s,]+/gu, token => {
        try {
            const address = ipaddr.parse(token);
            return address.kind() === 'ipv6' && address.isIPv4MappedAddress()
                ? `::ffff:${address.toIPv4Address().toString()}`
                : token;
        } catch (_error) {
            return token;
        }
    });
}

export function formatReadableAsPath(segments) {
    if (!Array.isArray(segments)) {
        if (segments === null || segments === undefined) return '未上报';
        const tokens = String(segments).match(/\{[^}]*\}|\([^)]*\)|\[[^\]]*\]|[^\s]+/gu) || [];
        return tokens.length
            ? tokens
                  .map(token => {
                      if (/^[{([]/u.test(token)) {
                          const values = token
                              .slice(1, -1)
                              .split(/[,\s]+/u)
                              .filter(Boolean);
                          return `${token[0]}${values.join(token[0] === '(' ? ' → ' : ', ')}${token.slice(-1)}`;
                      }
                      return token;
                  })
                  .join(' → ')
            : '空 AS 路径';
    }
    if (!segments.length) return '空 AS 路径';
    return segments
        .filter(segment => segment && typeof segment === 'object')
        .map(segment => {
            const values = (Array.isArray(segment.asNumbers) ? segment.asNumbers : []).map(readableScalar);
            switch (Number(segment.type)) {
                case 1:
                    return `{${values.join(', ')}}`;
                case 2:
                    return values.join(' → ');
                case 3:
                    return `(${values.join(' → ')})`;
                case 4:
                    return `[${values.join(', ')}]`;
                default:
                    return values.join(', ');
            }
        })
        .join(' → ');
}

function communityText(entry) {
    if (entry === null || entry === undefined) return '';
    const raw = typeof entry === 'object' ? (entry.formatted ?? entry.value) : entry;
    if (!hasReadableValue(raw) || !['number', 'string'].includes(typeof raw)) return '';
    if (typeof raw === 'number' && (!Number.isInteger(raw) || raw < 0 || raw > 0xffffffff)) return '';
    const value = typeof raw === 'number' ? `${Math.floor(raw / 65536)}:${raw % 65536}` : String(raw);
    const named = Object.entries(WELL_KNOWN_COMMUNITIES).find(
        ([, [name]]) => name === value.toUpperCase().replace(/-/gu, '_')
    );
    const known = WELL_KNOWN_COMMUNITIES[value] || named?.[1];
    return known ? `${known[0]}（${known[1]}）` : value;
}

function ipv4Words(raw, single = false) {
    const bytes = hexBytes(raw);
    if (!bytes || !bytes.length || bytes.length % 4 || (single && bytes.length !== 4)) return [];
    return Array.from({ length: bytes.length / 4 }, (_, index) => bytes.slice(index * 4, index * 4 + 4).join('.'));
}

function largeCommunityWords(raw) {
    // RFC 8092: each value is three unsigned, network-order 32-bit words.
    const bytes = hexBytes(raw);
    if (!bytes || !bytes.length || bytes.length % 12) return [];
    return Array.from({ length: bytes.length / 12 }, (_, index) =>
        [0, 4, 8].map(offset => unsignedBytes(bytes, index * 12 + offset, 4)).join(':')
    );
}

function largeCommunityText(entry) {
    if (!hasReadableValue(entry)) return '';
    const value =
        typeof entry === 'object'
            ? entry.formatted || [entry.globalAdministrator, entry.localData1, entry.localData2].join(':')
            : String(entry);
    return typeof value === 'string' &&
        /^\d+:\d+:\d+$/u.test(value) &&
        value.split(':').every(part => Number(part) <= 0xffffffff)
        ? value
        : '';
}

function splitLegacyCommunities(value) {
    if (Array.isArray(value)) return value;
    if (!hasReadableValue(value)) return [];
    return String(value).match(/(?:RT|SOO)\s+[^,;\s]+|[^,;\s]+/giu) || [];
}

function formatExtendedCommunity(entry) {
    if (!entry || (typeof entry !== 'string' && typeof entry !== 'object')) return { type: 'other', text: '', raw: '' };
    const bytes = hexBytes(entry.rawHex || entry.rawValueHex || '');
    if (bytes?.length === 8 && [0, 1, 2].includes(bytes[0]) && [2, 3].includes(bytes[1])) {
        // RFC 4360/5668: AS2 uses 2+4 bytes, IPv4 and AS4 use 4+2.
        const admin = bytes[0] === 1 ? bytes.slice(2, 6).join('.') : unsignedBytes(bytes, 2, bytes[0] === 0 ? 2 : 4);
        const local = unsignedBytes(bytes, bytes[0] === 0 ? 4 : 6, bytes[0] === 0 ? 4 : 2);
        return { type: bytes[1] === 2 ? 'rt' : 'soo', text: `${admin}:${local}` };
    }
    if (entry.encapsulation)
        return {
            type: 'encapsulation',
            text: entry.encapsulation.tunnelTypeName || `隧道 ${entry.encapsulation.tunnelType}`
        };
    const formatted = typeof entry === 'string' ? entry : typeof entry.formatted === 'string' ? entry.formatted : '';
    const match = /^(RT|SOO)\s+(.+)$/iu.exec(formatted);
    if (match) return { type: match[1].toLowerCase(), text: match[2] };
    if (/^Origin Validation State:/iu.test(formatted))
        return { type: 'validation', text: formatted.replace(/^Origin Validation State:\s*/iu, '') };
    return {
        type: 'other',
        text: formatted && !/^(?:unknown|truncated)\(/iu.test(formatted) ? formatted : '',
        raw: entry.rawHex || entry.rawValueHex || ''
    };
}

function extendedCommunityCards(attribute, key) {
    const values = attribute.extCommunities || attribute.extendedCommunities || [];
    const entries = Array.isArray(values) ? values.filter(entry => entry !== null && entry !== undefined) : [];
    const groups = new Map();
    const definitions = {
        rt: ['路由目标（RT）', '用于 VPN 路由导入和导出策略。'],
        soo: ['路由来源站点（SOO）', '标识路由源站点，帮助避免 VPN 站点之间的路由环路。'],
        encapsulation: ['封装方式', '对端为这条路由通告的隧道封装。'],
        validation: ['路由起源验证', '设备附带的起源验证结果。'],
        other: ['扩展 Community', '设备携带的扩展策略标记。']
    };
    entries.forEach((entry, index) => {
        const formatted = formatExtendedCommunity(entry);
        const groupKey = formatted.type === 'other' ? `other-${index}` : formatted.type;
        if (!groups.has(groupKey)) {
            const [title, description] = definitions[formatted.type];
            groups.set(groupKey, card(`${key}-${groupKey}`, title, description));
        }
        const group = groups.get(groupKey);
        if (formatted.text) group.tags.push(formatted.text);
        if (formatted.raw) group.raw = formatted.raw;
    });
    if (!groups.size) groups.set('empty', card(key, '扩展 Community', '该属性尚无可读的解码结果。'));
    const result = Array.from(groups.values());
    if (attribute.rawValueHex !== undefined) result[0].raw = attribute.rawValueHex;
    return result;
}

function labelText(value) {
    if (!value || typeof value !== 'object') return hasReadableValue(value) ? String(value) : '';
    if (value.display) return value.display.replace(/\(BOS\)/gu, '（栈底）');
    if (value.type === 'vni') return `VNI ${value.vni}`;
    return `MPLS ${value.mplsLabel ?? value.label}${value.bottom ? '（栈底）' : ''}`;
}

function prefixSidItems(group, prefixSid) {
    if (!prefixSid || typeof prefixSid !== 'object') {
        return;
    }
    addItem(group, '标签索引', prefixSid.labelIndex?.labelIndex);
    addItem(
        group,
        '全局标签块（SRGB）',
        prefixSid.originatorSrgb?.ranges?.map(
            range => `${range.start}–${range.end ?? range.start + range.range - 1}（${range.range} 个标签）`
        )
    );
    (prefixSid.srv6Services || []).forEach((service, index) => {
        const serviceLabel =
            { l2: 'SRv6 二层服务', l3: 'SRv6 三层服务', vpn: 'SRv6 VPN 服务', transport: 'SRv6 传输' }[
                service.serviceType
            ] || 'SRv6 服务';
        (service.sidInfos || []).forEach((sidInfo, sidIndex) => {
            const label = `${serviceLabel}${index || sidIndex ? ` ${index + 1}.${sidIndex + 1}` : ''}`;
            if (
                typeof sidInfo.sid === 'string' &&
                ipaddr.isValid(sidInfo.sid) &&
                ipaddr.parse(sidInfo.sid).kind() === 'ipv6'
            ) {
                addItem(
                    group,
                    label,
                    `${sidInfo.sid}${sidInfo.endpointBehaviorName ? ` · ${sidInfo.endpointBehaviorName}` : ''}`,
                    'code'
                );
            } else {
                addItem(group, `${label} · 端点行为`, sidInfo.endpointBehaviorName);
            }
            appendBusinessFields(group, sidInfo.sidStructure, new Set(), 'SID 结构');
        });
    });
    if (!group.items.length && Array.isArray(prefixSid.tlvs)) {
        addItem(
            group,
            'TLV 类型',
            prefixSid.tlvs.map(tlv => tlv.typeName || `类型 ${tlv.type}`)
        );
    }
}

function readableAttributeCards(attribute, index, route) {
    const type = Number(attribute.typeCode ?? attribute.type);
    const key = `attribute-${index}-${type}`;
    const group = card(
        key,
        READABLE_ATTRIBUTE_NAMES[type] || `未知路径属性（${Number.isFinite(type) ? type : '未指定类型'}）`
    );
    if (attribute.rawValueHex !== undefined) group.raw = attribute.rawValueHex;
    const bytes = hexBytes(attribute.rawValueHex || '');
    switch (type) {
        case 1: {
            const origin = attribute.origin ?? (bytes?.length === 1 ? bytes[0] : null);
            group.description = '说明这条路由最初如何进入 BGP。';
            addItem(group, '起源', ORIGIN_LABELS[origin] || `未知起源（${origin ?? '未解析'}）`);
            break;
        }
        case 2:
        case 17: {
            group.description =
                type === 17
                    ? '补充四字节 AS 号，用于还原有效 AS 路径。'
                    : '按报文顺序展示经过的自治系统；花括号表示集合，圆括号和方括号表示联邦路径。';
            const reconstructed = type === 2 && route.as4Path !== undefined && route.asPath !== route.wireAsPath;
            addItem(
                group,
                reconstructed ? '有效路径' : '路径',
                formatReadableAsPath(reconstructed ? route.asPath : (attribute.segments ?? attribute.asPath)),
                'path'
            );
            if (reconstructed)
                addItem(
                    group,
                    '报文中的两字节路径',
                    formatReadableAsPath(attribute.segments ?? route.wireAsPath),
                    'code'
                );
            if (Array.isArray(attribute.segments) && !reconstructed) {
                attribute.segments
                    .filter(segment => segment && Number(segment.type) !== 2)
                    .forEach(segment =>
                        addItem(
                            group,
                            { 1: 'AS 集合（不表示先后顺序）', 3: '联邦 AS 序列', 4: '联邦 AS 集合' }[segment.type] ||
                                'AS 段',
                            (Array.isArray(segment.asNumbers) ? segment.asNumbers : []).join(', ')
                        )
                    );
            }
            break;
        }
        case 3:
            group.description = '用于到达该路由的下一跳地址。';
            addItem(group, '地址', formatReadableNextHop(attribute.nextHop), 'code');
            break;
        case 4:
            group.description = '向相邻 AS 表达入口偏好；满足比较条件时，数值越小越优先。';
            addItem(group, 'MED', attribute.med ?? unsignedBytes(bytes, 0, 4));
            break;
        case 5:
            group.description = '本 AS 内的选路优先级，数值越大越优先。';
            addItem(group, 'Local Preference', attribute.localPref ?? unsignedBytes(bytes, 0, 4));
            break;
        case 6:
            group.description = '该路由经过聚合，部分原始 AS 路径信息可能已经省略。';
            addItem(group, '聚合标记', '已携带 ATOMIC_AGGREGATE');
            break;
        case 7:
        case 18:
            group.description = '发起路由聚合的自治系统和路由器。';
            addItem(
                group,
                '聚合 AS',
                attribute.aggregatorAs === 23456
                    ? '23456（AS_TRANS，四字节 AS 占位）'
                    : (attribute.aggregatorAs ?? attribute.aggregator?.as)
            );
            addItem(group, '聚合路由器', attribute.aggregatorIp ?? attribute.aggregator?.ip, 'code');
            break;
        case 8:
            group.description = '用于匹配路由策略；普通数值的具体含义由运营者定义。';
            group.tags = splitLegacyCommunities(attribute.communities).map(communityText).filter(Boolean);
            break;
        case 9:
            // RFC 4456: ORIGINATOR_ID is exactly one four-byte BGP Identifier.
            group.description = '路由反射时记录的原始 BGP 路由器标识，用于避免反射环路。';
            addItem(
                group,
                'Originator ID',
                attribute.originatorId ?? ipv4Words(attribute.rawValueHex, true)[0],
                'code'
            );
            break;
        case 10:
            group.description = '这条路由经过的路由反射器集群，按收到的顺序展示。';
            addItem(group, 'Cluster List', attribute.clusterList || ipv4Words(attribute.rawValueHex), 'list');
            break;
        case 14:
        case 15: {
            const mp = attribute.mpReach || attribute.mpUnreach || {};
            group.description =
                type === 14
                    ? '该地址族的下一跳信息。当前这条路由的可达信息在 NLRI 分组展示。'
                    : '该地址族携带路由撤销信息。当前这条路由的可达信息在 NLRI 分组展示。';
            addItem(group, '地址族', readableFamily(mp.afi, mp.safi));
            addItem(group, '下一跳', formatReadableNextHop(mp.nextHop), 'code');
            break;
        }
        case 16:
            return extendedCommunityCards(attribute, key);
        case 22: {
            const pmsi = attribute.pmsiTunnel || {};
            group.description = '组播分发使用的隧道和标签信息。';
            addItem(group, '隧道类型', pmsi.tunnelTypeName);
            addItem(group, '转发标签', labelText(pmsi.label), 'code');
            const endpointBytes = hexBytes(pmsi.tunnelIdentifierHex || '');
            const endpoint =
                pmsi.tunnelType === 6 && [4, 16].includes(endpointBytes?.length)
                    ? ipaddr.fromByteArray(endpointBytes).toString()
                    : null;
            addItem(group, '隧道端点', endpoint, 'code');
            if (pmsi.tunnelIdentifierHex && !endpoint && group.raw === undefined) group.raw = pmsi.tunnelIdentifierHex;
            break;
        }
        case 23:
            group.description = '该路由支持的隧道封装类型。';
            (attribute.tunnelEncapsulation?.tlvs || []).forEach(tunnel => {
                addItem(group, '封装', tunnel.tunnelTypeName || `隧道 ${tunnel.tunnelType}`);
            });
            break;
        case 32:
            group.description = '格式为“管理员:本地值1:本地值2”，三个部分均为四字节数值；本地值由管理员定义。';
            group.tags = attribute.largeCommunities
                ? splitLegacyCommunities(attribute.largeCommunities).map(largeCommunityText).filter(Boolean)
                : largeCommunityWords(attribute.rawValueHex);
            break;
        case 35:
            group.description = '记录仅允许沿客户方向传播的路由，帮助检测路由泄漏。';
            addItem(group, '携带该标记的 AS', attribute.otc ?? unsignedBytes(bytes, 0, 4));
            break;
        case 40:
            group.description = '标签索引、全局标签块和 SRv6 服务信息。';
            prefixSidItems(group, attribute.prefixSid);
            break;
        default:
            group.description = READABLE_ATTRIBUTE_NAMES[type] ? '该属性暂未解码。' : '尚未识别的路径属性。';
    }
    if (
        READABLE_ATTRIBUTE_NAMES[type] &&
        !group.items.length &&
        !group.tags.length &&
        !group.description.includes('暂未解码')
    )
        group.description += ' 当前没有可读的解析结果。';
    return [group];
}

function legacyReadableAttributes(route) {
    const descriptors = [
        [1, 'origin'],
        [2, 'asPath'],
        [3, 'nextHop'],
        [4, 'med'],
        [5, 'localPref'],
        [17, 'as4Path'],
        [9, 'originatorId'],
        [10, 'clusterList'],
        [35, 'otc'],
        [40, 'prefixSid']
    ]
        .filter(([, field]) => hasReadableValue(route[field]))
        .map(([typeCode, field]) => ({ typeCode, [typeCode === 17 ? 'asPath' : field]: route[field] }));
    const communityValues = splitLegacyCommunities(route.communities);
    const extended = communityValues.filter(entry => typeof entry === 'string' && /^(?:RT|SOO)\s/iu.test(entry));
    const standard = communityValues.filter(entry => !extended.includes(entry));
    if (standard.length) descriptors.push({ typeCode: 8, communities: standard });
    if (extended.length || route.extendedCommunities?.length)
        descriptors.push({ typeCode: 16, extCommunities: [...extended, ...(route.extendedCommunities || [])] });
    if (route.largeCommunities?.length) descriptors.push({ typeCode: 32, largeCommunities: route.largeCommunities });
    if (route.atomicAggregate) descriptors.push({ typeCode: 6 });
    if (route.aggregator) descriptors.push({ typeCode: 7, aggregator: route.aggregator });
    if (route.as4Aggregator) descriptors.push({ typeCode: 18, aggregator: route.as4Aggregator });
    if (route.pmsiTunnel) descriptors.push({ typeCode: 22, pmsiTunnel: route.pmsiTunnel });
    if (route.tunnelEncapsulation) descriptors.push({ typeCode: 23, tunnelEncapsulation: route.tunnelEncapsulation });
    return descriptors.flatMap((descriptor, index) => readableAttributeCards(descriptor, index, route));
}

function readableFamily(afi, safi, fallback = '') {
    const family = Number(afi);
    const subfamily = Number(safi);
    if (family === 25 && subfamily === 70) return 'EVPN（以太网 VPN）';
    if (family === 25 && subfamily === 65) return 'VPLS';
    if (family === 16388) return subfamily === 72 ? 'BGP-LS VPN（链路状态 VPN）' : 'BGP-LS（链路状态）';
    const ip = family === 1 ? 'IPv4' : family === 2 ? 'IPv6' : '';
    if (ip) {
        if (subfamily === 128) return family === 1 ? 'VPNv4（IPv4 VPN）' : 'VPNv6（IPv6 VPN）';
        return `${ip} ${{ 1: '单播', 2: '组播', 4: '标签单播', 5: '组播 VPN（MVPN）', 129: 'VPN 组播', 132: '路由目标约束', 133: 'FlowSpec', 134: 'VPN FlowSpec' }[subfamily] || '路由'}`;
    }
    return fallback || '未识别的地址族';
}

function readableLsDescriptorValue(descriptor) {
    if (!descriptor || descriptor.valid === false || !hasReadableValue(descriptor.value)) return '';
    const type = Number(descriptor.type);
    const value = String(descriptor.value);
    const length = descriptor.length === undefined ? null : Number(descriptor.length);
    const hasLength = minimum => length === null || length >= minimum;
    const isIp = family =>
        value.includes(family === 'ipv4' ? '.' : ':') && ipaddr.isValid(value) && ipaddr.parse(value).kind() === family;
    switch (type) {
        case 512:
        case 513:
            return hasLength(4) && /^\d+$/u.test(value) ? value : '';
        case 514:
        case 259:
        case 260:
            return hasLength(4) && isIp('ipv4') ? value : '';
        case 261:
        case 262:
            return hasLength(16) && isIp('ipv6') ? value : '';
        case 515:
            if ((length === null || length === 4) && isIp('ipv4')) return value;
            // IS-IS system IDs and pseudonode IDs are meaningful IGP identifiers, not opaque TLV payloads.
            return [12, 14, 16].includes(value.length) &&
                /^[\da-f]+$/iu.test(value) &&
                (length === null || length * 2 === value.length)
                ? value
                : '';
        case 258:
            return hasLength(8) && /^\d+->\d+$/u.test(value) ? value : '';
        case 263:
            return hasLength(2) && /^\d+$/u.test(value) ? value : '';
        case 264:
            return hasLength(1) && /^\d+$/u.test(value) ? value : '';
        case 265: {
            const match = /^(.*)\/(\d+)$/u.exec(value);
            if (!match || !ipaddr.isValid(match[1])) return '';
            const bits = ipaddr.parse(match[1]).kind() === 'ipv6' ? 128 : 32;
            return Number(match[2]) <= bits ? value : '';
        }
        default:
            return '';
    }
}

function lsDescriptorItems(group, descriptors, parent = '') {
    (descriptors || []).forEach(descriptor => {
        if (!descriptor || typeof descriptor !== 'object') return;
        const label = LS_DESCRIPTOR_LABELS[descriptor.type] || descriptor.typeName || '扩展拓扑信息';
        const title = parent ? `${parent} · ${label}` : label;
        if (descriptor.children?.length) lsDescriptorItems(group, descriptor.children, title);
        else {
            const parsed = readableLsDescriptorValue(descriptor);
            addItem(
                group,
                title,
                parsed || `类型 ${descriptor.type ?? '未知'}：尚未解析`,
                Number(descriptor.type) === 515 ? 'code' : 'text'
            );
        }
    });
}

function flowCondition(component) {
    if (!component || typeof component !== 'object') return '';
    if (
        [1, 2].includes(Number(component.type)) &&
        typeof component.prefix === 'string' &&
        ipaddr.isValid(component.prefix) &&
        Number.isInteger(component.length)
    )
        return `${component.prefix}/${component.length}${component.offset ? `（从第 ${component.offset} 位匹配）` : ''}`;
    if (!FLOW_COMPONENT_LABELS[component.type] || !Array.isArray(component.operations)) return '';
    return component.operations
        .filter(
            operation =>
                operation &&
                ['number', 'string', 'bigint'].includes(typeof operation.value) &&
                /^\d+$/u.test(String(operation.value))
        )
        .map(operation => {
            const op = String(operation.operatorName || '=')
                .replace(/not match/gu, '不全部匹配')
                .replace(/not any/gu, '全部不匹配')
                .replace(/match/gu, '全部匹配')
                .replace(/any/gu, '任意位匹配')
                .replace(/and/gu, '且')
                .replace(/true/gu, '任意值')
                .replace(/false/gu, '无匹配');
            const protocol =
                component.type === 3 ? { 1: 'ICMP', 6: 'TCP', 17: 'UDP', 58: 'ICMPv6' }[operation.value] : '';
            return `${op} ${operation.value}${protocol ? `（${protocol}）` : ''}`;
        })
        .join(' 或 ')
        .replace(/ 或 且 /gu, ' 且 ');
}

export function formatReadableRouteIdentity(value) {
    const route = getRouteDetailRecord(value);
    const nlri = route.nlriDetail || {};
    const afi = Number(route.afi);
    const safi = Number(route.safi);
    if (afi === 25 && safi === 70) {
        const type = Number(nlri.routeType ?? route.routeType);
        const names = {
            1: '以太网自动发现',
            2: 'MAC/IP',
            3: '组播成员',
            4: '以太网段',
            5: 'IP 前缀',
            6: '选择性组播',
            7: '组播成员同步',
            8: '组播离开同步',
            9: '区域组播',
            10: 'S-PMSI',
            11: '叶节点自动发现'
        };
        const parts = [nlri.macAddress, nlri.ipAddress, nlri.ipPrefix && `${nlri.ipPrefix}/${nlri.prefixLength}`];
        if (![2, 5].includes(type)) parts.push(nlri.originatingRouterIp || nlri.originatorRouterIp, nlri.groupAddress);
        if (!parts.some(hasReadableValue)) parts.push(nlri.esi, nlri.regionId, nlri.rd && `RD ${nlri.rd}`);
        return {
            title: names[type] ? `EVPN ${names[type]} 路由` : 'EVPN 路由',
            summary: parts.filter(hasReadableValue).join(' · ')
        };
    }
    if ([133, 134].includes(safi)) {
        const components = Array.isArray(nlri.components) ? nlri.components : [];
        return {
            title: `${afi === 2 ? 'IPv6' : 'IPv4'} FlowSpec 路由`,
            summary: components
                .slice(0, 3)
                .map(component => {
                    const condition = flowCondition(component);
                    return condition ? `${FLOW_COMPONENT_LABELS[component.type] || '匹配条件'} ${condition}` : '';
                })
                .filter(Boolean)
                .join(' · ')
        };
    }
    if (afi === 16388) {
        const descriptors = Array.isArray(nlri.descriptors) ? nlri.descriptors : [];
        const nodeId = type =>
            descriptors
                .find(descriptor => Number(descriptor.type) === type)
                ?.children?.find(descriptor => Number(descriptor.type) === 515);
        const endpoints = [nodeId(256), nodeId(257)]
            .map(readableLsDescriptorValue)
            .filter(hasReadableValue)
            .join(' → ');
        const reachability = readableLsDescriptorValue(descriptors.find(descriptor => Number(descriptor.type) === 265));
        const objectName = { 1: '节点', 2: '链路', 3: 'IPv4 前缀', 4: 'IPv6 前缀' }[nlri.routeType];
        return {
            title: objectName ? `BGP-LS ${objectName}路由` : 'BGP-LS 路由',
            summary: [nlri.protocol, reachability || endpoints].filter(hasReadableValue).join(' · ')
        };
    }
    if (safi === 5)
        return {
            title: '组播 VPN 路由',
            summary: MVPN_ROUTE_NAMES[nlri.routeType ?? route.routeType] || nlri.routeTypeName || ''
        };
    const prefix = formatRouteDetailPrefix(route);
    return { title: '路由详情', summary: prefix === '-' ? '' : prefix };
}

function readableNlriCards(route) {
    const nlri = route.nlriDetail || {};
    const group = card('nlri-route', '路由可达信息');
    const afi = Number(route.afi);
    const safi = Number(route.safi);
    addItem(group, '地址族', readableFamily(afi, safi, route.addrFamilyType || route.addressFamily));
    if (afi === 25 && safi === 70) {
        group.title = 'EVPN 路由';
        addItem(group, '路由类型', nlri.routeTypeName || `EVPN 路由 ${nlri.routeType ?? route.routeType}`);
        addItem(group, 'MAC 地址', nlri.macAddress, 'code');
        addItem(group, 'IP 地址', nlri.ipAddress, 'code');
        addItem(group, 'IP 前缀', nlri.ipPrefix && `${nlri.ipPrefix}/${nlri.prefixLength}`, 'code');
    } else if (afi === 16388) {
        group.title = '链路状态路由';
        addItem(
            group,
            '拓扑对象',
            { 1: '节点', 2: '链路', 3: 'IPv4 前缀', 4: 'IPv6 前缀' }[nlri.routeType] || nlri.routeTypeName
        );
        addItem(group, 'IGP 协议', nlri.protocol);
        addItem(group, '拓扑标识', nlri.identifier, 'code');
        lsDescriptorItems(group, nlri.descriptors);
    } else if ([133, 134].includes(safi)) {
        group.title = 'FlowSpec 流量匹配';
        group.description = '以下条件共同描述要匹配的流量；处置动作由相关 Community 和路由策略决定。';
        (nlri.components || []).forEach(component => {
            if (!component || typeof component !== 'object') return;
            addItem(
                group,
                FLOW_COMPONENT_LABELS[component.type] || '扩展匹配条件',
                flowCondition(component) || `类型 ${component.type ?? '未知'}：尚未解析`,
                'code'
            );
        });
    } else if (safi === 5) {
        group.title = '组播 VPN 路由';
        group.description = '展示已经识别的组播路由类型和解析字段。';
        addItem(
            group,
            '路由用途',
            MVPN_ROUTE_NAMES[nlri.routeType ?? route.routeType] || nlri.routeTypeName || '未识别的组播路由类型'
        );
    } else {
        group.title = [128, 129].includes(safi) ? 'VPN 路由' : '路由可达信息';
        addItem(group, '前缀', formatRouteDetailPrefix(route), 'code');
    }
    if (nlri.rd || (route.rd && (route.rd !== '0:0' || [128, 129, 134].includes(safi) || afi === 25)))
        addItem(group, '路由区分符（RD）', nlri.rd || route.rd, 'code');
    if (Object.hasOwn(nlri, 'pathId') || route.pathId)
        addItem(group, '多路径标识（Path ID）', nlri.pathId ?? route.pathId);
    const labels = Array.isArray(nlri.labels) ? nlri.labels.map(labelText) : route.labels ? [route.labels] : [];
    addItem(group, '转发标签 / VNI', labels, 'list');
    addItem(group, '封装方式', nlri.encapsulation?.tunnelTypeNames || nlri.encapsulation?.tunnelTypeName);
    addItem(group, '组播隧道', nlri.pmsiTunnel?.tunnelTypeName);
    appendBusinessFields(
        group,
        nlri,
        new Set([
            'prefix',
            'displayPrefix',
            'formatted',
            'rd',
            'pathId',
            'labels',
            'routeType',
            'routeTypeName',
            'macAddress',
            'ipAddress',
            'ipPrefix',
            'prefixLength',
            'protocol',
            'identifier',
            'descriptors',
            'components',
            'encapsulation',
            'pmsiTunnel'
        ])
    );
    if (nlri.rawNlri || route.rawNlri) group.raw = nlri.rawNlri || route.rawNlri;
    return [group];
}

function readableTlvCards(route) {
    return (Array.isArray(route.routeTlvs) ? route.routeTlvs : [])
        .filter(tlv => tlv && typeof tlv === 'object' && !Array.isArray(tlv))
        .map((tlv, index) => {
            const group = card(`route-tlv-${index}`, tlv.name || `未识别的路由附加信息（类型 ${tlv.type ?? '未知'}）`);
            const decoded = tlv.decoded || {};
            if (tlv.rawValueHex !== undefined || tlv.valueHex !== undefined)
                group.raw = tlv.rawValueHex ?? tlv.valueHex;
            const content = tlv.valueText ?? tlv.value;
            if (['string', 'number', 'boolean'].includes(typeof content)) addItem(group, '内容', content);
            addItem(group, '设备上报序号', decoded.sequenceNumber);
            addItem(group, '扩展 Flags', decoded.flags);
            addItem(group, '路径状态值', decoded.status);
            addItem(group, '设备标记的状态', decoded.statusNames);
            addItem(group, '设备标记的原因', decoded.reasonName);
            addItem(group, '解析提示', collectRouteDiagnostics(decoded));
            if (decoded.seconds !== undefined)
                addItem(
                    group,
                    '设备时间',
                    formatRouteDetailTimestamp(
                        Number(decoded.seconds) * 1000 + Number(decoded.microseconds || 0) / 1000
                    )
                );
            addItem(group, '关联路由序号', decoded.indexes);
            addItem(group, '适用路由序号', tlv.appliedNlriIndex);
            appendBusinessFields(
                group,
                decoded,
                new Set([
                    'sequenceNumber',
                    'flags',
                    'status',
                    'statusNames',
                    'reason',
                    'reasonName',
                    'seconds',
                    'microseconds',
                    'indexes'
                ])
            );
            if (!group.items.length) group.description = '尚未解码的路由附加信息。';
            return group;
        });
}

function collectRouteDiagnostics(value) {
    const messages = new Set();
    const visited = new Set();
    const visit = entry => {
        if (!entry || typeof entry !== 'object' || isBinaryValue(entry) || visited.has(entry)) return;
        visited.add(entry);
        for (const [key, child] of Object.entries(entry)) {
            if (['error', 'errors', 'warnings'].includes(key)) {
                for (const message of Array.isArray(child) ? child : [child]) {
                    if (typeof message === 'string' && message) messages.add(message);
                }
            } else if (!/^(?:raw|.*Hex$)/u.test(key)) {
                visit(child);
            }
        }
    };
    visit(value);
    return Array.from(messages);
}

function readableOverviewGroups(route, value) {
    const groups = [];
    const state = card('route-observation', '观测状态');
    const states = {
        active: '有效',
        stale: '待刷新',
        withdrawn: '已撤销',
        deleted: '已删除',
        ready: '已同步',
        syncing: '同步中',
        down: '连接中断'
    };
    addItem(state, '路由状态', states[route.routeState] || route.routeState);
    addItem(state, '同步状态', states[route.scopeState] || route.scopeState);
    if (route.parseStatus !== undefined)
        addItem(
            state,
            '报文解析',
            Number(route.parseStatus) & 2 ? '存在解析异常' : Number(route.parseStatus) & 1 ? '存在解析提示' : '正常'
        );
    addItem(state, '待刷新原因', route.staleReason || route.scopeStaleReason);
    addItem(state, '解析提示', collectRouteDiagnostics(route));
    if (state.items.length) groups.push(state);
    const time = card('route-times', '观测时间');
    ['firstSeenAt', 'lastSeenAt', 'sourceTimestampMs', 'refreshStartedAt', 'staleAt'].forEach(field => {
        if (hasReadableValue(route[field]))
            addItem(time, FIELD_LABELS[field], formatRouteDetailTimestamp(route[field]));
    });
    if (time.items.length) groups.push(time);
    const source = card('route-source', '路由来源');
    appendBusinessFields(source, route.source || value?.client || {}, new Set());
    appendBusinessFields(source, route.peer || value?.session || value?.instance || {}, new Set(), 'BGP 对端 / 实例');
    if (source.items.length) groups.push(source);
    return groups;
}

export function buildReadableRouteDetailModel(value) {
    const route = getRouteDetailRecord(value);
    const pathAttributes = Array.isArray(route.pathAttributes)
        ? route.pathAttributes.filter(
              attribute => attribute && typeof attribute === 'object' && !Array.isArray(attribute)
          )
        : [];
    return {
        attributes: pathAttributes.length
            ? pathAttributes.flatMap((attribute, index) => readableAttributeCards(attribute, index, route))
            : legacyReadableAttributes(route),
        nlri: readableNlriCards(route),
        tlvs: readableTlvCards(route),
        overviewGroups: readableOverviewGroups(route, value)
    };
}
